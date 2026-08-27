import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";

import {build} from "esbuild";

import {
  bundleChromiumReadOnlyStylesRuntime,
  CHROMIUM_READ_ONLY_STYLES_RUNTIME,
  prepareChromiumReadOnlyStylesBuild,
  verifyChromiumReadOnlyStylesOverlayInventory,
} from "../chromium-devtools-styles-runtime.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");

test("does not intercept CSS or skill imports from foreign importers", async () => {
  const fixtureRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-styles-foreign-"));
  try {
    const prepared = await prepareChromiumReadOnlyStylesBuild(repositoryRoot);
    const cssEntry = path.join(fixtureRoot, "foreign-css.mjs");
    const skillEntry = path.join(fixtureRoot, "foreign-skill.mjs");
    await writeFile(cssEntry, "import './private.css.js';\n");
    await writeFile(path.join(fixtureRoot, "private.css"), ".foreign { color: red; }\n");
    await writeFile(skillEntry, "import './private.skill.js';\n");

    for (const entryPoint of [cssEntry, skillEntry]) {
      await assert.rejects(
        build({entryPoints: [entryPoint], bundle: true, write: false, logLevel: "silent", plugins: prepared.plugins}),
        /Could not resolve/,
      );
    }
  } finally {
    await rm(fixtureRoot, {recursive: true, force: true});
  }
});

test("pins the native Chromium Styles runtime to the reviewed package", async () => {
  assert.equal(CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion, "1.0.1681091");
  assert.deepEqual(CHROMIUM_READ_ONLY_STYLES_RUNTIME.browserTargets, [
    "chrome116",
    "firefox142",
  ]);

  const result = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});

  assert.match(result.code, /StylesSidebarPane\s*=\s*class/);
  assert.match(result.code, /StylePropertiesSection\s*=\s*class/);
  assert.match(result.code, /CSSMatchedStyles\s*=\s*class/);
  assert.equal(result.metafile.inputs[result.entryPoint]?.bytes > 0, true);
});

test("exports a high-level createPane runtime without protocol writer fields", async () => {
  const result = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const runtimeSource = result.code.slice(result.code.indexOf(
    "// third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
  ));

  assert.match(result.code, /createPane/);
  assert.match(runtimeSource, /winning-known-author/);
  assert.match(runtimeSource, /overridden-known-author/);
  assert.doesNotMatch(runtimeSource, /styleSheetId\s*:/);
  assert.doesNotMatch(runtimeSource, /range\s*:/);
  assert.deepEqual(result.exports, [
    "chromiumReadOnlyStylesRuntime",
  ]);
});

test("installs matched styles through the native pane and fences stale work", async () => {
  const result = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});

  assert.match(result.code, /pinOpPresentMatchedStyles/);
  assert.match(result.code, /innerRebuildUpdate\(signal/);
  assert.match(result.code, /pinOpClearReadOnlyStyles/);
  assert.match(result.code, /new AbortController\(\)/);
  assert.doesNotMatch(result.code, /pin-op-native-styles-sections/);
});

test("binds duplicate rules by payload identity and never invents source coordinates", async () => {
  const runtimeSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
    import.meta.url,
  ), "utf8");

  assert.match(runtimeSource, /pin-op-rule:/);
  assert.doesNotMatch(runtimeSource, /takeMatchingRule/);
  assert.match(runtimeSource, /source\.lineNumber === undefined/);
  assert.doesNotMatch(runtimeSource, /source\.lineNumber \?\? 1/);
});

