import { describe, expect, it, vi } from "vitest";
import type { RulesSourcesMessage } from "@pin-op/protocol";
import { RulesSourcesController } from "../src/rulesSourcesController.js";

describe("RulesSourcesController", () => {
  it("publishes one exact origin and dispatches only its opaque open authority", () => {
    const sent = vi.fn();
    const controller = new RulesSourcesController(sent);
    controller.beginInspect("inspect-1", new Set(["rule-1"]));

    expect(controller.accept(rulesSources())).toBe("published");
    expect(controller.originFor("rule-1")).toMatchObject({
      label: "card.scss",
      languageId: "scss",
      startLine: 41,
      startColumn: 3,
      confidence: "sourcemap",
      clickable: true,
    });
    expect(controller.originFor("rule-1")).not.toHaveProperty(
      "openAuthorityId",
    );

    controller.open("rule-1");
    expect(sent).toHaveBeenCalledWith({
      type: "pin-op.rules.open",
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: "authority-1",
    });
  });

  it("defensively copies expected refs and accepts one complete subset publication", () => {
    const expected = new Set(["rule-1", "rule-2"]);
    const controller = new RulesSourcesController(vi.fn());
    controller.beginInspect("inspect-1", expected);
    expected.clear();
    expected.add("foreign-rule");

    expect(controller.accept(rulesSources({ unresolvedRuleCount: 1 })))
      .toBe("published");
    expect(controller.originFor("rule-1")?.label).toBe("card.scss");
    expect(controller.originFor("rule-2")).toBeUndefined();
  });

  it.each([64, 65, 256])(
    "accepts the complete bounded publication of %i rule origins",
    (count) => {
      const refs = Array.from({ length: count }, (_, index) => `rule-${index}`);
      const controller = new RulesSourcesController(vi.fn());
      controller.beginInspect("inspect-1", new Set(refs));

      expect(controller.accept(rulesSources({
        sources: refs.map((ruleRef, index) => source({
          ruleRef,
          openAuthorityId: `authority-${index}`,
          document: { label: `rule-${index}.css`, languageId: "css" },
        })),
      }))).toBe("published");
      expect(controller.originFor(`rule-${count - 1}`)?.label)
        .toBe(`rule-${count - 1}.css`);
    },
  );

  it("rejects a publication above the fixed 256-source bound", () => {
    const refs = Array.from({ length: 256 }, (_, index) => `rule-${index}`);
    const controller = new RulesSourcesController(vi.fn());
    controller.beginInspect("inspect-1", new Set(refs));

    expect(controller.accept(rulesSources({
      sources: Array.from({ length: 257 }, (_, index) => source({
        ruleRef: `rule-${index}`,
        openAuthorityId: `authority-${index}`,
      })),
    }))).toBe("ignored");
    expect(controller.originFor("rule-0")).toBeUndefined();
  });

  it.each([
    ["foreign rule refs", rulesSources({
      sources: [source({ ruleRef: "foreign-rule" })],
    })],
    ["duplicate rule refs", rulesSources({
      sources: [source(), source({ openAuthorityId: "authority-2" })],
      unresolvedRuleCount: 0,
    })],
    ["incomplete totals", rulesSources({ unresolvedRuleCount: 1 })],
    ["a wrong inspect", rulesSources({ inspectMessageId: "inspect-2" })],
    ["a non-first generation", rulesSources({ rulesGeneration: 2 })],
  ])("rejects %s atomically", (_label, message) => {
    const controller = new RulesSourcesController(vi.fn());
    controller.beginInspect("inspect-1", new Set(["rule-1"]));

    expect(controller.accept(message)).toBe("ignored");
    expect(controller.originFor("rule-1")).toBeUndefined();
  });

  it("rejects equal and stale generations while replacing with a newer complete set", () => {
    const controller = new RulesSourcesController(vi.fn());
    controller.beginInspect("inspect-1", new Set(["rule-1"]));
    expect(controller.accept(rulesSources())).toBe("published");

    expect(controller.accept(rulesSources({
      sources: [source({ document: { label: "equal.css", languageId: "css" } })],
    }))).toBe("ignored");
    expect(controller.accept(rulesSources({
      rulesGeneration: 0,
      sources: [source({ document: { label: "stale.css", languageId: "css" } })],
    }))).toBe("ignored");
    expect(controller.accept(rulesSources({
      rulesGeneration: 2,
      sources: [source({
        document: { label: "card.css", languageId: "css" },
        confidence: "exact",
        startLine: 12,
        startColumn: 1,
        openAuthorityId: "authority-2",
      })],
    }))).toBe("published");
    expect(controller.originFor("rule-1")).toMatchObject({
      label: "card.css",
      startLine: 12,
    });
  });

  it("atomically clears a prior origin with a newer complete empty publication", () => {
    const controller = new RulesSourcesController(vi.fn());
    controller.beginInspect("inspect-1", new Set(["rule-1"]));
    expect(controller.accept(rulesSources())).toBe("published");

    expect(controller.accept(rulesSources({
      rulesGeneration: 2,
      sources: [],
      unresolvedRuleCount: 1,
    }))).toBe("published");
    expect(controller.originFor("rule-1")).toBeUndefined();
  });

  it("allows repeated clicks while the same authority remains current", () => {
    const sent = vi.fn();
    const controller = new RulesSourcesController(sent);
    controller.beginInspect("inspect-1", new Set(["rule-1"]));
    controller.accept(rulesSources());

    controller.open("rule-1");
    controller.open("rule-1");
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("invalidates old origins on a new selection", () => {
    const sent = vi.fn();
    const controller = readyController(sent);

    controller.beginInspect("inspect-2", new Set(["rule-2"]));
    controller.open("rule-1");
    expect(controller.originFor("rule-1")).toBeUndefined();
    expect(sent).not.toHaveBeenCalled();
    expect(controller.accept(rulesSources({
      inspectMessageId: "inspect-2",
      sources: [source({ ruleRef: "rule-2" })],
    }))).toBe("published");
  });

  it("invalidates only the exact Rules publication rejected after delivery", () => {
    const sent = vi.fn();
    const controller = readyController(sent);

    controller.invalidatePublication("inspect-1", 1);

    expect(controller.status()).toBe("stale");
    expect(controller.originFor("rule-1")).toBeUndefined();
    controller.open("rule-1");
    expect(sent).not.toHaveBeenCalled();
  });

  it("does not let stale reconciliation clobber a newer generation or inspect", () => {
    const controller = readyController();
    expect(controller.accept(rulesSources({
      rulesGeneration: 2,
      sources: [source({ openAuthorityId: "authority-2" })],
    }))).toBe("published");

    controller.invalidatePublication("inspect-1", 1);
    expect(controller.status()).toBe("ready");
    expect(controller.originFor("rule-1")).toBeDefined();

    controller.beginInspect("inspect-2", new Set(["rule-2"]));
    expect(controller.accept(rulesSources({
      inspectMessageId: "inspect-2",
      sources: [source({
        ruleRef: "rule-2",
        openAuthorityId: "authority-new-inspect",
      })],
    }))).toBe("published");
    controller.invalidatePublication("inspect-1", 2);

    expect(controller.status()).toBe("ready");
    expect(controller.originFor("rule-2")).toBeDefined();
  });

  it.each([
    "disconnect",
    "stylesheet-refresh",
    "page-refresh",
    "document-navigation",
    "frame-navigation",
    "transport-invalidation",
  ] as const)("clears Rules authority on %s", (reason) => {
    const sent = vi.fn();
    const controller = readyController(sent);

    controller.invalidate(reason);
    expect(controller.originFor("rule-1")).toBeUndefined();
    controller.open("rule-1");
    expect(sent).not.toHaveBeenCalled();
  });

  it("clears on incompatibility and requires a fresh inspect after recovery", () => {
    const controller = readyController();
    controller.setCompatible(false);
    expect(controller.originFor("rule-1")).toBeUndefined();

    controller.setCompatible(true);
    expect(controller.accept(rulesSources({ rulesGeneration: 2 })))
      .toBe("ignored");
    controller.beginInspect("inspect-2", new Set(["rule-2"]));
    expect(controller.accept(rulesSources({
      inspectMessageId: "inspect-2",
      sources: [source({ ruleRef: "rule-2" })],
    }))).toBe("published");
  });

  it("keeps the incompatible status across later transport invalidation", () => {
    const controller = readyController();
    controller.setCompatible(false);

    controller.invalidate("transport-invalidation");

    expect(controller.status()).toBe("incompatible");
  });

  it("does not let Source navigation or active-editor updates revoke Rules", () => {
    const controller = readyController();
    const before = controller.originFor("rule-1");

    // These public Source messages intentionally never enter the Rules API.
    expect(controller.accept({
      type: "source.navigationState",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 99,
    })).toBe("ignored");
    expect(controller.accept({
      type: "source.matches",
      inspectMessageId: "inspect-1",
      resolutionGeneration: 99,
    })).toBe("ignored");
    expect(controller.originFor("rule-1")).toEqual(before);
  });

  it("notifies subscribers only for visible authority changes", () => {
    const controller = new RulesSourcesController(vi.fn());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.beginInspect("inspect-1", new Set(["rule-1"]));
    controller.accept(rulesSources());
    controller.accept(rulesSources());
    unsubscribe();
    controller.invalidate("page-refresh");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not republish an already stale visible state", () => {
    const controller = new RulesSourcesController(vi.fn());
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.invalidate("page-refresh");
    controller.invalidate("stylesheet-refresh");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("disposes idempotently and rejects later publications and opens", () => {
    const sent = vi.fn();
    const controller = readyController(sent);
    controller.dispose();
    controller.dispose();

    expect(controller.accept(rulesSources({ rulesGeneration: 2 })))
      .toBe("ignored");
    expect(controller.originFor("rule-1")).toBeUndefined();
    controller.open("rule-1");
    expect(sent).not.toHaveBeenCalled();
    expect(() => controller.subscribe(vi.fn())).toThrow(/disposed/i);
  });
});

function readyController(dispatch = vi.fn()): RulesSourcesController {
  const controller = new RulesSourcesController(dispatch);
  controller.beginInspect("inspect-1", new Set(["rule-1"]));
  expect(controller.accept(rulesSources())).toBe("published");
  return controller;
}

function rulesSources(
  overrides: Partial<RulesSourcesMessage> = {},
): RulesSourcesMessage {
  return {
    protocolVersion: 7,
    type: "rules.sources",
    messageId: "message-1",
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    sources: [source()],
    unresolvedRuleCount: 0,
    metadata: {},
    ...overrides,
  };
}

function source(
  overrides: Partial<RulesSourcesMessage["sources"][number]> = {},
): RulesSourcesMessage["sources"][number] {
  return {
    ruleRef: "rule-1",
    openAuthorityId: "authority-1",
    document: { label: "card.scss", languageId: "scss" },
    startLine: 41,
    startColumn: 3,
    confidence: "sourcemap",
    ...overrides,
  };
}
