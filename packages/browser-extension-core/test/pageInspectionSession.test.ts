import { describe, expect, it, vi } from "vitest";
import { utf8ByteLength } from "@pin-op/protocol";
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
import { DomTreeController } from "../src/domTreeController.js";
import {
  PageInspectionSession,
  type PageInspectionSelection,
  type PageInspectionTreeProvider,
} from "../src/pageInspectionSession.js";
import {
  StylesheetRegistry,
  type StylesheetRegistryOptions,
} from "../src/stylesheetRegistry.js";
import {
  MatchedStylesApplicabilityObserver,
  type MatchedStylesApplicabilityObserverOptions,
} from "../src/matchedStylesApplicabilityObserver.js";
import { DomTreeProviderError } from "../src/domTreeProvider.js";
import type {
  DomTreeElementIdentity,
  DomTreeRevealedElement,
  DomTreeResolvedElement,
  DomTreeSessionRetention,
} from "../src/domTreeProvider.js";
import {
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  parseDomEvent,
  parseDomResponse,
  type DomResponse,
  type DomChildrenResponse,
  type DomEvent,
  type DomGetChildrenRequest,
  type DomNodeView,
  type DomRequest,
  type DomRootResponse,
} from "../src/domProtocol.js";
import type {
  FrameContext,
  FrameIdentity,
  FrameLifecycleEvent,
  TopViewportRect,
  ViewportRect,
} from "../src/frameRegistry.js";

