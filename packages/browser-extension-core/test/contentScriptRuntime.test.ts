import { describe, expect, it, vi } from "vitest";
import {
  startContentRefreshBootstrapRuntime,
  startContentRefreshRuntime,
  startContentScriptRuntime,
} from "../src/contentScriptRuntime.js";
import { createInspectContentLeasePortName } from "../src/inspectPortProtocol.js";

describe("startContentScriptRuntime", () => {
  it("parses exact styles requests and publishes only strict styles lifecycle events", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const sent: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    pageSession.handle.mockImplementation(async (request: { type?: string; requestId?: string }) => (
      request.type === "styles.getMatched"
        ? stylesMatchedResponse(request.requestId ?? "missing")
        : rootResponse(request.requestId ?? "missing")
    ));
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => { sent.push(message); },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-styles",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });

    await expect(runtimeMessages.emit({
      type: "styles.getMatched",
      requestId: "styles-1",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      pseudoStateRevision: 2,
      pseudoStates: ["hover"],
      manualRefresh: true,
    })).resolves.toMatchObject({ type: "styles.matched", requestId: "styles-1" });
    expect(pageSession.handle).toHaveBeenLastCalledWith({
      type: "styles.getMatched",
      requestId: "styles-1",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      pseudoStateRevision: 2,
      pseudoStates: ["hover"],
      manualRefresh: true,
    });
    await expect(runtimeMessages.emit({ type: "styles.evil", requestId: "x" }))
      .resolves.toBeUndefined();

    const onStylesInvalidated = sessionOptions?.onStylesInvalidated as
      | ((event: unknown) => void)
      | undefined;
    const onStylesInspectPublicationRenewed =
      sessionOptions?.onStylesInspectPublicationRenewed as
        | ((event: unknown) => void)
        | undefined;
    onStylesInvalidated?.({
      documentEpoch: 4,
      stylesRevision: 9,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover"],
      reason: "fingerprint-change",
      kind: "stylesheet",
    });
    onStylesInspectPublicationRenewed?.({
      type: "styles.inspectPublicationRenewed",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
    });
    await flushAsync();
    expect(sent).toContainEqual({
      type: "pin-op.styles.event",
      contentSessionId: "content-styles",
      event: {
        type: "styles.invalidated",
        documentEpoch: 4,
        stylesRevision: 9,
        stylesheetRevision: 3,
        pseudoStateRevision: 2,
        pseudoStates: ["hover"],
      },
    });
    expect(sent).toContainEqual({
      type: "pin-op.styles.event",
      contentSessionId: "content-styles",
      event: {
        type: "styles.inspectPublicationRenewed",
        documentEpoch: 4,
        nodeRef: "node-1",
        selectionRevision: 7,
      },
    });
    runtime.dispose();
  });

  it("routes pseudo-state commands only to the local page session", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const sent: unknown[] = [];
    const request = pseudoStatesRequest("pseudo-local");
    pageSession.handle.mockResolvedValue(pseudoStatesResponse(request));
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => { sent.push(message); },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-pseudo",
      createPageInspectionSession: () => pageSession.session,
    });

    await expect(runtimeMessages.emit(request)).resolves.toEqual(
      pseudoStatesResponse(request),
    );
    expect(pageSession.handle).toHaveBeenCalledWith(request);
    expect(sent).toEqual([]);

    runtime.dispose();
  });

  it("cleans page-owned preview artifacts only for the exact lease before acknowledging disposal", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const leasePort = portHarness();
    const order: string[] = [];
    pageSession.clearPseudoStates
      .mockImplementationOnce(() => {
        order.push("pseudo-incomplete");
        return false;
      })
      .mockImplementation(() => {
        order.push("pseudo-complete");
        return true;
      });
    pageSession.dispose.mockImplementation(() => { order.push("page-session"); });
    leasePort.port.disconnect.mockImplementation(() => { order.push("lease"); });
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => leasePort.port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-cleanup",
      createPageInspectionSession: () => pageSession.session,
    });

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.disposeSession",
    })).resolves.toBeUndefined();
    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: "retired-content-session",
    })).resolves.toBe(false);
    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: "content-cleanup",
      extra: true,
    })).resolves.toBeUndefined();
    expect(order).toEqual([]);

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: "content-cleanup",
    })).resolves.toBe(false);
    expect(order).toEqual(["pseudo-incomplete"]);
    expect(runtimeMessages.remove).not.toHaveBeenCalled();
    expect(pageSession.dispose).not.toHaveBeenCalled();
    expect(leasePort.remove).not.toHaveBeenCalled();
    expect(leasePort.port.disconnect).not.toHaveBeenCalled();
    await expect(runtimeMessages.emit({
      type: "dom.getRoot",
      requestId: "still-live-after-incomplete-cleanup",
    })).resolves.toEqual(rootResponse("still-live-after-incomplete-cleanup"));

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: "content-cleanup",
    })).resolves.toBe(true);

    expect(order).toEqual([
      "pseudo-incomplete",
      "pseudo-complete",
      "page-session",
      "lease",
    ]);
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
    expect(leasePort.remove).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("acknowledges an exact lease-bound pseudo cleanup without disposing the local tree", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    pageSession.clearPseudoStates.mockReturnValueOnce(false).mockReturnValue(true);
    const leasePort = portHarness();
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => leasePort.port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-pseudo",
      createPageInspectionSession: () => pageSession.session,
    });

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "retired-content-session",
    })).resolves.toBe(false);
    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-pseudo",
      extra: true,
    })).resolves.toBeUndefined();
    expect(pageSession.clearPseudoStates).not.toHaveBeenCalled();

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-pseudo",
    })).resolves.toBe(false);
    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-pseudo",
    })).resolves.toBe(true);
    expect(pageSession.clearPseudoStates).toHaveBeenCalledTimes(2);
    expect(pageSession.dispose).not.toHaveBeenCalled();
    expect(leasePort.port.disconnect).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it("waits for the matching accepted styles invalidation before acknowledging pseudo cleanup", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const unrelatedPublication = deferred<unknown>();
    const cleanupPublication = deferred<unknown>();
    const sent: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        const stylesRevision = (
          message as { event?: { stylesRevision?: number } }
        ).event?.stylesRevision;
        if (stylesRevision === 9) return await unrelatedPublication.promise;
        if (stylesRevision === 10) return await cleanupPublication.promise;
        return undefined;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-publication",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    const publishInvalidation = sessionOptions?.onStylesInvalidated as
      | ((event: unknown) => unknown)
      | undefined;
    publishInvalidation?.({
      documentEpoch: 4,
      stylesRevision: 9,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover"],
      reason: "unrelated-applicability",
      kind: "applicability",
    });
    pageSession.clearPseudoStates.mockImplementation(() => {
      publishInvalidation?.({
        documentEpoch: 4,
        stylesRevision: 10,
        stylesheetRevision: 3,
        pseudoStateRevision: 3,
        pseudoStates: [],
        reason: "connection-transition",
        kind: "applicability",
      });
      return true;
    });

    const acknowledgements: unknown[] = [];
    const acknowledgement = runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-publication",
    }).then((value) => {
      acknowledgements.push(value);
      return value;
    });
    await flushAsync();
    const beforeEitherPublication = [...acknowledgements];
    unrelatedPublication.resolve({ ok: true });
    await flushAsync();
    const afterUnrelatedPublication = [...acknowledgements];
    cleanupPublication.resolve({ ok: true });

    await expect(acknowledgement).resolves.toBe(true);
    expect(beforeEitherPublication).toEqual([]);
    expect(afterUnrelatedPublication).toEqual([]);
    expect(sent).toEqual([
      {
        type: "pin-op.styles.event",
        contentSessionId: "content-clear-publication",
        event: {
          type: "styles.invalidated",
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 3,
          pseudoStateRevision: 2,
          pseudoStates: ["hover"],
        },
      },
      {
        type: "pin-op.styles.event",
        contentSessionId: "content-clear-publication",
        event: {
          type: "styles.invalidated",
          documentEpoch: 4,
          stylesRevision: 10,
          stylesheetRevision: 3,
          pseudoStateRevision: 3,
          pseudoStates: [],
        },
      },
    ]);
    runtime.dispose();
  });

  it("releases a pseudo cleanup blocked on invalidation acknowledgement when disposed", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const neverAccepted = new Promise<unknown>(() => undefined);
    let sessionOptions: Record<string, unknown> | undefined;
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => await neverAccepted,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-disposed-ack",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.clearPseudoStates.mockImplementation(() => {
      const publishInvalidation = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => unknown)
        | undefined;
      publishInvalidation?.({
        documentEpoch: 4,
        stylesRevision: 10,
        stylesheetRevision: 3,
        pseudoStateRevision: 3,
        pseudoStates: [],
        reason: "connection-transition",
        kind: "applicability",
      });
      return true;
    });

    const acknowledgement = runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-disposed-ack",
    });
    await flushAsync();
    runtime.dispose();

    await expect(acknowledgement).resolves.toBe(false);
  });

  it("rejects pseudo cleanup acknowledgement when its styles invalidation is not accepted", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    let sessionOptions: Record<string, unknown> | undefined;
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-rejected",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.clearPseudoStates.mockImplementation(() => {
      const publishInvalidation = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => unknown)
        | undefined;
      publishInvalidation?.({
        documentEpoch: 4,
        stylesRevision: 10,
        stylesheetRevision: 3,
        pseudoStateRevision: 3,
        pseudoStates: [],
        reason: "connection-transition",
        kind: "applicability",
      });
      return true;
    });

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-rejected",
    })).resolves.toBe(false);

    runtime.dispose();
  });

  it("rejects and reports pseudo cleanup when styles publication throws synchronously", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const reported: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const publicationError = new Error("runtime send failed synchronously");
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: () => {
        throw publicationError;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-sync-publication-error",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
      onError: (error) => reported.push(error),
    });
    pageSession.clearPseudoStates.mockImplementation(() => {
      const publishInvalidation = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => unknown)
        | undefined;
      publishInvalidation?.({
        documentEpoch: 4,
        stylesRevision: 10,
        stylesheetRevision: 3,
        pseudoStateRevision: 3,
        pseudoStates: [],
        reason: "connection-transition",
        kind: "applicability",
      });
      return true;
    });

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-sync-publication-error",
    })).resolves.toBe(false);
    expect(reported).toEqual([publicationError]);

    runtime.dispose();
  });

  it("reports a synchronous pseudo cleanup failure and resolves a negative acknowledgement", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const reported: unknown[] = [];
    const cleanupError = new Error("pseudo cleanup failed synchronously");
    pageSession.clearPseudoStates.mockImplementation(() => {
      throw cleanupError;
    });
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => "content-clear-sync-cleanup-error",
      createPageInspectionSession: () => pageSession.session,
      onError: (error) => reported.push(error),
    });

    await expect(runtimeMessages.emit({
      type: "pin-op.inspect.clearPseudoStates",
      contentSessionId: "content-clear-sync-cleanup-error",
    })).resolves.toBe(false);
    expect(reported).toEqual([cleanupError]);

    runtime.dispose();
  });

  it("is idempotent, owns the inspect lease, and cleans up listeners", async () => {
    const runtimeMessages = messageHarness();
    const leasePort = portHarness();
    const document = documentHarness();
    const pageSession = pageSessionHarness();
    const globalScope = {};
    const sent: unknown[] = [];
    const createContentSessionId = vi.fn(() => "content-session-a");
    let sessionOptions: Record<string, unknown> | undefined;
    const options = {
      globalScope,
      document: document.document,
      location: locationSource(),
      connectRuntimePort: vi.fn(() => leasePort.port),
      sendRuntimeMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId,
      createPageInspectionSession(next: unknown) {
        sessionOptions = next as Record<string, unknown>;
        return pageSession.session;
      },
    };

    const first = startContentScriptRuntime(options);
    const second = startContentScriptRuntime(options);
    expect(second).toBe(first);
    expect(runtimeMessages.subscribe).toHaveBeenCalledOnce();
    expect(createContentSessionId).toHaveBeenCalledOnce();
    expect(sessionOptions?.contentSessionId).toBe("content-session-a");

    await runtimeMessages.emit({ type: "enableInspectMode" });
    expect(options.connectRuntimePort).toHaveBeenCalledWith(
      createInspectContentLeasePortName("content-session-a"),
    );
    expect(pageSession.enablePicker).toHaveBeenCalledOnce();

    const onSelection = sessionOptions?.onSelection as
      | ((selection: unknown) => boolean)
      | undefined;
    const onEvent = sessionOptions?.onEvent as
      | ((event: unknown) => void)
      | undefined;
    expect(onSelection?.({
      nodeRef: "node-card",
      documentEpoch: 1,
      selectionRevision: 7,
      ancestorPath: [
        {
          nodeRef: "node-layout",
          kind: "element",
          nodeType: 1,
          nodeName: "MAIN",
          attributes: [],
          childCount: 1,
          relationship: "dom",
          selectable: true,
          label: "main.layout",
          expandable: true,
          branchRevision: 0,
          locator: elementLocator("main"),
        },
      ],
      payload: inspectPayload(),
    })).toBe(true);
    onEvent?.({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 7,
      nodeRef: "node-card",
      ancestorPath: [
        {
          nodeRef: "node-layout",
          kind: "element",
          nodeType: 1,
          nodeName: "MAIN",
          attributes: [],
          childCount: 1,
          relationship: "dom",
          selectable: true,
          label: "main.layout",
          expandable: true,
          branchRevision: 0,
          locator: elementLocator("main"),
        },
      ],
    });
    await flushAsync();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      type: "elementSelected",
      contentSessionId: "content-session-a",
      documentEpoch: 1,
      nodeRef: "node-card",
      ancestorPath: [
        {
          nodeRef: "node-layout",
          kind: "element",
          nodeType: 1,
          nodeName: "MAIN",
          attributes: [],
          childCount: 1,
          relationship: "dom",
          selectable: true,
          label: "main.layout",
          expandable: true,
          branchRevision: 0,
          locator: elementLocator("main"),
        },
      ],
      selectionRevision: 7,
      payload: {
        context: { url: "https://example.test/page" },
        targets: [{ role: "selected" }],
        ruleEvidence: { rules: [], omittedRuleCount: 0 },
      },
    });
    const publicInspectPayload = JSON.stringify(
      (sent[0] as { payload: unknown }).payload,
    );
    expect(publicInspectPayload).not.toContain("nodeRef");
    expect(publicInspectPayload).not.toContain("ancestorPath");
    expect(publicInspectPayload).not.toContain("dom.selectionChanged");
    expect(publicInspectPayload).not.toContain("dom.getRoot");
    expect(publicInspectPayload).not.toContain("styles.setPseudoStates");
    expect(publicInspectPayload).not.toContain("pseudoStates");
    expect(sent[1]).toEqual({
      type: "pin-op.dom.event",
      contentSessionId: "content-session-a",
      event: {
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 7,
        nodeRef: "node-card",
        ancestorPath: [
          {
            nodeRef: "node-layout",
            kind: "element",
            nodeType: 1,
            nodeName: "MAIN",
            attributes: [],
            childCount: 1,
            relationship: "dom",
            selectable: true,
            label: "main.layout",
            expandable: true,
            branchRevision: 0,
            locator: elementLocator("main"),
          },
        ],
      },
    });

    leasePort.disconnect();
    expect(pageSession.dispose).toHaveBeenCalledOnce();

    first.dispose();
    first.dispose();
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
    expect(leasePort.remove).toHaveBeenCalledOnce();

    const restarted = startContentScriptRuntime(options);
    expect(restarted).not.toBe(first);
    expect(createContentSessionId).toHaveBeenCalledTimes(2);
    restarted.dispose();
  });

  it("reports selection transport failures without leaking an unhandled rejection", async () => {
    const runtimeMessages = messageHarness();
    const document = documentHarness();
    const pageSession = pageSessionHarness();
    const reported: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: document.document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => {
        throw new Error("runtime unavailable");
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
      onError: (error) => reported.push(error),
    });

    const onSelection = sessionOptions?.onSelection as
      | ((selection: unknown) => boolean)
      | undefined;
    onSelection?.({
      nodeRef: "node-card",
      documentEpoch: 1,
      ancestorPath: [],
      payload: inspectPayload(),
    });
    await flushAsync();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(Error);
    runtime.dispose();
  });

  it("keeps one page session alive with picker off and serves DOM requests", async () => {
    const runtimeMessages = messageHarness();
    const leasePort = portHarness();
    const pageSession = pageSessionHarness();
    const createPageInspectionSession = vi.fn(() => pageSession.session);
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: vi.fn(() => leasePort.port),
      sendRuntimeMessage: vi.fn(async () => undefined),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createPageInspectionSession,
    });

    expect(createPageInspectionSession).toHaveBeenCalledOnce();
    expect(pageSession.dispose).not.toHaveBeenCalled();
    expect(pageSession.disablePicker).not.toHaveBeenCalled();

    await runtimeMessages.emit({ type: "disableInspectMode" });
    expect(pageSession.disablePicker).toHaveBeenCalledOnce();
    expect(pageSession.dispose).not.toHaveBeenCalled();

    await expect(runtimeMessages.emit({
      type: "dom.getRoot",
      requestId: "root-1",
    })).resolves.toEqual(rootResponse("root-1"));
    expect(pageSession.handle).toHaveBeenCalledWith({
      type: "dom.getRoot",
      requestId: "root-1",
    });
    expect(pageSession.dispose).not.toHaveBeenCalled();

    leasePort.disconnect();
    expect(pageSession.dispose).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("republishes a live selection and forwards page DOM events", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const sent: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const contentSessionId = "content-session-events";
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        sent.push(message);
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => contentSessionId,
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });

    const republishRequest = {
      type: "pin-op.inspect.republish",
      contentSessionId,
      documentEpoch: 4,
      nodeRef: "node-a",
      selectionRevision: 7,
      republishToken: "republish-events-1",
    };
    pageSession.republishSelection.mockImplementation(async () => {
      const onSelection = sessionOptions?.onSelection as
        | ((selection: unknown) => boolean)
        | undefined;
      return onSelection?.({
        nodeRef: "node-a",
        documentEpoch: 4,
        selectionRevision: 7,
        ancestorPath: [],
        payload: inspectPayload(),
      }) === true;
    });
    await runtimeMessages.emit(republishRequest);
    expect(pageSession.republishSelection).toHaveBeenCalledOnce();
    expect(pageSession.republishSelection).toHaveBeenCalledWith(
      republishRequest,
    );
    await flushAsync();
    expect(sent).toContainEqual({
      type: "elementSelected",
      contentSessionId,
      documentEpoch: 4,
      nodeRef: "node-a",
      ancestorPath: [],
      selectionRevision: 7,
      republishToken: "republish-events-1",
      payload: inspectPayload(),
    });
    await expect(runtimeMessages.emit({
      ...republishRequest,
      contentSessionId: "retired-content-session",
    })).resolves.toBe(false);
    await runtimeMessages.emit({ type: "pin-op.inspect.republish" });
    expect(pageSession.republishSelection).toHaveBeenCalledOnce();

    const onEvent = sessionOptions?.onEvent as
      | ((event: unknown) => void)
      | undefined;
    onEvent?.({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: "node-a",
      summary: "button.save",
    });
    await flushAsync();
    expect(sent).toContainEqual({
      type: "pin-op.dom.event",
      contentSessionId,
      event: {
        type: "dom.hoverChanged",
        documentEpoch: 1,
        nodeRef: "node-a",
        summary: "button.save",
      },
    });
    runtime.dispose();
  });

  it("awaits exact background acceptance for a tokened republish", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const accepted = deferred<unknown>();
    let sessionOptions: Record<string, unknown> | undefined;
    const contentSessionId = "content-session-republish-ack";
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) =>
        (message as { readonly type?: unknown }).type === "elementSelected"
          ? await accepted.promise
          : undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => contentSessionId,
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    const request = {
      type: "pin-op.inspect.republish",
      contentSessionId,
      documentEpoch: 4,
      nodeRef: "node-ack",
      selectionRevision: 7,
      republishToken: "republish-ack-1",
    };
    pageSession.republishSelection.mockImplementation(async () => {
      const onSelection = sessionOptions?.onSelection as
        | ((selection: unknown) => boolean)
        | undefined;
      return onSelection?.({
        nodeRef: request.nodeRef,
        documentEpoch: request.documentEpoch,
        selectionRevision: request.selectionRevision,
        ancestorPath: [],
        payload: inspectPayload(),
      }) === true;
    });

    const pending = runtimeMessages.emit(request);
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await flushAsync();
    expect(settled).toBe(false);

    accepted.resolve(undefined);
    await expect(pending).resolves.toBe(false);
    runtime.dispose();
  });
});

