// End-to-end Inspector smoke over the real extension. Exercises the panel the
// way a person does -- arm the picker, click the page, click a row, open a row
// by its disclosure triangle -- and holds the result to the contract the panel
// is supposed to keep.
//
//   node tools/smoke-inspector-extension.mjs
//   node tools/smoke-inspector-extension.mjs --workspace examples/basic-css
//   node tools/smoke-inspector-extension.mjs --url http://localhost/site/ //     --pick "#heading" --branch "content_block" --triangle "block_cnt"
//
// Without --url the bundled example fixture is served on loopback. With
// --workspace the IDE side is launched too, so Rules source links are covered.
// Another page needs its own targets: --pick selects the element to click,
// --branch the tree row to select, --triangle the row to open or close.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEEP_QUERY_SOURCE,
  PANEL_CONSOLE_RECORDER,
  TREE_ROWS_SOURCE,
  delay,
  launchInspectorExtension,
} from "./inspector-extension-driver.mjs";
import { startExampleServers } from "../examples/basic-css/server.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ceilings, not targets. The example fixture settles an ordinary pick in about
 * a third of a second; these leave room for a loaded CI machine while still
 * failing on the kind of regression that makes the panel feel broken.
 */
/** The pane a run of row clicks is measured in: short, like a real toolbox. */
const SHORT_PANE = Object.freeze({ width: 700, height: 220 });

export const INSPECTOR_INTERACTION_BUDGET = Object.freeze({
  pickLatencyMs: 4_000,
  rowSelectionLatencyMs: 4_000,
  suspensionRecoveryMs: 15_000,
});

/**
 * The panel contract this smoke defends, each line a defect that reached a
 * user: a picker that stayed armed and swallowed the next page click, blank
 * rows for whitespace text nodes, a reveal that left "Load more" over every
 * hidden sibling, Chromium adorners Pin-op cannot service, and panels that
 * emptied themselves once the browser suspended the idle background page.
 */
