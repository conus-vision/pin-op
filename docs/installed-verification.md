# PinOp Installed Artifact Verification

This is the terminal-free installation and acceptance runbook for the
PinOp `0.3.0` release candidate. Normal use has no separate PinOp
process: open a local project and the VS Code extension starts automatically.

## Candidate Files

Obtain all files from the repository owner or one trusted draft release and
keep them with that draft's `SHA256SUMS`:

- `pinop-vscode-0.3.0.vsix`;
- `pinop-chrome-0.3.0.zip`;
- `pinop-firefox-0.3.0.xpi`, signed by Mozilla.

The unsigned `pinop-firefox-0.3.0.zip` is build and Mozilla-review input.
It is not a persistent Firefox Stable add-on and cannot replace the signed XPI.

## Privacy And Security Before Testing

PinOp is read-only. Product traffic uses a loopback WebSocket between one
explicitly linked browser window and local VS Code; there is no product HTTP or
remote PinOp service. The two-digit PIN protects against accidental local
cross-linking, not a malicious process running as the same desktop user.

One selection can send bounded facts for the selected element and its immediate
parent: full page URL/route, IDs, classes, permitted `data-*`, `aria-*`, and
`role` names and values, CSS declarations and stylesheet identity, and bounded
development metadata. These values are not content-redacted. PinOp does
not deliberately read cookies, headers, form values, DOM text, workspace source
text, or source-map contents in the browser.

The DOM tree, browser-local node refs, child pages, and box-model geometry stay
inside the browser extension. Cross-origin frames are locked, and closed shadow
roots are not traversed. Local VS Code source plugins can read relevant
workspace files and source maps to resolve the active document; PinOp does
not upload them. Separately installed source plugins are independent trusted VS
Code extensions and may have their own data behavior.

Avoid private pages unless sending the bounded selection values to the linked
local VS Code window is acceptable. Read the [privacy policy](../PRIVACY.md),
[security policy](../SECURITY.md), and [security model](security.md).

## Install VS Code

1. Open VS Code and choose **Manage > Profiles > Create Profile**.
2. Create an empty profile named `PinOp 0.3.0 Candidate` and select it.
3. Open Extensions, confirm no unrelated user extension is enabled, open the
   view menu, and choose **Install from VSIX...**.
4. Select `pinop-vscode-0.3.0.vsix`, accept the prompt, and restart VS Code
   in the same profile.
5. Open a local project folder. Confirm PinOp starts automatically and
   shows a status item such as `PinOp: 48735 07` plus a stop icon.
6. Click the PinOp status item. Confirm VS Code reports
   `PinOp link code copied.`

The status item shows a five-digit port followed by a two-digit PIN. Its copied
value has no space, for example `4873507`. Each local VS Code window owns a
different bridge instance and current code.

## Install Chrome Or Chromium

1. Extract `pinop-chrome-0.3.0.zip` into a permanent candidate folder.
2. Open `chrome://extensions` in current Chrome/Chromium 116 or newer.
3. Enable **Developer mode** and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Confirm the PinOp card reports version `0.3.0` with no errors.
6. Restart the complete browser and confirm the extension remains installed.

## Install Firefox Stable

This path requires the Mozilla-signed XPI. Leave Firefox acceptance pending
until that exact file exists.

1. Open Firefox Stable 142 or newer and open Add-ons Manager.
2. Open its tools menu and choose **Install Add-on From File...**.
3. Select `pinop-firefox-0.3.0.xpi` and approve its permissions.
4. Confirm PinOp `0.3.0` is enabled.
5. Restart every Firefox process and confirm the signed add-on remains enabled.

## Normal Inspector Flow

Run this flow once in Firefox Stable and once in current Chrome/Chromium:

1. Open the project in the intended local VS Code window and keep its intended
   CSS or SCSS document active.
2. Click the PinOp status item to copy its port and PIN.
3. Open one normal browser window, open DevTools for the test page, and select
   the **PinOp** DevTools panel.
4. Confirm `Not linked`, choose Paste or enter the code, then select **Link**.
5. Confirm `Connected` and confirm the same displayed code appears in the panel
   and VS Code.
6. Use either the visual page picker or the lazy DOM tree to select an element.
7. Confirm VS Code highlights the expected source ranges without opening or
   switching editor tabs.
8. Read and record the exact footer outcome in DevTools.

The page picker is the mouse-pointer button. Hover a normal element and verify a
noninteractive box-model overlay with distinct margin, border, padding, and
content geometry. Click to select it. While the picker is active, its selection
gesture must not invoke the page's own handler. Press Escape to clear hover and
then turn off the picker.

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
   `PinOp: Offline` and Browser A reports `Linked IDE offline`.
2. Start PinOp again from the adjacent icon. Confirm a fresh code appears
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

- **No status code:** confirm PinOp `0.3.0` is enabled in the candidate
  profile, reopen the local project, and select the start icon if offline.
- **Paste denied:** enter the same seven digits manually; spaces are optional.
- **Link rejected:** copy the current code again from the intended VS Code
  window. Old bridge codes and credentials are intentionally invalid.
- **No DevTools panel:** confirm the browser extension is enabled, restart the
  browser, and open DevTools on a normal page.
- **No overlay:** confirm the panel is connected, enable the picker, and use an
  ordinary page element. Unsafe geometry can fail closed.
- **No highlights:** keep the expected CSS/SCSS document active and read the
  footer. PinOp never switches source files automatically.
- **Firefox rejects the file:** verify it is Mozilla's signed `.xpi`; the
  unsigned `.zip` cannot be installed persistently in Firefox Stable.

## 0.3.0 Candidate Verification Record

Pending external release evidence:

- signed-XPI installation and restart in Firefox Stable;
- installed VSIX activation and restart from the final `0.3.0` artifact;
- unpacked Chrome/Chromium installation and restart from the final artifact;
- complete Firefox/Chrome parity, two-window isolation, DOM-tree boundary,
  box-model overlay, CSS fingerprint, SCSS fail-closed, and footer-outcome
  acceptance;
- checksum comparison against the final draft release;
- privacy-reviewed screenshots and GIF evidence.

No signed `0.3.0` XPI exists in the candidate evidence. Artifact hashes are
pending. Screenshots and GIF evidence remain pending. No installed-product or
external release evidence is claimed by this document yet.
