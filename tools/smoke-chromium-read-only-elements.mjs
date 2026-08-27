import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { bundleChromiumReadOnlyElementsRuntime } from "./chromium-devtools-runtime.mjs";
import {
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  openCdp,
  shutdownOwnedChildTree,
} from "./smoke-packaged-chrome.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 15_000;

export const FORBIDDEN_WRITER_SURFACE = Object.freeze([
  "addNewAttribute", "attributeEditingCommitted", "canPaste", "clearDragOverTreeElementMarker",
  "copyCSSPath", "copyFullXPath", "copyJSPath", "copyStyles", "copyTo", "copyXPath",
  "doMove", "duplicateNode", "editAsHTML", "editingCancelled", "enableContextMenu",
  "hasEditableNode", "insertInLastAttributePosition", "moveTo", "onBeforeCopy", "onCopyOrCut",
  "onPaste", "ondblclick", "ondelete", "ondragend", "ondragleave", "ondragover",
  "ondragstart", "ondrop", "pasteNode", "performCopyOrCut", "performPaste",
  "populateForcedPseudoStateItems", "removeAttribute", "removeNode", "resetClipboardIfNeeded",
  "revealHTMLInSources", "saveNodeToTempVariable", "selectNodeAfterEdit", "setAsInspectedNode",
  "setAttribute", "setAttributeValue", "setAttributeValuePromise", "setClipboardData",
  "setNodeName", "setNodeValue", "setOuterHTML", "showContextMenu", "startEditing",
  "startEditingAsHTML", "startEditingAttribute", "startEditingProcessingInstructionValue",
  "startEditingTagName", "startEditingTarget", "startEditingTextNode",
  "tagNameEditingCommitted", "textNodeEditingCommitted", "toggleEditAsHTML",
  "triggerEditAttribute", "updateEditorHandles", "validDragSourceOrTarget",
]);

