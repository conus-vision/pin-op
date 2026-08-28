import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {build} from "esbuild";

import {
  createChromiumSharedRuntimePlugins,
  prepareChromiumReadOnlyElementsBuild,
} from "../chromium-devtools-runtime.mjs";

import {
  bundleChromiumReadOnlyStylesRuntime,
  CHROMIUM_READ_ONLY_STYLES_RUNTIME,
  prepareChromiumReadOnlyStylesBuild,
  verifyChromiumReadOnlyStylesOverlayInventory,
} from "../chromium-devtools-styles-runtime.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("does not intercept CSS or skill imports from foreign importers", async () => {
  const fixtureRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-styles-foreign-"));
  try {
    const prepared = await prepareChromiumReadOnlyStylesBuild(repositoryRoot);
    const cssEntry = path.join(fixtureRoot, "foreign-css.mjs");
    const skillEntry = path.join(fixtureRoot, "foreign-skill.mjs");
    const imageEntry = path.join(fixtureRoot, "foreign-image.mjs");
    await writeFile(cssEntry, "import './private.css.js';\n");
    await writeFile(path.join(fixtureRoot, "private.css"), ".foreign { color: red; }\n");
    await writeFile(skillEntry, "import './private.skill.js';\n");
    await writeFile(imageEntry, "import '#chromium/Images/Images.js';\n");

    const pluginOrders = [
      prepared.plugins,
      Object.freeze([...prepared.sharedRuntime.plugins, ...prepared.scopedPlugins]),
    ];
    for (const entryPoint of [cssEntry, skillEntry, imageEntry]) {
      for (const plugins of pluginOrders) {
        await assert.rejects(
          build({entryPoints: [entryPoint], bundle: true, write: false, logLevel: "silent", plugins}),
          /Could not resolve/,
        );
      }
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

test("rejects a tampered base resolution before preparing standalone Styles", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pin-op-styles-base-provenance-"));
  const thirdPartyRoot = path.join(fixtureRoot, "third_party", "chromium-devtools-frontend");
  const packageLinkRoot = path.join(fixtureRoot, "node_modules");
  const packageRoot = await realpath(path.join(repositoryRoot, "node_modules", "chrome-devtools-frontend"));
  try {
    await mkdir(thirdPartyRoot, {recursive: true});
    await mkdir(packageLinkRoot, {recursive: true});
    await cp(
      path.join(repositoryRoot, "third_party", "chromium-devtools-frontend", "patches"),
      path.join(thirdPartyRoot, "patches"),
      {recursive: true},
    );
    await cp(
      path.join(repositoryRoot, "third_party", "chromium-devtools-frontend", "styles-overlay"),
      path.join(thirdPartyRoot, "styles-overlay"),
      {recursive: true},
    );
    await cp(path.join(repositoryRoot, "pnpm-lock.yaml"), path.join(fixtureRoot, "pnpm-lock.yaml"));
    await symlink(packageRoot, path.join(packageLinkRoot, "chrome-devtools-frontend"), "junction");

    const manifestPath = path.join(
      thirdPartyRoot, "patches", CHROMIUM_READ_ONLY_STYLES_RUNTIME.packageVersion, "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.ok(manifest.resolutions.length > 1);
    manifest.resolutions[0].facade = manifest.resolutions[1].facade;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      prepareChromiumReadOnlyStylesBuild(fixtureRoot),
      /Chromium read-only overlay manifest hash mismatch/,
    );
  } finally {
    await rm(fixtureRoot, {recursive: true, force: true});
  }
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

test("stacks Rules status with the native pane and restores mount direction", async () => {
  const runtimeSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/runtime/read-only-styles-runtime.ts",
    import.meta.url,
  ), "utf8");

  assert.match(runtimeSource, /flexDirection: options\.mount\.style\.flexDirection/);
  assert.match(runtimeSource, /options\.mount\.style\.flexDirection = ['"]column['"]/);
  assert.match(
    runtimeSource,
    /this\.#mount\.style\.flexDirection = this\.#previousMountStyle\.flexDirection/,
  );
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
  assert.match(
    runtimeSource,
    /button\.className = ['"]text-button link-style devtools-link pin-op-rule-origin['"]/,
  );
  assert.match(runtimeSource, /button\.style\.inlineSize = ['"]100px['"]/);
  assert.match(runtimeSource, /button\.style\.maxInlineSize = ['"]100%['"]/);
  assert.match(runtimeSource, /button\.style\.textOverflow = ['"]ellipsis['"]/);
});

test("uses Chromium-faithful read-only toolbar controls instead of browser-native inputs", async () => {
  const uiSource = await readFile(new URL(
    "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/facades/ui.ts",
    import.meta.url,
  ), "utf8");

  assert.match(uiSource, /class ReadOnlyToolbarPrompt/);
  assert.match(uiSource, /className = ['"]toolbar-input-prompt text-prompt['"]/);
  assert.match(uiSource, /setAttribute\(['"]contenteditable['"], ['"]plaintext-only['"]\)/);
  assert.match(uiSource, /className = ['"]toolbar-prompt-proxy['"]/);
  assert.match(uiSource, /className = ['"]toolbar-input toolbar-filter toolbar-input-empty['"]/);
  assert.match(uiSource, /createReadOnlyIconButton\(['"]cross-circle-filled['"]/);
  assert.match(uiSource, /createReadOnlyIconButton\(['"]regular-expression['"]/);
  assert.match(uiSource, /addEventListener\(['"]beforeinput['"]/);
  assert.match(uiSource, /inputType === ['"]insertParagraph['"]/);
  assert.match(uiSource, /inputType === ['"]insertLineBreak['"]/);
  assert.match(uiSource, /singleLineToolbarText/);
  assert.match(uiSource, /const growFactor = args\[1\]/);
  assert.match(uiSource, /const shrinkFactor = args\[2\]/);
  assert.match(uiSource, /this\.element\.style\.flexGrow = String\(growFactor\)/);
  assert.match(uiSource, /this\.element\.style\.flexShrink = String\(shrinkFactor\)/);
  assert.doesNotMatch(uiSource, /document\.createElement\(['"]input['"]\)/);
  assert.doesNotMatch(uiSource, /button\.textContent = ['"]\.\*['"]/);
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
  const builderSource = await readFile(new URL("../chromium-devtools-styles-runtime.mjs", import.meta.url), "utf8");

  assert.equal(prepared.entryPoint.endsWith("/entrypoints/read-only-styles.ts") ||
    prepared.entryPoint.endsWith("\\entrypoints\\read-only-styles.ts"), true);
  assert.equal(prepared.packageRoot.includes("chrome-devtools-frontend"), true);
  assert.deepEqual(prepared.plugins.map(plugin => plugin.name), [
    "pin-op-chromium-styles-package",
    "pin-op-chromium-exact-styles-resolutions",
    "chromium-devtools-read-only-source-transforms",
    "pin-op-chromium-read-only-styles-transform",
    "chromium-devtools-css-module",
    "chromium-devtools-generated-modules",
    "chromium-devtools-browser-runtime",
  ]);
  assert.equal(Object.isFrozen(prepared.scopedPlugins), true);
  assert.equal(Object.isFrozen(prepared.sharedRuntime), true);
  assert.equal(Object.isFrozen(prepared.sharedImporterPaths), true);
  assert.equal(typeof prepared.createScopedPlugins, "function");
  assert.deepEqual(prepared.plugins.slice(0, prepared.scopedPlugins.length), prepared.scopedPlugins);
  assert.match(builderSource, /sharedRuntime\.resolveImagesInput\(\{importer: args\.importer\}\)/);
  assert.doesNotMatch(builderSource, /namespace: sharedRuntime\.namespaces\.images/);
  assert.throws(
    () => prepared.createScopedPlugins(Object.freeze({
      plugins: Object.freeze([]),
      namespaces: prepared.sharedRuntime.namespaces,
      resolveCssInput() {},
      verifyInputs() {},
    })),
    /invalid package or namespace authority/,
  );

  const oppositeOrder = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [prepared.entryPoint],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: prepared.browserTargets,
    treeShaking: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: "silent",
    plugins: Object.freeze([
      ...prepared.sharedRuntime.plugins,
      ...prepared.createScopedPlugins(prepared.sharedRuntime),
    ]),
  });
  const oppositeVerification = await prepared.verifyBuild(oppositeOrder, prepared.sharedRuntime);
  assert.deepEqual(oppositeVerification.sharedInputInventory,
    JSON.parse(await readFile(new URL(
      "../../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/manifest.json",
      import.meta.url,
    ), "utf8")).reviewedSharedInputInventory);

  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  assert.equal(bundled.verifiedInputKeys.length <= Object.keys(bundled.metafile.inputs).length, true);
  assert.equal(bundled.unminifiedBytes <= CHROMIUM_READ_ONLY_STYLES_RUNTIME.maxUnminifiedBytes, true);
  assert.equal(bundled.classifiedInputs.packageInputs.length > 0, true);
  assert.equal(bundled.classifiedInputs.stylesOverlayInputs.length > 0, true);
});

test("builds DOM and Styles with one branded shared runtime in either plugin order", async () => {
  const [dom, styles] = await Promise.all([
    prepareChromiumReadOnlyElementsBuild(repositoryRoot),
    prepareChromiumReadOnlyStylesBuild(repositoryRoot),
  ]);
  const unionImporters = Object.freeze(new Set([
    ...dom.sharedImporterPaths,
    ...styles.sharedImporterPaths,
  ]));
  const unionShared = await createChromiumSharedRuntimePlugins({
    packageRoot: styles.packageRoot,
    allowedImporters: unionImporters,
  });
  const pluginOrders = [
    [...dom.createScopedPlugins(unionShared), ...styles.createScopedPlugins(unionShared), ...unionShared.plugins],
    [...unionShared.plugins, ...styles.createScopedPlugins(unionShared), ...dom.createScopedPlugins(unionShared)],
  ];
  const resolutionSignatures = [];
  const completeBuildSignatures = [];
  for (const plugins of pluginOrders) {
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: {dom: dom.entryPoint, styles: styles.entryPoint},
      outdir: path.join(repositoryRoot, ".tmp-combined-runtime-output"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: styles.browserTargets,
      treeShaking: true,
      minify: false,
      sourcemap: false,
      metafile: true,
      write: false,
      logLevel: "silent",
      plugins,
    });
    const [domVerification, stylesVerification] = await Promise.all([
      dom.verifyBuild(result, unionShared),
      styles.verifyBuild(result, unionShared),
    ]);
    assert.equal(domVerification.verifiedInputKeys.some(input => input.includes("styles-overlay")), false);
    assert.equal(stylesVerification.verifiedInputKeys.some(input =>
      input.replaceAll("\\", "/").endsWith("patches/1.0.1681091/entrypoints/read-only-elements.ts")), false);
    assert.equal(domVerification.verifiedInputKeys.some(input => input.endsWith("ElementsTreeOutline.ts")), true);
    assert.equal(stylesVerification.verifiedInputKeys.some(input => input.endsWith("StylesSidebarPane.ts")), true);

    if (resolutionSignatures.length === 0) {
      const leakedMetafile = structuredClone(result.metafile);
      const domEntryInput = Object.keys(leakedMetafile.inputs).find(input =>
        input.replaceAll("\\", "/").endsWith("patches/1.0.1681091/entrypoints/read-only-elements.ts"));
      const leakedInput = Object.keys(leakedMetafile.inputs).find(input =>
        input.replaceAll("\\", "/").endsWith("styles-overlay/1.0.1681091/facades/platform.ts"));
      const domOutput = Object.values(leakedMetafile.outputs).find(output =>
        domEntryInput && output.inputs && Object.hasOwn(output.inputs, domEntryInput));
      assert.ok(domEntryInput && leakedInput && domOutput);
      domOutput.inputs[leakedInput] = {bytesInOutput: 1};
      await assert.rejects(
        dom.verifyBuild({...result, metafile: leakedMetafile}, unionShared),
        /(?:unreachable contributing input|outside the pinned package and overlay)/,
      );

      const stylesEntryInput = Object.keys(leakedMetafile.inputs).find(input =>
        input.replaceAll("\\", "/").endsWith("styles-overlay/1.0.1681091/entrypoints/read-only-styles.ts"));
      const foreignInput = Object.keys(leakedMetafile.inputs).find(input =>
        input.replaceAll("\\", "/").endsWith("patches/1.0.1681091/entrypoints/read-only-elements.ts"));
      const stylesOutput = Object.values(leakedMetafile.outputs).find(output =>
        stylesEntryInput && output.inputs && Object.hasOwn(output.inputs, stylesEntryInput));
      assert.ok(stylesEntryInput && foreignInput && stylesOutput);
      stylesOutput.inputs[foreignInput] = {bytesInOutput: 1};
      await assert.rejects(
        styles.verifyBuild({...result, metafile: leakedMetafile}, unionShared),
        /(?:outside the pinned package and reviewed overlays|base overlay closure mismatch)/,
      );
    }

    const signature = [];
    for (const suffix of ["CSSMetadata.ts", "Treeoutline.ts", "GeometryImpl.ts"]) {
      const entry = Object.entries(result.metafile.inputs).find(([input]) => input.endsWith(suffix));
      assert.ok(entry, `${suffix} missing from combined graph`);
      signature.push(...entry[1].imports.map(item => item.path).filter(imported =>
        /css-metadata-(?:protocol|common)\.ts$|shared-sdk\.ts$/.test(imported)).sort());
    }
    assert.equal(signature.some(value => value.endsWith("css-metadata-protocol.ts")), true);
    assert.equal(signature.some(value => value.endsWith("css-metadata-common.ts")), true);
    assert.equal(signature.filter(value => value.endsWith("shared-sdk.ts")).length, 2);
    resolutionSignatures.push(signature);
    const inputGraph = Object.entries(result.metafile.inputs)
      .map(([input, metadata]) => ({
        input: input.replaceAll("\\", "/"),
        bytes: metadata.bytes,
        format: metadata.format,
        imports: (metadata.imports ?? []).map(imported => ({
          path: imported.path.replaceAll("\\", "/"),
          kind: imported.kind,
          external: imported.external === true,
          original: imported.original,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }))
      .sort((left, right) => left.input.localeCompare(right.input));
    completeBuildSignatures.push({
      inputGraphSha256: createHash("sha256").update(JSON.stringify(inputGraph)).digest("hex"),
      outputs: result.outputFiles.map(file => ({
        name: path.basename(file.path),
        bytes: file.contents.byteLength,
        sha256: createHash("sha256").update(file.contents).digest("hex"),
      })).sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  assert.deepEqual(resolutionSignatures[0], resolutionSignatures[1]);
  assert.deepEqual(completeBuildSignatures[0], completeBuildSignatures[1]);
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

test("preserves exact CSS text and normal read-only Rules presentation", async () => {
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const propertyTree = bundledModule(
    bundled.code,
    "front_end/panels/elements/StylePropertyTreeElement.ts",
  );
  const stylesPane = bundledModule(
    bundled.code,
    "front_end/panels/elements/StylesSidebarPane.ts",
  );

  assert.match(
    propertyTree,
    /this\.valueElement\.textContent\s*!==\s*this\.property\.value/,
  );
  assert.match(
    propertyTree,
    /this\.valueElement\s*=\s*Renderer\.renderValueElement\(this\.property,\s*null,\s*\[\]\)\.valueElement/,
  );
  assert.doesNotMatch(propertyTree, /preservedNativeSwatches/);
  assert.doesNotMatch(propertyTree, /rawValueElement\.prepend/);
  assert.doesNotMatch(propertyTree, /this\.valueElement\.replaceWith/);
  assert.match(
    stylesPane,
    /registerRequiredCSS\([\s\S]*stylesSidebarPane_(?:default|Styles)[\s\S]*styles-section\.read-only/,
  );
  assert.match(
    stylesPane,
    /styles-sidebar-pane-toolbar-container\s*\{\s*padding-inline-end:\s*52px;/,
  );
  assert.doesNotMatch(stylesPane, /document\.createElement\(['"]style['"]\)/);
  assert.match(stylesPane, /font-style:\s*normal/);
});

test("installs the maximal upstream renderer set supported by read-only facades", async () => {
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const propertyTree = bundledModule(
    bundled.code,
    "front_end/panels/elements/StylePropertyTreeElement.ts",
  );
  const factoryStart = propertyTree.indexOf("function getPropertyRenderers");
  const factoryEnd = propertyTree.indexOf("var StylePropertyTreeElement", factoryStart);
  assert.notEqual(factoryStart, -1);
  assert.notEqual(factoryEnd, -1);
  const factory = propertyTree.slice(factoryStart, factoryEnd);

  for (const renderer of [
    "ColorRenderer", "ContrastColorRenderer", "AngleRenderer", "BezierRenderer",
    "StringRenderer", "GridTemplateRenderer", "LinearGradientRenderer", "FlexGridRenderer",
    "EnvFunctionRenderer", "PositionTryRenderer", "LengthRenderer", "CustomFunctionRenderer",
    "AutoBaseRenderer", "BinOpRenderer", "RelativeColorChannelRenderer",
  ]) {
    assert.match(factory, new RegExp(`new ${renderer}\\(`), `${renderer} is missing`);
  }
  for (const renderer of [
    "VariableRenderer", "VariableNameRenderer", "ColorMixRenderer", "URLRenderer",
    "LinkableNameRenderer", "ShadowRenderer", "CSSWideKeywordRenderer", "LightDarkColorRenderer",
    "AnchorFunctionRenderer", "PositionAnchorRenderer", "MathFunctionRenderer", "AttributeRenderer",
  ]) {
    assert.doesNotMatch(factory, new RegExp(`new ${renderer}\\(`), `${renderer} must use exact fallback`);
  }
  assert.match(factory, /new ColorRenderer\([^)]*,\s*null\)/);
  assert.match(factory, /new LengthRenderer\([^)]*,\s*null\)/);
  assert.doesNotMatch(factory, /new (?:AngleRenderer|BezierRenderer|FlexGridRenderer)\([^)]*treeElement/);
});

test("pins Styles overlay bytes to LF across platforms", async () => {
  const attributes = await readFile(new URL("../../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /^third_party\/chromium-devtools-frontend\/styles-overlay\/\*\* text eol=lf$/m);
});

test("removes writer, editor, AI, and network authority from the full Styles bundle", async () => {
  const bundled = await bundleChromiumReadOnlyStylesRuntime({repositoryRoot});
  const domModel = bundledModule(bundled.code, "front_end/core/sdk/DOMModel.ts");
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
  for (const writer of [
    "invoke_copyTo",
    "invoke_moveTo",
    "invoke_removeNode",
    "invoke_removeAttribute",
    "invoke_setNodeName",
    "invoke_setNodeValue",
    "invoke_setOuterHTML",
    "invoke_setAttributesAsText",
    "invoke_setAttributeValue",
    "invoke_setInspectedNode",
    "removeNode(",
    "copyTo(",
  ]) {
    assert.doesNotMatch(domModel, new RegExp(writer.replace("(", "\\(")),
      `${writer} remains in the standalone Styles DOMModel`);
  }
  assert.doesNotMatch(bundled.code, /\b(?:fetch\s*\(|new\s+XMLHttpRequest|new\s+WebSocket|importScripts\s*\()/);
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
  assert.deepEqual(bundled.generatedInputs.map(input =>
    input.replace(/^chromium-shared-images:.*[\\/]front_end[\\/]Images[\\/]Images\.js$/,
      "chromium-shared-images:front_end/Images/Images.js")), manifest.reviewedGeneratedInputs);
  assert.equal(Object.isFrozen(bundled.payloadAttestation), true);
  assert.deepEqual(bundled.payloadAttestation, manifest.reviewedSharedPayloadAttestation);
  assert.deepEqual(bundled.sharedInputInventory, manifest.reviewedSharedInputInventory);
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
