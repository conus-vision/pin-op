import { describe, expect, it } from "vitest";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";

describe("reply route registry", () => {
  it("registers, resolves, removes, and clears exact session/message keys", () => {
    const routes = new ReplyRouteRegistry();

    expect(routes.register("session-1", "inspect-1", "browser-1").status).toBe(
      "created",
    );
    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.resolve("session-2", "inspect-1")).toBeUndefined();
    expect(routes.remove("session-1", "inspect-1")).toBe(true);
    expect(routes.resolve("session-1", "inspect-1")).toBeUndefined();
    expect(routes.remove("session-1", "inspect-1")).toBe(false);

    routes.register("session-1", "inspect-2", "browser-1");
    routes.register("session-2", "inspect-2", "browser-2");
    routes.clear();
    expect(routes.resolve("session-1", "inspect-2")).toBeUndefined();
    expect(routes.resolve("session-2", "inspect-2")).toBeUndefined();
  });

  it("makes same-client registration idempotent and refreshes its LRU position", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });

    routes.register("session-1", "inspect-1", "browser-1");
    routes.register("session-1", "inspect-2", "browser-1");
    expect(routes.register("session-1", "inspect-1", "browser-1").status).toBe(
      "refreshed",
    );
    routes.register("session-1", "inspect-3", "browser-1");

    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-2")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-3")).toBe("browser-1");
  });

  it("rejects cross-client collisions without changing the original route", () => {
    const routes = new ReplyRouteRegistry();

    expect(routes.register("session-1", "inspect-1", "browser-1").status).toBe(
      "created",
    );
    expect(routes.register("session-1", "inspect-1", "browser-2").status).toBe(
      "collision",
    );
    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
  });

  it("evicts the least recently used route per client and preserves other clients", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });

    routes.register("session-1", "inspect-1", "browser-1");
    routes.register("session-1", "inspect-2", "browser-1");
    routes.register("session-1", "inspect-other", "browser-2");
    routes.resolve("session-1", "inspect-1");
    routes.register("session-2", "inspect-3", "browser-1");

    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-2")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-other")).toBe("browser-2");
  });

  it("peeks without refreshing the least recently used route", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });

    routes.register("session-1", "inspect-old", "browser-1").commit();
    routes.register("session-1", "inspect-new", "browser-1").commit();

    expect(routes.peek("session-1", "inspect-old")).toBe("browser-1");
    routes.register("session-1", "inspect-next", "browser-1").commit();

    expect(routes.resolve("session-1", "inspect-old")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-new")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-next")).toBe("browser-1");
  });

  it("keeps the reverse index bound after limit-one cross-session eviction", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });

    expect(routes.register("session-1", "inspect-1", "browser-1").status).toBe(
      "created",
    );
    expect(routes.register("session-2", "inspect-4", "browser-1").status).toBe(
      "created",
    );
    expect(routes.resolve("session-1", "inspect-1")).toBeUndefined();
    expect(routes.resolve("session-2", "inspect-4")).toBe("browser-1");

    expect(routes.register("session-1", "inspect-3", "browser-1").status).toBe(
      "created",
    );
    expect(routes.resolve("session-2", "inspect-4")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-3")).toBe("browser-1");

    routes.removeClient("browser-1");
    expect(routes.resolve("session-2", "inspect-4")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-3")).toBeUndefined();
  });

  it("refreshes on resolve and removes one client without affecting another session or client", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });

    routes.register("session-1", "inspect-1", "browser-1");
    routes.register("session-2", "inspect-1", "browser-1");
    routes.register("session-1", "inspect-2", "browser-2");
    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.remove("session-1", "inspect-1")).toBe(true);
    expect(routes.resolve("session-2", "inspect-1")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-2")).toBe("browser-2");

    routes.register("session-1", "inspect-3", "browser-1");
    routes.register("session-2", "inspect-4", "browser-1");
    routes.removeClient("browser-1");
    expect(routes.resolve("session-2", "inspect-1")).toBeUndefined();
    expect(routes.resolve("session-2", "inspect-4")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-3")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-2")).toBe("browser-2");
  });

  it("restores the exact LRU order after rolling back an eviction", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });

    routes.register("session-1", "inspect-a", "browser-1");
    routes.register("session-1", "inspect-b", "browser-1");
    const registration = routes.register("session-1", "inspect-c", "browser-1");

    registration.rollback();
    routes.register("session-1", "inspect-d", "browser-1");

    expect(routes.resolve("session-1", "inspect-a")).toBeUndefined();
    expect(routes.resolve("session-1", "inspect-b")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-d")).toBe("browser-1");
  });

  it("makes repeated rollback harmless", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    routes.register("session-1", "inspect-a", "browser-1");
    const registration = routes.register("session-1", "inspect-b", "browser-1");

    expect(() => {
      registration.rollback();
      registration.rollback();
    }).not.toThrow();
    expect(routes.resolve("session-1", "inspect-a")).toBe("browser-1");
    expect(routes.resolve("session-1", "inspect-b")).toBeUndefined();
  });

  it("does nothing when a committed registration is rolled back", () => {
    const routes = new ReplyRouteRegistry();
    const registration = routes.register("session-1", "inspect-a", "browser-1");

    registration.commit();
    registration.rollback();

    expect(routes.resolve("session-1", "inspect-a")).toBe("browser-1");
  });

  it("ignores rollback after remove or clear", () => {
    const routes = new ReplyRouteRegistry();
    const removed = routes.register("session-1", "inspect-a", "browser-1");
    routes.remove("session-1", "inspect-a");
    expect(() => removed.rollback()).not.toThrow();
    expect(routes.resolve("session-1", "inspect-a")).toBeUndefined();

    const cleared = routes.register("session-1", "inspect-b", "browser-1");
    routes.clear();
    expect(() => cleared.rollback()).not.toThrow();
    expect(routes.resolve("session-1", "inspect-b")).toBeUndefined();
  });

  it("cannot roll back over a same-key recreation", () => {
    const routes = new ReplyRouteRegistry();
    const oldRegistration = routes.register(
      "session-1",
      "inspect-a",
      "browser-1",
    );
    routes.remove("session-1", "inspect-a");
    routes.register("session-1", "inspect-a", "browser-1");

    oldRegistration.rollback();

    expect(routes.resolve("session-1", "inspect-a")).toBe("browser-1");
  });

  it("claims one authoritative IDE and advances only its generation", () => {
    const routes = new ReplyRouteRegistry();
    routes.register("session-1", "inspect-a", "browser-1").commit();

    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-1", 2),
    ).toMatchObject({
      originConnectionId: "browser-1",
      ideConnectionId: "ide-1",
      resolutionGeneration: 2,
    });
    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-2", 2),
    ).toBeUndefined();
    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-1", 1),
    ).toBeUndefined();
    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-1", 3),
    ).toMatchObject({
      ideConnectionId: "ide-1",
      resolutionGeneration: 3,
    });
  });

  it("clears match IDs on generation advance and replaces them atomically", () => {
    const routes = new ReplyRouteRegistry();
    routes.register("session-1", "inspect-a", "browser-1").commit();
    routes.claimResolution("session-1", "inspect-a", "ide-1", 2);

    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["a", "b"],
    );
    expect(routes.get("session-1", "inspect-a")?.matchIds).toEqual(
      new Set(["a", "b"]),
    );
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["c"],
    );
    expect(routes.get("session-1", "inspect-a")?.matchIds).toEqual(
      new Set(["c"]),
    );

    routes.claimResolution("session-1", "inspect-a", "ide-1", 3);
    expect(routes.get("session-1", "inspect-a")?.matchIds).toEqual(new Set());
  });

  it("removes routes through both origin and owner reverse indexes", () => {
    const routes = new ReplyRouteRegistry();
    routes.register("session-1", "inspect-a", "browser-1").commit();
    routes.claimResolution("session-1", "inspect-a", "ide-1", 1);
    routes.register("session-1", "inspect-b", "browser-2").commit();
    routes.claimResolution("session-1", "inspect-b", "ide-2", 1);

    routes.removeClient("ide-1");
    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
    expect(routes.get("session-1", "inspect-b")).toBeDefined();

    routes.removeClient("browser-2");
    expect(routes.get("session-1", "inspect-b")).toBeUndefined();
  });

  it("restores authority metadata and both indexes after LRU rollback", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    routes.register("session-1", "inspect-a", "browser-1").commit();
    routes.claimResolution("session-1", "inspect-a", "ide-1", 4);
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      4,
      ["match-a"],
    );

    const registration = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    registration.rollback();

    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      originConnectionId: "browser-1",
      ideConnectionId: "ide-1",
      resolutionGeneration: 4,
      matchIds: new Set(["match-a"]),
    });
    routes.removeClient("ide-1");
    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
  });

  it("does not restore an evicted route after its IDE owner is removed", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    routes.register("session-1", "inspect-a", "browser-1").commit();
    routes.claimResolution("session-1", "inspect-a", "ide-1", 4);
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      4,
      ["match-a"],
    );

    const registration = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    routes.removeClient("ide-1");
    registration.rollback();

    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
    expect(routes.get("session-1", "inspect-b")).toBeUndefined();
  });

  it("does not restore an evicted route after its browser origin is removed", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    routes.register("session-1", "inspect-a", "browser-1").commit();
    routes.claimResolution("session-1", "inspect-a", "ide-1", 4);

    const registration = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    routes.removeClient("browser-1");
    registration.rollback();

    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
    expect(routes.get("session-1", "inspect-b")).toBeUndefined();
  });
});
