import {
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sha256 } from "./vendor-chromium-elements.mjs";
import { validateManifestStructure } from "./verify-chromium-elements-vendor.mjs";

const VENDOR_RELATIVE_PATH = path.join("third_party", "chromium-devtools-frontend");
const MANIFEST_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "UPSTREAM.json");
const CHANGES_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "PIN_OP_CHANGES.md");

async function readManifest(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, MANIFEST_RELATIVE_PATH);
  let contents;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("missing Chromium UPSTREAM.json manifest", { cause: error });
    }
    throw error;
  }
  try {
    return validateManifestStructure(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Chromium UPSTREAM.json is not valid JSON", { cause: error });
    }
    throw error;
  }
}

function anchorForChangeRecord(changeRecord) {
  return changeRecord.slice("PIN_OP_CHANGES.md#".length);
}

async function assertAnchorsExist(repositoryRoot, manifest) {
  const changesText = await readFile(
    path.join(repositoryRoot, CHANGES_RELATIVE_PATH),
    "utf8",
  );
  for (const source of manifest.files) {
    for (const target of source.derivedTargets) {
      const anchor = anchorForChangeRecord(target.changeRecord);
      if (
        !changesText.includes(`<a id="${anchor}"></a>`) &&
        !changesText.includes(`<a id='${anchor}'></a>`)
      ) {
        throw new Error(`missing change-record anchor ${anchor} in PIN_OP_CHANGES.md`);
      }
    }
  }
}

async function digestOrPending(targetPath) {
  try {
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      throw new Error(`derived target is not a regular file: ${targetPath}`);
    }
    return sha256(await readFile(targetPath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "pending";
    }
    throw error;
  }
}

async function writeManifestAtomically(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  try {
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function updateChromiumDerivations(
  repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const manifest = await readManifest(resolvedRepositoryRoot);
  await assertAnchorsExist(resolvedRepositoryRoot, manifest);

  for (const source of manifest.files) {
    for (const target of source.derivedTargets) {
      const targetPath = path.join(
        resolvedRepositoryRoot,
        ...target.path.split("/"),
      );
      target.localSha256 = await digestOrPending(targetPath);
    }
  }

  await writeManifestAtomically(
    path.join(resolvedRepositoryRoot, MANIFEST_RELATIVE_PATH),
    manifest,
  );
  return manifest;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Usage: node tools/update-chromium-derivations.mjs");
    }
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = await updateChromiumDerivations(repositoryRoot);
    const completeCount = manifest.files
      .flatMap(({ derivedTargets }) => derivedTargets)
      .filter(({ localSha256 }) => localSha256 !== "pending")
      .length;
    console.log(`Recorded ${completeCount} existing Chromium-derived target hashes.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
