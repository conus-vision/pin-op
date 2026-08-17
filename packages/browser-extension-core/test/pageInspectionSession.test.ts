import { describe, expect, it, vi } from "vitest";
import type { CssDocumentSource } from "../src/collectCssFacts.js";
import type { InspectPayloadWithDiagnostics } from "../src/inspectPayload.js";
import type { LocationSource } from "../src/inspectPayload.js";
import {
  InspectMode,
  type InspectDocument,
  type InspectEventType,
  type InspectListenerOptions,
  type InspectModeOptions,
} from "../src/inspectMode.js";
import {
  PageInspectionSession,
  type PageInspectionSelection,
  type PageInspectionTreeProvider,
} from "../src/pageInspectionSession.js";
import { DomTreeProviderError } from "../src/domTreeProvider.js";
import type {
  DomTreeElementIdentity,
  DomTreeRevealedElement,
  DomTreeResolvedElement,
  DomTreeSessionRetention,
} from "../src/domTreeProvider.js";
import type {
  DomChildrenResponse,
  DomEvent,
  DomGetChildrenRequest,
  DomNodeView,
  DomRequest,
  DomRootResponse,
} from "../src/domProtocol.js";
import type {
  FrameContext,
  FrameIdentity,
  FrameLifecycleEvent,
  TopViewportRect,
  ViewportRect,
} from "../src/frameRegistry.js";

