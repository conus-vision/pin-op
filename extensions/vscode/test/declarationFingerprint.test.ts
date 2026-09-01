import { describe, expect, it } from "vitest";
import {
  completeDeclarationFingerprint,
  declarationEvidenceFromFact,
  declarationFingerprint,
  declarationsAfterInRuleCascade,
  declarationsBrowsersKeep,
  equalDeclarationFingerprints,
  equalReportedDeclarations,
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
        // Colours settle on one canonical spelling, whichever side wrote them.
        value: "rgb(1, 2, 3)",
        important: true,
      },
      {
        property: "display",
        value: "grid",
        important: false,
      },
    ]);
  });

  it("reads a quoted font family and its bare identifier as the same name", () => {
    // Blink drops the quotes the stylesheet wrote; Gecko keeps them. The rule
    // is the same rule either way, and a Chrome pick used to lose its origin
    // over exactly this.
    const declared: CssDeclarationEvidence[] = [{
      property: "font-family",
      value: '"gilroy-bold", Arial, Helvetica, sans-serif',
      important: false,
    }];
    const reported: CssDeclarationEvidence[] = [{
      property: "font-family",
      value: "gilroy-bold, Arial, Helvetica, sans-serif",
      important: false,
    }];

    expect(declarationFingerprint(reported)).toEqual(
      declarationFingerprint(declared),
    );
    expect(declarationFingerprint(declared)).toEqual([{
      property: "font-family",
      value: "gilroy-bold,Arial,Helvetica,sans-serif",
      important: false,
    }]);
  });

  it("keeps the quotes a font family name needs to keep its meaning", () => {
    const quotedValue = (value: string) => declarationFingerprint([{
      property: "font-family",
      value,
      important: false,
    }])[0]?.value;

    // A name that is not an identifier sequence cannot lose its quotes.
    expect(quotedValue('"2 Wide", Arial')).toBe('"2 Wide",Arial');
    expect(quotedValue('"Font, Inc.", Arial')).toBe('"Font, Inc.",Arial');
    // Quoted, these name a family; bare, they are generic or CSS-wide keywords.
    expect(quotedValue('"serif"')).toBe('"serif"');
    expect(quotedValue('"inherit"')).toBe('"inherit"');
    // Multi-word identifier sequences are still names a browser may unquote.
    expect(quotedValue('"Helvetica Neue", Arial')).toBe("Helvetica Neue,Arial");
    // Only font-family is read this way.
    expect(declarationFingerprint([{
      property: "content",
      value: '"gilroy-bold"',
      important: false,
    }])[0]?.value).toBe('"gilroy-bold"');
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


  it("reads a colour the same however either side spelled it", () => {
    const spellings = [
      "#0b57d0",
      "#0B57D0",
      "rgb(11, 87, 208)",
      "rgb(11 87 208)",
    ];
    const fingerprints = spellings.map((value) =>
      declarationFingerprint([{ property: "color", value }])
    );
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toEqual(fingerprints[0]);
    }
    expect(fingerprints[0]).toEqual([
      { property: "color", value: "rgb(11, 87, 208)", important: false },
    ]);
  });

  it("keeps a colour's alpha whichever syntax carried it", () => {
    const withAlpha = (value: string) =>
      declarationFingerprint([{ property: "color", value }]);

    expect(withAlpha("rgb(0 0 0 / 18%)")).toEqual(withAlpha("rgba(0, 0, 0, 0.18)"));
    expect(withAlpha("#0000002e")).toEqual(withAlpha("rgba(0, 0, 0, 0.18)"));
    expect(withAlpha("rgba(1, 2, 3, 1)")).toEqual(withAlpha("rgb(1, 2, 3)"));
  });

  it("reads a zero length as a zero, and leaves a zero percentage alone", () => {
    const value = (text: string) =>
      declarationFingerprint([{ property: "margin", value: text }])[0]?.value;

    expect(value("0")).toBe(value("0px"));
    expect(value("0 0 0.3em")).toBe(value("0px 0px 0.3em"));
    // A percentage resolves against the container; it is not a bare zero.
    expect(value("0%")).not.toBe(value("0px"));
  });

  it("reads the same number however it was written", () => {
    const value = (text: string) =>
      declarationFingerprint([{ property: "opacity", value: text }])[0]?.value;

    expect(value(".75")).toBe(value("0.75"));
    expect(value("1.0")).toBe(value("1"));
    expect(value("0.750")).toBe(value("0.75"));
  });

  it("reads a box shorthand as the sides it sets, however it is spelled", () => {
    const sides = (property: string, text: string) =>
      declarationFingerprint([{ property, value: text }]);

    expect(sides("padding", "2em 0")).toEqual(sides("padding", "2em 0 2em 0"));
    expect(sides("margin", "0 0 0.3em")).toEqual(sides("margin", "0 0 0.3em 0"));
    expect(sides("padding", "1px")).toEqual(sides("padding", "1px 1px 1px 1px"));
    expect(sides("gap", "10px")).toEqual(sides("gap", "10px 10px"));
    expect(sides("border-radius", "50% / 20%")).toEqual(
      sides("border-radius", "50% 50% 50% 50%/20% 20% 20% 20%"),
    );
    // Different sides stay different.
    expect(sides("padding", "1px 2px")).not.toEqual(sides("padding", "1px"));
    // A property whose values are not sides keeps its own spelling.
    expect(sides("font-family", "Arial Black")).toEqual([
      { property: "font-family", value: "Arial Black", important: false },
    ]);
    expect(sides("transition", "opacity 1s, transform 2s")).toEqual([
      { property: "transition", value: "opacity 1s,transform 2s", important: false },
    ]);
  });

  it("reads a shorthand and its written-out sides as the same rule", () => {
    expect(declarationFingerprint([
      { property: "inset", value: "0" },
      { property: "position", value: "absolute" },
    ])).toEqual(declarationFingerprint([
      { property: "position", value: "absolute" },
      { property: "top", value: "0" },
      { property: "right", value: "0" },
      { property: "bottom", value: "0" },
      { property: "left", value: "0" },
    ]));
    expect(declarationFingerprint([
      { property: "border-radius", value: "2.1em" },
    ])).toEqual(declarationFingerprint([
      { property: "border-top-left-radius", value: "2.1em" },
      { property: "border-top-right-radius", value: "2.1em" },
      { property: "border-bottom-right-radius", value: "2.1em" },
      { property: "border-bottom-left-radius", value: "2.1em" },
    ]));
    // A side the file overrides after the shorthand is the side that counts.
    expect(declarationFingerprint([
      { property: "margin", value: "0 auto" },
      { property: "margin-top", value: "1em" },
    ])).toEqual(declarationFingerprint([
      { property: "margin", value: "1em auto 0 auto" },
    ]));
    // An important side is not overridden by a later ordinary shorthand.
    expect(declarationFingerprint([
      { property: "margin-top", value: "1em", important: true },
      { property: "margin", value: "0" },
    ])).not.toEqual(declarationFingerprint([
      { property: "margin", value: "0" },
    ]));
  });

  it("reads a rule's repeated property the way the browser keeps it", () => {
    const winners = (
      declarations: readonly { property: string; value: string }[],
    ) =>
      declarationsAfterInRuleCascade(declarations)
        .map(({ property, value }) => `${property}:${value}`);

    expect(winners([
      { property: "width", value: "100%" },
      { property: "width", value: "90%" },
    ])).toEqual(["width:90%"]);
    expect(winners([
      { property: "color", value: "red !important" },
      { property: "color", value: "blue" },
    ])).toEqual(["color:red !important"]);
    expect(winners([
      { property: "color", value: "red" },
      { property: "color", value: "blue !important" },
    ])).toEqual(["color:blue !important"]);
    expect(winners([
      { property: "--Theme", value: "dark" },
      { property: "--theme", value: "light" },
    ])).toEqual(["--Theme:dark", "--theme:light"]);
  });

  it("reads a shadow by its offsets and colour, in either spelling", () => {
    const shadow = (text: string) =>
      declarationFingerprint([{ property: "box-shadow", value: text }])[0]
        ?.value;

    expect(shadow("rgba(0, 0, 0, 0.18) 0 0.75rem 2rem"))
      .toBe(shadow("0 0.75rem 2rem rgb(0 0 0 / 18%)"));
    expect(shadow("inset red 1px 2px")).toBe(shadow("inset 1px 2px red"));
    expect(shadow("red 1px 2px, blue 3px 4px"))
      .toBe(shadow("1px 2px red,3px 4px blue"));
    // Two shadows that differ by an offset stay different.
    expect(shadow("1px 2px red")).not.toBe(shadow("1px 3px red"));
    // A layer that is not a plain shadow keeps its own spelling.
    expect(shadow("none")).toBe("none");
  });

  it("reads a quoted name the same in either quote style", () => {
    const family = (text: string) =>
      declarationFingerprint([{ property: "font-family", value: text }])[0]
        ?.value;

    expect(family("'gilroy-bold', Arial")).toBe(family('"gilroy-bold", Arial'));
    // A name that needs no quotes settles on the bare identifier, which is
    // what Blink reports for it.
    expect(family("'gilroy-bold'")).toBe("gilroy-bold");
    // Text that would need escaping to requote keeps the quotes it was given.
    expect(family("'say \"hi\"'")).toBe("'say \"hi\"'");
  });

  it("keeps the space that follows a closing parenthesis", () => {
    expect(declarationFingerprint([
      { property: "transform", value: "translate(1px) scale(2)" },
    ])[0]?.value).toBe("translate(1px) scale(2)");
  });

  it("allows a file the prefixed declarations a browser discards", () => {
    const reported = declarationFingerprint([
      { property: "box-sizing", value: "border-box" },
      { property: "position", value: "relative" },
    ]);
    const declared = declarationFingerprint([
      { property: "-moz-box-sizing", value: "border-box" },
      { property: "-webkit-box-sizing", value: "border-box" },
      { property: "box-sizing", value: "border-box" },
      { property: "position", value: "relative" },
    ]);

    expect(equalReportedDeclarations(reported, declared)).toBe(true);
    // What the browser did report still has to match exactly.
    expect(equalReportedDeclarations(
      reported,
      declarationFingerprint([
        { property: "-moz-box-sizing", value: "border-box" },
        { property: "box-sizing", value: "content-box" },
        { property: "position", value: "relative" },
      ]),
    )).toBe(false);
    // An unprefixed declaration the browser never reported is a mismatch.
    expect(equalReportedDeclarations(
      reported,
      declarationFingerprint([
        { property: "box-sizing", value: "border-box" },
        { property: "position", value: "relative" },
        { property: "color", value: "red" },
      ]),
    )).toBe(false);
    // A prefixed property the browser did report must still match.
    expect(equalReportedDeclarations(
      declarationFingerprint([
        { property: "-webkit-box-sizing", value: "border-box" },
      ]),
      declarationFingerprint([
        { property: "-webkit-box-sizing", value: "content-box" },
      ]),
    )).toBe(false);
  });

  it("reads a bare number as the pixels a quirks-mode browser made of it", () => {
    const reported = declarationFingerprint([
      { property: "perspective", value: "1000px" },
    ]);
    const declared = declarationFingerprint([
      { property: "perspective", value: "1000" },
    ]);

    expect(equalReportedDeclarations(reported, declared)).toBe(true);
    // Only the same number, and only towards pixels.
    expect(equalReportedDeclarations(
      reported,
      declarationFingerprint([{ property: "perspective", value: "999" }]),
    )).toBe(false);
    expect(equalReportedDeclarations(
      declarationFingerprint([{ property: "perspective", value: "1000em" }]),
      declared,
    )).toBe(false);
  });

  it("keeps only the prefixed declarations a browser could have reported", () => {
    const reported = declarationFingerprint([
      { property: "backface-visibility", value: "hidden" },
    ]);
    const declared = declarationFingerprint([
      { property: "-moz-backface-visibility", value: "hidden" },
      { property: "-webkit-backface-visibility", value: "hidden" },
      { property: "backface-visibility", value: "hidden" },
    ]);

    expect(declarationsBrowsersKeep(reported, declared)).toEqual([
      { property: "backface-visibility", value: "hidden", important: false },
    ]);
    expect(declarationsBrowsersKeep(declared, declared)).toEqual(declared);
  });

  it("leaves quoted text and url() contents untouched", () => {
    const value = (text: string) =>
      declarationFingerprint([{ property: "content", value: text }])[0]?.value;

    expect(value('"#0b57d0"')).toBe('"#0b57d0"');
    expect(value("url(\"../a.css?v=0.750\")")).toBe("url(\"../a.css?v=0.750\")");
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
