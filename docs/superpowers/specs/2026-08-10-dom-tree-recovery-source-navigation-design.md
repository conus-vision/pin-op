# Browser2IDE DOM Tree Recovery And Source Navigation Design

**Date:** 2026-08-10
**Status:** Approved for implementation planning

## Summary

Browser2IDE will keep the DevTools DOM tree stable when its content-script
inspection session reconnects or the inspected page reloads. It will recover
the selected DOM element and expanded branches by using a bounded,
browser-local stable locator. Recovery is conservative: Browser2IDE restores a
node only when its identity can be proven without fuzzy matching.

The selected DOM row and the panel footer will also expose identical previous
and next source-match controls. These controls navigate only among source
ranges resolved for the selected DOM element. Immediate-parent ranges remain
highlighted in their existing color but are excluded from navigation.

The browser sends navigation intent over WebSocket, and VS Code remains the
authority for source ranges, editor focus, cursor movement, and the active
counter. Moving the cursor manually in VS Code immediately updates both
browser controls. Selecting a DOM element does not move the VS Code cursor;
navigation begins only after the first previous or next button press.

## Problem

The browser panel currently receives `browser2ide.inspect.invalidated` when a
content-script lease disconnects. `panelRuntime` resets `DomTreeController` and
reloads the root. The background can create a replacement inspection session,
but node references such as `node-1` are local to the old session. The visible
result is an expanded tree suddenly collapsing to `html`, with the selection
and resolution footer cleared even though the browser window remains linked to
VS Code.

The highlighted source blocks also have no direct navigation from DevTools.
The user can see that several rules match the selected element, but cannot move
the VS Code cursor between those blocks without returning to the editor and
finding them manually.

## Goals

- Preserve the visible expanded DOM tree while an inspection session recovers.
- Restore the selected DOM node after content reconnect, reload, or navigation
  when the same node can be identified unambiguously.
- Restore up to 64 expanded nodes without retaining stale session node refs.
- Let either browser control move the VS Code cursor to the previous or next
  selected-element source range.
- Derive the displayed match index from the primary VS Code cursor.
- Keep immediate-parent highlighting while excluding parent ranges from source
  navigation and its counter.
- Share the complete behavior between Firefox and Chromium adapters through
  `@browser2ide/browser-extension-core`.
- Keep all Browser2IDE product traffic WebSocket-only.
- Reject stale, cross-session, and cross-browser-window navigation messages.

## Non-Goals

- Fuzzy DOM recovery when node identity is uncertain.
- Persisting a DOM selection after the browser window or VS Code window closes.
- Navigating parent-element rules.
- Editing source code or the inspected page.
- Automatically focusing or moving the VS Code cursor on DOM selection.
- Reverse synchronization from source code to a browser element.
- Preserving compatibility with protocol v4 peers.
- Changing CSS/SCSS source-resolution semantics or decoration colors.

## User Experience

### Stable Tree

While the inspection session is being replaced, the last rendered tree remains
visible in a read-only recovering state instead of collapsing immediately to a
new root. Tree interaction and source navigation are disabled during this
state. The existing bounded status area reports that the DOM is being restored.

When recovery succeeds, the tree is replaced atomically with live nodes. The
selected row remains selected and visible, its ancestor path is expanded, and
the normal selection pipeline republishes CSS facts to VS Code. Additional
expanded branches are restored when possible.

When the selected node cannot be proven unique, Browser2IDE does not guess. It
shows the new live root with no selected node. Successfully recovered unrelated
branches may remain expanded.

### Source Navigation Controls

Two compact icon buttons appear at the far right of the selected DOM row:

- `ChevronLeft`, tooltip `Previous source match`;
- `ChevronRight`, tooltip `Next source match`.

The same two controls appear in the footer beside a counter. Both pairs share
one state and one command handler. Clicking a row control stops propagation, so
it neither changes the DOM selection nor toggles the branch.

The selected row reserves a stable control area while source resolution is in
progress so labels and indentation do not shift. Controls are disabled until a
current navigation state is available. They are hidden when there are no
selected-element matches. Parent-only matches do not make them visible.

