import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createAmoUploadProvenance,
  createAmoStateArtifactName,
  parseAmoUploadState,
  parseAmoUploadProvenance,
  validateAmoResumeProvenance,
} from "../amo-signing-state.mjs";

const validState = {
  uploadUuid: "123e4567-e89b-42d3-a456-426614174000",
  channel: "unlisted",
  xpiCrcHash: "a".repeat(64),
};
const releaseCommit = "1".repeat(40);
const workflowCommit = "2".repeat(40);
const validProvenanceInput = {
  repository: "conus-vision/Browser2IDE",
  workflowPath: ".github/workflows/firefox-sign.yml",
  eventName: "workflow_dispatch",
  releaseTag: "v0.3.0",
  releaseCommit,
  workflowCommit,
  runId: "123456789",
};
const validRun = {
  id: 123456789,
  event: "workflow_dispatch",
  head_branch: "master",
  head_sha: workflowCommit,
  path: ".github/workflows/firefox-sign.yml@master",
  status: "completed",
  conclusion: "failure",
  repository: { full_name: "conus-vision/Browser2IDE" },
};

test("AMO state artifact names use only a validated tag and positive run id", () => {
  assert.equal(
    createAmoStateArtifactName("v0.3.0", "123456789"),
    "browser2ide-amo-state-v0.3.0-run-123456789",
  );

  for (const runId of ["", "0", "01", "-1", "1.5", "12x", " 12", "12\n"] ) {
    assert.throws(
      () => createAmoStateArtifactName("v0.3.0", runId),
      /run id must be a positive integer/,
    );
  }
  assert.throws(
    () => createAmoStateArtifactName("v0.3.0;echo unsafe", "12"),
    /must match vX\.Y\.Z/,
  );
});

test("AMO upload state accepts UUID, channel and CRC only", () => {
  assert.deepEqual(parseAmoUploadState(JSON.stringify(validState)), validState);

  for (const invalid of [
    { ...validState, apiSecret: "must-not-be-uploaded" },
    { ...validState, uploadUuid: "not-a-uuid" },
    { ...validState, channel: "listed" },
    { ...validState, xpiCrcHash: "a".repeat(63) },
  ]) {
    assert.throws(() => parseAmoUploadState(JSON.stringify(invalid)), /Invalid AMO upload state/);
  }
});

test("resume provenance is canonical and contains no credential-shaped fields", () => {
  const provenance = createAmoUploadProvenance(validProvenanceInput);
  assert.deepEqual(parseAmoUploadProvenance(JSON.stringify(provenance)), provenance);
  assert.deepEqual(Object.keys(provenance).sort(), [
    "eventName",
    "releaseCommit",
    "releaseTag",
    "repository",
    "runId",
    "schemaVersion",
    "workflowCommit",
    "workflowPath",
  ]);
  for (const forbidden of ["apiKey", "apiSecret", "token", "credential"]) {
    assert.throws(
      () => parseAmoUploadProvenance(JSON.stringify({ ...provenance, [forbidden]: "unsafe" })),
      /Invalid AMO upload provenance/,
    );
  }
});

test("resume provenance is bound to repository, workflow, event, tag, commits, and run id", () => {
  const provenance = createAmoUploadProvenance(validProvenanceInput);
  assert.deepEqual(
    validateAmoResumeProvenance(
      JSON.stringify(provenance),
      JSON.stringify(validRun),
      validProvenanceInput,
    ),
    provenance,
  );

  for (const [key, value] of [
    ["repository", "attacker/Browser2IDE"],
    ["workflowPath", ".github/workflows/other.yml"],
    ["eventName", "push"],
    ["releaseTag", "v0.2.1"],
    ["releaseCommit", "3".repeat(40)],
    ["runId", "123456788"],
  ]) {
    assert.throws(
      () => validateAmoResumeProvenance(
        JSON.stringify(provenance),
        JSON.stringify(validRun),
        { ...validProvenanceInput, [key]: value },
      ),
      /provenance/i,
    );
  }

  for (const runMutation of [
    { repository: { full_name: "attacker/Browser2IDE" } },
    { path: ".github/workflows/other.yml" },
    { path: ".github/workflows/firefox-sign.yml@../../unsafe" },
    { path: ".github/workflows/firefox-sign.yml@@master" },
    { event: "push" },
    { head_branch: "feature/untrusted" },
    { head_sha: "4".repeat(40) },
    { id: 123456788 },
    { status: "in_progress" },
    { conclusion: "success" },
  ]) {
    assert.throws(
      () => validateAmoResumeProvenance(
        JSON.stringify(provenance),
        JSON.stringify({ ...validRun, ...runMutation }),
        validProvenanceInput,
      ),
      /workflow run|provenance/i,
    );
  }
});

test("preserve command writes a canonical hidden state file without extra fields", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-amo-state-"));
  try {
    const source = resolve(directory, "source.json");
    const destination = resolve(directory, "artifact", ".amo-upload-uuid");
    await writeFile(source, JSON.stringify(validState));

    const result = runTool("preserve", source, destination);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(destination, "utf8"),
      `${JSON.stringify(validState)}\n`,
    );
    assert.doesNotMatch(result.stdout, /123e4567|a{16}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserve bundle writes sanitized state and validated provenance together", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-amo-bundle-"));
  try {
    const source = resolve(directory, "source.json");
    const destination = resolve(directory, "artifact");
    await writeFile(source, JSON.stringify(validState));

    const result = runTool(
      "preserve-bundle",
      source,
      destination,
      validProvenanceInput.repository,
      validProvenanceInput.workflowPath,
      validProvenanceInput.eventName,
      validProvenanceInput.releaseTag,
      validProvenanceInput.releaseCommit,
      validProvenanceInput.workflowCommit,
      validProvenanceInput.runId,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(resolve(destination, ".amo-upload-uuid"), "utf8"),
      `${JSON.stringify(validState)}\n`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(resolve(destination, ".amo-upload-provenance.json"), "utf8")),
      createAmoUploadProvenance(validProvenanceInput),
    );
    assert.doesNotMatch(result.stdout, /123e4567|a{16}|secret|credential/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserve command does not emit an artifact for missing or unsafe state", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "browser2ide-amo-state-"));
  try {
    const missingDestination = resolve(directory, "missing", ".amo-upload-uuid");
    const missing = runTool("preserve", resolve(directory, "absent"), missingDestination);
    assert.equal(missing.status, 0, missing.stderr);
    await assert.rejects(() => readFile(missingDestination), /ENOENT/);

    const unsafeSource = resolve(directory, "unsafe.json");
    const unsafeDestination = resolve(directory, "unsafe", ".amo-upload-uuid");
    await writeFile(
      unsafeSource,
      JSON.stringify({ ...validState, apiKey: "must-not-be-uploaded" }),
    );
    const unsafe = runTool("preserve", unsafeSource, unsafeDestination);
    assert.notEqual(unsafe.status, 0);
    await assert.rejects(() => readFile(unsafeDestination), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runTool(...arguments_) {
  return spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../amo-signing-state.mjs"), ...arguments_],
    { encoding: "utf8" },
  );
}
