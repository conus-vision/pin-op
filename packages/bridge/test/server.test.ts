import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  INSPECT_ENVELOPE_MAX_BYTES,
  PROTOCOL_VERSION,
  type ClientRole,
} from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as bridgeExports from "../src/index.js";
import { LinkAuthenticator } from "../src/linkAuthenticator.js";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  createBridgeServer,
  type BridgeServer,
} from "../src/server.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OLD_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";
const PIN = "07";
const STARTED_AT = new Date("2026-07-09T12:00:00.000Z");

describe("bridge server link authentication", () => {
  it("links, authenticates, and unlinks only the connection token", async () => {
    const authenticator = createAuthenticator();
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(socket, linkRequest());

      expect(accepted).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "linkAccepted",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        expiresAt: "2026-07-10T12:00:00.000Z",
        metadata: {},
      });
      expect(accepted.authToken).toMatch(/^[a-f0-9]{64}$/);

      const authToken = readString(accepted, "authToken");
      const survivingToken = acceptedToken(authenticator);
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticated",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        metadata: {},
      });
      expect(server.registry.countByRole("browser")).toBe(1);

      const unlinked = once(socket, "close");
      socket.send(JSON.stringify(unlink()));
      await unlinked;
      expect(server.registry.countByRole("browser")).toBe(0);

      const retry = await connect(server.getUrl());
      await expectSocketErrorAndClose(retry, hello(authToken), {
        code: "auth.tokenRejected",
      });

      const survivingSocket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(survivingSocket, hello(survivingToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await closeSocket(survivingSocket);
    } finally {
      await server.stop();
    }
  });

  it("returns one generic rejection for a wrong PIN", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const error = await expectSocketErrorAndClose(
        socket,
        linkRequest("99"),
        {
          code: "link.rejected",
          message: "Link request rejected",
        },
      );
      expectLinkErrorNotToExposePin(error, "99");
    } finally {
      await server.stop();
    }
  });

  it("keeps link rate limiting global across separate sockets", async () => {
    const server = createTestServer();
    await server.start();

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const socket = await connect(server.getUrl());
        await expectSocketErrorAndClose(
          socket,
          linkRequest("99", `link-${attempt}`),
          {
            code: "link.rejected",
            message: "Link request rejected",
          },
        );
      }

      const socket = await connect(server.getUrl());
      const error = await expectSocketErrorAndClose(
        socket,
        linkRequest("99", "link-rate-limited"),
        {
          code: "link.rateLimited",
          message: "Link request rate limited",
          details: {
            fatal: false,
            retryAt: "2026-07-09T12:01:00.000Z",
          },
        },
      );
      expectLinkErrorNotToExposePin(error, "99");
    } finally {
      await server.stop();
    }
  });

  it("rejects a second link request on the same socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, linkRequest(PIN, "link-first")),
      ).resolves.toMatchObject({ type: "linkAccepted" });

      await expectSocketErrorAndClose(
        socket,
        linkRequest(PIN, "link-second"),
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("terminates an idle socket after the handshake timeout", async () => {
    const server = createBridgeServer({ port: 0, handshakeTimeoutMs: 50 });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketCloses(socket);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await server.stop();
    }
  });

  it("clears the handshake timeout after authentication", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({
      port: 0,
      authenticator,
      handshakeTimeoutMs: 50,
    });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await delay(100);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await closeSocket(socket);
    } finally {
      await server.stop();
    }
  });

  it("drops messages queued behind unlink before they can be routed", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    const tokenStateAtCount: string[] = [];
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));
      const countListener = server.onClientCountChanged((next) => {
        counts.push(next);
        tokenStateAtCount.push(
          authenticator.validateToken(
            SESSION_ID,
            "browser",
            browserToken,
            INSTANCE_ID,
          ),
        );
      });

      const routed: unknown[] = [];
      ide.on("message", (data) => routed.push(JSON.parse(data.toString())));
      const closed = once(browser, "close");
      browser.send(JSON.stringify(unlink()));
      browser.send(JSON.stringify(inspectMessage()));
      await closed;
      await delay(20);

      expect(routed).toEqual([]);
      expect(counts).toEqual([{ browser: 0, ide: 1 }]);
      expect(tokenStateAtCount).toEqual(["rejected"]);
      countListener.dispose();
      await closeSocket(ide);
    } finally {
      await server.stop();
    }
  });

  it("checks the bridge instance before validating the token", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        hello("invalid-token", "browser", OLD_INSTANCE_ID),
        { code: "auth.instanceChanged" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects an invalid token and closes the socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(socket, hello("invalid-token"), {
        code: "auth.tokenRejected",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects a valid token presented for the wrong session", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        hello(authToken, "browser", INSTANCE_ID, "other-session"),
        { code: "auth.tokenRejected" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects an expired token and closes the socket", async () => {
    let now = new Date(STARTED_AT);
    const authenticator = createAuthenticator({ now: () => now });
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const linkSocket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(linkSocket, linkRequest());
      const authToken = readString(accepted, "authToken");
      await closeSocket(linkSocket);

      now = new Date("2026-07-10T12:00:00.001Z");
      const helloSocket = await connect(server.getUrl());
      await expectSocketErrorAndClose(helloSocket, hello(authToken), {
        code: "auth.tokenRejected",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects a token presented by the wrong role and closes the socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const linkSocket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(linkSocket, linkRequest());
      const authToken = readString(accepted, "authToken");
      await closeSocket(linkSocket);

      const helloSocket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        helloSocket,
        hello(authToken, "ide"),
        { code: "auth.tokenRejected" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed clients with protocol.invalidMessage and closes", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "unknown",
          messageId: "invalid-1",
          metadata: {},
        },
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects routed messages before hello and closes", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "pong",
          messageId: "pong-before-hello",
          pingMessageId: "ping-1",
          sentAt: STARTED_AT.toISOString(),
          metadata: {},
        },
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects a second hello after registration and closes", async () => {
    const authenticator = createAuthenticator();
    const token = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, hello(token.value, "ide")),
      ).resolves.toMatchObject({ type: "authenticated" });

      await expectSocketErrorAndClose(socket, hello(token.value, "ide"), {
        code: "protocol.invalidMessage",
      });
    } finally {
      await server.stop();
    }
  });

  it("uses a default session and authenticator", async () => {
    const server = createBridgeServer({ port: 0 });
    expect(server.authenticator).toBeInstanceOf(LinkAuthenticator);
    expect(server.getLinkInfo()).toEqual(server.authenticator.linkInfo());
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(
        socket,
        linkRequest(server.getLinkInfo().pin),
      );
      expect(accepted).toMatchObject({
        type: "linkAccepted",
        sessionId: "default",
        bridgeInstanceId: server.getLinkInfo().bridgeInstanceId,
      });
      await closeSocket(socket);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server client counts", () => {
  it("reports browser removal after heartbeat eviction", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({
      port: 0,
      authenticator,
      heartbeatIntervalMs: 10,
    });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const closed = once(socket, "close");
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });

      await eventually(() =>
        expect(counts).toEqual([
          { browser: 1, ide: 0 },
          { browser: 0, ide: 0 },
        ]),
      );
      await closed;
      await delay(20);
      expect(counts).toEqual([
        { browser: 1, ide: 0 },
        { browser: 0, ide: 0 },
      ]);
      expect(server.registry.all()).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("reports browser registration and removal, and listener disposal works", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    const listener = server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    try {
      const first = await connect(server.getUrl());
      await expect(sendJsonAndReceive(first, hello(authToken))).resolves.toMatchObject({
        type: "authenticated",
      });
      await eventually(() => expect(counts).toEqual([{ browser: 1, ide: 0 }]));

      await closeSocket(first);
      await eventually(() =>
        expect(counts).toEqual([
          { browser: 1, ide: 0 },
          { browser: 0, ide: 0 },
        ]),
      );

      listener.dispose();
      const countAtDisposal = counts.length;
      const second = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(second, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await closeSocket(second);
      expect(counts).toHaveLength(countAtDisposal);
    } finally {
      await server.stop();
    }
  });

  it("isolates listener errors from registration and shutdown", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged(() => {
      throw new Error("listener failed");
    });
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    const socket = await connect(server.getUrl());
    await expect(sendJsonAndReceive(socket, hello(authToken))).resolves.toMatchObject({
      type: "authenticated",
    });
    expect(server.registry.countByRole("browser")).toBe(1);

    await server.stop();
    await eventually(() => expect(counts.at(-1)).toEqual({ browser: 0, ide: 0 }));
    expect(server.registry.all()).toEqual([]);
  });

  it("clears clients, revokes tokens, emits zero, and stops repeatedly", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    const socket = await connect(server.getUrl());
    await expect(sendJsonAndReceive(socket, hello(authToken))).resolves.toMatchObject({
      type: "authenticated",
    });
    await eventually(() => expect(server.registry.countByRole("browser")).toBe(1));

    const closed = once(socket, "close");
    await server.stop();
    await closed;
    expect(server.registry.all()).toEqual([]);
    expect(counts.at(-1)).toEqual({ browser: 0, ide: 0 });
    await server.stop();
    await server.stop();
    expect(
      authenticator.validateToken(
        SESSION_ID,
        "browser",
        authToken,
        INSTANCE_ID,
      ),
    ).toBe("rejected");
  });
});

