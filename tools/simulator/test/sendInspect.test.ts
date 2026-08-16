import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
} from "@pin-op/protocol";
import inspectCardFixture from "../fixtures/inspect-card.json";
import {
  buildInspectMessage,
  parseLinkCode,
  parseSendArgs,
  sendInspect,
} from "../src/sendInspect.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OTHER_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";
const AUTH_TOKEN = "a".repeat(64);
const TEST_PORT_MIN = 20_000;
const TEST_PORT_MAX = 39_999;
let nextTestPort =
  TEST_PORT_MIN + (process.pid % (TEST_PORT_MAX - TEST_PORT_MIN + 1));

describe("inspect-card fixture", () => {
  it("builds a valid inspect message with the required card facts", () => {
    const message = buildInspectMessage(inspectCardFixture, {
      sessionId: SESSION_ID,
      sourceId: "simulator-test",
    });

    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(message).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "inspect",
      sessionId: SESSION_ID,
      source: { role: "simulator", id: "simulator-test", metadata: {} },
      targets: [
        {
          role: "selected",
          depth: 0,
          subject: {
            selector: "div#hero.card.featured",
            metadata: { kind: "dom-node" },
          },
        },
      ],
      context: { url: "http://localhost:3000/", metadata: { viewport: "desktop" } },
    });
    expect(message.targets[0]?.subject.text).toBeUndefined();

    expect(message.targets[0]?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "css-rule",
          selector: ".card",
          metadata: { sourceUrl: "/dist/app.css" },
        }),
        expect.objectContaining({
          type: "css-rule",
          selector: ".featured",
          metadata: { sourceUrl: "/dist/app.css" },
        }),
        expect.objectContaining({
          type: "css-rule",
          selector: ".card",
          metadata: {
            status: "external",
            sourceUrl: "https://cdn.jsdelivr.net/npm/bootstrap/dist/css/bootstrap.css",
          },
        }),
      ]),
    );
  });
});

describe("parseLinkCode", () => {
  it.each(["48735 07", "48735-07", "4873507"])(
    "parses %s without losing a leading-zero PIN",
    (value) => {
      expect(parseLinkCode(value)).toEqual({
        url: "ws://127.0.0.1:48735",
        pin: "07",
      });
    },
  );

  it.each(["487350", "48735070", "48735A7", "48735_7"])(
    "rejects malformed code %s",
    (value) => {
      expect(() => parseLinkCode(value)).toThrow("seven digits");
    },
  );

  it.each(["0999907", "6553607"])("rejects invalid port code %s", (value) => {
    expect(() => parseLinkCode(value)).toThrow("invalid port");
  });

  it.each([
    ["1000007", "ws://127.0.0.1:10000"],
    ["6553507", "ws://127.0.0.1:65535"],
  ])("accepts boundary port code %s", (value, url) => {
    expect(parseLinkCode(value)).toEqual({ url, pin: "07" });
  });
});

describe("sendInspect CLI parsing", () => {
  it("parses the documented link-code command", () => {
    expect(
      parseSendArgs([
        "send",
        "--",
        "--link-code",
        "48735-07",
        "--fixture",
        "inspect-card",
      ]),
    ).toMatchObject({
      command: "send",
      linkCode: "48735-07",
      fixture: "inspect-card",
      sourceId: "pinop-simulator",
    });
  });

  it("rejects the removed legacy code flag", () => {
    expect(() =>
      parseSendArgs([
        "send",
        "--pairing-code",
        "4873507",
        "--fixture",
        "inspect-card",
      ]),
    ).toThrow("Unknown option: --pairing-code");
  });

  it("parses complete explicit token credentials", () => {
    expect(
      parseSendArgs([
        "send",
        "--url",
        "ws://127.0.0.1:48735",
        "--session-id",
        SESSION_ID,
        "--bridge-instance-id",
        INSTANCE_ID,
        "--auth-token",
        AUTH_TOKEN,
        "--fixture",
        "inspect-card",
      ]),
    ).toMatchObject({
      command: "send",
      url: "ws://127.0.0.1:48735",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: AUTH_TOKEN,
      fixture: "inspect-card",
    });
  });

  it.each([
    ["URL", ["--session-id", SESSION_ID, "--bridge-instance-id", INSTANCE_ID, "--auth-token", AUTH_TOKEN]],
    ["session", ["--url", "ws://127.0.0.1:48735", "--bridge-instance-id", INSTANCE_ID, "--auth-token", AUTH_TOKEN]],
    ["instance", ["--url", "ws://127.0.0.1:48735", "--session-id", SESSION_ID, "--auth-token", AUTH_TOKEN]],
    ["token", ["--url", "ws://127.0.0.1:48735", "--session-id", SESSION_ID, "--bridge-instance-id", INSTANCE_ID]],
  ])("rejects explicit token mode with a missing %s", (_field, flags) => {
    expect(() =>
      parseSendArgs(["send", ...flags, "--fixture", "inspect-card"]),
    ).toThrow(
      "Explicit token mode requires --url, --session-id, --bridge-instance-id, and --auth-token",
    );
  });

  it("rejects mixed link-code and explicit token modes", () => {
    expect(() =>
      parseSendArgs([
        "send",
        "--link-code",
        "4873507",
        "--url",
        "ws://127.0.0.1:48735",
        "--session-id",
        SESSION_ID,
        "--bridge-instance-id",
        INSTANCE_ID,
        "--auth-token",
        AUTH_TOKEN,
        "--fixture",
        "inspect-card",
      ]),
    ).toThrow("Use either --link-code or explicit token credentials, not both");
  });
});

