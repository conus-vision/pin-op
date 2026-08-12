import { createServer, type Server } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  LinkAuthenticator,
  type BridgeServerOptions,
  type LinkAuthenticatorOptions,
} from "@pinop/bridge";
import { BridgeClient } from "../src/bridgeClient.js";
import {
  BridgeManager,
  MANAGED_PORT_COUNT,
  MANAGED_PORT_START,
} from "../src/bridgeManager.js";

const SESSION_ID = "session-1";
const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";

describe("BridgeManager", () => {
  it("tries exactly 100 managed ports and succeeds at 48834 with one authenticator", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const attempts: number[] = [];
    const attemptedAuthenticators: Array<LinkAuthenticator | undefined> = [];
    const bridges: FakeBridge[] = [];
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        attempts.push(requiredPort(options));
        attemptedAuthenticators.push(options.authenticator);
        const bridge = new FakeBridge(options, {
          start: () => {
            if (requiredPort(options) < 48_834) {
              throw errno("EADDRINUSE");
            }
          },
        });
        bridges.push(bridge);
        return bridge;
      },
    });

    expect(MANAGED_PORT_START).toBe(48_735);
    expect(MANAGED_PORT_COUNT).toBe(100);

    await manager.start();

    expect(attempts).toEqual(managedPorts());
    expect(bridges).toHaveLength(100);
    expect(new Set(attemptedAuthenticators)).toEqual(
      new Set([authenticators.created[0]]),
    );
    expect(manager.snapshot()).toEqual({
      state: "running",
      url: "ws://127.0.0.1:48834",
      port: 48_834,
      pin: "07",
      linkCode: "4883407",
      bridgeInstanceId: INSTANCE_A,
      sessionId: SESSION_ID,
      linkedBrowserCount: 0,
    });

    const credentials = manager.getIdeCredentials();
    expect(credentials).toEqual({
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_A,
      authToken: authenticators.created[0]?.issuedTokens[0]?.value,
    });
    expect(
      authenticators.created[0]?.validateToken(
        SESSION_ID,
        "ide",
        credentials?.authToken ?? "",
        INSTANCE_A,
      ),
    ).toBe("accepted");

    await manager.start();
    expect(attempts).toHaveLength(100);
    expect(authenticators.created).toHaveLength(1);
    await manager.stop();
  });

  it("uses an injected managed port range", async () => {
    const managedPortStart = 40_000;
    const attempts: number[] = [];
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      managedPortStart,
      managedPortCount: 2,
      createBridge: (options) =>
        new FakeBridge(options, {
          start: () => {
            const port = requiredPort(options);
            attempts.push(port);
            if (port === managedPortStart) {
              throw errno("EADDRINUSE");
            }
          },
        }),
    });

    await manager.start();

    expect(attempts).toEqual([managedPortStart, managedPortStart + 1]);
    expect(manager.snapshot().port).toBe(managedPortStart + 1);
    await manager.stop();
  });

  it("authenticates the IDE after an occupied first managed port", async () => {
    const reservation = await reserveAdjacentPorts();
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      managedPortStart: reservation.startPort,
      managedPortCount: 2,
      createAuthenticator: authenticators.create,
    });
    let client: BridgeClient | undefined;
    onTestFinished(async () => {
      client?.dispose();
      try {
        await manager.stop();
      } finally {
        await closeServer(reservation.nextPort);
        await closeServer(reservation.blocker);
      }
    });

    await closeServer(reservation.nextPort);
    await manager.start();
    expect(manager.snapshot().port).toBe(reservation.startPort + 1);

    const credentials = manager.getIdeCredentials();
    if (!credentials) {
      throw new Error("Expected IDE credentials from the running bridge");
    }

    client = new BridgeClient({
      url: manager.snapshot().url ?? "",
      ...credentials,
    });
    const connected = waitForConnected(client);
    client.connect();
    await connected;

    client.dispose();
    client = undefined;
    await manager.stop();
    expect(
      authenticators.created[0]?.validateToken(
        SESSION_ID,
        "ide",
        credentials.authToken,
        INSTANCE_A,
      ),
    ).toBe("rejected");
  });

  it("stops each occupied-port bridge before trying the next port", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const events: string[] = [];
    const bridges: FakeBridge[] = [];
    const successfulPort = MANAGED_PORT_START + 2;
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        const port = requiredPort(options);
        const bridge = new FakeBridge(options, {
          start: () => {
            events.push(`start:${port}`);
            if (port < successfulPort) {
              throw errno("EADDRINUSE");
            }
          },
          stop: () => {
            events.push(`stop:${port}`);
            if (port < successfulPort) {
              throw new Error("cleanup failed");
            }
          },
        });
        bridges.push(bridge);
        return bridge;
      },
    });

    await manager.start();

    expect(events).toEqual([
      `start:${MANAGED_PORT_START}`,
      `stop:${MANAGED_PORT_START}`,
      `start:${MANAGED_PORT_START + 1}`,
      `stop:${MANAGED_PORT_START + 1}`,
      `start:${successfulPort}`,
    ]);
    expect(bridges.map((bridge) => bridge.stopCalls)).toEqual([1, 1, 0]);

    await manager.stop();
    expect(bridges.map((bridge) => bridge.stopCalls)).toEqual([1, 1, 1]);
  });

  it("fails after all 100 ports are occupied and retries with fresh link credentials", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
      { bridgeInstanceId: INSTANCE_B, pin: "08" },
    ]);
    const attempts: number[] = [];
    const bridges: FakeBridge[] = [];
    let portsOccupied = true;
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        attempts.push(requiredPort(options));
        const bridge = new FakeBridge(options, {
          start: () => {
            if (portsOccupied) {
              throw errno("EADDRINUSE");
            }
          },
          stop: () => {
            if (portsOccupied) {
              throw new Error("cleanup failed");
            }
          },
        });
        bridges.push(bridge);
        return bridge;
      },
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(attempts).toEqual(managedPorts());
    expect(bridges).toHaveLength(MANAGED_PORT_COUNT);
    expect(bridges.map((bridge) => bridge.stopCalls)).toEqual(
      Array.from({ length: MANAGED_PORT_COUNT }, () => 1),
    );
    expect(manager.snapshot()).toEqual({
      state: "error",
      sessionId: SESSION_ID,
      linkedBrowserCount: 0,
    });
    expect(manager.getIdeCredentials()).toBeUndefined();
    expect(authenticators.created).toHaveLength(1);
    expect(authenticators.created[0]?.issuedTokens).toEqual([]);

    portsOccupied = false;
    await manager.start();

    expect(attempts).toEqual([...managedPorts(), MANAGED_PORT_START]);
    expect(authenticators.created).toHaveLength(2);
    expect(manager.snapshot()).toMatchObject({
      state: "running",
      port: MANAGED_PORT_START,
      pin: "08",
      linkCode: "4873508",
      bridgeInstanceId: INSTANCE_B,
    });
    const retryCredentials = manager.getIdeCredentials();
    expect(retryCredentials).toMatchObject({
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_B,
    });
    expect(retryCredentials?.authToken).toBe(
      authenticators.created[1]?.issuedTokens[0]?.value,
    );
    await manager.stop();
  });

  it("aborts immediately on a non-EADDRINUSE start error", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const attempts: number[] = [];
    let bridge: FakeBridge | undefined;
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        attempts.push(requiredPort(options));
        bridge = new FakeBridge(options, {
          start: () => {
            throw errno("EACCES");
          },
          stop: () => {
            throw new Error("cleanup failed");
          },
        });
        return bridge;
      },
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "EACCES" });

    expect(attempts).toEqual([MANAGED_PORT_START]);
    expect(bridge?.stopCalls).toBe(1);
    expect(manager.snapshot()).toEqual({
      state: "error",
      sessionId: SESSION_ID,
      linkedBrowserCount: 0,
    });
    expect(manager.getIdeCredentials()).toBeUndefined();
    expect(authenticators.created[0]?.issuedTokens).toEqual([]);
  });

  it("creates a new server, identity, PIN, and token after a successful stop", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
      { bridgeInstanceId: INSTANCE_B, pin: "08" },
    ]);
    const bridges: FakeBridge[] = [];
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        const bridge = new FakeBridge(options);
        bridges.push(bridge);
        return bridge;
      },
    });

    await manager.start();
    const firstCredentials = manager.getIdeCredentials();
    expect(manager.snapshot().linkCode).toBe("4873507");

    await manager.stop();

    expect(bridges[0]?.stopCalls).toBe(1);
    expect(bridges[0]?.listenerDisposeCalls).toBe(1);
    expect(manager.snapshot()).toEqual({
      state: "stopped",
      sessionId: SESSION_ID,
      linkedBrowserCount: 0,
    });
    expect(manager.getIdeCredentials()).toBeUndefined();
    expect(
      authenticators.created[0]?.validateToken(
        SESSION_ID,
        "ide",
        firstCredentials?.authToken ?? "",
        INSTANCE_A,
      ),
    ).toBe("rejected");

    await manager.start();
    const secondCredentials = manager.getIdeCredentials();

    expect(bridges).toHaveLength(2);
    expect(bridges[1]).not.toBe(bridges[0]);
    expect(requiredPort(bridges[1]!.options)).toBe(MANAGED_PORT_START);
    expect(authenticators.created[1]).not.toBe(authenticators.created[0]);
    expect(manager.snapshot()).toMatchObject({
      state: "running",
      port: MANAGED_PORT_START,
      pin: "08",
      linkCode: "4873508",
      bridgeInstanceId: INSTANCE_B,
    });
    expect(secondCredentials?.authToken).not.toBe(firstCredentials?.authToken);
    await manager.stop();
  });

  it("coalesces concurrent starts and queues stop until a pending start finishes", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const startGate = deferred();
    const bridges: FakeBridge[] = [];
    const states: string[] = [];
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        const bridge = new FakeBridge(options, { start: () => startGate.promise });
        bridges.push(bridge);
        return bridge;
      },
    });
    manager.onStateChanged((snapshot) => states.push(snapshot.state));

    const firstStart = manager.start();
    const secondStart = manager.start();

    expect(secondStart).toBe(firstStart);
    await eventually(() => expect(manager.snapshot().state).toBe("starting"));
    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.startCalls).toBe(1);

    const stopping = manager.stop();
    startGate.resolve();
    await Promise.all([firstStart, secondStart, stopping]);

    expect(bridges[0]?.stopCalls).toBe(1);
    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
    expect(manager.snapshot().state).toBe("stopped");
    expect(manager.getIdeCredentials()).toBeUndefined();
  });

  it("waits for a pending stop before starting a fresh server", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
      { bridgeInstanceId: INSTANCE_B, pin: "08" },
    ]);
    const stopGate = deferred();
    const bridges: FakeBridge[] = [];
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        const bridge = new FakeBridge(options, {
          stop: bridges.length === 0 ? () => stopGate.promise : undefined,
        });
        bridges.push(bridge);
        return bridge;
      },
    });
    await manager.start();

    const stopping = manager.stop();
    await eventually(() => expect(manager.snapshot().state).toBe("stopping"));
    const restarting = manager.start();
    await Promise.resolve();
    expect(bridges).toHaveLength(1);

    stopGate.resolve();
    await Promise.all([stopping, restarting]);

    expect(bridges).toHaveLength(2);
    expect(manager.snapshot()).toMatchObject({
      state: "running",
      bridgeInstanceId: INSTANCE_B,
      linkCode: "4873508",
    });
    await manager.stop();
  });

  it("clears credentials and settles stopped when the server stop fails", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    let bridge: FakeBridge | undefined;
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        bridge = new FakeBridge(options, {
          stop: () => {
            throw new Error("stop failed");
          },
        });
        return bridge;
      },
    });
    await manager.start();
    const credentials = manager.getIdeCredentials();

    await expect(manager.stop()).rejects.toThrow("stop failed");

    expect(bridge?.listenerDisposeCalls).toBe(1);
    expect(manager.snapshot()).toEqual({
      state: "stopped",
      sessionId: SESSION_ID,
      linkedBrowserCount: 0,
    });
    expect(manager.getIdeCredentials()).toBeUndefined();
    expect(
      authenticators.created[0]?.validateToken(
        SESSION_ID,
        "ide",
        credentials?.authToken ?? "",
        INSTANCE_A,
      ),
    ).toBe("rejected");

    await manager.stop();
  });

  it("notifies isolated state listeners for browser counts and honors disposal", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    let bridge: FakeBridge | undefined;
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => {
        bridge = new FakeBridge(options);
        return bridge;
      },
    });
    let throwingCalls = 0;
    const throwing = manager.onStateChanged(() => {
      throwingCalls += 1;
      throw new Error("listener failed");
    });
    const browserCounts: number[] = [];
    const observing = manager.onStateChanged((snapshot) => {
      if (snapshot.state === "running") {
        browserCounts.push(snapshot.linkedBrowserCount);
      }
    });

    await manager.start();
    browserCounts.length = 0;
    const callsAfterStart = throwingCalls;

    bridge?.emitCounts({ browser: 1, ide: 1 });
    bridge?.emitCounts({ browser: 0, ide: 1 });

    expect(browserCounts).toEqual([1, 0]);
    expect(throwingCalls).toBe(callsAfterStart + 2);

    observing.dispose();
    throwing.dispose();
    bridge?.emitCounts({ browser: 2, ide: 0 });
    expect(browserCounts).toEqual([1, 0]);
    expect(throwingCalls).toBe(callsAfterStart + 2);
    expect(manager.snapshot().linkedBrowserCount).toBe(2);
    await manager.stop();
  });

  it("returns defensive snapshots and IDE credential objects without leaking tokens", async () => {
    const authenticators = deterministicAuthenticators([
      { bridgeInstanceId: INSTANCE_A, pin: "07" },
    ]);
    const manager = new BridgeManager({
      configuration: { sessionId: SESSION_ID },
      createAuthenticator: authenticators.create,
      createBridge: (options) => new FakeBridge(options),
    });
    await manager.start();

    const snapshot = manager.snapshot();
    const credentials = manager.getIdeCredentials();
    expect(credentials).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain(credentials?.authToken);
    expect(snapshot).not.toHaveProperty("authToken");

    Reflect.set(snapshot, "state", "error");
    Reflect.set(snapshot, "pin", "99");
    if (credentials) {
      Reflect.set(credentials, "authToken", "mutated-token");
    }

    expect(manager.snapshot()).not.toBe(snapshot);
    expect(manager.snapshot()).toMatchObject({ state: "running", pin: "07" });
    expect(manager.getIdeCredentials()).not.toBe(credentials);
    expect(manager.getIdeCredentials()?.authToken).toBe(
      authenticators.created[0]?.issuedTokens[0]?.value,
    );
    await manager.stop();
  });
});

