import type {
  PseudoState,
  PseudoStateMarkerNames,
} from "./pseudoStateSelector.js";
import { INSPECT_LIMITS } from "@pin-op/protocol";
import {
  DEFAULT_BROWSER_INTRINSICS,
  type BrowserIntrinsicAccess,
} from "./browserIntrinsics.js";

const RANDOM_BYTES_PER_MARKER = 16;
const MAX_OWNED_NODE_ANCESTRY = 64;
const MAX_ADOPTED_STYLESHEETS = INSPECT_LIMITS.stylesheets * 2;
const MAX_EXPECTED_OWN_MUTATIONS = INSPECT_LIMITS.stylesheets * 8 + 16;
const MAX_EXPECTED_MUTATION_NODES = 8;

export interface PinOpRuntimeArtifactsOptions {
  readonly getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  /** Explicit fake-DOM authority for tests; production uses captured intrinsics. */
  readonly testOnlyIntrinsics?: BrowserIntrinsicAccess;
}

export interface PinOpRuntimeCleanupResult {
  readonly complete: boolean;
  readonly failureCount: number;
}

interface OwnedAttribute {
  readonly kind: "state" | "style";
  readonly element: Element;
  readonly name: string;
  readonly attribute: Attr;
}

type ExpectedOwnMutation =
  | {
      readonly kind: "attributes";
      readonly target: Element;
      readonly name: string;
      readonly oldValue: string | null;
    }
  | {
      readonly kind: "childList";
      readonly target: object;
      readonly addedNodes: readonly object[];
      readonly removedNodes: readonly object[];
    };

interface OwnedAdoptedStylesheet {
  readonly root: Document | ShadowRoot;
  readonly sheet: CSSStyleSheet;
  readonly previous: readonly CSSStyleSheet[];
}

interface ExactAdoptedRemovalResult {
  readonly complete: boolean;
  readonly pending?: PendingAdoptedRemoval;
}

interface PendingAdoptedRemoval {
  readonly mode: "cleanup" | "rollback";
  readonly target: readonly CSSStyleSheet[];
  readonly observation: PendingAdoptedRemovalObservation;
}

type PendingAdoptedRemovalObservation =
  | { readonly status: "unattempted" }
  | { readonly status: "unproven" }
  | {
    readonly status: "proven";
    readonly sequence: readonly CSSStyleSheet[];
    readonly retryExact: boolean;
  };

interface ExactStyleNodeNeutralizationResult {
  readonly complete: boolean;
  readonly currentSheet?: CSSStyleSheet;
}

/**
 * Browser-local identity authority for temporary preview artifacts.
 *
 * Historical WeakSets deliberately outlive cleanup so delayed mutation records
 * can still be recognized. Cleanup authority itself is held only by the active
 * exact object records below.
 */
export class PinOpRuntimeArtifacts {
  public readonly markerNames: PseudoStateMarkerNames;
  private readonly sessionToken: string;
  private readonly styleMarkerName: string;
  private readonly historicalNodes = new WeakSet<object>();
  private readonly historicalStylesheets = new WeakSet<object>();
  private readonly historicalMarkerElements = new WeakMap<object, Set<string>>();
  private readonly activeAttributes: OwnedAttribute[] = [];
  private readonly activeStyleNodes = new Set<HTMLStyleElement>();
  private readonly detachedStyleNodes = new WeakSet<HTMLStyleElement>();
  private readonly activeStyleStylesheets = new WeakMap<HTMLStyleElement, CSSStyleSheet>();
  private readonly activeAdoptedStylesheets: OwnedAdoptedStylesheet[] = [];
  private readonly pendingAdoptedRemovalTargets = new WeakMap<
    OwnedAdoptedStylesheet,
    PendingAdoptedRemoval
  >();
  private readonly intrinsics: BrowserIntrinsicAccess;
  private readonly expectedOwnMutations: ExpectedOwnMutation[] = [];
  private expectedOwnMutationsOverflow = false;

  public constructor(options: PinOpRuntimeArtifactsOptions = {}) {
    const random = options.getRandomValues ?? defaultGetRandomValues;
    this.intrinsics = options.testOnlyIntrinsics ?? DEFAULT_BROWSER_INTRINSICS;
    this.markerNames = Object.freeze({
      selection: `data-pin-op-preview-selected-${randomHex(random)}`,
      hover: `data-pin-op-preview-hover-${randomHex(random)}`,
      focus: `data-pin-op-preview-focus-${randomHex(random)}`,
    });
    this.sessionToken = randomHex(random);
    this.styleMarkerName = `data-pin-op-runtime-${this.sessionToken}`;
  }

