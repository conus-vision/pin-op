# Chromium Inspector Shell And DOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor an auditable Chromium DevTools Elements subset, build a Pin-op-owned Inspector shell, and replace only the DOM-tree presentation while preserving the existing picker, overlay, link, refresh, IDE-highlight, correlation, and recovery behavior.

**Architecture:** Keep `DomTreeProvider`, `DomTreeController`, `PageInspectionSession`, and every browser/bridge lifecycle owner. A new `@pin-op/devtools-elements-ui` package contains Chromium-derived renderers behind neutral interfaces; `@pin-op/browser-extension-core` adapts its existing tree controller to those interfaces. The new panel is initially a separately selectable asset so the legacy panel remains a rollback path. No fake CDP, Chromium SDK model, DevTools host, or browser-specific frontend fork enters production.

**Tech Stack:** TypeScript, DOM APIs, pnpm workspaces, Vitest, esbuild, WebExtensions, Chromium DevTools frontend BSD-3-Clause sources pinned at `a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280`.

---

## Source Of Truth And Dependencies

Use `docs/superpowers/specs/2026-08-22-chromium-inspector-port-design.md`. This is checkpoint 1 of 4. It must land before:

1. `2026-08-22-read-only-rules.md`;
2. `2026-08-22-rules-scss-source-navigation.md`;
3. `2026-08-22-pseudo-state-rollout.md`.

This plan deliberately ships a Rules placeholder. It does not change public protocol v6, stylesheet collection, IDE source resolution, or pseudo-state behavior.

## Fixed Vendoring Boundary

Create `third_party/chromium-devtools-frontend/` and preserve these upstream files verbatim under `upstream/front_end/panels/elements/`:

- `ElementsTreeOutline.ts`
- `ElementsTreeElement.ts`
- `StylesSidebarPane.ts`
- `StylePropertiesSection.ts`
- `StylePropertyTreeElement.ts`
- `PropertyRenderer.ts`
- `StylePropertyUtils.ts`
- `elementsTreeOutline.css`
- `stylesSidebarPane.css`
- `stylePropertiesTreeOutline.css`

Also preserve upstream `LICENSE`. Do not vendor `ElementsPanel.ts`, `elements.ts`, `elements-meta.ts`, `InspectElementModeController.ts`, `ComputedStyleWidget.ts`, `MetricsSidebarPane.ts`, `LayoutPane.ts`, `SDK/*`, `core/host/*`, or `ui/legacy/*`.

Derived runtime targets live under `packages/devtools-elements-ui/src/chromium/` and retain the original copyright/license headers. The upstream snapshot is provenance/reference input, not compiled production code.

### Task 1: Pin, Import, And Verify The Chromium Subset

**Files:**
- Create: `third_party/chromium-devtools-frontend/LICENSE`
- Create: `third_party/chromium-devtools-frontend/UPSTREAM.json`
- Create: `third_party/chromium-devtools-frontend/README.pin-op.md`
- Create: `third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/ElementsTreeOutline.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/ElementsTreeElement.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/StylesSidebarPane.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/StylePropertiesSection.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/StylePropertyTreeElement.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/PropertyRenderer.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/StylePropertyUtils.ts`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/elementsTreeOutline.css`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/stylesSidebarPane.css`
- Create: `third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/stylePropertiesTreeOutline.css`
- Create: `tools/vendor-chromium-elements.mjs`
- Create: `tools/update-chromium-derivations.mjs`
- Create: `tools/verify-chromium-elements-vendor.mjs`
- Create: `tools/test/chromium-elements-vendor.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add a failing offline provenance test**

Test a temporary manifest and the checked-in manifest. Require the exact 40-character revision, the allowlisted paths, SHA-256 for every upstream file, an existing complete root BSD license, every distinct embedded copyright/license notice, and a structured derived-target entry for every imported source. Every derived entry records its repository-relative path, local SHA-256, and a stable `PIN_OP_CHANGES.md` anchor. The literal `"pending"` is valid only while that target does not exist; an existing target with `"pending"`, a missing target with a digest, a changed derived byte, a missing/unknown change-record anchor, or an unrecorded target fails. Also assert that `main`, a tag, an abbreviated/different SHA, an extra file such as `ElementsPanel.ts`, a changed upstream byte, or a missing root/embedded notice fails.

```js
assert.equal(manifest.revision,
  "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280");
