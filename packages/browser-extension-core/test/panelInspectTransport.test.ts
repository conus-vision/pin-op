import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  parseDomRequest,
  type DomNodeView,
  type DomRequest,
} from "../src/domProtocol.js";
import { DomTreeController } from "../src/domTreeController.js";
import type { PanelInspectPort } from "../src/inspectPortProtocol.js";
import { PanelInspectTransport } from "../src/panelInspectTransport.js";
import {
  STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES,
  type StylesGetMatchedRequest,
} from "../src/stylesProtocol.js";

describe("PanelInspectTransport DOM integration", () => {
  it("binds default styles request timers to the host global", async () => {
    const port = new FakePort();
    const pendingTimers = new Map<number, TimerHandler>();
    let nextTimer = 1;
    const hostSetTimeout = function (
      this: unknown,
      handler: TimerHandler,
    ): ReturnType<typeof globalThis.setTimeout> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: setTimeout receiver");
      }
      const timer = nextTimer;
      nextTimer += 1;
      pendingTimers.set(timer, handler);
      return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const hostClearTimeout = function (
      this: unknown,
      timer?: ReturnType<typeof globalThis.setTimeout>,
    ): void {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: clearTimeout receiver");
      }
      if (timer !== undefined) {
        pendingTimers.delete(timer as unknown as number);
      }
    };
    vi.stubGlobal("setTimeout", hostSetTimeout);
    vi.stubGlobal("clearTimeout", hostClearTimeout);

    try {
      const transport = new PanelInspectTransport(() => port);
      const pending = transport.requestStyles(stylesRequest("host-timer"));
      const state = promiseState(pending);
      await flushPanelTasks();

      expect(state).toEqual({ status: "pending" });
      expect(port.sent).toHaveLength(1);
      expect(pendingTimers.size).toBe(1);

      const wire = port.sent[0] as StylesGetMatchedRequest;
      port.emitMessage(stylesMatched(wire));
      await expect(pending).resolves.toMatchObject({ requestId: "host-timer" });
      expect(pendingTimers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rewrites styles request IDs and validates all echoed identities", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const caller = {
      ...stylesRequest("caller-styles"),
      manualRefresh: true as const,
    };
    const pending = transport.requestStyles(caller);
    const wire = port.sent.at(-1) as StylesGetMatchedRequest;

    expect(wire).toMatchObject({
      type: "styles.getMatched",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      manualRefresh: true,
    });
    expect(wire.requestId).not.toBe(caller.requestId);

    port.emitMessage(stylesMatched({ ...wire, nodeRef: "wrong" }));
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    port.emitMessage(stylesMatched(wire));
    await expect(pending).resolves.toMatchObject({
      type: "styles.matched",
      requestId: caller.requestId,
      nodeRef: caller.nodeRef,
    });
  });

  it("rejects stale-port styles replies, duplicate caller IDs, and pending work on disconnect", async () => {
    const first = new FakePort();
    const second = new FakePort();
    const ports = [first, second];
    const transport = new PanelInspectTransport(() => ports.shift()!);
    const firstPending = transport.requestStyles(stylesRequest("same"));
    await expect(transport.requestStyles(stylesRequest("same")))
      .rejects.toThrow(/duplicate/i);
    first.onDisconnect.emit();
    await expect(firstPending).rejects.toThrow(/closed/i);

    const current = transport.requestStyles(stylesRequest("current"));
    const wire = second.sent.at(-1) as StylesGetMatchedRequest;
    first.emitMessage(stylesMatched({ ...wire, requestId: "stylesq-1" }));
    await Promise.resolve();
    second.emitMessage(stylesMatched(wire));
    await expect(current).resolves.toMatchObject({ requestId: "current" });
  });

  it.each(["lost", "malformed", "oversized"] as const)(
    "expires a %s styles response and releases every correlation",
    async (responseKind) => {
      const port = new FakePort();
      const clock = new FakeClock();
      const signal = new CountingAbortSignal();
      const transport = new PanelInspectTransport(
        () => port,
        undefined,
        undefined,
        undefined,
        {
          stylesRequestTimeoutMs: 25,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        },
      );
      const pending = transport.requestStyles(
        stylesRequest("caller-timeout"),
        signal as unknown as AbortSignal,
      );
      const state = promiseState(pending);
      const wire = port.sent.at(-1) as StylesGetMatchedRequest;
      if (responseKind === "malformed") {
        port.emitMessage({
          type: "styles.matched",
          requestId: wire.requestId,
        });
      } else if (responseKind === "oversized") {
        const oversized = {
          ...stylesMatched(wire),
          padding: "x".repeat(STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES),
        };
        expect(JSON.stringify(oversized).length).toBeGreaterThan(
          STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES,
        );
        port.emitMessage(oversized);
      }

      clock.advanceBy(24);
      await flushPanelTasks();
      expect(state.status).toBe("pending");
      expect(pendingStylesCounts(transport)).toEqual({
        callerIds: 1,
        wireRequests: 1,
      });
      expect(signal.listenerCount()).toBe(1);

      clock.advanceBy(1);
      await flushPanelTasks();
      const timeoutSnapshot = {
        state: { ...state },
        correlations: pendingStylesCounts(transport),
        abortListeners: signal.listenerCount(),
        timers: clock.pendingCount(),
      };
      if (state.status === "pending") {
        transport.cancelStylesRequests();
        await flushPanelTasks();
      }
      expect(timeoutSnapshot).toEqual({
        state: {
          status: "rejected",
          reason: "Styles request timed out",
        },
        correlations: { callerIds: 0, wireRequests: 0 },
        abortListeners: 0,
        timers: 0,
      });

      port.emitMessage(stylesMatched(wire));
      await flushPanelTasks();
      expect(state).toEqual({
        status: "rejected",
        reason: "Styles request timed out",
      });

      const reissued = transport.requestStyles(stylesRequest("caller-timeout"));
      transport.cancelStylesRequests();
      await expect(reissued).rejects.toThrow("Styles session changed");
      expect(clock.pendingCount()).toBe(0);
    },
  );

  it.each(["cancel", "dispose"] as const)(
    "%s clears a pending styles timeout and abort listener",
    async (action) => {
      const port = new FakePort();
      const clock = new FakeClock();
      const signal = new CountingAbortSignal();
      const transport = new PanelInspectTransport(
        () => port,
        undefined,
        undefined,
        undefined,
        {
          stylesRequestTimeoutMs: 25,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        },
      );
      const pending = transport.requestStyles(
        stylesRequest(`caller-${action}`),
        signal as unknown as AbortSignal,
      );
      expect(clock.pendingCount()).toBe(1);
      expect(signal.listenerCount()).toBe(1);

      if (action === "cancel") {
        transport.cancelStylesRequests();
      } else {
        transport.dispose();
      }
      await expect(pending).rejects.toThrow(
        action === "cancel" ? "Styles session changed" : "Inspect connection is closed",
      );
      expect(clock.pendingCount()).toBe(0);
      expect(signal.listenerCount()).toBe(0);
      expect(pendingStylesCounts(transport)).toEqual({
        callerIds: 0,
        wireRequests: 0,
      });
    },
  );

  it("bounds an injected styles request timeout", () => {
    const port = new FakePort();
    for (const stylesRequestTimeoutMs of [0, 60_001, Number.NaN]) {
      expect(() => new PanelInspectTransport(
        () => port,
        undefined,
        undefined,
        undefined,
        { stylesRequestTimeoutMs },
      )).toThrow(RangeError);
    }
  });

  it("correlates a validated DOM query without a panel-supplied tab ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);

    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-1",
    });
    const wireRequest = sentDomQuery(port);

    expect(wireRequest).toMatchObject({ type: "dom.getRoot" });
    expect(wireRequest.requestId).not.toBe("root-1");
    port.emitMessage(rootResponse(wireRequest.requestId));
    await expect(pending).resolves.toEqual(rootResponse("root-1"));

    await expect(transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-spoofed",
      tabId: 999,
    })).rejects.toThrow("Invalid DOM request");
    expect(port.sent).toHaveLength(1);
  });

  it("posts stable locator queries and waits for the expected response family", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const request = locatorRequest("locator-1");

    const pending = transport.requestDom(request);
    const wireRequest = sentDomQuery(port);

    expect(wireRequest).toEqual({
      ...request,
      requestId: wireRequest.requestId,
    });
    expect(wireRequest.requestId).not.toBe(request.requestId);
    port.emitMessage(rootResponse(wireRequest.requestId));
    const state = viState(pending);
    await Promise.resolve();
    expect(state.settled).toBe(false);

    port.emitMessage(locatorResponse(wireRequest.requestId));
    await expect(pending).resolves.toEqual(locatorResponse("locator-1"));
  });

  it("does not consume a root query with a locator response", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-family",
    });
    const wireRequest = sentDomQuery(port);

    port.emitMessage(locatorResponse(wireRequest.requestId));
    const state = viState(pending);
    await Promise.resolve();
    expect(state.settled).toBe(false);

    port.emitMessage(rootResponse(wireRequest.requestId));
    await expect(pending).resolves.toEqual(rootResponse("root-family"));
  });

  it("keeps an epoch-bound root query pending after a stale response", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-epoch",
      documentEpoch: 4,
    });
    const wireRequest = sentDomQuery(port);

    port.emitMessage({
      ...rootResponse(wireRequest.requestId),
      documentEpoch: 3,
    });
    const state = viState(pending);
    await Promise.resolve();
    expect(state.settled).toBe(false);

    const response = {
      ...rootResponse(wireRequest.requestId),
      documentEpoch: 4,
    };
    port.emitMessage(response);
    await expect(pending).resolves.toEqual({
      ...response,
      requestId: "root-epoch",
    });
  });

  it("keeps a children query pending until every identity field matches", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const request = childrenRequest("children-identity");
    const pending = transport.requestDom(request);
    const wireRequest = sentDomQuery(port);
    const response = childrenResponse(wireRequest.requestId);
    const state = viState(pending);

    port.emitMessage({ ...response, documentEpoch: 8 });
    port.emitMessage({ ...response, nodeRef: "node-forged" });
    port.emitMessage({ ...response, branchRevision: 6 });
    await Promise.resolve();
    expect(state.settled).toBe(false);

    port.emitMessage(response);
    await expect(pending).resolves.toEqual(childrenResponse(request.requestId));
  });

  it("rejects contradictory error correlation but accepts an omitted epoch", async () => {
    const port = new FakePort();
    const unhandled: unknown[] = [];
    const transport = new PanelInspectTransport(
      () => port,
      () => undefined,
      (message) => unhandled.push(message),
    );
    const request = childrenRequest("children-error");
    const pending = transport.requestDom(request);
    const wireRequest = sentDomQuery(port);
    const state = viState(pending);
    const wrongId = {
      type: "dom.error" as const,
      requestId: "children-other",
      code: "stale-branch" as const,
    };
    const wrongEpoch = {
      type: "dom.error" as const,
      requestId: wireRequest.requestId,
      documentEpoch: 8,
      code: "stale-branch" as const,
    };

    port.emitMessage(wrongId);
    port.emitMessage(wrongEpoch);
    await Promise.resolve();
    expect(state.settled).toBe(false);
    expect(unhandled).toEqual([wrongId, wrongEpoch]);

    const boundedError = {
      type: "dom.error" as const,
      requestId: wireRequest.requestId,
      code: "stale-branch" as const,
    };
    port.emitMessage(boundedError);
    await expect(pending).resolves.toEqual({
      ...boundedError,
      requestId: request.requestId,
    });
  });

  it("dispatches validated DOM commands and rejects pending queries on close", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);

    transport.dispatchDom({
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "node-1",
    });
    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-pending",
    });
    const wireRequest = sentDomQuery(port, 1);

    expect(port.sent[0]).toEqual({
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "node-1",
    });
    expect(wireRequest).toMatchObject({ type: "dom.getRoot" });
    expect(wireRequest.requestId).not.toBe("root-pending");

    transport.dispose();
    await expect(pending).rejects.toThrow("Inspect connection is closed");
  });

  it("reuses a canceled caller ID with a new wire ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const request = locatorRequest("locator-reused");
    const pending = transport.requestDom(request);
    const oldWireRequest = sentDomQuery(port);

    transport.cancelDomRequests("DOM session changed");

    await expect(pending).rejects.toThrow("DOM session changed");
    expect(port.disconnected).toBe(false);
    const reissued = transport.requestDom(request);
    const reissuedState = promiseState(reissued);
    expect(port.sent).toHaveLength(2);
    const newWireRequest = sentDomQuery(port, 1);
    expect(newWireRequest.requestId).not.toBe(oldWireRequest.requestId);

    port.emitMessage(locatorResponse(oldWireRequest.requestId));
    await Promise.resolve();
    expect(reissuedState.status).toBe("pending");

    port.emitMessage(locatorResponse(newWireRequest.requestId));
    await expect(reissued).resolves.toEqual(locatorResponse(request.requestId));
  });

  it("retires old controller queries before replacement-root children across repeated replacements", async () => {
    const port = new FakePort();
    const inspectTransport = new PanelInspectTransport(() => port);
    const cancellations: Array<{
      readonly reason: string;
      readonly pending: ReturnType<typeof pendingDomCounts>;
    }> = [];
    let requestSequence = 0;
    const controller = new DomTreeController({
      transport: {
        request: (request) => inspectTransport.requestDom(request),
        dispatch: (request) => inspectTransport.dispatchDom(request),
        cancelPending: (reason) => {
          cancellations.push({
            reason,
            pending: pendingDomCounts(inspectTransport),
          });
          inspectTransport.cancelDomRequests(reason);
        },
      },
      createRequestId: () => `replacement-${++requestSequence}`,
    });
    let currentRoot = controllerNode("root-0", true, 1);
    let currentChild = controllerNode("child-0");
    const initialRoot = controller.loadRoot();
    const initialRootQuery = sentDomQuery(port);
    port.emitMessage(controllerRootResponse(initialRootQuery.requestId, currentRoot));
    await initialRoot;
    const initialExpand = controller.expand(currentRoot.nodeRef);
    const initialChildrenQuery = sentDomQuery(port);
    port.emitMessage(controllerChildrenResponse(
      initialChildrenQuery.requestId,
      currentRoot.nodeRef,
      1,
      [currentChild],
      "cursor-0",
    ));
    await initialExpand;

    for (let replacement = 1; replacement <= 3; replacement += 1) {
      const oldRoot = currentRoot;
      const oldChild = currentChild;
      const hungLoadMore = controller.loadMore(oldRoot.nodeRef);
      const hungState = promiseState(hungLoadMore);
      const hungQuery = sentDomQuery(port);
      const invalidationStart = port.sent.length;

      controller.handleEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: oldRoot.nodeRef, branchRevision: 2 }],
      });
      await flushPanelTasks();

      const invalidationQueries = port.sent
        .slice(invalidationStart)
        .map((_, index) => sentDomQuery(port, invalidationStart + index));
      const rootQuery = invalidationQueries.find((query) => (
        query.type === "dom.getRoot"
      ));
      const oldRefreshQuery = invalidationQueries.find((query) => (
        query.type === "dom.getChildren" && query.nodeRef === oldRoot.nodeRef
      ));
      expect(rootQuery).toBeDefined();
      expect(oldRefreshQuery).toBeDefined();

      currentRoot = controllerNode(`root-${replacement}`, true, 1);
      currentChild = controllerNode(`child-${replacement}`);
      const replacementChildrenStart = port.sent.length;
      port.emitMessage(controllerRootResponse(rootQuery!.requestId, currentRoot));
      await flushPanelTasks();

      expect(hungState.status).toBe("fulfilled");
      expect(cancellations.at(-1)).toEqual({
        reason: "DOM root replaced",
        pending: { callerIds: 2, wireRequests: 2 },
      });
      const replacementChildrenQuery = sentDomQuery(
        port,
        replacementChildrenStart,
      );
      expect(replacementChildrenQuery).toMatchObject({
        type: "dom.getChildren",
        documentEpoch: 1,
        nodeRef: currentRoot.nodeRef,
        branchRevision: 1,
      });
      expect(pendingDomCounts(inspectTransport)).toEqual({
        callerIds: 1,
        wireRequests: 1,
      });

      port.emitMessage(controllerChildrenResponse(
        hungQuery.requestId,
        oldRoot.nodeRef,
        1,
        [controllerNode(`late-more-${replacement}`)],
      ));
      port.emitMessage(controllerChildrenResponse(
        oldRefreshQuery!.requestId,
        oldRoot.nodeRef,
        2,
        [controllerNode(`late-refresh-${replacement}`)],
      ));
      await flushPanelTasks();
      expect(pendingDomCounts(inspectTransport)).toEqual({
        callerIds: 1,
        wireRequests: 1,
      });

      port.emitMessage(controllerChildrenResponse(
        replacementChildrenQuery.requestId,
        currentRoot.nodeRef,
        1,
        [currentChild],
        `cursor-${replacement}`,
      ));
      await flushPanelTasks();

      expect(pendingDomCounts(inspectTransport)).toEqual({
        callerIds: 0,
        wireRequests: 0,
      });
      expect(controller.rows().map((row) => row.nodeRef)).toEqual([
        currentRoot.nodeRef,
        currentChild.nodeRef,
        `pin-op:load-more:${currentRoot.nodeRef}`,
      ]);
      expect(controller.rows().some((row) => row.nodeRef === oldChild.nodeRef)).toBe(false);
    }

    expect(cancellations).toHaveLength(3);
  });

  it("reuses a completed caller ID with a new wire ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const request = locatorRequest("locator-complete");
    const first = transport.requestDom(request);
    const firstWireRequest = sentDomQuery(port);
    port.emitMessage(locatorResponse(firstWireRequest.requestId));
    await expect(first).resolves.toEqual(locatorResponse(request.requestId));

    const second = transport.requestDom(request);
    const secondState = promiseState(second);
    expect(port.sent).toHaveLength(2);
    const secondWireRequest = sentDomQuery(port, 1);
    expect(secondWireRequest.requestId).not.toBe(firstWireRequest.requestId);
    port.emitMessage(locatorResponse(secondWireRequest.requestId));

    await expect(second).resolves.toEqual(locatorResponse(request.requestId));
    expect(secondState.status).toBe("fulfilled");
  });

  it("rejects only a simultaneous duplicate caller ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const request = locatorRequest("locator-concurrent");
    const pending = transport.requestDom(request);
    const wireRequest = sentDomQuery(port);

    await expect(transport.requestDom(request)).rejects.toThrow(
      "Duplicate DOM request",
    );
    expect(port.sent).toHaveLength(1);

    port.emitMessage(locatorResponse(wireRequest.requestId));
    await expect(pending).resolves.toEqual(locatorResponse(request.requestId));
  });

  it("isolates a reused caller ID from messages on a disconnected port", async () => {
    const ports = [new FakePort(), new FakePort()];
    let portIndex = 0;
    const transport = new PanelInspectTransport(() => ports[portIndex++]!);
    const request = locatorRequest("locator-reconnected");
    const first = transport.requestDom(request);
    const firstWireRequest = sentDomQuery(ports[0]!);
    ports[0]!.emitMessage(locatorResponse(firstWireRequest.requestId));
    await expect(first).resolves.toEqual(locatorResponse(request.requestId));

    ports[0]!.disconnect();
    const second = transport.requestDom(request);
    const secondWireRequest = sentDomQuery(ports[1]!);
    const secondState = viState(second);
    expect(secondWireRequest.requestId).toBe(firstWireRequest.requestId);

    ports[0]!.emitMessage(locatorResponse(firstWireRequest.requestId));
    await Promise.resolve();
    expect(secondState.settled).toBe(false);

    ports[1]!.emitMessage(locatorResponse(secondWireRequest.requestId));
    await expect(second).resolves.toEqual(locatorResponse(request.requestId));
    expect(portIndex).toBe(2);
  });

  it("continues beyond 4096 sequential queries without retaining IDs", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    for (let index = 0; index < 4_100; index += 1) {
      const requestId = `bounded-${index}`;
      const pending = transport.requestDom({
        type: "dom.getRoot",
        requestId,
      });
      const state = promiseState(pending);
      expect(port.sent).toHaveLength(index + 1);
      const wireRequest = sentDomQuery(port, index);
      port.emitMessage({
        type: "dom.error",
        requestId: wireRequest.requestId,
        code: "node-unavailable",
      });
      await expect(pending).resolves.toEqual({
        type: "dom.error",
        requestId,
        code: "node-unavailable",
      });
      expect(state.status).toBe("fulfilled");
    }

    expect(pendingDomCounts(transport)).toEqual({
      callerIds: 0,
      wireRequests: 0,
    });
  });

  it("keeps wire IDs bounded and normalizes frozen responses to the caller ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const callerRequestId = "x".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH);
    const pending = transport.requestDom(locatorRequest(callerRequestId));
    const wireRequest = sentDomQuery(port);

    expect(wireRequest.requestId).toMatch(/^domq-[1-9]\d*$/);
    expect(wireRequest.requestId.length).toBeLessThanOrEqual(
      DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
    );
    expect(wireRequest.requestId).not.toBe(callerRequestId);

    port.emitMessage(locatorResponse(wireRequest.requestId));
    const response = await pending;

    expect(response.requestId).toBe(callerRequestId);
    expect(Object.isFrozen(response)).toBe(true);
    if (response.type !== "dom.locator") {
      throw new Error("Expected a locator response");
    }
    expect(Object.isFrozen(response.node)).toBe(true);
    expect(Object.isFrozen(response.ancestorPath)).toBe(true);
    expect(Object.isFrozen(response.node.locator)).toBe(true);
  });

  it("fails closed only after exhausting the safe-integer wire sequence", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    transport.connect();
    setNextDomWireSequence(transport, Number.MAX_SAFE_INTEGER);

    const last = transport.requestDom({
      type: "dom.getRoot",
      requestId: "last-safe-wire",
    });
    const lastWireRequest = sentDomQuery(port);
    expect(lastWireRequest.requestId).toBe(
      `domq-${Number.MAX_SAFE_INTEGER}`,
    );
    port.emitMessage(rootResponse(lastWireRequest.requestId));
    await expect(last).resolves.toEqual(rootResponse("last-safe-wire"));

    await expect(transport.requestDom({
      type: "dom.getRoot",
      requestId: "exhausted-wire",
    })).rejects.toThrow("DOM request ID space exhausted");
    expect(port.sent).toHaveLength(1);
    expect(port.disconnected).toBe(false);
  });

  it("forwards only validated DOM, protocol, and browser-local push messages", () => {
    const port = new FakePort();
    const received: unknown[] = [];
    const transport = new PanelInspectTransport(
      () => port,
      () => undefined,
      (message) => received.push(message),
    );
    transport.connect();
    const selection = selectionChanged();
    const currentResolution = resolution("inspect-1", 1);
    const currentPeerState = peerState(true, 2);
    const currentNavigationState = sourceNavigationState(2, 0);
    const navigationStateWithoutActiveMatch = sourceNavigationState(0);
    const inspectStarted = {
      type: "pin-op.inspect.started",
      inspectMessageId: "inspect-1",
      selectionRevision: 4,
    } as const;

    port.emitMessage(inspectStarted);
    port.emitMessage(selection);
    port.emitMessage(currentResolution);
    port.emitMessage(currentPeerState);
    port.emitMessage(currentNavigationState);
    port.emitMessage(navigationStateWithoutActiveMatch);
    port.emitMessage({ ...inspectStarted, inspectMessageId: "" });
    port.emitMessage({ ...inspectStarted, inspectMessageId: "x".repeat(129) });
    port.emitMessage({ ...inspectStarted, selectionRevision: "4" });
    port.emitMessage({ ...inspectStarted, selectionRevision: -1 });
    port.emitMessage({ ...inspectStarted, selectionRevision: 1.5 });
    port.emitMessage({
      ...inspectStarted,
      selectionRevision: Number.MAX_SAFE_INTEGER + 1,
    });
    port.emitMessage({ ...inspectStarted, extra: true });
    port.emitMessage({ ...selection, tabId: 999 });
    port.emitMessage({ ...currentResolution, resolutionGeneration: -1 });
    port.emitMessage({ ...currentPeerState, connected: "yes" });
    port.emitMessage({ ...currentNavigationState, activeMatchIndex: 2 });
    port.emitMessage({ ...currentNavigationState, sessionId: "" });
    port.emitMessage({ ...currentNavigationState, channel: "panel-b" });

    expect(received).toEqual([
      inspectStarted,
      selection,
      currentResolution,
      currentPeerState,
      currentNavigationState,
      navigationStateWithoutActiveMatch,
    ]);
  });
});

