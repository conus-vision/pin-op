# Changelog

All notable changes to Pin-op will be documented in this file.

## [0.4.1] - Unreleased

### Added

- A welcome message in the empty Pin-op view that links the Chrome Web Store
  and Firefox Add-ons pages for the browser half and repeats how to link a
  window.

### Changed

- Pointed the public descriptions at the published store listings. The VS Code
  README names the Chrome and Firefox pages, both browser listings name the
  Visual Studio Marketplace page, and all of them state that support for IDEs
  other than VS Code is in development. Release-status wording now says
  `GitHub Release` where it means the GitHub Release rather than the store
  listings, and the security policy supports `0.4.x` outright instead of
  waiting on a publication that has happened.
- Advanced the product release to `0.4.1`. The wire protocol stays at `7`.

### Fixed

- `prepackage` now also clears an unpacked candidate build left in
  `artifacts/`. The artifact verifier rejects every non-file entry there, so
  a directory extracted from the previous version failed the next
  `pnpm package`. A directory that only mimics an artifact file name is still
  preserved, and a symbolic link is never followed or removed.

## [0.4.0] - 2026-09-01

### Added

- Rules marks the selectors the `:hov` preview is what makes match, with the
  same fill the filter leaves on what it matched, so a previewed rule is
  distinguishable from the ordinary matches around it. A negated target, a
  target inside `:has()`, and anything else the preview cannot force stay
  unmarked, because the preview is not what makes those match.
- A terminal-free Browser Inspector workflow: VS Code starts automatically,
  the status item copies the port and PIN, and the DevTools panel confirms the
  same displayed code after linking.
- A visual page picker with a browser-local margin, border, padding, and content
  box-model overlay.
- A virtualized, lazy DOM tree with paged children, keyboard navigation, open
  shadow roots, same-origin frame documents, and locked cross-origin boundaries.
- Selection from either the picker or DOM tree, with exact resolution outcomes
  returned to the DevTools footer.
- Multi-range Selected and immediate-Parent highlighting in the active CSS or
  source-mapped SCSS document.
- Conservative CSS fingerprint fallback and fail-closed SCSS source-map
  outcomes.
- A versioned public source-plugin API for separately installed VS Code source
  resolvers.
- Selected-match Previous/Next controls shared by the DOM-tree row and footer,
  with centered VS Code cursor navigation and live cursor-state counts.
- Browser-local stable-locator recovery for expanded branches and selections
  across safe reloads and invalidations.
- Tab-local Auto Refresh for changed CSS/preprocessor, JavaScript, TypeScript,
  Vue, PHP, and HTML saves, including soft stylesheet replacement and reload
  scroll restore.
- A responsive Source tab with bounded active-document excerpts for Selected and
  immediate Parent matches and exact opaque-ID opening in VS Code.
- A tab-local IDE Highlight setting that controls decorations without removing
  resolution, Source presentation, or navigation.
- One shared Chromium-derived, read-only DOM Tree and Rules UI enabled by
  default in Firefox and Chrome, with its BSD attribution, pinned Chromium
  source manifest, and auditable Pin-op change record included in the source
  distribution.
- Exact generated CSS and source-mapped SCSS Rules origins that open only after
  an explicit current origin click.
- A browser-local author-style `:hover` and `:focus` preview for supported
  readable rules, with bounded partial diagnostics for unsupported,
  inaccessible, and source-order-approximate cases.
- A draggable, keyboard-adjustable separator between the DOM tree and the
  element details pane, with its size remembered per browser.
- A line under the panel's status row naming the product, its author and Conus
  Vision: `Pin-op by Volodymyr Moskvin © 2026 Conus Vision`, where the author
  opens a message and the company opens its site.
- A built-in PHP source provider for the active PHP document. It uses
  `php.template` and `wordpress.acf-block` instrumentation facts when a runtime
  emits them, and otherwise searches the template's literal markup by `id`, then
  `data-*`/`aria-*`/`role` attributes, then classes. Containment runs template
  into element, so classes and attributes PHP or scripts add later never hide
  the template that wrote the static ones, and a contradicting literal value
  rules a template element out. Equally strong candidates are all listed, since
  a template routinely writes one block in several conditional branches; beyond
  eight the result is reported as ambiguous instead of guessed.
- Built-in `dom-attribute` facts derived host-side from the selected and parent
  element identity, so DOM-driven source resolvers dispatch on an ordinary
  selection. Nothing new crosses the bridge.
- A link walkthrough in the Source tab whenever no IDE is connected, naming
  where the seven-digit code is copied from and where it is pasted. The pane
  follows the connection state rather than a single message, so it shows the
  walkthrough from the first paint and keeps it across panel recovery.

### Fixed