assert.deepEqual(
  manifest.files.map(({ upstreamPath }) => upstreamPath).sort(),
  EXPECTED_UPSTREAM_PATHS,
);
await assert.rejects(() => verifyVendor(tamperedRoot), /SHA-256 mismatch/);
```

- [ ] **Step 2: Confirm the red state**

```powershell
corepack pnpm exec node --test tools/test/chromium-elements-vendor.test.mjs
```

Expected: FAIL because the verifier, manifest, license, and snapshot do not exist.

- [ ] **Step 3: Implement deterministic import and offline verification**

`tools/vendor-chromium-elements.mjs` accepts `--revision` only when its value equals `a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280`; every other value fails before network access. It interpolates that validated value into the raw GitHub URL, downloads only the fixed allowlist, refuses redirects outside that origin, writes no file until all downloads and hashes succeed, and records the import date plus derived targets in `UPSTREAM.json`. The verifier performs no network access.

Use this manifest shape:

```json
{
  "repository": "https://github.com/ChromeDevTools/devtools-frontend.git",
  "revision": "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280",
  "license": "LICENSE",
  "files": [
    {
      "upstreamPath": "front_end/panels/elements/ElementsTreeOutline.ts",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "derivedTargets": [
        {
          "path": "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts",
          "localSha256": "pending",
          "changeRecord": "PIN_OP_CHANGES.md#dom-tree"
        }
      ]
    }
  ]
}
```

The upstream digest above illustrates the required 64-hex shape only. The import command must replace it with the SHA-256 of the downloaded bytes before committing `UPSTREAM.json`, and the offline verifier must recompute it. `tools/update-chromium-derivations.mjs` deterministically replaces `"pending"` with the SHA-256 of each existing derived target, refreshes an existing derived digest after an intentional local patch, never invents paths or change-record anchors, and leaves `"pending"` only for an absent future target. The normal verifier accepts that staged absence during early checkpoints; its `--require-complete` release mode rejects every `"pending"`/missing target. The final release gate uses complete mode and requires every planned target to exist, contain a 64-hex matching digest, and reference an existing stable anchor. The three upstream CSS files may point to the same scoped local stylesheet, but each source-to-target/hash/change-record relation is explicit. For every source, record the normalized text and hash of each embedded notice block. The distinct Apple/Joseph Pecoraro BSD notice present in the selected Elements sources must be inventoried separately from the repository root license.

- [ ] **Step 4: Record the local patch policy**

`PIN_OP_CHANGES.md` must expose stable `#dom-tree`, `#rules`, and `#scoped-styles` anchors and explicitly list removal of editing, context menus, AI features, SDK/CDP objects, Linkifier, Metrics/Layout/Computed, DevTools Host, telemetry, and browser branding. `README.pin-op.md` must give the exact refresh, derived-hash recording, and offline verification commands.

- [ ] **Step 5: Wire root verification and run it**

Add:

```json
"vendor:chromium-elements": "node tools/vendor-chromium-elements.mjs --revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280",
"vendor:chromium-elements:record-derived": "node tools/update-chromium-derivations.mjs",
"vendor:chromium-elements:check": "node tools/verify-chromium-elements-vendor.mjs",
"vendor:chromium-elements:check-complete": "node tools/verify-chromium-elements-vendor.mjs --require-complete"
```

Run:

```powershell
corepack pnpm vendor:chromium-elements
corepack pnpm vendor:chromium-elements:check
corepack pnpm exec node --test tools/test/chromium-elements-vendor.test.mjs
```

Expected: the one pinned import succeeds; the following verifier and test PASS without network access.

- [ ] **Step 6: Commit the provenance slice**

```powershell
git add third_party/chromium-devtools-frontend tools/vendor-chromium-elements.mjs tools/update-chromium-derivations.mjs tools/verify-chromium-elements-vendor.mjs tools/test/chromium-elements-vendor.test.mjs package.json
git commit -m "build: pin chromium elements sources"
```

### Task 2: Create The Neutral Elements UI Package And Shell

