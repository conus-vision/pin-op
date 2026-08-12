import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseReleaseTag,
  verifyReleaseVersion,
} from "../verify-release-version.mjs";

const releaseVersion = "0.3.0";
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("release tags must use the exact vX.Y.Z format", () => {
  assert.equal(parseReleaseTag("v0.3.0"), "0.3.0");
  assert.equal(parseReleaseTag("v12.34.56"), "12.34.56");

  for (const tag of [
    "0.3.0",
    "v01.2.0",
    "v1.02.0",
    "v1.2.03",
    "v1.2",
    "v1.2.3-beta.1",
    "v1.2.3\nunsafe",
  ]) {
    assert.throws(() => parseReleaseTag(tag), /must match vX\.Y\.Z/);
  }
});

test("release version verifier accepts aligned package and manifest versions", async () => {
  const fixture = await createVersionFixture(releaseVersion);
  try {
    const result = await verifyReleaseVersion(fixture, `v${releaseVersion}`);

    assert.equal(result.version, releaseVersion);
    assert.deepEqual(result.versions, {
      root: releaseVersion,
      vscodePackage: releaseVersion,
      firefoxPackage: releaseVersion,
      firefoxManifest: releaseVersion,
      chromePackage: releaseVersion,
      chromeManifest: releaseVersion,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release version verifier rejects every mismatched product version", async () => {
  const fixture = await createVersionFixture(releaseVersion);
  try {
    await writeJson(resolve(fixture, "extensions/chrome/manifest.json"), {
      version: "0.3.1",
    });

    await assert.rejects(
      () => verifyReleaseVersion(fixture, `v${releaseVersion}`),
      /Chrome manifest version must be 0\.3\.0, received 0\.3\.1/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("repository product metadata is aligned to release 0.3.0", async () => {
  const result = await verifyReleaseVersion(
    repositoryRoot,
    `v${releaseVersion}`,
  );

  assert.equal(result.version, releaseVersion);
  assert.deepEqual(new Set(Object.values(result.versions)), new Set([releaseVersion]));
});

test("every current release entry-point version equals releaseVersion", async () => {
  const releaseEntryPoints = [
    "package.json",
    "extensions/vscode/package.json",
    "extensions/vscode/package-vsix.mjs",
    "extensions/chrome/package.json",
    "extensions/firefox/package.json",
    "tools/archive-firefox-source.mjs",
    "tools/smoke-packaged-chrome.mjs",
    "tools/verify-artifacts.mjs",
  ];

  for (const path of releaseEntryPoints) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    const versions = releaseVersions(path, contents);

    assert.ok(versions.length > 0, `${path} must name a release version`);
    for (const version of versions) {
      assert.equal(
        version,
        releaseVersion,
        `${path} names release version ${version}; expected ${releaseVersion}`,
      );
    }
  }
});

function releaseVersions(path, contents) {
  if (path.endsWith("package.json")) {
    const manifest = JSON.parse(contents);
    const releaseOwnedValues = [
      manifest.version,
      ...Object.values(manifest.scripts ?? {}).filter(
        (value) =>
          typeof value === "string" &&
          /(?:artifacts|pinop-(?:chrome|firefox|vscode))/.test(value),
      ),
    ];
    return semanticVersions(releaseOwnedValues.join("\n"));
  }

  const patterns = [
    /pinop-(?:chrome|firefox(?:-source)?|vscode)-(\d+\.\d+\.\d+)\.(?:vsix|xpi|zip)/g,
    /\b(?:releaseVersion|VERSION)\s*=\s*["'](\d+\.\d+\.\d+)["']/g,
    /manifest\?\.version\s*===\s*["'](\d+\.\d+\.\d+)["']/g,
  ];
  return patterns.flatMap((pattern) =>
    [...contents.matchAll(pattern)].map((match) => match[1]),
  );
}

function semanticVersions(contents) {
  return [...contents.matchAll(/\b\d+\.\d+\.\d+\b/g)].map(
    ([version]) => version,
  );
}

async function createVersionFixture(version) {
  const root = await mkdtemp(resolve(tmpdir(), "pinop-version-"));
  const files = [
    "package.json",
    "extensions/vscode/package.json",
    "extensions/firefox/package.json",
    "extensions/firefox/manifest.json",
    "extensions/chrome/package.json",
    "extensions/chrome/manifest.json",
  ];

  for (const file of files) {
    await writeJson(resolve(root, file), { version });
  }
  return root;
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
