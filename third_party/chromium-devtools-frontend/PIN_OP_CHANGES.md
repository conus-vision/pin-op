# Pin-op Chromium Elements derivations

This file records the stable adaptation policy for sources derived from Chromium
DevTools frontend revision `a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280`.
`UPSTREAM.json` links every imported source to one of the anchors below.

The Pin-op derivations are deliberately read-only and backend-neutral. Across
the derived subset, remove editing, context menus, AI features, SDK/CDP objects,
Linkifier, Metrics/Layout/Computed integrations, DevTools Host integration,
telemetry, and browser branding. Retain upstream copyright/license headers in
every derived source.

<a id="dom-tree"></a>
## DOM tree

- Derive only the useful tree presentation and keyboard-navigation algorithms
  from `ElementsTreeOutline.ts` and `ElementsTreeElement.ts`.
- Replace Chromium SDK nodes, mutation commands, tree widgets, host services,
  issue UI, tooltips, and metrics with Pin-op's neutral `TreeDataSource` and safe
  DOM rendering helpers.
- Keep selection, expansion, lazy loading, focus, and hover read-only. Do not
  retain dormant edit or context-menu paths.
- Preserve Chromium's document-type, tag, attribute, text, comment,
  shadow-root, and frame-document syntax classes while rendering only bounded
  immutable snapshots through text APIs.
- Adapt disclosure and roving tree focus to delegated `TreeDataSource`
  commands. Focus remains controller-owned; the renderer performs only the
  immediate DOM-focus restoration required for keyboard continuity.
- Bound local row materialization to 512 rows even when a caller violates the
  controller's normal virtual-window contract. Navigation still uses the full
  bounded snapshot and shifts that materialized window around controller-owned
  focus. In-flight expand/load/select commands are independently capped and
  deduplicated until settlement.
- Describe virtualized rows with sibling-local `aria-posinset` and
  `aria-setsize` values from the full immutable snapshot. Represent omitted-row
  height with a bounded binary set of predeclared CSS chunks, never runtime
  inline styles.

<a id="rules"></a>
## Rules

- Derive read-only rule/declaration rendering from `StylesSidebarPane.ts`,
  `StylePropertiesSection.ts`, `StylePropertyTreeElement.ts`,
  `PropertyRenderer.ts`, and `StylePropertyUtils.ts`.
- Replace Chromium CSS/DOM models and Linkifier dependencies with immutable
  Pin-op rule snapshots and a narrow source-link delegate.
- Do not carry editing, element-state mutation, AI assistance, computed/layout
  panes, host integration, or telemetry into the derived boundary.
- Retain inline, matched-author, and inherited section ordering; selector-match
  emphasis; ordered group context; declaration importance and proven cascade
  states; generated public origin labels; local filtering; and roving section
  focus.
- Keep generated origins as plain unresolved text until a later exact source
  authority is present. The derived modules contain no dormant declaration,
  selector, value, color, shortcut, or rule mutation path.
- Adapt `MatchedStylesModel` through `RulesDataSource` in the shared Inspector
  runtime so selection and rendering remain browser-local and independent of
  IDE source resolution.
- Decorate each rule origin through the narrow source-link delegate: keep the
  generated public label as non-clickable text until an exact current Rules
  authority is available, then make only the exact label and line clickable.
  The click carries an opaque authority and never exposes a workspace path or
  URI to the browser UI.

<a id="scoped-styles"></a>
## Scoped styles

- Derive the required presentation rules from `elementsTreeOutline.css`,
  `stylesSidebarPane.css`, and `stylePropertiesTreeOutline.css` into the shared
  `packages/devtools-elements-ui/assets/devtools-elements.css` target.
- Prefix every retained selector with `.pin-op-elements-inspector`, replace
  Chromium theme variables with documented Pin-op variables, and preserve
  light, dark, high-contrast, narrow-panel, and keyboard-focus behavior.
- Do not retain unscoped rules, remote resources, inline style behavior, or
  Chromium browser branding.
- The retained DOM-tree subset includes disclosure/indent guides, syntax token
  colors, selection/hover/focus states, and load-more presentation, with
  explicit dark, forced-color, and 320-pixel layouts. Virtual spacing uses only
  scoped, predeclared chunk classes.
- The retained Rules subset includes the filter row, section/selectors,
  contexts, public origin labels, declaration tokens, inherited separators,
  partial diagnostics, proven-overridden line-through, unknown-state marker,
  dark/forced-color variables, focus rings, and the 320-pixel stacked layout.
- Reset an enabled Rules origin to a text-sized scoped button with an explicit
  keyboard-focus ring so the shared panel button chrome cannot distort the
  Chromium-style rule header.