**Files:**
- Create: `packages/devtools-elements-ui/package.json`
- Create: `packages/devtools-elements-ui/tsconfig.json`
- Create: `packages/devtools-elements-ui/src/contracts.ts`
- Create: `packages/devtools-elements-ui/src/elementsInspectorView.ts`
- Create: `packages/devtools-elements-ui/src/index.ts`
- Create: `packages/devtools-elements-ui/assets/devtools-elements.css`
- Create: `packages/devtools-elements-ui/test/support/fakeDocument.ts`
- Create: `packages/devtools-elements-ui/test/support/fakeElementsBackend.ts`
- Create: `packages/devtools-elements-ui/test/fixtures/elementsSession.ts`
- Create: `packages/devtools-elements-ui/test/elementsInspectorView.test.ts`
- Create: `packages/devtools-elements-ui/test/public-export.mjs`
- Modify: `third_party/chromium-devtools-frontend/UPSTREAM.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing contract and shell tests**

Define the only production boundary the derived UI may import:

```ts
export interface TreeRowSnapshot {
  readonly type: "node" | "load-more";
  readonly nodeRef: string;
  readonly parentRef?: string;
  readonly depth: number;
  readonly expanded: boolean;
  readonly expandable: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
  readonly node?: InspectorNodeSnapshot;
}

export interface TreeDataSource {
  snapshot(): TreePresentationSnapshot;
  subscribe(listener: () => void): () => void;
  expand(nodeRef: string): Promise<void>;
  collapse(nodeRef: string): void;
  loadMore(parentRef: string): Promise<void>;
  select(nodeRef: string): Promise<void>;
  hover(nodeRef?: string): void;
}

export interface SourceLinkDelegate {
  openRuleOrigin(ruleRef: string): void;
}
```

Add fixture tests proving the shell mounts `DOM` on the left and `Rules` on the right, retains a hidden sidebar-extension mount point for a future Source milestone, scopes every style below `.pin-op-elements-inspector`, renders page-controlled data with text nodes, and removes all listeners on dispose. Assert there is no visible Source tab, `contenteditable`, inline script/style, `innerHTML` assignment, or editable control.

- [ ] **Step 2: Run the package tests and confirm failure**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/elementsInspectorView.test.ts
```

Expected: FAIL because the package and public contracts do not exist.

- [ ] **Step 3: Implement the package skeleton and shell**

Use the existing package conventions: ESM, `dist/index.js`, declarations, `tsc`, Vitest, public-export check, and DOM libs. `ElementsInspectorView` owns only the Inspector workspace roots and tab semantics. It must not render Link/Disconnect, Auto Refresh, or IDE Highlight controls; those remain Pin-op shell responsibilities.

The static fixture must include doctype, elements, text/comment nodes, lazy children, open shadow root, inaccessible iframe, and an empty Rules placeholder so later plans extend the same fixture. Do not expose the future Source tab in this checkpoint.

- [ ] **Step 4: Prohibit Chromium SDK imports mechanically**

Add a package test that scans `src/chromium` and rejects imports containing `/sdk/`, `/host/`, `ui/legacy`, `ElementsPanel`, `CSSModel`, `DOMModel`, `OverlayModel`, `TargetManager`, or `Linkifier`.

- [ ] **Step 5: Verify package build and public API**

```powershell
corepack pnpm vendor:chromium-elements:record-derived
corepack pnpm vendor:chromium-elements:check
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/devtools-elements-ui typecheck
corepack pnpm --filter @pin-op/devtools-elements-ui lint
```

Expected: all checks pass and the public API exports only neutral snapshots, data-source interfaces, and `ElementsInspectorView`.

- [ ] **Step 6: Commit the neutral shell**

```powershell
git add packages/devtools-elements-ui third_party/chromium-devtools-frontend/UPSTREAM.json pnpm-lock.yaml
git commit -m "feat(inspector): add neutral elements shell"
```

### Task 3: Extend The Local DOM Snapshot Without Changing Its Authority

**Files:**
- Modify: `packages/browser-extension-core/src/domProtocol.ts`
- Modify: `packages/browser-extension-core/src/domTreeProvider.ts`
- Modify: `packages/browser-extension-core/src/domTreeController.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/test/domProtocol.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeProvider.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeController.test.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeRecoveryCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeView.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`
- Modify: `packages/browser-extension-core/test/public-export.mjs`

- [ ] **Step 1: Add failing structured-node tests**

