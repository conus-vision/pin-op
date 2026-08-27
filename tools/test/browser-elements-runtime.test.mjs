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
  ELEMENTS_RUNTIME_PACKAGE_IMPORT,
  buildBrowserInspectorModules,
  mergeBrowserBundleMetafiles,
} from "../browser-elements-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("browser Inspector build emits a bundled static ESM runtime boundary", async () => {
  assert.deepEqual(BROWSER_INSPECTOR_TARGETS, ["chrome116", "firefox142"]);
  assert.equal(CHROMIUM_ELEMENTS_RUNTIME_FILENAME, "chromiumElementsRuntime.js");
  assert.equal(CHROMIUM_ELEMENTS_RUNTIME_IMPORT, "./chromiumElementsRuntime.js");
  assert.equal(
    ELEMENTS_RUNTIME_PACKAGE_IMPORT,
    "@pin-op/devtools-elements-ui/upstream-runtime",
  );

  const extensionRoot = resolve(repositoryRoot, "extensions/chrome");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pin-op-elements-runtime-"));
  try {
    const { inspectorPanelResult, elementsRuntimeResult } =
      await buildBrowserInspectorModules({
        extensionRoot,
        outdir: temporaryDirectory,
      });
    const inspectorSource = await readFile(
      resolve(temporaryDirectory, "inspectorPanel.js"),
      "utf8",
    );
    const runtimeSource = await readFile(
      resolve(temporaryDirectory, CHROMIUM_ELEMENTS_RUNTIME_FILENAME),
      "utf8",
    );
    const inspectorModule = parseModule(inspectorSource, "inspectorPanel.js");
    const runtimeModule = parseModule(
      runtimeSource,
      CHROMIUM_ELEMENTS_RUNTIME_FILENAME,
    );

    assert.deepEqual(importSources(inspectorModule), [CHROMIUM_ELEMENTS_RUNTIME_IMPORT]);
    assert.ok(
      importedNames(inspectorModule).includes("createElementsInspectorView"),
    );
    assert.equal(inspectorSource.includes(ELEMENTS_RUNTIME_PACKAGE_IMPORT), false);
    assert.deepEqual(importSources(runtimeModule), []);
    assert.ok(exportedNames(runtimeModule).includes("createElementsInspectorView"));

    const merged = mergeBrowserBundleMetafiles(
      inspectorPanelResult.metafile,
      elementsRuntimeResult.metafile,
    );
    assert.ok(Object.keys(merged.inputs).some((path) =>
      path.replaceAll("\\", "/").endsWith("/src/inspectorPanel.ts") ||
      path === "src/inspectorPanel.ts"
    ));
    assert.ok(Object.keys(merged.inputs).some((path) =>
      path.replaceAll("\\", "/").endsWith(
        "/packages/devtools-elements-ui/dist/upstreamRuntime.js",
      )
    ));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
    .map((statement) => statement.moduleSpecifier.text);
}

function importedNames(sourceFile) {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .flatMap((statement) =>
      statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.map(
          (element) => (element.propertyName ?? element.name).text,
        )
        : []
    );
}

function exportedNames(sourceFile) {
  return sourceFile.statements
    .filter(ts.isExportDeclaration)
    .flatMap((statement) =>
      statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : []
    );
}