describe("PageInspectionSession", () => {
  it("collects matched styles for the exact current selection and returns strict lifecycle errors", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    const selected = harness.events.find((event) => event.type === "dom.selectionChanged");
    expect(selected?.type).toBe("dom.selectionChanged");
    const selectionRevision = selected?.type === "dom.selectionChanged"
      ? selected.selectionRevision
      : -1;

    await expect(harness.session.handle({
      type: "styles.getMatched",
      requestId: "styles-current",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision,
    })).resolves.toMatchObject({
      type: "styles.matched",
      requestId: "styles-current",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision,
      styles: { rules: [], inherited: [] },
    });
    await expect(harness.session.handle({
      type: "styles.getMatched",
      requestId: "styles-stale-document",
      documentEpoch: 2,
      nodeRef: "node-2",
      selectionRevision,
    })).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-stale-document",
      code: "stale-document",
    });
    await expect(harness.session.handle({
      type: "styles.getMatched",
      requestId: "styles-stale-selection",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision: selectionRevision + 1,
    })).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-stale-selection",
      code: "stale-selection",
    });
    await expect(harness.session.handle({
      type: "styles.getMatched",
      requestId: "styles-unknown-node",
      documentEpoch: 3,
      nodeRef: "node-other",
      selectionRevision,
    })).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-unknown-node",
      code: "unknown-node",
    });
    harness.session.dispose();
    await expect(harness.session.handle({
      type: "styles.getMatched",
      requestId: "styles-disposed",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision,
    })).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-disposed",
      code: "cancelled",
    });
  });

  it("coalesces changed ready evidence into a current-selection inspect renewal", async () => {
    const renewals: unknown[] = [];
    let value = "red";
    const registry = {
      revisions: { documentEpoch: 3, stylesheetRevision: 1, stylesRevision: 2 },
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
      checkForChanges: vi.fn(() => false),
      invalidate: vi.fn(),
      invalidateApplicability: vi.fn(),
      resetDocument: vi.fn(),
      dispose: vi.fn(),
    };
    const harness = createSessionHarness({
      createStylesheetRegistry: () => registry,
      createMatchedStylesCollector: () => ({
        collect(authority: {
          documentEpoch: number;
          nodeRef: string;
          selectionRevision: number;
          stylesRevision: number;
          stylesheetRevision: number;
        }) {
          return {
            ...authority,
            rules: [{
              ruleRef: "rule-1",
              selectorText: ".test",
              matchingSelectorIndices: [0],
              declarations: [{
                ruleRef: "rule-1",
                property: "color",
                value,
                important: false,
                valueTruncated: false,
                state: "winning-known-author" as const,
                reason: "highest-precedence-known-author-declaration" as const,
              }],
              contexts: [],
              source: { rulePath: "0" },
            }],
            inherited: [],
            inaccessibleStylesheetCount: 0,
            partial: false,
            diagnostics: [],
          };
        },
      }),
      onStylesInspectPublicationRenewed: (event) => renewals.push(event),
    });
    await harness.session.selectByRef("node-2", 3);
    const selected = harness.events.find((event) => event.type === "dom.selectionChanged");
    const selectionRevision = selected?.type === "dom.selectionChanged"
      ? selected.selectionRevision
      : -1;
    const request = {
      type: "styles.getMatched" as const,
      requestId: "styles-1",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision,
    };
    await harness.session.handle(request);
    await harness.session.handle({ ...request, requestId: "styles-2" });
    await Promise.resolve();
    expect(renewals).toEqual([]);

    value = "blue";
    const blue = harness.session.handle({ ...request, requestId: "styles-3" });
    value = "green";
    const green = harness.session.handle({ ...request, requestId: "styles-4" });
    await Promise.all([blue, green]);
    await Promise.resolve();
    expect(renewals).toEqual([{
      type: "styles.inspectPublicationRenewed",
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision,
    }]);
    expect(harness.selections).toHaveLength(1);
  });
  it("owns stylesheet polling and applicability lifecycle for the active content lease", async () => {
    const registry = {
      revisions: {
        documentEpoch: 3,
        stylesheetRevision: 0,
        stylesRevision: 0,
      },
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
      checkForChanges: vi.fn(() => false),
      invalidate: vi.fn(),
      invalidateApplicability: vi.fn(),
      resetDocument: vi.fn(),
      dispose: vi.fn(),
    };
    const firstApplicability = {
      setSelection: vi.fn(),
      check: vi.fn(() => ({ changed: false })),
      manualRefresh: vi.fn(),
      dispose: vi.fn(),
    };
    const nextApplicability = {
      ...firstApplicability,
      setSelection: vi.fn(),
      check: vi.fn(() => ({ changed: false })),
      dispose: vi.fn(),
    };
    const createApplicabilityObserver = vi.fn()
      .mockReturnValueOnce(firstApplicability)
      .mockReturnValueOnce(nextApplicability);
    const styleInvalidations: unknown[] = [];
    const harness = createSessionHarness({
      contentSessionId: "content-page-styles",
      createStylesheetRegistry: () => registry,
      createApplicabilityObserver,
      onStylesInvalidated: (event) => styleInvalidations.push(event),
    });

    expect(registry.startPolling).toHaveBeenCalledOnce();
    expect(registry.startPolling).toHaveBeenCalledWith(expect.any(Function));
    await harness.session.selectByRef("node-2", 3);
    expect(firstApplicability.setSelection).toHaveBeenLastCalledWith(
      harness.card,
      [],
    );
    expect(harness.session.checkStylesheetsForMatchedQuery()).toBe(false);
    expect(registry.checkForChanges).toHaveBeenCalledOnce();
    expect(firstApplicability.check).toHaveBeenCalledTimes(2);

    const frameDocument = new FakeSessionDocument();
    const context = frameContext(frameDocument, "frame-styles", 1);
    harness.provider.setFrameContexts([context]);
    harness.provider.emitFrameLifecycle("registered", context);
    expect(registry.invalidate).toHaveBeenCalledWith("frame-lifecycle");

    harness.session.clearOverlayForRefresh();
    expect(registry.invalidate).toHaveBeenCalledWith("soft-refresh");
    const applicabilityOptions = createApplicabilityObserver.mock.calls[0]?.[0] as {
      readonly onInvalidated: (event: { readonly reason: string }) => void;
    };
    applicabilityOptions.onInvalidated({ reason: "observable-signal" });
    expect(registry.invalidateApplicability).toHaveBeenCalledWith(
      "observable-signal",
    );

    const replacement = new FakeSessionDocument();
    harness.session.resetDocument(
      replacement as unknown as Document & { readonly styleSheets: [] },
      4,
    );
    expect(registry.resetDocument).toHaveBeenCalledWith(replacement, 4);
    expect(firstApplicability.dispose).toHaveBeenCalledOnce();
    expect(createApplicabilityObserver).toHaveBeenCalledTimes(2);
    expect(registry.startPolling).toHaveBeenCalledTimes(2);

    harness.session.dispose();
    expect(nextApplicability.dispose).toHaveBeenCalledOnce();
    expect(registry.dispose).toHaveBeenCalledOnce();
    expect(styleInvalidations).toEqual([]);
  });

  it("routes one content mutation through the applicability observer only", async () => {
    let registryMutation: ((records: readonly unknown[]) => void) | undefined;
    let applicabilityMutation: ((records: readonly unknown[]) => void) | undefined;
    let registry: StylesheetRegistry | undefined;
    const nativeRule = {
      cssText: ".card { color: red; }",
      selectorText: ".card",
      style: {
        length: 1,
        item: () => "color",
        getPropertyValue: () => "red",
        getPropertyPriority: () => "",
      },
    };
    const sheet = {
      href: "https://example.test/card.css",
      cssRules: [nativeRule],
      disabled: false,
      media: { mediaText: "" },
    };
    const invalidations: unknown[] = [];
    const harness = createSessionHarness({
      contentSessionId: "content-mutation-owner",
      createStylesheetRegistry(options) {
        const typed = options as StylesheetRegistryOptions;
        (typed.document.styleSheets as unknown as object[]).push(sheet);
        registry = new StylesheetRegistry({
          ...typed,
          createMutationObserver(callback) {
            registryMutation = callback;
            return { observe: vi.fn(), disconnect: vi.fn() };
          },
        });
        return registry;
      },
      createApplicabilityObserver(options) {
        const typed = options as MatchedStylesApplicabilityObserverOptions;
        return new MatchedStylesApplicabilityObserver({
          ...typed,
          createMutationObserver(callback) {
            applicabilityMutation = callback;
            return { observe: vi.fn(), disconnect: vi.fn() };
          },
        });
      },
      onStylesInvalidated: (event) => invalidations.push(event),
    });
    await harness.session.selectByRef("node-2", 3);
    const entry = registry!.snapshot().entries[0]!;
    const ruleRef = registry!.referenceRule(entry, "0", nativeRule);
    const record = {
      type: "childList",
      target: { tagName: "DIV" },
      addedNodes: [{ tagName: "SPAN" }],
      removedNodes: [],
    };

    registryMutation?.([record]);
    applicabilityMutation?.([record]);
    await Promise.resolve();

    expect(harness.session.styleRevisions).toMatchObject({
      stylesheetRevision: 0,
      stylesRevision: 1,
    });
    expect(invalidations).toEqual([expect.objectContaining({
      kind: "applicability",
      reason: "observable-signal",
      stylesheetRevision: 0,
      stylesRevision: 1,
    })]);
    expect(registry!.resolveRule(ruleRef)).toBe(nativeRule);
  });

  it("streams every unique branch through bounded settlement chunks", async () => {
    const harness = createSessionHarness();
    for (
      let index = 0;
      index <= DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES;
      index += 1
    ) {
      harness.provider.emitInvalidation(`branch-${index}`, index + 2);
    }

    expect(harness.events.filter((event) => event.type === "dom.invalidated"))
      .toEqual([{
        type: "dom.invalidated",
        documentEpoch: 3,
        branches: Array.from(
          { length: DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES },
          (_, index) => ({
            nodeRef: `branch-${index}`,
            branchRevision: index + 2,
          }),
        ),
      }]);

    harness.provider.emitInvalidation("branch-0", 999);
    harness.provider.emitInvalidation("branch-0", 998);
    harness.provider.emitMutationSettled();

    const invalidations = harness.events.filter((event) => (
      event.type === "dom.invalidated"
    ));
    expect(invalidations).toHaveLength(2);
    expect(invalidations[1]).toEqual({
      type: "dom.invalidated",
      documentEpoch: 3,
      branches: [
        { nodeRef: "branch-128", branchRevision: 130 },
        { nodeRef: "branch-0", branchRevision: 999 },
      ],
    });
    expect(new Set(invalidations.flatMap(({ branches }) => (
      branches.map(({ nodeRef }) => nodeRef)
    )))).toEqual(new Set(Array.from(
      { length: DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES + 1 },
      (_, index) => `branch-${index}`,
    )));
    for (const event of invalidations) {
      expect(event.branches.length).toBeLessThanOrEqual(
        DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
      );
      expect(() => parseDomEvent(event)).not.toThrow();
      expect(utf8ByteLength(JSON.stringify(event)))
        .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    }

    await flushAsync();
    expect(harness.events.filter((event) => event.type === "dom.invalidated"))
      .toHaveLength(2);
  });

  it("delivers 4096 unique invalidations without exceeding an event envelope", () => {
    const harness = createSessionHarness();
    const branchCount = 4_096;
    for (let index = 0; index < branchCount; index += 1) {
      harness.provider.emitInvalidation(`bulk-${index}`, index + 2);
    }

    harness.provider.emitMutationSettled();

    const invalidations = harness.events.filter((event) => (
      event.type === "dom.invalidated"
    ));
    expect(invalidations).toHaveLength(
      branchCount / DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
    );
    expect(invalidations.flatMap(({ branches }) => (
      branches.map(({ nodeRef }) => nodeRef)
    )))
      .toEqual(Array.from({ length: branchCount }, (_, index) => `bulk-${index}`));
    for (const event of invalidations) {
      expect(event.branches).toHaveLength(DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES);
      expect(() => parseDomEvent(event)).not.toThrow();
      expect(utf8ByteLength(JSON.stringify(event)))
        .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    }
  });

  it("streams escaped identifiers without overflowing an event envelope", () => {
    const harness = createSessionHarness();
    const nodeRefs = Array.from({ length: 256 }, (_, index) => (
      `${index}-` + "\u0000".repeat(120)
    ));
    for (const [index, nodeRef] of nodeRefs.entries()) {
      harness.provider.emitInvalidation(nodeRef, index + 2);
    }

    harness.provider.emitMutationSettled();

    const invalidations = harness.events.filter((event) => (
      event.type === "dom.invalidated"
    ));
    expect(invalidations.length).toBeGreaterThan(2);
    expect(invalidations.flatMap(({ branches }) => (
      branches.map(({ nodeRef }) => nodeRef)
    ))).toEqual(nodeRefs);
    for (const event of invalidations) {
      expect(event.branches.length).toBeLessThanOrEqual(
        DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
      );
      expect(() => parseDomEvent(event)).not.toThrow();
      expect(utf8ByteLength(JSON.stringify(event)))
        .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    }
  });

  it("preserves reentrant invalidations while streaming a full chunk", async () => {
    let harness!: ReturnType<typeof createSessionHarness>;
    let reentered = false;
    harness = createSessionHarness({
      onEvent: (event) => {
        if (event.type === "dom.invalidated" && !reentered) {
          reentered = true;
          harness.provider.emitInvalidation("reentrant", 700);
        }
      },
    });
    for (
      let index = 0;
      index <= DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES;
      index += 1
    ) {
      harness.provider.emitInvalidation(`branch-${index}`, index + 2);
    }

    harness.provider.emitMutationSettled();
    await flushAsync();

    const invalidations = harness.events.filter((event) => (
      event.type === "dom.invalidated"
    ));
    expect(invalidations).toHaveLength(2);
    expect(invalidations[1]).toMatchObject({
      branches: [
        { nodeRef: "branch-128", branchRevision: 130 },
        { nodeRef: "reentrant", branchRevision: 700 },
      ],
    });
  });

  it("flushes non-mutation invalidations once and cancels old batches on reset or dispose", async () => {
    const fallback = createSessionHarness();
    fallback.provider.emitInvalidation("fallback", 2);

    await flushAsync();

    expect(fallback.events).toContainEqual({
      type: "dom.invalidated",
      documentEpoch: 3,
      branches: [{ nodeRef: "fallback", branchRevision: 2 }],
    });

    const reset = createSessionHarness();
    reset.provider.emitInvalidation("old-document", 2);
    reset.provider.onResetDocument = () => {
      reset.provider.emitInvalidation("during-reset", 3);
    };
    reset.session.resetDocument(
      new FakeSessionDocument() as unknown as Document & { readonly styleSheets: [] },
      4,
    );
    await flushAsync();
    expect(reset.events).toEqual([]);

    const disposed = createSessionHarness();
    disposed.provider.emitInvalidation("disposed", 2);
    disposed.provider.onDispose = () => {
      disposed.provider.emitInvalidation("during-dispose", 3);
    };
    disposed.session.dispose();
    await flushAsync();
    expect(disposed.events).toEqual([]);
  });

  it("delivers streamed source and destination chunks as one move reconciliation wave", async () => {
    let controller: DomTreeController | undefined;
    const harness = createSessionHarness({
      onEvent: (event) => controller?.handleEvent(event),
    });
    const responses: Array<DomResponse | Promise<DomResponse>> = [];
    const requests: DomRequest[] = [];
    const root = controllerNode("tree-root", 1, true, 1);
    const source = controllerNode("source", 2, true, 1);
    const destination = controllerNode("destination", 2, true, 1, 1);
    const moved = controllerNode("moved", 3, true, 1);
    const leaf = controllerNode("moved-leaf", 4, false, 1);
    responses.push(
      rootResponseForSession(root),
      childrenResponseForSession(root.nodeRef, 1, [source, destination]),
      childrenResponseForSession(source.nodeRef, 1, [moved]),
      childrenResponseForSession(destination.nodeRef, 1, []),
      childrenResponseForSession(moved.nodeRef, 1, [leaf]),
    );
    controller = new DomTreeController({
      transport: {
        request: async (request) => {
          requests.push(request);
          const response = await responses.shift();
          if (!response) throw new Error("Missing queued controller response");
          return "requestId" in response
            ? { ...response, requestId: request.requestId }
            : response;
        },
        dispatch: () => undefined,
        cancelPending: () => undefined,
      },
      createRequestId: () => `session-tree-${requests.length + 1}`,
    });
    await controller.loadRoot();
    await controller.expand(root.nodeRef);
    await controller.expand(source.nodeRef);
    await controller.expand(destination.nodeRef);
    await controller.expand(moved.nodeRef);
    controller.handleEvent({
      type: "dom.selectionChanged",
      documentEpoch: 3,
      selectionRevision: 1,
      nodeRef: moved.nodeRef,
      ancestorPath: [root, source, moved],
    });
    controller.focus(leaf.nodeRef);
    responses.push(
      childrenResponseForSession(source.nodeRef, 2, []),
      childrenResponseForSession(destination.nodeRef, 2, [moved]),
    );

    for (
      let index = 0;
      index < DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES - 1;
      index += 1
    ) {
      harness.provider.emitInvalidation(`padding-${index}`, 2);
    }
    harness.provider.emitInvalidation(source.nodeRef, 2);
    harness.provider.emitInvalidation(destination.nodeRef, 2);
    harness.provider.emitMutationSettled();
    await flushAsync();

    const invalidations = harness.events.filter((event) => (
      event.type === "dom.invalidated"
    ));
    expect(invalidations).toHaveLength(2);
    expect(invalidations[0]?.branches).toHaveLength(
      DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
    );
    expect(invalidations[0]?.branches.at(-1)).toEqual({
      nodeRef: source.nodeRef,
      branchRevision: 2,
    });
    expect(invalidations[1]).toEqual({
      type: "dom.invalidated",
      documentEpoch: 3,
      branches: [{ nodeRef: destination.nodeRef, branchRevision: 2 }],
    });
    expect(controller.rows().filter((row) => row.nodeRef === moved.nodeRef))
      .toEqual([expect.objectContaining({
        parentRef: destination.nodeRef,
        selected: true,
      })]);
    expect(controller.rows().find((row) => row.nodeRef === leaf.nodeRef))
      .toMatchObject({ parentRef: moved.nodeRef, focused: true });
    expect(controller.expandedRefs()).toEqual(expect.arrayContaining([
      root.nodeRef,
      destination.nodeRef,
      moved.nodeRef,
    ]));
    expect(controller.beginRecovery()).toMatchObject({
      selectedLocator: moved.locator,
      focusAnchor: { locator: leaf.locator, rowType: "node" },
    });
  });

  it("carries a published same-document root replacement into the controller", async () => {
    let controller: DomTreeController | undefined;
    const harness = createSessionHarness({
      onEvent: (event) => controller?.handleEvent(event),
    });
    const requests: DomRequest[] = [];
    controller = new DomTreeController({
      transport: {
        request: async (request) => {
          requests.push(request);
          const response = await harness.session.handle(request);
          if (Array.isArray(response)) {
            throw new Error("Expected a DOM response");
          }
          return response as DomResponse;
        },
        dispatch: () => undefined,
        cancelPending: () => undefined,
      },
      createRequestId: () => `root-switch-${requests.length + 1}`,
    });
    await controller.loadRoot();
    expect(controller.rows().map(({ nodeRef }) => nodeRef)).toEqual(["node-1"]);

    harness.provider.rootNode = nodeView("replacement-root", "replacement");
    harness.provider.emitInvalidation("node-1", 2);
    harness.provider.emitMutationSettled();
    await flushAsync();

    expect(requests.filter(({ type }) => type === "dom.getRoot")).toHaveLength(2);
    expect(controller.documentEpoch).toBe(3);
    expect(controller.rows().map(({ nodeRef }) => nodeRef))
      .toEqual(["replacement-root"]);
    expect(controller.snapshot()).toMatchObject({
      documentEpoch: 3,
      focusedRef: "replacement-root",
    });
    expect(controller.snapshot().errorCode).toBeUndefined();
  });

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
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual(["node-2", "node-2"]);
  });

  it("revalidates delayed republish identity after selection, lease, and navigation replacement", async () => {
    const contentSessionId = "content-republish-current";
    const harness = createSessionHarness({ contentSessionId });
    await harness.session.selectByRef("node-2", 3);
    const retiredSelection = {
      type: "pin-op.inspect.republish" as const,
      contentSessionId,
      documentEpoch: 3,
      nodeRef: "node-2",
      selectionRevision: 1,
    };

    await harness.session.selectByRef("node-1", 3);
    await expect(harness.session.republishSelection(retiredSelection))
      .resolves.toBe(false);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-1"]);

    const currentSelection = {
      ...retiredSelection,
      nodeRef: "node-1",
      selectionRevision: 2,
    };
    await expect(harness.session.republishSelection({
      ...currentSelection,
      contentSessionId: "retired-content-lease",
    })).resolves.toBe(false);
    expect(harness.selections).toHaveLength(2);

    await expect(harness.session.republishSelection(currentSelection))
      .resolves.toBe(true);
    expect(harness.selections.at(-1)).toMatchObject({
      nodeRef: "node-1",
      documentEpoch: 3,
      selectionRevision: 2,
    });

    harness.session.resetDocument(
      new FakeSessionDocument() as unknown as Document & {
        readonly styleSheets: [];
      },
      4,
    );
    await expect(harness.session.republishSelection(currentSelection))
      .resolves.toBe(false);
    expect(harness.selections).toHaveLength(3);
  });

  it("does not display a selected element after hover leaves", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    expect(harness.overlay.shown).toEqual([]);
    harness.session.hoverByRef("node-1", 3);
    const shownBeforeLeave = harness.overlay.shown.length;

    harness.session.clearHover(3);

    expect(harness.overlay.shown).toHaveLength(shownBeforeLeave);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-2"]);
  });

  it("ignores trusted pointerleave transitions inside the document", async () => {
    const harness = createSessionHarness();
    harness.session.hoverByRef("node-2", 3);
    const clearCount = harness.overlay.clearCount;
    const releaseCount = harness.provider.retentions.filter(({ action }) => (
      action === "release"
    )).length;

    harness.document.dispatch(
      "pointerleave",
      createPointerLeaveEvent(harness.card, harness.root),
    );

    expect(harness.overlay.clearCount).toBe(clearCount);
    expect(harness.provider.retentions.filter(({ action }) => (
      action === "release"
    ))).toHaveLength(releaseCount);
  });

  it("ignores synthetic pointerleave events at the viewport boundary", () => {
    const harness = createSessionHarness();
    harness.session.hoverByRef("node-2", 3);
    const clearCount = harness.overlay.clearCount;
    const releaseCount = harness.provider.retentions.filter(({ action }) => (
      action === "release"
    )).length;

    harness.document.dispatch(
      "pointerleave",
      createPointerLeaveEvent(harness.card, null, false),
    );

    expect(harness.overlay.clearCount).toBe(clearCount);
    expect(harness.provider.retentions.filter(({ action }) => (
      action === "release"
    ))).toHaveLength(releaseCount);
  });

  it("clears page hover on a trusted top-document viewport exit", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.session.enablePicker();
    harness.document.dispatch(
      "pointermove",
      createEvent("pointermove", harness.root),
    );
    harness.clock.flushFrame();
    const shownBeforeLeave = harness.overlay.shown.length;

    harness.document.dispatch(
      "pointerleave",
      createPointerLeaveEvent(harness.root, null),
    );

    expect(harness.overlay.shown).toHaveLength(shownBeforeLeave);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.provider.retentions.at(-1)).toEqual({
      action: "release",
      nodeRef: "node-1",
      reason: "hovered",
    });
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
  });

  it("clears frame hover when the pointer exits an iframe document", () => {
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
    harness.session.hoverByRef("node-frame", 3);

    frameDocument.dispatch(
      "pointerleave",
      createPointerLeaveEvent(frameButton, null),
    );

    expect(harness.provider.retentions.at(-1)).toEqual({
      action: "release",
      nodeRef: "node-frame",
      reason: "hovered",
    });
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
  });

  it("clears hover authority before refresh without clearing selection", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-1", 3);

    harness.session.clearOverlayForRefresh();

    expect(harness.provider.retentions.at(-1)).toEqual({
      action: "release",
      nodeRef: "node-1",
      reason: "hovered",
    });
    expect(harness.events.at(-1)).toEqual({
      type: "dom.hoverChanged",
      documentEpoch: 3,
    });
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
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
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
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
    const shownBeforeEscape = harness.overlay.shown.length;
    const clearCountBeforeEscape = harness.overlay.clearCount;

    harness.document.dispatch("keydown", createKeyEvent("Escape", true));

    expect(harness.session.pickerEnabled).toBe(true);
    expect(harness.overlay.shown).toHaveLength(shownBeforeEscape);
    expect(harness.overlay.clearCount).toBe(clearCountBeforeEscape + 1);
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

    await expect(republishCurrentSelection(harness)).resolves.toBe(true);

    expect(harness.provider.revealCount).toBe(revealCount);
    expect(harness.selections.map(({ nodeRef }) => nodeRef))
      .toEqual(["node-2", "node-2"]);
    expect(harness.selections.map(({ selectionRevision }) => selectionRevision))
      .toEqual([1, 1]);
    expect(harness.events.filter(({ type }) => (
      type === "dom.selectionChanged"
    ))).toHaveLength(selectionEventCount);

    harness.provider.throwOnReveal = false;
    const removalEventOffset = harness.events.length;
    harness.provider.remove("node-2");
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
    expect(harness.selections).toHaveLength(2);
    expect(harness.events.slice(removalEventOffset)).toEqual([{
      type: "dom.selectionCleared",
      documentEpoch: 3,
      selectionRevision: 2,
      nodeRef: "node-2",
    }]);
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
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
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
    const eventOffset = harness.events.length;

    harness.provider.remove("node-2");
    harness.provider.emitInvalidation("node-1", 2);
    harness.provider.emitSelectedRemoval("node-2");
    harness.provider.emitMutationSettled();

    expect(harness.provider.retentions).toEqual(expect.arrayContaining([
      { action: "release", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "hovered" },
    ]));
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
    expect(harness.selections).toHaveLength(1);
    expect(harness.events.slice(eventOffset)).toEqual([
      {
        type: "dom.selectionCleared",
        documentEpoch: 3,
        selectionRevision: 2,
        nodeRef: "node-2",
      },
      {
        type: "dom.hoverChanged",
        documentEpoch: 3,
      },
      {
        type: "dom.invalidated",
        documentEpoch: 3,
        branches: [{ nodeRef: "node-1", branchRevision: 2 }],
      },
    ]);
    const duplicateEventCount = harness.events.length;
    harness.provider.emitSelectedRemoval("node-2");
    expect(harness.events).toHaveLength(duplicateEventCount);
  });

  it("clears a reveal-only selection before refreshing its surviving owner", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    const eventOffset = harness.events.length;

    harness.provider.remove("node-2");
    harness.provider.emitInvalidation("node-1", 2);
    harness.provider.emitSelectedRemoval("node-2");
    harness.provider.emitMutationSettled();

    expect(harness.events.slice(eventOffset)).toEqual([
      {
        type: "dom.selectionCleared",
        documentEpoch: 3,
        selectionRevision: 2,
        nodeRef: "node-2",
      },
      {
        type: "dom.invalidated",
        documentEpoch: 3,
        branches: [{ nodeRef: "node-1", branchRevision: 2 }],
      },
    ]);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
  });

  it("retains selection across a same-scope move invalidation", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    const eventOffset = harness.events.length;

    harness.provider.emitInvalidation("node-1", 2);
    harness.provider.emitMutationSettled();

    expect(harness.events.slice(eventOffset)).toEqual([{
      type: "dom.invalidated",
      documentEpoch: 3,
      branches: [{ nodeRef: "node-1", branchRevision: 2 }],
    }]);
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
    expect(harness.selections.map(({ nodeRef }) => nodeRef)).toEqual([
      "node-2",
      "node-2",
    ]);
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
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
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
    const clearCountBeforeReset = harness.overlay.clearCount;

    harness.session.resetDocument(
      replacement as unknown as Document & { readonly styleSheets: [] },
      4,
    );

    expect(harness.session.pickerEnabled).toBe(false);
    expect(harness.document.listenerCount("click")).toBe(0);
    expect(harness.document.listenerCount(
      "pointerleave" as InspectEventType,
    )).toBe(0);
    expect(replacement.listenerCount(
      "pointerleave" as InspectEventType,
    )).toBe(1);
    expect(harness.provider.resetCount).toBe(1);
    expect(harness.overlay.clearCount).toBe(clearCountBeforeReset + 1);
    expect(harness.overlay.disposeCount).toBe(1);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
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

  it("bounds locator responses with worst-case correlation and structured fields", async () => {
    const harness = createSessionHarness();
    const ancestorPath = Object.freeze([
      oversizedNodeView("node-1"),
      oversizedNodeView("node-3"),
    ]);
    harness.provider.locatorResolution = Object.freeze({
      node: ancestorPath[1]!,
      ancestorPath,
    });

    const response = await harness.session.handle({
      type: "dom.resolveLocator",
      requestId: "\u0000".repeat(128),
      locator: stableLocator(),
    });

    expect(response).toMatchObject({
      type: "dom.locator",
      node: { nodeRef: "node-3", locator: stableLocator() },
      ancestorPath: [
        { nodeRef: "node-1" },
        { nodeRef: "node-3", locator: stableLocator() },
      ],
    });
    expect(utf8ByteLength(JSON.stringify(response)))
      .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    expect(() => parseDomResponse(response as DomResponse)).not.toThrow();
  });

  it("fails closed when a required locator cannot fit twice in its response", async () => {
    const harness = createSessionHarness();
    const locator = largeStableLocator();
    const target = Object.freeze({
      ...nodeView("node-3", "target"),
      locator,
    });
    harness.provider.locatorResolution = Object.freeze({
      node: target,
      ancestorPath: Object.freeze([target]),
    });

    const response = await harness.session.handle({
      type: "dom.resolveLocator",
      requestId: "large-locator",
      locator,
    });

    expect(response).toEqual({
      type: "dom.error",
      requestId: "large-locator",
      documentEpoch: 3,
      code: "node-unavailable",
    });
  });

  it("bounds selection events without losing the selected path identity", async () => {
    const harness = createSessionHarness();
    const ancestorPath = Object.freeze([
      oversizedNodeView("node-1"),
      oversizedNodeView("node-2"),
    ]);
    harness.provider.add(harness.card, "node-2", ancestorPath);

    const response = await harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: "node-2",
    });
    const event = Array.isArray(response) ? response[0] : undefined;

    expect(event).toMatchObject({
      type: "dom.selectionChanged",
      nodeRef: "node-2",
      ancestorPath: [
        { nodeRef: "node-1" },
        { nodeRef: "node-2", locator: stableLocator() },
      ],
    });
    expect(utf8ByteLength(JSON.stringify(event)))
      .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    expect(() => parseDomEvent(event)).not.toThrow();

    const recoveryController = new DomTreeController({
      transport: {
        request: async () => {
          throw new Error("Unexpected recovery transport request");
        },
        dispatch: () => undefined,
        cancelPending: () => undefined,
      },
      createRequestId: () => "selection-recovery",
    });
    recoveryController.handleEvent(parseDomEvent(event));
    expect(recoveryController.beginRecovery().selectedLocator)
      .toEqual(stableLocator());
  });

  it("fails selection closed when its required recovery locator cannot fit", async () => {
    const harness = createSessionHarness();
    const target = Object.freeze({
      ...nodeView("node-2", "article#card"),
      locator: unfitStableLocator(),
    });
    harness.provider.add(harness.card, target.nodeRef, Object.freeze([
      nodeView("node-1", "html"),
      target,
    ]));

    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef: target.nodeRef,
    })).resolves.toEqual({
      type: "dom.error",
      documentEpoch: 3,
      code: "node-unavailable",
    });
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
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);

    accepted = true;
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
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
    expect(harness.events).toEqual([{
      type: "dom.selectionCleared",
      documentEpoch: 3,
      selectionRevision: 2,
      nodeRef: "node-2",
    }]);
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

    await expect(republishCurrentSelection(harness)).resolves.toBe(false);

    expect(payloadElements).toEqual([]);
    expect(harness.selections).toHaveLength(1);
  });

  it("does not resolve or restore the selected element when hover clears", async () => {
    const harness = createSessionHarness();
    await harness.session.selectByRef("node-2", 3);
    harness.session.hoverByRef("node-1", 3);
    const shownBeforeClear = harness.overlay.shown.length;
    const onResolve = vi.fn();
    harness.provider.onResolve = onResolve;

    harness.session.clearHover(3);

    expect(harness.overlay.shown).toHaveLength(shownBeforeClear);
    expect(onResolve).not.toHaveBeenCalled();
    expect(harness.provider.retentions.filter(({ nodeRef, reason }) => (
      nodeRef === "node-2" && reason === "selected"
    ))).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "selected" },
    ]);
    harness.provider.onResolve = undefined;
    await expect(republishCurrentSelection(harness)).resolves.toBe(true);
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

  it.each([
    "document-type",
    "text",
    "comment",
    "shadow-root",
    "frame-document",
  ] as const)("returns node-unavailable for select and hover of a known %s ref", async (
    kind,
  ) => {
    const harness = createSessionHarness();
    const nodeRef = `known-${kind}`;
    harness.provider.knownUnavailableRefs.add(nodeRef);

    await expect(harness.session.handle({
      type: "dom.select",
      documentEpoch: 3,
      nodeRef,
    })).resolves.toEqual({
      type: "dom.error",
      documentEpoch: 3,
      code: "node-unavailable",
    });
    await expect(harness.session.handle({
      type: "dom.hover",
      documentEpoch: 3,
      nodeRef,
    })).resolves.toEqual({
      type: "dom.error",
      documentEpoch: 3,
      code: "node-unavailable",
    });
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
    expect(frameDocument.listenerCount(
      "pointerleave" as InspectEventType,
    )).toBe(1);
    await harness.session.selectByRef("node-frame", 3);
    harness.session.hoverByRef("node-frame", 3);
    const eventOffset = harness.events.length;

    harness.provider.remove("node-frame");
    harness.provider.setFrameContexts([]);
    harness.provider.emitFrameLifecycle("removed", context);

    expect(frameDocument.listenerCount(
      "pointerleave" as InspectEventType,
    )).toBe(0);
    expect(harness.provider.retentions).toEqual(expect.arrayContaining([
      { action: "release", nodeRef: "node-frame", reason: "selected" },
      { action: "release", nodeRef: "node-frame", reason: "hovered" },
    ]));
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
    expect(harness.events.slice(eventOffset)).toEqual([
      {
        type: "dom.selectionCleared",
        documentEpoch: 3,
        selectionRevision: 2,
        nodeRef: "node-frame",
      },
      {
        type: "dom.hoverChanged",
        documentEpoch: 3,
      },
    ]);
  });

  it("leaves a listener inert when frame removal cannot unregister it", () => {
    const harness = createSessionHarness();
    const frameDocument = new FakeSessionDocument();
    const context = frameContext(frameDocument, "frame-2", 1);
    harness.provider.setFrameContexts([context]);
    harness.provider.emitFrameLifecycle("registered", context);
    harness.session.hoverByRef("node-1", 3);
    const clearCountBeforeRemoval = harness.overlay.clearCount;
    const removalClearCounts: number[] = [];
    frameDocument.throwOnRemove = true;
    frameDocument.onRemove = (type) => {
      if (type !== "pointerleave") return;
      frameDocument.dispatch(
        "pointerleave",
        createPointerLeaveEvent(frameDocument.documentElement, null),
      );
      removalClearCounts.push(harness.overlay.clearCount);
    };

    harness.provider.setFrameContexts([]);
    harness.provider.emitFrameLifecycle("removed", context);

    expect(removalClearCounts).toEqual([clearCountBeforeRemoval]);
    expect(frameDocument.listenerCount("pointerleave")).toBe(1);
    const clearCount = harness.overlay.clearCount;
    frameDocument.dispatch(
      "pointerleave",
      createPointerLeaveEvent(frameDocument.documentElement, null),
    );
    expect(harness.overlay.clearCount).toBe(clearCount);

    frameDocument.onRemove = undefined;
    harness.provider.setFrameContexts([context]);
    harness.provider.emitFrameLifecycle("registered", context);
    expect(frameDocument.listenerCount("pointerleave")).toBe(2);
    frameDocument.dispatch(
      "pointerleave",
      createPointerLeaveEvent(frameDocument.documentElement, null),
    );
    expect(harness.overlay.clearCount).toBe(clearCount + 1);

    harness.session.dispose();
    const disposedClearCount = harness.overlay.clearCount;
    frameDocument.dispatch(
      "pointerleave",
      createPointerLeaveEvent(frameDocument.documentElement, null),
    );
    expect(harness.overlay.clearCount).toBe(disposedClearCount);
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
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
  });

  it("rolls back retained authority when overlay rendering throws", async () => {
    const harness = createSessionHarness();
    harness.session.hoverByRef("node-1", 3);
    harness.overlay.throwOnShow = true;

    await expect(harness.session.selectByRef("node-2", 3)).resolves
      .toBeUndefined();

    expect(harness.selections).toEqual([]);
    expect(harness.provider.retentions.filter(({ reason }) => (
      reason === "selected"
    ))).toEqual([
      { action: "retain", nodeRef: "node-2", reason: "selected" },
      { action: "release", nodeRef: "node-2", reason: "selected" },
    ]);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
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
    harness.session.hoverByRef("node-2", 3);
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
      onSelection: (selection) => {
        reentrantRepublish = session.republishSelection(
          inspectRepublishRequest(selection),
        );
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
    const clearCount = harness.overlay.clearCount;

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
    expect(harness.document.listenerCount(
      "pointerleave" as InspectEventType,
    )).toBe(0);
    expect(harness.overlay.clearCount).toBe(clearCount + 1);
    expect(harness.overlay.disposeCount).toBe(1);
    expect(harness.provider.disposeCount).toBe(1);
    expect(harness.events).toHaveLength(eventCount);
    expect(harness.selections).toHaveLength(selectionCount);
    await expect(republishCurrentSelection(harness)).resolves.toBe(false);
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
  readonly contentSessionId?: string;
  readonly createStylesheetRegistry?: (options: unknown) => unknown;
  readonly createApplicabilityObserver?: (options: unknown) => unknown;
  readonly createMatchedStylesCollector?: (options: unknown) => unknown;
  readonly onStylesInvalidated?: (event: unknown) => void;
  readonly onStylesInspectPublicationRenewed?: (event: unknown) => void;
} = {}) {
  const contentSessionId = overrides.contentSessionId ?? "page-inspection-session";
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
    contentSessionId: overrides.contentSessionId,
    onError: overrides.onError,
    onEvent: (event) => {
      events.push(event);
      overrides.onEvent?.(event);
    },
    onSelection: (selection) => {
      selections.push(selection);
      return overrides.onSelection?.(selection) ?? true;
    },
    createStylesheetRegistry: overrides.createStylesheetRegistry,
    createApplicabilityObserver: overrides.createApplicabilityObserver,
    createMatchedStylesCollector: overrides.createMatchedStylesCollector,
    onStylesInvalidated: overrides.onStylesInvalidated,
    onStylesInspectPublicationRenewed:
      overrides.onStylesInspectPublicationRenewed,
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
    contentSessionId,
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

function inspectRepublishRequest(
  selection: PageInspectionSelection | undefined,
  contentSessionId = "page-inspection-session",
) {
  return {
    type: "pin-op.inspect.republish" as const,
    contentSessionId,
    documentEpoch: selection?.documentEpoch ?? 3,
    nodeRef: selection?.nodeRef ?? "missing-node",
    selectionRevision: selection?.selectionRevision ?? 0,
  };
}

function republishCurrentSelection(
  harness: ReturnType<typeof createSessionHarness>,
): Promise<boolean> {
  return harness.session.republishSelection(inspectRepublishRequest(
    harness.selections.at(-1),
    harness.contentSessionId,
  ));
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
  public rootNode = nodeView("node-1", "html");
  public locatorError: unknown;
  public locatorResolution: {
    readonly node: DomNodeView;
    readonly ancestorPath: readonly DomNodeView[];
  } | undefined;
  public resolveLocatorCount = 0;
  public startFrameTrackingCount = 0;
  public throwOnReveal = false;
  public onResolve: (() => void) | undefined;
  public onResetDocument: (() => void) | undefined;
  public onDispose: (() => void) | undefined;
  public readonly hiddenLookups = new Set<object>();
  public readonly knownUnavailableRefs = new Set<string>();
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

  public emitInvalidation(nodeRef: string, branchRevision = 2): void {
    this.callbacks.onInvalidated?.({ nodeRef, branchRevision });
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
      node: this.rootNode,
      prologue: Object.freeze([]),
      epilogue: Object.freeze([]),
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
    if (this.knownUnavailableRefs.has(nodeRef)) {
      throw new DomTreeProviderError("node-unavailable");
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
    this.onResetDocument?.();
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
    this.onDispose?.();
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

type SessionEventType = InspectEventType | "pointerleave";

class FakeSessionDocument implements InspectDocument {
  private readonly listeners = new Map<
    SessionEventType,
    Set<(event: any) => void>
  >();
  private readonly attached = new Set<object>();
  public throwOnRemove = false;
  public onRemove: ((type: SessionEventType) => void) | undefined;
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
    this.onRemove?.(type as SessionEventType);
    if (this.throwOnRemove) {
      throw new Error("listener removal blocked");
    }
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: SessionEventType, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  public listenerCount(type: SessionEventType): number {
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
    nodeType: 1,
    nodeName: "DIV",
    attributes: Object.freeze([]),
    childCount: 0,
    relationship: "dom",
    selectable: true,
    label,
    expandable: false,
    branchRevision: 1,
    locator: stableLocator(),
  });
}

function controllerNode(
  nodeRef: string,
  depth: number,
  expandable: boolean,
  branchRevision: number,
  siblingIndex = 0,
): DomNodeView {
  return Object.freeze({
    nodeRef,
    kind: "element",
    nodeType: 1,
    nodeName: "DIV",
    attributes: Object.freeze([]),
    childCount: expandable ? 1 : 0,
    relationship: "dom",
    selectable: true,
    label: nodeRef,
    expandable,
    branchRevision,
    locator: Object.freeze({
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: Object.freeze([]),
      path: Object.freeze(Array.from({ length: depth }, (_, index) => Object.freeze({
        tagName: index === depth - 1 ? "div" : "section",
        siblingIndex: index === depth - 1 ? siblingIndex : 0,
      }))),
    }),
  });
}

function rootResponseForSession(node: DomNodeView): DomRootResponse {
  return Object.freeze({
    type: "dom.root",
    requestId: "session-test",
    documentEpoch: 3,
    node,
    prologue: Object.freeze([]),
    epilogue: Object.freeze([]),
  });
}

function childrenResponseForSession(
  nodeRef: string,
  branchRevision: number,
  nodes: readonly DomNodeView[],
): DomChildrenResponse {
  return Object.freeze({
    type: "dom.children",
    requestId: "session-test",
    documentEpoch: 3,
    nodeRef,
    branchRevision,
    nodes: Object.freeze([...nodes]),
  });
}

function oversizedNodeView(nodeRef: string): DomNodeView {
  return Object.freeze({
    ...nodeView(nodeRef, nodeRef),
    attributes: Object.freeze(Array.from(
      { length: 64 },
      (_, index) => Object.freeze({
        name: `onclick-${index}`,
        value: "\u0000".repeat(1_000),
      }),
    )),
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

function largeStableLocator() {
  const classes = Object.freeze(Array.from({ length: 8 }, (_, index) => (
    `class-${index}-${"c".repeat(118)}`
  )));
  const attributes = Object.freeze(Array.from({ length: 8 }, (_, index) => Object.freeze({
    name: `data-${index}-${"n".repeat(110)}`,
    value: "v".repeat(128),
  })));
  return Object.freeze({
    version: 1 as const,
    targetKind: "element" as const,
    boundaries: Object.freeze([]),
    path: Object.freeze(Array.from({ length: 10 }, () => Object.freeze({
      tagName: "div",
      siblingIndex: 0,
      id: "i".repeat(128),
      classes,
      attributes,
    }))),
  });
}

function unfitStableLocator() {
  const large = largeStableLocator();
  const segment = large.path[0]!;
  return Object.freeze({
    ...large,
    path: Object.freeze(Array.from({ length: 64 }, () => segment)),
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

function createPointerLeaveEvent(
  target: unknown,
  relatedTarget: unknown,
  isTrusted = true,
) {
  return {
    type: "pointerleave" as const,
    target,
    relatedTarget,
    isTrusted,
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
