import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {access, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  bundleChromiumReadOnlyStylesRuntime,
} from "./chromium-devtools-styles-runtime.mjs";
import {
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  openCdp,
  shutdownOwnedChildTree,
} from "./smoke-packaged-chrome.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 20_000;

export async function smokeChromiumReadOnlyStylesRuntime() {
  return await smokeReadOnlyStylesRuntime("chrome");
}

export async function smokeFirefoxReadOnlyStylesRuntime() {
  return await smokeReadOnlyStylesRuntime("firefox");
}

async function smokeReadOnlyStylesRuntime(browser) {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "pin-op-read-only-styles-"));
  const profileRoot = path.join(smokeRoot, "profile");
  const runtimePath = path.join(smokeRoot, "runtime.js");
  const appPath = path.join(smokeRoot, "app.js");
  const htmlPath = path.join(smokeRoot, "index.html");
  const elementsCssPath = path.join(
    repositoryRoot,
    "packages/devtools-elements-ui/assets/devtools-elements.css",
  );
  let chrome;
  let cdp;
  let server;
  let stderr = "";
  let reportBrowserResult;
  const browserResult = new Promise(resolve => {
    reportBrowserResult = resolve;
  });
  try {
    await bundleChromiumReadOnlyStylesRuntime({
      repositoryRoot,
      write: true,
      outfile: runtimePath,
    });
    await writeFile(appPath, smokeApplication(), "utf8");
    await writeFile(htmlPath, smokeHTML(), "utf8");
    server = createServer(async (request, response) => {
      if (request.url === "/result" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        reportBrowserResult(JSON.parse(body));
        response.statusCode = 204;
        response.end();
        return;
      }
      const file = request.url === "/runtime.js" ? runtimePath :
        request.url === "/app.js" ? appPath :
          request.url === "/devtools-elements.css" ? elementsCssPath : htmlPath;
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" :
        file.endsWith(".css") ? "text/css" : "text/html");
      response.end(await readFile(file));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke server has no TCP address");
    if (browser === "firefox") {
      const executable = await findFirefoxExecutable();
      chrome = spawn(
        executable,
        ["--headless", "--no-remote", "--profile", profileRoot,
          `http://127.0.0.1:${address.port}/?firefox=1`],
        {...buildChromeSpawnOptions(), env: {...process.env, MOZ_HEADLESS: "1"}},
      );
      chrome.stderr.setEncoding("utf8");
      chrome.stderr.on("data", chunk => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      const result = await waitForReportedBrowserResult(browserResult, chrome);
      if (!result?.ok) throw new Error(result?.error ?? "Firefox Styles smoke failed");
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
      if (stderr.length < 16_384) stderr += chunk;
    });
    const [portText, browserPath] = (await waitForPortFile(
      path.join(profileRoot, "DevToolsActivePort"),
      chrome,
    )).split(/\r?\n/);
    cdp = await openCdp(`ws://127.0.0.1:${Number(portText)}${browserPath}`);
    const {targetId} = await cdp.send("Target.createTarget", {url: "about:blank"});
    const {sessionId} = await cdp.send("Target.attachToTarget", {targetId, flatten: true});
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", {url: `http://127.0.0.1:${address.port}/`}, sessionId);
    const result = await pollResult(cdp, sessionId);
    if (!result?.ok) throw new Error(result?.error ?? "Chromium Styles smoke failed");
    return result.value;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${
      stderr.trim() ? `\nChrome stderr:\n${stderr.trim()}` : ""
    }`, {cause: error});
  } finally {
    await shutdownOwnedChildTree({child: chrome, cdp});
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(smokeRoot, {recursive: true, force: true, maxRetries: 4, retryDelay: 50});
  }
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
  throw new Error("Firefox was not found for the Chromium Styles smoke");
}

async function waitForReportedBrowserResult(resultPromise, child) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Firefox Styles result")), timeoutMs);
    resultPromise.then(result => {
      clearTimeout(timeout);
      resolve(result);
    }, reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Firefox exited before reporting Styles result (${code ?? signal})`));
    });
  });
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
  while (Date.now() < deadline) {
    const evaluation = await cdp.send("Runtime.evaluate", {
      expression: "window.pinOpStylesSmokeResult",
      returnByValue: true,
    }, sessionId);
    if (evaluation.result?.value) return evaluation.result.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: "({html:document.documentElement.outerHTML.slice(0,2000), errors:window.pinOpStylesSmokeErrors})",
    returnByValue: true,
  }, sessionId);
  throw new Error(`Timed out waiting for Styles smoke: ${JSON.stringify(evaluation.result?.value)}`);
}

