import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflows = ["ci.yml", "release.yml", "firefox-sign.yml"];
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
  for (const [filename, jobName] of [
    ["release.yml", "package"],
    ["firefox-sign.yml", "validate"],
  ]) {
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

test("Firefox signing isolates AMO secrets and protects every privileged job", async () => {
  const workflow = await readWorkflow("firefox-sign.yml");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.validate.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.deepEqual(workflow.jobs.sign.permissions, {
    actions: "read",
    contents: "read",
  });
  assert.deepEqual(workflow.jobs.attach.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.deepEqual(workflow.jobs.publish.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.equal(workflow.jobs.validate.environment, "release-settings");

  for (const name of ["sign", "attach", "publish"]) {
    assert.equal(workflow.jobs[name].environment, "amo-signing");
    assert.match(workflow.jobs[name].if, /github\.ref == 'refs\/heads\/master'/);
  }
  const trustedContextGate = workflow.jobs.validate.steps.find(
    (step) => step.name === "Require mode-specific trusted inputs",
  );
  assert.match(trustedContextGate.run, /GITHUB_EVENT_NAME.*workflow_dispatch/s);
  assert.match(trustedContextGate.run, /GITHUB_REF.*refs\/heads\/master/s);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.attach), /AMO_JWT_/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /AMO_JWT_/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.attach), /RELEASE_SETTINGS_TOKEN/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /RELEASE_SETTINGS_TOKEN/);
  assert.equal(workflow.jobs.sign.permissions.contents, "read");

  for (const name of ["attach", "publish"]) {
    const actionSteps = workflow.jobs[name].steps.filter((step) => step.uses);
    assert.ok(actionSteps.length > 0);
    assert.ok(
      actionSteps.every((step) => step.uses.startsWith("actions/download-artifact@")),
      `${name} may only retrieve pinned artifacts`,
    );
  }

  const secretSteps = workflow.jobs.sign.steps.filter((step) =>
    Object.values(step.env ?? {}).some((value) => String(value).includes("secrets.AMO_JWT_")),
  );
  assert.equal(secretSteps.length, 1);
  assert.match(secretSteps[0].run, /web-ext sign/);
  assertNoRepositoryCodeWithGhToken(workflow.jobs.attach.steps);
  assertNoRepositoryCodeWithGhToken(workflow.jobs.publish.steps);
});

