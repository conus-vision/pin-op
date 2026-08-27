import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  CHROMIUM_ELEMENTS_RUNTIME_FILENAME,
  buildBrowserInspectorModules,
} from "./browser-elements-runtime.mjs";
import {
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  openCdp,
  shutdownOwnedChildTree,
} from "./smoke-packaged-chrome.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 30_000;

export const NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS = Object.freeze({
  navigationToReady: 2_000,
  loadMore: 750,
  rulesRefresh: 500,
  sourceSwitch: 300,
  total: 3_500,
});

export const NATIVE_INSPECTOR_OPERATION_BUDGET = Object.freeze({
  treeSnapshotCalls: 12,
  rulesSnapshotCalls: 6,
});

export const NATIVE_INSPECTOR_CROSS_BROWSER_BUDGET = Object.freeze({
  floorMs: 150,
  slowdownRatio: 2.5,
});

const LAYOUT_RECT_KEYS = Object.freeze([
  "root",
  "dom",
  "sidebar",
  "rules",
  "tabs",
  "toolbar",
  "sourceOrigin",
  "scrollOwner",
]);

const PARITY_RECT_COORDINATES = Object.freeze({
  root: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  dom: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  sidebar: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  rules: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  tabs: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  toolbar: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  sourceOrigin: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
  scrollOwner: Object.freeze(["left", "top", "right", "bottom", "width", "height"]),
});

export function assertNativeInspectorLayoutSnapshot(layout, label = "Inspector") {
  if (!layout || typeof layout !== "object") {
    throw new Error(`${label} layout snapshot is missing`);
  }
  if (layout.viewport?.width !== 800 || layout.viewport?.height !== 600) {
    throw new Error(
      `${label} viewport must be exactly 800x600: ${JSON.stringify(layout)}`,
    );
  }
  for (const key of LAYOUT_RECT_KEYS) {
    assertFiniteRect(layout.rects?.[key], `${label} ${key}`);
  }
  const {
    root,
    dom,
    sidebar,
    rules,
    tabs,
    toolbar,
    sourceOrigin,
    scrollOwner,
  } = layout.rects;
  if (
    Math.abs(root.left) > 1 ||
    Math.abs(root.top) > 1 ||
    Math.abs(root.width - 800) > 1 ||
    Math.abs(root.height - 600) > 1
  ) {
    throw new Error(`${label} root does not fill the 800x600 viewport`);
  }
  if (
    Math.abs(dom.left - root.left) > 1 ||
    Math.abs(dom.top - root.top) > 1 ||
    Math.abs(dom.height - root.height) > 1 ||
    Math.abs(sidebar.right - root.right) > 1 ||
    Math.abs(sidebar.top - root.top) > 1 ||
    Math.abs(sidebar.height - root.height) > 1 ||
    Math.abs(dom.right - sidebar.left) > 1 ||
    Math.abs(dom.width + sidebar.width - root.width) > 1
  ) {
    throw new Error(`${label} DOM/sidebar split is not contiguous`);
  }
  if (layout.domRatio < 0.60 || layout.domRatio > 0.64) {
    throw new Error(`${label} DOM/sidebar ratio is outside the native 62/38 split`);
  }
  if (
    Math.abs(tabs.left - sidebar.left) > 1 ||
    Math.abs(tabs.top - sidebar.top) > 1 ||
    Math.abs(tabs.width - sidebar.width) > 1 ||
    Math.abs(rules.left - sidebar.left) > 1 ||
    Math.abs(rules.width - sidebar.width) > 1 ||
    Math.abs(rules.top - tabs.bottom) > 1 ||
    Math.abs(rules.bottom - sidebar.bottom) > 1 ||
    Math.abs(scrollOwner.left - rules.left) > 1 ||
    Math.abs(scrollOwner.top - rules.top) > 1 ||
    Math.abs(scrollOwner.width - rules.width) > 1 ||
    Math.abs(scrollOwner.height - rules.height) > 1
  ) {
    throw new Error(
      `${label} sidebar tabs and Rules pane are not aligned: ${JSON.stringify(layout)}`,
    );
  }
  if (
    toolbar.left < rules.left - 1 ||
    toolbar.right > rules.right + 1 ||
    toolbar.top < rules.top - 1 ||
    sourceOrigin.left < rules.left - 1 ||
    sourceOrigin.right > rules.right + 1 ||
    sourceOrigin.top < rules.top - 1 ||
    sourceOrigin.bottom > rules.bottom + 1
  ) {
    throw new Error(`${label} Rules toolbar or SCSS origin is clipped`);
  }
  if (
    layout.overflowY !== "auto" ||
    layout.scrollable !== true ||
    layout.noHorizontalOverflow !== true ||
    layout.toolbarSticky !== true ||
    layout.sourceOriginVisible !== true ||
    layout.sourceOriginClickable !== true ||
    layout.selectedIndicator?.rulesSelected !== true ||
    layout.selectedIndicator?.sourceSelected !== false ||
    layout.selectedIndicator?.rulesTabIndex !== 0 ||
    layout.selectedIndicator?.sourceTabIndex !== -1 ||
    layout.selectedIndicator?.activeBorderVisible !== true ||
    layout.selectedIndicator?.inactiveBorderTransparent !== true ||
    layout.selectedIndicator?.activeTextDistinct !== true
  ) {
    throw new Error(
      `${label} layout semantics are incomplete: ${JSON.stringify(layout)}`,
    );
  }
}

export function assertNativeInspectorLayoutParity(
  chromeLayout,
  firefoxLayout,
  tolerancePx = 2,
) {
  assertNativeInspectorLayoutSnapshot(chromeLayout, "Chrome Inspector");
  assertNativeInspectorLayoutSnapshot(firefoxLayout, "Firefox Inspector");
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0 || tolerancePx > 2) {
    throw new Error("Inspector layout parity tolerance must be between 0 and 2px");
  }
  for (const [key, coordinates] of Object.entries(PARITY_RECT_COORDINATES)) {
    for (const coordinate of coordinates) {
      const delta = Math.abs(
        chromeLayout.rects[key][coordinate] - firefoxLayout.rects[key][coordinate],
      );
      if (delta > tolerancePx) {
        const reportedDelta = Math.round(delta * 1_000) / 1_000;
        throw new Error(
          `Chrome/Firefox Inspector layout differs at ${key}.${coordinate} by ${reportedDelta}px ` +
          `(${chromeLayout.rects[key][coordinate]} vs ${firefoxLayout.rects[key][coordinate]})`,
        );
      }
    }
  }
  if (Math.abs(chromeLayout.domRatio - firefoxLayout.domRatio) > 0.0025) {
    throw new Error("Chrome/Firefox Inspector DOM/sidebar ratios differ");
  }
}

export function assertNativeInspectorPerformanceParity(chrome, firefox) {
  const chromeDurations = performanceDurations(chrome, "Chrome Inspector");
  const firefoxDurations = performanceDurations(firefox, "Firefox Inspector");
  const { floorMs, slowdownRatio } = NATIVE_INSPECTOR_CROSS_BROWSER_BUDGET;
  for (const operation of Object.keys(chromeDurations)) {
    const chromeDuration = chromeDurations[operation];
    const firefoxDuration = firefoxDurations[operation];
    const ratio = Math.max(chromeDuration, firefoxDuration) /
      Math.max(Math.min(chromeDuration, firefoxDuration), floorMs);
    if (ratio > slowdownRatio) {
      throw new Error(
        `Chrome/Firefox Inspector ${operation} slowdown ratio ${ratio.toFixed(2)} exceeds ${slowdownRatio}`,
      );
    }
  }
}

