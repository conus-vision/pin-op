import { describe, expect, it } from "vitest";
import type {
  InspectorNodeSnapshot,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "../src/contracts.js";
import { createPinOpElementsTreeAdapter } from
  "../src/chromium/upstream/PinOpElementsTreeAdapter.js";
import {
  FakeChromiumElement,
  FakeChromiumDOMDocument,
  FakeChromiumDOMNode,
  FakeChromiumElementsRuntime,
  FakeChromiumMount,
} from "./support/fakeChromiumElementsRuntime.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

describe("PinOpElementsTreeAdapter", () => {
  it("mounts a TreeDataSource snapshot through Chromium DOMDocument and ElementsTreeOutline", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("html", 0, element("HTML", 1), { expanded: true }),
      row("body", 1, element("BODY", 0), {
        parentRef: "html",
        selected: true,
        focused: true,
      }),
    ]));

    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const document = required(outline.rootDOMNode);
    const html = required(document.children()?.[0]);
    const body = required(html.children()?.[0]);

    expect(runtime.prepareCount).toBe(1);
    expect(document).toBeInstanceOf(FakeChromiumDOMDocument);
    expect(html.nodeName()).toBe("HTML");
    expect(body.nodeName()).toBe("BODY");
    expect(outline.constructorArguments).toEqual([
      true,
      true,
      true,
      undefined,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(outline.wiredModel).toBeDefined();
    expect(outline.selectedDOMNode()).toBe(body);
    expect(required(outline.findTreeElement(html)).expanded).toBe(true);
    expect(mount.children).toEqual([host.element]);
    expect(backend.listenerCount()).toBe(1);
  });

  it("forwards user selection and applies source-owned selection without feedback", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 0), { selected: true }),
      row("aside", 0, element("ASIDE", 0)),
    ]));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const aside = required(outline.rootDOMNode?.children()?.[1]);

    outline.simulateUserSelection(aside);
    await Promise.resolve();
    expect(backend.selected).toEqual(["aside"]);
    expect(backend.focused).toEqual(["aside"]);

    backend.publish(tree([
      row("main", 0, element("MAIN", 0)),
      row("aside", 0, element("ASIDE", 0), { selected: true }),
    ]));
    expect(outline.selectedDOMNode()?.nodeName()).toBe("ASIDE");
    expect(backend.selected).toEqual(["aside"]);
  });

  it("hydrates a lazy branch from TreeDataSource and rejects every mutating agent call", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const collapsed = tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
    ]);
    const expanded = tree([
      row("main", 0, element("MAIN", 1), {
        expandable: true,
        expanded: true,
      }),
      row("section", 1, element("SECTION", 0), { parentRef: "main" }),
    ]);
    const backend = new PublishingExpandBackend(collapsed, expanded);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const initialMain = required(outline.rootDOMNode?.children()?.[0]);

    await outline.requestChildren(initialMain);

    const hydratedMain = required(outline.rootDOMNode?.children()?.[0]);
    expect(backend.expanded).toEqual(["main"]);
    expect(hydratedMain).toBe(initialMain);
    expect(outline.rootSetCount).toBe(1);
    expect(hydratedMain.children()?.map((node) => node.nodeName())).toEqual([
      "SECTION",
    ]);
    expect(required(outline.findTreeElement(hydratedMain)).expanded).toBe(true);

    const agent = required(outline.wiredModel).getAgent() as {
      invoke_setAttributeValue(
        request: unknown,
      ): Promise<{ getError(): string | undefined }>;
    };
    const mutation = await agent.invoke_setAttributeValue({
      nodeId: hydratedMain.id,
      name: "class",
      value: "forbidden",
    });
    expect(mutation.getError()).toMatch(/read-only.*invoke_setAttributeValue/i);
  });

  it("updates attributes, text, and branch revisions without rebuilding Chromium node identity", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initialMain = {
      ...element("MAIN", 1),
      attributes: [{ name: "class", value: "before" }],
    };
    const initialText = text("before");
    const backend = new FakeElementsBackend(tree([
      row("main", 0, initialMain, { expanded: true }),
      row("text", 1, initialText, { parentRef: "main" }),
    ]));
    createPinOpElementsTreeAdapter(runtime, mount as unknown as HTMLElement, backend);
    const outline = required(runtime.createdOutline);
    const document = required(outline.rootDOMNode);
    const main = required(document.children()?.[0]) as FakeChromiumDOMNode;
    const textNode = required(main.children()?.[0]) as FakeChromiumDOMNode;

    backend.publish(tree([
      row("main", 0, {
        ...initialMain,
        attributes: [{ name: "class", value: "after" }],
        branchRevision: 7,
      }, { expanded: true }),
      row("text", 1, {
        ...initialText,
        nodeValue: "after",
        branchRevision: 8,
      }, { parentRef: "main" }),
    ]));

    expect(outline.rootDOMNode).toBe(document);
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(main.children()?.[0]).toBe(textNode);
    expect(main.attributesForTest()).toEqual(["class", "after"]);
    expect(textNode.nodeValue()).toBe("after");
    expect(outline.rootSetCount).toBe(1);
  });

  it("incrementally appends, reorders, and removes expanded branch children", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 1), { expanded: true }),
      row("a", 1, element("SECTION", 0), { parentRef: "main" }),
    ]));
    createPinOpElementsTreeAdapter(runtime, mount as unknown as HTMLElement, backend);
    const outline = required(runtime.createdOutline);
    const document = required(outline.rootDOMNode);
    const main = required(document.children()?.[0]);
    const a = required(main.children()?.[0]);

    backend.publish(tree([
      row("main", 0, element("MAIN", 2), { expanded: true }),
      row("a", 1, element("SECTION", 0), { parentRef: "main" }),
      row("b", 1, element("ARTICLE", 0), { parentRef: "main" }),
    ]));
    const b = required(main.children()?.[1]);

    expect(outline.rootDOMNode).toBe(document);
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(main.children()?.[0]).toBe(a);
    expect(b.nodeName()).toBe("ARTICLE");

    backend.publish(tree([
      row("main", 0, element("MAIN", 2), { expanded: true }),
      row("b", 1, element("ARTICLE", 0), { parentRef: "main" }),
      row("a", 1, element("SECTION", 0), { parentRef: "main" }),
    ]));

    expect(main.children()).toEqual([b, a]);
    expect(main.children()?.[0]).toBe(b);
    expect(main.children()?.[1]).toBe(a);

    backend.publish(tree([
      row("main", 0, element("MAIN", 1), { expanded: true }),
      row("a", 1, element("SECTION", 0), { parentRef: "main" }),
    ]));

    expect(outline.rootDOMNode).toBe(document);
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(main.children()).toEqual([a]);
    expect(a.parentNode).toBe(main);
    expect(b.parentNode).toBeNull();
    expect(outline.rootSetCount).toBe(1);
  });

  it("keeps document and node identity across source-owned collapse and re-expand", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const expanded = tree([
      row("main", 0, element("MAIN", 1), { expanded: true, expandable: true }),
      row("section", 1, element("SECTION", 0), { parentRef: "main" }),
    ]);
    const collapsed = tree([
      row("main", 0, element("MAIN", 1), { expanded: false, expandable: true }),
    ]);
    const backend = new PublishingCollapseExpandBackend(expanded, collapsed);
    createPinOpElementsTreeAdapter(runtime, mount as unknown as HTMLElement, backend);
    const outline = required(runtime.createdOutline);
    const document = required(outline.rootDOMNode);
    const main = required(document.children()?.[0]);
    const section = required(main.children()?.[0]);

    outline.simulateUserCollapse(main);
    expect(outline.rootDOMNode).toBe(document);
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(outline.rootSetCount).toBe(1);

    outline.simulateUserExpansion(main);
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.expanded.at(-1)).toBe("main");
    expect(outline.rootDOMNode).toBe(document);
    expect(main.children()?.[0]).toBe(section);
    expect(outline.rootSetCount).toBe(1);
  });

  it("reconciles a deep expanded snapshot in a bounded linear pass", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const depth = 120;
    const rows = Array.from({ length: depth }, (_, index) => row(
      `node-${index}`,
      index,
      element("DIV", index + 1 < depth ? 1 : 0),
      {
        ...(index > 0 ? { parentRef: `node-${index - 1}` } : {}),
        expanded: index + 1 < depth,
        expandable: index + 1 < depth,
      },
    ));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(tree(rows)),
    );

    for (let index = 0; index < depth + 2; index += 1) await Promise.resolve();

    expect(required(runtime.createdOutline).rootSetCount).toBe(1);
    expect(runtime.totalExpandCalls()).toBeLessThanOrEqual(depth);
  });

  it("unsubscribes, unwires, removes the mount and invalidates the agent exactly once", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
    ]));
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const model = required(outline.wiredModel);
    const main = required(outline.rootDOMNode?.children()?.[0]);

    host.dispose();
    host.dispose();

    expect(backend.listenerCount()).toBe(0);
    expect(outline.unwiredModel).toBe(model);
    expect(outline.rootDOMNode).toBeNull();
    expect(outline.disposeCount).toBe(1);
    expect(runtime.cleanupCount).toBe(1);
    expect(mount.children).toEqual([]);
    const agent = model.getAgent() as {
      invoke_requestChildNodes(
        request: { readonly nodeId: number },
      ): Promise<unknown>;
    };
    const disposedRequest = await agent.invoke_requestChildNodes({ nodeId: main.id });
    expect(disposedRequest.getError()).toMatch(/disposed/i);
  });

  it("atomically tears down a partially mounted Chromium outline when initial synchronization fails", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("duplicate", 0, element("MAIN", 0)),
      row("duplicate", 0, element("ASIDE", 0)),
    ]));

    expect(() => createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    )).toThrow(/duplicate chromium node ref/i);

    const outline = required(runtime.createdOutline);
    expect(backend.listenerCount()).toBe(0);
    expect(outline.unwiredModel).toBe(outline.wiredModel);
    expect(outline.disposeCount).toBe(1);
    expect(runtime.loadMoreBridgeCleanupCount).toBe(1);
    expect(runtime.cleanupCount).toBe(1);
    expect(mount.children).toEqual([]);
  });

  it("bridges the Pin-op load-more row without duplicating an in-flight page request", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initial = tree([
      row("main", 0, element("MAIN", 2), {
        expandable: true,
        expanded: true,
      }),
      row("first", 1, element("SECTION", 0), { parentRef: "main" }),
      loadMoreRow("main", 1, {
        nodeRef: "load-more:main:v1",
        focused: true,
      }),
    ]);
    const complete = tree([
      row("main", 0, element("MAIN", 2), {
        expandable: true,
        expanded: true,
      }),
      row("first", 1, element("SECTION", 0), { parentRef: "main" }),
      row("second", 1, element("ARTICLE", 0), { parentRef: "main" }),
    ]);
    const backend = new DeferredLoadMoreBackend(initial, complete);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const firstChild = required(main.children()?.[0]);

    expect(main.childNodeCount()).toBe(2);
    expect(runtime.loadMoreParents).toEqual([{
      parent: main,
      hasMore: true,
      loadedChildCount: 1,
      totalChildCount: 2,
      remainingChildCount: 1,
      serviceRowRef: "load-more:main:v1",
      focused: true,
    }]);
    expect(Object.isFrozen(runtime.loadMoreParents)).toBe(true);
    expect(runtime.focusedLoadMoreRef).toBe("load-more:main:v1");
    await expect(runtime.requestLoadMore(required(main.children()?.[0])))
      .rejects.toThrow(/not presented/i);

    const staleAuthority = required(runtime.loadMoreParents[0]);
    backend.publish(tree([
      row("main", 0, element("MAIN", 2), {
        expandable: true,
        expanded: true,
      }),
      row("first", 1, element("SECTION", 0), { parentRef: "main" }),
      loadMoreRow("main", 1, { nodeRef: "load-more:main:v2" }),
    ]));
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(runtime.loadMoreParents[0]?.serviceRowRef).toBe("load-more:main:v2");
    expect(runtime.focusedLoadMoreRef).toBeUndefined();
    await runtime.requestLoadMoreAuthority(staleAuthority);
    expect(backend.loadMoreAttempts).toBe(0);

    const first = runtime.requestLoadMore(main);
    const duplicate = runtime.requestLoadMore(main);

    expect(backend.loadMoreAttempts).toBe(1);
    expect(backend.focused).toEqual(["load-more:main:v2"]);
    backend.settle();
    await Promise.all([first, duplicate]);
    expect(runtime.loadMoreParents).toEqual([]);
    expect(runtime.loadMoreUpdateHistory.length).toBeGreaterThanOrEqual(2);
    expect(outline.rootDOMNode?.children()?.[0]).toBe(main);
    expect(main.children()?.[0]).toBe(firstChild);
    expect(main.children()?.[1]?.nodeName()).toBe("ARTICLE");
    expect(outline.rootSetCount).toBe(1);
  });

  it("restores the source total child count after bounded lazy hydration", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const collapsed = tree([
      row("main", 0, element("MAIN", 2), { expandable: true }),
    ]);
    const firstPage = tree([
      row("main", 0, element("MAIN", 2), {
        expandable: true,
        expanded: true,
      }),
      row("first", 1, element("SECTION", 0), { parentRef: "main" }),
      loadMoreRow("main", 1),
    ]);
    const backend = new PublishingExpandBackend(collapsed, firstPage);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const initialMain = required(outline.rootDOMNode?.children()?.[0]);

    await outline.requestChildren(initialMain);

    expect(initialMain.childNodeCount()).toBe(2);
    expect(initialMain.setChildNodeCountCalls.at(-1)).toBe(2);
    const currentMain = required(outline.rootDOMNode?.children()?.[0]);
    expect(runtime.loadMoreParents[0]?.parent).toBe(currentMain);
    expect(runtime.loadMoreParents[0]?.remainingChildCount).toBe(1);
  });

  it("forwards Chromium hover through the read-only overlay and clears it on leave and dispose", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("doctype", 0, documentType("html")),
      row("main", 0, element("MAIN", 0)),
    ]));
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const model = required(outline.wiredModel);
    const doctype = required(outline.rootDOMNode?.children()?.[0]);
    const main = required(outline.rootDOMNode?.children()?.[1]);

    model.overlayModel().highlightInOverlay({ node: main });
    expect(backend.hovered).toEqual(["main"]);
    model.overlayModel().highlightInOverlay({ node: doctype });
    expect(backend.hovered).toEqual(["main", undefined]);
    model.overlayModel().highlightInOverlay({ node: main });
    (outline.element as unknown as FakeChromiumElement).dispatch("pointerleave");
    expect(backend.hovered).toEqual(["main", undefined, "main", undefined]);

    model.overlayModel().highlightInOverlay({ node: main });
    host.dispose();
    expect(backend.hovered.at(-1)).toBeUndefined();
  });

  it("allocates fresh Chromium ids when a new root reuses a child nodeRef", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(rootedTree("root-a", "BUTTON"));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const staleChild = required(outline.rootDOMNode?.children()?.[0]?.children()?.[0]);

    backend.publish(rootedTree("root-b", "SECTION"));
    const currentChild = required(outline.rootDOMNode?.children()?.[0]?.children()?.[0]);

    expect(currentChild.id).not.toBe(staleChild.id);
    outline.simulateUserSelection(staleChild);
    await Promise.resolve();
    expect(backend.selected).toEqual([]);
    outline.simulateUserSelection(currentChild);
    await Promise.resolve();
    expect(backend.selected).toEqual(["shared-child"]);
  });

  it("restores source selection after invalid and rejected Chromium selections", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const errors: unknown[] = [];
    const backend = new RejectingSelectionBackend(tree([
      row("doctype", 0, documentType("html")),
      row("main", 0, element("MAIN", 0), { selected: true }),
      row("aside", 0, element("ASIDE", 0)),
    ]));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
      { onError: error => errors.push(error) },
    );
    const outline = required(runtime.createdOutline);
    const [doctype, main, aside] = outline.rootDOMNode?.children() ?? [];

    outline.simulateUserSelection(required(doctype));
    expect(outline.selectedDOMNode()).toBe(main);
    expect(backend.selected).toEqual([]);

    outline.simulateUserSelection(required(aside));
    await Promise.resolve();
    await Promise.resolve();
    expect(outline.selectedDOMNode()).toBe(main);
    expect(errors).toHaveLength(1);
  });

  it("rejects selection invalidated by a synchronous focus publication", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initial = tree([row("button", 0, element("BUTTON", 0))]);
    const invalidated = tree([row("button", 0, element("SECTION", 0))]);
    const backend = new FocusPublishingBackend(initial, invalidated);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const staleButton = required(outline.rootDOMNode?.children()?.[0]);

    outline.simulateUserSelection(staleButton);
    await Promise.resolve();

    expect(backend.focused).toEqual(["button"]);
    expect(backend.selected).toEqual([]);
  });

  it("finishes teardown when unsubscribe throws and does not report an in-flight disposal as a backend error", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new ThrowingUnsubscribeDeferredExpandBackend(tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
    ]));
    const errors: unknown[] = [];
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
      { onError: error => errors.push(error) },
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const pending = outline.requestChildren(main);

    expect(() => host.dispose()).toThrow(/unsubscribe failed/i);
    expect(backend.listenerCount()).toBe(0);
    expect(outline.unwiredModel).toBe(outline.wiredModel);
    expect(outline.disposeCount).toBe(1);
    expect(runtime.cleanupCount).toBe(1);
    expect(runtime.loadMoreBridgeCleanupCount).toBe(1);
    expect(mount.children).toEqual([]);

    backend.settleExpand();
    await expect(pending).rejects.toThrow(/disposed/i);
    expect(errors).toEqual([]);
  });

  it("does not allow callers to replace the sole read-only agent command", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 0)),
    ]));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const agent = required(runtime.createdOutline?.wiredModel).getAgent();
    const original = agent.invoke_requestChildNodes;

    expect(Reflect.set(agent, "invoke_requestChildNodes", async () => ({
      getError: () => undefined,
    }))).toBe(false);
    expect(agent.invoke_requestChildNodes).toBe(original);
  });

  it("resolves forbidden moveTo-style agent calls as protocol errors without unhandled rejection", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(tree([row("main", 0, element("MAIN", 0))])),
    );
    const agent = required(runtime.createdOutline?.wiredModel).getAgent() as unknown as {
      invoke_moveTo(request: unknown): Promise<{ getError(): string | undefined }>;
      invoke_removeNode(request: unknown): Promise<{ getError(): string | undefined }>;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const move = await agent.invoke_moveTo({ nodeId: 2, targetNodeId: 3 });
      const remove = await agent.invoke_removeNode({ nodeId: 2 });
      expect(move.getError()).toMatch(/read-only.*invoke_moveTo/i);
      expect(remove.getError()).toMatch(/read-only.*invoke_removeNode/i);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports terminal loaded-branch synchronization failures without unhandled rejection", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const synchronizationError = new Error("expanded snapshot failed");
    const backend = new SnapshotFailingExpandBackend(tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
      row("child", 1, element("SECTION", 0), { parentRef: "main" }),
    ]), synchronizationError);
    const errors: unknown[] = [];
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
      { onError: error => errors.push(error) },
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      outline.simulateUserExpansion(main);
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(errors).toEqual([synchronizationError]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      host.dispose();
    }
  });

  it("resolves Chromium's getChildNodes chain when terminal synchronization fails", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const synchronizationError = new Error("child snapshot failed");
    const backend = new SnapshotFailingExpandBackend(tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
    ]), synchronizationError);
    const errors: unknown[] = [];
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
      { onError: error => errors.push(error) },
    );
    const main = required(runtime.createdOutline?.rootDOMNode?.children()?.[0]) as
      FakeChromiumDOMNode;
    const callbacks: Array<readonly unknown[] | null> = [];

    await expect(main.requestChildrenThroughChromiumChainForTest(
      children => callbacks.push(children),
    )).resolves.toBeUndefined();

    expect(callbacks).toEqual([null]);
    expect(errors).toEqual([synchronizationError]);
    host.dispose();
  });

  it("preserves retained identity and invalidates removed nodes during async expansion reconciliation", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initial = tree([
      row("main", 0, element("MAIN", 2), { expanded: true, expandable: true }),
      row("a", 1, element("ASIDE", 1), { parentRef: "main", expandable: true }),
      row("b", 1, element("BUTTON", 0), { parentRef: "main" }),
    ]);
    const reordered = tree([
      row("main", 0, element("MAIN", 2), { expanded: true, expandable: true }),
      row("b", 1, element("BUTTON", 0), { parentRef: "main" }),
      row("c", 1, element("CANVAS", 0), { parentRef: "main" }),
    ]);
    const backend = new SilentPublishingExpandBackend(initial, reordered);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const [removed, retained] = main.children() ?? [];

    await outline.requestChildren(main);

    expect(main.children()?.map(node => node.nodeName())).toEqual(["BUTTON", "CANVAS"]);
    expect(main.children()?.[0] === retained).toBe(true);
    expect(removed?.parentNode === null).toBe(true);
    outline.simulateUserExpansion(required(removed));
    outline.simulateUserSelection(required(removed));
    await Promise.resolve();
    expect(backend.expanded).toEqual(["main"]);
    expect(backend.selected).toEqual([]);
  });

  it("preserves retained identity and invalidates removed nodes during async pagination reconciliation", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initial = tree([
      row("main", 0, element("MAIN", 3), { expanded: true, expandable: true }),
      row("a", 1, element("ASIDE", 1), { parentRef: "main", expandable: true }),
      row("b", 1, element("BUTTON", 0), { parentRef: "main" }),
      loadMoreRow("main", 1, { nodeRef: "load-more:main" }),
    ]);
    const reordered = tree([
      row("main", 0, element("MAIN", 2), { expanded: true, expandable: true }),
      row("b", 1, element("BUTTON", 0), { parentRef: "main" }),
      row("c", 1, element("CANVAS", 0), { parentRef: "main" }),
    ]);
    const backend = new SilentDeferredLoadMoreBackend(initial, reordered);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const [removed, retained] = main.children() ?? [];
    const request = runtime.requestLoadMore(main);

    backend.settle();
    await request;

    expect(main.children()?.map(node => node.nodeName())).toEqual(["BUTTON", "CANVAS"]);
    expect(main.children()?.[0] === retained).toBe(true);
    expect(removed?.parentNode === null).toBe(true);
    outline.simulateUserExpansion(required(removed));
    outline.simulateUserSelection(required(removed));
    await Promise.resolve();
    expect(backend.expanded).toEqual([]);
    expect(backend.selected).toEqual([]);
  });

  it("starts pagination for a reused parent ref immediately after a document rebuild", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new NavigatingDeferredLoadMoreBackend(
      paginatedRoot("root-a", "ARTICLE"),
    );
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const oldDocument = required(outline.rootDOMNode);
    const oldParent = required(oldDocument.children()?.[0]?.children()?.[0]);
    const staleRequest = runtime.requestLoadMore(oldParent);
    let currentRequest: Promise<void> | undefined;

    try {
      backend.publish(paginatedRoot("root-b", "SECTION"));
      const newDocument = required(outline.rootDOMNode);
      const newParent = required(newDocument.children()?.[0]?.children()?.[0]);
      expect(newDocument === oldDocument).toBe(false);
      expect(newParent === oldParent).toBe(false);

      currentRequest = runtime.requestLoadMore(newParent);
      await Promise.resolve();
      expect(backend.loadMoreAttempts).toBe(2);
      await currentRequest;

      backend.settleFirst();
      await staleRequest;
      expect(outline.rootDOMNode === newDocument).toBe(true);
      expect(outline.rootDOMNode?.children()?.[0]?.children()?.[0] === newParent).toBe(true);
    } finally {
      backend.settleFirst();
      await staleRequest;
      await currentRequest;
      host.dispose();
    }
  });

  it("drains current-document pagination while an older document request remains pending", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new CrossGenerationDeferredLoadMoreBackend(
      paginatedRoot("root-a", "ARTICLE"),
      completedPaginatedRoot("root-b", "SECTION"),
    );
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const oldParent = required(outline.rootDOMNode?.children()?.[0]?.children()?.[0]);
    const staleRequest = runtime.requestLoadMore(oldParent);
    let currentRequest: Promise<void> | undefined;

    try {
      backend.publish(paginatedRoot("root-b", "SECTION"));
      const currentDocument = required(outline.rootDOMNode);
      const currentParent = required(currentDocument.children()?.[0]?.children()?.[0]);

      currentRequest = runtime.requestLoadMore(currentParent);
      await currentRequest;

      const loadedChild = required(currentParent.children()?.[0]);
      expect(backend.loadMoreAttempts).toBe(2);
      expect(runtime.loadMoreParents).toEqual([]);
      expect(loadedChild.nodeName()).toBe("BUTTON");
      expect(outline.selectedDOMNode()).toBe(loadedChild);
      expect(outline.rootDOMNode).toBe(currentDocument);

      backend.settleFirst();
      await staleRequest;
      expect(runtime.loadMoreParents).toEqual([]);
      expect(outline.selectedDOMNode()).toBe(loadedChild);
      expect(outline.rootDOMNode).toBe(currentDocument);
    } finally {
      backend.settleFirst();
      await staleRequest;
      await currentRequest;
      host.dispose();
    }
  });

  it("rejects recursive or piercing child requests at the bounded read-only boundary", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 1), { expandable: true }),
    ]));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const response = await required(outline.wiredModel).getAgent()
      .invoke_requestChildNodes({ nodeId: main.id, depth: 2, pierce: true });

    expect(response.getError()).toMatch(/bounded.*depth.*pierce/i);
    expect(backend.expanded).toEqual([]);
  });

  it("forwards a real Chromium ElementCollapsed event to source authority", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 1), {
        expanded: true,
        expandable: true,
      }),
      row("section", 1, element("SECTION", 0), { parentRef: "main" }),
    ]));
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);

    outline.simulateUserCollapse(main);

    expect(backend.collapsed).toEqual(["main"]);
  });

  it("releases document-scoped Chromium listeners on every root rebuild", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(rootedTree("root", "BUTTON"));
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const model = required(runtime.createdOutline?.wiredModel) as ChromiumModelWithTestCount;

    expect(model.listenerCountForTest()).toBe(2);
    backend.publish(rootedTree("root", "SECTION"));
    expect(model.listenerCountForTest()).toBe(2);
    backend.publish(rootedTree("root", "ARTICLE"));
    expect(model.listenerCountForTest()).toBe(2);

    host.dispose();
    expect(model.listenerCountForTest()).toBe(0);
  });
});

