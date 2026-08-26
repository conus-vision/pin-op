import {
  INSPECT_LIMITS,
  RULE_EVIDENCE_LIMITS,
  utf8ByteLength,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { MatchedStylesCollector } from "../src/matchedStylesCollector.js";
import { projectMatchedStylesToCssFacts } from "../src/matchedStylesProjection.js";
import { INSPECT_COLLECTION_MAX_BYTES } from "../src/inspectBounds.js";
import type { StyleDeclarationSource } from "../src/cssRuleWalker.js";
import type {
  MatchedStylesCollectionAuthority,
  MatchedStylesCollectorOptions,
  MatchedStylesStylesheetAuthority,
} from "../src/matchedStylesCollector.js";
import type {
  StylesheetRegistryEntry,
  StylesheetRegistrySnapshot,
} from "../src/stylesheetRegistry.js";
import type { PseudoStateMarkerNames } from "../src/pseudoStateSelector.js";

const AUTHORITY = Object.freeze({
  documentEpoch: 7,
  selectionRevision: 11,
  stylesRevision: 13,
  stylesheetRevision: 5,
  pseudoStateRevision: 0,
  pseudoStates: Object.freeze([]),
  nodeRef: "node-selected",
});

const PREVIEW_MARKERS: PseudoStateMarkerNames = Object.freeze({
  selection: "data-pin-op-preview-selected-abcdefghijklmnop",
  hover: "data-pin-op-preview-hover-abcdefghijklmnop",
  focus: "data-pin-op-preview-focus-abcdefghijklmnop",
});

describe("MatchedStylesCollector", () => {
  it("returns one fixed, deeply frozen authority shape for inline and matched rules", () => {
    const scope = documentScope();
    const selected = element(scope, {
      matches: new Set([".card", ".featured", "article"]),
      inline: declaration({ color: "purple", "--theme": "night" }),
    });
    const sheet = stylesheet("https://example.test/a.css", [
      styleRule("article, .card, .featured", {
        color: "red",
        display: "block",
      }),
      styleRule("#never, .card", { color: "blue !important" }),
    ]);
    const stylesheets = stylesheetAuthority(scope, [sheet]);
    const matchedCollector = collector(selected, stylesheets);

    const result = matchedCollector.collect(AUTHORITY)!;

    expect(result).toMatchObject({
      ...AUTHORITY,
      inline: {
        selectorText: "element.style",
        matchingSelectorIndices: [],
        declarations: [
          expect.objectContaining({ property: "color", value: "purple" }),
          expect.objectContaining({
            property: "--theme",
            state: "unknown",
            reason: "custom-property-cascade",
          }),
        ],
      },
      rules: [
        {
          ruleRef: expect.stringMatching(/^rule-/),
          selectorText: "article, .card, .featured",
          matchingSelectorIndices: [0, 1, 2],
          declarations: [
            expect.objectContaining({
              property: "color",
              state: "overridden-known-author",
            }),
            expect.objectContaining({
              property: "display",
              state: "winning-known-author",
            }),
          ],
          contexts: [],
          source: {
            sourceUrl: "https://example.test/a.css",
            rulePath: "0.0",
          },
        },
        {
          ruleRef: expect.stringMatching(/^rule-/),
          selectorText: "#never, .card",
          matchingSelectorIndices: [1],
          declarations: [expect.objectContaining({
            property: "color",
            value: "blue",
            important: true,
            state: "winning-known-author",
          })],
          contexts: [],
          source: {
            sourceUrl: "https://example.test/a.css",
            rulePath: "0.1",
          },
        },
      ],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      partial: false,
      diagnostics: [],
    });
    expect(result.rules[0]!.ruleRef).not.toBe(result.rules[1]!.ruleRef);
    expect(result.rules[0]!.declarations.every(
      (declaration) => declaration.ruleRef === result.rules[0]!.ruleRef,
    )).toBe(true);
    expectDeepFrozen(result);
  });

  it("retains ordered nested/import contexts, inactive conditions, and duplicate rules", () => {
    const scope = documentScope({
      media: new Map([["print", false], ["screen", true]]),
      supports: new Map([
        ["(display: grid)", true],
        ["(display: subgrid)", false],
      ]),
    });
    const selected = element(scope, { matches: new Set([".card"]) });
    const imported = stylesheet("https://example.test/imported.css", [
      supportsRule("(display: grid)", [styleRule(".card", { display: "grid" })]),
    ]);
    const first = stylesheet("https://example.test/first.css", [
      importRule(imported, "screen"),
      mediaRule("print", [styleRule(".card", { color: "gray" })]),
      supportsRule("(display: subgrid)", [styleRule(".card", { opacity: "0.5" })]),
      styleRule(".card", { color: "red" }),
    ]);
    const second = stylesheet("https://example.test/second.css", [
      styleRule(".card", { color: "blue" }),
    ]);
    const result = collector(
      selected,
      stylesheetAuthority(scope, [first, second], [imported]),
    ).collect(AUTHORITY)!;

    expect(result.rules.map((rule) => [
      rule.selectorText,
      rule.contexts,
      rule.declarations[0]?.state,
    ])).toEqual([
      [".card", [
        { kind: "media", text: "screen" },
        { kind: "supports", text: "(display: grid)" },
      ], "winning-known-author"],
      [".card", [{ kind: "media", text: "print" }], "inactive"],
      [".card", [{ kind: "supports", text: "(display: subgrid)" }], "inactive"],
      [".card", [], "overridden-known-author"],
      [".card", [], "winning-known-author"],
    ]);
    expect(new Set(result.rules.map(({ ruleRef }) => ruleRef))).toHaveLength(5);
  });

  it("keeps identical rules in distinct supports contexts non-interchangeable", () => {
    const firstCondition = "(display: grid)";
    const secondCondition = "(display: inline-grid)";
    const scope = documentScope({
      supports: new Map([
        [firstCondition, true],
        [secondCondition, true],
      ]),
    });
    const selected = element(scope, { matches: new Set([".card"]) });
    const matched = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet("https://example.test/app.css", [
        supportsRule(firstCondition, [styleRule(".card", { color: "red" })]),
        supportsRule(secondCondition, [styleRule(".card", { color: "red" })]),
      ])]),
    ).collect(AUTHORITY)!;

    const projection = projectMatchedStylesToCssFacts(matched);
    const contextsByRef = new Map(projection.ruleEvidence.rules.map((rule) => [
      rule.ruleRef,
      rule.generatedSource?.contexts,
    ]));

    expect(projection.facts.map(({ ruleRef }) => ruleRef)).toEqual(
      matched.rules.map(({ ruleRef }) => ruleRef),
    );
    expect([...contextsByRef.values()]).toEqual([
      [{ kind: "supports", conditionText: firstCondition }],
      [{ kind: "supports", conditionText: secondCondition }],
    ]);
    expect(new Set(contextsByRef.keys())).toHaveLength(2);
  });

  it("collects inheritable declarations from at most 32 composed ancestors", () => {
    const scope = documentScope();
    let ancestor: ReturnType<typeof element> | null = null;
    for (let index = 34; index >= 1; index -= 1) {
      ancestor = element(scope, {
        matches: new Set([`.ancestor-${index}`]),
        parent: ancestor,
        tagName: `A${index}`,
      });
    }
    const selected = element(scope, {
      matches: new Set([".selected"]),
      parent: ancestor,
    });
    const rules = Array.from({ length: 34 }, (_, index) =>
      styleRule(`.ancestor-${index + 1}`, {
        color: `rgb(${index}, 0, 0)`,
        display: "block",
        "--ancestor": `${index}`,
      }));

    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, rules)]),
    ).collect(AUTHORITY)!;

    expect(result.inherited).toHaveLength(32);
    expect(result.inherited[0]?.ancestorIndex).toBe(1);
    expect(result.inherited[31]?.ancestorIndex).toBe(32);
    const inheritedDeclarations = result.inherited
      .flatMap(({ rules }) => rules)
      .flatMap(({ declarations }) => declarations);
    expect(inheritedDeclarations.map(({ property }) => property)).toContain("display");
    expect(inheritedDeclarations.every(({ state, reason }) =>
      state === "unknown" && reason === "inherited-author-declaration"))
      .toBe(true);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("ancestor-limit");
  });

  it("identifies the actual DOM parent within the composed ancestor authority", () => {
    const scope = documentScope();
    const lightDomParent = element(scope, {
      matches: new Set([".light-parent"]),
      tagName: "MAIN",
    });
    const slot = element(scope, {
      matches: new Set([".slot"]),
      tagName: "SLOT",
    });
    const rules = [
      styleRule(".light-parent", { color: "red" }),
      styleRule(".slot", { color: "blue" }),
    ];
    const stylesheets = stylesheetAuthority(scope, [stylesheet(null, rules)]);

    const direct = collector(
      element(scope, {
        matches: new Set([".selected"]),
        parent: lightDomParent,
      }),
      stylesheets,
    ).collect(AUTHORITY)!;
    const slotted = collector(
      element(scope, {
        matches: new Set([".selected"]),
        parent: lightDomParent,
        assignedSlot: slot,
      }),
      stylesheets,
    ).collect(AUTHORITY)!;

    expect(direct).toMatchObject({ domParentAncestorIndex: 1 });
    expect(slotted.inherited[0]).toMatchObject({
      ancestorIndex: 1,
      elementName: "slot",
    });
    expect(slotted).not.toHaveProperty("domParentAncestorIndex");
  });

  it("fails closed for exact scope, hostile selectors, unsupported groups, and partial inventory", () => {
    const selectedScope = documentScope();
    const otherScope = documentScope();
    const selected = element(selectedScope, {
      matches: new Set([
        ".card",
        ":host",
        "::slotted(.card)",
        ":is(.shell) > .card",
      ]),
      throwSelectors: new Set([":broken("]),
    });
    const selectedSheet = stylesheet(null, [
      styleRule(":broken(", { color: "red" }),
      styleRule(":host", { color: "green" }),
      styleRule("::slotted(.card)", { color: "yellow" }),
      {
        ...styleRule(".shell", {}),
        cssRules: [styleRule("& > .card", { color: "orange" })],
      },
      groupRule("CSSLayerBlockRule", "theme", [
        styleRule(".card", { color: "blue" }),
      ]),
      groupRule("CSSScopeRule", "(.shell)", [
        styleRule(".card", { border: "1px solid" }),
      ]),
      groupRule("CSSContainerRule", "card (width > 1px)", [
        styleRule(".card", { padding: "1px" }),
      ]),
    ]);
    const otherSheet = stylesheet(null, [styleRule(".card", { opacity: "0" })]);
    const stylesheets = stylesheetAuthority(selectedScope, [selectedSheet]);
    const selectedEntries = stylesheets.snapshot().entries;
    stylesheets.snapshot = () => snapshot([
      ...selectedEntries,
      entry(otherScope, otherSheet, 1, "root-1"),
    ], {
      inaccessibleStylesheetCount: 2,
      partial: true,
      diagnostics: [{ code: "rules-visited-limit" }],
    });

    const result = collector(selected, stylesheets).collect(AUTHORITY)!;

    expect(result.rules.flatMap(({ declarations }) => declarations.map(({ property }) => property)))
      .not.toContain("opacity");
    expect(result.rules.map(({ declarations }) => declarations[0]?.reason)).toEqual([
      "unsupported-selector-specificity",
      "unsupported-selector-specificity",
      "unsupported-selector-specificity",
      "unsupported-cascade-layer",
      "unsupported-cascade-scope",
      "unsupported-container-query",
    ]);
    expect(result.inaccessibleStylesheetCount).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("selector-unavailable");
    expect(result.diagnostics).toContain("rules-visited-limit");
  });

  it("rejects stale document/revision/selection authority before publication", () => {
    const scope = documentScope();
    const selected = element(scope, { matches: new Set([".card"]) });
    const stylesheets = stylesheetAuthority(scope, [
      stylesheet(null, [styleRule(".card", { color: "red" })]),
    ]);
    let current = true;
    const matched = collector(selected, stylesheets, () => current);
    expect(matched.collect({ ...AUTHORITY, documentEpoch: 6 })).toBeUndefined();
    expect(matched.collect({ ...AUTHORITY, stylesRevision: 12 })).toBeUndefined();
    current = false;
    expect(matched.collect(AUTHORITY)).toBeUndefined();
  });

  it("rechecks authority after publishing applicability candidates", () => {
    const scope = documentScope();
    const selected = element(scope, { matches: new Set([".card"]) });
    const stylesheets = stylesheetAuthority(scope, [
      stylesheet(null, [styleRule(".card", { color: "red" })]),
    ]);
    let current = true;
    let candidateCount = 0;
    const matched = collector(
      selected,
      stylesheets,
      () => current,
      (_authority, candidates) => {
        candidateCount = candidates.length;
        current = false;
      },
    );

    expect(matched.collect(AUTHORITY)).toBeUndefined();
    expect(candidateCount).toBe(1);
  });

  it("fails closed when the applicability candidate callback throws", () => {
    const scope = documentScope();
    const selected = element(scope, { matches: new Set([".card"]) });
    const callbackError = new Error("applicability callback failed");
    const matched = collector(
      selected,
      stylesheetAuthority(scope, [
        stylesheet(null, [styleRule(".card", { color: "red" })]),
      ]),
      () => true,
      () => { throw callbackError; },
    );

    expect(() => matched.collect(AUTHORITY)).toThrow(callbackError);
  });

  it("reads ownerless sheet disabled/media applicability hostile-safely on every collection", () => {
    const scope = documentScope({
      media: new Map([["print", false], ["screen", true]]),
    });
    const selected = element(scope, { matches: new Set([".card"]) });
    const disabled = Object.assign(
      stylesheet(null, [styleRule(".card", { color: "red" })]),
      { disabled: true, media: { mediaText: "" } },
    );
    const mutableMedia = Object.assign(
      stylesheet(null, [styleRule(".card", { opacity: "0.5" })]),
      { disabled: false, media: { mediaText: "print" } },
    );
    const hostileMedia = Object.assign(
      stylesheet(null, [styleRule(".card", { "z-index": "2" })]),
      { disabled: false },
    );
    Object.defineProperty(hostileMedia, "media", {
      get(): never {
        throw new Error("hostile media getter");
      },
    });
    const authority = stylesheetAuthority(
      scope,
      [disabled, mutableMedia, hostileMedia],
      [],
      "adopted",
    );
    const matched = collector(selected, authority);

    expect(matched.collect(AUTHORITY)!.rules.map(
      ({ declarations }) => declarations[0]?.state,
    )).toEqual(["inactive", "inactive", "unknown"]);

    disabled.disabled = false;
    mutableMedia.media.mediaText = "screen";
    expect(matched.collect(AUTHORITY)!.rules.map(
      ({ declarations }) => declarations[0]?.state,
    )).toEqual(["winning-known-author", "winning-known-author", "unknown"]);
  });

  it("keeps the full Rules model while truncating only inspect evidence", () => {
    const scope = documentScope();
    const selected = element(scope, { matches: new Set([".card"]) });
    const rules = [styleRule(
      ".card",
      Object.fromEntries(Array.from(
        { length: INSPECT_LIMITS.declarationsPerRule + 1 },
        (_, declarationIndex) => [
          `--property-${declarationIndex}`,
          `${declarationIndex}`,
        ],
      )),
    )];

    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, rules)]),
    ).collect(AUTHORITY)!;
    const projection = projectMatchedStylesToCssFacts(result);

    expect(result.rules[0]?.declarations).toHaveLength(
      INSPECT_LIMITS.declarationsPerRule,
    );
    expect(result.rules[0]?.declarationsTruncated).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("declarations-per-rule-limit");
    expect(projection.facts).toHaveLength(
      RULE_EVIDENCE_LIMITS.declarationsPerRule,
    );
    expect(projection.ruleEvidence.rules[0]?.declarations).toHaveLength(
      RULE_EVIDENCE_LIMITS.declarationsPerRule,
    );
    expect(projection.ruleEvidence.rules[0]?.declarationsTruncated).toBe(true);
  });

  it("detects unsupported :host and ::slotted rules across actual roots", () => {
    const document = documentScope();
    const shadow = shadowScope(document);
    const hostElement = element(document, {
      matches: new Set(),
      shadowRoot: shadow,
      tagName: "PIN-HOST",
    });
    shadow.host = hostElement;
    const slot = element(shadow, { matches: new Set(), tagName: "SLOT" });
    const assigned = element(document, {
      matches: new Set([".light"]),
      assignedSlot: slot,
      tagName: "SPAN",
    });
    const shadowSheet = stylesheet(null, [
      styleRule(":host", { color: "red" }),
      styleRule("::slotted(.light)", { color: "blue" }),
    ]);
    const authority = multiScopeStylesheetAuthority([
      { scope: document, roots: [] },
      { scope: shadow, roots: [shadowSheet] },
    ]);

    const hostResult = collector(hostElement, authority).collect(AUTHORITY)!;
    expect(hostResult.rules).toEqual([]);
    expect(hostResult.partial).toBe(true);
    expect(hostResult.diagnostics).toContain("unsupported-host-selector-scope");

    const assignedResult = collector(assigned, authority).collect(AUTHORITY)!;
    expect(assignedResult.rules).toEqual([]);
    expect(assignedResult.partial).toBe(true);
    expect(assignedResult.diagnostics).toContain("unsupported-slotted-selector-scope");
  });

  it("includes ancestor inline declarations with one shared inline ruleRef", () => {
    const scope = documentScope();
    const parent = element(scope, {
      matches: new Set(),
      inline: declaration({ color: "red", "--x": "y" }),
      tagName: "PARENT",
    });
    const selected = element(scope, {
      matches: new Set(),
      parent,
      tagName: "CHILD",
    });

    const result = collector(
      selected,
      stylesheetAuthority(scope, []),
    ).collect(AUTHORITY)!;

    expect(result.inherited).toHaveLength(1);
    const inline = result.inherited[0]!.rules[0]!;
    expect(inline.selectorText).toBe("element.style");
    expect(inline.declarations.map(({ property, value, state }) =>
      [property, value, state])).toEqual([
      ["color", "red", "unknown"],
      ["--x", "y", "unknown"],
    ]);
    expect(inline.declarations.every(({ ruleRef }) => ruleRef === inline.ruleRef))
      .toBe(true);
  });

  it("retains unclassified ancestor declarations conservatively as unknown", () => {
    const scope = documentScope();
    const parent = element(scope, {
      matches: new Set([".parent"]),
      tagName: "PARENT",
    });
    const selected = element(scope, { matches: new Set(), parent });
    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, [styleRule(".parent", {
        font: "16px sans-serif",
        "list-style": "disc inside",
        "pointer-events": "auto",
        "font-variation-settings": '"wght" 600',
      })])]),
    ).collect(AUTHORITY)!;

    const declarations = result.inherited[0]!.rules[0]!.declarations;
    expect(declarations.map(({ property }) => property)).toEqual([
      "font",
      "list-style",
      "pointer-events",
      "font-variation-settings",
    ]);
    expect(declarations.every(({ state, reason }) =>
      state === "unknown" && reason === "inherited-author-declaration"))
      .toBe(true);
  });

  it("shares one declaration work budget across all 33 elements", () => {
    const scope = documentScope();
    let parent: ReturnType<typeof element> | null = null;
    for (let index = 0; index < 32; index += 1) {
      parent = element(scope, { matches: new Set([".shared"]), parent });
    }
    const selected = element(scope, { matches: new Set([".shared"]), parent });
    const value = "v";
    const names = Array.from({ length: 16 }, (_, index) => `--budget-${index}`);
    let itemReads = 0;
    let valueReads = 0;
    const boundedStyle: StyleDeclarationSource = {
      length: names.length,
      item(index) {
        itemReads += 1;
        return names[index] ?? "";
      },
      getPropertyValue() {
        valueReads += 1;
        return value;
      },
      getPropertyPriority: () => "",
    };
    const nativeRule = {
      selectorText: ".shared",
      cssText: ".shared { --budget: value }",
      style: boundedStyle,
    };

    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, [nativeRule])]),
    ).collect(AUTHORITY)!;
    const declarations = [
      ...result.rules.flatMap(({ declarations }) => declarations),
      ...result.inherited.flatMap(({ rules }) =>
        rules.flatMap(({ declarations }) => declarations)),
    ];

    expect(declarations.length).toBeLessThanOrEqual(INSPECT_LIMITS.factsPerTarget);
    expect(itemReads).toBeLessThanOrEqual(INSPECT_LIMITS.factsPerTarget);
    expect(valueReads).toBeLessThanOrEqual(INSPECT_LIMITS.factsPerTarget);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("facts-per-target-limit");
  });

  it("shares one byte work budget across all 33 elements", () => {
    const scope = documentScope();
    let parent: ReturnType<typeof element> | null = null;
    for (let index = 0; index < 32; index += 1) {
      parent = element(scope, { matches: new Set([".shared"]), parent });
    }
    const selected = element(scope, { matches: new Set([".shared"]), parent });
    const value = "v".repeat(INSPECT_LIMITS.valueLength);
    const names = Array.from({ length: 16 }, (_, index) => `--byte-${index}`);
    let valueReads = 0;
    const boundedStyle: StyleDeclarationSource = {
      length: names.length,
      item: (index) => names[index] ?? "",
      getPropertyValue() {
        valueReads += 1;
        return value;
      },
      getPropertyPriority: () => "",
    };

    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, [{
        selectorText: ".shared",
        cssText: ".shared { --byte: value }",
        style: boundedStyle,
      }])]),
    ).collect(AUTHORITY)!;

    expect(valueReads * value.length).toBeLessThanOrEqual(
      INSPECT_COLLECTION_MAX_BYTES + value.length,
    );
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("byte-limit");
  });

  it("shares one rule work budget across all 33 elements", () => {
    const scope = documentScope();
    let matchReads = 0;
    let parent: ReturnType<typeof element> | null = null;
    for (let index = 0; index < 32; index += 1) {
      parent = element(scope, {
        matches: new Set(),
        onMatch: () => matchReads += 1,
        parent,
      });
    }
    const selected = element(scope, {
      matches: new Set(),
      onMatch: () => matchReads += 1,
      parent,
    });
    const rules = Array.from({ length: 128 }, (_, index) =>
      styleRule(`.never-${index}`, { color: "red" }));

    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(null, rules)]),
    ).collect(AUTHORITY)!;

    expect(matchReads).toBeLessThanOrEqual(INSPECT_LIMITS.cssRules);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("css-rules-limit");
  });

  it("marks oversized and hostile inline declaration scans partial", () => {
    const scope = documentScope();
    const names = Array.from(
      { length: INSPECT_LIMITS.declarationsPerRule + 1 },
      (_, index) => `--inline-${index}`,
    );
    const oversized: StyleDeclarationSource = {
      length: names.length,
      item: (index) => names[index] ?? "",
      getPropertyValue: () => "x",
      getPropertyPriority: () => "",
    };
    const oversizedResult = collector(
      element(scope, { matches: new Set(), inline: oversized }),
      stylesheetAuthority(scope, []),
    ).collect(AUTHORITY)!;
    expect(oversizedResult.inline?.declarations).toHaveLength(
      INSPECT_LIMITS.declarationsPerRule,
    );
    expect(oversizedResult.partial).toBe(true);
    expect(oversizedResult.diagnostics).toContain("declarations-per-rule-limit");

    const hostile: StyleDeclarationSource = {
      length: 3,
      item(index) {
        if (index === 1) throw new Error("hostile indexed read");
        return index === 0 ? "color" : "display";
      },
      getPropertyValue: () => "red",
      getPropertyPriority: () => "",
    };
    const hostileResult = collector(
      element(scope, { matches: new Set(), inline: hostile }),
      stylesheetAuthority(scope, []),
    ).collect(AUTHORITY)!;
    expect(hostileResult.inline?.declarations.map(({ property }) => property))
      .toEqual(["color", "display"]);
    expect(hostileResult.partial).toBe(true);
    expect(hostileResult.diagnostics).toContain("inline-declaration-unavailable");
  });

  it("does not touch ancestor inline style after the byte authority is exhausted", () => {
    const scope = documentScope();
    let styleReads = 0;
    let lengthReads = 0;
    let itemReads = 0;
    let inlineReservations = 0;
    const ancestorStyle: StyleDeclarationSource = {
      get length() {
        lengthReads += 1;
        return 1;
      },
      item() {
        itemReads += 1;
        return "color";
      },
      getPropertyValue: () => "red",
      getPropertyPriority: () => "",
    };
    const parent = element(scope, { matches: new Set() });
    Object.defineProperty(parent, "style", {
      get() {
        styleReads += 1;
        return ancestorStyle;
      },
    });
    const selected = element(scope, {
      matches: new Set([".selected"]),
      parent,
    });
    const selector = ".selected";
    const property = "--fill";
    const fixedBytes = [
      "inline-style://document/0",
      selector,
      property,
    ].reduce((total, value) => total + utf8ByteLength(value), 0);
    const fill = "v".repeat(INSPECT_COLLECTION_MAX_BYTES - fixedBytes);
    const baseAuthority = stylesheetAuthority(scope, [stylesheet(null, [{
      selectorText: selector,
      cssText: `${selector} { ${property}: ... }`,
      style: declaration({ [property]: fill }),
    }])]);
    const authority: MatchedStylesStylesheetAuthority = {
      ...baseAuthority,
      referenceInlineRule(native) {
        inlineReservations += 1;
        return baseAuthority.referenceInlineRule(native);
      },
    };

    const result = collector(selected, authority).collect(AUTHORITY)!;

    expect({ styleReads, lengthReads, itemReads, inlineReservations }).toEqual({
      styleReads: 0,
      lengthReads: 0,
      itemReads: 0,
      inlineReservations: 0,
    });
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("byte-limit");
  });

  it("reports a throwing element.style getter as partial", () => {
    const scope = documentScope();
    const selected = element(scope, { matches: new Set() });
    Object.defineProperty(selected, "style", {
      get(): never {
        throw new Error("hostile style getter");
      },
    });

    const result = collector(
      selected,
      stylesheetAuthority(scope, []),
    ).collect(AUTHORITY)!;

    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("inline-declaration-unavailable");
  });

  it("excludes only the exact runtime stylesheet from Rules and inspect evidence", () => {
    const scope = documentScope();
    const selected = element(scope, {
      matches: new Set([".author", ".runtime"]),
    });
    const authorSheet = stylesheet("https://example.test/author.css", [
      styleRule(".author", { color: "green" }),
    ]);
    const runtimeSheet = stylesheet("https://example.test/runtime.css", [
      styleRule(".runtime", { background: "black" }),
    ]);
    const result = collector(
      selected,
      stylesheetAuthority(scope, [authorSheet, runtimeSheet]),
      () => true,
      undefined,
      (sheet) => sheet === runtimeSheet,
    ).collect(AUTHORITY)!;
    const projection = projectMatchedStylesToCssFacts(result);

    expect(result.rules.map(({ selectorText }) => selectorText)).toEqual([
      ".author",
    ]);
    expect(projection.facts.map(({ property }) => property)).toEqual(["color"]);
    expect(projection.ruleEvidence.rules.map(({ selector }) => selector)).toEqual([
      ".author",
    ]);
  });

  it("matches supported preview selectors through shared markers while preserving original rule identity", () => {
    const scope = documentScope();
    const transformed = ".card[data-pin-op-preview-hover-abcdefghijklmnop]:where([data-pin-op-preview-selected-abcdefghijklmnop])";
    const selected = element(scope, {
      matches: new Set([transformed, ".always"]),
    });
    const supported = styleRule(".card:hover", { color: "red" });
    const unsupported = styleRule(".parent:hover .card", { color: "blue" });
    const mixed = styleRule(".never:hover, .always", { border: "0" });
    const stable = styleRule(".always", { display: "block" });
    const stylesheets = stylesheetAuthority(scope, [stylesheet(
      "https://example.test/preview.css",
      [supported, unsupported, mixed, stable],
    )]);
    const result = collector(
      selected,
      stylesheets,
      () => true,
      undefined,
      undefined,
      PREVIEW_MARKERS,
    ).collect(Object.freeze({
      ...AUTHORITY,
      pseudoStateRevision: 1,
      pseudoStates: Object.freeze(["hover"] as const),
    }))!;

    expect(result.rules.map(({ selectorText }) => selectorText)).toEqual([
      ".card:hover",
      ".never:hover, .always",
      ".always",
    ]);
    expect(result.rules[0]?.ruleRef).toBe(stylesheets.referenceRule(
      stylesheets.entriesForElement(selected as unknown as Element)[0]!,
      "0.0",
      supported,
    ));
    expect(result.rules.map(({ matchingSelectorIndices }) => matchingSelectorIndices))
      .toEqual([[0], [1], [0]]);
    expect(result.rules.some(({ selectorText }) => selectorText === ".parent:hover .card"))
      .toBe(false);
  });

  it("retains a native unaffected :is branch while hover preview is active", () => {
    const scope = documentScope();
    const selector = ":is(.button:hover, a)";
    const selected = element(scope, { matches: new Set([selector]) });
    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(
        "https://example.test/native-functional.css",
        [styleRule(selector, { color: "red" })],
      )]),
      () => true,
      undefined,
      undefined,
      PREVIEW_MARKERS,
    ).collect(Object.freeze({
      ...AUTHORITY,
      pseudoStateRevision: 1,
      pseudoStates: Object.freeze(["hover"] as const),
    }))!;

    expect(result.rules.map(({ selectorText }) => selectorText)).toEqual([selector]);
    expect(result.rules[0]?.matchingSelectorIndices).toEqual([0]);
  });

  it("retains a native negated pseudo match while marking emulation partial", () => {
    const scope = documentScope();
    const selector = ".card:not(:hover)";
    const selected = element(scope, { matches: new Set([selector]) });
    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(
        "https://example.test/native-negation.css",
        [styleRule(selector, { color: "red" })],
      )]),
      () => true,
      undefined,
      undefined,
      PREVIEW_MARKERS,
    ).collect(Object.freeze({
      ...AUTHORITY,
      pseudoStateRevision: 1,
      pseudoStates: Object.freeze(["hover"] as const),
    }))!;

    expect(result.rules.map(({ selectorText }) => selectorText)).toEqual([selector]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("unsupported-pseudo-state-selector");
  });

  it("retains an exact native ancestor-pseudo match", () => {
    const scope = documentScope();
    const selector = ".parent:hover .card";
    const selected = element(scope, { matches: new Set([selector]) });
    const result = collector(
      selected,
      stylesheetAuthority(scope, [stylesheet(
        "https://example.test/native-ancestor.css",
        [styleRule(selector, { color: "red" })],
      )]),
      () => true,
      undefined,
      undefined,
      PREVIEW_MARKERS,
    ).collect(Object.freeze({
      ...AUTHORITY,
      pseudoStateRevision: 1,
      pseudoStates: Object.freeze(["hover"] as const),
    }))!;

    expect(result.rules.map(({ selectorText }) => selectorText)).toEqual([selector]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContain("unsupported-pseudo-state-selector");
  });

  it("publishes bounded active-preview applicability semantics under the original rule identity", () => {
    const scope = documentScope();
    const selector = "input:hover:checked";
    const transformed = "input[data-pin-op-preview-hover-abcdefghijklmnop]:checked:where([data-pin-op-preview-selected-abcdefghijklmnop])";
    const selected = element(scope, { matches: new Set([transformed]) });
    const candidates: ApplicabilityCandidateCapture[] = [];
    const stylesheets = stylesheetAuthority(scope, [stylesheet(
      "https://example.test/applicability-preview.css",
      [styleRule(selector, { color: "red" })],
    )]);
    const result = collector(
      selected,
      stylesheets,
      () => true,
      (_authority, next) => candidates.push(...next),
      undefined,
      PREVIEW_MARKERS,
    ).collect(Object.freeze({
      ...AUTHORITY,
      pseudoStateRevision: 1,
      pseudoStates: Object.freeze(["hover"] as const),
    }))!;

    expect(candidates).toEqual([expect.objectContaining({
      key: result.rules[0]?.ruleRef,
      selectorText: selector,
      previewSelectorText: transformed,
    })]);
    expect(Object.isFrozen(candidates[0])).toBe(true);
  });
});

