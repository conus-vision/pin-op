# Read-Only Pseudo-State Preview And Inspector Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve useful `:hover` and `:focus` inspection through reversible author-style emulation, harden every cleanup path, and make the Chromium-derived Inspector the default shared Chrome/Firefox panel while retaining a bounded legacy rollback asset.

**Architecture:** A content-local `PseudoStatePreview` assigns random Pin-op-owned marker attributes to the selected element and mounts Pin-op-owned temporary stylesheets containing transformed mirror rules in the same document or open shadow root. It places each mount beside the source sheet owner when possible, preserves selector specificity, rebases external-sheet URLs, and reports source-order/CSP limitations as partial. The matched-style collector uses the same selector transformer for Rules. All temporary style mounts and markers are excluded from DOM/Rules/inspect evidence and are synchronously cleaned on controlled in-context transitions, with best-effort teardown before a content context is lost. No focus, mouse, pointer, or keyboard event is dispatched.

**Tech Stack:** TypeScript, postcss-selector-parser, postcss-value-parser, DOM/CSSOM APIs, WebExtensions, pnpm, Vitest, esbuild, installed Chrome/Firefox verification.

---

## Source Of Truth And Dependencies

Use `docs/superpowers/specs/2026-08-22-chromium-inspector-port-design.md`. Complete the shell/DOM, read-only Rules, and Rules CSS/SCSS source-navigation plans first.

This is intentionally an approximation of accessible author rules, not privileged native pseudo forcing. The UI must say `Preview :hover` / `Preview :focus` in accessible help text and surface partial support when rules are inaccessible or unsupported.

Temporary style/attribute mutations are observable by page JavaScript while preview is enabled. Pin-op filters its own artifacts from its Inspector models and never dispatches input/focus events, but mirror styles can still cause CSS transitions, animations, resource loads, and page-observable mutation records. Abrupt extension disable/update/crash can destroy the only content context before object-identity cleanup; artifacts can then remain until page navigation/reload. Documentation and tests must not promise otherwise.

## Supported Selector Policy

Transform exact positive `:hover` and `:focus` pseudo-class nodes only. Preserve `:focus-visible`, `:focus-within`, pseudo-elements, strings, and escaped text unchanged. Support the pseudo only when it belongs to the rightmost/subject compound proven to represent the selected element, including direct use and positive branches in `:is()`/`:where()` whose specificity remains provably unchanged. Support combined `:hover:focus` on that same compound. Append a separate random `:where([selection-marker])` guard to the proven subject compound of every emitted mirror selector; because the marker exists only on the selected element and `:where()` contributes zero specificity, no other page element can receive mirror styling. Drop unaffected top-level/function branches; if doing so changes functional-pseudo specificity, mark the selector unsupported. Mark as unsupported, without guessing:

- multiple target compounds in one complex selector;
- ancestor/sibling pseudo targets such as `.parent:hover .selected`;
- target pseudos under negation, including `:not(:hover)` and `:not(:focus)`, because additive mirror CSS cannot suppress the still-matching original native rule;
- target pseudos inside `:has()`;
- malformed selectors;
- selectors whose reconstructed rule cannot be mounted safely;
- inaccessible sheets/grouping rules;
- keyframe selectors;
- rules altered concurrently so ownership cannot be proven.

The replacement is a random attribute selector, whose specificity `(0,1,0)` equals an ordinary pseudo class. No class/name exposed by the page is reused.

### Task 1: Build And Prove The Selector Transformer

