import {
  BackgroundInspectCoordinator,
  type BackgroundInspectApi,
} from "./backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundRouterSubscriptions,
  type BackgroundRuntimePort,
  type BackgroundTabRefreshCoordinator,
  type BackgroundTab,
  type BackgroundWindowCoordinator,
} from "./backgroundRouter.js";
import {
  BrowserWindowLinkStore,
  type SessionStorage,
} from "./browserWindowLinkStore.js";
import { WindowConnectionCoordinator } from "./windowConnectionCoordinator.js";
import { TabRefreshCoordinator } from "./tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "./tabRefreshStateStore.js";

export interface BackgroundRuntimeOptions extends BackgroundInspectApi {
  readonly expectedDevtoolsUrl: string;
  readonly expectedPanelUrl: string;
  readonly storage: SessionStorage;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly getActiveTabId?: (windowId: number) => Promise<number | undefined>;
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
  readonly createWindowConnectionCoordinator?: (
    store: BrowserWindowLinkStore,
  ) => BackgroundWindowCoordinator &
    Pick<
      WindowConnectionCoordinator,
      | "onResolution"
      | "onPeerState"
      | "onSourceNavigationState"
      | "onPageRefresh"
      | "dispose"
    >;
  readonly createTabRefreshCoordinator?: (
    store: TabRefreshStateStore,
    coordinator: BackgroundWindowCoordinator,
  ) => BackgroundTabRefreshCoordinator & { initialize?(): Promise<void> };
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
  const tabRefreshCoordinator = options.createTabRefreshCoordinator?.(
    tabRefreshStore,
    coordinator,
  ) ?? new TabRefreshCoordinator({
    store: tabRefreshStore,
    getActiveTabId: options.getActiveTabId ?? (async () => undefined),
    dispatchRefresh: async (tabId, command) => {
      await options.sendTabMessage(tabId, command);
    },
    setRefreshParticipant: (windowId, tabId, participant) =>
      coordinator.setRefreshParticipant(windowId, tabId, participant),
    onError: options.onError,
  });
  void tabRefreshCoordinator.initialize?.().catch((error) =>
    options.onError?.(error),
  );
  const router = createBackgroundRouter({
    expectedDevtoolsUrl: options.expectedDevtoolsUrl,
    expectedPanelUrl: options.expectedPanelUrl,
    getTab: options.getTab,
    coordinator,
    tabRefreshCoordinator,
    inspectCoordinator,
    subscribeResolutions: (listener) => {
      const subscription = coordinator.onResolution((_windowId, message) =>
        listener(message),
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
        (windowId, message) => listener(windowId, message),
      );
      return () => subscription.dispose();
    },
    subscribePageRefreshes: (listener) => {
      const subscription = coordinator.onPageRefresh((windowId, message) =>
        listener(windowId, message),
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
      coordinator.dispose();
    },
  };
}

export type { BackgroundRuntimePort };