  public setStateMarkers(
    element: Element,
    states: readonly PseudoState[],
  ): boolean {
    const canonical = canonicalStates(states);
    if (!canonical) return false;
    const previousCleanup = this.cleanupAttributes("state");
    if (!previousCleanup.complete) return false;
    const names = [
      this.markerNames.selection,
      ...canonical.map((state) => this.markerNames[state]),
    ];
    try {
      for (const name of names) {
        if (safeGetAttributeNode(element, name, this.intrinsics) !== null) {
          throw new Error("marker collision");
        }
        const attribute = createMarkerAttribute(element, name, this.intrinsics);
        const record = Object.freeze({ kind: "state" as const, element, name, attribute });
        this.activeAttributes.push(record);
        let inserted = false;
        try {
          const previous = this.intrinsics.call(
            element,
            "element.setAttributeNode",
            [attribute],
          );
          if (previous !== null) throw new Error("marker collision");
          inserted = exactAttributeIsOwned(
            element,
            name,
            attribute,
            this.intrinsics,
          );
          if (!inserted) throw new Error("marker unavailable");
        } finally {
          inserted ||= exactAttributeIsOwned(
            element,
            name,
            attribute,
            this.intrinsics,
          );
          if (inserted) {
            this.recordMarkerHistory(element, name);
            this.recordExpectedAttributeMutation(element, name, null);
          }
        }
      }
      return true;
    } catch {
      this.cleanupAttributes("state");
      return false;
    }
  }

  public registerStyleNode(node: HTMLStyleElement): void {
    this.registerDetachedStyleNode(node);
    this.detachedStyleNodes.delete(node);
    try {
      const sheet = this.intrinsics.read(node, "style.sheet");
      if (isObject(sheet)) {
        this.historicalStylesheets.add(sheet);
        this.activeStyleStylesheets.set(node, sheet as CSSStyleSheet);
      }
    } catch {
      // Node identity remains usable even when its attached sheet is unreadable.
    }
  }

  public registerDetachedStyleNode(node: HTMLStyleElement): void {
    if (!isObject(node)) throw new TypeError("style node must be an object");
    this.historicalNodes.add(node);
    this.activeStyleNodes.add(node);
    this.detachedStyleNodes.add(node);
  }

  public markStyleNode(node: HTMLStyleElement): boolean {
    if (!this.activeStyleNodes.has(node)) return false;
    try {
      if (safeGetAttributeNode(node, this.styleMarkerName, this.intrinsics) !== null) {
        return false;
      }
      const attribute = createMarkerAttribute(
        node,
        this.styleMarkerName,
        this.intrinsics,
      );
      const record = Object.freeze({
        kind: "style" as const,
        element: node,
        name: this.styleMarkerName,
        attribute,
      });
      this.activeAttributes.push(record);
      const previous = this.intrinsics.call(
        node,
        "element.setAttributeNode",
        [attribute],
      );
      if (previous !== null || !exactAttributeIsOwned(
        node,
        this.styleMarkerName,
        attribute,
        this.intrinsics,
      )) return false;
      this.recordMarkerHistory(node, this.styleMarkerName);
      this.recordExpectedAttributeMutation(node, this.styleMarkerName, null);
      return true;
    } catch {
      return false;
    }
  }

  public registerAttachedStyleNodeStylesheet(
    node: HTMLStyleElement,
    sheet: CSSStyleSheet,
  ): boolean {
    if (!this.activeStyleNodes.has(node) || !isObject(sheet)) return false;
    try {
      if (
        this.intrinsics.read(node, "style.sheet") !== sheet ||
        this.intrinsics.read(sheet, "stylesheet.ownerNode") !== node
      ) return false;
      this.historicalStylesheets.add(sheet);
      this.activeStyleStylesheets.set(node, sheet);
      if (this.detachedStyleNodes.delete(node)) {
        const parent = safeParentNode(node, this.intrinsics);
        if (parent) this.recordExpectedChildListMutation(parent, [node], []);
      }
      return true;
    } catch {
      return false;
    }
  }

  public registerAdoptedStylesheet(
    root: Document | ShadowRoot,
    sheet: CSSStyleSheet,
    previous: readonly CSSStyleSheet[],
  ): void {
    if (!isObject(root) || !isObject(sheet)) {
      throw new TypeError("adopted stylesheet ownership requires objects");
    }
    const previousSnapshot = snapshotStylesheetSequence(previous);
    if (!previousSnapshot) {
      throw new RangeError("adopted stylesheet history is unavailable");
    }
    this.historicalStylesheets.add(sheet);
    if (this.activeAdoptedStylesheets.some((record) => (
      record.root === root && record.sheet === sheet
    ))) return;
    this.activeAdoptedStylesheets.push(Object.freeze({
      root,
      sheet,
      previous: previousSnapshot,
    }));
  }

