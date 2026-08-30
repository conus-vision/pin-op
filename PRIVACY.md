# Privacy

Pin-op has no analytics, telemetry pipeline, account system, or remote
Pin-op service. It exposes no product HTTP endpoint. Product traffic uses
only a loopback WebSocket between an explicitly linked browser window and the
local VS Code window selected by the user.

## Data Sent To VS Code

For a selected element and its immediate DOM parent, Pin-op can send these
bounded inspection facts:

- the full page URL and route;
- tag, ID, classes, selector candidates, and permitted `data-*`, `aria-*`, and
  `role` names and values;
- CSS selectors and declarations, stylesheet source URLs, media conditions,
  CSSOM rule paths, and inaccessible-stylesheet counts;
- bounded development source metadata supplied by the inspected application.

These values are size-bounded but not content-redacted. Application-controlled
URLs, routes, identifiers, attributes, CSS, and source metadata may contain
personal data, secrets, or framework state. Do not inspect sensitive pages
unless sending those values to the linked local VS Code window is acceptable.

Pin-op does not deliberately collect cookies, request or response headers,
form-control values, or source-map contents in the browser. The Inspector reads
bounded DOM text and comments for browser-local structured rows, but does not
send them over the product WebSocket. The browser side sends stylesheet
identity and rule evidence. Local VS Code source plugins may read relevant
workspace files and source maps to resolve the active document.

For Source presentation, VS Code can send bounded excerpts from the active IDE
document back to the explicitly linked browser window. An excerpt contains an
opaque match ID, Selected/Parent role, display metadata, one-based line bounds,
and bounded source text. At most 32 excerpts are sent; each is limited to 80
logical lines and 8 KiB, and the complete message is limited to 256 KiB. Pin-op
does not send full source documents, workspace paths, source URIs, source-map
contents, or browser tab IDs over this channel. It does not upload workspace
source to a remote service.

