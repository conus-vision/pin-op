import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {build as esbuildBuild} from "esbuild";

import {
  CHROMIUM_DEVTOOLS_PIN,
  CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME,
  bundleChromiumDevToolsModule,
  bundleChromiumReadOnlyElementsRuntime,
  createChromiumReadOnlySourceTransformPlugin,
  prepareChromiumReadOnlyElementsBuild,
  sanitizeChromiumSharedCss,
  verifyChromiumDevToolsPackage,
  verifyChromiumReadOnlyElementsOverlay,
  verifyChromiumReadOnlyMetafileInputs,
} from "../chromium-devtools-runtime.mjs";

test("shared Chromium CSS drops comments, branding-only fonts, and unused AI tokens", () => {
  const design = sanitizeChromiumSharedCss(
    [
      "/* Chrome docs https://attacker.invalid/docs */",
      ":root {",
      "  --body-font: 'Google Sans Text', 'Google Sans', system-ui, sans-serif;",
      "  --kept-color: CanvasText;",
      "}",
      "",
    ].join("\n"),
    "front_end/design_system_tokens.css",
    { enforceReviewedTransformCounts: false },
  );
  assert.doesNotMatch(design, /Chrome|Google|https?:\/\//);
  assert.match(design, /--body-font:\s*system-ui, sans-serif/);
  assert.match(design, /--kept-color:\s*CanvasText/);

  const application = sanitizeChromiumSharedCss(
    [
      ":root {",
      "  --app-color-ai-assistance-input-divider: red;",
      "  --app-color-google-ai-blue: blue;",
      "  --app-color-google-ai-green: green;",
      "  --app-gradient-google-ai: linear-gradient(blue, green);",
      "  --kept-color: CanvasText;",
      "}",
      ".theme-with-dark-background {",
      "  --app-color-ai-assistance-input-divider: white;",
      "}",
      "",
    ].join("\n"),
    "front_end/application_tokens.css",
    { enforceReviewedTransformCounts: false },
  );
  assert.doesNotMatch(application, /\b(?:AI|Google)\b|google-ai|ai-assistance/i);
  assert.match(application, /--kept-color:\s*CanvasText/);
});

test("rejects unverified read-only source transform authority", () => {
  assert.throws(
    () => createChromiumReadOnlySourceTransformPlugin(Object.freeze({sourceTransforms: new Map()})),
    /require a verified overlay authority/,
  );
});
import {
  FORBIDDEN_WRITER_SURFACE,
  assertForbiddenHandlerRegression,
  installForbiddenWriterTraps,
} from "../smoke-chromium-read-only-elements.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("browser smoke writer traps count, throw, attest, and restore forbidden surfaces", () => {
  const target = {};
  const calls = [];
  const traps = installForbiddenWriterTraps(
    [target],
    FORBIDDEN_WRITER_SURFACE,
    (name, args) => calls.push([name, args]),
  );
  assert.deepEqual(traps.present, []);
  assert.throws(() => target.moveTo("parent"), /Forbidden Chromium writer invoked: moveTo/);
  assert.deepEqual(calls, [["moveTo", ["parent"]]]);
  traps.restore();
  assert.equal(Object.hasOwn(target, "moveTo"), false);

  const retained = {removeNode() { return "retained"; }};
  const retainedTrap = installForbiddenWriterTraps([retained], ["removeNode"], () => {});
  assert.deepEqual(retainedTrap.present, ["removeNode"]);
  retainedTrap.restore();
  assert.equal(retained.removeNode(), "retained");
});

test("browser smoke accepts only an exact clean forbidden-handler regression probe", () => {
  const exact = {
    preProbeErrors: 0,
    preProbeWriterCalls: 0,
    calls: ["ondblclick", "ondelete"],
    caughtErrors: 2,
    descriptorsRestored: true,
  };
  assert.doesNotThrow(() => assertForbiddenHandlerRegression(exact));
  for (const invalid of [
    {...exact, preProbeErrors: 1},
    {...exact, preProbeWriterCalls: 1},
    {...exact, calls: ["ondblclick", "ondelete", "ondelete"]},
    {...exact, caughtErrors: 3},
    {...exact, descriptorsRestored: false},
  ]) {
    assert.throws(() => assertForbiddenHandlerRegression(invalid), /did not traverse real Chromium events/);
  }
});

