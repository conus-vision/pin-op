import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeMetadata,
  serializeRuntimeMetadata,
} from "../runtime-metadata.mjs";

test("serializes and parses exact protocol runtime metadata", () => {
  const serialized = serializeRuntimeMetadata(5);

  assert.equal(
    serialized,
    '{\n  "schemaVersion": 1,\n  "protocolVersion": 5\n}\n',
  );
  assert.deepEqual(
    parseRuntimeMetadata(serialized, {
      expectedProtocolVersion: 5,
      label: "test metadata",
    }),
    { schemaVersion: 1, protocolVersion: 5 },
  );
});

test("rejects downgraded, malformed, and extended runtime metadata", () => {
  assert.throws(
    () => parseRuntimeMetadata(
      '{"schemaVersion":1,"protocolVersion":4}',
      { expectedProtocolVersion: 5, label: "test metadata" },
    ),
    /test metadata protocolVersion expected 5 but found 4/,
  );
  assert.throws(
    () => parseRuntimeMetadata("not-json", { label: "test metadata" }),
    /test metadata is not valid JSON/,
  );
  assert.throws(
    () => parseRuntimeMetadata(
      '{"schemaVersion":1,"protocolVersion":5,"marker":"test"}',
      { label: "test metadata" },
    ),
    /test metadata has unexpected keys: marker/,
  );
});
