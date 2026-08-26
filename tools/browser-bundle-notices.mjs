import { createHash } from "node:crypto";
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_SOURCE_DATE_EPOCH = "1704067200";
const CHROMIUM_UPSTREAM_ROOT = "third_party/chromium-devtools-frontend";
export const PINNED_CHROMIUM_REVISION =
  "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280";
export const CHROMIUM_EMBEDDED_NOTICE_DIGESTS = Object.freeze([
  "0341a16b53a79d5e32172c89db96057ee8358305eef0aaaa556681c83667338e",
  "050f83ce2b9b631be983c4ef44f0957b238a1643813e53a40387d672daf1f343",
  "131804219ff999f3413b2f96f4a83a6bcce31958295d4b9386ae8908b1feeb58",
  "3125b574da3d3e661c007a698a0ad1a606c9ac1d9d85a4a10fc108acbd0de9de",
  "3d7a44c2f58a44d1fc5b62cc6e0b9368f9be300f60d3772e77a0be8f9f91c8e0",
  "4c27ba6729a100d4fc512203eaec26c3fff044751c4852909a3166ef152d9c0a",
  "5faa528cc315b32fd8d47131934c4b5efe04f5bef5ee9f759c5f7ced60a31739",
  "a440e634c6fb90d085c874f96fd50705b609b91c648f4f75c1edb60999aa5ad3",
  "de0c092c55e5a9bd3da8e050472082eb98379a3aeafcdf8c060b71b751bde822",
]);
export const CHROMIUM_UPSTREAM_PATHS = Object.freeze([
  "front_end/panels/elements/ElementsTreeElement.ts",
  "front_end/panels/elements/ElementsTreeOutline.ts",
  "front_end/panels/elements/PropertyRenderer.ts",
  "front_end/panels/elements/StylePropertiesSection.ts",
  "front_end/panels/elements/StylePropertyTreeElement.ts",
  "front_end/panels/elements/StylePropertyUtils.ts",
  "front_end/panels/elements/StylesSidebarPane.ts",
  "front_end/panels/elements/elementsTreeOutline.css",
  "front_end/panels/elements/stylePropertiesTreeOutline.css",
  "front_end/panels/elements/stylesSidebarPane.css",
]);

export async function writeBrowserProjectLicense(extensionRoot) {
  const license = normalizeText(
    await readFile(resolve(extensionRoot, "../../LICENSE"), "utf8"),
  );
  await writeFile(resolve(extensionRoot, "LICENSE"), `${license}\n`, "utf8");
}

export async function writeBrowserBundleNotices(metafile, extensionRoot) {
  const packages = await bundledPackages(metafile, extensionRoot);
  if (packages.length === 0) {
    throw new Error("Browser bundle metadata contains no third-party packages");
  }

  const packageSections = packages.map((entry) => [
    `## ${entry.name}@${entry.version}`,
    `Declared license: ${entry.license}`,
    `License file: ${entry.licenseFile}`,
    "",
    entry.licenseText,
  ].join("\n"));
  const repositoryRoot = resolve(extensionRoot, "../..");
  const chromiumRoot = resolve(repositoryRoot, CHROMIUM_UPSTREAM_ROOT);
  const upstreamManifest = JSON.parse(
    await readFile(resolve(chromiumRoot, "UPSTREAM.json"), "utf8"),
  );
  const chromiumLicense = await readFile(resolve(chromiumRoot, "LICENSE"), "utf8");
  const chromiumSection = renderChromiumDerivedNoticeSection(
    upstreamManifest,
    chromiumLicense,
  );
  const notices = [
    "# Third-Party Notices",
    "",
    "Pin-op includes the following bundled third-party software.",
    "Bundled package sections are generated from the inputs in esbuild's bundle metadata.",
    "Chromium-derived sections are generated from the pinned UPSTREAM.json manifest, root license, and embedded source notices.",
    "",
    ...packageSections.flatMap((section) => [section, ""]),
    chromiumSection,
    "",
  ].join("\n");

  await writeFile(
    resolve(extensionRoot, "THIRD_PARTY_NOTICES"),
    notices,
    "utf8",
  );
}

