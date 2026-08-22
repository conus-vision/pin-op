# Pin-op Chromium-Derived Inspector Port Design

**Date:** 2026-08-22
**Status:** Approved design and implementation plans

## Summary

Pin-op will replace its current custom DOM presentation with a deliberately
small, Chromium-derived Inspector frontend shared by the Chrome and Firefox
extensions. The panel will retain Pin-op's connection toolbar, Auto Refresh,
IDE Highlight, browser-local inspection authority, source plugins, and local
IDE bridge. It will reuse and adapt the Chromium DevTools DOM-tree and Rules
presentation instead of embedding either browser's complete native Inspector.

The first release is read-only. It displays a lazy DOM tree and the styles that
actually apply to the selected element, including inline, inherited,
winning-known-author, and overridden-known-author declarations. It exposes no
DOM, CSS, SCSS, or IDE editing operation. The `:hov` control retains
reversible runtime previews for `:hover`
and `:focus` without writing source files.

Rules shows the generated selectors and declarations consumed by the browser.
When a usable source map exists, its origin link displays the exact original
SCSS file and line. Clicking the origin asks the linked IDE to open that
workspace file and reveal the exact source block. The browser never supplies a
local path or arbitrary IDE command; it sends a short-lived opaque authority
issued by the IDE.

A later milestone will mount the existing Pin-op Source presentation as a tab
beside Rules and extend it with instrumented PHP/template source blocks. That
future UI does not change the first release's Inspector boundaries.

## Approved Product Decisions

- Chrome and Firefox use one Chromium-style Inspector frontend.
- Pin-op vendors a pinned Chromium DevTools revision and carries a small,
  auditable patch surface; it does not maintain separate Chromium and Mozilla
  Inspector forks.
- The first release includes Chromium-derived DOM Tree and Rules presentation,
  not the complete `ElementsPanel`.
- Rules and DOM are read-only.
- `:hover` and `:focus` remain available as reversible runtime previews.
- Rules displays generated CSS selectors and declarations.
- With a valid source map, the rule origin and IDE navigation target are the
  original SCSS source location.
- Missing or invalid maps fall back visibly to generated CSS; Pin-op never
  invents an SCSS location.
- Link, Disconnect, Auto Refresh, IDE Highlight, page overlay, selection
  correlation, and source-plugin behavior remain operational throughout the
  migration.
- The Source tab and PHP/template blocks are a separate later milestone.

## Context

Pin-op currently has a cross-browser custom Inspector implementation in
`packages/browser-extension-core`. `PageInspectionSession` owns page picker
selection, hover, overlay, node references, frame authority, and inspect
publication. `DomTreeProvider`, `DomTreeController`, and `DomTreeView` provide
a bounded lazy tree. `collectCssFacts` emits one IDE fact per matched
declaration but does not provide a complete Rules model. The panel also owns
Link, Auto Refresh, IDE Highlight, source excerpts, navigation, and strict
browser/IDE correlation.

The Chromium and Firefox native Inspector frontends are not standalone
WebExtension widgets. Chromium Elements expects DevTools SDK models backed by
the Chrome DevTools Protocol. Firefox MarkupView and Rules expect privileged
Walker, PageStyle, StyleRule, Selection, Toolbox, and Highlighter actors. A
normal DevTools extension panel cannot obtain those private transports. In
Chrome, `chrome.debugger` is also mutually exclusive with the native DevTools
session hosting the Pin-op panel.

Consequently, Pin-op cannot copy an unchanged native Inspector and keep the
same backend. It can legally reuse the Chromium frontend code under its
BSD-style license, retain its interaction and rendering logic, and replace the
SDK/backend seam with bounded Pin-op models served by the existing
content-script runtime.

## Goals

- Reuse the familiar Chromium DOM-tree and Rules interaction and appearance in
  Pin-op's own DevTools panel.
- Share one implementation between Chrome and Firefox.
- Preserve Link, Disconnect, Auto Refresh, IDE Highlight, and exact inspect
  correlation.
- Keep DOM, node references, full Rules data, and runtime pseudo-state data
  browser-local.
- Keep the DOM tree lazy, virtualized, mutation-aware, frame-aware, and safe
  against stale node references.
- Show inline, matched, inherited, inactive, winning-known-author, and
  overridden-known-author declarations in Rules.
- Use one matched-style authority for Rules rendering and IDE CSS/SCSS facts.
- Display generated CSS while opening exact original SCSS through source maps.
- Open a validated workspace source file and reveal its exact rule range from
  a Rules origin link.
