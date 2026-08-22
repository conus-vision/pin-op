# Exact Rules CSS And SCSS Source Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every resolvable Rules origin update automatically to an exact workspace CSS or source-mapped SCSS label and open the exact block in the IDE on explicit click, with no browser-visible local path and no heuristic SCSS claim.

**Architecture:** Protocol v7 adds bounded generated rule evidence to `inspect`, automatic IDE-to-browser `rules.sources`, and browser-to-IDE `rules.open`. Rules source publication has its own monotonically increasing `rulesGeneration`, independent of active-editor `resolutionGeneration`. The IDE resolves batches with workspace-bound ASTs and source maps, owns opaque current-generation open authorities, and revalidates workspace generation plus CSS/map/source hashes, target version/range, and host document identity around editor showing. The bridge stores only route-local rule references and opaque authority IDs.

**Tech Stack:** TypeScript, Zod, WebSocket bridge, VS Code Extension API, PostCSS CSS/SCSS ASTs, source-map 0.7, pnpm, Vitest, WebExtensions.

---

## Source Of Truth And Dependencies

Use `docs/superpowers/specs/2026-08-22-chromium-inspector-port-design.md`. Complete both `2026-08-22-chromium-inspector-shell-dom.md` and `2026-08-22-read-only-rules.md` first.

Before starting Task 1, verify those prerequisite commits are merged and that their new `matchedStylesProjection.ts`, `inspectorPanelRuntime.ts`, and Chromium-derived Rules package paths exist. The paths below intentionally target that post-checkpoint repository, not today's pre-port tree.

Protocol v7 atomically replaces v6. There is no v6 compatibility mode. Existing `source.matches`, `source.open`, and active-editor Source semantics remain separate and unchanged.

## Fixed Wire Security Contract

The browser may receive only:

- `ruleRef` values it originally issued for the current inspect;
- a sanitized public label such as `card.scss`;
- language ID, 1-based line/column, and confidence;
- an opaque `openAuthorityId`.

It must never receive workspace URI, absolute/relative local path, full range, source-map path, document version, or a caller-supplied editor command. `rules.open` contains no `ruleRef`, URL, path, line, column, range, or command.

Browser-to-IDE inspect evidence may carry only a normalized absolute `http:` or `https:` stylesheet URL. Localhost and private-network HTTP(S) origins remain valid for development, but credentials, fragments, controls/bidi characters, relative URLs, filesystem/UNC/drive paths, and every other scheme are forbidden. A browser producer resolves a relative stylesheet `href` against the inspected document, rejects credentials/fragments rather than rewriting them, canonicalizes the URL, and emits `generatedSource` only when it passes that exact schema; otherwise the rule remains visible but unresolved.

### Task 1: Cut Protocol V7 Atomically Across Every Inspect Producer

**Files:**
- Create: `packages/protocol/test/rulesSources.test.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/limits.ts`
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/compatibility.test.ts`
- Modify: `packages/protocol/test/sourcePresentation.test.ts`
- Modify: `packages/protocol/test/public-types.ts`
- Modify: `packages/protocol/test/public-export.mjs`
- Modify: `packages/browser-extension-core/src/matchedStylesProjection.ts`
- Modify: `packages/browser-extension-core/src/collectCssFacts.ts`
- Modify: `packages/browser-extension-core/src/inspectPayload.ts`
- Modify: `packages/browser-extension-core/src/bridgeClient.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Modify: `packages/browser-extension-core/test/matchedStylesProjection.test.ts`
- Modify: `packages/browser-extension-core/test/collectCssFacts.test.ts`
- Modify: `packages/browser-extension-core/test/inspectPayload.test.ts`
- Modify: `packages/browser-extension-core/test/bridgeClient.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeView.test.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`
- Modify: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/windowWorkflow.test.ts`
- Rename: `packages/bridge/test/protocolV6Routing.test.ts` -> `packages/bridge/test/protocolV7Routing.test.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `packages/bridge/test/server.test.ts`
- Modify: `extensions/vscode/test/activeEditorCoordinator.test.ts`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`
- Modify: `extensions/vscode/test/diagnostics.test.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`
- Modify: `extensions/vscode/test/selectionStore.test.ts`
- Rename: `tools/simulator/test/protocolV6Routing.test.ts` -> `tools/simulator/test/protocolV7Routing.test.ts`
- Modify: `tools/simulator/src/sendInspect.ts`
- Modify: `tools/simulator/test/sendInspect.test.ts`
- Modify: `tools/simulator/README.md`
- Modify: `extensions/vscode/smoke-installed-vsix.mjs`
- Modify: `extensions/vscode/test/packageBuild.test.ts`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `tools/test/runtime-metadata.test.mjs`
- Modify: `tools/test/installed-verification-doc.test.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `tools/test/packaged-vsix-smoke.test.mjs`
- Modify: `tools/test/verify-browser-artifacts.test.mjs`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/protocol.md`
- Modify: `docs/security.md`
- Modify: `docs/installed-verification.md`

- [ ] **Step 1: Add failing v7 schema and production-evidence tests**

Set `PROTOCOL_VERSION = 7`. Add `RulesSources: "rules-sources"` to `ProtocolCapability`. Fix these limits:

```ts
export const RULE_EVIDENCE_LIMITS = Object.freeze({
  rules: 256,
  declarationsPerRule: 32,
  contextsPerRule: 16,
  contextTextLength: 2_048,
  ruleRefLength: 128,
  rulePathLength: 512,
  sourceUrlLength: 2_048,
});

