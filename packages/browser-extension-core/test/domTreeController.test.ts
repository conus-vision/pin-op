import { describe, expect, it, vi } from "vitest";
import {
  DomTreeController,
  type DomTreeTransport,
} from "../src/domTreeController.js";
import { DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES } from "../src/domProtocol.js";
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
  it("projects structured root auxiliaries around the recoverable element root", async () => {
    const transport = new TestTransport();
    const doctype = displayNode("doctype", "document-type", "html");
    const leading = displayNode("leading", "comment", "leading");
    const trailing = displayNode("trailing", "comment", "trailing");
    const root = node("root", true);
    transport.enqueue(rootResponse(root, 1, [doctype, leading], [trailing]));
    const controller = createController(transport);

    await controller.loadRoot();

    expect(controller.rows().map((row) => row.nodeRef)).toEqual([
      "doctype",
      "leading",
      "root",
      "trailing",
    ]);
    expect(controller.rows().map((row) => row.type === "node" ? row.node : undefined))
      .toEqual([doctype, leading, root, trailing]);
    expect(controller.rows().map((row) => row.depth)).toEqual([1, 1, 1, 1]);
  });

  it("refreshes displayed root auxiliaries after a collapsed-root invalidation", async () => {
    const transport = new TestTransport();
    const root = node("root", false, 1);
    transport.enqueue(rootResponse(root, 1, [displayNode("leading", "comment", "before")]));
    transport.enqueue(rootResponse({
      ...node("root", false, 2),
      attributes: [{ name: "data-state", value: "after" }],
    }, 1, [
      displayNode("leading", "comment", "after"),
    ]));
    const controller = createController(transport);
    await controller.loadRoot();

    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });
    await flushAsync();

    expect(transport.requests.map(({ type }) => type)).toEqual([
      "dom.getRoot",
      "dom.getRoot",
    ]);
    expect(controller.rows().map((row) => row.nodeRef)).toEqual(["leading", "root"]);
    expect(controller.rows()[0]).toMatchObject({
      node: { kind: "comment", nodeValue: "after" },
      label: "after",
    });
    expect(controller.rows()[1]).toMatchObject({
      branchRevision: 2,
      node: {
        branchRevision: 2,
        attributes: [{ name: "data-state", value: "after" }],
      },
    });
    expect(controller.isExpanded("root")).toBe(false);
  });

  it.each(["root-first", "children-first"] as const)(
    "keeps a failed root snapshot stale and independently errored when %s settles",
    async (order) => {
      const transport = new TestTransport();
      const root = {
        ...locatedNode("root", locator(1), true, 1),
        attributes: [{ name: "data-state", value: "old" }],
      };
      const oldChild = locatedNode("old-child", locator(2));
      const freshChild = locatedNode("fresh-child", locator(2, 1));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(root.nodeRef, 1, [oldChild]));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);

      const failedRoot = deferred<DomResponse>();
      const refreshedChildren = deferred<DomResponse>();
      transport.enqueue(failedRoot.promise);
      transport.enqueue(refreshedChildren.promise);
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: root.nodeRef, branchRevision: 2 }],
      });
      if (order === "root-first") {
        failedRoot.resolve({
          type: "dom.error",
          requestId: "ignored-by-test-transport",
          documentEpoch: 1,
          code: "internal-error",
        });
        await flushAsync();
        refreshedChildren.resolve(childrenResponse(root.nodeRef, 2, [freshChild]));
      } else {
        refreshedChildren.resolve(childrenResponse(root.nodeRef, 2, [freshChild]));
        await flushAsync();
        failedRoot.resolve({
          type: "dom.error",
          requestId: "ignored-by-test-transport",
          documentEpoch: 1,
          code: "internal-error",
        });
      }
      await flushAsync();

      expect(nodeRefs(controller)).toEqual([root.nodeRef, freshChild.nodeRef]);
      expect(controller.snapshot().errorCode).toBe("internal-error");
      expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
        .toMatchObject({
          branchRevision: 1,
          node: {
            branchRevision: 1,
            attributes: [{ name: "data-state", value: "old" }],
          },
        });
      const newestRoot = {
        ...locatedNode("root", locator(1), true, 3),
        attributes: [{ name: "data-state", value: "new" }],
      };
      const newestChild = locatedNode("newest-child", locator(2, 2));
      transport.enqueue(rootResponse(newestRoot));
      transport.enqueue(childrenResponse(root.nodeRef, 3, [newestChild]));
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: root.nodeRef, branchRevision: 3 }],
      });
      await flushAsync();

      expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
        .toMatchObject({
          branchRevision: 3,
          node: {
            branchRevision: 3,
            attributes: [{ name: "data-state", value: "new" }],
          },
        });
      expect(nodeRefs(controller)).toEqual([root.nodeRef, newestChild.nodeRef]);
      expect(controller.snapshot().errorCode).toBeUndefined();
    },
  );

  it.each(["rejected", "wrong-type", "request-id", "stale-revision"] as const)(
    "marks a current %s root snapshot terminal while retaining its last view",
    async (outcome) => {
      const transport = new TestTransport();
      const root = {
        ...locatedNode("root", locator(1), true, 1),
        attributes: [{ name: "data-state", value: "old" }],
      };
      const freshChild = locatedNode("fresh-child", locator(2));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(root.nodeRef, 1, []));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);

      const refreshedRoot = {
        ...locatedNode("root", locator(1), true, 2),
        attributes: [{ name: "data-state", value: "new" }],
      };
      if (outcome === "rejected") {
        transport.enqueue(Promise.reject(new Error("root rejected")));
      } else if (outcome === "wrong-type") {
        transport.enqueue(childrenResponse(root.nodeRef, 2, []));
      } else if (outcome === "request-id") {
        transport.enqueueRaw({
          ...rootResponse(refreshedRoot),
          requestId: "wrong-request",
        });
      } else {
        transport.enqueue(rootResponse(root));
      }
      transport.enqueue(childrenResponse(root.nodeRef, 2, [freshChild]));
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: root.nodeRef, branchRevision: 2 }],
      });
      await flushAsync();

      expect(controller.snapshot().errorCode).toBe("internal-error");
      expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
        .toMatchObject({
          branchRevision: 1,
          node: {
            branchRevision: 1,
            attributes: [{ name: "data-state", value: "old" }],
          },
      });
      expect(nodeRefs(controller)).toEqual([root.nodeRef, freshChild.nodeRef]);
    },
  );

  it("ignores a stale root snapshot and waits for the newest revision", async () => {
    const transport = new TestTransport();
    const root = {
      ...locatedNode("root", locator(1), true, 1),
      attributes: [{ name: "data-state", value: "old" }],
    };
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, []));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);

    const staleRoot = deferred<DomResponse>();
    transport.enqueue(staleRoot.promise);
    transport.enqueue(childrenResponse(root.nodeRef, 2, []));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();
    transport.enqueue(childrenResponse(root.nodeRef, 3, []));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 3 }],
    });
    await flushAsync();

    const newestRoot = deferred<DomResponse>();
    transport.enqueue(newestRoot.promise);
    staleRoot.resolve(rootResponse({
      ...locatedNode("root", locator(1), true, 2),
      attributes: [{ name: "data-state", value: "stale" }],
    }));
    await flushAsync();

    expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
      .toMatchObject({
        branchRevision: 1,
        node: {
          branchRevision: 1,
          attributes: [{ name: "data-state", value: "old" }],
        },
      });
    expect(controller.snapshot().errorCode).toBeUndefined();

    newestRoot.resolve(rootResponse({
      ...locatedNode("root", locator(1), true, 3),
      attributes: [{ name: "data-state", value: "new" }],
    }));
    await flushAsync();

    expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
      .toMatchObject({
        branchRevision: 3,
        node: {
          branchRevision: 3,
          attributes: [{ name: "data-state", value: "new" }],
        },
      });
    expect(controller.snapshot().errorCode).toBeUndefined();
  });

  it("refreshes a collapsed visible child's structured count from its owner branch", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true, 1)));
    transport.enqueue(childrenResponse("root", 1, [node("child", true, 1)]));
    transport.enqueue(rootResponse(node("root", true, 2)));
    transport.enqueue(childrenResponse("root", 2, [{
      ...node("child", true, 2),
      childCount: 2,
    }]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");

    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "root", branchRevision: 2 }],
    });
    await flushAsync();

    expect(controller.rows().find((row) => row.nodeRef === "child"))
      .toMatchObject({
        branchRevision: 2,
        expandable: true,
        node: { childCount: 2, branchRevision: 2 },
      });
    expect(controller.isExpanded("child")).toBe(false);
  });

  it("keeps display-only children visible but ignores selection and hover", async () => {
    const transport = new TestTransport();
    transport.enqueue(rootResponse(node("root", true)));
    const text = displayNode("text", "text", "hello");
    const comment = displayNode("comment", "comment", "note");
    transport.enqueue(childrenResponse("root", 0, [text, comment]));
    const controller = createController(transport);

    await controller.loadRoot();
    await controller.expand("root");
    await controller.select(text.nodeRef);
    controller.hover(comment.nodeRef);

    expect(nodeRefs(controller)).toEqual(["root", "text", "comment"]);
    expect(transport.dispatched).toEqual([]);
    expect(controller.rows().find((row) => row.nodeRef === text.nodeRef))
      .toMatchObject({ node: text, selectable: false, expandable: false });
  });

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
    transport.enqueue(rootResponse(node("root", true, 1), 1, [
      displayNode("leading", "comment", "before"),
    ]));
    transport.enqueue(childrenResponse("root", 1, [node("old-sibling")]));
    transport.enqueue(rootResponse(node("root", true, 2), 1, [
      displayNode("leading", "comment", "after"),
    ]));
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

    expect(nodeRefs(controller)).toEqual([
      "leading",
      "root",
      "fresh-sibling",
      "selected",
    ]);
    expect(controller.rows()[0]).toMatchObject({ node: { nodeValue: "after" } });
    expect(controller.rows().find((row) => row.nodeRef === "selected"))
      .toMatchObject({ selected: true });
    expectSingleFocusedRow(controller, "selected");
  });

  it.each(["target-first", "owner-first"] as const)(
    "retains an expanded refreshed child for %s presentation invalidation",
    async (order) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const child = locatedNode("child", locator(2), true, 1);
      const grandchild = locatedNode("grandchild", locator(3));
      const removedGrandchild = locatedNode(
        "removed-grandchild",
        locator(3, 1),
      );
      const omitted = locatedNode("omitted", locator(2, 1));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(
        root.nodeRef,
        1,
        [child, omitted],
        "old-page",
      ));
      transport.enqueue(childrenResponse(
        child.nodeRef,
        1,
        [grandchild, removedGrandchild],
      ));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(child.nodeRef);
      controller.handleEvent(selectionEvent(1, [root]));
      controller.focus(grandchild.nodeRef);

      const childRefresh = deferred<DomResponse>();
      const refreshedRoot = locatedNode("root", locator(1), true, 2);
      const refreshedChild = locatedNode("child", locator(2), true, 2);
      if (order === "target-first") {
        transport.enqueue(childRefresh.promise);
        transport.enqueue(rootResponse(refreshedRoot));
        transport.enqueue(childrenResponse(
          root.nodeRef,
          2,
          [refreshedChild],
          "fresh-page",
        ));
      } else {
        transport.enqueue(rootResponse(refreshedRoot));
        transport.enqueue(childrenResponse(
          root.nodeRef,
          2,
          [refreshedChild],
          "fresh-page",
        ));
        transport.enqueue(childRefresh.promise);
      }
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: order === "target-first"
          ? [
              { nodeRef: child.nodeRef, branchRevision: 2 },
              { nodeRef: root.nodeRef, branchRevision: 2 },
            ]
          : [
              { nodeRef: root.nodeRef, branchRevision: 2 },
              { nodeRef: child.nodeRef, branchRevision: 2 },
            ],
      });
      await flushAsync();

      expect(controller.expandedRefs()).toEqual([root.nodeRef, child.nodeRef]);
      expect(nodeRefs(controller)).toContain(grandchild.nodeRef);
      expectSingleFocusedRow(controller, grandchild.nodeRef);

      const added = locatedNode("added", locator(3, 2));
      childRefresh.resolve(childrenResponse(
        child.nodeRef,
        2,
        [grandchild, added],
      ));
      await flushAsync();

      expect(nodeRefs(controller)).not.toContain(omitted.nodeRef);
      expect(nodeRefs(controller)).not.toContain(removedGrandchild.nodeRef);
      expect(nodeRefs(controller)).toEqual([
        root.nodeRef,
        child.nodeRef,
        grandchild.nodeRef,
        added.nodeRef,
      ]);
      expect(controller.rows().find((row) => row.nodeRef === child.nodeRef))
        .toMatchObject({ expanded: true, branchRevision: 2 });
      expectSingleFocusedRow(controller, grandchild.nodeRef);
      expect(controller.snapshot().selectedRef).toBe(root.nodeRef);

      const paged = locatedNode("paged", locator(2, 2));
      transport.enqueue(childrenResponse(root.nodeRef, 2, [paged]));
      await controller.loadMore(root.nodeRef);

      expect(transport.requests.at(-1)).toMatchObject({
        type: "dom.getChildren",
        nodeRef: root.nodeRef,
        branchRevision: 2,
        cursor: "fresh-page",
      });
      expect(nodeRefs(controller)).toEqual([
        root.nodeRef,
        child.nodeRef,
        grandchild.nodeRef,
        added.nodeRef,
        paged.nodeRef,
      ]);
      expectSingleFocusedRow(controller, grandchild.nodeRef);

      expect(controller.beginRecovery()).toEqual({
        selectedLocator: locator(1),
        selectedWasExpanded: true,
        focusAnchor: { locator: locator(3), rowType: "node" },
        expandedLocators: [locator(1), locator(2)],
      });
    },
  );

  it("discards a late stale child page while retaining its refreshed expansion", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const child = locatedNode("child", locator(2), true, 1);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [child]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);

    const stalePage = deferred<DomResponse>();
    transport.enqueue(stalePage.promise);
    const staleExpansion = controller.expand(child.nodeRef);
    await flushAsync();

    const refreshedRoot = locatedNode("root", locator(1), true, 2);
    const refreshedChild = locatedNode("child", locator(2), true, 2);
    const freshGrandchild = locatedNode("fresh-grandchild", locator(3));
    transport.enqueue(childrenResponse(
      child.nodeRef,
      2,
      [freshGrandchild],
    ));
    transport.enqueue(rootResponse(refreshedRoot));
    transport.enqueue(childrenResponse(root.nodeRef, 2, [refreshedChild]));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [
        { nodeRef: child.nodeRef, branchRevision: 2 },
        { nodeRef: root.nodeRef, branchRevision: 2 },
      ],
    });
    await flushAsync();

    stalePage.resolve(childrenResponse(child.nodeRef, 1, [
      locatedNode("stale-grandchild", locator(3, 1)),
    ]));
    await staleExpansion;
    await flushAsync();

    expect(controller.expandedRefs()).toEqual([root.nodeRef, child.nodeRef]);
    expect(nodeRefs(controller)).toContain(freshGrandchild.nodeRef);
    expect(nodeRefs(controller)).not.toContain("stale-grandchild");
    expect(controller.rows().find((row) => row.nodeRef === child.nodeRef))
      .toMatchObject({ expanded: true, branchRevision: 2 });
  });

  it("fails closed with a focused retry row after a current first-page error", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const staleParent = locatedNode("stale-parent", locator(2), true, 1);
    const staleLeaf = locatedNode("stale-leaf", locator(3));
    const revealed = locatedNode("revealed", locator(2, 2));
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [
      locatedNode("stale-before", locator(2, 1)),
      staleParent,
    ]));
    transport.enqueue(childrenResponse(
      staleParent.nodeRef,
      1,
      [staleLeaf],
    ));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(staleParent.nodeRef);
    controller.handleEvent(selectionEvent(1, [root, revealed]));
    controller.focus(staleLeaf.nodeRef);

    transport.enqueue(rootResponse(locatedNode("root", locator(1), true, 2)));
    transport.enqueue({
      type: "dom.error",
      requestId: "ignored-by-test-transport",
      documentEpoch: 1,
      code: "internal-error",
    });
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual([root.nodeRef, revealed.nodeRef]);
    expect(controller.expandedRefs()).toEqual([root.nodeRef]);
    expect(controller.snapshot()).toMatchObject({
      selectedRef: revealed.nodeRef,
      errorCode: "internal-error",
    });
    const retryRow = controller.rows().find((row) => row.type === "load-more");
    expect(retryRow).toMatchObject({
      parentRef: root.nodeRef,
      label: "Load children",
      loading: false,
      focused: true,
    });

    const fresh = locatedNode("fresh", locator(2, 3));
    transport.enqueue(childrenResponse(root.nodeRef, 2, [fresh]));
    await controller.handleKey("Enter");

    expect(nodeRefs(controller)).toEqual([
      root.nodeRef,
      fresh.nodeRef,
      revealed.nodeRef,
    ]);
    expect(controller.snapshot().errorCode).toBeUndefined();
    expect(controller.beginRecovery()).toMatchObject({
      selectedLocator: revealed.locator,
      selectedWasExpanded: false,
      focusAnchor: { locator: revealed.locator, rowType: "node" },
      expandedLocators: [root.locator],
    });
  });

  it.each([
    ["rejected request", "rejected"],
    ["wrong response type", "wrong-type"],
    ["mismatched request", "request-id"],
    ["mismatched document", "document-epoch"],
    ["mismatched parent", "parent-ref"],
    ["mismatched revision", "branch-revision"],
  ] as const)(
    "fails closed after a current first-page %s",
    async (_label, outcome) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const parent = locatedNode("parent", locator(2), true, 1);
      const staleBefore = locatedNode("stale-before", locator(3, 2));
      const staleLeaf = locatedNode("stale-leaf", locator(3));
      const revealed = locatedNode("revealed", locator(3, 1));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(root.nodeRef, 1, [parent]));
      transport.enqueue(childrenResponse(
        parent.nodeRef,
        1,
        [staleBefore, staleLeaf],
      ));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(parent.nodeRef);
      controller.handleEvent(selectionEvent(1, [root, parent, revealed]));
      controller.focus(staleLeaf.nodeRef);

      const response = childrenResponse(parent.nodeRef, 2, []);
      switch (outcome) {
        case "rejected":
          transport.enqueue(Promise.reject(new Error("children rejected")));
          break;
        case "wrong-type":
          transport.enqueue(rootResponse(root));
          break;
        case "request-id":
          transport.enqueueRaw({ ...response, requestId: "wrong-request" });
          break;
        case "document-epoch":
          transport.enqueue({ ...response, documentEpoch: 2 });
          break;
        case "parent-ref":
          transport.enqueue({ ...response, nodeRef: "other-parent" });
          break;
        case "branch-revision":
          transport.enqueue({ ...response, branchRevision: 3 });
          break;
      }
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: parent.nodeRef, branchRevision: 2 }],
      });
      await flushAsync();

      expect(nodeRefs(controller)).toEqual([
        root.nodeRef,
        parent.nodeRef,
        revealed.nodeRef,
      ]);
      expect(controller.expandedRefs()).toEqual([root.nodeRef, parent.nodeRef]);
      expect(controller.snapshot()).toMatchObject({
        selectedRef: revealed.nodeRef,
        errorCode: "internal-error",
      });
      expect(controller.rows().find((row) => row.type === "load-more"))
        .toMatchObject({
          parentRef: parent.nodeRef,
          label: "Load children",
          loading: false,
          focused: true,
        });
      expect(controller.beginRecovery()).toMatchObject({
        selectedLocator: revealed.locator,
        focusAnchor: { locator: parent.locator, rowType: "load-more" },
      });
    },
  );

  it("ignores a superseded first-page terminal response without quarantining fresh rows", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const parent = locatedNode("parent", locator(2), true, 1);
    const staleLeaf = locatedNode("stale-leaf", locator(3));
    const freshLeaf = locatedNode("fresh-leaf", locator(3, 1));
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [parent]));
    transport.enqueue(childrenResponse(parent.nodeRef, 1, [staleLeaf]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(parent.nodeRef);

    const staleResponse = deferred<DomResponse>();
    transport.enqueue(staleResponse.promise);
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: parent.nodeRef, branchRevision: 2 }],
    });
    transport.enqueue(childrenResponse(parent.nodeRef, 3, [freshLeaf]));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: parent.nodeRef, branchRevision: 3 }],
    });
    await flushAsync();

    staleResponse.resolve({
      ...childrenResponse(parent.nodeRef, 2, []),
      documentEpoch: 99,
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual([
      root.nodeRef,
      parent.nodeRef,
      freshLeaf.nodeRef,
    ]);
    expect(controller.snapshot().errorCode).toBeUndefined();
    expect(controller.rows().some((row) => row.type === "load-more")).toBe(false);
  });

  it.each(["source-first", "destination-first"] as const)(
    "retains one destination-owned moved subtree when %s refresh resolves",
    async (order) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const source = locatedNode("source", locator(2), true, 1);
      const destination = locatedNode("destination", locator(2, 1), true, 1);
      const moved = locatedNode("moved", locator(3), true, 1);
      const movedLeaf = locatedNode("moved-leaf", locator(4));
      const deleted = locatedNode("deleted", locator(3, 1));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(
        root.nodeRef,
        1,
        [source, destination],
      ));
      transport.enqueue(childrenResponse(
        source.nodeRef,
        1,
        [moved, deleted],
      ));
      transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
      transport.enqueue(childrenResponse(moved.nodeRef, 1, [movedLeaf]));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(source.nodeRef);
      await controller.expand(destination.nodeRef);
      await controller.expand(moved.nodeRef);
      controller.handleEvent(selectionEvent(1, [root]));
      controller.focus(movedLeaf.nodeRef);

      const delayed = deferred<DomResponse>();
      const movedAtDestination = locatedNode(
        moved.nodeRef,
        locator(3, 2),
        true,
        1,
      );
      if (order === "source-first") {
        transport.enqueue(childrenResponse(source.nodeRef, 2, []));
        transport.enqueue(delayed.promise);
      } else {
        transport.enqueue(delayed.promise);
        transport.enqueue(childrenResponse(
          destination.nodeRef,
          2,
          [movedAtDestination],
        ));
      }
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [
          { nodeRef: source.nodeRef, branchRevision: 2 },
          { nodeRef: destination.nodeRef, branchRevision: 2 },
        ],
      });
      await flushAsync();

      if (order === "source-first") {
        controller.hover(moved.nodeRef);
        await controller.select(moved.nodeRef);
        controller.hover(movedLeaf.nodeRef);
        await controller.select(movedLeaf.nodeRef);
        expect(transport.dispatched).toEqual([]);
      }

      delayed.resolve(order === "source-first"
        ? childrenResponse(destination.nodeRef, 2, [movedAtDestination])
        : childrenResponse(source.nodeRef, 2, []));
      await flushAsync();

      const movedRows = controller.rows().filter((row) => (
        row.type === "node" && row.nodeRef === moved.nodeRef
      ));
      expect(movedRows).toEqual([
        expect.objectContaining({
          parentRef: destination.nodeRef,
          expanded: true,
        }),
      ]);
      expect(controller.rows().find((row) => row.nodeRef === movedLeaf.nodeRef))
        .toMatchObject({ parentRef: moved.nodeRef, focused: true });
      expect(nodeRefs(controller)).toEqual([
        root.nodeRef,
        source.nodeRef,
        destination.nodeRef,
        moved.nodeRef,
        movedLeaf.nodeRef,
      ]);
      expect(nodeRefs(controller)).not.toContain(deleted.nodeRef);
      expect(controller.isExpanded(deleted.nodeRef)).toBe(false);
      controller.hover(moved.nodeRef);
      await controller.select(moved.nodeRef);
      expect(transport.dispatched).toEqual([
        {
          type: "dom.hover",
          documentEpoch: 1,
          nodeRef: moved.nodeRef,
        },
        {
          type: "dom.select",
          documentEpoch: 1,
          nodeRef: moved.nodeRef,
        },
      ]);
      expect(controller.beginRecovery()).toEqual({
        selectedLocator: root.locator,
        selectedWasExpanded: true,
        focusAnchor: { locator: movedLeaf.locator, rowType: "node" },
        expandedLocators: [
          root.locator,
          source.locator,
          destination.locator,
          movedAtDestination.locator,
        ],
      });
    },
  );

  it.each(["source-first", "destination-first"] as const)(
    "reconciles a moved subtree across synchronous invalidation chunks when %s refresh resolves",
    async (order) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const source = locatedNode("source", locator(2), true, 1);
      const destination = locatedNode("destination", locator(2, 1), true, 1);
      const moved = locatedNode("moved", locator(3), true, 1);
      const movedLeaf = locatedNode("moved-leaf", locator(4));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(
        root.nodeRef,
        1,
        [source, destination],
      ));
      transport.enqueue(childrenResponse(source.nodeRef, 1, [moved]));
      transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
      transport.enqueue(childrenResponse(moved.nodeRef, 1, [movedLeaf]));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(source.nodeRef);
      await controller.expand(destination.nodeRef);
      await controller.expand(moved.nodeRef);
      controller.handleEvent(selectionEvent(1, [root]));
      controller.focus(movedLeaf.nodeRef);

      const delayed = deferred<DomResponse>();
      const movedAtDestination = locatedNode(
        moved.nodeRef,
        locator(3, 2),
        true,
        1,
      );
      if (order === "source-first") {
        transport.enqueue(childrenResponse(source.nodeRef, 2, []));
        transport.enqueue(delayed.promise);
      } else {
        transport.enqueue(delayed.promise);
        transport.enqueue(childrenResponse(
          destination.nodeRef,
          2,
          [movedAtDestination],
        ));
      }
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [
          ...Array.from(
            { length: DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES - 1 },
            (_, index) => ({
              nodeRef: `padding-${index}`,
              branchRevision: 2,
            }),
          ),
          { nodeRef: source.nodeRef, branchRevision: 2 },
        ],
      });
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: destination.nodeRef, branchRevision: 2 }],
      });
      await flushAsync();

      delayed.resolve(order === "source-first"
        ? childrenResponse(destination.nodeRef, 2, [movedAtDestination])
        : childrenResponse(source.nodeRef, 2, []));
      await flushAsync();

      expect(controller.rows().filter((row) => row.nodeRef === moved.nodeRef))
        .toEqual([
          expect.objectContaining({
            parentRef: destination.nodeRef,
            expanded: true,
          }),
        ]);
      expect(controller.rows().find((row) => row.nodeRef === movedLeaf.nodeRef))
        .toMatchObject({ parentRef: moved.nodeRef, focused: true });
      expect(controller.snapshot().selectedRef).toBe(root.nodeRef);
      expect(controller.beginRecovery()).toEqual({
        selectedLocator: root.locator,
        selectedWasExpanded: true,
        focusAnchor: { locator: movedLeaf.locator, rowType: "node" },
        expandedLocators: [
          root.locator,
          source.locator,
          destination.locator,
          movedAtDestination.locator,
        ],
      });
    },
  );

  it.each([
    ["source-first", "moved-root"],
    ["destination-first", "moved-root"],
    ["source-first", "moved-descendant"],
    ["destination-first", "moved-descendant"],
  ] as const)(
    "transfers a selected node after a %s %s refresh",
    async (order, selectedKind) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const source = locatedNode("source", locator(2), true, 1);
      const destination = locatedNode("destination", locator(2, 1), true, 1);
      const moved = locatedNode("moved", locator(3), true, 1);
      const movedLeaf = locatedNode("moved-leaf", locator(4));
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(
        root.nodeRef,
        1,
        [source, destination],
      ));
      transport.enqueue(childrenResponse(source.nodeRef, 1, [moved]));
      transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
      transport.enqueue(childrenResponse(moved.nodeRef, 1, [movedLeaf]));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(source.nodeRef);
      await controller.expand(destination.nodeRef);
      await controller.expand(moved.nodeRef);
      const selected = selectedKind === "moved-root" ? moved : movedLeaf;
      controller.handleEvent(selectionEvent(1, selectedKind === "moved-root"
        ? [root, source, moved]
        : [root, source, moved, movedLeaf]));

      const delayed = deferred<DomResponse>();
      const movedAtDestination = locatedNode(
        moved.nodeRef,
        locator(3, 2),
        true,
        1,
      );
      if (order === "source-first") {
        transport.enqueue(childrenResponse(source.nodeRef, 2, []));
        transport.enqueue(delayed.promise);
      } else {
        transport.enqueue(delayed.promise);
        transport.enqueue(childrenResponse(
          destination.nodeRef,
          2,
          [movedAtDestination],
        ));
      }
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [
          { nodeRef: source.nodeRef, branchRevision: 2 },
          { nodeRef: destination.nodeRef, branchRevision: 2 },
        ],
      });
      await flushAsync();

      delayed.resolve(order === "source-first"
        ? childrenResponse(destination.nodeRef, 2, [movedAtDestination])
        : childrenResponse(source.nodeRef, 2, []));
      await flushAsync();

      expect(controller.rows().filter((row) => row.nodeRef === moved.nodeRef))
        .toEqual([
          expect.objectContaining({
            parentRef: destination.nodeRef,
            selected: selectedKind === "moved-root",
          }),
        ]);
      expect(controller.rows().find((row) => row.nodeRef === movedLeaf.nodeRef))
        .toMatchObject({
          parentRef: moved.nodeRef,
          selected: selectedKind === "moved-descendant",
        });
      expect(controller.snapshot().selectedRef).toBe(selected.nodeRef);
      expect(controller.beginRecovery()).toMatchObject({
        selectedLocator: selectedKind === "moved-root"
          ? movedAtDestination.locator
          : movedLeaf.locator,
        focusAnchor: {
          locator: selectedKind === "moved-root"
            ? movedAtDestination.locator
            : movedLeaf.locator,
          rowType: "node",
        },
      });
    },
  );

  it.each(["stale", "dispose"] as const)(
    "does not retain deferred move candidates after %s settlement",
    async (outcome) => {
      const transport = new TestTransport();
      const root = locatedNode("root", locator(1), true, 1);
      const source = locatedNode("source", locator(2), true, 1);
      const destination = locatedNode("destination", locator(2, 1), true, 1);
      const moved = locatedNode("moved", locator(3), true, 1);
      transport.enqueue(rootResponse(root));
      transport.enqueue(childrenResponse(
        root.nodeRef,
        1,
        [source, destination],
      ));
      transport.enqueue(childrenResponse(source.nodeRef, 1, [moved]));
      transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
      const controller = createController(transport);
      await controller.loadRoot();
      await controller.expand(root.nodeRef);
      await controller.expand(source.nodeRef);
      await controller.expand(destination.nodeRef);
      controller.focus(moved.nodeRef);

      const staleDestination = deferred<DomResponse>();
      transport.enqueue(childrenResponse(source.nodeRef, 2, []));
      transport.enqueue(staleDestination.promise);
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [
          { nodeRef: source.nodeRef, branchRevision: 2 },
          { nodeRef: destination.nodeRef, branchRevision: 2 },
        ],
      });
      await flushAsync();

      if (outcome === "dispose") {
        controller.dispose();
      } else {
        controller.collapse(destination.nodeRef);
        controller.handleEvent({
          type: "dom.invalidated",
          documentEpoch: 1,
          branches: [{
            nodeRef: destination.nodeRef,
            branchRevision: 3,
          }],
        });
      }
      staleDestination.resolve(childrenResponse(destination.nodeRef, 2, [moved]));
      await flushAsync();

      expect(nodeRefs(controller)).not.toContain(moved.nodeRef);
      expect(controller.expandedRefs()).not.toContain(moved.nodeRef);
      await controller.select(moved.nodeRef);
      expect(transport.dispatched).toEqual([]);
      if (outcome === "dispose") {
        expect(controller.rows()).toEqual([]);
      }
    },
  );

  it("does not let an unrelated hanging refresh retain repeated deletions", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const source = locatedNode("source", locator(2), true, 1);
    const unrelated = locatedNode("unrelated", locator(2, 1), true, 1);
    let candidate = locatedNode("candidate-0", locator(3), true, 1);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [source, unrelated]));
    transport.enqueue(childrenResponse(source.nodeRef, 1, [candidate]));
    transport.enqueue(childrenResponse(candidate.nodeRef, 1, []));
    transport.enqueue(childrenResponse(unrelated.nodeRef, 1, []));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(source.nodeRef);
    await controller.expand(candidate.nodeRef);
    await controller.expand(unrelated.nodeRef);

    const hanging = deferred<DomResponse>();
    transport.enqueue(hanging.promise);
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: unrelated.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();

    for (let revision = 2; revision <= 12; revision += 1) {
      const next = revision === 12
        ? undefined
        : locatedNode(`candidate-${revision - 1}`, locator(3, revision), true, 1);
      transport.enqueue(childrenResponse(
        source.nodeRef,
        revision,
        next ? [next] : [],
      ));
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: source.nodeRef, branchRevision: revision }],
      });
      await flushAsync();
      if (next) {
        transport.enqueue(childrenResponse(next.nodeRef, 1, []));
        await controller.expand(next.nodeRef);
        candidate = next;
      }
    }

    expect(nodeRefs(controller)).toEqual([
      root.nodeRef,
      source.nodeRef,
      unrelated.nodeRef,
    ]);
    expect(controller.expandedRefs()).toEqual([
      root.nodeRef,
      source.nodeRef,
      unrelated.nodeRef,
    ]);
    expect(controller.isExpanded(candidate.nodeRef)).toBe(false);

    controller.dispose();
    hanging.resolve(childrenResponse(unrelated.nodeRef, 2, []));
    await flushAsync();
  });

  it("releases a re-owned move candidate while another batch claimant hangs", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const source = locatedNode("source", locator(2), true, 1);
    const destination = locatedNode("destination", locator(2, 1), true, 1);
    const blocker = locatedNode("blocker", locator(2, 2), true, 1);
    const moved = locatedNode("moved", locator(3), true, 1);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(
      root.nodeRef,
      1,
      [source, destination, blocker],
    ));
    transport.enqueue(childrenResponse(source.nodeRef, 1, [moved]));
    transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
    transport.enqueue(childrenResponse(blocker.nodeRef, 1, []));
    transport.enqueue(childrenResponse(moved.nodeRef, 1, []));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(source.nodeRef);
    await controller.expand(destination.nodeRef);
    await controller.expand(blocker.nodeRef);
    await controller.expand(moved.nodeRef);

    const hanging = deferred<DomResponse>();
    const movedAtDestination = locatedNode(
      moved.nodeRef,
      locator(3, 1),
      true,
      1,
    );
    transport.enqueue(childrenResponse(source.nodeRef, 2, []));
    transport.enqueue(childrenResponse(
      destination.nodeRef,
      2,
      [movedAtDestination],
    ));
    transport.enqueue(hanging.promise);
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [
        { nodeRef: source.nodeRef, branchRevision: 2 },
        { nodeRef: destination.nodeRef, branchRevision: 2 },
        { nodeRef: blocker.nodeRef, branchRevision: 2 },
      ],
    });
    await flushAsync();

    expect(controller.rows().filter((row) => row.nodeRef === moved.nodeRef))
      .toEqual([expect.objectContaining({ parentRef: destination.nodeRef })]);
    controller.hover(moved.nodeRef);
    await controller.select(moved.nodeRef);
    expect(transport.dispatched).toEqual([
      { type: "dom.hover", documentEpoch: 1, nodeRef: moved.nodeRef },
      { type: "dom.select", documentEpoch: 1, nodeRef: moved.nodeRef },
    ]);

    hanging.resolve(childrenResponse(blocker.nodeRef, 2, []));
    await flushAsync();
  });

  it("keeps overlapping move batches from settling each other's candidates", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const sourceA = locatedNode("source-a", locator(2), true, 1);
    const destinationA = locatedNode("destination-a", locator(2, 1), true, 1);
    const sourceB = locatedNode("source-b", locator(2, 2), true, 1);
    const destinationB = locatedNode("destination-b", locator(2, 3), true, 1);
    const movedA = locatedNode("moved-a", locator(3), true, 1);
    const movedB = locatedNode("moved-b", locator(3, 1), true, 1);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(
      root.nodeRef,
      1,
      [sourceA, destinationA, sourceB, destinationB],
    ));
    transport.enqueue(childrenResponse(sourceA.nodeRef, 1, [movedA]));
    transport.enqueue(childrenResponse(destinationA.nodeRef, 1, []));
    transport.enqueue(childrenResponse(sourceB.nodeRef, 1, [movedB]));
    transport.enqueue(childrenResponse(destinationB.nodeRef, 1, []));
    transport.enqueue(childrenResponse(movedA.nodeRef, 1, []));
    transport.enqueue(childrenResponse(movedB.nodeRef, 1, []));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(sourceA.nodeRef);
    await controller.expand(destinationA.nodeRef);
    await controller.expand(sourceB.nodeRef);
    await controller.expand(destinationB.nodeRef);
    await controller.expand(movedA.nodeRef);
    await controller.expand(movedB.nodeRef);

    const delayedA = deferred<DomResponse>();
    transport.enqueue(childrenResponse(sourceA.nodeRef, 2, []));
    transport.enqueue(delayedA.promise);
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [
        { nodeRef: sourceA.nodeRef, branchRevision: 2 },
        { nodeRef: destinationA.nodeRef, branchRevision: 2 },
      ],
    });
    const delayedB = deferred<DomResponse>();
    transport.enqueue(childrenResponse(sourceB.nodeRef, 2, []));
    transport.enqueue(delayedB.promise);
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [
        { nodeRef: sourceB.nodeRef, branchRevision: 2 },
        { nodeRef: destinationB.nodeRef, branchRevision: 2 },
      ],
    });
    await flushAsync();

    delayedA.resolve(childrenResponse(destinationA.nodeRef, 2, [movedA]));
    await flushAsync();
    expect(controller.rows().find((row) => row.nodeRef === movedA.nodeRef))
      .toMatchObject({ parentRef: destinationA.nodeRef });
    expect(controller.isExpanded(movedB.nodeRef)).toBe(true);
    await controller.select(movedB.nodeRef);
    expect(transport.dispatched).toEqual([]);

    delayedB.resolve(childrenResponse(destinationB.nodeRef, 2, [movedB]));
    await flushAsync();
    expect(controller.rows().filter((row) => row.nodeRef === movedA.nodeRef))
      .toEqual([expect.objectContaining({ parentRef: destinationA.nodeRef })]);
    expect(controller.rows().filter((row) => row.nodeRef === movedB.nodeRef))
      .toEqual([expect.objectContaining({ parentRef: destinationB.nodeRef })]);
    expect(controller.expandedRefs()).toEqual([
      root.nodeRef,
      sourceA.nodeRef,
      destinationA.nodeRef,
      sourceB.nodeRef,
      destinationB.nodeRef,
      movedA.nodeRef,
      movedB.nodeRef,
    ]);
  });

  it("fails the oldest reconciliation batch closed when the active cap overflows", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const batchCount = DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES + 1;
    const pairs = Array.from({ length: batchCount }, (_, index) => ({
      source: locatedNode(`source-${index}`, locator(2, index * 2), true, 1),
      destination: locatedNode(
        `destination-${index}`,
        locator(2, index * 2 + 1),
        true,
        1,
      ),
      candidate: locatedNode(`candidate-${index}`, locator(3, index), true, 1),
    }));
    const parents = pairs.flatMap(({ source, destination }) => [source, destination]);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(
      root.nodeRef,
      1,
      parents.slice(0, 100),
      "parents-2",
    ));
    transport.enqueue(childrenResponse(
      root.nodeRef,
      1,
      parents.slice(100, 200),
      "parents-3",
    ));
    transport.enqueue(childrenResponse(root.nodeRef, 1, parents.slice(200)));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.loadMore(root.nodeRef);
    await controller.loadMore(root.nodeRef);

    for (const { source, destination, candidate } of pairs) {
      transport.enqueue(childrenResponse(source.nodeRef, 1, [candidate]));
      await controller.expand(source.nodeRef);
      transport.enqueue(childrenResponse(destination.nodeRef, 1, []));
      await controller.expand(destination.nodeRef);
      transport.enqueue(childrenResponse(candidate.nodeRef, 1, []));
      await controller.expand(candidate.nodeRef);
    }

    const pendingDestinations: Array<Deferred<DomResponse>> = [];
    for (const { source, destination } of pairs) {
      const pending = deferred<DomResponse>();
      pendingDestinations.push(pending);
      transport.enqueue(childrenResponse(source.nodeRef, 2, []));
      transport.enqueue(pending.promise);
      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [
          { nodeRef: source.nodeRef, branchRevision: 2 },
          { nodeRef: destination.nodeRef, branchRevision: 2 },
        ],
      });
      await flushAsync();
    }

    expect(controller.isExpanded(pairs[0]?.candidate.nodeRef ?? "missing"))
      .toBe(false);
    expect(controller.isExpanded(pairs.at(-1)?.candidate.nodeRef ?? "missing"))
      .toBe(true);

    controller.dispose();
    for (const [index, pending] of pendingDestinations.entries()) {
      const destination = pairs[index]?.destination;
      if (destination) {
        pending.resolve(childrenResponse(destination.nodeRef, 2, []));
      }
    }
    await flushAsync();
  });

  it("prunes a disconnected ownership cycle without retaining stale authority", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const source = locatedNode("source", locator(2), true, 1);
    const cycleA = locatedNode("cycle-a", locator(3), true, 1);
    const cycleB = locatedNode("cycle-b", locator(4), true, 1);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [source]));
    transport.enqueue(childrenResponse(source.nodeRef, 1, [cycleA]));
    transport.enqueue(childrenResponse(cycleA.nodeRef, 1, [cycleB]));
    transport.enqueue(childrenResponse(cycleB.nodeRef, 1, [cycleA]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(source.nodeRef);
    await controller.expand(cycleA.nodeRef);
    await controller.expand(cycleB.nodeRef);
    controller.handleEvent(selectionEvent(1, [root]));

    transport.enqueue(childrenResponse(source.nodeRef, 2, []));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: source.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).toEqual([root.nodeRef, source.nodeRef]);
    expect(controller.expandedRefs()).toEqual([root.nodeRef, source.nodeRef]);
    await controller.select(cycleA.nodeRef);
    expect(transport.dispatched).toEqual([]);
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

  it("releases initial-root ownership when transport throws synchronously", async () => {
    const transport = new TestTransport();
    const failure = new Error("synchronous root failure");
    const onError = vi.fn();
    transport.enqueueSynchronousThrow(failure);
    const controller = createController(transport, () => undefined, onError);

    await controller.loadRoot();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(controller.rows()).toEqual([]);
    transport.enqueue(rootResponse(node("root")));

    await controller.loadRoot();

    expect(transport.requests.map(({ type }) => type)).toEqual([
      "dom.getRoot",
      "dom.getRoot",
    ]);
    expect(nodeRefs(controller)).toEqual(["root"]);
  });

  it("quarantines an ordinary first page after a synchronous transport throw and retries", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const parent = locatedNode("parent", locator(2), true, 1);
    const stale = locatedNode("stale", locator(3));
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [parent]));
    transport.enqueue(childrenResponse(parent.nodeRef, 1, [stale]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(parent.nodeRef);
    controller.focus(stale.nodeRef);
    transport.enqueueSynchronousThrow(new Error("synchronous children failure"));

    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: parent.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();

    expect(nodeRefs(controller)).not.toContain(stale.nodeRef);
    expect(controller.snapshot().errorCode).toBe("internal-error");
    expect(controller.focusedRef).toBe(`pin-op:load-more:${parent.nodeRef}`);
    expect(controller.rows().find((row) => row.type === "load-more"))
      .toMatchObject({
        parentRef: parent.nodeRef,
        label: "Load children",
        loading: false,
        focused: true,
      });

    const fresh = locatedNode("fresh", locator(3, 1));
    transport.enqueue(childrenResponse(parent.nodeRef, 2, [fresh]));
    await controller.loadMore(parent.nodeRef);

    expect(nodeRefs(controller)).toContain(fresh.nodeRef);
    expect(controller.snapshot().errorCode).toBeUndefined();
  });

  it("clears a load-more request that throws synchronously and permits retry", async () => {
    const transport = new TestTransport();
    const root = locatedNode("root", locator(1), true, 1);
    const first = locatedNode("first", locator(2));
    const second = locatedNode("second", locator(2, 1));
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse(root.nodeRef, 1, [first], "next"));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    transport.enqueueSynchronousThrow(new Error("synchronous page failure"));

    await controller.loadMore(root.nodeRef);

    expect(controller.snapshot().errorCode).toBe("internal-error");
    expect(controller.rows().find((row) => row.type === "load-more"))
      .toMatchObject({ parentRef: root.nodeRef, loading: false });
    transport.enqueue(childrenResponse(root.nodeRef, 1, [second]));

    await controller.loadMore(root.nodeRef);

    expect(nodeRefs(controller)).toEqual([root.nodeRef, first.nodeRef, second.nodeRef]);
    expect(controller.snapshot().errorCode).toBeUndefined();
  });

  it("propagates a synchronous recovery failure without retaining pending ownership", async () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    const root = locatedNode("recovery-root", locator(1), true, 1);
    controller.handleEvent(selectionEvent(1, [locatedNode("old-root", locator(1))]));
    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(root, 2));
    controller.installRecoveredPath(locatorResponse(root, [root], 2), {
      selected: false,
      expanded: true,
    });
    const failure = new Error("synchronous recovery failure");
    transport.enqueueSynchronousThrow(failure);

    await expect(controller.hydrateRecoveredBranches()).rejects.toBe(failure);

    transport.enqueue({
      ...childrenResponse(root.nodeRef, 1, []),
      documentEpoch: 2,
    });
    await expect(controller.hydrateRecoveredBranches()).resolves.toBeUndefined();
    expect(transport.requests).toHaveLength(2);
  });

  it("records and retries a root snapshot refresh that throws synchronously", async () => {
    const transport = new TestTransport();
    const root = {
      ...locatedNode("root", locator(1), false, 1),
      attributes: [{ name: "data-state", value: "old" }],
    };
    transport.enqueue(rootResponse(root));
    const controller = createController(transport);
    await controller.loadRoot();
    transport.enqueueSynchronousThrow(new Error("synchronous snapshot failure"));

    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 2 }],
    });
    await flushAsync();

    expect(controller.snapshot().errorCode).toBe("internal-error");
    expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
      .toMatchObject({
        branchRevision: 1,
        node: { attributes: [{ name: "data-state", value: "old" }] },
      });

    const freshRoot = {
      ...locatedNode("root", locator(1), false, 3),
      attributes: [{ name: "data-state", value: "fresh" }],
    };
    transport.enqueue(rootResponse(freshRoot));
    controller.handleEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: root.nodeRef, branchRevision: 3 }],
    });
    await flushAsync();

    expect(transport.requests.map(({ type }) => type)).toEqual([
      "dom.getRoot",
      "dom.getRoot",
      "dom.getRoot",
    ]);
    expect(controller.snapshot().errorCode).toBeUndefined();
    expect(controller.rows().find((row) => row.nodeRef === root.nodeRef))
      .toMatchObject({
        branchRevision: 3,
        node: { attributes: [{ name: "data-state", value: "fresh" }] },
      });
  });

  it("discards stale branch pages after invalidation", async () => {
    const transport = new TestTransport();
    const oldPage = deferred<DomResponse>();
    transport.enqueue(rootResponse(node("root", true, 1)));
    transport.enqueue(oldPage.promise);
    transport.enqueue(rootResponse(node("root", true, 2)));
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

  it.each(["document-type", "text", "comment"] as const)(
    "ignores a valid %s display row in a live selection path",
    (kind) => {
      const controller = createController(new TestTransport());
      const target = node("target");

      controller.handleEvent({
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 1,
        nodeRef: target.nodeRef,
        ancestorPath: [
          node("root", true),
          displayNode(`display-${kind}`, kind, kind),
          target,
        ],
      });

      expect(controller.rows()).toEqual([]);
      expect(controller.snapshot().selectedRef).toBeUndefined();
      expect(controller.expandedRefs()).toEqual([]);
    },
  );

  it("accepts shadow and frame boundaries but rejects a non-element selection target", () => {
    const controller = createController(new TestTransport());
    const root = node("root", true);
    const shadow = recoverableNode("shadow", "shadow-root");
    const frame = recoverableNode("frame", "frame-document");
    const target = node("target");

    controller.handleEvent(selectionEvent(1, [root, shadow, frame, target]));

    expect(nodeRefs(controller)).toEqual(["root", "shadow", "frame", "target"]);
    expect(controller.expandedRefs()).toEqual(["root", "shadow", "frame"]);
    expect(controller.snapshot().selectedRef).toBe("target");

    controller.handleEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 2,
      nodeRef: frame.nodeRef,
      ancestorPath: [root, shadow, frame],
    });

    expect(controller.snapshot().selectedRef).toBe("target");
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
    transport.enqueue(rootResponse(node("root", true, 2)));
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
    transport.enqueue(rootResponse(node("root", true)));
    transport.enqueue(childrenResponse("root", 0, [{
      ...node("locked-frame"),
      selectable: false,
      inaccessible: true,
    }]));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand("root");

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
      focusAnchor: {
        locator: selectedLocator,
        rowType: "node",
      },
      expandedLocators: [locator(1), duplicateLocator],
    });
    expect(controller.snapshot().recovering).toBe(true);
    expect(controller.rows()).toBe(rowsBeforeRecovery);
    expect(transport.cancellations).toEqual(["DOM tree recovery started"]);
  });

  it("caps expanded recovery locators at 64 while retaining the selection", async () => {
    const transport = new TestTransport();
    const selectedLocator = locatorWithBoundaries(
      [{ kind: "frame-document", hostDepth: 1 }],
      1,
      63,
    );
    const children = Array.from({ length: 64 }, (_, index) => (
      locatedNode(
        `child-${index}`,
        index === 63 ? selectedLocator : locator(2, index),
        true,
      )
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

    expect(snapshot.selectedLocator).toEqual(selectedLocator);
    expect(snapshot.selectedWasExpanded).toBe(true);
    expect(snapshot.focusAnchor).toEqual({
      locator: selectedLocator,
      rowType: "node",
    });
    expect(snapshot.expandedLocators).toHaveLength(64);
    expect(snapshot.expandedLocators[0]).toEqual(locator(1));
    expect(snapshot.expandedLocators.slice(1)).toEqual(
      Array.from({ length: 63 }, (_, index) => locator(2, index)),
    );
  });

  it("orders normal, shadow, and frame locators by boundary-aware depth", () => {
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
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      locatedNode("frame", frameLocator, true),
      locatedNode("shadow", shadowLocator, true),
      locatedNode("normal", normalLocator, true),
      locatedNode("selected", locator(6, 4)),
    ]));

    const snapshot = controller.beginRecovery();

    expect(snapshot.expandedLocators).toEqual([
      normalLocator,
      shadowLocator,
      frameLocator,
    ]);
  });

  it("captures a load-more recovery focus anchor by parent locator", async () => {
    const transport = new TestTransport();
    const rootLocator = locator(1, 4);
    const root = locatedNode("root", rootLocator, true);
    transport.enqueue(rootResponse(root));
    transport.enqueue(childrenResponse("root", 0, [node("child")], "next"));
    const controller = createController(transport);
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    const loadMore = controller.rows().find((row) => row.type === "load-more");
    if (!loadMore) {
      throw new Error("Missing load-more row");
    }
    controller.focus(loadMore.nodeRef);

    const snapshot = controller.beginRecovery();

    expect(snapshot.focusAnchor).toEqual({
      locator: rootLocator,
      rowType: "load-more",
    });
  });

  it("publishes the valid focus ref restored by an atomic recovery finish", () => {
    const transport = new TestTransport();
    const focusLocator = locator(2, 3);
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      locatedNode("old-root", locator(1), true),
      locatedNode("old-focus", focusLocator),
    ]));
    const newRoot = locatedNode("new-root", locator(1), true);
    const newFocus = locatedNode("new-focus", focusLocator);

    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(newRoot, 2));
    controller.installRecoveredPath(
      locatorResponse(newFocus, [newRoot, newFocus], 2),
      { selected: false, expanded: false, focusIntent: "node" },
    );
    controller.finishRecovery();

    expect(controller.snapshot()).toMatchObject({
      focusedRef: "new-focus",
      recoveredFocusRef: "new-focus",
    });
  });

  it("rejects display anchors and mismatched target authority during recovery", () => {
    const controller = createController(new TestTransport());
    const root = locatedNode("new-root", locator(1), true);
    const target = locatedNode("new-target", locator(2));

    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(root, 2));
    controller.installRecoveredPath(
      locatorResponse(target, [
        root,
        displayNode("recovery-comment", "comment", "marker"),
        target,
      ], 2),
      { selected: true, expanded: true },
    );
    controller.installRecoveredPath(
      locatorResponse(
        { ...target, label: "response authority" },
        [root, { ...target, label: "path authority" }],
        2,
      ),
      { selected: true, expanded: true },
    );
    controller.finishRecovery();

    expect(nodeRefs(controller)).toEqual(["new-root"]);
    expect(controller.snapshot().selectedRef).toBeUndefined();
    expect(controller.expandedRefs()).toEqual([]);
  });

  it("does not publish a recovered focus ref for root fallback", () => {
    const transport = new TestTransport();
    const controller = createController(transport);
    controller.handleEvent(selectionEvent(1, [
      locatedNode("old-root", locator(1), true),
      locatedNode("old-focus", locator(2, 3)),
    ]));
    const newRoot = locatedNode("new-root", locator(1));

    controller.beginRecovery();
    controller.installRecoveryRoot(rootResponse(newRoot, 2));
    controller.finishRecovery();

    expect(controller.snapshot().focusedRef).toBe("new-root");
    expect(controller.snapshot().recoveredFocusRef).toBeUndefined();
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

    transport.enqueue(rootResponse(locatedNode("new-root", locator(1), true, 1)));
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

    transport.enqueue(rootResponse(locatedNode("new-root", locator(1), true, 1)));
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
  onError: (error: unknown) => void = () => undefined,
): DomTreeController {
  let requestId = 0;
  return new DomTreeController({
    transport,
    onChange,
    onError,
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
    nodeType: 1,
    nodeName: "DIV",
    attributes: [],
    childCount: expandable ? 1 : 0,
    relationship: "dom",
    selectable: true,
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

function displayNode(
  nodeRef: string,
  kind: "document-type" | "text" | "comment",
  value: string,
): DomNodeView {
  return {
    nodeRef,
    kind,
    nodeType: kind === "document-type" ? 10 : kind === "text" ? 3 : 8,
    nodeName: kind === "document-type" ? value : kind === "text" ? "#text" : "#comment",
    ...(kind === "document-type" ? {} : { nodeValue: value }),
    ...(kind === "document-type" ? { publicId: "", systemId: "" } : {}),
    attributes: [],
    childCount: 0,
    relationship: "dom",
    selectable: false,
    expandable: false,
    branchRevision: 0,
    label: kind === "document-type" ? `<!DOCTYPE ${value}>` : value,
  };
}

function recoverableNode(
  nodeRef: string,
  kind: "shadow-root" | "frame-document",
): DomNodeView {
  return {
    nodeRef,
    kind,
    nodeType: kind === "shadow-root" ? 11 : 9,
    nodeName: kind === "shadow-root" ? "#document-fragment" : "#document",
    attributes: [],
    childCount: 1,
    relationship: kind,
    selectable: false,
    label: nodeRef,
    expandable: true,
    branchRevision: 0,
    locator: {
      version: 1,
      targetKind: kind,
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
      hostPath: locator(hostDepth).path,
    })),
    path: locator(pathDepth, siblingIndex).path,
  };
}

function rootResponse(
  root: DomNodeView,
  documentEpoch = 1,
  prologue: readonly DomNodeView[] = [],
  epilogue: readonly DomNodeView[] = [],
): DomRootResponse {
  return {
    type: "dom.root",
    requestId: "ignored-by-test-transport",
    documentEpoch,
    node: root,
    prologue,
    epilogue,
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
  private readonly responses: Array<{
    readonly response: DomResponse | Promise<DomResponse>;
    readonly preserveRequestId: boolean;
  } | {
    readonly synchronousFailure: unknown;
  }> = [];

  public enqueue(response: DomResponse | Promise<DomResponse>): void {
    this.responses.push({ response, preserveRequestId: false });
  }

  public enqueueRaw(response: DomResponse | Promise<DomResponse>): void {
    this.responses.push({ response, preserveRequestId: true });
  }

  public enqueueSynchronousThrow(error: unknown): void {
    this.responses.push({ synchronousFailure: error });
  }

  public request(request: DomRequest): Promise<DomResponse> {
    this.requests.push(request);
    const queued = this.responses.shift();
    if (!queued) {
      return Promise.reject(new Error("Missing queued DOM response"));
    }
    if ("synchronousFailure" in queued) {
      throw queued.synchronousFailure;
    }
    return Promise.resolve(queued.response).then((resolved) => (
      !queued.preserveRequestId && "requestId" in resolved
        ? {
          ...resolved,
          requestId: "requestId" in request ? request.requestId : resolved.requestId,
        }
        : resolved
    ));
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
