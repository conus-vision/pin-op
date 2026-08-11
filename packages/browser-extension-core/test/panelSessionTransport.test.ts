import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
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
        type: "browser2ide.inspect.started",
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