Replace presentation-only labels as the UI authority with bounded structured fields while retaining `label` temporarily for the legacy renderer:

```ts
export interface InspectorAttribute {
  readonly name: string;
  readonly value: string;
}

export interface DomNodeView {
  readonly nodeRef: string;
  readonly kind:
    | "document-type"
    | "element"
    | "text"
    | "comment"
    | "shadow-root"
    | "frame-document";
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly attributes: readonly InspectorAttribute[];
  readonly childCount: number;
  readonly relationship: "dom" | "shadow-root" | "frame-document";
  readonly selectable: boolean;
  readonly expandable: boolean;
  readonly inaccessible?: boolean;
  readonly branchRevision: number;
  readonly locator?: DomStableLocator;
  readonly label: string;
}
```

Add `DOM_PROTOCOL_MAX_ATTRIBUTES = 64`, `DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH = 256`, `DOM_PROTOCOL_MAX_ATTRIBUTE_VALUE_LENGTH = 16_384`, `DOM_PROTOCOL_MAX_NODE_VALUE_LENGTH = 16_384`, `DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH = 4_096`, `DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS = 32`, and `DOM_PROTOCOL_MAX_ROOT_CHILDREN_SCANNED = 128`; the existing 64 KiB serialized-message ceiling remains authoritative and truncates whole optional fields/rows rather than producing invalid partial UTF-16.

Extend `DomRootResponse` with bounded `prologue` and `epilogue` arrays for the document-type/top-level comments before `documentElement` and top-level comments after it; this keeps the existing element root/recovery authority intact without dropping legal trailing comments. Capture bounded `DocumentType.name`, `publicId`, and `systemId` rather than relying on its null `nodeValue`, and reject those optional keys on every non-document-type kind. Test strict unknown-key/kind-dependent rejection, own-property snapshotting against hostile getters/proxies, attribute/name/value/count/scan limits, UTF-8 envelope enforcement, text/comment truncation, and immutable results. Provider tests must cover simple/public/system doctypes, leading/trailing comments, text, element attributes, open shadow root, accessible frame document, and inaccessible frame leaf. Only element, shadow-root, and frame-document snapshots carry stable locators; display-only document-type/text/comment rows do not. Extend the existing mutation observer options with bounded `characterData` observation and invalidate the owning materialized branch when displayed text/comment content changes.

- [ ] **Step 2: Confirm the red state**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/domProtocol.test.ts test/domTreeProvider.test.ts test/domTreeController.test.ts
```

Expected: FAIL because structured node fields and non-element logical children are absent.

- [ ] **Step 3: Implement bounded snapshots in `DomTreeProvider`**

Keep node-reference/document-epoch authority, branch revisions, cursor paging, stable-locator semantics, observer lifecycle, and overlay exclusion unchanged; only extend the observer's node coverage/options as specified above. Add safe readers for node name/value, doctype IDs, and attributes; catch hostile DOM access. Text and comment nodes are display-only (`selectable: false`) and never reach the page overlay. `dom.select` and `dom.hover` continue to resolve only elements and reject other node kinds with `node-unavailable`.

- [ ] **Step 4: Carry structured nodes through the existing controller**

Add `node: DomNodeView` to node rows, project root `prologue` rows immediately before and `epilogue` immediately after the existing element root, retain existing row flags/virtualization/recovery, and make `DomTreeController.select` ignore non-selectable rows. Auxiliary/text/comment rows never become expansion or recovery anchors. Do not create a second tree state machine. Run `rg -n 'DomNodeView|DomRootResponse|type: "dom.root"' packages/browser-extension-core` and migrate every runtime, typed fixture, test builder, and literal found by that inventory, including recovery, the legacy tree, background/content runtimes, both panel transports, and panel runtime.

- [ ] **Step 5: Run focused and regression tests**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/domProtocol.test.ts test/domTreeProvider.test.ts test/domTreeController.test.ts test/pageInspectionSession.test.ts test/domTreeRecoveryCoordinator.test.ts test/domTreeView.test.ts test/backgroundRouter.test.ts test/contentScriptRuntime.test.ts test/panelInspectTransport.test.ts test/panelSessionTransport.test.ts test/panelRuntime.test.ts
corepack pnpm --filter @pin-op/browser-extension-core typecheck
```

