import {
  parseInspectPortRequest,
  type BackgroundInspectPort,
  type ContentSessionId,
  type ContentInspectPort,
  type InspectPortInvalidated,
  type InspectPortRequest,
  type InspectPortResult,
} from "./inspectPortProtocol.js";
import { BackgroundInspectLeaseRegistry } from "./inspectLease.js";

const DEFAULT_CLEANUP_ACK_TIMEOUT_MS = 1_000;
const MAX_CLEANUP_ACK_TIMEOUT_MS = 60_000;

type InspectScheduleTimeout = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof globalThis.setTimeout>;
type InspectCancelTimeout = (
  timer: ReturnType<typeof globalThis.setTimeout>,
) => void;

export interface BackgroundInspectApi {
  executeScript(details: {
    target: { tabId: number };
    files: string[];
  }): Promise<unknown>;
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface BackgroundInspectCoordinatorOptions {
  readonly cleanupAckTimeoutMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

interface TabInspectState {
  queue: Promise<void>;
  owner: ActiveInspectOwner | undefined;
  pendingLeaseAttachments: number;
}

interface ActiveInspectOwner {
  readonly token: object;
  readonly onInvalidated: (reason: InspectSessionInvalidationReason) => void;
  readonly onContentLeaseAttached: (contentSessionId: ContentSessionId) => void;
  readonly onContentLeaseReplacing: (
    previousContentSessionId: ContentSessionId,
    nextContentSessionId: ContentSessionId,
  ) => void;
}

export type InspectSessionInvalidationReason =
  | "documentDisconnected"
  | "injectionFailed";

export interface BackgroundInspectSessionLifecycle {
  readonly onInvalidated?: (reason: InspectSessionInvalidationReason) => void;
  readonly onContentLeaseAttached?: (
    contentSessionId: ContentSessionId,
  ) => void;
  readonly onContentLeaseReplacing?: (
    previousContentSessionId: ContentSessionId,
    nextContentSessionId: ContentSessionId,
  ) => void;
}

export class BackgroundInspectCoordinator {
  private readonly tabs = new Map<number, TabInspectState>();
  private readonly leases = new BackgroundInspectLeaseRegistry();
  private readonly cleanupAckTimeoutMs: number;
  private readonly scheduleTimeout: InspectScheduleTimeout;
  private readonly cancelTimeout: InspectCancelTimeout;

  public constructor(
    private readonly api: BackgroundInspectApi,
    options: BackgroundInspectCoordinatorOptions = {},
  ) {
    this.cleanupAckTimeoutMs = validCleanupAckTimeout(
      options.cleanupAckTimeoutMs,
    );
    this.scheduleTimeout = options.setTimeout ??
      ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.cancelTimeout = options.clearTimeout ??
      ((timer) => globalThis.clearTimeout(timer));
  }

  public attach(
    owner: object,
    tabId: number,
    onInvalidated: (
      reason: InspectSessionInvalidationReason,
    ) => void = () => {},
    onContentLeaseAttached: (contentSessionId: ContentSessionId) => void =
      () => {},
    onContentLeaseReplacing: (
      previousContentSessionId: ContentSessionId,
      nextContentSessionId: ContentSessionId,
    ) => void = () => {},
  ): Promise<void> {
    const state = this.stateFor(tabId);
    if (state.owner?.token === owner) {
      return state.queue;
    }
    state.owner = {
      token: owner,
      onInvalidated,
      onContentLeaseAttached,
      onContentLeaseReplacing,
    };
    return this.enqueue(state, async () => {
      if (state.owner?.token !== owner) {
        return;
      }
      try {
        await this.api.executeScript({
          target: { tabId },
          files: ["dist/contentScript.js"],
        });
      } catch (error) {
        this.invalidateOwner(state, owner, tabId, "injectionFailed");
        throw error;
      }
    });
  }

  public setEnabled(
    owner: object,
    tabId: number,
    enabled: boolean,
  ): Promise<void> {
    const state = this.stateFor(tabId);
    if (state.owner?.token !== owner) {
      return Promise.resolve();
    }

    return this.enqueue(state, async () => {
      if (state.owner?.token !== owner) {
        return;
      }
      await this.api.sendTabMessage(tabId, {
        type: enabled ? "enableInspectMode" : "disableInspectMode",
      });
    });
  }

  public release(owner: object, tabId: number): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state || state.owner?.token !== owner) {
      return Promise.resolve();
    }
    state.owner = undefined;
    const detachedLease = this.leases.detach(tabId);
    return this.enqueue(state, async () => {
      try {
        if (detachedLease?.contentSessionId) {
          await this.requestCleanupAcknowledgement(tabId, {
            type: "pin-op.inspect.disposeSession",
            contentSessionId: detachedLease.contentSessionId,
          });
        }
      } finally {
        detachedLease?.release();
      }
    });
  }

