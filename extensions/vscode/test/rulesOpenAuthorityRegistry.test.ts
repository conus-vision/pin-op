import { describe, expect, it } from "vitest";
import {
  RESOLUTION_LIMITS,
  RULES_SOURCES_LIMITS,
} from "@pin-op/protocol";
import {
  RulesOpenAuthorityRegistry,
  type StoredRuleOpenAuthority,
} from "../src/rules/rulesOpenAuthorityRegistry.js";

describe("RulesOpenAuthorityRegistry", () => {
  it("activates one immutable generation atomically and authorizes reusable clicks", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const input = authority();
    const prepared = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [input],
    });

    expect(registry.authorize(openTuple())).toBeUndefined();
    registry.activate(prepared);
    const first = registry.authorize(openTuple());
    const second = registry.authorize(openTuple());

    expect(first).toEqual(input);
    expect(second).toEqual(input);
    expect(first).not.toBe(input);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.range)).toBe(true);
    expect(Object.isFrozen(first?.dependencies)).toBe(true);
    registry.commit(prepared);
    expect(registry.authorize(openTuple())).toEqual(input);
  });

  it("rolls an activated same-inspect replacement back to the prior snapshot", () => {
    const registry = activeRegistry();
    const replacement = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorities: [authority({
        openAuthorityId: "00000000-0000-4000-8000-000000000002",
        rulesGeneration: 2,
      })],
    });

    registry.activate(replacement);
    expect(registry.authorize(openTuple())).toBeUndefined();
    registry.rollback(replacement);

    expect(registry.authorize(openTuple())).toMatchObject({
      openAuthorityId: "00000000-0000-4000-8000-000000000001",
      rulesGeneration: 1,
    });
  });

  it("rolls a new-inspect activation back to empty instead of reviving a foreign route", () => {
    const registry = activeRegistry();
    const next = registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorities: [authority({
        inspectMessageId: "inspect-2",
        rulesGeneration: 1,
        openAuthorityId: "00000000-0000-4000-8000-000000000002",
      })],
    });

    registry.activate(next);
    registry.rollback(next);

    expect(registry.current()).toBeUndefined();
    expect(registry.authorize(openTuple())).toBeUndefined();
  });

  it("commits an empty generation as a complete authority clear", () => {
    const registry = activeRegistry();
    const empty = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorities: [],
    });
    registry.activate(empty);
    registry.commit(empty);

    expect(registry.current()).toEqual({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorityCount: 0,
    });
    expect(registry.authorize(openTuple({ rulesGeneration: 2 })))
      .toBeUndefined();
    expect(registry.dependencyUris()).toEqual([]);
  });

  it("accepts exactly 256 entries without evicting any published authority", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const authorities = Array.from(
      { length: RULES_SOURCES_LIMITS.sources },
      (_, index) => authority({
        ruleRef: `rule-${index}`,
        openAuthorityId: uuid(index),
        documentUri: `file:///workspace/rule-${index}.css`,
        dependencies: [{
          kind: "generated-css",
          uri: `file:///workspace/rule-${index}.css`,
          documentVersion: 1,
          contentHash: hash(index),
        }],
      }),
    );
    const prepared = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities,
    });
    registry.activate(prepared);
    registry.commit(prepared);

    for (const entry of authorities) {
      expect(registry.authorize({
        inspectMessageId: "inspect-1",
        rulesGeneration: 1,
        openAuthorityId: entry.openAuthorityId,
      })?.ruleRef).toBe(entry.ruleRef);
    }
  });

  it("rejects an oversized or duplicate candidate before mutating current state", () => {
    const registry = activeRegistry();
    const tooMany = Array.from(
      { length: RULES_SOURCES_LIMITS.sources + 1 },
      (_, index) => authority({
        ruleRef: `rule-${index}`,
        openAuthorityId: uuid(index),
      }),
    );

    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorities: tooMany,
    })).toThrow(/capacity/i);
    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorities: [
        authority({ rulesGeneration: 2 }),
        authority({ rulesGeneration: 2, ruleRef: "rule-2" }),
      ],
    })).toThrow(/duplicate/i);

    expect(registry.authorize(openTuple())).toMatchObject({
      rulesGeneration: 1,
    });
  });

  it("scopes monotonic generations to one inspect and never reuses a rollback", () => {
    const registry = activeRegistry();
    const first = registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorities: [],
    });
    registry.activate(first);
    registry.rollback(first);

    expect(() => registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorities: [],
    })).toThrow(/newer/i);

    const second = registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 2,
      authorities: [],
    });
    registry.activate(second);
    registry.rollback(second);
    expect(() => registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 2,
      authorities: [],
    })).toThrow(/newer/i);
  });

  it("does not forget a route high watermark after another inspect becomes current", () => {
    const registry = activeRegistry();
    const next = registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorities: [],
    });
    registry.activate(next);
    registry.commit(next);

    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [],
    })).toThrow(/newer/i);
  });

  it("bounds route history while retaining active and recently used watermarks", () => {
    const registry = activeRegistry();
    const historyLimit = RULES_SOURCES_LIMITS.sources;
    const prepareRoute = (index: number) => registry.prepare({
      inspectMessageId: `inspect-bulk-${index}`,
      rulesGeneration: 1,
      authorities: [],
    });

    for (let index = 0; index < historyLimit - 1; index += 1) {
      registry.rollback(prepareRoute(index));
    }
    expect(() => prepareRoute(0)).toThrow(/newer/i);

    registry.rollback(prepareRoute(historyLimit - 1));
    registry.rollback(prepareRoute(0));

    const uniqueRouteCount = historyLimit * 16;
    for (let index = historyLimit; index < uniqueRouteCount; index += 1) {
      registry.rollback(prepareRoute(index));
    }
    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [],
    })).toThrow(/newer/i);
    expect(() => prepareRoute(uniqueRouteCount - 1)).toThrow(/newer/i);
  });

  it("fences an old-route preparation before activating a new inspect", () => {
    const registry = activeRegistry();
    const stale = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      authorities: [authority({
        rulesGeneration: 2,
        openAuthorityId: uuid(2),
      })],
    });
    const current = registry.prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorities: [authority({
        inspectMessageId: "inspect-2",
        rulesGeneration: 1,
        openAuthorityId: uuid(3),
      })],
    });

    expect(() => registry.activate(stale)).toThrow(/stale/i);
    registry.activate(current);
    registry.commit(current);
    expect(registry.current()).toEqual({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      authorityCount: 1,
    });
  });

  it("rejects a generation above the shared protocol ceiling", () => {
    const registry = new RulesOpenAuthorityRegistry();

    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: RESOLUTION_LIMITS.generation + 1,
      authorities: [],
    })).toThrow(/generation/i);
  });

  it("invalidates an unactivated preparation when clear observes empty state", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const prepared = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [authority()],
    });

    registry.clear();

    expect(() => registry.activate(prepared)).toThrow(/stale/i);
    expect(registry.current()).toBeUndefined();
  });

  it("fails closed for every wrong tuple component and after lifecycle clear", () => {
    const registry = activeRegistry();

    expect(registry.authorize(openTuple({ inspectMessageId: "inspect-2" })))
      .toBeUndefined();
    expect(registry.authorize(openTuple({ rulesGeneration: 2 })))
      .toBeUndefined();
    expect(registry.authorize(openTuple({
      openAuthorityId: "00000000-0000-4000-8000-000000000099",
    }))).toBeUndefined();

    registry.clear();
    expect(registry.authorize(openTuple())).toBeUndefined();
    expect(registry.current()).toBeUndefined();
  });

  it("publishes the exact immutable dependency URI set", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const mapped = authority({
      documentUri: "file:///workspace/src/card.scss",
      documentVersion: 4,
      dependencies: [
        dependency("generated-css", "file:///workspace/dist/app.css", 2, 1),
        dependency(
          "external-source-map",
          "file:///workspace/dist/app.css.map",
          3,
          2,
        ),
        dependency(
          "original-source",
          "file:///workspace/src/card.scss",
          4,
          3,
        ),
      ],
    });
    const prepared = registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [mapped],
    });
    registry.activate(prepared);
    registry.commit(prepared);

    expect(registry.dependencyUris()).toEqual([
      "file:///workspace/dist/app.css",
      "file:///workspace/dist/app.css.map",
      "file:///workspace/src/card.scss",
    ]);
    expect(Object.isFrozen(registry.dependencyUris())).toBe(true);
  });

  it.each([
    [
      "mapped target without generated CSS",
      authority({
        documentUri: "file:///workspace/src/card.scss",
        documentVersion: 4,
        dependencies: [dependency(
          "original-source",
          "file:///workspace/src/card.scss",
          4,
          1,
        )],
      }),
    ],
    [
      "external map without an original source",
      authority({
        dependencies: [
          dependency("generated-css", "file:///workspace/dist/app.css", 1, 1),
          dependency(
            "external-source-map",
            "file:///workspace/dist/app.css.map",
            1,
            2,
          ),
        ],
      }),
    ],
    [
      "multiple generated stylesheets",
      authority({
        dependencies: [
          dependency("generated-css", "file:///workspace/dist/app.css", 1, 1),
          dependency("generated-css", "file:///workspace/dist/other.css", 1, 2),
        ],
      }),
    ],
  ])("rejects invalid dependency shape: %s", (_name, candidate) => {
    const registry = new RulesOpenAuthorityRegistry();

    expect(() => registry.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      authorities: [candidate],
    })).toThrow(/dependency/i);
    expect(registry.current()).toBeUndefined();
  });
});

