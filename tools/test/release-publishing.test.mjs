import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import * as releasePublishing from "../release-publishing.mjs";

const {
  assertReleaseAssets,
  assertUnsignedReleaseAssets,
  parseChecksumManifest,
} = releasePublishing;

const version = "0.3.0";
const databaseId = "987654321";
const unsignedName = `pinop-firefox-${version}.zip`;
const signedName = `pinop-firefox-${version}.xpi`;
const unsignedNames = [
  `pinop-chrome-${version}.zip`,
  unsignedName,
  `pinop-firefox-source-${version}.zip`,
  `pinop-vscode-${version}.vsix`,
  "SHA256SUMS",
];
const signedNames = [...unsignedNames, signedName];
const publicationBinaryNames = signedNames.filter((name) => name !== "SHA256SUMS");
const publicationContents = new Map(
  publicationBinaryNames.map((name) => [name, Buffer.from(`artifact:${name}\n`)]),
);
const completePublicationManifest = checksumManifest(publicationContents);
const original = [
  `${"1".repeat(64)}  pinop-chrome-${version}.zip`,
  `${"2".repeat(64)}  ${unsignedName}`,
  `${"3".repeat(64)}  pinop-firefox-source-${version}.zip`,
  `${"4".repeat(64)}  pinop-vscode-${version}.vsix`,
  "",
].join("\n");

test("checksum manifests reject malformed and duplicate entries", () => {
  assert.throws(() => parseChecksumManifest("not a checksum\n"), /Invalid checksum line/);
  assert.throws(
    () => parseChecksumManifest(`${original}${"9".repeat(64)}  ${unsignedName}\n`),
    /duplicate checksum filename/,
  );
});

test("publication checksum manifest requires exactly five binary artifacts", () => {
  assert.equal(typeof releasePublishing.assertPublicationChecksumManifest, "function");
  const exact = releasePublishing.assertPublicationChecksumManifest(
    completePublicationManifest,
    version,
  );
  assert.deepEqual([...exact.keys()].sort(), [...publicationBinaryNames].sort());

  const firstName = publicationBinaryNames[0];
  const partial = checksumManifest(new Map([[firstName, publicationContents.get(firstName)]]));
  assert.equal(
    parseChecksumManifest(partial).get(firstName),
    sha256(publicationContents.get(firstName)),
    "the partial manifest has a correct listed hash and would satisfy a listed-only check",
  );
  assert.throws(
    () => releasePublishing.assertPublicationChecksumManifest(partial, version),
    /publication checksum asset set differs/i,
  );

  const selfEntry = `${completePublicationManifest}${"a".repeat(64)}  SHA256SUMS\n`;
  assert.throws(
    () => releasePublishing.assertPublicationChecksumManifest(selfEntry, version),
    /publication checksum asset set differs/i,
  );
  const extraEntry = `${completePublicationManifest}${"b".repeat(64)}  extra.zip\n`;
  assert.throws(
    () => releasePublishing.assertPublicationChecksumManifest(extraEntry, version),
    /publication checksum asset set differs/i,
  );
  const firstLine = completePublicationManifest.split("\n")[0];
  assert.throws(
    () =>
      releasePublishing.assertPublicationChecksumManifest(
        `${completePublicationManifest}${firstLine}\n`,
        version,
      ),
    /duplicate checksum filename/i,
  );
  assert.throws(
    () =>
      releasePublishing.assertPublicationChecksumManifest(
        completePublicationManifest.replace(/^[0-9a-f]/, "A"),
        version,
      ),
    /invalid checksum line/i,
  );
});