test("Chromium DevTools runtime is pinned to the reviewed official package", async () => {
  assert.deepEqual(CHROMIUM_DEVTOOLS_PIN, {
    packageName: "chrome-devtools-frontend",
    version: "1.0.1681091",
    gitHead: "23cccaa78f7458a5aad99c1af98dc1856d2494a3",
    integrity:
      "sha512-cXBay271CnEb+Y+Cxre3mjGDHFKhXVo9mGfNCVAruen/iwF+jnG6Z55mnC7yh078HD1rmKhBM9tKLKQbjVniVQ==",
  });

  const runtimeManifest = JSON.parse(await readFile(
    path.join(
      repositoryRoot,
      "third_party",
      "chromium-devtools-frontend",
      "RUNTIME.json",
    ),
    "utf8",
  ));
  assert.deepEqual(runtimeManifest.package, CHROMIUM_DEVTOOLS_PIN);
  assert.deepEqual(runtimeManifest.readOnlyElementsRuntime, {
    overlayRoot: "third_party/chromium-devtools-frontend/patches/1.0.1681091",
    manifestSha256: "2f1ec093bf83838dd914d10f30163eb66ab2c2f423621b076a67cc0c73a2555a",
    entryPoint: "entrypoints/read-only-elements.ts",
    exactImporterSpecifierResolutions: true,
    unminifiedBytes: 1_079_088,
    maxUnminifiedBytes: 1_310_720,
    browserTargets: ["chrome116", "firefox142"],
    upstreamInputClosure: {
      fileCount: 46,
      sha256: "53294d77cfdfcc48bacd7573e1134c809fe846e9ff074d8eadf9ae861a4dd75a",
    },
    overlayInputClosure: {
      fileCount: 37,
      sha256: "485baf9b0daba152f434d8411cafb30b594212dfa5d5d95bbca358e47742fa23",
    },
    sharedInputInventory: [
      "chromium-shared-css:front_end/application_tokens.css",
      "chromium-shared-css:front_end/design_system_tokens.css",
      "chromium-shared-css:front_end/panels/elements/components/elementsTreeExpandButton.css",
      "chromium-shared-css:front_end/panels/elements/elementsTreeOutline.css",
      "chromium-shared-css:front_end/ui/components/buttons/textButton.css",
      "chromium-shared-css:front_end/ui/legacy/inspectorCommon.css",
      "chromium-shared-css:front_end/ui/legacy/treeoutline.css",
    ],
    sharedPayloadAttestation: {
      fileCount: 7,
      sha256: "e78e6e0202d0291765fe41ae023a233e550589e9badf3784892f04a091a35ba5",
    },
    requiredLicenseFiles: {
      LICENSE: "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
      "front_end/third_party/lit/LICENSE":
        "45d31799d0db956cc3eb5469346abbd9b7025babc5ff29fab10d7095da992ef1",
    },
  });

  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  assert.equal(verified.version, CHROMIUM_DEVTOOLS_PIN.version);
  assert.equal(
    verified.files["front_end/panels/elements/ElementsTreeOutline.ts"],
    "36049536b7e146addc2de9784790d8ae630f28c1640b3b679506d9e4cc7bfd9d",
  );
  assert.equal(
    verified.files["front_end/panels/elements/StylesSidebarPane.ts"],
    "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28",
  );
  assert.equal(
    verified.files.LICENSE,
    "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
  );

  const lockfile = await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  assert.match(
    lockfile,
    new RegExp(
      `chrome-devtools-frontend@${CHROMIUM_DEVTOOLS_PIN.version.replaceAll(".", "\\.")}:[\\s\\S]{0,160}` +
        CHROMIUM_DEVTOOLS_PIN.integrity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
});

test("esbuild compiles the real upstream Elements tree and generated CSS modules", async () => {
  const result = await bundleChromiumDevToolsModule({
    repositoryRoot,
    entryPoint: "front_end/panels/elements/ElementsTreeOutline.ts",
    write: false,
  });
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  });

  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/ElementsTreeOutline.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/ElementsTreeElement.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/ui/legacy/Treeoutline.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/elementsTreeOutline.css",
  )));

  const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(javascript);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /ElementsTreeOutline\s*=\s*class/);
  assert.match(output, /elements-tree-outline/);
  assert.match(output, /style\.textContent = cssText/);
  assert.match(output, /var elementsTreeOutline_default = ['"]\.editing \{/);
  assert.doesNotMatch(output, /node:worker_threads/);
});

test("runtime refuses unreviewed Chromium entrypoints", async () => {
  await assert.rejects(
    bundleChromiumDevToolsModule({
      repositoryRoot,
      entryPoint: "front_end/panels/network/NetworkPanel.ts",
      write: false,
    }),
    /not a reviewed Chromium DevTools entry point/i,
  );
});

