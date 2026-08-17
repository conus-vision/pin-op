import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_BUNDLE_RELATIVE_PATH =
  "extensions/vscode/dist/extension.cjs";
const localBundlePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  LOCAL_BUNDLE_RELATIVE_PATH,
);

export function assertVsixBundleMatchesLocalBuild(packagedBundle, label) {
  let localBundle;
  try {
    localBundle = readFileSync(localBundlePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${label} cannot verify extension bundle parity: local build output ` +
          `${LOCAL_BUNDLE_RELATIVE_PATH} is missing`,
      );
    }
    throw new Error(
      `${label} cannot read local build output ${LOCAL_BUNDLE_RELATIVE_PATH}: ` +
        `${error.message}`,
    );
  }

  if (!Buffer.isBuffer(packagedBundle) || !packagedBundle.equals(localBundle)) {
    throw new Error(
      `${label} extension/dist/extension.cjs differs from local build output ` +
        LOCAL_BUNDLE_RELATIVE_PATH,
    );
  }
}
