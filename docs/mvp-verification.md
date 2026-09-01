# Pin-op MVP Verification

This runbook separates installed-product acceptance from optional source-checkout
development. Unless a dated evidence section says otherwise, the manual sections
describe expected acceptance steps and do not claim that an installed-product,
signed-package, screenshot, or release check passed.

## Checkpoint 1 Development-Host Evidence (2026-08-24)

This evidence is limited to the Chromium Inspector shell and DOM checkpoint. It
used source-checkout builds, a VS Code Extension Development Host, the local
fixture, disposable browser profiles, Chrome 151, and Firefox 154. It is not
installed-VSIX, packaged-ZIP, Mozilla-signed-XPI, persistence, or release-candidate
evidence.

Both browsers displayed the registered Pin-op DevTools tab. The shared
`inspector-panel.html` runtime connected to the fixture. Chrome
exercised the complete interactive checklist. Firefox used its registered native
custom tab for the complete interactive checklist. The native Firefox Inspector
panel covered Link, Rules, picker, tree selection, mutation, reload, Auto Refresh,
IDE Highlight, resize, keyboard, forced colors, and Disconnect. The add-on-scoped
DevTools harness provided supplementary target and asset confirmation; it was not
a substitute for any listed native-panel check.

| Check | Development-host result |
| --- | --- |
| Link and lazy root | Chrome and Firefox reached `Connected` with enabled picker/settings controls and a bounded initial root. No link code or credential was recorded. |
| Picker and page overlay | Trusted page input selected `article#fixture-card.card.featured` in both browsers, revealed its collapsed ancestor path, kept the fixture's normal-click count at `0`, and rendered the page overlay. Turning the picker off cleared the preview without clearing selection. |
| Tree selection and hover | The selected row and tree hover drove the same selection/overlay path in both browsers. Direct tree selection of `main.layout.source-mapped-app` was verified in both registered panels. |
| Rules placeholder | Chrome and Firefox showed one selected `Rules` tab backed by a visible, empty, read-only pane. Neither panel exposed Source or any edit/remove/set affordance. |
| Mutation and reload recovery | Removing the selected article cleared selection and kept a bounded live tree. A full navigation then recovered automatically to `Connected` with a populated tree in both browsers. This run exposed and verified the fix for the content-reinjection race. |
| Auto Refresh | In Chrome and Firefox, a saved CSS change replaced only the external stylesheet URL while preserving `performance.timeOrigin` and scroll. With Auto Refresh off, a later saved CSS change produced no replacement. The probes were restored before this evidence was recorded. |
| IDE Highlight | In Chrome and Firefox, selection created Monaco decorations; disabling IDE Highlight removed them, selecting another node did not recreate them, and re-enabling it restored them. |
| Resize and keyboard | Chrome and Firefox both rendered side-by-side DOM/Rules panes at wide width and stacked DOM above Rules at 320 px. The toolbar remained horizontally reachable. ArrowRight expanded `html`; ArrowDown moved the single roving focus to its child. |
| High contrast | Chrome forced-colors emulation and a Firefox forced-colors profile both showed system-color row/disclosure treatment and a visible focus outline without opting out of forced-color adjustment. |
| Disconnect cleanup | In both browsers, Disconnect returned to `Not linked`, disabled picker/settings, emptied the tree, and removed the page-owned overlay host. |

Chrome loaded the unpacked extension through its official extension-debugging
protocol and displayed the registered DevTools panel. Firefox loaded the same
source tree as a temporary add-on with `web-ext` and displayed its registered
native custom tab. Add-on-scoped target discovery confirmed that the active tab
was the packaged `dist/inspector-panel.html` entrypoint, while normal trusted page
input drove picker selection. This remains development-host evidence, not a
Mozilla-signed-XPI claim.

Finally, both browser builds were rebuilt without `PIN_OP_PANEL_VARIANT`, so the
legacy panel remained the default rollback asset. Fresh Chrome and Firefox
profiles kept Source available, resolved `.card`, `.card:hover`, and `.featured`
from the active `card.scss`, and the `.featured` Open action moved VS Code to
line 10, column 1. Firefox exercised Source in the wide split presentation. The
Inspector asset was not made the store-build default. This is historical
Checkpoint 1 evidence only and does not describe the current package default.