describe("bridge server authenticated envelope identity", () => {
  it.each([
    [
      "linkAccepted",
      () => ({
        protocolVersion: PROTOCOL_VERSION,
        type: "linkAccepted",
        messageId: "replayed-link-accepted",
        sessionId: "other-session",
        bridgeInstanceId: OLD_INSTANCE_ID,
        authToken: "a".repeat(64),
        expiresAt: "2026-07-10T12:00:00.000Z",
        metadata: {},
      }),
    ],
    [
      "authenticated",
      () => ({
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticated",
        messageId: "replayed-authenticated",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        metadata: {},
      }),
    ],
    [
      "ping",
      () => ({
        protocolVersion: PROTOCOL_VERSION,
        type: "ping",
        messageId: "replayed-ping",
        sentAt: STARTED_AT.toISOString(),
        metadata: {},
      }),
    ],
    [
      "error",
      () => ({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "replayed-error",
        code: "bridge.offline",
        message: "Spoofed bridge error",
        metadata: {},
      }),
    ],
  ])(
    "rejects a post-auth client replay of server-originated %s",
    async (_type, createMessage) => {
      const authenticator = createAuthenticator();
      const browserToken = acceptedToken(authenticator);
      const ideToken = authenticator.issueTrustedToken("ide");
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
        const browser = await connect(server.getUrl());
        await sendJsonAndReceive(browser, hello(browserToken));
        const ideMessages: unknown[] = [];
        const browserMessages: unknown[] = [];
        ide.on("message", (data) =>
          ideMessages.push(JSON.parse(data.toString())),
        );
        browser.on("message", (data) =>
          browserMessages.push(JSON.parse(data.toString())),
        );
        const closed = once(browser, "close");

        browser.send(JSON.stringify(createMessage()));

        await eventually(() =>
          expect(browserMessages).toEqual([
            expect.objectContaining({
              type: "error",
              code: "protocol.invalidMessage",
              message: "Message does not match protocol",
              details: { fatal: true },
            }),
          ]),
        );
        await closed;
        await delay(20);
        expect(ideMessages).toEqual([]);
        expect(server.registry.countByRole("browser")).toBe(0);
        await closeSocket(ide);
      } finally {
        await server.stop();
      }
    },
  );

  it.each(["browser", "simulator"] as const)(
    "routes multiplexed inspect source IDs from one authenticated %s socket",
    async (role) => {
      const authenticator = createAuthenticator();
      const senderToken = acceptedToken(authenticator, role);
      const ideToken = authenticator.issueTrustedToken("ide");
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
        const sender = await connect(server.getUrl());
        await sendJsonAndReceive(sender, hello(senderToken, role));

        const firstRouted = nextJsonMessageBeforeClose(ide, sender);
        sender.send(JSON.stringify(inspectMessage("panel-101", role)));
        await expect(firstRouted).resolves.toMatchObject({
          type: "inspect",
          sessionId: SESSION_ID,
          source: { role, id: "panel-101" },
        });

        const secondRouted = nextJsonMessageBeforeClose(ide, sender);
        sender.send(JSON.stringify(inspectMessage("panel-102", role)));
        await expect(secondRouted).resolves.toMatchObject({
          type: "inspect",
          sessionId: SESSION_ID,
          source: { role, id: "panel-102" },
        });

        expect(sender.readyState).toBe(WebSocket.OPEN);
        await Promise.all([closeSocket(sender), closeSocket(ide)]);
      } finally {
        await server.stop();
      }
    },
  );

  it("delivers resolutions only to the originating authenticated client", async () => {
    const authenticator = createAuthenticator();
    const browserAToken = acceptedToken(authenticator);
    const browserBToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const queues: MessageQueue[] = [];

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browserA = await connect(server.getUrl());
      await sendJsonAndReceive(browserA, hello(browserAToken));
      const browserB = await connect(server.getUrl());
      await sendJsonAndReceive(browserB, hello(browserBToken));
      const ideInspects = listenForJsonMessages(
        ide,
        (message) => message.type === "inspect",
      );
      const browserAResolutions = listenForJsonMessages(
        browserA,
        (message) => message.type === "resolution",
      );
      const browserBResolutions = listenForJsonMessages(
        browserB,
        (message) => message.type === "resolution",
      );
      const browserBCommands = listenForJsonMessages(
        browserB,
        (message) => message.type === "command",
      );
      queues.push(
        ideInspects,
        browserAResolutions,
        browserBResolutions,
        browserBCommands,
      );

      browserA.send(JSON.stringify(inspectMessage("browser-a")));
      browserB.send(JSON.stringify(inspectMessage("browser-b")));
      await eventually(() => {
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ messageId: "inspect-browser-a" }),
        );
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ messageId: "inspect-browser-b" }),
        );
      });

      ide.send(JSON.stringify(resolutionMessage("inspect-browser-a")));
      ide.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "resolution-barrier-command",
        command: "highlightElement",
        arguments: { selector: "#barrier", metadata: {} },
        metadata: {},
      }));
      await eventually(() =>
        expect(browserAResolutions.messages).toContainEqual(
          expect.objectContaining({
            type: "resolution",
            inspectMessageId: "inspect-browser-a",
          }),
        ),
      );
      await eventually(() =>
        expect(browserBCommands.messages).toContainEqual(
          expect.objectContaining({ messageId: "resolution-barrier-command" }),
        ),
      );
      expect(browserBResolutions.messages).toEqual([]);

      await Promise.all([closeSocket(browserA), closeSocket(browserB), closeSocket(ide)]);
    } finally {
      for (const queue of queues) {
        queue.dispose();
      }
      await server.stop();
    }
  });

  it.each([
    ["source", { source: { role: "ide" as const, id: "spoofed-ide" } }],
    ["session", { sessionId: "other-session" }],
  ])("rejects a resolution with a spoofed authenticated IDE %s", async (_field, spoof) => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));

      await expectSocketErrorAndClose(
        ide,
        { ...resolutionMessage("unknown-inspect"), ...spoof },
        { code: "protocol.invalidMessage", message: "Message does not match protocol" },
      );
      await closeSocket(browser);
    } finally {
      await server.stop();
    }
  });

  it("removes routes on close, unlink, heartbeat eviction, and stop", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const unlinkBrowserToken = acceptedToken(authenticator);
    const evictionBrowserToken = acceptedToken(authenticator);
    const stopBrowserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const replyRoutes = new ReplyRouteRegistry();
    const server = createBridgeServer({
      port: 0,
      authenticator,
      heartbeatIntervalMs: 100,
      replyRoutes,
    });
    await server.start();
    const queues: MessageQueue[] = [];
    const listenerDisposers: Array<() => void> = [];

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      listenerDisposers.push(autoPong(ide));
      const ideInspects = listenForJsonMessages(
        ide,
        (message) => message.type === "inspect",
      );
      const ideErrors = listenForJsonMessages(
        ide,
        (message) => message.type === "error",
      );
      queues.push(ideInspects, ideErrors);

      const browserAfterClose = await connect(server.getUrl());
      await sendJsonAndReceive(browserAfterClose, hello(browserToken));
      listenerDisposers.push(autoPong(browserAfterClose));
      browserAfterClose.send(JSON.stringify(inspectMessage("close-route")));
      await eventually(() =>
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ type: "inspect", messageId: "inspect-close-route" }),
        ),
      );
      await closeSocket(browserAfterClose);
      await eventually(() => expect(server.registry.countByRole("browser")).toBe(0));
      expect(replyRoutes.resolve("session-1", "inspect-close-route")).toBeUndefined();
      ide.send(JSON.stringify(resolutionMessage("inspect-close-route")));
      await eventually(() =>
        expect(ideErrors.messages.at(-1)).toEqual(
          expect.objectContaining({ code: "bridge.noBrowserClient" }),
        ),
      );

      const browserAfterUnlink = await connect(server.getUrl());
      await sendJsonAndReceive(browserAfterUnlink, hello(unlinkBrowserToken));
      listenerDisposers.push(autoPong(browserAfterUnlink));
      browserAfterUnlink.send(JSON.stringify(inspectMessage("unlink-route")));
      await eventually(() =>
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ type: "inspect", messageId: "inspect-unlink-route" }),
        ),
      );
      const unlinked = once(browserAfterUnlink, "close");
      browserAfterUnlink.send(JSON.stringify(unlink()));
      await unlinked;
      await eventually(() => expect(server.registry.countByRole("browser")).toBe(0));
      expect(replyRoutes.resolve("session-1", "inspect-unlink-route")).toBeUndefined();
      ide.send(JSON.stringify(resolutionMessage("inspect-unlink-route")));
      await eventually(() =>
        expect(ideErrors.messages.at(-1)).toEqual(
          expect.objectContaining({ code: "bridge.noBrowserClient" }),
        ),
      );

      const browserAfterEviction = await connect(server.getUrl());
      await sendJsonAndReceive(browserAfterEviction, hello(evictionBrowserToken));
      browserAfterEviction.send(JSON.stringify(inspectMessage("eviction-route")));
      await eventually(() =>
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ type: "inspect", messageId: "inspect-eviction-route" }),
        ),
      );
      const registered = server.registry
        .all()
        .find((client) => client.source.role === "browser");
      if (!registered) {
        throw new Error("Expected registered browser client");
      }
      registered.missedPongs = 2;
      await eventually(() => expect(server.registry.countByRole("browser")).toBe(0));
      expect(replyRoutes.resolve("session-1", "inspect-eviction-route")).toBeUndefined();
      ide.send(JSON.stringify(resolutionMessage("inspect-eviction-route")));
      await eventually(() =>
        expect(ideErrors.messages.at(-1)).toEqual(
          expect.objectContaining({ code: "bridge.noBrowserClient" }),
        ),
      );

      const browserBeforeStop = await connect(server.getUrl());
      await sendJsonAndReceive(browserBeforeStop, hello(stopBrowserToken));
      listenerDisposers.push(autoPong(browserBeforeStop));
      browserBeforeStop.send(JSON.stringify(inspectMessage("stop-route")));
      await eventually(() =>
        expect(ideInspects.messages).toContainEqual(
          expect.objectContaining({ type: "inspect", messageId: "inspect-stop-route" }),
        ),
      );
      const stopClient = server.registry
        .all()
        .find((client) => client.source.role === "browser");
      if (!stopClient) {
        throw new Error("Expected browser client before stop");
      }
      expect(replyRoutes.resolve("session-1", "inspect-stop-route")).toBe(
        stopClient.id,
      );
      await server.stop();
      expect(server.registry.all()).toEqual([]);
      expect(replyRoutes.resolve("session-1", "inspect-stop-route")).toBeUndefined();
    } finally {
      for (const disposer of listenerDisposers) {
        disposer();
      }
      for (const queue of queues) {
        queue.dispose();
      }
      await server.stop();
    }
  });

  it.each([
    [
      "session",
      (message: ReturnType<typeof inspectMessage>) => ({
        ...message,
        sessionId: "other-session",
      }),
    ],
    [
      "role",
      (message: ReturnType<typeof inspectMessage>) => ({
        ...message,
        source: source("simulator"),
      }),
    ],
  ])(
    "rejects an inspect message with a mismatched authenticated %s",
    async (_field, spoof) => {
      const authenticator = createAuthenticator();
      const browserToken = acceptedToken(authenticator);
      const ideToken = authenticator.issueTrustedToken("ide");
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
        const browser = await connect(server.getUrl());
        await sendJsonAndReceive(browser, hello(browserToken));
        const routed: unknown[] = [];
        ide.on("message", (data) => routed.push(JSON.parse(data.toString())));

        const error = await expectSocketErrorAndClose(
          browser,
          spoof(inspectMessage()),
          {
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
          },
        );
        await delay(20);

        expect(routed).toEqual([]);
        expect(JSON.stringify(error)).not.toContain(browserToken);
        await closeSocket(ide);
      } finally {
        await server.stop();
      }
    },
  );

  it("rejects unlink for a different authenticated session without revoking the token", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));

      await expectSocketErrorAndClose(
        browser,
        { ...unlink(), sessionId: "other-session" },
        {
          code: "protocol.invalidMessage",
          message: "Message does not match protocol",
        },
      );
      expect(
        authenticator.validateToken(
          SESSION_ID,
          "browser",
          browserToken,
          INSTANCE_ID,
        ),
      ).toBe("accepted");
    } finally {
      await server.stop();
    }
  });

  it("continues handling role-appropriate authenticated client messages", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));
      const routed = nextJsonMessage(ide);

      browser.send(JSON.stringify(inspectMessage()));

      await expect(routed).resolves.toMatchObject({
        type: "inspect",
        sessionId: SESSION_ID,
        source: source("browser"),
      });

      const command = {
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "allowed-command",
        command: "highlightElement",
        arguments: { selector: "#submit", metadata: {} },
        metadata: {},
      };
      const routedCommand = nextJsonMessage(browser);
      ide.send(JSON.stringify(command));
      await expect(routedCommand).resolves.toMatchObject(command);

      const references = {
        protocolVersion: PROTOCOL_VERSION,
        type: "references",
        messageId: "allowed-references",
        subject: { selector: "#submit", metadata: {} },
        references: [],
        metadata: {},
      };
      const routedReferences = nextJsonMessage(browser);
      ide.send(JSON.stringify(references));
      await expect(routedReferences).resolves.toMatchObject(references);

      const browserEntry = server.registry
        .all()
        .find((client) => client.source.role === "browser");
      if (!browserEntry) {
        throw new Error("Expected registered browser client");
      }
      browserEntry.missedPongs = 1;
      browser.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "pong",
          messageId: "allowed-pong",
          pingMessageId: "ping-1",
          sentAt: STARTED_AT.toISOString(),
          metadata: {},
        }),
      );
      await eventually(() => expect(browserEntry.missedPongs).toBe(0));
      expect(browser.readyState).toBe(WebSocket.OPEN);

      await Promise.all([closeSocket(browser), closeSocket(ide)]);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server send safety", () => {
  it("keeps a registry connection safe after its socket closes", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await sendJsonAndReceive(socket, hello(authToken));
      const connection = server.registry.all()[0]?.connection;
      if (!connection) {
        throw new Error("Expected registered browser connection");
      }

      await closeSocket(socket);

      expect(() => connection.send("{}")).not.toThrow();
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server network policy", () => {
  it.each([
    ["null", null],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["above the production ceiling", BRIDGE_MAX_PAYLOAD_BYTES + 1],
  ])("rejects a %s maxPayloadBytes option", (_name, maxPayloadBytes) => {
    expect(() =>
      createBridgeServer({ maxPayloadBytes: maxPayloadBytes as number }),
    ).toThrow(
      `Bridge max payload must be an integer from 1 to ${BRIDGE_MAX_PAYLOAD_BYTES} bytes`,
    );
  });

  it("enforces the default payload ceiling at its byte boundary", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();

    try {
      const atLimit = await connect(server.getUrl());
      const acceptedAtLimit = nextJsonMessage(atLimit);
      const atLimitClosed = once(atLimit, "close");
      atLimit.send(Buffer.alloc(BRIDGE_MAX_PAYLOAD_BYTES, 0x61));
      await expect(acceptedAtLimit).resolves.toMatchObject({
        type: "error",
        code: "protocol.invalidMessage",
      });
      await atLimitClosed;

      const overLimit = await connect(server.getUrl());
      const received: unknown[] = [];
      overLimit.on("message", (data) =>
        received.push(JSON.parse(data.toString())),
      );
      const overLimitClosed = once(overLimit, "close");
      overLimit.send(Buffer.alloc(BRIDGE_MAX_PAYLOAD_BYTES + 1, 0x61));

      const [code] = await overLimitClosed;
      expect(code).toBe(1009);
      expect(received).toEqual([]);
      expect(INSPECT_ENVELOPE_MAX_BYTES).toBeLessThan(
        BRIDGE_MAX_PAYLOAD_BYTES,
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects frames above the configured payload limit before protocol parsing", async () => {
    const maxPayloadBytes = 256;
    const server = createBridgeServer({ port: 0, maxPayloadBytes });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const received: unknown[] = [];
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
      const closed = once(socket, "close");

      socket.send(Buffer.alloc(maxPayloadBytes + 1, 0x61));

      const [code] = await closed;
      expect(code).toBe(1009);
      expect(received).toEqual([]);
      expect(server.registry.all()).toEqual([]);
      expect(BRIDGE_MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
    } finally {
      await server.stop();
    }
  });

  it("binds and advertises only the exact approved loopback host", async () => {
    for (const host of ["0.0.0.0", "localhost", "::1"]) {
      expect(() => createBridgeServer({ host, port: 0 })).toThrow(
        "Bridge host must be 127.0.0.1",
      );
    }

    const defaultHostServer = createBridgeServer({ port: 0 });
    await defaultHostServer.start();

    try {
      expect(defaultHostServer.getUrl()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(defaultHostServer.getUrl()).not.toContain("0.0.0.0");
      expect(defaultHostServer.getUrl().endsWith(":0")).toBe(false);
    } finally {
      await defaultHostServer.stop();
    }
  });

  it("rejects webpage origins and allows extension and originless clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();

    try {
      await expect(
        connect(server.getUrl(), "https://untrusted.example"),
      ).rejects.toThrow();

      const firefox = await connect(
        server.getUrl(),
        "moz-extension://browser2ide-test",
      );
      const chromium = await connect(
        server.getUrl(),
        "chrome-extension://browser2ide-test",
      );
      const originless = await connect(server.getUrl());
      await Promise.all([
        closeSocket(firefox),
        closeSocket(chromium),
        closeSocket(originless),
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server lifecycle", () => {
  it("stops promptly and closes active WebSocket clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();
    const socket = await connect(server.getUrl());
    const closed = once(socket, "close");

    const stopPromise = server.stop();
    const outcome = await Promise.race([
      stopPromise.then(() => "stopped"),
      delay(100).then(() => "timed-out"),
    ]);

    if (outcome !== "stopped") {
      socket.terminate();
      await stopPromise;
    }

    expect(outcome).toBe("stopped");
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("resets failed start state so a later start can succeed", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address for blocker");
    }

    const server = createBridgeServer({ port: address.port });

    await expect(server.start()).rejects.toThrow();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );

    await server.start();
    const socket = await connect(server.getUrl());
    await closeSocket(socket);
    await server.stop();
  });

  it("serializes concurrent starts so stop closes the single listener", async () => {
    const bridge = createBridgeServer({ port: 0 });

    await Promise.all([bridge.start(), bridge.start()]);
    const url = bridge.getUrl();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    await bridge.stop();
    expect(await canConnect(url)).toBe(false);
  });

  it("stops a listener that finishes starting after stop is requested", async () => {
    const bridge = createBridgeServer({ port: 0 });

    const starting = bridge.start();
    await bridge.stop();
    await starting;
    const url = bridge.getUrl();
    const connected = await canConnect(url);
    await bridge.stop();

    expect(connected).toBe(false);
  });

  it("requires a new BridgeServer after a successful start and stop", async () => {
    const bridge = createBridgeServer({ port: 0 });

    await bridge.start();
    await bridge.stop();

    await expect(bridge.start()).rejects.toThrow(
      "BridgeServer cannot be restarted; create a new BridgeServer",
    );
  });
});

describe("bridge public surface", () => {
  it("does not export or retain the legacy link store source", () => {
    const legacyStoreName = ["Pairing", "Store"].join("");
    expect(bridgeExports).not.toHaveProperty(legacyStoreName);
    expect(existsSync(new URL("../src/pairing.ts", import.meta.url))).toBe(false);
  });

  it("does not expose a standalone bridge CLI or package bin", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly bin?: unknown;
      readonly scripts?: Record<string, unknown>;
    };

    expect(existsSync(new URL("../src/cli.ts", import.meta.url))).toBe(false);
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson.scripts).not.toHaveProperty("dev");
  });
});

