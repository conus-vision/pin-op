import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PROTOCOL_VERSION } from "@pin-op/protocol";
import {
  normalizeBrowserPackageTimestamps,
  writeBrowserBundleNotices,
  writeBrowserProjectLicense,
} from "../../tools/browser-bundle-notices.mjs";
import {
  assertNoChromiumUpstreamInputs,
  assertVerifiedNativeInspectorBuild,
  copyBrowserPanelAssets,
} from "../../tools/browser-panel-assets.mjs";
import {
  buildBrowserInspectorModules,
  mergeBrowserBundleMetafiles,
} from "../../tools/browser-elements-runtime.mjs";
import {
  RUNTIME_METADATA_FILENAME,
  serializeRuntimeMetadata,
} from "../../tools/runtime-metadata.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(extensionRoot, "dist");
const panelVariant = process.env.PIN_OP_PANEL_VARIANT;
if (
  panelVariant !== undefined &&
  panelVariant !== "legacy" &&
  panelVariant !== "inspector"
) {
  throw new Error("PIN_OP_PANEL_VARIANT must be legacy or inspector");
}
const panelPage = panelVariant === "legacy"
  ? "/dist/panel.html"
  : "/dist/inspector-panel.html";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const browserBundleResult = await build({
  absWorkingDir: extensionRoot,
  entryPoints: {
    devtools: "src/devtools.ts",
    panel: "src/panel.ts",
    background: "src/background.ts",
    contentScript: "src/contentScript.ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "firefox142",
  outdir,
  minify: true,
  sourcemap: false,
  metafile: true,
  define: {
    __PIN_OP_PANEL_PAGE__: JSON.stringify(panelPage),
  },
});
const inspectorBuild = await buildBrowserInspectorModules({ extensionRoot, outdir });
const { inspectorPanelResult } = inspectorBuild;
assertNoChromiumUpstreamInputs(
  browserBundleResult.metafile,
  "Firefox browser bundle",
);
assertNoChromiumUpstreamInputs(
  inspectorPanelResult.metafile,
  "Firefox Inspector bootstrap",
);
assertVerifiedNativeInspectorBuild(
  inspectorBuild,
  "Firefox native Chromium Inspector runtime",
);
const combinedMetafile = mergeBrowserBundleMetafiles(
  browserBundleResult.metafile,
  inspectorBuild.inspectorRuntimeResult.metafile,
);

await copyFile(resolve(extensionRoot, "src/devtools.html"), resolve(outdir, "devtools.html"));
await copyBrowserPanelAssets(extensionRoot);

await writeFile(
  resolve(outdir, RUNTIME_METADATA_FILENAME),
  serializeRuntimeMetadata(PROTOCOL_VERSION),
  "utf8",
);

await writeBrowserProjectLicense(extensionRoot);
await writeBrowserBundleNotices(combinedMetafile, extensionRoot, {
  metafileSources: [
    { metafile: browserBundleResult.metafile, absWorkingDir: extensionRoot },
    {
      metafile: inspectorBuild.inspectorRuntimeResult.metafile,
      absWorkingDir: resolve(extensionRoot, "../.."),
    },
  ],
});
await normalizeBrowserPackageTimestamps(extensionRoot);