export function installForbiddenWriterTraps(targets, names, onCall) {
  const installed = [];
  const present = [];
  for (const target of targets) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor) present.push(name);
      Object.defineProperty(target, name, {
        configurable: true,
        value: (...args) => {
          onCall(name, args);
          throw new Error(`Forbidden Chromium writer invoked: ${name}`);
        },
      });
      installed.push({target, name, descriptor});
    }
  }
  return Object.freeze({
    present: Object.freeze([...new Set(present)].sort()),
    restore() {
      for (const {target, name, descriptor} of installed.reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
  });
}

export function assertForbiddenHandlerRegression(result) {
  const expectedCalls = ["ondblclick", "ondelete"];
  if (result.preProbeErrors !== 0 || result.preProbeWriterCalls !== 0 ||
      JSON.stringify(result.calls) !== JSON.stringify(expectedCalls) ||
      result.caughtErrors !== 2 || result.descriptorsRestored !== true) {
    throw new Error(
      `Forbidden handler regression probe did not traverse real Chromium events: ${JSON.stringify(result)}`,
    );
  }
}

export async function smokeChromiumReadOnlyElementsRuntime() {
  return await smokeReadOnlyElementsRuntime("chrome");
}

export async function smokeFirefoxReadOnlyElementsRuntime() {
  return await smokeReadOnlyElementsRuntime("firefox");
}

async function smokeReadOnlyElementsRuntime(browser) {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "pin-op-read-only-elements-"));
  const profileRoot = path.join(smokeRoot, "profile");
  const runtimePath = path.join(smokeRoot, "runtime.js");
  const appPath = path.join(smokeRoot, "app.js");
  const htmlPath = path.join(smokeRoot, "index.html");
  let chrome;
  let cdp;
  let server;
  let chromeStderr = "";
  let reportBrowserResult;
  const browserResult = new Promise(resolve => {
    reportBrowserResult = resolve;
  });
  try {
    await bundleChromiumReadOnlyElementsRuntime({
      repositoryRoot,
      write: true,
      outfile: runtimePath,
    });
    const adapterPath = path.join(
      repositoryRoot,
      "packages/devtools-elements-ui/src/chromium/upstream/PinOpElementsTreeAdapter.ts",
    );
    await build({
      absWorkingDir: smokeRoot,
      stdin: {
        sourcefile: "read-only-elements-smoke.ts",
        resolveDir: smokeRoot,
        loader: "ts",
        contents: smokeApplication(),
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome116",
      outfile: appPath,
      logLevel: "silent",
      external: ["./runtime.js"],
      plugins: [{
        name: "pin-op-smoke-adapter",
        setup(context) {
          context.onResolve({filter: /^#pin-op-adapter$/}, () => ({path: adapterPath}));
        },
      }],
    });
    await writeFile(
      htmlPath,
      '<!doctype html><html><body><main id="mount"></main><script type="module" src="./app.js"></script></body></html>',
      "utf8",
    );
    server = createServer(async (request, response) => {
      if (request.url === "/result" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        reportBrowserResult(JSON.parse(body));
        response.statusCode = 204;
        response.end();
        return;
      }
      const file = request.url === "/runtime.js" ? runtimePath : request.url === "/app.js" ? appPath : htmlPath;
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(file));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke server has no TCP address");

    if (browser === "firefox") {
      const executable = await findFirefoxExecutable();
      const spawnOptions = buildChromeSpawnOptions();
      chrome = spawn(
        executable,
        ["--headless", "--no-remote", "--profile", profileRoot, `http://127.0.0.1:${address.port}/?firefox=1`],
        {...spawnOptions, env: {...process.env, MOZ_HEADLESS: "1"}},
      );
      chrome.stderr.setEncoding("utf8");
      chrome.stderr.on("data", chunk => {
        if (chromeStderr.length < 16_384) chromeStderr += chunk;
      });
      const result = await waitForReportedBrowserResult(browserResult, chrome);
      if (!result?.ok) {
        throw new Error(`Firefox read-only Elements smoke failed: ${result?.error ?? "no result"}`);
      }
      return result.value;
    }

    const executable = await findChromeExecutable();
    chrome = spawn(
      executable,
      ["--headless=new", ...buildChromeArguments(profileRoot)],
      buildChromeSpawnOptions(),
    );
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => {
      if (chromeStderr.length < 16_384) chromeStderr += chunk;
    });
    const [portText, browserPath] = (await waitForPortFile(
      path.join(profileRoot, "DevToolsActivePort"),
      chrome,
    )).split(/\r?\n/);
    const port = Number(portText);
    if (!Number.isInteger(port) || !browserPath?.startsWith("/devtools/browser/")) {
      throw new Error("Chrome wrote an invalid DevToolsActivePort file");
    }
    cdp = await openCdp(`ws://127.0.0.1:${port}${browserPath}`);
    const { targetId } = await cdp.send("Target.createTarget", {url: "about:blank"});
    const { sessionId } = await cdp.send("Target.attachToTarget", {targetId, flatten: true});
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", {url: `http://127.0.0.1:${address.port}/`}, sessionId);
    const result = await pollResult(cdp, sessionId);
    if (!result?.ok) {
      throw new Error(`Chromium read-only Elements smoke failed: ${result?.error ?? "no result"}`);
    }
    return result.value;
  } catch (error) {
    const details = chromeStderr.trim();
    if (!details) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nChrome stderr:\n${details}`, {
      cause: error,
    });
  } finally {
    await shutdownOwnedChildTree({child: chrome, cdp});
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(smokeRoot, {recursive: true, force: true, maxRetries: 4, retryDelay: 50});
  }
}

async function findFirefoxExecutable() {
  const candidates = process.platform === "win32" ? [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  ] : process.platform === "darwin" ? [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
  ] : ["/usr/bin/firefox", "/usr/local/bin/firefox"];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Firefox was not found for the read-only Elements smoke");
}

async function waitForReportedBrowserResult(resultPromise, child) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Firefox runtime result")), timeoutMs);
    resultPromise.then(result => {
      clearTimeout(timeout);
      resolve(result);
    }, reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Firefox exited before reporting runtime result (${code ?? signal})`));
    });
  });
}

