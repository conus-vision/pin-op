import { describe, expect, it } from "vitest";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";

function commitRoute(
  routes: ReplyRouteRegistry,
  sessionId: string,
  inspectMessageId: string,
  connectionId: string,
  expectedRuleRefs: Iterable<string> = [],
): void {
  expect(
    routes
      .register(
        sessionId,
        inspectMessageId,
        connectionId,
        expectedRuleRefs,
      )
      .commit(),
  ).toBe(true);
}

describe("reply route registry", () => {
  it("registers, resolves, removes, and clears exact session/message keys", () => {
    const routes = new ReplyRouteRegistry();
    const registration = routes.register(
      "session-1",
      "inspect-1",
      "browser-1",
    );

    expect(registration.status).toBe("created");
    expect(registration.commit()).toBe(true);
    expect(routes.resolve("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.resolve("session-2", "inspect-1")).toBeUndefined();
    expect(routes.remove("session-1", "inspect-1")).toBe(true);
    expect(routes.remove("session-1", "inspect-1")).toBe(false);

    commitRoute(routes, "session-1", "inspect-2", "browser-1");
    commitRoute(routes, "session-2", "inspect-2", "browser-2");
    routes.clear();
    expect(routes.resolve("session-1", "inspect-2")).toBeUndefined();
    expect(routes.resolve("session-2", "inspect-2")).toBeUndefined();
  });

  it("refreshes an idempotent registration's LRU position on commit", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });
    commitRoute(routes, "session-1", "inspect-1", "browser-1");
    commitRoute(routes, "session-1", "inspect-2", "browser-1");

    const refreshed = routes.register(
      "session-1",
      "inspect-1",
      "browser-1",
    );
    expect(refreshed.status).toBe("refreshed");
    expect(refreshed.commit()).toBe(true);
    commitRoute(routes, "session-1", "inspect-3", "browser-1");

    expect(routes.peek("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.peek("session-1", "inspect-2")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-3")).toBe("browser-1");
  });

  it("rejects cross-client collisions without changing the route", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(routes, "session-1", "inspect-1", "browser-1");

    const collision = routes.register(
      "session-1",
      "inspect-1",
      "browser-2",
    );
    expect(collision.status).toBe("collision");
    expect(collision.commit()).toBe(false);
    expect(routes.peek("session-1", "inspect-1")).toBe("browser-1");
  });

  it("evicts the least recently used route per origin client", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });
    commitRoute(routes, "session-1", "inspect-1", "browser-1");
    commitRoute(routes, "session-1", "inspect-2", "browser-1");
    commitRoute(routes, "session-1", "inspect-other", "browser-2");
    routes.resolve("session-1", "inspect-1");
    commitRoute(routes, "session-2", "inspect-3", "browser-1");

    expect(routes.peek("session-1", "inspect-1")).toBe("browser-1");
    expect(routes.peek("session-1", "inspect-2")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-other")).toBe("browser-2");
    expect(routes.peek("session-2", "inspect-3")).toBe("browser-1");
  });

  it("peeks without refreshing the least recently used route", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 2 });
    commitRoute(routes, "session-1", "inspect-old", "browser-1");
    commitRoute(routes, "session-1", "inspect-new", "browser-1");

    expect(routes.peek("session-1", "inspect-old")).toBe("browser-1");
    commitRoute(routes, "session-1", "inspect-next", "browser-1");

    expect(routes.peek("session-1", "inspect-old")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-new")).toBe("browser-1");
  });

  it("keeps reverse indexes bounded across cross-session eviction", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-1", "browser-1");
    commitRoute(routes, "session-2", "inspect-2", "browser-1");

    expect(routes.peek("session-1", "inspect-1")).toBeUndefined();
    expect(routes.peek("session-2", "inspect-2")).toBe("browser-1");
    routes.removeClient("browser-1");
    expect(routes.peek("session-2", "inspect-2")).toBeUndefined();
  });

  it("defers all route and LRU mutation until commit", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    const admission = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );

    expect(routes.peek("session-1", "inspect-a")).toBe("browser-1");
    expect(routes.peek("session-1", "inspect-b")).toBeUndefined();
    admission.rollback();

    expect(routes.peek("session-1", "inspect-a")).toBe("browser-1");
    expect(admission.commit()).toBe(false);
  });

  it("preserves route metadata and both indexes on normal rollback", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    routes.claimResolution("session-1", "inspect-a", "ide-1", 4);
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      4,
      ["match-a"],
    );

    routes.register("session-1", "inspect-b", "browser-1").rollback();

    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      originConnectionId: "browser-1",
      ideConnectionId: "ide-1",
      resolutionGeneration: 4,
      matchIds: new Set(["match-a"]),
    });
    routes.removeClient("ide-1");
    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
  });

  it("makes repeated and post-commit rollback harmless", () => {
    const routes = new ReplyRouteRegistry();
    const canceled = routes.register(
      "session-1",
      "inspect-a",
      "browser-1",
    );
    canceled.rollback();
    canceled.rollback();
    expect(canceled.commit()).toBe(false);

    const committed = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    expect(committed.commit()).toBe(true);
    committed.rollback();
    expect(routes.peek("session-1", "inspect-b")).toBe("browser-1");
  });

  it("fails a commit after any intervening registry mutation", () => {
    const routes = new ReplyRouteRegistry();
    const admission = routes.register(
      "session-1",
      "inspect-a",
      "browser-1",
    );
    routes.removeClient("unrelated-client");

    expect(admission.commit()).toBe(false);
    expect(routes.peek("session-1", "inspect-a")).toBeUndefined();
  });

  it("claims one authoritative IDE and advances only its generation", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(routes, "session-1", "inspect-a", "browser-1");

    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-1", 2),
    ).toMatchObject({
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
    ).toMatchObject({ resolutionGeneration: 3 });
  });

  it("clears match IDs on every resolution and replaces them atomically", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    routes.claimResolution("session-1", "inspect-a", "ide-1", 2);

    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["a", "b"],
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

    routes.claimResolution("session-1", "inspect-a", "ide-1", 2);
    expect(routes.get("session-1", "inspect-a")?.matchIds).toEqual(new Set());
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["d"],
    );

    routes.claimResolution("session-1", "inspect-a", "ide-1", 3);
    expect(routes.get("session-1", "inspect-a")?.matchIds).toEqual(new Set());
  });

  it("keeps pre-resolution invalidations ownerless until a resolution claims", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(routes, "session-1", "inspect-a", "browser-1");

    expect(
      routes.claimSourceInvalidation(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
      ),
    ).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(routes.get("session-1", "inspect-a")?.ideConnectionId).toBeUndefined();
    expect(routes.get("session-1", "inspect-a")?.resolutionGeneration)
      .toBeUndefined();
    expect(routes.claimSourceInvalidation(
      "session-1",
      "inspect-a",
      "ide-2",
      7,
    )).toBeDefined();
    expect(routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["premature-match"],
    )).toBeUndefined();
    expect(
      routes.claimResolution("session-1", "inspect-a", "ide-2", 3),
    ).toMatchObject({
      ideConnectionId: "ide-2",
      resolutionGeneration: 3,
      resolutionClaimed: true,
    });
    expect(routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-2",
      3,
      ["resolved-match"],
    )).toMatchObject({ matchIds: new Set(["resolved-match"]) });
  });

  it("makes repeated same-generation invalidation provisional and clears matches", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    routes.claimResolution("session-1", "inspect-a", "ide-1", 2);
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["match-a"],
    );

    expect(
      routes.claimSourceInvalidation(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
      ),
    ).toMatchObject({
      resolutionClaimed: false,
      matchIds: new Set(),
    });
    expect(routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      ["bypass-match"],
    )).toBeUndefined();
  });

  it("removes routes through both origin and owner reverse indexes", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a"],
    );
    routes.claimResolution("session-1", "inspect-a", "ide-1", 1);
    routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      1,
      [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
      0,
    )?.commit();
    commitRoute(
      routes,
      "session-1",
      "inspect-b",
      "browser-2",
      ["rule-b"],
    );
    routes.claimResolution("session-1", "inspect-b", "ide-2", 1);
    routes.prepareRulesSources(
      "session-1",
      "inspect-b",
      "ide-2",
      1,
      [{ ruleRef: "rule-b", openAuthorityId: "open-b" }],
      0,
    )?.commit();

    routes.removeClient("ide-1");
    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
    expect(routes.get("session-1", "inspect-b")).toBeDefined();
    routes.removeClient("browser-2");
    expect(routes.get("session-1", "inspect-b")).toBeUndefined();
  });

  it.each(["ide", "origin"])(
    "invalidates nested pending admissions after %s removal",
    (removedPeer) => {
      const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
      commitRoute(routes, "session-1", "inspect-a", "browser-1");
      routes.claimResolution("session-1", "inspect-a", "ide-1", 1);
      const admission = routes.register(
        "session-1",
        "inspect-b",
        "browser-1",
      );
      const descendant = routes.register(
        "session-1",
        "inspect-c",
        "browser-1",
      );

      routes.removeClient(removedPeer === "ide" ? "ide-1" : "browser-1");

      expect(descendant.commit()).toBe(false);
      expect(admission.commit()).toBe(false);
      expect(routes.get("session-1", "inspect-a")).toBeUndefined();
      expect(routes.get("session-1", "inspect-b")).toBeUndefined();
      expect(routes.get("session-1", "inspect-c")).toBeUndefined();
    },
  );

  it("never overwrites a newer cross-client recreation on rollback", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    const admission = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );

    routes.remove("session-1", "inspect-a");
    commitRoute(routes, "session-1", "inspect-a", "browser-2");
    admission.rollback();

    expect(routes.peek("session-1", "inspect-a")).toBe("browser-2");
    expect(routes.peek("session-1", "inspect-b")).toBeUndefined();
  });

  it("keeps 10,000 unsettled admissions outside registry state", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    const admissions = Array.from({ length: 10_000 }, (_, index) =>
      routes.register("session-1", `pending-${index}`, "browser-1"),
    );

    expect(routes.peek("session-1", "inspect-a")).toBe("browser-1");
    expect(routes.peek("session-1", "pending-9999")).toBeUndefined();
    for (const admission of admissions) {
      admission.rollback();
    }

    commitRoute(routes, "session-1", "inspect-b", "browser-1");
    expect(routes.peek("session-1", "inspect-a")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-b")).toBe("browser-1");
  });

  it("cannot resurrect routes after A to B to C out-of-order rollback", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    routes.claimResolution("session-1", "inspect-a", "ide-1", 7);
    routes.replaceMatchIds(
      "session-1",
      "inspect-a",
      "ide-1",
      7,
      ["match-a"],
    );
    const admissionB = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    const admissionC = routes.register(
      "session-1",
      "inspect-c",
      "browser-1",
    );

    admissionB.rollback();
    admissionC.rollback();

    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      originConnectionId: "browser-1",
      ideConnectionId: "ide-1",
      resolutionGeneration: 7,
      matchIds: new Set(["match-a"]),
    });
    expect(routes.peek("session-1", "inspect-b")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-c")).toBeUndefined();
    routes.removeClient("ide-1");
    expect(routes.peek("session-1", "inspect-a")).toBeUndefined();
  });

  it("allows only the first concurrent admission to commit", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(routes, "session-1", "inspect-a", "browser-1");
    const admissionB = routes.register(
      "session-1",
      "inspect-b",
      "browser-1",
    );
    const admissionC = routes.register(
      "session-1",
      "inspect-c",
      "browser-1",
    );

    expect(admissionC.commit()).toBe(true);
    expect(admissionB.commit()).toBe(false);
    expect(routes.peek("session-1", "inspect-a")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-b")).toBeUndefined();
    expect(routes.peek("session-1", "inspect-c")).toBe("browser-1");
  });

  it("treats expected rule refs as immutable inspect-route identity", () => {
    const routes = new ReplyRouteRegistry();
    const expectedRuleRefs = new Set(["rule-a", "rule-b"]);
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      expectedRuleRefs,
    );
    expectedRuleRefs.clear();

    expect(routes.get("session-1", "inspect-a")?.expectedRuleRefs).toEqual(
      new Set(["rule-a", "rule-b"]),
    );
    const idempotent = routes.register(
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-b", "rule-a"],
    );
    expect(idempotent.status).toBe("refreshed");
    expect(idempotent.commit()).toBe(true);
    expect(
      routes.register(
        "session-1",
        "inspect-a",
        "browser-1",
        ["rule-a"],
      ).status,
    ).toBe("collision");
    expect(routes.get("session-1", "inspect-a")?.expectedRuleRefs).toEqual(
      new Set(["rule-a", "rule-b"]),
    );
  });

  it("prepares rules authority without mutation and commits it atomically", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a", "rule-b"],
    );

    const prepared = routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      1,
      [
        { ruleRef: "rule-a", openAuthorityId: "open-a" },
        { ruleRef: "rule-b", openAuthorityId: "open-b" },
      ],
      0,
    );
    expect(prepared).toBeDefined();
    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      ideConnectionId: undefined,
      rulesGeneration: undefined,
      ruleOpenAuthorityIds: new Set(),
    });

    expect(prepared?.commit()).toBe(true);
    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      ideConnectionId: "ide-1",
      rulesGeneration: 1,
      ruleOpenAuthorityIds: new Set(["open-a", "open-b"]),
    });
  });

  it("rejects invalid publications without changing current Rules authority", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a", "rule-b"],
    );
    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        1,
        [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
        1,
      )?.commit(),
    ).toBe(true);
    const current = routes.get("session-1", "inspect-a");

    for (const invalid of [
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        1,
        [{ ruleRef: "rule-a", openAuthorityId: "equal" }],
        1,
      ),
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
        [{ ruleRef: "rule-a", openAuthorityId: "incomplete" }],
        0,
      ),
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
        [
          { ruleRef: "rule-a", openAuthorityId: "duplicate-a" },
          { ruleRef: "rule-a", openAuthorityId: "duplicate-b" },
        ],
        0,
      ),
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
        [{ ruleRef: "guessed-rule", openAuthorityId: "guessed" }],
        1,
      ),
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-2",
        2,
        [{ ruleRef: "rule-b", openAuthorityId: "foreign" }],
        1,
      ),
    ]) {
      expect(invalid).toBeUndefined();
    }
    expect(routes.get("session-1", "inspect-a")).toEqual(current);
  });

  it("keeps Rules generation and open authority independent from resolution", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-resolution-first",
      "browser-1",
      ["rule-a"],
    );
    routes.claimResolution(
      "session-1",
      "inspect-resolution-first",
      "ide-1",
      40,
    );
    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-resolution-first",
        "ide-1",
        1,
        [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
        0,
      )?.commit(),
    ).toBe(true);
    routes.claimSourceInvalidation(
      "session-1",
      "inspect-resolution-first",
      "ide-1",
      41,
    );

    expect(
      routes.authorizeRulesOpen(
        "session-1",
        "inspect-resolution-first",
        "browser-1",
        1,
        "open-a",
      ),
    ).toBeDefined();
    for (const authorization of [
      routes.authorizeRulesOpen(
        "other-session",
        "inspect-resolution-first",
        "browser-1",
        1,
        "open-a",
      ),
      routes.authorizeRulesOpen(
        "session-1",
        "inspect-resolution-first",
        "browser-2",
        1,
        "open-a",
      ),
      routes.authorizeRulesOpen(
        "session-1",
        "inspect-resolution-first",
        "browser-1",
        2,
        "open-a",
      ),
      routes.authorizeRulesOpen(
        "session-1",
        "inspect-resolution-first",
        "browser-1",
        1,
        "guessed-open",
      ),
    ]) {
      expect(authorization).toBeUndefined();
    }
    expect(
      routes.authorizeRulesOpen(
        "session-1",
        "inspect-resolution-first",
        "browser-1",
        1,
        "open-a",
      ),
    ).toBeDefined();
    expect(routes.get("session-1", "inspect-resolution-first")).toMatchObject({
      resolutionGeneration: 41,
      rulesGeneration: 1,
      ruleOpenAuthorityIds: new Set(["open-a"]),
    });

    commitRoute(
      routes,
      "session-1",
      "inspect-rules-first",
      "browser-1",
      ["rule-b"],
    );
    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-rules-first",
        "ide-2",
        1,
        [{ ruleRef: "rule-b", openAuthorityId: "open-b" }],
        0,
      )?.commit(),
    ).toBe(true);
    expect(
      routes.claimResolution(
        "session-1",
        "inspect-rules-first",
        "ide-1",
        1,
      ),
    ).toBeUndefined();
    expect(
      routes.claimResolution(
        "session-1",
        "inspect-rules-first",
        "ide-2",
        1,
      ),
    ).toBeDefined();
  });

  it("rolls back prepared replacement and lets an empty next generation clear authority", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a"],
    );
    routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      1,
      [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
      0,
    )?.commit();

    const canceled = routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      2,
      [{ ruleRef: "rule-a", openAuthorityId: "open-b" }],
      0,
    );
    canceled?.rollback();
    expect(canceled?.commit()).toBe(false);
    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      rulesGeneration: 1,
      ruleOpenAuthorityIds: new Set(["open-a"]),
    });

    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        2,
        [],
        1,
      )?.commit(),
    ).toBe(true);
    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      rulesGeneration: 2,
      ruleOpenAuthorityIds: new Set(),
    });
  });

  it("cannot commit a first Rules authority after its IDE is removed", () => {
    const routes = new ReplyRouteRegistry();
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a"],
    );
    const prepared = routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      1,
      [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
      0,
    );

    routes.removeClient("ide-1");

    expect(prepared?.commit()).toBe(false);
    expect(routes.get("session-1", "inspect-a")).toMatchObject({
      ideConnectionId: undefined,
      rulesGeneration: undefined,
      ruleOpenAuthorityIds: new Set(),
    });
  });

  it("starts Rules generation at one for each fresh inspect route", () => {
    const routes = new ReplyRouteRegistry({ maxRoutesPerClient: 1 });
    commitRoute(
      routes,
      "session-1",
      "inspect-a",
      "browser-1",
      ["rule-a"],
    );
    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-a",
        "ide-1",
        0,
        [{ ruleRef: "rule-a", openAuthorityId: "open-zero" }],
        0,
      ),
    ).toBeUndefined();
    routes.prepareRulesSources(
      "session-1",
      "inspect-a",
      "ide-1",
      1,
      [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
      0,
    )?.commit();

    commitRoute(
      routes,
      "session-1",
      "inspect-b",
      "browser-1",
      ["rule-b"],
    );
    expect(routes.get("session-1", "inspect-a")).toBeUndefined();
    expect(
      routes.prepareRulesSources(
        "session-1",
        "inspect-b",
        "ide-1",
        1,
        [{ ruleRef: "rule-b", openAuthorityId: "open-b" }],
        0,
      )?.commit(),
    ).toBe(true);
  });
});
