import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Rule,
} from "postcss";
import selectorParser from "postcss-selector-parser";
import { utf8ByteLength } from "@pin-op/protocol";
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
  readonly generatedRanges: Readonly<Record<string, GeneratedRuleRange>>;
}

export type StylesheetDiagnosticCode =
  | "stylesheet-inaccessible"
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
  readonly now?: () => number;
  readonly createMutationObserver?: (
    callback: (records: readonly unknown[]) => void,
  ) => StylesheetMutationObserver;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
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
    );
    this.inventory = state;
    this.inventoryDirty = false;
    this.inventoryStructureDigest = inventoryStructureDigest(
      this.document,
      (scope) => this.scopeRef(scope),
      (sheet) => this.sheetRef(sheet),
      (owner) => this.ownerRef(owner),
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
        const kind = classifyStylesheetMutations(records);
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
): InventoryState {
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
  const scopes = discoverScopes(document, state, discoveryBudget);
  for (const scope of scopes) {
    const scopeRef = scopeRefFor(scope);
    let sourceOrder = 0;
    const owned = readOwnerSheets(scope, state.candidateBudget);
    recordCandidatePartial(state, scopeRef);
    if (scopeKind(scope) === "shadow-root") {
      for (const { sheet, owner } of owned) {
        sourceOrder = addSheetTree(
          state, scope, scopeRef, sheet, "owner", sourceOrder,
          owner, "", scopeRefFor, sheetRefFor, new Set(),
        );
      }
    }
    const scopeSheets = readScopeStyleSheets(scope, state.candidateBudget);
    recordCandidatePartial(state, scopeRef);
    for (const sheet of scopeSheets.values) {
      const owner = safeOwnerNode(sheet);
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
      );
    }
    if (scopeKind(scope) === "document") {
      for (const { sheet, owner } of owned) {
        sourceOrder = addSheetTree(
          state, scope, scopeRef, sheet, "owner", sourceOrder,
          owner, "", scopeRefFor, sheetRefFor, new Set(),
        );
      }
    }
    const adoptedSheets = readAdoptedSheets(scope, state.candidateBudget);
    recordCandidatePartial(state, scopeRef);
    for (const sheet of adoptedSheets.values) {
      sourceOrder = addSheetTree(
        state, scope, scopeRef, sheet, "adopted", sourceOrder,
        safeOwnerNode(sheet), "", scopeRefFor, sheetRefFor, new Set(),
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
): string {
  const candidateBudget: CandidatePullBudget = {
    pulls: 0,
    partial: false,
    reported: false,
  };
  const discoveryBudget: ScopeDiscoveryBudget = { pulls: 0, partial: false };
  const scopes = discoverScopes(document, undefined, discoveryBudget);
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
    const owned = readOwnerSheets(scope, candidateBudget);
    if (scopeKind(scope) === "shadow-root") {
      append("owner", owned);
    }
    const scopeSheets = readScopeStyleSheets(scope, candidateBudget);
    truncated ||= scopeSheets.truncated;
    append("external", scopeSheets.values.map((sheet) => ({
      sheet,
      ...(safeOwnerNode(sheet) ? { owner: safeOwnerNode(sheet) } : {}),
    })));
    if (scopeKind(scope) === "document") {
      append("owner", owned);
    }
    const adoptedSheets = readAdoptedSheets(scope, candidateBudget);
    truncated ||= adoptedSheets.truncated;
    append("adopted", adoptedSheets.values.map((sheet) => ({
      sheet,
      ...(safeOwnerNode(sheet) ? { owner: safeOwnerNode(sheet) } : {}),
    })));
  }
  parts.push(
    `pairs:${pairCount}`,
    `unique:${uniqueSheets.size}`,
    truncated || candidateBudget.partial || discoveryBudget.partial
      ? "truncated"
      : "complete",
  );
  return digestStructureParts(parts);
}

function discoverScopes(
  document: Document,
  state?: MutableInventory,
  discoveryBudget: ScopeDiscoveryBudget = { pulls: 0, partial: false },
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
      const children = readScopeDiscoveryChildren(parent, discoveryBudget);
      for (const node of children.values) {
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
): number {
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
  const generatedRanges = owner && rulesComplete
    ? inlineRangesForOwner(state, rules, owner, scopeRef, sheetIdentity)
    : Object.freeze({});
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
      ownerState: readStylesheetOwnerState(owner),
    } : {}),
    rulePathPrefix,
    generatedRanges,
  });
  state.entries.push(entry);
  sourceOrder += 1;
  active.add(sheet);
  for (let index = 0; index < rules.length; index += 1) {
    const imported = safeObjectProperty(rules[index]!, "styleSheet");
    if (!imported) continue;
    sourceOrder = addSheetTree(
      state,
      scope,
      scopeRef,
      imported,
      "import",
      sourceOrder,
      safeOwnerNode(imported),
      rulePathPrefix ? `${rulePathPrefix}.${index}` : `${index}`,
      _scopeRefFor,
      sheetRefFor,
      active,
    );
  }
  active.delete(sheet);
  return sourceOrder;
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
): StylesheetOwnerState {
  const rel = readOwnerAttribute(owner, "rel");
  return Object.freeze({
    media: readOwnerAttribute(owner, "media"),
    disabled: safeBooleanProperty(owner, "disabled") || hasOwnerAttribute(owner, "disabled"),
    rel,
    href: readOwnerAttribute(owner, "href"),
    title: readOwnerAttribute(owner, "title"),
    alternate: rel.toLowerCase().split(/\s+/).includes("alternate"),
  });
}

function readOwnerSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
): Array<{
  readonly sheet: object;
  readonly owner: object;
}> {
  const result: Array<{ readonly sheet: object; readonly owner: object }> = [];
  const candidates = safeQueryAll(
    scope,
    "style,link[rel~='stylesheet']",
    candidateBudget,
  );
  for (const owner of candidates.values) {
    if (isPinOpOwned(owner)) continue;
    const sheet = safeObjectProperty(owner, "sheet");
    if (sheet) result.push({ sheet, owner });
  }
  return result;
}

function readScopeStyleSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
): BoundedObjectScan {
  if (remainingCandidatePulls(candidateBudget) === 0) {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  try {
    const sheets = (scope as unknown as { readonly styleSheets?: unknown }).styleSheets;
    return sheets
      ? scanCandidateObjects(sheets, candidateBudget)
      : emptyBoundedObjectScan();
  } catch {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
}

function readAdoptedSheets(
  scope: StylesheetScope,
  candidateBudget: CandidatePullBudget,
): BoundedObjectScan {
  if (remainingCandidatePulls(candidateBudget) === 0) {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true);
  }
  try {
    const sheets = (scope as unknown as { readonly adoptedStyleSheets?: unknown })
      .adoptedStyleSheets;
    return sheets
      ? scanCandidateObjects(sheets, candidateBudget)
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
): BoundedObjectScan {
  const remaining = remainingCandidatePulls(budget);
  const bounded = scanBoundedObjects(value, remaining);
  budget.pulls += bounded.pulls;
  if (bounded.truncated || bounded.failures > 0) budget.partial = true;
  return bounded;
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
  const bounded = scanBoundedObjects(childNodes, remaining);
  budget.pulls += bounded.pulls;
  if (bounded.truncated || bounded.failures > 0) budget.partial = true;
  return bounded;
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
  try {
    const base = safeDocumentLocation(scope);
    const url = new URL(href, base);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(url.href)
    ) {
      return undefined;
    }
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
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
    return scanCandidateObjects(query.call(scope, selector), candidateBudget);
  } catch {
    candidateBudget.partial = true;
    return emptyBoundedObjectScan(true, 1);
  }
}

function safeQueryAllLimited(
  scope: object,
  selector: string,
  maximum: number,
): object[] {
  try {
    const query = (scope as { querySelectorAll?: unknown }).querySelectorAll;
    if (typeof query !== "function") return [];
    return boundedObjectList(query.call(scope, selector), maximum);
  } catch {
    return [];
  }
}

function classifyStylesheetMutations(
  records: readonly unknown[],
): "stylesheet" | undefined {
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const type = safeStringProperty(record, "type");
    const target = safeObjectProperty(record, "target");
    if (!type || !target) continue;
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
      if (parent && isStylesheetOwner(parent)) return "stylesheet";
      continue;
    }
    if (type === "childList") {
      if (isStylesheetOwner(target)) return "stylesheet";
      for (const key of ["addedNodes", "removedNodes"] as const) {
        const nodes = safeObjectProperty(record, key);
        if (!nodes) continue;
        for (const node of boundedObjectList(
          nodes,
          STYLESHEET_LIMITS.scopeSheetPairsPerSession,
        )) {
          if (containsStylesheetStructure(node)) return "stylesheet";
        }
      }
    }
  }
  return undefined;
}

function containsStylesheetStructure(node: object): boolean {
  if (isStylesheetOwner(node)) return true;
  const tagName = safeTagName(node);
  if (tagName === "IFRAME" || tagName === "FRAME") return true;
  const shadow = safeObjectProperty(node, "shadowRoot");
  if (shadow && safeStringProperty(shadow, "mode") !== "closed") return true;
  const frameDocument = safeObjectProperty(node, "contentDocument");
  if (frameDocument && isDocumentScope(frameDocument)) return true;
  return safeQueryAllLimited(
    node,
    "style,link[rel~='stylesheet'],iframe,frame",
    STYLESHEET_LIMITS.scopeSheetPairsPerSession,
  ).some((descendant) => containsStylesheetStructure(descendant));
}

function isStylesheetOwner(node: object): boolean {
  const tagName = safeTagName(node);
  return tagName === "STYLE" || tagName === "LINK";
}

function isPinOpOwned(owner: object): boolean {
  return hasOwnerAttribute(owner, "data-pin-op-runtime-artifact") ||
    hasOwnerAttribute(owner, "data-pin-op-pseudo-preview");
}

function readOwnerAttribute(owner: object, name: string): string {
  try {
    const getter = (owner as { getAttribute?: unknown }).getAttribute;
    if (typeof getter !== "function") return "";
    const value = getter.call(owner, name);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function hasOwnerAttribute(owner: object, name: string): boolean {
  try {
    const checker = (owner as { hasAttribute?: unknown }).hasAttribute;
    return typeof checker === "function" && checker.call(owner, name) === true;
  } catch {
    return false;
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
