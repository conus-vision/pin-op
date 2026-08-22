# Read-Only Matched Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one browser-local, read-only matched-style authority and render Chromium-derived Rules for the selected node in both Chrome and Firefox without CDP/RDP or CSS/DOM mutation.

**Architecture:** Extract the existing bounded CSSOM walk into a reusable registry, assign epoch-scoped `ruleRef` identities, and query matched author styles through a strict internal `styles.*` protocol. `MatchedStylesCollector` is the sole authority for both Rules rows and the CSS facts sent to the IDE. A conservative cascade classifier emits `winning-known-author`, `overridden-known-author`, `inactive`, or `unknown`; it never invents native-DevTools certainty. The Chromium-derived Rules renderer consumes immutable neutral snapshots and exposes no edit commands.

**Tech Stack:** TypeScript, DOM/CSSOM APIs, PostCSS, postcss-selector-parser, pnpm, Vitest, WebExtensions, Chromium-derived view/CSS sources from checkpoint 1.

---

## Source Of Truth And Dependencies

Use `docs/superpowers/specs/2026-08-22-chromium-inspector-port-design.md`. Complete `2026-08-22-chromium-inspector-shell-dom.md` first. This plan keeps public protocol v6 and IDE cross-file navigation unchanged; exact CSS/SCSS labels and open authorities arrive in checkpoint 3.

## Honest Fidelity Contract

Rules includes accessible author styles, inline style, applicable group contexts, inherited author rules, and root-scoped styles for open shadow trees when exposed. It reports inaccessible stylesheets and truncation. It does not claim to expose user-agent/user origins, closed shadow roots, cross-origin frames, commented/disabled declarations absent from CSSOM, or cascade facts that cannot be proven from available APIs. Unsupported cascade layers, `@scope`, `:host`/`::slotted` cases, complex shorthand expansion, container state, animations/transitions, or malformed selectors produce `unknown`, not a false strikethrough. `winning-known-author` means only the highest-precedence declaration among the complete known author subset; it is not a claim about hidden origins or the final animated value.

### Task 1: Define The Neutral Matched-Style Contract

**Files:**
- Modify: `packages/devtools-elements-ui/src/contracts.ts`
- Modify: `packages/devtools-elements-ui/src/elementsInspectorView.ts`
- Modify: `packages/devtools-elements-ui/src/index.ts`
- Modify: `packages/devtools-elements-ui/package.json`
- Modify: `packages/devtools-elements-ui/test/fixtures/elementsSession.ts`
- Create: `packages/devtools-elements-ui/test/matchedStylesContract.test.ts`
- Create: `packages/devtools-elements-ui/test/matchedStylesContract.types.ts`
- Create: `packages/devtools-elements-ui/test/types.tsconfig.json`

- [ ] **Step 1: Add failing immutable-contract tests**

Introduce these public neutral shapes with readonly arrays and no DOM/CSSOM objects:

```ts
export type DeclarationState =
  | "winning-known-author"
  | "overridden-known-author"
  | "inactive"
  | "unknown";

export interface MatchedDeclarationSnapshot {
  readonly declarationRef: string;
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly state: DeclarationState;
  readonly stateReason?: string;
}

export interface RuleContextSnapshot {
  readonly kind:
    | "media"
    | "supports"
    | "layer"
    | "scope"
    | "container"
    | "starting-style"
    | "unknown";
  readonly text: string;
}

export interface MatchedRuleSnapshot {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly declarations: readonly MatchedDeclarationSnapshot[];
  readonly contexts: readonly RuleContextSnapshot[];
  readonly generatedSource?: GeneratedRuleSourceSnapshot;
}

export interface MatchedStylesSnapshot {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly nodeRef: string;
  readonly inlineStyle?: MatchedRuleSnapshot;
  readonly matchedRules: readonly MatchedRuleSnapshot[];
  readonly inherited: readonly InheritedRulesSnapshot[];
  readonly inaccessibleStylesheetCount: number;
  readonly omittedRuleCount: number;
  readonly diagnostics: readonly RulesDiagnosticSnapshot[];
}

export interface RulesDataSource {
  snapshot(): RulesPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  filter(query: string): void;
}
```

