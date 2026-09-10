# Pin-op Installed Artifact Verification

This is the terminal-free installation and acceptance runbook for the
Pin-op `0.4.2` release candidate. Normal use has no separate Pin-op
process: open a local project and the VS Code extension starts automatically.

Pin-op `0.4.2` is published on the Visual Studio Marketplace, the Chrome Web
Store and Firefox Add-ons, and those listings are how an ordinary user installs
it. This runbook is for accepting a packaged candidate directly, before or
apart from a store listing, so its steps install from artifact files rather
than from a store.

## Candidate Files

Obtain all files from the repository owner or one trusted draft release and
keep them with that draft's `SHA256SUMS`:

- `pin-op-vscode-0.4.2.vsix`;
- `pin-op-chrome-0.4.2.zip`;
- `pin-op-firefox-0.4.2.xpi`, signed by Mozilla.

The unsigned `pin-op-firefox-0.4.2.zip` is build and Mozilla-review input.
It is not a persistent Firefox Stable add-on and cannot replace the signed XPI.

Install browser and IDE candidates from the same protocol generation. This
runbook requires protocol v7. Protocol v6 is rejected with WebSocket close code
`1002`; there is no compatibility adapter or fallback.

## Privacy And Security Before Testing

Pin-op is read-only. Product traffic uses a loopback WebSocket between one
explicitly linked browser window and local VS Code; there is no product HTTP or
remote Pin-op service. The two-digit PIN protects against accidental local
cross-linking, not a malicious process running as the same desktop user.

One selection can send bounded facts for the selected element and its immediate
parent: full page URL/route, IDs, classes, permitted `data-*`, `aria-*`, and
`role` names and values, CSS declarations, opaque correlated rule refs, and
canonical public HTTP(S) stylesheet evidence. Local paths and hostile or
unsupported stylesheet source evidence are omitted. The IDE can return bounded
excerpts from its active document: at most 32 excerpts, 80 logical lines and 8
KiB each, in a 256 KiB message. For a current Rules generation it can instead
return display-only source labels, one-based start positions, confidence, and
IDE-issued opaque open authorities; no workspace path/URI, full range, document
version, or command crosses the wire. These values are not content-redacted.
Pin-op does not deliberately read cookies, headers, form-control values,
workspace source documents, workspace paths/URIs, or source-map contents in the
browser. Browser-local structured tree fields, including bounded DOM text and
comments, stay in the private inspected-tab channel and do not cross the product
WebSocket.

The DOM tree, browser-local node refs, child pages, and box-model geometry stay
inside the browser extension. Cross-origin frames are locked, and closed shadow
roots are not traversed. Local VS Code source plugins can read relevant
workspace files and source maps to resolve the active document; Pin-op does
not upload them. Separately installed source plugins are independent trusted VS
Code extensions and may have their own data behavior.

The author-style `:hover`/`:focus` preview temporarily adds Pin-op-owned markers
and mirror styles. Page scripts may observe these temporary preview artifacts
while the preview is enabled, and their style effects may cause transitions,
animations, resource loads, or mutation records. Pin-op dispatches no input,
focus, mouse, pointer, or keyboard events. Controlled toggle, selection,
refresh, navigation, disconnect, and mismatch exits remove the artifacts.
Abrupt extension termination can leave preview markers or styles until page
navigation or reload because no content context remains to clean them.

Avoid private pages unless sending the bounded selection values to the linked
local VS Code window is acceptable. Read the [privacy policy](../PRIVACY.md),
[security policy](../SECURITY.md), and [security model](security.md).

## Install VS Code

1. Open VS Code and choose **Manage > Profiles > Create Profile**.
2. Create an empty profile named `Pin-op 0.4.2 Candidate` and select it.
3. Open Extensions, confirm no unrelated user extension is enabled, open the
   view menu, and choose **Install from VSIX...**.
4. Select `pin-op-vscode-0.4.2.vsix`, accept the prompt, and restart VS Code
   in the same profile.
