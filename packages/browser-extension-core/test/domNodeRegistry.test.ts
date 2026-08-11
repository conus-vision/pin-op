import { describe, expect, it } from "vitest";
import { DomNodeRegistry } from "../src/domNodeRegistry.js";

const scope = {
  documentEpoch: 7,
  frameRef: "frame-1",
  frameEpoch: 3,
} as const;

describe("DomNodeRegistry", () => {
  it("restores live references and retention without reusing allocation tokens", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const first = createNode();
    const second = createNode();
    const third = createNode();
    const firstRef = registry.reference(first, scope);
    expect(registry.retain(firstRef, "hovered")).toBe(true);
    const snapshot = registry.snapshot();
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error("expected registry snapshot");

    registry.reference(second, scope);
    registry.reference(third, scope);
    expect(registry.resolve(firstRef, scope)).toBe(first);

    expect(registry.restore(snapshot)).toBe(true);
    expect(registry.resolve(firstRef, scope)).toBe(first);
    expect(registry.retentionReasons(firstRef)).toEqual(["hovered"]);
    expect(registry.reference(second, scope)).toBe("node-4");
  });

  it("restores a snapshot without invoking the weak-reference factory again", () => {
    let factoryCalls = 0;
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: (node) => {
        factoryCalls += 1;
        return { deref: () => node };
      },
    });
    const first = createNode();
    const second = createNode();
    registry.reference(first, scope);
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    registry.reference(second, scope);

    expect(registry.restore(snapshot)).toBe(true);
    expect(factoryCalls).toBe(2);
  });

  it("does not restore stale entries when snapshot deref resets the document", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 3,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const oldNode = createNode();
    registry.reference(oldNode, scope);
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    controller.onNextDeref(() => registry.resetDocument(8));

    expect(registry.restore(snapshot)).toBe(false);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextNode = createNode();
    const nextRef = registry.reference(nextNode, nextScope);
    expect(registry.resolve(nextRef, nextScope)).toBe(nextNode);
    expect(registry.size).toBe(1);
  });

  it("preserves a reentrant reference instead of partially restoring a snapshot", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 3,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const oldNode = createNode();
    const oldRef = registry.reference(oldNode, scope);
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    const newerNode = createNode();
    let newerRef = "";
    controller.onNextDeref(() => {
      newerRef = registry.reference(newerNode, scope);
    });

    expect(registry.restore(snapshot)).toBe(false);
    expect(registry.resolve(oldRef, scope)).toBe(oldNode);
    expect(registry.resolve(newerRef, scope)).toBe(newerNode);
    expect(registry.size).toBe(2);
  });

  it("fails an outer restore when weak deref attempts a nested restore", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const node = createNode();
    const ref = registry.reference(node, scope);
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    let nestedResult: boolean | undefined;
    controller.onNextDeref(() => {
      nestedResult = registry.restore(snapshot);
    });

    expect(registry.restore(snapshot)).toBe(false);
    expect(nestedResult).toBe(false);
    expect(registry.resolve(ref, scope)).toBe(node);
  });

  it("restores exact snapshot authority after staging every weak entry", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 3, documentEpoch: 7 });
    const first = createNode();
    const second = createNode();
    const firstRef = registry.reference(first, scope);
    const secondRef = registry.reference(second, scope);
    registry.retain(firstRef, "selected");
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    registry.release(firstRef, "selected");
    registry.reference(createNode(), scope);

    expect(registry.restore(snapshot)).toBe(true);
    expect(registry.resolve(firstRef, scope)).toBe(first);
    expect(registry.resolve(secondRef, scope)).toBe(second);
    expect(registry.retentionReasons(firstRef)).toEqual(["selected"]);
    expect(registry.reference(createNode(), scope)).toBe("node-4");
  });

  it("never reissues an escaped tentative token after rollback", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 3, documentEpoch: 7 });
    const committed = createNode();
    registry.reference(committed, scope);
    const snapshot = registry.snapshot();
    if (!snapshot) throw new Error("expected registry snapshot");
    const escaped = registry.reference(createNode(), scope);

    expect(registry.restore(snapshot)).toBe(true);
    expect(registry.reference(createNode(), scope)).not.toBe(escaped);
  });
  it("creates opaque refs scoped to one document and frame epoch", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 4, documentEpoch: 7 });
    const node = Object.assign(createNode(), {
      tagName: "ARTICLE",
      id: "distinctive-id",
      className: "distinctive-class",
      selector: "article#distinctive-id.distinctive-class",
    });

    const ref = registry.reference(node, scope);

    expect(ref).toMatch(/^node-/);
    expect(ref).not.toContain("ARTICLE");
    expect(ref).not.toContain("distinctive-id");
    expect(ref).not.toContain("distinctive-class");
    expect(ref).not.toContain("article#");
    expect(registry.reference(node, scope)).toBe(ref);
    expect(registry.reference(node, { ...scope, frameEpoch: 4 })).not.toBe(ref);
    expect(registry.resolve(ref, scope)).toBe(node);
    expect(registry.resolve(ref, { ...scope, frameEpoch: 4 })).toBeUndefined();
  });

  it("does not reuse refs across a document reset", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 4, documentEpoch: 7 });
    const node = createNode();
    const oldRef = registry.reference(node, scope);

    registry.resetDocument(8);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextRef = registry.reference(node, nextScope);

    expect(nextRef).not.toBe(oldRef);
    expect(registry.resolve(oldRef, scope)).toBeUndefined();
    expect(registry.resolve(nextRef, nextScope)).toBe(node);
  });

  it("rejects non-increasing document resets without changing live state", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const node = createNode();
    const ref = registry.reference(node, scope);
    registry.retain(ref, "selected");

    for (const invalidEpoch of [7, 6]) {
      expect(() => registry.resetDocument(invalidEpoch)).toThrow(RangeError);
      expect(registry.resolve(ref, scope)).toBe(node);
      expect(registry.retentionReasons(ref)).toEqual(["selected"]);
      expect(registry.retainedSize).toBe(1);
    }
  });

  it("drops every retention reason during a valid document reset", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 4, documentEpoch: 7 });
    const node = createNode();
    const oldRef = registry.reference(node, scope);
    registry.retain(oldRef, "selected");
    registry.retain(oldRef, "hovered");
    registry.retain(oldRef, "expanded");

    registry.resetDocument(8);
    const reasons = registry.retentionReasons(oldRef);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextRef = registry.reference(node, nextScope);

    expect(registry.retainedSize).toBe(0);
    expect(reasons).toEqual([]);
    expect(Object.isFrozen(reasons)).toBe(true);
    expect(registry.resolve(oldRef, scope)).toBeUndefined();
    expect(nextRef).not.toBe(oldRef);
  });

  it("retains nodes only while one or more named reasons remain", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const ref = registry.reference(createNode(), scope);

    expect(registry.retain(ref, "selected")).toBe(true);
    expect(registry.retain(ref, "hovered")).toBe(true);
    expect(registry.retain(ref, "expanded")).toBe(true);
    expect(registry.retentionReasons(ref)).toEqual(["selected", "hovered", "expanded"]);
    expect(registry.retainedSize).toBe(1);
    expect(Object.isFrozen(registry.retentionReasons(ref))).toBe(true);

    registry.release(ref, "hovered");
    expect(registry.retentionReasons(ref)).toEqual(["selected", "expanded"]);
    registry.release(ref, "selected");
    registry.release(ref, "expanded");
    expect(registry.retentionReasons(ref)).toEqual([]);
    expect(registry.retainedSize).toBe(0);
    expect(Object.isFrozen(registry.retentionReasons(ref))).toBe(true);
  });

  it("evicts the least-recently-used unretained entry but never a retained entry", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const first = registry.reference(createNode(), scope);
    const second = registry.reference(createNode(), scope);
    registry.resolve(first, scope);

    const third = registry.reference(createNode(), scope);

    expect(registry.resolve(second, scope)).toBeUndefined();
    expect(registry.resolve(first, scope)).toBeDefined();
    expect(registry.resolve(third, scope)).toBeDefined();

    registry.retain(first, "selected");
    const fourth = registry.reference(createNode(), scope);
    expect(registry.resolve(first, scope)).toBeDefined();
    expect(registry.resolve(third, scope)).toBeUndefined();
    expect(registry.resolve(fourth, scope)).toBeDefined();
  });

  it("refreshes LRU order when reference returns an existing node", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const firstNode = createNode();
    const first = registry.reference(firstNode, scope);
    const second = registry.reference(createNode(), scope);

    expect(registry.reference(firstNode, scope)).toBe(first);
    registry.reference(createNode(), scope);

    expect(registry.resolve(first, scope)).toBe(firstNode);
    expect(registry.resolve(second, scope)).toBeUndefined();
  });

  it("refreshes LRU order when resolve returns a live node", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const first = registry.reference(createNode(), scope);
    const second = registry.reference(createNode(), scope);

    expect(registry.resolve(first, scope)).toBeDefined();
    registry.reference(createNode(), scope);

    expect(registry.resolve(first, scope)).toBeDefined();
    expect(registry.resolve(second, scope)).toBeUndefined();
  });

  it("fails closed at capacity when every reverse entry is retained", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const first = registry.reference(createNode(), scope);
    const second = registry.reference(createNode(), scope);
    registry.retain(first, "selected");
    registry.retain(second, "hovered");

    expect(() => registry.reference(createNode(), scope)).toThrow(/capacity/i);
    expect(registry.size).toBe(2);
  });

  it("reattaches a same-node forward alias after evicting its previous scope", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 1, documentEpoch: 7 });
    const node = createNode();
    const previousRef = registry.reference(node, scope);
    const currentScope = { ...scope, frameEpoch: scope.frameEpoch + 1 };

    const currentRef = registry.reference(node, currentScope);

    expect(previousRef).toBe("node-1");
    expect(currentRef).toBe("node-2");
    expect(registry.reference(node, currentScope)).toBe(currentRef);
    expect(registry.size).toBe(1);
    expect(registry.resolve(currentRef, currentScope)).toBe(node);
  });

  it("preserves the attached forward alias when retained capacity rejects a new scope", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 1, documentEpoch: 7 });
    const node = createNode();
    const previousRef = registry.reference(node, scope);
    registry.retain(previousRef, "selected");

    expect(() =>
      registry.reference(node, { ...scope, frameEpoch: scope.frameEpoch + 1 }),
    ).toThrow(/capacity/i);

    expect(registry.reference(node, scope)).toBe(previousRef);
    expect(registry.resolve(previousRef, scope)).toBe(node);
    expect(registry.size).toBe(1);
  });

  it("prunes dead weak references and does not resolve them", () => {
    const weakReferences = new Map<Node, TestWeakReference>();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: (node) => {
        const reference: TestWeakReference = { target: node, deref: () => reference.target };
        weakReferences.set(node, reference);
        return reference;
      },
    });
    const node = createNode();
    const ref = registry.reference(node, scope);
    weakReferences.get(node)!.target = undefined;

    expect(registry.resolve(ref, scope)).toBeUndefined();
    expect(registry.prune()).toBe(0);
    expect(registry.size).toBe(0);
  });

  it("treats a weak reference that later throws as dead and prunable", () => {
    let throws = false;
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: (node) => ({
        deref: () => {
          if (throws) throw new Error("collected adapter failed");
          return node;
        },
      }),
    });
    const ref = registry.reference(createNode(), scope);
    throws = true;

    expect(registry.resolve(ref, scope)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("does not resurrect an old entry when resolve deref resets the document", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const node = createNode();
    const oldRef = registry.reference(node, scope);
    controller.onNextDeref(() => registry.resetDocument(8));

    expect(registry.resolve(oldRef, scope)).toBeUndefined();

    expect(registry.size).toBe(0);
    expect(() => registry.resetDocument(8)).toThrow(RangeError);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextRef = registry.reference(node, nextScope);
    expect(nextRef).not.toBe(oldRef);
    expect(registry.resolve(nextRef, nextScope)).toBe(node);
    expect(registry.size).toBe(1);
  });

  it("does not retain an old entry when retain deref resets the document", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const node = createNode();
    const oldRef = registry.reference(node, scope);
    controller.onNextDeref(() => registry.resetDocument(8));

    expect(registry.retain(oldRef, "selected")).toBe(false);

    expect(registry.size).toBe(0);
    expect(registry.retainedSize).toBe(0);
    expect(registry.retentionReasons(oldRef)).toEqual([]);
    const nextScope = { ...scope, documentEpoch: 8 };
    expect(registry.resolve(registry.reference(node, nextScope), nextScope)).toBe(node);
  });

  it("does not return an existing ref when its deref resets the document", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const node = createNode();
    const oldRef = registry.reference(node, scope);
    controller.onNextDeref(() => registry.resetDocument(8));

    expect(() => registry.reference(node, scope)).toThrow(/changed|scope|epoch/i);

    expect(registry.size).toBe(0);
    expect(() => registry.resetDocument(8)).toThrow(RangeError);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextRef = registry.reference(node, nextScope);
    expect(nextRef).not.toBe(oldRef);
    expect(registry.resolve(nextRef, nextScope)).toBe(node);
  });

  it("stops prune when deref resets the document and preserves new-epoch entries", () => {
    const controller = createReentrantWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    registry.reference(createNode(), scope);
    const nextScope = { ...scope, documentEpoch: 8 };
    const nextNode = createNode();
    let nextRef: string | undefined;
    controller.onNextDeref(() => {
      registry.resetDocument(8);
      nextRef = registry.reference(nextNode, nextScope);
    }, true);

    expect(registry.prune()).toBe(0);

    expect(nextRef).toBeDefined();
    expect(registry.resolve(nextRef!, nextScope)).toBe(nextNode);
    expect(registry.size).toBe(1);
  });

  it("does not commit or evict after the weak-ref factory resets the document", () => {
    const triggerNode = createNode();
    const validNode = createNode();
    const nextScope = { ...scope, documentEpoch: 8 };
    let registry!: DomNodeRegistry;
    let nestedRef: string | undefined;
    let insideReset = false;
    registry = new DomNodeRegistry({
      maxReverseEntries: 1,
      documentEpoch: 7,
      createWeakRef: (node) => {
        if (node === triggerNode && !insideReset) {
          insideReset = true;
          registry.resetDocument(8);
          nestedRef = registry.reference(validNode, nextScope);
          insideReset = false;
        }
        return { deref: () => node };
      },
    });

    expect(() => registry.reference(triggerNode, scope)).toThrow(/changed|scope|epoch/i);

    expect(nestedRef).toBeDefined();
    expect(registry.resolve(nestedRef!, nextScope)).toBe(validNode);
    expect(registry.size).toBe(1);
    expect(() => registry.resetDocument(8)).toThrow(RangeError);
  });

  it("fails recursive deref re-entry closed without removing the live entry", () => {
    const node = createNode();
    let registry!: DomNodeRegistry;
    let ref: string | undefined;
    let derefCalls = 0;
    let recursiveResult: Node | undefined;
    registry = new DomNodeRegistry({
      maxReverseEntries: 1,
      documentEpoch: 7,
      createWeakRef: () => ({
        deref: () => {
          derefCalls += 1;
          if (derefCalls > 20) {
            throw new Error("recursive deref was not bounded");
          }
          if (ref) {
            recursiveResult = registry.resolve(ref, scope);
          }
          return node;
        },
      }),
    });
    ref = registry.reference(node, scope);

    expect(registry.resolve(ref, scope)).toBe(node);

    expect(recursiveResult).toBeUndefined();
    expect(derefCalls).toBe(2);
    expect(registry.size).toBe(1);
    expect(registry.resolve(ref, scope)).toBe(node);
  });

  it("validates a weak reference before eviction and commits refs transactionally", () => {
    const existingNode = createNode();
    const badNode = createNode();
    let failure: "throw" | "malformed" | "wrong" | undefined;
    const wrongNode = createNode();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 1,
      documentEpoch: 7,
      createWeakRef: (node) => {
        if (node === badNode && failure === "throw") throw new Error("factory failed");
        if (node === badNode && failure === "malformed") return {} as never;
        if (node === badNode && failure === "wrong") return { deref: () => wrongNode };
        return { deref: () => node };
      },
    });
    const existingRef = registry.reference(existingNode, scope);

    for (const mode of ["throw", "malformed", "wrong"] as const) {
      failure = mode;
      expect(() => registry.reference(badNode, scope)).toThrow();
      expect(registry.reference(existingNode, scope)).toBe(existingRef);
      expect(registry.resolve(existingRef, scope)).toBe(existingNode);
      expect(registry.size).toBe(1);
    }

    failure = undefined;
    expect(registry.reference(createNode(), scope)).toBe("node-2");
  });

  it("prunes dead weak references before evicting any live LRU entry", () => {
    const controller = createWeakReferenceController();
    const registry = new DomNodeRegistry({
      maxReverseEntries: 2,
      documentEpoch: 7,
      createWeakRef: controller.create,
    });
    const deadNode = createNode();
    registry.reference(deadNode, scope);
    const liveNode = createNode();
    const liveRef = registry.reference(liveNode, scope);
    controller.expire(deadNode);

    registry.reference(createNode(), scope);

    expect(registry.resolve(liveRef, scope)).toBe(liveNode);
    expect(registry.size).toBe(2);
  });

  it("invalidates a subtree deterministically and fails closed on hostile contains", () => {
    const root = createNode();
    const child = createNode(root);
    const grandchild = createNode(child);
    const sibling = createNode();
    const registry = new DomNodeRegistry({ maxReverseEntries: 8, documentEpoch: 7 });
    const rootRef = registry.reference(root, scope);
    const childRef = registry.reference(child, scope);
    const grandchildRef = registry.reference(grandchild, scope);
    const siblingRef = registry.reference(sibling, scope);
    registry.retain(childRef, "expanded");

    const invalidated = registry.invalidateSubtree(root);
    expect(invalidated).toEqual([rootRef, childRef, grandchildRef]);
    expect(Object.isFrozen(invalidated)).toBe(true);
    expect(Object.isFrozen(registry.invalidateSubtree(createNode()))).toBe(true);
    expect(registry.resolve(rootRef, scope)).toBeUndefined();
    expect(registry.resolve(childRef, scope)).toBeUndefined();
    expect(registry.resolve(grandchildRef, scope)).toBeUndefined();
    expect(registry.resolve(siblingRef, scope)).toBe(sibling);

    const hostileRoot = createNode();
    hostileRoot.contains = () => {
      throw new Error("hostile page object");
    };
    const hostileChild = createNode();
    const hostileRef = registry.reference(hostileChild, scope);
    expect(registry.invalidateSubtree(hostileRoot)).toEqual([]);
    expect(registry.resolve(hostileRef, scope)).toBe(hostileChild);
  });

  it("invalidates ordinary and nested open-shadow descendants atomically", () => {
    const host = createNode();
    const ordinaryChild = createNode(host);
    const shadowRoot = createShadowRoot(host);
    const shadowChild = createNode(shadowRoot);
    const nestedHost = createNode(shadowRoot);
    const nestedShadowRoot = createShadowRoot(nestedHost);
    const nestedChild = createNode(nestedShadowRoot);
    const outside = createNode();
    const registry = new DomNodeRegistry({ maxReverseEntries: 8, documentEpoch: 7 });
    const hostRef = registry.reference(host, scope);
    const ordinaryRef = registry.reference(ordinaryChild, scope);
    const shadowRef = registry.reference(shadowChild, scope);
    const nestedHostRef = registry.reference(nestedHost, scope);
    const nestedRef = registry.reference(nestedChild, scope);
    const outsideRef = registry.reference(outside, scope);

    const invalidated = registry.invalidateSubtree(host);

    expect(invalidated).toEqual([hostRef, ordinaryRef, shadowRef, nestedHostRef, nestedRef]);
    expect(registry.resolve(outsideRef, scope)).toBe(outside);
  });

  it("fails shadow-including invalidation closed on malformed or cyclic boundaries", () => {
    const malformedNodes: TestNode[] = [];

    const cyclic = createNode();
    cyclic.parentNode = cyclic;
    malformedNodes.push(cyclic);

    const malformedParent = createNode();
    malformedParent.parentNode = 42 as never;
    malformedNodes.push(malformedParent);

    const malformedHost = createNode() as TestNode & { host?: unknown };
    malformedHost.host = "not-a-node";
    malformedNodes.push(malformedHost);

    const throwingParent = createNode();
    Object.defineProperty(throwingParent, "parentNode", {
      get: () => {
        throw new Error("hostile parent boundary");
      },
    });
    malformedNodes.push(throwingParent);

    for (const malformed of malformedNodes) {
      const host = createNode();
      const ordinaryChild = createNode(host);
      const registry = new DomNodeRegistry({ maxReverseEntries: 4, documentEpoch: 7 });
      const hostRef = registry.reference(host, scope);
      const ordinaryRef = registry.reference(ordinaryChild, scope);
      const malformedRef = registry.reference(malformed, scope);

      expect(registry.invalidateSubtree(host)).toEqual([]);
      expect(registry.resolve(hostRef, scope)).toBe(host);
      expect(registry.resolve(ordinaryRef, scope)).toBe(ordinaryChild);
      expect(registry.resolve(malformedRef, scope)).toBe(malformed);
    }
  });

  it("does not partially invalidate when contains becomes hostile mid-scan", () => {
    const registry = new DomNodeRegistry({ maxReverseEntries: 4, documentEpoch: 7 });
    const root = createNode();
    const first = registry.reference(createNode(), scope);
    const second = registry.reference(createNode(), scope);
    let calls = 0;
    root.contains = () => {
      calls += 1;
      if (calls === 1) return true;
      throw new Error("hostile page object");
    };

    expect(registry.invalidateSubtree(root)).toEqual([]);
    expect(registry.resolve(first, scope)).toBeDefined();
    expect(registry.resolve(second, scope)).toBeDefined();
  });

  it("fails closed before invalidating a referenced root when contains is unusable", () => {
    for (const configure of [
      (root: Record<string, unknown>) => {
        delete root.contains;
      },
      (root: Record<string, unknown>) => {
        root.contains = 1;
      },
      (root: Record<string, unknown>) => {
        root.contains = () => "yes";
      },
      (root: Record<string, unknown>) => {
        Object.defineProperty(root, "contains", {
          get: () => {
            throw new Error("hostile accessor");
          },
        });
      },
    ]) {
      const registry = new DomNodeRegistry({ maxReverseEntries: 3, documentEpoch: 7 });
      const root = createNode();
      const rootRef = registry.reference(root, scope);
      const childRef = registry.reference(createNode(), scope);
      configure(root as unknown as Record<string, unknown>);

      const invalidated = registry.invalidateSubtree(root);

      expect(invalidated).toEqual([]);
      expect(Object.isFrozen(invalidated)).toBe(true);
      expect(registry.resolve(rootRef, scope)).toBe(root);
      expect(registry.resolve(childRef, scope)).toBeDefined();
    }
  });

  it("rejects invalid options, scopes, and opaque refs", () => {
    expect(() => new DomNodeRegistry({ maxReverseEntries: 0 })).toThrow();
    expect(() => new DomNodeRegistry({ maxReverseEntries: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    const registry = new DomNodeRegistry({ maxReverseEntries: 2, documentEpoch: 7 });
    const node = createNode();

    expect(() => registry.reference(node, { ...scope, frameRef: "div#target" })).toThrow();
    expect(() => registry.reference(node, { ...scope, documentEpoch: 6 })).toThrow();
    for (const invalidScope of [
      { ...scope, documentEpoch: -1 },
      { ...scope, documentEpoch: 7.5 },
      { ...scope, documentEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...scope, frameEpoch: -1 },
      { ...scope, frameEpoch: 3.5 },
      { ...scope, frameEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...scope, frameRef: "frame-0" },
      { ...scope, frameRef: "frame-not-a-number" },
      { ...scope, frameRef: `frame-${"1".repeat(24)}` },
    ]) {
      expect(() => registry.reference(node, invalidScope)).toThrow();
      expect(registry.resolve("node-1", invalidScope)).toBeUndefined();
    }
    expect(() => registry.reference(null as unknown as Node, scope)).toThrow();
    expect(() => registry.resetDocument(-1)).toThrow();
    expect(() => registry.resetDocument(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(registry.resolve("div#target", scope)).toBeUndefined();
    expect(registry.retain("node-999999", "selected")).toBe(false);
    expect(registry.retain("node-999999", "unknown" as never)).toBe(false);
    registry.release("node-999999", "unknown" as never);
  });
});

function createWeakReferenceController(): {
  readonly create: (node: Node) => TestWeakReference;
  readonly expire: (node: Node) => void;
} {
  const references = new Map<Node, TestWeakReference>();
  return {
    create: (node) => {
      const reference: TestWeakReference = { target: node, deref: () => reference.target };
      references.set(node, reference);
      return reference;
    },
    expire: (node) => {
      references.get(node)!.target = undefined;
    },
  };
}

function createReentrantWeakReferenceController(): {
  readonly create: (node: Node) => TestWeakReference;
  readonly onNextDeref: (action: () => void, returnUndefined?: boolean) => void;
} {
  let nextAction: (() => void) | undefined;
  let nextReturnsUndefined = false;
  return {
    create: (node) => ({
      deref: () => {
        const action = nextAction;
        const returnsUndefined = nextReturnsUndefined;
        nextAction = undefined;
        nextReturnsUndefined = false;
        action?.();
        return returnsUndefined ? undefined : node;
      },
    }),
    onNextDeref: (action, returnUndefined = false) => {
      nextAction = action;
      nextReturnsUndefined = returnUndefined;
    },
  };
}

interface TestWeakReference {
  target: Node | undefined;
  deref(): Node | undefined;
}

interface TestNode {
  parentNode: TestNode | null;
  shadowRoot?: TestShadowRoot;
  contains(other: Node): boolean;
}

interface TestShadowRoot extends TestNode {
  readonly host: TestNode;
}

function createNode(parentNode: TestNode | null = null): TestNode & Node {
  const node: TestNode = {
    parentNode,
    contains(other: Node): boolean {
      let current = other as unknown as TestNode | undefined;
      const seen = new Set<TestNode>();
      while (current) {
        if (current === node) {
          return true;
        }
        if (seen.has(current)) {
          return false;
        }
        seen.add(current);
        current = current.parentNode ?? undefined;
      }
      return false;
    },
  };
  return node as TestNode & Node;
}

function createShadowRoot(host: TestNode): TestShadowRoot & ShadowRoot {
  const shadowRoot = createNode() as TestShadowRoot & ShadowRoot;
  Object.defineProperty(shadowRoot, "host", { value: host, enumerable: true });
  host.shadowRoot = shadowRoot;
  return shadowRoot;
}