export function assertNativeInspectorPerformance(performance, label = "Inspector") {
  if (!performance || typeof performance !== "object") {
    throw new Error(`${label} performance metrics are missing`);
  }
  for (const [operation, budget] of Object.entries(
    NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS,
  )) {
    const duration = performance[`${operation}Ms`];
    if (!Number.isFinite(duration) || duration < 0 || duration > budget) {
      throw new Error(
        `${label} ${operation} took ${String(duration)}ms (budget ${budget}ms)`,
      );
    }
  }
}

function assertFiniteRect(rect, label) {
  if (!rect || typeof rect !== "object") {
    throw new Error(`${label} rectangle is missing`);
  }
  for (const coordinate of ["left", "top", "right", "bottom", "width", "height"]) {
    if (!Number.isFinite(rect[coordinate])) {
      throw new Error(`${label}.${coordinate} is not finite`);
    }
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error(`${label} rectangle must be visible`);
  }
}

function performanceDurations(result, label) {
  assertNativeInspectorPerformance(result?.performance, label);
  const packaged = result?.packagedBootstrap?.navigationToReadyMs;
  if (!Number.isFinite(packaged) || packaged < 0 ||
    packaged > NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS.navigationToReady) {
    throw new Error(
      `${label} packaged navigation took ${String(packaged)}ms ` +
      `(budget ${NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS.navigationToReady}ms)`,
    );
  }
  return Object.freeze({
    navigationToReady: result.performance.navigationToReadyMs,
    loadMore: result.performance.loadMoreMs,
    rulesRefresh: result.performance.rulesRefreshMs,
    sourceSwitch: result.performance.sourceSwitchMs,
    total: result.performance.totalMs,
    packagedNavigationToReady: packaged,
  });
}

export async function smokeChromiumReadOnlyInspectorRuntime() {
  return validateSmokeResult(
    await smokeReadOnlyInspectorRuntime("chrome"),
    "Chrome Inspector",
  );
}

export async function smokeFirefoxReadOnlyInspectorRuntime() {
  return validateSmokeResult(
    await smokeReadOnlyInspectorRuntime("firefox"),
    "Firefox Inspector",
  );
}

export async function smokeChromiumAndFirefoxReadOnlyInspectorRuntime() {
  const chrome = await smokeChromiumReadOnlyInspectorRuntime();
  const firefox = await smokeFirefoxReadOnlyInspectorRuntime();
  assertNativeInspectorLayoutParity(chrome.layout, firefox.layout);
  assertNativeInspectorPerformanceParity(chrome, firefox);
  return Object.freeze({ chrome, firefox });
}

function validateSmokeResult(result, label) {
  assertNativeInspectorLayoutSnapshot(result.layout, label);
  assertNativeInspectorPerformance(result.performance, label);
  for (const [operation, budget] of Object.entries(
    NATIVE_INSPECTOR_OPERATION_BUDGET,
  )) {
    if (!Number.isSafeInteger(result.performance[operation]) ||
      result.performance[operation] < 0 ||
      result.performance[operation] > budget) {
      throw new Error(
        `${label} ${operation} used ${String(result.performance[operation])} calls (budget ${budget})`,
      );
    }
  }
  const bootstrap = result.packagedBootstrap;
  if (
    !bootstrap?.exactModules ||
    !bootstrap?.exactRulesOpen ||
    !bootstrap?.staleClickFenced ||
    !bootstrap?.invalidatedClickFenced ||
    !Number.isFinite(bootstrap.navigationToReadyMs) ||
    bootstrap.navigationToReadyMs < 0 ||
    bootstrap.navigationToReadyMs >
      NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS.navigationToReady
  ) {
    throw new Error(`${label} packaged bootstrap gate failed`);
  }
  return result;
}