describe("PageInspectionSession", () => {
  it("uses one selection path for page clicks and tree commands", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();

    dispatchPrimarySequence(harness.document, harness.card);
    const treeSelection = harness.session.selectByRef("node-2", 3);
    await treeSelection;
    await flushAsync();

    expect(harness.selections).toHaveLength(2);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-2"]);
    expect(harness.selections.map(({ selectionRevision }) => selectionRevision))
      .toEqual([1, 2]);
    expect(harness.selections.map(({ ancestorPath }) => (
      ancestorPath.map(({ nodeRef }) => nodeRef)
    ))).toEqual([
      ["node-1", "node-2"],
      ["node-1", "node-2"],
    ]);
    expect(harness.events.flatMap((event) => (
      event.type === "dom.selectionChanged"
        ? [event.selectionRevision]
        : []
    ))).toEqual([1, 2]);
    expect(harness.session.pickerEnabled).toBe(true);
  });

  it("clears only the visual overlay before refresh and keeps selection authority", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    const clearCount = harness.overlay.clearCount;
    const releases = harness.provider.retentions.filter(({ action }) => action === "release");

    harness.session.clearOverlayForRefresh();

    expect(harness.overlay.clearCount).toBe(clearCount + 1);
    expect(harness.provider.retentions.filter(({ action }) => action === "release"))
      .toEqual(releases);
    await expect(harness.session.republishSelection()).resolves.toBe(true);
    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual(["node-2", "node-2"]);
  });

  it("cancels queued page hover before clearing the overlay for refresh", async () => {
    const harness = createSessionHarness();
    const preview = element("SECTION", "preview", harness.document);
    await harness.session.selectByRef("node-2", 3);
    harness.session.enablePicker();
    harness.session.hover(preview);
    const shownBeforeRefresh = harness.overlay.shown.length;

    harness.session.clearOverlayForRefresh();
    harness.clock.flushFrame();

    expect(harness.overlay.shown).toHaveLength(shownBeforeRefresh);
    await expect(harness.session.republishSelection()).resolves.toBe(true);
    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual(["node-2", "node-2"]);
  });

  it("coalesces the raw page target before provider lookup, overlay, and event work", () => {
    const harness = createSessionHarness();
    const first = element("DIV", "first", harness.document);
    const preview = element("SECTION", "preview", harness.document);
    harness.session.enablePicker();

    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", preview, false),
    );
    expect(harness.overlay.shown).toEqual([]);

    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", first),
    );
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", preview),
    );

    expect(harness.provider.revealCount).toBe(0);
    expect(harness.provider.lookupCount).toBe(0);
    expect(harness.events).toEqual([]);
    expect(harness.overlay.shown).toEqual([]);

    harness.clock.flushFrame();

    expect(harness.provider.lookupCount).toBe(1);
    expect(harness.overlay.shown).toHaveLength(1);
    expect(harness.overlay.shown[0]?.element).toBe(preview);
    expect(harness.events).toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
      summary: "section#preview.test",
    }]);
  });

  it("previews and clears tree hover while the picker is off", () => {
    const harness = createSessionHarness();

    harness.session.hoverByRef("node-2", 3);

    expect(harness.session.pickerEnabled).toBe(false);
    expect(harness.overlay.shown.at(-1)?.element).toBe(harness.card);
    expect(harness.provider.retentions).toContainEqual({
      action: "retain",
      nodeRef: "node-2",
      reason: "hovered",
    });
    expect(harness.events).toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
      nodeRef: "node-2",
      summary: "article#card.test",
    }]);

    harness.session.clearHover(3);

    expect(harness.provider.retentions.at(-1)).toEqual({
      action: "release",
      nodeRef: "node-2",
      reason: "hovered",
    });
    expect(harness.overlay.clearCount).toBe(1);
    expect(harness.events.at(-1)).toEqual({
      type: "dom.hoverChanged",
      documentEpoch: 3,
    });
  });

  it("keeps selection persistent and applies two-stage trusted Escape", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-1", 3);
    expect(harness.overlay.shown.at(-1)?.element).not.toBe(harness.card);

    harness.document.dispatch("keydown", createKeyEvent("Escape", true));

    expect(harness.session.pickerEnabled).toBe(true);
    expect(harness.overlay.shown.at(-1)?.element).toBe(harness.card);
    expect(harness.selections).toHaveLength(1);

    harness.document.dispatch("keydown", createKeyEvent("Escape", false));
    expect(harness.session.pickerEnabled).toBe(true);
    harness.document.dispatch("keydown", createKeyEvent("Escape", true));
    expect(harness.session.pickerEnabled).toBe(false);
    expect(harness.selections).toHaveLength(1);
  });

  it("republishes a retained live selection and rejects a stale one", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    const selectionEventCount = harness.events.filter(({ type }) => (
      type === "dom.selectionChanged"
    )).length;
    const revealCount = harness.provider.revealCount;
    harness.provider.throwOnReveal = true;

    await expect(harness.session.republishSelection()).resolves.toBe(true);

    expect(harness.provider.revealCount).toBe(revealCount);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-2"]);
    expect(harness.selections.map(({ selectionRevision }) => selectionRevision))
      .toEqual([1, 1]);
    expect(harness.events.filter(({ type }) => (
      type === "dom.selectionChanged"
    ))).toHaveLength(selectionEventCount);

    harness.provider.throwOnReveal = false;
    harness.provider.remove("node-2");
    await expect(harness.session.republishSelection()).resolves.toBe(false);
    expect(harness.selections).toHaveLength(2);
  });

  it("enforces the selection rate boundary only for page input", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();

    dispatchPrimarySequence(harness.document, harness.card);
    await flushAsync();
    harness.clock.advance(99);
    dispatchPrimarySequence(harness.document, harness.root);
    await flushAsync();
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2"]);

    harness.clock.advance(1);
    dispatchPrimarySequence(harness.document, harness.root);
    await flushAsync();

    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-1"]);
    expect(harness.provider.retentions.filter(({ reason }) => (
      reason === "selected"
    ))).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "selected" },
      { action: "retain", nodeRef: "node-1", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "selected" },
    ]);
  });

  it("serializes direct selections without applying the page input rate", async () => {
    const harness = createSessionHarness();

    await harness.session.selectByRef("node-2", 3);
    await harness.session.selectByRef("node-1", 3);

    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-1"]);
  });

  it("treats publication as a synchronous boolean handoff without assimilating thenables", async () => {
    let thenCalls = 0;
    const neverSettlingThenable = {
      then(): void {
        thenCalls += 1;
      },
    };
    const harness = createSessionHarness({
      onSelection: () => neverSettlingThenable as unknown as boolean,
    });

    const response = await withinMicrotasks(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    }));

    expect(response).not.toBe(MICROTASK_TIMEOUT);
    expect(response).toEqual([]);
    expect(thenCalls).toBe(0);
    expect(harness.selections).toHaveLength(1);
    expect("element" in harness.selections[0]!).toBe(false);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
    expect(thenCalls).toBe(0);
  });

  it("returns the accepted handoff before a queued reentrant replacement", async () => {
    let session!: PageInspectionSession;
    let replaced = false;
    const harness = createSessionHarness({
      onSelection: () => {
        if (!replaced) {
          replaced = true;
          void session.selectByRef("node-1", 3);
        }
        return true;
      },
    });
    session = harness.session;

    await expect(session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([{
      type: "dom.selectionChanged",
      documentEpoch: 3,
      selectionRevision: 1,
      nodeRef: "node-2",
      ancestorPath: [
        nodeView("node-1", "html"),
        nodeView("node-2", "article#card"),
      ],
    }]);
    await flushAsync();

    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-1"]);
  });

  it("clears selected and hovered authority when the selected node is removed", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-2", 3);

    harness.provider.remove("node-2");
    harness.provider.emitSelectedRemoval("node-2");

    expect(harness.provider.retentions).toEqual(expect.arrayContaining([
      { action: "release", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "hovered" },
    ]));
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
    expect(harness.selections).toHaveLength(1);
  });

  it("upgrades an unknown page hover when selection reveals the same element", async () => {
    const harness = createSessionHarness();
    harness.provider.hiddenLookups.add(harness.card);
    harness.session.enablePicker();
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", harness.card),
    );
    harness.clock.flushFrame();

    await harness.session.selectByRef("node-2", 3);
    harness.provider.remove("node-2");
    harness.provider.emitSelectedRemoval("node-2");
    harness.clock.flushFrame();

    expect(harness.provider.retentions.filter(({ reason }) => (
      reason === "hovered"
    ))).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "hovered" },
      { action: "release", nodeRef: "node-2", reason: "hovered" },
    ]);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.events.filter(({ type }) => (
      type === "dom.hoverChanged"
    ))).toEqual([
      {
        type: "dom.hoverChanged",
        documentEpoch: 3,
        summary: "article#card.test",
      },
      {
        type: "dom.hoverChanged",
        documentEpoch: 3,
      },
    ]);
  });

  it("clears a detached unknown page hover and cancels its pending raw target", () => {
    const harness = createSessionHarness();
    const unknown = element("SECTION", "unknown", harness.document);
    harness.provider.hiddenLookups.add(unknown);
    harness.session.enablePicker();
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", unknown),
    );
    harness.clock.flushFrame();
    expect(harness.overlay.shown.at(-1)?.element).toBe(unknown);

    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", unknown),
    );
    const lookupsBeforeRemoval = harness.provider.lookupCount;
    harness.document.detach(unknown);
    harness.provider.emitMutationSettled();
    harness.clock.flushFrame();

    expect(harness.provider.lookupCount).toBe(lookupsBeforeRemoval);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.events.filter(({ type }) => type === "dom.hoverChanged"))
      .toEqual([
        {
          type: "dom.hoverChanged",
          documentEpoch: 3,
          summary: "section#unknown.test",
        },
        {
          type: "dom.hoverChanged",
          documentEpoch: 3,
        },
      ]);
  });

  it("collects payload styles and location from the selected frame document", async () => {
    const frameStyles: CssDocumentSource["styleSheets"] = [{
      href: "https://frame.test/frame.css",
      cssRules: [],
    }];
    const frameLocation: LocationSource = {
      href: "https://frame.test/inside?mode=inspect#target",
      pathname: "/inside",
      search: "?mode=inspect",
      hash: "#target",
    };
    const frameDocument = new FakeSessionDocument(frameStyles, frameLocation);
    let payloadDocument: CssDocumentSource | undefined;
    let payloadLocation: LocationSource | undefined;
    const harness = createSessionHarness({
      createInspectPayload: (selected, document, location) => {
        payloadDocument = document;
        payloadLocation = location;
        return payload(selected.id);
      },
    });
    const context = frameContext(frameDocument, "frame-2", 1);
    const frameButton = element("BUTTON", "frame-button", frameDocument);
    harness.provider.setFrameContexts([context]);
    harness.provider.add(
      frameButton,
      "node-frame",
      [nodeView("node-frame", "button#frame-button")],
      "frame-2",
      1,
    );
    harness.provider.emitFrameLifecycle("registered", context);

    await harness.session.selectByRef("node-frame", 3);

    expect(payloadDocument).toEqual({
      pageUrl: frameLocation.href,
      styleSheets: frameStyles,
    });
    expect(payloadLocation).toEqual(frameLocation);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-frame"]);
  });

  it("wires current overlay ownership into tree-provider exclusion", () => {
    const harness = createSessionHarness();
    const overlayNode = element("DIV", "overlay", harness.document);
    harness.overlay.owned.add(overlayNode);
    const providerOptions = harness.providerOptions as unknown as {
      readonly isExcludedNode?: (node: Node) => boolean;
    };

    expect(providerOptions.isExcludedNode?.(overlayNode as unknown as Node))
      .toBe(true);
    expect(providerOptions.isExcludedNode?.(harness.card as unknown as Node))
      .toBe(false);
  });

  it("rejects selection when payload collection adopts the element", async () => {
    const replacement = new FakeSessionDocument([], {
      href: "https://other.test/adopted",
      pathname: "/adopted",
      search: "",
      hash: "",
    });
    const harness = createSessionHarness({
      createInspectPayload: (selected) => {
        selected.ownerDocument = replacement;
        return payload(selected.id);
      },
    });

    await harness.session.selectByRef("node-2", 3);

    expect(harness.selections).toEqual([]);
    expect(harness.provider.retentions).toEqual([]);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
  });

  it("updates picker documents on frame add, navigation, and removal", () => {
    const harness = createSessionHarness();
    const firstFrameDocument = new FakeSessionDocument();
    const secondFrameDocument = new FakeSessionDocument();
    const firstContext = frameContext(firstFrameDocument, "frame-2", 1);
    harness.provider.setFrameContexts([firstContext]);
    harness.provider.emitFrameLifecycle("registered", firstContext);
    harness.provider.emitFrameLifecycle("registered", firstContext);

    harness.session.enablePicker();
    expect(firstFrameDocument.listenerCount("click")).toBe(1);

    const secondContext = frameContext(secondFrameDocument, "frame-2", 2);
    harness.provider.setFrameContexts([secondContext]);
    harness.provider.emitFrameLifecycle("navigated", secondContext);

    expect(firstFrameDocument.listenerCount("click")).toBe(0);
    expect(secondFrameDocument.listenerCount("click")).toBe(1);

    harness.provider.setFrameContexts([]);
    harness.provider.emitFrameLifecycle("removed", secondContext);

    expect(secondFrameDocument.listenerCount("click")).toBe(0);
  });

  it("clears authority and rejects stale refs after document navigation", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-2", 3);
    const replacement = new FakeSessionDocument();

    harness.session.resetDocument(
      replacement as unknown as Document & { readonly styleSheets: [] },
      4,
    );

    expect(harness.session.pickerEnabled).toBe(false);
    expect(harness.document.listenerCount("click")).toBe(0);
    expect(harness.provider.resetCount).toBe(1);
    expect(harness.overlay.disposeCount).toBe(1);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
    await harness.session.selectByRef("node-2", 3);
    expect(harness.selections).toHaveLength(1);
  });

  it("returns a frozen locator response without changing selection authority", async () => {
    const harness = createSessionHarness();
    const node = nodeView("node-3", "h2#section_title_id1.block_title");
    harness.provider.locatorResolution = Object.freeze({
      node,
      ancestorPath: Object.freeze([
        nodeView("node-1", "html"),
        nodeView("node-3", "h2#section_title_id1.block_title"),
      ]),
    });

    const response = await harness.session.handle({
      type: "dom.resolveLocator",
      requestId: "restore-heading",
      locator: stableLocator(),
    });

    expect(response).toEqual({
      type: "dom.locator",
      requestId: "restore-heading",
      documentEpoch: 3,
      node,
      ancestorPath: [
        nodeView("node-1", "html"),
        nodeView("node-3", "h2#section_title_id1.block_title"),
      ],
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(harness.provider.resolveLocatorCount).toBe(1);
    expect(harness.selections).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it.each([undefined, new Error("page-controlled locator evidence")])(
    "returns a bounded node-unavailable error for locator resolution failure",
    async (failure) => {
      const harness = createSessionHarness();
      harness.provider.locatorError = failure;

      await expect(harness.session.handle({
        type: "dom.resolveLocator",
        requestId: "unavailable-locator",
        locator: stableLocator(),
      })).resolves.toEqual({
        type: "dom.error",
        requestId: "unavailable-locator",
        documentEpoch: 3,
        code: "node-unavailable",
      });
    },
  );

  it("routes strict requests through shared selection and hover authority", async () => {
    const harness = createSessionHarness();

    await expect(harness.session.handle({
      type: "dom.getRoot",
      requestId: "root-request",
      documentEpoch: 3,
    })).resolves.toMatchObject({
      type: "dom.root",
      requestId: "root-request",
      documentEpoch: 3,
    });
    await expect(harness.session.handle({
      type: "dom.getChildren",
      requestId: "children-request",
      documentEpoch: 3,
      nodeRef: "node-1",
      branchRevision: 1,
    })).resolves.toMatchObject({
      type: "dom.children",
      requestId: "children-request",
      nodeRef: "node-1",
    });
    await expect(harness.session.handle({
      type: "dom.hover",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
      nodeRef: "node-2",
      summary: "article#card.test",
    }]);
    await expect(harness.session.handle({
      type: "dom.clearHover",
      documentEpoch: 3,
    })).resolves.toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
    }]);
    await expect(harness.session.handle({
      type: "dom.resolveLocator",
      requestId: "locator-request",
      locator: stableLocator(),
    })).resolves.toEqual({
      type: "dom.error",
      requestId: "locator-request",
      documentEpoch: 3,
      code: "node-unavailable",
    });
    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([{
      type: "dom.selectionChanged",
      documentEpoch: 3,
      selectionRevision: 1,
      nodeRef: "node-2",
      ancestorPath: [
        nodeView("node-1", "html"),
        nodeView("node-2", "article#card"),
      ],
    }]);

    expect(harness.selections).toHaveLength(1);
    expect(harness.events).toEqual([]);
  });

  it("publishes only when the synchronous selection handoff accepts", async () => {
    let accepted = false;
    const harness = createSessionHarness({
      onSelection: () => accepted,
    });

    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([]);
    await expect(harness.session.republishSelection()).resolves.toBe(false);

    accepted = true;
    await expect(harness.session.republishSelection()).resolves.toBe(true);
    expect(harness.selections).toHaveLength(3);
  });

  it("does not return selection after its callback resets the document", async () => {
    let session!: PageInspectionSession;
    let reset = false;
    const replacement = new FakeSessionDocument();
    const harness = createSessionHarness({
      onSelection: () => {
        if (!reset) {
          reset = true;
          session.resetDocument(
            replacement as unknown as Document & { readonly styleSheets: [] },
            4,
          );
        }
        return true;
      },
    });
    session = harness.session;

    await expect(session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("does not return selection after its callback disposes the session", async () => {
    let session!: PageInspectionSession;
    const harness = createSessionHarness({
      onSelection: () => {
        session.dispose();
        return true;
      },
    });
    session = harness.session;

    await expect(session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("does not return selection invalidated during its live resolve", async () => {
    const harness = createSessionHarness({
      onSelection: () => {
        harness.provider.onResolve = () => {
          harness.provider.onResolve = undefined;
          harness.provider.emitSelectedRemoval("node-2");
        };
        return true;
      },
    });

    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    })).resolves.toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("does not collect a stale payload after live resolve invalidation", async () => {
    const payloadElements: string[] = [];
    const harness = createSessionHarness({
      createInspectPayload: (selected) => {
        payloadElements.push(selected.id);
        return payload(selected.id);
      },
    });
    await harness.session.selectByRef("node-2", 3);
    payloadElements.length = 0;
    harness.provider.onResolve = () => {
      harness.provider.onResolve = undefined;
      harness.provider.emitSelectedRemoval("node-2");
    };

    await expect(harness.session.republishSelection()).resolves.toBe(false);

    expect(payloadElements).toEqual([]);
    expect(harness.selections).toHaveLength(1);
  });

  it("does not restore an overlay invalidated during selected resolve", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-1", 3);
    const shownBeforeClear = harness.overlay.shown.length;
    harness.provider.onResolve = () => {
      harness.provider.onResolve = undefined;
      harness.provider.emitSelectedRemoval("node-2");
    };

    harness.session.clearHover(3);

    expect(harness.overlay.shown).toHaveLength(shownBeforeClear);
    expect(harness.provider.retentions.filter(({ nodeRef, reason }) => (
      nodeRef === "node-2" && reason === "selected"
    ))).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "selected" },
    ]);
  });

  it("authoritatively cancels a pending page-hover clear request", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", harness.card),
    );
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", { nodeType: 3 }),
    );

    await expect(harness.session.handle({
      type: "dom.clearHover",
      documentEpoch: 3,
    })).resolves.toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
    }]);
    harness.clock.flushFrame();

    expect(harness.events).toEqual([]);
  });

  it("reduces stale, unknown, malformed, and internal request failures", async () => {
    const harness = createSessionHarness();

    await expect(harness.session.handle({
      type: "dom.hover",
      documentEpoch: 2,
      nodeRef: "node-2",
    })).resolves.toEqual({
      type: "dom.error",
      documentEpoch: 2,
      code: "stale-document",
    });
    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "missing",
    })).resolves.toEqual({
      type: "dom.error",
      documentEpoch: 3,
      code: "unknown-node",
    });

    const hostileRequest = Object.defineProperty({}, "type", {
      enumerable: true,
      get(): never {
        throw new Error("page getter escaped");
      },
    }) as DomRequest;
    await expect(harness.session.handle(hostileRequest)).resolves.toEqual({
      type: "dom.error",
      code: "invalid-request",
    });

    harness.provider.rootError = new Error("private page details");
    const reduced = await harness.session.handle({
      type: "dom.getRoot",
      requestId: "root-error",
    });
    expect(reduced).toEqual({
      type: "dom.error",
      requestId: "root-error",
      code: "internal-error",
    });
    expect(JSON.stringify(reduced)).not.toContain("private page details");
  });

  it("clears frame-owned hover and selection when that frame is removed", async () => {
    const harness = createSessionHarness();
    const frameDocument = new FakeSessionDocument();
    const context = frameContext(frameDocument, "frame-2", 1);
    const frameButton = element("BUTTON", "frame-button", frameDocument);
    harness.provider.setFrameContexts([context]);
    harness.provider.add(
      frameButton,
      "node-frame",
      [nodeView("node-frame", "button#frame-button")],
      "frame-2",
      1,
    );
    harness.provider.emitFrameLifecycle("registered", context);
    await harness.session.selectByRef("node-frame", 3);
    harness.session.hoverByRef("node-frame", 3);

    harness.provider.remove("node-frame");
    harness.provider.setFrameContexts([]);
    harness.provider.emitFrameLifecycle("removed", context);

    expect(harness.provider.retentions).toEqual(expect.arrayContaining([
      { action: "release", nodeRef: "node-frame", reason: "selected" },
      { action: "release", nodeRef: "node-frame", reason: "hovered" },
    ]));
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
  });

  it("fails closed across reentrant and throwing selection callbacks", async () => {
    let session!: PageInspectionSession;
    let reentered = false;
    const harness = createSessionHarness({
      createInspectPayload: (selected) => {
        if (!reentered) {
          reentered = true;
          void session.selectByRef("node-1", 3);
        }
        return payload(selected.id);
      },
      onError: () => {
        throw new Error("hostile diagnostics");
      },
      onEvent: () => {
        throw new Error("hostile event callback");
      },
      onSelection: () => {
        throw new Error("hostile selection callback");
      },
    });
    session = harness.session;

    await expect(session.selectByRef("node-2", 3)).resolves.toBeUndefined();
    await flushAsync();

    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual(["node-2"]);
    await expect(session.republishSelection()).resolves.toBe(false);
  });

  it("rolls back retained authority when overlay rendering throws", async () => {
    const harness = createSessionHarness();
    harness.overlay.throwOnShow = true;

    await expect(harness.session.selectByRef("node-2", 3)).resolves
      .toBeUndefined();

    expect(harness.selections).toEqual([]);
    expect(harness.provider.retentions).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "selected" },
    ]);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
  });

  it("fails closed when an element getter disables picker during page hover", () => {
    const harness = createSessionHarness();
    const target = element("DIV", "reentrant", harness.document);
    Object.defineProperty(target, "tagName", {
      configurable: true,
      get: () => {
        harness.session.disablePicker();
        return "DIV";
      },
    });
    harness.session.enablePicker();

    harness.session.hover(target);
    harness.clock.flushFrame();

    expect(harness.session.pickerEnabled).toBe(false);
    expect(harness.overlay.shown).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("does not emit stale hover after overlay rendering clears it reentrantly", () => {
    const harness = createSessionHarness();
    harness.overlay.onShow = () => {
      harness.overlay.onShow = undefined;
      harness.session.clearHover(3);
    };

    harness.session.hoverByRef("node-2", 3);

    expect(harness.events).toEqual([{
      type: "dom.hoverChanged",
      documentEpoch: 3,
    }]);
    expect(harness.provider.retentions).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "hovered" },
      { action: "release", nodeRef: "node-2", reason: "hovered" },
    ]);
  });

  it("releases both selection generations when replacement disposes reentrantly", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.clock.advance(100);
    harness.overlay.onShow = () => {
      harness.overlay.onShow = undefined;
      harness.session.dispose();
    };

    await harness.session.selectByRef("node-1", 3);

    expect(harness.provider.retentions).toEqual(expect.arrayContaining([
      { action: "release", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-1", reason: "selected" },
    ]));
    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual(["node-2"]);
  });

  it("clears an independently retained hover when a mutation detaches it", () => {
    const harness = createSessionHarness();
    harness.session.hoverByRef("node-2", 3);

    harness.provider.remove("node-2");
    harness.provider.emitMutationSettled();

    expect(harness.provider.retentions.at(-1)).toEqual({
      action: "release",
      nodeRef: "node-2",
      reason: "hovered",
    });
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.events.at(-1)).toEqual({
      type: "dom.hoverChanged",
      documentEpoch: 3,
    });
  });

  it("rejects reentrant republish while a selection callback is active", async () => {
    let session!: PageInspectionSession;
    let reentrantRepublish: Promise<boolean> | undefined;
    const harness = createSessionHarness({
      onSelection: () => {
        reentrantRepublish = session.republishSelection();
        return true;
      },
    });
    session = harness.session;

    await session.selectByRef("node-2", 3);

    await expect(reentrantRepublish).resolves.toBe(false);
    expect(harness.selections).toHaveLength(1);
  });

  it("continues disposal when overlay cleanup throws", () => {
    const harness = createSessionHarness();
    harness.overlay.throwOnClear = true;
    harness.overlay.throwOnDispose = true;

    expect(() => harness.session.dispose()).not.toThrow();

    expect(harness.overlay.disposeCount).toBe(1);
    expect(harness.provider.disposeCount).toBe(1);
  });

  it("fully disposes once and prevents all later callbacks", async () => {
    const harness = createSessionHarness();
    harness.session.enablePicker();
    await harness.session.selectByRef("node-2", 3);
    harness.document.dispatch(
      "pointermove",
      createEvent(
        "pointermove",
        element("ASIDE", "pending", harness.document),
      ),
    );
    const eventCount = harness.events.length;
    const selectionCount = harness.selections.length;

    harness.session.dispose();
    harness.session.dispose();
    harness.provider.emitSelectedRemoval("node-2");
    harness.provider.emitFrameLifecycle(
      "registered",
      frameContext(new FakeSessionDocument(), "frame-late", 1),
    );
    harness.session.enablePicker();
    harness.clock.flushFrame();
    await harness.session.selectByRef("node-2", 3);

    expect(harness.document.listenerCount("click")).toBe(0);
    expect(harness.overlay.disposeCount).toBe(1);
    expect(harness.provider.disposeCount).toBe(1);
    expect(harness.events).toHaveLength(eventCount);
    expect(harness.selections).toHaveLength(selectionCount);
    await expect(harness.session.republishSelection()).resolves.toBe(false);
    await expect(harness.session.handle({
      type: "dom.getRoot",
      requestId: "disposed",
    })).resolves.toEqual({
      type: "dom.error",
      requestId: "disposed",
      code: "session-disposed",
    });
  });
});

