# Pin-op Protocol

Pin-op carries bounded inspection evidence from one explicitly linked
browser window to local VS Code. It returns source-resolution, bounded Source
presentation, and navigation state only to the originating browser connection,
and routes typed refresh generations from the IDE to participating tabs.

## Version And Capability Negotiation

The current protocol version is `6`. Every product message uses
`protocolVersion: 6`; product release semver (`0.3.0`) is independent. Packaged
runtime metadata reports protocol version `6`.

The protocol uses exact version matching with no downgrade negotiation.
Unsupported versions, unknown fields, and invalid message shapes are rejected.
Protocol v6 is breaking. A v5 peer is rejected with WebSocket close code
`1002`; there is no v5 compatibility adapter, downgrade, or retry fallback.
The browser exposes the received and expected versions so the panel can tell
the user to update both extensions and reconnect.

After linking, each client sends a strict `hello` containing its active
capabilities. Capability negotiation does not alter the protocol version. It
authorizes only message families implemented by both endpoints and the bridge:

- browser clients advertise `inspect`, `link`, `source-navigation`,
  `auto-refresh`, `source-presentation`, and `presentation-settings`;
- an inspect-only simulator may advertise only `inspect`, while a simulator
  that sends navigation intents must also advertise `source-navigation`;
- IDE clients advertise `resolution`, `source-navigation`, `auto-refresh`,
  `source-presentation`, and `presentation-settings`.

The bridge stores the authenticated capability list and checks it again when
routing optional messages. Advertising an unknown capability is invalid, and a
client cannot send or receive an optional message family without its capability.

```json
{
  "protocolVersion": 6,
  "type": "hello",
  "messageId": "hello-2",
  "sessionId": "default",
  "authToken": "<browser-role-token>",
  "bridgeInstanceId": "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
  "source": {
    "role": "browser",
    "id": "firefox-window-7",
    "metadata": {}
  },
  "capabilities": [
    "inspect",
    "link",
    "source-navigation",
    "auto-refresh",
    "source-presentation",
    "presentation-settings"
  ],
  "metadata": {}
}
```

## Transport, Link, And Authentication

Product traffic uses WebSocket only:

```text
browser extension -> ws://127.0.0.1:<managed-port> -> VS Code extension
```

The VS Code bridge binds only to `127.0.0.1` and chooses the first available
port from `48735` through `48834`. Pin-op exposes no product HTTP API and
the browser does not scan the port range.

Ordinary protocol messages are strict objects with a non-empty `messageId`, a
message-specific `type`, JSON-only `metadata`, and protocol version `6`.
Handshake and routed messages add the exact identity and correlation fields
their schemas require. WebSocket frames larger than 1 MiB are rejected.

Every bridge start creates a fresh UUID `bridgeInstanceId`, random two-digit
PIN, role-bound tokens, and managed port. The seven-digit UI code encodes only
the exact endpoint and PIN:

```text
48735 07 -> port 48735 + PIN 07 -> clipboard value 4873507
```

The browser connects to that one loopback endpoint and sends the final two
digits in a `linkRequest`. The PIN prevents accidental local cross-linking; it
is not strong authentication. A successful `linkAccepted` returns the
`sessionId`, `bridgeInstanceId`, browser-role token, and expiry used by `hello`.
The IDE receives its role-bound credentials inside the same VS Code extension
runtime and does not send `linkRequest`.

The bridge validates role, session, token, expiry, bridge instance, source, and
message order before returning `authenticated`. An unauthenticated socket has
ten seconds and one link attempt. Five failed PIN attempts in the rolling
window trigger a bridge-wide 60-second cooldown without revealing PIN detail.

Authenticated browser credentials and the display code live in
`browser.storage.session` for that browser window. **Disconnect** sends
`unlink`, revokes that window's token, closes its socket, and removes only that
window's session record. Stopping VS Code revokes every token for that bridge
instance.

## Inspect Messages And Targeted Resolution Replies

An `inspect` message contains one required selected target and at most one
immediate-parent target:

- selected has `role: "selected"` and `depth: 0`;
- parent has `role: "parent"` and `depth: 1`;
- duplicate roles, other depths, a missing selected target, or more than two
  targets are invalid;
- each target owns its strict subject, bounded facts, and metadata.