export const RULES_SOURCES_LIMITS = Object.freeze({
  sources: 256,
  unresolvedRules: 256,
  labelLength: 128,
  authorityIdLength: 128,
  line: 10_000_000,
  column: 1_000_000,
});

export const RULES_SOURCES_ENVELOPE_MAX_BYTES = 128 * 1024;
```

Add a top-level `ruleEvidence` object to `InspectMessage` so all displayed direct/inherited Rules can be resolved without changing selected/immediate-parent target semantics:

```ts
interface InspectRuleEvidenceBatch {
  readonly rules: readonly InspectRuleEvidence[];
  readonly omittedRuleCount: number;
}

interface InspectRuleEvidence {
  readonly ruleRef: string;
  readonly selector: string;
  readonly declarations: readonly {
    readonly property: string;
    readonly value: string;
    readonly important: boolean;
    readonly valueTruncated: boolean;
  }[];
  readonly declarationsTruncated: boolean;
  readonly generatedSource?: {
    readonly sourceUrl: string;
    readonly startLine?: number;
    readonly startColumn?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
    readonly rulePath?: string;
    readonly contexts: readonly {
      readonly kind: "media" | "supports";
      readonly conditionText: string;
    }[];
    readonly contextsTruncated: boolean;
    readonly unsupportedGroupContext: boolean;
  };
}
```

Generated positions are 1-based; end positions are end-exclusive. `generatedSource.sourceUrl` uses a dedicated strict `PublicStylesheetUrlSchema`: parse with the platform URL parser, require a canonical absolute `http:`/`https:` URL no longer than `sourceUrlLength`, require empty username/password/hash, and reject C0/C1 controls, bidi controls/isolates, backslashes, and any input whose normalized `href` differs. HTTP(S) localhost/private-IP URLs are intentionally allowed; `file:`, raw POSIX/Windows/UNC paths, relative URLs, `blob:`, `data:`, `chrome-extension:`, `moz-extension:`, `resource:`, `about:`, `javascript:`, userinfo, fragments, and control-character inputs fail. `contexts` is the bounded outer-to-inner ancestry for supported `@media` and `@supports` rules; normalize only syntax trivia, never condition semantics. Any other grouping ancestor sets `unsupportedGroupContext`; count/text overflow sets `contextsTruncated`. Either flag makes source resolution fail closed rather than silently discarding ancestry. When `generatedSource` is present, require either a complete start line/column pair or a valid numeric dotted `rulePath`; end line/column are paired. Inline rules stay in the evidence batch with no `generatedSource` so the bridge can validate their `ruleRef`, while the IDE counts them unresolved and issues no open authority. Require unique `ruleRef` values.

In v7, `InspectRuleEvidence` is the only owner of selector/generated-source/context evidence. Change `CssRuleFact` to `{type,ruleRef,property,value,important,valueTruncated,metadata}` and remove its duplicated selector/source fields. `InspectMessageSchema.superRefine` must require every target CSS fact to reference an included evidence entry and match one exact declaration tuple in it. Budget pruning removes an evidence entry and all referencing facts atomically.

In browser-core tests, require one stable evidence entry per displayed direct/inherited Rules row until the bound, shared `ruleRef` across declarations/facts, inherited evidence without fake selected facts, deterministic 32-declaration truncation, ordered nested media/supports evidence, unsupported/truncated group flags, and no local path. Include two otherwise identical rules under different `@supports` conditions and prove their evidence cannot be interchanged. Test browser-side resolution/canonicalization of a relative CSS `href`, accepted localhost HTTP(S), and omission of `generatedSource` for file URLs, raw POSIX/Windows/UNC paths, blob/data/extension/resource URLs, credentials, fragments, and control/bidi input. Mirror those hostile cases in protocol-schema tests so invalid source URLs cannot cross the wire even if a producer regresses. Exercise the real 768 KiB outer inspect budget: reserve envelope overhead before append, prune an evidence entry plus all referencing facts as one unit, and increment `omittedRuleCount`; the producer must never construct an oversized intermediate message and hope schema parsing repairs it.

- [ ] **Step 2: Specify and test `rules.sources`**

```ts
const sources = {
  protocolVersion: 7,
  type: "rules.sources",
  messageId: "rules-sources-1",
  sessionId: "session-1",
  source: { role: "ide", id: "ide-1" },
  inspectMessageId: "inspect-1",
  rulesGeneration: 1,
  sources: [{
    ruleRef: "rule-1",
    openAuthorityId: "authority-1",
    document: { label: "card.scss", languageId: "scss" },
    startLine: 41,
    startColumn: 3,
    confidence: "sourcemap",
  }],
  unresolvedRuleCount: 0,
  metadata: {},
};
```

Allow `languageId: "css" | "scss"` and `confidence: "exact" | "sourcemap"`. Define a dedicated strict `RulesSourceDocumentSchema`: `label` is 1–128 characters, rejects `/`, `\`, `:`, dot-segments, URI-scheme prefixes, C0/C1 controls, bidi overrides/isolates, and Unicode line separators; `languageId` is the fixed enum. Require unique rule refs and authority IDs, positive 1-based line/column, `unresolvedRuleCount <= RULE_EVIDENCE_LIMITS.rules`, strict keys, count/envelope limits, and IDE source role. Add hostile labels such as `C:\workspace\card.scss`, `file:///tmp/card.scss`, `../card.scss`, and bidi-spoofed names to the failing tests.

- [ ] **Step 3: Specify and test minimal `rules.open`**

```ts
const open = {
  protocolVersion: 7,
  type: "rules.open",
  messageId: "rules-open-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  rulesGeneration: 1,
  openAuthorityId: "authority-1",
  metadata: {},
};
```

