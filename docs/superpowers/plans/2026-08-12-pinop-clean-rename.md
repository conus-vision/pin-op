# PinOp Clean Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the unreleased Browser2IDE product and every active technical identity to PinOp, using `pinop.conus.vision` and `github.com/conus-vision/PinOp` as the canonical public locations.

**Architecture:** Treat this as one coordinated pre-release identity change across the pnpm workspace, protocol, IDE and browser adapters, release pipeline, and public documentation. Rename producers, consumers, tests, and artifacts together; do not add aliases, migration branches, deprecated exports, dual command registrations, legacy package names, or “formerly” copy. Historical records under `docs/superpowers/specs/` and `docs/superpowers/plans/` remain unchanged and are the only allowed repository locations for the old name.

**Tech Stack:** Node.js 22, pnpm 9.15, TypeScript, Vitest, `node:test`, VS Code extension manifests/VSCE, Chrome and Firefox Manifest V3, `web-ext`, GitHub Actions.

---

## Canonical identity matrix

| Surface | Target |
|---|---|
| Product display name | `PinOp` |
| Product descriptor | `Connect browser DevTools to your source code.` |
| Product site | `https://pinop.conus.vision` |
| Repository | `https://github.com/conus-vision/PinOp.git` |
| Root package | `@pinop/workspace` |
| Workspace scope | `@pinop/*` |
| VS Code package | `pinop` |
| VS Code publisher | `conus-vision` |
| VS Code extension ID | `conus-vision.pinop` |
| VS Code command/config/view/color prefix | `pinop.*` |
| Chrome workspace package | `pinop-chrome` |
| Firefox workspace package | `pinop-firefox` |
| Firefox add-on ID | `pinop@conus.vision` |
| Simulator binary | `pinop-simulator` |
| Release artifacts | `pinop-{vscode,chrome,firefox,firefox-source}-<version>.*` |

Keep product version `0.3.0` and protocol version `5`: neither has been publicly released, and every protocol-v5 producer and consumer is changed in the same commit series.

The private monorepo root uses `@pinop/workspace` so the VS Code extension can own the concise package name `pinop`; pnpm workspace package names must remain unique.

Before implementation, confirm that the project owns or can create the VS Marketplace publisher ID `conus-vision`. If it cannot, stop and get one exact replacement publisher ID before changing manifests; do not improvise a second identity.

## Explicit non-goals

- Do not publish compatibility packages under `@browser2ide/*`.
- Do not preserve old VS Code command, setting, view, color, or extension IDs.
- Do not accept old protocol discriminators, storage keys, DOM attributes, or browser message types.
- Do not generate artifacts with old prefixes or add a migration release.
- Do not add “formerly Browser2IDE” to README, manifests, marketplaces, or release notes.
- Do not rewrite historical specs or plans under `docs/superpowers/`.
- Do not rename the local checkout directory while an agent or editor is using it.

## Task 1: Record the package identity contract

**Files:**