## Checkpoint 2 Rules Manual Gate (PARTIAL/HARNESS_BLOCKED)

The checkpoint 2 automated suite verifies the shared CSSOM backend, immutable
matched-style protocol/model, read-only Rules renderer, package markers, and the
fixture facts that a normal page target exposes. The packaged Chrome smoke can
drive that page target, but it cannot drive a DevTools extension panel. There is
no geckodriver/BiDi panel harness in this repository. Therefore none of the
native-panel rows below is claimed as performed until a tester records both a
Chrome result and a Firefox result. Firefox must use its registered Pin-op
DevTools tab; a package/asset assertion is not native Firefox runtime evidence.

The rollout now makes the Inspector entrypoint the ordinary build default. Build
both unpacked extensions without a panel-variant environment variable:

```powershell
corepack pnpm --filter pin-op-chrome build
corepack pnpm --filter pin-op-firefox build
```

Record the visible selector, declaration state, origin label, diagnostic, and
revision probe for every row in each browser:

The revision probe is intentionally non-visual. In the Pin-op panel document
(using the browser's extension/page debugger or the native-panel automation
target), wait for the Rules root to become `ready` or `partial`, then evaluate:

```js
const rules = document.querySelector(
  '[data-pane="rules"][data-state="ready"], ' +
  '[data-pane="rules"][data-state="partial"]',
);
({
  documentEpoch: rules?.dataset.documentEpoch,
  selectionRevision: rules?.dataset.selectionRevision,
  stylesRevision: rules?.dataset.stylesRevision,
  stylesheetRevision: rules?.dataset.stylesheetRevision,
  ruleRef: rules?.dataset.probeRuleRef,
});
```

These values come from the same immutable matched-style snapshot that renders
Rules. The probe attributes are removed while Rules is empty, loading, or in an
error state, so never record a stale value. `data-probe-rule-ref` selects the
first current matched rule (then inline or inherited fallback); individual rule
sections continue to expose their exact `data-rule-ref` values.

| Rules case | Chrome | Firefox | Required observation |
| --- | --- | --- | --- |
| Document adopted sheet | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | `#document-adopted-target` includes the constructed document rule. |
| Open-shadow adopted sheet | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | `.shadow-adopted-target` includes the shadow-root rule. |
| One constructed sheet shared across roots | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | The shared declaration appears under both document and open-shadow selections with root-correct rule identity. |
| Media and viewport changes | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Active/inactive state changes without inventing unsupported cascade facts. |
| Focus and pointer applicability | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | `:focus`/`:hover` applicability follows the fixture state and remains read-only. |
| Sibling and slot mutation | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | The selected scope requeries after `toggleSiblingApplicability()` and `toggleSlottedApplicability()`. |
| CSSOM mutation | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | `insertRule`, `deleteRule`, and `replaceSync` invalidate the current Rules result. |
| Inaccessible and unknown data | PARTIAL/HARNESS_BLOCKED | PARTIAL/HARNESS_BLOCKED | Available rules remain visible; the panel shows a bounded partial diagnostic and never fabricates declarations or origins. |

Run these two eventless matrices from the inspected page console while the
corresponding target stays selected. Do not dispatch an event or edit a DOM
attribute:

1. Record `stylesheetRevision`, aggregate `stylesRevision`, and one current
   `ruleRef`. Call `pinOpRulesFixture.toggleEventlessStylesheet()` to toggle
   `CSSStyleSheet.disabled` and mutate its `MediaList`. After observation,
   verify both revisions advance. Repeat once to restore the fixture.
2. Record the same values, then call
   `pinOpRulesFixture.toggleEventlessApplicability()`. This changes supported
   `checked`, `indeterminate`, value/validity/placeholder state, and
   `ElementInternals.states` where the browser exposes it, without an event or
   attribute mutation. Verify the bounded applicability poll advances only
   `stylesRevision`; `stylesheetRevision` and the matching `ruleRef` remain
   unchanged. Record unsupported custom-state support as partial, not passed.

