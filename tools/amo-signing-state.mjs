import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseTag } from "./verify-release-version.mjs";

const STATE_KEYS = ["channel", "uploadUuid", "xpiCrcHash"];
const PROVENANCE_KEYS = [
  "eventName",
  "releaseCommit",
  "releaseTag",
  "repository",
  "runId",
  "schemaVersion",
  "workflowCommit",
  "workflowPath",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRC_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const WORKFLOW_RUN_PATH_PATTERN =
  /^(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)(?:@([A-Za-z0-9][A-Za-z0-9._/-]*))?$/;
const RESUMABLE_CONCLUSIONS = new Set(["cancelled", "failure", "timed_out"]);

export function createAmoStateArtifactName(tag, runId) {
  parseReleaseTag(tag);
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("GitHub run id must be a positive integer");
  }
  return `pinop-amo-state-${tag}-run-${runId}`;
}

export function parseAmoUploadState(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid AMO upload state");
  }

  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    JSON.stringify(keys) !== JSON.stringify(STATE_KEYS) ||
    !UUID_PATTERN.test(value.uploadUuid) ||
    value.channel !== "unlisted" ||
    !CRC_PATTERN.test(value.xpiCrcHash)
  ) {
    throw new Error("Invalid AMO upload state");
  }

  return {
    uploadUuid: value.uploadUuid,
    channel: value.channel,
    xpiCrcHash: value.xpiCrcHash,
  };
}

export function createAmoUploadProvenance(input) {
  if (!REPOSITORY_PATTERN.test(input?.repository ?? "")) {
    throw new Error("Invalid AMO upload provenance repository");
  }
  if (!WORKFLOW_PATH_PATTERN.test(input?.workflowPath ?? "")) {
    throw new Error("Invalid AMO upload provenance workflow path");
  }
  if (input?.eventName !== "workflow_dispatch") {
    throw new Error("Invalid AMO upload provenance event");
  }
  parseReleaseTag(input?.releaseTag ?? "");
  if (!COMMIT_PATTERN.test(input?.releaseCommit ?? "")) {
    throw new Error("Invalid AMO upload provenance release commit");
  }
  if (!COMMIT_PATTERN.test(input?.workflowCommit ?? "")) {
    throw new Error("Invalid AMO upload provenance workflow commit");
  }

  return {
    schemaVersion: 1,
    repository: input.repository,
    workflowPath: input.workflowPath,
    eventName: input.eventName,
    releaseTag: input.releaseTag,
    releaseCommit: input.releaseCommit,
    workflowCommit: input.workflowCommit,
    runId: positiveInteger(input.runId, "GitHub run id"),
  };
}

export function parseAmoUploadProvenance(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid AMO upload provenance");
  }

  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    JSON.stringify(keys) !== JSON.stringify([...PROVENANCE_KEYS].sort()) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string"
  ) {
    throw new Error("Invalid AMO upload provenance");
  }
  try {
    return createAmoUploadProvenance(value);
  } catch {
    throw new Error("Invalid AMO upload provenance");
  }
}

export function validateAmoResumeProvenance(
  provenanceSource,
  workflowRunSource,
  expected,
) {
  const provenance = parseAmoUploadProvenance(provenanceSource);
  const expectedRunId = positiveInteger(expected?.runId, "Expected GitHub run id");
  const expectedFields = [
    ["repository", expected?.repository],
    ["workflowPath", expected?.workflowPath],
    ["eventName", expected?.eventName],
    ["releaseTag", expected?.releaseTag],
    ["releaseCommit", expected?.releaseCommit],
    ["runId", expectedRunId],
  ];
  if (
    expectedFields.some(([key, value]) => provenance[key] !== value) ||
    (expected?.workflowCommit !== undefined &&
      provenance.workflowCommit !== expected.workflowCommit)
  ) {
    throw new Error("AMO upload provenance does not match this release run");
  }

  const workflowRun = parseWorkflowRun(workflowRunSource);
  if (
    workflowRun.id !== provenance.runId ||
    workflowRun.repository !== provenance.repository ||
    workflowRun.path !== provenance.workflowPath ||
    workflowRun.event !== provenance.eventName ||
    workflowRun.headSha !== provenance.workflowCommit
  ) {
    throw new Error("GitHub workflow run does not match AMO upload provenance");
  }
  return provenance;
}

