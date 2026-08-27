import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHROMIUM_DEVTOOLS_PIN,
  CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME,
  bundleChromiumDevToolsModule,
  bundleChromiumReadOnlyElementsRuntime,
  verifyChromiumDevToolsPackage,
  verifyChromiumReadOnlyElementsOverlay,
  verifyChromiumReadOnlyMetafileInputs,
} from "../chromium-devtools-runtime.mjs";
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
    manifestSha256: "626fd2608f55ffc5a5f13c35c850019ca1df8dfd30505d97a4060b4c2258d53c",
    entryPoint: "entrypoints/read-only-elements.ts",
    exactImporterSpecifierResolutions: true,
    unminifiedBytes: 767_974,
    maxUnminifiedBytes: 1_048_576,
    browserTargets: ["chrome116", "firefox142"],
    upstreamInputClosure: {
      fileCount: 42,
      sha256: "a2247797996dded0072ba22fc39fbf70d4b25a4f1d4d3ea688e5079eaa7e132b",
    },
    overlayInputClosure: {
      fileCount: 36,
      sha256: "9c3cb8bb26b1446e33fcf6952a8eaeb68a422e4ea74fd1d1d67e61f3e3b6c4a3",
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
  assert.match(output, /var elementsTreeOutline_default = ['"]\/\*/);
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
  assert.match(output, /var stylesSidebarPane_default = (?:['"]\/\*|`\/\*\*)/);
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
  assert.equal(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.maxUnminifiedBytes, 1024 * 1024);
  assert.deepEqual(CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.browserTargets, ["chrome116", "firefox142"]);
  assert.equal(
    CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.manifestSha256,
    "626fd2608f55ffc5a5f13c35c850019ca1df8dfd30505d97a4060b4c2258d53c",
  );

  const overlay = await verifyChromiumReadOnlyElementsOverlay(repositoryRoot);
  assert.equal(overlay.manifest.package.version, CHROMIUM_DEVTOOLS_PIN.version);
  assert.equal(Object.keys(overlay.manifest.upstreamFiles).length, 14);
  assert.equal(Object.keys(overlay.manifest.overlayFiles).length, 39);
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
  assert.ok(javascript.contents.byteLength <= CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.maxUnminifiedBytes);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /ElementsTreeOutline\s*=\s*class/);
  assert.match(output, /DOMDocument\s*=\s*class/);
  assert.match(output, /elements-tree-outline/);
  assert.match(output, /--sys-color-on-surface:/);
  assert.match(output, /--sys-color-cdt-base-container:/);
  assert.match(output, /\.text-button:not\(:disabled, \.primary-button\):focus-visible/);
  assert.match(output, /interpolate-size: allow-keywords/);
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

  assert.equal(result.unminifiedBytes, 767_974);
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 42,
    sha256: "a2247797996dded0072ba22fc39fbf70d4b25a4f1d4d3ea688e5079eaa7e132b",
  });
  assert.deepEqual(result.overlayAttestation, {
    fileCount: 36,
    sha256: "9c3cb8bb26b1446e33fcf6952a8eaeb68a422e4ea74fd1d1d67e61f3e3b6c4a3",
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
});
