import type { MatchedStyles } from "./matchedStylesTypes.js";
import {
  isStylesResponseForRequest,
  parseStylesEvent,
  parseStylesResponse,
  type StylesErrorCode,
  type StylesGetMatchedRequest,
  type StylesInvalidatedEvent,
  type StylesResponse,
} from "./stylesProtocol.js";

export type MatchedStylesModelState =
  | "idle"
  | "loading"
  | "ready"
  | "partial"
  | "error";

export interface MatchedStylesModelSelection {
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
}

export interface MatchedStylesModelSnapshot {
  readonly state: MatchedStylesModelState;
  readonly generation: number;
  readonly key?: MatchedStylesModelSelection;
  readonly styles?: MatchedStyles;
  readonly errorCode?: StylesErrorCode;
}

export type MatchedStylesResetReason =
  | "advanced-selection"
  | "recovery"
  | "inspect-port-invalidated"
  | "navigation"
  | "content-lease-replaced"
  | "compatibility-failure"
  | "disposal";

export interface MatchedStylesModelOptions {
  readonly request: (
    request: StylesGetMatchedRequest,
    signal: AbortSignal,
  ) => Promise<StylesResponse>;
  readonly createRequestId?: () => string;
  readonly onStylesheetReset?: (scope: {
    readonly documentEpoch: number;
    readonly stylesheetRevision: number;
  }) => void;
  readonly queueMicrotask?: (callback: () => void) => void;
}

/** IDE-independent, generation-fenced browser-local matched-style state. */
export class MatchedStylesModel {
  private state: MatchedStylesModelSnapshot = Object.freeze({
    state: "idle",
    generation: 0,
  });
  private generation = 0;
  private nextRequestSequence = 1;
  private controller: AbortController | undefined;
  private invalidationQueued = false;
  private pendingInvalidation: StylesInvalidatedEvent | undefined;
  private disposed = false;
  private readonly listeners = new Set<
    (snapshot: MatchedStylesModelSnapshot) => void
  >();
  private readonly enqueue: (callback: () => void) => void;

  public constructor(private readonly options: MatchedStylesModelOptions) {
    this.enqueue = options.queueMicrotask ?? globalThis.queueMicrotask.bind(globalThis);
  }

  public snapshot(): MatchedStylesModelSnapshot {
    return this.state;
  }

  public subscribe(
    listener: (snapshot: MatchedStylesModelSnapshot) => void,
  ): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      // Presentation observers cannot change model authority.
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  public async select(selection: MatchedStylesModelSelection): Promise<void> {
    this.requireLive();
    const key = freezeSelection(requireSelection(selection));
    const current = this.state.key;
    if (current && sameSelection(current, key) && this.state.state !== "error") return;
    await this.load(key);
  }

  public invalidate(value: unknown): void {
    if (this.disposed || !this.state.key) return;
    let event: StylesInvalidatedEvent;
    try {
      const parsed = parseStylesEvent(value);
      if (parsed.type !== "styles.invalidated") return;
      event = parsed;
    } catch {
      return;
    }
    const key = this.state.key;
    if (
      event.documentEpoch !== key.documentEpoch ||
      event.stylesRevision <= key.stylesRevision ||
      event.stylesheetRevision < key.stylesheetRevision ||
      event.stylesheetRevision > event.stylesRevision
    ) return;
    const pending = this.pendingInvalidation;
    if (
      pending &&
      (event.stylesRevision < pending.stylesRevision ||
        event.stylesheetRevision < pending.stylesheetRevision)
    ) return;
    this.pendingInvalidation = event;
    if (this.invalidationQueued) return;
    this.invalidationQueued = true;
    const generation = this.generation;
    this.enqueue(() => {
      this.invalidationQueued = false;
      if (this.disposed || generation !== this.generation) {
        this.pendingInvalidation = undefined;
        return;
      }
      const latest = this.pendingInvalidation;
      this.pendingInvalidation = undefined;
      const liveKey = this.state.key;
      if (!latest || !liveKey || latest.documentEpoch !== liveKey.documentEpoch) return;
      if (latest.stylesheetRevision > liveKey.stylesheetRevision) {
        try {
          this.options.onStylesheetReset?.({
            documentEpoch: latest.documentEpoch,
            stylesheetRevision: latest.stylesheetRevision,
          });
        } catch {
          // Reset notification cannot expand rule identity authority.
        }
      }
      void this.load(freezeSelection({
        ...liveKey,
        stylesRevision: latest.stylesRevision,
        stylesheetRevision: latest.stylesheetRevision,
      }));
    });
  }

