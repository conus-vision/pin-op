import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
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
