import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseTag } from "./verify-release-version.mjs";

export const SIGNED_XPI_PROVENANCE_FILENAME = "signed-xpi-provenance.json";
const MAX_SIGNED_XPI_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const WORKFLOW_RUN_PATH_PATTERN =
  /^(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)(?:@(?:refs\/heads\/)?master)?$/;
const PROVENANCE_KEYS = [
  "eventName",
  "releaseCommit",
  "releaseDatabaseId",
  "releaseTag",
  "repository",
  "schemaVersion",
  "signRunId",
  "workflowCommit",
  "workflowPath",
  "xpiFilename",
  "xpiSha256",
].sort();

export function createSignedXpiArtifactName(tag, runId) {
  parseReleaseTag(tag);
  return `pinop-signed-xpi-${tag}-run-${positiveInteger(runId, "Sign run id")}`;
}

export async function createSignedXpiBundle(xpiPath, destinationDirectory, input) {
  const version = parseReleaseTag(input?.releaseTag ?? "");
  const expectedFilename = `pinop-firefox-${version}.xpi`;
  const source = resolve(xpiPath);
  const sourceStats = await assertRegularFile(source, "Signed XPI");
  if (sourceStats.size <= 0 || sourceStats.size > MAX_SIGNED_XPI_BYTES) {
    throw new Error(`Signed XPI size must be between 1 and ${MAX_SIGNED_XPI_BYTES} bytes`);
  }
  if (basename(source) !== expectedFilename) {
    throw new Error(`Signed XPI filename must be ${expectedFilename}`);
  }

  const bytes = await readFile(source);
  const provenance = createSignedXpiProvenance({
    ...input,
    xpiFilename: expectedFilename,
    xpiSha256: sha256(bytes),
  });
  const destination = resolve(destinationDirectory);
  await mkdir(destination, { mode: 0o700 });
  await Promise.all([
    copyFile(source, resolve(destination, expectedFilename)),
    writeFile(
      resolve(destination, SIGNED_XPI_PROVENANCE_FILENAME),
      `${JSON.stringify(provenance)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ),
  ]);
  return provenance;
}

export async function validateCurrentSignedXpiBundle(bundleDirectory, expected) {
  const { provenance, bytes } = await readAndValidateBundle(bundleDirectory);
  assertExpectedProvenance(provenance, expected);
  if (
    expected?.workflowCommit !== undefined &&
    provenance.workflowCommit !== expected.workflowCommit
  ) {
    throw new Error("Signed XPI provenance does not match this workflow commit");
  }
  if (sha256(bytes) !== provenance.xpiSha256) {
    throw new Error("Signed XPI digest does not match provenance");
  }
  return provenance;
}

export async function validateSignedXpiBundle(
  bundleDirectory,
  workflowRunSource,
  expected,
) {
  const provenance = await validateCurrentSignedXpiBundle(bundleDirectory, expected);
  if (!HASH_PATTERN.test(expected?.verifiedXpiSha256 ?? "")) {
    throw new Error("Manually verified XPI digest must be lowercase SHA-256");
  }
  if (provenance.xpiSha256 !== expected.verifiedXpiSha256) {
    throw new Error("Manually verified XPI digest does not match signed provenance");
  }

  const run = parseTrustedWorkflowRun(workflowRunSource);
  if (
    run.id !== provenance.signRunId ||
    run.repository !== provenance.repository ||
    run.workflowPath !== provenance.workflowPath ||
    run.eventName !== provenance.eventName ||
    run.workflowCommit !== provenance.workflowCommit
  ) {
    throw new Error("GitHub run is not the trusted signing workflow run");
  }
  return provenance;
}

export function createSignedXpiProvenance(input) {
  if (!REPOSITORY_PATTERN.test(input?.repository ?? "")) {
    throw new Error("Invalid signed XPI provenance repository");
  }
  if (!WORKFLOW_PATH_PATTERN.test(input?.workflowPath ?? "")) {
    throw new Error("Invalid signed XPI provenance workflow path");
  }
  if (input?.eventName !== "workflow_dispatch") {
    throw new Error("Invalid signed XPI provenance event");
  }
  const version = parseReleaseTag(input?.releaseTag ?? "");
  if (!COMMIT_PATTERN.test(input?.releaseCommit ?? "")) {
    throw new Error("Invalid signed XPI provenance release commit");
  }
  if (!COMMIT_PATTERN.test(input?.workflowCommit ?? "")) {
    throw new Error("Invalid signed XPI provenance workflow commit");
  }
  const xpiFilename = `pinop-firefox-${version}.xpi`;
  if (input?.xpiFilename !== xpiFilename || !HASH_PATTERN.test(input?.xpiSha256 ?? "")) {
    throw new Error("Invalid signed XPI provenance artifact");
  }
  return {
    schemaVersion: 1,
    repository: input.repository,
    workflowPath: input.workflowPath,
    eventName: input.eventName,
    releaseTag: input.releaseTag,
    releaseCommit: input.releaseCommit,
    workflowCommit: input.workflowCommit,
    signRunId: positiveInteger(input.signRunId, "Sign run id"),
    releaseDatabaseId: positiveInteger(
      input.releaseDatabaseId,
      "Release database id",
    ),
    xpiFilename,
    xpiSha256: input.xpiSha256,
  };
}

export function parseSignedXpiProvenance(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid signed XPI provenance");
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    value?.schemaVersion !== 1 ||
    JSON.stringify(keys) !== JSON.stringify(PROVENANCE_KEYS)
  ) {
    throw new Error("Invalid signed XPI provenance");
  }
  try {
    return createSignedXpiProvenance(value);
  } catch {
    throw new Error("Invalid signed XPI provenance");
  }
}

async function readAndValidateBundle(bundleDirectory) {
  const directory = resolve(bundleDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const provenanceEntry = entries.find(
    (entry) => entry.name === SIGNED_XPI_PROVENANCE_FILENAME,
  );
  if (!provenanceEntry?.isFile() || provenanceEntry.isSymbolicLink()) {
    throw new Error("Signed XPI bundle file set is invalid");
  }
  const provenance = parseSignedXpiProvenance(
    await readFile(resolve(directory, SIGNED_XPI_PROVENANCE_FILENAME), "utf8"),
  );
  const expectedNames = [SIGNED_XPI_PROVENANCE_FILENAME, provenance.xpiFilename].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Signed XPI bundle file set is invalid");
  }
  const xpiPath = resolve(directory, provenance.xpiFilename);
  const stats = await assertRegularFile(xpiPath, "Signed XPI bundle artifact");
  if (stats.size <= 0 || stats.size > MAX_SIGNED_XPI_BYTES) {
    throw new Error("Signed XPI bundle artifact has an invalid size");
  }
  return { provenance, bytes: await readFile(xpiPath) };
}

function assertExpectedProvenance(provenance, expected) {
  const expectedRunId = positiveInteger(expected?.signRunId, "Expected sign run id");
  for (const [field, value] of [
    ["repository", expected?.repository],
    ["workflowPath", expected?.workflowPath],
    ["eventName", expected?.eventName],
    ["releaseTag", expected?.releaseTag],
    ["releaseCommit", expected?.releaseCommit],
    ["signRunId", expectedRunId],
  ]) {
    if (provenance[field] !== value) {
      throw new Error("Signed XPI provenance does not match this release");
    }
  }
}

function parseTrustedWorkflowRun(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("GitHub run is not the trusted signing workflow run");
  }
  const pathMatch = typeof value?.path === "string"
    ? WORKFLOW_RUN_PATH_PATTERN.exec(value.path)
    : null;
  let id;
  try {
    id = positiveInteger(value?.id, "Workflow run id");
  } catch {
    throw new Error("GitHub run is not the trusted signing workflow run");
  }
  if (
    !pathMatch ||
    value.event !== "workflow_dispatch" ||
    value.head_branch !== "master" ||
    !COMMIT_PATTERN.test(value.head_sha ?? "") ||
    value.status !== "completed" ||
    value.conclusion !== "success" ||
    !REPOSITORY_PATTERN.test(value?.repository?.full_name ?? "")
  ) {
    throw new Error("GitHub run is not the trusted signing workflow run");
  }
  return {
    id,
    repository: value.repository.full_name,
    workflowPath: pathMatch[1],
    eventName: value.event,
    workflowCommit: value.head_sha,
  };
}

async function assertRegularFile(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return stats;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  throw new Error(`${label} must be a positive integer`);
}

async function runCli() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "artifact-name" && arguments_.length === 2) {
    process.stdout.write(`${createSignedXpiArtifactName(arguments_[0], arguments_[1])}\n`);
    return;
  }
  if (command === "create-bundle" && arguments_.length === 10) {
    const provenance = await createSignedXpiBundle(arguments_[0], arguments_[1], {
      repository: arguments_[2],
      workflowPath: arguments_[3],
      eventName: arguments_[4],
      releaseTag: arguments_[5],
      releaseCommit: arguments_[6],
      workflowCommit: arguments_[7],
      signRunId: arguments_[8],
      releaseDatabaseId: arguments_[9],
    });
    process.stdout.write(`${provenance.xpiSha256}\n`);
    return;
  }
  if (command === "validate-current" && arguments_.length === 8) {
    const provenance = await validateCurrentSignedXpiBundle(arguments_[0], {
      repository: arguments_[1],
      workflowPath: arguments_[2],
      eventName: arguments_[3],
      releaseTag: arguments_[4],
      releaseCommit: arguments_[5],
      workflowCommit: arguments_[6],
      signRunId: arguments_[7],
    });
    process.stdout.write(`${provenance.releaseDatabaseId}\n`);
    return;
  }
  if (command === "validate-publish" && arguments_.length === 9) {
    const provenance = await validateSignedXpiBundle(arguments_[0], arguments_[1], {
      repository: arguments_[2],
      workflowPath: arguments_[3],
      eventName: arguments_[4],
      releaseTag: arguments_[5],
      releaseCommit: arguments_[6],
      signRunId: arguments_[7],
      verifiedXpiSha256: arguments_[8],
    });
    process.stdout.write(`${provenance.releaseDatabaseId}\n`);
    return;
  }
  throw new Error(
    "Usage: release-signing-provenance <artifact-name TAG RUN_ID|" +
      "create-bundle XPI DEST REPOSITORY WORKFLOW EVENT TAG RELEASE_COMMIT WORKFLOW_COMMIT RUN_ID RELEASE_DATABASE_ID|" +
      "validate-current BUNDLE REPOSITORY WORKFLOW EVENT TAG RELEASE_COMMIT WORKFLOW_COMMIT RUN_ID|" +
      "validate-publish BUNDLE RUN_JSON REPOSITORY WORKFLOW EVENT TAG RELEASE_COMMIT RUN_ID VERIFIED_SHA256>",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