Expected: PASS; existing selection, recovery, frames, mutations, and stale-response tests remain green.

- [ ] **Step 6: Commit the structured DOM model**

```powershell
git add packages/browser-extension-core/src/domProtocol.ts packages/browser-extension-core/src/domTreeProvider.ts packages/browser-extension-core/src/domTreeController.ts packages/browser-extension-core/src/pageInspectionSession.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test
git commit -m "feat(inspector): expose structured dom snapshots"
```

### Task 4: Port The Chromium-Derived Read-Only DOM Renderer

**Files:**
- Create: `packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts`
- Create: `packages/devtools-elements-ui/src/chromium/dom/ElementsTreeElement.ts`
- Create: `packages/devtools-elements-ui/test/elementsTreeOutline.test.ts`
- Modify: `packages/devtools-elements-ui/assets/devtools-elements.css`
- Modify: `packages/devtools-elements-ui/src/elementsInspectorView.ts`
- Modify: `packages/devtools-elements-ui/src/index.ts`
- Modify: `third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md`
- Modify: `third_party/chromium-devtools-frontend/UPSTREAM.json`

- [ ] **Step 1: Add failing renderer behavior tests**

Assert Chromium-style syntax tokens for simple, PUBLIC, and SYSTEM doctypes; tag names; attribute names/values; text; leading/trailing comments; shadow roots; and inaccessible frames. Cover disclosure click, `ArrowUp/Down/Left/Right`, `Home`, `End`, focus restoration, lazy `load more`, selection, pointer hover/clear, mutation rerender, and virtual row bounds.

Add negative tests for every write path:

```ts
expect(root.querySelector("[contenteditable]")).toBeNull();
expect(root.querySelector("input[type=checkbox]")).toBeNull();
expect(dispatchedCommands).not.toContainEqual(
  expect.objectContaining({ type: expect.stringMatching(/edit|remove|set/) }),
);
```

- [ ] **Step 2: Confirm the red state**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/elementsTreeOutline.test.ts
```

Expected: FAIL because the derived renderer is absent.

- [ ] **Step 3: Derive the two Chromium renderer modules**

Port useful view/rendering algorithms from the pinned `ElementsTreeOutline.ts` and `ElementsTreeElement.ts`; retain source headers and add a short `Pin-op adaptation` header naming the upstream path/revision. Replace Chromium tree outline, SDK node, context menu, DOM mutation, issue, tooltip, and host metrics dependencies with the neutral `TreeDataSource` and safe DOM helpers.

Do not mechanically preserve dead editing branches. The absence of editing is part of the type boundary, not a hidden runtime option.

- [ ] **Step 4: Derive and scope the DOM CSS**

Copy only the required rules from `elementsTreeOutline.css`, retain its license header, prefix selectors with `.pin-op-elements-inspector`, replace Chromium theme variables with documented Pin-op variables, and support light/dark/high-contrast plus a 320 px wide panel.

- [ ] **Step 5: Run package verification**

```powershell
corepack pnpm vendor:chromium-elements:record-derived
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm vendor:chromium-elements:check
```

Expected: renderer, static dependency gate, license headers, and public export all pass.

- [ ] **Step 6: Commit the renderer**

```powershell
git add packages/devtools-elements-ui third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md third_party/chromium-devtools-frontend/UPSTREAM.json
git commit -m "feat(inspector): port read-only chromium dom tree"
```

### Task 5: Adapt Pin-op Runtime To The New Shell Behind A Rollback Asset

**Files:**
- Create: `packages/browser-extension-core/src/elementsInspectorAdapter.ts`
- Create: `packages/browser-extension-core/src/inspectorPanelView.ts`
- Create: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Create: `packages/browser-extension-core/assets/inspector-panel.html`
- Create: `packages/browser-extension-core/test/elementsInspectorAdapter.test.ts`
- Create: `packages/browser-extension-core/test/inspectorPanelView.test.ts`
- Create: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`
- Modify: `packages/browser-extension-core/src/devtoolsRuntime.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/package.json`
- Modify: `packages/browser-extension-core/test/devtoolsRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/panelAssets.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`
- Modify: `packages/browser-extension-core/test/public-export.mjs`
- Create: `extensions/chrome/src/inspectorPanel.ts`
- Create: `extensions/firefox/src/inspectorPanel.ts`
- Modify: `extensions/chrome/src/devtools.ts`
- Modify: `extensions/firefox/src/devtools.ts`
- Modify: `extensions/chrome/esbuild.mjs`
- Modify: `extensions/firefox/esbuild.mjs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing adapter/lifecycle tests**

Prove `ElementsInspectorAdapter` is a thin projection over one `DomTreeController`: it exposes the same rows and delegates expand/collapse/load/select/hover exactly once. Prove the new runtime preserves these controllers unchanged:

- `PanelController` for Link/Disconnect and picker state;
- `PanelSettingsController` for Auto Refresh and IDE Highlight;
- `DomTreeRecoveryCoordinator` for invalidation recovery;
- existing Source protocol/controller behavior retained for the legacy rollback panel, with only a hidden reserved extension point in the new shell;
- `PanelInspectTransport`, correlation, compatibility, and unload disposal.

Assert old document epoch responses, selection revisions, and post-dispose events cannot render.

- [ ] **Step 2: Confirm the red state**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/elementsInspectorAdapter.test.ts test/inspectorPanelView.test.ts test/inspectorPanelRuntime.test.ts test/devtoolsRuntime.test.ts
```

