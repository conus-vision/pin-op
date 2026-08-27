# Pin-op Security

Pin-op is a local, read-only development tool. Its model assumes the
browser and VS Code extensions run under one trusted desktop user account. It
does not treat every other process under that account as trusted.

## Transport Boundary

Pin-op has no product HTTP API. Product traffic uses a loopback WebSocket:

```text
browser extension -> ws://127.0.0.1:<managed-port> -> VS Code extension
```

The bridge binds only to `127.0.0.1` on ports `48735..48834`; it never listens
on a LAN or public interface. When a WebSocket Origin is present, the bridge
accepts supported Firefox and Chromium extension origins and rejects webpage
origins. Originless clients still have to satisfy protocol role, token, session,
and bridge-instance checks.

Loopback binding prevents network peers from connecting directly. It does not
protect against a malicious process already running as the same desktop user.

## Explicit Browser-Window Linking

Pin-op never discovers an IDE. The user clicks the intended VS Code
window's status item and enters that exact code in one browser window. The first
five digits identify one loopback port and the final two digits are that bridge
instance's PIN.

The extension background derives tab and browser-window identity from browser
APIs rather than trusting values supplied by a panel or webpage. One browser
window owns one session link and at most one active authenticated socket while
panels are active. Another window does not inherit it.

**Disconnect** affects only the current browser window: it disables inspection,
revokes the browser token, removes the session record, and closes the socket.

## PIN And Authentication

Every bridge start creates a random two-digit PIN, bridge instance UUID, and
role-bound token set. The two-digit PIN is accidental cross-link protection,
not strong authentication. It is intentionally not presented as protection
against a hostile same-user process.

Five failed PIN attempts trigger a bridge-wide 60-second cooldown. Parallel
sockets share the limit. Errors do not disclose whether the PIN was correct.
Unauthenticated connections have ten seconds to finish one valid handshake.

The read-only scope is essential to this risk decision. Pin-op does not
write or edit page/workspace source and does not execute shell, page, workspace,
or user-supplied commands. Stronger authentication is required before any write,
remote transport, command execution, or multi-user host is considered.

## Credentials And Session Storage

Server tokens and IDE credentials live only in the running VS Code extension
host. Tokens are bound to role, session, and bridge instance. Stopping the bridge
revokes them and discards its identity.

After linking, the browser stores one record for that browser window in
`browser.storage.session`:

- exact loopback WebSocket endpoint and port;
- session ID and bridge instance ID;
- authenticated browser token;
- formatted display code used to confirm the linked VS Code window.

This is session storage, not durable local storage. The original input field is
cleared. Closing the final panel closes the active socket but can retain the
window session record; reopening a panel authenticates from it. Closing the
window, ending the browser session, or selecting Disconnect removes the record.
Credentials from a restarted, expired, or different bridge fail closed and are
discarded.

## Targeted Replies And Peer State

Protocol version `7` binds each accepted inspect ID to the exact browser
connection that sent it. IDE resolution replies are routed only to that
connection. Cross-connection inspect-ID collisions, stale routes, wrong roles,
and wrong sessions fail closed. Routes are bounded and removed with the client.

Auto-refresh, source-presentation, presentation-settings, source-navigation,
and Rules-source messages require their negotiated capabilities and reuse exact
authenticated routes. Legacy Source-open carries only an opaque current match
ID; presentation settings carry only the current correlation and IDE Highlight
boolean. `rules.sources` adds sanitized labels/start positions and IDE-issued
opaque authority IDs; `rules.open` returns only the inspect ID, independent Rules
generation, and one current authority ID. No message exposes an arbitrary file,
workspace URI/path, full range, document version, tab ID, or command.

Protocol v7 is an exact breaking contract. A v6 or otherwise incompatible peer
is closed with WebSocket code `1002`; there is no adapter or downgrade fallback.
The panel blocks inspection, refresh settings, Source actions, and navigation
until both extensions report a compatible handshake and fresh tab state. Link
and Disconnect controls remain usable so the user can update both extensions
and reconnect.

Bridge-generated peer state reports IDE availability with an increasing
generation. A stale peer update or source-resolution generation cannot replace
newer panel state.

## Clipboard Access

VS Code writes the code to the operating-system clipboard only after its status
item is clicked. The browser reads the clipboard only after Paste is clicked.
Opening DevTools, linking another tab, browsing the tree, or enabling the picker
does not read it. Manual entry remains available on denial.

The operating system controls clipboard retention after a copy. The browser's
session-only formatted display code includes the PIN, so users should Disconnect
or end the browser session on shared machines.

## Inspected-Page Access

Firefox and Chrome request `<all_urls>` because the background must inject the
Inspector runtime into the arbitrary page being debugged. Opening DevTools does
not grant `activeTab` access by itself.