type ApplicabilityCandidateCapture = MatchedStylesCollectorOptions[
  "onApplicabilityCandidates"
] extends (...args: infer _Args) => void
  ? Parameters<NonNullable<MatchedStylesCollectorOptions["onApplicabilityCandidates"]>>[1][number] & {
      readonly previewSelectorText?: string;
    }
  : never;

function collector(
  selected: ReturnType<typeof element>,
  stylesheets: MatchedStylesStylesheetAuthority,
  isAuthorityCurrent: (authority: MatchedStylesCollectionAuthority) => boolean = () => true,
  onApplicabilityCandidates?: MatchedStylesCollectorOptions["onApplicabilityCandidates"],
  isRuntimeStylesheet?: (stylesheet: object) => boolean,
  pseudoStateMarkers?: PseudoStateMarkerNames,
) {
  return new MatchedStylesCollector({
    domTreeProvider: {
      resolveElement(nodeRef, documentEpoch) {
        return nodeRef === AUTHORITY.nodeRef && documentEpoch === AUTHORITY.documentEpoch
          ? {
            element: selected as unknown as Element,
            nodeRef,
            documentEpoch,
            frameRef: "frame-top",
            frameEpoch: 1,
          }
          : undefined;
      },
    },
    stylesheets,
    isAuthorityCurrent,
    onApplicabilityCandidates,
    ...(isRuntimeStylesheet ? { isRuntimeStylesheet } : {}),
    ...(pseudoStateMarkers ? { pseudoStateMarkers } : {}),
  });
}