Before sending `source.matches`, the trusted VS Code host maps unknown plugin
`kind` and `relation` values to `source` and `matches`, bounds and normalizes
display/document labels and language IDs, and rejects literal or encoded path,
URI, source-map, and browser-locator labels. Unsafe match labels fall back to a
safe host-derived active-document basename or `untitled`; normalization failure
sends no matches or navigation authority. Local source-plugin match or
diagnostic metadata can remain in VS Code for diagnostics, but plugin
`SourceMatch.metadata` is never serialized into `source.matches`. See the
[protocol contract](docs/protocol.md#source-presentation-and-settings) for the
complete normalization rules.

This metadata boundary does not content-redact excerpt text. A bounded excerpt
is code from the active document and may itself contain personal data or
secrets. Do not use Source presentation on sensitive source unless sending that
code to the linked browser window is acceptable.

A Rules origin publication uses the standard authenticated protocol envelope
and route correlation. Each resolved entry carries an opaque `ruleRef`, a
sanitized basename label, CSS/SCSS language, one-based start position,
confidence, and a current opaque open authority; the envelope also carries
`rulesGeneration`, `unresolvedRuleCount`, and the required empty metadata
object. No workspace URI/path, full range, document version, source-map path or
content, or command crosses the bridge. After an explicit Rules origin click,
the browser returns the inspect correlation, Rules generation, and opaque
authority. There is no open acknowledgement carrying local data.

## Browser-Local Inspector Data

The DOM tree stays browser-local. Element labels, browser-local node refs,
expansion pages, selection paths, document epochs, branch revisions, and the
box-model overlay are exchanged only among the DevTools panel, extension
background, and inspected-tab content runtime. They are not sent over the
Pin-op product WebSocket.

Structured Inspector rows can show bounded attribute names and values plus
bounded DOM text and comments. Text and comment rows are display-only and have
no stable locator. This data stays browser-local in the private inspected-tab
channel and does not cross the product WebSocket. Open shadow roots and
same-origin frame documents
can be traversed. Cross-origin frames become locked leaves and fail closed.
Closed shadow roots are not traversed and fail closed.

The `:hover` and `:focus` controls are an author-style preview, not native
pseudo-state forcing. While a preview is enabled, the inspected-page runtime
adds random extension-owned marker attributes to the selected element and
mounts temporary mirror styles in the accessible document or open shadow root.
Pin-op filters those artifacts from its own DOM, Rules, locator, and inspect
evidence, but page scripts and MutationObservers can observe those temporary
preview artifacts while the preview is enabled. Applying the mirrored author
styles can also trigger CSS transitions, animations, resource loads, and
application observers.

Pseudo preview does not call `focus()` and does not dispatch input, focus,
mouse, pointer, or keyboard events. Controlled state changes, selection,
refresh, navigation, disconnect, compatibility loss, and disposal remove the
exact extension-owned artifacts while the content context can still run.
Abrupt extension termination, disable, update, or crash can destroy that
cleanup context first and leave preview artifacts until page navigation or
reload.

## Clipboard And Session Storage

VS Code places the link code on the operating-system clipboard only after the
user clicks its status item. The browser reads the clipboard only after the user
clicks Paste. Manual entry remains available when clipboard access is denied.

After a successful link, the browser stores one record per linked browser
window in `browser.storage.session`. It contains the exact loopback endpoint,
session and bridge identities, browser token, and formatted display code. This
session storage lets a reopened panel confirm the same displayed code; it is not
durable local storage. Disconnect removes only that browser window's record and
revokes its token. Closing the window or ending the browser session removes the
session-only record.

The two-digit PIN reduces accidental cross-linking between local VS Code
windows. It is not strong authentication and must not be treated as protection
against a malicious process running as the same desktop user.

## Browser Permissions

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Inject the bounded Inspector runtime into the page being debugged. |
| `activeTab` | Declare the browser's temporary user-gesture capability; it does not replace required inspected-page access. |
| `clipboardRead` | Read a link code only after Paste is clicked. |
| `scripting` | Inject the inspected-page runtime. |
| `storage` | Keep browser-window links in session storage. |
| `tabs` | Bind DevTools panels and inspected tabs to the correct browser window. |
| `http://127.0.0.1/*`, `http://localhost/*` | Declare local resource host access; product traffic still does not use HTTP. |

The extension Content Security Policy separately permits loopback WebSocket
connections. Opening a compatible linked DevTools panel makes that tab eligible
for Auto Refresh when the tab-local setting is on, but does not begin DOM
inspection. Page picking starts only after the panel is open, its browser window
is linked, and the user enables the picker. Browser-protected pages can still
reject injection.

## Read-Only Design

Pin-op exposes no user-authored CSS or DOM editing operations, does not write or
edit workspace source, and does not execute page, shell, workspace, or
user-supplied commands. Its extension-owned page changes are limited to the
inspection overlay, the temporary pseudo-preview markers and mirror styles
described above, and typed Auto Refresh replacement of an eligible stylesheet
link. Passive inspection and the Source flow highlight or reveal only
the document already active in VS Code. An explicit Rules origin click may
switch VS Code to a verified workspace CSS or SCSS file using a current
IDE-issued opaque authority. Missing or invalid source maps expose verified
generated CSS only, never an approximate SCSS location. Auto Refresh can
replace eligible stylesheet links or reload the current participating tab; it
does not edit page-owned source or application data. These commitments apply to
Pin-op-operated components, not to separately installed source plugins.

Source remains active-document-only; first-party PHP/template providers remain
a future milestone.

## Source Plugins

Compatible source plugins receive the validated selection, active document, and
bounded workspace discovery/read services inside VS Code. A separately installed
source plugin is trusted third-party extension code and may have its own network,
retention, and privacy behavior. Review it independently before use.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[docs/security.md](docs/security.md) for the implementation trust model.