The Vitest suite proves runtime immutability and shell transitions `empty -> loading -> ready -> partial -> error` without changing the DOM tree selection. A separate semantic `tsc --noEmit -p test/types.tsconfig.json` fixture uses `@ts-expect-error` to reject mutable arrays and public `CSSStyleRule` values; transpile-only Vitest is not the compile-time gate.

- [ ] **Step 2: Run and confirm red**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/matchedStylesContract.test.ts
corepack pnpm --filter @pin-op/devtools-elements-ui exec tsc --noEmit -p test/types.tsconfig.json
```

Expected: FAIL because the Rules contract does not exist.

- [ ] **Step 3: Implement and export the contract**

Keep source labels public-web-only at this stage: URL basename and generated 1-based position when known. Do not include a workspace URI, local path, or open authority in this package.

- [ ] **Step 4: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/devtools-elements-ui typecheck
git add packages/devtools-elements-ui
git commit -m "feat(rules): define matched styles view contract"
```

### Task 2: Extract One Bounded CSS Rule Walker And Rule Identity Registry

**Files:**
- Create: `packages/browser-extension-core/src/cssRuleWalker.ts`
- Create: `packages/browser-extension-core/src/ruleReferenceRegistry.ts`
- Create: `packages/browser-extension-core/test/cssRuleWalker.test.ts`
- Create: `packages/browser-extension-core/test/ruleReferenceRegistry.test.ts`
- Modify: `packages/browser-extension-core/src/collectCssFacts.ts`
- Modify: `packages/browser-extension-core/test/collectCssFacts.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`
- Modify: `packages/browser-extension-core/test/public-export.mjs`

- [ ] **Step 1: Characterize the current walker before extraction**

Add tests for inline/external sheets, `@import`, nested grouping rules, ordered typed media/supports ancestry, explicit layer/scope/container/starting-style/unknown contexts, cycles, inaccessible `cssRules`, invalid rules, query-string URLs, adopted sheets when exposed, rule/declaration/context limits, and deterministic numeric `rulePath`. Existing `collectCssFacts` output must be captured as the regression oracle.

- [ ] **Step 2: Add failing rule identity tests**

Use an epoch/revision-scoped registry contract:

```ts
const first = registry.reference(sheetIdentity, "0.2.1", nativeRule);
const again = registry.reference(sheetIdentity, "0.2.1", nativeRule);
expect(again).toBe(first);

registry.reset({ documentEpoch: 2, stylesheetRevision: 0 });
expect(registry.has(first)).toBe(false);
```

Assert different sheets with the same selector never collide; all declarations from one native rule share one `ruleRef`; IDs are bounded opaque tokens; stale generations cannot resolve; native objects never cross the registry boundary.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/cssRuleWalker.test.ts test/ruleReferenceRegistry.test.ts test/collectCssFacts.test.ts
```

Expected: FAIL because the common walker and registry are absent.

- [ ] **Step 4: Extract without changing fact behavior**

`cssRuleWalker.ts` owns traversal, cycle detection, group context, stylesheet order, rule paths, truncation, and inaccessible accounting. It yields internal records rather than protocol facts. Refactor `collectCssFacts` into a projection over those records; do not maintain two walkers.

- [ ] **Step 5: Implement scoped `ruleRef` identity**

Bind a registry instance to `{contentSessionId, documentEpoch, stylesheetRevision}`. Use generated random opaque IDs, not selector hashes or URLs. Reset on navigation, frame destruction, stylesheet revision, content lease loss, and disposal.

- [ ] **Step 6: Verify regression and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/cssRuleWalker.test.ts test/ruleReferenceRegistry.test.ts test/collectCssFacts.test.ts
git add packages/browser-extension-core
git commit -m "refactor(rules): share bounded css rule walk"
```

### Task 3: Build The Scoped Stylesheet Registry And Revision Fingerprint

