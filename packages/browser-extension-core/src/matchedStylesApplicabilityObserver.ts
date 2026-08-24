import selectorParser from "postcss-selector-parser";

export const APPLICABILITY_LIMITS = Object.freeze({
  candidatesPerPass: 4096,
  composedAncestors: 32,
  selectorsPerRule: 256,
});

export type ApplicabilityContextKind =
  | "media"
  | "supports"
  | "layer"
  | "scope"
  | "container"
  | "starting-style"
  | "unknown";

export interface ApplicabilityContext {
  readonly kind: ApplicabilityContextKind;
  readonly text: string;
}

export interface ApplicabilityCandidate {
  readonly key: string;
  readonly scope: Document | ShadowRoot;
  readonly selectorText: string;
  readonly contexts: readonly ApplicabilityContext[];
}

export type GroupApplicability = "active" | "inactive" | "unknown";

export interface ApplicabilityMatch {
  readonly candidateKey: string;
  readonly ancestorIndex: number;
  readonly matchingSelectorIndices: readonly number[];
  readonly groupApplicability: readonly GroupApplicability[];
}

export interface ApplicabilityCheckResult {
  readonly digest: string;
  readonly changed: boolean;
  readonly partial: boolean;
  readonly candidatesVisited: number;
  readonly ancestorsVisited: number;
  readonly nextCursor: number;
  readonly matches: readonly ApplicabilityMatch[];
}

export interface ApplicabilityInvalidationEvent {
  readonly reason:
    | "applicability-change"
    | "observable-signal"
    | "manual-refresh";
}

export interface ApplicabilityMutationObserver {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

export interface MatchedStylesApplicabilityObserverOptions {
  readonly document: Document;
  readonly onInvalidated: (event: ApplicabilityInvalidationEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly queueMicrotask?: (callback: () => void) => void;
  readonly createMutationObserver?: (
    callback: (records: readonly unknown[]) => void,
  ) => ApplicabilityMutationObserver;
}

interface MediaRegistration {
  readonly list: MediaQueryList;
  readonly listener: EventListener;
}

interface StoredApplicabilityCandidate extends ApplicabilityCandidate {
  readonly inputTruncated: boolean;
}

interface BoundedAncestors {
  readonly values: readonly Element[];
  readonly truncated: boolean;
}

interface ParsedSelectorList {
  readonly selectors: readonly string[];
  readonly truncated: boolean;
}

const CANDIDATES_PER_SELECTION = 65_536;
const CONTEXTS_PER_CANDIDATE = 32;
const CANDIDATE_KEY_LENGTH = 256;
const SELECTOR_TEXT_LENGTH = 16_384;
const CONTEXT_TEXT_LENGTH = 4096;

/** Observes events only; it never dispatches page input/focus events. */
export class MatchedStylesApplicabilityObserver {
  private selected: Element | undefined;
  private candidates: readonly StoredApplicabilityCandidate[] = Object.freeze([]);
  private candidatesTruncated = false;
  private cursor = 0;
  private disposed = false;
  private pendingSignal = false;
  private signalGeneration = 0;
  private readonly windows = new Map<number, string>();
  private readonly eventRegistrations: Array<{
    readonly target: EventTarget;
    readonly type: string;
    readonly listener: EventListener;
    readonly capture: boolean;
  }> = [];
  private readonly media = new Map<
    Document | ShadowRoot,
    Map<string, MediaRegistration>
  >();
  private mutationObserver: ApplicabilityMutationObserver | undefined;
  private suppressInvalidation = 0;
  private readonly enqueue: (callback: () => void) => void;

  public constructor(
    private readonly options: MatchedStylesApplicabilityObserverOptions,
  ) {
    requireObject(options.document, "document");
    this.enqueue = options.queueMicrotask ?? globalThis.queueMicrotask.bind(globalThis);
  }

