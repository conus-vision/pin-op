import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import { SourcePaneController } from "../src/sourcePaneController.js";

describe("SourcePaneController", () => {
  it("requires the authoritative current resolution before accepting matches", () => {
    const dispatch = vi.fn();
    const controller = new SourcePaneController(dispatch);
    controller.setCompatible(true);
    controller.beginInspect("inspect-a");

    expect(controller.acceptMatches(sourceMatches("inspect-a", 1))).toBe(
      "rejected",
    );
    expect(controller.snapshot().groups.selected.matches).toEqual([]);
    expect(controller.open("selected-1")).toBe(false);

    expect(controller.acceptResolution(resolution("inspect-a", 1))).toBe(true);
    expect(controller.acceptMatches(sourceMatches("inspect-a", 2))).toBe(
      "rejected",
    );
    expect(controller.acceptMatches(sourceMatches("inspect-b", 1))).toBe(
      "rejected",
    );
    expect(controller.acceptMatches(sourceMatches("inspect-a", 1, {
      sourceId: "other-ide",
    }))).toBe("rejected");
    expect(controller.acceptMatches(sourceMatches("inspect-a", 1, {
      sessionId: "other-session",
    }))).toBe("rejected");
    expect(controller.acceptMatches(sourceMatches("inspect-a", 1, {
      documentLabel: "other.scss",
    }))).toBe("rejected");

    expect(controller.acceptMatches(sourceMatches("inspect-a", 1))).toBe(
      "published",
    );
    expect(controller.snapshot().groups.selected.matches).toHaveLength(2);
  });

  it("treats empty pre-resolution messages as invalidation without granting authority", () => {
    const dispatch = vi.fn();
    const controller = new SourcePaneController(dispatch);
    controller.setCompatible(true);
    controller.beginInspect("inspect-a");

    expect(controller.acceptMatches(sourceMatches("inspect-a", 9, {
      matches: [],
      omittedMatchCount: 0,
    }))).toBe("invalidated");
    expect(controller.snapshot().groups.selected.matches).toEqual([]);
    expect(controller.open("selected-1")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    const matches = sourceMatches("inspect-a", 9);
    expect(controller.acceptMatches(matches)).toBe("rejected");
    expect(controller.acceptResolution(resolution("inspect-a", 9))).toBe(true);
    expect(controller.acceptMatches(matches)).toBe("published");
  });

  it("publishes authoritative empty matches with document metadata", () => {
    const controller = readyController();

    expect(controller.acceptMatches(sourceMatches("inspect-a", 1, {
      matches: [],
      omittedMatchCount: 2,
    }))).toBe("published");
    expect(controller.snapshot()).toMatchObject({
      document: { label: "card.scss", languageId: "scss" },
      groups: {
        selected: { matches: [] },
        parent: { matches: [] },
      },
      omittedMatchCount: 2,
    });
    expect(controller.open("selected-1")).toBe(false);
  });

  it("preserves IDE order in immutable Selected and Parent groups", () => {
    const controller = new SourcePaneController(vi.fn());
    controller.setCompatible(true);
    controller.beginInspect("inspect-a");
    controller.acceptResolution(resolution("inspect-a", 1));

    expect(controller.acceptMatches(sourceMatches("inspect-a", 1))).toBe(
      "published",
    );
    const snapshot = controller.snapshot();
    expect(snapshot.groups.selected.matches.map((match) => match.matchId)).toEqual([
      "selected-1",
      "selected-2",
    ]);
    expect(snapshot.groups.parent.matches.map((match) => match.matchId)).toEqual([
      "parent-1",
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.groups)).toBe(true);
    expect(Object.isFrozen(snapshot.groups.selected)).toBe(true);
    expect(Object.isFrozen(snapshot.groups.selected.matches)).toBe(true);
    expect(Object.isFrozen(snapshot.groups.selected.matches[0])).toBe(true);
    expect(snapshot.groups.selected.collapsed).toBe(false);
    expect(snapshot.groups.parent.collapsed).toBe(true);
  });

  it("takes bounded data-only snapshots without invoking hostile accessors", () => {
    const controller = new SourcePaneController(vi.fn());
    controller.setCompatible(true);
    controller.beginInspect("inspect-a");
    expect(controller.acceptResolution(resolution("inspect-a", 1))).toBe(true);

    const getter = vi.fn(() => sourceMatches("inspect-a", 1).matches);
    const hostile = sourceMatches("inspect-a", 1) as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostile, "matches", {
      enumerable: true,
      get: getter,
    });

    expect(() => controller.acceptMatches(hostile)).not.toThrow();
    expect(controller.acceptMatches(hostile)).toBe("rejected");
    expect(getter).not.toHaveBeenCalled();

    const accepted = sourceMatches("inspect-a", 1);
    expect(controller.acceptMatches(accepted)).toBe("published");
    (accepted.matches[0] as { label: string }).label = "mutated";
    expect(controller.snapshot().groups.selected.matches[0]?.label).toBe(
      "selected-1.scss:1",
    );
  });

  it("tracks only a currently published active match ID", () => {
    const controller = readyController();

    expect(controller.acceptNavigationState(navigationState("parent-1"))).toBe(true);
    expect(controller.snapshot().activeMatchId).toBe("parent-1");
    expect(controller.acceptNavigationState(navigationState("missing"))).toBe(false);
    expect(controller.snapshot().activeMatchId).toBe("parent-1");
    expect(controller.acceptNavigationState(navigationState(undefined))).toBe(true);
    expect(controller.snapshot().activeMatchId).toBeUndefined();
  });

  it("opens an exact opaque match without forwarding source data", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);

    expect(controller.open("parent-1")).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "pin-op.source.open",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      matchId: "parent-1",
    });
    expect(Object.keys(dispatch.mock.calls[0]![0]).sort()).toEqual([
      "inspectMessageId",
      "matchId",
      "resolutionGeneration",
      "type",
    ]);
    expect(controller.open("missing")).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("revokes every match on a new inspect, invalidation, disconnect, rebind, or mismatch", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);

    controller.beginInspect("inspect-b");
    expect(controller.open("selected-1")).toBe(false);

    controller.acceptResolution(resolution("inspect-b", 1));
    controller.acceptMatches(sourceMatches("inspect-b", 1));
    controller.invalidate();
    expect(controller.open("selected-1")).toBe(false);

    controller.beginInspect("inspect-disconnected");
    controller.acceptResolution(resolution("inspect-disconnected", 1));
    controller.acceptMatches(sourceMatches("inspect-disconnected", 1));
    controller.disconnect();
    expect(controller.open("selected-1")).toBe(false);

    controller.beginInspect("inspect-c");
    controller.acceptResolution(resolution("inspect-c", 1));
    controller.acceptMatches(sourceMatches("inspect-c", 1));
    controller.beginBinding();
    expect(controller.open("selected-1")).toBe(false);

    controller.beginInspect("inspect-d");
    controller.acceptResolution(resolution("inspect-d", 1));
    controller.acceptMatches(sourceMatches("inspect-d", 1));
    controller.setCompatible(false);
    expect(controller.open("selected-1")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects duplicate match IDs atomically", () => {
    const controller = readyController();
    const duplicate = excerpt("selected-1", "parent");

    expect(controller.acceptMatches(sourceMatches("inspect-a", 1, {
      matches: [excerpt("selected-1", "selected"), duplicate],
    }))).toBe("rejected");
    expect(controller.snapshot().groups.selected.matches).toHaveLength(2);
    expect(controller.snapshot().groups.parent.matches).toHaveLength(1);
  });
});

