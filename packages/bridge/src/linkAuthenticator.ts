import { randomInt, randomUUID } from "node:crypto";
import {
  BridgeInstanceIdSchema,
  type ClientRole,
} from "@pinop/protocol";
import {
  createAuthorizedToken,
  tokensEqual,
  type AuthorizedToken,
} from "./auth.js";

export type TokenValidation = "accepted" | "rejected" | "instanceChanged";

export interface LinkAuthenticatorOptions {
  readonly sessionId: string;
  readonly bridgeInstanceId?: string;
  readonly pin?: string;
  readonly now?: () => Date;
  readonly randomInstanceId?: () => string;
  readonly randomPin?: () => string;
}

export type LinkAttempt =
  | {
      readonly accepted: {
        readonly sessionId: string;
        readonly bridgeInstanceId: string;
        readonly authToken: AuthorizedToken;
      };
    }
  | { readonly errorCode: "link.rejected" }
  | {
      readonly errorCode: "link.rateLimited";
      readonly retryAt: Date;
    };

const PIN_PATTERN = /^\d{2}$/;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const COOLDOWN_MS = 60_000;
// Bounds link churn independently for browser, simulator, and IDE credentials.
const MAX_ACTIVE_TOKENS_PER_ROLE = 64;

export class LinkAuthenticator {
  private readonly sessionId: string;
  private readonly bridgeInstanceId: string;
  private readonly pin: string;
  private readonly now: () => Date;
  private tokens: AuthorizedToken[] = [];
  private failures: number[] = [];
  private cooldownUntil: number | undefined;

  constructor(options: LinkAuthenticatorOptions) {
    const randomInstanceId = options.randomInstanceId ?? randomUUID;
    const randomPin =
      options.randomPin ??
      (() => randomInt(0, 100).toString().padStart(2, "0"));
    const pin = options.pin ?? randomPin();

    if (!PIN_PATTERN.test(pin)) {
      throw new Error("Link PIN must contain exactly two digits");
    }

    this.sessionId = options.sessionId;
    this.bridgeInstanceId = BridgeInstanceIdSchema.parse(
      options.bridgeInstanceId ?? randomInstanceId(),
    );
    this.pin = pin;
    this.now = options.now ?? (() => new Date());
  }

  linkInfo(): { readonly bridgeInstanceId: string; readonly pin: string } {
    return {
      bridgeInstanceId: this.bridgeInstanceId,
      pin: this.pin,
    };
  }

  issueTrustedToken(role: "ide"): AuthorizedToken {
    return this.issueToken(role, this.readNow());
  }

  attemptLink(pin: string, role: "browser" | "simulator"): LinkAttempt {
    const now = this.readNow();
    const attemptedAt = now.getTime();
    this.pruneFailures(attemptedAt);

    if (this.cooldownUntil !== undefined) {
      if (attemptedAt < this.cooldownUntil) {
        return {
          errorCode: "link.rateLimited",
          retryAt: new Date(this.cooldownUntil),
        };
      }

      this.cooldownUntil = undefined;
      this.failures = [];
    }

    if (!tokensEqual(this.pin, pin)) {
      if (this.failures.length + 1 < MAX_FAILURES) {
        this.failures.push(attemptedAt);
        return { errorCode: "link.rejected" };
      }

      const cooldownUntil = new Date(attemptedAt + COOLDOWN_MS);
      if (!Number.isFinite(cooldownUntil.getTime())) {
        throw new Error(
          "LinkAuthenticator clock cannot produce a valid cooldown Date",
        );
      }

      this.failures.push(attemptedAt);
      this.cooldownUntil = cooldownUntil.getTime();
      return {
        errorCode: "link.rateLimited",
        retryAt: new Date(cooldownUntil.getTime()),
      };
    }

    this.failures = [];
    const authToken = this.issueToken(role, now);
    return {
      accepted: {
        sessionId: this.sessionId,
        bridgeInstanceId: this.bridgeInstanceId,
        authToken,
      },
    };
  }

  validateToken(
    sessionId: string,
    role: ClientRole,
    token: string,
    bridgeInstanceId: string,
  ): TokenValidation {
    const now = this.readNow();
    this.pruneExpiredTokens(now.getTime());
    const authorized = this.tokens.find((candidate) =>
      tokensEqual(candidate.value, token),
    );

    if (
      !authorized ||
      authorized.sessionId !== sessionId ||
      authorized.role !== role
    ) {
      return "rejected";
    }

    const expiresAt = authorized.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return "rejected";
    }

    return authorized.bridgeInstanceId === bridgeInstanceId
      ? "accepted"
      : "instanceChanged";
  }

  revokeToken(token: string): void {
    this.tokens = this.tokens.filter(
      (authorized) => !tokensEqual(authorized.value, token),
    );
  }

  revokeRole(role: ClientRole): void {
    this.tokens = this.tokens.filter((token) => token.role !== role);
  }

  revokeAll(): void {
    this.tokens = [];
  }

  private issueToken(role: ClientRole, now: Date): AuthorizedToken {
    this.pruneExpiredTokens(now.getTime());
    let activeForRole = this.tokens.filter((token) => token.role === role).length;
    while (activeForRole >= MAX_ACTIVE_TOKENS_PER_ROLE) {
      const oldestIndex = this.tokens.findIndex((token) => token.role === role);
      if (oldestIndex < 0) {
        break;
      }
      this.tokens.splice(oldestIndex, 1);
      activeForRole -= 1;
    }

    const token = createAuthorizedToken(
      this.sessionId,
      role,
      this.bridgeInstanceId,
      now,
    );
    this.tokens.push(cloneAuthorizedToken(token));
    return cloneAuthorizedToken(token);
  }

  private pruneExpiredTokens(now: number): void {
    this.tokens = this.tokens.filter((token) => {
      const expiresAt = token.expiresAt.getTime();
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
  }

  private pruneFailures(now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((failedAt) => failedAt >= cutoff);
  }

  private readNow(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("LinkAuthenticator clock returned an invalid Date");
    }
    return now;
  }
}

function cloneAuthorizedToken(token: AuthorizedToken): AuthorizedToken {
  return {
    ...token,
    expiresAt: new Date(token.expiresAt.getTime()),
  };
}
