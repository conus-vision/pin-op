import { describe, expect, it } from "vitest";
import {
  StatusBarController,
  formatVisibleLinkCode,
  type StatusBarHost,
  type StatusBarItemLike,
} from "../src/statusBarController.js";
import type { BridgeSnapshot } from "../src/bridgeManager.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("formatVisibleLinkCode", () => {
  it("groups the port and preserves a leading-zero PIN", () => {
    expect(formatVisibleLinkCode(48_735, "07")).toBe("48735 07");
  });

  it.each([
    [9_999, "07"],
    [65_536, "07"],
    [48_735.5, "07"],
    [Number.NaN, "07"],
    [48_735, "7"],
    [48_735, "007"],
    [48_735, "７０"],
  ])("rejects invalid port or PIN: %p, %p", (port, pin) => {
    expect(() => formatVisibleLinkCode(port, pin)).toThrow(
      "Cannot display an invalid Pin-op link code",
    );
  });
});

describe("StatusBarController", () => {
  it("shows a grouped code and stop action while running", () => {
    const host = statusHost();
    const controller = new StatusBarController(host);

    controller.render({
      state: "running",
      url: "ws://127.0.0.1:48735",
      port: 48_735,
      pin: "07",
      linkCode: "4873507",
      bridgeInstanceId: INSTANCE_ID,
      sessionId: "default",
      linkedBrowserCount: 2,
    });

    expect(host.primary).toMatchObject({
      text: "$(radio-tower) Pin-op: 48735 07",
      command: "pin-op.copyLinkCode",
    });
    expect(host.toggle).toMatchObject({
      text: "$(debug-stop)",
      tooltip: "Stop Pin-op",
      command: "pin-op.stop",
    });
    expect(host.primary.tooltip).toContain("state: running");
    expect(host.primary.tooltip).toContain("URL: ws://127.0.0.1:48735");
    expect(host.primary.tooltip).toContain("session: default");
    expect(host.primary.tooltip).toContain(`instance: ${INSTANCE_ID}`);
    expect(host.primary.tooltip).toContain("Linked browser windows: 2");
  });

  it.each([
    ["stopped", "$(radio-tower) Pin-op: Offline", "$(play)", "pin-op.start", undefined],
    ["error", "$(radio-tower) Pin-op: Offline", "$(play)", "pin-op.start", undefined],
    ["starting", "$(radio-tower) Pin-op: Starting", "$(sync~spin)", undefined, undefined],
    ["stopping", "$(radio-tower) Pin-op: Stopping", "$(sync~spin)", undefined, undefined],
  ] as const)("renders %s controls", (state, primaryText, toggleText, command) => {
    const host = statusHost();
    const controller = new StatusBarController(host);

    controller.render(emptySnapshot(state));

    expect(host.primary.text).toBe(primaryText);
    expect(host.primary.command).toBeUndefined();
    expect(host.toggle.text).toBe(toggleText);
    expect(host.toggle.command).toBe(command);
    expect(host.primary.tooltip).toContain(`state: ${state}`);
  });

  it("clears stale commands and tooltips across transitions", () => {
    const host = statusHost();
    const controller = new StatusBarController(host);

    controller.render({
      ...emptySnapshot("running"),
      port: 48_735,
      pin: "07",
      url: "ws://127.0.0.1:48735",
    });
    controller.render(emptySnapshot("stopped"));

    expect(host.primary.command).toBeUndefined();
    expect(host.toggle.command).toBe("pin-op.start");
    expect(host.primary.tooltip).toContain("Pin-op state: stopped");
    expect(host.primary.tooltip).not.toContain("ws://127.0.0.1:48735");
  });

  it("shows each item exactly once and disposes both items idempotently", () => {
    const host = statusHost();
    const controller = new StatusBarController(host);

    expect(host.primary.showCalls).toBe(1);
    expect(host.toggle.showCalls).toBe(1);

    controller.dispose();
    controller.dispose();

    expect(host.primary.disposeCalls).toBe(1);
    expect(host.toggle.disposeCalls).toBe(1);
  });

  it("does not mutate or call disposed items when rendered", () => {
    const host = statusHost();
    const controller = new StatusBarController(host);
    host.primary.text = "disposed primary";
    host.primary.tooltip = "disposed primary tooltip";
    host.primary.command = "disposed.primary";
    host.toggle.text = "disposed toggle";
    host.toggle.tooltip = "disposed toggle tooltip";
    host.toggle.command = "disposed.toggle";
    controller.dispose();

    const before = {
      primary: { ...host.primary },
      toggle: { ...host.toggle },
    };

    controller.render({
      state: "running",
      port: 48_735,
      pin: "07",
      sessionId: "default",
      linkedBrowserCount: 2,
    });

    expect(host.primary).toEqual(before.primary);
    expect(host.toggle).toEqual(before.toggle);
  });

  it("does not put auth tokens or raw link codes in tooltip text", () => {
    const host = statusHost();
    const controller = new StatusBarController(host);
    const snapshot = {
      ...emptySnapshot("running"),
      port: 48_735,
      pin: "07",
      linkCode: "4873507",
      authToken: "auth-token-secret",
    } as BridgeSnapshot & { authToken: string };

    controller.render(snapshot);

    expect(host.primary.tooltip).not.toContain("4873507");
    expect(host.primary.tooltip).not.toContain("auth-token-secret");
    expect(host.primary.tooltip).not.toMatch(/authToken|linkCode/i);
  });
});

function emptySnapshot(state: BridgeSnapshot["state"]): BridgeSnapshot {
  return {
    state,
    sessionId: "default",
    linkedBrowserCount: 0,
  };
}

function statusHost(): StatusBarHost & {
  primary: TestStatusBarItem;
  toggle: TestStatusBarItem;
} {
  return {
    primary: new TestStatusBarItem(),
    toggle: new TestStatusBarItem(),
  };
}

class TestStatusBarItem implements StatusBarItemLike {
  text = "";
  tooltip: string | undefined;
  command: string | undefined;
  showCalls = 0;
  disposeCalls = 0;

  show(): void {
    this.showCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}