The counter renders:

- `2 / 4` when the primary VS Code cursor is inside the second selected range;
- `- / 4` when four selected ranges exist but the cursor is outside all of
  them;
- no counter when no selected range exists.

The browser uses a hyphen for the no-active-match state to keep edited source
and protocol data ASCII-safe. Visual styling may render the equivalent neutral
placeholder without changing semantics.

### Cursor Rules

Selecting a new DOM element updates decorations and the match count but does
not move the VS Code cursor. The first navigation button press performs the
first movement.

For the primary VS Code cursor:

- a range is active when `start <= cursor < end`;
- if the cursor is inside a range, next and previous move relative to that
  range;
- if the cursor is outside all ranges, next chooses the first range whose start
  is after the cursor and previous chooses the range with the greatest start
  before the cursor;
- next wraps from the final range to the first;
- previous wraps from the first range to the final range;
- when no range exists in the requested direction, wrapping still selects the
  first or final range respectively.

Navigation places the primary cursor at the selector start, preserves the
complete-block decoration, and reveals the target near the editor center.
Manual cursor movement immediately recomputes and publishes the counter. Other
VS Code cursors do not participate in navigation state.

## Protocol Version 5

This feature is a strict protocol contract change. `PROTOCOL_VERSION` advances
from 4 to 5, and browser, bridge, simulator, and IDE packages migrate together.
Protocol v4 compatibility is intentionally not retained.

The active capability list gains `source-navigation`. Browser and simulator
clients may send navigation intents; IDE clients may send navigation state.

### Browser Navigation Intent

```ts
interface SourceNavigateMessage {
  readonly protocolVersion: 5;
  readonly type: "source.navigate";
  readonly messageId: string;
  readonly sessionId: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly direction: "previous" | "next";
  readonly metadata: Readonly<Record<string, never>>;
}
```

The browser sends only intent and correlation identifiers. It never sends
local file paths or source ranges back to the IDE.

### IDE Navigation State

```ts
interface SourceNavigationStateMessage {
  readonly protocolVersion: 5;
  readonly type: "source.navigationState";
  readonly messageId: string;
  readonly sessionId: string;
  readonly source: {
    readonly role: "ide";
    readonly id: string;
  };
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly selectedMatchCount: number;
  readonly activeMatchIndex?: number;
  readonly metadata: Readonly<Record<string, never>>;
}
```

`activeMatchIndex` is zero-based on the wire and absent when the cursor is
outside every selected range. It must be absent when `selectedMatchCount` is
zero and otherwise must be less than `selectedMatchCount`. The browser adds one
for display.

Cursor movement can produce many state messages for the same resolution
generation, so equal generations are valid. A state is accepted only when its
inspect message and generation equal the panel's current resolution identity.

All new schemas remain strict, bounded by the protocol's existing serialized
message limit, and reject unknown fields.

## Bridge Routing And Security

The bridge authenticates the connection and remains a routing layer without
source-navigation logic.

For `source.navigate`, it verifies that:

1. the sender role is `browser` or `simulator`;
2. the sender advertises `source-navigation`;
3. the session matches the authenticated connection;
4. the inspect reply route exists;
5. that reply route belongs to the same browser connection that originated
   `inspectMessageId`;
6. a linked IDE in the same session advertises `source-navigation`.

Only then is the intent forwarded to that IDE. Another browser window linked
to the same session cannot navigate an inspection it did not originate.

For `source.navigationState`, the bridge verifies the IDE role, source ID,
session, capability, inspect reply route, and linked recipient. It forwards the
state only to the browser connection that originated the inspection. Missing,
stale, or revoked routes fail closed.

No new message can execute arbitrary commands, write a file, edit a document,
or carry executable content.

## VS Code Source Navigator

A dedicated `SourceNavigator` owns navigation state independently of source
plugins and editor decorations. For each completed resolution it receives:

- the inspect message ID;
- the resolution generation;
- only matches whose relation is `selected`;
- the active document URI and complete source ranges.

