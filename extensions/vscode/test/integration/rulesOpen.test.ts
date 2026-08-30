import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";

const PROTOCOL_VERSION = 7;
const EXTENSION_ID = "conus-vision.pin-op";
const TEMP_WORKSPACE_PREFIX = "pin-op-task6-";
const INTEGRATION_LOCK_NAME = "pin-op-rules-open.integration.lock";
const INTEGRATION_LOCK_WAIT_MS = 8_000;
const INTEGRATION_LOCK_STALE_MS = 5_000;
const socketErrorGuards = new WeakMap<WebSocket, (error: Error) => void>();

interface IntegrationLock {
  readonly path: string;
  readonly token: string;
}

interface InitialWorkspaces {
  readonly fixture: vscode.WorkspaceFolder;
  readonly placeholder: vscode.WorkspaceFolder;
}

suite("Pin-op Rules source opening", () => {
  test("uses the production managed bridge and only opaque open authority", async () => {
    let integrationLock: IntegrationLock | undefined;
    let originalClipboard = "";
    let clipboardSaved = false;
    let tempRoot: string | undefined;
    let tempUri: vscode.Uri | undefined;
    let browser: WebSocket | undefined;
    let copyLinkCommand: Promise<unknown> | undefined;
    let pinOpMayBeRunning = false;
    let initialWorkspaces: InitialWorkspaces | undefined;
    let bodyFailure: unknown;

    try {
      integrationLock = await acquireIntegrationLock();
      originalClipboard = await vscode.env.clipboard.readText();
      clipboardSaved = true;

      initialWorkspaces = requireInitialWorkspaces();
      tempRoot = await createTempRoot();
      tempUri = vscode.Uri.file(tempRoot);
      await populateTempWorkspace(initialWorkspaces.fixture, tempRoot);
      await replaceSecondWorkspaceFolder(
        initialWorkspaces.placeholder.uri,
        tempUri,
      );
      const workspace = requireWorkspaceFolder(tempUri);

      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, "the production Pin-op extension must be installed");
      const clipboardSentinel = `pin-op-integration-${randomUUID()}`;
      await vscode.env.clipboard.writeText(clipboardSentinel);
      await extension.activate();
      pinOpMayBeRunning = true;
      await vscode.commands.executeCommand("pin-op.start");

      copyLinkCommand = beginCopyLinkCode();
      const linkCode = await waitForLinkCode(clipboardSentinel);
      await dismissAndAwaitCopyLink(copyLinkCommand);
      copyLinkCommand = undefined;
      const port = Number(linkCode.slice(0, 5));
      const pin = linkCode.slice(5);
      assert.ok(Number.isSafeInteger(port) && port > 0, "link port must be valid");
      assert.match(pin, /^\d{2}$/);

      browser = await openSocket(`ws://127.0.0.1:${port}`);
      const acceptedPromise = waitForMessage(browser, (message) =>
        message.type === "linkAccepted"
      );
      sendJson(browser, {
        protocolVersion: PROTOCOL_VERSION,
        type: "linkRequest",
        messageId: "rules-integration-link",
        pin,
        source: { role: "browser", id: "rules-integration-browser", metadata: {} },
        metadata: {},
      });
      const accepted = await acceptedPromise;
      const authenticatedPromise = waitForMessage(browser, (message) =>
        message.type === "authenticated"
      );
      sendJson(browser, {
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        messageId: "rules-integration-hello",
        sessionId: requiredString(accepted, "sessionId"),
        authToken: requiredString(accepted, "authToken"),
        bridgeInstanceId: requiredString(accepted, "bridgeInstanceId"),
        source: { role: "browser", id: "rules-integration-browser", metadata: {} },
        capabilities: [
          "inspect",
          "link",
          "source-presentation",
          "presentation-settings",
          "source-navigation",
          "auto-refresh",
          "rules-sources",
        ],
        metadata: {},
      });
      const authenticated = await authenticatedPromise;
      const sessionId = requiredString(authenticated, "sessionId");

      const sourcesPromise = waitForMessage(browser, (message) =>
        message.type === "rules.sources" &&
        message.inspectMessageId === "rules-integration-inspect"
      );
      sendJson(browser, rulesInspectMessage(sessionId, workspace.name));
      const publication = await sourcesPromise;
      const sources = requiredObjects(publication, "sources");
      assert.equal(sources.length, 2);
      assert.equal(publication.unresolvedRuleCount, 0);
      const scssSource = sourceByLabel(sources, "app.scss");
      const cssSource = sourceByLabel(sources, "fallback.css");
      assert.deepEqual(scssSource.document, {
        label: "app.scss",
        languageId: "scss",
      });
      assert.equal(scssSource.confidence, "sourcemap");
      assert.equal(cssSource.confidence, "exact");

      const appUri = vscode.Uri.joinPath(workspace.uri, "src", "app.scss");
      const appBlock = new vscode.Range(7, 0, 13, 1);
      await seedRuleOffScreen(appUri, appBlock);
      const indexUri = vscode.Uri.joinPath(workspace.uri, "index.html");
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(indexUri),
      );

      const scssOpen = rulesOpenMessage(sessionId, publication, scssSource);
      const rulesWire = [publication, scssOpen];
      sendJson(browser, scssOpen);

      const appEditor = await waitForOpenedRule(
        appUri,
        new vscode.Position(7, 0),
        appBlock,
      );
      assert.equal(
        appEditor.document.getText(appBlock).replaceAll("\r\n", "\n"),
        [
          ".dynamic-card {",
          "  max-width: 20rem;",
          "  margin-block-start: 0.5rem;",
          "  padding: 0.75rem;",
          "  border: 2px solid #1769aa;",
          "  background: #eef6fc;",
          "}",
        ].join("\n"),
      );

      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(indexUri),
      );
      const replacementPromise = waitForMessage(browser, (message) =>
        message.type === "rules.sources" &&
        typeof message.rulesGeneration === "number" &&
        message.rulesGeneration > requiredNumber(publication, "rulesGeneration")
      );
      const fallbackUri = vscode.Uri.joinPath(workspace.uri, "fallback.css");
      const fallbackBytes = await vscode.workspace.fs.readFile(fallbackUri);
      const changedFallback = new Uint8Array([
        ...fallbackBytes,
        ...new TextEncoder().encode("\n/* pin-op integration stale */\n"),
      ]);
      await vscode.workspace.fs.writeFile(fallbackUri, changedFallback);
      const replacement = await replacementPromise;
      rulesWire.push(replacement);

      const staleOpen = rulesOpenMessage(sessionId, publication, cssSource);
      rulesWire.push(staleOpen);
      const rejectedPromise = waitForMessage(browser, (message) =>
        message.type === "error"
      );
      sendJson(browser, staleOpen);
      await rejectedPromise;
      await delay(100);
      assert.equal(
        vscode.window.activeTextEditor?.document.uri.toString(),
        indexUri.toString(),
      );

      const rulesWireText = JSON.stringify(rulesWire);
      assert.doesNotMatch(
        rulesWireText,
        /file:|[A-Za-z]:[\\/]|"(?:uri|path|range|documentVersion)"\s*:/i,
      );
      for (const openMessage of [scssOpen, staleOpen]) {
        assert.deepEqual(Object.keys(openMessage).sort(), [
          "inspectMessageId",
          "messageId",
          "metadata",
          "openAuthorityId",
          "protocolVersion",
          "rulesGeneration",
          "sessionId",
          "type",
        ]);
      }
    } catch (error) {
      bodyFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    await captureCleanup("copy notification", cleanupFailures, async () => {
      if (copyLinkCommand) await dismissAndAwaitCopyLink(copyLinkCommand);
    });
    await captureCleanup("browser socket", cleanupFailures, async () => {
      if (browser) await closeSocket(browser);
    });
    await captureCleanup("Pin-op bridge", cleanupFailures, async () => {
      if (pinOpMayBeRunning) {
        await vscode.commands.executeCommand("pin-op.stop");
      }
    });
    await captureCleanup("active editor", cleanupFailures, async () => {
      if (initialWorkspaces) {
        const initialIndex = vscode.Uri.joinPath(
          initialWorkspaces.fixture.uri,
          "index.html",
        );
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(initialIndex),
        );
      }
    });
    await captureCleanup("temporary workspace folder", cleanupFailures, async () => {
      if (tempUri && initialWorkspaces) {
        await restoreSecondWorkspaceFolder(
          tempUri,
          initialWorkspaces.placeholder,
        );
      }
    });
    await captureCleanup("temporary workspace files", cleanupFailures, async () => {
      if (tempRoot) await removeTempRoot(tempRoot);
    });
    await captureCleanup("clipboard", cleanupFailures, async () => {
      if (clipboardSaved) await vscode.env.clipboard.writeText(originalClipboard);
    });
    await captureCleanup("integration lock", cleanupFailures, async () => {
      if (integrationLock) await releaseIntegrationLock(integrationLock);
    });

    throwCollectedFailures(bodyFailure, cleanupFailures);
  });
});

