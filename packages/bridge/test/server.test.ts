import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  INSPECT_ENVELOPE_MAX_BYTES,
  PROTOCOL_VERSION,
  type ClientRole,
} from "@pinop/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as bridgeExports from "../src/index.js";
import { ClientRegistry, type ClientRegistration } from "../src/clientRegistry.js";
import { LinkAuthenticator } from "../src/linkAuthenticator.js";
import { PeerStateRegistry } from "../src/peerStateRegistry.js";
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
      const accepted = await sendJsonAndExpectType(
        socket,
        linkRequest(),
        "linkAccepted",
      );

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
        sendJsonAndExpectType(socket, hello(authToken), "authenticated"),
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
        sendJsonAndExpectType(
          survivingSocket,
          hello(survivingToken),
          "authenticated",
        ),
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
        sendJsonAndExpectType(
          socket,
          linkRequest(PIN, "link-first"),
          "linkAccepted",
        ),
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
        sendJsonAndExpectType(socket, hello(authToken), "authenticated"),
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
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      const browser = await connect(server.getUrl());
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
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

      const routed = listenForJsonMessages(
        ide,
        (message) => message.type === "inspect",
      );
      const closed = once(browser, "close");
      browser.send(JSON.stringify(unlink()));
      browser.send(JSON.stringify(inspectMessage()));
      await closed;
      await ideErrorBarrier(ide, "unlink-queued-barrier");

      expect(routed.messages).toEqual([]);
      expect(counts).toEqual([{ browser: 0, ide: 1 }]);
      expect(tokenStateAtCount).toEqual(["rejected"]);
      routed.dispose();
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
      const accepted = await sendJsonAndExpectType(
        linkSocket,
        linkRequest(),
        "linkAccepted",
      );
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
      const accepted = await sendJsonAndExpectType(
        linkSocket,
        linkRequest(),
        "linkAccepted",
      );
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
        sendJsonAndExpectType(
          socket,
          hello(token.value, "ide"),
          "authenticated",
        ),
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
      const accepted = await sendJsonAndExpectType(
        socket,
        linkRequest(server.getLinkInfo().pin),
        "linkAccepted",
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

describe("bridge server peer state", () => {
  it("sends authenticated before a disconnected generation-zero snapshot", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const browser = await connect(server.getUrl());
    const messages = listenForJsonMessages(browser, () => true);

    try {
      await expect(
        sendJsonAndExpectType(browser, hello(browserToken), "authenticated"),
      ).resolves.toMatchObject({ type: "authenticated" });

      await eventually(() =>
        expect(messages.messages).toEqual([
          expect.objectContaining({ type: "authenticated" }),
          expect.objectContaining({
            protocolVersion: PROTOCOL_VERSION,
            type: "peerState",
            sessionId: SESSION_ID,
            role: "ide",
            connected: false,
            peerGeneration: 0,
            metadata: {},
          }),
        ]),
      );
    } finally {
      messages.dispose();
      await closeSocket(browser);
      await server.stop();
    }
  });

  it("sends a newly authenticated browser the current connected generation", async () => {
    const authenticator = createAuthenticator();
    const ideToken = authenticator.issueTrustedToken("ide");
    const browserToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const ide = await connect(server.getUrl());
    const browser = await connect(server.getUrl());
    const messages = listenForJsonMessages(browser, () => true);

    try {
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      await expect(
        sendJsonAndExpectType(browser, hello(browserToken), "authenticated"),
      ).resolves.toMatchObject({ type: "authenticated" });

      await eventually(() =>
        expect(messages.messages).toEqual([
          expect.objectContaining({ type: "authenticated" }),
          expect.objectContaining({
            type: "peerState",
            sessionId: SESSION_ID,
            connected: true,
            peerGeneration: 1,
            metadata: {},
          }),
        ]),
      );
    } finally {
      messages.dispose();
      await Promise.all([closeSocket(browser), closeSocket(ide)]);
      await server.stop();
    }
  });

  it("reconciles a populated injected registry before sending a browser snapshot", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const registry = new ClientRegistry();
    const existingBrowser = inMemoryClient("browser", SESSION_ID);
    const existingSimulator = inMemoryClient("simulator", SESSION_ID);
    const existingIde = inMemoryClient("ide", SESSION_ID);
    registry.add(existingBrowser.registration);
    registry.add(existingSimulator.registration);
    registry.add(existingIde.registration);
    const server = createBridgeServer({ port: 0, authenticator, registry });
    await server.start();
    const browser = await connect(server.getUrl());
    const orderedMessages = listenForJsonMessages(
      browser,
      (message) =>
        message.type === "authenticated" || message.type === "peerState",
    );

    try {
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      await expectSocketErrorAndClose(browser, hello(browserToken), {
        code: "protocol.invalidMessage",
        message: "Client is already authenticated",
      });

      expect(orderedMessages.messages).toEqual([
        expect.objectContaining({ type: "authenticated" }),
        expect.objectContaining({
          type: "peerState",
          sessionId: SESSION_ID,
          connected: true,
          peerGeneration: 1,
        }),
      ]);
      expect(
        existingBrowser.sent.filter((message) => message.type === "peerState"),
      ).toEqual([
        expect.objectContaining({ connected: true, peerGeneration: 1 }),
      ]);
      expect(
        existingSimulator.sent.filter((message) => message.type === "peerState"),
      ).toEqual([
        expect.objectContaining({ connected: true, peerGeneration: 1 }),
      ]);
      expect(
        existingIde.sent.filter((message) => message.type === "peerState"),
      ).toEqual([]);
    } finally {
      orderedMessages.dispose();
      await server.stop();
    }
  });

  it("reconciles a connected injected tracker when the registry has no IDE", async () => {
    const authenticator = createAuthenticator();
    const simulatorToken = acceptedToken(authenticator, "simulator");
    const registry = new ClientRegistry();
    const peerStateRegistry = new PeerStateRegistry();
    const existingBrowser = inMemoryClient("browser", SESSION_ID);
    const existingSimulator = inMemoryClient("simulator", SESSION_ID);
    registry.add(existingBrowser.registration);
    registry.add(existingSimulator.registration);
    peerStateRegistry.updateIdeCount(SESSION_ID, 1);
    const server = createBridgeServer({
      port: 0,
      authenticator,
      registry,
      peerStateRegistry,
    });
    await server.start();
    const simulator = await connect(server.getUrl());
    const orderedMessages = listenForJsonMessages(
      simulator,
      (message) =>
        message.type === "authenticated" || message.type === "peerState",
    );

    try {
      await sendJsonAndExpectType(
        simulator,
        hello(simulatorToken, "simulator"),
        "authenticated",
      );
      await expectSocketErrorAndClose(
        simulator,
        hello(simulatorToken, "simulator"),
        {
          code: "protocol.invalidMessage",
          message: "Client is already authenticated",
        },
      );

      expect(orderedMessages.messages).toEqual([
        expect.objectContaining({ type: "authenticated" }),
        expect.objectContaining({
          type: "peerState",
          sessionId: SESSION_ID,
          connected: false,
          peerGeneration: 2,
        }),
      ]);
      expect(
        existingBrowser.sent.filter((message) => message.type === "peerState"),
      ).toEqual([
        expect.objectContaining({ connected: false, peerGeneration: 2 }),
      ]);
      expect(
        existingSimulator.sent.filter((message) => message.type === "peerState"),
      ).toEqual([
        expect.objectContaining({ connected: false, peerGeneration: 2 }),
      ]);
    } finally {
      orderedMessages.dispose();
      await server.stop();
    }
  });

  it("sends simulator authenticated before exactly one same-session snapshot", async () => {
    const authenticator = createAuthenticator();
    const simulatorToken = acceptedToken(authenticator, "simulator");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const simulator = await connect(server.getUrl());
    const messages = listenForJsonMessages(simulator, () => true);

    try {
      await expect(
        sendJsonAndExpectType(
          simulator,
          hello(simulatorToken, "simulator"),
          "authenticated",
        ),
      ).resolves.toMatchObject({ type: "authenticated" });

      await eventually(() =>
        expect(messages.messages).toEqual([
          expect.objectContaining({ type: "authenticated" }),
          expect.objectContaining({
            protocolVersion: PROTOCOL_VERSION,
            type: "peerState",
            sessionId: SESSION_ID,
            role: "ide",
            connected: false,
            peerGeneration: 0,
            metadata: {},
          }),
        ]),
      );
    } finally {
      messages.dispose();
      await closeSocket(simulator);
      await server.stop();
    }
  });

  it("publishes only boundary transitions across two IDE connections", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const laterBrowserToken = acceptedToken(authenticator);
    const firstIdeToken = authenticator.issueTrustedToken("ide");
    const secondIdeToken = authenticator.issueTrustedToken("ide");
    const reconnectIdeToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const browser = await connect(server.getUrl());
    const peerStates = listenForJsonMessages(
      browser,
      (message) => message.type === "peerState",
    );
    let laterBrowserStates: MessageQueue | undefined;

    try {
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: false, peerGeneration: 0 }),
        ),
      );

      const firstIde = await connect(server.getUrl());
      await sendJsonAndExpectType(
        firstIde,
        hello(firstIdeToken.value, "ide"),
        "authenticated",
      );
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: true, peerGeneration: 1 }),
        ),
      );

      const secondIde = await connect(server.getUrl());
      const secondIdeCount = clientCountBarrier(server, { browser: 1, ide: 2 });
      await sendJsonAndExpectType(
        secondIde,
        hello(secondIdeToken.value, "ide"),
        "authenticated",
      );
      await secondIdeCount.promise;
      secondIdeCount.dispose();
      await recipientResolutionBarrier(
        browser,
        secondIde,
        "second-ide-auth-barrier",
        "browser",
      );
      expect(peerStates.messages).toHaveLength(2);

      const firstIdeRemoval = clientCountBarrier(server, { browser: 1, ide: 1 });
      await closeSocket(firstIde);
      await firstIdeRemoval.promise;
      firstIdeRemoval.dispose();
      await recipientResolutionBarrier(
        browser,
        secondIde,
        "first-ide-close-barrier",
        "browser",
      );
      expect(peerStates.messages).toHaveLength(2);

      const lastIdeRemoval = clientCountBarrier(server, { browser: 1, ide: 0 });
      await closeSocket(secondIde);
      await lastIdeRemoval.promise;
      lastIdeRemoval.dispose();
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: false, peerGeneration: 2 }),
        ),
      );

      const laterBrowser = await connect(server.getUrl());
      const nextBrowserStates = listenForJsonMessages(
        laterBrowser,
        (message) => message.type === "peerState",
      );
      laterBrowserStates = nextBrowserStates;
      await sendJsonAndExpectType(
        laterBrowser,
        hello(laterBrowserToken),
        "authenticated",
      );
      await eventually(() =>
        expect(nextBrowserStates.messages).toEqual([
          expect.objectContaining({ connected: false, peerGeneration: 2 }),
        ]),
      );

      const reconnectIde = await connect(server.getUrl());
      const reconnectIdeCount = clientCountBarrier(server, { browser: 2, ide: 1 });
      await sendJsonAndExpectType(
        reconnectIde,
        hello(reconnectIdeToken.value, "ide"),
        "authenticated",
      );
      await reconnectIdeCount.promise;
      reconnectIdeCount.dispose();
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: true, peerGeneration: 3 }),
        ),
      );

      await Promise.all([closeSocket(browser), closeSocket(laterBrowser), closeSocket(reconnectIde)]);
    } finally {
      laterBrowserStates?.dispose();
      peerStates.dispose();
      await server.stop();
    }
  });

  it("targets transitions by session and role", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const simulatorToken = acceptedToken(authenticator, "simulator");
    const firstIdeToken = authenticator.issueTrustedToken("ide");
    const secondIdeToken = authenticator.issueTrustedToken("ide");
    const registry = new ClientRegistry();
    const otherBrowser = inMemoryClient("browser", "other-session");
    const otherSimulator = inMemoryClient("simulator", "other-session");
    registry.add(otherBrowser.registration);
    registry.add(otherSimulator.registration);
    const server = createBridgeServer({ port: 0, authenticator, registry });
    await server.start();
    const browser = await connect(server.getUrl());
    const simulator = await connect(server.getUrl());
    const firstIde = await connect(server.getUrl());
    const secondIde = await connect(server.getUrl());
    const browserStates = listenForJsonMessages(
      browser,
      (message) => message.type === "peerState",
    );
    const simulatorStates = listenForJsonMessages(
      simulator,
      (message) => message.type === "peerState",
    );
    const firstIdeMessages = listenForJsonMessages(firstIde, () => true);
    const secondIdeMessages = listenForJsonMessages(secondIde, () => true);

    try {
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      await sendJsonAndExpectType(
        simulator,
        hello(simulatorToken, "simulator"),
        "authenticated",
      );
      await sendJsonAndExpectType(
        firstIde,
        hello(firstIdeToken.value, "ide"),
        "authenticated",
      );
      const secondIdeCount = clientCountBarrier(server, { browser: 2, ide: 2 });
      await sendJsonAndExpectType(
        secondIde,
        hello(secondIdeToken.value, "ide"),
        "authenticated",
      );
      await secondIdeCount.promise;
      secondIdeCount.dispose();
      await recipientResolutionBarrier(
        browser,
        firstIde,
        "target-browser-barrier",
        "browser",
      );
      await recipientResolutionBarrier(
        simulator,
        firstIde,
        "target-simulator-barrier",
        "simulator",
      );
      await ideErrorBarrier(firstIde, "target-first-ide-barrier");
      await ideErrorBarrier(secondIde, "target-second-ide-barrier");

      await eventually(() => {
        expect(browserStates.messages).toEqual([
          expect.objectContaining({ connected: false, peerGeneration: 0 }),
          expect.objectContaining({ connected: true, peerGeneration: 1 }),
        ]);
        expect(simulatorStates.messages).toEqual([
          expect.objectContaining({ connected: false, peerGeneration: 0 }),
          expect.objectContaining({ connected: true, peerGeneration: 1 }),
        ]);
      });
      expect(otherBrowser.sent).toEqual([]);
      expect(otherSimulator.sent).toEqual([]);
      expect(
        firstIdeMessages.messages.filter((message) => message.type === "peerState"),
      ).toEqual([]);
      expect(
        secondIdeMessages.messages.filter((message) => message.type === "peerState"),
      ).toEqual([]);
    } finally {
      browserStates.dispose();
      simulatorStates.dispose();
      firstIdeMessages.dispose();
      secondIdeMessages.dispose();
      await Promise.all([
        closeSocket(browser),
        closeSocket(simulator),
        closeSocket(firstIde),
        closeSocket(secondIde),
      ]);
      await server.stop();
    }
  });

  it("publishes unlink transitions for the last IDE and advances reconnect generation", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const firstIdeToken = authenticator.issueTrustedToken("ide");
    const secondIdeToken = authenticator.issueTrustedToken("ide");
    const reconnectIdeToken = authenticator.issueTrustedToken("ide");
    const peerStateRegistry = new PeerStateRegistry();
    const server = createBridgeServer({
      port: 0,
      authenticator,
      peerStateRegistry,
    });
    await server.start();
    const browser = await connect(server.getUrl());
    const peerStates = listenForJsonMessages(
      browser,
      (message) => message.type === "peerState",
    );

    try {
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      const firstIde = await connect(server.getUrl());
      const firstIdeCount = clientCountBarrier(server, { browser: 1, ide: 1 });
      await sendJsonAndExpectType(
        firstIde,
        hello(firstIdeToken.value, "ide"),
        "authenticated",
      );
      await firstIdeCount.promise;
      firstIdeCount.dispose();
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: true, peerGeneration: 1 }),
        ),
      );

      const secondIde = await connect(server.getUrl());
      const secondIdeCount = clientCountBarrier(server, { browser: 1, ide: 2 });
      await sendJsonAndExpectType(
        secondIde,
        hello(secondIdeToken.value, "ide"),
        "authenticated",
      );
      await secondIdeCount.promise;
      secondIdeCount.dispose();
      expect(peerStates.messages).toHaveLength(2);

      const firstUnlinkCount = clientCountBarrier(server, { browser: 1, ide: 1 });
      const firstUnlinkClosed = expectSocketCloses(firstIde);
      firstIde.send(JSON.stringify(unlink("first-ide-unlink")));
      await Promise.all([firstUnlinkCount.promise, firstUnlinkClosed]);
      firstUnlinkCount.dispose();
      await recipientResolutionBarrier(
        browser,
        secondIde,
        "first-ide-unlink-barrier",
        "browser",
      );
      expect(peerStates.messages).toHaveLength(2);
      expect(peerStateRegistry.get(SESSION_ID)).toEqual({
        connected: true,
        peerGeneration: 1,
      });

      const lastUnlinkCount = clientCountBarrier(server, { browser: 1, ide: 0 });
      const lastUnlinkClosed = expectSocketCloses(secondIde);
      secondIde.send(JSON.stringify(unlink("last-ide-unlink")));
      await Promise.all([lastUnlinkCount.promise, lastUnlinkClosed]);
      lastUnlinkCount.dispose();
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: false, peerGeneration: 2 }),
        ),
      );
      expect(peerStateRegistry.get(SESSION_ID)).toEqual({
        connected: false,
        peerGeneration: 2,
      });

      const reconnectIde = await connect(server.getUrl());
      const reconnectIdeCount = clientCountBarrier(server, { browser: 1, ide: 1 });
      await sendJsonAndExpectType(
        reconnectIde,
        hello(reconnectIdeToken.value, "ide"),
        "authenticated",
      );
      await reconnectIdeCount.promise;
      reconnectIdeCount.dispose();
      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: true, peerGeneration: 3 }),
        ),
      );
      expect(peerStateRegistry.get(SESSION_ID)).toEqual({
        connected: true,
        peerGeneration: 3,
      });
      await Promise.all([closeSocket(browser), closeSocket(reconnectIde)]);
    } finally {
      peerStates.dispose();
      await server.stop();
    }
  });

  it("publishes a false transition when heartbeat evicts the last IDE", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({
      port: 0,
      authenticator,
      heartbeatIntervalMs: 10,
    });
    await server.start();
    const browser = await connect(server.getUrl());
    const ide = await connect(server.getUrl());
    const peerStates = listenForJsonMessages(
      browser,
      (message) => message.type === "peerState",
    );
    const stopBrowserPong = autoPong(browser);

    try {
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      const ideClosed = expectSocketCloses(ide);

      await eventually(() =>
        expect(peerStates.messages).toContainEqual(
          expect.objectContaining({ connected: false, peerGeneration: 2 }),
        ),
      );
      await ideClosed;
      expect(server.registry.countBySessionAndRole(SESSION_ID, "ide")).toBe(0);
    } finally {
      stopBrowserPong();
      peerStates.dispose();
      await closeSocket(browser);
      await server.stop();
    }
  });

  it("continues publishing to surviving browsers after one send fails", async () => {
    const authenticator = createAuthenticator();
    const browserAToken = acceptedToken(authenticator);
    const browserBToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();
    const browserA = await connect(server.getUrl());
    const browserB = await connect(server.getUrl());
    const browserBPeerStates = listenForJsonMessages(
      browserB,
      (message) => message.type === "peerState",
    );

    try {
      await sendJsonAndExpectType(browserA, hello(browserAToken), "authenticated");
      await sendJsonAndExpectType(browserB, hello(browserBToken), "authenticated");
      const failingBrowser = server.registry
        .findBySessionAndRole(SESSION_ID, "browser")
        .at(0);
      if (!failingBrowser) {
        throw new Error("Expected an authenticated browser");
      }
      failingBrowser.connection.send = () => {
        throw new Error("peer state send failed");
      };

      const ide = await connect(server.getUrl());
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      await eventually(() =>
        expect(browserBPeerStates.messages).toContainEqual(
          expect.objectContaining({ connected: true, peerGeneration: 1 }),
        ),
      );
      await Promise.all([closeSocket(browserA), closeSocket(browserB), closeSocket(ide)]);
    } finally {
      browserBPeerStates.dispose();
      await server.stop();
    }
  });

  it.each(["browser", "simulator", "ide"] as const)(
    "rejects an inbound peerState from %s and closes the socket",
    async (role) => {
      const authenticator = createAuthenticator();
      const token =
        role === "ide"
          ? authenticator.issueTrustedToken("ide").value
          : acceptedToken(authenticator, role);
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();
      const socket = await connect(server.getUrl());
      const errors = listenForJsonMessages(
        socket,
        (message) => message.type === "error",
      );

      try {
        await sendJsonAndExpectType(
          socket,
          hello(token, role),
          "authenticated",
        );
        const closed = expectSocketCloses(socket);
        socket.send(JSON.stringify(peerStateMessage()));
        await eventually(() =>
          expect(errors.messages).toContainEqual(
            expect.objectContaining({
              type: "error",
              code: "protocol.invalidMessage",
            }),
          ),
        );
        await closed;
      } finally {
        errors.dispose();
        await server.stop();
      }
    },
  );

  it("clears an injected peer state registry on stop", async () => {
    const peerStateRegistry = new PeerStateRegistry();
    peerStateRegistry.updateIdeCount(SESSION_ID, 1);
    const server = createBridgeServer({
      port: 0,
      peerStateRegistry,
    });

    await server.start();
    await server.stop();

    expect(peerStateRegistry.get(SESSION_ID)).toEqual({
      connected: false,
      peerGeneration: 0,
    });
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
        sendJsonAndExpectType(socket, hello(authToken), "authenticated"),
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
      await expect(sendJsonAndExpectType(first, hello(authToken), "authenticated")).resolves.toMatchObject({
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
        sendJsonAndExpectType(second, hello(authToken), "authenticated"),
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
    await expect(sendJsonAndExpectType(socket, hello(authToken), "authenticated")).resolves.toMatchObject({
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
    await expect(sendJsonAndExpectType(socket, hello(authToken), "authenticated")).resolves.toMatchObject({
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
      const queues: MessageQueue[] = [];

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndExpectType(
          ide,
          hello(ideToken.value, "ide"),
          "authenticated",
        );
        const browser = await connect(server.getUrl());
        await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
        const idePeerStates = listenForJsonMessages(
          ide,
          (message) => message.type === "peerState",
        );
        const browserErrors = listenForJsonMessages(
          browser,
          (message) => message.type === "error",
        );
        queues.push(idePeerStates, browserErrors);
        const closed = once(browser, "close");
        const browserError = nextJsonMessageOfType(browser, "error");

        browser.send(JSON.stringify(createMessage()));

        await expect(browserError).resolves.toMatchObject({
          type: "error",
          code: "protocol.invalidMessage",
          message: "Message does not match protocol",
          details: { fatal: true },
        });
        await closed;
        await ideErrorBarrier(ide, "post-auth-replay-ide-barrier");
        expect(browserErrors.messages).toEqual([
          expect.objectContaining({
            type: "error",
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
            details: { fatal: true },
          }),
        ]);
        expect(idePeerStates.messages).toEqual([]);
        expect(server.registry.countByRole("browser")).toBe(0);
        await closeSocket(ide);
      } finally {
        for (const queue of queues) {
          queue.dispose();
        }
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
        await sendJsonAndExpectType(
          ide,
          hello(ideToken.value, "ide"),
          "authenticated",
        );
        const sender = await connect(server.getUrl());
        await sendJsonAndExpectType(
          sender,
          hello(senderToken, role),
          "authenticated",
        );

        const firstRouted = nextJsonMessageBeforeClose(ide, sender, "inspect");
        sender.send(JSON.stringify(inspectMessage("panel-101", role)));
        await expect(firstRouted).resolves.toMatchObject({
          type: "inspect",
          sessionId: SESSION_ID,
          source: { role, id: "panel-101" },
        });

        const secondRouted = nextJsonMessageBeforeClose(ide, sender, "inspect");
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
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      const browserA = await connect(server.getUrl());
      await sendJsonAndExpectType(browserA, hello(browserAToken), "authenticated");
      const browserB = await connect(server.getUrl());
      await sendJsonAndExpectType(browserB, hello(browserBToken), "authenticated");
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
      queues.push(
        ideInspects,
        browserAResolutions,
        browserBResolutions,
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
      ide.send(JSON.stringify(resolutionMessage("inspect-browser-b")));
      await eventually(() =>
        expect(browserAResolutions.messages).toContainEqual(
          expect.objectContaining({
            type: "resolution",
            inspectMessageId: "inspect-browser-a",
          }),
        ),
      );
      await eventually(() =>
        expect(browserBResolutions.messages).toContainEqual(
          expect.objectContaining({
            type: "resolution",
            inspectMessageId: "inspect-browser-b",
          }),
        ),
      );
      expect(browserAResolutions.messages).toHaveLength(1);
      expect(browserBResolutions.messages).toHaveLength(1);

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
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      const browser = await connect(server.getUrl());
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");

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

  it.each(["browser", "simulator"] as const)(
    "accepts source.navigate from an authenticated capable %s in the same session",
    async (role) => {
      const authenticator = createAuthenticator();
      const senderToken = acceptedToken(authenticator, role);
      const ideToken = authenticator.issueTrustedToken("ide");
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndExpectType(
          ide,
          helloWithSourceNavigation(ideToken.value, "ide"),
          "authenticated",
        );
        const sender = await connect(server.getUrl());
        await sendJsonAndExpectType(
          sender,
          helloWithSourceNavigation(senderToken, role),
          "authenticated",
        );
        const routedInspect = nextJsonMessageOfType(ide, "inspect");
        sender.send(JSON.stringify(inspectMessage("navigation-origin", role)));
        await expect(routedInspect).resolves.toMatchObject({
          type: "inspect",
          messageId: "inspect-navigation-origin",
        });

        const navigate = sourceNavigateMessage({
          inspectMessageId: "inspect-navigation-origin",
        });
        const routedNavigate = nextJsonMessageOfType(ide, "source.navigate");
        sender.send(JSON.stringify(navigate));

        await expect(routedNavigate).resolves.toEqual(navigate);
        expect(sender.readyState).toBe(WebSocket.OPEN);
        await Promise.all([closeSocket(sender), closeSocket(ide)]);
      } finally {
        await server.stop();
      }
    },
  );

  it("accepts source.navigationState from the exact authenticated capable IDE", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndExpectType(
        ide,
        helloWithSourceNavigation(ideToken.value, "ide"),
        "authenticated",
      );
      const browser = await connect(server.getUrl());
      await sendJsonAndExpectType(
        browser,
        helloWithSourceNavigation(browserToken, "browser"),
        "authenticated",
      );
      const routedInspect = nextJsonMessageOfType(ide, "inspect");
      browser.send(JSON.stringify(inspectMessage("navigation-state-origin")));
      await expect(routedInspect).resolves.toMatchObject({
        type: "inspect",
        messageId: "inspect-navigation-state-origin",
      });

      const navigationState = sourceNavigationStateMessage({
        inspectMessageId: "inspect-navigation-state-origin",
        selectedMatchCount: 4,
        activeMatchIndex: 3,
      });
      const routedState = nextJsonMessageOfType(
        browser,
        "source.navigationState",
      );
      ide.send(JSON.stringify(navigationState));

      await expect(routedState).resolves.toEqual(navigationState);
      expect(browser.readyState).toBe(WebSocket.OPEN);
      await Promise.all([closeSocket(browser), closeSocket(ide)]);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["an authenticated IDE", "ide" as const, true, {}],
    [
      "a different session",
      "browser" as const,
      true,
      { sessionId: "other-session" },
    ],
    ["a client without source-navigation", "browser" as const, false, {}],
  ])(
    "rejects source.navigate from %s with a bounded protocol error",
    async (_name, role, advertiseCapability, overrides) => {
      const authenticator = createAuthenticator();
      const authToken =
        role === "ide"
          ? authenticator.issueTrustedToken("ide").value
          : acceptedToken(authenticator, role);
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const sender = await connect(server.getUrl());
        await sendJsonAndExpectType(
          sender,
          advertiseCapability
            ? helloWithSourceNavigation(authToken, role)
            : hello(authToken, role),
          "authenticated",
        );

        const error = await expectSocketErrorAndClose(
          sender,
          sourceNavigateMessage(overrides),
          {
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
            details: { fatal: true },
          },
        );
        expect(JSON.stringify(error)).not.toContain(authToken);
      } finally {
        await server.stop();
      }
    },
  );

  it.each([
    ["an authenticated browser", "browser" as const, true, {}],
    ["an authenticated simulator", "simulator" as const, true, {}],
    [
      "a different session",
      "ide" as const,
      true,
      { sessionId: "other-session" },
    ],
    [
      "a spoofed IDE source id",
      "ide" as const,
      true,
      { source: { role: "ide" as const, id: "spoofed-ide" } },
    ],
    ["a client without source-navigation", "ide" as const, false, {}],
  ])(
    "rejects source.navigationState from %s with a bounded protocol error",
    async (_name, role, advertiseCapability, overrides) => {
      const authenticator = createAuthenticator();
      const authToken =
        role === "ide"
          ? authenticator.issueTrustedToken("ide").value
          : acceptedToken(authenticator, role);
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const sender = await connect(server.getUrl());
        await sendJsonAndExpectType(
          sender,
          advertiseCapability
            ? helloWithSourceNavigation(authToken, role)
            : hello(authToken, role),
          "authenticated",
        );

        const error = await expectSocketErrorAndClose(
          sender,
          sourceNavigationStateMessage(overrides),
          {
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
            details: { fatal: true },
          },
        );
        expect(JSON.stringify(error)).not.toContain(authToken);
      } finally {
        await server.stop();
      }
    },
  );

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
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
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
      await sendJsonAndExpectType(
        browserAfterClose,
        hello(browserToken),
        "authenticated",
      );
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
      await sendJsonAndExpectType(
        browserAfterUnlink,
        hello(unlinkBrowserToken),
        "authenticated",
      );
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
      await sendJsonAndExpectType(
        browserAfterEviction,
        hello(evictionBrowserToken),
        "authenticated",
      );
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
      await sendJsonAndExpectType(
        browserBeforeStop,
        hello(stopBrowserToken),
        "authenticated",
      );
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
        await sendJsonAndExpectType(
          ide,
          hello(ideToken.value, "ide"),
          "authenticated",
        );
        const browser = await connect(server.getUrl());
        await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
        const routed = listenForJsonMessages(
          ide,
          (message) => message.type === "inspect",
        );

        const error = await expectSocketErrorAndClose(
          browser,
          spoof(inspectMessage()),
          {
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
          },
        );
        await ideErrorBarrier(ide, "mismatched-inspect-barrier");

        expect(routed.messages).toEqual([]);
        expect(JSON.stringify(error)).not.toContain(browserToken);
        routed.dispose();
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
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");

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
      await sendJsonAndExpectType(
        ide,
        hello(ideToken.value, "ide"),
        "authenticated",
      );
      const browser = await connect(server.getUrl());
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      const routed = nextJsonMessageOfType(ide, "inspect");

      browser.send(JSON.stringify(inspectMessage()));

      await expect(routed).resolves.toMatchObject({
        type: "inspect",
        sessionId: SESSION_ID,
        source: source("browser"),
      });

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

  it.each([
    [
      "references",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "references",
        messageId: "legacy-references",
        subject: { selector: "#submit", metadata: {} },
        references: [
          {
            kind: "component",
            relation: "renders",
            label: "Submit",
            source: {
              uri: "file:///C:/private/workspace/src/App.tsx",
              line: 12,
              column: 3,
              metadata: {},
            },
            confidence: "exact",
            status: "active",
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    [
      "openSource command",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "legacy-open-source",
        command: "openSource",
        arguments: {
          source: {
            uri: "file:///C:/private/workspace/src/App.tsx",
            line: 12,
            column: 3,
            metadata: {},
          },
          metadata: {},
        },
        metadata: {},
      },
    ],
    [
      "highlightElement command",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "legacy-highlight-element",
        command: "highlightElement",
        arguments: { selector: "#submit", metadata: {} },
        metadata: {},
      },
    ],
  ])("rejects and does not route the legacy %s envelope", async (_name, message) => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    let ideErrors: MessageQueue | undefined;
    let browserLegacyMessages: MessageQueue | undefined;
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndExpectType(
        ide,
        { ...hello(ideToken.value, "ide"), capabilities: [] },
        "authenticated",
      );
      const browser = await connect(server.getUrl());
      await sendJsonAndExpectType(browser, hello(browserToken), "authenticated");
      ideErrors = listenForJsonMessages(ide, (candidate) => candidate.type === "error");
      browserLegacyMessages = listenForJsonMessages(
        browser,
        (candidate) => candidate.type === "references" || candidate.type === "command",
      );

      const closed = expectSocketCloses(ide);
      ide.send(JSON.stringify(message));
      await closed;

      expect(ideErrors.messages).toEqual([
        expect.objectContaining({
          type: "error",
          code: "protocol.invalidMessage",
          message: "Message does not match protocol",
        }),
      ]);
      expect(browserLegacyMessages.messages).toEqual([]);
      await closeSocket(browser);
    } finally {
      ideErrors?.dispose();
      browserLegacyMessages?.dispose();
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
      await sendJsonAndExpectType(socket, hello(authToken), "authenticated");
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
      const acceptedAtLimit = nextJsonMessageOfType(atLimit, "error");
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
        "moz-extension://pinop-test",
      );
      const chromium = await connect(
        server.getUrl(),
        "chrome-extension://pinop-test",
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
    capabilities: role === "ide" ? ["resolution"] : ["inspect"],
    metadata: {},
  };
}

function helloWithSourceNavigation(
  authToken: string,
  role: ClientRole,
) {
  return {
    ...hello(authToken, role),
    capabilities:
      role === "ide"
        ? ["resolution", "source-navigation"]
        : ["inspect", "source-navigation"],
  };
}

function unlink(messageId = "unlink-1") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "unlink",
    messageId,
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

function peerStateMessage() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: "inbound-peer-state",
    sessionId: SESSION_ID,
    role: "ide",
    connected: true,
    peerGeneration: 1,
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

function sourceNavigateMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigate",
    messageId: "source-navigate-1",
    sessionId: SESSION_ID,
    inspectMessageId: "inspect-navigation-origin",
    resolutionGeneration: 2,
    direction: "next",
    metadata: {},
    ...overrides,
  };
}

function sourceNavigationStateMessage(
  overrides: Record<string, unknown> = {},
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: "source-navigation-state-1",
    sessionId: SESSION_ID,
    inspectMessageId: "inspect-navigation-state-origin",
    source: { role: "ide", id: "ide-source" },
    resolutionGeneration: 2,
    selectedMatchCount: 3,
    activeMatchIndex: 1,
    metadata: {},
    ...overrides,
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

function inMemoryClient(
  role: ClientRole,
  sessionId: string,
): { readonly registration: ClientRegistration; readonly sent: JsonMessage[] } {
  const sent: JsonMessage[] = [];
  return {
    sent,
    registration: {
      connection: {
        send(payload) {
          sent.push(JSON.parse(payload) as JsonMessage);
          return true;
        },
        terminate() {},
      },
      source: { role, id: `${role}-${sessionId}`, metadata: {} },
      sessionId,
      authToken: `${role}-${sessionId}-token`,
      capabilities: [],
    },
  };
}

function clientCountBarrier(
  server: BridgeServer,
  expected: { readonly browser: number; readonly ide: number },
): { readonly promise: Promise<void>; dispose(): void } {
  let subscription: { dispose(): void } | undefined;
  const promise = new Promise<void>((resolve) => {
    subscription = server.onClientCountChanged((counts) => {
      if (counts.browser !== expected.browser || counts.ide !== expected.ide) {
        return;
      }

      subscription?.dispose();
      resolve();
    });
  });

  return {
    promise,
    dispose() {
      subscription?.dispose();
    },
  };
}

async function recipientResolutionBarrier(
  sender: WebSocket,
  ide: WebSocket,
  markerId: string,
  role: "browser" | "simulator",
): Promise<void> {
  const inspectId = `inspect-${markerId}`;
  const routedInspect = nextJsonMessageOfType(ide, "inspect");
  const routedResolution = nextJsonMessageOfType(sender, "resolution");
  sender.send(JSON.stringify(inspectMessage(markerId, role)));
  await routedInspect;
  ide.send(JSON.stringify(resolutionMessage(inspectId)));
  await routedResolution;
}

async function ideErrorBarrier(ide: WebSocket, markerId: string): Promise<void> {
  const response = nextJsonMessageOfType(ide, "error");
  ide.send(JSON.stringify(resolutionMessage(`unrouted-${markerId}`)));
  await expect(response).resolves.toMatchObject({
    type: "error",
    code: "bridge.noBrowserClient",
  });
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

interface JsonMessageBuffer {
  next(filter: (message: JsonMessage) => boolean): Promise<JsonMessage>;
  dispose(): void;
}

interface JsonMessageWaiter {
  readonly filter: (message: JsonMessage) => boolean;
  readonly resolve: (message: JsonMessage) => void;
  readonly reject: (error: Error) => void;
}

const jsonMessageBuffers = new WeakMap<WebSocket, JsonMessageBuffer>();

function getJsonMessageBuffer(socket: WebSocket): JsonMessageBuffer {
  const existing = jsonMessageBuffers.get(socket);
  if (existing) {
    return existing;
  }

  const messages: JsonMessage[] = [];
  const waiters: JsonMessageWaiter[] = [];
  let disposed = false;

  const cleanup = (): void => {
    socket.off("message", onMessage);
    socket.off("close", onClose);
    jsonMessageBuffers.delete(socket);
  };

  const rejectWaiters = (error: Error): void => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  };

  const onMessage = (data: { toString(): string }): void => {
    let message: JsonMessage;
    try {
      message = JSON.parse(data.toString()) as JsonMessage;
    } catch {
      return;
    }

    const waiterIndex = waiters.findIndex((waiter) => waiter.filter(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
      return;
    }

    messages.push(message);
  };

  const onClose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    cleanup();
    rejectWaiters(new Error("Socket closed before receiving the expected message"));
  };

  const buffer: JsonMessageBuffer = {
    next(filter) {
      if (disposed) {
        return Promise.reject(
          new Error("Socket closed before receiving the expected message"),
        );
      }

      const messageIndex = messages.findIndex(filter);
      if (messageIndex >= 0) {
        const [message] = messages.splice(messageIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise<JsonMessage>((resolve, reject) => {
        waiters.push({ filter, resolve, reject });
      });
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      cleanup();
      rejectWaiters(new Error("Message buffer disposed"));
    },
  };

  socket.on("message", onMessage);
  socket.once("close", onClose);
  jsonMessageBuffers.set(socket, buffer);
  return buffer;
}

async function sendJsonAndExpectType(
  socket: WebSocket,
  message: unknown,
  type: string,
): Promise<Record<string, unknown>> {
  const response = nextJsonMessageOfType(socket, type);
  socket.send(JSON.stringify(message));
  return response;
}

function nextJsonMessageOfType(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return getJsonMessageBuffer(socket).next(
    (message) => message.type === type,
  );
}

async function nextJsonMessageBeforeClose(
  receiver: WebSocket,
  sender: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return Promise.race([
    nextJsonMessageOfType(receiver, type),
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
  const response = nextJsonMessageOfType(socket, "error");
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
