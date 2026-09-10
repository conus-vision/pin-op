import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("release workflows and package scripts use canonical Pin-op names", async () => {
  const [ciSource, releaseSource, rootPackageSource] = await Promise.all([
    readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(root, "package.json"), "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageSource);
  const legacyArtifactPrefix = ["pin", "op", "-"].join("");

  assert.equal(
    rootPackage.scripts["smoke:chrome-package"],
    "node tools/smoke-packaged-chrome.mjs artifacts/pin-op-chrome-0.4.2.zip",
  );
  for (const source of [ciSource, releaseSource, rootPackageSource]) {
    assert.equal(source.toLowerCase().includes(legacyArtifactPrefix), false);
  }
  assert.match(ciSource, /--filter pin-op-chrome test/);
  assert.match(releaseSource, /--title "Pin-op \$RELEASE_TAG"/);
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
  // The job deliberately never checks out the repository, so gh cannot read
  // the remote from a working copy and fails unless it is told the repository.
  assert.ok(
    draftSteps.every((step) => step.uses !== "actions/checkout"),
    "create_draft must not check out repository code",
  );
  assert.equal(draftSteps[create].env?.GH_REPO, "${{ github.repository }}");
  assert.doesNotMatch(JSON.stringify(workflow.jobs.create_draft), /RELEASE_SETTINGS_TOKEN/);
  assertNoRepositoryCodeWithGhToken(draftSteps);
});

test("release guide documents protected tags, store submission, and recovery", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");

  assert.match(source, /git tag -a v0\.4\.2/);
  assert.doesNotMatch(source, /git tag -s|git verify-tag/);
  assert.match(source, /cryptographic tag\s+signing is not configured/i);
  assert.match(source, /branch ruleset|branch protection/i);
  assert.match(source, /Protect `v\*` tags/i);
  assert.match(source, /required reviewer/i);
  assert.match(source, /Prevent self-review/i);
  assert.match(source, /Enable release immutability/i);
  assert.match(source, /immutable-releases/);
  assert.match(source, /future releases/i);
  assert.match(source, /trusted writer/i);

  // Stores are the distribution; the release archives what they received.
  assert.match(source, /## Release An Update/);
  assert.match(source, /## Store Submissions/);
  assert.match(source, /does not free/i);
  assert.match(source, /its workflow from the tag's own commit/i);

  // The self-distribution path left with its workflow. It must not creep
  // back into the guide without the machinery that made it safe.
  for (const gone of [
    /amo-signing/i,
    /AMO_JWT/,
    /resume_run_id/,
    /sign_run_id/,
    /verified_xpi_sha256/,
    /signed-XPI/i,
  ]) {
    assert.doesNotMatch(source, gone);
  }
});

test("release guide searches every current release-owned document", async () => {
  const source = await readFile(resolve(root, "docs/release.md"), "utf8");
  const searchBlock = source.match(
    /\$releaseFiles = @\([\s\S]*?node tools\/verify-release-version\.mjs v0\.4\.2/,
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
