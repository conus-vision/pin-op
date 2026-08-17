# Pin-op Installed Artifact Verification

This is the terminal-free installation and acceptance runbook for the
Pin-op `0.3.0` release candidate. Normal use has no separate Pin-op
process: open a local project and the VS Code extension starts automatically.

## Candidate Files

Obtain all files from the repository owner or one trusted draft release and
keep them with that draft's `SHA256SUMS`:

- `pin-op-vscode-0.3.0.vsix`;
- `pin-op-chrome-0.3.0.zip`;
- `pin-op-firefox-0.3.0.xpi`, signed by Mozilla.

The unsigned `pin-op-firefox-0.3.0.zip` is build and Mozilla-review input.
It is not a persistent Firefox Stable add-on and cannot replace the signed XPI.

Install browser and IDE candidates from the same protocol generation. This
runbook requires protocol v6. Protocol v5 is rejected with WebSocket close code
`1002`; there is no compatibility adapter or fallback.

## Privacy And Security Before Testing

Pin-op is read-only. Product traffic uses a loopback WebSocket between one
explicitly linked browser window and local VS Code; there is no product HTTP or
remote Pin-op service. The two-digit PIN protects against accidental local
cross-linking, not a malicious process running as the same desktop user.

One selection can send bounded facts for the selected element and its immediate
parent: full page URL/route, IDs, classes, permitted `data-*`, `aria-*`, and
`role` names and values, CSS declarations and stylesheet identity, and bounded
development metadata. The IDE can return bounded excerpts from its active
document: at most 32 excerpts, 80 logical lines and 8 KiB each, in a 256 KiB
message. These values are not content-redacted. Pin-op does
not deliberately read cookies, headers, form values, DOM text, workspace source
documents, workspace paths/URIs, or source-map contents in the browser.

The DOM tree, browser-local node refs, child pages, and box-model geometry stay
inside the browser extension. Cross-origin frames are locked, and closed shadow
roots are not traversed. Local VS Code source plugins can read relevant
workspace files and source maps to resolve the active document; Pin-op does
not upload them. Separately installed source plugins are independent trusted VS
Code extensions and may have their own data behavior.

Avoid private pages unless sending the bounded selection values to the linked
local VS Code window is acceptable. Read the [privacy policy](../PRIVACY.md),
[security policy](../SECURITY.md), and [security model](security.md).

## Install VS Code

1. Open VS Code and choose **Manage > Profiles > Create Profile**.
2. Create an empty profile named `Pin-op 0.3.0 Candidate` and select it.
3. Open Extensions, confirm no unrelated user extension is enabled, open the
   view menu, and choose **Install from VSIX...**.
4. Select `pin-op-vscode-0.3.0.vsix`, accept the prompt, and restart VS Code
   in the same profile.
5. Open a local project folder. Confirm Pin-op starts automatically and
   shows a status item such as `Pin-op: 48735 07` plus a stop icon.
6. Click the Pin-op status item. Confirm VS Code reports
   `Pin-op link code copied.`

The status item shows a five-digit port followed by a two-digit PIN. Its copied
value has no space, for example `4873507`. Each local VS Code window owns a
different bridge instance and current code.

## Install Chrome Or Chromium

1. Extract `pin-op-chrome-0.3.0.zip` into a permanent candidate folder.
2. Open `chrome://extensions` in current Chrome/Chromium 116 or newer.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Confirm the Pin-op card reports version `0.3.0` with no errors.
6. Restart the complete browser and confirm the extension remains installed.

## Install Firefox Stable

This path requires the Mozilla-signed XPI. Leave Firefox acceptance pending
until that exact file exists.

1. Open Firefox Stable 142 or newer and open Add-ons Manager.
2. Open its tools menu and choose **Install Add-on From File...**.
3. Select `pin-op-firefox-0.3.0.xpi` and approve its permissions.
4. Confirm Pin-op `0.3.0` is enabled.
5. Restart every Firefox process and confirm the signed add-on remains enabled.

## Normal Inspector Flow

Run this flow once in Firefox Stable and once in current Chrome/Chromium:

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
8. Confirm VS Code highlights the expected source ranges without opening or
   switching editor tabs.