function createSessionHarness(overrides: {
  readonly createInspectPayload?: (
    element: ReturnType<typeof element>,
    document: CssDocumentSource,
    location: LocationSource,
  ) => InspectPayloadWithDiagnostics;
  readonly onError?: (error: unknown) => void;
  readonly onEvent?: (event: DomEvent) => void;
  readonly onSelection?: (
    selection: PageInspectionSelection,
  ) => boolean;
} = {}) {
  const document = new FakeSessionDocument();
  const root = element("HTML", "root", document);
  const card = element("ARTICLE", "card", document, root);
  const provider = new FakeTreeProvider(document);
  provider.add(root, "node-1", [nodeView("node-1", "html")]);
  provider.add(card, "node-2", [
    nodeView("node-1", "html"),
    nodeView("node-2", "article#card"),
  ]);
  const overlay = new FakeOverlay();
  const selections: PageInspectionSelection[] = [];
  const events: DomEvent[] = [];
  const clock = new TestClock();
  let providerOptions: Parameters<NonNullable<
    ConstructorParameters<typeof PageInspectionSession>[0]["createTreeProvider"]
  >>[1] | undefined;
  const session = new PageInspectionSession({
    document: document as unknown as Document & { readonly styleSheets: [] },
    location: {
      href: "https://example.test/page",
      pathname: "/page",
      search: "",
      hash: "",
    },
    now: clock.now,
    onError: overrides.onError,
    onEvent: (event) => {
      events.push(event);
      overrides.onEvent?.(event);
    },
    onSelection: (selection) => {
      selections.push(selection);
      return overrides.onSelection?.(selection) ?? true;
    },
    createInspectPayload: overrides.createInspectPayload ?? (
      (selected) => payload(selected.id)
    ),
    createTreeProvider: (_document, options) => {
      providerOptions = options;
      provider.setCallbacks(options);
      return provider;
    },
    createOverlay: () => overlay,
    createInspectMode: (options) => new InspectMode(options),
    requestAnimationFrame: (callback) => clock.requestFrame(callback),
    cancelAnimationFrame: (handle) => clock.cancelFrame(handle),
  });
  return {
    card,
    clock,
    document,
    events,
    overlay,
    provider,
    get providerOptions() {
      return providerOptions;
    },
    root,
    selections,
    session,
  };
}

