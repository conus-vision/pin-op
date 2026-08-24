import { describe, expect, it } from "vitest";
import { INSPECT_LIMITS } from "@pin-op/protocol";
import {
  walkCssRules,
  type CssDocumentSource,
  type CssRuleWalkRecord,
} from "../src/cssRuleWalker.js";

describe("walkCssRules", () => {
  it("walks external, inline, and exposed adopted sheets in stylesheet order", () => {
    const result = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [
        sheet("https://example.test/app.css?v=100%#coverage%", [
          styleRule(".external", { color: "red" }),
        ]),
        sheet(null, [styleRule(".inline", { display: "block" })]),
      ],
      adoptedStyleSheets: [
        sheet(null, [styleRule(".adopted", { margin: "0" })]),
      ],
    });

    expect(result.records.map(recordIdentity)).toEqual([
      [".external", "https://example.test/app.css?v=100%#coverage%", "0.0"],
      [".inline", "inline-style://document/1", "1.0"],
      [".adopted", "inline-style://document/2", "2.0"],
    ]);
  });

  it("walks imports with deterministic numeric paths and stops active cycles", () => {
    const root = sheet("https://example.test/root.css", []);
    const imported = sheet("https://example.test/imported.css?theme=dark", []);
    root.cssRules = [
      importRule(imported.href!, imported, "print"),
      styleRule(".root", { display: "grid" }),
    ];
    imported.cssRules = [
      importRule(root.href!, root),
      styleRule(".imported", { color: "purple" }),
    ];

    const result = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [root],
    });

    expect(result.records.map((record) => ({
      selector: record.selector,
      rulePath: record.rulePath,
      media: record.media,
    }))).toEqual([
      { selector: ".imported", rulePath: "1.1", media: ["print"] },
      { selector: ".root", rulePath: "0.1", media: [] },
    ]);
  });

  it("records ordered typed ancestry for every supported and unknown group", () => {
    const leaf = styleRule(".target", { color: "green" });
    const nested = group("CSSMediaRule", "(width >= 40rem)",
      group("CSSSupportsRule", "(display: grid)",
        group("CSSLayerBlockRule", "theme",
          group("CSSScopeRule", "(.card) to (.title)",
            group("CSSContainerRule", "sidebar (width > 20rem)",
              group("CSSStartingStyleRule", "",
                group("CSSFutureRule", "@future experimental", leaf),
              ),
            ),
          ),
        ),
      ),
    );

    const { records } = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [sheet("/contexts.css", [nested])],
    });

    expect(records[0]?.contexts).toEqual([
      { kind: "media", text: "(width >= 40rem)" },
      { kind: "supports", text: "(display: grid)" },
      { kind: "layer", text: "theme" },
      { kind: "scope", text: "(.card) to (.title)" },
      { kind: "container", text: "sidebar (width > 20rem)" },
      { kind: "starting-style", text: "" },
      { kind: "unknown", text: "@future experimental" },
    ]);
    expect(records[0]?.media).toEqual(["(width >= 40rem)"]);
    expect(records[0]?.contextsTruncated).toBe(false);
  });

  it("keeps an unknown conditional group unknown despite conditionText", () => {
    const conditionalUnknown = group(
      "CSSFutureConditionRule",
      "(future-feature: enabled)",
      styleRule(".target", { color: "green" }),
    );

    const { records } = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [sheet("/future.css", [conditionalUnknown])],
    });

    expect(records[0]?.contexts).toEqual([{
      kind: "unknown",
      text: "(future-feature: enabled)",
    }]);
  });

  it("keeps nested selector ancestry while traversing grouping rules", () => {
    const selectors: string[] = [];
    const walk = walkCssRules(
      {
        matches(selector) {
          selectors.push(selector);
          return selector === ":is(.card) > .title";
        },
      },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [sheet("/nested.css", [{
          ...styleRule(".card", {}),
          cssRules: [group(
            "CSSSupportsRule",
            "(display: grid)",
            styleRule("& > .title", { color: "red" }),
          )],
        }])],
      },
    );
    const records = [...walk.records];

    expect(selectors).toEqual([".card", ":is(.card) > .title"]);
    expect(records[0]).toMatchObject({
      selector: "& > .title",
      resolvedSelector: ":is(.card) > .title",
      rulePath: "0.0.0.0",
      contexts: [{ kind: "supports", text: "(display: grid)" }],
    });
  });

  it("reports inaccessible cssRules and skips invalid rules without leaking them", () => {
    const inaccessible = {
      href: "https://cdn.example.test/denied.css",
      get cssRules(): never {
        throw new Error("Permission denied");
      },
    };
    const invalidRule = new Proxy({}, {
      has() {
        throw new Error("invalid rule");
      },
      get() {
        throw new Error("invalid rule");
      },
    });
    const result = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [
        inaccessible,
        sheet("/valid.css", [invalidRule, null, styleRule(".valid", {
          color: "blue",
        })]),
      ],
    });

    expect(result.inaccessibleStylesheets).toEqual([{
      code: "browser.stylesheetInaccessible",
      sourceUrl: "https://cdn.example.test/denied.css",
      reason: "Permission denied",
    }]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.selector).toBe(".valid");
    expect(JSON.stringify(result.records)).not.toContain("cssRules");
    expect(JSON.stringify(result.records)).not.toContain("selectorText");
  });

  it("bounds rule, declaration, and context traversal", () => {
    let matchCalls = 0;
    const ruleWalk = walkCssRules(
      {
        matches() {
          matchCalls += 1;
          return false;
        },
      },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [sheet("/many.css", Array.from(
          { length: INSPECT_LIMITS.cssRules + 1 },
          (_, index) => styleRule(`.rule-${index}`, { color: "red" }),
        ))],
      },
    );
    expect([...ruleWalk.records]).toEqual([]);
    expect(matchCalls).toBe(INSPECT_LIMITS.cssRules);

    const declarations = Object.fromEntries(Array.from(
      { length: INSPECT_LIMITS.declarationsPerRule + 1 },
      (_, index) => [`--property-${index}`, `${index}`],
    ));
    let nested: unknown = styleRule(".bounded", declarations);
    for (let index = 0; index <= INSPECT_LIMITS.mediaConditions; index += 1) {
      nested = group("CSSMediaRule", `screen-${index}`, nested);
    }
    const bounded = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets: [sheet("/bounded.css", [nested])],
    });

    expect(bounded.records).toHaveLength(INSPECT_LIMITS.declarationsPerRule);
    expect(bounded.records[0]?.contexts).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(bounded.records[0]?.media).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(bounded.records[0]?.contextsTruncated).toBe(true);
    expect(bounded.records[0]?.mediaTruncated).toBe(true);
  });

  it("does not pull a stylesheet beyond the global stylesheet limit", () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const styleSheets = {
      [Symbol.iterator]() {
        return {
          next() {
            nextCalls += 1;
            return {
              done: false as const,
              value: sheet(`/sheet-${nextCalls}.css`, []),
            };
          },
          return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const result = collectRecords({
      pageUrl: "https://example.test/page",
      styleSheets,
    });

    expect(result.records).toEqual([]);
    expect(nextCalls).toBe(INSPECT_LIMITS.stylesheets);
    expect(returnCalls).toBe(1);
  });
});