Explicitly test that adding `ruleRef`, URI, path, URL, source-map path, line, column, range, or command makes parsing fail.

- [ ] **Step 4: Confirm the red state**

```powershell
corepack pnpm --filter @pin-op/protocol exec vitest run test/rulesSources.test.ts test/schema.test.ts test/compatibility.test.ts test/sourcePresentation.test.ts
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/matchedStylesProjection.test.ts test/collectCssFacts.test.ts test/inspectPayload.test.ts
```

Expected: FAIL because v7 and the new schemas are absent.

- [ ] **Step 5: Implement schemas, deep-readonly transforms, budgets, and exact evidence projection**

Use the existing own-data/UTF-8 budget patterns. Export/use one `PublicStylesheetUrlSchema` at the strict protocol boundary and make the browser projection resolve and sanitize a stylesheet URL before constructing evidence; it must omit the entire `generatedSource` object on failure rather than leak a path-like fallback. `rulesGeneration` uses the same numeric upper bound as resolution generations but is a distinct exported type/schema. Add both messages to `PinOpMessageSchema`.

In the same change, make `MatchedStyles` the production source of both `InspectRuleEvidence` and `CssRuleFact`. Build both projections in one deterministic Rules-row pass under the real outer-envelope budget, reserve fixed message overhead, and append/prune only whole evidence-plus-fact units. The final serialized evidence batch is the sole expected-ref set. Update `InspectPayload` and both browser producers so `ruleEvidence` is never bolted on later. For tests with no CSS facts, use the explicit empty batch `{rules: [], omittedRuleCount: 0}`; any fixture with a CSS fact must carry its exact matching evidence. The simulator must build evidence from the fixture rather than inventing a second selector/source walk.

- [ ] **Step 6: Migrate every compile-time producer and version fixture before committing**

This protocol cut must remain compile-green as one commit. Use both searches and inspect every hit:

```powershell
rg -n 'InspectMessage|InspectMessageSchema|type: "inspect"' packages extensions tools --glob '*.ts' --glob '*.mjs'
rg -n 'protocolVersion[^\n]*6|PROTOCOL_VERSION\s*=\s*6|protocolV6|metadata\.protocolVersion !== 6' . --glob '!docs/superpowers/**'
```

Update every real producer, typed literal, test factory, public type fixture, runtime-metadata assertion, package assertion, and current protocol/installed guide. Rename the bridge and simulator routing suites in this task. Deliberate malformed/old-peer compatibility values may remain only when their test names make that intent explicit. Do not leave a required `ruleEvidence` field for a later commit, and do not blind-replace historical changelog text. `rules-sources` remains dormant and unadvertised by endpoints until their routing/controller tasks are implemented.

- [ ] **Step 7: Run the cross-workspace compile/test gate and commit**

```powershell
corepack pnpm --filter @pin-op/protocol test
corepack pnpm --filter @pin-op/protocol typecheck
corepack pnpm --filter @pin-op/protocol lint
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter @pin-op/bridge test
corepack pnpm --filter pin-op test
corepack pnpm --filter @pin-op/simulator test
corepack pnpm typecheck
corepack pnpm test
git add packages/protocol packages/browser-extension-core packages/bridge extensions tools docs
git commit -m "feat(protocol): cut v7 correlated rule evidence"
```

### Task 2: Enforce Independent Rules Authority In The Bridge

**Files:**
- Modify: `packages/bridge/src/replyRouteRegistry.ts`
- Modify: `packages/bridge/src/router.ts`
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/src/index.ts`
- Modify: `packages/bridge/test/replyRouteRegistry.test.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `packages/bridge/test/server.test.ts`
- Modify: `packages/bridge/test/protocolMismatch.test.ts`

- [ ] **Step 1: Add failing route ownership tests**

An inspect registration records the immutable set of expected rule refs extracted from `inspect.ruleEvidence`. Extend the stored route conceptually as follows:

```ts
interface StoredReplyRoute {
  readonly originConnectionId: string;
  readonly expectedRuleRefs: ReadonlySet<string>;
  ideConnectionId?: string;
  resolutionGeneration?: number;
  resolutionClaimed: boolean;
  excerptMatchIds: Set<string>;
  rulesGeneration?: number;
  ruleOpenAuthorityIds: Set<string>;
}
```

`rulesGeneration` is monotonic only inside this exact inspect route, starts at 1 for a fresh route, and is independent of `resolutionGeneration`; a new inspect ID creates a new route rather than continuing the old counter.

Test:

