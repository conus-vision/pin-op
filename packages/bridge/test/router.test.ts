import { PROTOCOL_VERSION } from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import { ClientRegistry } from "../src/clientRegistry.js";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";
import { routeMessage } from "../src/router.js";

function client(role: "browser" | "ide" | "simulator", sessionId: string) {
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
    source: { role, id: `${role}-source`, metadata: {} },
    sessionId,
    authToken: `${role}-${sessionId}-token`,
  };
}

const inspectMessage = {
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
} as const;

const simulatorInspectMessage = {
  ...inspectMessage,
  messageId: "inspect-simulator-1",
  source: { role: "simulator", id: "simulator-source", metadata: {} },
} as const;

describe("bridge router and registry", () => {
  it("stores clients by protocol sessionId and role", () => {
    const registry = new ClientRegistry();
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
    const ide = registry.add(client("ide", "session-1"));
    const ideOther = registry.add(client("ide", "session-2"));
    const browserA = registry.add(client("browser", "session-1"));
    const browserB = registry.add(client("browser", "session-1"));
    const simulator = registry.add(client("simulator", "session-2"));
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

    expect(browserA.sent).toEqual([resolution("inspect-a")]);
    expect(browserB.sent).toEqual([resolution("inspect-b")]);
    expect(simulator.sent).toEqual([
      resolution("inspect-simulator-1", "session-2", ideOther.source.id),
    ]);
    expect(ideOther.sent).toEqual([inspectSimulator]);
  });

  it("fails closed for collisions, stale routes, wrong sessions, and browser resolutions", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ide = registry.add(client("ide", "session-1"));
    const browser = registry.add(client("browser", "session-1"));
    const otherBrowser = registry.add(client("browser", "session-2"));

    routeMessage(registry, routes, browser, inspectMessage);
    routeMessage(registry, routes, otherBrowser, { ...inspectMessage });
    expect(otherBrowser.sent).toEqual([
      expect.objectContaining({ type: "error", code: "protocol.invalidMessage" }),
    ]);
    expect(ide.sent).toEqual([inspectMessage]);

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
    expect(browser.sent).toHaveLength(1);

    routeMessage(registry, routes, ide, {
      ...resolution,
      messageId: "resolution-unknown",
      inspectMessageId: "unknown",
    });
    expect(ide.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );

    routeMessage(registry, routes, ide, {
      ...resolution,
      messageId: "resolution-wrong-session",
      sessionId: "session-2",
    });
    expect(ide.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
    expect(otherBrowser.sent).toHaveLength(1);

    registry.remove(browser.id);
    routeMessage(registry, routes, ide, resolution);
    expect(ide.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
    expect(routes.resolve("session-1", inspectMessage.messageId)).toBeUndefined();

    routeMessage(registry, routes, ide, resolution);
    expect(ide.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
  });

  it("removes a route when its target rejects the resolution send", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const ide = registry.add(client("ide", "session-1"));
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
    expect(ide.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noBrowserClient" }),
    );
  });

  it("removes a newly registered route when no IDE is available", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browser = registry.add(client("browser", "session-1"));

    routeMessage(registry, routes, browser, inspectMessage);
    expect(routes.resolve("session-1", inspectMessage.messageId)).toBeUndefined();
    expect(browser.sent).toEqual([
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
    const browser = registry.add(client("browser", "session-1"));
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
    expect(browser.sent.at(-1)).toEqual(
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    );
  });

  it("keeps a refreshed route when an idempotent inspect loses its IDE", () => {
    const registry = new ClientRegistry();
    const routes = new ReplyRouteRegistry();
    const browser = registry.add(client("browser", "session-1"));
    const ide = registry.add(client("ide", "session-1"));

    routeMessage(registry, routes, browser, inspectMessage);
    registry.remove(ide.id);
    routeMessage(registry, routes, browser, inspectMessage);

    expect(routes.resolve("session-1", inspectMessage.messageId)).toBe(browser.id);
    expect(browser.sent).toEqual([
      expect.objectContaining({ type: "error", code: "bridge.noIdeClient" }),
    ]);
  });
});
