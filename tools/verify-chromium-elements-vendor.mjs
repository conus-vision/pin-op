import {
  lstat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCompleteRootBsdLicense,
  CHROMIUM_REPOSITORY,
  expectedDerivedTargets,
  extractEmbeddedNotices,
  PINNED_LICENSE_SHA256,
  PINNED_REVISION,
  sha256,
  UPSTREAM_PATHS,
  validateRevision,
} from "./vendor-chromium-elements.mjs";
import {
  assertConfinedPath,
  readConfinedFile,
  resolvePhysicalRepositoryRoot,
} from "./chromium-vendor-paths.mjs";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const VENDOR_RELATIVE_PATH = path.join("third_party", "chromium-devtools-frontend");
const MANIFEST_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "UPSTREAM.json");
const CHANGES_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "PIN_OP_CHANGES.md");
const UPSTREAM_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "upstream");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertLowercaseSha256(value, description) {
  if (!LOWERCASE_SHA256.test(value)) {
    throw new Error(`${description} must be 64 lowercase hexadecimal characters`);
  }
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) {
    return false;
  }
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

function normalizedNoticeText(value) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function assertDerivedMapping(upstreamPath, actualTargets) {
  if (!Array.isArray(actualTargets)) {
    throw new Error(`unexpected derived target mapping for ${upstreamPath}`);
  }
  const expectedTargets = expectedDerivedTargets(upstreamPath);
  if (actualTargets.length !== expectedTargets.length) {
    throw new Error(`unexpected derived target mapping for ${upstreamPath}`);
  }
  for (let index = 0; index < expectedTargets.length; index += 1) {
    const actual = actualTargets[index];
    const expected = expectedTargets[index];
    if (
      !isRecord(actual) ||
      actual.path !== expected.path ||
      actual.changeRecord !== expected.changeRecord
    ) {
      throw new Error(`unexpected derived target mapping for ${upstreamPath}`);
    }
    if (actual.localSha256 !== "pending") {
      assertLowercaseSha256(
        actual.localSha256,
        `derived target digest for ${actual.path}`,
      );
    }
  }
}

export function validateManifestStructure(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("Chromium UPSTREAM.json must contain an object");
  }
  if (manifest.repository !== CHROMIUM_REPOSITORY) {
    throw new Error(`Unexpected Chromium repository: ${manifest.repository}`);
  }
  validateRevision(manifest.revision);
  if (
    typeof manifest.importedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(manifest.importedAt)
  ) {
    throw new Error("Chromium manifest import date must use YYYY-MM-DD");
  }
  if (manifest.license !== "LICENSE") {
    throw new Error("Chromium manifest must reference the root LICENSE file");
  }
  assertLowercaseSha256(manifest.licenseSha256, "root BSD license digest");
  if (manifest.licenseSha256 !== PINNED_LICENSE_SHA256) {
    throw new Error("pinned root BSD license SHA-256 mismatch");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Chromium manifest files must be an array");
  }

  const manifestPaths = manifest.files.map((source) => source?.upstreamPath);
  if (
    manifestPaths.some((upstreamPath) => typeof upstreamPath !== "string") ||
    !sameStringSet(manifestPaths, UPSTREAM_PATHS)
  ) {
    throw new Error("Chromium manifest must contain exactly the allowlisted upstream paths");
  }

  for (const source of manifest.files) {
    if (!isRecord(source)) {
      throw new Error("Chromium source entries must be objects");
    }
    assertLowercaseSha256(source.sha256, `upstream digest for ${source.upstreamPath}`);
    if (!Array.isArray(source.embeddedNotices) || source.embeddedNotices.length === 0) {
      throw new Error(`embedded notice inventory mismatch for ${source.upstreamPath}`);
    }
    const noticeHashes = new Set();
    for (const notice of source.embeddedNotices) {
      if (!isRecord(notice) || typeof notice.text !== "string" || notice.text.length === 0) {
        throw new Error(`invalid embedded notice record for ${source.upstreamPath}`);
      }
      if (normalizedNoticeText(notice.text) !== notice.text) {
        throw new Error(`embedded notice text is not normalized for ${source.upstreamPath}`);
      }
      assertLowercaseSha256(
        notice.sha256,
        `embedded notice digest for ${source.upstreamPath}`,
      );
      if (sha256(notice.text) !== notice.sha256) {
        throw new Error(`embedded notice SHA-256 mismatch for ${source.upstreamPath}`);
      }
      if (noticeHashes.has(notice.sha256)) {
        throw new Error(`duplicate embedded notice for ${source.upstreamPath}`);
      }
      noticeHashes.add(notice.sha256);
    }
    assertDerivedMapping(source.upstreamPath, source.derivedTargets);
  }

  const distinctNoticeTexts = new Map(
    manifest.files
      .flatMap(({ embeddedNotices }) => embeddedNotices)
      .map((notice) => [notice.sha256, notice.text]),
  );
  if (![...distinctNoticeTexts.values()].some((text) => /Apple[\s\S]*Joseph Pecoraro/.test(text))) {
    throw new Error("embedded notice inventory is missing the Apple/Joseph Pecoraro BSD notice");
  }
  return manifest;
}

async function readRequiredFile(physicalRoot, repositoryRelativePath, missingMessage) {
  try {
    const targetPath = await assertConfinedPath(physicalRoot, repositoryRelativePath);
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      throw new Error(missingMessage);
    }
    return await readConfinedFile(physicalRoot, repositoryRelativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(missingMessage, { cause: error });
    }
    throw error;
  }
}

