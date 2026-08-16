import { describe, expect, it } from "vitest";
import type { SourcePosition, SourceRange } from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  type SourceNavigateMessage,
} from "@pin-op/protocol";
import type { SourceNavigationStateInput } from "../src/bridgeClient.js";
import {
  replacePrimarySelection,
  SourceNavigator,
  type SourceNavigationEditor,
  type SourceNavigationHost,
  type SourceNavigationResolution,
} from "../src/presenter/sourceNavigator.js";
import type { ResolvedSourceMatch } from "../src/sourcePlugins/types.js";

const DOCUMENT_URI = "file:///workspace/card.scss";

describe("SourceNavigator", () => {
  it("replaces only the primary selection", () => {
    const oldPrimary = { id: "old-primary" };
    const newPrimary = { id: "new-primary" };
    const secondaryA = { id: "secondary-a" };
    const secondaryB = { id: "secondary-b" };
    const selections = [oldPrimary, secondaryA, secondaryB];

    const result = replacePrimarySelection(selections, newPrimary);

    expect(result).toEqual([newPrimary, secondaryA, secondaryB]);
    expect(result[1]).toBe(secondaryA);
    expect(result[2]).toBe(secondaryB);
    expect(selections).toEqual([oldPrimary, secondaryA, secondaryB]);
  });

  it("keeps selected ranges, removes exact duplicates, and retains nested ranges", () => {
    const harness = navigatorHarness({ emitCursorEventOnSet: true });
    harness.host.movePrimaryCursor({ line: 9, character: 0 });
    const outer = range(2, 0, 2, 8);
    const inner = range(2, 2, 2, 5);

    harness.navigator.update(resolution([
      match("parent", range(0, 1, 0, 4), "parent"),
      match("selected", outer, "outer"),
      match("selected", inner, "inner"),
      match("selected", outer, "duplicate"),
    ]));

    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
    });
    expect(harness.host.cursorSets).toEqual([]);
    expect(harness.host.revealed).toEqual([]);

    harness.navigator.navigate(intent("previous"));
    expectLastNavigation(harness, inner, 1, 1);
    harness.navigator.navigate(intent("previous"));
    expectLastNavigation(harness, outer, 0, 2);
    harness.navigator.navigate(intent("previous"));
    expectLastNavigation(harness, inner, 1, 3);
  });

  it.each([
    ["next", [0, 1, 2, 3, 4, 0]],
    ["previous", [4, 3, 2, 1, 0, 4]],
  ] as const)(
    "navigates %s without losing explicit identity across overlapping ranges",
    (direction, expectedIndexes) => {
      const harness = navigatorHarness({ emitCursorEventOnSet: true });
      const orderedRanges = [
        range(1, 0, 1, 4),
        range(1, 0, 1, 10),
        range(1, 2, 1, 5),
        range(1, 4, 1, 12),
        range(1, 14, 1, 16),
      ];
      harness.navigator.update(resolution([
        match("selected", orderedRanges[3]!, "partial-overlap"),
        match("selected", orderedRanges[1]!, "same-start-long"),
        match("selected", orderedRanges[4]!, "last"),
        match("selected", orderedRanges[2]!, "nested"),
        match("selected", orderedRanges[0]!, "same-start-short"),
      ]));

      for (const [commandIndex, expectedIndex] of expectedIndexes.entries()) {
        harness.navigator.navigate(intent(direction));
        expectLastNavigation(
          harness,
          orderedRanges[expectedIndex]!,
          expectedIndex,
          commandIndex + 1,
        );
      }

      expect(harness.host.revealed).toEqual(
        expectedIndexes.map((index) => orderedRanges[index]),
      );
    },
  );

  it("drops explicit identity after genuine cursor movement", () => {
    const harness = navigatorHarness({ emitCursorEventOnSet: true });
    harness.navigator.update(resolution([
      match("selected", range(1, 0, 1, 4), "same-start-short"),
      match("selected", range(1, 0, 1, 10), "same-start-long"),
    ]));
    harness.navigator.navigate(intent("next"));
    harness.navigator.navigate(intent("next"));
    expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex: 1 });

    harness.host.changePrimaryCursor(position(1, 1));
    expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex: 0 });
    harness.host.changePrimaryCursor(position(1, 0));
    expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex: 0 });
  });

  it("does not retain an explicit target when setting the cursor throws", () => {
    const harness = navigatorHarness({ emitCursorEventOnSet: true });
    const short = range(1, 0, 1, 4);
    const long = range(1, 0, 1, 10);
    harness.navigator.update(resolution([
      match("selected", short, "same-start-short"),
      match("selected", long, "same-start-long"),
    ]));
    harness.navigator.navigate(intent("next"));
    const error = new Error("selection failed");
    harness.host.failNextCursorSet(error);

    expect(() => harness.navigator.navigate(intent("next"))).toThrow(error);
    harness.host.changePrimaryCursor(position(1, 0));
    expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex: 0 });

    harness.navigator.navigate(intent("next"));
    expectLastNavigation(harness, long, 1, 2);
  });

  it("sorts ranges deterministically by start and then end", () => {
    const harness = navigatorHarness();
    harness.navigator.update(resolution([
      match("selected", range(3, 0, 3, 4), "last"),
      match("selected", range(1, 0, 1, 9), "same-start-long"),
      match("selected", range(1, 5, 1, 8), "middle"),
      match("selected", range(1, 0, 1, 4), "same-start-short"),
    ]));

    harness.navigator.navigate(intent("next"));
    harness.navigator.navigate(intent("next"));
    harness.host.movePrimaryCursor({ line: 1, character: 9 });
    harness.navigator.navigate(intent("next"));

    expect(harness.host.revealed).toEqual([
      range(1, 0, 1, 4),
      range(1, 0, 1, 9),
      range(3, 0, 3, 4),
    ]);
  });

  it.each([
    ["before", position(0, 0), undefined],
    ["first start", position(1, 2), 0],
    ["inside first", position(1, 4), 0],
    ["first end", position(1, 5), undefined],
    ["between", position(1, 6), undefined],
    ["second start", position(1, 8), 1],
    ["inside second", position(1, 9), 1],
    ["second end", position(1, 10), undefined],
    ["third start", position(3, 0), 2],
    ["third end", position(3, 2), undefined],
    ["after", position(4, 0), undefined],
  ] as const)(
    "publishes the primary cursor state at %s",
    (_label, cursor, activeMatchIndex) => {
      const harness = navigatorHarness();
      harness.navigator.update(threeRangeResolution());
      harness.host.changePrimaryCursor(cursor);

      expect(harness.states.at(-1)).toEqual({
        inspectMessageId: "inspect-1",
        resolutionGeneration: 2,
        selectedMatchCount: 3,
        ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
      });
      expect(harness.host.cursorSets).toEqual([]);
      expect(harness.host.revealed).toEqual([]);
    },
  );

  it("ignores secondary selections when calculating the active range", () => {
    const harness = navigatorHarness();
    harness.navigator.update(threeRangeResolution());

    harness.host.changeSelections(position(0, 0), [position(1, 3)]);
    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      selectedMatchCount: 3,
    });

    harness.host.changeSelections(position(1, 3), [position(4, 0)]);
    expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex: 0 });
  });

  it.each([
    ["next before", "next", position(0, 0), range(1, 2, 1, 5)],
    ["previous before", "previous", position(0, 0), range(3, 0, 3, 2)],
    ["next between", "next", position(1, 6), range(1, 8, 1, 10)],
    ["previous between", "previous", position(1, 6), range(1, 2, 1, 5)],
    ["next after", "next", position(4, 0), range(1, 2, 1, 5)],
    ["previous after", "previous", position(4, 0), range(3, 0, 3, 2)],
    ["next at start", "next", position(1, 2), range(1, 8, 1, 10)],
    ["previous at start", "previous", position(1, 2), range(3, 0, 3, 2)],
    ["next at end", "next", position(1, 5), range(1, 8, 1, 10)],
    ["previous at end", "previous", position(1, 5), range(1, 2, 1, 5)],
    ["next wraps inside last", "next", position(3, 1), range(1, 2, 1, 5)],
    ["previous wraps inside first", "previous", position(1, 3), range(3, 0, 3, 2)],
  ] as const)(
    "%s",
    (_label, direction, cursor, expectedRange) => {
      const harness = navigatorHarness();
      harness.navigator.update(threeRangeResolution());
      harness.host.movePrimaryCursor(cursor);

      harness.navigator.navigate(intent(direction));

      expect(harness.host.cursorSets).toEqual([expectedRange.start]);
      expect(harness.host.revealed).toEqual([expectedRange]);
      expect(harness.states.at(-1)).toMatchObject({
        activeMatchIndex: rangeIndex(expectedRange),
      });
    },
  );

  it("ignores stale inspect IDs and resolution generations", () => {
    const harness = navigatorHarness();
    harness.navigator.update(threeRangeResolution());
    const published = harness.states.length;

    harness.navigator.navigate(intent("next", { inspectMessageId: "inspect-2" }));
    harness.navigator.navigate(intent("next", { resolutionGeneration: 1 }));

    expect(harness.host.cursorSets).toEqual([]);
    expect(harness.host.revealed).toEqual([]);
    expect(harness.states).toHaveLength(published);
  });

  it("publishes zero and does not navigate for a missing or mismatched editor", () => {
    const harness = navigatorHarness();
    harness.navigator.update({
      ...threeRangeResolution(),
      documentUri: "file:///workspace/other.scss",
    });

    expect(harness.states.at(-1)).toMatchObject({ selectedMatchCount: 0 });
    harness.navigator.navigate(intent("next"));
    expect(harness.host.cursorSets).toEqual([]);

    harness.host.changeActiveEditor("file:///workspace/other.scss");
    harness.navigator.navigate(intent("next"));
    expect(harness.host.cursorSets).toEqual([]);

    harness.navigator.update(threeRangeResolution("inspect-1", 3));
    expect(harness.states.at(-1)).toMatchObject({
      resolutionGeneration: 3,
      selectedMatchCount: 0,
    });

    harness.navigator.update({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 4,
      matches: [match("selected", range(1, 2, 1, 5))],
    });
    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 4,
      selectedMatchCount: 0,
    });
  });

  it("invalidates ranges when the active editor changes", () => {
    const harness = navigatorHarness();
    harness.navigator.update(threeRangeResolution());

    harness.host.changeActiveEditor("file:///workspace/other.scss");

    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      selectedMatchCount: 0,
    });
    harness.navigator.navigate(intent("next"));
    expect(harness.host.cursorSets).toEqual([]);
    expect(harness.host.revealed).toEqual([]);
  });

  it("begins generation zero immediately and invalidates while retaining identity", () => {
    const harness = navigatorHarness();
    harness.navigator.update(threeRangeResolution());

    harness.navigator.beginInspect("inspect-2");

    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-2",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
    });
    harness.navigator.navigate(intent("next"));
    expect(harness.host.cursorSets).toEqual([]);

    harness.navigator.update(threeRangeResolution("inspect-2", 0));
    harness.navigator.invalidate();
    expect(harness.states.at(-1)).toEqual({
      inspectMessageId: "inspect-2",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
    });
    expect(harness.host.cursorSets).toEqual([]);
    expect(harness.host.revealed).toEqual([]);
  });

  it("disposes listeners and ignores every later operation", () => {
    const harness = navigatorHarness();
    harness.navigator.update(threeRangeResolution());
    const published = harness.states.length;

    harness.navigator.dispose();
    harness.navigator.dispose();
    harness.host.changePrimaryCursor(position(1, 3));
    harness.host.changeActiveEditor("file:///workspace/other.scss");
    harness.navigator.beginInspect("inspect-2");
    harness.navigator.update(threeRangeResolution("inspect-2", 0));
    harness.navigator.invalidate();
    harness.navigator.navigate(intent("next", {
      inspectMessageId: "inspect-2",
      resolutionGeneration: 0,
    }));

    expect(harness.states).toHaveLength(published);
    expect(harness.host.cursorSets).toEqual([]);
    expect(harness.host.revealed).toEqual([]);
    expect(harness.host.disposals).toBe(2);
  });
});

