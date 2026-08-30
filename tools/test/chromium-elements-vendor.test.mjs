import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyVendor } from "../verify-chromium-elements-vendor.mjs";
import { updateChromiumDerivations } from "../update-chromium-derivations.mjs";
import {
  assertCompleteRootBsdLicense,
  extractEmbeddedNotices,
  fetchWithPinnedRedirects,
  rawUrlFor,
  validateRevision,
  vendorChromiumElements,
} from "../vendor-chromium-elements.mjs";

const PINNED_REVISION = "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280";
const REPOSITORY_URL = "https://github.com/ChromeDevTools/devtools-frontend.git";
const EXPECTED_IMPORT_PATHS = [
  "front_end/panels/elements/ElementsTreeOutline.ts",
  "front_end/panels/elements/ElementsTreeElement.ts",
  "front_end/panels/elements/StylesSidebarPane.ts",
  "front_end/panels/elements/StylePropertiesSection.ts",
  "front_end/panels/elements/StylePropertyTreeElement.ts",
  "front_end/panels/elements/PropertyRenderer.ts",
  "front_end/panels/elements/StylePropertyUtils.ts",
  "front_end/panels/elements/elementsTreeOutline.css",
  "front_end/panels/elements/stylesSidebarPane.css",
  "front_end/panels/elements/stylePropertiesTreeOutline.css",
];
const EXPECTED_UPSTREAM_PATHS = [...EXPECTED_IMPORT_PATHS].sort();