**Files:**
- Create: `packages/browser-extension-core/src/stylesheetRegistry.ts`
- Create: `packages/browser-extension-core/src/stylesheetFingerprint.ts`
- Create: `packages/browser-extension-core/src/matchedStylesApplicabilityObserver.ts`
- Create: `packages/browser-extension-core/test/stylesheetRegistry.test.ts`
- Create: `packages/browser-extension-core/test/stylesheetFingerprint.test.ts`
- Create: `packages/browser-extension-core/test/matchedStylesApplicabilityObserver.test.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/src/contentScriptRuntime.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/package.json`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing scoped-registry tests**

Fix these internal limits in `stylesheetRegistry.ts`:

```ts
export const STYLESHEET_LIMITS = Object.freeze({
  scopeSheetPairsPerSession: 256,
  uniqueSheetObjectsPerSession: 256,
  rulesVisitedPerSessionSnapshot: 4096,
  declarationsPerRule: 128,
  inlineTextBytesPerSheet: 512 * 1024,
  inlineTextBytesPerSession: 2 * 1024 * 1024,
  scopesPerSession: 64,
  fingerprintCssTextBytesPerPass: 2 * 1024 * 1024,
  fingerprintTimeBudgetMs: 12,
  fingerprintIntervalTargetMs: 1000,
});
```

All limits above are global to one active content session, not multiplied by root count. Inventory each sheet as the pair `(DocumentOrShadowRoot scope, CSSStyleSheet object)`, never by URL alone. Test document sheets, `<style>/<link>` inside open shadow roots, document/shadow `adoptedStyleSheets`, one constructed sheet adopted into multiple roots, imports, duplicate URLs, same-origin frames as distinct document scopes, per-scope order, DOM insertion/removal, `CSSStyleSheet.disabled`, `sheet.media.mediaText`, bounded owner `<style>/<link>` applicability attributes (`media`, `disabled`, `rel`, `href`, and `title`/alternate state where exposed), inaccessible `cssRules`, closed roots, malformed inline text, parser/time/byte truncation, and revision invalidation. A document sheet must never be considered applicable to a shadow-tree element merely because `Element.matches(selector)` returns true.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesheetRegistry.test.ts test/stylesheetFingerprint.test.ts test/matchedStylesApplicabilityObserver.test.ts
```

Expected: FAIL because the scoped registry/fingerprint do not exist.

- [ ] **Step 3: Implement accessible, scope-bound CSSOM inventory**

The registry reads `document.styleSheets`, stylesheet owners inside each open shadow root, accessible `cssRules`, imports, and available adopted sheets. It records the exact owning scope for every traversal and filters candidates to the selected element's document/shadow scope before selector matching. For shared adopted sheets, identity is `(scopeRef, sheet object)` and source order is local to that root.

Parse only bounded inline `<style>` owner text in the browser. Attach a generated range only when a fail-closed CSSOM-to-AST walk matches every ancestor path component by rule type, grouping context, normalized selector, and direct declaration evidence. Comments do not consume CSSOM indices; invalid/dropped/duplicate ambiguity yields no range. External sheets retain public `sourceUrl` and numeric `rulePath` but no invented browser line/column; checkpoint 3 resolves those against the exact workspace CSS AST.

Declare `postcss` and `postcss-selector-parser` as explicit production dependencies of `@pin-op/browser-extension-core`; do not rely on root dev dependencies being bundled accidentally.

- [ ] **Step 4: Implement observable revision plus bounded resnapshot**

There is no standard CSSOM mutation event. Combine DOM observation for style/link/root changes, explicit Pin-op refresh invalidation, a fingerprint check at the start of every matched query, and a bounded fingerprint poll only while the Inspector content lease is active. Compute one structural digest per unique `CSSStyleSheet` object per pass, including its disabled/media applicability, and combine it with cheap per-root adoption/order/owner-state digests, so a shared constructed sheet is not rehashed for every root. Rotate a deterministic scan cursor after a byte/rule/time truncation and report partial coverage. The interval is a 1000 ms target; background-tab timer throttling can delay it, so documentation must not promise wall-clock detection within one second. On change, advance `stylesheetRevision` plus aggregate `stylesRevision` and notify the session. Stop timers on lease loss/navigation/dispose. Pin-op-owned preview mounts are excluded; checkpoint 4 advances pseudo-state plus aggregate styles revision, never stylesheet revision.

CSS text/order is not the only source of Rules changes. `MatchedStylesApplicabilityObserver` coalesces selected-scope invalidation on relevant subtree/attribute mutations (covering sibling combinators, `:nth-*`, and `:has()`), `slotchange`, captured pointer/focus state changes, viewport resize, and `MediaQueryList` changes for encountered media conditions. It observes events only and never dispatches them. On every explicit query and the same bounded rotating active-session poll, compute an applicability digest from matching selector indices and group applicability for the selected element plus its bounded composed ancestor chain. This catches eventless JS property/state changes such as `checked`, `indeterminate`, validity, placeholder state, and custom `:state()` when the engine exposes them through `Element.matches`. Truncated applicability scans are partial and rotate forward; manual refresh remains the deterministic fallback under timer throttling. Maintain a separate monotonic `stylesRevision` for every matched-result invalidation: a real sheet change advances both `stylesheetRevision` and `stylesRevision`, while applicability-only change advances only `stylesRevision`, preserving stable `ruleRef` identity. Requery under the same document/selection/stylesheet fence; unsupported container/scope semantics stay `unknown`. Test eventless form/custom-state changes, listener/timer teardown, and browser-throttling/manual-refresh fallback.

- [ ] **Step 5: Preserve the no-network security contract**

Do not add stylesheet `fetch`, XHR, background URL proxying, CSP expansion, or host permission. Extend `browserExtensionContract.ts` to keep rejecting packaged network fetch code. Inaccessible external CSS stays partial; exact CSS/SCSS ranges remain IDE-owned.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesheetRegistry.test.ts test/stylesheetFingerprint.test.ts test/matchedStylesApplicabilityObserver.test.ts test/pageInspectionSession.test.ts test/contentScriptRuntime.test.ts
```