async function findChromeExecutable() {
  for (const candidate of chromeExecutableCandidates(process.platform, process.env)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome Stable was not found; set CHROME_EXECUTABLE_PATH");
}

async function waitForPortFile(file, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited before CDP was ready (${child.exitCode ?? child.signalCode})`);
    }
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EPERM"].includes(error.code)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Chrome DevToolsActivePort");
}

async function pollResult(cdp, sessionId) {
  const deadline = Date.now() + timeoutMs;
  let hoverDispatched = false;
  while (Date.now() < deadline) {
    const evaluation = await cdp.send("Runtime.evaluate", {
      expression: "({result: window.pinOpSmokeResult, hover: window.pinOpSmokeHoverPoint})",
      returnByValue: true,
    }, sessionId);
    const state = evaluation.result?.value;
    if (state?.result) return state.result;
    if (!hoverDispatched && Number.isFinite(state?.hover?.x) && Number.isFinite(state?.hover?.y)) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: state.hover.x,
        y: state.hover.y,
      }, sessionId);
      await cdp.send("Runtime.evaluate", {
        expression: "window.pinOpSmokeHoverDispatched = true",
      }, sessionId);
      hoverDispatched = true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Chromium read-only Elements smoke result");
}

function smokeApplication() {
  return `
import * as Chromium from './runtime.js';
import {createPinOpElementsTreeAdapter} from '#pin-op-adapter';

const FORBIDDEN_WRITER_SURFACE = ${JSON.stringify(FORBIDDEN_WRITER_SURFACE)};
const installForbiddenWriterTraps = ${installForbiddenWriterTraps.toString()};
const assertForbiddenHandlerRegression = ${assertForbiddenHandlerRegression.toString()};

let rows = [
  row('doctype', undefined, 0, 10, 'html', 0, false, false),
  row('html', undefined, 0, 1, 'HTML', 1, true, false),
  row('body', 'html', 1, 1, 'BODY', 1, true, true),
  row('main', 'body', 2, 1, 'MAIN', 2, true, false),
  row('section', 'main', 3, 1, 'SECTION', 0, false, false),
  loadMoreRow('main', 3, 'load-more:main:v1', true),
];
const pendingRows = [
  row('doctype', undefined, 0, 10, 'html', 0, false, false),
  row('html', undefined, 0, 1, 'HTML', 1, true, false),
  row('body', 'html', 1, 1, 'BODY', 1, true, true),
  row('main', 'body', 2, 1, 'MAIN', 2, true, false),
  row('section', 'main', 3, 1, 'SECTION', 0, false, false),
  loadMoreRow('main', 3, 'load-more:main:v2', true),
];
const completeRows = [
  row('doctype', undefined, 0, 10, 'html', 0, false, false),
  row('html', undefined, 0, 1, 'HTML', 1, true, false),
  row('body', 'html', 1, 1, 'BODY', 1, true, true),
  row('main', 'body', 2, 1, 'MAIN', 2, true, false),
  row('section', 'main', 3, 1, 'SECTION', 0, false, false),
  row('article', 'main', 3, 1, 'ARTICLE', 0, false, false),
];
const calls = {selected: [], focused: [], hovered: [], loadMore: []};
let sourceListener;
let settleLoadMore;
const loadMoreGate = new Promise(resolve => { settleLoadMore = resolve; });
let forbiddenPathErrors = 0;
let writerCalls = 0;
addEventListener('error', event => { forbiddenPathErrors += 1; event.preventDefault(); });
addEventListener('unhandledrejection', event => { forbiddenPathErrors += 1; event.preventDefault(); });
const firefoxAutomation = new URLSearchParams(location.search).has('firefox');
const report = result => {
  window.pinOpSmokeResult = result;
  if (firefoxAutomation) {
    void fetch('/result', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(result)});
  }
};
const source = {
  snapshot: () => ({rows}),
  subscribe: listener => {
    sourceListener = listener;
    return () => { if (sourceListener === listener) sourceListener = undefined; };
  },
  expand: async () => {},
  collapse: () => {},
  loadMore: async ref => {
    calls.loadMore.push(ref);
    await loadMoreGate;
    rows = completeRows;
  },
  select: async ref => { calls.selected.push(ref); },
  focus: ref => { calls.focused.push(ref); },
  hover: ref => { calls.hovered.push(ref); },
};
const productionRuntime = Chromium.chromiumElementsRuntime;
let capturedOutline;
class CapturingElementsTreeOutline extends productionRuntime.ElementsTreeOutline {
  constructor(...args) {
    super(...args);
    capturedOutline = this;
  }
}
const runtime = Object.freeze({...productionRuntime, ElementsTreeOutline: CapturingElementsTreeOutline});
Promise.resolve().then(async () => {
  const mount = document.querySelector('#mount');
  const host = createPinOpElementsTreeAdapter(runtime, mount, source, {documentURL: 'https://pin-op.invalid/'});
  const shadow = host.element.shadowRoot;
  await waitFor(() => shadow?.querySelectorAll('[role="treeitem"]').length >= 6, 'tree rows');
  await waitFor(() => shadow?.querySelector('[data-pin-op-load-more-ref="load-more:main:v1"]'), 'load-more row');
  const firstLoadMoreButton = shadow.querySelector('[data-pin-op-load-more-ref="load-more:main:v1"]');
  const initialLoadMoreFocused = shadow.activeElement === firstLoadMoreButton;
  const initialLoadMoreHeight = getComputedStyle(firstLoadMoreButton).height;
  const tags = [...shadow.querySelectorAll('.webkit-html-tag-name')].map(node => node.textContent?.trim()).filter(Boolean);
  const selectedElement = shadow.querySelector('.selected');
  const selected = selectedElement?.textContent?.trim() ?? '';
  const selectedTreeItem = selectedElement?.closest('[role="treeitem"]') ?? selectedElement;
  const hoverTarget = selectedTreeItem?.querySelector('.webkit-html-tag-name') ?? selectedTreeItem;
  const hoverRect = hoverTarget?.getBoundingClientRect();
  window.pinOpSmokeHoverPoint = hoverRect ? {
    x: hoverRect.left + hoverRect.width / 2,
    y: hoverRect.top + hoverRect.height / 2,
  } : null;
  if (firefoxAutomation) {
    hoverTarget?.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      composed: true,
      clientX: window.pinOpSmokeHoverPoint?.x ?? 0,
      clientY: window.pinOpSmokeHoverPoint?.y ?? 0,
    }));
    window.pinOpSmokeHoverDispatched = true;
  }
  await waitFor(() => window.pinOpSmokeHoverDispatched === true, 'browser hover dispatch');
  await waitFor(() => selectedTreeItem?.classList.contains('hovered'), 'Chromium hovered tree state').catch(error => {
    const hit = hoverRect ? document.elementFromPoint(
      hoverRect.left + hoverRect.width / 2,
      hoverRect.top + hoverRect.height / 2,
    ) : null;
    throw new Error(error.message + ': rect=' + JSON.stringify(hoverRect?.toJSON()) + ', hit=' + hit?.outerHTML);
  });
  selectedTreeItem?.focus();
  await waitFor(() => shadow.activeElement === selectedTreeItem, 'selected tree focus');
  const treeFocusShell = shadow.activeElement === selectedTreeItem;
  const treeRootBefore = shadow.querySelector('[role="tree"]');
  const selectedBefore = selectedTreeItem;
  const treeTextBefore = treeRootBefore?.textContent;
  const rowCountBefore = shadow.querySelectorAll('[role="treeitem"]').length;
  const selectedNode = capturedOutline.selectedDOMNode();
  const actualTreeElement = capturedOutline.findTreeElement(selectedNode);
  const actualTreeElementPrototype = Object.getPrototypeOf(actualTreeElement);
  const actualPrototypes = [
    productionRuntime.DOMDocument.prototype,
    productionRuntime.ElementsTreeOutline.prototype,
    Object.getPrototypeOf(selectedNode),
    actualTreeElementPrototype,
    Object.getPrototypeOf(actualTreeElement.widget),
  ];
  const presentSurface = FORBIDDEN_WRITER_SURFACE.filter(name =>
    actualPrototypes.some(prototype => Object.hasOwn(prototype, name)));
  const regressionCalls = [];
  const regressionErrorsBefore = forbiddenPathErrors;
  const regressionWriterCallsBefore = writerCalls;
  const regressionTraps = installForbiddenWriterTraps(
    [actualTreeElementPrototype],
    ['ondblclick', 'ondelete'],
    name => { regressionCalls.push(name); writerCalls += 1; },
  );
  selectedTreeItem?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, composed: true}));
  selectedTreeItem?.dispatchEvent(legacyDeleteEvent());
  await new Promise(resolve => setTimeout(resolve, 0));
  regressionTraps.restore();
  const regressionDescriptorsRestored = ['ondblclick', 'ondelete'].every(name =>
    !Object.hasOwn(actualTreeElementPrototype, name));
  const regression = {
    preProbeErrors: regressionErrorsBefore,
    preProbeWriterCalls: regressionWriterCallsBefore,
    calls: [...regressionCalls].sort(),
    caughtErrors: forbiddenPathErrors - regressionErrorsBefore,
    descriptorsRestored: regressionDescriptorsRestored,
  };
  assertForbiddenHandlerRegression(regression);
  writerCalls = 0;
  forbiddenPathErrors = 0;
  const traps = installForbiddenWriterTraps(
    actualPrototypes,
    FORBIDDEN_WRITER_SURFACE.filter(name => name !== 'ondblclick' && name !== 'ondelete'),
    () => { writerCalls += 1; },
  );
  for (const event of [
    new KeyboardEvent('keydown', {key: 'ArrowUp', ctrlKey: true, bubbles: true, composed: true}),
    new KeyboardEvent('keydown', {key: 'ArrowDown', ctrlKey: true, bubbles: true, composed: true}),
    legacyDeleteEvent(),
    new MouseEvent('contextmenu', {bubbles: true, composed: true}),
    new MouseEvent('dblclick', {bubbles: true, composed: true}),
  ]) {
    selectedTreeItem?.dispatchEvent(event);
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  const treeIdentityUnchanged = treeRootBefore === shadow.querySelector('[role="tree"]');
  const selectedIdentityUnchanged = selectedBefore === shadow.querySelector('.selected');
  const selectedTextUnchanged = selected === selectedBefore?.textContent?.trim();
  const treeTextUnchanged = treeTextBefore === treeRootBefore?.textContent;
  const rowCountUnchanged = rowCountBefore === shadow.querySelectorAll('[role="treeitem"]').length;
  traps.restore();
  const mainNode = selectedNode.children()[0];
  const manualAuthority = Object.freeze({
    parent: mainNode,
    serviceRowRef: 'load-more:manual',
    focused: true,
    hasMore: true,
    loadedChildCount: 1,
    totalChildCount: 2,
    remainingChildCount: 1,
  });
  let manualCalls = 0;
  const manualBridge = productionRuntime.installLoadMoreBridge(
    capturedOutline,
    async () => { manualCalls += 1; },
  );
  let invalidAuthoritiesRejected = 0;
  for (const invalid of [
    [{...manualAuthority, focused: 'yes'}],
    [{...manualAuthority, loadedChildCount: 2, totalChildCount: 1}],
    [{...manualAuthority, remainingChildCount: 0}],
    [{...manualAuthority, totalChildCount: 3, remainingChildCount: 2}],
    [manualAuthority, manualAuthority],
  ]) {
    try {
      manualBridge.update(invalid);
    } catch {
      invalidAuthoritiesRejected += 1;
    }
  }
  manualBridge.update([manualAuthority]);
  manualBridge.update([manualAuthority]);
  const manualButtons = shadow.querySelectorAll('[data-pin-op-load-more-ref="load-more:manual"]');
  const manualButton = manualButtons[0];
  const manualFocused = shadow.activeElement === manualButton;
  manualBridge.update([{...manualAuthority, focused: false}]);
  const manualFocusReleased = shadow.activeElement !== manualButton;
  manualBridge.dispose();
  manualBridge.dispose();
  manualButton.click();
  manualBridge.update([manualAuthority]);
  await Promise.resolve();
  const manualContract = {
    invalidAuthoritiesRejected,
    idempotentRows: manualButtons.length,
    focused: manualFocused,
    focusReleased: manualFocusReleased,
    detached: !manualButton.isConnected && manualButton.disabled,
    staleCalls: manualCalls,
    disposedRows: shadow.querySelectorAll('[data-pin-op-load-more-ref="load-more:manual"]').length,
  };
  firstLoadMoreButton.click();
  firstLoadMoreButton.click();
  firstLoadMoreButton.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
  firstLoadMoreButton.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true, composed: true}));
  await Promise.resolve();
  const firstLoadMoreFenced = firstLoadMoreButton.disabled &&
    firstLoadMoreButton.getAttribute('aria-busy') === 'true' && calls.loadMore.length === 1;
  rows = pendingRows;
  sourceListener?.();
  await waitFor(() => shadow.querySelector('[data-pin-op-load-more-ref="load-more:main:v2"]'), 'replacement load-more row');
  const replacementLoadMoreButton = shadow.querySelector('[data-pin-op-load-more-ref="load-more:main:v2"]');
  const staleLoadMoreDetached = !firstLoadMoreButton.isConnected && firstLoadMoreButton.disabled;
  firstLoadMoreButton.click();
  replacementLoadMoreButton.click();
  replacementLoadMoreButton.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
  await Promise.resolve();
  const replacementLoadMoreFenced = replacementLoadMoreButton.disabled && calls.loadMore.length === 1;
  settleLoadMore();
  await waitFor(() => !shadow.querySelector('[data-pin-op-service-row="load-more"]'), 'load-more completion');
  await waitFor(() => [...shadow.querySelectorAll('.webkit-html-tag-name')]
    .some(node => node.textContent?.trim() === 'article'), 'loaded child');
  const staleReplacementDetached = !replacementLoadMoreButton.isConnected && replacementLoadMoreButton.disabled;
  replacementLoadMoreButton.click();
  await Promise.resolve();
  const css = [...shadow.querySelectorAll('style')].map(style => style.textContent).join('\\n');
  const tokenStyle = document.querySelector('#pin-op-chromium-design-system-tokens')?.textContent ?? '';
  const tokenValue = getComputedStyle(document.documentElement).getPropertyValue('--sys-color-on-surface').trim();
  const value = {
    exports: Object.keys(Chromium),
    runtimeFrozen: Object.isFrozen(productionRuntime),
    constructors: [productionRuntime.DOMDocument.name, productionRuntime.ElementsTreeOutline.name],
    tags,
    selected,
    treeItems: shadow.querySelectorAll('[role="treeitem"]').length,
    hasUpstreamCss: css.includes('.elements-tree-outline'),
    hasInspectorCommonCss: css.includes('interpolate-size: allow-keywords'),
    hasTextButtonCss: css.includes('.text-button:not(:disabled, .primary-button):focus-visible'),
    hasDesignTokens: tokenStyle.includes('--sys-color-on-surface:') && tokenValue.length > 0,
    focusShell: treeFocusShell,
    hoverClass: selectedTreeItem?.classList.contains('hovered') ?? false,
    forbiddenPaths: {
      errors: forbiddenPathErrors,
      writerCalls,
      writerSurfaceAbsent: presentSurface.length === 0 && traps.present.length === 0,
      checkedSurface: FORBIDDEN_WRITER_SURFACE,
      regression,
      treeIdentityUnchanged,
      treeRootPresent: treeRootBefore !== null,
      selectedIdentityUnchanged,
      selectedTextUnchanged,
      treeTextUnchanged,
      rowCountUnchanged,
    },
    loadMore: {
      manualContract,
      initialFocused: initialLoadMoreFocused,
      firstFenced: firstLoadMoreFenced,
      replacementFenced: replacementLoadMoreFenced,
      staleDetached: staleLoadMoreDetached,
      replacementDetached: staleReplacementDetached,
      calls: calls.loadMore,
      focusCalls: calls.focused.filter(ref => ref.startsWith('load-more:')),
      className: firstLoadMoreButton.className,
      height: initialLoadMoreHeight,
      remainingRows: shadow.querySelectorAll('[data-pin-op-service-row="load-more"]').length,
    },
  };
  host.dispose();
  if (
    !tags.includes('section') || !selected.includes('body') || !value.hasUpstreamCss ||
    !value.hasInspectorCommonCss || !value.hasTextButtonCss || !value.hasDesignTokens ||
    JSON.stringify(value.exports) !== JSON.stringify(['chromiumElementsRuntime']) ||
    !value.runtimeFrozen || !value.focusShell || !value.hoverClass ||
    value.forbiddenPaths.errors !== 0 || value.forbiddenPaths.writerCalls !== 0 ||
    !value.forbiddenPaths.writerSurfaceAbsent || !value.forbiddenPaths.treeRootPresent ||
    !value.forbiddenPaths.treeIdentityUnchanged ||
    !value.forbiddenPaths.selectedIdentityUnchanged || !value.forbiddenPaths.selectedTextUnchanged ||
    !value.forbiddenPaths.treeTextUnchanged ||
    !value.forbiddenPaths.rowCountUnchanged ||
    value.loadMore.manualContract.invalidAuthoritiesRejected !== 5 ||
    value.loadMore.manualContract.idempotentRows !== 1 || !value.loadMore.manualContract.focused ||
    !value.loadMore.manualContract.focusReleased ||
    !value.loadMore.manualContract.detached || value.loadMore.manualContract.staleCalls !== 0 ||
    value.loadMore.manualContract.disposedRows !== 0 || !value.loadMore.initialFocused ||
    !value.loadMore.firstFenced || !value.loadMore.replacementFenced ||
    !value.loadMore.staleDetached || !value.loadMore.replacementDetached ||
    JSON.stringify(value.loadMore.calls) !== JSON.stringify(['main']) ||
    JSON.stringify(value.loadMore.focusCalls) !== JSON.stringify(['load-more:main:v1']) ||
    !value.loadMore.className.includes('pin-op-elements-load-more') ||
    value.loadMore.height !== '24px' || value.loadMore.remainingRows !== 0 ||
    mount.childElementCount !== 0
  ) {
    throw new Error(
      'Real read-only Chromium tree lost selection, hover, focus, core styles, tokens, button styles, or disposal: ' +
      JSON.stringify({...value, mountChildren: mount.childElementCount}),
    );
  }
  report({ok: true, value});
}).catch(error => {
  report({ok: false, error: error instanceof Error ? error.stack : String(error)});
});

