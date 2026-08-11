import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DomTreeController,
  type DomTreeTransport,
} from "../src/domTreeController.js";
import {
  DomTreeView,
  type DomTreeDocument,
} from "../src/domTreeView.js";
import { SourceNavigationController } from "../src/sourceNavigationController.js";
import type {
  DomNodeView,
  DomRequest,
  DomResponse,
} from "../src/domProtocol.js";

describe("DomTreeView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an accessible tree with roving focus and safe text labels", () => {
    const harness = createHarness();
    const dangerous = "<img src=x onerror=alert(1)>";
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("selected", dangerous),
    ]));

    const tree = harness.dom.element("dom-tree");
    const root = harness.dom.row("root");
    const selected = harness.dom.row("selected");
    expect(tree.getAttribute("role")).toBe("tree");
    expect(root.getAttribute("role")).toBe("treeitem");
    expect(root.getAttribute("aria-expanded")).toBe("true");
    expect(root.getAttribute("tabindex")).toBe("-1");
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.getAttribute("tabindex")).toBe("0");
    expect(selected.findByData("part", "label")?.textContent).toBe(dangerous);
    expect(harness.dom.createdTags()).not.toContain("img");
  });

  it("materializes exactly viewport and overscan rows at a stable height", () => {
    const harness = createHarness({ clientHeight: 60, rowHeight: 20, overscan: 2 });
    const path = Array.from({ length: 40 }, (_, index) =>
      node(`node-${index}`, `div.level-${index}`, index < 39));

    harness.controller.handleEvent(selectionChanged(1, path));

    const spacer = harness.dom.element("dom-tree-spacer");
    expect(spacer.children).toHaveLength(7);
    expect(spacer.style.height).toBe("1580px");
    expect(harness.dom.element("dom-tree").scrollTop).toBeGreaterThan(0);
    for (const row of spacer.children) {
      expect(row.style.height).toBe("20px");
    }
  });

  it("routes keyboard, disclosure, selection, and materialized hover actions", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(5, [
      node("root", "html", true),
      node("parent", "main", true),
      node("child", "button.save"),
    ]));
    harness.controller.focus("parent");
    const tree = harness.dom.element("dom-tree");

    const down = tree.dispatch("keydown", { key: "ArrowDown" });
    await flushAsync();
    expect(down.defaultPrevented).toBe(true);
    expect(harness.controller.focusedRef).toBe("child");

    tree.dispatch("keydown", { key: "Enter" });
    await flushAsync();
    expect(harness.transport.dispatched.at(-1)).toEqual({
      type: "dom.select",
      documentEpoch: 5,
      nodeRef: "child",
    });

    harness.dom.element("dom-tree").dispatch("pointerover", {
      target: harness.dom.row("child"),
    });
    expect(harness.transport.dispatched.at(-1)).toEqual({
      type: "dom.hover",
      documentEpoch: 5,
      nodeRef: "child",
    });

    const disclosure = harness.dom.row("parent").findByData("action", "toggle");
    harness.dom.element("dom-tree").dispatch("click", { target: disclosure });
    await flushAsync();
    expect(harness.controller.isExpanded("parent")).toBe(false);
  });

  it("renders controls and resolving space only on the selected DOM row", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("selected", "button.save"),
    ]));

    harness.sourceNavigation.beginInspect("inspect-1");

    expect(harness.dom.row("root").findByData(
      "part",
      "source-navigation-controls",
    )).toBeUndefined();
    const reserved = harness.dom.row("selected").findByData(
      "part",
      "source-navigation-controls",
    );
    expect(reserved).toBeDefined();
    expect(reserved?.findByData("action", "source-previous")).toBeUndefined();

    harness.sourceNavigation.acceptResolution(resolution({
      selectedMatchCount: 2,
    }));

    const selected = harness.dom.row("selected");
    const previous = selected.findByData("action", "source-previous");
    const next = selected.findByData("action", "source-next");
    expect(previous?.getAttribute("type")).toBe("button");
    expect(previous?.getAttribute("aria-label")).toBe("Previous source match");
    expect(previous?.getAttribute("title")).toBe("Previous source match");
    expect(previous?.disabled).toBe(true);
    expect(next?.getAttribute("aria-label")).toBe("Next source match");
    expect(next?.getAttribute("title")).toBe("Next source match");
    expect(next?.disabled).toBe(true);

    harness.sourceNavigation.acceptResolution(resolution({
      resolutionGeneration: 4,
      selectedMatchCount: 0,
      parentMatchCount: 2,
    }));

    expect(harness.dom.row("selected").findByData(
      "part",
      "source-navigation-controls",
    )).toBeUndefined();
  });

  it("contains row navigation clicks before selection and dispatches both actions", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("selected", "button.save"),
    ]));
    harness.sourceNavigation.beginInspect("inspect-1");
    harness.sourceNavigation.acceptResolution(resolution({
      selectedMatchCount: 2,
    }));
    harness.sourceNavigation.acceptState(navigationState({
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    const tree = harness.dom.element("dom-tree");
    const selected = harness.dom.row("selected");
    const previous = selected.findByData("action", "source-previous");
    const next = selected.findByData("action", "source-next");
    if (!previous || !next) {
      throw new Error("Missing selected-row source navigation controls");
    }

    const previousClick = tree.dispatch("click", { target: previous });
    const nextClick = tree.dispatch("click", { target: next });
    await flushAsync();

    expect(previousClick.defaultPrevented).toBe(true);
    expect(previousClick.propagationStopped).toBe(true);
    expect(nextClick.defaultPrevented).toBe(true);
    expect(nextClick.propagationStopped).toBe(true);
    expect(harness.sourceCommands.map((command) => command.direction)).toEqual([
      "previous",
      "next",
    ]);
    expect(harness.transport.dispatched).not.toContainEqual(
      expect.objectContaining({ type: "dom.select" }),
    );
    expect(harness.controller.focusedRef).toBe("selected");
  });

  it("leaves source control keyboard activation to the nested buttons", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("selected", "button.save"),
    ]));
    harness.sourceNavigation.beginInspect("inspect-1");
    harness.sourceNavigation.acceptResolution(resolution());
    harness.sourceNavigation.acceptState(navigationState({ activeMatchIndex: 0 }));
    const tree = harness.dom.element("dom-tree");
    const previous = harness.dom.row("selected")
      .findByData("action", "source-previous");
    const next = harness.dom.row("selected")
      .findByData("action", "source-next");
    const previousIcon = previous?.children[0];
    if (!previous || !next || !previousIcon) {
      throw new Error("Missing selected-row source navigation controls");
    }

    const enter = tree.dispatch("keydown", {
      key: "Enter",
      target: previousIcon,
    });
    const arrow = tree.dispatch("keydown", {
      key: "ArrowLeft",
      target: next,
    });
    await flushAsync();

    expect(enter.defaultPrevented).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
    expect(harness.controller.focusedRef).toBe("selected");
    expect(harness.transport.dispatched).not.toContainEqual(
      expect.objectContaining({ type: "dom.select" }),
    );
    expect(harness.sourceCommands).toEqual([]);
  });

  it("creates row source icons with the supplied tree document", () => {
    const globalCreateElementNS = vi.fn(() => {
      throw new Error("global document must not create row icons");
    });
    vi.stubGlobal("document", { createElementNS: globalCreateElementNS });
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("selected", "button.save"),
    ]));
    harness.sourceNavigation.beginInspect("inspect-1");
    harness.sourceNavigation.acceptResolution(resolution());

    const previous = harness.dom.row("selected")
      .findByData("action", "source-previous");
    expect(globalCreateElementNS).not.toHaveBeenCalled();
    expect(previous?.children[0]?.tagName).toBe("svg");
    expect(harness.dom.createdNamespacedTags()).toContainEqual({
      namespace: "http://www.w3.org/2000/svg",
      tagName: "path",
    });
  });

  it("focuses the disclosed row and keeps one roving tabindex", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("parent", "main", true),
      node("child", "button"),
    ]));
    harness.controller.focus("root");

    const disclosure = harness.dom.row("parent").findByData("action", "toggle");
    harness.dom.element("dom-tree").dispatch("click", { target: disclosure });
    await flushAsync();

    expect(harness.controller.focusedRef).toBe("parent");
    expect(tabbableRows(harness.dom)).toEqual([
      expect.objectContaining({ dataset: expect.objectContaining({ nodeRef: "parent" }) }),
    ]);
  });

  it("roves onto actionable Load more without previewing it", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("child", "main"),
    ]));
    const tree = harness.dom.element("dom-tree");
    const loadMore = harness.dom.element("dom-tree-spacer")
      .findByData("rowType", "load-more");
    expect(loadMore).toBeDefined();

    tree.dispatch("keydown", { key: "ArrowDown" });
    await flushAsync();

    expect(harness.controller.focusedRef).toBe(loadMore?.dataset.nodeRef);
    expect(tabbableRows(harness.dom)).toHaveLength(1);
    expect(tabbableRows(harness.dom)[0]?.dataset.nodeRef)
      .toBe(loadMore?.dataset.nodeRef);

    tree.dispatch("pointerover", { target: harness.dom.row("child") });
    tree.dispatch("pointerover", { target: loadMore });
    tree.dispatch("pointerover", { target: loadMore });

    expect(clearHoverRequests(harness.transport)).toHaveLength(1);
  });

  it("moves the only tab stop off Load more while its request is pending", async () => {
    const harness = createHarness();
    const pendingChildren = deferred<DomResponse>();
    harness.transport.enqueue(pendingChildren.promise);
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("child", "main"),
    ]));
    const tree = harness.dom.element("dom-tree");
    tree.dispatch("keydown", { key: "ArrowDown" });
    await flushAsync();
    expect(tabbableRows(harness.dom)).toHaveLength(1);
    expect(tabbableRows(harness.dom)[0]?.dataset.rowType).toBe("load-more");

    const loading = harness.controller.loadMore("root");
    const focusedWhileLoading = harness.controller.focusedRef;
    const tabStopsWhileLoading = tabbableRows(harness.dom).map(
      (row) => row.dataset.nodeRef,
    );
    const loadingRow = harness.dom.element("dom-tree-spacer")
      .findByData("rowType", "load-more");
    const loadingTabIndex = loadingRow?.getAttribute("tabindex");
    const loadingState = loadingRow?.dataset.loading;
    pendingChildren.resolve(childrenResponse("root", []));
    await loading;

    expect(focusedWhileLoading).toBe("child");
    expect(tabStopsWhileLoading).toEqual(["child"]);
    expect(loadingState).toBe("true");
    expect(loadingTabIndex).toBe("-1");
  });

  it("keeps the only tab stop on a node while its children are loading", async () => {
    const harness = createHarness();
    const pendingChildren = deferred<DomResponse>();
    harness.transport.enqueue(pendingChildren.promise);
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("parent", "main", true),
    ]));

    const loading = harness.controller.expand("parent");
    const focusedWhileLoading = harness.controller.focusedRef;
    const parentWhileLoading = harness.dom.row("parent");
    const tabStopsWhileLoading = tabbableRows(harness.dom).map(
      (row) => row.dataset.nodeRef,
    );
    const loadingState = parentWhileLoading.dataset.loading;
    const loadingTabIndex = parentWhileLoading.getAttribute("tabindex");
    pendingChildren.resolve(childrenResponse("parent", []));
    await loading;

    expect(focusedWhileLoading).toBe("parent");
    expect(tabStopsWhileLoading).toEqual(["parent"]);
    expect(loadingState).toBe("true");
    expect(loadingTabIndex).toBe("0");
  });

  it("renders shadow, frame, and inaccessible boundary states", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      { ...node("shadow", "#shadow-root", true), kind: "shadow-root" },
      { ...node("frame", "iframe document", true), kind: "frame-document" },
      { ...node("locked", "iframe.external"), inaccessible: true },
    ]));

    expect(harness.dom.row("shadow").className).toContain("is-shadow-root");
    expect(harness.dom.row("frame").className).toContain("is-frame-document");
    expect(harness.dom.row("locked").className).toContain("is-inaccessible");
    expect(harness.dom.row("locked").getAttribute("aria-disabled")).toBe("true");
  });

  it("does not scroll or materialize an unknown page hover", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [node("root", "html")]));
    const tree = harness.dom.element("dom-tree");
    const before = tree.scrollTop;
    const materializedBefore = harness.dom.element("dom-tree-spacer").children.length;

    harness.controller.handleEvent({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: "not-loaded",
      summary: "button.remote",
    });

    expect(tree.scrollTop).toBe(before);
    expect(harness.dom.element("dom-tree-spacer").children.length)
      .toBe(materializedBefore);
    expect(harness.controller.expandedRefs()).toEqual([]);
  });

  it("reconciles focus inside the strict virtual window without scrolling back", () => {
    const harness = createHarness({ clientHeight: 60, rowHeight: 20 });
    const path = Array.from({ length: 30 }, (_, index) =>
      node(`node-${index}`, `div.level-${index}`, index < 29));
    harness.controller.handleEvent(selectionChanged(1, path));
    const tree = harness.dom.element("dom-tree");
    expect(tree.scrollTop).toBeGreaterThan(0);

    tree.scrollTop = 0;
    tree.dispatch("scroll");

    expect(tree.scrollTop).toBe(0);
    expect(harness.dom.element("dom-tree-spacer").children).toHaveLength(5);
    expect(tabbableRows(harness.dom)).toHaveLength(1);
    expect(tabbableRows(harness.dom)[0]?.dataset.nodeRef).toBe("node-0");
    expect(harness.controller.focusedRef).toBe("node-0");
  });

  it("rerenders exact virtual windows in both resize directions", () => {
    const harness = createHarness({ clientHeight: 40, rowHeight: 20, overscan: 1 });
    const path = Array.from({ length: 20 }, (_, index) =>
      node(`node-${index}`, `div.level-${index}`, index < 19));
    harness.controller.handleEvent(selectionChanged(1, path));
    const tree = harness.dom.element("dom-tree");
    tree.scrollTop = 0;
    tree.dispatch("scroll");

    expect(harness.resize.observed).toEqual([tree]);
    expect(harness.dom.element("dom-tree-spacer").children).toHaveLength(3);

    tree.clientHeight = 100;
    harness.resize.trigger();
    expect(harness.dom.element("dom-tree-spacer").children).toHaveLength(6);

    tree.clientHeight = 20;
    harness.resize.trigger();
    expect(harness.dom.element("dom-tree-spacer").children).toHaveLength(2);
    expect(tabbableRows(harness.dom)).toHaveLength(1);
  });

  it("deduplicates hover clearing across blank and non-previewable rows", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("preview", "main", true),
      { ...node("locked", "iframe.external"), inaccessible: true },
    ]));
    const tree = harness.dom.element("dom-tree");
    const loadMore = harness.dom.element("dom-tree-spacer")
      .findByData("rowType", "load-more");

    tree.dispatch("pointerover", { target: harness.dom.row("preview") });
    tree.dispatch("pointerover", { target: harness.dom.row("locked") });
    expect(clearHoverRequests(harness.transport)).toHaveLength(1);

    tree.dispatch("pointerover", { target: harness.dom.row("locked") });
    tree.dispatch("pointerover", { target: tree });
    expect(clearHoverRequests(harness.transport)).toHaveLength(1);

    tree.dispatch("pointerover", { target: harness.dom.row("preview") });
    tree.dispatch("pointerover", { target: loadMore });
    expect(clearHoverRequests(harness.transport)).toHaveLength(2);

    tree.dispatch("pointerover", { target: tree });
    tree.dispatch("pointerleave");
    tree.dispatch("pointerleave");

    expect(clearHoverRequests(harness.transport)).toHaveLength(2);
  });

  it("clears element preview when entering shadow and frame rows", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("preview", "main", true),
      { ...node("shadow", "#shadow-root", true), kind: "shadow-root" },
      { ...node("frame", "iframe document"), kind: "frame-document" },
    ]));
    const tree = harness.dom.element("dom-tree");

    tree.dispatch("pointerover", { target: harness.dom.row("preview") });
    tree.dispatch("pointerover", { target: harness.dom.row("shadow") });
    expect(clearHoverRequests(harness.transport)).toHaveLength(1);

    tree.dispatch("pointerover", { target: harness.dom.row("preview") });
    tree.dispatch("pointerover", { target: harness.dom.row("frame") });
    tree.dispatch("pointerover", { target: harness.dom.row("frame") });

    expect(clearHoverRequests(harness.transport)).toHaveLength(2);
    expect(harness.transport.dispatched.filter((request) => (
      request.type === "dom.hover"
    ))).toEqual([
      expect.objectContaining({ nodeRef: "preview" }),
      expect.objectContaining({ nodeRef: "preview" }),
    ]);
  });

  it("keeps frozen rows visible and disables every tree control while recovering", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("root", "html", true),
      node("selected", "button.save"),
    ]));
    harness.sourceNavigation.beginInspect("inspect-1");
    harness.sourceNavigation.acceptResolution(resolution());
    harness.sourceNavigation.acceptState(navigationState({ activeMatchIndex: 0 }));
    harness.view.focus("selected");

    harness.controller.beginRecovery();

    const tree = harness.dom.element("dom-tree");
    const root = harness.dom.row("root");
    const selected = harness.dom.row("selected");
    const previous = selected.findByData("action", "source-previous");
    const loadMore = harness.dom.element("dom-tree-spacer")
      .findByData("rowType", "load-more");
    expect(tree.getAttribute("aria-busy")).toBe("true");
    expect(tree.className.split(" ")).toContain("is-recovering");
    expect(root.getAttribute("aria-disabled")).toBe("true");
    expect(root.findByData("part", "disclosure")?.dataset.action)
      .toBeUndefined();
    expect(selected.getAttribute("tabindex")).toBe("0");
    expect(harness.dom.activeElement).toBe(selected);
    expect(previous).toBeDefined();
    expect(previous?.disabled).toBe(true);
    expect(loadMore?.getAttribute("aria-disabled")).toBe("true");
    if (!previous || !loadMore) {
      throw new Error("Missing frozen recovery controls");
    }

    tree.dispatch("click", { target: previous });
    tree.dispatch("click", { target: selected });
    tree.dispatch("click", { target: loadMore });
    tree.dispatch("keydown", { key: "Enter" });
    tree.dispatch("pointerover", { target: selected });
    await flushAsync();

    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
    expect(harness.transport.requests).toEqual([]);
  });

  it("restores browser focus to the recovered selected row", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      node("old-selected", "button.save"),
    ]));
    harness.view.focus("old-selected");
    const newRoot = node("new-root", "html", true);
    const newSelected = node("new-selected", "button.save");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(newSelected, [newRoot, newSelected], 2),
      { selected: true, expanded: false, focusIntent: "node" },
    );
    harness.controller.finishRecovery();

    expect(harness.controller.focusedRef).toBe("new-selected");
    expect(harness.dom.activeElement).toBe(harness.dom.row("new-selected"));
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("reveals a recovered focus anchor when the new session reuses its ref", () => {
    const harness = createHarness({ clientHeight: 48, overscan: 0 });
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      node("reused-focused", "button.save"),
    ]));
    harness.view.focus("reused-focused");
    const newRoot = node("new-root", "html", true);
    const ancestors = Array.from({ length: 6 }, (_, index) => (
      node(`new-ancestor-${index}`, `section.${index}`, true)
    ));
    const recoveredFocus = node("reused-focused", "button.save");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(
        recoveredFocus,
        [newRoot, ...ancestors, recoveredFocus],
        2,
      ),
      { selected: false, expanded: false, focusIntent: "node" },
    );
    harness.controller.finishRecovery();

    expect(harness.dom.element("dom-tree").scrollTop).toBeGreaterThan(0);
    expect(harness.dom.activeElement).toBe(harness.dom.row("reused-focused"));
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("prioritizes a distant recovered focus anchor over selection reveal", () => {
    const harness = createHarness({ clientHeight: 48, overscan: 0 });
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      node("old-focus", "section.focus", true),
      node("old-selected", "button.selected"),
    ]));
    harness.view.focus("old-focus");
    const newRoot = node("new-root", "html", true);
    const newSelected = node("new-selected", "button.selected");
    const focusAncestors = Array.from({ length: 6 }, (_, index) => (
      node(`new-focus-ancestor-${index}`, `section.focus-${index}`, true)
    ));
    const newFocus = node("new-focus", "section.focus");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(newSelected, [newRoot, newSelected], 2),
      { selected: true, expanded: false },
    );
    harness.controller.installRecoveredPath(
      recoveryLocator(
        newFocus,
        [newRoot, ...focusAncestors, newFocus],
        2,
      ),
      { selected: false, expanded: false, focusIntent: "node" },
    );
    for (let index = 0; index < 6; index += 1) {
      const filler = node(`new-filler-${index}`, `aside.filler-${index}`);
      harness.controller.installRecoveredPath(
        recoveryLocator(filler, [newRoot, filler], 2),
        { selected: false, expanded: false },
      );
    }
    harness.controller.finishRecovery();

    const selected = harness.controller.rows().find((row) => (
      row.nodeRef === "new-selected"
    ));
    const spacer = harness.dom.element("dom-tree-spacer");
    expect(harness.controller.focusedRef).toBe("new-focus");
    expect(harness.dom.activeElement).toBe(harness.dom.row("new-focus"));
    expect(spacer.findByData("nodeRef", "new-selected")).toBeUndefined();
    expect(selected).toMatchObject({ selected: true });

    const recoveredFocusScrollTop = harness.dom.element("dom-tree").scrollTop;
    harness.view.render();

    expect(harness.dom.element("dom-tree").scrollTop).toBe(
      recoveredFocusScrollTop,
    );
    expect(harness.dom.activeElement).toBe(harness.dom.row("new-focus"));
    expect(spacer.findByData("nodeRef", "new-selected")).toBeUndefined();
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("reveals recovered selection when the tree did not own browser focus", () => {
    const harness = createHarness({ clientHeight: 48, overscan: 0 });
    const oldRoot = node("old-root", "html", true);
    const oldFocus = node("old-focus", "section.focus");
    harness.controller.handleEvent(selectionChanged(1, [oldRoot, oldFocus]));
    harness.controller.focus("old-focus");
    const newRoot = node("new-root", "html", true);
    const selectedAncestors = Array.from({ length: 6 }, (_, index) => (
      node(`new-selected-ancestor-${index}`, `section.selected-${index}`, true)
    ));
    const newSelected = node("new-selected", "button.selected");
    const newFocus = node("new-focus", "section.focus");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(
        newSelected,
        [newRoot, ...selectedAncestors, newSelected],
        2,
      ),
      { selected: true, expanded: false },
    );
    harness.controller.installRecoveredPath(
      recoveryLocator(newFocus, [newRoot, newFocus], 2),
      { selected: false, expanded: false, focusIntent: "node" },
    );
    harness.view.render();
    harness.controller.finishRecovery();

    expect(harness.dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "new-selected",
    )).toBeDefined();
    expect(harness.controller.rows().find((row) => (
      row.nodeRef === "new-selected"
    ))).toMatchObject({ selected: true });
    expect(harness.dom.activeElement).toBeUndefined();
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("reveals recovered selection when the saved focus anchor is missing", () => {
    const harness = createHarness({ clientHeight: 48, overscan: 0 });
    const missingFocus = {
      ...node("old-focus", "section.missing"),
      locator: {
        version: 1 as const,
        targetKind: "element" as const,
        boundaries: [],
        path: [{ tagName: "section", siblingIndex: 9 }],
      },
    };
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      missingFocus,
    ]));
    harness.view.focus("old-focus");
    const newRoot = node("new-root", "html", true);
    const selectedAncestors = Array.from({ length: 6 }, (_, index) => (
      node(`new-selected-ancestor-${index}`, `section.selected-${index}`, true)
    ));
    const newSelected = node("new-selected", "button.selected");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(
        newSelected,
        [newRoot, ...selectedAncestors, newSelected],
        2,
      ),
      { selected: true, expanded: false },
    );
    harness.controller.finishRecovery();

    expect(harness.dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "new-selected",
    )).toBeDefined();
    expect(harness.controller.rows().find((row) => (
      row.nodeRef === "new-selected"
    ))).toMatchObject({ selected: true });
    expect(harness.dom.element("dom-tree").contains(harness.dom.activeElement))
      .toBe(true);
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("lets manual browser focus win while revealing recovered selection", () => {
    const harness = createHarness({ clientHeight: 48, overscan: 0 });
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      node("old-focus", "section.focus"),
    ]));
    harness.view.focus("old-focus");
    harness.controller.beginRecovery();
    const outside = harness.dom.document.createElement("button") as unknown as FakeElement;
    outside.focus();
    const newRoot = node("new-root", "html", true);
    const selectedAncestors = Array.from({ length: 6 }, (_, index) => (
      node(`new-selected-ancestor-${index}`, `section.selected-${index}`, true)
    ));
    const newSelected = node("new-selected", "button.selected");
    const newFocus = node("new-focus", "section.focus");
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(
        newSelected,
        [newRoot, ...selectedAncestors, newSelected],
        2,
      ),
      { selected: true, expanded: false },
    );
    harness.controller.installRecoveredPath(
      recoveryLocator(newFocus, [newRoot, newFocus], 2),
      { selected: false, expanded: false, focusIntent: "node" },
    );
    harness.controller.finishRecovery();

    expect(harness.dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "new-selected",
    )).toBeDefined();
    expect(harness.dom.activeElement).toBe(outside);
    expect(harness.controller.rows().find((row) => (
      row.nodeRef === "new-selected"
    ))).toMatchObject({ selected: true });
    expect(harness.sourceCommands).toEqual([]);
    expect(harness.transport.dispatched).toEqual([]);
  });

  it("falls back to the recovered root when the focus anchor is missing", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-root", "html", true),
      node("old-focused", "button.missing"),
    ]));
    harness.view.focus("old-focused");
    const newRoot = node("new-root", "html");

    harness.controller.beginRecovery();
    harness.controller.installRecoveryRoot(recoveryRoot(newRoot, 2));
    harness.controller.finishRecovery();

    expect(harness.controller.focusedRef).toBe("new-root");
    expect(harness.dom.activeElement).toBe(harness.dom.row("new-root"));
  });

  it("does not steal manually moved browser focus after recovery", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [
      node("old-selected", "button.save"),
    ]));
    harness.view.focus("old-selected");
    harness.controller.beginRecovery();
    const outside = harness.dom.document.createElement("button") as unknown as FakeElement;
    outside.focus();
    const newSelected = node("new-selected", "button.save");
    harness.controller.installRecoveryRoot(recoveryRoot(newSelected, 2));
    harness.controller.installRecoveredPath(
      recoveryLocator(newSelected, [newSelected], 2),
      { selected: true, expanded: false, focusIntent: "node" },
    );

    harness.controller.finishRecovery();

    expect(harness.dom.activeElement).toBe(outside);
  });

  it("moves focused recovery rows to the tree on cancel and dispose", () => {
    const canceled = createHarness();
    canceled.controller.handleEvent(selectionChanged(1, [
      node("selected", "button.save"),
    ]));
    canceled.view.focus("selected");
    canceled.controller.beginRecovery();

    canceled.controller.cancelRecovery("test cancel");

    expect(canceled.dom.activeElement).toBe(canceled.dom.element("dom-tree"));
    expect(canceled.dom.element("dom-tree").getAttribute("tabindex")).toBe("0");

    const disposed = createHarness();
    disposed.controller.handleEvent(selectionChanged(1, [
      node("selected", "button.save"),
    ]));
    disposed.view.focus("selected");
    disposed.controller.beginRecovery();

    disposed.view.dispose();

    expect(disposed.dom.activeElement).toBe(disposed.dom.element("dom-tree"));
  });

  it("removes listeners and rendered rows on disposal", () => {
    const harness = createHarness();
    harness.controller.handleEvent(selectionChanged(1, [node("root", "html")]));
    expect(harness.dom.totalListeners()).toBeGreaterThan(0);

    harness.view.dispose();
    harness.controller.handleEvent(selectionChanged(2, [node("next", "body")]));

    expect(harness.dom.totalListeners()).toBe(0);
    expect(harness.dom.element("dom-tree-spacer").children).toEqual([]);
    expect(harness.resize.disconnectCount).toBe(1);
  });

  it("keeps the narrow panel as a stable toolbar, tree, and footer grid", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../assets/panel.css", import.meta.url)),
      "utf8",
    );

    expect(css).toContain("grid-template-rows:");
    expect(css).toContain("minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 360px)");
    expect(css).not.toMatch(/gradient|border-radius:\s*(?:[89]|[1-9]\d)px/i);
  });

  it("keeps shadow and frame labels distinct at WCAG AA contrast", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../assets/panel.css", import.meta.url)),
      "utf8",
    );
    const shadow = canvasTextMix(css, "--dom-tree-shadow-text");
    const frame = canvasTextMix(css, "--dom-tree-frame-text");

    expect(shadow).toBeDefined();
    expect(frame).toBeDefined();
    expect(cssRuleColor(css, ".dom-tree-row.is-shadow-root"))
      .toBe("var(--dom-tree-shadow-text)");
    expect(cssRuleColor(css, ".dom-tree-row.is-frame-document"))
      .toBe("var(--dom-tree-frame-text)");
    expect(shadow?.accent).not.toEqual(frame?.accent);

    const themes = [
      { canvas: hexRgb("#ffffff"), canvasText: hexRgb("#000000") },
      { canvas: hexRgb("#1e1e1e"), canvasText: hexRgb("#ffffff") },
    ];
    for (const token of [shadow, frame]) {
      expect(token).toBeDefined();
      if (!token) continue;
      for (const theme of themes) {
        const foreground = mixRgb(
          theme.canvasText,
          token.accent,
          token.canvasTextWeight,
        );
        expect(contrastRatio(foreground, theme.canvas)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

function createHarness(options: {
  readonly clientHeight?: number;
  readonly rowHeight?: number;
  readonly overscan?: number;
} = {}) {
  const dom = new FakeDom(options.clientHeight ?? 120);
  const transport = new TestTransport();
  const resize = new FakeResizeObserverAdapter();
  const errors: unknown[] = [];
  const sourceCommands: Array<{
    readonly direction: "previous" | "next";
  }> = [];
  const sourceNavigation = new SourceNavigationController((command) => {
    sourceCommands.push(command);
  });
  const controller = new DomTreeController({ transport });
  const view = new DomTreeView({
    document: dom.document,
    controller,
    sourceNavigationController: sourceNavigation,
    rowHeight: options.rowHeight ?? 24,
    overscan: options.overscan ?? 2,
    createResizeObserver: (listener) => resize.create(listener),
    onError: (error) => errors.push(error),
  });
  return {
    dom,
    transport,
    controller,
    sourceNavigation,
    sourceCommands,
    view,
    resize,
    errors,
  };
}

function tabbableRows(dom: FakeDom): FakeElement[] {
  return dom.element("dom-tree-spacer").children.filter(
    (row) => row.getAttribute("tabindex") === "0",
  );
}

function clearHoverRequests(transport: TestTransport): DomRequest[] {
  return transport.dispatched.filter((request) => request.type === "dom.clearHover");
}

function node(
  nodeRef: string,
  label: string,
  expandable = false,
): DomNodeView {
  return {
    nodeRef,
    kind: "element",
    label,
    expandable,
    branchRevision: 0,
    locator: {
      version: 1,
      targetKind: "element",
      boundaries: [],
      path: [{ tagName: "div", siblingIndex: 0 }],
    },
  };
}

function selectionChanged(
  documentEpoch: number,
  ancestorPath: readonly DomNodeView[],
) {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch,
    selectionRevision: 1,
    nodeRef: ancestorPath.at(-1)?.nodeRef ?? "missing",
    ancestorPath,
  };
}

function resolution(
  overrides: Partial<ResolutionMessage> = {},
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 3,
    status: "matched",
    selectedMatchCount: 2,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
    ...overrides,
  };
}

function navigationState(
  overrides: Partial<SourceNavigationStateMessage> = {},
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: "state-1",
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 3,
    selectedMatchCount: 2,
    metadata: {},
    ...overrides,
  };
}