function createAuthenticator(
  overrides: Partial<ConstructorParameters<typeof LinkAuthenticator>[0]> = {},
): LinkAuthenticator {
  return new LinkAuthenticator({
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    pin: PIN,
    now: () => new Date(STARTED_AT),
    ...overrides,
  });
}

function createTestServer(): BridgeServer {
  return createBridgeServer({ port: 0, authenticator: createAuthenticator() });
}

function acceptedToken(
  authenticator: LinkAuthenticator,
  role: "browser" | "simulator" = "browser",
): string {
  const result = authenticator.attemptLink(PIN, role);
  if (!("accepted" in result)) {
    throw new Error("Expected test link attempt to be accepted");
  }
  return result.accepted.authToken.value;
}

function source(role: ClientRole) {
  return { role, id: `${role}-source`, metadata: {} };
}

function linkRequest(pin = PIN, messageId = "link-1") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "linkRequest",
    messageId,
    pin,
    source: source("browser"),
    metadata: {},
  };
}

function hello(
  authToken: string,
  role: ClientRole = "browser",
  bridgeInstanceId = INSTANCE_ID,
  sessionId = SESSION_ID,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "hello",
    messageId: `hello-${role}`,
    sessionId,
    authToken,
    bridgeInstanceId,
    source: source(role),
    capabilities: role === "ide" ? ["references"] : ["inspect"],
    metadata: {},
  };
}