function readyController(dispatch = vi.fn()): SourcePaneController {
  const controller = new SourcePaneController(dispatch);
  controller.setCompatible(true);
  controller.beginInspect("inspect-a");
  controller.acceptResolution(resolution("inspect-a", 1));
  controller.acceptMatches(sourceMatches("inspect-a", 1));
  return controller;
}

function resolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    status: "matched",
    selectedMatchCount: 2,
    parentMatchCount: 1,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function sourceMatches(
  inspectMessageId: string,
  resolutionGeneration: number,
  overrides: {
    readonly sourceId?: string;
    readonly sessionId?: string;
    readonly documentLabel?: string;
    readonly matches?: readonly SourceExcerpt[];
    readonly omittedMatchCount?: number;
  } = {},
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: overrides.sessionId ?? "session-a",
    source: { role: "ide", id: overrides.sourceId ?? "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: {
      label: overrides.documentLabel ?? "card.scss",
      languageId: "scss",
    },
    matches: overrides.matches ?? [
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("selected-2", "selected"),
    ],
    omittedMatchCount: overrides.omittedMatchCount ?? 0,
    metadata: {},
  };
}

function excerpt(
  matchId: string,
  targetRole: "selected" | "parent",
): SourceExcerpt {
  return {
    matchId,
    targetRole,
    label: `${matchId}.scss:1`,
    kind: "rule",
    relation: targetRole,
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: `.${matchId} {\n  color: red;\n}`,
    truncated: false,
  };
}

function navigationState(
  activeMatchId: string | undefined,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `navigation-${activeMatchId ?? "none"}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    selectedMatchCount: 2,
    ...(activeMatchId === undefined ? {} : { activeMatchId }),
    metadata: {},
  };
}