function stylesheetAuthority(
  scope: ReturnType<typeof documentScope>,
  roots: ReturnType<typeof stylesheet>[],
  imports: ReturnType<typeof stylesheet>[] = [],
  rootKind: StylesheetRegistryEntry["kind"] = "external",
): MatchedStylesStylesheetAuthority & { snapshot: () => StylesheetRegistrySnapshot } {
  const entries = [
    ...roots.map((sheet, index) => entry(
      scope,
      sheet,
      index,
      `root-${index}`,
      rootKind,
    )),
    ...imports.map((sheet, index) => entry(
      scope,
      sheet,
      roots.length + index,
      `import-${index}`,
      "import",
    )),
  ];
  const refs = new WeakMap<object, string>();
  let nextRef = 0;
  const reference = (native: object) => {
    const existing = refs.get(native);
    if (existing) return existing;
    const value = `rule-${++nextRef}`;
    refs.set(native, value);
    return value;
  };
  return {
    snapshot: () => snapshot(entries),
    entriesForElement: (candidate) =>
      (candidate as unknown as { root: object }).root === scope ? entries : [],
    referenceRule: (_entry, _path, native) => reference(native),
    referenceInlineRule: (native) => reference(native),
  };
}

function multiScopeStylesheetAuthority(
  groups: readonly {
    scope: ReturnType<typeof documentScope> | ReturnType<typeof shadowScope>;
    roots: ReturnType<typeof stylesheet>[];
  }[],
): MatchedStylesStylesheetAuthority {
  const entries = groups.flatMap(({ scope, roots }, groupIndex) => roots.map(
    (sheet, index) => entry(scope, sheet, index, `g${groupIndex}-${index}`),
  ));
  const refs = new WeakMap<object, string>();
  let nextRef = 0;
  const reference = (native: object) => {
    const current = refs.get(native);
    if (current) return current;
    const created = `rule-${++nextRef}`;
    refs.set(native, created);
    return created;
  };
  return {
    snapshot: () => snapshot(entries),
    entriesForElement: (candidate) => {
      const root = (candidate as unknown as { root: object }).root;
      return entries.filter(({ scope }) => scope === root);
    },
    referenceRule: (_entry, _path, native) => reference(native),
    referenceInlineRule: (native) => reference(native),
  };
}