function smokeHTML() {
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="./devtools-elements.css"><style>
    html,body,.pin-op-elements-inspector,#mount{height:100%;margin:0}
    #mount{grid-column:1/-1;grid-row:1/-1}
  </style><script>
    window.pinOpStylesSmokeErrors=[];
    const firefoxAutomation=new URLSearchParams(location.search).has('firefox');
    window.reportPinOpStylesSmoke=value=>{window.pinOpStylesSmokeResult=value;if(firefoxAutomation){fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}).catch(()=>{})}};
    addEventListener('error',e=>{const m=String(e.error?.stack||e.error||e.message);window.pinOpStylesSmokeErrors.push(m);window.reportPinOpStylesSmoke({ok:false,error:m})});
    addEventListener('unhandledrejection',e=>{const m=String(e.reason?.stack||e.reason);window.pinOpStylesSmokeErrors.push(m);window.reportPinOpStylesSmoke({ok:false,error:m})});
  </script></head><body><section class="pin-op-elements-inspector"><main id="mount" class="pin-op-elements-inspector__rules"></main></section><script type="module" src="./app.js"></script></body></html>`;
}

function smokeApplication() {
  return `
import * as Chromium from './runtime.js';

const mount = document.querySelector('#mount');
const opened = [];
const errors = [];

const pane = Chromium.chromiumReadOnlyStylesRuntime.createPane({
  document,
  mount,
  resolveOrigin: ruleRef => ({
    'rule:scss': {label: 'theme.scss', languageId: 'scss', startLine: 73, startColumn: 5,
      confidence: 'sourcemap', clickable: true},
    'rule:duplicate-a': {label: 'first.scss', languageId: 'scss', startLine: 11, startColumn: 1,
      confidence: 'sourcemap', clickable: true},
    'rule:duplicate-b': {label: 'second.scss', languageId: 'scss', startLine: 22, startColumn: 1,
      confidence: 'sourcemap', clickable: true},
    'rule:inherited-color': {label: 'inherited.scss', languageId: 'scss', startLine: 33, startColumn: 1,
      confidence: 'sourcemap', clickable: true},
    'rule:inherited-omitted': {label: 'omitted.scss', languageId: 'scss', startLine: 44, startColumn: 1,
      confidence: 'sourcemap', clickable: true},
  })[ruleRef],
  openOrigin: ruleRef => opened.push(ruleRef),
  onError: error => errors.push(String(error?.stack || error)),
});