  public reset(_reason: Exclude<MatchedStylesResetReason, "disposal">): void {
    if (this.disposed) return;
    this.cancelCurrent();
    this.generation += 1;
    this.pendingInvalidation = undefined;
    this.invalidationQueued = false;
    this.publish(Object.freeze({ state: "idle", generation: this.generation }));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.cancelCurrent();
    this.disposed = true;
    this.generation += 1;
    this.pendingInvalidation = undefined;
    this.invalidationQueued = false;
    this.state = Object.freeze({ state: "idle", generation: this.generation });
    this.listeners.clear();
  }

  private async load(key: MatchedStylesModelSelection): Promise<void> {
    this.cancelCurrent();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.publish(Object.freeze({ state: "loading", generation, key }));
    const request: StylesGetMatchedRequest = Object.freeze({
      type: "styles.getMatched",
      requestId: this.createRequestId(),
      documentEpoch: key.documentEpoch,
      nodeRef: key.nodeRef,
      selectionRevision: key.selectionRevision,
    });
    let response: StylesResponse;
    try {
      response = parseStylesResponse(await this.options.request(request, controller.signal));
    } catch {
      if (!this.isCurrent(generation, controller)) return;
      this.controller = undefined;
      this.publish(Object.freeze({
        state: "error",
        generation,
        key,
        errorCode: "internal-error",
      }));
      return;
    }
    if (!this.isCurrent(generation, controller)) return;
    this.controller = undefined;
    if (!isStylesResponseForRequest(request, response)) {
      this.publish(Object.freeze({
        state: "error",
        generation,
        key,
        errorCode: "internal-error",
      }));
      return;
    }
    if (response.type === "styles.error") {
      this.publish(Object.freeze({
        state: "error",
        generation,
        key,
        errorCode: response.code,
      }));
      return;
    }
    if (
      response.stylesRevision !== key.stylesRevision ||
      response.stylesheetRevision !== key.stylesheetRevision
    ) {
      this.publish(Object.freeze({
        state: "error",
        generation,
        key,
        errorCode: "internal-error",
      }));
      return;
    }
    this.publish(Object.freeze({
      state: response.styles.partial ? "partial" : "ready",
      generation,
      key,
      styles: response.styles,
    }));
  }

  private createRequestId(): string {
    const requestId = this.options.createRequestId?.() ??
      `styles-model-${this.nextRequestSequence++}`;
    if (
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      requestId.length > 128
    ) throw new Error("Invalid styles request ID");
    return requestId;
  }

  private cancelCurrent(): void {
    const controller = this.controller;
    this.controller = undefined;
    try {
      controller?.abort();
    } catch {
      // The generation fence remains authoritative.
    }
  }

  private isCurrent(generation: number, controller: AbortController): boolean {
    return !this.disposed &&
      this.generation === generation &&
      this.controller === controller &&
      !controller.signal.aborted;
  }

  private publish(snapshot: MatchedStylesModelSnapshot): void {
    if (this.disposed) return;
    this.state = snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Presentation observers cannot change model authority.
      }
    }
  }

  private requireLive(): void {
    if (this.disposed) throw new Error("MatchedStylesModel is disposed");
  }
}

function requireSelection(value: MatchedStylesModelSelection): MatchedStylesModelSelection {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.nodeRef !== "string" ||
    value.nodeRef.length === 0 ||
    value.nodeRef.length > 128 ||
    !validRevision(value.documentEpoch) ||
    !validRevision(value.selectionRevision) ||
    !validRevision(value.stylesRevision) ||
    !validRevision(value.stylesheetRevision) ||
    value.stylesheetRevision > value.stylesRevision
  ) throw new TypeError("Invalid matched styles selection");
  return value;
}

function freezeSelection(value: MatchedStylesModelSelection): MatchedStylesModelSelection {
  return Object.freeze({ ...value });
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameSelection(
  left: MatchedStylesModelSelection,
  right: MatchedStylesModelSelection,
): boolean {
  return left.documentEpoch === right.documentEpoch &&
    left.nodeRef === right.nodeRef &&
    left.selectionRevision === right.selectionRevision &&
    left.stylesRevision === right.stylesRevision &&
    left.stylesheetRevision === right.stylesheetRevision;
}
