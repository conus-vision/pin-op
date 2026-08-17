# Pin-op

[![CI](https://github.com/conus-vision/pin-op/actions/workflows/ci.yml/badge.svg)](https://github.com/conus-vision/pin-op/actions/workflows/ci.yml)

Highlights styles and source code in your IDE for the DOM element selected in
the browser.

[pin-op.conus.vision](https://pin-op.conus.vision) ·
[Repository](https://github.com/conus-vision/pin-op)

> Alpha: product and installation details may change before 1.0.

## Install

The `0.3.0` release is being prepared. A complete GitHub Release will contain
six public assets:

- `pin-op-vscode-0.3.0.vsix`;
- `pin-op-chrome-0.3.0.zip`;
- `pin-op-firefox-0.3.0.zip`, unsigned Mozilla-review input;
- `pin-op-firefox-0.3.0.xpi`, signed by Mozilla;
- `pin-op-firefox-source-0.3.0.zip`, the corresponding source archive;
- `SHA256SUMS`, checksums for the five packaged artifacts.

Use `SHA256SUMS` to verify the downloaded release artifacts before installing
them.

No signed `0.3.0` XPI or public `0.3.0` release is claimed yet. The Firefox ZIP
produced by the build is unsigned review input, not a Firefox Stable add-on.
Follow the [installed artifact guide](docs/installed-verification.md) for
candidate installation and evidence status.

The VS Code extension ID is `conus-vision.pin-op`. Workspace packages use the
`@pin-op/*` scope.

## Use

Normal installed use is terminal-free:

1. Open a local project in VS Code. Pin-op starts automatically.
2. Click the Pin-op status item to copy its five-digit port and two-digit
   PIN.
3. Open the Pin-op DevTools panel in one Firefox or Chrome/Chromium window.
4. Paste the code, select **Link**, and confirm the panel shows the same
   displayed code as VS Code.
5. Keep the intended source document active in VS Code.
6. Select an element with the visual page picker or the lazy DOM tree.
7. Use the highlighted ranges in VS Code or the bounded **Source** excerpts in
   DevTools. A Source excerpt opens its exact range in the active IDE document.

**Disconnect** unlinks only the current browser window. Other browser windows
keep their independent links. The full workflow is in the
[usage guide](docs/mvp-usage.md).

## Inspector

Firefox Stable and current Chrome/Chromium share the same Inspector workflow:

- the page picker draws a noninteractive box-model overlay for margin, border,
  padding, and content;
- the virtualized DOM tree loads children lazily and traverses open shadow roots
  and same-origin frames;
- cross-origin frames are locked leaves, and closed shadow roots fail closed;
- one selection sends bounded CSS and DOM facts for the selected element and
  its immediate parent;
- VS Code can highlight multiple complete ranges, with Selected and Parent
  decorations kept distinct;
- the Source pane shows bounded excerpts from the active IDE document for the
  Selected element and its immediate Parent;
- **Auto Refresh** updates changed styles without a page reload and reloads the
  current tab after changed script or PHP saves; **IDE Highlight** controls
  decorations without disabling resolution or source navigation;
- CSS uses exact source evidence first and a conservative unique CSS fingerprint
  fallback when needed;
- source-mapped SCSS fails closed when generated CSS, mappings, or the active
  source document cannot be identified safely;
- the DevTools footer reports the exact IDE resolution outcome, including
  `No active editor` and source-map failures.

The Inspector is read-only. It does not edit page or workspace source, execute
commands, or switch the active editor.

## Support

| Capability | Status |
| --- | --- |
| Firefox Stable 142+ | Supported |
| Chrome/Chromium 116+ | Supported with feature parity |
| Local VS Code | Supported; opens projects and starts automatically |
| CSS | Supported in the active document |
| Source-mapped SCSS | Supported with a usable inline or external source map |
| Separately installed source plugins | Supported through the versioned plugin API |
| Remote SSH and WSL extension hosts | Not supported |
| Auto Refresh | Supported for changed CSS/preprocessor, script, and PHP saves |
| Source editing and reverse sync | Not supported |

## Architecture

Browser-local DOM node references never cross the product WebSocket. Bounded
selection facts travel to the IDE; bounded active-document source excerpts can
return to the linked browser. Protocol version `6` is a breaking, exact-match
contract for inspection, refresh, source presentation, presentation settings,
and navigation. Protocol v5 is rejected with WebSocket close code `1002`; no
adapter or downgrade fallback exists. Product semver remains independent.

Read the [architecture overview](docs/architecture.md),
[protocol contract](docs/protocol.md), and
[source plugin authoring guide](docs/source-plugin-authoring.md).

## Security And Privacy

Pin-op has no analytics, product HTTP service, or remote Pin-op
backend. Product traffic uses a loopback-only WebSocket after explicit
browser-window linking. The two-digit PIN helps prevent accidental local
cross-linking; it is not strong authentication.

Page URLs, identifiers, permitted attribute values, and CSS facts are bounded
but not content-redacted. Review the [privacy policy](PRIVACY.md),
[security model](docs/security.md), and [security policy](SECURITY.md) before
inspecting sensitive applications.

## Development

Use Node.js 22 and the pinned pnpm version:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for all contributor gates and
[development-host verification](docs/mvp-verification.md) for browser parity
checks.

Report product problems in the
[Pin-op issue tracker](https://github.com/conus-vision/pin-op/issues).

## Status

Pin-op remains an alpha. Public browser-store distribution, remote VS Code
hosts, closed-shadow traversal, cross-origin frame traversal, editing, and
reverse synchronization are outside the current release. See the
[changelog](CHANGELOG.md) for the `0.3.0` release scope.

## License

Pin-op is available under the [MIT License](LICENSE). Copyright (c) 2026
conus-vision.