DOM inspection injection requires all of these conditions:

- the Pin-op DevTools panel is open for the tab;
- its browser window has an explicit link;
- the user enables the page picker or requests the tab's DOM tree.

Browser-protected pages can reject injection. Pin-op exposes no user-authored
CSS or DOM editing operations, does not submit forms, edit source, or read
cookies. Pseudo preview does not directly call inspected-page functions such as
`focus()` and does not dispatch input, focus, mouse, pointer, or keyboard events
into the inspected page. CSS transitions, animations, resource loads,
MutationObservers, and related application callbacks can still run indirectly
when mirror styles or preview artifacts take effect. The packaged runtime can
create the isolated inspection overlay, temporary pseudo-preview markers and
mirror styles, and an Auto Refresh replacement for an eligible stylesheet link;
reload uses the browser API for the current participating tab.

## Browser-Local DOM Tree

The DOM tree stays browser-local. Its node refs, labels, child pages, cursors,
selection path, document/frame epochs, branch revisions, hover state, and
box-model geometry do not travel over the product WebSocket.

The panel talks to the inspected tab through a background-bound opaque channel.
Node refs are useful only within that channel and current document/frame
authority. Navigation, mutation, collapse, frame lifecycle changes, record
pressure, and disposal invalidate stale refs and cursors.

The Inspector renderer consumes structured DOM node fields: node type and name,
bounded attribute names and values, bounded text and comment values, and
document-type names with bounded public and system IDs. Document-type, text,
and comment rows are display-only, receive no stable locator, and cannot drive
selection or the page overlay. Every page-provided name or value renders through
text APIs. The legacy rollback renderer alone retains the temporary preformatted
`label` field for its element-only labels; those labels include tag, ID, classes,
and approved attribute names but not DOM text or attribute values.

- Open shadow roots are traversed only when the platform exposes them.
- Same-origin frame documents are registered under bounded frame authority.
- A cross-origin frame becomes an inaccessible locked leaf and must fail closed.
- A closed shadow root cannot be inspected and must fail closed.

The overlay is extension-owned, `aria-hidden`, pointer-inert, style-isolated,
half-alpha, hover-only, and excluded from tree traversal. It is removed when
the pointer leaves the page element or DOM list and on refresh, document change,
or disposal. Unsafe transformed or fragmented geometry is omitted rather than
approximated.

## Chromium-Derived View Boundary

Firefox and Chrome ship one shared Chromium-derived, read-only Inspector UI by
default. The packaged view directly compiles reviewed modules from the pinned
`chrome-devtools-frontend` npm package, including the real DOM model/tree and
Rules sidebar/property renderers, but not Chromium's Inspector backend. Exact
importer/specifier resolutions and hash-pinned transforms route those modules
through read-only facades and remove mutation, context-menu, AI, telemetry,
network, and DevTools-host paths. Production bundles contain no CDP connection,
target discovery, remote code, or browser branding.

The [native runtime manifest](../third_party/chromium-devtools-frontend/RUNTIME.json),
DOM patch manifest, Rules overlay manifest,
[reference-source manifest](../third_party/chromium-devtools-frontend/UPSTREAM.json),
[BSD license](../third_party/chromium-devtools-frontend/LICENSE), and
[Pin-op patch record](../third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md)
are exact source-provenance and reproduction inputs in the repository and
Firefox source submission. Release verification recomputes every declared npm
input, overlay, image, manifest, and required-license digest. The Firefox
source gate independently pins the native package identity and binds its
version and integrity to the root dependency and sole matching pnpm importer,
package, and snapshot records.

The shared derived stylesheet is required to scope every selector below
`.pin-op-elements-inspector`. Browser package verification rejects unscoped
selectors, CSS resource loads, remote UI resources, inline script/style/event
handlers, `eval`, `Function` construction, remote dynamic loading, upstream
snapshot paths, changed permissions or host permissions, optional permissions,
and any CSP drift. Both browser packages must carry byte-identical native
runtime bytes and the same complete Chromium root, embedded Apple/Pecoraro,
Lit, and CodeMirror notice inventory.

## Read-Only Rules And CSSOM Boundary

Chrome and Firefox use the same browser-local `styles.getMatched` route,
bounded CSS rule walker, stylesheet registry, applicability observer, and
immutable Rules projection. Rules reads available author CSSOM and selected
element state. It exposes no selector/property/value editor, declaration
toggle, Add Rule, Add Property, editable popover, or DOM/CSS mutation command.
The filter changes presentation only and cannot alter browser authority.

