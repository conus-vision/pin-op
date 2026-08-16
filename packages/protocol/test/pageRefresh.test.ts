import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  PageRefreshMessageSchema,
  PageRefreshModeSchema,
  RESOLUTION_LIMITS,
  parseMessage,
} from "../src/index.js";

function pageRefreshMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: "refresh-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    refreshGeneration: 1,
    mode: "styles",
    metadata: {},
    ...overrides,
  };
}

describe("page refresh protocol message", () => {
  it.each(["styles", "reload"] as const)("parses %s refreshes", (mode) => {
    const message = pageRefreshMessage({ mode });

    expect(PageRefreshModeSchema.parse(mode)).toBe(mode);
    expect(PageRefreshMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it("requires an exact IDE source", () => {
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({ source: { role: "browser", id: "tab-1" } }),
      ),
    ).toThrow();
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({
          source: { role: "ide", id: "vscode-1", label: "VS Code" },
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown fields and non-empty metadata", () => {
    expect(() =>
      PageRefreshMessageSchema.parse(pageRefreshMessage({ uri: "file:///x" })),
    ).toThrow();
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({ metadata: { path: "/private" } }),
      ),
    ).toThrow();
  });

  it.each(["messageId", "sessionId"])("bounds %s", (field) => {
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({
          [field]: "x".repeat(RESOLUTION_LIMITS.opaqueIdLength + 1),
        }),
      ),
    ).toThrow();
  });

  it("bounds refresh generations", () => {
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({
          refreshGeneration: RESOLUTION_LIMITS.generation + 1,
        }),
      ),
    ).toThrow();
    expect(() =>
      PageRefreshMessageSchema.parse(
        pageRefreshMessage({ refreshGeneration: -1 }),
      ),
    ).toThrow();
  });

  it("rejects protocol v5", () => {
    expect(() =>
      PageRefreshMessageSchema.parse(pageRefreshMessage({ protocolVersion: 5 })),
    ).toThrow();
  });
});