- Preserve a strict read-only source boundary.
- Provide reversible cross-browser `:hover` and `:focus` previews.
- Retain a feature-flagged fallback until the new Inspector reaches parity.
- Preserve reproducible Chrome and Firefox packages with complete third-party
  notices and Firefox source submission materials.

## Non-Goals

- Embedding the complete Chromium `ElementsPanel` or Firefox Inspector.
- Using `chrome.debugger`, remote debugging, Firefox RDP, a native host, or a
  custom browser build as the normal product backend.
- Exact parity with privileged browser rules for UA styles, user styles,
  closed shadow roots, anonymous browser DOM, or inaccessible cross-origin
  stylesheets.
- Editing selectors, property names, property values, declaration enabled
  state, DOM nodes, attributes, or text.
- Adding rules or properties, applying workspace edits, or implementing
  DevTools CSS undo/redo.
- Pretending that an approximate or ambiguous workspace match is exact.
- Mapping SCSS without a valid source map.
- Reconstructing PHP, Twig, Blade, WordPress, or component source identity from
  final DOM alone.
- Shipping the future Source tab or PHP instrumentation in this milestone.
- Preserving wire compatibility with protocol v6. All Pin-op artifacts advance
  together when cross-file Rules navigation is introduced.

## User Experience

### Panel Layout

The existing Pin-op toolbar remains the stable top row. Link onboarding and
connected-state controls keep their current behavior. The Inspector workspace
below it is:

```text
Pin-op Panel
|- existing toolbar
|  |- Link / Disconnect
|  |- element picker
|  |- Auto Refresh
|  `- IDE Highlight
`- Inspector workspace
   |- Chromium-derived DOM Tree
   `- sidebar
      |- Rules
      `- Source (later milestone)
```

Rules is the only sidebar tab introduced in the first release. The existing
Source controller, protocol handlers, and IDE excerpt authority remain in the
codebase during migration. The old Source UI may remain available behind the
legacy-panel fallback until it is remounted beside Rules in its own approved
milestone.

The workspace adapts to narrow DevTools panes without changing the selected
node, expanded tree state, Rules generation, or connection state. Chromium
styles are namespaced under the Pin-op panel root so they do not leak into the
toolbar or footer.

### DOM Tree

The DOM tree retains Chromium's disclosure, indentation, keyboard navigation,
selection, hover affordances, search-ready structure, and familiar node
presentation. The first release is read-only: double-click editing, drag/drop,
cut/copy mutations, delete, attribute editing, text editing, and mutation
context-menu commands are absent or disabled.

Pin-op preserves its current security and lifecycle semantics:

- nodes have opaque browser-local references;
- children load lazily in bounded pages;
- only visible rows are materialized;
- page picker and tree selection use one authority;
- open shadow roots and accessible same-origin frames are explicit branches;
- closed roots and inaccessible frames remain opaque;
- navigation creates a new document epoch and invalidates every old node and
  rule reference;
- mutation events invalidate affected known branches without transmitting the
  whole page;
- page-provided names and values render only through text APIs.

The Chromium-derived row renderer consumes structured node fields rather than
the current preformatted `label`. The internal DOM model includes node type,
name, bounded value, bounded attributes, child count, shadow/frame
relationship, and the existing revision/locator authority needed for stale
recovery.

### Rules

Rules retains the familiar filter, selectors, property lists, inheritance
groups, overridden styling, shorthand expansion, color previews, and rule
origins. It displays the CSS that the browser applies, not reconstructed SCSS
syntax. A generated nested selector therefore remains the generated selector
in Rules even when its source origin is `component.scss`.

The following write affordances are removed or inert:

- selector, property-name, and property-value editors;
- declaration enabled/disabled checkboxes;
- Add Rule and Add Property;
- CSS/DOM mutation context commands;
- source-edit undo/redo;
- editable color, shadow, easing, and variable popovers.

Read-only swatches may retain non-mutating inspection details. Every control
must expose its read-only state to keyboard and assistive-technology users; a
disabled editor must not merely ignore input silently.

Rules initially covers available author styles, inline styles, inheritance,
and the cascade Pin-op can verify. If a stylesheet cannot be inspected, the
panel shows the rules it can prove and a compact `Stylesheet inaccessible`
diagnostic. It does not fabricate missing rules, specificity, or locations.

### Rule Origins And IDE Open

