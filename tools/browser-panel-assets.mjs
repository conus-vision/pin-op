import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CORE_ASSET_ROOT = "../../packages/browser-extension-core/assets";
const ELEMENTS_ASSET_ROOT = "../../packages/devtools-elements-ui/assets";

const ASSETS = Object.freeze([
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
      /(?:^|\/)node_modules\/chrome-devtools-frontend(?:\/|$)/i.test(normalized) ||
      /(?:^|\/)third_party\/chromium-devtools-frontend\/(?:upstream(?:\.json)?|patches|styles-overlay)(?:\/|$)/i.test(normalized) ||
      /(?:^|\/)packages\/devtools-elements-ui\/(?:src|dist)\/chromium(?:\/|$)/i.test(normalized) ||
      /(?:^|\/)tools\/browser-chromium-inspector-entry\.[cm]?[jt]s$/i.test(normalized)
    ) {
      throw new Error(`${label} contains native Chromium runtime input ${input}`);
    }
  }
}

export function assertVerifiedNativeInspectorBuild(
  inspectorBuild,
  label = "native Chromium Inspector runtime",
) {
  if (!inspectorBuild || typeof inspectorBuild !== "object") {
    throw new Error(`${label} has no verified build result`);
  }
  const fullMetafile = exactMetafile(
    inspectorBuild.inspectorRuntimeResult?.metafile,
    `${label} full build`,
  );
  const panelMetafile = exactMetafile(
    inspectorBuild.inspectorPanelResult?.metafile,
    `${label} bootstrap`,
  );
  const runtimeMetafile = exactMetafile(
    inspectorBuild.elementsRuntimeResult?.metafile,
    `${label} runtime`,
  );
  const [panelOutputPath] = exactOutput(
    panelMetafile,
    "inspectorPanel.js",
    `${label} bootstrap`,
  );
  const [runtimeOutputPath, runtimeOutput] = exactOutput(
    runtimeMetafile,
    "chromiumElementsRuntime.js",
    `${label} native runtime`,
  );
  const fullOutputPaths = Object.keys(fullMetafile.outputs).sort();
  const expectedOutputPaths = [panelOutputPath, runtimeOutputPath].sort();
  if (
    fullOutputPaths.length !== expectedOutputPaths.length ||
    fullOutputPaths.some((output, index) => output !== expectedOutputPaths[index])
  ) {
    throw new Error(
      `${label} full build must contain exactly Inspector bootstrap and native runtime outputs`,
    );
  }
  if (
    fullMetafile.outputs[panelOutputPath] !== panelMetafile.outputs[panelOutputPath] ||
    fullMetafile.outputs[runtimeOutputPath] !== runtimeOutput
  ) {
    throw new Error(`${label} filtered output metadata is not from the full build`);
  }

  const runtimeExports = denseUniqueArray(
    runtimeOutput.exports,
    `${label} runtime exports`,
    value => typeof value === "string" && value.length > 0,
  );
  if (
    runtimeExports.length !== 1 ||
    runtimeExports[0] !== "createElementsInspectorView"
  ) {
    throw new Error(`${label} must export only createElementsInspectorView`);
  }
  const runtimeImports = denseUniqueArray(
    runtimeOutput.imports,
    `${label} runtime output imports`,
    value => value && typeof value === "object",
    value => `${value.path ?? ""}\0${value.kind ?? ""}\0${value.external ?? false}`,
  );
  if (runtimeImports.length !== 0) {
    throw new Error(`${label} must have zero output imports`);
  }
  if (
    typeof runtimeOutput.entryPoint !== "string" ||
    !/(?:^|\/)tools\/browser-chromium-inspector-entry\.ts$/i.test(
      runtimeOutput.entryPoint.replaceAll("\\", "/"),
    )
  ) {
    throw new Error(`${label} has an unexpected native runtime entry point`);
  }
  if (!Number.isSafeInteger(runtimeOutput.bytes) || runtimeOutput.bytes < 1) {
    throw new Error(`${label} has invalid runtime output bytes`);
  }

  const runtimeInputs = Object.keys(runtimeMetafile.inputs).sort();
  if (runtimeInputs.length === 0) {
    throw new Error(`${label} has no native runtime inputs`);
  }
  const outputInputs = Object.keys(exactObject(
    runtimeOutput.inputs,
    `${label} runtime output inputs`,
  )).sort();
  assertExactStringSet(outputInputs, runtimeInputs, `${label} runtime output input closure`);

  const verification = inspectorBuild.runtimeVerification;
  if (!verification || typeof verification !== "object") {
    throw new Error(`${label} has no runtime verification`);
  }
  const verifiedInputs = denseUniqueStrings(
    verification.verifiedInputKeys,
    `${label} verified runtime inputs`,
  );
  assertExactStringSet(verifiedInputs, runtimeInputs, `${label} verified runtime inputs`);
  if (
    !Number.isSafeInteger(verification.minifiedBytes) ||
    verification.minifiedBytes !== runtimeOutput.bytes
  ) {
    throw new Error(`${label} runtime byte attestation does not match its sole output`);
  }

  const elementsInputs = denseUniqueStrings(
    verification.elements?.verifiedInputKeys,
    `${label} Elements inputs`,
  );
  const stylesInputs = denseUniqueStrings(
    verification.styles?.verifiedInputKeys,
    `${label} Styles inputs`,
  );
  const localInputs = denseUniqueStrings(
    verification.localInputKeys,
    `${label} local adapter inputs`,
  );
  if (elementsInputs.length === 0 || stylesInputs.length === 0 || localInputs.length === 0) {
    throw new Error(`${label} exact union has an empty input owner`);
  }
  const reviewedOwnerInputs = denseUniqueStrings(
    verification.reviewedOwnerInputKeys,
    `${label} reviewed owner inputs`,
  );
  assertExactStringSet(
    [...new Set([...elementsInputs, ...stylesInputs])].sort(),
    reviewedOwnerInputs,
    `${label} reviewed owner union`,
  );
  const prunedInputs = denseUniqueStrings(
    verification.prunedOwnerCapabilityInputKeys,
    `${label} pruned owner capabilities`,
  );
  if (prunedInputs.length !== 1 ||
      prunedInputs[0] !==
        "third_party/chromium-devtools-frontend/patches/1.0.1681091/facades/issues.ts" ||
      !reviewedOwnerInputs.includes(prunedInputs[0]) || runtimeInputs.includes(prunedInputs[0])) {
    throw new Error(`${label} has an invalid pruned owner capability inventory`);
  }
  const prunedAttestation = exactObject(
    verification.prunedOwnerCapabilityAttestation,
    `${label} pruned owner capability attestation`,
  );
  if (
    Object.keys(prunedAttestation).sort().join(",") !== "fileCount,reason,sha256" ||
    prunedAttestation.fileCount !== 1 ||
    prunedAttestation.sha256 !==
      "1a547b642f0a385145dcb553623881863d5496536d8d62bddae3a2952145bb30" ||
    prunedAttestation.reason !== "Pin-op does not expose Chromium Issues capability"
  ) {
    throw new Error(`${label} has an invalid pruned owner capability attestation`);
  }
  const ownedInputs = [...new Set([
    ...reviewedOwnerInputs.filter(input => !prunedInputs.includes(input)),
    ...localInputs,
  ])].sort();
  assertExactStringSet(ownedInputs, runtimeInputs, `${label} exact union of input owners`);

  exactAttestation(
    verification.elements?.chromiumInputAttestation,
    `${label} Elements package attestation`,
  );
  exactAttestation(
    verification.elements?.overlayAttestation,
    `${label} Elements overlay attestation`,
  );
  exactAttestation(
    verification.styles?.packageInputAttestation,
    `${label} Styles package attestation`,
  );
  exactAttestation(
    verification.styles?.stylesOverlayAttestation,
    `${label} Styles overlay attestation`,
  );
  exactAttestation(
    verification.styles?.baseOverlayAttestation,
    `${label} Styles base overlay attestation`,
  );
  exactLicenseInventory(
    verification.elements?.requiredLicenseFiles,
    `${label} Elements license inventory`,
  );
  exactLicenseInventory(
    verification.styles?.requiredLicenseFiles,
    `${label} Styles license inventory`,
  );
}

