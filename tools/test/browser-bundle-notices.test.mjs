import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  filesystemPathFromMetafileInput,
  loadChromiumNativeRuntimeNoticeInputs,
  renderChromiumDerivedNoticeSection,
  renderChromiumNativeRuntimeNoticeSection,
  writeBrowserBundleNotices,
} from "../browser-bundle-notices.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstreamRoot = resolve(
  repositoryRoot,
  "third_party/chromium-devtools-frontend",
);
const PINNED_REVISION = "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280";
const EXPECTED_EMBEDDED_NOTICE_DIGESTS = Object.freeze([
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

test("browser notices deterministically include every Chromium-derived license input", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pin-op-browser-notices-"));
  try {
    const manifest = JSON.parse(
      await readFile(resolve(upstreamRoot, "UPSTREAM.json"), "utf8"),
    );
    assert.equal(manifest.revision, PINNED_REVISION);
    assert.deepEqual(
      manifest.files.map((file) => file.upstreamPath).sort(compareAscii),
      EXPECTED_UPSTREAM_PATHS,
    );
    const rootLicense = normalizeText(
      await readFile(resolve(upstreamRoot, "LICENSE"), "utf8"),
    );
    await writeFixtureRepository(fixtureRoot, manifest, rootLicense);
    const nativeInputs = await writeNativeRuntimeFixture(fixtureRoot);
    const namespacedChromiumInput =
      `chromium-read-only:${resolve(
        fixtureRoot,
        "node_modules/chrome-devtools-frontend/front_end/panels/elements/ElementsTreeOutline.ts",
      ).replaceAll("\\", "/")}`;
    const generatedChromiumInput =
      `chromium-shared-images:${resolve(
        fixtureRoot,
        "node_modules/chrome-devtools-frontend/front_end/Images/Images.js",
      ).replaceAll("\\", "/")}`;

    const metafile = {
      inputs: {
        "../../node_modules/example-package/index.js": { bytes: 1, imports: [] },
        [namespacedChromiumInput]: { bytes: 1, imports: [] },
        [generatedChromiumInput]: { bytes: 1, imports: [] },
        "(disabled):../../node_modules/.pnpm/postcss@8.5.16/node_modules/postcss/lib/terminal-highlight": {
          bytes: 0,
          imports: [],
        },
      },
    };
    const chromeRoot = resolve(fixtureRoot, "extensions/chrome");
    const firefoxRoot = resolve(fixtureRoot, "extensions/firefox");

    await writeBrowserBundleNotices(metafile, chromeRoot);
    await writeBrowserBundleNotices(metafile, firefoxRoot);
    const chromeNotices = await readFile(
      resolve(chromeRoot, "THIRD_PARTY_NOTICES"),
      "utf8",
    );
    const firefoxNotices = await readFile(
      resolve(firefoxRoot, "THIRD_PARTY_NOTICES"),
      "utf8",
    );

    assert.equal(chromeNotices, firefoxNotices);
    assert.match(
      chromeNotices,
      /Bundled package sections are generated from the inputs in esbuild's bundle metadata\./,
    );
    assert.match(chromeNotices, /## example-package@1\.0\.0/);
    assert.doesNotMatch(
      chromeNotices,
      /^## chrome-devtools-frontend@/m,
      "the dedicated Chromium sections must be the sole Chromium attribution owner",
    );
    assert.equal(countOccurrences(chromeNotices, "Example dependency license"), 1);
    assert.doesNotMatch(chromeNotices, /^## postcss@8\.5\.16$/m);
    assert.match(
      chromeNotices,
      /Chromium-derived sections are generated from the pinned UPSTREAM\.json and RUNTIME\.json manifests, the reviewed DOM and Rules overlay manifests, exact input inventories, and required license bytes\./,
    );
    assert.doesNotMatch(
      chromeNotices,
      /^This list is generated from the inputs in esbuild's bundle metadata\.$/m,
    );
    assert.match(
      chromeNotices,
      /## Chromium DevTools Frontend \(derived view code\)/,
    );
    assert.match(
      chromeNotices,
      /## Chromium DevTools Frontend \(native read-only runtime\)/,
    );
    assert.match(
      chromeNotices,
      new RegExp(`NPM package: ${nativeInputs.packageManifest.name}@${nativeInputs.packageManifest.version}`),
    );
    assert.match(
      chromeNotices,
      new RegExp(`Runtime metadata SHA-256: ${sha256(nativeInputs.runtimeBytes)}`),
    );
    assert.match(
      chromeNotices,
      new RegExp(`DOM overlay manifest SHA-256: ${sha256(nativeInputs.domManifestBytes)}`),
    );
    assert.match(
      chromeNotices,
      new RegExp(`Rules overlay manifest SHA-256: ${sha256(nativeInputs.stylesManifestBytes)}`),
    );
    assert.match(
      chromeNotices,
      new RegExp(`Pinned revision: ${PINNED_REVISION}`),
    );
    assert.equal(countOccurrences(chromeNotices, rootLicense), 1);

    const embeddedNotices = new Map();
    for (const file of manifest.files) {
      for (const notice of file.embeddedNotices) {
        const existing = embeddedNotices.get(notice.sha256);
        assert.ok(existing === undefined || existing === notice.text);
        embeddedNotices.set(notice.sha256, normalizeText(notice.text));
      }
    }
    assert.deepEqual(
      [...embeddedNotices.keys()].sort(compareAscii),
      EXPECTED_EMBEDDED_NOTICE_DIGESTS,
    );
    for (const [sha256, notice] of [...embeddedNotices].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      assert.match(chromeNotices, new RegExp(`### Embedded notice ${sha256}`));
      assert.equal(countOccurrences(chromeNotices, notice), 1, sha256);
    }
    assert.match(chromeNotices, /Copyright \(C\) 2007, 2008 Apple Inc\./);
    assert.match(chromeNotices, /Copyright \(C\) 2009 Joseph Pecoraro/);
    assert.deepEqual(
      [...chromeNotices.matchAll(/^### Embedded notice ([0-9a-f]{64})$/gm)]
        .map((match) => match[1]),
      EXPECTED_EMBEDDED_NOTICE_DIGESTS,
    );

    await writeBrowserBundleNotices(metafile, chromeRoot);
    assert.equal(
      await readFile(resolve(chromeRoot, "THIRD_PARTY_NOTICES"), "utf8"),
      chromeNotices,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("browser notices parse verified Windows and POSIX namespaced filesystem inputs", () => {
  assert.deepEqual(
    filesystemPathFromMetafileInput("F:/repo/node_modules/pkg/index.js"),
    { path: "F:/repo/node_modules/pkg/index.js", namespaced: false },
  );
  assert.deepEqual(
    filesystemPathFromMetafileInput("chromium-css:F:/repo/node_modules/pkg/index.js"),
    { path: "F:/repo/node_modules/pkg/index.js", namespaced: true },
  );
  assert.deepEqual(
    filesystemPathFromMetafileInput("chromium-css:/repo/node_modules/pkg/index.js"),
    { path: "/repo/node_modules/pkg/index.js", namespaced: true },
  );
  assert.throws(
    () => filesystemPathFromMetafileInput("chromium-css:relative/node_modules/pkg/index.js"),
    /no absolute filesystem path/i,
  );
});

test("browser notices resolve physical packages only through exact verified metafile origins", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "pin-op-notice-origins-"));
  try {
    const stagedRepository = resolve(fixtureRoot, "project");
    const extensionRoot = resolve(stagedRepository, "extensions/chrome");
    const physicalPackageRoot = resolve(
      fixtureRoot,
      "physical/node_modules/example-package",
    );
    const upstreamManifest = JSON.parse(
      await readFile(resolve(upstreamRoot, "UPSTREAM.json"), "utf8"),
    );
    const rootLicense = normalizeText(
      await readFile(resolve(upstreamRoot, "LICENSE"), "utf8"),
    );
    await writeFixtureRepository(stagedRepository, upstreamManifest, rootLicense);
    await writeNativeRuntimeFixture(stagedRepository);
    await writeExamplePackage(physicalPackageRoot);

    const input = relative(
      stagedRepository,
      resolve(physicalPackageRoot, "index.js"),
    ).replaceAll("\\", "/");
    const sourceMetafile = {
      inputs: {
        [input]: { bytes: 1, imports: [] },
      },
      outputs: {
        "dist/runtime.js": {
          bytes: 1,
          inputs: { [input]: { bytesInOutput: 1 } },
          imports: [],
          exports: [],
        },
      },
    };
    const combinedMetafile = structuredClone(sourceMetafile);
    const verifiedSources = [{
      metafile: sourceMetafile,
      absWorkingDir: stagedRepository,
    }];

    await writeBrowserBundleNotices(
      combinedMetafile,
      extensionRoot,
      { metafileSources: verifiedSources },
    );
    assert.match(
      await readFile(resolve(extensionRoot, "THIRD_PARTY_NOTICES"), "utf8"),
      /## example-package@1\.0\.0/,
    );

    await assert.rejects(
      writeBrowserBundleNotices(combinedMetafile, extensionRoot),
      /outside.*verified metafile origin/i,
    );
    await assert.rejects(
      writeBrowserBundleNotices(
        combinedMetafile,
        extensionRoot,
        {
          metafileSources: [{
            metafile: sourceMetafile,
            absWorkingDir: resolve(fixtureRoot, "physical"),
          }],
        },
      ),
      /unapproved metafile origin/i,
    );
    await assert.rejects(
      writeBrowserBundleNotices(
        combinedMetafile,
        extensionRoot,
        {
          metafileSources: [{
            metafile: { inputs: {}, outputs: {} },
            absWorkingDir: stagedRepository,
          }],
        },
      ),
      /has no verified metafile origin/i,
    );
    await assert.rejects(
      writeBrowserBundleNotices(
        combinedMetafile,
        extensionRoot,
        {
          metafileSources: [
            ...verifiedSources,
            { metafile: sourceMetafile, absWorkingDir: extensionRoot },
          ],
        },
      ),
      /ambiguous metafile origin/i,
    );

    const missingInput =
      `chromium-shared-images:${resolve(
        stagedRepository,
        "node_modules/chrome-devtools-frontend/front_end/Images/Missing.js",
      ).replaceAll("\\", "/")}`;
    const missingMetafile = metafileForInput(missingInput);
    await assert.rejects(
      writeBrowserBundleNotices(
        structuredClone(missingMetafile),
        extensionRoot,
        {
          metafileSources: [{
            metafile: missingMetafile,
            absWorkingDir: stagedRepository,
          }],
        },
      ),
      /physical file.*missing\.js/i,
    );

    const externalChromiumRoot = resolve(
      fixtureRoot,
      "physical/node_modules/chrome-devtools-frontend",
    );
    await mkdir(externalChromiumRoot, { recursive: true });
    for (const path of ["package.json", "LICENSE"]) {
      await copyFile(
        resolve(stagedRepository, "node_modules/chrome-devtools-frontend", path),
        resolve(externalChromiumRoot, path),
      );
    }
    await writeFile(resolve(externalChromiumRoot, "index.js"), "export {};\n", "utf8");
    const externalChromiumInput = relative(
      stagedRepository,
      resolve(externalChromiumRoot, "index.js"),
    ).replaceAll("\\", "/");
    const externalChromiumMetafile = metafileForInput(externalChromiumInput);
    await assert.rejects(
      writeBrowserBundleNotices(
        structuredClone(externalChromiumMetafile),
        extensionRoot,
        {
          metafileSources: [{
            metafile: externalChromiumMetafile,
            absWorkingDir: stagedRepository,
          }],
        },
      ),
      /Chromium package input.*pinned physical package root/i,
    );
    const untrustedGeneratedInput =
      `chromium-shared-images:${resolve(
        externalChromiumRoot,
        "front_end/Images/Images.js",
      ).replaceAll("\\", "/")}`;
    const untrustedGeneratedMetafile = metafileForInput(untrustedGeneratedInput);
    await assert.rejects(
      writeBrowserBundleNotices(
        structuredClone(untrustedGeneratedMetafile),
        extensionRoot,
        {
          metafileSources: [{
            metafile: untrustedGeneratedMetafile,
            absWorkingDir: stagedRepository,
          }],
        },
      ),
      /virtual Chromium input.*pinned physical package root/i,
    );

    const escapedDirectory = resolve(fixtureRoot, "escaped-package-input");
    await mkdir(escapedDirectory, { recursive: true });
    await writeFile(resolve(escapedDirectory, "index.js"), "export {};\n", "utf8");
    const linkedDirectory = resolve(physicalPackageRoot, "linked");
    await symlink(
      escapedDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedInput = relative(
      stagedRepository,
      resolve(linkedDirectory, "index.js"),
    ).replaceAll("\\", "/");
    const linkedMetafile = metafileForInput(linkedInput);
    await assert.rejects(
      writeBrowserBundleNotices(
        structuredClone(linkedMetafile),
        extensionRoot,
        {
          metafileSources: [{
            metafile: linkedMetafile,
            absWorkingDir: stagedRepository,
          }],
        },
      ),
      /escapes its physical package root/i,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function metafileForInput(input) {
  return {
    inputs: {
      [input]: { bytes: 1, imports: [] },
    },
    outputs: {
      "dist/runtime.js": {
        bytes: 1,
        inputs: { [input]: { bytesInOutput: 1 } },
        imports: [],
        exports: [],
      },
    },
  };
}

test("native Chromium notice attests the exact runtime manifests, inputs, and licenses", async () => {
  const inputs = await loadChromiumNativeRuntimeNoticeInputs(repositoryRoot);
  const section = renderChromiumNativeRuntimeNoticeSection(inputs);

  assert.match(section, /## Chromium DevTools Frontend \(native read-only runtime\)/);
  assert.match(section, new RegExp(`Package gitHead: ${inputs.runtimeManifest.package.gitHead}`));
  assert.match(section, new RegExp(`Package integrity: ${escapeRegex(inputs.runtimeManifest.package.integrity)}`));
  for (const [owner, manifest] of [
    ["DOM", inputs.domManifest],
    ["Rules", inputs.stylesManifest],
  ]) {
    for (const [path, digest] of Object.entries(manifest.upstreamFiles)) {
      assert.match(section, new RegExp(`- ${escapeRegex(path)} ${digest}`), `${owner} ${path}`);
    }
    for (const [path, digest] of Object.entries(manifest.overlayFiles)) {
      assert.match(section, new RegExp(`- ${escapeRegex(path)} ${digest}`), `${owner} ${path}`);
    }
    for (const [path, digest] of Object.entries(manifest.requiredImageFiles ?? {})) {
      assert.match(
        section,
        new RegExp(`- ${escapeRegex(path)} ${digest}`),
        `${owner} image ${path}`,
      );
    }
    for (const [path, digest] of Object.entries(manifest.requiredLicenseFiles)) {
      assert.match(
        section,
        new RegExp(`- ${escapeRegex(path)} ${digest}`),
        `${owner} license ${path}`,
      );
    }
  }
  for (const [digest, text] of inputs.licenseTexts) {
    if (digest === inputs.runtimeManifest.license.sha256) continue;
    assert.match(section, new RegExp(`### Native runtime license ${digest}`));
    assert.equal(countOccurrences(section, normalizeText(text)), 1, digest);
  }
});

test("native Chromium notice rejects runtime, manifest, input, and license drift", async () => {
  const inputs = await loadChromiumNativeRuntimeNoticeInputs(repositoryRoot);
  const baseline = inputs;
  const mutations = [
    ["runtime metadata", (candidate) => {
      candidate.runtimeBytes = Buffer.from(
        candidate.runtimeBytes.toString("utf8").replace(
          '"packageName": "chrome-devtools-frontend"',
          '"packageName": "tampered-devtools-frontend"',
        ),
      );
    }],
    ["missing Rules runtime linkage", (candidate) => {
      delete candidate.runtimeManifest.readOnlyStylesRuntime;
      candidate.runtimeBytes = Buffer.from(
        `${JSON.stringify(candidate.runtimeManifest, null, 2)}\n`,
      );
    }],
    ["DOM overlay manifest", (candidate) => {
      candidate.domManifestBytes = Buffer.from(`${candidate.domManifestBytes}\n`);
    }],
    ["Rules overlay manifest", (candidate) => {
      candidate.stylesManifestBytes = Buffer.from(`${candidate.stylesManifestBytes}\n`);
    }],
    ["DOM upstream input", (candidate) => {
      const [path] = Object.keys(candidate.domManifest.upstreamFiles);
      candidate.packageFiles = new Map(candidate.packageFiles);
      candidate.packageFiles.set(path, Buffer.from("tampered DOM input"));
    }],
    ["Rules overlay input", (candidate) => {
      const [path] = Object.keys(candidate.stylesManifest.overlayFiles);
      candidate.stylesOverlayFiles = new Map(candidate.stylesOverlayFiles);
      candidate.stylesOverlayFiles.set(path, Buffer.from("tampered Rules input"));
    }],
    ["license", (candidate) => {
      const [path] = Object.keys(candidate.stylesManifest.requiredLicenseFiles);
      candidate.packageFiles = new Map(candidate.packageFiles);
      candidate.packageFiles.set(path, Buffer.from("tampered license"));
    }],
  ];

  for (const [label, mutate] of mutations) {
    const candidate = {
      ...baseline,
      runtimeManifest: structuredClone(baseline.runtimeManifest),
      domManifest: structuredClone(baseline.domManifest),
      stylesManifest: structuredClone(baseline.stylesManifest),
    };
    mutate(candidate);
    assert.throws(
      () => renderChromiumNativeRuntimeNoticeSection(candidate),
      /(?:sha-?256|hash|digest|metadata|manifest|input|license)/i,
      label,
    );
  }
});

test("Chromium notice renderer locks the exact unique upstream path inventory", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(upstreamRoot, "UPSTREAM.json"), "utf8"),
  );
  const rootLicense = await readFile(resolve(upstreamRoot, "LICENSE"), "utf8");

  for (const mutate of [
    (candidate) => {
      candidate.files.at(-1).upstreamPath = candidate.files[0].upstreamPath;
    },
    (candidate) => {
      candidate.files.at(-1).upstreamPath =
        "front_end/panels/elements/Injected.ts";
    },
  ]) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(
      () => renderChromiumDerivedNoticeSection(candidate, rootLicense),
      /upstream path inventory/i,
    );
  }
});

test("Chromium notice renderer rejects manifest, revision, and license drift", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(upstreamRoot, "UPSTREAM.json"), "utf8"),
  );
  const rootLicense = await readFile(resolve(upstreamRoot, "LICENSE"), "utf8");

  const wrongRevision = structuredClone(manifest);
  wrongRevision.revision = "b".repeat(40);
  assert.throws(
    () => renderChromiumDerivedNoticeSection(wrongRevision, rootLicense),
    /pinned Chromium revision/i,
  );

  const incomplete = structuredClone(manifest);
  incomplete.files = incomplete.files.filter(
    (file) => file.upstreamPath !== "front_end/panels/elements/PropertyRenderer.ts",
  );
  assert.throws(
    () => renderChromiumDerivedNoticeSection(incomplete, rootLicense),
    /embedded notice inventory/i,
  );

  const wrongLicensePath = structuredClone(manifest);
  wrongLicensePath.license = "OTHER-LICENSE";
  assert.throws(
    () => renderChromiumDerivedNoticeSection(wrongLicensePath, rootLicense),
    /upstream notice manifest/i,
  );
  assert.throws(
    () => renderChromiumDerivedNoticeSection(manifest, `${rootLicense}changed`),
    /root license/i,
  );
});

test("Chromium notice renderer rejects conflicting text for one digest", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(upstreamRoot, "UPSTREAM.json"), "utf8"),
  );
  const rootLicense = await readFile(resolve(upstreamRoot, "LICENSE"), "utf8");
  const conflicting = structuredClone(manifest);
  const repeatedDigest = conflicting.files[0].embeddedNotices[0].sha256;
  const duplicate = conflicting.files
    .flatMap((file) => file.embeddedNotices)
    .find((notice, index, notices) =>
      notice.sha256 === repeatedDigest && index > notices.findIndex(
        (candidate) => candidate.sha256 === repeatedDigest,
      ),
    );
  assert.ok(duplicate);
  duplicate.text += "\nconflicting text";

  assert.throws(
    () => renderChromiumDerivedNoticeSection(conflicting, rootLicense),
    /conflicting Chromium embedded notice/i,
  );
});

async function writeFixtureRepository(root, manifest, rootLicense) {
  for (const browser of ["chrome", "firefox"]) {
    await mkdir(resolve(root, `extensions/${browser}`), { recursive: true });
  }
  await writeExamplePackage(resolve(root, "node_modules/example-package"));
  await mkdir(resolve(root, "third_party/chromium-devtools-frontend"), {
    recursive: true,
  });
  await writeFile(
    resolve(root, "third_party/chromium-devtools-frontend/UPSTREAM.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  await writeFile(
    resolve(root, "third_party/chromium-devtools-frontend/LICENSE"),
    `${rootLicense}\n`,
    "utf8",
  );
}

async function writeExamplePackage(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ name: "example-package", version: "1.0.0", license: "MIT" }),
    "utf8",
  );
  await writeFile(resolve(root, "LICENSE"), "Example dependency license\n", "utf8");
  await writeFile(resolve(root, "index.js"), "export {};\n", "utf8");
}