Repeat both matrices with the fixture tab backgrounded long enough for browser
timer throttling. Observation may be delayed in that state. Record the delay,
then click the Pin-op toolbar button labelled **Refresh styles**
(`#refresh-styles`). The button is browser-local, needs no IDE connection, and
is disabled when there is no current selection. It requeries the exact current
selection through the existing `styles.getMatched` request with the exact optional
`manualRefresh: true` marker. That marker forces a bounded applicability rebaseline;
the normal stylesheet-fingerprint path then detects sheet changes and recollects.
Wait for Rules to return to `ready` or `partial`, rerun the probe above,
and verify the expected revision pair and matching rule. A delayed background
observation is not a failure if **Refresh styles** produces the correct result;
an uncorrected manual refresh is a failure.

## Installed Product Verification

Installed Pin-op needs no source checkout or terminal. There is no
separate bridge process: the installed VS Code extension starts automatically
when a local project opens and exposes its start/stop and link-code control in
the VS Code status bar.

### Candidate Packages

Use candidates from one trusted build or draft release and compare each file to
that draft's `SHA256SUMS` before installing:

- `pin-op-vscode-0.3.2.vsix`;
- `pin-op-chrome-0.3.2.zip`;
- `pin-op-firefox-0.3.2.zip` for a Firefox Temporary Add-on;
- a Mozilla-signed `pin-op-firefox-0.3.2.xpi`, when available, for a
  persistent Firefox Stable installation.

Install the VSIX with **Extensions > Install from VSIX...**. Open a local
project and confirm Pin-op starts automatically. Its status bar control
must show a five-digit port and two-digit PIN, such as `48735 07`; clicking it
copies the seven digits without the space.

For Chrome/Chromium 116 or newer, extract
`pin-op-chrome-0.3.2.zip`, open `chrome://extensions`, enable
Developer mode, choose **Load unpacked**, and select the extracted directory
containing `manifest.json`. Confirm version `0.3.2`, no extension-card errors,
the Pin-op DevTools panel, and persistence after a complete browser
restart.

Firefox Stable supports the unsigned
`pin-op-firefox-0.3.2.zip` only as a temporary check. Extract it,
open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select its `manifest.json`. Confirm the Pin-op panel and version
`0.3.2`; expect the Temporary Add-on to disappear after Firefox exits. For a
persistent check, use **Install Add-on From File...** with the exact
Mozilla-signed `pin-op-firefox-0.3.2.xpi`, then restart every Firefox
process and confirm it remains enabled. Do not treat the unsigned ZIP as
signed-XPI evidence.

### Associate Browser And VS Code Windows

Association is explicit and window-scoped:

Each browser window is associated with one VS Code window by that VS Code
window's five-digit port and two-digit PIN code.

1. Open the project in VS Code Window A and click its Pin-op status bar
   control to copy the current port/code.
2. In Browser Window A, open DevTools and the **Pin-op** panel. Confirm
   `Not linked`, paste or type Window A's code, and select **Link**.
3. Confirm `Connected` and the same grouped port/code in Browser Window A and
   VS Code Window A. That exact code associates this browser window with this
   VS Code window; it is not a machine-wide association.
4. Repeat with Browser Window B and VS Code Window B using B's different code.
   Alternate selections and confirm neither browser window updates the other
   VS Code window.

No source terminal is required for this installed flow. A second tab in the
same browser window reuses that window's association; a new browser window
starts `Not linked`.

### Expected Source Navigation And Recovery Scenario

These are expected manual acceptance steps only. They have not been performed
here. This document does not claim these checks were performed or passed.

1. Connect an installed browser panel to the intended VS Code window. Expand a
   branch in the lazy DOM tree and select an element with at least two Selected
   matches in the active CSS or SCSS document.
2. Confirm the selected tree row and footer expose navigation controls, and the
   row and footer counts stay in sync and show the same selected-only total.
3. Confirm selection itself does not move the VS Code cursor. Parent ranges
   remain distinct and excluded from navigation even though their decorations
   remain visible.
