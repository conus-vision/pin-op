import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  PluginDiagnostic,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import { utf8ByteLength } from "@pin-op/protocol";
import {
  SourceMapConsumer,
  type RawSourceMap,
} from "source-map";
import { BoundedLruCache } from "./boundedLruCache.js";
import {
  canonicalRulesSourceUri,
  raceWithAbort,
} from "./sourceWorkspace.js";
import type { StylesheetRule } from "./stylesheetAst.js";
import type { SourceMapResolution } from "./types.js";

export type LoadedRawSourceMap = Omit<RawSourceMap, "file"> & {
  readonly file?: string;
};

export interface SourceMapLoadResult {
  readonly mapUri?: string;
  readonly rawMap?: LoadedRawSourceMap;
  readonly mapKind?: "inline" | "external";
  readonly mapText?: string;
  readonly mapContentHash?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

interface GeneratedMapping {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly sourceContent?: string;
}

export type SelectorSourceMapResolution =
  | Extract<SourceMapResolution, { readonly kind: "mapped" }> & {
      readonly sourceContent?: string;
      readonly selectorMappings: readonly SelectorOriginalMapping[];
      readonly mapKind: "inline" | "external";
      readonly mapText: string;
      readonly mapContentHash: string;
    }
  | Exclude<SourceMapResolution, { readonly kind: "mapped" }>;

export interface SelectorOriginalMapping {
  readonly sourceUrl: string;
  readonly line: number;
  readonly column: number;
  readonly sourceContent?: string;
}

interface CachedSourceMap {
  readonly rawMap: LoadedRawSourceMap;
  readonly cacheKey: string;
  mappingIndex?: Promise<readonly GeneratedMapping[]>;
}

type CachedSourceMapOutcome =
  | { readonly kind: "loaded"; readonly cachedMap: CachedSourceMap }
  | {
      readonly kind: "failed";
      readonly diagnostics: readonly PluginDiagnostic[];
    };

interface CachedInlineDecodeOutcome {
  readonly kind: "failed";
  readonly diagnostics: readonly PluginDiagnostic[];
}

export type SourceMapContentHashProvider = (
  uri: string,
  text: string,
) => string | Promise<string>;

export interface SourceMapLoaderOptions {
  readonly maxEntries?: number;
  readonly maxDecodedBytes?: number;
  readonly maxMappingRecords?: number;
}

interface CachedSourceMapLoadResult {
  readonly mapUri?: string;
  readonly cachedMap?: CachedSourceMap;
  readonly mapKind?: "inline" | "external";
  readonly mapText?: string;
  readonly mapContentHash?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export const SOURCE_MAP_CACHE_LIMIT = 32;
export const SOURCE_MAP_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const SOURCE_MAP_CACHE_MAX_MAPPINGS = 131_072;
export const RULES_SOURCE_MAP_MAX_BYTES = 4 * 1024 * 1024;
export const RULES_SOURCE_MAP_MAX_MAPPINGS = 65_536;

interface WeightedSourceMapOutcomeEntry {
  readonly outcome: CachedSourceMapOutcome;
  readonly decodedBytes: number;
  readonly mappingRecords: number;
}

class WeightedSourceMapOutcomeCache {
  private readonly entries = new Map<string, WeightedSourceMapOutcomeEntry>();
  private decodedBytes = 0;
  private mappingRecords = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly maxDecodedBytes: number,
    private readonly maxMappingRecords: number,
  ) {}

  public get(key: string): CachedSourceMapOutcome | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.outcome;
  }

  public set(
    key: string,
    outcome: CachedSourceMapOutcome,
    decodedBytes = 0,
  ): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.decodedBytes -= previous.decodedBytes;
      this.mappingRecords -= previous.mappingRecords;
    }
    this.entries.delete(key);
    this.entries.set(key, { outcome, decodedBytes, mappingRecords: 0 });
    this.decodedBytes += decodedBytes;
    this.evict();
  }

  public setMappingRecords(key: string, mappingRecords: number): void {
    const current = this.entries.get(key);
    if (!current) return;
    this.mappingRecords -= current.mappingRecords;
    const next = { ...current, mappingRecords };
    this.entries.delete(key);
    this.entries.set(key, next);
    this.mappingRecords += mappingRecords;
    this.evict();
  }

  private evict(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.decodedBytes > this.maxDecodedBytes ||
      this.mappingRecords > this.maxMappingRecords
    ) {
      const oldest = this.entries.entries().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value[0]);
      this.decodedBytes -= oldest.value[1].decodedBytes;
      this.mappingRecords -= oldest.value[1].mappingRecords;
    }
  }
}

