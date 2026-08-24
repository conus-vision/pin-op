import { describe, expect, it } from "vitest";
import { createInspectByteBudget } from "../src/inspectBounds.js";
import { projectMatchedStylesToCssFacts } from "../src/matchedStylesProjection.js";
import type { MatchedStyles } from "../src/matchedStylesTypes.js";

describe("projectMatchedStylesToCssFacts", () => {
  it("projects the exact matched records with shared refs and bounded v6 metadata", () => {
    const matched = fixture();
    const result = projectMatchedStylesToCssFacts(matched, createInspectByteBudget());

    expect(result).toEqual({
      facts: [
        {
          type: "css-rule",
          selector: ".card",
          property: "color",
          value: "red",
          metadata: {
            ruleRef: "rule-external",
            sourceUrl: "https://example.test/app.css",
            media: ["screen"],
            mediaTruncated: false,
            rulePath: "0.3",
            valueTruncated: false,
            important: true,
          },
        },
      ],
      inaccessibleStylesheets: [],
    });
    expect(result.facts[0]!.metadata.ruleRef).toBe(matched.rules[0]!.ruleRef);
  });

  it("can project an inherited group without recollecting or walking CSSOM", () => {
    const matched = fixture();
    const inherited = projectMatchedStylesToCssFacts(
      matched,
      createInspectByteBudget(),
      { inheritedAncestorIndex: 1 },
    );
    expect(inherited.facts.map((fact) => [fact.selector, fact.property])).toEqual([
      ["body", "font-size"],
    ]);
  });

  it("honors the shared byte budget atomically", () => {
    const budget = createInspectByteBudget();
    budget.remainingBytes = 0;
    expect(projectMatchedStylesToCssFacts(fixture(), budget).facts).toEqual([]);
  });
});

function fixture(): MatchedStyles {
  return Object.freeze({
    documentEpoch: 7,
    selectionRevision: 11,
    stylesRevision: 13,
    stylesheetRevision: 5,
    nodeRef: "node-selected",
    rules: Object.freeze([rule(
      "rule-external",
      ".card",
      "color",
      "red",
      true,
      { sourceUrl: "https://example.test/app.css", rulePath: "0.3" },
      [{ kind: "media", text: "screen" }],
    )]),
    inherited: Object.freeze([Object.freeze({
      ancestorIndex: 1,
      elementName: "body",
      rules: Object.freeze([rule(
        "rule-body",
        "body",
        "font-size",
        "16px",
        false,
        { rulePath: "0.1" },
      )]),
    })]),
    inaccessibleStylesheetCount: 0,
    partial: false,
    diagnostics: Object.freeze([]),
  });
}

function rule(
  ruleRef: string,
  selectorText: string,
  property: string,
  value: string,
  important: boolean,
  source: { sourceUrl?: string; rulePath: string },
  contexts: readonly { kind: "media"; text: string }[] = [],
) {
  return Object.freeze({
    ruleRef,
    selectorText,
    matchingSelectorIndices: Object.freeze([0]),
    declarations: Object.freeze([Object.freeze({
      ruleRef,
      property,
      value,
      important,
      valueTruncated: false,
      state: "winning-known-author" as const,
      reason: "highest-precedence-known-author-declaration" as const,
    })]),
    contexts: Object.freeze(contexts.map((context) => Object.freeze(context))),
    source: Object.freeze(source),
  });
}
