import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeMetadata,
  serializeRuntimeMetadata,
} from "../runtime-metadata.mjs";

test("serializes and parses exact protocol runtime metadata", () => {
  const serialized = serializeRuntimeMetadata(6);

  assert.equal(
    serialized,
    '{\n  "schemaVersion": 1,\n  "protocolVersion": 6\n}\n',
  );
  assert.deepEqual(
    parseRuntimeMetadata(serialized, {
      expectedProtocolVersion: 6,
      label: "test metadata",
    }),
    { schemaVersion: 1, protocolVersion: 6 },
  );
});

test("rejects downgraded, malformed, and extended runtime metadata", () => {
  assert.throws(
    () => parseRuntimeMetadata(
      '{"schemaVersion":1,"protocolVersion":5}',
      { expectedProtocolVersion: 6, label: "test metadata" },
    ),
    /test metadata protocolVersion expected 6 but found 5/,
  );
  assert.throws(
    () => parseRuntimeMetadata("not-json", { label: "test metadata" }),
    /test metadata is not valid JSON/,
  );
  assert.throws(
    () => parseRuntimeMetadata(
      '{"schemaVersion":1,"protocolVersion":6,"marker":"test"}',
      { label: "test metadata" },
    ),
    /test metadata has unexpected keys: marker/,
  );
});
