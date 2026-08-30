# Pin-op Protocol

Pin-op carries bounded inspection evidence from one explicitly linked
browser window to local VS Code. It returns source-resolution, bounded Source
presentation, and navigation state only to the originating browser connection,
and routes typed refresh generations from the IDE to participating tabs.

## Version And Capability Negotiation

The current protocol version is `7`. Every product message uses
`protocolVersion: 7`; product release semver (`0.3.2`) is independent. Packaged
runtime metadata reports protocol version `7`.

The protocol uses exact version matching with no downgrade negotiation.
Unsupported versions, unknown fields, and invalid message shapes are rejected.
Protocol v7 is breaking. A v6 peer is rejected with WebSocket close code
`1002`; there is no v6 compatibility adapter, downgrade, or retry fallback.
The browser exposes the received and expected versions so the panel can tell
the user to update both extensions and reconnect.

After linking, each client sends a strict `hello` containing its active
capabilities. Capability negotiation does not alter the protocol version. It
authorizes only message families implemented by both endpoints and the bridge:

- browser clients advertise `inspect`, `link`, `source-navigation`,
  `auto-refresh`, `source-presentation`, `presentation-settings`, and
  `rules-sources`;
- an inspect-only simulator may advertise only `inspect`, while a simulator
  that sends navigation intents must also advertise `source-navigation`;
- IDE clients advertise `resolution`, `source-navigation`, `auto-refresh`,
  `source-presentation`, `presentation-settings`, and `rules-sources`.

The bridge stores the authenticated capability list and checks it again when
routing optional messages. Advertising an unknown capability is invalid, and a
client cannot send or receive an optional message family without its capability.

```json
{
  "protocolVersion": 7,
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
    "presentation-settings",
    "rules-sources"
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
message-specific `type`, JSON-only `metadata`, and protocol version `7`.
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
  "protocolVersion": 7,
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
  "ruleEvidence": {
    "rules": [],
    "omittedRuleCount": 0
  },
  "context": {
    "url": "http://127.0.0.1:4173/",
    "metadata": {}
  },
  "metadata": {}
}
```

Every inspect includes `ruleEvidence`, even when it is empty. A CSS fact carries
only its `ruleRef` and exact declaration tuple. The referenced evidence is the
sole wire owner of selector text, generated HTTP(S) stylesheet URL, one-based
and end-exclusive positions, numeric dotted rule path, and ordered outer-to-inner
`media`/`supports` contexts. Missing, duplicate, truncated, unsupported, hostile,
or over-budget source evidence fails closed; browser-local paths never cross the
product WebSocket.

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
  "protocolVersion": 7,
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

## Rules Source Navigation

The current browser, bridge, and IDE endpoints advertise the `rules-sources`
capability. After each inspect, the IDE resolves the complete bounded
`ruleEvidence` batch and publishes a strictly newer complete generation through
the exact originating inspect reply route:

```json
{
  "protocolVersion": 7,
  "type": "rules.sources",
  "messageId": "rules-sources-1",
  "sessionId": "default",
  "source": { "role": "ide", "id": "vscode-window-1" },
  "inspectMessageId": "inspect-42",
  "rulesGeneration": 1,
  "sources": [
    {
      "ruleRef": "rule-1",
      "openAuthorityId": "opaque-rule-open-1",
      "document": { "label": "card.scss", "languageId": "scss" },
      "startLine": 41,
      "startColumn": 3,
      "confidence": "sourcemap"
    }
  ],
  "unresolvedRuleCount": 0,
  "metadata": {}
}
```

Published `ruleRef` values must be unique members of the immutable inspect
evidence set, and `sources.length + unresolvedRuleCount` must cover that set
exactly. `rulesGeneration` is independent of active-document
`resolutionGeneration`. A prepare/send/commit transition ensures a failed
browser delivery does not replace the bridge's previous generation and
allowlist.

The browser renders only the safe document label, CSS/SCSS language, one-based
start position, and confidence. An unresolved rule remains visible with its
verified generated CSS origin when one exists, but it never receives an
approximate SCSS authority. A missing, invalid, ambiguous, stale, or
outside-workspace map cannot produce an SCSS origin.

An explicit current Rules-origin click sends this minimal message:

```json
{
  "protocolVersion": 7,
  "type": "rules.open",
  "messageId": "rules-open-1",
  "sessionId": "default",
  "inspectMessageId": "inspect-42",
  "rulesGeneration": 1,
  "openAuthorityId": "opaque-rule-open-1",
  "metadata": {}
}
```

`rules.open` has no `source` field and cannot contain a `ruleRef`, URL, URI,
path, line, column, range, document version, or command. The bridge accepts it
only from the originating capable browser and only for a current IDE-issued
opaque authority. The IDE revalidates workspace ownership, dependency hashes,
document identity, generation, and the private full range before and after the
host opens the document. The explicit click may therefore switch VS Code to a
different workspace CSS or SCSS file; passive inspection never does.

There is no open acknowledgement message. Local transport acceptance cannot
prove bridge-to-browser delivery, so stale or mismatched generations fail
closed and a fresh inspect republishes authority. Existing `source.matches`,
`source.open`, and active-document-only Source semantics remain separate and
back the Inspector's Source tab.

## Auto Refresh

The `auto-refresh` capability authorizes IDE-to-browser `page.refresh`
messages. They contain only an increasing generation and one closed mode:

```json
{
  "protocolVersion": 7,
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
defaults on only after `protocol.compatibility` reports v7 and a fresh tab-state
snapshot is accepted. A panel must be open. An inactive participating tab keeps
the strongest newest pending mode and applies it once when activated.

## Source Presentation And Settings

The `source-presentation` capability authorizes IDE `source.matches` replies
and browser `source.open` intents on the exact inspect route and resolution
generation. A match is a bounded excerpt from the active IDE document:

```json
{
  "protocolVersion": 7,
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

Before serializing `source.matches`, the trusted VS Code host rebuilds its
presentation metadata. `kind` and `relation` are members of the closed
`SOURCE_EXCERPT_KINDS` and `SOURCE_EXCERPT_RELATIONS` vocabularies; unknown
plugin values become `source` and `matches`. Match display labels,
host-derived document labels, and language IDs are normalized and bounded.
Local source-plugin match or diagnostic metadata can remain available for
diagnostics, but plugin `SourceMatch.metadata` is never serialized into
`source.matches`.

Serialized labels reject literal paths, URIs, and locators; relative `.map`
labels; `sourceMappingURL` directives; structured browser locators; and
bounded plausible base64 or base64url labels whose UTF-8 decoding has one of
those sensitive forms. An unsafe match label falls back to the separately
normalized, host-derived active-document basename, or `untitled` when no safe
basename exists. A normalization or publication failure fails closed with no
matches or navigation authority.

A message contains at most 32 excerpts and is at most 256 KiB. Each excerpt is
at most 80 logical lines and 8 KiB. It carries a display label and line numbers,
but no workspace path, source URI, browser tab ID, editor range, or full source
document. Selected and immediate Parent excerpts are separate; Previous/Next
navigation continues to include Selected matches only. The excerpt `text`
itself remains bounded code from the active document; it is not content-redacted
or scanned for secrets.

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
  "protocolVersion": 7,
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
  "protocolVersion": 7,
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
decorations and never enter the navigation count or navigation order. Passive
DOM selection and refresh do not move the VS Code cursor. An explicit
Previous/Next intent moves the primary cursor and reveals the chosen Selected
range; an explicit Source excerpt click can send `source.open` and reveal that
exact current Selected or Parent range after authority is revalidated.

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
  "protocolVersion": 7,
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

## Browser-Local Pseudo-State Preview

The shared Chromium-derived Inspector in Firefox and Chrome is read-only and
uses one browser-local pseudo-state API. Pseudo state is deliberately absent
from the public WebSocket capabilities and messages: requests and responses
move only among the panel, background, and inspected content runtime on the
validated opaque Inspector channel.

`styles.setPseudoStates` atomically replaces the requested canonical state set
with `hover`, `focus`, both in that order, or neither. The strict request carries
`requestId`, `documentEpoch`, `nodeRef`, `selectionRevision`,
`expectedStylesRevision`, `expectedPseudoStateRevision`, and `states`.
Independent toggle messages are not accepted. The content session compares
every authority and revision before applying supported readable author rules.

A successful `styles.pseudoStates` response echoes the request and selection
identity and returns `stylesRevision`, `stylesheetRevision`,
`pseudoStateRevision`, canonical `states`, and bounded
`unsupportedRuleCount`, `inaccessibleStylesheetCount`, and
`approximateRuleCount`. Pseudo changes advance the pseudo-state and aggregate
styles revisions but do not change stylesheet identity. `styles.getMatched`
and `styles.matched` carry the same `pseudoStateRevision` and canonical
`pseudoStates`, so a pre-preview Rules response cannot replace a post-preview
model generation. Stale document, selection, styles, or pseudo authority fails
closed with a typed browser-local error.

This API controls author-style `:hover`/`:focus` emulation, not native
pseudo-state forcing. The runtime adds random extension-owned marker attributes
and temporary mirror styles only for supported selectors in the selected
accessible scope. It does not expose user-authored CSS/DOM editing operations,
directly call inspected-page functions such as `focus()`, or dispatch input,
focus, mouse, pointer, or keyboard events into the inspected page. Inaccessible
stylesheets, unsupported selectors or grouping contexts, failed mounts, and
unprovable source order are partial/unavailable rather than guessed.

Preview artifacts are excluded from Pin-op DOM, Rules, inspect, overlay,
recovery, and stable-locator evidence but are not invisible to the page. Page
scripts and MutationObservers can observe them while enabled, and mirrored
styles can indirectly trigger transitions, animations, resource loads,
callbacks, and application observers. Controlled toggle, selection, recovery,
refresh, navigation, disconnect, compatibility loss, lease replacement, and
disposal remove the exact owned objects while the content context can run.
Abrupt extension termination, disable, update, or crash can leave artifacts
until page navigation or reload.

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

Pin-op is read-only: it exposes no user-authored CSS, DOM, or source editing
operations and no direct application-state commands. Its bounded runtime
exceptions are the extension-owned inspection overlay, pseudo-preview
marker/style mutations, and `styles` Auto Refresh link replacement described
below. The browser extension can execute only its packaged extension runtime and
permitted browser APIs. It can read bounded accessible DOM structure, approved
attributes, CSSOM evidence, and box geometry.

For visual inspection, the extension temporarily inserts an isolated
Pin-op inspection overlay DOM under a dedicated pointer-inert host with a
closed shadow root. Overlay-owned nodes are excluded from Pin-op inspection
and stable locator capture. When visual inspection is disabled or cleared, the
rendered overlay is removed. Disconnecting disposes the inspection session;
disposal removes its host and any remaining overlay DOM.

Pin-op exposes no arbitrary page-owned DOM write and does not modify source
code. It exposes no user-authored CSS/DOM editing operation. Beyond the isolated
overlay, extension-owned page mutations are the temporary pseudo-preview
markers/mirror styles described above and `styles` Auto Refresh: it inserts a
cloned external top-document HTTP(S) stylesheet link, removes the old link only
after the clone loads successfully, and retains the old link on failure. It
cannot fill or submit forms. It does not execute page commands received from VS
Code or the WebSocket, directly call arbitrary inspected-page functions, or
dispatch input/focus events into the inspected page. CSS transitions,
animations, resource loads, MutationObservers, and related application
callbacks can still run indirectly when preview artifacts or mirror styles take
effect.

The IDE extension can read the active workspace document through source plugins
and can read bounded workspace CSS, SCSS, and source-map dependencies through
the Rules resolver. It can add editor decorations and move the primary cursor
after an explicit Previous/Next intent, a validated active-document
`source.open`, or an explicit Rules origin click carrying a current IDE-issued
opaque authority. Only that Rules click may switch VS Code to another verified
workspace source file. Passive selection and refresh do not move the cursor or
switch editors. The IDE cannot edit or write source files, run a shell, execute
an arbitrary workspace command, or send a caller-supplied command to change the
inspected page. The browser cannot ask the IDE to execute arbitrary commands or
edit files, and the IDE cannot execute page scripts.

Only bounded inspect facts, bounded active-document excerpts, sanitized Rules
origin labels/start positions, opaque IDs, and protocol state cross the
loopback WebSocket. Browser-local locators and node refs never cross it. Full
source documents, full editor ranges, local file paths and URIs, document
versions, source maps, and browser tab IDs never cross in the reverse direction.
Protocol 7 exposes no user-authored CSS/DOM editing, source writes, shell
execution, workspace command execution, or reverse synchronization. Its
extension-owned DOM/style changes are the overlay, temporary author-style
pseudo-preview artifacts, and typed stylesheet-link replacement described
above. Pseudo-preview state remains browser-local and never becomes a public
protocol command.