interface DeterministicIdentity {
  readonly bridgeInstanceId: string;
  readonly pin: string;
}

class RecordingAuthenticator extends LinkAuthenticator {
  readonly issuedTokens: Array<
    ReturnType<LinkAuthenticator["issueTrustedToken"]>
  > = [];

  override issueTrustedToken(role: "ide") {
    const token = super.issueTrustedToken(role);
    this.issuedTokens.push(token);
    return token;
  }
}

function deterministicAuthenticators(
  identities: readonly DeterministicIdentity[],
): {
  readonly created: RecordingAuthenticator[];
  readonly create: (options: LinkAuthenticatorOptions) => LinkAuthenticator;
} {
  const created: RecordingAuthenticator[] = [];
  return {
    created,
    create(options) {
      const identity = identities[created.length];
      if (!identity) {
        throw new Error("Missing deterministic authenticator identity");
      }
      const authenticator = new RecordingAuthenticator({
        ...options,
        ...identity,
      });
      created.push(authenticator);
      return authenticator;
    },
  };
}

interface FakeBridgeHandlers {
  readonly start?: () => void | Promise<void>;
  readonly stop?: () => void | Promise<void>;
}

class FakeBridge {
  private countListener:
    | ((counts: { readonly browser: number; readonly ide: number }) => void)
    | undefined;
  startCalls = 0;
  stopCalls = 0;
  listenerDisposeCalls = 0;