const EXPECTED_DERIVED_TARGETS = new Map([
  ...[
    "front_end/panels/elements/ElementsTreeOutline.ts",
    "front_end/panels/elements/ElementsTreeElement.ts",
    "front_end/panels/elements/StylesSidebarPane.ts",
    "front_end/panels/elements/StylePropertiesSection.ts",
    "front_end/panels/elements/StylePropertyTreeElement.ts",
    "front_end/panels/elements/PropertyRenderer.ts",
    "front_end/panels/elements/StylePropertyUtils.ts",
  ].map((upstreamPath) => [upstreamPath, []]),
  ...[
    "front_end/panels/elements/elementsTreeOutline.css",
    "front_end/panels/elements/stylesSidebarPane.css",
    "front_end/panels/elements/stylePropertiesTreeOutline.css",
  ].map((upstreamPath) => [
    upstreamPath,
    [{
      path: "packages/devtools-elements-ui/assets/devtools-elements.css",
      changeRecord: "PIN_OP_CHANGES.md#scoped-styles",
    }],
  ]),
]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR_RELATIVE = path.join("third_party", "chromium-devtools-frontend");
const VENDOR_ROOT = path.join(REPO_ROOT, VENDOR_RELATIVE);
const MANIFEST_RELATIVE = path.join(VENDOR_RELATIVE, "UPSTREAM.json");

function derivedEntry(manifest) {
  const entry = manifest.files.find(({ derivedTargets }) => derivedTargets.length > 0);
  if (!entry) throw new Error("Expected one Chromium-derived manifest entry");
  return entry;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("root BSD completeness accepts the pinned line-wrapped comment format", () => {
  const pinnedLicenseFormat = `// Copyright 2014 The Chromium Authors
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// Neither the name of Google Inc. nor the names of its contributors may be used.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS".
// IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE.`;

  assert.doesNotThrow(() => assertCompleteRootBsdLicense(pinnedLicenseFormat));
});

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(root = REPO_ROOT) {
  return JSON.parse(await readFile(path.join(root, MANIFEST_RELATIVE), "utf8"));
}

async function writeManifest(root, manifest) {
  await writeFile(
    path.join(root, MANIFEST_RELATIVE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function mutateManifest(root, mutate) {
  const manifest = await readManifest(root);
  await mutate(manifest);
  await writeManifest(root, manifest);
  return manifest;
}

async function makeTemporaryRepository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-vendor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await populateTemporaryRepository(root);
  return root;
}

async function populateTemporaryRepository(root) {
  await mkdir(path.dirname(path.join(root, VENDOR_RELATIVE)), { recursive: true });
  await cp(VENDOR_ROOT, path.join(root, VENDOR_RELATIVE), { recursive: true });
  const manifest = await readManifest(root);
  const derivedPaths = new Set(
    manifest.files.flatMap(({ derivedTargets }) => (
      derivedTargets.map(({ path: targetPath }) => targetPath)
    )),
  );
  for (const targetPath of derivedPaths) {
    const checkedInTarget = path.join(REPO_ROOT, ...targetPath.split("/"));
    if (await exists(checkedInTarget)) {
      const temporaryTarget = path.join(root, ...targetPath.split("/"));
      await mkdir(path.dirname(temporaryTarget), { recursive: true });
      await cp(checkedInTarget, temporaryTarget);
    }
  }
}

function upstreamFilePath(root, upstreamPath) {
  return path.join(root, VENDOR_RELATIVE, "upstream", ...upstreamPath.split("/"));
}

async function createDerivedTarget(root, target, contents) {
  const targetPath = path.join(root, ...target.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents);
  return targetPath;
}

async function makePinnedResponses() {
  return new Map([
    ["LICENSE", await readFile(path.join(VENDOR_ROOT, "LICENSE"))],
    ...await Promise.all(EXPECTED_IMPORT_PATHS.map(async (upstreamPath) => [
      upstreamPath,
      await readFile(upstreamFilePath(REPO_ROOT, upstreamPath)),
    ])),
  ]);
}

function makeSuccessfulFetch(responseBytes, requests = []) {
  return async (url) => {
    requests.push(String(url));
    const marker = `/${PINNED_REVISION}/`;
    const requestPath = decodeURIComponent(new URL(url).pathname.split(marker)[1]);
    const bytes = responseBytes.get(requestPath);
    assert.ok(bytes, `unexpected pinned request ${url}`);
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
}

async function createDirectoryLink(target, linkPath) {
  await symlink(
    path.resolve(target),
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function removeDirectoryLink(linkPath) {
  await unlink(linkPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

test("checked-in Chromium Elements provenance is exact and verifies offline", async () => {
  const manifest = await readManifest();

  assert.equal(manifest.repository, REPOSITORY_URL);
  assert.equal(
    manifest.revision,
    "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280",
  );
  assert.match(manifest.importedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(manifest.license, "LICENSE");
  assert.equal(
    manifest.licenseSha256,
    "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
  );
  assert.deepEqual(
    manifest.files.map(({ upstreamPath }) => upstreamPath).sort(),
    EXPECTED_UPSTREAM_PATHS,
  );

  for (const source of manifest.files) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.embeddedNotices.length > 0, `${source.upstreamPath} has a notice`);
    for (const notice of source.embeddedNotices) {
      assert.equal(notice.text, notice.text.replace(/\r\n?/g, "\n").trim());
      assert.equal(notice.sha256, sha256(notice.text));
    }

    assert.deepEqual(
      source.derivedTargets.map(({ path: targetPath, changeRecord }) => ({
        path: targetPath,
        changeRecord,
      })),
      EXPECTED_DERIVED_TARGETS.get(source.upstreamPath),
    );
    for (const target of source.derivedTargets) {
      assert.ok(
        target.localSha256 === "pending" || /^[0-9a-f]{64}$/.test(target.localSha256),
      );
    }
  }

  const distinctNotices = [
    ...new Map(
      manifest.files
        .flatMap(({ embeddedNotices }) => embeddedNotices)
        .map((notice) => [notice.sha256, notice]),
    ).values(),
  ];
  assert.ok(
    distinctNotices.some(({ text }) => /Apple[\s\S]*Joseph Pecoraro/.test(text)),
    "the Apple/Joseph Pecoraro BSD notice is inventoried separately",
  );
  const rootLicense = await readFile(path.join(VENDOR_ROOT, "LICENSE"), "utf8");
  assert.ok(!distinctNotices.some(({ text }) => text === rootLicense.trim()));

  await verifyVendor(REPO_ROOT);
  const hasIncompleteTarget = manifest.files
    .flatMap(({ derivedTargets }) => derivedTargets)
    .some(({ localSha256 }) => localSha256 === "pending");
  if (hasIncompleteTarget) {
    await assert.rejects(
      () => verifyVendor(REPO_ROOT, { requireComplete: true }),
      /incomplete derived target/,
    );
  } else {
    await verifyVendor(REPO_ROOT, { requireComplete: true });
  }

  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(
    {
      vendor: packageJson.scripts["vendor:chromium-elements"],
      record: packageJson.scripts["vendor:chromium-elements:record-derived"],
      check: packageJson.scripts["vendor:chromium-elements:check"],
      complete: packageJson.scripts["vendor:chromium-elements:check-complete"],
    },
    {
      vendor: `node tools/vendor-chromium-elements.mjs --revision ${PINNED_REVISION}`,
      record: "node tools/update-chromium-derivations.mjs",
      check: "node tools/verify-chromium-elements-vendor.mjs",
      complete: "node tools/verify-chromium-elements-vendor.mjs --require-complete",
    },
  );
});

test("the recorded Chromium-derived stylesheet is pinned to LF", async () => {
  const manifest = await readManifest();
  const packagePrefix = "packages/devtools-elements-ui/";
  const derivedTargets = manifest.files
    .flatMap(({ derivedTargets: targets }) => targets)
    .filter(({ localSha256 }) => localSha256 !== "pending");
  const attributes = await readFile(
    path.join(REPO_ROOT, "packages/devtools-elements-ui/.gitattributes"),
    "utf8",
  );

  assert.ok(derivedTargets.length > 0);
  assert.match(attributes, /^assets\/devtools-elements\.css text eol=lf$/m);
  for (const target of derivedTargets) {
    assert.equal(target.path, `${packagePrefix}assets/devtools-elements.css`);
    const bytes = await readFile(path.join(REPO_ROOT, ...target.path.split("/")));
    assert.equal(
      bytes.includes(13),
      false,
      `${target.path} must contain LF line endings only`,
    );
  }
});

test("only the exact full Chromium revision is accepted before network access", async (t) => {
  const invalidRevisions = [
    "main",
    "refs/tags/123.0.0",
    PINNED_REVISION.slice(0, 12),
    "b092f2943b68ef9aa7c1d2c2a8b7e71aa4087280",
  ];

  for (const revision of invalidRevisions) {
    assert.throws(() => validateRevision(revision), /exact pinned Chromium revision/);
    let fetchCalls = 0;
    await assert.rejects(
      () => vendorChromiumElements({
        repositoryRoot: REPO_ROOT,
        revision,
        importDate: "2026-08-22",
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("fetch must not run for an invalid revision");
        },
      }),
      /exact pinned Chromium revision/,
    );
    assert.equal(fetchCalls, 0);
    await t.test(`manifest revision ${revision}`, async (t) => {
      const root = await makeTemporaryRepository(t);
      await mutateManifest(root, (manifest) => {
        manifest.revision = revision;
      });
      await assert.rejects(() => verifyVendor(root), /exact pinned Chromium revision/);
    });
  }
});

test("raw downloads are limited to the allowlist and pinned origin", async () => {
  assert.equal(
    rawUrlFor(PINNED_REVISION, "front_end/panels/elements/ElementsTreeOutline.ts"),
    `https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/${PINNED_REVISION}/front_end/panels/elements/ElementsTreeOutline.ts`,
  );
  assert.throws(
    () => rawUrlFor(PINNED_REVISION, "front_end/panels/elements/ElementsPanel.ts"),
    /allowlisted/,
  );

  let requests = 0;
  const redirectingFetch = async () => {
    requests += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://example.invalid/stolen-source.ts" },
    });
  };
  await assert.rejects(
    () => fetchWithPinnedRedirects(
      rawUrlFor(PINNED_REVISION, "front_end/panels/elements/ElementsTreeOutline.ts"),
      redirectingFetch,
    ),
    /redirect outside pinned raw GitHub origin/,
  );
  assert.equal(requests, 1);
});

test("unexpected, missing, or changed upstream files fail verification", async (t) => {
  await t.test("extra source", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      manifest.files.push({
        upstreamPath: "front_end/panels/elements/ElementsPanel.ts",
        sha256: "0".repeat(64),
        embeddedNotices: [],
        derivedTargets: [],
      });
    });
    await assert.rejects(() => verifyVendor(root), /allowlisted upstream paths/);
  });

  await t.test("missing source", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      manifest.files.pop();
    });
    await assert.rejects(() => verifyVendor(root), /allowlisted upstream paths/);
  });

  await t.test("changed source bytes", async (t) => {
    const tamperedRoot = await makeTemporaryRepository(t);
    const manifest = await readManifest(tamperedRoot);
    await writeFile(
      upstreamFilePath(tamperedRoot, manifest.files[0].upstreamPath),
      "tampered upstream bytes\n",
    );
    await assert.rejects(() => verifyVendor(tamperedRoot), /SHA-256 mismatch/);
  });
});