Before IDE mapping completes, an external rule may show its generated origin,
for example `style.css:418`. A successful IDE mapping atomically upgrades it to
the validated original source, for example `style.scss:920`. The display label
contains no local path.

Clicking an enabled origin:

1. sends the current inspect ID, Rules generation, and IDE-issued opaque
   open authority;
2. causes the IDE to revalidate the current connection, generation, authority,
   workspace ownership, document identity, version, and exact range;
3. opens the document through the IDE adapter;
4. places the primary cursor at the rule start and reveals the complete range.

A stale, ambiguous, unknown, out-of-workspace, or version-mismatched authority
does nothing destructive. The panel invalidates the link or asks for a fresh
location publication. The browser cannot send a local URI, file path, line,
range, or command for the IDE to execute.

### `:hover` And `:focus`

The Chromium-derived `:hov` control exposes `:hover` and `:focus` in the first
release. These are explicit runtime preview states, not source edits.

Native DevTools forces pseudo states through privileged browser backends that
are unavailable to a shared WebExtension. Pin-op therefore uses a reversible
author-style emulation:

1. identify available author rules whose selectors contain a supported
   positive requested pseudo class on the selected subject compound;
2. create bounded mirror selectors in the selected element's scope by
   replacing the requested pseudo class with a Pin-op-owned marker of equal
   class/attribute specificity and appending a zero-specificity selection guard;
3. install the mirror rules in a Pin-op-owned temporary stylesheet;
4. place the marker only on the current selected element;
5. remove every marker and temporary rule synchronously on controlled
   in-context state/selection/document/connection/refresh transitions and make
   a best-effort teardown request before a content context is lost.

The emulation must not call page functions directly, call `focus()`, or dispatch
pointer/focus/keyboard events. Page MutationObservers and handlers caused by
CSS transitions, animations, or resource loads may still run because preview
artifacts and style effects are observable. Negated target pseudos such as
`:not(:hover)` are unsupported because additive mirror CSS cannot suppress the
still-matching native rule. It covers only author rules Pin-op can read and rewrite.
It does not claim UA, inaccessible cross-origin, closed-shadow, or JavaScript
state parity. The UI labels this behavior as a preview when that distinction is
material.

Mirror rules are emitted only for the selected element and supported
media/supports contexts. Layer, scope, container, starting-style, and unknown
grouping contexts fail closed. Because a temporary mount cannot always occupy
the original rule's exact cross-sheet cascade position, the response and UI
report a bounded approximation count whenever precedence equivalence is not
proven.

## Runtime Architecture

```text
Chromium-derived Inspector frontend
  PinOpInspectorPanel
    -> DOM tree presenter
    -> Rules presenter
    -> origin-link presenter
    -> :hov presenter
             |
             | typed browser-local Inspector API
             v
Pin-op Inspector backend adapter
  -> PageInspectionSession / DomNodeRegistry / FrameRegistry
  -> InspectMode / PageOverlay
  -> MatchedStylesModel / StylesheetRegistry
  -> PseudoStatePreview
             |
             | existing bounded panel/background/content route
             v
Inspected page content runtime

Rules source evidence only
             |
             | authenticated protocol-v7 inspect and rule-source messages
             v
Local bridge validator/router
             |
             v
IDE adapter
  -> RuleLocationResolver
  -> CSS/SCSS AST and source maps
  -> RuleOpenAuthorityRegistry
  -> open/show document + cursor/reveal
```

### Preserved Pin-op Components

The implementation keeps these responsibilities and their current owners:

- `PanelController`, `BrowserWindowLinkStore`, `WindowConnectionCoordinator`,
  and both bridge clients retain Link/Disconnect and connection state.
- `PanelInspectTransport`, `PanelSessionTransport`, `BackgroundRouter`, and
  `BackgroundInspectSession` retain tab/channel routing and content leases.
- `PanelSettingsController`, `TabRefreshCoordinator`,
  `TabRefreshStateStore`, content refresh, stylesheet refresh, scroll
  restoration, IDE save observation, and refresh classifiers retain Auto
  Refresh.
- `HighlightController`, `ActiveEditorCoordinator`, inspect correlation, and
  presentation settings retain IDE Highlight.
- `SourcePaneController`, `SourceExcerptRegistry`, `SourceNavigator`, source
  plugins, `source.matches`, `source.open`, and navigation state remain the
  authority for the existing active-document Source feature.
