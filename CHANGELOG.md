# Changelog

All notable changes to Browser2IDE will be documented in this file.

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

### Changed

- Advanced the product release to `0.3.0` while keeping the wire protocol at
  version `4`.
- Added targeted resolution replies and IDE peer-state updates to protocol
  version `4`; there is no protocol-v3 compatibility branch.
- Replaced the old linked-panel actions with one **Disconnect** action that
  unlinks only the current browser window.
- Kept Firefox Stable and current Chrome/Chromium on the shared Inspector
  behavior and read-only resolution path.

### Security And Privacy

- Kept product traffic on a loopback-only WebSocket with explicit window
  linking and session-only browser credentials and displayed code.
- Kept DOM tree nodes, refs, expansion state, and box-model overlays inside the
  browser; only bounded selection facts are sent to the linked IDE.
- Made cross-origin frames, closed shadow roots, stale node refs, ambiguous CSS
  fingerprints, and unavailable SCSS mappings fail closed.
- Documented that the two-digit PIN is accidental-cross-link protection, not
  strong authentication, and that Browser2IDE cannot write source or execute
  commands.
