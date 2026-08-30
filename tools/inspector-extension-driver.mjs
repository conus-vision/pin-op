// Drives the real, unpacked browser extension end to end: background service
// worker, content script and Inspector panel, all wired through the product's
// own message routes.
//
// The panel normally lives in a DevTools window, which headless Chrome cannot
// open. The background never inspects the DevTools context though -- it only
// checks that the registration arrives from the devtools page URL and that the
// panel port arrives from the panel URL. So the devtools page is opened as an
// ordinary extension tab with `chrome.devtools` stubbed before its script runs,
// and the panel URL it hands back is opened in a second tab. Everything below
// that handshake is the shipped product.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  openCdp,
  shutdownOwnedChildTree,
} from "./smoke-packaged-chrome.mjs";

/**
 * A backgrounded renderer throttles timers, which makes every measurement here
 * meaningless: one pick looked like it took five seconds instead of a third of
 * one. Both tabs stay live and focused for the run.
 */
const LIVE_RENDERER_ARGUMENTS = Object.freeze([
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
]);

const DEVTOOLS_PAGE = "dist/devtools.html";
const PANEL_READY_TIMEOUT_MS = 30_000;

export const DEEP_QUERY_SOURCE =
  "const deep = (root, selector) => { const found = [...root.querySelectorAll(selector)]; " +
  "const visit = (node) => { if (node.shadowRoot) { found.push(...node.shadowRoot.querySelectorAll(selector)); " +
  "for (const child of node.shadowRoot.querySelectorAll(\"*\")) visit(child); } " +
  "for (const child of node.children || []) visit(child); }; visit(root); return found; };";

export const TREE_ROWS_SOURCE = `${DEEP_QUERY_SOURCE}
  const outline = deep(document, ".elements-tree-outline")[0];
  const rows = outline ? [...outline.querySelectorAll('li[role="treeitem"]')] : [];
  const rowLabel = (row) => (row.textContent || "").replace(/[\\s\\u200b]+/g, " ").trim();`;

/**
 * Boots Chrome with the extension loaded and returns the live session. The
 * caller owns `close()`.
 */
export async function launchInspectorExtension({
  extensionDirectory,
  pageUrl,
  viewport = { width: 1000, height: 850 },
  chromeExecutable = chromeExecutableCandidates(process.platform, process.env).find(Boolean),
}) {
  if (!isAbsolute(extensionDirectory)) {
    throw new Error("Inspector extension directory must be absolute");
  }
  if (typeof pageUrl !== "string" || pageUrl.length === 0) {
    throw new Error("Inspector smoke requires an inspected page URL");
  }
  if (!chromeExecutable) {
    throw new Error("Google Chrome Stable was not found for the Inspector smoke");
  }
  await assertExtensionBuild(extensionDirectory);

  const smokeRoot = await mkdtemp(join(tmpdir(), "pin-op-inspector-"));
  const profileRoot = join(smokeRoot, "profile");
  let child;
  let cdp;
  try {
    child = spawn(
      chromeExecutable,
      ["--headless=new", ...LIVE_RENDERER_ARGUMENTS, ...buildChromeArguments(profileRoot)],
      buildChromeSpawnOptions(),
    );
    cdp = await openCdp(await readDevToolsEndpoint(profileRoot), { timeoutMs: 30_000 });

    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", {
      path: extensionDirectory,
    });

    const site = await openTab(cdp, pageUrl, viewport);
    const worker = await attachExtensionWorker(cdp, extensionId);
    const inspectedTabId = await resolveInspectedTabId(cdp, worker, pageUrl);
    const panelUrl = await registerDevtoolsPanel(cdp, extensionId, inspectedTabId);
    const panel = await openTab(cdp, panelUrl, viewport, PANEL_CONSOLE_RECORDER);
    await waitFor(
      cdp,
      panel,
      'Boolean(document.getElementById("inspect-mode"))',
      PANEL_READY_TIMEOUT_MS,
    );

    const session = {
      cdp,
      extensionId,
      panelUrl,
      inspectedTabId,
      site,
      panel,
      worker,
      browser: "chrome",
      viewport,
      evaluate: (target, expression) => evaluate(cdp, target, expression),
      json: async (target, expression) => JSON.parse(await evaluate(cdp, target, expression)),
      click: (target, x, y) => click(cdp, target, x, y),
      type: (target, text) => typeText(cdp, target, text),
      waitFor: (target, expression, timeoutMs) => waitFor(cdp, target, expression, timeoutMs),
      screenshot: async (target, file) => {
        const image = await cdp.send("Page.captureScreenshot", { format: "png" }, target.sessionId);
        await writeFile(file, Buffer.from(image.data, "base64"));
      },
      /** Resizes the panel, so a run can be measured in a short pane. */
      async setPanelViewport({ width, height }) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width, height, deviceScaleFactor: 1, mobile: false,
        }, panel.sessionId);
      },
      /** Chrome stops an idle MV3 service worker; this is that, on demand. */
      async suspendBackground() {
        await cdp.send("ServiceWorker.enable", {}, site.sessionId);
        await cdp.send("ServiceWorker.stopAllWorkers", {}, site.sessionId);
      },
      async close() {
        await shutdownOwnedChildTree({ child, cdp });
        await rm(smokeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      },
    };
    return session;
  } catch (error) {
    await shutdownOwnedChildTree({ child, cdp });
    await rm(smokeRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    throw error;
  }
}

