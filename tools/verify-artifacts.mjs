import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { parse as parseYaml } from "yaml";
import { createHeadArchiveBuffer } from "./archive-firefox-source.mjs";
import {
  CHROMIUM_EMBEDDED_NOTICE_DIGESTS,
  CHROMIUM_UPSTREAM_PATHS,
  loadChromiumNativeRuntimeNoticeInputs,
  PINNED_CHROMIUM_REVISION,
  renderChromiumDerivedNoticeSection,
  renderChromiumNativeRuntimeNoticeSection,
} from "./browser-bundle-notices.mjs";
import {
  assertBrowserPackageRuntimeContract,
  assertRulesSourceJavaScriptContract,
} from "./browser-package-contract.mjs";
import { parseRuntimeMetadata } from "./runtime-metadata.mjs";
import {
  assertVsCodeExtensionIdentity,
  assertVsCodeReadme,
} from "./vscode-extension-identity.mjs";
import {
  assertVsixBundleMatchesLocalBuild,
} from "./vsix-bundle-parity.mjs";
import {
  assertTextEqual,
  assertVersion,
  compareAscii,
  normalizeArchivePath,
  rejectSensitivePath,
} from "./release-policy.mjs";

const VERSION = "0.3.0";
const CHROMIUM_NATIVE_PACKAGE_PIN = Object.freeze({
  packageName: "chrome-devtools-frontend",
  version: "1.0.1681091",
  gitHead: "23cccaa78f7458a5aad99c1af98dc1856d2494a3",
  integrity:
    "sha512-cXBay271CnEb+Y+Cxre3mjGDHFKhXVo9mGfNCVAruen/iwF+jnG6Z55mnC7yh078HD1rmKhBM9tKLKQbjVniVQ==",
});
const PRODUCT_DESCRIPTION =
  "Highlights styles and source code in your IDE for the selected DOM element. Pin-op by Volodymyr Moskvin. (c) 2026 Conus Vision.";
const EXPECTED_ARTIFACTS = new Map([
  [`pin-op-vscode-${VERSION}.vsix`, "vscode"],
  [`pin-op-chrome-${VERSION}.zip`, "chrome"],
  [`pin-op-firefox-${VERSION}.zip`, "firefox"],
  [`pin-op-firefox-source-${VERSION}.zip`, "firefox-source"],
]);
export const BROWSER_ARCHIVE_FILES = Object.freeze([
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "manifest.json",
  "dist/background.js",
  "dist/chromiumElementsRuntime.js",
  "dist/contentScript.js",
  "dist/devtools.html",
  "dist/devtools.js",
  "dist/icons/pin-op-16.png",
  "dist/icons/pin-op-32.png",
  "dist/icons/pin-op-48.png",
  "dist/icons/pin-op-96.png",
  "dist/icons/pin-op-128.png",
  "dist/devtools-elements.css",
  "dist/inspector-panel.html",
  "dist/inspectorPanel.js",
  "dist/panel.css",
  "dist/panel.html",
  "dist/panel.js",
  "dist/pin-op.svg",
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
  "extension/resources/pin-op.png",
  "extension/resources/pin-op.svg",
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
const chromiumUpstreamManifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "third_party/chromium-devtools-frontend/UPSTREAM.json"),
    "utf8",
  ),
);
const chromiumRootLicense = readFileSync(
  resolve(repositoryRoot, "third_party/chromium-devtools-frontend/LICENSE"),
  "utf8",
);
const chromiumDerivedNoticeSection = renderChromiumDerivedNoticeSection(
  chromiumUpstreamManifest,
  chromiumRootLicense,
);
const localNativeNoticeInputs = await loadChromiumNativeRuntimeNoticeInputs(
  repositoryRoot,
);
const chromiumNativeRuntimeNoticeSection =
  renderChromiumNativeRuntimeNoticeSection(localNativeNoticeInputs);
const vscodeReadme = await readFile(
  resolve(repositoryRoot, "extensions/vscode/README.md"),
);
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
  Object.freeze([".png", "image/png"]),
  Object.freeze([".svg", "image/svg+xml"]),
  Object.freeze([".txt", "text/plain"]),
  Object.freeze([".vsixmanifest", "text/xml"]),
  Object.freeze([".wasm", "application/wasm"]),
]);
const BROWSER_ICONS = Object.freeze({
  16: "dist/icons/pin-op-16.png",
  32: "dist/icons/pin-op-32.png",
  48: "dist/icons/pin-op-48.png",
  96: "dist/icons/pin-op-96.png",
  128: "dist/icons/pin-op-128.png",
});
const BROWSER_PERMISSIONS = Object.freeze([
  "activeTab",
  "clipboardRead",
  "scripting",
  "storage",
  "tabs",
]);
const BROWSER_HOST_PERMISSIONS = Object.freeze([
  "http://localhost/*",
  "http://127.0.0.1/*",
  "<all_urls>",
]);
const BROWSER_EXTENSION_CSP =
  "script-src 'self'; object-src 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*";
