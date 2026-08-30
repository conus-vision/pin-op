import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { build } from "esbuild";

import {
  createChromiumSharedRuntimePlugins,
  prepareChromiumReadOnlyElementsBuild,
} from "./chromium-devtools-runtime.mjs";
import {
  prepareChromiumReadOnlyStylesBuild,
} from "./chromium-devtools-styles-runtime.mjs";

export const CHROMIUM_ELEMENTS_RUNTIME_FILENAME =
  "chromiumElementsRuntime.js";
export const CHROMIUM_ELEMENTS_RUNTIME_IMPORT =
  `./${CHROMIUM_ELEMENTS_RUNTIME_FILENAME}`;
export const ELEMENTS_RUNTIME_PACKAGE_IMPORT =
  "@pin-op/devtools-elements-ui/upstream-runtime";
export const CHROMIUM_INSPECTOR_ADAPTER_IMPORT =
  "@pin-op/devtools-elements-ui/chromium-adapter";
export const BROWSER_INSPECTOR_TARGETS = Object.freeze([
  "chrome116",
  "firefox142",
]);
export const CHROMIUM_INSPECTOR_RUNTIME = Object.freeze({
  browserTargets: BROWSER_INSPECTOR_TARGETS,
  maxMinifiedBytes: 2 * 1024 * 1024,
});

const INSPECTOR_PANEL_FILENAME = "inspectorPanel.js";
const CHROMIUM_INSPECTOR_ENTRY = "tools/browser-chromium-inspector-entry.ts";
const ELEMENTS_RUNTIME_IMPORT_FILTER =
  /^@pin-op\/devtools-elements-ui\/upstream-runtime$/;
const CHROMIUM_INSPECTOR_ADAPTER_IMPORT_FILTER =
  /^@pin-op\/devtools-elements-ui\/chromium-adapter$/;
const REVIEWED_LOCAL_RUNTIME_INPUTS = Object.freeze([
  CHROMIUM_INSPECTOR_ENTRY,
  "packages/devtools-elements-ui/dist/chromium/upstream/GeckoDomCompatibility.js",
  "packages/devtools-elements-ui/dist/chromium/upstream/PinOpChromiumInspectorAdapter.js",
  "packages/devtools-elements-ui/dist/chromium/upstream/PinOpElementsTreeAdapter.js",
  "packages/devtools-elements-ui/dist/chromium/upstream/PinOpStylesSidebarAdapter.js",
  "packages/devtools-elements-ui/dist/elementsInspectorShell.js",
  "packages/devtools-elements-ui/dist/pseudoStateController.js",
]);
const FORBIDDEN_LOCAL_RUNTIME_INPUTS = Object.freeze([
  "packages/devtools-elements-ui/dist/elementsInspectorView.js",
  "packages/devtools-elements-ui/dist/upstreamRuntime.js",
  "packages/devtools-elements-ui/dist/chromium/dom/",
  "packages/devtools-elements-ui/dist/chromium/rules/",
]);
const REVIEWED_PRUNED_OWNER_CAPABILITIES = Object.freeze({
  input:
  "third_party/chromium-devtools-frontend/patches/1.0.1681091/facades/issues.ts",
  sha256: "87a278e4e1266e15f085e6ae6e7fdc651782a32e70f66a8fabf256f7eb53cf85",
  ownerOutput: "chromiumElementsAnalysis.js",
  bytesInOutput: 61,
  reason: "Pin-op does not expose Chromium Issues capability",
});

/**
 * Emits the Inspector bootstrap and its native Chromium runtime in one esbuild
 * invocation. The bootstrap keeps one static relative import; the runtime is a
 * closed ESM bundle with no output imports or raw Chromium authority exports.
 */