const declarations = Array.from({length: 220}, (_, index) => ({
  declarationRef: 'decl:' + index,
  name: index === 0 ? 'color' : index === 1 ? 'margin' : index === 2 ? 'border' :
    index === 3 ? 'background' : index === 4 ? 'font' : index === 5 ? 'flex' : index === 6 ? 'grid' :
    index === 7 ? 'letter-spacing' : index === 8 ? 'outline-color' :
    index === 9 ? 'transition-timing-function' : index === 10 ? 'transition-property' :
    index === 11 ? 'width' : index === 12 ? 'caret-color' :
    index === 13 ? 'animation-timing-function' : index === 14 ? 'list-style-image' :
    index === 15 ? 'box-shadow' : index === 16 ? 'mask-image' :
    '--property-' + index,
  value: index === 0 ? 'rgb(255 0 0 / 75%)' : index === 1 ? '1px 2px 3px 4px' :
    index === 2 ? '2px solid rgb(0 128 0)' : index === 3 ? 'rgb(0 0 255)' :
    index === 4 ? 'italic 700 16px/1.5 Arial' : index === 5 ? '1 0 auto' :
    index === 6 ? 'auto-flow / 100px' : index === 7 ? '1.3em' : index === 8 ? 'currentcolor' :
    index === 9 ? 'ease' : index === 10 ? 'color, text-shadow' : index === 11 ? '12.5px' :
    index === 12 ? 'var(--brand-color, rebeccapurple)' :
    index === 13 ? 'cubic-bezier(0.42, 0, 0.58, 1)' :
    index === 14 ? 'url("images/card.png")' :
    index === 15 ? '1px 2px 4px 0 rgb(0 0 0 / 35%)' :
    index === 16 ? 'linear-gradient(45deg, red 0%, blue 100%)' : String(index),
  important: false,
  state: index === 0 ? 'winning-known-author' : index === 1 ? 'overridden-known-author' :
    index === 2 ? 'inactive' : index === 3 ? 'unknown' : 'winning-known-author',
}));
const snapshot = {
  documentEpoch: 1, selectionRevision: 1, stylesRevision: 1, stylesheetRevision: 1,
  pseudoStateRevision: 0, pseudoStates: [], nodeRef: 'node:one',
  matchedRules: [{
    ruleRef: 'rule:scss', selectorText: '.target:not(.a,.b), [data-value=",x"]',
    matchingSelectorIndices: [0], declarations, contexts: [
      {kind: 'media', text: '(min-width: 1px)'},
      {kind: 'supports', text: '(display: grid)'},
      {kind: 'layer', text: 'theme'},
      {kind: 'scope', text: '(.scope)'},
      {kind: 'container', text: '(inline-size > 1px)'},
      {kind: 'starting-style', text: ''},
    ],
    generatedSource: {label: 'style.css', lineNumber: 41, columnNumber: 2},
  }, {
    ruleRef: 'rule:duplicate-a', selectorText: '.duplicate', matchingSelectorIndices: [0],
    declarations: [declaration('dup:a', 'display', 'block')], contexts: [],
  }, {
    ruleRef: 'rule:duplicate-b', selectorText: '.duplicate', matchingSelectorIndices: [0],
    declarations: [declaration('dup:b', 'position', 'relative')], contexts: [],
  }, {
    ruleRef: 'rule:generated', selectorText: '.generated', matchingSelectorIndices: [0],
    declarations: [declaration('generated:one', 'opacity', '0.75')], contexts: [],
    generatedSource: {label: 'C:\\\\site\\\\plain.css'},
  }],
  inherited: [{
    ancestorIndex: 0, displayLabel: 'body.site-shell',
    matchedRules: [{
      ruleRef: 'rule:inherited-omitted', selectorText: '.inherited', matchingSelectorIndices: [0],
      declarations: [declaration('inherited:omitted', 'margin', '8px')], contexts: [],
    }, {
      ruleRef: 'rule:inherited-color', selectorText: '.inherited', matchingSelectorIndices: [0],
      declarations: [declaration('inherited:color', 'color', 'blue')], contexts: [],
    }],
  }], unsupportedRuleCount: 0, inaccessibleStylesheetCount: 0,
  approximateRuleCount: 0, omittedRuleCount: 0, diagnostics: [],
};
const emptySnapshot = {...snapshot, matchedRules: [], inherited: []};
await pane.render(emptySnapshot);
await waitFor(() => deepQuery(pane.element, '.styles-section'), 'empty-first native style section');
const emptyFirst = Boolean(deepQuery(pane.element, '.styles-section'));
const emptySection = deepQuery(pane.element, '.styles-section');
emptySection?.focus();
const outsideFocus = document.createElement('button');
outsideFocus.textContent = 'outside focus target';
document.body.append(outsideFocus);
const largeRender = pane.render(snapshot);
outsideFocus.focus();
await largeRender;
const externalFocusRetained = document.activeElement === outsideFocus;

