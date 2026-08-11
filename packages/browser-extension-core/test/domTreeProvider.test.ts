import { describe, expect, it, vi } from "vitest";
import {
  DomTreeProvider,
  DomTreeProviderError,
} from "../src/domTreeProvider.js";
import type { DomStableLocator } from "../src/domStableLocator.js";
import type { FrameLifecycleEvent } from "../src/frameRegistry.js";

describe("DomTreeProvider", () => {
  it("binds default timers to the inspected document window", () => {
    const document = createDocument();
    const pendingTimers = new Map<number, TimerHandler>();
    let nextTimer = 1;
    const timerWindow = {
      setTimeout(this: unknown, handler: TimerHandler): number {
        if (this !== timerWindow) {
          throw new TypeError(
            "'setTimeout' called on an object that does not implement interface Window.",
          );
        }
        const timer = nextTimer;
        nextTimer += 1;
        pendingTimers.set(timer, handler);
        return timer;
      },
      clearTimeout(this: unknown, timer?: number): void {
        if (this !== timerWindow) {
          throw new TypeError(
            "'clearTimeout' called on an object that does not implement interface Window.",
          );
        }
        if (timer !== undefined) pendingTimers.delete(timer);
      },
    };
    Object.defineProperty(document, "defaultView", {
      configurable: true,
      value: timerWindow as unknown as Window,
    });
    vi.stubGlobal("setTimeout", timerWindow.setTimeout);
    vi.stubGlobal("clearTimeout", timerWindow.clearTimeout);

    try {
      const provider = new DomTreeProvider(document as unknown as Document, {
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      });

      expect(() => provider.startFrameTracking()).not.toThrow();
      expect(pendingTimers.size).toBe(1);

      provider.dispose();
      expect(pendingTimers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns only element children in fixed-size pages", () => {
    const document = createDocument();
    for (let index = 0; index < 51; index += 1) {
      document.documentElement.append(createText(`before-${index}`));
      document.documentElement.append(createElement("section", document));
      document.documentElement.append(createComment(`after-${index}`));
    }
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(root.node.locator).toMatchObject({
      version: 1,
      targetKind: "element",
      boundaries: expect.any(Array),
      path: expect.any(Array),
    });
    expect(Object.isFrozen(root.node.locator)).toBe(true);
    expect(Object.isFrozen(root.node.locator.boundaries)).toBe(true);
    expect(Object.isFrozen(root.node.locator.path)).toBe(true);

    const first = provider.getChildren({
      type: "dom.getChildren",
      requestId: "children-1",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(first.nodes).toHaveLength(50);
    expect(first.nodes.every((node) => node.kind === "element")).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = provider.getChildren({
      type: "dom.getChildren",
      requestId: "children-2",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: first.branchRevision,
      cursor: first.nextCursor,
    });
    expect(second.nodes).toHaveLength(1);
  });

  it("serializes an explicit expandable open-shadow-root container", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const hostView = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;

    const children = provider.getChildren({
      type: "dom.getChildren",
      requestId: "host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });

    expect(hostView.expandable).toBe(true);
    expect(children.nodes).toContainEqual(expect.objectContaining({
      kind: "shadow-root",
      expandable: true,
    }));
    expect(children.nodes.find((node) => node.kind === "shadow-root")?.locator)
      .toMatchObject({ version: 1, targetKind: "shadow-root" });
  });

  it("invalidates an expanded branch before serving revision two", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });

    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).branchRevision).toBe(2);
  });

  it("revisions every affected branch before invalidation callbacks re-enter", () => {
    const document = createDocument();
    const firstParent = createElement("main", document);
    const secondParent = createElement("aside", document);
    firstParent.append(createElement("p", document));
    secondParent.append(createElement("p", document));
    document.documentElement.append(firstParent);
    document.documentElement.append(secondParent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    let provider: DomTreeProvider | undefined;
    let documentEpoch = 0;
    let firstRef: string | undefined;
    let secondRef: string | undefined;
    let reentryResult: string | undefined;
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => {
        invalidated.push(branch);
        if (branch.nodeRef !== firstRef || !provider || !secondRef) {
          return;
        }
        try {
          provider.getChildren({
            type: "dom.getChildren",
            requestId: "reentrant-second-parent",
            documentEpoch,
            nodeRef: secondRef,
            branchRevision: 1,
          });
          reentryResult = "served";
        } catch (error) {
          reentryResult = error instanceof DomTreeProviderError
            ? error.code
            : "unexpected-error";
        }
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    documentEpoch = root.documentEpoch;
    const parents = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    firstRef = parents[0]!.nodeRef;
    secondRef = parents[1]!.nodeRef;
    provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent",
      documentEpoch,
      nodeRef: firstRef,
      branchRevision: 1,
    });
    provider.getChildren({
      type: "dom.getChildren",
      requestId: "second-parent",
      documentEpoch,
      nodeRef: secondRef,
      branchRevision: 1,
    });

    const firstAdded = createElement("section", document);
    const secondAdded = createElement("section", document);
    firstParent.append(firstAdded);
    secondParent.append(secondAdded);
    harness.observers[0]!.emit([
      mutationRecord(firstParent, [firstAdded]),
      mutationRecord(secondParent, [secondAdded]),
    ]);
    harness.flushTimers();

    expect(reentryResult).toBe("stale-branch");
    expect(invalidated).toEqual([
      { nodeRef: firstRef, branchRevision: 2 },
      { nodeRef: secondRef, branchRevision: 2 },
    ]);
  });

  it("ignores text-only mutations in an element-only branch", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const text = createText("changed");

    parent.append(text);
    harness.observers[0]!.emit([mutationRecord(parent, [text])]);
    harness.flushTimers();

    expect(invalidated).toEqual([]);
  });

  it("invalidates a parent page when a visible child becomes expandable", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("article", document);
    parent.append(child);
    for (let index = 0; index < 50; index += 1) {
      parent.append(createElement("section", document));
    }
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(firstPage.nodes[0]).toMatchObject({ expandable: false });

    const grandchild = createElement("button", document);
    child.append(grandchild);
    harness.observers[0]!.emit([mutationRecord(child, [grandchild])]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]).toMatchObject({ expandable: true });
  });

  it("invalidates a parent page when a visible child label changes", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("article", document);
    child.setAttribute("id", "before");
    parent.append(child);
    for (let index = 0; index < 50; index += 1) {
      parent.append(createElement("section", document));
    }
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(firstPage.nodes[0]?.label).toBe("article#before");

    child.setAttribute("id", "after");
    harness.observers[0]!.emit([attributeMutationRecord(child, "id")]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.label).toBe("article#after");
  });

  it("invalidates when an unapproved attribute shifts role into the label window", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("div", document);
    for (let index = 0; index < 32; index += 1) {
      child.setAttribute(`title-${index}`, `private-${index}`);
    }
    child.setAttribute("role", "region");
    parent.append(child);
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    expect(onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "initial-parent",
    ).label).toBe("div");

    child.removeAttribute("title-0");
    harness.observers[0]!.emit([attributeMutationRecord(child, "title-0")]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.label).toBe("div [role]");
  });

  it("does not invalidate when an attribute mutation leaves the label unchanged", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("div", document);
    child.setAttribute("title", "private-before");
    parent.append(child);
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    expect(onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "initial-parent",
    ).label).toBe("div");

    child.setAttribute("title", "private-after");
    harness.observers[0]!.emit([attributeMutationRecord(child, "title")]);
    harness.flushTimers();

    expect(invalidated).toEqual([]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "unchanged-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    }).nodes[0]?.label).toBe("div");
  });

  it("rejects a cursor from an older branch revision as stale-branch", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    for (let index = 0; index < 51; index += 1) {
      parent.append(createElement("p", document));
    }
    document.documentElement.append(parent);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const parentView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;
    const first = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
      cursor: first.nextCursor,
    })).toThrowError("stale-branch");
  });

  it("rejects a stale first expansion without acquiring branch ownership", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    })).toThrowError("stale-branch");
    expect(harness.observers).toHaveLength(1);

    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "current-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 1,
    });
    expect(harness.observers).toHaveLength(2);
  });

  it("rejects an unknown first cursor without acquiring branch ownership", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "unknown-first-cursor",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
      cursor: "missing-cursor",
    })).toThrowError("invalid-cursor");
    expect(harness.observers).toHaveLength(1);
  });

  it("returns the full root-to-node path across a shadow boundary", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    body.append(host);
    document.documentElement.append(body);
    const provider = createProvider(document);
    const root = provider.getRoot(3);
    const bodyView = onlyChild(provider, root.node, root.documentEpoch, "body");
    const hostView = onlyChild(provider, bodyView, root.documentEpoch, "host");
    const shadowView = onlyChild(provider, hostView, root.documentEpoch, "shadow");
    const buttonView = onlyChild(provider, shadowView, root.documentEpoch, "button");

    const path = provider.ancestorPath(buttonView.nodeRef, root.documentEpoch);

    expect(path.map((node) => node.nodeRef)).toEqual([
      root.node.nodeRef,
      bodyView.nodeRef,
      hostView.nodeRef,
      shadowView.nodeRef,
      buttonView.nodeRef,
    ]);
    expect(path.map((node) => node.kind)).toEqual([
      "element",
      "element",
      "element",
      "shadow-root",
      "element",
    ]);
    expect(Object.isFrozen(path)).toBe(true);
  });

  it("discovers an open shadow root created after host expansion", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.append(createElement("span", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });

    host.attachShadow().append(createElement("button", document));
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    }).nodes[0]).toMatchObject({
      kind: "shadow-root",
      expandable: true,
    });
  });

  it("observes each discovered open shadow root independently", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "shadow-children",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
    });

    expect(harness.observers).toHaveLength(2);
    expect(harness.observers[1]!.observedTargets).toEqual([shadowRoot]);
    const added = createElement("span", document);
    shadowRoot.append(added);
    harness.observers[1]!.emit([mutationRecord(shadowRoot, [added])]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: shadowView.nodeRef,
      branchRevision: 2,
    });
  });

  it("disconnects observers across nested shadow boundaries on removal", () => {
    const document = createDocument();
    const outerHost = createElement("article", document);
    const outerShadow = outerHost.attachShadow();
    const innerHost = createElement("section", document);
    const innerShadow = innerHost.attachShadow();
    innerShadow.append(createElement("button", document));
    outerShadow.append(innerHost);
    document.documentElement.append(outerHost);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const outerHostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const outerShadowView = onlyChild(
      harness.provider,
      outerHostView,
      root.documentEpoch,
      "outer-host-children",
    );
    const innerHostView = onlyChild(
      harness.provider,
      outerShadowView,
      root.documentEpoch,
      "outer-shadow-children",
    );
    onlyChild(
      harness.provider,
      innerHostView,
      root.documentEpoch,
      "inner-host-children",
    );
    const outerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(outerShadow)
    ))!;
    const innerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(innerShadow)
    ))!;

    document.documentElement.remove(outerHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [outerHost]),
    ]);
    harness.flushTimers();

    expect(outerObserver.disconnectCount).toBe(1);
    expect(innerObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("retains shadow cleanup ownership through record pressure", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    const unrelatedHost = createElement("aside", document);
    const unrelatedShadow = unrelatedHost.attachShadow();
    unrelatedShadow.append(createElement("span", document));
    const pressureParent = createElement("main", document);
    for (let index = 0; index < 100; index += 1) {
      pressureParent.append(createElement("p", document));
    }
    document.documentElement.append(host);
    document.documentElement.append(unrelatedHost);
    document.documentElement.append(pressureParent);
    const harness = createProviderHarness(document, { maxRecords: 64 });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const shadowView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "host-shadow",
    );
    const unrelatedShadowView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "unrelated-shadow",
    );
    const firstPressurePage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "pressure-one",
      documentEpoch: root.documentEpoch,
      nodeRef: topChildren[2]!.nodeRef,
      branchRevision: topChildren[2]!.branchRevision,
    });
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "pressure-two",
      documentEpoch: root.documentEpoch,
      nodeRef: topChildren[2]!.nodeRef,
      branchRevision: topChildren[2]!.branchRevision,
      cursor: firstPressurePage.nextCursor,
    });
    const hostObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedShadow)
    ))!;
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };

    expect(internals.records.has(shadowView.nodeRef)).toBe(true);
    expect(internals.records.has(unrelatedShadowView.nodeRef)).toBe(true);
    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      hostObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
  });

  it("serializes and observes an accessible same-origin frame document", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );

    expect(frameView).toMatchObject({ kind: "element", expandable: true });
    expect(frameDocumentView).toMatchObject({
      kind: "frame-document",
      expandable: true,
      locator: expect.objectContaining({
        version: 1,
        targetKind: "frame-document",
      }),
    });
    expect(harness.observers[1]!.observedTargets).toEqual([childDocument]);
    expect(harness.provider.ancestorPath(childRootView.nodeRef, root.documentEpoch)
      .map((node) => node.kind)).toEqual([
      "element",
      "element",
      "frame-document",
      "element",
    ]);
  });

  it("serializes a cross-origin frame as an inaccessible locked leaf", () => {
    const document = createDocument();
    const frame = createFrameElement(
      document,
      null,
      new Error("cross-origin"),
    );
    document.documentElement.append(frame);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const frameView = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(frameView).toMatchObject({
      kind: "element",
      expandable: false,
      inaccessible: true,
    });
    expect(frame.contentDocumentReads).toBe(2);
    expect(frame.contentWindowReads).toBe(0);
  });

  it("notifies when the selected node is removed", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    let selectedRef: string | undefined;
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "parent-children",
    );
    selectedRef = selectedView.nodeRef;

    parent.remove(selected);
    harness.observers[0]!.emit([mutationRecord(parent, [], [selected])]);
    harness.flushTimers();

    expect(removed).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("notifies after retained hovered nodes reach their final moved or detached state", () => {
    const document = createDocument();
    const source = createElement("main", document);
    const destination = createElement("aside", document);
    const hovered = createElement("button", document);
    source.append(hovered);
    document.documentElement.append(source);
    document.documentElement.append(destination);
    const attachedAtSettlement: boolean[] = [];
    const harness = createProviderHarness(document, {
      onMutationSettled: () => {
        attachedAtSettlement.push(document.documentElement.contains(
          hovered as unknown as Node,
        ));
      },
    });
    const revealed = harness.provider.revealElement(hovered as unknown as Element);
    expect(harness.provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);

    source.remove(hovered);
    destination.append(hovered);
    harness.observers[0]!.emit([
      mutationRecord(source, [], [hovered]),
      mutationRecord(destination, [hovered]),
    ]);
    harness.flushTimers();

    expect(attachedAtSettlement).toEqual([true]);
    expect(harness.provider.resolveElement(
      revealed.nodeRef,
      revealed.documentEpoch,
    )?.element).toBe(hovered);

    destination.remove(hovered);
    harness.observers[0]!.emit([
      mutationRecord(destination, [], [hovered]),
    ]);
    harness.flushTimers();

    expect(attachedAtSettlement).toEqual([true, false]);
    expect(harness.provider.resolveElement(
      revealed.nodeRef,
      revealed.documentEpoch,
    )).toBeUndefined();
  });

  it("preserves a selected node ref when it moves within one scope", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const newParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    document.documentElement.append(oldParent);
    document.documentElement.append(newParent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const parents = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      parents[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "new-parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: parents[1]!.branchRevision,
    });

    oldParent.remove(selected);
    newParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(newParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    expect(invalidated).toEqual(expect.arrayContaining([
      { nodeRef: parents[0]!.nodeRef, branchRevision: 2 },
      { nodeRef: parents[1]!.nodeRef, branchRevision: 2 },
    ]));
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path.map((node) => node.nodeRef)).toEqual([
      root.node.nodeRef,
      parents[1]!.nodeRef,
      selectedView.nodeRef,
    ]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "moved-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.nodeRef).toBe(selectedView.nodeRef);
  });

  it("preserves a selected ref moved beneath an unmaterialized parent", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const destinationContainer = createElement("section", document);
    const destinationParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    destinationContainer.append(destinationParent);
    document.documentElement.append(oldParent);
    document.documentElement.append(destinationContainer);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;

    oldParent.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path.map((node) => node.label)).toEqual([
      "html",
      "section",
      "aside",
      "button",
    ]);
    expect(path[1]?.nodeRef).toBe(topChildren[1]!.nodeRef);
    expect(path.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
  });

  it("atomically replaces a selected path at record capacity", () => {
    const document = createDocument();
    const unrelated = createElement("nav", document);
    const sourceRoot = createElement("main", document);
    let sourceParent = sourceRoot;
    for (let depth = 0; depth < 34; depth += 1) {
      const child = createElement("section", document);
      sourceParent.append(child);
      sourceParent = child;
    }
    const selected = createElement("button", document);
    sourceParent.append(selected);
    const destinationRoot = createElement("aside", document);
    let destinationParent = destinationRoot;
    for (let depth = 0; depth < 34; depth += 1) {
      const child = createElement("div", document);
      destinationParent.append(child);
      destinationParent = child;
    }
    document.documentElement.append(unrelated);
    document.documentElement.append(sourceRoot);
    document.documentElement.append(destinationRoot);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const unrelatedView = topChildren.find((node) => node.label === "nav")!;
    const sourceView = topChildren.find((node) => node.label === "main")!;
    const destinationView = topChildren.find((node) => node.label === "aside")!;
    let selectedView = sourceView;
    for (let depth = 0; depth < 35; depth += 1) {
      selectedView = onlyChild(
        harness.provider,
        selectedView,
        root.documentEpoch,
        `source-depth-${depth}`,
      );
    }
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(sourceView.nodeRef, root.documentEpoch);

    sourceParent.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(sourceParent, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path).toHaveLength(37);
    expect(path[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(path[1]?.nodeRef).toBe(destinationView.nodeRef);
    expect(path.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
    expect(() => harness.provider.ancestorPath(
      unrelatedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(internals.records.size).toBeLessThanOrEqual(64);
  });

  it("fails closed when a moved selected path cannot fit record capacity", () => {
    const document = createDocument();
    const unrelated = createElement("nav", document);
    let unrelatedParent = unrelated;
    for (let depth = 0; depth < 4; depth += 1) {
      const child = createElement("article", document);
      unrelatedParent.append(child);
      unrelatedParent = child;
    }
    const source = createElement("main", document);
    const selected = createElement("button", document);
    source.append(selected);
    const destinationRoot = createElement("aside", document);
    const destinationNodes: FakeElement[] = [];
    let destinationParent = destinationRoot;
    for (let depth = 0; depth < 10; depth += 1) {
      const child = createElement("section", document);
      destinationNodes.push(child);
      destinationParent.append(child);
      destinationParent = child;
    }
    document.documentElement.append(unrelated);
    document.documentElement.append(source);
    document.documentElement.append(destinationRoot);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 16,
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const unrelatedView = topChildren.find((node) => node.label === "nav")!;
    const sourceView = topChildren.find((node) => node.label === "main")!;
    let unrelatedProtectedView = unrelatedView;
    for (let depth = 0; depth < 4; depth += 1) {
      unrelatedProtectedView = onlyChild(
        harness.provider,
        unrelatedProtectedView,
        root.documentEpoch,
        `unrelated-depth-${depth}`,
      );
    }
    const selectedView = onlyChild(
      harness.provider,
      sourceView,
      root.documentEpoch,
      "selected",
    );
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(sourceView.nodeRef, root.documentEpoch);

    source.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(source, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    expect(harness.provider.ancestorPath(
      unrelatedProtectedView.nodeRef,
      root.documentEpoch,
    ).at(-1)?.nodeRef).toBe(unrelatedProtectedView.nodeRef);
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    for (const node of destinationNodes) {
      const nodeRef = internals.refsByNode.get(node);
      expect(nodeRef ? internals.records.has(nodeRef) : false).toBe(false);
    }
  });

  it("invalidates a selected ref after a remove-add-remove batch", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const temporaryParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    document.documentElement.append(oldParent);
    document.documentElement.append(temporaryParent);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const parents = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      parents[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;

    oldParent.remove(selected);
    temporaryParent.append(selected);
    temporaryParent.remove(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(temporaryParent, [selected]),
      mutationRecord(temporaryParent, [], [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("invalidates a selected ref when a node moves across frame scopes", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const oldParent = createElement("main", document);
    const newParent = createElement("aside", childDocument);
    const selected = createElement("button", document);
    oldParent.append(selected);
    childDocument.documentElement.append(newParent);
    document.documentElement.append(oldParent);
    document.documentElement.append(createFrameElement(document, childDocument));
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;
    const frameDocumentView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "frame-children",
    );
    const frameRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "frame-document-children",
    );
    const newParentView = onlyChild(
      harness.provider,
      frameRootView,
      root.documentEpoch,
      "frame-root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "new-parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: newParentView.nodeRef,
      branchRevision: newParentView.branchRevision,
    });

    oldParent.remove(selected);
    newParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
    ]);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    childObserver.emit([mutationRecord(newParent, [selected])]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const movedView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "cross-scope-children",
      documentEpoch: root.documentEpoch,
      nodeRef: newParentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]!;
    expect(movedView.nodeRef).not.toBe(selectedView.nodeRef);
  });

  it("invalidates affected branches before selected-removal callbacks re-enter", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    let selectedRef: string | undefined;
    let parentRef = "";
    let provider: DomTreeProvider;
    let reentrantError: unknown;
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => events.push("invalidated"),
      onSelectedNodeRemoved: () => {
        events.push("removed");
        try {
          provider.getChildren({
            type: "dom.getChildren",
            requestId: "reentrant-parent-children",
            documentEpoch: 3,
            nodeRef: parentRef,
            branchRevision: 1,
          });
        } catch (error) {
          reentrantError = error;
        }
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    const parentView = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    parentRef = parentView.nodeRef;
    const selectedView = onlyChild(
      provider,
      parentView,
      root.documentEpoch,
      "parent-children",
    );
    selectedRef = selectedView.nodeRef;

    parent.remove(selected);
    harness.observers[0]!.emit([mutationRecord(parent, [], [selected])]);
    harness.flushTimers();

    expect(events).toEqual(["invalidated", "invalidated", "removed"]);
    expect(reentrantError).toMatchObject({ code: "stale-branch" });
  });

  it("notifies when the selected node is inside a removed frame", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const selected = createElement("button", childDocument);
    childDocument.documentElement.append(selected);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      childRootView,
      root.documentEpoch,
      "child-root-children",
    );
    selectedRef = selectedView.nodeRef;

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(removed).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
  });

  it("invalidates all old state when the top document epoch resets", () => {
    const document = createDocument();
    for (let index = 0; index < 51; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document);
    const oldRoot = harness.provider.getRoot();
    const oldPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "old-page",
      documentEpoch: oldRoot.documentEpoch,
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: oldRoot.node.branchRevision,
    });
    const nextDocument = createDocument();

    harness.provider.resetDocument(nextDocument as unknown as Document, 4);

    expect(() => harness.provider.getRoot(3)).toThrowError("stale-document");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-page",
      documentEpoch: 3,
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: oldPage.branchRevision,
      cursor: oldPage.nextCursor,
    })).toThrowError("stale-document");
    const nextRoot = harness.provider.getRoot(4);
    expect(nextRoot.documentEpoch).toBe(4);
    expect(nextRoot.node.nodeRef).not.toBe(oldRoot.node.nodeRef);
    expect(harness.observers[0]!.disconnectCount).toBe(1);
    expect(harness.observers.at(-1)!.observedTargets).toEqual([nextDocument]);
  });

  it("disposes all ownership and fails closed afterward", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );

    harness.provider.dispose();
    expect(() => harness.provider.dispose()).not.toThrow();

    expect(harness.observers.every((observer) => observer.disconnectCount === 1)).toBe(true);
    harness.observers[0]!.emit([mutationRecord(document.documentElement)]);
    harness.flushTimers();
    expect(invalidated).toEqual([]);
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "disposed-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("session-disposed");
    expect(() => harness.provider.ancestorPath(
      root.node.nodeRef,
      root.documentEpoch,
    )).toThrowError("session-disposed");
    expect(() => harness.provider.resetDocument(
      createDocument() as unknown as Document,
      4,
    )).toThrowError("session-disposed");
  });

  it("releases document and registry ownership when disposed at the maximum epoch", () => {
    const document = createDocument();
    document.documentElement.append(createElement("main", document));
    const harness = createProviderHarness(document, {
      documentEpoch: Number.MAX_SAFE_INTEGER,
    });
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retain-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });
    const before = harness.provider as unknown as {
      readonly nodeRegistry: { readonly size: number; readonly retainedSize: number };
      readonly topDocument?: Document;
    };
    const oldRegistry = before.nodeRegistry;
    expect(oldRegistry.size).toBeGreaterThan(0);
    expect(oldRegistry.retainedSize).toBeGreaterThan(0);

    harness.provider.dispose();

    const after = harness.provider as unknown as {
      readonly nodeRegistry: { readonly size: number; readonly retainedSize: number };
      readonly topDocument?: Document;
    };
    expect([
      after.topDocument === undefined,
      after.nodeRegistry !== oldRegistry,
      after.nodeRegistry.size,
      after.nodeRegistry.retainedSize,
    ]).toEqual([true, true, 0, 0]);
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
  });

  it("binds each cursor exactly to its node, epoch, and branch revision", () => {
    const document = createDocument();
    const firstParent = createElement("main", document);
    const secondParent = createElement("aside", document);
    for (let index = 0; index < 51; index += 1) {
      firstParent.append(createElement("p", document));
      secondParent.append(createElement("span", document));
    }
    document.documentElement.append(firstParent);
    document.documentElement.append(secondParent);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const parents = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstPage = provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[0]!.nodeRef,
      branchRevision: parents[0]!.branchRevision,
    });

    expect(() => provider.getChildren({
      type: "dom.getChildren",
      requestId: "mismatched-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: parents[1]!.branchRevision,
      cursor: firstPage.nextCursor,
    })).toThrowError("invalid-request");
  });

  it("bounds cursor storage and evicts the oldest record", () => {
    const document = createDocument();
    for (let index = 0; index < 51; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document, { maxCursors: 2 });
    const root = harness.provider.getRoot();
    const request = {
      type: "dom.getChildren" as const,
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    };
    const oldest = harness.provider.getChildren({
      ...request,
      requestId: "page-1",
    }).nextCursor!;
    const middle = harness.provider.getChildren({
      ...request,
      requestId: "page-2",
    }).nextCursor!;
    harness.provider.getChildren({
      ...request,
      requestId: "page-3",
    });

    expect(() => harness.provider.getChildren({
      ...request,
      requestId: "evicted-page",
      cursor: oldest,
    })).toThrowError("invalid-cursor");
    expect(harness.provider.getChildren({
      ...request,
      requestId: "live-page",
      cursor: middle,
    }).nodes).toHaveLength(1);
  });

  it("releases descendant cursors and shadow observation on collapse", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    for (let index = 0; index < 51; index += 1) {
      shadowRoot.append(createElement("button", document));
    }
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const shadowPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "shadow-page",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
    });

    harness.provider.collapse(hostView.nodeRef, root.documentEpoch);

    expect(harness.observers[0]!.disconnectCount).toBe(0);
    expect(harness.observers[1]!.disconnectCount).toBe(1);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "released-page",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
      cursor: shadowPage.nextCursor,
    })).toThrowError("invalid-cursor");
  });

  it("flushes pending selected removal before collapsing its observed host", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    const selected = createElement("button", document);
    shadowRoot.append(selected);
    document.documentElement.append(host);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      shadowView,
      root.documentEpoch,
      "shadow-children",
    );
    selectedRef = selectedView.nodeRef;
    const shadowObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;

    shadowRoot.remove(selected);
    shadowObserver.emit([mutationRecord(shadowRoot, [], [selected])]);
    harness.provider.collapse(hostView.nodeRef, root.documentEpoch);

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("preserves a branch generation across collapse and re-expansion", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    for (let index = 0; index < 51; index += 1) {
      parent.append(createElement("p", document));
    }
    document.documentElement.append(parent);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    });
    const added = createElement("p", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();
    harness.provider.collapse(parentView.nodeRef, root.documentEpoch);

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "delayed-revision-one",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "delayed-cursor",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revision-two-re-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).branchRevision).toBe(2);
  });

  it("fails a branch closed when its revision space is exhausted", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const internals = harness.provider as unknown as {
      readonly expandedBranches: Map<string, { revision: number }>;
    };
    internals.expandedBranches.get(parentView.nodeRef)!.revision =
      Number.MAX_SAFE_INTEGER;
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);

    expect(() => harness.flushTimers()).toThrowError("internal-error");
    expect(invalidated).toEqual([]);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "exhausted-branch",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: Number.MAX_SAFE_INTEGER,
    })).toThrowError("internal-error");
  });

  it("disconnects an expanded frame-document observer on ancestor collapse", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;

    harness.provider.collapse(frameView.nodeRef, root.documentEpoch);

    expect(childObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("releases a discovered unexpanded frame document on iframe collapse", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const unrelatedDocument = createDocument();
    document.documentElement.append(createFrameElement(document, childDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    expect(frameViews).toHaveLength(2);
    const frameDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "discover-frame-document",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    expect(childObserver.disconnectCount).toBe(1);
    expect(unrelatedObserver.disconnectCount).toBe(0);
    expect(() => harness.provider.ancestorPath(
      frameDocumentView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("releases an unmaterialized nested frame document on outer iframe collapse", () => {
    const document = createDocument();
    const outerDocument = createDocument();
    const nestedDocument = createDocument();
    const unrelatedDocument = createDocument();
    const nestedFrame = createFrameElement(outerDocument, nestedDocument);
    outerDocument.documentElement.append(nestedFrame);
    document.documentElement.append(createFrameElement(document, outerDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const outerDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "outer-frame-children",
    );
    const outerRootView = onlyChild(
      harness.provider,
      outerDocumentView,
      root.documentEpoch,
      "outer-document-children",
    );
    const nestedFrameView = onlyChild(
      harness.provider,
      outerRootView,
      root.documentEpoch,
      "outer-root-children",
    );
    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    expect(internals.refsByNode.get(nestedDocument)).toBeUndefined();
    const outerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(outerDocument)
    ))!;
    const nestedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(nestedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    expect([
      outerObserver.disconnectCount,
      nestedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
      unrelatedObserver.disconnectCount,
    ]).toEqual([1, 1, 0, 0]);
    expect([...internals.frameDocumentsByRef.values()]).toEqual([
      unrelatedDocument,
    ]);
    expect(() => harness.provider.ancestorPath(
      nestedFrameView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("releases an unmaterialized frame discovered below an ordinary ancestor", () => {
    const document = createDocument();
    const ancestor = createElement("main", document);
    const nestedDocument = createDocument();
    const nestedFrame = createFrameElement(document, nestedDocument);
    const unrelatedDocument = createDocument();
    document.documentElement.append(ancestor);
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;

    ancestor.append(nestedFrame);
    harness.observers[0]!.emit([mutationRecord(ancestor, [nestedFrame])]);
    harness.flushTimers();
    const nestedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(nestedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    expect(internals.refsByNode.get(nestedFrame)).toBeUndefined();

    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      nestedObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
    expect([...internals.frameDocumentsByRef.values()]).toEqual([
      unrelatedDocument,
    ]);
  });

  it("does not observe a collapsed iframe navigation until re-expansion", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "first-frame-document",
    );
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);
    expect(firstObserver.disconnectCount).toBe(1);

    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect([...internals.frameDocumentsByRef.values()]).not.toContain(nextDocument);
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const nextFrameDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "reexpanded-frame-document",
    );
    expect(nextFrameDocumentView.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("keeps a collapsed frame inactive while refreshing its parent row", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    document.documentElement.append(frame);
    document.documentElement.append(unrelatedFrame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "first-frame-document",
    );
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();

    expect(firstObserver.disconnectCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    const parentRevision = [...invalidated].reverse().find((branch) => (
      branch.nodeRef === root.node.nodeRef
    ))?.branchRevision;
    expect(parentRevision).toBe(2);

    const refreshedFrames = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "refreshed-top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: parentRevision!,
    }).nodes;

    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const currentDocumentView = onlyChild(
      harness.provider,
      refreshedFrames[0]!,
      root.documentEpoch,
      "current-frame-document",
    );
    expect(currentDocumentView.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("does not resurrect frames from a collapsed queued scan", () => {
    const document = createDocument();
    const collapsedDocument = createDocument();
    const unrelatedDocument = createDocument();
    document.documentElement.append(createFrameElement(document, collapsedDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "collapsed-frame-children",
    );
    onlyChild(
      harness.provider,
      frameViews[1]!,
      root.documentEpoch,
      "unrelated-frame-children",
    );
    const collapsedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(collapsedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    const collapsedContainer = createElement("main", collapsedDocument);
    const unrelatedContainer = createElement("main", unrelatedDocument);
    for (let index = 0; index < 1_100; index += 1) {
      collapsedContainer.append(createElement("span", collapsedDocument));
      unrelatedContainer.append(createElement("span", unrelatedDocument));
    }
    const collapsedLateDocument = createDocument();
    const unrelatedLateDocument = createDocument();
    const collapsedLateFrame = createFrameElement(
      collapsedDocument,
      collapsedLateDocument,
    );
    const unrelatedLateFrame = createFrameElement(
      unrelatedDocument,
      unrelatedLateDocument,
    );
    collapsedContainer.append(collapsedLateFrame);
    unrelatedContainer.append(unrelatedLateFrame);
    collapsedDocument.documentElement.append(collapsedContainer);
    unrelatedDocument.documentElement.append(unrelatedContainer);
    collapsedObserver.emit([
      mutationRecord(collapsedDocument.documentElement, [collapsedContainer]),
    ]);
    unrelatedObserver.emit([
      mutationRecord(unrelatedDocument.documentElement, [unrelatedContainer]),
    ]);
    harness.flushTimers();
    expect([
      collapsedLateFrame.loadListenerCount,
      unrelatedLateFrame.loadListenerCount,
    ]).toEqual([0, 0]);

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);
    harness.flushTimers();
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    const ownedDocuments = [...internals.frameDocumentsByRef.values()];
    expect([
      collapsedLateFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(collapsedLateDocument)
      )),
      ownedDocuments.includes(collapsedLateDocument),
      unrelatedLateFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(unrelatedLateDocument)
      )),
      ownedDocuments.includes(unrelatedLateDocument),
      collapsedObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([0, false, false, 1, true, true, 1, 0, 0]);
  });

  it("does not reactivate a collapsed frame from a bounded discovery scan", () => {
    const document = createDocument();
    const scannedContainer = createElement("main", document);
    const unrelatedContainer = createElement("aside", document);
    for (let index = 0; index < 250; index += 1) {
      scannedContainer.append(createElement("span", document));
      unrelatedContainer.append(createElement("span", document));
    }
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    scannedContainer.append(frame);
    unrelatedContainer.append(unrelatedFrame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    document.documentElement.append(scannedContainer);
    document.documentElement.append(unrelatedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [
        scannedContainer,
        unrelatedContainer,
      ]),
    ]);
    harness.flushTimers();
    expect([frame.loadListenerCount, unrelatedFrame.loadListenerCount]).toEqual([
      1,
      1,
    ]);
    const rootRevision = [...invalidated].reverse().find((branch) => (
      branch.nodeRef === root.node.nodeRef
    ))?.branchRevision;
    expect(rootRevision).toBe(2);
    const containers = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "containers",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: rootRevision!,
    }).nodes;
    const scannedContainerView = containers.find((node) => node.label === "main")!;
    let frameView: typeof scannedContainerView | undefined;
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `scanned-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: scannedContainerView.nodeRef,
        branchRevision: scannedContainerView.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      frameView ??= page.nodes.find((node) => node.label === "iframe");
      cursor = page.nextCursor;
      pageIndex += 1;
    } while (cursor);
    expect(frameView).toBeDefined();
    expect(frame.loadListenerCount).toBe(1);
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;

    harness.provider.collapse(frameView!.nodeRef, root.documentEpoch);
    expect(firstObserver.disconnectCount).toBe(1);
    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);

    harness.flushTimers();
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect([...internals.frameDocumentsByRef.values()]).not.toContain(nextDocument);
    expect(unrelatedFrame.loadListenerCount).toBe(1);
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const currentFrameDocument = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "direct-frame-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: frameView!.nodeRef,
      branchRevision: frameView!.branchRevision,
    });
    expect(currentFrameDocument.nodes).toHaveLength(1);
    expect(currentFrameDocument.nodes[0]?.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("does not register a queued frame after its scan root is detached", () => {
    const document = createDocument();
    const detachedContainer = createElement("main", document);
    const unrelatedContainer = createElement("aside", document);
    for (let index = 0; index < 1_100; index += 1) {
      detachedContainer.append(createElement("span", document));
      unrelatedContainer.append(createElement("span", document));
    }
    const detachedDocument = createDocument();
    const unrelatedDocument = createDocument();
    const detachedFrame = createFrameElement(document, detachedDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    detachedContainer.append(detachedFrame);
    unrelatedContainer.append(unrelatedFrame);
    const harness = createProviderHarness(document);

    document.documentElement.append(detachedContainer);
    document.documentElement.append(unrelatedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [
        detachedContainer,
        unrelatedContainer,
      ]),
    ]);
    harness.flushTimers();
    expect([
      detachedFrame.loadListenerCount,
      unrelatedFrame.loadListenerCount,
    ]).toEqual([0, 0]);

    document.documentElement.remove(detachedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [detachedContainer]),
    ]);
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect([
      detachedFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(detachedDocument)
      )),
      [...internals.frameDocumentsByRef.values()].includes(detachedDocument),
    ]).toEqual([0, false, false]);

    harness.flushTimers();
    expect([
      unrelatedFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(unrelatedDocument)
      )),
      [...internals.frameDocumentsByRef.values()].includes(unrelatedDocument),
    ]).toEqual([1, true, true]);
  });

  it("registers and unregisters frame contexts from document mutations", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });
    const frame = createFrameElement(document, childDocument);

    document.documentElement.append(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [frame]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(childDocument)
    ))).toBe(true);

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(0);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ));
    expect(childObserver?.disconnectCount).toBe(1);
  });

  it("continues a bounded scan to register a late frame in an added subtree", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    for (let index = 0; index < 1_100; index += 1) {
      container.append(createElement("span", document));
    }
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const harness = createProviderHarness(document);

    document.documentElement.append(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [container]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(0);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(childDocument)
    ))).toBe(true);
  });

  it("continues a bounded scan to unregister a late frame in a removed subtree", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    for (let index = 0; index < 1_100; index += 1) {
      container.append(createElement("span", document));
    }
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [container]),
    ]);
    harness.flushTimers();
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;

    document.documentElement.remove(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [container]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(1);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(0);
    expect(childObserver.disconnectCount).toBe(1);
  });

  it("replaces observed frame documents when a frame navigates", () => {
    const document = createDocument();
    const firstChildDocument = createDocument();
    const frame = createFrameElement(document, firstChildDocument);
    document.documentElement.append(frame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const documentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const firstChildRoot = onlyChild(
      harness.provider,
      documentView,
      root.documentEpoch,
      "document-children",
    );
    const nextChildDocument = createDocument();

    frame.setFrameDocument(nextChildDocument);
    frame.dispatchLoad();

    const oldObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstChildDocument)
    ));
    expect(oldObserver?.disconnectCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextChildDocument)
    ))).toBe(true);
    expect(invalidated).toContainEqual({
      nodeRef: frameView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.ancestorPath(
      firstChildRoot.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("disconnects nested shadow observers when a frame navigates", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const host = createElement("article", childDocument);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", childDocument));
    childDocument.documentElement.append(host);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const hostView = onlyChild(
      harness.provider,
      childRootView,
      root.documentEpoch,
      "child-root-children",
    );
    onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    const shadowObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;

    frame.setFrameDocument(createDocument());
    frame.dispatchLoad();

    expect(childObserver.disconnectCount).toBe(1);
    expect(shadowObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("invalidates queued mutations before serving any child data", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "old-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
  });

  it("fails closed rather than delivering a hostile tag with an empty locator", () => {
    const document = createDocument();
    const hostileTagName = `<SCRIPT>${"x".repeat(600)}</SCRIPT>`;
    document.documentElement.append(new FakeElement(hostileTagName, document));
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(() => onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    )).toThrowError("node-unavailable");
  });

  it("includes approved identity and attribute names without private values", () => {
    const document = createDocument();
    const element = createElement("div", document);
    element.setAttribute("id", "hero");
    element.setAttribute("class", "card featured");
    element.setAttribute("role", "region");
    element.setAttribute("data-state", "secret-ready");
    element.setAttribute("aria-label", "Private account name");
    element.setAttribute("value", "private form value");
    element.setAttribute("onclick", "sendPrivateData() <script>");
    element.setAttribute("style", "background:url(private)");
    document.documentElement.append(element);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const child = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(child.label).toBe(
      "div#hero.card.featured [role] [data-state] [aria-label]",
    );
    expect(child.label).not.toMatch(
      /region|secret-ready|Private account|private form|sendPrivateData|style|onclick|[<>]/,
    );
  });

  it("rejects malformed child requests with a typed invalid-request error", () => {
    const document = createDocument();
    const provider = createProvider(document);
    const root = provider.getRoot();

    let error: unknown;
    try {
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "malformed",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: Number.NaN,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DomTreeProviderError);
    expect(error).toMatchObject({
      code: "invalid-request",
      message: "invalid-request",
    });
  });

  it("rechecks a late shadow root before a direct child response", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.append(createElement("span", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    host.attachShadow().append(createElement("button", document));

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(invalidated).toEqual([]);
  });

  it("resumes physical traversal without rescanning earlier child pages", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const provider = createProvider(document);
    const root = provider.getRoot();
    indexedReads = 0;

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const readsBeforePage = indexedReads;
      const page = provider.getChildren({
        type: "dom.getChildren",
        requestId: `page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });

      expect(page.nodes).toHaveLength(50);
      expect(page.nextCursor).toBeDefined();
      expect(indexedReads - readsBeforePage).toBeLessThanOrEqual(100_000);
      cursor = page.nextCursor;
    }
  });

  it("bounds physical traversal through non-element children", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createText(`text-${index}`));
    }
    document.documentElement.append(createElement("section", document));
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const provider = createProvider(document);
    const root = provider.getRoot();
    indexedReads = 0;
    let cursor: string | undefined;
    const found = [];

    for (let pageIndex = 0; pageIndex < 5 && found.length === 0; pageIndex += 1) {
      const readsBeforePage = indexedReads;
      const page = provider.getChildren({
        type: "dom.getChildren",
        requestId: `text-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.nodes);

      expect(indexedReads - readsBeforePage).toBeLessThanOrEqual(12_000);
      if (found.length === 0) {
        expect(page.nextCursor).toBeDefined();
      }
      cursor = page.nextCursor;
    }

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "element", label: "section" });
  });

  it("probes root and row expandability without scanning text-heavy children", () => {
    const rootDocument = createDocument();
    for (let index = 0; index < 10_000; index += 1) {
      rootDocument.documentElement.append(createText(`root-text-${index}`));
    }
    const rootChild = createElement("main", rootDocument);
    rootDocument.documentElement.append(rootChild);
    const rootChildNodes = rootDocument.documentElement.childNodes;
    let rootIndexedReads = 0;
    Object.defineProperty(rootDocument.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(rootChildNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rootIndexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(rootDocument.documentElement, "childElementCount", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(rootDocument.documentElement, "firstElementChild", {
      configurable: true,
      get: () => rootChild,
    });

    const rootView = createProvider(rootDocument).getRoot();
    expect(rootView.node.expandable).toBe(true);
    expect(rootIndexedReads).toBe(0);

    const rowDocument = createDocument();
    const row = createElement("article", rowDocument);
    for (let index = 0; index < 10_000; index += 1) {
      row.append(createText(`row-text-${index}`));
    }
    const rowChild = createElement("button", rowDocument);
    row.append(rowChild);
    rowDocument.documentElement.append(row);
    const rowChildNodes = row.childNodes;
    let rowIndexedReads = 0;
    Object.defineProperty(row, "childNodes", {
      configurable: true,
      get: () => new Proxy(rowChildNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rowIndexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(row, "childElementCount", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(row, "firstElementChild", {
      configurable: true,
      get: () => rowChild,
    });
    const rowProvider = createProvider(rowDocument);
    const rowRoot = rowProvider.getRoot();
    rowIndexedReads = 0;

    const rowView = onlyChild(
      rowProvider,
      rowRoot.node,
      rowRoot.documentEpoch,
      "row",
    );
    expect(rowView.expandable).toBe(true);
    expect(rowIndexedReads).toBe(0);
  });

  it("keeps an invalid expandable primitive conservative and constant-time", () => {
    const document = createDocument();
    for (let index = 0; index < 10_000; index += 1) {
      document.documentElement.append(createText(`text-${index}`));
    }
    document.documentElement.append(createElement("main", document));
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(document.documentElement, "childElementCount", {
      configurable: true,
      get: () => "invalid",
    });
    Object.defineProperty(document.documentElement, "firstElementChild", {
      configurable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });

    const root = createProvider(document).getRoot();

    expect(root.node.expandable).toBe(true);
    expect(indexedReads).toBe(0);
  });

  it("bounds provider records while retaining selected and expanded authority", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
    });
    const root = harness.provider.getRoot();
    let cursor: string | undefined;
    let evictedRef: string | undefined;
    let lastRef: string | undefined;

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `materialize-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.nodes).toHaveLength(50);
      if (pageIndex === 0) {
        selectedRef = page.nodes[0]!.nodeRef;
        evictedRef = page.nodes[1]!.nodeRef;
      }
      lastRef = page.nodes.at(-1)!.nodeRef;
      cursor = page.nextCursor;
    }

    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(cursor).toBeUndefined();
    expect(internals.records.size).toBeLessThanOrEqual(64);
    expect(internals.records.has(root.node.nodeRef)).toBe(true);
    expect(internals.records.has(selectedRef!)).toBe(true);
    expect(internals.records.has(lastRef!)).toBe(true);
    expect(() => harness.provider.ancestorPath(
      selectedRef!,
      root.documentEpoch,
    )).not.toThrow();
    expect(() => harness.provider.ancestorPath(
      evictedRef!,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("protects the complete selected ancestor path under record pressure", () => {
    const document = createDocument();
    const selectedRoot = createElement("main", document);
    let selectedParent = selectedRoot;
    for (let depth = 0; depth < 8; depth += 1) {
      const child = createElement("section", document);
      selectedParent.append(child);
      selectedParent = child;
    }
    const selected = createElement("button", document);
    selectedParent.append(selected);
    const unrelatedParent = createElement("aside", document);
    for (let index = 0; index < 200; index += 1) {
      unrelatedParent.append(createElement("p", document));
    }
    document.documentElement.append(selectedRoot);
    document.documentElement.append(unrelatedParent);
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    let selectedView = topChildren[0]!;
    for (let depth = 0; depth < 9; depth += 1) {
      selectedView = onlyChild(
        harness.provider,
        selectedView,
        root.documentEpoch,
        `selected-depth-${depth}`,
      );
    }
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    let cursor: string | undefined;
    let staleUnrelatedRef: string | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `unrelated-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: topChildren[1]!.nodeRef,
        branchRevision: topChildren[1]!.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      staleUnrelatedRef ??= page.nodes[0]!.nodeRef;
      cursor = page.nextCursor;
    }

    const selectedPath = harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    );
    expect(selectedPath).toHaveLength(11);
    expect(selectedPath[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(selectedPath.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
    expect(() => harness.provider.ancestorPath(
      staleUnrelatedRef!,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(internals.records.size).toBeLessThanOrEqual(64);
  });

  it("fails closed when the record capacity is fully retained", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("button", document));
    document.documentElement.append(parent);
    const harness = createProviderHarness(document, { maxRecords: 2 });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-child",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "capacity-exhausted",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    })).toThrowError("node-unavailable");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    expect([internals.records.size, internals.nodeRegistry.size]).toEqual([2, 2]);
  });

  it("does not evict rows while assembling the same child page", () => {
    const document = createDocument();
    for (let index = 0; index < 10; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document, { maxRecords: 8 });
    const root = harness.provider.getRoot();

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "oversized-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    expect(internals.records.size).toBeLessThanOrEqual(8);
    expect(internals.nodeRegistry.size).toBeLessThanOrEqual(8);
  });

  it("cleans nested branches and observers on collapse", () => {
    const document = createDocument();
    const collapsedRoot = createElement("main", document);
    let current = collapsedRoot;
    for (let depth = 0; depth < 60; depth += 1) {
      const child = createElement("section", document);
      current.append(child);
      current = child;
    }
    const deepShadow = current.attachShadow();
    for (let index = 0; index < 51; index += 1) {
      deepShadow.append(createElement("button", document));
    }
    const unrelatedHost = createElement("aside", document);
    const unrelatedShadow = unrelatedHost.attachShadow();
    unrelatedShadow.append(createElement("span", document));
    document.documentElement.append(collapsedRoot);
    document.documentElement.append(unrelatedHost);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    let deepView = topChildren[0]!;
    for (let depth = 0; depth < 60; depth += 1) {
      deepView = onlyChild(
        harness.provider,
        deepView,
        root.documentEpoch,
        `depth-${depth}`,
      );
    }
    const deepShadowView = onlyChild(
      harness.provider,
      deepView,
      root.documentEpoch,
      "deep-shadow",
    );
    const deepPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "deep-page",
      documentEpoch: root.documentEpoch,
      nodeRef: deepShadowView.nodeRef,
      branchRevision: deepShadowView.branchRevision,
    });
    const unrelatedShadowView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "unrelated-shadow",
    );
    onlyChild(
      harness.provider,
      unrelatedShadowView,
      root.documentEpoch,
      "unrelated-child",
    );
    const deepObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(deepShadow)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedShadow)
    ))!;

    expect(harness.provider.ancestorPath(
      deepShadowView.nodeRef,
      root.documentEpoch,
    )).toHaveLength(63);

    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      deepObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "released-deep-page",
      documentEpoch: root.documentEpoch,
      nodeRef: deepShadowView.nodeRef,
      branchRevision: deepShadowView.branchRevision,
      cursor: deepPage.nextCursor,
    })).toThrowError("invalid-cursor");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "unrelated-still-live",
      documentEpoch: root.documentEpoch,
      nodeRef: unrelatedShadowView.nodeRef,
      branchRevision: unrelatedShadowView.branchRevision,
    }).nodes).toHaveLength(1);
  });

  it("looks up only already-materialized live elements with their frame identity", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const card = createElement("article", document);
    body.append(card);
    document.documentElement.append(body);
    const provider = createProvider(document);

    const root = provider.getRoot();
    const records = (provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    }).records;
    const recordCount = records.size;

    expect(provider.lookupElement(card as unknown as Element)).toBeUndefined();
    expect(records.size).toBe(recordCount);
    expect(provider.lookupElement(document.documentElement as unknown as Element))
      .toEqual({
        nodeRef: root.node.nodeRef,
        frameRef: "frame-1",
        frameEpoch: 1,
        documentEpoch: root.documentEpoch,
      });
  });

  it("reveals an attached element through one bounded materialized ancestor path", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const card = createElement("article", document);
    body.append(card);
    document.documentElement.append(body);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const revealed = provider.revealElement(card as unknown as Element);

    expect(revealed).toMatchObject({
      frameRef: "frame-1",
      frameEpoch: 1,
      documentEpoch: root.documentEpoch,
    });
    expect(revealed.ancestorPath.map((node) => node.label)).toEqual([
      "html",
      "body",
      "article",
    ]);
    expect(revealed.ancestorPath[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(revealed.ancestorPath.at(-1)?.nodeRef).toBe(revealed.nodeRef);
    expect(provider.lookupElement(card as unknown as Element)?.nodeRef)
      .toBe(revealed.nodeRef);
  });

  it("resolves and retains current element refs for independent session authorities", () => {
    const document = createDocument();
    const card = createElement("article", document);
    document.documentElement.append(card);
    const provider = createProvider(document);
    const revealed = provider.revealElement(card as unknown as Element);

    expect(provider.resolveElement(revealed.nodeRef, revealed.documentEpoch))
      .toEqual({
        element: card,
        nodeRef: revealed.nodeRef,
        frameRef: "frame-1",
        frameEpoch: 1,
        documentEpoch: revealed.documentEpoch,
      });
    expect(provider.resolveElement("node-999", revealed.documentEpoch))
      .toBeUndefined();
    expect(() => provider.resolveElement(revealed.nodeRef, 2))
      .toThrowError("stale-document");

    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "selected",
    )).toBe(true);
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);
    const registry = (provider as unknown as {
      readonly nodeRegistry: {
        retentionReasons(nodeRef: string): readonly string[];
      };
    }).nodeRegistry;
    expect(registry.retentionReasons(revealed.nodeRef))
      .toEqual(["selected", "hovered"]);

    provider.releaseNode(revealed.nodeRef, "hovered");
    expect(registry.retentionReasons(revealed.nodeRef)).toEqual(["selected"]);
    provider.releaseNode(revealed.nodeRef, "selected");
    expect(registry.retentionReasons(revealed.nodeRef)).toEqual([]);
  });

  it("stops resolving a retained element as soon as it detaches", () => {
    const document = createDocument();
    const card = createElement("article", document);
    document.documentElement.append(card);
    const provider = createProvider(document);
    const revealed = provider.revealElement(card as unknown as Element);
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);

    document.documentElement.remove(card);

    expect(provider.lookupElement(card as unknown as Element)).toBeUndefined();
    expect(provider.resolveElement(revealed.nodeRef, revealed.documentEpoch))
      .toBeUndefined();
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "selected",
    )).toBe(false);
  });

  it("exposes read-only frame authority and forwards tracked frame lifecycle", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const replacementDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const lifecycle: Array<{
      readonly type: string;
      readonly frameRef: string;
      readonly frameEpoch: number;
    }> = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });

    expect(Object.isFrozen(harness.provider.frameAuthority)).toBe(true);
    expect("describeFrame" in harness.provider.frameAuthority).toBe(false);
    expect(harness.provider.currentDocumentEpoch).toBe(3);

    harness.provider.startFrameTracking();

    const child = harness.provider.frameAuthority
      .getContextForDocument(childDocument as unknown as Document);
    expect(child).toMatchObject({
      frameRef: "frame-2",
      frameEpoch: 1,
      documentEpoch: 3,
    });
    expect(lifecycle.map(({ type }) => type)).toEqual(["registered"]);

    frame.setFrameDocument(replacementDocument);
    frame.dispatchLoad();
    expect(harness.provider.frameAuthority
      .getContextForDocument(childDocument as unknown as Document))
      .toBeUndefined();
    expect(harness.provider.frameAuthority
      .getContextForDocument(replacementDocument as unknown as Document))
      .toMatchObject({ frameRef: "frame-2", frameEpoch: 2 });

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(lifecycle.map(({ type }) => type)).toEqual([
      "registered",
      "navigated",
      "removed",
    ]);
    expect(harness.provider.frameAuthority.getContext("frame-2"))
      .toBeUndefined();
  });

  it("excludes overlay-owned nodes from traversal and mutation discovery", () => {
    const document = createDocument();
    const pageContent = createElement("main", document);
    const overlayHost = createElement("browser2ide-overlay", document);
    const overlayRoot = overlayHost.attachShadow();
    const overlayArtifact = createElement("div", document);
    overlayRoot.append(overlayArtifact);
    document.documentElement.append(pageContent);
    document.documentElement.append(overlayHost);
    const overlayNodes = new Set<FakeNode>([
      overlayHost,
      overlayRoot,
      overlayArtifact,
    ]);
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => overlayNodes.has(node as unknown as FakeNode),
    });

    const root = harness.provider.getRoot();
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "without-overlay",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["main"]);
    expect(harness.provider.lookupElement(overlayHost as unknown as Element))
      .toBeUndefined();
    expect(() => harness.provider.revealElement(
      overlayHost as unknown as Element,
    )).toThrowError("node-unavailable");
    expect(() => harness.provider.revealElement(
      overlayArtifact as unknown as Element,
    )).toThrowError("node-unavailable");

    document.documentElement.remove(overlayHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [overlayHost]),
    ]);
    document.documentElement.append(overlayHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [overlayHost]),
    ]);
    harness.flushTimers();

    const refreshedRoot = harness.provider.getRoot();
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "without-reattached-overlay",
      documentEpoch: refreshedRoot.documentEpoch,
      nodeRef: refreshedRoot.node.nodeRef,
      branchRevision: refreshedRoot.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["main"]);
    expect(harness.provider.lookupElement(overlayHost as unknown as Element))
      .toBeUndefined();
  });

  it("resolves an equivalent heading through fresh refs and its complete ancestor path", () => {
    const first = createHeadingTree({ includeAttributes: false });
    const unrelated = createElement("aside", first.document);
    first.document.documentElement.append(unrelated);
    first.provider.revealElement(unrelated as unknown as Element);
    const original = first.provider.revealElement(first.target as unknown as Element);
    const second = createHeadingTree({ includeAttributes: false });

    const restored = resolveLocator(
      second.provider,
      original.ancestorPath.at(-1)!.locator,
    );

    expect(restored?.node.nodeRef).not.toBe(original.nodeRef);
    expect(restored?.ancestorPath.map(({ label }) => label)).toEqual([
      "html",
      "body",
      "main",
      "h2#section_title_id1.block_title",
    ]);
  });

  it("rejects a locator whose captured ID is duplicated in the current boundary", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const duplicate = createElement("h2", second.document);
    duplicate.id = "section_title_id1";
    duplicate.className = "block_title";
    duplicate.setAttribute("data-section", "intro");
    second.main.append(duplicate);

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when the exact structural index has a changed tag", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ tagName: "p" });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when its captured class evidence changes", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ className: "replaced_title" });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it.each([
    ["data-section", "changed"],
    ["aria-label", "changed"],
    ["role", "heading"],
  ])("rejects a locator when captured %s evidence changes", (name, value) => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ attribute: { name, value } });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when a structural sibling is missing", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("resolves nested open-shadow paths and rejects a missing shadow boundary", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toBe("button#shadow_target.action");

    const missing = createNestedShadowTree({ attachInnerShadow: false });
    expect(resolveLocator(missing.provider, locator)).toBeUndefined();
  });

  it("resolves a registered same-origin frame and rejects an inaccessible replacement", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree();

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toBe("button#frame_target.action");

    const inaccessible = createFramedButtonTree({
      accessError: new Error("cross-origin"),
    });
    expect(resolveLocator(inaccessible.provider, locator)).toBeUndefined();
  });

  it("does not consult materialized session refs while resolving a locator", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    second.provider.resolveElement = () => {
      throw new Error("stale ref consulted");
    };

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toContain("h2#section_title_id1.block_title");
  });

  it("rejects a locator whose traversal exceeds 64 structural segments", () => {
    const provider = createProvider(createDocument());
    const segment = Object.freeze({ tagName: "div", siblingIndex: 0 });
    const locator = Object.freeze({
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: Object.freeze([]),
      path: Object.freeze(Array.from({ length: 65 }, () => segment)),
    });

    expect(resolveLocator(provider, locator)).toBeUndefined();
  });

  it("never delivers an empty locator when capture cannot prove identity", () => {
    const hostileDocument = createDocument();
    hostileDocument.documentElement.append(
      new FakeElement(`<SCRIPT>${"x".repeat(600)}</SCRIPT>`, hostileDocument),
    );
    const hostileProvider = createProvider(hostileDocument);
    const hostileRoot = hostileProvider.getRoot();
    expect(() => onlyChild(
      hostileProvider,
      hostileRoot.node,
      hostileRoot.documentEpoch,
      "hostile-capture",
    )).toThrowError("node-unavailable");

    const deepDocument = createDocument();
    let parent = deepDocument.documentElement;
    for (let depth = 0; depth < 64; depth += 1) {
      const child = createElement("section", deepDocument);
      parent.append(child);
      parent = child;
    }
    const deepProvider = createProvider(deepDocument);
    let view = deepProvider.getRoot().node;
    for (let depth = 0; depth < 63; depth += 1) {
      view = onlyChild(deepProvider, view, 3, `deep-${depth}`);
      expect(view.locator.path).not.toHaveLength(0);
    }
    expect(() => onlyChild(deepProvider, view, 3, "too-deep")).toThrowError(
      "node-unavailable",
    );
  });

  it("captures canonical punctuation-bearing attributes in parser order", () => {
    const first = createHeadingTree({ includeAttributes: false });
    first.target.setAttribute("data-a_", "underscore");
    first.target.setAttribute("data-a.0", "dot");
    first.target.setAttribute("data-a1", "digit");
    first.target.setAttribute("data-a", "dash");
    const locator = locatorFor(first.provider, first.target);
    const attributes = locator.path.at(-1)?.attributes ?? [];

    expect(attributes.map(({ name }) => name)).toEqual([
      "data-a",
      "data-a.0",
      "data-a1",
      "data-a_",
    ]);

    const second = createHeadingTree({ includeAttributes: false });
    second.target.setAttribute("data-a1", "digit");
    second.target.setAttribute("data-a_", "underscore");
    second.target.setAttribute("data-a", "dash");
    second.target.setAttribute("data-a.0", "dot");
    expect(resolveLocator(second.provider, locator)?.node.kind).toBe("element");
  });

  it("captures deterministic bounded evidence and rejects oversized hostile collections", () => {
    const first = createHeadingTree({ includeAttributes: false });
    for (let index = 9; index >= 0; index -= 1) {
      first.target.setAttribute(`data-key-${index}`, String(index));
    }
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.attributes?.map(({ name }) => name)).toEqual([
      "data-key-0",
      "data-key-1",
      "data-key-2",
      "data-key-3",
      "data-key-4",
      "data-key-5",
      "data-key-6",
      "data-key-7",
    ]);

    const oversized = createHeadingTree({ includeAttributes: false });
    for (let index = 0; index <= 256; index += 1) {
      oversized.target.setAttribute(`data-overflow-${index}`, String(index));
    }
    expect(() => locatorFor(oversized.provider, oversized.target)).toThrowError(
      "node-unavailable",
    );
  });

  it("delivers only non-empty recoverable locators for ordinary element, shadow, and frame views", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(host);
    document.documentElement.append(frame);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const [hostView, frameView] = provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordinary-views",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const shadowView = onlyChild(provider, hostView!, root.documentEpoch, "ordinary-shadow");
    const frameDocumentView = onlyChild(provider, frameView!, root.documentEpoch, "ordinary-frame");

    for (const view of [root.node, hostView!, shadowView, frameView!, frameDocumentView]) {
      expect(view.locator.path.length + view.locator.boundaries.length).toBeGreaterThan(0);
      expect(resolveLocator(provider, view.locator)?.node.kind).toBe(view.kind);
    }
  });

  it("fails closed before scanning more than 256 physical children in one level", () => {
    const first = createDocument();
    let firstTarget!: FakeElement;
    for (let index = 0; index < 1_025; index += 1) {
      const sibling = createElement("span", first);
      first.documentElement.append(sibling);
      firstTarget = sibling;
    }
    firstTarget.id = "wide_target";
    expect(() => locatorFor(createProvider(first), firstTarget)).toThrowError("node-unavailable");
  });

  it("rejects an oversized child collection before indexed structural reads", () => {
    const tree = createHeadingTree();
    let indexedReads = 0;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => new Proxy({ length: 257 }, {
        get: (collection, key) => {
          if (typeof key === "string" && /^\\d+$/.test(key)) indexedReads += 1;
          return Reflect.get(collection, key);
        },
      }),
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
    expect(indexedReads).toBe(0);
  });

  it("shares the locator visit budget across nested structural proofs", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    const collections: Array<{ readonly parent: FakeElement; readonly children: FakeNode[] }> = [];
    for (let depth = 0; depth < 53; depth += 1) {
      const next = createElement(depth === 52 ? "h2" : "section", document);
      const children: FakeNode[] = [];
      for (let index = 0; index < 255; index += 1) {
        const sibling = createElement("span", document);
        parent.append(sibling);
        children.push(sibling);
      }
      parent.append(next);
      children.push(next);
      collections.push({ parent, children });
      parent = next;
      target = next;
    }
    const provider = createProvider(document);
    const service = (provider as unknown as {
      readonly locatorService: {
        capture(node: Node, kind: "element"): DomStableLocator;
        resolve(locator: DomStableLocator): unknown;
      };
    }).locatorService;
    const locator = service.capture(target as unknown as Node, "element");
    let indexedReads = 0;
    for (const { parent: collectionParent, children } of collections) {
      Object.defineProperty(collectionParent, "childNodes", {
        configurable: true,
        get: () => new Proxy(children, {
          get: (collection, key) => {
            if (typeof key === "string" && /^\\d+$/.test(key)) indexedReads += 1;
            return Reflect.get(collection, key);
          },
        }),
      });
    }

    expect(service.resolve(locator)).toBeUndefined();
    expect(indexedReads).toBeLessThanOrEqual(65_536);
  });

  it("charges previous-sibling walks to the shared locator visit budget", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    let siblingReads = 0;
    for (let depth = 0; depth < 63; depth += 1) {
      const next = createElement(depth === 62 ? "h2" : "section", document);
      const children: FakeElement[] = [];
      for (let index = 0; index < 255; index += 1) {
        const sibling = createElement("span", document);
        parent.append(sibling);
        children.push(sibling);
      }
      parent.append(next);
      children.push(next);
      for (const child of children) {
        const previous = child.previousElementSibling;
        Object.defineProperty(child, "previousElementSibling", {
          configurable: true,
          get: () => {
            siblingReads += 1;
            return previous;
          },
        });
      }
      parent = next;
      target = next;
    }
    const provider = createProvider(document);
    const service = (provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;

    expect(() => service.capture(target as unknown as Node, "element"))
      .toThrow("Invalid stable DOM locator");
    expect(siblingReads).toBeLessThanOrEqual(65_536);
  });

  it("charges bounded class and attribute evidence reads to the shared locator budget", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    let evidenceReads = 0;
    for (let depth = 0; depth < 53; depth += 1) {
      const next = createElement(depth === 52 ? "h2" : "section", document);
      for (let index = 0; index < 255; index += 1) {
        parent.append(createElement("span", document));
      }
      parent.append(next);
      const classes = Array.from({ length: 256 }, (_, index) => `class-${index}`);
      const attributes = Array.from({ length: 256 }, (_, index) => ({
        name: `data-key-${index}`,
        value: String(index),
      }));
      for (const collection of [classes, attributes]) {
        Object.defineProperty(next, collection === classes ? "classList" : "attributes", {
          configurable: true,
          get: () => new Proxy(collection, {
            get: (value, key) => {
              if (typeof key === "string" && /^\d+$/.test(key)) evidenceReads += 1;
              return Reflect.get(value, key);
            },
          }),
        });
      }
      parent = next;
      target = next;
    }
    const service = (createProvider(document) as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;

    expect(() => service.capture(target as unknown as Node, "element")).toThrow();
    expect(evidenceReads).toBeLessThanOrEqual(65_536);
  });

  it("resolves a captured shadow-root target with a fresh full materialized path", () => {
    const first = createNestedShadowTree();
    const firstUnrelated = createElement("aside", first.document);
    first.document.documentElement.append(firstUnrelated);
    first.provider.revealElement(firstUnrelated as unknown as Element);
    first.document.documentElement.remove(firstUnrelated);
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-shadow-root");
    const second = createNestedShadowTree();
    const secondRoot = second.provider.getRoot();
    const secondHost = onlyChild(second.provider, secondRoot.node, 3, "second-shadow-host");
    onlyChild(second.provider, secondHost, 3, "second-shadow-root");

    const restored = resolveLocator(second.provider, firstShadow.locator);

    expect(restored?.node.kind).toBe("shadow-root");
    expect(restored?.node.nodeRef).not.toBe(firstShadow.nodeRef);
    expect(restored?.ancestorPath.map(({ kind }) => kind)).toEqual([
      "element",
      "element",
      "shadow-root",
    ]);
  });

  it("rejects malformed shadow-root targets during capture and resolution", () => {
    const first = createNestedShadowTree();
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-malformed-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-malformed-shadow-root");
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const unrelated = createElement("aside", second.document);
    const unrelatedRoot = unrelated.attachShadow();

    outer.shadowRoot = unrelatedRoot;
    expect(resolveStableLocator(second.provider, firstShadow.locator)).toBeUndefined();

    const capture = createNestedShadowTree();
    const captureRoot = capture.provider.getRoot();
    const captureHost = onlyChild(capture.provider, captureRoot.node, 3, "hostile-shadow-host");
    const captureShadow = (capture.document.documentElement.childNodes[0] as FakeElement).shadowRoot!;
    Object.defineProperty(captureShadow, "host", {
      configurable: true,
      get: () => {
        throw new Error("hostile shadow host");
      },
    });
    expect(() => onlyChild(
      capture.provider,
      captureHost,
      3,
      "hostile-shadow-root",
    )).toThrowError("node-unavailable");
  });

  it("rejects a cyclic shadow-root target", () => {
    const first = createNestedShadowTree();
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-cyclic-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-cyclic-shadow-root");
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const outerShadow = outer.shadowRoot!;

    Object.defineProperty(outerShadow, "host", {
      configurable: true,
      value: outerShadow,
    });

    expect(resolveStableLocator(second.provider, firstShadow.locator)).toBeUndefined();
  });

  it("rejects malformed shadow-root boundaries before resolving an element target", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const outerShadow = outer.shadowRoot!;

    Object.defineProperty(outerShadow, "host", {
      configurable: true,
      value: outerShadow,
    });
    Object.defineProperty(outerShadow, "getRootNode", {
      configurable: true,
      value: () => outer,
    });

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a shadow boundary whose host points at a different element", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const unrelated = createElement("aside", second.document);
    const unrelatedRoot = unrelated.attachShadow();

    outer.shadowRoot = unrelatedRoot;

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
  });

  it("resolves a captured frame-document target through its registered exact host", () => {
    const first = createFramedButtonTree({ materialize: false });
    const firstUnrelated = createElement("aside", first.document);
    first.document.documentElement.append(firstUnrelated);
    first.provider.revealElement(firstUnrelated as unknown as Element);
    first.document.documentElement.remove(firstUnrelated);
    const firstRoot = first.provider.getRoot();
    const firstFrame = onlyChild(first.provider, firstRoot.node, 3, "first-frame");
    const firstDocument = onlyChild(first.provider, firstFrame, 3, "first-frame-document");
    const second = createFramedButtonTree({
      materialize: false,
      includeUnrelatedFrame: true,
    });
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);

    const restored = resolveLocator(second.provider, firstDocument.locator);

    expect(restored?.node.kind).toBe("frame-document");
    expect(restored?.node.nodeRef).not.toBe(firstDocument.nodeRef);
    expect(restored?.ancestorPath.map(({ kind }) => kind)).toEqual([
      "element",
      "element",
      "frame-document",
    ]);
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(2);
    expect(second.provider.frameAuthority.accessibleContexts().map(({ document }) => document))
      .not.toContain(second.unrelatedDocument as unknown as Document);
  });

  it("fails locator resolution for excluded, inaccessible, and cyclic current DOM", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const excluded = createHeadingTree();
    const excludedProvider = createProviderHarness(excluded.document, {
      isExcludedNode: (node) => node === excluded.target,
    }).provider;
    expect(resolveLocator(excludedProvider, locator)).toBeUndefined();

    const framed = createFramedButtonTree();
    const framedRoot = framed.provider.getRoot();
    const framedHost = onlyChild(framed.provider, framedRoot.node, 3, "framed-host");
    const framedDocument = onlyChild(framed.provider, framedHost, 3, "framed-document");
    const inaccessible = createFramedButtonTree({
      accessError: new Error("cross-origin"),
      materialize: false,
    });
    expect(resolveLocator(inaccessible.provider, framedDocument.locator)).toBeUndefined();

    const cyclic = createHeadingTree();
    cyclic.target.parentNode = cyclic.target;
    expect(resolveLocator(createProvider(cyclic.document), locator)).toBeUndefined();
  });

  it("fails closed for previous-sibling cycles and inaccessible evidence access", () => {
    const document = createHeadingTree();
    document.target.previousElementSibling = document.target;
    expect(() => locatorFor(document.provider, document.target)).toThrowError(
      "node-unavailable",
    );

    const hostile = createHeadingTree();
    Object.defineProperty(hostile.target, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile attributes");
      },
    });
    expect(() => locatorFor(hostile.provider, hostile.target)).toThrowError(
      "node-unavailable",
    );
  });

  it("fails closed during resolution for hostile evidence and child collections", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const classes = createHeadingTree();
    Object.defineProperty(classes.target, "classList", {
      configurable: true,
      get: () => ({ length: 257 }),
    });
    expect(resolveLocator(classes.provider, locator)).toBeUndefined();

    const attributes = createHeadingTree();
    Object.defineProperty(attributes.target, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile resolution attributes");
      },
    });
    expect(resolveLocator(attributes.provider, locator)).toBeUndefined();

    const children = createHeadingTree();
    Object.defineProperty(children.main, "childNodes", {
      configurable: true,
      get: () => ({ length: 65_537 }),
    });
    expect(resolveLocator(children.provider, locator)).toBeUndefined();
  });

  it("compares canonical top-eight evidence exactly while ignoring noncanonical additions", () => {
    const first = createHeadingTree({ includeAttributes: false });
    first.target.className = Array.from({ length: 10 }, (_, index) => `class-${index}`)
      .join(" ");
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.classes).toEqual([
      "class-0", "class-1", "class-2", "class-3",
      "class-4", "class-5", "class-6", "class-7",
    ]);

    const equivalent = createHeadingTree({ includeAttributes: false });
    equivalent.target.className = `${first.target.className} zzz`;
    expect(resolveLocator(equivalent.provider, locator)?.node.kind).toBe("element");

    const changed = createHeadingTree({ includeAttributes: false });
    changed.target.className = `aaa ${first.target.className}`;
    expect(resolveLocator(changed.provider, locator)).toBeUndefined();
  });

  it("counts excluded duplicate IDs and fails closed on unreadable uniqueness descendants", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const duplicate = createHeadingTree();
    const hiddenDuplicate = createElement("aside", duplicate.document);
    hiddenDuplicate.id = duplicate.target.id;
    duplicate.main.append(hiddenDuplicate);
    const excluded = createProviderHarness(duplicate.document, {
      isExcludedNode: (node) => node === hiddenDuplicate,
    }).provider;
    expect(resolveLocator(excluded, locator)).toBeUndefined();

    const unreadable = createHeadingTree();
    Object.defineProperty(unreadable.document.documentElement, "childNodes", {
      configurable: true,
      get: () => {
        throw new Error("hostile uniqueness descendants");
      },
    });
    expect(resolveLocator(unreadable.provider, locator)).toBeUndefined();
  });

  it("omits duplicate captured IDs while preserving structural locator recovery", () => {
    const first = createHeadingTree();
    const duplicate = createElement("h2", first.document);
    duplicate.id = first.target.id;
    duplicate.className = first.target.className;
    duplicate.setAttribute("data-section", "intro");
    duplicate.setAttribute("aria-label", "Introduction");
    duplicate.setAttribute("role", "presentation");
    first.main.append(duplicate);
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.id).toBeUndefined();

    const second = createHeadingTree();
    const secondDuplicate = createElement("h2", second.document);
    secondDuplicate.id = second.target.id;
    secondDuplicate.className = second.target.className;
    secondDuplicate.setAttribute("data-section", "intro");
    secondDuplicate.setAttribute("aria-label", "Introduction");
    secondDuplicate.setAttribute("role", "presentation");
    second.main.append(secondDuplicate);
    expect(resolveLocator(second.provider, locator)?.node.label)
      .toContain("h2#section_title_id1.block_title");
  });

  it("rolls back exact frame authorization when later locator proof fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    second.target.tagName = "P";

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(second.frame.loadListenerCount).toBe(0);
  });

  it("keeps pre-existing inaccessible frame authority when locator recovery fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({
      accessError: new Error("cross-origin"),
      materialize: false,
    });
    const root = second.provider.getRoot();
    onlyChild(second.provider, root.node, root.documentEpoch, "register-inaccessible-frame");

    expect(second.frame.loadListenerCount).toBe(1);
    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.frame.loadListenerCount).toBe(1);
  });

  it("rolls back recovery frame authority when provider path materialization fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    const provider = second.provider as unknown as {
      materializeLogicalPath(): undefined;
    };
    provider.materializeLogicalPath = () => undefined;

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(second.frame.loadListenerCount).toBe(0);
  });

  it("contains temporary locator frame lifecycle effects until resolution commits", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const provider = harness.provider as unknown as {
      frameTracking: boolean;
      materializeLogicalPath: (...args: readonly unknown[]) => unknown;
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    provider.frameTracking = true;
    const originalMaterialize = provider.materializeLogicalPath;
    provider.materializeLogicalPath = () => undefined;

    expect(resolveLocator(harness.provider, locator)).toBeUndefined();
    expect(events).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(provider.pendingFrameMutationScans).toHaveLength(0);
    expect(frame.loadListenerCount).toBe(0);

    provider.materializeLogicalPath = originalMaterialize;
    expect(resolveLocator(harness.provider, locator)?.node.label)
      .toContain("button#frame_target.action");
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(harness.pendingTimerCount()).toBe(1);
  });

  it("returns locator refs before a post-commit frame callback resets authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") provider?.resetDocument(createDocument() as unknown as Document, 4);
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    expect(harness.provider.currentDocumentEpoch).toBe(3);
    harness.flushEffects();
    expect(harness.provider.currentDocumentEpoch).toBe(4);
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("returns locator refs before a post-commit frame callback disposes authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") provider?.dispose();
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
    expect(frame.loadListenerCount).toBe(0);
  });

  it("returns locator refs before a post-commit frame callback navigates authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") {
          frame.setFrameDocument(createDocument());
          frame.dispatchLoad();
        }
      },
    });

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
  });

  it("publishes locator effects once for read-only callback reentry", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const events: string[] = [];
    let observedContexts = 0;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        events.push(event.type);
        observedContexts = provider?.frameAuthority.accessibleContexts().length ?? 0;
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)?.node.label).toContain("button#frame_target.action");
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(observedContexts).toBe(2);
  });

  it("returns a child page before a post-commit callback resets authority", () => {
    const document = createDocument();
    let armed = false;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (armed && event.type === "registered") {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    document.documentElement.append(createFrameElement(document, createDocument()));
    armed = true;

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "published-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(1);
    harness.flushEffects();
    expect(harness.provider.currentDocumentEpoch).toBe(4);
  });

  it("does not return an ancestor path after callback reentry resets authority", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let armed = false;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (armed && event.type === "navigated") {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "ancestor-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "ancestor-document");
    const targetView = onlyChild(harness.provider, frameDocument, root.documentEpoch, "ancestor-target");
    const state = harness.provider as unknown as {
      viewFrameDocument(document: Document, ...args: readonly unknown[]): unknown;
    };
    const originalViewFrameDocument = state.viewFrameDocument;
    let navigated = false;
    state.viewFrameDocument = (frameDocumentNode, ...args) => {
      const view = originalViewFrameDocument.call(state, frameDocumentNode, ...args);
      if (armed && !navigated) {
        navigated = true;
        frame.setFrameDocument(createDocument());
        frame.dispatchLoad();
      }
      return view;
    };
    armed = true;

    expect(() => harness.provider.ancestorPath(targetView.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
    expect(harness.provider.currentDocumentEpoch).toBe(3);
  });

  it.each([
    ["reset", (provider: DomTreeProvider, _frame: FakeFrameElement) => (
      provider.resetDocument(createDocument() as unknown as Document, 4)
    )],
    ["dispose", (provider: DomTreeProvider, _frame: FakeFrameElement) => provider.dispose()],
    ["navigate", (_provider: DomTreeProvider, frame: FakeFrameElement) => {
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
    }],
  ] as const)("stops ordered post-commit frame delivery after a callback %s authority", (_name, invalidate) => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    let provider: DomTreeProvider | undefined;
    let invalidated = false;
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        registered.push(event.frameRef);
        if (!invalidated) {
          invalidated = true;
          invalidate(provider!, frames[0]);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordered-frame-effects",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(3);
    harness.flushEffects();
    expect(registered).toHaveLength(1);
  });

  it("replays all ordered frame effects once for a read-only callback", () => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") registered.push(event.frameRef);
      },
    });
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    const response = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordered-frame-effects-read-only",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(response.nodes).toHaveLength(3);
    harness.flushEffects();
    expect(new Set(registered)).toHaveLength(3);
    expect(registered).toHaveLength(3);
  });

  it("returns a root before its first post-commit callback changes it", () => {
    const document = createDocument();
    const invalidations: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => {
        invalidations.push(branch.nodeRef);
        if (invalidations.length === 1) document.documentElement.className = "changed";
      },
    });
    const state = harness.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalViewElement = state.viewElement;
    state.viewElement = (element, ...args) => {
      const view = originalViewElement.call(state, element, ...args);
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      return view;
    };

    expect(harness.provider.getRoot().node.label).toBe("html");
    harness.flushEffects();
    expect(invalidations).toHaveLength(3);
  });

  it("returns children before their first post-commit callback replaces them", () => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        registered.push(event.frameRef);
        if (registered.length === 1) {
          document.documentElement.remove(frames[0]);
          document.documentElement.append(createFrameElement(document, createDocument()));
        }
      },
    });
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "published-child-dom-change",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(3);
    harness.flushEffects();
    expect(registered).toHaveLength(3);
  });

  it("returns an ancestor path before its first post-commit callback moves it", () => {
    const tree = createHeadingTree();
    const root = tree.provider.getRoot();
    const body = onlyChild(tree.provider, root.node, root.documentEpoch, "ancestor-live-body");
    const main = onlyChild(tree.provider, body, root.documentEpoch, "ancestor-live-main");
    const target = onlyChild(tree.provider, main, root.documentEpoch, "ancestor-live-target");
    let effects = 0;
    const state = tree.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
      onInvalidated: ((branch: { readonly nodeRef: string; readonly branchRevision: number }) => void) | undefined;
    };
    const originalViewElement = state.viewElement;
    state.onInvalidated = () => {
      effects += 1;
      if (effects === 1) {
        tree.main.remove(tree.target);
        tree.document.documentElement.append(tree.target);
      }
    };
    state.viewElement = (element, ...args) => {
      const view = originalViewElement.call(state, element, ...args);
      if (element === tree.target) {
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      }
      return view;
    };

    expect(tree.provider.ancestorPath(target.nodeRef, root.documentEpoch)).toHaveLength(4);
    flushPostCommitEffects(tree.provider);
    expect(effects).toBe(3);
  });

  it("returns a locator result before its post-commit callback changes it", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") target.className = "changed";
      },
    });

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
    expect(target.className).toBe("changed");
  });

  it("emits no lifecycle callback for a failed locator transaction", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const observedFrameRefs: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        observedFrameRefs.push(event.frameRef);
      },
    });
    const state = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly frameAuthority: { accessibleContexts(): readonly unknown[] };
      materializeLogicalPath: (...args: readonly unknown[]) => unknown;
    };
    const recordsBefore = state.records.size;
    const contextsBefore = state.frameAuthority.accessibleContexts().length;

    const materialize = state.materializeLogicalPath;
    state.materializeLogicalPath = () => undefined;
    expect(resolveLocator(harness.provider, locator)).toBeUndefined();
    expect(state.records.size).toBe(recordsBefore);
    expect(state.frameAuthority.accessibleContexts()).toHaveLength(contextsBefore);
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(observedFrameRefs).toEqual([]);
    expect((state as unknown as {
      readonly postCommitEffectBatches: readonly unknown[];
      readonly postCommitDeliveryScheduled: boolean;
    }).postCommitEffectBatches).toEqual([]);
    expect((state as unknown as {
      readonly postCommitDeliveryScheduled: boolean;
    }).postCommitDeliveryScheduled).toBe(false);

    state.materializeLogicalPath = materialize;
    expect(resolveLocator(harness.provider, locator)?.node.label).toContain("button#frame_target.action");
    expect(observedFrameRefs).toEqual([]);
    harness.flushEffects();
    expect(observedFrameRefs).toHaveLength(1);
  });

  it.each([
    ["reset", (provider: DomTreeProvider) => (
      provider.resetDocument(createDocument() as unknown as Document, 4)
    )],
    ["dispose", (provider: DomTreeProvider) => provider.dispose()],
  ] as const)("drops committed effects when %s occurs before their outbox delivery", (_name, invalidate) => {
    const document = createDocument();
    const invalidated: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch.nodeRef),
    });
    const state = harness.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const viewElement = state.viewElement;
    state.viewElement = (element, ...args) => {
      const view = viewElement.call(state, element, ...args);
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      return view;
    };

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(invalidated).toEqual([]);
    invalidate(harness.provider);
    harness.flushEffects();
    expect(invalidated).toEqual([]);
  });

  it("holds nested authority-operation effects for the owning operation's outbox", () => {
    const document = createDocument();
    const invalidated: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch.nodeRef),
    });
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): {
        publish(validate?: () => boolean): boolean;
        finalize(validate?: () => boolean): boolean;
      } | undefined;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const outer = state.beginProviderAuthorityOperation()!;
    const inner = state.beginProviderAuthorityOperation()!;
    state.emitInvalidated({ nodeRef: "nested", branchRevision: 1 });

    expect(inner.publish()).toBe(true);
    expect(inner.finalize()).toBe(true);
    expect(invalidated).toEqual([]);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    expect(invalidated).toEqual([]);
    harness.flushEffects();
    expect(invalidated).toEqual(["nested"]);
  });

  it("does not publish a failed nested frame effect reentered during an outer operation", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;

    expect(state.emitFrameLifecycle(frameLifecycleEvent("nested-frame"))).toBe(true);
    expect(nested.rollback()).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    expect(observed).toEqual([]);

    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("drops a nested frame journal opened by a hostile child getter", () => {
    const document = createDocument();
    const child = createElement("aside", document);
    document.documentElement.append(child);
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as AuthorityOperationInternals;
    let reentered = false;
    Object.defineProperty(child, "tagName", {
      configurable: true,
      get: () => {
        if (!reentered) {
          reentered = true;
          const nested = state.beginProviderAuthorityOperation()!;
          state.emitFrameLifecycle(frameLifecycleEvent("hostile-frame"));
          nested.rollback();
        }
        return "ASIDE";
      },
    });

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "hostile-nested-effect",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(1);
    expect(reentered).toBe(true);
    expect(observed).toEqual([]);
    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("keeps only committed nested journal slices in outer effect order", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("outer-before"))).toBe(true);
    const middle = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("middle"))).toBe(true);
    const rejected = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("rejected"))).toBe(true);
    expect(rejected.rollback()).toBe(true);
    expect(middle.publish()).toBe(true);
    expect(middle.finalize()).toBe(true);
    expect(state.emitFrameLifecycle(frameLifecycleEvent("outer-after"))).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);

    harness.flushEffects();
    expect(observed).toEqual(["outer-before", "middle", "outer-after"]);
  });

  it("truncates effects generated by nested rollback cleanup", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("nested"))).toBe(true);

    expect(nested.rollback(() => {
      state.emitFrameLifecycle(frameLifecycleEvent("cleanup"));
    })).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("reconciles retained frame navigation authority without publishing a failed owner journal", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "retained-frame");
    harness.flushEffects();
    events.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly frameDescriptions: ReadonlyMap<string, { readonly document?: Document }>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const replacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(replacement);
    frame.dispatchLoad();
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(replacement as unknown as Document);
    expect(state.frameDescriptions.get(frameView.nodeRef)?.document)
      .toBe(replacement as unknown as Document);
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual([]);
  });

  it("reconciles retained frame events in order while suppressing secondary callbacks", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const selected = createElement("button", firstDocument);
    firstDocument.documentElement.append(selected);
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    let selectedRef: string | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retained-frame-views",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    expect(frameViews).toHaveLength(2);
    const firstFrameView = frameViews[0]!;
    const secondFrameView = frameViews[1]!;
    const firstFrameDocument = onlyChild(
      harness.provider,
      firstFrameView,
      root.documentEpoch,
      "retained-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstFrameDocument,
      root.documentEpoch,
      "retained-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "retained-selected",
    ).nodeRef;
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      handleFrameLifecycle(event: FrameLifecycleEvent): boolean;
    };
    const contexts = harness.provider.frameAuthority.accessibleContexts();
    const firstContext = contexts.find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = contexts.find((candidate) => candidate.frameElement === secondFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;
    const reconciledFrames: string[] = [];
    const handleFrameLifecycle = state.handleFrameLifecycle;
    let reconciling = false;
    state.handleFrameLifecycle = (event) => {
      if (reconciling) reconciledFrames.push(event.frameRef);
      return handleFrameLifecycle.call(state, event);
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    secondFrame.setFrameDocument(secondReplacement);
    secondFrame.dispatchLoad();
    reconciling = true;
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(reconciledFrames).toEqual([firstContext.frameRef, secondContext.frameRef]);
    expect(secondFrameView.label).toBe("iframe");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains a frame navigation appended by timer cancellation after retained-event capture", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "drain-timer-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(harness.provider, frameViews[0]!, root.documentEpoch, "drain-timer-first");
    onlyChild(harness.provider, frameViews[1]!, root.documentEpoch, "drain-timer-second");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      mutationTimer: unknown;
      cancelTimeout(handle: unknown): void;
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const firstContext = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === secondFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;
    state.mutationTimer = 101;
    state.cancelTimeout = (handle) => {
      if (handle !== 101) return;
      secondFrame.setFrameDocument(secondReplacement);
      secondFrame.dispatchLoad();
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains chained retained frame events for nested rollback without publishing callbacks", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const selected = createElement("button", firstDocument);
    firstDocument.documentElement.append(selected);
    const secondDocument = createDocument();
    const thirdDocument = createDocument();
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    const thirdFrame = createFrameElement(document, thirdDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    document.documentElement.append(thirdFrame);
    let selectedRef: string | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "drain-nested-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "drain-nested-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstDocumentView,
      root.documentEpoch,
      "drain-nested-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "drain-nested-selected",
    ).nodeRef;
    onlyChild(harness.provider, frameViews[1]!, root.documentEpoch, "drain-nested-second");
    onlyChild(harness.provider, frameViews[2]!, root.documentEpoch, "drain-nested-third");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      mutationTimer: unknown;
      cancelTimeout(handle: unknown): void;
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const contexts = harness.provider.frameAuthority.accessibleContexts();
    const firstContext = contexts.find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = contexts.find((candidate) => candidate.frameElement === secondFrame)!;
    const thirdContext = contexts.find((candidate) => candidate.frameElement === thirdFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const thirdReplacement = createDocument();
    secondFrame.addEventListener("load", () => {
      thirdFrame.setFrameDocument(thirdReplacement);
      thirdFrame.dispatchLoad();
    });
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;
    state.mutationTimer = 202;
    state.cancelTimeout = (handle) => {
      if (handle !== 202) return;
      secondFrame.setFrameDocument(secondReplacement);
      secondFrame.dispatchLoad();
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    expect(nested.rollback()).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(thirdContext.frameRef)).toBe(thirdReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("fails closed when rollback frame reconciliation never reaches a fixed point", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "drain-endless-frame");
    onlyChild(harness.provider, frameView, root.documentEpoch, "drain-endless-document");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly nodeRegistry: { restore(snapshot: unknown): boolean };
    };
    const restore = state.nodeRegistry.restore;
    let navigations = 0;
    state.nodeRegistry.restore = (snapshot) => {
      const restored = restore.call(state.nodeRegistry, snapshot);
      navigations += 1;
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
      return restored;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    expect(owner.rollback()).toBe(false);
    expect(navigations).toBeGreaterThan(1);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains a nested frame navigation from observer installation during retained replay", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const replacement = createDocument();
    const latest = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const customObservers: TestMutationObserver[] = [];
    let armObserver = false;
    let reentered = false;
    let replacementObservations = 0;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const observe = observer.observe.bind(observer);
        observer.observe = (target, options) => {
          observe(target, options);
          if (target === replacement as unknown as Node) {
            replacementObservations += 1;
          }
          if (
            armObserver &&
            !reentered &&
            target === replacement as unknown as Node &&
            replacementObservations > 1
          ) {
            reentered = true;
            frame.setFrameDocument(latest);
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(replacement);
    frame.dispatchLoad();
    armObserver = true;

    expect(owner.rollback()).toBe(true);
    expect(reentered).toBe(true);
    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(latest as unknown as Document);
    expect(state.rootObservers.has(replacement as unknown as Node)).toBe(false);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      latest as unknown as Node,
    ]);
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(replacement)
    )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains chained observer reentries and removes every stale observer root", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const thirdDocument = createDocument();
    const fourthDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const customObservers: TestMutationObserver[] = [];
    let replaying = false;
    let secondDocumentObservations = 0;
    const replacements = new Map<Node, FakeDocument>([
      [secondDocument as unknown as Node, thirdDocument],
      [thirdDocument as unknown as Node, fourthDocument],
    ]);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const observe = observer.observe.bind(observer);
        observer.observe = (target, options) => {
          observe(target, options);
          if (target === secondDocument as unknown as Node) {
            secondDocumentObservations += 1;
          }
          const next = replacements.get(target);
          if (
            next &&
            replaying &&
            (target !== secondDocument as unknown as Node || secondDocumentObservations > 1)
          ) {
            replacements.delete(target);
            frame.setFrameDocument(next);
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(secondDocument);
    frame.dispatchLoad();
    replaying = true;

    expect(owner.rollback()).toBe(true);
    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(fourthDocument as unknown as Document);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      fourthDocument as unknown as Node,
    ]);
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(secondDocument) ||
      observer.observedTargets.includes(thirdDocument)
    )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("disconnects a superseded same-document observer before retained replay replaces it", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const initialObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    const supersededObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(supersededObserver).not.toBe(initialObserver);

    expect(owner.rollback()).toBe(true);
    const replayObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(replayObserver).not.toBe(initialObserver);
    expect(replayObserver).not.toBe(supersededObserver);
    expect(supersededObserver.disconnectCount).toBe(1);
    supersededObserver.emit([mutationRecord(frameDocument.documentElement)]);
    expect(supersededObserver.emitCount).toBe(0);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
    expect(customObservers).toContain(replayObserver);
  });

  it("drains a lifecycle event reentered from superseded observer disconnect", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    let reentered = false;
    let armDisconnect = false;
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const disconnect = observer.disconnect.bind(observer);
        observer.disconnect = () => {
          disconnect();
          if (
            armDisconnect &&
            !reentered &&
            observer.observedTargets.includes(frameDocument)
          ) {
            reentered = true;
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    const supersededObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    armDisconnect = true;

    expect(owner.rollback()).toBe(true);
    expect(reentered).toBe(true);
    expect(supersededObserver.disconnectCount).toBe(1);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      frameDocument as unknown as Node,
    ]);
    expect(customObservers).toContain(state.rootObservers.get(frameDocument as unknown as Node)!);
  });

  it("disconnects every superseded instance across repeated same-document loads", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    frame.dispatchLoad();

    expect(owner.rollback()).toBe(true);
    const currentObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(frameDocument) && observer !== currentObserver
    )).every((observer) => observer.disconnectCount > 0)).toBe(true);
  });

  it("rejects mutation records from a superseded observer instance", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const observers: TestMutationObserver[] = [];
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        observers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
      readonly pendingMutations: readonly unknown[];
    };
    const stale = state.rootObservers.get(frameDocument as unknown as Node)!;

    frame.dispatchLoad();
    expect(state.rootObservers.get(frameDocument as unknown as Node)).not.toBe(stale);

    stale.emitUnchecked([mutationRecord(frameDocument.documentElement)]);
    expect(state.pendingMutations).toHaveLength(0);
    expect(observers).toContain(stale);
  });

  it("stops frame callback fan-out after its first invalidation callback resets authority", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let provider: DomTreeProvider | undefined;
    let armed = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => {
        callbacks.push("invalidated");
        if (callbacks.length === 1) {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "fanout-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "fanout-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "fanout-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "fanout-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (armed) {
            armed = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    armed = true;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual(["invalidated"]);
  });

  it("replays frame callback fan-out once in deterministic order for read-only callbacks", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let armed = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "fanout-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "fanout-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "fanout-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "fanout-read-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (armed) {
            armed = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    armed = true;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([
      "invalidated",
      "invalidated",
      "selected-removed",
      "frame",
    ]);
  });

  it.each([
    ["reset", (provider: DomTreeProvider, _frame: FakeFrameElement) => {
      provider.resetDocument(createDocument() as unknown as Document, 4);
    }],
    ["dispose", (provider: DomTreeProvider, _frame: FakeFrameElement) => {
      provider.dispose();
    }],
    ["navigate", (_provider: DomTreeProvider, frame: FakeFrameElement) => {
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
    }],
  ] as const)("stops frame publication when the selected-ref reader %s authority", (_name, invalidate) => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let provider: DomTreeProvider | undefined;
    let triggerSelectionRead = false;
    let selectionRead = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        if (triggerSelectionRead && !selectionRead) {
          selectionRead = true;
          invalidate(provider!, frame);
        }
        return selectedRef;
      },
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "selection-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "selection-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "selection-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "selection-read-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    let triggerNavigation = false;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (triggerNavigation) {
            triggerNavigation = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    triggerSelectionRead = true;
    triggerNavigation = true;

    expect(() => harness.provider.getRoot()).toThrowError("node-unavailable");
    expect(selectionRead).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("keeps selected-ref reads read-only during frame publication", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let selectionReads = 0;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        selectionReads += 1;
        return selectedRef;
      },
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "selection-read-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "selection-read-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "selection-read-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "selection-read-read-target");
    selectedRef = targetView.nodeRef;
    selectionReads = 0;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    let triggerNavigation = true;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (triggerNavigation) {
            triggerNavigation = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(selectionReads).toBe(1);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([
      "invalidated",
      "invalidated",
      "selected-removed",
      "frame",
    ]);
  });

  it("drains a frame navigation triggered by a selected-ref reader during rollback", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const target = createElement("button", firstDocument);
    firstDocument.documentElement.append(target);
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    let selectedRef: string | undefined;
    let armSelectionRead = false;
    let secondReplacement: FakeDocument | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        if (armSelectionRead) {
          armSelectionRead = false;
          secondReplacement = createDocument();
          secondFrame.setFrameDocument(secondReplacement);
          secondFrame.dispatchLoad();
        }
        return selectedRef;
      },
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frames = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "selected-reader-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstDocumentView = onlyChild(
      harness.provider,
      frames[0]!,
      root.documentEpoch,
      "selected-reader-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstDocumentView,
      root.documentEpoch,
      "selected-reader-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "selected-reader-target",
    ).nodeRef;
    onlyChild(harness.provider, frames[1]!, root.documentEpoch, "selected-reader-second-document");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const secondContext = harness.provider.frameAuthority.accessibleContexts()
      .find((context) => context.frameElement === secondFrame)!;
    const owner = state.beginProviderAuthorityOperation()!;
    armSelectionRead = true;

    firstFrame.setFrameDocument(createDocument());
    firstFrame.dispatchLoad();

    expect(owner.rollback()).toBe(true);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it.each([
    ["detached", (document: FakeDocument, parent: FakeElement) => {
      (parent.parentNode as FakeElement).remove(parent);
    }],
    ["moved", (document: FakeDocument, parent: FakeElement) => {
      const body = parent.parentNode as FakeElement;
      body.remove(parent);
      document.documentElement.append(parent);
    }],
    ["replaced", (document: FakeDocument, parent: FakeElement) => {
      const body = parent.parentNode as FakeElement;
      body.remove(parent);
      body.append(createElement("main", document));
    }],
    ["given a child", (_document: FakeDocument, parent: FakeElement) => {
      parent.append(createElement("button", parent.ownerDocument));
    }],
  ] as const)("returns an empty page before its parent is %s by a post-commit callback", (_name, mutate) => {
    const document = createDocument();
    const body = createElement("body", document);
    const parent = createElement("main", document);
    body.append(parent);
    document.documentElement.append(body);
    let callbackCount = 0;
    const harness = createProviderHarness(document, {
      onInvalidated: () => {
        callbackCount += 1;
        mutate(document, parent);
      },
    });
    const root = harness.provider.getRoot();
    const bodyView = onlyChild(harness.provider, root.node, root.documentEpoch, "empty-page-body");
    const parentView = onlyChild(harness.provider, bodyView, root.documentEpoch, "empty-page-parent");
    const state = harness.provider as unknown as {
      logicalChildPage(node: Node, ...args: readonly unknown[]): unknown;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalLogicalChildPage = state.logicalChildPage;
    let injected = false;
    state.logicalChildPage = (node, ...args) => {
      const page = originalLogicalChildPage.call(state, node, ...args);
      if (!injected && node === parent) {
        injected = true;
        state.emitInvalidated({
          nodeRef: parentView.nodeRef,
          branchRevision: parentView.branchRevision,
        });
      }
      return page;
    };

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-page-live-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    }).nodes).toEqual([]);
    expect(callbackCount).toBe(0);
    harness.flushEffects();
    expect(callbackCount).toBe(1);
  });

  it("returns an empty page after a read-only callback", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const parent = createElement("main", document);
    body.append(parent);
    document.documentElement.append(body);
    let callbackCount = 0;
    const harness = createProviderHarness(document, {
      onInvalidated: () => { callbackCount += 1; },
    });
    const root = harness.provider.getRoot();
    const bodyView = onlyChild(harness.provider, root.node, root.documentEpoch, "empty-read-body");
    const parentView = onlyChild(harness.provider, bodyView, root.documentEpoch, "empty-read-parent");
    const state = harness.provider as unknown as {
      logicalChildPage(node: Node, ...args: readonly unknown[]): unknown;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalLogicalChildPage = state.logicalChildPage;
    let injected = false;
    state.logicalChildPage = (node, ...args) => {
      const page = originalLogicalChildPage.call(state, node, ...args);
      if (!injected && node === parent) {
        injected = true;
        state.emitInvalidated({
          nodeRef: parentView.nodeRef,
          branchRevision: parentView.branchRevision,
        });
      }
      return page;
    };

    const response = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-page-read-only",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(response.nodes).toEqual([]);
    expect(callbackCount).toBe(0);
    harness.flushEffects();
    expect(callbackCount).toBe(1);
  });

  it("fails capture when a registered frame host is moved or has the wrong parent owner", () => {
    const framed = createFramedButtonTree();
    const service = (framed.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    framed.document.documentElement.remove(framed.frame);

    expect(() => service.capture(framed.target as unknown as Node, "element"))
      .toThrow();

    framed.document.documentElement.append(framed.frame);
    (framed.frame as unknown as { ownerDocument: FakeDocument }).ownerDocument = createDocument();
    expect(() => service.capture(framed.target as unknown as Node, "element"))
      .toThrow();
  });

  it("rejects stable recovery through a frame whose live document changed before load", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    const root = second.provider.getRoot();
    onlyChild(second.provider, root.node, root.documentEpoch, "register-stale-frame");
    const context = second.provider.frameAuthority.accessibleContexts().at(-1)!;
    second.frame.setFrameDocument(createDocument());

    expect(second.provider.frameAuthority.getContext(context.frameRef)).toBeUndefined();
    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.frame.loadListenerCount).toBe(1);
  });

  it("rejects locator recovery when the final child frame read silently changes its parent", () => {
    const topDocument = createDocument();
    const parentDocument = createDocument();
    const childDocument = createDocument();
    const parentFrame = createFrameElement(topDocument, parentDocument);
    const childFrame = createFrameElement(parentDocument, childDocument);
    const target = createElement("button", childDocument);
    target.id = "nested_frame_target";
    childDocument.documentElement.append(target);
    parentDocument.documentElement.append(childFrame);
    topDocument.documentElement.append(parentFrame);

    const provider = createProvider(topDocument);
    const root = provider.getRoot();
    const parentFrameView = onlyChild(provider, root.node, root.documentEpoch, "parent-frame");
    const parentDocumentView = onlyChild(provider, parentFrameView, root.documentEpoch, "parent-document");
    const childFrameView = onlyChild(provider, parentDocumentView, root.documentEpoch, "child-frame");
    const childDocumentView = onlyChild(provider, childFrameView, root.documentEpoch, "child-document");
    const targetView = onlyChild(provider, childDocumentView, root.documentEpoch, "nested-target");
    const locator = targetView.locator;
    const stableChildDocument = childFrame.contentDocument;
    let reads = 0;

    Object.defineProperty(childFrame, "contentDocument", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 2) parentFrame.setFrameDocument(createDocument());
        return stableChildDocument;
      },
    });

    expect(resolveStableLocator(provider, locator)).toBeUndefined();
  });

  it("rejects capture when a sibling shortcut hides an excessive child collection", () => {
    const tree = createHeadingTree();
    tree.target.id = "";
    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => ({ 0: tree.target, length: 65_537 }),
    });

    expect(() => service.capture(tree.target as unknown as Node, "element")).toThrow();
  });

  it("rejects locator resolution when uniqueness scanning mutates verified evidence", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const children = second.target.childNodes;
    let mutated = false;
    Object.defineProperty(second.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!mutated) {
          mutated = true;
          second.target.className = "mutated";
        }
        return children;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("fails capture when a previous-element sibling read throws partway through the chain", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0] as FakeElement;
    Object.defineProperty(sibling, "previousElementSibling", {
      configurable: true,
      get: () => {
        throw new Error("hostile previous sibling");
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails capture when a verified child collection spoofs the same-length sibling position", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0]!;
    const originalChildren = tree.main.childNodes;
    let reads = 0;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? originalChildren : [tree.target, sibling];
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails recovery when a verified child collection reorders same-length siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0]!;
    const originalChildren = second.main.childNodes;
    let reads = 0;
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? originalChildren : [second.target, sibling];
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("fails capture when a final same-length child collection read reorders siblings", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0]!;
    const originalChildren = tree.main.childNodes;
    let afterPreviousSiblingReads = 0;
    Object.defineProperty(tree.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads = 0;
        return sibling;
      },
    });
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads += 1;
        return afterPreviousSiblingReads === 2 ? [tree.target, sibling] : originalChildren;
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails recovery when a final same-length child collection read reorders siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0]!;
    const originalChildren = second.main.childNodes;
    let afterPreviousSiblingReads = 0;
    Object.defineProperty(second.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads = 0;
        return sibling;
      },
    });
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads += 1;
        return afterPreviousSiblingReads === 2 ? [second.target, sibling] : originalChildren;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects capture when a formerly post-snapshot parent getter reorders same-length siblings", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0] as FakeElement;
    const children = tree.main.childNodes;
    let childReadsAfterPrevious = 0;
    let reordered = false;
    Object.defineProperty(tree.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious = 0;
        return sibling;
      },
    });
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return children;
      },
    });
    Object.defineProperty(tree.target, "parentNode", {
      configurable: true,
      get: () => {
        if (!reordered && childReadsAfterPrevious === 2) {
          reordered = true;
          tree.main.childNodes.splice(0, 2, tree.target, sibling);
          tree.target.previousElementSibling = null;
          sibling.previousElementSibling = tree.target;
        }
        return tree.main;
      },
    });

    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    expect(() => service.capture(tree.target as unknown as Node, "element")).toThrow("Invalid stable DOM locator");
    expect(reordered).toBe(true);
  });

  it("rejects recovery when a formerly post-snapshot parent getter reorders same-length siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0] as FakeElement;
    const children = second.main.childNodes;
    let childReadsAfterPrevious = 0;
    let reordered = false;
    Object.defineProperty(second.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious = 0;
        return sibling;
      },
    });
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return children;
      },
    });
    Object.defineProperty(second.target, "parentNode", {
      configurable: true,
      get: () => {
        if (!reordered && childReadsAfterPrevious === 2) {
          reordered = true;
          second.main.childNodes.splice(0, 2, second.target, sibling);
          second.target.previousElementSibling = null;
          sibling.previousElementSibling = second.target;
        }
        return second.main;
      },
    });

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
    expect(reordered).toBe(true);
  });

  it("does not read the capture root after the final path proof", () => {
    const tree = createHeadingTree();
    const html = tree.document.documentElement;
    let pathProofComplete = false;
    let mutated = false;
    Object.defineProperty(html, "previousElementSibling", {
      configurable: true,
      get: () => {
        pathProofComplete = true;
        return null;
      },
    });
    Object.defineProperty(tree.document, "nodeType", {
      configurable: true,
      get: () => {
        if (pathProofComplete && !mutated) {
          mutated = true;
          tree.main.remove(tree.target);
        }
        return 9;
      },
    });

    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    const locator = service.capture(tree.target as unknown as Node, "element");

    expect(mutated).toBe(false);
    Object.defineProperty(tree.document, "nodeType", {
      configurable: true,
      value: 9,
    });
    expect(resolveStableLocator(tree.provider, locator)).toBeDefined();
  });

  it("does not read the resolved target after the final segment proof", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const target = createElement("h2", document);
    target.id = "section_title_id1";
    target.className = "block_title";
    target.setAttribute("data-section", "intro");
    target.setAttribute("aria-label", "Introduction");
    target.setAttribute("role", "presentation");
    const sibling = createElement("p", document);
    document.documentElement.append(body);
    body.append(main);
    main.append(target);
    main.append(sibling);
    const provider = createProvider(document);
    let childReadsAfterPrevious = 0;
    let previousRead = false;
    let finalSnapshotComplete = false;
    let mutated = false;
    Object.defineProperty(target, "previousElementSibling", {
      configurable: true,
      get: () => {
        previousRead = true;
        childReadsAfterPrevious = 0;
        return null;
      },
    });
    Object.defineProperty(main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return [target, sibling];
      },
    });
    Object.defineProperty(sibling, "nodeType", {
      configurable: true,
      get: () => {
        if (previousRead && childReadsAfterPrevious === 2) finalSnapshotComplete = true;
        return 1;
      },
    });
    Object.defineProperty(target, "nodeType", {
      configurable: true,
      get: () => {
        if (finalSnapshotComplete && !mutated) {
          mutated = true;
          target.className = "mutated-after-proof";
        }
        return 1;
      },
    });

    expect(resolveStableLocator(provider, locator)).toBeUndefined();
    expect(mutated).toBe(true);
  });

  it("omits a capture ID when a second bounded scan finds a late duplicate", () => {
    const tree = createHeadingTree();
    const earlier = createElement("aside", tree.document);
    tree.document.documentElement.remove(tree.document.documentElement.childNodes[0]!);
    tree.document.documentElement.append(earlier);
    tree.document.documentElement.append(tree.main.parentNode as FakeNode);
    const originalChildren = tree.target.childNodes;
    let inserted = false;
    Object.defineProperty(tree.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!inserted) {
          inserted = true;
          const duplicate = createElement("aside", tree.document);
          duplicate.id = tree.target.id;
          earlier.append(duplicate);
        }
        return originalChildren;
      },
    });

    expect(locatorFor(tree.provider, tree.target).path.at(-1)?.id).toBeUndefined();
  });

  it("omits an ID when final evidence adds an excluded duplicate", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const target = createElement("h2", document);
    target.id = "stable_target";
    target.className = "title";
    document.documentElement.append(body);
    body.append(main);
    main.append(target);
    let duplicate: FakeElement | undefined;
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => node === duplicate,
    });
    const classes = target.classList;
    let reads = 0;
    Object.defineProperty(target, "classList", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 3) {
          duplicate = createElement("aside", document);
          duplicate.id = target.id;
          document.documentElement.append(duplicate);
        }
        return classes;
      },
    });

    expect(locatorFor(harness.provider, target).path.at(-1)?.id).toBeUndefined();
  });

  it("rejects resolution when final evidence adds an excluded duplicate", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    let duplicate: FakeElement | undefined;
    const harness = createProviderHarness(second.document, {
      isExcludedNode: (node) => node === duplicate,
    });
    const classes = second.target.classList;
    let reads = 0;
    Object.defineProperty(second.target, "classList", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 3) {
          duplicate = createElement("aside", second.document);
          duplicate.id = second.target.id;
          second.document.documentElement.append(duplicate);
        }
        return classes;
      },
    });

    expect(resolveStableLocator(harness.provider, locator)).toBeUndefined();
  });

  it("fails capture when uniqueness traversal mutates candidate evidence", () => {
    const tree = createHeadingTree();
    const children = tree.target.childNodes;
    let mutated = false;
    Object.defineProperty(tree.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!mutated) {
          mutated = true;
          tree.target.className = "mutated";
        }
        return children;
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails locator resolution when a second uniqueness scan finds a late duplicate", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const originalChildren = second.target.childNodes;
    let inserted = false;
    Object.defineProperty(second.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!inserted) {
          inserted = true;
          const duplicate = createElement("aside", second.document);
          duplicate.id = second.target.id;
          second.main.append(duplicate);
        }
        return originalChildren;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("preflights every child locator before durable page materialization", () => {
    const document = createDocument();
    const first = createElement("article", document);
    const second = createElement("aside", document);
    document.documentElement.append(first);
    document.documentElement.append(second);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const providerState = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    const recordCount = providerState.records.size;
    const referenceCount = providerState.nodeRegistry.size;
    const originalAttributes = second.attributes;
    Object.defineProperty(second, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("late hostile child locator");
      },
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "atomic-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    expect(providerState.records.size).toBe(recordCount);
    expect(providerState.nodeRegistry.size).toBe(referenceCount);
    expect(harness.observers).toHaveLength(1);
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(1);

    Object.defineProperty(second, "attributes", {
      configurable: true,
      value: originalAttributes,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "recovered-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["article", "aside"]);
  });

  it("rolls back expansion authority when child locator capture fails", () => {
    const document = createDocument();
    const child = createElement("article", document);
    document.documentElement.append(child);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      readonly expandedBranches: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
    };
    const originalAttributes = child.attributes;
    Object.defineProperty(child, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile first expansion locator");
      },
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    expect(provider.expandedBranches.has(root.node.nodeRef)).toBe(false);
    expect(provider.nodeRegistry.retentionReasons(root.node.nodeRef)).toEqual([]);
    expect(harness.observers).toHaveLength(1);

    Object.defineProperty(child, "attributes", {
      configurable: true,
      value: originalAttributes,
    });
    expect(onlyChild(harness.provider, root.node, root.documentEpoch, "retried-first-expansion").label)
      .toBe("article");
  });

  it("restores an unaliased expanded branch after shadow discovery fails", () => {
    const document = createDocument();
    const host = createElement("article", document);
    for (let index = 0; index < 51; index += 1) {
      host.append(createElement("span", document));
    }
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(harness.provider, root.node, root.documentEpoch, "branch-host");
    const initialPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    const cursor = initialPage.nextCursor!;
    const shadow = host.attachShadow();
    const provider = harness.provider as unknown as {
      readonly expandedBranches: ReadonlyMap<string, { revision: number }>;
      readonly cursors: ReadonlyMap<string, { readonly branchRevision: number; readonly active: boolean }>;
    };
    const before = provider.expandedBranches.get(hostView.nodeRef)!;
    const beforeCursor = provider.cursors.get(cursor)!;
    let exposeShadow = true;
    Object.defineProperty(host, "shadowRoot", {
      configurable: true,
      get: () => exposeShadow ? shadow : null,
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-shadow-discovery",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    })).toThrowError("stale-branch");
    const restored = provider.expandedBranches.get(hostView.nodeRef)!;
    expect(restored).not.toBe(before);
    expect(restored.revision).toBe(hostView.branchRevision);
    expect(provider.cursors.get(cursor)).toEqual(beforeCursor);

    exposeShadow = false;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retried-shadow-discovery",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    }).nodes).toHaveLength(50);
  });

  it("rolls back ancestor-path materialization before a late view failure", () => {
    const tree = createHeadingTree();
    const revealed = tree.provider.revealElement(tree.target as unknown as Element);
    const documentEpoch = tree.provider.getRoot().documentEpoch;
    const provider = tree.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    const records = [...provider.records.entries()];
    const referenceCount = provider.nodeRegistry.size;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === tree.main.parentNode) throw new Error("late ancestor view failure");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => tree.provider.ancestorPath(revealed.nodeRef, documentEpoch))
      .toThrowError("late ancestor view failure");
    expect([...provider.records.entries()]).toEqual(records);
    expect(provider.nodeRegistry.size).toBe(referenceCount);

    provider.viewElement = originalViewElement;
    expect(tree.provider.ancestorPath(revealed.nodeRef, documentEpoch)
      .map(({ label }) => label)).toEqual(["html", "body", "main", "h2#section_title_id1.block_title [data-section] [aria-label] [role]"]);
  });

  it("buffers invalidation callbacks until a child page commits", () => {
    const document = createDocument();
    const host = createElement("article", document);
    document.documentElement.append(host);
    const invalidated: Array<{ readonly nodeRef: string; readonly branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(harness.provider, root.node, root.documentEpoch, "callback-host");
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-callback-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    host.attachShadow();
    const provider = harness.provider as unknown as {
      viewShadowRoot(root: ShadowRoot, ...args: readonly unknown[]): unknown;
    };
    const originalViewShadowRoot = provider.viewShadowRoot;
    provider.viewShadowRoot = () => {
      throw new Error("late invalidation view failure");
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-callback-page",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    })).toThrowError("late invalidation view failure");
    expect(invalidated).toEqual([]);

    provider.viewShadowRoot = originalViewShadowRoot;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "committed-callback-page",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    });
    expect(invalidated).toEqual([]);
    harness.flushEffects();
    expect(invalidated).toEqual([{
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    }]);
  });

  it("rolls back earlier child views when a later materialization throws", () => {
    const document = createDocument();
    const first = createElement("article", document);
    const second = createElement("aside", document);
    document.documentElement.append(first);
    document.documentElement.append(second);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    const recordCount = provider.records.size;
    const referenceCount = provider.nodeRegistry.size;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === second) throw new Error("late child view failure");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "late-child-view-failure",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("late child view failure");
    expect(provider.records.size).toBe(recordCount);
    expect(provider.nodeRegistry.size).toBe(referenceCount);
    expect(harness.observers).toHaveLength(1);

    provider.viewElement = originalViewElement;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retried-late-child-view",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["article", "aside"]);
  });

  it("buffers frame lifecycle work until an entire child page commits", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    const second = createElement("aside", document);
    document.documentElement.append(frame);
    document.documentElement.append(second);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      frameTracking: boolean;
      readonly pendingFrameMutationScans: readonly unknown[];
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    provider.frameTracking = true;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === second) throw new Error("late hostile child view");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "buffered-frame-failure",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("late hostile child view");
    expect(events).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(provider.pendingFrameMutationScans).toHaveLength(0);
    expect(frame.loadListenerCount).toBe(0);

    provider.viewElement = originalViewElement;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "buffered-frame-success",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["iframe", "aside"]);
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(harness.pendingTimerCount()).toBe(2);
    expect(provider.pendingFrameMutationScans).toHaveLength(1);
  });

  it("releases transient path retentions before replaying frame lifecycle callbacks", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    document.documentElement.append(frame);
    let observedReasons: readonly string[] | undefined;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered" || !provider) return;
        const registry = provider as unknown as {
          readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
        };
        observedReasons = registry.nodeRegistry.retentionReasons("node-1");
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, { readonly scope: unknown }>;
      readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
      materializeLogicalPath(path: readonly unknown[]): readonly { readonly nodeRef: string }[] | undefined;
    };
    const scope = state.records.get(root.node.nodeRef)!.scope;

    const path = state.materializeLogicalPath([
      { kind: "element", node: document.documentElement, scope },
      { kind: "element", node: frame, scope },
    ]);

    expect(path?.map(({ nodeRef }) => nodeRef)).toEqual([root.node.nodeRef, "node-2"]);
    expect(observedReasons).toBeUndefined();
    harness.flushEffects();
    expect(observedReasons).toEqual([]);
    expect(state.nodeRegistry.retentionReasons(root.node.nodeRef)).toEqual([]);
  });

  it("restores evicted records when path materialization fails after reserving capacity", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const aside = createElement("aside", document);
    body.append(main);
    document.documentElement.append(body);
    document.documentElement.append(aside);
    const harness = createProviderHarness(document, { maxRecords: 3 });
    const root = harness.provider.getRoot();
    const rootChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "capacity-root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const bodyView = rootChildren.find(({ label }) => label === "body")!;
    const asideView = rootChildren.find(({ label }) => label === "aside")!;
    const provider = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, { readonly scope: unknown }>;
      materializeLogicalPath(path: readonly unknown[]): readonly unknown[] | undefined;
      materializePathEntry(entry: { readonly node: Node }): unknown;
    };
    const originalRefs = [...provider.records.keys()];
    const scope = provider.records.get(root.node.nodeRef)!.scope;
    const originalMaterialize = provider.materializePathEntry;
    provider.materializePathEntry = (entry) => {
      if (entry.node === main) throw new Error("forced post-reservation failure");
      return originalMaterialize.call(provider, entry);
    };

    expect(provider.materializeLogicalPath([
      { kind: "element", node: document.documentElement, scope },
      { kind: "element", node: body, scope },
      { kind: "element", node: main, scope },
    ])).toBeUndefined();
    expect([...provider.records.keys()]).toEqual(originalRefs);
    expect(harness.provider.resolveElement(asideView.nodeRef, root.documentEpoch))
      .toBeDefined();
    expect(harness.provider.resolveElement(bodyView.nodeRef, root.documentEpoch))
      .toBeDefined();
  });

  it("does not materialize references, observers, or frame ownership before capture succeeds", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const originalAttributes = frame.attributes;
    Object.defineProperty(frame, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile frame identity");
      },
    });

    expect(() => onlyChild(harness.provider, root.node, root.documentEpoch, "hostile-frame"))
      .toThrowError("node-unavailable");
    expect((harness.provider as unknown as { records: Map<string, unknown> }).records.size)
      .toBe(1);
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(frame.loadListenerCount).toBe(0);

    Object.defineProperty(frame, "attributes", {
      configurable: true,
      value: originalAttributes,
    });
    expect(onlyChild(harness.provider, root.node, root.documentEpoch, "recovered-frame").kind)
      .toBe("element");
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(2);
  });

  it.each([
    ["mutationTimer", "reset"],
    ["frameMutationScanTimer", "dispose"],
    ["shadowScanTimer", "reset"],
  ] as const)("abandons rollback when canceling %s reenters through %s", (timerField, action) => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const currentHandle = 101;
    const replacementHandle = 202;
    let reentered = false;
    internals[timerField] = currentHandle;
    internals.cancelTimeout = () => {
      if (reentered) return;
      reentered = true;
      if (action === "reset") {
        provider.resetDocument(replacement as unknown as Document, 4);
      } else {
        provider.dispose();
      }
      internals[timerField] = replacementHandle;
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(internals[timerField]).toBe(replacementHandle);
    expect(reentered).toBe(true);
  });

  it("abandons timer rollback when cancellation throws after replacing state", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    internals.mutationTimer = 101;
    internals.cancelTimeout = () => {
      internals.mutationTimer = 202;
      throw new Error("hostile timer cancellation");
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(internals.mutationTimer).toBe(202);
  });

  it("does not cancel later timer replacements from mutation-timer cancellation", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const originalFrameTimer = { timer: "frame" };
    const originalShadowTimer = { timer: "shadow" };
    const replacementFrameTimer = { timer: "frame" };
    const replacementShadowTimer = { timer: "shadow" };
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = originalFrameTimer;
    internals.shadowScanTimer = originalShadowTimer;
    internals.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) {
        internals.frameMutationScanTimer = replacementFrameTimer;
        internals.shadowScanTimer = replacementShadowTimer;
      }
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBe(replacementFrameTimer);
    expect(internals.shadowScanTimer).toBe(replacementShadowTimer);
  });

  it("abandons timer rollback when the first cancellation clears a later timer", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = 102;
    internals.shadowScanTimer = 103;
    internals.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) internals.frameMutationScanTimer = undefined;
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBeUndefined();
    expect(internals.shadowScanTimer).toBe(103);
  });

  it("abandons provider rollback after an observer disconnect resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const extraRoot = createElement("aside", document);
    internals.rootObservers.set(extraRoot as unknown as Node, {
      disconnect: () => provider.resetDocument(replacement as unknown as Document, 4),
    });

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
    expect(internals.rootObservers.has(document as unknown as Node)).toBe(false);
    expect(internals.rootObservers.has(replacement as unknown as Node)).toBe(true);
  });

  it("abandons provider rollback after frame unregistration resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    let reentered = false;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "removed" || reentered || !provider) return;
        reentered = true;
        provider.resetDocument(replacement as unknown as Document, 4);
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();

    onlyChild(provider, root.node, root.documentEpoch, "operation-frame");

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
    expect(reentered).toBe(true);
  });

  it("abandons provider rollback after registry restoration resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    internals.nodeRegistry.restore = () => {
      provider.resetDocument(replacement as unknown as Document, 4);
      return true;
    };

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
  });

  it("cleans the three entry timer handles exactly once", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = 102;
    internals.shadowScanTimer = 103;
    internals.cancelTimeout = (handle) => cancelled.push(handle);

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(true);
    expect(cancelled).toEqual([101, 102, 103]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBeUndefined();
    expect(internals.shadowScanTimer).toBeUndefined();
  });

  it("preserves reentrant reset timer ownership while canceling scheduled work", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const state = provider as unknown as ProviderRollbackInternals & {
      cancelScheduledWork(): void;
    };
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    let reentered = false;
    state.cancelTimeout = (handle) => {
      if (handle !== 101 || reentered) return;
      reentered = true;
      provider.resetDocument(replacement as unknown as Document, 4);
      state.mutationTimer = 201;
      state.frameMutationScanTimer = 202;
      state.shadowScanTimer = 203;
    };

    expect(() => state.cancelScheduledWork()).not.toThrow();
    expect(state.mutationTimer).toBe(201);
    expect(state.frameMutationScanTimer).toBe(202);
    expect(state.shadowScanTimer).toBe(203);
  });

  it("continues scheduled-work cancellation after a hostile timer throws", () => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & {
      cancelScheduledWork(): void;
    };
    const cancelled: unknown[] = [];
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    state.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) throw new Error("hostile cancellation");
    };

    expect(() => state.cancelScheduledWork()).not.toThrow();
    expect(cancelled).toEqual([101, 103, 102]);
    expect(state.mutationTimer).toBeUndefined();
    expect(state.frameMutationScanTimer).toBeUndefined();
    expect(state.shadowScanTimer).toBeUndefined();
  });

  it("continues rollback timer cancellation after a hostile timer throws", () => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = state.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    state.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) throw new Error("hostile rollback cancellation");
    };

    expect(state.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101, 102, 103]);
    expect(state.mutationTimer).toBeUndefined();
    expect(state.frameMutationScanTimer).toBeUndefined();
    expect(state.shadowScanTimer).toBeUndefined();
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("clears the %s timer before hostile cancellation", (_path, timer, cancel) => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    let observed: unknown;
    state.cancelTimeout = () => {
      observed = state[timer];
      throw new Error("hostile cancellation");
    };

    expect(() => cancel(state)).not.toThrow();
    expect(observed).toBeUndefined();
    expect(state[timer]).toBeUndefined();
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("preserves a reentrant %s timer replacement", (_path, timer, cancel) => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    state.cancelTimeout = () => {
      state[timer] = 202;
    };

    cancel(state);
    expect(state[timer]).toBe(202);
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("preserves a reentrant reset replacement from the %s timer", (_path, timer, cancel) => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    state.cancelTimeout = () => {
      harness.provider.resetDocument(replacement as unknown as Document, 4);
      state[timer] = 202;
    };

    cancel(state);
    expect(state.topDocument).toBe(replacement as unknown as Document);
    expect(state[timer]).toBe(202);
  });

  it("does not invoke an outward callback after publication authority is already stale", () => {
    const provider = createProvider(createDocument());
    const state = provider as unknown as {
      activePublicationGuard: (() => boolean) | undefined;
      invokeOutwardCallback(callback: () => void): boolean;
    };
    let callbacks = 0;
    state.activePublicationGuard = () => false;

    expect(state.invokeOutwardCallback(() => { callbacks += 1; })).toBe(false);
    expect(callbacks).toBe(0);
  });

  it("does not read selected state after publication authority is already stale", () => {
    let reads = 0;
    const harness = createProviderHarness(createDocument(), {
      getSelectedNodeRef: () => {
        reads += 1;
        return "selected-ref";
      },
    });
    const state = harness.provider as unknown as {
      activePublicationGuard: (() => boolean) | undefined;
      readSelectedNodeRef(): { readonly valid: boolean; readonly nodeRef?: string };
    };
    state.activePublicationGuard = () => false;

    expect(state.readSelectedNodeRef()).toEqual({ valid: false });
    expect(reads).toBe(0);
  });

  it("never reuses a tentative cursor after provider authority restoration", () => {
    const harness = createProviderHarness(createDocument());
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as {
      snapshotProviderAuthority(): unknown;
      restoreProviderAuthority(snapshot: unknown): boolean;
      createCursor(record: {
        readonly nodeRef: string;
        readonly documentEpoch: number;
        readonly branchRevision: number;
        readonly offset: number;
        readonly physicalOffset: number;
      }): string;
    };
    const snapshot = state.snapshotProviderAuthority();
    const cursorRecord = {
      nodeRef: root.node.nodeRef,
      documentEpoch: root.documentEpoch,
      branchRevision: root.node.branchRevision,
      offset: 1,
      physicalOffset: 1,
    };
    const tentative = state.createCursor(cursorRecord);

    expect(state.restoreProviderAuthority(snapshot)).toBe(true);
    expect(state.createCursor(cursorRecord)).not.toBe(tentative);
  });
});

interface ProviderRollbackInternals {
  topDocument: Document | undefined;
  mutationTimer: unknown;
  frameMutationScanTimer: unknown;
  shadowScanTimer: unknown;
  cancelTimeout: (handle: unknown) => void;
  rootObservers: Map<Node, { disconnect(): void }>;
  nodeRegistry: { restore(snapshot: unknown): boolean };
  snapshotProviderAuthority(): unknown;
  restoreSnapshotTimers(snapshot: unknown): boolean;
  restoreProviderAuthority(snapshot: unknown): boolean;
}

interface ProviderTimerCancellationInternals {
  flushMutationBarrier(): void;
  pruneCollapsedFrameMutationScans(collapsedNode: Node | undefined): void;
  stopShadowScanIfIdle(): void;
}

interface AuthorityOperationInternals {
  beginProviderAuthorityOperation(): {
    publish(validate?: () => boolean): boolean;
    finalize(validate?: () => boolean): boolean;
    rollback(cleanup?: () => void): boolean;
  } | undefined;
  emitFrameLifecycle(event: FrameLifecycleEvent): boolean;
}

function frameLifecycleEvent(frameRef: string): FrameLifecycleEvent {
  return Object.freeze({
    type: "registered" as const,
    frameRef,
    frameEpoch: 1,
    documentEpoch: 3,
    parentFrameRef: "top",
    accessible: true,
  });
}

function onlyChild(
  provider: DomTreeProvider,
  parent: { readonly nodeRef: string; readonly branchRevision: number },
  documentEpoch: number,
  requestId: string,
) {
  const children = provider.getChildren({
    type: "dom.getChildren",
    requestId,
    documentEpoch,
    nodeRef: parent.nodeRef,
    branchRevision: parent.branchRevision,
  }).nodes;
  expect(children).toHaveLength(1);
  return children[0]!;
}

function createProvider(document: FakeDocument): DomTreeProvider {
  return createProviderHarness(document).provider;
}

function resolveLocator(
  provider: DomTreeProvider,
  locator: DomStableLocator,
): { readonly node: { readonly nodeRef: string; readonly label: string }; readonly ancestorPath: readonly { readonly label: string }[] } | undefined {
  return (provider as unknown as {
    resolveLocator(locator: DomStableLocator): { readonly node: { readonly nodeRef: string; readonly label: string }; readonly ancestorPath: readonly { readonly label: string }[] } | undefined;
  }).resolveLocator(locator);
}

function resolveStableLocator(
  provider: DomTreeProvider,
  locator: DomStableLocator,
): unknown {
  return (provider as unknown as {
    readonly locatorService: { resolve(locator: DomStableLocator): unknown };
  }).locatorService.resolve(locator);
}

function flushPostCommitEffects(provider: DomTreeProvider): void {
  (provider as unknown as { flushPostCommitEffects(): void }).flushPostCommitEffects();
}

function locatorFor(provider: DomTreeProvider, target: FakeElement): DomStableLocator {
  return provider.revealElement(target as unknown as Element).ancestorPath.at(-1)!.locator;
}

function createHeadingTree(options: {
  readonly tagName?: string;
  readonly className?: string;
  readonly includeSibling?: boolean;
  readonly includeAttributes?: boolean;
  readonly attribute?: { readonly name: string; readonly value: string };
} = {}) {
  const document = createDocument();
  const body = createElement("body", document);
  const main = createElement("main", document);
  const target = createElement(options.tagName ?? "h2", document);
  target.id = "section_title_id1";
  target.className = options.className ?? "block_title";
  if (options.includeAttributes !== false) {
    target.setAttribute("data-section", "intro");
    target.setAttribute("aria-label", "Introduction");
    target.setAttribute("role", "presentation");
  }
  if (options.attribute) target.setAttribute(options.attribute.name, options.attribute.value);
  document.documentElement.append(body);
  body.append(main);
  if (options.includeSibling) main.append(createElement("p", document));
  main.append(target);
  return { document, main, target, provider: createProvider(document) };
}

function createNestedShadowTree(options: { readonly attachInnerShadow?: boolean } = {}) {
  const document = createDocument();
  const outer = createElement("article", document);
  outer.id = "outer_host";
  const outerShadow = outer.attachShadow();
  const inner = createElement("section", document);
  inner.id = "inner_host";
  outerShadow.append(inner);
  const target = createElement("button", document);
  target.id = "shadow_target";
  target.className = "action";
  if (options.attachInnerShadow !== false) {
    inner.attachShadow().append(target);
  } else {
    inner.append(target);
  }
  document.documentElement.append(outer);
  return { document, provider: createProvider(document), target };
}

function createFramedButtonTree(options: {
  readonly accessError?: Error;
  readonly materialize?: boolean;
  readonly includeUnrelatedFrame?: boolean;
} = {}) {
  const document = createDocument();
  const childDocument = createDocument();
  const frame = createFrameElement(document, childDocument, options.accessError);
  const target = createElement("button", childDocument);
  target.id = "frame_target";
  target.className = "action";
  childDocument.documentElement.append(target);
  document.documentElement.append(frame);
  const unrelatedDocument = options.includeUnrelatedFrame ? createDocument() : undefined;
  if (unrelatedDocument) {
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
  }
  const provider = createProvider(document);
  if (options.materialize !== false) {
    const root = provider.getRoot();
    const frameView = onlyChild(provider, root.node, root.documentEpoch, "frame");
    if (!options.accessError) {
      onlyChild(provider, frameView, root.documentEpoch, "frame-document");
    }
  }
  return { document, provider, target, frame, unrelatedDocument };
}

interface ProviderHarnessOptions {
  readonly documentEpoch?: number;
  readonly createMutationObserver?: (
    callback: (records: readonly MutationRecord[]) => void,
  ) => TestMutationObserver;
  readonly onInvalidated?: (branch: {
    readonly nodeRef: string;
    readonly branchRevision: number;
  }) => void;
  readonly getSelectedNodeRef?: () => string | undefined;
  readonly onSelectedNodeRemoved?: (event: {
    readonly nodeRef: string;
    readonly documentEpoch: number;
  }) => void;
  readonly onFrameLifecycle?: (event: {
    readonly type: string;
    readonly frameRef: string;
    readonly frameEpoch: number;
    readonly documentEpoch: number;
  }) => void;
  readonly onMutationSettled?: () => void;
  readonly maxCursors?: number;
  readonly maxRecords?: number;
  readonly isExcludedNode?: (node: Node) => boolean;
}

function createProviderHarness(
  document: FakeDocument,
  options: ProviderHarnessOptions = {},
): {
  readonly provider: DomTreeProvider;
  readonly observers: TestMutationObserver[];
  readonly flushTimers: () => void;
  readonly flushEffects: () => void;
  readonly pendingTimerCount: () => number;
} {
  const observers: TestMutationObserver[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const providerOptions = {
    documentEpoch: options.documentEpoch ?? 3,
    createMutationObserver: (callback) => {
      const observer = options.createMutationObserver?.(callback) ??
        new TestMutationObserver(callback);
      observers.push(observer);
      return observer;
    },
    setTimeout: (callback) => {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    onInvalidated: options.onInvalidated,
    getSelectedNodeRef: options.getSelectedNodeRef,
    onSelectedNodeRemoved: options.onSelectedNodeRemoved,
    onFrameLifecycle: options.onFrameLifecycle,
    onMutationSettled: options.onMutationSettled,
    isExcludedNode: options.isExcludedNode,
    maxCursors: options.maxCursors,
    maxRecords: options.maxRecords,
  };
  const provider = new DomTreeProvider(
    document as unknown as Document,
    providerOptions,
  );
  return {
    provider,
    observers,
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    flushEffects: () => {
      (provider as unknown as { flushPostCommitEffects(): void }).flushPostCommitEffects();
    },
    pendingTimerCount: () => timers.size,
  };
}

class TestMutationObserver {
  private records: MutationRecord[] = [];
  public readonly observedTargets: FakeNode[] = [];
  public disconnectCount = 0;
  public emitCount = 0;

  public constructor(
    private readonly callback: (records: readonly MutationRecord[]) => void,
  ) {}

  public observe(target: Node, _options: MutationObserverInit): void {
    this.observedTargets.push(target as unknown as FakeNode);
  }

  public disconnect(): void {
    this.disconnectCount += 1;
    this.records = [];
  }

  public takeRecords(): readonly MutationRecord[] {
    const records = this.records;
    this.records = [];
    return records;
  }

  public emit(records: readonly MutationRecord[]): void {
    if (this.disconnectCount > 0) return;
    this.emitCount += 1;
    this.callback(records);
  }

  public emitUnchecked(records: readonly MutationRecord[]): void {
    this.callback(records);
  }
}

function mutationRecord(
  target: FakeNode,
  addedNodes: readonly FakeNode[] = [],
  removedNodes: readonly FakeNode[] = [],
): MutationRecord {
  return {
    type: "childList",
    target,
    addedNodes,
    removedNodes,
  } as unknown as MutationRecord;
}

function attributeMutationRecord(
  target: FakeElement,
  attributeName: string,
): MutationRecord {
  return {
    type: "attributes",
    target,
    attributeName,
  } as unknown as MutationRecord;
}

class FakeNode {
  public parentNode: FakeNode | null = null;
  public readonly childNodes: FakeNode[] = [];
  public previousElementSibling: FakeElement | null = null;

  public constructor(public readonly nodeType: number) {}

  public append(child: FakeNode): void {
    child.parentNode = this;
    child.previousElementSibling = this.lastElementChild();
    this.childNodes.push(child);
  }

  public remove(child: FakeNode): void {
    const index = this.childNodes.indexOf(child);
    if (index < 0) return;
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    child.previousElementSibling = null;
    for (let childIndex = index; childIndex < this.childNodes.length; childIndex += 1) {
      const current = this.childNodes[childIndex]!;
      current.previousElementSibling = this.lastElementBefore(childIndex);
    }
  }

  private lastElementChild(): FakeElement | null {
    return this.lastElementBefore(this.childNodes.length);
  }

  private lastElementBefore(end: number): FakeElement | null {
    for (let index = end - 1; index >= 0; index -= 1) {
      const candidate = this.childNodes[index];
      if (candidate?.nodeType === 1) return candidate as FakeElement;
    }
    return null;
  }

  public contains(candidate: Node): boolean {
    let current: FakeNode | null = candidate as unknown as FakeNode;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
}

class FakeElement extends FakeNode {
  public id = "";
  public className = "";
  public readonly attributes: Array<{ name: string; value: string }> = [];
  public shadowRoot: FakeShadowRoot | null = null;

  public constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeDocument,
  ) {
    super(1);
  }

  public attachShadow(): FakeShadowRoot {
    const shadowRoot = new FakeShadowRoot(this);
    this.shadowRoot = shadowRoot;
    return shadowRoot;
  }

  public get childElementCount(): number {
    let count = 0;
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        count += 1;
      }
    }
    return count;
  }

  public get firstElementChild(): FakeElement | null {
    return (this.childNodes.find((child) => child.nodeType === 1) as
      | FakeElement
      | undefined) ?? null;
  }

  public get classList(): readonly string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }

  public setAttribute(name: string, value: string): void {
    const normalized = name.toLowerCase();
    const existing = this.attributes.find((attribute) => (
      attribute.name === normalized
    ));
    if (existing) {
      existing.value = value;
    } else {
      this.attributes.push({ name: normalized, value });
    }
    if (normalized === "id") {
      this.id = value;
    } else if (normalized === "class") {
      this.className = value;
    }
  }

  public removeAttribute(name: string): void {
    const normalized = name.toLowerCase();
    const index = this.attributes.findIndex((attribute) => (
      attribute.name === normalized
    ));
    if (index >= 0) {
      this.attributes.splice(index, 1);
    }
    if (normalized === "id") {
      this.id = "";
    } else if (normalized === "class") {
      this.className = "";
    }
  }
}

class FakeFrameElement extends FakeElement {
  private readonly loadListeners = new Set<EventListener>();
  private readonly contentWindowValue: { document: FakeDocument | null };
  public contentDocumentReads = 0;
  public contentWindowReads = 0;

  public constructor(
    ownerDocument: FakeDocument,
    private frameDocument: FakeDocument | null,
    private readonly accessError?: Error,
  ) {
    super("IFRAME", ownerDocument);
    this.contentWindowValue = { document: frameDocument };
  }

  public get contentDocument(): Document | null {
    this.contentDocumentReads += 1;
    if (this.accessError) throw this.accessError;
    return this.frameDocument as unknown as Document | null;
  }

  public get contentWindow(): Window | null {
    this.contentWindowReads += 1;
    return this.frameDocument
      ? (this.contentWindowValue as unknown as Window)
      : null;
  }

  public addEventListener(type: string, listener: EventListener): void {
    if (type === "load") this.loadListeners.add(listener);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    if (type === "load") this.loadListeners.delete(listener);
  }

  public getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
      toJSON: () => ({}),
    } as DOMRect;
  }

  public get loadListenerCount(): number {
    return this.loadListeners.size;
  }

  public setFrameDocument(document: FakeDocument | null): void {
    this.frameDocument = document;
    this.contentWindowValue.document = document;
  }

  public dispatchLoad(): void {
    for (const listener of [...this.loadListeners]) {
      listener(new Event("load"));
    }
  }
}

class FakeShadowRoot extends FakeNode {
  public readonly mode = "open";

  public constructor(public readonly host: FakeElement) {
    super(11);
  }

  public getRootNode(): FakeShadowRoot {
    return this;
  }
}

class FakeDocument extends FakeNode {
  public readonly documentElement: FakeElement;

  public constructor() {
    super(9);
    this.documentElement = new FakeElement("HTML", this);
    this.append(this.documentElement);
  }
}

function createDocument(): FakeDocument {
  return new FakeDocument();
}

function createElement(tagName: string, document: FakeDocument): FakeElement {
  return new FakeElement(tagName.toUpperCase(), document);
}

function createFrameElement(
  document: FakeDocument,
  frameDocument: FakeDocument | null,
  accessError?: Error,
): FakeFrameElement {
  return new FakeFrameElement(document, frameDocument, accessError);
}

function createText(_text: string): FakeNode {
  return new FakeNode(3);
}

function createComment(_text: string): FakeNode {
  return new FakeNode(8);
}
