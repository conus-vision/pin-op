import {
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertConfinedPath,
  readConfinedFile,
  resolvePhysicalRepositoryRoot,
  writeConfinedFileAtomically,
} from "./chromium-vendor-paths.mjs";
import { sha256 } from "./vendor-chromium-elements.mjs";
import { validateManifestStructure } from "./verify-chromium-elements-vendor.mjs";

const VENDOR_RELATIVE_PATH = path.join("third_party", "chromium-devtools-frontend");
const MANIFEST_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "UPSTREAM.json");
const CHANGES_RELATIVE_PATH = path.join(VENDOR_RELATIVE_PATH, "PIN_OP_CHANGES.md");

async function readManifest(physicalRoot) {
  let contents;
  try {
    contents = await readConfinedFile(
      physicalRoot,
      MANIFEST_RELATIVE_PATH,
      "utf8",
    );
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

async function assertAnchorsExist(physicalRoot, manifest) {
  const changesText = await readConfinedFile(
    physicalRoot,
    CHANGES_RELATIVE_PATH,
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

async function digestOrPending(physicalRoot, repositoryRelativePath) {
  try {
    const targetPath = await assertConfinedPath(
      physicalRoot,
      repositoryRelativePath,
    );
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      throw new Error(
        `derived target is not a regular file: ${repositoryRelativePath}`,
      );
    }
    return sha256(await readConfinedFile(physicalRoot, repositoryRelativePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "pending";
    }
    throw error;
  }
}

export async function updateChromiumDerivations(
  repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const physicalRoot = await resolvePhysicalRepositoryRoot(repositoryRoot);
  const manifest = await readManifest(physicalRoot);
  await assertAnchorsExist(physicalRoot, manifest);

  for (const source of manifest.files) {
    for (const target of source.derivedTargets) {
      target.localSha256 = await digestOrPending(
        physicalRoot,
        target.path,
      );
    }
  }

  await writeConfinedFileAtomically(
    physicalRoot,
    MANIFEST_RELATIVE_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
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
