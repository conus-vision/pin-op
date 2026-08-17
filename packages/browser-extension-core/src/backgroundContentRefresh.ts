import type { SessionStorage } from "./browserWindowLinkStore.js";
import {
  parseContentRefreshBootstrapRequest,
  parseContentRefreshBootstrapResult,
  parseContentRefreshCommand,
  parseContentRefreshReadyRequest,
  parseContentRefreshResult,
  parseReloadTabRequest,
  parseReloadTabResult,
  parseScrollRestoreCommand,
  type ContentRefreshBinding,
  type RefreshExecutionCommand,
} from "./refreshRuntimeProtocol.js";
import {
  parseTopScrollSnapshot,
  TopScrollSnapshotLeaseStore,
  type TopScrollSnapshot,
  type TopScrollSnapshotStorage,
} from "./topScrollRestoration.js";

const SNAPSHOT_KEY_PREFIX = "pin-op.top-scroll.";
const DEFAULT_READY_TIMEOUT_MS = 1_500;

export interface ContentRefreshMessageSender {
  readonly url?: string;
  readonly frameId?: number;
  readonly tab?: {
    readonly id?: number;
    readonly windowId?: number;
  };
}

export interface BackgroundTabUpdate {
  readonly status?: "loading" | "complete";
  readonly url?: string;
  readonly windowId?: number;
}

export interface BackgroundContentRefreshCoordinatorOptions {
  readonly snapshotStorage: TopScrollSnapshotStorage;
  readonly executeContentScript: (tabId: number) => Promise<unknown>;
  readonly sendTopFrameMessage: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly reloadTab: (tabId: number) => Promise<unknown>;
  readonly now?: () => number;
  readonly readyTimeoutMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly createRefreshCommandId?: () => string;
  readonly onError?: (error: unknown) => void;
}

interface ReadyWaiter {
  readonly lifecycleEpoch: number;
  readonly resolve: (binding: OwnedContentRefreshBinding) => void;
  readonly reject: (error: Error) => void;
}

interface TabLifecycle {
  lifecycleEpoch: number;
  windowId?: number;
  pageUrl?: string;
  participant: boolean;
  detached: boolean;
  blockedRuntimeId?: string;
  preserveSnapshot: boolean;
}

interface OwnedContentRefreshBinding extends ContentRefreshBinding {
  readonly windowId: number;
  readonly lifecycleEpoch: number;
}

interface RefreshCommandLease extends OwnedContentRefreshBinding {
  readonly refreshCommandId: string;
  readonly refreshGeneration: number;
  readonly mode: RefreshExecutionCommand["mode"];
  consumed: boolean;
}

interface ReadinessAttempt {
  readonly lifecycleEpoch: number;
  readonly promise: Promise<OwnedContentRefreshBinding>;
}

export class SessionTopScrollSnapshotStorage
  implements TopScrollSnapshotStorage {
  public constructor(private readonly storage: SessionStorage) {}

  public async read(tabId: number): Promise<unknown> {
    const key = snapshotKey(tabId);
    const record = await this.storage.get(key);
    return ownDataValue(record, key);
  }

  public async write(snapshot: TopScrollSnapshot): Promise<void> {
    const parsed = parseTopScrollSnapshot(snapshot);
    if (!parsed) throw new TypeError("Invalid top scroll snapshot");
    const key = snapshotKey(parsed.tabId);
    await this.storage.set({ [key]: parsed });
  }

  public remove(tabId: number): Promise<void> {
    return this.storage.remove(snapshotKey(tabId));
  }
}

export class BackgroundContentRefreshCoordinator {
  private readonly storage: TopScrollSnapshotStorage;
  private readonly leases: TopScrollSnapshotLeaseStore;
  private readonly executeContentScript: BackgroundContentRefreshCoordinatorOptions["executeContentScript"];
  private readonly sendTopFrameMessage: BackgroundContentRefreshCoordinatorOptions["sendTopFrameMessage"];
  private readonly reloadTab: BackgroundContentRefreshCoordinatorOptions["reloadTab"];
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly cancel: typeof globalThis.clearTimeout;
  private readonly createRefreshCommandId: () => string;
  private readonly onError: BackgroundContentRefreshCoordinatorOptions["onError"];
  private readonly lifecycle = new Map<number, TabLifecycle>();
  private readonly eligibleWindows = new Set<number>();
  private readonly provisional = new Map<number, OwnedContentRefreshBinding>();
  private readonly ready = new Map<number, OwnedContentRefreshBinding>();
  private readonly commandLeases = new Map<number, RefreshCommandLease>();
  private readonly readyWaiters = new Map<number, Set<ReadyWaiter>>();
  private readonly readinessAttempts = new Map<number, ReadinessAttempt>();
  private readonly tabTails = new Map<number, Promise<void>>();
  private disposed = false;

