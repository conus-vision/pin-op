# Pin-op Usage

Normal use with installed Pin-op extensions is terminal-free. Contributor
commands belong in [development-host verification](mvp-verification.md), not in
the installed workflow.

Install both halves first: the
[Pin-op VS Code extension](https://marketplace.visualstudio.com/items?itemName=conus-vision.pin-op)
and, for the browser you inspect in, the
[Chrome Web Store](https://chromewebstore.google.com/detail/pkfpamadjoolcfkaadnleagmhbapepci)
or [Firefox Add-ons](https://addons.mozilla.org/addon/pin-op/)
listing. VS Code is the only IDE a browser window can link to, and support for
other IDEs is in development.

Ordinary and store Firefox/Chrome packages open one shared Chromium-derived,
read-only Inspector UI by default. It adapts pinned BSD-licensed Chromium
DevTools DOM Tree and Rules presentation to Pin-op's browser-local models; it is
not either browser's native Inspector backend. The
[pinned source manifest](../third_party/chromium-devtools-frontend/UPSTREAM.json),
[BSD license](../third_party/chromium-devtools-frontend/LICENSE), and
[Pin-op change record](../third_party/chromium-devtools-frontend/PIN_OP_CHANGES.md)
are available with the source distribution.

## Link One Browser Window

1. Open the project in the local VS Code window that should receive selections.
   Pin-op starts automatically.
2. Find a status item such as `Pin-op: 48735 07` and click it. VS Code
   copies the ungrouped code, `4873507` in this example.
3. Open DevTools for the page in Firefox Stable or current Chrome/Chromium, then
   open the **Pin-op** DevTools panel in that browser window.
4. Select Paste, or enter the code manually, and select **Link**.
5. Confirm the panel reports `Connected` and shows the same displayed code as
   the VS Code status item.
6. Keep the intended source document active in VS Code.
7. Select an element with the page picker or DOM tree and read the exact footer
   outcome.

The visual space separates the five-digit port from the two-digit PIN. Leading
zeroes in the PIN matter. Clipboard access occurs only after Paste is selected;
manual entry remains available when it is denied.

Pin-op does not discover IDEs or scan localhost ports. A code links exactly
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

The picker, **Auto Refresh**, and **IDE Highlight** are on the left of one
toolbar row. The current connection state, visible `<port> <PIN>` code, and
Link/Disconnect interaction remain on the right. Auto Refresh and IDE Highlight
are tab-local and default on only after a compatible protocol handshake and a
fresh tab-state snapshot. Opening a linked panel makes that tab a refresh
participant; linking alone does not silently enable a tab.

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
events, uses half-alpha box-model fills, and is excluded from the DOM tree. It
disappears when the pointer leaves the page element or DOM list; the selection
itself remains. Press Escape once to clear a hover preview and again to turn off
the picker. The selected element remains selected until another valid selection,
navigation, removal, disconnect, or session reset replaces it.

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

The default Inspector renders structured bounded attribute names and values and
bounded text and comment rows through text APIs. Text, comment, and document-type
rows are display-only and cannot drive selection or stable-locator recovery.

Browser-local node refs are valid only inside their panel channel, document
epoch, frame epoch, and branch revision. Navigation, mutation, collapse, and
session disposal invalidate stale work rather than reusing it.

## Source Highlighting

Pin-op sends one selected target and, when available, its immediate DOM
parent. VS Code retains the latest valid selection and resolves it only against
the active document. Passive highlighting does not open, close, or switch
editor tabs. This active-document authority is also the basis of the Source
tab; it is separate from Rules-origin opening.

Source lookup is workspace-bound when the document or stylesheet URL path
begins with an open workspace folder name. Pin-op strips that leading
segment once and searches only that folder. For example,
`http://localhost/_ORB/` with
`/_ORB/wp-content/themes/orbiter/style.css?v=7` binds to the open `_ORB` folder;
duplicate basenames elsewhere do not make the source ambiguous.

When neither URL identifies an open folder, source lookup remains automatic
across all open folders, using exact-path and unique-basename matching. This is
a convenience trade-off: the user accepts the risk of a coincidental automatic
mapping. Applicable Sources and **Pin-op: Open Diagnostics** report the
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
- PHP resolves the active PHP document. A development runtime that emits a
  `php.template` or `wordpress.acf-block` fact gives an `instrumented` range.
  Otherwise Pin-op searches the template's literal markup for the element's
  `id`, then its `data-*`, `aria-*`, and `role` attributes, then its classes,
  and highlights the first tier that answers. Those matches are `heuristic`. A
  template holds only an element's static markup, so the comparison runs
  template into element: every class and value the template writes literally
  must be on the selected element, which may carry further classes and
  attributes added later by PHP or scripts. A literal value the element
  contradicts rules that template element out, and `<?php ... ?>` output is
  never matched literally. A template often writes one block twice - the
  branches of an `if`/`else` render it for different page types - so equally
  strong candidates are all listed; beyond eight the result is reported as
  ambiguous instead of guessed.
- Compatible separately installed source plugins can resolve other active
  document types through the versioned source-plugin API.

Every applicable complete block can be highlighted. The selected element uses
the Selected decoration; only its immediate parent uses Parent. A single
selection can create multiple source ranges for either role. `Applicable
Sources` lists the same ranges without changing the active editor.

## Read Rules

Rules shows a rule the way the stylesheet writes it: a `margin: 0` is one row,
and the four longhands it sets are behind the row's disclosure triangle. What
wins sits at the top -- sections are ordered as the cascade, so low-weight rules
such as `*` and `:root` sink to the bottom wherever they were written -- and a
declaration is struck through when the cascade overrode it, a shorthand only
when every longhand it sets has lost.

A partial snapshot still shows every rule it could read; what could not be read
is reported in the status row, and what the `:hov` preview covers is what its
button says when the pointer rests on it.

## Rules Origins And Exact Open

The default Inspector's read-only Rules rows first show a verified generated CSS
origin when one is available. After the IDE proves the exact generated rule, a
usable source map, one original SCSS file, and the smallest complete original
block, the label upgrades atomically to that SCSS origin. Missing, invalid,
ambiguous, stale, or outside-workspace source maps show verified generated CSS
only, with no approximate SCSS label or authority.

Exact CSS and source-mapped original SCSS blocks open only after an explicit
Rules origin click. That click may switch VS Code to another verified workspace
CSS or SCSS document using a current IDE-issued opaque authority. The IDE
revalidates workspace ownership, document identity, private range, dependency
hashes/versions, and Rules generation around the editor-host call. Merely
selecting an element, reading Rules, or enabling pseudo preview never switches
files, and stale authority cannot move the cursor or reveal a range.

The wire carries only the inspect ID, independent Rules generation, safe
basename label and one-based start position for display, confidence, and opaque
authority ID. No workspace URI/path, full range, document version, source-map
path/content, or command crosses the bridge. There is no open acknowledgement.

Clicking a declaration in a rule whose origin is a link opens the same block
with the cursor at the start of that declaration's value, so it can be edited
straight away. A longhand under a shorthand opens the shorthand the stylesheet
wrote; a declaration the rule does not write itself, because an `@include` put it
there, opens the rule.

Clicking an `@media` condition that names a viewport width or height -- they are
underlined -- resizes the browser window so the inspected page is shown at that
size. A range such as `(min-width: 768px) and (max-width: 1023.98px)` is shown at
its widest matching width, an open-ended `min-width` at the minimum, and `em` or
`rem` lengths are read at 16 px. A maximized window is restored first, and page
zoom is corrected for. Only the window holding the inspected tab is resized.

A rule that a preprocessor wrote through a mixin has no selector of its own to
compare, so it is identified by its source map and by what it declares directly;
its origin opens the line where those declarations are written, which may be the
mixin rather than the rule that includes it.

Source remains active-document-only. A built-in PHP provider reads the
active PHP document, using instrumented `php.template` or
`wordpress.acf-block` facts when a runtime emits them and otherwise matching
the document's literal markup heuristically. Twig, Blade, and other template
providers remain future scope.

## Preview `:hover` And `:focus`

The read-only Rules toolbar has a `:hov` menu with **Preview :hover** and
**Preview :focus** checkboxes. Select one or both to preview supported readable
author rules on the currently selected element. The operation replaces the
complete requested state set atomically; it does not edit user-authored CSS or
DOM.

Rules marks the selectors the preview is what makes match, with the same fill
the filter leaves on what it matched. Selectors the preview cannot force - a
negated target, a target inside `:has()`, an ancestor or sibling target - match
on their own or not at all, and stay unmarked.

This is author-style pseudo preview, not native pseudo-state forcing. Pin-op
mirrors a supported positive `:hover` or `:focus` selector using random,
extension-owned markers and temporary styles in the selected element's
accessible document or open shadow root. The preview runtime does not directly
call inspected-page `focus()` or dispatch input, focus, mouse, pointer, or
keyboard events into the inspected page. Consequently, **Preview :focus**
changes supported CSS presentation without changing focus in the inspected page
or sending focus/input events to the inspected application. Ordinary keyboard
focus changes inside the DevTools UI remain available for accessible controls.

The preview menu reports partial coverage rather than guessing. Known partial
or unavailable cases include:

- inaccessible or unreadable stylesheet CSSOM; CORS-readable cross-origin
  stylesheets remain supported;
- UA/user rules, closed shadow roots, and rejected temporary
  style/constructable-sheet mounts;
- negated targets such as `:not(:hover)` or `:not(:focus)`, pseudo targets in
  `:has()`, and ancestor/sibling or multiple target compounds;
- mixed functional selector branches whose specificity would change, malformed
  selectors, and unsupported layer/scope/container/starting-style contexts;
- cross-sheet source order whose equivalent cascade position cannot be proven.

Temporary marker attributes, style nodes, and constructed mirror sheets are
filtered out of Pin-op's own DOM, Rules, locator, overlay, and inspect evidence,
but page scripts and MutationObservers may observe them while preview is
enabled. Mirrored author styles may trigger transitions, animations, resource
loads, and application observers even though Pin-op dispatches no input/focus
events.

Turning preview off, replacing the selection, Refresh, navigation, Disconnect,
compatibility loss, or normal panel/runtime disposal removes the exact owned
artifacts while the inspected content context can still run. Abrupt extension
termination, disable, update, or crash may leave them until page navigation or
reload. If that happens, reload the inspected page before continuing.

## Source Pane And Navigation

The Inspector's Source tab shows bounded excerpts
from the active IDE document only. Selected matches are expanded; the immediate
Parent group is collapsed by default.

Excerpts exist only while a VS Code window is linked, so with no IDE connected
the tab shows what to do instead of an empty list: open the project in VS Code,
click the Pin-op status bar item to copy that window's seven-digit code, and
paste it into the field at the top of the panel before selecting **Link**. The
same walkthrough appears when a linked IDE disconnects. A click sends only the excerpt's opaque
match ID and moves the VS Code cursor to that exact current range after the IDE
revalidates it. It cannot name or open an arbitrary path. Previous/Next remains
Selected-only and does not include Parent matches.

The panel combines viewport breakpoints with its measured usable workspace. At
680 px wide or wider, DOM and Source use side-by-side split when the workspace
width fits two 160 px panes plus the measured separator. When split does not
fit, including at those wider viewport sizes, the panel stacks DOM above Source
if the viewport is at least 520 px tall and the workspace height fits two 160 px
panes plus the measured separator (currently at least 325 px total). Tabs appear
only when neither two-pane arrangement fits. The panel re-evaluates as banners
or window constraints change, so restoring enough workspace re-enters split or
stack. The toolbar and connection code remain available in every layout. The
centered footer shows the compact Pin-op mark and name, a mail link on Volodymyr
Moskvin, and `(c) 2026 Conus Vision` linked to `https://conus.vision`.

Resizing the page re-evaluates media queries, so Rules re-queries what now
applies. The rules already on screen stay there while it does, and their exact
CSS/SCSS origins stay clickable: only an actual stylesheet change re-mints the
rule identities those origins are bound to. **Refresh styles** behaves the same
way - the list updates in place instead of emptying first.

Turning **IDE Highlight** off clears only VS Code decorations. Resolution,
Source excerpts, exact Source opening, and Selected-only navigation remain
available. Turning it back on applies decoration behavior to the current
selection.

## Auto Refresh

Auto Refresh reacts only to files that actually changed before Save. An
unchanged Save does nothing.

- CSS uses `styles` after a 150 ms settle.
- SCSS, Sass, and Less use `styles` after a 750 ms quiet period within a
  two-second generated-CSS window; a generated CSS event resets settlement to
  150 ms.
- JS, MJS, CJS, JSX, TS, TSX, Vue, PHP, and HTML use `reload` after 150 ms.
- `reload` wins when a save burst contains both modes.

`styles` replaces eligible external top-document HTTP(S) stylesheet links
without reloading the page. The old link remains when its replacement fails.
Inline styles, adopted stylesheets, data/blob URLs, and iframe documents are
not refreshed. `reload` reloads only the current participating tab and restores
its bounded top-level scroll position.

Only the active tab refreshes immediately. If a participating tab is inactive
when files change, it becomes stale and refreshes once after activation. A tab
with Auto Refresh off does not queue that work. Switching tabs does not refresh
tabs whose panel is closed.

## Protocol Compatibility

The browser and IDE extensions must both implement protocol v7. Protocol v6 is
rejected with WebSocket close code `1002`; there is no fallback. On mismatch the
panel keeps connection controls available but blocks inspection, Rules-origin,
and Source actions and shows:

```text
Extensions are incompatible
Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.
Browser protocol: 7 - IDE protocol: 6
```

Update both extensions to the same protocol generation, restart them, and link
the browser window again.

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

- click `Pin-op: <port> <PIN>` to copy the code;
- click Stop to shut down that VS Code window's bridge;
- click Start while offline to create a fresh bridge and code.

Command Palette equivalents exist, but normal startup and use require no
command. If all 100 managed ports (`48735` through `48834`) are occupied, the
status remains offline until a port becomes available.

## Known Limits

- Browser-protected pages can deny content-script injection.
- UA and user styles are unavailable to author-style pseudo preview.
- Only cross-origin stylesheets whose CSSOM is inaccessible are unavailable;
  CORS-readable cross-origin stylesheets remain supported and inspectable.
- Readable stylesheets with unsupported selectors are reported as PARTIAL; the
  omitted rules are not reconstructed or guessed.
- Cross-origin frames are unavailable.
- Closed shadow roots are unavailable.
- `:not(:hover)` and `:not(:focus)` targets are PARTIAL because additive mirror
  CSS cannot suppress the original native match.
- Ancestor or sibling hover/focus targets are PARTIAL because Pin-op cannot
  prove that the selected element is the pseudo subject.
- Pseudo preview covers only supported readable author `:hover`/`:focus` rules;
  unsupported, inaccessible, or source-order-approximate cases are visibly
  PARTIAL and are not guessed or presented as native forcing.
- Temporary pseudo-preview artifacts are page-observable while enabled and can
  remain after abrupt extension termination until navigation or reload.
- Transformed or unsafe overlay geometry can be omitted rather than guessed.
- SCSS requires generated CSS and a usable source map in the workspace.
- Remote SSH and WSL extension hosts, editing, reverse sync, and arbitrary
  command execution are not supported.
