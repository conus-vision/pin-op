import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { InspectCorrelationStore } from "../src/inspectCorrelationStore.js";

describe("InspectCorrelationStore", () => {
  it("routes only increasing resolution generations to the recorded channel", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7);

    expect(store.accept(resolution("inspect-a", 2))).toBe("panel-a");
    expect(store.accept(resolution("inspect-a", 2))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3))).toBe("panel-a");
    expect(store.accept(resolution("inspect-missing", 1))).toBeUndefined();
  });

  it("removes a failed send without disturbing other correlations", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7);
    store.record("panel-b", "inspect-b", 8);

    store.discard("inspect-a");

    expect(store.accept(resolution("inspect-a", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1))).toBe("panel-b");
  });

  it("keeps only the newest inspect correlation for each panel channel", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a-old", 7);
    store.record("panel-b", "inspect-b", 8);

    store.record("panel-a", "inspect-a-current", 7);

    expect(store.accept(resolution("inspect-a-old", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1))).toBe("panel-b");
    expect(store.accept(resolution("inspect-a-current", 1))).toBe("panel-a");
  });

  it("is bounded by least-recently-used correlations", () => {
    const store = new InspectCorrelationStore(2);
    store.record("panel-a", "inspect-a", 7);
    store.record("panel-b", "inspect-b", 8);
    expect(store.accept(resolution("inspect-a", 1))).toBe("panel-a");

    store.record("panel-c", "inspect-c", 9);

    expect(store.accept(resolution("inspect-b", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 2))).toBe("panel-a");
    expect(store.accept(resolution("inspect-c", 1))).toBe("panel-c");
  });

  it("drops every correlation owned by a disposed panel channel", () => {
    const store = new InspectCorrelationStore(256);
    store.record("panel-a", "inspect-a", 7);
    store.record("panel-a", "inspect-b", 7);
    store.record("panel-b", "inspect-c", 8);

    store.disposeChannel("panel-a");

    expect(store.accept(resolution("inspect-a", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1))).toBeUndefined();
    expect(store.accept(resolution("inspect-c", 1))).toBe("panel-b");
  });

  it("repeatedly accepts navigation state only at the current resolution generation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7);
    expect(store.accept(resolution("inspect-a", 2))).toBe("panel-a");
    const current = sourceNavigationState("inspect-a", 2, 0);

    expect(store.acceptNavigationState(current)).toBe("panel-a");
    expect(store.acceptNavigationState(current)).toBe("panel-a");
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-a", 1)),
    ).toBeUndefined();
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-missing", 2)),
    ).toBeUndefined();
    expect(store.acceptNavigationState({
      ...current,
      activeMatchIndex: 2,
    } as SourceNavigationStateMessage)).toBeUndefined();

    expect(store.accept(resolution("inspect-a", 2))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3))).toBe("panel-a");
    expect(store.acceptNavigationState(current)).toBeUndefined();
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-a", 3)),
    ).toBe("panel-a");
  });

  it("repeatedly authorizes only the exact current navigation correlation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7);
    expect(store.accept(resolution("inspect-a", 2))).toBe("panel-a");
    const current = {
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 2,
      tabId: 7,
    };

    expect(store.authorizeNavigation(current)).toBe(true);
    expect(store.authorizeNavigation(current)).toBe(true);
    expect(store.authorizeNavigation({
      ...current,
      inspectMessageId: "inspect-missing",
    })).toBe(false);
    expect(store.authorizeNavigation({
      ...current,
      resolutionGeneration: 1,
    })).toBe(false);
    expect(store.authorizeNavigation({
      ...current,
      channel: "panel-b",
    })).toBe(false);
    expect(store.authorizeNavigation({ ...current, tabId: 8 })).toBe(false);

    expect(store.accept(resolution("inspect-a", 2))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3))).toBe("panel-a");
  });

  it("authorizes source open only for the exact published IDE match authority", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10);
    expect(store.accept(matchedResolution("inspect-a", 1))).toBe("panel-a");
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1))).toBe(
      "panel-a",
    );
    const current = sourceOpenAuthority();

    expect(store.authorizeSourceOpen(current)).toBe(true);
    expect(store.authorizeSourceOpen(current)).toBe(true);
    expect(store.authorizeSourceOpen({ ...current, matchId: "unknown" })).toBe(false);
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 0,
    })).toBe(false);
    expect(store.authorizeSourceOpen({ ...current, channel: "panel-b" })).toBe(false);
    expect(store.authorizeSourceOpen({ ...current, tabId: 8 })).toBe(false);
    expect(store.authorizeSourceOpen({ ...current, windowId: 11 })).toBe(false);
    expect(store.authorizeSourceOpen({ ...current, sessionId: "session-b" })).toBe(false);
    expect(store.authorizeSourceOpen({
      ...current,
      source: { role: "ide", id: "vscode-b" },
    })).toBe(false);
    expect(store.authorizeSourceOpen({ ...current, uri: "file:///card.scss" })).toBe(false);
  });

  it("requires a current resolution for nonempty matches and accepts empty pre-resolution invalidation without authority", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10);

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 9, {
      matches: [],
    }))).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenAuthority())).toBe(false);

    expect(store.accept(matchedResolution("inspect-a", 1))).toBe("panel-a");
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1))).toBe(
      "panel-a",
    );
    expect(store.authorizeSourceOpen(sourceOpenAuthority())).toBe(true);

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [],
    }))).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenAuthority())).toBe(false);
  });

  it("rejects stale, foreign, and duplicate match publications atomically", () => {
    const store = readySourceStore();
    const current = sourceOpenAuthority();

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 0))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-b", 1))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      sourceId: "vscode-b",
    }))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      sessionId: "session-b",
    }))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      documentLabel: "other.scss",
    }))).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [excerpt("selected-1"), excerpt("selected-1")],
    }))).toBeUndefined();

    expect(store.authorizeSourceOpen(current)).toBe(true);
  });

  it("revokes source IDs on a new resolution, inspect, channel rebind, tab move, or unlink", () => {
    const store = readySourceStore();
    const current = sourceOpenAuthority();

    expect(store.accept(matchedResolution("inspect-a", 2))).toBe("panel-a");
    expect(store.authorizeSourceOpen(current)).toBe(false);
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 2))).toBe(
      "panel-a",
    );
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 2,
    })).toBe(true);

    store.record("panel-a", "inspect-b", 7, 10);
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 2,
    })).toBe(false);

    store.record("panel-a", "inspect-a", 7, 10);
    store.accept(matchedResolution("inspect-a", 1));
    store.acceptSourceMatches(sourceMatches("inspect-a", 1));
    store.disposeTab(7);
    expect(store.authorizeSourceOpen(current)).toBe(false);

    store.record("panel-a", "inspect-a", 7, 10);
    store.accept(matchedResolution("inspect-a", 1));
    store.acceptSourceMatches(sourceMatches("inspect-a", 1));
    store.disposeChannel("panel-a");
    expect(store.authorizeSourceOpen(current)).toBe(false);
  });

  it("rejects accessor-backed source authority without invoking it", () => {
    const store = readySourceStore();
    let getterCalls = 0;
    const hostile = sourceOpenAuthority() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "matchId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });

    expect(() => store.authorizeSourceOpen(hostile)).not.toThrow();
    expect(store.authorizeSourceOpen(hostile)).toBe(false);
    expect(getterCalls).toBe(0);
  });
});

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
    status: "no-active-editor",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function matchedResolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    ...resolution(inspectMessageId, resolutionGeneration),
    status: "matched",
    document: { label: "card.scss", languageId: "scss" },
    selectedMatchCount: 1,
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
    matches: overrides.matches ?? [excerpt("selected-1")],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function excerpt(matchId: string): SourceExcerpt {
  return {
    matchId,
    targetRole: "selected",
    label: `${matchId}.scss:1`,
    kind: "rule",
    relation: "selected",
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: `.${matchId} {\n  color: red;\n}`,
    truncated: false,
  };
}

function sourceOpenAuthority() {
  return {
    channel: "panel-a",
    tabId: 7,
    windowId: 10,
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    matchId: "selected-1",
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
  } as const;
}

function readySourceStore(): InspectCorrelationStore {
  const store = new InspectCorrelationStore(4);
  store.record("panel-a", "inspect-a", 7, 10);
  store.accept(matchedResolution("inspect-a", 1));
  store.acceptSourceMatches(sourceMatches("inspect-a", 1));
  return store;
}

function sourceNavigationState(
  inspectMessageId: string,
  resolutionGeneration: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    selectedMatchCount: activeMatchIndex === undefined ? 0 : 2,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}
