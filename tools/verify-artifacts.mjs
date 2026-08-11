import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { createHeadArchiveBuffer } from "./archive-firefox-source.mjs";
import { parseRuntimeMetadata } from "./runtime-metadata.mjs";
import {
  assertTextEqual,
  assertVersion,
  compareAscii,
  normalizeArchivePath,
  rejectSensitivePath,
} from "./release-policy.mjs";

const VERSION = "0.3.0";
const EXPECTED_ARTIFACTS = new Map([
  [`browser2ide-vscode-${VERSION}.vsix`, "vscode"],
  [`browser2ide-chrome-${VERSION}.zip`, "chrome"],
  [`browser2ide-firefox-${VERSION}.zip`, "firefox"],
  [`browser2ide-firefox-source-${VERSION}.zip`, "firefox-source"],
]);
export const BROWSER_ARCHIVE_FILES = Object.freeze([
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "manifest.json",
  "dist/background.js",
  "dist/browser2ide.svg",
  "dist/contentScript.js",
  "dist/devtools.html",
  "dist/devtools.js",
  "dist/panel.css",
  "dist/panel.html",
  "dist/panel.js",
  "dist/runtime-metadata.json",
]);
export const VSIX_ARCHIVE_FILES = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES",
  "extension/dist/extension.cjs",
  "extension/dist/mappings.wasm",
  "extension/dist/runtime-metadata.json",
  "extension/package.json",
  "extension/readme.md",
  "extension/resources/browser2ide.svg",
]);
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_ARCHIVE_FILENAME_BYTES = 512 * 1024;
export const MAX_ARCHIVE_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectLicense = await readFile(resolve(repositoryRoot, "LICENSE"));
const extensionRequire = createRequire(
  resolve(repositoryRoot, "extensions/vscode/package.json"),
);
const vsceRequire = createRequire(
  extensionRequire.resolve("@vscode/vsce/package.json"),
);
const { Parser: XmlParser } = vsceRequire("xml2js");
const VSIX_MANIFEST_NAMESPACE =
  "http://schemas.microsoft.com/developer/vsx-schema/2011";
const VSIX_CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const REQUIRED_VSIX_CONTENT_TYPES = Object.freeze([
  Object.freeze([".cjs", "application/octet-stream"]),
  Object.freeze([".json", "application/json"]),
  Object.freeze([".md", "text/markdown"]),
  Object.freeze([".svg", "image/svg+xml"]),
  Object.freeze([".txt", "text/plain"]),
  Object.freeze([".vsixmanifest", "text/xml"]),
  Object.freeze([".wasm", "application/wasm"]),
]);

export async function verifyArtifacts(arguments_) {
  const artifacts = await collectArtifacts(arguments_);
  const missing = [...EXPECTED_ARTIFACTS.keys()].filter(
    (filename) => !artifacts.has(filename),
  );
  if (missing.length > 0) {
    throw new Error(`Missing required release artifacts: ${missing.join(", ")}`);
  }

  for (const [filename, kind] of EXPECTED_ARTIFACTS) {
    const archive = readArchive(artifacts.get(filename), filename);
    if (kind === "vscode") await verifyVsix(archive, filename);
    else if (kind === "firefox-source") await verifySource(archive, filename);
    else await verifyBrowser(archive, filename, kind);
    console.log(`Verified ${filename} (${archive.files.size} files)`);
  }
}

export function readArchive(path, filename) {
  let raw;
  let zip;
  try {
    const size = statSync(path).size;
    if (size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `${filename} exceeds the ${MAX_ARCHIVE_BYTES}-byte verification limit`,
      );
    }
    raw = readFileSync(path);
    preflightZipMetadata(raw, filename);
    zip = new AdmZip(raw);
  } catch (error) {
    throw new Error(`${filename} is not a readable ZIP archive: ${error.message}`);
  }

  const entries = zip.getEntries();
  assertArchiveDeclaredSizes(entries, filename);

  const files = new Map();
  const seen = new Set();
  const caseFolded = new Map();
  for (const entry of entries) {
    const name = normalizeArchivePath(entry.entryName, filename, entry.isDirectory);
    if (seen.has(name)) {
      throw new Error(`${filename} contains duplicate path ${name}`);
    }
    const folded = name.toLowerCase();
    const existing = caseFolded.get(folded);
    if (existing !== undefined && existing !== name) {
      throw new Error(
        `${filename} contains case-insensitive path collision: ${existing} and ${name}`,
      );
    }
    rejectZipSymlink(entry, name, filename);
    rejectSensitivePath(name, filename);
    seen.add(name);
    caseFolded.set(folded, name);
    if (!entry.isDirectory) files.set(name, entry.getData());
  }
  return { files, paths: [...seen].sort(compareAscii), raw };
}

