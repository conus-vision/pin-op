import {
  SOURCE_PLUGIN_API_VERSION,
  type Disposable,
  type PluginDiagnostic,
  type SelectionSnapshot,
  type SourceDocument,
  type SourceMatch,
  type SourcePlugin,
  type SourceWorkspace,
} from "@pinop/plugin-api";
import {
  JsonObjectSchema,
  type ResolutionStatus,
} from "@pinop/protocol";
import type {
  PluginResolutionCandidate,
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
  SourcePluginDispatch,
  SourceResolution,
} from "./types.js";

interface PluginPayload {
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}

interface PluginResolution extends PluginPayload, PluginResolutionCandidate {}

const CONFIDENCE_PRIORITY: Record<SourceMatch["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

export class SourcePluginRegistry {
  private readonly plugins = new Map<string, SourcePlugin>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;

  public constructor(options: { readonly timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  public register(plugin: SourcePlugin): Disposable {
    if (plugin.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
      throw new Error(
        `Plugin "${plugin.id}" uses unsupported API version ${plugin.apiVersion}`,
      );
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Source plugin "${plugin.id}" is already registered`);
    }
    this.plugins.set(plugin.id, plugin);
    this.emitChange();
    return {
      dispose: () => {
        if (this.plugins.delete(plugin.id)) this.emitChange();
      },
    };
  }

  public onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async resolve(
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<SourcePluginDispatch> {
    const factKinds = new Set(
      selection.targets.flatMap((target) =>
        target.facts.map((fact) => fact.type),
      ),
    );
    const documentPlugins = [...this.plugins.values()].filter((plugin) =>
      matchesDocument(plugin, document),
    );
    if (documentPlugins.length === 0) {
      return {
        kind: "unsupported-document",
        documentUri: document.uri,
        documentVersion: document.version,
      };
    }
    const plugins = documentPlugins.filter((plugin) =>
      plugin.supportedFactKinds.some((kind) => factKinds.has(kind)),
    );
    const settled = await Promise.all(
      plugins.map((plugin) =>
        this.resolvePlugin(plugin, selection, document, workspace, signal),
      ),
    );
    const candidates = settled.map((entry) =>
      validateCandidate(entry, selection, document),
    );
    const resolution: SourceResolution = {
      selectionMessageId: selection.messageId,
      documentUri: document.uri,
      documentVersion: document.version,
      matches: deduplicateMatches(
        candidates.flatMap((entry) => entry.matches),
      ),
      diagnostics: candidates.flatMap((entry) => entry.diagnostics),
    };
    return {
      kind: "resolved",
      resolution,
      candidates,
    };
  }

  private async resolvePlugin(
    plugin: SourcePlugin,
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<PluginResolution> {
    if (signal.aborted) return emptyResolution(plugin.id);

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() =>
            plugin.resolve({
              selection,
              document,
              workspace,
              signal: controller.signal,
            }),
          )
          .then(
            (result) => ({ kind: "result" as const, result }),
            (error: unknown) => ({ kind: "exception" as const, error }),
          ),
        new Promise<{ readonly kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ kind: "timeout" });
          }, this.timeoutMs);
        }),
        new Promise<{ readonly kind: "cancelled" }>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve({ kind: "cancelled" }),
            { once: true },
          );
        }),
      ]);

      if (outcome.kind === "cancelled" && !signal.aborted) {
        return diagnosticResolution(plugin.id, {
          code: "plugin.timeout",
          message: `Source plugin "${plugin.displayName}" timed out`,
          severity: "warning",
        });
      }
      if (outcome.kind === "cancelled" || signal.aborted) {
        return emptyResolution(plugin.id);
      }
      if (outcome.kind === "timeout") {
        return diagnosticResolution(plugin.id, {
          code: "plugin.timeout",
          message: `Source plugin "${plugin.displayName}" timed out`,
          severity: "warning",
        });
      }
      if (outcome.kind === "exception") {
        return diagnosticResolution(plugin.id, {
          code: "plugin.exception",
          message: "Source plugin failed while resolving the active document",
          severity: "error",
        });
      }

      try {
        return normalizePluginResult(plugin.id, outcome.result);
      } catch {
        return invalidResultResolution(plugin.id);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function matchesDocument(plugin: SourcePlugin, document: SourceDocument): boolean {
  const scheme = document.uri.slice(0, document.uri.indexOf(":"));
  return plugin.documentSelectors.some(
    (selector) =>
      selector.languageId === document.languageId &&
      (selector.scheme === undefined || selector.scheme === scheme),
  );
}

function validateMatches(
  matches: readonly ResolvedSourceMatch[],
  selection: SelectionSnapshot,
  document: SourceDocument,
): PluginPayload {
  const roles = new Set(selection.targets.map((target) => target.role));
  const valid: ResolvedSourceMatch[] = [];
  const diagnostics: ResolvedPluginDiagnostic[] = [];

  for (const match of matches) {
    if (!roles.has(match.targetRole) || !validRange(match.range, document)) {
      diagnostics.push({
        pluginId: match.pluginId,
        code: "plugin.invalidRange",
        message: `Source plugin "${match.pluginId}" returned an invalid source match`,
        severity: "warning",
      });
      continue;
    }
    valid.push(match);
  }

  return { matches: valid, diagnostics };
}

function validateCandidate(
  candidate: PluginResolution,
  selection: SelectionSnapshot,
  document: SourceDocument,
): PluginResolutionCandidate {
  const validated = validateMatches(candidate.matches, selection, document);
  const matches = deduplicateMatches(validated.matches);
  const diagnostics = [...candidate.diagnostics, ...validated.diagnostics];
  return {
    pluginId: candidate.pluginId,
    status: matches.length > 0
      ? "matched"
      : candidate.matches.length > 0 && validated.matches.length === 0
        ? "error"
        : candidate.status,
    matches,
    diagnostics,
  };
}

function validRange(
  range: SourceMatch["range"],
  document: SourceDocument,
): boolean {
  const positions = [range.start, range.end];
  if (
    positions.some(
      (position) =>
        !Number.isInteger(position.line) ||
        !Number.isInteger(position.character) ||
        position.line < 0 ||
        position.character < 0,
    )
  ) {
    return false;
  }

  try {
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    return (
      start < end &&
      samePosition(document.positionAt(start), range.start) &&
      samePosition(document.positionAt(end), range.end)
    );
  } catch {
    return false;
  }
}

function samePosition(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): boolean {
  return left.line === right.line && left.character === right.character;
}

function deduplicateMatches(
  matches: readonly ResolvedSourceMatch[],
): readonly ResolvedSourceMatch[] {
  const unique = new Map<string, ResolvedSourceMatch>();
  for (const match of matches) {
    const key = JSON.stringify([
      match.range.start.line,
      match.range.start.character,
      match.range.end.line,
      match.range.end.character,
      match.kind,
      match.relation,
    ]);
    const existing = unique.get(key);
    if (!existing || compareMatches(match, existing) < 0) {
      unique.set(key, match);
    }
  }
  return [...unique.values()].sort(compareByRange);
}

function compareMatches(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return (
    rolePriority(left.targetRole) - rolePriority(right.targetRole) ||
    CONFIDENCE_PRIORITY[left.confidence] -
      CONFIDENCE_PRIORITY[right.confidence] ||
    left.pluginId.localeCompare(right.pluginId)
  );
}

function compareByRange(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character ||
    compareMatches(left, right)
  );
}

function rolePriority(role: SourceMatch["targetRole"]): number {
  return role === "selected" ? 0 : 1;
}

function emptyResolution(pluginId: string): PluginResolution {
  return {
    pluginId,
    status: "error",
    matches: [],
    diagnostics: [],
  };
}

function diagnosticResolution(
  pluginId: string,
  diagnostic: Omit<ResolvedPluginDiagnostic, "pluginId">,
): PluginResolution {
  return {
    pluginId,
    status: "error",
    matches: [],
    diagnostics: [{ ...diagnostic, pluginId }],
  };
}

function normalizePluginResult(
  pluginId: string,
  value: unknown,
): PluginResolution {
  if (
    !isRecord(value) ||
    !Array.isArray(value.matches) ||
    (value.diagnostics !== undefined && !Array.isArray(value.diagnostics))
  ) {
    return invalidResultResolution(pluginId);
  }

  if (!value.matches.every(isSourceMatch)) {
    return invalidResultResolution(pluginId);
  }
  if (value.status !== undefined && !isPluginResolutionStatus(value.status)) {
    return invalidResultResolution(pluginId);
  }
  const diagnostics = value.diagnostics ?? [];
  if (!diagnostics.every(isPluginDiagnostic)) {
    return invalidResultResolution(pluginId);
  }

  const matches = value.matches.map((match) => ({ ...match, pluginId }));
  const resolvedDiagnostics = diagnostics.map((diagnostic) => ({
      ...diagnostic,
      pluginId,
    }));
  if (value.status === "matched" && matches.length === 0) {
    return invalidResultResolution(pluginId);
  }
  return {
    pluginId,
    status: matches.length > 0
      ? "matched"
      : value.status ?? inferPluginStatus(resolvedDiagnostics),
    matches,
    diagnostics: resolvedDiagnostics,
  };
}

function invalidResultResolution(pluginId: string): PluginResolution {
  return diagnosticResolution(pluginId, {
    code: "plugin.invalidResult",
    message: "Source plugin returned an invalid result",
    severity: "warning",
  });
}

function isSourceMatch(value: unknown): value is SourceMatch {
  if (!isRecord(value)) return false;
  return (
    (value.targetRole === "selected" || value.targetRole === "parent") &&
    isSourceRange(value.range) &&
    typeof value.label === "string" &&
    typeof value.kind === "string" &&
    typeof value.relation === "string" &&
    isConfidence(value.confidence) &&
    isOptionalJsonObject(value.metadata)
  );
}

function isPluginDiagnostic(value: unknown): value is PluginDiagnostic {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.severity === "info" ||
      value.severity === "warning" ||
      value.severity === "error") &&
    isOptionalJsonObject(value.metadata)
  );
}

function isSourceRange(value: unknown): value is SourceMatch["range"] {
  return isRecord(value) &&
    isSourcePosition(value.start) &&
    isSourcePosition(value.end);
}

function isSourcePosition(value: unknown): value is {
  readonly line: number;
  readonly character: number;
} {
  return isRecord(value) &&
    typeof value.line === "number" &&
    typeof value.character === "number";
}

function isConfidence(value: unknown): value is SourceMatch["confidence"] {
  return value === "exact" ||
    value === "sourcemap" ||
    value === "instrumented" ||
    value === "heuristic" ||
    value === "unknown";
}

function isPluginResolutionStatus(value: unknown): value is ResolutionStatus {
  return value === "matched" ||
    value === "source-not-found" ||
    value === "source-not-active-document" ||
    value === "source-ambiguous" ||
    value === "source-map-missing" ||
    value === "source-map-invalid" ||
    value === "no-rule-match" ||
    value === "rule-match-ambiguous" ||
    value === "error";
}

function inferPluginStatus(
  diagnostics: readonly ResolvedPluginDiagnostic[],
): ResolutionStatus {
  const codes = new Set(diagnostics.map((entry) => entry.code));
  if (
    codes.has("css.sourceAmbiguous") ||
    codes.has("scss.generatedSourceAmbiguous") ||
    codes.has("scss.sourceAmbiguous")
  ) {
    return "source-ambiguous";
  }
  if (codes.has("scss.originalSourceNotFound")) return "source-not-found";
  if (codes.has("scss.sourceMapInvalid")) return "source-map-invalid";
  if (codes.has("scss.sourceMapMissing")) return "source-map-missing";
  if (codes.has("scss.mappingMissing")) return "no-rule-match";
  if (
    diagnostics.some(
      (entry) =>
        entry.severity === "error" || entry.code.startsWith("plugin."),
    )
  ) {
    return "error";
  }
  return "no-rule-match";
}

function isOptionalJsonObject(value: unknown): boolean {
  return value === undefined || JsonObjectSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
