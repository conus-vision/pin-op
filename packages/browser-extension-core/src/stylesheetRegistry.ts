import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Rule,
} from "postcss";
import selectorParser from "postcss-selector-parser";
import {
  INSPECT_LIMITS,
  canonicalizePublicStylesheetUrl,
  utf8ByteLength,
} from "@pin-op/protocol";
import { RuleReferenceRegistry } from "./ruleReferenceRegistry.js";
import { StylesheetFingerprint } from "./stylesheetFingerprint.js";

export const STYLESHEET_LIMITS = Object.freeze({
  scopeSheetPairsPerSession: 256,
  uniqueSheetObjectsPerSession: 256,
  rulesVisitedPerSessionSnapshot: 4096,
  declarationsPerRule: 128,
  inlineTextBytesPerSheet: 512 * 1024,
  inlineTextBytesPerSession: 2 * 1024 * 1024,
  scopesPerSession: 64,
  fingerprintCssTextBytesPerPass: 2 * 1024 * 1024,
  fingerprintTimeBudgetMs: 12,
  fingerprintIntervalTargetMs: 1000,
});

const SCOPE_DISCOVERY_CANDIDATE_LIMIT = Math.min(
  STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot,
  STYLESHEET_LIMITS.scopeSheetPairsPerSession * STYLESHEET_LIMITS.scopesPerSession,
);
const RUNTIME_ARTIFACT_SCAN_ALLOWANCE =
  STYLESHEET_LIMITS.scopeSheetPairsPerSession;

export type StylesheetScope = Document | ShadowRoot;
export type StylesheetEntryKind = "external" | "owner" | "adopted" | "import";

export interface GeneratedRuleRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface StylesheetOwnerState {
  readonly media: string;
  readonly disabled: boolean;
  readonly rel: string;
  readonly href: string;
  readonly title: string;
  readonly alternate: boolean;
}

export interface StylesheetImportContext {
  readonly kind: "media" | "supports";
  readonly text: string;
}

export interface StylesheetRegistryOrigin {
  readonly kind: "external" | "owner" | "adopted";
  readonly sheet: CSSStyleSheet;
  readonly owner?: Element;
}

export interface StylesheetImportChainEntry {
  readonly parentSheet: CSSStyleSheet;
  readonly rule: object;
  readonly ruleIndex: number;
  readonly importedSheet: CSSStyleSheet;
  readonly contexts: readonly StylesheetImportContext[];
  readonly unsupported: boolean;
}

export interface StylesheetRegistryEntry {
  readonly scope: StylesheetScope;
  readonly scopeRef: string;
  readonly scopeKind: "document" | "shadow-root";
  readonly sheet: CSSStyleSheet;
  readonly sheetRef: string;
  readonly sheetIdentity: string;
  readonly kind: StylesheetEntryKind;
  readonly sourceOrder: number;
  readonly sourceUrl?: string;
  /** Internal owner identity used for live applicability fingerprinting. */
  readonly owner?: Element;
  readonly ownerState?: StylesheetOwnerState;
  readonly rulePathPrefix: string;
  readonly origin: StylesheetRegistryOrigin;
  readonly importChain: readonly StylesheetImportChainEntry[];
  readonly importContexts?: readonly StylesheetImportContext[];
  readonly importContextUnsupported?: boolean;
  readonly generatedRanges: Readonly<Record<string, GeneratedRuleRange>>;
}

export type StylesheetDiagnosticCode =
  | "stylesheet-inaccessible"
  | "runtime-artifact-exclusion-failed"
  | "scope-limit"
  | "scope-sheet-pair-limit"
  | "unique-sheet-limit"
  | "rules-visited-limit"
  | "inline-text-too-large"
  | "inline-parse-failed"
  | "inline-cssom-ast-mismatch";

export interface StylesheetRegistryDiagnostic {
  readonly code: StylesheetDiagnosticCode;
  readonly scopeRef?: string;
  readonly sheetIdentity?: string;
}

export interface StylesheetRegistrySnapshot {
  readonly documentEpoch: number;
  readonly stylesheetRevision: number;
  readonly stylesRevision: number;
  readonly entries: readonly StylesheetRegistryEntry[];
  readonly uniqueSheetObjectCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly omittedScopeCount: number;
  readonly omittedScopeSheetPairCount: number;
  readonly partial: boolean;
  readonly diagnostics: readonly StylesheetRegistryDiagnostic[];
}

export interface StylesheetRevisionState {
  readonly documentEpoch: number;
  readonly stylesheetRevision: number;
  readonly stylesRevision: number;
}

export interface StylesheetInvalidationEvent extends StylesheetRevisionState {
  readonly reason: string;
  readonly kind: "stylesheet" | "applicability";
}