**Files:**
- Create: `packages/browser-extension-core/src/pseudoStateSelector.ts`
- Create: `packages/browser-extension-core/test/pseudoStateSelector.test.ts`
- Modify: `packages/browser-extension-core/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing table-driven parser tests**

Use `postcss-selector-parser` and cover at least:

```ts
[
  [".button:hover", ".button[data-pin-op-preview-hover-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])"],
  ["input:focus", "input[data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])"],
  [".button:hover:focus", ".button[data-pin-op-preview-hover-abcdefghijkl][data-pin-op-preview-focus-abcdefghijkl]:where([data-pin-op-preview-selected-abcdefghijkl])"],
  [":is(.button:hover, a)", ":is(.button[data-pin-op-preview-hover-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])"],
  [":where(.button:focus)", ":where(.button[data-pin-op-preview-focus-abcdefghijkl]):where([data-pin-op-preview-selected-abcdefghijkl])"],
]
```

Test selector lists where only supported branches are emitted, mixed functional branches whose maximum specificity would change, escaped identifiers, nested functions, pseudo-elements, `:focus-visible`, `:focus-within`, `:not(:hover)`, `:has(:hover)`, `.parent:hover .selected`, two target compounds, malformed input, byte/branch/depth limits, and deterministic formatting. Verify specificity with a small independent specificity counter, and verify the output cannot match an otherwise matching non-selected element.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/pseudoStateSelector.test.ts
```

Expected: FAIL because the transformer does not exist.

- [ ] **Step 3: Implement a typed transformation result**

```ts
type PseudoState = "hover" | "focus";

type SelectorTransformResult =
  | {
      readonly kind: "supported";
      readonly selectorText: string;
      readonly transformedBranches: number;
      readonly omittedBranches: number;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: PseudoSelectorUnsupportedReason;
    };
```

Operate on parser nodes, never string replacement. State and selection marker names are injected by the caller and validated against `^data-pin-op-preview-[a-z0-9-]{16,64}$`.

- [ ] **Step 4: Verify dependency/notices and commit**

