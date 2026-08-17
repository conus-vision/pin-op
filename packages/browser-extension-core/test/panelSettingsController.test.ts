import { PROTOCOL_VERSION } from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import { PanelSettingsController } from "../src/panelSettingsController.js";

describe("PanelSettingsController", () => {
  it("shows both settings on by default but sends nothing before a compatible tab snapshot", () => {
    const dispatch = vi.fn();
    const controller = new PanelSettingsController(dispatch);

    expect(controller.snapshot()).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      compatibility: "pending",
      snapshotReady: false,
      controlsEnabled: false,
    });
    expect(controller.setAutoRefreshEnabled(false)).toBe(false);
    expect(controller.setIdeHighlightEnabled(false)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    controller.acceptTabState(tabState(false, false));
    expect(controller.snapshot().snapshotReady).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends both tab booleans atomically and keeps Auto Refresh independent", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);

    expect(controller.setAutoRefreshEnabled(false)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
    expect(controller.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("persists Highlight without presentation traffic when no inspect is current", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);

    expect(controller.setIdeHighlightEnabled(false)).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    }]]);
  });

  it("sends exact presentation settings for the current inspect", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);
    expect(controller.beginInspect("inspect-a")).toBe(true);

    expect(controller.setIdeHighlightEnabled(false)).toBe(true);
    expect(dispatch.mock.calls).toEqual([
      [{
        type: "pin-op.tab.settings",
        autoRefreshEnabled: true,
        ideHighlightEnabled: false,
      }],
      [{
        type: "pin-op.presentation.settings",
        inspectMessageId: "inspect-a",
        ideHighlightEnabled: false,
      }],
    ]);
    expect(Object.keys(dispatch.mock.calls[1]![0]).sort()).toEqual([
      "ideHighlightEnabled",
      "inspectMessageId",
      "type",
    ]);
  });

  it("blocks on mismatch and requires compatible, a fresh snapshot, and a fresh inspect", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);
    controller.beginInspect("inspect-a");

    controller.acceptCompatibility({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    expect(controller.snapshot()).toMatchObject({
      compatibility: "incompatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    expect(controller.setIdeHighlightEnabled(false)).toBe(false);

    controller.acceptWindowState("linked");
    expect(controller.snapshot().controlsEnabled).toBe(false);
    controller.acceptCompatibility(compatible());
    expect(controller.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    expect(controller.beginInspect("inspect-stale")).toBe(false);
    controller.acceptTabState(tabState(true, true));
    expect(controller.snapshot().controlsEnabled).toBe(true);
    expect(controller.setIdeHighlightEnabled(false)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    expect(dispatch.mock.calls.some(([message]) =>
      (message as { type?: string }).type === "pin-op.presentation.settings"
    )).toBe(false);

    expect(controller.beginInspect("inspect-fresh")).toBe(true);
    expect(controller.setIdeHighlightEnabled(true)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "pin-op.presentation.settings",
      inspectMessageId: "inspect-fresh",
      ideHighlightEnabled: true,
    });
  });

  it("revokes command authority on port rebind without replaying old commands", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);
    controller.beginInspect("inspect-a");
    controller.setIdeHighlightEnabled(false);
    dispatch.mockClear();

    controller.beginBinding();
    controller.acceptCompatibility(compatible());
    expect(controller.snapshot()).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      snapshotReady: false,
    });
    expect(controller.setAutoRefreshEnabled(false)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    controller.acceptTabState(tabState(false, false));
    expect(dispatch).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
  });

  it("strictly rejects malformed tab and compatibility snapshots", () => {
    const dispatch = vi.fn();
    const controller = new PanelSettingsController(dispatch);

    expect(controller.acceptCompatibility({ ...compatible(), extra: true })).toBe(false);
    expect(controller.acceptTabState({ ...tabState(true, true), extra: true })).toBe(false);
    expect(controller.snapshot().controlsEnabled).toBe(false);
  });

  it("rejects accessor-backed snapshots without invoking them", () => {
    const controller = new PanelSettingsController(vi.fn());
    expect(controller.acceptCompatibility(compatible())).toBe(true);
    const getter = vi.fn(() => true);
    const hostile = tabState(true, true) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "autoRefreshEnabled", {
      enumerable: true,
      get: getter,
    });

    expect(() => controller.acceptTabState(hostile)).not.toThrow();
    expect(controller.acceptTabState(hostile)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(controller.snapshot().controlsEnabled).toBe(false);
  });

  it("revokes readiness and current inspect when the window disconnects", () => {
    const dispatch = vi.fn();
    const controller = readyController(dispatch);
    expect(controller.beginInspect("inspect-a")).toBe(true);

    controller.acceptWindowState("offline");

    expect(controller.snapshot()).toMatchObject({
      compatibility: "pending",
      snapshotReady: false,
      controlsEnabled: false,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });
    expect(controller.setIdeHighlightEnabled(false)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function readyController(dispatch = vi.fn()): PanelSettingsController {
  const controller = new PanelSettingsController(dispatch);
  controller.acceptCompatibility(compatible());
  controller.acceptTabState(tabState(true, true));
  return controller;
}

function compatible() {
  return {
    type: "pin-op.protocol.compatibility",
    compatible: true,
    browserProtocolVersion: PROTOCOL_VERSION,
  } as const;
}

function tabState(autoRefreshEnabled: boolean, ideHighlightEnabled: boolean) {
  return {
    type: "pin-op.tab.state",
    autoRefreshEnabled,
    ideHighlightEnabled,
    participant: autoRefreshEnabled,
    lastAcceptedGeneration: 0,
  } as const;
}
