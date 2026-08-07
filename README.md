# Browser2IDE

[![CI](https://github.com/conus-vision/Browser2IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/conus-vision/Browser2IDE/actions/workflows/ci.yml)

Highlights source code in the IDE that relates to a DOM element selected in
browser DevTools.

> Alpha: product and installation details may change before 1.0.

## Install

The `0.3.0` release is being prepared. A complete GitHub Release will contain:

- `browser2ide-vscode-0.3.0.vsix`;
- `browser2ide-chrome-0.3.0.zip`;
- `browser2ide-firefox-0.3.0.xpi`, signed by Mozilla.

No signed `0.3.0` XPI or public `0.3.0` release is claimed yet. The Firefox ZIP
produced by the build is unsigned review input, not a Firefox Stable add-on.
Follow the [installed artifact guide](docs/installed-verification.md) for
candidate installation and evidence status.

## Use

Normal installed use is terminal-free:

1. Open a local project in VS Code. Browser2IDE starts automatically.
2. Click the Browser2IDE status item to copy its five-digit port and two-digit
   PIN.
3. Open the Browser2IDE DevTools panel in one Firefox or Chrome/Chromium window.
4. Paste the code, select **Link**, and confirm the panel shows the same
   displayed code as VS Code.
5. Keep the intended CSS or SCSS document active in VS Code.
6. Select an element with the visual page picker or the lazy DOM tree.
7. Read the exact footer outcome in DevTools and the highlighted source ranges
   in VS Code.

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
| Source editing and reverse sync | Not supported |

## Architecture

Browser-local DOM node references never cross the product WebSocket. Only a
bounded selection snapshot travels over the authenticated loopback bridge.
Protocol version `4` adds targeted resolution replies and IDE peer state while
keeping product semver independent.

Read the [architecture overview](docs/architecture.md),
[protocol contract](docs/protocol.md), and
[source plugin authoring guide](docs/source-plugin-authoring.md).

## Security And Privacy

Browser2IDE has no analytics, product HTTP service, or remote Browser2IDE
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

## Status

Browser2IDE remains an alpha. Public browser-store distribution, remote VS Code
hosts, closed-shadow traversal, cross-origin frame traversal, editing, and
reverse synchronization are outside the current release. See the
[changelog](CHANGELOG.md) for the `0.3.0` release scope.

## License

Browser2IDE is available under the [MIT License](LICENSE). Copyright (c) 2026
conus-vision.
