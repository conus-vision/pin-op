import { describe, expect, it } from "vitest";
import type { SourceDocument } from "@browser2ide/plugin-api";
import { INSPECT_LIMITS, type CssRuleFact } from "@browser2ide/protocol";
import {
  findRulesByFingerprint,
  normalizeSelector,
  StylesheetAstCache,
} from "../src/sourcePlugins/stylesheetAst.js";
import type { CssDeclarationEvidence } from "../src/sourcePlugins/types.js";

describe("stylesheet fingerprint lookup", () => {
  it("returns one strong candidate with its complete CSS block range", () => {
    const text = [
      ".card {",
      "  color: red;",
      "  display: grid;",
      "}",
      ".card { color: blue; display: block; }",
    ].join("\n");
    const parsed = stylesheet(text);
    const rules = findRulesByFingerprint(
      parsed,
      fact(".card", "color", "red"),
      declarations(["color", "red"], ["display", "grid"]),
    );

    expect(rules).toHaveLength(1);
    expect(snippet(parsed, rules[0]!)).toBe([
      ".card {",
      "  color: red;",
      "  display: grid;",
      "}",
    ].join("\n"));
  });

  it("returns every indistinguishable strong candidate for stable ambiguity", () => {
    const parsed = stylesheet([
      ".card { color: red; }",
      ".card { color: red; }",
    ].join("\n"));

    expect(findRulesByFingerprint(
      parsed,
      fact(".card", "color", "red"),
    )).toHaveLength(2);
  });

  it("uses declaration evidence to distinguish duplicate selectors", () => {
    const parsed = stylesheet([
      ".card { color: red; display: grid; }",
      ".card { color: blue; display: flex; }",
    ].join("\n"));
    const rules = findRulesByFingerprint(
      parsed,
      fact(".card", "display", "flex"),
    );

    expect(rules).toHaveLength(1);
    expect(snippet(parsed, rules[0]!)).toBe(
      ".card { color: blue; display: flex; }",
    );
  });

  it("uses normalized priority as declaration evidence", () => {
    const parsed = stylesheet([
      ".card { color: red; }",
      ".card { color: red !important; }",
    ].join("\n"));

    const runtimeFact = fact(".card", "color", "red");
    runtimeFact.metadata.important = true;
    const rules = findRulesByFingerprint(parsed, runtimeFact);

    expect(rules).toHaveLength(1);
    expect(snippet(parsed, rules[0]!)).toBe(
      ".card { color: red !important; }",
    );
  });

  it("fails closed for important and non-important duplicate properties", () => {
    const parsed = stylesheet(
      ".card { color: red; color: blue !important; }",
    );
    const normal = fact(".card", "color", "red");
    const important = fact(".card", "color", "blue");
    important.metadata.important = true;

    expect(findRulesByFingerprint(parsed, normal)).toEqual([]);
    expect(findRulesByFingerprint(parsed, important)).toEqual([]);
  });

  it("does not use selector-only evidence", () => {
    const parsed = stylesheet([
      ".card { color: red; }",
      ".card { color: blue; }",
    ].join("\n"));

    expect(findRulesByFingerprint(
      parsed,
      fact(".card", "color", "red"),
      [],
    )).toEqual([]);
  });

  it("normalizes available media evidence and rejects a condition mismatch", () => {
    const parsed = stylesheet([
      "@media (min-width:40rem) {",
      "  .card { color: red; }",
      "}",
      "@media (min-width: 60rem) {",
      "  .card { color: red; }",
      "}",
    ].join("\n"));
    const matching = fact(".card", "color", "red");
    matching.metadata.media = [" (min-width: 40rem) "];
    const mismatched = fact(".card", "color", "red");
    mismatched.metadata.media = ["(orientation: landscape)"];

    const rules = findRulesByFingerprint(parsed, matching);
    expect(rules).toHaveLength(1);
    expect(snippet(parsed, rules[0]!)).toBe(".card { color: red; }");
    expect(findRulesByFingerprint(parsed, mismatched)).toEqual([]);
  });

  it("preserves case-sensitive custom identifiers in condition evidence", () => {
    const parsed = stylesheet(
      "@media (--Theme) { .card { color: red; } }",
    );
    const runtime = fact(".card", "color", "red");
    runtime.metadata.media = ["(--theme)"];

    expect(findRulesByFingerprint(parsed, runtime)).toEqual([]);
  });

  it("does not guess from a runtime value that may be truncated", () => {
    const prefix = "x".repeat(INSPECT_LIMITS.valueLength);
    const unique = stylesheet(`.card { --payload: ${prefix}one; }`);
    const runtime = fact(".card", "--payload", prefix);

    expect(findRulesByFingerprint(unique, runtime)).toEqual([]);
  });

  it("rejects declaration evidence at the truncation boundary", () => {
    const boundary = "x".repeat(INSPECT_LIMITS.valueLength);
    const belowBoundary = boundary.slice(1);
    const exactBoundary = stylesheet(
      `.card { --payload: ${boundary}; }`,
    );
    const complete = stylesheet(
      `.card { --payload: ${belowBoundary}; }`,
    );
    const truncated = fact(".card", "--payload", boundary);
    truncated.metadata.valueTruncated = true;

    expect(findRulesByFingerprint(
      exactBoundary,
      truncated,
    )).toEqual([]);
    expect(findRulesByFingerprint(
      complete,
      fact(".card", "--payload", belowBoundary),
    )).toHaveLength(1);
  });

  it("rejects media evidence at the truncation boundary", () => {
    const prefix = "screen-";
    const boundary = prefix + "x".repeat(
      INSPECT_LIMITS.valueLength - prefix.length,
    );
    const belowBoundary = boundary.slice(1);
    const parsed = stylesheet([
      `@media ${boundary} { .card { color: red; } }`,
      `@media ${belowBoundary} { .card { color: blue; } }`,
    ].join("\n"));
    const ambiguous = fact(".card", "color", "red");
    ambiguous.metadata.media = [boundary];
    ambiguous.metadata.mediaTruncated = true;
    const complete = fact(".card", "color", "blue");
    complete.metadata.media = [belowBoundary];

    expect(findRulesByFingerprint(parsed, ambiguous)).toEqual([]);
    expect(findRulesByFingerprint(parsed, complete)).toHaveLength(1);
  });

  it("uses an available declaration subset without requiring the full rule", () => {
    const unique = stylesheet([
      ".card { color: red; display: grid; padding: 1rem; }",
      ".card { color: blue; display: flex; padding: 2rem; }",
    ].join("\n"));
    const ambiguous = stylesheet([
      ".card { color: red; display: grid; }",
      ".card { color: blue; display: grid; }",
    ].join("\n"));
    const runtime = fact(".card", "display", "grid");

    expect(findRulesByFingerprint(unique, runtime)).toHaveLength(1);
    expect(findRulesByFingerprint(ambiguous, runtime)).toHaveLength(2);
  });

  it("normalizes selector serialization without changing attribute content", () => {
    expect(normalizeSelector('.a, [data-label="x,  y"]')).toBe(
      '.a,[data-label="x,  y"]',
    );
    expect(normalizeSelector("[data-label=")).toBeUndefined();
  });

  it("invalidates a reopened document with the same URI and version", () => {
    const cache = new StylesheetAstCache();
    const firstDocument = sourceDocument(".first { color: red; }");
    const reopenedDocument = sourceDocument(".second { color: blue; }");

    const first = cache.parseDocument(firstDocument, "css");
    const reopened = cache.parseDocument(reopenedDocument, "css");

    expect(reopened).not.toBe(first);
    expect(reopened.rules.map((rule) => rule.selector)).toEqual([".second"]);
    expect(cache.parseDocument(reopenedDocument, "css")).toBe(reopened);
  });
});

function stylesheet(text: string) {
  return new StylesheetAstCache().parseText(
    "file:///workspace/dist/app.css",
    "css",
    text,
  );
}

function fact(
  selector: string,
  property: string,
  value: string,
): CssRuleFact {
  return {
    type: "css-rule",
    selector,
    property,
    value,
    metadata: {
      sourceUrl: "/dist/app.css",
      rulePath: "0.99",
      media: [],
      mediaTruncated: false,
      valueTruncated: false,
      important: false,
    },
  };
}

function declarations(
  ...entries: readonly (readonly [string, string])[]
): CssDeclarationEvidence[] {
  return entries.map(([property, value]) => ({
    property,
    value,
    important: false,
  }));
}

function snippet(
  parsed: ReturnType<typeof stylesheet>,
  rule: { readonly startOffset: number; readonly endOffset: number },
): string {
  return parsed.document.getText().slice(rule.startOffset, rule.endOffset);
}

function sourceDocument(text: string): SourceDocument {
  return {
    uri: "file:///workspace/dist/app.css",
    languageId: "css",
    version: 1,
    getText: () => text,
    positionAt: (offset) => ({ line: 0, character: offset }),
    offsetAt: (position) => position.character,
  };
}
