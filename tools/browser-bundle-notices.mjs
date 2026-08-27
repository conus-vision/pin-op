import { createHash } from "node:crypto";
import { readFile, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_SOURCE_DATE_EPOCH = "1704067200";
const CHROMIUM_UPSTREAM_ROOT = "third_party/chromium-devtools-frontend";
const CHROMIUM_PACKAGE_NAME = "chrome-devtools-frontend";
const CHROMIUM_GENERATED_IMAGE_INPUT_SUFFIX =
  "/node_modules/chrome-devtools-frontend/front_end/Images/Images.js";
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

export async function writeBrowserBundleNotices(
  metafile,
  extensionRoot,
  { metafileSources } = {},
) {
  const packages = await bundledPackages(
    metafile,
    extensionRoot,
    metafileSources,
  );
  if (packages.length === 0) {
    throw new Error("Browser bundle metadata contains no third-party packages");
  }

  const packageSections = packages
    .filter((entry) => entry.name !== CHROMIUM_PACKAGE_NAME)
    .map((entry) => [
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
  const nativeRuntimeSection = renderChromiumNativeRuntimeNoticeSection(
    await loadChromiumNativeRuntimeNoticeInputs(repositoryRoot),
  );
  const notices = [
    "# Third-Party Notices",
    "",
    "Pin-op includes the following bundled third-party software.",
    "Bundled package sections are generated from the inputs in esbuild's bundle metadata.",
    "Chromium-derived sections are generated from the pinned UPSTREAM.json and RUNTIME.json manifests, the reviewed DOM and Rules overlay manifests, exact input inventories, and required license bytes.",
    "",
    ...packageSections.flatMap((section) => [section, ""]),
    chromiumSection,
    "",
    nativeRuntimeSection,
    "",
  ].join("\n");

  await writeFile(
    resolve(extensionRoot, "THIRD_PARTY_NOTICES"),
    notices,
    "utf8",
  );
}

export async function loadChromiumNativeRuntimeNoticeInputs(repositoryRoot) {
  const chromiumRoot = resolve(repositoryRoot, CHROMIUM_UPSTREAM_ROOT);
  const runtimePath = resolve(chromiumRoot, "RUNTIME.json");
  const runtimeBytes = await readFile(runtimePath);
  const runtimeManifest = parseJson(runtimeBytes, "Chromium RUNTIME.json");
  const version = runtimeManifest?.package?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Chromium RUNTIME.json has invalid package version");
  }
  const domRuntime = runtimeManifest.readOnlyElementsRuntime;
  if (!domRuntime || typeof domRuntime.overlayRoot !== "string") {
    throw new Error("Chromium RUNTIME.json is missing readOnlyElementsRuntime");
  }
  const stylesRuntime = runtimeManifest.readOnlyStylesRuntime;
  if (!stylesRuntime || typeof stylesRuntime.overlayRoot !== "string") {
    throw new Error("Chromium RUNTIME.json is missing readOnlyStylesRuntime");
  }
  const stylesOverlayRoot = stylesRuntime.overlayRoot;
  const domOverlayRoot = domRuntime.overlayRoot;
  assertOverlayRoot(domOverlayRoot, `patches/${version}`, "DOM");
  assertOverlayRoot(stylesOverlayRoot, `styles-overlay/${version}`, "Rules");

  const domManifestBytes = await readFile(
    resolve(repositoryRoot, domOverlayRoot, "manifest.json"),
  );
  const stylesManifestBytes = await readFile(
    resolve(repositoryRoot, stylesOverlayRoot, "manifest.json"),
  );
  const domManifest = parseJson(domManifestBytes, "Chromium DOM overlay manifest");
  const stylesManifest = parseJson(
    stylesManifestBytes,
    "Chromium Rules overlay manifest",
  );
  const packageRoot = resolve(repositoryRoot, "node_modules", CHROMIUM_PACKAGE_NAME);
  const packageManifestBytes = await readFile(resolve(packageRoot, "package.json"));
  const packageManifest = parseJson(
    packageManifestBytes,
    "Chromium npm package manifest",
  );

  const domOverlayFiles = await readDeclaredFiles(
    resolve(repositoryRoot, domOverlayRoot),
    domManifest.overlayFiles,
    "Chromium DOM overlay",
  );
  const stylesOverlayFiles = await readDeclaredFiles(
    resolve(repositoryRoot, stylesOverlayRoot),
    stylesManifest.overlayFiles,
    "Chromium Rules overlay",
  );
  const packagePaths = new Set(["package.json"]);
  for (const manifest of [domManifest, stylesManifest]) {
    for (const key of ["upstreamFiles", "requiredImageFiles", "requiredLicenseFiles"]) {
      for (const path of Object.keys(manifest[key] ?? {})) packagePaths.add(path);
    }
  }
  for (const path of Object.keys(runtimeManifest.reviewedEntrypoints ?? {})) {
    packagePaths.add(path);
  }
  for (const path of Object.keys(runtimeManifest.reviewedImages ?? {})) {
    packagePaths.add(`front_end/Images/src/${path}`);
  }
  const packageFiles = new Map();
  for (const path of [...packagePaths].sort(compareAscii)) {
    assertPackagePath(path, "Chromium npm input");
    packageFiles.set(path, await readFile(resolve(packageRoot, path)));
  }

  const licenseTexts = new Map();
  const licenseInventory = mergeLicenseInventories(domManifest, stylesManifest);
  for (const [path, digest] of licenseInventory) {
    const bytes = packageFiles.get(path);
    if (!bytes || sha256(bytes) !== digest) {
      throw new Error(`Chromium native runtime license ${path} has invalid SHA-256`);
    }
    const text = normalizeText(bytes.toString("utf8"));
    if (!text) throw new Error(`Chromium native runtime license ${path} is empty`);
    const existing = licenseTexts.get(digest);
    if (existing !== undefined && existing !== text) {
      throw new Error(`Conflicting Chromium native runtime license ${digest}`);
    }
    licenseTexts.set(digest, text);
  }

  return {
    runtimePath: `${CHROMIUM_UPSTREAM_ROOT}/RUNTIME.json`,
    runtimeBytes,
    runtimeManifest,
    packageManifestBytes,
    packageManifest,
    domOverlayRoot,
    domManifestBytes,
    domManifest,
    domOverlayFiles,
    stylesOverlayRoot,
    stylesManifestBytes,
    stylesManifest,
    stylesOverlayFiles,
    packageFiles,
    licenseTexts,
  };
}

export function renderChromiumNativeRuntimeNoticeSection(inputs) {
  if (!inputs || typeof inputs !== "object") {
    throw new Error("Invalid Chromium native runtime notice inputs");
  }
  const {
    runtimePath,
    runtimeBytes,
    runtimeManifest,
    packageManifestBytes,
    packageManifest,
    domOverlayRoot,
    domManifestBytes,
    domManifest,
    domOverlayFiles,
    stylesOverlayRoot,
    stylesManifestBytes,
    stylesManifest,
    stylesOverlayFiles,
    packageFiles,
    licenseTexts,
  } = inputs;
  if (runtimePath !== `${CHROMIUM_UPSTREAM_ROOT}/RUNTIME.json`) {
    throw new Error("Chromium native runtime notice has invalid RUNTIME.json path");
  }
  assertParsedBytes(runtimeBytes, runtimeManifest, "Chromium RUNTIME.json metadata");
  assertParsedBytes(
    packageManifestBytes,
    packageManifest,
    "Chromium npm package metadata",
  );
  assertParsedBytes(
    domManifestBytes,
    domManifest,
    "Chromium DOM overlay manifest metadata",
  );
  assertParsedBytes(
    stylesManifestBytes,
    stylesManifest,
    "Chromium Rules overlay manifest metadata",
  );
  assertNativePackageIdentity(runtimeManifest, packageManifest, domManifest, stylesManifest);
  const version = runtimeManifest.package.version;
  assertOverlayRoot(domOverlayRoot, `patches/${version}`, "DOM");
  assertOverlayRoot(stylesOverlayRoot, `styles-overlay/${version}`, "Rules");

  assertRuntimeDescriptor(
    runtimeManifest.readOnlyElementsRuntime,
    {
      overlayRoot: domOverlayRoot,
      manifestSha256: sha256(domManifestBytes),
      entryPoint: domManifest.entryPoint,
      upstreamInputClosure: domManifest.reviewedInputClosure,
      overlayInputClosure: domManifest.reviewedOverlayClosure,
      requiredLicenseFiles: domManifest.requiredLicenseFiles,
    },
    "DOM",
  );
  assertRuntimeDescriptor(
    runtimeManifest.readOnlyStylesRuntime,
    {
      overlayRoot: stylesOverlayRoot,
      manifestSha256: sha256(stylesManifestBytes),
      entryPoint: stylesManifest.entryPoint,
      packageInputClosure: stylesManifest.reviewedPackageClosure,
      overlayInputClosure: stylesManifest.reviewedStylesOverlayClosure,
      requiredLicenseFiles: stylesManifest.requiredLicenseFiles,
    },
    "Rules",
  );
  verifyFileInventory(
    "Chromium DOM npm input",
    domManifest.upstreamFiles,
    packageFiles,
  );
  verifyFileInventory(
    "Chromium DOM image input",
    domManifest.requiredImageFiles ?? {},
    packageFiles,
  );
  verifyFileInventory(
    "Chromium DOM overlay input",
    domManifest.overlayFiles,
    domOverlayFiles,
    { exact: true },
  );
  verifyFileInventory(
    "Chromium Rules npm input",
    stylesManifest.upstreamFiles,
    packageFiles,
  );
  verifyFileInventory(
    "Chromium Rules image input",
    stylesManifest.requiredImageFiles ?? {},
    packageFiles,
  );
  verifyFileInventory(
    "Chromium Rules overlay input",
    stylesManifest.overlayFiles,
    stylesOverlayFiles,
    { exact: true },
  );
  verifyFileInventory(
    "Chromium reviewed entrypoint",
    runtimeManifest.reviewedEntrypoints ?? {},
    packageFiles,
  );
  const reviewedImageInventory = Object.fromEntries(
    Object.entries(runtimeManifest.reviewedImages ?? {}).map(([path, digest]) => [
      `front_end/Images/src/${path}`,
      digest,
    ]),
  );
  verifyFileInventory(
    "Chromium reviewed image",
    reviewedImageInventory,
    packageFiles,
  );

  const licenseUsage = new Map();
  for (const [owner, manifest] of [
    ["DOM", domManifest],
    ["Rules", stylesManifest],
  ]) {
    verifyFileInventory(
      `Chromium ${owner} license`,
      manifest.requiredLicenseFiles,
      packageFiles,
    );
    for (const [path, digest] of sortedEntries(manifest.requiredLicenseFiles)) {
      const owners = licenseUsage.get(digest) ?? [];
      owners.push(`${owner}:${path}`);
      licenseUsage.set(digest, owners);
    }
  }
  const expectedLicenseDigests = [...licenseUsage.keys()].sort(compareAscii);
  const actualLicenseDigests = [...licenseTexts.keys()].sort(compareAscii);
  if (!sameStrings(actualLicenseDigests, expectedLicenseDigests)) {
    throw new Error("Chromium native runtime license digest inventory does not match");
  }
  for (const [digest, text] of licenseTexts) {
    const firstUsage = licenseUsage.get(digest)?.[0];
    const path = firstUsage?.slice(firstUsage.indexOf(":") + 1);
    const expectedText = normalizeText(packageFiles.get(path)?.toString("utf8") ?? "");
    if (!/^[0-9a-f]{64}$/.test(digest) || normalizeText(text) !== expectedText) {
      throw new Error(`Chromium native runtime license ${digest} has invalid text bytes`);
    }
  }
  const rootLicenseDigest = runtimeManifest.license.sha256;
  if (!licenseUsage.has(rootLicenseDigest)) {
    throw new Error("Chromium native runtime license inventory omits the root license");
  }

  const generatedInputs = [
    ...(runtimeManifest.generatedModules ?? []).map((path) => `runtime:${path}`),
    ...(stylesManifest.reviewedGeneratedInputs ?? []).map((path) => `Rules:${path}`),
  ].sort(compareAscii);
  const nativeLicenseSections = [...licenseTexts]
    .filter(([digest]) => digest !== rootLicenseDigest)
    .sort(([left], [right]) => compareAscii(left, right))
    .flatMap(([digest, text]) => [
      `### Native runtime license ${digest}`,
      `Used by: ${licenseUsage.get(digest).sort(compareAscii).join(", ")}`,
      "",
      normalizeText(text),
      "",
    ]);
  return [
    "## Chromium DevTools Frontend (native read-only runtime)",
    `NPM package: ${packageManifest.name}@${packageManifest.version}`,
    `Package gitHead: ${runtimeManifest.package.gitHead}`,
    `Package integrity: ${runtimeManifest.package.integrity}`,
    `Package repository: ${runtimeManifest.repository}`,
    `Runtime metadata: ${runtimePath}`,
    `Runtime metadata SHA-256: ${sha256(runtimeBytes)}`,
    "",
    `DOM overlay manifest: ${domOverlayRoot}/manifest.json`,
    `DOM overlay manifest SHA-256: ${sha256(domManifestBytes)}`,
    ...renderClosureAttestation(
      "DOM npm closure",
      domManifest.reviewedInputClosure,
    ),
    ...renderClosureAttestation(
      "DOM overlay closure",
      domManifest.reviewedOverlayClosure,
    ),
    ...renderClosureAttestation(
      "DOM shared payload",
      domManifest.reviewedSharedPayloadAttestation,
    ),
    ...renderStringInventory(
      "DOM shared input inventory",
      domManifest.reviewedSharedInputInventory,
    ),
    ...renderDigestInventory("DOM npm input inventory", domManifest.upstreamFiles),
    ...renderDigestInventory("DOM image input inventory", domManifest.requiredImageFiles ?? {}),
    ...renderDigestInventory("DOM overlay input inventory", domManifest.overlayFiles),
    ...renderDigestInventory("DOM required license inventory", domManifest.requiredLicenseFiles),
    "",
    `Rules overlay manifest: ${stylesOverlayRoot}/manifest.json`,
    `Rules overlay manifest SHA-256: ${sha256(stylesManifestBytes)}`,
    ...renderClosureAttestation(
      "Rules npm closure",
      stylesManifest.reviewedPackageClosure,
    ),
    ...renderClosureAttestation(
      "Rules overlay closure",
      stylesManifest.reviewedStylesOverlayClosure,
    ),
    ...renderClosureAttestation(
      "Rules base overlay closure",
      stylesManifest.reviewedBaseOverlayClosure,
    ),
    ...renderClosureAttestation(
      "Rules shared payload",
      stylesManifest.reviewedSharedPayloadAttestation,
    ),
    ...renderStringInventory(
      "Rules shared input inventory",
      stylesManifest.reviewedSharedInputInventory,
    ),
    ...renderDigestInventory("Rules npm input inventory", stylesManifest.upstreamFiles),
    ...renderDigestInventory("Rules image input inventory", stylesManifest.requiredImageFiles ?? {}),
    ...renderDigestInventory("Rules overlay input inventory", stylesManifest.overlayFiles),
    ...renderDigestInventory(
      "Rules required license inventory",
      stylesManifest.requiredLicenseFiles,
    ),
    "",
    ...renderStringInventory(
      "Reviewed generated module inventory",
      generatedInputs,
    ),
    "",
    "The Chromium root BSD license text appears once in the derived view section above.",
    "The remaining native runtime license texts follow, deduplicated by SHA-256.",
    "",
    ...nativeLicenseSections,
  ].join("\n").trimEnd();
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

async function readDeclaredFiles(root, inventory, label) {
  assertDigestInventory(inventory, label);
  const declared = Object.keys(inventory).sort(compareAscii);
  const actual = (await listFiles(root))
    .filter((path) => path !== "manifest.json")
    .sort(compareAscii);
  if (!sameStrings(actual, declared)) {
    throw new Error(`${label} file inventory does not match its manifest`);
  }
  const files = new Map();
  for (const path of declared) {
    files.set(path, await readFile(resolve(root, path)));
  }
  return files;
}

async function listFiles(root, prefix = "") {
  const result = [];
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareAscii(left.name, right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new Error(`Chromium overlay contains unsupported filesystem entry ${path}`);
    }
  }
  return result;
}

function assertParsedBytes(bytes, value, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are missing`);
  const parsed = parseJson(bytes, label);
  if (!isDeepStrictEqual(parsed, value)) {
    throw new Error(`${label} does not match its exact JSON bytes`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function assertNativePackageIdentity(
  runtimeManifest,
  packageManifest,
  domManifest,
  stylesManifest,
) {
  if (
    runtimeManifest?.schemaVersion !== 1 ||
    runtimeManifest?.package?.packageName !== CHROMIUM_PACKAGE_NAME ||
    typeof runtimeManifest.package.version !== "string" ||
    !/^[0-9a-f]{40}$/.test(runtimeManifest.package.gitHead ?? "") ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(runtimeManifest.package.integrity ?? "") ||
    runtimeManifest.repository !==
      "https://github.com/ChromeDevTools/devtools-frontend.git" ||
    runtimeManifest?.license?.spdx !== "BSD-3-Clause" ||
    runtimeManifest.license.path !== "LICENSE" ||
    !/^[0-9a-f]{64}$/.test(runtimeManifest.license.sha256 ?? "")
  ) {
    throw new Error("Invalid Chromium native RUNTIME.json package metadata");
  }
  if (
    packageManifest?.name !== runtimeManifest.package.packageName ||
    packageManifest.version !== runtimeManifest.package.version ||
    packageManifest.license !== runtimeManifest.license.spdx
  ) {
    throw new Error("Chromium npm package metadata does not match RUNTIME.json");
  }
  for (const [label, manifest] of [
    ["DOM", domManifest],
    ["Rules", stylesManifest],
  ]) {
    if (
      manifest?.schemaVersion !== 1 ||
      manifest?.package?.name !== runtimeManifest.package.packageName ||
      manifest.package.version !== runtimeManifest.package.version ||
      manifest.package.gitHead !== runtimeManifest.package.gitHead
    ) {
      throw new Error(`Chromium ${label} manifest package metadata does not match RUNTIME.json`);
    }
  }
  if (
    stylesManifest.package.integrity !== runtimeManifest.package.integrity ||
    stylesManifest.package.license !== runtimeManifest.license.spdx
  ) {
    throw new Error("Chromium Rules manifest package integrity/license does not match RUNTIME.json");
  }
}

function assertRuntimeDescriptor(actual, expected, label) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`Chromium RUNTIME.json is missing ${label} runtime metadata`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(actual[key], value)) {
      throw new Error(`Chromium ${label} runtime metadata ${key} does not match its manifest`);
    }
  }
}

function verifyFileInventory(label, inventory, files, { exact = false } = {}) {
  assertDigestInventory(inventory, label);
  if (!(files instanceof Map)) throw new Error(`${label} bytes are missing`);
  const paths = Object.keys(inventory).sort(compareAscii);
  if (exact && !sameStrings([...files.keys()].sort(compareAscii), paths)) {
    throw new Error(`${label} path inventory does not match`);
  }
  for (const path of paths) {
    const bytes = files.get(path);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== inventory[path]) {
      throw new Error(`${label} ${path} has invalid SHA-256 bytes`);
    }
  }
}

function assertDigestInventory(inventory, label) {
  if (
    !inventory ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    Object.keys(inventory).length === 0
  ) {
    throw new Error(`${label} has invalid digest inventory`);
  }
  for (const [path, digest] of Object.entries(inventory)) {
    assertPackagePath(path, label);
    if (!/^[0-9a-f]{64}$/.test(digest ?? "")) {
      throw new Error(`${label} ${path} has invalid SHA-256 metadata`);
    }
  }
}

function assertPackagePath(path, label) {
  if (
    typeof path !== "string" ||
    !path ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} has unsafe path ${path}`);
  }
}

