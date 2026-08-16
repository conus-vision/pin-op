import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertAsciiFilename, compareAscii } from "./release-policy.mjs";

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function parseChecksumManifest(source) {
  if (source.includes("\r")) {
    throw new Error("Checksum manifest must use LF line endings");
  }
  const entries = new Map();
  for (const line of source.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  ([\x20-\x7e]+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid checksum line: ${line}`);
    }
    const [, hash, filename] = match;
    assertAsciiFilename(filename);
    if (filename.includes("/") || filename.includes("\\") || entries.has(filename)) {
      throw new Error(`Invalid or duplicate checksum filename: ${filename}`);
    }
    entries.set(filename, hash);
  }
  return entries;
}

export function assertPublicationChecksumManifest(source, version) {
  const entries = parseChecksumManifest(source);
  const actualNames = [...entries.keys()].sort(compareAscii);
  const expectedNames = expectedReleaseAssetNames(version, true).filter(
    (name) => name !== "SHA256SUMS",
  );
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Publication checksum asset set differs: ${actualNames.join(", ")}`,
    );
  }
  return entries;
}

export async function verifyPublicationChecksumDirectory(directory, version) {
  const manifestPath = resolve(directory, "SHA256SUMS");
  await assertRegularFile(manifestPath, "publication SHA256SUMS");
  const manifestBytes = await readFile(manifestPath);
  const entries = assertPublicationChecksumManifest(manifestBytes.toString("utf8"), version);
  const artifacts = [];

  for (const name of [...entries.keys()].sort(compareAscii)) {
    const artifactPath = resolve(directory, name);
    await assertRegularFile(artifactPath, `publication ${name}`);
    const actualSha256 = sha256(await readFile(artifactPath));
    if (actualSha256 !== entries.get(name)) {
      throw new Error(`${name} checksum differs from SHA256SUMS`);
    }
    artifacts.push({ name, sha256: actualSha256 });
  }

  return {
    checksumManifestSha256: sha256(manifestBytes),
    artifacts,
  };
}

export function assertReleaseAssets(release, version, checksumSource, expectedDatabaseId) {
  return assertDraftReleaseAssets(
    release,
    version,
    checksumSource,
    true,
    expectedDatabaseId,
  );
}

export function assertUnsignedReleaseAssets(
  release,
  version,
  checksumSource,
  expectedDatabaseId,
) {
  return assertDraftReleaseAssets(
    release,
    version,
    checksumSource,
    false,
    expectedDatabaseId,
  );
}

export async function compareReleaseArtifactDirectories(
  phase,
  version,
  releaseDirectory,
  rebuildDirectory,
  scope = "all",
) {
  const includeSignedXpi = phase === "signed";
  if (!includeSignedXpi && phase !== "unsigned") {
    throw new Error(`Invalid release comparison phase: ${phase}`);
  }
  if (!["all", "unsigned-artifacts"].includes(scope)) {
    throw new Error(`Invalid release comparison scope: ${scope}`);
  }

  let names = expectedReleaseAssetNames(version, includeSignedXpi);
  if (scope === "unsigned-artifacts") {
    names = names.filter((name) => name !== "SHA256SUMS" && !name.endsWith(".xpi"));
  }
  for (const name of names) {
    const releasePath = resolve(releaseDirectory, name);
    const rebuildPath = resolve(rebuildDirectory, name);
    await assertRegularFile(releasePath, `release ${name}`);
    await assertRegularFile(rebuildPath, `rebuilt ${name}`);
    const [releaseBytes, rebuildBytes] = await Promise.all([
      readFile(releasePath),
      readFile(rebuildPath),
    ]);
    if (!releaseBytes.equals(rebuildBytes)) {
      throw new Error(`${name} differs between release and rebuild`);
    }
  }
}