function beginCopyLinkCode(): Promise<unknown> {
  const command = Promise.resolve(
    vscode.commands.executeCommand("pin-op.copyLinkCode"),
  );
  void command.catch(() => undefined);
  return command;
}

async function dismissAndAwaitCopyLink(command: Promise<unknown>): Promise<void> {
  await vscode.commands.executeCommand("notifications.clearAll");
  await withTimeout(command, 2_000, "copy-link notification did not close");
}

async function waitForLinkCode(sentinel: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await vscode.env.clipboard.readText();
    if (value !== sentinel && /^\d{7}$/.test(value)) return value;
    await delay(50);
  }
  throw new Error("The production BridgeManager did not publish a link code");
}

function requireInitialWorkspaces(): InitialWorkspaces {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2, "the integration workspace must start multi-root");
  const fixture = folders[0];
  const placeholder = folders[1];
  assert.ok(fixture && placeholder);
  assert.equal(fixture.name, "basic-css");
  const placeholderRoot = process.env.PIN_OP_TASK6_PLACEHOLDER_ROOT;
  assert.ok(placeholderRoot, "the launch placeholder path must be provided");
  assert.equal(
    placeholder.uri.toString(),
    vscode.Uri.file(placeholderRoot).toString(),
  );
  return { fixture, placeholder };
}

function requireWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
  const workspace = vscode.workspace.getWorkspaceFolder(uri);
  assert.ok(workspace, `expected temporary workspace ${uri.toString()}`);
  assert.equal(workspace.uri.toString(), uri.toString());
  return workspace;
}

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(resolve(tmpdir()), TEMP_WORKSPACE_PREFIX));
  assertSafeTempRoot(root);
  return root;
}

async function populateTempWorkspace(
  fixture: vscode.WorkspaceFolder,
  tempRoot: string,
): Promise<void> {
  await Promise.all([
    mkdir(join(tempRoot, "dist"), { recursive: true }),
    mkdir(join(tempRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(fixture.uri.fsPath, "dist", "app.css"), join(tempRoot, "dist", "app.css")),
    copyFile(join(fixture.uri.fsPath, "dist", "app.css.map"), join(tempRoot, "dist", "app.css.map")),
    copyFile(join(fixture.uri.fsPath, "src", "card.scss"), join(tempRoot, "src", "card.scss")),
    copyFile(join(fixture.uri.fsPath, "src", "layout.scss"), join(tempRoot, "src", "layout.scss")),
    copyFile(join(fixture.uri.fsPath, "fallback.css"), join(tempRoot, "fallback.css")),
  ]);
  const appScss = await readFile(join(fixture.uri.fsPath, "src", "app.scss"), "utf8");
  const offScreenTail = Array.from(
    { length: 240 },
    (_, index) => `/* task6 off-screen ${index + 1} */`,
  ).join("\n");
  await Promise.all([
    writeFile(join(tempRoot, "src", "app.scss"), `${appScss}\n${offScreenTail}\n`, "utf8"),
    writeFile(
      join(tempRoot, "index.html"),
      "<!doctype html><meta charset=\"utf-8\"><title>Pin-op Task 6</title>\n",
      "utf8",
    ),
  ]);
}

async function replaceSecondWorkspaceFolder(
  placeholderUri: vscode.Uri,
  uri: vscode.Uri,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2);
  assert.equal(folders[1]?.uri.toString(), placeholderUri.toString());
  await updateWorkspaceFoldersAndWait(uri, "added", () =>
    vscode.workspace.updateWorkspaceFolders(1, 1, {
      uri,
      name: basename(uri.fsPath),
    })
  );
  assert.equal(vscode.workspace.workspaceFolders?.length, 2);
  assert.equal(vscode.workspace.workspaceFolders?.[1]?.uri.toString(), uri.toString());
}