interface ChromiumModelWithTestCount {
  listenerCountForTest(): number;
}

class PublishingExpandBackend extends FakeElementsBackend {
  public constructor(
    initial: TreePresentationSnapshot,
    private readonly expandedSnapshot: TreePresentationSnapshot,
  ) {
    super(initial);
  }

  public override async expand(nodeRef: string): Promise<void> {
    await super.expand(nodeRef);
    this.publish(this.expandedSnapshot);
  }
}

class SilentPublishingExpandBackend extends PublishingExpandBackend {
  public override subscribe(_listener: () => void): () => void {
    return () => undefined;
  }
}

class PublishingCollapseExpandBackend extends FakeElementsBackend {
  public constructor(
    private readonly expandedSnapshot: TreePresentationSnapshot,
    private readonly collapsedSnapshot: TreePresentationSnapshot,
  ) {
    super(expandedSnapshot);
  }

  public override collapse(nodeRef: string): void {
    super.collapse(nodeRef);
    this.publish(this.collapsedSnapshot);
  }

  public override async expand(nodeRef: string): Promise<void> {
    await super.expand(nodeRef);
    this.publish(this.expandedSnapshot);
  }
}

class DeferredLoadMoreBackend extends FakeElementsBackend {
  public loadMoreAttempts = 0;
  private resolve: (() => void) | undefined;

