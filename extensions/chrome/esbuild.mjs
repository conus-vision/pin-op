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
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const browserBundleResult = await build({
  absWorkingDir: extensionRoot,
  entryPoints: {
    devtools: "src/devtools.ts",
    background: "src/background.ts",
    contentScript: "src/contentScript.ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome116",
  outdir,
  minify: true,
  sourcemap: false,
  metafile: true,
});
const inspectorBuild = await buildBrowserInspectorModules({ extensionRoot, outdir });
const { inspectorPanelResult } = inspectorBuild;
assertNoChromiumUpstreamInputs(
  browserBundleResult.metafile,
  "Chrome browser bundle",
);
assertNoChromiumUpstreamInputs(
  inspectorPanelResult.metafile,
  "Chrome Inspector bootstrap",
);
assertVerifiedNativeInspectorBuild(
  inspectorBuild,
  "Chrome native Chromium Inspector runtime",
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
