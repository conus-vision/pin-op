import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourceUriResolution,
} from "@pinop/plugin-api";
import type { ResolutionStatus } from "@pinop/protocol";
import { targetCssFacts } from "./cssFacts.js";
import {
  canFingerprintFallback,
  findExactCssRules,
  findRulesByFingerprint,
  StylesheetAstCache,
} from "./stylesheetAst.js";
import { classifyActiveDocumentSource } from "./sourceWorkspace.js";
import type { StatusAwareSourcePluginResult } from "./types.js";

const MAX_WORKSPACE_LABEL_LENGTH = 128;

export class CssSourcePlugin implements SourcePlugin {
  public readonly id = "pinop.css";
  public readonly displayName = "PinOp CSS";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "css", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["css-rule"] as const;

  public constructor(private readonly ast = new StylesheetAstCache()) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<StatusAwareSourcePluginResult> {
    if (context.signal.aborted) return abortedResult();
    let parsed;
    try {
      parsed = this.ast.parseDocument(context.document, "css");
    } catch (error) {
      return {
        status: "error",
        matches: [],
        diagnostics: [parseDiagnostic(error)],
      };
    }

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const ambiguousUrls = new Set<string>();
    const otherDocumentUrls = new Set<string>();
    const missingUrls = new Set<string>();
    const ambiguousRules = new Set<string>();
    const failures = new Set<ResolutionStatus>();
    const strategyDiagnostics = new Map<string, PluginDiagnostic>();
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) return abortedResult();
      const resolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (context.signal.aborted) return abortedResult();
      const strategyDiagnostic = sourceStrategyDiagnostic(resolution);
      const strategyDiagnosticKey = JSON.stringify([
        strategyDiagnostic.code,
        strategyDiagnostic.message,
      ]);
      if (!strategyDiagnostics.has(strategyDiagnosticKey)) {
        strategyDiagnostics.set(
          strategyDiagnosticKey,
          strategyDiagnostic,
        );
      }
      const sourceKind = classifyActiveDocumentSource(
        resolution,
        context.document.uri,
      );
      if (sourceKind === "ambiguous") {
        failures.add("source-ambiguous");
        addOnce(
          ambiguousUrls,
          entry.sourceUrl,
          diagnostics,
          ambiguousSourceDiagnostic,
        );
        continue;
      }
      if (sourceKind === "other-document") {
        failures.add("source-not-active-document");
        addOnce(
          otherDocumentUrls,
          entry.sourceUrl,
          diagnostics,
          otherDocumentDiagnostic,
        );
        continue;
      }

      const exactRules = sourceKind === "active-document"
        ? findExactCssRules(parsed, entry.fact, context.document)
        : [];
      const canFallback = sourceKind === "not-found"
        ? resolution.strategy === "automatic" &&
          canFingerprintFallback(entry.fact)
        : canFingerprintFallback(entry.fact, context.document);
      const rules = exactRules.length > 0
        ? exactRules
        : canFallback
          ? findRulesByFingerprint(parsed, entry.fact, entry.declarations)
          : [];
      if (rules.length > 1) {
        failures.add("rule-match-ambiguous");
        addOnce(
          ambiguousRules,
          entry.fact.selector,
          diagnostics,
          ambiguousRuleDiagnostic,
        );
        continue;
      }
      const rule = rules[0];
      if (rule) {
        matches.push(sourceMatch(
          entry,
          rule.range,
          exactRules.length > 0 ? "exact" : "heuristic",
        ));
        continue;
      }
      if (sourceKind === "not-found") {
        failures.add("source-not-found");
        addOnce(
          missingUrls,
          entry.sourceUrl,
          diagnostics,
          missingSourceDiagnostic,
        );
      } else {
        failures.add("no-rule-match");
      }
    }
    return {
      status: matches.length > 0 ? "matched" : failureStatus(failures),
      matches,
      diagnostics: [...diagnostics, ...strategyDiagnostics.values()],
    };
  }
}

function sourceMatch(
  entry: ReturnType<typeof targetCssFacts>[number],
  range: SourceMatch["range"],
  confidence: "exact" | "heuristic",
): SourceMatch {
  return {
    targetRole: entry.targetRole,
    range,
    label: entry.fact.selector,
    kind: "style-rule",
    relation: "styles",
    confidence,
    metadata: { sourceUrl: entry.sourceUrl },
  };
}

function parseDiagnostic(error: unknown): PluginDiagnostic {
  return {
    code: "css.parseFailed",
    message: `CSS could not be parsed: ${messageOf(error)}`,
    severity: "error",
  };
}

function ambiguousSourceDiagnostic(sourceUrl: string): PluginDiagnostic {
  return {
    code: "css.sourceAmbiguous",
    message: `CSS source maps to more than one workspace file: ${sourceUrl}`,
    severity: "warning",
    metadata: { sourceUrl },
  };
}

function otherDocumentDiagnostic(sourceUrl: string): PluginDiagnostic {
  return {
    code: "css.sourceNotActiveDocument",
    message: `CSS source resolves outside the active document: ${sourceUrl}`,
    severity: "info",
    metadata: { sourceUrl },
  };
}

function missingSourceDiagnostic(sourceUrl: string): PluginDiagnostic {
  return {
    code: "css.sourceNotFound",
    message: `CSS source is not in the workspace: ${sourceUrl}`,
    severity: "info",
    metadata: { sourceUrl },
  };
}

function ambiguousRuleDiagnostic(selector: string): PluginDiagnostic {
  return {
    code: "css.ruleMatchAmbiguous",
    message: `More than one CSS rule matches the available evidence: ${selector}`,
    severity: "warning",
  };
}

function sourceStrategyDiagnostic(
  resolution: SourceUriResolution,
): PluginDiagnostic {
  const strategy = resolution.strategy;
  switch (strategy) {
    case "automatic":
      return {
        code: "css.sourceAutomatic",
        message: "Automatic source matching",
        severity: "info",
      };
    case "workspace-bound":
      return {
        code: "css.sourceWorkspaceBound",
        message: `Workspace-bound: ${workspaceFolderLabel(resolution)}`,
        severity: "info",
      };
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
    `Unsupported CSS source resolution strategy: ${String(strategy)}`,
  );
}

function addOnce(
  seen: Set<string>,
  key: string,
  diagnostics: PluginDiagnostic[],
  create: (value: string) => PluginDiagnostic,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  diagnostics.push(create(key));
}

function failureStatus(failures: ReadonlySet<ResolutionStatus>): ResolutionStatus {
  for (const status of [
    "source-ambiguous",
    "source-not-active-document",
    "source-not-found",
    "rule-match-ambiguous",
    "no-rule-match",
  ] as const) {
    if (failures.has(status)) return status;
  }
  return "no-rule-match";
}

function abortedResult(): StatusAwareSourcePluginResult {
  return { status: "no-rule-match", matches: [], diagnostics: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
