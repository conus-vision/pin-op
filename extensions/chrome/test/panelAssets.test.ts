import { describeBrowserPackageContract } from "../../test/browserExtensionContract.js";

describeBrowserPackageContract({
  platformName: "Chrome",
  extensionRoot: new URL("../", import.meta.url),
  buildTarget: "chrome116",
  expectedInspectorAssets: [
    "dist/inspector-panel.html",
    "dist/inspectorPanel.js",
    "dist/devtools-elements.css",
  ],
});
