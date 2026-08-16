import assert from "node:assert/strict";
import * as protocolExports from "@pin-op/protocol";
import {
  AuthenticatedMessageSchema,
  BridgeInstanceIdSchema,
  PinOpMessageSchema,
  EmptyMetadataSchema,
  LinkAcceptedMessageSchema,
  LinkRequestMessageSchema,
  PeerStateMessageSchema,
  PROTOCOL_VERSION,
  ProtocolCapability,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
  ResolutionDiagnosticCodeSchema,
  ResolutionMessageSchema,
  ResolutionSourceSchema,
  ResolutionStatusSchema,
  SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
  SourceNavigateMessageSchema,
  SourceNavigationDirectionSchema,
  SourceNavigationStateMessageSchema,
  UnlinkMessageSchema,
  parseMessage,
} from "@pin-op/protocol";

const ping = {
  protocolVersion: PROTOCOL_VERSION,
  type: "ping",
  messageId: "msg-public-export-ping",
  sentAt: "2026-07-09T14:00:00.000Z",
  metadata: {},
};

assert.deepEqual(parseMessage(ping), ping);
assert.equal(PROTOCOL_VERSION, 5);
assert.equal(typeof PinOpMessageSchema.parse, "function");
assert.equal(typeof BridgeInstanceIdSchema.parse, "function");
assert.equal(typeof EmptyMetadataSchema.parse, "function");
assert.equal(typeof LinkRequestMessageSchema.parse, "function");
assert.equal(typeof LinkAcceptedMessageSchema.parse, "function");
assert.equal(typeof AuthenticatedMessageSchema.parse, "function");
assert.equal(typeof UnlinkMessageSchema.parse, "function");
assert.equal(typeof ResolutionSourceSchema.parse, "function");
assert.equal(typeof ResolutionDiagnosticCodeSchema.parse, "function");
assert.equal(typeof ResolutionStatusSchema.parse, "function");
assert.equal(typeof ResolutionMessageSchema.parse, "function");
assert.equal(typeof PeerStateMessageSchema.parse, "function");
assert.equal(typeof SourceNavigationDirectionSchema.parse, "function");
assert.equal(typeof SourceNavigateMessageSchema.parse, "function");
assert.equal(typeof SourceNavigationStateMessageSchema.parse, "function");
assert.equal(ProtocolCapability.SourceNavigation, "source-navigation");
assert.equal(RESOLUTION_ENVELOPE_MAX_BYTES, 16 * 1024);
assert.equal(SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES, 16 * 1024);
assert.equal(typeof RESOLUTION_LIMITS.opaqueIdLength, "number");
assert.equal(typeof RESOLUTION_LIMITS.labelLength, "number");
assert.equal(typeof RESOLUTION_LIMITS.languageIdLength, "number");
assert.equal(typeof RESOLUTION_LIMITS.generation, "number");
assert.equal(typeof RESOLUTION_LIMITS.count, "number");
assert.equal(typeof RESOLUTION_LIMITS.diagnosticCodes, "number");

for (const legacyExport of [
  "ReferencesMessageSchema",
  "OpenSourceCommandMessageSchema",
  "HighlightElementCommandMessageSchema",
  "CommandMessageSchema",
  "SourceReferenceSchema",
]) {
  assert.equal(
    Object.hasOwn(protocolExports, legacyExport),
    false,
    `${legacyExport} must not be publicly exported`,
  );
}

const localSource = {
  uri: "file:///C:/private/workspace/src/App.tsx",
  line: 12,
  column: 3,
  metadata: {},
};
const legacyMessages = [
  {
    protocolVersion: PROTOCOL_VERSION,
    type: "references",
    messageId: "legacy-references",
    subject: { selector: "#app", metadata: {} },
    references: [
      {
        kind: "component",
        relation: "renders",
        label: "App",
        source: localSource,
        confidence: "exact",
        status: "active",
        metadata: {},
      },
    ],
    metadata: {},
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: "command",
    messageId: "legacy-open-source",
    command: "openSource",
    arguments: { source: localSource, metadata: {} },
    metadata: {},
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: "command",
    messageId: "legacy-highlight-element",
    command: "highlightElement",
    arguments: { selector: "#app", metadata: {} },
    metadata: {},
  },
];

for (const message of legacyMessages) {
  assert.equal(
    PinOpMessageSchema.safeParse(message).success,
    false,
    `${message.type}/${message.command ?? "references"} must be rejected`,
  );
}
