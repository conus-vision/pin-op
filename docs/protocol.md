# Browser2IDE Protocol

The Browser2IDE product protocol carries bounded inspection evidence from a
linked browser window to local VS Code and returns source-resolution outcomes to
the originating browser connection.

## Version

The current protocol version is `4`. Product messages use
`protocolVersion: 4`; product release semver (`0.3.0`) is independent. Packaged
runtime metadata therefore reports protocol version `4`, not the product major
or minor version.

Version matching is exact. Unsupported versions, unknown fields, and invalid
message shapes are rejected. There is no protocol v3 compatibility branch and
no downgrade negotiation.

## Transport

Product traffic uses WebSocket only:

```text
browser extension -> ws://127.0.0.1:<managed-port> -> VS Code extension
```

The VS Code bridge binds only to `127.0.0.1` and chooses the first available
port from `48735` through `48834`. Browser2IDE exposes no product HTTP API and
does not scan this range from the browser.

Ordinary protocol messages are strict objects with a non-empty `messageId`,
message-specific `type`, JSON-only `metadata`, and protocol version `4`.
Handshake and routed messages add role, session, and identity fields as needed.

## Link Code

Every bridge start creates a fresh UUID `bridgeInstanceId`, random two-digit
PIN, role-bound tokens, and managed port. The seven-digit UI code is only an
encoding of the exact endpoint and PIN:

```text
48735 07 -> port 48735 + PIN 07 -> clipboard value 4873507
```

The browser parses the first five digits as the port, connects to that one
loopback endpoint, and sends the last two digits in a `linkRequest`. The PIN is
accidental-cross-link protection, not strong authentication.

## Link And Authentication

A browser or simulator sends one link request on a new socket:

```json
{
  "protocolVersion": 4,
  "type": "linkRequest",
  "messageId": "link-1",
  "pin": "07",
  "source": {
    "role": "browser",
    "id": "firefox-devtools",
    "metadata": {}
  },
  "metadata": {}
}
```

On success the bridge returns `linkAccepted` with `sessionId`,
`bridgeInstanceId`, a browser-role token, and expiry. The client then sends
`hello` with those values and its capabilities. The bridge validates role,
session, token, expiry, bridge instance, and source before returning
`authenticated`.

The IDE does not send `linkRequest`. Its role-bound credentials are created
inside the same VS Code extension runtime and it performs the `hello` exchange
directly.

Unauthenticated sockets have ten seconds to finish the handshake. A socket gets
one link attempt. Invalid order, malformed input, or failed authentication
closes it. Five failed PIN attempts in the rolling window trigger a bridge-wide
60-second cooldown; responses do not reveal whether a guessed PIN was close.

After authentication, the browser stores the endpoint, session ID, bridge
instance ID, browser token, and formatted display code in
`browser.storage.session` for that browser window. Display-code storage is
session-only. It exists so another panel in the same window can show the same
code without preserving the original input field.

The DevTools **Disconnect** action sends the protocol `unlink` request, revokes
that browser token, closes its socket, and removes only that window's session
record. Stopping VS Code revokes all tokens for that bridge instance.

## Inspect Messages

An `inspect` message contains one required selected target and one optional
immediate-parent target:

- selected has `role: "selected"` and `depth: 0`;
- parent has `role: "parent"` and `depth: 1`;
- duplicate roles, other depths, a missing selected target, or more than two
  targets are invalid;
- each target owns its subject, runtime facts, and metadata.