export function assertInspectorInteractionSnapshot(
  snapshot,
  { requireSourceOrigins = false } = {},
) {
  requireRecord(snapshot, "Inspector interaction snapshot");

  const pick = requireRecord(snapshot.pick, "Inspector pick result");
  if (pick.selected !== pick.hit) {
    throw new Error(
      `Inspector picked ${describe(pick.selected)} where the page shows ${describe(pick.hit)}`,
    );
  }
  if (pick.pickerArmedAfterPick !== false) {
    throw new Error("Inspector picker stayed armed after a pick");
  }
  requireWithinBudget(pick.latencyMs, INSPECTOR_INTERACTION_BUDGET.pickLatencyMs, "pick");

  const tree = requireRecord(snapshot.tree, "Inspector tree result");
  if (tree.whitespaceRows !== 0) {
    throw new Error(`Inspector tree shows ${tree.whitespaceRows} whitespace-only rows`);
  }
  if (tree.loadMoreRows !== 0) {
    throw new Error(
      `Inspector tree left ${tree.loadMoreRows} "Load more" rows over revealed siblings`,
    );
  }
  if (!(tree.rowCount > 1)) {
    throw new Error("Inspector tree never rendered the revealed document");
  }
  if (tree.rowCursor !== "default" || !/^(default|absent)(,(default|absent))*$/.test(String(tree.labelCursor))) {
    throw new Error(
      `Inspector tree rows do not carry a pointer arrow (row ${tree.rowCursor}, label ${tree.labelCursor})`,
    );
  }
  if (tree.adornerDisplay !== "none" && tree.adornerDisplay !== "absent") {
    throw new Error(`Inspector tree presents Chromium adorners (${tree.adornerDisplay})`);
  }

  // A row can be selected and still look unselected: Chromium paints its
  // selection band behind the row, which the panel's own surface hid.
  const band = requireRecord(snapshot.selectionBand, "Inspector selection band");
  if (!band.displayed) {
    throw new Error("The selected row paints no selection band");
  }
  if (!(band.width > 0 && band.height > 0)) {
    throw new Error(`The selection band has no size (${band.width}x${band.height})`);
  }
  if (band.transparent) {
    throw new Error(`The selection band is transparent (${describe(band.background)})`);
  }
  if (!band.paintsAbovePanelSurface) {
    throw new Error("The selection band is painted behind the panel's own surface");
  }

  const rowSelection = requireRecord(snapshot.rowSelection, "Inspector row selection result");
  if (rowSelection.selected !== rowSelection.clicked) {
    throw new Error(
      `Clicking ${describe(rowSelection.clicked)} selected ${describe(rowSelection.selected)}`,
    );
  }
  requireWithinBudget(
    rowSelection.latencyMs,
    INSPECTOR_INTERACTION_BUDGET.rowSelectionLatencyMs,
    "row selection",
  );

  // Selecting a row used to re-centre the tree, so the reader's next click
  // landed two rows away. Clicking a run of rows from one measurement is the
  // only way to see that.
  const rowRun = requireRecord(snapshot.rowRun, "Inspector row run result");
  const missed = (rowRun.clicks ?? []).filter((click) => !click.hit);
  if (missed.length > 0) {
    throw new Error(
      `Clicking ${describe(missed[0].aimedAt)} selected ${describe(missed[0].selected)}`,
    );
  }
  if (!((rowRun.clicks ?? []).length >= 2)) {
    throw new Error("Inspector row run never clicked a second row");
  }
  if (!(rowRun.maxRowShiftPx <= 2)) {
    throw new Error(
      `Selecting a row moved the tree ${rowRun.maxRowShiftPx}px under the cursor`,
    );
  }

  const disclosure = requireRecord(snapshot.disclosure, "Inspector disclosure result");
  if (disclosure.expandedBefore === disclosure.expandedAfter) {
    throw new Error("The disclosure triangle did not open or close the row");
  }

  const suspension = requireRecord(snapshot.suspension, "Inspector suspension result");
  if (suspension.selectedAfter !== suspension.selectedBefore) {
    throw new Error(
      `Suspending the background moved the selection from ${describe(suspension.selectedBefore)} to ${describe(suspension.selectedAfter)}`,
    );
  }
  // Recovery rebuilds the tree from stable locators, so the row count can land
  // a little either side of what it was; what it must never do is come back
  // empty.
  if (!(suspension.rowsAfter > 1)) {
    throw new Error(
      `Suspending the background cleared the tree (${suspension.rowsBefore} rows to ${suspension.rowsAfter})`,
    );
  }
  if (!(suspension.sectionsAfter >= suspension.sectionsBefore)) {
    throw new Error(
      `Suspending the background cleared Rules (${suspension.sectionsBefore} sections to ${suspension.sectionsAfter})`,
    );
  }
  requireWithinBudget(
    suspension.recoveryMs,
    INSPECTOR_INTERACTION_BUDGET.suspensionRecoveryMs,
    "suspension recovery",
  );

  // A Chrome-only DOM call once threw out of every tree click in Gecko, and
  // nothing failed except the feature: the panel's own log is a gate.
  const thrown = (snapshot.panelLog ?? []).filter((entry) => (
    typeof entry === "string" && (entry.startsWith("error") || entry.startsWith("rejection"))
  ));
  if (thrown.length > 0) {
    throw new Error(`The Inspector panel threw during the run: ${thrown[0]}`);
  }

  const sources = snapshot.sources;
  if (requireSourceOrigins) {
    requireRecord(sources, "Inspector source origins");
    if (!(sources.resolvedRuleCount > 0)) {
      throw new Error("No Rules row resolved to a workspace source");
    }
  }
  return snapshot;
}