async function smokeReadOnlyInspectorRuntime(browser) {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), `pin-op-native-inspector-${browser}-`));
  const profileRoot = path.join(smokeRoot, "profile");
  const appPath = path.join(smokeRoot, "app.js");
  const htmlPath = path.join(smokeRoot, "index.html");
  const panelCssPath = path.join(
    repositoryRoot,
    "packages",
    "browser-extension-core",
    "assets",
    "panel.css",
  );
  const elementsCssPath = path.join(
    repositoryRoot,
    "packages",
    "devtools-elements-ui",
    "assets",
    "devtools-elements.css",
  );
  const inspectorHtmlPath = path.join(
    repositoryRoot,
    "packages",
    "browser-extension-core",
    "assets",
    "inspector-panel.html",
  );
  const pinOpLogoPath = path.join(
    repositoryRoot,
    "packages",
    "browser-extension-core",
    "assets",
    "pin-op.svg",
  );
  let child;
  let cdp;
  let server;
  let browserStderr = "";
  let reportBrowserResult;
  const browserResult = new Promise(resolve => {
    reportBrowserResult = resolve;
  });
  try {
    await buildBrowserInspectorModules({
      extensionRoot: path.join(repositoryRoot, "extensions", browser),
      outdir: smokeRoot,
    });
    await build({
      absWorkingDir: repositoryRoot,
      stdin: {
        contents: smokeApplication(),
        loader: "js",
        resolveDir: smokeRoot,
        sourcefile: "native-inspector-smoke.js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome116", "firefox142"],
      outfile: appPath,
      external: [`./${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}`],
      logLevel: "silent",
      plugins: [sourcePaneSmokePlugin()],
    });
    await writeFile(htmlPath, smokeHTML(), "utf8");
    const packagedHtml = packagedSmokeHTML(await readFile(inspectorHtmlPath, "utf8"));
    server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/result" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        reportBrowserResult(JSON.parse(body));
        response.statusCode = 204;
        response.end();
        return;
      }
      if (requestUrl.pathname === "/packaged.html") {
        response.setHeader("Content-Type", "text/html");
        response.end(packagedHtml);
        return;
      }
      const file = requestUrl.pathname === `/${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}`
        ? path.join(smokeRoot, CHROMIUM_ELEMENTS_RUNTIME_FILENAME)
        : requestUrl.pathname === "/inspectorPanel.js"
          ? path.join(smokeRoot, "inspectorPanel.js")
        : requestUrl.pathname === "/app.js"
          ? appPath
          : requestUrl.pathname === "/panel.css"
            ? panelCssPath
            : requestUrl.pathname === "/devtools-elements.css"
              ? elementsCssPath
              : requestUrl.pathname === "/pin-op.svg"
                ? pinOpLogoPath
          : htmlPath;
      response.setHeader(
        "Content-Type",
        file.endsWith(".js") ? "text/javascript" :
          file.endsWith(".css") ? "text/css" :
            file.endsWith(".svg") ? "image/svg+xml" : "text/html",
      );
      response.end(await readFile(file));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Native Inspector smoke server has no TCP address");
    }

    if (browser === "firefox") {
      const executable = await findFirefoxExecutable();
      const firefoxOuterHeight = process.platform === "win32" ? 685 : 600;
      child = spawn(
        executable,
        [
          "--headless",
          "--width",
          "800",
          "--height",
          String(firefoxOuterHeight),
          "--no-remote",
          "--profile",
          profileRoot,
          `http://127.0.0.1:${address.port}/?firefox=1`,
        ],
        {
          ...buildChromeSpawnOptions(),
          env: { ...process.env, MOZ_HEADLESS: "1" },
        },
      );
      captureStderr(child, chunk => {
        if (browserStderr.length < 16_384) browserStderr += chunk;
      });
      const result = await waitForReportedBrowserResult(browserResult, child);
      if (!result?.ok) {
        throw new Error(result?.error ?? "Firefox native Inspector smoke failed");
      }
      return result.value;
    }

    const executable = await findChromeExecutable();
    child = spawn(
      executable,
      [
        "--headless=new",
        ...buildChromeArguments(profileRoot),
      ],
      buildChromeSpawnOptions(),
    );
    captureStderr(child, chunk => {
      if (browserStderr.length < 16_384) browserStderr += chunk;
    });
    const [portText, browserPath] = (await waitForPortFile(
      path.join(profileRoot, "DevToolsActivePort"),
      child,
    )).split(/\r?\n/);
    const port = Number(portText);
    if (!Number.isInteger(port) || !browserPath?.startsWith("/devtools/browser/")) {
      throw new Error("Chrome wrote an invalid DevToolsActivePort file");
    }
    cdp = await openCdp(
      `ws://127.0.0.1:${port}${browserPath}`,
      { timeoutMs },
    );
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await cdp.send(
      "Page.navigate",
      { url: `http://127.0.0.1:${address.port}/` },
      sessionId,
    );
    const result = await pollResult(cdp, sessionId);
    if (!result?.ok) {
      throw new Error(result?.error ?? "Chrome native Inspector smoke failed");
    }
    return result.value;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        browserStderr.trim() ? `\n${browser} stderr:\n${browserStderr.trim()}` : ""
      }`,
      { cause: error },
    );
  } finally {
    await shutdownOwnedChildTree({ child, cdp });
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(smokeRoot, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 50,
    });
  }
}

function sourcePaneSmokePlugin() {
  const sourcePaneEntry = path.join(
    repositoryRoot,
    "packages",
    "browser-extension-core",
    "dist",
    "sourcePaneView.js",
  );
  return {
    name: "exact-pin-op-source-pane-smoke",
    setup(context) {
      context.onResolve({ filter: /^#pin-op-source-pane$/ }, () => ({
        path: sourcePaneEntry,
      }));
    },
  };
}

function captureStderr(child, onChunk) {
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", onChunk);
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

async function findFirefoxExecutable() {
  const candidates = process.platform === "win32"
    ? [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    ]
    : process.platform === "darwin"
      ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
      : ["/usr/bin/firefox", "/usr/local/bin/firefox"];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Firefox was not found for the native Inspector smoke");
}

async function waitForPortFile(file, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Chrome exited before CDP was ready (${child.exitCode ?? child.signalCode})`,
      );
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
  while (Date.now() < deadline) {
    const evaluation = await cdp.send(
      "Runtime.evaluate",
      {
        expression: "window.pinOpInspectorSmokeResult",
        returnByValue: true,
      },
      sessionId,
    );
    if (evaluation.result?.value) return evaluation.result.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const evaluation = await cdp.send(
    "Runtime.evaluate",
    {
      expression:
        "({html:document.documentElement.outerHTML.slice(0,3000),errors:window.pinOpInspectorSmokeErrors})",
      returnByValue: true,
    },
    sessionId,
  );
  throw new Error(
    `Timed out waiting for native Inspector smoke: ${JSON.stringify(evaluation.result?.value)}`,
  );
}

async function waitForReportedBrowserResult(resultPromise, child) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Firefox native Inspector result")),
      timeoutMs,
    );
    resultPromise.then(result => {
      clearTimeout(timeout);
      resolve(result);
    }, reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `Firefox exited before reporting native Inspector result (${code ?? signal})`,
      ));
    });
  });
}

