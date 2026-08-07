import { describeBrowserPackageContract } from "../../test/browserExtensionContract.js";

describeBrowserPackageContract({
  platformName: "Chrome",
  extensionRoot: new URL("../", import.meta.url),
  buildTarget: "chrome116",
});
