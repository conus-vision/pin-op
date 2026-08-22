import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertConfinedPath,
  readConfinedFile,
  removeConfinedDirectoryTree,
  resolvePhysicalRepositoryRoot,
  writeConfinedFileAtomically,
} from "./chromium-vendor-paths.mjs";

export const PINNED_REVISION = "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280";
export const PINNED_LICENSE_SHA256 =
  "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e";
export const CHROMIUM_REPOSITORY =
  "https://github.com/ChromeDevTools/devtools-frontend.git";
export const RAW_GITHUB_ORIGIN = "https://raw.githubusercontent.com";
export const UPSTREAM_PATHS = Object.freeze([
  "front_end/panels/elements/ElementsTreeOutline.ts",
  "front_end/panels/elements/ElementsTreeElement.ts",
  "front_end/panels/elements/StylesSidebarPane.ts",
  "front_end/panels/elements/StylePropertiesSection.ts",
  "front_end/panels/elements/StylePropertyTreeElement.ts",
  "front_end/panels/elements/PropertyRenderer.ts",
  "front_end/panels/elements/StylePropertyUtils.ts",
  "front_end/panels/elements/elementsTreeOutline.css",
  "front_end/panels/elements/stylesSidebarPane.css",
  "front_end/panels/elements/stylePropertiesTreeOutline.css",
]);

const LICENSE_UPSTREAM_PATH = "LICENSE";
const RAW_REPOSITORY_PREFIX = "/ChromeDevTools/devtools-frontend/";
const VENDOR_RELATIVE_PATH = path.join("third_party", "chromium-devtools-frontend");
const UPSTREAM_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "upstream");
const ALLOWED_DOWNLOAD_PATHS = new Set([LICENSE_UPSTREAM_PATH, ...UPSTREAM_PATHS]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DERIVED_TARGETS = new Map([
  [
    "front_end/panels/elements/ElementsTreeOutline.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
    }],
  ],
  [
    "front_end/panels/elements/ElementsTreeElement.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
    }],
  ],
  [
    "front_end/panels/elements/StylesSidebarPane.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylesSidebarPane.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
    }],
  ],
  [
    "front_end/panels/elements/StylePropertiesSection.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertiesSection.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
    }],
  ],
  [
    "front_end/panels/elements/StylePropertyTreeElement.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
    }],
  ],
  [
    "front_end/panels/elements/PropertyRenderer.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/rules/PropertyRenderer.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
    }],
  ],
  [
    "front_end/panels/elements/StylePropertyUtils.ts",
    [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyUtils.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
    }],
  ],
  ...[
    "front_end/panels/elements/elementsTreeOutline.css",
    "front_end/panels/elements/stylesSidebarPane.css",
    "front_end/panels/elements/stylePropertiesTreeOutline.css",
  ].map((upstreamPath) => [
    upstreamPath,
    [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
    }],
  ]),
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateRevision(revision) {
  if (revision !== PINNED_REVISION) {
    throw new Error(
      `Expected --revision to equal the exact pinned Chromium revision ${PINNED_REVISION}`,
    );
  }
  return revision;
}

export function expectedDerivedTargets(upstreamPath) {
  const targets = DERIVED_TARGETS.get(upstreamPath);
  if (!targets) {
    throw new Error(`No derived-target mapping for allowlisted source ${upstreamPath}`);
  }
  return targets.map((target) => ({ ...target }));
}

export function rawUrlFor(revision, upstreamPath) {
  validateRevision(revision);
  if (!ALLOWED_DOWNLOAD_PATHS.has(upstreamPath)) {
    throw new Error(`Chromium path is not allowlisted: ${upstreamPath}`);
  }
  return `${RAW_GITHUB_ORIGIN}${RAW_REPOSITORY_PREFIX}${revision}/${upstreamPath}`;
}

function assertPinnedRawUrl(value) {
  const url = new URL(value);
  if (url.origin !== RAW_GITHUB_ORIGIN || url.protocol !== "https:") {
    throw new Error(`Chromium download URL is outside pinned raw GitHub origin: ${url}`);
  }
  const expectedPrefix = `${RAW_REPOSITORY_PREFIX}${PINNED_REVISION}/`;
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new Error(`Chromium download URL does not use the pinned revision: ${url}`);
  }
  const upstreamPath = decodeURIComponent(url.pathname.slice(expectedPrefix.length));
  if (!ALLOWED_DOWNLOAD_PATHS.has(upstreamPath)) {
    throw new Error(`Chromium redirect path is not allowlisted: ${upstreamPath}`);
  }
  return url;
}

