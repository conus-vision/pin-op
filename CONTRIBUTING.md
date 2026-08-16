# Contributing To Pin-op

Thank you for contributing. Pin-op is an alpha, so changes should preserve
the explicit browser-window link, read-only protocol, and local trust boundary.

## Prerequisites

- Node.js 22
- Corepack
- Git
- Firefox Stable 142+ and/or Chrome/Chromium 116+ for browser validation
- Local VS Code for integration tests

Enable Corepack and install the locked workspace dependencies:

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
```

## Development Workflow

Use test-driven development: add or update a failing test, make the smallest
implementation change that passes it, then refactor while the suite remains
green. Keep changes focused and include tests at the closest useful boundary.

Run each repository gate separately before opening a pull request.

Build:

```powershell
corepack pnpm build
```

Unit tests:

```powershell
corepack pnpm test
```

VS Code integration tests:

```powershell
corepack pnpm test:integration
```

Type checking:

```powershell
corepack pnpm typecheck
```

Linting:

```powershell
corepack pnpm lint
```

Firefox manifest and package validation with `web-ext`:

```powershell
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

## Commits And Pull Requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages, such as `fix(bridge): reject expired links` or
`docs: clarify browser permissions`. Describe behavior changes, testing, and
security or privacy effects in the pull request.

Do not commit credentials, signing keys, tokens, private test data, or other
secrets. Use local environment variables or repository secret storage where a
workflow requires credentials.

## Source Plugins

Read the [source plugin authoring guide](docs/source-plugin-authoring.md) before
adding or changing a source plugin. Keep plugin matching document-first,
version the public contract deliberately, and test registration and resolution
through the supported API.

## Reporting Security Problems

Do not disclose an unpatched vulnerability in a public issue. Follow the
private reporting process in [SECURITY.md](SECURITY.md).