- `rules.sources` or `resolution` may be the first family to claim the IDE, but the other family must later come from that same IDE;
- a rules generation must strictly increase;
- every published `ruleRef` is unique and in the immutable expected set;
- `sources.length + unresolvedRuleCount === expectedRuleRefs.size`; inspect `omittedRuleCount` is outside this equation;
- re-registering the same `(sessionId, inspectMessageId, originConnectionId)` is idempotent only when the expected-ref set is exactly equal; a different set is a collision;
- a valid publication atomically replaces the authority set only after delivery succeeds;
- an empty publication clears it;
- invalid publication changes nothing;
- resolution/source invalidation does not clear current Rules authority;
- new inspect, route eviction, browser/IDE disconnect, unlink, and mismatch clear both namespaces;
- equal/stale generation, wrong browser, wrong IDE, wrong session, missing capability, foreign authority, and guessed rule refs fail closed.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/protocol build
corepack pnpm --filter @pin-op/bridge exec vitest run test/replyRouteRegistry.test.ts test/protocolV7Routing.test.ts test/protocolMismatch.test.ts
```

Expected: FAIL because the route has only resolution/match authority.

- [ ] **Step 3: Implement atomic registry methods**

Add `prepareRulesSources(...)`, a success-only `commit()` token, `rollback()`, and `authorizeRulesOpen(...)`. Do not reuse `replaceMatchIds` or `resolutionGeneration`. Preparation validates generation, exact completeness, expected refs, IDE ownership, and the proposed authority set without mutating the route. Only a successful browser send commits; send failure/throw rolls back and preserves the prior generation/allowlist. `rules.open` authority is reusable for repeated explicit clicks while its current generation remains valid; authorization does not consume it.

- [ ] **Step 4: Route both message families with capabilities**

`rules.sources`: authoritative IDE -> exact originating browser/simulator, only when both endpoints advertise `rules-sources`. Reject the whole message when `sources.length + unresolvedRuleCount` differs from the registered expected-ref count, even if every supplied ref is a valid subset.

`rules.open`: exact originating browser/simulator -> the route-owning IDE, only when inspect ID, strict generation, and allowlisted authority all match.

- [ ] **Step 5: Run bridge verification and commit**

```powershell
corepack pnpm --filter @pin-op/bridge test
corepack pnpm --filter @pin-op/bridge typecheck
corepack pnpm --filter @pin-op/bridge lint
git add packages/bridge
git commit -m "feat(bridge): secure rules source routing"
```

### Task 3: Fence Complete Rule Evidence Across Browser Correlation

**Files:**
- Modify: `packages/browser-extension-core/src/inspectCorrelationStore.ts`
- Modify: `packages/browser-extension-core/test/inspectCorrelationStore.test.ts`
- Modify: `packages/browser-extension-core/test/inspectCorrelationStore.types.ts`
- Modify: `packages/browser-extension-core/test/panelDiagnostics.test.ts`

- [ ] **Step 1: Add failing correlation namespace/lifecycle tests**

For each accepted inspect, assert:

- the store snapshots the exact immutable ref set from the already serialized `ruleEvidence` batch;
- Source resolution and Rules generations/authority brands cannot be interchanged at compile time;
- same-selection styles-correlation renewal creates a new inspect route and invalidates old Rules authority without changing selection identity;
- active-editor Source resolution and `source.navigate` leave Rules authority current;
- selection, stylesheet/page refresh, document/frame navigation, disconnect, mismatch, and dispose revoke it.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/inspectCorrelationStore.test.ts test/panelDiagnostics.test.ts
```

Expected: FAIL because correlation storage does not yet own expected rule refs or an independent Rules namespace.

- [ ] **Step 3: Track expected refs and independent generations**

`InspectCorrelationStore` records the immutable expected refs from the final serialized evidence batch for each current inspect plus separate Source and Rules revisions. Add branded `RulesOpenAuthority` methods that cannot be passed to Source navigation APIs. New active-editor Source resolution and `source.navigate` must not revoke Rules. A new inspect/selection, stylesheet or page refresh, document/frame navigation (`documentEpoch` change), disconnect, mismatch, or disposal must revoke them.

- [ ] **Step 4: Update bounded diagnostics and renewal lifecycle**

Expose only counts/reasons in panel diagnostics, never refs or authorities. Wire same-selection styles renewals through the existing correlation owner so an older asynchronous IDE publication cannot repaint a newer Rules snapshot.

- [ ] **Step 5: Verify and commit**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/inspectCorrelationStore.test.ts test/panelDiagnostics.test.ts
git add packages/browser-extension-core
git commit -m "feat(rules): publish correlated rule evidence"
```

### Task 4: Resolve Exact CSS And SCSS Blocks In The IDE

**Files:**
- Create: `extensions/vscode/src/rules/rulesSourceResolver.ts`
- Create: `extensions/vscode/test/rulesSourceResolver.test.ts`
- Modify: `extensions/vscode/src/sourcePlugins/cssFacts.ts`
- Modify: `extensions/vscode/src/sourcePlugins/declarationFingerprint.ts`
- Modify: `extensions/vscode/src/sourcePlugins/sourceWorkspace.ts`
- Modify: `extensions/vscode/src/sourcePlugins/sourceMapLoader.ts`
- Modify: `extensions/vscode/src/sourcePlugins/stylesheetAst.ts`
- Modify: `extensions/vscode/src/sourcePresentationMetadata.ts`
- Modify: `extensions/vscode/test/sourceWorkspace.test.ts`
- Modify: `extensions/vscode/test/sourceMapLoader.test.ts`
- Modify: `extensions/vscode/test/stylesheetAst.test.ts`
- Modify: `extensions/vscode/test/declarationFingerprint.test.ts`
- Modify: `extensions/vscode/test/cssSourcePlugin.test.ts`
- Modify: `extensions/vscode/test/scssSourcePlugin.test.ts`

- [ ] **Step 1: Add failing resolver matrix tests**

Test exact generated CSS by position and by numeric rule path; unique complete fingerprint fallback; inline and external source maps; nested SCSS selectors; ordered nested media/supports; duplicate identical rules under different `@supports` conditions; multiple original SCSS files; query strings; `sourceRoot`; embedded `sourcesContent`; CRLF; exact selector-prelude coordinates; and smallest containing SCSS rule. Truncated or unsupported grouping ancestry must be unresolved. Add an adversarial map where the selector start maps to `card.scss` but the first declaration maps to `mixins.scss`; the origin must be `card.scss`, never the first mapping in the declaration body.

Test fail-closed outcomes for missing/invalid/unmapped map, no mapping exactly at the generated selector start, contradictory mappings within the selector prelude, ambiguous generated file, `unique-basename`, outside-workspace source, changed CSS, incomplete/truncated declaration fingerprint, mixin-generated declarations that cannot be verified in one original rule, multiple matching rules, missing source, parse error, invalid range, cancellation, and stale input. A positional/rule-path mismatch recovered only through a unique fingerprint may receive a verified CSS result but is never eligible for an SCSS claim.

Expected policy:

```ts
expect(await resolver.resolve(validMappedRule)).toMatchObject({
  languageId: "scss",
  confidence: "sourcemap",
  label: "card.scss",
});
expect(await resolver.resolve(invalidMapRule)).toMatchObject({
  languageId: "css",
  confidence: "exact",
  label: "app.css",
});
expect(await resolver.resolve(uniqueBasenameOnly)).toEqual({
  kind: "unresolved",
  reason: "non-exact-workspace-match",
});
```

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter pin-op exec vitest run test/rulesSourceResolver.test.ts test/sourceWorkspace.test.ts test/sourceMapLoader.test.ts test/stylesheetAst.test.ts
```

