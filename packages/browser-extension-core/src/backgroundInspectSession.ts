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

export interface BackgroundInspectApi {
  executeScript(details: {
    target: { tabId: number };
    files: string[];
  }): Promise<unknown>;
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
}

interface TabInspectState {
  queue: Promise<void>;
  owner: ActiveInspectOwner | undefined;
}

interface ActiveInspectOwner {
  readonly token: object;
  readonly onInvalidated: (reason: InspectSessionInvalidationReason) => void;
  readonly onContentLeaseAttached: (contentSessionId: ContentSessionId) => void;
}

export type InspectSessionInvalidationReason =
  | "documentDisconnected"
  | "injectionFailed";

export interface BackgroundInspectSessionLifecycle {
  readonly onInvalidated?: (reason: InspectSessionInvalidationReason) => void;
  readonly onContentLeaseAttached?: (
    contentSessionId: ContentSessionId,
  ) => void;
}

export class BackgroundInspectCoordinator {
  private readonly tabs = new Map<number, TabInspectState>();
  private readonly leases = new BackgroundInspectLeaseRegistry();

  public constructor(private readonly api: BackgroundInspectApi) {}

  public attach(
    owner: object,
    tabId: number,
    onInvalidated: (
      reason: InspectSessionInvalidationReason,
    ) => void = () => {},
    onContentLeaseAttached: (contentSessionId: ContentSessionId) => void =
      () => {},
  ): Promise<void> {
    const state = this.stateFor(tabId);
    if (state.owner?.token === owner) {
      return state.queue;
    }
    state.owner = { token: owner, onInvalidated, onContentLeaseAttached };
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
    this.leases.release(tabId);
    return this.enqueue(state, async () => {
      try {
        await this.api.sendTabMessage(tabId, {
          type: "browser2ide.inspect.disposeSession",
        });
      } catch {
        // Disconnecting the content lease already makes the session inert.
      }
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
      try {
        port.disconnect();
      } catch {
        // The content script may have disappeared before registration.
      }
      return;
    }
    this.leases.attach(tabId, port, () =>
      this.invalidateContentOwner(tabId),
    );
    try {
      owner.onContentLeaseAttached(contentSessionId);
    } catch {
      // Recovery bookkeeping cannot invalidate an accepted content lease.
    }
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
    };
    this.tabs.set(tabId, created);
    return created;
  }

  private enqueue(
    state: TabInspectState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const result = state.queue.then(operation);
    state.queue = result.catch(() => undefined);
    return result;
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
          type: "browser2ide.inspect.result",
          requestId: request.requestId,
          ok: true,
        });
      },
      () => {
        this.finishRequest(pending, {
          type: "browser2ide.inspect.result",
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
        type: "browser2ide.inspect.result",
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
        type: "browser2ide.inspect.invalidated",
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
