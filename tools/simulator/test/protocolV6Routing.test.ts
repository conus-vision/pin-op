import { once } from "node:events";
import {
  ClientRegistry,
  createBridgeServer,
  ReplyRouteRegistry,
  routeMessage as routeProductionMessage,
  type BridgeServer,
  type ClientRegistration,
  type RegisteredClient,
} from "@pin-op/bridge";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  PinOpMessageSchema,
  protocolMismatchReason,
  type InspectMessage,
  type PageRefreshMessage,
  type PinOpMessage,
  type ProtocolCapability,
  type ResolutionMessage,
  type SourceMatchesMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  TabRefreshCoordinator,
  TabRefreshStateStore,
  type SessionStorage,
} from "../../../packages/browser-extension-core/src/index.js";
import { buildInspectMessage, describeBridgeClose } from "../src/sendInspect.js";
import inspectCardFixture from "../fixtures/inspect-card.json";

const SESSION_ID = "simulator-v6";
const INSPECT_ID = "inspect-v6";

interface TestClient extends ClientRegistration {
  readonly sent: unknown[];
}

function client(
  role: "browser" | "ide" | "simulator",
  sourceId: string,
  capabilities: readonly ProtocolCapability[],
): TestClient {
  const sent: unknown[] = [];
  return {
    sent,
    connection: {
      send(payload) {
        sent.push(PinOpMessageSchema.parse(JSON.parse(payload)));
        return true;
      },
      terminate() {},
    },
    source: { role, id: sourceId, metadata: {} },
    sessionId: SESSION_ID,
    authToken: `${role}-${sourceId}-token`,
    capabilities,
  };
}

function inspect(
  messageId: string,
  ideHighlightEnabled: boolean,
): InspectMessage {
  return {
    ...buildInspectMessage(inspectCardFixture, {
      sessionId: SESSION_ID,
      sourceId: "simulator-a",
      ideHighlightEnabled,
    }),
    messageId,
  };
}

function refresh(
  generation: number,
  mode: "styles" | "reload",
): PageRefreshMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: `refresh-${generation}-${mode}`,
    sessionId: SESSION_ID,
    source: { role: "ide", id: "ide-a" },
    refreshGeneration: generation,
    mode,
    metadata: {},
  };
}

describe("simulator protocol v6 production routing", () => {
  it.each([
    ["Style Save", "styles"],
    ["Script Save", "reload"],
    ["PHP Save", "reload"],
  ] as const)("routes %s as a %s refresh", (_scenario, mode) => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ideConnection = client("ide", "ide-a", ["auto-refresh"]);
    const simulatorConnection = client("simulator", "simulator-a", [
      "auto-refresh",
    ]);
    const ide = registry.add(ideConnection);
    registry.add(simulatorConnection);

    const message = refresh(1, mode);
    routeMessage(registry, routes, ide, message);

    expect(simulatorConnection.sent).toEqual([message]);
  });

  it("routes IDE Highlight off and on in v6 inspect envelopes", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const simulatorConnection = client("simulator", "simulator-a", ["inspect"]);
    const ideConnection = client("ide", "ide-a", ["resolution"]);
    const simulator = registry.add(simulatorConnection);
    registry.add(ideConnection);

    routeMessage(registry, routes, simulator, inspect("inspect-off", false));
    routeMessage(registry, routes, simulator, inspect("inspect-on", true));

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        protocolVersion: 6,
        type: "inspect",
        ideHighlightEnabled: false,
      }),
      expect.objectContaining({
        protocolVersion: 6,
        type: "inspect",
        ideHighlightEnabled: true,
      }),
    ]);
  });

  it("opens an exact source match and rejects a stale source click", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const simulatorConnection = client("simulator", "simulator-a", [
      "inspect",
      "source-presentation",
    ]);
    const ideConnection = client("ide", "ide-a", [
      "resolution",
      "source-presentation",
    ]);
    const simulator = registry.add(simulatorConnection);
    const ide = registry.add(ideConnection);

    routeMessage(registry, routes, simulator, inspect(INSPECT_ID, true));
    ideConnection.sent.length = 0;
    routeMessage(registry, routes, ide, resolution(1));
    routeMessage(registry, routes, ide, matches(1, "match-current"));
    simulatorConnection.sent.length = 0;

    const current = sourceOpen(1, "match-current", "open-current");
    routeMessage(registry, routes, simulator, current);
    expect(ideConnection.sent.at(-1)).toEqual(current);

    routeMessage(registry, routes, ide, resolution(2));
    routeMessage(registry, routes, ide, matches(2, "match-new"));
    ideConnection.sent.length = 0;
    simulatorConnection.sent.length = 0;
    routeMessage(
      registry,
      routes,
      simulator,
      sourceOpen(1, "match-current", "open-stale"),
    );

    expect(ideConnection.sent).toEqual([]);
    expect(simulatorConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
  });
});