describe("startContentRefreshRuntime", () => {
  it("runs style refresh for one exact top-frame binding without an inspect port", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const sent: unknown[] = [];
    const clearOverlay = vi.fn();
    const refreshStylesheets = vi.fn(async () => Object.freeze({
      attempted: 2,
      updated: 1,
      failed: 1,
    }));
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 21,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        return undefined;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
      refreshStylesheets,
    });
    await flushAsync();
    expect(sent).toEqual([{
      type: "pin-op.refresh.content.ready",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
    }]);

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      refreshCommandId: "command-a",
      refreshGeneration: 5,
      mode: "styles",
    })).resolves.toEqual({
      type: "pin-op.refresh.content.result",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      refreshCommandId: "command-a",
      refreshGeneration: 5,
      mode: "styles",
      accepted: true,
      stylesheet: { attempted: 2, updated: 1, failed: 1 },
    });
    expect(clearOverlay).toHaveBeenCalledOnce();
    expect(refreshStylesheets).toHaveBeenCalledWith(
      page.document,
      5,
      {
        signal: expect.any(AbortSignal),
        beforeControlledTransition: expect.any(Function),
        onStylesheetsUpdated: expect.any(Function),
      },
    );

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "another-runtime",
      refreshCommandId: "command-b",
      refreshGeneration: 6,
      mode: "styles",
    })).resolves.toBeUndefined();
    expect(clearOverlay).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
  });

  it("captures and requests an exact background reload without treating acceptance as navigation", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    page.view.scrollX = 34;
    page.view.scrollY = 78;
    const clearOverlay = vi.fn();
    const reload = vi.fn();
    page.view.location = { reload };
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 22,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      now: () => 2_000,
      sendRuntimeMessage: async (message) => {
        if ((message as { type?: string }).type === "pin-op.refresh.content.ready") {
          return undefined;
        }
        expect(message).toEqual({
          type: "pin-op.refresh.reload.request",
          tabId: 22,
          frameId: 0,
          pageUrl: "https://example.test/page",
          contentRuntimeId: "refresh-runtime-b",
          refreshCommandId: "command-c",
          refreshGeneration: 8,
          snapshot: {
            tabId: 22,
            url: "https://example.test/page",
            refreshGeneration: 8,
            scrollX: 34,
            scrollY: 78,
            createdAt: 2_000,
          },
        });
        return {
          type: "pin-op.refresh.reload.result",
          tabId: 22,
          frameId: 0,
          pageUrl: "https://example.test/page",
          contentRuntimeId: "refresh-runtime-b",
          refreshCommandId: "command-c",
          refreshGeneration: 8,
          accepted: true,
        };
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
    });
    await flushAsync();

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      refreshCommandId: "command-c",
      refreshGeneration: 8,
      mode: "reload",
    })).resolves.toEqual({
      type: "pin-op.refresh.content.result",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      refreshCommandId: "command-c",
      refreshGeneration: 8,
      mode: "reload",
      accepted: true,
    });
    expect(clearOverlay).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("releases a reload blocked in cleanup when the runtime is disposed", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const cleanup = deferred<boolean>();
    const clearOverlay = vi.fn(() => cleanup.promise);
    const sendRuntimeMessage = vi.fn(async () => undefined);
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 22,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-reload-dispose",
      sendRuntimeMessage,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
    });
    await flushAsync();
    let resultSettled = false;
    const pending = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-reload-dispose",
      refreshCommandId: "reload-dispose",
      refreshGeneration: 9,
      mode: "reload",
    }).then((result) => {
      resultSettled = true;
      return result;
    });
    await flushAsync();

    runtime.dispose();
    await flushAsync();
    const settledBeforeCleanupAcknowledgement = resultSettled;
    cleanup.resolve(true);

    await expect(pending).resolves.toBeUndefined();
    expect(settledBeforeCleanupAcknowledgement).toBe(true);
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1);
  });

  it("starts a superseding reload before the previous cleanup acknowledgement settles", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const firstCleanup = deferred<boolean>();
    const clearOverlay = vi.fn()
      .mockImplementationOnce(() => firstCleanup.promise)
      .mockReturnValue(true);
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 22,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-reload-superseded",
      sendRuntimeMessage: async (message) => {
        const request = message as {
          readonly type?: string;
          readonly refreshCommandId?: string;
          readonly refreshGeneration?: number;
        };
        if (request.type !== "pin-op.refresh.reload.request") return undefined;
        return {
          type: "pin-op.refresh.reload.result",
          tabId: 22,
          frameId: 0,
          pageUrl: "https://example.test/page",
          contentRuntimeId: "refresh-runtime-reload-superseded",
          refreshCommandId: request.refreshCommandId,
          refreshGeneration: request.refreshGeneration,
          accepted: true,
        };
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
    });
    await flushAsync();
    const execute = (generation: number) => runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-reload-superseded",
      refreshCommandId: `reload-superseded-${generation}`,
      refreshGeneration: generation,
      mode: "reload",
    });

    const first = execute(10);
    await flushAsync();
    expect(clearOverlay).toHaveBeenCalledTimes(1);
    const second = execute(11);
    await flushAsync();
    const secondStartedBeforeFirstAcknowledgement =
      clearOverlay.mock.calls.length === 2;
    firstCleanup.resolve(true);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toMatchObject({
      accepted: true,
      refreshGeneration: 11,
      mode: "reload",
    });
    expect(secondStartedBeforeFirstAcknowledgement).toBe(true);
    runtime.dispose();
  });

  it("claims a background-leased snapshot on ready and restores it once", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const snapshot = {
      tabId: 23,
      url: "https://example.test/page",
      refreshGeneration: 11,
      scrollX: 1,
      scrollY: 2,
      createdAt: 3_000,
    } as const;
    const restoration = { dispose: vi.fn() };
    const restoreScroll = vi.fn(() => restoration);
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 23,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-c",
      sendRuntimeMessage: async () => ({
        type: "pin-op.refresh.scroll.restore",
        tabId: 23,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "refresh-runtime-c",
        refreshGeneration: 11,
        snapshot,
      }),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      restoreScroll,
    });
    await flushAsync();
    expect(restoreScroll).toHaveBeenCalledOnce();
    expect(restoreScroll).toHaveBeenCalledWith(snapshot, {
      document: page.document,
      view: page.view,
    });
    runtime.dispose();
    expect(restoration.dispose).toHaveBeenCalledOnce();
  });

  it("clears a colocated inspection overlay without coupling refresh lifetime to its port", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createPageInspectionSession: () => pageSession.session,
    });
    const page = refreshPageHarness();
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async () => ({ attempted: 0, updated: 0, failed: 0 }),
    });
    await flushAsync();

    await refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      refreshCommandId: "command-d",
      refreshGeneration: 12,
      mode: "styles",
    });
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledOnce();

    inspectRuntime.dispose();
    expect(pageSession.dispose).toHaveBeenCalledOnce();
    await refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      refreshCommandId: "command-e",
      refreshGeneration: 13,
      mode: "styles",
    });
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledOnce();
    refreshRuntime.dispose();
  });

  it("runs each stylesheet refresh through one cleanup and advances stylesheet identity only for an author refresh", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const sent: unknown[] = [];
    const transitionHooks: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    let stylesRevision = 8;
    let stylesheetRevision = 3;
    let pseudoStateRevision = 2;
    let pseudoStates: readonly string[] = ["hover"];
    const publishInvalidation = (
      reason: string,
      kind: "applicability" | "stylesheet",
    ): unknown => {
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => unknown)
        | undefined;
      return publish?.({
        documentEpoch: 4,
        stylesRevision,
        stylesheetRevision,
        pseudoStateRevision,
        pseudoStates,
        reason,
        kind,
      });
    };
    pageSession.clearOverlayForRefresh.mockImplementation(() => {
      if (pseudoStates.length === 0) return;
      pseudoStates = [];
      pseudoStateRevision += 1;
      stylesRevision += 1;
      publishInvalidation("soft-refresh", "applicability");
    });
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      stylesheetRevision += 1;
      stylesRevision += 1;
      publishInvalidation("author-refresh", "stylesheet");
      return true;
    });
    const refreshStylesheets = vi.fn(async (
      _document: Document,
      generation: number,
      refreshOptions?: {
        readonly beforeControlledTransition?: () => unknown;
        readonly onStylesheetsUpdated?: () => void;
      },
    ) => {
      transitionHooks.push(refreshOptions?.beforeControlledTransition);
      await refreshOptions?.beforeControlledTransition?.();
      if (generation === 14) {
        refreshOptions?.onStylesheetsUpdated?.();
        return Object.freeze({ attempted: 1, updated: 1, failed: 0 });
      }
      return Object.freeze({ attempted: 0, updated: 0, failed: 0 });
    });
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        return (message as { type?: string }).type === "pin-op.styles.event"
          ? { ok: true }
          : undefined;
      },
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-refresh-revisions",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-revisions",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();

    for (const generation of [13, 14]) {
      await expect(refreshMessages.emit({
        type: "pin-op.refresh.content.execute",
        tabId: 24,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "refresh-runtime-revisions",
        refreshCommandId: `command-${generation}`,
        refreshGeneration: generation,
        mode: "styles",
      })).resolves.toMatchObject({ accepted: true });
    }
    await flushAsync();

    expect(transitionHooks).toEqual([expect.any(Function), expect.any(Function)]);
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledTimes(2);
    expect(sent.filter((message) =>
      (message as { type?: string }).type === "pin-op.styles.event"
    )).toEqual([
      {
        type: "pin-op.styles.event",
        contentSessionId: "content-refresh-revisions",
        event: {
          type: "styles.invalidated",
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 3,
          pseudoStateRevision: 3,
          pseudoStates: [],
        },
      },
      {
        type: "pin-op.styles.event",
        contentSessionId: "content-refresh-revisions",
        event: {
          type: "styles.invalidated",
          documentEpoch: 4,
          stylesRevision: 10,
          stylesheetRevision: 4,
          pseudoStateRevision: 3,
          pseudoStates: [],
        },
      },
    ]);

    refreshRuntime.dispose();
    inspectRuntime.dispose();
  });

  it("settles changed stylesheet refreshes only after the newer invalidation is accepted", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const latePublication = deferred<unknown>();
    const earlyRefreshCompletion = deferred<{
      attempted: number;
      updated: number;
      failed: number;
    }>();
    let sessionOptions: Record<string, unknown> | undefined;
    let stylesheetRevision = 3;
    let stylesRevision = 8;
    const publishApplicabilityInvalidation = (): void => {
      stylesRevision += 1;
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision,
        stylesheetRevision,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "unrelated-applicability",
        kind: "applicability",
      });
    };
    const publishStylesheetInvalidation = (): void => {
      stylesheetRevision += 1;
      stylesRevision += 1;
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision,
        stylesheetRevision,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
    };
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      publishStylesheetInvalidation();
      return true;
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-barrier",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async (_document, generation, refreshOptions) => {
        if (generation === 21) {
          queueMicrotask(publishApplicabilityInvalidation);
          refreshOptions?.onStylesheetsUpdated?.();
          return { attempted: 1, updated: 1, failed: 0 };
        }
        if (generation === 22) {
          return { attempted: 1, updated: 1, failed: 0 };
        }
        if (generation === 23) {
          refreshOptions?.onStylesheetsUpdated?.();
          return { attempted: 1, updated: 1, failed: 0 };
        }
        if (generation === 24) {
          refreshOptions?.onStylesheetsUpdated?.();
          return await earlyRefreshCompletion.promise;
        }
        return { attempted: 0, updated: 0, failed: 0 };
      },
    });
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        const revision = (message as {
          event?: { readonly stylesheetRevision?: number };
        }).event?.stylesheetRevision;
        if (revision === 4) return await latePublication.promise;
        if (revision === 5) return { ok: false };
        return { ok: true };
      },
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-refresh-barrier",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    publishApplicabilityInvalidation();
    await flushAsync();
    const execute = (refreshGeneration: number) => refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-barrier",
      refreshCommandId: `barrier-${refreshGeneration}`,
      refreshGeneration,
      mode: "styles",
    });

    await expect(execute(20)).resolves.toMatchObject({ accepted: true });

    let lateResultSettled = false;
    const lateResult = execute(21).then((result) => {
      lateResultSettled = true;
      return result;
    });
    await flushAsync();
    expect(lateResultSettled).toBe(false);
    latePublication.resolve({ ok: true });
    await expect(lateResult).resolves.toMatchObject({ accepted: true });

    await expect(execute(22)).resolves.toMatchObject({ accepted: false });
    await expect(execute(23)).resolves.toMatchObject({ accepted: false });

    let earlyResultSettled = false;
    const earlyResult = execute(24).then((result) => {
      earlyResultSettled = true;
      return result;
    });
    await flushAsync();
    expect(earlyResultSettled).toBe(false);
    earlyRefreshCompletion.resolve({ attempted: 1, updated: 1, failed: 0 });
    await expect(earlyResult).resolves.toMatchObject({ accepted: true });

    refreshRuntime.dispose();
    inspectRuntime.dispose();
  });

  it.each([
    { applicabilityCount: 256, accepted: true },
    { applicabilityCount: 527, accepted: true },
    { applicabilityCount: 528, accepted: false },
  ])(
    "bounds one stylesheet advance plus $applicabilityCount applicability invalidations as accepted=$accepted",
    async ({ applicabilityCount, accepted }) => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const stylesheetAcceptance = deferred<unknown>();
    const applicabilityAcceptance = deferred<unknown>();
    const sendRuntimeMessage = vi.fn(async (message: unknown) => {
      const stylesRevision = (message as {
        readonly event?: { readonly stylesRevision?: number };
      }).event?.stylesRevision;
      return await (stylesRevision === 9
        ? stylesheetAcceptance.promise
        : applicabilityAcceptance.promise);
    });
    let sessionOptions: Record<string, unknown> | undefined;
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage,
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-refresh-history",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision: 9,
        stylesheetRevision: 4,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
      for (let index = 0; index < applicabilityCount; index += 1) {
        publish?.({
          documentEpoch: 4,
          stylesRevision: 10 + index,
          stylesheetRevision: 4,
          pseudoStateRevision: 3 + index,
          pseudoStates: ["hover"],
          reason: "pseudo-change",
          kind: "applicability",
        });
      }
      return true;
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-history",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async (_document, _generation, refreshOptions) => {
        refreshOptions?.onStylesheetsUpdated?.();
        return { attempted: 1, updated: 1, failed: 0 };
      },
    });
    await flushAsync();

    const pendingResult = refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-history",
      refreshCommandId: "history-27",
      refreshGeneration: 27,
      mode: "styles",
    });
    let settled = false;
    void pendingResult.finally(() => { settled = true; });
    await flushAsync();
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(applicabilityCount + 1);
    expect(settled).toBe(false);

    applicabilityAcceptance.resolve({ ok: true });
    await flushAsync();
    expect(settled).toBe(false);

    stylesheetAcceptance.resolve({ ok: true });
    await expect(pendingResult).resolves.toMatchObject({
      accepted,
      refreshCommandId: "history-27",
      refreshGeneration: 27,
    });

    refreshRuntime.dispose();
    inspectRuntime.dispose();
    },
  );

  it.each([
    { stylesheetAccepted: false, applicabilityAccepted: true },
    { stylesheetAccepted: true, applicabilityAccepted: false },
  ])(
    "rejects refresh ownership when stylesheet=$stylesheetAccepted and applicability=$applicabilityAccepted",
    async ({ stylesheetAccepted, applicabilityAccepted }) => {
      const globalScope = {};
      const inspectMessages = messageHarness();
      const refreshMessages = messageHarness();
      const pageSession = pageSessionHarness();
      const page = refreshPageHarness();
      let sessionOptions: Record<string, unknown> | undefined;
      const inspectRuntime = startContentScriptRuntime({
        globalScope,
        document: documentHarness().document,
        location: locationSource(),
        connectRuntimePort: () => portHarness().port,
        sendRuntimeMessage: async (message) => {
          const stylesRevision = (message as {
            readonly event?: { readonly stylesRevision?: number };
          }).event?.stylesRevision;
          return {
            ok: stylesRevision === 9
              ? stylesheetAccepted
              : applicabilityAccepted,
          };
        },
        subscribeRuntimeMessages: inspectMessages.subscribe,
        createContentSessionId: () => "content-refresh-polarity",
        createPageInspectionSession(options) {
          sessionOptions = options as unknown as Record<string, unknown>;
          return pageSession.session;
        },
      });
      pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
        const publish = sessionOptions?.onStylesInvalidated as
          | ((event: unknown) => void)
          | undefined;
        publish?.({
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 4,
          pseudoStateRevision: 2,
          pseudoStates: [],
          reason: "author-refresh",
          kind: "stylesheet",
        });
        publish?.({
          documentEpoch: 4,
          stylesRevision: 10,
          stylesheetRevision: 4,
          pseudoStateRevision: 3,
          pseudoStates: ["hover"],
          reason: "pseudo-change",
          kind: "applicability",
        });
        return true;
      });
      const refreshRuntime = startContentRefreshRuntime({
        globalScope,
        document: page.document,
        view: page.view,
        tabId: 24,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "refresh-runtime-polarity",
        sendRuntimeMessage: async () => undefined,
        subscribeRuntimeMessages: refreshMessages.subscribe,
        refreshStylesheets: async (_document, _generation, refreshOptions) => {
          refreshOptions?.onStylesheetsUpdated?.();
          return { attempted: 1, updated: 1, failed: 0 };
        },
      });
      await flushAsync();

      await expect(refreshMessages.emit({
        type: "pin-op.refresh.content.execute",
        tabId: 24,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "refresh-runtime-polarity",
        refreshCommandId: "polarity-28",
        refreshGeneration: 28,
        mode: "styles",
      })).resolves.toMatchObject({ accepted: false });

      refreshRuntime.dispose();
      inspectRuntime.dispose();
    },
  );

  it("releases a refresh blocked on invalidation acknowledgement when superseded", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const neverAccepted = new Promise<unknown>(() => {});
    let sessionOptions: Record<string, unknown> | undefined;
    let stylesRevision = 8;
    let stylesheetRevision = 3;
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: vi.fn(async () =>
        stylesRevision === 9 ? await neverAccepted : { ok: true }
      ),
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-refresh-superseded-ack",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      stylesRevision += 1;
      stylesheetRevision += 1;
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision,
        stylesheetRevision,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
      return true;
    });
    const refreshStylesheets = vi.fn(async (
      _document: Document,
      _generation: number,
      refreshOptions?: { readonly onStylesheetsUpdated?: () => void },
    ) => {
      refreshOptions?.onStylesheetsUpdated?.();
      return { attempted: 1, updated: 1, failed: 0 };
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-superseded-ack",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const execute = (generation: number) => refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-superseded-ack",
      refreshCommandId: `superseded-ack-${generation}`,
      refreshGeneration: generation,
      mode: "styles",
    });

    const first = execute(29);
    await vi.waitFor(() => expect(refreshStylesheets).toHaveBeenCalledTimes(1));
    const second = execute(30);
    await vi.waitFor(() => expect(refreshStylesheets).toHaveBeenCalledTimes(2));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toMatchObject({
      accepted: true,
      refreshGeneration: 30,
    });

    refreshRuntime.dispose();
    inspectRuntime.dispose();
  });

  it("runs a superseding refresh while the previous cleanup acknowledgement is pending", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const firstCleanupAcknowledgement = deferred<unknown>();
    let sessionOptions: Record<string, unknown> | undefined;
    let stylesRevision = 8;
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        const revision = (
          message as { event?: { stylesRevision?: number } }
        ).event?.stylesRevision;
        return revision === 9
          ? await firstCleanupAcknowledgement.promise
          : { ok: true };
      },
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-refresh-cleanup-superseded",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.clearOverlayForRefresh.mockImplementation(() => {
      stylesRevision += 1;
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision,
        stylesheetRevision: 3,
        pseudoStateRevision: stylesRevision - 6,
        pseudoStates: [],
        reason: "soft-refresh",
        kind: "applicability",
      });
      return true;
    });
    const refreshStylesheets = vi.fn(async () => ({
      attempted: 0,
      updated: 0,
      failed: 0,
    }));
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-cleanup-superseded",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const execute = (generation: number) => refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-cleanup-superseded",
      refreshCommandId: `cleanup-superseded-${generation}`,
      refreshGeneration: generation,
      mode: "styles",
    });

    const first = execute(31);
    await flushAsync();
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledTimes(1);
    const second = execute(32);
    await flushAsync();
    const secondStartedBeforeFirstAcknowledgement =
      pageSession.clearOverlayForRefresh.mock.calls.length === 2 &&
      refreshStylesheets.mock.calls.length === 1;
    firstCleanupAcknowledgement.resolve({ ok: true });

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toMatchObject({
      accepted: true,
      refreshGeneration: 32,
    });
    expect(secondStartedBeforeFirstAcknowledgement).toBe(true);
    expect(refreshStylesheets.mock.calls.map((call) => call[1])).toEqual([32]);

    refreshRuntime.dispose();
    inspectRuntime.dispose();
  });

  it("commits through an inspect barrier that appears while stylesheets load", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const refreshStarted = deferred<void>();
    const finishRefresh = deferred<void>();
    const invalidationAcknowledgement = deferred<unknown>();
    const sendRuntimeMessage = vi.fn(async () =>
      await invalidationAcknowledgement.promise
    );
    let sessionOptions: Record<string, unknown> | undefined;
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-late-barrier",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async (_document, _generation, refreshOptions) => {
        refreshStarted.resolve();
        await finishRefresh.promise;
        refreshOptions?.onStylesheetsUpdated?.();
        return { attempted: 1, updated: 1, failed: 0 };
      },
    });
    await flushAsync();
    const pending = refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-late-barrier",
      refreshCommandId: "late-barrier-31",
      refreshGeneration: 31,
      mode: "styles",
    });
    await refreshStarted.promise;

    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage,
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-late-barrier",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision: 9,
        stylesheetRevision: 4,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
      return true;
    });

    let settled = false;
    void pending.finally(() => { settled = true; });
    finishRefresh.resolve();
    await vi.waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    invalidationAcknowledgement.resolve({ ok: true });
    await expect(pending).resolves.toMatchObject({
      accepted: true,
      refreshGeneration: 31,
    });

    inspectRuntime.dispose();
    refreshRuntime.dispose();
  });

  it("releases a refresh acknowledgement when its inspect barrier is disposed", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    const neverAccepted = new Promise<unknown>(() => {});
    const sendRuntimeMessage = vi.fn(async () => await neverAccepted);
    let sessionOptions: Record<string, unknown> | undefined;
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage,
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-disposed-barrier",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
      const publish = sessionOptions?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision: 9,
        stylesheetRevision: 4,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
      return true;
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-disposed-barrier",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async (_document, _generation, refreshOptions) => {
        refreshOptions?.onStylesheetsUpdated?.();
        return { attempted: 1, updated: 1, failed: 0 };
      },
    });
    await flushAsync();
    let result: unknown;
    let settled = false;
    const pending = refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-disposed-barrier",
      refreshCommandId: "disposed-barrier-32",
      refreshGeneration: 32,
      mode: "styles",
    }).then((value) => {
      result = value;
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      inspectRuntime.dispose();
      await vi.waitFor(() => expect(settled).toBe(true));
      await pending;
      expect(result).toMatchObject({ accepted: false, refreshGeneration: 32 });
    } finally {
      refreshRuntime.dispose();
      inspectRuntime.dispose();
    }
  });

  it("uses the replacement inspect invalidation barrier for a live refresh runtime", async () => {
    const globalScope = {};
    const inspectMessagesA = messageHarness();
    const inspectMessagesB = messageHarness();
    const refreshMessages = messageHarness();
    const pageSessionA = pageSessionHarness();
    const pageSessionB = pageSessionHarness();
    const page = refreshPageHarness();
    const refreshStarted = deferred<void>();
    const finishRefresh = deferred<void>();
    const authorInvalidationAcknowledgementB = deferred<unknown>();
    const sentByB: unknown[] = [];
    let sessionOptionsB: Record<string, unknown> | undefined;

    const inspectRuntimeA = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => ({ ok: true }),
      subscribeRuntimeMessages: inspectMessagesA.subscribe,
      createContentSessionId: () => "content-barrier-a",
      createPageInspectionSession: () => pageSessionA.session,
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-barrier-replacement",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async (_document, _generation, refreshOptions) => {
        refreshStarted.resolve();
        await finishRefresh.promise;
        const publish = sessionOptionsB?.onStylesInvalidated as
          | ((event: unknown) => void)
          | undefined;
        publish?.({
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 3,
          pseudoStateRevision: 2,
          pseudoStates: [],
          reason: "unrelated-applicability",
          kind: "applicability",
        });
        refreshOptions?.onStylesheetsUpdated?.();
        return { attempted: 1, updated: 1, failed: 0 };
      },
    });
    await flushAsync();

    let result: unknown;
    let settled = false;
    const pendingResult = refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-barrier-replacement",
      refreshCommandId: "barrier-replacement",
      refreshGeneration: 25,
      mode: "styles",
    }).then((value) => {
      result = value;
      settled = true;
    });
    await refreshStarted.promise;

    inspectRuntimeA.dispose();
    const inspectRuntimeB = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      subscribeRuntimeMessages: inspectMessagesB.subscribe,
      createContentSessionId: () => "content-barrier-b",
      createPageInspectionSession(options) {
        sessionOptionsB = options as unknown as Record<string, unknown>;
        return pageSessionB.session;
      },
      sendRuntimeMessage: async (message) => {
        sentByB.push(message);
        const stylesheetRevision = (message as {
          readonly event?: { readonly stylesheetRevision?: number };
        }).event?.stylesheetRevision;
        return stylesheetRevision === 4
          ? await authorInvalidationAcknowledgementB.promise
          : { ok: true };
      },
    });
    pageSessionB.invalidateStylesheetsForRefresh.mockImplementation(() => {
      const publish = sessionOptionsB?.onStylesInvalidated as
        | ((event: unknown) => void)
        | undefined;
      publish?.({
        documentEpoch: 4,
        stylesRevision: 10,
        stylesheetRevision: 4,
        pseudoStateRevision: 2,
        pseudoStates: [],
        reason: "author-refresh",
        kind: "stylesheet",
      });
      return true;
    });
    finishRefresh.resolve();
    await flushAsync();

    expect(settled).toBe(false);
    expect(pageSessionA.clearOverlayForRefresh).toHaveBeenCalledOnce();
    expect(pageSessionB.clearOverlayForRefresh).not.toHaveBeenCalled();
    expect(sentByB[0]).toEqual({
      type: "pin-op.styles.event",
      contentSessionId: "content-barrier-b",
      event: {
        type: "styles.invalidated",
        documentEpoch: 4,
        stylesRevision: 9,
        stylesheetRevision: 3,
        pseudoStateRevision: 2,
        pseudoStates: [],
      },
    });
    expect(sentByB).toHaveLength(2);
    expect(sentByB[1]).toMatchObject({
      type: "pin-op.styles.event",
      contentSessionId: "content-barrier-b",
      event: {
        stylesheetRevision: 4,
      },
    });

    authorInvalidationAcknowledgementB.resolve({ ok: true });
    await flushAsync();
    expect(settled).toBe(true);
    await pendingResult;

    expect(result).toMatchObject({
      accepted: true,
      refreshGeneration: 25,
      stylesheet: { attempted: 1, updated: 1, failed: 0 },
    });

    inspectRuntimeB.dispose();
    refreshRuntime.dispose();
  });

  it.each([
    ["stylesheet", true],
    ["applicability", false],
  ] as const)(
    "settles a fresh changed refresh from one %s invalidation as accepted=%s",
    async (kind, accepted) => {
      const globalScope = {};
      const inspectMessages = messageHarness();
      const refreshMessages = messageHarness();
      const pageSession = pageSessionHarness();
      const page = refreshPageHarness();
      let sessionOptions: Record<string, unknown> | undefined;
      const inspectRuntime = startContentScriptRuntime({
        globalScope,
        document: documentHarness().document,
        location: locationSource(),
        connectRuntimePort: () => portHarness().port,
        sendRuntimeMessage: async () => ({ ok: true }),
        subscribeRuntimeMessages: inspectMessages.subscribe,
        createContentSessionId: () => `content-fresh-${kind}`,
        createPageInspectionSession(options) {
          sessionOptions = options as unknown as Record<string, unknown>;
          return pageSession.session;
        },
      });
      pageSession.invalidateStylesheetsForRefresh.mockImplementation(() => {
        const publish = sessionOptions?.onStylesInvalidated as
          | ((event: unknown) => void)
          | undefined;
        publish?.({
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 4,
          pseudoStateRevision: 2,
          pseudoStates: [],
          reason: `${kind}-only`,
          kind,
        });
        return true;
      });
      const refreshRuntime = startContentRefreshRuntime({
        globalScope,
        document: page.document,
        view: page.view,
        tabId: 24,
        pageUrl: "https://example.test/page",
        contentRuntimeId: `refresh-runtime-fresh-${kind}`,
        sendRuntimeMessage: async () => undefined,
        subscribeRuntimeMessages: refreshMessages.subscribe,
        refreshStylesheets: async (_document, _generation, refreshOptions) => {
          refreshOptions?.onStylesheetsUpdated?.();
          return { attempted: 1, updated: 1, failed: 0 };
        },
      });
      await flushAsync();

      await expect(refreshMessages.emit({
        type: "pin-op.refresh.content.execute",
        tabId: 24,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: `refresh-runtime-fresh-${kind}`,
        refreshCommandId: `fresh-${kind}`,
        refreshGeneration: 26,
        mode: "styles",
      })).resolves.toMatchObject({ accepted });

      refreshRuntime.dispose();
      inspectRuntime.dispose();
    },
  );

  it("does not accept an unrelated stylesheet invalidation as refresh ownership", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const page = refreshPageHarness();
    let sessionOptions: Record<string, unknown> | undefined;
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => ({ ok: true }),
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createContentSessionId: () => "content-unrelated-stylesheet",
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-unrelated-stylesheet",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async () => {
        const publish = sessionOptions?.onStylesInvalidated as
          | ((event: unknown) => void)
          | undefined;
        publish?.({
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 4,
          pseudoStateRevision: 2,
          pseudoStates: [],
          reason: "unrelated-fingerprint-change",
          kind: "stylesheet",
        });
        return { attempted: 1, updated: 1, failed: 0 };
      },
    });
    await flushAsync();

    await expect(refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-unrelated-stylesheet",
      refreshCommandId: "unrelated-stylesheet",
      refreshGeneration: 27,
      mode: "styles",
    })).resolves.toMatchObject({ accepted: false });

    refreshRuntime.dispose();
    inspectRuntime.dispose();
  });

  it("revokes a queued refresh command when its runtime is disposed", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const refreshStylesheets = vi.fn(async () => ({
      attempted: 0,
      updated: 0,
      failed: 0,
    }));
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 25,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-e",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();

    const pending = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 25,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-e",
      refreshCommandId: "command-f",
      refreshGeneration: 14,
      mode: "styles",
    });
    runtime.dispose();

    await expect(pending).resolves.toBeUndefined();
    expect(refreshStylesheets).not.toHaveBeenCalled();
  });

  it("aborts an in-flight stylesheet refresh when disposed", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    let signal: AbortSignal | undefined;
    let resolveRefresh: ((result: {
      attempted: number;
      updated: number;
      failed: number;
    }) => void) | undefined;
    const refreshStylesheets = vi.fn((
      _document: Document,
      _generation: number,
      options?: { readonly signal?: AbortSignal },
    ) => {
      signal = options?.signal;
      return new Promise<{ attempted: number; updated: number; failed: number }>(
        (resolve) => {
          resolveRefresh = resolve;
          signal?.addEventListener("abort", () => resolve({
            attempted: 1,
            updated: 0,
            failed: 1,
          }), { once: true });
        },
      );
    });
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 26,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-f",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const pending = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 26,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-f",
      refreshCommandId: "command-g",
      refreshGeneration: 15,
      mode: "styles",
    });
    await flushAsync();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    runtime.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    resolveRefresh?.({ attempted: 1, updated: 0, failed: 1 });
  });

  it("aborts an in-flight stylesheet refresh superseded by a newer command", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((result: {
      attempted: number;
      updated: number;
      failed: number;
    }) => void) | undefined;
    const refreshStylesheets = vi.fn((
      _document: Document,
      generation: number,
      options?: { readonly signal?: AbortSignal },
    ) => {
      if (generation !== 16) {
        return Promise.resolve({ attempted: 1, updated: 1, failed: 0 });
      }
      firstSignal = options?.signal;
      return new Promise<{ attempted: number; updated: number; failed: number }>(
        (resolve) => {
          resolveFirst = resolve;
          firstSignal?.addEventListener("abort", () => resolve({
            attempted: 1,
            updated: 0,
            failed: 1,
          }), { once: true });
        },
      );
    });
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 27,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const first = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 27,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      refreshCommandId: "command-h",
      refreshGeneration: 16,
      mode: "styles",
    });
    await flushAsync();
    const second = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 27,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      refreshCommandId: "command-i",
      refreshGeneration: 17,
      mode: "styles",
    });
    await flushAsync();
    const firstWasAborted = firstSignal?.aborted ?? false;
    if (!firstWasAborted) {
      resolveFirst?.({ attempted: 1, updated: 0, failed: 1 });
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);
    runtime.dispose();

    expect(firstWasAborted).toBe(true);
    expect(firstResult).toBeUndefined();
    expect(secondResult).toMatchObject({
      accepted: true,
      refreshGeneration: 17,
      mode: "styles",
      stylesheet: { attempted: 1, updated: 1, failed: 0 },
    });
    expect(refreshStylesheets.mock.calls.map((call) => call[1])).toEqual([16, 17]);
  });

  it("replaces a global runtime when its authoritative URL or runtime identity changes", async () => {
    const globalScope = {};
    const page = refreshPageHarness();
    const firstMessages = messageHarness();
    const secondMessages = messageHarness();
    const thirdMessages = messageHarness();
    const base = {
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 28,
      sendRuntimeMessage: async () => undefined,
      refreshStylesheets: async () => ({ attempted: 1, updated: 1, failed: 0 }),
    } as const;
    const first = startContentRefreshRuntime({
      ...base,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-h",
      subscribeRuntimeMessages: firstMessages.subscribe,
    });
    const second = startContentRefreshRuntime({
      ...base,
      pageUrl: "https://example.test/page#state",
      contentRuntimeId: "refresh-runtime-h",
      subscribeRuntimeMessages: secondMessages.subscribe,
    });
    const third = startContentRefreshRuntime({
      ...base,
      pageUrl: "https://example.test/page#state",
      contentRuntimeId: "refresh-runtime-i",
      subscribeRuntimeMessages: thirdMessages.subscribe,
    });

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(firstMessages.remove).toHaveBeenCalledOnce();
    expect(secondMessages.remove).toHaveBeenCalledOnce();
    await expect(thirdMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 28,
      frameId: 0,
      pageUrl: "https://example.test/page#state",
      contentRuntimeId: "refresh-runtime-i",
      refreshCommandId: "command-j",
      refreshGeneration: 18,
      mode: "styles",
    })).resolves.toMatchObject({
      type: "pin-op.refresh.content.result",
      pageUrl: "https://example.test/page#state",
      contentRuntimeId: "refresh-runtime-i",
      refreshCommandId: "command-j",
      accepted: true,
    });
    third.dispose();
  });
});