  public ownsAttribute(element: Element, name: string): boolean {
    return this.activeAttributes.some((record) => (
      record.element === element &&
      record.name === name &&
      exactAttributeIsOwned(element, name, record.attribute, this.intrinsics)
    ));
  }

  public isRuntimeAttributeName(name: string): boolean {
    return name === this.styleMarkerName ||
      name === this.markerNames.selection ||
      name === this.markerNames.hover ||
      name === this.markerNames.focus;
  }

  public containsRuntimeMarker(value: string): boolean {
    if (typeof value !== "string" || value.length > INSPECT_LIMITS.valueLength) {
      return true;
    }
    return value.includes(this.styleMarkerName) ||
      value.includes(this.markerNames.selection) ||
      value.includes(this.markerNames.hover) ||
      value.includes(this.markerNames.focus);
  }

  public isRuntimeAttributeMutation(element: Element, name: string): boolean {
    if (!this.isRuntimeAttributeName(name)) return false;
    try {
      return this.historicalMarkerElements.get(element)?.has(name) === true;
    } catch {
      return false;
    }
  }

  /** Consume-once attribution for MutationObserver records caused by this authority. */
  public consumeExpectedOwnMutation(record: unknown): boolean {
    if (this.expectedOwnMutationsOverflow) return false;
    const observed = readObservedMutation(record);
    if (!observed) return false;
    const index = this.expectedOwnMutations.findIndex((expected) => (
      sameExpectedMutation(expected, observed)
    ));
    if (index < 0) return false;
    this.expectedOwnMutations.splice(index, 1);
    return true;
  }

  /** Ends one delivered MutationObserver batch and expires every unmatched expectation. */
  public finishExpectedOwnMutationBatch(): void {
    this.expectedOwnMutations.length = 0;
    this.expectedOwnMutationsOverflow = false;
  }

  public isRuntimeNode(node: Node): boolean {
    if (!isObject(node)) return false;
    let current: object | undefined = node;
    const seen = new Set<object>();
    for (let depth = 0; current && depth < MAX_OWNED_NODE_ANCESTRY; depth += 1) {
      if (this.historicalNodes.has(current)) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = safeParentNode(current, this.intrinsics);
    }
    return false;
  }

  public isRuntimeStylesheet(sheet: object): boolean {
    if (!isObject(sheet)) return false;
    if (this.historicalStylesheets.has(sheet)) return true;
    const owner = this.intrinsics.read(sheet, "stylesheet.ownerNode");
    if (!isObject(owner) || !this.historicalNodes.has(owner)) return false;
    this.historicalStylesheets.add(sheet);
    return true;
  }

  /** Exact prior registration only; unlike isRuntimeStylesheet this does not classify by owner. */
  public hasRuntimeStylesheetIdentity(sheet: object): boolean {
    return isObject(sheet) && this.historicalStylesheets.has(sheet);
  }

  public cleanupStyleNode(node: HTMLStyleElement): boolean {
    if (!this.activeStyleNodes.has(node)) return true;
    try {
      const parentBefore = safeParentNode(node, this.intrinsics);
      if (parentBefore && this.detachedStyleNodes.delete(node)) {
        this.recordExpectedChildListMutation(parentBefore, [node], []);
      }
      const contentBefore = snapshotMutationNodes(
        (node as unknown as { readonly childNodes?: unknown }).childNodes,
      );
      const registeredSheet = this.activeStyleStylesheets.get(node);
      if (!registeredSheet) {
        const currentSheet = this.intrinsics.read(node, "style.sheet");
        if (
          isObject(currentSheet) &&
          this.intrinsics.read(currentSheet, "stylesheet.ownerNode") !== node
        ) {
          if (!detachExactStyleNode(node, this.intrinsics)) return false;
          if (this.intrinsics.read(node, "style.sheet") !== null) return false;
        }
      }
      const neutralized = neutralizeExactStyleNode(
        node,
        registeredSheet,
        this.intrinsics,
      );
      if (!neutralized.complete) return false;
      if (contentBefore && contentBefore.length > 0) {
        this.recordExpectedChildListMutation(node, [], contentBefore);
      }
      if (neutralized.currentSheet) {
        this.historicalStylesheets.add(neutralized.currentSheet);
        this.activeStyleStylesheets.set(node, neutralized.currentSheet);
      } else {
        this.activeStyleStylesheets.delete(node);
      }
      if (!detachExactStyleNode(node, this.intrinsics)) return false;
      if (parentBefore) {
        this.recordExpectedChildListMutation(parentBefore, [], [node]);
      }
      this.activeStyleNodes.delete(node);
      this.detachedStyleNodes.delete(node);
      this.activeStyleStylesheets.delete(node);
      return true;
    } catch {
      return false;
    }
  }

