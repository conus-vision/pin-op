// Drives the real, unpacked Firefox extension end to end: background page,
// content script and Inspector panel, all wired through the product's own
// message routes. The Chrome driver's counterpart, with the same session shape,
// so one smoke can hold both browsers to the same contract.
//
// Firefox has no CDP, so this speaks two protocols at once. Marionette opens the
// WebDriver session (and is the only way to reach chrome scope, which is the
// only way to open a `moz-extension://` tab -- WebDriver BiDi refuses to
// navigate content to a privileged URL). That session is bridged into BiDi with
// the `webSocketUrl` capability, and everything after it -- installing the
// extension, evaluating, clicking, typing -- goes over BiDi.
//
// The panel normally lives in a DevTools toolbox, which cannot be driven from
// outside the parent process. So the extension's own devtools page is opened as
// an ordinary tab: its first run throws on the absent `browser.devtools` before
// it does anything, the harness installs a stub, and then re-runs the shipped
// `devtools.js` in that same page. The background is satisfied because it only
// checks that the registration arrives from the devtools page URL. Everything
// below that handshake is the shipped product.
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const ADDON_ID = "info@conus.vision";
/** Fixed so the `moz-extension://` origin is knowable before the tab exists. */
const EXTENSION_UUID = "8d2f0a52-4c1e-4a9b-9f3d-7c6b1e0a5d41";
const DEVTOOLS_PAGE = "dist/devtools.html";
const PANEL_READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;

const FIREFOX_CANDIDATES = Object.freeze([
  "C:/Program Files/Mozilla Firefox/firefox.exe",
  "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
  "/usr/bin/firefox",
  "/usr/local/bin/firefox",
]);

export function firefoxExecutableCandidates(env = process.env) {
  return [env.PIN_OP_FIREFOX, ...FIREFOX_CANDIDATES].filter(Boolean);
}

/**
 * Boots Firefox with the extension loaded and returns the live session. The
 * caller owns `close()`.
 */
