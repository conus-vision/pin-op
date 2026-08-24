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
}

export interface MatchedStylesModelKey extends MatchedStylesModelSelection {
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
}

export interface MatchedStylesModelSnapshot {
  readonly state: MatchedStylesModelState;
  readonly generation: number;
  readonly key?: MatchedStylesModelSelection | MatchedStylesModelKey;
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
  private selection: MatchedStylesModelSelection | undefined;
  private revisionAuthority: StylesRevisionAuthority | undefined;
  private lastAcceptedKey: MatchedStylesModelKey | undefined;
  private lastStylesheetReset: {
    readonly documentEpoch: number;
    readonly stylesheetRevision: number;
  } | undefined;
  private invalidationQueued = false;
  private pendingInvalidation: StylesInvalidatedEvent | undefined;
  private pendingReloadGeneration: number | undefined;
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
    const current = this.selection;
    if (current && sameSelection(current, key) && this.state.state !== "error") {
      return;
    }
    if (
      (current && current.documentEpoch !== key.documentEpoch) ||
      (this.revisionAuthority &&
        this.revisionAuthority.documentEpoch !== key.documentEpoch)
    ) {
      this.clearRevisionAuthority();
    }
    this.selection = key;
    await this.load(key);
  }

  public invalidate(value: unknown): void {
    if (this.disposed) return;
    let event: StylesInvalidatedEvent;
    try {
      const parsed = parseStylesEvent(value);
      if (parsed.type !== "styles.invalidated") return;
      event = parsed;
    } catch {
      return;
    }
    const selection = this.selection;
    if (selection && event.documentEpoch !== selection.documentEpoch) return;
    const authority = this.revisionAuthority;
    if (authority) {
      if (event.documentEpoch < authority.documentEpoch) return;
      if (
        event.documentEpoch === authority.documentEpoch &&
        !strictlyNewerRevisionPair(event, authority)
      ) return;
    }
    this.revisionAuthority = freezeRevisionAuthority(event);
    if (!selection) return;
    if (this.state.state === "loading") {
      this.pendingReloadGeneration = this.generation;
      return;
    }
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
      const liveSelection = this.selection;
      if (
        !latest ||
        !liveSelection ||
        latest.documentEpoch !== liveSelection.documentEpoch
      ) return;
      this.notifyStylesheetReset(latest);
      if (
        this.disposed ||
        generation !== this.generation ||
        this.selection !== liveSelection
      ) return;
      void this.load(liveSelection);
    });
  }

  public reset(_reason: Exclude<MatchedStylesResetReason, "disposal">): void {
    if (this.disposed) return;
    this.cancelCurrent();
    this.generation += 1;
    this.selection = undefined;
    this.clearRevisionAuthority();
    this.publish(Object.freeze({ state: "idle", generation: this.generation }));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.cancelCurrent();
    this.disposed = true;
    this.generation += 1;
    this.selection = undefined;
    this.clearRevisionAuthority();
    this.state = Object.freeze({ state: "idle", generation: this.generation });
    this.listeners.clear();
  }

  private async load(selection: MatchedStylesModelSelection): Promise<void> {
    this.cancelCurrent();
    const generation = ++this.generation;
    this.pendingReloadGeneration = undefined;
    const controller = new AbortController();
    this.controller = controller;
    this.publish(Object.freeze({ state: "loading", generation, key: selection }));
    const request: StylesGetMatchedRequest = Object.freeze({
      type: "styles.getMatched",
      requestId: this.createRequestId(),
      documentEpoch: selection.documentEpoch,
      nodeRef: selection.nodeRef,
      selectionRevision: selection.selectionRevision,
    });
    let response: StylesResponse;
    try {
      response = parseStylesResponse(await this.options.request(request, controller.signal));
    } catch {
      if (!this.isCurrent(generation, controller)) return;
      this.controller = undefined;
      if (this.reloadPendingFloor(generation, selection)) return;
      this.pendingReloadGeneration = undefined;
      this.publish(Object.freeze({
        state: "error",
        generation,
        key: selection,
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
        key: selection,
        errorCode: "internal-error",
      }));
      return;
    }
    if (response.type === "styles.error") {
      if (
        (response.code === "cancelled" || response.code === "internal-error") &&
        this.reloadPendingFloor(generation, selection)
      ) return;
      this.pendingReloadGeneration = undefined;
      this.publish(Object.freeze({
        state: "error",
        generation,
        key: selection,
        errorCode: response.code,
      }));
      return;
    }
    const responseAuthority = freezeRevisionAuthority(response);
    const floor = this.revisionAuthority;
    if (
      floor &&
      (
        floor.documentEpoch !== response.documentEpoch ||
        !revisionPairMeetsFloor(responseAuthority, floor)
      )
    ) {
      if (this.reloadPendingFloor(generation, selection)) return;
      this.pendingReloadGeneration = undefined;
      this.publish(Object.freeze({
        state: "error",
        generation,
        key: selection,
        errorCode: "internal-error",
      }));
      return;
    }
    this.pendingReloadGeneration = undefined;
    this.notifyStylesheetReset(responseAuthority);
    this.revisionAuthority = responseAuthority;
    const key: MatchedStylesModelKey = Object.freeze({
      ...selection,
      stylesRevision: response.stylesRevision,
      stylesheetRevision: response.stylesheetRevision,
    });
    this.lastAcceptedKey = key;
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

  private notifyStylesheetReset(authority: StylesRevisionAuthority): void {
    const previous = this.lastStylesheetReset;
    const baseline = previous?.documentEpoch === authority.documentEpoch
      ? previous.stylesheetRevision
      : this.lastAcceptedKey?.documentEpoch === authority.documentEpoch
      ? this.lastAcceptedKey.stylesheetRevision
      : undefined;
    if (baseline === undefined) {
      this.lastStylesheetReset = Object.freeze({
        documentEpoch: authority.documentEpoch,
        stylesheetRevision: authority.stylesheetRevision,
      });
      return;
    }
    if (authority.stylesheetRevision <= baseline) return;
    this.lastStylesheetReset = Object.freeze({
      documentEpoch: authority.documentEpoch,
      stylesheetRevision: authority.stylesheetRevision,
    });
    try {
      this.options.onStylesheetReset?.(this.lastStylesheetReset);
    } catch {
      // Reset notification cannot expand rule identity authority.
    }
  }

  private reloadPendingFloor(
    generation: number,
    selection: MatchedStylesModelSelection,
  ): boolean {
    const floor = this.revisionAuthority;
    if (
      this.pendingReloadGeneration !== generation ||
      !floor ||
      floor.documentEpoch !== selection.documentEpoch
    ) return false;
    this.pendingReloadGeneration = undefined;
    this.notifyStylesheetReset(floor);
    if (
      !this.disposed &&
      this.generation === generation &&
      this.selection === selection
    ) {
      void this.load(selection);
    }
    return true;
  }

  private clearRevisionAuthority(): void {
    this.revisionAuthority = undefined;
    this.lastAcceptedKey = undefined;
    this.lastStylesheetReset = undefined;
    this.pendingInvalidation = undefined;
    this.invalidationQueued = false;
    this.pendingReloadGeneration = undefined;
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

interface StylesRevisionAuthority {
  readonly documentEpoch: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
}

function requireSelection(value: MatchedStylesModelSelection): MatchedStylesModelSelection {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.nodeRef !== "string" ||
    value.nodeRef.length === 0 ||
    value.nodeRef.length > 128 ||
    !validRevision(value.documentEpoch) ||
    !validRevision(value.selectionRevision)
  ) throw new TypeError("Invalid matched styles selection");
  return Object.freeze({
    documentEpoch: value.documentEpoch,
    nodeRef: value.nodeRef,
    selectionRevision: value.selectionRevision,
  });
}

function freezeSelection(value: MatchedStylesModelSelection): MatchedStylesModelSelection {
  return Object.freeze({
    documentEpoch: value.documentEpoch,
    nodeRef: value.nodeRef,
    selectionRevision: value.selectionRevision,
  });
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
    left.selectionRevision === right.selectionRevision;
}

function freezeRevisionAuthority(
  value: StylesRevisionAuthority,
): StylesRevisionAuthority {
  return Object.freeze({
    documentEpoch: value.documentEpoch,
    stylesRevision: value.stylesRevision,
    stylesheetRevision: value.stylesheetRevision,
  });
}

function strictlyNewerRevisionPair(
  candidate: StylesRevisionAuthority,
  floor: StylesRevisionAuthority,
): boolean {
  return candidate.stylesRevision > floor.stylesRevision &&
    candidate.stylesheetRevision >= floor.stylesheetRevision;
}

function revisionPairMeetsFloor(
  candidate: StylesRevisionAuthority,
  floor: StylesRevisionAuthority,
): boolean {
  return (
    candidate.stylesRevision === floor.stylesRevision &&
    candidate.stylesheetRevision === floor.stylesheetRevision
  ) || strictlyNewerRevisionPair(candidate, floor);
}
