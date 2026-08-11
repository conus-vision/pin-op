import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
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

    expect(port.sent).toEqual([
      { type: "dom.getRoot", requestId: "root-1" },
    ]);
    port.emitMessage(rootResponse("root-1"));
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

    expect(port.sent).toEqual([request]);
    port.emitMessage(rootResponse("locator-1"));
    const state = viState(pending);
    await Promise.resolve();
    expect(state.settled).toBe(false);

    port.emitMessage(locatorResponse("locator-1"));
    await expect(pending).resolves.toEqual(locatorResponse("locator-1"));
  });

  it("does not consume a root query with a locator response", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-family",
    });

    port.emitMessage(locatorResponse("root-family"));
    const state = viState(pending);
    await Promise.resolve();
    expect(state.settled).toBe(false);

    port.emitMessage(rootResponse("root-family"));
    await expect(pending).resolves.toEqual(rootResponse("root-family"));
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

    expect(port.sent).toEqual([
      {
        type: "dom.select",
        documentEpoch: 1,
        nodeRef: "node-1",
      },
      { type: "dom.getRoot", requestId: "root-pending" },
    ]);

    transport.dispose();
    await expect(pending).rejects.toThrow("Inspect connection is closed");
  });

  it("cancels pending DOM queries without closing the shared panel port", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const pending = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-old-session",
    });

    transport.cancelDomRequests("DOM session changed");

    await expect(pending).rejects.toThrow("DOM session changed");
    expect(port.disconnected).toBe(false);
    const next = transport.requestDom({
      type: "dom.getRoot",
      requestId: "root-new-session",
    });
    port.emitMessage(rootResponse("root-old-session"));
    port.emitMessage(rootResponse("root-new-session"));
    await expect(next).resolves.toEqual(rootResponse("root-new-session"));
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
      type: "browser2ide.inspect.started",
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
  public readonly name = "browser2ide.devtools.channel-1";
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
    type: "browser2ide.source.navigate" as const,
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

function viState(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  void promise.finally(() => {
    state.settled = true;
  });
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
