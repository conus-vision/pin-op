import { describe, expect, it } from "vitest";
import {
  createDevtoolsPanelPortName,
  createInspectContentLeasePortName,
  parseDevtoolsPanelPortName,
  parseInspectContentLeasePortName,
} from "../src/inspectPortProtocol.js";
import { PanelInspectTransport } from "../src/panelInspectTransport.js";

describe("panel inspect transport", () => {
  it("creates and parses strict document-scoped content lease names", () => {
    expect(createInspectContentLeasePortName("content-session-1")).toBe(
      "browser2ide.inspect.contentLease.content-session-1",
    );
    expect(
      parseInspectContentLeasePortName(
        "browser2ide.inspect.contentLease.content-session-1",
      ),
    ).toBe("content-session-1");
    expect(
      parseInspectContentLeasePortName("browser2ide.inspect.contentLease"),
    ).toBeUndefined();
    expect(
      parseInspectContentLeasePortName(
        "browser2ide.inspect.contentLease.content/session",
      ),
    ).toBeUndefined();
    expect(() => createInspectContentLeasePortName("content/session"))
      .toThrow(/session/i);
  });

  it("creates and validates canonical channel-only port names", () => {
    expect(createDevtoolsPanelPortName("channel-1")).toBe(
      "browser2ide.devtools.channel-1",
    );
    expect(
      parseDevtoolsPanelPortName("browser2ide.devtools.channel-1"),
    ).toBe("channel-1");
    expect(parseDevtoolsPanelPortName("browser2ide.devtools.")).toBeUndefined();
    expect(
      parseDevtoolsPanelPortName("browser2ide.devtools.channel/1"),
    ).toBeUndefined();
    expect(
      parseDevtoolsPanelPortName(`browser2ide.devtools.${"a".repeat(129)}`),
    ).toBeUndefined();
    expect(parseDevtoolsPanelPortName("browser2ide.inspect")).toBeUndefined();
  });

  it("opens its lifetime port explicitly and only once", () => {
    const port = new FakePort();
    let factoryCalls = 0;
    const transport = new PanelInspectTransport(() => {
      factoryCalls += 1;
      return port;
    });

    transport.connect();
    transport.connect();

    expect(factoryCalls).toBe(1);
    transport.dispose();
  });

  it("correlates a background acknowledgement without sending a tab ID", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);

    const result = transport.send({
      type: "enableInspectMode",
      tabId: 999,
    });
    expect(port.sent).toEqual([
      {
        type: "browser2ide.inspect.setEnabled",
        requestId: "1",
        enabled: true,
      },
    ]);

    port.emitMessage({
      type: "browser2ide.inspect.result",
      requestId: "1",
      ok: true,
    });

    await expect(result).resolves.toEqual({ ok: true });
  });

  it("rejects pending commands and disconnects synchronously on dispose", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(() => port);
    const pending = transport.send({
      type: "disableInspectMode",
    });

    transport.dispose();

    expect(port.disconnected).toBe(true);
    await expect(pending).rejects.toThrow("Inspect connection is closed");
  });

  it("recreates an unexpectedly disconnected port for the next command", async () => {
    const ports = [new FakePort(), new FakePort()];
    let factoryCalls = 0;
    let unexpectedDisconnects = 0;
    const transport = new PanelInspectTransport(
      () => ports[factoryCalls++]!,
      () => {
        unexpectedDisconnects += 1;
      },
    );

    const interrupted = transport.send({
      type: "enableInspectMode",
    });
    ports[0].disconnect();

    await expect(interrupted).rejects.toThrow("Inspect connection is closed");
    expect(unexpectedDisconnects).toBe(1);

    const retried = transport.send({
      type: "enableInspectMode",
    });
    ports[1].emitMessage({
      type: "browser2ide.inspect.result",
      requestId: "2",
      ok: true,
    });

    await expect(retried).resolves.toEqual({ ok: true });
    expect(factoryCalls).toBe(2);

    transport.dispose();
    await expect(
      transport.send({ type: "enableInspectMode" }),
    ).rejects.toThrow("Inspect connection is closed");
    expect(factoryCalls).toBe(2);
  });

  it("forwards window state on the shared port without duplicate listeners after reconnect", () => {
    const ports = [new FakePort(), new FakePort()];
    const received: unknown[] = [];
    let factoryCalls = 0;
    const transport = new PanelInspectTransport(
      () => ports[factoryCalls++]!,
      () => undefined,
      (message) => received.push(message),
    );

    transport.connect();
    ports[0].emitMessage({
      type: "browser2ide.windowState",
      state: "notLinked",
    });
    ports[0].disconnect();
    transport.connect();
    ports[1].emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
    });
    ports[0].emitMessage({
      type: "browser2ide.windowState",
      state: "error",
    });

    expect(received).toEqual([
      { type: "browser2ide.windowState", state: "notLinked" },
      { type: "browser2ide.windowState", state: "linked" },
    ]);
  });
});

class FakePort {
  public readonly name = "test.inspect";
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public disconnect(): void {
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
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
