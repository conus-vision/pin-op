import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  BROWSER_INSPECTOR_TARGETS,
  CHROMIUM_ELEMENTS_RUNTIME_FILENAME,
  CHROMIUM_ELEMENTS_RUNTIME_IMPORT,
  CHROMIUM_INSPECTOR_ADAPTER_IMPORT,
  CHROMIUM_INSPECTOR_RUNTIME,
  ELEMENTS_RUNTIME_PACKAGE_IMPORT,
  buildBrowserInspectorModules,
  mergeBrowserBundleMetafiles,
  assertExactBrowserOutputs,
  verifyRuntimeBytes,
  verifyUnifiedOwnerInputClosure,
} from "../browser-elements-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("browser Inspector build emits one verified native Chromium runtime graph", async () => {
  assert.deepEqual(BROWSER_INSPECTOR_TARGETS, ["chrome116", "firefox142"]);
  assert.equal(CHROMIUM_ELEMENTS_RUNTIME_FILENAME, "chromiumElementsRuntime.js");
  assert.equal(CHROMIUM_ELEMENTS_RUNTIME_IMPORT, "./chromiumElementsRuntime.js");
  assert.equal(
    ELEMENTS_RUNTIME_PACKAGE_IMPORT,
    "@pin-op/devtools-elements-ui/upstream-runtime",
  );
  assert.equal(
    CHROMIUM_INSPECTOR_ADAPTER_IMPORT,
    "@pin-op/devtools-elements-ui/chromium-adapter",
  );
  assert.deepEqual(CHROMIUM_INSPECTOR_RUNTIME, {
    browserTargets: ["chrome116", "firefox142"],
    maxMinifiedBytes: 2 * 1024 * 1024,
  });

  const chromeRoot = resolve(repositoryRoot, "extensions/chrome");
  const firefoxRoot = resolve(repositoryRoot, "extensions/firefox");
  const chromeOutdir = await mkdtemp(join(tmpdir(), "pin-op-chromium-runtime-chrome-"));
  const firefoxOutdir = await mkdtemp(join(tmpdir(), "pin-op-chromium-runtime-firefox-"));
  try {
    const chromeBuild = await buildBrowserInspectorModules({
      extensionRoot: chromeRoot,
      outdir: chromeOutdir,
    });
    const firefoxBuild = await buildBrowserInspectorModules({
      extensionRoot: firefoxRoot,
      outdir: firefoxOutdir,
    });

    assert.equal(
      Object.keys(chromeBuild.inspectorRuntimeResult.metafile.outputs).length,
      2,
    );
    assert.deepEqual(
      Object.keys(chromeBuild.inspectorRuntimeResult.metafile.outputs)
        .map(path => path.replaceAll("\\", "/").split("/").at(-1))
        .sort(),
      ["chromiumElementsRuntime.js", "inspectorPanel.js"],
    );
    assert.equal(
      Object.keys(chromeBuild.inspectorPanelResult.metafile.outputs).length,
      1,
    );
    assert.equal(
      Object.keys(chromeBuild.elementsRuntimeResult.metafile.outputs).length,
      1,
    );

    const inspectorSource = await readFile(
      resolve(chromeOutdir, "inspectorPanel.js"),
      "utf8",
    );
    const chromeRuntime = await readFile(
      resolve(chromeOutdir, CHROMIUM_ELEMENTS_RUNTIME_FILENAME),
    );
    const firefoxRuntime = await readFile(
      resolve(firefoxOutdir, CHROMIUM_ELEMENTS_RUNTIME_FILENAME),
    );
    const runtimeSource = chromeRuntime.toString("utf8");
    const inspectorModule = parseModule(inspectorSource, "inspectorPanel.js");
    const runtimeModule = parseModule(
      runtimeSource,
      CHROMIUM_ELEMENTS_RUNTIME_FILENAME,
    );

    assert.deepEqual(importSources(inspectorModule), [CHROMIUM_ELEMENTS_RUNTIME_IMPORT]);
    assert.deepEqual(importedNames(inspectorModule), ["createElementsInspectorView"]);
    assert.equal(inspectorSource.includes(ELEMENTS_RUNTIME_PACKAGE_IMPORT), false);
    assert.deepEqual(importSources(runtimeModule), []);
    assert.deepEqual(exportedNames(runtimeModule), ["createElementsInspectorView"]);
    assert.deepEqual(chromeRuntime, firefoxRuntime);
    const [[, runtimeOutput]] = Object.entries(
      chromeBuild.elementsRuntimeResult.metafile.outputs,
    );
    assert.equal(runtimeOutput.bytes, chromeRuntime.byteLength);
    assert.equal(
      chromeBuild.runtimeVerification.minifiedBytes,
      chromeRuntime.byteLength,
    );
    assert.ok(
      chromeBuild.runtimeVerification.minifiedBytes <=
        CHROMIUM_INSPECTOR_RUNTIME.maxMinifiedBytes,
    );

    const runtimeInputs = normalizedInputNames(
      chromeBuild.elementsRuntimeResult.metafile,
    );
    assert.ok(runtimeInputs.some(path => path.endsWith(
      "/tools/browser-chromium-inspector-entry.ts",
    )));
    assert.ok(runtimeInputs.some(path => path.endsWith(
      "/entrypoints/read-only-elements.ts",
    )));
    assert.ok(runtimeInputs.some(path => path.endsWith(
      "/entrypoints/read-only-styles.ts",
    )));
    assert.ok(runtimeInputs.some(path => path.endsWith(
      "/dist/chromium/upstream/PinOpChromiumInspectorAdapter.js",
    )));
    for (const forbidden of [
      "/dist/elementsInspectorView.js",
      "/dist/upstreamRuntime.js",
      "/dist/chromium/dom/",
      "/dist/chromium/rules/",
    ]) {
      assert.equal(runtimeInputs.some(path => path.includes(forbidden)), false);
    }
    assert.deepEqual(
      [...chromeBuild.runtimeVerification.verifiedInputKeys].sort(),
      Object.keys(chromeBuild.elementsRuntimeResult.metafile.inputs).sort(),
    );
    assert.deepEqual(chromeBuild.runtimeVerification.prunedOwnerCapabilityInputKeys, [
      "third_party/chromium-devtools-frontend/patches/1.0.1681091/facades/issues.ts",
    ]);
    assert.deepEqual(chromeBuild.runtimeVerification.prunedOwnerCapabilityAttestation, {
      fileCount: 1,
      sha256: "1a547b642f0a385145dcb553623881863d5496536d8d62bddae3a2952145bb30",
      reason: "Pin-op does not expose Chromium Issues capability",
    });
    assert.equal(
      chromeBuild.runtimeVerification.resolutionEdgeSignature,
      firefoxBuild.runtimeVerification.resolutionEdgeSignature,
    );
    assert.notDeepEqual(
      chromeBuild.runtimeVerification.pluginOrder,
      firefoxBuild.runtimeVerification.pluginOrder,
    );

    const panelInputs = normalizedInputNames(chromeBuild.inspectorPanelResult.metafile);
    assert.ok(panelInputs.some(path => path.endsWith("/extensions/chrome/src/inspectorPanel.ts")));
    assert.equal(
      panelInputs.some(path => path.includes("chrome-devtools-frontend")),
      false,
    );
  } finally {
    await Promise.all([
      rm(chromeOutdir, { recursive: true, force: true }),
      rm(firefoxOutdir, { recursive: true, force: true }),
    ]);
  }
});