export async function fetchWithPinnedRedirects(
  initialUrl,
  fetchImpl = globalThis.fetch,
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available for the Chromium import");
  }

  let currentUrl = assertPinnedRawUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      redirect: "manual",
      headers: { "user-agent": "pin-op-chromium-vendor/1" },
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Chromium download redirect omitted Location: ${currentUrl}`);
    }
    const redirectedUrl = new URL(location, currentUrl);
    if (redirectedUrl.origin !== RAW_GITHUB_ORIGIN) {
      throw new Error(
        `Chromium download refused redirect outside pinned raw GitHub origin: ${redirectedUrl}`,
      );
    }
    currentUrl = assertPinnedRawUrl(redirectedUrl);
  }
  throw new Error(`Chromium download exceeded redirect limit: ${initialUrl}`);
}

function normalizeCommentBlock(rawBlock) {
  const normalized = rawBlock.replace(/\r\n?/g, "\n");
  let lines;
  if (normalized.startsWith("/*")) {
    lines = normalized
      .slice(2, -2)
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/, ""));
  } else {
    lines = normalized
      .split("\n")
      .map((line) => line.replace(/^\s*\/\/ ?/, ""));
  }
  return lines
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function extractEmbeddedNotices(sourceText) {
  const normalizedSource = sourceText.replace(/\r\n?/g, "\n");
  const candidates = [];
  for (const expression of [
    /\/\*[\s\S]*?\*\//g,
    /(?:^[\t ]*\/\/[^\n]*(?:\n|$))+/gm,
  ]) {
    for (const match of normalizedSource.matchAll(expression)) {
      candidates.push({ index: match.index, text: normalizeCommentBlock(match[0]) });
    }
  }

  const notices = [];
  const seen = new Set();
  for (const candidate of candidates.sort((left, right) => left.index - right.index)) {
    if (
      !/copyright/i.test(candidate.text) ||
      !/(?:license|redistribution|all rights reserved)/i.test(candidate.text)
    ) {
      continue;
    }
    const digest = sha256(candidate.text);
    if (!seen.has(digest)) {
      notices.push({ text: candidate.text, sha256: digest });
      seen.add(digest);
    }
  }
  return notices;
}

export function assertCompleteRootBsdLicense(licenseText) {
  const normalizedLicense = licenseText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  const requiredClauses = [
    /copyright/i,
    /redistribution and use in source and binary forms/i,
    /neither the name/i,
    /this software is provided by the copyright holders and contributors/i,
    /in no event shall the copyright (?:owner|holder)/i,
  ];
  if (!requiredClauses.every((clause) => clause.test(normalizedLicense))) {
    throw new Error("Downloaded Chromium root BSD license is incomplete");
  }
}

function decodeUtf8(bytes, description) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8`, { cause: error });
  }
}

