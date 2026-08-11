import { describe, expect, it } from "vitest";
import {
  DomTreeController,
  type DomTreeTransport,
} from "../src/domTreeController.js";
import { DomTreeRecoveryCoordinator } from "../src/domTreeRecoveryCoordinator.js";
import type {
  DomChildrenResponse,
  DomErrorCode,
  DomLocatorResponse,
  DomNodeView,
  DomRequest,
  DomResponse,
  DomRootResponse,
  DomSelectionChangedEvent,
} from "../src/domProtocol.js";
import type { DomStableLocator } from "../src/domStableLocator.js";

describe("DomTreeRecoveryCoordinator", () => {
  it("restores an expanded selection with one locator resolution", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 3);
    const oldSelected = node("old-selected", selectedLocator, true);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [oldSelected]));
    transport.enqueue(childrenResponse(oldSelected, [], 1));
    await controller.expand(oldSelected.nodeRef);
    transport.requests.length = 0;

    const coordinator = createCoordinator(controller, transport);
    const newSelected = node("new-selected", selectedLocator, true);
    const newChild = node("new-child", locator(2, 0));
    transport.enqueue(rootResponse(newSelected, 2));
    transport.enqueue(locatorResponse(newSelected, [newSelected], 2));
    transport.enqueue(childrenResponse(newSelected, [newChild], 2));

    await coordinator.begin();

    expect(transport.requests.filter(isResolveRequest)).toHaveLength(1);
    expect(transport.requests.filter(isChildrenRequest).map((request) => (
      request.nodeRef
    ))).toEqual(["new-selected"]);
    expect(nodeRefs(controller)).toEqual(["new-selected", "new-child"]);
    expect(controller.isExpanded("new-selected")).toBe(true);
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 2,
      nodeRef: "new-selected",
    }]);
  });

  it("restores separate row focus without another locator resolution", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 0);
    const selectedLocator = locator(2, 1);
    const oldRoot = node("old-root", rootLocator, true);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      oldRoot,
      node("old-selected", selectedLocator),
    ]));
    controller.focus(oldRoot.nodeRef);
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", rootLocator, true);
    const newSelected = node("new-selected", selectedLocator);
    transport.enqueue(rootResponse(newRoot, 2));
    transport.enqueue(locatorResponse(newSelected, [newRoot, newSelected], 2));
    transport.enqueue(locatorResponse(newRoot, [newRoot], 2));
    transport.enqueue(childrenResponse(newRoot, [newSelected], 2));

    await coordinator.begin();

    expect(controller.focusedRef).toBe("new-root");
    expect(transport.requests.filter(isResolveRequest)).toHaveLength(2);
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 2,
      nodeRef: "new-selected",
    }]);
  });

  it("restores a focused load-more row after hydrating its recovered branch", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 0);
    const oldRoot = node("old-root", rootLocator, true);
    transport.enqueue(rootResponse(oldRoot, 1));
    transport.enqueue(childrenResponse(oldRoot, [], 1, "old-next"));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(oldRoot.nodeRef);
    const oldLoadMore = controller.rows().find((row) => row.type === "load-more");
    if (!oldLoadMore) {
      throw new Error("Missing old load-more row");
    }
    controller.focus(oldLoadMore.nodeRef);
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", rootLocator, true);
    transport.enqueue(rootResponse(newRoot, 2));
    transport.enqueue(locatorResponse(newRoot, [newRoot], 2));
    transport.enqueue(childrenResponse(newRoot, [], 2, "new-next"));

    await coordinator.begin();

    const newLoadMore = controller.rows().find((row) => row.type === "load-more");
    expect(newLoadMore).toMatchObject({ parentRef: "new-root", focused: true });
    expect(controller.focusedRef).toBe(newLoadMore?.nodeRef);
    expect(transport.requests.filter(isResolveRequest)).toHaveLength(1);
    expect(transport.dispatched).toEqual([]);
  });

  it("resolves selection first, tolerates an expanded failure, and swaps once", async () => {
    const transport = new TestTransport();
    const observedRows: string[][] = [];
    const controller = createController(transport, () => {
      observedRows.push(nodeRefs(controller));
    });
    const rootLocator = locator(1, 0);
    const parentLocator = locator(2, 1);
    const selectedLocator = locator(3, 2);
    controller.handleEvent(selectionEvent(1, [
      node("old-root", rootLocator, true),
      node("old-parent", parentLocator, true),
      node("old-selected", selectedLocator),
    ]));
    observedRows.length = 0;
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", rootLocator, true);
    const newParent = node("new-parent", parentLocator, true);
    const newSelected = node("new-selected", selectedLocator);
    transport.enqueue(rootResponse(newRoot, 7));
    transport.enqueue(locatorResponse(newSelected, [
      newRoot,
      newParent,
      newSelected,
    ], 7));
    transport.enqueue(errorResponse("node-unavailable"));
    transport.enqueue(locatorResponse(newParent, [newRoot, newParent], 7));
    transport.enqueue(childrenResponse(newRoot, [newParent], 7));
    transport.enqueue(childrenResponse(newParent, [newSelected], 7));

    await coordinator.begin();

    expect(transport.requests.filter(isResolveRequest).map((request) => (
      request.locator
    ))).toEqual([selectedLocator, rootLocator, parentLocator]);
    expect(transport.requests.filter(isChildrenRequest).map((request) => (
      request.nodeRef
    ))).toEqual(["new-root", "new-parent"]);
    expect(nodeRefs(controller)).toEqual([
      "new-root",
      "new-parent",
      "new-selected",
    ]);
    expect(controller.snapshot()).toMatchObject({
      recovering: false,
      selectedRef: "new-selected",
      documentEpoch: 7,
    });
    expect(observedRows).toEqual([
      ["old-root", "old-parent", "old-selected"],
      ["new-root", "new-parent", "new-selected"],
    ]);
    expect(observedRows).not.toContainEqual(["new-root"]);
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 7,
      nodeRef: "new-selected",
    }]);
  });

  it("orders mixed expanded locators by boundary-aware depth", async () => {
    const transport = new TestTransport();
    const normalLocator = locator(3, 1);
    const shadowLocator = locatorWithBoundaries(
      [{ kind: "shadow-root", hostDepth: 1 }],
      2,
      2,
    );
    const frameLocator = locatorWithBoundaries([
      { kind: "frame-document", hostDepth: 1 },
      { kind: "shadow-root", hostDepth: 1 },
    ], 1, 3);
    const selectedLocator = locator(6, 4);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-frame", frameLocator, true),
      node("old-shadow", shadowLocator, true),
      node("old-normal", normalLocator, true),
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    transport.enqueue(rootResponse(node("new-root", locator(1, 0)), 2));
    for (let index = 0; index < 4; index += 1) {
      transport.enqueue(errorResponse("node-unavailable"));
    }

    await coordinator.begin();

    expect(transport.requests.filter(isResolveRequest).map((request) => (
      request.locator
    ))).toEqual([
      selectedLocator,
      normalLocator,
      shadowLocator,
      frameLocator,
    ]);
  });

  it("finishes with a live root and no selection when selected recovery fails", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    const selectedLocator = locator(1, 4);
    controller.handleEvent(selectionEvent(3, [
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    transport.enqueue(rootResponse(node("new-root", locator(1, 0)), 4));
    transport.enqueue(errorResponse("node-unavailable"));

    await coordinator.begin();

    expect(nodeRefs(controller)).toEqual(["new-root"]);
    expect(controller.snapshot().selectedRef).toBeUndefined();
    expect(controller.snapshot().recovering).toBe(false);
    expect(transport.dispatched).toEqual([]);
  });

  it.each(["stale-document", "session-disposed"] as const)(
    "aborts when selected locator recovery returns %s",
    async (code) => {
      const transport = new TestTransport();
      const selectedLocator = locator(1, 4);
      const controller = createController(transport);
      controller.handleEvent(selectionEvent(1, [
        node("old-selected", selectedLocator),
      ]));
      const coordinator = createCoordinator(controller, transport);
      transport.enqueue(rootResponse(node("new-root", locator(1, 0)), 2));
      transport.enqueue(errorResponse(code));

      await coordinator.begin();

      expectSafeRecoveryReset(controller, transport);
    },
  );

  it.each(["stale-document", "session-disposed"] as const)(
    "aborts when expanded locator recovery returns %s",
    async (code) => {
      const transport = new TestTransport();
      const rootLocator = locator(1, 0);
      const oldRoot = node("old-root", rootLocator, true);
      transport.enqueue(rootResponse(oldRoot, 1));
      transport.enqueue(childrenResponse(oldRoot, [], 1));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(oldRoot.nodeRef);
      const coordinator = createCoordinator(controller, transport);
      transport.enqueue(rootResponse(node("new-root", rootLocator, true), 2));
      transport.enqueue(errorResponse(code));

      await coordinator.begin();

      expectSafeRecoveryReset(controller, transport);
    },
  );

  it.each(["stale-document", "session-disposed"] as const)(
    "aborts when selected branch hydration returns %s",
    async (code) => {
      const transport = new TestTransport();
      const selectedLocator = locator(1, 3);
      const oldSelected = node("old-selected", selectedLocator, true);
      const controller = createController(transport);
      controller.handleEvent(selectionEvent(1, [oldSelected]));
      transport.enqueue(childrenResponse(oldSelected, [], 1));
      await controller.expand(oldSelected.nodeRef);
      const coordinator = createCoordinator(controller, transport);
      const newSelected = node("new-selected", selectedLocator, true);
      transport.enqueue(rootResponse(newSelected, 2));
      transport.enqueue(locatorResponse(newSelected, [newSelected], 2));
      transport.enqueue(errorResponse(code));

      await coordinator.begin();

      expectSafeRecoveryReset(controller, transport);
    },
  );

  it.each(["stale-document", "session-disposed"] as const)(
    "aborts when expanded branch hydration returns %s",
    async (code) => {
      const transport = new TestTransport();
      const rootLocator = locator(1, 0);
      const oldRoot = node("old-root", rootLocator, true);
      transport.enqueue(rootResponse(oldRoot, 1));
      transport.enqueue(childrenResponse(oldRoot, [], 1));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(oldRoot.nodeRef);
      const coordinator = createCoordinator(controller, transport);
      const newRoot = node("new-root", rootLocator, true);
      transport.enqueue(rootResponse(newRoot, 2));
      transport.enqueue(locatorResponse(newRoot, [newRoot], 2));
      transport.enqueue(errorResponse(code));

      await coordinator.begin();

      expectSafeRecoveryReset(controller, transport);
    },
  );

  it("aborts and reports a locator transport ownership failure", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 4);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const failedLocator = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("new-root", locator(1, 0)), 2));
    transport.enqueue(failedLocator.promise);
    const recovery = coordinator.begin();
    await waitForRequests(transport, 2);
    failedLocator.reject(new Error("locator session closed"));

    await expect(recovery).rejects.toThrow("locator session closed");
    expectSafeRecoveryReset(controller, transport);
  });

  it("aborts a partial locator code from a mismatched document", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 4);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    transport.enqueue(rootResponse(node("new-root", locator(1, 0)), 2));
    transport.enqueue(errorResponse("node-unavailable", 99));

    await coordinator.begin();

    expectSafeRecoveryReset(controller, transport);
  });

  it("aborts a locator path owned by another replacement root", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(2, 4);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", locator(1, 0));
    const foreignRoot = node("foreign-root", locator(1, 8), true);
    const foreignSelected = node("foreign-selected", selectedLocator);
    transport.enqueue(rootResponse(newRoot, 2));
    transport.enqueue(locatorResponse(foreignSelected, [
      foreignRoot,
      foreignSelected,
    ], 2));

    await coordinator.begin();

    expectSafeRecoveryReset(controller, transport);
  });

  it("aborts and reports a hydration transport ownership failure", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 3);
    const oldSelected = node("old-selected", selectedLocator, true);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [oldSelected]));
    transport.enqueue(childrenResponse(oldSelected, [], 1));
    await controller.expand(oldSelected.nodeRef);
    const coordinator = createCoordinator(controller, transport);
    const failedChildren = deferred<DomResponse>();
    const newSelected = node("new-selected", selectedLocator, true);
    transport.enqueue(rootResponse(newSelected, 2));
    transport.enqueue(locatorResponse(newSelected, [newSelected], 2));
    transport.enqueue(failedChildren.promise);
    const recovery = coordinator.begin();
    await waitForRequests(transport, 3);
    failedChildren.reject(new Error("children session closed"));

    await expect(recovery).rejects.toThrow("children session closed");
    expectSafeRecoveryReset(controller, transport);
  });

  it("aborts a partial branch code from a mismatched document", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 3);
    const oldSelected = node("old-selected", selectedLocator, true);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [oldSelected]));
    transport.enqueue(childrenResponse(oldSelected, [], 1));
    await controller.expand(oldSelected.nodeRef);
    const coordinator = createCoordinator(controller, transport);
    const newSelected = node("new-selected", selectedLocator, true);
    transport.enqueue(rootResponse(newSelected, 2));
    transport.enqueue(locatorResponse(newSelected, [newSelected], 2));
    transport.enqueue(errorResponse("stale-branch", 99));

    await coordinator.begin();

    expectSafeRecoveryReset(controller, transport);
  });

  it("continues hydration after an individual stale branch miss", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 0);
    const parentLocator = locator(2, 1);
    const selectedLocator = locator(3, 2);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-root", rootLocator, true),
      node("old-parent", parentLocator, true),
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", rootLocator, true);
    const newParent = node("new-parent", parentLocator, true);
    const newSelected = node("new-selected", selectedLocator);
    transport.enqueue(rootResponse(newRoot, 2));
    transport.enqueue(locatorResponse(newSelected, [
      newRoot,
      newParent,
      newSelected,
    ], 2));
    transport.enqueue(locatorResponse(newRoot, [newRoot], 2));
    transport.enqueue(locatorResponse(newParent, [newRoot, newParent], 2));
    transport.enqueue(errorResponse("stale-branch"));
    transport.enqueue(childrenResponse(newParent, [newSelected], 2));

    await coordinator.begin();

    expect(transport.requests.filter(isChildrenRequest).map((request) => (
      request.nodeRef
    ))).toEqual(["new-root", "new-parent"]);
    expect(nodeRefs(controller)).toEqual([
      "new-root",
      "new-parent",
      "new-selected",
    ]);
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 2,
      nodeRef: "new-selected",
    }]);
  });

  it("lets a manual same-epoch selection clear frozen refs and win the race", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(8, [
      node("old-selected", locator(1, 1)),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const pendingRoot = deferred<DomResponse>();
    transport.enqueue(pendingRoot.promise);
    const recovery = coordinator.begin();
    await waitForRequests(transport, 1);
    const manual = selectionEvent(8, [
      node("manual-selected", locator(1, 9)),
    ], 2);

    coordinator.handleManualSelection(manual);
    controller.handleEvent(manual);
    pendingRoot.resolve(rootResponse(node("late-root", locator(1, 0)), 8));
    await recovery;

    expect(nodeRefs(controller)).toEqual(["manual-selected"]);
    expect(controller.snapshot()).toMatchObject({
      recovering: false,
      selectedRef: "manual-selected",
      documentEpoch: 8,
    });
    expect(controller.rows().some((row) => row.nodeRef === "old-selected"))
      .toBe(false);
    expect(controller.rows().some((row) => row.nodeRef === "late-root"))
      .toBe(false);
    expect(transport.dispatched).toEqual([]);
  });

  it("does not dispatch the recovered selection after a reentrant manual finish", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 0);
    const selectedLocator = locator(2, 1);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-root", rootLocator, true),
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const newRoot = node("new-root", rootLocator, true);
    const newSelected = node("new-selected", selectedLocator);
    const manualSelected = node("manual-selected", locator(2, 2));
    let manualWon = false;
    controller.subscribe(() => {
      const snapshot = controller.snapshot();
      if (
        manualWon ||
        snapshot.recovering ||
        snapshot.selectedRef !== newSelected.nodeRef
      ) {
        return;
      }
      manualWon = true;
      const manual = selectionEvent(2, [newRoot, manualSelected], 2);
      coordinator.handleManualSelection(manual);
      controller.handleEvent(manual);
    });
    transport.enqueue(rootResponse(newRoot, 2));
    transport.enqueue(locatorResponse(newSelected, [newRoot, newSelected], 2));
    transport.enqueue(locatorResponse(newRoot, [newRoot], 2));
    transport.enqueue(childrenResponse(newRoot, [newSelected], 2));

    await coordinator.begin();

    expect(manualWon).toBe(true);
    expect(controller.snapshot().selectedRef).toBe("manual-selected");
    expect(nodeRefs(controller)).toEqual([
      "new-root",
      "new-selected",
      "manual-selected",
    ]);
    expect(transport.dispatched).toEqual([]);
  });

  it("lets a second invalidation supersede a pending root response", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("old-root", locator(1, 0)), 1));
    const controller = createController(transport);
    await controller.loadRoot();
    const coordinator = createCoordinator(controller, transport);
    const firstRoot = deferred<DomResponse>();
    transport.enqueue(firstRoot.promise);
    transport.enqueue(rootResponse(node("second-root", locator(1, 2)), 2));
    transport.enqueue(errorResponse("node-unavailable"));

    const first = coordinator.begin();
    await waitForRequests(transport, 2);
    const second = coordinator.begin();
    await second;
    firstRoot.resolve(rootResponse(node("stale-root", locator(1, 1)), 2));
    await first;

    expect(nodeRefs(controller)).toEqual(["second-root"]);
    expect(controller.snapshot().recovering).toBe(false);
  });

  it("ignores a stale locator response from a superseded attempt", async () => {
    const transport = new TestTransport();
    const selectedLocator = locator(1, 5);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const staleLocator = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("first-root", locator(1, 0)), 1));
    transport.enqueue(staleLocator.promise);
    const first = coordinator.begin();
    await waitForRequests(transport, 2);
    const secondSelected = node("second-selected", selectedLocator);
    transport.enqueue(rootResponse(secondSelected, 1));
    transport.enqueue(locatorResponse(secondSelected, [secondSelected], 1));

    const second = coordinator.begin();
    await second;
    const staleSelected = node("stale-selected", selectedLocator);
    staleLocator.resolve(locatorResponse(staleSelected, [staleSelected], 1));
    await first;

    expect(nodeRefs(controller)).toEqual(["second-selected"]);
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "second-selected",
    }]);
  });

  it("ignores a stale child page from a superseded attempt", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 0);
    const selectedLocator = locator(2, 1);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-root", rootLocator, true),
      node("old-selected", selectedLocator),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const staleChildren = deferred<DomResponse>();
    const firstRoot = node("first-root", rootLocator, true);
    const firstSelected = node("first-selected", selectedLocator);
    transport.enqueue(rootResponse(firstRoot, 1));
    transport.enqueue(locatorResponse(firstSelected, [
      firstRoot,
      firstSelected,
    ], 1));
    transport.enqueue(locatorResponse(firstRoot, [firstRoot], 1));
    transport.enqueue(staleChildren.promise);
    const first = coordinator.begin();
    await waitForRequests(transport, 4);
    const secondRoot = node("second-root", rootLocator, true);
    const secondSelected = node("second-selected", selectedLocator);
    transport.enqueue(rootResponse(secondRoot, 1));
    transport.enqueue(locatorResponse(secondSelected, [
      secondRoot,
      secondSelected,
    ], 1));
    transport.enqueue(locatorResponse(secondRoot, [secondRoot], 1));
    transport.enqueue(childrenResponse(secondRoot, [secondSelected], 1));

    const second = coordinator.begin();
    await second;
    staleChildren.resolve(childrenResponse(firstRoot, [
      node("stale-child", locator(2, 8)),
    ], 1));
    await first;

    expect(nodeRefs(controller)).toEqual(["second-root", "second-selected"]);
    expect(nodeRefs(controller)).not.toContain("stale-child");
    expect(transport.dispatched).toEqual([{
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "second-selected",
    }]);
  });

  it("clears recovery safely after a fatal root failure", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", locator(1, 1)),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const failedRoot = deferred<DomResponse>();
    transport.enqueue(failedRoot.promise);
    const recovery = coordinator.begin();
    await waitForRequests(transport, 1);
    failedRoot.reject(new Error("replacement root unavailable"));

    await expect(recovery).rejects.toThrow("replacement root unavailable");
    expect(controller.rows()).toEqual([]);
    expect(controller.snapshot().recovering).toBe(false);
    expect(transport.dispatched).toEqual([]);
  });

  it("cancels pending recovery and clears frozen refs on dispose", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("old-selected", locator(1, 1)),
    ]));
    const coordinator = createCoordinator(controller, transport);
    const pendingRoot = deferred<DomResponse>();
    transport.enqueue(pendingRoot.promise);
    const recovery = coordinator.begin();
    await waitForRequests(transport, 1);

    coordinator.dispose();
    pendingRoot.resolve(rootResponse(node("late-root", locator(1, 0)), 1));
    await recovery;

    expect(controller.rows()).toEqual([]);
    expect(controller.snapshot().recovering).toBe(false);
    expect(transport.dispatched).toEqual([]);
  });
});

