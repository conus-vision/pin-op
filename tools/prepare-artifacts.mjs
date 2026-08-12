import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedReleaseArtifactPatterns = Object.freeze([
  /^pinop-chrome-\d+\.\d+\.\d+\.zip$/,
  /^pinop-firefox-\d+\.\d+\.\d+\.(?:xpi|zip)$/,
  /^pinop-firefox-source-\d+\.\d+\.\d+\.zip$/,
  /^pinop-vscode-\d+\.\d+\.\d+\.vsix$/,
  /^SHA256SUMS$/,
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
    if (!entry.isFile() || !isGeneratedReleaseArtifact(entry.name)) continue;
    await unlink(resolve(artifactDirectory, entry.name));
  }

  return artifactDirectory;
}

export function isGeneratedReleaseArtifact(filename) {
  return generatedReleaseArtifactPatterns.some((pattern) =>
    pattern.test(filename),
  );
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
