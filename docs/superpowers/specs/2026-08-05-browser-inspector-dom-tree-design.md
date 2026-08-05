# Browser2IDE Browser Inspector And DOM Tree Design

**Date:** 2026-08-05
**Status:** Approved for implementation planning

## Summary

Browser2IDE will replace its click-only browser picker with an Inspector-like
experience shared by Firefox and Chrome. The DevTools panel will show a live,
lazy DOM element tree. Hovering either the page or the tree will highlight the
corresponding element on the page. Selecting from either surface will use one
selection pipeline and send the existing bounded runtime evidence to the linked
VS Code window.

The browser panel will continuously identify its linked IDE with the same
seven-digit link code shown by VS Code, for example `48735 07`. The adjacent
action will be `Disconnect`, not Copy. Disconnecting revokes the browser token,
forgets the browser-window binding, disables inspection, and returns the panel
to link-code entry.

VS Code will return a bounded `resolution` message after processing each
selection. The panel will report either the number of highlighted rules or a
specific reason why no highlight was produced. The CSS resolver will also gain
a conservative selector-and-declaration fallback when precise CSSOM evidence
does not match the active local file.

## Context

The installed `0.2.0` workflow successfully sends inspect events from Firefox
through the bridge to VS Code, but a selection can produce no visible result.
The current presenter resolves only against the active local CSS or SCSS file.
Unsupported documents, unresolved source URLs, inaccessible stylesheets,
source-map failures, and CSSOM/local-file differences all result in an empty
presentation with little or no visible explanation.

The current browser UI also provides no proof that the intended DOM element was
selected. `InspectMode` owns one captured click listener but has no hover state,
page overlay, selected-node summary, or DOM tree. These are related product
problems: the new Inspector UI must make browser selection visible, while the
new resolution response must make IDE source resolution visible.

## Goals

- Match the familiar interaction model of browser Inspector element pickers.
- Show a navigable live tree of DOM elements in the Browser2IDE DevTools panel.
- Keep page selection and tree selection synchronized through one code path.
- Keep the picker active across repeated selections for live inspection.
- Display the linked VS Code window code while the link is active.
- Replace the connected-state Copy action with an explicit Disconnect action.
- Report successful and unsuccessful VS Code resolution in the browser panel.
- Preserve document-first source-plugin dispatch and active-file highlighting.
- Make CSS matching resilient to safe CSSOM/local-file differences.
- Preserve Firefox/Chrome parity through the shared browser-extension core.
- Keep the bridge a validated WebSocket relay with no DOM ownership.
- Preserve Browser2IDE's read-only security boundary.

## Non-Goals

- Editing DOM nodes, attributes, text, CSS, or workspace files.
- Replacing the browser's complete native Elements/Inspector tool.
- Opening or switching VS Code files after browser selection.
- Showing text nodes, comments, or selectable `::before` and `::after` nodes.
- Reading closed Shadow DOM.
- Traversing cross-origin iframe documents in this milestone.
- Guessing nested SCSS when a usable source map is unavailable.
- Adding React, Vue, template, WordPress, or other framework source plugins.
- Sending a full DOM snapshot or general page content to VS Code.
- Adding HTTP product endpoints, remote bridges, or cloud relay services.
- Preserving wire compatibility with protocol version 3. All Browser2IDE
  artifacts are migrated and released together.

## User Experience

### Connected Header

The connected panel header contains:

```text
Browser2IDE     Connected     48735 07     [Disconnect]
```

The code is the exact five-digit bridge port plus two-digit link PIN. It is
shown with a space but has no Copy action in the browser. The code identifies
the linked VS Code window when several IDE windows are open, but it also remains
a reusable pairing credential for the lifetime of that VS Code bridge.

`Disconnect` performs the existing full unlink semantics:

1. disable picker and tree interaction;
2. ask the reachable bridge to revoke the browser token;
3. close the browser-window WebSocket;
4. delete the browser-window session binding and retained display code;
5. return every Browser2IDE panel in that browser window to code entry.

A subsequent connection requires explicit code entry. There is no dormant
linked state after Disconnect. Disconnect revokes only this browser window's
token; it does not rotate the bridge PIN or disconnect other explicitly linked
browser windows. Stopping and starting Browser2IDE in VS Code creates a new PIN
and bridge instance and revokes every existing browser token.

### Element Picker

The picker is a compact cursor-icon toggle like the native Inspector picker.
When active:

- pointer movement previews the element under the pointer;
- the page displays box-model overlays for margin, border, padding, and content;
- a label displays bounded `tag#id.classes` text and rendered dimensions;
- all client rectangles of a multi-line inline element are represented;
- captured `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`,
  `dblclick`, `auxclick`, `contextmenu`, `touchstart`, and `touchend` events are
  suppressed as one picker interaction sequence so page handlers cannot act
  before selection; a trusted primary sequence selects exactly once on `click`,
  reveals the element in the tree, and publishes the selection;
- the picker remains active after a selection;
- the first `Escape` clears current hover preview, and a second `Escape` with
  no hover disables the picker;
- closing DevTools, disconnecting, navigating, or losing the panel lease
  disables the picker and removes every overlay artifact.

Picker actions require `event.isTrusted`, the primary button, and an active
panel-owned lease. Synthetic page events cannot select an element or publish an
inspect message. Exactly-once interaction tracking and a bounded selection rate
prevent one physical action or a hostile event burst from flooding the bridge.

The selected element remains identified in the tree and result footer after a
hover preview ends. Page hover emits at most one browser-local tree update per
animation frame. If the matching row is already materialized, the panel marks
it as hovered; otherwise the panel updates only its bounded hover summary and
does not expand or scroll the tree. Selection, unlike hover, always reveals the
ancestor path. Hover is temporary; selection is persistent until another
element is selected or the document changes.

### DOM Tree

The DOM tree is available while the current browser window is linked and the
DevTools panel has a valid inspected-tab session. It displays element nodes
only. Rows show bounded tag, ID, classes, and the same bounded `role`, `data-*`,
and `aria-*` attribute values permitted by the current inspect subject. They do
not expose form values, text-node contents, event-handler source, or unbounded
attribute data.

The tree behaves like a standard accessible tree control:

- disclosure arrows expand and collapse branches;
- children load lazily in bounded pages;
- `Up` and `Down` move between visible rows;
- `Left` collapses or moves to the parent;
- `Right` expands or moves to the first child;
- `Enter` selects the focused element;
- hovering a row previews that element on the page;
- clicking a row selects it even when the page picker is off;
- a page selection automatically expands and scrolls to its ancestor path.

Open shadow roots appear as explicit pseudo-containers whose element children
can be expanded. Closed shadow roots remain opaque. A same-origin iframe node
can expose its document subtree. A cross-origin iframe is shown as a terminal,
inaccessible branch with no attempt to bypass origin restrictions. Loading or
navigating an accessible iframe invalidates that frame subtree and all of its
old node references without resetting unrelated top-level branches. Each
accessible frame document owns its own mutation observer. Overlay rectangles
from nested documents are translated through the same-origin frame-element
chain into top-level viewport coordinates and recomputed when any frame or the
top-level viewport scrolls or resizes.

`MutationObserver` invalidates only affected expanded branches after a short
debounce. The panel virtualizes visible rows and does not materialize the whole
document. Navigation creates a new document epoch, clears old rows and
selection, and invalidates every old node reference.

### Resolution Footer

Immediately after selection, the footer shows the selected element summary and
`Resolving in VS Code`. A correlated IDE response replaces it with one of:

- `<n> rules highlighted`, with separate Selected and Parent counts;
- `No active editor`;
- `Unsupported active file: <language>`;
- `No CSS facts`, including the inaccessible stylesheet count when nonzero;
- `CSS source not found in workspace`;
- `Stylesheet resolves to a different workspace file`;
- `Ambiguous source path`;
- `SCSS source map missing`;
- `SCSS source map invalid`;
- `No matching rules in active file`;
- `Ambiguous rule match`;
- `VS Code disconnected`;
- `Resolution failed` with a stable diagnostic code.

Switching the active VS Code editor reruns the latest retained selection and
updates the browser footer without another browser click. Detailed local paths,
stack traces, and plugin messages remain in VS Code diagnostics. The browser
receives only a bounded active-document label, language ID, counts, and stable
reason codes.

## Runtime Architecture

```text
Inspected page content script
  PageInspectionSession
    -> PageOverlay
    -> DomNodeRegistry
    -> FrameRegistry
    -> DomTreeProvider
    -> existing inspect-payload collection
          |
          | strict browser-local messages
          v
Browser2IDE DevTools panel
  DomTreeController + DomTreeView
  connection header + resolution footer
          |
          | authenticated WebSocket inspect
          v
Local bridge relay
          |
          v
VS Code
  SelectionStore -> ActiveEditorCoordinator -> SourcePluginRegistry
  -> decorations + Applicable Sources
          |
          | authenticated WebSocket resolution
          v
Originating Browser2IDE panel
```

