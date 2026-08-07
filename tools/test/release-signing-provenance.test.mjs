import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  SIGNED_XPI_PROVENANCE_FILENAME,
  createSignedXpiArtifactName,
  createSignedXpiBundle,
  validateSignedXpiBundle,
} from "../release-signing-provenance.mjs";
import { withTemporaryDirectory } from "./test-helpers.mjs";

const releaseCommit = "1".repeat(40);
const workflowCommit = "2".repeat(40);
const xpiSha256 = "d8e8fca2dc0f896fd7cb4cb0031ba249" +
  "00000000000000000000000000000000";

function provenanceInput(overrides = {}) {
  return {
    repository: "conus-vision/Browser2IDE",
    workflowPath: ".github/workflows/firefox-sign.yml",
    eventName: "workflow_dispatch",
    releaseTag: "v0.3.0",
    releaseCommit,
    workflowCommit,
    signRunId: "12345",
    releaseDatabaseId: "67890",
    ...overrides,
  };
}

function completedRun(overrides = {}) {
  return JSON.stringify({
    id: 12345,
    event: "workflow_dispatch",
    head_branch: "master",
    head_sha: workflowCommit,
    path: ".github/workflows/firefox-sign.yml@refs/heads/master",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "conus-vision/Browser2IDE" },
    ...overrides,
  });
}

test("signed XPI artifact names are tag and run specific", () => {
  assert.equal(
    createSignedXpiArtifactName("v0.3.0", "12345"),
    "browser2ide-signed-xpi-v0.3.0-run-12345",
  );
  assert.throws(() => createSignedXpiArtifactName("0.3.0", "12345"), /release tag/i);
  assert.throws(() => createSignedXpiArtifactName("v0.3.0", "0"), /run id/i);
});

test("signed XPI bundle records and validates the exact AMO-returned bytes", async () => {
  await withTemporaryDirectory("browser2ide-signed-provenance-", async (directory) => {
    const sourcePath = resolve(directory, "browser2ide-firefox-0.3.0.xpi");
    const bundlePath = resolve(directory, "bundle");
    await writeFile(sourcePath, "signed xpi bytes");

    const created = await createSignedXpiBundle(sourcePath, bundlePath, provenanceInput());
    assert.match(created.xpiSha256, /^[0-9a-f]{64}$/);
    assert.equal(created.xpiFilename, "browser2ide-firefox-0.3.0.xpi");

    const validated = await validateSignedXpiBundle(
      bundlePath,
      completedRun(),
      {
        repository: "conus-vision/Browser2IDE",
        workflowPath: ".github/workflows/firefox-sign.yml",
        eventName: "workflow_dispatch",
        releaseTag: "v0.3.0",
        releaseCommit,
        signRunId: "12345",
        verifiedXpiSha256: created.xpiSha256,
      },
    );
    assert.deepEqual(validated, created);

    const persisted = JSON.parse(
      await readFile(resolve(bundlePath, SIGNED_XPI_PROVENANCE_FILENAME), "utf8"),
    );
    assert.equal(persisted.xpiSha256, created.xpiSha256);
    assert.equal(persisted.workflowCommit, workflowCommit);
  });
});

test("publication rejects an unverified digest, a tampered XPI, and extra bundle files", async () => {
  await withTemporaryDirectory("browser2ide-signed-tamper-", async (directory) => {
    const sourcePath = resolve(directory, "browser2ide-firefox-0.3.0.xpi");
    const bundlePath = resolve(directory, "bundle");
    await writeFile(sourcePath, "signed xpi bytes");
    const provenance = await createSignedXpiBundle(
      sourcePath,
      bundlePath,
      provenanceInput(),
    );
    const expected = {
      repository: "conus-vision/Browser2IDE",
      workflowPath: ".github/workflows/firefox-sign.yml",
      eventName: "workflow_dispatch",
      releaseTag: "v0.3.0",
      releaseCommit,
      signRunId: "12345",
      verifiedXpiSha256: provenance.xpiSha256,
    };

    await assert.rejects(
      validateSignedXpiBundle(bundlePath, completedRun(), {
        ...expected,
        verifiedXpiSha256: xpiSha256,
      }),
      /manually verified XPI digest/i,
    );

    await writeFile(resolve(bundlePath, provenance.xpiFilename), "replacement bytes");
    await assert.rejects(
      validateSignedXpiBundle(bundlePath, completedRun(), expected),
      /XPI digest/i,
    );

    await writeFile(resolve(bundlePath, provenance.xpiFilename), "signed xpi bytes");
    await writeFile(resolve(bundlePath, "unexpected.txt"), "unexpected");
    await assert.rejects(
      validateSignedXpiBundle(bundlePath, completedRun(), expected),
      /bundle file set/i,
    );
  });
});

test("publication accepts only a completed successful master workflow run", async () => {
  await withTemporaryDirectory("browser2ide-signed-run-", async (directory) => {
    const sourcePath = resolve(directory, "browser2ide-firefox-0.3.0.xpi");
    const bundlePath = resolve(directory, "bundle");
    await writeFile(sourcePath, "signed xpi bytes");
    const provenance = await createSignedXpiBundle(
      sourcePath,
      bundlePath,
      provenanceInput(),
    );
    const expected = {
      repository: "conus-vision/Browser2IDE",
      workflowPath: ".github/workflows/firefox-sign.yml",
      eventName: "workflow_dispatch",
      releaseTag: "v0.3.0",
      releaseCommit,
      signRunId: "12345",
      verifiedXpiSha256: provenance.xpiSha256,
    };

    await assert.doesNotReject(
      validateSignedXpiBundle(
        bundlePath,
        completedRun({ path: ".github/workflows/firefox-sign.yml@master" }),
        expected,
      ),
    );

    for (const run of [
      completedRun({ status: "in_progress", conclusion: null }),
      completedRun({ conclusion: "failure" }),
      completedRun({ head_branch: "feature/untrusted" }),
      completedRun({ head_sha: "3".repeat(40) }),
      completedRun({ path: ".github/workflows/other.yml@refs/heads/master" }),
    ]) {
      await assert.rejects(
        validateSignedXpiBundle(bundlePath, run, expected),
        /trusted signing workflow run/i,
      );
    }
  });
});