await waitFor(() => deepQuery(pane.element, '.styles-section'), 'native Styles section');
const section = deepQuery(pane.element, '.styles-section');
const readOnlyPresentation = {
  sectionClassRetained: section?.classList.contains('read-only') === true,
  fontStyle: section ? getComputedStyle(section).fontStyle : undefined,
};
const origin = deepQuery(pane.element, '.pin-op-rule-origin');
const originStyle = origin ? getComputedStyle(origin) : undefined;
const originPresentation = {
  chromiumLinkClasses: Boolean(origin?.classList.contains('text-button') &&
    origin.classList.contains('link-style') && origin.classList.contains('devtools-link')),
  noNativeButtonChrome: Boolean(originStyle && originStyle.borderTopStyle === 'none' &&
    originStyle.paddingInlineStart === '0px' && originStyle.paddingInlineEnd === '0px' &&
    originStyle.marginInlineStart === '0px' && originStyle.marginInlineEnd === '0px'),
};
origin?.click();
pane.refreshOrigins();
origin?.click();
const staleOriginListenerAborted = opened.length === 1;
const showAll = deepQuery(pane.element, '.styles-show-all');
showAll?.click();
await waitFor(() => deepQueryAll(pane.element, '.webkit-css-property').length === 224, '224 native property rows');
const colorName = deepQueryAll(pane.element, '.webkit-css-property').find(node => node.textContent === 'color');
const colorRow = colorName?.closest('li');
const lazyColorBeforeScroll = !(colorRow && deepQuery(colorRow, 'devtools-color-swatch'));
colorRow?.scrollIntoView({block: 'nearest'});
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
await waitFor(() => colorRow && deepQuery(colorRow, 'devtools-color-swatch'), 'native lazy color swatch');
const colorValue = colorRow && deepQuery(colorRow, '.value');
const colorSwatch = colorRow && deepQuery(colorRow, 'devtools-color-swatch');
const readonlySwatch = colorSwatch?.shadowRoot?.querySelector('.color-swatch.readonly');
const expectedExactValues = {
  'letter-spacing': '1.3em',
  'outline-color': 'currentcolor',
  'transition-timing-function': 'ease',
  'transition-property': 'color, text-shadow',
  width: '12.5px',
  'caret-color': 'var(--brand-color, rebeccapurple)',
  'animation-timing-function': 'cubic-bezier(0.42, 0, 0.58, 1)',
  'list-style-image': 'url("images/card.png")',
  'box-shadow': '1px 2px 4px 0 rgb(0 0 0 / 35%)',
  'mask-image': 'linear-gradient(45deg, red 0%, blue 100%)',
};
const exactRenderedValues = {};
const exactValueRows = {};
for (const name of Object.keys(expectedExactValues)) {
  const nameElement = deepQueryAll(pane.element, '.webkit-css-property')
    .find(node => node.textContent === name);
  const row = nameElement?.closest('li');
  row?.scrollIntoView({block: 'nearest'});
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await waitFor(() => deepQuery(row, '.value'), 'native exact value for ' + name);
  exactValueRows[name] = row;
  exactRenderedValues[name] = deepQuery(row, '.value')?.innerText;
}
const rendererEvidence = {
  variablePlainText: !deepQuery(exactValueRows['caret-color'], 'devtools-link-swatch.css-var-link') &&
    exactRenderedValues['caret-color'] === expectedExactValues['caret-color'],
  lengthStructured: Boolean(deepQuery(exactValueRows.width, '.value > span')),
  easingStructured: Boolean(deepQuery(exactValueRows['animation-timing-function'], '.value > span')),
  shadowColorSwatch: Boolean(deepQuery(exactValueRows['box-shadow'], 'devtools-color-swatch')),
  gradientColorSwatches: deepQueryAll(exactValueRows['mask-image'], 'devtools-color-swatch').length,
};
const readOnlyRendererSafety = {
  noBezierEditor: !deepQuery(exactValueRows['animation-timing-function'], '.bezier-swatch-icon'),
  noShadowEditor: !deepQuery(exactValueRows['box-shadow'], 'devtools-css-shadow-swatch'),
  noLengthPopover: !deepQuery(exactValueRows.width, 'devtools-tooltip'),
  urlIsPlainText: !deepQuery(exactValueRows['list-style-image'], 'a'),
};
const shorthandExpectations = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  border: ['border-top-width', 'border-right-style', 'border-bottom-color'],
  background: ['background-color', 'background-image'],
  font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  grid: ['grid-template-rows', 'grid-template-columns'],
};
let expandIcon;
for (const [shorthand, expectedLonghands] of Object.entries(shorthandExpectations)) {
  const shorthandName = deepQueryAll(pane.element, '.webkit-css-property')
    .find(node => node.textContent === shorthand);
  const shorthandRow = shorthandName?.closest('li');
  const icon = shorthandRow && deepQuery(shorthandRow, '.expand-icon');
  if (shorthand === 'margin') expandIcon = icon;
  icon?.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true}));
  await waitFor(() => expectedLonghands.every(name =>
    deepQueryAll(pane.element, '.webkit-css-property').some(node => node.textContent === name)),
  'native ' + shorthand + ' longhands');
}
const shorthandCoverage = Object.fromEntries(Object.entries(shorthandExpectations).map(([shorthand, expected]) => [
  shorthand,
  expected.every(name => deepQueryAll(pane.element, '.webkit-css-property').some(node => node.textContent === name)),
]));
const shorthandLonghands = deepQueryAll(pane.element, '.webkit-css-property')
  .map(node => node.textContent).filter(name => name === 'margin' || name?.startsWith('margin-'));
