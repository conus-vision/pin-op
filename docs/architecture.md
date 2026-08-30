# Architecture

Pin-op is a local, read-only bridge from browser DevTools inspection to
source highlighting in VS Code. Product semver is `0.3.0`; the independent wire
protocol version is `7`.

## Components

### DevTools Panel

Firefox and Chrome/Chromium build the same Pin-op panel from the shared
browser core. The panel owns:

- explicit browser-window link controls and the displayed port-plus-PIN code;
- one toolbar row with the visual page picker, tab-local **Auto Refresh** and
  **IDE Highlight** controls, and the unchanged connection controls/code;
- a virtualized, lazy DOM tree;
- a Source tab containing bounded active-document excerpts for the Selected
  element and its immediate Parent;
- the selected-element summary, exact IDE resolution footer, and selected-match
  source navigation controls.

Layout selection combines viewport breakpoints with the measured usable
workspace. DOM and Source use split when the viewport is at least 680 px wide
and the workspace width fits two 160 px panes plus the measured separator. If
split does not fit, stack is available at any viewport width when the viewport
is at least 520 px tall and the workspace height fits two 160 px panes plus the
measured separator (currently at least 325 px total). The panel uses tabs only
when neither two-pane arrangement fits. The footer carries the compact Pin-op
product identity without replacing operational status.

Each panel receives an opaque browser-extension channel. DOM requests and events
are routed through that channel to the inspected tab, never through the product
WebSocket.

The default panel in Chrome and Firefox is one shared Chromium-derived,
byte-identical, read-only Inspector UI built from a native Chromium DevTools
frontend runtime. It compiles the pinned npm package's actual
`DOMModel`, `ElementsTreeOutline`, `StylesSidebarPane`,
`StylePropertiesSection`, `StylePropertyTreeElement`, property renderer, tree
widgets, design tokens, icons, and scoped CSS. Hash-pinned overlays remove
editing, context-menu, AI, telemetry, network, and DevTools-host paths and
provide only the narrow browser-neutral facades those reviewed modules need.
Pin-op does not embed Chromium's `ElementsPanel`, connect a Chrome DevTools
Protocol backend, discover targets, or ship browser branding.
`DomTreeProvider`, page inspection, overlay, selection, refresh, source
authority, pseudo preview, and bridge routing remain Pin-op-owned.

While an Inspector is mounted the panel declares Chromium's own root theme
classes - the color scheme, its untinted `baseline-grayscale` surfaces, and one
`platform-*` font class - and restores whatever the host document declared on
disposal. Pin-op's read-only `:hov` control is mounted inside Chromium's Styles
toolbar row and toolbar pane rather than above the rule list, and every upstream
adorner is reported disabled because Pin-op ships neither adorner data nor the
capabilities those badges reveal. Below 680 CSS pixels the DOM pane stacks above
Rules, the same width at which Chromium's Elements panel moves its sidebar.

The checked-in [native runtime manifest](../third_party/chromium-devtools-frontend/RUNTIME.json),
DOM and Rules overlay manifests, [BSD license](../third_party/chromium-devtools-frontend/LICENSE),
[reference-source manifest](../third_party/chromium-devtools-frontend/UPSTREAM.json),
and [derivation record](../third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md)
are exact provenance and reproduction inputs. The default Inspector exposes the
native DOM and Rules views plus Pin-op's Source tab. Exact current Rules origins
show the SCSS/source label and one-based line and can send an opaque open intent
to VS Code; unresolved generated CSS origins stay non-clickable.

The Inspector path exposes structured DOM node snapshots. They carry node type
and name, bounded attribute names and values, bounded text and comment values,
and document-type names with bounded public and system IDs. Document types and
top-level comments are bounded display-only auxiliary rows; text and comment
children are likewise non-selectable and have no stable locator.

Chrome and Firefox copy the same panel HTML entrypoint, core stylesheet,
scoped `devtools-elements.css`, logo, and icons through one deterministic asset
assembler. Both bundles ship exactly one panel page and one `inspectorPanel.js`
bootstrap; Pin-op packages no second Inspector implementation. Release verification
requires byte-identical derived CSS and Chromium notice inventory across
browsers. It also requires the native runtime JavaScript itself to be
byte-identical.

### Inspected-Page Runtime

The content runtime owns the browser-local Inspector session. One selection
authority serves both page clicks and DOM-tree commands. It:

- renders a style-isolated, pointer-inert, half-alpha box-model overlay only
  while a page element or DOM-tree row is hovered;
- exposes bounded tree pages on demand;
- traverses the top document, open shadow roots, and same-origin frame
  documents;
- represents cross-origin frames as inaccessible locked leaves and ignores
  closed shadow roots;
- collects bounded page, DOM, and CSS facts only for a valid selection;
- owns one reversible author-style pseudo preview for supported positive
  `:hover` and `:focus` rules in the selected element's accessible scope;