function snapshot(
  entries: StylesheetRegistryEntry[],
  overrides: Partial<StylesheetRegistrySnapshot> = {},
): StylesheetRegistrySnapshot {
  return {
    documentEpoch: AUTHORITY.documentEpoch,
    stylesheetRevision: AUTHORITY.stylesheetRevision,
    stylesRevision: AUTHORITY.stylesRevision,
    entries,
    uniqueSheetObjectCount: entries.length,
    inaccessibleStylesheetCount: 0,
    omittedScopeCount: 0,
    omittedScopeSheetPairCount: 0,
    partial: false,
    diagnostics: [],
    ...overrides,
  };
}

function entry(
  scope: object,
  sheet: ReturnType<typeof stylesheet>,
  sourceOrder: number,
  identity: string,
  kind: StylesheetRegistryEntry["kind"] = "external",
): StylesheetRegistryEntry {
  return {
    scope: scope as Document,
    scopeRef: "scope-test",
    scopeKind: "document",
    sheet: sheet as unknown as CSSStyleSheet,
    sheetRef: identity,
    sheetIdentity: identity,
    kind,
    sourceOrder,
    sourceUrl: sheet.href ?? undefined,
    rulePathPrefix: kind === "import" ? "0" : "",
    generatedRanges: {},
  };
}

