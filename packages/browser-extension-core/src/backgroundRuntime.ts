import {
  BackgroundInspectCoordinator,
  type BackgroundInspectApi,
} from "./backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundRouterSubscriptions,
  type BackgroundRuntimePort,
  type BackgroundTab,
  type BackgroundWindowCoordinator,
} from "./backgroundRouter.js";
import {
  BrowserWindowLinkStore,
  type SessionStorage,
} from "./browserWindowLinkStore.js";
import { WindowConnectionCoordinator } from "./windowConnectionCoordinator.js";

export interface BackgroundRuntimeOptions extends BackgroundInspectApi {
  readonly expectedDevtoolsUrl: string;
  readonly expectedPanelUrl: string;
  readonly storage: SessionStorage;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly subscribeRuntimeMessages: BackgroundRouterSubscriptions["subscribeRuntimeMessages"];
  readonly subscribeRuntimePorts: BackgroundRouterSubscriptions["subscribeRuntimePorts"];
  readonly subscribeWindowRemoved: BackgroundRouterSubscriptions["subscribeWindowRemoved"];
  readonly subscribeTabDetached: BackgroundRouterSubscriptions["subscribeTabDetached"];
  readonly subscribeTabAttached: BackgroundRouterSubscriptions["subscribeTabAttached"];
  readonly createWindowConnectionCoordinator?: (
    store: BrowserWindowLinkStore,
  ) => BackgroundWindowCoordinator &
    Pick<
      WindowConnectionCoordinator,
      | "onResolution"
      | "onPeerState"
      | "onSourceNavigationState"
      | "dispose"
    >;
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
  const router = createBackgroundRouter({
    expectedDevtoolsUrl: options.expectedDevtoolsUrl,
    expectedPanelUrl: options.expectedPanelUrl,
    getTab: options.getTab,
    coordinator,
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
    subscriptions: {
      subscribeRuntimeMessages: options.subscribeRuntimeMessages,
      subscribeRuntimePorts: options.subscribeRuntimePorts,
      subscribeWindowRemoved: options.subscribeWindowRemoved,
      subscribeTabDetached: options.subscribeTabDetached,
      subscribeTabAttached: options.subscribeTabAttached,
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
