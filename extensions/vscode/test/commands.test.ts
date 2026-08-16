import { describe, expect, it } from "vitest";
import { registerPresenterCommands } from "../src/presenter/commands.js";
import {
  ExtensionRuntimeController,
  registerRuntimeCommands,
  type RuntimeClientLike,
  type RuntimeManagerLike,
  type RuntimeStatusLike,
} from "../src/runtimeController.js";
import type { ResolvedSourceMatch } from "../src/sourcePlugins/types.js";

describe("presenter commands", () => {
  it("reveals a current match in the active editor without opening documents", () => {
    const callbacks = new Map<string, (...arguments_: unknown[]) => unknown>();
    const current = match();
    const revealed: unknown[] = [];
    const selected: unknown[] = [];
    const errors: unknown[] = [];
    let activeUri = "file:///src/app.scss";
    let disposed = false;
    const editor = { document: { uri: { toString: () => activeUri } } };
    const registration = registerPresenterCommands(
      {
        registerCommand(command, callback) {
          callbacks.set(command, callback);
          return { dispose: () => (disposed = true) };
        },
        getActiveEditor: () => editor,
        createRange: (range) => range,
        revealRange: (_editor, range) => revealed.push(range),
        selectRangeStart: (_editor, start) => selected.push(start),
      },
      {
        getMatch: (id) => (id === "current" ? current : undefined),
        getDocumentUri: () => "file:///src/app.scss",
      },
      (error) => errors.push(error),
    );

    const callback = callbacks.get("pin-op.revealSourceMatch");
    expect(callback).toBeTypeOf("function");
    callback?.("missing");
    callback?.("current");
    expect(revealed).toEqual([current.range]);
    expect(selected).toEqual([current.range.start]);

    activeUri = "file:///src/other.scss";
    callback?.("current");
    expect(errors).toHaveLength(1);
    expect(revealed).toHaveLength(1);
    registration.dispose();
    expect(disposed).toBe(true);
  });
});

describe("runtime commands", () => {
  it("starts one instance-bound IDE client and copies the raw link code", async () => {
    const harness = runtimeHarness();

    await Promise.all([harness.controller.start(), harness.controller.start()]);
    await harness.controller.copyLinkCode();

    expect(harness.manager.startCalls).toBe(1);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clientOptions[0]).toEqual({
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      bridgeInstanceId: "11111111-1111-4111-8111-111111111111",
      authToken: "ide-token",
    });
    expect(harness.clients[0]?.connectCalls).toBe(1);
    expect(harness.clipboard).toEqual(["4873507"]);
    expect(harness.information).toEqual(["Pin-op link code copied."]);
    expect(harness.information.join(" ")).not.toContain("4873507");
  });

  it("warns without writing when no running link code exists", async () => {
    const harness = runtimeHarness({ state: "stopped" });

    await harness.controller.copyLinkCode();

    expect(harness.clipboard).toEqual([]);
    expect(harness.warnings).toEqual(["Pin-op is not running."]);
  });

  it("disposes the client before stopping and creates a fresh client later", async () => {
    const events: string[] = [];
    const harness = runtimeHarness({ events });

    await harness.controller.start();
    await harness.controller.stop();
    await harness.controller.start();

    expect(events).toContain("client:dispose");
    expect(events.indexOf("client:dispose")).toBeLessThan(
      events.indexOf("manager:stop"),
    );
    expect(harness.clients).toHaveLength(2);
    expect(harness.manager.stopCalls).toBe(1);
  });

  it("ends running when start immediately follows stop without awaiting it", async () => {
    const events: string[] = [];
    const harness = runtimeHarness({ events });
    await harness.controller.start();
    const stopGate = harness.manager.deferNextStop();

    const stopping = harness.controller.stop();
    const restarting = harness.controller.start();
    await stopGate.started;

    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.disposeCalls).toBe(1);
    stopGate.release();
    await Promise.all([stopping, restarting]);

    expect(harness.manager.snapshot().state).toBe("running");
    expect(harness.manager.startCalls).toBe(2);
    expect(harness.manager.stopCalls).toBe(1);
    expect(harness.clients).toHaveLength(2);
    expect(events).toEqual([
      "manager:start",
      "client:dispose",
      "manager:stop:start",
      "manager:stop",
      "manager:start",
    ]);
  });

  it("runs a queued restart after stop fails", async () => {
    const harness = runtimeHarness();
    await harness.controller.start();
    harness.manager.stopError = new Error("stop failed");

    const stopping = harness.controller.stop();
    const restarting = harness.controller.start();

    await expect(stopping).rejects.toThrow("stop failed");
    await expect(restarting).resolves.toBeUndefined();
    expect(harness.manager.snapshot().state).toBe("running");
    expect(harness.manager.startCalls).toBe(2);
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[1]?.connectCalls).toBe(1);
  });

  it("coalesces duplicate stop effects while preserving command order", async () => {
    const harness = runtimeHarness();
    await harness.controller.start();

    await Promise.all([harness.controller.stop(), harness.controller.stop()]);

    expect(harness.manager.stopCalls).toBe(1);
    expect(harness.clients[0]?.disposeCalls).toBe(1);
    expect(harness.manager.snapshot().state).toBe("stopped");
  });

  it("disposal suppresses a queued restart and performs one final stop", async () => {
    const harness = runtimeHarness();
    await harness.controller.start();
    const stopGate = harness.manager.deferNextStop();

    const stopping = harness.controller.stop();
    const restarting = harness.controller.start();
    const disposing = harness.controller.dispose();
    await stopGate.started;
    stopGate.release();
    await Promise.all([stopping, restarting, disposing]);

    expect(harness.manager.snapshot().state).toBe("stopped");
    expect(harness.manager.stopCalls).toBe(1);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.disposeCalls).toBe(1);
    expect(harness.manager.subscriptionDisposeCalls).toBe(1);
    expect(harness.status.disposeCalls).toBe(1);
  });

  it("registers start, stop, and copy commands and reports command failures", async () => {
    const harness = runtimeHarness();
    const callbacks = new Map<string, () => unknown>();
    const errors: unknown[] = [];
    const registration = registerRuntimeCommands(
      {
        registerCommand(command, callback) {
          callbacks.set(command, callback);
          return { dispose() {} };
        },
        reportError: (error) => errors.push(error),
      },
      harness.controller,
    );

    expect([...callbacks.keys()]).toEqual([
      "pin-op.start",
      "pin-op.stop",
      "pin-op.copyLinkCode",
    ]);
    await callbacks.get("pin-op.start")?.();
    await callbacks.get("pin-op.copyLinkCode")?.();
    await callbacks.get("pin-op.stop")?.();
    expect(errors).toEqual([]);

    harness.manager.startError = new Error("start failed");
    await callbacks.get("pin-op.start")?.();
    expect(errors).toHaveLength(1);
    registration.dispose();
  });

  it("disposes subscriptions, client, status, and manager once", async () => {
    const harness = runtimeHarness();
    await harness.controller.start();

    await Promise.all([harness.controller.dispose(), harness.controller.dispose()]);

    expect(harness.clients[0]?.disposeCalls).toBe(1);
    expect(harness.manager.stopCalls).toBe(1);
    expect(harness.manager.subscriptionDisposeCalls).toBe(1);
    expect(harness.status.disposeCalls).toBe(1);
  });
});