class FakeTreeProvider implements PageInspectionTreeProvider {
  private epoch = 3;
  public get currentDocumentEpoch(): number {
    return this.epoch;
  }
  public readonly frameAuthority: PageInspectionTreeProvider["frameAuthority"];
  public disposeCount = 0;
  public lookupCount = 0;
  public revealCount = 0;
  public resetCount = 0;
  public rootError: unknown;
  public locatorError: unknown;
  public locatorResolution: {
    readonly node: DomNodeView;
    readonly ancestorPath: readonly DomNodeView[];
  } | undefined;
  public resolveLocatorCount = 0;
  public startFrameTrackingCount = 0;
  public throwOnReveal = false;
  public onResolve: (() => void) | undefined;
  public readonly hiddenLookups = new Set<object>();
  public readonly retentions: Array<{
    readonly action: "retain" | "release";
    readonly nodeRef: string;
    readonly reason: DomTreeSessionRetention;
  }> = [];
  private readonly entriesByElement = new Map<object, DomTreeRevealedElement>();
  private readonly entriesByRef = new Map<string, DomTreeResolvedElement>();
  private readonly contexts = new Map<string, FrameContext>();
  private callbacks: {
    readonly onFrameLifecycle?: (event: FrameLifecycleEvent) => void;
    readonly onInvalidated?: (branch: {
      readonly nodeRef: string;
      readonly branchRevision: number;
    }) => void;
    readonly onSelectedNodeRemoved?: (event: {
      readonly nodeRef: string;
      readonly documentEpoch: number;
    }) => void;
    readonly onMutationSettled?: () => void;
  } = {};