```json
{
  "protocolVersion": 4,
  "type": "inspect",
  "messageId": "inspect-42",
  "sessionId": "default",
  "source": {
    "role": "browser",
    "id": "firefox-devtools:tab-7",
    "metadata": {}
  },
  "targets": [
    {
      "role": "selected",
      "depth": 0,
      "subject": {
        "selector": ".card.featured",
        "metadata": {}
      },
      "facts": [
        {
          "type": "css-rule",
          "selector": ".card",
          "property": "display",
          "value": "grid",
          "metadata": {
            "sourceUrl": "http://127.0.0.1:4173/dist/app.css",
            "rulePath": [2, 0]
          }
        }
      ],
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

Known runtime facts have strict schemas. `css-rule` facts can include selector,
declaration, source position, source URL, media conditions, and CSSOM rule path.
`dom-attribute` facts carry bounded names and values. Namespaced plugin facts use
a lowercase dotted type and JSON-only payload.

Wire source locations are one-based. The source-plugin API converts them to
zero-based, end-exclusive editor ranges.

## Targeted Resolution Replies

When the bridge accepts an inspect message, it registers a route keyed by
`sessionId` and the inspect `messageId`, pointing to the exact browser connection
that sent it. The inspect message is then delivered to the IDE role.

The IDE returns a `resolution` message whose `inspectMessageId` is that original
ID. The bridge resolves the stored route and sends the reply only to the
originating browser or simulator connection. It does not broadcast resolution
replies to every browser in a session.

Routes are bounded to 256 recent inspect IDs per browser connection. Reusing an
ID on the same connection refreshes its route; the same session/ID from another
connection is a collision and fails closed. Client disconnect removes its
routes. `resolutionGeneration` is monotonic for one inspect ID so the panel can
discard stale replies while accepting later active-editor reruns.

```json
{
  "protocolVersion": 4,
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

Resolution status is one of:

- `matched`;
- `no-active-editor`;
- `unsupported-document`;
- `no-facts`;
- `source-not-found`;
- `source-not-active-document`;
- `source-ambiguous`;
- `source-map-missing`;
- `source-map-invalid`;
- `no-rule-match`;
- `rule-match-ambiguous`;
- `error`.

Only `matched` can have nonzero Selected or Parent counts. Diagnostic codes are
bounded, unique, and drawn from the closed resolver vocabulary.

## Peer State

Protocol version `4` adds `peerState` so a browser can distinguish an
authenticated socket from IDE availability. The bridge tracks whether at least
one IDE role is connected in the session and publishes transitions plus an
increasing `peerGeneration`:

```json
{
  "protocolVersion": 4,
  "type": "peerState",
  "messageId": "peer-9",
  "sessionId": "default",
  "role": "ide",
  "connected": true,
  "peerGeneration": 2,
  "metadata": {}
}
```

The current state is sent to a newly authenticated client. A transition is sent
when IDE availability changes. Older generations cannot overwrite newer panel
state.

## Browser-Local DOM Protocol

The Inspector DOM tree is deliberately outside the product WebSocket protocol.
Browser-local node refs and tree messages move only between the panel,
background, and inspected content runtime.

Each DevTools panel has a validated opaque channel bound by the background to
one inspected tab. A channel can issue:

- `dom.getRoot`;
- `dom.getChildren` with document epoch, node ref, branch revision, and optional
  cursor;
- `dom.select`;
- `dom.hover`;
- `dom.clearHover`.

The content runtime replies with `dom.root`, `dom.children`, or a closed
`dom.error` code and emits selection, hover, and branch-invalidation events.
Every request/reply is correlated by `requestId`. Responses from another type,
request, channel, document epoch, or branch revision are discarded.

Browser-local bounds include:

- 64 KiB serialized tree messages;
- 100 nodes per child page;
- 64 nodes in a revealed ancestor path;
- 128 invalidated branches per event;
- 64 concurrent panel channels by default;
- bounded node labels, IDs, provider records, cursor records, scan slices, and
  virtualized rendered rows.

Open shadow roots and same-origin frame documents receive explicit tree nodes.
Cross-origin frame nodes are marked inaccessible and locked. Closed shadow roots
are not exposed. Node refs do not reveal DOM objects and are invalid after their
document/frame authority becomes stale.

## Resource And Routing Bounds

The bridge rejects WebSocket frames larger than 1 MiB. An inspect envelope is at
most 768 KiB, with at most two targets and 256 facts per target. A resolution
envelope is at most 16 KiB. URL, route, selector, attribute, value, metadata,
source, count, generation, and identifier fields all have schema limits.

The router enforces direction:

- browser/simulator inspect messages go to the IDE role;
- IDE resolution messages use the targeted reply route;
- peer state is generated by the bridge;
- heartbeat ping/pong maintains liveness;
- invalid roles, sessions, sources, routes, schemas, and stale identities fail
  with a bounded error or closed connection.

The `0.3.0` product does not expose source writes, DOM writes, shell execution,
workspace command execution, or reverse synchronization through protocol
version `4`.
