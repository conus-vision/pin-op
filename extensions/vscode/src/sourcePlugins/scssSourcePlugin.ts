import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourcePluginResult,
} from "@browser2ide/plugin-api";
import {
  SourceMapConsumer,
  type RawSourceMap,
} from "source-map";
import { targetCssFacts, type TargetCssFact } from "./cssFacts.js";
import {
  findMatchingCssRules,
  smallestContainingRule,
  StylesheetAstCache,
  type StylesheetRule,
} from "./stylesheetAst.js";
import { classifyActiveDocumentSource } from "./sourceWorkspace.js";
import {
  SourceMapLoader,
  type LoadedRawSourceMap,
} from "./sourceMapLoader.js";

interface MappedPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export class ScssSourcePlugin implements SourcePlugin {
  public readonly id = "browser2ide.scss";
  public readonly displayName = "Browser2IDE SCSS";
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
  ): Promise<SourcePluginResult> {
    if (context.signal.aborted) return abortedResult();
    let original;
    try {
      original = this.ast.parseDocument(context.document, "scss");
    } catch (error) {
      return {
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
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const generatedResolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (context.signal.aborted) break;
      if (
        generatedResolution.status === "ambiguous" ||
        generatedResolution.uris.length > 1
      ) {
        diagnostics.push(diagnostic(
          "scss.generatedSourceAmbiguous",
          `Generated CSS maps to more than one workspace file: ${entry.sourceUrl}`,
        ));
      }
      if (
        generatedResolution.status !== "exact" ||
        generatedResolution.uris.length !== 1
      ) {
        continue;
      }
      for (const generatedUri of generatedResolution.uris) {
        if (context.signal.aborted) break;
        await this.resolveGenerated(
          context,
          entry,
          generatedUri,
          original.rules,
          matches,
          diagnostics,
        );
      }
    }

    if (context.signal.aborted) return abortedResult();

    return {
      matches: deduplicate(matches).sort(compareByRange),
      diagnostics: deduplicateDiagnostics(diagnostics),
    };
  }

  private async resolveGenerated(
    context: SourcePluginContext,
    entry: TargetCssFact,
    generatedUri: string,
    originalRules: readonly StylesheetRule[],
    matches: SourceMatch[],
    diagnostics: PluginDiagnostic[],
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
      diagnostics.push(diagnostic(
        "scss.generatedReadFailed",
        `Generated CSS could not be read or parsed: ${messageOf(error)}`,
        "error",
      ));
      return;
    }

    let mapResult: Awaited<ReturnType<SourceMapLoader["load"]>>;
    try {
      mapResult = await this.maps.load(
        generatedUri,
        generatedText,
        context.workspace,
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) return;
      diagnostics.push(diagnostic(
        "scss.sourceMapReadFailed",
        `SCSS source map could not be loaded: ${messageOf(error)}`,
        "error",
      ));
      return;
    }
    if (context.signal.aborted) return;
    if (!mapResult.rawMap || !mapResult.mapUri) {
      diagnostics.push(...mapResult.diagnostics);
      return;
    }

    const generatedRules = findMatchingCssRules(
      generated,
      entry.fact,
      generated.document,
      entry.declarations,
    );
    let mapped: readonly (MappedPosition | undefined)[];
    try {
      mapped = await mapGeneratedStarts(
        mapResult.rawMap,
        generatedRules,
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) return;
      diagnostics.push(diagnostic(
        "scss.sourceMapInvalid",
        `SCSS source map is invalid: ${messageOf(error)}`,
      ));
      return;
    }
    if (context.signal.aborted) return;

    for (const [index, generatedRule] of generatedRules.entries()) {
      if (context.signal.aborted) return;
      const position = mapped[index];
      if (!position) {
        diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
        continue;
      }
      const sourceResolution = await context.workspace.resolveSourceUri(
        position.source,
        mapResult.mapUri,
      );
      if (context.signal.aborted) return;
      const sourceKind = classifyActiveDocumentSource(
        sourceResolution,
        context.document.uri,
      );
      if (sourceKind === "ambiguous") {
        diagnostics.push(diagnostic(
          "scss.sourceAmbiguous",
          `Mapped SCSS source is ambiguous: ${position.source}`,
        ));
        continue;
      }
      if (sourceKind === "not-found") {
        diagnostics.push(diagnostic(
          "scss.originalSourceNotFound",
          `Mapped SCSS source is not in the workspace: ${position.source}`,
        ));
        continue;
      }
      if (sourceKind !== "active-document") continue;

      const rule = smallestContainingRule(
        originalRules,
        context.document.offsetAt({
          line: position.line - 1,
          character: position.column,
        }),
      );
      if (!rule) {
        diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
        continue;
      }
      matches.push(sourceMappedMatch(
        entry,
        rule,
        generatedUri,
        mapResult.mapUri,
      ));
    }
  }
}

async function mapGeneratedStarts(
  rawMap: LoadedRawSourceMap,
  rules: readonly StylesheetRule[],
  signal: AbortSignal,
): Promise<readonly (MappedPosition | undefined)[]> {
  if (signal.aborted) throw abortError();
  const mapped = await SourceMapConsumer.with(
    rawMap as RawSourceMap,
    null,
    (consumer) => rules.map((rule) => {
      if (signal.aborted) throw abortError();
      const mapped = consumer.originalPositionFor({
        line: rule.range.start.line + 1,
        column: rule.range.start.character,
      });
      if (!mapped.source || mapped.line === null || mapped.column === null) {
        return undefined;
      }
      return {
        source: mapped.source,
        line: mapped.line,
        column: mapped.column,
      };
    }),
  );
  if (signal.aborted) throw abortError();
  return mapped;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedResult(): SourcePluginResult {
  return { matches: [], diagnostics: [] };
}

function abortError(): Error {
  const error = new Error("SCSS source resolution was aborted");
  error.name = "AbortError";
  return error;
}