export function renderChromiumDerivedNoticeSection(manifest, rootLicense) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.license !== "LICENSE" ||
    !/^[0-9a-f]{64}$/.test(manifest.licenseSha256 ?? "") ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Invalid Chromium upstream notice manifest");
  }
  if (manifest.revision !== PINNED_CHROMIUM_REVISION) {
    throw new Error(
      `Expected pinned Chromium revision ${PINNED_CHROMIUM_REVISION}`,
    );
  }
  if (manifest.files.length !== 10) {
    throw new Error(
      "Chromium embedded notice inventory does not match the pinned source set",
    );
  }
  const upstreamPaths = manifest.files
    .map((file) => file?.upstreamPath)
    .sort(compareAscii);
  if (!sameStrings(upstreamPaths, CHROMIUM_UPSTREAM_PATHS)) {
    throw new Error(
      "Chromium upstream path inventory does not match the pinned source set",
    );
  }
  const normalizedLicenseBytes = normalizeLineEndings(rootLicense);
  if (sha256(normalizedLicenseBytes) !== manifest.licenseSha256) {
    throw new Error("Chromium root license does not match UPSTREAM.json");
  }
  const normalizedLicense = normalizedLicenseBytes.trim();
  if (!normalizedLicense) {
    throw new Error("Chromium root license is empty");
  }

  const embeddedNotices = new Map();
  for (const file of manifest.files) {
    if (!Array.isArray(file?.embeddedNotices) || file.embeddedNotices.length === 0) {
      throw new Error(`Chromium source ${file?.upstreamPath ?? "<unknown>"} has no embedded notice`);
    }
    for (const notice of file.embeddedNotices) {
      const text = normalizeText(notice?.text ?? "");
      if (!/^[0-9a-f]{64}$/.test(notice?.sha256 ?? "") || !text) {
        throw new Error("Invalid Chromium embedded notice metadata");
      }
      const existing = embeddedNotices.get(notice.sha256);
      if (existing !== undefined && existing !== text) {
        throw new Error(`Conflicting Chromium embedded notice ${notice.sha256}`);
      }
      if (sha256(text) !== notice.sha256) {
        throw new Error(`Chromium embedded notice ${notice.sha256} has invalid text`);
      }
      embeddedNotices.set(notice.sha256, text);
    }
  }

  const embeddedDigests = [...embeddedNotices.keys()].sort(compareAscii);
  if (!sameStrings(embeddedDigests, CHROMIUM_EMBEDDED_NOTICE_DIGESTS)) {
    throw new Error(
      "Chromium embedded notice inventory does not match the pinned source set",
    );
  }

  const embeddedSections = [...embeddedNotices]
    .sort(([left], [right]) => compareAscii(left, right))
    .flatMap(([digest, text]) => [
      `### Embedded notice ${digest}`,
      "",
      text,
      "",
    ]);
  return [
    "## Chromium DevTools Frontend (derived view code)",
    `Pinned revision: ${manifest.revision}`,
    `License file: ${CHROMIUM_UPSTREAM_ROOT}/${manifest.license}`,
    "",
    normalizedLicense,
    "",
    "## Chromium DevTools Frontend embedded source notices",
    "",
    ...embeddedSections,
  ].join("\n").trimEnd();
}

export async function normalizeBrowserPackageTimestamps(extensionRoot) {
  const timestamp = sourceDate();
  const distEntries = await readdir(resolve(extensionRoot, "dist"), {
    withFileTypes: true,
  });
  const files = [
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "manifest.json",
    ...distEntries.filter((entry) => entry.isFile()).map((entry) => `dist/${entry.name}`),
  ];
  await Promise.all(
    files.map((path) => utimes(resolve(extensionRoot, path), timestamp, timestamp)),
  );
}

async function bundledPackages(metafile, extensionRoot) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRootFromMetafilePath(input, extensionRoot);
    if (root) roots.add(root);
  }

  const packages = await Promise.all([...roots].map(readPackageNotice));
  const unique = new Map();
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    const existing = unique.get(key);
    if (existing && existing.licenseText !== entry.licenseText) {
      throw new Error(`Conflicting license texts found for ${key}`);
    }
    unique.set(key, entry);
  }
  return [...unique.values()].sort((left, right) =>
    compareAscii(left.name, right.name) || compareAscii(left.version, right.version)
  );
}

function packageRootFromMetafilePath(input, extensionRoot) {
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("(disabled):")) return undefined;
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const packagePath = normalized.slice(markerIndex + marker.length).split("/");
  const packageSegments = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2)
    : packagePath.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((part) => !part)) {
    throw new Error(`Cannot identify package root for esbuild input: ${input}`);
  }
  return resolve(
    extensionRoot,
    normalized.slice(0, markerIndex + marker.length),
    ...packageSegments,
  );
}

async function readPackageNotice(root) {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    typeof manifest.license !== "string"
  ) {
    throw new Error(`Invalid package notice metadata in ${manifestPath}`);
  }

  const licenseFile = await findLicenseFile(root);
  if (!licenseFile) {
    throw new Error(`Bundled package ${manifest.name}@${manifest.version} has no license file`);
  }
  const licenseText = normalizeText(await readFile(resolve(root, licenseFile), "utf8"));
  if (!licenseText) {
    throw new Error(`Bundled package ${manifest.name}@${manifest.version} has an empty license`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    licenseFile,
    licenseText,
  };
}

async function findLicenseFile(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) =>
      entry.isFile() && /^(?:license|licence|copying)(?:[._-].*)?$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftExact = /^licen[cs]e$/i.test(left) ? 0 : 1;
      const rightExact = /^licen[cs]e$/i.test(right) ? 0 : 1;
      return leftExact - rightExact || compareAscii(left, right);
    })[0];
}

function sourceDate() {
  const value = process.env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH;
  if (!/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  const milliseconds = Number(value) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(1980, 0, 1)) {
    throw new Error("SOURCE_DATE_EPOCH must be a ZIP-safe Unix timestamp on or after 1980-01-01");
  }
  return new Date(milliseconds);
}

function normalizeText(text) {
  return normalizeLineEndings(text).trim();
}

function normalizeLineEndings(text) {
  return text.replaceAll("\r\n", "\n");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