  public clearPseudoStates(
    tabId: number,
    contentSessionId: ContentSessionId,
  ): Promise<boolean> {
    const state = this.tabs.get(tabId);
    const owner = state?.owner;
    if (
      !state ||
      !owner ||
      !this.leases.isCurrent(tabId, contentSessionId)
    ) {
      return Promise.resolve(false);
    }
    return this.enqueueResult(state, async () => {
      if (
        state.owner !== owner ||
        !this.leases.isCurrent(tabId, contentSessionId)
      ) {
        return false;
      }
      const acknowledged = await this.requestCleanupAcknowledgement(tabId, {
        type: "pin-op.inspect.clearPseudoStates",
        contentSessionId,
      });
      return acknowledged &&
        state.owner === owner &&
        this.leases.isCurrent(tabId, contentSessionId);
    });
  }

  public attachContentLease(
    tabId: number,
    contentSessionId: ContentSessionId,
    port: ContentInspectPort,
  ): void {
    const state = this.tabs.get(tabId);
    const owner = state?.owner;
    if (!owner) {
      disconnectContentPort(port);
      return;
    }
    if (!this.leases.has(tabId) && state.pendingLeaseAttachments === 0) {
      this.acceptContentLease(
        state,
        owner,
        tabId,
        contentSessionId,
        port,
      );
      return;
    }
    const candidate = observePendingContentLease(port);
    if (!candidate) return;
    const queuedPredecessorId = this.leases.contentSessionId(tabId);
    if (queuedPredecessorId) {
      this.notifyContentLeaseReplacing(
        state,
        owner,
        queuedPredecessorId,
        contentSessionId,
      );
    }
    state.pendingLeaseAttachments += 1;
    const operation = this.enqueue(state, async () => {
      if (state.owner !== owner) {
        candidate.reject();
        return;
      }
      const predecessor = this.leases.detach(tabId);
      if (
        predecessor?.contentSessionId &&
        predecessor.contentSessionId !== queuedPredecessorId
      ) {
        this.notifyContentLeaseReplacing(
          state,
          owner,
          predecessor.contentSessionId,
          contentSessionId,
        );
      }
      try {
        if (predecessor?.contentSessionId) {
          await this.requestCleanupAcknowledgement(tabId, {
            type: "pin-op.inspect.disposeSession",
            contentSessionId: predecessor.contentSessionId,
          });
        }
      } finally {
        predecessor?.release();
      }
      if (state.owner !== owner) {
        candidate.reject();
        return;
      }
      if (!candidate.accept()) {
        return;
      }
      this.acceptContentLease(state, owner, tabId, contentSessionId, port);
    });
    void operation.then(
      () => { state.pendingLeaseAttachments -= 1; },
      () => {
        state.pendingLeaseAttachments -= 1;
        candidate.reject();
      },
    );
  }

  public whenIdle(tabId: number): Promise<void> {
    return this.tabs.get(tabId)?.queue ?? Promise.resolve();
  }