Expected: FAIL because batch Rules resolution is absent and current plugins are active-document oriented.

- [ ] **Step 3: Expose strict reusable AST/workspace helpers**

Reuse `StylesheetAstCache`, exact rule-path lookup, unique fingerprint lookup, `SourceMapLoader`, and `smallestContainingRule`. Extend the generated stylesheet AST rule record with an exact half-open selector-prelude range separate from the declaration/body range. Add an explicit helper that accepts only `status: "exact"`, exactly one URI, and `isWorkspaceUri(uri) === true`; never use `unique-basename` for Rules open.

Do not turn this into a SourcePlugin. The existing plugin contract remains active-document based for Source and future PHP/template providers.

- [ ] **Step 4: Implement bounded batch resolution**

Group by unique `ruleRef`, reject truncated/unsupported grouping evidence, then resolve and verify the exact generated CSS rule first, including selector, complete non-truncated declarations, importance, and the exact ordered typed media/supports ancestry. Each AST ancestor must match kind and condition text in order; rule-path or fingerprint candidates under a different `@supports` block are not exact. Convert protocol 1-based coordinates to the source-map library's 0-based columns explicitly. SCSS is eligible only when a source-map segment exists at the exact generated selector start and every usable mapping inside that half-open selector-prelude range resolves unambiguously to the same canonical original source and smallest containing SCSS rule. Verify that original rule with the existing nested-selector expansion plus the full selector/declaration/context evidence. Never select a declaration-body/mixin mapping as the rule origin.

If positional/rule-path verification failed and only unique-fingerprint relocation found the generated rule, stop at verified generated CSS. A broken, missing, contradictory, or unverifiable map also falls back only to that separately verified generated CSS. If generated CSS itself is not exact, return unresolved and issue no authority.

The result retains document URI/version/full range only inside the IDE. Its public projection contains label, language ID, start line/column, confidence, and rule ref.

- [ ] **Step 5: Run resolver regressions and commit**

```powershell
corepack pnpm --filter pin-op exec vitest run test/rulesSourceResolver.test.ts test/sourceWorkspace.test.ts test/sourceMapLoader.test.ts test/stylesheetAst.test.ts test/cssSourcePlugin.test.ts test/scssSourcePlugin.test.ts
git add extensions/vscode/src/rules extensions/vscode/src/sourcePlugins extensions/vscode/src/sourcePresentationMetadata.ts extensions/vscode/test
git commit -m "feat(vscode): resolve exact rules css and scss blocks"
```

### Task 5: Own Opaque Open Authorities And Safe Editor Switching In The IDE

**Files:**
- Create: `extensions/vscode/src/rules/rulesOpenAuthorityRegistry.ts`
- Create: `extensions/vscode/src/rules/rulesSourcesPublication.ts`
- Create: `extensions/vscode/src/rules/rulesSourceController.ts`
- Create: `extensions/vscode/test/rulesOpenAuthorityRegistry.test.ts`
- Create: `extensions/vscode/test/rulesSourcesPublication.test.ts`
- Create: `extensions/vscode/test/rulesSourceController.test.ts`
- Modify: `extensions/vscode/src/presenter/runtime.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`

- [ ] **Step 1: Add failing registry lifecycle/TOCTOU tests**

Store only inside the IDE:

```ts
interface StoredRuleOpenAuthority {
  readonly openAuthorityId: string;
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly ruleRef: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly range: SourceRange;
  readonly workspaceGeneration: number;
  readonly dependencies: readonly {
    readonly kind: "generated-css" | "external-source-map" | "original-source";
    readonly uri: string;
    readonly documentVersion?: number;
    readonly contentHash: string;
  }[];
}
```

Exact CSS stores its generated CSS dependency; mapped SCSS stores generated CSS, an external source-map dependency when present, and original SCSS. Inline maps are covered by the generated CSS hash. Set registry capacity to exactly `RULES_SOURCES_LIMITS.sources` (256), replace one whole generation atomically, and never evict an authority from the generation that was published; an oversized candidate set fails before send. Test prepared replace/commit/rollback, empty clear, generation monotonicity, full 256-entry capacity, one inspect at a time, reusable current-generation clicks, wrong tuple, workspace removal, target/original edit, generated CSS change, external map change, resolver cancellation, new inspect, stylesheet/page refresh, document navigation, disconnect, and dispose. Active-editor changes and `source.navigate` alone do not revoke Rules.