const contextHosts = deepQueryAll(pane.element, 'pin-op-readonly-css-query');
const contextOrderWithoutLayer = contextHosts.map(host =>
  host.shadowRoot?.querySelector('.query')?.textContent?.replace(/\\s+/g, ' ').trim());
const layerText = deepQuery(pane.element, '.layer-separator')?.textContent?.replace(/\\s+/g, ' ').trim();
const contextOrder = [
  contextOrderWithoutLayer[0],
  contextOrderWithoutLayer[1],
  layerText === 'Layer theme' || layerText === 'Layertheme' ? '@layer theme {' : layerText,
  ...contextOrderWithoutLayer.slice(2),
];
const origins = deepQueryAll(pane.element, '.styles-section-subtitle').map(node => node.textContent?.trim()).filter(Boolean);
const inheritedLabel = deepQuery(pane.element, '.pin-op-inherited-node-label')?.textContent;
const root = document.documentElement;
const lightTokens = {
  sysColor: getComputedStyle(root).getPropertyValue('--sys-color-on-surface').trim(),
  appColor: getComputedStyle(root).getPropertyValue('--app-color-element-sidebar-subtitle').trim(),
  size: getComputedStyle(root).getPropertyValue('--sys-size-6').trim(),
};
root.classList.add('theme-with-dark-background');
const darkTokens = {
  sysColor: getComputedStyle(root).getPropertyValue('--sys-color-on-surface').trim(),
  appColor: getComputedStyle(root).getPropertyValue('--app-color-element-sidebar-subtitle').trim(),
};
root.classList.remove('theme-with-dark-background');
const iconEvidence = icon => {
  const glyph = icon && deepQuery(icon, '.pin-op-icon-glyph');
  const style = glyph && getComputedStyle(glyph);
  const rect = icon?.getBoundingClientRect();
  return Boolean(icon && glyph && rect.width > 0 && rect.height > 0 &&
    (style.maskImage || style.webkitMaskImage) !== 'none');
};
const visibleIcons = {
  disclosure: iconEvidence(expandIcon),
  filter: iconEvidence(deepQuery(pane.element, '.pin-op-filter-icon')),
  origin: iconEvidence(deepQuery(pane.element, '.pin-op-rule-origin-icon')),
};
const toolbarFilter = deepQuery(pane.element, '.toolbar-input.toolbar-filter');
const toolbarPrompt = deepQuery(toolbarFilter, '.toolbar-input-prompt.text-prompt');
const toolbarButtons = deepQueryAll(toolbarFilter, 'devtools-button.pin-op-toolbar-icon-button');
const toolbarFilterStyle = toolbarFilter ? getComputedStyle(toolbarFilter) : undefined;
const toolbarControlEvidence = {
  prompt: Boolean(toolbarPrompt?.isContentEditable &&
    toolbarPrompt.getAttribute('data-placeholder') === 'Filter'),
  noNativeInput: !deepQuery(toolbarFilter, 'input'),
  iconButtons: toolbarButtons.length === 2 && toolbarButtons.every(button =>
    Boolean(deepQuery(button, 'svg[viewBox="0 0 20 20"] path'))),
  chromiumFlex: Boolean(toolbarFilterStyle && toolbarFilterStyle.flexGrow === '1' &&
    toolbarFilterStyle.flexShrink === '1'),
  chromiumShape: Boolean(toolbarFilterStyle && toolbarFilterStyle.boxSizing === 'border-box' &&
    toolbarFilterStyle.borderRadius === '100px' && toolbarFilterStyle.minWidth === '35px'),
  fillsToolbar: Boolean(toolbarFilter && toolbarFilter.getBoundingClientRect().width > 120),
  emptyClearHidden: Boolean(toolbarButtons[0] && getComputedStyle(toolbarButtons[0]).display === 'none'),
};
const scrollOwner = pane.element;
const stickyToolbar = deepQuery(pane.element, '.styles-sidebar-pane-toolbar-container');
const stickyTopBefore = stickyToolbar?.getBoundingClientRect().top;
const hasScrollRange = scrollOwner.scrollHeight > scrollOwner.clientHeight;
scrollOwner.scrollTop = scrollOwner.scrollHeight;
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const stickyTopAfter = stickyToolbar?.getBoundingClientRect().top;
const lastProperty = deepQueryAll(pane.element, '.webkit-css-property').at(-1);
lastProperty?.scrollIntoView({block: 'nearest'});
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const lastRect = lastProperty?.getBoundingClientRect();
const ownerRect = scrollOwner.getBoundingClientRect();
const scrollContract = {
  hasScrollRange,
  moved: scrollOwner.scrollTop > 0,
  lastVisible: Boolean(lastRect && lastRect.top >= ownerRect.top && lastRect.bottom <= ownerRect.bottom + 1),
  sticky: typeof stickyTopBefore === 'number' && typeof stickyTopAfter === 'number' &&
    Math.abs(stickyTopBefore - stickyTopAfter) <= 1,
};
toolbarPrompt.textContent = 'definitely-not-a-style';
toolbarPrompt.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
const noMatches = deepQuery(pane.element, '.gray-info-message');
await waitFor(() => noMatches && !noMatches.classList.contains('hidden'), 'native no-matches filter state');
toolbarButtons[0]?.click();
await waitFor(() => noMatches?.classList.contains('hidden'), 'native filter reset');
const lineBreakEvent = new InputEvent('beforeinput', {
  bubbles: true,
  cancelable: true,
  inputType: 'insertParagraph',
});
const lineBreakBlocked = !toolbarPrompt.dispatchEvent(lineBreakEvent) && lineBreakEvent.defaultPrevented;
toolbarPrompt.textContent = 'color\\nbackground';
toolbarPrompt.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
const singleLine = toolbarPrompt.textContent === 'color background';
toolbarButtons[0]?.click();
await waitFor(() => noMatches?.classList.contains('hidden'), 'native normalized filter reset');
toolbarButtons[1]?.click();
const toolbarBehaviorEvidence = {
  clear: toolbarPrompt.textContent === '',
  lineBreakBlocked,
  singleLine,
  regexToggle: toolbarButtons[1]?.getAttribute('aria-pressed') === 'true',
};
const visibleSections = deepQueryAll(pane.element, '.styles-section').filter(node => !node.classList.contains('hidden'));
visibleSections[0]?.focus();
visibleSections[0]?.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, composed: true}));
await waitFor(() => deepActiveElement(document) === visibleSections[1], 'native section keyboard navigation');
const keyboardMoved = deepActiveElement(document) === visibleSections[1];
const propertyRows = deepQueryAll(pane.element, '.webkit-css-property').length;
const nativeTreeItems = deepQueryAll(pane.element, 'li').length;
const focusedBeforeEmpty = deepActiveElement(document);
await pane.render(emptySnapshot);
await waitFor(() => deepQueryAll(pane.element, '.styles-section').length === 1, 'focused-to-empty section');
const focusedToEmpty = Boolean(focusedBeforeEmpty && !focusedBeforeEmpty.isConnected &&
  deepActiveElement(document)?.isConnected);