test("unified runtime rejects tampered output, owner, local, and byte inventories", () => {
  assert.throws(
    () => assertExactBrowserOutputs(["out/inspectorPanel.js", "out/chromiumElementsRuntime.js", "out/extra.js"]),
    /unexpected output inventory/i,
  );
  assert.throws(() => verifyRuntimeBytes(10, 11), /not truthful/i);
  const reviewed = [
    "owner/entrypoints/read-only-elements.ts",
    "owner/entrypoints/read-only-styles.ts",
    "third_party/chromium-devtools-frontend/patches/1.0.1681091/facades/issues.ts",
  ];
  const runtime = [
    "owner/entrypoints/read-only-elements.ts",
    "owner/entrypoints/read-only-styles.ts",
    "local/adapter.js",
  ];
  const evidence = {
    [reviewed[2]]: {
      relative: reviewed[2],
      contributions: [{ownerOutput: "chromiumElementsAnalysis.js", bytesInOutput: 61}],
      sha256: "87a278e4e1266e15f085e6ae6e7fdc651782a32e70f66a8fabf256f7eb53cf85",
    },
  };
  assert.doesNotThrow(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: runtime,
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }));
  assert.doesNotThrow(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: [
      "/p/entrypoints/read-only-elements.ts",
      "/p/entrypoints/read-only-styles.ts",
      "/local/adapter.js",
    ],
    reviewedOwnerInputKeys: [
      "/p/entrypoints/read-only-elements.ts",
      "/p/entrypoints/read-only-styles.ts",
      reviewed[2],
    ],
    localInputKeys: ["/local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }));
  assert.throws(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: ["local/adapter.js"],
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }), /pruned owner capability delta changed/i);
  assert.throws(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: [...runtime, "unknown.js"],
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }), /unexpected inputs/i);
  assert.throws(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: runtime.slice(0, 2),
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }), /missing local inputs/i);
  assert.throws(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: runtime,
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: {[reviewed[2]]: {...evidence[reviewed[2]], contributions: [{ownerOutput: "chromiumElementsAnalysis.js", bytesInOutput: 62}]}},
  }), /evidence changed/i);
  assert.throws(() => verifyUnifiedOwnerInputClosure({
    runtimeInputKeys: [...runtime, "OWNER\\ENTRYPOINTS\\READ-ONLY-ELEMENTS.TS"],
    reviewedOwnerInputKeys: reviewed,
    localInputKeys: ["local/adapter.js"],
    prunedOwnerCapabilityEvidence: evidence,
  }), /alias collision/i);
  for (const alias of [
    "owner/./entrypoints/read-only-elements.ts",
    "owner//entrypoints/read-only-elements.ts",
    "owner/entrypoints/read-only-elements.ts.",
  ]) {
    assert.throws(() => verifyUnifiedOwnerInputClosure({
      runtimeInputKeys: [...runtime, alias],
      reviewedOwnerInputKeys: reviewed,
      localInputKeys: ["local/adapter.js"],
      prunedOwnerCapabilityEvidence: evidence,
    }), /canonical|alias/i);
  }
});

