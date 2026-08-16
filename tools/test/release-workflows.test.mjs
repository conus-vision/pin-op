import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("release workflows and package scripts use canonical Pin-op names", async () => {
  const [ciSource, releaseSource, firefoxSource, rootPackageSource] = await Promise.all([
    readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(root, ".github/workflows/firefox-sign.yml"), "utf8"),
    readFile(resolve(root, "package.json"), "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageSource);
  const legacyArtifactPrefix = ["pin", "op", "-"].join("");

  assert.equal(
    rootPackage.scripts["smoke:chrome-package"],
    "node tools/smoke-packaged-chrome.mjs artifacts/pin-op-chrome-0.3.0.zip",
  );
  for (const source of [ciSource, releaseSource, firefoxSource, rootPackageSource]) {
    assert.equal(source.toLowerCase().includes(legacyArtifactPrefix), false);
  }
  assert.match(ciSource, /--filter pin-op-chrome test/);
  assert.match(releaseSource, /--title "Pin-op \$RELEASE_TAG"/);
});

test("Firefox artifact handoffs reject a signed-XPI attach mutation", async () => {
  const source = await readFile(resolve(root, ".github/workflows/firefox-sign.yml"), "utf8");
  assertFirefoxArtifactHandoffs(YAML.parse(source));

  const canonicalCopy =
    'cp -- "$SIGNED_XPI_PROVENANCE_DIRECTORY/$SIGNED_XPI_BASENAME" release-bundle/artifacts/';
  const mutatedCopy =
    'cp -- "$SIGNED_XPI_PROVENANCE_DIRECTORY/pin-op-firefox-${RELEASE_VERSION}.zip" release-bundle/artifacts/';
  const mutatedSource = source.replace(canonicalCopy, mutatedCopy);
  assert.notEqual(mutatedSource, source, "the signed-XPI attach mutation must apply");
  assert.throws(
    () => assertFirefoxArtifactHandoffs(YAML.parse(mutatedSource)),
    (error) => error?.code === "ERR_ASSERTION",
  );
});

test("release draft artifact handoffs reuse exact canonical outputs", async () => {
  const workflow = YAML.parse(
    await readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
  );
  const packageJob = workflow.jobs.package;
  const release = namedStep(packageJob.steps, "Verify annotated tag and product versions");
  const preserve = namedStep(packageJob.steps, "Preserve immutable draft assets");

  for (const [output, definition] of Object.entries(RELEASE_ARTIFACT_OUTPUTS)) {
    assert.equal(packageJob.outputs[output], `\${{ steps.release.outputs.${output} }}`);
    assert.match(release.run, new RegExp(escapeRegex(`printf '${output}=${definition}\\n'`)));
  }
  assert.deepEqual(preserve.with.path.trim().split("\n"), [
    "artifacts/${{ steps.release.outputs.vscode_basename }}",
    "artifacts/${{ steps.release.outputs.chrome_basename }}",
    "artifacts/${{ steps.release.outputs.firefox_zip_basename }}",
    "artifacts/${{ steps.release.outputs.firefox_source_basename }}",
    "artifacts/SHA256SUMS",
  ]);

  const draftJob = workflow.jobs.create_draft;
  assert.deepEqual(draftJob.env, {
    CHROME_BASENAME: "${{ needs.package.outputs.chrome_basename }}",
    FIREFOX_SOURCE_BASENAME: "${{ needs.package.outputs.firefox_source_basename }}",
    FIREFOX_ZIP_BASENAME: "${{ needs.package.outputs.firefox_zip_basename }}",
    VSCODE_BASENAME: "${{ needs.package.outputs.vscode_basename }}",
  });
  const exact = namedStep(draftJob.steps, "Require the exact draft asset set");
  const create = namedStep(draftJob.steps, "Create draft release");
  for (const variable of Object.keys(draftJob.env)) {
    assert.match(exact.run, new RegExp(escapeRegex(`release-assets/$${variable}`)));
    assert.match(create.run, new RegExp(escapeRegex(`release-assets/$${variable}`)));
  }
  assert.doesNotMatch(`${exact.run}\n${create.run}`, /pin-op-(?:vscode|chrome|firefox)/);
});

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
  assert.equal(
    restoreState.with.name,
    "${{ steps.artifact_names.outputs.resume_amo_state_artifact_name }}",
  );
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

const RELEASE_ARTIFACT_OUTPUTS = {
  vscode_basename: "pin-op-vscode-%s.vsix",
  chrome_basename: "pin-op-chrome-%s.zip",
  firefox_zip_basename: "pin-op-firefox-%s.zip",
  firefox_source_basename: "pin-op-firefox-source-%s.zip",
};

function namedStep(steps, name) {
  return steps[stepIndex(steps, name)];
}

function assertFirefoxArtifactHandoffs(workflow) {
  const attachJob = workflow.jobs.attach;
  assert.deepEqual(attachJob.env, {
    SIGNED_XPI_BASENAME: "${{ needs.validate.outputs.firefox_xpi_basename }}",
    SIGNED_XPI_PROVENANCE_DIRECTORY: "signed-xpi-provenance",
  });
  const attachRestore = namedStep(attachJob.steps, "Restore immutable signed XPI provenance");
  assert.equal(attachRestore.with.name, "${{ needs.sign.outputs.signed_artifact_name }}");
  assert.equal(attachRestore.with.path, "${{ env.SIGNED_XPI_PROVENANCE_DIRECTORY }}");
  const attachValidate = namedStep(attachJob.steps, "Validate current signed XPI provenance");
  assert.match(attachValidate.run, /validate-current \\\n\s+"\$SIGNED_XPI_PROVENANCE_DIRECTORY"/);
  const prepare = namedStep(attachJob.steps, "Prepare exact signed release assets");
  assert.match(
    prepare.run,
    /cp -- "\$SIGNED_XPI_PROVENANCE_DIRECTORY\/\$SIGNED_XPI_BASENAME" release-bundle\/artifacts\//,
  );
  assert.doesNotMatch(prepare.run, /pin-op-firefox|RELEASE_VERSION/);
  const upload = namedStep(attachJob.steps, "Upload signed XPI to draft");
  assert.match(upload.run, /release-bundle\/artifacts\/\$SIGNED_XPI_BASENAME/);
  assert.doesNotMatch(upload.run, /pin-op-firefox|RELEASE_VERSION/);
  const verify = namedStep(attachJob.steps, "Verify exact signed draft after upload");
  assert.match(verify.run, /"\$RELEASE_DIR\/\$SIGNED_XPI_BASENAME"/);
  assert.match(
    verify.run,
    /"\$SIGNED_XPI_PROVENANCE_DIRECTORY\/\$SIGNED_XPI_BASENAME"/,
  );

  const validateJob = workflow.jobs.validate;
  const release = namedStep(validateJob.steps, "Verify checkout is the requested annotated release tag");
  for (const [output, definition] of Object.entries({
    ...RELEASE_ARTIFACT_OUTPUTS,
    firefox_xpi_basename: "pin-op-firefox-%s.xpi",
  })) {
    assert.equal(validateJob.outputs[output], `\${{ steps.release.outputs.${output} }}`);
    assert.match(release.run, new RegExp(escapeRegex(`printf '${output}=${definition}\\n'`)));
  }
  const prepareBundle = namedStep(
    validateJob.steps,
    "Prepare immutable unsigned release bundle",
  );
  assert.deepEqual(prepareBundle.env, {
    CHROME_BASENAME: "${{ steps.release.outputs.chrome_basename }}",
    FIREFOX_SOURCE_BASENAME: "${{ steps.release.outputs.firefox_source_basename }}",
    FIREFOX_ZIP_BASENAME: "${{ steps.release.outputs.firefox_zip_basename }}",
    VSCODE_BASENAME: "${{ steps.release.outputs.vscode_basename }}",
  });
  for (const variable of Object.keys(prepareBundle.env)) {
    assert.match(prepareBundle.run, new RegExp(escapeRegex(`artifacts/$${variable}`)));
  }
  assert.doesNotMatch(prepareBundle.run, /pin-op-(?:vscode|chrome|firefox)/);

  const signJob = workflow.jobs.sign;
  const names = namedStep(signJob.steps, "Define signing artifact handoffs");
  assert.equal(names.id, "artifact_names");
  assert.match(names.run, /amo-signing-state\.mjs artifact-name/);
  assert.match(names.run, /release-signing-provenance\.mjs artifact-name/);
  assert.match(names.run, /amo_state_directory_name=pin-op-amo-state/);
  assert.match(names.run, /signed_provenance_directory_name=pin-op-signed-xpi-provenance/);
  const restoreState = namedStep(signJob.steps, "Restore prior AMO upload state");
  assert.equal(
    restoreState.with.name,
    "${{ steps.artifact_names.outputs.resume_amo_state_artifact_name }}",
  );
  const preserveState = namedStep(signJob.steps, "Prepare available AMO upload state for preservation");
  assert.equal(
    preserveState.env.AMO_STATE_DIRECTORY_NAME,
    "${{ steps.artifact_names.outputs.amo_state_directory_name }}",
  );
  assert.match(preserveState.run, /STATE_DIRECTORY="\$RUNNER_TEMP\/\$AMO_STATE_DIRECTORY_NAME"/);
  const uploadState = namedStep(signJob.steps, "Preserve available AMO upload state");
  assert.equal(
    uploadState.with.name,
    "${{ steps.artifact_names.outputs.amo_state_artifact_name }}",
  );
  assert.equal(
    uploadState.with.path,
    "${{ runner.temp }}/${{ steps.artifact_names.outputs.amo_state_directory_name }}/",
  );
  const createProvenance = namedStep(signJob.steps, "Create immutable signed XPI provenance");
  assert.equal(
    createProvenance.env.SIGNED_XPI_BASENAME,
    "${{ needs.validate.outputs.firefox_xpi_basename }}",
  );
  assert.equal(
    createProvenance.env.SIGNED_PROVENANCE_DIRECTORY_NAME,
    "${{ steps.artifact_names.outputs.signed_provenance_directory_name }}",
  );
  assert.match(createProvenance.run, /"artifacts\/\$SIGNED_XPI_BASENAME"/);
  assert.match(
    createProvenance.run,
    /PROVENANCE_DIR="\$RUNNER_TEMP\/\$SIGNED_PROVENANCE_DIRECTORY_NAME"/,
  );
  const uploadProvenance = namedStep(signJob.steps, "Preserve immutable signed XPI provenance");
  assert.equal(
    uploadProvenance.with.name,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  assert.equal(
    uploadProvenance.with.path,
    "${{ runner.temp }}/${{ steps.artifact_names.outputs.signed_provenance_directory_name }}/",
  );

  const publishJob = workflow.jobs.publish;
  assert.deepEqual(publishJob.env, {
    CHROME_BASENAME: "${{ needs.validate.outputs.chrome_basename }}",
    FIREFOX_SOURCE_BASENAME: "${{ needs.validate.outputs.firefox_source_basename }}",
    FIREFOX_XPI_BASENAME: "${{ needs.validate.outputs.firefox_xpi_basename }}",
    FIREFOX_ZIP_BASENAME: "${{ needs.validate.outputs.firefox_zip_basename }}",
    SIGNED_XPI_PROVENANCE_DIRECTORY: "signed-xpi-provenance",
    VSCODE_BASENAME: "${{ needs.validate.outputs.vscode_basename }}",
  });
  const publicationNames = namedStep(
    publishJob.steps,
    "Define publication artifact handoffs",
  );
  assert.equal(publicationNames.id, "artifact_names");
  assert.match(publicationNames.run, /release-signing-provenance\.mjs artifact-name/);
  const publishRestore = namedStep(publishJob.steps, "Restore immutable signed XPI provenance");
  assert.equal(
    publishRestore.with.name,
    "${{ steps.artifact_names.outputs.signed_provenance_artifact_name }}",
  );
  assert.equal(publishRestore.with.path, "${{ env.SIGNED_XPI_PROVENANCE_DIRECTORY }}");
  const publishValidate = namedStep(
    publishJob.steps,
    "Validate exact manually verified signed XPI",
  );
  assert.match(
    publishValidate.run,
    /validate-publish \\\n\s+"\$SIGNED_XPI_PROVENANCE_DIRECTORY"/,
  );
  const publishVerify = namedStep(
    publishJob.steps,
    "Verify signed draft identity for publication",
  );
  assert.match(publishVerify.run, /"\$RELEASE_DIR\/\$FIREFOX_XPI_BASENAME"/);
  assert.match(
    publishVerify.run,
    /"\$SIGNED_XPI_PROVENANCE_DIRECTORY\/\$FIREFOX_XPI_BASENAME"/,
  );
  const publish = namedStep(publishJob.steps, "Verify and publish immutable release by ID");
  for (const variable of [
    "CHROME_BASENAME",
    "FIREFOX_ZIP_BASENAME",
    "FIREFOX_XPI_BASENAME",
    "FIREFOX_SOURCE_BASENAME",
    "VSCODE_BASENAME",
  ]) {
    assert.match(publish.run, new RegExp(`\\$${variable}`));
  }
  assert.doesNotMatch(publish.run, /pin-op-(?:vscode|chrome|firefox)/);
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
