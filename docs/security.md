# Browser2IDE Security

Browser2IDE is a local, read-only development tool. Its model assumes the
browser and VS Code extensions run under one trusted desktop user account. It
does not treat every other process under that account as trusted.

## Transport Boundary

Browser2IDE has no product HTTP API. Product traffic uses a loopback WebSocket:

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

Browser2IDE never discovers an IDE. The user clicks the intended VS Code
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

The read-only scope is essential to this risk decision. Browser2IDE does not
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

Protocol version `4` binds each accepted inspect ID to the exact browser
connection that sent it. IDE resolution replies are routed only to that
connection. Cross-connection inspect-ID collisions, stale routes, wrong roles,
and wrong sessions fail closed. Routes are bounded and removed with the client.

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

Injection requires all of these conditions:

- the Browser2IDE DevTools panel is open for the tab;
- its browser window has an explicit link;
- the user enables the page picker or requests the tab's DOM tree.

Browser-protected pages can reject injection. Browser2IDE has no feature that
navigates a page, submits forms, edits DOM or source, reads cookies, or invokes
user-supplied code.

## Browser-Local DOM Tree

The DOM tree stays browser-local. Its node refs, labels, child pages, cursors,
selection path, document/frame epochs, branch revisions, hover state, and
box-model geometry do not travel over the product WebSocket.

The panel talks to the inspected tab through a background-bound opaque channel.
Node refs are useful only within that channel and current document/frame
authority. Navigation, mutation, collapse, frame lifecycle changes, record
pressure, and disposal invalidate stale refs and cursors.

Tree labels are bounded plain text. They include tag, ID, classes, and approved
attribute names but not DOM text or attribute values. The tree renders only
element nodes plus explicit open-shadow and frame-document boundaries.

- Open shadow roots are traversed only when the platform exposes them.
- Same-origin frame documents are registered under bounded frame authority.
- A cross-origin frame becomes an inaccessible locked leaf and must fail closed.
- A closed shadow root cannot be inspected and must fail closed.

The overlay is extension-owned, `aria-hidden`, pointer-inert, style-isolated,
and excluded from tree traversal. Unsafe transformed or fragmented geometry is
omitted rather than approximated.

## Bounded Facts Sent To VS Code

Only a valid selection creates protocol facts. Browser2IDE sends bounded facts
for the selected element and its immediate parent:

- page URL and route;
- tag, ID, classes, selectors, and permitted `data-*`, `aria-*`, and `role`
  names and values;
- stylesheet URL/accessibility, selectors, declarations, media conditions, and
  CSSOM rule-path or source-position evidence;
- namespaced development metadata when explicitly produced by the application.

These bounded inspection facts are not content-redacted. URLs, routes,
identifiers, attributes, CSS values, and application metadata can contain
sensitive data. Avoid sensitive pages unless sending these values to the linked
local VS Code window is acceptable.

The browser does not deliberately collect cookies, headers, form-control values,
DOM text, workspace files, source maps, or source text. Local VS Code plugins
read workspace source and source maps only for local resolution. Browser2IDE
does not upload source or maps to a remote service.

## Resource Bounds

The bridge rejects WebSocket messages over 1 MiB. Protocol version `4` limits an
inspect envelope to 768 KiB, two targets, 256 facts per target, and bounded
strings, arrays, metadata, selectors, declarations, URLs, and routes. Resolution
replies are limited to 16 KiB and closed status/diagnostic vocabularies.

Browser collection has byte, stylesheet, rule, nesting, declaration, class,
attribute, and inaccessible-stylesheet budgets. The browser-local tree limits
message size, channel count, node/page/path/invalidation counts, provider and
cursor records, scan slices, and rendered virtual rows. Work stops or fails
closed when a bound is reached.

## Source Resolution

The IDE resolves only the active document. Exact CSS evidence wins. The CSS
fingerprint fallback requires stable selector/media/declaration evidence and a
unique result; ambiguity produces no highlight. SCSS requires one generated
rule, a valid source map, and a mapping into the active SCSS document. Missing,
invalid, unmapped, ambiguous, or other-document cases fail closed and produce a
bounded footer status.

Browser2IDE does not load executable code from an inspected workspace. A
separately installed source plugin is independently trusted VS Code extension
code. It receives the validated selection, active document, cancellation, and
bounded workspace discovery/read services. Review third-party plugins and their
privacy behavior separately.

## Sensitive Output

Browser2IDE does not deliberately place auth tokens or raw credentials in
diagnostics, protocol errors, source-plugin metadata, or inspection facts.
User-facing errors use bounded, sanitized vocabularies. Page-controlled values
are not scanned for secret-looking content.

See [../PRIVACY.md](../PRIVACY.md) for data handling and
[../SECURITY.md](../SECURITY.md) for private reporting.
