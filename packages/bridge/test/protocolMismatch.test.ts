import { once } from "node:events";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  protocolMismatchReason,
} from "@pin-op/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ReplyRouteRegistry } from "../src/replyRouteRegistry.js";
import { createBridgeServer, type BridgeServer } from "../src/server.js";

describe("bridge protocol version handshake", () => {
  let server: BridgeServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it.each([
    [5, protocolMismatchReason(5)],
    [99, protocolMismatchReason(99)],
  ])(
    "closes protocol version %s with 1002 and no current-version error frame",
    async (protocolVersion, expectedReason) => {
      server = createBridgeServer({ port: 0 });
      await server.start();
      const socket = await connect(server.getUrl());
      const received: string[] = [];
      socket.on("message", (payload) => received.push(payload.toString()));

      const closed = once(socket, "close");
      socket.send(JSON.stringify({ protocolVersion, type: "hello" }));
      const [code, reason] = (await closed) as [number, Buffer];

      expect(code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
      expect(reason.toString()).toBe(expectedReason);
      expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
      expect(received).toEqual([]);
    },
  );

  it.each([
    ["missing", JSON.stringify({ type: "hello" })],
    ["malformed", JSON.stringify({ protocolVersion: "6", type: "hello" })],
  ])(
    "closes an %s protocol version with a bounded unknown-version reason",
    async (_case, payload) => {
      server = createBridgeServer({ port: 0 });
      await server.start();
      const socket = await connect(server.getUrl());
      const received: string[] = [];
      socket.on("message", (frame) => received.push(frame.toString()));

      const closed = once(socket, "close");
      socket.send(payload);
      const [code, reason] = (await closed) as [number, Buffer];

      expect(code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
      expect(reason.toString()).toBe(protocolMismatchReason());
      expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
      expect(received).toEqual([]);
    },
  );

  it("clears both authority namespaces when an authenticated origin mismatches", async () => {
    const replyRoutes = new ReplyRouteRegistry();
    server = createBridgeServer({ port: 0, replyRoutes });
    const linkInfo = server.getLinkInfo();
    const linked = server.authenticator.attemptLink(linkInfo.pin, "browser");
    if (!("accepted" in linked)) {
      throw new Error("Expected browser link to be accepted");
    }
    await server.start();
    const socket = await connect(server.getUrl());
    const authenticated = once(socket, "message");
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        messageId: "hello-mismatch-cleanup",
        sessionId: "default",
        authToken: linked.accepted.authToken.value,
        bridgeInstanceId: linkInfo.bridgeInstanceId,
        source: { role: "browser", id: "browser-mismatch", metadata: {} },
        capabilities: ["inspect", "rules-sources"],
        metadata: {},
      }),
    );
    const [authenticatedPayload] = (await authenticated) as [Buffer];
    expect(JSON.parse(authenticatedPayload.toString())).toMatchObject({
      type: "authenticated",
    });
    const browser = server.registry.all()[0];
    if (!browser) {
      throw new Error("Expected authenticated browser registration");
    }
    expect(
      replyRoutes
        .register(
          "default",
          "inspect-mismatch-cleanup",
          browser.id,
          ["rule-a"],
        )
        .commit(),
    ).toBe(true);
    expect(
      replyRoutes.prepareRulesSources(
        "default",
        "inspect-mismatch-cleanup",
        "ide-owner",
        1,
        [{ ruleRef: "rule-a", openAuthorityId: "open-a" }],
        0,
      )?.commit(),
    ).toBe(true);
    expect(
      replyRoutes.claimResolution(
        "default",
        "inspect-mismatch-cleanup",
        "ide-owner",
        8,
      ),
    ).toBeDefined();
    expect(
      replyRoutes.get("default", "inspect-mismatch-cleanup"),
    ).toMatchObject({
      resolutionGeneration: 8,
      rulesGeneration: 1,
      matchIds: new Set(),
      ruleOpenAuthorityIds: new Set(["open-a"]),
    });

    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION + 1,
        type: "rules.open",
      }),
    );
    await closed;

    await vi.waitFor(() =>
      expect(
        replyRoutes.get("default", "inspect-mismatch-cleanup"),
      ).toBeUndefined(),
    );
  });
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}