- Create: `tools/test/package-identity.test.mjs`
- Modify: `package.json`
- Modify: `packages/protocol/package.json`
- Modify: `packages/bridge/package.json`
- Modify: `packages/browser-extension-core/package.json`
- Modify: `packages/plugin-api/package.json`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/chrome/package.json`
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/source-plugin-fixture/package.json`
- Modify: `tools/simulator/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: all tracked `.ts`, `.mjs`, and `package.json` files importing or filtering `@browser2ide/*`

- [ ] **Step 1: Add a failing metadata test**

Create `tools/test/package-identity.test.mjs` with a table-driven test that reads the manifests above and asserts:

```js
const expectedNames = new Map([
  ["package.json", "@pinop/workspace"],
  ["packages/protocol/package.json", "@pinop/protocol"],
  ["packages/bridge/package.json", "@pinop/bridge"],
  ["packages/browser-extension-core/package.json", "@pinop/browser-extension-core"],
  ["packages/plugin-api/package.json", "@pinop/plugin-api"],
  ["extensions/vscode/package.json", "pinop"],
  ["extensions/chrome/package.json", "pinop-chrome"],
  ["extensions/firefox/package.json", "pinop-firefox"],
  ["extensions/source-plugin-fixture/package.json", "pinop-source-plugin-fixture"],
  ["tools/simulator/package.json", "@pinop/simulator"],
]);
```

Also assert the root repository, bugs, and homepage URLs; VS Code `publisher === "conus-vision"`; fixture dependency `conus-vision.pinop`; and simulator binary `pinop-simulator`.

- [ ] **Step 2: Run the contract test and confirm RED**

Run: `node --test tools/test/package-identity.test.mjs`

Expected: FAIL on the current root package name and the remaining legacy package names.

- [ ] **Step 3: Rename package identities and dependency scope**

Apply these exact mappings throughout package manifests, workspace filters, imports, build scripts, test helpers, and esbuild entry points:

```text
@browser2ide/protocol             -> @pinop/protocol
@browser2ide/bridge               -> @pinop/bridge
@browser2ide/browser-extension-core -> @pinop/browser-extension-core
@browser2ide/plugin-api           -> @pinop/plugin-api
@browser2ide/simulator            -> @pinop/simulator
browser2ide-vscode                -> pinop
browser2ide-chrome                -> pinop-chrome
browser2ide-firefox               -> pinop-firefox
source-plugin-fixture             -> pinop-source-plugin-fixture
browser2ide-simulator             -> pinop-simulator
```

Set root metadata to:

```json
{
  "name": "@pinop/workspace",
  "description": "Connect browser DevTools to your source code.",
  "repository": {
    "type": "git",
    "url": "https://github.com/conus-vision/PinOp.git"
  },
  "bugs": "https://github.com/conus-vision/PinOp/issues",
  "homepage": "https://pinop.conus.vision"
}
```

Set the VS Code manifest name/publisher to `pinop`/`conus-vision`; change the fixture dependency to `conus-vision.pinop`. Do not change user-facing labels or runtime identifiers yet.

- [ ] **Step 4: Regenerate the lockfile**

Run: `corepack pnpm install --lockfile-only`

Expected: exit 0; workspace importer dependency keys use `@pinop/*` and no importer uses `@browser2ide/*`.

- [ ] **Step 5: Verify the package layer**

Run:

```bash
node --test tools/test/package-identity.test.mjs
corepack pnpm -r --workspace-concurrency=1 typecheck
git grep -n '@browser2ide/' -- ':!docs/superpowers/**'
```

Expected: tests and typecheck pass; `git grep` returns no matches.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages extensions tools
git commit -m "refactor(packages): move workspace to pinop"
```

## Task 2: Rename the protocol and runtime namespace

**Files:**

- Modify: `packages/protocol/src/**`
- Modify: `packages/protocol/test/**`
- Modify: `packages/bridge/src/**`
- Modify: `packages/bridge/test/**`
- Modify: `packages/browser-extension-core/src/**`
- Modify: `packages/browser-extension-core/test/**`
- Modify: `extensions/chrome/src/**`
- Modify: `extensions/chrome/test/adapter.test.ts`
- Modify: `extensions/firefox/src/**`
- Modify: `extensions/firefox/test/adapter.test.ts`
- Modify: `extensions/vscode/src/**`
- Modify: `extensions/vscode/test/**`
- Modify: `tools/simulator/src/sendInspect.ts`
- Modify: `tools/simulator/test/**`

- [ ] **Step 1: Change tests to the PinOp contract first**

Update relevant tests before production code so their expected literals use `pinop.*`, and their public type/API names use `PinOp`. Cover protocol schemas, bridge routing/authentication, browser messages/storage/DOM hooks, VS Code command/config IDs, and simulator fixtures.

- [ ] **Step 2: Run representative tests and confirm RED**

Run:

```bash
corepack pnpm --filter @pinop/protocol test
corepack pnpm --filter @pinop/bridge test
corepack pnpm --filter @pinop/browser-extension-core test
```

Expected: FAIL because implementations still emit or accept legacy discriminators and symbols.

- [ ] **Step 3: Rename the production namespace**

Within the active source and test trees listed above, apply the semantic mappings:

```text
Browser2IDE                       -> PinOp
browser2ide                       -> pinop
Browser2IDEApi                    -> PinOpApi
createBrowser2IDEApi              -> createPinOpApi
findBrowser2IDEServiceWorker      -> findPinOpServiceWorker
isBrowser2IDEManifest             -> isPinOpManifest
```

The general casing replacement also covers derived types, constants, symbols, log prefixes, WebSocket message discriminators, storage keys, DOM attributes, dataset properties, CSS hooks, fake URLs, and browser runtime message types. Preserve behavior and protocol version `5`; do not add fallback parsing for the old strings.

- [ ] **Step 4: Verify each dependency layer**

Run:

```bash
corepack pnpm --filter @pinop/protocol test
corepack pnpm --filter @pinop/bridge test
corepack pnpm --filter @pinop/browser-extension-core test
corepack pnpm --filter @pinop/simulator test
corepack pnpm --filter pinop-chrome test
corepack pnpm --filter pinop-firefox test
corepack pnpm --filter pinop test
corepack pnpm --filter pinop test:integration
```

Expected: every command exits 0 and no component needs a legacy branch.

- [ ] **Step 5: Commit**

```bash
git add packages extensions tools/simulator
git commit -m "refactor(runtime): rename namespace to pinop"
```

## Task 3: Rename extension manifests, UI, and assets

**Files:**

- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `extensions/chrome/manifest.json`
- Modify: `extensions/chrome/src/devtools.html`
- Modify: `extensions/chrome/test/manifest.test.ts`
- Modify: `extensions/firefox/manifest.json`
- Modify: `extensions/firefox/src/devtools.html`
- Modify: `extensions/firefox/test/manifest.test.ts`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/vscode/test/manifest.test.ts`
- Rename: `extensions/vscode/resources/browser2ide.svg` -> `extensions/vscode/resources/pinop.svg`
- Rename: `packages/browser-extension-core/assets/browser2ide.svg` -> `packages/browser-extension-core/assets/pinop.svg`
- Modify: `packages/browser-extension-core/assets/panel.html`
- Modify: `extensions/chrome/esbuild.mjs`
- Modify: `extensions/firefox/esbuild.mjs`

- [ ] **Step 1: Update manifest tests first**

Assert all three extension manifests display `PinOp`; VS Code contributes only `pinop.*` identifiers and references `resources/pinop.svg`; Firefox uses `pinop@conus.vision`; repository URLs target `conus-vision/PinOp`; the VS Code homepage is `https://pinop.conus.vision`.

- [ ] **Step 2: Run the manifest tests and confirm RED**

Run:

```bash
corepack pnpm --filter pinop test -- manifest.test.ts
corepack pnpm --filter pinop-chrome test -- manifest.test.ts
corepack pnpm --filter pinop-firefox test -- manifest.test.ts
```

Expected: FAIL on display names, contributed IDs, asset paths, and Firefox ID.

- [ ] **Step 3: Implement manifest and asset changes**

Use `git mv` for both SVGs. Update every manifest contribution and matching implementation reference:

```text
browser2ide.start                 -> pinop.start
browser2ide.stop                  -> pinop.stop
browser2ide.copyLinkCode          -> pinop.copyLinkCode
browser2ide.openDiagnostics       -> pinop.openDiagnostics
browser2ide.revealSourceMatch     -> pinop.revealSourceMatch
browser2ide.sessionId             -> pinop.sessionId
browser2ide.applicableRules       -> pinop.applicableRules
browser2ide.* color IDs           -> pinop.*
browser2ide@local                 -> pinop@conus.vision
```

Use the approved descriptor verbatim in marketplace/browser descriptions where a short description is appropriate. Do not claim editing, automation, or bidirectional control.

- [ ] **Step 4: Re-run extension tests and builds**

Run:

```bash
corepack pnpm --filter pinop test
corepack pnpm --filter pinop-chrome test
corepack pnpm --filter pinop-firefox test
corepack pnpm --filter pinop build
corepack pnpm --filter pinop-chrome build
corepack pnpm --filter pinop-firefox build
```

Expected: all commands exit 0; built bundles contain `pinop.svg` and no reference to the removed SVG filenames.

- [ ] **Step 5: Commit**

```bash
git add extensions packages/browser-extension-core/assets
git commit -m "feat(extensions): present product as PinOp"
```

## Task 4: Rename the source-plugin API and fixture

**Files:**

- Modify: `packages/plugin-api/src/index.ts`
- Modify: `packages/plugin-api/test/contracts.test.ts`
- Modify: `extensions/vscode/src/sourcePlugins/api.ts`
- Modify: `extensions/vscode/src/sourcePlugins/types.ts`
- Modify: `extensions/vscode/src/sourcePlugins/registry.ts`
- Modify: `extensions/vscode/test/integration/sourcePluginApi.test.ts`
- Modify: `extensions/vscode/test/sourcePluginRegistry.test.ts`
- Modify: `extensions/source-plugin-fixture/package.json`
- Modify: `extensions/source-plugin-fixture/src/extension.ts`
- Modify: `extensions/source-plugin-fixture/README.md`

- [ ] **Step 1: Change API tests before exports**

Update contracts to import and assert `PinOpApi`, `PinOpSourcePlugin`, and `createPinOpApi` names. Change the fixture language ID to `pinop-fixture` and its sample extension to `.pinop-fixture`; remove `.b2i` because no compatibility is required.

- [ ] **Step 2: Confirm RED**

Run:

```bash
corepack pnpm --filter @pinop/plugin-api test
corepack pnpm --filter pinop-source-plugin-fixture test
corepack pnpm --filter pinop test:integration
```

Expected: FAIL until public exports, registry usage, fixture manifest, and integration assertions match.

- [ ] **Step 3: Rename the API and fixture implementation**

Rename exported types/functions and all internal consumers without deprecated aliases. Update README examples to the new import scope, API names, extension dependency, language ID, and product name.

- [ ] **Step 4: Verify and commit**

Run:

```bash
corepack pnpm --filter @pinop/plugin-api test
corepack pnpm --filter pinop-source-plugin-fixture test
corepack pnpm --filter pinop test:integration
```

Expected: all pass.

```bash
git add packages/plugin-api extensions/vscode extensions/source-plugin-fixture
git commit -m "refactor(plugin-api): expose PinOp contracts"
```

## Task 5: Rename release artifacts and release automation

**Files:**

- Modify: `extensions/vscode/package-vsix.mjs`
- Modify: `extensions/vscode/smoke-installed-vsix.mjs`
- Modify: `extensions/vscode/verify-vsix.mjs`
- Modify: `extensions/chrome/package.json`
- Modify: `extensions/firefox/package.json`
- Modify: `tools/amo-signing-state.mjs`
- Modify: `tools/archive-firefox-source.mjs`
- Modify: `tools/browser-bundle-notices.mjs`
- Modify: `tools/prepare-artifacts.mjs`
- Modify: `tools/release-publishing.mjs`
- Modify: `tools/release-signing-provenance.mjs`
- Modify: `tools/smoke-packaged-chrome.mjs`
- Modify: `tools/verify-artifacts.mjs`
- Modify: every matching file under `tools/test/`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/firefox-sign.yml`
- Modify: `extensions/vscode/THIRD_PARTY_NOTICES`
- Modify: `extensions/chrome/THIRD_PARTY_NOTICES`
- Modify: `extensions/firefox/THIRD_PARTY_NOTICES`

- [ ] **Step 1: Update release tests before tools**

Change expected filenames and manifest identities to:

```text
pinop-vscode-0.3.0.vsix
pinop-chrome-0.3.0.zip
pinop-firefox-0.3.0.zip
pinop-firefox-0.3.0.xpi
pinop-firefox-source-0.3.0.zip
```

Update expected VSIX extension ID to `conus-vision.pinop`, Firefox ID to `pinop@conus.vision`, display name to `PinOp`, and embedded icon paths to `extension/resources/pinop.svg` and `dist/pinop.svg`.

- [ ] **Step 2: Run release-tool tests and confirm RED**

Run: `node --test tools/test/*.test.mjs`

Expected: FAIL because packagers, validators, workflows, and test fixtures still use legacy filenames or identities.

- [ ] **Step 3: Update packaging and verification tools**

Change all package outputs, validators, temp-directory prefixes, provenance filenames, release titles, action artifact names, and workflow file references to lowercase `pinop`. Update package filters to the names from Task 1. Change Firefox signing validation to `pinop@conus.vision`. Update notices so their project title and repository URL identify PinOp.

Do not weaken checksum, provenance, immutable-release, signing, or archive-security checks while renaming strings.

- [ ] **Step 4: Verify tools and workflow syntax**

Run:

```bash
node --test tools/test/*.test.mjs
corepack pnpm --filter pinop-chrome test -- manifest.test.ts adapter.test.ts
corepack pnpm exec prettier --check .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/firefox-sign.yml
```

Expected: tests pass; workflow YAML is syntactically accepted by the existing workflow tests. If Prettier is not configured in this repository, omit only the Prettier command and rely on `release-workflows.test.mjs` plus the YAML parser already used by the suite.

- [ ] **Step 5: Commit**

```bash
git add package.json extensions tools .github/workflows
git commit -m "build(release): emit PinOp artifacts"
```

## Task 6: Update public documentation and examples

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CONTRIBUTING.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `.github/pull_request_template.md`
- Modify: `.github/ISSUE_TEMPLATE/bug-report.yml`
- Modify: `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `.github/ISSUE_TEMPLATE/feature-request.yml`
- Modify: `docs/architecture.md`
- Modify: `docs/firefox-source-submission.md`
- Modify: `docs/installed-verification.md`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/protocol.md`
- Modify: `docs/release.md`
- Modify: `docs/security.md`
- Modify: `docs/source-plugin-authoring.md`
- Modify: `extensions/vscode/README.md`
- Modify: `extensions/source-plugin-fixture/README.md`
- Modify: `examples/basic-css/fallback.css`
- Modify: `examples/basic-css/index.html`
- Modify: `examples/basic-css/server.mjs`
- Modify: `tools/test/installed-verification-doc.test.mjs`

- [ ] **Step 1: Update documentation tests first**

Make the installed-verification test expect PinOp artifact names, commands, and display labels. Add assertions that README starts with `# PinOp`, includes the exact descriptor and canonical site, and links to `conus-vision/PinOp`.

- [ ] **Step 2: Confirm RED**

Run: `node --test tools/test/installed-verification-doc.test.mjs`

Expected: FAIL on existing product and artifact references.

- [ ] **Step 3: Rewrite active public copy**

Use `PinOp` for display text and `pinop` for technical identifiers. Update links, clone/install commands, package filters, screenshots/examples, security addresses, source-plugin samples, and release instructions. Lead README and extension descriptions with:

```text
PinOp
Connect browser DevTools to your source code.
```

Describe only the current read-only browser-to-source workflow. Do not add transition language. Keep historical documents under `docs/superpowers/` intact.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test tools/test/installed-verification-doc.test.mjs
git grep -n -e 'github.com/conus-vision/Browser2IDE' -e 'Browser2IDE' -e 'browser2ide' -- ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
```

Expected: test passes and grep returns no matches.

```bash
git add README.md CHANGELOG.md CONTRIBUTING.md PRIVACY.md SECURITY.md .github/ISSUE_TEMPLATE .github/pull_request_template.md docs extensions/vscode/README.md extensions/source-plugin-fixture/README.md examples tools/test/installed-verification-doc.test.mjs
git commit -m "docs: publish PinOp identity"
```

## Task 7: Add a permanent legacy-identity guard

**Files:**

- Create: `tools/brand-identity.mjs`
- Create: `tools/test/brand-identity.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add failing unit tests for the scanner**

Tests must construct legacy tokens from fragments so the test file does not itself contain a contiguous forbidden token:

```js
const legacyDisplay = ["Browser", "2", "IDE"].join("");
const legacyTechnical = ["browser", "2", "ide"].join("");
```

Test that the scanner reports each token in an active filename/content, ignores `docs/superpowers/specs/**` and `docs/superpowers/plans/**`, and reports no violations in the real tracked tree.

- [ ] **Step 2: Confirm RED**

Run: `node --test tools/test/brand-identity.test.mjs`

Expected: FAIL because `tools/brand-identity.mjs` does not exist yet.

- [ ] **Step 3: Implement the scanner**

`tools/brand-identity.mjs` must:

1. obtain tracked paths with `git ls-files -z`;
2. skip only the two historical `docs/superpowers/` prefixes;
3. detect the two fragment-constructed forbidden tokens in path names and UTF-8 text;
4. skip binary files containing a NUL byte;
5. print `path: token` violations and exit 1 when any exist;
6. export pure matching helpers for unit tests.

Add root script:

```json
"brand:check": "node tools/brand-identity.mjs"
```

Run it in the root `test` script and as an explicit CI step before packaging.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test tools/test/brand-identity.test.mjs
corepack pnpm brand:check
```

Expected: both pass with zero violations.

```bash
git add tools/brand-identity.mjs tools/test/brand-identity.test.mjs package.json .github/workflows/ci.yml
git commit -m "test(brand): prevent legacy identity regressions"
```

## Task 8: Build and inspect clean PinOp artifacts

**Files:**

- Generated: `artifacts/pinop-vscode-0.3.0.vsix`
- Generated: `artifacts/pinop-chrome-0.3.0.zip`
- Generated: `artifacts/pinop-firefox-0.3.0.zip`
- Generated: `artifacts/pinop-firefox-source-0.3.0.zip`
- Generated: `artifacts/SHA256SUMS`

- [ ] **Step 1: Inspect and remove only obsolete generated artifacts**

List exact files in `artifacts/` whose basename begins with the old product prefix. Confirm they are generated VSIX/ZIP/XPI/checksum outputs, then remove only those explicit files. Do not recurse, glob-delete, or touch source files.

- [ ] **Step 2: Run the complete local gate**

Run:

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm package
corepack pnpm smoke:chrome-package
corepack pnpm smoke:vscode-package
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect package contents**

Run the repository's artifact verifier and inspect the VSIX/browser manifests inside the archives. Confirm product display `PinOp`, VS Code ID `conus-vision.pinop`, Firefox ID `pinop@conus.vision`, `pinop.svg` asset paths, and exactly the four expected PinOp packages plus checksums.

- [ ] **Step 4: Re-run the identity guard against tracked files**

Run:

```bash
corepack pnpm brand:check
git status --short
git diff --check
```

Expected: no brand violations or whitespace errors; only intentional generated/ignored artifact changes remain.

- [ ] **Step 5: Commit any deterministic generated metadata**

If `pnpm-lock.yaml` or tracked notices changed during the clean build, review and commit only those files:

```bash
git add pnpm-lock.yaml extensions/*/THIRD_PARTY_NOTICES
git commit -m "chore(release): refresh PinOp metadata"
```

Skip this commit when there is no tracked diff.

## Task 9: Point the checkout and GitHub metadata at the renamed repository

**Files:**

- Modify outside worktree: local Git remote configuration
- External metadata: `conus-vision/PinOp` repository description/homepage

- [ ] **Step 1: Verify the renamed remote before changing local config**

Run:

```bash
git ls-remote https://github.com/conus-vision/PinOp.git HEAD refs/heads/master
```

Expected: both references resolve to the renamed repository.

- [ ] **Step 2: Update and verify `origin`**

Run:

```bash
git remote set-url origin https://github.com/conus-vision/PinOp.git
git remote -v
```

Expected: fetch and push URLs are both the canonical PinOp URL.

- [ ] **Step 3: Update GitHub repository metadata with explicit approval**

After receiving approval for the external write, set:

```text
Description: Connect browser DevTools to your source code.
Website: https://pinop.conus.vision
```

Do not create a second repository and do not recreate the old repository name.

- [ ] **Step 4: Review before push**

Run:

```bash
git status --short
git log --oneline --decorate -10
git diff HEAD~8..HEAD --check
```

Expected: a clean worktree apart from pre-existing unrelated untracked files; the rename commits are reviewable and contain no compatibility layer.

- [ ] **Step 5: Push only with explicit approval**

Push `master` to `origin`, then verify the GitHub Actions CI run. Do not publish Marketplace, Chrome Web Store, AMO, or GitHub Release artifacts as part of this rename unless separately requested.

## Final acceptance checklist

- [ ] Every active user-facing surface says `PinOp`.
- [ ] Every active technical namespace uses lowercase `pinop` or the approved `@pinop/*` scope.
- [ ] No active tracked file or path contains the old identity.
- [ ] Historical specs/plans are untouched.
- [ ] No compatibility alias, parser, storage migration, dual registration, or legacy artifact remains.
- [ ] All package, unit, integration, typecheck, lint, packaging, artifact-verification, and smoke gates pass.
- [ ] The local remote and all repository links target `github.com/conus-vision/PinOp`.
- [ ] Public metadata uses `pinop.conus.vision` and the approved descriptor.
- [ ] No marketplace publication or release occurred without separate authorization.
