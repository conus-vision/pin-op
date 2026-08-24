import { describeBrowserPackageContract } from "../../test/browserExtensionContract.js";

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
    "aria-readonly",
    "Rules",
  ],
  expectedChromiumCssScope: ".pin-op-elements-inspector",
  expectedNoticePackages: [
    "postcss@8.5.16",
    "postcss-selector-parser@7.1.0",
  ],
});