function collectRecords(document: CssDocumentSource): {
  records: CssRuleWalkRecord[];
  inaccessibleStylesheets: readonly unknown[];
} {
  const walk = walkCssRules({ matches: () => true }, document);
  return {
    records: [...walk.records],
    inaccessibleStylesheets: walk.inaccessibleStylesheets,
  };
}

function recordIdentity(record: CssRuleWalkRecord): readonly string[] {
  return [record.selector, record.sourceUrl, record.rulePath];
}

function sheet(
  href: string | null,
  cssRules: unknown[],
): { href: string | null; cssRules: unknown[] } {
  return { href, cssRules };
}

function importRule(href: string, styleSheet: object, mediaText = "") {
  return {
    href,
    styleSheet,
    ...(mediaText ? { media: { mediaText } } : {}),
  };
}

function group(constructorName: string, text: string, child: unknown) {
  const rule: Record<string, unknown> = {
    constructor: { name: constructorName },
    cssRules: [child],
  };
  if (constructorName === "CSSMediaRule") {
    rule.conditionText = text;
    rule.media = { mediaText: text };
  } else if (constructorName === "CSSLayerBlockRule") {
    rule.name = text;
  } else if (constructorName === "CSSFutureRule") {
    rule.cssText = `${text} {}`;
  } else {
    rule.conditionText = text;
  }
  return rule;
}

function styleRule(selectorText: string, declarations: Record<string, string>) {
  const names = Object.keys(declarations);
  return {
    selectorText,
    style: {
      length: names.length,
      item: (index: number) => names[index] ?? "",
      getPropertyValue: (name: string) =>
        declarations[name]?.replace(/\s*!important\s*$/, "") ?? "",
      getPropertyPriority: (name: string) =>
        declarations[name]?.endsWith("!important") ? "important" : "",
    },
  };
}
