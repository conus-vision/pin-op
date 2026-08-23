import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startInspectorPanelRuntime,
  type PanelInspectPort,
} from "@pin-op/browser-extension-core";

startInspectorPanelRuntime({
  locationSearch: location.search,
  document,
  connectRuntimePort: (name) =>
    browser.runtime.connect({ name }) as unknown as PanelInspectPort,
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  readClipboard: () => navigator.clipboard.readText(),
  subscribeUnload(listener) {
    window.addEventListener("unload", listener);
    return () => window.removeEventListener("unload", listener);
  },
  onError: (error) =>
    console.error("Pin-op panel:", sanitizeErrorMessage(error)),
});