const BROWSER_MANIFEST_KEYS = Object.freeze({
  chrome: Object.freeze([
    "manifest_version",
    "name",
    "description",
    "version",
    "icons",
    "minimum_chrome_version",
    "devtools_page",
    "background",
    "permissions",
    "host_permissions",
    "content_security_policy",
  ]),
  firefox: Object.freeze([
    "manifest_version",
    "name",
    "description",
    "version",
    "icons",
    "devtools_page",
    "background",
    "permissions",
    "host_permissions",
    "content_security_policy",
    "browser_specific_settings",
  ]),
});
const FIREFOX_INSPECTOR_SOURCE_INPUTS = Object.freeze([
  ".gitattributes",
  "package.json",
  "pnpm-lock.yaml",
  "README.md",
  "CHANGELOG.md",
  "PRIVACY.md",
  "docs/architecture.md",
  "docs/security.md",
  "docs/protocol.md",
  "docs/mvp-usage.md",
  "docs/mvp-verification.md",
  "docs/installed-verification.md",
  "docs/firefox-source-submission.md",
  "docs/release.md",
  "docs/store-listings.md",
  "examples/basic-css/index.html",
  "examples/basic-css/dist/app.css",
  "examples/basic-css/dist/app.css.map",
  "examples/basic-css/src/card.scss",
  "tools/simulator/test/exampleFixtureServer.test.ts",
  "tools/test/installed-verification-doc.test.mjs",
  "tools/test/store-listings.test.mjs",
  "tools/test/archive-firefox-source.test.mjs",
  "third_party/chromium-devtools-frontend/.gitattributes",
  "third_party/chromium-devtools-frontend/LICENSE",
  "third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md",
  "third_party/chromium-devtools-frontend/README.pin-op.md",
  "third_party/chromium-devtools-frontend/RUNTIME.json",
  "third_party/chromium-devtools-frontend/UPSTREAM.json",
  "packages/devtools-elements-ui/.gitattributes",
  "packages/devtools-elements-ui/assets/devtools-elements.css",
  "packages/devtools-elements-ui/package.json",
  "packages/devtools-elements-ui/src/chromium/upstream/PinOpChromiumInspectorAdapter.ts",
  "packages/devtools-elements-ui/src/chromium/upstream/PinOpElementsTreeAdapter.ts",
  "packages/devtools-elements-ui/src/chromium/upstream/PinOpStylesSidebarAdapter.ts",
  "packages/devtools-elements-ui/src/contracts.ts",
  "packages/devtools-elements-ui/src/elementsInspectorShell.ts",
  "packages/devtools-elements-ui/src/elementsInspectorView.ts",
  "packages/devtools-elements-ui/src/index.ts",
  "packages/devtools-elements-ui/src/pseudoStateController.ts",
  "packages/devtools-elements-ui/src/upstreamRuntime.ts",
  "packages/devtools-elements-ui/test/elementsInspectorView.test.ts",
  "packages/devtools-elements-ui/test/elementsTreeOutline.test.ts",
  "packages/devtools-elements-ui/test/fixtures/elementsSession.ts",
  "packages/devtools-elements-ui/test/matchedStylesContract.test.ts",
  "packages/devtools-elements-ui/test/matchedStylesContract.types.ts",
  "packages/devtools-elements-ui/test/pseudoStateController.test.ts",
  "packages/devtools-elements-ui/test/public-export.mjs",
  "packages/devtools-elements-ui/test/support/fakeDocument.ts",
  "packages/devtools-elements-ui/test/support/fakeElementsBackend.ts",
  "packages/devtools-elements-ui/test/stylesSidebarPane.test.ts",
  "packages/devtools-elements-ui/test/types.tsconfig.json",
  "packages/devtools-elements-ui/tsconfig.json",
  "packages/browser-extension-core/package.json",
  "packages/browser-extension-core/assets/inspector-panel.html",
  "packages/browser-extension-core/assets/panel.css",
  "packages/browser-extension-core/assets/panel.html",
  "packages/browser-extension-core/assets/pin-op.svg",
  "packages/browser-extension-core/assets/icons/pin-op-16.png",
  "packages/browser-extension-core/assets/icons/pin-op-32.png",
  "packages/browser-extension-core/assets/icons/pin-op-48.png",
  "packages/browser-extension-core/assets/icons/pin-op-96.png",
  "packages/browser-extension-core/assets/icons/pin-op-128.png",
  "tools/archive-firefox-source.mjs",
  "tools/browser-bundle-notices.mjs",
  "tools/browser-chromium-inspector-entry.ts",
  "tools/browser-elements-runtime.mjs",
  "tools/browser-package-contract.mjs",
  "tools/browser-panel-assets.mjs",
  "tools/chromium-vendor-paths.mjs",
  "tools/chromium-devtools-runtime.mjs",
  "tools/chromium-devtools-styles-runtime.mjs",
  "tools/smoke-chromium-read-only-elements.mjs",
  "tools/smoke-chromium-read-only-inspector.mjs",
  "tools/smoke-chromium-read-only-styles.mjs",
  "tools/test/browser-bundle-notices.test.mjs",
  "tools/test/browser-elements-runtime.test.mjs",
  "tools/test/browser-panel-assets.test.mjs",
  "tools/test/chromium-devtools-runtime.test.mjs",
  "tools/test/chromium-styles-runtime.test.mjs",
  "tools/test/native-inspector-ux-gates.test.mjs",
  "tools/test/verify-browser-artifacts.test.mjs",
  "tools/update-chromium-derivations.mjs",
  "tools/vendor-chromium-elements.mjs",
  "tools/verify-artifacts.mjs",
  "tools/verify-chromium-elements-vendor.mjs",
  "extensions/test/browserExtensionContract.ts",
  "extensions/firefox/LICENSE",
  "extensions/firefox/THIRD_PARTY_NOTICES",
  "extensions/firefox/esbuild.mjs",
  "extensions/firefox/manifest.json",
  "extensions/firefox/package.json",
  "extensions/firefox/src/background.ts",
  "extensions/firefox/src/contentScript.ts",
  "extensions/firefox/src/devtools.html",
  "extensions/firefox/src/devtools.ts",
  "extensions/firefox/src/inspectorPanel.ts",
  "extensions/firefox/src/panel.ts",
  "extensions/firefox/test/adapter.test.ts",
  "extensions/firefox/test/manifest.test.ts",
  "extensions/firefox/test/panelAssets.test.ts",
  "extensions/firefox/tsconfig.json",
]);
const CHROMIUM_SOURCE_REPRODUCTION_INVENTORY = Object.freeze([
  {
    upstreamPath: "front_end/panels/elements/ElementsTreeOutline.ts",
    sha256: "36049536b7e146addc2de9784790d8ae630f28c1640b3b679506d9e4cc7bfd9d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
      localSha256: "13a888ecc9cf4faec200bcb6a0149c0de7ae726a7406c95b94201f5b69f75d40",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/ElementsTreeElement.ts",
    sha256: "40167299e234ad6378823514f2265b2e4fb5530821aeae4c3fcc39ae301ec07b",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
      localSha256: "882883d5a5231eff4d7aed88e58e5680690ef2a29948edd0e71926aecbe2eb64",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylesSidebarPane.ts",
    sha256: "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylesSidebarPane.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256: "43c30720702c295746c948b7eddf384e86eb36e6ef4a2cb82c1f39969fe3083e",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertiesSection.ts",
    sha256: "bd02a2628edd75360d29eb7da8630dd5b0ef9b5e409cf83bd20288fa52a293be",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertiesSection.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256: "2a23013161ed18920997793023f25a8fca5947bc036fcdf9310cf5da47e0c91f",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertyTreeElement.ts",
    sha256: "427124f750a785db8d64676c970ae1576c7c11df7136393e8f4b82e679ecba2d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256: "0fcb976c04ddc107ab372497fd2e1d816f9407500a4653ccc1b36028627bb1e9",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/PropertyRenderer.ts",
    sha256: "b13d5d5edede2f5dc0b8cb7e7d974f3b5cf69afd41e81c320f78466aa9e7464e",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/PropertyRenderer.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256: "a74c190d654652966d209ddeb5d763fdc3c5e29bbc4e77468d40c8ece39d4759",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertyUtils.ts",
    sha256: "f4fc4e139fe9fac7ef2632f0ae0042de18e01ec00d3b60159d6827edc0e0ee4b",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyUtils.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256: "fa1652b5e6ec341854d8e745f20465f9ec20a0bdfadcee70aaccfd978b19528f",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/elementsTreeOutline.css",
    sha256: "86b768a436167e97ca7c2e5cee622c122ba095d2fb6853a15aedf18b892f0c6d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256: "41dbf6fbb4b351bbd1f28298d36c0e20f834d32e5255709856604c0c79b3edec",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/stylesSidebarPane.css",
    sha256: "01d5198e52f4b1a2dea4b3d20631f756ecf7db5bedab093539e87b4569ede5aa",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256: "41dbf6fbb4b351bbd1f28298d36c0e20f834d32e5255709856604c0c79b3edec",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/stylePropertiesTreeOutline.css",
    sha256: "87bfbaeb3ddf0d33dd001c023d0ca64e6926fe27724af828074e8b2b7e432860",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256: "41dbf6fbb4b351bbd1f28298d36c0e20f834d32e5255709856604c0c79b3edec",
    }],
  },
]);
const CHROMIUM_SOURCE_REPRODUCTION_BY_PATH = new Map(
  CHROMIUM_SOURCE_REPRODUCTION_INVENTORY.map((file) => [file.upstreamPath, file]),
);