describe("startContentRefreshBootstrapRuntime", () => {
  it("binds a top document through background before starting refresh", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const sent: unknown[] = [];
    const runtime = startContentRefreshBootstrapRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      location: { href: "https://example.test/page" },
      createContentRuntimeId: () => "runtime-bootstrap-a",
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        if ((message as { type?: string }).type ===
          "pin-op.refresh.content.bootstrap") {
          return {
            type: "pin-op.refresh.content.bootstrap.result",
            accepted: true,
            tabId: 31,
            frameId: 0,
            pageUrl: "https://example.test/page",
            contentRuntimeId: "runtime-bootstrap-a",
          };
        }
        return undefined;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
    });
    await flushAsync();
    await flushAsync();

    expect(sent).toEqual([
      {
        type: "pin-op.refresh.content.bootstrap",
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-bootstrap-a",
      },
      {
        type: "pin-op.refresh.content.ready",
        tabId: 31,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-bootstrap-a",
      },
    ]);
    runtime.dispose();
  });

  it("is a silent no-op in child frames", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    page.view.top = {} as Window;
    const sendRuntimeMessage = vi.fn(async () => undefined);
    const onError = vi.fn();

    const runtime = startContentRefreshBootstrapRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      location: { href: "https://example.test/frame" },
      sendRuntimeMessage,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      onError,
    });
    await flushAsync();

    expect(sendRuntimeMessage).not.toHaveBeenCalled();
    expect(runtimeMessages.remove).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

