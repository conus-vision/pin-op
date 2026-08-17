import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startBackgroundRuntime,
  type BackgroundMessageSender,
  type BackgroundRuntimePort,
} from "@pin-op/browser-extension-core";

startBackgroundRuntime({
  expectedDevtoolsUrl: browser.runtime.getURL("dist/devtools.html"),
  expectedPanelUrl: browser.runtime.getURL("dist/panel.html"),
  storage: {
    get: (key) => browser.storage.session.get(key),
    set: (values) => browser.storage.session.set(values),
    remove: (key) => browser.storage.session.remove(key),
  },
  executeScript: (details) => browser.scripting.executeScript(details),
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
  sendTopFrameMessage: (tabId, message) =>
    browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
  reloadTab: (tabId) => browser.tabs.reload(tabId),
  getTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    return { id: tab.id, windowId: tab.windowId };
  },
  getActiveTabId: async (windowId) => {
    const tabs = await browser.tabs.query({ active: true, windowId });
    if (tabs.length !== 1 || !isBrowserId(tabs[0]?.id)) {
      return undefined;
    }
    return tabs[0].id;
  },
  subscribeRuntimeMessages(listener) {
    const wrapped = (message: unknown, sender: FirefoxMessageSender) =>
      listener(message, adaptSender(sender));
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  subscribeRuntimePorts(listener) {
    const wrapped = (port: FirefoxRuntimePort): void => {
      listener(port as unknown as BackgroundRuntimePort);
    };
    browser.runtime.onConnect.addListener(wrapped);
    return () => browser.runtime.onConnect.removeListener(wrapped);
  },
  subscribeWindowRemoved(listener) {
    browser.windows.onRemoved.addListener(listener);
    return () => browser.windows.onRemoved.removeListener(listener);
  },
  subscribeTabDetached(listener) {
    const wrapped = (tabId: number, info: TabDetachInfo): void => {
      listener(tabId, info.oldWindowId);
    };
    browser.tabs.onDetached.addListener(wrapped);
    return () => browser.tabs.onDetached.removeListener(wrapped);
  },
  subscribeTabAttached(listener) {
    const wrapped = (tabId: number, info: TabAttachInfo): void => {
      listener(tabId, info.newWindowId);
    };
    browser.tabs.onAttached.addListener(wrapped);
    return () => browser.tabs.onAttached.removeListener(wrapped);
  },
  subscribeTabActivated(listener) {
    const wrapped = (info: TabActivationInfo): void => {
      listener(info.tabId, info.windowId);
    };
    browser.tabs.onActivated.addListener(wrapped);
    return () => browser.tabs.onActivated.removeListener(wrapped);
  },
  subscribeTabRemoved(listener) {
    const wrapped = (tabId: number): void => listener(tabId);
    browser.tabs.onRemoved.addListener(wrapped);
    return () => browser.tabs.onRemoved.removeListener(wrapped);
  },
  subscribeTabUpdated(listener) {
    const wrapped = (
      tabId: number,
      change: TabChangeInfo,
      tab: BrowserTab,
    ): void => {
      listener(tabId, {
        ...(change.status === "loading" || change.status === "complete"
          ? { status: change.status }
          : {}),
        ...(typeof (change.url ?? tab.url) === "string"
          ? { url: change.url ?? tab.url }
          : {}),
        ...(isBrowserId(tab.windowId) ? { windowId: tab.windowId } : {}),
      });
    };
    browser.tabs.onUpdated.addListener(wrapped);
    return () => browser.tabs.onUpdated.removeListener(wrapped);
  },
  onError: (error) =>
    console.error("Pin-op background:", sanitizeErrorMessage(error)),
});

interface FirefoxMessageSender {
  readonly url?: string;
  readonly frameId?: number;
  readonly tab?: {
    readonly id?: number;
    readonly windowId?: number;
  };
}

interface FirefoxRuntimePort {
  readonly name: string;
  readonly sender?: FirefoxMessageSender;
}

interface TabDetachInfo {
  readonly oldWindowId: number;
}

interface TabAttachInfo {
  readonly newWindowId: number;
}

interface TabActivationInfo {
  readonly tabId: number;
  readonly windowId: number;
}

interface TabChangeInfo {
  readonly status?: string;
  readonly url?: string;
}

interface BrowserTab {
  readonly windowId?: number;
  readonly url?: string;
}

function adaptSender(sender: FirefoxMessageSender): BackgroundMessageSender {
  return {
    url: sender.url,
    frameId: sender.frameId,
    tab: sender.tab
      ? { id: sender.tab.id, windowId: sender.tab.windowId }
      : undefined,
  };
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