### Shared Browser Components

`PageInspectionSession` is the single authority for hovered and selected page
elements. Both page pointer events and tree commands call the same `hover`,
`clearHover`, and `select` operations. Only `select` creates and publishes an
inspect payload.

`DomNodeRegistry` maps live elements to opaque `nodeRef` values. Forward lookup
uses `WeakMap<Node, nodeRef>`; reverse lookup uses a bounded
`Map<nodeRef, WeakRef<Node>>`. Only selected, hovered, and currently expanded
nodes receive temporary strong ownership. Invalidation, collapse, removal, and
navigation release those strong references and prune dead reverse entries. A
reference is scoped to one inspected tab, frame/document context, and
`documentEpoch`. It is not a CSS selector, HTML `id`, or stable identifier.
References cannot be reused after navigation or in another panel/tab.

`FrameRegistry` assigns bounded `frameRef` and `frameEpoch` values to the
top-level document and each accessible same-origin frame document. It installs
picker listeners and a mutation observer in every accessible document,
translates overlay rectangles through the frame-element chain, and invalidates
one frame subtree when that frame loads or navigates. Cross-origin frames never
receive a registry entry for their document contents.

`DomTreeProvider` exposes a bounded root, ancestor paths, and paginated child
queries. It serializes display metadata, not DOM objects or HTML. It handles
open shadow-root containers and accessible same-origin frame documents, and it
marks inaccessible frame boundaries. Each discovered open `ShadowRoot` gets
its own observer. Child queries always re-check `element.shadowRoot`, and a
low-frequency bounded check of expanded hosts discovers late-created open roots
without instrumenting page JavaScript. Closed roots remain inaccessible.

`PageOverlay` owns a style-isolated overlay host with `pointer-events: none`.
It uses `getBoundingClientRect()`, `getClientRects()`, and computed box values.
Pointer, scroll, and resize changes are coalesced to one update per animation
frame. The overlay host and descendants are excluded from hit testing and tree
serialization.

`DomTreeController` owns expanded nodes, loaded child pages, virtualized rows,
keyboard focus, hover, selection, and stale-response rejection. `DomTreeView`
renders labels through DOM text APIs and never inserts page-provided strings as
HTML.

Firefox and Chrome adapters continue to provide only their platform APIs.
Inspection behavior remains in `packages/browser-extension-core`.

### Browser-Local Protocol

Panel/background/content communication gains a strict internal protocol. It is
not part of the public WebSocket protocol and is never accepted from a page:

```text
dom.getRoot(requestId, documentEpoch?)
dom.getChildren(requestId, documentEpoch, nodeRef, branchRevision, cursor?)
dom.select(documentEpoch, nodeRef)
dom.hover(documentEpoch, nodeRef)
dom.clearHover(documentEpoch)

dom.root(requestId, documentEpoch, node)
dom.children(requestId, documentEpoch, nodeRef, branchRevision, nodes, nextCursor?)
dom.hoverChanged(documentEpoch, nodeRef?, summary?)
dom.selectionChanged(documentEpoch, nodeRef, ancestorPath)
dom.invalidated(documentEpoch, branches[{ nodeRef, branchRevision }])
dom.error(requestId?, documentEpoch?, code)
```

Every message is shape-validated and size-bounded. Requests are bound to the
DevTools channel and inspected tab registered by the background. A panel cannot
address another tab by supplying a tab ID. Unknown references, stale epochs,
and requests after channel disposal fail closed. Every child cursor is bound to
its node reference and `branchRevision`. Mutations increment the affected
revision before invalidation, and the panel discards child pages whose revision
does not equal the latest revision it has observed.

The content-script session exists while a linked panel owns the inspected-tab
lease. The picker event listeners are a separately toggled capability so tree
selection works while the picker is off.

### WebSocket Protocol Version 4

Protocol version 4 adds strict IDE-to-browser `resolution` and bridge-to-browser
`peerState` messages. `ResolutionSource`, diagnostic codes, and empty metadata
are closed schemas rather than the extensible `ClientSource` and `JsonObject`
forms used by inspect facts:

