# Firefox Source Submission

These instructions reproduce the unsigned Firefox extension from the Browser2IDE 0.3.0 source ZIP submitted to Mozilla. Run them from the extracted ZIP root on a clean system.

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
corepack pnpm --filter browser2ide-firefox run build
```

The version command must print `9.15.0`. The build output is written to `extensions/firefox/dist/` and contains `background.js`, `contentScript.js`, `devtools.html`, `devtools.js`, `panel.html`, `panel.js`, `panel.css`, and `browser2ide.svg`.

## Create The Submission ZIP

```sh
corepack pnpm --filter browser2ide-firefox run package
```

The unsigned extension is written to `artifacts/browser2ide-firefox-0.3.0.zip`. The package command repeats the Firefox build before invoking the repository-pinned `web-ext@10.4.0` with its source and test exclusions.

## Reproducibility And Review Notes

The build does not download generated code. After the frozen install, it reads only files in this source tree and dependencies fixed by `pnpm-lock.yaml`. TypeScript is type-checked, and esbuild bundles and minifies the four TypeScript entry points using the target `firefox142`. The package contents receive a fixed ZIP-safe timestamp before `web-ext` creates the archive.

The release source ZIP is produced by `git archive HEAD` with a command-local `core.autocrlf=false`. This keeps every archived regular file byte-identical to its Git blob on Windows and Linux without changing the user's Git configuration. The release verifier requires the ZIP path set to match the complete `HEAD` tree, rejects unsupported Git modes, and compares every archived file with its `HEAD` blob.

Source maps are intentionally not generated or shipped because the complete TypeScript sources for the Firefox adapter, shared browser core, and protocol are present in the source ZIP. `tools/browser-bundle-notices.mjs` reads esbuild's actual bundle-input metadata and the installed packages' manifests and license files to regenerate `extensions/firefox/THIRD_PARTY_NOTICES`; no hand-maintained dependency list is used. The exact Browser2IDE MIT license is included as `extensions/firefox/LICENSE`.
