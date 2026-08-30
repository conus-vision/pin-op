import assert from "node:assert/strict";
import test from "node:test";

import {
  INSPECTOR_INTERACTION_BUDGET,
  assertInspectorInteractionSnapshot,
} from "../smoke-inspector-extension.mjs";

test("accepts a panel that picks, disarms, reveals, selects, and toggles", () => {
  assert.doesNotThrow(() => assertInspectorInteractionSnapshot(validSnapshot()));
});

test("rejects a pick that landed on a different element than the page shows", () => {
  const snapshot = validSnapshot();
  snapshot.pick.selected = "div#other";

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /picked div#other where the page shows article#fixture-card/,
  );
});

test("rejects a picker that stayed armed after the pick landed", () => {
  const snapshot = validSnapshot();
  snapshot.pick.pickerArmedAfterPick = true;

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /picker stayed armed/,
  );
});

test("rejects whitespace-only rows and leftover load-more rows", () => {
  const whitespace = validSnapshot();
  whitespace.tree.whitespaceRows = 19;
  assert.throws(
    () => assertInspectorInteractionSnapshot(whitespace),
    /19 whitespace-only rows/,
  );

  const paginated = validSnapshot();
  paginated.tree.loadMoreRows = 6;
  assert.throws(
    () => assertInspectorInteractionSnapshot(paginated),
    /6 "Load more" rows/,
  );
});

test("rejects a tree whose rows carry a text cursor", () => {
  const snapshot = validSnapshot();
  snapshot.tree.rowCursor = "text";

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /do not carry a pointer arrow/,
  );
});

test("rejects a row label that carries a text cursor", () => {
  const snapshot = validSnapshot();
  snapshot.tree.labelCursor = "default,text";

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /do not carry a pointer arrow/,
  );
});

test("rejects a tree that presents Chromium adorners", () => {
  const snapshot = validSnapshot();
  snapshot.tree.adornerDisplay = "inline-flex";

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /presents Chromium adorners \(inline-flex\)/,
  );
});

test("accepts a tree whose adorner container was never rendered", () => {
  const snapshot = validSnapshot();
  snapshot.tree.adornerDisplay = "absent";

  assert.doesNotThrow(() => assertInspectorInteractionSnapshot(snapshot));
});

test("rejects an empty tree even when every other gate passes", () => {
  const snapshot = validSnapshot();
  snapshot.tree.rowCount = 1;

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /never rendered the revealed document/,
  );
});

test("rejects a row click that selected another row", () => {
  const snapshot = validSnapshot();
  snapshot.rowSelection.selected = "main";

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /Clicking section#hero selected main/,
  );
});

test("rejects a disclosure triangle that changed nothing", () => {
  const snapshot = validSnapshot();
  snapshot.disclosure.expandedAfter = snapshot.disclosure.expandedBefore;

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /did not open or close the row/,
  );
});

test("rejects interaction latency beyond the reviewed budget", () => {
  const slowPick = validSnapshot();
  slowPick.pick.latencyMs = INSPECTOR_INTERACTION_BUDGET.pickLatencyMs + 1;
  assert.throws(
    () => assertInspectorInteractionSnapshot(slowPick),
    /pick took \d+ms, over the \d+ms budget/,
  );

  const slowRow = validSnapshot();
  slowRow.rowSelection.latencyMs = INSPECTOR_INTERACTION_BUDGET.rowSelectionLatencyMs + 1;
  assert.throws(
    () => assertInspectorInteractionSnapshot(slowRow),
    /row selection took \d+ms, over the \d+ms budget/,
  );
});

test("rejects a latency that is not a measurement", () => {
  const snapshot = validSnapshot();
  snapshot.pick.latencyMs = null;

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /pick latency is not a measurement/,
  );
});

test("requires resolved rule sources only when the IDE was linked", () => {
  const snapshot = validSnapshot();
  snapshot.sources = { ruleSectionCount: 3, resolvedRuleCount: 0, origins: [] };

  assert.doesNotThrow(() => assertInspectorInteractionSnapshot(snapshot));
  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot, { requireSourceOrigins: true }),
    /No Rules row resolved to a workspace source/,
  );

  snapshot.sources.resolvedRuleCount = 2;
  assert.doesNotThrow(
    () => assertInspectorInteractionSnapshot(snapshot, { requireSourceOrigins: true }),
  );
});