function row(nodeRef, parentRef, depth, nodeType, nodeName, childCount, expanded, selected) {
  return {
    type: 'node', nodeRef, parentRef, depth, expanded, expandable: childCount > 0,
    selected, focused: selected, hovered: false,
    node: {
      nodeRef,
      kind: nodeType === 10 ? 'document-type' : 'element',
      nodeType,
      nodeName,
      attributes: nodeName === 'BODY' ? [{name: 'class', value: 'fixture'}] : [],
      childCount,
      relationship: 'dom',
      selectable: nodeType === 1,
      expandable: childCount > 0,
      branchRevision: expanded ? 1 : 0,
    },
  };
}
function loadMoreRow(parentRef, depth, nodeRef, focused) {
  return {
    type: 'load-more', nodeRef, parentRef, depth, expanded: false,
    expandable: false, selected: false, focused, hovered: false,
  };
}
function legacyDeleteEvent() {
  const event = new KeyboardEvent('keydown', {key: 'Delete', bubbles: true, composed: true});
  Object.defineProperty(event, 'keyCode', {value: 46});
  return event;
}
async function waitFor(predicate, label) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chromiumResult = await smokeChromiumReadOnlyElementsRuntime();
  console.log(`CHROMIUM_READ_ONLY_ELEMENTS_OK ${JSON.stringify(chromiumResult)}`);
  const firefoxResult = await smokeFirefoxReadOnlyElementsRuntime();
  console.log(`FIREFOX_READ_ONLY_ELEMENTS_OK ${JSON.stringify(firefoxResult)}`);
}
