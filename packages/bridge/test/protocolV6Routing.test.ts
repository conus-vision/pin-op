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

function sourceOpen(matchId: string, generation: number): SourceOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId: `open-${matchId}`,
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    resolutionGeneration: generation,
    matchId,
    metadata: {},
  };
}

function navigationState(
  sourceId: string,
  generation: number,
  state: Partial<
    Pick<
      SourceNavigationStateMessage,
      "selectedMatchCount" | "activeMatchIndex" | "activeMatchId"
    >
  > = {},
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `state-${sourceId}-${generation}-${
      state.selectedMatchCount ?? 0
    }-${state.activeMatchId ?? "none"}`,
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    source: { role: "ide", id: sourceId },
    resolutionGeneration: generation,
    selectedMatchCount: state.selectedMatchCount ?? 0,
    ...(state.activeMatchIndex === undefined
      ? {}
      : { activeMatchIndex: state.activeMatchIndex }),
    ...(state.activeMatchId === undefined
      ? {}
      : { activeMatchId: state.activeMatchId }),
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

  it("forwards competing empty invalidations ownerlessly until resolution wins", () => {
    const context = setup();
    const invalidationA = matches("ide-a", 0, []);
    const invalidationB = matches("ide-b", 7, []);
    const prematureMatches = matches("ide-a", 0, ["premature-match"]);
    const winningResolution = resolution("ide-b", 3);
    const losingResolution = resolution("ide-a", 3);
    const resolvedMatches = matches("ide-b", 3, ["resolved-match"]);

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      invalidationA,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideB,
      invalidationB,
    );
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.routes.get("session-1", "inspect-1")?.ideConnectionId)
      .toBeUndefined();
    expect(context.routes.get("session-1", "inspect-1")?.resolutionGeneration)
      .toBeUndefined();

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      prematureMatches,
    );
    expect(context.browserConnection.sent).toEqual([
      invalidationA,
      invalidationB,
    ]);

    routeMessage(
      context.registry,
      context.routes,
      context.ideB,
      winningResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      losingResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideB,
      resolvedMatches,
    );

    expect(context.browserConnection.sent).toEqual([
      invalidationA,
      invalidationB,
      winningResolution,
      resolvedMatches,
    ]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideB.id,
      resolutionGeneration: 3,
      resolutionClaimed: true,
      matchIds: new Set(["resolved-match"]),
    });
    expect(context.ideBConnection.sent).toEqual([]);
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("forwards ownerless Source clearing and zero navigation before resolution wins", () => {
    const context = setup();
    const invalidation = matches("ide-a", 0, []);
    const zeroState = navigationState("ide-a", 0);
    const winningResolution = resolution("ide-b", 1);

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      invalidation,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      zeroState,
    );

    expect(context.browserConnection.sent).toEqual([
      invalidation,
      zeroState,
    ]);
    expect(context.ideAConnection.sent).toEqual([]);
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.routes.get("session-1", "inspect-1")?.ideConnectionId)
      .toBeUndefined();
    expect(context.routes.get("session-1", "inspect-1")?.resolutionGeneration)
      .toBeUndefined();

    routeMessage(
      context.registry,
      context.routes,
      context.ideB,
      winningResolution,
    );

    expect(context.browserConnection.sent).toEqual([
      invalidation,
      zeroState,
      winningResolution,
    ]);
    expect(context.ideBConnection.sent).toEqual([]);
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideB.id,
      resolutionGeneration: 1,
      resolutionClaimed: true,
      matchIds: new Set(),
    });
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("does not let ownerless zero navigation authorize later active state", () => {
    const context = setup();
    const zeroState = navigationState("ide-a", 0);
    const nonzeroState = navigationState("ide-a", 0, {
      selectedMatchCount: 1,
      activeMatchIndex: 0,
    });
    const forgedActiveState = navigationState("ide-a", 0, {
      activeMatchId: "forged-match",
    });

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      zeroState,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      nonzeroState,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      forgedActiveState,
    );

    expect(context.browserConnection.sent).toEqual([zeroState]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.routes.get("session-1", "inspect-1")?.ideConnectionId)
      .toBeUndefined();
    expect(context.routes.get("session-1", "inspect-1")?.resolutionGeneration)
      .toBeUndefined();
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("rejects ownerless zero navigation from an IDE without resolution", () => {
    const context = setup();
    const navigationOnlyConnection = client(
      "ide",
      "session-1",
      ["source-navigation"],
      "navigation-only",
    );
    const navigationOnly = context.registry.add(navigationOnlyConnection);

    routeMessage(
      context.registry,
      context.routes,
      navigationOnly,
      navigationState("navigation-only", 0),
    );

    expect(context.browserConnection.sent).toEqual([]);
    expect(navigationOnlyConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.routes.get("session-1", "inspect-1")?.ideConnectionId)
      .toBeUndefined();
    expect(context.routes.get("session-1", "inspect-1")?.resolutionGeneration)
      .toBeUndefined();
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("clears source.open IDs on repeated same-generation resolution", () => {
    const context = setup();
    const firstResolution = resolution("ide-a", 2);
    const firstMatches = matches("ide-a", 2, ["old-match"]);
    const repeatedResolution = {
      ...firstResolution,
      messageId: "resolution-ide-a-2-repeated",
    };
    routeMessage(context.registry, context.routes, context.ideA, firstResolution);
    routeMessage(context.registry, context.routes, context.ideA, firstMatches);

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      repeatedResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.browser,
      sourceOpen("old-match", 2),
    );

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      resolutionClaimed: true,
      matchIds: new Set(),
    });
    expect(context.browserConnection.sent).toEqual([
      firstResolution,
      firstMatches,
      repeatedResolution,
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(context.ideAConnection.sent).toEqual([]);

    const nextMatches = matches("ide-a", 2, ["new-match"]);
    routeMessage(context.registry, context.routes, context.ideA, nextMatches);
    expect(context.browserConnection.sent.at(-1)).toEqual(nextMatches);
  });

  it("advances an owned route with empty invalidation and clears match IDs immediately", () => {
    const context = setup();
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      resolution("ide-a", 2),
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      matches("ide-a", 2, ["old-match"]),
    );
    const invalidation = matches("ide-a", 3, []);

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      invalidation,
    );

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideA.id,
      resolutionGeneration: 3,
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.browserConnection.sent.at(-1)).toEqual(invalidation);

    const staleOpen: SourceOpenMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.open",
      messageId: "open-cleared-match",
      sessionId: "session-1",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      matchId: "old-match",
      metadata: {},
    };
    routeMessage(
      context.registry,
      context.routes,
      context.browser,
      staleOpen,
    );
    expect(context.ideAConnection.sent).toEqual([]);
    expect(context.browserConnection.sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    );

    const nextResolution = resolution("ide-a", 3);
    const nextMatches = matches("ide-a", 3, ["next-match"]);
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      nextResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      nextMatches,
    );
    expect(context.browserConnection.sent.slice(-2)).toEqual([
      nextResolution,
      nextMatches,
    ]);
  });

  it("revokes same-generation resolution and matches on another invalidation", () => {
    const context = setup();
    const firstResolution = resolution("ide-a", 4);
    const firstMatches = matches("ide-a", 4, ["first-match"]);
    const invalidation = matches("ide-a", 4, []);
    const bypass = matches("ide-a", 4, ["bypass-match"]);
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      firstResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      firstMatches,
    );

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      invalidation,
    );
    routeMessage(context.registry, context.routes, context.ideA, bypass);

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideA.id,
      resolutionGeneration: 4,
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.browserConnection.sent).toEqual([
      firstResolution,
      firstMatches,
      invalidation,
    ]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);

    const repeatedResolution = {
      ...firstResolution,
      messageId: "resolution-ide-a-4-repeated",
    };
    const repeatedMatches = matches("ide-a", 4, ["re-enabled-match"]);
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      repeatedResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      repeatedMatches,
    );
    expect(context.browserConnection.sent.slice(-2)).toEqual([
      repeatedResolution,
      repeatedMatches,
    ]);
  });

  it("requires resolution authority for nonzero navigation after invalidation", () => {
    const context = setup();
    const currentResolution = resolution("ide-a", 4);
    const invalidation = matches("ide-a", 4, []);
    const nonzeroState = navigationState("ide-a", 4, {
      selectedMatchCount: 1,
      activeMatchIndex: 0,
    });
    const zeroState = navigationState("ide-a", 4);

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      currentResolution,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      invalidation,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      nonzeroState,
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      zeroState,
    );

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideA.id,
      resolutionGeneration: 4,
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(context.browserConnection.sent).toEqual([
      currentResolution,
      invalidation,
      zeroState,
    ]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(context.otherBrowserConnection.sent).toEqual([]);
  });

  it("rejects second-IDE and stale empty invalidations without changing authority", () => {
    const context = setup();
    const claimed = matches("ide-a", 2, []);
    const currentResolution = resolution("ide-a", 2);
    const current = matches("ide-a", 2, ["current-match"]);
    const raced = matches("ide-b", 3, []);
    const stale = matches("ide-a", 1, []);

    routeMessage(context.registry, context.routes, context.ideA, claimed);
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      currentResolution,
    );
    routeMessage(context.registry, context.routes, context.ideA, current);
    routeMessage(context.registry, context.routes, context.ideB, raced);
    routeMessage(context.registry, context.routes, context.ideA, stale);

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: context.ideA.id,
      resolutionGeneration: 2,
      resolutionClaimed: true,
      matchIds: new Set(["current-match"]),
    });
    expect(context.browserConnection.sent).toEqual([
      claimed,
      currentResolution,
      current,
    ]);
    expect(context.ideBConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
  });

  it("requires exact claimed generation for nonempty or omitted empty matches", () => {
    const context = setup();
    const nonempty = matches("ide-a", 0, ["unclaimed"]);
    const omittedEmpty = {
      ...matches("ide-a", 0, []),
      messageId: "matches-empty-omitted",
      omittedMatchCount: 1,
    };

    routeMessage(context.registry, context.routes, context.ideA, nonempty);
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      omittedEmpty,
    );

    expect(context.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: undefined,
      resolutionGeneration: undefined,
      matchIds: new Set(),
    });
    expect(context.browserConnection.sent).toEqual([]);
    expect(context.ideAConnection.sent).toHaveLength(2);
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
  });

  it("fails closed for invalid empty-invalidation peers and revoked routes", () => {
    const wrongSession = setup();
    routeMessage(
      wrongSession.registry,
      wrongSession.routes,
      wrongSession.ideA,
      { ...matches("ide-a", 0, []), sessionId: "session-2" },
    );
    expect(wrongSession.browserConnection.sent).toEqual([]);
    expect(wrongSession.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: undefined,
    });

    const wrongRole = setup();
    routeMessage(
      wrongRole.registry,
      wrongRole.routes,
      wrongRole.browser,
      matches("ide-a", 0, []),
    );
    expect(wrongRole.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: undefined,
    });

    const incapable = setup();
    const sourceOnlyConnection = client(
      "ide",
      "session-1",
      ["source-presentation"],
      "source-only",
    );
    const sourceOnly = incapable.registry.add(sourceOnlyConnection);
    routeMessage(
      incapable.registry,
      incapable.routes,
      sourceOnly,
      matches("source-only", 0, []),
    );
    expect(incapable.routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: undefined,
    });
    expect(incapable.browserConnection.sent).toEqual([]);

    const revoked = setup();
    revoked.routes.remove("session-1", "inspect-1");
    routeMessage(
      revoked.registry,
      revoked.routes,
      revoked.ideA,
      matches("ide-a", 0, []),
    );
    expect(revoked.routes.get("session-1", "inspect-1")).toBeUndefined();
    expect(revoked.browserConnection.sent).toEqual([]);
  });

  it("removes a newly claimed invalidation route when browser send fails", () => {
    const context = setup();
    context.browserConnection.connection.send = () => false;

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      matches("ide-a", 0, []),
    );

    expect(context.routes.get("session-1", "inspect-1")).toBeUndefined();
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
  });

  it("removes an advanced route when invalidation forwarding fails", () => {
    const context = setup();
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      resolution("ide-a", 1),
    );
    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      matches("ide-a", 1, ["old-match"]),
    );
    context.browserConnection.connection.send = () => false;

    routeMessage(
      context.registry,
      context.routes,
      context.ideA,
      matches("ide-a", 2, []),
    );

    expect(context.routes.get("session-1", "inspect-1")).toBeUndefined();
    expect(context.ideAConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
  });

  it("does not claim invalidation authority for an incapable origin browser", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["inspect"],
      "browser-a",
    );
    const ideConnection = client(
      "ide",
      "session-1",
      ["resolution", "source-presentation"],
      "ide-a",
    );
    const browser = registry.add(browserConnection);
    const ide = registry.add(ideConnection);
    routeMessage(registry, routes, browser, inspect());
    ideConnection.sent.length = 0;

    routeMessage(registry, routes, ide, matches("ide-a", 0, []));

    expect(routes.get("session-1", "inspect-1")).toMatchObject({
      ideConnectionId: undefined,
      resolutionGeneration: undefined,
      matchIds: new Set(),
    });
    expect(browserConnection.sent).toEqual([]);
    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
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