Verify the selector parser added by checkpoint 2 remains an explicit production dependency, and add `postcss-value-parser` as a production dependency of `@pin-op/browser-extension-core`; update the lockfile and later regenerate browser notices.

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/pseudoStateSelector.test.ts
corepack pnpm --filter @pin-op/browser-extension-core typecheck
git add packages/browser-extension-core pnpm-lock.yaml
git commit -m "feat(inspector): transform preview pseudo selectors"
```

### Task 2: Implement Reversible Content-Local Pseudo-State Preview

**Files:**
- Create: `packages/browser-extension-core/src/pseudoStatePreview.ts`
- Create: `packages/browser-extension-core/src/pinOpRuntimeArtifacts.ts`
- Create: `packages/browser-extension-core/test/pseudoStatePreview.test.ts`
- Create: `packages/browser-extension-core/test/pinOpRuntimeArtifacts.test.ts`
- Modify: `packages/browser-extension-core/src/cssRuleWalker.ts`
- Modify: `packages/browser-extension-core/src/stylesheetRegistry.ts`
- Modify: `packages/browser-extension-core/src/domTreeProvider.ts`
- Modify: `packages/browser-extension-core/src/domStableLocator.ts`
- Modify: `packages/browser-extension-core/src/elementSnapshot.ts`
- Modify: `packages/browser-extension-core/src/pageOverlay.ts`
- Modify: `packages/browser-extension-core/test/cssRuleWalker.test.ts`
- Modify: `packages/browser-extension-core/test/stylesheetRegistry.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeProvider.test.ts`
- Modify: `packages/browser-extension-core/test/domStableLocator.test.ts`
- Modify: `packages/browser-extension-core/test/elementSnapshot.test.ts`
- Modify: `packages/browser-extension-core/test/pageOverlay.test.ts`

- [ ] **Step 1: Add failing preview mount/cleanup tests**

Group supported mirror rules by their source sheet/root. For a `<style>` or `<link>` owner, mount one Pin-op-owned temporary `<style>` immediately after that owner. For an adopted sheet or a sheet inside an open shadow root, mount a constructable stylesheet adjacent in `adoptedStyleSheets` when supported, otherwise a Pin-op-owned `<style>` in the same root. Store the exact created node/sheet object, previous adopted-sheet array, root, session token, and marker attributes. Never write into the original stylesheet.

Test:

- hover, focus, and combined markers;
- nested media/supports grouping rules;
- style, link, import, open-shadow, and adopted sheets;
- preservation of declarations, `!important`, grouping contexts, and rule order inside each mirror mount;
- only `@media`/`@supports` grouping is reconstructed in this release; `@layer`, `@scope`, `@container`, `@starting-style`, unknown grouping rules, and any context whose cascade/scope cannot be proven are rejected as unsupported;
- an equal-specificity later original rule that proves the mirror mount's cross-sheet/source-order result is partial rather than falsely classified exact;
- rebasing relative external-sheet `url()` tokens while preserving absolute, fragment, data, and blob URLs;
- CSP/style-mount rejection and adopted-sheet assignment failure;
- nested CSS rules flattened only from a proven resolved selector/declaration snapshot; unprovable nesting is unsupported;
- inaccessible/read-only sheet partial diagnostics;
- page mutation/reparenting between mount and cleanup;
- repeated toggle idempotence;
- selection replacement;
- an otherwise matching sibling/non-selected element whose computed style remains unchanged for direct, selector-list, `:is()`, and `:where()` cases;
- hostile CSSOM getters/methods;
- cleanup after a partial mount failure;
- removal of the exact owned constructable sheet from the current adopted-sheet array while preserving every concurrently added page-owned entry and their relative order;
- one constructed source sheet adopted by multiple roots, with a mirror mounted and removed only in the selected root.

Cleanup removes only the exact stored node/sheet object. For adopted sheets, compute the current list with only that exact object removed rather than restoring a stale full list. A token match alone is never sufficient to remove anything. Pass the same exact-artifact exclusion predicate into `DomStableLocator` sibling indexing on both capture and recovery so a temporary `<style>` cannot shift a locator.

- [ ] **Step 2: Add failing artifact-exclusion tests**

While preview is active, assert marker attributes, temporary style nodes, and mirror rules are absent from:

- `DomNodeView.attributes` and legacy labels;
- `elementSnapshot` attributes/selector/text evidence;
- `cssRuleWalker` and `MatchedStyles`;
- inspect facts and rule evidence;
- page overlay target/ancestor calculation;
- DOM mutation invalidation/recovery;
- stable-locator sibling indexing during capture, resolution, and uniqueness scans.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/pseudoStatePreview.test.ts test/pinOpRuntimeArtifacts.test.ts test/domTreeProvider.test.ts test/domStableLocator.test.ts test/cssRuleWalker.test.ts test/elementSnapshot.test.ts
```

Expected: FAIL because preview ownership/exclusion is absent.

- [ ] **Step 4: Implement random session-scoped artifact ownership**

Generate independent marker attribute names for selection, hover, and focus from cryptographic randomness. `PinOpRuntimeArtifacts` owns the marker set, exact temporary style nodes, and constructable sheet objects; every DOM/CSS collector and stable-locator scan receives its exclusion predicates. Do not expose tokens in public messages or diagnostic text.

- [ ] **Step 5: Implement fail-closed preview application**

Add the selection marker plus requested state markers only to the currently authoritative selected element. Build CSS text from parsed, selection-guarded, scope-proven resolved selectors, supported media/supports contexts, and direct `CSSStyleDeclaration` values; rebase external relative URLs with `postcss-value-parser` against the public stylesheet URL. Reject unsupported grouping/nesting rather than lifting a rule into a different cascade. Do not serialize unresolved nested `rule.cssText`. Mount only in the selected element's document/open-shadow root, deduplicating shared adopted sources by `(root, sheet object)`. If a branch/sheet fails, keep successful mounts, report bounded reasons including source-order approximation, and retain exact object ownership for cleanup.