  public sendTabMessage(tabId: number, message: unknown): Promise<unknown> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      return Promise.reject(new Error("Invalid trusted inspect tab"));
    }
    return this.api.sendTabMessage(tabId, message);
  }

  private stateFor(tabId: number): TabInspectState {
    const existing = this.tabs.get(tabId);
    if (existing) {
      return existing;
    }
    const created: TabInspectState = {
      queue: Promise.resolve(),
      owner: undefined,
      pendingLeaseAttachments: 0,
    };
    this.tabs.set(tabId, created);
    return created;
  }

  private enqueue(
    state: TabInspectState,
    operation: () => Promise<void>,
  ): Promise<void> {
    return this.enqueueResult(state, operation);
  }

  private enqueueResult<T>(
    state: TabInspectState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = state.queue.then(operation);
    state.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private acceptContentLease(
    state: TabInspectState,
    owner: ActiveInspectOwner,
    tabId: number,
    contentSessionId: ContentSessionId,
    port: ContentInspectPort,
  ): void {
    if (state.owner !== owner) {
      disconnectContentPort(port);
      return;
    }
    try {
      this.leases.attach(
        tabId,
        port,
        () => this.invalidateContentOwner(tabId),
        contentSessionId,
      );
    } catch {
      disconnectContentPort(port);
      return;
    }
    try {
      owner.onContentLeaseAttached(contentSessionId);
    } catch {
      // Recovery bookkeeping cannot invalidate an accepted content lease.
    }
  }

  private notifyContentLeaseReplacing(
    state: TabInspectState,
    owner: ActiveInspectOwner,
    previousContentSessionId: ContentSessionId,
    nextContentSessionId: ContentSessionId,
  ): void {
    if (state.owner !== owner) return;
    try {
      owner.onContentLeaseReplacing(
        previousContentSessionId,
        nextContentSessionId,
      );
    } catch {
      // Routing invalidation remains best-effort; cleanup still owns the boundary.
    }
  }

  private requestCleanupAcknowledgement(
    tabId: number,
    message: unknown,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let active = true;
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const finish = (acknowledged: boolean): void => {
        if (!active) return;
        active = false;
        if (timer !== undefined) {
          try {
            this.cancelTimeout(timer);
          } catch {
            // Timeout authority is already revoked after settlement.
          }
        }
        resolve(acknowledged);
      };
      try {
        timer = this.scheduleTimeout(
          () => finish(false),
          this.cleanupAckTimeoutMs,
        );
      } catch {
        finish(false);
        return;
      }
      if (!active) {
        try {
          this.cancelTimeout(timer);
        } catch {
          // A synchronously-fired timer has already revoked cleanup authority.
        }
        return;
      }
      let pending: Promise<unknown>;
      try {
        pending = this.api.sendTabMessage(tabId, message);
      } catch {
        finish(false);
        return;
      }
      void pending.then(
        (response) => finish(response === true),
        () => finish(false),
      );
    });
  }

  private invalidateContentOwner(tabId: number): void {
    const state = this.tabs.get(tabId);
    const owner = state?.owner;
    if (!state || !owner) {
      return;
    }
    state.owner = undefined;
    try {
      owner.onInvalidated("documentDisconnected");
    } catch {
      // Panel notification cannot restore invalidated inspect ownership.
    }
  }

  private invalidateOwner(
    state: TabInspectState,
    owner: object,
    tabId: number,
    reason: InspectSessionInvalidationReason,
  ): void {
    if (state.owner?.token !== owner) {
      return;
    }
    const active = state.owner;
    state.owner = undefined;
    this.leases.release(tabId);
    try {
      active.onInvalidated(reason);
    } catch {
      // Panel notification cannot restore invalidated ownership.
    }
  }
}

function disconnectContentPort(port: ContentInspectPort): void {
  try {
    port.disconnect();
  } catch {
    // The content script may have disappeared before registration settled.
  }
}

interface PendingContentLeaseCandidate {
  accept(): boolean;
  reject(): void;
}

