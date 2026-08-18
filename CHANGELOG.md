# Changelog

All notable changes to Pin-op will be documented in this file.

## [0.3.0] - Unreleased

### Added

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
- A responsive DevTools Source pane with bounded active-document excerpts for
  Selected and immediate Parent matches and exact opaque-ID opening in VS Code.
- A tab-local IDE Highlight setting that controls decorations without removing
  resolution, Source presentation, or navigation.

### Changed

- Advanced the product release to `0.3.0` and the exact wire protocol to the
  breaking version `6`.
- Added capability-gated auto-refresh, source-presentation, presentation-
  settings, navigation intents, and repeated navigation-state updates. Protocol
  v5 is closed with code `1002`; there is no adapter or fallback.
- Replaced the old linked-panel actions with one **Disconnect** action that
  unlinks only the current browser window.
- Kept Firefox Stable and current Chrome/Chromium on the shared Inspector
  behavior and read-only resolution path.

### Fixed

- Bound DOM-tree timers to the inspected page window in Firefox, restoring
  content-script startup, the page picker, the DOM tree, and source highlights.

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