async function assertExtensionBuild(extensionDirectory) {
  for (const relative of ["manifest.json", "dist/inspector-panel.html", "dist/devtools.html"]) {
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

async function readDevToolsEndpoint(profileRoot) {
  const portFile = join(profileRoot, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const contents = await readFile(portFile, "utf8");
      const [portText, browserPath] = contents.split(/\r?\n/);
      if (/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath ?? "")) {
        return `ws://127.0.0.1:${Number(portText)}${browserPath}`;
      }
    } catch {
      // Chrome has not written the endpoint yet.
    }
    await delay(100);
  }
  throw new Error("Chrome never published a DevTools endpoint");
}

/**
 * Keeps the panel's own diagnostics: when a run fails, what the panel logged
 * while it was failing is usually the whole story.
 */
export const PANEL_CONSOLE_RECORDER = `(() => {
  const log = [];
  globalThis.__pinOpPanelLog = log;
  for (const level of ["warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      if (log.length < 200) {
        log.push(level + ": " + args
          .map((value) => String(value && value.message ? value.message : value))
          .join(" ")
          .slice(0, 200));
      }
      original(...args);
    };
  }
})()`;

async function openTab(cdp, url, viewport, bootstrapSource) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const target = { targetId, sessionId };
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  if (bootstrapSource) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource }, sessionId);
  }
  if (url !== "about:blank") {
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitFor(cdp, target, 'document.readyState === "complete"', 30_000);
  }
  return target;
}

async function attachExtensionWorker(cdp, extensionId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const info = targetInfos.find((candidate) => (
      candidate.type === "service_worker" && candidate.url.includes(extensionId)
    ));
    if (info) {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
      await cdp.send("Runtime.enable", {}, sessionId);
      return { targetId: info.targetId, sessionId };
    }
    await delay(200);
  }
  throw new Error("The extension service worker never started");
}

/** The tab id the extension sees is only knowable from inside the extension. */
async function resolveInspectedTabId(cdp, worker, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const listed = await evaluate(cdp, worker, `(async () => {
    const tabs = await chrome.tabs.query({});
    return JSON.stringify(tabs.map((tab) => ({ id: tab.id, url: tab.url })));
  })()`);
  const tabs = JSON.parse(listed);
  const inspected = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(origin));
  if (!inspected) {
    throw new Error(`The inspected tab is not open: ${tabs.map((tab) => tab.url).join(", ")}`);
  }
  return inspected.id;
}

async function registerDevtoolsPanel(cdp, extensionId, inspectedTabId) {
  const devtools = await openTab(cdp, "about:blank", { width: 640, height: 480 });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: devtoolsStubSource(inspectedTabId),
  }, devtools.sessionId);
  await cdp.send("Page.navigate", {
    url: `chrome-extension://${extensionId}/${DEVTOOLS_PAGE}`,
  }, devtools.sessionId);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const page = await evaluate(cdp, devtools, "window.__pinOpPanelPage ?? null");
    if (typeof page === "string" && page.length > 0) {
      return `chrome-extension://${extensionId}${page.startsWith("/") ? "" : "/"}${page}`;
    }
    await delay(200);
  }
  throw new Error("The devtools page never created the Pin-op panel");
}

function devtoolsStubSource(inspectedTabId) {
  return `(() => {
    const panel = { onShown: { addListener() {}, removeListener() {} } };
    const create = (title, icon, page, callback) => {
      window.__pinOpPanelPage = page;
      if (typeof callback === "function") { callback(panel); return undefined; }
      return Promise.resolve(panel);
    };
    const devtools = { inspectedWindow: { tabId: ${inspectedTabId} }, panels: { create } };
    if (!globalThis.chrome) globalThis.chrome = {};
    globalThis.chrome.devtools = devtools;
    Object.defineProperty(globalThis, "browser", {
      configurable: true,
      get() { return globalThis.__pinOpBrowserNamespace; },
      set(value) { value.devtools = devtools; globalThis.__pinOpBrowserNamespace = value; },
    });
  })()`;
}

async function evaluate(cdp, target, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, target.sessionId);
  if (exceptionDetails) {
    throw new Error(
      `Inspector smoke evaluation failed: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }`,
    );
  }
  return result?.value;
}

async function waitFor(cdp, target, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, target, `Boolean(${expression})`) === true) return;
    await delay(100);
  }
  throw new Error(`Inspector smoke timed out waiting for ${expression}`);
}

async function click(cdp, target, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    }, target.sessionId);
    await delay(60);
  }
}

async function typeText(cdp, target, text) {
  for (const character of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: character,
      unmodifiedText: character,
    }, target.sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp" }, target.sessionId);
    await delay(20);
  }
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
