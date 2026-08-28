import { describe, expect, it } from "vitest";
import type {
  InspectorNodeSnapshot,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "../src/contracts.js";
import {
  type ChromiumDOMNode,
  createPinOpElementsTreeAdapter,
} from "../src/chromium/upstream/PinOpElementsTreeAdapter.js";
import {
  FakeChromiumElement,
  FakeChromiumDOMDocument,
  FakeChromiumDOMNode,
  FakeChromiumElementsTreeOutline,
  FakeChromiumElementsRuntime,
  FakeChromiumMount,
  FakeChromiumTreeElement,
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
    expect((host.element as unknown as FakeChromiumElement).classList.contains(
      "pin-op-elements-inspector__tree",
    )).toBe(true);
    expect((host.element as unknown as FakeChromiumElement).getAttribute(
      "data-part",
    )).toBe("chromium-read-only-elements-tree");
    expect(backend.listenerCount()).toBe(1);
  });

  it("replays only new reveal intent or focus for an already selected native node", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const selectedRows = [
      row("main", 0, element("MAIN", 0), { selected: true, focused: true }),
    ];
    const initial = tree(selectedRows, { revealRef: "main", revealVersion: 1 });
    const backend = new FakeElementsBackend(initial);
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const callsAfterMount = outline.selectDOMNodeCalls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    backend.publish(tree(selectedRows, {
      revealRef: "main",
      revealVersion: 1,
    }));
    expect(outline.selectDOMNodeCalls).toHaveLength(callsAfterMount);

    backend.publish(tree(selectedRows, {
      revealRef: "main",
      revealVersion: 2,
    }));
    expect(outline.selectDOMNodeCalls).toHaveLength(callsAfterMount + 1);
    expect(outline.selectDOMNodeCalls.at(-1)?.focus).toBe(true);

    const unfocusedRows = [
      row("main", 0, element("MAIN", 0), { selected: true, focused: false }),
    ];
    const unfocused = tree(unfocusedRows, {
      revealRef: "main",
      revealVersion: 2,
    });
    backend.publish(tree(unfocusedRows, {
      revealRef: "main",
      revealVersion: 2,
    }));
    expect(outline.selectDOMNodeCalls).toHaveLength(callsAfterMount + 2);
    expect(outline.selectDOMNodeCalls.at(-1)?.focus).toBe(false);

    backend.publish(unfocused);
    expect(outline.selectDOMNodeCalls).toHaveLength(callsAfterMount + 2);
  });

  it("finishes an asynchronous native reveal for a deeply selected snapshot node", async () => {
    const runtime = new AsyncPopulateChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const rows = deepSelectedRows(50);
    const backend = new FakeElementsBackend(tree(rows, {
      revealRef: "selected",
      revealVersion: 1,
    }));

    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdAsyncOutline);
    const selected = required(required(outline.rootDOMNode).children()?.[0]);
    let selectedNode = selected;
    while (selectedNode?.children()?.[0]) {
      selectedNode = selectedNode.children()?.[0];
    }

    expect(outline.renderedSelectedDOMNode()).toBeNull();
    for (let turn = 0; turn < 256 && !outline.renderedSelectedDOMNode(); turn += 1) {
      await waitForTimerTask();
    }

    expect(outline.renderedSelectedDOMNode() === selectedNode).toBe(true);
    expect(outline.populateDepths).toHaveLength(49);
    expect(backend.selected).toEqual([]);
    expect(backend.focused).toEqual([]);
  });

  it("continues a deep native reveal across timer-task population", async () => {
    const runtime = new AsyncPopulateChromiumElementsRuntime(waitForTimerTask);
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree(deepSelectedRows(50), {
      revealRef: "selected",
      revealVersion: 1,
    }));

    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdAsyncOutline);
    const selected = deepestDOMNode(required(outline.rootDOMNode));

    expect(outline.renderedSelectedDOMNode()).toBeNull();
    for (let turn = 0; turn < 256 && !outline.renderedSelectedDOMNode(); turn += 1) {
      await waitForTimerTask();
    }

    expect(outline.renderedSelectedDOMNode() === selected).toBe(true);
    expect(outline.populateDepths).toHaveLength(49);
    expect(backend.selected).toEqual([]);
    expect(backend.focused).toEqual([]);
  });

  it("rebuilds a pending native population before revealing a newly materialized deep selection", () => {
    const runtime = new PendingPopulateChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initialRoot = required(deepSelectedRows(50)[0]);
    const backend = new DeferredExpandBackend(tree([initialRoot]));
    const host = createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdPendingOutline);
    const initialDocument = required(outline.rootDOMNode);

    expect(backend.expanded).toEqual(["root"]);
    expect(outline.rootSetCount).toBe(1);

    backend.publish(tree(deepSelectedRows(50), {
      revealRef: "selected",
      revealVersion: 1,
    }));

    const currentDocument = required(outline.rootDOMNode);
    const selected = deepestDOMNode(currentDocument);
    expect(currentDocument === initialDocument).toBe(false);
    expect(outline.rootSetCount).toBe(2);
    expect(outline.findTreeElement(selected)).not.toBeNull();
    expect(outline.selectedDOMNode()).toBe(selected);

    host.dispose();
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

  it("keeps a native click selected while focus publishes before its deferred acknowledgement", async () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const initial = tree([
      row("main", 0, element("MAIN", 0), { selected: true, focused: true }),
      row("aside", 0, element("ASIDE", 0)),
    ], { revealRef: "main", revealVersion: 1 });
    const focused = tree([
      row("main", 0, element("MAIN", 0), { selected: true }),
      row("aside", 0, element("ASIDE", 0), { focused: true }),
    ], { revealRef: "main", revealVersion: 1 });
    const acknowledged = tree([
      row("main", 0, element("MAIN", 0)),
      row("aside", 0, element("ASIDE", 0), { selected: true, focused: true }),
    ], { revealRef: "aside", revealVersion: 2 });
    const backend = new DeferredSelectionAcknowledgementBackend(
      initial,
      focused,
      acknowledged,
    );
    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );
    const outline = required(runtime.createdOutline);
    const main = required(outline.rootDOMNode?.children()?.[0]);
    const aside = required(outline.rootDOMNode?.children()?.[1]);
    const selectionCallsBeforeClick = outline.selectDOMNodeCalls.length;

    outline.simulateUserSelection(aside);

    expect(backend.focused).toEqual(["aside"]);
    expect(backend.selected).toEqual(["aside"]);
    expect(outline.selectedDOMNode()).toBe(aside);
    expect(outline.selectDOMNodeCalls).toHaveLength(selectionCallsBeforeClick);

    backend.acknowledge();
    await backend.selectionSettled();

    expect(outline.selectedDOMNode()).toBe(aside);
    expect(outline.selectDOMNodeCalls.at(-1)?.node).toBe(aside);
    expect(outline.selectDOMNodeCalls.at(-1)?.node).not.toBe(main);
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

  it("omits a stale load-more authority when every child is already materialized", () => {
    const runtime = new FakeChromiumElementsRuntime();
    const mount = new FakeChromiumMount();
    const backend = new FakeElementsBackend(tree([
      row("main", 0, element("MAIN", 1), {
        expandable: true,
        expanded: true,
      }),
      row("selected", 1, element("BUTTON", 0), {
        parentRef: "main",
        selected: true,
      }),
      loadMoreRow("main", 1),
    ]));

    createPinOpElementsTreeAdapter(
      runtime,
      mount as unknown as HTMLElement,
      backend,
    );

    expect(runtime.loadMoreParents).toEqual([]);
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
    const internalFocusTarget = new FakeChromiumElement();
    (outline.element as unknown as FakeChromiumElement).append(
      internalFocusTarget,
    );
    const hoverBeforeInternalFocus = [...backend.hovered];
    (outline.element as unknown as FakeChromiumElement).dispatch("focusout", {
      relatedTarget: internalFocusTarget,
    });
    expect(backend.hovered).toEqual(hoverBeforeInternalFocus);

    (outline.element as unknown as FakeChromiumElement).dispatch("focusout");
    expect(backend.hovered).toEqual([...hoverBeforeInternalFocus, undefined]);

    model.overlayModel().highlightInOverlay({ node: main });
    const hoverBeforePointerLeave = [...backend.hovered];
    (outline.element as unknown as FakeChromiumElement).dispatch("pointerleave");
    expect(backend.hovered).toEqual([...hoverBeforePointerLeave, undefined]);

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

class AsyncPopulateChromiumElementsRuntime extends FakeChromiumElementsRuntime {
  public createdAsyncOutline: AsyncPopulateChromiumElementsTreeOutline | undefined;

  public constructor(
    waitForPopulation: () => Promise<void> = () => Promise.resolve(),
  ) {
    super();
    const runtime = this;
    Object.defineProperty(this, "ElementsTreeOutline", {
      configurable: true,
      value: class extends AsyncPopulateChromiumElementsTreeOutline {
        public constructor(...arguments_: readonly unknown[]) {
          super(waitForPopulation, ...arguments_);
          runtime.createdOutline = this;
          runtime.createdAsyncOutline = this;
        }
      },
    });
  }
}

class AsyncPopulateChromiumElementsTreeOutline extends FakeChromiumElementsTreeOutline {
  public readonly populateDepths: number[] = [];
  private readonly asyncTreeElements = new Map<
    ChromiumDOMNode,
    AsyncPopulateChromiumTreeElement
  >();
  private renderedSelectedNode: ChromiumDOMNode | null = null;
  private visibleDepth = 0;

  public constructor(
    private readonly waitForPopulation: () => Promise<void>,
    ...constructorArguments: readonly unknown[]
  ) {
    super(...constructorArguments);
  }

  public override get rootDOMNode(): ChromiumDOMNode | null {
    return super.rootDOMNode;
  }

  public override set rootDOMNode(node: ChromiumDOMNode | null) {
    super.rootDOMNode = node;
    this.asyncTreeElements.clear();
    this.renderedSelectedNode = null;
    this.visibleDepth = node ? 1 : 0;
  }

  public override selectDOMNode(
    node: ChromiumDOMNode | null,
    focus = false,
  ): void {
    super.selectDOMNode(node, focus);
    this.renderedSelectedNode = node && this.findTreeElement(node) ? node : null;
  }

  public override findTreeElement(
    node: ChromiumDOMNode,
  ): AsyncPopulateChromiumTreeElement | null {
    const depth = chromiumNodeDepth(node);
    if (
      node === this.rootDOMNode ||
      depth > this.visibleDepth ||
      !super.findTreeElement(node)
    ) {
      return null;
    }
    let treeElement = this.asyncTreeElements.get(node);
    if (!treeElement) {
      treeElement = new AsyncPopulateChromiumTreeElement(node, async () => {
        await this.waitForPopulation();
        this.populateDepths.push(depth);
        this.visibleDepth = Math.max(this.visibleDepth, depth + 1);
      });
      this.asyncTreeElements.set(node, treeElement);
    }
    return treeElement;
  }

  public renderedSelectedDOMNode(): ChromiumDOMNode | null {
    return this.renderedSelectedNode;
  }
}

class AsyncPopulateChromiumTreeElement extends FakeChromiumTreeElement {
  private populated = false;

  public constructor(
    node: ChromiumDOMNode,
    private readonly populate: () => Promise<void>,
  ) {
    super(node, () => undefined);
  }

  public async onpopulate(): Promise<void> {
    await this.populate();
  }

  public override expand(): void {
    const shouldPopulate = !this.expanded && !this.populated;
    super.expand();
    if (shouldPopulate) {
      this.populated = true;
      void this.onpopulate();
    }
  }
}

class PendingPopulateChromiumElementsRuntime extends FakeChromiumElementsRuntime {
  public createdPendingOutline: PendingPopulateChromiumElementsTreeOutline | undefined;

  public constructor() {
    super();
    const runtime = this;
    Object.defineProperty(this, "ElementsTreeOutline", {
      configurable: true,
      value: class extends PendingPopulateChromiumElementsTreeOutline {
        public constructor(...arguments_: readonly unknown[]) {
          super(...arguments_);
          runtime.createdOutline = this;
          runtime.createdPendingOutline = this;
        }
      },
    });
  }
}

class PendingPopulateChromiumElementsTreeOutline extends FakeChromiumElementsTreeOutline {
  private pendingRoot: ChromiumDOMNode | undefined;
  private pendingRootElement: FakeChromiumTreeElement | undefined;
  private pendingRequest: Promise<void> | undefined;

  public override get rootDOMNode(): ChromiumDOMNode | null {
    return super.rootDOMNode;
  }

  public override set rootDOMNode(node: ChromiumDOMNode | null) {
    super.rootDOMNode = node;
    this.pendingRoot = undefined;
    this.pendingRootElement = undefined;
  }

  public override findTreeElement(
    node: ChromiumDOMNode,
  ): FakeChromiumTreeElement | null {
    const sourceRoot = this.rootDOMNode?.children()?.[0];
    if (node !== sourceRoot) return super.findTreeElement(node);
    if (this.pendingRoot !== node || !this.pendingRootElement) {
      this.pendingRoot = node;
      this.pendingRootElement = new FakeChromiumTreeElement(node, () => {
        if (node.children() !== null || this.pendingRequest) return;
        this.pendingRequest = this.requestChildren(node).catch(() => undefined);
      });
    }
    return this.pendingRootElement;
  }
}

class DeferredExpandBackend extends FakeElementsBackend {
  public override expand(nodeRef: string): Promise<void> {
    this.expanded.push(nodeRef);
    return new Promise<void>(() => undefined);
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

class DeferredSelectionAcknowledgementBackend extends FakeElementsBackend {
  private settleSelection: (() => void) | undefined;
  private readonly pendingSelection = new Promise<void>(resolve => {
    this.settleSelection = resolve;
  });

  public constructor(
    initial: TreePresentationSnapshot,
    private readonly focusedSnapshot: TreePresentationSnapshot,
    private readonly acknowledgedSnapshot: TreePresentationSnapshot,
  ) {
    super(initial);
  }

  public override focus(nodeRef: string): void {
    super.focus(nodeRef);
    this.publish(this.focusedSnapshot);
  }

  public override select(nodeRef: string): Promise<void> {
    this.selected.push(nodeRef);
    return this.pendingSelection;
  }

  public acknowledge(): void {
    this.publish(this.acknowledgedSnapshot);
    this.settleSelection?.();
    this.settleSelection = undefined;
  }

  public selectionSettled(): Promise<void> {
    return this.pendingSelection;
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

function chromiumNodeDepth(node: ChromiumDOMNode): number {
  let depth = 0;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) depth += 1;
  return depth;
}

function deepestDOMNode(root: ChromiumDOMNode): ChromiumDOMNode {
  let node = root;
  while (node.children()?.[0]) node = required(node.children()?.[0]);
  return node;
}

function waitForTimerTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function deepSelectedRows(length: number): readonly TreeRowSnapshot[] {
  return Array.from({ length }, (_, index) => {
    const nodeRef = index === 0
      ? "root"
      : index === length - 1
        ? "selected"
        : `deep-${index}`;
    const hasChild = index < length - 1;
    const nodeName = index === 0 ? "HTML" : hasChild ? "DIV" : "BUTTON";
    return row(nodeRef, index, {
      ...element(nodeName, hasChild ? 1 : 0),
      nodeRef,
    }, {
      ...(index === 0 ? {} : {
        parentRef: index === 1 ? "root" : `deep-${index - 1}`,
      }),
      expanded: hasChild,
      expandable: hasChild,
      selected: !hasChild,
      focused: !hasChild,
    });
  });
}

function tree(
  rows: readonly TreeRowSnapshot[],
  reveal: { readonly revealRef?: string; readonly revealVersion?: number } = {},
): TreePresentationSnapshot {
  return { rows, revealVersion: reveal.revealVersion ?? 0, ...reveal };
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