  public constructor(document: FakeSessionDocument) {
    const context = frameContext(document, "frame-1", 1);
    this.contexts.set(context.frameRef, context);
    this.frameAuthority = Object.freeze({
      getContext: (frameRef: string) => this.contexts.get(frameRef),
      getContextForDocument: (candidate: Document) => (
        [...this.contexts.values()].find(({ document }) => (
          document === candidate
        ))
      ),
      accessibleContexts: () => Object.freeze([...this.contexts.values()]),
      toTopViewport: (
        _identity: FrameIdentity,
        rect: ViewportRect,
      ): TopViewportRect => Object.freeze({
        ...rect,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      }),
    });
  }

  public setFrameContexts(contexts: readonly FrameContext[]): void {
    for (const frameRef of [...this.contexts.keys()]) {
      if (frameRef !== "frame-1") this.contexts.delete(frameRef);
    }
    for (const context of contexts) this.contexts.set(context.frameRef, context);
  }

  public emitFrameLifecycle(
    type: FrameLifecycleEvent["type"],
    context: FrameContext,
  ): void {
    this.callbacks.onFrameLifecycle?.(Object.freeze({
      type,
      frameRef: context.frameRef,
      frameEpoch: context.frameEpoch,
      documentEpoch: context.documentEpoch,
      accessible: type !== "removed",
    }));
  }