function navigatorHarness(
  options: { readonly emitCursorEventOnSet?: boolean } = {},
) {
  const host = new MemorySourceNavigationHost(
    DOCUMENT_URI,
    options.emitCursorEventOnSet ?? false,
  );
  const states: SourceNavigationStateInput[] = [];
  const navigator = new SourceNavigator(host, {
    sendSourceNavigationState: (state) => states.push(state),
  });
  return { host, navigator, states };
}

class MemorySourceNavigationHost implements SourceNavigationHost {
  public primaryCursor: SourcePosition = position(0, 0);
  public secondaryCursors: readonly SourcePosition[] = [];
  public readonly cursorSets: SourcePosition[] = [];
  public readonly revealed: SourceRange[] = [];
  public disposals = 0;
  private nextCursorSetError: Error | undefined;
  private editor: SourceNavigationEditor | undefined;
  private readonly activeEditorListeners = new Set<() => void>();
  private readonly primaryCursorListeners = new Set<() => void>();

  public constructor(
    documentUri?: string,
    private readonly emitCursorEventOnSet = false,
  ) {
    this.editor = documentUri ? { documentUri } : undefined;
  }

  public getActiveEditor(): SourceNavigationEditor | undefined {
    return this.editor;
  }

  public getPrimaryCursor(_editor: SourceNavigationEditor): SourcePosition {
    return this.primaryCursor;
  }

