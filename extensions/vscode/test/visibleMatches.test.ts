import { describe, expect, it } from "vitest";
import type { SourceDocument } from "@pin-op/plugin-api";
import { visibleMatches } from "../src/presenter/visibleMatches.js";
import type { ResolvedSourceMatch } from "../src/sourcePlugins/types.js";

describe("visibleMatches", () => {
  it("deduplicates document ranges with selected precedence over parent", () => {
    const result = visibleMatches(
      [
        match("parent", 0, 7, "parent-plugin"),
        match("selected", 0, 7, "selected-plugin"),
        match("selected", 9, 16, "selected-a"),
        match("selected", 9, 16, "selected-b"),
        match("parent", 18, 25, "parent-only"),
      ],
      document(".card{}  .title{}  .layout{}"),
    );

    expect(result.matches.map((entry) => [
      entry.targetRole,
      entry.range.start.character,
      entry.pluginId,
    ])).toEqual([
      ["selected", 0, "selected-plugin"],
      ["selected", 9, "selected-a"],
      ["parent", 18, "parent-only"],
    ]);
    expect(result).toMatchObject({
      selectedMatchCount: 2,
      parentMatchCount: 1,
      rejectedMatchCount: 0,
    });
  });

  it("normalizes valid ranges and rejects noncanonical or out-of-document ranges", () => {
    const result = visibleMatches(
      [
        match("selected", 0, 7, "valid"),
        match("selected", -1, 2, "negative"),
        match("parent", 0, 99, "clamped"),
        {
          ...match("parent", 0, 2, "fractional"),
          range: {
            start: { line: 0, character: 0.5 },
            end: { line: 0, character: 2 },
          },
        },
      ],
      document(".card{}"),
    );

    expect(result.matches).toEqual([
      expect.objectContaining({ pluginId: "valid" }),
    ]);
    expect(result.rejectedMatchCount).toBe(3);
  });

  it("preserves multiple distinct selected and immediate-parent ranges", () => {
    const result = visibleMatches(
      [
        match("selected", 0, 4, "selected-a"),
        match("selected", 5, 9, "selected-b"),
        match("parent", 10, 14, "parent-a"),
        match("parent", 15, 19, "parent-b"),
      ],
      document("1234 6789 abcde fghij"),
    );

    expect(result.selectedMatchCount).toBe(2);
    expect(result.parentMatchCount).toBe(2);
    expect(result.matches).toHaveLength(4);
  });
});

function match(
  targetRole: "selected" | "parent",
  startCharacter: number,
  endCharacter: number,
  pluginId: string,
): ResolvedSourceMatch {
  return {
    pluginId,
    targetRole,
    range: {
      start: { line: 0, character: startCharacter },
      end: { line: 0, character: endCharacter },
    },
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "exact",
  };
}

function document(text: string): SourceDocument {
  return {
    uri: "file:///workspace/src/app.css",
    languageId: "css",
    version: 1,
    getText: () => text,
    positionAt(offset) {
      const character = Math.max(0, Math.min(offset, text.length));
      return { line: 0, character };
    },
    offsetAt(position) {
      return Math.max(0, Math.min(position.character, text.length));
    },
  };
}