export async function verifyArtifacts(arguments_) {
  const artifacts = await collectArtifacts(arguments_);
  const missing = [...EXPECTED_ARTIFACTS.keys()].filter(
    (filename) => !artifacts.has(filename),
  );
  if (missing.length > 0) {
    throw new Error(`Missing required release artifacts: ${missing.join(", ")}`);
  }

  const browserArchives = new Map();
  for (const [filename, kind] of EXPECTED_ARTIFACTS) {
    const archive = readArchive(artifacts.get(filename), filename);
    if (kind === "vscode") await verifyVsix(archive, filename);
    else if (kind === "firefox-source") await verifySource(archive, filename);
    else {
      await verifyBrowser(archive, filename, kind);
      browserArchives.set(kind, archive);
    }
    console.log(`Verified ${filename} (${archive.files.size} files)`);
  }
  assertBrowserInspectorParity(
    browserArchives.get("chrome"),
    browserArchives.get("firefox"),
  );
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
  validateBrowserArchive(archive, filename, browser);

  const noticePath = resolve(repositoryRoot, "extensions", browser, "THIRD_PARTY_NOTICES");
  assertEqualFile(
    archive,
    filename,
    "THIRD_PARTY_NOTICES",
    await readFile(noticePath),
  );
}

export function validateBrowserArchive(archive, filename, browser) {
  assertExactArchivePaths(archive, filename, BROWSER_ARCHIVE_FILES);
  assertProjectLicense(archive, filename, "LICENSE");
  verifyBrowserManifest(
    parseJsonFile(archive, filename, "manifest.json"),
    filename,
    browser,
  );
  for (const [size, path] of Object.entries(BROWSER_ICONS)) {
    assertPngDimensions(archive.files.get(path), `${filename} ${path}`, Number(size));
  }
  verifyBrowserPanelIdentity(archive.files.get("dist/panel.html"), filename);
  assertChromiumDerivedNotices(archive, filename);
  assertBrowserPackageRuntimeContract(archive, {
    artifactLabel: filename,
    metadataLabel: `${filename} runtime metadata`,
    panelVariant: "inspector",
    platform: browser,
  });
}