test("the complete root BSD license is mandatory", async (t) => {
  await t.test("missing license", async (t) => {
    const root = await makeTemporaryRepository(t);
    await unlink(path.join(root, VENDOR_RELATIVE, "LICENSE"));
    await assert.rejects(() => verifyVendor(root), /missing root BSD license/);
  });

  await t.test("truncated license", async (t) => {
    const root = await makeTemporaryRepository(t);
    await writeFile(path.join(root, VENDOR_RELATIVE, "LICENSE"), "BSD\n");
    await assert.rejects(() => verifyVendor(root), /root BSD license SHA-256 mismatch/);
  });

  await t.test("self-consistent changed license", async (t) => {
    const root = await makeTemporaryRepository(t);
    const licensePath = path.join(root, VENDOR_RELATIVE, "LICENSE");
    const license = await readFile(licensePath, "utf8");
    const changedLicense = license.replace(
      "// notice, this list of conditions and the following disclaimer.\n",
      "",
    );
    assert.notEqual(changedLicense, license);
    await writeFile(licensePath, changedLicense);
    await mutateManifest(root, (manifest) => {
      manifest.licenseSha256 = sha256(changedLicense);
    });
    await assert.rejects(
      () => verifyVendor(root),
      /pinned root BSD license SHA-256 mismatch/,
    );
  });
});

