import {readFile, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";

import {build} from "esbuild";
import ts from "typescript";

import {
  applyChromiumReadOnlySourceTransform,
  assertChromiumSharedRuntimeAuthority,
  CHROMIUM_DEVTOOLS_PIN,
  createChromiumReadOnlySourceTransformPlugin,
  createChromiumSharedRuntimePlugins,
  verifyChromiumDevToolsPackage,
  verifyChromiumReadOnlyElementsOverlay,
} from "./chromium-devtools-runtime.mjs";

export const CHROMIUM_READ_ONLY_STYLES_RUNTIME = Object.freeze({
  schemaVersion: 1,
  packageName: "chrome-devtools-frontend",
  packageVersion: "1.0.1681091",
  gitHead: "23cccaa78f7458a5aad99c1af98dc1856d2494a3",
  integrity:
    "sha512-cXBay271CnEb+Y+Cxre3mjGDHFKhXVo9mGfNCVAruen/iwF+jnG6Z55mnC7yh078HD1rmKhBM9tKLKQbjVniVQ==",
  maxUnminifiedBytes: 2 * 1024 * 1024,
  browserTargets: Object.freeze(["chrome116", "firefox142"]),
  overlayRoot:
    "third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091",
  manifestSha256:
    "ac7cdbf3be3760c3963059fbe230ddc59de756640c7b441ee352c5c4ff423bc2",
  entryPoint:
    "third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/entrypoints/read-only-styles.ts",
});

const REVIEWED_STYLES_SIDEBAR_SHA256 =
  "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28";
const REVIEWED_STYLE_PROPERTIES_SECTION_SHA256 =
  "bd02a2628edd75360d29eb7da8630dd5b0ef9b5e409cf83bd20288fa52a293be";
const REVIEWED_STYLE_PROPERTY_TREE_SHA256 =
  "427124f750a785db8d64676c970ae1576c7c11df7136393e8f4b82e679ecba2d";
const REVIEWED_CSS_PROPERTY_SHA256 =
  "6c699445cd13b6f841cc740b15fe1e01360c5afb4c87a3a68f1dd89b76f22047";
const REVIEWED_CSS_STYLE_DECLARATION_SHA256 =
  "8c35c9ab6b4ae00f172d67546047efdacfb0d59173b3420dae066f4b00583454";
const REVIEWED_STYLE_IMAGE_HASHES = Object.freeze({
  "filter.svg": "fb827ba04c06cb587cf0f76adece7488274ee4048b29b6cb6c17b02fda1a6a4a",
  "open-externally.svg": "5fcb85adf49ec2ab8ee9961c9dad144e7368132051a86fd1fbcf22845fff724d",
  "triangle-down.svg": "849ee04c3f54b9167e5e0cb791baca667b3c59efa0ec6f97227b32dea2e1be4b",
  "triangle-right.svg": "be18d57199e26de957ae4fa8c8bf5bca89456e5ecf225075dab4a95f89535e85",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertHashInventory(actual, reviewed, description) {
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) {
    throw new Error(`${description} inventory is invalid`);
  }
  const actualKeys = Object.keys(actual).sort();
  const reviewedKeys = Object.keys(reviewed).sort();
  if (
    actualKeys.length !== reviewedKeys.length ||
    actualKeys.some((value, index) => value !== reviewedKeys[index])
  ) {
    throw new Error(`${description} inventory mismatch`);
  }
  for (const relativePath of actualKeys) {
    if (actual[relativePath] !== reviewed[relativePath]) {
      throw new Error(`${description} hash mismatch for ${relativePath}: ${actual[relativePath]}`);
    }
  }
}

function assertAttestation(actual, reviewed, description) {
  if (
    !reviewed || !Number.isSafeInteger(reviewed.fileCount) || reviewed.fileCount < 0 ||
    !/^[a-f0-9]{64}$/.test(reviewed.sha256 ?? "") ||
    actual.fileCount !== reviewed.fileCount || actual.sha256 !== reviewed.sha256
  ) {
    throw new Error(
      `${description} mismatch: ${actual.fileCount}/${actual.sha256}`,
    );
  }
}

async function listRegularFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    } else {
      throw new Error(`Chromium Styles overlay contains a non-regular file: ${absolutePath}`);
    }
  }
  return files;
}

export async function verifyChromiumReadOnlyStylesOverlayInventory({overlayRoot, expectedFiles}) {
  const physicalOverlayRoot = await realpath(overlayRoot);
  const actualFiles = {};
  for (const absolutePath of await listRegularFiles(physicalOverlayRoot)) {
    const relativePath = path.relative(physicalOverlayRoot, absolutePath).replaceAll(path.sep, "/");
    if (relativePath !== "manifest.json") {
      actualFiles[relativePath] = sha256(await readFile(absolutePath));
    }
  }
  assertHashInventory(actualFiles, expectedFiles, "Chromium Styles overlay file");
  return Object.freeze(actualFiles);
}

