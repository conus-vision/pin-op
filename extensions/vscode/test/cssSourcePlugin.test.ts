import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  INSPECT_LIMITS,
  RULE_EVIDENCE_LIMITS,
  canonicalizePublicStylesheetUrl,
  type CssRuleFact,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
  type InspectTarget,
} from "@pin-op/protocol";
import { collectCssFacts } from "../../../packages/browser-extension-core/src/collectCssFacts.js";
import { CssSourcePlugin } from "../src/sourcePlugins/cssSourcePlugin.js";
import {
  completeCssRuleEvidence,
  type CssResolutionFact,
} from "../src/sourcePlugins/cssFacts.js";
import {
  DOCUMENT_STYLESHEET_CACHE_LIMIT,
  GENERATED_STYLESHEET_CACHE_LIMIT,
  findMatchingCssRules,
  normalizeSelector,
  StylesheetAstCache,
} from "../src/sourcePlugins/stylesheetAst.js";
import {
  addCorrelatedCssRule,
  createCorrelatedCssTarget,
  primaryCorrelatedCssRule,
  projectCorrelatedCssFixtures,
  type CorrelatedCssTargetFixture,
} from "./support/correlatedCssFixture.js";

describe("CssSourcePlugin", () => {
  it("exposes only complete correlated evidence to reusable batch resolvers", () => {
    const complete: InspectRuleEvidence = {
      ruleRef: "complete-rule",
      selector: ".card",
      declarations: [{
        property: "color",
        value: "red",
        important: true,
        valueTruncated: false,
      }],
      declarationsTruncated: false,
      generatedSource: {
        sourceUrl: "http://localhost:4173/dist/app.css",
        rulePath: "0.0",
        contexts: [{ kind: "supports", conditionText: "(display: grid)" }],
        contextsTruncated: false,
        unsupportedGroupContext: false,
      },
    };

    expect(completeCssRuleEvidence(complete)).toEqual({
      selector: ".card",
      declarations: [{
        property: "color",
        value: "red",
        important: true,
        valueComplete: true,
      }],
      contexts: [{ kind: "supports", conditionText: "(display: grid)" }],
    });
    expect(completeCssRuleEvidence({
      ...complete,
      declarationsTruncated: true,
    })).toBeUndefined();
  });

  it("rejects legacy selector-owned facts without correlated rule evidence", async () => {
    const legacyTarget = {
      role: "selected",
      depth: 0,
      subject: { selector: ".legacy", metadata: {} },
      facts: [{
        type: "css-rule",
        selector: ".legacy",
        property: "color",
        value: "red",
        metadata: {
          sourceUrl: "/dist/app.css",
          media: [],
          mediaTruncated: false,
          valueTruncated: false,
          important: false,
          rulePath: "0.0",
        },
      }],
      metadata: {},
    } as unknown as InspectTarget;

    const result = await resolveCss(
      ".legacy { color: red; }",
      selection([legacyTarget], { rules: [], omittedRuleCount: 0 }),
    );

    expect(result.matches).toEqual([]);
  });

  it("returns every complete selected and parent CSS rule", async () => {
    const text = [
      ".layout { display: grid; }",
      ".card { color: red; }",
      "@media (min-width: 40rem) {",
      "  .card { color: blue; }",
      "}",
    ].join("\n");
    const parent = cssTarget("parent", ".layout", "/dist/app.css");
    parent.facts[0] = {
      ...parent.facts[0]!,
      property: "display",
      value: "grid",
    };
    const result = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card", "/dist/app.css"),
        parent,
      ]),
    );

    expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual(
      [
        ["selected", ".card"],
        ["parent", ".layout"],
      ],
    );
    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
      ".layout { display: grid; }",
    ]);
  });

  it("uses exact confidence for a positioned fact and heuristic for selector fallback", async () => {
    const text = ".card { color: red; }\n.card { color: blue; }";
    const exact = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card", "/dist/app.css", {
          line: 2,
          column: 1,
        }),
      ]),
    );
    const fallback = await resolveCss(
      text,
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
    );

    expect(exact.matches).toHaveLength(1);
    expect(exact.matches[0]?.confidence).toBe("exact");
    expect(snippets(text, exact.matches)).toEqual([
      ".card { color: blue; }",
    ]);
    expect(fallback.matches).toHaveLength(1);
    expect(fallback.matches[0]?.confidence).toBe("heuristic");
    expect(snippets(text, fallback.matches)).toEqual([
      ".card { color: red; }",
    ]);
  });

  it.each([
    [99, 1],
    [1, 999],
  ])("fails closed for oversized source position %i:%i", async (line, column) => {
    const text = ".card {\n  color: red;\n}\n.final { color: blue; }";
    const result = await resolveCss(
      text,
      selection([cssTarget("selected", ".card", "/dist/app.css", {
        line,
        column,
      })]),
    );

    expect(result.matches).toEqual([]);
  });

  it("accepts a valid source position on the final line", async () => {
    const text = ".card { color: red; }\n.final { color: blue; }";
    const result = await resolveCss(
      text,
      selection([cssTarget("selected", ".final", "/dist/app.css", {
        line: 2,
        column: 1,
      })]),
    );

    expect(snippets(text, result.matches)).toEqual([
      ".final { color: blue; }",
    ]);
  });

  it("uses precise source evidence and a namespaced rule path", async () => {
    const text = ".card,\n.featured { color: red; }\n.other { color: blue; }";
    const positioned = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card,.featured", "/dist/app.css", {
          line: 1,
          column: 1,
        }),
      ]),
    );
    const pathTarget = cssTarget("selected", ".other", "/dist/app.css");
    primaryCorrelatedCssRule(pathTarget).rulePath = "0.1";
    const byPath = await resolveCss(text, selection([pathTarget]));

    expect(snippets(text, positioned.matches)).toEqual([
      ".card,\n.featured { color: red; }",
    ]);
    expect(snippets(text, byPath.matches)).toEqual([
      ".other { color: blue; }",
    ]);
  });

  it("does not confuse a nested rule path with its root suffix", async () => {
    const text = [
      "@media (min-width: 40rem) {",
      "  .first { color: black; }",
      "  .nested { color: red; }",
      "}",
      ".root { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".nested", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0.1";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".nested { color: red; }",
    ]);
  });

  it.each([
    {
      name: "unquoted attribute values",
      first: "[type=button]",
      second: '[type="button"]',
      browser: '[type="button"]',
    },
    {
      name: "escaped identifiers",
      first: ".\\63 ard",
      second: ".card",
      browser: ".card",
    },
    {
      name: "equivalent nth expressions",
      first: ":nth-child(odd)",
      second: ":nth-child(2n+1)",
      browser: ":nth-child(2n+1)",
    },
  ])("uses a trusted path for $name without selector serialization", async ({
    first,
    second,
    browser,
  }) => {
    const text = [
      `${first} { color: red; }`,
      `${second} { color: blue; }`,
    ].join("\n");
    const target = cssTarget("selected", browser, "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      `${first} { color: red; }`,
    ]);
  });

  it("uses a trusted path for minified nested selectors and uppercase media", async () => {
    const text = [
      "@MEDIA (min-width:40rem) {",
      "  .card {",
      "    >.title,.summary { color: red; }",
      "  }",
      "}",
      "@media (min-width: 40rem) {",
      "  .card {",
      "    > .title, .summary { color: blue; }",
      "  }",
      "}",
    ].join("\n");
    const target = cssTarget(
      "selected",
      "& > .title, & .summary",
      "/dist/app.css",
    );
    primaryCorrelatedCssRule(target).rulePath = "0.0.0.0";
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(min-width: 40rem)",
    }];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ">.title,.summary { color: red; }",
    ]);
  });

  it("maps CSSOM nesting paths without confusing declarations or sibling parents", async () => {
    const text = [
      ".card {",
      "  color: red;",
      "  /* CSSOM does not count this comment as a rule. */",
      "  > .title { color: blue; }",
      "  background: silver;",
      "}",
      ".panel {",
      "  color: black;",
      "  > .title { color: green; }",
      "  background: white;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";
    addCorrelatedCssRule(target, "& > .title", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.0",
      declarations: [{ property: "color", value: "blue" }],
    });
    addCorrelatedCssRule(target, ".card", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.1",
      declarations: [{ property: "background", value: "silver" }],
    });

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      [
        ".card {",
        "  color: red;",
        "  /* CSSOM does not count this comment as a rule. */",
        "  > .title { color: blue; }",
        "  background: silver;",
        "}",
      ].join("\n"),
      "> .title { color: blue; }",
      [
        ".card {",
        "  color: red;",
        "  /* CSSOM does not count this comment as a rule. */",
        "  > .title { color: blue; }",
        "  background: silver;",
        "}",
      ].join("\n"),
    ]);
  });

  it("uses CSSOM paths and media evidence for rules nested in a group", async () => {
    const text = [
      ".card {",
      "  @media (min-width: 40rem) {",
      "    .title { color: blue; }",
      "  }",
      "}",
      ".panel {",
      "  @media (min-width: 40rem) {",
      "    .title { color: green; }",
      "  }",
      "}",
    ].join("\n");
    const target = cssTarget("selected", "& .title", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0.0.0";
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(min-width: 40rem)",
    }];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".title { color: blue; }",
    ]);
  });

  it("preserves nested declaration runs through supports and media groups", async () => {
    const text = [
      ".card {",
      "  color: red;",
      "  @supports (display: grid) {",
      "    display: grid;",
      "    @media (min-width: 40rem) {",
      "      gap: 1rem;",
      "    }",
      "  }",
      "  background: white;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";
    addCorrelatedCssRule(target, ".card", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.0.0",
      declarations: [{ property: "display", value: "grid" }],
    });
    addCorrelatedCssRule(target, ".card", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.0.1.0",
      declarations: [{ property: "gap", value: "1rem" }],
    });
    addCorrelatedCssRule(target, ".card", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.1",
      declarations: [{ property: "background", value: "white" }],
    });

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toHaveLength(4);
    expect(snippets(text, result.matches)).toEqual([
      text,
      text,
      text,
      text,
    ]);
  });

  it("counts interleaved and trailing CSSNestedDeclarations", async () => {
    const text = [
      ".card {",
      "  .first { color: red; }",
      "  display: grid;",
      "  .second { color: blue; }",
      "  gap: 1rem;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0.1";
    addCorrelatedCssRule(target, ".card", {
      sourceUrl: "/dist/app.css",
      rulePath: "0.0.3",
      declarations: [{ property: "gap", value: "1rem" }],
    });
    const first = cssTarget("selected", "& .first", "/dist/app.css");
    primaryCorrelatedCssRule(first).rulePath = "0.0.0";
    const second = cssTarget("selected", "& .second", "/dist/app.css");
    primaryCorrelatedCssRule(second).rulePath = "0.0.2";

    const result = await resolveCss(
      text,
      selection([target, first, second]),
    );

    expect(snippets(text, result.matches)).toEqual([
      text,
      text,
      ".first { color: red; }",
      ".second { color: blue; }",
    ]);
  });

  it("keeps nested media uncertainty local to its CSSRuleList", async () => {
    const text = [
      "@media (min-width: 40rem) {",
      "  @unknown demo;",
      "  .duplicate { color: red; }",
      "  .duplicate { color: blue; }",
      "}",
      ".outside { color: green; }",
    ].join("\n");
    const uncertain = cssTarget("selected", ".duplicate", "/dist/app.css");
    primaryCorrelatedCssRule(uncertain).rulePath = "0.0.1";
    const trusted = cssTarget("parent", ".outside", "/dist/app.css");
    primaryCorrelatedCssRule(trusted).rulePath = "0.1";

    const result = await resolveCss(text, selection([uncertain, trusted]));

    expect(snippets(text, result.matches)).toEqual([
      ".outside { color: green; }",
    ]);
  });

  it.each([
    {
      name: "implicit selector branches with nested commas and quoted commas",
      sourceSelector:
        ".title:is(.primary,.secondary), [data-label='a,b'], .escaped\\,comma",
      cssomSelector:
        '& .title:is(.primary, .secondary), & [data-label="a,b"], & .escaped\\,comma',
    },
    {
      name: "relative combinator branches",
      sourceSelector: "> .title, + .summary",
      cssomSelector: "& > .title, & + .summary",
    },
    {
      name: "mixed explicit and implicit branches",
      sourceSelector: "&.active, .child",
      cssomSelector: "&.active, & .child",
    },
  ])("maps nested $name per selector-list branch", async ({
    sourceSelector,
    cssomSelector,
  }) => {
    const text = [
      ".card {",
      `  ${sourceSelector} { color: red; }`,
      "}",
      ".panel {",
      `  ${sourceSelector} { color: blue; }`,
      "}",
    ].join("\n");
    const target = cssTarget("selected", cssomSelector, "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      `${sourceSelector} { color: red; }`,
    ]);
  });

  it.each([
    ["selector-list comma spacing", ".a,.b", ".a, .b", "red"],
    ["combinator spacing", ".a>.b", ".a > .b", "blue"],
    [
      "attribute quote serialization",
      "[data-kind='card']",
      '[data-kind="card"]',
      "green",
    ],
  ])("matches CSSOM %s at the exact rule path", async (
    _name,
    sourceSelector,
    cssomSelector,
    color,
  ) => {
    const text = `${sourceSelector} { color: ${color}; }`;
    const target = cssTarget("selected", cssomSelector, "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([text]);
  });

  it("matches CSSOM media colon spacing at the exact nested path", async () => {
    const text = [
      "@media (min-width:40rem) {",
      "  .card { color: red; }",
      "}",
      "@media (min-width: 60rem) {",
      "  .card { color: blue; }",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0.0";
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(min-width: 40rem)",
    }];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
    ]);
  });

  it("rejects producer-truncated media evidence for pathless fallback", async () => {
    const media = "x".repeat(RULE_EVIDENCE_LIMITS.contextTextLength);
    const text = `@media ${media} { .card { color: red; } }`;
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: media,
    }];
    primaryCorrelatedCssRule(target).contextsTruncated = true;

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toEqual([]);
  });

  it("does not count a leading charset declaration in CSSOM rule paths", async () => {
    const text = [
      '@charset "UTF-8";',
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".duplicate", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.1";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".duplicate { color: blue; }",
    ]);
  });

  it.each([
    [
      "root-relative selector",
      "> .bad {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "invalid nesting",
      ".owner { &-title {} .duplicate { color: red; } .duplicate { color: blue; } }",
      "0.0.1",
    ],
    [
      "undeclared namespace",
      "svg|a {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "trailing combinator",
      ".bad > {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "empty functional selector pseudo",
      ":not() {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "multiple pseudo-elements",
      ".bad::before::after {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "adjacent combinators",
      ".bad > + .worse {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "nested adjacent combinators",
      ".bad:not(.x > + .y) {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "non-terminal pseudo-element",
      ".bad::before:hover {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "pseudo-element before a descendant",
      ".bad::before .child {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
    [
      "legacy non-terminal pseudo-element",
      ".bad:before:hover {}\n.duplicate { color: red; }\n.duplicate { color: blue; }",
      "0.1",
    ],
  ])("fails closed after %s", async (_name, text, path) => {
    expect((await resolvePath(text, path)).matches).toEqual([]);
  });

  it.each([
    [
      "declared namespace",
      "@namespace svg url(http://www.w3.org/2000/svg);\nsvg|a { color: red; }",
      "svg|a",
      "0.1",
      "svg|a { color: red; }",
    ],
    [
      "nested relative selector",
      ".owner { > .valid { color: red; } }",
      "& > .valid",
      "0.0.0",
      "> .valid { color: red; }",
    ],
    [
      "non-empty functional selector pseudo",
      ".valid:not(.bad) { color: red; }",
      ".valid:not(.bad)",
      "0.0",
      ".valid:not(.bad) { color: red; }",
    ],
    [
      "terminal pseudo-element",
      ".valid::before { color: red; }",
      ".valid::before",
      "0.0",
      ".valid::before { color: red; }",
    ],
  ])("trusts a %s", async (_name, text, selector, path, expected) => {
    const result = await resolvePath(text, path, selector);
    expect(snippets(text, result.matches)).toEqual([expected]);
  });

  it.each([
    ["supports", "@supports display: grid { .ignored {} }"],
    ["container", "@container card and { .ignored {} }"],
    ["layer", "@layer reset, theme { .ignored {} }"],
    ["scope", "@scope .root { .ignored {} }"],
    ["starting-style", "@starting-style unexpected { .ignored {} }"],
    [
      "supports not-chain",
      "@supports not (display: grid) and (gap: 1rem) { .ignored {} }",
    ],
    ["container name-only", "@container sidebar { .ignored {} }"],
    [
      "container function-only",
      "@container style(--theme: dark) { .ignored {} }",
    ],
    [
      "container not-chain",
      "@container sidebar not (width > 10rem) and (height > 10rem) { .ignored {} }",
    ],
    [
      "supports semicolon",
      "@supports (display: grid; color: red) { .ignored {} }",
    ],
    [
      "supports braces",
      "@supports (display: {grid}) { .ignored {} }",
    ],
    [
      "container semicolon",
      "@container sidebar (width: 1px; color: red) { .ignored {} }",
    ],
    [
      "container braces",
      "@container sidebar (width: {1px}) { .ignored {} }",
    ],
    ["reserved container name", "@container none (width > 1px) { .ignored {} }"],
    ["globally reserved container name", "@container default (width > 1px) { .ignored {} }"],
    ["condition keyword as name", "@container and (width > 1px) { .ignored {} }"],
  ])("fails closed after malformed %s group", async (_name, prefix) => {
    const text = `${prefix}\n.duplicate { color: red; }\n.duplicate { color: blue; }`;
    expect((await resolvePath(text, "0.1")).matches).toEqual([]);
  });

  it.each([
    ["@media (min-width: 40rem)", ".valid"],
    ["@supports (display: grid)", ".valid"],
    ["@supports not (display: grid)", ".valid"],
    ["@supports (display: grid) and (gap: 1rem)", ".valid"],
    ["@container (width > 20rem)", ".valid"],
    ["@container card (width > 20rem)", ".valid"],
    ["@layer components", ".valid"],
    ["@scope (.shell) to (.stop)", ".valid"],
    ["@starting-style", ".valid"],
  ])("trusts common valid group %s", async (prelude, selector) => {
    const text = `${prelude} { ${selector} { color: red; } }`;
    const result = await resolvePath(text, "0.0.0", selector);
    expect(snippets(text, result.matches)).toEqual([
      `${selector} { color: red; }`,
    ]);
  });

  it.each([
    ["initial", ["@LAYER reset;", "@IMPORT url('theme.css');"], "0.3"],
    [
      "imports",
      [
        "@IMPORT url('base.css');",
        "@LAYER reset;",
        "@IMPORT url('theme.css');",
      ],
      "0.4",
    ],
  ])("keeps a statement layer in the %s phase", async (_phase, prefix, path) => {
    const text = [
      ...prefix,
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const result = await resolvePath(text, path);
    expect(snippets(text, result.matches)).toEqual([
      ".duplicate { color: blue; }",
    ]);
  });

  it.each([
    ["quoted string", '"theme.css"'],
    ["url", "url('theme.css')"],
    [
      "supported tail",
      "url(theme.css) layer(theme) supports(display: grid) screen and (min-width: 40rem)",
    ],
    ["condition-only media", '"theme.css" (min-width: 1px)'],
    ["comma media list", '"theme.css" screen, print'],
    ["balanced supports not", '"theme.css" supports(not (display: grid))'],
  ])("counts a valid %s import", async (_name, params) => {
    const text = `@import ${params};\n` +
      ".duplicate { color: red; }\n.duplicate { color: blue; }";
    const result = await resolvePath(text, "0.2");
    expect(snippets(text, result.matches)).toEqual([
      ".duplicate { color: blue; }",
    ]);
  });

  it.each([
    ["source", "nonsense"],
    ["media tail", '"theme.css" screen and (:)'],
    [
      "supports semicolon",
      '"theme.css" supports(display: grid; color: red)',
    ],
    ["supports braces", '"theme.css" supports(display: {grid})'],
    [
      "supports not-chain",
      '"theme.css" supports(not (display: grid) and (gap: 1rem))',
    ],
    ["supports boundary", '"theme.css" supports(display: grid)screen'],
  ])("fails closed after a malformed import %s collision", async (_name, params) => {
    const text = `@import ${params};\n` +
      ".duplicate { color: red; }\n.duplicate { color: blue; }";
    expect((await resolvePath(text, "0.1")).matches).toEqual([]);
  });

  it("fails closed when import follows a block layer", async () => {
    const text = "@layer reset {}\n@import url('late.css');\n" +
      ".duplicate { color: red; }\n.duplicate { color: blue; }";
    expect((await resolvePath(text, "0.2")).matches).toEqual([]);
  });

  it.each([
    ["font-face", "@font-face {}"],
    ["view-transition", "@view-transition {}"],
    ["property", "@property --accent {}"],
    ["font-palette-values", "@font-palette-values --brand {}"],
    ["color-profile", "@color-profile --print {}"],
    ["counter-style", "@counter-style custom {}"],
    ["page", "@page :first {}"],
    ["font-feature-values", "@font-feature-values Inter {}"],
    ["font-feature-values multiword", "@font-feature-values Open Sans {}"],
  ])("counts a valid @%s leaf rule", async (_name, prefix) => {
    const text = `${prefix}\n.duplicate { color: red; }\n` +
      ".duplicate { color: blue; }";
    const result = await resolvePath(text, "0.2");
    expect(snippets(text, result.matches)).toEqual([
      ".duplicate { color: blue; }",
    ]);
  });

  it.each([
    ["font-face prelude", "@font-face nope {}"],
    ["view-transition prelude", "@view-transition nope {}"],
    ["property name", "@property accent {}"],
    ["font-palette-values name", "@font-palette-values brand {}"],
    ["color-profile name", "@color-profile print {}"],
    ["counter-style name", "@counter-style -- {}"],
    ["page selector", "@page :hover {}"],
    ["font-feature-values family", "@font-feature-values {}"],
    ["generic font-feature-values family", "@font-feature-values serif {}"],
    ["reserved font-feature-values family", "@font-feature-values default {}"],
    ["system font-feature-values family", "@font-feature-values system-ui {}"],
    ["system font shorthand family", "@font-feature-values caption {}"],
  ])("fails closed after malformed @%s", async (_name, prefix) => {
    const text = `${prefix}\n.duplicate { color: red; }\n` +
      ".duplicate { color: blue; }";
    expect((await resolvePath(text, "0.1")).matches).toEqual([]);
  });

  it.each([
    {
      name: "an unknown at-rule",
      prefix: "@unknown demo;",
      path: "0.1",
    },
    {
      name: "an invalid selector",
      prefix: ".broken,, .selector { color: black; }",
      path: "0.1",
    },
    {
      name: "a misplaced import",
      prefix: ".before { color: black; }\n@import url('late.css');",
      path: "0.2",
    },
    {
      name: "a misplaced namespace",
      prefix: ".before { color: black; }\n@namespace svg url(http://www.w3.org/2000/svg);",
      path: "0.2",
    },
    {
      name: "a malformed known group rule",
      prefix: "@media screen;",
      path: "0.1",
    },
    {
      name: "a malformed known leaf rule",
      prefix: "@font-face;",
      path: "0.1",
    },
  ])("fails closed after $name shifts a browser path", async ({
    prefix,
    path,
  }) => {
    const text = [
      prefix,
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".duplicate", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = path;

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toEqual([]);
  });

  it("preserves meaningful string whitespace in normalized selector metadata", () => {
    expect(normalizeSelector('  [data-label="a  b"]  ')).toBe(
      '[data-label="a  b"]',
    );
  });

  it("falls back after a valid unresolved browser rule path", async () => {
    const unresolved = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(unresolved).rulePath = "0.99";

    const result = await resolveCss(
      ".layout { display: grid; }\n.card { color: red; }",
      selection([unresolved]),
    );

    expect(snippets(
      ".layout { display: grid; }\n.card { color: red; }",
      result.matches,
    )).toEqual([".card { color: red; }"]);
  });

  it("uses a fingerprint fallback for an invalidated path collision", () => {
    const ast = new StylesheetAstCache();
    const parsed = ast.parseText(
      "file:///workspace/dist/app.css",
      "css",
      ".card { color: red; }",
    );
    const collided = {
      ...parsed,
      pathIndex: new Map([["0", null]]),
    } as unknown as Parameters<typeof findMatchingCssRules>[0];
    const fact = cssResolutionFact(
      ".card",
      "color",
      "red",
      "/dist/app.css",
      "0.0",
    );

    expect(() =>
      findMatchingCssRules(collided, fact, parsed.document)
    ).not.toThrow();
    expect(findMatchingCssRules(collided, fact, parsed.document)).toHaveLength(1);
  });

  it("fails closed for unsupported nested collector context and preserves duplicate ambiguity", async () => {
    const text = (await readFile(
      new URL("../../../examples/basic-css/fallback.css", import.meta.url),
      "utf8",
    )).replace(/\r\n/g, "\n");
    const collected = collectCssFacts(
      { matches: (selector) => selector === ".pin-op-path-miss" },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/fallback.css",
          cssRules: [
            collectorStyleRule(".pin-op-cssom-only", "--fixture", "cssom"),
            {
              cssRules: [
                collectorStyleRule(".card", "background-color", "rgb(245, 247, 250)"),
                collectorStyleRule(
                  ".pin-op-path-miss",
                  "outline-style",
                  "dashed",
                ),
                collectorStyleRule(
                  ".duplicate-selector",
                  "text-decoration-line",
                  "underline",
                ),
              ],
            },
          ],
        }],
      },
    );
    expect(collected.facts).toEqual([
      expect.objectContaining({
        ruleRef: collected.ruleEvidence.rules[0]?.ruleRef,
        property: "outline-style",
        value: "dashed",
        important: false,
        valueTruncated: false,
        metadata: {},
      }),
    ]);
    expect(collected.ruleEvidence.rules[0]).toMatchObject({
      selector: ".pin-op-path-miss",
      generatedSource: { rulePath: "0.1.1" },
    });

    const fallback = await resolveCss(
      text,
      selection(
        [collectedTarget(collected.facts)],
        withRulePath(collected.ruleEvidence, "0.99"),
      ),
    );

    expect(collected.ruleEvidence.rules[0]?.generatedSource)
      .toMatchObject({ unsupportedGroupContext: true });
    expect(fallback.status).toBe("no-rule-match");
    expect(fallback.matches).toEqual([]);

    const duplicate = cssTarget(
      "selected",
      ".duplicate-selector",
      "/fallback.css",
    );
    duplicate.facts[0]!.property = "text-decoration";
    duplicate.facts[0]!.value = "underline";
    primaryCorrelatedCssRule(duplicate).rulePath = "0.1.2";

    const ambiguous = await resolveCss(text, selection([duplicate]));

    expect(ambiguous.status).toBe("rule-match-ambiguous");
    expect(ambiguous.matches).toEqual([]);
  });

  it("reports bounded indistinguishable duplicates and refuses oversized buckets", async () => {
    const boundedText = [
      ".duplicate { color: red; }",
      ".duplicate { color: red; }",
    ].join("\n");
    const bounded = await resolveCss(
      boundedText,
      selection([cssTarget("selected", ".duplicate", "/dist/app.css")]),
    );
    const oversizedText = Array.from(
      { length: 65 },
      (_, index) => `.duplicate { order: ${index}; }`,
    ).join("\n");
    const oversized = await resolveCss(
      oversizedText,
      selection([cssTarget("selected", ".duplicate", "/dist/app.css")]),
    );

    expect(bounded.matches).toEqual([]);
    expect(bounded.status).toBe("rule-match-ambiguous");
    expect(oversized.matches).toEqual([]);
  });

  it("uses precomputed indexes for path and fallback lookups", () => {
    const ast = new StylesheetAstCache();
    const parsed = ast.parseText(
      "file:///workspace/dist/app.css",
      "css",
      Array.from(
        { length: 1024 },
        (_, index) => `.rule-${index} { order: ${index}; }`,
      ).join("\n"),
    );
    const source = parsed.document;
    Object.defineProperty(parsed, "rules", {
      get(): never {
        throw new Error("lookup scanned ParsedStylesheet.rules");
      },
    });
    const byPath = cssResolutionFact(
      ".browser-serialized-selector",
      "order",
      "1023",
      "/dist/app.css",
      "0.1023",
    );
    const bySelector: CssResolutionFact = {
      ...byPath,
      selector: ".rule-512",
      value: "512",
      metadata: { ...byPath.metadata, rulePath: "0.2048" },
    };

    expect(findMatchingCssRules(parsed, byPath, source).map(
      (rule) => rule.selector,
    )).toEqual([".rule-1023"]);
    expect(findMatchingCssRules(parsed, bySelector, source).map(
      (rule) => rule.selector,
    )).toEqual([".rule-512"]);
  });

  it("reuses the current generated AST and evicts least-recent history", () => {
    const ast = new StylesheetAstCache();
    const firstText = ".first { color: red; }";
    const currentText = ".current { color: blue; }";
    const first = ast.parseText("file:///generated/first.css", "css", firstText);
    const current = ast.parseText(
      "file:///generated/current.css",
      "css",
      currentText,
    );
    for (
      let index = 0;
      index < GENERATED_STYLESHEET_CACHE_LIMIT - 2;
      index += 1
    ) {
      ast.parseText(
        `file:///generated/filler-${index}.css`,
        "css",
        `.filler-${index} { order: ${index}; }`,
      );
    }

    expect(ast.parseText(
      "file:///generated/current.css",
      "css",
      currentText,
    )).toBe(current);
    ast.parseText(
      "file:///generated/overflow.css",
      "css",
      ".overflow { display: block; }",
    );

    expect(ast.parseText(
      "file:///generated/current.css",
      "css",
      currentText,
    )).toBe(current);
    expect(ast.parseText(
      "file:///generated/first.css",
      "css",
      firstText,
    )).not.toBe(first);
  });

  it("bounds parsed documents while retaining the latest URI version", () => {
    const ast = new StylesheetAstCache();
    const firstDocument = document(
      ".first { color: red; }",
      1,
      "file:///workspace/first.css",
    );
    const currentV1 = document(
      ".current { color: blue; }",
      1,
      "file:///workspace/current.css",
    );
    const currentV2 = document(
      ".current { color: green; }",
      2,
      "file:///workspace/current.css",
    );
    const first = ast.parseDocument(firstDocument, "css");
    const previous = ast.parseDocument(currentV1, "css");
    const current = ast.parseDocument(currentV2, "css");
    const generated = ast.parseText(
      "file:///generated/shared.css",
      "css",
      ".generated { display: grid; }",
    );

    expect(current).not.toBe(previous);
    expect(ast.parseDocument(currentV2, "css")).toBe(current);
    for (
      let index = 0;
      index < DOCUMENT_STYLESHEET_CACHE_LIMIT - 2;
      index += 1
    ) {
      ast.parseDocument(document(
        `.document-${index} { order: ${index}; }`,
        1,
        `file:///workspace/document-${index}.css`,
      ), "css");
    }

    expect(ast.parseDocument(currentV2, "css")).toBe(current);
    ast.parseDocument(document(
      ".overflow { display: block; }",
      1,
      "file:///workspace/overflow.css",
    ), "css");

    expect(ast.parseDocument(currentV2, "css")).toBe(current);
    expect(ast.parseDocument(firstDocument, "css")).not.toBe(first);
    expect(ast.parseText(
      "file:///generated/shared.css",
      "css",
      ".generated { display: grid; }",
    )).toBe(generated);
  });

  it("does not match an ambiguous or different active CSS source", async () => {
    const ambiguous = await resolveCss(
      ".card {}",
      selection([cssTarget("selected", ".card", "/app.css")]),
      { uris: [], status: "ambiguous", strategy: "automatic" },
    );
    const different = await resolveCss(
      ".card {}",
      selection([cssTarget("selected", ".card", "/app.css")]),
      {
        uris: ["file:///workspace/other.css"],
        status: "exact",
        strategy: "automatic",
      },
    );

    expect(ambiguous.matches).toEqual([]);
    expect(ambiguous.status).toBe("source-ambiguous");
    expect(ambiguous.diagnostics?.[0]?.code).toBe("css.sourceAmbiguous");
    expect(different.matches).toEqual([]);
    expect(different.status).toBe("source-not-active-document");
    expect(JSON.stringify(different)).not.toContain(
      "file:///workspace/other.css",
    );
  });

  it("does not grant CSSOM path authority to a unique basename", async () => {
    const target = cssTarget("selected", ".card", "/assets/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";
    const text = [
      ".wrong { color: blue; }",
      ".card { color: red; }",
    ].join("\n");

    const result = await resolveCss(
      text,
      selection([target]),
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "unique-basename",
        strategy: "automatic",
      },
    );

    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
    ]);
    expect(result.matches[0]?.confidence).toBe("heuristic");
  });

  it("does not heuristic-resolve a fact without stable rule identity", async () => {
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = undefined;

    const result = await resolveCss(
      ".card { color: red; }",
      selection([target]),
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("no-rule-match");
  });

  it("does not combine pathless declarations into synthetic rule evidence", async () => {
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = undefined;
    target.facts.splice(0, target.facts.length,
      {
        ...target.facts[0]!,
        property: "color",
        value: "red",
      },
      {
        ...target.facts[0]!,
        property: "display",
        value: "grid",
      },
    );

    const result = await resolveCss(
      ".card { color: red; display: grid; }",
      selection([target]),
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("no-rule-match");
  });

  it("falls back to a unique fingerprint after an active-source path miss", async () => {
    const text = [
      ".card {",
      "  color: red;",
      "  display: grid;",
      "}",
      ".card { color: blue; display: flex; }",
    ].join("\n");
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/dist/app.css",
      [["display", "grid"], ["color", "red"]],
    );
    primaryCorrelatedCssRule(target).rulePath = "0.99";

    const result = await resolveCss(text, selection([target]));

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({
        confidence: "heuristic",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 3, character: 1 },
        },
      }),
    ]);
    expect(snippets(text, result.matches)).toEqual([
      [
        ".card {",
        "  color: red;",
        "  display: grid;",
        "}",
      ].join("\n"),
    ]);
  });

  it("matches CSSOM selector-list whitespace after a path miss", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".a,.b",
      "/dist/app.css",
      [["display", "grid"]],
    );
    primaryCorrelatedCssRule(target).rulePath = "0.99";

    const result = await resolveCss(
      ".a, .b { display: grid; }",
      selection([target]),
    );

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({ confidence: "heuristic" }),
    ]);
  });

  it("uses explicit empty media context only for top-level rules", async () => {
    const target = completeCssTarget(".card", {
      rulePath: "0.99",
      media: [],
    });
    const text = [
      "@media screen { .card { color: red; } }",
      ".card { color: red; }",
    ].join("\n");

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
    ]);
  });

  it("keeps exact CSSOM path resolution independent of fingerprint metadata", async () => {
    const target = cssTarget("selected", ".card", "/dist/app.css");
    primaryCorrelatedCssRule(target).rulePath = "0.0";

    const result = await resolveCss(
      ".card { color: red; }",
      selection([target]),
    );

    expect(result.matches).toEqual([
      expect.objectContaining({ confidence: "exact" }),
    ]);
  });

  it("does not search the active document for a workspace-bound missing source", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/missing/app.css",
      [["display", "grid"]],
    );
    primaryCorrelatedCssRule(target).startLine = 999;
    primaryCorrelatedCssRule(target).startColumn = 1;
    const result = await resolveCss(
      ".card { display: grid; }",
      selection([target]),
      {
        uris: [],
        status: "not-found",
        strategy: "workspace-bound",
        workspaceFolderUri: "file:///workspaces/_ORB",
      },
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("source-not-found");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "css.sourceNotFound" }),
      {
        code: "css.sourceWorkspaceBound",
        message: "Workspace-bound: _ORB",
        severity: "info",
      },
    ]);
  });

  it("allows automatic fingerprint fallback when source is wholly not found", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/missing/app.css",
      [["display", "grid"]],
    );
    primaryCorrelatedCssRule(target).startLine = 999;
    primaryCorrelatedCssRule(target).startColumn = 1;
    const result = await resolveCss(
      ".card { display: grid; }",
      selection([target]),
      { uris: [], status: "not-found", strategy: "automatic" },
    );

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({ confidence: "heuristic" }),
    ]);
    expect(result.diagnostics).toEqual([{
      code: "css.sourceAutomatic",
      message: "Automatic source matching",
      severity: "info",
    }]);
  });

  it("retains bound fingerprint fallback after an active-source path miss", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/dist/app.css",
      [["display", "grid"]],
    );

    const result = await resolveCss(
      ".card { display: grid; }",
      selection([target]),
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "exact",
        strategy: "workspace-bound",
      },
    );

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({ confidence: "heuristic" }),
    ]);
    expect(result.diagnostics).toEqual([{
      code: "css.sourceWorkspaceBound",
      message: "Workspace-bound: workspace",
      severity: "info",
    }]);
  });

  it("deduplicates strategy diagnostics by code and message", async () => {
    const result = await resolveCss(
      [
        ".card { color: red; }",
        ".layout { color: red; }",
        ".panel { color: red; }",
      ].join("\n"),
      selection([
        cssTarget("selected", ".card", "/dist/app.css"),
        cssTarget("parent", ".layout", "/dist/layout.css"),
        cssTarget("parent", ".panel", "/dist/panel.css"),
      ]),
      async (sourceUrl) => ({
        uris: ["file:///workspace/dist/app.css"],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri: new URL(sourceUrl).pathname === "/dist/layout.css"
          ? "file:///workspaces/SECOND"
          : "file:///workspaces/FIRST",
      }),
    );

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(3);
    expect(result.diagnostics).toEqual([
      {
        code: "css.sourceWorkspaceBound",
        message: "Workspace-bound: FIRST",
        severity: "info",
      },
      {
        code: "css.sourceWorkspaceBound",
        message: "Workspace-bound: SECOND",
        severity: "info",
      },
    ]);
  });

  it("does not parse a pre-aborted document", async () => {
    let parseCalls = 0;
    const ast = new StylesheetAstCache();
    ast.parseDocument = () => {
      parseCalls += 1;
      throw new Error("parser should not be called");
    };
    const controller = new AbortController();
    controller.abort();

    const result = await resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      undefined,
      new CssSourcePlugin(ast),
      1,
      controller.signal,
    );

    expect(parseCalls).toBe(0);
    expect(result).toEqual({
      status: "no-rule-match",
      matches: [],
      diagnostics: [],
    });
  });

  it("returns an empty aborted result when source resolution is cancelled", async () => {
    let finishResolution: ((resolution: Resolution) => void) | undefined;
    let resolutionStarted = false;
    const deferredResolution = new Promise<Resolution>((resolve) => {
      finishResolution = resolve;
    });
    const controller = new AbortController();
    const pending = resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      async () => {
        resolutionStarted = true;
        return deferredResolution;
      },
      new CssSourcePlugin(),
      1,
      controller.signal,
    );

    expect(resolutionStarted).toBe(true);
    controller.abort();
    finishResolution?.({
      uris: ["file:///workspace/dist/app.css"],
      status: "exact",
      strategy: "automatic",
    });

    await expect(pending).resolves.toEqual({
      status: "no-rule-match",
      matches: [],
      diagnostics: [],
    });
  });

  it("does not expose the workspace URI in a bound strategy diagnostic", async () => {
    const result = await resolveCss(
      ".card { display: grid; }",
      selection([cssTargetWithDeclarations(
        "selected",
        ".card",
        "/missing/app.css",
        [["display", "grid"]],
      )]),
      {
        uris: [],
        status: "not-found",
        strategy: "workspace-bound",
        workspaceFolderUri:
          "file:///C:/Users/alice/private-project/_ORB%20Workspace/",
      },
    );

    expect(result.diagnostics).toContainEqual({
      code: "css.sourceWorkspaceBound",
      message: "Workspace-bound: _ORB Workspace",
      severity: "info",
    });
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain("file:///");
    expect(serialized).not.toContain("C:/Users/alice/private-project");
  });

  it("removes control and bidi characters from workspace labels", async () => {
    const controls =
      "\u0000\u001f\u007f\u0080\u009f\u061c\u200e\u200f" +
      "\u2028\u2029\u202a\u202e\u2066\u2069";
    const label = `  Project${controls} Workspace  `;
    const result = await resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri:
          `file:///workspaces/${encodeURIComponent(label)}`,
      },
    );

    expect(result.diagnostics).toEqual([{
      code: "css.sourceWorkspaceBound",
      message: "Workspace-bound: Project Workspace",
      severity: "info",
    }]);
  });

  it("uses a fallback when workspace label sanitization leaves no text", async () => {
    const label = "\u0000\u0080\u2028\u202e\u2066";
    const result = await resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      {
        uris: [],
        status: "ambiguous",
        strategy: "workspace-bound",
        workspaceFolderUri:
          `file:///workspaces/${encodeURIComponent(label)}`,
      },
    );

    expect(result.diagnostics?.at(-1)).toEqual({
      code: "css.sourceWorkspaceBound",
      message: "Workspace-bound: ambiguous workspace",
      severity: "info",
    });
  });

  it("caps displayed workspace labels at 128 Unicode characters", async () => {
    const displayedLabel = `${"a".repeat(127)}\u{1f600}`;
    const label = `${displayedLabel}trailing text`;
    const result = await resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri:
          `file:///workspaces/${encodeURIComponent(label)}`,
      },
    );

    expect(result.diagnostics).toEqual([{
      code: "css.sourceWorkspaceBound",
      message: `Workspace-bound: ${displayedLabel}`,
      severity: "info",
    }]);
    expect([...displayedLabel]).toHaveLength(128);
  });

  it("rejects unsupported source resolution strategies", async () => {
    await expect(resolveCss(
      ".card { color: red; }",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      {
        uris: [],
        status: "not-found",
        strategy: "future-strategy",
      } as unknown as Resolution,
    )).rejects.toThrow(
      "Unsupported CSS source resolution strategy: future-strategy",
    );
  });

  it.each([
    ["other-document", {
      uris: ["file:///workspace/other.css"],
      status: "exact",
      strategy: "automatic",
    } as const, "source-not-active-document"],
    ["ambiguous", {
      uris: [],
      status: "ambiguous",
      strategy: "automatic",
    } as const, "source-ambiguous"],
  ])("does not fingerprint-fallback for %s source resolution", async (
    _name,
    resolution,
    status,
  ) => {
    const result = await resolveCss(
      ".card { display: grid; }",
      selection([cssTargetWithDeclarations(
        "selected",
        ".card",
        "/app.css",
        [["display", "grid"]],
      )]),
      resolution,
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe(status);
  });

  it("reports ambiguity instead of choosing duplicate strong candidates", async () => {
    const result = await resolveCss(
      [
        ".card { color: red; display: grid; }",
        ".card { display: grid; color: red; }",
      ].join("\n"),
      selection([cssTargetWithDeclarations(
        "selected",
        ".card",
        "/dist/app.css",
        [["color", "red"], ["display", "grid"]],
      )]),
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("rule-match-ambiguous");
  });

  it("does not displace an exact path result with a stronger fingerprint", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/dist/app.css",
      [["color", "blue"], ["display", "grid"]],
    );
    primaryCorrelatedCssRule(target).rulePath = "0.0";
    const text = [
      ".card { color: red; }",
      ".card { color: blue; display: grid; }",
    ].join("\n");

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
    ]);
    expect(result.matches[0]?.confidence).toBe("exact");
  });

  it("uses available media evidence and fails conservatively on mismatch", async () => {
    const target = cssTargetWithDeclarations(
      "selected",
      ".card",
      "/dist/app.css",
      [["color", "red"]],
    );
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(min-width: 40rem)",
    }];
    const text = [
      "@media (min-width:40rem) { .card { color: red; } }",
      "@media (min-width:60rem) { .card { color: red; } }",
    ].join("\n");

    const matched = await resolveCss(text, selection([target]));
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(orientation: landscape)",
    }];
    const mismatched = await resolveCss(text, selection([target]));

    expect(matched.matches).toHaveLength(1);
    expect(mismatched.matches).toEqual([]);
    expect(mismatched.status).toBe("no-rule-match");
  });

  it("coalesces declaration facts from the same rule", async () => {
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts.push({
      ...target.facts[0]!,
      property: "padding",
      value: "1rem",
    });

    const result = await resolveCss(".card { color: red; padding: 1rem; }", selection([target]));

    expect(result.matches).toHaveLength(1);
  });

  it("does not resolve context-incomplete correlated rule evidence", async () => {
    const target = completeCssTarget(".card", { rulePath: "0.99" });
    target.facts.push({
      ...target.facts[0]!,
      property: "display",
      value: "grid",
    });
    primaryCorrelatedCssRule(target).contextsTruncated = true;

    const result = await resolveCss(
      [
        ".card { color: red; display: block; }",
        ".card { color: red; display: grid; }",
      ].join("\n"),
      selection([target]),
    );

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("no-rule-match");
  });

  it("uses priority evidence emitted by the browser collector", async () => {
    const collected = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/dist/app.css",
          cssRules: [{
            selectorText: ".card",
            style: {
              length: 1,
              item: () => "color",
              getPropertyValue: () => "red",
              getPropertyPriority: () => "important",
            },
          }],
        }],
      },
    );
    const target: InspectTarget = {
      role: "selected",
      depth: 0,
      subject: { selector: ".card", metadata: {} },
      facts: collected.facts.map((fact) => ({
        ...fact,
        metadata: { ...fact.metadata, rulePath: "0.99" },
      })),
      metadata: {},
    };
    const text = [
      ".card { color: red; }",
      ".card { color: red !important; }",
    ].join("\n");

    const result = await resolveCss(
      text,
      selection([target], withRulePath(collected.ruleEvidence, "0.99")),
    );

    expect(collected.facts[0]?.important).toBe(true);
    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red !important; }",
    ]);
  });

  it("rejects pre-trim value truncation reported by the collector", async () => {
    const prefix = "x".repeat(INSPECT_LIMITS.valueLength - 1);
    const collected = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/dist/app.css",
          cssRules: [{
            selectorText: ".card",
            style: {
              length: 1,
              item: () => "--payload",
              getPropertyValue: () => `${prefix} tail`,
              getPropertyPriority: () => "",
            },
          }],
        }],
      },
    );

    const result = await resolveCss(
      `.card { --payload: ${prefix}; }`,
      selection([collectedTarget(collected.facts)], collected.ruleEvidence),
    );

    expect(collected.facts[0]?.valueTruncated).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it("rejects pre-trim media truncation reported by the collector", async () => {
    const condition = "screen-" + "x".repeat(
      INSPECT_LIMITS.valueLength - "screen-".length - 1,
    );
    const collected = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/dist/app.css",
          cssRules: [{
            conditionText: `${condition} tail`,
            media: { mediaText: `${condition} tail` },
            cssRules: [{
              selectorText: ".card",
              style: {
                length: 1,
                item: () => "color",
                getPropertyValue: () => "red",
                getPropertyPriority: () => "",
              },
            }],
          }],
        }],
      },
    );

    const result = await resolveCss(
      `@media ${condition} { .card { color: red; } }`,
      selection([collectedTarget(collected.facts)], collected.ruleEvidence),
    );

    expect(collected.ruleEvidence.rules[0]?.generatedSource)
      .toMatchObject({ contextsTruncated: true });
    expect(result.matches).toEqual([]);
  });

  it("rejects nested media count overflow reported by the collector", async () => {
    const conditions = Array.from(
      { length: INSPECT_LIMITS.mediaConditions + 1 },
      (_, index) => `(min-width: ${index + 1}px)`,
    );
    const collected = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/dist/app.css",
          cssRules: [collectorMediaRules(
            conditions,
            collectorStyleRule(),
          )],
        }],
      },
    );
    const text = mediaCss(
      conditions.slice(0, INSPECT_LIMITS.mediaConditions),
      ".card { color: red; }",
    );

    const result = await resolveCss(
      text,
      selection([collectedTarget(collected.facts)], collected.ruleEvidence),
    );

    expect(result.matches).toEqual([]);
    expect(collected.ruleEvidence.rules[0]?.generatedSource)
      .toMatchObject({ contextsTruncated: true });
  });

  it("rejects imported media count overflow reported by the collector", async () => {
    const conditions = Array.from(
      { length: INSPECT_LIMITS.mediaConditions },
      (_, index) => `(min-width: ${index + 1}px)`,
    );
    const importedUrl = "http://localhost:4173/imported.css";
    const collected = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:4173/",
        styleSheets: [{
          href: "/dist/app.css",
          cssRules: [collectorMediaRules(conditions, {
            href: importedUrl,
            media: { mediaText: "print" },
            styleSheet: {
              href: importedUrl,
              cssRules: [collectorStyleRule()],
            },
          })],
        }],
      },
    );
    const text = mediaCss(conditions, ".card { color: red; }");

    const result = await resolveCss(
      text,
      selection([collectedTarget(collected.facts)], collected.ruleEvidence),
    );

    expect(result.matches).toEqual([]);
    expect(collected.ruleEvidence.rules[0]?.generatedSource)
      .toMatchObject({ contextsTruncated: true });
  });

  it("filters media evidence and returns parse diagnostics without stale ranges", async () => {
    const plugin = new CssSourcePlugin();
    const text = [
      ".card { color: red; }",
      "@media (min-width: 40rem) { .card { color: blue; } }",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.value = "blue";
    primaryCorrelatedCssRule(target).contexts = [{
      kind: "media",
      conditionText: "(min-width: 40rem)",
    }];
    const first = await resolveCss(text, selection([target]), undefined, plugin);

    expect(snippets(text, first.matches)).toEqual([
      ".card { color: blue; }",
    ]);

    const malformed = await resolveCss(
      ".card { color: red;",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      undefined,
      plugin,
      2,
    );
    expect(malformed.matches).toEqual([]);
    expect(malformed.diagnostics?.map((entry) => entry.code)).toEqual([
      "css.parseFailed",
    ]);
  });
});

