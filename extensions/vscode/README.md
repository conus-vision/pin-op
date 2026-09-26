# Pin-op

Select a DOM element in Firefox or Chrome and see matching CSS or
source-mapped SCSS ranges highlighted in the active VS Code file.

You already found the rule in DevTools. Pin-op saves you finding it a second
time in the editor: pick the element in the browser and the blocks that style
it light up here. Click a declaration in the browser's Rules pane and this
editor opens it with the cursor on the value.

## Install

Pin-op has two halves and needs both. This extension is the IDE half. The
browser half is a DevTools panel you install separately:

- Chrome and Chromium 116+:
  [Chrome Web Store](https://chromewebstore.google.com/detail/pkfpamadjoolcfkaadnleagmhbapepci)
- Firefox Stable 142+:
  [Firefox Add-ons](https://addons.mozilla.org/addon/pin-op/)

Install the matching release of both halves. VS Code is the only IDE a browser
window can link to; support for other IDEs is in development.

To install this extension from a local package instead of the Marketplace:

1. Open the Command Palette and run **Extensions: Install from VSIX...**.
2. Select `pin-op-vscode-0.4.2.vsix` and reload VS Code if prompted.
3. Open a local project. Pin-op starts automatically.

## Link And Inspect

Normal use needs no terminal:

1. Click the Pin-op status item. It copies that VS Code window's seven-digit
   link code, shown as a five-digit port and a two-digit PIN such as `48735 07`.
2. Open the Pin-op DevTools panel in one Firefox or Chrome/Chromium window.
3. Paste the code, select **Link**, and check that the same displayed code
   appears in VS Code and DevTools.
4. Keep the active CSS, SCSS, PHP, or script file you want highlighted open in
   VS Code.
5. Pick an element with the page picker or the lazy DOM tree.
6. Read the exact footer outcome. Matching Selected and immediate Parent blocks
   appear as separate, possibly multiple source ranges in the active document.
7. Click a Rules origin to open its exact verified CSS or source-mapped SCSS
   block, or click a declaration to land on its value. The Source tab shows
   short excerpts from the active document.

**Disconnect** unlinks only the current browser window. Other browser windows
keep their own links.

## What Pin-op Resolves

The picker shows a box-model overlay. The lazy DOM tree includes open shadow
roots and same-origin frames; cross-origin frames are locked, and closed shadow
roots stay closed. CSS can fall back to a conservative unique fingerprint.
Source-mapped SCSS needs a usable source map, and Pin-op stops when the mapping
or the active source document cannot be identified safely.

Rules finds the stylesheet a page loaded by its content, not by the URL's
folders, so a dev server or a renamed build output still leads to your file.
A Rules click can open a different verified workspace file, but only when you
click. Missing or invalid maps show verified generated CSS only and never an
approximate SCSS origin.

For PHP templates and JavaScript, TypeScript, JSX, or TSX files, Pin-op lists
where the active file names the selected element: its markup, selector
strings, `classList` calls, JSX tags, and similar references.

**Auto Refresh** and **IDE Highlight** are set per tab and start on after a
compatible protocol-v7 handshake and fresh tab state. Saving changed
CSS/SCSS/Sass/Less refreshes the eligible stylesheets; saving changed
JavaScript, TypeScript, Vue, PHP, or HTML reloads the current participating tab
and restores its scroll position. Unchanged saves do nothing. Turning IDE
Highlight off clears the decorations only; resolution, Source presentation, and
navigation keep working.

## Safety And Compatibility

Pin-op is read-only. It does not edit files or execute caller-supplied commands.
An explicit Rules origin click may switch VS Code using a current IDE-issued
opaque authority; passive inspection never switches editors. No workspace
URI/path, full range, document version, or command crosses the bridge.
Browser-local DOM references stay in the browser, and product traffic uses
explicit window linking over a loopback-only WebSocket.

Firefox Stable 142+ and Chrome/Chromium 116+ are supported with a matching local
VS Code extension. Remote SSH and WSL extension hosts are not supported.

The browser and IDE extensions must use the same protocol generation. Protocol
v6 is rejected with WebSocket close code `1002`, with no fallback. When the
panel reports incompatible extensions, update both, restart them, and reconnect.

## Documentation

Read the [usage guide](https://github.com/conus-vision/pin-op/blob/master/docs/mvp-usage.md),
[architecture overview](https://github.com/conus-vision/pin-op/blob/master/docs/architecture.md),
[protocol contract](https://github.com/conus-vision/pin-op/blob/master/docs/protocol.md),
[privacy policy](https://github.com/conus-vision/pin-op/blob/master/PRIVACY.md),
and [security model](https://github.com/conus-vision/pin-op/blob/master/docs/security.md).
Source and issue tracking are in the
[Pin-op repository](https://github.com/conus-vision/pin-op) and
[issue tracker](https://github.com/conus-vision/pin-op/issues). The extension
ID is `conus-vision.pin-op`.

Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)
