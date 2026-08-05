import assert from "node:assert/strict";
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
