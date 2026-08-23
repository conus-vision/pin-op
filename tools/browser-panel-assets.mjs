import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CORE_ASSET_ROOT = "../../packages/browser-extension-core/assets";
const ELEMENTS_ASSET_ROOT = "../../packages/devtools-elements-ui/assets";

const ASSETS = Object.freeze([
  Object.freeze({ path: "panel.html", source: `${CORE_ASSET_ROOT}/panel.html` }),
  Object.freeze({
    path: "inspector-panel.html",
    source: `${CORE_ASSET_ROOT}/inspector-panel.html`,
  }),
  Object.freeze({ path: "panel.css", source: `${CORE_ASSET_ROOT}/panel.css` }),
  Object.freeze({
    path: "devtools-elements.css",
    source: `${ELEMENTS_ASSET_ROOT}/devtools-elements.css`,
  }),
  Object.freeze({ path: "pin-op.svg", source: `${CORE_ASSET_ROOT}/pin-op.svg` }),
  ...[16, 32, 48, 96, 128].map((size) => Object.freeze({
    path: `icons/pin-op-${size}.png`,
    source: `${CORE_ASSET_ROOT}/icons/pin-op-${size}.png`,
  })),
]);

export const BROWSER_PANEL_ASSET_PATHS = Object.freeze(
  ASSETS.map(({ path }) => path),
);

export function assertNoChromiumUpstreamInputs(metafile, label = "browser bundle") {
  if (
    !metafile ||
    typeof metafile !== "object" ||
    !metafile.inputs ||
    typeof metafile.inputs !== "object" ||
    Array.isArray(metafile.inputs)
  ) {
    throw new Error(`${label} has invalid esbuild metafile inputs`);
  }
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/");
    if (
      /(?:^|\/)third_party\/chromium-devtools-frontend\/upstream(?:\/|$)/i.test(
        normalized,
      )
    ) {
      throw new Error(`${label} contains Chromium upstream snapshot input ${input}`);
    }
  }
}

export async function copyBrowserPanelAssets(extensionRoot) {
  const outdir = resolve(extensionRoot, "dist");
  for (const asset of ASSETS) {
    const destination = resolve(outdir, asset.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(extensionRoot, asset.source), destination);
  }
}
