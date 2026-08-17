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
form values, DOM text, or source-map contents. The browser side sends
stylesheet identity and rule evidence. Local VS Code source plugins may read
relevant workspace files and source maps to resolve the active document.

For Source presentation, VS Code can send bounded excerpts from the active IDE
document back to the explicitly linked browser window. An excerpt contains an
opaque match ID, Selected/Parent role, display metadata, one-based line bounds,
and bounded source text. At most 32 excerpts are sent; each is limited to 80
logical lines and 8 KiB, and the complete message is limited to 256 KiB. Pin-op
does not send full source documents, workspace paths, source URIs, source-map
contents, or browser tab IDs over this channel. It does not upload workspace
source to a remote service.

## Browser-Local Inspector Data

The DOM tree stays browser-local. Element labels, browser-local node refs,
expansion pages, selection paths, document epochs, branch revisions, and the
box-model overlay are exchanged only among the DevTools panel, extension
background, and inspected-tab content runtime. They are not sent over the
Pin-op product WebSocket.

DOM tree labels show bounded tag, ID, class, and approved attribute names; they
do not include attribute values or DOM text. Open shadow roots and same-origin
frame documents can be traversed. Cross-origin frames become locked leaves and
fail closed. Closed shadow roots are not traversed and fail closed.

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

Pin-op does not write or edit page or workspace source and does not execute
page, shell, workspace, or user-supplied commands. It highlights and opens
source ranges only in the document already active in VS Code. Auto Refresh can
replace eligible stylesheet links or reload the current participating tab; it
does not edit page-owned source or application data. These commitments apply
to Pin-op-operated components, not to separately installed source plugins.

## Source Plugins

Compatible source plugins receive the validated selection, active document, and
bounded workspace discovery/read services inside VS Code. A separately installed
source plugin is trusted third-party extension code and may have its own network,
retention, and privacy behavior. Review it independently before use.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[docs/security.md](docs/security.md) for the implementation trust model.