- Paste answers in the Chrome panel. The asynchronous Clipboard API is gated on
  the `clipboard-read` permissions policy, which a document delegates only to
  its own origin, and a DevTools panel is a frame the toolbox embeds
  cross-origin without delegating it - so the read was refused however the
  extension was permitted, and the control reported nothing to paste. The read
  now falls back to the editing command, which is gated on the extension's own
  `clipboardRead` permission and still answers inside the panel.
- Rules origins resolve in Chrome for a rule that names a quoted font family.
  Blink drops the quotes the stylesheet wrote and Gecko keeps them, so a rule
  declaring `font-family: "gilroy-bold", Arial` matched the file in Firefox and
  fell back to generated CSS in Chrome. A family name that is already an
  identifier sequence is now read as that name on both sides; a name that needs
  its quotes, and a quoted generic or CSS-wide keyword, keep them.
- Previewed `:hover` and `:focus` styles reach the page. A mirror is written
  from the longhands the CSSOM enumerates for a shorthand, and the engine hands
  that back as the shorthand it parsed. The mount check compared the two as text
  and read the difference as tampering, dropping the whole mirror - so on any
  stylesheet holding one such shorthand, which is most real ones, ticking
  `:hover` listed the rule in Rules and changed nothing on the page. The
  expectation now goes through the same parser before the two serializations are
  compared.
- `:hov` no longer needs a linked editor. The preview never leaves the browser:
  it moves only between the panel, the background worker, and the inspected
  page. Disabling it on the IDE's window and peer state left the control dead
  for anyone reading styles without VS Code linked, reporting that the browser
  was disconnected while the Rules pane was plainly working.
- The `:hov` menu stays on screen while a tick settles. Ticking a box began the
  atomic replacement, which disabled the control, which closed the menu - so the
  box vanished from under the pointer that had just ticked it, and every reload
  of the same element closed it again. A busy menu now keeps its boxes visible
  and only disables them; a control with nothing left to offer still closes.
- Rules origins survive an applicability-only invalidation. Resizing the page
  re-evaluates media queries, which advances the styles revision but not the
  stylesheet revision, so every rule reference - and every CSS/SCSS origin the
  IDE published against it - is still current. The panel used to drop them on
  any invalidation, which is what lost the source links on resize.
- A reload of the same element keeps its rules on screen. The pane reports
  itself busy through `aria-busy` instead of emptying and filling again, so
  Refresh reads as an update rather than as the Rules list resetting.
- Auto Refresh no longer leaves Rules on `Styles unavailable (cancelled)`.
  Replacing a stylesheet keeps the page's style authority moving for a moment,
  because swapping the link is itself a mutation the applicability observer
  sees. The retries a cancelled collect is given all ran in the same turn, so
  they were spent against a page that had not settled and the pane stayed on the
  error. Each retry now waits a beat.
- Auto Refresh republishes the evidence the page has after the swap, not the
  evidence it had before it. A refresh republishes the retained selection, and a
  renewal arriving while that republish was in flight - the page reporting that
  its own evidence moved again, which a stylesheet swap always causes - was
  recorded and then dropped when the republish succeeded. The IDE was left
  resolving rule positions from the stylesheet the refresh had already replaced,
  so every origin fell back to generated CSS until the element was picked again.
- Rules origins recover when a build writes the source map after the CSS. A
  resolution that lands between the two verifies against a map that no longer
  describes this CSS and correctly falls back to generated CSS positions, but it
  recorded no map among its dependencies - so the map's own arrival changed
  nothing and the origin stayed on `style.css` until the element was picked
  again. The map belonging to a watched stylesheet is now watched with it.
  Watching costs a re-resolution; it does not make the CSS answer stale.
- The cancelled-collect retry budget covers a whole stylesheet rebuild rather
  than a single race, and any invalidation refills it.
- DOM recovery no longer waits out the ordinary DOM request timeout. A reload
  replaces the content session, and the panel is told when the old one goes
  rather than when the new one arrives, so an optimistic root request can land
  in that gap and be neither answered nor refused. It sat on the 15-second
  request timeout, holding the tree frozen on `Restoring DOM` with the Rules
  pane empty, and then gave up on the selection. Recovery now gives the page a
  far shorter deadline of its own, reports "not ready", and retries.
- A tab reload no longer empties the DOM tree. The panel is told its content
  lease is gone the moment the old one is replaced, which is before the new one
  has attached, so the first recovery attempt could find no session at all and
  reset the tree to a root the reloading page could not fill. The frozen tree is
  now held while the panel waits for the new session, bounded, and the previous
  selection is restored from it. Saving a PHP file is the ordinary way to hit
  this.
