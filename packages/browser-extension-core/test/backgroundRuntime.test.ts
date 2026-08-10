import { describe, expect, it, vi } from "vitest";
import { startBackgroundRuntime } from "../src/backgroundRuntime.js";

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
    const coordinatorDispose = vi.fn();
    const coordinator = {
      linkWindow: vi.fn(async () => undefined),
      unlinkWindow: vi.fn(async () => undefined),
      registerPanel: vi.fn(() => ({ dispose: vi.fn() })),
      publishInspect: vi.fn(() => "sent" as const),
      publishSourceNavigation: vi.fn(() => "sent" as const),
      removeWindow: vi.fn(async () => undefined),
      onResolution: vi.fn(() => ({ dispose: resolutionDispose })),
      onPeerState: vi.fn(() => ({ dispose: peerStateDispose })),
      onSourceNavigationState: vi.fn(() => ({
        dispose: sourceNavigationStateDispose,
      })),
      dispose: coordinatorDispose,
    };

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://browser2ide/dist/devtools.html",
      expectedPanelUrl: "moz-extension://browser2ide/dist/panel.html",
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

    runtime.dispose();
    runtime.dispose();

    expect(resolutionDispose).toHaveBeenCalledOnce();
    expect(peerStateDispose).toHaveBeenCalledOnce();
    expect(sourceNavigationStateDispose).toHaveBeenCalledOnce();
    expect(coordinatorDispose).toHaveBeenCalledOnce();
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
      expectedDevtoolsUrl: "moz-extension://browser2ide/dist/devtools.html",
      expectedPanelUrl: "moz-extension://browser2ide/dist/panel.html",
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
        type: "browser2ide.registerDevtools",
        channel: "channel-1",
        tabId: 91,
        sourceId: "firefox-source-1",
      },
      { url: "moz-extension://browser2ide/dist/devtools.html" },
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
      "browser2ide.windowLink.7": validStoredLink(),
      "browser2ide.windowLink.8": validStoredLink(),
    });

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://browser2ide/dist/devtools.html",
      expectedPanelUrl: "moz-extension://browser2ide/dist/panel.html",
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
    expect(await storage.get("browser2ide.windowLink.7")).toEqual({});
    expect(await storage.get("browser2ide.windowLink.8")).not.toEqual({});
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
    sessionId: "browser2ide",
    bridgeInstanceId: "11111111-1111-4111-8111-111111111111",
    authToken: "token-value",
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