  public setSelection(
    element: Element | undefined,
    candidates: readonly ApplicabilityCandidate[],
  ): void {
    this.requireLive();
    this.detachAll();
    this.selected = element;
    this.candidatesTruncated = candidates.length > CANDIDATES_PER_SELECTION;
    this.candidates = Object.freeze(candidates
      .slice(0, CANDIDATES_PER_SELECTION)
      .map((candidate) => {
        const key = typeof candidate.key === "string" ? candidate.key : "";
        const selectorText = typeof candidate.selectorText === "string"
          ? candidate.selectorText
          : "";
        const contexts = Array.isArray(candidate.contexts)
          ? candidate.contexts
          : [];
        const contextTextTruncated = contexts.some(({ text }) => (
          typeof text === "string" && text.length > CONTEXT_TEXT_LENGTH
        ));
        return Object.freeze({
          key: key.slice(0, CANDIDATE_KEY_LENGTH),
          scope: candidate.scope,
          selectorText: selectorText.slice(0, SELECTOR_TEXT_LENGTH),
          contexts: Object.freeze(contexts
            .slice(0, CONTEXTS_PER_CANDIDATE)
            .map((context) => Object.freeze({
              kind: context.kind,
              text: boundedContext(context.text),
            }))),
          inputTruncated:
            key.length > CANDIDATE_KEY_LENGTH ||
            selectorText.length > SELECTOR_TEXT_LENGTH ||
            contexts.length > CONTEXTS_PER_CANDIDATE ||
            contextTextTruncated,
        });
      }));
    this.cursor = 0;
    this.windows.clear();
    this.signalGeneration += 1;
    this.pendingSignal = false;
    if (!element) return;
    this.attachSignals();
    this.attachMedia();
  }

  public check(): ApplicabilityCheckResult {
    this.requireLive();
    const selected = this.selected;
    if (!selected) return emptyResult();
    const ancestorScan = composedAncestors(selected);
    const ancestors = ancestorScan.values;
    const total = this.candidates.length;
    if (total === 0) {
      const windowDigest = digestStrings([String(ancestors.length)]);
      const previous = this.windows.get(0);
      const changed = previous !== undefined && previous !== windowDigest;
      this.windows.set(0, windowDigest);
      const digest = aggregateWindowDigest(total, this.windows);
      if (changed && this.suppressInvalidation === 0) {
        this.emit({ reason: "applicability-change" });
      }
      return freezeResult({
        digest,
        changed,
        partial: this.candidatesTruncated || ancestorScan.truncated,
        candidatesVisited: 0,
        ancestorsVisited: ancestors.length,
        nextCursor: 0,
        matches: [],
      });
    }

    const start = this.cursor >= 0 && this.cursor < total ? this.cursor : 0;
    const count = Math.min(
      total - start,
      APPLICABILITY_LIMITS.candidatesPerPass,
    );
    const matches: ApplicabilityMatch[] = [];
    const parts: string[] = [`ancestors:${ancestors.length}`];
    let scanTruncated = this.candidatesTruncated || ancestorScan.truncated;
    for (let offset = 0; offset < count; offset += 1) {
      const candidateIndex = start + offset;
      const candidate = this.candidates[candidateIndex]!;
      const parsedSelectors = parseSelectorList(candidate.selectorText);
      const selectors = parsedSelectors.selectors;
      scanTruncated ||= candidate.inputTruncated || parsedSelectors.truncated;
      const groupApplicability = candidate.contexts.map((context) => (
        this.groupApplicability(context, candidate.scope)
      ));
      for (let ancestorIndex = 0; ancestorIndex < ancestors.length; ancestorIndex += 1) {
        const ancestor = ancestors[ancestorIndex]!;
        if (safeRoot(ancestor) !== candidate.scope) continue;
        const matchingSelectorIndices: number[] = [];
        for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
          if (safeMatches(ancestor, selectors[selectorIndex]!)) {
            matchingSelectorIndices.push(selectorIndex);
          }
        }
        parts.push([
          candidate.key,
          String(ancestorIndex),
          matchingSelectorIndices.join(","),
          groupApplicability.join(","),
        ].join(":"));
        if (matchingSelectorIndices.length > 0) {
          matches.push(Object.freeze({
            candidateKey: candidate.key,
            ancestorIndex,
            matchingSelectorIndices: Object.freeze(matchingSelectorIndices),
            groupApplicability: Object.freeze([...groupApplicability]),
          }));
        }
      }
    }
    const windowDigest = digestStrings(parts);
    const previous = this.windows.get(start);
    const changed = previous !== undefined && previous !== windowDigest;
    this.windows.set(start, windowDigest);
    const partial = scanTruncated || total > count;
    this.cursor = start + count >= total ? 0 : start + count;
    const digest = aggregateWindowDigest(total, this.windows);
    if (changed && this.suppressInvalidation === 0) {
      this.emit({ reason: "applicability-change" });
    }
    return freezeResult({
      digest,
      changed,
      partial,
      candidatesVisited: count,
      ancestorsVisited: ancestors.length,
      nextCursor: this.cursor,
      matches,
    });
  }