function exactMetafile(metafile, description) {
  if (!metafile || typeof metafile !== "object") {
    throw new Error(`${description} has no esbuild metafile`);
  }
  exactObject(metafile.inputs, `${description} inputs`);
  exactObject(metafile.outputs, `${description} outputs`);
  return metafile;
}

function exactObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function exactOutput(metafile, filename, description) {
  const outputs = Object.entries(metafile.outputs);
  if (outputs.length !== 1) {
    throw new Error(`${description} must have one exact output path`);
  }
  const normalized = outputs[0][0].replaceAll("\\", "/");
  if (normalized.split("/").at(-1) !== filename) {
    throw new Error(`${description} has an unexpected output path: ${outputs[0][0]}`);
  }
  exactObject(outputs[0][1], `${description} output metadata`);
  return outputs[0];
}

function denseUniqueStrings(value, description) {
  return denseUniqueArray(
    value,
    description,
    item => typeof item === "string" && item.length > 0,
  );
}

function denseUniqueArray(
  value,
  description,
  isValid,
  identity = item => item,
) {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be a dense array`);
  }
  const identities = new Set();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${description} must be a dense array`);
    }
    const item = value[index];
    if (!isValid(item)) {
      throw new Error(`${description} contains an invalid entry`);
    }
    const key = identity(item);
    if (identities.has(key)) {
      throw new Error(`${description} must contain unique entries`);
    }
    identities.add(key);
  }
  return value;
}

function assertExactStringSet(actual, expected, description) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((value, index) => value !== sortedExpected[index])
  ) {
    throw new Error(`${description} does not match the exact union`);
  }
}

function exactAttestation(value, description) {
  const attestation = exactObject(value, description);
  const keys = Object.keys(attestation).sort();
  if (
    keys.length !== 2 || keys[0] !== "fileCount" || keys[1] !== "sha256" ||
    !Number.isSafeInteger(attestation.fileCount) || attestation.fileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(attestation.sha256 ?? "")
  ) {
    throw new Error(`${description} has an invalid attestation shape`);
  }
}

function exactLicenseInventory(value, description) {
  const licenses = denseUniqueArray(
    value,
    description,
    item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const keys = Object.keys(item).sort();
      return keys.length === 2 && keys[0] === "path" && keys[1] === "sha256" &&
        typeof item.path === "string" && item.path.length > 0 &&
        /^[a-f0-9]{64}$/.test(item.sha256 ?? "");
    },
    item => item.path,
  );
  if (licenses.length === 0) {
    throw new Error(`${description} must not be empty`);
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