export class SourceMapLoader {
  private readonly cache: WeightedSourceMapOutcomeCache;
  private readonly inlineDecodeCache = new BoundedLruCache<
    string,
    CachedInlineDecodeOutcome
  >(
    SOURCE_MAP_CACHE_LIMIT,
  );

  public constructor(options: SourceMapLoaderOptions = {}) {
    const maxEntries = boundedCacheOption(
      options.maxEntries,
      SOURCE_MAP_CACHE_LIMIT,
      SOURCE_MAP_CACHE_LIMIT,
    );
    const maxDecodedBytes = boundedCacheOption(
      options.maxDecodedBytes,
      SOURCE_MAP_CACHE_MAX_BYTES,
      SOURCE_MAP_CACHE_MAX_BYTES,
    );
    const maxMappingRecords = boundedCacheOption(
      options.maxMappingRecords,
      SOURCE_MAP_CACHE_MAX_MAPPINGS,
      SOURCE_MAP_CACHE_MAX_MAPPINGS,
    );
    this.cache = new WeightedSourceMapOutcomeCache(
      maxEntries,
      maxDecodedBytes,
      maxMappingRecords,
    );
  }

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
      canonicalSourceContents(
        loaded.cachedMap.rawMap,
        generatedSourceUrl,
        lastSourceMapReference(generatedText),
      );
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

  public async resolveSelectorPrelude(
    generatedUri: string,
    generatedText: string,
    generatedRule: StylesheetRule,
    workspace: SourceWorkspace,
    generatedSourceUrl: string,
    signal?: AbortSignal,
    contentHash?: SourceMapContentHashProvider,
  ): Promise<SelectorSourceMapResolution> {
    const loaded = await this.loadCached(
      generatedUri,
      generatedText,
      workspace,
      signal,
      contentHash,
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
      const reference = lastSourceMapReference(generatedText);
      const canonicalContents = canonicalSourceContents(
        loaded.cachedMap.rawMap,
        generatedSourceUrl,
        reference,
      );
      const mappingIndex = await this.mappingIndex(loaded.cachedMap, signal);
      const mappings = mappingsWithinSelectorPrelude(
        mappingIndex,
        generatedRule,
      );
      const starts = mappings.filter((mapping) =>
        mapping.generatedLine ===
          generatedRule.selectorPreludeRange.start.line + 1 &&
        mapping.generatedColumn ===
          generatedRule.selectorPreludeRange.start.character
      );
      if (starts.length !== 1) {
        return {
          kind: "unmapped",
          mapUri: loaded.mapUri,
          diagnostics: [],
        };
      }
      const start = starts[0]!;
      const sourceUrl = resolveMappedSourceUrl(
        start.source,
        generatedSourceUrl,
        reference,
      );
      const selectorMappings = mappings.map((mapping) => {
        const mappingSourceUrl = resolveMappedSourceUrl(
          mapping.source,
          generatedSourceUrl,
          reference,
        );
        const sourceContent = canonicalContents.get(
          canonicalSourceUrl(mappingSourceUrl),
        );
        return {
          sourceUrl: mappingSourceUrl,
          line: mapping.line,
          column: mapping.column,
          ...(sourceContent === undefined ? {} : { sourceContent }),
        };
      });
      if (selectorMappings.some((mapping) =>
        canonicalSourceUrl(mapping.sourceUrl) !== canonicalSourceUrl(sourceUrl)
      )) {
        return {
          kind: "unmapped",
          mapUri: loaded.mapUri,
          diagnostics: [],
        };
      }
      throwIfAborted(signal);
      const sourceContent = canonicalContents.get(
        canonicalSourceUrl(sourceUrl),
      );
      return {
        kind: "mapped",
        mapUri: loaded.mapUri,
        sourceUrl,
        line: start.line,
        column: start.column,
        ...(sourceContent === undefined ? {} : { sourceContent }),
        selectorMappings: Object.freeze(selectorMappings.map((mapping) =>
          Object.freeze(mapping)
        )),
        mapKind: loaded.mapKind!,
        mapText: loaded.mapText!,
        mapContentHash: loaded.mapContentHash!,
        diagnostics: [],
      };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return invalidResolution([{
        code: "scss.sourceMapInvalid",
        message: `SCSS source map is invalid: ${messageOf(error)}`,
        severity: "warning",
      }]);
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
        mapKind: loaded.mapKind,
        mapText: loaded.mapText,
        mapContentHash: loaded.mapContentHash,
        diagnostics: loaded.diagnostics,
      }
      : { diagnostics: loaded.diagnostics };
  }