Expected: PASS; inaccessible/oversized sheets degrade to bounded diagnostics, synchronous query checks see current state, and fake-clock polling/applicability signals converge without claiming a real-browser wall-clock bound.

```powershell
git add packages/browser-extension-core extensions/test/browserExtensionContract.ts pnpm-lock.yaml
git commit -m "feat(rules): inventory bounded author stylesheets"
```

### Task 4: Collect Matched Styles And Classify The Cascade Conservatively

**Files:**
- Create: `packages/browser-extension-core/src/matchedStylesTypes.ts`
- Create: `packages/browser-extension-core/src/matchedStylesCollector.ts`
- Create: `packages/browser-extension-core/src/cascadeClassifier.ts`
- Create: `packages/browser-extension-core/src/matchedStylesProjection.ts`
- Create: `packages/browser-extension-core/test/matchedStylesCollector.test.ts`
- Create: `packages/browser-extension-core/test/cascadeClassifier.test.ts`
- Create: `packages/browser-extension-core/test/matchedStylesProjection.test.ts`
- Modify: `packages/browser-extension-core/src/collectCssFacts.ts`
- Modify: `packages/browser-extension-core/src/inspectPayload.ts`
- Modify: `packages/browser-extension-core/test/collectCssFacts.test.ts`
- Modify: `packages/browser-extension-core/test/inspectPayload.test.ts`

- [ ] **Step 1: Add failing matched-style fixtures**

Cover:

- inline declarations;
- selector lists and exact `matchingSelectorIndices`;
- specificity and source order;
- `!important` versus normal declarations;
- winning-known-author, inactive media, and supports contexts;
- nested contexts and imports;
- custom properties;
- inherited rules for multiple ancestors;
- duplicate selectors in different sheets;
- inaccessible/truncated sheets;
- invalid selectors and hostile `matches()`;
- layer/scope/container/shorthand cases that must remain `unknown`.

Use a fixed result shape keyed by `{documentEpoch, selectionRevision, stylesRevision, stylesheetRevision, nodeRef}` and verify frozen output.

- [ ] **Step 2: Add failing conservative-cascade tests**

```ts
expect(classify(simpleLowerSpecificity)).toEqual({
  state: "overridden-known-author",
  reason: "lower-precedence-author-declaration",
});
expect(classify(insideUnknownLayer)).toEqual({
  state: "unknown",
  reason: "unsupported-cascade-layer",
});
```

