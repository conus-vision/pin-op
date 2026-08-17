import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import {
  BackgroundContentRefreshCoordinator,
  SessionTopScrollSnapshotStorage,
} from "../src/backgroundContentRefresh.js";
import { captureTopScrollSnapshot } from "../src/topScrollRestoration.js";

describe("BackgroundContentRefreshCoordinator", () => {
  it("injects a missing top runtime and sends one exact bound command", async () => {
    const storage = new MemorySessionStorage();
    let coordinator: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => ({
      ...(message as object),
      type: "pin-op.refresh.content.result",
      accepted: true,
      stylesheet: { attempted: 1, updated: 1, failed: 0 },
    }));
    const executeContentScript = vi.fn(async (tabId: number) => {
      const sender = topSender(tabId, "https://example.test/page");
      await coordinator.routeMessage({
        type: "pin-op.refresh.content.bootstrap",
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-a",
      }, sender);
      await coordinator.routeMessage({
        type: "pin-op.refresh.content.ready",
        tabId,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-a",
      }, sender);
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript,
      sendTopFrameMessage,
      reloadTab: vi.fn(),
    });

    await coordinator.dispatch(21, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 4,
      mode: "styles",
    });

    expect(executeContentScript).toHaveBeenCalledWith(21);
    expect(sendTopFrameMessage).toHaveBeenCalledWith(21, {
      type: "pin-op.refresh.content.execute",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
      refreshGeneration: 4,
      mode: "styles",
    });
  });

  it("cancels its readiness lease when content injection fails", async () => {
    const injectionError = new Error("injection failed");
    const clearTimeout = vi.fn();
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(
        new MemorySessionStorage(),
      ),
      executeContentScript: vi.fn(async () => { throw injectionError; }),
      sendTopFrameMessage: vi.fn(),
      reloadTab: vi.fn(),
      setTimeout: vi.fn(() => 41 as unknown as ReturnType<typeof setTimeout>),
      clearTimeout,
    });

    await expect(coordinator.dispatch(20, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "styles",
    })).rejects.toBe(injectionError);
    expect(clearTimeout).toHaveBeenCalledWith(41);
  });

  it("rejects bootstrap and reload messages outside the exact top binding", async () => {
    const reloadTab = vi.fn();
    const storage = new MemorySessionStorage();
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(),
      sendTopFrameMessage: vi.fn(),
      reloadTab,
    });
    const request = reloadRequest(22, "runtime-b", 6);

    await expect(coordinator.routeMessage(
      { type: "pin-op.refresh.content.bootstrap", pageUrl: request.pageUrl,
        contentRuntimeId: request.contentRuntimeId },
      { ...topSender(22, request.pageUrl), frameId: 1 },
    )).resolves.toBeUndefined();
    await expect(coordinator.routeMessage(request, topSender(23, request.pageUrl)))
      .resolves.toBeUndefined();
    await expect(coordinator.routeMessage(request, topSender(22, "https://example.test/other")))
      .resolves.toBeUndefined();
    expect(reloadTab).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });

  it("persists before reload and removes the lease when reload fails", async () => {
    const events: string[] = [];
    const storage = new MemorySessionStorage(events);
    const reloadTab = vi.fn(async () => {
      events.push("reload");
      throw new Error("reload failed");
    });
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(),
      sendTopFrameMessage: vi.fn(),
      reloadTab,
    });
    const sender = topSender(24, "https://example.test/page");
    await bind(coordinator, sender, "runtime-c");

    await expect(coordinator.routeMessage(
      reloadRequest(24, "runtime-c", 7),
      sender,
    )).resolves.toMatchObject({
      type: "pin-op.refresh.reload.result",
      accepted: false,
      tabId: 24,
      refreshGeneration: 7,
    });

    expect(events).toEqual(["set", "reload", "remove"]);
    expect(storage.values.size).toBe(0);
  });

  it("claims an exact stored scroll snapshot at most once for a new runtime", async () => {
    const storage = new MemorySessionStorage();
    const snapshotStorage = new SessionTopScrollSnapshotStorage(storage);
    await snapshotStorage.write(captureTopScrollSnapshot({
      tabId: 25,
      url: "https://example.test/page",
      refreshGeneration: 8,
      scrollX: 10,
      scrollY: 20,
      createdAt: 1_000,
    }));
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage,
      executeContentScript: vi.fn(),
      sendTopFrameMessage: vi.fn(),
      reloadTab: vi.fn(),
      now: () => 1_100,
    });
    const sender = topSender(25, "https://example.test/page");
    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-d",
    }, sender);
    const ready = {
      type: "pin-op.refresh.content.ready",
      tabId: 25,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-d",
    } as const;

    const first = await coordinator.routeMessage(ready, sender);
    const second = await coordinator.routeMessage(ready, sender);
    expect(first).toEqual({
      type: "pin-op.refresh.scroll.restore",
      tabId: 25,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-d",
      refreshGeneration: 8,
      snapshot: expect.objectContaining({ tabId: 25, refreshGeneration: 8 }),
    });
    expect(second).toBeUndefined();
  });

  it("does not revoke a new-document runtime when reload completion is late", async () => {
    const storage = new MemorySessionStorage();
    const reload = deferred<void>();
    const reloadTab = vi.fn(() => reload.promise);
    const executeContentScript = vi.fn(async () => undefined);
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => ({
      ...(message as object),
      type: "pin-op.refresh.content.result",
      accepted: true,
      stylesheet: { attempted: 0, updated: 0, failed: 0 },
    }));
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript,
      sendTopFrameMessage,
      reloadTab,
      now: () => 600,
    });
    const sender = topSender(27, "https://example.test/page");
    await bind(coordinator, sender, "runtime-old");
    const pendingReload = coordinator.routeMessage(
      reloadRequest(27, "runtime-old", 10),
      sender,
    );
    for (let attempt = 0; attempt < 20 && reloadTab.mock.calls.length === 0; attempt += 1) {
      await flushAsync();
    }
    expect(reloadTab).toHaveBeenCalledWith(27);

    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-new",
    }, sender);
    reload.resolve();
    await pendingReload;
    await coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 27,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-new",
    }, sender);
    await coordinator.dispatch(27, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 11,
      mode: "styles",
    });

    expect(executeContentScript).not.toHaveBeenCalled();
    expect(sendTopFrameMessage).toHaveBeenCalledWith(27, expect.objectContaining({
      contentRuntimeId: "runtime-new",
      refreshGeneration: 11,
    }));
  });

  it("injects after completed reload only for a participating tab and cleans removal", async () => {
    const storage = new MemorySessionStorage();
    const snapshotStorage = new SessionTopScrollSnapshotStorage(storage);
    await snapshotStorage.write(captureTopScrollSnapshot({
      tabId: 26,
      url: "https://example.test/page",
      refreshGeneration: 9,
      scrollX: 0,
      scrollY: 40,
      createdAt: 2_000,
    }));
    const executeContentScript = vi.fn(async () => undefined);
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage,
      executeContentScript,
      sendTopFrameMessage: vi.fn(),
      reloadTab: vi.fn(),
    });

    await coordinator.tabUpdated(26, {
      status: "complete",
      url: "https://example.test/page",
      windowId: 7,
    }, false);
    expect(executeContentScript).not.toHaveBeenCalled();
    await coordinator.tabUpdated(26, {
      status: "complete",
      url: "https://example.test/page",
      windowId: 7,
    }, true);
    expect(executeContentScript).toHaveBeenCalledWith(26);

    await coordinator.removeTab(26);
    expect(storage.values.size).toBe(0);
    await coordinator.tabUpdated(26, {
      status: "complete",
      url: "https://example.test/page",
      windowId: 7,
    }, false);
    expect(executeContentScript).toHaveBeenCalledTimes(1);
  });
});