- A cancelled matched-styles collection retries instead of settling on
  `Styles unavailable (cancelled)`. `cancelled` means the page moved its style
  authority mid-collect, which a resize drag does repeatedly; the last
  cancellation carried no invalidation behind it to reload from, so the pane
  stayed on an error the page had already moved past. Retries are bounded.

### Changed

- Advanced the product release to `0.4.0` and the exact wire protocol to the
  breaking version `7`.
- Added capability-gated auto-refresh, source-presentation, presentation-
  settings, navigation intents, and repeated navigation-state updates. Protocol
  v6 is closed with code `1002`; there is no adapter or fallback.
- Replaced the old linked-panel actions with one **Disconnect** action that
  unlinks only the current browser window.
- Kept Firefox Stable and current Chrome/Chromium on the shared Inspector
  behavior and read-only resolution path.
- Made the Chromium-derived Inspector the default panel in both browser
  packages.

### Removed

- The non-default legacy rollback panel, its own DOM/Rules renderers, and the
  `PIN_OP_PANEL_VARIANT` build switch. Chrome and Firefox now package exactly
  one panel page and one Inspector implementation; the Source tab, resolution
  footer, and every bridge owner are unchanged.
- The `== $0` console hint in the DOM tree. Pin-op exposes no console binding
  for it.

### Fixed

- Restored Chromium's real Inspector surfaces: the panel now declares the
  browser's baseline theme and platform font classes, so Rules controls stop
  rendering on a tinted blue field and use DevTools typography.
- Removed the unstyled `view-source` badge that leaked next to the root element
  by reporting every upstream adorner as disabled.
- Moved the `:hov` preview into Chromium's own Styles toolbar row and toolbar
  pane. Its coverage status no longer floats over the rule list, and neutral
  status text stays announced without occupying the pane.
- Stacked the DOM tree above Rules below 680 CSS pixels, matching the width at
  which Chromium's Elements panel moves its sidebar under the tree.
- Bound DOM-tree timers to the inspected page window in Firefox, restoring
  content-script startup, the page picker, the DOM tree, and source highlights.
- Stopped presenting Pin-op's own page overlay as page content. A content
  session the browser tore down without warning leaves its overlay host behind,
  owned by nobody: it kept whatever it had last painted and appeared in the DOM
  tree as an enormous inline-styled element. A new overlay now clears abandoned
  hosts, and the tree never shows a node wearing Pin-op's overlay marker.
- Rules source links now open the preprocessor source for rules a mixin wrote.
  A rule inside a mixin says `&`, and what that becomes is only known where the
  mixin is used, so the selector could not be compared and the link stopped at
  the compiled CSS; a rule that cannot state its own selector is now identified
  by the source map and by what it does declare directly. A mixin body, an
  `@each` loop and the rest of a preprocessor's own constructs no longer read as
  cascade conditions Pin-op cannot account for. A value that names properties --
  `transition`, `will-change` -- is also read the way a browser reports it: each
  browser answers in the property names it knows, and leaves out a `0s` delay.
- Gave the Rules pane back the two lines it spent on itself. A partial snapshot
  no longer prints "some styles could not be inspected" above the rules -- the
  footer already reports what could not be read -- and what the `:hov` preview
  covers is now what its button says when the pointer rests on it. Both stay
  announced to a screen reader, and a real preview error still takes its line.
- Rules source links now open the preprocessor source for the rules a
  preprocessor actually wrote. Four more spellings are settled before the two
  sides are compared: a shorthand and the sides it sets are read as the same
  four values, so a file's `top/right/bottom/left` matches the browser's
  `inset`, and a `margin-top` written after a `margin` shorthand overrides just
  that side; a bare number matches the pixels a quirks-mode browser made of it;
  and a rule whose declarations a mixin writes is no longer required to declare
  them itself -- the source map and a matching selector and condition identify
  it, and whatever it does declare must still be present in what the browser
  reported. On a production theme every rule of an element now opens its `.scss`
  line rather than stopping at the compiled CSS.
- Restored the hover highlight on pages that move or scale what they show. The
  highlight is drawn from an element's own margin, border and padding widths, so
  it was refused whenever anything on the way to the viewport was transformed --
  which on an ordinary carousel, or a button that grows a little under the
  pointer, meant no highlight at all. A box that is only moved or scaled stays an
  upright rectangle, so it is now drawn with its widths scaled by as much as the
  box was; a `perspective` that projects nothing is no longer read as a
  transform. Anything that turns, skews or mirrors a box still shows nothing
  rather than something misplaced.
- Gave the DOM tree the pointer arrow it should have. Rows are clicked to select
  an element, not typed into, and the text cursor over them said otherwise.
