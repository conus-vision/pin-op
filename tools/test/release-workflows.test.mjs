import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("tag workflow verifies artifacts before a minimal job creates the draft", async () => {
  const source = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  const workflow = YAML.parse(source);

  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.match(source, /verify-release-version\.mjs/);
  assert.match(source, /git cat-file -t/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /refs\/remotes\/origin\/master/);
  assert.match(source, /corepack pnpm package/);
  assert.doesNotMatch(source, /AMO_JWT_(?:ISSUER|SECRET)/);
  assert.equal(workflow.jobs.package.environment, "release-settings");

  const packageSteps = workflow.jobs.package.steps;
  const immutable = stepIndex(packageSteps, "Require immutable repository releases");
  const preserve = stepIndex(packageSteps, "Preserve immutable draft assets");
  assert.ok(immutable < preserve);
  assert.match(packageSteps[immutable].run, /immutable-releases/);
  assert.match(packageSteps[immutable].run, /\.enabled == true/);
  assert.equal(
    packageSteps[immutable].env.GH_TOKEN,
    "${{ secrets.RELEASE_SETTINGS_TOKEN }}",
  );
  assert.ok(stepIndex(packageSteps, "Package unsigned artifacts") < preserve);
  assert.ok(stepIndex(packageSteps, "Check generated drift") < preserve);

  const draftSteps = workflow.jobs.create_draft.steps;
  const restore = stepIndex(draftSteps, "Restore verified draft assets");
  const exact = stepIndex(draftSteps, "Require the exact draft asset set");
  const create = stepIndex(draftSteps, "Create draft release");
  assert.ok(restore < exact && exact < create);
  assert.match(draftSteps[exact].run, /sha256sum --check --strict SHA256SUMS/);
  assert.match(draftSteps[create].run, /gh release create/);
  assert.match(draftSteps[create].run, /--draft/);
  assert.match(draftSteps[create].run, /--target master/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.create_draft), /RELEASE_SETTINGS_TOKEN/);
  assertNoRepositoryCodeWithGhToken(draftSteps);
});

test("Firefox signing preserves resume state and rechecks the draft before AMO", async () => {
  const source = await readFile(
    resolve(root, ".github/workflows/firefox-sign.yml"),
    "utf8",
  );
  const workflow = YAML.parse(source);
  const signSteps = workflow.jobs.sign.steps;

  assert.ok(workflow.on.workflow_dispatch);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ["sign", "publish"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.resume_run_id.required, false);
  assert.equal(workflow.on.pull_request, undefined);
  assert.match(source, /refs\/tags\/\$RELEASE_TAG/);
  assert.match(source, /git merge-base --is-ancestor/);

  const preAmoDownload = stepIndex(
    signSteps,
    "Redownload unsigned draft immediately before AMO",
  );
  const preAmoVerify = stepIndex(
    signSteps,
    "Revalidate unsigned draft immediately before AMO",
  );
  const sign = stepIndex(
    signSteps,
    "Check environment secrets and sign unlisted Firefox XPI",
  );
  assert.ok(preAmoDownload < preAmoVerify && preAmoVerify < sign);
  assert.match(signSteps[preAmoVerify].run, /--expected-database-id/);
  assert.match(signSteps[preAmoVerify].run, /--compare-all/);

  const signStep = signSteps[sign];
  assert.equal(signStep.env.WEB_EXT_API_KEY, "${{ secrets.AMO_JWT_ISSUER }}");
  assert.equal(signStep.env.WEB_EXT_API_SECRET, "${{ secrets.AMO_JWT_SECRET }}");
  assert.match(signStep.run, /--channel=unlisted/);
  assert.match(signStep.run, /--upload-source-code=/);
  assert.match(signStep.run, /--no-input/);
  assert.match(signStep.run, /--no-config-discovery/);
  assert.match(signStep.run, /--approval-timeout=900000/);
  assert.match(signStep.run, /--timeout=900000/);
  assert.doesNotMatch(signStep.run, /--api-key|--api-secret/);

  const restoreState = signSteps[stepIndex(signSteps, "Restore prior AMO upload state")];
  assert.equal(restoreState.with["run-id"], "${{ inputs.resume_run_id }}");
  assert.match(restoreState.with.name, /inputs\.resume_run_id/);
  const validateResume = signSteps[
    stepIndex(signSteps, "Validate restored AMO upload state and provenance")
  ];
  assert.match(validateResume.run, /validate-resume/);
  assert.match(validateResume.run, /workflow_dispatch/);
  assert.match(validateResume.run, /RELEASE_COMMIT/);

  const preserveState = stepIndex(
    signSteps,
    "Prepare available AMO upload state for preservation",
  );
  const uploadState = stepIndex(signSteps, "Preserve available AMO upload state");
  assert.ok(sign < preserveState && preserveState < uploadState);
  assert.match(signSteps[preserveState].if, /always\(\)/);
  assert.equal(signSteps[uploadState].with["if-no-files-found"], "warn");
  assert.equal(signSteps[uploadState].with["retention-days"], 7);
  assert.equal(signSteps[uploadState].with.overwrite, undefined);

  const normalize = stepIndex(signSteps, "Normalize and verify the single signed artifact");
  const createProvenance = stepIndex(
    signSteps,
    "Create immutable signed XPI provenance",
  );
  const uploadProvenance = stepIndex(
    signSteps,
    "Preserve immutable signed XPI provenance",
  );
  assert.ok(normalize < createProvenance && createProvenance < uploadProvenance);
  assert.match(signSteps[normalize].run, /verify-signed-firefox\.mjs/);
  assert.match(signSteps[createProvenance].run, /release-signing-provenance\.mjs create-bundle/);
  assert.equal(signSteps[uploadProvenance].with["retention-days"], 90);
  assertNoRepositoryCodeWithGhToken(signSteps);
});

