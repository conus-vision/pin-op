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
    const contentLease = new FakePort("browser2ide.inspect.contentLease");
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
    expect(contentLease.disconnected).toBe(true);
    await session.whenIdle();
    expect(calls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
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
        type: "browser2ide.inspect.result",
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
        type: "browser2ide.inspect.result",
        requestId: "enable",
        ok: false,
        error: "stalePanel",
      },
      delivered: true,
    });
    expect(sent).toEqual([
      {
        type: "browser2ide.inspect.result",
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
    const port = new FakePort("browser2ide.devtools.channel-1");
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
        type: "browser2ide.inspect.result",
        requestId: "trusted",
        ok: true,
      },
    ]);
  });

  it("disposes the trusted content session after its panel disconnects during enable", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("browser2ide.devtools.channel-1");
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
      ["tab", 17, { type: "browser2ide.inspect.disposeSession" }],
    ]);
    expect(port.sent).toEqual([]);
  });

  it("settles a pending request as stale before retiring a live panel session", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("browser2ide.devtools.channel-1");
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
        type: "browser2ide.inspect.result",
        requestId: "pending-enable",
        ok: false,
        error: "stalePanel",
      },
    ]);

    enable.resolve();
    await session.whenIdle();

    expect(calls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
    expect(port.sent).toHaveLength(1);
  });

  it("serializes enable and disable requests on the owning port", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort("browser2ide.devtools.channel-1");
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
        type: "browser2ide.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "disable",
        ok: true,
      },
    ]);
  });

  it("disconnects the content lease only when the owning panel closes", async () => {
    const calls: unknown[] = [];
    const panelPort = new FakePort("browser2ide.devtools.channel-1");
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
    const contentLease = new FakePort("browser2ide.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    panelPort.emitMessage(request("disable", false));

    expect(contentLease.disconnected).toBe(false);
    await session.whenIdle();
    expect(calls).toEqual([
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
    ]);

    panelPort.emitDisconnect();
    expect(contentLease.disconnected).toBe(true);
    await session.whenIdle();
    expect(calls.at(-1)).toEqual({
      type: "browser2ide.inspect.disposeSession",
    });
  });

  it("fails closed and notifies the panel when the content document disappears", async () => {
    const panelPort = new FakePort("browser2ide.devtools.channel-1");
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
    const contentLease = new FakePort("browser2ide.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);

    contentLease.emitDisconnect();

    expect(panelPort.sent.at(-1)).toEqual({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const nextDocumentLease = new FakePort(
      "browser2ide.inspect.contentLease",
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

    const contentLease = new FakePort("browser2ide.inspect.contentLease");
    coordinator.attachContentLease(17, CONTENT_SESSION_A, contentLease);
    contentLease.emitDisconnect();

    expect(lifecycle).toEqual([
      "attached:content-session-a",
      "documentDisconnected",
    ]);
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
    const contentLease = new FakePort("browser2ide.inspect.contentLease");
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
    const oldPort = new FakePort("browser2ide.devtools.old");
    const newPort = new FakePort("browser2ide.devtools.new");
    attachBackgroundInspectSession(oldPort, coordinator, 17);
    const newSession = attachBackgroundInspectSession(
      newPort,
      coordinator,
      17,
    );

    oldPort.emitMessage(request("old", true));
    await flushAsync();
    const contentLease = new FakePort("browser2ide.inspect.contentLease");
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
        type: "browser2ide.inspect.result",
        requestId: "new",
        ok: true,
      },
    ]);

    newPort.emitDisconnect();
    expect(contentLease.disconnected).toBe(true);
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
    const port = new FakePort("browser2ide.devtools.channel-1");
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
        type: "browser2ide.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "disable-1",
        ok: false,
        error: "Inspect mode update failed",
      },
      {
        type: "browser2ide.inspect.result",
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
    type: "browser2ide.inspect.setEnabled",
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
