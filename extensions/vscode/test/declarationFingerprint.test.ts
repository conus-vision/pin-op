import { describe, expect, it } from "vitest";
import {
  completeDeclarationFingerprint,
  declarationEvidenceFromFact,
  declarationFingerprint,
  equalDeclarationFingerprints,
} from "../src/sourcePlugins/declarationFingerprint.js";
import type { CssResolutionFact } from "../src/sourcePlugins/cssFacts.js";
import type { CssDeclarationEvidence } from "../src/sourcePlugins/types.js";

describe("declarationFingerprint", () => {
  it("normalizes declaration order, whitespace, property casing, and priority", () => {
    const runtime: CssDeclarationEvidence[] = [
      {
        property: " DISPLAY ",
        value: "  grid  ",
        important: false,
      },
      {
        property: "Color",
        value: "rgb(1, 2, 3)  ! IMPORTANT",
      },
    ];
    const local: CssDeclarationEvidence[] = [
      {
        property: "color",
        value: "rgb(1,2,3)",
        important: true,
      },
      {
        property: "display",
        value: "grid",
        important: false,
      },
    ];

    expect(declarationFingerprint(runtime)).toEqual(
      declarationFingerprint(local),
    );
    expect(declarationFingerprint(runtime)).toEqual([
      {
        property: "color",
        value: "rgb(1,2,3)",
        important: true,
      },
      {
        property: "display",
        value: "grid",
        important: false,
      },
    ]);
  });

  it("preserves significant string whitespace while normalizing token spacing", () => {
    expect(declarationFingerprint([
      {
        property: "content",
        value: '"a  b"   /   "c d"',
        important: false,
      },
    ])).toEqual([
      {
        property: "content",
        value: '"a  b"/"c d"',
        important: false,
      },
    ]);
  });

  it("does not fold case-sensitive custom property names", () => {
    expect(declarationFingerprint([
      { property: "--Theme", value: "red" },
    ])).not.toEqual(declarationFingerprint([
      { property: "--theme", value: "red" },
    ]));
  });

  it.each([
    ["function whitespace", "url (x)", "url(x)"],
    ["slash whitespace", "alpha / beta", "alpha/beta"],
    ["colon whitespace", "theme : dark", "theme:dark"],
  ])("preserves custom-property %s", (_name, left, right) => {
    expect(declarationFingerprint([
      { property: "--payload", value: left, important: false },
    ])).not.toEqual(declarationFingerprint([
      { property: "--payload", value: right, important: false },
    ]));
  });

  it("preserves quoted and attribute-like custom-property content exactly", () => {
    const value = '  "[data-label = a:b]" / [kind : value]  ';

    expect(declarationFingerprint([
      { property: "--payload", value, important: false },
    ])).toEqual([{
      property: "--payload",
      value: '"[data-label = a:b]" / [kind : value]',
      important: false,
    }]);
  });

  it("uses only the correlated v7 priority and completion fields", () => {
    expect(declarationEvidenceFromFact(runtimeFact({
      important: true,
      metadata: { important: false, priority: "" },
    }))).toEqual({
      property: "color",
      value: "red",
      valueComplete: true,
      important: true,
    });
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: true,
      metadata: { valueTruncated: false },
    }))).toBeUndefined();
  });

  it("rejects an important suffix that conflicts with explicit false", () => {
    const conflicting = declarationEvidenceFromFact(runtimeFact(
      {
        valueTruncated: false,
        important: false,
      },
      "red !important",
    ));

    expect(conflicting).toEqual(expect.objectContaining({ important: false }));
    expect(declarationFingerprint([
      conflicting!,
      { property: "display", value: "grid", important: false },
    ])).toEqual([]);
  });

  it("accepts explicit true without a suffix and infers only absent priority", () => {
    expect(declarationFingerprint([
      { property: "color", value: "red", important: true },
    ])).toEqual([
      { property: "color", value: "red", important: true },
    ]);
    expect(declarationFingerprint([
      { property: "color", value: "red !important" },
    ])).toEqual([
      { property: "color", value: "red", important: true },
    ]);
  });

  it("distinguishes a complete exact fingerprint from invalid or partial evidence", () => {
    const exact = completeDeclarationFingerprint([
      { property: "color", value: "red", important: true },
      { property: "display", value: "grid", important: false },
    ]);

    expect(exact).toBeDefined();
    expect(equalDeclarationFingerprints(exact!, declarationFingerprint([
      { property: "display", value: "grid" },
      { property: "color", value: "red", important: true },
    ]))).toBe(true);
    expect(equalDeclarationFingerprints(exact!, declarationFingerprint([
      { property: "display", value: "grid" },
      { property: "color", value: "red", important: false },
    ]))).toBe(false);
    expect(completeDeclarationFingerprint([
      { property: "color", value: "red", valueComplete: false },
    ])).toBeUndefined();
    expect(completeDeclarationFingerprint([
      { property: "color", value: "red" },
      { property: "color", value: "blue" },
    ])).toBeUndefined();
    expect(completeDeclarationFingerprint([])).toEqual([]);
  });

});

function runtimeFact(
  overrides: Partial<Pick<
    CssResolutionFact,
    "important" | "valueTruncated" | "metadata"
  >>,
  value = "red",
): CssResolutionFact {
  return {
    type: "css-rule",
    ruleRef: "runtime-rule",
    selector: ".card",
    property: "color",
    value,
    important: overrides.important ?? false,
    valueTruncated: overrides.valueTruncated ?? false,
    metadata: overrides.metadata ?? {},
  };
}
