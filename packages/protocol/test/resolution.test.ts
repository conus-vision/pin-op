import { describe, expect, it } from "vitest";
import {
  EmptyMetadataSchema,
  PeerStateMessageSchema,
  PROTOCOL_VERSION,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
  ResolutionDiagnosticCodeSchema,
  ResolutionMessageSchema,
  ResolutionSourceSchema,
  ResolutionStatusSchema,
  parseMessage,
} from "../src/index.js";
import { createResolutionMessageSchema } from "../src/messages.js";

const resolutionStatuses = [
  "matched",
  "no-active-editor",
  "unsupported-document",
  "no-facts",
  "source-not-found",
  "source-not-active-document",
  "source-ambiguous",
  "source-map-missing",
  "source-map-invalid",
  "no-rule-match",
  "rule-match-ambiguous",
  "error",
] as const;

const diagnosticCodes = [
  "resolver.plugin-error",
  "resolver.plugin-timeout",
  "resolver.invalid-result",
  "resolver.source-read-failed",
] as const;

function resolutionMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: {
      role: "ide",
      id: "vscode-1",
    },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 1,
    document: {
      label: "src/App.tsx",
      languageId: "typescriptreact",
    },
    status: "matched",
    selectedMatchCount: 1,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
    ...overrides,
  };
}

function peerStateMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: "peer-state-1",
    sessionId: "session-1",
    role: "ide",
    connected: true,
    peerGeneration: 1,
    metadata: {},
    ...overrides,
  };
}