test("esbuild compiles the real upstream Rules pane", async () => {
  const result = await bundleChromiumDevToolsModule({
    repositoryRoot,
    entryPoint: "front_end/panels/elements/StylesSidebarPane.ts",
    write: false,
  });
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  });

  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/StylesSidebarPane.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/StylePropertiesSection.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/stylesSidebarPane.css",
  )));

  const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(javascript);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /StylesSidebarPane\s*=\s*class/);
  assert.match(output, /var stylesSidebarPane_default = ['"]\.styles-section \{/);
  assert.doesNotMatch(output, /node:worker_threads/);
  assert.doesNotMatch(
    output,
    /setProperty\(["']--image-file-baseline-(?:high|limited|low)-availability/,
  );
});

test("read-only Elements overlay is versioned and resolves only exact reviewed imports", async () => {
  assert.equal(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.schemaVersion, 1);
  assert.equal(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.packageVersion, CHROMIUM_DEVTOOLS_PIN.version);
  assert.equal(
    CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.overlayRoot,
    "third_party/chromium-devtools-frontend/patches/1.0.1681091",
  );
  assert.equal(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.maxUnminifiedBytes, 1280 * 1024);
  assert.deepEqual(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.browserTargets, ["chrome116", "firefox142"]);
  assert.equal(
    CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.manifestSha256,
    "2f1ec093bf83838dd914d10f30163eb66ab2c2f423621b076a67cc0c73a2555a",
  );

  const overlay = await verifyChromiumReadOnlyElementsOverlay(repositoryRoot);
  assert.equal(overlay.manifest.package.version, CHROMIUM_DEVTOOLS_PIN.version);
  assert.equal(overlay.manifest.entryPoint, "entrypoints/read-only-elements.ts");
  assert.equal(overlay.manifest.testOnlyEntryPoint, "entrypoints/read-only-elements-smoke.ts");
  assert.equal(Object.keys(overlay.manifest.upstreamFiles).length, 18);
  assert.equal(Object.keys(overlay.manifest.overlayFiles).length, 44);
  assert.deepEqual(Object.keys(overlay.manifest.sourceTransforms).sort(), [
    "front_end/core/sdk/DOMModel.ts",
    "front_end/panels/elements/ElementsTreeElement.ts",
    "front_end/panels/elements/ElementsTreeOutline.ts",
  ]);
  assert.deepEqual(
    [...FORBIDDEN_WRITER_SURFACE].sort(),
    [...new Set(Object.values(overlay.manifest.sourceTransforms)
      .flatMap(transform => transform.removeMembers)
      .map(name => name.replace(/^#/, "")))].sort(),
  );
  const outlineSource = overlay.sourceTransforms.get("front_end/panels/elements/ElementsTreeOutline.ts").transformedSource;
  const treeElementSource = overlay.sourceTransforms.get("front_end/panels/elements/ElementsTreeElement.ts").transformedSource;
  assert.doesNotMatch(outlineSource, /\.moveTo\s*\(/);
  assert.doesNotMatch(outlineSource, /^\s*showContextMenu\s*[:=(]/m);
  assert.doesNotMatch(outlineSource, /void 0\s*\)\s*\.(?:bind|call|apply)/);
  assert.doesNotMatch(treeElementSource, /void 0\s*\)\s*\.(?:bind|call|apply)/);
  assert.match(treeElementSource, /classList\.remove\(['"]violating-element['"]\)/);
  assert.match(treeElementSource, /widget\.element\.classList\.remove\(['"]vbox['"], ['"]flex-auto['"]\)/);
  assert.match(outlineSource, /container\.classList\.remove\(['"]elements-tree-truncated['"]\)/);
  assert.ok(overlay.manifest.resolutions.length > 0);
  for (const resolution of overlay.manifest.resolutions) {
    assert.match(resolution.importer, /^front_end\/[A-Za-z0-9_./-]+\.ts$/);
    assert.match(resolution.specifier, /^(?:\.\.?\/)[A-Za-z0-9_./-]+\.js$/);
    assert.match(resolution.facade, /^facades\/[A-Za-z0-9_./-]+\.ts$/);
    assert.doesNotMatch(resolution.importer, /[*?]/);
    assert.doesNotMatch(resolution.specifier, /[*?]/);
  }
});

test("read-only Elements overlay hash inputs preserve LF across Git checkouts", async () => {
  const attributes = await readFile(path.join(repositoryRoot, ".gitattributes"), "utf8");
  assert.match(
    attributes,
    /^third_party\/chromium-devtools-frontend\/patches\/\*\* text eol=lf$/m,
  );
});

test("Chromium runtime metadata preserves LF across Git checkouts", async () => {
  const attributes = await readFile(path.join(repositoryRoot, ".gitattributes"), "utf8");
  for (const file of ["RUNTIME.json", "UPSTREAM.json"]) {
    assert.match(
      attributes,
      new RegExp(
        `^third_party/chromium-devtools-frontend/${file.replace(".", "\\.")} text eol=lf$`,
        "m",
      ),
    );
    const bytes = await readFile(path.join(
      repositoryRoot,
      "third_party",
      "chromium-devtools-frontend",
      file,
    ));
    assert.equal(bytes.includes(13), false, `${file} must use canonical LF bytes`);
  }
});

test("DOM overlay routes only the reviewed shared SDK edges through the canonical facade", async () => {
  const overlayRoot = path.join(
    repositoryRoot,
    "third_party",
    "chromium-devtools-frontend",
    "patches",
    CHROMIUM_DEVTOOLS_PIN.version,
  );
  const manifest = JSON.parse(await readFile(path.join(overlayRoot, "manifest.json"), "utf8"));
  const sharedEdges = manifest.resolutions.filter(({importer, specifier}) =>
    specifier === "../../core/sdk/sdk.js" &&
    [
      "front_end/models/geometry/GeometryImpl.ts",
      "front_end/ui/legacy/Treeoutline.ts",
    ].includes(importer)).sort((left, right) => left.importer.localeCompare(right.importer));

  assert.deepEqual(sharedEdges, [
    {
      importer: "front_end/models/geometry/GeometryImpl.ts",
      specifier: "../../core/sdk/sdk.js",
      facade: "facades/shared-sdk.ts",
    },
    {
      importer: "front_end/ui/legacy/Treeoutline.ts",
      specifier: "../../core/sdk/sdk.js",
      facade: "facades/shared-sdk.ts",
    },
  ]);
  assert.equal(
    await readFile(path.join(overlayRoot, "facades", "shared-sdk.ts"), "utf8"),
    "import * as DOMModel from '#chromium/core/sdk/DOMModel.js';\n" +
      "import * as CSSMetadata from '#chromium/core/sdk/CSSMetadata.js';\n\n" +
      "export {CSSMetadata, DOMModel};\n",
  );
});

test("CSSMetadata dependencies use only canonical base facades", async () => {
  const overlay = await verifyChromiumReadOnlyElementsOverlay(repositoryRoot);
  const cssMetadataEdges = overlay.manifest.resolutions
    .filter(({importer}) => importer === "front_end/core/sdk/CSSMetadata.ts")
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
  assert.deepEqual(cssMetadataEdges, [
    {
      importer: "front_end/core/sdk/CSSMetadata.ts",
      specifier: "../../generated/protocol.js",
      facade: "facades/css-metadata-protocol.ts",
    },
    {
      importer: "front_end/core/sdk/CSSMetadata.ts",
      specifier: "../common/common.js",
      facade: "facades/css-metadata-common.ts",
    },
  ]);
  const result = await bundleChromiumReadOnlyElementsRuntime({repositoryRoot, write: false});
  const inputs = Object.keys(result.metafile.inputs).map(input => input.replaceAll("\\", "/"));
  assert.ok(inputs.some(input => input.endsWith("/facades/css-metadata-protocol.ts")));
  const cssMetadataInput = Object.entries(result.metafile.inputs).find(([input]) =>
    input.replaceAll("\\", "/").endsWith("/front_end/core/sdk/CSSMetadata.ts"));
  assert.ok(cssMetadataInput);
  const cssMetadataImports = cssMetadataInput[1].imports.map(({path: importPath}) =>
    importPath.replaceAll("\\", "/"));
  assert.ok(cssMetadataImports.some(importPath => importPath.endsWith("/facades/css-metadata-protocol.ts")));
  assert.ok(!cssMetadataImports.some(importPath => importPath.endsWith("/front_end/generated/protocol.ts")));
  assert.ok(!inputs.some(input => input.includes("/styles-overlay/")));
  assert.ok(!inputs.some(input => input.includes("chromium-devtools-styles-runtime")));
});

test("canonical Chromium shared plugins expose frozen namespaces and payload attestation", async () => {
  const runtimeModule = await import("../chromium-devtools-runtime.mjs");
  assert.equal(typeof runtimeModule.createChromiumSharedRuntimePlugins, "function");

  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  const importer = path.join(
    repositoryRoot,
    "third_party",
    "chromium-devtools-frontend",
    "patches",
    CHROMIUM_DEVTOOLS_PIN.version,
    "facades",
    "shared-sdk.ts",
  );
  const shared = await runtimeModule.createChromiumSharedRuntimePlugins({
    packageRoot: verified.packageRoot,
    allowedImporters: Object.freeze(new Set([importer])),
  });

  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(shared.plugins), true);
  assert.ok(shared.plugins.every(plugin => Object.isFrozen(plugin)));
  assert.equal(new Set(shared.plugins.map(plugin => plugin.name)).size, shared.plugins.length);
  assert.equal(Object.isFrozen(shared.namespaces), true);
  assert.equal(typeof shared.verifyInputs, "function");
  const verification = shared.verifyInputs([]);
  assert.equal(Object.isFrozen(verification), true);
  assert.equal(Object.isFrozen(verification.generatedInputs), true);
  assert.equal(Object.isFrozen(verification.payloadAttestation), true);
  assert.throws(
    () => shared.verifyInputs(["chromium-foreign:payload"]),
    /unreviewed Chromium shared input/i,
  );
  assert.throws(
    () => shared.verifyInputs([`${shared.namespaces.css}:${path.join(repositoryRoot, "foreign.css")}`]),
    /outside|invalid Chromium shared CSS/i,
  );

  const resolutions = [];
  for (const plugin of shared.plugins) {
    plugin.setup({
      onResolve(options, callback) { resolutions.push({options, callback}); },
      onLoad(options, callback) { resolutions.push({options, callback}); },
    });
  }
  const cssResolver = resolutions.find(({options}) => options.filter.test("./tree.css.js"));
  const cssLoader = resolutions.find(({options}) => options.namespace === shared.namespaces.css);
  const imageLoader = resolutions.find(({options}) => options.namespace === shared.namespaces.images);
  assert.ok(cssResolver);
  assert.ok(cssLoader);
  assert.ok(imageLoader);
  assert.equal(await cssResolver.callback({
    importer: path.join(repositoryRoot, "tools", "foreign.ts"),
    resolveDir: repositoryRoot,
    path: "./tree.css.js",
  }), undefined);
  await assert.rejects(
    cssLoader.callback({path: path.join(repositoryRoot, "tools", "test", "chromium-devtools-runtime.test.mjs")}),
    /outside/i,
  );
  await assert.rejects(
    cssLoader.callback({
      path: path.join(verified.packageRoot, "front_end", "panels", "elements", "stylesSidebarPane.css"),
    }),
    /unregistered/i,
  );
  const imageModulePath = path.join(verified.packageRoot, "front_end", "Images", "Images.js");
  assert.throws(
    () => imageLoader.callback({path: imageModulePath}),
    /unregistered/i,
  );
  const registeredImage = shared.resolveImagesInput({importer});
  assert.equal(registeredImage.namespace, shared.namespaces.images);
  const emittedImage = imageLoader.callback({path: registeredImage.path});
  assert.match(emittedImage.contents, /--image-file-filter/);
  assert.match(emittedImage.contents, /--image-file-open-externally/);

  const registered = await cssResolver.callback({
    importer,
    resolveDir: path.join(verified.packageRoot, "front_end"),
    path: "./application_tokens.css.js",
  });
  assert.equal(registered.namespace, shared.namespaces.css);
  const emitted = await cssLoader.callback({path: registered.path});
  const css = sanitizeChromiumSharedCss(
    await readFile(registered.path, "utf8"),
    "front_end/application_tokens.css",
  );
  assert.equal(emitted.contents, `export default ${JSON.stringify(css)};\n`);
  const emittedVerification = shared.verifyInputs([
    `${shared.namespaces.css}:${registered.path}`,
  ]);
  const canonical = "chromium-shared-css:front_end/application_tokens.css";
  const expectedRow = `${canonical}\0${createHash("sha256").update(emitted.contents).digest("hex")}`;
  assert.deepEqual(emittedVerification.inputInventory, [canonical]);
  assert.equal(
    emittedVerification.payloadAttestation.sha256,
    createHash("sha256").update(`${expectedRow}\n`).digest("hex"),
  );
});

test("canonical Chromium shared plugins reject ambiguous importer authority", async () => {
  const runtimeModule = await import("../chromium-devtools-runtime.mjs");
  assert.equal(typeof runtimeModule.createChromiumSharedRuntimePlugins, "function");
  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  const importer = path.join(verified.packageRoot, "front_end", "ui", "legacy", "Treeoutline.ts");

  await assert.rejects(
    runtimeModule.createChromiumSharedRuntimePlugins({
      packageRoot: verified.packageRoot,
      allowedImporters: new Set([importer]),
    }),
    /frozen.*allowedImporters|allowedImporters.*frozen/i,
  );
  await assert.rejects(
    runtimeModule.createChromiumSharedRuntimePlugins({
      packageRoot: verified.packageRoot,
      allowedImporters: Object.freeze(new Set([path.join(verified.packageRoot, "missing.ts")])),
    }),
    /reviewed importer|real path|does not exist/i,
  );

  const mutableFrozenSet = Object.freeze(new Set([importer]));
  const snapshotPromise = runtimeModule.createChromiumSharedRuntimePlugins({
    packageRoot: verified.packageRoot,
    allowedImporters: mutableFrozenSet,
  });
  mutableFrozenSet.add(path.join(verified.packageRoot, "missing-after-call.ts"));
  const snapshotted = await snapshotPromise;
  assert.equal(Object.isFrozen(snapshotted), true);
});

test("canonical shared payload attestation is checkout-root independent", async t => {
  const runtimeModule = await import("../chromium-devtools-runtime.mjs");
  const runtimeManifest = JSON.parse(await readFile(path.join(
    repositoryRoot,
    "third_party",
    "chromium-devtools-frontend",
    "RUNTIME.json",
  ), "utf8"));
  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);

  const attestFixture = async prefix => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), prefix));
    t.after(() => rm(packageRoot, {recursive: true, force: true}));
    const frontEndRoot = path.join(packageRoot, "front_end");
    const imageRoot = path.join(frontEndRoot, "Images", "src");
    await mkdir(imageRoot, {recursive: true});
    for (const imageName of Object.keys(runtimeManifest.reviewedImages)) {
      await writeFile(
        path.join(imageRoot, imageName),
        await readFile(path.join(verified.packageRoot, "front_end", "Images", "src", imageName)),
      );
    }
    const importer = path.join(frontEndRoot, "importer.ts");
    const cssPath = path.join(frontEndRoot, "fixture.css");
    await writeFile(importer, "export {};\n");
    await writeFile(cssPath, ".fixture { color: red; }\n");
    const shared = await runtimeModule.createChromiumSharedRuntimePlugins({
      packageRoot,
      allowedImporters: Object.freeze(new Set([importer])),
    });
    const callbacks = [];
    for (const plugin of shared.plugins) {
      plugin.setup({
        onResolve(options, callback) { callbacks.push({kind: "resolve", options, callback}); },
        onLoad(options, callback) { callbacks.push({kind: "load", options, callback}); },
      });
    }
    const resolver = callbacks.find(item => item.kind === "resolve" && item.options.filter.test("./fixture.css.js"));
    const loader = callbacks.find(item => item.kind === "load" && item.options.namespace === shared.namespaces.css);
    const resolved = await resolver.callback({importer, resolveDir: frontEndRoot, path: "./fixture.css.js"});
    await loader.callback({path: resolved.path});
    return shared.verifyInputs([`${shared.namespaces.css}:${resolved.path}`]);
  };

  const left = await attestFixture("pin-op-shared-left-");
  const right = await attestFixture("pin-op-shared-right-");
  assert.deepEqual(left, right);
  assert.deepEqual(left.inputInventory, ["chromium-shared-css:front_end/fixture.css"]);
  assert.doesNotMatch(JSON.stringify(left), /pin-op-shared|\\\\/);
});

test("production read-only runtime keeps the real Chromium DOM tree in a bounded closure", async () => {
  const result = await bundleChromiumReadOnlyElementsRuntime({
    repositoryRoot,
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"));

  for (const required of [
    "/front_end/core/sdk/DOMModel.ts",
    "/front_end/panels/elements/ElementsTreeOutline.ts",
    "/front_end/panels/elements/ElementsTreeElement.ts",
    "/front_end/panels/elements/elementsTreeOutline.css",
    "/front_end/application_tokens.css",
    "/front_end/design_system_tokens.css",
    "/front_end/ui/components/buttons/textButton.css",
    "/front_end/ui/legacy/inspectorCommon.css",
    "/front_end/ui/legacy/Treeoutline.ts",
  ]) {
    assert.ok(inputs.some(value => value.endsWith(required)), required);
  }
  for (const forbidden of [
    "/panels/elements/ElementsPanel.ts",
    "/panels/elements/StylesSidebarPane.ts",
    "/models/ai_assistance/",
    "/models/bindings/",
    "/models/issues_manager/",
    "/models/workspace/",
    "/panels/media/",
    "/third_party/codemirror.next/",
    "/generated/InspectorBackendCommands.ts",
    "/core/sdk/sdk.ts",
    "/core/sdk/CSSModel.ts",
    "/ui/legacy/UIUtils.ts",
    "/ui/visual_logging/",
  ]) {
    assert.ok(!inputs.some(value => value.includes(forbidden)), forbidden);
  }

  const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(javascript);
  const javascriptMetadata = Object.entries(result.metafile.outputs)
    .find(([output]) => output.endsWith(".js"))?.[1];
  assert.deepEqual(javascriptMetadata?.exports, ["chromiumElementsRuntime"]);
  assert.ok(javascript.contents.byteLength <= CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.maxUnminifiedBytes);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /ElementsTreeOutline\s*=\s*class/);
  assert.match(output, /DOMDocument\s*=\s*class/);
  assert.match(output, /elements-tree-outline/);
  assert.match(output, /--sys-color-on-surface:/);
  assert.match(output, /--sys-color-cdt-base-container:/);
  assert.match(output, /\.text-button:not\(:disabled, \.primary-button\):focus-visible/);
  assert.match(output, /interpolate-size: allow-keywords/);
  assert.match(output, /pin-op-elements-load-more/);
  assert.match(output, /data-pin-op-load-more-ref/);
  assert.doesNotMatch(output, /StylesSidebarPane\s*=\s*class/);
  for (const removed of [
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
    "copyCSSPath",
    "copyTo",
    "performPaste",
    "setAttributeValue",
    "startEditingAttribute",
    "toggleEditAsHTML",
  ]) {
    assert.ok(!output.includes(removed), `read-only output retained ${removed}`);
  }

  assert.equal(result.unminifiedBytes, 1_079_088);
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 46,
    sha256: "53294d77cfdfcc48bacd7573e1134c809fe846e9ff074d8eadf9ae861a4dd75a",
  });
  assert.deepEqual(result.overlayAttestation, {
    fileCount: 37,
    sha256: "485baf9b0daba152f434d8411cafb30b594212dfa5d5d95bbca358e47742fa23",
  });
  assert.deepEqual(result.requiredLicenseFiles, [
    {
      path: "LICENSE",
      sha256: "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
    },
    {
      path: "front_end/third_party/lit/LICENSE",
      sha256: "45d31799d0db956cc3eb5469346abbd9b7025babc5ff29fab10d7095da992ef1",
    },
  ]);
});

test("read-only Elements build preparation is reusable by a one-pass browser build", async () => {
  const prepared = await prepareChromiumReadOnlyElementsBuild(repositoryRoot);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(
    prepared.entryPoint.replaceAll("\\", "/").endsWith(
      "/third_party/chromium-devtools-frontend/patches/1.0.1681091/entrypoints/read-only-elements.ts",
    ),
    true,
  );
  assert.deepEqual(prepared.browserTargets, ["chrome116", "firefox142"]);
  assert.equal(Object.isFrozen(prepared.browserTargets), true);
  assert.equal(Object.isFrozen(prepared.plugins), true);
  assert.ok(prepared.plugins.length >= 5);
  assert.ok(prepared.plugins.every(plugin => Object.isFrozen(plugin)));
  assert.equal(typeof prepared.verifyBuild, "function");
  assert.equal(Object.isFrozen(prepared.scopedPlugins), true);
  assert.equal(Object.isFrozen(prepared.sharedRuntime), true);
  assert.equal(Object.isFrozen(prepared.sharedImporterPaths), true);
  assert.throws(
    () => prepared.createScopedPlugins(Object.freeze({
      namespaces: prepared.sharedRuntime.namespaces,
      resolveCssInput() {},
      verifyInputs() {},
    })),
    /invalid package or namespace authority/i,
  );

  const result = await bundleChromiumReadOnlyElementsRuntime({
    repositoryRoot,
    write: false,
  });
  const verification = await prepared.verifyBuild(result, result.sharedRuntime);
  assert.deepEqual(verification.chromiumInputAttestation, result.chromiumInputAttestation);
  assert.deepEqual(verification.overlayAttestation, result.overlayAttestation);
  assert.deepEqual(verification.requiredLicenseFiles, result.requiredLicenseFiles);
  assert.equal(verification.unminifiedBytes, result.unminifiedBytes);
  assert.equal(Object.isFrozen(verification.verifiedInputKeys), true);
  assert.equal(Object.isFrozen(verification.generatedInputs), true);
  assert.equal(Object.isFrozen(verification.payloadAttestation), true);
  assert.ok(verification.payloadAttestation.fileCount > 0);
  assert.ok(verification.verifiedInputKeys.some(input =>
    input.replaceAll("\\", "/").endsWith("/entrypoints/read-only-elements.ts")));

  const unreachableInput = "tools/test/chromium-devtools-runtime.test.mjs";
  const withUnreachableInput = structuredClone(result);
  withUnreachableInput.metafile.inputs[unreachableInput] = {bytes: 1, imports: []};
  await assert.doesNotReject(prepared.verifyBuild(withUnreachableInput, result.sharedRuntime));

  const withReachableInput = structuredClone(result);
  const entryInput = Object.keys(withReachableInput.metafile.inputs).find(input =>
    input.replaceAll("\\", "/").endsWith("/entrypoints/read-only-elements.ts"));
  assert.ok(entryInput);
  const owningOutput = Object.values(withReachableInput.metafile.outputs).find(output =>
    Object.hasOwn(output.inputs, entryInput));
  assert.ok(owningOutput);
  withReachableInput.metafile.inputs[entryInput].imports.push({
    path: unreachableInput,
    kind: "import-statement",
    original: "#unreviewed",
  });
  withReachableInput.metafile.inputs[unreachableInput] = {bytes: 1, imports: []};
  owningOutput.inputs[unreachableInput] = {bytesInOutput: 1};
  await assert.rejects(
    prepared.verifyBuild(withReachableInput, result.sharedRuntime),
    /outside the pinned package and overlay/i,
  );
});

test("DOM scoped plugins bind one union shared runtime in either plugin order", async () => {
  const runtimeModule = await import("../chromium-devtools-runtime.mjs");
  const prepared = await prepareChromiumReadOnlyElementsBuild(repositoryRoot);
  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  const unionShared = await runtimeModule.createChromiumSharedRuntimePlugins({
    packageRoot: verified.packageRoot,
    allowedImporters: Object.freeze(new Set(prepared.sharedImporterPaths)),
  });
  const scoped = prepared.createScopedPlugins(unionShared);
  const run = async plugins => {
    const result = await esbuildBuild({
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
      outfile: path.join(repositoryRoot, "chromium-union-order-test.js"),
      logLevel: "silent",
      plugins,
    });
    return await prepared.verifyBuild(result, unionShared);
  };
  const scopedFirst = await run([...scoped, ...unionShared.plugins]);
  const sharedFirst = await run([...unionShared.plugins, ...scoped]);
  assert.deepEqual(sharedFirst.sharedInputInventory, scopedFirst.sharedInputInventory);
  assert.deepEqual(sharedFirst.payloadAttestation, scopedFirst.payloadAttestation);
});

test("DOM verifier scopes merged reachability to its owning multi-entry output", async () => {
  const prepared = await prepareChromiumReadOnlyElementsBuild(repositoryRoot);
  const result = await bundleChromiumReadOnlyElementsRuntime({repositoryRoot, write: false});
  const foreignInput =
    "third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/entrypoints/read-only-styles.ts";
  const merged = structuredClone(result);
  const entryInput = Object.keys(merged.metafile.inputs).find(input =>
    input.replaceAll("\\", "/").endsWith("/entrypoints/read-only-elements.ts"));
  const domOutputKey = Object.keys(merged.metafile.outputs).find(output =>
    Object.hasOwn(merged.metafile.outputs[output].inputs, entryInput));
  assert.ok(entryInput);
  assert.ok(domOutputKey);
  merged.metafile.outputs[domOutputKey].inputs[entryInput] = {bytesInOutput: 0};
  merged.metafile.inputs[entryInput].imports.push({
    path: foreignInput,
    kind: "import-statement",
    original: "#styles-only-neighbour",
  });
  merged.metafile.inputs[foreignInput] = {bytes: 1, imports: []};
  merged.metafile.outputs["styles-neighbour.js"] = {
    bytes: 1,
    inputs: {[foreignInput]: {bytesInOutput: 1}},
    exports: ["chromiumReadOnlyStylesRuntime"],
    entryPoint: foreignInput,
    imports: [],
  };

  await assert.doesNotReject(prepared.verifyBuild(merged, result.sharedRuntime));

  const orphanedLeak = structuredClone(merged);
  orphanedLeak.metafile.inputs[entryInput].imports = orphanedLeak.metafile.inputs[entryInput].imports
    .filter(({path: importPath}) => importPath !== foreignInput);
  orphanedLeak.metafile.outputs[domOutputKey].inputs[foreignInput] = {bytesInOutput: 1};
  await assert.rejects(
    prepared.verifyBuild(orphanedLeak, result.sharedRuntime),
    /outside the pinned package and overlay/i,
  );

  const leaked = structuredClone(merged);
  leaked.metafile.outputs[domOutputKey].inputs[foreignInput] = {bytesInOutput: 1};
  await assert.rejects(
    prepared.verifyBuild(leaked, result.sharedRuntime),
    /outside the pinned package and overlay/i,
  );
});

test("read-only provenance rejects disguised namespaces and repository-local external inputs", async () => {
  await assert.rejects(
    verifyChromiumReadOnlyMetafileInputs({
      repositoryRoot,
      metafile: {inputs: {"chromium-disguised:outside.ts": {}}},
    }),
    /unreviewed Chromium generated namespace/i,
  );
  await assert.rejects(
    verifyChromiumReadOnlyMetafileInputs({
      repositoryRoot,
      metafile: {inputs: {"tools/test/chromium-devtools-runtime.test.mjs": {}}},
    }),
    /outside the pinned package and overlay/i,
  );
});

test("reviewed runtime images include Chromium's tree error decoration", async () => {
  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  assert.equal(
    verified.files["front_end/Images/src/errorWave.svg"],
    "fd5dc2adee295375b0e96df8c7adf96be0ee6169155306f636786ae633f9f640",
  );
  assert.equal(
    verified.files["front_end/Images/src/filter.svg"],
    "fb827ba04c06cb587cf0f76adece7488274ee4048b29b6cb6c17b02fda1a6a4a",
  );
  assert.equal(
    verified.files["front_end/Images/src/open-externally.svg"],
    "5fcb85adf49ec2ab8ee9961c9dad144e7368132051a86fd1fbcf22845fff724d",
  );
});