function messageHarness() {
  let listener: ((message: unknown) => unknown) | undefined;
  const remove = vi.fn();
  return {
    subscribe: vi.fn((next: (message: unknown) => unknown) => {
      listener = next;
      return remove;
    }),
    remove,
    async emit(message: unknown) {
      return await listener?.(message);
    },
  };
}

function portHarness() {
  let listener: (() => void) | undefined;
  const remove = vi.fn(() => {
    listener = undefined;
  });
  return {
    port: {
      onDisconnect: {
        addListener(next: () => void) {
          listener = next;
        },
        removeListener: remove,
      },
      disconnect: vi.fn(),
    },
    remove,
    disconnect() {
      listener?.();
    },
  };
}

function documentHarness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const captureAdds: string[] = [];
  const captureRemoves: string[] = [];
  return {
    document: {
      styleSheets: [],
      addEventListener(
        type: string,
        listener: (event: unknown) => void,
        options: boolean | { readonly capture?: boolean; readonly passive?: boolean },
      ) {
        expect(readCapture(options)).toBe(true);
        if (type === "touchstart" || type === "touchend") {
          expect(options).toEqual({ capture: true, passive: false });
        }
        listeners.set(type, listener);
        captureAdds.push(type);
      },
      removeEventListener(
        type: string,
        listener: (event: unknown) => void,
        options: boolean | { readonly capture?: boolean; readonly passive?: boolean },
      ) {
        expect(readCapture(options)).toBe(true);
        if (listeners.get(type) === listener) {
          listeners.delete(type);
        }
        captureRemoves.push(type);
      },
    },
    captureAdds,
    captureRemoves,
    click(target: unknown) {
      for (const type of [
        "pointerdown",
        "pointerup",
        "click",
      ]) {
        listeners.get(type)?.({
          type,
          target,
          isTrusted: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
          composedPath: () => [target],
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {},
        });
      }
    },
  };
}

