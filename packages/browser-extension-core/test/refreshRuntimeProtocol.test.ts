import { PROTOCOL_VERSION } from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPanelTabStateMessage,
  parsePanelTabSettingsCommand,
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  parseRefreshExecutionCommand,
  parseTabRefreshState,
} from "../src/refreshRuntimeProtocol.js";

describe("refresh runtime protocol", () => {
  it("parses strict tab state and refresh envelopes", () => {
    const state = {
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 9,
      pending: { generation: 9, mode: "styles" },
    } as const;

    expect(parseTabRefreshState(state)).toEqual(state);
    expect(
      parseTabRefreshState({
        ...state,
        autoRefreshEnabled: false,
        participant: false,
        pending: undefined,
      }),
    ).toEqual({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 9,
    });
    expect(
      parseTabRefreshState({
        ...state,
        autoRefreshEnabled: false,
        pending: undefined,
      }),
    ).toBeUndefined();
    expect(
      parseRefreshExecutionCommand({
        type: "pin-op.refresh.execute",
        refreshGeneration: 9,
        mode: "reload",
      }),
    ).toEqual({
      type: "pin-op.refresh.execute",
      refreshGeneration: 9,
      mode: "reload",
    });
    expect(
      parsePanelTabSettingsCommand({
        type: "pin-op.tab.settings",
        autoRefreshEnabled: false,
        ideHighlightEnabled: true,
      }),
    ).toEqual({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
  });

  it("rejects unknown, missing, malformed, and accessor-backed fields", () => {
    const state = {
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 9,
    } as const;
    expect(parseTabRefreshState({ ...state, source: "secret" })).toBeUndefined();
    expect(
      parseTabRefreshState({ ...state, ideHighlightEnabled: undefined }),
    ).toBeUndefined();
    expect(
      parseTabRefreshState({
        ...state,
        pending: { generation: 10, mode: "styles", uri: "file:///secret" },
      }),
    ).toBeUndefined();
    expect(
      parseRefreshExecutionCommand({
        type: "pin-op.refresh.execute",
        refreshGeneration: -1,
        mode: "styles",
      }),
    ).toBeUndefined();
    expect(
      parsePanelTabSettingsCommand({
        type: "pin-op.tab.settings",
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        tabId: 11,
      }),
    ).toBeUndefined();

    const getter = vi.fn(() => 11);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "tabId", { enumerable: true, get: getter });
    Object.assign(hostile, {
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 0,
    });
    expect(parseTabRefreshState(hostile)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("creates and parses panel snapshots without browser routing IDs", () => {
    const message = createPanelTabStateMessage({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 5,
      pending: { generation: 5, mode: "reload" },
    });

    expect(message).toEqual({
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 5,
      pending: { generation: 5, mode: "reload" },
    });
    expect(parsePanelTabStateMessage(message)).toEqual(message);
    expect(message).not.toHaveProperty("tabId");
    expect(message).not.toHaveProperty("windowId");
  });

  it("parses compatible and known or unknown incompatible status exactly", () => {
    expect(
      parseProtocolCompatibilityMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      }),
    ).toEqual({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    expect(
      parseProtocolCompatibilityMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: "unknown",
      }),
    ).toEqual({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: "unknown",
    });
    expect(
      parseProtocolCompatibilityMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: 5,
        reason: "details",
      }),
    ).toBeUndefined();
  });
});
