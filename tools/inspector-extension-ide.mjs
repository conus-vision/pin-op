// Launches the Pin-op VS Code extension for the Inspector smoke and returns the
// link code the panel needs. The extension host runs a tiny runner that keeps
// the window alive until the browser side is done.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vscodeExtensionRoot = join(repositoryRoot, "extensions", "vscode");
const runnerPath = join(repositoryRoot, "tools", "inspector-extension-ide-runner.cjs");

const HANDSHAKE_TIMEOUT_MS = 90_000;

/**
 * Starts VS Code on `workspace` with the Pin-op extension in development mode.
 * Resolves once the bridge is listening and a link code exists.
 */
export async function startInspectorIde({ workspace, executablePath }) {
  await assertVSCodeExtensionBuild();
  const workspaceRoot = resolve(workspace);
  await assertDirectory(workspaceRoot, "Inspector IDE workspace");

  const ideRoot = await mkdtemp(join(tmpdir(), "pin-op-ide-"));
  const handshakePath = join(ideRoot, "handshake.json");
  const stopPath = join(ideRoot, "stop");
  const userDataRoot = join(ideRoot, "user-data");
  const extensionsRoot = join(ideRoot, "extensions");

  const executable = executablePath ?? await resolveVSCodeExecutable();
  const child = spawn(executable, [
    `--extensionDevelopmentPath=${vscodeExtensionRoot}`,
    `--extensionTestsPath=${runnerPath}`,
    `--user-data-dir=${userDataRoot}`,
    `--extensions-dir=${extensionsRoot}`,
    "--disable-telemetry",
    "--disable-updates",
    "--disable-workspace-trust",
    // Electron's sandbox switch is only accepted where a sandbox exists.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    workspaceRoot,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...hostEnvironment(),
      PIN_OP_IDE_HANDSHAKE: handshakePath,
      PIN_OP_IDE_STOP: stopPath,
    },
  });

  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      if (output.length < 32_768) output += chunk;
    });
  }

  const stop = async () => {
    try {
      await writeFile(stopPath, "stop", "utf8");
    } catch {
      // The host may already be gone.
    }
    await closeChild(child);
    await rm(ideRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  };

  try {
    const handshake = await readHandshake(handshakePath, child, () => output);
    return { linkCode: handshake.linkCode, workspace: workspaceRoot, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function readHandshake(handshakePath, child, readOutput) {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `VS Code exited before publishing a link code (${child.exitCode}): ${readOutput().slice(-2_000)}`,
      );
    }
    try {
      const handshake = JSON.parse(await readFile(handshakePath, "utf8"));
      if (typeof handshake.linkCode === "string" && handshake.linkCode.length > 0) {
        return handshake;
      }
    } catch {
      // The runner has not written the handshake yet.
    }
    await delay(250);
  }
  throw new Error(
    `VS Code never published a link code (${await readStatus(handshakePath)}): ${
      readOutput().slice(-2_000)
    }`,
  );
}

/** The in-host runner records its progress next to the handshake. */
async function readStatus(handshakePath) {
  try {
    return await readFile(`${handshakePath}.status`, "utf8");
  } catch {
    return "the extension host reported no progress";
  }
}

async function assertVSCodeExtensionBuild() {
  const bundle = join(vscodeExtensionRoot, "dist", "extension.cjs");
  try {
    await stat(bundle);
  } catch (error) {
    throw new Error(
      "The Pin-op VS Code extension is not built: run pnpm --filter pin-op run build",
      { cause: error },
    );
  }
}

async function assertDirectory(path, label) {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

/**
 * Reuses VSCODE_EXECUTABLE_PATH when the caller pins one, otherwise downloads
 * the same release the extension's own integration tests use.
 */
async function resolveVSCodeExecutable() {
  const pinned = process.env.VSCODE_EXECUTABLE_PATH;
  if (pinned) {
    await stat(pinned);
    return pinned;
  }
  const testElectron = await import(pathToFileURL(join(
    vscodeExtensionRoot,
    "node_modules",
    "@vscode",
    "test-electron",
    "out",
    "index.js",
  )).href);
  return testElectron.downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    cachePath: join(repositoryRoot, ".vscode-test"),
    reporter: new testElectron.SilentReporter(),
  });
}

async function closeChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, 10_000);
  try {
    child.kill();
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A terminal opened inside VS Code exports the extension host's own Electron
 * variables. Inherited, they make the launched Code.exe run as plain Node and
 * reject every window switch, so the smoke starts from a clean environment.
 */
function hostEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_")) {
      delete environment[name];
    }
  }
  return environment;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
