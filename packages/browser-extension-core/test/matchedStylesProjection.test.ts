import { describe, expect, it } from "vitest";
import { createInspectByteBudget } from "../src/inspectBounds.js";
import { projectMatchedStylesToCssFacts } from "../src/matchedStylesProjection.js";
import type { MatchedStyles } from "../src/matchedStylesTypes.js";

describe("projectMatchedStylesToCssFacts", () => {
  it("projects one correlated evidence unit per displayed rule", () => {
    const matched = fixture();
    const result = projectMatchedStylesToCssFacts(matched, createInspectByteBudget());

    expect(result).toEqual({
      facts: [
        {
          type: "css-rule",
          ruleRef: "rule-external",
          property: "color",
          value: "red",
          important: true,
          valueTruncated: false,
          metadata: {},
        },
      ],
      ruleEvidence: {
        rules: [
          {
            ruleRef: "rule-external",
            selector: ".card",
            declarations: [
              {
                property: "color",
                value: "red",
                important: true,
                valueTruncated: false,
              },
            ],
            declarationsTruncated: false,
            generatedSource: {
            sourceUrl: "https://example.test/app.css",
              rulePath: "0.3",
              contexts: [{ kind: "media", conditionText: "screen" }],
              contextsTruncated: false,
              unsupportedGroupContext: false,
            },
          },
        ],
        omittedRuleCount: 0,
      },
      inaccessibleStylesheets: [],
    });
    expect(result.facts[0]!.ruleRef).toBe(matched.rules[0]!.ruleRef);
  });

  it("can project an inherited group without recollecting or walking CSSOM", () => {
    const matched = fixture();
    const inherited = projectMatchedStylesToCssFacts(
      matched,
      createInspectByteBudget(),
      { inheritedAncestorIndex: 1 },
    );
    expect(inherited.facts.map((fact) => [fact.ruleRef, fact.property])).toEqual([
      ["rule-body", "font-size"],
    ]);
    expect(inherited.ruleEvidence.rules.map((rule) => rule.ruleRef)).toEqual([
      "rule-body",
    ]);
  });

  it("honors the shared byte budget atomically", () => {
    const budget = createInspectByteBudget();
    budget.remainingBytes = 0;
    expect(projectMatchedStylesToCssFacts(fixture(), budget)).toMatchObject({
      facts: [],
      ruleEvidence: { rules: [], omittedRuleCount: 1 },
    });
  });

  it("keeps inline evidence but omits generated source authority", () => {
    const matched = fixture();
    const inline = rule(
      "rule-inline",
      "element.style",
      "color",
      "blue",
      false,
      { rulePath: "0" },
    );
    const result = projectMatchedStylesToCssFacts({ ...matched, inline });

    expect(result.ruleEvidence.rules[0]).toMatchObject({
      ruleRef: "rule-inline",
      selector: "element.style",
    });
    expect(result.ruleEvidence.rules[0]).not.toHaveProperty("generatedSource");
  });

  it("fails closed on hostile and unresolved generated source URLs", () => {
    for (const sourceUrl of [
      "file:///private/app.css",
      "blob:https://example.test/id",
      "data:text/css,body{}",
      "chrome-extension://abc/app.css",
      "moz-extension://abc/app.css",
      "resource://gre/app.css",
      "about:blank",
      "javascript:alert(1)",
      "/var/private/app.css",
      "/Users/alice/app.css",
      "/workspace/project/app.css",
      "/mnt/c/app.css",
      "C:\\private\\app.css",
      "\\\\server\\share\\app.css",
      "//server/share/app.css",
      "https://user@example.test/app.css",
      "https://EXAMPLE.test/app.css",
      "https://example.test/app.css#",
      "https://example.test/app.css#fragment",
      "https://example.test/app.css\u0085hidden",
      "https://example.test/app.css\u2066hidden",
      "https://example.test/app%00.css",
      "https://example.test/app%C2%85.css",
      "https://example.test/app%E2%81%A6.css",
      "https://example.test/app%5Csecret.css",
    ]) {
      const matched = fixtureWithSourceUrl(sourceUrl);
      const result = projectMatchedStylesToCssFacts(matched);

      expect(result.ruleEvidence.rules).toHaveLength(1);
      expect(result.ruleEvidence.rules[0]).not.toHaveProperty("generatedSource");
    }
  });

  it.each([
    ["../assets/app.css", "https://example.test/routes/assets/app.css"],
    ["/assets/app.css", "https://example.test/assets/app.css"],
  ])("canonicalizes relative stylesheet href %s", (sourceUrl, expected) => {
    const result = projectMatchedStylesToCssFacts(
      fixtureWithSourceUrl(sourceUrl),
      createInspectByteBudget(),
      { pageUrl: "https://example.test/routes/card/" },
    );

    expect(result.ruleEvidence.rules[0]?.generatedSource).toMatchObject({
      sourceUrl: expected,
    });
  });

  it("marks truncated and unsupported contexts for fail-closed resolution", () => {
    const matched = fixture();
    const truncated = projectMatchedStylesToCssFacts({
      ...matched,
      rules: [{ ...matched.rules[0]!, contextsTruncated: true }],
    });
    expect(truncated.ruleEvidence.rules[0]?.generatedSource).toMatchObject({
      contextsTruncated: true,
      unsupportedGroupContext: false,
    });

    const unsupported = projectMatchedStylesToCssFacts({
      ...matched,
      rules: [{
        ...matched.rules[0]!,
        contexts: [{ kind: "container" as const, text: "width > 10rem" }],
      }],
    });
    expect(unsupported.ruleEvidence.rules[0]?.generatedSource).toMatchObject({
      contexts: [],
      contextsTruncated: false,
      unsupportedGroupContext: true,
    });
  });
});

function fixtureWithSourceUrl(sourceUrl: string): MatchedStyles {
  const matched = fixture();
  return {
    ...matched,
    rules: [{
      ...matched.rules[0]!,
      source: { ...matched.rules[0]!.source!, sourceUrl },
    }],
  };
}

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