5. Open a local project folder. Confirm Pin-op starts automatically and
   shows a status item such as `Pin-op: 48735 07` plus a stop icon.
6. Click the Pin-op status item. Confirm VS Code reports
   `Pin-op link code copied.`

The status item shows a five-digit port followed by a two-digit PIN. Its copied
value has no space, for example `4873507`. Each local VS Code window owns a
different bridge instance and current code.

## Install Chrome Or Chromium

1. Extract `pin-op-chrome-0.4.2.zip` into a permanent candidate folder.
2. Open `chrome://extensions` in current Chrome/Chromium 116 or newer.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Confirm the Pin-op card reports version `0.4.2` with no errors.
6. Restart the complete browser and confirm the extension remains installed.

## Install Firefox Stable

This path requires the Mozilla-signed XPI. Leave Firefox acceptance pending
until that exact file exists.

1. Open Firefox Stable 142 or newer and open Add-ons Manager.
2. Open its tools menu and choose **Install Add-on From File...**.
3. Select `pin-op-firefox-0.4.2.xpi` and approve its permissions.
4. Confirm Pin-op `0.4.2` is enabled.
5. Restart every Firefox process and confirm the signed add-on remains enabled.

## Default Inspector Flow

The ordinary/store artifacts default to the shared Chromium-derived Inspector.
Run its read-only Rules verification in installed Chrome and installed Firefox;
a current explicit Rules origin click is part of this normal flow.

1. Open the project in the intended local VS Code window and keep its intended
   CSS or SCSS document active.
2. Click the Pin-op status item to copy its port and PIN.
3. Open one normal browser window, open DevTools for the test page, and select
   the **Pin-op** DevTools panel.
4. Confirm `Not linked`, choose Paste or enter the code, then select **Link**.
5. Confirm `Connected` and confirm the same displayed code appears in the panel
   and VS Code.
6. Confirm the one-row toolbar shows the picker, checked **Auto Refresh** and
   **IDE Highlight** on the left, and the unchanged connection/code controls on
   the right.
7. Use either the visual page picker or the lazy DOM tree to select an element.
8. Confirm passive selection highlights the expected active-document ranges
   without opening or switching editor tabs.
9. Confirm DOM Tree and Rules are visible and no Source tab is rendered.
10. Explicitly click a current verified Rules origin and confirm the exact CSS
    or source-mapped SCSS block opens through its opaque IDE authority.
11. Read and record the exact footer outcome in DevTools.

The page picker is the mouse-pointer button. Hover a normal element and verify a
noninteractive box-model overlay with distinct margin, border, padding, and
content geometry and half-alpha fills. Move outside the element or DOM list and
confirm the overlay clears without clearing selection. Click to select it.
While the picker is active, its selection gesture must not invoke the page's
own handler. Press Escape to clear hover and then turn off the picker.

## Lazy DOM Tree

Verify that the DOM tree requests content on demand:

1. Open the panel and confirm only the root and expanded rows are materialized.
2. Expand ordinary element rows and use `Load more` when a branch is paged.
3. Hover an element row and confirm it uses the same box-model overlay as the
   picker.
4. Select a tree row and confirm the same selection/source flow runs.
5. Use Arrow keys and Enter to verify standard tree focus and selection.
6. Select an element with the page picker and confirm its bounded ancestor path
   is revealed in the tree.

Using a page with the release fixture boundaries, confirm:

- an open shadow root appears as an explicit expandable row;
- its element descendants can be hovered and selected;
- a same-origin frame appears with an expandable frame-document row;
- a cross-origin frame appears as a locked leaf and cannot be expanded;
- a closed shadow root is not traversed and fails closed;
- navigation or mutation refreshes affected branches without accepting stale
  node refs or branch pages.

The structured Inspector may show bounded attribute values and bounded text or
comment rows; text and comments are display-only and have no stable locator.

## CSS And SCSS Results

Keep the intended source document active before each selection.