  public constructor(
    initial: TreePresentationSnapshot,
    private readonly completeSnapshot: TreePresentationSnapshot,
  ) {
    super(initial);
  }

  public override loadMore(parentRef: string): Promise<void> {
    this.loadMoreAttempts += 1;
    this.loadedMore.push(parentRef);
    return new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  public settle(): void {
    this.publish(this.completeSnapshot);
    this.resolve?.();
  }
}

class SilentDeferredLoadMoreBackend extends DeferredLoadMoreBackend {
  public override subscribe(_listener: () => void): () => void {
    return () => undefined;
  }
}

class RejectingSelectionBackend extends FakeElementsBackend {
  public override async select(nodeRef: string): Promise<void> {
    await super.select(nodeRef);
    throw new Error("selection rejected");
  }
}

class SnapshotFailingExpandBackend extends FakeElementsBackend {
  private failSnapshot = false;

  public constructor(
    snapshot: TreePresentationSnapshot,
    private readonly snapshotError: Error,
  ) {
    super(snapshot);
  }

  public override snapshot(): TreePresentationSnapshot {
    if (this.failSnapshot) throw this.snapshotError;
    return super.snapshot();
  }

  public override async expand(nodeRef: string): Promise<void> {
    await super.expand(nodeRef);
    this.failSnapshot = true;
  }
}

class FocusPublishingBackend extends FakeElementsBackend {
  public constructor(
    initial: TreePresentationSnapshot,
    private readonly afterFocus: TreePresentationSnapshot,
  ) {
    super(initial);
  }

