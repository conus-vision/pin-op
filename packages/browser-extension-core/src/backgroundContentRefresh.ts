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
  readonly onError?: (error: unknown) => void;
}

interface ReadyWaiter {
  readonly resolve: (binding: ContentRefreshBinding) => void;
  readonly reject: (error: Error) => void;
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
  private readonly onError: BackgroundContentRefreshCoordinatorOptions["onError"];
  private readonly provisional = new Map<number, ContentRefreshBinding>();
  private readonly ready = new Map<number, ContentRefreshBinding>();
  private readonly readyWaiters = new Map<number, Set<ReadyWaiter>>();
  private readonly readinessAttempts = new Map<number, Promise<ContentRefreshBinding>>();
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
    this.onError = options.onError;
  }

  public async dispatch(
    tabId: number,
    command: RefreshExecutionCommand,
  ): Promise<void> {
    if (this.disposed || !isBrowserId(tabId)) return;
    const binding = await this.ensureReady(tabId);
    if (this.disposed || this.ready.get(tabId) !== binding) return;
    const contentCommand = parseContentRefreshCommand({
      type: "pin-op.refresh.content.execute",
      ...binding,
      refreshGeneration: command.refreshGeneration,
      mode: command.mode,
    });
    if (!contentCommand) throw new TypeError("Invalid content refresh command");
    const response = parseContentRefreshResult(
      await this.sendTopFrameMessage(tabId, contentCommand),
    );
    if (
      !response ||
      !sameBinding(response, binding) ||
      response.refreshGeneration !== command.refreshGeneration ||
      response.mode !== command.mode
    ) {
      throw new Error("Content refresh returned an invalid result");
    }
  }

  public routeMessage(
    message: unknown,
    sender: ContentRefreshMessageSender,
  ): Promise<unknown> {
    if (this.disposed) return Promise.resolve(undefined);
    const bootstrap = parseContentRefreshBootstrapRequest(message);
    if (bootstrap) {
      const tabId = trustedTopSenderTab(sender, bootstrap.pageUrl);
      if (tabId === undefined) return Promise.resolve(undefined);
      const binding = freezeBinding({
        tabId,
        frameId: 0,
        pageUrl: bootstrap.pageUrl,
        contentRuntimeId: bootstrap.contentRuntimeId,
      });
      this.provisional.set(tabId, binding);
      if (!sameBinding(this.ready.get(tabId), binding)) this.ready.delete(tabId);
      return Promise.resolve(parseContentRefreshBootstrapResult({
        type: "pin-op.refresh.content.bootstrap.result",
        accepted: true,
        ...binding,
      }));
    }

    const ready = parseContentRefreshReadyRequest(message);
    if (ready) {
      const tabId = trustedBoundSenderTab(sender, ready);
      if (tabId === undefined) return Promise.resolve(undefined);
      return this.enqueueTab(tabId, () => this.acceptReady(ready));
    }

    const reload = parseReloadTabRequest(message);
    if (reload) {
      const tabId = trustedBoundSenderTab(sender, reload);
      if (tabId === undefined) return Promise.resolve(undefined);
      return this.enqueueTab(tabId, () => this.acceptReload(reload));
    }
    return Promise.resolve(undefined);
  }

  public async tabUpdated(
    tabId: number,
    update: BackgroundTabUpdate,
    participant: boolean,
  ): Promise<void> {
    if (this.disposed || !isBrowserId(tabId)) return;
    if (update.status === "loading") {
      this.clearRuntime(tabId, new Error("Content document navigated"));
    }
    if (!participant || update.status !== "complete") return;
    const pageUrl = normalizedPageUrl(update.url);
    if (!pageUrl) return;
    const stored = parseTopScrollSnapshot(await this.storage.read(tabId));
    if (!stored || stored.url !== pageUrl) return;
    try {
      await this.executeContentScript(tabId);
    } catch (error) {
      this.report(error);
    }
  }

  public async removeTab(tabId: number): Promise<void> {
    if (!isBrowserId(tabId)) return;
    this.clearRuntime(tabId, new Error("Content tab removed"));
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
    ])) {
      this.clearRuntime(tabId, new Error("Content refresh coordinator disposed"));
    }
    this.tabTails.clear();
  }

  private async acceptReady(
    request: ReturnType<typeof parseContentRefreshReadyRequest> & object,
  ): Promise<unknown> {
    const provisional = this.provisional.get(request.tabId);
    const current = this.ready.get(request.tabId);
    if (!sameBinding(provisional, request) && !sameBinding(current, request)) {
      return undefined;
    }
    const binding = freezeBinding(request);
    this.provisional.set(request.tabId, binding);
    this.ready.set(request.tabId, binding);
    this.resolveReady(request.tabId, binding);

    const raw = await this.storage.read(request.tabId);
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
    return snapshot
      ? parseScrollRestoreCommand({
          type: "pin-op.refresh.scroll.restore",
          ...binding,
          refreshGeneration: snapshot.refreshGeneration,
          snapshot,
        })
      : undefined;
  }

  private async acceptReload(
    request: NonNullable<ReturnType<typeof parseReloadTabRequest>>,
  ): Promise<unknown> {
    const binding = this.ready.get(request.tabId);
    if (!sameBinding(binding, request)) return undefined;
    let accepted = false;
    try {
      await this.leases.persist(request.snapshot);
      if (!sameBinding(this.ready.get(request.tabId), request)) {
        throw new Error("Content runtime changed before reload");
      }
      await this.reloadTab(request.tabId);
      accepted = true;
      this.clearBinding(
        request.tabId,
        request,
        new Error("Content tab reloading"),
      );
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
      refreshGeneration: request.refreshGeneration,
      accepted,
    });
  }

  private ensureReady(tabId: number): Promise<ContentRefreshBinding> {
    const current = this.ready.get(tabId);
    if (current) return Promise.resolve(current);
    const existing = this.readinessAttempts.get(tabId);
    if (existing) return existing;
    const attempt = this.startReadinessAttempt(tabId);
    this.readinessAttempts.set(tabId, attempt);
    void attempt.finally(() => {
      if (this.readinessAttempts.get(tabId) === attempt) {
        this.readinessAttempts.delete(tabId);
      }
    }).catch(() => undefined);
    return attempt;
  }

  private async startReadinessAttempt(tabId: number): Promise<ContentRefreshBinding> {
    const readiness = this.waitForReady(tabId);
    try {
      await this.executeContentScript(tabId);
      return this.ready.get(tabId) ?? await readiness.promise;
    } catch (error) {
      readiness.cancel();
      await readiness.promise.catch(() => undefined);
      throw error;
    }
  }

  private waitForReady(tabId: number): {
    readonly promise: Promise<ContentRefreshBinding>;
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
    const promise = new Promise<ContentRefreshBinding>((resolve, reject) => {
      waiter = {
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

  private resolveReady(tabId: number, binding: ContentRefreshBinding): void {
    for (const waiter of [...(this.readyWaiters.get(tabId) ?? [])]) {
      waiter.resolve(binding);
    }
  }

  private clearRuntime(tabId: number, reason: Error): void {
    this.provisional.delete(tabId);
    this.ready.delete(tabId);
    for (const waiter of [...(this.readyWaiters.get(tabId) ?? [])]) {
      waiter.reject(reason);
    }
    this.readyWaiters.delete(tabId);
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

function trustedTopSenderTab(
  sender: ContentRefreshMessageSender,
  expectedUrl: string,
): number | undefined {
  const tabId = sender.tab?.id;
  return sender.frameId === 0 &&
      isBrowserId(tabId) &&
      normalizedPageUrl(sender.url) === expectedUrl
    ? tabId
    : undefined;
}

function trustedBoundSenderTab(
  sender: ContentRefreshMessageSender,
  binding: ContentRefreshBinding,
): number | undefined {
  const tabId = trustedTopSenderTab(sender, binding.pageUrl);
  return tabId === binding.tabId ? tabId : undefined;
}

function freezeBinding(binding: ContentRefreshBinding): ContentRefreshBinding {
  return Object.freeze({
    tabId: binding.tabId,
    frameId: 0,
    pageUrl: binding.pageUrl,
    contentRuntimeId: binding.contentRuntimeId,
  });
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