1. In CSS, confirm exact source evidence identifies complete rule blocks,
   including closing braces.
2. Exercise the fixture's CSSOM path-miss case. The conservative CSS fingerprint
   fallback may highlight only when selector, media, and declaration evidence
   identify one rule; duplicate candidates must report `Ambiguous rule match`.
3. Confirm every applicable selected-element block uses Selected and every
   applicable immediate-parent block uses Parent.
4. Confirm one selection can highlight multiple source ranges for either role.
5. In source-mapped SCSS, confirm generated CSS maps to complete ranges in the
   active original SCSS document.
6. Remove or invalidate the test map and confirm SCSS fails closed with
   `SCSS source map missing` or `SCSS source map invalid`, with no guessed range.
7. Close every editor and select again. Confirm the exact footer outcome is
   `No active editor`.
8. Activate an unsupported file and confirm
   `Unsupported active file: <languageId>`.

For a match, the footer format is
`<N> rule(s) highlighted · Selected <S> · Parent <P>`. It can append an
inaccessible-stylesheet count. Other exact outcomes are listed in the
[usage guide](mvp-usage.md).

## Read-Only Rules Backend

This read-only Rules matrix applies to the default Inspector in installed Chrome
and installed Firefox. Package tests and the Chrome page-target smoke establish
static and page/runtime invariants, but do not constitute native DevTools-panel
evidence.

1. Select the specificity, `!important`, inline-style, inherited, inactive
   media/supports, nested-group, and duplicate-selector fixture targets. Confirm
   Rules distinguishes winning-known-author, overridden-known-author, inactive,
   inherited, and explicitly unknown declarations without an editor, checkbox,
   Add Rule, Add Property, or editable popover.
2. Select the document adopted target, the open-shadow adopted target, and the
   shared constructed target in both roots. Confirm each readable rule is shown
   once in the correct scope. Select the inaccessible external target and
   confirm a bounded partial diagnostic while proven rules remain usable.
3. Resize the viewport and exercise focus/pointer, sibling, and slot state.
   Confirm the current selection is requeried without changing its node
   identity. Exercise `insertRule`, `deleteRule`, and `replaceSync` through
   `window.pinOpRulesFixture` and confirm the Rules result invalidates.
4. Without dispatching an event or changing a DOM attribute, record the current
   `stylesheetRevision`, aggregate `stylesRevision`, and a `ruleRef`. Call
   `pinOpRulesFixture.toggleEventlessStylesheet()`. Confirm both revisions
   advance after the `CSSStyleSheet.disabled`/`MediaList` change.
5. Record the values again and call
   `pinOpRulesFixture.toggleEventlessApplicability()`. Confirm supported
   checked, indeterminate, value/validity/placeholder, and custom-state changes
   advance only `stylesRevision`; `stylesheetRevision` and `ruleRef` stay
   unchanged. Record unsupported `ElementInternals.states` as partial.
6. Repeat steps 4 and 5 in a browser-throttled background tab. Record any
   observation delay, then press manual Refresh. Refresh must deterministically
   produce the current Rules result even when background polling was delayed.

Rules works without an IDE link. With a linked compatible IDE, verified current
origins become explicit click targets. An explicit Rules origin click may switch
VS Code using a current IDE-issued opaque authority. No workspace URI/path, full
range, document version, source-map path, or command crosses the bridge.
Missing or invalid source maps show verified generated CSS only, with no
approximate SCSS authority. Source remains active-document-only, now
including a built-in PHP provider. Twig, Blade, and other template providers
remain future scope.

## Checkpoint 3 Rules-Origin Installed Matrix

Run this matrix with the default Inspector from the Chrome and Firefox packages.
Automated package smoke covers only the ordinary fixture page and static package
markers; Task 6 VS Code integration and Task 7 browser controller/UI tests are
supplementary and do not prove a native DevTools-to-installed-VS Code click.