function verifyBrowserPanelIdentity(panelBuffer, filename) {
  const panel = panelBuffer.toString("utf8");
  if (!panel.includes('src="./pin-op.svg"')) {
    throw new Error(`${filename} panel must reference ./pin-op.svg`);
  }
  if (
    !panel.includes("<title>Pin-op</title>") ||
    !panel.includes('id="panel-branding"') ||
    !/<span\b[^>]*class="product-name"[^>]*>[\s\S]*?\bPin-op<\/span>/.test(
      panel,
    )
  ) {
    throw new Error(
      `${filename} panel must present Pin-op in its title and branded footer`,
    );
  }
}

function verifyBrowserManifest(manifest, filename, browser) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${filename} has invalid manifest`);
  }
  if (manifest.manifest_version !== 3) {
    throw new Error(`${filename} has unexpected manifest_version`);
  }
  if (manifest.name !== "Pin-op") {
    throw new Error(`${filename} has unexpected manifest name`);
  }
  if (manifest.description !== PRODUCT_DESCRIPTION) {
    throw new Error(`${filename} has unexpected manifest description`);
  }
  if (!hasExactStringEntries(manifest.icons, BROWSER_ICONS)) {
    throw new Error(`${filename} has unexpected manifest icons`);
  }
  if (manifest.devtools_page !== "dist/devtools.html") {
    throw new Error(`${filename} has unexpected manifest devtools page`);
  }
  const expectedBackground = browser === "chrome"
    ? hasExactStringEntries(manifest.background, {
      service_worker: "dist/background.js",
    })
    : (
      manifest.background !== null &&
      typeof manifest.background === "object" &&
      !Array.isArray(manifest.background) &&
      Object.keys(manifest.background).length === 1 &&
      sameStringArray(manifest.background.scripts, ["dist/background.js"])
    );
  if (!expectedBackground) {
    throw new Error(`${filename} has unexpected manifest background`);
  }
  if (!sameStringArray(manifest.permissions, BROWSER_PERMISSIONS)) {
    throw new Error(`${filename} has unexpected manifest permissions`);
  }
  if (!sameStringArray(manifest.host_permissions, BROWSER_HOST_PERMISSIONS)) {
    throw new Error(`${filename} has unexpected manifest host permissions`);
  }
  if (
    Object.hasOwn(manifest, "optional_permissions") ||
    Object.hasOwn(manifest, "optional_host_permissions")
  ) {
    throw new Error(`${filename} has unexpected manifest optional permissions`);
  }
  const unexpectedKeys = Object.keys(manifest).filter(
    (key) => !BROWSER_MANIFEST_KEYS[browser].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `${filename} has unexpected manifest capability key ${unexpectedKeys[0]}`,
    );
  }
  if (!hasExactStringEntries(manifest.content_security_policy, {
    extension_pages: BROWSER_EXTENSION_CSP,
  })) {
    throw new Error(`${filename} has unexpected manifest content security policy`);
  }
  assertVersion(manifest.version, `${filename} manifest`, VERSION);
  if (browser === "chrome" && manifest.minimum_chrome_version !== "116") {
    throw new Error(`${filename} has unexpected minimum_chrome_version`);
  }
  if (
    browser === "firefox" &&
    manifest.browser_specific_settings?.gecko?.strict_min_version !== "142.0"
  ) {
    throw new Error(`${filename} has unexpected Firefox strict_min_version`);
  }
  if (
    browser === "firefox" &&
    manifest.browser_specific_settings?.gecko?.id !== "info@conus.vision"
  ) {
    throw new Error(`${filename} has unexpected Firefox Gecko ID`);
  }
  if (
    browser === "firefox" &&
    !hasExactFirefoxBrowserSpecificSettings(manifest.browser_specific_settings)
  ) {
    throw new Error(`${filename} has unexpected Firefox browser_specific_settings`);
  }
}

function hasExactFirefoxBrowserSpecificSettings(settings) {
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    !sameStringArray(Object.keys(settings), ["gecko"])
  ) {
    return false;
  }
  const gecko = settings.gecko;
  if (
    gecko === null ||
    typeof gecko !== "object" ||
    Array.isArray(gecko) ||
    !sameStringArray(Object.keys(gecko), [
      "id",
      "strict_min_version",
      "data_collection_permissions",
    ]) ||
    gecko.id !== "info@conus.vision" ||
    gecko.strict_min_version !== "142.0"
  ) {
    return false;
  }
  const permissions = gecko.data_collection_permissions;
  return (
    permissions !== null &&
    typeof permissions === "object" &&
    !Array.isArray(permissions) &&
    sameStringArray(Object.keys(permissions), ["required"]) &&
    sameStringArray(permissions.required, ["websiteContent", "websiteActivity"])
  );
}

function assertChromiumDerivedNotices(archive, filename) {
  const bytes = archive.files.get("THIRD_PARTY_NOTICES");
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${filename} is missing THIRD_PARTY_NOTICES`);
  }
  const notices = bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (
    countOccurrences(notices, chromiumDerivedNoticeSection) !== 1 ||
    countOccurrences(notices, chromiumNativeRuntimeNoticeSection) !== 1
  ) {
    throw new Error(`${filename} has incomplete Chromium-derived notices`);
  }
  const distinctEmbeddedNotices = new Map();
  for (const file of chromiumUpstreamManifest.files) {
    for (const notice of file.embeddedNotices) {
      distinctEmbeddedNotices.set(
        notice.sha256,
        notice.text.replaceAll("\r\n", "\n").trim(),
      );
    }
  }
  for (const text of distinctEmbeddedNotices.values()) {
    if (countOccurrences(notices, text) !== 1) {
      throw new Error(`${filename} has incomplete Chromium-derived notices`);
    }
  }
}