async function writeNativeRuntimeFixture(root) {
  const sourceRoot = upstreamRoot;
  const runtimeBytes = await readFile(resolve(sourceRoot, "RUNTIME.json"));
  const runtimeManifest = JSON.parse(runtimeBytes.toString("utf8"));
  const version = runtimeManifest.package.version;
  const domOverlayRoot = `third_party/chromium-devtools-frontend/patches/${version}`;
  const stylesOverlayRoot = `third_party/chromium-devtools-frontend/styles-overlay/${version}`;
  const domManifestBytes = await readFile(resolve(repositoryRoot, domOverlayRoot, "manifest.json"));
  const stylesManifestBytes = await readFile(
    resolve(repositoryRoot, stylesOverlayRoot, "manifest.json"),
  );
  const domManifest = JSON.parse(domManifestBytes.toString("utf8"));
  const stylesManifest = JSON.parse(stylesManifestBytes.toString("utf8"));
  const runtimeFixture = structuredClone(runtimeManifest);
  const fixtureRuntimeBytes = runtimeBytes;
  await copyBytes(runtimeBytes, resolve(root, sourceRootRelative("RUNTIME.json")));
  await copyBytes(domManifestBytes, resolve(root, domOverlayRoot, "manifest.json"));
  await copyBytes(stylesManifestBytes, resolve(root, stylesOverlayRoot, "manifest.json"));

  for (const [overlayRoot, manifest] of [
    [domOverlayRoot, domManifest],
    [stylesOverlayRoot, stylesManifest],
  ]) {
    for (const path of Object.keys(manifest.overlayFiles)) {
      await copyRepositoryFile(`${overlayRoot}/${path}`, root);
    }
  }
  const packagePaths = new Set(["package.json"]);
  for (const manifest of [domManifest, stylesManifest]) {
    for (const key of ["upstreamFiles", "requiredImageFiles", "requiredLicenseFiles"]) {
      for (const path of Object.keys(manifest[key] ?? {})) packagePaths.add(path);
    }
  }
  for (const path of Object.keys(runtimeFixture.reviewedEntrypoints ?? {})) {
    packagePaths.add(path);
  }
  for (const path of Object.keys(runtimeFixture.reviewedImages ?? {})) {
    packagePaths.add(`front_end/Images/src/${path}`);
  }
  for (const path of packagePaths) {
    const source = resolve(repositoryRoot, "node_modules/chrome-devtools-frontend", path);
    const target = resolve(root, "node_modules/chrome-devtools-frontend", path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return {
    runtimeBytes: fixtureRuntimeBytes,
    runtimeManifest: runtimeFixture,
    domManifestBytes,
    stylesManifestBytes,
    domManifest,
    stylesManifest,
    packageManifest: JSON.parse(
      await readFile(resolve(root, "node_modules/chrome-devtools-frontend/package.json"), "utf8"),
    ),
  };
}

async function copyRepositoryFile(path, targetRoot) {
  const target = resolve(targetRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(repositoryRoot, path), target);
}

async function copyBytes(bytes, target) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function sourceRootRelative(path) {
  return `third_party/chromium-devtools-frontend/${path}`;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function normalizeText(text) {
  return text.toString("utf8").replaceAll("\r\n", "\n").trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
