import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const legacyIdentity = ["browser", "2", "ide"].join("");
const historicalPrefixes = [
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
];

export function findLegacyIdentityViolations(entries) {
  const violations = [];

  for (const entry of entries) {
    const normalizedPath = entry.path.replaceAll("\\", "/");
    if (isHistoricalPath(normalizedPath)) continue;

    if (normalizedPath.toLowerCase().includes(legacyIdentity)) {
      violations.push({ path: normalizedPath, location: "path" });
    }
    if (entry.content?.toLowerCase().includes(legacyIdentity)) {
      violations.push({ path: normalizedPath, location: "content" });
    }
  }

  return violations;
}

export function scanTrackedBrandIdentity(cwd) {
  const safeDirectory = resolve(cwd).replaceAll("\\", "/");
  const tracked = execFileSync(
    "git",
    ["-c", `safe.directory=${safeDirectory}`, "ls-files", "-z"],
    { cwd },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  return findLegacyIdentityViolations(
    tracked.map((path) => ({ path, content: readTrackedText(cwd, path) })),
  );
}

function isHistoricalPath(path) {
  return historicalPrefixes.some((prefix) => path.startsWith(prefix));
}

function readTrackedText(cwd, path) {
  try {
    const content = readFileSync(resolve(cwd, path));
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
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
