# Store Listings

## GitHub About
Select a DOM element in Firefox or Chrome and reveal its CSS/SCSS source directly in VS Code.

## Firefox AMO
Pin-op connects one Firefox window to one local VS Code window through an
explicit seven-digit code. Select an element on the page or in the lazy DOM
tree, then inspect its DOM and Rules while the related CSS or source-mapped SCSS
ranges are highlighted in the IDE.

Pin-op distinguishes rules for the selected element from rules for its
immediate parent. Auto Refresh updates eligible styles without reloading the
page and reloads the current tab with scroll restoration after changed script,
Vue, PHP, or HTML saves.

Chrome and Firefox use one shared Chromium-derived read-only Inspector UI. It
is a BSD-licensed derivation with attribution in the package notices, and the
pinned Chromium source is available in the Firefox release source archive.

Only after an explicit Rules origin click may Pin-op open the exact verified CSS
or original source-mapped SCSS block in VS Code using an IDE-issued opaque
authority. Passive inspection never switches files, and no workspace path,
full range, document version, or command crosses the bridge.

The author-style pseudo preview supports `:hover` and `:focus`; it is not native
forcing and provides no user-authored CSS or DOM editing operations. Pin-op
does not dispatch input, focus, mouse, pointer, or keyboard events.

Page scripts may observe temporary preview artifacts while enabled, and mirror
styles may trigger transitions, animations, or resource loads. Controlled
exits remove Pin-op-owned markers and styles. Abrupt extension termination can
leave artifacts until page navigation or reload.

Unsupported cases are reported rather than invented. Inaccessible stylesheet
rules are unavailable and reported as PARTIAL. Cross-origin frames are
unavailable, and closed shadow roots are unavailable. Unsupported
`:not(:hover)` is PARTIAL; unsupported results are not guessed.

The packaged legacy rollback `panel.html` remains for exactly one published
rollback release. Remove it only after support reports or manual field reports
confirm no blocking regression. The default Inspector has no visible Source
tab; Source remains active-document-only in the explicit rollback panel.

The connection uses a loopback-only WebSocket and explicit browser-window
linking, with no remote Pin-op service. Firefox 142 or newer and the matching
Pin-op VS Code extension are required.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)

## Chrome Web Store
Pin-op connects one Chrome or Chromium window to one local VS Code window
through an explicit seven-digit code. Select an element on the page or in the
lazy DOM tree, then see the related CSS or source-mapped SCSS ranges highlighted
in the active IDE file and inspect its DOM and Rules.

Pin-op distinguishes rules for the selected element from rules for its
immediate parent. Auto Refresh updates eligible styles without reloading the
page and reloads the current tab with scroll restoration after changed script,
Vue, PHP, or HTML saves.

Chrome and Firefox use one shared Chromium-derived read-only Inspector UI. It
is a BSD-licensed derivation with attribution in the package notices, and the
pinned Chromium source is available in the Firefox release source archive.

Only after an explicit Rules origin click may Pin-op open the exact verified CSS
or original source-mapped SCSS block in VS Code using an IDE-issued opaque
authority. Passive inspection never switches files, and no workspace path,
full range, document version, or command crosses the bridge.

The author-style pseudo preview supports `:hover` and `:focus`; it is not native
forcing and provides no user-authored CSS or DOM editing operations. Pin-op
does not dispatch input, focus, mouse, pointer, or keyboard events.

Page scripts may observe temporary preview artifacts while enabled, and mirror
styles may trigger transitions, animations, or resource loads. Controlled
exits remove Pin-op-owned markers and styles. Abrupt extension termination can
leave artifacts until page navigation or reload.

Unsupported cases are reported rather than invented. Inaccessible stylesheet
rules are unavailable and reported as PARTIAL. Cross-origin frames are
unavailable, and closed shadow roots are unavailable. Unsupported
`:not(:hover)` is PARTIAL; unsupported results are not guessed.

The packaged legacy rollback `panel.html` remains for exactly one published
rollback release. Remove it only after support reports or manual field reports
confirm no blocking regression. The default Inspector has no visible Source
tab; Source remains active-document-only in the explicit rollback panel.

The connection uses a loopback-only WebSocket and explicit browser-window
linking, with no remote Pin-op service. Chrome/Chromium 116 or newer and the
matching Pin-op VS Code extension are required.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)