describe("sendInspect", () => {
  it("waits for link acceptance and matching authentication before inspect", async () => {
    const bridge = await createBridgeHarness();
    try {
      const sending = sendInspect({
        linkCode: bridge.linkCode("07"),
        fixture: "inspect-card",
        sourceId: "simulator-link",
      });

      expect(await bridge.nextMessage()).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "linkRequest",
        pin: "07",
        source: { role: "simulator", id: "simulator-link" },
      });
      await delay(15);
      expect(bridge.pendingMessages()).toEqual([]);

      await bridge.send(linkAccepted());
      expect(await bridge.nextMessage()).toMatchObject({
        type: "hello",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        authToken: AUTH_TOKEN,
        capabilities: ["inspect"],
      });
      await delay(15);
      expect(bridge.pendingMessages()).toEqual([]);

      await bridge.send(authenticated());
      const inspect = await bridge.nextMessage();
      expect(inspect).toMatchObject({
        type: "inspect",
        sessionId: SESSION_ID,
        source: { role: "simulator", id: "simulator-link" },
        targets: [{ subject: { selector: "div#hero.card.featured" } }],
      });

      await expect(sending).resolves.toMatchObject({
        type: "inspect",
        sessionId: SESSION_ID,
      });
    } finally {
      await bridge.close();
    }
  });

  it("keeps explicit token mode and waits for matching authentication", async () => {
    const bridge = await createBridgeHarness();
    try {
      const sending = sendInspect({
        url: bridge.url,
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        authToken: AUTH_TOKEN,
        fixture: "inspect-card",
        sourceId: "simulator-token",
      });

      expect(await bridge.nextMessage()).toMatchObject({
        type: "hello",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        authToken: AUTH_TOKEN,
        capabilities: ["inspect"],
      });
      await delay(15);
      expect(bridge.pendingMessages()).toEqual([]);

      await bridge.send(authenticated());
      expect(await bridge.nextMessage()).toMatchObject({
        type: "inspect",
        source: { role: "simulator", id: "simulator-token" },
      });
      await expect(sending).resolves.toMatchObject({ type: "inspect" });
    } finally {
      await bridge.close();
    }
  });

  it("rejects mismatched authentication without sending inspect", async () => {
    const bridge = await createBridgeHarness();
    try {
      const sending = sendInspect({
        url: bridge.url,
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        authToken: AUTH_TOKEN,
        fixture: "inspect-card",
      });

      expect(await bridge.nextMessage()).toMatchObject({ type: "hello" });
      await bridge.send(authenticated(SESSION_ID, OTHER_INSTANCE_ID));

      await expect(sending).rejects.toThrow("authenticated a different session or bridge instance");
      await delay(15);
      expect(bridge.pendingMessages()).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it("sanitizes authentication errors and never sends inspect", async () => {
    const bridge = await createBridgeHarness();
    try {
      const sending = sendInspect({
        linkCode: bridge.linkCode("07"),
        fixture: "inspect-card",
      });

      expect(await bridge.nextMessage()).toMatchObject({ type: "linkRequest" });
      await bridge.send(linkAccepted());
      expect(await bridge.nextMessage()).toMatchObject({ type: "hello" });
      await bridge.send({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "auth-error-1",
        code: "auth.tokenRejected",
        message: `Rejected credential ${AUTH_TOKEN}`,
        metadata: {},
      });

      const error = await sending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("auth.tokenRejected");
      expect((error as Error).message).not.toContain(AUTH_TOKEN);
      await delay(15);
      expect(bridge.pendingMessages()).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
});

interface BridgeHarness {
  readonly url: string;
  linkCode(pin: string): string;
  nextMessage(): Promise<Record<string, unknown>>;
  pendingMessages(): readonly Record<string, unknown>[];
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function createBridgeHarness(): Promise<BridgeHarness> {
  const server = await createTestServer();
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Expected a TCP test server address");
  }

  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  let resolveSocket!: (socket: WebSocket) => void;
  const connected = new Promise<WebSocket>((resolve) => {
    resolveSocket = resolve;
  });
  server.on("connection", (socket) => {
    socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queued.push(message);
      }
    });
    resolveSocket(socket);
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    linkCode: (pin) => `${address.port}${pin}`,
    nextMessage: () => {
      const message = queued.shift();
      if (message) {
        return Promise.resolve(message);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    pendingMessages: () => [...queued],
    send: async (message) => {
      const socket = await connected;
      await new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify(message), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close: () => closeServer(server),
  };
}

async function createTestServer(): Promise<WebSocketServer> {
  const attempts = TEST_PORT_MAX - TEST_PORT_MIN + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = nextTestPort;
    nextTestPort = port === TEST_PORT_MAX ? TEST_PORT_MIN : port + 1;
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    try {
      await waitForServer(server);
      return server;
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }
  throw new Error("No five-digit simulator test port is available");
}

function waitForServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
}

function linkAccepted() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "linkAccepted",
    messageId: "link-accepted-1",
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    authToken: AUTH_TOKEN,
    expiresAt: "2026-08-01T00:00:00.000Z",
    metadata: {},
  };
}

function authenticated(
  sessionId = SESSION_ID,
  bridgeInstanceId = INSTANCE_ID,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "authenticated",
    messageId: "authenticated-1",
    sessionId,
    bridgeInstanceId,
    metadata: {},
  };
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
