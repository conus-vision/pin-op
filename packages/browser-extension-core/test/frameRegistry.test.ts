import { describe, expect, it } from "vitest";
import {
  FrameRegistry as FrameRegistryBase,
  type FrameIdentity,
  type FrameLifecycleEvent,
  type ViewportRect,
} from "../src/frameRegistry.js";

class FrameRegistry extends FrameRegistryBase {
  public override describeFrame(
    frameElement: HTMLIFrameElement,
    parentFrameRef = this.topContext?.frameRef,
  ) {
    const parent = parentFrameRef ? this.getContext(parentFrameRef) : undefined;
    if (parent && frameElement instanceof FakeFrame) {
      frameElement.assignDefaultOwnerDocument(parent.document);
    }
    return super.describeFrame(frameElement, parentFrameRef);
  }
}

describe("FrameRegistry", () => {
  it("exposes a stable top context for the current document epoch", () => {
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, { documentEpoch: 5, maxFrames: 4 });

    expect(registry.topContext).toMatchObject({
      frameRef: "frame-1",
      frameEpoch: 1,
      documentEpoch: 5,
      document: topDocument,
    });
    expect(Object.isFrozen(registry.topContext)).toBe(true);
    expect(registry.getContextForDocument(topDocument)).toEqual(registry.topContext);
  });

  it("freezes nonempty accessible context lists and lifecycle events", () => {
    const events: object[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event),
    });
    registry.describeFrame(createFrame({ document: createDocument() }));
    const contexts = registry.accessibleContexts();

    expect(Object.isFrozen(contexts)).toBe(true);
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(Object.isFrozen(contexts[1])).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("registers same-origin child and nested frame documents", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 5 });
    const parentDocument = createDocument();
    const parent = createFrame({ document: parentDocument });
    const parentDescription = registry.registerChildFrame(parent);
    expect(parentDescription).toMatchObject({ kind: "accessible", parentFrameRef: "frame-1" });
    expect(parentDescription?.kind).toBe("accessible");
    if (parentDescription?.kind !== "accessible") throw new Error("expected accessible frame");

    const childDocument = createDocument();
    const child = createFrame({ document: childDocument });
    const childDescription = registry.registerChildFrame(child, parentDescription.frameRef);

    expect(childDescription).toMatchObject({
      kind: "accessible",
      parentFrameRef: parentDescription.frameRef,
      document: childDocument,
    });
    expect(registry.accessibleContexts()).toHaveLength(3);
  });

  it.each(["locked-first", "owner-first"] as const)(
    "keeps one owner for a shared child document when removing %s",
    (removalOrder) => {
      const events: FrameLifecycleEvent[] = [];
      const registry = new FrameRegistry(createDocument(), {
        maxFrames: 3,
        onLifecycle: (event) => events.push(event),
      });
      const sharedDocument = createDocument();
      const ownerFrame = createFrame({ document: sharedDocument });
      const duplicateFrame = createFrame({ document: sharedDocument });
      const owner = registry.describeFrame(ownerFrame);
      if (owner?.kind !== "accessible") throw new Error("expected accessible frame");

      const duplicate = registry.describeFrame(duplicateFrame);

      expect(duplicate).toMatchObject({ kind: "inaccessible", locked: true });
      expect(duplicate).not.toHaveProperty("document");
      expect(registry.getContextForDocument(sharedDocument)).toBe(
        registry.getContext(owner.frameRef),
      );
      expect(registry.accessibleContexts()).toHaveLength(2);
      expect(events.slice(0, 2).map((event) => [event.type, event.accessible])).toEqual([
        ["registered", true],
        ["registered", false],
      ]);

      if (removalOrder === "locked-first") {
        registry.unregisterFrame(duplicateFrame);
        expect(registry.getContextForDocument(sharedDocument)).toBe(
          registry.getContext(owner.frameRef),
        );
        registry.unregisterFrame(ownerFrame);
      } else {
        registry.unregisterFrame(ownerFrame);
        expect(registry.getContextForDocument(sharedDocument)).toBeUndefined();
        expect(registry.describeFrame(duplicateFrame)).toMatchObject({
          kind: "inaccessible",
          locked: true,
        });
        registry.unregisterFrame(duplicateFrame);
      }

      expect(registry.getContextForDocument(sharedDocument)).toBeUndefined();
      expect(registry.accessibleContexts()).toEqual([registry.topContext]);
      expect(ownerFrame.loadListenerCount).toBe(0);
      expect(duplicateFrame.loadListenerCount).toBe(0);
      expect(events.slice(2).map((event) => [event.type, event.accessible])).toEqual([
        ["removed", false],
        ["removed", false],
      ]);
    },
  );

  it("locks navigation document collisions and recovers when each document is unique", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event),
    });
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const recoveredDocument = createDocument();
    const firstFrame = createFrame({ document: firstDocument });
    const secondFrame = createFrame({ document: secondDocument });
    const first = registry.describeFrame(firstFrame);
    const second = registry.describeFrame(secondFrame);
    if (first?.kind !== "accessible" || second?.kind !== "accessible") {
      throw new Error("expected accessible frames");
    }

    secondFrame.setDocument(firstDocument);
    secondFrame.dispatchLoad();

    expect(registry.describeFrame(secondFrame)).toMatchObject({
      kind: "inaccessible",
      frameRef: second.frameRef,
      frameEpoch: 2,
    });
    expect(registry.describeFrame(secondFrame)).not.toHaveProperty("document");
    expect(registry.getContextForDocument(firstDocument)).toBe(
      registry.getContext(first.frameRef),
    );
    expect(registry.getContextForDocument(secondDocument)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "navigated",
      frameRef: second.frameRef,
      accessible: false,
    });

    secondFrame.setDocument(recoveredDocument);
    secondFrame.dispatchLoad();

    expect(registry.describeFrame(secondFrame)).toMatchObject({
      kind: "accessible",
      frameEpoch: 3,
      document: recoveredDocument,
    });
    expect(registry.getContextForDocument(recoveredDocument)).toBe(
      registry.getContext(second.frameRef),
    );
    expect(events.at(-1)).toMatchObject({
      type: "navigated",
      frameRef: second.frameRef,
      accessible: true,
    });

    firstFrame.setDocument(recoveredDocument);
    firstFrame.dispatchLoad();

    expect(registry.describeFrame(firstFrame)).toMatchObject({
      kind: "inaccessible",
      frameEpoch: 2,
    });
    expect(registry.getContextForDocument(recoveredDocument)).toBe(
      registry.getContext(second.frameRef),
    );
    expect(registry.getContextForDocument(firstDocument)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "navigated",
      frameRef: first.frameRef,
      accessible: false,
    });

    firstFrame.setDocument(firstDocument);
    firstFrame.dispatchLoad();

    expect(registry.describeFrame(firstFrame)).toMatchObject({
      kind: "accessible",
      frameEpoch: 3,
      document: firstDocument,
    });
    expect(registry.getContextForDocument(firstDocument)).toBe(
      registry.getContext(first.frameRef),
    );
    expect(registry.getContextForDocument(recoveredDocument)).toBe(
      registry.getContext(second.frameRef),
    );
    expect(events.at(-1)).toMatchObject({
      type: "navigated",
      frameRef: first.frameRef,
      accessible: true,
    });
  });

  it("keeps a frame locked while it exposes the top document", () => {
    const events: FrameLifecycleEvent[] = [];
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const frame = createFrame({ document: topDocument });

    const locked = registry.describeFrame(frame);

    expect(locked).toMatchObject({ kind: "inaccessible", locked: true });
    expect(locked).not.toHaveProperty("document");
    expect(registry.getContextForDocument(topDocument)).toBe(registry.topContext);
    expect(registry.accessibleContexts()).toEqual([registry.topContext]);
    expect(events.at(-1)).toMatchObject({ type: "registered", accessible: false });
    expect(frame.loadListenerCount).toBe(1);

    const childDocument = createDocument();
    frame.setDocument(childDocument);
    frame.dispatchLoad();

    expect(registry.describeFrame(frame)).toMatchObject({
      kind: "accessible",
      frameEpoch: 2,
      document: childDocument,
    });
    expect(registry.getContextForDocument(topDocument)).toBe(registry.topContext);
    expect(registry.getContextForDocument(childDocument)).toBe(
      registry.getContext(locked!.frameRef),
    );
    expect(events.at(-1)).toMatchObject({ type: "navigated", accessible: true });
  });

  it("translates a nested rectangle through every frame element to the top viewport", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 5 });
    const parent = registry.registerChildFrame(
      createFrame({ document: createDocument(), left: 100, top: 200 }),
    );
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const child = registry.registerChildFrame(
      createFrame({ document: createDocument(), left: 20, top: 30, clientLeft: 1, clientTop: 2 }),
      parent.frameRef,
    );
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(registry.toTopViewport(child, { x: 2, y: 3, width: 4, height: 5 })).toEqual({
      x: 123,
      y: 235,
      width: 4,
      height: 5,
      left: 123,
      top: 235,
      right: 127,
      bottom: 240,
    });
  });

  it("snapshots stateful caller rectangle getters exactly once", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 2 });
    const top = registry.topContext!;
    const reads = createRectReadCounts();
    const rect = createGetterRect((field) => {
      reads[field] += 1;
      const firstValues = { x: 2, y: 3, width: 4, height: 5 };
      return firstValues[field] + (reads[field] - 1) * 100;
    });

    const translated = registry.toTopViewport(top, rect);

    expect(translated).toEqual({
      x: 2,
      y: 3,
      width: 4,
      height: 5,
      left: 2,
      top: 3,
      right: 6,
      bottom: 8,
    });
    expect(reads).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("does not perform a late width read that can return stale geometry", () => {
    const initialTopDocument = createDocument();
    const replacementTopDocument = createDocument();
    const registry = new FrameRegistry(initialTopDocument, { maxFrames: 2 });
    const top = registry.topContext!;
    const reads = createRectReadCounts();
    const rect = createGetterRect((field) => {
      reads[field] += 1;
      if (field === "width" && reads.width === 4) {
        registry.resetTopDocument(replacementTopDocument, 1);
      }
      return { x: 2, y: 3, width: 4, height: 5 }[field];
    });

    const translated = registry.toTopViewport(top, rect);

    expect(translated).toMatchObject({ x: 2, y: 3, width: 4, height: 5 });
    expect(reads).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    expect(registry.topContext).toBe(top);
    expect(registry.getContextForDocument(initialTopDocument)).toBe(top);
    expect(registry.getContextForDocument(replacementTopDocument)).toBeUndefined();
  });

  it("snapshots stateful caller frame identity getters exactly once", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 2 });
    const top = registry.topContext!;
    const reads = createIdentityReadCounts();
    const firstValues = identityValues(top);
    const identity = createGetterIdentity((field) => {
      reads[field] += 1;
      if (reads[field] === 1) return firstValues[field];
      return field === "frameRef" ? "frame-999" : 999;
    });

    const translated = registry.toTopViewport(identity, {
      x: 2,
      y: 3,
      width: 4,
      height: 5,
    });

    expect(translated).toMatchObject({ x: 2, y: 3, width: 4, height: 5 });
    expect(reads).toEqual({ frameRef: 1, frameEpoch: 1, documentEpoch: 1 });
  });

  it("does not read caller identity getters during the final authority check", () => {
    const initialTopDocument = createDocument();
    const replacementTopDocument = createDocument();
    const registry = new FrameRegistry(initialTopDocument, { maxFrames: 2 });
    const top = registry.topContext!;
    const reads = createIdentityReadCounts();
    const values = identityValues(top);
    let lateReads = 0;
    let armLateReset = false;
    const identity = createGetterIdentity((field) => {
      reads[field] += 1;
      if (field === "documentEpoch" && armLateReset) {
        lateReads += 1;
        if (lateReads === 2) {
          registry.resetTopDocument(replacementTopDocument, 1);
        }
      }
      return values[field];
    });
    const rect = {
      x: 2,
      y: 3,
      width: 4,
      get height(): number {
        armLateReset = true;
        return 5;
      },
    };

    const translated = registry.toTopViewport(identity, rect);

    expect(translated).toMatchObject({ x: 2, y: 3, width: 4, height: 5 });
    expect(reads).toEqual({ frameRef: 1, frameEpoch: 1, documentEpoch: 1 });
    expect(lateReads).toBe(0);
    expect(registry.topContext).toBe(top);
    expect(registry.getContextForDocument(initialTopDocument)).toBe(top);
    expect(registry.getContextForDocument(replacementTopDocument)).toBeUndefined();
  });

  it.each([
    ["frameRef", { frameRef: 1, frameEpoch: 0, documentEpoch: 0 }],
    ["frameEpoch", { frameRef: 1, frameEpoch: 1, documentEpoch: 0 }],
    ["documentEpoch", { frameRef: 1, frameEpoch: 1, documentEpoch: 1 }],
  ] as const)(
    "fails closed when the caller identity %s getter throws",
    (throwingField, expectedReads) => {
      const registry = new FrameRegistry(createDocument(), { maxFrames: 2 });
      const top = registry.topContext!;
      const reads = createIdentityReadCounts();
      const values = identityValues(top);
      const identity = createGetterIdentity((field) => {
        reads[field] += 1;
        if (field === throwingField) throw new Error(`hostile ${field}`);
        return values[field];
      });

      expect(registry.toTopViewport(identity, { x: 0, y: 0, width: 1, height: 1 }))
        .toBeUndefined();
      expect(reads).toEqual(expectedReads);
      expect(registry.topContext).toBe(top);
    },
  );

  it.each([
    ["frameRef", "reset", { frameRef: 1, frameEpoch: 0, documentEpoch: 0 }],
    ["frameEpoch", "dispose", { frameRef: 1, frameEpoch: 1, documentEpoch: 0 }],
    ["documentEpoch", "unregister", { frameRef: 1, frameEpoch: 1, documentEpoch: 1 }],
    ["documentEpoch", "navigate", { frameRef: 1, frameEpoch: 1, documentEpoch: 1 }],
  ] as const)(
    "fails closed when the caller identity %s getter triggers %s",
    (mutatingField, mutation, expectedReads) => {
      const initialTopDocument = createDocument();
      const replacementTopDocument = createDocument();
      const initialChildDocument = createDocument();
      const replacementChildDocument = createDocument();
      const registry = new FrameRegistry(initialTopDocument, { maxFrames: 2 });
      const frame = createFrame({ document: initialChildDocument });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");
      const values = identityValues(description);
      const reads = createIdentityReadCounts();
      if (mutation === "navigate") frame.setDocument(replacementChildDocument);
      const identity = createGetterIdentity((field) => {
        reads[field] += 1;
        if (field === mutatingField) {
          if (mutation === "reset") registry.resetTopDocument(replacementTopDocument, 1);
          if (mutation === "dispose") registry.dispose();
          if (mutation === "unregister") registry.unregisterFrame(frame);
          if (mutation === "navigate") frame.dispatchLoad();
        }
        return values[field];
      });

      expect(registry.toTopViewport(identity, { x: 0, y: 0, width: 1, height: 1 }))
        .toBeUndefined();
      expect(reads).toEqual(expectedReads);

      if (mutation === "reset") {
        expect(registry.topContext).toMatchObject({
          document: replacementTopDocument,
          documentEpoch: 1,
        });
        expect(registry.getContext(description.frameRef)).toBeUndefined();
      } else if (mutation === "dispose") {
        expect(registry.topContext).toBeUndefined();
      } else if (mutation === "unregister") {
        expect(registry.topContext).toMatchObject({ document: initialTopDocument });
        expect(registry.getContext(description.frameRef)).toBeUndefined();
      } else {
        expect(registry.getContext(description.frameRef)).toMatchObject({
          frameEpoch: description.frameEpoch + 1,
          document: replacementChildDocument,
        });
        expect(registry.getContextForDocument(initialChildDocument)).toBeUndefined();
      }
    },
  );

  it.each([
    ["x", { x: 1, y: 0, width: 0, height: 0 }],
    ["y", { x: 1, y: 1, width: 0, height: 0 }],
    ["width", { x: 1, y: 1, width: 1, height: 0 }],
    ["height", { x: 1, y: 1, width: 1, height: 1 }],
  ] as const)(
    "fails closed when the caller rectangle %s getter throws",
    (throwingField, expectedReads) => {
      const registry = new FrameRegistry(createDocument(), { maxFrames: 2 });
      const top = registry.topContext!;
      const reads = createRectReadCounts();
      const rect = createGetterRect((field) => {
        reads[field] += 1;
        if (field === throwingField) throw new Error(`hostile ${field}`);
        return { x: 2, y: 3, width: 4, height: 5 }[field];
      });

      expect(registry.toTopViewport(top, rect)).toBeUndefined();
      expect(reads).toEqual(expectedReads);
    },
  );

  it.each([
    ["x", { x: 1, y: 0, width: 0, height: 0 }],
    ["y", { x: 1, y: 1, width: 0, height: 0 }],
    ["width", { x: 1, y: 1, width: 1, height: 0 }],
    ["height", { x: 1, y: 1, width: 1, height: 1 }],
  ] as const)(
    "fails closed immediately when the caller rectangle %s getter resets the registry",
    (mutatingField, expectedReads) => {
      const initialTopDocument = createDocument();
      const replacementTopDocument = createDocument();
      const registry = new FrameRegistry(initialTopDocument, { maxFrames: 2 });
      const top = registry.topContext!;
      const reads = createRectReadCounts();
      const rect = createGetterRect((field) => {
        reads[field] += 1;
        if (field === mutatingField) {
          registry.resetTopDocument(replacementTopDocument, 1);
        }
        return { x: 2, y: 3, width: 4, height: 5 }[field];
      });

      expect(registry.toTopViewport(top, rect)).toBeUndefined();
      expect(reads).toEqual(expectedReads);
      expect(registry.topContext).toMatchObject({
        document: replacementTopDocument,
        documentEpoch: 1,
      });
      expect(registry.getContextForDocument(initialTopDocument)).toBeUndefined();
    },
  );

  it("rejects stale geometry when the rect getter resets the top document", () => {
    const events: FrameLifecycleEvent[] = [];
    const nextTopDocument = createDocument();
    let registry!: FrameRegistry;
    const frame = createFrame({
      document: createDocument(),
      left: 100,
      top: 200,
      onGetBoundingClientRect: () => {
        registry.resetTopDocument(nextTopDocument, 1);
      },
    });
    registry = new FrameRegistry(frame.ownerDocument, {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    const translated = registry.toTopViewport(description, {
      x: 2,
      y: 3,
      width: 4,
      height: 5,
    });

    expect(translated).toBeUndefined();
    expect(registry.topContext).toMatchObject({
      document: nextTopDocument,
      documentEpoch: 1,
    });
    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(frame.loadListenerCount).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["registered", "reset"]);
  });

  it("rejects stale geometry when computed-style access disposes the registry", () => {
    const events: FrameLifecycleEvent[] = [];
    let registry!: FrameRegistry;
    const geometryDocument = createGeometryDocument(() => registry.dispose());
    const frame = createFrame({
      document: createDocument(),
      ownerDocument: geometryDocument,
    });
    registry = new FrameRegistry(geometryDocument, {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    const translated = registry.toTopViewport(description, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });

    expect(translated).toBeUndefined();
    expect(registry.topContext).toBeUndefined();
    expect(registry.accessibleContexts()).toEqual([]);
    expect(frame.loadListenerCount).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["registered"]);
  });

  it.each(["unregister", "navigate"] as const)(
    "rejects stale geometry when an ancestor getter triggers %s",
    (mutation) => {
      const events: FrameLifecycleEvent[] = [];
      let mutationCalls = 0;
      let mutate = (): void => undefined;
      const ancestor = new FakeStyleElement({
        onAssignedSlotRead: () => {
          mutationCalls += 1;
          mutate();
        },
      });
      const oldDocument = createDocument();
      const nextDocument = createDocument();
      const topDocument = createDocument();
      const registry = new FrameRegistry(topDocument, {
        maxFrames: 2,
        onLifecycle: (event) => events.push(event),
      });
      const frame = createFrame({
        document: oldDocument,
        ownerDocument: topDocument,
        parentElement: ancestor,
        left: 10,
        top: 20,
      });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");
      expect(registry.getContext(description.frameRef)).toBeDefined();
      if (mutation === "unregister") {
        mutate = () => {
          registry.unregisterFrame(frame);
        };
      } else {
        frame.setDocument(nextDocument);
        let navigated = false;
        mutate = () => {
          if (navigated) return;
          navigated = true;
          frame.dispatchLoad();
        };
      }

      const translated = registry.toTopViewport(description, {
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      });

      expect(translated).toBeUndefined();
      if (mutation === "unregister") {
        expect(mutationCalls).toBeGreaterThan(0);
        expect(registry.getContext(description.frameRef)).toBeUndefined();
        expect(frame.loadListenerCount).toBe(0);
        expect(events.map((event) => event.type)).toEqual(["registered", "removed"]);
      } else {
        expect(mutationCalls).toBe(0);
        expect(registry.getContext(description.frameRef)).toBeUndefined();
        expect(frame.loadListenerCount).toBe(1);
        expect(events.map((event) => event.type)).toEqual(["registered"]);
      }
    },
  );

  it("represents cross-origin access as a locked leaf without retrying or leaking a document", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const frame = createFrame({ contentDocumentError: new Error("cross-origin") });

    const description = registry.registerChildFrame(frame);

    expect(description).toMatchObject({ kind: "inaccessible", locked: true });
    expect(frame.contentDocumentReads).toBe(2);
    expect(frame.contentWindowReads).toBe(0);
    expect(description).not.toHaveProperty("document");
    expect(JSON.parse(JSON.stringify(description!))).not.toHaveProperty("document");
  });

  it("represents a null child document as an inaccessible locked leaf", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });

    const description = registry.registerChildFrame(createFrame({ document: null }));

    expect(description).toMatchObject({ kind: "inaccessible", locked: true });
    expect(description).not.toHaveProperty("document");
  });

  it("replaces only a loaded frame subtree and its epoch", () => {
    const events: string[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 5,
      onLifecycle: (event) => events.push(`${event.type}:${event.frameRef}`),
    });
    const firstDocument = createDocument();
    const frame = createFrame({ document: firstDocument });
    const parent = registry.registerChildFrame(frame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const child = registry.registerChildFrame(createFrame({ document: createDocument() }), parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    const firstEpoch = parent.frameEpoch;
    frame.setDocument(createDocument());

    frame.dispatchLoad();

    const replacement = registry.getContext(parent.frameRef);
    expect(replacement).toMatchObject({ frameRef: parent.frameRef, frameEpoch: firstEpoch + 1 });
    expect(registry.getContextForDocument(firstDocument)).toBeUndefined();
    expect(registry.getContext(child.frameRef)).toBeUndefined();
    expect(events).toContain(`navigated:${parent.frameRef}`);
  });

  it("resets the top document and invalidates all child contexts", () => {
    const registry = new FrameRegistry(createDocument(), { documentEpoch: 3, maxFrames: 3 });
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.registerChildFrame(childFrame);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    const topRef = registry.topContext.frameRef;
    const nextDocument = createDocument();

    registry.resetTopDocument(nextDocument, 4);

    expect(registry.topContext).toMatchObject({ frameRef: topRef, documentEpoch: 4, document: nextDocument });
    expect(registry.getContext(child.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(childFrame.loadListenerCount).toBe(0);
    expect(registry.accessibleContexts()).toEqual([registry.topContext]);
  });

  it("fails closed when the frame bound is reached", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 2 });
    expect(registry.registerChildFrame(createFrame({ document: createDocument() }))).toMatchObject({ kind: "accessible" });

    expect(registry.registerChildFrame(createFrame({ document: createDocument() }))).toBeUndefined();
  });

  it("removes load listeners and prevents callbacks after disposal", () => {
    const events: string[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event.type),
    });
    const frame = createFrame({ document: createDocument() });
    registry.registerChildFrame(frame);
    const eventCount = events.length;

    registry.dispose();
    frame.dispatchLoad();

    expect(frame.loadListenerCount).toBe(0);
    expect(events).toHaveLength(eventCount);
    expect(registry.getContext("frame-1")).toBeUndefined();
    expect(registry.registerChildFrame(frame)).toBeUndefined();
  });

  it("rejects stale and unknown frame references", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const child = registry.registerChildFrame(createFrame({ document: createDocument() }));
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(registry.toTopViewport({ frameRef: "frame-999", frameEpoch: 1, documentEpoch: 0 }, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    registry.resetTopDocument(createDocument(), 2);
    expect(registry.toTopViewport(child, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
  });

  it("describes existing accessible and locked frames without duplicate registration", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 4 });
    const accessibleFrame = createFrame({ document: createDocument() });
    const accessible = registry.describeFrame(accessibleFrame);
    if (accessible?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(Object.isFrozen(accessible)).toBe(true);
    expect(registry.describeFrame(accessibleFrame)).toMatchObject({ frameRef: accessible.frameRef });
    expect(accessibleFrame.loadListenerCount).toBe(1);
    expect(accessibleFrame.contentDocumentReads).toBe(3);
    expect(accessibleFrame.contentWindowReads).toBe(3);

    const lockedFrame = createFrame({ document: null });
    const locked = registry.describeFrame(lockedFrame);
    expect(locked).toMatchObject({ kind: "inaccessible", locked: true });
    expect(locked).not.toHaveProperty("document");
    expect(Object.isFrozen(locked)).toBe(true);
    expect(registry.describeFrame(lockedFrame)).toEqual(locked);
    expect(lockedFrame.loadListenerCount).toBe(1);
    expect(lockedFrame.contentDocumentReads).toBe(2);
  });

  it("does not return a stale context when contentDocument inspection reenters through load", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const document = createDocument();
    const frame = createFrame({ document });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const stale = registry.getContext(description.frameRef)!;
    frame.setContentDocumentReadCallback(() => frame.dispatchLoad());

    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(registry.getContext(description.frameRef)).toMatchObject({
      frameRef: description.frameRef,
      frameEpoch: stale.frameEpoch + 1,
      document,
    });
  });

  it("does not return a stale context when contentWindow inspection reenters through load", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const document = createDocument();
    const frame = createFrame({ document });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const stale = registry.getContext(description.frameRef)!;
    frame.setContentWindowReadCallback(() => frame.dispatchLoad());

    expect(registry.getContextForDocument(document)).toBeUndefined();
    expect(registry.getContext(description.frameRef)).toMatchObject({
      frameRef: description.frameRef,
      frameEpoch: stale.frameEpoch + 1,
      document,
    });
  });

  it("rejects a child when its inspection silently changes a parent document", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 4 });
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible child");
    childFrame.setContentDocumentReadCallback(() => parentFrame.setDocument(createDocument()));

    expect(registry.getContext(child.frameRef)).toBeUndefined();
  });

  it("rejects a descendant when its inspection silently changes a grandparent document", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 5 });
    const grandparentDocument = createDocument();
    const grandparentFrame = createFrame({ document: grandparentDocument });
    const grandparent = registry.describeFrame(grandparentFrame);
    if (grandparent?.kind !== "accessible") throw new Error("expected accessible grandparent");
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame, grandparent.frameRef);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible child");
    childFrame.setContentWindowReadCallback(() => grandparentFrame.setDocument(createDocument()));

    expect(registry.getContext(child.frameRef)).toBeUndefined();
  });

  it("rejects a child when live parent inspection throws", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 4 });
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible child");
    parentFrame.setContentDocumentError(new Error("hostile parent access"));

    expect(registry.getContext(child.frameRef)).toBeUndefined();
  });

  it("does not register a child after its inspection silently changes parent authority", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 4 });
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childFrame = createFrame({ document: createDocument() });
    childFrame.setContentDocumentReadCallback(() => parentFrame.setDocument(createDocument()));

    expect(registry.describeFrame(childFrame, parent.frameRef)).toBeUndefined();
  });

  it("does not refresh a child after its load inspection silently changes parent authority", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 4 });
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible child");
    childFrame.setContentDocumentReadCallback(() => parentFrame.setDocument(createDocument()));

    childFrame.dispatchLoad();

    expect(registry.getContext(child.frameRef)).toBeUndefined();
  });

  it("invalidates only a loaded frame subtree and retains an unaffected sibling", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 5 });
    const oldParentDocument = createDocument();
    const parentFrame = createFrame({ document: oldParentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const descendantDocument = createDocument();
    const descendantFrame = createFrame({ document: descendantDocument });
    const descendant = registry.describeFrame(descendantFrame, parent.frameRef);
    if (descendant?.kind !== "accessible") throw new Error("expected accessible frame");
    const siblingDocument = createDocument();
    const siblingFrame = createFrame({ document: siblingDocument });
    const sibling = registry.describeFrame(siblingFrame);
    if (sibling?.kind !== "accessible") throw new Error("expected accessible frame");
    parentFrame.setDocument(createDocument());

    parentFrame.dispatchLoad();

    expect(descendantFrame.loadListenerCount).toBe(0);
    expect(registry.getContext(descendant.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(descendantDocument)).toBeUndefined();
    expect(registry.getContextForDocument(oldParentDocument)).toBeUndefined();
    expect(registry.getContext(sibling.frameRef)).toMatchObject({ document: siblingDocument });
    expect(siblingFrame.loadListenerCount).toBe(1);
  });

  it("unregisters a detached top-level frame once and frees its capacity", () => {
    const events: Array<{ type: string; invalidated?: readonly object[] }> = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const document = createDocument();
    const frame = createFrame({ document });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const eventCount = events.length;

    const invalidated = registry.unregisterFrame(frame);

    expect(invalidated).toEqual([identityOf(description)]);
    expect(Object.isFrozen(invalidated)).toBe(true);
    expect(Object.isFrozen(invalidated[0])).toBe(true);
    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(document)).toBeUndefined();
    expect(frame.loadListenerCount).toBe(0);
    expect(events).toHaveLength(eventCount + 1);
    expect(events.at(-1)).toMatchObject({
      type: "removed",
      frameRef: description.frameRef,
      accessible: false,
    });
    expect(events.at(-1)?.invalidated).toEqual(invalidated);
    expect(Object.isFrozen(events.at(-1)?.invalidated)).toBe(true);

    const replacement = registry.describeFrame(createFrame({ document: createDocument() }));
    expect(replacement).toMatchObject({ kind: "accessible" });
    const postRemovalEventCount = events.length;
    const repeated = registry.unregisterFrame(frame);
    expect(repeated).toEqual([]);
    expect(Object.isFrozen(repeated)).toBe(true);
    expect(events).toHaveLength(postRemovalEventCount);
  });

  it("unregisters a nested frame subtree deterministically with one callback", () => {
    const events: Array<{ type: string; invalidated?: readonly object[] }> = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 6,
      onLifecycle: (event) => events.push(event),
    });
    const parentDocument = createDocument();
    const parentFrame = createFrame({ document: parentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    const grandchildDocument = createDocument();
    const grandchildFrame = createFrame({ document: grandchildDocument });
    const grandchild = registry.describeFrame(grandchildFrame, child.frameRef);
    if (grandchild?.kind !== "accessible") throw new Error("expected accessible frame");
    const siblingFrame = createFrame({ document: createDocument() });
    const sibling = registry.describeFrame(siblingFrame);
    if (sibling?.kind !== "accessible") throw new Error("expected accessible frame");
    const eventCount = events.length;

    const invalidated = registry.unregisterFrame(parent.frameRef);

    expect(invalidated).toEqual([
      identityOf(parent),
      identityOf(child),
      identityOf(grandchild),
    ]);
    expect(parentFrame.loadListenerCount).toBe(0);
    expect(childFrame.loadListenerCount).toBe(0);
    expect(grandchildFrame.loadListenerCount).toBe(0);
    expect(registry.getContextForDocument(parentDocument)).toBeUndefined();
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(registry.getContextForDocument(grandchildDocument)).toBeUndefined();
    expect(registry.getContext(sibling.frameRef)).toBeDefined();
    expect(siblingFrame.loadListenerCount).toBe(1);
    expect(events).toHaveLength(eventCount + 1);
    expect(events.at(-1)).toMatchObject({ type: "removed", invalidated });
  });

  it("marks a frame inactive before listener removal can synchronously re-enter load", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const frame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    const invalidated = registry.unregisterFrame(frame);

    expect(invalidated).toEqual([identityOf(description)]);
    expect(events.map((event) => event.type)).toEqual(["registered", "removed"]);
    expect(events.at(-1)).toMatchObject({
      frameRef: description.frameRef,
      frameEpoch: description.frameEpoch,
      invalidated: [identityOf(description)],
    });
    expect(frame.loadListenerCount).toBe(0);
  });

  it("marks an entire nested subtree inactive before detaching reentrant listeners", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 4,
      onLifecycle: (event) => events.push(event),
    });
    const parentFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");

    const invalidated = registry.unregisterFrame(parent.frameRef);

    expect(invalidated).toEqual([identityOf(parent), identityOf(child)]);
    expect(events.map((event) => event.type)).toEqual([
      "registered",
      "registered",
      "removed",
    ]);
    expect(parentFrame.loadListenerCount).toBe(0);
    expect(childFrame.loadListenerCount).toBe(0);
  });

  it("keeps descendant listener re-entry inert during parent navigation", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 4,
      onLifecycle: (event) => events.push(event),
    });
    const parentFrame = createFrame({ document: createDocument() });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    parentFrame.setDocument(createDocument());

    parentFrame.dispatchLoad();

    expect(events.map((event) => event.type)).toEqual([
      "registered",
      "registered",
      "navigated",
    ]);
    expect(events.at(-1)).toMatchObject({
      frameRef: parent.frameRef,
      invalidated: [identityOf(child)],
    });
    expect(childFrame.loadListenerCount).toBe(0);
  });

  it("keeps a navigating parent inactive while descendant detachment re-enters its load listener", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 4,
      onLifecycle: (event) => events.push(event),
    });
    const oldParentDocument = createDocument();
    const nextParentDocument = createDocument();
    const parentFrame = createFrame({ document: oldParentDocument });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childDocument = createDocument();
    const childFrame = createFrame({
      document: childDocument,
      onRemoveLoadListener: () => parentFrame.dispatchLoad(),
    });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    parentFrame.setDocument(nextParentDocument);

    parentFrame.dispatchLoad();

    const currentParent = registry.getContext(parent.frameRef);
    expect(currentParent).toMatchObject({
      frameEpoch: 2,
      document: nextParentDocument,
    });
    expect(registry.getContextForDocument(oldParentDocument)).toBeUndefined();
    expect(registry.getContextForDocument(nextParentDocument)).toBe(currentParent);
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(registry.getContext(child.frameRef)).toBeUndefined();
    expect(childFrame.loadListenerCount).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "registered",
      "registered",
      "navigated",
    ]);
    expect(events.at(-1)).toMatchObject({
      frameRef: parent.frameRef,
      frameEpoch: 2,
      invalidated: [identityOf(child)],
    });
  });

  it("keeps a navigating frame inactive while guarded document inspection re-enters load", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event),
    });
    const frame = createFrame({ document: createDocument() });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const replacementDocument = createDocument();
    frame.setDocument(replacementDocument);
    frame.setContentDocumentReadCallback(() => frame.dispatchLoad());

    frame.dispatchLoad();

    expect(registry.getContext(description.frameRef)).toMatchObject({
      frameEpoch: 2,
      document: replacementDocument,
    });
    expect(events.map((event) => event.type)).toEqual([
      "registered",
      "navigated",
    ]);
    expect(events.at(-1)).toMatchObject({ frameEpoch: 2 });
  });

  it("keeps listener re-entry inert while resetting and disposing registries", () => {
    const resetEvents: FrameLifecycleEvent[] = [];
    const resetRegistry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => resetEvents.push(event),
    });
    const resetParentFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const resetParent = resetRegistry.describeFrame(resetParentFrame);
    if (resetParent?.kind !== "accessible") throw new Error("expected accessible frame");
    const resetChildFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    resetRegistry.describeFrame(resetChildFrame, resetParent.frameRef);

    resetRegistry.resetTopDocument(createDocument(), 1);

    expect(resetEvents.map((event) => event.type)).toEqual([
      "registered",
      "registered",
      "reset",
    ]);
    expect(resetParentFrame.loadListenerCount).toBe(0);
    expect(resetChildFrame.loadListenerCount).toBe(0);

    const disposeEvents: FrameLifecycleEvent[] = [];
    const disposeRegistry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => disposeEvents.push(event),
    });
    const disposeFrame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    disposeRegistry.describeFrame(disposeFrame);

    disposeRegistry.dispose();

    expect(disposeEvents.map((event) => event.type)).toEqual(["registered"]);
    expect(disposeFrame.loadListenerCount).toBe(0);
  });

  it("gates public operations while reset detaches hostile listeners", () => {
    const initialTopDocument = createDocument();
    const requestedTopDocument = createDocument();
    const rogueTopDocument = createDocument();
    const events: FrameLifecycleEvent[] = [];
    const intruderFrame = createFrame({ document: createDocument() });
    let nestedResetResult: boolean | undefined;
    let nestedRegistration: unknown;
    let observedTop: unknown;
    let observedTopLookup: unknown;
    let observedDocumentLookup: unknown;
    let observedContexts: readonly object[] | undefined;
    let observedTranslation: unknown;
    let observedUnregister: readonly object[] | undefined;
    let registry!: FrameRegistry;
    let initialTop!: NonNullable<FrameRegistry["topContext"]>;
    const frame = createFrame({
      document: createDocument(),
      onRemoveLoadListener: () => {
        observedTop = registry.topContext;
        observedTopLookup = registry.getContext(initialTop.frameRef);
        observedDocumentLookup = registry.getContextForDocument(initialTopDocument);
        observedContexts = registry.accessibleContexts();
        observedTranslation = registry.toTopViewport(initialTop, {
          x: 1,
          y: 2,
          width: 3,
          height: 4,
        });
        observedUnregister = registry.unregisterFrame(frame);
        nestedResetResult = registry.resetTopDocument(rogueTopDocument, 99);
        nestedRegistration = registry.registerChildFrame(intruderFrame);
      },
    });
    registry = new FrameRegistry(initialTopDocument, {
      documentEpoch: 1,
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    initialTop = registry.topContext!;
    registry.describeFrame(frame);

    expect(registry.resetTopDocument(requestedTopDocument, 2)).toBe(true);

    expect(observedTop).toBeUndefined();
    expect(observedTopLookup).toBeUndefined();
    expect(observedDocumentLookup).toBeUndefined();
    expect(observedContexts).toEqual([]);
    expect(Object.isFrozen(observedContexts)).toBe(true);
    expect(observedTranslation).toBeUndefined();
    expect(observedUnregister).toEqual([]);
    expect(Object.isFrozen(observedUnregister)).toBe(true);
    expect(nestedResetResult).toBe(false);
    expect(nestedRegistration).toBeUndefined();
    expect(intruderFrame.loadListenerCount).toBe(0);
    expect(frame.loadListenerCount).toBe(0);
    expect(registry.topContext).toMatchObject({
      document: requestedTopDocument,
      documentEpoch: 2,
    });
    expect(registry.accessibleContexts()).toEqual([registry.topContext]);
    expect(events.map((event) => event.type)).toEqual(["registered", "reset"]);
    expect(registry.describeFrame(createFrame({ document: createDocument() }))).toMatchObject({
      kind: "accessible",
    });
  });

  it("stays disposed when hostile listener removal attempts reset and registration", () => {
    const events: FrameLifecycleEvent[] = [];
    const intruderFrame = createFrame({ document: createDocument() });
    let nestedResetResult: boolean | undefined;
    let nestedRegistration: unknown;
    let registry!: FrameRegistry;
    const frame = createFrame({
      document: createDocument(),
      onRemoveLoadListener: () => {
        nestedResetResult = registry.resetTopDocument(createDocument(), 1);
        nestedRegistration = registry.registerChildFrame(intruderFrame);
      },
    });
    registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    registry.describeFrame(frame);

    registry.dispose();

    expect(nestedResetResult).toBe(false);
    expect(nestedRegistration).toBeUndefined();
    expect(intruderFrame.loadListenerCount).toBe(0);
    expect(frame.loadListenerCount).toBe(0);
    expect(registry.topContext).toBeUndefined();
    expect(registry.accessibleContexts()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["registered"]);
  });

  it("blocks add-listener re-entry from committing a duplicate registration", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event),
    });
    const nestedFrame = createFrame({ document: createDocument() });
    let nestedRegistration: unknown;
    let observedTop: unknown;
    const frame = createFrame({
      document: createDocument(),
      onAddLoadListener: () => {
        observedTop = registry.topContext;
        nestedRegistration = registry.describeFrame(nestedFrame);
      },
    });

    const description = registry.describeFrame(frame);

    expect(description).toMatchObject({ kind: "accessible", frameRef: "frame-2" });
    expect(observedTop).toBeUndefined();
    expect(nestedRegistration).toBeUndefined();
    expect(nestedFrame.loadListenerCount).toBe(0);
    expect(frame.loadListenerCount).toBe(1);
    expect(registry.accessibleContexts()).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["registered"]);
  });

  it.each([
    ["different accessible document", (frame: FakeFrame, next: Document) => frame.setDocument(next)],
    ["inaccessible document", (frame: FakeFrame, _next: Document) => frame.setDocument(null)],
    ["hostile document getter", (frame: FakeFrame, _next: Document) => (
      frame.setContentDocumentError(new Error("hostile post-listener access"))
    )],
  ] as const)(
    "rejects a frame whose %s changes while installing its listener",
    (_label, mutate) => {
      const events: string[] = [];
      const registry = new FrameRegistry(createDocument(), {
        maxFrames: 3,
        onLifecycle: (event) => events.push(event.type),
      });
      let frame!: FakeFrame & HTMLIFrameElement;
      frame = createFrame({
        document: createDocument(),
        onAddLoadListener: () => mutate(frame, createDocument()),
      });

      expect(registry.describeFrame(frame)).toBeUndefined();
      expect(frame.loadListenerCount).toBe(0);
      expect(registry.accessibleContexts()).toHaveLength(1);
      expect(events).toEqual([]);
      expect(registry.describeFrame(createFrame({ document: createDocument() })))
        .toMatchObject({ frameRef: "frame-2" });
    },
  );

  it("blocks registration while unregister detaches a hostile listener", () => {
    const events: FrameLifecycleEvent[] = [];
    const intruderFrame = createFrame({ document: createDocument() });
    let nestedRegistration: unknown;
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const frame = createFrame({
      document: createDocument(),
      onRemoveLoadListener: () => {
        nestedRegistration = registry.describeFrame(intruderFrame);
      },
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    registry.unregisterFrame(frame);

    expect(nestedRegistration).toBeUndefined();
    expect(intruderFrame.loadListenerCount).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["registered", "removed"]);
    expect(registry.describeFrame(intruderFrame)).toMatchObject({ kind: "accessible" });
  });

  it("blocks nested reset and registration during navigation descendant cleanup", () => {
    const events: FrameLifecycleEvent[] = [];
    const rogueTopDocument = createDocument();
    const intruderFrame = createFrame({ document: createDocument() });
    let nestedResetResult: boolean | undefined;
    let nestedRegistration: unknown;
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 4,
      onLifecycle: (event) => events.push(event),
    });
    const nextParentDocument = createDocument();
    const parentFrame = createFrame({ document: createDocument() });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childFrame = createFrame({
      document: createDocument(),
      onRemoveLoadListener: () => {
        nestedResetResult = registry.resetTopDocument(rogueTopDocument, 99);
        nestedRegistration = registry.describeFrame(intruderFrame);
      },
    });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    parentFrame.setDocument(nextParentDocument);

    parentFrame.dispatchLoad();

    expect(nestedResetResult).toBe(false);
    expect(nestedRegistration).toBeUndefined();
    expect(intruderFrame.loadListenerCount).toBe(0);
    expect(childFrame.loadListenerCount).toBe(0);
    expect(registry.getContext(child.frameRef)).toBeUndefined();
    expect(registry.getContext(parent.frameRef)).toMatchObject({
      frameEpoch: 2,
      document: nextParentDocument,
    });
    expect(registry.topContext).toMatchObject({ documentEpoch: 0 });
    expect(events.map((event) => event.type)).toEqual([
      "registered",
      "registered",
      "navigated",
    ]);
  });

  it("includes removed descendants in the parent navigation event", () => {
    const events: Array<{ type: string; invalidated?: readonly object[] }> = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 4,
      onLifecycle: (event) => events.push(event),
    });
    const parentFrame = createFrame({ document: createDocument() });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible frame");
    const childFrame = createFrame({ document: createDocument() });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    const eventCount = events.length;
    parentFrame.setDocument(createDocument());

    parentFrame.dispatchLoad();

    expect(events).toHaveLength(eventCount + 1);
    expect(events.at(-1)).toMatchObject({
      type: "navigated",
      frameRef: parent.frameRef,
      invalidated: [identityOf(child)],
    });
    expect(Object.isFrozen(events.at(-1)?.invalidated)).toBe(true);
  });

  it("rolls registration back when structural access or listener installation fails", () => {
    const events: string[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event.type),
    });
    const listenerFailure = createFrame({
      document: createDocument(),
      addListenerError: new Error("listener failed"),
    });
    expect(registry.describeFrame(listenerFailure)).toBeUndefined();
    expect(listenerFailure.loadListenerCount).toBe(0);
    expect(events).toEqual([]);

    const hostileMethods = createFrame({ document: createDocument() });
    Object.defineProperty(hostileMethods, "addEventListener", {
      get: () => {
        throw new Error("hostile method getter");
      },
    });
    expect(registry.describeFrame(hostileMethods)).toBeUndefined();
    expect(events).toEqual([]);

    const valid = registry.describeFrame(createFrame({ document: createDocument() }));
    expect(valid).toMatchObject({ kind: "accessible", frameRef: "frame-2" });
  });

  it("cleans every map when listener removal throws", () => {
    const events: string[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event.type),
    });
    const document = createDocument();
    const frame = createFrame({
      document,
      removeListenerError: new Error("remove failed"),
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(() => registry.unregisterFrame(frame)).not.toThrow();
    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(document)).toBeUndefined();
    const eventCount = events.length;
    frame.dispatchLoad();
    expect(events).toHaveLength(eventCount);
    expect(registry.describeFrame(createFrame({ document: createDocument() }))).toBeDefined();
  });

  it("retires a failed registration ref when its load callback cannot be removed", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => events.push(event),
    });
    const leakedFrame = createFrame({
      document: createDocument(),
      addListenerError: new Error("add failed after retaining listener"),
      removeListenerError: new Error("listener retained"),
    });

    expect(registry.describeFrame(leakedFrame)).toBeUndefined();
    expect(leakedFrame.loadListenerCount).toBe(1);

    const replacementFrame = createFrame({ document: createDocument() });
    const replacement = registry.describeFrame(replacementFrame);
    expect(replacement).toMatchObject({ kind: "accessible", frameRef: "frame-3" });
    if (replacement?.kind !== "accessible") throw new Error("expected accessible frame");
    const eventCount = events.length;
    const replacementReads = replacementFrame.contentDocumentReads;

    leakedFrame.invokeSavedLoadListener();

    expect(events).toHaveLength(eventCount);
    expect(registry.getContext(replacement.frameRef)).toMatchObject({ frameEpoch: 1 });
    expect(replacementFrame.contentDocumentReads).toBe(replacementReads + 1);
  });

  it("uses a weak registry keyed load callback that stays inert when hostile removal leaks it", () => {
    const originalWeakRef = globalThis.WeakRef;
    const weakTargets: object[] = [];
    class TrackingWeakRef<T extends object> {
      private readonly target: T;

      public constructor(target: T) {
        weakTargets.push(target);
        this.target = target;
      }

      public deref(): T | undefined {
        return this.target;
      }
    }
    (globalThis as { WeakRef: typeof WeakRef }).WeakRef =
      TrackingWeakRef as unknown as typeof WeakRef;
    try {
      const events: FrameLifecycleEvent[] = [];
      const registry = new FrameRegistry(createDocument(), {
        maxFrames: 2,
        onLifecycle: (event) => events.push(event),
      });
      const oldDocument = createDocument();
      const frame = createFrame({
        document: oldDocument,
        removeListenerError: new Error("listener retained"),
      });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");
      const savedListenerSource = frame.savedLoadListenerSource;

      expect(weakTargets).toEqual([registry]);
      expect(savedListenerSource).toContain("deref");
      expect(savedListenerSource).toContain("handleLoadByRef");
      expect(savedListenerSource).not.toContain("this");
      expect(savedListenerSource).not.toContain("record");
      expect(savedListenerSource).not.toContain("frameElement");
      expect(savedListenerSource).not.toContain("document");

      registry.unregisterFrame(frame);
      const eventCount = events.length;
      const contentDocumentReads = frame.contentDocumentReads;

      frame.invokeSavedLoadListener();

      expect(events).toHaveLength(eventCount);
      expect(events.map((event) => event.type)).toEqual(["registered", "removed"]);
      expect(frame.contentDocumentReads).toBe(contentDocumentReads);
      expect(registry.getContext(description.frameRef)).toBeUndefined();
      expect(registry.getContextForDocument(oldDocument)).toBeUndefined();
      expect(registry.accessibleContexts()).toEqual([registry.topContext]);

      const replacement = registry.describeFrame(
        createFrame({ document: createDocument() }),
      );
      if (replacement?.kind !== "accessible") throw new Error("expected accessible frame");
      const replacementEventCount = events.length;

      frame.invokeSavedLoadListener();

      expect(events).toHaveLength(replacementEventCount);
      expect(registry.getContext(replacement.frameRef)).toMatchObject({
        frameEpoch: 1,
      });
    } finally {
      (globalThis as { WeakRef: typeof WeakRef }).WeakRef = originalWeakRef;
    }
  });

  it("keeps hostile leaked callbacks inert after top reset and disposal", () => {
    const resetEvents: string[] = [];
    const oldDocument = createDocument();
    const resetRegistry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => resetEvents.push(event.type),
    });
    const resetFrame = createFrame({
      document: oldDocument,
      removeListenerError: new Error("listener retained"),
    });
    const resetDescription = resetRegistry.describeFrame(resetFrame);
    if (resetDescription?.kind !== "accessible") throw new Error("expected accessible frame");
    resetRegistry.resetTopDocument(createDocument(), 1);
    const resetEventCount = resetEvents.length;

    resetFrame.invokeSavedLoadListener();

    expect(resetEvents).toHaveLength(resetEventCount);
    expect(resetEvents).toEqual(["registered", "reset"]);
    expect(resetRegistry.getContext(resetDescription.frameRef)).toBeUndefined();
    expect(resetRegistry.getContextForDocument(oldDocument)).toBeUndefined();

    const disposeEvents: string[] = [];
    const disposeRegistry = new FrameRegistry(createDocument(), {
      maxFrames: 2,
      onLifecycle: (event) => disposeEvents.push(event.type),
    });
    const disposeFrame = createFrame({
      document: createDocument(),
      removeListenerError: new Error("listener retained"),
    });
    disposeRegistry.describeFrame(disposeFrame);
    disposeRegistry.dispose();
    const disposeEventCount = disposeEvents.length;

    disposeFrame.invokeSavedLoadListener();

    expect(disposeEvents).toHaveLength(disposeEventCount);
    expect(disposeEvents).toEqual(["registered"]);
    expect(disposeRegistry.topContext).toBeUndefined();
    expect(disposeRegistry.accessibleContexts()).toEqual([]);
  });

  it("changes accessibility on load with one guarded inspection and one lifecycle result", () => {
    const events: string[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      onLifecycle: (event) => events.push(`${event.type}:${event.accessible}`),
    });
    const frame = createFrame({ document: createDocument() });
    const first = registry.describeFrame(frame);
    if (first?.kind !== "accessible") throw new Error("expected accessible frame");
    frame.setContentDocumentError(new Error("cross-origin"));

    frame.dispatchLoad();

    expect(registry.describeFrame(frame)).toMatchObject({ kind: "inaccessible", frameRef: first.frameRef });
    expect(frame.contentDocumentReads).toBe(3);
    expect(frame.contentWindowReads).toBe(2);
    frame.setContentDocumentError(undefined);
    const replacementDocument = createDocument();
    frame.setDocument(replacementDocument);

    frame.dispatchLoad();

    expect(registry.describeFrame(frame)).toMatchObject({
      kind: "accessible",
      frameRef: first.frameRef,
      document: replacementDocument,
    });
    expect(frame.contentDocumentReads).toBe(5);
    expect(frame.contentWindowReads).toBe(4);
    expect(events).toEqual(["registered:true", "navigated:false", "navigated:true"]);
  });

  it("rejects a stale frame identity after navigation but accepts the replacement context", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const frame = createFrame({ document: createDocument(), left: 10, top: 20 });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const stale = registry.getContext(description.frameRef)!;
    frame.setDocument(createDocument());
    frame.dispatchLoad();
    const current = registry.getContext(description.frameRef)!;

    expect(registry.toTopViewport(stale, { x: 1, y: 2, width: 3, height: 4 })).toBeUndefined();
    expect(registry.toTopViewport(current, { x: 1, y: 2, width: 3, height: 4 })).toMatchObject({ x: 11, y: 22 });
  });

  it("drops a frame on configured epoch exhaustion without reusing its context", () => {
    const events: FrameLifecycleEvent[] = [];
    const registry = new FrameRegistry(createDocument(), {
      maxFrames: 3,
      maxFrameEpoch: 1,
      onLifecycle: (event) => events.push(event),
    });
    const frame = createFrame({
      document: createDocument(),
      invokeLoadOnRemove: true,
    });
    const first = registry.describeFrame(frame);
    if (first?.kind !== "accessible") throw new Error("expected accessible frame");
    frame.setDocument(createDocument());

    frame.dispatchLoad();

    expect(frame.loadListenerCount).toBe(0);
    expect(registry.getContext(first.frameRef)).toBeUndefined();
    expect(registry.describeFrame(frame)).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["registered", "invalidated"]);
    expect(events.at(-1)).toMatchObject({
      frameRef: first.frameRef,
      frameEpoch: first.frameEpoch,
      invalidated: [identityOf(first)],
    });
  });

  it("validates identity geometry and returns a fresh frozen top rectangle", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const frame = createFrame({ document: createDocument(), left: 10, top: 20 });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const context = registry.getContext(description.frameRef)!;
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const first = registry.toTopViewport(context, rect);
    const second = registry.toTopViewport(context, rect);

    expect(first).toEqual({ x: 11, y: 22, width: 3, height: 4, left: 11, top: 22, right: 14, bottom: 26 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).not.toBe(first);
    expect(registry.toTopViewport(context, { ...rect, width: -1 })).toBeUndefined();
    expect(registry.toTopViewport(context, { ...rect, x: Number.MAX_VALUE, width: Number.MAX_VALUE })).toBeUndefined();
    frame.setOffset(Number.MAX_VALUE, 0);
    expect(registry.toTopViewport(context, { ...rect, x: Number.MAX_VALUE })).toBeUndefined();
  });

  it.each([
    ["scaled frame", { transform: "matrix(2, 0, 0, 2, 0, 0)" }],
    ["rotated frame", { transform: "matrix(0.98, 0.17, -0.17, 0.98, 0, 0)" }],
    ["skewed frame", { transform: "matrix(1, 0, 0.2, 1, 0, 0)" }],
    ["CSS-zoomed frame", { zoom: "1.25" }],
    [
      "transformed ancestor",
      { parentElement: new FakeStyleElement({ transform: "matrix(1.5, 0, 0, 1.5, 0, 0)" }) },
    ],
    ["aggregate dimension mismatch", { width: 20, offsetWidth: 10 }],
    ["unverifiable style environment", { geometryUnavailable: true }],
  ] satisfies ReadonlyArray<readonly [string, FrameOptions]>) (
    "rejects knowingly unsafe translated geometry for a %s",
    (_label, options) => {
      const frame = createFrame({ document: createDocument(), left: 10, top: 20, ...options });
      const registry = new FrameRegistry(frame.ownerDocument, { maxFrames: 3 });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");

      expect(
        registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
      ).toBeUndefined();
    },
  );

  it("accepts neutral individual transform properties", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const frame = createFrame({
      document: createDocument(),
      left: 10,
      top: 20,
      translate: "0px 0% 0px",
      rotate: "z 0deg",
      scale: "1 100% 1.0",
      perspective: "none",
      offsetPath: "none",
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
    ).toMatchObject({ x: 11, y: 22 });
  });

  it.each([
    ["translate", { translate: "1px 0px" }],
    ["rotate", { rotate: "10deg" }],
    ["scale", { scale: "1.1" }],
    ["offset path", { offsetPath: "path(\"M 0 0 L 10 10\")" }],
    ["legacy motion path", { motionPath: "path(\"M 0 0 L 10 10\")" }],
  ] satisfies ReadonlyArray<readonly [string, FrameOptions]>) (
    "rejects a non-neutral individual frame %s",
    (_label, options) => {
      const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
      const frame = createFrame({ document: createDocument(), ...options });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");

      expect(
        registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
      ).toBeUndefined();
    },
  );

  it("rejects perspective on an ordinary composed ancestor", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const ancestor = new FakeStyleElement({ perspective: "600px" });
    const frame = createFrame({ document: createDocument(), parentElement: ancestor });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
    ).toBeUndefined();
  });

  it.each([
    ["transform", { transform: "matrix(1, 0, 0, 1, 5, 0)" }],
    ["individual rotate", { rotate: "15deg" }],
  ] satisfies ReadonlyArray<readonly [string, FakeStyleOptions]>) (
    "rejects a shadow host %s even when frame dimensions still match",
    (_label, hostStyle) => {
      const ownerDocument = createGeometryDocument();
      const registry = new FrameRegistry(ownerDocument, { maxFrames: 3 });
      const host = new FakeStyleElement({ ...hostStyle, rootNode: ownerDocument });
      const shadowRoot = { mode: "open", host };
      const frame = createFrame({
        document: createDocument(),
        ownerDocument,
        rootNode: shadowRoot,
        width: 10,
        offsetWidth: 10,
      });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");

      expect(
        registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
      ).toBeUndefined();
    },
  );

  it("accepts a light-DOM frame through a neutral assigned slot and shadow ancestry", () => {
    const ownerDocument = createGeometryDocument();
    const registry = new FrameRegistry(ownerDocument, { maxFrames: 3 });
    const host = new FakeStyleElement({ rootNode: ownerDocument });
    const shadowRoot = { mode: "open", host };
    const shadowAncestor = new FakeStyleElement({ rootNode: shadowRoot });
    const slot = new FakeStyleElement({
      parentElement: shadowAncestor,
      rootNode: shadowRoot,
    });
    const frame = createFrame({
      document: createDocument(),
      ownerDocument,
      rootNode: ownerDocument,
      parentElement: host,
      assignedSlot: slot,
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
    ).toMatchObject({ x: 1, y: 2 });
  });

  it.each([
    ["slot transform", { transform: "matrix(1, 0, 0, 1, 5, 0)" }, {}],
    ["slot rotate", { rotate: "15deg" }, {}],
    ["shadow ancestor scale", {}, { scale: "1.2" }],
  ] satisfies ReadonlyArray<
    readonly [string, FakeStyleOptions, FakeStyleOptions]
  >) (
    "rejects a slotted frame with a non-neutral %s",
    (_label, slotStyle, ancestorStyle) => {
      const ownerDocument = createGeometryDocument();
      const registry = new FrameRegistry(ownerDocument, { maxFrames: 3 });
      const host = new FakeStyleElement({ rootNode: ownerDocument });
      const shadowRoot = { mode: "open", host };
      const shadowAncestor = new FakeStyleElement({
        ...ancestorStyle,
        rootNode: shadowRoot,
      });
      const slot = new FakeStyleElement({
        ...slotStyle,
        parentElement: shadowAncestor,
        rootNode: shadowRoot,
      });
      const frame = createFrame({
        document: createDocument(),
        ownerDocument,
        rootNode: ownerDocument,
        parentElement: host,
        assignedSlot: slot,
        width: 10,
        offsetWidth: 10,
      });
      const description = registry.describeFrame(frame);
      if (description?.kind !== "accessible") throw new Error("expected accessible frame");

      expect(
        registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }),
      ).toBeUndefined();
    },
  );

  it("fails geometry closed when assignedSlot access throws", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const frame = createFrame({
      document: createDocument(),
      assignedSlotError: new Error("assigned slot failed"),
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined();
  });

  it("fails geometry closed on an assignedSlot cycle", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const cyclicSlot = new FakeStyleElement();
    cyclicSlot.setAssignedSlot(cyclicSlot);
    const frame = createFrame({
      document: createDocument(),
      assignedSlot: cyclicSlot,
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined();
  });

  it("fails geometry closed when composed root access throws", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const throwingRootFrame = createFrame({
      document: createDocument(),
      getRootNodeError: new Error("root failed"),
    });
    const throwingRootDescription = registry.describeFrame(throwingRootFrame);
    if (throwingRootDescription?.kind !== "accessible") {
      throw new Error("expected accessible frame");
    }
    expect(
      registry.toTopViewport(throwingRootDescription, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined();
  });

  it("fails geometry closed when an open shadow root host getter throws", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const hostileShadowRoot = { mode: "open" };
    Object.defineProperty(hostileShadowRoot, "host", {
      get: () => {
        throw new Error("host failed");
      },
    });
    const hostileHostFrame = createFrame({
      document: createDocument(),
      rootNode: hostileShadowRoot,
    });
    const hostileHostDescription = registry.describeFrame(hostileHostFrame);
    if (hostileHostDescription?.kind !== "accessible") {
      throw new Error("expected accessible frame");
    }

    expect(
      registry.toTopViewport(hostileHostDescription, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined();
  });

  it("fails geometry closed on a composed ancestry cycle", () => {
    const registry = new FrameRegistry(createDocument(), { maxFrames: 3 });
    const cyclicShadowRoot: { mode: "open"; host?: object } = { mode: "open" };
    const frame = createFrame({
      document: createDocument(),
      rootNode: cyclicShadowRoot,
    });
    cyclicShadowRoot.host = frame;
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    expect(
      registry.toTopViewport(description, { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeUndefined();
  });

  it("rejects invalid public inputs and makes every operation fail closed after disposal", () => {
    expect(() => new FrameRegistry(createDocument(), { maxFrames: 0 })).toThrow();
    expect(() => new FrameRegistry(createDocument(), { documentEpoch: -1 })).toThrow();
    expect(() => new FrameRegistry(createDocument(), { maxFrameEpoch: 0 })).toThrow();
    const topDocument = createDocument();
    const events: string[] = [];
    const registry = new FrameRegistry(topDocument, {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event.type),
    });
    expect(registry.registerChildFrame(null as unknown as HTMLIFrameElement)).toBeUndefined();
    const childDocument = createDocument();
    const frame = createFrame({ document: childDocument });
    const child = registry.describeFrame(frame);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    expect(registry.getContextForDocument(childDocument)).toMatchObject({ frameRef: child.frameRef });
    const eventCount = events.length;

    registry.dispose();

    expect(eventCount).toBe(1);
    expect(frame.loadListenerCount).toBe(0);
    expect(registry.topContext).toBeUndefined();
    expect(registry.getContext(child.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(topDocument)).toBeUndefined();
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(registry.accessibleContexts()).toEqual([]);
    expect(Object.isFrozen(registry.accessibleContexts())).toBe(true);
    expect(registry.registerChildFrame(frame)).toBeUndefined();
    expect(registry.describeFrame(frame)).toBeUndefined();
    expect(registry.toTopViewport(child, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(registry.resetTopDocument(createDocument(), 2)).toBe(false);
    frame.dispatchLoad();
    expect(events).toHaveLength(eventCount);
  });

  it("invalidates top identities on reset and starts the next document at epoch one", () => {
    const registry = new FrameRegistry(createDocument(), { documentEpoch: 2, maxFrames: 3 });
    const staleTop = registry.topContext!;

    expect(registry.resetTopDocument(createDocument(), 3)).toBe(true);

    const currentTop = registry.topContext!;
    expect(currentTop.frameEpoch).toBe(1);
    expect(registry.toTopViewport(staleTop, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(registry.toTopViewport(currentTop, { x: 0, y: 0, width: 1, height: 1 })).toBeDefined();
  });

  it("rejects non-increasing and invalid top document epochs without mutating live state", () => {
    const events: string[] = [];
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, {
      documentEpoch: 5,
      maxFrames: 3,
      onLifecycle: (event) => events.push(event.type),
    });
    const childDocument = createDocument();
    const childFrame = createFrame({ document: childDocument });
    const child = registry.describeFrame(childFrame);
    if (child?.kind !== "accessible") throw new Error("expected accessible frame");
    const initialTop = registry.topContext!;
    const initialEventCount = events.length;

    for (const invalidEpoch of [5, 4, -1, 5.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => registry.resetTopDocument(createDocument(), invalidEpoch)).toThrow(RangeError);
      expect(registry.topContext).toBe(initialTop);
      expect(registry.getContextForDocument(topDocument)).toBe(initialTop);
      expect(registry.getContextForDocument(childDocument)).toMatchObject({ frameRef: child.frameRef });
      expect(childFrame.loadListenerCount).toBe(1);
      expect(registry.toTopViewport(initialTop, { x: 0, y: 0, width: 1, height: 1 })).toBeDefined();
      expect(events).toHaveLength(initialEventCount);
    }

    expect(registry.resetTopDocument(createDocument(), 6)).toBe(true);
    const currentTop = registry.topContext!;
    expect(registry.toTopViewport(initialTop, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(() => registry.resetTopDocument(createDocument(), 5)).toThrow(RangeError);
    expect(registry.topContext).toBe(currentTop);
  });

  it("authorizes exact frame hosts only from their owning registered parent context", () => {
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, { maxFrames: 4 });
    const parentDocument = createDocument();
    const parent = createFrame({ document: parentDocument, ownerDocument: topDocument });
    const parentDescription = registry.describeFrame(parent);
    if (parentDescription?.kind !== "accessible") throw new Error("expected parent");
    const child = createFrame({ document: createDocument(), ownerDocument: parentDocument });

    expect(registry.authorizeExactFrameElement(child, parentDescription.frameRef))
      .toMatchObject({ kind: "accessible", parentFrameRef: parentDescription.frameRef });
    expect(registry.authorizeExactFrameElement(child, registry.topContext!.frameRef))
      .toBeUndefined();

    const moved = createFrame({ document: createDocument(), ownerDocument: topDocument });
    expect(registry.authorizeExactFrameElement(moved, parentDescription.frameRef))
      .toBeUndefined();
  });

  it("rejects describeFrame hosts with a wrong owner or existing parent", () => {
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, { maxFrames: 4 });
    const wrongOwner = createFrame({
      document: createDocument(),
      ownerDocument: createDocument(),
    });
    expect(registry.describeFrame(wrongOwner)).toBeUndefined();

    const parentDocument = createDocument();
    const parent = createFrame({ document: parentDocument, ownerDocument: topDocument });
    const parentDescription = registry.describeFrame(parent);
    if (parentDescription?.kind !== "accessible") throw new Error("expected parent");
    const child = createFrame({ document: createDocument(), ownerDocument: parentDocument });
    expect(registry.describeFrame(child, parentDescription.frameRef)).toBeDefined();
    expect(registry.describeFrame(child, registry.topContext!.frameRef)).toBeUndefined();
  });

  it("does not return cached contexts after live frame access becomes stale", () => {
    const topDocument = createDocument();
    const childDocument = createDocument();
    const replacementDocument = createDocument();
    const events: string[] = [];
    const registry = new FrameRegistry(topDocument, {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event.type),
    });
    const frame = createFrame({ document: childDocument, ownerDocument: topDocument });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");
    const eventCount = events.length;

    frame.setDocument(replacementDocument);
    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(registry.getContextForFrameElement(frame, registry.topContext!.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(registry.describeFrame(frame)).toBeUndefined();
    expect(registry.authorizeExactFrameElement(frame, registry.topContext!.frameRef))
      .toBeUndefined();

    frame.setDocument(childDocument);
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => ({ document: childDocument }),
    });
    expect(registry.getContextForFrameElement(frame, registry.topContext!.frameRef)).toBeUndefined();
    delete (frame as unknown as { contentWindow?: unknown }).contentWindow;

    frame.setContentDocumentError(new Error("hostile frame access"));
    expect(registry.getContext(description.frameRef)).toBeUndefined();
    expect(registry.getContextForDocument(childDocument)).toBeUndefined();
    expect(registry.describeFrame(frame)).toBeUndefined();
    expect(registry.authorizeExactFrameElement(frame, registry.topContext!.frameRef))
      .toBeUndefined();
    expect(events).toHaveLength(eventCount);
    expect(frame.loadListenerCount).toBe(1);
    frame.setContentDocumentError(undefined);
    expect(registry.getContextForFrameElement(frame, registry.topContext!.frameRef))
      .toMatchObject({ frameRef: description.frameRef, document: childDocument });
  });

  it("keeps existing inaccessible exact frame authority without live document access", () => {
    const topDocument = createDocument();
    const registry = new FrameRegistry(topDocument, { maxFrames: 3 });
    const frame = createFrame({ document: null, ownerDocument: topDocument });
    const locked = registry.describeFrame(frame);

    expect(locked).toMatchObject({ kind: "inaccessible", locked: true });
    expect(registry.authorizeExactFrameElement(frame, registry.topContext!.frameRef))
      .toMatchObject({ kind: "inaccessible", frameRef: locked!.frameRef });
    expect(registry.describeFrame(frame)).toMatchObject({
      kind: "inaccessible",
      frameRef: locked!.frameRef,
    });
  });

  it("rejects direct viewport geometry after a silent frame navigation", () => {
    const topDocument = createDocument();
    const childDocument = createDocument();
    const events: string[] = [];
    const registry = new FrameRegistry(topDocument, {
      maxFrames: 3,
      onLifecycle: (event) => events.push(event.type),
    });
    const frame = createFrame({
      document: childDocument,
      ownerDocument: topDocument,
      left: 10,
      top: 20,
    });
    const description = registry.describeFrame(frame);
    if (description?.kind !== "accessible") throw new Error("expected accessible frame");

    frame.setDocument(createDocument());

    expect(registry.toTopViewport(description, { x: 1, y: 2, width: 3, height: 4 }))
      .toBeUndefined();
    expect(events).toEqual(["registered"]);
  });

  it("rejects nested viewport geometry after a silent ancestor navigation", () => {
    const topDocument = createDocument();
    const parentDocument = createDocument();
    const registry = new FrameRegistry(topDocument, { maxFrames: 4 });
    const parentFrame = createFrame({
      document: parentDocument,
      ownerDocument: topDocument,
      left: 10,
      top: 20,
    });
    const parent = registry.describeFrame(parentFrame);
    if (parent?.kind !== "accessible") throw new Error("expected accessible parent");
    const childFrame = createFrame({
      document: createDocument(),
      ownerDocument: parentDocument,
      left: 3,
      top: 4,
    });
    const child = registry.describeFrame(childFrame, parent.frameRef);
    if (child?.kind !== "accessible") throw new Error("expected accessible child");

    parentFrame.setDocument(createDocument());

    expect(registry.toTopViewport(child, { x: 1, y: 2, width: 3, height: 4 }))
      .toBeUndefined();
  });
});

function createDocument(): Document {
  return createGeometryDocument();
}

type RectField = keyof ViewportRect;
type IdentityField = keyof FrameIdentity;

function createRectReadCounts(): Record<RectField, number> {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function createGetterRect(read: (field: RectField) => number): ViewportRect {
  return Object.defineProperties({}, {
    x: { get: () => read("x") },
    y: { get: () => read("y") },
    width: { get: () => read("width") },
    height: { get: () => read("height") },
  }) as ViewportRect;
}

function createIdentityReadCounts(): Record<IdentityField, number> {
  return { frameRef: 0, frameEpoch: 0, documentEpoch: 0 };
}

function identityValues(identity: FrameIdentity): Record<IdentityField, string | number> {
  return {
    frameRef: identity.frameRef,
    frameEpoch: identity.frameEpoch,
    documentEpoch: identity.documentEpoch,
  };
}

function createGetterIdentity(
  read: (field: IdentityField) => string | number,
): FrameIdentity {
  return Object.defineProperties({}, {
    frameRef: { get: () => read("frameRef") },
    frameEpoch: { get: () => read("frameEpoch") },
    documentEpoch: { get: () => read("documentEpoch") },
  }) as FrameIdentity;
}

function createGeometryDocument(onGetComputedStyle?: () => void): Document {
  return {
    defaultView: {
      getComputedStyle: (element: FakeFrame | FakeStyleElement) => {
        onGetComputedStyle?.();
        return {
          transform: element.computedTransform,
          zoom: element.computedZoom,
          translate: element.computedTranslate,
          rotate: element.computedRotate,
          scale: element.computedScale,
          perspective: element.computedPerspective,
          offsetPath: element.computedOffsetPath,
          motionPath: element.computedMotionPath,
        };
      },
    },
  } as unknown as Document;
}

interface FrameOptions {
  document?: Document | null;
  contentDocumentError?: Error;
  left?: number;
  top?: number;
  clientLeft?: number;
  clientTop?: number;
  addListenerError?: Error;
  onAddLoadListener?: () => void;
  removeListenerError?: Error;
  invokeLoadOnRemove?: boolean;
  onRemoveLoadListener?: () => void;
  width?: number;
  height?: number;
  offsetWidth?: number;
  offsetHeight?: number;
  transform?: string;
  zoom?: string;
  translate?: string;
  rotate?: string;
  scale?: string;
  perspective?: string;
  offsetPath?: string;
  motionPath?: string;
  parentElement?: FakeStyleElement;
  assignedSlot?: FakeStyleElement | null;
  assignedSlotError?: Error;
  ownerDocument?: Document;
  rootNode?: object;
  getRootNodeError?: Error;
  geometryUnavailable?: boolean;
  onGetBoundingClientRect?: () => void;
}

interface FakeStyleOptions {
  transform?: string;
  zoom?: string;
  translate?: string;
  rotate?: string;
  scale?: string;
  perspective?: string;
  offsetPath?: string;
  motionPath?: string;
  parentElement?: FakeStyleElement;
  assignedSlot?: FakeStyleElement | null;
  assignedSlotError?: Error;
  onAssignedSlotRead?: () => void;
  rootNode?: object;
}

class FakeStyleElement {
  public readonly computedTransform: string;
  public readonly computedZoom: string;
  public readonly computedTranslate: string;
  public readonly computedRotate: string;
  public readonly computedScale: string;
  public readonly computedPerspective: string;
  public readonly computedOffsetPath: string;
  public readonly computedMotionPath: string;
  public readonly parentElement: FakeStyleElement | null;
  private assignedSlotValue: FakeStyleElement | null;
  private readonly assignedSlotError: Error | undefined;
  private readonly onAssignedSlotRead: (() => void) | undefined;
  private rootNode: object | undefined;

  public constructor(options: FakeStyleOptions = {}) {
    this.computedTransform = options.transform ?? "none";
    this.computedZoom = options.zoom ?? "1";
    this.computedTranslate = options.translate ?? "none";
    this.computedRotate = options.rotate ?? "none";
    this.computedScale = options.scale ?? "none";
    this.computedPerspective = options.perspective ?? "none";
    this.computedOffsetPath = options.offsetPath ?? "none";
    this.computedMotionPath = options.motionPath ?? "none";
    this.parentElement = options.parentElement ?? null;
    this.assignedSlotValue = options.assignedSlot ?? null;
    this.assignedSlotError = options.assignedSlotError;
    this.onAssignedSlotRead = options.onAssignedSlotRead;
    this.rootNode = options.rootNode;
  }

  public get assignedSlot(): FakeStyleElement | null {
    if (this.assignedSlotError) throw this.assignedSlotError;
    this.onAssignedSlotRead?.();
    return this.assignedSlotValue;
  }

  public setAssignedSlot(assignedSlot: FakeStyleElement | null): void {
    this.assignedSlotValue = assignedSlot;
  }

  public attachToRoot(rootNode: object): void {
    this.rootNode ??= rootNode;
    this.parentElement?.attachToRoot(rootNode);
  }

  public getRootNode(): object {
    return this.rootNode ?? this;
  }
}

class FakeFrame {
  private document: Document | null;
  private readonly contentWindowValue: { document: Document | null };
  private contentDocumentError: Error | undefined;
  private readonly listeners = new Set<EventListener>();
  private readonly removingListeners = new Set<EventListener>();
  private savedLoadListener: EventListener | undefined;
  private left: number;
  private top: number;
  private readonly addListenerError: Error | undefined;
  private readonly onAddLoadListener: (() => void) | undefined;
  private readonly removeListenerError: Error | undefined;
  private readonly invokeLoadOnRemove: boolean;
  private readonly onRemoveLoadListener: (() => void) | undefined;
  private contentDocumentReadCallback: (() => void) | undefined;
  private contentWindowReadCallback: (() => void) | undefined;
  private readonly width: number;
  private readonly height: number;
  private rootNode: object;
  private readonly getRootNodeError: Error | undefined;
  private readonly onGetBoundingClientRect: (() => void) | undefined;
  public readonly clientLeft: number;
  public readonly clientTop: number;
  public readonly offsetWidth: number;
  public readonly offsetHeight: number;
  public readonly computedTransform: string;
  public readonly computedZoom: string;
  public readonly computedTranslate: string;
  public readonly computedRotate: string;
  public readonly computedScale: string;
  public readonly computedPerspective: string;
  public readonly computedOffsetPath: string;
  public readonly computedMotionPath: string;
  public readonly parentElement: FakeStyleElement | null;
  private readonly assignedSlotValue: FakeStyleElement | null;
  private readonly assignedSlotError: Error | undefined;
  public ownerDocument: Document;
  private readonly hasExplicitOwnerDocument: boolean;
  private readonly hasExplicitRootNode: boolean;
  public contentDocumentReads = 0;
  public contentWindowReads = 0;

  public constructor(options: FrameOptions) {
    this.document = options.document ?? null;
    this.contentWindowValue = { document: this.document };
    this.contentDocumentError = options.contentDocumentError;
    this.left = options.left ?? 0;
    this.top = options.top ?? 0;
    this.width = options.width ?? 10;
    this.height = options.height ?? 10;
    this.clientLeft = options.clientLeft ?? 0;
    this.clientTop = options.clientTop ?? 0;
    this.offsetWidth = options.offsetWidth ?? this.width;
    this.offsetHeight = options.offsetHeight ?? this.height;
    this.computedTransform = options.transform ?? "none";
    this.computedZoom = options.zoom ?? "1";
    this.computedTranslate = options.translate ?? "none";
    this.computedRotate = options.rotate ?? "none";
    this.computedScale = options.scale ?? "none";
    this.computedPerspective = options.perspective ?? "none";
    this.computedOffsetPath = options.offsetPath ?? "none";
    this.computedMotionPath = options.motionPath ?? "none";
    this.parentElement = options.parentElement ?? null;
    this.assignedSlotValue = options.assignedSlot ?? null;
    this.assignedSlotError = options.assignedSlotError;
    this.hasExplicitOwnerDocument = options.ownerDocument !== undefined || options.geometryUnavailable === true;
    this.ownerDocument = options.geometryUnavailable
      ? ({} as Document)
      : (options.ownerDocument ?? createGeometryDocument());
    this.hasExplicitRootNode = options.rootNode !== undefined;
    this.rootNode = options.rootNode ?? this.ownerDocument;
    this.getRootNodeError = options.getRootNodeError;
    this.onGetBoundingClientRect = options.onGetBoundingClientRect;
    this.parentElement?.attachToRoot(this.rootNode);
    this.addListenerError = options.addListenerError;
    this.onAddLoadListener = options.onAddLoadListener;
    this.removeListenerError = options.removeListenerError;
    this.invokeLoadOnRemove = options.invokeLoadOnRemove ?? false;
    this.onRemoveLoadListener = options.onRemoveLoadListener;
  }

  public assignDefaultOwnerDocument(ownerDocument: Document): void {
    if (this.hasExplicitOwnerDocument) return;
    this.ownerDocument = ownerDocument;
    if (!this.hasExplicitRootNode) {
      this.rootNode = ownerDocument;
      this.parentElement?.attachToRoot(ownerDocument);
    }
  }

  public get contentDocument(): Document | null {
    this.contentDocumentReads += 1;
    const callback = this.contentDocumentReadCallback;
    this.contentDocumentReadCallback = undefined;
    callback?.();
    if (this.contentDocumentError) throw this.contentDocumentError;
    return this.document;
  }

  public get contentWindow(): Window | null {
    this.contentWindowReads += 1;
    const callback = this.contentWindowReadCallback;
    this.contentWindowReadCallback = undefined;
    callback?.();
    return this.document ? (this.contentWindowValue as unknown as Window) : null;
  }

  public get assignedSlot(): FakeStyleElement | null {
    if (this.assignedSlotError) throw this.assignedSlotError;
    return this.assignedSlotValue;
  }

  public addEventListener(type: string, listener: EventListener): void {
    if (type === "load") {
      this.listeners.add(listener);
      this.savedLoadListener = listener;
      this.onAddLoadListener?.();
    }
    if (this.addListenerError) throw this.addListenerError;
  }

  public removeEventListener(type: string, listener: EventListener): void {
    if (this.removeListenerError) throw this.removeListenerError;
    if (type !== "load") return;
    this.onRemoveLoadListener?.();
    if (
      this.invokeLoadOnRemove &&
      this.listeners.has(listener) &&
      !this.removingListeners.has(listener)
    ) {
      this.removingListeners.add(listener);
      try {
        listener(new Event("load"));
      } finally {
        this.removingListeners.delete(listener);
      }
    }
    this.listeners.delete(listener);
    if (this.savedLoadListener === listener) {
      this.savedLoadListener = undefined;
    }
  }

  public getBoundingClientRect(): DOMRect {
    this.onGetBoundingClientRect?.();
    return {
      x: this.left,
      y: this.top,
      left: this.left,
      top: this.top,
      right: this.left + this.width,
      bottom: this.top + this.height,
      width: this.width,
      height: this.height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  public getRootNode(): object {
    if (this.getRootNodeError) throw this.getRootNodeError;
    return this.rootNode;
  }

  public setDocument(document: Document | null): void {
    this.document = document;
    this.contentWindowValue.document = document;
  }

  public setContentDocumentError(error: Error | undefined): void {
    this.contentDocumentError = error;
  }

  public setContentDocumentReadCallback(callback: (() => void) | undefined): void {
    this.contentDocumentReadCallback = callback;
  }

  public setContentWindowReadCallback(callback: (() => void) | undefined): void {
    this.contentWindowReadCallback = callback;
  }

  public setOffset(left: number, top: number): void {
    this.left = left;
    this.top = top;
  }

  public dispatchLoad(): void {
    for (const listener of [...this.listeners]) listener(new Event("load"));
  }

  public invokeSavedLoadListener(): void {
    this.savedLoadListener?.(new Event("load"));
  }

  public get savedLoadListenerSource(): string | undefined {
    return this.savedLoadListener?.toString();
  }

  public get loadListenerCount(): number {
    return this.listeners.size;
  }
}

function createFrame(options: FrameOptions): FakeFrame & HTMLIFrameElement {
  return new FakeFrame(options) as FakeFrame & HTMLIFrameElement;
}

function identityOf(description: {
  readonly frameRef: string;
  readonly frameEpoch: number;
  readonly documentEpoch: number;
}): object {
  return {
    frameRef: description.frameRef,
    frameEpoch: description.frameEpoch,
    documentEpoch: description.documentEpoch,
  };
}
