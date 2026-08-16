import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(
  repositoryRoot,
  "artifacts/pin-op-firefox-source-0.3.0.zip",
);

export function archiveArguments(root) {
  const portableRoot = portablePath(root);
  return [
    "-c",
    `safe.directory=${portableRoot}`,
    "-c",
    "core.autocrlf=false",
    "archive",
    "--format=zip",
    "HEAD",
  ];
}

export function createHeadArchiveBuffer(root) {
  const resolvedRoot = resolve(root);
  const result = spawnSync("git", archiveArguments(resolvedRoot), {
    cwd: resolvedRoot,
    encoding: null,
    maxBuffer: MAX_ARCHIVE_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git archive failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  if (!Buffer.isBuffer(result.stdout)) {
    throw new Error("git archive did not return a binary archive");
  }
  return result.stdout;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, createHeadArchiveBuffer(repositoryRoot));
}

function portablePath(path) {
  return resolve(path).replaceAll("\\", "/");
}
