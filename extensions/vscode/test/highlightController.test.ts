import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type PresentationSettingsMessage } from "@pin-op/protocol";
import {
  HighlightController,
  type HighlightEditor,
} from "../src/presenter/highlightController.js";
import {
  SourceDecorationManager,
  type DecorationRole,
} from "../src/presenter/decorations.js";
import type {
  ResolvedSourceMatch,
  SourceResolution,
} from "../src/sourcePlugins/types.js";

const DOCUMENT_URI = "file:///workspace/src/card.scss";

describe("HighlightController", () => {
  it("is enabled by default and applies the latest valid resolution", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-1");

    harness.controller.update(harness.editor, resolution());

    expect(harness.ranges("primary")).toEqual([range(1, 0, 2, 1)]);
    expect(harness.ranges("context")).toEqual([range(4, 0, 5, 1)]);
  });

  it("clears selected and parent decorations immediately while retaining resolution", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-1");
    const latest = resolution();
    harness.controller.update(harness.editor, latest);

    expect(harness.controller.applySettings(settings(false))).toBe(true);

    expect(harness.ranges("primary")).toEqual([]);
    expect(harness.ranges("context")).toEqual([]);

    expect(harness.controller.applySettings(settings(true))).toBe(true);
    expect(harness.ranges("primary")).toEqual([range(1, 0, 2, 1)]);
    expect(harness.ranges("context")).toEqual([range(4, 0, 5, 1)]);
  });

  it("retains a resolution received while disabled and reapplies it on enable", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-1", false);

    harness.controller.update(harness.editor, resolution());

    expect(harness.ranges("primary")).toEqual([]);
    expect(harness.ranges("context")).toEqual([]);

    harness.controller.applySettings(settings(true));
    expect(harness.ranges("primary")).toEqual([range(1, 0, 2, 1)]);
    expect(harness.ranges("context")).toEqual([range(4, 0, 5, 1)]);
  });

  it("ignores settings and resolutions for a non-current inspection", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-current");
    harness.controller.update(harness.editor, {
      ...resolution(),
      selectionMessageId: "inspect-stale",
    });

    expect(harness.controller.applySettings(
      settings(false, "inspect-stale"),
    )).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  it("does not reapply a retained resolution after document version drift", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-1");
    harness.controller.update(harness.editor, resolution());
    harness.controller.applySettings(settings(false));
    harness.editor.document.version = 2;

    harness.controller.applySettings(settings(true));

    expect(harness.ranges("primary")).toEqual([]);
    expect(harness.ranges("context")).toEqual([]);
  });

  it("clears retained authority on invalidation and new inspections", () => {
    const harness = highlightHarness();
    harness.controller.beginInspect("inspect-1");
    harness.controller.update(harness.editor, resolution());
    harness.controller.applySettings(settings(false));

    harness.controller.clear();
    harness.controller.applySettings(settings(true));
    expect(harness.ranges("primary")).toEqual([]);
    expect(harness.ranges("context")).toEqual([]);

    harness.controller.update(harness.editor, resolution());
    harness.controller.beginInspect("inspect-2");
    expect(harness.ranges("primary")).toEqual([]);
    expect(harness.ranges("context")).toEqual([]);
    expect(harness.controller.applySettings(settings(true, "inspect-1")))
      .toBe(false);
  });

  it("disposes the decoration manager once and ignores later operations", () => {
    const clear = vi.fn();
    const update = vi.fn();
    const dispose = vi.fn();
    const controller = new HighlightController({ clear, update, dispose });
    const editor = highlightEditor(DOCUMENT_URI, 1);
    controller.beginInspect("inspect-1");
    controller.update(editor, resolution());

    controller.dispose();
    controller.dispose();
    controller.beginInspect("inspect-2");
    controller.update(editor, resolution("inspect-2"));
    controller.applySettings(settings(false, "inspect-2"));
    controller.clear();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

function highlightHarness() {
  const calls: Array<{
    readonly role: DecorationRole;
    readonly ranges: readonly unknown[];
  }> = [];
  const disposed: DecorationRole[] = [];
  const editor = highlightEditor(DOCUMENT_URI, 1, calls);
  const manager = new SourceDecorationManager({
    createThemeColor: (id) => ({ id }) as vscode.ThemeColor,
    overviewRulerLaneRight: 4,
    createDecorationType(_options, role) {
      return { role, dispose: () => disposed.push(role) };
    },
    createRange: (startLine, startCharacter, endLine, endCharacter) =>
      range(startLine, startCharacter, endLine, endCharacter),
  });
  const controller = new HighlightController(manager);
  return {
    controller,
    editor,
    calls,
    disposed,
    ranges(role: DecorationRole): readonly unknown[] {
      return calls.filter((call) => call.role === role).at(-1)?.ranges ?? [];
    },
  };
}

function highlightEditor(
  uri: string,
  version: number,
  calls: Array<{
    readonly role: DecorationRole;
    readonly ranges: readonly unknown[];
  }> = [],
): HighlightEditor & { document: HighlightEditor["document"] & { version: number } } {
  return {
    documentUri: uri,
    document: {
      uri: { toString: () => uri },
      languageId: "scss",
      version,
      getText: () => ".card {}",
      positionAt: (offset) => ({ line: 0, character: offset }),
      offsetAt: (position) => position.character,
    },
    setDecorations(type, ranges) {
      calls.push({ role: type.role!, ranges });
    },
  };
}

function resolution(
  inspectMessageId = "inspect-1",
): SourceResolution {
  return {
    selectionMessageId: inspectMessageId,
    documentUri: DOCUMENT_URI,
    documentVersion: 1,
    matches: [
      match("selected", range(1, 0, 2, 1)),
      match("parent", range(4, 0, 5, 1)),
    ],
    diagnostics: [],
  };
}

function match(
  targetRole: "selected" | "parent",
  sourceRange: ReturnType<typeof range>,
): ResolvedSourceMatch {
  return {
    pluginId: `fixture.${targetRole}`,
    targetRole,
    range: sourceRange,
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "exact",
  };
}

function settings(
  ideHighlightEnabled: boolean,
  inspectMessageId = "inspect-1",
): PresentationSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "presentation.settings",
    messageId: `settings-${ideHighlightEnabled}`,
    sessionId: "session-1",
    inspectMessageId,
    ideHighlightEnabled,
    metadata: {},
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
