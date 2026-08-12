# PinOp Usage

Normal use with installed PinOp extensions is terminal-free. Contributor
commands belong in [development-host verification](mvp-verification.md), not in
the installed workflow.

## Link One Browser Window

1. Open the project in the local VS Code window that should receive selections.
   PinOp starts automatically.
2. Find a status item such as `PinOp: 48735 07` and click it. VS Code
   copies the ungrouped code, `4873507` in this example.
3. Open DevTools for the page in Firefox Stable or current Chrome/Chromium, then
   open the **PinOp** DevTools panel in that browser window.
4. Select Paste, or enter the code manually, and select **Link**.
5. Confirm the panel reports `Connected` and shows the same displayed code as
   the VS Code status item.
6. Keep the intended CSS or SCSS document active in VS Code.
7. Select an element with the page picker or DOM tree and read the exact footer
   outcome.

The visual space separates the five-digit port from the two-digit PIN. Leading
zeroes in the PIN matter. Clipboard access occurs only after Paste is selected;
manual entry remains available when it is denied.

PinOp does not discover IDEs or scan localhost ports. A code links exactly
one browser window to the VS Code window that displayed it. Tabs in that browser
window can reuse its session link; another browser window must be linked
separately.

**Disconnect** unlinks only the current browser window. It turns off the picker,
closes that window's socket, revokes its browser token, and removes its
session-storage record. Other browser windows and VS Code windows continue
independently.

## Connection And Session Behavior

The DevTools header reports one of these states:

- `Not linked`;
- `Linking`;
- `Connected`;
- `Reconnecting`;
- `Linked IDE offline`;
- `Rate limited`;
- `Error`.

After a successful link, code entry is replaced by the linked display code and
**Disconnect**. DevTools panels in the same browser window share at most one
authenticated WebSocket while panels are active. Closing the final panel closes
the socket but leaves that window's `browser.storage.session` link available.
Reopening the panel reconnects without scanning or asking for another code.

The session record contains the endpoint, bridge and session identities,
browser token, and formatted display code. It is cleared when that browser
window or browser session ends. Stopping or restarting the VS Code bridge creates
a new bridge instance and invalidates old credentials.

Firefox Stable and current Chrome/Chromium have feature parity. Chrome uses a
Manifest V3 service worker; bridge heartbeat and reconnection preserve the same
window-scoped behavior while a panel is active.

## Select From The Page

Select the mouse-pointer button to enable the visual page picker. Hovering an
eligible page element draws a noninteractive box-model overlay with separate
margin, border, padding, and content geometry plus a bounded element label.
Clicking selects the element and sends its bounded inspection facts to the
linked IDE. While the picker is active, its trusted selection gesture is
suppressed before page handlers run.

The overlay is isolated inside an extension-owned shadow root, ignores pointer
events, and is excluded from the DOM tree. Press Escape once to clear a hover
preview and again to turn off the picker. The selected element remains selected
until another valid selection, navigation, removal, disconnect, or session
reset replaces it.

## Select From The DOM Tree

The virtualized, lazy DOM tree is available without enabling the page picker.
It requests only the root and branches that are expanded. Large branches use a
bounded page followed by `Load more`; they are not scanned into the panel all at
once.

- Hover an element row to show the same box-model overlay.
- Select a row, or press Enter, to use the same selection path as a page click.
- Use Arrow keys for standard tree navigation and disclosure.
- Page selection reveals the bounded ancestor path in the tree.
- Open shadow roots appear as explicit expandable rows.
- Same-origin frame documents appear as expandable frame rows.
- A cross-origin frame is a locked leaf and cannot be selected or expanded.
- A closed shadow root is not traversed and fails closed.

Tree labels are plain bounded text containing tag, ID, classes, and approved
attribute names. Attribute values and DOM text do not appear in tree labels.
Browser-local node refs are valid only inside their panel channel, document
epoch, frame epoch, and branch revision. Navigation, mutation, collapse, and
session disposal invalidate stale work rather than reusing it.

## Source Highlighting