- `PageInspectionSession`, `DomNodeRegistry`, `FrameRegistry`,
  `DomStableLocator`, `InspectMode`, `PageOverlay`, and initially
  `DomTreeProvider` remain browser-local inspection authority.

The panel workspace and presentation layer change. `DomPanelView` continues to
own the Pin-op toolbar/footer but delegates Inspector workspace mounting to a
new shell. The current `DomTreeView` and its presentation-specific controller
are retired only after the new tree passes parity checks. Recovery semantics
remain available through `DomStableLocator` even if their controller adapter
changes.

### Vendored Frontend Boundary

Pin-op pins one Chromium DevTools frontend commit. It vendors only the files
and assets needed for the selected DOM-tree and Rules renderers, plus their
transitive license-compatible UI dependencies. A machine-readable upstream
manifest records the commit, original paths, licenses, local patches, and the
command used to reproduce the vendored snapshot. Each upstream source maps to
structured derived-target entries containing the repository-relative target,
its current local SHA-256, and a stable `PIN_OP_CHANGES.md` anchor. A temporary
`pending` digest is allowed only before that target exists; release verification
requires every derived target to exist and match its recorded digest.

The long-term product does not instantiate unmodified `ElementsPanel`,
`SDK.DOMModel`, `SDK.CSSModel`, `SDK.OverlayModel`, Target discovery, Workspace,
Sources, Accessibility, Layout, Computed, Fonts, Animations, or the DevTools
host. The fork retains useful view/rendering logic and CSS but replaces
controller/model dependencies with small Pin-op interfaces. This is more
maintainable than emulating the complete CDP surface.

A fake-CDP experiment is allowed only as an isolated feasibility fixture. It
must not become the production architecture unless a later approved design
demonstrates a smaller, more stable surface than the typed Pin-op adapter.

The Chromium BSD-style license, copyright notices, disclaimers, and all
transitive third-party notices remain in source and binary distributions.
Chromium/Google product branding is not copied into Pin-op.

## Browser-Local Inspector Models

The adapter exposes focused immutable snapshots rather than Chromium SDK
objects. Exact names may change during implementation, but these ownership
boundaries are fixed:

```ts
interface InspectorNode {
  readonly nodeRef: string;
  readonly documentEpoch: number;
  readonly branchRevision: number;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly attributes: readonly InspectorAttribute[];
  readonly childCount: number;
  readonly relationship: "dom" | "shadow-root" | "frame-document";
  readonly inaccessible: boolean;
  readonly locator?: DomStableLocator;
}

interface MatchedStyles {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly nodeRef: string;
  readonly inline?: MatchedRule;
  readonly rules: readonly MatchedRule[];
  readonly inherited: readonly InheritedMatchedRules[];
  readonly inaccessibleStylesheetCount: number;
}

interface MatchedRule {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly declarations: readonly MatchedDeclaration[];
  readonly contexts: readonly RuleContext[];
  readonly source?: GeneratedRuleSource;
}

interface RuleContext {
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

interface GeneratedRuleSource {
  readonly sourceUrl: PublicStylesheetUrl;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly rulePath?: string;
}
```

Generated positions are 1-based/end-exclusive when present. A source record
must carry a complete start pair or a numeric rule path; external CSS commonly
uses only the path until the IDE verifies its workspace AST.

`PublicStylesheetUrl` is a bounded, canonical, credential-free absolute
`http:`/`https:` URL with no fragment or control/bidi characters. HTTP(S)
localhost and private-network hosts are allowed for local development. Relative
stylesheet URLs are resolved in the inspected page first. Filesystem/UNC/drive
paths and `file:`, `blob:`, `data:`, extension, resource, and other schemes never
enter inspect evidence; such a rule remains visible but has no generated-source
navigation evidence.

The root response keeps `documentElement` as the selectable/recoverable root and
adds bounded non-selectable `prologue`/`epilogue` rows for document type and
top-level comments. Document types retain bounded name/public/system IDs; text,
comment, and document-type rows never receive stable locators.

The protocol remains bounded and strict. Page-controlled strings are copied
and validated at every content/panel boundary. `nodeRef` and `ruleRef` are
scoped to the inspected tab, content lease, document epoch, and current model
generation. They are never accepted as global identifiers.

## Matched Styles And Stylesheet Registry

`collectCssFacts` is not sufficient for Rules because it emits declaration
facts but does not own inline style, full inheritance, cascade state, matched
selector indices, disabled/overridden state, or source ranges. A new
browser-local `StylesheetRegistry` and `MatchedStylesModel` become the single
style authority.