| Scenario | Chrome | Firefox | Required evidence |
| --- | --- | --- | --- |
| Exact CSS | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Origin label and explicit click reveal the complete verified generated CSS block. |
| Inline-map SCSS | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | One inline map resolves and opens the smallest exact original SCSS block. |
| External-map SCSS | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | One external map resolves and opens the smallest exact original SCSS block. |
| Nested SCSS | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Expanded selector/context evidence opens the exact nested original block. |
| Selector/declaration split mapping | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Selector-start authority wins; a declaration/mixin segment cannot redirect the origin. |
| Invalid-map CSS fallback | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Verified generated CSS remains visible/clickable; no approximate SCSS origin appears. |
| Generated CSS edit | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | The old authority becomes stale; fresh evidence resolves or fails closed. |
| Map edit | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | The old mapped authority becomes stale and cannot move cursor/reveal. |
| Stale authority | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Replaced inspect/generation authority is rejected on repeated click. |
| Cross-file editor switch | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Explicit origin click may switch VS Code only to the exact workspace-owned target. |
| Inspector Rules and Source tabs | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | DOM Tree, Rules, and the Source tab are visible; Source stays active-document-only with unchanged excerpt/open behavior. |

Evidence (2026-08-25): Task 6 exercises the production VS Code extension's
opaque open, exact cursor, and full-range reveal; Task 7 exercises browser
routing, correlation, invalidation, and Rules-origin UI clicks; current Chrome
and Firefox package contracts verify the emitted v7 bundles. None opens a native
DevTools panel linked to an installed VS Code extension. This environment has no
native DevTools-to-installed-VS Code click harness, so every browser cell remains
`PARTIAL/HARNESS_BLOCKED`.

Until a native cross-product harness or manual run can exercise these clicks,
record the browser cell as `PARTIAL/HARNESS_BLOCKED`, not `PASS`. Do not infer a
signed-XPI, store release, or native result from automated archive verification.

## Rollout Installed Native Matrix

The user-approved checkpoint disposition permits this native gate to remain
partial; it does not convert an unperformed check into a pass. Automated unit,
integration, static package, archive, and ordinary-page smoke evidence cover
their named invariants only. No available harness opens the native Pin-op
DevTools panel in both browsers and drives the complete installed product path,
so every unperformed cell below remains `PARTIAL/HARNESS_BLOCKED`.

| Native scenario | Chrome | Firefox | Required evidence |
| --- | --- | --- | --- |
| Link, Disconnect, reconnect, mismatch, two-window isolation | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Link ownership, reconnect, protocol rejection, and isolation are observed in the installed panel. |
| Picker/tree hover and selection; frame/shadow/mutation recovery | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Page and tree use one selection/overlay authority and recover only current bounded identities. |
| Read-only inline, matched, inherited, overridden, and unknown Rules | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Every state is visible without selector, property, value, declaration, rule, or DOM editors. |
| Document/open-shadow adopted sheets and shared constructed sheet | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Document and shadow selections show each readable rule once with selected-root isolation. |
| Live CSSOM and adoption mutation | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | `insertRule`, `deleteRule`, `replaceSync`, adoption-list replacement, and exposed in-place mutation invalidate the current result. |
| Eventless stylesheet and element-state mutation under throttling | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Disabled/MediaList changes advance both revisions; JS-only checked/value/validity/placeholder/custom-state changes advance only styles while `ruleRef` stays stable; manual Refresh is deterministic. |
| CSP temporary-mount rejection and fallback | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Temporary style and constructable-sheet rejection fails closed or uses only the documented safe fallback with a partial diagnostic. |
| CSS/SCSS origin and authority lifecycle | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Exact CSS, valid SCSS map, invalid-map CSS fallback, cross-file opening, and stale authority all follow explicit-click authority. |
| Hover/focus supported and partial preview | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Supported author rules preview `:hover`/`:focus`; unsupported and inaccessible coverage is labelled PARTIAL and not guessed. |
| Auto Refresh styles/reload and scroll restore | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Styles replacement preserves the page; reload restores bounded top-level scroll and respects tab-local state. |
| IDE Highlight and Source boundary | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | IDE Highlight remains independent; the Source tab remains active-document-only. |
| Preview cleanup and abrupt context loss | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Toggle, selection, refresh, navigation, disconnect, and mismatch clean synchronously; abrupt extension termination is separately documented and page reload is the final cleanup boundary. |
| Themes, keyboard, screen reader, 320 px and wide layouts | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Dark, light, high contrast, accessible labels/focus, narrow stacking, and wide split are exercised in the native panel. |