async function restoreSecondWorkspaceFolder(
  uri: vscode.Uri,
  placeholder: vscode.WorkspaceFolder,
): Promise<void> {
  const index = (vscode.workspace.workspaceFolders ?? []).findIndex(
    (folder) => folder.uri.toString() === uri.toString(),
  );
  if (index < 0) return;
  await updateWorkspaceFoldersAndWait(placeholder.uri, "added", () =>
    vscode.workspace.updateWorkspaceFolders(index, 1, {
      uri: placeholder.uri,
      name: placeholder.name,
    })
  );
  assert.equal(
    vscode.workspace.workspaceFolders?.[1]?.uri.toString(),
    placeholder.uri.toString(),
  );
}

async function updateWorkspaceFoldersAndWait(
  uri: vscode.Uri,
  kind: "added" | "removed",
  update: () => boolean,
): Promise<void> {
  let subscription: vscode.Disposable | undefined;
  const changed = new Promise<void>((resolveChange) => {
    subscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      if (event[kind].some((folder) => folder.uri.toString() === uri.toString())) {
        resolveChange();
      }
    });
  });
  try {
    assert.equal(update(), true, `workspace folder ${kind} update must start`);
    await withTimeout(changed, 5_000, `workspace folder was not ${kind}`);
  } finally {
    subscription?.dispose();
  }
}

async function removeTempRoot(root: string): Promise<void> {
  assertSafeTempRoot(root);
  await rm(root, { recursive: true, force: true });
}

function assertSafeTempRoot(root: string): void {
  const tempDirectory = resolve(tmpdir());
  const resolvedRoot = resolve(root);
  const child = relative(tempDirectory, resolvedRoot);
  assert.equal(dirname(resolvedRoot), tempDirectory);
  assert.ok(child.length > 0 && !isAbsolute(child) && !child.startsWith(".."));
  assert.ok(basename(resolvedRoot).startsWith(TEMP_WORKSPACE_PREFIX));
}

