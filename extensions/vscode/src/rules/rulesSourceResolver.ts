import { createHash } from "node:crypto";
import type {
  SourceRange,
  SourceUriResolution,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  RULE_EVIDENCE_LIMITS,
  utf8ByteLength,
  type InspectRuleContext,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
} from "@pin-op/protocol";
import { completeCssRuleEvidence } from "../sourcePlugins/cssFacts.js";
import {
  completeDeclarationFingerprint,
  equalDeclarationFingerprints,
  normalizeCondition,
} from "../sourcePlugins/declarationFingerprint.js";
import {
  RULES_SOURCE_MAP_MAX_BYTES,
  SourceMapLoader,
} from "../sourcePlugins/sourceMapLoader.js";
import {
  findRuleAtProtocolPosition,
  findRuleByBrowserPath,
  findUniqueRuleByCompleteFingerprint,
  normalizeSelector,
  RULES_STYLESHEET_MAX_BYTES,
  RULES_STYLESHEET_MAX_RULES,
  smallestContainingRule,
  StylesheetAstCache,
  StylesheetParseLimitError,
  type ParsedStylesheet,
  type StylesheetSyntax,
  type StylesheetRule,
} from "../sourcePlugins/stylesheetAst.js";
import {
  canonicalRulesSourceUri,
  exactWorkspaceUri,
  raceWithAbort,
  RulesSourceSnapshotLimitError,
  rulesSourceSnapshotWorkspace,
  type RulesSourceSnapshot,
  type RulesSourceSnapshotWorkspace,
} from "../sourcePlugins/sourceWorkspace.js";
import type { CssDeclarationEvidence } from "../sourcePlugins/types.js";
import { rulesSourceDocumentMetadata } from "../sourcePresentationMetadata.js";

export const RULES_SOURCE_BATCH_MAX_BYTES = 32 * 1024 * 1024;

export interface RulesSourceResolverOptions {
  readonly maxRetainedSourceBytes?: number;
}

export interface RulesSourceResolverRequest {
  readonly selectionMessageId: string;
  readonly pageUrl: string;
  readonly ruleEvidence: InspectRuleEvidenceBatch;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}

export interface ResolvedRuleSource {
  readonly kind: "resolved";
  readonly ruleRef: string;
  readonly document: {
    readonly uri: string;
    readonly languageId: "css" | "scss";
    readonly version: number;
  };
  readonly range: SourceRange;
  readonly confidence: "exact" | "sourcemap";
  readonly dependencies: readonly RuleSourceDependencySnapshot[];
}

export interface RuleSourceDependencySnapshot {
  readonly kind: "generated-css" | "external-source-map" | "original-source";
  readonly uri: string;
  readonly documentVersion?: number;
  readonly contentHash: string;
}

export interface UnresolvedRuleSource {
  readonly kind: "unresolved";
  readonly ruleRef: string;
  readonly reason: string;
}

export type RuleSourceResolution = ResolvedRuleSource | UnresolvedRuleSource;

export interface RulesSourceResolutionBatch {
  readonly selectionMessageId: string;
  readonly results: readonly RuleSourceResolution[];
}

export interface RulesSourceProjection {
  readonly ruleRef: string;
  readonly document: {
    readonly label: string;
    readonly languageId: "css" | "scss";
  };
  readonly startLine: number;
  readonly startColumn: number;
  readonly confidence: "exact" | "sourcemap";
}

interface VerifiedGeneratedRule {
  readonly rule: StylesheetRule;
  readonly exactIdentity: boolean;
}

type CachedStylesheet =
  | { readonly kind: "parsed"; readonly value: ParsedStylesheet }
  | { readonly kind: "failed"; readonly error: unknown };

interface RulesSourceSnapshotIdentity {
  readonly uri: string;
  readonly documentVersion: number;
  readonly contentHash: string;
}

interface HashedRulesSourceSnapshot extends RulesSourceSnapshotIdentity {
  readonly text: string;
}

class RulesSourceBatchLimitError extends Error {
  public constructor() {
    super("Rules source batch exceeds the retained-text budget");
    this.name = "RulesSourceBatchLimitError";
  }
}

class RetainedSourceBudget {
  private retainedBytes = 0;
  private exhausted = false;

  public constructor(private readonly maxBytes: number) {}

  public assertAvailable(): void {
    if (this.exhausted) throw new RulesSourceBatchLimitError();
  }

  public retain(bytes: number): void {
    if (this.exhausted || bytes > this.maxBytes - this.retainedBytes) {
      this.exhausted = true;
      throw new RulesSourceBatchLimitError();
    }
    this.retainedBytes += bytes;
    if (this.retainedBytes >= this.maxBytes) this.exhausted = true;
  }
}