test("preserves native show-all classes for large read-only sections", async () => {
  const facadeSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/ui-utils.ts",
    import.meta.url,
  ), "utf8");

  assert.match(facadeSource, /opts\?\.className/);
  assert.match(facadeSource, /addEventListener\(['"]click['"],\s*handler\)/);
});

test("renders every reviewed nested CSS context without model authority", async () => {
  const [componentsSource, protocolSource, sdkSource, runtimeSource] = await Promise.all([
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/elements-components.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/protocol.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/sdk.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
      import.meta.url,
    ), "utf8"),
  ]);

  assert.match(componentsSource, /export const CSSQuery = Object\.freeze\(\{CSSQuery:/);
  assert.match(componentsSource, /parseStyleQueries\(\): void \{\}/);
  assert.doesNotMatch(componentsSource, /fetch\(|setStyleText|invoke_/);
  assert.match(protocolSource, /LayerRule:\s*['"]LayerRule['"]/);
  assert.match(sdkSource, /readableLayerName/);
  assert.match(runtimeSource, /ruleTypes/);
  assert.match(runtimeSource, /getContainerForNode\([\s\S]*Promise\.resolve\(undefined\)/);
  assert.doesNotMatch(runtimeSource, /getContainerForNode[\s\S]{0,300}(?:fetch|invoke_|sendCommand)/);
});

test("expands broad Chromium shorthands through detached read-only CSSOM", async () => {
  const runtimeSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
    import.meta.url,
  ), "utf8");

  assert.match(runtimeSource, /cssMetadata\(\)\.getLonghands/);
  assert.match(runtimeSource, /document\.createElement\(['"]span['"]\)\.style/);
  assert.match(runtimeSource, /getPropertyValue\(longhandName\)/);
  assert.doesNotMatch(runtimeSource, /longhandsByShorthand/);
  assert.doesNotMatch(runtimeSource, /appendChild|append\(scratch|document\.body/);
});

test("aborts stale origin listeners on refresh, clear, and dispose", async () => {
  const runtimeSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
    import.meta.url,
  ), "utf8");

  assert.match(runtimeSource, /#originController/);
  assert.match(runtimeSource, /addEventListener\(['"]click['"][\s\S]*signal:/);
  assert.equal((runtimeSource.match(/#originController\?\.abort\(\)/g) ?? []).length >= 3, true);
});

test("bootstraps pinned tokens and visible read-only icons", async () => {
  const [runtimeSource, kitSource, uiSource] = await Promise.all([
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/kit.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/ui.ts",
      import.meta.url,
    ), "utf8"),
  ]);

  assert.match(runtimeSource, /patches\/1\.0\.1681091\/facades\/core-styles\.js/);
  assert.match(kitSource, /#chromium\/Images\/Images\.js/);
  assert.match(kitSource, /mask:\s*var\(--pin-op-icon-image\)/);
  for (const name of ["triangle-right", "triangle-down", "filter", "open-externally"]) {
    assert.match(kitSource, new RegExp(`['"]${name}['"]`));
  }
  assert.match(uiSource, /pin-op-filter-icon/);
  assert.match(runtimeSource, /pin-op-rule-origin-icon/);
});

test("keeps empty transitions focus-safe and renders inherited labels", async () => {
  const [runtimeSource, builderSource] = await Promise.all([
    readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../chromium-devtools-styles-runtime.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(runtimeSource, /snapshot\.matchedRules\.length === 0 \? emptyInlineStylePayload\(\)/);
  assert.match(runtimeSource, /ancestorIndex: number/);
  assert.match(runtimeSource, /displayLabel: string/);
  assert.match(runtimeSource, /`inherited:\$\{item\.ancestorIndex\}`/);
  assert.doesNotMatch(runtimeSource, /item\.displayLabel \?\? item\.nodeRef/);
  assert.match(runtimeSource, /pinOpInheritedLabel/);
  assert.match(builderSource, /pin-op-inherited-node-label/);
  assert.doesNotMatch(builderSource, /DOMLinkifier\.Linkifier\.instance\(\)\.linkify/);
  assert.match(builderSource, /focusedElementAtStart/);
  assert.match(builderSource, /shouldRestoreSectionFocus/);
  assert.match(builderSource, /this\.sectionBlocks\[0\]\?\.sections\[0\]\?\.element\.focus\(\)/);
  assert.match(runtimeSource, /mount\.style\.overflow = ['"]hidden['"]/);
  assert.match(runtimeSource, /this\.element\.style\.overflow = ['"]auto['"]/);
  assert.match(runtimeSource, /this\.#previousMountStyle/);
});

test("exposes one-pass verified Styles build preparation", async () => {
  const prepared = await prepareChromiumReadOnlyStylesBuild(repositoryRoot);

  assert.equal(prepared.entryPoint.endsWith("/entrypoints/read-only-styles.ts") ||
    prepared.entryPoint.endsWith("\\entrypoints\\read-only-styles.ts"), true);
  assert.equal(prepared.packageRoot.includes("chrome-devtools-frontend"), true);
  assert.deepEqual(prepared.plugins.map(plugin => plugin.name), [
    "pin-op-chromium-styles-package",
    "pin-op-chromium-exact-styles-resolutions",
    "pin-op-chromium-read-only-styles-transform",
    "pin-op-chromium-styles-generated",
  ]);

  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  assert.equal(bundled.verifiedInputKeys.length, Object.keys(bundled.metafile.inputs).length);
  assert.equal(bundled.unminifiedBytes <= CHROMIUM_READ_ONLY_STYLES_RUNTIME.maxUnminifiedBytes, true);
  assert.equal(bundled.classifiedInputs.packageInputs.length > 0, true);
  assert.equal(bundled.classifiedInputs.stylesOverlayInputs.length > 0, true);
});

test("uses pinned Chromium parsing and structured property rendering", async () => {
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const inputs = Object.keys(bundled.metafile.inputs).map(value => value.replaceAll("\\", "/"));

  for (const source of [
    "front_end/core/sdk/CSSPropertyParser.ts",
    "front_end/core/sdk/CSSPropertyParserMatchers.ts",
    "front_end/panels/elements/PropertyRenderer.ts",
    "front_end/ui/legacy/components/inline_editor/ColorSwatch.ts",
  ]) {
    assert.equal(inputs.some(input => input.endsWith(source)), true, `${source} is outside the production closure`);
  }
  assert.match(bundled.code, /new ColorRenderer\([^)]*,\s*null\)/);
  assert.match(bundled.code, /longhandProperties:\s*readOnlyLonghandProperties/);
  assert.doesNotMatch(bundled.code, /valueElement\.textContent\s*=\s*property\.value/);
});

test("pins Styles overlay bytes to LF across platforms", async () => {
  const attributes = await readFile(new URL("../../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /^third_party\/chromium-devtools-frontend\/styles-overlay\/\*\* text eol=lf$/m);
});

test("removes writer, editor, AI, and network authority from the full Styles bundle", async () => {
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const cssProperty = bundledModule(bundled.code, "front_end/core/sdk/CSSProperty.ts");
  const cssStyle = bundledModule(bundled.code, "front_end/core/sdk/CSSStyleDeclaration.ts");
  const stylesPane = bundledModule(bundled.code, "front_end/panels/elements/StylesSidebarPane.ts");

  for (const writer of ["setText(", "setDisabled(", "setValue(", "setLocalValue("]) {
    assert.doesNotMatch(cssProperty, new RegExp(writer.replace("(", "\\(")));
  }
  for (const writer of ["setText(", "newBlankProperty(", "insertPropertyAt(", "appendProperty("]) {
    assert.doesNotMatch(cssStyle, new RegExp(writer.replace("(", "\\(")));
  }
  assert.doesNotMatch(stylesPane, /class CSSPropertyPrompt|triggerAiCodeCompletion|AIDA_REQUEST/);
  assert.doesNotMatch(bundled.code, /\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\b/);
  for (const forbidden of ["StylesAiCodeCompletionProvider", "AidaClient", "StylesAi"]) {
    assert.equal(bundled.code.includes(forbidden), false, `${forbidden} remains in the emitted bundle`);
    assert.equal(bundled.verifiedInputKeys.some(input => input.includes(forbidden)), false,
      `${forbidden} remains in the verified closure`);
  }
  const inertFacadeSources = await Promise.all(["styles-dependencies.ts", "host.ts"].map(file => readFile(new URL(
    `../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/${file}`,
    import.meta.url,
  ), "utf8")));
  assert.doesNotMatch(inertFacadeSources.join("\n"), /StylesAiCodeCompletionProvider|AidaClient|StylesAi/);
});

test("attests the exact Styles closure, overlay, and third-party licenses", async () => {
  const manifest = JSON.parse(await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/manifest.json",
    import.meta.url,
  ), "utf8"));
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});

  assert.equal(bundled.verifiedInputKeys.length, manifest.reviewedInputCount);
  assert.deepEqual(bundled.packageInputAttestation, manifest.reviewedPackageClosure);
  assert.deepEqual(bundled.stylesOverlayAttestation, manifest.reviewedStylesOverlayClosure);
  assert.deepEqual(bundled.baseOverlayAttestation, manifest.reviewedBaseOverlayClosure);
  assert.deepEqual(bundled.classifiedInputs.generatedInputs, manifest.reviewedGeneratedInputs);
  assert.deepEqual(
    Object.fromEntries(bundled.requiredImageFiles.map(file => [file.path, file.sha256])),
    manifest.requiredImageFiles,
  );
  const inputs = bundled.verifiedInputKeys.map(value => value.replaceAll("\\", "/"));
  assert.equal(inputs.some(input => input.endsWith("front_end/design_system_tokens.css")), true);
  assert.equal(inputs.some(input => input.endsWith("front_end/application_tokens.css")), true);
  assert.deepEqual(
    Object.fromEntries(bundled.requiredLicenseFiles.map(file => [file.path, file.sha256])),
    manifest.requiredLicenseFiles,
  );
});

test("rejects tampered, extra, and missing Styles overlay files", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pin-op-styles-overlay-"));
  const nested = path.join(fixtureRoot, "facades");
  const entry = path.join(fixtureRoot, "entry.ts");
  const facade = path.join(nested, "sdk.ts");
  const digest = value => createHash("sha256").update(value).digest("hex");
  const expected = {
    "entry.ts": digest("entry\n"),
    "facades/sdk.ts": digest("facade\n"),
  };
  try {
    await mkdir(nested);
    await writeFile(entry, "entry\n");
    await writeFile(facade, "facade\n");
    await verifyChromiumReadOnlyStylesOverlayInventory({overlayRoot: fixtureRoot, expectedFiles: expected});

    await writeFile(entry, "tampered\n");
    await assert.rejects(
      verifyChromiumReadOnlyStylesOverlayInventory({overlayRoot: fixtureRoot, expectedFiles: expected}),
      /hash mismatch for entry\.ts/,
    );

    await writeFile(entry, "entry\n");
    await writeFile(path.join(fixtureRoot, "extra.ts"), "extra\n");
    await assert.rejects(
      verifyChromiumReadOnlyStylesOverlayInventory({overlayRoot: fixtureRoot, expectedFiles: expected}),
      /inventory mismatch/,
    );

    await rm(path.join(fixtureRoot, "extra.ts"));
    await rm(facade);
    await assert.rejects(
      verifyChromiumReadOnlyStylesOverlayInventory({overlayRoot: fixtureRoot, expectedFiles: expected}),
      /inventory mismatch/,
    );
  } finally {
    await rm(fixtureRoot, {recursive: true, force: true});
  }
});

function bundledModule(code, sourcePath) {
  const marker = `// node_modules/.pnpm/chrome-devtools-frontend@1.0.1681091/node_modules/chrome-devtools-frontend/${sourcePath}`;
  const start = code.indexOf(marker);
  assert.notEqual(start, -1, `${sourcePath} marker`);
  const end = code.indexOf("\n// ", start + marker.length);
  return code.slice(start, end === -1 ? undefined : end);
}