export interface StylesheetMutationObserver {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

export interface StylesheetRegistryOptions {
  readonly document: Document;
  readonly contentSessionId: string;
  readonly documentEpoch: number;
  readonly onInvalidated?: (event: StylesheetInvalidationEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly isRuntimeNode?: (node: object) => boolean;
  readonly isRuntimeStylesheet?: (stylesheet: object) => boolean;
  readonly now?: () => number;
  readonly createMutationObserver?: (
    callback: (records: readonly unknown[]) => void,
  ) => StylesheetMutationObserver;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

interface RuntimeArtifactExclusion {
  readonly isRuntimeNode?: (node: object) => boolean;
  readonly isRuntimeStylesheet?: (stylesheet: object) => boolean;
  readonly onRuntimeArtifactExclusionError?: (error: unknown) => void;
}

interface InventoryState {
  readonly entries: readonly StylesheetRegistryEntry[];
  readonly uniqueSheetObjectCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly omittedScopeCount: number;
  readonly omittedScopeSheetPairCount: number;
  readonly diagnostics: readonly StylesheetRegistryDiagnostic[];
  readonly scopes: readonly StylesheetScope[];
}

interface MutableInventory {
  readonly entries: StylesheetRegistryEntry[];
  readonly diagnostics: StylesheetRegistryDiagnostic[];
  readonly scopes: StylesheetScope[];
  readonly uniqueSheets: Set<object>;
  readonly pairs: WeakMap<object, Set<object>>;
  inaccessibleStylesheetCount: number;
  omittedScopeCount: number;
  omittedScopeSheetPairCount: number;
  inlineBytes: number;
  rulesVisited: number;
  readonly candidateBudget: CandidatePullBudget;
}

interface CandidatePullBudget {
  pulls: number;
  partial: boolean;
  reported: boolean;
}

interface ScopeDiscoveryBudget {
  pulls: number;
  partial: boolean;
}

/** Browser-local inventory; native CSSOM values never leave this boundary. */
export class StylesheetRegistry {
  private document: Document;
  private documentEpoch: number;
  private stylesheetRevision = 0;
  private stylesRevision = 0;
  private disposed = false;
  private inventoryDirty = true;
  private inventory: InventoryState | undefined;
  private inventoryStructureDigest = "";
  private scopeReferences = new WeakMap<object, string>();
  private sheetReferences = new WeakMap<object, string>();
  private ownerReferences = new WeakMap<object, string>();
  private nextScopeReference = 0;
  private nextSheetReference = 0;
  private nextOwnerReference = 0;
  private identityGeneration = 0;
  private fingerprint: StylesheetFingerprint;
  private readonly ruleReferences: RuleReferenceRegistry;
  private mutationObserver: StylesheetMutationObserver | undefined;
  private pollHandle: unknown;
  private pollApplicability: ((stylesheetChanged: boolean) => void) | undefined;
  private readonly setIntervalFn: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  public constructor(private readonly options: StylesheetRegistryOptions) {
    this.document = requireObject(options.document, "document") as Document;
    this.documentEpoch = requireRevision(options.documentEpoch, "documentEpoch");
    this.fingerprint = new StylesheetFingerprint({ now: options.now });
    this.ruleReferences = new RuleReferenceRegistry({
      contentSessionId: options.contentSessionId,
      documentEpoch: this.documentEpoch,
      stylesheetRevision: 0,
    });
    this.setIntervalFn = options.setInterval ?? ((callback, milliseconds) => (
      globalThis.setInterval(callback, milliseconds)
    ));
    this.clearIntervalFn = options.clearInterval ?? ((handle) => {
      globalThis.clearInterval(handle as number);
    });
    this.refreshInventory();
    this.fingerprint.scan(this.inventory!.entries);
  }

  public get revisions(): StylesheetRevisionState {
    this.requireLive();
    return Object.freeze({
      documentEpoch: this.documentEpoch,
      stylesheetRevision: this.stylesheetRevision,
      stylesRevision: this.stylesRevision,
    });
  }

  public snapshot(): StylesheetRegistrySnapshot {
    this.requireLive();
    this.ensureInventory();
    const inventory = this.inventory!;
    return Object.freeze({
      ...this.revisions,
      entries: inventory.entries,
      uniqueSheetObjectCount: inventory.uniqueSheetObjectCount,
      inaccessibleStylesheetCount: inventory.inaccessibleStylesheetCount,
      omittedScopeCount: inventory.omittedScopeCount,
      omittedScopeSheetPairCount: inventory.omittedScopeSheetPairCount,
      partial: inventory.diagnostics.length > 0,
      diagnostics: inventory.diagnostics,
    });
  }

  public entriesForElement(element: Element): readonly StylesheetRegistryEntry[] {
    this.requireLive();
    this.ensureInventory();
    const root = safeRoot(element);
    if (!root) return Object.freeze([]);
    return Object.freeze(this.inventory!.entries.filter(({ scope }) => scope === root));
  }

  public referenceRule(
    entry: StylesheetRegistryEntry,
    rulePath: string,
    nativeRule: object,
  ): string {
    this.requireLive();
    if (!this.inventory?.entries.includes(entry)) {
      throw new Error("stylesheet entry is not current");
    }
    return this.ruleReferences.reference(entry.sheetIdentity, rulePath, nativeRule);
  }

  public referenceInlineRule(element: Element): string {
    this.requireLive();
    this.ensureInventory();
    const root = safeRoot(element);
    if (!root || !this.inventory!.scopes.includes(root)) {
      throw new Error("inline style element is outside the current inventory");
    }
    const scopeRef = this.scopeRef(root);
    return this.ruleReferences.reference(`${scopeRef}-inline`, "0", element);
  }

  public resolveRule(ruleRef: string): object | undefined {
    this.requireLive();
    return this.ruleReferences.resolve(ruleRef, {
      contentSessionId: this.options.contentSessionId,
      documentEpoch: this.documentEpoch,
      stylesheetRevision: this.stylesheetRevision,
    });
  }

  public checkForChanges(): boolean {
    this.requireLive();
    this.ensureInventory();
    const currentStructureDigest = inventoryStructureDigest(
      this.document,
      (scope) => this.scopeRef(scope),
      (sheet) => this.sheetRef(sheet),
      (owner) => this.ownerRef(owner),
      this.options,
    );
    if (currentStructureDigest !== this.inventoryStructureDigest) {
      this.inventoryDirty = true;
      this.refreshInventory();
      this.fingerprint.reset();
      this.fingerprint.scan(this.inventory!.entries);
      this.advance("inventory-structure-change", "stylesheet");
      return true;
    }
    const result = this.fingerprint.scan(this.inventory!.entries);
    if (!result.changed) return false;
    this.inventoryDirty = true;
    this.refreshInventory();
    this.fingerprint.reset();
    this.fingerprint.scan(this.inventory!.entries);
    this.advance("fingerprint-change", "stylesheet");
    return true;
  }

  public invalidate(reason = "explicit-refresh"): void {
    this.requireLive();
    this.inventoryDirty = true;
    this.fingerprint.reset();
    this.advance(reason, "stylesheet");
  }

  public invalidateApplicability(reason = "applicability-change"): void {
    this.requireLive();
    this.advance(reason, "applicability");
  }

  public startPolling(
    applicabilityCheck?: (stylesheetChanged: boolean) => void,
  ): void {
    this.requireLive();
    if (applicabilityCheck) this.pollApplicability = applicabilityCheck;
    if (this.pollHandle !== undefined) return;
    this.pollHandle = this.setIntervalFn(() => {
      if (this.disposed) return;
      let stylesheetChanged = false;
      try {
        stylesheetChanged = this.checkForChanges();
      } catch (error) {
        this.reportError(error);
      }
      try {
        this.pollApplicability?.(stylesheetChanged);
      } catch (error) {
        this.reportError(error);
      }
    }, STYLESHEET_LIMITS.fingerprintIntervalTargetMs);
  }

  public stopPolling(): void {
    if (this.pollHandle === undefined) return;
    const handle = this.pollHandle;
    this.pollHandle = undefined;
    this.pollApplicability = undefined;
    try {
      this.clearIntervalFn(handle);
    } catch (error) {
      this.reportError(error);
    }
  }

  public resetDocument(document: Document, documentEpoch: number): void {
    this.requireLive();
    const nextEpoch = requireRevision(documentEpoch, "documentEpoch");
    if (nextEpoch <= this.documentEpoch) {
      throw new RangeError("documentEpoch must advance");
    }
    const polling = this.pollHandle !== undefined;
    const applicability = this.pollApplicability;
    this.stopPolling();
    this.disconnectMutationObserver();
    this.document = requireObject(document, "document") as Document;
    this.documentEpoch = nextEpoch;
    this.stylesheetRevision = 0;
    this.stylesRevision = 0;
    this.scopeReferences = new WeakMap();
    this.sheetReferences = new WeakMap();
    this.ownerReferences = new WeakMap();
    this.nextScopeReference = 0;
    this.nextSheetReference = 0;
    this.nextOwnerReference = 0;
    this.identityGeneration += 1;
    this.inventory = undefined;
    this.inventoryDirty = true;
    this.fingerprint.reset();
    this.ruleReferences.reset({
      contentSessionId: this.options.contentSessionId,
      documentEpoch: nextEpoch,
      stylesheetRevision: 0,
    });
    this.refreshInventory();
    this.fingerprint.scan(this.inventory!.entries);
    if (polling) this.startPolling(applicability);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.stopPolling();
    this.disposed = true;
    this.disconnectMutationObserver();
    this.fingerprint.reset();
    this.ruleReferences.dispose();
    this.inventory = undefined;
  }

  private ensureInventory(): void {
    if (!this.inventoryDirty && this.inventory) return;
    this.refreshInventory();
    this.fingerprint.scan(this.inventory!.entries);
  }

  private refreshInventory(): void {
    const previousScopes = this.inventory?.scopes;
    const state = inventoryStylesheets(
      this.document,
      (scope) => this.scopeRef(scope),
      (sheet) => this.sheetRef(sheet),
      this.options,
    );
    this.inventory = state;
    this.inventoryDirty = false;
    this.inventoryStructureDigest = inventoryStructureDigest(
      this.document,
      (scope) => this.scopeRef(scope),
      (sheet) => this.sheetRef(sheet),
      (owner) => this.ownerRef(owner),
      this.options,
    );
    if (!previousScopes || !sameObjectArray(previousScopes, state.scopes)) {
      this.installMutationObserver(state.scopes);
    }
  }

  private scopeRef(scope: object): string {
    const existing = this.scopeReferences.get(scope);
    if (existing) return existing;
    const created = `scope-${this.identityGeneration}-${this.nextScopeReference++}`;
    this.scopeReferences.set(scope, created);
    return created;
  }

  private sheetRef(sheet: object): string {
    const existing = this.sheetReferences.get(sheet);
    if (existing) return existing;
    const created = `sheet-${this.nextSheetReference++}`;
    this.sheetReferences.set(sheet, created);
    return created;
  }

  private ownerRef(owner: object): string {
    const existing = this.ownerReferences.get(owner);
    if (existing) return existing;
    const created = `owner-${this.nextOwnerReference++}`;
    this.ownerReferences.set(owner, created);
    return created;
  }

  private installMutationObserver(scopes: readonly StylesheetScope[]): void {
    this.disconnectMutationObserver();
    const create = this.options.createMutationObserver ??
      defaultMutationObserverFactory();
    if (!create) return;
    let observer: StylesheetMutationObserver | undefined;
    try {
      observer = create((records) => {
        if (this.disposed) return;
        const kind = classifyStylesheetMutations(records, this.options);
        if (kind !== "stylesheet") return;
        this.inventoryDirty = true;
        this.fingerprint.reset();
        this.advance("stylesheet-dom-mutation", "stylesheet");
      });
      this.mutationObserver = observer;
      for (const scope of scopes) {
        observer.observe(scope as unknown as Node, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["media", "disabled", "rel", "href", "title"],
          characterData: true,
        });
      }
    } catch (error) {
      try {
        observer?.disconnect();
      } catch {
        // A detached observer has no remaining authority.
      }
      this.mutationObserver = undefined;
      this.reportError(error);
    }
  }

  private disconnectMutationObserver(): void {
    const observer = this.mutationObserver;
    this.mutationObserver = undefined;
    if (!observer) return;
    try {
      observer.disconnect();
    } catch (error) {
      this.reportError(error);
    }
  }

  private advance(reason: string, kind: "stylesheet" | "applicability"): void {
    if (kind === "stylesheet") {
      this.stylesheetRevision += 1;
      this.ruleReferences.reset({
        contentSessionId: this.options.contentSessionId,
        documentEpoch: this.documentEpoch,
        stylesheetRevision: this.stylesheetRevision,
      });
    }
    this.stylesRevision += 1;
    const event: StylesheetInvalidationEvent = Object.freeze({
      documentEpoch: this.documentEpoch,
      stylesheetRevision: this.stylesheetRevision,
      stylesRevision: this.stylesRevision,
      reason,
      kind,
    });
    try {
      this.options.onInvalidated?.(event);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.disposed) return;
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot change registry ownership.
    }
  }