export function assertPublicationRelease(release, version, expected) {
  const releaseDatabaseId = parseNumericRestId(release?.id, "Release", "release");
  const expectedDatabaseId = parseReleaseDatabaseId(expected?.expectedDatabaseId);
  if (releaseDatabaseId !== expectedDatabaseId) {
    throw new Error(
      `Release database id differs: expected ${expectedDatabaseId}, received ${releaseDatabaseId}`,
    );
  }
  if (release?.tag_name !== expected?.expectedTag) {
    throw new Error("Release tag differs from the verified publication tag");
  }
  if (release?.target_commitish !== expected?.expectedTarget) {
    throw new Error("Release target differs from the verified publication target");
  }
  if (
    typeof expected?.expectedDraft !== "boolean" ||
    release?.draft !== expected.expectedDraft
  ) {
    throw new Error("Release draft state differs from the required publication state");
  }
  if (expected.expectedDraft === false && release?.immutable !== true) {
    throw new Error("Published release must be immutable");
  }
  if (!Array.isArray(release?.assets)) {
    throw new Error("Publication release assets must be an array");
  }

  const assets = release.assets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error("Publication release contains invalid asset metadata");
    }
    const id = parseNumericRestId(asset.id, "Release asset", "asset");
    if (
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    ) {
      throw new Error("Release asset size must be a positive safe integer");
    }
    if (asset.state !== "uploaded") {
      throw new Error("Release asset must be fully uploaded");
    }
    return { id, name: asset.name, size: asset.size };
  });
  assets.sort((left, right) => compareAscii(left.name, right.name));
  const actualNames = assets.map(({ name }) => name);
  const expectedNames = expectedReleaseAssetNames(version, true);
  if (
    actualNames.some((name) => typeof name !== "string") ||
    new Set(actualNames).size !== actualNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(`Publication release asset set differs: ${actualNames.join(", ")}`);
  }
  if (new Set(assets.map(({ id }) => id)).size !== assets.length) {
    throw new Error("Publication release contains duplicate numeric asset ids");
  }

  return {
    releaseDatabaseId,
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    assets,
  };
}

function assertDraftReleaseAssets(
  release,
  version,
  checksumSource,
  includeSignedXpi,
  expectedDatabaseId,
) {
  if (release?.isDraft !== true) {
    throw new Error("Firefox signing release must still be a draft");
  }
  const databaseId = parseReleaseDatabaseId(release.databaseId);
  if (
    expectedDatabaseId !== undefined &&
    databaseId !== parseReleaseDatabaseId(expectedDatabaseId)
  ) {
    throw new Error(
      `Release database id differs: expected ${expectedDatabaseId}, received ${databaseId}`,
    );
  }
  const expected = expectedReleaseAssetNames(version, includeSignedXpi);
  if (!Array.isArray(release.assets)) {
    throw new Error("Release assets must be an array");
  }
  const actual = release.assets.map(({ name } = {}) => name).sort(compareAscii);
  if (actual.some((name) => typeof name !== "string")) {
    throw new Error("Release assets contain an invalid name");
  }
  const phase = includeSignedXpi ? "signed" : "unsigned";
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${phase} draft asset set differs: ${actual.join(", ")}`);
  }
  const checksumNames = [...parseChecksumManifest(checksumSource).keys()].sort(compareAscii);
  const expectedChecksums = expected.filter((name) => name !== "SHA256SUMS");
  if (JSON.stringify(checksumNames) !== JSON.stringify(expectedChecksums)) {
    throw new Error(`${phase} checksum asset set differs: ${checksumNames.join(", ")}`);
  }
  return databaseId;
}

function expectedReleaseAssetNames(version, includeSignedXpi) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Release version must match X.Y.Z, received ${version}`);
  }
  return [
    "SHA256SUMS",
    `pin-op-chrome-${version}.zip`,
    `pin-op-firefox-${version}.zip`,
    `pin-op-firefox-source-${version}.zip`,
    `pin-op-vscode-${version}.vsix`,
    ...(includeSignedXpi ? [`pin-op-firefox-${version}.xpi`] : []),
  ].sort(compareAscii);
}

function parseReleaseDatabaseId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Release database id must be a positive safe integer");
    }
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  throw new Error("Release database id must be a positive integer");
}

function parseNumericRestId(value, label, kind) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must have a positive numeric ${kind} id`);
  }
  return String(value);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function assertRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`Missing ${label}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}