No signed XPI, store artifact, screenshot, or native result is inferred from this
matrix. Replace a cell only with dated evidence from the corresponding native
browser panel and installed VS Code extension.

## Source, Highlight, And Responsive Layout

1. Confirm DOM Tree, Rules, and Source are visible. Turn **IDE Highlight** off
   and confirm decorations clear while Rules origins and resolution remain
   usable; turn it back on.
2. On the Source tab, confirm it shows only bounded excerpts from the active IDE
   document, with Selected expanded and immediate Parent collapsed.
3. Click several excerpts. Confirm each opaque match ID opens its exact current
   range and a stale excerpt cannot open after a newer selection.
4. Confirm Previous/Next remains Selected-only and its counter follows the
   primary VS Code cursor. Turning **IDE Highlight** off clears decorations but
   leaves Source excerpts, exact opening, and navigation usable.
5. Resize DevTools to 680 px or wider. When the measured usable workspace width
   fits two 160 px panes plus the measured separator, confirm the side-by-side
   split remains active.
6. Keep the viewport at least 680 px wide and 520 px tall, then constrain the
   measured workspace width below the horizontal fit threshold while its height
   still fits two 160 px panes plus the measured separator. Confirm both panes
   are visible, tabs are hidden, and the separator is visible and horizontal.
7. Resize below 680 px while keeping the viewport at least 520 px tall. When
   the measured usable workspace height fits two 160 px panes plus the measured
   separator (currently at least 325 px total), confirm the panes stack.
8. Keep that narrow, tall viewport and reduce the usable workspace below the
   fit threshold, for example with the mismatch banner or window constraints.
   Confirm tabs appear with no clipping, then restore enough workspace and
   confirm stack re-entry.
9. Below 680 px and below 520 px, confirm tabs remain active.
10. Confirm the compact centered footer shows the Pin-op logo/name, Volodymyr
   Moskvin email link, and `(c) 2026 Conus Vision` website link.

## Auto Refresh

Auto Refresh is tab-local, defaults on after the compatible handshake and fresh
tab state, and applies only while that tab's panel participates.

1. Change then save CSS. Confirm eligible external top-document HTTP(S)
   stylesheet links update after 150 ms without a page reload. A failed
   replacement must leave the old link in place.
2. Change then save SCSS, Sass, or Less. Confirm the 750 ms quiet period and
   generated-CSS events settle within two seconds, with generation resetting
   settlement to 150 ms.
3. Change then save JS, MJS, CJS, JSX, TS, TSX, Vue, PHP, or HTML. Confirm the
   current tab reloads after 150 ms and restores bounded top-level scroll.
4. Save an unchanged supported file and confirm nothing refreshes.
5. Leave another participating tab inactive during a changed save. Confirm it
   becomes stale and refreshes once when activated.
6. Turn Auto Refresh off for one tab. Confirm it neither refreshes nor queues
   the change. Re-enable it and verify the next changed save.
7. Confirm inline/adopted styles, data/blob stylesheets, and iframe documents
   are outside the refresh claim. Confirm `reload` wins a mixed burst.

## Protocol Compatibility

1. Temporarily combine a protocol-v7 extension with a v6 peer.
2. Confirm the connection closes with code `1002`, does not retry v6, and shows
   `Extensions are incompatible` plus instructions to update both extensions
   and reconnect.