function unlink() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "unlink",
    messageId: "unlink-1",
    sessionId: SESSION_ID,
    metadata: {},
  };
}

function inspectMessage(
  sourceId = "browser-source",
  role: "browser" | "simulator" = "browser",
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: `inspect-${sourceId}`,
    sessionId: SESSION_ID,
    source: { ...source(role), id: sourceId },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: "#submit", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function resolutionMessage(
  inspectMessageId: string,
  sourceId = "ide-source",
  sessionId = SESSION_ID,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution" as const,
    messageId: `resolution-${inspectMessageId}`,
    sessionId,
    source: { role: "ide" as const, id: sourceId },
    inspectMessageId,
    resolutionGeneration: 1,
    status: "no-facts" as const,
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

type JsonMessage = Record<string, unknown>;

interface MessageQueue {
  readonly messages: JsonMessage[];
  dispose(): void;
}

function listenForJsonMessages(
  socket: WebSocket,
  filter: (message: JsonMessage) => boolean,
): MessageQueue {
  const messages: JsonMessage[] = [];
  const listener = (data: { toString(): string }): void => {
    const message = JSON.parse(data.toString()) as JsonMessage;
    if (filter(message)) {
      messages.push(message);
    }
  };
  socket.on("message", listener);
  return {
    messages,
    dispose() {
      socket.off("message", listener);
    },
  };
}

async function connect(url: string, origin?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  await once(socket, "open");
  return socket;
}

function autoPong(socket: WebSocket): () => void {
  const listener = (data: { toString(): string }): void => {
    const message = JSON.parse(data.toString()) as {
      type?: string;
      messageId?: string;
    };
    if (message.type !== "ping" || !message.messageId) {
      return;
    }

    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: "pong",
      messageId: `pong-${message.messageId}`,
      pingMessageId: message.messageId,
      sentAt: STARTED_AT.toISOString(),
      metadata: {},
    }));
  };
  socket.on("message", listener);
  return () => socket.off("message", listener);
}