It removes exact duplicate ranges by canonical URI, start, and end; retains
distinct nested or overlapping ranges; and sorts by start followed by end.
Matches in other documents are excluded from the current counter and command
set. Existing behavior may still open related source files, but source
navigation always applies to the currently active document.

The navigator subscribes to active-editor changes and primary selection
changes. It publishes a new navigation state after resolution, after a cursor
or editor change, and after a navigation command. Re-resolution replaces the
range set and recomputes the index without moving the cursor.

A navigation intent is ignored when its inspect ID or generation no longer
matches the navigator's current state. If the active document changes between
the intent and execution, the navigator recomputes against the new active
document and does not use stale ranges.

The implementation uses an editor-host abstraction so range ordering, cursor
semantics, wrapping, reveal behavior, and state publication can be tested
without starting VS Code.

## Browser Navigation State

A browser-local `SourceNavigationController` owns the current inspect ID,
generation, count, active index, availability, and dispatch callback. Both the
selected-row view and footer view subscribe to this controller. This prevents
the duplicated controls from drifting apart.

The controller clears live navigation state on a new manual selection,
disconnect, inspect invalidation, or resolution-generation change. During DOM
recovery it keeps the controls visible only as disabled placeholders until a
fresh selection and matching IDE state arrive.

The existing resolution presenter continues to render match diagnostics and
selected/parent totals. Navigation state is intentionally separate because
cursor updates can repeat within one resolution generation.

## Browser-Local Stable DOM Locator

Session node refs remain transport handles and are never reused for recovery.
Every `DomNodeView` delivered to the panel includes a bounded stable locator
created by the content-side DOM provider. The locator is browser-local and
never enters the WebSocket protocol.

```ts
interface DomStableLocator {
  readonly version: 1;
  readonly boundaries: readonly DomBoundaryLocator[];
  readonly path: readonly DomPathSegment[];
}

interface DomPathSegment {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly id?: string;
  readonly siblingIndex: number;
  readonly fingerprint?: {
    readonly classes?: readonly string[];
    readonly attributes?: Readonly<Record<string, string>>;
  };
}
```

The concrete schema also represents frame and open-shadow-root boundaries.
Cross-origin frames and closed shadow roots remain inaccessible and cannot be
restored through unsupported boundaries.

Locators are limited to 64 path levels. Class and attribute evidence is
canonicalized, sorted, and bounded. Volatile or unsafe values are omitted
according to the existing DOM serialization policy. Serialized locator and DOM
message sizes remain within existing browser transport limits.

### Identity Proof

Resolution is deterministic and fail-closed:

1. Within the current boundary, a unique ID candidate may be used only when its
   node type and tag match the locator evidence. Duplicate IDs are ambiguous.
2. Otherwise, the resolver follows the exact structural sibling-index path.
3. Every resolved segment must match its node type, tag, ID when present, and
   bounded fingerprint evidence.
4. Each frame or shadow boundary must resolve uniquely before traversal
   continues.
5. A missing, mismatched, inaccessible, or ambiguous segment fails that
   locator. The resolver never scores nearby nodes or searches by similar text.

This deliberately favors a safe reset over selecting the wrong element after
a page change.

## Recovery Flow

A `DomTreeRecoveryCoordinator` maintains a snapshot whenever selected or
expanded state changes. The snapshot contains the selected locator, selected
label for frozen rendering, and at most 64 expanded locators. It contains no
session-local node refs.

On inspection invalidation:

1. cancel stale tree loads, navigation state, and any older recovery attempt;
2. retain the bounded locator snapshot and last rendered rows;
3. mark the rendered tree read-only and recovering;
4. wait for the replacement content session and its root;
5. resolve the selected locator and its ancestor path first;
6. resolve remaining expanded locators shallow-to-deep;
7. build live tree state with new node refs;
8. atomically replace the frozen tree;
9. if selection resolved, invoke the normal DOM selection path so inspection
   facts and source resolution are republished.

One failed expanded branch does not abort other branches. If selection fails,
the live tree has no selection and the source-navigation state remains empty.

A new manual tree or page selection increments the recovery token, cancels all
pending restore work, and wins immediately. Every asynchronous load and
locator-resolution result checks both the current content generation and
recovery token before mutating the tree.

