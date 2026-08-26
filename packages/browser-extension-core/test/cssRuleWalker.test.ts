import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  utf8ByteLength,
} from "@pin-op/protocol";
import {
  createCssRuleWalkBudget,
  walkCssRules,
  type CssDocumentSource,
  type CssRuleWalkRecord,
} from "../src/cssRuleWalker.js";
import { PinOpRuntimeArtifacts } from "../src/pinOpRuntimeArtifacts.js";

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
    expect(ruleWalk.status.truncated).toBe(true);
    expect(ruleWalk.status.reasons).toContain("css-rules-limit");
    expect(Object.isFrozen(ruleWalk.status.reasons)).toBe(true);

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

    expect(bounded.records).toHaveLength(
      INSPECT_LIMITS.declarationsPerRule,
    );
    expect(bounded.records[0]?.contexts).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(bounded.records[0]?.media).toHaveLength(
      INSPECT_LIMITS.mediaConditions,
    );
    expect(bounded.records[0]?.contextsTruncated).toBe(true);
    expect(bounded.records[0]?.mediaTruncated).toBe(true);
    expect(bounded.status.reasons).toEqual(expect.arrayContaining([
      "declarations-per-rule-limit",
      "context-limit",
    ]));
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
    expect(result.status.reasons).toContain("stylesheets-limit");
  });

  it("charges retained context bytes before they can be copied or evaluated", () => {
    const context = "x".repeat(INSPECT_LIMITS.valueLength);
    const importedUrl = "https://example.test/context-import.css";
    const inlineUrl = "inline-style://document/0";
    const selector = ".target";
    const property = "color";
    const cases = [
      {
        label: "media",
        urls: [inlineUrl],
        root: (child: object) => sheet(null, [group("CSSMediaRule", context, child)]),
      },
      {
        label: "supports",
        urls: [inlineUrl],
        root: (child: object) => sheet(null, [group("CSSSupportsRule", context, child)]),
      },
      {
        label: "layer",
        urls: [inlineUrl],
        root: (child: object) => sheet(null, [group("CSSLayerBlockRule", context, child)]),
      },
      {
        label: "scope",
        urls: [inlineUrl],
        root: (child: object) => sheet(null, [group("CSSScopeRule", context, child)]),
      },
      {
        label: "container",
        urls: [inlineUrl],
        root: (child: object) => sheet(null, [group("CSSContainerRule", context, child)]),
      },
      {
        label: "import-media",
        urls: [inlineUrl, importedUrl],
        root(child: object) {
          const imported = sheet(importedUrl, [child]);
          return sheet(null, [importRule(importedUrl, imported, context)]);
        },
      },
    ];

    for (const testCase of cases) {
      const urlBytes = testCase.urls.reduce(
        (total, value) => total + utf8ByteLength(value),
        0,
      );
      const contextBytes = utf8ByteLength(context);
      let matchReads = 0;
      let observerReads = 0;
      let reservationReads = 0;
      let valueReads = 0;
      const child = {
        selectorText: selector,
        style: {
          length: 1,
          item: () => property,
          getPropertyPriority: () => "",
          getPropertyValue() {
            valueReads += 1;
            return "red";
          },
        },
      };
      const budget = createCssRuleWalkBudget();
      budget.remainingBytes = urlBytes + contextBytes - 1;
      const walk = walkCssRules(
        {
          matches() {
            matchReads += 1;
            return true;
          },
        },
        {
          pageUrl: "https://example.test/page",
          styleSheets: [testCase.root(child)],
        },
        {
          workBudget: budget,
          referenceRule() {
            reservationReads += 1;
            return "rule-context";
          },
          onMatchedRule() {
            observerReads += 1;
          },
        },
      );
      const records = [...walk.records];

      expect(
        { matchReads, observerReads, reservationReads, valueReads, records },
        testCase.label,
      ).toEqual({
        matchReads: 0,
        observerReads: 0,
        reservationReads: 0,
        valueReads: 0,
        records: [],
      });
      expect(walk.status.reasons, testCase.label).toContain("byte-limit");
    }
  });

  it("marks matched-rule declarations truncated when bytes expire mid-rule", () => {
    const sourceUrl = "https://example.test/app.css";
    const selector = ".target";
    const properties = ["color", "background"];
    const firstValue = "red";
    const budget = createCssRuleWalkBudget();
    budget.remainingBytes = [
      sourceUrl,
      selector,
      ...properties,
      firstValue,
    ].reduce((total, value) => total + utf8ByteLength(value), 0);
    let matchedRule: { readonly declarationsTruncated: boolean } | undefined;
    const walk = walkCssRules(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [sheet(sourceUrl, [{
          selectorText: selector,
          style: {
            length: properties.length,
            item: (index: number) => properties[index] ?? "",
            getPropertyPriority: () => "",
            getPropertyValue: (property: string) =>
              property === properties[0] ? firstValue : "blue",
          },
        }])],
      },
      {
        workBudget: budget,
        referenceRule: () => "rule-mid-byte",
        onMatchedRule: (rule) => matchedRule = rule,
      },
    );

    expect([...walk.records].map(({ property }) => property)).toEqual(["color"]);
    expect(matchedRule).toMatchObject({
      ruleRef: "rule-mid-byte",
      declarationsTruncated: true,
    });
    expect(walk.status.reasons).toContain("byte-limit");
  });

  it("charges dropped nested, branching, and import context getter reads once", () => {
    const context = "x".repeat(INSPECT_LIMITS.valueLength);
    const contextReadsBeforeStop = INSPECT_LIMITS.mediaConditions + 1;
    const contextBytes = utf8ByteLength(context);
    const inlineUrl = "inline-style://document/0";
    const constructors = [
      "CSSMediaRule",
      "CSSSupportsRule",
      "CSSLayerBlockRule",
      "CSSScopeRule",
      "CSSContainerRule",
    ] as const;

    let nestedContextReads = 0;
    let nestedChildReads = 0;
    let nested: object = styleRule(".nested-leaf", { color: "red" });
    for (let index = INSPECT_LIMITS.mediaConditions + 1; index >= 0; index -= 1) {
      const child = nested;
      const constructorName = constructors[index % constructors.length]!;
      const rule: Record<string, unknown> = {
        constructor: { name: constructorName },
      };
      Object.defineProperty(
        rule,
        constructorName === "CSSLayerBlockRule" ? "name" : "conditionText",
        {
          get() {
            nestedContextReads += 1;
            return context;
          },
        },
      );
      if (constructorName === "CSSMediaRule") {
        rule.media = { mediaText: context };
      }
      Object.defineProperty(rule, "cssRules", {
        get() {
          nestedChildReads += 1;
          return [child];
        },
      });
      nested = rule;
    }
    const nestedBudget = createCssRuleWalkBudget();
    nestedBudget.remainingBytes = utf8ByteLength(inlineUrl) +
      contextReadsBeforeStop * contextBytes;
    const nestedWalk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets: [sheet(null, [nested])] },
      { workBudget: nestedBudget },
    );
    expect([...nestedWalk.records]).toHaveLength(0);
    expect({ nestedContextReads, nestedChildReads }).toEqual({
      nestedContextReads: contextReadsBeforeStop,
      nestedChildReads: INSPECT_LIMITS.mediaConditions,
    });
    expect(nestedWalk.status.reasons).toContain("byte-limit");

    let branchContextReads = 0;
    let branchChildReads = 0;
    const branches = Array.from(
      { length: INSPECT_LIMITS.mediaConditions + 2 },
      () => {
        const rule: Record<string, unknown> = {
          constructor: { name: "CSSSupportsRule" },
        };
        Object.defineProperty(rule, "conditionText", {
          get() {
            branchContextReads += 1;
            return context;
          },
        });
        Object.defineProperty(rule, "cssRules", {
          get() {
            branchChildReads += 1;
            return [];
          },
        });
        return rule;
      },
    );
    const branchBudget = createCssRuleWalkBudget();
    branchBudget.remainingBytes = utf8ByteLength(inlineUrl) +
      contextReadsBeforeStop * contextBytes;
    const branchWalk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets: [sheet(null, branches)] },
      { workBudget: branchBudget },
    );
    expect([...branchWalk.records]).toHaveLength(0);
    expect({ branchContextReads, branchChildReads }).toEqual({
      branchContextReads: contextReadsBeforeStop,
      branchChildReads: INSPECT_LIMITS.mediaConditions,
    });
    expect(branchWalk.status.reasons).toContain("byte-limit");

    let importContextReads = 0;
    let importChildReads = 0;
    const importUrls = Array.from(
      { length: INSPECT_LIMITS.mediaConditions + 2 },
      (_, index) => `https://example.test/context-${index}.css`,
    );
    const importedSheets: Array<{
      readonly href: string;
      readonly cssRules: readonly object[];
    }> = [];
    const instrumentedImport = (index: number) => ({
      href: importUrls[index]!,
      styleSheet: importedSheets[index]!,
      media: {
        get mediaText() {
          importContextReads += 1;
          return context;
        },
      },
    });
    for (let index = 0; index < importUrls.length; index += 1) {
      importedSheets.push({
        href: importUrls[index]!,
        get cssRules() {
          importChildReads += 1;
          return index + 1 < importUrls.length
            ? [instrumentedImport(index + 1)]
            : [];
        },
      });
    }
    const importBudget = createCssRuleWalkBudget();
    importBudget.remainingBytes = utf8ByteLength(inlineUrl) +
      importUrls.slice(0, contextReadsBeforeStop).reduce(
        (total, value) => total + utf8ByteLength(value),
        0,
      ) + contextReadsBeforeStop * contextBytes;
    const importWalk = walkCssRules(
      { matches: () => true },
      {
        pageUrl: "https://example.test/page",
        styleSheets: [sheet(null, [instrumentedImport(0)])],
      },
      { workBudget: importBudget },
    );
    expect([...importWalk.records]).toHaveLength(0);
    expect({ importContextReads, importChildReads }).toEqual({
      importContextReads: contextReadsBeforeStop,
      importChildReads: INSPECT_LIMITS.mediaConditions,
    });
    expect(importWalk.status.reasons).toContain("byte-limit");
  });

  it("excludes exact runtime stylesheets at roots and imports without spending walk authority", () => {
    const ownedRoot = sheet("https://example.test/runtime-root.css", [
      styleRule(".runtime-root", { color: "red" }),
    ]);
    const ownedImport = sheet("https://example.test/runtime-import.css", [
      styleRule(".runtime-import", { color: "blue" }),
    ]);
    const author = sheet("https://example.test/author.css", [
      importRule(ownedImport.href!, ownedImport),
      styleRule(".author", { color: "green" }),
    ]);
    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test", styleSheets: [ownedRoot, author] },
      { isRuntimeStylesheet: (candidate) => candidate === ownedRoot || candidate === ownedImport },
    );

    expect([...walk.records].map(({ selector }) => selector)).toEqual([".author"]);
    expect(walk.inaccessibleStylesheets).toEqual([]);
    expect(walk.status.truncated).toBe(false);
  });

  it("excludes a replacement sheet owned by an exact historical runtime style node", () => {
    const artifacts = new PinOpRuntimeArtifacts({
      getRandomValues(bytes) {
        bytes.fill(7);
        return bytes;
      },
    });
    const style = { sheet: undefined as object | undefined };
    const first = Object.assign(sheet(null, []), { ownerNode: style });
    style.sheet = first;
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);
    const replacement = Object.assign(sheet(null, [
      styleRule(".runtime", { color: "red" }),
    ]), { ownerNode: style });
    style.sheet = replacement;
    const author = sheet(null, [styleRule(".author", { color: "green" })]);

    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test", styleSheets: [replacement, author] },
      { isRuntimeStylesheet: (candidate) => artifacts.isRuntimeStylesheet(candidate) },
    );

    expect([...walk.records].map(({ selector }) => selector)).toEqual([".author"]);
    expect(walk.status.truncated).toBe(false);
  });

  it("fails closed with explicit status when runtime stylesheet classification throws", () => {
    const author = sheet("https://example.test/author.css", [
      styleRule(".author", { color: "green" }),
    ]);
    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test", styleSheets: [author] },
      {
        isRuntimeStylesheet() {
          throw new Error("runtime ownership unavailable");
        },
      },
    );

    expect([...walk.records]).toEqual([]);
    expect(walk.status).toMatchObject({
      truncated: true,
      reasons: expect.arrayContaining(["runtime-artifact-exclusion-failed"]),
    });
    expect(walk.inaccessibleStylesheets).toContainEqual(expect.objectContaining({
      code: "browser.stylesheetInaccessible",
      reason: expect.stringContaining("runtime ownership unavailable"),
    }));
  });

  it("reports partial authority when runtime ownership cannot read sheet.ownerNode", () => {
    const artifacts = new PinOpRuntimeArtifacts({
      getRandomValues(bytes) {
        bytes.fill(8);
        return bytes;
      },
    });
    const author = sheet("https://example.test/author.css", [
      styleRule(".author", { color: "green" }),
    ]);
    Object.defineProperty(author, "ownerNode", {
      get() {
        throw new Error("owner identity unavailable");
      },
    });

    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test", styleSheets: [author] },
      { isRuntimeStylesheet: (candidate) => artifacts.isRuntimeStylesheet(candidate) },
    );

    expect([...walk.records]).toEqual([]);
    expect(walk.status).toMatchObject({
      truncated: true,
      reasons: expect.arrayContaining(["runtime-artifact-exclusion-failed"]),
    });
    expect(walk.inaccessibleStylesheets).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining("owner identity unavailable"),
    }));
  });

  it("keeps author root identity stable when an exact runtime root is present", () => {
    const runtime = sheet(null, [styleRule(".runtime", { color: "red" })]);
    const author = sheet(null, [styleRule(".author", { color: "green" })]);
    const collect = (styleSheets: readonly ReturnType<typeof sheet>[]) => {
      const walk = walkCssRules(
        { matches: () => true },
        { pageUrl: "https://example.test/page", styleSheets },
        { isRuntimeStylesheet: (candidate) => candidate === runtime },
      );
      return [...walk.records].map((record) => ({
        sourceUrl: record.sourceUrl,
        rulePath: record.rulePath,
        stylesheetIdentity: record.stylesheetIdentity,
      }));
    };

    expect(collect([runtime, author])).toEqual(collect([author]));
  });

  it("resolves an own exact runtime import at the author stylesheet boundary", () => {
    const runtime = sheet("https://example.test/runtime.css", [
      styleRule(".runtime", { color: "red" }),
    ]);
    const authorImport = sheet("https://example.test/imported.css", []);
    const runtimeImport = Object.create({
      get styleSheet() {
        return runtime;
      },
    }) as ReturnType<typeof importRule>;
    Object.assign(runtimeImport, { href: runtime.href });
    const root = sheet("https://example.test/root.css", [
      importRule(authorImport.href!, authorImport),
      runtimeImport,
    ]);
    const workBudget = createCssRuleWalkBudget();
    workBudget.remainingStylesheets = 2;
    let runtimePredicateReads = 0;
    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets: [root] },
      {
        workBudget,
        isRuntimeStylesheet(candidate) {
          if (candidate === runtime) runtimePredicateReads += 1;
          return candidate === runtime;
        },
      },
    );

    expect([...walk.records]).toEqual([]);
    expect(runtimePredicateReads).toBe(1);
    expect(walk.inaccessibleStylesheets).toEqual([]);
    expect(walk.status.truncated).toBe(false);
  });

  it("fails closed when the separate raw runtime-root scan cap is exhausted", () => {
    const runtime = sheet(null, []);
    const styleSheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets * 2 + 1 },
      () => runtime,
    );
    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets },
      { isRuntimeStylesheet: (candidate) => candidate === runtime },
    );

    expect([...walk.records]).toEqual([]);
    expect(walk.status.reasons).toContain("stylesheets-limit");
  });

  it("closes the boundary after one non-runtime import probe", () => {
    const authorImport = sheet("https://example.test/imported.css", []);
    let boundaryReads = 0;
    const throwingBoundaryImport = () => Object.create({
      get styleSheet(): never {
        boundaryReads += 1;
        throw new Error("blocked");
      },
    });
    const root = sheet("https://example.test/root.css", [
      importRule(authorImport.href!, authorImport),
      throwingBoundaryImport(),
      throwingBoundaryImport(),
    ]);
    const workBudget = createCssRuleWalkBudget();
    workBudget.remainingStylesheets = 2;
    const walk = walkCssRules(
      { matches: () => true },
      { pageUrl: "https://example.test/page", styleSheets: [root] },
      { workBudget, isRuntimeStylesheet: () => false },
    );

    expect([...walk.records]).toEqual([]);
    expect(boundaryReads).toBe(1);
    expect(walk.status.reasons).toContain("stylesheets-limit");
  });
});

function collectRecords(document: CssDocumentSource): {
  records: CssRuleWalkRecord[];
  inaccessibleStylesheets: readonly unknown[];
  status: ReturnType<typeof walkCssRules>["status"];
} {
  const walk = walkCssRules({ matches: () => true }, document);
  return {
    records: [...walk.records],
    inaccessibleStylesheets: walk.inaccessibleStylesheets,
    status: walk.status,
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