export function preflightZipMetadata(
  raw,
  filename,
  {
    entryBudget = MAX_ARCHIVE_ENTRIES,
    filenameBudget = MAX_ARCHIVE_FILENAME_BYTES,
    centralDirectoryBudget = MAX_ARCHIVE_CENTRAL_DIRECTORY_BYTES,
  } = {},
) {
  if (!Buffer.isBuffer(raw) || raw.length < EOCD_MIN_BYTES) {
    throw new Error(`${filename} has no valid ZIP EOCD record`);
  }
  for (const [label, value] of [
    ["entry", entryBudget],
    ["filename", filenameBudget],
    ["central directory", centralDirectoryBudget],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${filename} has an invalid ${label} metadata budget`);
    }
  }

  const eocdOffset = findEocdOffset(raw);
  if (eocdOffset < 0) {
    throw new Error(`${filename} has no valid ZIP EOCD record`);
  }

  const diskNumber = raw.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = raw.readUInt16LE(eocdOffset + 6);
  const diskEntries = raw.readUInt16LE(eocdOffset + 8);
  const totalEntries = raw.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = raw.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = raw.readUInt32LE(eocdOffset + 16);
  if (
    diskEntries === 0xffff ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error(`${filename} uses unsupported ZIP64 metadata`);
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error(`${filename} uses an unsupported multi-disk ZIP layout`);
  }
  if (totalEntries > entryBudget) {
    throw new Error(
      `${filename} entry count ${totalEntries} exceeds ${entryBudget}-entry limit`,
    );
  }
  if (centralDirectorySize > centralDirectoryBudget) {
    throw new Error(
      `${filename} central directory ${centralDirectorySize} bytes exceeds ` +
        `${centralDirectoryBudget}-byte limit`,
    );
  }
  if (
    centralDirectoryOffset > eocdOffset ||
    centralDirectorySize !== eocdOffset - centralDirectoryOffset
  ) {
    throw new Error(`${filename} has invalid ZIP central directory bounds`);
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let cursor = centralDirectoryOffset;
  let filenameBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor > centralDirectoryEnd - 46 ||
      raw.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error(`${filename} has invalid ZIP central directory metadata`);
    }
    const filenameLength = raw.readUInt16LE(cursor + 28);
    const extraLength = raw.readUInt16LE(cursor + 30);
    const commentLength = raw.readUInt16LE(cursor + 32);
    const diskStart = raw.readUInt16LE(cursor + 34);
    if (diskStart !== 0) {
      throw new Error(`${filename} uses an unsupported multi-disk ZIP entry`);
    }
    if (filenameBytes > filenameBudget - filenameLength) {
      throw new Error(
        `${filename} filename metadata exceeds ${filenameBudget}-byte limit`,
      );
    }
    filenameBytes += filenameLength;
    const recordBytes = 46 + filenameLength + extraLength + commentLength;
    if (recordBytes > centralDirectoryEnd - cursor) {
      throw new Error(`${filename} has truncated ZIP central directory metadata`);
    }
    cursor += recordBytes;
  }
  if (cursor !== centralDirectoryEnd) {
    throw new Error(`${filename} has inconsistent ZIP central directory metadata`);
  }
  return {
    centralDirectoryBytes: centralDirectorySize,
    entries: totalEntries,
    filenameBytes,
  };
}

function findEocdOffset(raw) {
  const minimumOffset = Math.max(0, raw.length - EOCD_MIN_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let offset = raw.length - EOCD_MIN_BYTES; offset >= minimumOffset; offset -= 1) {
    if (raw.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = raw.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_BYTES + commentLength === raw.length) return offset;
  }
  return -1;
}

export function assertArchiveDeclaredSizes(
  entries,
  filename,
  {
    perEntryBudget = MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES,
    totalBudget = MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES,
  } = {},
) {
  let total = 0;
  for (const entry of entries) {
    const size = entry?.header?.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `${filename} entry ${String(entry?.entryName)} has invalid declared uncompressed size`,
      );
    }
    if (size > perEntryBudget) {
      throw new Error(
        `${filename} entry ${entry.entryName} declared uncompressed size ${size} exceeds ` +
        `${perEntryBudget}-byte per-entry limit`,
      );
    }
    if (total > totalBudget - size) {
      throw new Error(
        `${filename} total declared uncompressed size exceeds ${totalBudget}-byte limit`,
      );
    }
    total += size;
  }
  return total;
}

export function assertExactArchivePaths(archive, filename, expectedPaths) {
  const expected = new Set(expectedPaths);
  for (const path of [...expected].sort(compareAscii)) {
    if (!archive.paths.includes(path)) {
      throw new Error(`${filename} is missing archive path ${path}`);
    }
  }
  for (const path of archive.paths) {
    if (!expected.has(path)) {
      throw new Error(`${filename} contains unexpected archive path ${path}`);
    }
  }
  if (archive.paths.length !== expected.size) {
    throw new Error(`${filename} archive path set is not exact`);
  }
}

export function readHeadTree(root = repositoryRoot) {
  const output = runGit(root, ["ls-tree", "-rz", "--full-tree", "HEAD"]);
  const tree = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const record of splitNullTerminated(output)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("git ls-tree returned a malformed record");
    const metadata = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(metadata);
    if (!match) throw new Error(`git ls-tree returned malformed metadata: ${metadata}`);
    let path;
    try {
      path = decoder.decode(record.subarray(tab + 1));
    } catch {
      throw new Error("HEAD contains a path that is not valid UTF-8");
    }
    if (tree.has(path)) throw new Error(`HEAD contains duplicate path ${path}`);
    tree.set(path, { mode: match[1], type: match[2], object: match[3] });
  }
  return tree;
}

export async function verifySourceAgainstHead(
  archive,
  filename,
  head,
  blobReader,
) {
  const folded = new Map();
  for (const [path, entry] of head) {
    if (!REGULAR_GIT_MODES.has(entry.mode) || entry.type !== "blob") {
      throw new Error(
        `${filename} has unsupported HEAD entry mode ${entry.mode} (${entry.type}) at ${path}`,
      );
    }
    const key = path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined && existing !== path) {
      throw new Error(`HEAD contains case-insensitive path collision: ${existing} and ${path}`);
    }
    folded.set(key, path);
  }

  assertExactArchivePaths(archive, filename, expectedGitArchivePaths(head.keys()));
  const readBlob = blobReader ?? ((object) => readHeadBlob(repositoryRoot, object));
  for (const [path, entry] of head) {
    const expected = await readBlob(entry.object, path);
    const actual = archive.files.get(path);
    if (!Buffer.isBuffer(expected)) {
      throw new Error(`HEAD blob reader did not return a Buffer for ${path}`);
    }
    if (!actual?.equals(expected)) {
      throw new Error(`${filename} differs from HEAD blob ${path}`);
    }
  }
}

export function verifySourceArchiveIdentity(
  archive,
  filename,
  root = repositoryRoot,
) {
  const expected = createHeadArchiveBuffer(root);
  if (!archive.raw.equals(expected)) {
    throw new Error(
      `${filename} is not byte-for-byte identical to git archive HEAD`,
    );
  }
}

async function collectArtifacts(arguments_) {
  if (arguments_.length === 0) {
    throw new Error(
      "Usage: node tools/verify-artifacts.mjs <artifact-directory|artifact-path> [...]",
    );
  }

  const paths = new Map();
  for (const argument of arguments_) {
    const path = resolve(process.cwd(), argument);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      throw new Error(`Artifact path does not exist: ${path}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Artifact path must not be a symbolic link: ${path}`);
    }
    if (stats.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === "SHA256SUMS") continue;
        if (!entry.isFile()) {
          throw new Error(`Unexpected non-file artifact entry: ${entry.name}`);
        }
        addArtifact(paths, entry.name, resolve(path, entry.name));
      }
    } else if (stats.isFile()) {
      addArtifact(paths, filenameFromPath(path), path);
    } else {
      throw new Error(`Artifact path is not a regular file or directory: ${path}`);
    }
  }
  return paths;
}

function addArtifact(paths, filename, path) {
  if (!EXPECTED_ARTIFACTS.has(filename)) {
    throw new Error(`Unexpected release artifact: ${filename}`);
  }
  if (paths.has(filename)) {
    throw new Error(`Release artifact was provided more than once: ${filename}`);
  }
  paths.set(filename, path);
}

function filenameFromPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

async function verifyBrowser(archive, filename, browser) {
  assertExactArchivePaths(archive, filename, BROWSER_ARCHIVE_FILES);
  assertProjectLicense(archive, filename, "LICENSE");
  const noticePath = resolve(repositoryRoot, "extensions", browser, "THIRD_PARTY_NOTICES");
  assertEqualFile(
    archive,
    filename,
    "THIRD_PARTY_NOTICES",
    await readFile(noticePath),
  );

  verifyBrowserManifest(
    parseJsonFile(archive, filename, "manifest.json"),
    filename,
    browser,
  );
  parseRuntimeMetadata(archive.files.get("dist/runtime-metadata.json"), {
    expectedProtocolVersion: 5,
    label: `${filename} runtime metadata`,
  });
}

function verifyBrowserManifest(manifest, filename, browser) {
  if (manifest.manifest_version !== 3) {
    throw new Error(`${filename} has unexpected manifest_version`);
  }
  if (manifest.name !== "Browser2IDE") {
    throw new Error(`${filename} has unexpected manifest name`);
  }
  assertVersion(manifest.version, `${filename} manifest`, VERSION);
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes("<all_urls>")) {
    throw new Error(`${filename} manifest must request <all_urls>`);
  }
  const forbiddenHosts = manifest.host_permissions.filter((value) =>
    typeof value === "string" && /^wss?:\/\//i.test(value)
  );
  if (forbiddenHosts.length > 0) {
    throw new Error(`${filename} has forbidden WebSocket host_permissions: ${forbiddenHosts.join(", ")}`);
  }
  if (browser === "chrome" && manifest.minimum_chrome_version !== "116") {
    throw new Error(`${filename} has unexpected minimum_chrome_version`);
  }
  if (
    browser === "firefox" &&
    manifest.browser_specific_settings?.gecko?.strict_min_version !== "142.0"
  ) {
    throw new Error(`${filename} has unexpected Firefox strict_min_version`);
  }
}

async function verifyVsix(archive, filename) {
  validateVsixArchive(archive, filename);

  const require = createRequire(import.meta.url);
  const sourceMapRoot = dirname(require.resolve("source-map/package.json", {
    paths: [resolve(repositoryRoot, "extensions/vscode")],
  }));
  assertEqualFile(
    archive,
    filename,
    "extension/dist/mappings.wasm",
    await readFile(resolve(sourceMapRoot, "lib/mappings.wasm")),
  );
  assertEqualFile(
    archive,
    filename,
    "extension/THIRD_PARTY_NOTICES",
    await readFile(resolve(repositoryRoot, "extensions/vscode/THIRD_PARTY_NOTICES")),
  );
}

export function validateVsixArchive(archive, filename) {
  assertExactArchivePaths(archive, filename, VSIX_ARCHIVE_FILES);
  assertProjectLicense(archive, filename, "extension/LICENSE.txt");

  const manifest = parseJsonFile(archive, filename, "extension/package.json");
  if (manifest.publisher !== "browser2ide") {
    throw new Error(`${filename} has unexpected extension publisher`);
  }
  if (manifest.name !== "browser2ide-vscode") {
    throw new Error(`${filename} has unexpected extension name`);
  }
  assertVersion(manifest.version, `${filename} extension`, VERSION);
  if (manifest.main !== "./dist/extension.cjs") {
    throw new Error(`${filename} has unexpected extension main: ${manifest.main}`);
  }
  validateVsixXmlMetadata(archive, filename, manifest);
  parseRuntimeMetadata(
    archive.files.get("extension/dist/runtime-metadata.json"),
    {
      expectedProtocolVersion: 5,
      label: `${filename} runtime metadata`,
    },
  );

  const bundle = archive.files.get("extension/dist/extension.cjs").toString("utf8");
  if (!bundle.includes("source-navigation")) {
    throw new Error(
      `${filename} VSIX bundle is missing current source-navigation capability`,
    );
  }
  for (const type of ["source.navigate", "source.navigationState"]) {
    if (!bundle.includes(type)) {
      throw new Error(`${filename} VSIX bundle is missing current ${type} message`);
    }
  }
  const runtimeRequires = [
    ...bundle.matchAll(/\brequire\((["'])([^"'.\/][^"']*)\1\)/g),
  ].map((match) => match[2]);
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);
  const unsupported = [...new Set(runtimeRequires)]
    .filter((name) => name !== "vscode" && !builtins.has(name))
    .sort(compareAscii);
  if (unsupported.length > 0) {
    throw new Error(`${filename} has external runtime packages: ${unsupported.join(", ")}`);
  }
  if (!runtimeRequires.includes("vscode")) {
    throw new Error(`${filename} does not declare the vscode runtime external`);
  }
  return manifest;
}

function validateVsixXmlMetadata(archive, filename, manifest) {
  const manifestDocument = parseXmlFile(
    archive,
    filename,
    "extension.vsixmanifest",
  );
  const packageManifest = requireXmlRoot(
    manifestDocument,
    "PackageManifest",
    filename,
    "extension.vsixmanifest",
  );
  assertXmlAttribute(
    packageManifest,
    "xmlns",
    VSIX_MANIFEST_NAMESPACE,
    filename,
    "extension.vsixmanifest",
  );
  assertXmlAttribute(
    packageManifest,
    "Version",
    "2.0.0",
    filename,
    "extension.vsixmanifest",
  );
  const metadata = requireSingleXmlChild(
    packageManifest,
    "Metadata",
    filename,
    "extension.vsixmanifest",
  );
  const identity = requireSingleXmlChild(
    metadata,
    "Identity",
    filename,
    "extension.vsixmanifest",
  );
  for (const [attribute, field, label] of [
    ["Publisher", "publisher", "publisher"],
    ["Id", "name", "name"],
    ["Version", "version", "version"],
  ]) {
    const value = requireXmlAttribute(
      identity,
      attribute,
      filename,
      "extension.vsixmanifest",
    );
    if (value !== manifest[field]) {
      throw new Error(
        `${filename} extension.vsixmanifest ${label} ${value} does not match ` +
          "extension/package.json",
      );
    }
  }

  const contentTypesDocument = parseXmlFile(
    archive,
    filename,
    "[Content_Types].xml",
  );
  const types = requireXmlRoot(
    contentTypesDocument,
    "Types",
    filename,
    "[Content_Types].xml",
  );
  assertXmlAttribute(
    types,
    "xmlns",
    VSIX_CONTENT_TYPES_NAMESPACE,
    filename,
    "[Content_Types].xml",
  );
  const declarations = new Map();
  for (const declaration of types.Default ?? []) {
    const extension = requireXmlAttribute(
      declaration,
      "Extension",
      filename,
      "[Content_Types].xml Default",
    );
    const contentType = requireXmlAttribute(
      declaration,
      "ContentType",
      filename,
      "[Content_Types].xml Default",
    );
    if (declarations.has(extension)) {
      throw new Error(
        `${filename} [Content_Types].xml has duplicate declaration for ${extension}`,
      );
    }
    declarations.set(extension, contentType);
  }
  for (const [extension, expectedContentType] of REQUIRED_VSIX_CONTENT_TYPES) {
    const actualContentType = declarations.get(extension);
    if (actualContentType === undefined) {
      throw new Error(
        `${filename} [Content_Types].xml is missing required ${extension} ` +
          `content type ${expectedContentType}`,
      );
    }
    if (actualContentType !== expectedContentType) {
      throw new Error(
        `${filename} [Content_Types].xml declares ${extension} as ${actualContentType}; ` +
          `expected ${expectedContentType}`,
      );
    }
  }
}

function parseXmlFile(archive, filename, path) {
  const parser = new XmlParser({
    async: false,
    explicitArray: true,
    explicitRoot: true,
    strict: true,
  });
  const doctypeError = new Error(
    `${filename} ${path} must not contain a DOCTYPE declaration`,
  );
  parser.saxParser.ondoctype = () => {
    throw doctypeError;
  };

  let parseError;
  let document;
  parser.parseString(archive.files.get(path), (error, result) => {
    parseError = error;
    document = result;
  });
  if (parseError === doctypeError) throw doctypeError;
  if (parseError !== undefined && parseError !== null) {
    throw new Error(
      `${filename} contains invalid XML in ${path}: ${parseError.message}`,
    );
  }
  if (document === undefined || document === null) {
    throw new Error(`${filename} contains invalid XML in ${path}: empty document`);
  }
  return document;
}

function requireXmlRoot(document, name, filename, path) {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    typeof document[name] !== "object" ||
    document[name] === null ||
    Array.isArray(document[name])
  ) {
    throw new Error(`${filename} ${path} must contain one ${name} root element`);
  }
  return document[name];
}

function requireSingleXmlChild(element, name, filename, path) {
  const children = element?.[name];
  if (
    !Array.isArray(children) ||
    children.length !== 1 ||
    typeof children[0] !== "object" ||
    children[0] === null ||
    Array.isArray(children[0])
  ) {
    throw new Error(`${filename} ${path} must contain one ${name} element`);
  }
  return children[0];
}

function requireXmlAttribute(element, name, filename, path) {
  const value = element?.$?.[name];
  if (typeof value !== "string") {
    throw new Error(`${filename} ${path} is missing ${name} attribute`);
  }
  return value;
}

function assertXmlAttribute(element, name, expected, filename, path) {
  const actual = requireXmlAttribute(element, name, filename, path);
  if (actual !== expected) {
    throw new Error(
      `${filename} ${path} has unexpected ${name} attribute: ${actual}`,
    );
  }
}

async function verifySource(archive, filename) {
  await verifySourceAgainstHead(archive, filename, readHeadTree(repositoryRoot));
  verifySourceArchiveIdentity(archive, filename, repositoryRoot);
  assertProjectLicense(archive, filename, "LICENSE");

  const rootManifest = parseJsonFile(archive, filename, "package.json");
  assertVersion(rootManifest.version, `${filename} root package`, VERSION);
  if (
    rootManifest.packageManager !== "pnpm@9.15.0" ||
    rootManifest.devDependencies?.["adm-zip"] !== "0.5.16" ||
    rootManifest.devDependencies?.["web-ext"] !== "10.4.0"
  ) {
    throw new Error(`${filename} has unexpected root packaging dependencies`);
  }
  for (const script of [
    "package:vscode",
    "package:chrome",
    "package:firefox",
    "package:firefox-source",
    "artifacts:verify",
    "artifacts:checksums",
  ]) {
    if (typeof rootManifest.scripts?.[script] !== "string") {
      throw new Error(`${filename} is missing root script ${script}`);
    }
  }
  const firefoxPackage = parseJsonFile(
    archive,
    filename,
    "extensions/firefox/package.json",
  );
  assertVersion(firefoxPackage.version, `${filename} Firefox package`, VERSION);
  if (typeof firefoxPackage.scripts?.package !== "string") {
    throw new Error(`${filename} is missing the Firefox package script`);
  }
  verifyBrowserManifest(
    parseJsonFile(archive, filename, "extensions/firefox/manifest.json"),
    filename,
    "firefox",
  );
}

function rejectZipSymlink(entry, path, filename) {
  const unixMode = ((entry.attr >>> 0) >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`${filename} contains symbolic link entry ${path}`);
  }
}

function expectedGitArchivePaths(paths) {
  const expected = new Set();
  for (const path of paths) {
    expected.add(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expected.add(parts.slice(0, index).join("/"));
    }
  }
  return expected;
}

function splitNullTerminated(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new Error("git ls-tree output was not NUL terminated");
  }
  return records;
}

function readHeadBlob(root, object) {
  return runGit(root, ["cat-file", "blob", object]);
}

function runGit(root, arguments_) {
  const portableRoot = resolve(root).replaceAll("\\", "/");
  const result = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${portableRoot}`,
      "-C",
      portableRoot,
      ...arguments_,
    ],
    { encoding: null, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${arguments_[0]} failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

function parseJsonFile(archive, filename, path) {
  try {
    return JSON.parse(archive.files.get(path).toString("utf8"));
  } catch (error) {
    throw new Error(`${filename} contains invalid JSON in ${path}: ${error.message}`);
  }
}

function assertProjectLicense(archive, filename, path) {
  try {
    assertTextEqual(
      archive.files.get(path).toString("utf8"),
      projectLicense.toString("utf8"),
    );
  } catch {
    throw new Error(`${filename} contains unexpected content in ${path}`);
  }
}

function assertEqualFile(archive, filename, path, expected) {
  if (!archive.files.get(path).equals(expected)) {
    throw new Error(`${filename} contains unexpected content in ${path}`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await verifyArtifacts(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
