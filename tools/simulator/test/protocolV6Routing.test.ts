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
  BackgroundInspectCoordinator,
  createBackgroundRouter,
  TabRefreshCoordinator,
  TabRefreshStateStore,
  type BackgroundWindowCoordinator,
  type SessionStorage,
} from "../../../packages/browser-extension-core/src/index.js";
import {
  BridgeClient,
  PageRefreshClientRouter,
  type SocketLike,
} from "../../../extensions/vscode/src/bridgeClient.js";
import { RefreshClassifierRegistry } from "../../../extensions/vscode/src/refresh/refreshClassifierRegistry.js";
import {
  SaveObserver,
  type RefreshDocumentLike,
} from "../../../extensions/vscode/src/refresh/saveObserver.js";
import { buildInspectMessage, describeBridgeClose } from "../src/sendInspect.js";
import inspectCardFixture from "../fixtures/inspect-card.json";

const SESSION_ID = "simulator-v6";
const INSPECT_ID = "inspect-v6";
const BRIDGE_INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const AUTH_TOKEN = "a".repeat(64);
const WINDOW_ID = 10;

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

describe("simulator protocol v6 production routing", () => {
  it.each([
    ["CSS", "file:///project/app.css", "css", 150, "styles"],
    ["SCSS", "file:///project/app.scss", "scss", 750, "styles"],
    ["JavaScript", "file:///project/app.js", "javascript", 150, "reload"],
    ["PHP", "file:///project/template.php", "php", 150, "reload"],
  ] as const)(
    "classifies and schedules a changed %s save through the production refresh path",
    async (_scenario, uri, languageId, delay, expectedMode) => {
      const harness = await createProductionRefreshHarness();
      try {
        harness.changeAndSave(uri, languageId);
        harness.advance(delay - 1);
        await harness.settle();
        expect(harness.dispatched).toEqual([]);

        harness.advance(1);
        await harness.settle();

        expect(harness.bridgeRefreshes).toEqual([
          expect.objectContaining({
            protocolVersion: PROTOCOL_VERSION,
            type: "page.refresh",
            refreshGeneration: 1,
            mode: expectedMode,
          }),
        ]);
        expect(harness.dispatched).toEqual([
          { tabId: 1, generation: 1, mode: expectedMode },
        ]);
      } finally {
        harness.dispose();
      }
    },
  );

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
  it("delivers bridge refreshes to active tabs and queues inactive participants", async () => {
    const harness = await createProductionRefreshHarness();
    try {
      harness.changeAndSave("file:///project/app.css", "css");
      harness.advance(150);
      await harness.settle();
      expect(harness.dispatched).toEqual([
        { tabId: 1, generation: 1, mode: "styles" },
      ]);

      await harness.activate(2);
      expect(harness.dispatched.at(-1)).toEqual({
        tabId: 2,
        generation: 1,
        mode: "styles",
      });

      await harness.updateSettings(2, false, false);
      harness.changeAndSave("file:///project/app.js", "javascript");
      harness.advance(150);
      await harness.settle();
      expect(harness.dispatched).toHaveLength(2);

      await harness.activate(1);
      expect(harness.dispatched.at(-1)).toEqual({
        tabId: 1,
        generation: 2,
        mode: "reload",
      });
      expect(await harness.state(2)).toMatchObject({
        autoRefreshEnabled: false,
        ideHighlightEnabled: false,
        participant: false,
      });

      await harness.updateSettings(2, true, true);
      harness.changeAndSave("file:///project/template.php", "php");
      harness.advance(150);
      await harness.settle();
      expect(harness.dispatched.at(-1)).toEqual({
        tabId: 1,
        generation: 3,
        mode: "reload",
      });

      await harness.activate(2);
      expect(harness.dispatched.at(-1)).toEqual({
        tabId: 2,
        generation: 3,
        mode: "reload",
      });
      expect(await harness.state(2)).toMatchObject({
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        participant: true,
      });
    } finally {
      harness.dispose();
    }
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

async function createProductionRefreshHarness() {
  let now = 0;
  let nextTimerId = 0;
  let activeTabId = 1;
  const timers = new Map<
    number,
    { readonly callback: () => void; readonly dueAt: number }
  >();
  const dispatched: Array<{
    tabId: number;
    generation: number;
    mode: string;
  }> = [];
  const bridgeRefreshes: PageRefreshMessage[] = [];
  const pageRefreshListeners = new Set<
    (windowId: number, message: PageRefreshMessage) => void
  >();
  const registry = new ClientRegistry();
  const routes = new ReplyRouteRegistry();
  const tabRefreshCoordinator = new TabRefreshCoordinator({
    store: new TabRefreshStateStore(memoryStorage()),
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
  await tabRefreshCoordinator.panelOpened(1, WINDOW_ID);
  await tabRefreshCoordinator.panelOpened(2, WINDOW_ID);

  const backgroundRouter = createBackgroundRouter({
    getTab: async () => undefined,
    coordinator: unusedWindowCoordinator(),
    tabRefreshCoordinator,
    inspectCoordinator: new BackgroundInspectCoordinator({
      executeScript: async () => undefined,
      sendTabMessage: async () => undefined,
    }),
    subscribePageRefreshes(listener) {
      pageRefreshListeners.add(listener);
      return () => pageRefreshListeners.delete(listener);
    },
  });

  registry.add({
    connection: {
      send(payload) {
        const message = PinOpMessageSchema.parse(JSON.parse(payload));
        if (message.type !== "page.refresh") return true;
        bridgeRefreshes.push(message);
        for (const listener of pageRefreshListeners) {
          listener(WINDOW_ID, message);
        }
        return true;
      },
      terminate() {},
    },
    source: { role: "browser", id: "browser-refresh", metadata: {} },
    sessionId: SESSION_ID,
    authToken: "browser-refresh-token",
    capabilities: ["auto-refresh"],
  });

  let ideRegistration: RegisteredClient | undefined;
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: WebSocket.OPEN,
    send(payload) {
      const message = PinOpMessageSchema.parse(JSON.parse(payload));
      if (message.type === "hello") {
        ideRegistration = registry.add({
          connection: {
            send() {
              return true;
            },
            terminate() {},
          },
          source: message.source,
          sessionId: message.sessionId,
          authToken: message.authToken,
          capabilities: message.capabilities,
        });
        socket.onmessage?.({
          data: JSON.stringify(PinOpMessageSchema.parse({
            protocolVersion: PROTOCOL_VERSION,
            type: "authenticated",
            messageId: "authenticated-refresh",
            sessionId: SESSION_ID,
            bridgeInstanceId: BRIDGE_INSTANCE_ID,
            metadata: {},
          })),
        });
        return;
      }
      if (!ideRegistration) {
        throw new Error("IDE transport sent data before authentication");
      }
      routeMessage(registry, routes, ideRegistration, message);
    },
    close() {},
  };
  const ideClient = new BridgeClient({
    url: "ws://127.0.0.1:48735",
    sessionId: SESSION_ID,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    authToken: AUTH_TOKEN,
    socketFactory: () => socket,
  });
  ideClient.connect();
  socket.onopen?.({});
  const pageRefreshClients = new PageRefreshClientRouter();
  pageRefreshClients.bind(ideClient);

  const observer = new SaveObserver({
    classifierRegistry: new RefreshClassifierRegistry(),
    sink: {
      publish(mode) {
        pageRefreshClients.sendPageRefresh({ mode });
      },
    },
    now: () => now,
    setTimeout(callback, delay) {
      const timerId = ++nextTimerId;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      timers.delete(timer as unknown as number);
    },
  });

  const settle = async (): Promise<void> => {
    await tabRefreshCoordinator.state(1, WINDOW_ID);
  };

  return {
    bridgeRefreshes,
    dispatched,
    changeAndSave(uri: string, languageId: string): void {
      const savedDocument: RefreshDocumentLike = {
        uri: { toString: () => uri },
        languageId,
      };
      observer.onDidChangeTextDocument({
        document: savedDocument,
        contentChanges: [{}],
      });
      observer.onDidSaveTextDocument(savedDocument);
    },
    advance(duration: number): void {
      const target = now + duration;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) =>
            left[1].dueAt - right[1].dueAt || left[0] - right[0]
          )[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
    settle,
    async activate(tabId: number): Promise<void> {
      activeTabId = tabId;
      await tabRefreshCoordinator.activateTab(tabId, WINDOW_ID);
    },
    updateSettings(
      tabId: number,
      autoRefreshEnabled: boolean,
      ideHighlightEnabled: boolean,
    ) {
      return tabRefreshCoordinator.updateSettings(tabId, WINDOW_ID, {
        autoRefreshEnabled,
        ideHighlightEnabled,
      });
    },
    state(tabId: number) {
      return tabRefreshCoordinator.state(tabId, WINDOW_ID);
    },
    dispose(): void {
      observer.dispose();
      pageRefreshClients.unbind(ideClient);
      ideClient.dispose();
      backgroundRouter.dispose();
    },
  };
}

function unusedWindowCoordinator(): BackgroundWindowCoordinator {
  return new Proxy({}, {
    get() {
      return () => {
        throw new Error("Unexpected window coordinator call");
      };
    },
  }) as BackgroundWindowCoordinator;
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