interface ResolutionBatchContext {
  readonly sourceResolutions: Map<string, Promise<SourceUriResolution>>;
  readonly initialSnapshots: Map<string, Promise<HashedRulesSourceSnapshot>>;
  readonly fenceSnapshots: Map<string, Promise<RulesSourceSnapshotIdentity>>;
  readonly contentHashes: Map<
    string,
    { readonly text: string; readonly contentHash: string }[]
  >;
  readonly stylesheets: Map<string, CachedStylesheet>;
  readonly sourceMapWorkspace: SourceWorkspace;
  readonly snapshotWorkspace: RulesSourceSnapshotWorkspace;
  readonly retainedSourceBudget: RetainedSourceBudget;
}

export class RulesSourceResolver {
  private readonly maxRetainedSourceBytes: number;

  public constructor(
    private readonly workspace: SourceWorkspace,
    private readonly ast = new StylesheetAstCache(),
    private readonly sourceMaps = new SourceMapLoader(),
    options: RulesSourceResolverOptions = {},
  ) {
    this.maxRetainedSourceBytes = options.maxRetainedSourceBytes ??
      RULES_SOURCE_BATCH_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maxRetainedSourceBytes) ||
      this.maxRetainedSourceBytes < 1 ||
      this.maxRetainedSourceBytes > RULES_SOURCE_BATCH_MAX_BYTES
    ) {
      throw new Error("Rules retained-source budget is invalid");
    }
  }

  public async resolve(
    request: RulesSourceResolverRequest,
  ): Promise<RulesSourceResolutionBatch> {
    throwIfAborted(request.signal);
    if (!request.isCurrent?.() && request.isCurrent !== undefined) {
      return unresolvedBatch(request, "stale-input");
    }
    if (
      request.ruleEvidence.omittedRuleCount !== 0 ||
      request.ruleEvidence.rules.length > RULE_EVIDENCE_LIMITS.rules
    ) {
      return unresolvedBatch(request, "truncated-rule-evidence");
    }

    const snapshotWorkspace = rulesSourceSnapshotWorkspace(this.workspace);
    if (!snapshotWorkspace) {
      return unresolvedBatch(request, "rules-source-snapshot-unavailable");
    }
    let initialGeneration: number;
    try {
      initialGeneration = readRulesSourceGeneration(snapshotWorkspace);
    } catch {
      return unresolvedBatch(request, "rules-source-snapshot-unavailable");
    }
    const batch = createBatchContext(
      this.workspace,
      snapshotWorkspace,
      request.signal,
      this.maxRetainedSourceBytes,
    );
    const grouped = groupUniqueRules(request.ruleEvidence.rules);
    const results: RuleSourceResolution[] = [];
    for (const entry of grouped) {
      throwIfAborted(request.signal);
      results.push(entry.kind === "duplicate"
        ? unresolved(entry.rule.ruleRef, "duplicate-rule-ref")
        : await this.resolveRule(entry.rule, request, batch));
    }
    throwIfAborted(request.signal);
    if (!request.isCurrent?.() && request.isCurrent !== undefined) {
      return unresolvedBatch(request, "stale-input");
    }
    let revalidated: readonly RuleSourceResolution[];
    try {
      const generationBeforeSweep = readRulesSourceGeneration(
        snapshotWorkspace,
      );
      revalidated = await revalidateBatchDependencies(
        results,
        snapshotWorkspace,
        request.signal,
      );
      const generationAfterSweep = readRulesSourceGeneration(
        snapshotWorkspace,
      );
      if (
        generationBeforeSweep !== initialGeneration ||
        generationAfterSweep !== initialGeneration
      ) {
        revalidated = revalidated.map((result) =>
          unresolved(result.ruleRef, "stale-input")
        );
      }
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      revalidated = results.map((result) =>
        unresolved(result.ruleRef, "stale-input")
      );
    }
    throwIfAborted(request.signal);
    if (!request.isCurrent?.() && request.isCurrent !== undefined) {
      return unresolvedBatch(request, "stale-input");
    }
    return {
      selectionMessageId: request.selectionMessageId,
      results: revalidated,
    };
  }

  private async resolveRule(
    evidence: InspectRuleEvidence,
    request: RulesSourceResolverRequest,
    batch: ResolutionBatchContext,
  ): Promise<RuleSourceResolution> {
    const generated = evidence.generatedSource;
    if (!generated) return unresolved(evidence.ruleRef, "missing-generated-source");
    if (!completeCssRuleEvidence(evidence)) {
      return unresolved(evidence.ruleRef, "incomplete-rule-evidence");
    }

    let resolution;
    try {
      resolution = await batchResolveSourceUri(
        batch.sourceResolutions,
        this.workspace,
        generated.sourceUrl,
        request.pageUrl,
        request.signal,
      );
    } catch {
      return unresolved(evidence.ruleRef, "non-exact-workspace-match");
    }
    const generatedUri = exactWorkspaceUri(this.workspace, resolution);
    if (!generatedUri) {
      return unresolved(evidence.ruleRef, "non-exact-workspace-match");
    }

    let generatedSnapshot: HashedRulesSourceSnapshot;
    try {
      generatedSnapshot = await batchReadSnapshot(
        batch.initialSnapshots,
        batch.contentHashes,
        batch.retainedSourceBudget,
        batch.snapshotWorkspace,
        generatedUri,
        RULES_STYLESHEET_MAX_BYTES,
        request.signal,
      );
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      if (error instanceof RulesSourceBatchLimitError) {
        return unresolved(evidence.ruleRef, "source-budget-exceeded");
      }
      if (error instanceof RulesSourceSnapshotLimitError) {
        return unresolved(evidence.ruleRef, "generated-source-too-large");
      }
      return unresolved(evidence.ruleRef, "generated-source-unreadable");
    }
    const generatedText = generatedSnapshot.text;
    const generatedDocumentUri = generatedSnapshot.uri;
    let stylesheet: ParsedStylesheet;
    try {
      stylesheet = batchParseStylesheet(
        batch,
        this.ast,
        generatedDocumentUri,
        "css",
        generatedText,
      );
    } catch (error) {
      if (error instanceof StylesheetParseLimitError) {
        return unresolved(
          evidence.ruleRef,
          error.limit === "bytes"
            ? "generated-source-too-large"
            : "generated-source-too-complex",
        );
      }
      return unresolved(evidence.ruleRef, "generated-source-parse-error");
    }
    const verified = verifyGeneratedRule(stylesheet, evidence);
    if (!verified) {
      return unresolved(evidence.ruleRef, "generated-css-not-exact");
    }

    const cssResult = resolved(
      evidence.ruleRef,
      generatedDocumentUri,
      "css",
      generatedSnapshot.documentVersion,
      verified.rule.range,
      "exact",
      [dependency("generated-css", generatedSnapshot)],
    );
    if (!verified.exactIdentity) {
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }

    let mapped: Awaited<
      ReturnType<SourceMapLoader["resolveSelectorPrelude"]>
    >;
    try {
      mapped = await this.sourceMaps.resolveSelectorPrelude(
        generatedDocumentUri,
        generatedText,
        verified.rule,
        batch.sourceMapWorkspace,
        generated.sourceUrl,
        request.signal,
        (uri, text) => batchContentHash(
          batch.contentHashes,
          batch.retainedSourceBudget,
          uri,
          text,
          true,
        ),
      );
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }
    if (mapped.kind !== "mapped") {
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }

    let externalMapSnapshot: HashedRulesSourceSnapshot | undefined;
    if (mapped.mapKind === "external") {
      try {
        externalMapSnapshot = await batchReadSnapshot(
          batch.initialSnapshots,
          batch.contentHashes,
          batch.retainedSourceBudget,
          batch.snapshotWorkspace,
          mapped.mapUri,
          RULES_SOURCE_MAP_MAX_BYTES,
          request.signal,
        );
        if (externalMapSnapshot.text !== mapped.mapText) {
          return this.freshCssFallback(
            cssResult,
            generatedDocumentUri,
            generatedText,
            request,
            batch,
          );
        }
      } catch (error) {
        if (request.signal?.aborted) throw abortError();
        return this.freshCssFallback(
          cssResult,
          generatedDocumentUri,
          generatedText,
          request,
          batch,
        );
      }
    }

    let originalResolution;
    try {
      originalResolution = await batchResolveSourceUri(
        batch.sourceResolutions,
        this.workspace,
        mapped.sourceUrl,
        generated.sourceUrl,
        request.signal,
      );
    } catch {
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }
    const originalUri = exactWorkspaceUri(this.workspace, originalResolution);
    if (!originalUri || !isScssUri(originalUri)) {
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }

    let originalSnapshot: HashedRulesSourceSnapshot;
    let originalStylesheet: ParsedStylesheet;
    try {
      originalSnapshot = await batchReadSnapshot(
        batch.initialSnapshots,
        batch.contentHashes,
        batch.retainedSourceBudget,
        batch.snapshotWorkspace,
        originalUri,
        RULES_STYLESHEET_MAX_BYTES,
        request.signal,
      );
      const originalText = originalSnapshot.text;
      if (
        mapped.sourceContent !== undefined &&
        mapped.sourceContent !== originalText
      ) {
        return this.freshCssFallback(
          cssResult,
          generatedDocumentUri,
          generatedText,
          request,
          batch,
        );
      }
      if (mapped.selectorMappings.some((mapping) =>
        mapping.sourceContent !== undefined &&
        mapping.sourceContent !== originalText
      )) {
        return this.freshCssFallback(
          cssResult,
          generatedDocumentUri,
          generatedText,
          request,
          batch,
        );
      }
      originalStylesheet = batchParseStylesheet(
        batch,
        this.ast,
        originalSnapshot.uri,
        "scss",
        originalText,
      );
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }
    const originalText = originalSnapshot.text;
    const originalRule = mappedOriginalRule(originalStylesheet, mapped);
    if (!originalRule || !ruleMatchesEvidence(originalRule, evidence)) {
      return this.freshCssFallback(
        cssResult,
        generatedDocumentUri,
        generatedText,
        request,
        batch,
      );
    }

    try {
      const currentGeneratedSnapshot = await batchReadSnapshotIdentity(
        batch.fenceSnapshots,
        batch.snapshotWorkspace,
        generatedDocumentUri,
        RULES_STYLESHEET_MAX_BYTES,
        request.signal,
      );
      const currentOriginalSnapshot = await batchReadSnapshotIdentity(
        batch.fenceSnapshots,
        batch.snapshotWorkspace,
        originalSnapshot.uri,
        RULES_STYLESHEET_MAX_BYTES,
        request.signal,
      );
      let mapCurrent = true;
      if (mapped.mapKind === "external") {
        try {
          const currentMapSnapshot = await batchReadSnapshotIdentity(
            batch.fenceSnapshots,
            batch.snapshotWorkspace,
            externalMapSnapshot?.uri ?? mapped.mapUri,
            RULES_SOURCE_MAP_MAX_BYTES,
            request.signal,
          );
          mapCurrent = externalMapSnapshot !== undefined &&
            sameRulesSnapshot(currentMapSnapshot, externalMapSnapshot);
        } catch {
          mapCurrent = false;
        }
      }
      if (
        !sameRulesSnapshot(currentGeneratedSnapshot, generatedSnapshot) ||
        !sameRulesSnapshot(currentOriginalSnapshot, originalSnapshot) ||
        (request.isCurrent !== undefined && !request.isCurrent())
      ) {
        return unresolved(evidence.ruleRef, "stale-input");
      }
      if (!mapCurrent) return cssResult;
    } catch {
      return unresolved(evidence.ruleRef, "stale-input");
    }
    return resolved(
      evidence.ruleRef,
      originalSnapshot.uri,
      "scss",
      originalSnapshot.documentVersion,
      originalRule.range,
      "sourcemap",
      [
        dependency("generated-css", generatedSnapshot),
        ...(mapped.mapKind === "external"
          ? [dependency("external-source-map", externalMapSnapshot!)]
          : []),
        dependency("original-source", originalSnapshot),
      ],
    );
  }

  private async freshCssFallback(
    cssResult: ResolvedRuleSource,
    generatedUri: string,
    _generatedText: string,
    request: RulesSourceResolverRequest,
    batch: ResolutionBatchContext,
  ): Promise<RuleSourceResolution> {
    try {
      throwIfAborted(request.signal);
      const currentSnapshot = await batchReadSnapshotIdentity(
        batch.fenceSnapshots,
        batch.snapshotWorkspace,
        generatedUri,
        RULES_STYLESHEET_MAX_BYTES,
        request.signal,
      );
      const dependency = cssResult.dependencies[0];
      return dependency !== undefined &&
          currentSnapshot.uri === generatedUri &&
          currentSnapshot.documentVersion === cssResult.document.version &&
          currentSnapshot.contentHash === dependency.contentHash &&
          (request.isCurrent === undefined || request.isCurrent())
        ? cssResult
        : unresolved(cssResult.ruleRef, "stale-input");
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      return unresolved(cssResult.ruleRef, "stale-input");
    }
  }
}

