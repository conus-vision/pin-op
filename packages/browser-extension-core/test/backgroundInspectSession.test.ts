import { describe, expect, it } from "vitest";
import {
  BackgroundInspectCoordinator,
  BackgroundInspectSession,
  attachBackgroundInspectSession,
} from "../src/backgroundInspectSession.js";
import type {
  ContentSessionId,
  InspectPortRequest,
} from "../src/inspectPortProtocol.js";

const CONTENT_SESSION_A = "content-session-a" as ContentSessionId;
const CONTENT_SESSION_B = "content-session-b" as ContentSessionId;
const CONTENT_SESSION_C = "content-session-c" as ContentSessionId;

describe("background inspect session", () => {
  it("keeps the content lease alive while picker mode is off", async () => {
    const calls: unknown[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await session.whenIdle();
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    await session.execute(request("picker-off", false));

    expect(contentLease.disconnected).toBe(false);
    expect(calls).toEqual([
      [
        "inject",
        { target: { tabId: 17 }, files: ["dist/contentScript.js"] },
      ],
      ["tab", 17, { type: "disableInspectMode" }],
    ]);

    session.disconnect();
    expect(contentLease.disconnected).toBe(false);
    await session.whenIdle();
    expect(contentLease.disconnected).toBe(true);
    expect(calls.at(-1)).toEqual([
      "tab",
      17,
      {
        type: "pin-op.inspect.disposeSession",
        contentSessionId: CONTENT_SESSION_A,
      },
    ]);
  });

  it("does not send cleanup after a synchronously-fired timeout revokes it", async () => {
    const calls: unknown[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
        return true;
      },
    }, {
      setTimeout(callback) {
        callback();
        return 1 as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout() {},
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await session.whenIdle();
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    session.disconnect();
    await session.whenIdle();

    expect(calls).toEqual([]);
    expect(contentLease.disconnected).toBe(true);
  });

  it("bounds queued pseudo cleanup and never sends it after its deadline", async () => {
    const blockedEnable = deferred<void>();
    const calls: unknown[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        if (isRecord(message) && message.type === "enableInspectMode") {
          await blockedEnable.promise;
        }
        return true;
      },
    }, {
      cleanupAckTimeoutMs: 25,
      setTimeout(callback) {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout(timer) {
        timers.delete(timer as unknown as number);
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);

    const enable = session.execute(request("blocked-enable", true));
    await flushAsync();
    const cleanup = coordinator.clearPseudoStates(17, CONTENT_SESSION_A);

    expect(timers.size).toBe(1);
    const [deadlineId, deadline] = [...timers.entries()][0]!;
    timers.delete(deadlineId);
    deadline();
    await expect(cleanup).resolves.toBe(false);

    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    blockedEnable.resolve();
    await enable;
    await coordinator.whenIdle(17);

    expect(calls.some(([, message]) =>
      isRecord(message) && message.type === "pin-op.inspect.clearPseudoStates"
    )).toBe(false);
    expect(leaseA.disconnected).toBe(true);
    expect(leaseB.disconnected).toBe(false);
  });

  it("bounds a queued session release and never sends late disposal", async () => {
    const blockedEnable = deferred<void>();
    const calls: unknown[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        if (isRecord(message) && message.type === "enableInspectMode") {
          await blockedEnable.promise;
        }
        return true;
      },
    }, {
      cleanupAckTimeoutMs: 25,
      setTimeout(callback) {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout(timer) {
        timers.delete(timer as unknown as number);
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await session.whenIdle();
    const contentLease = new FakePort("lease-release-deadline");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    const enable = session.execute(request("blocked-before-release", true));
    await flushAsync();
    session.disconnect();

    expect(timers.size).toBe(1);
    const [deadlineId, deadline] = [...timers.entries()][0]!;
    timers.delete(deadlineId);
    deadline();
    await session.whenIdle();
    expect(contentLease.disconnected).toBe(true);
    expect(calls.some(([, message]) =>
      isRecord(message) && message.type === "pin-op.inspect.disposeSession"
    )).toBe(false);

    blockedEnable.resolve();
    await enable;
    await coordinator.whenIdle(17);
    expect(calls.some(([, message]) =>
      isRecord(message) && message.type === "pin-op.inspect.disposeSession"
    )).toBe(false);
  });

  it("lets the router defer a successful acknowledgement until postflight", async () => {
    const sent: unknown[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage() {},
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      (message) => sent.push(message),
    );

    await expect(session.execute(request("enable", true))).resolves.toEqual({
      result: {
        type: "pin-op.inspect.result",
        requestId: "enable",
        ok: true,
      },
      delivered: false,
    });
    expect(sent).toEqual([]);
  });

  it("settles a deferred acknowledgement exactly once when retired", async () => {
    const enable = deferred<void>();
    const sent: unknown[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      (message) => sent.push(message),
    );

    const result = session.execute(request("enable", true));
    await flushAsync();
    session.retire("stalePanel");

    await expect(result).resolves.toEqual({
      result: {
        type: "pin-op.inspect.result",
        requestId: "enable",
        ok: false,
        error: "stalePanel",
      },
      delivered: true,
    });
    expect(sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "enable",
        ok: false,
        error: "stalePanel",
      },
    ]);

    enable.resolve();
    await session.whenIdle();
    expect(sent).toHaveLength(1);
  });

  it("uses its trusted tab and rejects a panel-supplied tab ID", async () => {
    const calls: unknown[] = [];
    const port = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator, 17);

    port.emitMessage({ ...request("spoof", true), tabId: 99 });
    port.emitMessage(request("trusted", true));
    await session.whenIdle();

    expect(calls).toEqual([
      [
        "inject",
        { target: { tabId: 17 }, files: ["dist/contentScript.js"] },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(port.sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "trusted",
        ok: true,
      },
    ]);
  });

  it("does not send unkeyed cleanup before a content lease exists", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator, 17);

    port.emitMessage(request("enable", true));
    await flushAsync();
    port.emitDisconnect();
    enable.resolve();
    await session.whenIdle();

    expect(calls).toEqual([
      [
        "inject",
        { target: { tabId: 17 }, files: ["dist/contentScript.js"] },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(port.sent).toEqual([]);
  });

  it("settles a pending request as stale before retiring a live panel session", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator, 17);

    port.emitMessage(request("pending-enable", true));
    await flushAsync();
    session.retire("stalePanel");

    expect(port.sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "pending-enable",
        ok: false,
        error: "stalePanel",
      },
    ]);

    enable.resolve();
    await session.whenIdle();

    expect(calls.at(-1)).toEqual(["tab", 17, { type: "enableInspectMode" }]);
    expect(port.sent).toHaveLength(1);
  });

  it("serializes enable and disable requests on the owning port", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        calls.push("inject");
      },
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator, 17);

    port.emitMessage(request("enable", true));
    await flushAsync();
    port.emitMessage(request("disable", false));
    enable.resolve();
    await session.whenIdle();

    expect(calls).toEqual([
      "inject",
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
    ]);
    expect(port.sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "pin-op.inspect.result",
        requestId: "disable",
        ok: true,
      },
    ]);
  });

  it("disconnects the content lease only when the owning panel closes", async () => {
    const calls: unknown[] = [];
    const panelPort = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        calls.push(message);
      },
    });
    const session = attachBackgroundInspectSession(
      panelPort,
      coordinator,
      17,
    );

    panelPort.emitMessage(request("enable", true));
    await session.whenIdle();
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    panelPort.emitMessage(request("disable", false));

    expect(contentLease.disconnected).toBe(false);
    await session.whenIdle();
    expect(calls).toEqual([
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
    ]);

    panelPort.emitDisconnect();
    expect(contentLease.disconnected).toBe(false);
    await session.whenIdle();
    expect(contentLease.disconnected).toBe(true);
    expect(calls.at(-1)).toEqual({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: CONTENT_SESSION_A,
    });
  });

  it("fails closed and notifies the panel when the content document disappears", async () => {
    const panelPort = new FakePort("pin-op.devtools.channel-1");
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage() {},
    });
    const session = attachBackgroundInspectSession(
      panelPort,
      coordinator,
      17,
    );

    panelPort.emitMessage(request("enable", true));
    await session.whenIdle();
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    contentLease.emitDisconnect();

    expect(panelPort.sent.at(-1)).toEqual({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const nextDocumentLease = new FakePort(
      "pin-op.inspect.contentLease",
    );
    coordinator.attachContentLease(17, CONTENT_SESSION_B, nextDocumentLease);
    expect(nextDocumentLease.disconnected).toBe(true);
  });

  it("reports trusted content lease attachment and document disconnect", async () => {
    const lifecycle: string[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage() {},
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onContentLeaseAttached: (contentSessionId) =>
          lifecycle.push(`attached:${contentSessionId}`),
        onInvalidated: (reason: string) => lifecycle.push(reason),
      },
    );
    await session.whenIdle();

    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);
    contentLease.emitDisconnect();

    expect(lifecycle).toEqual([
      "attached:content-session-a",
      "documentDisconnected",
    ]);
  });

  it("rejects a stale lease from a retiring injection before activating its replacement owner", async () => {
    const firstInjection = deferred<void>();
    const secondInjection = deferred<void>();
    const replacementAttachments: ContentSessionId[] = [];
    let injectionCount = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        injectionCount += 1;
        await (injectionCount === 1
          ? firstInjection.promise
          : secondInjection.promise);
      },
      async sendTabMessage() {
        return true;
      },
    });
    const retiring = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await flushAsync();
    expect(injectionCount).toBe(1);

    const retirement = retiring.controlledDispose();
    const replacement = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onContentLeaseAttached: (contentSessionId) =>
          replacementAttachments.push(contentSessionId),
      },
    );
    const staleLease = new FakePort("stale-retiring-injection");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, staleLease);
    const staleLeaseWasRejected = staleLease.disconnected;
    const attachmentsBeforeReplacementInjection = [...replacementAttachments];

    firstInjection.resolve();
    await retirement;
    await flushAsync();
    expect(injectionCount).toBe(2);
    secondInjection.resolve();
    await replacement.whenIdle();

    expect(staleLeaseWasRejected).toBe(true);
    expect(attachmentsBeforeReplacementInjection).toEqual([]);
    expect(replacementAttachments).toEqual([]);
    replacement.disconnect();
    await replacement.whenIdle();
  });

  it("keeps replacement activation behind a bounded retiring injection", async () => {
    const firstInjection = deferred<void>();
    const secondInjection = deferred<void>();
    const replacementAttachments: ContentSessionId[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let injectionCount = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        injectionCount += 1;
        await (injectionCount === 1
          ? firstInjection.promise
          : secondInjection.promise);
      },
      async sendTabMessage() {
        return true;
      },
    }, {
      cleanupAckTimeoutMs: 25,
      setTimeout(callback) {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout(timer) {
        timers.delete(timer as unknown as number);
      },
    });
    const retiring = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await flushAsync();
    expect(injectionCount).toBe(1);

    const retirement = retiring.controlledDispose();
    await flushAsync();
    expect(timers.size).toBe(1);
    const [deadlineId, deadline] = [...timers.entries()][0]!;
    timers.delete(deadlineId);
    deadline();
    await retirement;

    const replacement = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onContentLeaseAttached: (contentSessionId) =>
          replacementAttachments.push(contentSessionId),
      },
    );
    await flushAsync();
    const replacementStartedBeforeRetiredInjectionSettled = injectionCount > 1;

    firstInjection.resolve();
    const staleLease = new FakePort("late-retired-injection");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, staleLease);
    const staleLeaseWasRejected = staleLease.disconnected;
    await flushAsync();
    expect(injectionCount).toBe(2);

    secondInjection.resolve();
    await replacement.whenIdle();
    const currentLease = new FakePort("replacement-injection");
    coordinator.attachContentLease(17, CONTENT_SESSION_B, currentLease);
    await coordinator.whenIdle(17);

    expect(replacementStartedBeforeRetiredInjectionSettled).toBe(false);
    expect(staleLeaseWasRejected).toBe(true);
    expect(replacementAttachments).toEqual([CONTENT_SESSION_B]);
    expect(currentLease.disconnected).toBe(false);
    replacement.disconnect();
    await replacement.whenIdle();
  });

  it("replaces a content lease when an older dispatch never settles", async () => {
    const never = new Promise<never>(() => undefined);
    const calls: unknown[] = [];
    const attached: ContentSessionId[] = [];
    const invalidated: string[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        if (
          isRecord(message) &&
          (message.type === "enableInspectMode" ||
            message.type === "pin-op.inspect.disposeSession")
        ) {
          await never;
        }
        return true;
      },
    }, {
      cleanupAckTimeoutMs: 25,
      setTimeout(callback) {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout(timer) {
        timers.delete(timer as unknown as number);
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onInvalidated: (reason) => invalidated.push(reason),
        onContentLeaseAttached: (id) => attached.push(id),
      },
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);

    void session.execute(request("never-settles", true));
    await flushAsync();
    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    await flushAsync();

    expect(calls).toContainEqual([
      17,
      {
        type: "pin-op.inspect.disposeSession",
        contentSessionId: CONTENT_SESSION_A,
      },
    ]);
    expect(timers.size).toBe(1);
    const [deadlineId, deadline] = [...timers.entries()][0]!;
    timers.delete(deadlineId);
    deadline();
    await flushAsync();

    expect(leaseA.disconnected).toBe(true);
    expect(leaseB.disconnected).toBe(false);
    expect(attached).toEqual([CONTENT_SESSION_A, CONTENT_SESSION_B]);
    leaseA.emitDisconnect();
    expect(invalidated).toEqual([]);
    expect(leaseB.disconnected).toBe(false);
  });

  it("revokes replacement authority only after predecessor cleanup settles", async () => {
    const cleanup = deferred<unknown>();
    const timeline: string[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        if (
          isRecord(message) &&
          message.type === "pin-op.inspect.disposeSession"
        ) {
          timeline.push(`cleanup:${String(message.contentSessionId)}`);
          return await cleanup.promise;
        }
        return true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onContentLeaseAttached: (contentSessionId) =>
          timeline.push(`attached:${contentSessionId}`),
        onContentLeaseReplacementStarted: (
          previousContentSessionId,
          nextContentSessionId,
        ) => timeline.push(
          `starting:${previousContentSessionId}->${nextContentSessionId}`,
        ),
        onContentLeaseReplacing: (previousContentSessionId, nextContentSessionId) =>
          timeline.push(
            `replacing:${previousContentSessionId}->${nextContentSessionId}`,
          ),
      },
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);

    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    await flushAsync();

    expect(timeline).toEqual([
      `attached:${CONTENT_SESSION_A}`,
      `starting:${CONTENT_SESSION_A}->${CONTENT_SESSION_B}`,
      `cleanup:${CONTENT_SESSION_A}`,
    ]);
    expect(leaseA.disconnected).toBe(false);
    expect(leaseB.disconnected).toBe(false);

    cleanup.resolve(true);
    await coordinator.whenIdle(17);

    expect(timeline).toEqual([
      `attached:${CONTENT_SESSION_A}`,
      `starting:${CONTENT_SESSION_A}->${CONTENT_SESSION_B}`,
      `cleanup:${CONTENT_SESSION_A}`,
      `replacing:${CONTENT_SESSION_A}->${CONTENT_SESSION_B}`,
      `attached:${CONTENT_SESSION_B}`,
    ]);
    expect(leaseA.disconnected).toBe(true);
    expect(leaseB.disconnected).toBe(false);
  });

  it("holds session release behind an in-flight predecessor lease cleanup", async () => {
    const cleanup = deferred<unknown>();
    const calls: unknown[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        if (
          isRecord(message) &&
          message.type === "pin-op.inspect.disposeSession" &&
          message.contentSessionId === CONTENT_SESSION_A
        ) {
          return await cleanup.promise;
        }
        return true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);
    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    await flushAsync();

    const release = session.controlledDispose();
    let released = false;
    void release.then(() => {
      released = true;
    });
    await flushAsync();

    expect(released).toBe(false);
    expect(leaseA.disconnected).toBe(false);
    expect(leaseB.disconnected).toBe(false);

    cleanup.resolve(true);
    await release;
    await coordinator.whenIdle(17);

    expect(leaseA.disconnected).toBe(true);
    expect(leaseB.disconnected).toBe(true);
    expect(calls.filter(([, message]) =>
      isRecord(message) && message.type === "pin-op.inspect.disposeSession"
    )).toEqual([[17, {
      type: "pin-op.inspect.disposeSession",
      contentSessionId: CONTENT_SESSION_A,
    }]]);
  });

  it("serializes A-to-B-to-C lease replacement behind each predecessor cleanup", async () => {
    const cleanupA = deferred<unknown>();
    const cleanupB = deferred<unknown>();
    const calls: unknown[] = [];
    const attached: ContentSessionId[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        if (!isRecord(message) || message.type !== "pin-op.inspect.disposeSession") {
          return undefined;
        }
        if (message.contentSessionId === CONTENT_SESSION_A) {
          return await cleanupA.promise;
        }
        if (message.contentSessionId === CONTENT_SESSION_B) {
          return await cleanupB.promise;
        }
        return true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      { onContentLeaseAttached: (id) => attached.push(id) },
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    const leaseC = new FakePort("lease-c");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);
    await coordinator.whenIdle(17);

    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    coordinator.attachContentLease(17, CONTENT_SESSION_C, leaseC);
    await flushAsync();

    expect(calls).toEqual([[
      17,
      {
        type: "pin-op.inspect.disposeSession",
        contentSessionId: CONTENT_SESSION_A,
      },
    ]]);
    expect(attached).toEqual([CONTENT_SESSION_A]);
    expect(leaseA.disconnected).toBe(false);
    expect(leaseB.disconnected).toBe(false);
    expect(leaseC.disconnected).toBe(false);

    cleanupA.resolve(true);
    await flushAsync();
    expect(leaseA.disconnected).toBe(true);
    expect(attached).toEqual([CONTENT_SESSION_A, CONTENT_SESSION_B]);
    expect(calls.at(-1)).toEqual([
      17,
      {
        type: "pin-op.inspect.disposeSession",
        contentSessionId: CONTENT_SESSION_B,
      },
    ]);
    expect(leaseB.disconnected).toBe(false);
    expect(leaseC.disconnected).toBe(false);

    cleanupB.resolve(true);
    await coordinator.whenIdle(17);
    expect(leaseB.disconnected).toBe(true);
    expect(leaseC.disconnected).toBe(false);
    expect(attached).toEqual([
      CONTENT_SESSION_A,
      CONTENT_SESSION_B,
      CONTENT_SESSION_C,
    ]);
  });

  it("never accepts a queued replacement disconnected during predecessor cleanup", async () => {
    const cleanupA = deferred<unknown>();
    const calls: unknown[] = [];
    const attached: ContentSessionId[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(tabId, message) {
        calls.push([tabId, message]);
        return isRecord(message) &&
            message.type === "pin-op.inspect.disposeSession" &&
            message.contentSessionId === CONTENT_SESSION_A
          ? await cleanupA.promise
          : true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      { onContentLeaseAttached: (id) => attached.push(id) },
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    const leaseC = new FakePort("lease-c");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);
    await coordinator.whenIdle(17);

    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    expect(leaseB.onDisconnect.listenerCount).toBe(1);
    leaseB.disconnect();
    coordinator.attachContentLease(17, CONTENT_SESSION_C, leaseC);
    await flushAsync();

    cleanupA.resolve(true);
    await coordinator.whenIdle(17);

    expect(attached).toEqual([CONTENT_SESSION_A, CONTENT_SESSION_C]);
    expect(leaseB.onDisconnect.listenerCount).toBe(0);
    expect(leaseC.disconnected).toBe(false);
    expect(calls.filter(([, message]) =>
      isRecord(message) && message.type === "pin-op.inspect.disposeSession"
    )).toEqual([[
      17,
      {
        type: "pin-op.inspect.disposeSession",
        contentSessionId: CONTENT_SESSION_A,
      },
    ]]);
  });

  it("rejects a queued replacement when its original panel owner is revoked", async () => {
    const cleanupA = deferred<unknown>();
    const attached: ContentSessionId[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        return isRecord(message) &&
            message.type === "pin-op.inspect.disposeSession" &&
            message.contentSessionId === CONTENT_SESSION_A
          ? await cleanupA.promise
          : true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      { onContentLeaseAttached: (id) => attached.push(id) },
    );
    await session.whenIdle();
    const leaseA = new FakePort("lease-a");
    const leaseB = new FakePort("lease-b");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, leaseA);
    await coordinator.whenIdle(17);

    coordinator.attachContentLease(17, CONTENT_SESSION_B, leaseB);
    expect(leaseB.onDisconnect.listenerCount).toBe(1);
    await flushAsync();
    session.disconnect();
    cleanupA.resolve(true);
    await session.whenIdle();
    await coordinator.whenIdle(17);

    expect(leaseA.disconnected).toBe(true);
    expect(leaseB.disconnected).toBe(true);
    expect(leaseB.onDisconnect.listenerCount).toBe(0);
    expect(attached).toEqual([CONTENT_SESSION_A]);
  });

  it("reports injection failure without accepting an unowned content lease", async () => {
    const lifecycle: string[] = [];
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        throw new Error("Protected page");
      },
      async sendTabMessage() {},
    });
    const session = new BackgroundInspectSession(
      coordinator,
      17,
      () => undefined,
      {
        onInvalidated: (reason: string) => lifecycle.push(reason),
      },
    );

    await session.whenIdle();

    expect(lifecycle).toEqual(["injectionFailed"]);
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);
    expect(contentLease.disconnected).toBe(true);
  });

  it("does not let an old port disable a newer owner for the same tab", async () => {
    const firstEnable = deferred<void>();
    const calls: unknown[] = [];
    let enableCount = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        calls.push("inject");
      },
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (isRecord(message) && message.type === "enableInspectMode") {
          enableCount += 1;
          if (enableCount === 1) {
            await firstEnable.promise;
          }
        }
      },
    });
    const oldPort = new FakePort("pin-op.devtools.old");
    const newPort = new FakePort("pin-op.devtools.new");
    attachBackgroundInspectSession(oldPort, coordinator, 17);
    const newSession = attachBackgroundInspectSession(
      newPort,
      coordinator,
      17,
    );

    oldPort.emitMessage(request("old", true));
    await flushAsync();
    const contentLease = new FakePort("pin-op.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);
    newPort.emitMessage(request("new", true));
    oldPort.emitDisconnect();
    expect(contentLease.disconnected).toBe(false);
    firstEnable.resolve();
    await newSession.whenIdle();

    expect(calls).toEqual([
      "inject",
      { type: "enableInspectMode" },
    ]);
    expect(newPort.sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "new",
        ok: true,
      },
    ]);

    newPort.emitDisconnect();
    expect(contentLease.disconnected).toBe(false);
    await newSession.whenIdle();
    expect(contentLease.disconnected).toBe(true);
    expect(calls.at(-1)).toEqual({
      type: "pin-op.inspect.disposeSession",
      contentSessionId: CONTENT_SESSION_A,
    });
  });

  it("lets the same owner retry a failed disable", async () => {
    const calls: unknown[] = [];
    let rejectNextDisable = true;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (
          rejectNextDisable &&
          isRecord(message) &&
          message.type === "disableInspectMode"
        ) {
          rejectNextDisable = false;
          throw new Error("Content script did not answer");
        }
      },
    });
    const port = new FakePort("pin-op.devtools.channel-1");
    const session = attachBackgroundInspectSession(port, coordinator, 17);

    port.emitMessage(request("enable", true));
    await session.whenIdle();
    port.emitMessage(request("disable-1", false));
    await session.whenIdle();
    port.emitMessage(request("disable-2", false));
    await session.whenIdle();
    await flushAsync();

    expect(calls).toEqual([
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
      { type: "disableInspectMode" },
    ]);
    expect(port.sent).toEqual([
      {
        type: "pin-op.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "pin-op.inspect.result",
        requestId: "disable-1",
        ok: false,
        error: "Inspect mode update failed",
      },
      {
        type: "pin-op.inspect.result",
        requestId: "disable-2",
        ok: true,
      },
    ]);
  });
});

class FakePort {
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public constructor(public readonly name: string) {}

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  public emitDisconnect(): void {
    this.onDisconnect.emit();
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.emitDisconnect();
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}

function request(requestId: string, enabled: boolean): InspectPortRequest {
  return {
    type: "pin-op.inspect.setEnabled",
    requestId,
    enabled,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
