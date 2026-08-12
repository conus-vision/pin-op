import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  PluginDiagnostic,
  SourceWorkspace,
} from "@pinop/plugin-api";
import {
  SourceMapConsumer,
  type RawSourceMap,
} from "source-map";
import { BoundedLruCache } from "./boundedLruCache.js";
import type { StylesheetRule } from "./stylesheetAst.js";
import type { SourceMapResolution } from "./types.js";

export type LoadedRawSourceMap = Omit<RawSourceMap, "file"> & {
  readonly file?: string;
};

export interface SourceMapLoadResult {
  readonly mapUri?: string;
  readonly rawMap?: LoadedRawSourceMap;
  readonly diagnostics: readonly PluginDiagnostic[];
}

interface GeneratedMapping {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

interface CachedSourceMap {
  readonly rawMap: LoadedRawSourceMap;
  mappingIndex?: Promise<readonly GeneratedMapping[]>;
}

interface CachedSourceMapLoadResult {
  readonly mapUri?: string;
  readonly cachedMap?: CachedSourceMap;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export const SOURCE_MAP_CACHE_LIMIT = 32;

export class SourceMapLoader {
  private readonly cache = new BoundedLruCache<string, CachedSourceMap>(
    SOURCE_MAP_CACHE_LIMIT,
  );

  public async resolve(
    generatedUri: string,
    generatedText: string,
    generatedRule: StylesheetRule,
    workspace: SourceWorkspace,
    generatedSourceUrl: string,
    signal?: AbortSignal,
  ): Promise<SourceMapResolution> {
    const loaded = await this.loadCached(
      generatedUri,
      generatedText,
      workspace,
      signal,
    );
    if (!loaded.cachedMap || !loaded.mapUri) {
      return loaded.diagnostics.some(
          (entry) => entry.code === "scss.sourceMapMissing",
        )
        ? { kind: "missing", diagnostics: loaded.diagnostics }
        : invalidResolution(loaded.diagnostics);
    }

    try {
      throwIfAborted(signal);
      const mappingIndex = await this.mappingIndex(
        loaded.cachedMap,
        signal,
      );
      const mapped = mappingWithinRule(mappingIndex, generatedRule);
      throwIfAborted(signal);
      if (!mapped) {
        return {
          kind: "unmapped",
          mapUri: loaded.mapUri,
          diagnostics: [],
        };
      }
      return {
        kind: "mapped",
        mapUri: loaded.mapUri,
        sourceUrl: resolveMappedSourceUrl(
          mapped.source,
          generatedSourceUrl,
          lastSourceMapReference(generatedText),
        ),
        line: mapped.line,
        column: mapped.column,
        diagnostics: [],
      };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return invalidResolution([
        {
          code: "scss.sourceMapInvalid",
          message: `SCSS source map is invalid: ${messageOf(error)}`,
          severity: "warning",
        },
      ]);
    }
  }

  public async load(
    generatedUri: string,
    generatedText: string,
    workspace: SourceWorkspace,
    signal?: AbortSignal,
  ): Promise<SourceMapLoadResult> {
    const loaded = await this.loadCached(
      generatedUri,
      generatedText,
      workspace,
      signal,
    );
    return loaded.cachedMap && loaded.mapUri
      ? {
        mapUri: loaded.mapUri,
        rawMap: loaded.cachedMap.rawMap,
        diagnostics: loaded.diagnostics,
      }
      : { diagnostics: loaded.diagnostics };
  }