Never infer `overridden-known-author` merely because a declaration differs from computed style; prove that it loses to another known author declaration. `winning-known-author` is the winner only inside that known subset. Variables, animation, transitions, shorthand expansion, inheritance, and unsupported origins make stronger claims unsafe.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/matchedStylesCollector.test.ts test/cascadeClassifier.test.ts test/matchedStylesProjection.test.ts
```

Expected: FAIL because the matched authority does not exist.

- [ ] **Step 4: Implement one selected-node collection**

Resolve the selected node from `DomTreeProvider`, walk only it and a maximum of 32 composed ancestors, filter rules by their exact document/open-shadow scope before using parsed selector lists plus `Element.matches`, retain group contexts, and attach one shared `ruleRef`. Treat `:host`, `::slotted`, unsupported nesting/scope, and cross-root uncertainty as partial/unknown. Collection and inspect-fact projection stay synchronous over the current accessible CSSOM snapshot; there is no network read to block selection publication. Check selection/document/revision authority before publication.

- [ ] **Step 5: Replace fact collection with a projection**

`matchedStylesProjection.ts` produces current `CssRuleFact[]` from the exact same matched-rule records. Preserve existing v6 shape in this checkpoint, storing `ruleRef`, importance, source URL, media, and rule path in bounded metadata until protocol v7 types them in checkpoint 3. Delete the old independent fact walk once regression tests pass.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/matchedStylesCollector.test.ts test/cascadeClassifier.test.ts test/matchedStylesProjection.test.ts test/collectCssFacts.test.ts test/inspectPayload.test.ts
git add packages/browser-extension-core
git commit -m "feat(rules): collect matched author styles"
```

### Task 5: Route Matched Styles Through A Strict Local Protocol

**Files:**
- Create: `packages/browser-extension-core/src/stylesProtocol.ts`
- Create: `packages/browser-extension-core/src/matchedStylesModel.ts`
- Create: `packages/browser-extension-core/test/stylesProtocol.test.ts`
- Create: `packages/browser-extension-core/test/matchedStylesModel.test.ts`
- Modify: `packages/browser-extension-core/src/inspectPortProtocol.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/src/contentScriptRuntime.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/src/panelSessionTransport.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/test/inspectPort.test.ts`
- Modify: `packages/browser-extension-core/test/inspectPortProtocol.types.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`

- [ ] **Step 1: Add failing strict schema/correlation tests**

Define:

```ts
interface StylesGetMatchedRequest {
  readonly type: "styles.getMatched";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
}

interface StylesMatchedResponse {
  readonly type: "styles.matched";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly styles: MatchedStylesSnapshot;
}
```

Also define `styles.invalidated {documentEpoch,stylesRevision,stylesheetRevision}` as a content-to-panel event and `styles.error` with `invalid-request | stale-document | stale-selection | unknown-node | inaccessible | cancelled | internal-error`. Fix a 512 KiB serialized response ceiling and bounded nested arrays/strings. Test strict keys, monotonic revision pairs, hostile getters/proxies, mismatched echoed identities, request-ID rewrite, stale port replies, coalesced fingerprint/applicability invalidations, cancellation, lease loss, new selection, navigation, and disposal.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesProtocol.test.ts test/matchedStylesModel.test.ts test/panelInspectTransport.test.ts test/backgroundRouter.test.ts
```

Expected: FAIL because `styles.*` routing and model are absent.

- [ ] **Step 3: Implement bottom-up routing**

Parse in the content script, resolve/collect inside `PageInspectionSession`, carry queries and `styles.invalidated` through the trusted tab session, rewrite panel request IDs exactly as DOM queries do, and validate every response/event identity before resolving. A coalesced ready snapshot whose fact/evidence fingerprint changed also renews the existing current-selection inspect publication through a dedicated strict internal event, producing a new inspect ID without changing `selectionRevision`; this keeps IDE Highlight and later Rules origins correlated. It must not be confused with a new user selection. Replace the DOM-named internal allowlist helpers with a closed union of exact `dom.*` and `styles.*` types; do not accept arbitrary message types.

- [ ] **Step 4: Implement model lifecycle**

`MatchedStylesModel` states are `idle | loading | ready | partial | error`. Its key is `{documentEpoch,nodeRef,selectionRevision,stylesRevision,stylesheetRevision}` plus a local generation fence. It works while the IDE is disconnected. A strictly newer same-document `styles.invalidated` triggers one coalesced reload for the current selection; an applicability-only revision does not reset the stylesheet registry or `ruleRef`. Reset it on advanced selection, recovery, inspect-port invalidation, navigation, content lease replacement, compatibility failure, and disposal.

- [ ] **Step 5: Verify local transport**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/stylesProtocol.test.ts test/matchedStylesModel.test.ts test/pageInspectionSession.test.ts test/contentScriptRuntime.test.ts test/panelInspectTransport.test.ts test/panelSessionTransport.test.ts test/backgroundRouter.test.ts test/inspectorPanelRuntime.test.ts
```