describe("PanelInspectTransport source navigation", () => {
  it("lazily posts canonical previous and next commands on the shared port", () => {
    const port = new FakePort();
    let factoryCalls = 0;
    const transport = new PanelInspectTransport(() => {
      factoryCalls += 1;
      return port;
    });
    const previous = sourceNavigateCommand("previous");

    transport.dispatchSourceNavigation(previous);
    transport.dispatchSourceNavigation(sourceNavigateCommand("next"));

    expect(factoryCalls).toBe(1);
    expect(port.sent).toEqual([
      sourceNavigateCommand("previous"),
      sourceNavigateCommand("next"),
    ]);
    expect(port.sent[0]).not.toBe(previous);
  });

  it("rejects malformed or non-local commands without opening or posting", () => {
    const port = new FakePort();
    let factoryCalls = 0;
    const transport = new PanelInspectTransport(() => {
      factoryCalls += 1;
      return port;
    });
    const valid = sourceNavigateCommand("next");
    const invalid = [
      { ...valid, sessionId: "session-a" },
      { ...valid, messageId: "message-a" },
      { ...valid, extra: true },
      { ...valid, direction: "first" },
      { ...valid, resolutionGeneration: -1 },
      { type: valid.type, inspectMessageId: valid.inspectMessageId },
      null,
    ];

    for (const message of invalid) {
      expect(() => transport.dispatchSourceNavigation(message)).toThrow(
        "Invalid source navigation command",
      );
    }
    expect(factoryCalls).toBe(0);
    expect(port.sent).toEqual([]);
  });

  it("throws the existing closed error after disposal without opening a port", () => {
    let factoryCalls = 0;
    const transport = new PanelInspectTransport(() => {
      factoryCalls += 1;
      return new FakePort();
    });
    transport.dispose();

    expect(() =>
      transport.dispatchSourceNavigation(sourceNavigateCommand("next"))
    ).toThrow("Inspect connection is closed");
    expect(factoryCalls).toBe(0);
  });

  it("cleans up a failed post and reopens through unexpected-disconnect semantics", () => {
    const ports = [new FakePort(), new FakePort()];
    ports[0]!.throwOnPost = true;
    let factoryCalls = 0;
    let unexpectedDisconnects = 0;
    const transport = new PanelInspectTransport(
      () => ports[factoryCalls++]!,
      () => {
        unexpectedDisconnects += 1;
      },
    );

    expect(() =>
      transport.dispatchSourceNavigation(sourceNavigateCommand("previous"))
    ).toThrow("Inspect connection is closed");
    expect(unexpectedDisconnects).toBe(1);
    expect(ports[0]!.listenerCount()).toBe(0);

    transport.dispatchSourceNavigation(sourceNavigateCommand("next"));
    expect(factoryCalls).toBe(2);
    expect(ports[1]!.sent).toEqual([sourceNavigateCommand("next")]);
  });
});

