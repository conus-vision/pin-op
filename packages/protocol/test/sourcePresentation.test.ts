import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  PresentationSettingsMessageSchema,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
  SourceExcerptSchema,
  SourceMatchesMessageSchema,
  SourceOpenMessageSchema,
  parseMessage,
} from "../src/index.js";
import { createSourceMatchesMessageSchema } from "../src/messages.js";

function excerpt(overrides: Record<string, unknown> = {}) {
  return {
    matchId: "match-1",
    targetRole: "selected",
    label: "App.tsx:12",
    kind: "component",
    relation: "renders",
    confidence: "sourcemap",
    startLine: 12,
    endLine: 14,
    text: "export function App() {\n  return <main />;\n}",
    truncated: false,
    ...overrides,
  };
}

function sourceMatchesMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: "matches-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    document: { label: "App.tsx", languageId: "typescriptreact" },
    matches: [excerpt()],
    omittedMatchCount: 0,
    metadata: {},
    ...overrides,
  };
}

function sourceMatchesMessageWithSerializedBytes(targetBytes: number) {
  const emptyMatches = Array.from(
    { length: SOURCE_PRESENTATION_LIMITS.matches },
    (_, index) => excerpt({ matchId: `match-${index}`, text: "" }),
  );
  const emptyMessage = sourceMatchesMessage({ matches: emptyMatches });
  const emptyBytes = Buffer.byteLength(JSON.stringify(emptyMessage), "utf8");
  const textBytes = targetBytes - emptyBytes;
  const textBytesPerMatch = Math.floor(textBytes / emptyMatches.length);
  const remainder = textBytes % emptyMatches.length;
  const matches = emptyMatches.map((match, index) => ({
    ...match,
    text: "x".repeat(textBytesPerMatch + (index < remainder ? 1 : 0)),
  }));

  return sourceMatchesMessage({ matches });
}

function sourceOpenMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId: "open-1",
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    matchId: "match-1",
    metadata: {},
    ...overrides,
  };
}

function presentationSettingsMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "presentation.settings",
    messageId: "settings-1",
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    ideHighlightEnabled: true,
    metadata: {},
    ...overrides,
  };
}

