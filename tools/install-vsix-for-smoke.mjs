import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readArchive, validateVsixArchive } from "./verify-artifacts.mjs";

const EXTENSION_PREFIX = "extension/";

export async function installVerifiedVsix(artifactPath, extensionsDirectory) {
  const filename = basename(artifactPath);
  const archive = readArchive(artifactPath, filename);
  const manifest = validateVsixArchive(archive, filename);
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const extensionDirectory = join(
    extensionsDirectory,
    `${extensionId}-${manifest.version}`,
  );

  await mkdir(extensionDirectory);
  for (const [path, data] of archive.files) {
    if (!path.startsWith(EXTENSION_PREFIX)) continue;
    const relativePath = path.slice(EXTENSION_PREFIX.length);
    const output = join(extensionDirectory, ...relativePath.split("/"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, data, { flag: "wx" });
  }

  return {
    extensionDirectory,
    extensionId,
    version: manifest.version,
  };
}