function observePendingContentLease(
  port: ContentInspectPort,
): PendingContentLeaseCandidate | undefined {
  let live = true;
  let listening = false;
  let settled = false;
  const onDisconnect = (): void => {
    live = false;
  };
  try {
    port.onDisconnect.addListener(onDisconnect);
    listening = true;
  } catch {
    try {
      port.onDisconnect.removeListener(onDisconnect);
    } catch {
      // A partially registered observer is harmless after fail-closed disconnect.
    }
    disconnectContentPort(port);
    return undefined;
  }

  const stopListening = (): boolean => {
    if (!listening) return false;
    listening = false;
    try {
      port.onDisconnect.removeListener(onDisconnect);
    } catch {
      live = false;
      disconnectContentPort(port);
      return false;
    }
    return live;
  };

  return {
    accept(): boolean {
      if (settled) return false;
      settled = true;
      const accepted = stopListening();
      if (!accepted) disconnectContentPort(port);
      return accepted;
    },
    reject(): void {
      if (settled) return;
      settled = true;
      stopListening();
      disconnectContentPort(port);
    },
  };
}

function validCleanupAckTimeout(value: unknown): number {
  return Number.isSafeInteger(value) &&
      (value as number) > 0 &&
      (value as number) <= MAX_CLEANUP_ACK_TIMEOUT_MS
    ? value as number
    : DEFAULT_CLEANUP_ACK_TIMEOUT_MS;
}

export class BackgroundInspectSession {
  private readonly owner = {};
  private readonly pendingRequests = new Set<PendingInspectRequest>();
  private lastOperation = Promise.resolve();
  private readonly ready: Promise<void>;
  private pickerEnabled = false;
  private disconnected = false;