export async function buildBrowserInspectorModules({ extensionRoot, outdir }) {
  const physicalExtensionRoot = await realpath(extensionRoot);
  const repositoryRoot = await resolveRepositoryRoot(physicalExtensionRoot);
  const extensionRelative = normalizePath(
    path.relative(repositoryRoot, physicalExtensionRoot),
  );
  if (extensionRelative !== "extensions/chrome" &&
      extensionRelative !== "extensions/firefox") {
    throw new Error(
      `Browser Inspector extension root is not reviewed: ${extensionRelative}`,
    );
  }

  const [elementsBuild, stylesBuild] = await Promise.all([
    prepareChromiumReadOnlyElementsBuild(repositoryRoot),
    prepareChromiumReadOnlyStylesBuild(repositoryRoot),
  ]);
  assertExactTargets(elementsBuild.browserTargets, "Chromium Elements");
  assertExactTargets(stylesBuild.browserTargets, "Chromium Styles");

  const sharedImporterPaths = Object.freeze(new Set([
    ...elementsBuild.sharedImporterPaths,
    ...stylesBuild.sharedImporterPaths,
  ]));
  const unionSharedRuntime = await createChromiumSharedRuntimePlugins({
    packageRoot: stylesBuild.packageRoot,
    allowedImporters: sharedImporterPaths,
  });
  const elementsScopedPlugins = elementsBuild.createScopedPlugins(unionSharedRuntime);
  const stylesScopedPlugins = stylesBuild.createScopedPlugins(unionSharedRuntime);
  const reverseOwnerOrder = extensionRelative === "extensions/firefox";
  const ownerPluginGroups = reverseOwnerOrder
    ? [stylesScopedPlugins, elementsScopedPlugins]
    : [elementsScopedPlugins, stylesScopedPlugins];
  const nativePlugins = Object.freeze([
    ...ownerPluginGroups.flat(),
    ...unionSharedRuntime.plugins,
  ]);

  const analysisResult = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: {
      chromiumElementsAnalysis: elementsBuild.entryPoint,
      chromiumStylesAnalysis: stylesBuild.entryPoint,
    },
    entryNames: "[name]",
    outdir: path.join(repositoryRoot, "out", "chromium-inspector-analysis"),
    bundle: true,
    splitting: false,
    platform: "browser",
    format: "esm",
    target: BROWSER_INSPECTOR_TARGETS,
    treeShaking: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: nativePlugins,
  });
  const [elementsVerification, stylesVerification] = await Promise.all([
    elementsBuild.verifyBuild(analysisResult, unionSharedRuntime),
    stylesBuild.verifyBuild(analysisResult, unionSharedRuntime),
  ]);

  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: {
      inspectorPanel: path.join(physicalExtensionRoot, "src", "inspectorPanel.ts"),
      chromiumElementsRuntime: path.join(repositoryRoot, CHROMIUM_INSPECTOR_ENTRY),
    },
    entryNames: "[name]",
    outdir: path.resolve(outdir),
    bundle: true,
    splitting: false,
    platform: "browser",
    format: "esm",
    target: BROWSER_INSPECTOR_TARGETS,
    treeShaking: true,
    minify: true,
    sourcemap: false,
    metafile: true,
    write: true,
    logLevel: "silent",
    plugins: [
      externalElementsRuntimePlugin(physicalExtensionRoot),
      exactChromiumInspectorAdapterPlugin(repositoryRoot),
      ...nativePlugins,
    ],
  });

  assertExactBrowserOutputs(Object.keys(result.metafile?.outputs ?? {}));

  const inspectorPanelResult = resultForOutput(result, INSPECTOR_PANEL_FILENAME);
  const elementsRuntimeResult = resultForOutput(
    result,
    CHROMIUM_ELEMENTS_RUNTIME_FILENAME,
  );
  const runtimeVerification = await verifyUnifiedInspectorRuntime({
    repositoryRoot,
    result: elementsRuntimeResult,
    analysisResult,
    elementsVerification,
    stylesVerification,
    pluginOrder: reverseOwnerOrder
      ? Object.freeze(["styles", "elements"])
      : Object.freeze(["elements", "styles"]),
  });

  return Object.freeze({
    inspectorRuntimeResult: result,
    analysisResult,
    inspectorPanelResult,
    elementsRuntimeResult,
    runtimeVerification,
  });
}

export function mergeBrowserBundleMetafiles(...metafiles) {
  const merged = { inputs: {}, outputs: {} };
  const normalizedInputs = new Map();
  const normalizedOutputs = new Map();
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
    mergeMetafileEntries(
      merged.inputs,
      metafile.inputs,
      normalizedInputs,
      "input",
    );
    mergeMetafileEntries(
      merged.outputs,
      metafile.outputs,
      normalizedOutputs,
      "output",
    );
  }
  return merged;
}

