import { describe, expect, it } from "vitest";
import { PeerStateRegistry } from "../src/peerStateRegistry.js";

describe("PeerStateRegistry", () => {
  it("returns a disconnected generation-zero snapshot for an unseen session", () => {
    const registry = new PeerStateRegistry();

    expect(registry.get("session-1")).toEqual({
      connected: false,
      peerGeneration: 0,
    });
  });

  it("returns one transition when a session crosses each connection boundary", () => {
    const registry = new PeerStateRegistry();

    expect(registry.updateIdeCount("session-1", 1)).toEqual({
      sessionId: "session-1",
      connected: true,
      peerGeneration: 1,
    });
    expect(registry.updateIdeCount("session-1", 0)).toEqual({
      sessionId: "session-1",
      connected: false,
      peerGeneration: 2,
    });
  });

  it("does not emit transitions while the IDE count stays on one side of zero", () => {
    const registry = new PeerStateRegistry();

    expect(registry.updateIdeCount("session-1", 2)).toMatchObject({
      sessionId: "session-1",
      connected: true,
      peerGeneration: 1,
    });
    expect(registry.updateIdeCount("session-1", 3)).toBeUndefined();
    expect(registry.updateIdeCount("session-1", 1)).toBeUndefined();
    expect(registry.get("session-1")).toEqual({
      connected: true,
      peerGeneration: 1,
    });
  });

  it("tracks two IDEs through last disconnect and reconnect", () => {
    const registry = new PeerStateRegistry();

    expect(registry.updateIdeCount("session-1", 1)?.peerGeneration).toBe(1);
    expect(registry.updateIdeCount("session-1", 2)).toBeUndefined();
    expect(registry.updateIdeCount("session-1", 1)).toBeUndefined();
    expect(registry.updateIdeCount("session-1", 0)).toEqual({
      sessionId: "session-1",
      connected: false,
      peerGeneration: 2,
    });
    expect(registry.updateIdeCount("session-1", 1)).toEqual({
      sessionId: "session-1",
      connected: true,
      peerGeneration: 3,
    });
  });

  it("isolates sessions and keeps each generation monotonic", () => {
    const registry = new PeerStateRegistry();

    expect(registry.updateIdeCount("session-1", 1)?.peerGeneration).toBe(1);
    expect(registry.updateIdeCount("session-2", 1)?.peerGeneration).toBe(1);
    expect(registry.updateIdeCount("session-1", 0)?.peerGeneration).toBe(2);
    expect(registry.get("session-2")).toEqual({
      connected: true,
      peerGeneration: 1,
    });
  });

  it.each([-
    1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects an invalid IDE count: %s", (count) => {
    const registry = new PeerStateRegistry();

    expect(() => registry.updateIdeCount("session-1", count)).toThrow(
      "IDE count must be a nonnegative integer",
    );
  });

  it("clears snapshots and generations for bridge stop", () => {
    const registry = new PeerStateRegistry();
    registry.updateIdeCount("session-1", 1);
    registry.updateIdeCount("session-2", 1);

    registry.clear();

    expect(registry.get("session-1")).toEqual({
      connected: false,
      peerGeneration: 0,
    });
    expect(registry.get("session-2")).toEqual({
      connected: false,
      peerGeneration: 0,
    });
  });
});
