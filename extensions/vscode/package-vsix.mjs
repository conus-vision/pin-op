import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBrowserArchive } from "../../tools/normalize-browser-archive.mjs";

const DEFAULT_SOURCE_DATE_EPOCH = "1704067200";
const extensionRoot = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(
  extensionRoot,
  "../../artifacts/browser2ide-vscode-0.3.0.vsix",
);
const require = createRequire(import.meta.url);
const vsceCli = require.resolve("@vscode/vsce/vsce");
const sourceDateEpoch =
  process.env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH;

validateSourceDateEpoch(sourceDateEpoch);
await mkdir(dirname(artifactPath), { recursive: true });

run(process.execPath, [
  vsceCli,
  "package",
  "--no-dependencies",
  "--out",
  artifactPath,
], {
  ...process.env,
  SOURCE_DATE_EPOCH: sourceDateEpoch,
});
await normalizeBrowserArchive(artifactPath);
run(process.execPath, [
  resolve(extensionRoot, "verify-vsix.mjs"),
  artifactPath,
]);

function validateSourceDateEpoch(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  const milliseconds = Number(value) * 1000;
  const minimumZipDate = Date.UTC(1980, 0, 1);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimumZipDate) {
    throw new Error(
      "SOURCE_DATE_EPOCH must be a ZIP-safe Unix timestamp on or after 1980-01-01",
    );
  }
}

function run(command, arguments_, env = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: extensionRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
