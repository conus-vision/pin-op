import {
  PROTOCOL_VERSION,
  type InspectMessage,
  type PageRefreshMessage,
  type PresentationSettingsMessage,
  type ProtocolCapability,
  type ResolutionMessage,
  type SourceMatchesMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { ClientRegistry, type ClientRegistration } from "../src/clientRegistry.js";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";
import { routeMessage } from "../src/router.js";

interface TestClient extends ClientRegistration {
  readonly sent: unknown[];
}

function client(
  role: "browser" | "ide" | "simulator",
  sessionId: string,
  capabilities: readonly ProtocolCapability[],
  sourceId: string,
): TestClient {
  const sent: unknown[] = [];
  return {
    sent,
    connection: {
      send(payload) {
        sent.push(JSON.parse(payload));
        return true;
      },
      terminate() {},
    },
    source: { role, id: sourceId, metadata: {} },
    sessionId,
    authToken: `${role}-${sourceId}-token`,
    capabilities,
  };
}

function inspect(messageId = "inspect-1", sessionId = "session-1"): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId,
    sessionId,
    source: { role: "browser", id: "browser-a", metadata: {} },
    ideHighlightEnabled: true,
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: "#target", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function resolution(
  sourceId: string,
  generation: number,
  inspectMessageId = "inspect-1",
  sessionId = "session-1",
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${sourceId}-${generation}`,
    sessionId,
    source: { role: "ide", id: sourceId },
    inspectMessageId,
    resolutionGeneration: generation,
    status: "no-facts",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function matches(
  sourceId: string,
  generation: number,
  matchIds: readonly string[],
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${generation}-${matchIds.join("-")}`,
    sessionId: "session-1",
    source: { role: "ide", id: sourceId },
    inspectMessageId: "inspect-1",
    resolutionGeneration: generation,
    document: { label: "app.ts", languageId: "typescript" },
    matches: matchIds.map((matchId, index) => ({
      matchId,
      targetRole: "selected",
      label: `Match ${index + 1}`,
      kind: "rule",
      relation: "declared-in",
      confidence: "exact",
      startLine: index + 1,
      endLine: index + 1,
      text: ".target {}",
      truncated: false,
    })),
    omittedMatchCount: 0,
    metadata: {},
  };
}

function setup() {
  const registry = new ClientRegistry();
  const routes = new ReplyRouteRegistry();
  const browserConnection = client(
    "browser",
    "session-1",
    ["inspect", "source-presentation", "presentation-settings", "source-navigation", "auto-refresh"],
    "browser-a",
  );
  const otherBrowserConnection = client(
    "browser",
    "session-1",
    ["source-presentation", "presentation-settings", "source-navigation", "auto-refresh"],
    "browser-b",
  );
  const ideAConnection = client(
    "ide",
    "session-1",
    ["resolution", "source-presentation", "presentation-settings", "source-navigation", "auto-refresh"],
    "ide-a",
  );
  const ideBConnection = client(
    "ide",
    "session-1",
    ["resolution", "source-presentation", "presentation-settings", "source-navigation", "auto-refresh"],
    "ide-b",
  );
  const browser = registry.add(browserConnection);
  const otherBrowser = registry.add(otherBrowserConnection);
  const ideA = registry.add(ideAConnection);
  const ideB = registry.add(ideBConnection);
  routeMessage(registry, routes, browser, inspect());
  ideAConnection.sent.length = 0;
  ideBConnection.sent.length = 0;
  return {
    registry,
    routes,
    browser,
    otherBrowser,
    ideA,
    ideB,
    browserConnection,
    otherBrowserConnection,
    ideAConnection,
    ideBConnection,
  };
}