function childrenResponse(
  nodeRef: string,
  nodes: readonly DomNodeView[],
): DomResponse {
  return {
    type: "dom.children",
    requestId: "ignored-by-test-transport",
    documentEpoch: 1,
    nodeRef,
    branchRevision: 0,
    nodes,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type Rgb = readonly [number, number, number];

interface CanvasTextMix {
  readonly canvasTextWeight: number;
  readonly accent: Rgb;
}

function canvasTextMix(
  css: string,
  customProperty: string,
): CanvasTextMix | undefined {
  const match = new RegExp(
    `${escapeRegExp(customProperty)}\\s*:\\s*color-mix\\(` +
      "in srgb,\\s*CanvasText\\s+(\\d+(?:\\.\\d+)?)%,\\s*" +
      "(#[0-9a-f]{6})\\s*\\)",
    "i",
  ).exec(css);
  const weight = match?.[1];
  const accent = match?.[2];
  if (!weight || !accent) return undefined;
  return {
    canvasTextWeight: Number(weight) / 100,
    accent: hexRgb(accent),
  };
}

function cssRuleColor(css: string, selector: string): string | undefined {
  const rule = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`,
    "i",
  ).exec(css)?.[1];
  return /(?:^|;)\s*color:\s*([^;]+);/i.exec(rule ?? "")?.[1]?.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hexRgb(value: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid test color: ${value}`);
  }
  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ];
}