await pane.render(snapshot);
await waitFor(() => deepQuery(pane.element, '.pin-op-rule-origin'), 'empty-to-nonempty origin');
const emptyToNonempty = Boolean(deepQuery(pane.element, '.styles-section') &&
  deepQuery(pane.element, '.pin-op-rule-origin'));
const stable = mount.children.length === 1 && mount.children[0] === pane.element;
const value = {
  stable,
  directChild: pane.element.parentElement === mount,
  selector: deepQuery(pane.element, '.selector')?.textContent,
  origin: origin?.textContent,
  opened,
  propertyRows,
  nativeTreeItems,
  structuredColor: Boolean(colorValue && colorValue.childNodes.length > 1),
  lazyColorBeforeScroll,
  colorValueHTML: colorValue?.innerHTML,
  colorValueText: colorValue?.textContent,
  colorValueInnerText: colorValue?.innerText,
  colorValueChildren: colorValue?.childNodes.length,
  nativeColorSwatch: colorSwatch?.localName === 'devtools-color-swatch',
  readonlyColorSwatch: readonlySwatch instanceof HTMLElement,
  exactRenderedValues,
  rendererEvidence,
  readOnlyRendererSafety,
  readOnlyPresentation,
  originPresentation,
  shorthandLonghands,
  shorthandCoverage,
  contextOrder,
  inheritedLabel,
  lightTokens,
  darkTokens,
  visibleIcons,
  toolbarControlEvidence,
  toolbarBehaviorEvidence,
  scrollContract,
  emptyFirst,
  externalFocusRetained,
  staleOriginListenerAborted,
  focusedToEmpty,
  emptyToNonempty,
  origins,
  keyboardMoved,
  filterRoundTrip: noMatches?.classList.contains('hidden') === true,
  errors: [...errors, ...window.pinOpStylesSmokeErrors],
  hasNativeSection: section instanceof HTMLElement,
  hasNativeShowAll: showAll instanceof HTMLElement,
};
pane.dispose();
value.disposed = !pane.element.isConnected;
value.mountStyleRestored = mount.style.display === '' && mount.style.height === '' &&
  mount.style.minHeight === '' && mount.style.overflow === '';
