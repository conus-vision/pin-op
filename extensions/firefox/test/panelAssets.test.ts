import {
  describeBrowserPackageContract,
  SHARED_CHROMIUM_UI_SELECTORS,
  SHARED_CHROMIUM_UI_SHA256,
} from "../../test/browserExtensionContract.js";

describeBrowserPackageContract({
  platformName: "Firefox",
  extensionRoot: new URL("../", import.meta.url),
  buildTarget: "firefox142",
  expectedInspectorAssets: [
    "dist/inspector-panel.html",
    "dist/inspectorPanel.js",
    "dist/devtools-elements.css",
  ],
  expectedInspectorBundleMarkers: [
    "styles.getMatched",
    "styles.setPseudoStates",
    "aria-readonly",
    "pseudo-state-button",
    "Pseudo-state previews",
    "Preview :",
    "data-pseudo-state",
    '["hover","focus"]',
    "Rules",
  ],
  expectedChromiumCssScope: ".pin-op-elements-inspector",
  expectedChromiumSelectors: SHARED_CHROMIUM_UI_SELECTORS,
  expectedChromiumUiSha256: SHARED_CHROMIUM_UI_SHA256,
  expectedNoticePackages: [
    "cssesc@3.0.0",
    "postcss@8.5.16",
    "postcss-selector-parser@7.1.0",
    "postcss-value-parser@4.2.0",
    "util-deprecate@1.0.2",
  ],
});