function assertOverlayRoot(actual, expectedSuffix, label) {
  const expected = `${CHROMIUM_UPSTREAM_ROOT}/${expectedSuffix}`;
  if (actual !== expected) {
    throw new Error(`Chromium ${label} overlay root must be ${expected}`);
  }
}

function mergeLicenseInventories(...manifests) {
  const merged = new Map();
  for (const manifest of manifests) {
    assertDigestInventory(
      manifest?.requiredLicenseFiles,
      "Chromium native runtime license",
    );
    for (const [path, digest] of Object.entries(manifest.requiredLicenseFiles)) {
      const existing = merged.get(path);
      if (existing !== undefined && existing !== digest) {
        throw new Error(`Conflicting Chromium native runtime license ${path}`);
      }
      merged.set(path, digest);
    }
  }
  return [...merged].sort(([left], [right]) => compareAscii(left, right));
}

function renderDigestInventory(title, inventory) {
  assertDigestInventory(inventory, title);
  return [
    "",
    `### ${title}`,
    ...sortedEntries(inventory).map(([path, digest]) => `- ${path} ${digest}`),
  ];
}

function renderClosureAttestation(title, attestation) {
  if (
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation) ||
    !Number.isSafeInteger(attestation.fileCount) ||
    attestation.fileCount <= 0 ||
    !/^[0-9a-f]{64}$/.test(attestation.sha256 ?? "")
  ) {
    throw new Error(`${title} has invalid closure attestation`);
  }
  return [
    "",
    `### ${title}`,
    `File count: ${attestation.fileCount}`,
    `SHA-256: ${attestation.sha256}`,
  ];
}