3. Confirm the panel reports `Browser protocol: 7 - IDE protocol: 6` when both
   values are known and blocks picker/settings/Rules-origin/Source/navigation
   while keeping Link/Disconnect usable.
4. Restore matching protocol-v7 candidates, restart both extensions, reconnect,
   and confirm defaults activate only after a fresh tab state.

## Window Isolation And Disconnect

1. Link Browser Window A to VS Code Window A.
2. Link Browser Window B independently to VS Code Window B.
3. Select alternating elements and confirm only the explicitly linked IDE
   updates.
4. Open a second tab in Window A. Confirm its panel reuses Window A's displayed
   link while maintaining independent tree and picker state for that tab.
5. Close every panel in Window A, reopen one, and confirm its session-only link
   reconnects without port scanning.
6. Select **Disconnect** in Window A. Confirm Disconnect unlinks only the current
   browser window: every Window A panel returns to `Not linked`, while Window B
   remains connected and continues resolving selections.
7. Open a third browser window and confirm it begins `Not linked`.

## Stop, Restart, And Session Cleanup

1. Select the stop icon in VS Code A. Confirm its status becomes
   `Pin-op: Offline` and Browser A reports `Linked IDE offline`.
2. Start Pin-op again from the adjacent icon. Confirm a fresh code appears
   and stale browser credentials do not attach to the new bridge instance.
3. Enter the new code to reconnect explicitly.
4. End the complete browser session, reopen it, and confirm previous browser
   windows do not regain their session-only links.
5. Confirm another VS Code window and its browser link were not affected.

## Cleanup

1. Turn off the picker and select **Disconnect** in each linked browser window.
2. Close DevTools and browser windows.
3. Stop each test VS Code bridge if desired.
4. Remove the candidate browser extensions and VS Code extension from their
   normal extension-management UIs.

## Troubleshooting

- **No status code:** confirm Pin-op `0.4.2` is enabled in the candidate
  profile, reopen the local project, and select the start icon if offline.
- **Paste denied:** enter the same seven digits manually; spaces are optional.
- **Link rejected:** copy the current code again from the intended VS Code
  window. Old bridge codes and credentials are intentionally invalid.
- **Extensions are incompatible:** install browser and VS Code extensions from
  the same protocol generation, restart both, and link again. A v6/v7 pair
  cannot downgrade or continue partially.
- **No DevTools panel:** confirm the browser extension is enabled, restart the
  browser, and open DevTools on a normal page.
- **No overlay:** confirm the panel is connected, enable the picker, and use an
  ordinary page element. Unsafe geometry can fail closed.
- **No highlights:** keep the expected source document active, ensure IDE
  Highlight is on, and read the footer. Passive inspection never switches source
  files. Only an explicit current Rules origin click may switch VS Code; Source
  excerpts remain active-document-only and can stay available while
  highlighting is intentionally off.
- **Firefox rejects the file:** verify it is Mozilla's signed `.xpi`; the
  unsigned `.zip` cannot be installed persistently in Firefox Stable.

## 0.4.2 Candidate Verification Record

Pending external release evidence:

- signed-XPI installation and restart in Firefox Stable;
- installed VSIX activation and restart from the final `0.4.2` artifact;
- unpacked Chrome/Chromium installation and restart from the final artifact;
- complete Firefox/Chrome parity, two-window isolation, DOM-tree boundary,
  box-model overlay, Rules-origin matrix, Source tab, Auto Refresh,
  protocol mismatch, responsive layout, CSS fingerprint, SCSS fail-closed, and
  footer-outcome acceptance;
- checksum comparison against the final draft release;
- privacy-reviewed screenshots and GIF evidence.

No signed `0.4.2` XPI exists in the candidate evidence. Mozilla's listed channel
serves a signed `0.4.2` to Firefox users, and that build has not been through
this runbook. Artifact hashes are pending. Screenshots and GIF evidence remain
pending. No installed-product or external release evidence is claimed by this
document yet.
