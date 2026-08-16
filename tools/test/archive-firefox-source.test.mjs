import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { archiveArguments } from "../archive-firefox-source.mjs";

test("source archive scopes Git safe.directory to the current repository", () => {
  const repositoryRoot = resolve("fixtures", "pin-op");
  const portableRepositoryRoot = repositoryRoot.replaceAll("\\", "/");

  assert.deepEqual(
    archiveArguments(repositoryRoot),
    [
      "-c",
      `safe.directory=${portableRepositoryRoot}`,
      "-c",
      "core.autocrlf=false",
      "archive",
      "--format=zip",
      "HEAD",
    ],
  );
});