test("rejects a background suspension that emptied the panel", () => {
  const moved = validSnapshot();
  moved.suspension.selectedAfter = "body";
  assert.throws(
    () => assertInspectorInteractionSnapshot(moved),
    /moved the selection from article#fixture-card to body/,
  );

  const cleared = validSnapshot();
  cleared.suspension.rowsAfter = 1;
  assert.throws(
    () => assertInspectorInteractionSnapshot(cleared),
    /cleared the tree \(17 rows to 1\)/,
  );

  const unstyled = validSnapshot();
  unstyled.suspension.sectionsAfter = 0;
  assert.throws(
    () => assertInspectorInteractionSnapshot(unstyled),
    /cleared Rules \(3 sections to 0\)/,
  );

  const slow = validSnapshot();
  slow.suspension.recoveryMs = INSPECTOR_INTERACTION_BUDGET.suspensionRecoveryMs + 1;
  assert.throws(
    () => assertInspectorInteractionSnapshot(slow),
    /suspension recovery took \d+ms, over the \d+ms budget/,
  );
});

test("rejects a tree that moves out from under a run of row clicks", () => {
  const missed = validSnapshot();
  missed.rowRun.clicks[1] = { aimedAt: "main", selected: "body", hit: false };
  assert.throws(
    () => assertInspectorInteractionSnapshot(missed),
    /Clicking main selected body/,
  );

  const shifted = validSnapshot();
  shifted.rowRun.maxRowShiftPx = 33;
  assert.throws(
    () => assertInspectorInteractionSnapshot(shifted),
    /moved the tree 33px under the cursor/,
  );

  const lonely = validSnapshot();
  lonely.rowRun.clicks = [lonely.rowRun.clicks[0]];
  assert.throws(
    () => assertInspectorInteractionSnapshot(lonely),
    /never clicked a second row/,
  );
});

test("rejects a selection nobody can see", () => {
  const hidden = validSnapshot();
  hidden.selectionBand.displayed = false;
  assert.throws(
    () => assertInspectorInteractionSnapshot(hidden),
    /paints no selection band/,
  );

  const buried = validSnapshot();
  buried.selectionBand.paintsAbovePanelSurface = false;
  assert.throws(
    () => assertInspectorInteractionSnapshot(buried),
    /painted behind the panel/,
  );

  const clear = validSnapshot();
  clear.selectionBand.transparent = true;
  assert.throws(
    () => assertInspectorInteractionSnapshot(clear),
    /band is transparent/,
  );
});

test("rejects a snapshot that is missing a whole interaction", () => {
  const snapshot = validSnapshot();
  delete snapshot.disclosure;

  assert.throws(
    () => assertInspectorInteractionSnapshot(snapshot),
    /Inspector disclosure result is missing/,
  );
});

function validSnapshot() {
  return {
    pick: {
      hit: "article#fixture-card",
      selected: "article#fixture-card",
      latencyMs: 249,
      pickerArmedAfterPick: false,
    },
    tree: {
      rowCount: 17,
      whitespaceRows: 0,
      loadMoreRows: 0,
      adornerDisplay: "none",
      rowCursor: "default",
      labelCursor: "default",
    },
    rowSelection: {
      clicked: "section#hero",
      selected: "section#hero",
      latencyMs: 210,
    },
    disclosure: {
      row: "section#hero",
      expandedBefore: true,
      expandedAfter: false,
    },
    selectionBand: {
      displayed: true,
      background: "rgb(211, 227, 253)",
      transparent: false,
      width: 432,
      height: 34,
      paintsAbovePanelSurface: true,
    },
    rowRun: {
      clicks: [
        { aimedAt: "section#hero", selected: "section#hero", hit: true },
        { aimedAt: "main", selected: "main", hit: true },
      ],
      maxRowShiftPx: 0,
    },
    suspension: {
      selectedBefore: "article#fixture-card",
      selectedAfter: "article#fixture-card",
      rowsBefore: 17,
      rowsAfter: 18,
      sectionsBefore: 3,
      sectionsAfter: 3,
      recoveryMs: 310,
    },
    sources: { ruleSectionCount: 3, resolvedRuleCount: 3, origins: ["app.scss:12"] },
  };
}
