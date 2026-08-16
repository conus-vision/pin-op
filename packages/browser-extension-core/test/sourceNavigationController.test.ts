import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import { SourceNavigationController } from "../src/sourceNavigationController.js";

describe("SourceNavigationController", () => {
  it("moves from resolving through matched resolution to current cursor state", () => {
    const controller = new SourceNavigationController(vi.fn());

    controller.beginInspect("inspect-1");
    expect(controller.snapshot()).toMatchObject({
      visible: false,
      reserveRowSpace: true,
      disabled: true,
      selectedMatchCount: 0,
      counter: "",
    });

    controller.acceptResolution(resolution({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      selectedMatchCount: 4,
    }));
    expect(controller.snapshot()).toMatchObject({
      visible: true,
      reserveRowSpace: true,
      disabled: true,
      selectedMatchCount: 4,
      counter: "- / 4",
    });

    controller.acceptState(state({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      selectedMatchCount: 4,
      activeMatchIndex: 1,
    }));
    expect(controller.snapshot()).toEqual({
      visible: true,
      reserveRowSpace: true,
      disabled: false,
      selectedMatchCount: 4,
      activeMatchIndex: 1,
      counter: "2 / 4",
    });
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
  });

  it("accepts repeated cursor states for the same resolution generation", () => {
    const controller = readyController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.acceptState(state({ activeMatchIndex: 0 }));
    controller.acceptState(state({ activeMatchIndex: 3 }));
    controller.acceptState(state({ activeMatchIndex: undefined }));

    expect(listener).toHaveBeenCalledTimes(3);
    expect(controller.snapshot()).toMatchObject({
      disabled: false,
      counter: "- / 4",
    });
    expect(controller.snapshot()).not.toHaveProperty("activeMatchIndex");
  });

  it("rejects stale inspect identities, generations, and count mismatches", () => {
    const controller = readyController();
    controller.acceptState(state({ activeMatchIndex: 1 }));
    const current = controller.snapshot();

    controller.acceptResolution(resolution({
      inspectMessageId: "inspect-stale",
      resolutionGeneration: 4,
      selectedMatchCount: 2,
    }));
    controller.acceptResolution(resolution({
      resolutionGeneration: 2,
      selectedMatchCount: 2,
    }));
    controller.acceptState(state({
      inspectMessageId: "inspect-stale",
      activeMatchIndex: 2,
    }));
    controller.acceptState(state({
      resolutionGeneration: 2,
      activeMatchIndex: 2,
    }));
    controller.acceptState(state({
      selectedMatchCount: 3,
      activeMatchIndex: 2,
    }));

    expect(controller.snapshot()).toBe(current);
  });

  it("hides parent-only controls and clears resolving row space at zero matches", () => {
    const controller = new SourceNavigationController(vi.fn());
    controller.beginInspect("inspect-1");

    controller.acceptResolution(resolution({
      selectedMatchCount: 0,
      parentMatchCount: 3,
    }));

    expect(controller.snapshot()).toEqual({
      visible: false,
      reserveRowSpace: false,
      disabled: true,
      selectedMatchCount: 0,
      counter: "",
    });
  });

  it("invalidates current state and removes disposed listeners", () => {
    const controller = readyController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.acceptState(state({ activeMatchIndex: 1 }));
    unsubscribe();

    controller.invalidate();

    expect(listener).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toEqual({
      visible: false,
      reserveRowSpace: false,
      disabled: true,
      selectedMatchCount: 0,
      counter: "",
    });
  });

  it("dispatches both directions with the exact current correlation identity", () => {
    const dispatch = vi.fn();
    const controller = new SourceNavigationController(dispatch);
    controller.beginInspect("inspect-current");
    controller.acceptResolution(resolution({
      inspectMessageId: "inspect-current",
      resolutionGeneration: 7,
      selectedMatchCount: 2,
    }));

    controller.navigate("next");
    expect(dispatch).not.toHaveBeenCalled();

    controller.acceptState(state({
      inspectMessageId: "inspect-current",
      resolutionGeneration: 7,
      selectedMatchCount: 2,
      activeMatchIndex: undefined,
    }));
    controller.navigate("previous");
    controller.navigate("next");

    expect(dispatch.mock.calls).toEqual([
      [{
        type: "pinop.source.navigate",
        inspectMessageId: "inspect-current",
        resolutionGeneration: 7,
        direction: "previous",
      }],
      [{
        type: "pinop.source.navigate",
        inspectMessageId: "inspect-current",
        resolutionGeneration: 7,
        direction: "next",
      }],
    ]);
  });
});

function readyController(): SourceNavigationController {
  const controller = new SourceNavigationController(vi.fn());
  controller.beginInspect("inspect-1");
  controller.acceptResolution(resolution({
    resolutionGeneration: 3,
    selectedMatchCount: 4,
  }));
  return controller;
}

function resolution(
  overrides: Partial<ResolutionMessage> = {},
): ResolutionMessage {
  const status = overrides.status ?? "matched";
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 3,
    status,
    selectedMatchCount: status === "matched" ? 4 : 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
    ...overrides,
  };
}

function state(
  overrides: Partial<SourceNavigationStateMessage> = {},
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: "state-1",
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 3,
    selectedMatchCount: 4,
    metadata: {},
    ...overrides,
  };
}