function createController(
  transport: DomTreeTransport,
  onChange: () => void = () => undefined,
): DomTreeController {
  let requestId = 0;
  return new DomTreeController({
    transport,
    onChange,
    createRequestId: () => `tree-${++requestId}`,
  });
}

function createCoordinator(
  controller: DomTreeController,
  transport: TestTransport,
): DomTreeRecoveryCoordinator {
  let requestId = 0;
  return new DomTreeRecoveryCoordinator({
    controller,
    transport,
    createRequestId: () => `recovery-${++requestId}`,
  });
}

function node(
  nodeRef: string,
  stableLocator: DomStableLocator,
  expandable = false,
): DomNodeView {
  return {
    nodeRef,
    kind: "element",
    label: nodeRef,
    expandable,
    branchRevision: 0,
    locator: stableLocator,
  };
}

function locator(depth: number, siblingIndex: number): DomStableLocator {
  return {
    version: 1,
    targetKind: "element",
    boundaries: [],
    path: Array.from({ length: depth }, (_, index) => ({
      tagName: index === depth - 1 ? "div" : "section",
      siblingIndex: index === depth - 1 ? siblingIndex : 0,
    })),
  };
}

function locatorWithBoundaries(
  boundaries: readonly {
    readonly kind: "shadow-root" | "frame-document";
    readonly hostDepth: number;
  }[],
  pathDepth: number,
  siblingIndex: number,
): DomStableLocator {
  return {
    version: 1,
    targetKind: "element",
    boundaries: boundaries.map(({ kind, hostDepth }) => ({
      kind,
      hostPath: locator(hostDepth, 0).path,
    })),
    path: locator(pathDepth, siblingIndex).path,
  };
}