  public constructor(options: BackgroundContentRefreshCoordinatorOptions) {
    this.storage = options.snapshotStorage;
    this.leases = new TopScrollSnapshotLeaseStore(options.snapshotStorage);
    this.executeContentScript = options.executeContentScript;
    this.sendTopFrameMessage = options.sendTopFrameMessage;
    this.reloadTab = options.reloadTab;
    this.now = options.now ?? Date.now;
    this.readyTimeoutMs = validTimeout(options.readyTimeoutMs);
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout;
    this.createRefreshCommandId = options.createRefreshCommandId ??
      defaultRefreshCommandId;
    this.onError = options.onError;
  }

  public async dispatch(
    tabId: number,
    command: RefreshExecutionCommand,
  ): Promise<void> {
    if (this.disposed || !isBrowserId(tabId)) return;
    this.commandLeases.delete(tabId);
    const lifecycle = this.authorizedLifecycle(tabId);
    if (!lifecycle) throw new Error("Content refresh tab is not eligible");
    const lifecycleEpoch = lifecycle.lifecycleEpoch;
    const binding = await this.ensureReady(tabId, lifecycleEpoch);
    if (!this.isCurrentBinding(binding)) {
      throw new Error("Content refresh command revoked");
    }
    const refreshCommandId = this.nextRefreshCommandId();
    const lease: RefreshCommandLease = {
      ...binding,
      refreshCommandId,
      refreshGeneration: command.refreshGeneration,
      mode: command.mode,
      consumed: false,
    };
    this.commandLeases.set(tabId, lease);
    const contentCommand = parseContentRefreshCommand({
      type: "pin-op.refresh.content.execute",
      ...publicBinding(binding),
      refreshCommandId,
      refreshGeneration: command.refreshGeneration,
      mode: command.mode,
    });
    if (!contentCommand) throw new TypeError("Invalid content refresh command");
    try {
      const response = parseContentRefreshResult(
        await this.sendTopFrameMessage(tabId, contentCommand),
      );
      if (this.commandLeases.get(tabId) !== lease || !this.isLeaseCurrent(lease)) {
        throw new Error("Content refresh command revoked");
      }
      if (
        !response ||
        !sameBinding(response, lease) ||
        response.refreshCommandId !== lease.refreshCommandId ||
        response.refreshGeneration !== command.refreshGeneration ||
        response.mode !== command.mode ||
        (command.mode === "reload" && response.accepted && !lease.consumed)
      ) {
        throw new Error("Content refresh returned an invalid result");
      }
      if (!response.accepted) {
        throw new Error("Content refresh command was rejected");
      }
    } finally {
      if (this.commandLeases.get(tabId) === lease) {
        this.commandLeases.delete(tabId);
      }
    }
  }

  public setTabParticipation(
    tabId: number,
    windowId: number,
    participant: boolean,
  ): void {
    if (!isBrowserId(tabId) || !isBrowserId(windowId) || this.disposed) return;
    const lifecycle = this.lifecycleFor(tabId);
    if (!participant) {
      if (lifecycle.windowId === undefined || lifecycle.windowId === windowId) {
        this.invalidateLifecycle(tabId, lifecycle, new Error(
          "Content refresh participation revoked",
        ), true);
        lifecycle.windowId = windowId;
        lifecycle.participant = false;
      }
      return;
    }
    if (lifecycle.detached ||
      (lifecycle.windowId !== undefined && lifecycle.windowId !== windowId)) {
      this.invalidateLifecycle(
        tabId,
        lifecycle,
        new Error("Content refresh tab ownership changed"),
        true,
      );
    }
    lifecycle.windowId = windowId;
    lifecycle.participant = true;
    lifecycle.detached = false;
  }