4. Click **Previous** or **Next** once. The first Previous/Next click moves the
   primary VS Code cursor to a Selected match and centers that range. Continue
   in both directions and confirm deterministic wraparound.
5. Manually move the primary cursor outside every Selected match. Confirm both
   browser controls update to `- / N` without another inspect selection.
6. Reload the page while the selected element's identity is unchanged. Confirm
   the expanded branch and selection restore without a root-only flash, and
   source navigation resumes against the new browser-local refs.
7. Change or remove the selected node so its stable identity is changed or
   ambiguous, then reload or invalidate its branch. Confirm Pin-op safely
   resets instead of selecting a nearby element.
8. During recovery, trigger a second invalidation and then make a manual
   selection. Confirm the second invalidation supersedes older recovery work
   and the manual selection wins.
9. Select **Disconnect**. Confirm navigation controls are disabled or hidden,
   no stale route can update them, no old Previous/Next intent moves VS Code,
   and another linked browser window remains connected.
10. In the Inspector's Source tab, confirm it shows only bounded
    excerpts from the active IDE document, with Selected expanded and immediate
    Parent collapsed. Click an excerpt and confirm the cursor opens that exact
    range without switching the active editor.
11. Turn **IDE Highlight** off. Confirm decorations clear while Source excerpts
    and Selected-only navigation continue to work; turn it back on.
11a. Select **Disconnect**, then open the Source tab. Confirm it names where the
    seven-digit code is copied from (the VS Code status bar item) and where it
    is pasted (the field at the top of the panel), and that linking again
    restores excerpts. Confirm the same walkthrough appears in a panel that has
    never been linked.
11b. Make a PHP template the active IDE document and select an element it
    renders. Confirm the Source tab shows that element's markup when the
    template identifies it uniquely by `id`, by a `data-*`/`aria-*`/`role`
    attribute, or by the classes the template writes literally, including when
    the element carries further classes added by PHP or scripts. Confirm a
    block written in two conditional branches lists both, and that a template
    element whose literal `id`, class, or attribute the element contradicts is
    left out.
12. With **Auto Refresh** on, change and save CSS, SCSS, JavaScript, TypeScript,
    Vue, PHP, and HTML as described below. Confirm unchanged saves do nothing.

Repeat the scenario with the supported installed Firefox path and with the
installed Chrome package. Also verify picker/DOM-tree parity, open shadow roots,
same-origin frames, locked cross-origin frames, CSS fingerprint fallback,
source-mapped SCSS, Source presentation, refresh behavior, exact footer
outcomes, browser-window isolation, protocol mismatch, and session-only
reconnect/cleanup as described in the
[installed artifact verification guide](installed-verification.md).

### Expected Inspector Rules-Origin Scenario

These remain manual acceptance steps. Build and load the ordinary Chrome and
Firefox artifacts; both register the shared Inspector by default.

1. Confirm the new Inspector shows DOM Tree and Rules with no visible Source tab.
2. Verify exact CSS, inline-map SCSS, external-map SCSS, nested SCSS, and a
   selector/declaration split map. Each current origin label must identify only
   the verified generated CSS or exact original SCSS block.
3. Explicitly click each origin. The click may switch VS Code across workspace
   files using a current IDE-issued opaque authority and must reveal the complete
   smallest exact block.
4. Test an invalid map, generated-CSS edit, map edit, stale authority, and
   cross-file editor switch. Missing or invalid maps show verified generated CSS
   only; stale authority cannot move the cursor or reveal a range.
5. Confirm no workspace URI/path, full range, document version, source-map path,
   or command appears in browser/bridge diagnostics or wire capture.
6. Confirm the Source tab remains active-document-only and otherwise unchanged.

Record Chrome and Firefox outcomes in the Checkpoint 3 matrix in
`docs/installed-verification.md`. If the native UI harness cannot perform the
cross-product click, record `PARTIAL/HARNESS_BLOCKED`; never promote automated
package, bridge, browser-controller, or VS Code integration coverage to native
`PASS`.

## Development And Source Workflow

