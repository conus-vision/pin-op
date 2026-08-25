import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";

const launchRoot = mkdtempSync(join(resolve(tmpdir()), "pin-op-vscode-launch-"));
const placeholderRoot = join(launchRoot, "placeholder");
const userDataRoot = join(launchRoot, "user-data");
const workspaceFile = join(launchRoot, "pin-op-integration.code-workspace");
mkdirSync(placeholderRoot);
writeFileSync(workspaceFile, `${JSON.stringify({
  folders: [
    { path: resolve("../../examples/basic-css"), name: "basic-css" },
    { path: placeholderRoot, name: "pin-op-task6-placeholder" },
  ],
}, null, 2)}\n`, "utf8");
process.once("exit", () => {
  const resolvedRoot = resolve(launchRoot);
  if (
    dirname(resolvedRoot) === resolve(tmpdir()) &&
    basename(resolvedRoot).startsWith("pin-op-vscode-launch-")
  ) {
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
});

export default defineConfig({
  label: "sourcePluginApi",
  files: "dist/test/integration/**/*.test.cjs",
  version: "1.124.2",
  workspaceFolder: workspaceFile,
  extensionDevelopmentPath: [
    resolve("."),
    resolve("../source-plugin-fixture"),
  ],
  skipExtensionDependencies: true,
  env: { PIN_OP_TASK6_PLACEHOLDER_ROOT: placeholderRoot },
  mocha: { ui: "tdd", timeout: 20_000 },
  launchArgs: [
    "--disable-telemetry",
    `--user-data-dir=${userDataRoot}`,
  ],
});
