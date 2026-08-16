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
  getTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    return { id: tab.id, windowId: tab.windowId };
  },
  subscribeRuntimeMessages(listener) {
    const wrapped = (message: unknown, sender: ChromeMessageSender) =>
      listener(message, adaptSender(sender));
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  subscribeRuntimePorts(listener) {
    const wrapped = (port: ChromeRuntimePort): void => {
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
  onError: (error) =>
    console.error("Pin-op background:", sanitizeErrorMessage(error)),
});

interface ChromeMessageSender {
  readonly url?: string;
  readonly tab?: {
    readonly id?: number;
    readonly windowId?: number;
  };
}

interface ChromeRuntimePort {
  readonly name: string;
  readonly sender?: ChromeMessageSender;
}

interface TabDetachInfo {
  readonly oldWindowId: number;
}

interface TabAttachInfo {
  readonly newWindowId: number;
}

function adaptSender(sender: ChromeMessageSender): BackgroundMessageSender {
  return {
    url: sender.url,
    tab: sender.tab
      ? { id: sender.tab.id, windowId: sender.tab.windowId }
      : undefined,
  };
}
