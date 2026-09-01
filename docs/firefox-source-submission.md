# Firefox Source Submission

These instructions reproduce the unsigned Firefox extension from the Pin-op 0.4.0 source ZIP, `pin-op-firefox-source-0.4.0.zip`, submitted to Mozilla. Run them from the extracted ZIP root on a clean system.

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

The version command must print `9.15.0`. The build output is written to `extensions/firefox/dist/`; it registers the shared BSD-licensed native Chromium read-only Inspector by default and contains the panel entrypoint, the Inspector bundles, the byte-identical Chrome/Firefox native runtime, the core and scoped stylesheets, `pin-op.svg`, and the `icons/pin-op-*.png` extension icons. The frozen install supplies `chrome-devtools-frontend@1.0.1681091`; `RUNTIME.json` pins its npm integrity and git revision. The pinned source is included through the frozen lockfile and the source archive's exact metadata, DOM patch and Rules overlay trees and manifests, reference `UPSTREAM.json`, Chromium root license, and Pin-op change record. Their attribution and dependent Lit/CodeMirror license texts are generated into `THIRD_PARTY_NOTICES`.

## Create The Submission ZIP

```sh
corepack pnpm --filter pin-op-firefox run package
```

The unsigned extension is written to `artifacts/pin-op-firefox-0.4.0.zip`. The package command repeats the Firefox build before invoking the repository-pinned `web-ext@10.4.0` with its source and test exclusions.

## Reproducibility And Review Notes

The build does not download generated code after the frozen install. It reads only files in this source tree and dependencies fixed by `pnpm-lock.yaml`. TypeScript is type-checked; esbuild bundles and minifies the four extension entrypoints, Inspector bootstrap, and reviewed native Chromium DOM/Rules runtime using the target `firefox142`. The package contents receive a fixed ZIP-safe timestamp before `web-ext` creates the archive.

The release source ZIP is produced by `git archive HEAD` with a command-local `core.autocrlf=false`. This keeps every archived regular file byte-identical to its Git blob on Windows and Linux without changing the user's Git configuration. The release verifier requires the ZIP path set to match the complete `HEAD` tree, rejects unsupported Git modes, and compares every archived file with its `HEAD` blob.

Source maps are intentionally not generated or shipped because the complete TypeScript sources for the Firefox adapter, shared browser core, protocol, and every Pin-op native-runtime overlay are present in the source ZIP; the pinned npm sources are restored exactly by the frozen lockfile. The verifier explicitly requires `RUNTIME.json`, both overlay manifests and every file they enumerate, all native runtime adapters/builders/entrypoints/smokes/tests, `package.json`, `pnpm-lock.yaml`, the pinned `UPSTREAM.json`, Chromium root license, all ten reference snapshot files, embedded notice inventory, `PIN_OP_CHANGES.md`, and the vendor, update, verification, notice, and panel-asset tools needed to reproduce the build. It pins the exact Chromium package version, git revision, and integrity allowed in `RUNTIME.json`, then binds the version and integrity to the root dependency and its sole pnpm importer/package/snapshot entries. No wildcard is used to define this release inventory.

`tools/browser-bundle-notices.mjs` reads esbuild's actual bundle-input metadata and the installed packages' manifests and license files to regenerate `extensions/firefox/THIRD_PARTY_NOTICES`. It verifies and records the exact `RUNTIME.json`, DOM patch manifest, Rules overlay manifest, npm/overlay/image input inventories, package integrity/git revision, required license digests and texts, Chromium root BSD license, and all nine distinct embedded reference notices. Chrome and Firefox must contain byte-identical generated notice inventories, native runtime JavaScript, and scoped UI CSS. The exact Pin-op MIT license is included as `extensions/firefox/LICENSE`.
