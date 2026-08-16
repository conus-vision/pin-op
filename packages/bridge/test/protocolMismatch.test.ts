import { once } from "node:events";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protocolMismatchReason,
} from "@pin-op/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
    "closes protocol version %s with 1002 and no v6 error frame",
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
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}