async function readManifest(physicalRoot) {
  let contents;
  try {
    contents = await readConfinedFile(
      physicalRoot,
      MANIFEST_RELATIVE_PATH,
      "utf8",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("missing Chromium UPSTREAM.json manifest", { cause: error });
    }
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error("Chromium UPSTREAM.json is not valid JSON", { cause: error });
  }
}

function decodeUtf8(bytes, description) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8`, { cause: error });
  }
}

async function listRelativeFiles(
  physicalRoot,
  rootRelativePath,
  relativePath = "",
) {
  const directoryRelativePath = path.join(rootRelativePath, relativePath);
  const directoryPath = await assertConfinedPath(
    physicalRoot,
    directoryRelativePath,
  );
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
    await assertConfinedPath(physicalRoot, directoryRelativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("missing Chromium upstream snapshot", { cause: error });
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const childRelativePath = relativePath
      ? path.join(relativePath, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(
        physicalRoot,
        rootRelativePath,
        childRelativePath,
      ));
    } else if (entry.isFile()) {
      files.push(childRelativePath.split(path.sep).join("/"));
    } else {
      throw new Error(`Chromium upstream snapshot contains a non-file entry: ${childRelativePath}`);
    }
  }
  return files;
}

function anchorForChangeRecord(changeRecord) {
  const match = /^PIN_OP_CHANGES\.md#([a-z0-9-]+)$/.exec(changeRecord);
  if (!match) {
    throw new Error(`unexpected change-record reference: ${changeRecord}`);
  }
  return match[1];
}

function assertChangeRecordAnchor(changesText, changeRecord) {
  const anchor = anchorForChangeRecord(changeRecord);
  const expectedDoubleQuoted = `<a id="${anchor}"></a>`;
  const expectedSingleQuoted = `<a id='${anchor}'></a>`;
  if (!changesText.includes(expectedDoubleQuoted) && !changesText.includes(expectedSingleQuoted)) {
    throw new Error(`missing change-record anchor ${anchor} in PIN_OP_CHANGES.md`);
  }
}

async function targetState(physicalRoot, repositoryRelativePath) {
  try {
    const targetPath = await assertConfinedPath(physicalRoot, repositoryRelativePath);
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      throw new Error(`derived target is not a regular file: ${repositoryRelativePath}`);
    }
    return {
      exists: true,
      bytes: await readConfinedFile(physicalRoot, repositoryRelativePath),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

export async function verifyVendor(
  repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  { requireComplete = false } = {},
) {
  const physicalRoot = await resolvePhysicalRepositoryRoot(repositoryRoot);
  const manifest = validateManifestStructure(await readManifest(physicalRoot));

  const licenseBytes = await readRequiredFile(
    physicalRoot,
    path.join(VENDOR_RELATIVE_PATH, manifest.license),
    "missing root BSD license",
  );
  if (sha256(licenseBytes) !== manifest.licenseSha256) {
    throw new Error("root BSD license SHA-256 mismatch");
  }
  const licenseText = decodeUtf8(licenseBytes, "Chromium root BSD license");
  assertCompleteRootBsdLicense(licenseText);

  const actualSnapshotPaths = (
    await listRelativeFiles(physicalRoot, UPSTREAM_RELATIVE_PATH)
  ).sort();
  if (!sameStringSet(actualSnapshotPaths, UPSTREAM_PATHS)) {
    throw new Error("Chromium snapshot must contain exactly the allowlisted upstream paths");
  }

  const changesBytes = await readRequiredFile(
    physicalRoot,
    CHANGES_RELATIVE_PATH,
    "missing PIN_OP_CHANGES.md",
  );
  const changesText = decodeUtf8(changesBytes, "PIN_OP_CHANGES.md");

  for (const source of manifest.files) {
    const upstreamPath = path.join(
      UPSTREAM_RELATIVE_PATH,
      ...source.upstreamPath.split("/"),
    );
    const upstreamBytes = await readRequiredFile(
      physicalRoot,
      upstreamPath,
      `missing upstream source ${source.upstreamPath}`,
    );
    if (sha256(upstreamBytes) !== source.sha256) {
      throw new Error(`Upstream SHA-256 mismatch for ${source.upstreamPath}`);
    }
    const sourceText = decodeUtf8(upstreamBytes, source.upstreamPath);
    const actualNotices = extractEmbeddedNotices(sourceText);
    if (JSON.stringify(actualNotices) !== JSON.stringify(source.embeddedNotices)) {
      throw new Error(`embedded notice inventory mismatch for ${source.upstreamPath}`);
    }

    for (const target of source.derivedTargets) {
      assertChangeRecordAnchor(changesText, target.changeRecord);
      const state = await targetState(physicalRoot, target.path);
      if (state.exists && target.localSha256 === "pending") {
        throw new Error(`existing derived target ${target.path} cannot remain pending`);
      }
      if (!state.exists && target.localSha256 !== "pending") {
        throw new Error(`missing derived target ${target.path} cannot retain a digest`);
      }
      if (!state.exists && requireComplete) {
        throw new Error(`incomplete derived target ${target.path}`);
      }
      if (
        state.exists &&
        target.localSha256 !== "pending" &&
        sha256(state.bytes) !== target.localSha256
      ) {
        throw new Error(`derived target SHA-256 mismatch for ${target.path}`);
      }
    }
  }
  return manifest;
}

function parseArguments(argv) {
  if (argv.length === 0) {
    return { requireComplete: false };
  }
  if (argv.length === 1 && argv[0] === "--require-complete") {
    return { requireComplete: true };
  }
  throw new Error(
    "Usage: node tools/verify-chromium-elements-vendor.mjs [--require-complete]",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = await verifyVendor(repositoryRoot, options);
    console.log(
      `Verified ${manifest.files.length} pinned Chromium Elements files${
        options.requireComplete ? " with complete derivations" : ""
      }.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
