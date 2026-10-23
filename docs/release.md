# Pin-op Release Guide

Pin-op reaches users through three store listings: the Visual Studio
Marketplace, the Chrome Web Store and Firefox Add-ons. A GitHub release is an
archive of the same packages and their checksums, not a distribution channel.
Version `0.4.2` is published on all three, and `0.5.0` is the release being
prepared.

## Release An Update

1. Raise the version everywhere **Prepare A Release** lists, and confirm it
   with `node tools/verify-release-version.mjs vX.Y.Z`.
2. Run the full gate from a clean checkout, ending in `corepack pnpm package`
   and `git diff --exit-code`.
3. Check `artifacts/SHA256SUMS` with `sha256sum --check --strict`.
4. Commit the prepared version, open a pull request, and merge it once CI
   passes. `master` requires the `verify` check, so a direct push is refused.
5. Tag the merged commit and push the tag. **Release draft** rebuilds the
   packages and creates a draft release.
6. Verify the draft's packages, then submit them to the three stores, as
   [store publishing](store-publishing.md) describes step by step. Store review
   is the long pole.
7. When Firefox Add-ons has signed the version, attach its Mozilla-signed
   `.xpi` to the draft, as **Attach The Firefox XPI** describes, and publish the
   release from the Releases page.

A store listing does not wait for a tag, and a tag does not wait for a store;
only the `.xpi` waits for Mozilla, because Mozilla alone can sign it.

## Store Submissions

| Store | File | Notes |
| --- | --- | --- |
| Visual Studio Marketplace | `pin-op-vscode-X.Y.Z.vsix` | Published immediately, no review |
| Chrome Web Store | `pin-op-chrome-X.Y.Z.zip` | Reviewed |
| Firefox Add-ons | `pin-op-firefox-X.Y.Z.zip` | Reviewed; attach `pin-op-firefox-source-X.Y.Z.zip` when asked for sources |

[Store publishing](store-publishing.md) walks through each store's upload,
review, and release controls.

Submit the Firefox package to the listed channel, the one whose submission
page says it is publicly listed on addons.mozilla.org. Mozilla does not free
a version number a submission has used, so a number spent on a withdrawn
submission is spent for good and the next attempt needs the next number.

`docs/firefox-source-submission.md` is the reviewer's build instruction and
travels inside the source archive.

## One-Time Security Setup

Complete these controls in order. The release workflow intentionally cannot use
AMO credentials until this setup exists.

1. Protect `master` with a branch ruleset (or branch protection) that requires CI,
   blocks force-pushes and deletion, and limits bypasses. Protect `v*` tags from
   update or deletion and limit who can create them.
2. Enable GitHub release immutability before creating any Pin-op release. On
   the repository page, open **Settings**, scroll to **Releases**, and select
   **Enable release immutability**. An owner can perform the same mandatory setup
   and verify it with GitHub CLI:

   ```bash
   gh api --method PUT repos/conus-vision/pin-op/immutable-releases
   gh api --method GET repos/conus-vision/pin-op/immutable-releases --jq '.enabled'
   ```

   The GET command must print `true`; both release workflows fail closed otherwise.
   This setting protects only future releases created after it is enabled. It does
   not retroactively protect an existing draft or published release, so enable it
   before the first release draft is created.
3. Create the GitHub Environment named `release-settings` under **Settings >
   Environments**. Restrict deployments to the protected `master` branch and
   protected `v*` tags. Add at least one required reviewer, and clear **Allow
   administrators to bypass configured protection rules** so a repository
   administrator cannot force a pending deployment through unapproved. Enable
   **Prevent self-review** as soon as a second trusted reviewer exists. A
   single-maintainer repository leaves that control off, because its only
   reviewer is the person who pushes the tag and could otherwise never approve
   the deployment the tag starts.
4. Create a fine-grained personal access token scoped only to
   `conus-vision/pin-op`, with **Administration: Read-only** and no additional
   repository permission beyond GitHub's required metadata access. Add it as the
   `RELEASE_SETTINGS_TOKEN` environment secret inside `release-settings` only after
   its deployment restrictions, required reviewer, and disabled administrator
   bypass are active. Rotate it before its expiration.

The standard workflow `GITHUB_TOKEN` does not expose the repository Administration
permission required by the immutable-release settings endpoint. The release workflow uses
`RELEASE_SETTINGS_TOKEN` only in the protected preflight step that performs the GET;
no repository code or release mutation runs with that credential. The later
`contents: write` job cannot access it.