  public constructor(
    private readonly coordinator: BackgroundInspectCoordinator,
    private readonly tabId: number,
    private readonly sendMessage: (
      message: InspectPortResult | InspectPortInvalidated,
    ) => void,
    private readonly lifecycle: BackgroundInspectSessionLifecycle = {},
  ) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw new Error("Invalid trusted inspect tab");
    }
    this.ready = this.coordinator.attach(
      this.owner,
      this.tabId,
      (reason) => this.handleInvalidation(reason),
      (contentSessionId) => this.handleContentLeaseAttached(contentSessionId),
      (previous, next) => this.handleContentLeaseReplacing(previous, next),
    );
    this.lastOperation = this.ready.catch(() => undefined);
  }

  public handleMessage(message: unknown): void {
    const request = parseInspectPortRequest(message);
    if (!request || this.disconnected) {
      return;
    }
    void this.track(request, true);
  }

  public execute(
    message: unknown,
  ): Promise<BackgroundInspectSessionOutcome | undefined> {
    const request = parseInspectPortRequest(message);
    if (!request || this.disconnected) {
      return Promise.resolve(undefined);
    }
    return this.track(request, false);
  }

  public disconnect(): void {
    this.settlePending("stalePanel", false);
    this.close();
  }

  public retire(error: string): void {
    if (this.disconnected) {
      return;
    }
    this.settlePending(error, true);
    this.close();
  }

  public suspend(error = "stalePanel"): void {
    if (this.disconnected) {
      return;
    }
    const shouldDisable = this.pickerEnabled ||
      [...this.pendingRequests].some((pending) => pending.enabled);
    this.settlePending(error, true);
    this.pickerEnabled = false;
    if (shouldDisable) {
      this.lastOperation = this.coordinator
        .setEnabled(this.owner, this.tabId, false)
        .catch(() => undefined);
    }
  }

  public whenIdle(): Promise<void> {
    return this.lastOperation;
  }

  private track(
    request: InspectPortRequest,
    deliverResult: boolean,
  ): Promise<BackgroundInspectSessionOutcome> {
    let resolveOutcome!: (outcome: BackgroundInspectSessionOutcome) => void;
    const outcome = new Promise<BackgroundInspectSessionOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const pending: PendingInspectRequest = {
      requestId: request.requestId,
      enabled: request.enabled,
      deliverResult,
      resolve: resolveOutcome,
    };
    this.pendingRequests.add(pending);
    const operation = this.ready.then(() => this.coordinator.setEnabled(
      this.owner,
      this.tabId,
      request.enabled,
    ));
    this.lastOperation = operation.catch(() => undefined);
    void operation.then(
      () => {
        this.finishRequest(pending, {
          type: "pin-op.inspect.result",
          requestId: request.requestId,
          ok: true,
        });
      },
      () => {
        this.finishRequest(pending, {
          type: "pin-op.inspect.result",
          requestId: request.requestId,
          ok: false,
          error: "Inspect mode update failed",
        });
      },
    );
    return outcome;
  }

  private finishRequest(
    pending: PendingInspectRequest,
    result: InspectPortResult,
  ): void {
    if (this.disconnected || !this.pendingRequests.delete(pending)) {
      return;
    }
    if (pending.deliverResult) {
      try {
        this.sendMessage(result);
      } finally {
        if (result.ok) {
          this.pickerEnabled = pending.enabled;
        }
        pending.resolve({ result, delivered: true });
      }
      return;
    }
    if (result.ok) {
      this.pickerEnabled = pending.enabled;
    }
    pending.resolve({ result, delivered: false });
  }

  private settlePending(error: string, deliverResult: boolean): void {
    for (const pending of [...this.pendingRequests]) {
      this.pendingRequests.delete(pending);
      const result: InspectPortResult = {
        type: "pin-op.inspect.result",
        requestId: pending.requestId,
        ok: false,
        error,
      };
      if (deliverResult) {
        try {
          this.sendMessage(result);
        } catch {
          // Retiring ownership must continue if the panel disappears.
        }
      }
      pending.resolve({ result, delivered: deliverResult });
    }
  }

  private close(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.lastOperation = this.coordinator.release(this.owner, this.tabId)
      .catch(() => undefined);
  }

  private handleInvalidation(reason: InspectSessionInvalidationReason): void {
    if (this.disconnected) {
      return;
    }
    try {
      this.sendMessage({
        type: "pin-op.inspect.invalidated",
        reason: "documentDisconnected",
      });
    } finally {
      this.lifecycle.onInvalidated?.(reason);
    }
  }

  private handleContentLeaseAttached(contentSessionId: ContentSessionId): void {
    if (this.disconnected) {
      return;
    }
    this.lifecycle.onContentLeaseAttached?.(contentSessionId);
  }

  private handleContentLeaseReplacing(
    previousContentSessionId: ContentSessionId,
    nextContentSessionId: ContentSessionId,
  ): void {
    if (this.disconnected) return;
    this.lifecycle.onContentLeaseReplacing?.(
      previousContentSessionId,
      nextContentSessionId,
    );
  }
}

export interface BackgroundInspectSessionOutcome {
  readonly result: InspectPortResult;
  readonly delivered: boolean;
}

interface PendingInspectRequest {
  readonly requestId: string;
  readonly enabled: boolean;
  readonly deliverResult: boolean;
  readonly resolve: (outcome: BackgroundInspectSessionOutcome) => void;
}

export function attachBackgroundInspectSession(
  port: BackgroundInspectPort,
  coordinator: BackgroundInspectCoordinator,
  trustedTabId: number,
): BackgroundInspectSession {
  const safePost = (
    result: InspectPortResult | InspectPortInvalidated,
  ): void => {
    try {
      port.postMessage(result);
    } catch {
      // The panel can disappear between completion and acknowledgement.
    }
  };
  const session = new BackgroundInspectSession(
    coordinator,
    trustedTabId,
    safePost,
  );
  const onMessage = (message: unknown): void => {
    session.handleMessage(message);
  };
  const onDisconnect = (): void => {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    session.disconnect();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  return session;
}