  public setCallbacks(callbacks: typeof this.callbacks): void {
    this.callbacks = callbacks;
  }

  public add(
    target: object,
    nodeRef: string,
    ancestorPath: readonly DomNodeView[],
    frameRef = "frame-1",
    frameEpoch = 1,
  ): void {
    const identity = {
      nodeRef,
      frameRef,
      frameEpoch,
      documentEpoch: this.currentDocumentEpoch,
    };
    this.entriesByElement.set(target, Object.freeze({
      ...identity,
      ancestorPath: Object.freeze([...ancestorPath]),
    }));
    this.entriesByRef.set(nodeRef, Object.freeze({
      ...identity,
      element: target as Element,
    }));
  }

  public remove(nodeRef: string): void {
    const resolved = this.entriesByRef.get(nodeRef);
    this.entriesByRef.delete(nodeRef);
    if (resolved) {
      this.entriesByElement.delete(resolved.element);
    }
  }

  public emitSelectedRemoval(nodeRef: string): void {
    this.callbacks.onSelectedNodeRemoved?.({
      nodeRef,
      documentEpoch: this.currentDocumentEpoch,
    });
  }

  public emitInvalidation(nodeRef: string): void {
    this.callbacks.onInvalidated?.({ nodeRef, branchRevision: 2 });
  }