```ts
type EmptyMetadata = { readonly [key: string]: never };

type ResolutionSource = {
  readonly role: "ide";
  readonly id: BoundedOpaqueId;
};

type ResolutionDiagnosticCode =
  | "resolver.plugin-error"
  | "resolver.plugin-timeout"
  | "resolver.invalid-result"
  | "resolver.source-read-failed";

interface ResolutionMessage {
  readonly protocolVersion: 4;
  readonly type: "resolution";
  readonly messageId: string;
  readonly sessionId: string;
  readonly source: ResolutionSource;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly document?: {
    readonly label: string;
    readonly languageId: string;
  };
  readonly status:
    | "matched"
    | "no-active-editor"
    | "unsupported-document"
    | "no-facts"
    | "source-not-found"
    | "source-not-active-document"
    | "source-ambiguous"
    | "source-map-missing"
    | "source-map-invalid"
    | "no-rule-match"
    | "rule-match-ambiguous"
    | "error";
  readonly selectedMatchCount: number;
  readonly parentMatchCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly diagnosticCodes: readonly ResolutionDiagnosticCode[];
  readonly metadata: EmptyMetadata; // strict object with zero keys
}

interface PeerStateMessage {
  readonly protocolVersion: 4;
  readonly type: "peerState";
  readonly messageId: string;
  readonly sessionId: string;
  readonly role: "ide";
  readonly connected: boolean;
  readonly peerGeneration: number;
  readonly metadata: EmptyMetadata;
}
```

Counts and `resolutionGeneration` are nonnegative bounded integers. Document
labels and diagnostic lists have explicit length limits, diagnostic codes have
a closed enum, and a resolution envelope is limited to 16 KiB. `matched`
requires at least one visible, deduplicated decoration match. The Selected and
Parent counts are calculated after range validation, deduplication, and
Selected-over-Parent precedence. Non-matched statuses require both match counts
to be zero.

Before writing an inspect message, the browser background generates its
`inspectMessageId`, records the originating inspected tab and DevTools channel,
and calls `BrowserBridgeClient.sendInspect(inspectMessageId, payload, sourceId)`.
The client no longer creates an ID internally for this call. It still reports a
bounded send outcome; a failed send removes the just-created correlation and
immediately produces the disconnected panel state.

When the bridge receives the inspect message, it records a bounded reply route
from `(sessionId, inspectMessageId)` to the sending registered browser
connection. Resolution routing uses that entry and never broadcasts IDE source
results to every browser client in a session. Routes contain no payload, are
bounded to 256 least-recently-used entries per browser connection, and are
removed on browser disconnect or eviction. A routed resolution refreshes its
entry so active-editor re-evaluation can continue while the panel is active.

The originating browser background then delivers a resolution only to its
recorded panel channel. A panel accepts a result only when the inspect ID equals
its current selection. Closing the panel drops its local correlation state.
Re-evaluation after an active-editor change reuses the inspect ID and increments
`resolutionGeneration`; the panel accepts only the greatest generation seen for
that inspect ID.

The bridge sends the current `peerState` snapshot after browser authentication
and emits a new one when the IDE-client count for a session transitions between
zero and nonzero. `peerGeneration` prevents stale connection events.
On `connected: false`, the panel displays `VS Code disconnected`. On a later
`connected: true`, the background asks each active `PageInspectionSession` with
a still-live selected element to republish that selection with a new inspect ID;
it does not synthesize a page click or reuse an expired reply route.

The bridge continues to validate and relay payloads. Its only new state is
bounded reply-routing and peer-generation bookkeeping. It stores no DOM tree,
node reference, inspect payload, selection model, or source-resolution payload.

## VS Code Resolution

### Coordinator Outcomes

`ActiveEditorCoordinator` will publish an explicit outcome for every current
selection generation, including missing-editor and unsupported-document cases.
The source-plugin registry will report why no plugin ran instead of returning a
silent empty result.

When several failure conditions are present, status precedence is deterministic:
`no-active-editor`, `unsupported-document`, `no-facts`, source resolution,
source-map resolution, rule matching, then `error`. A successful nonempty match
always produces `matched` regardless of nonfatal plugin diagnostics. Source
resolution reduces in this order: ambiguous, resolved-to-different-file,
not-found, then downstream source-map or rule outcomes.

The existing `SelectionStore` and document-first behavior remain unchanged:
Browser2IDE never opens or switches an editor. A new inspect, active-editor
change, active-document edit, or source-plugin registry change reruns the
selection. Successful resolution updates Selected and Parent decorations,
`Applicable Sources`, VS Code diagnostics, and the browser resolution footer.

### CSS Matching

`CssSourcePlugin` resolves each selected and immediate-parent rule using this
ordered strategy:

1. resolve the browser stylesheet URL to workspace candidates;
2. prefer an exact active-document URI and CSSOM rule path/position;
3. if the path does not resolve in the local AST, fall back to a normalized
   selector plus declaration fingerprint within that active document;
4. if source resolution is wholly `not-found`, permit a heuristic only when the
   active document contains exactly one strong selector-and-declaration
   candidate;
5. if the source resolves to another workspace file or is ambiguous, reject it
   without searching the active document;
6. reject multiple strong candidates as `rule-match-ambiguous` rather than
   selecting one arbitrarily.

A declaration fingerprint uses normalized property names, values, priorities,
and available enclosing-condition metadata. It does not require every runtime
declaration when browser limits truncate a fact, but it requires enough common
evidence to avoid selector-only matches when duplicate selectors exist.

Precise path/position matches retain `exact` confidence. Unique fingerprint
fallbacks use `heuristic`. Complete rule blocks remain the returned ranges.
Every applicable block in the active CSS file is preserved when evidence
distinguishes multiple valid rules, such as separate active media contexts.

### SCSS Matching

`ScssSourcePlugin` continues to prefer generated CSS resolution followed by a
usable source map and original SCSS position. It receives the improved CSS
generated-rule lookup but does not infer nested SCSS selectors when mapping is
missing or invalid.

Missing generated CSS, ambiguous generated paths, missing source maps, invalid
maps, missing original sources, and unmapped generated positions become stable
resolution diagnostics. An active SCSS file is highlighted only when the map
resolves to that document.

Inline and runtime-injected styles remain visible as unmapped browser facts.
Future source plugins may resolve them, but CSS and SCSS plugins do not invent a
workspace owner.

## Connection-Code Storage

Showing `48735 07` after linking requires retaining the entered PIN for the
link's lifetime. This intentionally narrows the earlier rule that the browser
never stores the PIN:

- the normalized display code is kept only in extension session storage for
  the linked browser-window record;
- it is shared only with Browser2IDE panels in that browser window;
- it is never written to persistent local/sync storage, logs, diagnostics,
  telemetry, page DOM, or WebSocket messages after link establishment;
- it is cleared on Disconnect, browser-window close, bridge-instance mismatch,
  token rejection, or establishment of a new explicit link;
- the existing high-entropy role-bound token remains the actual authenticated
  credential after linking.

The displayed code is nevertheless a reusable pairing credential: another
browser window can exchange it for its own token while that bridge instance is
running. Disconnect revokes only the current browser token. Users who need to
invalidate the displayed code and every issued token stop and start the bridge
from the VS Code status bar.

This is acceptable only within the existing localhost, read-only MVP threat
model. Any future write capability still requires stronger pairing and explicit
IDE approval regardless of whether the code is displayed.

## State, Errors, And Recovery

- The panel enters `resolving` locally as soon as a selection is published.
- A newer selection cancels or supersedes previous browser and IDE work.
- Navigation changes `documentEpoch`, clears overlay/tree state, and rejects
  all pending tree responses from the previous document.
- DOM removal of a selected node clears its overlay and marks the selection
  stale until another element is selected.
- A temporary content-script disconnect attempts bounded session recovery while
  the panel and inspected tab remain valid.
- IDE connection loss produces `VS Code disconnected`; reconnecting reruns or
  republishes the latest selection only through an explicit, bounded recovery
  path and never duplicates page click effects.
- Unsupported or protected pages show a panel error and never leave picker UI
  enabled without a working content session.
- Cross-origin stylesheet failures contribute to the inaccessible count and do
  not abort facts from readable stylesheets.
- Internal protocol and source-plugin errors are sanitized before presentation.

## Security And Privacy

- Full DOM data and `nodeRef` values never enter the public WebSocket protocol.
- Only the existing bounded selected/parent subjects and runtime facts leave the
  browser, plus the page URL context already defined by the protocol.
- No new browser permissions are required beyond the existing inspected-page
  scripting and host access.
- The content script uses an isolated, noninteractive overlay and never executes
  page script or reads framework JavaScript state.
- Tree labels are bounded and rendered with text APIs, preventing markup or
  script injection into the extension panel.
- Node references are opaque, epoch-scoped, channel-bound, and useless outside
  their originating document.
- Child pagination, row virtualization, message limits, and debounced mutation
  invalidation bound memory and CPU consumption on large documents.
- The page cannot send trusted panel commands, choose an inspected tab, or
  trigger IDE commands.