function assertWithin(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${description} is outside ${root}: ${candidate}`);
  }
  return candidate;
}

async function resolvePinnedPackage(repositoryRoot) {
  if (
    CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageName !== CHROMIUM_DEVTOOLS_PIN.packageName ||
    CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion !== CHROMIUM_DEVTOOLS_PIN.version ||
    CHROMIUM_READ_ONLY_STYLES_RUNTIME.gitHead !== CHROMIUM_DEVTOOLS_PIN.gitHead ||
    CHROMIUM_READ_ONLY_STYLES_RUNTIME.integrity !== CHROMIUM_DEVTOOLS_PIN.integrity
  ) {
    throw new Error("Chromium Styles runtime pin diverges from the reviewed DevTools pin");
  }
  const verifiedPackage = await verifyChromiumDevToolsPackage(repositoryRoot);
  const packageRoot = verifiedPackage.packageRoot;
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (
    manifest.name !== CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageName ||
    manifest.version !== CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion ||
    manifest.license !== "BSD-3-Clause"
  ) {
    throw new Error("Chromium Styles runtime package does not match the reviewed pin");
  }
  const lockfile = await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const lockEntry =
    `${CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageName}@${CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion}:`;
  if (!lockfile.includes(lockEntry) ||
      !lockfile.includes(`integrity: ${CHROMIUM_READ_ONLY_STYLES_RUNTIME.integrity}`)) {
    throw new Error("Chromium Styles runtime lockfile integrity does not match the reviewed pin");
  }
  return packageRoot;
}

async function verifyChromiumReadOnlyStylesOverlay(repositoryRoot, packageRoot) {
  const overlayRoot = await realpath(path.join(
    repositoryRoot,
    ...CHROMIUM_READ_ONLY_STYLES_RUNTIME.overlayRoot.split("/"),
  ));
  if (!relativePathWithin(repositoryRoot, overlayRoot)) {
    throw new Error("Chromium Styles overlay is outside the repository");
  }
  const manifestBytes = await readFile(path.join(overlayRoot, "manifest.json"));
  if (sha256(manifestBytes) !== CHROMIUM_READ_ONLY_STYLES_RUNTIME.manifestSha256) {
    throw new Error("Chromium Styles overlay manifest hash mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pin = CHROMIUM_READ_ONLY_STYLES_RUNTIME;
  if (
    manifest.schemaVersion !== pin.schemaVersion ||
    manifest.package?.name !== pin.packageName ||
    manifest.package?.version !== pin.packageVersion ||
    manifest.package?.gitHead !== pin.gitHead ||
    manifest.package?.integrity !== pin.integrity ||
    manifest.package?.license !== "BSD-3-Clause" ||
    manifest.entryPoint !== "entrypoints/read-only-styles.ts" ||
    manifest.maxUnminifiedBytes !== pin.maxUnminifiedBytes ||
    !Array.isArray(manifest.browserTargets) ||
    manifest.browserTargets.length !== pin.browserTargets.length ||
    manifest.browserTargets.some((target, index) => target !== pin.browserTargets[index]) ||
    !Array.isArray(manifest.productionExports) ||
    manifest.productionExports.length !== 1 ||
    manifest.productionExports[0] !== "chromiumReadOnlyStylesRuntime"
  ) {
    throw new Error("Chromium Styles overlay manifest does not match the reviewed runtime");
  }
  await verifyChromiumReadOnlyStylesOverlayInventory({
    overlayRoot,
    expectedFiles: manifest.overlayFiles,
  });

  const reviewedUpstreamFiles = Object.freeze({
    "front_end/core/sdk/CSSProperty.ts": REVIEWED_CSS_PROPERTY_SHA256,
    "front_end/core/sdk/CSSStyleDeclaration.ts": REVIEWED_CSS_STYLE_DECLARATION_SHA256,
    "front_end/panels/elements/StylePropertiesSection.ts": REVIEWED_STYLE_PROPERTIES_SECTION_SHA256,
    "front_end/panels/elements/StylePropertyTreeElement.ts": REVIEWED_STYLE_PROPERTY_TREE_SHA256,
    "front_end/panels/elements/StylesSidebarPane.ts": REVIEWED_STYLES_SIDEBAR_SHA256,
  });
  assertHashInventory(
    reviewedUpstreamFiles,
    manifest.upstreamFiles,
    "Chromium Styles reviewed upstream file",
  );
  const actualUpstreamFiles = {};
  for (const relativePath of Object.keys(reviewedUpstreamFiles)) {
    if (!/^front_end\/[A-Za-z0-9_./-]+\.ts$/.test(relativePath)) {
      throw new Error(`Invalid Chromium Styles upstream path: ${relativePath}`);
    }
    const absolutePath = assertWithin(
      packageRoot,
      path.resolve(packageRoot, ...relativePath.split("/")),
      "Chromium Styles upstream source",
    );
    actualUpstreamFiles[relativePath] = sha256(await readFile(absolutePath));
  }
  assertHashInventory(
    actualUpstreamFiles,
    manifest.upstreamFiles,
    "Chromium Styles upstream source",
  );
  const reviewedImageFiles = Object.fromEntries(Object.entries(REVIEWED_STYLE_IMAGE_HASHES).map(
    ([fileName, hash]) => [`front_end/Images/src/${fileName}`, hash],
  ));
  assertHashInventory(
    reviewedImageFiles,
    manifest.requiredImageFiles,
    "Chromium Styles image",
  );
  const requiredImageFiles = [];
  for (const relativePath of Object.keys(reviewedImageFiles).sort()) {
    const absolutePath = assertWithin(
      packageRoot,
      path.resolve(packageRoot, ...relativePath.split("/")),
      "Chromium Styles image",
    );
    requiredImageFiles.push(Object.freeze({
      path: relativePath,
      sha256: sha256(await readFile(absolutePath)),
    }));
  }
  assertHashInventory(
    Object.fromEntries(requiredImageFiles.map(file => [file.path, file.sha256])),
    manifest.requiredImageFiles,
    "Chromium Styles image",
  );

  if (
    !Number.isSafeInteger(manifest.reviewedInputCount) || manifest.reviewedInputCount < 1 ||
    !Array.isArray(manifest.reviewedGeneratedInputs) ||
    new Set(manifest.reviewedGeneratedInputs).size !== manifest.reviewedGeneratedInputs.length ||
    !Array.isArray(manifest.reviewedSharedInputInventory) ||
    new Set(manifest.reviewedSharedInputInventory).size !== manifest.reviewedSharedInputInventory.length ||
    !manifest.reviewedSharedPayloadAttestation ||
    !Number.isSafeInteger(manifest.reviewedSharedPayloadAttestation.fileCount) ||
    !/^[a-f0-9]{64}$/.test(manifest.reviewedSharedPayloadAttestation.sha256 ?? "")
  ) {
    throw new Error("Chromium Styles reviewed closure metadata is invalid");
  }
  for (const [name, attestation] of Object.entries({
    package: manifest.reviewedPackageClosure,
    stylesOverlay: manifest.reviewedStylesOverlayClosure,
    baseOverlay: manifest.reviewedBaseOverlayClosure,
  })) {
    if (
      !attestation || !Number.isSafeInteger(attestation.fileCount) || attestation.fileCount < 1 ||
      !/^[a-f0-9]{64}$/.test(attestation.sha256 ?? "")
    ) {
      throw new Error(`Chromium Styles ${name} closure attestation is invalid`);
    }
  }
  if (
    !manifest.requiredLicenseFiles ||
    Object.keys(manifest.requiredLicenseFiles).length === 0 ||
    Object.entries(manifest.requiredLicenseFiles).some(([relativePath, hash]) =>
      !/^(?:LICENSE|front_end\/third_party\/[A-Za-z0-9_.-]+\/LICENSE(?:\.[A-Za-z0-9_.-]+)?)$/.test(relativePath) ||
      !/^[a-f0-9]{64}$/.test(hash))
  ) {
    throw new Error("Chromium Styles license inventory is invalid");
  }
  return Object.freeze({
    overlayRoot,
    manifest: Object.freeze(manifest),
    requiredImageFiles: Object.freeze(requiredImageFiles),
  });
}

function chromiumPackagePlugin(packageRoot, allowedImporterRoots, sharedRuntime) {
  const frontEndRoot = path.join(packageRoot, "front_end");
  return {
    name: "pin-op-chromium-styles-package",
    setup(context) {
      context.onResolve({filter: /^#chromium\//}, async args => {
        if (!args.importer || !allowedImporterRoots.some(root => relativePathWithin(root, path.resolve(args.importer)))) {
          return undefined;
        }
        const relative = args.path.slice("#chromium/".length);
        if (!/^[A-Za-z0-9_./-]+\.js$/.test(relative)) {
          throw new Error(`Invalid Chromium Styles package import: ${args.path}`);
        }
        if (relative.endsWith(".css.js")) {
          const cssPath = assertWithin(
            frontEndRoot,
            path.resolve(frontEndRoot, relative.slice(0, -3)),
            "Chromium Styles CSS import",
          );
          return await sharedRuntime.resolveCssInput({cssPath, importer: args.importer});
        }
        if (relative === "Images/Images.js") {
          return sharedRuntime.resolveImagesInput({importer: args.importer});
        }
        return {
          path: assertWithin(
            frontEndRoot,
            path.resolve(frontEndRoot, `${relative.slice(0, -3)}.ts`),
            "Chromium Styles source import",
          ),
        };
      });
    },
  };
}

const STYLE_RESOLUTIONS = Object.freeze([
  // Native Styles panes keep their rendering algorithms but receive reviewed, read-only services.
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/common/common.js", "common.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/host/host.js", "host.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/i18n/i18n.js", "@base/i18n.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/platform/platform.js", "platform.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/root/root.js", "@base/root.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/sdk/sdk.js", "sdk.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../core/text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../generated/protocol.js", "protocol.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../models/bindings/bindings.js", "@base/bindings.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../third_party/codemirror.next/codemirror.next.js", "@base/codemirror.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/components/text_editor/text_editor.js", "@base/text-editor.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/kit/kit.js", "kit.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/legacy/components/inline_editor/inline_editor.js", "inline-editor.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/legacy/components/utils/utils.js", "components.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/legacy/legacy.js", "ui.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../../ui/visual_logging/visual_logging.js", "visual-logging.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "../common/common.js", "@base/panels-common.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./components/components.js", "elements-components.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./ElementsPanel.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./ImagePreviewPopover.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./LayersWidget.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./StyleEditorWidget.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./StylePropertyHighlighter.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylesSidebarPane.ts", "./WebCustomData.js", "styles-dependencies.ts"],

  ["front_end/panels/elements/ElementsSidebarPane.ts", "../../models/computed_style/computed_style.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/ElementsSidebarPane.ts", "../../ui/legacy/legacy.js", "ui.ts"],

  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/common/common.js", "common.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/host/host.js", "host.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/i18n/i18n.js", "@base/i18n.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/platform/platform.js", "platform.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/sdk/sdk.js", "sdk.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../core/text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../generated/protocol.js", "protocol.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../models/badges/badges.js", "@base/badges.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../models/bindings/bindings.js", "@base/bindings.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/components/buttons/buttons.js", "buttons.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/components/tooltips/tooltips.js", "@base/tooltip.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/kit/kit.js", "kit.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/legacy/components/utils/utils.js", "components.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/legacy/legacy.js", "ui.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../../ui/visual_logging/visual_logging.js", "visual-logging.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "../common/common.js", "@base/panels-common.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "./components/components.js", "elements-components.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "./CSSSpecificityBreakdown.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertiesSection.ts", "./ElementsPanel.js", "styles-dependencies.ts"],

  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/common/common.js", "common.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/host/host.js", "host.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/i18n/i18n.js", "@base/i18n.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/platform/platform.js", "platform.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/sdk/sdk.js", "sdk.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../core/text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../generated/protocol.js", "protocol.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../models/badges/badges.js", "@base/badges.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../models/bindings/bindings.js", "@base/bindings.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../third_party/codemirror.next/codemirror.next.js", "@base/codemirror.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/components/tooltips/tooltips.js", "@base/tooltip.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/kit/kit.js", "kit.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/legacy/components/inline_editor/inline_editor.js", "inline-editor.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/legacy/components/color_picker/color_picker.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/legacy/legacy.js", "ui.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "../../ui/visual_logging/visual_logging.js", "visual-logging.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./ColorSwatchPopoverIcon.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./components/components.js", "elements-components.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./CSSRuleValidator.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./CSSValueTraceView.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./ElementsPanel.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./StyleEditorWidget.js", "styles-dependencies.ts"],
  ["front_end/panels/elements/StylePropertyTreeElement.ts", "./StylePropertyUtils.js", "styles-dependencies.ts"],

  // Narrow SDK model closure used by the real CSS cascade.
  ["front_end/core/sdk/CSSMatchedStyles.ts", "../../generated/protocol.js", "protocol.ts"],
  ["front_end/core/sdk/CSSMatchedStyles.ts", "../platform/platform.js", "platform.ts"],
  ["front_end/core/sdk/CSSMatchedStyles.ts", "./DOMModel.js", "dom-model.ts"],
  ["front_end/core/sdk/CSSProperty.ts", "../common/common.js", "common.ts"],
  ["front_end/core/sdk/CSSProperty.ts", "../host/host.js", "host.ts"],
  ["front_end/core/sdk/CSSProperty.ts", "../platform/platform.js", "platform.ts"],
  ["front_end/core/sdk/CSSProperty.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSStyleDeclaration.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSRule.ts", "../../generated/protocol.js", "protocol.ts"],
  ["front_end/core/sdk/CSSRule.ts", "../platform/platform.js", "platform.ts"],
  ["front_end/core/sdk/CSSRule.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSContainerQuery.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSLayer.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSMedia.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSNavigation.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSScope.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSStartingStyle.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSSupports.ts", "./CSSQuery.js", "css-query.ts"],
  ["front_end/core/sdk/CSSContainerQuery.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSLayer.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSMedia.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSNavigation.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSScope.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSStartingStyle.ts", "../text_utils/text_utils.js", "text-utils.ts"],
  ["front_end/core/sdk/CSSSupports.ts", "../text_utils/text_utils.js", "text-utils.ts"],

  // The reviewed native parser/value renderer spine. Only broad barrels and
  // interactive dependencies are replaced; parsing and rendering stay upstream.
  ["front_end/core/sdk/CSSPropertyParser.ts", "../../core/platform/platform.js", "platform.ts"],
  ["front_end/core/sdk/CSSPropertyParserMatchers.ts", "../../core/common/common.js", "common.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../core/common/common.js", "common.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../core/i18n/i18n.js", "@base/i18n.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../core/sdk/sdk.js", "sdk.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../ui/legacy/components/utils/utils.js", "components.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../ui/legacy/legacy.js", "ui.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "../../ui/visual_logging/visual_logging.js", "visual-logging.ts"],
  ["front_end/panels/elements/PropertyRenderer.ts", "./ImagePreviewPopover.js", "styles-dependencies.ts"],
  ["front_end/ui/legacy/components/inline_editor/ColorSwatch.ts", "../../../../core/i18n/i18n.js", "@base/i18n.ts"],
  ["front_end/ui/legacy/components/inline_editor/ColorSwatch.ts", "../../../legacy/components/color_picker/color_picker.js", "styles-dependencies.ts"],
  ["front_end/ui/legacy/components/inline_editor/ColorSwatch.ts", "../../../visual_logging/visual_logging.js", "visual-logging.ts"],
]);

function stylesResolutions({stylesRoot, baseOverlay, packageRoot}) {
  const baseRoot = baseOverlay.overlayRoot;
  if (
    path.resolve(baseOverlay.packageRoot) !== path.resolve(packageRoot) ||
    baseOverlay.manifest.package?.version !== CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion ||
    baseOverlay.manifest.package?.gitHead !== CHROMIUM_READ_ONLY_STYLES_RUNTIME.gitHead
  ) {
    throw new Error("Chromium Styles base overlay diverges from the reviewed package pin");
  }
  const resolutions = new Map(baseOverlay.resolutions);
  for (const [importer, specifier, facade] of STYLE_RESOLUTIONS) {
    const facadeRoot = facade.startsWith("@base/") ? path.join(baseRoot, "facades") : path.join(stylesRoot, "facades");
    const facadeRelative = facade.replace(/^@base\//, "");
    resolutions.set(`${importer}\0${specifier}`, path.join(facadeRoot, ...facadeRelative.split("/")));
  }
  return Object.freeze(resolutions);
}

function exactStylesResolutionPlugin(packageRoot, resolutions) {
  return {
    name: "pin-op-chromium-exact-styles-resolutions",
    setup(context) {
      context.onResolve({filter: /.*/}, args => {
        if (!args.importer) return undefined;
        const importer = path.resolve(args.importer);
        const relative = path.relative(packageRoot, importer).replaceAll(path.sep, "/");
        if (relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
        const facade = resolutions.get(`${relative}\0${args.path}`);
        return facade ? {path: facade} : undefined;
      });
    },
  };
}

function memberName(member) {
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

function rewriteMethodBody(source, relativePath, className, name, replacement, predicate = () => true) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = [];
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const item of node.members) {
        if (memberName(item) === name && item.body && predicate(item)) matches.push(item.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(`Reviewed ${relativePath} method ${className}.${name} is missing or ambiguous`);
  }
  const body = matches[0];
  return source.slice(0, body.getStart(sourceFile)) + replacement + source.slice(body.end);
}

function rewriteFunctionBody(source, relativePath, name, replacement) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = sourceFile.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body);
  if (matches.length !== 1) {
    throw new Error(`Reviewed ${relativePath} function ${name} is missing or ambiguous`);
  }
  const body = matches[0].body;
  return source.slice(0, body.getStart(sourceFile)) + replacement + source.slice(body.end);
}

function pruneConstructorStatements(source, relativePath, className, shouldRemove) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    const constructor = statement.members.find(ts.isConstructorDeclaration);
    if (!constructor?.body) throw new Error(`Reviewed ${relativePath} constructor is missing`);
    for (const child of constructor.body.statements) {
      if (shouldRemove(child.getText(sourceFile))) ranges.push([child.getFullStart(), child.end]);
    }
  }
  if (ranges.length === 0) throw new Error(`Reviewed ${relativePath} constructor pruning matched nothing`);
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) {
    source = source.slice(0, start) + source.slice(end);
  }
  return source;
}

function removeTopLevelClass(source, relativePath, className) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = sourceFile.statements.filter(statement =>
    ts.isClassDeclaration(statement) && statement.name?.text === className);
  if (matches.length !== 1) {
    throw new Error(`Reviewed ${relativePath} class ${className} is missing or ambiguous`);
  }
  const declaration = matches[0];
  return source.slice(0, declaration.getFullStart()) + "\n" + source.slice(declaration.end);
}

function removeTopLevelImport(source, relativePath, specifier) {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = sourceFile.statements.filter(statement =>
    ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier);
  if (matches.length !== 1) {
    throw new Error(`Reviewed ${relativePath} import ${specifier} is missing or ambiguous`);
  }
  const declaration = matches[0];
  return source.slice(0, declaration.getFullStart()) + "\n" + source.slice(declaration.end);
}

function transformStylesSidebarSource(source, relativePath) {
  source = removeTopLevelImport(source, relativePath, "../../models/ai_code_completion/ai_code_completion.js");
  source = removeTopLevelImport(source, relativePath, "./StylesAiCodeCompletionProvider.js");
  source = pruneConstructorStatements(source, relativePath, "StylesSidebarPane", text =>
    text.includes(".addChangeListener(") ||
    text.includes("#swatchPopoverHelper.addEventListener") ||
    text.includes("addFlavorChangeListener") ||
    text.includes("addEventListener('copy'") ||
    text.includes("UI.ViewManager.ViewManager.instance().addEventListener") ||
    text.includes("isAiCodeCompletionStylesAvailable"));
  const readOnlyPresentationAnchor = "    this.registerRequiredCSS(stylesSidebarPaneStyles);";
  if (source.split(readOnlyPresentationAnchor).length !== 2) {
    throw new Error(`Reviewed ${relativePath} read-only presentation anchor is missing or ambiguous`);
  }
  source = source.replace(readOnlyPresentationAnchor, `    this.registerRequiredCSS(
        (stylesSidebarPaneStyles +
         '\\n.styles-section.read-only { font-style: normal; }' +
         '\\n.styles-sidebar-pane-toolbar-container { padding-inline-end: 52px; }' +
         '\\n.text-prompt-root { display: flex; align-items: center; }' +
         '\\n.text-prompt[data-placeholder]:empty::before { content: attr(data-placeholder); color: var(--sys-color-on-surface-subtle); }' +
         '\\n.pin-op-toolbar-icon-button { align-items: center; align-self: center; background: transparent; border: 0; border-radius: 4px; box-sizing: border-box; color: var(--sys-color-on-surface-subtle); cursor: default; display: inline-flex; flex: none; height: 20px; justify-content: center; padding: 2px; width: 20px; }' +
         '\\n.pin-op-toolbar-icon-button:hover { background-color: var(--sys-color-state-hover-on-subtle); }' +
         '\\n.pin-op-toolbar-icon-button:focus-visible { outline: 2px solid var(--sys-color-state-focus-ring); outline-offset: -2px; }' +
         '\\n.pin-op-toolbar-icon-button[aria-pressed="true"] { background-color: var(--sys-color-tonal-container); color: var(--sys-color-primary); }' +
         '\\n.pin-op-toolbar-icon-button > svg { fill: currentcolor; height: 16px; pointer-events: none; width: 16px; }') as typeof stylesSidebarPaneStyles);`);
  source = rewriteMethodBody(source, relativePath, "StylesSidebarPane", "setActiveProperty", `{
        // Pin-op owns page highlighting; the embedded Styles pane has no overlay authority.
    }`);
  source = rewriteMethodBody(source, relativePath, "SectionBlock", "createInheritedNodeBlock", `{
        const separatorElement = document.createElement('div');
        separatorElement.className = 'sidebar-separator';
        separatorElement.setAttribute('jslog', String(VisualLogging.sectionHeader('inherited')));
        UI.UIUtils.createTextChild(separatorElement, 'Inherited from ');
        const label = (node as SDK.DOMModel.DOMNode&{pinOpInheritedLabel?: string}).pinOpInheritedLabel ||
            node.nodeNameInCorrectCase();
        const labelElement = separatorElement.createChild('span', 'pin-op-inherited-node-label');
        labelElement.textContent = label;
        return new SectionBlock(separatorElement);
    }`);
  const focusCaptureAnchor = "    const focusedIndex = this.focusedSectionIndex();";
  const focusMountAnchor = `    this.sectionsContainer.contentElement.removeChildren();
    this.sectionsContainer.detachChildWidgets();
    const fragment = document.createDocumentFragment();`;
  const focusRestoreAnchor = `    if (elementToFocus) {
      elementToFocus.focus();
    }

    if (focusedIndex >= index) {
      this.sectionBlocks[0].sections[0].element.focus();
    }`;
  for (const [anchor, replacement] of [
    [focusCaptureAnchor, `${focusCaptureAnchor}
    const focusedElementAtStart = UI.DOMUtilities.deepActiveElement(this.element.ownerDocument);`],
    [focusMountAnchor, `    const shouldRestoreSectionFocus = focusedIndex >= 0 &&
        UI.DOMUtilities.deepActiveElement(this.element.ownerDocument) === focusedElementAtStart;
${focusMountAnchor}`],
    [focusRestoreAnchor, `    if (shouldRestoreSectionFocus && elementToFocus) {
      elementToFocus.focus();
    }

    if (shouldRestoreSectionFocus && focusedIndex >= index) {
      this.sectionBlocks[0]?.sections[0]?.element.focus();
    }`],
  ]) {
    if (source.split(anchor).length !== 2) {
      throw new Error(`Reviewed ${relativePath} focus guard anchor is missing or ambiguous`);
    }
    source = source.replace(anchor, replacement);
  }
  source = applyChromiumReadOnlySourceTransform(source, {removeMembers: [
    "onAddButtonLongClick", "refreshUpdate", "performUpdate", "#innerDoUpdate", "#getRegisteredPropertyDetails",
    "getVariableParserError", "getVariablePopoverContents", "fetchComputedStylesFor",
    "fetchComputedStyleExtraFieldsFor", "resetCache", "fetchMatchedCascade", "setEditingStyle",
    "onCSSModelChanged", "onComputedStyleChanged", "handledComputedStyleChangedForTest",
    "#resetUpdateIfNotEditing", "#scheduleResetUpdateIfNotEditing", "scheduleResetUpdateIfNotEditingCalledForTest",
    "#hasAnimatedStyles", "#updateAnimatedStyles", "#refreshComputedStyles", "continueEditingElement",
    "createNewRuleInViaInspectorStyleSheet", "createNewRuleInStyleSheet", "addBlankSection", "removeSection",
    "clipboardCopy", "showToolbarPane", "startToolbarPaneAnimation", "createRenderingShortcuts",
    "#cleanupAiCodeCompletion", "#createAiCodeCompletionSummaryToolbar", "#onAiCodeCompletionSuggestionAccepted",
    "#onAiCodeCompletionRequestTriggered", "#onAiCodeCompletionResponseReceived",
  ]}, relativePath);
  const anchor =
    "    private nodeStylesUpdatedForTest(_node: SDK.DOMModel.DOMNode, _rebuild: boolean): void {";
  if (source.split(anchor).length !== 2) {
    throw new Error("Reviewed transformed StylesSidebarPane hook anchor is missing or ambiguous");
  }
  const hook = `    async pinOpPresentMatchedStyles(
        matchedStyles: SDK.CSSMatchedStyles.CSSMatchedStyles, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        this.matchedStyles = matchedStyles;
        await this.innerRebuildUpdate(signal, matchedStyles, null, null, null);
        signal.throwIfAborted();
    }
    pinOpClearReadOnlyStyles(): void {
        this.idleCallbackManager?.discard();
        this.idleCallbackManager = null;
        this.#updateAbortController?.abort();
        this.#updateAbortController = undefined;
        this.#updateComputedStylesAbortController?.abort();
        this.#updateComputedStylesAbortController = undefined;
        this.#lazyRenderObserver?.disconnect();
        this.#lazyRenderObserver = undefined;
        this.#lazyRenderCallbacks = new WeakMap();
        this.#elementsForSyncViewportCheck = [];
        this.sectionBlocks = [];
        this.sectionsContainer.contentElement.removeChildren();
        this.sectionsContainer.detachChildWidgets();
        this.noMatchesElement.classList.remove('hidden');
        this.matchedStyles = null;
        this.hasMatchedStyles = false;
    }
    pinOpDisposeReadOnlyStyles(): void {
        this.pinOpClearReadOnlyStyles();
        this.#swatchPopoverHelper.hide();
        this.imagePreviewPopover.hide();
        this.linkifier.dispose();
    }
`;
  source = source.replace(anchor, `${hook}${anchor}`);
  // The prompt owns completion, AI, and editor plumbing. The read-only pane
  // keeps Chromium's presentation classes but has no reason to ship it.
  return removeTopLevelClass(source, relativePath, "CSSPropertyPrompt");
}

function transformStylePropertiesSectionSource(source, relativePath) {
  source = pruneConstructorStatements(source, relativePath, "StylePropertiesSection", text =>
    text.includes("const newRuleButton") ||
    text.includes("this.element.addEventListener('keydown'") ||
    text.includes("this.selectorElement.addEventListener('click'") ||
    text.includes("this.element.addEventListener('contextmenu'") ||
    text.includes("this.element.addEventListener('mousedown'") ||
    text.includes("this.element.addEventListener('click'") ||
    text.includes("this.element.addEventListener('mousemove'") ||
    text.includes("this.element.addEventListener('mouseleave'"));
  return applyChromiumReadOnlySourceTransform(source, {removeMembers: [
    "commitActiveAiSuggestion", "#clearActiveAiSuggestion", "#renderActiveAiSuggestion",
    "#getAiSuggestionSourceTreeElement", "onNewRuleClick", "styleSheetEdited", "addNewBlankProperty",
    "handleEmptySpaceMouseDown", "handleEmptySpaceClick", "handleQueryRuleClick", "editingMediaFinished",
    "editingMediaCancelled", "editingMediaBlurHandler", "editingMediaCommitted", "editingMediaTextCommittedForTest",
    "handleSelectorClick", "handleContextMenuEvent", "navigateToSelectorSource", "revealSelectorSource",
    "startEditingAtFirstPosition", "startEditingSelector", "moveEditorFromSelector", "editingSelectorCommitted",
    "setHeaderText", "editingSelectorCommittedForTest", "editingSelectorEnded", "editingSelectorCancelled",
    "closestPropertyForEditing", "onKeyDown",
  ]}, relativePath);
}

function transformStylePropertyTreeSource(source, relativePath) {
  source = rewriteFunctionBody(source, relativePath, "getPropertyRenderers", `{
    // Preserve every Chromium presentation renderer supported by the reviewed
    // read-only facades. Editor-capable renderers receive no tree element.
    // Exact raw fallback below covers the deliberately excluded set:
    // VariableRenderer, VariableNameRenderer, ColorMixRenderer, URLRenderer,
    // LinkableNameRenderer, ShadowRenderer, CSSWideKeywordRenderer,
    // LightDarkColorRenderer, AnchorFunctionRenderer, PositionAnchorRenderer,
    // MathFunctionRenderer, and AttributeRenderer.
    return [
        new ColorRenderer(stylesContainer, null),
        new ContrastColorRenderer(stylesContainer, null),
        new AngleRenderer(null),
        new BezierRenderer(null),
        new StringRenderer(),
        new GridTemplateRenderer(),
        new LinearGradientRenderer(),
        new FlexGridRenderer(stylesContainer, null),
        new EnvFunctionRenderer(null, matchedStyles, computedStyles, computedStyleExtraFields),
        new PositionTryRenderer(matchedStyles),
        new LengthRenderer(stylesContainer, propertyName, null),
        new CustomFunctionRenderer(
            stylesContainer, matchedStyles, computedStyles, computedStyleExtraFields, propertyName, null),
        new AutoBaseRenderer(computedStyles, computedStyleExtraFields),
        new BinOpRenderer(),
        new RelativeColorChannelRenderer(null),
    ];
}`);
  source = rewriteMethodBody(source, relativePath, "StylePropertyTreeElement", "#getLonghandProperties", `{
        return this.property.getLonghandProperties();
    }`);
  source = rewriteMethodBody(source, relativePath, "StylePropertyTreeElement", "onattach", `{
        if (this.#lazyRender) {
            this.nameElement = Renderer.renderNameElement(this.name);
            this.valueElement = Renderer.renderValueElement(this.property, null, []).valueElement;
            this.listItemElement.classList.toggle('inactive', !this.property.activeInStyle());
            this.listItemElement.appendChild(this.nameElement);
            this.listItemElement.createChild('span', 'styles-name-value-separator').textContent = ': ';
            this.listItemElement.appendChild(this.valueElement);
            this.listItemElement.createChild('span', 'styles-semicolon').textContent = ';';
            this.#stylesContainer.trackForLazyRendering(this.listItemElement, () => {
                this.#lazyRender = false;
                this.updateTitle();
            });
        } else {
            this.updateTitle();
        }
    }`);
  source = rewriteMethodBody(source, relativePath, "StylePropertyTreeElement", "updateTitle", `{
        this.#updateTitle();
    }`);
  source = rewriteMethodBody(source, relativePath, "StylePropertyTreeElement", "#updateTitle", `{
        this.updateState();
        this.expandElement = null;
        if (this.isExpandable()) {
            this.expandElement = createIcon('triangle-right', 'expand-icon');
            this.expandElement.setAttribute('role', 'button');
            this.expandElement.setAttribute('aria-label', 'Show longhand properties');
            this.expandElement.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (this.expanded) {
                    this.collapse();
                } else {
                    void this.expand();
                }
            });
        }
        const renderers = this.property.parsedOk ?
            getPropertyRenderers(
                this.name, this.style, this.#stylesContainer, this.#matchedStyles, null,
                this.getComputedStyles() ?? new Map(), this.getComputedStyleExtraFields()) : [];
        this.listItemElement.removeChildren();
        this.nameElement = Renderer.renderNameElement(this.name);
        const matchedResult = this.property.parseValue(this.matchedStyles(), this.computedStyles);
        this.valueElement = Renderer.renderValueElement(this.property, matchedResult, renderers).valueElement;
        if (this.valueElement.textContent !== this.property.value) {
            this.valueElement = Renderer.renderValueElement(this.property, null, []).valueElement;
        }
        if (!this.treeOutline) {
            return;
        }
        const indent = Common.Settings.Settings.instance().moduleSetting('text-editor-indent').get();
        UI.UIUtils.createTextChild(
            this.listItemElement.createChild('span', 'styles-clipboard-only'),
            indent.repeat(this.section().nestingLevel + 1));
        this.listItemElement.appendChild(this.nameElement);
        this.listItemElement.createChild('span', 'styles-name-value-separator').textContent = ': ';
        if (this.expandElement) {
            this.listItemElement.appendChild(this.expandElement);
            this.updateExpandElement();
        }
        this.listItemElement.appendChild(this.valueElement);
        this.listItemElement.createChild('span', 'styles-semicolon').textContent = ';';
        if (!this.property.parsedOk) {
            this.listItemElement.classList.add('not-parsed-ok');
        }
        if (!this.property.activeInStyle()) {
            this.listItemElement.classList.add('inactive');
        }
        this.updateFilter();
    }`);
  return applyChromiumReadOnlySourceTransform(source, {removeMembers: [
    "updatePane", "toggleDisabled", "#computeCSSExpression", "refreshIfComputedValueChanged",
    "createExclamationMark", "#getLinkableFunction", "getTracingTooltip", "getTooltipId",
    "updateAuthoringHint", "updateAnimationOverrideHint", "overriddenByAnimation", "mouseUp",
    "handleContextMenuEvent", "handleCopyContextMenuEvent", "createCopyContextMenu", "viewComputedValue",
    "copyCssDeclarationAsJs", "copyAllCssDeclarationAsJs", "navigateToSource", "startEditingValue",
    "startEditingName", "#startEditing", "editingNameValueKeyDown", "shouldCommitValueSemicolon",
    "editingNameValueKeyPress", "#selectionLeftOffset", "applyFreeFlowStyleTextEdit",
    "kickFreeFlowStyleEditForTest", "editingEnded", "editingCancelled", "commitAiSuggestion",
    "applyOriginalStyle", "findSibling", "editingCommitted", "removePrompt", "styleTextAppliedForTest",
    "applyStyleText", "innerApplyStyleText", "ondblclick", "isEventWithinDisclosureTriangle",
    "renderActiveAiSuggestion", "clearActiveAiSuggestion", "#showGhostTextInValue", "#clearGhostTextInValue",
  ]}, relativePath);
}

function transformCSSPropertySource(source, relativePath) {
  return applyChromiumReadOnlySourceTransform(source, {removeMembers: [
    "rebase", "setText", "formatStyle", "detectIndentation", "setValue", "setLocalValue", "setDisabled",
  ]}, relativePath);
}

function transformCSSStyleDeclarationSource(source, relativePath) {
  return applyChromiumReadOnlySourceTransform(source, {removeMembers: [
    "rebase", "#insertionRange", "newBlankProperty", "setText", "insertPropertyAt", "appendProperty",
  ]}, relativePath);
}

function readOnlyStylesSourceTransformPlugin(packageRoot) {
  const sourcePath = path.join(
    packageRoot,
    "front_end",
    "panels",
    "elements",
    "StylesSidebarPane.ts",
  );
  const stylePropertiesPath = path.join(
    packageRoot, "front_end", "panels", "elements", "StylePropertiesSection.ts");
  const stylePropertyTreePath = path.join(
    packageRoot, "front_end", "panels", "elements", "StylePropertyTreeElement.ts");
  const cssPropertyPath = path.join(packageRoot, "front_end", "core", "sdk", "CSSProperty.ts");
  const cssStyleDeclarationPath = path.join(
    packageRoot, "front_end", "core", "sdk", "CSSStyleDeclaration.ts");
  const transforms = new Map([
    [sourcePath, Object.freeze({
      sha256: REVIEWED_STYLES_SIDEBAR_SHA256,
      transform: transformStylesSidebarSource,
    })],
    [stylePropertiesPath, Object.freeze({
      sha256: REVIEWED_STYLE_PROPERTIES_SECTION_SHA256,
      transform: transformStylePropertiesSectionSource,
    })],
    [stylePropertyTreePath, Object.freeze({
      sha256: REVIEWED_STYLE_PROPERTY_TREE_SHA256,
      transform: transformStylePropertyTreeSource,
    })],
    [cssPropertyPath, Object.freeze({
      sha256: REVIEWED_CSS_PROPERTY_SHA256,
      transform: transformCSSPropertySource,
    })],
    [cssStyleDeclarationPath, Object.freeze({
      sha256: REVIEWED_CSS_STYLE_DECLARATION_SHA256,
      transform: transformCSSStyleDeclarationSource,
    })],
  ]);
  return {
    name: "pin-op-chromium-read-only-styles-transform",
    setup(context) {
      context.onLoad({filter: /(?:StylesSidebarPane|StylePropertiesSection|StylePropertyTreeElement|CSSProperty|CSSStyleDeclaration)\.ts$/}, async args => {
        const absolute = path.resolve(args.path);
        const reviewed = transforms.get(absolute);
        if (!reviewed) return undefined;
        const source = await readFile(absolute, "utf8");
        if (sha256(source) !== reviewed.sha256) {
          throw new Error(`Pinned ${path.basename(absolute)} source does not match the reviewed hash`);
        }
        const relativePath = path.relative(packageRoot, absolute).replaceAll(path.sep, "/");
        const transformed = reviewed.transform(source, relativePath);
        return {
          contents: transformed,
          loader: "ts",
          resolveDir: path.dirname(absolute),
        };
      });
    },
  };
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function relativePathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return normalizePath(relative);
}

function reachableStylesInputs({repositoryRoot, entryPoint, metafile}) {
  if (!metafile?.inputs || typeof metafile.inputs !== "object") {
    throw new Error("Chromium Styles build has no metafile input inventory");
  }
  const inputs = Object.keys(metafile.inputs);
  const normalizedInputs = new Map();
  for (const input of inputs) {
    const normalized = normalizePath(input);
    if (normalizedInputs.has(normalized)) {
      throw new Error(`Ambiguous Chromium Styles metafile input: ${normalized}`);
    }
    normalizedInputs.set(normalized, input);
  }
  const relativeEntry = normalizePath(path.relative(repositoryRoot, entryPoint));
  const absoluteEntry = normalizePath(entryPoint);
  const entryInput = normalizedInputs.get(relativeEntry) ?? normalizedInputs.get(absoluteEntry) ??
    inputs.find(input => !input.startsWith("chromium-styles-") &&
      normalizePath(path.resolve(repositoryRoot, input)) === absoluteEntry);
  if (!entryInput) throw new Error("Chromium Styles production entry is absent from the metafile");

  const owningOutputs = Object.entries(metafile.outputs ?? {}).filter(([, output]) =>
    output.inputs && Object.hasOwn(output.inputs, entryInput));
  if (owningOutputs.length !== 1) {
    throw new Error(`Chromium Styles entry must contribute to exactly one output; found ${owningOutputs.length}`);
  }
  const [owningOutputPath, owningOutput] = owningOutputs[0];
  const projectedInputs = Object.keys(owningOutput.inputs);
  for (const input of projectedInputs) {
    if (!normalizedInputs.has(normalizePath(input))) {
      throw new Error(`Chromium Styles owning output input is absent from the metafile: ${input}`);
    }
  }
  return Object.freeze({
    entryInput,
    inputs: Object.freeze(projectedInputs.sort()),
    owningOutputPath,
    owningOutput,
  });
}

async function classifyStylesInputs({
  repositoryRoot,
  packageRoot,
  stylesOverlayRoot,
  baseOverlayRoot,
  inputKeys,
  sharedNamespaces,
}) {
  const packageInputs = [];
  const stylesOverlayInputs = [];
  const baseOverlayInputs = [];
  const sharedInputs = [];
  for (const input of inputKeys) {
    if (input.startsWith(`${sharedNamespaces.css}:`)) {
      sharedInputs.push(input);
      const namespace = `${sharedNamespaces.css}:`;
      // A shared CSS input names its place in the package, not on this machine.
      const absolutePath = await realpath(
        path.resolve(packageRoot, input.slice(namespace.length)),
      );
      const relativePath = relativePathWithin(packageRoot, absolutePath);
      if (!relativePath) throw new Error(`Chromium Styles CSS input is outside the pinned package: ${input}`);
      packageInputs.push(Object.freeze({input, absolutePath, relativePath}));
      continue;
    }
    if ([sharedNamespaces.generated, sharedNamespaces.images].some(namespace => input.startsWith(`${namespace}:`))) {
      sharedInputs.push(input);
      continue;
    }
    const absolutePath = await realpath(path.resolve(repositoryRoot, input));
    const packageRelativePath = relativePathWithin(packageRoot, absolutePath);
    if (packageRelativePath) {
      packageInputs.push(Object.freeze({input, absolutePath, relativePath: packageRelativePath}));
      continue;
    }
    const stylesRelativePath = relativePathWithin(stylesOverlayRoot, absolutePath);
    if (stylesRelativePath) {
      stylesOverlayInputs.push(Object.freeze({input, absolutePath, relativePath: stylesRelativePath}));
      continue;
    }
    const baseRelativePath = relativePathWithin(baseOverlayRoot, absolutePath);
    if (baseRelativePath) {
      baseOverlayInputs.push(Object.freeze({input, absolutePath, relativePath: baseRelativePath}));
      continue;
    }
    throw new Error(`Chromium Styles input is outside the pinned package and reviewed overlays: ${input}`);
  }
  return Object.freeze({
    packageInputs: Object.freeze(packageInputs),
    stylesOverlayInputs: Object.freeze(stylesOverlayInputs),
    baseOverlayInputs: Object.freeze(baseOverlayInputs),
    sharedInputs: Object.freeze(sharedInputs.sort()),
  });
}

async function attestInputs(inputs) {
  const hashes = new Map();
  for (const input of inputs) {
    if (!hashes.has(input.relativePath)) {
      hashes.set(input.relativePath, sha256(await readFile(input.absolutePath)));
    }
  }
  const rows = [...hashes]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relativePath, hash]) => `${relativePath}\0${hash}`);
  return Object.freeze({fileCount: rows.length, sha256: sha256(`${rows.join("\n")}\n`)});
}

async function requiredStylesLicenseFiles(packageRoot, packageInputs) {
  const reviewedThirdPartyLicenses = new Map([
    ["codemirror.next", "front_end/third_party/codemirror.next/LICENSE"],
    ["lit", "front_end/third_party/lit/LICENSE"],
  ]);
  const requiredPaths = new Set(["LICENSE"]);
  for (const input of packageInputs) {
    const match = /^front_end\/third_party\/([^/]+)\//.exec(input.relativePath);
    if (!match) continue;
    const licensePath = reviewedThirdPartyLicenses.get(match[1]);
    if (!licensePath) {
      throw new Error(`Chromium Styles closure has an unreviewed third-party license: ${match[1]}`);
    }
    requiredPaths.add(licensePath);
  }
  return Object.freeze(await Promise.all([...requiredPaths].sort().map(async relativePath => {
    const absolutePath = assertWithin(
      packageRoot,
      path.resolve(packageRoot, ...relativePath.split("/")),
      "Chromium Styles license",
    );
    return Object.freeze({path: relativePath, sha256: sha256(await readFile(absolutePath))});
  })));
}

function stylesOutputForEntry(metafile, entryInput) {
  const outputs = Object.entries(metafile.outputs ?? {}).filter(([, output]) =>
    output.inputs && Object.hasOwn(output.inputs, entryInput));
  if (outputs.length !== 1) {
    throw new Error(`Chromium Styles entry must contribute to exactly one output; found ${outputs.length}`);
  }
  return outputs[0];
}

export async function prepareChromiumReadOnlyStylesBuild(repositoryRoot) {
  const physicalRoot = await realpath(repositoryRoot);
  const packageRoot = await resolvePinnedPackage(physicalRoot);
  const overlay = await verifyChromiumReadOnlyStylesOverlay(physicalRoot, packageRoot);
  const baseOverlay = await verifyChromiumReadOnlyElementsOverlay(physicalRoot);
  const stylesOverlayRoot = overlay.overlayRoot;
  const baseOverlayRoot = await realpath(baseOverlay.overlayRoot);
  const entryPoint = await realpath(path.join(
    physicalRoot,
    ...CHROMIUM_READ_ONLY_STYLES_RUNTIME.entryPoint.split("/"),
  ));
  if (!relativePathWithin(stylesOverlayRoot, entryPoint)) {
    throw new Error("Chromium Styles entry is outside its reviewed overlay");
  }
  const resolutions = stylesResolutions({stylesRoot: stylesOverlayRoot, baseOverlay, packageRoot});
  const reviewedImporters = Object.freeze(new Set([
    ...Object.keys(overlay.manifest.overlayFiles).map(relativePath =>
      path.resolve(stylesOverlayRoot, ...relativePath.split("/"))),
    ...Object.keys(overlay.manifest.upstreamFiles).map(relativePath =>
      path.resolve(packageRoot, ...relativePath.split("/"))),
    ...[
      "front_end/core/i18n/i18nImpl.ts",
      "front_end/core/platform/HostRuntime.ts",
      "front_end/ui/legacy/Treeoutline.ts",
      "front_end/ui/legacy/components/inline_editor/ColorSwatch.ts",
    ].map(relativePath => path.resolve(packageRoot, ...relativePath.split("/"))),
    path.resolve(baseOverlayRoot, "facades", "core-styles.ts"),
    path.resolve(baseOverlayRoot, "facades", "ui-utils.ts"),
  ]));
  const shared = await createChromiumSharedRuntimePlugins({packageRoot, allowedImporters: reviewedImporters});
  const createScopedPlugins = sharedRuntime => {
    assertChromiumSharedRuntimeAuthority(sharedRuntime, packageRoot);
    return Object.freeze([
      chromiumPackagePlugin(packageRoot, Object.freeze([
        stylesOverlayRoot,
        path.join(baseOverlayRoot, "facades"),
      ]), sharedRuntime),
      exactStylesResolutionPlugin(packageRoot, resolutions),
      createChromiumReadOnlySourceTransformPlugin(baseOverlay),
      readOnlyStylesSourceTransformPlugin(packageRoot),
    ].map(plugin => Object.freeze(plugin)));
  };
  const scopedPlugins = createScopedPlugins(shared);
  const plugins = Object.freeze([...scopedPlugins, ...shared.plugins]);
  const verifyBuild = async (result, sharedRuntime = shared) => {
    assertChromiumSharedRuntimeAuthority(sharedRuntime, packageRoot);
    const reachable = reachableStylesInputs({repositoryRoot: physicalRoot, entryPoint, metafile: result?.metafile});
    const classifiedInputs = await classifyStylesInputs({
      repositoryRoot: physicalRoot,
      packageRoot,
      stylesOverlayRoot,
      baseOverlayRoot,
      inputKeys: reachable.inputs,
      sharedNamespaces: sharedRuntime.namespaces,
    });
    const sharedInputVerification = sharedRuntime.verifyInputs(classifiedInputs.sharedInputs);
    if (
      JSON.stringify(sharedInputVerification.inputInventory) !==
      JSON.stringify(overlay.manifest.reviewedSharedInputInventory)
    ) {
      throw new Error("Chromium Styles shared input inventory mismatch");
    }
    assertAttestation(
      sharedInputVerification.payloadAttestation,
      overlay.manifest.reviewedSharedPayloadAttestation,
      "Chromium Styles shared payload",
    );
    const [, output] = stylesOutputForEntry(result.metafile, reachable.entryInput);
    const standalone = normalizePath(output.entryPoint ?? "") ===
      normalizePath(path.relative(physicalRoot, entryPoint));
    if (standalone && (
      !Array.isArray(output.exports) ||
      output.exports.length !== overlay.manifest.productionExports.length ||
      output.exports.some((name, index) => name !== overlay.manifest.productionExports[index])
    )) {
      throw new Error("Chromium Styles production entry exports unreviewed authority");
    }
    const unminifiedBytes = standalone ? output.bytes : reachable.inputs.reduce(
      (total, input) => total + (output.inputs?.[input]?.bytesInOutput ?? 0),
      0,
    );
    if (!Number.isSafeInteger(unminifiedBytes)) {
      throw new Error("Chromium Styles runtime build did not produce JavaScript");
    }
    if (unminifiedBytes > CHROMIUM_READ_ONLY_STYLES_RUNTIME.maxUnminifiedBytes) {
      throw new Error(
        `Chromium Styles runtime exceeds ${CHROMIUM_READ_ONLY_STYLES_RUNTIME.maxUnminifiedBytes} bytes: ${unminifiedBytes}`,
      );
    }
    const packageInputAttestation = await attestInputs(classifiedInputs.packageInputs);
    const stylesOverlayAttestation = await attestInputs(classifiedInputs.stylesOverlayInputs);
    const baseOverlayAttestation = await attestInputs(classifiedInputs.baseOverlayInputs);
    assertAttestation(
      packageInputAttestation,
      overlay.manifest.reviewedPackageClosure,
      "Chromium Styles package closure",
    );
    assertAttestation(
      stylesOverlayAttestation,
      overlay.manifest.reviewedStylesOverlayClosure,
      "Chromium Styles overlay closure",
    );
    assertAttestation(
      baseOverlayAttestation,
      overlay.manifest.reviewedBaseOverlayClosure,
      "Chromium Styles base overlay closure",
    );
    if (reachable.inputs.length !== overlay.manifest.reviewedInputCount) {
      throw new Error(
        `Chromium Styles input count mismatch: ${reachable.inputs.length}`,
      );
    }
    const canonicalImageInput = `${sharedRuntime.namespaces.images}:${path.join(packageRoot, "front_end", "Images", "Images.js")}`;
    const manifestGeneratedInputs = sharedInputVerification.generatedInputs.map(input =>
      input === canonicalImageInput ? `${sharedRuntime.namespaces.images}:front_end/Images/Images.js` : input);
    const reviewedGeneratedInputs = [...overlay.manifest.reviewedGeneratedInputs].sort();
    if (
      manifestGeneratedInputs.length !== reviewedGeneratedInputs.length ||
      manifestGeneratedInputs.some((input, index) => input !== reviewedGeneratedInputs[index])
    ) {
      throw new Error("Chromium Styles generated input inventory mismatch");
    }
    const requiredLicenseFiles = await requiredStylesLicenseFiles(
      packageRoot,
      classifiedInputs.packageInputs,
    );
    assertHashInventory(
      Object.fromEntries(requiredLicenseFiles.map(file => [file.path, file.sha256])),
      overlay.manifest.requiredLicenseFiles,
      "Chromium Styles license",
    );
    return Object.freeze({
      verifiedInputKeys: reachable.inputs,
      classifiedInputs,
      packageInputAttestation,
      stylesOverlayAttestation,
      baseOverlayAttestation,
      requiredLicenseFiles,
      requiredImageFiles: overlay.requiredImageFiles,
      generatedInputs: sharedInputVerification.generatedInputs,
      sharedInputInventory: sharedInputVerification.inputInventory,
      payloadAttestation: sharedInputVerification.payloadAttestation,
      unminifiedBytes,
    });
  };
  return Object.freeze({
    repositoryRoot: physicalRoot,
    packageRoot,
    entryPoint,
    plugins,
    scopedPlugins,
    createScopedPlugins: Object.freeze(createScopedPlugins),
    sharedRuntime: shared,
    sharedImporterPaths: Object.freeze([...reviewedImporters].sort()),
    browserTargets: CHROMIUM_READ_ONLY_STYLES_RUNTIME.browserTargets,
    verifyBuild,
  });
}

export async function bundleChromiumReadOnlyStylesRuntime({
  repositoryRoot,
  write = false,
  outfile,
}) {
  const physicalRoot = await realpath(repositoryRoot);
  const prepared = await prepareChromiumReadOnlyStylesBuild(physicalRoot);
  const result = await build({
    absWorkingDir: physicalRoot,
    entryPoints: [prepared.entryPoint],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: prepared.browserTargets,
    treeShaking: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    write,
    outfile: outfile ?? path.join(physicalRoot, "chromium-read-only-styles-runtime.js"),
    logLevel: "silent",
    plugins: prepared.plugins,
  });
  const output = Object.entries(result.metafile.outputs).find(([name]) => name.endsWith(".js"));
  const verification = await prepared.verifyBuild(result);
  return Object.freeze({
    code: write ? "" : new TextDecoder().decode(result.outputFiles[0].contents),
    entryPoint: path.relative(physicalRoot, prepared.entryPoint).replaceAll(path.sep, "/"),
    metafile: result.metafile,
    packageRoot: prepared.packageRoot,
    exports: output?.[1].exports ?? [],
    ...verification,
  });
}