This optional workflow is for contributors testing a source checkout. It is
separate from installed-product use and may use development hosts, package
scripts, and local fixture servers.

HTTP in this workflow serves only fixture and stylesheet/frame resources.
Pin-op product traffic remains a loopback WebSocket.

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
corepack pnpm --filter pin-op-chrome test -- manifest.test.ts adapter.test.ts
corepack pnpm package
git diff --check
```

The package command creates and verifies the `0.3.2` VSIX, Chrome ZIP,
unsigned Firefox ZIP, Firefox source ZIP, and `SHA256SUMS`.

The packaged Chrome artifact smoke is separate:

```powershell
corepack pnpm smoke:chrome-package
```

That smoke asserts page/package markers (`styles.getMatched`, read-only Rules,
`rules-sources`, `rules.sources`, `rules.open`, and scoped Chromium CSS) plus
fixture/runtime CSSOM facts. Its CDP target is an ordinary fixture page: it does
not open the DevTools extension panel, link VS Code, click a Rules origin, or
receive an open acknowledgement. It cannot replace the Chrome/Firefox Rules
manual gate above, whose unperformed native cells remain
`PARTIAL/HARNESS_BLOCKED`.

The Inspector panel smoke drives the real extension end to end -- background
service worker, content script, and the panel itself -- without a DevTools
window, by opening the devtools page as an ordinary extension tab with
`chrome.devtools` stubbed:

```powershell
corepack pnpm smoke:inspector-extension
corepack pnpm smoke:inspector-extension-firefox
node tools/smoke-inspector-extension.mjs --workspace examples/basic-css
node tools/smoke-inspector-extension.mjs --browser firefox --workspace examples/basic-css
node tools/smoke-inspector-extension.mjs --url http://localhost/site/ `
  --pick "#heading" --branch "content_block" --triangle "block_cnt"
```

`--browser firefox` runs the same contract against the shipped Firefox
extension. Gecko has no CDP, so that path speaks Marionette (the only way to
reach chrome scope, and chrome scope is the only way to open a `moz-extension://`
tab) bridged into WebDriver BiDi through the `webSocketUrl` capability. Firefox
must be installed; `PIN_OP_FIREFOX` overrides where it is looked for.

Another page needs its own targets: `--pick` is the element clicked on the page,
`--branch` the tree row to select, and `--triangle` the row to open or close.
Needles match the row text, so a page whose top-level rows carry no `class=`
needs its own; the `_ORB` project runs green with `--pick "#section_title_id1"
--branch "<div" --triangle "<div"`.

It arms the picker, clicks the page, suspends the extension background the way
the browser does with an idle one, then clicks a tree row and a disclosure
triangle, and holds the result to the panel contract: the pick lands on the
element the page shows under the cursor, the picker disarms afterwards, the
revealed tree carries no whitespace-only rows and no leftover `Load more` rows
over hidden siblings, Chromium adorners stay hidden, the suspended background
comes back with the same element selected and its tree and Rules intact instead
of cleared panes, a run of row clicks aimed from one measurement in a short pane
each selects the row it aimed at without the tree moving underneath, the selected
row paints a selection band that is not buried behind the panel's own surface,
every interaction lands inside `INSPECTOR_INTERACTION_BUDGET`,
and the panel's own console stays free of thrown errors -- a Chrome-only DOM call
once threw out of every tree click in Gecko while every other gate still passed. With `--workspace` it also launches the
Pin-op VS Code extension on that folder, links the panel with the IDE's link
code, and requires at least one Rules row to resolve to a workspace source. It
still does not click a Rules origin or assert an open acknowledgement, so the
native Rules manual gate stays as recorded above.

On Linux, `smoke:chrome-package` requires a graphical session or Xvfb. Set
`DISPLAY` or `WAYLAND_DISPLAY`, or run it under `xvfb-run -a`; the script refuses
to launch Chrome without one of those display paths.

The focused browser-core suite can be useful while iterating:

```powershell
corepack pnpm --filter @pin-op/protocol build
corepack pnpm --filter @pin-op/browser-extension-core exec vitest run test/windowWorkflow.test.ts test/pageOverlay.test.ts test/domTreeProvider.test.ts test/domTreeController.test.ts
```

