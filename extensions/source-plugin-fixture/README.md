# Pin-op Source Plugin Fixture

This private VS Code extension proves that an extension outside the Pin-op
core can register a `SourcePlugin` and `RefreshClassifier` through public API
version 2. It contributes the `pin-op-fixture` language for `.pin-op-fixture`
files and registers IDs `pin-op.fixture` and `pin-op.fixture.refresh`.

Its manifest depends on the canonical core extension ID
`conus-vision.pin-op`. Activation calls the core extension, compares
its API with `SOURCE_PLUGIN_API_VERSION`, and disposes both registrations with
the fixture extension context.

Build the fixture from the repository root:

```powershell
corepack pnpm --filter pin-op-source-plugin-fixture build
```

Run the real cross-extension test with Node.js 22 or newer:

```powershell
corepack pnpm test:integration
```

The fixture is test infrastructure, not a production source resolver. Copy its
manifest and activation pattern when starting another source plugin, then use
the contract and ecosystem guidance in `docs/source-plugin-authoring.md`.