export async function runInspectorExtensionSmoke({
  url,
  browser = "chrome",
  extensionDirectory = join(repositoryRoot, "extensions", browser),
  workspace,
  pickSelector = "#fixture-card",
  branchNeedle = "class=",
  triangleNeedle = branchNeedle,
} = {}) {
  if (browser !== "chrome" && browser !== "firefox") {
    throw new Error(`Inspector smoke does not know the browser ${browser}`);
  }
  // Ephemeral ports: a smoke that crashed earlier must not block the next run.
  const servers = url
    ? undefined
    : await startExampleServers({ pagePort: 0, vendorPort: 0 });
  const pageUrl = url ?? servers.pageUrl;
  const ide = workspace ? await startIde(workspace) : undefined;
  const session = await launchBrowser(browser, { extensionDirectory, pageUrl });
  try {
    if (ide) await linkPanel(session, ide.linkCode);
    const snapshot = {};
    try {
      await collectInteractionSnapshot(session, snapshot, {
        pickSelector,
        branchNeedle,
        triangleNeedle,
        linked: Boolean(ide),
      });
    } catch (error) {
      // Whatever was measured before the step that broke is what makes the
      // failure actionable, and so is whatever the panel logged meanwhile.
      snapshot.pageUrl = pageUrl;
      snapshot.linked = Boolean(ide);
      snapshot.browser = browser;
      snapshot.panelLog = await readPanelLog(session);
      console.error(`INSPECTOR_EXTENSION_FAIL ${JSON.stringify(snapshot)}`);
      throw error;
    }
    snapshot.pageUrl = pageUrl;
    snapshot.linked = Boolean(ide);
    snapshot.browser = browser;
    snapshot.panelLog = await readPanelLog(session);
    return snapshot;
  } finally {
    await session.close();
    await ide?.stop();
    await servers?.stop();
  }
}

async function collectInteractionSnapshot(session, snapshot, {
  pickSelector,
  branchNeedle,
  triangleNeedle,
  linked,
}) {
  const { panel, site } = session;

  await armPicker(session);
  const spot = await session.json(site, pointExpression(pickSelector));
  if (spot.error) {
    throw new Error(`Inspector smoke cannot pick ${pickSelector}: ${spot.error}`);
  }
  const pickStarted = Date.now();
  await session.click(site, spot.x, spot.y);
  const picked = await waitForSelection(session, undefined);
  snapshot.pick = {
    hit: spot.hit,
    selected: picked.selectedElement,
    latencyMs: Date.now() - pickStarted,
    pickerArmedAfterPick: picked.pickerArmed,
  };

  await settleTree(session);
  // Source origins belong to the picked element: read them before the later
  // interactions move the selection somewhere with no mapped rules.
  snapshot.sources = await readSourceOrigins(session, linked);
  const tree = await session.json(panel, treeStateExpression());
  snapshot.tree = {
    rowCount: tree.rowCount,
    whitespaceRows: tree.whitespaceRows,
    loadMoreRows: tree.loadMoreRows,
    adornerDisplay: tree.adornerDisplay,
    rowCursor: tree.rowCursor,
    labelCursor: tree.labelCursor,
  };

  snapshot.selectionBand = await session.json(panel, selectionBandExpression());

  snapshot.suspension = await surviveBackgroundSuspension(session);
  // Recovery re-reveals the branches it restored; let them land before the
  // interactions below measure a row rectangle.
  await settleTree(session);

  // Before the disclosure step collapses a branch: the run needs the tall tree.
  snapshot.rowRun = await clickRowRun(session);
  await session.setPanelViewport(session.viewport);
  await settleTree(session);

  const row = await session.json(
    panel,
    rowRectExpression(branchNeedle, false, { skipSelected: true }),
  );
  if (row.error) throw new Error(`Inspector smoke found no collapsible row: ${row.error}`);
  const rowStarted = Date.now();
  const beforeRowClick = await session.json(panel, selectionExpression());
  const rowX = Math.round(row.left + Math.min(140, Math.max(20, row.width / 2)));
  // Recorded before the wait: a click that selects nothing has to say what it
  // aimed at to be worth anything.
  snapshot.rowSelection = { clicked: row.element, clickedX: rowX, clickedY: Math.round(row.top) };
  await session.click(panel, rowX, Math.round(row.top + row.height / 2));
  const rowSelected = await waitForSelection(session, beforeRowClick.selectedElement);
  snapshot.rowSelection.selected = rowSelected.selectedElement;
  snapshot.rowSelection.latencyMs = Date.now() - rowStarted;

  // The selection re-reveals the tree, so let the rows stop moving before
  // measuring a triangle: a stale rectangle clicks the row above or below.
  await settleTree(session);
  const branch = await session.json(panel, rowRectExpression(triangleNeedle, true));
  if (branch.error) throw new Error(`Inspector smoke found no branch row: ${branch.error}`);
  await session.click(panel, Math.round(branch.triangleX), Math.round(branch.top + branch.height / 2));
  await delay(700);
  // Re-find the very row that was clicked: the needle alone can land on a
  // different row once the toggle re-lays out the tree, which reads as "nothing
  // happened" when something did.
  const afterBranch = await session.json(panel, markedRowExpandedExpression());
  snapshot.disclosure = {
    row: branch.element,
    rowLeft: Math.round(branch.left),
    clickedX: Math.round(branch.triangleX),
    expandedBefore: branch.expanded,
    expandedAfter: afterBranch.found ? afterBranch.expanded : branch.expanded,
  };
}

