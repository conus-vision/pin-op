import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startDevtoolsRuntime,
} from "@pinop/browser-extension-core";

startDevtoolsRuntime({
  inspectedTabId: browser.devtools.inspectedWindow.tabId,
  sourcePrefix: "chrome",
  createId: () => globalThis.crypto.randomUUID(),
  async createPanel(title, icon, page) {
    const panel = await browser.devtools.panels.create(title, icon, page);
    return {
      addShownListener: (listener) => panel.onShown.addListener(listener),
      removeShownListener: (listener) => panel.onShown.removeListener(listener),
    };
  },
  subscribeRuntimeMessages(listener) {
    const wrapped = (message: unknown): void => listener(message);
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  subscribeUnload(listener) {
    window.addEventListener("unload", listener);
    return () => window.removeEventListener("unload", listener);
  },
  onError: (error) =>
    console.error("PinOp DevTools:", sanitizeErrorMessage(error)),
});