The browser runtime does not fetch stylesheet URLs in the background. A
cross-origin or otherwise unreadable stylesheet contributes only a bounded
inaccessible count and partial diagnostic; Pin-op does not invent its rules,
specificity, declarations, or source locations. Full stylesheet text, DOM
nodes, and adopted-sheet objects do not cross the public WebSocket merely to
render Rules. A displayed rule can contribute only bounded correlated evidence:
an opaque `ruleRef`, selector, exact declaration tuples, canonical public
HTTP(S) generated URL, numeric rule path or one-based position, and supported
outer-to-inner media/supports contexts. Local paths, userinfo, fragments,
non-public schemes, malformed URLs, unsupported ancestors, and truncated
contexts fail closed for source resolution.

The IDE independently verifies generated CSS against a workspace-owned AST and
accepts SCSS only through an exact usable source map and original AST proof.
Missing, invalid, ambiguous, stale, or outside-workspace maps show verified
generated CSS only, with no approximate SCSS authority. The browser sees only a
safe label, language, one-based start position, confidence, and opaque authority.

An explicit Rules origin click may switch VS Code to the verified workspace CSS
or SCSS document using a current IDE-issued opaque authority. The browser cannot
choose the file, full range, document version, source-map path, or command. The
IDE revalidates workspace/dependency ownership and document identity both before
and after the editor-host call; stale authority prevents cursor/reveal and is
revoked. Passive inspection never switches editors.

The pinned browser runtime includes PostCSS `8.5.16`,
`postcss-selector-parser` `7.1.0`, and `postcss-value-parser` `4.2.0` for bounded
parsing, selector analysis, and URL rebasing. Their bundled constructor uses
were reviewed as typed AST cloning/prototype wiring, not global `Function` or
`eval`. Package verification still rejects dynamic code evaluation and remote
code loading, and accepts the existing Zod schema-clone helper only for exact
reviewed legacy/Inspector bundle SHA-256 provenance. Generated Chrome and
Firefox notices include these packages and every bundled transitive license.

Stylesheet identity changes advance `stylesheetRevision` and aggregate
`stylesRevision`. Selector/group applicability changes advance only
`stylesRevision` and preserve current rule identity. Browser timer throttling
can delay bounded polling in a background tab, so manual Refresh is the
deterministic recomputation fallback; throttling never authorizes a write or a
fabricated result.

## Author-Style Pseudo Preview Boundary

The Rules `:hov` control offers `Preview :hover` and `Preview :focus` for a
supported subset of readable author rules. This is not native pseudo-state
forcing: it cannot reproduce UA/user rules, inaccessible CSS, closed-shadow
internals, or browser-engine state outside those author rules. Unsupported
selectors and grouping contexts, inaccessible stylesheets, mount rejection,
and unprovable cross-sheet source order are reported as partial or unavailable;
Pin-op does not guess their result.

The content runtime uses cryptographically random, session-scoped marker
attribute names and exact extension-owned temporary style node or constructable
sheet objects. It rewrites only supported positive `:hover`/`:focus` targets on
the selected subject compound and adds a zero-specificity selection guard.
Negated targets such as `:not(:hover)`, ancestor or sibling targets, `:has()`
targets, multiple target compounds, malformed selectors, and unsupported
grouping/cascade contexts fail closed. Marker attributes, temporary mounts, and
mirror rules are excluded from Pin-op DOM, Rules, inspect, overlay, recovery,
and stable-locator evidence.

The preview never directly calls an inspected-page function such as `focus()`
and does not dispatch input, focus, mouse, pointer, or keyboard events into the
inspected page. It nevertheless mutates the inspected page with extension-owned
markers/styles while enabled. Page scripts and MutationObservers can observe
those temporary preview artifacts, and applying author styles can indirectly
trigger transitions, animations, resource loads, callbacks, or other
application observers.

Controlled toggle replacement, selection, recovery, refresh, navigation,
disconnect, compatibility loss, lease replacement, and disposal remove only
the exact owned objects while the content context can still execute. Teardown
makes a bounded best-effort cleanup request before losing that context. Abrupt
extension termination, disable, update, or crash may leave artifacts until page
navigation or reload; no remaining extension context can promise earlier
object-identity cleanup.

## Bounded Facts Sent To VS Code

Only a valid selection creates protocol facts. Pin-op sends bounded facts
for the selected element and its immediate parent:

- page URL and route;
- tag, ID, classes, selectors, and permitted `data-*`, `aria-*`, and `role`
  names and values;
- canonical public stylesheet URL/accessibility, selectors, declarations,
  supported media/supports contexts, and correlated CSSOM rule-path or
  source-position evidence;
- namespaced development metadata when explicitly produced by the application.

These bounded inspection facts are not content-redacted. URLs, routes,
identifiers, attributes, CSS values, and application metadata can contain
sensitive data. Avoid sensitive pages unless sending these values to the linked
local VS Code window is acceptable.

