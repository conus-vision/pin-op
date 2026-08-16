# Pin-op

Pin-op highlights source code in VS Code for a DOM element selected in
Firefox or Chrome/Chromium DevTools.

## Install From VSIX

1. Open the Command Palette and run **Extensions: Install from VSIX...**.
2. Select `pin-op-vscode-0.3.0.vsix` and reload VS Code if prompted.
3. Open a local project. Pin-op starts automatically.

## Link And Inspect

Normal use is terminal-free:

1. Click the Pin-op status item. It copies the five-digit port and
   two-digit PIN shown as a grouped code such as `48735 07`.
2. Open the Pin-op DevTools panel in one browser window.
3. Paste the code, select **Link**, and confirm the same displayed code appears
   in VS Code and DevTools.
4. Keep the intended CSS or SCSS document active in VS Code.
5. Use the page picker or lazy DOM tree to select an element.
6. Read the exact footer outcome. Matching Selected and immediate Parent rules
   appear as distinct, possibly multiple source ranges in the active document.

The picker shows a box-model overlay. The DOM tree includes open shadow roots
and same-origin frames; cross-origin frames are locked and closed shadow roots
fail closed. CSS can use a conservative fingerprint fallback. SCSS requires a
usable source map and fails closed when the mapping is missing or invalid.

**Disconnect** unlinks only the current browser window. Pin-op does not
edit files, execute commands, or switch the active editor.

Source, installation details, architecture, and issue tracking are available in
the [Pin-op repository](https://github.com/conus-vision/pin-op) and
[issue tracker](https://github.com/conus-vision/pin-op/issues). The extension
ID is `conus-vision.pin-op`.
