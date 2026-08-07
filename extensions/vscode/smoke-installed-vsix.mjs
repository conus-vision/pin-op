import { spawnSync } from "node:child_process";
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
import {
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const artifactPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : undefined;
if (!artifactPath) {
  throw new Error("Usage: node smoke-installed-vsix.mjs <path-to-vsix>");
}
await access(artifactPath);

const vscodeExecutablePath =
  process.env.VSCODE_EXECUTABLE_PATH ?? defaultVSCodeExecutablePath();
await access(vscodeExecutablePath);

const smokeRoot = await mkdtemp(join(tmpdir(), "browser2ide-vsix-smoke-"));
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
  const [cli, ...cliPrefix] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath,
    { reuseMachineInstall: true },
  );
  run(cli, [
    ...cliPrefix,
    "--install-extension",
    artifactPath,
    "--force",
    "--extensions-dir",
    extensionsDirectory,
    "--user-data-dir",
    userDataDirectory,
  ]);
  run(cli, [
    ...cliPrefix,
    "--list-extensions",
    "--show-versions",
    "--extensions-dir",
    extensionsDirectory,
    "--user-data-dir",
    userDataDirectory,
  ]);

  const harnessManifest = {
    name: "browser2ide-installed-smoke",
    publisher: "browser2ide-smoke",
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
        '    "browser2ide.browser2ide-vscode",',
        "  );",
        '  if (!extension) throw new Error("Installed Browser2IDE VSIX was not found");',
        "  const metadataText = readFileSync(",
        '    join(extension.extensionPath, "dist", "runtime-metadata.json"),',
        '    "utf8",',
        "  );",
        "  let metadata;",
        "  try {",
        "    metadata = JSON.parse(metadataText);",
        "  } catch (error) {",
        '    throw new Error(`Installed Browser2IDE metadata is invalid JSON: ${error.message}`);',
        "  }",
        "  const metadataKeys = Object.keys(metadata).sort();",
        '  if (JSON.stringify(metadataKeys) !== JSON.stringify(["protocolVersion", "schemaVersion"])) {',
        '    throw new Error(`Installed Browser2IDE metadata has unexpected keys: ${metadataKeys.join(", ")}`);',
        "  }",
        "  if (metadata.schemaVersion !== 1 || metadata.protocolVersion !== 4) {",
        '    throw new Error(`Installed Browser2IDE metadata expected schema 1/protocol 4, found ${metadata.schemaVersion}/${metadata.protocolVersion}`);',
        "  }",
        "  const api = await extension.activate();",
        '  if (!extension.isActive) throw new Error("Browser2IDE did not activate");',
        '  if (!api || typeof api.registerSourcePlugin !== "function") {',
        '    throw new Error("Browser2IDE returned an invalid public API");',
        "  }",
        '  console.log("INSTALLED_VSIX_PROTOCOL_V4_OK browser2ide.browser2ide-vscode");',
        '  console.log("INSTALLED_VSIX_ACTIVATION_OK browser2ide.browser2ide-vscode");',
        "};",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);

  delete process.env.ELECTRON_RUN_AS_NODE;
  const exitCode = await runTests({
    vscodeExecutablePath,
    reuseMachineInstall: true,
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

function defaultVSCodeExecutablePath() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Microsoft VS Code",
      "Code.exe",
    );
  }
  throw new Error(
    "Set VSCODE_EXECUTABLE_PATH to a local VS Code executable for the smoke test",
  );
}

function run(command, arguments_) {
  const executable = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : command;
  const spawnArguments = process.platform === "win32"
    ? ["/d", "/c", command, ...arguments_]
    : arguments_;
  const result = spawnSync(executable, spawnArguments, {
    cwd: smokeRoot,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `VS Code CLI exited with code ${result.status}: ${command} ${arguments_.join(" ")}`,
    );
  }
}