describe("PanelInspectTransport source presentation", () => {
  it("posts only exact source open, presentation, and tab settings commands", () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const sourceOpen = {
      type: "pin-op.source.open",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      matchId: "match-1",
    } as const;
    const presentation = {
      type: "pin-op.presentation.settings",
      inspectMessageId: "inspect-1",
      ideHighlightEnabled: false,
    } as const;
    const tabSettings = {
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    } as const;

    transport.dispatchSourceOpen(sourceOpen);
    transport.dispatchPresentationSettings(presentation);
    transport.dispatchTabSettings(tabSettings);

    expect(port.sent).toEqual([sourceOpen, presentation, tabSettings]);
    expect(port.sent[0]).not.toBe(sourceOpen);
    expect(port.sent[1]).not.toBe(presentation);
    expect(port.sent[2]).not.toBe(tabSettings);

    expect(() => transport.dispatchSourceOpen({ ...sourceOpen, extra: true }))
      .toThrow("Invalid source open command");
    expect(() => transport.dispatchPresentationSettings({
      ...presentation,
      inspectMessageId: "",
    })).toThrow("Invalid presentation settings command");
    expect(() => transport.dispatchTabSettings({
      ...tabSettings,
      autoRefreshEnabled: "yes",
    })).toThrow("Invalid tab settings command");
    expect(port.sent).toHaveLength(3);
  });

  it("forwards strict v6 source, settings, compatibility, and incompatible states", () => {
    const port = new FakePort();
    const received: unknown[] = [];
    const transport = new PanelInspectTransport(
      () => port,
      () => undefined,
      (message) => received.push(message),
    );
    transport.connect();
    const matches = sourceMatches();
    const tabState = {
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 2,
    } as const;
    const compatible = {
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    } as const;
    const incompatible = {
      type: "pin-op.windowState",
      state: "incompatible",
      displayLinkCode: "48735 07",
    } as const;

    port.emitMessage(matches);
    port.emitMessage(tabState);
    port.emitMessage(compatible);
    port.emitMessage(incompatible);
    port.emitMessage({ ...matches, extra: true });
    port.emitMessage({ ...tabState, participant: "yes" });
    port.emitMessage({ ...compatible, browserProtocolVersion: 5 });
    port.emitMessage({ ...incompatible, state: "connected" });

    expect(received).toEqual([matches, tabState, compatible, incompatible]);
  });

  it("ignores messages from an old port after reconnecting", () => {
    const ports = [new FakePort(), new FakePort()];
    const received: unknown[] = [];
    let index = 0;
    const transport = new PanelInspectTransport(
      () => ports[index++]!,
      () => undefined,
      (message) => received.push(message),
    );
    transport.connect();
    ports[0]!.disconnect();
    transport.connect();

    ports[0]!.emitMessage(sourceMatches());
    ports[1]!.emitMessage(sourceMatches());

    expect(received).toEqual([sourceMatches()]);
  });
});

