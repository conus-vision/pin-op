import {
  PROTOCOL_VERSION,
  type PinOpMessage,
  type ProtocolCapability,
} from "@pinop/protocol";
import { describe, expect, it } from "vitest";
import * as clientRegistry from "../src/clientRegistry.js";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";
import { routeMessage } from "../src/router.js";

const { ClientRegistry } = clientRegistry;

function client(
  role: "browser" | "ide" | "simulator",
  sessionId: string,
  capabilities: readonly ProtocolCapability[] = [],
  sourceId = `${role}-source`,
) {
  const sent: unknown[] = [];
  return {
    sent,
    connection: {
      send: (payload: string) => {
        sent.push(JSON.parse(payload));
        return true;
      },
      terminate: () => undefined,
    },
    source: { role, id: sourceId, metadata: {} },
    sessionId,
    authToken: `${role}-${sessionId}-token`,
    capabilities,
  };
}

const inspectMessage: Extract<PinOpMessage, { type: "inspect" }> = {
  protocolVersion: PROTOCOL_VERSION,
  type: "inspect",
  messageId: "inspect-1",
  sessionId: "session-1",
  source: { role: "browser", id: "browser-source", metadata: {} },
  targets: [
    {
      role: "selected",
      depth: 0,
      subject: { selector: "#submit", metadata: {} },
      facts: [],
      metadata: {},
    },
  ],
  context: { url: "http://localhost:3000", metadata: {} },
  metadata: {},
};

const simulatorInspectMessage: Extract<
  PinOpMessage,
  { type: "inspect" }
> = {
  ...inspectMessage,
  messageId: "inspect-simulator-1",
  source: { role: "simulator", id: "simulator-source", metadata: {} },
};

