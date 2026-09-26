import { describe, expect, it } from "vitest";
import type { SourceDocument, SourcePosition, SourceRange } from
  "@pin-op/plugin-api";
import { declarationValuePosition } from
  "../src/rules/declarationValuePosition.js";

describe("declarationValuePosition", () => {
  it("finds the value of a declaration the rule writes directly", () => {
    const text = [
      ".card {",
      "  /* color: blue; */",
      "  color:   red;",
      "  margin: 0 auto",
      "}",
    ].join("\n");
    expect(at(text, "color")).toEqual({ line: 2, character: 11 });
    expect(at(text, "margin")).toEqual({ line: 3, character: 10 });
    expect(at(text, "padding")).toBeUndefined();
  });

  it("ignores declarations of nested rules and reads only the rule's own block", () => {
    const text = [
      ".card {",
      "  &:hover { color: blue; }",
      "  .title { color: green; }",
      "  @include theme($color: red);",
      "  $gap: 4px;",
      "  color: red;",
      "}",
      ".other { color: black; }",
    ].join("\n");
    expect(at(text, "color", 0, rangeOfFirstRule(text)))
      .toEqual({ line: 5, character: 9 });
  });

  it("picks the counted occurrence and otherwise the last one the browser keeps", () => {
    const text = ".a { display: block; display: grid; }";
    expect(at(text, "display", 0)).toEqual({ line: 0, character: 14 });
    expect(at(text, "display", 1)).toEqual({ line: 0, character: 30 });
    expect(at(text, "DISPLAY", 5)).toEqual({ line: 0, character: 30 });
  });

  it("is not misled by strings, urls, interpolation and selector colons", () => {
    const text = [
      'a:hover, .x[data-y="a;b{"] {',
      "  background: url(//cdn.test/a;b.png);",
      '  content: "}";',
      "  width: calc(#{$w} - 1px);",
      "}",
    ].join("\n");
    expect(at(text, "content")).toEqual({ line: 2, character: 11 });
    expect(at(text, "width")).toEqual({ line: 3, character: 9 });
    expect(at(text, "background")).toEqual({ line: 1, character: 14 });
  });

  it("finds custom properties", () => {
    expect(at(":root { --brand-color: #f00; }", "--brand-color"))
      .toEqual({ line: 0, character: 23 });
  });
});

function at(
  text: string,
  property: string,
  occurrence = 0,
  range?: SourceRange,
): SourcePosition | undefined {
  const document = textDocument(text);
  return declarationValuePosition(
    document,
    range ?? { start: { line: 0, character: 0 }, end: document.positionAt(text.length) },
    { property, occurrence },
  );
}

function rangeOfFirstRule(text: string): SourceRange {
  const document = textDocument(text);
  const end = text.indexOf("\n}") + 2;
  return { start: { line: 0, character: 0 }, end: document.positionAt(end) };
}

function textDocument(text: string): SourceDocument {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return {
    uri: "file:///workspace/card.scss",
    languageId: "scss",
    version: 1,
    getText: () => text,
    positionAt(offset) {
      const bounded = Math.min(Math.max(0, offset), text.length);
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= bounded) line += 1;
      return { line, character: bounded - lineStarts[line]! };
    },
    offsetAt(position) {
      return Math.min(text.length, (lineStarts[position.line] ?? text.length) + position.character);
    },
  };
}