```json
{
  "protocolVersion": 6,
  "type": "inspect",
  "messageId": "inspect-42",
  "sessionId": "default",
  "source": {
    "role": "browser",
    "id": "firefox-window-7:tab-3",
    "metadata": {}
  },
  "ideHighlightEnabled": true,
  "targets": [
    {
      "role": "selected",
      "depth": 0,
      "subject": {
        "selector": ".card.featured",
        "metadata": {}
      },
      "facts": [],
      "metadata": {}
    }
  ],
  "context": {
    "url": "http://127.0.0.1:4173/",
    "metadata": {}
  },
  "metadata": {}
}
```

When the bridge accepts an inspect message, it registers a reply route keyed by
`sessionId` and the inspect `messageId`. The route points to the exact browser
or simulator connection that sent it. The IDE's `resolution.inspectMessageId`
must reference that route, and the bridge sends each targeted resolution reply
only to the originating connection, never to every browser in the session.

Routes are bounded to 256 recent inspect IDs per browser connection. Reusing an
ID on the same connection refreshes its route; the same session and ID from a
different connection is a collision and fails closed. Disconnect removes the
connection's routes. `resolutionGeneration` increases when VS Code resolves the
same inspect selection again, allowing clients to reject older resolution
results.

```json
{
  "protocolVersion": 6,
  "type": "resolution",
  "messageId": "resolution-18",
  "sessionId": "default",
  "source": {
    "role": "ide",
    "id": "vscode-window-1"
  },
  "inspectMessageId": "inspect-42",
  "resolutionGeneration": 3,
  "document": {
    "label": "card.scss",
    "languageId": "scss"
  },
  "status": "matched",
  "selectedMatchCount": 2,
  "parentMatchCount": 1,
  "inaccessibleStylesheetCount": 0,
  "diagnosticCodes": [],
  "metadata": {}
}
```

Only `matched` can report nonzero Selected or Parent counts. Other strict
statuses cover no active editor, unsupported documents, missing or ambiguous
sources, source-map failures, no or ambiguous rule matches, and bounded plugin
or internal errors. Wire source locations are one-based; the local source
plugin API converts them to zero-based, end-exclusive editor ranges.

## Auto Refresh

The `auto-refresh` capability authorizes IDE-to-browser `page.refresh`
messages. They contain only an increasing generation and one closed mode:

```json
{
  "protocolVersion": 6,
  "type": "page.refresh",
  "messageId": "refresh-7",
  "sessionId": "default",
  "source": { "role": "ide", "id": "vscode-window-1" },
  "refreshGeneration": 7,
  "mode": "styles",
  "metadata": {}
}
```

`styles` asks a participating current tab to refresh eligible external
top-document HTTP(S) stylesheet links. `reload` asks the browser adapter to
reload the current tab with bounded top-level scroll restoration. The message
contains no path, URL, script, selector, source text, tab ID, or command.

Participation and pending work are browser-local. Auto Refresh is tab-local and
defaults on only after `protocol.compatibility` reports v6 and a fresh tab-state
snapshot is accepted. A panel must be open. An inactive participating tab keeps
the strongest newest pending mode and applies it once when activated.

## Source Presentation And Settings

The `source-presentation` capability authorizes IDE `source.matches` replies
and browser `source.open` intents on the exact inspect route and resolution
generation. A match is a bounded excerpt from the active IDE document:

```json
{
  "protocolVersion": 6,
  "type": "source.matches",
  "messageId": "matches-8",
  "sessionId": "default",
  "source": { "role": "ide", "id": "vscode-window-1" },
  "inspectMessageId": "inspect-42",
  "resolutionGeneration": 3,
  "document": { "label": "card.scss", "languageId": "scss" },
  "matches": [{
    "matchId": "opaque-match-1",
    "targetRole": "selected",
    "label": ".card",
    "kind": "rule",
    "relation": "applies",
    "confidence": "sourcemap",
    "startLine": 18,
    "endLine": 24,
    "text": ".card {\n  display: grid;\n}",
    "truncated": false
  }],
  "omittedMatchCount": 0,
  "metadata": {}
}
```

A message contains at most 32 excerpts and is at most 256 KiB. Each excerpt is
at most 80 logical lines and 8 KiB. It carries a display label and line numbers,
but no workspace path, source URI, browser tab ID, editor range, or full source
document. Selected and immediate Parent excerpts are separate; Previous/Next
navigation continues to include Selected matches only.

Clicking an excerpt sends `source.open` with only `inspectMessageId`,
`resolutionGeneration`, and the opaque `matchId`. The bridge and IDE re-prove
the current private authority before revealing the exact range in the already
active document. A stale or foreign ID fails closed.

The `presentation-settings` capability authorizes `presentation.settings` for
the current inspect route. It contains only the `ideHighlightEnabled` boolean.
Disabling IDE Highlight clears editor decorations but preserves resolution,
Source presentation, and source-navigation authority. Browser tab settings do
not expose browser tab IDs on the product WebSocket.

