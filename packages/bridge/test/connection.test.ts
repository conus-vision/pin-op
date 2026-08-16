import { describe, expect, it } from "vitest";
import * as registryModule from "../src/clientRegistry.js";
import type { BridgeConnection } from "../src/clientRegistry.js";

interface TestSocket {
  readyState: number;
  send(payload: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

type GuardedConnectionFactory = (socket: TestSocket) => BridgeConnection;

describe("guarded WebSocket connection", () => {
  it("contains sync, callback, and concurrent-close send failures", () => {
    const candidate = Reflect.get(
      registryModule,
      "createGuardedWebSocketConnection",
    ) as unknown;
    expect(candidate).toBeTypeOf("function");
    const createConnection = candidate as GuardedConnectionFactory;

    let mode: "throw" | "callback" = "throw";
    let sends = 0;
    let terminations = 0;
    const socket: TestSocket = {
      readyState: 1,
      send(_payload, callback) {
        sends += 1;
        if (mode === "throw") {
          throw new Error("synchronous send failure");
        }
        callback(new Error("asynchronous send failure"));
      },
      close() {},
      terminate() {
        terminations += 1;
      },
    };
    const connection = createConnection(socket);

    expect(connection.send("first")).toBe(false);
    mode = "callback";
    expect(connection.send("second")).toBe(true);
    socket.readyState = 2;
    expect(connection.send("closing")).toBe(false);

    expect(sends).toBe(2);
    expect(terminations).toBe(2);
  });

  it("reports safe send acceptance and contains throwing connections", () => {
    const sendSafely = registryModule.sendConnectionSafely as (
      connection: { send(payload: string): boolean; terminate(): void },
      payload: string,
    ) => boolean;
    const sent: string[] = [];
    const connection = {
      send(payload: string) {
        sent.push(payload);
        return true;
      },
      terminate() {},
    };

    expect(sendSafely(connection, "accepted")).toBe(true);
    expect(sent).toEqual(["accepted"]);
    expect(
      sendSafely(
        {
          send() {
            throw new Error("send failed");
          },
          terminate() {},
        },
        "rejected",
      ),
    ).toBe(false);
  });

  it("forwards an optional WebSocket close code and reason", () => {
    const createConnection = Reflect.get(
      registryModule,
      "createGuardedWebSocketConnection",
    ) as GuardedConnectionFactory;
    const closes: Array<[number | undefined, string | undefined]> = [];
    const socket: TestSocket = {
      readyState: 1,
      send() {},
      close(code, reason) {
        closes.push([code, reason]);
      },
      terminate() {},
    };

    createConnection(socket).close?.(1002, "protocol mismatch");

    expect(closes).toEqual([[1002, "protocol mismatch"]]);
  });
});
