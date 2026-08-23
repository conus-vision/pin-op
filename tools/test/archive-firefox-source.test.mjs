import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { archiveArguments } from "../archive-firefox-source.mjs";
import * as artifactVerifier from "../verify-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstreamManifestPath =
  "third_party/chromium-devtools-frontend/UPSTREAM.json";
const EXPECTED_NOTICE_DIGESTS = Object.freeze([
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
const EXPECTED_UPSTREAM_PATHS = Object.freeze([
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
const EXPECTED_FIXED_SOURCE_PATHS = Object.freeze([
  ".gitattributes",
  "package.json",
  "pnpm-lock.yaml",
  "third_party/chromium-devtools-frontend/.gitattributes",
  "third_party/chromium-devtools-frontend/LICENSE",
  "third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md",
  "third_party/chromium-devtools-frontend/README.pin-op.md",
  "third_party/chromium-devtools-frontend/UPSTREAM.json",
  "packages/devtools-elements-ui/.gitattributes",
  "packages/devtools-elements-ui/assets/devtools-elements.css",
  "packages/devtools-elements-ui/package.json",
  "packages/devtools-elements-ui/src/contracts.ts",
  "packages/devtools-elements-ui/src/elementsInspectorView.ts",
  "packages/devtools-elements-ui/src/index.ts",
  "packages/devtools-elements-ui/test/elementsInspectorView.test.ts",
  "packages/devtools-elements-ui/test/elementsTreeOutline.test.ts",
  "packages/devtools-elements-ui/test/fixtures/elementsSession.ts",
  "packages/devtools-elements-ui/test/public-export.mjs",
  "packages/devtools-elements-ui/test/support/fakeDocument.ts",
  "packages/devtools-elements-ui/test/support/fakeElementsBackend.ts",
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
  "tools/browser-package-contract.mjs",
  "tools/browser-panel-assets.mjs",
  "tools/chromium-vendor-paths.mjs",
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

test("source archive scopes Git safe.directory to the current repository", () => {
  const repositoryRoot = resolve("fixtures", "pin-op");
  const portableRepositoryRoot = repositoryRoot.replaceAll("\\", "/");

  assert.deepEqual(
    archiveArguments(repositoryRoot),
    [
      "-c",
      `safe.directory=${portableRepositoryRoot}`,
      "-c",
      "core.autocrlf=false",
      "archive",
      "--format=zip",
      "HEAD",
    ],
  );
});

test("source archive requires every Chromium Inspector reproduction input", () => {
  assert.equal(
    typeof artifactVerifier.assertFirefoxSourceReproductionInputs,
    "function",
  );
  const files = chromiumInspectorSourceFixture();
  const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
  assert.equal(
    typeof artifactVerifier.requiredFirefoxSourceReproductionPaths,
    "function",
  );
  const requiredPaths = expectedSourcePaths(manifest);
  assert.deepEqual(
    artifactVerifier.requiredFirefoxSourceReproductionPaths(manifest),
    requiredPaths,
  );
  assert.doesNotThrow(() =>
    artifactVerifier.assertFirefoxSourceReproductionInputs(
      files,
      "fixture source archive",
    ),
  );

  for (const missingPath of requiredPaths) {
    const incomplete = new Map(files);
    incomplete.delete(missingPath);
    assert.throws(
      () => artifactVerifier.assertFirefoxSourceReproductionInputs(
        incomplete,
        "fixture source archive",
      ),
      new RegExp(escapeRegex(missingPath), "i"),
      missingPath,
    );
  }
});

test("source archive requires the complete embedded notice inventory", () => {
  assert.equal(
    typeof artifactVerifier.assertFirefoxSourceReproductionInputs,
    "function",
  );
  const files = chromiumInspectorSourceFixture();
  const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
  manifest.files[0].embeddedNotices = [];
  files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));

  assert.throws(
    () => artifactVerifier.assertFirefoxSourceReproductionInputs(
      files,
      "fixture source archive",
    ),
    /embedded notice/i,
  );
});

test("source archive locks the exact embedded notice digest set", () => {
  const files = chromiumInspectorSourceFixture();
  const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
  const currentDigests = distinctNoticeDigests(manifest);
  assert.deepEqual(currentDigests, EXPECTED_NOTICE_DIGESTS);

  const replaced = currentDigests[2];
  for (const file of manifest.files) {
    for (const notice of file.embeddedNotices) {
      if (notice.sha256 === replaced) {
        notice.sha256 = "f".repeat(64);
      }
    }
  }
  files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));
  assert.throws(
    () => artifactVerifier.assertFirefoxSourceReproductionInputs(
      files,
      "fixture source archive",
    ),
    /embedded notice inventory/i,
  );
});

test("source archive rejects conflicting text for one embedded notice digest", () => {
  const files = chromiumInspectorSourceFixture();
  const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
  const repeated = manifest.files
    .flatMap((file) => file.embeddedNotices)
    .find((notice, index, notices) =>
      index > notices.findIndex((candidate) => candidate.sha256 === notice.sha256),
    );
  assert.ok(repeated);
  repeated.text += "\nconflict";
  files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));

  assert.throws(
    () => artifactVerifier.assertFirefoxSourceReproductionInputs(
      files,
      "fixture source archive",
    ),
    /conflicting embedded notice/i,
  );
});