describe("bridge router and registry", () => {
  it("stores clients by protocol sessionId and role", () => {
    const registry = new clientRegistry.ClientRegistry();
    const ide = registry.add(client("ide", "session-1"));
    registry.add(client("browser", "session-1"));
    registry.add(client("ide", "session-2"));

    expect(registry.findBySessionAndRole("session-1", "ide")).toEqual([ide]);
    expect(registry.findBySessionAndRole("session-1", "browser")).toHaveLength(1);
    expect(registry.findBySessionAndRole("session-2", "ide")).toHaveLength(1);
    expect(registry.countByRole("browser")).toBe(1);
    expect(registry.countByRole("ide")).toBe(2);
    expect(registry.get(ide.id)).toBe(ide);

    registry.remove(ide.id);
    expect(registry.findBySessionAndRole("session-1", "ide")).toEqual([]);

    registry.clear();
    expect(registry.all()).toEqual([]);
  });

  it("stores a frozen copy of authenticated client capabilities", () => {
    const registry = new clientRegistry.ClientRegistry();
    const capabilities: ProtocolCapability[] = ["inspect"];
    const registered = registry.add(
      client("browser", "session-1", capabilities),
    );

    capabilities.push("source-navigation");

    expect(registered.capabilities).toEqual(["inspect"]);
    expect(Object.isFrozen(registered.capabilities)).toBe(true);
  });

  it("checks capabilities retained by the registry", () => {
    const registry = new clientRegistry.ClientRegistry();
    const registered = registry.add(
      client("browser", "session-1", ["inspect"]),
    );

    expect(clientRegistry.supportsCapability(registered, "inspect")).toBe(true);
    expect(
      clientRegistry.supportsCapability(registered, "source-navigation"),
    ).toBe(false);
  });

  it("routes inspect from browser and simulator clients to IDE clients in the same session", () => {
    const registry = new ClientRegistry();
    const ideSame = client("ide", "session-1");
    const ideOther = client("ide", "session-2");
    const browser = registry.add(client("browser", "session-1"));
    registry.add(ideSame);
    registry.add(ideOther);

    routeMessage(registry, new ReplyRouteRegistry(), browser, inspectMessage);

    expect(ideSame.sent).toEqual([inspectMessage]);
    expect(ideOther.sent).toEqual([]);

    const simulator = registry.add(client("simulator", "session-1"));
    routeMessage(registry, new ReplyRouteRegistry(), simulator, simulatorInspectMessage);

    expect(ideSame.sent).toEqual([inspectMessage, simulatorInspectMessage]);
    expect(ideOther.sent).toEqual([]);
  });

  it("reports when an inspect message has no IDE recipient", () => {
    const registry = new ClientRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);

    routeMessage(registry, new ReplyRouteRegistry(), browser, inspectMessage);

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noIdeClient",
      }),
    ]);
  });

  it("contains recipient send failures", () => {
    const registry = new ClientRegistry();
    const browser = registry.add(client("browser", "session-1"));
    const ide = client("ide", "session-1");
    ide.connection.send = () => {
      throw new Error("send failed");
    };
    registry.add(ide);

    expect(() =>
      routeMessage(registry, new ReplyRouteRegistry(), browser, inspectMessage),
    ).not.toThrow();
  });

  it("routes each resolution only to its originating browser or simulator", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ideConnection = client("ide", "session-1");
    const otherIdeConnection = client("ide", "session-2");
    const browserAConnection = client("browser", "session-1");
    const browserBConnection = client("browser", "session-1");
    const simulatorConnection = client("simulator", "session-2");
    const ide = registry.add(ideConnection);
    const ideOther = registry.add(otherIdeConnection);
    const browserA = registry.add(browserAConnection);
    const browserB = registry.add(browserBConnection);
    const simulator = registry.add(simulatorConnection);
    const inspectA = { ...inspectMessage, messageId: "inspect-a" };
    const inspectB = { ...inspectMessage, messageId: "inspect-b" };
    const inspectSimulator = {
      ...simulatorInspectMessage,
      sessionId: "session-2",
    };

    routeMessage(registry, routes, browserA, inspectA);
    routeMessage(registry, routes, browserB, inspectB);
    routeMessage(registry, routes, simulator, inspectSimulator);

    const resolution = (
      inspectMessageId: string,
      sessionId = "session-1",
      sourceId = ide.source.id,
    ) => ({
      protocolVersion: PROTOCOL_VERSION,
      type: "resolution" as const,
      messageId: `resolution-${inspectMessageId}`,
      sessionId,
      source: { role: "ide" as const, id: sourceId },
      inspectMessageId,
      resolutionGeneration: 1,
      status: "no-facts" as const,
      selectedMatchCount: 0,
      parentMatchCount: 0,
      inaccessibleStylesheetCount: 0,
      diagnosticCodes: [],
      metadata: {},
    });

    routeMessage(registry, routes, ide, resolution("inspect-b"));
    routeMessage(registry, routes, ide, resolution("inspect-a"));
    routeMessage(
      registry,
      routes,
      ideOther,
      resolution("inspect-simulator-1", "session-2", ideOther.source.id),
    );

    expect(browserAConnection.sent).toEqual([resolution("inspect-a")]);
    expect(browserBConnection.sent).toEqual([resolution("inspect-b")]);
    expect(simulatorConnection.sent).toEqual([
      resolution("inspect-simulator-1", "session-2", ideOther.source.id),
    ]);
    expect(otherIdeConnection.sent).toEqual([inspectSimulator]);
  });

  it("routes source navigation only through the exact inspect reply route", () => {
    const registry = new clientRegistry.ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserAConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-a",
    );
    const browserBConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-b",
    );
    const otherBrowserConnection = client(
      "browser",
      "session-2",
      ["source-navigation"],
      "browser-other",
    );
    const simulatorConnection = client(
      "simulator",
      "session-1",
      ["source-navigation"],
    );
    const ideAConnection = client(
      "ide",
      "session-1",
      ["source-navigation"],
      "ide-a",
    );
    const ideBConnection = client(
      "ide",
      "session-1",
      ["source-navigation"],
      "ide-b",
    );
    const incapableIdeConnection = client(
      "ide",
      "session-1",
      [],
      "ide-incapable",
    );
    const otherIdeConnection = client(
      "ide",
      "session-2",
      ["source-navigation"],
      "ide-other",
    );
    const browserA = registry.add(browserAConnection);
    registry.add(browserBConnection);
    registry.add(otherBrowserConnection);
    registry.add(simulatorConnection);
    const ideA = registry.add(ideAConnection);
    registry.add(ideBConnection);
    registry.add(incapableIdeConnection);
    registry.add(otherIdeConnection);
    routes.register("session-1", "inspect-a", browserA.id).commit();

    const navigate = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate" as const,
      messageId: "navigate-a",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 4,
      direction: "next" as const,
      metadata: {},
    };
    routeMessage(registry, routes, browserA, navigate);

    expect(ideAConnection.sent).toEqual([navigate]);
    expect(ideBConnection.sent).toEqual([navigate]);
    expect(incapableIdeConnection.sent).toEqual([]);
    expect(otherIdeConnection.sent).toEqual([]);
    expect(browserAConnection.sent).toEqual([]);
    expect(browserBConnection.sent).toEqual([]);
    expect(otherBrowserConnection.sent).toEqual([]);
    expect(simulatorConnection.sent).toEqual([]);

    const navigationState = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState" as const,
      messageId: "navigation-state-a",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide" as const, id: ideA.source.id },
      resolutionGeneration: 4,
      selectedMatchCount: 3,
      activeMatchIndex: 2,
      metadata: {},
    };
    routeMessage(registry, routes, ideA, navigationState);

    expect(browserAConnection.sent).toEqual([navigationState]);
    expect(browserAConnection.sent[0]).toMatchObject({ activeMatchIndex: 2 });
    expect(browserBConnection.sent).toEqual([]);
    expect(otherBrowserConnection.sent).toEqual([]);
    expect(simulatorConnection.sent).toEqual([]);
    expect(ideAConnection.sent).toEqual([navigate]);
    expect(ideBConnection.sent).toEqual([navigate]);
    expect(incapableIdeConnection.sent).toEqual([]);
    expect(otherIdeConnection.sent).toEqual([]);
  });

  it("rejects source.navigate from the wrong sender role", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browser = registry.add(
      client("browser", "session-1", ["source-navigation"]),
    );
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-wrong-role",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
  });

  it("rejects source.navigate for a different authenticated session", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const otherIdeConnection = client(
      "ide",
      "session-2",
      ["source-navigation"],
    );
    registry.add(otherIdeConnection);
    routes.register("session-2", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, browser, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-wrong-session",
      sessionId: "session-2",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(otherIdeConnection.sent).toEqual([]);
  });

  it("rejects source.navigate when the sender lacks source-navigation", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, browser, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-no-capability",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(ideConnection.sent).toEqual([]);
  });

  it("reports no IDE when recipients lack source-navigation", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const incapableIdeConnection = client("ide", "session-1");
    registry.add(incapableIdeConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, browser, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-no-capable-ide",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    ]);
    expect(incapableIdeConnection.sent).toEqual([]);
  });

  it("retains the inspect route when every source.navigate IDE send fails", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    ideConnection.connection.send = () => false;
    registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, browser, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-send-failed",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    ]);
    expect(routes.resolve("session-1", "inspect-a")).toBe(browser.id);
  });

  it("rejects source.navigate without a stored inspect route", () => {
    const registry = new ClientRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    registry.add(ideConnection);

    routeMessage(registry, new ReplyRouteRegistry(), browser, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-no-route",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(ideConnection.sent).toEqual([]);
  });

  it("rejects a second browser navigating another browser's inspect route", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserA = registry.add(
      client("browser", "session-1", ["source-navigation"], "browser-a"),
    );
    const browserBConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-b",
    );
    const browserB = registry.add(browserBConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browserA.id).commit();

    routeMessage(registry, routes, browserB, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-from-browser-b",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(browserBConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(ideConnection.sent).toEqual([]);
  });

  it("does not refresh victim routes for rejected cross-browser navigation", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });
    const victim = registry.add(
      client("browser", "session-1", ["source-navigation"], "browser-a"),
    );
    const attackerConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-b",
    );
    const attacker = registry.add(attackerConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    registry.add(ideConnection);
    routes.register("session-1", "inspect-old", victim.id).commit();
    routes.register("session-1", "inspect-new", victim.id).commit();

    routeMessage(registry, routes, attacker, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigate",
      messageId: "navigate-victim-route",
      sessionId: "session-1",
      inspectMessageId: "inspect-old",
      resolutionGeneration: 1,
      direction: "next",
      metadata: {},
    });

    expect(attackerConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(ideConnection.sent).toEqual([]);

    routes.register("session-1", "inspect-next", victim.id).commit();
    expect(routes.resolve("session-1", "inspect-old")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-new")).toBe(victim.id);
    expect(routes.resolve("session-1", "inspect-next")).toBe(victim.id);
  });

  it("rejects source.navigationState from the wrong sender role", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const originConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-a",
    );
    const origin = registry.add(originConnection);
    const senderConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
      "browser-b",
    );
    const sender = registry.add(senderConnection);
    routes.register("session-1", "inspect-a", origin.id).commit();

    routeMessage(registry, routes, sender, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-wrong-role",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: "ide-source" },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(senderConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(originConnection.sent).toEqual([]);
  });

  it("rejects source.navigationState for a different authenticated session", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-2",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-2", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-wrong-session",
      sessionId: "session-2",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    ]);
    expect(browserConnection.sent).toEqual([]);
  });

  it("rejects source.navigationState when the sender lacks source-navigation", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1");
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-no-capability",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(browserConnection.sent).toEqual([]);
  });

  it("reports no browser when the inspect recipient lacks source-navigation", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-incapable-browser",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(browserConnection.sent).toEqual([]);
  });

  it("does not refresh routes when navigation state targets an incapable browser", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-old", browser.id).commit();
    routes.register("session-1", "inspect-new", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-incapable-browser-lru",
      sessionId: "session-1",
      inspectMessageId: "inspect-old",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(browserConnection.sent).toEqual([]);

    routes.register("session-1", "inspect-next", browser.id).commit();
    expect(routes.resolve("session-1", "inspect-old")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-new")).toBe(browser.id);
    expect(routes.resolve("session-1", "inspect-next")).toBe(browser.id);
  });

  it("reports no browser for source.navigationState without an inspect route", () => {
    const registry = new ClientRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    registry.add(browserConnection);
    const ide = registry.add(ideConnection);

    routeMessage(registry, new ReplyRouteRegistry(), ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-no-route",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(browserConnection.sent).toEqual([]);
  });

  it("removes the inspect route when a source.navigationState browser send fails", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    browserConnection.connection.send = () => false;
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-send-failed",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: ide.source.id },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
    expect(routes.resolve("session-1", "inspect-a")).toBeUndefined();
  });

  it("rejects source.navigationState with a spoofed IDE source id", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client(
      "browser",
      "session-1",
      ["source-navigation"],
    );
    const browser = registry.add(browserConnection);
    const ideConnection = client("ide", "session-1", ["source-navigation"]);
    const ide = registry.add(ideConnection);
    routes.register("session-1", "inspect-a", browser.id).commit();

    routeMessage(registry, routes, ide, {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: "navigation-state-spoofed-source",
      sessionId: "session-1",
      inspectMessageId: "inspect-a",
      source: { role: "ide", id: "other-ide" },
      resolutionGeneration: 1,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      metadata: {},
    });

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "protocol.invalidMessage",
      }),
    ]);
    expect(browserConnection.sent).toEqual([]);
  });

  it("fails closed for collisions, stale routes, wrong sessions, and browser resolutions", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ideConnection = client("ide", "session-1");
    const browserConnection = client("browser", "session-1");
    const otherBrowserConnection = client("browser", "session-2");
    const ide = registry.add(ideConnection);
    const browser = registry.add(browserConnection);
    const otherBrowser = registry.add(otherBrowserConnection);

    routeMessage(registry, routes, browser, inspectMessage);
    routeMessage(registry, routes, otherBrowser, { ...inspectMessage });
    expect(otherBrowserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
    expect(ideConnection.sent).toEqual([inspectMessage]);

    const resolution = {
      protocolVersion: PROTOCOL_VERSION,
      type: "resolution" as const,
      messageId: "resolution-1",
      sessionId: "session-1",
      source: { role: "ide" as const, id: ide.source.id },
      inspectMessageId: inspectMessage.messageId,
      resolutionGeneration: 1,
      status: "no-facts" as const,
      selectedMatchCount: 0,
      parentMatchCount: 0,
      inaccessibleStylesheetCount: 0,
      diagnosticCodes: [],
      metadata: {},
    };
    routeMessage(registry, routes, browser, resolution);
    expect(browserConnection.sent).toHaveLength(1);

    routeMessage(registry, routes, ide, {
      ...resolution,
      messageId: "resolution-unknown",
      inspectMessageId: "unknown",
    });
    expect(ideConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );

    routeMessage(registry, routes, ide, {
      ...resolution,
      messageId: "resolution-wrong-session",
      sessionId: "session-2",
    });
    expect(ideConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
    expect(otherBrowserConnection.sent).toHaveLength(1);

    registry.remove(browser.id);
    routeMessage(registry, routes, ide, resolution);
    expect(ideConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
    expect(routes.resolve("session-1", inspectMessage.messageId)).toBeUndefined();

    routeMessage(registry, routes, ide, resolution);
    expect(ideConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
  });

  it("removes a route when its target rejects the resolution send", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ideConnection = client("ide", "session-1");
    const ide = registry.add(ideConnection);
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);

    routeMessage(registry, routes, browser, inspectMessage);
    browserConnection.connection.send = () => false;

    const resolution = {
      protocolVersion: PROTOCOL_VERSION,
      type: "resolution" as const,
      messageId: "resolution-send-failed",
      sessionId: "session-1",
      source: { role: "ide" as const, id: ide.source.id },
      inspectMessageId: inspectMessage.messageId,
      resolutionGeneration: 1,
      status: "no-facts" as const,
      selectedMatchCount: 0,
      parentMatchCount: 0,
      inaccessibleStylesheetCount: 0,
      diagnosticCodes: [],
      metadata: {},
    };

    routeMessage(registry, routes, ide, resolution);

    expect(routes.resolve("session-1", inspectMessage.messageId)).toBeUndefined();
    expect(ideConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
  });

  it("removes a newly registered route when no IDE is available", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);

    routeMessage(registry, routes, browser, inspectMessage);
    expect(routes.resolve("session-1", inspectMessage.messageId)).toBeUndefined();
    expect(browserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    ]);
  });

  it("restores an evicted route when a new route has no IDE recipient", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    const browser = registry.add(client("browser", "session-1"));
    const ide = registry.add(client("ide", "session-1"));

    routeMessage(registry, routes, browser, inspectMessage);
    registry.remove(ide.id);
    routeMessage(registry, routes, browser, {
      ...inspectMessage,
      messageId: "inspect-b",
    });

    expect(routes.resolve("session-1", inspectMessage.messageId)).toBe(browser.id);
    expect(routes.resolve("session-1", "inspect-b")).toBeUndefined();
  });

  it("restores an evicted route when every IDE send fails synchronously", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);
    const workingIde = registry.add(client("ide", "session-1"));

    routeMessage(registry, routes, browser, inspectMessage);
    registry.remove(workingIde.id);

    const failingIde = client("ide", "session-1");
    failingIde.connection.send = () => {
      throw new Error("synchronous send failed");
    };
    registry.add(failingIde);
    routeMessage(registry, routes, browser, {
      ...inspectMessage,
      messageId: "inspect-b",
    });

    expect(routes.resolve("session-1", inspectMessage.messageId)).toBe(browser.id);
    expect(routes.resolve("session-1", "inspect-b")).toBeUndefined();
    expect(browserConnection.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    );
  });

  it("keeps a refreshed route when an idempotent inspect loses its IDE", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);
    const ide = registry.add(client("ide", "session-1"));

    routeMessage(registry, routes, browser, inspectMessage);
    registry.remove(ide.id);
    routeMessage(registry, routes, browser, inspectMessage);

    expect(routes.resolve("session-1", inspectMessage.messageId)).toBe(browser.id);
    expect(browserConnection.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    ]);
  });
});
