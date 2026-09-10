import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflows = ["ci.yml", "release.yml"];
const actionPins = new Map([
  ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
  ["actions/setup-node", ["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]],
  ["actions/upload-artifact", ["043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"]],
  ["actions/download-artifact", ["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"]],
  ["pnpm/action-setup", ["0ebf47130e4866e96fce0953f49152a61190b271", "v6.0.9"]],
]);

test("all third-party Actions are pinned to reviewed full commit SHAs", async () => {
  for (const filename of workflows) {
    const source = await readFile(resolve(root, ".github/workflows", filename), "utf8");
    for (const line of source.split("\n")) {
      const match = /^\s*uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/.exec(line);
      if (!match) continue;
      const expected = actionPins.get(match[1]);
      assert.ok(expected, `${filename} uses an unreviewed action: ${match[1]}`);
      assert.equal(match[2], expected[0], `${filename}: ${match[1]} must use the reviewed SHA`);
      assert.equal(match[3], expected[1], `${filename}: ${match[1]} must name the reviewed version`);
    }
    assert.doesNotMatch(source, /uses:\s*[^\s]+@(?![0-9a-f]{40}(?:\s|#|$))/);
  }
});

test("CI has read-only permissions and checkout never persists credentials", async () => {
  const workflow = await readWorkflow("ci.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.verify.permissions, undefined);
  assertPersistCredentialsDisabled(workflow.jobs.verify.steps);
});

test("draft release separates read-only packaging from minimal release mutation", async () => {
  const workflow = await readWorkflow("release.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.package.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.create_draft.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.equal(workflow.jobs.create_draft.needs, "package");
  assertPersistCredentialsDisabled(workflow.jobs.package.steps);
  assert.equal(
    workflow.jobs.create_draft.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    false,
  );
  assert.ok(
    workflow.jobs.package.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
  );
  assert.ok(
    workflow.jobs.create_draft.steps.some((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ),
  );
  assertNoRepositoryCodeWithGhToken(workflow.jobs.create_draft.steps);
});

test("release workflows require repository release immutability", async () => {
  for (const [filename, jobName] of [["release.yml", "package"]]) {
    const workflow = await readWorkflow(filename);
    const step = workflow.jobs[jobName].steps.find(
      (candidate) => candidate.name === "Require immutable repository releases",
    );
    assert.ok(step, `${filename} must preflight immutable releases`);
    assert.equal(workflow.jobs[jobName].environment, "release-settings");
    assert.equal(step.env.GH_TOKEN, "${{ secrets.RELEASE_SETTINGS_TOKEN }}");
    assert.equal(step.env.GITHUB_REPOSITORY, "${{ github.repository }}");
    assert.match(
      step.run,
      /gh api --method GET "repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases"/,
    );
    assert.match(step.run, /\.enabled == true/);
    const source = await readFile(resolve(root, ".github/workflows", filename), "utf8");
    assert.equal(
      (source.match(/repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases/g) ?? []).length,
      1,
      `${filename} must query release settings only in its protected preflight`,
    );
  }
});

test("release guide makes the protected release environment mandatory", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const environment = source.slice(0, source.indexOf("## Prepare A Release"));
  assert.match(environment, /protected branch/i);
  assert.match(environment, /required reviewer/i);
  assert.match(environment, /disabled self-review|prevent self-review/i);
  assert.match(environment, /before adding `RELEASE_SETTINGS_TOKEN`/i);
  assert.match(environment, /Settings[\s\S]+Releases[\s\S]+Enable release immutability/i);
  assert.match(
    environment,
    /gh api --method PUT repos\/conus-vision\/pin-op\/immutable-releases/,
  );
  assert.match(environment, /future releases/i);
  assert.match(environment, /`release-settings`/);
  assert.match(environment, /RELEASE_SETTINGS_TOKEN/);
  assert.match(environment, /Administration[^.]+read-only/i);
  assert.match(environment, /GITHUB_TOKEN[^.]+Administration/i);
  assert.match(source, /trusted writer/i);
  assert.match(source, /pre-publish|before publication/i);
  assert.doesNotMatch(environment, /optional|not required/i);
  assert.match(source, /Firefox Stable/i);
  assert.match(source, /active document/i);
  assert.doesNotMatch(source, /CSS\/SCSS source opening/i);
});

async function readWorkflow(filename) {
  return YAML.parse(
    await readFile(resolve(root, ".github/workflows", filename), "utf8"),
  );
}

function assertPersistCredentialsDisabled(steps) {
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.["persist-credentials"], false);
  }
}

function assertNoRepositoryCodeWithGhToken(steps) {
  for (const step of steps) {
    if (!Object.hasOwn(step.env ?? {}, "GH_TOKEN")) continue;
    assert.match(step.run ?? "", /(?:^|\n)\s*gh\s/m);
    assert.doesNotMatch(step.run ?? "", /corepack\s+pnpm|\bgit\s/);
    for (const line of (step.run ?? "").split("\n")) {
      if (!/node\s+(?:tools\/|release-bundle\/)/.test(line)) continue;
      assert.match(line, /^\s*env -u GH_TOKEN node\s+/);
    }
  }
}

function stepIndex(steps, name) {
  const index = steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `Missing workflow step: ${name}`);
  return index;
}
