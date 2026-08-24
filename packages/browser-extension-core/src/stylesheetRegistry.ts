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
  private scopeReferences = new WeakMap<object, string>();
  private sheetReferences = new WeakMap<object, string>();
  private nextScopeReference = 0;
  private nextSheetReference = 0;
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
    this.nextScopeReference = 0;
    this.nextSheetReference = 0;
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

  private installMutationObserver(scopes: readonly StylesheetScope[]): void {
    this.disconnectMutationObserver();
    const create = this.options.createMutationObserver ??
      defaultMutationObserverFactory();
    if (!create) return;
    let observer: StylesheetMutationObserver | undefined;
    try {
      observer = create(() => {
        if (this.disposed) return;
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
  };
  const scopes = discoverScopes(document, state);
  for (const scope of scopes) {
    const scopeRef = scopeRefFor(scope);
    let sourceOrder = 0;
    const owned = readOwnerSheets(scope);
    if (scopeKind(scope) === "shadow-root") {
      for (const { sheet, owner } of owned) {
        sourceOrder = addSheetTree(
          state, scope, scopeRef, sheet, "owner", sourceOrder,
          owner, "", scopeRefFor, sheetRefFor, new Set(),
        );
      }
    }
    for (const sheet of readScopeStyleSheets(scope)) {
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
    for (const sheet of readAdoptedSheets(scope)) {
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

function discoverScopes(document: Document, state: MutableInventory): StylesheetScope[] {
  const queue: StylesheetScope[] = [document];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const scope = queue.shift()!;
    if (seen.has(scope)) continue;
    if (state.scopes.length >= STYLESHEET_LIMITS.scopesPerSession) {
      state.omittedScopeCount += 1 + queue.length;
      addDiagnostic(state, { code: "scope-limit" });
      break;
    }
    seen.add(scope);
    state.scopes.push(scope);
    for (const node of safeQueryAll(scope, "*")) {
      const shadow = safeObjectProperty(node, "shadowRoot");
      if (shadow && safeStringProperty(shadow, "mode") !== "closed") {
        queue.push(shadow as unknown as ShadowRoot);
      }
      const frameDocument = safeObjectProperty(node, "contentDocument");
      if (frameDocument && isDocumentScope(frameDocument)) {
        queue.push(frameDocument as unknown as Document);
      }
    }
  }
  return state.scopes;
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
  const generatedRanges = owner
    ? inlineRangesForOwner(state, sheet, owner, scopeRef, sheetIdentity)
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

  let rules: readonly object[];
  try {
    const remaining = Math.max(
      0,
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - state.rulesVisited,
    );
    const bounded = readCssRulesBounded(sheet, remaining);
    rules = bounded.rules;
    state.rulesVisited += rules.length;
    if (bounded.truncated) {
      addDiagnostic(state, {
        code: "rules-visited-limit",
        scopeRef,
        sheetIdentity,
      });
    }
  } catch {
    state.inaccessibleStylesheetCount += 1;
    addDiagnostic(state, {
      code: "stylesheet-inaccessible",
      scopeRef,
      sheetIdentity,
    });
    return sourceOrder;
  }
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
  sheet: object,
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
  let cssomRules: readonly object[];
  try {
    cssomRules = readCssRules(sheet);
  } catch {
    return Object.freeze({});
  }
  const ranges: Record<string, GeneratedRuleRange> = {};
  if (!correlateRuleLists(cssomRules, significantNodes(ast), "", ranges)) {
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
  cssom: readonly object[],
  ast: readonly ChildNode[],
  parentPath: string,
  ranges: Record<string, GeneratedRuleRange>,
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
      const nested = safeOptionalCssRules(nativeRule);
      if (nested === undefined || node.type !== "atrule") return false;
      if (!sameGroup(nativeRule, node)) return false;
      if (!correlateRuleLists(nested, significantNodes(node), path, ranges)) {
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
  const header = (safeStringProperty(nativeRule, "cssText") ?? "")
    .split("{")[0]!
    .trim()
    .toLowerCase();
  const expectedName = node.name.toLowerCase();
  if (header && !header.startsWith(`@${expectedName}`)) return false;
  const nativeCondition = safeStringProperty(nativeRule, "conditionText") ??
    safeNestedString(nativeRule, "media", "mediaText") ?? "";
  return !nativeCondition || normalizeCssValue(nativeCondition) ===
    normalizeCssValue(node.params);
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

function readOwnerSheets(scope: StylesheetScope): Array<{
  readonly sheet: object;
  readonly owner: object;
}> {
  const result: Array<{ readonly sheet: object; readonly owner: object }> = [];
  for (const owner of safeQueryAll(scope, "style,link[rel~='stylesheet']")) {
    if (isPinOpOwned(owner)) continue;
    const sheet = safeObjectProperty(owner, "sheet");
    if (sheet) result.push({ sheet, owner });
  }
  return result;
}

function readScopeStyleSheets(scope: StylesheetScope): object[] {
  try {
    const sheets = (scope as unknown as { readonly styleSheets?: unknown }).styleSheets;
    return sheets ? boundedObjectList(sheets) : [];
  } catch {
    return [];
  }
}

function readAdoptedSheets(scope: StylesheetScope): object[] {
  try {
    const sheets = (scope as unknown as { readonly adoptedStyleSheets?: unknown })
      .adoptedStyleSheets;
    return sheets ? boundedObjectList(sheets) : [];
  } catch {
    return [];
  }
}

function readCssRules(sheet: object): object[] {
  const rules = (sheet as { readonly cssRules?: unknown }).cssRules;
  if (!rules || (typeof rules !== "object" && typeof rules !== "function")) {
    throw new Error("cssRules unavailable");
  }
  return boundedObjectList(rules);
}

function readCssRulesBounded(
  sheet: object,
  maximum: number,
): { readonly rules: readonly object[]; readonly truncated: boolean } {
  const raw = (sheet as { readonly cssRules?: unknown }).cssRules;
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules unavailable");
  }
  const knownLength = safeNumberProperty(Object(raw), "length");
  const rules = boundedObjectList(raw, maximum);
  return {
    rules,
    truncated: knownLength !== undefined
      ? knownLength > maximum
      : maximum === 0 || rules.length === maximum,
  };
}

function safeOptionalCssRules(rule: object): object[] | undefined {
  try {
    if (!("cssRules" in rule)) return undefined;
    return readCssRules(rule);
  } catch {
    return undefined;
  }
}

function boundedObjectList(
  value: unknown,
  maximum = STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot + 1,
): object[] {
  const result: object[] = [];
  if (maximum <= 0) return result;
  if (
    typeof value === "object" && value !== null &&
    Symbol.iterator in value
  ) {
    try {
      for (const item of value as Iterable<unknown>) {
        if (typeof item === "object" && item !== null) result.push(item);
        if (result.length >= maximum) break;
      }
      return result;
    } catch {
      throw new Error("hostile rule list");
    }
  }
  const length = Math.min(safeNumberProperty(Object(value), "length") ?? 0, maximum);
  for (let index = 0; index < length; index += 1) {
    try {
      const item = (value as ArrayLike<unknown>)[index];
      if (typeof item === "object" && item !== null) result.push(item);
    } catch {
      continue;
    }
  }
  return result;
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

function safeQueryAll(scope: object, selector: string): object[] {
  try {
    const query = (scope as { querySelectorAll?: unknown }).querySelectorAll;
    if (typeof query !== "function") return [];
    return boundedObjectList(query.call(scope, selector));
  } catch {
    return [];
  }
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

function safeNestedString(
  value: object,
  key: PropertyKey,
  nestedKey: PropertyKey,
): string | undefined {
  const nested = safeObjectProperty(value, key);
  return nested ? safeStringProperty(nested, nestedKey) : undefined;
}

function normalizeCssValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