export function assertBrowserInspectorParity(chromeArchive, firefoxArchive) {
  if (!chromeArchive || !firefoxArchive) {
    throw new Error("Chrome and Firefox archives are required for Inspector parity");
  }
  for (const path of [
    "dist/devtools-elements.css",
    "dist/inspector-panel.html",
    "dist/inspectorPanel.js",
    "dist/chromiumElementsRuntime.js",
  ]) {
    const chromeBytes = chromeArchive.files.get(path);
    const firefoxBytes = firefoxArchive.files.get(path);
    if (
      !Buffer.isBuffer(chromeBytes) ||
      !Buffer.isBuffer(firefoxBytes) ||
      !chromeBytes.equals(firefoxBytes)
    ) {
      throw new Error(`Chrome and Firefox ${path} must be byte-identical`);
    }
  }
  const chromeNotices = chromeArchive.files.get("THIRD_PARTY_NOTICES");
  const firefoxNotices = firefoxArchive.files.get("THIRD_PARTY_NOTICES");
  if (
    !Buffer.isBuffer(chromeNotices) ||
    !Buffer.isBuffer(firefoxNotices) ||
    !chromeNotices.equals(firefoxNotices)
  ) {
    throw new Error("Chrome and Firefox Chromium notice sections must be identical");
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
  assertVsCodeReadme(
    archive.files.get("extension/readme.md"),
    vscodeReadme,
    filename,
  );

  const manifest = parseJsonFile(archive, filename, "extension/package.json");
  assertVsCodeExtensionIdentity(manifest, filename);
  assertVersion(manifest.version, `${filename} extension`, VERSION);
  if (manifest.main !== "./dist/extension.cjs") {
    throw new Error(`${filename} has unexpected extension main: ${manifest.main}`);
  }
  assertPngDimensions(
    archive.files.get("extension/resources/pin-op.png"),
    `${filename} extension/resources/pin-op.png`,
    128,
  );
  validateVsixXmlMetadata(archive, filename, manifest);
  parseRuntimeMetadata(
    archive.files.get("extension/dist/runtime-metadata.json"),
    {
      expectedProtocolVersion: 7,
      label: `${filename} runtime metadata`,
    },
  );

  const bundleBytes = archive.files.get("extension/dist/extension.cjs");
  assertVsixBundleMatchesLocalBuild(bundleBytes, filename);
  const bundle = bundleBytes.toString("utf8");
  for (const capability of [
    "source-navigation",
    "source-presentation",
  ]) {
    if (!bundle.includes(capability)) {
      throw new Error(
        `${filename} VSIX bundle is missing current ${capability} capability`,
      );
    }
  }
  for (const marker of [
    "source.matches",
    "source.open",
    "source.navigate",
    "source.navigationState",
    "matchId",
  ]) {
    if (!bundle.includes(marker)) {
      throw new Error(`${filename} VSIX bundle is missing current ${marker} marker`);
    }
  }
  assertRulesSourceJavaScriptContract(bundle, `${filename} VSIX bundle`, {
    requiredStrings: [
      ["Rules source capability", "rules-sources"],
      ["Rules source publication", "rules.sources"],
      ["Rules source open", "rules.open"],
    ],
  });
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
  assertFirefoxSourceReproductionInputs(archive.files, filename);
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

function hasExactStringEntries(actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const expectedEntries = Object.entries(expected);
  const actualKeys = Object.keys(actual);
  return actualKeys.length === expectedEntries.length && expectedEntries.every(
    ([key, value]) => actual[key] === value,
  );
}

export function requiredFirefoxSourceReproductionPaths(
  manifest,
  nativeRuntime = localNativeNoticeInputs.runtimeManifest,
  domManifest = localNativeNoticeInputs.domManifest,
  stylesManifest = localNativeNoticeInputs.stylesManifest,
) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.files)) {
    throw new Error("Invalid Chromium upstream source inventory");
  }
  assertPinnedChromiumSourceInventory(manifest, "Chromium upstream source inventory");
  const paths = new Set(FIREFOX_INSPECTOR_SOURCE_INPUTS);
  for (const [overlayRoot, overlayManifest] of nativeOverlaySources(
    nativeRuntime,
    domManifest,
    stylesManifest,
    "Chromium native source inventory",
  )) {
    paths.add(`${overlayRoot}/manifest.json`);
    for (const path of Object.keys(overlayManifest.overlayFiles)) {
      paths.add(`${overlayRoot}/${path}`);
    }
  }
  for (const file of manifest.files) {
    paths.add(
      `third_party/chromium-devtools-frontend/upstream/${file.upstreamPath}`,
    );
    for (const target of file.derivedTargets) {
      if (target?.localSha256 === "pending") continue;
      paths.add(target.path);
    }
  }
  return [...paths].sort(compareAscii);
}