9. Confirm the Source pane shows active-document Selected and immediate Parent
   excerpts, then click one and verify the exact range opens in VS Code.
10. Read and record the exact footer outcome in DevTools.

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

The DOM tree must never show attribute values or DOM text in its labels.

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

## Source, Highlight, And Responsive Layout

1. Confirm Source shows only bounded excerpts from the active IDE document,
   with Selected expanded and immediate Parent collapsed.
2. Click several excerpts. Confirm each opaque match ID opens its exact current
   range and a stale excerpt cannot open after a newer selection.
3. Confirm Previous/Next remains Selected-only and its counter follows the
   primary VS Code cursor.
4. Turn **IDE Highlight** off. Decorations must clear, but resolution, Source
   excerpts, exact opening, and navigation must remain usable.
5. Resize DevTools. Confirm DOM/Source are side by side at 680 px or wider,
   stacked below 680 px when height is at least 520 px, and shown as tabs when
   both dimensions are below those thresholds.
6. Confirm the compact centered footer shows the Pin-op logo/name, Volodymyr
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
3. Change then save JS, MJS, CJS, JSX, TS, TSX, or PHP. Confirm the current tab
   reloads after 150 ms and restores bounded top-level scroll.
4. Save an unchanged supported file and confirm nothing refreshes.
5. Leave another participating tab inactive during a changed save. Confirm it
   becomes stale and refreshes once when activated.
6. Turn Auto Refresh off for one tab. Confirm it neither refreshes nor queues
   the change. Re-enable it and verify the next changed save.
7. Confirm inline/adopted styles, data/blob stylesheets, and iframe documents
   are outside the refresh claim. Confirm `reload` wins a mixed burst.

## Protocol Compatibility

1. Temporarily combine a protocol-v6 extension with a v5 peer.
2. Confirm the connection closes with code `1002`, does not retry v5, and shows
   `Extensions are incompatible` plus instructions to update both extensions
   and reconnect.
3. Confirm the panel reports `Browser protocol: 6 - IDE protocol: 5` when both
   values are known and blocks picker/settings/Source/navigation while keeping
   Link/Disconnect usable.
4. Restore matching protocol-v6 candidates, restart both extensions, reconnect,
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

- **No status code:** confirm Pin-op `0.3.0` is enabled in the candidate
  profile, reopen the local project, and select the start icon if offline.
- **Paste denied:** enter the same seven digits manually; spaces are optional.
- **Link rejected:** copy the current code again from the intended VS Code
  window. Old bridge codes and credentials are intentionally invalid.
- **Extensions are incompatible:** install browser and VS Code extensions from
  the same protocol generation, restart both, and link again. A v5/v6 pair
  cannot downgrade or continue partially.
- **No DevTools panel:** confirm the browser extension is enabled, restart the
  browser, and open DevTools on a normal page.
- **No overlay:** confirm the panel is connected, enable the picker, and use an
  ordinary page element. Unsafe geometry can fail closed.
- **No highlights:** keep the expected source document active, ensure IDE
  Highlight is on, and read the footer. Pin-op never switches source files
  automatically. Source excerpts can remain available while highlighting is
  intentionally off.
- **Firefox rejects the file:** verify it is Mozilla's signed `.xpi`; the
  unsigned `.zip` cannot be installed persistently in Firefox Stable.

## 0.3.0 Candidate Verification Record

Pending external release evidence:

- signed-XPI installation and restart in Firefox Stable;
- installed VSIX activation and restart from the final `0.3.0` artifact;
- unpacked Chrome/Chromium installation and restart from the final artifact;
- complete Firefox/Chrome parity, two-window isolation, DOM-tree boundary,
  box-model overlay, Source pane, Auto Refresh, protocol mismatch, responsive
  layout, CSS fingerprint, SCSS fail-closed, and footer-outcome acceptance;
- checksum comparison against the final draft release;
- privacy-reviewed screenshots and GIF evidence.

No signed `0.3.0` XPI exists in the candidate evidence. Artifact hashes are
pending. Screenshots and GIF evidence remain pending. No installed-product or
external release evidence is claimed by this document yet.
