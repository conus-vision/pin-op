import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("prepackage removes only regular PinOp release outputs", async () => {
  const rootPackage = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    rootPackage.scripts.prepackage,
    "node tools/prepare-artifacts.mjs",
  );

  const root = await mkdtemp(resolve(tmpdir(), "pinop-prepare-"));
  const artifactDirectory = resolve(root, "artifacts");
  const lookalikeDirectory = "pinop-chrome-9.9.9.zip";
  const preservedFiles = ["pinop-chrome-latest.zip", "release-notes.txt"];
  const generatedFiles = [
    "SHA256SUMS",
    "pinop-chrome-0.2.0.zip",
    "pinop-firefox-0.2.0.xpi",
    "pinop-firefox-0.2.0.zip",
    "pinop-firefox-source-0.2.0.zip",
    "pinop-vscode-0.2.0.vsix",
  ];
  const outsideArtifactDirectory = resolve(
    root,
    "pinop-chrome-0.2.0.zip",
  );

  try {
    await mkdir(resolve(artifactDirectory, lookalikeDirectory), {
      recursive: true,
    });
    await writeFile(
      resolve(artifactDirectory, lookalikeDirectory, "keep.txt"),
      "directory contents\n",
    );
    for (const filename of [...generatedFiles, ...preservedFiles]) {
      await writeFile(resolve(artifactDirectory, filename), `${filename}\n`);
    }
    await writeFile(outsideArtifactDirectory, "outside artifacts\n");

    const { prepareArtifactDirectory } = await import(
      "../prepare-artifacts.mjs"
    );
    await prepareArtifactDirectory(root);

    assert.deepEqual(
      (await readdir(artifactDirectory)).sort(),
      [...preservedFiles, lookalikeDirectory].sort(),
    );
    assert.equal(
      await readFile(
        resolve(artifactDirectory, lookalikeDirectory, "keep.txt"),
        "utf8",
      ),
      "directory contents\n",
    );
    assert.equal(await readFile(outsideArtifactDirectory, "utf8"), "outside artifacts\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a directory missing required release artifacts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-verify-"));
  try {
    const result = runTool("verify-artifacts.mjs", directory);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Missing required release artifacts: .*pinop-vscode-0\.3\.0\.vsix/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checksum writer hashes sorted regular top-level artifact files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-checksums-"));
  try {
    await writeFile(resolve(directory, "z.zip"), "zipped\n");
    await writeFile(resolve(directory, "a.vsix"), "vsix\n");
    await writeFile(resolve(directory, "SHA256SUMS"), "stale\n");
    await mkdir(resolve(directory, "nested"));
    await writeFile(resolve(directory, "nested", "ignored.zip"), "ignored\n");

    const result = runTool("write-checksums.mjs", directory);

    assert.equal(result.status, 0, result.stderr);
    const actual = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
    const expected = [
      `${sha256("vsix\n")}  a.vsix`,
      `${sha256("zipped\n")}  z.zip`,
      "",
    ].join("\n");
    assert.equal(actual, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runTool(name, ...arguments_) {
  return spawnSync(process.execPath, [resolve(repositoryRoot, "tools", name), ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