  public override focus(nodeRef: string): void {
    super.focus(nodeRef);
    this.publish(this.afterFocus);
  }
}

class ThrowingUnsubscribeDeferredExpandBackend extends FakeElementsBackend {
  private resolve: (() => void) | undefined;

  public override subscribe(listener: () => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      unsubscribe();
      throw new Error("unsubscribe failed");
    };
  }

  public override expand(nodeRef: string): Promise<void> {
    this.expanded.push(nodeRef);
    return new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  public settleExpand(): void {
    this.resolve?.();
  }
}

class NavigatingDeferredLoadMoreBackend extends FakeElementsBackend {
  public loadMoreAttempts = 0;
  private resolveFirst: (() => void) | undefined;

  public override loadMore(parentRef: string): Promise<void> {
    this.loadMoreAttempts += 1;
    this.loadedMore.push(parentRef);
    if (this.loadMoreAttempts > 1) return Promise.resolve();
    return new Promise(resolve => {
      this.resolveFirst = resolve;
    });
  }

  public settleFirst(): void {
    this.resolveFirst?.();
    this.resolveFirst = undefined;
  }
}

class CrossGenerationDeferredLoadMoreBackend extends FakeElementsBackend {
  public loadMoreAttempts = 0;
  private resolveFirst: (() => void) | undefined;
  private suppressNotification = false;