  public emitMutationSettled(): void {
    this.callbacks.onMutationSettled?.();
  }

  public getRoot(_expectedEpoch?: number): DomRootResponse {
    if (this.rootError) throw this.rootError;
    return Object.freeze({
      type: "dom.root",
      requestId: "root",
      documentEpoch: this.currentDocumentEpoch,
      node: nodeView("node-1", "html"),
    });
  }

  public getChildren(request: DomGetChildrenRequest): DomChildrenResponse {
    return Object.freeze({
      type: "dom.children",
      requestId: request.requestId,
      documentEpoch: request.documentEpoch,
      nodeRef: request.nodeRef,
      branchRevision: request.branchRevision,
      nodes: Object.freeze([]),
    });
  }

  public resolveLocator(_locator: ReturnType<typeof stableLocator>): {
    readonly node: DomNodeView;
    readonly ancestorPath: readonly DomNodeView[];
  } | undefined {
    this.resolveLocatorCount += 1;
    if (this.locatorError) throw this.locatorError;
    return this.locatorResolution;
  }

  public lookupElement(element: Element): DomTreeElementIdentity | undefined {
    this.lookupCount += 1;
    if (this.hiddenLookups.has(element)) return undefined;
    const entry = this.entriesByElement.get(element);
    return entry && Object.freeze({
      nodeRef: entry.nodeRef,
      frameRef: entry.frameRef,
      frameEpoch: entry.frameEpoch,
      documentEpoch: entry.documentEpoch,
    });
  }

  public revealElement(element: Element): DomTreeRevealedElement {
    this.revealCount += 1;
    if (this.throwOnReveal) throw new Error("record pressure");
    const entry = this.entriesByElement.get(element);
    if (!entry) throw new Error("node-unavailable");
    return entry;
  }

  public resolveElement(
    nodeRef: string,
    documentEpoch: number,
  ): DomTreeResolvedElement | undefined {
    if (documentEpoch !== this.currentDocumentEpoch) {
      throw new DomTreeProviderError("stale-document");
    }
    const resolved = this.entriesByRef.get(nodeRef);
    this.onResolve?.();
    return resolved;
  }

  public retainNode(
    nodeRef: string,
    _documentEpoch: number,
    reason: DomTreeSessionRetention,
  ): boolean {
    if (!this.entriesByRef.has(nodeRef)) return false;
    this.retentions.push({ action: "retain", nodeRef, reason });
    return true;
  }