Add two-step authorize/revalidate tests where a dependency changes while `openTextDocument` awaits (so `showTextDocument` never runs) and while `showTextDocument` awaits (so no cursor/reveal occurs after it returns). Watchers are only eager invalidation: the open path must re-read and re-hash every stored dependency itself.

- [ ] **Step 2: Add failing controller publication tests**

`RulesSourceController` starts on every accepted inspect, resolves the entire bounded batch, increments `rulesGeneration`, and sends exactly one complete `rules.sources` publication, including empty publications. A newer inspect/cancellation makes older async results inert. Active-editor changes alone do not restart it.

`RulesSourcesPublication` preserves the stable `ruleEvidence.rules` order and budgets the real UTF-8 serialized envelope before registry preparation. Use fixed-length UUID authority IDs and the maximum-length placeholder during packing; entries that do not fit are deterministically omitted from the tail and counted unresolved. Prepare authorities only for the final serialized `sources`, retaining the prior active registry snapshot only for the same inspect; beginning a new inspect first clears the older route. Assert `sources.length + unresolvedRuleCount === expectedRuleRefs.size` for every publication. Activate the prepared IDE registry immediately before the local send so a newly delivered browser authority is already recognizable. Restore the prior same-inspect snapshot only if local serialization/socket submission throws or returns failure; a new-inspect/first local failure restores empty state. A local `sent` result proves only that the frame was accepted for IDE-to-bridge transport, not that the bridge delivered it to the browser. There is intentionally no third message family/ack in this milestone: downstream rejection or disconnect can temporarily leave endpoints on different generations, but every mismatch fails closed (old/new clicks are rejected by whichever current allowlist they do not match) and disconnect or a fresh inspect clears/re-resolves the route. Never claim a three-party atomic rollback.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter pin-op exec vitest run test/rulesOpenAuthorityRegistry.test.ts test/rulesSourcesPublication.test.ts test/rulesSourceController.test.ts test/presenterRuntime.test.ts
```

Expected: FAIL because no Rules authority/controller/editor host exists.

- [ ] **Step 4: Extend the presenter host safely**

Add a presenter-owned document adapter that exposes `SourceDocument` fields but has a module-private compile-time brand. The production host retains `adapter -> vscode.TextDocument` in a private `WeakMap`; only `openTextDocument` can create/register an adapter, and `showTextDocument` rejects any object not present in that map:

```ts
declare const presenterDocumentBrand: unique symbol;
export interface PresenterDocumentLike extends SourceDocument {
  readonly [presenterDocumentBrand]: true;
}

openTextDocument(uri: string): Promise<PresenterDocumentLike>;
showTextDocument(document: PresenterDocumentLike): Promise<PresenterEditorLike>;
```

Open sequence is fixed:

1. authorize the opaque tuple;
2. verify the stored URI is still in the workspace;
3. call `openTextDocument` without showing it;
4. re-read/re-hash all dependency URIs and revalidate workspace generation, authority, exact target URI/version, and range;
5. call `showTextDocument`;
6. re-authorize the opaque tuple and again re-read/re-hash every dependency plus workspace generation;
7. verify the returned editor is backed by the same registered document URI/version;
8. set cursor to stored range start and reveal the full stored block.

If a check fails before step 5, do not switch editors. VS Code may already have switched a tab while `showTextDocument` was awaiting; if either post-show dependency/authority check or editor identity check fails, do not set the cursor or reveal, revoke the generation, report the bounded failure, and republish if the inspect is still current. A dependency/workspace-generation failure triggers one complete replacement for the still-current inspect; a foreign/stale inspect or disconnected session invalidates and sends nothing. Do not execute `vscode.commands.executeCommand` from wire input.

- [ ] **Step 5: Wire controller lifecycle**

Feed accepted InspectMessage/clear/disconnect/dispose into `RulesSourceController` independently from `ActiveEditorCoordinator`. Dependency reads prefer the current open-buffer text/version over disk, so unsaved edits invalidate correctly. Wire `onDidChangeTextDocument`, workspace-folder generation, explicit stylesheet/page refresh, and one bounded `createFileSystemWatcher` per workspace folder (filtering events against the current exact dependency-URI set) to revoke/re-resolve changed, created, or deleted closed CSS/SCSS/map dependencies. Watchers are eager hints; click-time double rehash remains authoritative. Explicit open may naturally trigger the existing active-editor Source/Highlight re-resolution after the editor changes.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm --filter pin-op test
git add extensions/vscode
git commit -m "feat(vscode): authorize exact rules file opening"
```

### Task 6: Send `rules.sources` And Receive `rules.open` In The IDE Client