Expected: PASS; Rules works without a linked IDE and stale results never repaint.

- [ ] **Step 6: Commit the local protocol**

```powershell
git add packages/browser-extension-core
git commit -m "feat(rules): route matched styles to inspector"
```

### Task 6: Port And Mount The Chromium-Derived Read-Only Rules Renderer

**Files:**
- Create: `packages/devtools-elements-ui/src/chromium/rules/StylesSidebarPane.ts`
- Create: `packages/devtools-elements-ui/src/chromium/rules/StylePropertiesSection.ts`
- Create: `packages/devtools-elements-ui/src/chromium/rules/StylePropertyTreeElement.ts`
- Create: `packages/devtools-elements-ui/src/chromium/rules/PropertyRenderer.ts`
- Create: `packages/devtools-elements-ui/src/chromium/rules/StylePropertyUtils.ts`
- Create: `packages/devtools-elements-ui/test/stylesSidebarPane.test.ts`
- Modify: `packages/devtools-elements-ui/src/elementsInspectorView.ts`
- Modify: `packages/devtools-elements-ui/assets/devtools-elements.css`
- Modify: `third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md`
- Modify: `third_party/chromium-devtools-frontend/UPSTREAM.json`
- Modify: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Modify: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`

- [ ] **Step 1: Add failing Rules renderer tests**

Render fixture sections in this order: inline, matched author rules, inherited groups. Assert selector highlighting, declarations, `!important`, media/group context, generated public origin label, overridden strikethrough, unknown diagnostic styling, inaccessible/truncated notice, filtering, keyboard/focus behavior, and safe page strings.

Assert complete read-only behavior:

- no declaration checkbox;
- no Add Rule button;
- no editable selector/property/value;
- no context menu mutation item;
- no color/value editing popover;
- no keyboard shortcut that writes;
- origin is plain text until `SourceLinkDelegate` receives an authority in checkpoint 3.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui exec vitest run test/stylesSidebarPane.test.ts
```

Expected: FAIL because the derived Rules renderer is absent.

- [ ] **Step 3: Derive the five Rules modules**

Retain upstream headers and record the upstream-to-local mapping. Replace SDK `CSSMatchedStyles`, `CSSProperty`, Linkifier, context menu, popover, metrics, and editing dependencies with `RulesDataSource`, immutable snapshots, safe token renderers, and `SourceLinkDelegate`. Remove edit branches structurally.

- [ ] **Step 4: Derive and scope Rules CSS**

Use only required rules from the three pinned upstream stylesheets. Prefix them with `.pin-op-elements-inspector`; support narrow panels and theme variables. A declaration receives strikethrough only for `state: "overridden-known-author"`; `winning-known-author` renders normally with an honest tooltip, and `unknown` has a separate muted marker/title.

- [ ] **Step 5: Mount the model into the Inspector runtime**

Bind `MatchedStylesModel` to the selected DOM node and pass it through a small adapter implementing `RulesDataSource`. Rules selection must not require bridge resolution. Keep the hidden future sidebar-extension mount and all existing Pin-op toolbar controls operational; do not expose Source in this milestone.

- [ ] **Step 6: Verify UI and commit**