Complete the Environment's protected branch and tag restriction, required reviewer,
and disabled administrator bypass before adding `RELEASE_SETTINGS_TOKEN` to it.

While a single maintainer runs releases and **Prevent self-review** is therefore
off, environment approval is an explicit confirmation and a dated audit record
by that maintainer, not a second-person control. It still stops an unattended
run from mutating a release, because administrator bypass is disabled and the
job is gated on the environment. Treat the second reviewer as the control this
configuration is missing, and enable **Prevent self-review** on the day one
exists.

Release immutability locks a release only when that release is published. Its draft
remains mutable beforehand, so a trusted writer with `contents: write` is a residual
pre-publish trust boundary. Required environment review and the final same-step
numeric-ID validation narrow that boundary; they cannot make a malicious trusted
writer's concurrent draft mutation transactionally impossible. Limit trusted
writers and environment reviewers accordingly.

Never commit, print, paste into an issue, or store the token as a workflow
variable. Revoke and replace it if its value may have been disclosed.

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
rg -n -g '!docs/superpowers/**' -g '!**/node_modules/**' -g '!pnpm-lock.yaml' '(?:(?:"version":\s*"|pin-op-(?:chrome|firefox(?:-source)?|vscode)-|(?:releaseVersion|VERSION)\s*=\s*"|manifest\?\.version\s*===\s*"|Pin-op\b|Version\b|product (?:release )?semver\b|packaged\b|final\b|^##\s+\[?)[^"\r\n]*[0-9]+\.[0-9]+\.[0-9]+|[0-9]+\.[0-9]+\.[0-9]+[^"\r\n]*(?:release|product|candidate|artifact|XPI))' -- $releaseFiles
node tools/verify-release-version.mjs v0.5.0
```

Keep the changelog entry under `Unreleased` until the version reaches users. A
store listing releases it as surely as a GitHub release does, so date the entry
on whichever happens first. From a clean checkout, run:

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

Merge the prepared version through a pull request and wait for CI on `master` to
pass. Confirm that the protected `release-settings` environment and its required
reviewer are ready, because the tag starts a deployment to it.

Create and inspect an annotated tag:

```powershell
git tag -a v0.5.0 -m "Pin-op 0.5.0"
git cat-file -t refs/tags/v0.5.0
git push origin master
git push origin v0.5.0
```

`git cat-file` must print `tag`; a lightweight tag is rejected. Cryptographic tag
signing is not configured for the `0.5.0` release, and this runbook does not claim GPG
verification. The release workflow requires the annotated tag commit to be an
ancestor of `origin/master`, and all package and manifest versions must match the
`vX.Y.Z` tag.

## Create The Draft

Pushing the tag starts **Release draft**. Its read-only `package` job runs the full
gate and uploads an immutable short-lived workflow artifact. A separate minimal
`create_draft` job receives `contents: write`, downloads only that artifact, validates
the exact five-file set and checksums, and creates a GitHub draft containing:

```text
pin-op-chrome-X.Y.Z.zip
pin-op-firefox-X.Y.Z.zip
pin-op-firefox-source-X.Y.Z.zip
pin-op-vscode-X.Y.Z.vsix
SHA256SUMS
```

The Firefox ZIP is unsigned and is not suitable for normal Firefox Stable
installation. Leave the release in draft.

## Verify The Inspector

From the final committed checkout, build both browser extensions:

```powershell
corepack pnpm --filter pin-op-chrome build
corepack pnpm --filter pin-op-firefox build
```

These ordinary builds register the shared Chromium-derived read-only Inspector
and its Rules UI by default. Load `extensions/chrome` through Chrome's **Load
unpacked** flow. Load `extensions/firefox/manifest.json` as a Firefox Temporary
Add-on or use the documented `web-ext` development flow. Run the complete
matrix in `docs/installed-verification.md`, including pseudo preview, Rules
origins, cleanup, parity, accessibility, and recovery. Automated, static, and
package checks are supplementary: every unperformed native browser cell remains
`PARTIAL/HARNESS_BLOCKED`, not `PASS`, and is not store-release or native
installed-product evidence.

## Verify Installed Artifacts

Download all five draft assets and validate `SHA256SUMS`. Complete
`docs/installed-verification.md` without development launchers. In particular:

1. install the Firefox add-on from its Firefox Add-ons listing and restart
   Firefox. The `.zip` in the draft is unsigned build and review input, and
   Firefox Stable will not keep it;
2. install the VSIX and load the Chrome ZIP in current Chrome or Chromium;
3. open a project and confirm that the VS Code service starts without a terminal;
4. click the VS Code status item to copy the port and two-digit PIN, then paste it
   into Pin-op DevTools in one browser window and confirm the same display code;
5. confirm the final ordinary/store artifacts use the shared Chromium-derived
   Inspector, with DOM Tree, read-only Rules, and the Source tab;
6. in the active document, verify the visual picker and box-model overlay, lazy
   DOM tree boundaries, selected-element plus immediate-parent multi-range
   highlighting, and an explicit Rules origin click for exact verified CSS and
   source-mapped SCSS;
7. verify the author-style `:hover`/`:focus` preview is labelled as a preview,
   exposes partial coverage honestly, performs no user-authored CSS/DOM editing,
   and dispatches no input or focus events;
8. record the exact footer outcome, including `No active editor` and SCSS source-map
   failures, and confirm that **Disconnect** unlinks only that browser window;
9. complete the two VS Code window and two browser window isolation checks;
10. preserve the verification record with the tag, the release commit, and the
    `SHA256SUMS` the draft carried.

The packaged Chrome smoke opens only an ordinary fixture page and validates
page/package markers. Task 6 VS Code integration and Task 7 browser UI tests do
not replace the native cross-product click. `PARTIAL/HARNESS_BLOCKED` is not a
release pass. Do not claim public-release evidence until the installed Stable
checks above actually complete.

## Attach The Firefox XPI

Firefox Stable installs only what Mozilla has signed, and Mozilla signs a
version number once: the listed submission to Firefox Add-ons is the only
signature `X.Y.Z` will ever get. So the release does not sign anything itself.
It carries the file Mozilla signed for the listing, checked against the
release's own Firefox package before it is attached.

1. When the version shows as approved in the Firefox Add-ons Developer Hub,
   open **Manage Status & Versions**, select `X.Y.Z`, and download its file.
2. Rename it `pin-op-firefox-X.Y.Z.xpi`, download `pin-op-firefox-X.Y.Z.zip`
   from the draft, and run:

   ```bash
   corepack pnpm release:verify-xpi pin-op-firefox-X.Y.Z.xpi pin-op-firefox-X.Y.Z.zip X.Y.Z
   ```

   The check requires every file of the release ZIP in the `.xpi` byte for
   byte, only Mozilla's `META-INF` signature files in addition, a signed JAR
   manifest whose SHA-256 digests match every file, the release version, and a
   signing certificate issued to `info@conus.vision`. It writes
   `pin-op-firefox-X.Y.Z.xpi.sha256`. Firefox verifies Mozilla's signature
   itself when it installs the file.
3. Attach both files to the draft before publishing; a published release is
   immutable:

   ```bash
   gh release upload vX.Y.Z pin-op-firefox-X.Y.Z.xpi pin-op-firefox-X.Y.Z.xpi.sha256
   ```

A release published before Mozilla approves the version stays without an
`.xpi`; Firefox users then install from Firefox Add-ons.

## Publish

The draft holds the same four packages the stores received, plus their
checksums and, once Mozilla has signed the version, the Firefox `.xpi`.
Publishing it is a button on the release page, and immutability locks the
assets at that moment.

Publish only after installed verification passes. Confirm the release contains
exactly:

```text
pin-op-chrome-X.Y.Z.zip
pin-op-firefox-X.Y.Z.zip
pin-op-firefox-X.Y.Z.xpi
pin-op-firefox-X.Y.Z.xpi.sha256
pin-op-firefox-source-X.Y.Z.zip
pin-op-vscode-X.Y.Z.vsix
SHA256SUMS
```

Move the changelog entry from `Unreleased` to its release date in the next
normal commit, unless a store listing already dated it.

## Failure Policy

If draft creation or installed verification fails, leave the release in draft and
identify the failing stage. Never delete, move, or rewrite a pushed release tag,
and never remove history to hide a defective release. A tag-triggered run reads
its workflow from the tag's own commit, so a workflow fix reaches the next
version, not the one already tagged.

For a code defect, document it and ship a new patch version and tag. The store
number is spent too, so the fix carries the next version there as well. For a
credential incident, revoke `RELEASE_SETTINGS_TOKEN` immediately, rotate it,
preserve release history for audit, and remove a hosted artifact only if the
artifact itself exposes sensitive material.
