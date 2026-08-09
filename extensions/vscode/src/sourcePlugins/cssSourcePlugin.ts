import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourceUriResolution,
} from "@browser2ide/plugin-api";
import type { ResolutionStatus } from "@browser2ide/protocol";
import { targetCssFacts } from "./cssFacts.js";
import {
  canFingerprintFallback,
  findExactCssRules,
  findRulesByFingerprint,
  StylesheetAstCache,
} from "./stylesheetAst.js";
import { classifyActiveDocumentSource } from "./sourceWorkspace.js";
import type { StatusAwareSourcePluginResult } from "./types.js";

export class CssSourcePlugin implements SourcePlugin {
  public readonly id = "browser2ide.css";
  public readonly displayName = "Browser2IDE CSS";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "css", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["css-rule"] as const;

  public constructor(private readonly ast = new StylesheetAstCache()) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<StatusAwareSourcePluginResult> {
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
    const strategyDiagnostics = new Map<
      SourceUriResolution["strategy"],
      PluginDiagnostic
    >();
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const resolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (!strategyDiagnostics.has(resolution.strategy)) {
        strategyDiagnostics.set(
          resolution.strategy,
          sourceStrategyDiagnostic(resolution),
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
  if (resolution.strategy === "automatic") {
    return {
      code: "css.sourceAutomatic",
      message: "Automatic source matching",
      severity: "info",
    };
  }
  return {
    code: "css.sourceWorkspaceBound",
    message: `Workspace-bound: ${workspaceFolderLabel(resolution)}`,
    severity: "info",
  };
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
    const label = decodeURIComponent(segment);
    if (
      label.trim().length === 0 ||
      /^[a-z]:$/i.test(label) ||
      /[/\\\u0000-\u001f\u007f]/.test(label)
    ) {
      return fallback;
    }
    return label;
  } catch {
    return fallback;
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