test("Firefox publish requires exact sign-run provenance and manually verified XPI digest", async () => {
  const source = await readFile(resolve(root, ".github/workflows/firefox-sign.yml"), "utf8");
  const workflow = YAML.parse(source);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.sign_run_id.type, "string");
  assert.equal(inputs.verified_xpi_sha256.type, "string");
  assert.match(inputs.sign_run_id.description, /publish/i);
  assert.match(inputs.verified_xpi_sha256.description, /Firefox Stable/i);

  const gate = workflow.jobs.validate.steps.find(
    (step) => step.name === "Require mode-specific trusted inputs",
  );
  assert.match(gate.run, /MODE.*publish/s);
  assert.match(gate.run, /SIGN_RUN_ID/);
  assert.match(gate.run, /VERIFIED_XPI_SHA256/);
  assert.match(gate.run, /\^\[0-9a-f\]\{64\}\$/);

  const publishSteps = workflow.jobs.publish.steps;
  const artifactNames = stepIndex(publishSteps, "Define publication artifact handoffs");
  const fetchRun = stepIndex(publishSteps, "Fetch trusted signing run metadata");
  const restore = stepIndex(publishSteps, "Restore immutable signed XPI provenance");
  const validate = stepIndex(publishSteps, "Validate exact manually verified signed XPI");
  const firstRelease = stepIndex(publishSteps, "Download signed draft for publication");
  const publish = stepIndex(publishSteps, "Verify and publish immutable release by ID");
  assert.ok(artifactNames < fetchRun && fetchRun < restore);
  assert.ok(restore < validate && validate < firstRelease);
  assert.ok(firstRelease < publish);
  assert.equal(publish, publishSteps.length - 1);
  assert.equal(publishSteps[restore].with["run-id"], "${{ inputs.sign_run_id }}");
  assert.equal(
    publishSteps[restore].with.name,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  assert.equal(publishSteps[artifactNames].env.RELEASE_TAG, "${{ inputs.tag }}");
  assert.equal(publishSteps[artifactNames].env.SIGN_RUN_ID, "${{ inputs.sign_run_id }}");
  assert.match(publishSteps[artifactNames].run, /release-signing-provenance\.mjs artifact-name/);
  assert.match(publishSteps[validate].run, /release-signing-provenance\.mjs validate-publish/);
  assert.match(publishSteps[validate].run, /VERIFIED_XPI_SHA256/);
  assert.match(publishSteps[validate].run, /SIGN_RUN_ID/);
  const publishStep = publishSteps[publish];
  assert.equal(
    publishStep.env.EXPECTED_RELEASE_DATABASE_ID,
    "${{ steps.provenance.outputs.release_database_id }}",
  );
  assert.match(publishStep.run, /EXPECTED_RELEASE_DATABASE_ID.*\^\[1-9\]\[0-9\]\*\$/s);
  assert.match(publishStep.run, /env -u GH_TOKEN node .*verify-release-publication\.mjs draft/);
  assert.match(
    publishStep.run,
    /gh api --method PATCH "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{EXPECTED_RELEASE_DATABASE_ID\}"/,
  );
  assert.match(publishStep.run, /-F draft=false/);
  assert.match(publishStep.run, /env -u GH_TOKEN node .*verify-release-publication\.mjs published/);
  assert.equal(
    (publishStep.run.match(/verify-publication-checksums\.mjs/g) ?? []).length,
    2,
  );
  const preChecksum = publishStep.run.indexOf("verify-publication-checksums.mjs");
  const postChecksum = publishStep.run.lastIndexOf("verify-publication-checksums.mjs");
  const publicationPatch = publishStep.run.indexOf("--method PATCH");
  assert.ok(preChecksum < publicationPatch && publicationPatch < postChecksum);
  assert.match(
    publishStep.run,
    /cmp -- .*publication-before\.checksums.*publication-after\.checksums/s,
  );
  assert.match(publishStep.run, /cmp -- .*publication-before.*publication-after/s);
  assert.doesNotMatch(source, /gh release edit/);

  const getById =
    'gh api --method GET "repos/${GITHUB_REPOSITORY}/releases/${EXPECTED_RELEASE_DATABASE_ID}"';
  const preVerify = "verify-release-publication.mjs draft";
  const patchById =
    'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${EXPECTED_RELEASE_DATABASE_ID}"';
  const postVerify = "verify-release-publication.mjs published";
  assert.ok(publishStep.run.indexOf(getById) < publishStep.run.indexOf(preVerify));
  assert.ok(publishStep.run.indexOf(preVerify) < publishStep.run.indexOf(patchById));
  assert.ok(publishStep.run.indexOf(patchById) < publishStep.run.indexOf(postVerify));
  assert.ok(publishStep.run.lastIndexOf(getById) > publishStep.run.indexOf(patchById));

  const provenanceUpload = workflow.jobs.sign.steps.find(
    (step) => step.name === "Preserve immutable signed XPI provenance",
  );
  assert.ok(provenanceUpload.uses.startsWith("actions/upload-artifact@"));
  assert.equal(provenanceUpload.with.overwrite, undefined);
  assert.ok(provenanceUpload.with["retention-days"] >= 30);
  assert.equal(
    provenanceUpload.with.name,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  const signingArtifactNames = workflow.jobs.sign.steps.find(
    (step) => step.name === "Define signing artifact handoffs",
  );
  assert.match(signingArtifactNames.run, /release-signing-provenance\.mjs artifact-name/);
  assert.equal(
    workflow.jobs.sign.outputs.signed_artifact_name,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  const createProvenance = workflow.jobs.sign.steps.find(
    (step) => step.name === "Create immutable signed XPI provenance",
  );
  assert.equal(
    createProvenance.env.SIGNED_PROVENANCE_ARTIFACT_NAME,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  assert.match(createProvenance.env.CURRENT_RUN_ID, /github\.run_id/);
});

test("release guide makes the protected AMO environment and digest handoff mandatory", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const environment = source.slice(0, source.indexOf("## Prepare A Release"));
  assert.match(environment, /`amo-signing`/);
  assert.match(environment, /protected branch/i);
  assert.match(environment, /required reviewer/i);
  assert.match(environment, /disabled self-review|prevent self-review/i);
  assert.match(environment, /before[^.]+AMO_JWT_ISSUER/i);
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
  assert.match(source, /sign_run_id/);
  assert.match(source, /verified_xpi_sha256/);
  assert.match(source, /Firefox Stable/i);
  assert.match(source, /does not cryptographically verify Mozilla/i);
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
