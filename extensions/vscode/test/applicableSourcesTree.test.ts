import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  ApplicableSourcesTreeDataProvider,
  stableSourceMatchId,
} from "../src/presenter/applicableSourcesTree.js";
import type {
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
  SourceResolution,
} from "../src/sourcePlugins/types.js";

describe("ApplicableSourcesTreeDataProvider", () => {
  it("shows target role, label, confidence, and plugin diagnostics", () => {
    const selected = resolvedMatch(
      "selected",
      range(0, 0, 2, 1),
      "pin-op.scss",
      ".card",
      "sourcemap",
    );
    const parent = resolvedMatch(
      "parent",
      range(4, 0, 6, 1),
      "pin-op.scss",
      ".layout",
      "sourcemap",
    );
    const tree = new ApplicableSourcesTreeDataProvider({
      createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
    });
    tree.update(snapshot(
      [selected, parent],
      [diagnostic("scss.sourceMapMissing")],
    ));

    const items = tree.getChildren();
    expect(items.map((item) => item.label)).toEqual([
      "Selected  .card",
      "Parent  .layout",
      "SCSS source map was not found",
    ]);
    expect(items.map((item) => item.description)).toEqual([
      "sourcemap - pin-op.scss",
      "sourcemap - pin-op.scss",
      "warning - pin-op.scss",
    ]);
    expect(items[0]?.command).toEqual({
      command: "pin-op.revealSourceMatch",
      title: "Reveal Source Match",
      arguments: [stableSourceMatchId(snapshot([selected]), selected)],
    });
    expect(items[2]?.command).toBeUndefined();
  });

  it("keeps lookup scoped to the latest active-file snapshot", () => {
    const tree = new ApplicableSourcesTreeDataProvider();
    const first = resolvedMatch("selected", range(0, 0, 1, 1), "css");
    const firstSnapshot = snapshot([first]);
    const firstId = stableSourceMatchId(firstSnapshot, first);
    tree.update(firstSnapshot);
    expect(tree.getMatch(firstId)).toBe(first);

    tree.update({ ...snapshot([]), documentUri: "file:///src/other.css" });
    expect(tree.getMatch(firstId)).toBeUndefined();
    expect(tree.getDocumentUri()).toBe("file:///src/other.css");
  });

  it("notifies listeners and releases state when disposed", () => {
    const tree = new ApplicableSourcesTreeDataProvider();
    const updates: unknown[] = [];
    tree.onDidChangeTreeData((item) => updates.push(item));

    tree.update(snapshot([]));
    tree.dispose();
    tree.update(snapshot([]));

    expect(updates).toEqual([undefined]);
    expect(tree.getChildren()).toEqual([]);
  });
});

function snapshot(
  matches: readonly ResolvedSourceMatch[],
  diagnostics: readonly ResolvedPluginDiagnostic[] = [],
): SourceResolution {
  return {
    selectionMessageId: "inspect-1",
    documentUri: "file:///src/app.css",
    documentVersion: 1,
    matches,
    diagnostics,
  };
}

function resolvedMatch(
  targetRole: "selected" | "parent",
  sourceRange: ReturnType<typeof range>,
  pluginId: string,
  label = ".card",
  confidence: ResolvedSourceMatch["confidence"] = "exact",
): ResolvedSourceMatch {
  return {
    pluginId,
    targetRole,
    range: sourceRange,
    label,
    kind: "style-rule",
    relation: "styles",
    confidence,
  };
}

function diagnostic(code: string): ResolvedPluginDiagnostic {
  return {
    pluginId: "pin-op.scss",
    code,
    message: "SCSS source map was not found",
    severity: "warning",
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