Never call `focus()`, `blur()`, `dispatchEvent`, mouse/pointer/keyboard constructors, `chrome.debugger`, Firefox actors, or page functions.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/pseudoStatePreview.test.ts test/pinOpRuntimeArtifacts.test.ts test/cssRuleWalker.test.ts test/stylesheetRegistry.test.ts test/domTreeProvider.test.ts test/domStableLocator.test.ts test/elementSnapshot.test.ts test/pageOverlay.test.ts
git add packages/browser-extension-core
git commit -m "feat(inspector): emulate reversible pseudo states"
```

### Task 3: Add Strict Local Pseudo-State Commands And Model Correlation

**Files:**
- Modify: `packages/devtools-elements-ui/src/contracts.ts`
- Modify: `packages/devtools-elements-ui/test/matchedStylesContract.test.ts`
- Modify: `packages/devtools-elements-ui/test/matchedStylesContract.types.ts`
- Modify: `packages/devtools-elements-ui/test/fixtures/elementsSession.ts`
- Modify: `packages/devtools-elements-ui/test/elementsInspectorView.test.ts`
- Modify: `packages/devtools-elements-ui/test/stylesSidebarPane.test.ts`
- Modify: `packages/browser-extension-core/src/stylesProtocol.ts`
- Modify: `packages/browser-extension-core/src/matchedStylesCollector.ts`
- Modify: `packages/browser-extension-core/src/matchedStylesModel.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/src/contentScriptRuntime.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/src/panelSessionTransport.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Modify: `packages/browser-extension-core/test/stylesProtocol.test.ts`
- Modify: `packages/browser-extension-core/test/matchedStylesCollector.test.ts`
- Modify: `packages/browser-extension-core/test/matchedStylesModel.test.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`

- [ ] **Step 1: Add failing strict command tests**

Define one atomic request rather than independent racing toggles:

```ts
interface StylesSetPseudoStatesRequest {
  readonly type: "styles.setPseudoStates";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly expectedStylesRevision: number;
  readonly expectedPseudoStateRevision: number;
  readonly states: readonly ("hover" | "focus")[];
}

interface StylesPseudoStatesResponse {
  readonly type: "styles.pseudoStates";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly pseudoStateRevision: number;
  readonly states: readonly ("hover" | "focus")[];
  readonly unsupportedRuleCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly approximateRuleCount: number;
}
```

In the existing `StylesGetMatchedRequest`/`StylesMatchedResponse`, add and echo both `pseudoStateRevision` and canonical `pseudoStates`; the model must never accept a pre-preview response for a post-preview key. Add the same fields plus `unsupportedRuleCount`, `inaccessibleStylesheetCount`, and `approximateRuleCount` to the neutral `MatchedStylesSnapshot` contract in this task. Require canonical state order, uniqueness, strict keys, request/identity echo, compare-and-set `stylesRevision`/pseudo revision semantics, bounded counts, and errors `stale-document | stale-selection | stale-styles | stale-pseudo-state | unknown-node | node-unavailable | cancelled | internal-error`. A rule mirrored at a different cross-sheet source position increments `approximateRuleCount` unless precedence equivalence was proven. Run `rg -n 'MatchedStylesSnapshot|pseudoStateRevision|pseudoStates' packages/devtools-elements-ui` and migrate every neutral fixture, typed contract assertion, and renderer literal in the same compile-green task.

- [ ] **Step 2: Add failing lifecycle tests**

Prove object-identity cleanup happens before every controlled in-context transition:

- selected node or document epoch changes;
- a new user selection/recovery inspect generation begins (not a same-selection styles-correlation renewal);
- DOM recovery starts;
- soft stylesheet refresh or page reload;
- frame unload/navigation;
- cooperative content lease replacement/loss while the old content context can still run;
- window unlink, IDE disconnect, compatibility mismatch;
- panel/content/background dispose when the content cleanup request is acknowledged.

