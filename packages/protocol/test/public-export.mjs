import assert from "node:assert/strict";
import * as protocolExports from "@browser2ide/protocol";
import {
  AuthenticatedMessageSchema,
  BridgeInstanceIdSchema,
  Browser2IdeMessageSchema,
  EmptyMetadataSchema,
  LinkAcceptedMessageSchema,
  LinkRequestMessageSchema,
  PeerStateMessageSchema,
  PROTOCOL_VERSION,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
  ResolutionDiagnosticCodeSchema,
  ResolutionMessageSchema,
  ResolutionSourceSchema,
  ResolutionStatusSchema,
  UnlinkMessageSchema,
  parseMessage,
} from "@browser2ide/protocol";

const ping = {
  protocolVersion: PROTOCOL_VERSION,
  type: "ping",
  messageId: "msg-public-export-ping",
  sentAt: "2026-07-09T14:00:00.000Z",
  metadata: {},
};

assert.deepEqual(parseMessage(ping), ping);
assert.equal(PROTOCOL_VERSION, 4);
assert.equal(typeof Browser2IdeMessageSchema.parse, "function");
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
assert.equal(RESOLUTION_ENVELOPE_MAX_BYTES, 16 * 1024);
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
    Browser2IdeMessageSchema.safeParse(message).success,
    false,
    `${message.type}/${message.command ?? "references"} must be rejected`,
  );
}