export function assertFirefoxSourceReproductionInputs(files, label) {
  const manifestPath = "third_party/chromium-devtools-frontend/UPSTREAM.json";
  requireSourceInput(files, label, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(files.get(manifestPath).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} has invalid ${manifestPath}: ${error.message}`);
  }
  if (
    manifest?.revision !== PINNED_CHROMIUM_REVISION ||
    manifest.license !== "LICENSE" ||
    !/^[0-9a-f]{64}$/.test(manifest.licenseSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 10
  ) {
    throw new Error(`${label} has invalid Chromium upstream source inventory`);
  }
  assertPinnedChromiumSourceInventory(manifest, label);
  const nativeSources = assertFirefoxNativeRuntimeSources(files, label);
  for (const path of requiredFirefoxSourceReproductionPaths(
    manifest,
    nativeSources.runtime,
    nativeSources.domManifest,
    nativeSources.stylesManifest,
  )) {
    requireSourceInput(files, label, path);
  }

  const embeddedNotices = new Map();
  for (const file of manifest.files) {
    if (
      typeof file?.upstreamPath !== "string" ||
      !/^front_end\/panels\/elements\/[A-Za-z0-9._-]+$/.test(file.upstreamPath)
    ) {
      throw new Error(`${label} has invalid Chromium upstream source path`);
    }
    if (!Array.isArray(file.embeddedNotices) || file.embeddedNotices.length === 0) {
      throw new Error(`${label} source ${file.upstreamPath} is missing an embedded notice`);
    }
    for (const notice of file.embeddedNotices) {
      if (
        !/^[0-9a-f]{64}$/.test(notice?.sha256 ?? "") ||
        typeof notice?.text !== "string" ||
        !notice.text.trim()
      ) {
        throw new Error(`${label} has invalid embedded notice metadata`);
      }
      const normalizedText = notice.text.replaceAll("\r\n", "\n").trim();
      const existing = embeddedNotices.get(notice.sha256);
      if (existing !== undefined && existing !== normalizedText) {
        throw new Error(`${label} has conflicting embedded notice metadata`);
      }
      embeddedNotices.set(notice.sha256, normalizedText);
    }
    if (!Array.isArray(file.derivedTargets) || file.derivedTargets.length === 0) {
      throw new Error(`${label} source ${file.upstreamPath} has no derived target`);
    }

    const upstreamArchivePath =
      `third_party/chromium-devtools-frontend/upstream/${file.upstreamPath}`;
    if (sha256Bytes(files.get(upstreamArchivePath)) !== file.sha256) {
      throw new Error(`${label} source ${file.upstreamPath} has invalid upstream sha256 bytes`);
    }
    for (const target of file.derivedTargets) {
      if (target.localSha256 === "pending") continue;
      if (sha256Bytes(files.get(target.path)) !== target.localSha256) {
        throw new Error(
          `${label} derived target ${target.path} has invalid derived sha256 bytes`,
        );
      }
    }
  }
  const embeddedDigests = [...embeddedNotices.keys()].sort(compareAscii);
  if (!sameStringArray(embeddedDigests, CHROMIUM_EMBEDDED_NOTICE_DIGESTS)) {
    throw new Error(`${label} has unexpected embedded notice inventory`);
  }
  try {
    renderChromiumDerivedNoticeSection(
      manifest,
      files.get("third_party/chromium-devtools-frontend/LICENSE").toString("utf8"),
    );
  } catch (error) {
    throw new Error(
      `${label} has invalid Chromium notice metadata: ${error.message}`,
    );
  }
}

function assertFirefoxNativeRuntimeSources(files, label) {
  const runtimePath = "third_party/chromium-devtools-frontend/RUNTIME.json";
  requireSourceInput(files, label, runtimePath);
  const runtime = parseSourceJson(files, runtimePath, label);
  const version = runtime?.package?.version;
  if (
    runtime?.schemaVersion !== 1 ||
    runtime?.package?.packageName !== CHROMIUM_NATIVE_PACKAGE_PIN.packageName ||
    typeof version !== "string" ||
    version !== CHROMIUM_NATIVE_PACKAGE_PIN.version ||
    runtime.package.gitHead !== CHROMIUM_NATIVE_PACKAGE_PIN.gitHead ||
    runtime.package.integrity !== CHROMIUM_NATIVE_PACKAGE_PIN.integrity ||
    runtime?.repository !==
      "https://github.com/ChromeDevTools/devtools-frontend.git" ||
    runtime?.license?.spdx !== "BSD-3-Clause" ||
    runtime.license.path !== "LICENSE" ||
    runtime.license.sha256 !== chromiumUpstreamManifest.licenseSha256
  ) {
    throw new Error(`${label} has invalid Chromium native RUNTIME.json metadata`);
  }
  assertFirefoxNativeDependencyPin(files, label, runtime);
  const domRoot = `third_party/chromium-devtools-frontend/patches/${version}`;
  const stylesRoot =
    `third_party/chromium-devtools-frontend/styles-overlay/${version}`;
  const domManifestPath = `${domRoot}/manifest.json`;
  const stylesManifestPath = `${stylesRoot}/manifest.json`;
  requireSourceInput(files, label, domManifestPath);
  requireSourceInput(files, label, stylesManifestPath);
  const domManifest = parseSourceJson(files, domManifestPath, label);
  const stylesManifest = parseSourceJson(files, stylesManifestPath, label);
  assertNativeOverlayPackageMetadata(runtime, domManifest, stylesManifest, label);
  assertNativeRuntimeDescriptorLinkage(
    runtime.readOnlyElementsRuntime,
    {
      overlayRoot: domRoot,
      manifestSha256: sha256Bytes(files.get(domManifestPath)),
      entryPoint: domManifest.entryPoint,
      upstreamInputClosure: domManifest.reviewedInputClosure,
      overlayInputClosure: domManifest.reviewedOverlayClosure,
      requiredLicenseFiles: domManifest.requiredLicenseFiles,
    },
    label,
    "DOM",
  );
  assertNativeRuntimeDescriptorLinkage(
    runtime.readOnlyStylesRuntime,
    {
      overlayRoot: stylesRoot,
      manifestSha256: sha256Bytes(files.get(stylesManifestPath)),
      entryPoint: stylesManifest.entryPoint,
      packageInputClosure: stylesManifest.reviewedPackageClosure,
      overlayInputClosure: stylesManifest.reviewedStylesOverlayClosure,
      requiredLicenseFiles: stylesManifest.requiredLicenseFiles,
    },
    label,
    "Rules",
  );
  for (const [overlayRoot, manifest] of nativeOverlaySources(
    runtime,
    domManifest,
    stylesManifest,
    label,
  )) {
    const declaredPaths = Object.keys(manifest.overlayFiles).sort(compareAscii);
    for (const path of declaredPaths) {
      const archivePath = `${overlayRoot}/${path}`;
      requireSourceInput(files, label, archivePath);
      if (sha256Bytes(files.get(archivePath)) !== manifest.overlayFiles[path]) {
        throw new Error(`${label} native runtime input ${archivePath} has invalid sha256 bytes`);
      }
    }
    const actualPaths = [...files]
      .filter(([path, bytes]) =>
        Buffer.isBuffer(bytes) &&
        path.startsWith(`${overlayRoot}/`) &&
        path !== `${overlayRoot}/manifest.json`
      )
      .map(([path]) => path.slice(overlayRoot.length + 1))
      .sort(compareAscii);
    if (!sameStringArray(actualPaths, declaredPaths)) {
      throw new Error(`${label} has unexpected Chromium native overlay path inventory`);
    }
  }
  return { runtime, domManifest, stylesManifest };
}

function assertFirefoxNativeDependencyPin(files, label, runtime) {
  const packagePath = "package.json";
  const lockfilePath = "pnpm-lock.yaml";
  requireSourceInput(files, label, packagePath);
  requireSourceInput(files, label, lockfilePath);
  const rootManifest = parseSourceJson(files, packagePath, label);
  if (
    rootManifest?.devDependencies?.[CHROMIUM_NATIVE_PACKAGE_PIN.packageName] !==
      CHROMIUM_NATIVE_PACKAGE_PIN.version
  ) {
    throw new Error(`${label} has invalid native Chromium root dependency package pin`);
  }

  let lockfile;
  try {
    lockfile = parseYaml(files.get(lockfilePath).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} has invalid ${lockfilePath}: ${error.message}`);
  }
  const packageKey =
    `${CHROMIUM_NATIVE_PACKAGE_PIN.packageName}@${CHROMIUM_NATIVE_PACKAGE_PIN.version}`;
  const importer = lockfile?.importers?.["."]?.devDependencies?.[
    CHROMIUM_NATIVE_PACKAGE_PIN.packageName
  ];
  const nativePackageKeys = Object.keys(lockfile?.packages ?? {})
    .filter((key) => key.startsWith(`${CHROMIUM_NATIVE_PACKAGE_PIN.packageName}@`))
    .sort(compareAscii);
  const nativeSnapshotKeys = Object.keys(lockfile?.snapshots ?? {})
    .filter((key) => key.startsWith(`${CHROMIUM_NATIVE_PACKAGE_PIN.packageName}@`))
    .sort(compareAscii);
  if (
    lockfile?.lockfileVersion !== "9.0" ||
    importer?.specifier !== CHROMIUM_NATIVE_PACKAGE_PIN.version ||
    importer?.version !== CHROMIUM_NATIVE_PACKAGE_PIN.version ||
    !sameStringArray(nativePackageKeys, [packageKey]) ||
    !sameStringArray(nativeSnapshotKeys, [packageKey])
  ) {
    throw new Error(`${label} has invalid native Chromium lockfile pin`);
  }
  if (
    lockfile.packages[packageKey]?.resolution?.integrity !==
      CHROMIUM_NATIVE_PACKAGE_PIN.integrity ||
    runtime.package.integrity !== CHROMIUM_NATIVE_PACKAGE_PIN.integrity
  ) {
    throw new Error(`${label} has invalid native Chromium lockfile integrity`);
  }
}