type Resolution = Awaited<ReturnType<SourceWorkspace["resolveSourceUri"]>>;
type ResolutionFixture = Resolution | SourceWorkspace["resolveSourceUri"];

async function resolveCss(
  text: string,
  selected: SelectionSnapshot,
  resolution: ResolutionFixture = {
    uris: ["file:///workspace/dist/app.css"],
    status: "exact",
    strategy: "automatic",
  },
  plugin = new CssSourcePlugin(),
  version = 1,
  signal = new AbortController().signal,
) {
  const sourceDocument = document(text, version);
  return plugin.resolve({
    selection: selected,
    document: sourceDocument,
    workspace: workspace(resolution),
    signal,
  });
}

async function resolvePath(
  text: string,
  path: string,
  selector = ".duplicate",
) {
  const target = cssTarget("selected", selector, "/dist/app.css");
  primaryCorrelatedCssRule(target).rulePath = path;
  return resolveCss(text, selection([target]));
}

function selection(
  targets: readonly CorrelatedCssTargetFixture[],
): SelectionSnapshot;
function selection(
  targets: readonly InspectTarget[],
  ruleEvidence: InspectRuleEvidenceBatch,
): SelectionSnapshot;
function selection(
  targets: readonly (InspectTarget | CorrelatedCssTargetFixture)[],
  ruleEvidence?: InspectRuleEvidenceBatch,
): SelectionSnapshot {
  const correlated = ruleEvidence === undefined
    ? projectCorrelatedCssFixtures(targets.filter(isCorrelatedCssFixture))
    : {
        targets: targets.map((target) => isCorrelatedCssFixture(target)
          ? projectCorrelatedCssFixtures([target]).targets[0]!
          : target),
        ruleEvidence,
      };
  if (
    ruleEvidence === undefined &&
    correlated.targets.length !== targets.length
  ) {
    throw new Error("CSS fixture selection requires correlated v7 targets");
  }
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets: correlated.targets,
    ruleEvidence: correlated.ruleEvidence,
    context: { url: "http://localhost:4173/page", metadata: {} },
    metadata: {},
  };
}