  public cleanupAdoptedStylesheet(
    root: Document | ShadowRoot,
    sheet: CSSStyleSheet,
  ): boolean {
    const index = this.activeAdoptedStylesheets.findIndex((record) => (
      record.root === root && record.sheet === sheet
    ));
    if (index < 0) return true;
    const record = this.activeAdoptedStylesheets[index]!;
    if (!neutralizeExactStylesheet(sheet, this.intrinsics)) return false;
    const removed = removeExactAdoptedStylesheet(
      root,
      sheet,
      this.pendingAdoptedRemovalTargets.get(record),
      this.intrinsics,
    );
    if (!removed.complete) {
      if (removed.pending) {
        this.pendingAdoptedRemovalTargets.set(record, removed.pending);
      }
      return false;
    }
    this.pendingAdoptedRemovalTargets.delete(record);
    this.activeAdoptedStylesheets.splice(index, 1);
    return true;
  }

  /**
   * Rolls a failed adopted-sheet transaction back to its exact pre-write list.
   * The target remains attached to the exact ownership record until a later
   * cleanup proves that exact sequence, so a lossy setter cannot be mistaken
   * for a successful rollback.
   */
  public rollbackAdoptedStylesheet(
    root: Document | ShadowRoot,
    sheet: CSSStyleSheet,
    baseline: readonly CSSStyleSheet[],
  ): boolean {
    const index = this.activeAdoptedStylesheets.findIndex((record) => (
      record.root === root && record.sheet === sheet
    ));
    if (index < 0) return false;
    const target = snapshotStylesheetSequence(baseline);
    if (!target || target.includes(sheet)) return false;
    const record = this.activeAdoptedStylesheets[index]!;
    const retained = this.pendingAdoptedRemovalTargets.get(record);
    if (
      retained &&
      (
        retained.mode !== "rollback" ||
        !sameStylesheetSequence(retained.target, target)
      )
    ) return false;
    const pending = retained ?? Object.freeze({
      mode: "rollback" as const,
      target,
      observation: Object.freeze({ status: "unattempted" as const }),
    });
    this.pendingAdoptedRemovalTargets.set(record, pending);
    if (!neutralizeExactStylesheet(sheet, this.intrinsics)) return false;
    const removed = removeExactAdoptedStylesheet(
      root,
      sheet,
      pending,
      this.intrinsics,
    );
    if (!removed.complete) {
      if (removed.pending) {
        this.pendingAdoptedRemovalTargets.set(record, removed.pending);
      }
      return false;
    }
    this.pendingAdoptedRemovalTargets.delete(record);
    this.activeAdoptedStylesheets.splice(index, 1);
    return true;
  }

  public cleanup(): PinOpRuntimeCleanupResult {
    let failureCount = 0;
    failureCount += this.cleanupAttributes().failureCount;
    failureCount += this.cleanupStyleNodes();
    failureCount += this.cleanupAdoptedStylesheets();
    return Object.freeze({ complete: failureCount === 0, failureCount });
  }

  private cleanupAttributes(kind?: OwnedAttribute["kind"]): PinOpRuntimeCleanupResult {
    let failureCount = 0;
    const records = this.activeAttributes.splice(0);
    const retained: OwnedAttribute[] = [];
    for (const record of records) {
      if (kind !== undefined && record.kind !== kind) {
        retained.push(record);
        continue;
      }
      let location = exactAttributeLocation(
        record.name,
        record.attribute,
        this.intrinsics,
      );
      if (location.status === "owned") {
        const mutationTarget = location.owner;
        const oldValue = readAttributeValue(record.attribute, this.intrinsics);
        this.recordMarkerHistory(location.owner, record.name);
        try {
          this.intrinsics.call(
            location.owner,
            "element.removeAttributeNode",
            [record.attribute],
          );
        } catch {
          // Verify the exact Attr again; a throwing method can still mutate first.
        }
        location = exactAttributeLocation(
          record.name,
          record.attribute,
          this.intrinsics,
        );
        if (location.status === "absent" && oldValue !== undefined) {
          this.recordExpectedAttributeMutation(
            mutationTarget,
            record.name,
            oldValue,
          );
        }
      }
      if (location.status === "owned" || location.status === "unknown") {
        failureCount += 1;
        retained.push(record);
      }
    }
    this.activeAttributes.push(...retained);
    return Object.freeze({ complete: failureCount === 0, failureCount });
  }

  private cleanupStyleNodes(): number {
    let failures = 0;
    for (const node of [...this.activeStyleNodes]) {
      if (!this.cleanupStyleNode(node)) failures += 1;
    }
    return failures;
  }