function mixRgb(primary: Rgb, accent: Rgb, primaryWeight: number): Rgb {
  const accentWeight = 1 - primaryWeight;
  return [
    primary[0] * primaryWeight + accent[0] * accentWeight,
    primary[1] * primaryWeight + accent[1] * accentWeight,
    primary[2] * primaryWeight + accent[2] * accentWeight,
  ];
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    Math.max(foregroundLuminance, backgroundLuminance) + 0.05
  ) / (
    Math.min(foregroundLuminance, backgroundLuminance) + 0.05
  );
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

class TestTransport implements DomTreeTransport {
  public readonly requests: DomRequest[] = [];
  public readonly dispatched: DomRequest[] = [];
  private readonly responses: Array<DomResponse | Promise<DomResponse>> = [];

  public enqueue(response: DomResponse | Promise<DomResponse>): void {
    this.responses.push(response);
  }

  public async request(request: DomRequest): Promise<DomResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) return {
      type: "dom.error",
      code: "internal-error",
    };
    const resolved = await response;
    return "requestId" in resolved && "requestId" in request
      ? { ...resolved, requestId: request.requestId }
      : resolved;
  }

  public dispatch(request: DomRequest): void {
    this.dispatched.push(request);
  }

  public cancelPending(): void {}
}

class FakeResizeObserverAdapter {
  public readonly observed: unknown[] = [];
  public disconnectCount = 0;
  private listener: (() => void) | undefined;

