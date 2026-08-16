import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ClientRole } from "@pin-op/protocol";

export interface AuthorizedToken {
  readonly sessionId: string;
  readonly role: ClientRole;
  readonly bridgeInstanceId: string;
  readonly value: string;
  readonly expiresAt: Date;
}

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAuthorizedToken(
  sessionId: string,
  role: ClientRole,
  bridgeInstanceId: string,
  now = new Date(),
): AuthorizedToken {
  const issuedAt = finiteDateTime(now, "Token issue time");
  const expiresAt = new Date(issuedAt + TOKEN_TTL_MS);
  finiteDateTime(expiresAt, "Token expiration");

  return {
    sessionId,
    role,
    bridgeInstanceId,
    value: randomBytes(TOKEN_BYTES).toString("hex"),
    expiresAt,
  };
}

function finiteDateTime(date: Date, description: string): number {
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    throw new Error(`${description} must be a valid Date`);
  }
  return time;
}