Use synchronous cleanup assertions inside `PageInspectionSession`: after each local exit call, marker/style counts must already be zero before later work. For background/panel teardown, assert bounded best-effort request/ack behavior and document that abrupt context destruction cannot guarantee cleanup; page navigation/reload is the final cleanup boundary.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/matchedStylesContract.test.ts test/elementsInspectorView.test.ts test/stylesSidebarPane.test.ts
corepack pnpm --filter @pin-op/devtools-elements-ui typecheck
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesProtocol.test.ts test/matchedStylesModel.test.ts test/pageInspectionSession.test.ts test/backgroundRouter.test.ts test/inspectorPanelRuntime.test.ts
```

Expected: FAIL in both the neutral contract/type fixtures and browser-core lifecycle suites because pseudo correlation is absent.

- [ ] **Step 4: Implement content authority and shared selector matching**

`PageInspectionSession` owns one `PseudoStatePreview`. It validates the selected element both before and after application. `MatchedStylesCollector` uses `pseudoStateSelector.ts` plus the same current markers to decide selector matches; temporary mirror styles remain excluded. Include `pseudoStateRevision` and active states in the request, response, neutral snapshot, and model key so stale non-preview responses cannot overwrite preview Rules. Adding/removing Pin-op-owned mounts advances `pseudoStateRevision` and the aggregate `stylesRevision`, but must not advance `stylesheetRevision`, reset `ruleRef`, or trigger the registry fingerprint loop. The resulting same-selection inspect renewal keeps the preview active while replacing stale IDE rule evidence/authorities.

- [ ] **Step 5: Route through the existing trusted panel/content session**

Use the same bounded request-ID rewrite and tab/session ownership as other `styles.*` queries. Do not add public WebSocket messages or capabilities for pseudo state; all data stays inside the browser extension.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/matchedStylesContract.test.ts test/elementsInspectorView.test.ts test/stylesSidebarPane.test.ts
corepack pnpm --filter @pin-op/devtools-elements-ui typecheck
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter @pin-op/browser-extension-core typecheck
git add packages/devtools-elements-ui packages/browser-extension-core
git commit -m "feat(inspector): correlate hover and focus preview"
```

### Task 4: Add The Read-Only `:hov` UI

**Files:**
- Create: `packages/devtools-elements-ui/src/pseudoStateController.ts`
- Create: `packages/devtools-elements-ui/test/pseudoStateController.test.ts`
- Modify: `packages/devtools-elements-ui/src/contracts.ts`
- Modify: `packages/devtools-elements-ui/src/chromium/rules/StylesSidebarPane.ts`
- Modify: `packages/devtools-elements-ui/src/elementsInspectorView.ts`
- Modify: `packages/devtools-elements-ui/assets/devtools-elements.css`
- Modify: `packages/devtools-elements-ui/test/stylesSidebarPane.test.ts`
- Modify: `packages/devtools-elements-ui/test/elementsInspectorView.test.ts`
- Modify: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Modify: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`
- Modify: `third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md`
- Modify: `third_party/chromium-devtools-frontend/UPSTREAM.json`

- [ ] **Step 1: Add failing interaction/accessibility tests**

The Rules toolbar contains a `:hov` button opening two checkboxes: `:hover` and `:focus`. Test keyboard open/close, focus return, checked/loading/disabled state, error/partial description, state replacement (not racing toggle messages), selection reset, and screen-reader labels that call the feature a preview.

Assert there are no `:active`, `:visited`, `:focus-within`, or arbitrary pseudo inputs in this release.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/pseudoStateController.test.ts test/stylesSidebarPane.test.ts test/elementsInspectorView.test.ts
```

Expected: FAIL because the `:hov` controller/view do not exist.

- [ ] **Step 3: Implement the neutral UI/controller boundary**

Expose a `PseudoStateDataSource` with immutable state and `setStates(states)`; the browser-core adapter owns transport. Disable the UI while no selectable element exists, during recovery, after disconnect/mismatch, and while an atomic update is pending. Record the `:hov` additions to the derived Rules module and scoped stylesheet under their existing stable change-record anchors before refreshing their local digests.

- [ ] **Step 4: Render honest partial diagnostics**