async function sendJsonAndReceive(
  socket: WebSocket,
  message: unknown,
): Promise<Record<string, unknown>> {
  const response = nextJsonMessage(socket);
  socket.send(JSON.stringify(message));
  return response;
}

async function nextJsonMessage(
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message");
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

async function nextJsonMessageBeforeClose(
  receiver: WebSocket,
  sender: WebSocket,
): Promise<Record<string, unknown>> {
  return Promise.race([
    nextJsonMessage(receiver),
    once(sender, "close").then(() => {
      throw new Error("Authenticated sender closed before inspect was routed");
    }),
  ]);
}

async function expectSocketErrorAndClose(
  socket: WebSocket,
  message: unknown,
  expected: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextJsonMessage(socket);
  const closed = expectSocketCloses(socket);
  socket.send(JSON.stringify(message));
  const parsed = await response;
  expect(parsed).toMatchObject({
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    metadata: {},
    ...expected,
  });
  await closed;
  return parsed;
}

async function expectSocketCloses(socket: WebSocket): Promise<void> {
  const outcome = await Promise.race([
    once(socket, "close").then(() => "closed" as const),
    delay(500).then(() => "timed-out" as const),
  ]);
  expect(outcome).toBe("closed");
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

function readString(message: Record<string, unknown>, key: string): string {
  const value = message[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function expectLinkErrorNotToExposePin(
  message: Record<string, unknown>,
  pin: string,
): void {
  expect(message.message).not.toContain(pin);
  expect(JSON.stringify(message.details)).not.toContain(pin);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect(url: string): Promise<boolean> {
  let socket: WebSocket | undefined;

  try {
    socket = await connect(url);
    return true;
  } catch {
    return false;
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await closeSocket(socket);
    }
  }
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
      await delay(10);
    }
  }

  throw lastError;
}