function smokeHTML() {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="./panel.css">
    <link rel="stylesheet" href="./devtools-elements.css">
  <script>
    window.pinOpInspectorSmokeErrors=[];
    window.pinOpPackagedBootstrapPromise=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Timed out waiting for packaged Inspector bootstrap')),15000);
      addEventListener('message',event=>{
        if(event.origin!==location.origin||event.data?.type!=='pin-op.packaged-bootstrap.result')return;
        clearTimeout(timeout);
        event.data.ok?resolve(event.data.value):reject(new Error(event.data.error||'Packaged Inspector bootstrap failed'));
      });
    });
    addEventListener('error',event=>{const message=event.error instanceof Error?event.error.message+'\\n'+(event.error.stack||''):String(event.error||event.message);window.pinOpInspectorSmokeErrors.push(message);window.pinOpInspectorSmokeResult={ok:false,error:message}});
    addEventListener('unhandledrejection',event=>{const message=event.reason instanceof Error?event.reason.message+'\\n'+(event.reason.stack||''):String(event.reason);window.pinOpInspectorSmokeErrors.push(message);window.pinOpInspectorSmokeResult={ok:false,error:message}});
  </script></head><body><main class="panel-layout inspector-panel-layout">
    <section class="panel-workspace inspector-workspace">
      <div id="inspector-elements-mount"></div>
    </section>
  </main><iframe title="Packaged Inspector bootstrap gate" aria-hidden="true" src="./packaged.html?channel=bootstrap-channel" style="position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0"></iframe><script type="module" src="./app.js"></script></body></html>`;
}

function packagedSmokeHTML(inspectorHtml) {
  const bootstrap = `<script>
  (()=>{
    const listeners=()=>{const values=new Set();return {addListener:value=>values.add(value),removeListener:value=>values.delete(value),emit:value=>{for(const listener of [...values])listener(value)}}};
    const sent=[];
    const runtimeMessages=[];
    const ports=[];
    const browserApi={runtime:{
      id:'pin-op-native-bootstrap',
      connect:({name})=>{const port={name,sent:[],onMessage:listeners(),onDisconnect:listeners(),postMessage(message){this.sent.push(message);sent.push(message)},disconnect(){this.onDisconnect.emit()}};ports.push(port);return port},
      sendMessage:async message=>{runtimeMessages.push(message)},
    }};
    window.__pinOpPackagedBootstrap={ports,sent,runtimeMessages};
    globalThis.browser=browserApi;
    if(!globalThis.chrome)globalThis.chrome={};
    globalThis.chrome.runtime={id:'pin-op-native-bootstrap'};
  })();
  </script>`;
  const harness = `<script type="module">
  const report=value=>parent.postMessage(value,location.origin);
  const state=window.__pinOpPackagedBootstrap;
  const started=performance.getEntriesByType('navigation')[0]?.startTime||0;
  Promise.resolve().then(async()=>{
    const port=await waitFor(()=>state.ports[0],'runtime port');
    await waitFor(()=>message(port.sent,'dom.getRoot'),'dom.getRoot');
    port.onMessage.emit({type:'pin-op.windowState',state:'linked'});
    port.onMessage.emit({type:'pin-op.protocol.compatibility',compatible:true,browserProtocolVersion:7});
    await tick();
    const rootRequest=await waitFor(()=>message(port.sent,'dom.getRoot'),'linked dom.getRoot');
    port.onMessage.emit({type:'dom.root',requestId:rootRequest.requestId,documentEpoch:1,node:domNode('root','HTML',true),prologue:[],epilogue:[]});
    await tick();
    port.onMessage.emit({type:'pin-op.inspect.started',inspectMessageId:'bootstrap-inspect',selectionRevision:1,expectedRuleRefs:['bootstrap-rule']});
    port.onMessage.emit({type:'dom.selectionChanged',documentEpoch:1,selectionRevision:1,nodeRef:'selected',ancestorPath:[domNode('root','HTML',true),domNode('selected','DIV',false)]});
    const stylesRequest=await waitFor(()=>message(port.sent,'styles.getMatched'),'styles.getMatched');
    port.onMessage.emit(stylesMatched(stylesRequest));
    port.onMessage.emit(rulesSources());
    const origin=await waitFor(()=>deepQueryAll(document,'.pin-op-rule-origin').find(node=>node.textContent==='theme.scss:73'),'theme.scss:73');
    const readyMs=performance.now()-started;
    origin.click();
    const open=await waitFor(()=>message(port.sent,'pin-op.rules.open'),'pin-op.rules.open');
    const expected={type:'pin-op.rules.open',inspectMessageId:'bootstrap-inspect',rulesGeneration:1,openAuthorityId:'bootstrap-authority'};
    const exactRulesOpen=JSON.stringify(open)===JSON.stringify(expected);
    const count=port.sent.filter(value=>value?.type==='pin-op.rules.open').length;
    port.onMessage.emit({type:'pin-op.rules.invalidated',inspectMessageId:'bootstrap-inspect',rulesGeneration:1});
    await waitFor(()=>!deepQueryAll(document,'.pin-op-rule-origin').some(node=>node.textContent==='theme.scss:73'),'stale Rules origin removal');
    origin.click();
    await tick();
    const staleClickFenced=port.sent.filter(value=>value?.type==='pin-op.rules.open').length===count;
    port.onMessage.emit({type:'pin-op.inspect.invalidated',reason:'documentDisconnected'});
    origin.click();
    await tick();
    const invalidatedClickFenced=port.sent.filter(value=>value?.type==='pin-op.rules.open').length===count;
    const resources=performance.getEntriesByType('resource').map(entry=>new URL(entry.name).pathname);
    report({type:'pin-op.packaged-bootstrap.result',ok:true,value:{
      exactModules:Boolean(document.querySelector('script[src="./inspectorPanel.js"]'))&&resources.includes('/inspectorPanel.js')&&resources.includes('/${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}'),
      exactRulesOpen,staleClickFenced,invalidatedClickFenced,navigationToReadyMs:readyMs,open,
      lifecycle:['linked','compatibility','dom.root','inspect','styles','rules.sources'],
    }});
  }).catch(error=>report({type:'pin-op.packaged-bootstrap.result',ok:false,error:error instanceof Error?error.message+'\\n'+(error.stack||''):String(error)}));
  function domNode(nodeRef,nodeName,expandable){return {nodeRef,kind:'element',nodeType:1,nodeName,attributes:[],childCount:expandable?1:0,relationship:'dom',selectable:true,expandable,branchRevision:1,label:nodeRef,locator:{version:1,targetKind:'element',boundaries:[],path:[{tagName:nodeName.toLowerCase(),siblingIndex:0}]}}}
  function stylesMatched(request){return {type:'styles.matched',requestId:request.requestId,documentEpoch:request.documentEpoch,nodeRef:request.nodeRef,selectionRevision:request.selectionRevision,stylesRevision:1,stylesheetRevision:1,pseudoStateRevision:0,pseudoStates:[],styles:{documentEpoch:request.documentEpoch,nodeRef:request.nodeRef,selectionRevision:request.selectionRevision,stylesRevision:1,stylesheetRevision:1,pseudoStateRevision:0,pseudoStates:[],rules:[{ruleRef:'bootstrap-rule',selectorText:'.bootstrap',matchingSelectorIndices:[0],declarations:[{ruleRef:'bootstrap-rule',property:'color',value:'rebeccapurple',important:false,valueTruncated:false,state:'winning-known-author',reason:'highest-precedence-known-author-declaration'}],contexts:[],source:{sourceUrl:'https://example.test/style.css',startLine:17,startColumn:5,endLine:18,endColumn:2,rulePath:'0'}}],inherited:[],inaccessibleStylesheetCount:0,unsupportedRuleCount:0,approximateRuleCount:0,partial:false,diagnostics:[]}}}
  function rulesSources(){return {protocolVersion:7,type:'rules.sources',messageId:'bootstrap-rules-sources',sessionId:'bootstrap-session',source:{role:'ide',id:'bootstrap-vscode'},inspectMessageId:'bootstrap-inspect',rulesGeneration:1,sources:[{ruleRef:'bootstrap-rule',openAuthorityId:'bootstrap-authority',document:{label:'theme.scss',languageId:'scss'},startLine:73,startColumn:5,confidence:'sourcemap'}],unresolvedRuleCount:0,metadata:{}}}
  function message(values,type){return [...values].reverse().find(value=>value?.type===type)}
  function deepQueryAll(root,selector){const found=[...root.querySelectorAll(selector)];const visit=node=>{if(node.shadowRoot){found.push(...node.shadowRoot.querySelectorAll(selector));for(const child of node.shadowRoot.querySelectorAll('*'))visit(child)}for(const child of node.children||[])visit(child)};visit(root);return [...new Set(found)]}
  async function waitFor(predicate,label){const deadline=performance.now()+10000;while(true){const value=predicate();if(value)return value;if(performance.now()>=deadline)throw new Error('Timed out waiting for '+label);await new Promise(resolve=>setTimeout(resolve,20))}}
  async function tick(){await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,0))}
  </script>`;
  return inspectorHtml
    .replace("</head>", `${bootstrap}</head>`)
    .replace("</body>", `${harness}</body>`);
}

function smokeApplication() {
  return `
import * as Inspector from './${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}';
import {SourcePaneView} from '#pin-op-source-pane';

