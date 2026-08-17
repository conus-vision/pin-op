import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DomRequest } from "../src/domProtocol.js";
import { PanelSessionTransport } from "../src/panelSessionTransport.js";

describe("PanelSessionTransport", () => {
  it("binds DOM requests to the registered channel tab", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return rootResponse("root-a");
      },
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", rootRequest("root-a")))
      .resolves.toEqual(rootResponse("root-a"));
    expect(sent).toEqual([{
      tabId: 7,
      message: rootRequest("root-a"),
    }]);
  });

  it("keeps stable locator queries browser-local and correlates their response", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return locatorResponse("locator-a");
      },
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", locatorRequest("locator-a")))
      .resolves.toEqual(locatorResponse("locator-a"));
    expect(sent).toEqual([{
      tabId: 7,
      message: locatorRequest("locator-a"),
    }]);
  });

  it("maps a malformed stable locator request to invalid-request", async () => {
    const sendTabMessage = vi.fn();
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", {
      ...locatorRequest("locator-invalid"),
      locator: { ...stableLocator(), version: 2 },
    } as unknown as DomRequest)).resolves.toEqual({
      type: "dom.error",
      requestId: "locator-invalid",
      code: "invalid-request",
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it("never accepts a panel-supplied tab ID", async () => {
    const sendTabMessage = vi.fn(async () => rootResponse("root-a"));
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", {
      ...rootRequest("root-a"),
      tabId: 999,
    } as unknown as DomRequest)).resolves.toMatchObject({
      type: "dom.error",
      requestId: "root-a",
      code: "invalid-request",
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it("fails closed when a channel is disposed during a request", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((next) => {
      resolve = next;
    });
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    const pending = transport.request("panel-a", rootRequest("root-a"));
    transport.disposeChannel("panel-a");
    resolve(rootResponse("root-a"));

    await expect(pending).resolves.toMatchObject({
      type: "dom.error",
      requestId: "root-a",
      code: "session-disposed",
    });
  });

  it.each([
    ["wrong request ID", rootRequest("root-a"), rootResponse("root-b")],
    [
      "missing request ID",
      rootRequest("root-a"),
      { type: "dom.error", code: "stale-node" },
    ],
    [
      "wrong root response family",
      rootRequest("root-a"),
      childrenResponse("root-a"),
    ],
    [
      "wrong children response family",
      childrenRequest("children-a"),
      rootResponse("children-a"),
    ],
    [
      "wrong locator response family",
      locatorRequest("locator-a"),
      rootResponse("locator-a"),
    ],
    [
      "wrong root document epoch",
      { ...rootRequest("root-epoch"), documentEpoch: 2 },
      rootResponse("root-epoch"),
    ],
    [
      "wrong children document epoch",
      childrenRequest("children-epoch"),
      { ...childrenResponse("children-epoch"), documentEpoch: 2 },
    ],
    [
      "wrong children node reference",
      childrenRequest("children-node"),
      { ...childrenResponse("children-node"), nodeRef: "node-forged" },
    ],
    [
      "wrong children branch revision",
      childrenRequest("children-branch"),
      { ...childrenResponse("children-branch"), branchRevision: 1 },
    ],
    [
      "contradictory error document epoch",
      childrenRequest("children-error"),
      {
        type: "dom.error" as const,
        requestId: "children-error",
        documentEpoch: 2,
        code: "stale-branch" as const,
      },
    ],
  ])("returns a correlated internal error for a %s", async (
    _case,
    request,
    response,
  ) => {
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", request)).resolves.toEqual({
      type: "dom.error",
      requestId: request.requestId,
      code: "internal-error",
    });
  });

  it("accepts a correlated bounded error that omits documentEpoch", async () => {
    const response = {
      type: "dom.error" as const,
      requestId: "children-bounded-error",
      code: "stale-branch" as const,
    };
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request(
      "panel-a",
      childrenRequest("children-bounded-error"),
    )).resolves.toEqual(response);
  });

  it("coalesces concurrent selection republish for one channel binding", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((next) => {
      resolve = next;
    });
    const sendTabMessage = vi.fn(async () => response);
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    const first = transport.republishSelection("panel-a");
    const second = transport.republishSelection("panel-a");

    expect(sendTabMessage).toHaveBeenCalledOnce();
    resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("publishes only validated events to the bound panel channel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    transport.bind("panel-b", 8);
    const peerState: PeerStateMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "peerState",
      messageId: "peer-1",
      sessionId: "session-a",
      role: "ide",
      connected: false,
      peerGeneration: 1,
      metadata: {},
    };

    transport.publish("panel-a", peerState);
    transport.publish("panel-missing", peerState);

    expect(published).toEqual([{ channel: "panel-a", message: peerState }]);
  });

  it("publishes only strict navigation state while preserving optional and zero fields", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    transport.bind("panel-b", 8);
    const activeZero = sourceNavigationState(2, 0);
    const noActiveMatch = sourceNavigationState(0);

    transport.publish("panel-a", activeZero);
    transport.publish("panel-a", noActiveMatch);
    transport.publish("panel-missing", activeZero);
    transport.publish("panel-b", {
      ...activeZero,
      activeMatchIndex: 2,
    } as SourceNavigationStateMessage);
    transport.publish("panel-b", {
      ...activeZero,
      sessionId: "",
    } as SourceNavigationStateMessage);

    expect(published).toEqual([
      { channel: "panel-a", message: activeZero },
      { channel: "panel-a", message: noActiveMatch },
    ]);
  });

  it("publishes only strict source matches to the bound panel channel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    const matches = sourceMatches();
    const hostile = { ...matches } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "matches", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    const inherited = Object.create(matches) as SourceMatchesMessage;
    let proxyGetterCalls = 0;
    const proxyHostile = new Proxy(matches, {
      get() {
        proxyGetterCalls += 1;
        throw new Error("proxy getter must not run");
      },
      ownKeys() {
        throw new Error("proxy reflection is hostile");
      },
    });

    transport.publish("panel-a", matches);
    transport.publish("panel-missing", matches);
    transport.publish("panel-a", {
      ...matches,
      path: "/secret.scss",
    } as SourceMatchesMessage);
    expect(() => transport.publish(
      "panel-a",
      hostile as unknown as SourceMatchesMessage,
    )).not.toThrow();
    expect(() => transport.publish("panel-a", inherited)).not.toThrow();
    expect(() => transport.publish("panel-a", proxyHostile)).not.toThrow();

    expect(getterCalls).toBe(0);
    expect(proxyGetterCalls).toBe(0);
    expect(published).toEqual([{ channel: "panel-a", message: matches }]);
  });

  it("publishes a bounded correlated inspect start only to its bound panel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);

    transport.publishInspectStarted("panel-a", "inspect-1", 4);
    transport.publishInspectStarted("panel-missing", "inspect-2", 4);
    transport.publishInspectStarted("panel-a", "", 4);
    transport.publishInspectStarted("panel-a", "x".repeat(129), 4);
    transport.publishInspectStarted("panel-a", "inspect-negative", -1);
    transport.publishInspectStarted("panel-a", "inspect-fractional", 1.5);
    transport.publishInspectStarted(
      "panel-a",
      "inspect-unsafe",
      Number.MAX_SAFE_INTEGER + 1,
    );

    expect(published).toEqual([{
      channel: "panel-a",
      message: {
        type: "pin-op.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 4,
      },
    }]);
  });

  it("bounds channels and releases them through their handles", () => {
    const transport = new PanelSessionTransport({
      maxChannels: 1,
      sendTabMessage: vi.fn(),
      postPanelMessage: vi.fn(),
    });
    const first = transport.bind("panel-a", 7);

    expect(() => transport.bind("panel-b", 8)).toThrow(/limit/i);
    first.dispose();
    expect(() => transport.bind("panel-b", 8)).not.toThrow();
  });
});

function rootRequest(requestId: string) {
  return {
    type: "dom.getRoot" as const,
    requestId,
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
    documentEpoch: 1,
    nodeRef: "node-root",
    branchRevision: 0,
  };
}

function childrenResponse(requestId: string) {
  return {
    type: "dom.children" as const,
    requestId,
    documentEpoch: 1,
    nodeRef: "node-root",
    branchRevision: 0,
    nodes: [],
  };
}

function locatorRequest(requestId: string) {
  return {
    type: "dom.resolveLocator" as const,
    requestId,
    locator: stableLocator(),
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
    resolutionGeneration: 2,
    selectedMatchCount,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
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
    matches: [{
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
    }],
    omittedMatchCount: 0,
    metadata: {},
  };
}