- Made a pick on a large page about three times faster. Selecting an element
  read the same element back many times over -- the path was walked and every
  locator on it rebuilt and re-resolved for each read -- although the page
  cannot change anything while a read holds the thread. Each read now answers
  from the moment it was taken in, re-proving cheaply that the element is still
  where it was and skipping only the walk; any mutation the tree observes ends
  that moment. On a production page a pick fell from about 1.5 seconds to about
  0.4.
- Rules source links now reach the preprocessor source for rules that a
  preprocessor rewrote on the way out. A stylesheet's `'font'` becomes `"font"`
  in the generated CSS, and the rule then verified against the generated file
  but not against its own source, so the link stopped at the CSS. Quoted text
  now reads the same in either quote style, and a value token no longer loses
  the space that follows a closing parenthesis.
- Rules now shows a rule the way it is written. A stylesheet that says
  `margin: 0` holds four longhands in the browser, and Pin-op used to list all
  four: a `*` rule became twenty-five rows and no longer resembled the file it
  came from. Each declaration is now presented as the rule spells it, with the
  longhands it sets kept behind the same disclosure triangle an inspector shows,
  and the cascade is still decided one longhand at a time -- a shorthand is
  struck through only when every longhand it sets has lost.
- Rules source links now find rules written with shorthands, prefixed
  fallbacks, or a property declared twice. The three spellings a stylesheet and
  a browser disagree on are settled before the two sides are compared: the sides
  of a box (`padding: 2em 0` and `padding: 2em 0 2em 0`), the order inside a
  shadow (the browser always writes the colour first), and a repeated property
  (the browser keeps the last, or the important one). A file may also carry the
  prefixed declarations a browser silently discards, such as `-moz-box-sizing`
  beside `box-sizing`; everything the browser did report must still match
  exactly, and the rule must still be the only one in the file that matches.
- Rules source links no longer miss a rule because the stylesheet and the
  browser spelled the same value differently. Colours, zero lengths and number
  forms are settled on one canonical spelling before the two sides are compared,
  so `#0b57d0` and `rgb(11, 87, 208)`, or `0` and `0px`, read as the same
  declaration. A zero percentage is left alone, being a different value.
- Rules now reads as the cascade rather than as the file. Whatever wins sits at
  the top and low-weight rules such as `*` and `:root` sink to the bottom
  wherever they were authored, the way a browser's own inspector presents them;
  a selector whose weight cannot be proven never outranks one that can.
- Made the selected DOM row visible again. Upstream paints a row's selection
  band behind it at `z-index: -1`, which needs every ancestor background to stay
  transparent; the panel paints its own surface, so the band was landing behind
  it and no selection ever showed, in either browser. Each row now carries its
  own stacking context.
- Stopped the DOM tree from moving out from under the pointer. Chromium
  re-centres the row it selects and Pin-op echoed every selection back through
  it, so clicking a row the reader could already see scrolled the tree and the
  next click landed two rows away. A row that is already on screen is now
  selected in place; one that is off screen still scrolls into view.
- Restored DOM tree interaction in Firefox. Chromium's tree calls
  `ShadowRoot.getSelection()`, which only Blink implements, on the first line of
  every click handler; in Gecko that threw and took the handler with it, so a
  row's disclosure arrow never opened it. The shared runtime now installs a
  reviewed Gecko shim before any upstream code runs.
- Kept the panel alive across a suspended extension background. The browser
  unloads an idle background page, and the panel used to answer with cleared DOM
  and Rules panes that only a fresh pick could revive. It now freezes what it was
  showing and restores the same element once the background is back, the
  background waits for a content lease it is still establishing instead of
  reporting a disposed session, and a DOM read that goes unanswered now times
  out instead of hanging forever.

### Security And Privacy

- Kept product traffic on a loopback-only WebSocket with explicit window
  linking and session-only browser credentials and displayed code.
- Kept DOM tree nodes, refs, expansion state, and box-model overlays inside the
  browser. Bounded selection facts go to the linked IDE; only bounded excerpts
  from the active document return, without paths, URIs, or full documents.
- Made cross-origin frames, closed shadow roots, stale node refs, ambiguous CSS
  fingerprints, and unavailable SCSS mappings fail closed.
- Documented that the two-digit PIN is accidental-cross-link protection, not
  strong authentication, and that Pin-op cannot write source or execute
  commands.
- Kept user-authored CSS and DOM editing operations absent. Pseudo preview does
  not call `focus()` or dispatch input, focus, mouse, pointer, or keyboard
  events.
- Documented that random extension-owned marker attributes and temporary
  mirror styles are observable by page scripts while preview is enabled and
  may cause transitions, animations, resource loads, or mutation records.
  Controlled exits remove exact owned artifacts; abrupt extension termination
  can leave them until page navigation or reload.