test("publication checksum verifier rejects partial and replaced manifests", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-publication-checksums-"));
  try {
    for (const [name, contents] of publicationContents) {
      await writeFile(resolve(directory, name), contents);
    }
    const manifestPath = resolve(directory, "SHA256SUMS");
    await writeFile(manifestPath, completePublicationManifest);

    const valid = runPublicationChecksumVerifier(directory);
    assert.equal(valid.status, 0, valid.stderr);
    const fingerprint = JSON.parse(valid.stdout);
    assert.equal(
      fingerprint.checksumManifestSha256,
      sha256(Buffer.from(completePublicationManifest)),
    );
    assert.deepEqual(
      fingerprint.artifacts.map(({ name }) => name),
      [...publicationBinaryNames].sort(),
    );

    const firstName = publicationBinaryNames[0];
    const partialManifest = checksumManifest(
      new Map([[firstName, publicationContents.get(firstName)]]),
    );
    await writeFile(manifestPath, partialManifest);
    await assertListedOnlyChecksumsPass(directory, partialManifest);
    const partial = runPublicationChecksumVerifier(directory);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /publication checksum asset set differs/i);

    await writeFile(
      manifestPath,
      completePublicationManifest.replace(/^[0-9a-f]{64}/, "f".repeat(64)),
    );
    const replaced = runPublicationChecksumVerifier(directory);
    assert.notEqual(replaced.status, 0);
    assert.match(replaced.stderr, /checksum differs/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft release must contain signed and unsigned Firefox artifacts with checksums", () => {
  const names = [
    `pinop-chrome-${version}.zip`,
    unsignedName,
    signedName,
    `pinop-firefox-source-${version}.zip`,
    `pinop-vscode-${version}.vsix`,
    "SHA256SUMS",
  ];
  const checksums = original.replace(
    /\n$/,
    `\n${"5".repeat(64)}  ${signedName}\n`,
  );

  assert.equal(
    assertReleaseAssets(
      { databaseId: Number(databaseId), isDraft: true, assets: names.map((name) => ({ name })) },
      version,
      checksums,
    ),
    databaseId,
  );
  assert.throws(
    () =>
      assertReleaseAssets(
        { databaseId: Number(databaseId), isDraft: false, assets: names.map((name) => ({ name })) },
        version,
        checksums,
      ),
    /must still be a draft/,
  );
  assert.throws(
    () =>
      assertReleaseAssets(
        { databaseId: Number(databaseId), isDraft: true, assets: [...names, "unexpected.zip"].map((name) => ({ name })) },
        version,
        checksums,
      ),
    /asset set differs/,
  );
});

test("unsigned recovery phase accepts only the original five-asset draft", () => {
  assert.equal(
    assertUnsignedReleaseAssets(
      { databaseId, isDraft: true, assets: unsignedNames.map((name) => ({ name })) },
      version,
      original,
    ),
    databaseId,
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { databaseId, isDraft: false, assets: unsignedNames.map((name) => ({ name })) },
        version,
        original,
      ),
    /must still be a draft/,
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { databaseId, isDraft: true, assets: [...unsignedNames, signedName].map((name) => ({ name })) },
        version,
        original,
      ),
    /unsigned draft asset set differs/,
  );
  assert.throws(
    () =>
      assertUnsignedReleaseAssets(
        { databaseId, isDraft: true, assets: unsignedNames.map((name) => ({ name })) },
        version,
        original.replace(/\n$/, `\n${"5".repeat(64)}  ${signedName}\n`),
      ),
    /unsigned checksum asset set differs/,
  );
});

test("release identity is mandatory and immutable across verification phases", () => {
  const release = {
    databaseId: Number(databaseId),
    isDraft: true,
    assets: unsignedNames.map((name) => ({ name })),
  };

  assert.equal(assertUnsignedReleaseAssets(release, version, original, databaseId), databaseId);
  assert.throws(
    () => assertUnsignedReleaseAssets(release, version, original, "987654322"),
    /database id differs/i,
  );
  assert.throws(
    () => assertUnsignedReleaseAssets({ ...release, databaseId: undefined }, version, original),
    /database id/i,
  );
  assert.throws(
    () => assertUnsignedReleaseAssets({ ...release, databaseId: 1.5 }, version, original),
    /database id/i,
  );
});

test("REST publication identity has a stable fingerprint across draft publication", () => {
  assert.equal(typeof releasePublishing.assertPublicationRelease, "function");
  const expected = {
    expectedDatabaseId: databaseId,
    expectedTag: `v${version}`,
    expectedTarget: "master",
  };
  const before = releasePublishing.assertPublicationRelease(
    publicationRelease(),
    version,
    { ...expected, expectedDraft: true },
  );
  const after = releasePublishing.assertPublicationRelease(
    publicationRelease({ draft: false, immutable: true }),
    version,
    { ...expected, expectedDraft: false },
  );

  assert.deepEqual(after, before);
  assert.equal(before.releaseDatabaseId, databaseId);
  assert.equal(before.tagName, `v${version}`);
  assert.equal(before.targetCommitish, "master");
  assert.deepEqual(
    before.assets.map(({ name }) => name),
    [...signedNames].sort(),
  );
});