test("source archive locks the exact unique Chromium upstream path inventory", () => {
  const baseline = chromiumInspectorSourceFixture();
  const baselineManifest = JSON.parse(
    baseline.get(upstreamManifestPath).toString("utf8"),
  );
  assert.deepEqual(
    baselineManifest.files.map((file) => file.upstreamPath).sort(compareAscii),
    EXPECTED_UPSTREAM_PATHS,
  );

  for (const mutate of [
    (manifest, files) => {
      manifest.files.at(-1).upstreamPath = manifest.files[0].upstreamPath;
    },
    (manifest, files) => {
      const file = manifest.files.at(-1);
      const originalPath = file.upstreamPath;
      file.upstreamPath = "front_end/panels/elements/Injected.ts";
      files.set(
        `third_party/chromium-devtools-frontend/upstream/${file.upstreamPath}`,
        files.get(
          `third_party/chromium-devtools-frontend/upstream/${originalPath}`,
        ),
      );
    },
  ]) {
    const files = new Map(baseline);
    const manifest = structuredClone(baselineManifest);
    mutate(manifest, files);
    files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));
    assert.throws(
      () => artifactVerifier.assertFirefoxSourceReproductionInputs(
        files,
        "fixture source archive",
      ),
      /upstream path inventory/i,
    );
  }
});

test("source archive confines derived targets to the approved repository roots", () => {
  for (const injectedPath of [
    "../escape.ts",
    "docs/injected.ts",
  ]) {
    const files = chromiumInspectorSourceFixture();
    const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
    const target = manifest.files[0].derivedTargets[0];
    const originalBytes = files.get(target.path);
    assert.ok(originalBytes);
    files.set(injectedPath, originalBytes);
    target.path = injectedPath;
    files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => artifactVerifier.assertFirefoxSourceReproductionInputs(
        files,
        "fixture source archive",
      ),
      /derived target (?:path|inventory|mapping)|repo-relative|approved root/i,
      injectedPath,
    );
  }
});

test("source archive verifies pinned upstream and derived bytes", () => {
  for (const kind of ["upstream", "derived"]) {
    const files = chromiumInspectorSourceFixture();
    const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
    const path = kind === "upstream"
      ? `third_party/chromium-devtools-frontend/upstream/${manifest.files[0].upstreamPath}`
      : manifest.files[0].derivedTargets[0].path;
    files.set(path, Buffer.from(`tampered ${kind} bytes`));

    assert.throws(
      () => artifactVerifier.assertFirefoxSourceReproductionInputs(
        files,
        "fixture source archive",
      ),
      new RegExp(`${kind}.*(?:sha256|hash)|(?:sha256|hash).*${kind}`, "i"),
      kind,
    );
  }
});

test("source archive locks every derived target mapping and digest", () => {
  for (const mutate of [
    (target) => { target.changeRecord = "PIN_OP_CHANGES.md#injected"; },
    (target) => { target.localSha256 = "f".repeat(64); },
  ]) {
    const files = chromiumInspectorSourceFixture();
    const manifest = JSON.parse(files.get(upstreamManifestPath).toString("utf8"));
    mutate(manifest.files[0].derivedTargets[0]);
    files.set(upstreamManifestPath, Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => artifactVerifier.assertFirefoxSourceReproductionInputs(
        files,
        "fixture source archive",
      ),
      /derived target (?:inventory|mapping|sha256|hash)/i,
    );
  }
});