## Source Navigation

The `source-navigation` capability authorizes two strict messages.
After a resolution with selected matches, a capable browser or simulator sends
an intent with no source ranges or file identity:

```json
{
  "protocolVersion": 6,
  "type": "source.navigate",
  "messageId": "navigate-19",
  "sessionId": "default",
  "inspectMessageId": "inspect-42",
  "resolutionGeneration": 3,
  "direction": "next",
  "metadata": {}
}
```

`source.navigate` has no `source` field. The browser or simulator identity
comes from its authenticated WebSocket connection, not from an identity field
visible to the IDE in the navigation intent.

The IDE answers with current cursor state:

```json
{
  "protocolVersion": 6,
  "type": "source.navigationState",
  "messageId": "navigation-state-20",
  "sessionId": "default",
  "inspectMessageId": "inspect-42",
  "source": {
    "role": "ide",
    "id": "vscode-window-1"
  },
  "resolutionGeneration": 3,
  "selectedMatchCount": 2,
  "activeMatchIndex": 0,
  "metadata": {}
}
```

`source.navigate` uses the same inspect reply route as `resolution`. The bridge
validates the authenticated sender's role, registered source and client
identity, session, capability, and ownership of the exact inspect reply route.
It routes the intent only to capable IDE clients in that session. A second
browser cannot reuse the correlation, even with the same session and inspect
ID.

The intent and every corresponding state update stay on the same inspect reply
route and the same browser connection.

`source.navigationState` is accepted only from an authenticated capable IDE.
The bridge verifies the sender role and client identity, checks that its
`source.id` equals the registered IDE source, checks its session, and resolves
its `inspectMessageId` through the exact route to the capable originating
browser connection.

Endpoint correlation uses only fields and local ownership each endpoint
actually has. Across the browser and IDE endpoints this includes the
authenticated session, current browser window and DevTools channel/tab
ownership, `inspectMessageId`, `resolutionGeneration`, and the IDE's current
document and selected ranges. The browser correlation store does not compare
the IDE source ID; the bridge has already authenticated the state sender and
targeted the route. The IDE cannot validate a browser source ID because
`source.navigate` carries no such field. Stale, mismatched, or superseded state
is ignored or fails closed at the layer that owns the relevant correlation.

The route remains live, so repeated `source.navigationState` updates in the
same resolution generation are valid. This is how manual cursor movement can
update the footer without a new inspect or resolution. Every update has a new
`messageId` but retains the current inspect ID and generation.

Navigation is selected-only. `selectedMatchCount` counts unique selected
ranges in the active resolved document. Parent ranges remain distinct editor
decorations and never enter the navigation count or navigation order. Selecting
a DOM element does not move the VS Code cursor. Previous/Next moves only the
primary cursor after a button intent and reveals the chosen selected range.

`activeMatchIndex` is zero-based and is present only when the primary cursor is
inside one of those selected ranges. In the normal state before navigation,
the unchanged cursor is outside the matches and `activeMatchIndex` is omitted;
it is also omitted whenever the cursor moves outside all matches. If the cursor
already lies inside a selected range, that index can be reported before the
first navigation click. An index greater than or equal to
`selectedMatchCount` is invalid.

## Peer State

`peerState` lets a browser distinguish an authenticated socket from IDE
availability. The bridge publishes whether an IDE role is connected in the
session and includes an increasing `peerGeneration`:

```json
{
  "protocolVersion": 6,
  "type": "peerState",
  "messageId": "peer-9",
  "sessionId": "default",
  "role": "ide",
  "connected": true,
  "peerGeneration": 2,
  "metadata": {}
}
```

The current state is sent after authentication and transitions are sent when
IDE availability changes. Older generations cannot overwrite newer panel
state.

## Browser-Local DOM Protocol And Recovery

The Inspector DOM tree is deliberately outside the product WebSocket protocol.
Browser-local node refs, stable locators, tree pages, geometry, and recovery
messages move only among the panel, background, and inspected content runtime.
Locators never cross the WebSocket.

Each DevTools panel has a validated opaque channel bound by the background to
one inspected tab. Browser-local requests include `dom.getRoot`,
`dom.getChildren`, `dom.resolveLocator`, `dom.select`, `dom.hover`, and
`dom.clearHover`. Every request/reply is correlated by `requestId`; tree pages
also prove the channel, document epoch, node ref, branch revision, and cursor as
applicable. A response from another request, channel, document epoch, or branch
revision is discarded.