  public setPrimaryCursor(
    _editor: SourceNavigationEditor,
    position_: SourcePosition,
  ): void {
    const error = this.nextCursorSetError;
    this.nextCursorSetError = undefined;
    if (error) throw error;
    this.primaryCursor = position_;
    this.cursorSets.push(position_);
    if (this.emitCursorEventOnSet) this.emitPrimaryCursorChange();
  }

  public revealRange(
    _editor: SourceNavigationEditor,
    range_: SourceRange,
  ): void {
    this.revealed.push(range_);
  }

  public onDidChangeActiveEditor(listener: () => void) {
    this.activeEditorListeners.add(listener);
    return {
      dispose: () => {
        if (this.activeEditorListeners.delete(listener)) this.disposals += 1;
      },
    };
  }

  public onDidChangePrimaryCursor(listener: () => void) {
    this.primaryCursorListeners.add(listener);
    return {
      dispose: () => {
        if (this.primaryCursorListeners.delete(listener)) this.disposals += 1;
      },
    };
  }

  public movePrimaryCursor(position_: SourcePosition): void {
    this.primaryCursor = position_;
  }

  public changePrimaryCursor(position_: SourcePosition): void {
    this.changeSelections(position_, []);
  }

  public changeSelections(
    primary: SourcePosition,
    secondary: readonly SourcePosition[],
  ): void {
    this.primaryCursor = primary;
    this.secondaryCursors = secondary;
    this.emitPrimaryCursorChange();
  }