  public setWindowEligibility(windowId: number, eligible: boolean): void {
    if (!isBrowserId(windowId) || this.disposed) return;
    if (eligible) {
      this.eligibleWindows.add(windowId);
      return;
    }
    this.eligibleWindows.delete(windowId);
    this.revokeWindow(windowId);
  }

  public revokeTab(tabId: number): void {
    if (!isBrowserId(tabId) || this.disposed) return;
    const lifecycle = this.lifecycleFor(tabId);
    this.invalidateLifecycle(
      tabId,
      lifecycle,
      new Error("Content refresh tab revoked"),
      true,
    );
    lifecycle.participant = false;
  }

  public revokeWindow(windowId: number): void {
    if (!isBrowserId(windowId) || this.disposed) return;
    this.eligibleWindows.delete(windowId);
    for (const [tabId, lifecycle] of this.lifecycle) {
      if (lifecycle.windowId !== windowId) continue;
      this.invalidateLifecycle(
        tabId,
        lifecycle,
        new Error("Content refresh window revoked"),
        true,
      );
    }
  }

  public observeTabUpdate(tabId: number, update: BackgroundTabUpdate): void {
    if (!isBrowserId(tabId) || this.disposed) return;
    const lifecycle = this.lifecycleFor(tabId);
    if (lifecycle.detached) return;
    if (isBrowserId(update.windowId)) {
      if (lifecycle.windowId !== undefined && lifecycle.windowId !== update.windowId) {
        this.invalidateLifecycle(
          tabId,
          lifecycle,
          new Error("Content refresh tab window changed"),
          true,
        );
        lifecycle.participant = false;
        lifecycle.detached = true;
        return;
      }
      lifecycle.windowId = update.windowId;
    }
    const pageUrl = normalizedPageUrl(update.url);
    const knownUrl = lifecycle.pageUrl ?? this.ready.get(tabId)?.pageUrl ??
      this.provisional.get(tabId)?.pageUrl;
    const urlChanged = pageUrl !== undefined && knownUrl !== undefined &&
      pageUrl !== knownUrl;
    if (update.status === "loading" || urlChanged) {
      const currentRuntimeId = this.ready.get(tabId)?.contentRuntimeId ??
        this.provisional.get(tabId)?.contentRuntimeId;
      const preserveSnapshot = lifecycle.preserveSnapshot && !urlChanged;
      this.invalidateLifecycle(
        tabId,
        lifecycle,
        new Error("Content document navigated"),
        !preserveSnapshot,
      );
      lifecycle.pageUrl = pageUrl;
      lifecycle.blockedRuntimeId = update.status === "loading"
        ? currentRuntimeId ?? lifecycle.blockedRuntimeId
        : undefined;
      lifecycle.preserveSnapshot = preserveSnapshot;
      return;
    }
    if (pageUrl !== undefined) lifecycle.pageUrl = pageUrl;
  }

  public routeMessage(
    message: unknown,
    sender: ContentRefreshMessageSender,
  ): Promise<unknown> {
    if (this.disposed) return Promise.resolve(undefined);
    const bootstrap = parseContentRefreshBootstrapRequest(message);
    if (bootstrap) {
      const identity = trustedTopSender(sender, bootstrap.pageUrl);
      if (!identity) return Promise.resolve(undefined);
      const lifecycle = this.authorizedLifecycle(identity.tabId, identity.windowId);
      if (!lifecycle ||
        (lifecycle.pageUrl !== undefined && lifecycle.pageUrl !== bootstrap.pageUrl) ||
        lifecycle.blockedRuntimeId === bootstrap.contentRuntimeId) {
        return Promise.resolve(undefined);
      }
      lifecycle.pageUrl = bootstrap.pageUrl;
      lifecycle.blockedRuntimeId = undefined;
      const binding = freezeOwnedBinding({
        windowId: identity.windowId,
        lifecycleEpoch: lifecycle.lifecycleEpoch,
        tabId: identity.tabId,
        frameId: 0,
        pageUrl: bootstrap.pageUrl,
        contentRuntimeId: bootstrap.contentRuntimeId,
      });
      this.provisional.set(identity.tabId, binding);
      if (!sameOwnedBinding(this.ready.get(identity.tabId), binding)) {
        this.ready.delete(identity.tabId);
      }
      this.commandLeases.delete(identity.tabId);
      return Promise.resolve(parseContentRefreshBootstrapResult({
        type: "pin-op.refresh.content.bootstrap.result",
        accepted: true,
        ...publicBinding(binding),
      }));
    }

    const ready = parseContentRefreshReadyRequest(message);
    if (ready) {
      const owned = this.trustedCurrentBinding(sender, ready);
      if (!owned) return Promise.resolve(undefined);
      return this.enqueueTab(ready.tabId, () => this.acceptReady(ready, owned));
    }

    const reload = parseReloadTabRequest(message);
    if (reload) {
      const lease = this.trustedCurrentLease(sender, reload);
      if (!lease) return Promise.resolve(undefined);
      return this.enqueueTab(reload.tabId, () => this.acceptReload(reload, lease));
    }
    return Promise.resolve(undefined);
  }