Show a compact warning when unsupported, inaccessible, or approximate counts are non-zero. The tooltip/help text must distinguish unsupported coverage from source-order approximation, say author styles only, and never claim native browser forcing or exact cascade parity.

- [ ] **Step 5: Verify and commit**

```powershell
corepack pnpm vendor:chromium-elements:record-derived
corepack pnpm vendor:chromium-elements:check-complete
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/inspectorPanelRuntime.test.ts
git add packages/devtools-elements-ui packages/browser-extension-core third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md third_party/chromium-devtools-frontend/UPSTREAM.json
git commit -m "feat(inspector): add hover and focus preview controls"
```

### Task 5: Harden Refresh, Navigation, Recovery, And Authority Invalidation

**Files:**
- Modify: `packages/browser-extension-core/src/stylesheetRefresher.ts`
- Modify: `packages/browser-extension-core/src/tabRefreshCoordinator.ts`
- Modify: `packages/browser-extension-core/src/backgroundContentRefresh.ts`
- Modify: `packages/browser-extension-core/src/domTreeRecoveryCoordinator.ts`
- Modify: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Modify: `packages/browser-extension-core/src/inspectCorrelationStore.ts`
- Modify: `packages/browser-extension-core/src/rulesSourcesController.ts`
- Modify: `packages/browser-extension-core/test/stylesheetRefresher.test.ts`
- Modify: `packages/browser-extension-core/test/tabRefreshCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundContentRefresh.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeRecoveryCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/inspectCorrelationStore.test.ts`
- Modify: `packages/browser-extension-core/test/rulesSourcesController.test.ts`
- Modify: `packages/browser-extension-core/test/windowWorkflow.test.ts`

- [ ] **Step 1: Add a cross-controller cleanup matrix test**

For every controlled exit event, assert this order:

```text
clear pseudo markers/temporary styles
-> advance/reset pseudo state plus aggregate stylesRevision and invalidate the matched-style model
-> advance stylesheetRevision only when a real author sheet changed/refreshed
-> revoke Rules source/open authority
-> refresh/recover/navigate/disconnect
-> accept only a new correlated generation
```

Use deferred promises to prove stale fingerprint rescans, matched responses, `rules.sources`, and `rules.open` cannot act after the boundary. Add a separate abrupt-context-loss test that records best-effort cleanup failure without claiming the now-destroyed content context can mutate the page.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesheetRefresher.test.ts test/tabRefreshCoordinator.test.ts test/domTreeRecoveryCoordinator.test.ts test/inspectCorrelationStore.test.ts test/windowWorkflow.test.ts
```

Expected: at least the new ordering/preview cleanup cases fail.

- [ ] **Step 3: Centralize the transition hook**

Introduce one runtime-owned cleanup callback invoked by controlled refresh/recovery/disconnect paths before their existing side effects. Do not make refresh, DOM recovery, or bridge owners depend on UI classes; inject the cleanup capability. Background-owned teardown waits only for a bounded acknowledgement and then proceeds; it cannot promise cleanup after the content context has already disappeared.

- [ ] **Step 4: Verify regressions and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core test
git add packages/browser-extension-core
git commit -m "fix(inspector): revoke preview state on controlled exits"
```

### Task 6: Make The Chromium-Derived Inspector The Default With Rollback

**Files:**
- Modify: `extensions/chrome/src/devtools.ts`
- Modify: `extensions/firefox/src/devtools.ts`
- Modify: `packages/browser-extension-core/src/devtoolsRuntime.ts`
- Modify: `packages/browser-extension-core/test/devtoolsRuntime.test.ts`
- Modify: `extensions/chrome/test/adapter.test.ts`
- Modify: `extensions/firefox/test/adapter.test.ts`
- Modify: `extensions/chrome/test/panelAssets.test.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `tools/browser-package-contract.mjs`
- Modify: `tools/browser-bundle-notices.mjs`
- Modify: `extensions/chrome/THIRD_PARTY_NOTICES`
- Modify: `extensions/firefox/THIRD_PARTY_NOTICES`
- Modify: `tools/smoke-packaged-chrome.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `tools/test/verify-browser-artifacts.test.mjs`