async function seedRuleOffScreen(
  uri: vscode.Uri,
  targetBlock: vscode.Range,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  assert.ok(document.lineCount > 200, "the test source must have an off-screen tail");
  const editor = await vscode.window.showTextDocument(document);
  const bottom = document.lineAt(document.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(bottom, bottom);
  editor.revealRange(
    new vscode.Range(bottom, bottom),
    vscode.TextEditorRevealType.InCenter,
  );
  await waitForEditorState(uri, (candidate) =>
    candidate.selection.active.isEqual(bottom) &&
    candidate.selection.isEmpty &&
    candidate.visibleRanges.some((range) => range.contains(bottom)) &&
    candidate.visibleRanges.every((range) =>
      range.intersection(targetBlock) === undefined
    )
  );
}

async function waitForOpenedRule(
  uri: vscode.Uri,
  position: vscode.Position,
  block: vscode.Range,
): Promise<vscode.TextEditor> {
  return waitForEditorState(uri, (editor) =>
    editor.selection.isEmpty &&
    editor.selection.active.isEqual(position) &&
    editor.selection.anchor.isEqual(position) &&
    editor.visibleRanges.some((range) =>
      range.contains(block.start) && range.contains(block.end)
    )
  );
}

async function waitForEditorState(
  uri: vscode.Uri,
  predicate: (editor: vscode.TextEditor) => boolean,
): Promise<vscode.TextEditor> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() === uri.toString() && predicate(editor)) {
      return editor;
    }
    await delay(20);
  }
  throw new Error(`Editor did not reach the required state for ${uri.toString()}`);
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  let onOpen = (): void => undefined;
  let onError = (_error: Error): void => undefined;
  const opened = new Promise<void>((resolve, reject) => {
    onOpen = () => resolve();
    onError = (error) => reject(error);
  });
  socket.on("open", onOpen);
  socket.on("error", onError);
  socketErrorGuards.set(socket, onError);
  try {
    await withTimeout(opened, 5_000, "Timed out opening the bridge socket");
    return socket;
  } catch (error) {
    try {
      await closeSocket(socket);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Bridge socket failed to open and terminate",
      );
    }
    throw error;
  } finally {
    socket.off("open", onOpen);
    if (socket.readyState === WebSocket.CLOSED) {
      socket.off("error", onError);
      socketErrorGuards.delete(socket);
    }
  }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  let onClose = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    onClose = () => resolve();
  });
  const onError = (): void => undefined;
  socket.on("close", onClose);
  socket.on("error", onError);
  try {
    if (socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    } else {
      socket.close(1000, "integration cleanup");
    }
    try {
      await withTimeout(closed, 1_000, "bridge socket did not close cleanly");
    } catch {
      socket.terminate();
      await withTimeout(closed, 1_000, "bridge socket did not terminate");
    }
  } finally {
    socket.off("close", onClose);
    socket.off("error", onError);
    const errorGuard = socketErrorGuards.get(socket);
    if (errorGuard) socket.off("error", errorGuard);
    socketErrorGuards.delete(socket);
  }
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error("Timed out waiting for a bridge message"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: WebSocket.RawData): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolveMessage(message);
    };
    const onClose = (): void => {
      cleanup();
      rejectMessage(new Error("Bridge socket closed before the expected message"));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectMessage(error);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function sendJson(socket: WebSocket, message: Record<string, unknown>): void {
  socket.send(JSON.stringify(message));
}

function rulesInspectMessage(
  sessionId: string,
  workspaceName: string,
): Record<string, unknown> {
  const workspacePath = encodeURIComponent(workspaceName);
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "rules-integration-inspect",
    sessionId,
    source: { role: "browser", id: "rules-integration-browser", metadata: {} },
    ideHighlightEnabled: false,
    targets: [{
      role: "selected",
      depth: 0,
      subject: { selector: ".dynamic-card", metadata: {} },
      facts: [],
      metadata: {},
    }],
    ruleEvidence: {
      rules: [
        ruleEvidence(
          "rule-scss",
          `http://localhost:4173/${workspacePath}/dist/app.css`,
          ".dynamic-card",
          // The line the fixture's compiled `.dynamic-card` rule starts on.
          105,
          [
            ["max-width", "20rem"],
            ["margin-block-start", "0.5rem"],
            ["padding", "0.75rem"],
            ["border", "2px solid #1769aa"],
            ["background", "#eef6fc"],
          ],
        ),
        ruleEvidence(
          "rule-css",
          `http://localhost:4173/${workspacePath}/fallback.css`,
          ".card",
          1,
          [["background-color", "#f5f7fa"]],
        ),
      ],
      omittedRuleCount: 0,
    },
    context: {
      url: `http://localhost:4173/${workspacePath}/index.html`,
      metadata: {},
    },
    metadata: {},
  };
}