const performanceBudget=${JSON.stringify(NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS)};
const operationBudget=${JSON.stringify(NATIVE_INSPECTOR_OPERATION_BUDGET)};
const firefoxAutomation = new URLSearchParams(location.search).has('firefox');
const report = result => {
  window.pinOpInspectorSmokeResult = result;
  if (firefoxAutomation) {
    void fetch('/result', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
  }
};
const errors = [];
const opened = [];
const sourceOpened = [];
const treeCalls = {select:[],focus:[],hover:[],expand:[],collapse:[],loadMore:[]};
const writerNames = new Set([
  'setAttribute','setAttributeValue','setNodeName','setNodeValue','setOuterHTML',
  'removeNode','moveTo','copyTo','setStyleText','setSelectorText','addRule',
]);
let writerCalls = 0;
let treeSnapshotCalls = 0;
let rulesSnapshotCalls = 0;
let rulesNotifications = 0;
let treeUnsubscribed = 0;
let rulesUnsubscribed = 0;
let pseudoUnsubscribed = 0;
let sourceUnsubscribed = 0;
const treeListeners = new Set();
const rulesListeners = new Set();
let pseudoListener;
let pseudoSnapshot = {
  state:'ready',states:[],unsupportedRuleCount:0,inaccessibleStylesheetCount:0,approximateRuleCount:0,
};
const baseRows = [
  row('doctype', undefined, 0, 10, 'html', 0, false, false),
  row('html', undefined, 0, 1, 'HTML', 1, true, false),
  row('body', 'html', 1, 1, 'BODY', 1, true, true),
  row('main', 'body', 2, 1, 'MAIN', 360, true, false),
];
const firstChildren = Array.from({length:180}, (_,index) =>
  row('section-'+index,'main',3,1,'SECTION',0,false,false));
const allChildren = Array.from({length:360}, (_,index) =>
  row(index<180?'section-'+index:'article-'+index,'main',3,1,index<180?'SECTION':'ARTICLE',0,false,false));
let rows = [...baseRows,...firstChildren,loadMoreRow('main',3,'load-more:main',true)];
const treeSource = writerTrapped({
  snapshot: () => { treeSnapshotCalls += 1; return {rows}; },
  subscribe: listener => {
    treeListeners.add(listener);
    return () => { if (treeListeners.delete(listener)) treeUnsubscribed += 1; };
  },
  expand: async ref => { treeCalls.expand.push(ref); },
  collapse: ref => { treeCalls.collapse.push(ref); },
  loadMore: async ref => {
    treeCalls.loadMore.push(ref);
    await Promise.resolve();
    rows=[...baseRows,...allChildren];
    for (const listener of [...treeListeners]) listener();
  },
  select: async ref => { treeCalls.select.push(ref); },
  focus: ref => { treeCalls.focus.push(ref); },
  hover: ref => { treeCalls.hover.push(ref); },
});
const declarations = Array.from({length:278}, (_, index) => ({
  declarationRef:'decl:'+index,
  name:index===0?'color':index===1?'margin':index===2?'border':
    index===3?'background':index===4?'font':index===5?'flex':index===6?'grid':'--property-'+index,
  value:index===0?'rgb(255 0 0 / 75%)':index===1?'1px 2px 3px 4px':
    index===2?'2px solid rgb(0 128 0)':index===3?'rgb(0 0 255)':
    index===4?'italic 700 16px/1.5 Arial':index===5?'1 0 auto':
    index===6?'auto-flow / 100px':String(index),
  important:false,
  state:index===0?'winning-known-author':index===1?'overridden-known-author':
    index===2?'inactive':index===3?'unknown':'winning-known-author',
}));
const matchedStyles = {
  documentEpoch:1,selectionRevision:1,stylesRevision:1,stylesheetRevision:1,
  pseudoStateRevision:0,pseudoStates:[],nodeRef:'body',
  matchedRules:[{
    ruleRef:'rule:scss',selectorText:'.fixture:not(.a,.b), [data-value=",x"]',
    matchingSelectorIndices:[0],declarations,contexts:[
      {kind:'media',text:'(min-width: 1px)'},{kind:'supports',text:'(display: grid)'},
      {kind:'layer',text:'theme'},{kind:'scope',text:'(.scope)'},
      {kind:'container',text:'(inline-size > 1px)'},{kind:'starting-style',text:''},
    ],
    generatedSource:{label:'style.css',lineNumber:41,columnNumber:2},
  },{
    ruleRef:'rule:duplicate-a',selectorText:'.duplicate',matchingSelectorIndices:[0],
    declarations:[declaration('dup:a','display','block')],contexts:[],
  },{
    ruleRef:'rule:duplicate-b',selectorText:'.duplicate',matchingSelectorIndices:[0],
    declarations:[declaration('dup:b','position','relative')],contexts:[],
  },{
    ruleRef:'rule:generated',selectorText:'.generated',matchingSelectorIndices:[0],
    declarations:[declaration('generated:one','opacity','0.75')],contexts:[],
    generatedSource:{label:'C:\\\\site\\\\plain.css'},
  }],
  inherited:[{nodeRef:'body-parent',matchedRules:[{
    ruleRef:'rule:inherited-a',selectorText:'.inherited',matchingSelectorIndices:[0],
    declarations:[declaration('inherited:a','padding','8px')],contexts:[],
  },{
    ruleRef:'rule:inherited-b',selectorText:'.inherited',matchingSelectorIndices:[0],
    declarations:[declaration('inherited:b','color','blue')],contexts:[],
  }]}],unsupportedRuleCount:0,inaccessibleStylesheetCount:0,
  approximateRuleCount:0,omittedRuleCount:0,diagnostics:[],
};
let rulesPresentation={state:'ready',matchedStyles};
const rulesSource = writerTrapped({
  snapshot: () => { rulesSnapshotCalls += 1; return rulesPresentation; },
  subscribe: listener => {
    rulesListeners.add(listener);
    return () => { if (rulesListeners.delete(listener)) rulesUnsubscribed += 1; };
  },
  filter: () => {},
});
const sourceDelegate = {
  originFor: ruleRef => ({
    'rule:scss':{label:'theme.scss',languageId:'scss',startLine:73,startColumn:5,confidence:'sourcemap',clickable:true},
    'rule:duplicate-a':{label:'first.scss',languageId:'scss',startLine:11,startColumn:1,confidence:'sourcemap',clickable:true},
    'rule:duplicate-b':{label:'second.scss',languageId:'scss',startLine:22,startColumn:1,confidence:'sourcemap',clickable:true},
    'rule:inherited-b':{label:'inherited.scss',languageId:'scss',startLine:33,startColumn:1,confidence:'sourcemap',clickable:true},
  })[ruleRef],
  openRuleOrigin: ruleRef => { opened.push(ruleRef); },
};
const pseudoSource = {
  snapshot: () => pseudoSnapshot,
  subscribe: listener => { pseudoListener=listener; return () => { pseudoUnsubscribed += 1; }; },
  setStates: async states => {
    pseudoSnapshot={...pseudoSnapshot,states:[...states]};
    pseudoListener?.();
  },
};
const sourceController={
  snapshot:()=>({
    document:{label:'theme.scss',languageId:'scss'},activeMatchId:'source:theme',omittedMatchCount:0,
    groups:{
      selected:{label:'Selected',collapsed:false,matches:[{
        matchId:'source:theme',targetRole:'selected',label:'theme.scss:73',kind:'rule',
        relation:'selected',confidence:'exact',startLine:73,endLine:76,
        text:'.fixture {\\n  color: rgb(255 0 0 / 75%);\\n}',truncated:false,
      }]},
      parent:{label:'Parent',collapsed:true,matches:[]},
    },
  }),
  subscribe:()=>()=>{sourceUnsubscribed+=1;},
  open:matchId=>sourceOpened.push(matchId),
};

Promise.resolve().then(async () => {
  const navigationStart=performance.getEntriesByType('navigation')[0]?.startTime||0;
  const operationStart=performance.now();
  if(firefoxAutomation&&(innerWidth!==800||innerHeight!==600)) {
    resizeBy(800-innerWidth,600-innerHeight);
    await waitFor(()=>innerWidth===800&&innerHeight===600,'Firefox 800x600 viewport');
  }
  const mount = document.querySelector('#inspector-elements-mount');
  const view = Inspector.createElementsInspectorView(document, mount, treeSource);
  view.bindRulesDataSource(rulesSource, sourceDelegate, pseudoSource);
  const sourcePane=new SourcePaneView({document,root:view.sidebarExtensionMount,controller:sourceController,onError:error=>errors.push(String(error))});
  await waitFor(() => deepQueryAll(view.domRoot,'.webkit-html-tag-name').length >= 183, 'large native DOM rows');
  await waitFor(() => deepQuery(view.rulesRoot,'.styles-section'), 'native Styles section');
  const pane = view.rulesRoot.querySelector('[data-part="chromium-read-only-styles-pane"]');
  const paneIdentity = pane;
  const showAll = deepQuery(view.rulesRoot,'.styles-show-all');
  showAll?.click();
  await waitFor(() => deepQueryAll(view.rulesRoot,'.webkit-css-property').length >= 280, 'at least 280 native properties');
  const navigationToReadyMs=performance.now()-navigationStart;
  const initialPropertyRows=deepQueryAll(view.rulesRoot,'.webkit-css-property').length;
  const origin = deepQueryAll(view.rulesRoot,'.pin-op-rule-origin').find(node=>node.textContent==='theme.scss:73');
  const sidebar=view.element.querySelector('[data-pane="sidebar"]');
  const tabsRoot=view.element.querySelector('[role="tablist"]');
  const rulesTab = [...view.element.querySelectorAll('[role="tab"]')].find(tab => tab.textContent==='Rules');
  const sourceTab = [...view.element.querySelectorAll('[role="tab"]')].find(tab => tab.textContent==='Source');
  const toolbar=deepQuery(view.rulesRoot,'.styles-sidebar-pane-toolbar-container');
  const activeTabStyle=getComputedStyle(rulesTab);
  const inactiveTabStyle=getComputedStyle(sourceTab);
  const originRect=origin?.getBoundingClientRect();
  const rulesRect=view.rulesRoot.getBoundingClientRect();
  const layout={
    viewport:{width:innerWidth,height:innerHeight},
    rects:{
      root:rect(view.element),dom:rect(view.domRoot),sidebar:rect(sidebar),rules:rect(view.rulesRoot),
      tabs:rect(tabsRoot),toolbar:rect(toolbar),sourceOrigin:rect(origin),
      scrollOwner:rect(pane),
    },
    domRatio:view.domRoot.getBoundingClientRect().width/view.element.getBoundingClientRect().width,
    overflowY:getComputedStyle(pane).overflowY,
    scrollable:pane.scrollHeight>pane.clientHeight,
    noHorizontalOverflow:[document.documentElement,view.element,view.domRoot,sidebar,view.rulesRoot,pane]
      .every(node=>node&&node.scrollWidth<=node.clientWidth+1),
    toolbarSticky:getComputedStyle(toolbar).position==='sticky',
    sourceOriginVisible:Boolean(originRect&&originRect.width>0&&originRect.height>0&&originRect.top>=rulesRect.top&&originRect.bottom<=rulesRect.bottom+1),
    sourceOriginClickable:origin?.tagName==='BUTTON'&&!origin.disabled&&getComputedStyle(origin).pointerEvents!=='none',
    selectedIndicator:{
      rulesSelected:rulesTab?.getAttribute('aria-selected')==='true',
      sourceSelected:sourceTab?.getAttribute('aria-selected')==='true',
      rulesTabIndex:rulesTab?.tabIndex,
      sourceTabIndex:sourceTab?.tabIndex,
      activeBorderVisible:parseFloat(activeTabStyle.borderBottomWidth)>=2&&!transparent(activeTabStyle.borderBottomColor),
      inactiveBorderTransparent:transparent(inactiveTabStyle.borderBottomColor),
      activeTextDistinct:activeTabStyle.color!==inactiveTabStyle.color,
    },
  };
  origin?.click();
  const origins=deepQueryAll(view.rulesRoot,'.styles-section-subtitle').map(node=>node.textContent?.trim()).filter(Boolean);
  const generatedFallback=origins.includes('plain.css')&&!origins.includes('plain.css:1');

  const loadMore=deepQuery(view.domRoot,'.pin-op-elements-load-more');
  const loadStart=performance.now();
  loadMore?.click();
  await waitFor(()=>deepQueryAll(view.domRoot,'.webkit-html-tag-name').length>=363,'lazy DOM load-more');
  const loadMoreMs=performance.now()-loadStart;
  const lazyLoadMore=treeCalls.loadMore.join()==='main'&&!deepQuery(view.domRoot,'.pin-op-elements-load-more');

  const selectedBefore=deepQuery(view.domRoot,'.selected')?.closest('[role="treeitem"]')||deepQuery(view.domRoot,'.selected');
  selectedBefore?.focus();
  const activeBefore=deepActiveElement(document);
  selectedBefore?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,composed:true}));
  await waitFor(()=>deepActiveElement(document)!==activeBefore,'DOM keyboard navigation');
  const domKeyboardMoved=deepActiveElement(document)!==activeBefore;
  const domSelectionForwarded=treeCalls.select.length>0;

  const pseudoButton = view.rulesRoot.querySelector('[data-part="pseudo-state-button"]');
  pseudoButton?.click();
  const hoverChoice = view.rulesRoot.querySelector('[data-pseudo-state="hover"]');
  hoverChoice?.click();
  await waitFor(() => pseudoSnapshot.states.includes('hover'), 'pseudo-state update');

  const colorName=deepQueryAll(view.rulesRoot,'.webkit-css-property').find(node=>node.textContent==='color');
  const colorRow=colorName?.closest('li');
  colorRow?.scrollIntoView({block:'nearest'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await waitFor(()=>colorRow&&deepQuery(colorRow,'devtools-color-swatch'),'native color swatch');
  const colorSwatch=colorRow&&deepQuery(colorRow,'devtools-color-swatch');
  const nativeColorSwatch=colorSwatch?.localName==='devtools-color-swatch'&&
    colorSwatch.shadowRoot?.querySelector('.color-swatch.readonly') instanceof HTMLElement;
  const shorthandExpectations={
    margin:['margin-top','margin-right','margin-bottom','margin-left'],
    border:['border-top-width','border-right-style','border-bottom-color'],
    background:['background-color','background-image'],
    font:['font-style','font-weight','font-size','line-height','font-family'],
    flex:['flex-grow','flex-shrink','flex-basis'],
    grid:['grid-template-rows','grid-template-columns'],
  };
  const shorthandIcons={};
  for (const [shorthand,longhands] of Object.entries(shorthandExpectations)) {
    let name=deepQueryAll(view.rulesRoot,'.webkit-css-property').find(node=>node.textContent===shorthand);
    name?.closest('li')?.scrollIntoView({block:'nearest'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await waitFor(()=>{
      name=deepQueryAll(view.rulesRoot,'.webkit-css-property').find(node=>node.textContent===shorthand);
      return name?.closest('li')&&deepQuery(name.closest('li'),'.expand-icon');
    },'visible native '+shorthand+' shorthand');
    const icon=name?.closest('li')&&deepQuery(name.closest('li'),'.expand-icon');
    shorthandIcons[shorthand]=Boolean(icon);
    icon?.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true}));
    await waitFor(()=>longhands.every(longhand=>deepQueryAll(view.rulesRoot,'.webkit-css-property').some(node=>node.textContent===longhand)),'native '+shorthand+' shorthand');
  }
  const shorthandCoverage=Object.fromEntries(Object.entries(shorthandExpectations).map(([name,longhands])=>[
    name,longhands.every(longhand=>deepQueryAll(view.rulesRoot,'.webkit-css-property').some(node=>node.textContent===longhand)),
  ]));
  const expandedPropertyNames=deepQueryAll(view.rulesRoot,'.webkit-css-property').map(node=>node.textContent).filter(Boolean);

  const scrollCandidates=[pane,deepQuery(view.element,'.pin-op-elements-inspector__rules'),view.rulesRoot].filter(Boolean);
  const scrollOwner=scrollCandidates.find(node=>node.scrollHeight>node.clientHeight);
  if (!scrollOwner) throw new Error('Native Rules scroll owner is missing: '+JSON.stringify(scrollCandidates.map(node=>({className:node.className,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,display:getComputedStyle(node).display,overflow:getComputedStyle(node).overflow}))));
  const stickyToolbar=deepQuery(view.rulesRoot,'.styles-sidebar-pane-toolbar-container');
  const stickyBefore=stickyToolbar?.getBoundingClientRect().top;
  scrollOwner.scrollTop=scrollOwner.scrollHeight;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const lastProperty=deepQueryAll(view.rulesRoot,'.webkit-css-property').at(-1);
  lastProperty?.scrollIntoView({block:'nearest'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const lastRect=lastProperty?.getBoundingClientRect();
  const ownerRect=scrollOwner.getBoundingClientRect();
  const stickyAfter=stickyToolbar?.getBoundingClientRect().top;
  const scrollContract={
    moved:scrollOwner.scrollTop>0,
    lastVisible:Boolean(lastRect&&lastRect.top>=ownerRect.top&&lastRect.bottom<=ownerRect.bottom+1),
    sticky:getComputedStyle(stickyToolbar).position==='sticky'&&Math.abs(stickyBefore-stickyAfter)<=1,
  };
  const filterInput=deepQuery(view.rulesRoot,'.toolbar-filter input');
  const noMatches=deepQuery(view.rulesRoot,'.gray-info-message');
  filterInput.value='definitely-not-a-style';
  filterInput.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
  await waitFor(()=>noMatches&&!noMatches.classList.contains('hidden'),'native no-matches state');
  filterInput.value='';
  filterInput.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
  await waitFor(()=>noMatches?.classList.contains('hidden'),'native filter reset');
  const filterRoundTrip=noMatches?.classList.contains('hidden')===true;

  const treeBefore = deepQuery(view.domRoot,'[role="tree"]');
  const treeTextBefore = treeBefore?.textContent;
  selectedBefore?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,composed:true}));
  selectedBefore?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,composed:true}));
  selectedBefore?.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,composed:true}));
  await new Promise(resolve => setTimeout(resolve,0));

  const outsideFocus=document.createElement('button');
  outsideFocus.textContent='outside';
  document.body.append(outsideFocus);
  outsideFocus.focus({preventScroll:true});
  const staleSnapshot={...matchedStyles,stylesRevision:2,matchedRules:[{
    ruleRef:'rule:stale',selectorText:'.stale',matchingSelectorIndices:[0],
    declarations:[declaration('stale:one','display','none')],contexts:[],
  }],inherited:[]};
  const finalSnapshot={...matchedStyles,stylesRevision:3,matchedRules:[
    {...matchedStyles.matchedRules[0],selectorText:'.final'},...matchedStyles.matchedRules.slice(1),
  ]};
  const rulesRefreshStart=performance.now();
  rulesPresentation={state:'loading'};
  rulesNotifications+=1;
  for (const listener of [...rulesListeners]) listener();
  await waitFor(()=>view.rulesRoot.querySelector('[data-part="rules-message"]')?.textContent==='Loading styles','Rules loading status');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const loadingMessage=view.rulesRoot.querySelector('[data-part="rules-message"]');
  const loadingRootRect=rect(view.rulesRoot);
  const loadingPaneRect=rect(paneIdentity);
  const loadingMessageRect=rect(loadingMessage);
  const loadingLayout={
    direction:getComputedStyle(view.rulesRoot).flexDirection,
    root:loadingRootRect,
    pane:loadingPaneRect,
    message:loadingMessageRect,
    slotStable:Boolean(
      loadingRootRect&&layout.rects.rules&&
      Math.abs(loadingRootRect.left-layout.rects.rules.left)<=1&&
      Math.abs(loadingRootRect.right-layout.rects.rules.right)<=1&&
      Math.abs(loadingRootRect.top-layout.rects.rules.top)<=1&&
      Math.abs(loadingRootRect.bottom-layout.rects.rules.bottom)<=1
    ),
    stacked:Boolean(
      loadingRootRect&&loadingPaneRect&&loadingMessageRect&&
      Math.abs(loadingPaneRect.left-loadingRootRect.left)<=1&&
      Math.abs(loadingPaneRect.right-loadingRootRect.right)<=1&&
      (loadingMessageRect.bottom<=loadingPaneRect.top+1||loadingPaneRect.bottom<=loadingMessageRect.top+1)&&
      loadingPaneRect.top>=loadingRootRect.top-1&&
      loadingPaneRect.bottom<=loadingRootRect.bottom+1&&
      loadingMessageRect.top>=loadingRootRect.top-1&&
      loadingMessageRect.left>=loadingRootRect.left-1&&
      loadingMessageRect.right<=loadingRootRect.right+1&&
      loadingMessageRect.bottom<=loadingRootRect.bottom+1
    ),
  };
  rulesPresentation={state:'ready',matchedStyles:staleSnapshot};
  rulesNotifications+=1;
  for (const listener of [...rulesListeners]) listener();
  rulesPresentation={state:'ready',matchedStyles:finalSnapshot};
  rulesNotifications+=1;
  for (const listener of [...rulesListeners]) listener();
  await waitFor(()=>deepQuery(view.rulesRoot,'.selector')?.textContent?.includes('.final'),'latest overlapping Rules render');
  const rulesRefreshMs=performance.now()-rulesRefreshStart;
  const staleRenderFenced=!deepQuery(view.rulesRoot,'.selector')?.textContent?.includes('.stale')&&document.activeElement===outsideFocus;

  const sourceSwitchStart=performance.now();
  sourceTab?.click();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const sourceSwitchMs=performance.now()-sourceSwitchStart;
  const sourceEntry=view.sidebarExtensionMount.querySelector('.source-pane-entry');
  const sourceOpen=view.sidebarExtensionMount.querySelector('.source-pane-open');
  sourceOpen?.click();
  const sourceVisible = !view.sidebarExtensionMount.hidden && view.rulesRoot.hidden&&
    sourceEntry?.textContent?.includes('color: rgb(255 0 0 / 75%)')&&sourceOpened.join()==='source:theme';
  sourceTab?.focus();
  sourceTab?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  const tabKeyboard=document.activeElement===rulesTab&&rulesTab?.getAttribute('aria-selected')==='true'&&rulesTab?.tabIndex===0&&sourceTab?.tabIndex===-1;
  const rulesRestored = !view.rulesRoot.hidden && paneIdentity ===
    view.rulesRoot.querySelector('[data-part="chromium-read-only-styles-pane"]');

  const tags = deepQueryAll(view.domRoot,'.webkit-html-tag-name').map(node => node.textContent?.trim()).filter(Boolean);
  const packagedBootstrap=await window.pinOpPackagedBootstrapPromise;
  const totalMs=performance.now()-operationStart;
  const value = {
    exports:Object.keys(Inspector),
    tags,
    nativeDom:Boolean(treeBefore),
    nativeStyles:Boolean(deepQuery(view.rulesRoot,'.styles-section')),
    initialPropertyRows,
    hasNativeShowAll:Boolean(showAll),
    origin:origin?.textContent,
    opened,
    generatedFallback,
    nativeColorSwatch,
    shorthandCoverage,
    shorthandIcons,
    expandedPropertyNames:expandedPropertyNames.filter(name=>['background-color','background-image','font-style','font-weight','font-size','line-height','font-family','flex-grow','flex-shrink','flex-basis','grid-template-rows','grid-template-columns'].includes(name)),
    scrollContract,
    layout,
    loadingLayout,
    filterRoundTrip,
    lazyLoadMore,
    domKeyboardMoved,
    domSelectionForwarded,
    staleRenderFenced,
    pseudoStates:pseudoSnapshot.states,
    sourceVisible,
    tabKeyboard,
    rulesRestored,
    treeIdentityStable:treeBefore===deepQuery(view.domRoot,'[role="tree"]'),
    selectedIdentityStable:selectedBefore?.isConnected===true,
    treeTextStable:treeTextBefore===treeBefore?.textContent,
    writerCalls,
    packagedBootstrap,
    performance:{navigationToReadyMs,loadMoreMs,rulesRefreshMs,sourceSwitchMs,totalMs,treeSnapshotCalls,rulesSnapshotCalls,rulesNotifications,finalStylesRevision:rulesPresentation.matchedStyles.stylesRevision,loadMoreCalls:treeCalls.loadMore.length},
    errors:[...errors,...window.pinOpInspectorSmokeErrors],
  };
  sourcePane.dispose();
  sourcePane.dispose();
  view.dispose();
  view.dispose();
  outsideFocus.remove();
  value.disposed=mount.childElementCount===0;
  value.cleanup={treeUnsubscribed,rulesUnsubscribed,pseudoUnsubscribed,sourceUnsubscribed};
  if (
    JSON.stringify(value.exports)!==JSON.stringify(['createElementsInspectorView']) ||
    !tags.includes('section') || !value.nativeDom || !value.nativeStyles ||
    value.initialPropertyRows!==282 || !value.hasNativeShowAll || value.origin!=='theme.scss:73' ||
    value.opened.join()!=='rule:scss' || !value.generatedFallback || !value.nativeColorSwatch ||
    !Object.values(value.shorthandCoverage).every(Boolean) || !Object.values(value.scrollContract).every(Boolean) ||
    value.loadingLayout.direction!=='column' || !value.loadingLayout.stacked || !value.loadingLayout.slotStable ||
    !value.filterRoundTrip || !value.lazyLoadMore || !value.domKeyboardMoved || !value.domSelectionForwarded || !value.staleRenderFenced ||
    value.pseudoStates.join()!=='hover' || !value.sourceVisible || !value.tabKeyboard || !value.rulesRestored ||
    !value.treeIdentityStable || !value.selectedIdentityStable || !value.treeTextStable ||
    value.writerCalls!==0 || value.performance.navigationToReadyMs>performanceBudget.navigationToReady || value.performance.loadMoreMs>performanceBudget.loadMore ||
    value.performance.rulesRefreshMs>performanceBudget.rulesRefresh || value.performance.sourceSwitchMs>performanceBudget.sourceSwitch || value.performance.totalMs>performanceBudget.total || value.performance.treeSnapshotCalls>operationBudget.treeSnapshotCalls ||
    value.performance.rulesSnapshotCalls>operationBudget.rulesSnapshotCalls || value.performance.rulesNotifications!==3 ||
    value.performance.finalStylesRevision!==3 || value.performance.loadMoreCalls!==1 ||
    !value.packagedBootstrap?.exactModules || !value.packagedBootstrap?.exactRulesOpen || !value.packagedBootstrap?.staleClickFenced || !value.packagedBootstrap?.invalidatedClickFenced ||
    value.errors.length || !value.disposed || treeUnsubscribed!==1 || rulesUnsubscribed!==1 || pseudoUnsubscribed!==1 || sourceUnsubscribed!==1
  ) {
    throw new Error('Native Inspector smoke invariant failed: '+JSON.stringify(value));
  }
  report({ok:true,value});
}).catch(error => {
  report({ok:false,error:error instanceof Error?error.message+'\\n'+(error.stack||''):String(error)});
});