The registry:

- inventories inline, external, imported, and available adopted author
  stylesheets per accessible document or open shadow-root scope;
- assigns epoch-scoped stylesheet and rule references;
- reads CSSOM when permitted;
- parses bounded inline owner text only when it can prove one-to-one CSSOM rule
  correspondence; external ranges remain IDE-owned;
- tracks media/group ancestry, stylesheet order, imports, and revision;
- invalidates on stylesheet DOM changes, soft style refresh, frame lifecycle,
  and document navigation, and detects otherwise eventless CSSOM/adopted-sheet
  changes through a bounded active-session fingerprint rescan;
- reports inaccessible sheets without retry loops or authority escalation.

Fingerprint budgets are session-global, not multiplied independently by every
root. One bounded structural digest is cached per `CSSStyleSheet` object and is
combined with each root's adoption/order/owner-state digest. The digest includes
sheet disabled/media applicability and bounded owner link/style media, disabled,
rel, href, title/alternate state, not only rule `cssText`. Rule, byte, scope, and
elapsed-time ceilings make a truncated scan explicitly partial. Browser timer
throttling means the polling interval is a target cadence, not a wall-clock
freshness guarantee.

The matched-style model queries only the selected node and its inheritance
chain. It combines selector matches, stylesheet/group applicability, inline
declarations, importance, and origin/order information available to Pin-op.
It marks a declaration `overridden-known-author` only when another known author
declaration proves that result; the highest known author candidate is not a
claim about unavailable origins, animations, or transitions. Unsupported
cascade features remain explicitly unknown instead of being misclassified.

The IDE fact collector becomes a projection of `MatchedStyles`. All
declarations from one rule share its `ruleRef` and generated source evidence.
This guarantees that the rule rendered in Rules, the rule highlighted in the
IDE, and the rule mapped to SCSS have the same browser-side identity.

## SCSS Source Mapping

SCSS mapping stays IDE-owned because workspace paths, documents, ASTs, and
source-map contents are IDE authority. The browser sends only bounded generated
rule evidence already needed for inspection: a strict HTTP(S) stylesheet URL,
generated range, selector, ordered typed media/supports ancestry,
unsupported/truncation flags, rule path/reference, and declaration fingerprints.

The IDE resolves a rule in this order:

1. resolve the generated stylesheet URL to exactly one workspace-owned CSS
   document using the existing workspace-bound strategy;
2. reject truncated or unsupported grouping ancestry, then verify the generated
   rule from its optional generated position or numeric rule path plus complete
   selector/declaration and ordered typed media/supports evidence; a unique
   fingerprint relocation can prove CSS only;
3. retain the generated AST's exact half-open selector-prelude range and load a
   bounded inline or external source map through the existing
   workspace/source-map boundary;
4. require a mapping segment at the exact generated selector start and require
   every usable mapping in the selector prelude to agree on one canonical
   original source and smallest containing block;
5. resolve that original URL to exactly one workspace-owned SCSS document;
6. parse that SCSS document and verify the full expanded selector,
   declarations, importance, and media/supports context evidence against the
   exact generated rule;
7. create an opaque open authority bound to inspect ID, Rules generation,
   rule reference, exact range, workspace generation, and hashes/versions of
   the generated CSS, external map when present, and original source.

Nested selectors, nested media/supports rules, and multiple original SCSS files
are supported only when that complete verification succeeds; truncated or other
group ancestry receives no source authority. A declaration
mapping into a mixin cannot replace the selector-start rule origin; mixin output
that cannot be proven inside one original rule falls back to generated CSS.
Rules continues to show generated selectors and values; the origin label and
open authority use the verified original SCSS block.

If any exactness check fails, the IDE returns a bounded reason and no SCSS open
authority. A verified generated CSS document may still receive its own exact
CSS open authority. Unique-basename and selector-only guesses are not allowed
for cross-file open.

Auto Refresh retains its current SCSS quiet/build window. A successful refresh
increments stylesheet revision, clears stale mappings, reparses generated CSS
and its source map, and republishes only current rule origins.

## Protocol V7 Rule Source Navigation

Protocol v7 is an atomic replacement for v6. It adds a capability dedicated to
Rules source navigation and two strict message families. Final names and byte
limits are fixed in the protocol implementation plan, but the semantic
contract is:

```ts
interface RulesSourcesMessage {
  readonly protocolVersion: 7;
  readonly type: "rules.sources";
  readonly messageId: string;
  readonly sessionId: string;
  readonly source: { readonly role: "ide"; readonly id: string };
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly sources: readonly RulesSource[];
  readonly unresolvedRuleCount: number;
  readonly metadata: Readonly<Record<string, never>>;
}

interface RulesSource {
  readonly ruleRef: string;
  readonly document: {
    readonly label: string;
    readonly languageId: "css" | "scss";
  };
  readonly startLine: number;
  readonly startColumn: number;
  readonly confidence: "exact" | "sourcemap";
  readonly openAuthorityId: string;
}

interface RuleSourceOpenMessage {
  readonly protocolVersion: 7;
  readonly type: "rules.open";
  readonly messageId: string;
  readonly sessionId: string;
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly openAuthorityId: string;
  readonly metadata: Readonly<Record<string, never>>;
}
```

`rules.sources` follows only the exact originating inspect reply route. The
bridge stores the immutable expected rule-reference set from that inspect and
accepts only a complete publication where unique published sources are a subset
and `sources.length + unresolvedRuleCount === expectedRuleRefs.size`. It uses a
prepare/send/commit transition so a delivery failure leaves the previous
generation and allowlist intact. The bridge records the current bounded set of
issued open authorities for that route and generation. `rules.open` is accepted
only from that originating browser and forwarded only to the authoritative IDE
connection. A current authority may be clicked repeatedly; it is revoked by
disconnect, new inspection, workspace/dependency changes, stylesheet or page
refresh, document/frame navigation, protocol mismatch, or replacement.

The IDE registry holds one complete current generation with capacity for all
256 publishable sources. It prepares the final envelope/registry together and
activates the candidate immediately before local transport submission so a
newly delivered browser authority is already recognizable. A local
serialization/socket failure restores the prior same-inspect registry (or empty
state for a new inspect). Local acceptance does not prove bridge-to-browser
delivery; without a third acknowledgement, downstream failure may temporarily
leave endpoints on different generations. This remains fail-closed because a
click not present in the receiver's current allowlist is rejected, and a fresh
inspect or disconnect clears/re-resolves the route. Open-buffer contents/version
take precedence over disk, while bounded workspace file watchers eagerly
invalidate closed CSS/SCSS/map dependencies. On click, the IDE re-authorizes and
re-hashes every dependency both before and after `showTextDocument`, then
verifies the returned editor's host-owned document identity before moving the
cursor or revealing.
Staleness known before `showTextDocument` prevents any editor switch. If owning
state changes only while that awaited host call is already executing, VS Code
may have switched the tab; post-show failure still prevents cursor/reveal,
revokes the generation, and never executes a wire-supplied command.

The browser displays only `label`, `startLine`, `startColumn`, `languageId`, and confidence.
Messages never include local URIs, absolute paths, workspace names, document
text, or end-user commands. Labels pass the existing path/URI rejection and
Unicode-control normalization boundary.

The current `source.open` message retains its active-document excerpt meaning.
Rules navigation does not silently broaden that existing authority.

## Lifecycle, Caching, And Invalidation

The selected node, DOM tree, matched styles, source locations, IDE highlights,
and pseudo-state preview form one correlated generation.

- Navigation creates a new `documentEpoch`, releases old nodes/rules, clears
  Rules and pseudo state, and starts a fresh tree.
- Page selection advances `selectionRevision`, reveals the tree path, clears
  previous Rules/source authority, and requests matched styles.
- Stylesheet change advances `stylesheetRevision`, clears Rules/source
  authority, also advances aggregate `stylesRevision`, and recomputes only for
  the current selected node.
- Applicability or pseudo-preview change advances `stylesRevision` (and the
  dedicated pseudo revision when applicable) without resetting stylesheet
  identity. A changed fact/evidence projection renews the current-selection
  inspect ID while retaining `selectionRevision` and active preview state.
- IDE Rules resolution advances its independent `rulesGeneration`; only a
  strictly newer complete publication with matching inspect and rule
  references updates origins. Active-editor Source re-resolution does not
  revoke Rules locations.
- DOM mutations invalidate known branches. A bounded, coalesced selected-scope
  requery also follows relevant document/shadow mutations, slot changes,
  viewport/media-query changes, and observed pointer/focus state changes so
  selector and group applicability can change without CSS text changing.
  The same rotating poll hashes actual matching selector indices/group
  applicability for the selected element and bounded composed ancestors, which
  catches eventless form validity/checked/placeholder/custom-state changes when
  exposed through `Element.matches`; truncated scans remain partial and manual
  refresh is the deterministic fallback.