```powershell
corepack pnpm vendor:chromium-elements:record-derived
corepack pnpm vendor:chromium-elements:check-complete
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/browser-extension-core test
git add packages/devtools-elements-ui packages/browser-extension-core third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md third_party/chromium-devtools-frontend/UPSTREAM.json
git commit -m "feat(rules): render chromium-derived read-only rules"
```

### Task 7: Add Cross-Browser Fixtures And Package Regression

**Files:**
- Modify: `examples/basic-css/index.html`
- Modify: `examples/basic-css/dist/app.css`
- Modify: `examples/basic-css/dist/app.css.map`
- Modify: `examples/basic-css/src/card.scss`
- Modify: `examples/basic-css/src/layout.scss`
- Modify: `tools/simulator/test/exampleFixtureServer.test.ts`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `extensions/chrome/test/adapter.test.ts`
- Modify: `extensions/chrome/test/panelAssets.test.ts`
- Modify: `extensions/firefox/test/adapter.test.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/chrome/THIRD_PARTY_NOTICES`
- Modify: `extensions/firefox/THIRD_PARTY_NOTICES`
- Modify: `tools/browser-package-contract.mjs`
- Modify: `tools/smoke-packaged-chrome.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/installed-verification.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Add deterministic fixture expectations**

Include competing specificity, important override, inline style, inherited property, inactive media/supports, nested group, duplicate selector, accessible same-origin frame, open shadow root, document/shadow adopted sheets, one constructed sheet shared across roots, selector-applicability mutations, and an intentionally inaccessible sheet. Add package markers for `styles.getMatched`, read-only Rules, and scoped Chromium CSS.

- [ ] **Step 2: Run targeted red checks**

```powershell
corepack pnpm --filter @pin-op/simulator exec vitest run test/exampleFixtureServer.test.ts
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
```

Expected: fixture/package assertions fail until updated.

- [ ] **Step 3: Update installed verification truthfully**

Regenerate notices for the new PostCSS runtime dependencies. The existing packaged Chrome smoke can assert fixture/runtime facts and package markers only; it cannot drive a DevTools extension panel. Build and load unpacked Chrome and Firefox with `PIN_OP_PANEL_VARIANT=inspector` for this checkpoint; ordinary/store artifacts remain on the legacy default until checkpoint 4. Record DOM/Rules UI behavior in installed manual verification unless a separate panel E2E harness is added. Firefox uses the same shared contract plus manual installed verification; do not claim automated native Firefox runtime coverage if no geckodriver/BiDi harness exists.

- [ ] **Step 4: Run the checkpoint suite**

```powershell
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Expected: PASS. Manually compare Chrome and Firefox Rules rows for document/open-shadow adopted sheets, a shared constructed sheet, media/viewport changes, focus/pointer applicability, sibling/slot mutations, `insertRule`/`deleteRule`/`replaceSync`, throttled-tab/manual-refresh behavior, and known inaccessible/unknown cases. Include two explicit eventless matrices: (1) toggle `CSSStyleSheet.disabled` and mutate its `MediaList` without a DOM mutation, then verify both `stylesheetRevision` and aggregate `stylesRevision` advance; (2) programmatically change supported `checked`, `indeterminate`, `value`/validity/placeholder, and `ElementInternals.states` cases without dispatching an event or changing an attribute, then verify the bounded applicability poll advances only `stylesRevision` and preserves `ruleRef`. In a browser-throttled background tab, record that observation may be delayed and prove manual Refresh is the deterministic fallback.

- [ ] **Step 5: Commit the Rules checkpoint**

```powershell
git add examples tools extensions docs
git commit -m "test(rules): verify shared browser rules backend"
```

## Checkpoint Exit Criteria

- Chrome and Firefox use the same read-only Rules renderer and CSSOM backend.
- Rules and IDE inspection facts originate from one `MatchedStyles` authority and share `ruleRef` internally.
- Inline, matched, inherited, winning-known-author, overridden-known-author, inactive, and explicitly unknown declarations render correctly for supported cases.
- No DOM/CSS writing operation exists.
- Inaccessible and unsupported data is visibly partial, bounded, and non-fatal.
- Rules works without the IDE; generated origin labels are not yet clickable.
