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

<a id="rules"></a>
## Rules

- Derive read-only rule/declaration rendering from `StylesSidebarPane.ts`,
  `StylePropertiesSection.ts`, `StylePropertyTreeElement.ts`,
  `PropertyRenderer.ts`, and `StylePropertyUtils.ts`.
- Replace Chromium CSS/DOM models and Linkifier dependencies with immutable
  Pin-op rule snapshots and a narrow source-link delegate.
- Do not carry editing, element-state mutation, AI assistance, computed/layout
  panes, host integration, or telemetry into the derived boundary.

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