function isCorrelatedCssFixture(
  target: InspectTarget | CorrelatedCssTargetFixture,
): target is CorrelatedCssTargetFixture {
  return "correlatedRules" in target;
}

function withRulePath(
  evidence: InspectRuleEvidenceBatch,
  rulePath: string,
): InspectRuleEvidenceBatch {
  return {
    ...evidence,
    rules: evidence.rules.map((rule) => ({
      ...rule,
      ...(rule.generatedSource
        ? {
            generatedSource: {
              ...rule.generatedSource,
              rulePath,
            },
          }
        : {}),
    })),
  };
}

function cssTarget(
  role: "selected" | "parent",
  selector: string,
  sourceUrl: string,
  source?: {
    readonly line: number;
    readonly column: number;
  },
): CorrelatedCssTargetFixture {
  return createCorrelatedCssTarget(role, selector, {
    sourceUrl,
    rulePath: "0.99",
    startLine: source?.line,
    startColumn: source?.column,
  });
}

function completeCssTarget(
  selector: string,
  options: {
    readonly rulePath?: string;
    readonly media?: readonly string[];
    readonly mediaTruncated?: boolean;
    readonly valueTruncated?: boolean;
    readonly important?: boolean;
    readonly unsupportedGroupContext?: boolean;
  } = {},
): CorrelatedCssTargetFixture {
  const target = createCorrelatedCssTarget("selected", selector, {
    sourceUrl: "/dist/app.css",
    rulePath: options.rulePath ?? "0.99",
    contexts: (options.media ?? []).map((conditionText) => ({
      kind: "media" as const,
      conditionText,
    })),
    contextsTruncated: options.mediaTruncated,
    unsupportedGroupContext: options.unsupportedGroupContext,
    declarations: [{
      property: "color",
      value: "red",
      important: options.important,
      valueTruncated: options.valueTruncated,
    }],
  });
  return target;
}