function mergeMetafileEntries(target, source, normalizedKeys, kind) {
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizePath(key);
    const previous = normalizedKeys.get(normalized);
    if (Object.hasOwn(target, key) || previous !== undefined) {
      const previousKey = previous ?? key;
      if (kind === "input" && normalized.startsWith("(disabled):") &&
          JSON.stringify(target[previousKey]) === JSON.stringify(value)) {
        continue;
      }
      throw new Error(
        `Cannot merge esbuild metafile ${kind} collision: ${previous ?? key} and ${key}`,
      );
    }
    normalizedKeys.set(normalized, key);
    target[key] = value;
  }
}

async function resolveRepositoryRoot(extensionRoot) {
  const candidate = await realpath(path.resolve(extensionRoot, "..", ".."));
  const extensionRelative = path.relative(candidate, extensionRoot);
  if (
    extensionRelative === "" ||
    extensionRelative === ".." ||
    extensionRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(extensionRelative)
  ) {
    throw new Error("Browser Inspector extension root is outside its repository");
  }
  return candidate;
}

function assertExactTargets(targets, description) {
  if (
    !Array.isArray(targets) ||
    targets.length !== BROWSER_INSPECTOR_TARGETS.length ||
    targets.some((target, index) => target !== BROWSER_INSPECTOR_TARGETS[index])
  ) {
    throw new Error(`${description} browser targets do not match the Inspector`);
  }
}

function externalElementsRuntimePlugin(extensionRoot) {
  const inspectorEntry = path.join(extensionRoot, "src", "inspectorPanel.ts");
  return {
    name: "external-native-chromium-inspector-runtime",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: ELEMENTS_RUNTIME_IMPORT_FILTER },
        args => {
          if (path.resolve(args.importer) !== inspectorEntry) {
            throw new Error(
              `Unreviewed browser runtime importer: ${args.importer}`,
            );
          }
          return {
            path: CHROMIUM_ELEMENTS_RUNTIME_IMPORT,
            external: true,
          };
        },
      );
    },
  };
}

function exactChromiumInspectorAdapterPlugin(repositoryRoot) {
  const inspectorEntry = path.join(repositoryRoot, CHROMIUM_INSPECTOR_ENTRY);
  const adapterEntry = path.join(
    repositoryRoot,
    "packages",
    "devtools-elements-ui",
    "dist",
    "chromium",
    "upstream",
    "PinOpChromiumInspectorAdapter.js",
  );
  return {
    name: "exact-pin-op-chromium-inspector-adapter",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: CHROMIUM_INSPECTOR_ADAPTER_IMPORT_FILTER },
        args => {
          if (path.resolve(args.importer) !== inspectorEntry) {
            throw new Error(
              `Unreviewed Chromium Inspector adapter importer: ${args.importer}`,
            );
          }
          return { path: adapterEntry };
        },
      );
    },
  };
}