  public async tabUpdated(
    tabId: number,
    update: BackgroundTabUpdate,
    participant: boolean,
  ): Promise<void> {
    if (this.disposed || !isBrowserId(tabId)) return;
    this.observeTabUpdate(tabId, update);
    if (!participant || update.status !== "complete") return;
    const pageUrl = normalizedPageUrl(update.url);
    if (!pageUrl) return;
    const lifecycle = this.authorizedLifecycle(tabId, update.windowId);
    if (!lifecycle || lifecycle.pageUrl !== pageUrl) return;
    const lifecycleEpoch = lifecycle.lifecycleEpoch;
    const stored = parseTopScrollSnapshot(await this.storage.read(tabId));
    if (!this.isCurrentLifecycle(tabId, lifecycleEpoch)) return;
    if (!stored || stored.url !== pageUrl) return;
    try {
      await this.executeContentScript(tabId);
      if (!this.isCurrentLifecycle(tabId, lifecycleEpoch)) return;
    } catch (error) {
      this.report(error);
    }
  }

  public async removeTab(tabId: number): Promise<void> {
    if (!isBrowserId(tabId)) return;
    const lifecycle = this.lifecycleFor(tabId);
    this.invalidateLifecycle(
      tabId,
      lifecycle,
      new Error("Content tab removed"),
      false,
    );
    lifecycle.participant = false;
    lifecycle.detached = true;
    await this.storage.remove(tabId);
  }

  public detachTab(tabId: number): Promise<void> {
    return this.removeTab(tabId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tabId of new Set([
      ...this.provisional.keys(),
      ...this.ready.keys(),
      ...this.readyWaiters.keys(),
      ...this.lifecycle.keys(),
    ])) {
      const lifecycle = this.lifecycleFor(tabId);
      this.invalidateLifecycle(
        tabId,
        lifecycle,
        new Error("Content refresh coordinator disposed"),
        false,
      );
    }
    this.eligibleWindows.clear();
    this.tabTails.clear();
  }

  private async acceptReady(
    request: ReturnType<typeof parseContentRefreshReadyRequest> & object,
    owned: OwnedContentRefreshBinding,
  ): Promise<unknown> {
    if (!this.isCurrentBinding(owned)) return undefined;
    const provisional = this.provisional.get(request.tabId);
    const current = this.ready.get(request.tabId);
    if (!sameOwnedBinding(provisional, owned) && !sameOwnedBinding(current, owned)) {
      return undefined;
    }
    this.provisional.set(request.tabId, owned);
    this.ready.set(request.tabId, owned);
    this.resolveReady(request.tabId, owned);

    const raw = await this.storage.read(request.tabId);
    if (!this.isCurrentBinding(owned)) return undefined;
    if (raw === undefined) return undefined;
    const stored = parseTopScrollSnapshot(raw);
    if (!stored || stored.url !== request.pageUrl) {
      await this.storage.remove(request.tabId);
      return undefined;
    }
    const snapshot = await this.leases.claim({
      tabId: request.tabId,
      url: request.pageUrl,
      refreshGeneration: stored.refreshGeneration,
      now: this.now(),
    });
    if (!this.isCurrentBinding(owned)) return undefined;
    const lifecycle = this.lifecycle.get(request.tabId);
    if (snapshot && lifecycle) lifecycle.preserveSnapshot = false;
    return snapshot
      ? parseScrollRestoreCommand({
          type: "pin-op.refresh.scroll.restore",
          ...publicBinding(owned),
          refreshGeneration: snapshot.refreshGeneration,
          snapshot,
        })
      : undefined;
  }

