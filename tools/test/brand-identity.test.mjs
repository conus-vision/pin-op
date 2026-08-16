import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

import {
  findLegacyIdentityViolations,
  scanTrackedBrandIdentity,
} from "../brand-identity.mjs";

const legacyDisplay = ["Browser", "2", "IDE"].join("");
const legacyTechnical = ["browser", "2", "ide"].join("");
const obsoleteSlug = ["pin", "op"].join("");
const obsoleteDisplay = ["Pin", "Op"].join("");
const obsoleteUpper = ["PIN", "OP"].join("");

test("brand guard finds legacy identity in paths and text", () => {
  const violations = findLegacyIdentityViolations([
    { path: `src/${legacyTechnical}.ts`, content: "export const value = 1;" },
    { path: "src/product.ts", content: `export const name = ${JSON.stringify(legacyDisplay)};` },
  ]);

  assert.deepEqual(violations, [
    { path: `src/${legacyTechnical}.ts`, location: "path" },
    { path: "src/product.ts", location: "content" },
  ]);
});

test("brand guard rejects each obsolete identity in filenames and content", () => {
  const violations = findLegacyIdentityViolations([
    {
      path: `fixtures/${obsoleteSlug}-session.json`,
      content: "fixture content",
    },
    {
      path: `fixtures/release-${obsoleteUpper}.zip`,
      content: "artifact content",
    },
    {
      path: `docs/${obsoleteDisplay}.md`,
      content: "documentation content",
    },
    {
      path: "fixtures/domain.txt",
      content: `https://${obsoleteSlug}.example.test`,
    },
    {
      path: "fixtures/archive.txt",
      content: `release-${obsoleteUpper}.zip`,
    },
    {
      path: "fixtures/context.txt",
      content: `Launch ${obsoleteDisplay} from the command palette.`,
    },
  ]);

  assert.deepEqual(violations, [
    { path: `fixtures/${obsoleteSlug}-session.json`, location: "path" },
    { path: `fixtures/release-${obsoleteUpper}.zip`, location: "path" },
    { path: `docs/${obsoleteDisplay}.md`, location: "path" },
    { path: "fixtures/domain.txt", location: "content" },
    { path: "fixtures/archive.txt", location: "content" },
    { path: "fixtures/context.txt", location: "content" },
  ]);
});

test("brand guard allows canonical branding and conventional identifiers", () => {
  const allowed = [
    "PinOpApi",
    "PinOpMessage",
    "PinOpClientFactory",
    "pinOpClient",
    "pinOpMessage",
    "PIN_OP_VERSION",
    "PIN_OP_CLIENT",
    "Pin-op",
    "pin-op",
  ];

  assert.deepEqual(
    findLegacyIdentityViolations(
      allowed.map((value) => ({
        path: `src/${value}.ts`,
        content: `export const value = ${JSON.stringify(value)};`,
      })),
    ),
    [],
  );
});

test("brand guard excludes the historical documentation tree", () => {
  const violations = findLegacyIdentityViolations([
    {
      path: `docs/superpowers/plans/2026-01-01-${legacyTechnical}.md`,
      content: legacyDisplay,
    },
    {
      path: `docs/superpowers/specs/2026-01-01-${legacyTechnical}.md`,
      content: legacyDisplay,
    },
    {
      path: `docs/superpowers/plans-archive/${legacyTechnical}.md`,
      content: legacyDisplay,
    },
  ]);

  assert.deepEqual(violations, []);
});

test("brand guard excludes protected and generated paths", () => {
  const protectedPaths = [
    `docs/superpowers/plans/2026-01-01-${obsoleteSlug}.md`,
    `docs/superpowers/specs/2026-01-01-${obsoleteUpper}.md`,
    `promotion/${obsoleteDisplay}.md`,
    `.superpowers/${obsoleteSlug}.json`,
    "debug.log",
    `artifacts/${obsoleteUpper}.zip`,
    `packages/core/dist/${obsoleteDisplay}.js`,
    `node_modules/example/${obsoleteSlug}.js`,
  ];

  assert.deepEqual(
    findLegacyIdentityViolations(
      protectedPaths.map((path) => ({ path, content: obsoleteDisplay })),
    ),
    [],
  );
});

test("tracked scan detects positive controls and skips ignored and binary files", (context) => {
  const repository = createTemporaryRepository(context);
  const trackedFilename = `src/${obsoleteSlug}-tracked.txt`;

  writeFileSync(join(repository, ".gitignore"), "debug.log\nartifacts/\n");
  writeRepositoryFile(repository, trackedFilename, "Pin-op fixture\n");
  writeRepositoryFile(
    repository,
    "src/tracked-content.txt",
    `fixture ${obsoleteUpper}\n`,
  );
  writeRepositoryFile(
    repository,
    "src/large.txt",
    `${"x".repeat(1_100_000)} ${obsoleteDisplay}\n`,
  );
  writeRepositoryFile(
    repository,
    "src/binary.dat",
    Buffer.from(`binary\0${obsoleteDisplay}`, "utf8"),
  );
  git(repository, "add", ".gitignore", "src");

  writeFileSync(join(repository, "debug.log"), legacyDisplay);
  writeFileSync(join(repository, "scratch.txt"), obsoleteDisplay);
  mkdirSync(join(repository, "artifacts"));
  writeFileSync(join(repository, "artifacts", "bundle.txt"), obsoleteUpper);

  assert.deepEqual(scanTrackedBrandIdentity(repository), [
    { path: "src/large.txt", location: "content" },
    { path: trackedFilename, location: "path" },
    { path: "src/tracked-content.txt", location: "content" },
  ]);
});