function parseSourceJson(files, path, label) {
  try {
    return JSON.parse(files.get(path).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} has invalid ${path}: ${error.message}`);
  }
}

function nativeOverlaySources(runtime, domManifest, stylesManifest, label) {
  const version = runtime?.package?.version;
  const domRoot = `third_party/chromium-devtools-frontend/patches/${version}`;
  const stylesRoot =
    `third_party/chromium-devtools-frontend/styles-overlay/${version}`;
  if (
    runtime?.readOnlyElementsRuntime?.overlayRoot !== domRoot ||
    runtime?.readOnlyStylesRuntime?.overlayRoot !== stylesRoot
  ) {
    throw new Error(`${label} has invalid Chromium native overlay roots`);
  }
  for (const [owner, manifest] of [
    ["DOM", domManifest],
    ["Rules", stylesManifest],
  ]) {
    for (const key of [
      "overlayFiles",
      "upstreamFiles",
      "requiredImageFiles",
      "requiredLicenseFiles",
    ]) {
      const inventory = manifest?.[key];
      if (
        !inventory ||
        typeof inventory !== "object" ||
        Array.isArray(inventory) ||
        Object.keys(inventory).length === 0
      ) {
        throw new Error(`${label} has invalid Chromium ${owner} ${key} inventory`);
      }
      for (const [path, digest] of Object.entries(inventory)) {
        if (!isApprovedNativeRelativePath(path) || !/^[0-9a-f]{64}$/.test(digest)) {
          throw new Error(`${label} has invalid Chromium ${owner} ${key} metadata`);
        }
      }
    }
    if (
      !isApprovedNativeRelativePath(manifest.entryPoint) ||
      !Object.hasOwn(manifest.overlayFiles, manifest.entryPoint)
    ) {
      throw new Error(`${label} has invalid Chromium ${owner} entrypoint metadata`);
    }
  }
  return [
    [domRoot, domManifest],
    [stylesRoot, stylesManifest],
  ];
}

function assertNativeOverlayPackageMetadata(runtime, domManifest, stylesManifest, label) {
  for (const [owner, manifest] of [
    ["DOM", domManifest],
    ["Rules", stylesManifest],
  ]) {
    if (
      manifest?.schemaVersion !== 1 ||
      manifest?.package?.name !== runtime.package.packageName ||
      manifest.package.version !== runtime.package.version ||
      manifest.package.gitHead !== runtime.package.gitHead
    ) {
      throw new Error(`${label} has invalid Chromium ${owner} package metadata`);
    }
  }
  if (
    stylesManifest.package.integrity !== runtime.package.integrity ||
    stylesManifest.package.license !== runtime.license.spdx
  ) {
    throw new Error(`${label} has invalid Chromium Rules integrity/license metadata`);
  }
}

function assertNativeRuntimeDescriptorLinkage(
  actual,
  expected,
  label,
  owner,
) {
  if (
    !actual ||
    typeof actual !== "object" ||
    Array.isArray(actual) ||
    Object.entries(expected).some(
      ([key, value]) => !isDeepStrictEqual(actual[key], value),
    )
  ) {
    throw new Error(
      `${label} has invalid Chromium ${owner} runtime manifest linkage`,
    );
  }
}

function isApprovedNativeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function assertPinnedChromiumSourceInventory(manifest, label) {
  const upstreamPaths = manifest.files
    .map((file) => file?.upstreamPath)
    .sort(compareAscii);
  if (!sameStringArray(upstreamPaths, CHROMIUM_UPSTREAM_PATHS)) {
    throw new Error(`${label} has unexpected Chromium upstream path inventory`);
  }

  for (const file of manifest.files) {
    const expected = CHROMIUM_SOURCE_REPRODUCTION_BY_PATH.get(file.upstreamPath);
    if (!expected || file.sha256 !== expected.sha256) {
      throw new Error(`${label} has unexpected upstream sha256 metadata`);
    }
    if (
      !Array.isArray(file.derivedTargets) ||
      file.derivedTargets.length !== expected.derivedTargets.length
    ) {
      throw new Error(`${label} has unexpected derived target inventory`);
    }
    for (let index = 0; index < expected.derivedTargets.length; index += 1) {
      const target = file.derivedTargets[index];
      const expectedTarget = expected.derivedTargets[index];
      if (!isApprovedDerivedTargetPath(target?.path)) {
        throw new Error(`${label} has derived target path outside the approved root`);
      }
      if (
        !hasExactStringEntries(target, expectedTarget)
      ) {
        throw new Error(`${label} has unexpected derived target mapping`);
      }
    }
  }
}

function isApprovedDerivedTargetPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("packages/devtools-elements-ui/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSourceInput(files, label, path) {
  if (typeof path !== "string" || !Buffer.isBuffer(files.get(path))) {
    throw new Error(`${label} is missing Chromium Inspector source input ${path}`);
  }
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function countOccurrences(text, needle) {
  return needle ? text.split(needle).length - 1 : 0;
}

export function assertPngDimensions(buffer, label, expectedSize) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} must be a valid PNG`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `${label} must be ${expectedSize}x${expectedSize}; received ${width}x${height}`,
    );
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