## Build And Serve The Fixture

Build once:

```powershell
corepack pnpm build
```

Start the fixture in a dedicated source-workflow shell:

```powershell
node examples/basic-css/server.mjs
```

Keep `http://127.0.0.1:4173/` running. The fixture contains:

- source-mapped `src/card.scss` and `src/layout.scss`;
- generated `dist/app.css`;
- a CSSOM path-miss fingerprint case and duplicate-selector ambiguity;
- inline, runtime-injected, virtual, CORS-readable, and inaccessible styles;
- competing specificity, `!important`, inline, inherited, inactive
  media/supports, nested-group, and duplicate-selector cases;
- document/open-shadow adopted sheets and one constructed sheet shared across
  document and shadow roots;
- eventless stylesheet/applicability, sibling, slot, and CSSOM mutators;
- multiline overlay geometry;
- dynamic DOM mutation controls;
- an open shadow root;
- same-origin and cross-origin frames.

## Start Two VS Code Development Windows

From two additional source-workflow shells:

```powershell
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

Call them IDE A and IDE B. In both:

1. Confirm Pin-op starts automatically.
2. Confirm the status item shows a grouped port and two-digit PIN.
3. Confirm the windows show different current codes.
4. Click each status item and associate its clipboard value with A or B.
5. Open `examples/basic-css/src/layout.scss` and keep Applicable Sources open.

Do not run a separate bridge process.

## Load Firefox For Development

From another source-workflow shell, create one disposable profile and preserve it for restarts in
this verification run:

```powershell
$firefoxProfile = Join-Path $env:TEMP ("pin-op-0.3.2-" + [guid]::NewGuid().ToString("N"))
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

1. Open the Pin-op DevTools panel in Browser Window A. Confirm `Not linked`.
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
9. Confirm the overlay uses the lighter half-alpha fills and disappears when
   the pointer leaves the hovered page element or DOM tree, while selection
   remains intact.

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

Exercise `.pin-op-path-miss` with CSS active. Confirm the unique CSS
fingerprint fallback resolves. Select `.duplicate-selector` and confirm
`Ambiguous rule match` rather than an arbitrary range.

For SCSS, temporarily test missing, unreadable/invalid, and unmapped source-map
variants. Confirm `SCSS source map missing`, `SCSS source map invalid`, or
`No matching rules in active file`, with no guessed highlight. Restore the
fixture after the checks.

### IDE Highlight And Default Inspector Layout

Keep the ordinary default Inspector loaded for this block.

1. Select an element with several Selected matches and an immediate Parent
   match while the intended CSS or SCSS file is active.
2. Confirm DOM Tree and Rules are visible and no Source tab is rendered.
3. Confirm no full source document, workspace path, URI, or browser tab ID is
   displayed or exposed by panel diagnostics.
4. Confirm Previous/Next cycles only through Selected matches and its counter
   follows the VS Code primary cursor.
5. Turn **IDE Highlight** off. Confirm all decorations clear while resolution,
   Rules origins, and Selected-only navigation remain usable. Turn it on and
   make a new selection; confirm Selected and Parent decorations return.
6. At wide width, confirm DOM Tree and Rules use the side-by-side presentation.
   At 320 px, confirm DOM Tree stacks above Rules, the toolbar remains reachable,
   and neither pane is clipped.

### Source Tab

1. Select an element with several Selected matches and an immediate Parent
   match while the intended CSS or SCSS file is active.
2. Open the Inspector's **Source** tab and confirm it contains excerpts only
   from that active document; Selected is expanded and Parent is initially
   collapsed.
3. Click each excerpt and confirm VS Code reveals the exact current range by
   opaque match identity. Repeat after a newer inspect and confirm an old click
   is ignored.
4. Turn **IDE Highlight** off. Confirm decorations clear while the Source tab,
   exact excerpt opening, resolution footer, and navigation remain usable; turn
   it back on.

### Auto Refresh

Open the Pin-op panel in two fixture tabs and leave Auto Refresh enabled.