  private async loadCached(
    generatedUri: string,
    generatedText: string,
    workspace: SourceWorkspace,
    signal?: AbortSignal,
    contentHash?: SourceMapContentHashProvider,
  ): Promise<CachedSourceMapLoadResult> {
    throwIfAborted(signal);
    const reference = lastSourceMapReference(generatedText);
    if (!reference) {
      return failed("scss.sourceMapMissing", "SCSS source map was not found");
    }

    let mapUri: string;
    let mapKind: "inline" | "external";
    let rawJson: string;
    try {
      throwIfAborted(signal);
      if (reference.startsWith("data:")) {
        if (reference.length > RULES_SOURCE_MAP_MAX_BYTES * 3 + 1_024) {
          throw new Error("source map exceeds the byte limit");
        }
        mapUri = `${generatedUri}#inline-source-map`;
        mapKind = "inline";
        const encodedHash = await hashContent(
          contentHash,
          mapUri,
          reference,
          signal,
        );
        const decodeKey = `${mapUri}:encoded:${encodedHash}`;
        const cachedDecode = this.inlineDecodeCache.get(decodeKey);
        if (cachedDecode?.kind === "failed") {
          return { diagnostics: cachedDecode.diagnostics };
        }
        try {
          rawJson = decodeDataUrl(reference);
        } catch (error) {
          const failure = failed(
            "scss.sourceMapReadFailed",
            `SCSS source map could not be read: ${messageOf(error)}`,
          );
          this.inlineDecodeCache.set(decodeKey, {
            kind: "failed",
            diagnostics: failure.diagnostics,
          });
          return failure;
        }
      } else {
        const referencedMapUri = workspace.resolveRelativeUri(
          generatedUri,
          reference,
        );
        mapUri = canonicalRulesSourceUri(referencedMapUri) ?? referencedMapUri;
        mapKind = "external";
        rawJson = await raceWithAbort(
          Promise.resolve().then(() => workspace.readText(mapUri)),
          signal,
        );
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
    const mapContentHash = await hashContent(
      contentHash,
      mapUri,
      rawJson,
      signal,
    );
    const cacheKey = `${mapUri}:${mapContentHash}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.kind === "failed") {
        return { diagnostics: cached.diagnostics };
      }
      return {
        mapUri,
        cachedMap: cached.cachedMap,
        mapKind,
        mapText: rawJson,
        mapContentHash,
        diagnostics: [],
      };
    }

    if (utf8ByteLength(rawJson) > RULES_SOURCE_MAP_MAX_BYTES) {
      const failure = failed(
        "scss.sourceMapInvalid",
        "SCSS source map exceeds the byte limit",
      );
      this.cache.set(cacheKey, {
        kind: "failed",
        diagnostics: failure.diagnostics,
      });
      return failure;
    }

    try {
      throwIfAborted(signal);
      const parsed = JSON.parse(rawJson) as unknown;
      throwIfAborted(signal);
      if (!isRawSourceMap(parsed)) {
        throw new Error("source map has an invalid shape");
      }
      if (exceedsMappingLimit(parsed.mappings)) {
        throw new Error("source map exceeds the mapping limit");
      }
      const cachedMap = { rawMap: parsed, cacheKey };
      this.cache.set(
        cacheKey,
        { kind: "loaded", cachedMap },
        utf8ByteLength(rawJson),
      );
      return {
        mapUri,
        cachedMap,
        mapKind,
        mapText: rawJson,
        mapContentHash,
        diagnostics: [],
      };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const failure = failed(
        "scss.sourceMapInvalid",
        `SCSS source map is invalid: ${messageOf(error)}`,
      );
      this.cache.set(cacheKey, {
        kind: "failed",
        diagnostics: failure.diagnostics,
      });
      return failure;
    }
  }

  private async mappingIndex(
    cachedMap: CachedSourceMap,
    signal: AbortSignal | undefined,
  ): Promise<readonly GeneratedMapping[]> {
    throwIfAborted(signal);
    cachedMap.mappingIndex ??= buildMappingIndex(cachedMap.rawMap).then(
      (mappings) => {
        this.cache.setMappingRecords(cachedMap.cacheKey, mappings.length);
        return mappings;
      },
    );
    const mappings = await raceWithAbort(cachedMap.mappingIndex, signal);
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
      let visitedMappings = 0;
      consumer.eachMapping((mapping) => {
        visitedMappings += 1;
        if (visitedMappings > RULES_SOURCE_MAP_MAX_MAPPINGS) {
          throw new Error("source map exceeds the mapping limit");
        }
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
          ...(consumer.sourceContentFor(mapping.source, true) === null
            ? {}
            : {
                sourceContent: consumer.sourceContentFor(
                  mapping.source,
                  true,
                )!,
              }),
        });
      }, null, SourceMapConsumer.GENERATED_ORDER);
      return mappings;
    },
  );
}

function mappingsWithinSelectorPrelude(
  mappings: readonly GeneratedMapping[],
  generatedRule: StylesheetRule,
): readonly GeneratedMapping[] {
  return mappings.filter((mapping) => {
    const position = {
      line: mapping.generatedLine - 1,
      character: mapping.generatedColumn,
    };
    return comparePosition(
      position,
      generatedRule.selectorPreludeRange.start,
    ) >= 0 && comparePosition(
      position,
      generatedRule.selectorPreludeRange.end,
    ) < 0;
  });
}

function comparePosition(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): number {
  return left.line - right.line || left.character - right.character;
}

function canonicalSourceUrl(value: string): string {
  const parsed = new URL(value);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
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

function canonicalSourceContents(
  rawMap: LoadedRawSourceMap,
  generatedSourceUrl: string,
  mapReference: string | undefined,
): ReadonlyMap<string, string> {
  const canonicalContents = new Map<string, string>();
  const contents = rawMap.sourcesContent;
  if (!contents) return canonicalContents;
  const sourceBaseUrl = mapReference && !mapReference.startsWith("data:")
    ? new URL(mapReference, generatedSourceUrl).toString()
    : generatedSourceUrl;
  const sourceRoot = rawMap.sourceRoot;
  const rootedBaseUrl = sourceRoot
    ? new URL(
        sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`,
        sourceBaseUrl,
      ).toString()
    : sourceBaseUrl;
  rawMap.sources.forEach((source, index) => {
    const content = contents[index];
    if (content === undefined || content === null) return;
    const rootedSource = sourceRoot && source.startsWith("/")
      ? source.slice(1)
      : source;
    const canonical = canonicalSourceUrl(
      new URL(rootedSource, rootedBaseUrl).toString(),
    );
    const previous = canonicalContents.get(canonical);
    if (previous !== undefined && previous !== content) {
      throw new Error("canonical source aliases have conflicting content");
    }
    canonicalContents.set(canonical, content);
  });
  return canonicalContents;
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

function exceedsMappingLimit(mappings: string): boolean {
  let segments = 0;
  let segmentHasContent = false;
  for (let index = 0; index < mappings.length; index += 1) {
    const character = mappings[index];
    if (character === "," || character === ";") {
      if (segmentHasContent) {
        segments += 1;
        if (segments > RULES_SOURCE_MAP_MAX_MAPPINGS) return true;
      }
      segmentHasContent = false;
    } else {
      segmentHasContent = true;
    }
  }
  return segmentHasContent && segments >= RULES_SOURCE_MAP_MAX_MAPPINGS;
}

function failed(code: string, message: string): SourceMapLoadResult {
  return {
    diagnostics: [{ code, message, severity: "warning" }],
  };
}

function invalidResolution(
  diagnostics: readonly PluginDiagnostic[],
): Extract<SourceMapResolution, { readonly kind: "invalid" }> {
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

function boundedCacheOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new Error("Source map cache budget is invalid");
  }
  return resolved;
}

async function hashContent(
  provider: SourceMapContentHashProvider | undefined,
  uri: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const pending = provider
    ? Promise.resolve().then(() => provider(uri, text))
    : Promise.resolve(createHash("sha256").update(text).digest("hex"));
  const hash = await raceWithAbort(pending, signal);
  throwIfAborted(signal);
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error("source map content hash is invalid");
  }
  return hash.toLowerCase();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Source map loading was aborted");
  error.name = "AbortError";
  return error;
}
