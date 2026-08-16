import { describe, expect, it } from "vitest";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  parseProtocolMismatchReason,
  probeProtocolVersion,
  protocolMismatchReason,
} from "../src/index.js";

describe("protocol version compatibility helpers", () => {
  it("recognizes only protocol v6 as compatible", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(probeProtocolVersion({ protocolVersion: 6 })).toEqual({
      receivedVersion: 6,
      compatible: true,
    });
    expect(probeProtocolVersion({ protocolVersion: 5 })).toEqual({
      receivedVersion: 5,
      compatible: false,
    });
  });

  it.each([
    null,
    [],
    "6",
    {},
    { protocolVersion: "6" },
    { protocolVersion: -1 },
    { protocolVersion: 1.5 },
    { protocolVersion: Number.MAX_SAFE_INTEGER },
  ])("treats unknown versions as incompatible", (payload) => {
    expect(probeProtocolVersion(payload)).toEqual({ compatible: false });
  });

  it("does not throw for malicious objects or getters", () => {
    const getter = Object.defineProperty({}, "protocolVersion", {
      get() {
        throw new Error("do not invoke me");
      },
    });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("blocked");
        },
        get() {
          throw new Error("blocked");
        },
      },
    );
    const revokedProxy = Proxy.revocable({}, {});
    revokedProxy.revoke();

    expect(() => probeProtocolVersion(getter)).not.toThrow();
    expect(probeProtocolVersion(getter)).toEqual({ compatible: false });
    expect(() => probeProtocolVersion(proxy)).not.toThrow();
    expect(probeProtocolVersion(proxy)).toEqual({ compatible: false });
    expect(() => probeProtocolVersion(revokedProxy.proxy)).not.toThrow();
    expect(probeProtocolVersion(revokedProxy.proxy)).toEqual({
      compatible: false,
    });
  });

  it.each([5, 7, undefined])(
    "round trips mismatch close reasons for received version %s",
    (receivedVersion) => {
      const reason = protocolMismatchReason(receivedVersion);

      expect(PROTOCOL_MISMATCH_CLOSE_CODE).toBe(1002);
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(123);
      expect(reason).not.toMatch(/[\\/]|token|uri|path/i);
      expect(parseProtocolMismatchReason(reason)).toEqual({
        expectedVersion: PROTOCOL_VERSION,
        ...(receivedVersion === undefined ? {} : { receivedVersion }),
      });
    },
  );

  it("rejects unknown or oversized close reasons", () => {
    expect(parseProtocolMismatchReason("unrelated close reason")).toBeUndefined();
    expect(
      parseProtocolMismatchReason("x".repeat(124)),
    ).toBeUndefined();
  });
});