test("every normalized embedded notice and its hash are mandatory", async (t) => {
  await t.test("missing notice record", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      const source = manifest.files.find(({ embeddedNotices }) => embeddedNotices.length > 0);
      source.embeddedNotices.shift();
    });
    await assert.rejects(() => verifyVendor(root), /embedded notice inventory mismatch/);
  });

  await t.test("changed notice hash", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      const source = manifest.files.find(({ embeddedNotices }) => embeddedNotices.length > 0);
      source.embeddedNotices[0].sha256 = "0".repeat(64);
    });
    await assert.rejects(() => verifyVendor(root), /embedded notice SHA-256 mismatch/);
  });
});

test("derived target state is exact, anchored, and byte-verified", async (t) => {
  await t.test("an existing target cannot remain pending", async (t) => {
    const root = await makeTemporaryRepository(t);
    const manifest = await readManifest(root);
    const target = derivedEntry(manifest).derivedTargets[0];
    await createDerivedTarget(root, target.path, "derived\n");
    await mutateManifest(root, (temporaryManifest) => {
      derivedEntry(temporaryManifest).derivedTargets[0].localSha256 = "pending";
    });
    await assert.rejects(() => verifyVendor(root), /existing derived target.*pending/);
  });

  await t.test("a missing target cannot retain a digest", async (t) => {
    const root = await makeTemporaryRepository(t);
    const manifest = await mutateManifest(root, (temporaryManifest) => {
      derivedEntry(temporaryManifest).derivedTargets[0].localSha256 = "0".repeat(64);
    });
    const targetPath = path.join(
      root,
      ...derivedEntry(manifest).derivedTargets[0].path.split("/"),
    );
    await unlink(targetPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
    await assert.rejects(() => verifyVendor(root), /missing derived target.*digest/);
  });

  await t.test("changed derived bytes fail", async (t) => {
    const root = await makeTemporaryRepository(t);
    const manifest = await readManifest(root);
    const target = derivedEntry(manifest).derivedTargets[0];
    const targetPath = await createDerivedTarget(root, target.path, "derived v1\n");
    await updateChromiumDerivations(root);
    await writeFile(targetPath, "derived v2\n");
    await assert.rejects(() => verifyVendor(root), /derived target SHA-256 mismatch/);
  });

  await t.test("missing change-record anchor fails", async (t) => {
    const root = await makeTemporaryRepository(t);
    const changesPath = path.join(root, VENDOR_RELATIVE, "PIN_OP_CHANGES.md");
    const changes = await readFile(changesPath, "utf8");
    await writeFile(changesPath, changes.replace('<a id="scoped-styles"></a>', ""));
    await assert.rejects(
      () => verifyVendor(root),
      /missing change-record anchor.*scoped-styles/,
    );
  });

  await t.test("unknown change-record anchor fails", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      derivedEntry(manifest).derivedTargets[0].changeRecord = "PIN_OP_CHANGES.md#unknown";
    });
    await assert.rejects(() => verifyVendor(root), /unexpected derived target mapping/);
  });

  await t.test("an unrecorded target fails", async (t) => {
    const root = await makeTemporaryRepository(t);
    await mutateManifest(root, (manifest) => {
      derivedEntry(manifest).derivedTargets = [];
    });
    await assert.rejects(() => verifyVendor(root), /unexpected derived target mapping/);
  });
});

