import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_SOURCE_DATE_EPOCH = "1704067200";

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

  const sections = packages.map((entry) => [
    `## ${entry.name}@${entry.version}`,
    `Declared license: ${entry.license}`,
    `License file: ${entry.licenseFile}`,
    "",
    entry.licenseText,
  ].join("\n"));
  const notices = [
    "# Third-Party Notices",
    "",
    "Pin-op includes the following bundled third-party software.",
    "This list is generated from the inputs in esbuild's bundle metadata.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");

  await writeFile(
    resolve(extensionRoot, "THIRD_PARTY_NOTICES"),
    notices,
    "utf8",
  );
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
  return text.replaceAll("\r\n", "\n").trim();
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
