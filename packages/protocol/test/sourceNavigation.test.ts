import { describe, expect, it } from "vitest";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
  SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
  SourceNavigateMessageSchema,
  SourceNavigationDirectionSchema,
  SourceNavigationStateMessageSchema,
  parseMessage,
} from "../src/index.js";
import {
  createSourceNavigateMessageSchema,
  createSourceNavigationStateMessageSchema,
} from "../src/messages.js";

function sourceNavigateMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigate",
    messageId: "source-navigate-1",
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    resolutionGeneration: 3,
    direction: "next",
    metadata: {},
    ...overrides,
  };
}

function sourceNavigationStateMessage(
  overrides: Record<string, unknown> = {},
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: "source-navigation-state-1",
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    source: {
      role: "ide",
      id: "vscode-1",
    },
    resolutionGeneration: 3,
    selectedMatchCount: 4,
    activeMatchIndex: 1,
    metadata: {},
    ...overrides,
  };
}

describe("source navigation protocol messages", () => {
  it.each(["previous", "next"] as const)(
    "parses a valid %s source navigation intent",
    (direction) => {
      const message = sourceNavigateMessage({ direction });

      expect(SourceNavigationDirectionSchema.parse(direction)).toBe(direction);
      expect(SourceNavigateMessageSchema.parse(message)).toEqual(message);
      expect(PinOpMessageSchema.parse(message)).toEqual(message);
      expect(parseMessage(message)).toEqual(message);
    },
  );

  it("parses a valid source navigation state", () => {
    const message = sourceNavigationStateMessage();

    expect(SourceNavigationStateMessageSchema.parse(message)).toEqual(message);
    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it("allows the active match index to be absent outside every match", () => {
    const { activeMatchIndex: _activeMatchIndex, ...message } =
      sourceNavigationStateMessage();

    expect(SourceNavigationStateMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it.each([
    [0, 0],
    [4, 4],
    [4, -1],
  ])(
    "rejects selected match count %i with active match index %i",
    (selectedMatchCount, activeMatchIndex) => {
      expect(() =>
        SourceNavigationStateMessageSchema.parse(
          sourceNavigationStateMessage({
            selectedMatchCount,
            activeMatchIndex,
          }),
        ),
      ).toThrow();
    },
  );

  it("rejects directions outside the closed navigation vocabulary", () => {
    expect(() => SourceNavigationDirectionSchema.parse("first")).toThrow();
    expect(() =>
      SourceNavigateMessageSchema.parse(
        sourceNavigateMessage({ direction: "first" }),
      ),
    ).toThrow();
  });

  it("rejects unknown source navigation intent fields", () => {
    expect(() =>
      SourceNavigateMessageSchema.parse(
        sourceNavigateMessage({ unexpected: true }),
      ),
    ).toThrow();
  });

  it("rejects unknown source navigation state fields", () => {
    expect(() =>
      SourceNavigationStateMessageSchema.parse(
        sourceNavigationStateMessage({ unexpected: true }),
      ),
    ).toThrow();
    expect(() =>
      SourceNavigationStateMessageSchema.parse(
        sourceNavigationStateMessage({
          source: { role: "ide", id: "vscode-1", label: "VS Code" },
        }),
      ),
    ).toThrow();
  });

  it("publishes the source navigation envelope budget", () => {
    expect(SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES).toBe(16 * 1024);
  });

  it("enforces the source navigation intent serialized byte budget", () => {
    const message = sourceNavigateMessage({
      messageId: "\u00e9".repeat(64),
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");

    expect(
      createSourceNavigateMessageSchema(serializedBytes).safeParse(message)
        .success,
    ).toBe(true);
    expect(
      createSourceNavigateMessageSchema(serializedBytes - 1).safeParse(message)
        .success,
    ).toBe(false);
  });

  it("enforces the source navigation state serialized byte budget", () => {
    const message = sourceNavigationStateMessage({
      messageId: "\u00e9".repeat(64),
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");

    expect(
      createSourceNavigationStateMessageSchema(serializedBytes).safeParse(
        message,
      ).success,
    ).toBe(true);
    expect(
      createSourceNavigationStateMessageSchema(serializedBytes - 1).safeParse(
        message,
      ).success,
    ).toBe(false);
  });
});
