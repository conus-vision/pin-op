import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourceUriResolution,
} from "@pin-op/plugin-api";
import type { ResolutionStatus } from "@pin-op/protocol";
import { targetCssFacts, type TargetCssFact } from "./cssFacts.js";
import {
  findMatchingCssRules,
  smallestContainingRule,
  StylesheetAstCache,
  type StylesheetRule,
} from "./stylesheetAst.js";
import { classifyActiveDocumentSource } from "./sourceWorkspace.js";
import { SourceMapLoader } from "./sourceMapLoader.js";
import type { StatusAwareSourcePluginResult } from "./types.js";

const MAX_WORKSPACE_LABEL_LENGTH = 128;

export class ScssSourcePlugin implements SourcePlugin {
  public readonly id = "pin-op.scss";
  public readonly displayName = "PinOp SCSS";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "scss", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["css-rule"] as const;

  public constructor(
    private readonly ast = new StylesheetAstCache(),
    private readonly maps = new SourceMapLoader(),
  ) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<StatusAwareSourcePluginResult> {
    if (context.signal.aborted) return abortedResult();
    let original;
    try {
      original = this.ast.parseDocument(context.document, "scss");
    } catch (error) {
      return {
        status: "error",
        matches: [],
        diagnostics: [diagnostic(
          "scss.parseFailed",
          `SCSS could not be parsed: ${messageOf(error)}`,
          "error",
        )],
      };
    }
    if (context.signal.aborted) return abortedResult();

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const failures = new Set<ResolutionStatus>();
    const strategyDiagnostics = new Map<string, PluginDiagnostic>();
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) return abortedResult();
      const generatedResolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (context.signal.aborted) return abortedResult();
      addStrategyDiagnostic(strategyDiagnostics, generatedResolution);
      if (
        generatedResolution.status === "ambiguous" ||
        generatedResolution.uris.length > 1
      ) {
        failures.add("source-ambiguous");
        diagnostics.push(diagnostic(
          "scss.generatedSourceAmbiguous",
          `Generated CSS maps to more than one workspace file: ${entry.sourceUrl}`,
        ));
        continue;
      }
      const generatedIsExact = generatedResolution.status === "exact" &&
        generatedResolution.uris.length === 1;
      const generatedIsAutomaticBasename =
        generatedResolution.strategy === "automatic" &&
        generatedResolution.status === "unique-basename" &&
        generatedResolution.uris.length === 1;
      if (!generatedIsExact && !generatedIsAutomaticBasename) {
        failures.add("source-not-found");
        diagnostics.push(diagnostic(
          "scss.generatedSourceNotFound",
          `Generated CSS is not in the workspace: ${entry.sourceUrl}`,
          "info",
        ));
        continue;
      }
      if (generatedIsAutomaticBasename) {
        diagnostics.push(diagnostic(
          "scss.generatedSourceHeuristic",
          `Generated CSS used automatic basename matching: ${entry.sourceUrl}`,
          "info",
        ));
      }
      await this.resolveGenerated(
        context,
        entry,
        generatedResolution.uris[0]!,
        original.rules,
        matches,
        diagnostics,
        failures,
        strategyDiagnostics,
      );
      if (context.signal.aborted) return abortedResult();
    }

    if (context.signal.aborted) return abortedResult();

    const uniqueMatches = deduplicate(matches).sort(compareByRange);
    return {
      status: uniqueMatches.length > 0 ? "matched" : failureStatus(failures),
      matches: uniqueMatches,
      diagnostics: deduplicateDiagnostics([
        ...diagnostics,
        ...strategyDiagnostics.values(),
      ]),
    };
  }

  private async resolveGenerated(
    context: SourcePluginContext,
    entry: TargetCssFact,
    generatedUri: string,
    originalRules: readonly StylesheetRule[],
    matches: SourceMatch[],
    diagnostics: PluginDiagnostic[],
    failures: Set<ResolutionStatus>,
    strategyDiagnostics: Map<string, PluginDiagnostic>,
  ): Promise<void> {
    if (context.signal.aborted) return;
    let generatedText: string;
    let generated;
    try {
      generatedText = await context.workspace.readText(generatedUri);
      if (context.signal.aborted) return;
      generated = this.ast.parseText(generatedUri, "css", generatedText);
      if (context.signal.aborted) return;
    } catch (error) {
      if (context.signal.aborted) return;
      failures.add("error");
      diagnostics.push(diagnostic(
        "scss.generatedReadFailed",
        `Generated CSS could not be read or parsed: ${messageOf(error)}`,
        "error",
      ));
      return;
    }

    const generatedRules = findMatchingCssRules(
      generated,
      entry.fact,
      generated.document,
      entry.declarations,
    );
    if (generatedRules.length > 1) {
      failures.add("rule-match-ambiguous");
      diagnostics.push(diagnostic(
        "scss.generatedRuleAmbiguous",
        `More than one generated CSS rule matches the available evidence: ${entry.fact.selector}`,
      ));
      return;
    }
    const generatedRule = generatedRules[0];
    if (!generatedRule) {
      failures.add("no-rule-match");
      return;
    }

    let mapResult: Awaited<ReturnType<SourceMapLoader["resolve"]>>;
    try {
      mapResult = await this.maps.resolve(
        generatedUri,
        generatedText,
        generatedRule,
        context.workspace,
        new URL(
          entry.sourceUrl,
          context.selection.context.url,
        ).toString(),
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) return;
      failures.add("source-map-invalid");
      diagnostics.push(diagnostic(
        "scss.sourceMapReadFailed",
        `SCSS source map could not be loaded: ${messageOf(error)}`,
        "error",
      ));
      return;
    }
    if (context.signal.aborted) return;
    diagnostics.push(...mapResult.diagnostics);
    if (mapResult.kind === "missing") {
      failures.add("source-map-missing");
      return;
    }
    if (mapResult.kind === "invalid") {
      failures.add("source-map-invalid");
      return;
    }
    if (mapResult.kind === "unmapped") {
      failures.add("no-rule-match");
      diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
      return;
    }

    const sourceResolution = await context.workspace.resolveSourceUri(
      mapResult.sourceUrl,
      context.selection.context.url,
    );
    if (context.signal.aborted) return;
    addStrategyDiagnostic(strategyDiagnostics, sourceResolution);
    const sourceKind = classifyActiveDocumentSource(
      sourceResolution,
      context.document.uri,
    );
    if (sourceKind === "ambiguous") {
      failures.add("source-ambiguous");
      diagnostics.push(diagnostic(
        "scss.sourceAmbiguous",
        `Mapped SCSS source is ambiguous: ${mapResult.sourceUrl}`,
      ));
      return;
    }
    if (sourceKind === "not-found") {
      failures.add("source-not-found");
      diagnostics.push(diagnostic(
        "scss.originalSourceNotFound",
        `Mapped SCSS source is not in the workspace: ${mapResult.sourceUrl}`,
      ));
      return;
    }
    if (sourceKind === "other-document") {
      failures.add("source-not-active-document");
      diagnostics.push(diagnostic(
        "scss.sourceNotActiveDocument",
        `Mapped SCSS source resolves outside the active document: ${mapResult.sourceUrl}`,
        "info",
      ));
      return;
    }

    const mappedPosition = {
      line: mapResult.line - 1,
      character: mapResult.column,
    };
    const mappedOffset = context.document.offsetAt(mappedPosition);
    const roundTrippedPosition = context.document.positionAt(mappedOffset);
    if (
      roundTrippedPosition.line !== mappedPosition.line ||
      roundTrippedPosition.character !== mappedPosition.character
    ) {
      failures.add("no-rule-match");
      diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
      return;
    }

    const rule = smallestContainingRule(originalRules, mappedOffset);
    if (!rule) {
      failures.add("no-rule-match");
      diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
      return;
    }
    matches.push(sourceMappedMatch(
      entry,
      rule,
      generatedUri,
      mapResult.mapUri,
    ));
  }
}

