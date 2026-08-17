import { PROTOCOL_VERSION } from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import {
  BackgroundContentRefreshCoordinator,
  SessionTopScrollSnapshotStorage,
} from "../src/backgroundContentRefresh.js";
import { captureTopScrollSnapshot } from "../src/topScrollRestoration.js";
import { TabRefreshCoordinator } from "../src/tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "../src/tabRefreshStateStore.js";

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
      createRefreshCommandId: () => "command-a",
    });
    authorize(coordinator, 21);

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
      refreshCommandId: "command-a",
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
      createRefreshCommandId: () => "command-b",
    });
    authorize(coordinator, 20);

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
    authorize(coordinator, 22);
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
    let coordinator: BackgroundContentRefreshCoordinator;
    const sender = topSender(24, "https://example.test/page");
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      const reloadResult = await coordinator.routeMessage(reloadRequest(
        24,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      ), sender);
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: (reloadResult as { accepted?: boolean } | undefined)?.accepted === true,
      };
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(coordinator, sender, "runtime-c");
      }),
      sendTopFrameMessage,
      reloadTab,
      createRefreshCommandId: () => "command-reload-failure",
    });
    authorize(coordinator, 24);

    await expect(coordinator.dispatch(24, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 7,
      mode: "reload",
    })).rejects.toThrow("Content refresh command was rejected");

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
    authorize(coordinator, 25);
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

  it("preserves restoration when loading precedes reload Promise completion", async () => {
    const storage = new MemorySessionStorage();
    const reload = deferred<void>();
    const reloadTab = vi.fn(() => reload.promise);
    const executeContentScript = vi.fn(async () => undefined);
    const sender = topSender(27, "https://example.test/page");
    let coordinator: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly mode: "styles" | "reload";
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      if (command.mode === "reload") {
        const result = await coordinator.routeMessage(reloadRequest(
          27,
          command.contentRuntimeId,
          command.refreshGeneration,
          command.refreshCommandId,
        ), sender);
        return {
          ...(message as object),
          type: "pin-op.refresh.content.result",
          accepted: (result as { accepted?: boolean } | undefined)?.accepted === true,
        };
      }
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: true,
        stylesheet: { attempted: 0, updated: 0, failed: 0 },
      };
    });
    const ids = ["command-late", "command-new-document"];
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript,
      sendTopFrameMessage,
      reloadTab,
      now: () => 600,
      createRefreshCommandId: () => ids.shift() ?? "command-exhausted",
    });
    authorize(coordinator, 27);
    await bind(coordinator, sender, "runtime-old");
    const pendingReload = coordinator.dispatch(27, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 10,
      mode: "reload",
    });
    for (let attempt = 0; attempt < 20 && reloadTab.mock.calls.length === 0; attempt += 1) {
      await flushAsync();
    }
    expect(reloadTab).toHaveBeenCalledWith(27);

    coordinator.observeTabUpdate(27, {
      status: "loading",
      url: sender.url,
      windowId: 7,
    });
    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-new",
    }, sender);
    const newReady = coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 27,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-new",
    }, sender);
    reload.resolve();
    await expect(pendingReload).resolves.toBeUndefined();
    await expect(newReady).resolves.toMatchObject({
      type: "pin-op.refresh.scroll.restore",
      contentRuntimeId: "runtime-new",
      refreshGeneration: 10,
      snapshot: expect.objectContaining({ refreshGeneration: 10 }),
    });
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

  it("accepts an exact completed reload when loading destroys its message channel", async () => {
    const storage = new MemorySessionStorage();
    const sender = topSender(37, "https://example.test/page");
    const onError = vi.fn();
    let coordinator: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      const result = await coordinator.routeMessage(reloadRequest(
        37,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      ), sender);
      expect(result).toMatchObject({ accepted: true });
      throw new Error("The message port closed before a response was received");
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(coordinator, sender, "runtime-channel-old");
      }),
      sendTopFrameMessage,
      reloadTab: vi.fn(async () => {
        coordinator.observeTabUpdate(37, {
          status: "loading",
          url: sender.url,
          windowId: 7,
        });
      }),
      now: () => 600,
      createRefreshCommandId: () => "command-channel-destroyed",
      onError,
    });
    authorize(coordinator, 37);

    await expect(coordinator.dispatch(37, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 15,
      mode: "reload",
    })).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();

    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-channel-new",
    }, sender);
    await expect(coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 37,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-channel-new",
    }, sender)).resolves.toMatchObject({
      type: "pin-op.refresh.scroll.restore",
      contentRuntimeId: "runtime-channel-new",
      refreshGeneration: 15,
    });
  });

  it("preserves restoration when reload resolves before loading", async () => {
    const storage = new MemorySessionStorage();
    const sender = topSender(34, "https://example.test/page");
    let coordinator: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      const result = await coordinator.routeMessage(reloadRequest(
        34,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      ), sender);
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: (result as { accepted?: boolean } | undefined)?.accepted === true,
      };
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(coordinator, sender, "runtime-before-loading");
      }),
      sendTopFrameMessage,
      reloadTab: vi.fn(async () => undefined),
      now: () => 600,
      createRefreshCommandId: () => "command-before-loading",
    });
    authorize(coordinator, 34);

    await coordinator.dispatch(34, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 12,
      mode: "reload",
    });
    coordinator.observeTabUpdate(34, {
      status: "loading",
      url: sender.url,
      windowId: 7,
    });
    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-after-loading",
    }, sender);

    await expect(coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 34,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-after-loading",
    }, sender)).resolves.toMatchObject({
      type: "pin-op.refresh.scroll.restore",
      refreshGeneration: 12,
    });
  });

  it("treats observed loading as authoritative when reload rejects", async () => {
    const storage = new MemorySessionStorage();
    const sender = topSender(35, "https://example.test/page");
    const onError = vi.fn();
    let coordinator: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      const result = await coordinator.routeMessage(reloadRequest(
        35,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      ), sender);
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: (result as { accepted?: boolean } | undefined)?.accepted === true,
      };
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(coordinator, sender, "runtime-rejected-after-loading");
      }),
      sendTopFrameMessage,
      reloadTab: vi.fn(async () => {
        coordinator.observeTabUpdate(35, {
          status: "loading",
          url: sender.url,
          windowId: 7,
        });
        throw new Error("reload API rejected after navigation");
      }),
      now: () => 600,
      createRefreshCommandId: () => "command-rejected-after-loading",
      onError,
    });
    authorize(coordinator, 35);

    await expect(coordinator.dispatch(35, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 13,
      mode: "reload",
    })).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    await coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-after-rejected-reload",
    }, sender);
    await expect(coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 35,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-after-rejected-reload",
    }, sender)).resolves.toMatchObject({
      type: "pin-op.refresh.scroll.restore",
      refreshGeneration: 13,
    });
  });

  it("reports a true reload failure exactly once through the refresh owner", async () => {
    const storage = new MemorySessionStorage();
    const onError = vi.fn();
    const sender = topSender(36, "https://example.test/page");
    let content: BackgroundContentRefreshCoordinator;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly contentRuntimeId: string;
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
      };
      const result = await content.routeMessage(reloadRequest(
        36,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      ), sender);
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: (result as { accepted?: boolean } | undefined)?.accepted === true,
      };
    });
    content = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(content, sender, "runtime-single-diagnostic");
      }),
      sendTopFrameMessage,
      reloadTab: vi.fn(async () => { throw new Error("reload failed"); }),
      createRefreshCommandId: () => "command-single-diagnostic",
      onError,
    });
    const tabs = new TabRefreshCoordinator({
      store: new TabRefreshStateStore(storage),
      getActiveTabId: async () => 36,
      dispatchRefresh: (tabId, command) => content.dispatch(tabId, command),
      setRefreshParticipant: (windowId, tabId, participant) => {
        content.setTabParticipation(tabId, windowId, participant);
        content.setWindowEligibility(windowId, true);
      },
      onError,
    });
    await tabs.panelOpened(36, 7);

    await tabs.acceptPageRefresh(7, {
      protocolVersion: PROTOCOL_VERSION,
      type: "page.refresh",
      messageId: "refresh-single-diagnostic",
      sessionId: "session-a",
      source: { role: "ide", id: "vscode-a" },
      refreshGeneration: 14,
      mode: "reload",
      metadata: {},
    });

    expect(sendTopFrameMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
      "Content refresh command was rejected",
    );
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
    authorize(coordinator, 26);

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

  it("treats accepted false as a consumed one-shot failure and allows only a newer save", async () => {
    let coordinator: BackgroundContentRefreshCoordinator;
    let accepted = false;
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => ({
      ...(message as object),
      type: "pin-op.refresh.content.result",
      accepted,
      ...(accepted
        ? { stylesheet: { attempted: 1, updated: 1, failed: 0 } }
        : {}),
    }));
    const executeContentScript = vi.fn(async () => {
      await bind(
        coordinator,
        topSender(28, "https://example.test/page"),
        "runtime-failure",
      );
    });
    const ids = ["command-failure", "command-retry"];
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(
        new MemorySessionStorage(),
      ),
      executeContentScript,
      sendTopFrameMessage,
      reloadTab: vi.fn(),
      createRefreshCommandId: () => ids.shift() ?? "command-exhausted",
    });
    authorize(coordinator, 28);

    await expect(coordinator.dispatch(28, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 20,
      mode: "styles",
    })).rejects.toThrow("Content refresh command was rejected");
    expect(sendTopFrameMessage).toHaveBeenCalledTimes(1);

    accepted = true;
    await expect(coordinator.dispatch(28, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 21,
      mode: "styles",
    })).resolves.toBeUndefined();
    expect(sendTopFrameMessage).toHaveBeenCalledTimes(2);
    expect(sendTopFrameMessage.mock.calls[1]?.[1]).toMatchObject({
      refreshCommandId: "command-retry",
      refreshGeneration: 21,
    });
  });

  it("revokes a URL-only SPA binding and bootstraps the next refresh to the exact URL", async () => {
    const firstResult = deferred<unknown>();
    const pageUrls = [
      "https://example.test/page",
      "https://example.test/page#next",
    ];
    let injection = 0;
    let coordinator: BackgroundContentRefreshCoordinator;
    const sent: unknown[] = [];
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      sent.push(message);
      if (sent.length === 1) return firstResult.promise;
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: true,
        stylesheet: { attempted: 1, updated: 1, failed: 0 },
      };
    });
    const executeContentScript = vi.fn(async () => {
      const pageUrl = pageUrls[injection] ?? pageUrls[1];
      injection += 1;
      await bind(coordinator, topSender(29, pageUrl), "runtime-spa");
    });
    const ids = ["command-before-spa", "command-after-spa"];
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(
        new MemorySessionStorage(),
      ),
      executeContentScript,
      sendTopFrameMessage,
      reloadTab: vi.fn(),
      createRefreshCommandId: () => ids.shift() ?? "command-exhausted",
    });
    authorize(coordinator, 29);
    const beforeNavigation = coordinator.dispatch(29, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 30,
      mode: "styles",
    });
    await waitForCalls(sendTopFrameMessage, 1);

    coordinator.observeTabUpdate(29, {
      url: "https://example.test/page#next",
      windowId: 7,
    });
    firstResult.resolve({
      ...sent[0] as object,
      type: "pin-op.refresh.content.result",
      accepted: true,
      stylesheet: { attempted: 1, updated: 1, failed: 0 },
    });
    await expect(beforeNavigation).rejects.toThrow("Content refresh command revoked");

    await coordinator.dispatch(29, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 31,
      mode: "styles",
    });
    expect(executeContentScript).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatchObject({
      pageUrl: "https://example.test/page#next",
      contentRuntimeId: "runtime-spa",
      refreshCommandId: "command-after-spa",
    });
  });

  it("ignores deferred injection and ready completion after detach", async () => {
    const injection = deferred<void>();
    const storage = new MemorySessionStorage();
    const sendTopFrameMessage = vi.fn();
    const reloadTab = vi.fn();
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(() => injection.promise),
      sendTopFrameMessage,
      reloadTab,
      createRefreshCommandId: () => "command-detached",
    });
    authorize(coordinator, 30);
    const pending = coordinator.dispatch(30, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 40,
      mode: "reload",
    });
    await flushAsync();
    await coordinator.detachTab(30);
    injection.resolve();

    const sender = topSender(30, "https://example.test/page");
    await expect(coordinator.routeMessage({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: sender.url,
      contentRuntimeId: "runtime-too-late",
    }, sender)).resolves.toBeUndefined();
    await expect(coordinator.routeMessage({
      type: "pin-op.refresh.content.ready",
      tabId: 30,
      frameId: 0,
      pageUrl: sender.url,
      contentRuntimeId: "runtime-too-late",
    }, sender)).resolves.toBeUndefined();
    await expect(pending).rejects.toThrow();
    expect(sendTopFrameMessage).not.toHaveBeenCalled();
    expect(reloadTab).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });

  it("consumes an exact reload command lease only once", async () => {
    let coordinator: BackgroundContentRefreshCoordinator;
    const storage = new MemorySessionStorage();
    const reloadTab = vi.fn(async () => undefined);
    const sender = topSender(31, "https://example.test/page");
    const sendTopFrameMessage = vi.fn(async (_tabId, message: unknown) => {
      const command = message as {
        readonly refreshCommandId: string;
        readonly refreshGeneration: number;
        readonly contentRuntimeId: string;
      };
      const request = reloadRequest(
        31,
        command.contentRuntimeId,
        command.refreshGeneration,
        command.refreshCommandId,
      );
      const first = await coordinator.routeMessage(request, sender);
      const second = await coordinator.routeMessage(request, sender);
      expect(first).toMatchObject({ accepted: true });
      expect(second).toBeUndefined();
      return {
        ...(message as object),
        type: "pin-op.refresh.content.result",
        accepted: true,
      };
    });
    coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(async () => {
        await bind(coordinator, sender, "runtime-once");
      }),
      sendTopFrameMessage,
      reloadTab,
      createRefreshCommandId: () => "command-once",
    });
    authorize(coordinator, 31);

    await coordinator.dispatch(31, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 50,
      mode: "reload",
    });
    expect(reloadTab).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Auto Refresh off", async (coordinator: BackgroundContentRefreshCoordinator) => {
      coordinator.setTabParticipation(32, 7, false);
    }],
    ["window disconnect", async (coordinator: BackgroundContentRefreshCoordinator) => {
      coordinator.setWindowEligibility(7, false);
    }],
    ["protocol mismatch", async (coordinator: BackgroundContentRefreshCoordinator) => {
      coordinator.revokeWindow(7);
    }],
    ["tab detach", async (coordinator: BackgroundContentRefreshCoordinator) => {
      await coordinator.detachTab(32);
    }],
    ["tab removal", async (coordinator: BackgroundContentRefreshCoordinator) => {
      await coordinator.removeTab(32);
    }],
    ["URL-only navigation", async (coordinator: BackgroundContentRefreshCoordinator) => {
      coordinator.observeTabUpdate(32, {
        url: "https://example.test/page#revoked",
        windowId: 7,
      });
    }],
  ])("rejects a delayed reload after %s without persisting a snapshot", async (
    _reason,
    revoke,
  ) => {
    const response = deferred<unknown>();
    const events: string[] = [];
    const storage = new MemorySessionStorage(events);
    const reloadTab = vi.fn();
    const sender = topSender(32, "https://example.test/page");
    let command: {
      readonly contentRuntimeId: string;
      readonly refreshCommandId: string;
      readonly refreshGeneration: number;
    } | undefined;
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(),
      sendTopFrameMessage: vi.fn(async (_tabId, message: unknown) => {
        command = message as typeof command;
        return response.promise;
      }),
      reloadTab,
      createRefreshCommandId: () => "command-revoked",
    });
    authorize(coordinator, 32);
    await bind(coordinator, sender, "runtime-revoked");
    const pending = coordinator.dispatch(32, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 60,
      mode: "reload",
    });
    await flushAsync();
    expect(command).toBeDefined();

    await revoke(coordinator);
    await expect(coordinator.routeMessage(reloadRequest(
      32,
      command!.contentRuntimeId,
      command!.refreshGeneration,
      command!.refreshCommandId,
    ), sender)).resolves.toBeUndefined();
    expect(events).not.toContain("set");
    expect(reloadTab).not.toHaveBeenCalled();

    response.resolve({
      ...command as object,
      type: "pin-op.refresh.content.result",
      accepted: false,
    });
    await expect(pending).rejects.toThrow("Content refresh command revoked");
  });

  it("supersedes an older command lease before a delayed reload request", async () => {
    const responses = [deferred<unknown>(), deferred<unknown>()];
    const commands: Array<{
      readonly contentRuntimeId: string;
      readonly refreshCommandId: string;
      readonly refreshGeneration: number;
    }> = [];
    const storage = new MemorySessionStorage();
    const reloadTab = vi.fn();
    const sender = topSender(33, "https://example.test/page");
    const ids = ["command-old", "command-new"];
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: new SessionTopScrollSnapshotStorage(storage),
      executeContentScript: vi.fn(),
      sendTopFrameMessage: vi.fn(async (_tabId, message: unknown) => {
        commands.push(message as typeof commands[number]);
        return responses[commands.length - 1]!.promise;
      }),
      reloadTab,
      createRefreshCommandId: () => ids.shift() ?? "command-exhausted",
    });
    authorize(coordinator, 33);
    await bind(coordinator, sender, "runtime-supersede");
    const first = coordinator.dispatch(33, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 70,
      mode: "reload",
    });
    await waitForLength(commands, 1);
    const second = coordinator.dispatch(33, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 71,
      mode: "reload",
    });
    await waitForLength(commands, 2);

    await expect(coordinator.routeMessage(reloadRequest(
      33,
      commands[0]!.contentRuntimeId,
      commands[0]!.refreshGeneration,
      commands[0]!.refreshCommandId,
    ), sender)).resolves.toBeUndefined();
    expect(reloadTab).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);

    responses[0]!.resolve({
      ...commands[0],
      type: "pin-op.refresh.content.result",
      accepted: false,
    });
    responses[1]!.resolve({
      ...commands[1],
      type: "pin-op.refresh.content.result",
      accepted: false,
    });
    await expect(first).rejects.toThrow("Content refresh command revoked");
    await expect(second).rejects.toThrow("Content refresh command was rejected");
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

function authorize(
  coordinator: BackgroundContentRefreshCoordinator,
  tabId: number,
  windowId = 7,
): void {
  coordinator.setTabParticipation(tabId, windowId, true);
  coordinator.setWindowEligibility(windowId, true);
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

function reloadRequest(
  tabId: number,
  contentRuntimeId: string,
  generation: number,
  refreshCommandId = "command-direct",
) {
  const pageUrl = "https://example.test/page";
  return {
    type: "pin-op.refresh.reload.request",
    tabId,
    frameId: 0,
    pageUrl,
    contentRuntimeId,
    refreshCommandId,
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

async function waitForCalls(
  mock: { readonly mock: { readonly calls: readonly unknown[][] } },
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 30 && mock.mock.calls.length < count; attempt += 1) {
    await flushAsync();
  }
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

async function waitForLength(values: readonly unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 30 && values.length < count; attempt += 1) {
    await flushAsync();
  }
  expect(values.length).toBeGreaterThanOrEqual(count);
}
