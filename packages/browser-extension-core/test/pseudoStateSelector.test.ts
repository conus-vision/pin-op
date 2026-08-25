import selectorParser from "postcss-selector-parser";
import { describe, expect, it } from "vitest";
import {
  PSEUDO_STATE_SELECTOR_LIMITS,
  transformPseudoStateSelector,
  type PseudoStateMarkerNames,
  type SelectorTransformResult,
} from "../src/pseudoStateSelector.js";

const MARKERS: PseudoStateMarkerNames = Object.freeze({
  selection: "data-pin-op-preview-selected-abcdefghijkl",
  hover: "data-pin-op-preview-hover-abcdefghijkl",
  focus: "data-pin-op-preview-focus-abcdefghijkl",
});

describe("transformPseudoStateSelector", () => {
  it.each([
    [
      ".button:hover",
      ".button[data-pin-op-preview-hover-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
    [
      "input:focus",
      "input[data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
    [
      ".button:hover:focus",
      ".button[data-pin-op-preview-hover-abcdefghijkl][data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
    [
      ":is(.button:hover, a)",
      ":is(.button[data-pin-op-preview-hover-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
    [
      ":where(.button:focus)",
      ":where(.button[data-pin-op-preview-focus-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
  ])("transforms the supported selector %s", (selectorText, expected) => {
    expectSupported(selectorText, expected);
  });

  it("emits only supported selector-list and functional branches", () => {
    expect(transformPseudoStateSelector(
      "a, .button:hover, :is(input:focus, a), .parent:hover .selected",
      MARKERS,
    )).toEqual({
      kind: "supported",
      selectorText: [
        ".button[data-pin-op-preview-hover-abcdefghijkl]",
        ":is(input[data-pin-op-preview-focus-abcdefghijkl])",
      ].map((selector) => (
        `${selector}:where([data-pin-op-preview-selected-abcdefghijkl])`
      )).join(","),
      transformedBranches: 2,
      omittedBranches: 3,
    });
  });

  it("preserves escaped text, strings, non-target pseudos, and pseudo-elements", () => {
    expectSupported(
      String.raw`.button\:primary[data-label=":hover"]:\63 hecked:hover:focus-visible:focus-within::before`,
      String.raw`.button\:primary[data-label=":hover"]:\63 hecked[data-pin-op-preview-hover-abcdefghijkl]:focus-visible:focus-within:where([data-pin-op-preview-selected-abcdefghijkl])::before`,
    );
  });

  it.each([
    [
      String.raw`.button:\68 over`,
      ".button[data-pin-op-preview-hover-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
    [
      String.raw`.button:h\6f ver:focus`,
      ".button[data-pin-op-preview-hover-abcdefghijkl][data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])",
    ],
  ])("transforms semantically escaped target pseudos in %s", (selectorText, expected) => {
    expectSupported(selectorText, expected);
  });

  it("does not treat non-CSS whitespace as a hex-escape terminator", () => {
    expectSupported(
      String.raw`.button:\68${"\u00a0"}over:focus`,
      String.raw`.button:\68${"\u00a0"}over[data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])`,
    );
  });

  it("handles nested positive functions deterministically", () => {
    const compact = transformPseudoStateSelector(
      ":where(:is(.button:hover, a), .fallback)",
      MARKERS,
    );
    const spaced = transformPseudoStateSelector(
      "  :where( :is( .button:hover , a ) , .fallback )  ",
      MARKERS,
    );

    expect(compact).toEqual({
      kind: "supported",
      selectorText: ":where(:is(.button[data-pin-op-preview-hover-abcdefghijkl])):where([data-pin-op-preview-selected-abcdefghijkl])",
      transformedBranches: 1,
      omittedBranches: 2,
    });
    expect(spaced).toEqual(compact);
  });

  it("preserves specificity for every supported transformation", () => {
    const cases = [
      ".button:hover",
      "input:focus",
      ".button:hover:focus",
      ":is(.button:hover, a)",
      ":where(.button:focus)",
      ".button:hover:focus-visible::before",
      "main > :is(#submit:hover, button:hover)",
    ];

    for (const selectorText of cases) {
      const transformed = supported(transformPseudoStateSelector(selectorText, MARKERS));
      expect(independentSpecificity(transformed.selectorText), selectorText)
        .toEqual(independentSpecificity(selectorText));
    }
  });

  it.each([
    [":is(.button:hover, #fallback)", "specificity-change"],
    [":is(:where(.button:hover), a)", "specificity-change"],
    [":not(:hover)", "target-under-negation"],
    [".button:hover:not(:focus)", "target-under-negation"],
    [":has(:hover)", "target-inside-has"],
    [".parent:hover .selected", "unsupported-target-position"],
    [".parent:hover > .selected:focus", "multiple-target-compounds"],
    [".button::before:hover", "unsafe-selector"],
    [".button::part(label):hover", "unsafe-selector"],
    [".host::before > .child:hover", "unsafe-selector"],
    [".host::before .child:hover", "unsafe-selector"],
    [".host::before + .child:hover", "unsafe-selector"],
    [".button:hover::before.extra", "unsafe-selector"],
    [".button:focus-visible:focus-within", "no-target-pseudo"],
    [".button:hover:nth-child(2n of .item:focus)", "unsupported-functional-target"],
    ["> .button:hover", "unsafe-selector"],
    [".button:hover >", "unsafe-selector"],
    [".parent > + .button:hover", "unsafe-selector"],
    [".parent >> .button:hover", "unsafe-selector"],
    [".button:hover,]", "malformed-selector"],
  ] as const)("fails closed for unsupported selector %s", (selectorText, reason) => {
    expect(transformPseudoStateSelector(selectorText, MARKERS)).toEqual({
      kind: "unsupported",
      reason,
    });
  });

  it("omits structurally unsafe nested positive branches", () => {
    expect(transformPseudoStateSelector(
      ":where(> .unsafe:hover, .safe:hover, .trailing:hover >)",
      MARKERS,
    )).toEqual({
      kind: "supported",
      selectorText: ":where(.safe[data-pin-op-preview-hover-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])",
      transformedBranches: 1,
      omittedBranches: 2,
    });
    expect(transformPseudoStateSelector(
      ":is(> .unsafe:hover)",
      MARKERS,
    )).toEqual({ kind: "unsupported", reason: "unsafe-selector" });
    expect(transformPseudoStateSelector(
      ":where(.host::before > .child:hover, .safe:hover)",
      MARKERS,
    )).toEqual({
      kind: "supported",
      selectorText: ":where(.safe[data-pin-op-preview-hover-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])",
      transformedBranches: 1,
      omittedBranches: 1,
    });
    expect(transformPseudoStateSelector(
      ":where(.host::before + .child:hover)",
      MARKERS,
    )).toEqual({ kind: "unsupported", reason: "unsafe-selector" });
  });

  it("keeps a selected subject target before a terminal pseudo-element", () => {
    expectSupported(
      ".button:hover::before",
      ".button[data-pin-op-preview-hover-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])::before",
    );
  });

  it.each([
    ".layout .button:hover",
    ".layout > .button:hover",
    ".layout + .button:hover",
    ".layout ~ .button:hover",
    ".layout || .button:hover",
  ])("keeps a valid standard combinator in %s", (selectorText) => {
    const result = supported(transformPseudoStateSelector(selectorText, MARKERS));
    expect(result.selectorText).toContain(
      ".button[data-pin-op-preview-hover-abcdefghijkl]",
    );
  });

  it("enforces UTF-8 byte, selector-branch, and functional-depth limits", () => {
    expect(transformPseudoStateSelector(
      `${"é".repeat(PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes / 2)}:hover`,
      MARKERS,
    )).toEqual({ kind: "unsupported", reason: "selector-byte-limit" });

    const branches = Array.from(
      { length: PSEUDO_STATE_SELECTOR_LIMITS.branches + 1 },
      (_, index) => `.branch-${index}:hover`,
    ).join(",");
    expect(transformPseudoStateSelector(branches, MARKERS)).toEqual({
      kind: "unsupported",
      reason: "selector-branch-limit",
    });

    const depth = PSEUDO_STATE_SELECTOR_LIMITS.functionalDepth + 1;
    const nested = `${":where(".repeat(depth)}.button:hover${")".repeat(depth)}`;
    expect(transformPseudoStateSelector(nested, MARKERS)).toEqual({
      kind: "unsupported",
      reason: "selector-depth-limit",
    });
  });

  it("enforces the UTF-8 byte limit again after marker expansion", () => {
    const maximalMarkers = {
      selection: `data-pin-op-preview-selected-${"a".repeat(55)}`,
      hover: `data-pin-op-preview-hover-${"b".repeat(58)}`,
      focus: `data-pin-op-preview-focus-${"c".repeat(58)}`,
    } satisfies PseudoStateMarkerNames;
    const compactInput = Array.from(
      { length: 100 },
      (_, index) => `.b${index}:hover`,
    ).join(",");
    expect(new TextEncoder().encode(compactInput).byteLength)
      .toBeLessThan(PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes);

    expect(transformPseudoStateSelector(compactInput, maximalMarkers)).toEqual({
      kind: "unsupported",
      reason: "selector-byte-limit",
    });
  });

  it.each([
    { ...MARKERS, selection: "data-pin-op-preview-short" },
    { ...MARKERS, hover: "data-pin-op-preview-HOVER-abcdefghijkl" },
    { ...MARKERS, focus: `data-pin-op-preview-${"a".repeat(65)}` },
    { ...MARKERS, focus: "data-pin-op-preview-focus_abcdefghijkl" },
  ])("validates every injected marker name against the exact grammar", (markers) => {
    expect(transformPseudoStateSelector(".button:hover", markers)).toEqual({
      kind: "unsupported",
      reason: "invalid-marker-name",
    });
  });

  it.each([
    { ...MARKERS, selection: MARKERS.hover },
    { ...MARKERS, hover: MARKERS.focus },
    { ...MARKERS, focus: MARKERS.selection },
  ])("rejects repeated marker names", (markers) => {
    expect(transformPseudoStateSelector(".button:hover", markers)).toEqual({
      kind: "unsupported",
      reason: "invalid-marker-name",
    });
  });

  it("fails closed when a hostile marker proxy throws", () => {
    const markers = new Proxy(MARKERS, {
      get() {
        throw new Error("page-controlled getter");
      },
    });

    expect(() => transformPseudoStateSelector(".button:hover", markers))
      .not.toThrow();
    expect(transformPseudoStateSelector(".button:hover", markers)).toEqual({
      kind: "unsupported",
      reason: "invalid-marker-name",
    });
  });

  it("guards every emitted selector so a matching non-selected element cannot match", () => {
    const result = supported(transformPseudoStateSelector(
      ".button:hover, :is(.button:hover, a), :where(.button:hover)",
      MARKERS,
    ));
    const selected = {
      classes: new Set(["button"]),
      attributes: new Set([MARKERS.hover, MARKERS.selection]),
    };
    const otherwiseMatchingSibling = {
      classes: new Set(["button"]),
      attributes: new Set([MARKERS.hover]),
    };

    for (const selectorText of splitSelectors(result.selectorText)) {
      expect(matchesSupportedOutput(selectorText, selected), selectorText).toBe(true);
      expect(
        matchesSupportedOutput(selectorText, otherwiseMatchingSibling),
        selectorText,
      ).toBe(false);
    }
  });
});

function expectSupported(selectorText: string, expected: string): void {
  expect(transformPseudoStateSelector(selectorText, MARKERS)).toEqual({
    kind: "supported",
    selectorText: expected,
    transformedBranches: 1,
    omittedBranches: selectorText.includes(":is(") ? 1 : 0,
  });
}

function supported(result: SelectorTransformResult): Extract<
  SelectorTransformResult,
  { readonly kind: "supported" }
> {
  expect(result.kind).toBe("supported");
  if (result.kind !== "supported") throw new Error(result.reason);
  return result;
}

type Specificity = readonly [number, number, number];

interface SpecificityNode {
  readonly type: string;
  readonly value?: string;
  readonly nodes?: readonly SpecificityNode[];
}

function independentSpecificity(selectorText: string): Specificity {
  const root = selectorParser().astSync(selectorText, { lossless: false });
  expect(root.nodes).toHaveLength(1);
  return countSpecificity(root.nodes[0]!.nodes as readonly SpecificityNode[]);
}

function countSpecificity(nodes: readonly SpecificityNode[]): Specificity {
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (const node of nodes) {
    if (node.type === "id") ids += 1;
    else if (node.type === "class" || node.type === "attribute") classes += 1;
    else if (node.type === "tag" || node.value?.startsWith("::")) types += 1;
    else if (node.type === "pseudo") {
      const value = node.value?.toLowerCase();
      if (value === ":where") continue;
      if (node.nodes && [":is", ":not", ":has"].includes(value ?? "")) {
        const nested = node.nodes.map((selector) => countSpecificity(
          selector.nodes ?? [],
        )).sort(compareSpecificity).at(-1) ?? [0, 0, 0];
        ids += nested[0];
        classes += nested[1];
        types += nested[2];
      } else if (!node.value?.startsWith("::")) {
        classes += 1;
      }
    }
  }
  return [ids, classes, types];
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function splitSelectors(selectorText: string): readonly string[] {
  return selectorParser().astSync(selectorText, { lossless: false }).nodes.map(String);
}

interface Matchable {
  readonly classes: ReadonlySet<string>;
  readonly attributes: ReadonlySet<string>;
}

interface MatchNode {
  readonly type: string;
  readonly value?: string;
  readonly attribute?: string;
  readonly nodes?: readonly MatchNode[];
}

function matchesSupportedOutput(selectorText: string, element: Matchable): boolean {
  const root = selectorParser().astSync(selectorText, { lossless: false });
  return root.nodes.some((selector) => matchesNodes(
    selector.nodes as readonly MatchNode[],
    element,
  ));
}

function matchesNodes(nodes: readonly MatchNode[], element: Matchable): boolean {
  return nodes.every((node) => {
    if (node.type === "class") return element.classes.has(node.value ?? "");
    if (node.type === "attribute") {
      return element.attributes.has(node.attribute ?? "");
    }
    if (node.type === "pseudo" && [":is", ":where"].includes(node.value ?? "")) {
      return node.nodes?.some((selector) => matchesNodes(
        selector.nodes ?? [],
        element,
      )) ?? false;
    }
    return node.type === "comment";
  });
}
