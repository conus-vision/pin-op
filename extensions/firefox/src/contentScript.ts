import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startContentRefreshBootstrapRuntime,
  startContentScriptRuntime,
  type ContentInspectPort,
  type ContentScriptDocument,
} from "@pin-op/browser-extension-core";

startContentRefreshBootstrapRuntime({
  globalScope: globalThis,
  document,
  view: window,
  location,
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  subscribeRuntimeMessages(listener) {
    const wrapped = ((message: unknown): Promise<unknown> | undefined => {
      const response = listener(message);
      return response === undefined ? undefined : Promise.resolve(response);
    }) as Parameters<typeof browser.runtime.onMessage.addListener>[0];
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  onError: (error) =>
    console.error("Pin-op content refresh:", sanitizeErrorMessage(error)),
});

startContentScriptRuntime({
  globalScope: globalThis,
  document: document as unknown as ContentScriptDocument,
  location,
  connectRuntimePort: (name) =>
    browser.runtime.connect({ name }) as unknown as ContentInspectPort,
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  subscribeRuntimeMessages(listener) {
    const wrapped = ((message: unknown): Promise<unknown> | undefined => {
      const response = listener(message);
      return response === undefined ? undefined : Promise.resolve(response);
    }) as Parameters<typeof browser.runtime.onMessage.addListener>[0];
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  onError: (error) =>
    console.error("Pin-op content script:", sanitizeErrorMessage(error)),
});
