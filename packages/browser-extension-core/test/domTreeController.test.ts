import { describe, expect, it, vi } from "vitest";
import {
  DomTreeController,
  type DomTreeTransport,
} from "../src/domTreeController.js";
import type {
  DomChildrenResponse,
  DomEvent,
  DomLocatorResponse,
  DomNodeView,
  DomRequest,
  DomResponse,
  DomRootResponse,
} from "../src/domProtocol.js";
import type { DomStableLocator } from "../src/domStableLocator.js";

describe("DomTreeController", () => {
  it("loads children lazily and paginates only on demand", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [node("child-1")], "page-2"));
    transport.enqueue(childrenResponse("root", 0, [node("child-2")]));
    const controller = createController(transport);

    await controller.loadRoot();
    expect(transport.requests).toHaveLength(1);

    await controller.expand("root");
    expect(nodeRefs(controller)).toEqual(["root", "child-1"]);
    expect(controller.rows().at(-1)).toMatchObject({
      type: "load-more",
      parentRef: "root",
    });

    await controller.loadMore("root");
    expect(nodeRefs(controller)).toEqual(["root", "child-1", "child-2"]);
    expect(transport.requests.at(-1)).toMatchObject({ cursor: "page-2" });
  });

  it("keeps a selected reveal child outside paginated pages until its page loads", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [node("first")], "page-2"));
    transport.enqueue(childrenResponse("root", 0, [node("selected")]));
    const controller = createController(transport);

    await controller.loadRoot();
    controller.handleEvent(selectionEvent(1, [
      node("root", true),
      node("selected"),
    ]));
    await controller.expand("root");

    expect(nodeRefs(controller)).toEqual(["root", "first", "selected"]);
    expect(controller.rows().find((row) => row.nodeRef === "selected"))
      .toMatchObject({ selected: true, focused: true });
    expect(controller.rows().at(-1)).toMatchObject({ type: "load-more" });

    await controller.loadMore("root");

    expect(nodeRefs(controller)).toEqual(["root", "first", "selected"]);
    expect(nodeRefs(controller).filter((nodeRef) => nodeRef === "selected"))
      .toHaveLength(1);
    expectSingleFocusedRow(controller, "selected");
  });

  it("keeps the selected reveal path through branch invalidation", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true, 1)));
    transport.enqueue(childrenResponse("root", 1, [node("old-sibling")]));
    transport.enqueue(childrenResponse("root", 2, [node("fresh-sibling")]));
    const controller = createController(transport);

    await controller.loadRoot();
    controller.handleEvent(selectionEvent(1, [
      node("root", true, 1),
      node("selected"),
    ]));
    await controller.expand("root");
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual(["root", "fresh-sibling", "selected"]);
    expect(controller.rows().find((row) => row.nodeRef === "selected"))
      .toMatchObject({ selected: true });
    expectSingleFocusedRow(controller, "selected");
  });

  it("notifies subscribers when the initial root finishes loading", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root")));
    const changed = vi.fn();
    const controller = createController(transport, changed);

    await controller.loadRoot();

    expect(changed).toHaveBeenCalledTimes(2);
    expect(controller.rows()).toHaveLength(1);
  });

  it("discards stale branch pages after invalidation", async () => {
    const transport = new TestTransport();
    const oldPage = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("root", true, 1)));
    transport.enqueue(oldPage.promise);
    transport.enqueue(childrenResponse("root", 2, []));
    const controller = createController(transport);

    await controller.loadRoot();
    const expanding = controller.expand("root");
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });
    oldPage.resolve(childrenResponse("root", 1, [node("stale-child")]));
    await expanding;
    await flushAsync();

    expect(nodeRefs(controller)).not.toContain("stale-child");
    expect(transport.requests.at(-1)).toMatchObject({ branchRevision: 2 });
  });

  it("does not downgrade a materialized branch with a stale selection path", () => {
    const controller = createController(new TestTransport());
    controller.handleEvent(selectionEvent(1, [
      node("root", true, 2),
      node("first"),
    ]));

    controller.handleEvent(selectionEvent(1, [
      node("root", true, 1),
      node("second"),
    ]));

    expect(controller.rows().find((row) => row.nodeRef === "root"))
      .toMatchObject({ branchRevision: 2 });
    expect(nodeRefs(controller)).toContain("second");
  });

  it("rejects old-document responses and resets rows on a new epoch", async () => {
    const transport = new TestTransport();
    const oldRoot = deferred<DomResponse>();
    transport.enqueue(oldRoot.promise);
    const controller = createController(transport);
    const loading = controller.loadRoot();

    controller.handleEvent(selectionEvent(2, [
      node("new-root", true),
      node("new-child"),
    ]));
    oldRoot.resolve(rootResponse(node("old-root"), 1));
    await loading;

    expect(controller.documentEpoch).toBe(2);
    expect(nodeRefs(controller)).toEqual(["new-root", "new-child"]);
    expect(transport.cancellations).toEqual(["DOM document changed"]);
  });

  it("reveals and focuses a page selection ancestor path", () => {
    const transport = new TestTransport();
    const changed = vi.fn();
    const controller = createController(transport, changed);

    controller.handleEvent(selectionEvent(4, [
      node("html", true),
      node("body", true),
      node("button"),
    ]));

    expect(controller.expandedRefs()).toEqual(["html", "body"]);
    expect(nodeRefs(controller)).toEqual(["html", "body", "button"]);
    expect(controller.snapshot()).toMatchObject({
      documentEpoch: 4,
      selectedRef: "button",
      focusedRef: "button",
      revealRef: "button",
      revealVersion: 1,
    });
    expect(changed).toHaveBeenCalled();
  });

  it("keeps reveal versions monotonic across document epochs", () => {
    const controller = createController(new TestTransport());
    controller.handleEvent(selectionEvent(1, [node("old")]));
    const firstVersion = controller.snapshot().revealVersion;

    controller.handleEvent(selectionEvent(2, [node("new")]));

    expect(controller.snapshot().revealVersion).toBe(firstVersion + 1);
    expect(controller.snapshot().revealRef).toBe("new");
  });

  it("implements standard tree keyboard navigation", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [
      node("parent", true),
      node("sibling"),
    ]));
    transport.enqueue(childrenResponse("parent", 0, [node("child")]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    controller.focus("parent");

    await controller.handleKey("ArrowRight");
    expect(controller.isExpanded("parent")).toBe(true);
    await controller.handleKey("ArrowRight");
    expect(controller.focusedRef).toBe("child");
    await controller.handleKey("ArrowLeft");
    expect(controller.focusedRef).toBe("parent");
    await controller.handleKey("ArrowDown");
    expect(controller.focusedRef).toBe("child");
    await controller.handleKey("Enter");

    expect(transport.dispatched.at(-1)).toEqual({
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "child",
    });
  });

  it("moves focus to a collapsed parent when its descendant was focused", () => {
    const controller = createController(new TestTransport());
    controller.handleEvent(selectionEvent(1, [
      node("root", true),
      node("parent", true),
      node("child"),
    ]));

    controller.collapse("parent");

    expect(nodeRefs(controller)).toEqual(["root", "parent"]);
    expectSingleFocusedRow(controller, "parent");
  });

  it("uses the nearest visible row when invalidation removes the focused child", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true, 1)));
    transport.enqueue(childrenResponse("root", 1, [
      node("before"),
      node("focused"),
      node("after"),
    ]));
    transport.enqueue(childrenResponse("root", 2, [
      node("before"),
      node("after"),
    ]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    controller.focus("focused");

    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });
    await flushAsync();

    expectSingleFocusedRow(controller, "after");
  });

  it("focuses actionable Load more and activates it with Enter", async () => {
    const transport = new TestTransport();
    const pendingPage = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [node("child")], "page-2"));
    transport.enqueue(pendingPage.promise);
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    const loadMoreRef = controller.rows().at(-1)?.nodeRef;
    expect(loadMoreRef).toBeDefined();
    controller.focus("child");
    await controller.handleKey("ArrowDown");
    expectSingleFocusedRow(controller, loadMoreRef ?? "missing");

    const loading = controller.handleKey("Enter");
    await flushAsync();
    const focusedWhileLoading = controller.focusedRef;
    const rowsWhileLoading = controller.rows();
    pendingPage.resolve(childrenResponse("root", 0, []));
    await loading;

    expect(transport.requests.at(-1)).toMatchObject({
      type: "dom.getChildren",
      nodeRef: "root",
      cursor: "page-2",
    });
    expect(focusedWhileLoading).toBe("child");
    expect(rowsWhileLoading.filter((row) => row.focused)).toEqual([
      expect.objectContaining({ nodeRef: "child", loading: false }),
    ]);
    expect(rowsWhileLoading.find((row) => row.type === "load-more"))
      .toMatchObject({ loading: true, focused: false });
    expect(controller.rows().some((row) => row.type === "load-more")).toBe(false);
    expectSingleFocusedRow(controller, "child");
  });

  it("focuses a loading node while skipping its loading service row", async () => {
    const transport = new TestTransport();
    const pendingChildren = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [
      node("before"),
      node("pending", true),
      node("after"),
    ]));
    transport.enqueue(pendingChildren.promise);
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    const loading = controller.expand("pending");

    controller.focus("before");
    await controller.handleKey("ArrowDown");
    expectSingleFocusedRow(controller, "pending");
    expect(controller.rows().find((row) => row.nodeRef === "pending"))
      .toMatchObject({ type: "node", loading: true });

    await controller.handleKey("ArrowDown");
    expectSingleFocusedRow(controller, "after");

    await controller.handleKey("ArrowUp");
    expectSingleFocusedRow(controller, "pending");

    await controller.handleKey("ArrowUp");
    expectSingleFocusedRow(controller, "before");

    pendingChildren.resolve(childrenResponse("pending", 0, []));
    await loading;
  });

  it("stops at the top boundary and skips a loading service row", async () => {
    const transport = new TestTransport();
    const pendingPage = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [
      node("first"),
      node("last"),
    ], "page-2"));
    transport.enqueue(pendingPage.promise);
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");

    controller.focus("root");
    await controller.handleKey("ArrowUp");
    expectSingleFocusedRow(controller, "root");

    const loading = controller.loadMore("root");
    controller.focus("last");
    await controller.handleKey("ArrowDown");
    expectSingleFocusedRow(controller, "last");

    pendingPage.resolve(childrenResponse("root", 0, []));
    await loading;
  });

  it("does not move ArrowRight into a neighboring expanded branch", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [
      node("empty", true),
      node("sibling", true),
    ]));
    transport.enqueue(childrenResponse("empty", 0, []));
    transport.enqueue(childrenResponse("sibling", 0, [node("sibling-child")]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    await controller.expand("empty");
    await controller.expand("sibling");
    controller.focus("empty");

    await controller.handleKey("ArrowRight");

    expect(controller.focusedRef).toBe("empty");
  });

  it("does not expand or request scrolling for an unmaterialized page hover", () => {
    const transport = new TestTransport();
    const controller = createController(transport);

    controller.handleEvent({
      type: "dom.hoverChanged",
      documentEpoch: 3,
      nodeRef: "unknown",
      summary: "button.save",
    });

    expect(controller.expandedRefs()).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      hoverSummary: "button.save",
      revealVersion: 0,
    });
    expect(controller.snapshot().hoveredRef).toBeUndefined();
  });

  it("does not dispatch interaction for inaccessible rows", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      node("root", true),
      { ...node("locked-frame"), inaccessible: true },
    ]));

    await controller.select("locked-frame");
    controller.hover("locked-frame");

    expect(transport.dispatched).toEqual([]);
    expect(controller.rows().find((row) => row.nodeRef === "locked-frame"))
      .toMatchObject({ kind: "element", inaccessible: true });
  });

  it("captures selected and deduplicated expanded locators shallow-to-deep", () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    const duplicateLocator = locator(2, 7);
    const selectedLocator = locator(4, 9);
    controller.handleEvent(selectionEvent(1, [
      locatedNode("root", locator(1), true),
      locatedNode("parent-a", duplicateLocator, true),
      locatedNode("parent-b", duplicateLocator, true),
      locatedNode("selected", selectedLocator),
    ]));
    const rowsBeforeRecovery = controller.rows();
    transport.cancellations.length = 0;

    const snapshot = controller.beginRecovery();

    expect(snapshot).toEqual({
      selectedLocator,
      selectedWasExpanded: false,
      expandedLocators: [locator(1), duplicateLocator],
    });
    expect(controller.snapshot().recovering).toBe(true);
    expect(controller.rows()).toBe(rowsBeforeRecovery);
    expect(transport.cancellations).toEqual(["DOM tree recovery started"]);
  });

  it("caps expanded recovery locators at 64 while retaining the selection", async () => {
    const transport = new TestTransport();
    const children = Array.from({ length: 64 }, (_, index) => (
      locatedNode(`child-${index}`, locator(2, index), true)
    ));
    transport.enqueue(rootResponse(locatedNode("root", locator(1), true)));
    transport.enqueue(childrenResponse("root", 0, children));
    for (let index = 0; index < children.length; index += 1) {
      transport.enqueue(childrenResponse(`child-${index}`, 0, []));
    }
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    for (const child of children) {
      await controller.expand(child.nodeRef);
    }
    controller.handleEvent(selectionEvent(1, [
      locatedNode("root", locator(1), true),
      children.at(-1)!,
    ]));

    const snapshot = controller.beginRecovery();

    expect(snapshot.selectedLocator).toEqual(locator(2, 63));
    expect(snapshot.selectedWasExpanded).toBe(true);
    expect(snapshot.expandedLocators).toHaveLength(64);
    expect(snapshot.expandedLocators[0]).toEqual(locator(1));
    expect(snapshot.expandedLocators.slice(1)).toEqual(
      Array.from({ length: 63 }, (_, index) => locator(2, index)),
    );
  });

  it("keeps frozen rows read-only throughout recovery", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [node("child")], "page-2"));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");
    controller.focus("child");
    controller.hover("child");
    const frozenRows = controller.rows();
    const requestCount = transport.requests.length;
    const dispatchCount = transport.dispatched.length;

    controller.beginRecovery();
    await controller.select("child");
    controller.hover("child");
    controller.clearHover();
    controller.focus("root");
    controller.collapse("root");
    await controller.expand("root");
    await controller.toggle("root");
    await controller.loadMore("root");
    await controller.handleKey("Enter");
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });

    expect(controller.rows()).toBe(frozenRows);
    expect(controller.focusedRef).toBe("child");
    expect(transport.requests).toHaveLength(requestCount);
    expect(transport.dispatched).toHaveLength(dispatchCount);
  });

  it("stages a replacement root without publishing until one atomic finish", () => {
    const transport = new TestTransport();
    const changed = vi.fn();
    const controller = createController(transport, changed);
    controller.handleEvent(selectionEvent(1, [node("old-root")]));
    const frozenRows = controller.rows();
    changed.mockClear();

    controller.beginRecovery();
    expect(changed).toHaveBeenCalledTimes(1);
    controller.installRecoveryRoot(rootResponse(node("new-root"), 2));

    expect(controller.rows()).toBe(frozenRows);
    expect(changed).toHaveBeenCalledTimes(1);

    controller.finishRecovery();

    expect(nodeRefs(controller)).toEqual(["new-root"]);
    expect(controller.snapshot().recovering).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("removes omitted recovered children after an ordinary live refresh", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [node("old-root")]));
    const root = locatedNode("new-root", locator(1), true);
    const recoveredChild = locatedNode(
      "recovered-child",
      locator(2, 1),
      true,
    );

    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(root));
    controller.installRecoveredPath(locatorResponse(root, [root]), {
      selected: false,
      expanded: true,
    });
    controller.installRecoveredPath(
      locatorResponse(recoveredChild, [root, recoveredChild]),
      { selected: false, expanded: true },
    );
    transport.enqueue(childrenResponse(root.nodeRef, 0, [recoveredChild]));
    transport.enqueue(childrenResponse(recoveredChild.nodeRef, 0, []));
    await controller.hydrateRecoveredBranches();
    controller.finishRecovery();

    expect(nodeRefs(controller)).toEqual(["new-root", "recovered-child"]);
    expect(controller.isExpanded(recoveredChild.nodeRef)).toBe(true);

    transport.enqueue(childrenResponse(root.nodeRef, 1, []));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 1 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual(["new-root"]);
    expect(controller.isExpanded(recoveredChild.nodeRef)).toBe(false);
    await controller.select(recoveredChild.nodeRef);
    expect(transport.dispatched).toEqual([]);
  });

  it("retires an omitted recovered selection when a live selection replaces it", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [node("old-root")]));
    const root = locatedNode("new-root", locator(1), true);
    const recoveredSelected = locatedNode(
      "recovered-selected",
      locator(2, 1),
      true,
    );

    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(root));
    controller.installRecoveredPath(
      locatorResponse(recoveredSelected, [root, recoveredSelected]),
      { selected: true, expanded: true },
    );
    transport.enqueue(childrenResponse(root.nodeRef, 0, [recoveredSelected]));
    transport.enqueue(childrenResponse(recoveredSelected.nodeRef, 0, []));
    await controller.hydrateRecoveredBranches();
    controller.finishRecovery();

    transport.enqueue(childrenResponse(root.nodeRef, 1, []));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 1 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual(["new-root", "recovered-selected"]);
    expect(controller.snapshot().selectedRef).toBe("recovered-selected");

    const replacement = locatedNode("replacement", locator(2, 2));
    controller.handleEvent(selectionEvent(1, [
      locatedNode("new-root", locator(1), true, 1),
      replacement,
    ]));

    expect(nodeRefs(controller)).toEqual(["new-root", "replacement"]);
    expect(controller.isExpanded(recoveredSelected.nodeRef)).toBe(false);
    await controller.select(recoveredSelected.nodeRef);
    expect(transport.dispatched).toEqual([]);
  });

  it("ignores pending responses and further actions after disposal", async () => {
    const transport = new TestTransport();
    const root = deferred<DomResponse>();
    transport.enqueue(root.promise);
    const changed = vi.fn();
    const controller = createController(transport, changed);
    const loading = controller.loadRoot();
    changed.mockClear();

    controller.dispose();
    root.resolve(rootResponse(node("late-root")));
    await loading;
    await controller.loadRoot();

    expect(controller.rows()).toEqual([]);
    expect(transport.requests).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
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

function node(
  nodeRef: string,
  expandable = false,
  branchRevision = 0,
): DomNodeView {
  return {
    nodeRef,
    kind: "element",
    label: nodeRef,
    expandable,
    branchRevision,
    locator: {
      version: 1,
      targetKind: "element",
      boundaries: [],
      path: [{ tagName: "div", siblingIndex: 0 }],
    },
  };
}

function locatedNode(
  nodeRef: string,
  stableLocator: DomStableLocator,
  expandable = false,
  branchRevision = 0,
): DomNodeView {
  return {
    ...node(nodeRef, expandable, branchRevision),
    locator: stableLocator,
  };
}

function locator(depth: number, siblingIndex = 0): DomStableLocator {
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

function rootResponse(
  root: DomNodeView,
  documentEpoch = 1,
): DomRootResponse {
  return {
    type: "dom.root",
    requestId: "ignored-by-test-transport",
    documentEpoch,
    node: root,
  };
}

function locatorResponse(
  target: DomNodeView,
  ancestorPath: readonly DomNodeView[],
  documentEpoch = 1,
): DomLocatorResponse {
  return {
    type: "dom.locator",
    requestId: "ignored-by-test-transport",
    documentEpoch,
    node: target,
    ancestorPath,
  };
}

function childrenResponse(
  nodeRef: string,
  branchRevision: number,
  nodes: readonly DomNodeView[],
  nextCursor?: string,
): DomChildrenResponse {
  return {
    type: "dom.children",
    requestId: "ignored-by-test-transport",
    documentEpoch: 1,
    nodeRef,
    branchRevision,
    nodes,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function selectionEvent(
  documentEpoch: number,
  ancestorPath: readonly DomNodeView[],
  nodeRef = ancestorPath.at(-1)?.nodeRef ?? "missing",
): DomEvent {
  return {
    type: "dom.selectionChanged",
    documentEpoch,
    selectionRevision: 1,
    nodeRef,
    ancestorPath,
  };
}

function nodeRefs(controller: DomTreeController): string[] {
  return controller.rows()
    .filter((row) => row.type === "node")
    .map((row) => row.nodeRef);
}

function expectSingleFocusedRow(
  controller: DomTreeController,
  nodeRef: string,
): void {
  expect(controller.focusedRef).toBe(nodeRef);
  expect(controller.rows().filter((row) => row.focused))
    .toEqual([expect.objectContaining({ nodeRef })]);
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
      throw new Error("Missing queued DOM response");
    }
    const resolved = await response;
    return "requestId" in resolved
      ? { ...resolved, requestId: "requestId" in request ? request.requestId : resolved.requestId }
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
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