function cssTargetWithDeclarations(
  role: "selected" | "parent",
  selector: string,
  sourceUrl: string,
  declarations: readonly (readonly [string, string])[],
): CorrelatedCssTargetFixture {
  return createCorrelatedCssTarget(role, selector, {
    sourceUrl,
    rulePath: "0.99",
    declarations: declarations.map(([property, value]) => ({ property, value })),
  });
}

function collectedTarget(
  facts: readonly CssRuleFact[],
): InspectTarget {
  return {
    role: "selected",
    depth: 0,
    subject: { selector: ".card", metadata: {} },
    facts,
    metadata: {},
  };
}

function collectorStyleRule(
  selector = ".card",
  property = "color",
  value = "red",
) {
  return {
    selectorText: selector,
    style: {
      length: 1,
      item: () => property,
      getPropertyValue: () => value,
      getPropertyPriority: () => "",
    },
  };
}

function collectorMediaRules(
  conditions: readonly string[],
  leaf: unknown,
): unknown {
  return conditions.reduceRight<unknown>((nested, condition) => ({
    conditionText: condition,
    media: { mediaText: condition },
    cssRules: [nested],
  }), leaf);
}

function mediaCss(conditions: readonly string[], rule: string): string {
  return conditions.reduceRight(
    (nested, condition) => `@media ${condition} { ${nested} }`,
    rule,
  );
}