async function downloadPinnedFile(upstreamPath, fetchImpl) {
  const url = rawUrlFor(PINNED_REVISION, upstreamPath);
  const response = await fetchWithPinnedRedirects(url, fetchImpl);
  if (response.status !== 200) {
    throw new Error(
      `Chromium source download failed for ${upstreamPath}: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function localTargetDigest(physicalRoot, repositoryRelativePath) {
  try {
    const targetPath = await assertConfinedPath(
      physicalRoot,
      repositoryRelativePath,
    );
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      throw new Error(
        `derived target is not a regular file: ${repositoryRelativePath}`,
      );
    }
    return sha256(await readConfinedFile(physicalRoot, repositoryRelativePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "pending";
    }
    throw error;
  }
}

function validateImportDate(importDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(importDate)) {
    throw new Error(`Invalid Chromium import date: ${importDate}`);
  }
  const parsed = new Date(`${importDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== importDate) {
    throw new Error(`Invalid Chromium import date: ${importDate}`);
  }
  return importDate;
}

export async function vendorChromiumElements({
  repositoryRoot,
  revision,
  importDate = new Date().toISOString().slice(0, 10),
  fetchImpl = globalThis.fetch,
} = {}) {
  validateRevision(revision);
  validateImportDate(importDate);
  const physicalRoot = await resolvePhysicalRepositoryRoot(
    repositoryRoot ?? process.cwd(),
  );

  await assertConfinedPath(physicalRoot, VENDOR_RELATIVE_PATH);
  await assertConfinedPath(physicalRoot, UPSTREAM_RELATIVE_PATH);
  await assertConfinedPath(
    physicalRoot,
    path.join(VENDOR_RELATIVE_PATH, "LICENSE"),
  );
  await assertConfinedPath(
    physicalRoot,
    path.join(VENDOR_RELATIVE_PATH, "UPSTREAM.json"),
  );
  for (const upstreamPath of UPSTREAM_PATHS) {
    await assertConfinedPath(
      physicalRoot,
      path.join(UPSTREAM_RELATIVE_PATH, ...upstreamPath.split("/")),
    );
    for (const target of expectedDerivedTargets(upstreamPath)) {
      await assertConfinedPath(physicalRoot, target.path);
    }
  }

  const requestedPaths = [LICENSE_UPSTREAM_PATH, ...UPSTREAM_PATHS];
  const downloadedEntries = await Promise.all(
    requestedPaths.map(async (upstreamPath) => [
      upstreamPath,
      await downloadPinnedFile(upstreamPath, fetchImpl),
    ]),
  );
  const downloads = new Map(downloadedEntries);

  const licenseBytes = downloads.get(LICENSE_UPSTREAM_PATH);
  if (sha256(licenseBytes) !== PINNED_LICENSE_SHA256) {
    throw new Error("Downloaded Chromium root BSD license SHA-256 mismatch");
  }
  const licenseText = decodeUtf8(licenseBytes, "Chromium root license");
  assertCompleteRootBsdLicense(licenseText);

  const files = [];
  for (const upstreamPath of UPSTREAM_PATHS) {
    const bytes = downloads.get(upstreamPath);
    const sourceText = decodeUtf8(bytes, upstreamPath);
    const embeddedNotices = extractEmbeddedNotices(sourceText);
    if (embeddedNotices.length === 0) {
      throw new Error(`No embedded copyright/license notice found in ${upstreamPath}`);
    }
    const derivedTargets = await Promise.all(
      expectedDerivedTargets(upstreamPath).map(async (target) => ({
        ...target,
        localSha256: await localTargetDigest(physicalRoot, target.path),
      })),
    );
    files.push({
      upstreamPath,
      sha256: sha256(bytes),
      embeddedNotices,
      derivedTargets,
    });
  }

  const distinctNoticeTexts = new Map(
    files
      .flatMap(({ embeddedNotices }) => embeddedNotices)
      .map((notice) => [notice.sha256, notice.text]),
  );
  if (![...distinctNoticeTexts.values()].some((text) => /Apple[\s\S]*Joseph Pecoraro/.test(text))) {
    throw new Error("The selected Chromium sources omit the expected Apple/Joseph Pecoraro notice");
  }

  const manifest = {
    repository: CHROMIUM_REPOSITORY,
    revision: PINNED_REVISION,
    importedAt: importDate,
    license: "LICENSE",
    licenseSha256: PINNED_LICENSE_SHA256,
    files,
  };

  await removeConfinedDirectoryTree(physicalRoot, UPSTREAM_RELATIVE_PATH);
  for (const upstreamPath of UPSTREAM_PATHS) {
    await writeConfinedFileAtomically(
      physicalRoot,
      path.join(UPSTREAM_RELATIVE_PATH, ...upstreamPath.split("/")),
      downloads.get(upstreamPath),
    );
  }
  await writeConfinedFileAtomically(
    physicalRoot,
    path.join(VENDOR_RELATIVE_PATH, "LICENSE"),
    licenseBytes,
  );
  await writeConfinedFileAtomically(
    physicalRoot,
    path.join(VENDOR_RELATIVE_PATH, "UPSTREAM.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--revision") {
    throw new Error(`Usage: node tools/vendor-chromium-elements.mjs --revision ${PINNED_REVISION}`);
  }
  return { revision: validateRevision(argv[1]) };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const { revision } = parseArguments(process.argv.slice(2));
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = await vendorChromiumElements({ repositoryRoot, revision });
    console.log(
      `Vendored ${manifest.files.length} Chromium Elements files at ${manifest.revision}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
