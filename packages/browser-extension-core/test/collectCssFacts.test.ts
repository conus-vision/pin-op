import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  RuntimeFactSchema,
  type CssRuleFact,
} from "@pinop/protocol";
import { collectCssFacts } from "../src/collectCssFacts.js";

describe("collectCssFacts", () => {
  it("emits complete fingerprint metadata for every declaration", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{
          href: "/complete.css",
          cssRules: [styleRule(".card", {
            color: "red",
            display: "grid !important",
          })],
        }],
      },
    );

    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: ".card",
        property: "color",
        value: "red",
        metadata: {
          sourceUrl: "/complete.css",
          media: [],
          mediaTruncated: false,
          rulePath: "0.0",
          valueTruncated: false,
          important: false,
        },
      },
      {
        type: "css-rule",
        selector: ".card",
        property: "display",
        value: "grid",
        metadata: {
          sourceUrl: "/complete.css",
          media: [],
          mediaTruncated: false,
          rulePath: "0.0",
          valueTruncated: false,
          important: true,
        },
      },
    ]);
    result.facts.forEach((fact) => {
      expect(RuntimeFactSchema.parse(fact)).toEqual(fact);
    });
  });

  it("collects matched declarations through nested media rules", () => {
    const result = collectCssFacts(
      {
        matches(selector) {
          if (selector === ":invalid(") {
            throw new Error("invalid selector");
          }
          return selector === ".card";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "http://localhost:3000/dist/app.css",
            cssRules: [
              mediaRule("(min-width: 40rem)", [
                styleRule(".card", {
                  display: "flex",
                  padding: "1rem !important",
                }),
                styleRule(":invalid(", { color: "red" }),
              ]),
            ],
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets).toEqual([]);
    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: ".card",
        property: "display",
        value: "flex",
        metadata: completeFactMetadata(
          "http://localhost:3000/dist/app.css",
          "0.0.0",
          ["(min-width: 40rem)"],
        ),
      },
      {
        type: "css-rule",
        selector: ".card",
        property: "padding",
        value: "1rem",
        metadata: completeFactMetadata(
          "http://localhost:3000/dist/app.css",
          "0.0.0",
          ["(min-width: 40rem)"],
          { important: true },
        ),
      },
    ]);
    for (const fact of result.facts) {
      expect(RuntimeFactSchema.parse(fact)).toEqual(fact);
    }
  });

  it("marks value and media truncation before trimming transmitted text", () => {
    const valuePrefix = "v".repeat(INSPECT_LIMITS.valueLength - 1);
    const mediaPrefix = "screen-" + "m".repeat(
      INSPECT_LIMITS.valueLength - "screen-".length - 1,
    );
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{
          href: "/truncated.css",
          cssRules: [mediaRule(`${mediaPrefix} tail`, [
            styleRule(".card", { payload: `${valuePrefix} tail` }),
          ])],
        }],
      },
    );

    expect(result.facts).toEqual([{
      type: "css-rule",
      selector: ".card",
      property: "payload",
      value: valuePrefix,
      metadata: completeFactMetadata(
        "/truncated.css",
        "0.0.0",
        [mediaPrefix],
        { mediaTruncated: true, valueTruncated: true },
      ),
    }]);
    expect(RuntimeFactSchema.parse(result.facts[0])).toEqual(result.facts[0]);
  });

  it("marks nested media condition count overflow as truncated", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{
          href: "/nested-overflow.css",
          cssRules: [nestedMediaRules(
            INSPECT_LIMITS.mediaConditions + 1,
            styleRule(".card", { color: "red" }),
          )],
        }],
      },
    );

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.metadata.media).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(result.facts[0]?.metadata.mediaTruncated).toBe(true);
    expect(RuntimeFactSchema.parse(result.facts[0])).toEqual(result.facts[0]);
  });

  it("marks imported media condition count overflow as truncated", () => {
    const importedUrl = "http://localhost:3000/imported.css";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{
          href: "/root.css",
          cssRules: [nestedMediaRules(
            INSPECT_LIMITS.mediaConditions,
            importRule(
              importedUrl,
              {
                href: importedUrl,
                cssRules: [styleRule(".card", { color: "red" })],
              },
              "print",
            ),
          )],
        }],
      },
    );

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.metadata.media).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(result.facts[0]?.metadata.mediaTruncated).toBe(true);
    expect(RuntimeFactSchema.parse(result.facts[0])).toEqual(result.facts[0]);
  });

  it("traverses native nested style rules when the outer rule does not match", () => {
    const matchedSelectors: string[] = [];
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return selector === ":is(.card) > .title";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/nested.css",
            cssRules: [
              {
                ...styleRule(".card", { display: "grid" }),
                cssRules: [
                  styleRule("& > .title", { color: "red" }),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([
      ".card",
      ":is(.card) > .title",
    ]);
    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: "& > .title",
        property: "color",
        value: "red",
        metadata: completeFactMetadata("/nested.css", "0.0.0"),
      },
    ]);
  });

  it("threads the nearest style selector through nested group rules", () => {
    const matchedSelectors: string[] = [];
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return selector === ":is(.card) .icon";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/nested-media.css",
            cssRules: [
              {
                ...styleRule(".card", {}),
                cssRules: [
                  mediaRule("(width >= 40rem)", [
                    styleRule("& .icon", { display: "block" }),
                  ]),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([
      ".card",
      ":is(.card) .icon",
    ]);
    expect(result.facts[0]).toEqual({
      type: "css-rule",
      selector: "& .icon",
      property: "display",
      value: "block",
      metadata: completeFactMetadata(
        "/nested-media.css",
        "0.0.0.0",
        ["(width >= 40rem)"],
      ),
    });
  });

  it("resolves multi-level selector lists without replacing quoted or escaped ampersands", () => {
    const matchedSelectors: string[] = [];
    const resolvedGrandchild =
      ':is(:is(.card, .featured) [data-label="&"]) > .title\\&mark';
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return selector === resolvedGrandchild;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/multi-level.css",
            cssRules: [
              {
                ...styleRule(".card, .featured", {}),
                cssRules: [
                  {
                    ...styleRule('& [data-label="&"]', {}),
                    cssRules: [
                      styleRule("& > .title\\&mark", {
                        color: "purple",
                      }),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([
      ".card, .featured",
      ':is(.card, .featured) [data-label="&"]',
      resolvedGrandchild,
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.selector).toBe("& > .title\\&mark");
    expect(result.facts[0]?.metadata.rulePath).toBe("0.0.0.0");
  });

  it("uses a conservative descendant fallback when a nested selector omits ampersand", () => {
    const matchedSelectors: string[] = [];
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return selector === ":is(.card) .title";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/implicit-nesting.css",
            cssRules: [
              {
                ...styleRule(".card", {}),
                cssRules: [styleRule(".title", { color: "red" })],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([
      ".card",
      ":is(.card) .title",
    ]);
    expect(result.facts[0]?.selector).toBe(".title");
  });

  it("collects nested declarations against the inherited style selector", () => {
    const matchedSelectors: string[] = [];
    const nestedDeclarations = styleRule(".unused", {
      background: "silver",
    }).style;
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return selector === ".card";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/nested-declarations.css",
            cssRules: [
              {
                ...styleRule(".card", {}),
                cssRules: [
                  mediaRule("(prefers-color-scheme: dark)", [
                    { style: nestedDeclarations },
                  ]),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([".card", ".card"]);
    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: ".card",
        property: "background",
        value: "silver",
        metadata: completeFactMetadata(
          "/nested-declarations.css",
          "0.0.0.0",
          ["(prefers-color-scheme: dark)"],
        ),
      },
    ]);
  });

  it("skips malformed or over-limit nested selector resolution", () => {
    const parentSelector = "p".repeat(
      INSPECT_LIMITS.selectorLength - 5,
    );
    const matchedSelectors: string[] = [];
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return false;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/bounded-nesting.css",
            cssRules: [
              {
                ...styleRule(parentSelector, {}),
                cssRules: [
                  styleRule("& &", { color: "red" }),
                  styleRule("&[data-label='unterminated]", {
                    color: "blue",
                  }),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(matchedSelectors).toEqual([parentSelector]);
    expect(result.facts).toEqual([]);
  });

  it("does not report supports conditions as media metadata", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/supports.css",
            cssRules: [
              {
                conditionText: "(display: grid)",
                cssRules: [styleRule(".card", { display: "grid" })],
              },
            ],
          },
        ],
      },
    );

    expect(result.facts[0]?.metadata.media).toEqual([]);
    expect(result.facts[0]?.metadata.mediaTruncated).toBe(false);
  });

  it("does not let a trailing escape cross the resolved selector limit", () => {
    const parentSelector = ".card";
    const replacement = `:is(${parentSelector})`;
    const nestedSelector = `&${"a".repeat(
      INSPECT_LIMITS.selectorLength - replacement.length - 1,
    )}\\x`;
    const matchedSelectors: string[] = [];
    const result = collectCssFacts(
      {
        matches(selector) {
          matchedSelectors.push(selector);
          return false;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/escaped-boundary.css",
            cssRules: [
              {
                ...styleRule(parentSelector, {}),
                cssRules: [
                  styleRule(nestedSelector, { color: "red" }),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(nestedSelector.length).toBeLessThanOrEqual(
      INSPECT_LIMITS.selectorLength,
    );
    expect(matchedSelectors).toEqual([parentSelector]);
    expect(result.facts).toEqual([]);
  });

  it("reports inaccessible stylesheets and marks inline sources", () => {
    const inaccessible = {
      href: "https://cdn.example/vendor.css",
      get cssRules(): never {
        throw new Error("Permission denied");
      },
    };
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          inaccessible,
          { href: null, cssRules: [styleRule(".local", { color: "red" })] },
        ],
      },
    );

    expect(result.inaccessibleStylesheets).toEqual([
      {
        code: "browser.stylesheetInaccessible",
        sourceUrl: "https://cdn.example/vendor.css",
        reason: "Permission denied",
      },
    ]);
    expect(result.facts[0].metadata.sourceUrl).toBe("inline-style://document/1");
  });

  it("collects imported rules under their own source and local rule path", () => {
    const importedUrl = "https://example.test/styles/imported.css";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/styles/root.css",
            cssRules: [
              importRule(importedUrl, {
                href: importedUrl,
                cssRules: [styleRule(".imported", { color: "red" })],
              }),
              styleRule(".root", { display: "block" }),
            ],
          },
        ],
      },
    );

    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: ".imported",
        property: "color",
        value: "red",
        metadata: completeFactMetadata(importedUrl, "1.0"),
      },
      {
        type: "css-rule",
        selector: ".root",
        property: "display",
        value: "block",
        metadata: completeFactMetadata(
          "https://example.test/styles/root.css",
          "0.1",
        ),
      },
    ]);
  });

  it("preserves surrounding and import media through nested imports", () => {
    const leafUrl = "https://example.test/styles/leaf.css";
    const middleUrl = "https://example.test/styles/middle.css";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/styles/root.css",
            cssRules: [
              mediaRule("screen", [
                importRule(
                  middleUrl,
                  {
                    href: middleUrl,
                    cssRules: [
                      importRule(
                        leafUrl,
                        {
                          href: leafUrl,
                          cssRules: [
                            styleRule(".nested-import", { color: "green" }),
                          ],
                        },
                        "(min-width: 40rem)",
                      ),
                    ],
                  },
                  "print",
                ),
              ]),
            ],
          },
        ],
      },
    );

    expect(result.facts[0]).toEqual({
      type: "css-rule",
      selector: ".nested-import",
      property: "color",
      value: "green",
      metadata: completeFactMetadata(
        leafUrl,
        "2.0",
        ["screen", "print", "(min-width: 40rem)"],
      ),
    });
  });

  it("reports inaccessible imported rules and continues the root sheet", () => {
    const importedUrl = "https://cdn.example.test/inaccessible.css";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: [
              importRule(importedUrl, {
                href: importedUrl,
                get cssRules(): never {
                  throw new Error("Imported sheet denied");
                },
              }),
              styleRule(".after-import", { color: "blue" }),
            ],
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets).toEqual([
      {
        code: "browser.stylesheetInaccessible",
        sourceUrl: importedUrl,
        reason: "Imported sheet denied",
      },
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.selector).toBe(".after-import");
  });

  it("reports a throwing import styleSheet accessor with its import URL", () => {
    const importedUrl = "https://cdn.example.test/style-sheet-denied.css";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: [
              {
                href: importedUrl,
                get styleSheet(): never {
                  throw new Error("styleSheet denied");
                },
              },
              styleRule(".after-import", { color: "blue" }),
            ],
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets[0]).toEqual({
      code: "browser.stylesheetInaccessible",
      sourceUrl: importedUrl,
      reason: "styleSheet denied",
    });
    expect(result.facts[0]?.selector).toBe(".after-import");
  });

  it("reports a throwing imported href accessor without reading its rules", () => {
    const importedUrl = "https://cdn.example.test/href-denied.css";
    let rulesRead = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: [
              importRule(importedUrl, {
                get href(): never {
                  throw new Error("href denied");
                },
                get cssRules() {
                  rulesRead += 1;
                  return [styleRule(".unread", { color: "red" })];
                },
              }),
              styleRule(".after-import", { color: "blue" }),
            ],
          },
        ],
      },
    );

    expect(rulesRead).toBe(0);
    expect(result.inaccessibleStylesheets[0]).toEqual({
      code: "browser.stylesheetInaccessible",
      sourceUrl: importedUrl,
      reason: "href denied",
    });
    expect(result.facts[0]?.selector).toBe(".after-import");
  });

  it("does not confuse style or group rules carrying a styleSheet field", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: [
              {
                ...styleRule(".styled", { color: "red" }),
                styleSheet: { href: "/not-an-import.css", cssRules: [] },
              },
              {
                styleSheet: { href: "/not-an-import.css", cssRules: [] },
                cssRules: [styleRule(".grouped", { display: "grid" })],
              },
            ],
          },
        ],
      },
    );

    expect(result.facts.map((fact) => fact.selector)).toEqual([
      ".styled",
      ".grouped",
    ]);
  });

  it("stops import cycles but revisits a shared sheet on another branch", () => {
    const rootUrl = "https://example.test/root.css";
    const sharedUrl = "https://example.test/shared.css";
    const rootSheet: { href: string; cssRules: unknown[] } = {
      href: rootUrl,
      cssRules: [],
    };
    const sharedSheet: { href: string; cssRules: unknown[] } = {
      href: sharedUrl,
      cssRules: [],
    };
    sharedSheet.cssRules = [
      importRule(rootUrl, rootSheet),
      styleRule(".shared", { color: "purple" }),
    ];
    rootSheet.cssRules = [
      importRule(sharedUrl, sharedSheet, "screen"),
      importRule(sharedUrl, sharedSheet, "print"),
    ];

    const result = collectCssFacts(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets: [rootSheet] },
    );

    expect(result.facts).toHaveLength(2);
    expect(result.facts.map((fact) => fact.metadata.sourceUrl)).toEqual([
      sharedUrl,
      sharedUrl,
    ]);
    expect(result.facts.map((fact) => fact.metadata.media)).toEqual([
      ["screen"],
      ["print"],
    ]);
  });

  it("applies the global stylesheet limit across imports", () => {
    let styleSheetReads = 0;
    let cssRulesReads = 0;
    const imports = Array.from(
      { length: INSPECT_LIMITS.stylesheets },
      (_, index) => ({
        href: `https://example.test/import-${index}.css`,
        get styleSheet() {
          styleSheetReads += 1;
          return {
            href: `https://example.test/import-${index}.css`,
            get cssRules() {
              cssRulesReads += 1;
              return [];
            },
          };
        },
      }),
    );

    collectCssFacts(
      { matches: () => false },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          { href: "https://example.test/root.css", cssRules: imports },
        ],
      },
    );

    expect(styleSheetReads).toBe(INSPECT_LIMITS.stylesheets - 1);
    expect(cssRulesReads).toBe(INSPECT_LIMITS.stylesheets - 1);
  });

  it("bounds throwing import styleSheet accessors by the stylesheet limit", () => {
    let styleSheetReads = 0;
    const imports = Array.from(
      { length: INSPECT_LIMITS.stylesheets },
      (_, index) => ({
        href: `https://example.test/denied-${index}.css`,
        get styleSheet(): never {
          styleSheetReads += 1;
          throw new Error("denied");
        },
      }),
    );

    const result = collectCssFacts(
      { matches: () => false },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          { href: "https://example.test/root.css", cssRules: imports },
        ],
      },
    );

    expect(styleSheetReads).toBe(INSPECT_LIMITS.stylesheets - 1);
    expect(result.inaccessibleStylesheets).toHaveLength(
      INSPECT_LIMITS.inaccessibleStylesheets,
    );
  });

  it("applies the global rule limit across imported sheets", () => {
    let importedRulesRead = 0;
    let matchCalls = 0;
    let rootRulesRead = 0;
    const importedRules = {
      *[Symbol.iterator]() {
        for (let index = 0; index < INSPECT_LIMITS.cssRules; index += 1) {
          importedRulesRead += 1;
          yield styleRule(`.imported-${index}`, { color: "red" });
        }
      },
    };
    const rootRules = {
      *[Symbol.iterator]() {
        rootRulesRead += 1;
        yield importRule("https://example.test/imported.css", {
          href: "https://example.test/imported.css",
          cssRules: importedRules,
        });
        rootRulesRead += 1;
        yield styleRule(".must-not-be-read", { color: "blue" });
      },
    };

    collectCssFacts(
      {
        matches() {
          matchCalls += 1;
          return false;
        },
      },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: rootRules,
          },
        ],
      },
    );

    expect(importedRulesRead).toBe(INSPECT_LIMITS.cssRules - 1);
    expect(matchCalls).toBe(INSPECT_LIMITS.cssRules - 1);
    expect(rootRulesRead).toBe(1);
  });

  it("drops malformed and over-limit imported URLs before reading rules", () => {
    let styleSheetReads = 0;
    let rulesRead = 0;
    const overLimitUrl = `${exactLengthUrl()}x`;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [
          {
            href: "https://example.test/root.css",
            cssRules: [
              {
                href: "https://example.test/malformed.css",
                get styleSheet() {
                  styleSheetReads += 1;
                  return {
                    href: "https://example.test/import%2.css",
                    get cssRules() {
                      rulesRead += 1;
                      return [styleRule(".malformed", { color: "red" })];
                    },
                  };
                },
              },
              {
                href: "https://example.test/over-limit.css",
                get styleSheet() {
                  styleSheetReads += 1;
                  return {
                    href: overLimitUrl,
                    get cssRules() {
                      rulesRead += 1;
                      return [styleRule(".over-limit", { color: "red" })];
                    },
                  };
                },
              },
            ],
          },
        ],
      },
    );

    expect(styleSheetReads).toBe(2);
    expect(rulesRead).toBe(0);
    expect(result.facts).toEqual([]);
    expect(result.inaccessibleStylesheets).toEqual([]);
  });

  it("skips over-limit selectors and properties before reading values", () => {
    let matchCalls = 0;
    let valueReads = 0;
    const oversizedProperty = "p".repeat(
      INSPECT_LIMITS.propertyNameLength + 1,
    );
    const result = collectCssFacts(
      {
        matches() {
          matchCalls += 1;
          return true;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/bounded.css",
            cssRules: [
              styleRule(
                "s".repeat(INSPECT_LIMITS.selectorLength + 1),
                { color: "red" },
              ),
              {
                selectorText: ".card",
                cssText: `.card { ${oversizedProperty}: value; }`,
                style: {
                  length: 1,
                  item: () => oversizedProperty,
                  getPropertyValue() {
                    valueReads += 1;
                    return "value";
                  },
                  getPropertyPriority: () => "",
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toEqual([]);
    expect(matchCalls).toBe(1);
    expect(valueReads).toBe(0);
  });

  it("bounds priority reads while retaining compact source evidence", () => {
    const declarationCount = INSPECT_LIMITS.declarationsPerRule + 1;
    let cssTextReads = 0;
    let priorityReads = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/metadata.css",
            cssRules: [
              {
                selectorText: ".card",
                get cssText() {
                  cssTextReads += 1;
                  return ".card { color: red; }";
                },
                style: {
                  length: declarationCount,
                  item(index: number) {
                    const prefix = `--property-${index}-`;
                    return `${prefix}${"p".repeat(
                      INSPECT_LIMITS.propertyNameLength - prefix.length,
                    )}`;
                  },
                  getPropertyValue: () => "value",
                  getPropertyPriority() {
                    priorityReads += 1;
                    return "";
                  },
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.declarationsPerRule);
    expect(cssTextReads).toBe(0);
    expect(priorityReads).toBe(INSPECT_LIMITS.declarationsPerRule);
    for (const fact of result.facts) {
      expect(fact.metadata).toEqual(
        completeFactMetadata("/metadata.css", "0.0"),
      );
    }
  });

  it("preserves query and fragment percent characters verbatim", () => {
    const sourceUrl = "https://example.test/app.css?v=100%#coverage%";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: sourceUrl,
            cssRules: [styleRule(".card", { color: "red" })],
          },
        ],
      },
    );

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.metadata.sourceUrl).toBe(sourceUrl);
  });

  it("preserves valid percent escapes in source pathnames", () => {
    const sourceUrl = "https://example.test/My%20Card.css?v=1";
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: sourceUrl,
            cssRules: [styleRule(".card", { color: "red" })],
          },
        ],
      },
    );

    expect(result.facts[0]?.metadata.sourceUrl).toBe(sourceUrl);
    expect(decodeURIComponent(new URL(sourceUrl).pathname)).toBe(
      "/My Card.css",
    );
  });

  it("drops malformed pathname escapes before reading stylesheet rules", () => {
    let rulesRead = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "https://example.test/app%2.css?v=100%",
            get cssRules() {
              rulesRead += 1;
              return [styleRule(".card", { color: "red" })];
            },
          },
        ],
      },
    );

    expect(rulesRead).toBe(0);
    expect(result.facts).toEqual([]);
    expect(result.inaccessibleStylesheets).toEqual([]);
  });

  it("preserves the exact URL limit and drops one crossing its boundary", () => {
    const prefix = "https://example.test/";
    const exactUrl = `${prefix}${"a".repeat(
      INSPECT_LIMITS.urlLength - prefix.length - 3,
    )}%20`;
    const overLimitUrl = `${prefix}${"a".repeat(
      INSPECT_LIMITS.urlLength - prefix.length - 1,
    )}%20`;
    let overLimitRulesRead = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: overLimitUrl,
            get cssRules() {
              overLimitRulesRead += 1;
              return [styleRule(".over-limit", { color: "red" })];
            },
          },
          {
            href: exactUrl,
            cssRules: [styleRule(".exact", { color: "blue" })],
          },
        ],
      },
    );

    expect(exactUrl).toHaveLength(INSPECT_LIMITS.urlLength);
    expect(overLimitUrl.length).toBeGreaterThan(INSPECT_LIMITS.urlLength);
    expect(overLimitUrl.slice(0, INSPECT_LIMITS.urlLength).endsWith("%"))
      .toBe(true);
    expect(overLimitRulesRead).toBe(0);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.metadata.sourceUrl).toBe(exactUrl);
    const resolved = new URL(
      String(result.facts[0]?.metadata.sourceUrl),
      "http://localhost:3000/page",
    );
    expect(() => decodeURIComponent(resolved.pathname)).not.toThrow();
  });

  it("truncates inaccessible stylesheet diagnostic reasons", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/inaccessible.css",
            get cssRules(): never {
              throw new Error(
                "r".repeat(INSPECT_LIMITS.valueLength + 1),
              );
            },
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets[0]?.reason).toHaveLength(
      INSPECT_LIMITS.valueLength,
    );
  });

  it("caps declaration traversal without allocating from style.length", () => {
    let itemCalls = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/large.css",
            cssRules: [
              {
                selectorText: ".card",
                cssText: ".card { color: red; }",
                style: {
                  length: Number.MAX_SAFE_INTEGER,
                  item(index: number) {
                    itemCalls += 1;
                    return `--property-${index}`;
                  },
                  getPropertyValue: () => "value",
                  getPropertyPriority: () => "",
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.declarationsPerRule);
    expect(itemCalls).toBe(INSPECT_LIMITS.declarationsPerRule);
  });

  it("stops matching rules as soon as the fact budget is exhausted", () => {
    let matchCalls = 0;
    let rulesRead = 0;
    const rules = {
      *[Symbol.iterator]() {
        for (
          let index = 0;
          index < INSPECT_LIMITS.factsPerTarget + 1;
          index += 1
        ) {
          rulesRead += 1;
          yield styleRule(`.rule-${index}`, { color: "red" });
        }
      },
    };
    const result = collectCssFacts(
      {
        matches() {
          matchCalls += 1;
          return true;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{ href: "/app.css", cssRules: rules }],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.factsPerTarget);
    expect(matchCalls).toBe(INSPECT_LIMITS.factsPerTarget);
    expect(rulesRead).toBe(INSPECT_LIMITS.factsPerTarget);
  });

  it("bounds stylesheet and total rule traversal when no rules match", () => {
    let stylesheetRuleMatches = 0;
    const stylesheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets + 1 },
      (_, index) => ({
        href: `/sheet-${index}.css`,
        cssRules: [styleRule(`.sheet-${index}`, { color: "red" })],
      }),
    );
    collectCssFacts(
      {
        matches() {
          stylesheetRuleMatches += 1;
          return false;
        },
      },
      { pageUrl: "http://localhost:3000/page", styleSheets: stylesheets },
    );
    expect(stylesheetRuleMatches).toBe(INSPECT_LIMITS.stylesheets);

    let totalRuleMatches = 0;
    const rules = Array.from(
      { length: INSPECT_LIMITS.cssRules + 1 },
      (_, index) => styleRule(`.rule-${index}`, { color: "red" }),
    );
    collectCssFacts(
      {
        matches() {
          totalRuleMatches += 1;
          return false;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{ href: "/app.css", cssRules: rules }],
      },
    );
    expect(totalRuleMatches).toBe(INSPECT_LIMITS.cssRules);
  });

  it("bounds nested traversal and page-controlled CSS metadata", () => {
    const atLimit = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: exactLengthUrl(),
            cssRules: [nestedRule(INSPECT_LIMITS.cssRuleDepth, true)],
          },
        ],
      },
    );
    const fact = atLimit.facts[0];

    expect(fact).toBeDefined();
    expect(fact?.metadata.sourceUrl).toHaveLength(INSPECT_LIMITS.urlLength);
    expect(fact?.metadata.media).toHaveLength(INSPECT_LIMITS.mediaConditions);
    expect(RuntimeFactSchema.parse(fact)).toEqual(fact);

    const beyondLimit = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/deep.css",
            cssRules: [nestedRule(INSPECT_LIMITS.cssRuleDepth + 1, false)],
          },
        ],
      },
    );
    expect(beyondLimit.facts).toEqual([]);
  });
});