**Files:**
- Create: `extensions/vscode/test/integration/rulesOpen.test.ts`
- Modify: `extensions/vscode/src/bridgeClient.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/esbuild.mjs`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`
- Modify: `extensions/vscode/test/bridgeManager.test.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`
- Modify: `extensions/vscode/test/integration/sourcePluginApi.test.ts`

- [ ] **Step 1: Add failing client/capability tests**

Add `RulesSourcesInput`, `RulesSourcesSender`, and `RulesSourcesClientRouter`. Verify v7 IDE hello advertises `rules-sources`, complete publication serialization, schema rejection, reconnect behavior, and `rules.open` dispatch only while authenticated/current.

- [ ] **Step 2: Confirm red**

```powershell
corepack pnpm --filter pin-op exec vitest run test/bridgeClient.test.ts test/bridgeManager.test.ts test/presenterRuntime.test.ts
```

Expected: FAIL because the IDE client lacks the message families.

- [ ] **Step 3: Wire extension activation/deactivation**

Bind `RulesSourceController` sender to the bridge router and bridge `onRulesOpen` to the presenter runtime. Reconnect republishes only through a fresh valid inspect; it does not resurrect old authorities.

- [ ] **Step 4: Add a real VS Code integration case**

Change `esbuild.mjs` from the single integration `outfile` to deterministic multiple entry points under `dist/test/integration`, so both integration files are bundled and matched by the existing `.vscode-test.mjs` glob. Activate the production Pin-op extension, wait for its managed `BridgeManager` server, execute `pin-op.copyLinkCode`, read and later restore the VS Code clipboard, and perform the normal browser link/auth handshake with a browser-role test WebSocket; do not start a second unrelated bridge. Send `inspect`, await the IDE's `rules.sources`, send only its opaque `rules.open`, and observe `vscode.window.activeTextEditor`. With two workspace CSS/SCSS files, prove a current authority switches to the exact document/cursor/block and a dependency changed before open causes no switch. Keep the deterministic change-during-`showTextDocument` race in the injected-host unit test from Task 5. Capture the wire and assert it contains no local URI/path/range.

- [ ] **Step 5: Verify and commit**

```powershell
corepack pnpm --filter pin-op test
corepack pnpm --filter pin-op typecheck
corepack pnpm --filter pin-op test:integration
git add extensions/vscode
git commit -m "feat(vscode): transport rules source messages"
```

### Task 7: Correlate Rules Sources Through Browser Core And The Rules UI

**Files:**
- Create: `packages/browser-extension-core/src/rulesSourcesController.ts`
- Create: `packages/browser-extension-core/test/rulesSourcesController.test.ts`
- Modify: `packages/browser-extension-core/src/inspectPortProtocol.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/src/panelSessionTransport.ts`
- Modify: `packages/browser-extension-core/src/bridgeClient.ts`
- Modify: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/backgroundRuntime.ts`
- Modify: `packages/browser-extension-core/src/inspectorPanelRuntime.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/test/inspectPort.test.ts`
- Modify: `packages/browser-extension-core/test/inspectPortProtocol.types.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/test/bridgeClient.test.ts`
- Modify: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/inspectorPanelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`
- Modify: `packages/browser-extension-core/test/public-export.mjs`
- Modify: `packages/devtools-elements-ui/src/contracts.ts`
- Modify: `packages/devtools-elements-ui/src/chromium/rules/StylePropertiesSection.ts`
- Modify: `packages/devtools-elements-ui/test/stylesSidebarPane.test.ts`
- Modify: `third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md`
- Modify: `third_party/chromium-devtools-frontend/UPSTREAM.json`

- [ ] **Step 1: Add failing browser controller tests**

`RulesSourcesController` contract:

```ts
controller.beginInspect("inspect-1", new Set(["rule-1"]));
expect(controller.accept(validSources)).toBe("published");
expect(controller.originFor("rule-1")).toMatchObject({
  label: "card.scss",
  startLine: 41,
  clickable: true,
});
controller.open("rule-1");
expect(sent).toEqual({
  type: "pin-op.rules.open",
  inspectMessageId: "inspect-1",
  rulesGeneration: 1,
  openAuthorityId: "authority-1",
});
```

Test foreign rule refs, duplicate refs, `sources.length + unresolvedRuleCount` mismatch, stale/equal generation, wrong inspect, replacement, empty clear, new selection, disconnect, incompatibility, stylesheet/page refresh, document/frame navigation, transport invalidation, and dispose. `source.navigate` and active-editor Source updates do not clear a current Rules origin. Generated fallback origin remains visible but non-clickable when no location is published.

- [ ] **Step 2: Add failing full transport tests**

Define strict internal `pin-op.rules.open`; allow parsed `rules.sources` as a background-to-panel push. Test browser hello capability, exact inspect route, completeness against the controller's immutable expected refs, defensive preflight and postflight authority checks around asynchronous sends, window isolation, stale panel port, IDE replacement, and reconnect.

- [ ] **Step 3: Confirm red**

```powershell
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/rulesSourcesController.test.ts test/bridgeClient.test.ts test/windowConnectionCoordinator.test.ts test/backgroundRouter.test.ts test/panelInspectTransport.test.ts test/inspectorPanelRuntime.test.ts
```

Expected: FAIL because browser routing/controller hooks are absent.

- [ ] **Step 4: Implement bottom-up browser routing**

Add `PanelRulesOpenCommand`, schema parsers, bridge client handlers, coordinator publication, background authorization, panel push handling, and controller lifecycle in that order. Keep Source and Rules authority types/methods separate.

- [ ] **Step 5: Turn the origin into the only click target**

`StylePropertiesSection` receives current origin decoration by `ruleRef`. Render `card.scss:41` as a button/link only when `clickable`; otherwise render generated `app.css` evidence as text. Stop propagation so origin click does not select/toggle a declaration. Disable on pending/stale/incompatible states. Record this derived origin-link adaptation under the existing stable Rules change-record anchor before refreshing its local digest.

- [ ] **Step 6: Verify and commit**

```powershell
corepack pnpm vendor:chromium-elements:record-derived
corepack pnpm vendor:chromium-elements:check-complete
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter @pin-op/browser-extension-core test
git add packages/browser-extension-core packages/devtools-elements-ui third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md third_party/chromium-devtools-frontend/UPSTREAM.json
git commit -m "feat(rules): open exact ide rule origins"
```

### Task 8: Update Packages, Documentation, And Installed Verification

**Files:**
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `extensions/vscode/smoke-installed-vsix.mjs`
- Modify: `extensions/vscode/test/packageBuild.test.ts`
- Modify: `tools/browser-package-contract.mjs`
- Modify: `tools/smoke-packaged-chrome.mjs`
- Modify: `tools/verify-artifacts.mjs`
- Modify: `tools/test/runtime-metadata.test.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `tools/test/packaged-vsix-smoke.test.mjs`
- Modify: `tools/test/verify-browser-artifacts.test.mjs`
- Modify: `tools/test/installed-verification-doc.test.mjs`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `extensions/vscode/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/protocol.md`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/installed-verification.md`
- Modify: `docs/store-listings.md`
- Modify: `docs/release.md`
- Modify: `docs/source-plugin-authoring.md`

- [ ] **Step 1: Add failing v7 artifact and package assertions**

Require every runtime/package marker to report v7 and `rules-sources`, and require the packaged browser/VSIX contracts to contain the strict message schemas and fixed Inspector entrypoints. The existing packaged Chrome smoke controls only a normal page target through CDP; it does not open DevTools or a linked VS Code instance. Keep it to page/package markers, fixture reachability, and absence of local-path data. Do not invent an open acknowledgement that the protocol does not have. Bridge route tests, browser controller/UI tests, and the real VS Code integration from Task 6 own the automated round trip; the installed matrix owns the cross-product UI click.

- [ ] **Step 2: Confirm the artifact/documentation red state**

```powershell
corepack pnpm --filter pin-op exec vitest run test/packageBuild.test.ts
corepack pnpm exec node --test tools/test/runtime-metadata.test.mjs tools/test/packaged-chrome-smoke.test.mjs tools/test/packaged-vsix-smoke.test.mjs tools/test/verify-browser-artifacts.test.mjs tools/test/installed-verification-doc.test.mjs
```

Expected: FAIL on the new capability/package/documentation assertions until this task updates all release inputs.

- [ ] **Step 3: Prove the Task 1 cut left no v6 runtime fixture**

Use:

```powershell
rg -n "protocolVersion[^\n]*6|PROTOCOL_VERSION\s*=\s*6|protocolV6|v6" . --glob "!docs/superpowers/**"
```

Review every hit; permitted results are explicitly historical documentation and clearly named negative compatibility fixtures that intentionally send an old/malformed v6 peer. Any producer, positive fixture, package marker, or current protocol assertion still on v6 is a Task 1 regression and must be fixed before continuing.

- [ ] **Step 4: Update product/security wording**

State precisely: Pin-op remains read-only, but an explicit Rules origin click may switch the IDE editor using a current IDE-issued opaque authority. No workspace URI/path crosses the bridge. Missing/invalid maps show generated CSS only. Existing Source remains active-document and available only in the legacy rollback panel; the new Source tab and PHP/template providers remain future scope.

- [ ] **Step 5: Run the complete pre-archive verification**

```powershell
corepack pnpm --filter @pin-op/protocol test
corepack pnpm --filter @pin-op/bridge test
corepack pnpm --filter pin-op test
corepack pnpm --filter @pin-op/browser-extension-core test
corepack pnpm --filter @pin-op/devtools-elements-ui test
corepack pnpm --filter pin-op-chrome test
corepack pnpm --filter pin-op-firefox test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Expected: all pre-archive tests and builds pass.

