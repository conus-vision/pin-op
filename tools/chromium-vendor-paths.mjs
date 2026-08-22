import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

function normalizedPathForComparison(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(physicalRoot, candidatePath) {
  const relative = path.relative(physicalRoot, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function physicalConfinementError(repositoryRelativePath, reason, options) {
  return new Error(
    `Physical confinement rejected ${repositoryRelativePath}: ${reason}`,
    options,
  );
}

export async function resolvePhysicalRepositoryRoot(repositoryRoot) {
  const lexicalRoot = path.resolve(repositoryRoot);
  let metadata;
  try {
    metadata = await lstat(lexicalRoot);
  } catch (error) {
    throw physicalConfinementError(lexicalRoot, "repository root is unavailable", {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw physicalConfinementError(
      lexicalRoot,
      "repository root must be a physical directory",
    );
  }
  const physicalRoot = await realpath(lexicalRoot);
  const physicalMetadata = await lstat(physicalRoot);
  if (!physicalMetadata.isDirectory() || physicalMetadata.isSymbolicLink()) {
    throw physicalConfinementError(
      lexicalRoot,
      "resolved repository root must be a physical directory",
    );
  }
  return physicalRoot;
}

export async function assertConfinedPath(
  physicalRoot,
  repositoryRelativePath,
) {
  if (
    typeof repositoryRelativePath !== "string" ||
    repositoryRelativePath.length === 0 ||
    path.isAbsolute(repositoryRelativePath)
  ) {
    throw physicalConfinementError(
      String(repositoryRelativePath),
      "path must be repository-relative",
    );
  }

  const candidatePath = path.resolve(physicalRoot, repositoryRelativePath);
  if (!isWithinRoot(physicalRoot, candidatePath)) {
    throw physicalConfinementError(repositoryRelativePath, "path escapes repository root");
  }

  const relative = path.relative(physicalRoot, candidatePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let currentPath = physicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    let metadata;
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw physicalConfinementError(
        repositoryRelativePath,
        `symbolic-link or reparse-point ancestor ${currentPath}`,
      );
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw physicalConfinementError(
        repositoryRelativePath,
        `non-directory ancestor ${currentPath}`,
      );
    }

    const resolvedCurrentPath = await realpath(currentPath);
    if (!isWithinRoot(physicalRoot, resolvedCurrentPath)) {
      throw physicalConfinementError(
        repositoryRelativePath,
        `resolved path escapes repository root via ${currentPath}`,
      );
    }
    if (
      normalizedPathForComparison(resolvedCurrentPath) !==
      normalizedPathForComparison(currentPath)
    ) {
      throw physicalConfinementError(
        repositoryRelativePath,
        `reparse-point ancestor ${currentPath}`,
      );
    }
  }
  return candidatePath;
}

export async function readConfinedFile(
  physicalRoot,
  repositoryRelativePath,
  options,
) {
  const targetPath = await assertConfinedPath(
    physicalRoot,
    repositoryRelativePath,
  );
  const contents = await readFile(targetPath, options);
  await assertConfinedPath(physicalRoot, repositoryRelativePath);
  return contents;
}

export async function ensureConfinedDirectory(
  physicalRoot,
  repositoryRelativePath,
) {
  const directoryPath = await assertConfinedPath(
    physicalRoot,
    repositoryRelativePath,
  );
  const relativePath = path.relative(physicalRoot, directoryPath);
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    throw physicalConfinementError(
      repositoryRelativePath,
      "directory path must be repository-relative",
    );
  }

  let currentRelativePath = "";
  for (const segment of segments) {
    currentRelativePath = currentRelativePath
      ? path.join(currentRelativePath, segment)
      : segment;
    const currentPath = await assertConfinedPath(
      physicalRoot,
      currentRelativePath,
    );
    try {
      await mkdir(currentPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const metadata = await lstat(currentPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw physicalConfinementError(
        repositoryRelativePath,
        `directory ancestor ${currentRelativePath} is not a physical directory`,
      );
    }
    await assertConfinedPath(physicalRoot, currentRelativePath);
  }
  return directoryPath;
}

export async function writeConfinedFileAtomically(
  physicalRoot,
  repositoryRelativePath,
  contents,
) {
  const parentRelativePath = path.dirname(repositoryRelativePath);
  await ensureConfinedDirectory(physicalRoot, parentRelativePath);
  const targetPath = await assertConfinedPath(
    physicalRoot,
    repositoryRelativePath,
  );
  const temporaryRelativePath = `${repositoryRelativePath}.tmp-${process.pid}`;
  const temporaryPath = await assertConfinedPath(
    physicalRoot,
    temporaryRelativePath,
  );
  await writeFile(temporaryPath, contents, { flag: "wx" });
  try {
    await assertConfinedPath(physicalRoot, temporaryRelativePath);
    await assertConfinedPath(physicalRoot, repositoryRelativePath);
    await rename(temporaryPath, targetPath);
    await assertConfinedPath(physicalRoot, repositoryRelativePath);
  } catch (error) {
    try {
      const cleanupPath = await assertConfinedPath(
        physicalRoot,
        temporaryRelativePath,
      );
      await unlink(cleanupPath);
    } catch {
      // Leave an unsafe or already-removed temporary path untouched.
    }
    throw error;
  }
}

async function assertConfinedDirectoryTree(
  physicalRoot,
  rootRelativePath,
  relativePath = "",
) {
  const directoryRelativePath = path.join(rootRelativePath, relativePath);
  const directoryPath = await assertConfinedPath(
    physicalRoot,
    directoryRelativePath,
  );
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  for (const entry of entries) {
    const childRelativePath = relativePath
      ? path.join(relativePath, entry.name)
      : entry.name;
    const repositoryRelativeChild = path.join(rootRelativePath, childRelativePath);
    await assertConfinedPath(physicalRoot, repositoryRelativeChild);
    if (entry.isDirectory()) {
      await assertConfinedDirectoryTree(
        physicalRoot,
        rootRelativePath,
        childRelativePath,
      );
    } else if (!entry.isFile()) {
      throw physicalConfinementError(
        rootRelativePath,
        `directory tree contains a symbolic-link or reparse-point entry ${repositoryRelativeChild}`,
      );
    }
  }
  await assertConfinedPath(physicalRoot, directoryRelativePath);
  return true;
}

export async function removeConfinedDirectoryTree(
  physicalRoot,
  repositoryRelativePath,
) {
  if (!await assertConfinedDirectoryTree(physicalRoot, repositoryRelativePath)) {
    return;
  }
  const targetPath = await assertConfinedPath(
    physicalRoot,
    repositoryRelativePath,
  );
  await rm(targetPath, { recursive: true });
  await assertConfinedPath(physicalRoot, repositoryRelativePath);
}