- Auto Refresh clears pseudo state before stylesheet replacement or reload.
- Controlled panel disconnect, cooperative lease replacement, incompatible
  protocol, or disposal clears browser runtime artifacts while the content
  context can still run. Abrupt extension termination can leave preview
  artifacts until page navigation/reload.

Matched styles cache by document epoch, node reference, selection revision,
aggregate styles revision, stylesheet revision, and pseudo-state revision.
Browser-side parsed text is limited to bounded inline-owner ASTs keyed by scope,
owner/sheet identity, and content revision; external stylesheet parsing remains
IDE-owned and caches by workspace URI/version. Work is coalesced and cancelable;
an old parse or IDE response cannot replace a newer selection.

## Security And Privacy

- The feature remains workspace-source read-only.
- Browser-to-IDE traffic is still loopback-only, authenticated, correlated,
  capability-checked, schema-validated, and bounded.
- DOM nodes, full DOM trees, page text, full stylesheet text, and runtime
  pseudo-state markers never cross the public WebSocket.
- Only bounded CSS rule evidence already needed for source resolution crosses
  to the IDE.
- The IDE opens only a current, exact, workspace-owned authority it created.
- Page-controlled URLs, selectors, labels, source maps, and CSS text are
  untrusted inputs and cannot become direct file paths or HTML.
- The browser runtime performs no background stylesheet URL fetch; inaccessible
  external CSS remains partial and exact external ranges are resolved only
  against workspace-owned IDE documents.
- Temporary pseudo-state styles and markers have random session-scoped names,
  cannot receive pointer events, and are synchronously removed on controlled
  in-context exits; teardown also attempts cleanup before losing the content
  context.
- Page scripts can observe temporary marker/style mutations while an explicit
  preview is enabled; Pin-op filters its own artifacts but does not claim they
  are invisible to application MutationObservers.
- No remote code, remote UI bundle, dynamic executable download, or browser
  branding is included.

The product documentation must update the current statement that Pin-op never
switches active editors. It will instead state that source files are opened
only after an explicit user click on a validated Rules origin or Source match.

## Known Fidelity Limits

An ordinary cross-browser WebExtension cannot guarantee native Inspector
fidelity for:

- UA and user styles;
- closed shadow DOM and browser-anonymous nodes;
- stylesheets whose CSSOM and text are both inaccessible;
- all disabled declarations not represented by the live CSSOM;
- every modern cascade feature before Pin-op's parser/model supports it;
- browser-engine pseudo-state behavior outside readable author rules;
- application code that reacts to observing the temporary preview artifacts;
- CSS transitions, animations, or resource loads caused by applying supported
  mirror styles, even though Pin-op dispatches no input/focus event;
- abrupt extension termination, which can leave preview artifacts until the
  inspected page navigates or reloads because no content context remains to
  perform object-identity cleanup;
- out-of-process or cross-origin frame internals without existing authority.

These limits are surfaced as unavailable or unknown states. They are not
silently represented as complete native results.

## Migration Strategy

1. Pin and vendor the minimal Chromium-derived UI with a reproducible manifest,
   license inventory, static fake data, and Chrome/Firefox CSP/package checks.
2. Add a feature-flagged `PinOpInspectorPanel` and typed adapter while retaining
   the existing panel as fallback.
3. Extend the browser-local DOM protocol and connect picker/tree selection to
   the new DOM presenter.
4. Add `StylesheetRegistry` and read-only `MatchedStylesModel`; project current
   IDE CSS facts from the new model.
5. Introduce protocol v7, IDE `RuleLocationResolver`, and opaque cross-file open
   authority; then enable exact CSS and SCSS origin links.
6. Add and harden reversible `:hover`/`:focus` previews.
7. Run installed parity, visual, security, package, and source-submission
   verification in both browsers.
8. Enable the new Inspector by default, retain a bounded rollback release, then
   remove the legacy tree presentation after field confidence.

The migration is divided into implementation plans with independent testable
checkpoints: vendored shell/DOM, matched Rules, protocol/SCSS navigation, and
pseudo-state/rollout hardening.

## Testing Strategy

### Vendored Frontend And Packaging

- upstream manifest reproducibility and patch inventory;
- license/header/third-party-notice generation;
- no unapproved Chromium panel/domain imports;
- Chrome and Firefox extension CSP compliance;
- no remote code or network-loaded UI dependencies;
- package-size and Firefox source-archive coverage;
- keyboard, focus, screen-reader, dark/light theme, and narrow-panel behavior;
- deterministic visual snapshots of DOM Tree and Rules fixtures.