- [ ] **Step 6: Commit every source-archive input**

```powershell
git add tools extensions docs README.md PRIVACY.md
git commit -m "docs(protocol): complete v7 rules navigation rollout"
```

`tools/archive-firefox-source.mjs` uses `git archive HEAD`; do not package before this commit contains every changed tool, fixture, document, and build input.

- [ ] **Step 7: Package and smoke the committed tree**

```powershell
corepack pnpm package
corepack pnpm artifacts:verify
corepack pnpm smoke:chrome-package
corepack pnpm smoke:vscode-package
```

Expected: all commands exit 0 and all archives are reproducible from the current `HEAD`. If a correction is needed, commit it and rerun from the new `HEAD`.

- [ ] **Step 8: Perform installed Chrome and Firefox verification**

Build and load unpacked Chrome and Firefox with `PIN_OP_PANEL_VARIANT=inspector`; ordinary/store artifacts remain on the legacy default until checkpoint 4. Manually verify source origins and clicks for exact CSS, inline-map SCSS, external-map SCSS, nested SCSS, selector/declaration split mappings, invalid-map CSS fallback, generated CSS edits, map edits, stale authorities, and cross-file editor switching. Record evidence in `docs/installed-verification.md`; verify the new Inspector has no visible Source tab and the legacy rollback panel's existing Source behavior remains intact.

## Checkpoint Exit Criteria

- Rules rows immediately receive exact CSS or source-mapped SCSS labels after each inspect.
- Valid SCSS source maps open the smallest exact original SCSS block in the IDE.
- Missing, invalid, ambiguous, stale, or outside-workspace mappings never produce an SCSS authority; verified generated CSS is the only fallback.
- Browser/bridge wire data contains no local URI/path/range/version.
- `rulesGeneration` and Rules authority are independent of active-editor Source resolution.
- An authority already stale at the pre-show revalidation cannot switch editors. If owning state changes only while awaited `showTextDocument` is already executing, VS Code may have switched the tab; the mandatory post-show checks prevent cursor/reveal, revoke the generation, and republish or fail closed. This host race is an explicit limitation, not a claimed three-party/editor transaction.
- Existing Source protocol/controller and legacy-panel navigation remain unchanged; the new Inspector still has no visible Source tab.
