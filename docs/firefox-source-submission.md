# Firefox Source Submission

These instructions reproduce the unsigned Firefox extension from the Pin-op 0.3.0 source ZIP, `pin-op-firefox-source-0.3.0.zip`, submitted to Mozilla. Run them from the extracted ZIP root on a clean system.

## Prerequisites

- Node.js 22.x
- Corepack, included with the supported Node.js distribution
- Internet access for the frozen dependency install only

The root `package.json` pins `pnpm@9.15.0` in `packageManager`, and the committed `pnpm-lock.yaml` pins the complete dependency graph.

## Install And Build

```sh
corepack enable
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm --filter pin-op-firefox run build
```

The version command must print `9.15.0`. The build output is written to `extensions/firefox/dist/` and contains both panel entrypoints, the legacy and Inspector bundles, the core and scoped Chromium-derived stylesheets, `pin-op.svg`, and the `icons/pin-op-*.png` extension icons.

## Create The Submission ZIP

```sh
corepack pnpm --filter pin-op-firefox run package
```

The unsigned extension is written to `artifacts/pin-op-firefox-0.3.0.zip`. The package command repeats the Firefox build before invoking the repository-pinned `web-ext@10.4.0` with its source and test exclusions.

## Reproducibility And Review Notes

The build does not download generated code. After the frozen install, it reads only files in this source tree and dependencies fixed by `pnpm-lock.yaml`. TypeScript is type-checked, and esbuild bundles and minifies the five TypeScript entry points using the target `firefox142`. The package contents receive a fixed ZIP-safe timestamp before `web-ext` creates the archive.

The release source ZIP is produced by `git archive HEAD` with a command-local `core.autocrlf=false`. This keeps every archived regular file byte-identical to its Git blob on Windows and Linux without changing the user's Git configuration. The release verifier requires the ZIP path set to match the complete `HEAD` tree, rejects unsupported Git modes, and compares every archived file with its `HEAD` blob.

Source maps are intentionally not generated or shipped because the complete TypeScript sources for the Firefox adapter, shared browser core, protocol, and Chromium-derived view package are present in the source ZIP. The verifier explicitly requires the pinned `UPSTREAM.json`, Chromium root license, all ten upstream snapshot files, embedded notice inventory, `PIN_OP_CHANGES.md`, derivation sources/tests/assets, and the vendor, update, verification, notice, and panel-asset tools needed to reproduce the build.

`tools/browser-bundle-notices.mjs` reads esbuild's actual bundle-input metadata and the installed packages' manifests and license files to regenerate `extensions/firefox/THIRD_PARTY_NOTICES`; it also reads the checked-in Chromium manifest, root BSD license, and all nine distinct embedded notices. Chrome and Firefox must contain byte-identical generated notice inventories and scoped derived UI CSS. The exact Pin-op MIT license is included as `extensions/firefox/LICENSE`.