Expected: FAIL because the adapter, shell view, and separate runtime asset are missing.

- [ ] **Step 3: Implement the adapter and Pin-op-owned shell**

`InspectorPanelView` implements the current `PanelView` contract for the toolbar/status controls and exposes DOM/Rules roots plus a hidden future-extension mount. `InspectorPanelRuntime` mirrors the lifecycle ownership in `panelRuntime.ts` but mounts `ElementsInspectorView` through `ElementsInspectorAdapter`. Keep current Source message/controller code intact for the legacy panel, but do not create `SourcePaneView` or a visible Source tab in the new runtime. Extract shared lifecycle helpers only when a test proves both runtimes need them; do not duplicate bridge/session ownership. Declare `@pin-op/devtools-elements-ui: "workspace:*"` as a production dependency of `@pin-op/browser-extension-core`; update/install the workspace lock before verification so a clean checkout has the same topological build edge as the developer tree.

- [ ] **Step 4: Add an explicit panel-page selection**

Extend `DevtoolsRuntimeOptions` with:

```ts
readonly panelPage?: "/dist/panel.html" | "/dist/inspector-panel.html";
```

Default remains `/dist/panel.html`. Both esbuild scripts validate `PIN_OP_PANEL_VARIANT=legacy|inspector`, default it to `legacy`, and compile the selected fixed page into their `devtools.ts` adapters; installed-test/dev builds set `inspector`. `inspector-panel.html` loads its own thin `inspectorPanel.ts -> inspectorPanel.js` entrypoint so runtime choice does not depend on an untrusted query parameter. Browser store builds do not change default until checkpoint 4. Chrome and Firefox contain no renderer forks.

- [ ] **Step 5: Verify lifecycle regression**

```powershell
corepack pnpm install
corepack pnpm --filter @pin-op/devtools-elements-ui build
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter @pin-op/browser-extension-core typecheck
```

Expected: the neutral UI builds first through the declared workspace dependency, then all legacy tests, new Inspector runtime tests, and semantic type checks pass from a clean install.

- [ ] **Step 6: Commit runtime integration**

```powershell
git add packages/browser-extension-core extensions/chrome extensions/firefox pnpm-lock.yaml
git commit -m "feat(inspector): mount chromium dom shell"
```

### Task 6: Build, Package, License, And Verify Both Browser Assets

