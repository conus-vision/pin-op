# Browser2IDE Development Host Verification

For terminal-free acceptance of packaged `0.3.0` candidates, use the
[installed artifact verification guide](installed-verification.md). This
runbook uses development hosts and unpacked extensions to verify a source
checkout.

HTTP in this runbook serves only the fixture and stylesheet/frame resources.
Browser2IDE product traffic remains a loopback WebSocket.

## Prerequisites

- Node.js 22;
- pnpm through Corepack;
- VS Code;
- Firefox Stable 142 or newer;
- current Chrome or Chromium 116 or newer.

Run commands from the repository root unless stated otherwise.

## Automated Gates

Run each command separately and require exit code 0:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm exec web-ext lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
corepack pnpm --filter browser2ide-chrome test -- manifest.test.ts adapter.test.ts
corepack pnpm package
git diff --check
```

The package command creates and verifies the `0.3.0` VSIX, Chrome ZIP,
unsigned Firefox ZIP, Firefox source ZIP, and `SHA256SUMS`.

The packaged Chrome artifact smoke is separate:

```powershell
corepack pnpm smoke:chrome-package
```

On Linux, `smoke:chrome-package` requires a graphical session or Xvfb. Set
`DISPLAY` or `WAYLAND_DISPLAY`, or run it under `xvfb-run -a`; the script refuses
to launch Chrome without one of those display paths.

The focused browser-core suite can be useful while iterating:

```powershell
corepack pnpm --filter @browser2ide/protocol build
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/windowWorkflow.test.ts test/pageOverlay.test.ts test/domTreeProvider.test.ts test/domTreeController.test.ts
```

## Build And Serve The Fixture

Build once:

```powershell
corepack pnpm build
```

Start the fixture in terminal 1:

```powershell
node examples/basic-css/server.mjs
```

Keep `http://127.0.0.1:4173/` running. The fixture contains:

- source-mapped `src/card.scss` and `src/layout.scss`;
- generated `dist/app.css`;
- a CSSOM path-miss fingerprint case and duplicate-selector ambiguity;
- inline, runtime-injected, virtual, CORS-readable, and inaccessible styles;
- multiline overlay geometry;
- dynamic DOM mutation controls;
- an open shadow root;
- same-origin and cross-origin frames.

## Start Two VS Code Development Windows

In terminals 2 and 3:

```powershell
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

Call them IDE A and IDE B. In both:

1. Confirm Browser2IDE starts automatically.
2. Confirm the status item shows a grouped port and two-digit PIN.
3. Confirm the windows show different current codes.
4. Click each status item and associate its clipboard value with A or B.
5. Open `examples/basic-css/src/layout.scss` and keep Applicable Sources open.

Do not run a separate bridge process.

## Load Firefox For Development

In terminal 4, create one disposable profile and preserve it for restarts in
this verification run:

```powershell
$firefoxProfile = Join-Path $env:TEMP ("browser2ide-0.3.0-" + [guid]::NewGuid().ToString("N"))
corepack pnpm exec web-ext run --source-dir extensions/firefox --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --firefox-profile "$firefoxProfile" --profile-create-if-missing --keep-profile-changes --start-url http://127.0.0.1:4173/
```

If `firefox` is on `PATH`, omit only the explicit executable option. Use normal,
non-private windows.

## Load Chrome For Development

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `extensions/chrome`.
4. Open the fixture in two normal browser windows.
5. After rebuilding, use the extension card's Reload action.

## Browser Parity Matrix

Run the complete matrix once in Firefox Stable and once in current
Chrome/Chromium.

### Link Explicit Windows

1. Open the Browser2IDE DevTools panel in Browser Window A. Confirm `Not linked`.
2. Paste or enter IDE A's code and select **Link**.
3. Confirm `Connected` and the same grouped code displayed by IDE A.
4. Link Browser Window B independently to IDE B.
5. Open a third browser window and confirm it starts `Not linked`.
6. Open a second fixture tab and panel in each linked window. Confirm it reuses
   that window's link and displayed code.
7. Confirm each IDE reports one browser-window client, not one per tab.

Close every panel in Window A and confirm its active socket closes. Reopen one
panel and confirm it reconnects from session credentials without scanning ports
or reading the clipboard.

### Page Picker And Box Model

1. Select the mouse-pointer button in Window A.
2. Hover `#fixture-card`. Confirm the overlay label and separate margin, border,
   padding, and content layers track the element.
3. Hover `.multiline-inline`. Confirm each client rect is represented without
   blocking pointer input.
4. Click `#fixture-card`. Confirm the element is selected and the fixture's
   normal-click counter does not increment while the picker owns the gesture.
5. Scroll and resize while hovering. Confirm the overlay updates without stale
   geometry.
6. Press Escape once to clear preview and again to turn off the picker.
7. Repeat inside the same-origin frame and open shadow root.
8. Confirm cross-origin frame contents and unsafe geometry fail closed.