function createBatchContext(
  workspace: SourceWorkspace,
  snapshotWorkspace: RulesSourceSnapshotWorkspace,
  signal: AbortSignal | undefined,
  maxRetainedSourceBytes: number,
): ResolutionBatchContext {
  const sourceResolutions = new Map<string, Promise<SourceUriResolution>>();
  const initialSnapshots = new Map<
    string,
    Promise<HashedRulesSourceSnapshot>
  >();
  const fenceSnapshots = new Map<
    string,
    Promise<RulesSourceSnapshotIdentity>
  >();
  const retainedSourceBudget = new RetainedSourceBudget(
    maxRetainedSourceBytes,
  );
  const contentHashes = new Map<
    string,
    { readonly text: string; readonly contentHash: string }[]
  >();
  const stylesheets = new Map<string, CachedStylesheet>();
  const sourceMapWorkspace: SourceWorkspace = {
    findFiles: (pattern) => raceWithAbort(
      Promise.resolve().then(() => workspace.findFiles(pattern)),
      signal,
    ),
    readText: async (uri) => (await batchReadSnapshot(
      initialSnapshots,
      contentHashes,
      retainedSourceBudget,
      snapshotWorkspace,
      uri,
      RULES_SOURCE_MAP_MAX_BYTES,
      signal,
    )).text,
    resolveSourceUri: (sourceUrl, baseUrl) => batchResolveSourceUri(
      sourceResolutions,
      workspace,
      sourceUrl,
      baseUrl,
      signal,
    ),
    resolveRelativeUri: (baseUri, reference) => {
      const resolved = workspace.resolveRelativeUri(baseUri, reference);
      return canonicalRulesSourceUri(resolved) ?? resolved;
    },
    isWorkspaceUri: (uri) => workspace.isWorkspaceUri(uri),
  };
  return {
    sourceResolutions,
    initialSnapshots,
    fenceSnapshots,
    contentHashes,
    stylesheets,
    sourceMapWorkspace,
    snapshotWorkspace,
    retainedSourceBudget,
  };
}