class FakePort implements PanelInspectPort {
  public readonly name = "pin-op.devtools.channel-1";
  public readonly sent: unknown[] = [];
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();
  public disconnected = false;
  public throwOnPost = false;

  public postMessage(message: unknown): void {
    if (this.throwOnPost) {
      throw new Error("post failed");
    }
    this.sent.push(message);
  }

  public disconnect(): void {
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  public listenerCount(): number {
    return this.onMessage.listenerCount() + this.onDisconnect.listenerCount();
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { readonly due: number; readonly callback: () => void }
  >();

  public readonly setTimeout = (
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  public readonly clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  public advanceBy(delay: number): void {
    const target = this.now + delay;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([leftId, left], [rightId, right]) =>
          left.due - right.due || leftId - rightId
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.due;
      timer.callback();
    }
    this.now = target;
  }

  public pendingCount(): number {
    return this.timers.size;
  }
}

class CountingAbortSignal {
  public readonly aborted = false;
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === "abort" && listener) this.listeners.add(listener);
  }

  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === "abort" && listener) this.listeners.delete(listener);
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function sourceNavigateCommand(direction: "previous" | "next") {
  return {
    type: "pin-op.source.navigate" as const,
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    direction,
  };
}

function sourceMatches(): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: "source-matches-1",
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    document: { label: "card.scss", languageId: "scss" },
    matches: [sourceExcerpt()],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function sourceExcerpt(): SourceExcerpt {
  return {
    matchId: "match-1",
    targetRole: "selected",
    label: "card.scss:1",
    kind: "rule",
    relation: "selected",
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: ".card {\n  color: red;\n}",
    truncated: false,
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
      locator: stableLocator({ path: [pathSegment({ tagName: "html" })] }),
    },
  };
}

