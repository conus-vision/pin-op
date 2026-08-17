import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { installVerifiedVsix } from "../../tools/install-vsix-for-smoke.mjs";
import { resolveVSCodeTestRuntimeOptions } from "../../tools/vscode-smoke-runtime.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(extensionRoot, "../..");
const artifactPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : undefined;
if (!artifactPath) {
  throw new Error("Usage: node smoke-installed-vsix.mjs <path-to-vsix>");
}
await access(artifactPath);
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
      [
        'const vscode = require("vscode");',
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
        "  if (metadata.schemaVersion !== 1 || metadata.protocolVersion !== 6) {",
        '    throw new Error(`Installed Pin-op metadata expected schema 1/protocol 6, found ${metadata.schemaVersion}/${metadata.protocolVersion}`);',
        "  }",
        "  const bundleText = readFileSync(",
        '    join(extension.extensionPath, "dist", "extension.cjs"),',
        '    "utf8",',
        "  );",
        '  for (const marker of ["source-navigation", "source-presentation", "source.matches", "source.open", "source.navigate", "source.navigationState", "matchId"]) {',
        "    if (!bundleText.includes(marker)) {",
        '      throw new Error(`Installed Pin-op bundle is missing ${marker}`);',
        "    }",
        "  }",
        "  const api = await extension.activate();",
        '  if (!extension.isActive) throw new Error("Pin-op did not activate");',
        '  if (!api || typeof api.registerSourcePlugin !== "function") {',
        '    throw new Error("Pin-op returned an invalid public API");',
        "  }",
        '  console.log("INSTALLED_VSIX_PROTOCOL_V6_OK conus-vision.pin-op");',
        '  console.log("INSTALLED_VSIX_ACTIVATION_OK conus-vision.pin-op");',
        "};",
        "",
      ].join("\n"),
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
      "--disable-extension-update-checks",
      "--disable-telemetry",
    ],
  });
  if (exitCode !== 0) {
    throw new Error(`Installed VSIX smoke exited with code ${exitCode}`);
  }
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