1. Change and save direct CSS. Confirm the active tab replaces external
   top-document HTTP(S) stylesheet links after the 150 ms settle without a page
   reload or lost scroll.
2. Force one replacement to fail and confirm its old stylesheet remains.
3. Change and save SCSS. Confirm Pin-op waits for generated CSS using the 750 ms
   quiet/two-second maximum window and refreshes styles after generation.
4. Change and save JS, MJS, CJS, JSX, TS, TSX, Vue, PHP, or HTML. Confirm the
   active tab reloads after the 150 ms settle and restores its bounded top-level
   scroll position.
5. Save an unchanged supported file and confirm no refresh occurs.
6. Put the second participating tab in the background, save again, then
   activate it. Confirm it refreshes once on activation and does not replay old
   generations.
7. Turn Auto Refresh off in one tab and save. Confirm that tab neither refreshes
   nor queues stale work; re-enable it and verify a later changed save.
8. Confirm inline, adopted, data/blob, and iframe styles are not claimed as
   refreshed. In a mixed burst confirm `reload` wins over `styles`.

### Protocol Mismatch

Use intentionally mismatched development artifacts once:

1. Confirm a protocol-v5 peer is closed with WebSocket code `1002`, with no
   compatibility retry or fallback.
2. Confirm the panel shows `Extensions are incompatible`, tells the user to
   update both extensions and reconnect, and reports expected/received protocol
   versions when known.
3. Confirm picker, settings, Rules-origin, and selected-match navigation actions
   are blocked while Link/Disconnect remains usable.
4. Restore matching protocol-v7 artifacts, restart both extensions, reconnect,
   and confirm a fresh compatible handshake and tab state restore the defaults.

### Optional `_ORB` Project Regression

Use this check when the real `_ORB` project is available alongside the current
Development Host workflow:

1. In the current Extension Development Host, choose **File > Add Folder to
   Workspace** and add the real project root named `_ORB`, or open it in that
   host as appropriate. Keep the repository fixture available in the host for
   the automatic-mode check below.
2. Confirm the project contains
   `wp-content/themes/orbiter/style.scss`, its generated `style.css`, and a
   usable inline or external source map from that CSS into the SCSS file. Leave
   the project's other `style.css` files in place as duplicate basenames.
3. In the already linked Firefox Pin-op panel, load
   `http://localhost/_ORB/` and inspect `.home_slide_title`. Confirm its CSS
   comes from `/_ORB/wp-content/themes/orbiter/style.css?v=7`.
4. Keep the mapped `wp-content/themes/orbiter/style.scss` active in VS Code and
   confirm complete SCSS blocks, including their closing braces, are
   highlighted.
5. Run **Pin-op: Open Diagnostics**. Confirm the exact strategy message
   `Workspace-bound: _ORB` and `resolution status=matched`, not
   `resolution status=source-ambiguous`.
6. Separately confirm the Firefox DevTools footer does not show
   `Ambiguous source path`.

Return to the repository fixture at `http://127.0.0.1:4173/`, activate
`examples/basic-css/src/layout.scss`, and select `.card.featured`. Run
**Pin-op: Open Diagnostics** and confirm the exact strategy message
`Automatic source matching`.

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

- Firefox: `about:debugging#/runtime/this-firefox` > Pin-op > Inspect;
- Chrome: `chrome://extensions` > Pin-op > service worker.

List keys only, never values containing tokens:

```js
Object.keys(await browser.storage.session.get(null))
Object.keys(await chrome.storage.session.get(null))
```

Confirm one `pin-op.windowLink.<windowId>` key per linked browser window.
Disconnect or close Window A and confirm only its key disappears. Restart the
complete browser profile and confirm no prior window-link key survives. A newly
opened panel must start `Not linked`.

## Cleanup

1. Turn off page pickers and select **Disconnect** in each browser window.
2. Stop Pin-op in both VS Code windows.
3. Close the development hosts and development-loaded browsers.
4. Stop the fixture and Firefox development process with `Ctrl+C`.

## Regenerate The CSS Fixture

After changing SCSS fixture source:

```powershell
corepack pnpm exec sass examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