describe("simulator tab refresh workflow", () => {
  it("queues inactive participants and honors Auto Refresh off and on", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    const dispatched: Array<{ tabId: number; generation: number; mode: string }> = [];
    let activeTabId = 1;
    const coordinator = new TabRefreshCoordinator({
      store,
      getActiveTabId: async () => activeTabId,
      dispatchRefresh: (tabId, command) => {
        dispatched.push({
          tabId,
          generation: command.refreshGeneration,
          mode: command.mode,
        });
      },
      setRefreshParticipant() {},
    });

    await coordinator.panelOpened(1, 10);
    await coordinator.panelOpened(2, 10);
    await coordinator.acceptPageRefresh(10, refresh(1, "styles"));
    expect(dispatched).toEqual([{ tabId: 1, generation: 1, mode: "styles" }]);

    activeTabId = 2;
    await coordinator.activateTab(2, 10);
    expect(dispatched.at(-1)).toEqual({ tabId: 2, generation: 1, mode: "styles" });

    await coordinator.updateSettings(2, 10, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await coordinator.acceptPageRefresh(10, refresh(2, "reload"));
    expect(dispatched).toHaveLength(2);
    expect(await coordinator.state(2, 10)).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });

    await coordinator.updateSettings(2, 10, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });
    await coordinator.acceptPageRefresh(10, refresh(3, "reload"));
    expect(dispatched.at(-1)).toEqual({ tabId: 2, generation: 3, mode: "reload" });
    expect(await coordinator.state(2, 10)).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
    });
  });
});

describe("simulator protocol mismatch diagnostics", () => {
  let server: BridgeServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("observes one terminal protocol-v5 handshake rejection from a real bridge", async () => {
    server = createBridgeServer({ port: 0 });
    await server.start();
    const socket = new WebSocket(server.getUrl());
    await once(socket, "open");
    const received: string[] = [];
    socket.on("message", (payload) => received.push(payload.toString()));

    const closed = once(socket, "close");
    socket.send(JSON.stringify({ protocolVersion: 5, type: "hello" }));
    const [code, reason] = (await closed) as [number, Buffer];

    expect(code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
    expect(reason.toString()).toBe(protocolMismatchReason(5));
    expect(describeBridgeClose(code, reason.toString())).toBe(
      "Protocol mismatch: expected version 6, received version 5",
    );
    expect(received).toEqual([]);
  });
});

function resolution(generation: number): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${generation}`,
    sessionId: SESSION_ID,
    source: { role: "ide", id: "ide-a" },
    inspectMessageId: INSPECT_ID,
    resolutionGeneration: generation,
    status: "matched",
    selectedMatchCount: 1,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function matches(generation: number, matchId: string): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${generation}`,
    sessionId: SESSION_ID,
    source: { role: "ide", id: "ide-a" },
    inspectMessageId: INSPECT_ID,
    resolutionGeneration: generation,
    document: { label: "app.scss", languageId: "scss" },
    matches: [{
      matchId,
      targetRole: "selected",
      label: ".card",
      kind: "rule",
      relation: "declared-in",
      confidence: "exact",
      startLine: 1,
      endLine: 3,
      text: ".card {\n  display: grid;\n}",
      truncated: false,
    }],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function sourceOpen(
  generation: number,
  matchId: string,
  messageId: string,
): SourceOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId,
    sessionId: SESSION_ID,
    inspectMessageId: INSPECT_ID,
    resolutionGeneration: generation,
    matchId,
    metadata: {},
  };
}

function memoryStorage(): SessionStorage {
  const values: Record<string, unknown> = {};
  return {
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(key) {
      delete values[key];
    },
  };
}

function routeMessage(
  registry: ClientRegistry,
  routes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: PinOpMessage,
): void {
  routeProductionMessage(
    registry,
    routes,
    sender,
    PinOpMessageSchema.parse(message),
  );
}
