import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTests } from "@vscode/test-electron";
import {
  assertRulesSourceJavaScriptContract,
} from "../../tools/browser-package-contract.mjs";
import { installVerifiedVsix } from "../../tools/install-vsix-for-smoke.mjs";
import { readArchive } from "../../tools/verify-artifacts.mjs";
import { resolveVSCodeTestRuntimeOptions } from "../../tools/vscode-smoke-runtime.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(extensionRoot, "../..");

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildInstalledVsixSmokeHarnessSource(expectedBundleSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedBundleSha256)) {
    throw new Error("Installed VSIX smoke requires an expected bundle SHA-256");
  }
  return [
    'const vscode = require("vscode");',
    'const { createHash } = require("node:crypto");',
    'const { readFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    "exports.run = async function () {",
    "  const extension = vscode.extensions.getExtension(",
    '    "conus-vision.pin-op",',
    "  );",
    '  if (!extension) throw new Error("Installed Pin-op VSIX was not found");',
    "  const metadataText = readFileSync(",
    '    join(extension.extensionPath, "dist", "runtime-metadata.json"),',
    '    "utf8",',
    "  );",
    "  let metadata;",
    "  try {",
    "    metadata = JSON.parse(metadataText);",
    "  } catch (error) {",
    '    throw new Error(`Installed Pin-op metadata is invalid JSON: ${error.message}`);',
    "  }",
    "  const metadataKeys = Object.keys(metadata).sort();",
    '  if (JSON.stringify(metadataKeys) !== JSON.stringify(["protocolVersion", "schemaVersion"])) {',
    '    throw new Error(`Installed Pin-op metadata has unexpected keys: ${metadataKeys.join(", ")}`);',
    "  }",
    "  if (metadata.schemaVersion !== 1 || metadata.protocolVersion !== 7) {",
    '    throw new Error(`Installed Pin-op metadata expected schema 1/protocol 7, found ${metadata.schemaVersion}/${metadata.protocolVersion}`);',
    "  }",
    "  const bundleBytes = readFileSync(",
    '    join(extension.extensionPath, "dist", "extension.cjs"),',
    "  );",
    `  const expectedBundleSha256 = ${JSON.stringify(expectedBundleSha256)};`,
    '  const installedBundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");',
    "  if (installedBundleSha256 !== expectedBundleSha256) {",
    '    throw new Error("Installed Pin-op bundle SHA-256 mismatch");',
    "  }",
    '  const bundleText = bundleBytes.toString("utf8");',
    '  for (const marker of ["source-navigation", "source-presentation", "source.matches", "source.open", "source.navigate", "source.navigationState", "matchId"]) {',
    "    if (!bundleText.includes(marker)) {",
    '      throw new Error(`Installed Pin-op bundle is missing ${marker}`);',
    "    }",
    "  }",
    "  const hasExactStringLiteral = (value) => bundleText.includes(JSON.stringify(value));",
    '  for (const marker of ["rules-sources", "rules.sources", "rules.open"]) {',
    "    if (!hasExactStringLiteral(marker)) {",
    '      throw new Error(`Installed Pin-op bundle is missing exact ${marker}`);',
    "    }",
    "  }",
    "  const forbiddenRulesOpenLiteral = [...bundleText.matchAll(/([\"'])((?:pin-op\\.)?rules\\.open[A-Za-z0-9._:-]+)\\1/g)]",
    "    .map((match) => match[2])",
    '    .find((value) => value !== "rules.open" && value !== "pin-op.rules.open");',
    "  if (forbiddenRulesOpenLiteral) {",
    '    throw new Error(`Installed Pin-op bundle contains forbidden Rules open acknowledgement ${forbiddenRulesOpenLiteral}`);',
    "  }",
    "  const api = await extension.activate();",
    '  if (!extension.isActive) throw new Error("Pin-op did not activate");',
    '  if (!api || typeof api.registerSourcePlugin !== "function") {',
    '    throw new Error("Pin-op returned an invalid public API");',
    "  }",
    '  console.log("INSTALLED_VSIX_PROTOCOL_V7_OK conus-vision.pin-op");',
    '  console.log("INSTALLED_VSIX_PROTOCOL_V7_RULES_SOURCES_OK package-contract-only");',
    '  console.log("INSTALLED_VSIX_ACTIVATION_OK conus-vision.pin-op");',
    "};",
    "",
  ].join("\n");
}

const invokedAsCli = Boolean(
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);
if (invokedAsCli) {
const artifactPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : undefined;
if (!artifactPath) {
  throw new Error("Usage: node smoke-installed-vsix.mjs <path-to-vsix>");
}
await access(artifactPath);
const artifactLabel = basename(artifactPath);
const artifactArchive = readArchive(artifactPath, artifactLabel);
const packagedBundle = artifactArchive.files.get("extension/dist/extension.cjs");
if (!Buffer.isBuffer(packagedBundle)) {
  throw new Error(`${artifactLabel} is missing extension/dist/extension.cjs`);
}
assertRulesSourceJavaScriptContract(
  packagedBundle.toString("utf8"),
  `${artifactLabel} installed smoke preflight`,
  {
    requiredStrings: [
      ["Rules source capability", "rules-sources"],
      ["Rules source publication", "rules.sources"],
      ["Rules source open", "rules.open"],
    ],
  },
);
const expectedBundleSha256 = sha256Hex(packagedBundle);
const runtimeOptions = await resolveVSCodeTestRuntimeOptions(
  process.env,
  repositoryRoot,
);

const smokeRoot = await mkdtemp(join(tmpdir(), "pin-op-vsix-smoke-"));
const extensionsDirectory = join(smokeRoot, "extensions");
const userDataDirectory = join(smokeRoot, "user-data");
const harnessDirectory = join(smokeRoot, "harness");
const workspaceDirectory = join(smokeRoot, "workspace");
await Promise.all([
  mkdir(extensionsDirectory, { recursive: true }),
  mkdir(userDataDirectory, { recursive: true }),
  mkdir(harnessDirectory, { recursive: true }),
  mkdir(workspaceDirectory, { recursive: true }),
]);

try {
  await installVerifiedVsix(artifactPath, extensionsDirectory);

  const harnessManifest = {
    name: "pin-op-installed-smoke",
    publisher: "pin-op-smoke",
    version: "0.0.0",
    engines: { vscode: "^1.85.0" },
    main: "./extension.cjs",
  };
  await Promise.all([
    writeFile(
      join(harnessDirectory, "package.json"),
      `${JSON.stringify(harnessManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(harnessDirectory, "extension.cjs"),
      "exports.activate = function () {};\n",
      "utf8",
    ),
    writeFile(
      join(harnessDirectory, "smoke.cjs"),
      buildInstalledVsixSmokeHarnessSource(expectedBundleSha256),
      "utf8",
    ),
  ]);

  delete process.env.ELECTRON_RUN_AS_NODE;
  const exitCode = await runTests({
    ...runtimeOptions,
    extensionDevelopmentPath: harnessDirectory,
    extensionTestsPath: join(harnessDirectory, "smoke.cjs"),
    launchArgs: [
      workspaceDirectory,
      "--extensions-dir",
      extensionsDirectory,
      "--user-data-dir",
      userDataDirectory,
      "--disable-telemetry",
    ],
  });
  if (exitCode !== 0) {
    throw new Error(`Installed VSIX smoke exited with code ${exitCode}`);
  }
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
}