describe("source presentation protocol messages", () => {
  it("parses source matches without source paths or URIs", () => {
    const message = sourceMatchesMessage();

    expect(SourceMatchesMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it.each(["selected", "parent"])("accepts %s excerpts", (targetRole) => {
    expect(SourceExcerptSchema.parse(excerpt({ targetRole }))).toMatchObject({
      targetRole,
    });
  });

  it.each(["exact", "sourcemap", "instrumented", "heuristic", "unknown"])(
    "accepts %s confidence",
    (confidence) => {
      expect(SourceExcerptSchema.parse(excerpt({ confidence }))).toMatchObject({
        confidence,
      });
    },
  );

  it.each([
    ["kind", "file:///workspace/private/Card.tsx"],
    ["relation", "webpack:///sources/Card.tsx:9:2"],
  ] as const)("rejects non-protocol %s presentation metadata", (field, value) => {
    expect(SourceExcerptSchema.safeParse(excerpt({ [field]: value })).success)
      .toBe(false);
  });

  it("does not impose selected-before-parent schema ordering", () => {
    const matches = [
      excerpt({ matchId: "parent-1", targetRole: "parent" }),
      excerpt({ matchId: "selected-1", targetRole: "selected" }),
    ];

    expect(
      SourceMatchesMessageSchema.parse(sourceMatchesMessage({ matches })).matches,
    ).toEqual(matches);
  });

  it("requires an exact IDE source", () => {
    expect(() =>
      SourceMatchesMessageSchema.parse(
        sourceMatchesMessage({ source: { role: "browser", id: "tab-1" } }),
      ),
    ).toThrow();
    expect(() =>
      SourceMatchesMessageSchema.parse(
        sourceMatchesMessage({
          source: { role: "ide", id: "vscode-1", url: "file:///private" },
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown source match, document, and excerpt fields", () => {
    expect(() =>
      SourceMatchesMessageSchema.parse(sourceMatchesMessage({ uri: "file:///x" })),
    ).toThrow();
    expect(() =>
      SourceMatchesMessageSchema.parse(
        sourceMatchesMessage({
          document: {
            label: "App.tsx",
            languageId: "typescriptreact",
            uri: "file:///x",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      SourceMatchesMessageSchema.parse(
        sourceMatchesMessage({ matches: [excerpt({ path: "/private" })] }),
      ),
    ).toThrow();
  });

  it("enforces one-based ordered display lines", () => {
    expect(() => SourceExcerptSchema.parse(excerpt({ startLine: 0 }))).toThrow();
    expect(() =>
      SourceExcerptSchema.parse(excerpt({ startLine: 15, endLine: 14 })),
    ).toThrow();
  });

  it("bounds match count", () => {
    const matches = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.matches + 1 },
      (_, index) => excerpt({ matchId: `match-${index}` }),
    );

    expect(() =>
      SourceMatchesMessageSchema.parse(sourceMatchesMessage({ matches })),
    ).toThrow();
  });

  it("bounds excerpt text by UTF-8 bytes", () => {
    const atLimit = "\u00e9".repeat(SOURCE_PRESENTATION_LIMITS.textBytes / 2);
    const overLimit = `${atLimit}x`;

    expect(SourceExcerptSchema.safeParse(excerpt({ text: atLimit })).success).toBe(
      true,
    );
    expect(
      SourceExcerptSchema.safeParse(excerpt({ text: overLimit })).success,
    ).toBe(false);
  });

  it("bounds excerpt text by logical lines", () => {
    const atLimit = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.textLines },
      () => "line",
    ).join("\r\n");
    const overLimit = `${atLimit}\nline`;

    expect(SourceExcerptSchema.safeParse(excerpt({ text: atLimit })).success).toBe(
      true,
    );
    expect(
      SourceExcerptSchema.safeParse(excerpt({ text: overLimit })).success,
    ).toBe(false);
  });

  it("publishes and enforces the source matches envelope budget", () => {
    expect(SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES).toBe(256 * 1024);
    const message = sourceMatchesMessage();
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");

    expect(createSourceMatchesMessageSchema(bytes).safeParse(message).success).toBe(
      true,
    );
    expect(
      createSourceMatchesMessageSchema(bytes - 1).safeParse(message).success,
    ).toBe(false);
  });

  it("enforces the production source matches envelope boundary", () => {
    const atLimit = sourceMatchesMessageWithSerializedBytes(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
    );
    const overLimit = sourceMatchesMessageWithSerializedBytes(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES + 1,
    );

    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
    );
    expect(SourceMatchesMessageSchema.safeParse(atLimit).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBe(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES + 1,
    );
    const result = SourceMatchesMessageSchema.safeParse(overLimit);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            message: "source.matches message exceeds serialized byte limit",
          }),
        ]),
      );
    }
  });

  it("parses strict source-open intents with only match identity", () => {
    const message = sourceOpenMessage();

    expect(SourceOpenMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
    for (const forbidden of ["uri", "range", "command", "path"]) {
      expect(() =>
        SourceOpenMessageSchema.parse(
          sourceOpenMessage({ [forbidden]: forbidden }),
        ),
      ).toThrow();
    }
  });

  it("parses strict presentation settings", () => {
    const message = presentationSettingsMessage();

    expect(PresentationSettingsMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
    expect(() =>
      PresentationSettingsMessageSchema.parse(
        presentationSettingsMessage({ ideHighlightEnabled: "true" }),
      ),
    ).toThrow();
    expect(() =>
      PresentationSettingsMessageSchema.parse(
        presentationSettingsMessage({ metadata: { extra: true } }),
      ),
    ).toThrow();
  });

  it.each([
    sourceMatchesMessage({ protocolVersion: 5 }),
    sourceOpenMessage({ protocolVersion: 5 }),
    presentationSettingsMessage({ protocolVersion: 5 }),
  ])("rejects protocol v5", (message) => {
    expect(() => parseMessage(message)).toThrow();
  });
});