function activeRegistry(): RulesOpenAuthorityRegistry {
  const registry = new RulesOpenAuthorityRegistry();
  const prepared = registry.prepare({
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    authorities: [authority()],
  });
  registry.activate(prepared);
  registry.commit(prepared);
  return registry;
}

function authority(
  overrides: Partial<StoredRuleOpenAuthority> = {},
): StoredRuleOpenAuthority {
  return {
    openAuthorityId: "00000000-0000-4000-8000-000000000001",
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    ruleRef: "rule-1",
    documentUri: "file:///workspace/dist/app.css",
    documentVersion: 1,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 20 },
    },
    workspaceGeneration: 3,
    dependencies: [dependency(
      "generated-css",
      "file:///workspace/dist/app.css",
      1,
      0,
    )],
    ...overrides,
  };
}

function dependency(
  kind: StoredRuleOpenAuthority["dependencies"][number]["kind"],
  uri: string,
  documentVersion: number,
  seed: number,
): StoredRuleOpenAuthority["dependencies"][number] {
  return { kind, uri, documentVersion, contentHash: hash(seed) };
}

function openTuple(
  overrides: Partial<{
    readonly inspectMessageId: string;
    readonly rulesGeneration: number;
    readonly openAuthorityId: string;
  }> = {},
) {
  return {
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    openAuthorityId: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function hash(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}