  private requireLive(): void {
    if (this.disposed) throw new Error("StylesheetRegistry is disposed");
  }
}

function inventoryStylesheets(
  document: Document,
  scopeRefFor: (scope: object) => string,
  sheetRefFor: (sheet: object) => string,
  exclusion: RuntimeArtifactExclusion,
): InventoryState {
  const ownerSnapshots = new WeakMap<object, object | undefined>();
  const state: MutableInventory = {
    entries: [],
    diagnostics: [],
    scopes: [],
    uniqueSheets: new Set(),
    pairs: new WeakMap(),
    inaccessibleStylesheetCount: 0,
    omittedScopeCount: 0,
    omittedScopeSheetPairCount: 0,
    inlineBytes: 0,
    rulesVisited: 0,
    candidateBudget: { pulls: 0, partial: false, reported: false },
  };
  const discoveryBudget: ScopeDiscoveryBudget = { pulls: 0, partial: false };
  let exclusionFailureReported = false;
  const guardedExclusion = withRuntimeExclusionErrorHandler(exclusion, () => {
    if (exclusionFailureReported) return;
    exclusionFailureReported = true;
    state.inaccessibleStylesheetCount += 1;
    addDiagnostic(state, { code: "runtime-artifact-exclusion-failed" });
  });
  const scopes = discoverScopes(document, state, discoveryBudget, guardedExclusion);
  for (const scope of scopes) {
    const scopeRef = scopeRefFor(scope);
    let sourceOrder = 0;
    const owned = readOwnerSheets(scope, state.candidateBudget, guardedExclusion);
    recordCandidatePartial(state, scopeRef);
    if (scopeKind(scope) === "shadow-root") {
      for (const { sheet, owner } of owned) {
        sourceOrder = addSheetTree(
          state, scope, scopeRef, sheet, "owner", sourceOrder,
          owner, "", scopeRefFor, sheetRefFor, new Set(), guardedExclusion,
        );
      }
    }
    const scopeSheets = readScopeStyleSheets(
      scope,
      state.candidateBudget,
      guardedExclusion,
      ownerSnapshots,
    );
    recordCandidatePartial(state, scopeRef);
    for (const sheet of scopeSheets.values) {
      if (isRuntimeStylesheet(guardedExclusion, sheet)) continue;
      const owner = snapshotOwnerNode(sheet, ownerSnapshots);
      if (owner && isRuntimeNode(guardedExclusion, owner)) continue;
      sourceOrder = addSheetTree(
        state,
        scope,
        scopeRef,
        sheet,
        safeHref(sheet) ? "external" : "owner",
        sourceOrder,
        owner,
        "",
        scopeRefFor,
        sheetRefFor,
        new Set(),
        guardedExclusion,
      );
    }
    if (scopeKind(scope) === "document") {
      for (const { sheet, owner } of owned) {
        sourceOrder = addSheetTree(
          state, scope, scopeRef, sheet, "owner", sourceOrder,
          owner, "", scopeRefFor, sheetRefFor, new Set(), guardedExclusion,
        );
      }
    }
    const adoptedSheets = readAdoptedSheets(
      scope,
      state.candidateBudget,
      guardedExclusion,
    );
    recordCandidatePartial(state, scopeRef);
    for (const sheet of adoptedSheets.values) {
      if (isRuntimeStylesheet(guardedExclusion, sheet)) continue;
      sourceOrder = addSheetTree(
        state, scope, scopeRef, sheet, "adopted", sourceOrder,
        snapshotOwnerNode(sheet, ownerSnapshots), "", scopeRefFor, sheetRefFor,
        new Set(), guardedExclusion,
      );
    }
  }
  return Object.freeze({
    entries: Object.freeze(state.entries),
    uniqueSheetObjectCount: state.uniqueSheets.size,
    inaccessibleStylesheetCount: state.inaccessibleStylesheetCount,
    omittedScopeCount: state.omittedScopeCount,
    omittedScopeSheetPairCount: state.omittedScopeSheetPairCount,
    diagnostics: Object.freeze(state.diagnostics),
    scopes: Object.freeze(state.scopes),
  });
}

function inventoryStructureDigest(
  document: Document,
  scopeRefFor: (scope: object) => string,
  sheetRefFor: (sheet: object) => string,
  ownerRefFor: (owner: object) => string,
  exclusion: RuntimeArtifactExclusion,
): string {
  const ownerSnapshots = new WeakMap<object, object | undefined>();
  let runtimeExclusionFailed = false;
  const guardedExclusion = withRuntimeExclusionErrorHandler(exclusion, () => {
    runtimeExclusionFailed = true;
  });
  const candidateBudget: CandidatePullBudget = {
    pulls: 0,
    partial: false,
    reported: false,
  };
  const discoveryBudget: ScopeDiscoveryBudget = { pulls: 0, partial: false };
  const scopes = discoverScopes(document, undefined, discoveryBudget, guardedExclusion);
  const uniqueSheets = new Set<object>();
  const parts: string[] = [`scope-count:${scopes.length}`];
  let pairCount = 0;
  let truncated = false;
  for (const scope of scopes) {
    const scopeRef = scopeRefFor(scope);
    const seen = new Set<object>();
    let sourceOrder = 0;
    parts.push(`scope:${scopeRef}:${scopeKind(scope)}`);
    const append = (
      kind: "owner" | "external" | "adopted",
      candidates: readonly {
        readonly sheet: object;
        readonly owner?: object;
      }[],
    ): void => {
      for (const { sheet, owner } of candidates) {
        if (
          isRuntimeStylesheet(guardedExclusion, sheet) ||
          (owner && isRuntimeNode(guardedExclusion, owner))
        ) continue;
        if (seen.has(sheet)) continue;
        if (pairCount >= STYLESHEET_LIMITS.scopeSheetPairsPerSession) {
          truncated = true;
          return;
        }
        if (
          !uniqueSheets.has(sheet) &&
          uniqueSheets.size >= STYLESHEET_LIMITS.uniqueSheetObjectsPerSession
        ) {
          truncated = true;
          continue;
        }
        seen.add(sheet);
        uniqueSheets.add(sheet);
        parts.push([
          scopeRef,
          String(sourceOrder),
          kind,
          sheetRefFor(sheet),
          owner ? ownerRefFor(owner) : "",
        ].join(":"));
        sourceOrder += 1;
        pairCount += 1;
      }
    };
    const owned = readOwnerSheets(scope, candidateBudget, guardedExclusion);
    if (scopeKind(scope) === "shadow-root") {
      append("owner", owned);
    }
    const scopeSheets = readScopeStyleSheets(
      scope,
      candidateBudget,
      guardedExclusion,
      ownerSnapshots,
    );
    truncated ||= scopeSheets.truncated;
    append("external", scopeSheets.values.map((sheet) => {
      const owner = snapshotOwnerNode(sheet, ownerSnapshots);
      return {
        sheet,
        ...(owner ? { owner } : {}),
      };
    }));
    if (scopeKind(scope) === "document") {
      append("owner", owned);
    }
    const adoptedSheets = readAdoptedSheets(scope, candidateBudget, guardedExclusion);
    truncated ||= adoptedSheets.truncated;
    append("adopted", adoptedSheets.values.map((sheet) => {
      const owner = snapshotOwnerNode(sheet, ownerSnapshots);
      return {
        sheet,
        ...(owner ? { owner } : {}),
      };
    }));
  }
  parts.push(
    `pairs:${pairCount}`,
    `unique:${uniqueSheets.size}`,
    truncated || candidateBudget.partial || discoveryBudget.partial
      ? "truncated"
      : "complete",
    runtimeExclusionFailed ? "runtime-exclusion-failed" : "runtime-exclusion-complete",
  );
  return digestStructureParts(parts);
}

function discoverScopes(
  document: Document,
  state?: MutableInventory,
  discoveryBudget: ScopeDiscoveryBudget = { pulls: 0, partial: false },
  exclusion: RuntimeArtifactExclusion = {},
): StylesheetScope[] {
  const scopes = state?.scopes ?? [];
  const queue: StylesheetScope[] = [document];
  const seenScopes = new Set<object>();
  const seenNodes = new Set<object>();
  while (queue.length > 0) {
    const scope = queue.shift()!;
    if (seenScopes.has(scope)) continue;
    if (scopes.length >= STYLESHEET_LIMITS.scopesPerSession) {
      if (state) {
        state.omittedScopeCount += 1 + queue.length;
        addDiagnostic(state, { code: "scope-limit" });
      }
      break;
    }
    seenScopes.add(scope);
    scopes.push(scope);
    const nodeStack: object[] = [scope];
    while (nodeStack.length > 0) {
      const parent = nodeStack.pop()!;
      const children = readScopeDiscoveryChildren(
        parent,
        discoveryBudget,
        exclusion,
      );
      for (const node of children.values) {
        if (isRuntimeNode(exclusion, node)) continue;
        if (seenNodes.has(node)) continue;
        seenNodes.add(node);
        const shadow = safeObjectProperty(node, "shadowRoot");
        if (shadow && safeStringProperty(shadow, "mode") !== "closed") {
          queue.push(shadow as unknown as ShadowRoot);
        }
        const frameDocument = safeObjectProperty(node, "contentDocument");
        if (frameDocument && isDocumentScope(frameDocument)) {
          queue.push(frameDocument as unknown as Document);
        }
        nodeStack.push(node);
      }
      if (remainingScopeDiscoveryPulls(discoveryBudget) === 0) {
        if (nodeStack.length > 0) discoveryBudget.partial = true;
        nodeStack.length = 0;
      }
    }
  }
  if (discoveryBudget.partial && state) {
    state.omittedScopeCount += 1;
    addDiagnostic(state, { code: "scope-limit" });
  }
  return scopes;
}

function addSheetTree(
  state: MutableInventory,
  scope: StylesheetScope,
  scopeRef: string,
  sheet: object,
  kind: StylesheetEntryKind,
  sourceOrder: number,
  owner: object | undefined,
  rulePathPrefix: string,
  _scopeRefFor: (scope: object) => string,
  sheetRefFor: (sheet: object) => string,
  active: Set<object>,
  exclusion: RuntimeArtifactExclusion,
  importContexts: readonly StylesheetImportContext[] = Object.freeze([]),
  importContextUnsupported = false,
  origin?: StylesheetRegistryOrigin,
  importChain: readonly StylesheetImportChainEntry[] = Object.freeze([]),
): number {
  if (
    isRuntimeStylesheet(exclusion, sheet) ||
    (owner && isRuntimeNode(exclusion, owner))
  ) return sourceOrder;
  if (active.has(sheet)) return sourceOrder;
  const pairs = state.pairs.get(scope) ?? new Set<object>();
  state.pairs.set(scope, pairs);
  if (pairs.has(sheet)) return sourceOrder;
  if (state.entries.length >= STYLESHEET_LIMITS.scopeSheetPairsPerSession) {
    state.omittedScopeSheetPairCount += 1;
    addDiagnostic(state, { code: "scope-sheet-pair-limit", scopeRef });
    return sourceOrder;
  }
  if (
    !state.uniqueSheets.has(sheet) &&
    state.uniqueSheets.size >= STYLESHEET_LIMITS.uniqueSheetObjectsPerSession
  ) {
    state.omittedScopeSheetPairCount += 1;
    addDiagnostic(state, { code: "unique-sheet-limit", scopeRef });
    return sourceOrder;
  }
  pairs.add(sheet);
  state.uniqueSheets.add(sheet);
  const sheetRef = sheetRefFor(sheet);
  const sheetIdentity = `${scopeRef}-${sheetRef}`;
  const sourceUrl = publicStylesheetUrl(safeHref(sheet), scope);
  let rules: readonly object[] = [];
  let rulesComplete = false;
  try {
    const remaining = Math.max(
      0,
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - state.rulesVisited,
    );
    const bounded = readCssRulesBounded(sheet, remaining);
    rules = bounded.rules;
    state.rulesVisited += bounded.pulls;
    if (bounded.truncated) {
      addDiagnostic(state, {
        code: "rules-visited-limit",
        scopeRef,
        sheetIdentity,
      });
    }
    if (bounded.failures > 0) {
      state.inaccessibleStylesheetCount += 1;
      addDiagnostic(state, {
        code: "stylesheet-inaccessible",
        scopeRef,
        sheetIdentity,
      });
    }
    rulesComplete = !bounded.truncated && bounded.failures === 0;
  } catch {
    state.inaccessibleStylesheetCount += 1;
    addDiagnostic(state, {
      code: "stylesheet-inaccessible",
      scopeRef,
      sheetIdentity,
    });
  }
  const generatedRanges = owner && rulesComplete && kind !== "import"
    ? inlineRangesForOwner(state, rules, owner, scopeRef, sheetIdentity)
    : Object.freeze({});
  const exactOrigin: StylesheetRegistryOrigin = origin ?? Object.freeze({
    kind: kind as StylesheetRegistryOrigin["kind"],
    sheet: sheet as CSSStyleSheet,
    ...(owner && kind !== "adopted" ? { owner: owner as Element } : {}),
  });
  const ownerState = owner ? readStylesheetOwnerState(owner) : undefined;
  if (owner && !ownerState) {
    state.inaccessibleStylesheetCount += 1;
    addDiagnostic(state, {
      code: "stylesheet-inaccessible",
      scopeRef,
      sheetIdentity,
    });
  }
  const entry: StylesheetRegistryEntry = Object.freeze({
    scope,
    scopeRef,
    scopeKind: scopeKind(scope),
    sheet: sheet as CSSStyleSheet,
    sheetRef,
    sheetIdentity,
    kind,
    sourceOrder,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(owner ? {
      owner: owner as Element,
      ...(ownerState ? { ownerState } : {}),
    } : {}),
    rulePathPrefix,
    origin: exactOrigin,
    importChain: Object.freeze([...importChain]),
    ...(kind === "import" ? {
      importContexts: Object.freeze([...importContexts]),
      ...(importContextUnsupported ? { importContextUnsupported: true } : {}),
    } : {}),
    generatedRanges,
  });
  state.entries.push(entry);
  sourceOrder += 1;
  active.add(sheet);
  for (let index = 0; index < rules.length; index += 1) {
    const imported = safeObjectProperty(rules[index]!, "styleSheet");
    if (!imported) continue;
    const provenance = readStylesheetImportProvenance(rules[index]!);
    const chainEntry: StylesheetImportChainEntry = Object.freeze({
      parentSheet: sheet as CSSStyleSheet,
      rule: rules[index]!,
      ruleIndex: index,
      importedSheet: imported as CSSStyleSheet,
      contexts: provenance.contexts,
      unsupported: provenance.unsupported,
    });
    sourceOrder = addSheetTree(
      state,
      scope,
      scopeRef,
      imported,
      "import",
      sourceOrder,
      exactOrigin.owner,
      rulePathPrefix ? `${rulePathPrefix}.${index}` : `${index}`,
      _scopeRefFor,
      sheetRefFor,
      active,
      exclusion,
      Object.freeze([...importContexts, ...provenance.contexts]),
      importContextUnsupported || provenance.unsupported,
      exactOrigin,
      Object.freeze([...importChain, chainEntry]),
    );
  }
  active.delete(sheet);
  return sourceOrder;
}

export function readStylesheetImportProvenance(rule: object): {
  readonly contexts: readonly StylesheetImportContext[];
  readonly unsupported: boolean;
} {
  const contexts: StylesheetImportContext[] = [];
  let unsupported = false;
  try {
    if ("layerName" in rule) {
      const layerName = (rule as { readonly layerName?: unknown }).layerName;
      if (layerName !== null && layerName !== undefined) unsupported = true;
    }
  } catch {
    unsupported = true;
  }
  try {
    if ("supportsText" in rule) {
      const supports = (rule as { readonly supportsText?: unknown }).supportsText;
      if (supports !== null && supports !== undefined && supports !== "") {
        if (validImportCondition(supports)) {
          contexts.push(Object.freeze({ kind: "supports", text: supports }));
        } else {
          unsupported = true;
        }
      }
    }
  } catch {
    unsupported = true;
  }
  try {
    const media = (rule as { readonly media?: unknown }).media;
    if (media !== null && media !== undefined) {
      const text = (media as { readonly mediaText?: unknown }).mediaText;
      if (text !== null && text !== undefined && text !== "") {
        if (validImportCondition(text)) {
          contexts.push(Object.freeze({ kind: "media", text }));
        } else {
          unsupported = true;
        }
      }
    }
  } catch {
    unsupported = true;
  }
  return Object.freeze({ contexts: Object.freeze(contexts), unsupported });
}

function validImportCondition(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= INSPECT_LIMITS.valueLength &&
    !/[{};]/u.test(value);
}

function inlineRangesForOwner(
  state: MutableInventory,
  cssomRules: readonly object[],
  owner: object,
  scopeRef: string,
  sheetIdentity: string,
): Readonly<Record<string, GeneratedRuleRange>> {
  if (safeTagName(owner) !== "STYLE") return Object.freeze({});
  const text = safeStringProperty(owner, "textContent") ?? "";
  const bytes = utf8ByteLength(text);
  if (
    bytes > STYLESHEET_LIMITS.inlineTextBytesPerSheet ||
    state.inlineBytes + bytes > STYLESHEET_LIMITS.inlineTextBytesPerSession
  ) {
    addDiagnostic(state, {
      code: "inline-text-too-large",
      scopeRef,
      sheetIdentity,
    });
    return Object.freeze({});
  }
  state.inlineBytes += bytes;
  let ast: ReturnType<typeof postcss.parse>;
  try {
    ast = postcss.parse(text, { from: undefined });
  } catch {
    addDiagnostic(state, {
      code: "inline-parse-failed",
      scopeRef,
      sheetIdentity,
    });
    return Object.freeze({});
  }
  const ranges: Record<string, GeneratedRuleRange> = {};
  if (!correlateRuleLists(
    state,
    cssomRules,
    significantNodes(ast),
    "",
    ranges,
    scopeRef,
    sheetIdentity,
  )) {
    addDiagnostic(state, {
      code: "inline-cssom-ast-mismatch",
      scopeRef,
      sheetIdentity,
    });
    return Object.freeze({});
  }
  return Object.freeze(ranges);
}

function correlateRuleLists(
  state: MutableInventory,
  cssom: readonly object[],
  ast: readonly ChildNode[],
  parentPath: string,
  ranges: Record<string, GeneratedRuleRange>,
  scopeRef: string,
  sheetIdentity: string,
): boolean {
  if (cssom.length !== ast.length) return false;
  for (let index = 0; index < cssom.length; index += 1) {
    const nativeRule = cssom[index]!;
    const node = ast[index]!;
    const path = parentPath ? `${parentPath}.${index}` : `${index}`;
    const selector = safeStringProperty(nativeRule, "selectorText");
    if (selector !== undefined) {
      if (node.type !== "rule" || !sameSelector(selector, node.selector)) return false;
      if (!sameDeclarations(nativeRule, node)) return false;
      const range = sourceRange(node);
      if (!range) return false;
      ranges[path] = range;
    } else {
      const nested = readNestedCssRulesBounded(
        state,
        nativeRule,
        scopeRef,
        sheetIdentity,
      );
      if (nested === undefined || node.type !== "atrule") return false;
      if (!sameGroup(nativeRule, node)) return false;
      if (!correlateRuleLists(
        state,
        nested,
        significantNodes(node),
        path,
        ranges,
        scopeRef,
        sheetIdentity,
      )) {
        return false;
      }
    }
  }
  return true;
}

function significantNodes(container: Container): ChildNode[] {
  return (container.nodes ?? []).filter((node) => (
    node.type !== "comment" && node.type !== "decl"
  ));
}

function sameSelector(left: string, right: string): boolean {
  try {
    const normalize = (selector: string): string => selectorParser()
      .astSync(selector)
      .toString()
      .replace(/\s+/g, " ")
      .trim();
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function sameDeclarations(nativeRule: object, node: Rule): boolean {
  const style = safeObjectProperty(nativeRule, "style");
  if (!style) return false;
  const declarations = (node.nodes ?? []).filter((child) => child.type === "decl");
  const length = safeNumberProperty(style, "length");
  if (
    length === undefined ||
    length > STYLESHEET_LIMITS.declarationsPerRule ||
    length !== declarations.length
  ) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const declaration = declarations[index]!;
    let name: unknown;
    let value: unknown;
    let priority: unknown;
    try {
      const source = style as unknown as {
        item(index: number): string;
        getPropertyValue(name: string): string;
        getPropertyPriority(name: string): string;
      };
      name = source.item(index);
      value = source.getPropertyValue(String(name));
      priority = source.getPropertyPriority(String(name));
    } catch {
      return false;
    }
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      typeof priority !== "string" ||
      declaration.prop.trim() !== name.trim() ||
      normalizeCssValue(declaration.value) !== normalizeCssValue(value) ||
      (declaration.important === true) !== (priority === "important")
    ) {
      return false;
    }
  }
  return true;
}

function sameGroup(nativeRule: object, node: AtRule): boolean {
  const cssText = safeStringProperty(nativeRule, "cssText");
  if (
    cssText === undefined ||
    cssText.length > STYLESHEET_LIMITS.inlineTextBytesPerSheet ||
    utf8ByteLength(cssText) > STYLESHEET_LIMITS.inlineTextBytesPerSheet
  ) {
    return false;
  }

  let parsed: ReturnType<typeof postcss.parse>;
  try {
    parsed = postcss.parse(cssText, { from: undefined });
  } catch {
    return false;
  }
  const nativeNodes = (parsed.nodes ?? []).filter(({ type }) => type !== "comment");
  if (nativeNodes.length !== 1) return false;
  const nativeNode = nativeNodes[0]!;
  if (nativeNode.type !== "atrule" || nativeNode.nodes === undefined) return false;

  return nativeNode.name.toLowerCase() === node.name.toLowerCase() &&
    normalizeCssValue(nativeNode.params) === normalizeCssValue(node.params);
}

function sourceRange(node: ChildNode): GeneratedRuleRange | undefined {
  const start = node.source?.start;
  const end = node.source?.end;
  if (!start || !end) return undefined;
  return Object.freeze({
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column + 1,
  });
}

export function readStylesheetOwnerState(
  owner: object,
): StylesheetOwnerState | undefined {
  const media = readOwnerAttribute(owner, "media", INSPECT_LIMITS.valueLength);
  const rel = readOwnerAttribute(owner, "rel", INSPECT_LIMITS.valueLength);
  const href = readOwnerAttribute(owner, "href", INSPECT_LIMITS.urlLength);
  const title = readOwnerAttribute(owner, "title", INSPECT_LIMITS.valueLength);
  const disabled = readOwnerDisabled(owner);
  if (
    media === undefined ||
    rel === undefined ||
    href === undefined ||
    title === undefined ||
    disabled === undefined
  ) return undefined;
  return Object.freeze({
    media,
    disabled,
    rel,
    href,
    title,
    alternate: rel.toLowerCase().split(/\s+/).includes("alternate"),
  });
}

function readOwnerSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
  exclusion: RuntimeArtifactExclusion,
): Array<{
  readonly sheet: object;
  readonly owner: object;
}> {
  const result: Array<{ readonly sheet: object; readonly owner: object }> = [];
  const candidates = safeQueryAll(
    scope,
    "style,link[rel~='stylesheet']",
    candidateBudget,
    (candidate) => isRuntimeNode(exclusion, candidate),
  );
  for (const owner of candidates.values) {
    if (isRuntimeNode(exclusion, owner)) continue;
    const sheet = safeObjectProperty(owner, "sheet");
    if (sheet && !isRuntimeStylesheet(exclusion, sheet)) {
      result.push({ sheet, owner });
    }
  }
  return result;
}

function readScopeStyleSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
  exclusion: RuntimeArtifactExclusion,
  ownerSnapshots: WeakMap<object, object | undefined>,
): BoundedObjectScan {
  if (remainingCandidatePulls(candidateBudget) === 0) {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  try {
    const sheets = (scope as unknown as { readonly styleSheets?: unknown }).styleSheets;
    return sheets
      ? scanCandidateObjects(
          sheets,
          candidateBudget,
          (sheet) => {
            if (isRuntimeStylesheet(exclusion, sheet)) return true;
            const owner = snapshotOwnerNode(sheet, ownerSnapshots);
            return owner ? isRuntimeNode(exclusion, owner) : false;
          },
        )
      : emptyBoundedObjectScan();
  } catch {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
}

function readAdoptedSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
  exclusion: RuntimeArtifactExclusion,
): BoundedObjectScan {
  if (remainingCandidatePulls(candidateBudget) === 0) {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  try {
    const sheets = (scope as unknown as { readonly adoptedStyleSheets?: unknown })
      .adoptedStyleSheets;
    return sheets
      ? scanCandidateObjects(
          sheets,
          candidateBudget,
          (sheet) => isRuntimeStylesheet(exclusion, sheet),
        )
      : emptyBoundedObjectScan();
  } catch {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
}

function readCssRulesBounded(
  sheet: object,
  maximum: number,
): {
  readonly rules: readonly object[];
  readonly pulls: number;
  readonly failures: number;
  readonly truncated: boolean;
} {
  const raw = (sheet as { readonly cssRules?: unknown }).cssRules;
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules unavailable");
  }
  const bounded = scanBoundedObjects(raw, maximum);
  return {
    rules: bounded.values,
    pulls: bounded.pulls,
    failures: bounded.failures,
    truncated: bounded.truncated,
  };
}

function readNestedCssRulesBounded(
  state: MutableInventory,
  rule: object,
  scopeRef: string,
  sheetIdentity: string,
): readonly object[] | undefined {
  try {
    if (!("cssRules" in rule)) return undefined;
    const remaining = Math.max(
      0,
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - state.rulesVisited,
    );
    const bounded = readCssRulesBounded(rule, remaining);
    state.rulesVisited += bounded.pulls;
    if (bounded.truncated) {
      addDiagnostic(state, {
        code: "rules-visited-limit",
        scopeRef,
        sheetIdentity,
      });
    }
    if (bounded.failures > 0) {
      state.inaccessibleStylesheetCount += 1;
      addDiagnostic(state, {
        code: "stylesheet-inaccessible",
        scopeRef,
        sheetIdentity,
      });
    }
    return bounded.truncated || bounded.failures > 0
      ? undefined
      : bounded.rules;
  } catch {
    state.inaccessibleStylesheetCount += 1;
    addDiagnostic(state, {
      code: "stylesheet-inaccessible",
      scopeRef,
      sheetIdentity,
    });
    return undefined;
  }
}

function boundedObjectList(
  value: unknown,
  maximum: number = STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot,
): object[] {
  return scanBoundedObjects(value, maximum).values;
}

interface BoundedObjectScan {
  readonly values: object[];
  readonly pulls: number;
  readonly failures: number;
  readonly truncated: boolean;
}

function emptyBoundedObjectScan(
  truncated = false,
  failures = 0,
): BoundedObjectScan {
  return { values: [], pulls: 0, failures, truncated };
}

function scanCandidateObjects(
  value: unknown,
  budget: CandidatePullBudget,
  isExcluded: (candidate: object) => boolean = () => false,
): BoundedObjectScan {
  const remaining = remainingCandidatePulls(budget);
  const bounded = scanBoundedObjects(
    value,
    remaining + RUNTIME_ARTIFACT_SCAN_ALLOWANCE,
  );
  const retained: object[] = [];
  let excludedPulls = 0;
  for (const candidate of bounded.values) {
    let excluded = true;
    try {
      excluded = isExcluded(candidate) === true;
    } catch {
      excluded = true;
    }
    if (excluded) {
      excludedPulls += 1;
    } else if (retained.length < remaining) {
      retained.push(candidate);
    }
  }
  const authorPulls = Math.min(
    remaining,
    Math.max(0, bounded.values.length - excludedPulls + bounded.failures),
  );
  budget.pulls += authorPulls;
  const authorTruncated = bounded.values.length - excludedPulls > remaining;
  const truncated = bounded.truncated || authorTruncated;
  if (truncated || bounded.failures > 0) budget.partial = true;
  return {
    values: retained,
    pulls: authorPulls,
    failures: bounded.failures,
    truncated,
  };
}

function remainingCandidatePulls(budget: CandidatePullBudget): number {
  return Math.max(
    0,
    STYLESHEET_LIMITS.scopeSheetPairsPerSession - budget.pulls,
  );
}

function readScopeDiscoveryChildren(
  node: object,
  budget: ScopeDiscoveryBudget,
  exclusion: RuntimeArtifactExclusion,
): BoundedObjectScan {
  const remaining = remainingScopeDiscoveryPulls(budget);
  if (remaining === 0) {
    budget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  let childNodes: unknown;
  try {
    childNodes = (node as { readonly childNodes?: unknown }).childNodes;
  } catch {
    budget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
  if (childNodes === undefined || childNodes === null) {
    return emptyBoundedObjectScan();
  }
  const bounded = scanBoundedObjects(
    childNodes,
    remaining + RUNTIME_ARTIFACT_SCAN_ALLOWANCE,
  );
  const retained: object[] = [];
  let excludedPulls = 0;
  for (const candidate of bounded.values) {
    if (isRuntimeNode(exclusion, candidate)) {
      excludedPulls += 1;
    } else if (retained.length < remaining) {
      retained.push(candidate);
    }
  }
  const authorPulls = Math.min(
    remaining,
    Math.max(0, bounded.values.length - excludedPulls + bounded.failures),
  );
  budget.pulls += authorPulls;
  const authorTruncated = bounded.values.length - excludedPulls > remaining;
  const truncated = bounded.truncated || authorTruncated;
  if (truncated || bounded.failures > 0) budget.partial = true;
  return {
    values: retained,
    pulls: authorPulls,
    failures: bounded.failures,
    truncated,
  };
}

function remainingScopeDiscoveryPulls(budget: ScopeDiscoveryBudget): number {
  return Math.max(0, SCOPE_DISCOVERY_CANDIDATE_LIMIT - budget.pulls);
}

function recordCandidatePartial(
  state: MutableInventory,
  scopeRef?: string,
): void {
  if (!state.candidateBudget.partial || state.candidateBudget.reported) return;
  state.candidateBudget.reported = true;
  state.omittedScopeSheetPairCount += 1;
  addDiagnostic(state, { code: "scope-sheet-pair-limit", scopeRef });
}

function scanBoundedObjects(
  value: unknown,
  maximum: number,
): BoundedObjectScan {
  const result: object[] = [];
  const boundedMaximum = Number.isSafeInteger(maximum) && maximum > 0
    ? maximum
    : 0;
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return { values: result, pulls: 0, failures: 1, truncated: true };
  }
  const knownLength = safeNumberProperty(value, "length");
  if (knownLength !== undefined) {
    const pulls = Math.min(knownLength, boundedMaximum);
    let failures = 0;
    for (let index = 0; index < pulls; index += 1) {
      try {
        const item = (value as ArrayLike<unknown>)[index];
        if (typeof item === "object" && item !== null) {
          result.push(item);
        } else {
          failures += 1;
        }
      } catch {
        // A hostile slot consumes the same bounded pull as a readable slot.
        failures += 1;
      }
    }
    return {
      values: result,
      pulls,
      failures,
      truncated: knownLength > boundedMaximum || failures > 0,
    };
  }

  if (boundedMaximum === 0) {
    return { values: result, pulls: 0, failures: 0, truncated: true };
  }

  let iterator: Iterator<unknown> | undefined;
  let pulls = 0;
  let failures = 0;
  let completed = false;
  const close = (): void => {
    try {
      const finish = iterator?.return;
      if (typeof finish === "function") finish.call(iterator);
    } catch {
      // Iterator cleanup cannot expand stylesheet authority.
    }
  };
  try {
    const iteratorMethod = (value as { readonly [Symbol.iterator]?: unknown })[
      Symbol.iterator
    ];
    if (typeof iteratorMethod !== "function") {
      return { values: result, pulls: 0, failures: 1, truncated: true };
    }
    const opened = iteratorMethod.call(value) as unknown;
    if (
      typeof opened !== "object" ||
      opened === null ||
      typeof (opened as { readonly next?: unknown }).next !== "function"
    ) {
      throw new Error("hostile rule list");
    }
    iterator = opened as Iterator<unknown>;
    while (pulls < boundedMaximum) {
      pulls += 1;
      const step = iterator.next();
      if (typeof step !== "object" || step === null) {
        throw new Error("hostile rule list");
      }
      if (step.done === true) {
        completed = true;
        break;
      }
      const item = step.value;
      if (typeof item === "object" && item !== null) {
        result.push(item);
      } else {
        failures += 1;
      }
    }
  } catch {
    failures += 1;
    close();
    return { values: result, pulls, failures, truncated: true };
  }
  const truncated = failures > 0 || (!completed && pulls >= boundedMaximum);
  if (truncated) close();
  return {
    values: result,
    pulls,
    failures,
    truncated,
  }
}

function publicStylesheetUrl(href: string | undefined, scope: StylesheetScope): string | undefined {
  if (!href) return undefined;
  return canonicalizePublicStylesheetUrl(href, {
    baseUrl: safeDocumentLocation(scope),
    maxLength: INSPECT_LIMITS.urlLength,
  });
}

function safeDocumentLocation(scope: StylesheetScope): string | undefined {
  const document = scopeKind(scope) === "document"
    ? scope
    : safeObjectProperty(scope, "ownerDocument");
  if (!document) return undefined;
  const location = safeObjectProperty(document, "location");
  return location ? safeStringProperty(location, "href") : undefined;
}

function safeOwnerNode(sheet: object): object | undefined {
  return safeObjectProperty(sheet, "ownerNode");
}

function snapshotOwnerNode(
  sheet: object,
  snapshots: WeakMap<object, object | undefined>,
): object | undefined {
  if (snapshots.has(sheet)) return snapshots.get(sheet);
  const owner = safeOwnerNode(sheet);
  snapshots.set(sheet, owner);
  return owner;
}

function safeHref(sheet: object): string | undefined {
  return safeStringProperty(sheet, "href");
}

function scopeKind(scope: StylesheetScope): "document" | "shadow-root" {
  return isDocumentScope(scope) ? "document" : "shadow-root";
}

function isDocumentScope(value: object): boolean {
  return safeNumberProperty(value, "nodeType") === 9;
}

function safeRoot(element: Element): StylesheetScope | undefined {
  try {
    const root = element.getRootNode();
    return typeof root === "object" && root !== null
      ? root as StylesheetScope
      : undefined;
  } catch {
    return undefined;
  }
}

function safeQueryAll(
  scope: object,
  selector: string,
  candidateBudget: CandidatePullBudget,
  isExcluded: (candidate: object) => boolean = () => false,
): BoundedObjectScan {
  if (remainingCandidatePulls(candidateBudget) === 0) {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  try {
    const query = (scope as { querySelectorAll?: unknown }).querySelectorAll;
    if (typeof query !== "function") {
      candidateBudget.partial = true;
      return emptyBoundedObjectScan(true, 1);
    }
    return scanCandidateObjects(
      query.call(scope, selector),
      candidateBudget,
      isExcluded,
    );
  } catch {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
}

function scanMutationDescendants(
  scope: object,
  selector: string,
  exclusion: RuntimeArtifactExclusion,
): BoundedObjectScan {
  try {
    const query = (scope as { querySelectorAll?: unknown }).querySelectorAll;
    if (typeof query !== "function") return emptyBoundedObjectScan();
    return scanCandidateObjects(
      query.call(scope, selector),
      { pulls: 0, partial: false, reported: false },
      (candidate) => isRuntimeNode(exclusion, candidate),
    );
  } catch {
    return emptyBoundedObjectScan(true, 1);
  }
}

function classifyStylesheetMutations(
  records: readonly unknown[],
  exclusion: RuntimeArtifactExclusion,
): "stylesheet" | undefined {
  let runtimeExclusionFailed = false;
  const guardedExclusion = withRuntimeExclusionErrorHandler(exclusion, () => {
    runtimeExclusionFailed = true;
  });
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const type = safeStringProperty(record, "type");
    const target = safeObjectProperty(record, "target");
    if (!type || !target) continue;
    if (isRuntimeNode(guardedExclusion, target)) continue;
    if (type === "attributes") {
      const attributeName = safeStringProperty(record, "attributeName") ?? "";
      if (
        ["media", "disabled", "rel", "href", "title"].includes(attributeName) &&
        isStylesheetOwner(target)
      ) {
        return "stylesheet";
      }
      continue;
    }
    if (type === "characterData") {
      const parent = safeObjectProperty(target, "parentElement") ??
        safeObjectProperty(target, "parentNode");
      if (
        parent &&
        !isRuntimeNode(guardedExclusion, parent) &&
        isStylesheetOwner(parent)
      ) return "stylesheet";
      continue;
    }
    if (type === "childList") {
      if (isStylesheetOwner(target)) return "stylesheet";
      for (const key of ["addedNodes", "removedNodes"] as const) {
        const nodes = safeObjectProperty(record, key);
        if (!nodes) continue;
        const bounded = scanCandidateObjects(
          nodes,
          { pulls: 0, partial: false, reported: false },
          (candidate) => isRuntimeNode(guardedExclusion, candidate),
        );
        if (bounded.truncated || bounded.failures > 0) return "stylesheet";
        for (const node of bounded.values) {
          if (containsStylesheetStructure(node, guardedExclusion)) return "stylesheet";
        }
      }
    }
  }
  return runtimeExclusionFailed ? "stylesheet" : undefined;
}

function containsStylesheetStructure(
  node: object,
  exclusion: RuntimeArtifactExclusion,
): boolean {
  if (isRuntimeNode(exclusion, node)) return false;
  if (isStylesheetOwner(node)) return true;
  const tagName = safeTagName(node);
  if (tagName === "IFRAME" || tagName === "FRAME") return true;
  const shadow = safeObjectProperty(node, "shadowRoot");
  if (shadow && safeStringProperty(shadow, "mode") !== "closed") return true;
  const frameDocument = safeObjectProperty(node, "contentDocument");
  if (frameDocument && isDocumentScope(frameDocument)) return true;
  const descendants = scanMutationDescendants(
    node,
    "style,link[rel~='stylesheet'],iframe,frame",
    exclusion,
  );
  return descendants.truncated || descendants.failures > 0 ||
    descendants.values.some((descendant) => (
      containsStylesheetStructure(descendant, exclusion)
    ));
}

function isStylesheetOwner(node: object): boolean {
  const tagName = safeTagName(node);
  return tagName === "STYLE" || tagName === "LINK";
}

function isRuntimeNode(
  exclusion: RuntimeArtifactExclusion,
  node: object,
): boolean {
  const predicate = exclusion.isRuntimeNode;
  if (!predicate) return false;
  try {
    return predicate(node) === true;
  } catch (error) {
    reportRuntimeExclusionError(exclusion, error);
    return true;
  }
}

function isRuntimeStylesheet(
  exclusion: RuntimeArtifactExclusion,
  stylesheet: object,
): boolean {
  const predicate = exclusion.isRuntimeStylesheet;
  if (!predicate) return false;
  try {
    return predicate(stylesheet) === true;
  } catch (error) {
    reportRuntimeExclusionError(exclusion, error);
    return true;
  }
}

function withRuntimeExclusionErrorHandler(
  exclusion: RuntimeArtifactExclusion,
  onError: (error: unknown) => void,
): RuntimeArtifactExclusion {
  return Object.freeze({
    isRuntimeNode: exclusion.isRuntimeNode,
    isRuntimeStylesheet: exclusion.isRuntimeStylesheet,
    onRuntimeArtifactExclusionError(error: unknown): void {
      reportRuntimeExclusionError(exclusion, error);
      onError(error);
    },
  });
}

function reportRuntimeExclusionError(
  exclusion: RuntimeArtifactExclusion,
  error: unknown,
): void {
  try {
    exclusion.onRuntimeArtifactExclusionError?.(error);
  } catch {
    // Runtime-artifact diagnostics cannot change exclusion authority.
  }
}

function readOwnerAttribute(
  owner: object,
  name: string,
  maximumLength: number,
): string | undefined {
  try {
    const getter = (owner as { getAttribute?: unknown }).getAttribute;
    if (typeof getter !== "function") return undefined;
    const value = getter.call(owner, name);
    if (value === null) return "";
    return typeof value === "string" && value.length <= maximumLength
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function readOwnerDisabled(owner: object): boolean | undefined {
  try {
    const disabled = (owner as { readonly disabled?: unknown }).disabled;
    if (typeof disabled !== "boolean") return undefined;
    const checker = (owner as { hasAttribute?: unknown }).hasAttribute;
    if (typeof checker !== "function") return undefined;
    const attribute = checker.call(owner, "disabled");
    return typeof attribute === "boolean"
      ? disabled || attribute
      : undefined;
  } catch {
    return undefined;
  }
}

function safeTagName(owner: object): string {
  return (safeStringProperty(owner, "tagName") ?? "").toUpperCase();
}

function safeObjectProperty(value: object, key: PropertyKey): object | undefined {
  try {
    const candidate = (value as Record<PropertyKey, unknown>)[key];
    return typeof candidate === "object" && candidate !== null
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function safeStringProperty(value: object, key: PropertyKey): string | undefined {
  try {
    const candidate = (value as Record<PropertyKey, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function safeBooleanProperty(value: object, key: PropertyKey): boolean {
  try {
    return (value as Record<PropertyKey, unknown>)[key] === true;
  } catch {
    return false;
  }
}

function safeNumberProperty(value: object, key: PropertyKey): number | undefined {
  try {
    const candidate = (value as Record<PropertyKey, unknown>)[key];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCssValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function digestStructureParts(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function addDiagnostic(
  state: MutableInventory,
  diagnostic: StylesheetRegistryDiagnostic,
): void {
  if (state.diagnostics.length >= STYLESHEET_LIMITS.scopeSheetPairsPerSession) return;
  if (state.diagnostics.some((existing) => (
    existing.code === diagnostic.code &&
    existing.scopeRef === diagnostic.scopeRef &&
    existing.sheetIdentity === diagnostic.sheetIdentity
  ))) return;
  state.diagnostics.push(Object.freeze({ ...diagnostic }));
}

function defaultMutationObserverFactory():
  | StylesheetRegistryOptions["createMutationObserver"]
  | undefined {
  return typeof MutationObserver === "function"
    ? (callback) => new MutationObserver((records) => callback(records))
    : undefined;
}

function requireObject(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function requireRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function sameObjectArray(
  left: readonly object[],
  right: readonly object[],
): boolean {
  return left.length === right.length && left.every((value, index) => (
    value === right[index]
  ));
}