export async function launchInspectorExtensionFirefox({
  extensionDirectory,
  pageUrl,
  viewport = { width: 1000, height: 850 },
  firefoxExecutable,
}) {
  if (!isAbsolute(extensionDirectory)) {
    throw new Error("Inspector extension directory must be absolute");
  }
  if (typeof pageUrl !== "string" || pageUrl.length === 0) {
    throw new Error("Inspector smoke requires an inspected page URL");
  }
  const executable = firefoxExecutable ?? await firstExisting(firefoxExecutableCandidates());
  if (!executable) {
    throw new Error("Mozilla Firefox was not found for the Inspector smoke");
  }
  await assertExtensionBuild(extensionDirectory);

  const smokeRoot = await mkdtemp(join(tmpdir(), "pin-op-firefox-"));
  const profile = join(smokeRoot, "profile");
  const marionettePort = await freePort();
  let child;
  let marionette;
  let bidi;
  const shutdown = async () => {
    try { bidi?.close(); } catch { /* the socket may already be gone */ }
    try { marionette?.close(); } catch { /* likewise */ }
    if (child && child.exitCode === null) {
      child.kill();
      await delay(500);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(smokeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  };

  try {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "user.js"), profilePreferences(marionettePort), "utf8");
    child = spawn(executable, [
      "--headless",
      "--no-remote",
      // Chrome scope is refused without it, and chrome scope is the only way to
      // open an extension page in a tab.
      "-remote-allow-system-access",
      "-profile", profile,
      "--marionette",
      "--remote-debugging-port", "0",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.resume();
    child.stderr.resume();

    marionette = await connectMarionette(marionettePort);
    const session = await marionette.send("WebDriver:NewSession", { webSocketUrl: true });
    const socketUrl = session?.capabilities?.webSocketUrl;
    if (typeof socketUrl !== "string") {
      throw new Error("Firefox did not publish a WebDriver BiDi session socket");
    }
    bidi = await connectBidi(socketUrl);
    await bidi.send("webExtension.install", {
      extensionData: { type: "path", path: extensionDirectory },
    });
    await marionette.send("Marionette:SetContext", { value: "chrome" });

    const site = await openTab(bidi, pageUrl, viewport);
    const { panelPage, inspectedTabId } = await registerDevtoolsPanel(
      bidi,
      marionette,
      pageUrl,
      viewport,
    );
    const panelUrl = extensionUrl(panelPage);
    const panel = await openExtensionTab(bidi, marionette, panelUrl, viewport);
    await waitFor(bidi, panel, 'Boolean(document.getElementById("inspect-mode"))', PANEL_READY_TIMEOUT_MS);

    return {
      browser: "firefox",
      viewport,
      extensionId: EXTENSION_UUID,
      panelUrl,
      inspectedTabId,
      site,
      panel,
      bidi,
      marionette,
      evaluate: (target, expression) => evaluate(bidi, target, expression),
      json: async (target, expression) => JSON.parse(await evaluate(bidi, target, expression)),
      click: (target, x, y) => click(bidi, target, x, y),
      type: (target, text) => typeText(bidi, target, text),
      waitFor: (target, expression, timeoutMs) => waitFor(bidi, target, expression, timeoutMs),
      async screenshot(target, file) {
        const shot = await bidi.send("browsingContext.captureScreenshot", {
          context: target.context,
        });
        await writeFile(file, Buffer.from(shot.data, "base64"));
      },
      /** Resizes the panel, so a run can be measured in a short pane. */
      async setPanelViewport({ width, height }) {
        await applyViewport(bidi, panel, { width, height });
      },
      /**
       * Firefox unloads an idle event page on its own; this is the same
       * teardown about:debugging's "Terminate Background Script" performs.
       */
      async suspendBackground() {
        const outcome = await marionette.send("WebDriver:ExecuteAsyncScript", {
          script: `
            const done = arguments[arguments.length - 1];
            const { ExtensionParent } = ChromeUtils.importESModule(
              "resource://gre/modules/ExtensionParent.sys.mjs",
            );
            const extension = ExtensionParent.GlobalManager.getExtension(arguments[0]);
            if (!extension) { done("missing extension"); return; }
            Promise.resolve(extension.terminateBackground())
              .then(() => done("terminated"), (error) => done("failed: " + error));
          `,
          args: [ADDON_ID],
        });
        if (outcome?.value !== "terminated" && outcome !== "terminated") {
          throw new Error(`Firefox did not suspend the background: ${JSON.stringify(outcome)}`);
        }
      },
      close: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function assertExtensionBuild(extensionDirectory) {
  for (const relative of ["manifest.json", "dist/inspector-panel.html", DEVTOOLS_PAGE]) {
    try {
      await readFile(join(extensionDirectory, relative));
    } catch (error) {
      throw new Error(
        `Inspector smoke needs a built extension: ${relative} is missing`,
        { cause: error },
      );
    }
  }
}

function profilePreferences(marionettePort) {
  return [
    // Pins the extension's origin so its pages are addressable before it loads.
    `user_pref("extensions.webextensions.uuids", "{\\"${ADDON_ID}\\":\\"${EXTENSION_UUID}\\"}");`,
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);',
    `user_pref("marionette.port", ${marionettePort});`,
  ].join("\n");
}

function extensionUrl(path) {
  return `moz-extension://${EXTENSION_UUID}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Runs the shipped devtools page as an ordinary tab. Its first pass throws on
 * the absent `browser.devtools`; the stub goes in, the shipped script runs
 * again, and the panel it creates is the product's own.
 */
async function registerDevtoolsPanel(bidi, marionette, pageUrl, viewport) {
  const devtools = await openExtensionTab(
    bidi,
    marionette,
    extensionUrl(DEVTOOLS_PAGE),
    { width: 640, height: 480 },
  );
  const origin = new URL(pageUrl).origin;
  const inspectedTabId = await bidi.send("script.callFunction", {
    functionDeclaration: `async (origin) => {
      const tabs = await browser.tabs.query({});
      const inspected = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(origin));
      if (!inspected) throw new Error("The inspected tab is not open");
      return inspected.id;
    }`,
    arguments: [{ type: "string", value: origin }],
    target: { context: devtools.context },
    awaitPromise: true,
  }).then(readResult);

  await evaluate(bidi, devtools, devtoolsStubSource(inspectedTabId));
  await evaluate(bidi, devtools, `new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./devtools.js";
    script.addEventListener("load", () => resolve("loaded"));
    script.addEventListener("error", () => reject(new Error("devtools.js failed to load")));
    document.body.append(script);
  })`);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const page = await evaluate(bidi, devtools, "window.__pinOpPanelPage ?? null");
    if (typeof page === "string" && page.length > 0) {
      return { panelPage: page, inspectedTabId };
    }
    await delay(200);
  }
  throw new Error("The devtools page never created the Pin-op panel");
}

/**
 * `browser` is native here, so the stub inherits from it and overrides only the
 * devtools namespace the toolbox would have provided.
 */
function devtoolsStubSource(inspectedTabId) {
  return `(() => {
    const panel = { onShown: { addListener() {}, removeListener() {} } };
    const create = (title, icon, page, callback) => {
      window.__pinOpPanelPage = page;
      if (typeof callback === "function") { callback(panel); return undefined; }
      return Promise.resolve(panel);
    };
    const devtools = { inspectedWindow: { tabId: ${inspectedTabId} }, panels: { create } };
    for (const name of ["browser", "chrome"]) {
      const native = globalThis[name];
      if (!native) continue;
      const stub = Object.create(native);
      Object.defineProperty(stub, "devtools", { value: devtools, enumerable: true });
      Object.defineProperty(globalThis, name, { configurable: true, value: stub });
    }
    return "stubbed";
  })()`;
}

async function openTab(bidi, url, viewport) {
  const { context } = await bidi.send("browsingContext.create", { type: "tab" });
  const target = { context };
  await applyViewport(bidi, target, viewport);
  if (url !== "about:blank") {
    await bidi.send("browsingContext.navigate", { context, url, wait: "complete" });
    await waitFor(bidi, target, 'document.readyState === "complete"', 30_000);
  }
  return target;
}

/**
 * BiDi refuses to navigate content to a privileged URL, so the tab is opened
 * from chrome scope with a system principal and then adopted by BiDi.
 */
async function openExtensionTab(bidi, marionette, url, viewport) {
  const before = await listContexts(bidi);
  await marionette.send("WebDriver:ExecuteScript", {
    script: `
      const tab = gBrowser.addTab(arguments[0], {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      gBrowser.selectedTab = tab;
      return true;
    `,
    args: [url],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const contexts = await listContexts(bidi);
    const opened = contexts.find((candidate) => (
      candidate.url === url && !before.some((seen) => seen.context === candidate.context)
    ));
    if (opened) {
      const target = { context: opened.context };
      // Firefox 155 refuses to size a privileged context, and every extension
      // page this harness drives is one. The viewport is a convenience for
      // measurement here, not part of what is under test, so the refusal is
      // carried; `setPanelViewport` still fails loudly, because a run that
      // measures in a short pane has to actually get one.
      await applyViewport(bidi, target, viewport, { optional: true });
      await waitFor(bidi, target, 'document.readyState !== "loading"', 30_000);
      return target;
    }
    await delay(150);
  }
  throw new Error(`Firefox never opened the extension tab ${url}`);
}

async function listContexts(bidi) {
  const { contexts } = await bidi.send("browsingContext.getTree", {});
  return contexts.map(({ context, url }) => ({ context, url }));
}

async function applyViewport(bidi, target, viewport, { optional = false } = {}) {
  try {
    await bidi.send("browsingContext.setViewport", {
      context: target.context,
      viewport: { width: viewport.width, height: viewport.height },
      devicePixelRatio: 1,
    });
  } catch (error) {
    if (!optional || !/privileged scope/i.test(String(error?.message ?? error))) {
      throw error;
    }
  }
}

async function evaluate(bidi, target, expression) {
  const outcome = await bidi.send("script.evaluate", {
    expression,
    target: { context: target.context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  return readResult(outcome);
}

function readResult(outcome) {
  if (outcome.type === "exception") {
    throw new Error(
      `Inspector smoke evaluation failed: ${outcome.exceptionDetails?.text ?? "unknown"}`,
    );
  }
  const value = outcome.result;
  if (!value || value.type === "undefined" || value.type === "null") return undefined;
  return value.value;
}

async function waitFor(bidi, target, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(bidi, target, `Boolean(${expression})`) === true) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Inspector smoke timed out waiting for ${expression}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function click(bidi, target, x, y) {
  await bidi.send("input.performActions", {
    context: target.context,
    actions: [{
      type: "pointer",
      id: "pin-op-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
        { type: "pause", duration: 40 },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 40 },
        { type: "pointerUp", button: 0 },
      ],
    }],
  });
  await delay(60);
}

async function typeText(bidi, target, text) {
  await bidi.send("input.performActions", {
    context: target.context,
    actions: [{
      type: "key",
      id: "pin-op-keyboard",
      actions: [...text].flatMap((character) => [
        { type: "keyDown", value: character },
        { type: "keyUp", value: character },
      ]),
    }],
  });
  await delay(60);
}

async function connectBidi(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("BiDi WebSocket failed to open")); };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === "error") {
      entry.reject(new Error(`BiDi ${entry.method}: ${message.error} ${message.message ?? ""}`.trim()));
    } else {
      entry.resolve(message.result ?? {});
    }
  });
  socket.addEventListener("close", () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`BiDi ${entry.method}: the session socket closed`));
    }
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`BiDi ${method}: timed out`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

/** Marionette frames every packet as `<byte length>:<json>`. */
async function connectMarionette(port) {
  const socket = await new Promise((resolve, reject) => {
    const attempt = (left) => {
      const candidate = net.connect(port, "127.0.0.1");
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", () => {
        candidate.destroy();
        if (left === 0) reject(new Error("Marionette never started listening"));
        else setTimeout(() => attempt(left - 1), 200);
      });
    };
    attempt(150);
  });
  let buffer = Buffer.alloc(0);
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString("utf8"));
      if (!Number.isFinite(length) || buffer.length < colon + 1 + length) return;
      const body = buffer.subarray(colon + 1, colon + 1 + length).toString("utf8");
      buffer = buffer.subarray(colon + 1 + length);
      const waiter = waiters.shift();
      if (!waiter) continue;
      try {
        waiter.resolve(JSON.parse(body));
      } catch (error) {
        waiter.reject(error);
      }
    }
  });
  const read = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Marionette timed out")), COMMAND_TIMEOUT_MS);
    waiters.push({
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
  await read(); // the server's hello packet
  let nextId = 0;
  let tail = Promise.resolve();
  return {
    send(command, params = {}) {
      const run = async () => {
        const payload = JSON.stringify([0, ++nextId, command, params]);
        socket.write(`${Buffer.byteLength(payload)}:${payload}`);
        const [, , error, result] = await read();
        if (error) {
          throw new Error(`Marionette ${command}: ${error.message ?? error.error ?? "failed"}`);
        }
        return result;
      };
      const settled = tail.then(run, run);
      tail = settled.then(() => undefined, () => undefined);
      return settled;
    },
    close() {
      socket.destroy();
    },
  };
}

async function firstExisting(candidates) {
  const { access } = await import("node:fs/promises");
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the next one */ }
  }
  return undefined;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
