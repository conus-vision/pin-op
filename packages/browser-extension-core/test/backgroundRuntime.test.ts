import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type PageRefreshMessage } from "@pin-op/protocol";
import { startBackgroundRuntime } from "../src/backgroundRuntime.js";
import type { BrowserProtocolMismatch } from "../src/bridgeClient.js";

describe("startBackgroundRuntime", () => {
  it("wires bridge protocol events into the router and disposes subscriptions", () => {
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const resolutionDispose = vi.fn();
    const peerStateDispose = vi.fn();
    const sourceNavigationStateDispose = vi.fn();
    const pageRefreshDispose = vi.fn();
    const protocolMismatchDispose = vi.fn();
    const coordinatorDispose = vi.fn();
    const coordinator = {
      linkWindow: vi.fn(async () => undefined),
      unlinkWindow: vi.fn(async () => undefined),
      registerPanel: vi.fn(() => ({ dispose: vi.fn() })),
      publishInspect: vi.fn(() => "sent" as const),
      publishSourceNavigation: vi.fn(() => "sent" as const),
      setRefreshParticipant: vi.fn(),
      removeWindow: vi.fn(async () => undefined),
      onResolution: vi.fn(() => ({ dispose: resolutionDispose })),
      onPeerState: vi.fn(() => ({ dispose: peerStateDispose })),
      onSourceNavigationState: vi.fn(() => ({
        dispose: sourceNavigationStateDispose,
      })),
      onPageRefresh: vi.fn(() => ({ dispose: pageRefreshDispose })),
      onProtocolMismatch: vi.fn(() => ({ dispose: protocolMismatchDispose })),
      dispose: coordinatorDispose,
    };

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://pin-op/dist/devtools.html",
      expectedPanelUrl: "moz-extension://pin-op/dist/panel.html",
      storage: memoryStorage(),
      executeScript: vi.fn(async () => []),
      sendTabMessage: vi.fn(async () => undefined),
      getTab: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 7 })),
      subscribeRuntimeMessages: messages.subscribe,
      subscribeRuntimePorts: ports.subscribe,
      subscribeWindowRemoved: windows.subscribe,
      subscribeTabDetached: detachedTabs.subscribe,
      subscribeTabAttached: attachedTabs.subscribe,
      createWindowConnectionCoordinator: () => coordinator,
    });

    expect(coordinator.onResolution).toHaveBeenCalledOnce();
    expect(coordinator.onPeerState).toHaveBeenCalledOnce();
    expect(coordinator.onSourceNavigationState).toHaveBeenCalledOnce();
    expect(coordinator.onPageRefresh).toHaveBeenCalledOnce();
    expect(coordinator.onProtocolMismatch).toHaveBeenCalledOnce();

    runtime.dispose();
    runtime.dispose();

    expect(resolutionDispose).toHaveBeenCalledOnce();
    expect(peerStateDispose).toHaveBeenCalledOnce();
    expect(sourceNavigationStateDispose).toHaveBeenCalledOnce();
    expect(pageRefreshDispose).toHaveBeenCalledOnce();
    expect(protocolMismatchDispose).toHaveBeenCalledOnce();
    expect(coordinatorDispose).toHaveBeenCalledOnce();
  });

  it("coordinates bridge refresh, tab activation, tab removal, and participant restoration", async () => {
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const activatedTabs = eventHarness();
    const removedTabs = eventHarness();
    const updatedTabs = eventHarness();
    let pageRefreshListener:
      | ((windowId: number, message: PageRefreshMessage) => void)
      | undefined;
    let protocolMismatchListener:
      | ((windowId: number, details: BrowserProtocolMismatch) => void)
      | undefined;
    const coordinator = {
      linkWindow: vi.fn(async () => undefined),
      unlinkWindow: vi.fn(async () => undefined),
      registerPanel: vi.fn(() => ({ dispose: vi.fn() })),
      publishInspect: vi.fn(() => "sent" as const),
      publishSourceNavigation: vi.fn(() => "sent" as const),
      setRefreshParticipant: vi.fn(),
      removeWindow: vi.fn(async () => undefined),
      onResolution: vi.fn(() => ({ dispose: vi.fn() })),
      onPeerState: vi.fn(() => ({ dispose: vi.fn() })),
      onSourceNavigationState: vi.fn(() => ({ dispose: vi.fn() })),
      onPageRefresh: vi.fn((listener) => {
        pageRefreshListener = listener;
        return { dispose: vi.fn() };
      }),
      onProtocolMismatch: vi.fn((listener) => {
        protocolMismatchListener = listener;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    const tabRefresh = {
      initialize: vi.fn(async () => undefined),
      panelOpened: vi.fn(async (tabId, windowId) => tabState(tabId, windowId)),
      state: vi.fn(async (tabId, windowId) => tabState(tabId, windowId)),
      updateSettings: vi.fn(async (tabId, windowId) => tabState(tabId, windowId)),
      acceptPageRefresh: vi.fn(async () => undefined),
      beginWindowEpoch: vi.fn(async () => undefined),
      clearWindowPending: vi.fn(async () => undefined),
      activateTab: vi.fn(async () => undefined),
      detachTab: vi.fn(async () => undefined),
      removeTab: vi.fn(async () => undefined),
      removeWindow: vi.fn(async () => undefined),
    };
    const contentRefresh = {
      dispatch: vi.fn(async () => undefined),
      routeMessage: vi.fn(async (message: unknown) =>
        (message as { type?: string }).type === "pin-op.refresh.content.bootstrap"
          ? { accepted: true }
          : undefined),
      tabUpdated: vi.fn(async () => undefined),
      removeTab: vi.fn(async () => undefined),
      detachTab: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://pin-op/dist/devtools.html",
      expectedPanelUrl: "moz-extension://pin-op/dist/panel.html",
      storage: memoryStorage(),
      executeScript: vi.fn(async () => []),
      sendTabMessage: vi.fn(async () => undefined),
      sendTopFrameMessage: vi.fn(async () => undefined),
      reloadTab: vi.fn(async () => undefined),
      getTab: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 7 })),
      getActiveTabId: vi.fn(async () => 11),
      subscribeRuntimeMessages: messages.subscribe,
      subscribeRuntimePorts: ports.subscribe,
      subscribeWindowRemoved: windows.subscribe,
      subscribeTabDetached: detachedTabs.subscribe,
      subscribeTabAttached: attachedTabs.subscribe,
      subscribeTabActivated: activatedTabs.subscribe,
      subscribeTabRemoved: removedTabs.subscribe,
      subscribeTabUpdated: updatedTabs.subscribe,
      createWindowConnectionCoordinator: () => coordinator,
      createTabRefreshCoordinator: () => tabRefresh,
      createContentRefreshCoordinator: () => contentRefresh,
    });
    await flushAsync();
    expect(tabRefresh.initialize).toHaveBeenCalledOnce();

    const refresh = pageRefresh(4);
    pageRefreshListener?.(7, refresh);
    protocolMismatchListener?.(7, {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    activatedTabs.emit(11, 7);
    removedTabs.emit(12);
    updatedTabs.emit(11, {
      status: "complete",
      url: "https://example.test/page",
      windowId: 7,
    });
    const bootstrap = { type: "pin-op.refresh.content.bootstrap" };
    await messages.emit(bootstrap, {
      url: "https://example.test/page",
      frameId: 0,
      tab: { id: 11, windowId: 7 },
    });
    await flushAsync();

    expect(tabRefresh.acceptPageRefresh).toHaveBeenCalledWith(7, refresh);
    expect(tabRefresh.clearWindowPending).toHaveBeenCalledWith(7);
    expect(tabRefresh.activateTab).toHaveBeenCalledWith(11, 7);
    expect(tabRefresh.removeTab).toHaveBeenCalledWith(12);
    expect(contentRefresh.removeTab).toHaveBeenCalledWith(12);
    expect(contentRefresh.tabUpdated).toHaveBeenCalledWith(11, {
      status: "complete",
      url: "https://example.test/page",
      windowId: 7,
    }, true);
    expect(contentRefresh.routeMessage).toHaveBeenCalledWith(bootstrap, {
      url: "https://example.test/page",
      frameId: 0,
      tab: { id: 11, windowId: 7 },
    });
    runtime.dispose();
    expect(contentRefresh.dispose).toHaveBeenCalledOnce();
  });

  it("composes the background services and removes every platform listener", async () => {
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const storage = memoryStorage();
    const getTab = vi.fn(async (tabId: number) => ({ id: tabId, windowId: 7 }));

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://pin-op/dist/devtools.html",
      expectedPanelUrl: "moz-extension://pin-op/dist/panel.html",
      storage,
      executeScript: vi.fn(async () => []),
      sendTabMessage: vi.fn(async () => undefined),
      getTab,
      subscribeRuntimeMessages: messages.subscribe,
      subscribeRuntimePorts: ports.subscribe,
      subscribeWindowRemoved: windows.subscribe,
      subscribeTabDetached: detachedTabs.subscribe,
      subscribeTabAttached: attachedTabs.subscribe,
    });

    expect(messages.listener).toBeTypeOf("function");
    expect(ports.listener).toBeTypeOf("function");
    expect(windows.listener).toBeTypeOf("function");
    expect(detachedTabs.listener).toBeTypeOf("function");
    expect(attachedTabs.listener).toBeTypeOf("function");

    await messages.emit(
      {
        type: "pin-op.registerDevtools",
        channel: "channel-1",
        tabId: 91,
        sourceId: "firefox-source-1",
      },
      { url: "moz-extension://pin-op/dist/devtools.html" },
    );
    expect(getTab).toHaveBeenCalledWith(91);

    runtime.dispose();
    runtime.dispose();
    expect(messages.remove).toHaveBeenCalledOnce();
    expect(ports.remove).toHaveBeenCalledOnce();
    expect(windows.remove).toHaveBeenCalledOnce();
    expect(detachedTabs.remove).toHaveBeenCalledOnce();
    expect(attachedTabs.remove).toHaveBeenCalledOnce();
  });

  it("removes only the closed browser window session record", async () => {
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const storage = memoryStorage();
    await storage.set({
      "pin-op.windowLink.7": validStoredLink(),
      "pin-op.windowLink.8": validStoredLink(),
    });

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://pin-op/dist/devtools.html",
      expectedPanelUrl: "moz-extension://pin-op/dist/panel.html",
      storage,
      executeScript: async () => [],
      sendTabMessage: async () => undefined,
      getTab: async (tabId) => ({ id: tabId, windowId: 7 }),
      subscribeRuntimeMessages: messages.subscribe,
      subscribeRuntimePorts: ports.subscribe,
      subscribeWindowRemoved: windows.subscribe,
      subscribeTabDetached: detachedTabs.subscribe,
      subscribeTabAttached: attachedTabs.subscribe,
    });

    windows.emit(7);
    await flushAsync();
    expect(await storage.get("pin-op.windowLink.7")).toEqual({});
    expect(await storage.get("pin-op.windowLink.8")).not.toEqual({});
    runtime.dispose();
  });
});

function eventHarness() {
  let listener: ((...args: any[]) => unknown) | undefined;
  const remove = vi.fn();
  return {
    get listener() {
      return listener;
    },
    subscribe(next: (...args: any[]) => unknown) {
      listener = next;
      return remove;
    },
    remove,
    emit(...args: any[]) {
      return listener?.(...args);
    },
  };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    async get(key: string) {
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      for (const [key, value] of Object.entries(records)) {
        values.set(key, value);
      }
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function validStoredLink(): Record<string, unknown> {
  return {
    url: "ws://127.0.0.1:48735",
    port: 48_735,
    sessionId: "pin-op",
    bridgeInstanceId: "11111111-1111-4111-8111-111111111111",
    authToken: "token-value",
  };
}

function tabState(tabId: number, windowId: number) {
  return {
    tabId,
    windowId,
    autoRefreshEnabled: true,
    ideHighlightEnabled: true,
    participant: true,
    lastAcceptedGeneration: 0,
  } as const;
}

function pageRefresh(refreshGeneration: number): PageRefreshMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: `refresh-${refreshGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    refreshGeneration,
    mode: "styles",
    metadata: {},
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
