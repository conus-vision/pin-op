import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type PageRefreshMessage,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceMatchesMessage,
} from "@pin-op/protocol";
import { startBackgroundRuntime } from "../src/backgroundRuntime.js";
import type {
  BrowserProtocolMismatch,
  InspectPayload,
  SourceOpenInput,
} from "../src/bridgeClient.js";
import type {
  BackgroundMessageSender,
  BackgroundRuntimePort,
} from "../src/backgroundRouter.js";
import {
  createDevtoolsPanelPortName,
  createInspectContentLeasePortName,
} from "../src/inspectPortProtocol.js";
import { TAB_REFRESH_STATE_STORAGE_KEY } from "../src/tabRefreshStateStore.js";
import type {
  BrowserWindowConnectionState,
  PanelRegistration,
} from "../src/windowConnectionCoordinator.js";
import {
  createTransportTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "../src/trustedIdePeerContext.js";

describe("startBackgroundRuntime", () => {
  it("wires authenticated resolutions into the live correlated panel route", async () => {
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const resolutionDispose = vi.fn();
    const stateDispose = vi.fn();
    const peerStateDispose = vi.fn();
    const sourceMatchesDispose = vi.fn();
    const sourceNavigationStateDispose = vi.fn();
    const pageRefreshDispose = vi.fn();
    const protocolMismatchDispose = vi.fn();
    const coordinatorDispose = vi.fn();
    let resolutionListener:
      | ((
        context: TrustedIdePeerContext,
        message: ResolutionMessage,
      ) => void)
      | undefined;
    let sourceMatchesListener:
      | ((
        context: TrustedIdePeerContext,
        message: SourceMatchesMessage,
      ) => void)
      | undefined;
    let panelRegistration: PanelRegistration | undefined;
    let publishedInspectMessageId: string | undefined;
    const coordinator = {
      linkWindow: vi.fn(async () => undefined),
      unlinkWindow: vi.fn(async () => undefined),
      registerPanel: vi.fn((registration: PanelRegistration) => {
        panelRegistration = registration;
        return { dispose: vi.fn() };
      }),
      publishInspect: vi.fn((
        _windowId: number,
        inspectMessageId: string,
        _sourceId: string,
        _payload: InspectPayload,
      ) => {
        publishedInspectMessageId = inspectMessageId;
        return "sent" as const;
      }),
      publishSourceNavigation: vi.fn(() => "sent" as const),
      publishSourceOpen: vi.fn((
        _context: TrustedIdePeerContext,
        _input: SourceOpenInput,
      ) => "sent" as const),
      publishPresentationSettings: vi.fn(() => "sent" as const),
      setRefreshParticipant: vi.fn(),
      removeWindow: vi.fn(async () => undefined),
      state: vi.fn(() => "linked" as const),
      onStateChanged: vi.fn(() => ({ dispose: stateDispose })),
      onResolution: vi.fn((listener) => {
        resolutionListener = listener;
        return { dispose: resolutionDispose };
      }),
      onPeerState: vi.fn(() => ({ dispose: peerStateDispose })),
      onSourceMatches: vi.fn((listener) => {
        sourceMatchesListener = listener;
        return { dispose: sourceMatchesDispose };
      }),
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
    expect(coordinator.onStateChanged).toHaveBeenCalledOnce();
    expect(coordinator.onPeerState).toHaveBeenCalledTimes(2);
    expect(coordinator.onSourceMatches).toHaveBeenCalledOnce();
    expect(coordinator.onSourceNavigationState).toHaveBeenCalledOnce();
    expect(coordinator.onPageRefresh).toHaveBeenCalledOnce();
    expect(coordinator.onProtocolMismatch).toHaveBeenCalledTimes(2);

    const channel = "channel-resolution-authority";
    const tabId = 17;
    const contentSessionId = "content-session-runtime";
    await messages.emit(
      registerMessage(channel, tabId, "firefox-source-a"),
      devtoolsSender(),
    );
    const panel = new TestRuntimePort(
      createDevtoolsPanelPortName(channel),
      panelSender(channel),
    );
    ports.emit(panel);
    panelRegistration?.onStateChanged?.("linked");
    await flushAsync();
    expect(panel.disconnected).toBe(false);
    expect(coordinator.registerPanel).toHaveBeenCalledOnce();
    const contentLease = new TestRuntimePort(
      createInspectContentLeasePortName(contentSessionId),
      contentSender(tabId, 7),
    );
    ports.emit(contentLease);
    await flushAsync();
    expect(contentLease.disconnected).toBe(false);
    const selectionResult = await messages.emit(
      selectedMessage(contentSessionId),
      contentSender(tabId, 7),
    );
    expect(selectionResult).toEqual({ ok: true });

    expect(coordinator.publishInspect).toHaveBeenCalledOnce();
    const inspectMessageId = publishedInspectMessageId;
    expect(inspectMessageId).toEqual(expect.any(String));
    if (typeof inspectMessageId !== "string") {
      throw new Error("Expected the runtime to publish an inspect message");
    }
    const trusted = createTransportTrustedIdePeerContext(
      7,
      "session-a",
      "vscode-a",
    );
    const spoofed = {
      ...resolution(
        inspectMessageId,
        1,
        "session-b",
        "vscode-b",
      ),
      messageId: `resolution-spoofed-${inspectMessageId}`,
    } satisfies ResolutionMessage;
    const matching = resolution(inspectMessageId, 1);
    resolutionListener?.(
      trusted,
      spoofed,
    );
    expect(messagesOfType(panel, "resolution")).toEqual([]);
    resolutionListener?.(trusted, matching);

    expect(messagesOfType(panel, "resolution")).toEqual([matching]);

    const matched = matchedResolution(inspectMessageId, 2);
    resolutionListener?.(trusted, matched);
    const matches = sourceMatches(inspectMessageId, 2);
    const sourceMatchesContext = createTransportTrustedIdePeerContext(
      7,
      "session-a",
      "vscode-a",
    );
    sourceMatchesListener?.(
      createTransportTrustedIdePeerContext(8, "session-a", "vscode-a"),
      matches,
    );
    expect(messagesOfType(panel, "source.matches")).toEqual([]);
    sourceMatchesListener?.(sourceMatchesContext, matches);
    expect(messagesOfType(panel, "source.matches")).toEqual([matches]);

    panel.onMessage.emit({
      type: "pin-op.source.open",
      inspectMessageId,
      resolutionGeneration: 2,
      matchId: "match-1",
    });
    await flushAsync();

    expect(coordinator.publishSourceOpen).toHaveBeenCalledOnce();
    expect(coordinator.publishSourceOpen.mock.calls[0]?.[0]).toBe(
      sourceMatchesContext,
    );
    expect(coordinator.publishSourceOpen.mock.calls[0]?.[1]).toEqual({
      inspectMessageId,
      resolutionGeneration: 2,
      matchId: "match-1",
    });

    runtime.dispose();
    runtime.dispose();

    expect(resolutionDispose).toHaveBeenCalledOnce();
    expect(stateDispose).toHaveBeenCalledOnce();
    expect(peerStateDispose).toHaveBeenCalledTimes(2);
    expect(sourceMatchesDispose).toHaveBeenCalledOnce();
    expect(sourceNavigationStateDispose).toHaveBeenCalledOnce();
    expect(pageRefreshDispose).toHaveBeenCalledOnce();
    expect(protocolMismatchDispose).toHaveBeenCalledTimes(2);
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
      publishSourceOpen: vi.fn(() => "sent" as const),
      publishPresentationSettings: vi.fn(() => "sent" as const),
      setRefreshParticipant: vi.fn(),
      removeWindow: vi.fn(async () => undefined),
      state: vi.fn(() => "notLinked" as const),
      onStateChanged: vi.fn(() => ({ dispose: vi.fn() })),
      onResolution: vi.fn(() => ({ dispose: vi.fn() })),
      onPeerState: vi.fn(() => ({ dispose: vi.fn() })),
      onSourceMatches: vi.fn(() => ({ dispose: vi.fn() })),
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
      panelClosed: vi.fn(async (tabId, windowId) =>
        windowId === undefined ? undefined : tabState(tabId, windowId)),
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
      observeTabUpdate: vi.fn(),
      tabUpdated: vi.fn(async () => undefined),
      removeTab: vi.fn(async () => undefined),
      detachTab: vi.fn(async () => undefined),
      setTabParticipation: vi.fn(),
      setWindowEligibility: vi.fn(),
      revokeTab: vi.fn(),
      revokeWindow: vi.fn(),
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
    expect(contentRefresh.revokeWindow).toHaveBeenCalledWith(7);
    activatedTabs.emit(11, 7);
    removedTabs.emit(12);
    expect(contentRefresh.revokeTab).toHaveBeenCalledWith(12);
    detachedTabs.emit(13, 7);
    expect(contentRefresh.revokeTab).toHaveBeenCalledWith(13);
    const spaUpdate = {
      url: "https://example.test/page#spa",
      windowId: 7,
    };
    updatedTabs.emit(11, spaUpdate);
    expect(contentRefresh.observeTabUpdate).toHaveBeenCalledWith(11, spaUpdate);
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
    expect(tabRefresh.detachTab).toHaveBeenCalledWith(13, 7);
    expect(contentRefresh.detachTab).toHaveBeenCalledWith(13);
    expect(contentRefresh.tabUpdated).toHaveBeenCalledWith(
      11,
      spaUpdate,
      true,
    );
    expect(contentRefresh.routeMessage).toHaveBeenCalledWith(bootstrap, {
      url: "https://example.test/page",
      frameId: 0,
      tab: { id: 11, windowId: 7 },
    });
    runtime.dispose();
    expect(contentRefresh.dispose).toHaveBeenCalledOnce();
  });

  it("restores refresh without a panel only after transport and IDE peer are ready", async () => {
    const storage = memoryStorage();
    await storage.set({
      [TAB_REFRESH_STATE_STORAGE_KEY]: [{
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        participant: true,
        lastAcceptedGeneration: 0,
      }],
    });
    const messages = eventHarness();
    const ports = eventHarness();
    const windows = eventHarness();
    const detachedTabs = eventHarness();
    const attachedTabs = eventHarness();
    const connectionStates = subscriptionEventHarness<
      (windowId: number, state: BrowserWindowConnectionState) => void
    >();
    const peerStates = subscriptionEventHarness<
      (windowId: number, message: PeerStateMessage) => void
    >();
    const pageRefreshes = subscriptionEventHarness<
      (windowId: number, message: PageRefreshMessage) => void
    >();
    const protocolMismatches = subscriptionEventHarness<
      (windowId: number, details: BrowserProtocolMismatch) => void
    >();
    const setRefreshParticipant = vi.fn();
    let eligible = false;
    const contentRefresh = {
      dispatch: vi.fn(async () => {
        if (!eligible) throw new Error("refresh window is not eligible");
      }),
      routeMessage: vi.fn(async () => undefined),
      observeTabUpdate: vi.fn(),
      tabUpdated: vi.fn(async () => undefined),
      removeTab: vi.fn(async () => undefined),
      detachTab: vi.fn(async () => undefined),
      setTabParticipation: vi.fn(),
      setWindowEligibility: vi.fn((_windowId: number, next: boolean) => {
        eligible = next;
      }),
      revokeTab: vi.fn(),
      revokeWindow: vi.fn(() => { eligible = false; }),
      dispose: vi.fn(),
    };
    const coordinator = {
      linkWindow: vi.fn(async () => undefined),
      unlinkWindow: vi.fn(async () => undefined),
      registerPanel: vi.fn(() => ({ dispose: vi.fn() })),
      publishInspect: vi.fn(() => "sent" as const),
      publishSourceNavigation: vi.fn(() => "sent" as const),
      publishSourceOpen: vi.fn(() => "sent" as const),
      publishPresentationSettings: vi.fn(() => "sent" as const),
      setRefreshParticipant,
      removeWindow: vi.fn(async () => undefined),
      state: vi.fn(() => "notLinked" as BrowserWindowConnectionState),
      onStateChanged: connectionStates.subscribe,
      onResolution: vi.fn(() => ({ dispose: vi.fn() })),
      onPeerState: peerStates.subscribe,
      onSourceMatches: vi.fn(() => ({ dispose: vi.fn() })),
      onSourceNavigationState: vi.fn(() => ({ dispose: vi.fn() })),
      onPageRefresh: pageRefreshes.subscribe,
      onProtocolMismatch: protocolMismatches.subscribe,
      dispose: vi.fn(),
    };
    const onError = vi.fn();

    const runtime = startBackgroundRuntime({
      expectedDevtoolsUrl: "moz-extension://pin-op/dist/devtools.html",
      expectedPanelUrl: "moz-extension://pin-op/dist/panel.html",
      storage,
      executeScript: vi.fn(async () => []),
      sendTabMessage: vi.fn(async () => undefined),
      getTab: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 7 })),
      getActiveTabId: vi.fn(async () => 11),
      subscribeRuntimeMessages: messages.subscribe,
      subscribeRuntimePorts: ports.subscribe,
      subscribeWindowRemoved: windows.subscribe,
      subscribeTabDetached: detachedTabs.subscribe,
      subscribeTabAttached: attachedTabs.subscribe,
      createWindowConnectionCoordinator: () => coordinator,
      createContentRefreshCoordinator: () => contentRefresh,
      onError,
    });
    await flushAsync();

    expect(setRefreshParticipant).toHaveBeenCalledWith(7, 11, true);
    expect(contentRefresh.setTabParticipation).toHaveBeenCalledWith(
      11,
      7,
      true,
    );
    expect(contentRefresh.dispatch).not.toHaveBeenCalled();

    connectionStates.emit(7, "linked");
    expect(contentRefresh.setWindowEligibility).not.toHaveBeenCalledWith(
      7,
      true,
    );
    peerStates.emit(7, peerState(true, 1));
    expect(contentRefresh.setWindowEligibility).toHaveBeenLastCalledWith(
      7,
      true,
    );
    await flushAsync();

    pageRefreshes.emit(7, pageRefresh(1));
    await flushAsync();
    expect(contentRefresh.dispatch).toHaveBeenCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "styles",
    });
    expect(onError).not.toHaveBeenCalled();

    connectionStates.emit(7, "offline");
    expect(contentRefresh.setWindowEligibility).toHaveBeenLastCalledWith(
      7,
      false,
    );
    connectionStates.emit(7, "linked");
    peerStates.emit(7, peerState(true, 2));
    protocolMismatches.emit(7, {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    expect(contentRefresh.revokeWindow).toHaveBeenCalledWith(7);

    runtime.dispose();
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

class TestRuntimePort implements BackgroundRuntimePort {
  public readonly sent: unknown[] = [];
  public readonly onMessage = new TestEvent<(message: unknown) => void>();
  public readonly onDisconnect = new TestEvent<() => void>();
  public disconnected = false;

  public constructor(
    public readonly name: string,
    public readonly sender: BackgroundMessageSender,
  ) {}

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

class TestEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

function registerMessage(channel: string, tabId: number, sourceId: string) {
  return {
    type: "pin-op.registerDevtools",
    channel,
    tabId,
    sourceId,
  } as const;
}

function devtoolsSender(): BackgroundMessageSender {
  return { url: "moz-extension://pin-op/dist/devtools.html" };
}

function panelSender(channel: string): BackgroundMessageSender {
  return {
    url:
      `moz-extension://pin-op/dist/panel.html?channel=${encodeURIComponent(channel)}`,
  };
}

function contentSender(
  tabId: number,
  windowId: number,
): BackgroundMessageSender {
  return { tab: { id: tabId, windowId } };
}

function inspectPayload(): InspectPayload {
  return {
    targets: [{
      role: "selected",
      depth: 0,
      subject: { selector: ".card", metadata: {} },
      facts: [],
      metadata: {},
    }],
    context: { url: "https://example.test/page", metadata: {} },
    ideHighlightEnabled: true,
    metadata: {},
  };
}

function selectedMessage(contentSessionId: string) {
  return {
    type: "elementSelected" as const,
    contentSessionId,
    selectionRevision: 1,
    payload: inspectPayload(),
  };
}

function messagesOfType(
  port: TestRuntimePort,
  type: string,
): unknown[] {
  return port.sent.filter((message) =>
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === type
  );
}

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

function subscriptionEventHarness<Listener extends (...args: any[]) => void>() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(...args: Parameters<Listener>) {
      for (const listener of [...listeners]) listener(...args);
    },
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

function resolution(
  inspectMessageId: string,
  resolutionGeneration: number,
  sessionId = "session-a",
  sourceId = "vscode-a",
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${inspectMessageId}-${resolutionGeneration}`,
    sessionId,
    source: { role: "ide", id: sourceId },
    inspectMessageId,
    resolutionGeneration,
    status: "no-active-editor",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function matchedResolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    ...resolution(inspectMessageId, resolutionGeneration),
    status: "matched",
    document: { label: "card.scss", languageId: "scss" },
    selectedMatchCount: 1,
  };
}

function sourceMatches(
  inspectMessageId: string,
  resolutionGeneration: number,
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `source-matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    matches: [{
      matchId: "match-1",
      targetRole: "selected",
      label: "card.scss:1",
      kind: "rule",
      relation: "selected",
      confidence: "exact",
      startLine: 1,
      endLine: 3,
      text: ".card { color: red; }",
      truncated: false,
    }],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function peerState(
  connected: boolean,
  peerGeneration: number,
): PeerStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: `peer-${peerGeneration}`,
    sessionId: "session-a",
    role: "ide",
    connected,
    peerGeneration,
    metadata: {},
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