function readCapture(
  options: boolean | { readonly capture?: boolean },
): boolean {
  return typeof options === "boolean" ? options : options.capture === true;
}

function locationSource() {
  return {
    href: "https://example.test/page",
    pathname: "/page",
    search: "",
    hash: "",
  };
}

function inspectPayload() {
  return {
    targets: [
      {
        role: "selected" as const,
        depth: 0 as const,
        subject: {
          selector: ".card",
          tag: "article",
          id: "hero",
          classes: ["card"],
          metadata: {},
        },
        facts: [],
        metadata: {},
      },
    ],
    ruleEvidence: { rules: [], omittedRuleCount: 0 },
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
  };
}

function pageSessionHarness() {
  const enablePicker = vi.fn();
  const disablePicker = vi.fn();
  const republishSelection = vi.fn(async () => true);
  const clearOverlayForRefresh = vi.fn();
  const clearPseudoStates = vi.fn(() => true);
  const invalidateStylesheetsForRefresh = vi.fn(() => true);
  const handle = vi.fn(async (request: { requestId?: string }) =>
    rootResponse(request.requestId ?? "missing")
  );
  const dispose = vi.fn();
  return {
    enablePicker,
    disablePicker,
    republishSelection,
    clearOverlayForRefresh,
    clearPseudoStates,
    invalidateStylesheetsForRefresh,
    handle,
    dispose,
    session: {
      enablePicker,
      disablePicker,
      republishSelection,
      clearOverlayForRefresh,
      clearPseudoStates,
      invalidateStylesheetsForRefresh,
      handle,
      dispose,
    },
  };
}