describe("resolution protocol messages", () => {
  it.each(resolutionStatuses)("accepts the %s status", (status) => {
    const message = resolutionMessage({
      status,
      selectedMatchCount: status === "matched" ? 1 : 0,
    });

    expect(ResolutionStatusSchema.parse(status)).toBe(status);
    expect(ResolutionMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it.each(diagnosticCodes)("accepts the %s diagnostic", (code) => {
    const message = resolutionMessage({
      status: "error",
      selectedMatchCount: 0,
      diagnosticCodes: [code],
    });

    expect(ResolutionDiagnosticCodeSchema.parse(code)).toBe(code);
    expect(ResolutionMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts a resolution without document details", () => {
    const { document: _document, ...message } = resolutionMessage();

    expect(ResolutionMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts a strict IDE resolution source", () => {
    const source = { role: "ide", id: "vscode-1" };

    expect(ResolutionSourceSchema.parse(source)).toEqual(source);
  });

  it("accepts a peer-state message through the public union", () => {
    const message = peerStateMessage();

    expect(PeerStateMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it("accepts only empty metadata", () => {
    expect(EmptyMetadataSchema.parse({})).toEqual({});
    expect(() => EmptyMetadataSchema.parse({ traceId: "trace-1" })).toThrow();
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ metadata: { traceId: "trace-1" } }),
      ),
    ).toThrow();
    expect(() =>
      PeerStateMessageSchema.parse(
        peerStateMessage({ metadata: { traceId: "trace-1" } }),
      ),
    ).toThrow();
  });

  it.each([
    ["label", "IDE"],
    ["url", "file:///workspace"],
    ["metadata", {}],
  ])("rejects the arbitrary resolution source field %s", (field, value) => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          source: { role: "ide", id: "vscode-1", [field]: value },
        }),
      ),
    ).toThrow();
  });

  it("rejects a non-IDE resolution source", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ source: { role: "browser", id: "browser-1" } }),
      ),
    ).toThrow();
  });

  it("rejects a non-IDE peer-state role", () => {
    expect(() =>
      PeerStateMessageSchema.parse(peerStateMessage({ role: "browser" })),
    ).toThrow();
  });

  it.each([
    "resolutionGeneration",
    "selectedMatchCount",
    "parentMatchCount",
    "inaccessibleStylesheetCount",
  ])("rejects a negative %s", (field) => {
    expect(() =>
      ResolutionMessageSchema.parse(resolutionMessage({ [field]: -1 })),
    ).toThrow();
  });

  it.each([
    ["resolutionGeneration", () => RESOLUTION_LIMITS.generation],
    ["selectedMatchCount", () => RESOLUTION_LIMITS.count],
    ["parentMatchCount", () => RESOLUTION_LIMITS.count],
    ["inaccessibleStylesheetCount", () => RESOLUTION_LIMITS.count],
  ])("rejects an oversized %s", (field, readLimit) => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ [field]: readLimit() + 1 }),
      ),
    ).toThrow();
  });

  it.each([
    "resolutionGeneration",
    "selectedMatchCount",
    "parentMatchCount",
    "inaccessibleStylesheetCount",
  ])("rejects a fractional %s", (field) => {
    expect(() =>
      ResolutionMessageSchema.parse(resolutionMessage({ [field]: 0.5 })),
    ).toThrow();
  });

  it("rejects invalid peer generations", () => {
    expect(() =>
      PeerStateMessageSchema.parse(peerStateMessage({ peerGeneration: -1 })),
    ).toThrow();
    expect(() =>
      PeerStateMessageSchema.parse(
        peerStateMessage({
          peerGeneration: RESOLUTION_LIMITS.generation + 1,
        }),
      ),
    ).toThrow();
    expect(() =>
      PeerStateMessageSchema.parse(peerStateMessage({ peerGeneration: 0.5 })),
    ).toThrow();
  });

  it("requires a matched resolution to contain a match", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          selectedMatchCount: 0,
          parentMatchCount: 0,
        }),
      ),
    ).toThrow();
  });

  it.each(resolutionStatuses.filter((status) => status !== "matched"))(
    "requires zero selected matches for %s",
    (status) => {
      expect(() =>
        ResolutionMessageSchema.parse(
          resolutionMessage({ status, selectedMatchCount: 1 }),
        ),
      ).toThrow();
    },
  );

  it.each(resolutionStatuses.filter((status) => status !== "matched"))(
    "requires zero parent matches for %s",
    (status) => {
      expect(() =>
        ResolutionMessageSchema.parse(
          resolutionMessage({
            status,
            selectedMatchCount: 0,
            parentMatchCount: 1,
          }),
        ),
      ).toThrow();
    },
  );

  it("rejects duplicate diagnostics", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          diagnosticCodes: [
            "resolver.plugin-error",
            "resolver.plugin-error",
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown statuses and diagnostics", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ status: "partially-matched" }),
      ),
    ).toThrow();
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ diagnosticCodes: ["resolver.unknown"] }),
      ),
    ).toThrow();
  });

  it.each([
    ["messageId", () => RESOLUTION_LIMITS.opaqueIdLength],
    ["sessionId", () => RESOLUTION_LIMITS.opaqueIdLength],
    ["inspectMessageId", () => RESOLUTION_LIMITS.opaqueIdLength],
  ])("bounds resolution %s", (field, readLimit) => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ [field]: "x".repeat(readLimit() + 1) }),
      ),
    ).toThrow();
  });

  it("bounds resolution source IDs", () => {
    expect(() =>
      ResolutionSourceSchema.parse({
        role: "ide",
        id: "x".repeat(RESOLUTION_LIMITS.opaqueIdLength + 1),
      }),
    ).toThrow();
  });

  it("bounds resolution document fields", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          document: {
            label: "x".repeat(RESOLUTION_LIMITS.labelLength + 1),
            languageId: "typescript",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          document: {
            label: "App.tsx",
            languageId: "x".repeat(RESOLUTION_LIMITS.languageIdLength + 1),
          },
        }),
      ),
    ).toThrow();
  });

  it("publishes the v4 resolution bounds", () => {
    expect(RESOLUTION_LIMITS.opaqueIdLength).toBe(128);
    expect(RESOLUTION_LIMITS.labelLength).toBe(128);
    expect(RESOLUTION_LIMITS.languageIdLength).toBe(64);
    expect(RESOLUTION_LIMITS.generation).toBe(0x7fffffff);
    expect(RESOLUTION_LIMITS.count).toBe(0x7fffffff);
    expect(RESOLUTION_LIMITS.diagnosticCodes).toBe(8);
  });

  it("rejects unknown top-level and document fields", () => {
    expect(() =>
      ResolutionMessageSchema.parse(resolutionMessage({ unexpected: true })),
    ).toThrow();
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({
          document: {
            label: "App.tsx",
            languageId: "typescriptreact",
            uri: "file:///workspace/src/App.tsx",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      PeerStateMessageSchema.parse(peerStateMessage({ unexpected: true })),
    ).toThrow();
  });

  it("enforces the serialized resolution envelope budget", () => {
    const oversized = resolutionMessage({
      document: {
        label: "x".repeat(RESOLUTION_ENVELOPE_MAX_BYTES),
        languageId: "typescript",
      },
    });

    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(
      RESOLUTION_ENVELOPE_MAX_BYTES,
    );
    const result = ResolutionMessageSchema.safeParse(oversized);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            message: "resolution message exceeds serialized byte limit",
          }),
        ]),
      );
    }
  });

  it("enforces an injected serialized-size limit for valid fields", () => {
    const message = resolutionMessage();
    const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    const schemaAtLimit = createResolutionMessageSchema(serializedBytes);
    const schemaBelowLimit = createResolutionMessageSchema(serializedBytes - 1);

    expect(schemaAtLimit.safeParse(message).success).toBe(true);
    expect(schemaBelowLimit.safeParse(message).success).toBe(false);
  });

  it("rejects protocol v3 resolution messages", () => {
    expect(() =>
      ResolutionMessageSchema.parse(
        resolutionMessage({ protocolVersion: 3 }),
      ),
    ).toThrow();
  });
});