/**
 * What the selected row actually paints. The band sits behind its row at
 * `z-index: -1`, so it only shows while its own stacking context lives inside
 * the tree -- outside it, the panel's surface covers it and the row looks
 * unselected however correct the state is.
 */
function selectionBandExpression() {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const selected = rows.find((row) => row.classList.contains("selected"));
    const band = selected ? selected.querySelector(".selection") : null;
    if (!band) return JSON.stringify({ displayed: false, width: 0, height: 0 });
    const style = getComputedStyle(band);
    const rect = band.getBoundingClientRect();
    const formsStackingContext = (element, elementStyle) => (
      element === document.documentElement ||
      (elementStyle.position !== "static" && elementStyle.zIndex !== "auto") ||
      elementStyle.position === "fixed" ||
      elementStyle.position === "sticky" ||
      Number.parseFloat(elementStyle.opacity) < 1 ||
      elementStyle.isolation === "isolate" ||
      elementStyle.transform !== "none" ||
      elementStyle.filter !== "none" ||
      elementStyle.perspective !== "none" ||
      (elementStyle.mixBlendMode && elementStyle.mixBlendMode !== "normal") ||
      elementStyle.willChange.includes("transform") ||
      elementStyle.willChange.includes("opacity") ||
      elementStyle.contain.includes("layout") ||
      elementStyle.contain.includes("paint")
    );
    let root = band.parentElement;
    while (root && !formsStackingContext(root, getComputedStyle(root))) {
      root = root.parentElement ?? (root.getRootNode() || {}).host ?? null;
    }
    return JSON.stringify({
      displayed: style.display !== "none" && style.visibility !== "hidden",
      background: style.backgroundColor,
      transparent: style.backgroundColor === "rgba(0, 0, 0, 0)" ||
        style.backgroundColor === "transparent",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      paintsAbovePanelSurface: Boolean(root && outline.contains(root)),
    });
  })()`;
}

/**
 * Clicks a run of rows from one measurement, the way a reader does: aim, click,
 * aim at the next row where it still appears to be. A tree that re-lays itself
 * out under the cursor fails here and nowhere else.
 */
async function clickRowRun(session, pane = SHORT_PANE) {
  // A tree that fits its pane cannot scroll, and a re-centring bug hides there.
  // Real DevTools panels are short; measure the run in one.
  await session.setPanelViewport(pane);
  await settleTree(session);
  const aimed = await session.json(session.panel, clickableRowsExpression(4));
  const clicks = [];
  let maxRowShiftPx = 0;
  for (const row of aimed) {
    await session.click(session.panel, row.x, row.y);
    await delay(900);
    const state = await session.json(session.panel, rowRunStateExpression(row.probe));
    clicks.push({
      aimedAt: row.label,
      selected: state.selected,
      hit: state.selectedProbe === row.probe,
    });
    if (Number.isFinite(state.rowTop) && Number.isFinite(row.top)) {
      maxRowShiftPx = Math.max(maxRowShiftPx, Math.abs(state.rowTop - row.top));
    }
  }
  return { clicks, maxRowShiftPx: Math.round(maxRowShiftPx), pane };
}

/** Rows a click can actually reach, marked so they stay identifiable. */
function clickableRowsExpression(limit) {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const topmostAt = (x, y) => {
      let node = document.elementFromPoint(x, y);
      while (node && node.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      return node;
    };
    const reachable = [];
    for (const row of rows) {
      if (row.classList.contains("selected")) continue;
      // A closing-tag row selects the element its opening row does, which reads
      // as a miss without being one.
      if (rowLabel(row).startsWith("</")) continue;
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const x = Math.round(rect.left + Math.min(120, Math.max(20, rect.width / 2)));
      const y = Math.round(rect.top + rect.height / 2);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (!row.contains(topmostAt(x, y))) continue;
      reachable.push({ row, x, y, top: Math.round(rect.top) });
    }
    // From the middle of the pane outwards: a row at the very top cannot be
    // scrolled up, so centring it moves nothing and proves nothing.
    const start = Math.max(0, Math.floor(reachable.length / 2) - 1);
    const picked = [];
    for (const candidate of reachable.slice(start)) {
      const probe = "run-" + picked.length;
      candidate.row.dataset.pinOpRunRow = probe;
      picked.push({
        probe,
        label: rowLabel(candidate.row).slice(0, 40),
        x: candidate.x,
        y: candidate.y,
        top: candidate.top,
      });
      if (picked.length >= ${Number(limit)}) break;
    }
    return JSON.stringify(picked);
  })()`;
}