function match(): ResolvedSourceMatch {
  return {
    pluginId: "pin-op.scss",
    targetRole: "selected",
    range: {
      start: { line: 1, character: 2 },
      end: { line: 4, character: 1 },
    },
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "sourcemap",
  };
}

function runtimeHarness(
  options: { state?: "stopped" | "running"; events?: string[] } = {},
) {
  const events = options.events ?? [];
  const manager = new FakeRuntimeManager(options.state ?? "stopped", events);
  const status = new FakeRuntimeStatus();
  const clients: FakeRuntimeClient[] = [];
  const clientOptions: unknown[] = [];
  const clipboard: string[] = [];
  const information: string[] = [];
  const warnings: string[] = [];
  const controller = new ExtensionRuntimeController({
    manager,
    status,
    createClient(options) {
      clientOptions.push(options);
      const client = new FakeRuntimeClient(events);
      clients.push(client);
      return client;
    },
    writeClipboard: async (value) => {
      clipboard.push(value);
    },
    showInformationMessage: async (message) => {
      information.push(message);
    },
    showWarningMessage: async (message) => {
      warnings.push(message);
    },
  });

  return {
    controller,
    manager,
    status,
    clients,
    clientOptions,
    clipboard,
    information,
    warnings,
  };
}

class FakeRuntimeManager implements RuntimeManagerLike {
  startCalls = 0;
  stopCalls = 0;
  subscriptionDisposeCalls = 0;
  startError: Error | undefined;
  stopError: Error | undefined;
  private stopGate: Deferred<void> | undefined;
  private stopStarted: Deferred<void> | undefined;
  private readonly listeners = new Set<(snapshot: ReturnType<FakeRuntimeManager["snapshot"]>) => void>();

  constructor(
    private state: "stopped" | "running",
    private readonly events: string[],
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    this.events.push("manager:start");
    if (this.startError) {
      const error = this.startError;
      this.startError = undefined;
      throw error;
    }
    this.state = "running";
    this.emit();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.events.push("manager:stop:start");
    this.stopStarted?.resolve();
    this.stopStarted = undefined;
    const gate = this.stopGate;
    this.stopGate = undefined;
    await gate?.promise;
    if (this.stopError) {
      const error = this.stopError;
      this.stopError = undefined;
      throw error;
    }
    this.events.push("manager:stop");
    this.state = "stopped";
    this.emit();
  }

  deferNextStop(): { readonly started: Promise<void>; release(): void } {
    const started = deferred<void>();
    const gate = deferred<void>();
    this.stopStarted = started;
    this.stopGate = gate;
    return { started: started.promise, release: () => gate.resolve() };
  }

  snapshot() {
    return this.state === "running"
      ? {
          state: "running" as const,
          url: "ws://127.0.0.1:48735",
          port: 48_735,
          pin: "07",
          linkCode: "4873507",
          bridgeInstanceId: "11111111-1111-4111-8111-111111111111",
          sessionId: "session-1",
          linkedBrowserCount: 0,
        }
      : {
          state: "stopped" as const,
          sessionId: "session-1",
          linkedBrowserCount: 0,
        };
  }

  getIdeCredentials() {
    return this.state === "running"
      ? {
          sessionId: "session-1",
          bridgeInstanceId: "11111111-1111-4111-8111-111111111111",
          authToken: "ide-token",
        }
      : undefined;
  }

  onStateChanged(listener: (snapshot: ReturnType<FakeRuntimeManager["snapshot"]>) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.subscriptionDisposeCalls += 1;
        this.listeners.delete(listener);
      },
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

class FakeRuntimeStatus implements RuntimeStatusLike {
  readonly snapshots: unknown[] = [];
  disposeCalls = 0;

  render(snapshot: unknown): void {
    this.snapshots.push(snapshot);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeRuntimeClient implements RuntimeClientLike {
  connectCalls = 0;
  disposeCalls = 0;

  constructor(private readonly events: string[]) {}

  connect(): void {
    this.connectCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
    this.events.push("client:dispose");
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}