outsideFocus.remove();
for (let index = 0; index < 3; index++) {
  const cyclePane = Chromium.chromiumReadOnlyStylesRuntime.createPane({
    document, mount, resolveOrigin: () => undefined, openOrigin: () => {},
    onError: error => errors.push(String(error?.stack || error)),
  });
  await cyclePane.render({...snapshot, matchedRules: [snapshot.matchedRules[1]], inherited: []});
  cyclePane.dispose();
}
value.repeatedDispose = mount.children.length === 0;
value.errors = [...errors, ...window.pinOpStylesSmokeErrors];
const expectedContextOrder = [
  '@media (min-width: 1px) {',
  '@supports (display: grid) {',
  '@layer theme {',
  '@scope (.scope) {',
  '@container (inline-size > 1px) {',
  '@starting-style {',
];
if (!value.stable || !value.directChild || !value.hasNativeSection || !value.hasNativeShowAll || value.origin !== 'theme.scss:73' ||
    value.opened.join() !== 'rule:scss' || propertyRows <= 228 || !value.lazyColorBeforeScroll || !value.structuredColor || !value.nativeColorSwatch ||
    !value.readonlyColorSwatch || value.shorthandLonghands.length !== 5 ||
    value.colorValueText !== 'rgb(255 0 0 / 75%)' ||
    JSON.stringify(value.exactRenderedValues) !== JSON.stringify(expectedExactValues) ||
    !value.rendererEvidence.variablePlainText || !value.rendererEvidence.lengthStructured ||
    !value.rendererEvidence.easingStructured || !value.rendererEvidence.shadowColorSwatch ||
    value.rendererEvidence.gradientColorSwatches < 2 ||
    !Object.values(value.readOnlyRendererSafety).every(Boolean) ||
    !value.readOnlyPresentation.sectionClassRetained || value.readOnlyPresentation.fontStyle !== 'normal' ||
    !Object.values(value.originPresentation).every(Boolean) ||
    !Object.values(value.shorthandCoverage).every(Boolean) || JSON.stringify(value.contextOrder) !== JSON.stringify(expectedContextOrder) ||
    value.inheritedLabel !== 'body.site-shell' || !value.lightTokens.sysColor || !value.lightTokens.appColor ||
    value.lightTokens.size !== '12px' || value.lightTokens.sysColor === value.darkTokens.sysColor ||
    value.lightTokens.appColor === value.darkTokens.appColor || !Object.values(value.visibleIcons).every(Boolean) ||
    !Object.values(value.toolbarControlEvidence).every(Boolean) ||
    !Object.values(value.toolbarBehaviorEvidence).every(Boolean) ||
    !Object.values(value.scrollContract).every(Boolean) || !value.keyboardMoved || !value.filterRoundTrip ||
    !value.emptyFirst || !value.externalFocusRetained || !value.staleOriginListenerAborted ||
    !value.focusedToEmpty || !value.emptyToNonempty || !value.mountStyleRestored ||
    !value.origins.includes('first.scss:11') || !value.origins.includes('second.scss:22') ||
    !value.origins.includes('inherited.scss:33') || value.origins.includes('omitted.scss:44') ||
    !value.origins.includes('plain.css') || value.origins.includes('plain.css:1') ||
    !value.disposed || !value.repeatedDispose || value.errors.length) {
  throw new Error('Styles smoke invariant failed: ' + JSON.stringify(value));
}
window.reportPinOpStylesSmoke({ok:true, value});

function deepQuery(root, selector) { return deepQueryAll(root, selector)[0] || null; }
function deepQueryAll(root, selector) {
  const found = [...root.querySelectorAll(selector)];
  const visit = node => {
    if (node.shadowRoot) {
      found.push(...node.shadowRoot.querySelectorAll(selector));
      for (const child of node.shadowRoot.querySelectorAll('*')) visit(child);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return [...new Set(found)];
}
function deepActiveElement(doc) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
function declaration(declarationRef, name, value) {
  return {declarationRef, name, value, important: false, state: 'winning-known-author'};
}
async function waitFor(predicate, label) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for ' + label + ': ' + errors.join(' | '));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
`.replace(
    "const nativeConstructors = pane.element && Chromium.StylesSidebarPane.prototype.isPrototypeOf(\n  pane.element.__pinOpPaneForTest || Object.getPrototypeOf(pane.element));\n",
    "",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const firefox = process.argv.includes("--firefox");
  const result = firefox ? await smokeFirefoxReadOnlyStylesRuntime() : await smokeChromiumReadOnlyStylesRuntime();
  console.log(`${firefox ? "FIREFOX" : "CHROMIUM"}_READ_ONLY_STYLES_OK ${JSON.stringify(result)}`);
}