function rowRunStateExpression(probe) {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const selected = rows.find((row) => row.classList.contains("selected"));
    const aimed = rows.find((row) => row.dataset.pinOpRunRow === ${JSON.stringify(probe)});
    return JSON.stringify({
      selected: selected ? rowLabel(selected).slice(0, 40) : null,
      selectedProbe: selected ? selected.dataset.pinOpRunRow ?? null : null,
      rowTop: aimed ? Math.round(aimed.getBoundingClientRect().top) : null,
    });
  })()`;
}

/**
 * The browser suspends an idle background page whenever it feels like it, and
 * the panel used to come back with every pane cleared and no way back but a
 * fresh pick. Stop the worker the way the browser does and hold the panel to
 * returning with the same element, tree and Rules.
 */
async function surviveBackgroundSuspension(session) {
  const read = () => session.json(session.panel, panelStateExpression());
  const before = await read();
  await session.suspendBackground();
  const started = Date.now();
  // Poll at a walking pace: every read walks the panel's shadow roots, and on a
  // large page a tighter loop starves the recovery it is trying to measure.
  await delay(500);
  let after = await read();
  const deadline = started + INSPECTOR_INTERACTION_BUDGET.suspensionRecoveryMs;
  while (
    Date.now() < deadline &&
    !(
      after.selectedElement === before.selectedElement &&
      after.rowCount > 1 &&
      after.ruleSectionCount >= before.ruleSectionCount
    )
  ) {
    await delay(500);
    after = await read();
  }
  return {
    selectedBefore: before.selectedElement,
    selectedAfter: after.selectedElement,
    rowsBefore: before.rowCount,
    rowsAfter: after.rowCount,
    sectionsBefore: before.ruleSectionCount,
    sectionsAfter: after.ruleSectionCount,
    recoveryMs: Date.now() - started,
  };
}

async function launchBrowser(browser, options) {
  if (browser === "firefox") {
    const { launchInspectorExtensionFirefox } = await import(
      "./inspector-extension-driver-firefox.mjs"
    );
    const session = await launchInspectorExtensionFirefox(options);
    // Gecko runs no preload script on an extension page, so the recorder goes in
    // as soon as the panel exists. Startup logs are missed; every interaction
    // this smoke performs afterwards is covered.
    await session.evaluate(session.panel, PANEL_CONSOLE_RECORDER);
    return session;
  }
  return launchInspectorExtension(options);
}

async function readPanelLog(session) {
  try {
    return await session.json(session.panel, "JSON.stringify(globalThis.__pinOpPanelLog ?? [])");
  } catch {
    return [];
  }
}

/** The IDE answers a selection asynchronously, so wait for its first origin. */
async function readSourceOrigins(session, linked) {
  let sources = await session.json(session.panel, sourceOriginsExpression());
  const deadline = Date.now() + (linked ? 15_000 : 0);
  while (Date.now() < deadline && sources.resolvedRuleCount === 0) {
    await delay(300);
    sources = await session.json(session.panel, sourceOriginsExpression());
  }
  return sources;
}

async function armPicker(session) {
  const button = await session.json(session.panel, `(() => {
    const node = document.getElementById("inspect-mode");
    const box = node.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      pressed: node.getAttribute("aria-pressed"),
      disabled: Boolean(node.disabled),
    });
  })()`);
  if (button.disabled) throw new Error("The Inspector picker is disabled");
  if (button.pressed !== "true") await session.click(session.panel, button.x, button.y);
  await delay(300);
}

async function waitForSelection(session, previousSelection) {
  const deadline = Date.now() + 10_000;
  let state = {};
  while (Date.now() < deadline) {
    state = await session.json(session.panel, selectionExpression());
    if (state.selectedElement && state.selectedElement !== previousSelection) return state;
    await delay(100);
  }
  throw new Error(
    `The Inspector never reported a selection (it still shows ${describe(state.selectedElement)})`,
  );
}

/** The revealed branches load on their own; wait for the tree to stop moving. */
async function settleTree(session) {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await session.json(session.panel, treeStateExpression());
    if (state.rowCount > 1 && state.rowCount === previous && state.loadMoreRows === 0) return;
    previous = state.rowCount;
    await delay(150);
  }
}

async function linkPanel(session, linkCode) {
  await session.waitFor(session.panel, 'Boolean(document.getElementById("link-code"))', 10_000);
  const field = await session.json(session.panel, `(() => {
    const input = document.getElementById("link-code");
    const box = input.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
  })()`);
  await session.click(session.panel, field.x, field.y);
  await session.type(session.panel, linkCode);
  const link = await session.json(session.panel, `(() => {
    const button = document.getElementById("link-button");
    const box = button.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
  })()`);
  await session.click(session.panel, link.x, link.y);
  await session.waitFor(
    session.panel,
    '(document.getElementById("connection-status")?.textContent || "").includes("Connected")',
    30_000,
  );
}

async function startIde(workspace) {
  const { startInspectorIde } = await import("./inspector-extension-ide.mjs");
  return startInspectorIde({
    workspace: isAbsolute(workspace) ? workspace : join(repositoryRoot, workspace),
  });
}

function pointExpression(selector) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return JSON.stringify({ error: "the target is absent" });
    node.scrollIntoView({ block: "center" });
    const box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return JSON.stringify({ error: "the target has no box" });
    const x = Math.round(box.left + Math.min(box.width / 2, 40));
    const y = Math.round(box.top + Math.min(box.height / 2, 12));
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      return JSON.stringify({ error: "the target is outside the viewport" });
    }
    const describe = (element) => element
      ? element.tagName.toLowerCase() + (element.id ? "#" + element.id : "")
      : "none";
    return JSON.stringify({ x, y, hit: describe(document.elementFromPoint(x, y)) });
  })()`;
}