**Files:**
- Create: `tools/browser-panel-assets.mjs`
- Create: `tools/test/browser-bundle-notices.test.mjs`
- Modify: `tools/browser-bundle-notices.mjs`
- Modify: `extensions/chrome/esbuild.mjs`
- Modify: `extensions/firefox/esbuild.mjs`
- Modify: `extensions/chrome/package.json`
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/chrome/THIRD_PARTY_NOTICES`
- Modify: `extensions/firefox/THIRD_PARTY_NOTICES`
- Modify: `extensions/chrome/test/panelAssets.test.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `tools/browser-package-contract.mjs`
- Modify: `tools/verify-artifacts.mjs`
- Modify: `tools/test/archive-firefox-source.test.mjs`
- Modify: `tools/test/verify-browser-artifacts.test.mjs`
- Modify: `docs/architecture.md`
- Modify: `docs/firefox-source-submission.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Add failing asset/notices/source tests**

Require both builds to contain `inspector-panel.html`, `inspectorPanel.js`, and a deterministic combined panel stylesheet. Require identical Chromium-root and Apple/Pecoraro notice sections in Chrome and Firefox, containing the pinned revision and complete deduplicated BSD texts. Require the Firefox source archive to include the upstream manifest, root/embedded licenses, snapshot, derived package source, and reproduction tools.

The browser contract must reject unscoped Chromium CSS, remote UI resources, inline script/style, `eval`, new permissions, `debugger`, `nativeMessaging`, and production imports from the upstream snapshot.

- [ ] **Step 2: Confirm the red state**

```powershell
corepack pnpm exec node --test tools/test/browser-bundle-notices.test.mjs tools/test/archive-firefox-source.test.mjs tools/test/verify-browser-artifacts.test.mjs
corepack pnpm --filter pin-op-chrome exec vitest run test/panelAssets.test.ts
corepack pnpm --filter pin-op-firefox exec vitest run test/panelAssets.test.ts
```

Expected: FAIL because the new assets and notice inventory are absent.

- [ ] **Step 3: Centralize deterministic panel asset assembly**

`tools/browser-panel-assets.mjs` copies the two HTML entrypoints, logo/icons, core CSS, and `devtools-elements.css` in fixed order; esbuild emits both `panel.js` and `inspectorPanel.js`. Both esbuild files call the common asset helper. Update build order to:

```text
@pin-op/protocol
-> @pin-op/devtools-elements-ui
-> @pin-op/browser-extension-core
-> Chrome / Firefox bundles
```

- [ ] **Step 4: Include workspace-derived Chromium notices**

Extend `browser-bundle-notices.mjs`; its existing `node_modules` scan is insufficient. Read the checked-in upstream manifest, root license, and every distinct embedded notice explicitly. Generate deterministic, deduplicated Chromium-root and Apple/Pecoraro BSD sections in both browser notices; do not rely on minification retaining source headers.

- [ ] **Step 5: Document the boundary and verify packages**

Document that Pin-op uses BSD-licensed Chromium-derived view code but no native DevTools backend. Run the pre-archive verification first:

```powershell
corepack pnpm vendor:chromium-elements:check
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm build
```

Expected: all pre-archive checks pass.

- [ ] **Step 6: Commit every source-archive input**

`tools/archive-firefox-source.mjs` uses `git archive HEAD`; commit the new source, notices, manifest, build helpers, and docs before packaging:

```powershell
git add tools extensions/chrome extensions/firefox extensions/test docs packages/browser-extension-core/package.json pnpm-lock.yaml
git commit -m "build(inspector): package chromium-derived shell"
```

- [ ] **Step 7: Package and verify the committed tree**

```powershell
corepack pnpm package
corepack pnpm artifacts:verify
```

Expected: Chrome and Firefox packages contain byte-identical derived UI CSS and the same complete Chromium/Apple attribution; the Firefox source archive contains every committed reproduction input. If this fails, make a focused corrective commit and rerun both commands from the new `HEAD`.

- [ ] **Step 8: Manual checkpoint**

Build with `PIN_OP_PANEL_VARIANT=inspector`, load the unpacked Chrome and Firefox builds, and verify Link, picker, tree selection/hover, mutation recovery, refresh, IDE Highlight, resize, keyboard navigation, high contrast, disconnect cleanup, and absence of a visible Source tab. Separately verify Source still works in the legacy rollback build. Record results in `docs/mvp-verification.md`; do not enable the Inspector asset by default yet.

## Checkpoint Exit Criteria

- The pinned upstream subset and every local derivation are reproducible and licensed.
- One shared Chromium-derived DOM renderer runs in Chrome and Firefox.
- Link, Disconnect, picker, overlay, refresh, IDE Highlight, recovery, and multi-window ownership remain under their current Pin-op controllers; legacy Source behavior remains intact but is not mounted in the new panel.
- DOM UI has no edit path.
- The legacy panel remains the store-build default until checkpoint 4.
- Rules is visibly a placeholder; no incomplete Rules behavior is presented as native parity.
