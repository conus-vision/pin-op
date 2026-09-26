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
  declarationsBrowsersKeep,
  declarationsContainEvidence,
  equalReportedDeclarations,
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
import {
  RulesStylesheetLocator,
  type GeneratedStylesheetLocation,
  type StylesheetCandidateScore,
} from "./rulesStylesheetLocator.js";

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
  /** Per served stylesheet URL, the workspace file its content led to. */
  readonly generatedStylesheets: Map<
    string,
    Promise<GeneratedStylesheetLocation>
  >;
  readonly stylesheetLocator: RulesStylesheetLocator;
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
    const grouped = groupUniqueRules(request.ruleEvidence.rules);
    const batch = createBatchContext(
      this.workspace,
      snapshotWorkspace,
      this.ast,
      request.signal,
      this.maxRetainedSourceBytes,
      locatableRules(grouped),
    );
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

    // The URL says where the page was served from, not where the file lives in
    // the project; the file is the one whose content carries these rules.
    let location: GeneratedStylesheetLocation;
    try {
      location = await batchLocateGeneratedStylesheet(
        batch,
        generated.sourceUrl,
        request.signal,
      );
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      return unresolved(
        evidence.ruleRef,
        error instanceof RulesSourceBatchLimitError
          ? "source-budget-exceeded"
          : "generated-source-unreadable",
      );
    }
    if (location.kind === "unlocated") {
      return unresolved(evidence.ruleRef, location.reason);
    }
    const generatedUri = location.uri;

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
      return unresolved(evidence.ruleRef, generatedParseFailure(error));
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
      verified.range,
      "exact",
      [dependency("generated-css", generatedSnapshot)],
    );

    let mapped: Awaited<
      ReturnType<SourceMapLoader["resolveSelectorPrelude"]>
    >;
    try {
      // A map names its sources relative to where it was written, which is
      // beside the stylesheet on disk -- not wherever the page was served from.
      mapped = await this.sourceMaps.resolveSelectorPrelude(
        generatedDocumentUri,
        generatedText,
        verified,
        batch.sourceMapWorkspace,
        generatedDocumentUri,
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

    const originalUri = await this.originalSourceUri(
      mapped,
      generatedDocumentUri,
      request,
      batch,
    );
    if (!originalUri) {
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
    // The map carried this file's own text and it matched byte for byte above,
    // so the position it gives is the compiler's own answer for a rule already
    // matched declaration for declaration.
    const mapCarriedThisSource = mapped.sourceContent !== undefined ||
      mapped.selectorMappings.some(
        (mapping) => mapping.sourceContent !== undefined,
      );
    if (
      !originalRule ||
      !originalRuleCarriesEvidence(originalRule, evidence, mapCarriedThisSource)
    ) {
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

  /**
   * The SCSS file a source map names as the origin of a rule.
   *
   * A `file:` name, read relative to the map beside the stylesheet on disk,
   * is the file when the workspace has it. When it has not -- the map named its
   * sources by a bundler's own scheme, or by paths on the machine that ran the
   * build -- the workspace is searched for the file by what the map says about
   * it. A file that is there but cannot be used is not traded for another.
   */
  private async originalSourceUri(
    mapped: Extract<
      Awaited<ReturnType<SourceMapLoader["resolveSelectorPrelude"]>>,
      { readonly kind: "mapped" }
    >,
    generatedUri: string,
    request: RulesSourceResolverRequest,
    batch: ResolutionBatchContext,
  ): Promise<string | undefined> {
    if (!isScssUri(mapped.sourceUrl)) return undefined;
    if (isFileUri(mapped.sourceUrl)) {
      let resolution: SourceUriResolution | undefined;
      try {
        resolution = await batchResolveSourceUri(
          batch.sourceResolutions,
          this.workspace,
          mapped.sourceUrl,
          generatedUri,
          request.signal,
        );
      } catch {
        if (request.signal?.aborted) throw abortError();
      }
      const onDisk = resolution &&
        exactWorkspaceUri(this.workspace, resolution);
      if (onDisk && isScssUri(onDisk)) {
        try {
          await batchReadSnapshot(
            batch.initialSnapshots,
            batch.contentHashes,
            batch.retainedSourceBudget,
            batch.snapshotWorkspace,
            onDisk,
            RULES_STYLESHEET_MAX_BYTES,
            request.signal,
          );
          return onDisk;
        } catch (error) {
          if (request.signal?.aborted) throw abortError();
          if (
            error instanceof RulesSourceSnapshotLimitError ||
            error instanceof RulesSourceBatchLimitError
          ) {
            return undefined;
          }
        }
      }
    }
    try {
      return await raceWithAbort(
        batch.stylesheetLocator.locateOriginal(
          mapped.sourceUrl,
          mapped.sourceContent,
        ),
        request.signal,
      );
    } catch {
      if (request.signal?.aborted) throw abortError();
      return undefined;
    }
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
  ast: StylesheetAstCache,
  signal: AbortSignal | undefined,
  maxRetainedSourceBytes: number,
  rules: readonly InspectRuleEvidence[],
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
  const batch: ResolutionBatchContext = {
    sourceResolutions,
    initialSnapshots,
    fenceSnapshots,
    contentHashes,
    stylesheets,
    generatedStylesheets: new Map(),
    stylesheetLocator: new RulesStylesheetLocator(
      {
        findFiles: (pattern) => workspace.findFiles(pattern),
        isWorkspaceUri: (uri) => workspace.isWorkspaceUri(uri),
        readText: (uri, maxBytes) => readRankingText(
          snapshotWorkspace,
          uri,
          maxBytes,
          signal,
        ),
        scoreCandidate: (uri, candidateRules) => scoreGeneratedCandidate(
          batch,
          ast,
          uri,
          candidateRules,
          signal,
        ),
      },
      rules,
      signal,
    ),
    sourceMapWorkspace,
    snapshotWorkspace,
    retainedSourceBudget,
  };
  return batch;
}

/**
 * Reads a file only to rank it. It bypasses the batch caches -- a file read
 * this way is neither retained nor charged, and never becomes a dependency --
 * and it prefers the workspace's own ranking read, which leaves unopened files
 * unopened.
 */
async function readRankingText(
  workspace: RulesSourceSnapshotWorkspace,
  uri: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly text: string; readonly bytes: number }> {
  throwIfAborted(signal);
  const canonicalUri = canonicalRulesSourceUri(uri) ?? uri;
  if (typeof workspace.readRulesRankingText === "function") {
    const text: unknown = await raceWithAbort(
      Promise.resolve().then(() =>
        workspace.readRulesRankingText!(canonicalUri, maxBytes, signal)
      ),
      signal,
    );
    if (typeof text !== "string") {
      throw new Error("Rules ranking text is invalid");
    }
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) throw new RulesSourceSnapshotLimitError();
    return { text, bytes };
  }
  const snapshot = await raceWithAbort(
    Promise.resolve().then(() =>
      workspace.readRulesSourceSnapshot(canonicalUri, maxBytes, signal)
    ),
    signal,
  );
  return {
    text: snapshot.text,
    bytes: validateRulesSourceSnapshot(snapshot, canonicalUri, maxBytes),
  };
}

/** The rules whose stylesheet is looked for: each reported once, completely. */
function locatableRules(
  grouped: ReturnType<typeof groupUniqueRules>,
): InspectRuleEvidence[] {
  return grouped.flatMap((entry) =>
    entry.kind === "unique" &&
      entry.rule.generatedSource !== undefined &&
      completeCssRuleEvidence(entry.rule) !== undefined
      ? [entry.rule]
      : []
  );
}

async function batchLocateGeneratedStylesheet(
  batch: ResolutionBatchContext,
  sourceUrl: string,
  signal: AbortSignal | undefined,
): Promise<GeneratedStylesheetLocation> {
  throwIfAborted(signal);
  let pending = batch.generatedStylesheets.get(sourceUrl);
  if (!pending) {
    pending = Promise.resolve().then(() =>
      batch.stylesheetLocator.locateGenerated(sourceUrl)
    );
    batch.generatedStylesheets.set(sourceUrl, pending);
  }
  const location = await raceWithAbort(pending, signal);
  throwIfAborted(signal);
  return location;
}

/**
 * How many of the rules reported from one stylesheet a workspace file carries.
 *
 * A candidate that gets this far is read like any other source of the batch --
 * retained, hashed and charged -- so the one chosen is resolved from exactly
 * the text it was chosen by. A batch out of budget cannot finish choosing, and
 * says so rather than choosing among fewer files.
 */
async function scoreGeneratedCandidate(
  batch: ResolutionBatchContext,
  ast: StylesheetAstCache,
  uri: string,
  rules: readonly InspectRuleEvidence[],
  signal: AbortSignal | undefined,
): Promise<StylesheetCandidateScore> {
  let snapshot: HashedRulesSourceSnapshot;
  try {
    snapshot = await batchReadSnapshot(
      batch.initialSnapshots,
      batch.contentHashes,
      batch.retainedSourceBudget,
      batch.snapshotWorkspace,
      uri,
      RULES_STYLESHEET_MAX_BYTES,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof RulesSourceBatchLimitError) throw error;
    return {
      kind: "failed",
      reason: error instanceof RulesSourceSnapshotLimitError
        ? "generated-source-too-large"
        : "generated-source-unreadable",
    };
  }
  let stylesheet: ParsedStylesheet;
  try {
    stylesheet = batchParseStylesheet(
      batch,
      ast,
      snapshot.uri,
      "css",
      snapshot.text,
    );
  } catch (error) {
    return { kind: "failed", reason: generatedParseFailure(error) };
  }
  let verified = 0;
  let corroborated = 0;
  for (const rule of rules) {
    throwIfAborted(signal);
    const match = matchGeneratedRule(stylesheet, rule);
    if (!match) continue;
    verified += 1;
    if (match.corroborated) corroborated += 1;
  }
  return { kind: "verified", verified, corroborated };
}

function generatedParseFailure(error: unknown): string {
  if (error instanceof StylesheetParseLimitError) {
    return error.limit === "bytes"
      ? "generated-source-too-large"
      : "generated-source-too-complex";
  }
  return "generated-source-parse-error";
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

function isFileUri(uri: string): boolean {
  try {
    return new URL(uri).protocol === "file:";
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

/**
 * The generated rule the browser reported, found in the file on disk.
 *
 * The browser names a rule by its index in the CSSOM, and that index cannot be
 * predicted from the file's text: an engine drops every rule whose selector it
 * does not implement -- `:-ms-input-placeholder` in one engine, `::-moz-*` in
 * another -- and from the first such rule onwards every later index is shifted.
 * So the index is corroboration, not identity. Identity is the rule the browser
 * reported matched selector, declaration for declaration, and grouping context:
 * when exactly one rule in the file carries all of it, that rule is the one,
 * whichever index the browser gave it.
 */
function verifyGeneratedRule(
  stylesheet: ParsedStylesheet,
  evidence: InspectRuleEvidence,
): StylesheetRule | undefined {
  return matchGeneratedRule(stylesheet, evidence)?.rule;
}

interface GeneratedRuleMatch {
  readonly rule: StylesheetRule;
  /**
   * Whether the rule also stands where the browser said it does -- at the
   * position and CSSOM path it reported -- rather than being found by what it
   * carries alone. Two files carrying the same rules differ here when only one
   * of them is laid out like the stylesheet the browser read.
   */
  readonly corroborated: boolean;
}

function matchGeneratedRule(
  stylesheet: ParsedStylesheet,
  evidence: InspectRuleEvidence,
): GeneratedRuleMatch | undefined {
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
    return { rule: identityCandidate, corroborated: true };
  }
  const relocated = findUniqueRuleByCompleteFingerprint(stylesheet, {
    selector: evidence.selector,
    declarations: declarationEvidence(evidence),
    contexts: generated.contexts,
  });
  return relocated ? { rule: relocated, corroborated: false } : undefined;
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

const RELATIVE_SELECTOR = /&|#\{/;

/**
 * Whether a preprocessor rule is the one the generated rule was compiled from.
 *
 * The generated rule has already been matched declaration for declaration, and
 * the source map is what ties the two together; what is checked here is that
 * the rule the map points at is the same rule. Its declarations cannot be
 * required to match: a preprocessor rule may write none of them out -- a mixin
 * include compiles to a dozen -- so what it does declare directly must be
 * present in what the browser reported, and no more is asked of it.
 */
function originalRuleCarriesEvidence(
  rule: StylesheetRule,
  evidence: InspectRuleEvidence,
  mapCarriedThisSource: boolean,
): boolean {
  if (rule.hasUnsupportedGroupingContext) return false;
  const declarations = completeDeclarationFingerprint(
    declarationEvidence(evidence),
  );
  if (declarations === undefined) return false;
  // A rule written inside a mixin says `&`, or names a state by interpolation,
  // or says nothing at all and lets the `@include` around it decide -- and what
  // that becomes is only known where the mixin is used, as is the `@media` it is
  // used under. Its selector and conditions cannot be compared with anything;
  // what it declares directly still can, and the map is what says this is the
  // rule.
  const comparableSelector = !RELATIVE_SELECTOR.test(rule.selector) &&
    !rule.hasAuthoringRewrittenSelector;
  if (comparableSelector && !mapCarriedThisSource) {
    if (
      normalizeSelector(evidence.selector) !==
        (rule.expandedSelector ?? rule.fingerprint.selector)
    ) {
      return false;
    }
    if (
      !equalContexts(evidence.generatedSource?.contexts ?? [], rule.contexts)
    ) {
      return false;
    }
  }
  const written = declarationsBrowsersKeep(
    declarations,
    rule.fingerprint.declarations,
  );
  return written.length === 0 ||
    declarationsContainEvidence(declarations, written);
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
    !equalReportedDeclarations(declarations, rule.fingerprint.declarations)
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