/** The selected row's own tag and id, so it can be compared with a hit test. */
function selectionExpression() {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const selected = rows.find((row) => row.classList.contains("selected"));
    const text = selected ? rowLabel(selected) : "";
    const tag = /^<([a-zA-Z][\\w-]*)/.exec(text);
    const id = /\\bid=\\s*"?\\s*([^"\\s>]+)/.exec(text);
    return JSON.stringify({
      selectedElement: selected ? (tag ? tag[1].toLowerCase() : "?") + (id ? "#" + id[1] : "") : null,
      selectedLabel: selected ? text.slice(0, 80) : null,
      pickerArmed: document.getElementById("inspect-mode")?.getAttribute("aria-pressed") === "true",
    });
  })()`;
}

/**
 * Everything the suspension gate compares, from a single walk of the panel's
 * shadow roots: three separate deep queries cost enough main thread on a large
 * page to slow the very recovery being measured.
 */
function panelStateExpression() {
  return `(() => {
    ${DEEP_QUERY_SOURCE}
    const found = deep(document, ".elements-tree-outline, .styles-section, .pin-op-rule-origin, [data-part='rule-origin']");
    const outline = found.find((node) => node.classList.contains("elements-tree-outline"));
    const rows = outline ? [...outline.querySelectorAll('li[role="treeitem"]')] : [];
    const selected = rows.find((row) => row.classList.contains("selected"));
    const text = selected ? (selected.textContent || "").replace(/[\\s\\u200b]+/g, " ").trim() : "";
    const tag = /^<([a-zA-Z][\\w-]*)/.exec(text);
    const id = /\\bid=\\s*"?\\s*([^"\\s>]+)/.exec(text);
    return JSON.stringify({
      selectedElement: selected ? (tag ? tag[1].toLowerCase() : "?") + (id ? "#" + id[1] : "") : null,
      rowCount: rows.length,
      ruleSectionCount: found.filter((node) => node.classList.contains("styles-section")).length,
    });
  })()`;
}

function treeStateExpression() {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const labelCursorOf = (row) => {
      if (!row) return "absent";
      const nodes = [...row.querySelectorAll("*")];
      const cursors = new Set(nodes.map((node) => {
        const view = node.ownerDocument?.defaultView;
        return view ? view.getComputedStyle(node).cursor : "absent";
      }));
      return [...cursors].join(",") || "absent";
    };
    const adorner = deep(document, ".adorner-container")[0];
    return JSON.stringify({
      rowCount: rows.length,
      whitespaceRows: rows.filter((row) => /^"\\s*"$/.test(rowLabel(row))).length,
      loadMoreRows: rows.filter((row) => rowLabel(row).startsWith("Load more")).length,
      adornerDisplay: adorner ? getComputedStyle(adorner).display : "absent",
      rowCursor: rows[0] ? getComputedStyle(rows[0]).cursor : "absent",
      labelCursor: labelCursorOf(rows[0]),
    });
  })()`;
}