test("tracked scan resolves the repository root from a nested workspace", () => {
  const repository = resolve(process.cwd());
  const nestedWorkspace = join(repository, "packages", "browser-extension-core");
  const canonicalRepository = realpathSync.native(repository);
  const canonicalizedPaths = [];
  const readPaths = [];

  const violations = scanTrackedBrandIdentity(nestedWorkspace, {
    realpath(path) {
      canonicalizedPaths.push(resolve(path));
      return realpathSync.native(path);
    },
    readTrackedText(repositoryRoot, path) {
      assert.equal(repositoryRoot, canonicalRepository);
      readPaths.push(path);
      return path === "package.json" ? obsoleteDisplay : "Pin-op";
    },
  });

  assert.deepEqual(canonicalizedPaths, [
    resolve(nestedWorkspace),
    canonicalRepository,
    canonicalRepository,
  ]);
  assert.ok(readPaths.includes("package.json"));
  assert.deepEqual(violations, [
    { path: "package.json", location: "content" },
  ]);
});

test("tracked scan reads a symlink target string without following it", (context) => {
  const repository = createTemporaryRepository(context);
  const linkPath = "src/guide-link";
  writeRepositoryFile(repository, linkPath, "regular checkout placeholder\n");
  git(repository, "add", linkPath);

  const lstatPaths = [];
  const readlinkPaths = [];
  const readPaths = [];
  const violations = scanTrackedBrandIdentity(repository, {
    lstat(path) {
      lstatPaths.push(repositoryRelative(repository, path));
      return { isSymbolicLink: () => true };
    },
    readlink(path) {
      readlinkPaths.push(repositoryRelative(repository, path));
      return `../${obsoleteSlug}-guide.md`;
    },
    readFile(path) {
      readPaths.push(repositoryRelative(repository, path));
      throw new Error("tracked symlink was followed");
    },
  });

  assert.deepEqual(lstatPaths, [linkPath]);
  assert.deepEqual(readlinkPaths, [linkPath]);
  assert.deepEqual(readPaths, []);
  assert.deepEqual(violations, [{ path: linkPath, location: "content" }]);
});

test("tracked scan filters protected directories before reading active files", (context) => {
  const repository = createTemporaryRepository(context);
  const protectedPaths = [
    `docs/superpowers/plans/${obsoleteSlug}.md`,
    `promotion/${obsoleteUpper}.md`,
    `.superpowers/${obsoleteDisplay}.txt`,
    "debug.log",
    `artifacts/${obsoleteSlug}.zip`,
    `packages/core/dist/${obsoleteUpper}.js`,
    `vendor/node_modules/${obsoleteDisplay}.js`,
  ];

  writeRepositoryFile(repository, "dist", "active file\n");
  writeRepositoryFile(repository, "node_modules", "active file\n");
  writeRepositoryFile(repository, "src/index.ts", "export {};\n");
  for (const path of protectedPaths) {
    writeRepositoryFile(repository, path, obsoleteDisplay);
  }
  git(repository, "add", "dist", "node_modules", "src/index.ts");
  git(repository, "add", "--force", ...protectedPaths);

  const lstatPaths = [];
  const readPaths = [];
  const violations = scanTrackedBrandIdentity(repository, {
    lstat(path) {
      const trackedPath = repositoryRelative(repository, path);
      assert.equal(protectedPaths.includes(trackedPath), false, `${trackedPath} was statted`);
      lstatPaths.push(trackedPath);
      return { isSymbolicLink: () => false };
    },
    readlink(path) {
      assert.fail(`${repositoryRelative(repository, path)} was read as a link`);
    },
    readFile(path) {
      const trackedPath = repositoryRelative(repository, path);
      assert.equal(protectedPaths.includes(trackedPath), false, `${trackedPath} was read`);
      readPaths.push(trackedPath);
      if (trackedPath === "dist") return Buffer.from(obsoleteSlug);
      if (trackedPath === "node_modules") return Buffer.from(obsoleteUpper);
      return Buffer.from("Pin-op");
    },
  });

  assert.deepEqual(lstatPaths, ["dist", "node_modules", "src/index.ts"]);
  assert.deepEqual(readPaths, ["dist", "node_modules", "src/index.ts"]);
  assert.deepEqual(violations, [
    { path: "dist", location: "content" },
    { path: "node_modules", location: "content" },
  ]);
});

test("tracked scan fails clearly when an active tracked file is unreadable", (context) => {
  const repository = createTemporaryRepository(context);
  const missingPath = "src/missing.txt";
  writeRepositoryFile(repository, missingPath, "tracked fixture\n");
  git(repository, "add", missingPath);
  rmSync(join(repository, missingPath));

  assert.throws(
    () => scanTrackedBrandIdentity(repository),
    (error) => {
      assert.match(error.message, /Unable to read tracked file/);
      assert.equal(error.message.includes(missingPath), true);
      return true;
    },
  );
});

test("tracked tree contains no active legacy identity", () => {
  assert.deepEqual(scanTrackedBrandIdentity(process.cwd()), []);
});

function createTemporaryRepository(context) {
  const repository = mkdtempSync(join(tmpdir(), "pin-op-brand-"));
  context.after(() => rmSync(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  return repository;
}

function writeRepositoryFile(repository, path, content) {
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  writeFileSync(join(repository, path), content);
}

function repositoryRelative(repository, path) {
  return relative(repository, path).replaceAll("\\", "/");
}

function git(repository, ...args) {
  execFileSync(
    "git",
    [
      "-c",
      `core.excludesFile=${join(repository, ".git", "info", "exclude")}`,
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd: repository },
  );
}