describe("protocol v6 bridge routing", () => {
  it("lets the first valid resolution claim a route and rejects a second IDE race", () => {
    const context = setup();
    const first = resolution("ide-a", 2);
    const raced = resolution("ide-b", 2);

    routeMessage(context.registry, context.routes, context.ideA, first);
    routeMessage(context.registry, context.routes, context.ideB, raced);

    expect(context.browserConnection.sent).toEqual([first]);
    expect(context.ideBConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
  });

  it("allows the owner to advance generation, rejects stale resolution, and clears match IDs", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 2));
    routeMessage(context.registry, context.routes, context.ideA, matches("ide-a", 2, ["old-match"]));
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 3));
    const stale = resolution("ide-a", 2);
    routeMessage(context.registry, context.routes, context.ideA, stale);
    const oldOpen: SourceOpenMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.open",
      messageId: "open-old",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      matchId: "old-match",
      metadata: {},
    };
    routeMessage(context.registry, context.routes, context.browser, oldOpen);

    expect(context.browserConnection.sent).toEqual([
      expect.objectContaining({ type: "resolution", resolutionGeneration: 2 }),
      expect.objectContaining({ type: "source.matches", resolutionGeneration: 2 }),
      expect.objectContaining({ type: "resolution", resolutionGeneration: 3 }),
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
  });

  it("routes matches and open only between the exact authoritative peers", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 4));
    const sourceMatches = matches("ide-a", 4, ["match-a"]);
    routeMessage(context.registry, context.routes, context.ideA, sourceMatches);
    const sourceOpen: SourceOpenMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.open",
      messageId: "open-a",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 4,
      matchId: "match-a",
      metadata: {},
    };
    routeMessage(context.registry, context.routes, context.browser, sourceOpen);

    expect(context.browserConnection.sent).toEqual([
      expect.objectContaining({ type: "resolution" }),
      sourceMatches,
    ]);
    expect(context.otherBrowserConnection.sent).toEqual([]);
    expect(context.ideAConnection.sent).toEqual([sourceOpen]);
    expect(context.ideBConnection.sent).toEqual([]);
  });

  it("atomically replaces the source.matches allowlist", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 5));
    routeMessage(context.registry, context.routes, context.ideA, matches("ide-a", 5, ["a", "b"]));
    routeMessage(context.registry, context.routes, context.ideA, matches("ide-a", 5, ["c"]));

    const open = (matchId: string): SourceOpenMessage => ({
      protocolVersion: PROTOCOL_VERSION,
      type: "source.open",
      messageId: `open-${matchId}`,
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 5,
      matchId,
      metadata: {},
    });
    routeMessage(context.registry, context.routes, context.browser, open("a"));
    routeMessage(context.registry, context.routes, context.browser, open("c"));

    expect(context.ideAConnection.sent).toEqual([open("c")]);
    expect(context.browserConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    );
  });

  it("routes settings and navigation only between the origin and owner", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 6));
    const settings: PresentationSettingsMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "presentation.settings",
      messageId: "settings-1",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      ideHighlightEnabled: false,
      metadata: {},
    };
    const navigate: SourceNavigateMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-1",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 6,
      direction: "next",
      metadata: {},
    };
    routeMessage(context.registry, context.routes, context.browser, settings);
    routeMessage(context.registry, context.routes, context.browser, navigate);

    expect(context.ideAConnection.sent).toEqual([settings, navigate]);
    expect(context.ideBConnection.sent).toEqual([]);
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("accepts navigation state only from the owner and validates activeMatchId", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 7));
    routeMessage(context.registry, context.routes, context.ideA, matches("ide-a", 7, ["included"]));
    const state = (sourceId: string, activeMatchId: string): SourceNavigationStateMessage => ({
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: `state-${sourceId}-${activeMatchId}`,
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      source: { role: "ide", id: sourceId },
      resolutionGeneration: 7,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      activeMatchId,
      metadata: {},
    });

    routeMessage(context.registry, context.routes, context.ideA, state("ide-a", "forged"));
    routeMessage(context.registry, context.routes, context.ideB, state("ide-b", "included"));
    routeMessage(context.registry, context.routes, context.ideA, state("ide-a", "included"));

    expect(context.browserConnection.sent.at(-1)).toEqual(state("ide-a", "included"));
    expect(context.browserConnection.sent).not.toContainEqual(state("ide-a", "forged"));
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
    expect(context.ideBConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
  });

  it("rejects settings from another browser and messages with wrong capability or route", () => {
    const context = setup();
    routeMessage(context.registry, context.routes, context.ideA, resolution("ide-a", 8));
    const settings: PresentationSettingsMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "presentation.settings",
      messageId: "settings-forged",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      ideHighlightEnabled: false,
      metadata: {},
    };
    routeMessage(context.registry, context.routes, context.otherBrowser, settings);

    const incapableConnection = client("ide", "session-1", [], "ide-incapable");
    const incapable = context.registry.add(incapableConnection);
    routeMessage(context.registry, context.routes, incapable, resolution("ide-incapable", 8));
    routeMessage(context.registry, context.routes, context.browser, {
      ...settings,
      messageId: "settings-unknown",
      inspectMessageId: "unknown",
    });

    expect(context.ideAConnection.sent).toEqual([]);
    expect(context.otherBrowserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
    expect(incapableConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
    expect(context.browserConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    );
  });

  it("removes routes when either the originating browser or owning IDE disconnects", () => {
    const ideCleanup = setup();
    routeMessage(ideCleanup.registry, ideCleanup.routes, ideCleanup.ideA, resolution("ide-a", 9));
    ideCleanup.routes.removeClient(ideCleanup.ideA.id);
    expect(ideCleanup.routes.peek("session-1", "inspect-1")).toBeUndefined();

    const browserCleanup = setup();
    routeMessage(browserCleanup.registry, browserCleanup.routes, browserCleanup.ideA, resolution("ide-a", 9));
    browserCleanup.routes.removeClient(browserCleanup.browser.id);
    expect(browserCleanup.routes.peek("session-1", "inspect-1")).toBeUndefined();
  });

  it("broadcasts page.refresh only to capable browser peers in the same session", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ideConnection = client("ide", "session-1", ["auto-refresh"], "ide-a");
    const capableBrowser = client("browser", "session-1", ["auto-refresh"], "browser-a");
    const capableSimulator = client("simulator", "session-1", ["auto-refresh"], "sim-a");
    const incapableBrowser = client("browser", "session-1", [], "browser-b");
    const otherSession = client("browser", "session-2", ["auto-refresh"], "browser-c");
    const ide = registry.add(ideConnection);
    registry.add(capableBrowser);
    registry.add(capableSimulator);
    registry.add(incapableBrowser);
    registry.add(otherSession);
    const refresh: PageRefreshMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "page.refresh",
      messageId: "refresh-1",
      sessionId: "session-1",
      source: { role: "ide", id: "ide-a" },
      refreshGeneration: 3,
      mode: "styles",
      metadata: {},
    };

    routeMessage(registry, routes, ide, refresh);
    routeMessage(registry, routes, ide, { ...refresh, messageId: "refresh-2" });

    expect(capableBrowser.sent).toEqual([refresh, { ...refresh, messageId: "refresh-2" }]);
    expect(capableSimulator.sent).toEqual([refresh, { ...refresh, messageId: "refresh-2" }]);
    expect(incapableBrowser.sent).toEqual([]);
    expect(otherSession.sent).toEqual([]);
  });

  it.each([
    ["source ID", "session-1", "forged-ide", ["auto-refresh"]],
    ["session", "session-2", "ide-a", ["auto-refresh"]],
    ["capability", "session-1", "ide-a", []],
  ] as const)(
    "rejects page.refresh with the wrong %s",
    (_case, messageSessionId, sourceId, capabilities) => {
      const registry = new ClientRegistry();
      const routes = new ReplyRouteRegistry();
      const ideConnection = client(
        "ide",
        "session-1",
        capabilities,
        "ide-a",
      );
      const browserConnection = client(
        "browser",
        messageSessionId,
        ["auto-refresh"],
        "browser-a",
      );
      const ide = registry.add(ideConnection);
      registry.add(browserConnection);
      const refresh: PageRefreshMessage = {
        protocolVersion: PROTOCOL_VERSION,
        type: "page.refresh",
        messageId: "refresh-invalid",
        sessionId: messageSessionId,
        source: { role: "ide", id: sourceId },
        refreshGeneration: 1,
        mode: "reload",
        metadata: {},
      };

      routeMessage(registry, routes, ide, refresh);

      expect(browserConnection.sent).toEqual([]);
      expect(ideConnection.sent).toEqual([
        expect.objectContaining({
          type: "error",
          code: "protocol.invalidMessage",
        }),
      ]);
    },
  );
});