  private cleanupAdoptedStylesheets(): number {
    let failures = 0;
    const retained: OwnedAdoptedStylesheet[] = [];
    for (const record of [...this.activeAdoptedStylesheets]) {
      if (neutralizeExactStylesheet(record.sheet, this.intrinsics)) {
        const removed = removeExactAdoptedStylesheet(
          record.root,
          record.sheet,
          this.pendingAdoptedRemovalTargets.get(record),
          this.intrinsics,
        );
        if (removed.complete) {
          this.pendingAdoptedRemovalTargets.delete(record);
          continue;
        }
        if (removed.pending) {
          this.pendingAdoptedRemovalTargets.set(record, removed.pending);
        }
      }
      failures += 1;
      retained.push(record);
    }
    this.activeAdoptedStylesheets.length = 0;
    this.activeAdoptedStylesheets.push(...retained);
    return failures;
  }

  private recordMarkerHistory(element: Element, name: string): void {
    const names = this.historicalMarkerElements.get(element) ?? new Set<string>();
    names.add(name);
    this.historicalMarkerElements.set(element, names);
  }

  private recordExpectedAttributeMutation(
    target: Element,
    name: string,
    oldValue: string | null,
  ): void {
    if (!safeParentNode(target, this.intrinsics)) return;
    this.recordExpectedOwnMutation(Object.freeze({
      kind: "attributes",
      target,
      name,
      oldValue,
    }));
  }

  private recordExpectedChildListMutation(
    target: object,
    addedNodes: readonly object[],
    removedNodes: readonly object[],
  ): void {
    this.recordExpectedOwnMutation(Object.freeze({
      kind: "childList",
      target,
      addedNodes: Object.freeze([...addedNodes]),
      removedNodes: Object.freeze([...removedNodes]),
    }));
  }

  private recordExpectedOwnMutation(expected: ExpectedOwnMutation): void {
    if (
      this.expectedOwnMutationsOverflow ||
      this.expectedOwnMutations.length >= MAX_EXPECTED_OWN_MUTATIONS
    ) {
      this.expectedOwnMutations.length = 0;
      this.expectedOwnMutationsOverflow = true;
      return;
    }
    this.expectedOwnMutations.push(expected);
  }
}

function readObservedMutation(record: unknown): ExpectedOwnMutation | undefined {
  if (!isObject(record) || Array.isArray(record)) return undefined;
  try {
    const candidate = record as {
      readonly type?: unknown;
      readonly target?: unknown;
      readonly attributeName?: unknown;
      readonly oldValue?: unknown;
      readonly addedNodes?: unknown;
      readonly removedNodes?: unknown;
    };
    if (candidate.type === "attributes") {
      if (
        !isObject(candidate.target) ||
        typeof candidate.attributeName !== "string" ||
        (candidate.oldValue !== null && typeof candidate.oldValue !== "string")
      ) return undefined;
      return Object.freeze({
        kind: "attributes",
        target: candidate.target as Element,
        name: candidate.attributeName,
        oldValue: candidate.oldValue,
      });
    }
    if (candidate.type !== "childList" || !isObject(candidate.target)) {
      return undefined;
    }
    const addedNodes = snapshotMutationNodes(candidate.addedNodes);
    const removedNodes = snapshotMutationNodes(candidate.removedNodes);
    if (!addedNodes || !removedNodes || addedNodes.length + removedNodes.length === 0) {
      return undefined;
    }
    return Object.freeze({
      kind: "childList",
      target: candidate.target,
      addedNodes,
      removedNodes,
    });
  } catch {
    return undefined;
  }
}

function sameExpectedMutation(
  expected: ExpectedOwnMutation,
  observed: ExpectedOwnMutation,
): boolean {
  if (expected.kind !== observed.kind || expected.target !== observed.target) {
    return false;
  }
  if (expected.kind === "attributes" && observed.kind === "attributes") {
    return expected.name === observed.name && expected.oldValue === observed.oldValue;
  }
  return expected.kind === "childList" && observed.kind === "childList" &&
    sameObjectSequence(expected.addedNodes, observed.addedNodes) &&
    sameObjectSequence(expected.removedNodes, observed.removedNodes);
}

