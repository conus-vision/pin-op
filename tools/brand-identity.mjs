import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const legacyIdentity = ["browser", "2", "ide"].join("");
const obsoleteSlug = ["pin", "op"].join("");
const obsoleteDisplay = ["Pin", "Op"].join("");
const obsoleteUpper = ["PIN", "OP"].join("");
const obsoleteDisplayPattern = new RegExp(`\\b${obsoleteDisplay}\\b`);
const protectedPrefixes = [
  "docs/superpowers/",
  "promotion/",
  ".superpowers/",
  "artifacts/",
];

export function findLegacyIdentityViolations(entries) {
  const violations = [];

  for (const entry of entries) {
    const normalizedPath = entry.path.replaceAll("\\", "/");
    if (isProtectedPath(normalizedPath)) continue;

    if (containsObsoleteIdentity(normalizedPath)) {
      violations.push({ path: normalizedPath, location: "path" });
    }
    if (entry.content && containsObsoleteIdentity(entry.content)) {
      violations.push({ path: normalizedPath, location: "content" });
    }
  }

  return violations;
}

export function scanTrackedBrandIdentity(
  cwd,
  {
    lstat = lstatSync,
    readFile = readFileSync,
    readlink = readlinkSync,
    readTrackedText: injectedReadText,
    realpath = realpathSync.native,
  } = {},
) {
  const repositoryRoot = resolveRepositoryTopLevel(cwd, realpath);
  const safeDirectory = repositoryRoot.replaceAll("\\", "/");
  const tracked = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${safeDirectory}`,
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !isProtectedPath(path));
  const readText =
    injectedReadText ??
    ((root, path) =>
      readTrackedText(root, path, { lstat, readFile, readlink }));

  return findLegacyIdentityViolations(
    tracked.map((path) => ({
      path,
      content: readText(repositoryRoot, path),
    })),
  );
}

function resolveRepositoryTopLevel(cwd, realpath) {
  const start = canonicalizeRepositoryPath(
    resolve(cwd),
    realpath,
    "brand scan path",
  );
  let current = start;

  try {
    if (!statSync(start).isDirectory()) {
      throw new Error(`Brand scan path is not a directory: ${start}`);
    }
  } catch (error) {
    if (error?.message?.startsWith("Brand scan path")) throw error;
    throw new Error(`Unable to inspect brand scan path ${start}: ${error.message}`, {
      cause: error,
    });
  }

  while (true) {
    const markerPath = resolve(current, ".git");
    try {
      const marker = statSync(markerPath);
      if (!marker.isDirectory() && !marker.isFile()) {
        throw new Error(`Unsupported Git marker at ${markerPath}`);
      }
      const candidate = canonicalizeRepositoryPath(
        current,
        realpath,
        "Git repository candidate",
      );
      return validateRepositoryTopLevel(candidate, realpath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No Git repository found from ${start}`);
    }
    current = parent;
  }
}

function validateRepositoryTopLevel(candidate, realpath) {
  const safeDirectory = candidate.replaceAll("\\", "/");
  const reported = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${safeDirectory}`,
      "-C",
      candidate,
      "rev-parse",
      "--show-toplevel",
    ],
    { encoding: "utf8" },
  ).trim();
  const repositoryRoot = canonicalizeRepositoryPath(
    reported,
    realpath,
    "reported Git top-level",
  );

  if (!samePath(repositoryRoot, candidate)) {
    throw new Error(
      `Git repository top-level mismatch: expected ${candidate}, received ${repositoryRoot}`,
    );
  }

  return repositoryRoot;
}

function canonicalizeRepositoryPath(path, realpath, description) {
  try {
    return resolve(realpath(resolve(path)));
  } catch (error) {
    throw new Error(`Unable to canonicalize ${description} ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

function samePath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function containsObsoleteIdentity(value) {
  return (
    value.toLowerCase().includes(legacyIdentity) ||
    value.includes(obsoleteSlug) ||
    value.includes(obsoleteUpper) ||
    obsoleteDisplayPattern.test(value)
  );
}

function isProtectedPath(path) {
  const segments = path.split("/");
  const directorySegments = segments.slice(0, -1);
  return (
    protectedPrefixes.some((prefix) => path.startsWith(prefix)) ||
    path === "debug.log" ||
    path.endsWith("/debug.log") ||
    directorySegments.includes("dist") ||
    directorySegments.includes("node_modules")
  );
}

function readTrackedText(
  repositoryRoot,
  path,
  { lstat, readFile, readlink },
) {
  const trackedPath = resolve(repositoryRoot, path);
  let metadata;
  try {
    metadata = lstat(trackedPath);
  } catch (error) {
    throw trackedReadError(path, error);
  }

  if (metadata.isSymbolicLink()) {
    try {
      return readlink(trackedPath, { encoding: "utf8" });
    } catch (error) {
      throw trackedReadError(path, error);
    }
  }

  let content;
  try {
    content = readFile(trackedPath);
  } catch (error) {
    throw trackedReadError(path, error);
  }

  // A NUL byte is Git's documented heuristic for classifying binary content.
  if (typeof content === "string") {
    return content.includes("\0") ? undefined : content;
  }
  return content.includes(0) ? undefined : content.toString("utf8");
}

function trackedReadError(path, error) {
  return new Error(`Unable to read tracked file ${path}: ${error.message}`, {
    cause: error,
  });
}

function main() {
  const violations = scanTrackedBrandIdentity(process.cwd());
  if (violations.length === 0) {
    console.log("Brand identity check passed.");
    return;
  }

  console.error("Legacy product identity found in active tracked files:");
  for (const violation of violations) {
    console.error(`- ${violation.path} (${violation.location})`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