  private async acceptReload(
    request: NonNullable<ReturnType<typeof parseReloadTabRequest>>,
    lease: RefreshCommandLease,
  ): Promise<unknown> {
    if (this.commandLeases.get(request.tabId) !== lease ||
      !this.isLeaseCurrent(lease) || lease.consumed) return undefined;
    lease.consumed = true;
    let accepted = false;
    try {
      await this.leases.persist(request.snapshot);
      if (this.commandLeases.get(request.tabId) !== lease ||
        !this.isLeaseCurrent(lease)) {
        throw new Error("Content refresh command revoked");
      }
      await this.reloadTab(request.tabId);
      if (this.commandLeases.get(request.tabId) !== lease ||
        !this.isLeaseCurrent(lease)) {
        throw new Error("Content refresh command revoked");
      }
      accepted = true;
      const lifecycle = this.lifecycle.get(request.tabId);
      if (lifecycle) {
        lifecycle.preserveSnapshot = true;
        lifecycle.blockedRuntimeId = request.contentRuntimeId;
      }
      this.clearBinding(request.tabId, lease, new Error("Content tab reloading"));
    } catch (error) {
      try {
        await this.storage.remove(request.tabId);
      } catch (cleanupError) {
        this.report(cleanupError);
      }
      this.report(error);
    }
    return parseReloadTabResult({
      type: "pin-op.refresh.reload.result",
      tabId: request.tabId,
      frameId: 0,
      pageUrl: request.pageUrl,
      contentRuntimeId: request.contentRuntimeId,
      refreshCommandId: request.refreshCommandId,
      refreshGeneration: request.refreshGeneration,
      accepted,
    });
  }