async function batchResolveSourceUri(
  cache: Map<string, Promise<SourceUriResolution>>,
  workspace: SourceWorkspace,
  sourceUrl: string,
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<SourceUriResolution> {
  throwIfAborted(signal);
  const key = JSON.stringify([sourceUrl, baseUrl]);
  let pending = cache.get(key);
  if (!pending) {
    pending = Promise.resolve().then(() =>
      workspace.resolveSourceUri(sourceUrl, baseUrl)
    );
    cache.set(key, pending);
  }
  const resolution = await raceWithAbort(pending, signal);
  throwIfAborted(signal);
  return resolution;
}

async function batchReadSnapshot(
  cache: Map<string, Promise<HashedRulesSourceSnapshot>>,
  contentHashes: ResolutionBatchContext["contentHashes"],
  retainedSourceBudget: RetainedSourceBudget,
  workspace: RulesSourceSnapshotWorkspace,
  uri: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<HashedRulesSourceSnapshot> {
  throwIfAborted(signal);
  const canonicalUri = canonicalRulesSourceUri(uri) ?? uri;
  const key = `${maxBytes}:${canonicalUri}`;
  let pending = cache.get(key);
  if (!pending) {
    retainedSourceBudget.assertAvailable();
    pending = Promise.resolve()
      .then(() =>
        workspace.readRulesSourceSnapshot(canonicalUri, maxBytes, signal)
      )
      .then((snapshot): HashedRulesSourceSnapshot => {
        const bytes = validateRulesSourceSnapshot(
          snapshot,
          canonicalUri,
          maxBytes,
        );
        retainedSourceBudget.retain(bytes);
        return {
          uri: canonicalRulesSourceUri(snapshot.uri) ?? snapshot.uri,
          text: snapshot.text,
          documentVersion: snapshot.documentVersion,
          contentHash: batchContentHash(
            contentHashes,
            retainedSourceBudget,
            canonicalRulesSourceUri(snapshot.uri) ?? snapshot.uri,
            snapshot.text,
            false,
          ),
        };
      });
    cache.set(key, pending);
  }
  const snapshot = await raceWithAbort(pending, signal);
  throwIfAborted(signal);
  return snapshot;
}

async function batchReadSnapshotIdentity(
  cache: Map<string, Promise<RulesSourceSnapshotIdentity>>,
  workspace: RulesSourceSnapshotWorkspace,
  uri: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<RulesSourceSnapshotIdentity> {
  throwIfAborted(signal);
  const canonicalUri = canonicalRulesSourceUri(uri) ?? uri;
  const key = `${maxBytes}:${canonicalUri}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(() =>
        workspace.readRulesSourceSnapshot(canonicalUri, maxBytes, signal)
      )
      .then((snapshot): RulesSourceSnapshotIdentity => {
        validateRulesSourceSnapshot(snapshot, canonicalUri, maxBytes);
        return {
          uri: canonicalRulesSourceUri(snapshot.uri) ?? snapshot.uri,
          documentVersion: snapshot.documentVersion,
          contentHash: createHash("sha256").update(snapshot.text).digest("hex"),
        };
      });
    cache.set(key, pending);
  }
  const snapshot = await raceWithAbort(pending, signal);
  throwIfAborted(signal);
  return snapshot;
}

function validateRulesSourceSnapshot(
  snapshot: RulesSourceSnapshot,
  requestedUri: string,
  maxBytes: number,
): number {
  if (
    (canonicalRulesSourceUri(snapshot.uri) ?? snapshot.uri) !== requestedUri ||
    !Number.isSafeInteger(snapshot.documentVersion) ||
    snapshot.documentVersion < 0 ||
    typeof snapshot.text !== "string"
  ) {
    throw new Error("Rules source snapshot is invalid");
  }
  const bytes = utf8ByteLength(snapshot.text);
  if (bytes > maxBytes) throw new RulesSourceSnapshotLimitError();
  return bytes;
}

function batchContentHash(
  cache: ResolutionBatchContext["contentHashes"],
  retainedSourceBudget: RetainedSourceBudget,
  uri: string,
  text: string,
  retainText: boolean,
): string {
  const entries = cache.get(uri);
  const cached = entries?.find((entry) => entry.text === text);
  if (cached) return cached.contentHash;
  if (retainText) retainedSourceBudget.retain(utf8ByteLength(text));
  const contentHash = createHash("sha256").update(text).digest("hex");
  const next = { text, contentHash };
  if (entries) entries.push(next);
  else cache.set(uri, [next]);
  return contentHash;
}

function batchParseStylesheet(
  batch: ResolutionBatchContext,
  ast: StylesheetAstCache,
  uri: string,
  syntax: StylesheetSyntax,
  text: string,
): ParsedStylesheet {
  const key = `${syntax}:${uri}`;
  const cached = batch.stylesheets.get(key);
  if (cached?.kind === "parsed") return cached.value;
  if (cached?.kind === "failed") throw cached.error;
  try {
    const value = ast.parseText(uri, syntax, text, {
      maxBytes: RULES_STYLESHEET_MAX_BYTES,
      maxRules: RULES_STYLESHEET_MAX_RULES,
    });
    batch.stylesheets.set(key, { kind: "parsed", value });
    return value;
  } catch (error) {
    batch.stylesheets.set(key, { kind: "failed", error });
    throw error;
  }
}

function isScssUri(uri: string): boolean {
  try {
    return decodeURIComponent(new URL(uri).pathname).toLowerCase().endsWith(
      ".scss",
    );
  } catch {
    return false;
  }
}

function mappedOriginalRule(
  stylesheet: ParsedStylesheet,
  mapped: Extract<
    Awaited<ReturnType<SourceMapLoader["resolveSelectorPrelude"]>>,
    { readonly kind: "mapped" }
  >,
): StylesheetRule | undefined {
  const startOffset = sourceMapOffset(stylesheet, mapped.line, mapped.column);
  if (startOffset === undefined) return undefined;
  const candidate = smallestContainingRule(stylesheet.rules, startOffset);
  if (
    !candidate ||
    startOffset < candidate.selectorPreludeStartOffset ||
    startOffset >= candidate.selectorPreludeEndOffset
  ) {
    return undefined;
  }
  for (const mapping of mapped.selectorMappings) {
    const offset = sourceMapOffset(stylesheet, mapping.line, mapping.column);
    if (
      offset === undefined ||
      smallestContainingRule(stylesheet.rules, offset) !== candidate
    ) {
      return undefined;
    }
  }
  return candidate;
}

export function projectRulesSource(
  source: ResolvedRuleSource,
): RulesSourceProjection {
  return {
    ruleRef: source.ruleRef,
    document: rulesSourceDocumentMetadata(
      source.document.uri,
      source.document.languageId,
    ),
    startLine: source.range.start.line + 1,
    startColumn: source.range.start.character + 1,
    confidence: source.confidence,
  };
}

function verifyGeneratedRule(
  stylesheet: ParsedStylesheet,
  evidence: InspectRuleEvidence,
): VerifiedGeneratedRule | undefined {
  const generated = evidence.generatedSource;
  if (!generated) return undefined;
  const byPosition = generated.startLine === undefined ||
      generated.startColumn === undefined
    ? undefined
    : findRuleAtProtocolPosition(
      stylesheet,
      generated.startLine,
      generated.startColumn,
    );
  const byPath = generated.rulePath === undefined
    ? undefined
    : findRuleByBrowserPath(stylesheet, generated.rulePath);
  const identityCandidate = exactIdentityCandidate(
    generated,
    byPosition,
    byPath,
  );
  if (identityCandidate && ruleMatchesEvidence(identityCandidate, evidence)) {
    return { rule: identityCandidate, exactIdentity: true };
  }
  const fallback = findUniqueRuleByCompleteFingerprint(stylesheet, {
    selector: evidence.selector,
    declarations: declarationEvidence(evidence),
    contexts: generated.contexts,
  });
  return fallback
    ? { rule: fallback, exactIdentity: false }
    : undefined;
}

function exactIdentityCandidate(
  generated: NonNullable<InspectRuleEvidence["generatedSource"]>,
  byPosition: StylesheetRule | undefined,
  byPath: StylesheetRule | undefined,
): StylesheetRule | undefined {
  const hasAnyStart = generated.startLine !== undefined ||
    generated.startColumn !== undefined;
  const hasCompleteStart = generated.startLine !== undefined &&
    generated.startColumn !== undefined;
  const candidates: StylesheetRule[] = [];
  if (hasAnyStart) {
    if (!hasCompleteStart || !byPosition) return undefined;
    candidates.push(byPosition);
  }
  if (generated.rulePath !== undefined) {
    if (!byPath) return undefined;
    candidates.push(byPath);
  }
  const candidate = candidates[0];
  if (!candidate || candidates.some((entry) => entry !== candidate)) {
    return undefined;
  }
  return exactProtocolRangeMatchesRule(generated, candidate)
    ? candidate
    : undefined;
}

function exactProtocolRangeMatchesRule(
  generated: NonNullable<InspectRuleEvidence["generatedSource"]>,
  rule: StylesheetRule,
): boolean {
  const hasCompleteStart = generated.startLine !== undefined &&
    generated.startColumn !== undefined;
  if (
    hasCompleteStart &&
    (generated.startLine !== rule.range.start.line + 1 ||
      generated.startColumn !== rule.range.start.character + 1)
  ) {
    return false;
  }
  const hasAnyEnd = generated.endLine !== undefined ||
    generated.endColumn !== undefined;
  if (!hasAnyEnd) return true;
  if (!hasCompleteStart) return false;
  return generated.endLine !== undefined &&
    generated.endColumn !== undefined &&
    generated.endLine === rule.range.end.line + 1 &&
    generated.endColumn === rule.range.end.character + 1;
}

function ruleMatchesEvidence(
  rule: StylesheetRule,
  evidence: InspectRuleEvidence,
): boolean {
  if (
    rule.hasUnsupportedGroupingContext ||
    !rule.hasCompleteDeclarationFingerprint
  ) return false;
  if (
    normalizeSelector(evidence.selector) !==
      (rule.expandedSelector ?? rule.fingerprint.selector)
  ) {
    return false;
  }
  const declarations = completeDeclarationFingerprint(
    declarationEvidence(evidence),
  );
  if (
    declarations === undefined ||
    !equalDeclarationFingerprints(
      declarations,
      rule.fingerprint.declarations,
    )
  ) {
    return false;
  }
  return equalContexts(
    evidence.generatedSource?.contexts ?? [],
    rule.contexts,
  );
}

function declarationEvidence(
  evidence: InspectRuleEvidence,
): CssDeclarationEvidence[] {
  return evidence.declarations.map((entry): CssDeclarationEvidence => ({
    property: entry.property,
    value: entry.value,
    important: entry.important,
    valueComplete: !entry.valueTruncated,
  }));
}

function equalContexts(
  evidence: readonly InspectRuleContext[],
  actual: readonly {
    readonly kind: "media" | "supports";
    readonly conditionText: string;
  }[],
): boolean {
  return evidence.length === actual.length && evidence.every((entry, index) => {
    const candidate = actual[index];
    return candidate !== undefined &&
      entry.kind === candidate.kind &&
      normalizeCondition(entry.conditionText) === candidate.conditionText;
  });
}

function sourceMapOffset(
  stylesheet: ParsedStylesheet,
  oneBasedLine: number,
  zeroBasedColumn: number,
): number | undefined {
  if (
    !Number.isSafeInteger(oneBasedLine) || oneBasedLine < 1 ||
    !Number.isSafeInteger(zeroBasedColumn) || zeroBasedColumn < 0
  ) {
    return undefined;
  }
  const position = { line: oneBasedLine - 1, character: zeroBasedColumn };
  const offset = stylesheet.document.offsetAt(position);
  const roundTrip = stylesheet.document.positionAt(offset);
  return roundTrip.line === position.line &&
      roundTrip.character === position.character
    ? offset
    : undefined;
}

function resolved(
  ruleRef: string,
  uri: string,
  languageId: "css" | "scss",
  version: number,
  range: SourceRange,
  confidence: "exact" | "sourcemap",
  dependencies: readonly RuleSourceDependencySnapshot[],
): ResolvedRuleSource {
  return {
    kind: "resolved",
    ruleRef,
    document: {
      uri,
      languageId,
      version,
    },
    range,
    confidence,
    dependencies: Object.freeze(dependencies.map((entry) =>
      Object.freeze({ ...entry })
    )),
  };
}

function dependency(
  kind: RuleSourceDependencySnapshot["kind"],
  snapshot: HashedRulesSourceSnapshot,
): RuleSourceDependencySnapshot {
  return dependencyFromHash(
    kind,
    snapshot.uri,
    snapshot.contentHash,
    snapshot.documentVersion,
  );
}

function dependencyFromHash(
  kind: RuleSourceDependencySnapshot["kind"],
  uri: string,
  contentHash: string,
  documentVersion: number,
): RuleSourceDependencySnapshot {
  return { kind, uri, documentVersion, contentHash };
}

function sameRulesSnapshot(
  left: RulesSourceSnapshotIdentity,
  right: RulesSourceSnapshotIdentity,
): boolean {
  return left.uri === right.uri &&
    left.documentVersion === right.documentVersion &&
    left.contentHash === right.contentHash;
}

async function revalidateBatchDependencies(
  results: readonly RuleSourceResolution[],
  workspace: RulesSourceSnapshotWorkspace,
  signal: AbortSignal | undefined,
): Promise<readonly RuleSourceResolution[]> {
  const limits = new Map<string, number>();
  for (const result of results) {
    if (result.kind !== "resolved") continue;
    for (const dependency of result.dependencies) {
      const limit = dependency.kind === "external-source-map"
        ? RULES_SOURCE_MAP_MAX_BYTES
        : RULES_STYLESHEET_MAX_BYTES;
      limits.set(
        dependency.uri,
        Math.min(limits.get(dependency.uri) ?? limit, limit),
      );
    }
  }
  const current = new Map<
    string,
    RulesSourceSnapshotIdentity
  >();
  for (const [uri, maxBytes] of limits) {
    throwIfAborted(signal);
    try {
      const snapshot = await raceWithAbort(
        Promise.resolve().then(() =>
          workspace.readRulesSourceSnapshot(uri, maxBytes, signal)
        ),
        signal,
      );
      validateRulesSourceSnapshot(snapshot, uri, maxBytes);
      current.set(uri, {
        uri: canonicalRulesSourceUri(snapshot.uri) ?? snapshot.uri,
        documentVersion: snapshot.documentVersion,
        contentHash: createHash("sha256").update(snapshot.text).digest("hex"),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
    }
  }
  return results.map((result): RuleSourceResolution => {
    if (result.kind !== "resolved") return result;
    const stale = result.dependencies.some((dependency) => {
      const candidate = current.get(dependency.uri);
      return !candidate ||
        candidate.uri !== dependency.uri ||
        candidate.documentVersion !== dependency.documentVersion ||
        candidate.contentHash !== dependency.contentHash;
    });
    return stale ? unresolved(result.ruleRef, "stale-input") : result;
  });
}

function unresolved(ruleRef: string, reason: string): UnresolvedRuleSource {
  return { kind: "unresolved", ruleRef, reason };
}

function readRulesSourceGeneration(
  workspace: RulesSourceSnapshotWorkspace,
): number {
  const generation = workspace.currentRulesSourceGeneration();
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Rules source generation is invalid");
  }
  return generation;
}

function unresolvedBatch(
  request: RulesSourceResolverRequest,
  reason: string,
): RulesSourceResolutionBatch {
  return {
    selectionMessageId: request.selectionMessageId,
    results: uniqueRuleRefs(request.ruleEvidence.rules).map((ruleRef) =>
      unresolved(ruleRef, reason)
    ),
  };
}

function uniqueRuleRefs(rules: readonly InspectRuleEvidence[]): string[] {
  return [...new Set(rules.map((rule) => rule.ruleRef))];
}

function groupUniqueRules(
  rules: readonly InspectRuleEvidence[],
): readonly ({ readonly kind: "unique" | "duplicate"; readonly rule: InspectRuleEvidence })[] {
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.ruleRef, (counts.get(rule.ruleRef) ?? 0) + 1);
  const seen = new Set<string>();
  return rules.flatMap((rule) => {
    if (seen.has(rule.ruleRef)) return [];
    seen.add(rule.ruleRef);
    return [{
      kind: counts.get(rule.ruleRef) === 1 ? "unique" : "duplicate",
      rule,
    }];
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Rules source resolution was aborted");
  error.name = "AbortError";
  return error;
}