function cssResolutionFact(
  selector: string,
  property: string,
  value: string,
  sourceUrl: string,
  rulePath: string,
): CssResolutionFact {
  const canonicalSourceUrl = canonicalizePublicStylesheetUrl(sourceUrl, {
    baseUrl: "http://localhost:4173/page",
  });
  if (!canonicalSourceUrl) throw new Error("Invalid CSS resolution fixture URL");
  return {
    type: "css-rule",
    ruleRef: `resolution-fixture-${rulePath}`,
    selector,
    property,
    value,
    important: false,
    valueTruncated: false,
    metadata: {
      sourceUrl: canonicalSourceUrl,
      media: [],
      mediaTruncated: false,
      rulePath,
    },
  };
}

function document(
  text: string,
  version: number,
  uri = "file:///workspace/dist/app.css",
): SourceDocument {
  const lines = text.split("\n");
  return {
    uri,
    languageId: "css",
    version,
    getText: () => text,
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(offset, text.length));
      const before = text.slice(0, clamped).split("\n");
      return {
        line: before.length - 1,
        character: before.at(-1)?.length ?? 0,
      };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      const before = lines
        .slice(0, line)
        .reduce((total, value) => total + value.length + 1, 0);
      return before + Math.max(
        0,
        Math.min(position.character, lines[line]?.length ?? 0),
      );
    },
  };
}

function workspace(resolution: ResolutionFixture): SourceWorkspace {
  return {
    findFiles: async () => typeof resolution === "function"
      ? []
      : resolution.uris,
    readText: async () => "",
    resolveSourceUri: async (sourceUrl, baseUrl) =>
      typeof resolution === "function"
        ? resolution(sourceUrl, baseUrl)
        : resolution,
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function snippets(
  text: string,
  matches: readonly { readonly range: SourceMatchRange }[],
): string[] {
  const sourceDocument = document(text, 1);
  return matches.map((match) =>
    text.slice(
      sourceDocument.offsetAt(match.range.start),
      sourceDocument.offsetAt(match.range.end),
    ),
  );
}

interface SourceMatchRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}
