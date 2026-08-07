export const RUNTIME_METADATA_FILENAME = "runtime-metadata.json";
export const RUNTIME_METADATA_SCHEMA_VERSION = 1;

const RUNTIME_METADATA_KEYS = Object.freeze([
  "protocolVersion",
  "schemaVersion",
]);

export function serializeRuntimeMetadata(protocolVersion) {
  return `${JSON.stringify(createRuntimeMetadata(protocolVersion), null, 2)}\n`;
}

export function parseRuntimeMetadata(
  input,
  { expectedProtocolVersion, label = "runtime metadata" } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(
      typeof input === "string" ? input : input.toString("utf8"),
    );
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(parsed).sort(compareAscii);
  const missing = RUNTIME_METADATA_KEYS.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing keys: ${missing.join(", ")}`);
  }
  const unexpected = keys.filter((key) => !RUNTIME_METADATA_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} has unexpected keys: ${unexpected.join(", ")}`);
  }
  if (parsed.schemaVersion !== RUNTIME_METADATA_SCHEMA_VERSION) {
    throw new Error(
      `${label} schemaVersion expected ${RUNTIME_METADATA_SCHEMA_VERSION} but found ${String(parsed.schemaVersion)}`,
    );
  }
  assertProtocolVersion(parsed.protocolVersion, label);
  if (
    expectedProtocolVersion !== undefined &&
    parsed.protocolVersion !== expectedProtocolVersion
  ) {
    throw new Error(
      `${label} protocolVersion expected ${expectedProtocolVersion} but found ${parsed.protocolVersion}`,
    );
  }

  return Object.freeze({
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    protocolVersion: parsed.protocolVersion,
  });
}

function createRuntimeMetadata(protocolVersion) {
  assertProtocolVersion(protocolVersion, "runtime metadata");
  return {
    schemaVersion: RUNTIME_METADATA_SCHEMA_VERSION,
    protocolVersion,
  };
}

function assertProtocolVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} protocolVersion must be a positive safe integer`);
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
