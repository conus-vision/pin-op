import { vi } from "vitest";
import { describeBrowserAdapterContract } from "../../test/browserExtensionContract.js";

const harness = await vi.hoisted(async () => {
  const { createBrowserAdapterHarness } = await import(
    "../../test/browserExtensionContract.js"
  );
  return createBrowserAdapterHarness();
});

vi.mock("webextension-polyfill", () => ({ default: harness.browser }));
vi.mock("@pin-op/browser-extension-core", () => ({
  startBackgroundRuntime: harness.starts.background,
  startContentScriptRuntime: harness.starts.contentScript,
  startDevtoolsRuntime: harness.starts.devtools,
  startPanelRuntime: harness.starts.panel,
  sanitizeErrorMessage: harness.sanitize,
}));

describeBrowserAdapterContract(
  {
    platformName: "Chrome",
    extensionOrigin: "chrome-extension://pin-op",
    sourcePrefix: "chrome",
    extensionRoot: new URL("../", import.meta.url),
    importBackground: () => import("../src/background.js"),
    importContentScript: () => import("../src/contentScript.js"),
    importDevtools: () => import("../src/devtools.js"),
    importPanel: () => import("../src/panel.js"),
  },
  harness,
);