test("derived hashes are recorded and refreshed deterministically", async (t) => {
  const root = await makeTemporaryRepository(t);
  const initialManifest = await readManifest(root);
  const target = derivedEntry(initialManifest).derivedTargets[0];
  const originalMappings = initialManifest.files.map(({ upstreamPath, derivedTargets }) => ({
    upstreamPath,
    derivedTargets: derivedTargets.map(({ path: targetPath, changeRecord }) => ({
      path: targetPath,
      changeRecord,
    })),
  }));

  const targetPath = await createDerivedTarget(root, target.path, "derived v1\n");
  await updateChromiumDerivations(root);
  let updated = await readManifest(root);
  assert.equal(derivedEntry(updated).derivedTargets[0].localSha256, sha256("derived v1\n"));

  await writeFile(targetPath, "derived v2\n");
  await updateChromiumDerivations(root);
  updated = await readManifest(root);
  assert.equal(derivedEntry(updated).derivedTargets[0].localSha256, sha256("derived v2\n"));

  await unlink(targetPath);
  await updateChromiumDerivations(root);
  updated = await readManifest(root);
  assert.equal(derivedEntry(updated).derivedTargets[0].localSha256, "pending");
  assert.deepEqual(
    updated.files.map(({ upstreamPath, derivedTargets }) => ({
      upstreamPath,
      derivedTargets: derivedTargets.map(({ path: targetPath, changeRecord }) => ({
        path: targetPath,
        changeRecord,
      })),
    })),
    originalMappings,
  );
});