function row(nodeRef,parentRef,depth,nodeType,nodeName,childCount,expanded,selected) {
  return {
    type:'node',nodeRef,parentRef,depth,expanded,expandable:childCount>0,
    selected,focused:selected,hovered:false,
    node:{
      nodeRef,kind:nodeType===10?'document-type':'element',nodeType,nodeName,
      attributes:nodeName==='BODY'?[{name:'class',value:'fixture'}]:[],childCount,
      relationship:'dom',selectable:nodeType===1,expandable:childCount>0,
      branchRevision:expanded?1:0,
    },
  };
}
function loadMoreRow(parentRef,depth,nodeRef,focused) {
  return {type:'load-more',nodeRef,parentRef,depth,expanded:false,expandable:false,selected:false,focused,hovered:false};
}
function declaration(declarationRef,name,value) {
  return {declarationRef,name,value,important:false,state:'winning-known-author'};
}
function writerTrapped(value) {
  return new Proxy(value,{get(target,key,receiver){
    if (writerNames.has(String(key))) { writerCalls+=1; throw new Error('Forbidden writer requested: '+String(key)); }
    return Reflect.get(target,key,receiver);
  }});
}
function deepQuery(root,selector) { return deepQueryAll(root,selector)[0]||null; }
function deepQueryAll(root,selector) {
  const found=[...root.querySelectorAll(selector)];
  const visit=node=>{
    if (node.shadowRoot) {
      found.push(...node.shadowRoot.querySelectorAll(selector));
      for (const child of node.shadowRoot.querySelectorAll('*')) visit(child);
    }
    for (const child of node.children||[]) visit(child);
  };
  visit(root);
  return [...new Set(found)];
}
function deepActiveElement(document) {
  let active=document.activeElement;
  while (active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
  return active;
}
function rect(node) {
  if (!node) return null;
  const value=node.getBoundingClientRect();
  return Object.fromEntries(['left','top','right','bottom','width','height'].map(key=>[key,Math.round(value[key]*100)/100]));
}
function transparent(color) {
  return color==='transparent'||color==='rgba(0, 0, 0, 0)'||color==='rgba(0,0,0,0)';
}
async function waitFor(predicate,label) {
  const deadline=performance.now()+15000;
  while (!predicate()) {
    if (performance.now()>=deadline) throw new Error('Timed out waiting for '+label+': '+window.pinOpInspectorSmokeErrors.join(' | '));
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.argv.includes("--both")
    ? "chrome+firefox"
    : process.argv.includes("--firefox") ? "firefox" : "chrome";
  const result = browser === "chrome+firefox"
    ? await smokeChromiumAndFirefoxReadOnlyInspectorRuntime()
    : browser === "firefox"
      ? await smokeFirefoxReadOnlyInspectorRuntime()
      : await smokeChromiumReadOnlyInspectorRuntime();
  console.log(
    `${browser.toUpperCase()}_NATIVE_CHROMIUM_INSPECTOR_OK ${JSON.stringify(result)}`,
  );
}
