import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_INSPECTOR_CROSS_BROWSER_BUDGET,
  NATIVE_INSPECTOR_OPERATION_BUDGET,
  NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS,
  assertNativeInspectorLayoutParity,
  assertNativeInspectorLayoutSnapshot,
  assertNativeInspectorPerformance,
  assertNativeInspectorPerformanceParity,
} from "../smoke-chromium-read-only-inspector.mjs";

test("accepts a semantic 800x600 Inspector layout with two-pixel parity", () => {
  const chrome = validLayout();
  const firefox = validLayout();
  firefox.rects.sourceOrigin.top += 2;
  firefox.rects.sourceOrigin.bottom += 2;

  assert.doesNotThrow(() => assertNativeInspectorLayoutSnapshot(chrome));
  assert.doesNotThrow(() => assertNativeInspectorLayoutParity(chrome, firefox));
});

test("rejects a missing layout rectangle before parity can pass", () => {
  const firefox = validLayout();
  delete firefox.rects.toolbar;

  assert.throws(
    () => assertNativeInspectorLayoutParity(validLayout(), firefox),
    /toolbar rectangle is missing/i,
  );
});

test("rejects Chrome and Firefox geometry beyond the two-pixel ceiling", () => {
  const firefox = validLayout();
  firefox.rects.toolbar.height += 2.01;
  firefox.rects.toolbar.bottom += 2.01;

  assert.throws(
    () => assertNativeInspectorLayoutParity(validLayout(), firefox),
    /toolbar\.bottom by 2\.01px/i,
  );
});

test("compares the complete toolbar and source-origin rectangles", () => {
  for (const [key, coordinate, delta] of [
    ["toolbar", "width", 2.01],
    ["toolbar", "right", -2.01],
    ["sourceOrigin", "left", 2.01],
    ["sourceOrigin", "right", 2.01],
    ["sourceOrigin", "width", 2.01],
  ]) {
    const firefox = validLayout();
    firefox.rects[key][coordinate] += delta;
    assert.throws(
      () => assertNativeInspectorLayoutParity(validLayout(), firefox),
      new RegExp(`${key}\\.${coordinate} by 2\\.01px`, "i"),
    );
  }
});

test("rejects semantic parity when the selected indicator disappears", () => {
  const firefox = validLayout();
  firefox.selectedIndicator.activeBorderVisible = false;

  assert.throws(
    () => assertNativeInspectorLayoutParity(validLayout(), firefox),
    /layout semantics are incomplete/i,
  );
});

test("pins operation budgets far below the former permissive smoke limits", () => {
  assert.deepEqual(NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS, {
    navigationToReady: 2_000,
    loadMore: 750,
    rulesRefresh: 500,
    sourceSwitch: 300,
    total: 3_500,
  });
  assert.deepEqual(NATIVE_INSPECTOR_OPERATION_BUDGET, {
    treeSnapshotCalls: 12,
    rulesSnapshotCalls: 6,
  });
  const atBudget = Object.fromEntries(Object.entries(
    NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS,
  ).map(([operation, duration]) => [`${operation}Ms`, duration]));
  assert.doesNotThrow(() => assertNativeInspectorPerformance(atBudget));
  assert.throws(
    () => assertNativeInspectorPerformance({
      ...atBudget,
      sourceSwitchMs: NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS.sourceSwitch + 0.01,
    }),
    /sourceSwitch took/i,
  );
});

test("accepts measured cross-browser timings within the CI floor and ratio", () => {
  assert.deepEqual(NATIVE_INSPECTOR_CROSS_BROWSER_BUDGET, {
    floorMs: 150,
    slowdownRatio: 2.5,
  });
  const chrome = validResult();
  const firefox = validResult();
  chrome.performance.navigationToReadyMs = 200;
  firefox.performance.navigationToReadyMs = 500;
  chrome.performance.sourceSwitchMs = 1;
  firefox.performance.sourceSwitchMs = 300;

  assert.doesNotThrow(() => assertNativeInspectorPerformanceParity(chrome, firefox));
});

test("rejects a cross-browser slowdown above the ratio after applying the CI floor", () => {
  const chrome = validResult();
  const firefox = validResult();
  chrome.performance.loadMoreMs = 1;
  firefox.performance.loadMoreMs = 376;

  assert.throws(
    () => assertNativeInspectorPerformanceParity(chrome, firefox),
    /loadMore slowdown ratio 2\.51 exceeds 2\.5/i,
  );
});

test("rejects packaged bootstrap navigation above the absolute budget", () => {
  const firefox = validResult();
  firefox.packagedBootstrap.navigationToReadyMs =
    NATIVE_INSPECTOR_PERFORMANCE_BUDGET_MS.navigationToReady + 0.01;

  assert.throws(
    () => assertNativeInspectorPerformanceParity(validResult(), firefox),
    /packaged navigation took 2000\.01ms \(budget 2000ms\)/i,
  );
});

function validLayout() {
  return {
    viewport: { width: 800, height: 600 },
    rects: {
      root: rect(0, 0, 800, 600),
      dom: rect(0, 0, 496, 600),
      sidebar: rect(496, 0, 304, 600),
      rules: rect(496, 28, 304, 572),
      tabs: rect(496, 0, 304, 28),
      toolbar: rect(496, 28, 304, 28),
      sourceOrigin: rect(700, 60, 90, 18),
      scrollOwner: rect(496, 28, 304, 572),
    },
    domRatio: 0.62,
    overflowY: "auto",
    scrollable: true,
    noHorizontalOverflow: true,
    toolbarSticky: true,
    sourceOriginVisible: true,
    sourceOriginClickable: true,
    selectedIndicator: {
      rulesSelected: true,
      sourceSelected: false,
      rulesTabIndex: 0,
      sourceTabIndex: -1,
      activeBorderVisible: true,
      inactiveBorderTransparent: true,
      activeTextDistinct: true,
    },
  };
}

function validResult() {
  return {
    performance: {
      navigationToReadyMs: 400,
      loadMoreMs: 150,
      rulesRefreshMs: 50,
      sourceSwitchMs: 20,
      totalMs: 800,
    },
    packagedBootstrap: {
      navigationToReadyMs: 400,
    },
  };
}

function rect(left, top, width, height) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}