test("verifyVendor rejects an upstream snapshot through a directory-link ancestor", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-verify-link-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-outside-"));
  const snapshotLink = path.join(root, VENDOR_RELATIVE, "upstream");
  t.after(async () => {
    await removeDirectoryLink(snapshotLink);
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  await populateTemporaryRepository(root);
  const outsideSnapshot = path.join(outsideRoot, "upstream");
  await cp(path.join(VENDOR_ROOT, "upstream"), outsideSnapshot, { recursive: true });
  await rm(snapshotLink, { recursive: true, force: true });
  await createDirectoryLink(outsideSnapshot, snapshotLink);

  await assert.rejects(() => verifyVendor(root), /physical confinement/i);
});

test("derived updater rejects a target through a directory-link ancestor", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-update-link-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-outside-"));
  await populateTemporaryRepository(root);
  const manifest = await readManifest(root);
  const target = derivedEntry(manifest).derivedTargets[0];
  const targetPath = path.join(root, ...target.path.split("/"));
  const targetLink = path.dirname(targetPath);
  t.after(async () => {
    await removeDirectoryLink(targetLink);
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  await rm(targetLink, { recursive: true, force: true });
  await mkdir(path.dirname(targetLink), { recursive: true });
  const outsideTargetDirectory = path.join(outsideRoot, "dom");
  await mkdir(outsideTargetDirectory, { recursive: true });
  await writeFile(
    path.join(outsideTargetDirectory, path.basename(targetPath)),
    "outside derived bytes\n",
  );
  await createDirectoryLink(outsideTargetDirectory, targetLink);
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  const before = await readFile(manifestPath, "utf8");

  await assert.rejects(() => updateChromiumDerivations(root), /physical confinement/i);
  assert.equal(await readFile(manifestPath, "utf8"), before);
});

test("importer rejects a vendor output path through a directory-link ancestor", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-import-link-"));
  const outsideVendor = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-outside-"));
  const vendorLink = path.join(root, VENDOR_RELATIVE);
  t.after(async () => {
    await removeDirectoryLink(vendorLink);
    await rm(root, { recursive: true, force: true });
    await rm(outsideVendor, { recursive: true, force: true });
  });

  await mkdir(path.dirname(vendorLink), { recursive: true });
  await createDirectoryLink(outsideVendor, vendorLink);
  const responseBytes = await makePinnedResponses();
  const requests = [];

  await assert.rejects(
    () => vendorChromiumElements({
      repositoryRoot: root,
      revision: PINNED_REVISION,
      importDate: "2026-08-22",
      fetchImpl: makeSuccessfulFetch(responseBytes, requests),
    }),
    /physical confinement/i,
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(await readdir(outsideVendor), []);
});

test("hermetic successful import replaces the snapshot and verifies offline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-import-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendorRoot = path.join(root, VENDOR_RELATIVE);
  const staleElementsRoot = path.join(
    vendorRoot,
    "upstream",
    "front_end",
    "panels",
    "elements",
  );
  await mkdir(staleElementsRoot, { recursive: true });
  const policyBytes = await readFile(path.join(VENDOR_ROOT, "PIN_OP_CHANGES.md"));
  await writeFile(path.join(vendorRoot, "PIN_OP_CHANGES.md"), policyBytes);
  await writeFile(path.join(vendorRoot, "LICENSE"), "stale license\n");
  await writeFile(path.join(vendorRoot, "UPSTREAM.json"), "stale manifest\n");
  await writeFile(path.join(staleElementsRoot, "ElementsTreeOutline.ts"), "stale source\n");
  const extraPath = path.join(staleElementsRoot, "ElementsPanel.ts");
  await writeFile(extraPath, "unallowlisted stale source\n");

  const derivedBytes = Buffer.from("existing derived output\n");
  const derivedPath = EXPECTED_DERIVED_TARGETS
    .get("front_end/panels/elements/elementsTreeOutline.css")[0].path;
  await createDerivedTarget(root, derivedPath, derivedBytes);

  const responseBytes = await makePinnedResponses();
  const requests = [];
  const manifest = await vendorChromiumElements({
    repositoryRoot: root,
    revision: PINNED_REVISION,
    importDate: "2026-08-22",
    fetchImpl: makeSuccessfulFetch(responseBytes, requests),
  });

  assert.deepEqual(
    requests,
    ["LICENSE", ...EXPECTED_IMPORT_PATHS].map((upstreamPath) => (
      rawUrlFor(PINNED_REVISION, upstreamPath)
    )),
  );
  assert.equal(requests.length, 11);
  const expectedManifest = {
    repository: REPOSITORY_URL,
    revision: PINNED_REVISION,
    importedAt: "2026-08-22",
    license: "LICENSE",
    licenseSha256: sha256(responseBytes.get("LICENSE")),
    files: EXPECTED_IMPORT_PATHS.map((upstreamPath) => {
      const expectedBytes = responseBytes.get(upstreamPath);
      return {
        upstreamPath,
        sha256: sha256(expectedBytes),
        embeddedNotices: extractEmbeddedNotices(expectedBytes.toString("utf8")),
        derivedTargets: EXPECTED_DERIVED_TARGETS.get(upstreamPath).map((target) => ({
          ...target,
          localSha256: target.path === derivedPath ? sha256(derivedBytes) : "pending",
        })),
      };
    }),
  };
  assert.deepEqual(manifest, expectedManifest);
  assert.deepEqual(await readManifest(root), expectedManifest);
  assert.deepEqual(await readFile(path.join(vendorRoot, "LICENSE")), responseBytes.get("LICENSE"));
  assert.deepEqual(await readFile(path.join(vendorRoot, "PIN_OP_CHANGES.md")), policyBytes);

  for (const source of manifest.files) {
    const expectedBytes = responseBytes.get(source.upstreamPath);
    assert.deepEqual(
      await readFile(upstreamFilePath(root, source.upstreamPath)),
      expectedBytes,
    );
  }

  assert.equal(await exists(extraPath), false);
  await verifyVendor(root);
});

test("a failed import writes no vendor files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pin-op-chromium-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const responseBytes = await makePinnedResponses();
  const failedPath = EXPECTED_IMPORT_PATHS.at(-1);
  const fetchImpl = async (url) => {
    const marker = `/${PINNED_REVISION}/`;
    const requestPath = decodeURIComponent(new URL(url).pathname.split(marker)[1]);
    if (requestPath === failedPath) {
      return new Response("upstream failure", { status: 503 });
    }
    return new Response(responseBytes.get(requestPath), { status: 200 });
  };

  await assert.rejects(
    () => vendorChromiumElements({
      repositoryRoot: root,
      revision: PINNED_REVISION,
      importDate: "2026-08-22",
      fetchImpl,
    }),
    /download failed.*503/,
  );
  assert.equal(await exists(path.join(root, VENDOR_RELATIVE)), false);
});