function documentScope(options: {
  media?: Map<string, boolean>;
  supports?: Map<string, boolean>;
} = {}) {
  return {
    nodeType: 9,
    defaultView: {
      matchMedia: (query: string) => ({ matches: options.media?.get(query) ?? true }),
      CSS: { supports: (query: string) => options.supports?.get(query) ?? true },
    },
  };
}

function shadowScope(ownerDocument: ReturnType<typeof documentScope>) {
  return {
    nodeType: 11,
    mode: "open",
    ownerDocument,
    host: undefined as ReturnType<typeof element> | undefined,
  };
}

function element(
  root: object,
  options: {
    matches: Set<string>;
    onMatch?: (selector: string) => void;
    throwSelectors?: Set<string>;
    inline?: StyleDeclarationSource;
    parent?: ReturnType<typeof element> | null;
    tagName?: string;
    assignedSlot?: ReturnType<typeof element> | null;
    shadowRoot?: ReturnType<typeof shadowScope> | null;
  },
) {
  return {
    root,
    tagName: options.tagName ?? "ARTICLE",
    parentElement: options.parent ?? null,
    assignedSlot: options.assignedSlot ?? null,
    shadowRoot: options.shadowRoot ?? null,
    style: options.inline ?? declaration({}),
    getRootNode: () => root,
    matches(selector: string) {
      options.onMatch?.(selector);
      if (options.throwSelectors?.has(selector)) throw new Error("hostile matches");
      if (options.matches.has(selector)) return true;
      return selector.split(",").some((part) => options.matches.has(part.trim()));
    },
  };
}

