import { PROTOCOL_VERSION } from "@browser2ide/protocol";
import { describe, expect, it, vi } from "vitest";
import { ClientRegistry } from "../src/clientRegistry.js";
import { startHeartbeat } from "../src/heartbeat.js";

function client() {
  return {
    sent: [] as unknown[],
    terminated: false,
    connection: {
      send(payload: string) {
        this.sent.push(JSON.parse(payload));
        return true;
      },
      sent: [] as unknown[],
      terminate() {
        this.terminated = true;
      },
      terminated: false,
    },
    source: { role: "browser" as const, id: "browser-source", metadata: {} },
    sessionId: "session-1",
    authToken: "browser-session-1-token",
  };
}

describe("bridge heartbeat", () => {
  it("sends ping every 15 seconds and terminates clients that miss two pongs", () => {
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const entry = registry.add(client());

    const heartbeat = startHeartbeat(registry);

    vi.advanceTimersByTime(15_000);
    expect(entry.connection.sent).toHaveLength(1);
    expect(entry.connection.sent[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      metadata: {},
    });
    expect(entry.missedPongs).toBe(1);

    vi.advanceTimersByTime(15_000);
    expect(entry.connection.sent).toHaveLength(2);
    expect(entry.missedPongs).toBe(2);
    expect(entry.connection.terminated).toBe(false);

    vi.advanceTimersByTime(15_000);
    expect(entry.connection.terminated).toBe(true);

    heartbeat.stop();
    vi.useRealTimers();
  });

  it("contains connection send failures", () => {
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const failing = client();
    failing.connection.send = () => {
      throw new Error("send failed");
    };
    registry.add(failing);
    const heartbeat = startHeartbeat(registry);

    try {
      expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("passes the exact evicted registered client once", () => {
    vi.useFakeTimers();
    const registry = new ClientRegistry();
    const entry = registry.add(client());
    const evicted: unknown[] = [];
    const heartbeat = startHeartbeat(registry, 15_000, (client) =>
      evicted.push(client),
    );

    try {
      vi.advanceTimersByTime(45_000);
      expect(evicted).toEqual([entry]);
      expect(registry.all()).toEqual([]);
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });
});