function selectionEvent(
  documentEpoch: number,
  ancestorPath: readonly DomNodeView[],
  selectionRevision = 1,
): DomSelectionChangedEvent {
  return {
    type: "dom.selectionChanged",
    documentEpoch,
    selectionRevision,
    nodeRef: ancestorPath.at(-1)?.nodeRef ?? "missing",
    ancestorPath,
  };
}

function rootResponse(
  root: DomNodeView,
  documentEpoch: number,
): DomRootResponse {
  return {
    type: "dom.root",
    requestId: "test-response",
    documentEpoch,
    node: root,
  };
}

function locatorResponse(
  target: DomNodeView,
  ancestorPath: readonly DomNodeView[],
  documentEpoch: number,
): DomLocatorResponse {
  return {
    type: "dom.locator",
    requestId: "test-response",
    documentEpoch,
    node: target,
    ancestorPath,
  };
}

function childrenResponse(
  parent: DomNodeView,
  nodes: readonly DomNodeView[],
  documentEpoch: number,
  nextCursor?: string,
): DomChildrenResponse {
  return {
    type: "dom.children",
    requestId: "test-response",
    documentEpoch,
    nodeRef: parent.nodeRef,
    branchRevision: parent.branchRevision,
    nodes,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function errorResponse(
  code: DomErrorCode,
  documentEpoch?: number,
): DomResponse {
  return {
    type: "dom.error",
    requestId: "test-response",
    ...(documentEpoch !== undefined ? { documentEpoch } : {}),
    code,
  };
}

function expectSafeRecoveryReset(
  controller: DomTreeController,
  transport: TestTransport,
): void {
  expect(controller.rows()).toEqual([]);
  expect(controller.snapshot().recovering).toBe(false);
  expect(controller.snapshot().selectedRef).toBeUndefined();
  expect(transport.dispatched).toEqual([]);
}

function nodeRefs(controller: DomTreeController): string[] {
  return controller.rows()
    .filter((row) => row.type === "node")
    .map((row) => row.nodeRef);
}

function isResolveRequest(
  request: DomRequest,
): request is Extract<DomRequest, { readonly type: "dom.resolveLocator" }> {
  return request.type === "dom.resolveLocator";
}

function isChildrenRequest(
  request: DomRequest,
): request is Extract<DomRequest, { readonly type: "dom.getChildren" }> {
  return request.type === "dom.getChildren";
}

class TestTransport implements DomTreeTransport {
  public readonly requests: DomRequest[] = [];
  public readonly dispatched: DomRequest[] = [];
  public readonly cancellations: string[] = [];
  private readonly responses: Array<DomResponse | Promise<DomResponse>> = [];

  public enqueue(response: DomResponse | Promise<DomResponse>): void {
    this.responses.push(response);
  }

  public async request(request: DomRequest): Promise<DomResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Missing response for ${request.type}`);
    }
    const resolved = await response;
    return "requestId" in request
      ? { ...resolved, requestId: request.requestId }
      : resolved;
  }

  public dispatch(request: DomRequest): void {
    this.dispatched.push(request);
  }

  public cancelPending(reason: string): void {
    this.cancellations.push(reason);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForRequests(
  transport: TestTransport,
  count: number,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (transport.requests.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${count} DOM requests`);
}