  constructor(
    readonly options: BridgeServerOptions,
    private readonly handlers: FakeBridgeHandlers = {},
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    await this.handlers.start?.();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.handlers.stop?.();
  }

  getUrl(): string {
    return `ws://${this.options.host}:${requiredPort(this.options)}`;
  }

  getLinkInfo(): { readonly bridgeInstanceId: string; readonly pin: string } {
    if (!this.options.authenticator) {
      throw new Error("Expected a managed authenticator");
    }
    return this.options.authenticator.linkInfo();
  }

  onClientCountChanged(
    listener: (counts: { readonly browser: number; readonly ide: number }) => void,
  ): { dispose(): void } {
    this.countListener = listener;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.listenerDisposeCalls += 1;
        if (this.countListener === listener) {
          this.countListener = undefined;
        }
      },
    };
  }

  emitCounts(counts: { readonly browser: number; readonly ide: number }): void {
    this.countListener?.({ ...counts });
  }
}

function requiredPort(options: BridgeServerOptions): number {
  if (options.port === undefined) {
    throw new Error("Expected an explicit managed port");
  }
  return options.port;
}

function managedPorts(): number[] {
  return Array.from(
    { length: MANAGED_PORT_COUNT },
    (_, index) => MANAGED_PORT_START + index,
  );
}

async function reserveAdjacentPorts(): Promise<{
  readonly startPort: number;
  readonly blocker: Server;
  readonly nextPort: Server;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const blocker = createServer();
    const nextPort = createServer();

    try {
      await listen(blocker, 0);
      const address = blocker.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address for managed port reservation");
      }
      if (address.port === 65_535) {
        await closeServer(blocker);
        continue;
      }

      await listen(nextPort, address.port + 1);
      return { startPort: address.port, blocker, nextPort };
    } catch (error) {
      await closeServer(nextPort);
      await closeServer(blocker);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error("Could not reserve adjacent managed ports");
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForConnected(client: BridgeClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const dispose = client.onConnectionStateChanged((state) => {
      if (state === "connected") {
        dispose();
        resolve();
      } else if (state === "error") {
        dispose();
        reject(new Error("IDE client failed to authenticate"));
      }
    });
  });
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 500) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  throw lastError;
}