function sameObjectSequence(left: readonly object[], right: readonly object[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function snapshotMutationNodes(value: unknown): readonly object[] | undefined {
  if (!isObject(value)) return undefined;
  try {
    const length = (value as { readonly length?: unknown }).length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_EXPECTED_MUTATION_NODES
    ) return undefined;
    const nodes: object[] = [];
    for (let index = 0; index < length; index += 1) {
      const node = (value as ArrayLike<unknown>)[index];
      if (!isObject(node)) return undefined;
      nodes.push(node);
    }
    return Object.freeze(nodes);
  } catch {
    return undefined;
  }
}

function readAttributeValue(
  attribute: Attr,
  intrinsics: BrowserIntrinsicAccess,
): string | undefined {
  try {
    const value = intrinsics.read(attribute, "attr.value");
    return typeof value === "string" && value.length <= INSPECT_LIMITS.valueLength
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function neutralizeExactStylesheet(
  sheet: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  try {
    const rules = intrinsics.read(sheet, "stylesheet.cssRules");
    if (!isObject(rules)) return false;
    const length = intrinsics.read(rules, "ruleList.length");
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return false;
    }
    if (length === 0) return true;
    intrinsics.call(sheet, "stylesheet.replaceSync", [""]);
    return exactStylesheetIsEmpty(sheet, intrinsics);
  } catch {
    return false;
  }
}

function neutralizeExactStyleNode(
  node: HTMLStyleElement,
  ownedSheet: CSSStyleSheet | undefined,
  intrinsics: BrowserIntrinsicAccess,
): ExactStyleNodeNeutralizationResult {
  try {
    intrinsics.call(node, "set:node.textContent", [""]);
    if (intrinsics.read(node, "node.textContent") !== "") {
      return Object.freeze({ complete: false });
    }

    const currentSheet = intrinsics.read(node, "style.sheet");
    if (currentSheet === null) {
      if (
        ownedSheet &&
        intrinsics.read(ownedSheet, "stylesheet.ownerNode") !== null
      ) return Object.freeze({ complete: false });
      return Object.freeze({ complete: true });
    }
    if (!isObject(currentSheet)) return Object.freeze({ complete: false });
    if (
      intrinsics.read(currentSheet, "stylesheet.ownerNode") !== node
    ) return Object.freeze({ complete: false });

    if (currentSheet !== ownedSheet && ownedSheet) {
      if (
        intrinsics.read(ownedSheet, "stylesheet.ownerNode") !== null ||
        !exactStylesheetIsEmpty(currentSheet as CSSStyleSheet, intrinsics)
      ) return Object.freeze({ complete: false });
    } else if (!neutralizeExactStylesheet(
      currentSheet as CSSStyleSheet,
      intrinsics,
    )) {
      return Object.freeze({ complete: false });
    }

    return Object.freeze({ complete: true, currentSheet: currentSheet as CSSStyleSheet });
  } catch {
    return Object.freeze({ complete: false });
  }
}

function exactStylesheetIsEmpty(
  sheet: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  try {
    const rules = intrinsics.read(sheet, "stylesheet.cssRules");
    if (!isObject(rules)) return false;
    const length = intrinsics.read(rules, "ruleList.length");
    return typeof length === "number" && Number.isSafeInteger(length) && length === 0;
  } catch {
    return false;
  }
}

function canonicalStates(states: readonly PseudoState[]): readonly PseudoState[] | undefined {
  try {
    if (!Array.isArray(states)) return undefined;
    const length = states.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 2) return undefined;
    const values = new Set<PseudoState>();
    for (let index = 0; index < length; index += 1) {
      const state = states[index];
      if (state !== "hover" && state !== "focus") return undefined;
      values.add(state);
    }
    return Object.freeze([
      ...(values.has("hover") ? ["hover" as const] : []),
      ...(values.has("focus") ? ["focus" as const] : []),
    ]);
  } catch {
    return undefined;
  }
}

function randomHex(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = new Uint8Array(RANDOM_BYTES_PER_MARKER);
  let filled: Uint8Array;
  try {
    filled = random(bytes);
  } catch {
    throw new Error("cryptographic randomness is unavailable");
  }
  if (filled !== bytes || filled.length !== RANDOM_BYTES_PER_MARKER) {
    throw new Error("cryptographic randomness is unavailable");
  }
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function defaultGetRandomValues(bytes: Uint8Array): Uint8Array {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("cryptographic randomness is unavailable");
  }
  return crypto.getRandomValues(bytes);
}

function removeExactAdoptedStylesheet(
  root: Document | ShadowRoot,
  sheet: CSSStyleSheet,
  retained?: PendingAdoptedRemoval,
  intrinsics: BrowserIntrinsicAccess = DEFAULT_BROWSER_INTRINSICS,
): ExactAdoptedRemovalResult {
  const current = snapshotAdoptedStylesheets(root, intrinsics);
  if (!current) {
    const pending = retained?.observation.status === "unattempted"
      ? pendingAdoptedRemoval(
        retained.mode,
        retained.target,
        Object.freeze({ status: "unproven" }),
      )
      : retained;
    return Object.freeze({ complete: false, pending });
  }

  if (retained && sameStylesheetSequence(current, retained.target)) {
    return Object.freeze({ complete: true });
  }

  let expected: readonly CSSStyleSheet[];
  let mode: PendingAdoptedRemoval["mode"];
  if (
    retained?.mode === "cleanup" &&
    retained.observation.status === "proven" &&
    retained.observation.retryExact &&
    sameStylesheetSequence(current, retained.observation.sequence)
  ) {
    expected = retained.target;
    mode = "cleanup";
  } else if (retained?.mode === "rollback") {
    if (
      retained.observation.status === "unproven" ||
      (
        retained.observation.status === "proven" &&
        (
          !retained.observation.retryExact ||
          !sameStylesheetSequence(current, retained.observation.sequence)
        )
      ) ||
      (
        retained.observation.status === "unattempted" &&
        hasUnexpectedStylesheetOccurrences(current, retained.target, sheet)
      )
    ) {
      const pending = retained.observation.status === "unattempted"
        ? pendingAdoptedRemoval(
          "rollback",
          retained.target,
          Object.freeze({
            status: "proven",
            sequence: current,
            retryExact: false,
          }),
        )
        : retained;
      return Object.freeze({ complete: false, pending });
    }
    expected = retained.target;
    mode = "rollback";
  } else {
    if (!current.includes(sheet)) return Object.freeze({ complete: true });
    expected = Object.freeze(current.filter((candidate) => candidate !== sheet));
    mode = "cleanup";
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      intrinsics.call(root, "set:root.adoptedStyleSheets", [[...expected]]);
    } catch {
      // A throwing setter can still apply the exact target before throwing.
    }
    const after = snapshotAdoptedStylesheets(root, intrinsics);
    if (!after) {
      return Object.freeze({
        complete: false,
        pending: pendingAdoptedRemoval(
          mode,
          expected,
          Object.freeze({ status: "unproven" }),
        ),
      });
    }
    if (after && sameStylesheetSequence(after, expected)) {
      return Object.freeze({ complete: true });
    }
    if (hasUnexpectedStylesheetOccurrences(after, expected, sheet)) {
      if (mode === "rollback") {
        return Object.freeze({
          complete: false,
          pending: pendingAdoptedRemoval(
            mode,
            expected,
            Object.freeze({
              status: "proven",
              sequence: after,
              retryExact: false,
            }),
          ),
        });
      }
      const revised = Object.freeze(after.filter((candidate) => candidate !== sheet));
      if (sameStylesheetSequence(after, revised)) {
        return Object.freeze({ complete: true });
      }
      expected = revised;
    }
    if (attempt === 1) {
      return Object.freeze({
        complete: false,
        pending: pendingAdoptedRemoval(
          mode,
          expected,
          Object.freeze({
            status: "proven",
            sequence: after,
            retryExact: true,
          }),
        ),
      });
    }
  }
  return Object.freeze({ complete: false });
}