function stylesheet(href: string | null, cssRules: object[]) {
  return { href, cssRules };
}

function styleRule(selectorText: string, values: Record<string, string>) {
  return {
    selectorText,
    cssText: `${selectorText} { ... }`,
    style: declaration(values),
  };
}

function declaration(values: Record<string, string>) {
  const entries = Object.entries(values).map(([property, raw]) => ({
    property,
    value: raw.replace(/\s*!important$/i, ""),
    priority: /\s*!important$/i.test(raw) ? "important" : "",
  }));
  return {
    length: entries.length,
    item: (index: number) => entries[index]?.property ?? "",
    getPropertyValue: (property: string) =>
      entries.find((entry) => entry.property === property)?.value ?? "",
    getPropertyPriority: (property: string) =>
      entries.find((entry) => entry.property === property)?.priority ?? "",
  };
}

function mediaRule(conditionText: string, cssRules: object[]) {
  return namedRule("CSSMediaRule", {
    conditionText,
    media: { mediaText: conditionText },
    cssText: `@media ${conditionText} {}`,
    cssRules,
  });
}

function supportsRule(conditionText: string, cssRules: object[]) {
  return namedRule("CSSSupportsRule", {
    type: 12,
    conditionText,
    cssText: `@supports ${conditionText} {}`,
    cssRules,
  });
}

function groupRule(name: string, conditionText: string, cssRules: object[]) {
  return namedRule(name, { conditionText, name: conditionText, cssText: `@x ${conditionText} {}`, cssRules });
}

function importRule(imported: ReturnType<typeof stylesheet>, media: string) {
  return {
    href: imported.href,
    styleSheet: imported,
    media: { mediaText: media },
    cssText: `@import ${imported.href}`,
  };
}

function namedRule(name: string, value: object) {
  return Object.assign(Object.create({ constructor: { name } }), value);
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested);
}