/**
 * The expansion state of the exact row that was measured. A row's label changes
 * when it collapses -- `<div>` gains its ` … </div>` tail -- so matching on text
 * reads a real toggle as "nothing happened"; the mark survives it.
 */
function markedRowExpandedExpression() {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const row = rows.find((candidate) => candidate.dataset.pinOpSmokeRow === "1");
    return JSON.stringify({
      found: Boolean(row),
      expanded: row ? row.classList.contains("expanded") : null,
    });
  })()`;
}

function rowRectExpression(needle, wantExpandable, { skipSelected = false } = {}) {
  return `(() => {
    ${TREE_ROWS_SOURCE}
    const matched = rows.filter((row) => rowLabel(row).includes(${JSON.stringify(needle)}));
    // Clicking the row that is already selected proves nothing, so the
    // selection step needs a different one -- and a row the tree has scrolled
    // out of view cannot be clicked at all.
    // A row can sit inside the outline yet be scrolled under the panel chrome,
    // where a click reaches the chrome instead. Hit-test the point that would
    // be clicked, piercing shadow roots the way the browser does.
    const topmostAt = (x, y) => {
      let node = document.elementFromPoint(x, y);
      while (node && node.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      return node;
    };
    const visible = matched.filter((row) => {
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0) return false;
      const y = Math.round(rect.top + rect.height / 2);
      const x = Math.round(rect.left + Math.min(140, Math.max(20, rect.width / 2)));
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      return row.contains(topmostAt(x, y));
    });
    const candidates = ${skipSelected}
      ? visible.filter((row) => !row.classList.contains("selected"))
      : visible;
    const row = ${wantExpandable}
      ? candidates.find((candidate) => candidate.classList.contains("parent"))
      : candidates[0];
    if (!row) {
      return JSON.stringify({
        error: "no visible " + (${wantExpandable} ? "expandable " : "") + "row matched " +
          ${JSON.stringify(needle)} +
          " (" + matched.length + " matched, " + visible.length + " in view)",
      });
    }
    for (const marked of rows) delete marked.dataset.pinOpSmokeRow;
    row.dataset.pinOpSmokeRow = "1";
    const box = row.getBoundingClientRect();
    const text = rowLabel(row);
    const tag = /^<([a-zA-Z][\\w-]*)/.exec(text);
    const id = /\\bid=\\s*"?\\s*([^"\\s>]+)/.exec(text);
    // Chromium hit-tests the disclosure triangle inside the row's own left
    // padding, which grows with depth, so a fixed offset misses nested rows.
    const indent = Number.parseFloat(getComputedStyle(row).paddingLeft) || 0;
    return JSON.stringify({
      label: text.slice(0, 60),
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      triangleX: box.left + indent + 5,
      expanded: row.classList.contains("expanded"),
      element: (tag ? tag[1].toLowerCase() : "?") + (id ? "#" + id[1] : ""),
    });
  })()`;
}

function sourceOriginsExpression() {
  return `(() => {
    ${DEEP_QUERY_SOURCE}
    const origins = deep(document, ".pin-op-rule-origin, [data-part='rule-origin']")
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean);
    return JSON.stringify({
      ruleSectionCount: deep(document, ".styles-section").length,
      resolvedRuleCount: origins.filter((origin) => /:\\d+$/.test(origin)).length,
      origins: origins.slice(0, 12),
    });
  })()`;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requireWithinBudget(value, ceiling, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Inspector ${label} latency is not a measurement`);
  }
  if (value > ceiling) {
    throw new Error(`Inspector ${label} took ${Math.round(value)}ms, over the ${ceiling}ms budget`);
  }
}

function describe(value) {
  return typeof value === "string" && value.length > 0 ? value : "nothing";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") options.url = argv[++index];
    else if (argument === "--browser") options.browser = argv[++index];
    else if (argument === "--workspace") options.workspace = argv[++index];
    else if (argument === "--extension") options.extensionDirectory = resolve(argv[++index]);
    else if (argument === "--pick") options.pickSelector = argv[++index];
    else if (argument === "--branch") options.branchNeedle = argv[++index];
    else if (argument === "--triangle") options.triangleNeedle = argv[++index];
    else throw new Error(`Unknown Inspector smoke argument: ${argument}`);
  }
  return options;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = await runInspectorExtensionSmoke(options);
  try {
    assertInspectorInteractionSnapshot(snapshot, { requireSourceOrigins: snapshot.linked });
  } catch (error) {
    // The measurement is what makes a failure actionable, so print it before
    // the process dies on the assertion.
    console.error(`INSPECTOR_EXTENSION_FAIL ${JSON.stringify(snapshot)}`);
    throw error;
  }
  console.log(`INSPECTOR_EXTENSION_OK ${JSON.stringify(snapshot)}`);
}