  public constructor(
    initial: TreePresentationSnapshot,
    private readonly currentCompleteSnapshot: TreePresentationSnapshot,
  ) {
    super(initial);
  }

  public override subscribe(listener: () => void): () => void {
    return super.subscribe(() => {
      if (!this.suppressNotification) listener();
    });
  }

  public override loadMore(parentRef: string): Promise<void> {
    this.loadMoreAttempts += 1;
    this.loadedMore.push(parentRef);
    if (this.loadMoreAttempts === 1) {
      return new Promise(resolve => {
        this.resolveFirst = resolve;
      });
    }
    this.suppressNotification = true;
    try {
      this.publish(this.currentCompleteSnapshot);
    } finally {
      this.suppressNotification = false;
    }
    return Promise.resolve();
  }

  public settleFirst(): void {
    this.resolveFirst?.();
    this.resolveFirst = undefined;
  }
}

function tree(rows: readonly TreeRowSnapshot[]): TreePresentationSnapshot {
  return { rows };
}

function row(
  nodeRef: string,
  depth: number,
  node: InspectorNodeSnapshot,
  overrides: Partial<TreeRowSnapshot> = {},
): TreeRowSnapshot {
  return {
    type: "node",
    nodeRef,
    depth,
    node,
    expanded: false,
    expandable: node.expandable,
    selected: false,
    focused: false,
    hovered: false,
    ...overrides,
  };
}

function loadMoreRow(
  parentRef: string,
  depth: number,
  overrides: Partial<TreeRowSnapshot> = {},
): TreeRowSnapshot {
  return {
    type: "load-more",
    nodeRef: `load-more:${parentRef}`,
    parentRef,
    depth,
    expanded: false,
    expandable: false,
    selected: false,
    focused: false,
    hovered: false,
    ...overrides,
  };
}

function element(nodeName: string, childCount: number): InspectorNodeSnapshot {
  return {
    nodeRef: nodeName.toLowerCase(),
    kind: "element",
    nodeType: 1,
    nodeName,
    attributes: [],
    childCount,
    relationship: "dom",
    selectable: true,
    expandable: childCount > 0,
    branchRevision: 0,
  };
}

function documentType(nodeName: string): InspectorNodeSnapshot {
  return {
    nodeRef: `doctype:${nodeName}`,
    kind: "document-type",
    nodeType: 10,
    nodeName,
    attributes: [],
    childCount: 0,
    relationship: "dom",
    selectable: false,
    expandable: false,
    branchRevision: 0,
  };
}

function text(nodeValue: string): InspectorNodeSnapshot {
  return {
    nodeRef: "text",
    kind: "text",
    nodeType: 3,
    nodeName: "#text",
    nodeValue,
    attributes: [],
    childCount: 0,
    relationship: "dom",
    selectable: true,
    expandable: false,
    branchRevision: 0,
  };
}

function rootedTree(rootRef: string, childName: string): TreePresentationSnapshot {
  return tree([
    row(rootRef, 0, {
      ...element("HTML", 1),
      nodeRef: rootRef,
    }, { expanded: true, expandable: true }),
    row("shared-child", 1, {
      ...element(childName, 0),
      nodeRef: "shared-child",
    }, { parentRef: rootRef }),
  ]);
}

function paginatedRoot(rootRef: string, rootName: string): TreePresentationSnapshot {
  return tree([
    row(rootRef, 0, element(rootName, 1), { expanded: true, expandable: true }),
    row("shared-parent", 1, element("MAIN", 1), {
      parentRef: rootRef,
      expanded: true,
      expandable: true,
    }),
    loadMoreRow("shared-parent", 2, { nodeRef: "load-more:shared-parent" }),
  ]);
}

function completedPaginatedRoot(
  rootRef: string,
  rootName: string,
): TreePresentationSnapshot {
  return tree([
    row(rootRef, 0, element(rootName, 1), { expanded: true, expandable: true }),
    row("shared-parent", 1, element("MAIN", 1), {
      parentRef: rootRef,
      expanded: true,
      expandable: true,
    }),
    row("loaded-child", 2, element("BUTTON", 0), {
      parentRef: "shared-parent",
      selected: true,
      focused: true,
    }),
  ]);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
}
