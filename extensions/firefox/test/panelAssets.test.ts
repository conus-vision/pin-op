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
});
