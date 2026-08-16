import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION_PROBE_MAX_BYTES,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  parseProtocolMismatchReason,
  probeProtocolVersion,
  protocolMismatchReason,
} from "../src/index.js";

describe("protocol version compatibility helpers", () => {
  it("recognizes only protocol v6 as compatible", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(probeProtocolVersion(JSON.stringify({ protocolVersion: 6 }))).toEqual({
      receivedVersion: 6,
      compatible: true,
    });
    expect(probeProtocolVersion(JSON.stringify({ protocolVersion: 5 }))).toEqual({
      receivedVersion: 5,
      compatible: false,
    });
  });

  it.each([
    null,
    [],
    {},
    "not-json",
    "6",
    "null",
    "[]",
    "{}",
    JSON.stringify({ protocolVersion: "6" }),
    JSON.stringify({ protocolVersion: -1 }),
    JSON.stringify({ protocolVersion: 1.5 }),
    JSON.stringify({ protocolVersion: Number.MAX_SAFE_INTEGER }),
  ])("treats unknown versions as incompatible", (payload) => {
    expect(probeProtocolVersion(payload)).toEqual({ compatible: false });
  });

  it("bounds raw serialized frame text by UTF-8 bytes", () => {
    const emptyFrame = JSON.stringify({ protocolVersion: 6, padding: "" });
    const emptyFrameBytes = Buffer.byteLength(emptyFrame, "utf8");
    const atLimit = JSON.stringify({
      protocolVersion: 6,
      padding: "x".repeat(
        PROTOCOL_VERSION_PROBE_MAX_BYTES - emptyFrameBytes,
      ),
    });
    const overLimit = `${atLimit} `;
    const multibyteOverLimit = JSON.stringify({
      protocolVersion: 6,
      padding: "\u00e9".repeat(PROTOCOL_VERSION_PROBE_MAX_BYTES / 2),
    });

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(
      PROTOCOL_VERSION_PROBE_MAX_BYTES,
    );
    expect(probeProtocolVersion(atLimit)).toEqual({
      receivedVersion: 6,
      compatible: true,
    });
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(
      PROTOCOL_VERSION_PROBE_MAX_BYTES + 1,
    );
    expect(probeProtocolVersion(overLimit)).toEqual({ compatible: false });
    expect(multibyteOverLimit.length).toBeLessThan(
      PROTOCOL_VERSION_PROBE_MAX_BYTES,
    );
    expect(Buffer.byteLength(multibyteOverLimit, "utf8")).toBeGreaterThan(
      PROTOCOL_VERSION_PROBE_MAX_BYTES,
    );
    expect(probeProtocolVersion(multibyteOverLimit)).toEqual({
      compatible: false,
    });
  });

  it("rejects accessors without invoking their getters", () => {
    let getterInvocationCount = 0;
    const getter = Object.defineProperty({}, "protocolVersion", {
      get() {
        getterInvocationCount += 1;
        return PROTOCOL_VERSION;
      },
    });

    expect(probeProtocolVersion(getter)).toEqual({ compatible: false });
    expect(getterInvocationCount).toBe(0);
  });

  it("rejects proxies without invoking property traps", () => {
    let proxyGetInvocationCount = 0;
    let proxyDescriptorInvocationCount = 0;
    const proxy = new Proxy(
      { protocolVersion: PROTOCOL_VERSION },
      {
        get() {
          proxyGetInvocationCount += 1;
          return PROTOCOL_VERSION;
        },
        getOwnPropertyDescriptor() {
          proxyDescriptorInvocationCount += 1;
          return {
            configurable: true,
            enumerable: true,
            value: PROTOCOL_VERSION,
            writable: true,
          };
        },
      },
    );

    expect(probeProtocolVersion(proxy)).toEqual({ compatible: false });
    expect(proxyGetInvocationCount).toBe(0);
    expect(proxyDescriptorInvocationCount).toBe(0);
  });

  it("does not throw for malicious or revoked proxies", () => {
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