- [ ] **Step 1: Add failing default/rollback package tests**

Require both browser adapters to register `/dist/inspector-panel.html` by default and to package `/dist/panel.html` as a non-default rollback asset. Require identical Chromium-derived UI hashes and selectors in both packages. Ensure no extra browser permission, remote code, or Chromium branding appears.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm exec node --test tools/test/packaged-chrome-smoke.test.mjs tools/test/verify-browser-artifacts.test.mjs
```

Expected: FAIL because the legacy page is still selected by default and pseudo-state markers are not in package contracts.

- [ ] **Step 3: Switch only the registered panel page**

Change the validated `PIN_OP_PANEL_VARIANT` build default from `legacy` to `inspector` in both esbuild adapters. Keep `/dist/panel.html` and its runtime in the artifacts for one bounded rollback release; `PIN_OP_PANEL_VARIANT=legacy` is the documented local rollback build and can select only the two packaged pages, never a URL.

- [ ] **Step 4: Regenerate dependency/license notices**

Include `postcss-selector-parser`, `postcss-value-parser`, their transitive production licenses, and the pinned Chromium section in both notices. Verify the Firefox source archive contains all build sources.

- [ ] **Step 5: Keep packaged smoke within its real authority**

The existing packaged Chrome smoke does not open the DevTools panel or a linked VS Code instance. Extend it only to verify the default packaged page/entrypoint markers, fixture pseudo selectors, runtime artifact exclusion helpers, and absence of persistent artifacts before/after fixture page reload. DOM/Rules UI interaction, SCSS origin clicking, and controlled cleanup remain covered by unit/integration tests plus the installed manual matrix unless a separately designed panel E2E harness is added.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm build
git add extensions packages/browser-extension-core tools
git commit -m "feat(inspector): enable shared chromium panel"
```

### Task 7: Complete Installed Verification, Documentation, And Release Gate

**Files:**
- Modify: `examples/basic-css/index.html`
- Modify: `examples/basic-css/dist/app.css`
- Modify: `examples/basic-css/dist/app.css.map`
- Modify: `examples/basic-css/src/card.scss`
- Modify: `tools/simulator/test/exampleFixtureServer.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `PRIVACY.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/protocol.md`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/installed-verification.md`
- Modify: `docs/firefox-source-submission.md`
- Modify: `docs/release.md`
- Modify: `docs/store-listings.md`
- Modify: `tools/test/installed-verification-doc.test.mjs`
- Modify: `tools/test/store-listings.test.mjs`
- Modify: `tools/test/archive-firefox-source.test.mjs`

- [ ] **Step 1: Add failing documentation truth tests**

Require docs/store text to state:

- one shared Chromium-derived read-only Inspector UI;
- BSD attribution and pinned source availability;
- exact CSS/SCSS opening only on explicit origin click;
- author-style pseudo preview, not native forcing;
- no user-authored CSS/DOM editing operations and no input event dispatch;
- temporary preview artifacts may be observed by page scripts while enabled;
- abrupt extension termination may leave artifacts until page navigation/reload;
- known inaccessible/unsupported cases;
- legacy rollback asset lifetime and removal criterion.

- [ ] **Step 2: Confirm the documentation red state**

```powershell
corepack pnpm exec node --test tools/test/installed-verification-doc.test.mjs tools/test/store-listings.test.mjs tools/test/archive-firefox-source.test.mjs
```

Expected: FAIL because the new preview/rollback truth requirements are not yet present in the release documents and source-archive contract.

- [ ] **Step 3: Add deterministic preview fixtures**

