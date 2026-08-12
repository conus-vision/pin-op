import { describe, expect, it } from "vitest";
import type { CssRuleFact } from "@pinop/protocol";
import {
  declarationEvidenceFromFact,
  declarationFingerprint,
} from "../src/sourcePlugins/declarationFingerprint.js";
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

  it("uses exact legacy priority metadata when boolean evidence is absent", () => {
    const fact: CssRuleFact = {
      type: "css-rule",
      selector: ".card",
      property: "color",
      value: "red",
      metadata: { priority: "important", valueTruncated: false },
    };

    expect(declarationFingerprint([
      declarationEvidenceFromFact(fact)!,
    ])).toEqual([
      { property: "color", value: "red", important: true },
    ]);
  });

  it("rejects runtime declarations without completion or priority evidence", () => {
    expect(declarationEvidenceFromFact(runtimeFact({
      important: false,
    }))).toBeUndefined();
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
    }))).toBeUndefined();
  });

  it("accepts only exact legacy priority and rejects conflicts", () => {
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      priority: "",
    }))).toEqual(expect.objectContaining({ important: false }));
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      priority: "important",
    }))).toEqual(expect.objectContaining({ important: true }));
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      priority: " IMPORTANT ",
    }))).toBeUndefined();
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      priority: "urgent",
    }))).toBeUndefined();
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      important: false,
      priority: "important",
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

  it("rejects an important suffix conflicting with legacy empty priority", () => {
    const conflicting = declarationEvidenceFromFact(runtimeFact(
      {
        valueTruncated: false,
        priority: "",
      },
      "red !important",
    ));

    expect(conflicting).toEqual(expect.objectContaining({ important: false }));
    expect(declarationFingerprint([conflicting!])).toEqual([]);
    expect(declarationEvidenceFromFact(runtimeFact({
      valueTruncated: false,
      priority: "unknown",
    }))).toBeUndefined();
  });
});

function runtimeFact(
  metadata: Record<string, unknown>,
  value = "red",
): CssRuleFact {
  return {
    type: "css-rule",
    selector: ".card",
    property: "color",
    value,
    metadata: { sourceUrl: "/dist/app.css", ...metadata },
  };
}