function controllerNode(
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
    locator: stableLocator({
      path: [pathSegment({ tagName: "div", id: nodeRef })],
    }),
  };
}

function controllerRootResponse(requestId: string, node: DomNodeView) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    prologue: [],
    epilogue: [],
    node,
  };
}

function controllerChildrenResponse(
  requestId: string,
  nodeRef: string,
  branchRevision: number,
  nodes: readonly DomNodeView[],
  nextCursor?: string,
) {
  return {
    type: "dom.children" as const,
    requestId,
    documentEpoch: 1,
    nodeRef,
    branchRevision,
    nodes,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function childrenRequest(requestId: string) {
  return {
    type: "dom.getChildren" as const,
    requestId,
    documentEpoch: 7,
    nodeRef: "node-root",
    branchRevision: 5,
  };
}

function childrenResponse(requestId: string) {
  return {
    type: "dom.children" as const,
    requestId,
    documentEpoch: 7,
    nodeRef: "node-root",
    branchRevision: 5,
    nodes: [],
  };
}

function locatorRequest(requestId: string) {
  return {
    type: "dom.resolveLocator" as const,
    requestId,
    locator: stableLocator({
      path: [pathSegment({ tagName: "button", id: "save" })],
    }),
  };
}

function locatorResponse(requestId: string) {
  const node = {
    nodeRef: "node-target",
    kind: "element" as const,
    nodeType: 1,
    nodeName: "BUTTON",
    attributes: [],
    childCount: 0,
    relationship: "dom" as const,
    selectable: true,
    label: "button#save",
    expandable: false,
    branchRevision: 0,
    locator: stableLocator({
      path: [pathSegment({ tagName: "button", id: "save" })],
    }),
  };
  return {
    type: "dom.locator" as const,
    requestId,
    documentEpoch: 2,
    node,
    ancestorPath: [node],
  };
}

function selectionChanged() {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch: 1,
    selectionRevision: 4,
    nodeRef: "node-1",
    ancestorPath: [
      {
        nodeRef: "node-1",
        kind: "element" as const,
        nodeType: 1,
        nodeName: "MAIN",
        attributes: [],
        childCount: 1,
        relationship: "dom" as const,
        selectable: true,
        label: "main#content",
        expandable: true,
        branchRevision: 0,
        locator: stableLocator({
          path: [pathSegment({ tagName: "main", id: "content" })],
        }),
      },
    ],
  };
}

function stableLocator(overrides: Partial<{
  version: number;
  targetKind: string;
  boundaries: Array<{
    kind: string;
    hostPath: ReturnType<typeof pathSegment>[];
  }>;
  path: ReturnType<typeof pathSegment>[];
}> = {}) {
  return {
    version: 1,
    targetKind: "element",
    boundaries: [],
    path: [pathSegment()],
    ...overrides,
  };
}

function pathSegment(overrides: Partial<{
  tagName: string;
  siblingIndex: number;
  id: string;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
}> = {}) {
  return {
    tagName: "div",
    siblingIndex: 0,
    ...overrides,
  };
}

type TestDomQuery = Extract<DomRequest, { readonly requestId: string }>;

function sentDomQuery(
  port: FakePort,
  index = port.sent.length - 1,
): TestDomQuery {
  const request = parseDomRequest(port.sent[index]);
  if (!("requestId" in request)) {
    throw new Error("Expected a DOM query");
  }
  return request;
}

function pendingDomCounts(transport: PanelInspectTransport): {
  readonly callerIds: number;
  readonly wireRequests: number;
} {
  const state = transport as unknown as {
    readonly pendingDom: ReadonlyMap<string, unknown>;
    readonly pendingDomCallerIds: ReadonlySet<string>;
  };
  return {
    callerIds: state.pendingDomCallerIds.size,
    wireRequests: state.pendingDom.size,
  };
}

function setNextDomWireSequence(
  transport: PanelInspectTransport,
  sequence: number,
): void {
  const state = transport as unknown as {
    readonly connection?: { nextDomRequestSequence: number | undefined };
  };
  if (!state.connection) {
    throw new Error("Expected an inspect connection");
  }
  state.connection.nextDomRequestSequence = sequence;
}

function viState(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  void promise.finally(() => {
    state.settled = true;
  });
  return state;
}

function promiseState(promise: Promise<unknown>): {
  status: "pending" | "fulfilled" | "rejected";
  reason?: string;
} {
  const state: {
    status: "pending" | "fulfilled" | "rejected";
    reason?: string;
  } = { status: "pending" };
  void promise.then(
    () => {
      state.status = "fulfilled";
    },
    (error: unknown) => {
      state.status = "rejected";
      state.reason = error instanceof Error ? error.message : String(error);
    },
  );
  return state;
}

async function flushPanelTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    status: "no-active-editor",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function peerState(
  connected: boolean,
  peerGeneration: number,
): PeerStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: `peer-${peerGeneration}`,
    sessionId: "session-a",
    role: "ide",
    connected,
    peerGeneration,
    metadata: {},
  };
}

function sourceNavigationState(
  selectedMatchCount: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${activeMatchIndex ?? "none"}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 1,
    selectedMatchCount,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}

function stylesRequest(requestId: string): StylesGetMatchedRequest {
  return {
    type: "styles.getMatched",
    requestId,
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
  };
}

function pendingStylesCounts(transport: PanelInspectTransport): {
  readonly callerIds: number;
  readonly wireRequests: number;
} {
  const state = transport as unknown as {
    readonly pendingStyles: ReadonlyMap<string, unknown>;
    readonly pendingStylesCallerIds: ReadonlySet<string>;
  };
  return {
    callerIds: state.pendingStylesCallerIds.size,
    wireRequests: state.pendingStyles.size,
  };
}

function stylesMatched(request: StylesGetMatchedRequest) {
  return {
    type: "styles.matched" as const,
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision: 8,
    stylesheetRevision: 3,
    styles: {
      documentEpoch: request.documentEpoch,
      nodeRef: request.nodeRef,
      selectionRevision: request.selectionRevision,
      stylesRevision: 8,
      stylesheetRevision: 3,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}