test("REST publication identity rejects recreation and metadata drift", () => {
  assert.equal(typeof releasePublishing.assertPublicationRelease, "function");
  const expected = {
    expectedDatabaseId: databaseId,
    expectedTag: `v${version}`,
    expectedTarget: "master",
    expectedDraft: true,
  };
  for (const [release, pattern] of [
    [publicationRelease({ id: Number(databaseId) + 1 }), /database id differs/i],
    [publicationRelease({ id: databaseId }), /numeric release id/i],
    [publicationRelease({ tag_name: "v9.9.9" }), /tag differs/i],
    [publicationRelease({ target_commitish: "other" }), /target differs/i],
    [publicationRelease({ draft: false }), /draft state differs/i],
    [publicationRelease({ assets: publicationRelease().assets.slice(1) }), /asset set differs/i],
    [
      publicationRelease({
        assets: publicationRelease().assets.map((asset, index) =>
          index === 0 ? { ...asset, id: "101" } : asset,
        ),
      }),
      /numeric asset id/i,
    ],
  ]) {
    assert.throws(
      () => releasePublishing.assertPublicationRelease(release, version, expected),
      pattern,
    );
  }

  assert.throws(
    () =>
      releasePublishing.assertPublicationRelease(
        publicationRelease({ draft: false, immutable: false }),
        version,
        { ...expected, expectedDraft: false },
      ),
    /immutable/i,
  );
});

test("publication verifier CLI emits the same identity before and after PATCH", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-publication-release-"));
  try {
    const beforePath = resolve(directory, "before.json");
    const afterPath = resolve(directory, "after.json");
    await writeFile(beforePath, JSON.stringify(publicationRelease()));
    await writeFile(
      afterPath,
      JSON.stringify(publicationRelease({ draft: false, immutable: true })),
    );

    const before = runPublicationVerifier("draft", beforePath);
    const after = runPublicationVerifier("published", afterPath);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release asset verifier CLI requires an explicit unsigned phase", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-unsigned-release-"));
  try {
    const remoteDirectory = resolve(directory, "remote");
    const localDirectory = resolve(directory, "local");
    await mkdir(remoteDirectory);
    await mkdir(localDirectory);
    const releasePath = resolve(directory, "release.json");
    const checksumPath = resolve(remoteDirectory, "SHA256SUMS");
    await writeFile(
      releasePath,
      JSON.stringify({
        databaseId: Number(databaseId),
        isDraft: true,
        assets: unsignedNames.map((name) => ({ name })),
      }),
    );
    for (const name of unsignedNames) {
      const content = name === "SHA256SUMS" ? original : `artifact:${name}\n`;
      await writeFile(resolve(remoteDirectory, name), content);
      await writeFile(resolve(localDirectory, name), content);
    }

    const valid = runVerifier(
      "unsigned",
      releasePath,
      version,
      checksumPath,
      "--expected-database-id",
      databaseId,
      "--compare-all",
      localDirectory,
    );
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, `${databaseId}\n`);

    const wrongIdentity = runVerifier(
      "unsigned",
      releasePath,
      version,
      checksumPath,
      "--expected-database-id",
      "987654322",
    );
    assert.notEqual(wrongIdentity.status, 0);
    assert.match(wrongIdentity.stderr, /database id differs/i);

    await writeFile(resolve(remoteDirectory, unsignedName), "tampered\n");
    const tampered = runVerifier(
      "unsigned",
      releasePath,
      version,
      checksumPath,
      "--compare-all",
      localDirectory,
    );
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /differs between release and rebuild/i);

    const wrongPhase = runVerifier("signed", releasePath, version, checksumPath);
    assert.notEqual(wrongPhase.status, 0);

    const missingPhase = runVerifier(releasePath, version, checksumPath);
    assert.notEqual(missingPhase.status, 0);
    assert.match(missingPhase.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runVerifier(...arguments_) {
  return spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../verify-release-assets.mjs"), ...arguments_],
    { encoding: "utf8" },
  );
}

function publicationRelease(overrides = {}) {
  return {
    id: Number(databaseId),
    tag_name: `v${version}`,
    target_commitish: "master",
    draft: true,
    immutable: false,
    assets: signedNames.map((name, index) => ({
      id: 1000 + index,
      name,
      size: 100 + index,
      state: "uploaded",
    })),
    ...overrides,
  };
}

function runPublicationVerifier(state, releasePath) {
  return spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "../verify-release-publication.mjs"),
      state,
      releasePath,
      version,
      databaseId,
      `v${version}`,
      "master",
    ],
    { encoding: "utf8" },
  );
}

function runPublicationChecksumVerifier(directory) {
  return spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "../verify-publication-checksums.mjs"),
      directory,
      version,
    ],
    { encoding: "utf8" },
  );
}

function checksumManifest(contentsByName) {
  return [...contentsByName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}\n`)
    .join("");
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function assertListedOnlyChecksumsPass(directory, manifestSource) {
  for (const [name, expectedSha256] of parseChecksumManifest(manifestSource)) {
    assert.equal(sha256(await readFile(resolve(directory, name))), expectedSha256);
  }
}