function refreshPageHarness() {
  const view: Record<string, unknown> = {
    scrollX: 0,
    scrollY: 0,
  };
  view.top = view;
  const document = {
    baseURI: "https://example.test/page",
    defaultView: view,
    querySelectorAll: () => [],
    documentElement: {
      scrollWidth: 0,
      scrollHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
    },
    body: null,
    readyState: "complete",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.assign(view, {
    document,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
  });
  return {
    document: document as unknown as Document,
    view: view as unknown as Window & {
      scrollX: number;
      scrollY: number;
      location?: { reload: () => void };
    },
  };
}

function rootResponse(requestId: string) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    prologue: [],
    epilogue: [],
    node: {
      nodeRef: "node-root",
      kind: "element" as const,
      nodeType: 1,
      nodeName: "HTML",
      attributes: [],
      childCount: 1,
      relationship: "dom" as const,
      selectable: true,
      label: "html",
      expandable: true,
      branchRevision: 0,
      locator: elementLocator("html"),
    },
  };
}

function stylesMatchedResponse(requestId: string) {
  return {
    type: "styles.matched" as const,
    requestId,
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    stylesRevision: 8,
    stylesheetRevision: 3,
    pseudoStateRevision: 2,
    pseudoStates: ["hover"],
    styles: {
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      stylesRevision: 8,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover"],
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      unsupportedRuleCount: 0,
      approximateRuleCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}

function pseudoStatesRequest(requestId: string) {
  return {
    type: "styles.setPseudoStates" as const,
    requestId,
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    expectedStylesRevision: 8,
    expectedPseudoStateRevision: 2,
    states: ["hover", "focus"] as const,
  };
}

function pseudoStatesResponse(request: ReturnType<typeof pseudoStatesRequest>) {
  return {
    type: "styles.pseudoStates" as const,
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision: 9,
    stylesheetRevision: 3,
    pseudoStateRevision: 3,
    states: request.states,
    unsupportedRuleCount: 1,
    inaccessibleStylesheetCount: 2,
    approximateRuleCount: 1,
  };
}

function elementLocator(tagName: string) {
  return {
    version: 1 as const,
    targetKind: "element" as const,
    boundaries: [],
    path: [{ tagName, siblingIndex: 0 }],
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