  private ensureReady(
    tabId: number,
    lifecycleEpoch: number,
  ): Promise<OwnedContentRefreshBinding> {
    const current = this.ready.get(tabId);
    if (current?.lifecycleEpoch === lifecycleEpoch && this.isCurrentBinding(current)) {
      return Promise.resolve(current);
    }
    const existing = this.readinessAttempts.get(tabId);
    if (existing?.lifecycleEpoch === lifecycleEpoch) return existing.promise;
    const promise = this.startReadinessAttempt(tabId, lifecycleEpoch);
    const attempt = { lifecycleEpoch, promise };
    this.readinessAttempts.set(tabId, attempt);
    void promise.finally(() => {
      if (this.readinessAttempts.get(tabId)?.promise === promise) {
        this.readinessAttempts.delete(tabId);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async startReadinessAttempt(
    tabId: number,
    lifecycleEpoch: number,
  ): Promise<OwnedContentRefreshBinding> {
    if (!this.isCurrentLifecycle(tabId, lifecycleEpoch)) {
      throw new Error("Content refresh readiness revoked");
    }
    const readiness = this.waitForReady(tabId, lifecycleEpoch);
    try {
      await this.executeContentScript(tabId);
      if (!this.isCurrentLifecycle(tabId, lifecycleEpoch)) {
        throw new Error("Content refresh readiness revoked");
      }
      const current = this.ready.get(tabId);
      return current?.lifecycleEpoch === lifecycleEpoch
        ? current
        : await readiness.promise;
    } catch (error) {
      readiness.cancel();
      await readiness.promise.catch(() => undefined);
      throw error;
    }
  }

  private waitForReady(tabId: number, lifecycleEpoch: number): {
    readonly promise: Promise<OwnedContentRefreshBinding>;
    readonly cancel: () => void;
  } {
    let waiter: ReadyWaiter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const remove = (): void => {
      const waiters = this.readyWaiters.get(tabId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) this.readyWaiters.delete(tabId);
      if (timer !== undefined) {
        this.cancel(timer);
        timer = undefined;
      }
    };
    const promise = new Promise<OwnedContentRefreshBinding>((resolve, reject) => {
      waiter = {
        lifecycleEpoch,
        resolve: (binding) => {
          if (settled) return;
          settled = true;
          remove();
          resolve(binding);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          remove();
          reject(error);
        },
      };
      const waiters = this.readyWaiters.get(tabId) ?? new Set<ReadyWaiter>();
      waiters.add(waiter);
      this.readyWaiters.set(tabId, waiters);
      timer = this.schedule(
        () => waiter.reject(new Error("Content refresh runtime did not become ready")),
        this.readyTimeoutMs,
      );
    });
    return {
      promise,
      cancel: () => waiter.reject(new Error("Content refresh readiness cancelled")),
    };
  }

  private resolveReady(tabId: number, binding: OwnedContentRefreshBinding): void {
    for (const waiter of [...(this.readyWaiters.get(tabId) ?? [])]) {
      if (waiter.lifecycleEpoch === binding.lifecycleEpoch) waiter.resolve(binding);
    }
  }

  private clearRuntime(tabId: number, reason: Error): void {
    this.provisional.delete(tabId);
    this.ready.delete(tabId);
    this.commandLeases.delete(tabId);
    for (const waiter of [...(this.readyWaiters.get(tabId) ?? [])]) {
      waiter.reject(reason);
    }
    this.readyWaiters.delete(tabId);
    this.readinessAttempts.delete(tabId);
  }

  private clearBinding(
    tabId: number,
    binding: ContentRefreshBinding,
    reason: Error,
  ): void {
    let cleared = false;
    if (sameBinding(this.provisional.get(tabId), binding)) {
      this.provisional.delete(tabId);
      cleared = true;
    }
    if (sameBinding(this.ready.get(tabId), binding)) {
      this.ready.delete(tabId);
      cleared = true;
    }
    if (!cleared) return;
    for (const waiter of [...(this.readyWaiters.get(tabId) ?? [])]) {
      waiter.reject(reason);
    }
    this.readyWaiters.delete(tabId);
  }

  private lifecycleFor(tabId: number): TabLifecycle {
    const existing = this.lifecycle.get(tabId);
    if (existing) return existing;
    const created: TabLifecycle = {
      lifecycleEpoch: 0,
      participant: false,
      detached: false,
      preserveSnapshot: false,
    };
    this.lifecycle.set(tabId, created);
    return created;
  }

  private authorizedLifecycle(
    tabId: number,
    expectedWindowId?: number,
  ): TabLifecycle | undefined {
    const lifecycle = this.lifecycle.get(tabId);
    if (!lifecycle || !lifecycle.participant || lifecycle.detached ||
      !isBrowserId(lifecycle.windowId) ||
      !this.eligibleWindows.has(lifecycle.windowId) ||
      (expectedWindowId !== undefined && lifecycle.windowId !== expectedWindowId)) {
      return undefined;
    }
    return lifecycle;
  }

  private invalidateLifecycle(
    tabId: number,
    lifecycle: TabLifecycle,
    reason: Error,
    removeSnapshot: boolean,
  ): void {
    lifecycle.lifecycleEpoch += 1;
    lifecycle.preserveSnapshot = false;
    this.clearRuntime(tabId, reason);
    if (removeSnapshot) {
      void this.storage.remove(tabId).catch((error) => this.report(error));
    }
  }

  private isCurrentLifecycle(tabId: number, lifecycleEpoch: number): boolean {
    const lifecycle = this.authorizedLifecycle(tabId);
    return lifecycle?.lifecycleEpoch === lifecycleEpoch;
  }

  private isCurrentBinding(binding: OwnedContentRefreshBinding): boolean {
    const lifecycle = this.authorizedLifecycle(binding.tabId, binding.windowId);
    return lifecycle?.lifecycleEpoch === binding.lifecycleEpoch &&
      lifecycle.pageUrl === binding.pageUrl &&
      sameOwnedBinding(this.ready.get(binding.tabId) ??
        this.provisional.get(binding.tabId), binding);
  }

  private isLeaseCurrent(lease: RefreshCommandLease): boolean {
    if (!this.isCurrentLifecycle(lease.tabId, lease.lifecycleEpoch)) return false;
    if (sameOwnedBinding(this.ready.get(lease.tabId), lease)) return true;
    const lifecycle = this.lifecycle.get(lease.tabId);
    return lease.mode === "reload" && lease.consumed &&
      lifecycle?.blockedRuntimeId === lease.contentRuntimeId;
  }

  private trustedCurrentBinding(
    sender: ContentRefreshMessageSender,
    binding: ContentRefreshBinding,
  ): OwnedContentRefreshBinding | undefined {
    const identity = trustedTopSender(sender, binding.pageUrl);
    if (!identity || identity.tabId !== binding.tabId) return undefined;
    const owned = sameBinding(this.provisional.get(binding.tabId), binding)
      ? this.provisional.get(binding.tabId)
      : sameBinding(this.ready.get(binding.tabId), binding)
      ? this.ready.get(binding.tabId)
      : undefined;
    return owned?.windowId === identity.windowId && this.isCurrentBinding(owned)
      ? owned
      : undefined;
  }

  private trustedCurrentLease(
    sender: ContentRefreshMessageSender,
    request: NonNullable<ReturnType<typeof parseReloadTabRequest>>,
  ): RefreshCommandLease | undefined {
    const identity = trustedTopSender(sender, request.pageUrl);
    const lease = this.commandLeases.get(request.tabId);
    return identity?.tabId === request.tabId &&
        lease?.windowId === identity.windowId &&
        !lease.consumed &&
        lease.mode === "reload" &&
        lease.refreshCommandId === request.refreshCommandId &&
        lease.refreshGeneration === request.refreshGeneration &&
        sameBinding(lease, request) &&
        this.isLeaseCurrent(lease)
      ? lease
      : undefined;
  }

  private nextRefreshCommandId(): string {
    const value = this.createRefreshCommandId();
    if (!isOpaqueId(value)) {
      throw new TypeError("Invalid refresh command ID");
    }
    return value;
  }

  private enqueueTab<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tabTails.get(tabId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tabTails.set(tabId, tail);
    void tail.finally(() => {
      if (this.tabTails.get(tabId) === tail) this.tabTails.delete(tabId);
    });
    return result;
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics cannot change refresh ownership.
    }
  }
}

function sameBinding(
  value: Partial<ContentRefreshBinding> | undefined,
  expected: ContentRefreshBinding,
): boolean {
  return value?.tabId === expected.tabId &&
    value.frameId === 0 &&
    value.pageUrl === expected.pageUrl &&
    value.contentRuntimeId === expected.contentRuntimeId;
}

function sameOwnedBinding(
  value: OwnedContentRefreshBinding | undefined,
  expected: OwnedContentRefreshBinding,
): boolean {
  return sameBinding(value, expected) &&
    value?.windowId === expected.windowId &&
    value.lifecycleEpoch === expected.lifecycleEpoch;
}

function trustedTopSender(
  sender: ContentRefreshMessageSender,
  expectedUrl: string,
): { readonly tabId: number; readonly windowId: number } | undefined {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  return sender.frameId === 0 &&
      isBrowserId(tabId) &&
      isBrowserId(windowId) &&
      normalizedPageUrl(sender.url) === expectedUrl
    ? { tabId, windowId }
    : undefined;
}

function freezeOwnedBinding(
  binding: OwnedContentRefreshBinding,
): OwnedContentRefreshBinding {
  return Object.freeze({
    ...publicBinding(binding),
    windowId: binding.windowId,
    lifecycleEpoch: binding.lifecycleEpoch,
  });
}

function publicBinding(binding: ContentRefreshBinding): ContentRefreshBinding {
  return Object.freeze({
    tabId: binding.tabId,
    frameId: 0,
    pageUrl: binding.pageUrl,
    contentRuntimeId: binding.contentRuntimeId,
  });
}

let refreshCommandSequence = 0;

function defaultRefreshCommandId(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") {
      return randomUuid.call(globalThis.crypto);
    }
  } catch {
    // Use a process-local opaque fallback when extension crypto is unavailable.
  }
  refreshCommandSequence += 1;
  return `refresh-command-${Date.now().toString(36)}-${refreshCommandSequence.toString(36)}`;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

function snapshotKey(tabId: number): string {
  if (!isBrowserId(tabId)) throw new TypeError("Invalid browser tab ID");
  return `${SNAPSHOT_KEY_PREFIX}${tabId}`;
}

function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedPageUrl(value: unknown): string | undefined {
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
      return undefined;
    }
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function validTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 10_000
    ? Number(value)
    : DEFAULT_READY_TIMEOUT_MS;
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