  public create(listener: () => void) {
    this.listener = listener;
    return {
      observe: (target: unknown): void => {
        this.observed.push(target);
      },
      disconnect: (): void => {
        this.disconnectCount += 1;
      },
    };
  }

  public trigger(): void {
    this.listener?.();
  }
}

class FakeDom {
  public readonly document: DomTreeDocument;
  private readonly elements = new Map<string, FakeElement>();
  private readonly tags: string[] = [];
  private readonly namespacedTags: Array<{
    readonly namespace: string;
    readonly tagName: string;
  }> = [];
  public activeElement: FakeElement | undefined;

  public constructor(clientHeight: number) {
    const tree = this.register("dom-tree");
    tree.clientHeight = clientHeight;
    tree.append(this.register("dom-tree-spacer"));
    this.register("dom-tree-empty");
    this.document = {
      getElementById: (id) => this.elements.get(id),
      createElement: (tagName) => {
        this.tags.push(tagName.toLowerCase());
        return new FakeElement(this, tagName);
      },
      createElementNS: (namespace, tagName) => {
        this.namespacedTags.push({ namespace, tagName });
        return new FakeElement(this, tagName, namespace);
      },
      get activeElement() {
        return tree.owner.activeElement;
      },
    } as unknown as DomTreeDocument;
  }