test("write jobs preserve release identity and race checks without AMO secrets", async () => {
  const workflow = YAML.parse(
    await readFile(resolve(root, ".github/workflows/firefox-sign.yml"), "utf8"),
  );

  const attachSteps = workflow.jobs.attach.steps;
  const provenance = stepIndex(attachSteps, "Validate current signed XPI provenance");
  const downloadUnsigned = stepIndex(
    attachSteps,
    "Redownload unsigned draft immediately before upload",
  );
  const verifyUnsigned = stepIndex(
    attachSteps,
    "Revalidate unsigned draft immediately before upload",
  );
  const upload = stepIndex(attachSteps, "Upload signed XPI to draft");
  const verifySigned = stepIndex(attachSteps, "Verify exact signed draft after upload");
  assert.ok(provenance < downloadUnsigned);
  assert.ok(downloadUnsigned < verifyUnsigned && verifyUnsigned < upload);
  assert.ok(upload < verifySigned);
  assert.match(attachSteps[verifyUnsigned].run, /--expected-database-id/);
  assert.match(attachSteps[verifySigned].run, /verify-release-assets\.mjs signed/);
  assert.match(attachSteps[verifySigned].run, /cmp --/);

  const publishSteps = workflow.jobs.publish.steps;
  const validateXpi = stepIndex(
    publishSteps,
    "Validate exact manually verified signed XPI",
  );
  const initialDownload = stepIndex(publishSteps, "Download signed draft for publication");
  const initialVerify = stepIndex(
    publishSteps,
    "Verify signed draft identity for publication",
  );
  const publish = stepIndex(publishSteps, "Verify and publish immutable release by ID");
  assert.ok(validateXpi < initialDownload && initialDownload < initialVerify);
  assert.ok(initialVerify < publish);
  assert.equal(publish, publishSteps.length - 1);
  assert.match(publishSteps[initialVerify].run, /--expected-database-id/);
  assert.match(publishSteps[initialVerify].run, /cmp --/);
  const publishRun = publishSteps[publish].run;
  const prepareBundle = workflow.jobs.validate.steps.find(
    (step) => step.name === "Prepare immutable unsigned release bundle",
  );
  assert.match(prepareBundle.run, /tools\/verify-publication-checksums\.mjs/);
  assert.match(publishRun, /releases\/\$\{EXPECTED_RELEASE_DATABASE_ID\}/);
  assert.match(publishRun, /verify-release-publication\.mjs draft/);
  assert.match(publishRun, /--method PATCH/);
  assert.match(publishRun, /-F draft=false/);
  assert.match(publishRun, /verify-release-publication\.mjs published/);
  assert.match(publishRun, /sha256sum --check --strict SHA256SUMS/);
  const firstChecksumVerification = publishRun.indexOf("verify-publication-checksums.mjs");
  const patch = publishRun.indexOf("--method PATCH");
  const lastChecksumVerification = publishRun.lastIndexOf("verify-publication-checksums.mjs");
  assert.ok(firstChecksumVerification >= 0);
  assert.ok(firstChecksumVerification < patch);
  assert.ok(patch < lastChecksumVerification);
  assert.match(publishRun, /cmp -- .*publication-before\.checksums.*publication-after\.checksums/s);
  assert.match(publishRun, /VERIFIED_XPI_SHA256/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /gh release edit/);

  assert.doesNotMatch(JSON.stringify(workflow.jobs.attach), /AMO_JWT_/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.publish), /AMO_JWT_/);
  assertNoRepositoryCodeWithGhToken(attachSteps);
  assertNoRepositoryCodeWithGhToken(publishSteps);
});