- emits one selected target and, when present, its immediate DOM parent.

Browser-local node refs are scoped by panel channel, document epoch, frame
identity/epoch, and branch revision. Cursors are also bound to their node,
epoch, and revision. Mutation, navigation, collapse, frame lifecycle changes,
and session disposal invalidate stale authority instead of guessing.

`PseudoStatePreview` parses readable author selectors and replaces only a
supported positive pseudo on the selected subject compound with a random,
session-scoped marker of equal specificity plus a zero-specificity selection
guard. It groups mirror rules by source sheet/root and mounts exact
extension-owned style nodes or constructable sheets beside their source where
possible. The original stylesheet is never modified. Temporary markers,
mounts, and mirror rules are excluded from Pin-op DOM, Rules, overlay, inspect,
and stable-locator evidence.

This is author-style emulation, not native pseudo-state forcing. Unsupported
selector shapes, inaccessible sheets, unprovable grouping/cascade positions,
and mount failures contribute bounded partial diagnostics rather than guessed
rules. Cross-sheet source-order equivalence that cannot be proven contributes
an approximation count. No preview path calls `focus()` or dispatches input,
focus, mouse, pointer, or keyboard events. Page scripts can still observe the
marker/style mutations, and the applied author styles can trigger transitions,
animations, resource loads, and mutation records.

### Browser-Window Coordinator

The extension background owns one session link per browser window in
`browser.storage.session`. The record contains the exact loopback endpoint,
session and bridge identities, browser token, and formatted display code. Panels
in one window share at most one active authenticated WebSocket. A different
browser window has independent state.

Disconnect revokes and removes only the current browser window's record. Closing
the final panel closes its socket without converting session storage into
durable storage.

Refresh participation is tab-local and requires an open compatible panel with
Auto Refresh enabled. Only the current tab refreshes immediately. A
participating inactive tab records the newest pending refresh and applies it
once when activated.

### Protocol And Bridge

Protocol version `7` defines strict handshake, inspection, targeted resolution,
source presentation, presentation settings, auto-refresh, source navigation,
Rules source publication/opening, peer state, error, and heartbeat messages.
Every product message is validated before routing. Version 7 is breaking: a v6
peer is closed with WebSocket code `1002`, with no compatibility adapter or
fallback.

The bridge binds one managed port on `127.0.0.1`. A link request to that exact
port exchanges the two-digit PIN for a role-bound browser token. The bridge does
not scan ports or discover clients.

For each accepted inspect message, the bridge records a bounded reply route from
`sessionId` plus `inspectMessageId` to the originating browser connection. IDE
resolution and Source messages return only through that route, so another
linked browser connection cannot receive them. The bridge also publishes
monotonically generated IDE peer state when IDE availability changes.
Navigation, exact Source-open intents, presentation settings, and repeated
cursor-state updates reuse the same exact inspect reply route and generation.
Rules source publication has its own monotonic generation and complete expected
`ruleRef` set. The bridge stores only route-local refs and current opaque open
authority IDs; it never stores a workspace path, URI, full range, document
version, source map, or editor command.

### VS Code Presenter

Each local VS Code window starts its bridge automatically. The status bar shows
the managed port and two-digit PIN and copies the ungrouped code on click.

The presenter retains the latest valid selection and resolves Source excerpts
and decorations against only the active text document. Passive inspection never
switches editors. It owns Selected and Parent decorations, validates and
deduplicates plugin ranges, updates Applicable Sources, creates bounded Source
excerpts, and sends protocol-v7 resolution and source-presentation outcomes back
to the originating panel. Clicking a Source excerpt returns only its
opaque match ID; the IDE validates that private authority before revealing the
exact range in the active document.

Separately, the Rules resolver verifies bounded generated CSS evidence against
workspace-owned CSS ASTs and usable source maps. It publishes safe labels and
opaque open authorities. An explicit Rules origin click may switch VS Code to a
different exact CSS or SCSS block using that current IDE-issued opaque
authority. Missing or invalid source maps expose only verified generated CSS;
they never create an approximate SCSS target. The private full range,
dependency hashes, workspace generation, document identity, and version remain
IDE-owned and are revalidated around the editor host call.

The presenter also observes changed saves. Direct CSS settles for 150 ms.
SCSS, Sass, and Less wait for a 750 ms quiet period within a two-second build
window; generated CSS resets settlement to 150 ms. JavaScript, TypeScript, Vue,
PHP, and HTML reload candidates settle for 150 ms, and reload wins a mixed
burst.
Unchanged saves do not publish refreshes.

### Source Plugins