function sourceMappedMatch(
  entry: TargetCssFact,
  rule: StylesheetRule,
  generatedUri: string,
  mapUri: string,
): SourceMatch {
  return {
    targetRole: entry.targetRole,
    range: rule.range,
    label: entry.fact.selector,
    kind: "style-rule",
    relation: "styles",
    confidence: "sourcemap",
    metadata: { generatedUri, mapUri, sourceUrl: entry.sourceUrl },
  };
}

function mappingMissingDiagnostic(selector: string): PluginDiagnostic {
  return diagnostic(
    "scss.mappingMissing",
    `Source map has no SCSS rule mapping for ${selector}`,
  );
}

function addStrategyDiagnostic(
  diagnostics: Map<string, PluginDiagnostic>,
  resolution: SourceUriResolution,
): void {
  const entry = sourceStrategyDiagnostic(resolution);
  const key = JSON.stringify([entry.code, entry.message]);
  if (!diagnostics.has(key)) diagnostics.set(key, entry);
}

function sourceStrategyDiagnostic(
  resolution: SourceUriResolution,
): PluginDiagnostic {
  const strategy = resolution.strategy;
  switch (strategy) {
    case "automatic":
      return diagnostic(
        "scss.sourceAutomatic",
        "Automatic source matching",
        "info",
      );
    case "workspace-bound":
      return diagnostic(
        "scss.sourceWorkspaceBound",
        `Workspace-bound: ${workspaceFolderLabel(resolution)}`,
        "info",
      );
    default:
      return unsupportedSourceResolutionStrategy(strategy);
  }
}

