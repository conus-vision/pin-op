import { resolve } from "node:path";
import { build } from "esbuild";

export const CHROMIUM_ELEMENTS_RUNTIME_FILENAME =
  "chromiumElementsRuntime.js";
export const CHROMIUM_ELEMENTS_RUNTIME_IMPORT =
  `./${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}`;
export const ELEMENTS_RUNTIME_PACKAGE_IMPORT =
  "@pin-op/devtools-elements-ui/upstream-runtime";
export const BROWSER_INSPECTOR_TARGETS = Object.freeze([
  "chrome116",
  "firefox142",
]);

const ELEMENTS_RUNTIME_IMPORT_FILTER =
  /^@pin-op\/devtools-elements-ui\/upstream-runtime$/;

export async function buildBrowserInspectorModules({ extensionRoot, outdir }) {
  const commonOptions = {
    absWorkingDir: extensionRoot,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: BROWSER_INSPECTOR_TARGETS,
    minify: true,
    sourcemap: false,
    metafile: true,
  };
  const inspectorPanelResult = await build({
    ...commonOptions,
    entryPoints: {
      inspectorPanel: "src/inspectorPanel.ts",
    },
    outdir,
    plugins: [externalElementsRuntimePlugin()],
  });
  const elementsRuntimeResult = await build({
    ...commonOptions,
    entryPoints: [ELEMENTS_RUNTIME_PACKAGE_IMPORT],
    outfile: resolve(outdir, CHROMIUM_ELEMENTS_RUNTIME_FILENAME),
  });

  return { inspectorPanelResult, elementsRuntimeResult };
}

export function mergeBrowserBundleMetafiles(...metafiles) {
  const merged = { inputs: {}, outputs: {} };
  for (const metafile of metafiles) {
    if (
      !metafile ||
      typeof metafile !== "object" ||
      !metafile.inputs ||
      typeof metafile.inputs !== "object" ||
      Array.isArray(metafile.inputs) ||
      !metafile.outputs ||
      typeof metafile.outputs !== "object" ||
      Array.isArray(metafile.outputs)
    ) {
      throw new Error("Cannot merge invalid esbuild metafile");
    }
    Object.assign(merged.inputs, metafile.inputs);
    Object.assign(merged.outputs, metafile.outputs);
  }
  return merged;
}

function externalElementsRuntimePlugin() {
  return {
    name: "external-elements-runtime",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: ELEMENTS_RUNTIME_IMPORT_FILTER },
        () => ({
          path: CHROMIUM_ELEMENTS_RUNTIME_IMPORT,
          external: true,
        }),
      );
    },
  };
}