test("the patch policy and refresh runbook retain stable commands and anchors", async () => {
  const changes = await readFile(path.join(VENDOR_ROOT, "PIN_OP_CHANGES.md"), "utf8");
  for (const anchor of ["dom-tree", "rules", "scoped-styles"]) {
    assert.match(changes, new RegExp(`<a id=["']${anchor}["']></a>`));
  }
  for (const removedCapability of [
    "editing",
    "context menus",
    "AI features",
    "SDK/CDP objects",
    "Linkifier",
    "Metrics/Layout/Computed",
    "DevTools Host",
    "telemetry",
    "browser branding",
  ]) {
    assert.ok(changes.includes(removedCapability), `records removal of ${removedCapability}`);
  }

  const readme = await readFile(path.join(VENDOR_ROOT, "README.pin-op.md"), "utf8");
  for (const command of [
    "corepack pnpm vendor:chromium-elements",
    "corepack pnpm vendor:chromium-elements:record-derived",
    "corepack pnpm vendor:chromium-elements:check",
    "corepack pnpm vendor:chromium-elements:check-complete",
  ]) {
    assert.ok(readme.includes(command), `documents ${command}`);
  }
});

test("Git attributes preserve exact LF bytes for the hashed vendor inputs", async () => {
  const attributes = await readFile(path.join(VENDOR_ROOT, ".gitattributes"), "utf8");
  assert.equal(attributes, "LICENSE text eol=lf\nupstream/** text eol=lf\n");

  const repositoryAttributes = await readFile(path.join(REPO_ROOT, ".gitattributes"), "utf8");
  const rules = repositoryAttributes.split(/\r?\n/u);
  assert.ok(
    rules.includes("third_party/chromium-devtools-frontend/patches/** text eol=lf"),
    "the byte-hashed production overlay must retain LF outside the exact vendor contract",
  );
});