function renderStringInventory(title, inventory) {
  if (
    !Array.isArray(inventory) ||
    inventory.length === 0 ||
    inventory.some(
      (value) =>
        typeof value !== "string" ||
        !value ||
        /[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    throw new Error(`${title} has invalid string inventory`);
  }
  const sorted = [...inventory].sort(compareAscii);
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`${title} contains duplicate entries`);
  }
  return ["", `### ${title}`, ...sorted.map((value) => `- ${value}`)];
}

function sortedEntries(value) {
  return Object.entries(value).sort(([left], [right]) => compareAscii(left, right));
}

async function bundledPackages(metafile, extensionRoot, metafileSources) {
  assertEsbuildMetafile(metafile, "Browser bundle metadata");
  const repositoryRoot = resolve(extensionRoot, "../..");
  const origins = await verifiedInputOrigins(
    metafile,
    extensionRoot,
    repositoryRoot,
    metafileSources,
  );
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const canonicalChromiumPackageRoot = await realpath(
    resolve(repositoryRoot, "node_modules", CHROMIUM_PACKAGE_NAME),
  );
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const origin = origins.get(input);
    if (!origin) continue;
    const packageDescriptor = packageRootFromMetafilePath(input, origin.root);
    if (!packageDescriptor) continue;
    const reviewedVirtualChromiumInput =
      isReviewedVirtualChromiumPackageInput(input);
    let canonicalRoot;
    if (!isWithin(packageDescriptor.root, packageDescriptor.inputPath)) {
      throw new Error(`Esbuild input escapes its package root: ${input}`);
    }
    try {
      canonicalRoot = await realpath(packageDescriptor.root);
    } catch (error) {
      if (!origin.explicit) {
        throw new Error(
          `Esbuild input outside the repository requires a verified metafile origin: ${input}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (reviewedVirtualChromiumInput) {
      if (
        packageDescriptor.name !== CHROMIUM_PACKAGE_NAME ||
        canonicalRoot !== canonicalChromiumPackageRoot
      ) {
        throw new Error(
          `Virtual Chromium input does not use the pinned physical package root: ${input}`,
        );
      }
    } else {
      if (
        packageDescriptor.name === CHROMIUM_PACKAGE_NAME &&
        canonicalRoot !== canonicalChromiumPackageRoot
      ) {
        throw new Error(
          `Chromium package input does not use the pinned physical package root: ${input}`,
        );
      }
      let canonicalInput;
      try {
        canonicalInput = await realpath(packageDescriptor.inputPath);
      } catch (error) {
        throw new Error(`Esbuild package input has no physical file: ${input}`, {
          cause: error,
        });
      }
      if (!isWithin(canonicalRoot, canonicalInput)) {
        throw new Error(`Esbuild input escapes its physical package root: ${input}`);
      }
    }
    if (!isWithin(canonicalRepositoryRoot, canonicalRoot) && !origin.explicit) {
      throw new Error(
        `Esbuild input outside the repository requires a verified metafile origin: ${input}`,
      );
    }
    const existingName = roots.get(canonicalRoot);
    if (existingName !== undefined && existingName !== packageDescriptor.name) {
      throw new Error(`Conflicting package identities found for ${canonicalRoot}`);
    }
    roots.set(canonicalRoot, packageDescriptor.name);
  }

  const packages = await Promise.all(
    [...roots].map(([root, name]) => readPackageNotice(root, name)),
  );
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

async function verifiedInputOrigins(
  metafile,
  extensionRoot,
  repositoryRoot,
  metafileSources,
) {
  if (metafileSources === undefined) {
    return new Map(
      Object.keys(metafile.inputs).map((input) => [
        input,
        { root: extensionRoot, explicit: false },
      ]),
    );
  }
  if (!Array.isArray(metafileSources) || metafileSources.length === 0) {
    throw new Error("Browser bundle metadata has no verified metafile origins");
  }
  const approvedRoots = new Set([
    await realpath(extensionRoot),
    await realpath(repositoryRoot),
  ]);
  const origins = new Map();
  for (const source of metafileSources) {
    if (!source || typeof source !== "object") {
      throw new Error("Browser bundle metadata has invalid verified metafile origin");
    }
    assertEsbuildMetafile(source.metafile, "Verified browser bundle metadata");
    const originRoot = await realpath(source.absWorkingDir);
    if (!approvedRoots.has(originRoot)) {
      throw new Error(`Browser bundle metadata has unapproved metafile origin ${originRoot}`);
    }
    for (const [input, metadata] of Object.entries(source.metafile.inputs)) {
      if (!Object.hasOwn(metafile.inputs, input) ||
          !isDeepStrictEqual(metafile.inputs[input], metadata)) {
        throw new Error(`Verified metafile input does not match combined metadata: ${input}`);
      }
      if (input.startsWith("(disabled):")) continue;
      if (origins.has(input)) {
        throw new Error(`Esbuild input has ambiguous metafile origin: ${input}`);
      }
      origins.set(input, { root: originRoot, explicit: true });
    }
  }
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith("(disabled):") && !origins.has(input)) {
      throw new Error(`Esbuild input has no verified metafile origin: ${input}`);
    }
  }
  return origins;
}

function assertEsbuildMetafile(metafile, label) {
  if (
    !metafile ||
    typeof metafile !== "object" ||
    Array.isArray(metafile) ||
    !metafile.inputs ||
    typeof metafile.inputs !== "object" ||
    Array.isArray(metafile.inputs) ||
    (metafile.outputs !== undefined &&
      (typeof metafile.outputs !== "object" || Array.isArray(metafile.outputs)))
  ) {
    throw new Error(`${label} is not an esbuild metafile`);
  }
}

function isReviewedVirtualChromiumPackageInput(input) {
  const normalized = input.replaceAll("\\", "/");
  if (!normalized.startsWith("chromium-shared-images:")) return false;
  const { path, namespaced } = filesystemPathFromMetafileInput(normalized);
  return namespaced && path.endsWith(CHROMIUM_GENERATED_IMAGE_INPUT_SUFFIX);
}

function packageRootFromMetafilePath(input, originRoot) {
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("(disabled):")) return undefined;
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const { path: filesystemInput } = filesystemPathFromMetafileInput(
    normalized,
  );
  const filesystemMarkerIndex = filesystemInput.lastIndexOf(marker);
  if (filesystemMarkerIndex < 0) {
    throw new Error(`Cannot identify package root for esbuild input: ${input}`);
  }

  const packagePath = filesystemInput
    .slice(filesystemMarkerIndex + marker.length)
    .split("/");
  const packageSegments = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2)
    : packagePath.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((part) => !part)) {
    throw new Error(`Cannot identify package root for esbuild input: ${input}`);
  }
  return {
    name: packageSegments.join("/"),
    inputPath: resolve(originRoot, filesystemInput),
    root: resolve(
      originRoot,
      filesystemInput.slice(0, filesystemMarkerIndex + marker.length),
      ...packageSegments,
    ),
  };
}

export function filesystemPathFromMetafileInput(input) {
  if (/^[a-z]:\//i.test(input)) return { path: input, namespaced: false };
  const namespaced = input.match(/^([a-z][a-z0-9-]*):(.*)$/i);
  if (!namespaced) return { path: input, namespaced: false };
  const payload = namespaced[2];
  if (!/^(?:[a-z]:\/|\/)/i.test(payload)) {
    throw new Error(`Namespaced esbuild input has no absolute filesystem path: ${input}`);
  }
  return { path: payload, namespaced: true };
}

async function readPackageNotice(root, expectedName) {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.name !== expectedName ||
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
