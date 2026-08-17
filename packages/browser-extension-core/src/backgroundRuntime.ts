import {
  BackgroundInspectCoordinator,
  type BackgroundInspectApi,
} from "./backgroundInspectSession.js";
import {
  BackgroundContentRefreshCoordinator,
  SessionTopScrollSnapshotStorage,
} from "./backgroundContentRefresh.js";
import {
  createBackgroundRouter,
  type BackgroundRouterSubscriptions,
  type BackgroundRuntimePort,
  type BackgroundTabRefreshCoordinator,
  type BackgroundContentRefreshRuntime,
  type BackgroundTab,
  type BackgroundWindowCoordinator,
} from "./backgroundRouter.js";
import {
  BrowserWindowLinkStore,
  type SessionStorage,
} from "./browserWindowLinkStore.js";
import {
  WindowConnectionCoordinator,
  type BrowserWindowConnectionState,
} from "./windowConnectionCoordinator.js";
import { TabRefreshCoordinator } from "./tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "./tabRefreshStateStore.js";

export interface BackgroundRuntimeOptions extends BackgroundInspectApi {
  readonly expectedDevtoolsUrl: string;
  readonly expectedPanelUrl: string;
  readonly storage: SessionStorage;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly getActiveTabId?: (windowId: number) => Promise<number | undefined>;
  readonly sendTopFrameMessage?: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly reloadTab?: (tabId: number) => Promise<unknown>;
  readonly subscribeRuntimeMessages: BackgroundRouterSubscriptions["subscribeRuntimeMessages"];
  readonly subscribeRuntimePorts: BackgroundRouterSubscriptions["subscribeRuntimePorts"];
  readonly subscribeWindowRemoved: BackgroundRouterSubscriptions["subscribeWindowRemoved"];
  readonly subscribeTabDetached: BackgroundRouterSubscriptions["subscribeTabDetached"];
  readonly subscribeTabAttached: BackgroundRouterSubscriptions["subscribeTabAttached"];
  readonly subscribeTabActivated?: NonNullable<
    BackgroundRouterSubscriptions["subscribeTabActivated"]
  >;
  readonly subscribeTabRemoved?: NonNullable<
    BackgroundRouterSubscriptions["subscribeTabRemoved"]
  >;
  readonly subscribeTabUpdated?: NonNullable<
    BackgroundRouterSubscriptions["subscribeTabUpdated"]
  >;
  readonly createWindowConnectionCoordinator?: (
    store: BrowserWindowLinkStore,
  ) => BackgroundWindowCoordinator &
    Pick<
      WindowConnectionCoordinator,
      | "onResolution"
      | "onStateChanged"
      | "onPeerState"
      | "onSourceNavigationState"
      | "onPageRefresh"
      | "onProtocolMismatch"
      | "state"
      | "dispose"
    >;
  readonly createTabRefreshCoordinator?: (
    store: TabRefreshStateStore,
    coordinator: BackgroundWindowCoordinator,
  ) => BackgroundTabRefreshCoordinator & { initialize?(): Promise<void> };
  readonly createContentRefreshCoordinator?: (
    storage: SessionTopScrollSnapshotStorage,
  ) => BackgroundContentRefreshRuntime;
  readonly onError?: (error: unknown) => void;
}

export interface BackgroundRuntime {
  dispose(): void;
}

