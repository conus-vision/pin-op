import { describe, expect, it } from "vitest";
import {
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  ProtocolCapability,
  ProtocolCapabilitySchema,
  parseMessage,
} from "../src/index.js";

const bridgeInstanceId = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";

const source = {
  role: "browser",
  id: "browser-tab-1",
  label: "Demo tab",
  url: "http://localhost:3000",
  metadata: {
    tabId: 12,
  },
};

const sourceLocation = {
  uri: "file:///workspace/src/App.tsx",
  line: 12,
  column: 3,
  endLine: 15,
  endColumn: 8,
  metadata: {
    loader: "vite",
  },
};

const runtimeFacts = [
  {
    type: "css-rule",
    selector: ".primary",
    property: "color",
    value: "red",
    source: sourceLocation,
    metadata: {},
  },
  {
    type: "dom-attribute",
    name: "aria-label",
    value: "Submit form",
    metadata: {},
  },
];

function target(
  role: "selected" | "parent",
  depth: 0 | 1,
  selector: string,
  facts: readonly unknown[],
) {
  return {
    role,
    depth,
    subject: { selector, metadata: {} },
    facts,
    metadata: {},
  };
}

function inspectMessage(targets: readonly unknown[]) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-v3",
    sessionId: "session-1",
    source,
    ideHighlightEnabled: true,
    targets,
    context: { url: "http://localhost:3000/", metadata: {} },
    metadata: {},
  };
}

