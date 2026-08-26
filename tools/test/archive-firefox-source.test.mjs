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
const EXPECTED_CHROMIUM_PIN = Object.freeze({
  repository: "https://github.com/ChromeDevTools/devtools-frontend.git",
  revision: "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280",
  importedAt: "2026-08-22",
  license: "LICENSE",
  licenseSha256:
    "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
});
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
const EXPECTED_CHROMIUM_SOURCE_INVENTORY = Object.freeze([
  {
    upstreamPath: "front_end/panels/elements/ElementsTreeElement.ts",
    sha256: "40167299e234ad6378823514f2265b2e4fb5530821aeae4c3fcc39ae301ec07b",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
      localSha256:
        "882883d5a5231eff4d7aed88e58e5680690ef2a29948edd0e71926aecbe2eb64",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/ElementsTreeOutline.ts",
    sha256: "36049536b7e146addc2de9784790d8ae630f28c1640b3b679506d9e4cc7bfd9d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts",
      changeRecord: "PIN_OP_CHANGES.md#dom-tree",
      localSha256:
        "13a888ecc9cf4faec200bcb6a0149c0de7ae726a7406c95b94201f5b69f75d40",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/PropertyRenderer.ts",
    sha256: "b13d5d5edede2f5dc0b8cb7e7d974f3b5cf69afd41e81c320f78466aa9e7464e",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/PropertyRenderer.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256:
        "a74c190d654652966d209ddeb5d763fdc3c5e29bbc4e77468d40c8ece39d4759",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertiesSection.ts",
    sha256: "bd02a2628edd75360d29eb7da8630dd5b0ef9b5e409cf83bd20288fa52a293be",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertiesSection.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256:
        "2a23013161ed18920997793023f25a8fca5947bc036fcdf9310cf5da47e0c91f",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertyTreeElement.ts",
    sha256: "427124f750a785db8d64676c970ae1576c7c11df7136393e8f4b82e679ecba2d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyTreeElement.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256:
        "0fcb976c04ddc107ab372497fd2e1d816f9407500a4653ccc1b36028627bb1e9",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylePropertyUtils.ts",
    sha256: "f4fc4e139fe9fac7ef2632f0ae0042de18e01ec00d3b60159d6827edc0e0ee4b",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylePropertyUtils.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256:
        "fa1652b5e6ec341854d8e745f20465f9ec20a0bdfadcee70aaccfd978b19528f",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/StylesSidebarPane.ts",
    sha256: "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/src/chromium/rules/StylesSidebarPane.ts",
      changeRecord: "PIN_OP_CHANGES.md#rules",
      localSha256:
        "e0a03b7003f3acc1a0a76dc225e6920fdfc15e86ff04202e55cfad9b98c872ae",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/elementsTreeOutline.css",
    sha256: "86b768a436167e97ca7c2e5cee622c122ba095d2fb6853a15aedf18b892f0c6d",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256:
        "7df2510470d1efae4ba405d6afe3b992cf972bcae6e462cb67a3f7b5d6ed7130",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/stylePropertiesTreeOutline.css",
    sha256: "87bfbaeb3ddf0d33dd001c023d0ca64e6926fe27724af828074e8b2b7e432860",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256:
        "7df2510470d1efae4ba405d6afe3b992cf972bcae6e462cb67a3f7b5d6ed7130",
    }],
  },
  {
    upstreamPath: "front_end/panels/elements/stylesSidebarPane.css",
    sha256: "01d5198e52f4b1a2dea4b3d20631f756ecf7db5bedab093539e87b4569ede5aa",
    derivedTargets: [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
      localSha256:
        "7df2510470d1efae4ba405d6afe3b992cf972bcae6e462cb67a3f7b5d6ed7130",
    }],
  },
]);
const EXPECTED_ROLLOUT_SOURCE_PATHS = Object.freeze([
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
  "packages/devtools-elements-ui/src/pseudoStateController.ts",
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
  ...EXPECTED_ROLLOUT_SOURCE_PATHS,
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

test("source archive locks the current Chromium pin and derived source bytes", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, upstreamManifestPath), "utf8"),
  );
  const { files, ...pin } = manifest;

  assert.deepEqual(pin, EXPECTED_CHROMIUM_PIN);
  assert.deepEqual(
    files
      .map(({ upstreamPath, sha256, derivedTargets }) => ({
        upstreamPath,
        sha256,
        derivedTargets,
      }))
      .sort((left, right) => compareAscii(left.upstreamPath, right.upstreamPath)),
    EXPECTED_CHROMIUM_SOURCE_INVENTORY,
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
  for (const path of EXPECTED_FIXED_SOURCE_PATHS) {
    if (!files.has(path)) files.set(path, Buffer.from(`fixture ${path}`));
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
