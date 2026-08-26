import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  renderChromiumDerivedNoticeSection,
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

    const metafile = {
      inputs: {
        "../../node_modules/example-package/index.js": { bytes: 1, imports: [] },
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
    assert.equal(countOccurrences(chromeNotices, "Example dependency license"), 1);
    assert.doesNotMatch(chromeNotices, /^## postcss@8\.5\.16$/m);
    assert.match(
      chromeNotices,
      /Chromium-derived sections are generated from the pinned UPSTREAM\.json manifest, root license, and embedded source notices\./,
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
  await mkdir(resolve(root, "node_modules/example-package"), { recursive: true });
  await mkdir(resolve(root, "third_party/chromium-devtools-frontend"), {
    recursive: true,
  });
  await writeFile(
    resolve(root, "node_modules/example-package/package.json"),
    JSON.stringify({ name: "example-package", version: "1.0.0", license: "MIT" }),
    "utf8",
  );
  await writeFile(
    resolve(root, "node_modules/example-package/LICENSE"),
    "Example dependency license\n",
    "utf8",
  );
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

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function normalizeText(text) {
  return text.replaceAll("\r\n", "\n").trim();
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