describe("Pin-op protocol schemas", () => {
  it.each([
    [
      "hello",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        messageId: "msg-hello",
        sessionId: "session-1",
        authToken: "token-1",
        bridgeInstanceId,
        source,
        capabilities: ["inspect", "link"],
        metadata: {
          userAgent: "Vitest",
        },
      },
    ],
    [
      "linkRequest",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "linkRequest",
        messageId: "msg-link-request",
        pin: "07",
        source,
        metadata: {},
      },
    ],
    [
      "linkAccepted",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "linkAccepted",
        messageId: "msg-link-accepted",
        sessionId: "session-1",
        bridgeInstanceId,
        authToken: "a".repeat(64),
        expiresAt: "2026-07-09T15:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "authenticated",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticated",
        messageId: "msg-authenticated",
        sessionId: "session-1",
        bridgeInstanceId,
        metadata: {},
      },
    ],
    [
      "unlink",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "unlink",
        messageId: "msg-unlink",
        sessionId: "session-1",
        metadata: {},
      },
    ],
    [
      "inspect",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "inspect",
        messageId: "msg-inspect",
        sessionId: "session-1",
        source,
        ideHighlightEnabled: true,
        targets: [
          {
            role: "selected",
            depth: 0,
            subject: {
              selector: "#root > button",
              nodeId: "node-1",
              text: "Submit",
              attributes: [
                {
                  name: "data-testid",
                  value: "submit",
                  metadata: {},
                },
              ],
              metadata: {},
            },
            facts: runtimeFacts,
            metadata: {},
          },
        ],
        context: {
          url: "http://localhost:3000/form",
          frameId: "main",
          route: "/form",
          metadata: {
            viewport: "desktop",
          },
        },
        metadata: {},
      },
    ],
    [
      "error",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "msg-error",
        code: "resolver.fileNotFound",
        message: "Could not map element to source",
        details: {
          selector: "#missing",
        },
        metadata: {},
      },
    ],
    [
      "ping",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "ping",
        messageId: "msg-ping",
        sentAt: "2026-07-09T14:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "pong",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "pong",
        messageId: "msg-pong",
        pingMessageId: "msg-ping",
        sentAt: "2026-07-09T14:00:01.000Z",
        metadata: {},
      },
    ],
  ])("parses a valid %s message", (_name, message) => {
    expect(parseMessage(message)).toEqual(message);
  });

  it.each([
    [
      "references",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "references",
        messageId: "legacy-references",
        subject: { selector: "#root > button", metadata: {} },
        references: [
          {
            kind: "component",
            relation: "renders",
            label: "App",
            source: sourceLocation,
            confidence: "sourcemap",
            status: "active",
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    [
      "openSource command",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "legacy-open-source",
        command: "openSource",
        arguments: { source: sourceLocation, metadata: {} },
        metadata: {},
      },
    ],
    [
      "highlightElement command",
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "legacy-highlight-element",
        command: "highlightElement",
        arguments: { selector: "#root > button", metadata: {} },
        metadata: {},
      },
    ],
  ])("rejects the legacy %s public WebSocket envelope", (_name, message) => {
    expect(() => parseMessage(message)).toThrow();
  });

  it("advertises only active protocol capabilities", () => {
    expect(ProtocolCapability).toEqual({
      Inspect: "inspect",
      Resolution: "resolution",
      Link: "link",
      SourceNavigation: "source-navigation",
      AutoRefresh: "auto-refresh",
      SourcePresentation: "source-presentation",
      PresentationSettings: "presentation-settings",
    });
    expect(ProtocolCapabilitySchema.options).toEqual([
      "inspect",
      "resolution",
      "link",
      "source-navigation",
      "auto-refresh",
      "source-presentation",
      "presentation-settings",
    ]);
  });

  it.each(["7", "007", "aa"])("rejects invalid PIN %s", (pin) => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "linkRequest",
        messageId: "msg-invalid-pin",
        pin,
        source,
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects hello without a bridge instance", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        messageId: "msg-hello-no-instance",
        sessionId: "session-1",
        authToken: "token-1",
        source,
        capabilities: ["inspect"],
        metadata: {},
      }),
    ).toThrow();
  });

  it("parses selected and immediate-parent inspect targets", () => {
    const message = inspectMessage([
      target("selected", 0, ".card", runtimeFacts),
      target("parent", 1, ".layout", runtimeFacts),
    ]);

    expect(parseMessage(message)).toEqual(message);
  });

  it("requires an explicit IDE highlight preference on inspect", () => {
    const { ideHighlightEnabled: _ideHighlightEnabled, ...message } =
      inspectMessage([target("selected", 0, ".card", runtimeFacts)]);

    expect(() => parseMessage(message)).toThrow();
    expect(
      parseMessage({ ...message, ideHighlightEnabled: false }),
    ).toMatchObject({ ideHighlightEnabled: false });
  });

  it("exports practical inspect collection limits", () => {
    expect(INSPECT_ENVELOPE_MAX_BYTES).toBe(768 * 1024);
    expect(INSPECT_LIMITS).toEqual({
      targets: 2,
      factsPerTarget: 256,
      subjectAttributes: 64,
      selectorLength: 2048,
      propertyNameLength: 256,
      attributeNameLength: 256,
      valueLength: 16_384,
      textLength: 16_384,
      urlLength: 8192,
      nodeIdLength: 1024,
      frameIdLength: 256,
      routeLength: 8192,
      classNames: 128,
      stylesheets: 256,
      cssRules: 4096,
      cssRuleDepth: 32,
      declarationsPerRule: 128,
      mediaConditions: 16,
      inaccessibleStylesheets: 64,
    });
  });

  it("enforces the aggregate serialized inspect envelope budget", () => {
    const createMessage = (paddingLength: number) => ({
      ...inspectMessage([target("selected", 0, ".card", [])]),
      metadata: { padding: "x".repeat(paddingLength) },
    });
    const emptyBytes = Buffer.byteLength(
      JSON.stringify(createMessage(0)),
      "utf8",
    );
    const atLimit = createMessage(INSPECT_ENVELOPE_MAX_BYTES - emptyBytes);
    const oneByteOver = createMessage(
      INSPECT_ENVELOPE_MAX_BYTES - emptyBytes + 1,
    );

    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
    expect(() => parseMessage(atLimit)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(oneByteOver), "utf8")).toBe(
      INSPECT_ENVELOPE_MAX_BYTES + 1,
    );
    expect(() => parseMessage(oneByteOver)).toThrow();

    const multibyte = {
      ...inspectMessage([target("selected", 0, ".card", [])]),
      metadata: {
        padding: "\u{1F642}".repeat(INSPECT_ENVELOPE_MAX_BYTES / 4),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(multibyte), "utf8")).toBeGreaterThan(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
    expect(() => parseMessage(multibyte)).toThrow();
  });

  it("rejects inspect target arrays over the exported limit", () => {
    const result = InspectMessageSchema.safeParse(
      inspectMessage([
        target("selected", 0, ".card", []),
        target("parent", 1, ".layout", []),
        target("parent", 1, ".outer", []),
      ]),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "too_big",
            path: ["targets"],
            maximum: INSPECT_LIMITS.targets,
          }),
        ]),
      );
    }
  });

  it.each([
    ["client source ID", "id", () => INSPECT_LIMITS.nodeIdLength],
    ["client source label", "label", () => INSPECT_LIMITS.textLength],
    ["client source URL", "url", () => INSPECT_LIMITS.urlLength],
  ])("bounds inspect %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => ({
      ...inspectMessage([target("selected", 0, ".card", [])]),
      source: {
        ...source,
        [field]: "x".repeat(length),
      },
    });
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    ["DOM fact name", "name", () => INSPECT_LIMITS.attributeNameLength],
    ["DOM fact value", "value", () => INSPECT_LIMITS.valueLength],
  ])("bounds inspect %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => {
      const fact = {
        type: "dom-attribute",
        name: "data-state",
        value: "ready",
        metadata: {},
        [field]: "x".repeat(length),
      };
      return inspectMessage([target("selected", 0, ".card", [fact])]);
    };
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    [
      "facts per target",
      (length: number) =>
        inspectMessage([
          target(
            "selected",
            0,
            ".card",
            Array.from({ length }, () => runtimeFacts[0]),
          ),
        ]),
      () => INSPECT_LIMITS.factsPerTarget,
    ],
    [
      "subject attributes",
      (length: number) => {
        const message = inspectMessage([target("selected", 0, ".card", [])]);
        return {
          ...message,
          targets: [
            {
              ...message.targets[0],
              subject: {
                selector: ".card",
                attributes: Array.from({ length }, (_, index) => ({
                  name: `data-${index}`,
                  value: "value",
                  metadata: {},
                })),
                metadata: {},
              },
            },
          ],
        };
      },
      () => INSPECT_LIMITS.subjectAttributes,
    ],
  ])("bounds inspect %s", (_name, createMessage, readLimit) => {
    const limit = readLimit();
    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    ["subject selector", "selector", () => INSPECT_LIMITS.selectorLength],
    ["subject node id", "nodeId", () => INSPECT_LIMITS.nodeIdLength],
    ["subject text", "text", () => INSPECT_LIMITS.textLength],
  ])("bounds inspect %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => {
      const message = inspectMessage([target("selected", 0, ".card", [])]);
      return {
        ...message,
        targets: [
          {
            ...message.targets[0],
            subject: {
              ...message.targets[0]?.subject,
              [field]: "x".repeat(length),
            },
          },
        ],
      };
    };
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    ["attribute name", "name", () => INSPECT_LIMITS.attributeNameLength],
    ["attribute value", "value", () => INSPECT_LIMITS.valueLength],
  ])("bounds inspect subject %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => {
      const message = inspectMessage([target("selected", 0, ".card", [])]);
      return {
        ...message,
        targets: [
          {
            ...message.targets[0],
            subject: {
              ...message.targets[0]?.subject,
              attributes: [
                {
                  name: "data-state",
                  value: "ready",
                  metadata: {},
                  [field]: "x".repeat(length),
                },
              ],
            },
          },
        ],
      };
    };
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    ["CSS selector", "selector", () => INSPECT_LIMITS.selectorLength],
    ["CSS property", "property", () => INSPECT_LIMITS.propertyNameLength],
    ["CSS value", "value", () => INSPECT_LIMITS.valueLength],
  ])("bounds inspect %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => {
      const fact = {
        ...runtimeFacts[0],
        [field]: "x".repeat(length),
      };
      return inspectMessage([target("selected", 0, ".card", [fact])]);
    };
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it.each([
    ["context URL", "url", () => INSPECT_LIMITS.urlLength],
    ["context frame id", "frameId", () => INSPECT_LIMITS.frameIdLength],
    ["context route", "route", () => INSPECT_LIMITS.routeLength],
  ])("bounds inspect %s length", (_name, field, readLimit) => {
    const createMessage = (length: number) => ({
      ...inspectMessage([target("selected", 0, ".card", [])]),
      context: {
        url: "http://localhost",
        metadata: {},
        [field]: "x".repeat(length),
      },
    });
    const limit = readLimit();

    expect(() => parseMessage(createMessage(limit))).not.toThrow();
    expect(() => parseMessage(createMessage(limit + 1))).toThrow();
  });

  it("accepts a namespaced plugin runtime fact", () => {
    const fact = {
      type: "react.component",
      source: sourceLocation,
      payload: { componentName: "Card" },
      metadata: {},
    };

    expect(
      parseMessage(
        inspectMessage([target("selected", 0, ".card", [fact])]),
      ),
    ).toMatchObject({ targets: [{ facts: [fact] }] });
  });

  it.each([
    ["missing namespace", "react"],
    ["uppercase segment", "React.component"],
    ["empty segment", "react..component"],
    ["leading dot", ".react.component"],
    ["trailing dot", "react.component."],
    ["overlength name", `react.${"x".repeat(123)}`],
  ])("rejects a plugin fact with %s", (_name, type) => {
    expect(() =>
      parseMessage(inspectMessage([
        target("selected", 0, ".card", [{
          type,
          payload: {},
          metadata: {},
        }]),
      ])),
    ).toThrow();
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
  ])("rejects a plugin fact with %s in its payload", (_name, payload) => {
    expect(() =>
      parseMessage(inspectMessage([
        target("selected", 0, ".card", [{
          type: "react.component",
          payload,
          metadata: {},
        }]),
      ])),
    ).toThrow();
  });

  it.each([
    ["no selected target", [target("parent", 1, ".layout", runtimeFacts)]],
    [
      "duplicate selected targets",
      [
        target("selected", 0, ".card", runtimeFacts),
        target("selected", 0, ".featured", runtimeFacts),
      ],
    ],
    [
      "parent with the wrong depth",
      [
        target("selected", 0, ".card", runtimeFacts),
        target("parent", 0, ".layout", runtimeFacts),
      ],
    ],
  ])("rejects %s", (_name, targets) => {
    expect(() => parseMessage(inspectMessage(targets))).toThrow();
  });

  it("rejects protocol v5", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 5,
        type: "ping",
        messageId: "old-ping",
        sentAt: "2026-07-11T00:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects the legacy code-exchange request", () => {
    const legacyType = ["pair", "Request"].join("");
    const legacyCodeField = ["pairing", "Code"].join("");
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: legacyType,
        messageId: "msg-legacy-pair-request",
        [legacyCodeField]: "123456",
        source,
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects the legacy code-exchange response", () => {
    const legacyType = ["pair", "Accepted"].join("");
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: legacyType,
        messageId: "msg-legacy-pair-accepted",
        sessionId: "session-1",
        authToken: "token-1",
        expiresAt: "2026-07-09T15:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("accepts only the structured Pin-op error vocabulary", () => {
    const codes = [
      "link.invalidCode",
      "link.unreachable",
      "link.rejected",
      "link.rateLimited",
      "auth.tokenRejected",
      "auth.instanceChanged",
      "protocol.invalidMessage",
      "bridge.noIdeClient",
      "bridge.noBrowserClient",
      "bridge.offline",
      "resolver.fileNotFound",
      "resolver.sourceMapFailed",
      "browser.stylesheetInaccessible",
    ];

    for (const code of codes) {
      expect(
        parseMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: "error",
          messageId: `error-${code}`,
          code,
          message: "Diagnostic",
          metadata: {},
        }),
      ).toMatchObject({ code });
    }

    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "error-unknown",
        code: "UNKNOWN_ERROR",
        message: "Diagnostic",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects inspect messages with facts nested inside the subject", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "inspect",
        messageId: "msg-inspect-nested-facts",
        sessionId: "session-1",
        source,
        ideHighlightEnabled: true,
        targets: [
          {
            role: "selected",
            depth: 0,
            subject: {
              selector: "#root > button",
              facts: runtimeFacts,
              metadata: {},
            },
            facts: runtimeFacts,
            metadata: {},
          },
        ],
        context: {
          url: "http://localhost:3000/form",
          metadata: {},
        },
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unsupported protocol versions", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION + 1,
        type: "ping",
        messageId: "msg-ping",
        sentAt: "2026-07-09T14:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects messages with no type", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        messageId: "msg-missing-type",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects hello messages without session auth", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        messageId: "msg-hello-no-auth",
        source,
        capabilities: ["inspect"],
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects source locations with zero-based positions", () => {
    const invalidFact = {
      ...runtimeFacts[0],
      source: { ...sourceLocation, line: 0 },
    };

    expect(() =>
      parseMessage(
        inspectMessage([target("selected", 0, "#root", [invalidFact])]),
      ),
    ).toThrow();
  });

  it("rejects source locations with reversed ranges", () => {
    const invalidFact = {
      ...runtimeFacts[0],
      source: { ...sourceLocation, endLine: 11, endColumn: 8 },
    };

    expect(() =>
      parseMessage(
        inspectMessage([target("selected", 0, "#root", [invalidFact])]),
      ),
    ).toThrow();
  });

  it("rejects source locations with only one end position", () => {
    const invalidFact = {
      ...runtimeFacts[0],
      source: {
        uri: sourceLocation.uri,
        line: sourceLocation.line,
        column: sourceLocation.column,
        endLine: sourceLocation.endLine,
        metadata: {},
      },
    };

    expect(() =>
      parseMessage(
        inspectMessage([target("selected", 0, "#root", [invalidFact])]),
      ),
    ).toThrow();
  });

  it("rejects unsupported command names", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "command",
        messageId: "msg-unknown-command",
        command: "unknownCommand",
        arguments: {
          metadata: {},
        },
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields while preserving metadata entries", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "ping",
        messageId: "msg-extra-top-level",
        sentAt: "2026-07-09T14:00:00.000Z",
        unexpected: true,
        metadata: {
          unexpected: true,
        },
      }),
    ).toThrow();

    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "msg-extra-metadata",
      sentAt: "2026-07-09T14:00:00.000Z",
      metadata: {
        unexpected: true,
      },
    };

    expect(parseMessage(message)).toEqual(message);
  });
});