function pendingAdoptedRemoval(
  mode: PendingAdoptedRemoval["mode"],
  target: readonly CSSStyleSheet[],
  observation: PendingAdoptedRemovalObservation,
): PendingAdoptedRemoval {
  return Object.freeze({ mode, target, observation });
}

function hasUnexpectedStylesheetOccurrences(
  actual: readonly CSSStyleSheet[],
  expected: readonly CSSStyleSheet[],
  ignored: CSSStyleSheet,
): boolean {
  const remaining = new Map<CSSStyleSheet, number>();
  for (const sheet of expected) {
    remaining.set(sheet, (remaining.get(sheet) ?? 0) + 1);
  }
  for (const sheet of actual) {
    if (sheet === ignored) continue;
    const count = remaining.get(sheet) ?? 0;
    if (count === 0) return true;
    remaining.set(sheet, count - 1);
  }
  return false;
}

function sameStylesheetSequence(
  left: readonly CSSStyleSheet[],
  right: readonly CSSStyleSheet[],
): boolean {
  return left.length === right.length && left.every((sheet, index) => (
    sheet === right[index]
  ));
}

function snapshotAdoptedStylesheets(
  root: Document | ShadowRoot,
  intrinsics: BrowserIntrinsicAccess,
): readonly CSSStyleSheet[] | undefined {
  try {
    const value = intrinsics.read(root, "root.adoptedStyleSheets");
    return isObject(value)
      ? snapshotStylesheetSequence(value as readonly CSSStyleSheet[])
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotStylesheetSequence(
  value: readonly CSSStyleSheet[],
): readonly CSSStyleSheet[] | undefined {
  try {
    const source = value as unknown as ArrayLike<unknown> | Iterable<unknown>;
    const rawLength = (source as { readonly length?: unknown }).length;
    const result: CSSStyleSheet[] = [];
    if (rawLength !== undefined) {
      if (
        typeof rawLength !== "number" ||
        !Number.isSafeInteger(rawLength) ||
        rawLength < 0 ||
        rawLength > MAX_ADOPTED_STYLESHEETS
      ) return undefined;
      for (let index = 0; index < rawLength; index += 1) {
        const value = (source as ArrayLike<unknown>)[index];
        if (!isObject(value)) return undefined;
        result.push(value as CSSStyleSheet);
      }
      return Object.freeze(result);
    }
    const iteratorFactory = (source as Partial<Iterable<unknown>>)[Symbol.iterator];
    if (typeof iteratorFactory !== "function") return undefined;
    const iterator = iteratorFactory.call(source) as Iterator<unknown>;
    for (let pulls = 0; pulls <= MAX_ADOPTED_STYLESHEETS; pulls += 1) {
      const next = iterator.next();
      if (!isObject(next) || typeof next.done !== "boolean") return undefined;
      if (next.done) return Object.freeze(result);
      if (!isObject(next.value) || result.length >= MAX_ADOPTED_STYLESHEETS) {
        return undefined;
      }
      result.push(next.value as CSSStyleSheet);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeGetAttributeNode(
  element: Element,
  name: string,
  intrinsics: BrowserIntrinsicAccess,
): Attr | null | undefined {
  try {
    const value = intrinsics.call(element, "element.getAttributeNode", [name]);
    return value === null || isObject(value) ? value as Attr | null : undefined;
  } catch {
    return undefined;
  }
}

function createMarkerAttribute(
  element: Element,
  name: string,
  intrinsics: BrowserIntrinsicAccess,
): Attr {
  const document = intrinsics.read(element, "node.ownerDocument");
  if (!isObject(document)) {
    throw new Error("marker attribute creation unavailable");
  }
  const attribute = intrinsics.call(document, "document.createAttribute", [name]);
  if (
    !isObject(attribute) ||
    intrinsics.read(attribute, "attr.name") !== name ||
    intrinsics.read(attribute, "attr.ownerElement") !== null
  ) {
    throw new Error("marker attribute creation failed");
  }
  intrinsics.call(attribute, "set:attr.value", [""]);
  if (intrinsics.read(attribute, "attr.value") !== "") {
    throw new Error("marker attribute creation failed");
  }
  return attribute as Attr;
}

function exactAttributeIsOwned(
  element: Element,
  name: string,
  attribute: Attr,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  try {
    if (intrinsics.read(attribute, "attr.ownerElement") === element) return true;
  } catch {
    // Fall through to the exact attribute lookup.
  }
  return safeGetAttributeNode(element, name, intrinsics) === attribute;
}

function exactAttributeLocation(
  name: string,
  attribute: Attr,
  intrinsics: BrowserIntrinsicAccess,
):
  | { readonly status: "owned"; readonly owner: Element }
  | { readonly status: "absent" | "unknown" } {
  let owner: Element | null;
  try {
    owner = intrinsics.read(attribute, "attr.ownerElement") as Element | null;
  } catch {
    return Object.freeze({ status: "unknown" });
  }
  if (owner === null) return Object.freeze({ status: "absent" });
  if (!isObject(owner)) return Object.freeze({ status: "unknown" });
  try {
    return intrinsics.call(owner, "element.getAttributeNode", [name]) === attribute
      ? Object.freeze({ status: "owned", owner })
      : Object.freeze({ status: "unknown" });
  } catch {
    return Object.freeze({ status: "unknown" });
  }
}

function safeParentNode(
  node: object,
  intrinsics: BrowserIntrinsicAccess,
): object | undefined {
  const result = readParentNode(node, intrinsics);
  return result.readable ? result.parent : undefined;
}

function readParentNode(
  node: object,
  intrinsics: BrowserIntrinsicAccess,
): {
  readonly readable: boolean;
  readonly parent?: object;
} {
  try {
    const parent = intrinsics.read(node, "node.parentNode");
    return Object.freeze({
      readable: true,
      ...(isObject(parent) ? { parent } : {}),
    });
  } catch {
    return Object.freeze({ readable: false });
  }
}

function detachExactStyleNode(
  node: HTMLStyleElement,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  const before = readParentNode(node, intrinsics);
  if (!before.readable) return false;
  if (before.parent) {
    try {
      intrinsics.call(before.parent, "node.removeChild", [node]);
    } catch {
      // A throwing native call may still detach the exact node first.
    }
  }
  const after = readParentNode(node, intrinsics);
  return after.readable && !after.parent;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
