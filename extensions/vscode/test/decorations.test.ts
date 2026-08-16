import { describe, expect, it } from "vitest";
import {
  SourceDecorationManager,
  type DecorationRole,
} from "../src/presenter/decorations.js";
import type { ResolvedSourceMatch, SourceResolution } from "../src/sourcePlugins/types.js";

describe("source decorations", () => {
  it("decorates every selected range and distinct non-overlapping parent ranges", () => {
    const harness = decorationHarness();
    const shared = range(0, 0, 2, 1);
    harness.manager.update(
      harness.firstEditor,
      snapshot([
        resolvedMatch("selected", shared, "pin-op.scss"),
        resolvedMatch("parent", shared, "pin-op.scss"),
        resolvedMatch(
          "parent",
          range(4, 0, 6, 1),
          "pin-op.scss",
        ),
      ]),
    );

    expect(harness.rangesFor(harness.firstEditor, "primary")).toEqual([shared]);
    expect(harness.rangesFor(harness.firstEditor, "context")).toEqual([
      range(4, 0, 6, 1),
    ]);
  });

  it("clears decorations from the previous active editor", () => {
    const harness = decorationHarness();
    harness.manager.update(
      harness.firstEditor,
      snapshot([resolvedMatch("selected", range(0, 0, 2, 1), "css")]),
    );
    harness.manager.update(
      harness.secondEditor,
      {
        ...snapshot([
          resolvedMatch("parent", range(4, 0, 6, 1), "scss"),
        ]),
        documentUri: harness.secondEditor.document.uri.toString(),
      },
    );

    expect(harness.rangesFor(harness.firstEditor, "primary")).toEqual([]);
    expect(harness.rangesFor(harness.firstEditor, "context")).toEqual([]);
    expect(harness.rangesFor(harness.secondEditor, "context")).not.toEqual([]);
  });

  it("clears and disposes exactly two semantic decoration types", () => {
    const harness = decorationHarness();
    harness.manager.update(harness.firstEditor, snapshot([]));
    harness.manager.clear();
    harness.manager.dispose();

    expect(harness.disposed).toEqual(["primary", "context"]);
  });
});

function decorationHarness() {
  const disposed: DecorationRole[] = [];
  const firstEditor = editor("file:///src/app.css");
  const secondEditor = editor("file:///src/card.scss");
  const manager = new SourceDecorationManager({
    createThemeColor: (id) => ({ id }),
    overviewRulerLaneRight: 4,
    createDecorationType(_options, role) {
      return { role, dispose: () => disposed.push(role) };
    },
    createRange: (startLine, startCharacter, endLine, endCharacter) => ({
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    }),
  });
  return {
    manager,
    firstEditor,
    secondEditor,
    disposed,
    rangesFor(candidate: ReturnType<typeof editor>, role: DecorationRole) {
      return candidate.calls.filter((call) => call.type.role === role).at(-1)
        ?.ranges ?? [];
    },
  };
}

function editor(uri: string) {
  const calls: Array<{
    type: { role: DecorationRole; dispose(): void };
    ranges: readonly unknown[];
  }> = [];
  return {
    document: { uri: { toString: () => uri } },
    calls,
    setDecorations(
      type: { role: DecorationRole; dispose(): void },
      ranges: readonly unknown[],
    ) {
      calls.push({ type, ranges });
    },
  };
}

function snapshot(matches: readonly ResolvedSourceMatch[]): SourceResolution {
  return {
    selectionMessageId: "inspect-1",
    documentUri: "file:///src/app.css",
    documentVersion: 1,
    matches,
    diagnostics: [],
  };
}

function resolvedMatch(
  targetRole: "selected" | "parent",
  sourceRange: ReturnType<typeof range>,
  pluginId: string,
): ResolvedSourceMatch {
  return {
    pluginId,
    targetRole,
    range: sourceRange,
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "sourcemap",
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
