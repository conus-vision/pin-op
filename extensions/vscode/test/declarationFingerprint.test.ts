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
    expect(sides("grid-template-columns", "repeat(3, 1fr)")).toEqual([
      { property: "grid-template-columns", value: "repeat(3,1fr)", important: false },
    ]);
  });

  it("reads a shorthand as every longhand it sets", () => {
    expect(declarationFingerprint([
      { property: "transition", value: "opacity 1s, transform 2s" },
    ])).toEqual([
      { property: "transition-behavior", value: "normal,normal", important: false },
      { property: "transition-delay", value: "0s,0s", important: false },
      { property: "transition-duration", value: "1s,2s", important: false },
      { property: "transition-property", value: "opacity,transform", important: false },
      { property: "transition-timing-function", value: "ease,ease", important: false },
    ]);
    // A value that cannot be read with certainty is left as it was written.
    expect(declarationFingerprint([
      { property: "transition", value: "opacity var(--speed) ease" },
    ])).toEqual([
      { property: "transition", value: "opacity var(--speed) ease", important: false },
    ]);
  });

  // What Chrome 155 and Firefox 158 report, verbatim, for rules as authors and
  // dart-sass write them. A browser leaves out every part at its initial value,
  // writes the parts in its own order, and folds a longhand written after the
  // shorthand into it -- and the two engines do not agree with each other.
  it.each([
    ["transition: transform 0.2s ease, box-shadow 0.2s ease",
      "transition: transform 0.2s, box-shadow 0.2s",
      "transition: transform 0.2s, box-shadow 0.2s"],
    ["transition: background 0.15s ease, transform 0.15s ease",
      "transition: background 0.15s, transform 0.15s",
      "transition: background 0.15s, transform 0.15s"],
    ["transition: all 0.3s ease",
      "transition: 0.3s",
      "transition: 0.3s"],
    ["transition: all .3s ease-in-out",
      "transition: 0.3s ease-in-out",
      "transition: 0.3s ease-in-out"],
    ["transition: opacity 1s ease, transform 1s ease 0.2s",
      "transition: opacity 1s, transform 1s 0.2s",
      "transition: opacity 1s, transform 1s 0.2s"],
    ["transition: opacity 300ms ease 0ms",
      "transition: opacity 300ms",
      "transition: opacity 300ms"],
    ["transition: 0s",
      "transition: all",
      "transition: all"],
    ["transition: -webkit-transform 0.2s ease",
      "transition: -webkit-transform 0.2s",
      "transition: -webkit-transform 0.2s"],
    ["transition: opacity 0.3s steps(4, end)",
      "transition: opacity 0.3s steps(4)",
      "transition: opacity 0.3s steps(4)"],
    ["transition: opacity 0.3s step-end",
      "transition: opacity 0.3s step-end",
      "transition: opacity 0.3s steps(1)"],
    ["transition: opacity .3s step-start",
      "transition: opacity 0.3s step-start",
      "transition: opacity 0.3s steps(1, start)"],
    ["transition: opacity 0.3s; transition-delay: 0.1s",
      "transition: opacity 0.3s 0.1s",
      "transition: opacity 0.3s 0.1s"],
    ["transition: opacity .3s ease; transition-timing-function: linear",
      "transition: opacity 0.3s linear",
      "transition: opacity 0.3s linear"],
    ["animation: spin 1s linear infinite",
      "animation: 1s linear 0s infinite normal none running spin",
      "animation: 1s linear infinite spin"],
    ["animation: fade 0.3s ease",
      "animation: 0.3s ease 0s 1 normal none running fade",
      "animation: 0.3s fade"],
    ["animation: bounce 1s ease 0.5s 3 alternate both",
      "animation: 1s ease 0.5s 3 alternate both running bounce",
      "animation: 1s 0.5s 3 alternate both bounce"],
    ["animation: none",
      "animation: auto ease 0s 1 normal none running none",
      "animation: none"],
    ["animation: fade 0s 1s",
      "animation: 0s ease 1s 1 normal none running fade",
      "animation: 0s 1s fade"],
    ["animation: fade 1s step-end",
      "animation: 1s step-end 0s 1 normal none running fade",
      "animation: 1s steps(1) fade"],
    ["animation: spin 1s linear infinite, fade 2s ease-out",
      "animation: 1s linear 0s infinite normal none running spin, 2s ease-out 0s 1 normal none running fade",
      "animation: 1s linear infinite spin, 2s ease-out fade"],
    ["animation: spin 1s linear infinite; animation-play-state: paused",
      "animation: 1s linear 0s infinite normal none paused spin",
      "animation: 1s linear infinite paused spin"],
    ["flex: 1",
      "flex: 1 1 0%",
      "flex: 1 1 0%"],
    ["flex: auto",
      "flex: 1 1 auto",
      "flex: 1 1 auto"],
    ["flex: none",
      "flex: 0 0 auto",
      "flex: 0 0 auto"],
    ["flex: 1 200px",
      "flex: 1 1 200px",
      "flex: 1 1 200px"],
    ["flex: 0",
      "flex: 0 1 0%",
      "flex: 0 1 0%"],
    ["flex: 1 1 0",
      "flex: 1 1 0px",
      "flex: 1 1 0px"],
    ["flex: 0 0 auto; flex-basis: 50%",
      "flex: 0 0 50%",
      "flex: 0 0 50%"],
    ["flex-flow: row wrap",
      "flex-flow: wrap",
      "flex-flow: wrap"],
    ["flex-flow: row nowrap",
      "flex-flow: row",
      "flex-flow: row"],
    ["outline: 2px solid red",
      "outline: red solid 2px",
      "outline: red solid 2px"],
    ["outline: 1px solid currentColor",
      "outline: currentcolor solid 1px",
      "outline: solid 1px"],
    ["outline: medium none currentcolor",
      "outline: currentcolor none medium",
      "outline: none"],
    ["outline: 0 none",
      "outline: none 0px",
      "outline: 0px"],
    ["border: solid 1px red",
      "border: 1px solid red",
      "border: 1px solid red"],
    ["border: 1px solid currentColor",
      "border: 1px solid",
      "border: 1px solid"],
    ["border: none",
      "border-width: medium; border-style: none; border-color: currentcolor; border-image: none",
      "border: medium"],
    ["border-left: none",
      "border-left-width: medium; border-left-style: none; border-left-color: currentcolor",
      "border-left: medium"],
    ["border: 1px solid red; border-bottom: none",
      "border-width: 1px 1px medium; border-style: solid solid none; border-color: red red currentcolor; border-image: none",
      "border-width: 1px 1px medium; border-style: solid solid none; border-color: red red currentcolor; border-image: none"],
    ["border-top: 1px solid red; border-right: 1px solid red; border-bottom: 1px solid red; border-left: 1px solid red",
      "border-width: 1px; border-style: solid; border-color: red",
      "border-width: 1px; border-style: solid; border-color: red"],
    ["border-inline: none",
      "border-inline-start: medium none currentcolor; border-inline-end: medium none currentcolor",
      "border-inline: medium"],
    ["border: none; border-bottom: 1px solid #eee",
      "border-width: medium medium 1px; border-style: none none solid; border-color: currentcolor currentcolor rgb(238, 238, 238); border-image: none",
      "border-width: medium medium 1px; border-style: none none solid; border-color: currentcolor currentcolor rgb(238, 238, 238); border-image: none"],
    ["border: 0 none",
      "border: 0px",
      "border: 0px"],
    ["background: url(img/a.png) no-repeat center / cover",
      "background: url(\"img/a.png\") center center / cover no-repeat",
      "background: url(\"img/a.png\") center center / cover no-repeat"],
    ["background: #fff url(img/a.png) repeat-x 0 0",
      "background: url(\"img/a.png\") 0px 0px repeat-x rgb(255, 255, 255)",
      "background: url(\"img/a.png\") 0px 0px repeat-x rgb(255, 255, 255)"],
    ["background: url(a.png) 0 0 / cover no-repeat padding-box",
      "background: url(\"a.png\") 0px 0px / cover no-repeat padding-box padding-box",
      "background: url(\"a.png\") 0px 0px / cover no-repeat padding-box"],
    ["background: transparent none repeat scroll 0% 0%",
      "background: none 0% 0% repeat scroll transparent",
      "background: transparent"],
    ["background: url(a.png) text",
      "background: url(\"a.png\") text",
      "background: url(\"a.png\") padding-box text"],
    ["background: url(a.png) center / auto",
      "background: url(\"a.png\") center center / auto",
      "background: url(\"a.png\") center center"],
    ["background: url(a.png); background-size: cover",
      "background: url(\"a.png\") 0% 0% / cover",
      "background: url(\"a.png\") 0% 0% / cover"],
    ["background: linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%), url(img/a.png) center / cover no-repeat",
      "background: linear-gradient(rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 100%), url(\"img/a.png\") center center / cover no-repeat",
      "background: linear-gradient(rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 100%), url(\"img/a.png\") center center / cover no-repeat"],
    ["background: url(a.png) no-repeat, url(b.png) repeat-x #fff",
      "background: url(\"a.png\") no-repeat, url(\"b.png\") repeat-x rgb(255, 255, 255)",
      "background: url(\"a.png\") no-repeat, url(\"b.png\") repeat-x rgb(255, 255, 255)"],
    ["background-position: top right",
      "background-position: right top",
      "background-position: right top"],
    ["background-position: 50%",
      "background-position: 50% center",
      "background-position: 50% center"],
    ["background-size: 100%",
      "background-size: 100% auto",
      "background-size: 100% auto"],
    ["background-repeat: repeat no-repeat",
      "background-repeat: repeat-x",
      "background-repeat: repeat-x"],
    ["background-image: url('img/a.png')",
      "background-image: url(\"img/a.png\")",
      "background-image: url(\"img/a.png\")"],
    ["background: radial-gradient(ellipse farthest-corner at center, red, blue)",
      "background: radial-gradient(red, blue)",
      "background: radial-gradient(red, blue)"],
    ["background: radial-gradient(circle at top, red, blue)",
      "background: radial-gradient(circle at center top, red, blue)",
      "background: radial-gradient(circle at center top, red, blue)"],
    ["background: repeating-linear-gradient(45deg, red 0 10px, blue 10px 20px)",
      "background: repeating-linear-gradient(45deg, red 0px, red 10px, blue 10px, blue 20px)",
      "background: repeating-linear-gradient(45deg, red 0px, red 10px, blue 10px, blue 20px)"],
    ["background: conic-gradient(from 0deg, red, blue)",
      "background: conic-gradient(red, blue)",
      "background: conic-gradient(red, blue)"],
    ["background: conic-gradient(red 0 25%, blue 25% 50%)",
      "background: conic-gradient(red 0deg, red 25%, blue 25%, blue 50%)",
      "background: conic-gradient(red 0deg, red 25%, blue 25%, blue 50%)"],
    ["font: 600 1rem/1.5 \"Inter\", sans-serif",
      "font: 600 1rem / 1.5 Inter, sans-serif",
      "font: 600 1rem / 1.5 Inter, sans-serif"],
    ["font: normal normal 400 16px/1.5 system-ui",
      "font: 400 16px / 1.5 system-ui",
      "font: 16px / 1.5 system-ui"],
    ["font: 1.25rem/1.2 \"Playfair Display\", Georgia, serif",
      "font: 1.25rem / 1.2 \"Playfair Display\", Georgia, serif",
      "font: 1.25rem / 1.2 Playfair Display, Georgia, serif"],
    ["font: 16px/normal Arial",
      "font: 16px Arial",
      "font: 16px Arial"],
    ["font: 16px serif; font-weight: 700",
      "font: 700 16px serif",
      "font: 700 16px serif"],
    ["list-style: disc inside",
      "list-style: inside disc",
      "list-style: inside"],
    ["list-style: none outside none",
      "list-style: outside none none",
      "list-style: none"],
    ["list-style: square inside url(i.png)",
      "list-style: inside url(\"i.png\") square",
      "list-style: inside url(\"i.png\") square"],
    ["columns: 2 200px",
      "columns: 200px 2",
      "columns: 200px 2"],
    ["columns: auto 2",
      "columns: 2",
      "columns: 2"],
    ["text-decoration: underline solid currentColor",
      "text-decoration: underline",
      "text-decoration: underline"],
    ["text-decoration: none currentcolor solid",
      "text-decoration: none",
      "text-decoration: none"],
    ["transform-origin: center",
      "transform-origin: center center",
      "transform-origin: center center 0px"],
    ["object-position: top",
      "object-position: center top",
      "object-position: center top"],
    ["perspective-origin: top left",
      "perspective-origin: left top",
      "perspective-origin: left top"],
    ["grid-gap: 1rem 2rem",
      "gap: 1rem 2rem",
      "gap: 1rem 2rem"],
    ["word-wrap: break-word",
      "overflow-wrap: break-word",
      "overflow-wrap: break-word"],
    ["-webkit-transform: none",
      "transform: none",
      "transform: none"],
    ["-webkit-flex: 1",
      "flex: 1 1 0%",
      "flex: 1 1 0%"],
    ["-webkit-transition: opacity 0.3s ease",
      "transition: opacity 0.3s",
      "transition: opacity 0.3s"],
    ["-webkit-transform: translateX(1px); transform: translateX(1px)",
      "transform: translateX(1px)",
      "transform: translateX(1px)"],
    ["display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden",
      "display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden",
      "display: -webkit-box; -webkit-line-clamp: 2; -moz-box-orient: vertical; overflow: hidden"],
    ["-webkit-box-pack: center",
      "-webkit-box-pack: center",
      "-moz-box-pack: center"],
    ["color: currentColor",
      "color: currentcolor",
      "color: currentcolor"],
    ["fill: currentColor",
      "fill: currentcolor",
      "fill: currentcolor"],
    ["color: RED",
      "color: red",
      "color: red"],
    ["cursor: url(c.png), auto",
      "cursor: url(\"c.png\"), auto",
      "cursor: url(\"c.png\"), auto"],
  ])("reads `%s` the way Chrome and Firefox report it", (
    written,
    chrome,
    firefox,
  ) => {
    expect(equalReportedDeclarations(reportedRule(chrome), writtenRule(written)))
      .toBe(true);
    expect(equalReportedDeclarations(reportedRule(firefox), writtenRule(written)))
      .toBe(true);
  });

  it.each([
    // Every pair differs in what it means, however close the spelling.
    ["transition: opacity 0.3s", "transition: opacity 0.3s 0.1s"],
    ["transition: opacity 0.3s ease", "transition: opacity 0.3s linear"],
    ["transition: opacity 0.3s steps(4)", "transition: opacity 0.3s steps(4, start)"],
    ["transition: opacity 0.3s", "transition: transform 0.3s"],
    ["animation: fade 1s", "animation: fade 1s 1s"],
    ["animation: fade 1s", "animation: spin 1s"],
    ["animation: fade 1s", "animation: fade 1s infinite"],
    ["flex: 1", "flex: 1 1 0"],
    ["flex: 1", "flex: 1 1 auto"],
    ["flex-flow: row", "flex-flow: row wrap"],
    ["outline: 0", "outline: none"],
    ["outline: 1px solid", "outline: 1px dashed"],
    ["border: none", "border: 0"],
    ["border: 1px solid", "border: 1px solid red"],
    ["border-top: 1px solid", "border-bottom: 1px solid"],
    ["background: url(a.png) 0 0", "background: url(a.png)"],
    ["background: url(a.png) no-repeat", "background: url(a.png)"],
    ["background: url(a.png) center / cover", "background: url(a.png) center / contain"],
    ["background: url(a.png) padding-box", "background: url(a.png)"],
    ["background: url(a.png)", "background: url(b.png)"],
    ["background-position: left top", "background-position: right top"],
    ["background: linear-gradient(to right, red, blue)", "background: linear-gradient(red, blue)"],
    ["background: radial-gradient(circle, red, blue)", "background: radial-gradient(red, blue)"],
    ["font: 16px Arial", "font: 700 16px Arial"],
    ["font: 16px Arial", "font: 16px/1.5 Arial"],
    ["font: 16px Arial", "font: italic 16px Arial"],
    ["list-style: none", "list-style: disc"],
    ["list-style: disc inside", "list-style: disc"],
    ["columns: 2", "columns: 200px"],
    ["text-decoration: underline", "text-decoration: underline wavy"],
    ["transform-origin: left top 10px", "transform-origin: left top"],
    ["transform: none", "-webkit-transform: rotate(1deg)"],
  ])("keeps `%s` and `%s` apart", (left, right) => {
    expect(equalReportedDeclarations(reportedRule(left), writtenRule(right)))
      .toBe(false);
    expect(equalReportedDeclarations(reportedRule(right), writtenRule(left)))
      .toBe(false);
  });

  it("does not read a transition Chrome reported lossily as the file's", () => {
    // Chrome drops a zero duration that a delay follows, so the file's
    // `visibility 0s .3s` comes back as `visibility 0.3s` -- which reads as a
    // 0.3s duration. Firefox reports it intact. They are different transitions,
    // so in Chrome the rule stays unproven rather than guessed at.
    const written = writtenRule("transition: opacity .3s, visibility 0s .3s");

    expect(equalReportedDeclarations(
      reportedRule("transition: opacity 0.3s, visibility 0.3s"),
      written,
    )).toBe(false);
    expect(equalReportedDeclarations(
      reportedRule("transition: opacity 0.3s, visibility 0s 0.3s"),
      written,
    )).toBe(true);
  });

  it("lowercases a colour keyword only where the value is a colour", () => {
    const value = (property: string, text: string) =>
      declarationFingerprint([{ property, value: text }])[0]?.value;

    expect(value("color", "currentColor")).toBe("currentcolor");
    // A family name is case-sensitive text, even when it starts with a colour.
    expect(value("font-family", "Red Hat Display")).toBe("Red Hat Display");
    expect(value("animation-name", "Red")).toBe("Red");
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

  it("reads a url() the way a browser quotes it", () => {
    const value = (text: string) =>
      declarationFingerprint([{ property: "content", value: text }])[0]?.value;

    expect(value("url(img/a.png)")).toBe('url("img/a.png")');
    expect(value("url('img/a.png')")).toBe('url("img/a.png")');
    expect(value("url( img/a.png )")).toBe('url("img/a.png")');
    expect(value("url(data:image/png;base64,iVBORw0KGgo=)"))
      .toBe('url("data:image/png;base64,iVBORw0KGgo=")');
    // A URL that would need escaping to requote keeps the spelling it has.
    expect(value("url('a\"b.png')")).toBe("url('a\"b.png')");
  });

});

function writtenRule(text: string) {
  return declarationFingerprint(declarationsAfterInRuleCascade(
    declarationsOf(text),
  ));
}

function reportedRule(text: string) {
  const fingerprint = completeDeclarationFingerprint(declarationsOf(text));
  if (!fingerprint) throw new Error(`not a complete rule: ${text}`);
  return fingerprint;
}

function declarationsOf(text: string): CssDeclarationEvidence[] {
  return text.split(/;\s*/).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(":");
    return {
      property: entry.slice(0, colon),
      value: entry.slice(colon + 1),
      important: false,
    };
  });
}

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
