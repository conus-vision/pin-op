// Runs inside the VS Code extension host of the Inspector smoke. It starts the
// bridge, hands the link code back to the smoke through a file, and then keeps
// the host alive until the browser side is finished, because the host exits as
// soon as this function resolves.
"use strict";

const { writeFile, access } = require("node:fs/promises");
const vscode = require("vscode");

const HANDSHAKE_TIMEOUT_MS = 60_000;
const HOST_LIFETIME_MS = 10 * 60_000;

exports.run = async function run() {
  const handshakePath = process.env.PIN_OP_IDE_HANDSHAKE;
  const stopPath = process.env.PIN_OP_IDE_STOP;
  if (!handshakePath || !stopPath) {
    throw new Error("The Inspector IDE runner needs handshake and stop paths");
  }
  const statusPath = `${handshakePath}.status`;
  const note = async (stage, detail) => {
    try {
      await writeFile(statusPath, JSON.stringify({ stage, detail: String(detail ?? "") }), "utf8");
    } catch {
      // Status is a diagnostic; never fail the run over it.
    }
  };

  try {
    await note("activating");
    const extension = vscode.extensions.all.find((candidate) => (
      candidate.packageJSON?.contributes?.commands?.some(
        (command) => command.command === "pin-op.start",
      )
    ));
    await note("activating", extension ? extension.id : "extension not found");
    if (extension && !extension.isActive) await extension.activate();
    await note("starting");
    await vscode.commands.executeCommand("pin-op.start");
    await note("reading link code");
    const linkCode = await readLinkCode();
    await note("linked", linkCode.length);
    await writeFile(handshakePath, JSON.stringify({ linkCode }), "utf8");
  } catch (error) {
    await note("failed", error?.stack ?? error);
    throw error;
  }

  const deadline = Date.now() + HOST_LIFETIME_MS;
  while (Date.now() < deadline) {
    if (await exists(stopPath)) return;
    await delay(250);
  }
  throw new Error("The Inspector smoke never released the VS Code host");
};

/**
 * The link code is only published through the clipboard command, so poll it:
 * the bridge needs a moment to listen before a code exists.
 */
async function readLinkCode() {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await vscode.env.clipboard.writeText("");
      // Deliberately not awaited. While the bridge is still starting the copy
      // command parks on a warning notification that nothing will dismiss in a
      // test host, and awaiting it would strand the handshake forever.
      void vscode.commands.executeCommand("pin-op.copyLinkCode");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await delay(200);
        const value = (await vscode.env.clipboard.readText()).trim();
        if (value.length > 0) return value;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Pin-op never published a link code${lastError ? `: ${lastError}` : ""}; ${
      await readDiagnostics()
    }`,
  );
}

/**
 * Distinguishes the two ways the handshake can stall: a clipboard the host
 * cannot service, or a bridge that never reached the running state (the copy
 * command stays silent then).
 */
async function readDiagnostics() {
  try {
    const probe = `pin-op-clipboard-probe-${Date.now()}`;
    await vscode.env.clipboard.writeText(probe);
    const echoed = await vscode.env.clipboard.readText();
    return echoed === probe
      ? "the clipboard works, so the bridge never reached the running state"
      : `the host clipboard did not echo (${JSON.stringify(echoed).slice(0, 120)})`;
  } catch (error) {
    return `the host clipboard threw: ${error}`;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