Add a focusable target and rules for hover, focus, combined hover/focus, unsupported `:not(:hover)`, unsupported ancestor hover, mixed functional branches, equal-specificity later source-order conflict, same-origin frame, open shadow root, document/shadow adopted sheets, one constructed sheet shared across roots, and observable transition/resource/mutation counters. Fixture tests prove non-selected elements are unchanged, no input/focus events are dispatched, and page reload removes all artifacts.

- [ ] **Step 4: Run the pre-archive automated gate**

```powershell
corepack pnpm vendor:chromium-elements:check-complete
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/protocol test
corepack pnpm --filter @pin-op/bridge test
corepack pnpm --filter pin-op test
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: all commands exit 0 with no skipped required suite.

- [ ] **Step 5: Perform installed Chrome and Firefox matrix**

Record evidence for:

- Link, Disconnect, reconnect, protocol mismatch, and two-window isolation;
- picker/tree hover/selection, frame/shadow/mutation recovery;
- read-only inline/matched/inherited/overridden/unknown Rules;
- document and open-shadow `adoptedStyleSheets`, one constructed sheet shared across roots, and isolation of the selected root in both browsers;
- live `insertRule`, `deleteRule`, `replaceSync`, adoption-list replacement/in-place mutation where exposed, and browser timer-throttling/manual-refresh behavior;
- eventless `CSSStyleSheet.disabled`/`MediaList` mutation, proving both stylesheet/styles revisions advance, plus JS-only `checked`, `indeterminate`, `value`/validity/placeholder, and supported custom-state changes, proving only styles revision advances and `ruleRef` remains stable; repeat observation under timer throttling and confirm manual Refresh as the deterministic fallback;
- CSP rejection/fallback for temporary style and constructable-sheet mounts;
- CSS origin, valid SCSS map, invalid map fallback, cross-file open, stale authority;
- hover/focus supported and partial cases;
- Auto Refresh styles/reload and scroll restoration;
- IDE Highlight regression and absence of the future Source tab in the new panel; verify Source only in the legacy rollback panel;
- cleanup after toggle, selection, refresh, navigation, disconnect, and mismatch; separately verify/document that abrupt extension reload may require page reload for final cleanup;
- dark/light/high-contrast, keyboard, screen reader labels, 320 px and wide layouts.

- [ ] **Step 6: Define rollback removal follow-up**

Keep the legacy asset for exactly one published rollback release. Open a tracked follow-up that removes `panel.html`, `panelRuntime.ts`, `DomTreeView`, their presentation-only tests/exports, and rollback documentation only after field telemetry/support confirms no blocking regression. Do not remove `DomTreeController`, provider, recovery, picker, overlay, Source, or any bridge owner.

- [ ] **Step 7: Commit every final source-archive input**

```powershell
git add README.md CHANGELOG.md PRIVACY.md docs examples tools/simulator/test tools/test
git commit -m "docs(inspector): document preview and rollout"
```

- [ ] **Step 8: Package and smoke the committed release tree**

```powershell
corepack pnpm package
corepack pnpm artifacts:verify
corepack pnpm smoke:chrome-package
corepack pnpm smoke:vscode-package
```

Expected: all commands exit 0 and the Firefox source archive contains the just-committed fixtures, documentation, provenance, and build inputs. If a correction is required, commit it and rerun from the new `HEAD`.

## Checkpoint Exit Criteria

- `:hover` and `:focus` preview supported author rules without calling focus or dispatching events.
- Marker attributes and temporary mirror styles cannot leak into UI/evidence; controlled exits remove them, while abrupt context loss is documented as lasting until page navigation/reload.
- Unsupported/inaccessible selectors are visibly partial rather than guessed.
- The Chromium-derived DOM + Rules panel is the default in both browsers and is backed by the same shared code.
- Exact CSS/SCSS origin navigation, Link, Refresh, IDE Highlight, recovery, and window/session ownership pass installed verification; legacy Source remains intact but the new panel reserves it for the later milestone.
- A packaged legacy rollback page remains for one bounded release with an explicit removal criterion.
