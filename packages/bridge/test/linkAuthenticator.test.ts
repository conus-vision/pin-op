import { BridgeInstanceIdSchema } from "@pinop/protocol";
import { describe, expect, it } from "vitest";
import {
  LinkAuthenticator,
  type LinkAuthenticatorOptions,
} from "../src/linkAuthenticator.js";
import type { AuthorizedToken } from "../src/auth.js";

const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OTHER_ID = "4b1e466d-9ed3-46c9-bc21-367e741cd70b";
const STARTED_AT = Date.parse("2026-07-11T12:00:00.000Z");

describe("LinkAuthenticator", () => {
  it("keeps its generated two-digit PIN and instance identity stable", () => {
    let instanceIdCalls = 0;
    let pinCalls = 0;
    const auth = authenticator({
      randomInstanceId: () => {
        instanceIdCalls += 1;
        return instanceIdCalls === 1 ? INSTANCE_ID : OTHER_ID;
      },
      randomPin: () => {
        pinCalls += 1;
        return pinCalls === 1 ? "07" : "42";
      },
    });

    expect(auth.linkInfo()).toEqual({
      bridgeInstanceId: INSTANCE_ID,
      pin: "07",
    });
    expect(instanceIdCalls).toBe(1);
    expect(pinCalls).toBe(1);
    expect(auth.linkInfo()).toEqual({
      bridgeInstanceId: INSTANCE_ID,
      pin: "07",
    });
  });

  it("generates a valid instance identity and two-digit PIN by default", () => {
    const info = new LinkAuthenticator({ sessionId: "default" }).linkInfo();

    expect(BridgeInstanceIdSchema.safeParse(info.bridgeInstanceId).success).toBe(
      true,
    );
    expect(info.pin).toMatch(/^\d{2}$/);
  });

  it.each(["7", "007", "aa", "-1"])(
    "rejects invalid injected PIN %s",
    (pin) => {
      expect(() => authenticator({ pin })).toThrow();
    },
  );

  it("rejects an invalid injected bridge instance ID", () => {
    expect(() => authenticator({ bridgeInstanceId: "not-a-uuid" })).toThrow();
  });

  it("issues a browser token for the leading-zero PIN", () => {
    const auth = authenticator();
    const result = auth.attemptLink("07", "browser");

    expect(result).toMatchObject({
      accepted: {
        sessionId: "default",
        bridgeInstanceId: INSTANCE_ID,
        authToken: {
          sessionId: "default",
          role: "browser",
          bridgeInstanceId: INSTANCE_ID,
          expiresAt: new Date(STARTED_AT + 24 * 60 * 60 * 1_000),
        },
      },
    });
    if (!("accepted" in result)) {
      throw new Error("Expected the link attempt to be accepted");
    }
    expect(result.accepted.authToken.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds linked and trusted tokens to their issued roles", () => {
    const auth = authenticator();
    const browserToken = acceptedToken(auth, "browser");
    const simulatorToken = acceptedToken(auth, "simulator");
    const ideToken = auth.issueTrustedToken("ide");

    expect(browserToken.role).toBe("browser");
    expect(simulatorToken.role).toBe("simulator");
    expect(ideToken).toMatchObject({
      sessionId: "default",
      role: "ide",
      bridgeInstanceId: INSTANCE_ID,
    });
    expect(
      auth.validateToken("default", "browser", browserToken.value, INSTANCE_ID),
    ).toBe("accepted");
    expect(
      auth.validateToken(
        "default",
        "simulator",
        simulatorToken.value,
        INSTANCE_ID,
      ),
    ).toBe("accepted");
    expect(
      auth.validateToken("default", "ide", ideToken.value, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("does not expose a linked token's internal expiration Date", () => {
    const auth = authenticator();
    const token = acceptedToken(auth, "browser");

    token.expiresAt.setTime(0);

    expect(
      auth.validateToken("default", "browser", token.value, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("does not expose a trusted token's internal object", () => {
    const auth = authenticator();
    const token = auth.issueTrustedToken("ide");
    const originalValue = token.value;
    const mutableToken = token as Mutable<AuthorizedToken>;

    mutableToken.sessionId = "changed-session";
    mutableToken.role = "browser";
    mutableToken.bridgeInstanceId = OTHER_ID;
    mutableToken.value = differentTokenValue(originalValue);
    mutableToken.expiresAt = new Date(0);

    expect(
      auth.validateToken("default", "ide", originalValue, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("rejects an invalid clock when issuing a trusted token", () => {
    const auth = authenticator({ now: () => new Date(Number.NaN) });

    expect(() => auth.issueTrustedToken("ide")).toThrow(
      "LinkAuthenticator clock returned an invalid Date",
    );
  });

  it("rejects an invalid clock when attempting a link", () => {
    const auth = authenticator({ now: () => new Date(Number.NaN) });

    expect(() => auth.attemptLink("07", "browser")).toThrow(
      "LinkAuthenticator clock returned an invalid Date",
    );
  });

  it("rejects a clock that cannot produce a valid cooldown Date", () => {
    const auth = authenticator({
      now: () => new Date(8_640_000_000_000_000),
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }
    expect(() => auth.attemptLink("99", "browser")).toThrow(
      "LinkAuthenticator clock cannot produce a valid cooldown Date",
    );
  });

  it("rejects an invalid clock when validating a token", () => {
    let now = new Date(STARTED_AT);
    const auth = authenticator({ now: () => now });
    const token = acceptedToken(auth, "browser");
    now = new Date(Number.NaN);

    expect(() =>
      auth.validateToken("default", "browser", token.value, INSTANCE_ID),
    ).toThrow("LinkAuthenticator clock returned an invalid Date");
  });

  it("enters a bridge-wide cooldown on exactly the fifth failure", () => {
    let now = STARTED_AT;
    const auth = authenticator({ now: () => new Date(now) });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }

    const retryAt = new Date(STARTED_AT + 60_000);
    expect(auth.attemptLink("99", "simulator")).toEqual({
      errorCode: "link.rateLimited",
      retryAt,
    });

    now = STARTED_AT + 59_999;
    expect(auth.attemptLink("07", "browser")).toEqual({
      errorCode: "link.rateLimited",
      retryAt,
    });

    now = STARTED_AT + 60_000;
    expect(auth.attemptLink("99", "browser")).toEqual({
      errorCode: "link.rejected",
    });
  });

  it("prunes failures outside the rolling 60-second window", () => {
    let now = STARTED_AT;
    const auth = authenticator({ now: () => new Date(now) });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }

    now = STARTED_AT + 60_001;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }
    expect(auth.attemptLink("99", "browser")).toEqual({
      errorCode: "link.rateLimited",
      retryAt: new Date(now + 60_000),
    });
  });

  it("clears accumulated failures after a successful link", () => {
    const auth = authenticator();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }
    expect(auth.attemptLink("07", "browser")).toHaveProperty("accepted");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "simulator")).toEqual({
        errorCode: "link.rejected",
      });
    }
    expect(auth.attemptLink("99", "simulator")).toMatchObject({
      errorCode: "link.rateLimited",
    });
  });

  it("rejects a valid token for the wrong session or role", () => {
    const auth = authenticator();
    const token = acceptedToken(auth, "browser");

    expect(
      auth.validateToken("other-session", "browser", token.value, INSTANCE_ID),
    ).toBe("rejected");
    expect(
      auth.validateToken("default", "simulator", token.value, INSTANCE_ID),
    ).toBe("rejected");
    expect(
      auth.validateToken(
        "default",
        "browser",
        differentTokenValue(token.value),
        INSTANCE_ID,
      ),
    ).toBe("rejected");
  });

  it("reports a changed instance only for a matching live token", () => {
    const auth = authenticator();
    const token = acceptedToken(auth, "browser");

    expect(
      auth.validateToken("default", "browser", token.value, OTHER_ID),
    ).toBe("instanceChanged");
    expect(
      auth.validateToken(
        "default",
        "browser",
        differentTokenValue(token.value),
        OTHER_ID,
      ),
    ).toBe("rejected");
  });

  it("rejects a token at its expiration time", () => {
    let now = STARTED_AT;
    const auth = authenticator({ now: () => new Date(now) });
    const token = acceptedToken(auth, "browser");

    now = token.expiresAt.getTime() - 1;
    expect(
      auth.validateToken("default", "browser", token.value, INSTANCE_ID),
    ).toBe("accepted");

    now = token.expiresAt.getTime();
    expect(
      auth.validateToken("default", "browser", token.value, INSTANCE_ID),
    ).toBe("rejected");
  });

  it("caps active tokens per role and evicts the oldest token", () => {
    const auth = authenticator();
    const ideToken = auth.issueTrustedToken("ide");
    const browserTokens = Array.from({ length: 65 }, () =>
      acceptedToken(auth, "browser"),
    );
    const oldest = browserTokens[0];
    const newest = browserTokens.at(-1);
    if (!oldest || !newest) {
      throw new Error("Expected browser tokens for cap regression");
    }

    expect(
      auth.validateToken("default", "browser", oldest.value, INSTANCE_ID),
    ).toBe("rejected");
    expect(
      auth.validateToken("default", "browser", newest.value, INSTANCE_ID),
    ).toBe("accepted");
    expect(
      auth.validateToken("default", "ide", ideToken.value, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("revokes one token without revoking another", () => {
    const auth = authenticator();
    const revoked = acceptedToken(auth, "browser");
    const retained = acceptedToken(auth, "browser");

    auth.revokeToken(revoked.value);

    expect(
      auth.validateToken("default", "browser", revoked.value, INSTANCE_ID),
    ).toBe("rejected");
    expect(
      auth.validateToken("default", "browser", retained.value, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("revokes every token for one role", () => {
    const auth = authenticator();
    const firstBrowserToken = acceptedToken(auth, "browser");
    const secondBrowserToken = acceptedToken(auth, "browser");
    const simulatorToken = acceptedToken(auth, "simulator");
    const ideToken = auth.issueTrustedToken("ide");

    auth.revokeRole("browser");

    expect(
      auth.validateToken(
        "default",
        "browser",
        firstBrowserToken.value,
        INSTANCE_ID,
      ),
    ).toBe("rejected");
    expect(
      auth.validateToken(
        "default",
        "browser",
        secondBrowserToken.value,
        INSTANCE_ID,
      ),
    ).toBe("rejected");
    expect(
      auth.validateToken(
        "default",
        "simulator",
        simulatorToken.value,
        INSTANCE_ID,
      ),
    ).toBe("accepted");
    expect(
      auth.validateToken("default", "ide", ideToken.value, INSTANCE_ID),
    ).toBe("accepted");
  });

  it("revokes all issued tokens", () => {
    const auth = authenticator();
    const browserToken = acceptedToken(auth, "browser");
    const ideToken = auth.issueTrustedToken("ide");

    auth.revokeAll();

    expect(
      auth.validateToken("default", "browser", browserToken.value, INSTANCE_ID),
    ).toBe("rejected");
    expect(
      auth.validateToken("default", "ide", ideToken.value, INSTANCE_ID),
    ).toBe("rejected");
  });
});

function authenticator(
  overrides: Partial<LinkAuthenticatorOptions> = {},
): LinkAuthenticator {
  return new LinkAuthenticator({
    sessionId: "default",
    now: () => new Date(STARTED_AT),
    randomInstanceId: () => INSTANCE_ID,
    randomPin: () => "07",
    ...overrides,
  });
}

function acceptedToken(
  auth: LinkAuthenticator,
  role: "browser" | "simulator",
): AuthorizedToken {
  const result = auth.attemptLink("07", role);
  if (!("accepted" in result)) {
    throw new Error("Expected the link attempt to be accepted");
  }
  return result.accepted.authToken;
}

function differentTokenValue(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key];
};