class MemorySessionStorage implements SessionStorage {
  public readonly values = new Map<string, unknown>();
  public constructor(private readonly events?: string[]) {}
  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }
  public async set(values: Record<string, unknown>): Promise<void> {
    this.events?.push("set");
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  public async remove(key: string): Promise<void> {
    this.events?.push("remove");
    this.values.delete(key);
  }
}

function topSender(tabId: number, url: string) {
  return { url, frameId: 0, tab: { id: tabId, windowId: 7 } } as const;
}

async function bind(
  coordinator: BackgroundContentRefreshCoordinator,
  sender: ReturnType<typeof topSender>,
  contentRuntimeId: string,
): Promise<void> {
  await coordinator.routeMessage({
    type: "pin-op.refresh.content.bootstrap",
    pageUrl: sender.url,
    contentRuntimeId,
  }, sender);
  await coordinator.routeMessage({
    type: "pin-op.refresh.content.ready",
    tabId: sender.tab.id,
    frameId: 0,
    pageUrl: sender.url,
    contentRuntimeId,
  }, sender);
}

function reloadRequest(tabId: number, contentRuntimeId: string, generation: number) {
  const pageUrl = "https://example.test/page";
  return {
    type: "pin-op.refresh.reload.request",
    tabId,
    frameId: 0,
    pageUrl,
    contentRuntimeId,
    refreshGeneration: generation,
    snapshot: captureTopScrollSnapshot({
      tabId,
      url: pageUrl,
      refreshGeneration: generation,
      scrollX: 3,
      scrollY: 5,
      createdAt: 500,
    }),
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