export function startBackgroundRuntime(
  options: BackgroundRuntimeOptions,
): BackgroundRuntime {
  const inspectCoordinator = new BackgroundInspectCoordinator({
    executeScript: options.executeScript,
    sendTabMessage: options.sendTabMessage,
  });
  const store = new BrowserWindowLinkStore(options.storage);
  const coordinator = options.createWindowConnectionCoordinator?.(store) ??
    new WindowConnectionCoordinator({ store });
  const tabRefreshStore = new TabRefreshStateStore(options.storage);
  const snapshotStorage = new SessionTopScrollSnapshotStorage(options.storage);
  const contentRefreshCoordinator = options.createContentRefreshCoordinator?.(
    snapshotStorage,
  ) ?? new BackgroundContentRefreshCoordinator({
    snapshotStorage,
    executeContentScript: (tabId) => options.executeScript({
      target: { tabId },
      files: ["dist/contentScript.js"],
    }),
    sendTopFrameMessage: options.sendTopFrameMessage ?? options.sendTabMessage,
    reloadTab: options.reloadTab ?? (async () => {
      throw new Error("Browser tab reload is unavailable");
    }),
    onError: options.onError,
  });
  const tabRefreshCoordinator = options.createTabRefreshCoordinator?.(
    tabRefreshStore,
    coordinator,
  ) ?? new TabRefreshCoordinator({
    store: tabRefreshStore,
    getActiveTabId: options.getActiveTabId ?? (async () => undefined),
    dispatchRefresh: async (tabId, command) => {
      await contentRefreshCoordinator.dispatch(tabId, command);
    },
    setRefreshParticipant: (windowId, tabId, participant) => {
      contentRefreshCoordinator.setTabParticipation(
        tabId,
        windowId,
        participant,
      );
      coordinator.setRefreshParticipant(windowId, tabId, participant);
    },
    onError: options.onError,
  });
  const refreshWindows = new Map<number, RefreshWindowReadiness>();
  const publishRefreshEligibility = (windowId: number): void => {
    const readiness = refreshWindows.get(windowId);
    contentRefreshCoordinator.setWindowEligibility(
      windowId,
      readiness?.state === "linked" && readiness.peer?.connected === true,
    );
  };
  const refreshStateSubscription = coordinator.onStateChanged(
    (windowId, state) => {
      const readiness = refreshWindows.get(windowId) ?? { state };
      readiness.state = state;
      if (state !== "linked") readiness.peer = undefined;
      refreshWindows.set(windowId, readiness);
      publishRefreshEligibility(windowId);
    },
  );
  const refreshPeerSubscription = coordinator.onPeerState(
    (windowId, message) => {
      const readiness = refreshWindows.get(windowId) ?? {
        state: coordinator.state(windowId),
      };
      if (
        readiness.peer?.sessionId === message.sessionId &&
        message.peerGeneration <= readiness.peer.generation
      ) {
        return;
      }
      readiness.peer = {
        sessionId: message.sessionId,
        generation: message.peerGeneration,
        connected: message.connected,
      };
      refreshWindows.set(windowId, readiness);
      publishRefreshEligibility(windowId);
    },
  );
  const refreshMismatchSubscription = coordinator.onProtocolMismatch(
    (windowId) => {
      refreshWindows.delete(windowId);
    },
  );
  void tabRefreshCoordinator.initialize?.().catch((error) =>
    options.onError?.(error),
  );
  const router = createBackgroundRouter({
    expectedDevtoolsUrl: options.expectedDevtoolsUrl,
    expectedPanelUrl: options.expectedPanelUrl,
    getTab: options.getTab,
    coordinator,
    tabRefreshCoordinator,
    contentRefreshCoordinator,
    inspectCoordinator,
    subscribeResolutions: (listener) => {
      const subscription = coordinator.onResolution((context, message) =>
        listener(context, message),
      );
      return () => subscription.dispose();
    },
    subscribePeerStates: (listener) => {
      const subscription = coordinator.onPeerState((windowId, message) =>
        listener(windowId, message),
      );
      return () => subscription.dispose();
    },
    subscribeSourceNavigationStates: (listener) => {
      const subscription = coordinator.onSourceNavigationState(
        (context, message) => listener(context, message),
      );
      return () => subscription.dispose();
    },
    subscribePageRefreshes: (listener) => {
      const subscription = coordinator.onPageRefresh((windowId, message) =>
        listener(windowId, message),
      );
      return () => subscription.dispose();
    },
    subscribeProtocolMismatches: (listener) => {
      const subscription = coordinator.onProtocolMismatch(
        (windowId, details) => listener(windowId, details),
      );
      return () => subscription.dispose();
    },
    subscriptions: {
      subscribeRuntimeMessages: options.subscribeRuntimeMessages,
      subscribeRuntimePorts: options.subscribeRuntimePorts,
      subscribeWindowRemoved: options.subscribeWindowRemoved,
      subscribeTabDetached: options.subscribeTabDetached,
      subscribeTabAttached: options.subscribeTabAttached,
      subscribeTabActivated: options.subscribeTabActivated,
      subscribeTabRemoved: options.subscribeTabRemoved,
      subscribeTabUpdated: options.subscribeTabUpdated,
    },
    onError: options.onError,
  });
  let disposed = false;

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      router.dispose();
      refreshStateSubscription.dispose();
      refreshPeerSubscription.dispose();
      refreshMismatchSubscription.dispose();
      refreshWindows.clear();
      coordinator.dispose();
    },
  };
}

interface RefreshWindowReadiness {
  state: BrowserWindowConnectionState;
  peer?: {
    readonly sessionId: string;
    readonly generation: number;
    readonly connected: boolean;
  };
}

export type { BackgroundRuntimePort };
