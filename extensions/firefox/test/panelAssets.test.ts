import { describeBrowserPackageContract } from "../../test/browserExtensionContract.js";

describeBrowserPackageContract({
  platformName: "Firefox",
  extensionRoot: new URL("../", import.meta.url),
  buildTarget: "firefox142",
});