function workspaceFolderLabel(resolution: SourceUriResolution): string {
  const fallback = resolution.status === "ambiguous"
    ? "ambiguous workspace"
    : "workspace";
  if (resolution.workspaceFolderUri === undefined) return fallback;
  try {
    const pathname = new URL(resolution.workspaceFolderUri).pathname
      .replace(/\/+$/, "");
    const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
    const label = decodeURIComponent(segment)
      .replace(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        "",
      )
      .trim();
    if (
      label.length === 0 ||
      /^[a-z]:$/i.test(label) ||
      /[/\\]/.test(label)
    ) {
      return fallback;
    }
    return [...label]
      .slice(0, MAX_WORKSPACE_LABEL_LENGTH)
      .join("")
      .trim() || fallback;
  } catch {
    return fallback;
  }
}

function unsupportedSourceResolutionStrategy(strategy: never): never {
  throw new Error(
    `Unsupported SCSS source resolution strategy: ${String(strategy)}`,
  );
}

function diagnostic(
  code: string,
  message: string,
  severity: PluginDiagnostic["severity"] = "warning",
): PluginDiagnostic {
  return { code, message, severity };
}

function deduplicate(matches: readonly SourceMatch[]): SourceMatch[] {
  const unique = new Map<string, SourceMatch>();
  for (const match of matches) {
    const key = JSON.stringify([
      match.targetRole,
      match.range,
      match.kind,
      match.relation,
    ]);
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()];
}

function deduplicateDiagnostics(
  diagnostics: readonly PluginDiagnostic[],
): PluginDiagnostic[] {
  const unique = new Map<string, PluginDiagnostic>();
  for (const entry of diagnostics) {
    const key = `${entry.code}:${entry.message}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function compareByRange(left: SourceMatch, right: SourceMatch): number {
  return left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character;
}

function failureStatus(failures: ReadonlySet<ResolutionStatus>): ResolutionStatus {
  for (const status of [
    "source-ambiguous",
    "source-not-active-document",
    "source-not-found",
    "source-map-invalid",
    "source-map-missing",
    "rule-match-ambiguous",
    "no-rule-match",
    "error",
  ] as const) {
    if (failures.has(status)) return status;
  }
  return "no-rule-match";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedResult(): StatusAwareSourcePluginResult {
  return { status: "no-rule-match", matches: [], diagnostics: [] };
}
