import { utf8ByteLength } from "./json.js";
import { PROTOCOL_VERSION } from "./messages.js";

export const PROTOCOL_MISMATCH_CLOSE_CODE = 1002;

const MAX_PROTOCOL_VERSION = 0x7fffffff;
const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_REASON_PATTERN =
  /^pin-op protocol mismatch; expected=(\d+); received=(\d+|unknown)$/;

export interface ProtocolVersionProbe {
  receivedVersion?: number;
  compatible: boolean;
}

function isBoundedProtocolVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PROTOCOL_VERSION
  );
}

export function probeProtocolVersion(payload: unknown): ProtocolVersionProbe {
  if (typeof payload !== "object" || payload === null) {
    return { compatible: false };
  }

  let descriptor: PropertyDescriptor | undefined;
  try {
    if (Array.isArray(payload)) {
      return { compatible: false };
    }
    descriptor = Object.getOwnPropertyDescriptor(payload, "protocolVersion");
  } catch {
    return { compatible: false };
  }

  if (!descriptor || !("value" in descriptor)) {
    return { compatible: false };
  }

  const receivedVersion = descriptor.value as unknown;
  if (!isBoundedProtocolVersion(receivedVersion)) {
    return { compatible: false };
  }

  return {
    receivedVersion,
    compatible: receivedVersion === PROTOCOL_VERSION,
  };
}

export function protocolMismatchReason(receivedVersion?: number): string {
  const safeReceivedVersion = isBoundedProtocolVersion(receivedVersion)
    ? receivedVersion.toString()
    : "unknown";
  return `pin-op protocol mismatch; expected=${PROTOCOL_VERSION}; received=${safeReceivedVersion}`;
}

export function parseProtocolMismatchReason(
  reason: string,
): { expectedVersion: number; receivedVersion?: number } | undefined {
  if (
    typeof reason !== "string" ||
    reason.length > MAX_CLOSE_REASON_BYTES ||
    utf8ByteLength(reason) > MAX_CLOSE_REASON_BYTES
  ) {
    return undefined;
  }

  const match = CLOSE_REASON_PATTERN.exec(reason);
  if (!match) {
    return undefined;
  }

  const expectedVersion = Number(match[1]);
  if (!isBoundedProtocolVersion(expectedVersion)) {
    return undefined;
  }

  if (match[2] === "unknown") {
    return { expectedVersion };
  }

  const receivedVersion = Number(match[2]);
  if (!isBoundedProtocolVersion(receivedVersion)) {
    return undefined;
  }

  return { expectedVersion, receivedVersion };
}