### DOM And Picker

- root/children paging, attributes, node kinds, search-ready structure, and
  stale-response rejection;
- selection and hover synchronization between page and tree;
- mutation, navigation, frame, and shadow-root invalidation;
- overlay exclusion and complete disposal;
- read-only removal of editing shortcuts and mutation commands;
- Chrome/Firefox adapter contract parity.

### Rules

- inline, author, inherited, typed media/supports/group, important, winning-known-author, and
  overridden-known-author declarations;
- duplicate selectors, nested CSS, imports, adopted styles where available,
  and stylesheet ordering;
- safe failure for inaccessible and malformed stylesheets;
- bounded parsing, caching, cancellation, and revision invalidation;
- one `ruleRef` identity shared by Rules, IDE facts, and source mapping;
- no write controls or editable popovers.

### CSS And SCSS Navigation

- exact generated CSS ranges;
- inline and external source maps;
- nested selectors, ordered nested media/supports, duplicate rules under
  different supports conditions, mixins, multiple source files, query strings,
  and changed generated artifacts;
- missing, invalid, unmapped, ambiguous, stale, and outside-workspace maps;
- generated CSS fallback without heuristic SCSS claims;
- strict protocol schemas, byte/count limits, roles, capabilities, route
  ownership, replacement, and disconnect cleanup;
- explicit click opens the exact document, places the cursor, and reveals the
  exact full block;
- pre-show stale rejection plus post-show cursor/reveal suppression for the
  documented in-flight editor-host race;
- browser-supplied path/URI/range and stale authority attacks fail closed.

### Pseudo-State Preview

- selected-element-anchored `:hover` and `:focus` selector rewriting with
  equivalent specificity for the supported positive subset;
- no application focus, mouse, pointer, or keyboard events;
- same-origin frames and open shadow-root documents where available;
- partial/inaccessible rule reporting;
- synchronous cleanup on controlled in-context exits, best-effort cleanup on
  teardown/lease loss, and page navigation/reload as the final abrupt-loss
  cleanup boundary;
- no marker/style leakage into inspect payloads or the DOM tree.

### Regression

- Link, Disconnect, reconnect, protocol mismatch, and multi-window isolation;
- Auto Refresh styles/reload and scroll restoration;
- IDE Highlight toggle and active-editor re-resolution;
- existing Source excerpts and navigation on the legacy/future mount;
- release builds, artifact verification, installed VSIX smoke, Chrome package
  smoke, Firefox `web-ext` lint, and Firefox source submission.

## Acceptance Criteria

- Chrome and Firefox ship the same Chromium-derived DOM Tree and Rules UI.
- Existing Link, Refresh, IDE Highlight, selection, and overlay workflows still
  pass installed verification.
- DOM and Rules expose no editing operation.
- Rules displays available inline, matched, inherited, winning-known-author,
  overridden-known-author, inactive, and unknown declarations for the selected
  node.
- Rules and IDE facts use one matched-rule identity and do not disagree about
  the source rule.
- A valid source map displays an original SCSS origin and an explicit click
  opens the exact SCSS block in the IDE.
- Missing or invalid source maps visibly fall back to generated CSS without an
  approximate SCSS link.
- `:hover` and `:focus` previews work for supported author rules, leave no
  runtime artifacts after every controlled in-context exit, and document the
  abrupt-termination-until-page-reload limit.
- Old node, rule, source, and open-authority IDs cannot begin a new action after
  their owning generation changes; the bounded in-flight editor-host race above
  never receives cursor/reveal authority after post-show revalidation fails.
- Inaccessible data produces bounded partial diagnostics instead of false
  completeness or a broken panel.
- Vendored code, patches, licenses, package contents, and Firefox source
  submission are reproducible and auditable.

## Future Source And PHP Milestone

The future Source tab reuses `SourcePaneController`, `SourceExcerptRegistry`,
`SourceNavigator`, `source.matches`, and active-document correlation. It mounts
beside Rules without changing browser DOM or matched-style ownership.

Exact PHP, Twig, Blade, WordPress, and ACF source blocks require
development-only server/build instrumentation that emits namespaced source
hints. A source plugin resolves those hints only inside the active workspace
and returns bounded `instrumented` matches. Final DOM, selector, or text
heuristics alone never receive exact authority.
