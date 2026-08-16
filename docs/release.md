# PinOp Release Guide

This is the owner runbook for signed public releases. Version `0.3.0` is the
current release candidate. Its external signing and installed-product evidence is
pending. Do not create its release tag or publish a GitHub release until AMO
signing and installed-product verification are complete.

## One-Time Security Setup

Complete these controls in order. The release workflow intentionally cannot use
AMO credentials until this setup exists.

1. Protect `master` with a branch ruleset (or branch protection) that requires CI,
   blocks force-pushes and deletion, and limits bypasses. Protect `v*` tags from
   update or deletion and limit who can create them.
2. Enable GitHub release immutability before creating any PinOp release. On
   the repository page, open **Settings**, scroll to **Releases**, and select
   **Enable release immutability**. An owner can perform the same mandatory setup
   and verify it with GitHub CLI:

   ```bash
   gh api --method PUT repos/conus-vision/PinOp/immutable-releases
   gh api --method GET repos/conus-vision/PinOp/immutable-releases --jq '.enabled'
   ```

   The GET command must print `true`; both release workflows fail closed otherwise.
   This setting protects only future releases created after it is enabled. It does
   not retroactively protect an existing draft or published release, so enable it
   before the first release draft is created.
3. Create the GitHub Environment named `release-settings` under **Settings >
   Environments**. Restrict deployments to the protected `master` branch and
   protected `v*` tags. Add at least one required reviewer who is not the person
   dispatching the workflow or creating the tag, and enable **Prevent self-review**.
4. Create a fine-grained personal access token scoped only to
   `conus-vision/PinOp`, with **Administration: Read-only** and no additional
   repository permission beyond GitHub's required metadata access. Add it as the
   `RELEASE_SETTINGS_TOKEN` environment secret inside `release-settings` only after
   its deployment restrictions, required reviewer, and disabled self-review are
   active. Rotate it before its expiration.
5. Register the Firefox extension for unlisted distribution in Mozilla Add-ons.
   Its add-on ID must exactly match `browser_specific_settings.gecko.id` in
   `extensions/firefox/manifest.json`; the current ID is `info@conus.vision`.
6. Create the GitHub Environment named `amo-signing` under **Settings >
   Environments**.
7. Restrict `amo-signing` deployments to the protected `master` branch. Add at
   least one required reviewer who is not the person dispatching the workflow,
   and enable **Prevent self-review** so self-review is disabled. Do not allow
   unprotected branches or tags to deploy to this environment.
8. Only after those protections are active, create Mozilla JWT credentials and
   add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as environment secrets inside
   `amo-signing`. Do not create repository-level copies.

The standard workflow `GITHUB_TOKEN` does not expose the repository Administration
permission required by the immutable-release settings endpoint. Both workflows use
`RELEASE_SETTINGS_TOKEN` only in the protected preflight step that performs the GET;
no repository code or release mutation runs with that credential. The later
`contents: write` jobs cannot access it.

Complete each Environment's protected branch or tag restriction, required reviewer,
and disabled self-review controls before adding `RELEASE_SETTINGS_TOKEN`,
`AMO_JWT_ISSUER`, or `AMO_JWT_SECRET` to that Environment.

Every manual signing or publication run must be dispatched from `master`. The
workflow checks `refs/heads/master`, and every job with AMO secrets or
`contents: write` also requires the protected `amo-signing` environment. A branch
copy of the workflow therefore cannot reach credentials or mutate a release.

Release immutability locks a release only when that release is published. Its draft
remains mutable beforehand, so a trusted writer with `contents: write` is a residual
pre-publish trust boundary. Required environment review and the final same-step
numeric-ID validation narrow that boundary; they cannot make a malicious trusted
writer's concurrent draft mutation transactionally impossible. Limit trusted
writers and environment reviewers accordingly.

Never commit, print, paste into an issue, or store either credential as a workflow
variable. The signing job has `contents: read`; only its `web-ext sign` step receives
the two environment secrets. The separate attach and publish jobs have
`contents: write`, receive no AMO secrets, and do not check out repository code.
Revoke and replace both credentials if either value may have been disclosed.

All third-party Actions are pinned to reviewed immutable commits:

| Action | Version | Commit |
| --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | `v8.0.1` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| `pnpm/action-setup` | `v6.0.9` | `0ebf47130e4866e96fce0953f49152a61190b271` |

Review official release notes before changing a pin. Keep the full 40-character
commit and the human-readable version comment together.

## Prepare A Release

Update the version in all six product files:

- `package.json`;
- `extensions/vscode/package.json`;
- `extensions/firefox/package.json` and `manifest.json`;
- `extensions/chrome/package.json` and `manifest.json`.

Also update versioned artifact names and expectations in package scripts, smoke
scripts, release tools, tests, and documentation. Confirm that every current
release-owned reference agrees with the candidate version. This explicit list avoids
dependency versions and excludes historical material under `docs/superpowers/`:

```powershell
$releaseFiles = @(
  'package.json'
  'packages/browser-extension-core/package.json'
  'extensions/vscode/package.json'
  'extensions/vscode/package-vsix.mjs'
  'extensions/vscode/README.md'
  'extensions/vscode/test/manifest.test.ts'
  'extensions/chrome/package.json'
  'extensions/chrome/manifest.json'
  'extensions/chrome/test/manifest.test.ts'
  'extensions/firefox/package.json'
  'extensions/firefox/manifest.json'
  'tools/archive-firefox-source.mjs'
  'tools/prepare-artifacts.mjs'
  'tools/smoke-packaged-chrome.mjs'
  'tools/verify-artifacts.mjs'
  'tools/test'
  '.github/ISSUE_TEMPLATE/bug-report.yml'
  'README.md'
  'CHANGELOG.md'
  'PRIVACY.md'
  'SECURITY.md'
  'docs/architecture.md'
  'docs/firefox-source-submission.md'
  'docs/installed-verification.md'
  'docs/mvp-usage.md'
  'docs/mvp-verification.md'
  'docs/protocol.md'
  'docs/release.md'
  'docs/security.md'
)
rg -n -g '!docs/superpowers/**' -g '!**/node_modules/**' -g '!pnpm-lock.yaml' '(?:(?:"version":\s*"|pinop-(?:chrome|firefox(?:-source)?|vscode)-|(?:releaseVersion|VERSION)\s*=\s*"|manifest\?\.version\s*===\s*"|PinOp\b|Version\b|product (?:release )?semver\b|packaged\b|final\b|^##\s+\[?)[^"\r\n]*[0-9]+\.[0-9]+\.[0-9]+|[0-9]+\.[0-9]+\.[0-9]+[^"\r\n]*(?:release|product|candidate|artifact|XPI))' -- $releaseFiles
node tools/verify-release-version.mjs v0.3.0
```

Keep the changelog entry under `Unreleased` until the signed XPI passes installed
verification. From a clean checkout, run:

```powershell
corepack pnpm install --lockfile-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
corepack pnpm --filter pin-op-chrome test -- manifest.test.ts adapter.test.ts
corepack pnpm package
git diff --check
git diff --exit-code
```

Review `artifacts/SHA256SUMS`. On Linux or Git Bash, verify it with:

```bash
cd artifacts
sha256sum --check --strict SHA256SUMS
```

## Commit And Tag

Commit and push the prepared version, then wait for CI on `master` to pass. Confirm
that the protected `amo-signing` environment and its required reviewer are ready.

Create and inspect an annotated tag:

```powershell
git tag -a v0.3.0 -m "PinOp 0.3.0"
git cat-file -t refs/tags/v0.3.0
git push origin master
git push origin v0.3.0
```

`git cat-file` must print `tag`; a lightweight tag is rejected. Cryptographic tag
signing is not configured for the `0.3.0` release, and this runbook does not claim GPG
verification. Both release workflows require the annotated tag commit to be an
ancestor of `origin/master`, and all package and manifest versions must match the
`vX.Y.Z` tag.

## Create The Draft

Pushing the tag starts **Release draft**. Its read-only `package` job runs the full
gate and uploads an immutable short-lived workflow artifact. A separate minimal
`create_draft` job receives `contents: write`, downloads only that artifact, validates
the exact five-file set and checksums, and creates a GitHub draft containing:

```text
pinop-chrome-X.Y.Z.zip
pinop-firefox-X.Y.Z.zip
pinop-firefox-source-X.Y.Z.zip
pinop-vscode-X.Y.Z.vsix
SHA256SUMS
```

The Firefox ZIP is unsigned and is not suitable for normal Firefox Stable
installation. Leave the release in draft.

## Sign Firefox

Open **Actions > Sign Firefox and publish release > Run workflow**. Select branch
`master`, enter the exact tag, choose mode `sign`, and leave `resume_run_id`,
`sign_run_id`, and `verified_xpi_sha256` empty.

The read-only validation job rebuilds all unsigned artifacts and requires the remote
draft database ID, exact asset set, checksums, and bytes to match. The protected
`sign` job repeats that remote check immediately before AMO, then invokes the pinned
`web-ext` package with channel `unlisted`, config discovery disabled, and the verified
source ZIP attached for Mozilla review.

`web-ext` writes `.amo-upload-uuid` only after AMO validation succeeds. After every
attempt, the workflow preserves available sanitized UUID/channel/CRC state plus
repository, workflow, tag, commit, and run provenance for seven days. Stateful resume
is valid only for approval timeout or a later failure:

1. inspect the existing version in the AMO Developer Hub;
2. do not submit the same version again with an empty `resume_run_id`;
3. while the state artifact exists, dispatch mode `sign` from `master` with the same
   tag and the failed numeric run ID in `resume_run_id`;
4. if another resumed run times out, inspect AMO again and resume from that later run.

The restored run must be a completed failure or timeout from this repository,
`workflow_dispatch`, `master`, the same workflow, and the matching workflow commit.
A validation timeout can produce no state artifact. In that case, do not resubmit;
resolve the existing upload with Mozilla.

After AMO returns one XPI, the workflow checks its manifest version and Gecko ID,
requires unsigned runtime entries to remain byte-identical, and permits only expected
`META-INF` additions. This structural check does not cryptographically verify Mozilla
signature metadata. Firefox Stable installation is a separate required test.