  public element(id: string): FakeElement {
    const element = this.elements.get(id);
    if (!element) {
      throw new Error(`Missing fake element: ${id}`);
    }
    return element;
  }

  public row(nodeRef: string): FakeElement {
    const row = this.element("dom-tree-spacer").findByData("nodeRef", nodeRef);
    if (!row) {
      throw new Error(`Missing rendered row: ${nodeRef}`);
    }
    return row;
  }

  public createdTags(): readonly string[] {
    return this.tags;
  }

  public createdNamespacedTags(): readonly {
    readonly namespace: string;
    readonly tagName: string;
  }[] {
    return this.namespacedTags;
  }

  public totalListeners(): number {
    return [...this.elements.values()].reduce(
      (total, element) => total + element.listenerCount(true),
      0,
    );
  }

  private register(id: string): FakeElement {
    const element = new FakeElement(this, "div");
    element.id = id;
    this.elements.set(id, element);
    return element;
  }
}

class FakeElement {
  public id = "";
  public className = "";
  public hidden = false;
  public disabled = false;
  public scrollTop = 0;
  public clientHeight = 0;
  public tabIndex = -1;
  public textContent = "";
  public readonly style: Record<string, string> = {};
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | undefined;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  public constructor(
    public readonly owner: FakeDom,
    public readonly tagName: string,
    public readonly namespaceURI?: string,
  ) {}

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "tabindex") {
      this.tabIndex = Number(value);
    }
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  public appendChild(child: FakeElement): FakeElement {
    this.append(child);
    return child;
  }

  public replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) {
      child.parentElement = undefined;
    }
    this.children.length = 0;
    this.append(...children);
  }

  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(
    type: string,
    init: { readonly key?: string; readonly target?: FakeElement } = {},
  ): FakeEvent {
    const event = new FakeEvent(type, init.target ?? this, init.key);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
    return event;
  }

  public focus(): void {
    this.owner.activeElement = this;
  }

  public contains(candidate: unknown): boolean {
    if (candidate === this) {
      return true;
    }
    return this.children.some((child) => child.contains(candidate));
  }

  public findByData(key: string, value: string): FakeElement | undefined {
    if (this.dataset[key] === value) {
      return this;
    }
    for (const child of this.children) {
      const match = child.findByData(key, value);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  public listenerCount(deep = false): number {
    const own = [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
    return deep
      ? own + this.children.reduce((total, child) => total + child.listenerCount(true), 0)
      : own;
  }
}

class FakeEvent {
  public defaultPrevented = false;
  public propagationStopped = false;

  public constructor(
    public readonly type: string,
    public readonly target: FakeElement,
    public readonly key?: string,
  ) {}

  public preventDefault(): void {
    this.defaultPrevented = true;
  }

  public stopPropagation(): void {
    this.propagationStopped = true;
  }
}

function recoveryRoot(
  root: DomNodeView,
  documentEpoch: number,
) {
  return {
    type: "dom.root" as const,
    requestId: "recovery-root",
    documentEpoch,
    node: root,
  };
}

function recoveryLocator(
  target: DomNodeView,
  ancestorPath: readonly DomNodeView[],
  documentEpoch: number,
) {
  return {
    type: "dom.locator" as const,
    requestId: "recovery-locator",
    documentEpoch,
    node: target,
    ancestorPath,
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