Built-in CSS and SCSS resolvers use source-plugin API v3, the same versioned API
available to separately installed VS Code extensions. API v3 also accepts
synchronous refresh classifiers. This document-first, protocol-driven boundary
keeps the browser independent of the IDE and permits future IDE adapters to
implement the same v7 contract.

Source lookup first chooses a workspace strategy. Workspace-bound resolution is
selected when the document or stylesheet URL path begins with an open workspace
folder name. Pin-op strips that leading segment once and searches only that
folder. For example, `http://localhost/_ORB/` and
`/_ORB/wp-content/themes/orbiter/style.css?v=7` bind source lookup to the open
`_ORB` folder, so duplicate basenames elsewhere do not create ambiguity. The
local diagnostic is `Workspace-bound: _ORB` (generally
`Workspace-bound: <folder>`).

When neither URL supplies a workspace identity, automatic resolution keeps the
existing exact-path and unique-basename search across all open folders. Its
local diagnostic is `Automatic source matching`; this convenience means the
user accepts the risk of a coincidental automatic mapping.

The CSS resolver prefers exact source position or CSSOM rule-path evidence. A
workspace-bound CSS source miss never fingerprint-matches an unrelated active
CSS document. Automatic CSS may retain the conservative fingerprint fallback,
which uses normalized selector, media conditions, and declaration evidence;
zero or multiple candidates fail closed.

The SCSS resolver reads generated CSS from the workspace, identifies one
generated rule, loads its local inline or external source map, and accepts only
a mapping into the exact active SCSS document. Automatic unique-basename
matching may locate generated CSS and is diagnosed, but a basename-only match
can never authorize the original SCSS source. Missing, invalid, ambiguous,
unmapped, and other-document outcomes fail closed.

Plugins return semantic ranges. Core owns all editor UI. The authoring contract
is in [source-plugin-authoring.md](source-plugin-authoring.md).

## Data Flow

### Link

1. VS Code starts a loopback bridge and displays `<port> <PIN>`.
2. The user copies that code and submits it in one DevTools panel.
3. The browser connects only to the encoded endpoint and exchanges the PIN for
   session credentials.
4. The panel displays the same grouped code stored in that browser window's
   session record.

### Browse And Select

1. The panel asks the inspected tab for the root through its private channel.
2. Expanding a row requests one bounded child page for the current document
   epoch and branch revision.
3. Picker hover or tree-row hover updates the browser-local overlay.
4. Picker click or tree selection resolves a live element through the same
   authority and updates the tree ancestor path.
5. Only then does the browser collect and publish bounded selected/immediate-
   parent facts as a protocol-v7 inspect message.

### Run Chromium's UI On Gecko

The DOM Tree and Rules panes are Chromium's own, so they assume Blink's DOM.
Where Gecko lacks a Blink-only API the shared runtime installs a narrow,
reviewed shim before any upstream code runs, rather than forking the vendored
source. Today that is `ShadowRoot.getSelection()`: Gecko does not implement it,
Chromium's `Node.hasSelection()` is the first line of every tree click handler,
and without the shim a missing method threw the whole interaction away -- rows
would not open. Gecko does not scope selection to a shadow root, so the
document's selection is the same answer Blink gives.

It also assumes it owns the whole surface: a selected row's band is painted
behind the row at `z-index: -1`, which only shows through while every ancestor
background is transparent. Pin-op paints its own panel surface, so each row is
given its own stacking context and the band stays inside it.

Chromium's tree also assumes it owns the selection: `selectDOMNode()` re-centres
the row it selects, every time. Pin-op routes every selection through it, so a
row the reader could already see is selected in place and the scroll position is
left alone; only a row that is off screen is scrolled into view.

### Survive A Suspended Background

Browsers stop an idle extension background whenever they like: Chrome unloads
the MV3 service worker, Firefox unloads the event page. Everything the panel was
showing belongs to a content session that dies with it, so the panel treats the
dropped port as a blip rather than an ending.

1. The panel freezes the tree on what it last showed and keeps the stable
   locators for the selected and expanded rows.
2. The reconnect wakes a fresh background, which starts a new inspection session
   and injects the content script again.
3. The panel restores the frozen selection from its locators against the new
   content session, so the same element, tree and Rules come back.
4. A read that reaches the background before its content lease has attached
   waits for that lease instead of failing closed -- but only until the panel has
   held one. After that a read with no lease has crossed a session boundary the
   panel was told about, and it still fails closed.
5. A restore that still outruns the content session keeps the frozen tree and
   retries on the next window state, a bounded number of times; after that the
   panel reloads the tree rather than staying frozen on stale rows.

Matched rules are handed to the UI in cascade order -- the winning rule first,
low-weight rules such as `*` and `:root` last -- which is how an inspector is
read. Only the presentation is ordered; the cascade classification itself runs
on document order and keeps its own source ordering.

### Resolve And Present

1. The bridge validates the inspect envelope, registers its targeted reply
   route, and sends it to the IDE peer.