export async function preserveAmoUploadState(sourcePath, destinationPath) {
  let source;
  try {
    source = await readFile(resolve(sourcePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  const state = parseAmoUploadState(source);
  const destination = resolve(destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}

export async function preserveAmoUploadBundle(sourcePath, destinationDirectory, input) {
  let source;
  try {
    source = await readFile(resolve(sourcePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  const state = parseAmoUploadState(source);
  const provenance = createAmoUploadProvenance(input);
  const destination = resolve(destinationDirectory);
  await mkdir(destination, { mode: 0o700 });
  await Promise.all([
    writeFile(resolve(destination, ".amo-upload-uuid"), `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(
      resolve(destination, ".amo-upload-provenance.json"),
      `${JSON.stringify(provenance)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ),
  ]);
  return true;
}

function parseWorkflowRun(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid GitHub workflow run metadata");
  }
  const id = positiveInteger(value?.id, "GitHub workflow run id");
  const workflowPath = normalizeWorkflowRunPath(value?.path);
  if (
    value?.event !== "workflow_dispatch" ||
    value?.head_branch !== "master" ||
    !COMMIT_PATTERN.test(value?.head_sha ?? "") ||
    !REPOSITORY_PATTERN.test(value?.repository?.full_name ?? "") ||
    value?.status !== "completed" ||
    !RESUMABLE_CONCLUSIONS.has(value?.conclusion)
  ) {
    throw new Error("Invalid GitHub workflow run metadata");
  }
  return {
    id,
    event: value.event,
    headSha: value.head_sha,
    path: workflowPath,
    repository: value.repository.full_name,
  };
}

function normalizeWorkflowRunPath(value) {
  const match = typeof value === "string" ? WORKFLOW_RUN_PATH_PATTERN.exec(value) : null;
  const ref = match?.[2];
  if (
    !match ||
    (ref !== undefined &&
      (ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")))
  ) {
    throw new Error("Invalid GitHub workflow run metadata");
  }
  return match[1];
}

function positiveInteger(value, label) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  throw new Error(`${label} must be a positive integer`);
}

async function runCli() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "artifact-name" && arguments_.length === 2) {
    process.stdout.write(`${createAmoStateArtifactName(arguments_[0], arguments_[1])}\n`);
    return;
  }
  if (command === "validate" && arguments_.length === 1) {
    parseAmoUploadState(await readFile(resolve(arguments_[0]), "utf8"));
    process.stdout.write("AMO upload state is valid\n");
    return;
  }
  if (command === "preserve" && arguments_.length === 2) {
    const preserved = await preserveAmoUploadState(arguments_[0], arguments_[1]);
    process.stdout.write(preserved ? "AMO upload state prepared\n" : "No AMO upload state was created\n");
    return;
  }
  if (command === "preserve-bundle" && arguments_.length === 9) {
    const preserved = await preserveAmoUploadBundle(arguments_[0], arguments_[1], {
      repository: arguments_[2],
      workflowPath: arguments_[3],
      eventName: arguments_[4],
      releaseTag: arguments_[5],
      releaseCommit: arguments_[6],
      workflowCommit: arguments_[7],
      runId: arguments_[8],
    });
    process.stdout.write(preserved ? "AMO upload bundle prepared\n" : "No AMO upload state was created\n");
    return;
  }
  if (command === "validate-resume" && arguments_.length === 9) {
    parseAmoUploadState(await readFile(resolve(arguments_[0]), "utf8"));
    validateAmoResumeProvenance(
      await readFile(resolve(arguments_[1]), "utf8"),
      await readFile(resolve(arguments_[2]), "utf8"),
      {
        repository: arguments_[3],
        workflowPath: arguments_[4],
        eventName: arguments_[5],
        releaseTag: arguments_[6],
        releaseCommit: arguments_[7],
        runId: arguments_[8],
      },
    );
    process.stdout.write("AMO upload state and provenance are valid\n");
    return;
  }
  throw new Error(
    "Usage: amo-signing-state <artifact-name TAG RUN_ID|validate PATH|preserve SOURCE DESTINATION|" +
      "preserve-bundle SOURCE DESTINATION REPOSITORY WORKFLOW EVENT TAG RELEASE_COMMIT WORKFLOW_COMMIT RUN_ID|" +
      "validate-resume STATE PROVENANCE RUN_JSON REPOSITORY WORKFLOW EVENT TAG RELEASE_COMMIT RUN_ID>",
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