  private async loadCached(
    generatedUri: string,
    generatedText: string,
    workspace: SourceWorkspace,
    signal?: AbortSignal,
  ): Promise<CachedSourceMapLoadResult> {
    throwIfAborted(signal);
    const reference = lastSourceMapReference(generatedText);
    if (!reference) {
      return failed("scss.sourceMapMissing", "SCSS source map was not found");
    }

    let mapUri: string;
    let rawJson: string;
    try {
      throwIfAborted(signal);
      if (reference.startsWith("data:")) {
        mapUri = `${generatedUri}#inline-source-map`;
        rawJson = decodeDataUrl(reference);
      } else {
        mapUri = workspace.resolveRelativeUri(generatedUri, reference);
        rawJson = await workspace.readText(mapUri);
      }
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return failed(
        "scss.sourceMapReadFailed",
        `SCSS source map could not be read: ${messageOf(error)}`,
      );
    }

    throwIfAborted(signal);
    const cacheKey = `${mapUri}:${createHash("sha256").update(rawJson).digest("hex")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { mapUri, cachedMap: cached, diagnostics: [] };

    try {
      throwIfAborted(signal);
      const parsed = JSON.parse(rawJson) as unknown;
      throwIfAborted(signal);
      if (!isRawSourceMap(parsed)) {
        throw new Error("source map has an invalid shape");
      }
      const cachedMap = { rawMap: parsed };
      this.cache.set(cacheKey, cachedMap);
      return { mapUri, cachedMap, diagnostics: [] };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return failed(
        "scss.sourceMapInvalid",
        `SCSS source map is invalid: ${messageOf(error)}`,
      );
    }
  }

  private async mappingIndex(
    cachedMap: CachedSourceMap,
    signal: AbortSignal | undefined,
  ): Promise<readonly GeneratedMapping[]> {
    throwIfAborted(signal);
    cachedMap.mappingIndex ??= buildMappingIndex(cachedMap.rawMap);
    const mappings = await cachedMap.mappingIndex;
    throwIfAborted(signal);
    return mappings;
  }
}

async function buildMappingIndex(
  rawMap: LoadedRawSourceMap,
): Promise<readonly GeneratedMapping[]> {
  return SourceMapConsumer.with(
    rawMap as RawSourceMap,
    null,
    (consumer) => {
      const mappings: GeneratedMapping[] = [];
      consumer.eachMapping((mapping) => {
        if (
          !mapping.source ||
          mapping.originalLine === null ||
          mapping.originalColumn === null
        ) {
          return;
        }
        mappings.push({
          generatedLine: mapping.generatedLine,
          generatedColumn: mapping.generatedColumn,
          source: mapping.source,
          line: mapping.originalLine,
          column: mapping.originalColumn,
        });
      }, null, SourceMapConsumer.GENERATED_ORDER);
      return mappings;
    },
  );
}

function mappingWithinRule(
  mappings: readonly GeneratedMapping[],
  generatedRule: StylesheetRule,
): GeneratedMapping | undefined {
  let low = 0;
  let high = mappings.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const mapping = mappings[middle]!;
    const line = mapping.generatedLine - 1;
    if (
      line < generatedRule.range.start.line ||
      (line === generatedRule.range.start.line &&
        mapping.generatedColumn < generatedRule.range.start.character)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const candidate = mappings[low];
  return candidate && generatedMappingIsWithinRule(
      candidate.generatedLine,
      candidate.generatedColumn,
      generatedRule,
    )
    ? candidate
    : undefined;
}

function generatedMappingIsWithinRule(
  generatedLine: number,
  generatedColumn: number,
  generatedRule: StylesheetRule,
): boolean {
  const line = generatedLine - 1;
  const { start, end } = generatedRule.range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && generatedColumn < start.character) return false;
  if (line === end.line && generatedColumn >= end.character) return false;
  return true;
}

function resolveMappedSourceUrl(
  mappedSource: string,
  generatedSourceUrl: string,
  mapReference: string | undefined,
): string {
  const sourceBaseUrl = mapReference && !mapReference.startsWith("data:")
    ? new URL(mapReference, generatedSourceUrl).toString()
    : generatedSourceUrl;
  return new URL(mappedSource, sourceBaseUrl).toString();
}

function lastSourceMapReference(generatedText: string): string | undefined {
  const directives = [
    ...generatedText.matchAll(
      /(?:\/\*[#@]\s*|\/\/[#@]\s*)sourceMappingURL=([^\s*]+)[^\n]*?/g,
    ),
  ];
  return directives.at(-1)?.[1];
}

function decodeDataUrl(reference: string): string {
  const separator = reference.indexOf(",");
  if (separator < 0) throw new Error("inline source map has no data payload");
  const metadata = reference.slice(5, separator).toLowerCase();
  const payload = reference.slice(separator + 1);
  return metadata.split(";").includes("base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
}

function isRawSourceMap(value: unknown): value is LoadedRawSourceMap {
  if (!isRecord(value)) return false;
  return value.version === 3 &&
    Array.isArray(value.sources) &&
    value.sources.every((source) => typeof source === "string") &&
    Array.isArray(value.names) &&
    value.names.every((name) => typeof name === "string") &&
    typeof value.mappings === "string" &&
    (value.file === undefined || typeof value.file === "string") &&
    (value.sourceRoot === undefined || typeof value.sourceRoot === "string") &&
    (value.sourcesContent === undefined ||
      (Array.isArray(value.sourcesContent) &&
        value.sourcesContent.every(
          (content) => content === null || typeof content === "string",
        )));
}

function failed(code: string, message: string): SourceMapLoadResult {
  return {
    diagnostics: [{ code, message, severity: "warning" }],
  };
}

function invalidResolution(
  diagnostics: readonly PluginDiagnostic[],
): SourceMapResolution {
  return {
    kind: "invalid",
    diagnosticCode: "resolver.source-read-failed",
    diagnostics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Source map loading was aborted");
  error.name = "AbortError";
  return error;
}
