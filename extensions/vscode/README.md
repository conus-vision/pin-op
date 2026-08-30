# Pin-op

Select a DOM element in Firefox or Chrome and see matching CSS or
source-mapped SCSS ranges highlighted in the active VS Code file.

## Install From VSIX

1. Open the Command Palette and run **Extensions: Install from VSIX...**.
2. Select `pin-op-vscode-0.3.2.vsix` and reload VS Code if prompted.
3. Open a local project. Pin-op starts automatically.

## Link And Inspect

Normal use is terminal-free:

1. Click the Pin-op status item. It copies that VS Code window's seven-digit
   link code, displayed as a five-digit port and two-digit PIN such as `48735 07`.
2. Open the Pin-op DevTools panel in one Firefox or Chrome/Chromium window.
3. Paste the code, select **Link**, and confirm the same displayed code appears
   in VS Code and DevTools.
4. Keep the intended highlight or legacy Source document active in VS Code.
5. Use the page picker or lazy DOM tree to select an element.
6. Read the exact footer outcome. Matching Selected and immediate Parent rules
   appear as distinct, possibly multiple source ranges in the active document.
7. In the Inspector candidate, explicitly click a current Rules origin to open
   its exact verified CSS or source-mapped SCSS block. The legacy rollback panel
   instead keeps bounded Source excerpts active-document-only.

**Disconnect** unlinks only the current browser window. Other browser windows
keep their independent links.

## What Pin-op Resolves

The picker shows a box-model overlay. The lazy DOM tree includes open shadow
roots and same-origin frames; cross-origin frames are locked and closed shadow
roots fail closed. CSS can use a conservative unique fingerprint fallback.
Source-mapped SCSS requires a usable source map and fails closed when the
mapping or active source document cannot be identified safely.
Rules source navigation can open a different verified workspace file only after
an explicit click. Missing or invalid maps show verified generated CSS only and
never an approximate SCSS origin.

**Auto Refresh** and **IDE Highlight** are tab-local and default on after a
compatible protocol-v7 handshake and fresh tab state. Changed CSS/SCSS/Sass/Less
saves refresh eligible stylesheets; changed JavaScript, TypeScript, Vue, PHP,
and HTML saves reload the current participating tab with scroll restoration.
Unchanged saves do nothing. Turning IDE Highlight off clears decorations only;
resolution, Source presentation, and navigation remain available.

## Safety And Compatibility

Pin-op is read-only. It does not edit files or execute caller-supplied commands.
An explicit Rules origin click may switch VS Code using a current IDE-issued
opaque authority; passive inspection never switches editors. No workspace
URI/path, full range, document version, or command crosses the bridge. The new
Inspector has no visible Source tab; existing Source remains
active-document-only in the legacy rollback panel. A new Source tab and
first-party PHP/template providers remain future scope. Browser-local DOM
references stay in the browser, and product traffic uses explicit window
linking over a loopback-only WebSocket.

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
