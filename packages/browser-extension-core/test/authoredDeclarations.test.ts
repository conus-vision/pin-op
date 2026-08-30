import { describe, expect, it } from "vitest";
import {
  createShorthandExpander,
  parseDeclarationList,
  readAuthoredDeclarations,
  type LonghandDeclaration,
  type ShorthandExpander,
} from "../src/authoredDeclarations.js";
import { INSPECT_LIMITS } from "@pin-op/protocol";

const MARGIN_LONGHANDS = [
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
] as const;

describe("parseDeclarationList", () => {
  it("reads properties, values and priority from a serialized block", () => {
    expect(parseDeclarationList("color: red; margin: 0px 1px !important;"))
      .toEqual([
        { property: "color", value: "red", important: false },
        { property: "margin", value: "0px 1px", important: true },
      ]);
  });

  it("keeps semicolons and colons that belong to a value", () => {
    expect(parseDeclarationList(
      'background: url("a;b.png") no-repeat; content: "x: y";',
    )).toEqual([
      {
        property: "background",
        value: 'url("a;b.png") no-repeat',
        important: false,
      },
      { property: "content", value: '"x: y"', important: false },
    ]);
  });

  it("keeps a custom property's own name and text", () => {
    expect(parseDeclarationList("--Theme: dark:night;")).toEqual([
      { property: "--Theme", value: "dark:night", important: false },
    ]);
  });

  it("refuses text it cannot account for", () => {
    expect(parseDeclarationList("color red;")).toBeUndefined();
    expect(parseDeclarationList("color: ;")).toBeUndefined();
    expect(parseDeclarationList('content: "unclosed;')).toBeUndefined();
    expect(parseDeclarationList("background: url(a;")).toBeUndefined();
    expect(parseDeclarationList("color: red)")).toBeUndefined();
    expect(parseDeclarationList(declarationBlock(
      INSPECT_LIMITS.declarationsPerRule + 1,
    ))).toBeUndefined();
  });

  it("reads an empty block as no declarations", () => {
    expect(parseDeclarationList("")).toEqual([]);
    expect(parseDeclarationList("  ;; ")).toEqual([]);
  });
});

describe("readAuthoredDeclarations", () => {
  it("presents a shorthand once and carries the longhands it sets", () => {
    const authored = readAuthoredDeclarations(
      "margin: 0px; color: red;",
      [...MARGIN_LONGHANDS.map(zero), longhand("color", "red")],
      marginExpander,
    );

    expect(authored).toEqual([
      {
        property: "margin",
        value: "0px",
        important: false,
        longhands: MARGIN_LONGHANDS.map((property) => ({
          property,
          value: "0px",
        })),
      },
      {
        property: "color",
        value: "red",
        important: false,
        longhands: [{ property: "color", value: "red" }],
      },
    ]);
  });

  it("keeps the longhand values the rule actually holds", () => {
    const authored = readAuthoredDeclarations(
      "margin: 1px 2px;",
      [
        longhand("margin-top", "1px"),
        longhand("margin-right", "2px"),
        longhand("margin-bottom", "1px"),
        longhand("margin-left", "2px"),
      ],
      marginExpander,
    );

    expect(authored?.[0]?.longhands.map(({ value }) => value)).toEqual([
      "1px",
      "2px",
      "1px",
      "2px",
    ]);
  });

  it("presents longhands when no expansion is available", () => {
    expect(readAuthoredDeclarations(
      "margin: 0px;",
      MARGIN_LONGHANDS.map(zero),
    )).toBeUndefined();
  });

  it("presents longhands when the text leaves one unaccounted for", () => {
    expect(readAuthoredDeclarations(
      "margin: 0px;",
      [...MARGIN_LONGHANDS.map(zero), longhand("color", "red")],
      marginExpander,
    )).toBeUndefined();
    expect(readAuthoredDeclarations(
      "margin: 0px; color: red;",
      MARGIN_LONGHANDS.map(zero),
      marginExpander,
    )).toBeUndefined();
  });

  it("presents longhands when two declarations claim the same longhand", () => {
    expect(readAuthoredDeclarations(
      "margin: 0px; margin-top: 0px;",
      MARGIN_LONGHANDS.map(zero),
      marginExpander,
    )).toBeUndefined();
  });

  it("presents longhands when priority disagrees with the text", () => {
    expect(readAuthoredDeclarations(
      "margin: 0px !important;",
      MARGIN_LONGHANDS.map(zero),
      marginExpander,
    )).toBeUndefined();
  });

  it("refuses a rule whose text is larger than a rule may be", () => {
    const oversized = `color: ${"a".repeat(
      INSPECT_LIMITS.declarationsPerRule *
        (INSPECT_LIMITS.propertyNameLength + INSPECT_LIMITS.valueLength),
    )};`;

    expect(readAuthoredDeclarations(
      oversized,
      [longhand("color", "red")],
      marginExpander,
    )).toBeUndefined();
  });
});

describe("createShorthandExpander", () => {
  it("asks the browser once per declaration and reuses the answer", () => {
    const calls: string[] = [];
    const expand = createShorthandExpander(scratchDocument(calls))!;

    expect(expand("margin", "0px")).toEqual([...MARGIN_LONGHANDS]);
    expect(expand("margin", "0px")).toEqual([...MARGIN_LONGHANDS]);
    expect(calls).toEqual(["margin"]);
  });

  it("reports a longhand and an unknown property as no expansion", () => {
    const expand = createShorthandExpander(scratchDocument([]))!;

    expect(expand("color", "red")).toBeUndefined();
    expect(expand("-x-nonsense", "1")).toBeUndefined();
  });

  it("declines a document that cannot make one", () => {
    expect(createShorthandExpander({})).toBeUndefined();
    expect(createShorthandExpander({ createElement: () => ({}) }))
      .toBeUndefined();
    expect(createShorthandExpander({
      createElement: () => {
        throw new Error("hostile");
      },
    })).toBeUndefined();
  });
});

const marginExpander: ShorthandExpander = (property) =>
  property === "margin" ? [...MARGIN_LONGHANDS] : undefined;

function longhand(property: string, value: string): LonghandDeclaration {
  return { property, value, important: false };
}

function zero(property: string): LonghandDeclaration {
  return longhand(property, "0px");
}

function declarationBlock(count: number): string {
  return Array.from(
    { length: count },
    (_entry, index) => `--p${index}: ${index}`,
  ).join(";");
}

function scratchDocument(calls: string[]): object {
  return {
    createElement: () => {
      let names: string[] = [];
      return {
        style: {
          get length() {
            return names.length;
          },
          get cssText() {
            return "";
          },
          set cssText(_text: string) {
            names = [];
          },
          setProperty(property: string, _value: string) {
            calls.push(property);
            names = property === "margin"
              ? [...MARGIN_LONGHANDS]
              : property.startsWith("-x-")
              ? []
              : [property];
          },
          item(index: number) {
            return names[index] ?? "";
          },
        },
      };
    },
  };
}