function ruleEvidence(
  ruleRef: string,
  sourceUrl: string,
  selector: string,
  startLine: number,
  declarations: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  return {
    ruleRef,
    selector,
    declarations: declarations.map(([property, value]) => ({
      property,
      value,
      important: false,
      valueTruncated: false,
    })),
    declarationsTruncated: false,
    generatedSource: {
      sourceUrl,
      startLine,
      startColumn: 1,
      contexts: [],
      contextsTruncated: false,
      unsupportedGroupContext: false,
    },
  };
}

function rulesOpenMessage(
  sessionId: string,
  publication: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.open",
    messageId: `rules-open-${requiredString(source, "ruleRef")}`,
    sessionId,
    inspectMessageId: requiredString(publication, "inspectMessageId"),
    rulesGeneration: requiredNumber(publication, "rulesGeneration"),
    openAuthorityId: requiredString(source, "openAuthorityId"),
    metadata: {},
  };
}

function sourceByLabel(
  sources: readonly Record<string, unknown>[],
  label: string,
): Record<string, unknown> {
  const source = sources.find((candidate) => {
    const document = candidate.document;
    return isRecord(document) && document.label === label;
  });
  assert.ok(source, `expected Rules source for ${label}`);
  return source;
}

function requiredObjects(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const entries = value[key];
  assert.ok(Array.isArray(entries) && entries.every(isRecord), `${key} must be objects`);
  return entries;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string", `${key} must be a string`);
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  assert.equal(typeof field, "number", `${key} must be a number`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function acquireIntegrationLock(): Promise<IntegrationLock> {
  const lockPath = integrationLockPath();
  const token = randomUUID();
  const ownerPath = `${lockPath}.${token}.owner`;
  const deadline = Date.now() + INTEGRATION_LOCK_WAIT_MS;
  try {
    await writeIntegrationLockOwner(ownerPath, token);
    while (Date.now() < deadline) {
      try {
        await link(ownerPath, lockPath);
        return { path: lockPath, token };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        await reclaimStaleIntegrationLock(lockPath);
        await delay(100);
      }
    }
  } finally {
    await unlink(ownerPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
  }
  throw new Error(`Timed out waiting for the Task 6 integration lock: ${lockPath}`);
}

async function writeIntegrationLockOwner(
  ownerPath: string,
  token: string,
): Promise<void> {
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      token,
      pid: process.pid,
      createdAt: Date.now(),
    }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function reclaimStaleIntegrationLock(lockPath: string): Promise<void> {
  let contents: string;
  let modifiedAt: number;
  try {
    [contents, modifiedAt] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath).then((entry) => entry.mtimeMs),
    ]);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (Date.now() - modifiedAt < INTEGRATION_LOCK_STALE_MS) return;
  const owner = parseLockOwner(contents);
  if (owner && processIsAlive(owner.pid)) return;
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (current !== contents) return;
  await unlink(lockPath).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

async function releaseIntegrationLock(lock: IntegrationLock): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(lock.path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (parseLockOwner(contents)?.token !== lock.token) return;
  await unlink(lock.path).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

function integrationLockPath(): string {
  const tempDirectory = resolve(tmpdir());
  const lockPath = resolve(tempDirectory, INTEGRATION_LOCK_NAME);
  assert.equal(dirname(lockPath), tempDirectory);
  return lockPath;
}

function parseLockOwner(
  value: string,
): { readonly token: string; readonly pid: number } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.token !== "string" ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0
    ) {
      return undefined;
    }
    return { token: parsed.token, pid: parsed.pid as number };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function captureCleanup(
  label: string,
  failures: unknown[],
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push(new Error(`${label} cleanup failed`, { cause: error }));
  }
}

function throwCollectedFailures(
  bodyFailure: unknown,
  cleanupFailures: readonly unknown[],
): void {
  const failures = bodyFailure === undefined
    ? [...cleanupFailures]
    : [bodyFailure, ...cleanupFailures];
  for (const [index, failure] of failures.entries()) {
    console.error(`Task 6 failure ${index + 1}:`, failure);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Task 6 integration and cleanup failed");
  }
}

async function withTimeout<T>(
  promise: PromiseLike<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