test("release guide documents protected tags, stateful resume, and fail-closed recovery", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");

  assert.match(source, /git tag -a v0\.3\.0/);
  assert.doesNotMatch(source, /git tag -s|git verify-tag/);
  assert.match(source, /cryptographic tag\s+signing is not configured/i);
  assert.match(source, /branch ruleset|branch protection/i);
  assert.match(source, /Protect `v\*` tags/i);
  assert.match(source, /`amo-signing`/);
  assert.match(source, /required reviewer/i);
  assert.match(source, /Prevent self-review/i);
  assert.match(source, /Enable release immutability/i);
  assert.match(source, /immutable-releases/);
  assert.match(source, /future releases/i);
  assert.match(source, /trusted writer/i);

  assert.match(source, /resume_run_id/);
  assert.match(source, /AMO Developer Hub/);
  assert.match(source, /\.amo-upload-uuid/);
  assert.match(source, /only after AMO validation succeeds/i);
  assert.match(source, /approval timeout or a later failure/i);
  assert.match(source, /validation timeout can produce no state artifact/i);
  assert.doesNotMatch(source, /validation (?:or|and) approval timeout/i);

  assert.match(source, /missing or expired signed-XPI provenance artifact blocks/i);
  assert.match(source, /Do not\s+reconstruct it/i);
  assert.match(source, /fail-closed/i);
  assert.doesNotMatch(source, /Complete the installed verification with this XPI, then use mode `publish`/i);
});

test("release guide searches every current release-owned document", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const searchBlock = source.match(
    /\$releaseFiles = @\([\s\S]*?node tools\/verify-release-version\.mjs v0\.3\.0/,
  )?.[0];

  assert.ok(searchBlock, "release version-search block is missing");
  for (const path of [
    "README.md",
    "CHANGELOG.md",
    "PRIVACY.md",
    "SECURITY.md",
    "docs/architecture.md",
    "docs/firefox-source-submission.md",
    "docs/installed-verification.md",
    "docs/mvp-usage.md",
    "docs/mvp-verification.md",
    "docs/protocol.md",
    "docs/release.md",
    "docs/security.md",
    "extensions/vscode/README.md",
  ]) {
    assert.match(searchBlock, new RegExp(`'${path.replaceAll("/", "\\/")}'`));
  }
  assert.match(searchBlock, /-g '!docs\/superpowers\/\*\*'/);
  assert.match(searchBlock, /-g '!\*\*\/node_modules\/\*\*'/);
  assert.match(searchBlock, /-g '!pnpm-lock\.yaml'/);
});

function stepIndex(steps, name) {
  const index = steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `Missing workflow step: ${name}`);
  return index;
}

function assertNoRepositoryCodeWithGhToken(steps) {
  for (const step of steps) {
    if (!Object.hasOwn(step.env ?? {}, "GH_TOKEN")) continue;
    assert.match(step.run ?? "", /(?:^|\n)\s*gh\s/m, `${step.name} must invoke gh`);
    assert.doesNotMatch(step.run ?? "", /corepack\s+pnpm|\bgit\s/);
    for (const line of (step.run ?? "").split("\n")) {
      if (!/node\s+(?:tools\/|release-bundle\/)/.test(line)) continue;
      assert.match(
        line,
        /^\s*env -u GH_TOKEN node\s+/,
        `${step.name} must remove GH_TOKEN before running repository code`,
      );
    }
  }
}
