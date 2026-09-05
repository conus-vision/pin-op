import { lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedReleaseArtifactPatterns = Object.freeze([
  /^pin-op-chrome-\d+\.\d+\.\d+\.zip$/,
  /^pin-op-firefox-\d+\.\d+\.\d+\.(?:xpi|zip)$/,
  /^pin-op-firefox-source-\d+\.\d+\.\d+\.zip$/,
  /^pin-op-vscode-\d+\.\d+\.\d+\.vsix$/,
  /^SHA256SUMS$/,
]);
// A packaged archive extracted next to itself, which is how a candidate build
// is loaded unpacked. The names carry no extension, so a directory that merely
// mimics an artifact file name is still left alone.
const generatedUnpackedBuildPatterns = Object.freeze([
  /^pin-op-chrome-\d+\.\d+\.\d+$/,
  /^pin-op-firefox-\d+\.\d+\.\d+$/,
  /^pin-op-firefox-source-\d+\.\d+\.\d+$/,
  /^pin-op-vscode-\d+\.\d+\.\d+$/,
]);

export async function prepareArtifactDirectory(root = repositoryRoot) {
  const artifactDirectory = resolve(root, "artifacts");
  let stats;

  try {
    stats = await lstat(artifactDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(artifactDirectory);
    stats = await lstat(artifactDirectory);
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Artifact path must be a real directory: ${artifactDirectory}`,
    );
  }

  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(artifactDirectory, entry.name);

    if (entry.isFile() && isGeneratedReleaseArtifact(entry.name)) {
      await unlink(entryPath);
      continue;
    }

    // An unpacked build left from an earlier candidate is regenerated from its
    // archive, and `verify-artifacts.mjs` rejects every non-file entry, so a
    // stale one fails the next package run. A symbolic link reports neither
    // file nor directory here and is never followed or removed.
    if (entry.isDirectory() && isGeneratedUnpackedBuild(entry.name)) {
      await rm(entryPath, { recursive: true, force: true });
    }
  }

  return artifactDirectory;
}

export function isGeneratedReleaseArtifact(filename) {
  return generatedReleaseArtifactPatterns.some((pattern) =>
    pattern.test(filename),
  );
}

export function isGeneratedUnpackedBuild(name) {
  return generatedUnpackedBuildPatterns.some((pattern) => pattern.test(name));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await prepareArtifactDirectory();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