  public manualRefresh(): void {
    this.requireLive();
    try {
      this.rebaseline();
    } finally {
      this.emit({ reason: "manual-refresh" });
    }
  }

  /** Refreshes the digest without reporting a second invalidation. */
  public rebaseline(): ApplicabilityCheckResult {
    this.requireLive();
    this.suppressInvalidation += 1;
    try {
      return this.check();
    } finally {
      this.suppressInvalidation -= 1;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.detachAll();
    this.disposed = true;
    this.selected = undefined;
    this.candidates = Object.freeze([]);
    this.candidatesTruncated = false;
    this.windows.clear();
  }

  private attachSignals(): void {
    const targets = new Set<EventTarget>();
    targets.add(this.options.document);
    for (const candidate of this.candidates) targets.add(candidate.scope);
    for (const target of targets) {
      for (const type of [
        "slotchange",
        "pointerover",
        "pointerout",
        "focusin",
        "focusout",
      ]) {
        this.listen(target, type, () => this.scheduleObservableSignal(), true);
      }
      const view = safeView(target);
      if (view) this.listen(view, "resize", () => this.scheduleObservableSignal(), true);
    }
    const create = this.options.createMutationObserver ?? defaultMutationObserver();
    if (!create) return;
    try {
      const observer = create(() => this.scheduleObservableSignal());
      this.mutationObserver = observer;
      for (const target of targets) {
        observer.observe(target as unknown as Node, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    } catch (error) {
      try {
        this.mutationObserver?.disconnect();
      } catch {
        // The detached observer cannot retain authority.
      }
      this.mutationObserver = undefined;
      this.reportError(error);
    }
  }

  private attachMedia(): void {
    for (const candidate of this.candidates) {
      for (const context of candidate.contexts) {
        if (context.kind !== "media") continue;
        const registrations = this.media.get(candidate.scope) ?? new Map();
        if (registrations.has(context.text)) continue;
        const list = safeMatchMedia(candidate.scope, context.text);
        if (!list) continue;
        const listener: EventListener = () => {
          try {
            const result = this.check();
            if (!result.changed) this.scheduleObservableSignal();
          } catch (error) {
            this.reportError(error);
          }
        };
        try {
          list.addEventListener("change", listener);
          registrations.set(context.text, { list, listener });
          this.media.set(candidate.scope, registrations);
        } catch (error) {
          this.reportError(error);
        }
      }
    }
  }

  private groupApplicability(
    context: ApplicabilityContext,
    scope: Document | ShadowRoot,
  ): GroupApplicability {
    if (context.kind === "media") {
      const registration = this.media.get(scope)?.get(context.text);
      const list = registration?.list ?? safeMatchMedia(
        scope,
        context.text,
      );
      return list ? (safeMediaMatches(list) ? "active" : "inactive") : "unknown";
    }
    if (context.kind === "supports") {
      const result = safeSupports(scope, context.text);
      return result === undefined ? "unknown" : result ? "active" : "inactive";
    }
    return "unknown";
  }

  private scheduleObservableSignal(): void {
    if (this.disposed || this.pendingSignal) return;
    this.pendingSignal = true;
    const generation = this.signalGeneration;
    this.enqueue(() => {
      if (
        this.disposed ||
        generation !== this.signalGeneration ||
        !this.pendingSignal
      ) return;
      this.pendingSignal = false;
      this.emit({ reason: "observable-signal" });
    });
  }

  private listen(
    target: EventTarget,
    type: string,
    callback: () => void,
    capture: boolean,
  ): void {
    const listener: EventListener = () => callback();
    try {
      target.addEventListener(type, listener, capture);
      this.eventRegistrations.push({ target, type, listener, capture });
    } catch (error) {
      this.reportError(error);
    }
  }

  private detachAll(): void {
    this.signalGeneration += 1;
    this.pendingSignal = false;
    const observer = this.mutationObserver;
    this.mutationObserver = undefined;
    try {
      observer?.disconnect();
    } catch (error) {
      this.reportError(error);
    }
    for (const { target, type, listener, capture } of this.eventRegistrations.splice(0)) {
      try {
        target.removeEventListener(type, listener, capture);
      } catch (error) {
        this.reportError(error);
      }
    }
    for (const registrations of this.media.values()) {
      for (const { list, listener } of registrations.values()) {
        try {
          list.removeEventListener("change", listener);
        } catch (error) {
          this.reportError(error);
        }
      }
    }
    this.media.clear();
  }

  private emit(event: ApplicabilityInvalidationEvent): void {
    if (this.disposed) return;
    try {
      this.options.onInvalidated(Object.freeze({ ...event }));
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.disposed) return;
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot change observer authority.
    }
  }

  private requireLive(): void {
    if (this.disposed) {
      throw new Error("MatchedStylesApplicabilityObserver is disposed");
    }
  }
}

function composedAncestors(element: Element): BoundedAncestors {
  const result: Element[] = [];
  const seen = new Set<object>();
  let current: Element | undefined = element;
  while (current) {
    if (seen.has(current)) break;
    if (result.length >= APPLICABILITY_LIMITS.composedAncestors) {
      return Object.freeze({
        values: Object.freeze(result),
        truncated: true,
      });
    }
    seen.add(current);
    result.push(current);
    current = nextComposedAncestor(current);
  }
  return Object.freeze({
    values: Object.freeze(result),
    truncated: false,
  });
}

function nextComposedAncestor(element: Element): Element | undefined {
  const assigned = safeObjectProperty(element, "assignedSlot");
  if (assigned) return assigned as unknown as Element;
  const parent = safeObjectProperty(element, "parentElement");
  if (parent) return parent as unknown as Element;
  const root = safeRoot(element);
  const host = root ? safeObjectProperty(root, "host") : undefined;
  return host as Element | undefined;
}

function parseSelectorList(selectorText: string): ParsedSelectorList {
  try {
    const nodes = selectorParser().astSync(selectorText).nodes;
    return Object.freeze({
      selectors: Object.freeze(nodes
        .slice(0, APPLICABILITY_LIMITS.selectorsPerRule)
      .map((selector) => selector.toString().trim())
        .filter(Boolean)),
      truncated: nodes.length > APPLICABILITY_LIMITS.selectorsPerRule,
    });
  } catch {
    return Object.freeze({
      selectors: Object.freeze([]),
      truncated: false,
    });
  }
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function safeRoot(element: Element): object | undefined {
  try {
    const root = element.getRootNode();
    return typeof root === "object" && root !== null ? root : undefined;
  } catch {
    return undefined;
  }
}

function safeView(scope: EventTarget): Window | undefined {
  const document = isDocument(scope)
    ? scope
    : safeObjectProperty(scope, "ownerDocument");
  return document
    ? safeObjectProperty(document, "defaultView") as Window | undefined
    : undefined;
}

function safeMatchMedia(
  scope: Document | ShadowRoot,
  condition: string,
): MediaQueryList | undefined {
  const view = safeView(scope);
  try {
    return view && typeof view.matchMedia === "function"
      ? view.matchMedia(condition)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeMediaMatches(list: MediaQueryList): boolean {
  try {
    return list.matches === true;
  } catch {
    return false;
  }
}

function safeSupports(
  scope: Document | ShadowRoot,
  condition: string,
): boolean | undefined {
  const view = safeView(scope) as Window & {
    readonly CSS?: { supports(condition: string): boolean };
  } | undefined;
  try {
    const css = view?.CSS ?? globalThis.CSS;
    return css && typeof css.supports === "function"
      ? css.supports(condition)
      : undefined;
  } catch {
    return undefined;
  }
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

function isDocument(value: object): value is Document {
  try {
    return (value as { readonly nodeType?: unknown }).nodeType === 9;
  } catch {
    return false;
  }
}

function defaultMutationObserver(): MatchedStylesApplicabilityObserverOptions["createMutationObserver"] {
  return typeof MutationObserver === "function"
    ? (callback) => new MutationObserver((records) => callback(records))
    : undefined;
}

function boundedContext(value: string): string {
  return typeof value === "string" ? value.slice(0, CONTEXT_TEXT_LENGTH) : "";
}

function aggregateWindowDigest(
  total: number,
  windows: ReadonlyMap<number, string>,
): string {
  return digestStrings([
    `total:${total}`,
    ...[...windows.entries()]
      .sort(([left], [right]) => left - right)
      .map(([start, digest]) => `${start}:${digest}`),
  ]);
}

function digestStrings(values: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function freezeResult(result: ApplicabilityCheckResult): ApplicabilityCheckResult {
  return Object.freeze({ ...result, matches: Object.freeze([...result.matches]) });
}

function emptyResult(): ApplicabilityCheckResult {
  return freezeResult({
    digest: "00000000",
    changed: false,
    partial: false,
    candidatesVisited: 0,
    ancestorsVisited: 0,
    nextCursor: 0,
    matches: [],
  });
}

function requireObject(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}
