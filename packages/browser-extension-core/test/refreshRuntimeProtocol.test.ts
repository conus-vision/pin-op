import { PROTOCOL_VERSION } from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPanelTabStateMessage,
  parseContentRefreshBootstrapRequest,
  parseContentRefreshBootstrapResult,
  parseContentRefreshCommand,
  parseContentRefreshReadyRequest,
  parseContentRefreshResult,
  parseReloadTabRequest,
  parseReloadTabResult,
  parseScrollRestoreCommand,
  parsePanelTabSettingsCommand,
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  parseRefreshExecutionCommand,
  parseTabRefreshState,
} from "../src/refreshRuntimeProtocol.js";

describe("refresh runtime protocol", () => {
  it("parses strict unbound content bootstrap envelopes", () => {
    expect(parseContentRefreshBootstrapRequest({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    })).toEqual({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    });
    expect(parseContentRefreshBootstrapResult({
      type: "pin-op.refresh.content.bootstrap.result",
      accepted: true,
      tabId: 11,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    })).toEqual({
      type: "pin-op.refresh.content.bootstrap.result",
      accepted: true,
      tabId: 11,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    });
    expect(parseContentRefreshBootstrapRequest({
      type: "pin-op.refresh.content.bootstrap",
      tabId: 11,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    })).toBeUndefined();
    expect(parseContentRefreshBootstrapResult({
      type: "pin-op.refresh.content.bootstrap.result",
      accepted: true,
      tabId: 11,
      frameId: 1,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    })).toBeUndefined();
  });

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

  it("parses exact top-frame refresh, reload, and restore boundaries", () => {
    const binding = {
      tabId: 11,
      frameId: 0 as const,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
    };
    const snapshot = {
      tabId: 11,
      url: binding.pageUrl,
      refreshGeneration: 9,
      scrollX: 10,
      scrollY: 20,
      createdAt: 1_000,
    };
    expect(parseContentRefreshReadyRequest({
      type: "pin-op.refresh.content.ready",
      ...binding,
    })).toEqual({
      type: "pin-op.refresh.content.ready",
      ...binding,
    });
    expect(parseContentRefreshCommand({
      type: "pin-op.refresh.content.execute",
      ...binding,
      refreshGeneration: 9,
      mode: "styles",
    })).toEqual({
      type: "pin-op.refresh.content.execute",
      ...binding,
      refreshGeneration: 9,
      mode: "styles",
    });
    expect(parseReloadTabRequest({
      type: "pin-op.refresh.reload.request",
      ...binding,
      refreshGeneration: 9,
      snapshot,
    })).toEqual({
      type: "pin-op.refresh.reload.request",
      ...binding,
      refreshGeneration: 9,
      snapshot,
    });
    expect(parseReloadTabResult({
      type: "pin-op.refresh.reload.result",
      ...binding,
      refreshGeneration: 9,
      accepted: true,
    })).toEqual({
      type: "pin-op.refresh.reload.result",
      ...binding,
      refreshGeneration: 9,
      accepted: true,
    });
    expect(parseScrollRestoreCommand({
      type: "pin-op.refresh.scroll.restore",
      ...binding,
      refreshGeneration: 9,
      snapshot,
    })).toEqual({
      type: "pin-op.refresh.scroll.restore",
      ...binding,
      refreshGeneration: 9,
      snapshot,
    });
    expect(parseContentRefreshResult({
      type: "pin-op.refresh.content.result",
      ...binding,
      refreshGeneration: 9,
      mode: "styles",
      accepted: true,
      stylesheet: { attempted: 2, updated: 1, failed: 1 },
    })).toEqual({
      type: "pin-op.refresh.content.result",
      ...binding,
      refreshGeneration: 9,
      mode: "styles",
      accepted: true,
      stylesheet: { attempted: 2, updated: 1, failed: 1 },
    });
  });

  it("rejects child-frame, mismatched snapshot, extra-key, and completion-shaped refresh messages", () => {
    const binding = {
      tabId: 11,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "runtime-a",
      refreshGeneration: 9,
    };
    expect(parseContentRefreshCommand({
      type: "pin-op.refresh.content.execute",
      ...binding,
      frameId: 1,
      mode: "reload",
    })).toBeUndefined();
    expect(parseContentRefreshCommand({
      type: "pin-op.refresh.content.execute",
      ...binding,
      mode: "reload",
      path: "/secret",
    })).toBeUndefined();
    expect(parseReloadTabRequest({
      type: "pin-op.refresh.reload.request",
      ...binding,
      snapshot: {
        tabId: 12,
        url: binding.pageUrl,
        refreshGeneration: 9,
        scrollX: 0,
        scrollY: 0,
        createdAt: 1_000,
      },
    })).toBeUndefined();
    expect(parseReloadTabResult({
      type: "pin-op.refresh.reload.result",
      ...binding,
      accepted: true,
      navigationCompleted: true,
    })).toBeUndefined();
    expect(parseScrollRestoreCommand({
      type: "pin-op.refresh.scroll.restore",
      ...binding,
      snapshot: {
        tabId: 11,
        url: binding.pageUrl,
        refreshGeneration: 8,
        scrollX: 0,
        scrollY: 0,
        createdAt: 1_000,
      },
    })).toBeUndefined();
  });
});
