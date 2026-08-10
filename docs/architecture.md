# Architecture

Browser2IDE is a local, read-only bridge from browser DevTools inspection to
source highlighting in VS Code. Product semver is `0.3.0`; the independent wire
protocol version is `4`.

## Components

### DevTools Panel

Firefox and Chrome/Chromium build the same Browser2IDE panel from the shared
browser core. The panel owns:

- explicit browser-window link controls and the displayed port-plus-PIN code;
- a visual page picker;
- a virtualized, lazy DOM tree;
- the selected-element summary and exact IDE resolution footer.

Each panel receives an opaque browser-extension channel. DOM requests and events
are routed through that channel to the inspected tab, never through the product
WebSocket.

### Inspected-Page Runtime

The content runtime owns the browser-local Inspector session. One selection
authority serves both page clicks and DOM-tree commands. It:

- renders a style-isolated, pointer-inert box-model overlay;
- exposes element-only tree pages on demand;
- traverses the top document, open shadow roots, and same-origin frame
  documents;
- represents cross-origin frames as inaccessible locked leaves and ignores
  closed shadow roots;
- collects bounded page, DOM, and CSS facts only for a valid selection;
- emits one selected target and, when present, its immediate DOM parent.

Browser-local node refs are scoped by panel channel, document epoch, frame
identity/epoch, and branch revision. Cursors are also bound to their node,
epoch, and revision. Mutation, navigation, collapse, frame lifecycle changes,
and session disposal invalidate stale authority instead of guessing.

### Browser-Window Coordinator

The extension background owns one session link per browser window in
`browser.storage.session`. The record contains the exact loopback endpoint,
session and bridge identities, browser token, and formatted display code. Panels
in one window share at most one active authenticated WebSocket. A different
browser window has independent state.

Disconnect revokes and removes only the current browser window's record. Closing
the final panel closes its socket without converting session storage into
durable storage.

### Protocol And Bridge

Protocol version `4` defines strict handshake, inspection, targeted resolution
reply, peer state, error, and heartbeat messages. Every product message is
validated before routing.

The bridge binds one managed port on `127.0.0.1`. A link request to that exact
port exchanges the two-digit PIN for a role-bound browser token. The bridge does
not scan ports or discover clients.

For each accepted inspect message, the bridge records a bounded reply route from
`sessionId` plus `inspectMessageId` to the originating browser connection. IDE
resolution messages return only through that route, so another linked browser
connection cannot receive the reply. The bridge also publishes monotonically
generated IDE peer state when IDE availability changes.

### VS Code Presenter

Each local VS Code window starts its bridge automatically. The status bar shows
the managed port and two-digit PIN and copies the ungrouped code on click.

The presenter retains the latest valid selection and resolves it against only
the active text document. It never switches editors. It owns Selected and Parent
decorations, validates and deduplicates plugin ranges, updates Applicable
Sources, and sends a bounded protocol-v4 resolution outcome back to the
originating panel.

### Source Plugins

Built-in CSS and SCSS resolvers use the same versioned API available to
separately installed VS Code extensions.

Source lookup first chooses a workspace strategy. Workspace-bound resolution is
selected when the document or stylesheet URL path begins with an open workspace
folder name. Browser2IDE strips that leading segment once and searches only that
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
   parent facts as a protocol-v4 inspect message.

### Resolve And Present

1. The bridge validates the inspect envelope, registers its targeted reply
   route, and sends it to the IDE peer.
2. The presenter asks compatible source plugins to resolve the active document.
3. Core renders all accepted Selected and Parent ranges.
4. The IDE sends one bounded resolution status and counts.
5. The bridge routes that reply only to the browser connection that originated
   the inspect message; the panel renders the exact footer outcome.

## Data Separation

The DOM tree, node refs, expansion state, ancestor paths used for tree reveal,
and box-model geometry stay inside the browser extension. They are not protocol
facts and are not available to VS Code.

The product WebSocket receives only the bounded selection snapshot needed for
source resolution: page context, selected/immediate-parent subjects, CSS facts,
and inaccessible-stylesheet diagnostics. Workspace source and source maps stay
inside the VS Code extension host.

## Trust Boundaries

The inspected page is untrusted. The content runtime bounds reads, renders
labels as text, excludes its own overlay, rejects stale identities, and fails
closed across inaccessible DOM boundaries.

The loopback bridge is authenticated but not a defense against every process
running as the same desktop user. The two-digit PIN prevents accidental local
cross-linking; it is not strong authentication. The bridge checks extension
origins, handshake order, roles, session identity, message size, and schemas.

VS Code and installed source plugins can read workspace documents. Separately
installed plugins are independently trusted extension code. Browser2IDE itself
has no remote service and exposes no write, page mutation, source edit, or
arbitrary command path.

See [protocol.md](protocol.md), [security.md](security.md), and
[../PRIVACY.md](../PRIVACY.md) for the complete contracts.