  public failNextCursorSet(error: Error): void {
    this.nextCursorSetError = error;
  }

  public changeActiveEditor(documentUri?: string): void {
    this.editor = documentUri ? { documentUri } : undefined;
    for (const listener of this.activeEditorListeners) listener();
  }

  private emitPrimaryCursorChange(): void {
    for (const listener of this.primaryCursorListeners) listener();
  }
}

function expectLastNavigation(
  harness: ReturnType<typeof navigatorHarness>,
  expectedRange: SourceRange,
  activeMatchIndex: number,
  commandCount: number,
): void {
  expect(harness.host.cursorSets).toHaveLength(commandCount);
  expect(harness.host.cursorSets.at(-1)).toEqual(expectedRange.start);
  expect(harness.host.revealed).toHaveLength(commandCount);
  expect(harness.host.revealed.at(-1)).toEqual(expectedRange);
  expect(harness.states.at(-1)).toMatchObject({ activeMatchIndex });
}

function threeRangeResolution(
  inspectMessageId = "inspect-1",
  resolutionGeneration = 2,
): SourceNavigationResolution {
  return resolution([
    match("selected", range(1, 2, 1, 5), "first"),
    match("selected", range(1, 8, 1, 10), "second"),
    match("selected", range(3, 0, 3, 2), "third"),
  ], inspectMessageId, resolutionGeneration);
}

function resolution(
  matches: readonly ResolvedSourceMatch[],
  inspectMessageId = "inspect-1",
  resolutionGeneration = 2,
): SourceNavigationResolution {
  return {
    inspectMessageId,
    resolutionGeneration,
    documentUri: DOCUMENT_URI,
    matches,
  };
}

function match(
  targetRole: "selected" | "parent",
  range_: SourceRange,
  pluginId = "fixture.source",
): ResolvedSourceMatch {
  return {
    pluginId,
    targetRole,
    range: range_,
    label: pluginId,
    kind: "style-rule",
    relation: "styles",
    confidence: "exact",
  };
}

function intent(
  direction: SourceNavigateMessage["direction"],
  overrides: Partial<
    Pick<SourceNavigateMessage, "inspectMessageId" | "resolutionGeneration">
  > = {},
): SourceNavigateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigate",
    messageId: `navigate-${direction}`,
    sessionId: "session-1",
    inspectMessageId: overrides.inspectMessageId ?? "inspect-1",
    resolutionGeneration: overrides.resolutionGeneration ?? 2,
    direction,
    metadata: {},
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): SourceRange {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter),
  };
}

function position(line: number, character: number): SourcePosition {
  return { line, character };
}

function rangeIndex(range_: SourceRange): number {
  if (range_.start.line === 1 && range_.start.character === 2) return 0;
  if (range_.start.line === 1 && range_.start.character === 8) return 1;
  return 2;
}
