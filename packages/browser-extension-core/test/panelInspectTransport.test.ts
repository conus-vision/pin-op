import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import {
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  parseDomRequest,
  type DomRequest,
} from "../src/domProtocol.js";
import type { PanelInspectPort } from "../src/inspectPortProtocol.js";
import { PanelInspectTransport } from "../src/panelInspectTransport.js";

describe("PanelInspectTransport DOM integration", () => {
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

function sourceNavigateCommand(direction: "previous" | "next") {
  return {
    type: "pin-op.source.navigate" as const,
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    direction,
  };
}

function rootResponse(requestId: string) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    node: {
      nodeRef: "node-root",
      kind: "element" as const,
      label: "html",
      expandable: true,
      branchRevision: 0,
      locator: stableLocator({ path: [pathSegment({ tagName: "html" })] }),
    },
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
