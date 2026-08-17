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
  PageRefreshMessageSchema,
  PageRefreshModeSchema,
  PresentationSettingsMessageSchema,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION_PROBE_MAX_BYTES,
  ProtocolCapability,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
  ResolutionDiagnosticCodeSchema,
  ResolutionMessageSchema,
  ResolutionSourceSchema,
  ResolutionStatusSchema,
  SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
  SOURCE_EXCERPT_KINDS,
  SOURCE_EXCERPT_RELATIONS,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
  SourceDocumentSchema,
  SourceExcerptConfidenceSchema,
  SourceExcerptKindSchema,
  SourceExcerptRelationSchema,
  SourceExcerptSchema,
  SourceExcerptTargetRoleSchema,
  SourceMatchesMessageSchema,
  SourceNavigateMessageSchema,
  SourceNavigationDirectionSchema,
  SourceNavigationStateMessageSchema,
  SourceOpenMessageSchema,
  UnlinkMessageSchema,
  createSourceMatchesMessageSchema,
  parseProtocolMismatchReason,
  parseMessage,
  probeProtocolVersion,
  protocolMismatchReason,
} from "@pin-op/protocol";

const ping = {
  protocolVersion: PROTOCOL_VERSION,
  type: "ping",
  messageId: "msg-public-export-ping",
  sentAt: "2026-07-09T14:00:00.000Z",
  metadata: {},
};

assert.deepEqual(parseMessage(ping), ping);
assert.equal(PROTOCOL_VERSION, 6);
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
assert.equal(typeof PageRefreshModeSchema.parse, "function");
assert.equal(typeof PageRefreshMessageSchema.parse, "function");
assert.equal(typeof SourceExcerptSchema.parse, "function");
assert.equal(typeof SourceExcerptTargetRoleSchema.parse, "function");
assert.equal(typeof SourceExcerptConfidenceSchema.parse, "function");
assert.equal(typeof SourceExcerptKindSchema.parse, "function");
assert.equal(typeof SourceExcerptRelationSchema.parse, "function");
assert.deepEqual(SOURCE_EXCERPT_KINDS, [
  "component",
  "fixture",
  "rule",
  "source",
  "style-rule",
  "template",
]);
assert.deepEqual(SOURCE_EXCERPT_RELATIONS, [
  "applies",
  "contains",
  "declared-in",
  "matches",
  "parent",
  "renders",
  "selected",
  "styles",
  "templates",
]);
assert.equal(SourceExcerptKindSchema.safeParse("template").success, true);
assert.equal(SourceExcerptRelationSchema.safeParse("templates").success, true);
assert.equal(typeof SourceDocumentSchema.parse, "function");
assert.equal(typeof createSourceMatchesMessageSchema, "function");
assert.equal(typeof SourceMatchesMessageSchema.parse, "function");
assert.equal(typeof SourceOpenMessageSchema.parse, "function");
assert.equal(typeof PresentationSettingsMessageSchema.parse, "function");
assert.equal(typeof SourceNavigationDirectionSchema.parse, "function");
assert.equal(typeof SourceNavigateMessageSchema.parse, "function");
assert.equal(typeof SourceNavigationStateMessageSchema.parse, "function");
assert.equal(ProtocolCapability.SourceNavigation, "source-navigation");
assert.equal(ProtocolCapability.AutoRefresh, "auto-refresh");
assert.equal(ProtocolCapability.SourcePresentation, "source-presentation");
assert.equal(ProtocolCapability.PresentationSettings, "presentation-settings");
assert.equal(RESOLUTION_ENVELOPE_MAX_BYTES, 16 * 1024);
assert.equal(SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES, 16 * 1024);
assert.equal(SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES, 256 * 1024);
assert.equal(SOURCE_PRESENTATION_LIMITS.matches, 32);
assert.equal(SOURCE_PRESENTATION_LIMITS.textBytes, 8 * 1024);
assert.equal(SOURCE_PRESENTATION_LIMITS.textLines, 80);
assert.equal(PROTOCOL_MISMATCH_CLOSE_CODE, 1002);
assert.equal(PROTOCOL_VERSION_PROBE_MAX_BYTES, 768 * 1024);
assert.deepEqual(probeProtocolVersion(JSON.stringify({ protocolVersion: 6 })), {
  receivedVersion: 6,
  compatible: true,
});
assert.deepEqual(parseProtocolMismatchReason(protocolMismatchReason(5)), {
  expectedVersion: 6,
  receivedVersion: 5,
});
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