Each rendered node carries a version-1 stable locator used only for bounded
recovery after a document or branch invalidation. `dom.resolveLocator` asks the
current content runtime to prove that locator again. Success returns a fresh
`dom.locator` response with the current document epoch, fresh node view, and
fresh ancestor path. Failure returns a closed `dom.error` outcome or no match;
it never selects a nearby node by guess.

Stable locator bounds are:

- a total depth cap of 64 across path segments and open-shadow or same-origin
  frame boundary hops, with no more than 16 boundary records;
- at most 8 classes and 8 approved attributes per segment;
- at most 128 characters per tag, ID, class, attribute name, or value token;
- at most 64 remembered expanded locators during recovery;
- bounded scans of 4,096 nodes for unique IDs, 256 physical entries for child
  or evidence reads, and 65,536 total visited nodes.

A segment fingerprint combines the canonical lowercase tag, exact element
sibling index, a unique ID only when repeated scans prove it stable and unique,
and canonical sorted class and approved-attribute subsets capped at 8 each.
Approved attributes are `role`, `aria-*`, and `data-*`. Resolution re-proves
every path and boundary, current frame identity and authorization, structural
index, fingerprint, and target kind. Mutation during reads, changed evidence,
duplicate or ambiguous identity, stale frame ownership, inaccessible
boundaries, thrown page accessors, or any exceeded cap fails closed.

Open shadow roots and same-origin frame documents receive explicit tree nodes.
Cross-origin frames are locked leaves and closed shadow roots are not exposed.
Recovery replaces refs only after the complete proof commits. A superseding
manual selection or newer invalidation wins over older recovery work.

Browser-local resource bounds also include 64 KiB serialized messages, 100
nodes per child page, 64 nodes in a revealed ancestor path, 128 invalidated
branches per event, and 64 concurrent panel channels by default.

## Resource And Routing Bounds

An inspect envelope is at most 768 KiB with at most two targets and 256 facts
per target. Resolution and source-navigation envelopes are at most 16 KiB.
Source presentation is at most 256 KiB with at most 32 excerpts, 80 logical
lines and 8 KiB per excerpt.
URLs, routes, selectors, attributes, values, metadata, sources, counts,
generations, and identifiers all have schema limits.

The router enforces direction and authority:

- browser or simulator inspect messages go to IDE clients in the same session;
- IDE resolution and navigation-state messages use targeted reply routes;
- IDE page-refresh messages require `auto-refresh` at both endpoints;
- source matches, exact opens, and presentation settings require their
  capabilities and current inspect/generation authority;
- source-navigation messages require the negotiated capability at both ends;
- peer state is bridge-generated and heartbeat ping/pong maintains liveness;
- invalid roles, sessions, source IDs, correlations, routes, schemas, and stale
  identities fail with a bounded error or closed connection.

## Read-Only Security Model

Pin-op is read-only with respect to page-owned content, application state,
and source code. The browser extension can execute only its packaged extension
runtime and permitted browser APIs. It can read bounded accessible DOM
structure, approved attributes, CSSOM evidence, and box geometry.

For visual inspection, the extension temporarily inserts an isolated
Pin-op inspection overlay DOM under a dedicated pointer-inert host with a
closed shadow root. Overlay-owned nodes are excluded from Pin-op inspection
and stable locator capture. When visual inspection is disabled or cleared, the
rendered overlay is removed. Disconnecting disposes the inspection session;
disposal removes its host and any remaining overlay DOM.

Outside that isolated overlay, Pin-op does not modify page-owned content or
application state, and it does not modify source code. It cannot fill or submit
forms or invoke page handlers, and it does not execute page commands or
arbitrary page scripts received from VS Code or the WebSocket.

The IDE extension can read the active workspace document and relevant local
source maps through its source plugins. It can add editor decorations and, only
after an explicit Previous/Next intent, move the primary cursor and reveal a
matched range. It cannot edit or write source files, run a shell, execute an
arbitrary workspace command, or send a command to change the inspected page.
The browser cannot ask the IDE to execute commands or edit files, and the IDE
cannot execute page scripts or request changes to page-owned content or
application state.

Only bounded inspect facts, bounded active-document excerpts, and protocol
state cross the loopback WebSocket. Browser-local locators and node refs never
cross it. Full source documents, editor ranges, local file paths and URIs,
source maps, and browser tab IDs never cross in the reverse direction. Protocol
6 exposes no page-owned DOM writes, source writes, shell execution, workspace
command execution, or reverse synchronization.