The same flow applies to a content lease reconnect and a genuine page
reload/navigation. A replacement document is never assumed to contain the old
node merely because its URL is unchanged.

## Error Handling

- A malformed locator is rejected before DOM traversal.
- Oversized snapshots retain the selected locator and the first 64 expanded
  locators in shallow-to-deep order.
- An inaccessible frame or shadow boundary fails only affected locators.
- A bridge route revoked during navigation drops the command and state.
- A source-navigation state with an invalid index is rejected by schema
  validation.
- A source range invalidated by an editor change is discarded before cursor
  movement.
- A disconnected IDE leaves both browser control pairs disabled.
- Plugin errors keep existing resolution diagnostics and publish zero
  navigable selected matches.
- Recovery and source navigation never block disconnect, stop, or page
  teardown.

## Testing Strategy

### Protocol And Bridge

- strict parsing and size limits for both protocol v5 messages;
- zero-based optional index invariants;
- capability advertisement by browser, simulator, bridge, and IDE clients;
- browser-to-IDE intent routing inside one linked session;
- IDE-to-originating-browser state routing;
- rejection of IDE-originated intents, browser-originated states,
  cross-session traffic, wrong source IDs, missing routes, and a second browser
  trying to navigate the first browser's inspection;
- protocol v4 peers rejected by the protocol v5 handshake.

### VS Code

- selected-only filtering excludes immediate-parent ranges;
- exact duplicate removal and deterministic ordering;
- distinct nested ranges remain separately navigable;
- cursor inside each range publishes its zero-based index;
- cursor outside all ranges publishes no index;
- next and previous behavior from inside, before, between, and after ranges;
- wrapping at both boundaries;
- no cursor movement on a new DOM selection;
- target cursor placement and centered reveal after the first command;
- primary-cursor semantics with multiple selections;
- manual cursor and active-editor changes publish updated state;
- stale inspect IDs and generations cannot move the cursor.

### DOM Recovery

- locator capture and exact structural resolution;
- unique-ID resolution with tag validation;
- duplicate IDs, changed fingerprints, missing nodes, inaccessible boundaries,
  excessive depth, and malformed locators fail safely;
- expanded branches and selection restored after content lease replacement;
- the same behavior after true reload/navigation;
- no visible root-only tree replacement during successful recovery;
- partial branch recovery;
- selected-node failure resets selection without guessing;
- a manual selection racing recovery always wins;
- snapshot cap of 64 expanded nodes and stale generation cancellation.

### Browser UI And Packaging

- controls render only on the selected DOM row and in the footer;
- both pairs share count, active index, disabled state, and commands;
- row control clicks do not select or expand the node;
- stable row width while resolving;
- controls hidden for zero selected matches and parent-only matches;
- `- / total` shown when the cursor is outside all ranges;
- Firefox and Chrome adapters expose the same core behavior;
- extension package-contract and packaged-artifact smoke tests.

The complete workspace build, focused and full tests, typecheck, lint, Firefox
`web-ext` lint, Chrome manifest checks, and VSIX/package smoke gates run before
the feature is considered complete.

## Acceptance Criteria

1. An expanded DOM tree no longer collapses to a root-only view after a
   recoverable content-session disconnect.
2. A selected node and its ancestor path are restored after reconnect or reload
   only when the browser can prove the node identity unambiguously.
3. A manual selection made during recovery is never overwritten.
4. Previous and next controls appear both on the selected row and in the
   footer, and either pair drives the same VS Code navigation state.
5. Navigation includes all and only complete source ranges for the selected DOM
   element in the active document; immediate-parent ranges remain decorated but
   are excluded.
6. The first navigation click moves the VS Code cursor; DOM selection alone
   does not.
7. The browser counter follows the actual primary VS Code cursor and shows no
   active index when that cursor is outside every selected range.
8. Previous and next wrap deterministically at the first and last ranges.
9. Navigation and state cannot cross browser windows, sessions, inspect
   generations, or authenticated roles.
10. Firefox and Chrome ship the behavior through the shared browser core, and
    all automated and package verification gates pass.