2. The presenter asks compatible source plugins to resolve the active document.
3. Core renders accepted Selected and Parent ranges when IDE Highlight is on.
4. The IDE sends one bounded resolution status, counts, and active-document
   Source excerpts. Turning IDE Highlight off clears decorations only; it does
   not discard resolution, Source presentation, or navigation authority.
5. The bridge routes that reply only to the browser connection that originated
   the inspect message; the panel renders the exact footer outcome and Source
   pane. Previous/Next remains Selected-only.
6. Independently, the IDE resolves the complete correlated rule-evidence batch
   and publishes a newer `rules.sources` generation through the same exact route.
7. Rules replaces a generated label only with a verified CSS or source-mapped
   SCSS label. An explicit origin click sends only `rules.open` correlation and
   the opaque authority; the IDE may then switch files and reveal its private
   exact block after pre/post revalidation.

### Preview Author Pseudo States

1. The Rules `:hov` control replaces the requested canonical state set with
   `:hover`, `:focus`, both, or neither through the browser-local Inspector
   channel; it never sends pseudo state over the product WebSocket.
2. The content session compares document, node, selection, styles, and pseudo
   revisions before applying the request.
3. Supported readable author rules are mirrored only for the selected element's
   accessible document or open-shadow scope. Unsupported and inaccessible work
   is returned as partial counts.
4. A successful change advances the pseudo-state and aggregate styles revisions
   without changing stylesheet identity. Rules is re-collected against that
   exact correlated generation.
5. Controlled replacement, selection, recovery, refresh, navigation,
   disconnect, compatibility loss, and disposal remove the exact owned marker
   and stylesheet objects synchronously while the content context is alive.
   Abrupt extension termination may leave artifacts until page navigation or
   reload because no context remains to perform object-identity cleanup.

### Refresh After Save

1. VS Code records actual document changes and ignores an unchanged save.
2. Built-in or plugin API v3 classifiers choose `styles` or `reload`; `reload`
   wins a mixed burst.
3. The IDE publishes one v7 `page.refresh` generation to linked browsers.
4. The browser applies it only to participating tabs with Auto Refresh on.
5. `styles` clones and cache-busts eligible top-document external HTTP(S)
   stylesheet links, removing the old link only after the replacement loads.
6. `reload` captures bounded top-level scroll, reloads the current tab, and
   restores scroll in the replacement document. Inline, adopted, data/blob
   stylesheets and iframe refresh are outside this behavior.

## Data Separation

The DOM tree, node refs, expansion state, ancestor paths used for tree reveal,
and box-model geometry stay inside the browser extension. They are not protocol
facts and are not available to VS Code.

The product WebSocket receives the bounded selection snapshot needed for source
resolution: page context, selected/immediate-parent subjects, CSS facts,
correlated rule evidence, and inaccessible-stylesheet diagnostics. In the
reverse direction it can carry at most 32 active-document excerpts, each capped
at 80 logical lines and 8 KiB, inside a 256 KiB message, plus sanitized Rules
origin labels/start positions and opaque IDs. Full source documents, workspace
paths and URIs, full editor ranges, document versions, source maps, browser tab
IDs, and browser-local locators do not cross it.

## Trust Boundaries

The inspected page is untrusted. The content runtime bounds reads, renders
labels as text, excludes its own overlay, rejects stale identities, and fails
closed across inaccessible DOM boundaries.

The loopback bridge is authenticated but not a defense against every process
running as the same desktop user. The two-digit PIN prevents accidental local
cross-linking; it is not strong authentication. The bridge checks extension
origins, handshake order, roles, session identity, message size, and schemas.

VS Code and installed source plugins can read workspace documents. Separately
installed plugins are independently trusted extension code. Pin-op itself has
no remote service and exposes no user-authored CSS/DOM editing operation,
source write, or arbitrary command path. Its extension-owned noninteractive
overlay lives in an isolated shadow DOM. Pseudo preview temporarily adds
extension-owned marker attributes and mirror styles in the selected accessible
scope; those artifacts are page-observable and follow the cleanup boundary
described above. The other narrow page-DOM exception is `styles` Auto Refresh:
it inserts a cloned external top-document HTTP(S) stylesheet link, removes the
old link only after the clone loads successfully, and retains the old link on
failure. Reload mode uses the browser tab reload API. Neither refresh mode is a
caller-supplied command.

Rules navigation does not broaden the browser into workspace authority. Only a
current IDE-issued opaque authority from an explicit origin click can request a
file switch, and the IDE revalidates all private dependencies before cursor and
reveal. No workspace URI/path, full range, document version, or command crosses
the bridge.

See [protocol.md](protocol.md), [security.md](security.md), and
[../PRIVACY.md](../PRIVACY.md) for the complete contracts.