function chromiumInspectorSourceFixture() {
  const manifestBytes = readFileSync(resolve(repositoryRoot, upstreamManifestPath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const files = new Map([
    [upstreamManifestPath, manifestBytes],
    [
      "third_party/chromium-devtools-frontend/LICENSE",
      readFileSync(
        resolve(repositoryRoot, "third_party/chromium-devtools-frontend/LICENSE"),
      ),
    ],
  ]);
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    ".gitattributes",
    "third_party/chromium-devtools-frontend/.gitattributes",
    "third_party/chromium-devtools-frontend/README.pin-op.md",
    "third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md",
    "packages/devtools-elements-ui/.gitattributes",
    "packages/devtools-elements-ui/package.json",
    "packages/devtools-elements-ui/src/index.ts",
    "packages/devtools-elements-ui/src/contracts.ts",
    "packages/devtools-elements-ui/src/elementsInspectorView.ts",
    "packages/devtools-elements-ui/assets/devtools-elements.css",
    "packages/devtools-elements-ui/test/elementsInspectorView.test.ts",
    "packages/devtools-elements-ui/test/elementsTreeOutline.test.ts",
    "packages/devtools-elements-ui/test/fixtures/elementsSession.ts",
    "packages/devtools-elements-ui/test/public-export.mjs",
    "packages/devtools-elements-ui/test/support/fakeDocument.ts",
    "packages/devtools-elements-ui/test/support/fakeElementsBackend.ts",
    "packages/devtools-elements-ui/tsconfig.json",
    "packages/browser-extension-core/package.json",
    "packages/browser-extension-core/assets/panel.html",
    "packages/browser-extension-core/assets/inspector-panel.html",
    "packages/browser-extension-core/assets/panel.css",
    "packages/browser-extension-core/assets/pin-op.svg",
    "packages/browser-extension-core/assets/icons/pin-op-16.png",
    "packages/browser-extension-core/assets/icons/pin-op-32.png",
    "packages/browser-extension-core/assets/icons/pin-op-48.png",
    "packages/browser-extension-core/assets/icons/pin-op-96.png",
    "packages/browser-extension-core/assets/icons/pin-op-128.png",
    "tools/browser-panel-assets.mjs",
    "tools/browser-bundle-notices.mjs",
    "tools/browser-package-contract.mjs",
    "tools/chromium-vendor-paths.mjs",
    "tools/archive-firefox-source.mjs",
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
    "extensions/firefox/tsconfig.json",
    "extensions/firefox/src/background.ts",
    "extensions/firefox/src/contentScript.ts",
    "extensions/firefox/src/devtools.html",
    "extensions/firefox/src/devtools.ts",
    "extensions/firefox/src/inspectorPanel.ts",
    "extensions/firefox/src/panel.ts",
    "extensions/firefox/test/adapter.test.ts",
    "extensions/firefox/test/manifest.test.ts",
    "extensions/firefox/test/panelAssets.test.ts",
  ]) {
    files.set(path, Buffer.from(`fixture ${path}`));
  }
  for (const file of manifest.files) {
    const upstreamPath =
      `third_party/chromium-devtools-frontend/upstream/${file.upstreamPath}`;
    files.set(upstreamPath, readFileSync(resolve(repositoryRoot, upstreamPath)));
    for (const target of file.derivedTargets) {
      if (target.localSha256 !== "pending") {
        files.set(target.path, readFileSync(resolve(repositoryRoot, target.path)));
      }
    }
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedSourcePaths(manifest) {
  const paths = new Set(EXPECTED_FIXED_SOURCE_PATHS);
  for (const file of manifest.files) {
    paths.add(
      `third_party/chromium-devtools-frontend/upstream/${file.upstreamPath}`,
    );
    for (const target of file.derivedTargets) {
      if (target.localSha256 !== "pending") paths.add(target.path);
    }
  }
  return [...paths].sort(compareAscii);
}

function distinctNoticeDigests(manifest) {
  return [...new Set(
    manifest.files.flatMap((file) =>
      file.embeddedNotices.map((notice) => notice.sha256),
    ),
  )].sort(compareAscii);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