test("metafile merger rejects invalid build metadata and preserves final output closures", () => {
  const first = {
    inputs: { "src/a.ts": { bytes: 1, imports: [] } },
    outputs: { "dist/a.js": { bytes: 1, inputs: {}, imports: [], exports: [] } },
  };
  const second = {
    inputs: { "src/b.ts": { bytes: 1, imports: [] } },
    outputs: { "dist/b.js": { bytes: 1, inputs: {}, imports: [], exports: [] } },
  };
  assert.deepEqual(mergeBrowserBundleMetafiles(first, second), {
    inputs: { ...first.inputs, ...second.inputs },
    outputs: { ...first.outputs, ...second.outputs },
  });
  assert.deepEqual(mergeBrowserBundleMetafiles(
    {inputs: {"(disabled):path": {bytes: 0, imports: []}}, outputs: {}},
    {inputs: {"(disabled):path": {bytes: 0, imports: []}}, outputs: {}},
  ).inputs, {"(disabled):path": {bytes: 0, imports: []}});
  assert.throws(() => mergeBrowserBundleMetafiles(
    {inputs: {"(disabled):path": {bytes: 0, imports: []}}, outputs: {}},
    {inputs: {"(disabled):path": {bytes: 1, imports: []}}, outputs: {}},
  ), /input collision/i);
  for (const invalid of [undefined, null, {}, { inputs: [], outputs: {} }]) {
    assert.throws(
      () => mergeBrowserBundleMetafiles(invalid),
      /invalid esbuild metafile/,
    );
  }
  assert.throws(
    () => mergeBrowserBundleMetafiles(first, {
      inputs: { "src/a.ts": { bytes: 2, imports: [] } },
      outputs: { "dist/c.js": { bytes: 2, inputs: {}, imports: [], exports: [] } },
    }),
    /input collision.*src\/a\.ts/i,
  );
  assert.throws(
    () => mergeBrowserBundleMetafiles(first, {
      inputs: { "src/c.ts": { bytes: 2, imports: [] } },
      outputs: { "dist\\a.js": { bytes: 2, inputs: {}, imports: [], exports: [] } },
    }),
    /output collision.*dist[\\/]a\.js/i,
  );
  assert.throws(
    () => mergeBrowserBundleMetafiles(first, first),
    /input collision|output collision/i,
  );
});

function parseModule(source, path) {
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(parsed.parseDiagnostics.length, 0);
  return parsed;
}

function importSources(sourceFile) {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .map(statement => statement.moduleSpecifier.text);
}

function importedNames(sourceFile) {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .flatMap(statement =>
      statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.map(
          element => (element.propertyName ?? element.name).text,
        )
        : [],
    );
}

function exportedNames(sourceFile) {
  const names = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map(element => element.name.text));
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) ?? []
      : [];
    if (!modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function normalizedInputNames(metafile) {
  return Object.keys(metafile.inputs).map(path => `/${path.replaceAll("\\", "/")}`);
}