The browser does not deliberately collect cookies, headers, form-control values,
workspace files, or source maps. Browser-local structured tree fields, including
bounded DOM text and comments, stay in the private inspected-tab channel and do
not travel over the product WebSocket. Local VS Code plugins read workspace
source and source maps only for local resolution. The IDE can return bounded
excerpts from its active document for Source presentation: at most 32 excerpts,
80 logical lines and 8 KiB per excerpt, in a 256 KiB message. Full documents,
workspace paths and URIs, source maps, and browser tab IDs are not sent. Pin-op
does not upload source or maps to a remote service.

Rules origin publications contain no workspace URI/path, full range, document
version, source-map content/path, or command. They contain only a safe label,
language, one-based start position, confidence, correlation, and opaque open
authority. The minimal `rules.open` request contains none of the display label
or position fields and has no acknowledgement message.

Before that IDE-to-browser send, the trusted VS Code host maps plugin `kind`
and `relation` strings to the closed protocol vocabularies, bounds and
normalizes display/document labels and language IDs, and rejects literal or
encoded path, URI, source-map, and browser-locator labels. Unsafe match labels
fall back to a safe host-derived active-document basename or `untitled`;
normalization failure sends no matches or navigation authority. Local
source-plugin match or diagnostic metadata can support diagnostics, but plugin
`SourceMatch.metadata` is never serialized into `source.matches`.

This boundary does not content-redact the excerpt text. It remains bounded code
from the active document and can contain secrets. See the
[wire contract](protocol.md#source-presentation-and-settings) and
[source-plugin guidance](source-plugin-authoring.md#browser-presentation-metadata).

## Resource Bounds

The bridge rejects WebSocket messages over 1 MiB. Protocol version `7` limits an
inspect envelope to 768 KiB, two targets, 256 facts per target, and bounded
strings, arrays, metadata, selectors, declarations, URLs, and routes. Resolution
replies and source-navigation messages are limited to 16 KiB and closed
status/diagnostic vocabularies. Source presentation is limited to 256 KiB and
the per-excerpt limits above. Rules source publication is limited to 256 entries
and 128 KiB, with independent generations and bounded labels, positions,
authority IDs, and unresolved counts.

Browser collection has byte, stylesheet, rule, nesting, declaration, class,
attribute, and inaccessible-stylesheet budgets. The browser-local tree limits
message size, channel count, node/page/path/invalidation counts, provider and
cursor records, scan slices, and rendered virtual rows. Work stops or fails
closed when a bound is reached.

## Source Resolution

Legacy Source/highlight resolution uses only the active document. Exact CSS
evidence wins. Its CSS fingerprint fallback requires stable
selector/media/declaration evidence and a unique result; ambiguity produces no
highlight. Its SCSS path requires one generated rule, a valid source map, and a
mapping into the active SCSS document. Missing, invalid, unmapped, ambiguous, or
other-document cases fail closed and produce a bounded footer status.

Rules origin resolution is a separate IDE-owned batch over bounded workspace
CSS/SCSS/map dependencies. It can authorize a cross-file open only after exact
CSS or source-mapped SCSS verification. Existing Source remains
active-document-only in the packaged, non-default legacy rollback panel for its
one published rollback release; the default Inspector has no visible Source
tab. A new Source tab and first-party PHP/template providers remain future
scope.

Pin-op does not load executable code from an inspected workspace. Built-in CSS
and SCSS resolvers use source-plugin API v3; its synchronous refresh classifiers
receive only canonical URI and language ID, not source text or workspace
services. A
separately installed source plugin is independently trusted VS Code extension
code. It receives the validated selection, active document, cancellation, and
bounded workspace discovery/read services. Review third-party plugins and their
privacy behavior separately.

## Sensitive Output

Pin-op does not deliberately place auth tokens or raw credentials in
diagnostics, protocol errors, source-plugin metadata, or inspection facts.
User-facing errors use bounded, sanitized vocabularies. Page-controlled values
and active-document source excerpts are not scanned for secret-looking content.

## Refresh Boundary

Auto Refresh is tab-local, defaults on only after a compatible handshake and a
fresh tab-state snapshot, and participates only while the panel is open.
Inactive participating tabs retain only the newest pending refresh and apply it
once when activated.

`styles` refresh examines at most 256 top-document external HTTP(S) stylesheet
links. It inserts a cache-busted clone and removes the old link only after the
replacement loads; failure leaves the old stylesheet in place. It does not
refresh inline styles, adopted stylesheets, data/blob URLs, or iframe documents.
`reload` captures bounded top-level scroll state and restores it after the
current tab reloads. Refresh messages select only the closed modes `styles` and
`reload`; they cannot carry script, URL, selector, or command payloads.

See [../PRIVACY.md](../PRIVACY.md) for data handling and
[../SECURITY.md](../SECURITY.md) for private reporting.