  public releaseNode(nodeRef: string, reason: DomTreeSessionRetention): void {
    this.retentions.push({ action: "release", nodeRef, reason });
  }

  public startFrameTracking(): void {
    this.startFrameTrackingCount += 1;
  }

  public resetDocument(document: Document, documentEpoch: number): void {
    this.resetCount += 1;
    this.epoch = documentEpoch;
    this.entriesByElement.clear();
    this.entriesByRef.clear();
    this.contexts.clear();
    this.contexts.set("frame-1", Object.freeze({
      document,
      frameRef: "frame-1",
      frameEpoch: 1,
      documentEpoch,
    }));
  }

  public dispose(): void {
    this.disposeCount += 1;
  }
}

class FakeOverlay {
  public readonly shown: Array<{ element: Element; identity: FrameIdentity }> = [];
  public clearCount = 0;
  public disposeCount = 0;
  public onShow: (() => void) | undefined;
  public throwOnClear = false;
  public throwOnDispose = false;
  public throwOnShow = false;
  public readonly owned = new Set<object>();

  public show(element: Element, identity: FrameIdentity): void {
    if (this.throwOnShow) throw new Error("overlay blocked");
    this.onShow?.();
    this.shown.push({ element, identity });
  }

  public clear(): void {
    this.clearCount += 1;
    if (this.throwOnClear) throw new Error("overlay clear blocked");
  }

  public ownsNode(node: Node): boolean {
    return this.owned.has(node);
  }

  public dispose(): void {
    this.disposeCount += 1;
    if (this.throwOnDispose) throw new Error("overlay dispose blocked");
  }
}

class FakeSessionDocument implements InspectDocument {
  private readonly listeners = new Map<
    InspectEventType,
    Set<(event: any) => void>
  >();
  private readonly attached = new Set<object>();
  public readonly documentElement = {
    contains: (candidate: object): boolean => this.attached.has(candidate),
  };

  public constructor(
    public readonly styleSheets: CssDocumentSource["styleSheets"] = [],
    public readonly location?: LocationSource,
  ) {}

  public addEventListener(
    type: InspectEventType,
    listener: (event: any) => void,
    _options: InspectListenerOptions,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: InspectEventType,
    listener: (event: any) => void,
    _options: InspectListenerOptions,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: InspectEventType, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  public listenerCount(type: InspectEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  public attach(candidate: object): void {
    this.attached.add(candidate);
  }

  public detach(candidate: object): void {
    this.attached.delete(candidate);
  }
}

class TestClock {
  private current = 0;
  private nextFrame = 1;
  private readonly frames = new Map<number, FrameRequestCallback>();
  public readonly now = (): number => this.current;

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  public requestFrame(callback: FrameRequestCallback): number {
    const handle = this.nextFrame;
    this.nextFrame += 1;
    this.frames.set(handle, callback);
    return handle;
  }

  public cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }

  public flushFrame(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(this.current);
  }
}

function frameContext(
  document: FakeSessionDocument,
  frameRef: string,
  frameEpoch: number,
): FrameContext {
  return Object.freeze({
    document: document as unknown as Document,
    frameRef,
    frameEpoch,
    documentEpoch: 3,
  });
}

function nodeView(nodeRef: string, label: string): DomNodeView {
  return Object.freeze({
    nodeRef,
    kind: "element",
    label,
    expandable: false,
    branchRevision: 1,
    locator: stableLocator(),
  });
}

function stableLocator() {
  return Object.freeze({
    version: 1 as const,
    targetKind: "element" as const,
    boundaries: Object.freeze([]),
    path: Object.freeze([
      Object.freeze({ tagName: "div", siblingIndex: 0 }),
    ]),
  });
}

function element(
  tagName: string,
  id: string,
  ownerDocument: FakeSessionDocument,
  parentElement: ReturnType<typeof element> | null = null,
) {
  const candidate = {
    nodeType: 1,
    tagName,
    id,
    classList: ["test"],
    attributes: [],
    matches: () => true,
    ownerDocument,
    parentElement,
  };
  ownerDocument.attach(candidate);
  return candidate;
}

function createEvent(
  type: InspectEventType,
  target: unknown,
  isTrusted = true,
) {
  return {
    type,
    target,
    isTrusted,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
    composedPath: () => [target],
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

function createKeyEvent(key: string, isTrusted: boolean) {
  return {
    type: "keydown" as const,
    key,
    isTrusted,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

function dispatchPrimarySequence(
  document: FakeSessionDocument,
  target: unknown,
): void {
  for (const type of [
    "pointerdown",
    "pointerup",
    "click",
  ] as const) {
    document.dispatch(type, createEvent(type, target));
  }
}

function payload(id: string): InspectPayloadWithDiagnostics {
  return {
    targets: [],
    context: { url: `https://example.test/${id}`, metadata: {} },
    metadata: {},
    inaccessibleStylesheets: [],
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

const MICROTASK_TIMEOUT = Symbol("microtask-timeout");

async function withinMicrotasks<T>(
  promise: Promise<T>,
): Promise<T | typeof MICROTASK_TIMEOUT> {
  const timeout = (async () => {
    for (let index = 0; index < 100; index += 1) {
      await Promise.resolve();
    }
    return MICROTASK_TIMEOUT;
  })();
  return await Promise.race([promise, timeout]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