function completeFactMetadata(
  sourceUrl: string,
  rulePath: string,
  media: readonly string[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
): CssRuleFact["metadata"] {
  return {
    sourceUrl,
    media: [...media],
    mediaTruncated: false,
    rulePath,
    valueTruncated: false,
    important: false,
    ...overrides,
  };
}

function nestedRule(depth: number, oversizedMetadata: boolean): unknown {
  let nested: unknown = styleRule(".card", {
    color: "x".repeat(
      oversizedMetadata ? INSPECT_LIMITS.valueLength + 1 : 1,
    ),
  });
  if (oversizedMetadata) {
    nested = {
      ...(nested as object),
      cssText: "x".repeat(INSPECT_LIMITS.valueLength + 1),
    };
  }

  for (let index = 0; index < depth; index += 1) {
    nested = mediaRule(
      `screen-${index}${"x".repeat(
        INSPECT_LIMITS.valueLength,
      )}`,
      [nested],
    );
  }
  return nested;
}

function mediaRule(conditionText: string, cssRules: readonly unknown[]) {
  return {
    conditionText,
    media: { mediaText: conditionText },
    cssRules,
  };
}

function nestedMediaRules(count: number, leaf: unknown): unknown {
  let nested = leaf;
  for (let index = count - 1; index >= 0; index -= 1) {
    nested = mediaRule(`screen-${index}`, [nested]);
  }
  return nested;
}

function importRule(
  href: string,
  styleSheet: object,
  mediaText = "",
) {
  return {
    href,
    ...(mediaText ? { media: { mediaText } } : {}),
    styleSheet,
  };
}

function exactLengthUrl(): string {
  const prefix = "https://example.test/";
  return `${prefix}${"u".repeat(INSPECT_LIMITS.urlLength - prefix.length)}`;
}

function styleRule(
  selectorText: string,
  declarations: Record<string, string>,
) {
  const names = Object.keys(declarations);
  return {
    selectorText,
    cssText: `${selectorText} { ${names
      .map((name) => `${name}: ${declarations[name]};`)
      .join(" ")} }`,
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
