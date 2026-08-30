# Pin-op Chromium Elements derivations

This file records the stable adaptation policy for sources derived from Chromium
DevTools frontend revision `a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280`.
`UPSTREAM.json` links every imported source to one of the anchors below.

The Pin-op derivations are deliberately read-only and backend-neutral. Across
the derived subset, remove editing, context menus, AI features, SDK/CDP objects,
Linkifier, Metrics/Layout/Computed integrations, DevTools Host integration,
telemetry, and browser branding. Retain upstream copyright/license headers in
every derived source. Only `devtools-elements.css` is derived today; the
TypeScript anchors below record the policy applied to the reviewed
native-runtime inputs that replaced Pin-op's former derived renderers.

<a id="dom-tree"></a>
## DOM tree

Pin-op no longer derives its own DOM-tree renderer. `ElementsTreeOutline.ts`
and `ElementsTreeElement.ts` are reviewed native-runtime inputs compiled from
the pinned npm package, and this anchor records the policy applied to them
through the hash-pinned DOM overlay:

- Remove editing, context menus, drag-and-drop, clipboard paths, AI, Issues,
  Metrics, DevTools Host integration, telemetry, and browser branding.
- Report every upstream adorner as disabled. Pin-op ships no adorner data,
  no adorner presentation, and none of the Sources or layout capabilities the
  upstream badges reveal.
- Keep selection, expansion, lazy loading, focus, and hover read-only, driven by
  Pin-op's neutral `TreeDataSource`.

<a id="rules"></a>
## Rules

Pin-op no longer derives its own Rules renderer. `StylesSidebarPane.ts`,
`StylePropertiesSection.ts`, `StylePropertyTreeElement.ts`,
`PropertyRenderer.ts`, and `StylePropertyUtils.ts` are reviewed native-runtime
inputs compiled from the pinned npm package, and this anchor records the policy
applied to them through the hash-pinned Rules overlay:

- Remove declaration, selector, value, color, shortcut, and rule mutation paths
  along with AI assistance, computed/layout panes, host integration, and
  telemetry.
- Adapt `MatchedStylesModel` through `RulesDataSource` so selection and
  rendering stay browser-local and independent of IDE source resolution.
- Mount the read-only `:hov` preview control in Chromium's own Styles toolbar
  row and toolbar pane, and adopt exactly its control rules into the widget
  shadow root that owns them. The preview never floats above the rule list.
- Replace SDK element-state forcing with immutable `PseudoStateDataSource`
  snapshots and atomic complete-state replacement; expose only `:hover` and
  `:focus`, and label every control as a preview.
- Report unsupported rules, inaccessible stylesheets, and source-order
  approximation as author-style coverage limits; never claim native browser
  forcing or exact cascade parity.
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
- Carry Chromium's own root theme classes while an Inspector is mounted:
  `theme-with-dark-background` for the color scheme, `baseline-grayscale` for
  its untinted baseline surfaces, and one `platform-*` class for its font
  tokens. Restore whatever the host document declared on disposal.
- Stack the DOM pane above Rules below 680 CSS pixels, the same width at which
  Chromium's Elements panel moves its sidebar under the tree.
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
- Keep the compact `:hov` button, two-choice preview pane, coverage description,
  disabled/busy states, checkbox focus, and forced-colors treatment entirely
  below `.pin-op-elements-inspector`, without unscoped animation or theme
  dependencies.