The sign job then creates an immutable 90-day artifact containing only:

```text
pinop-firefox-X.Y.Z.xpi
signed-xpi-provenance.json
```

The provenance binds repository, workflow, tag, release commit, workflow commit,
release database ID, sign run ID, filename, and XPI SHA-256. The workflow summary
prints the sign run ID and digest. A separate protected `attach` job has no AMO
secrets; it rechecks the draft immediately before mutation, attaches that exact XPI,
regenerates `SHA256SUMS`, and redownloads the six-file draft for byte-for-byte
verification.

### Missing Signing State Or Provenance

A missing or expired state artifact does not authorize another AMO submission. Check
the AMO Developer Hub and resolve the existing version with Mozilla. Likewise, a
missing or expired signed-XPI provenance artifact blocks automated publication. Do not
reconstruct it by editing release assets or inventing a digest. Leave the release in
draft and use a separately reviewed recovery change or a new version after the AMO
status is understood.

This fail-closed rule intentionally replaces ad hoc manual release-asset recovery.
It preserves the binding between the AMO-returned bytes, the trusted workflow run,
the draft identity, and the later manual Firefox Stable test.

## Verify Installed Artifacts

Download all six draft assets and validate `SHA256SUMS`. Complete
`docs/installed-verification.md` without development launchers. In particular:

1. install `pinop-firefox-X.Y.Z.xpi` in Firefox Stable and restart Firefox;
2. install the VSIX and load the Chrome ZIP in current Chrome or Chromium;
3. open a project and confirm that the VS Code service starts without a terminal;
4. click the VS Code status item to copy the port and two-digit PIN, then paste it
   into PinOp DevTools in one browser window and confirm the same display code;
5. in the active document, which must be the intended CSS or SCSS file, verify the
   visual picker and box-model overlay, lazy DOM tree boundaries, and
   selected-element plus immediate-parent multi-range highlighting;
6. record the exact footer outcome, including `No active editor` and SCSS source-map
   failures, and confirm that **Disconnect** unlinks only that browser window;
7. complete the two VS Code window and two browser window isolation checks;
8. preserve the verification record with the sign run ID and exact XPI SHA-256.

Compute the digest from the exact XPI that passed Firefox Stable. PowerShell:

```powershell
(Get-FileHash .\pinop-firefox-0.3.0.xpi -Algorithm SHA256).Hash.ToLowerInvariant()
```

Linux or Git Bash:

```bash
sha256sum pinop-firefox-0.3.0.xpi
```

The value must exactly match the digest in the signing workflow summary and
`signed-xpi-provenance.json`. Do not continue if a checksum, restart, isolation, or
installed workflow check fails. Fix code in a new version rather than changing the
pushed tag.

## Publish

After installed verification passes, dispatch **Sign Firefox and publish release**
from branch `master` with:

- the same tag;
- mode `publish`;
- `sign_run_id` set to the completed successful signing workflow run;
- `verified_xpi_sha256` set to the exact lowercase digest copied after the Firefox
  Stable test;
- an empty `resume_run_id`.

Publication retrieves only the tag-and-run-specific immutable provenance artifact.
It verifies that the referenced run completed successfully on `master` in this
repository and workflow, recomputes the artifact XPI digest, and requires it to equal
both provenance and `verified_xpi_sha256`. Before any release mutation, it also
requires the same release database ID, exact six-file draft, valid checksums, rebuilt
unsigned bytes, and byte equality between the draft XPI and provenance artifact.

The final workflow step carries the exact numeric release database ID from signing
provenance. In that one step it fetches the draft by ID, verifies the tag, `master`
target, draft state, asset IDs and metadata, downloads every asset by numeric asset
ID, and repeats the checksum, unsigned-byte, XPI-byte, and manually verified digest
checks. It then publishes only by calling
`PATCH repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID` with `draft=false`; publication
by tag is prohibited. If the verified release was deleted and recreated under the
same tag, the old numeric ID is missing and publication fails.

The same step validates the PATCH response, refetches that numeric ID, requires the
same ID, tag, target, published state, and asset fingerprint, then redownloads and
compares the immutable public assets. It receives no AMO secret and does not sign
again. Confirm the public release contains only:

```text
pinop-chrome-X.Y.Z.zip
pinop-firefox-X.Y.Z.zip
pinop-firefox-X.Y.Z.xpi
pinop-firefox-source-X.Y.Z.zip
pinop-vscode-X.Y.Z.vsix
SHA256SUMS
```

Only after publication move the changelog entry from `Unreleased` to its release
date in the next normal commit. Unlisted AMO signing makes the XPI installable but
does not create a listed AMO store page.

## Failure Policy

If draft creation, signing, provenance validation, or installed verification fails,
leave the release in draft and identify the failing stage. Never delete, move, or
rewrite a pushed release tag. Do not remove history to hide a defective release.

For a code defect, document it and ship a new patch version and tag. For a credential
incident, revoke the AMO credentials immediately, rotate both environment secrets,
preserve release history for audit, and remove a hosted artifact only if the artifact
itself exposes sensitive material.