### Lazy DOM Tree

1. Confirm the tree initially loads only its root.
2. Expand `html`, `body`, `main.layout`, and the fixture sections. Confirm child
   requests occur only on expansion and `Load more` pages a large branch.
3. Hover `article#fixture-card.card.featured` and confirm the same overlay.
4. Select it from the tree and confirm the same source-selection path as the
   picker.
5. Use Arrow keys and Enter to navigate, disclose, and select.
6. Select a page element whose branch is collapsed and confirm the bounded
   ancestor path is revealed and focused.
7. Expand the explicit open-shadow row and select `.shadow-action`.
8. Expand the same-origin iframe and its frame-document row.
9. Confirm the cross-origin frame is a locked leaf with no disclosure action.
10. Add a dynamic card and confirm only the affected expanded branch refreshes.
11. Navigate/reload a frame and confirm old document epochs, node refs, cursors,
    and branch revisions are rejected.

Tree labels must remain plain text and show no DOM text or approved-attribute
values. The extension's own overlay must never appear in the tree.

### Active-Document Resolution

Select `.card.featured` while `src/layout.scss` is active. Confirm:

- the footer first reports `Resolving in VS Code`;
- the complete `.layout > .card` block is Selected;
- the immediate parent's `.layout` block is Parent;
- all ranges include closing braces and appear in Applicable Sources;
- the final footer uses
  `<N> rules highlighted · Selected <S> · Parent <P>`;
- selecting an Applicable Sources item reveals within the already active editor.

Without another browser selection:

1. Switch to `src/card.scss` and confirm multiple Selected ranges.
2. Switch to `dist/app.css` and confirm CSS ranges with Selected/Parent roles.
3. Activate `index.html` and confirm `Unsupported active file: html`.
4. Close every editor and select again; confirm `No active editor`.

Exercise `.browser2ide-path-miss` with CSS active. Confirm the unique CSS
fingerprint fallback resolves. Select `.duplicate-selector` and confirm
`Ambiguous rule match` rather than an arbitrary range.

For SCSS, temporarily test missing, unreadable/invalid, and unmapped source-map
variants. Confirm `SCSS source map missing`, `SCSS source map invalid`, or
`No matching rules in active file`, with no guessed highlight. Restore the
fixture after the checks.

### Installed `_ORB` Workspace Check

Repeat this focused check with the packaged `0.3.0` extensions and the normal
terminal-free link workflow:

1. Open a workspace containing an open folder named `_ORB`.
2. Load `http://localhost/_ORB/` and confirm the selected element uses
   `/_ORB/wp-content/themes/orbiter/style.css?v=7`.
3. Keep the mapped `style.scss` active in VS Code. Leave other `style.css` files
   in the workspace so duplicate basenames are present.
4. Select the styled element and confirm complete SCSS blocks, including their
   closing braces, are highlighted.
5. Run **Browser2IDE: Open Diagnostics** and confirm the exact local diagnostic
   `Workspace-bound: _ORB`; it must not report `Ambiguous source path`.

Return to the existing repository-root fixture at `http://127.0.0.1:4173/`,
select `.card.featured` with `src/layout.scss` active, and open diagnostics.
Because that fixture URL has no workspace identity, confirm the exact local
diagnostic `Automatic source matching`.

### Window Isolation And Peer State

1. Alternate selections in Windows A and B. Only their explicitly linked IDE
   may update.
2. Stop IDE A. Confirm Window A reports `Linked IDE offline` or
   `VS Code disconnected`, while Window B remains usable.
3. Restart IDE A. Confirm it has a fresh code and old credentials do not attach.
4. Link Window A with the new code and confirm resolution resumes.
5. Select **Disconnect** in Window A. Confirm only Window A returns to
   `Not linked`; Window B and IDE B continue unchanged.
6. Reconnect A for cleanup checks.

Leave Chrome panels active for at least 45 seconds and select again to cover the
Manifest V3 service-worker heartbeat path.

## Verify Session Storage Cleanup

Inspect extension background tools:

- Firefox: `about:debugging#/runtime/this-firefox` > Browser2IDE > Inspect;
- Chrome: `chrome://extensions` > Browser2IDE > service worker.

List keys only, never values containing tokens:

```js
Object.keys(await browser.storage.session.get(null))
Object.keys(await chrome.storage.session.get(null))
```

Confirm one `browser2ide.windowLink.<windowId>` key per linked browser window.
Disconnect or close Window A and confirm only its key disappears. Restart the
complete browser profile and confirm no prior window-link key survives. A newly
opened panel must start `Not linked`.

## Cleanup

1. Turn off page pickers and select **Disconnect** in each browser window.
2. Stop Browser2IDE in both VS Code windows.
3. Close the development hosts and development-loaded browsers.
4. Stop the fixture and Firefox development process with `Ctrl+C`.

## Regenerate The CSS Fixture

After changing SCSS fixture source:

```powershell
corepack pnpm exec sass examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
