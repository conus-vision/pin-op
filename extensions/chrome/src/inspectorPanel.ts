import browser from "webextension-polyfill";
import { createElementsInspectorView } from "@pin-op/devtools-elements-ui/upstream-runtime";
import {
  readPanelClipboardText,
  sanitizeErrorMessage,
  startInspectorPanelRuntime,
  type PanelInspectPort,
} from "@pin-op/browser-extension-core";

startInspectorPanelRuntime({
  locationSearch: location.search,
  document,
  createElementsInspectorView,
  connectRuntimePort: (name) =>
    browser.runtime.connect({ name }) as unknown as PanelInspectPort,
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  readClipboard: () => readPanelClipboardText({
    document,
    clipboard: navigator.clipboard,
  }),
  subscribeUnload(listener) {
    window.addEventListener("unload", listener);
    return () => window.removeEventListener("unload", listener);
  },
  onError: (error) =>
    console.error("Pin-op panel:", sanitizeErrorMessage(error)),
});