PinOp sends one selected target and, when available, its immediate DOM
parent. VS Code retains the latest valid selection and resolves it only against
the active document. It does not open, close, or switch editor tabs.

Source lookup is workspace-bound when the document or stylesheet URL path
begins with an open workspace folder name. PinOp strips that leading
segment once and searches only that folder. For example,
`http://localhost/_ORB/` with
`/_ORB/wp-content/themes/orbiter/style.css?v=7` binds to the open `_ORB` folder;
duplicate basenames elsewhere do not make the source ambiguous.

When neither URL identifies an open folder, source lookup remains automatic
across all open folders, using exact-path and unique-basename matching. This is
a convenience trade-off: the user accepts the risk of a coincidental automatic
mapping. Applicable Sources and **PinOp: Open Diagnostics** report the
strategy with the exact local text `Workspace-bound: <folder>` (for example,
`Workspace-bound: _ORB`) or `Automatic source matching`.

- CSS first uses exact generated source positions or CSSOM paths. A
  workspace-bound source miss never fingerprint-matches an unrelated active CSS
  file. Automatic mode may retain a conservative CSS fingerprint fallback using
  normalized selector, media conditions, and declaration evidence only when
  the result is unique.
- SCSS requires generated CSS and a usable inline or external source map into
  the exact active SCSS document. Automatic unique-basename matching may locate
  and diagnose the generated CSS, but it can never authorize a basename-only
  original SCSS source. Missing, invalid, ambiguous, unmapped, and
  other-document outcomes fail closed.
- Compatible separately installed source plugins can resolve other active
  document types through the versioned source-plugin API.

Every applicable complete block can be highlighted. The selected element uses
the Selected decoration; only its immediate parent uses Parent. A single
selection can create multiple source ranges for either role. `Applicable
Sources` lists the same ranges without changing the active editor.

## Footer Outcomes

The DevTools footer is the authoritative result for the latest selection. Read
the exact footer outcome rather than inferring success from the tree or overlay.
Current text is:

| Condition | Exact footer text |
| --- | --- |
| Nothing selected | `Select an element to inspect` |
| IDE is resolving | `Resolving in VS Code` |
| IDE connection is lost | `VS Code disconnected` |
| Matches | `<N> rule(s) highlighted · Selected <S> · Parent <P>` |
| No editor tab is active | `No active editor` |
| Active language has no plugin | `Unsupported active file: <languageId>` |
| Selection contains no CSS facts | `No CSS facts` |
| Generated CSS is absent | `CSS source not found in workspace` |
| CSS resolves to another file | `Stylesheet resolves to a different workspace file` |
| Source path is ambiguous | `Ambiguous source path` |
| SCSS map is absent | `SCSS source map missing` |
| SCSS map is unreadable or invalid | `SCSS source map invalid` |
| No safe rule result | `No matching rules in active file` |
| More than one safe rule result | `Ambiguous rule match` |
| Resolver contract failure | `Resolution failed (<diagnostic code>)` |

When stylesheets were inaccessible, the footer appends
`<N> inaccessible stylesheet(s)`. A later editor change can rerun resolution for
the retained selection, so read the footer again after changing the active file.

## VS Code Controls

The status bar has the code item and an adjacent stop/start icon:

- click `PinOp: <port> <PIN>` to copy the code;
- click Stop to shut down that VS Code window's bridge;
- click Start while offline to create a fresh bridge and code.

Command Palette equivalents exist, but normal startup and use require no
command. If all 100 managed ports (`48735` through `48834`) are occupied, the
status remains offline until a port becomes available.

## Known Limits

- Browser-protected pages can deny content-script injection.
- Cross-origin stylesheets may be inaccessible through CSSOM; the footer reports
  their bounded count.
- Cross-origin frame contents and closed shadow roots cannot be traversed.
- Transformed or unsafe overlay geometry can be omitted rather than guessed.
- SCSS requires generated CSS and a usable source map in the workspace.
- Remote SSH and WSL extension hosts, editing, reverse sync, and arbitrary
  command execution are not supported.