- Browser2IDE remains unable to edit source, modify page state intentionally,
  or execute arbitrary commands.

## Testing Strategy

### Browser Core Unit Tests

- picker hover, primary click, repeated selection, two-stage Escape, cleanup,
  complete primary-event suppression, exactly-once publication, and
  `composedPath()` handling;
- overlay geometry, box-model layers, multiple client rectangles, scroll and
  resize updates, and overlay-host exclusion;
- opaque node allocation, document epochs, stale and cross-session references;
- lazy roots and children, pagination, ancestor paths, open shadow roots,
  same-origin frame coordinate translation and navigation, inaccessible frames,
  per-document observers, and mutation invalidation;
- one shared selection path for page and tree selection;
- throttled page-to-tree hover without expansion or scroll churn;
- strict internal message validation and bounded serialization;
- panel expansion, virtualization, keyboard navigation, hover, selection,
  connection-code display, Disconnect, and every resolution state;
- tab/channel binding, origin-only resolution delivery, stale resolution
  rejection, branch-revision races, synthetic-event rejection, selection rate
  limiting, and panel disposal.

### Protocol, Bridge, And VS Code Tests

- protocol version 4 resolution schema acceptance and malformed-message
  rejection;
- bridge reply-route registration, targeted IDE-to-browser resolution,
  per-connection LRU eviction, disconnect cleanup, peer-state generations, and
  malformed-route rejection;
- resolution correlation across multiple inspected tabs in one browser window;
- resolution isolation across multiple browser windows linked to one IDE;
- coordinator outcomes for no editor, unsupported document, no facts, match,
  diagnostic failure, cancellation, and editor changes;
- CSS exact path resolution, path-miss fingerprint fallback, source-miss unique
  fallback, known-other and source-ambiguous rejection, duplicate ambiguity,
  conditional rules, and complete block ranges;
- SCSS successful mapping plus every missing/invalid/ambiguous map outcome;
- Selected and immediate-Parent range precedence and decoration colors.

### Integration And Packaged Verification

An expanded fixture will include exact CSS, source-mapped SCSS, CSSOM/local
structure differences, duplicate selectors, inline/runtime CSS, inaccessible
cross-origin stylesheets, dynamic DOM, an open shadow root, same-origin and
cross-origin iframe boundaries, and multi-line inline content.

The automated gate includes workspace build, tests, typecheck, lint, Firefox
`web-ext lint`, VSIX installed smoke, Firefox package verification, and Chrome
packaged smoke. Manual installed-artifact verification covers Firefox Stable
and current Chrome/Chromium with no contributor terminal in the normal usage
flow.

Panel and page-overlay screenshots are checked at narrow and wide DevTools
sizes. Visual verification confirms nonblank tree output, stable toolbar and
footer dimensions, no text overlap, correctly aligned overlay labels, readable
selected/focused states, and synchronized page/tree selection.

## Acceptance Criteria

1. The connected browser panel visibly shows the exact linked VS Code code and
   a working Disconnect action.
2. Hovering a page element produces an Inspector-style box-model overlay and
   label without triggering page behavior.
3. Clicking a page element selects it, keeps picker mode active, reveals the
   corresponding tree row, and sends one inspect selection.
4. Hovering and selecting tree rows synchronizes the page overlay and uses the
   same inspect pipeline even when picker mode is off.
5. Dynamic DOM changes update affected expanded branches without replacing the
   full tree or retaining stale node references.
6. VS Code highlights all resolved blocks in the active CSS/SCSS file, with a
   distinct color for the immediate parent's blocks.
7. A missing highlight always produces one documented resolution state in the
   browser and detailed diagnostics in VS Code.
8. Safe CSS fingerprint fallback resolves unique strong candidates and refuses
   ambiguous candidates.
9. Full DOM tree data, local paths, and node references never cross the public
   Browser2IDE WebSocket boundary.
10. Firefox and Chrome adapters pass the same shared behavior suites and require
    no new permissions.
11. Resolution details reach only the browser connection and panel that
    originated the correlated inspect message.

## Documentation And Release Impact

Implementation updates protocol, architecture, security, usage, installed
verification, contributor verification, browser store/privacy materials, and
release notes. The browser and VS Code extension versions advance together
because protocol version 4 is intentionally incompatible with version 3.

The release runbook must verify the installed-artifact workflow that originally
exposed the silent-resolution problem. Screenshots and repository media should
show the connected code, Inspector overlay, DOM tree, VS Code decorations, and
an explicit successful or failed resolution state.