function resultForOutput(result, filename) {
  const matches = Object.entries(result.metafile?.outputs ?? {}).filter(
    ([output]) => normalizePath(output).endsWith(`/${filename}`) ||
      normalizePath(output) === filename,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Browser Inspector build must emit exactly one ${filename}; found ${matches.length}`,
    );
  }
  const [outputPath, output] = matches[0];
  const inputKeys = Object.keys(output.inputs ?? {}).sort();
  if (inputKeys.length === 0) {
    throw new Error(`${filename} output has no emitted input closure`);
  }
  const inputs = Object.fromEntries(inputKeys.map(input => {
    const metadata = result.metafile.inputs[input];
    if (!metadata) {
      throw new Error(`${filename} output references an absent input: ${input}`);
    }
    return [input, metadata];
  }));
  return Object.freeze({
    ...result,
    metafile: Object.freeze({
      inputs: Object.freeze(inputs),
      outputs: Object.freeze({ [outputPath]: output }),
    }),
  });
}

async function verifyUnifiedInspectorRuntime({
  repositoryRoot,
  result,
  analysisResult,
  elementsVerification,
  stylesVerification,
  pluginOrder,
}) {
  const [[, output]] = Object.entries(result.metafile.outputs);
  if (
    !output ||
    !Array.isArray(output.exports) ||
    output.exports.length !== 1 ||
    output.exports[0] !== "createElementsInspectorView"
  ) {
    throw new Error(
      "Native Chromium Inspector runtime must export only createElementsInspectorView",
    );
  }
  if (!Array.isArray(output.imports) || output.imports.length !== 0) {
    throw new Error("Native Chromium Inspector runtime must have zero output imports");
  }
  if (!Number.isSafeInteger(output.bytes) ||
      output.bytes > CHROMIUM_INSPECTOR_RUNTIME.maxMinifiedBytes) {
    throw new Error(
      `Native Chromium Inspector runtime exceeds ${CHROMIUM_INSPECTOR_RUNTIME.maxMinifiedBytes} minified bytes: ${output.bytes}`,
    );
  }

  const runtimeInputKeys = Object.keys(result.metafile.inputs);
  const reviewedChromiumInputs = new Set([
    ...verifiedInputKeys(elementsVerification, "Chromium Elements"),
    ...verifiedInputKeys(stylesVerification, "Chromium Styles"),
  ]);
  const localInputs = new Map();
  for (const input of runtimeInputKeys) {
    const normalized = normalizePath(input);
    if (FORBIDDEN_LOCAL_RUNTIME_INPUTS.some(forbidden =>
      normalized.includes(forbidden))) {
      throw new Error(`Native Chromium Inspector includes forbidden input: ${input}`);
    }
    if (reviewedChromiumInputs.has(input)) continue;
    const relative = await repositoryRelativeInput(repositoryRoot, input);
    if (!relative || !REVIEWED_LOCAL_RUNTIME_INPUTS.includes(relative)) {
      throw new Error(
        `Native Chromium Inspector includes an unreviewed local input: ${input}`,
      );
    }
    if (localInputs.has(relative)) {
      throw new Error(`Native Chromium Inspector input is ambiguous: ${relative}`);
    }
    localInputs.set(relative, input);
  }
  for (const expected of REVIEWED_LOCAL_RUNTIME_INPUTS) {
    if (!localInputs.has(expected)) {
      throw new Error(`Native Chromium Inspector input is missing: ${expected}`);
    }
  }

  const prunedOwnerCapabilityEvidence = {};
  for (const input of reviewedChromiumInputs) {
    if (runtimeInputKeys.includes(input)) continue;
    const contributions = Object.entries(analysisResult.metafile.outputs).flatMap(([outputPath, output]) =>
      Object.hasOwn(output.inputs ?? {}, input)
        ? [{ownerOutput: normalizePath(outputPath).split("/").at(-1), bytesInOutput: output.inputs[input].bytesInOutput}]
        : []);
    const relative = await repositoryRelativeInput(repositoryRoot, input);
    const contents = relative ? await readFile(path.join(repositoryRoot, relative)) : undefined;
    prunedOwnerCapabilityEvidence[input] = {
      contributions,
      relative,
      sha256: contents && createHash("sha256").update(contents).digest("hex"),
    };
  }
  const ownerClosure = verifyUnifiedOwnerInputClosure({
    runtimeInputKeys,
    reviewedOwnerInputKeys: [...reviewedChromiumInputs],
    localInputKeys: [...localInputs.values()],
    prunedOwnerCapabilityEvidence,
  });
  const survivingOwnerInputKeys = ownerClosure.reviewedOwnerInputKeys.filter(
    input => !ownerClosure.prunedOwnerCapabilityInputKeys.includes(input),
  );
  const analysisResolutionEdgeSignature = resolutionEdgeSignature(
    analysisResult.metafile, survivingOwnerInputKeys,
  );
  const finalResolutionEdgeSignature = resolutionEdgeSignature(
    result.metafile, survivingOwnerInputKeys,
  );
  if (analysisResolutionEdgeSignature !== finalResolutionEdgeSignature) {
    throw new Error("Native Chromium Inspector surviving owner resolution edges changed");
  }

  const outputPath = Object.keys(result.metafile.outputs)[0];
  const actualMinifiedBytes = (await readFile(
    path.resolve(repositoryRoot, outputPath),
  )).byteLength;
  verifyRuntimeBytes(output.bytes, actualMinifiedBytes);

  return Object.freeze({
    minifiedBytes: actualMinifiedBytes,
    verifiedInputKeys: Object.freeze([...runtimeInputKeys].sort()),
    localInputKeys: Object.freeze([...localInputs.values()].sort()),
    reviewedOwnerInputKeys: ownerClosure.reviewedOwnerInputKeys,
    prunedOwnerCapabilityInputKeys: ownerClosure.prunedOwnerCapabilityInputKeys,
    prunedOwnerCapabilityAttestation: ownerClosure.prunedOwnerCapabilityAttestation,
    resolutionEdgeSignature: finalResolutionEdgeSignature,
    elements: elementsVerification,
    styles: stylesVerification,
    pluginOrder,
  });
}

export function assertExactBrowserOutputs(outputPaths) {
  const names = outputPaths.map(output => normalizePath(output).split("/").at(-1)).sort();
  if (names.length !== 2 || names[0] !== CHROMIUM_ELEMENTS_RUNTIME_FILENAME ||
      names[1] !== INSPECTOR_PANEL_FILENAME) {
    throw new Error(`Browser Inspector build has an unexpected output inventory: ${names.join(", ")}`);
  }
}

export function verifyRuntimeBytes(metafileBytes, actualBytes) {
  if (!Number.isSafeInteger(metafileBytes) || !Number.isSafeInteger(actualBytes) ||
      metafileBytes !== actualBytes) {
    throw new Error(
      `Native Chromium Inspector metafile byte count is not truthful: ${metafileBytes} != ${actualBytes}`,
    );
  }
}

export function verifyUnifiedOwnerInputClosure({
  runtimeInputKeys,
  reviewedOwnerInputKeys,
  localInputKeys,
  prunedOwnerCapabilityEvidence = {},
}) {
  assertCanonicalInventory(runtimeInputKeys, "runtime");
  assertCanonicalInventory(reviewedOwnerInputKeys, "reviewed owner");
  assertCanonicalInventory(localInputKeys, "local");
  const crossInventoryAliases = new Map();
  for (const input of [...runtimeInputKeys, ...reviewedOwnerInputKeys, ...localInputKeys]) {
    const canonical = canonicalLogicalInput(input);
    const prior = crossInventoryAliases.get(canonical);
    if (prior !== undefined && prior !== input) {
      throw new Error(`Native Chromium Inspector cross-inventory alias collision: ${prior} and ${input}`);
    }
    crossInventoryAliases.set(canonical, input);
  }
  const runtime = new Set(runtimeInputKeys);
  const reviewed = new Set(reviewedOwnerInputKeys);
  const locals = new Set(localInputKeys);
  if (runtime.size !== runtimeInputKeys.length || reviewed.size !== reviewedOwnerInputKeys.length ||
      locals.size !== localInputKeys.length) {
    throw new Error("Native Chromium Inspector input inventory contains a collision");
  }
  const unexpected = [...runtime].filter(input => !reviewed.has(input) && !locals.has(input));
  if (unexpected.length > 0) {
    throw new Error(`Native Chromium Inspector has unexpected inputs: ${unexpected.join(", ")}`);
  }
  const absentLocals = [...locals].filter(input => !runtime.has(input));
  if (absentLocals.length > 0) {
    throw new Error(`Native Chromium Inspector is missing local inputs: ${absentLocals.join(", ")}`);
  }
  const prunedOwnerCapabilityInputKeys = [...reviewed].filter(input => !runtime.has(input)).sort();
  if (JSON.stringify(prunedOwnerCapabilityInputKeys) !==
      JSON.stringify([REVIEWED_PRUNED_OWNER_CAPABILITIES.input])) {
    throw new Error(
      `Native Chromium Inspector pruned owner capability delta changed: ${prunedOwnerCapabilityInputKeys.join(", ")}`,
    );
  }
  const ownerSentinels = ["/entrypoints/read-only-elements.ts", "/entrypoints/read-only-styles.ts"];
  if (ownerSentinels.some(sentinel =>
    ![...runtime].some(input => normalizePath(input).endsWith(sentinel)))) {
    throw new Error("Native Chromium Inspector final owner closure is missing a production entry sentinel");
  }
  const payloadRows = prunedOwnerCapabilityInputKeys.map(input => {
    const evidence = prunedOwnerCapabilityEvidence[input];
    if (!evidence || evidence.relative !== input ||
        evidence.sha256 !== REVIEWED_PRUNED_OWNER_CAPABILITIES.sha256 ||
        !Array.isArray(evidence.contributions) || evidence.contributions.length !== 1 ||
        evidence.contributions[0]?.ownerOutput !== REVIEWED_PRUNED_OWNER_CAPABILITIES.ownerOutput ||
        evidence.contributions[0]?.bytesInOutput !== REVIEWED_PRUNED_OWNER_CAPABILITIES.bytesInOutput) {
      throw new Error(`Native Chromium Inspector pruned owner capability evidence changed: ${input}`);
    }
    return `${input}\0${evidence.sha256}`;
  });
  const payload = `${payloadRows.join("\n")}\n`;
  return Object.freeze({
    reviewedOwnerInputKeys: Object.freeze([...reviewed].sort()),
    prunedOwnerCapabilityInputKeys: Object.freeze(prunedOwnerCapabilityInputKeys),
    prunedOwnerCapabilityAttestation: Object.freeze({
      fileCount: prunedOwnerCapabilityInputKeys.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      reason: REVIEWED_PRUNED_OWNER_CAPABILITIES.reason,
    }),
  });
}

function resolutionEdgeSignature(metafile, inputKeys) {
  const rows = [];
  for (const input of [...inputKeys].sort()) {
    const metadata = metafile.inputs?.[input];
    if (!metadata) throw new Error(`Native Chromium Inspector resolution signature input is missing: ${input}`);
    for (const edge of metadata.imports ?? []) {
      rows.push(`${input}\0${edge.kind ?? ""}\0${normalizePath(edge.path)}\0${Boolean(edge.external)}`);
    }
  }
  return createHash("sha256").update(`${rows.sort().join("\n")}\n`).digest("hex");
}

function assertCanonicalInventory(inputs, description) {
  if (!Array.isArray(inputs) || inputs.some(input => typeof input !== "string" || input.length === 0)) {
    throw new Error(`Native Chromium Inspector ${description} inventory is invalid`);
  }
  const aliases = new Set();
  for (const input of inputs) {
    const canonical = canonicalLogicalInput(input);
    if (aliases.has(canonical)) {
      throw new Error(`Native Chromium Inspector ${description} inventory has an alias collision or escape: ${input}`);
    }
    aliases.add(canonical);
  }
}

function canonicalLogicalInput(input) {
  const normalized = normalizePath(input);
  const lexical = path.posix.normalize(normalized);
  const segments = normalized.split("/");
  const hasInvalidSegment = segments.some((segment, index) =>
    segment === "." || (segment === "" && !(index === 0 && normalized.startsWith("/"))) ||
    (segment !== ".." && (segment.endsWith(".") || segment.endsWith(" "))));
  if (lexical !== normalized || hasInvalidSegment) {
    throw new Error(`Native Chromium Inspector input is not lexically canonical: ${input}`);
  }
  return lexical.toLowerCase();
}

function verifiedInputKeys(verification, description) {
  if (!Array.isArray(verification?.verifiedInputKeys) ||
      verification.verifiedInputKeys.some(input => typeof input !== "string")) {
    throw new Error(`${description} verification has no exact input inventory`);
  }
  return verification.verifiedInputKeys;
}

async function repositoryRelativeInput(repositoryRoot, input) {
  if (/^[A-Za-z0-9_-]+:/.test(input) && !path.isAbsolute(input)) return null;
  let physicalInput;
  try {
    physicalInput = await realpath(path.resolve(repositoryRoot, input));
  } catch {
    return null;
  }
  const relative = path.relative(repositoryRoot, physicalInput);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return normalizePath(relative);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}
