import { describe, expect, it } from "vitest";
import { walkCssRules } from "../src/cssRuleWalker.js";
import {
  RULE_REFERENCE_MAX_ENTRIES,
  RULE_REFERENCE_MAX_LENGTH,
  RuleReferenceRegistry,
  type RuleReferenceScope,
} from "../src/ruleReferenceRegistry.js";

const scope: RuleReferenceScope = {
  contentSessionId: "content-session-a",
  documentEpoch: 1,
  stylesheetRevision: 0,
};

describe("RuleReferenceRegistry", () => {
  it("returns the same reference for the same sheet, path, and native rule", () => {
    const registry = new RuleReferenceRegistry(scope);
    const nativeRule = { selectorText: ".card" };

    const first = registry.reference("sheet-0", "0.2.1", nativeRule);
    const second = registry.reference("sheet-0", "0.2.1", nativeRule);

    expect(second).toBe(first);
    expect(registry.resolve(first, scope)).toBe(nativeRule);
  });

  it("drops old references when the document or stylesheet generation resets", () => {
    const registry = new RuleReferenceRegistry(scope);
    const nativeRule = { selectorText: ".card" };
    const oldRef = registry.reference("sheet-0", "0.0", nativeRule);

    registry.reset({ documentEpoch: 2, stylesheetRevision: 0 });

    expect(registry.resolve(oldRef, scope)).toBeUndefined();
    const nextScope = { ...scope, documentEpoch: 2 };
    const nextRef = registry.reference("sheet-0", "0.0", nativeRule);
    expect(nextRef).not.toBe(oldRef);
    expect(registry.resolve(nextRef, nextScope)).toBe(nativeRule);

    registry.reset({ documentEpoch: 2, stylesheetRevision: 1 });
    expect(registry.resolve(nextRef, nextScope)).toBeUndefined();
  });

  it("does not collide for identical selectors in different sheets", () => {
    const registry = new RuleReferenceRegistry(scope);
    const firstRule = { selectorText: ".same" };
    const secondRule = { selectorText: ".same" };

    const first = registry.reference("sheet-0", "0.0", firstRule);
    const second = registry.reference("sheet-1", "0.0", secondRule);

    expect(first).not.toBe(second);
    expect(registry.resolve(first, scope)).toBe(firstRule);
    expect(registry.resolve(second, scope)).toBe(secondRule);
  });

  it("gives every declaration from one native rule the same opaque ruleRef", () => {
    const registry = new RuleReferenceRegistry(scope);
    const nativeRule = styleRule(".card", { color: "red", display: "grid" });
    const walk = walkCssRules(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [{ href: "/app.css", cssRules: [nativeRule] }],
      },
      { ruleReferences: registry },
    );
    const records = [...walk.records];

    expect(records).toHaveLength(2);
    expect(records[0]?.ruleRef).toBe(records[1]?.ruleRef);
    expect(registry.resolve(records[0]!.ruleRef!, scope)).toBe(nativeRule);
  });

  it("uses bounded random opaque tokens without source-derived identity", () => {
    const registry = new RuleReferenceRegistry(scope);
    const first = registry.reference(
      "https://secret.example/app.css",
      "0.2.1",
      { selectorText: ".private-selector" },
    );
    const second = registry.reference("sheet-1", "0.0", {});

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(RULE_REFERENCE_MAX_LENGTH);
    expect(first).toMatch(/^rule-[A-Za-z0-9_-]+$/);
    expect(first).not.toContain("secret");
    expect(first).not.toContain("0.2.1");
    expect(first).not.toContain("private-selector");
    expect(RULE_REFERENCE_MAX_ENTRIES).toBeGreaterThan(0);
  });

  it("guards resolution with the complete bound generation", () => {
    const registry = new RuleReferenceRegistry(scope);
    const nativeRule = { selectorText: ".card" };
    const ref = registry.reference("sheet-0", "0.0", nativeRule);

    expect(registry.resolve(ref, { ...scope, contentSessionId: "other" }))
      .toBeUndefined();
    expect(registry.resolve(ref, { ...scope, documentEpoch: 2 }))
      .toBeUndefined();
    expect(registry.resolve(ref, { ...scope, stylesheetRevision: 1 }))
      .toBeUndefined();
    expect(registry.resolve(ref, scope)).toBe(nativeRule);
  });

  it("revokes native lookup on content lease loss and disposal", () => {
    const registry = new RuleReferenceRegistry(scope);
    const nativeRule = { selectorText: ".card" };
    const leaseRef = registry.reference("sheet-0", "0.0", nativeRule);

    registry.reset({
      contentSessionId: "content-session-b",
      documentEpoch: 1,
      stylesheetRevision: 0,
    });
    expect(registry.resolve(leaseRef, scope)).toBeUndefined();

    const nextScope = { ...scope, contentSessionId: "content-session-b" };
    const liveRef = registry.reference("sheet-0", "0.0", nativeRule);
    registry.dispose();

    expect(registry.resolve(liveRef, nextScope)).toBeUndefined();
    expect(() => registry.reference("sheet-0", "0.0", nativeRule)).toThrow(
      "disposed",
    );
  });

  it("rejects scopes outside the canonical content-session authority", () => {
    expect(() => new RuleReferenceRegistry({
      ...scope,
      contentSessionId: "content session with spaces",
    })).toThrow("scope is invalid");
    expect(() => new RuleReferenceRegistry({
      ...scope,
      contentSessionId: "s".repeat(129),
    })).toThrow("scope is invalid");
  });
});

function styleRule(selectorText: string, declarations: Record<string, string>) {
  const names = Object.keys(declarations);
  return {
    selectorText,
    style: {
      length: names.length,
      item: (index: number) => names[index] ?? "",
      getPropertyValue: (name: string) => declarations[name] ?? "",
      getPropertyPriority: () => "",
    },
  };
}
