import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as elementsUi from "../dist/index.js";
import * as upstreamRuntime from "../dist/upstreamRuntime.js";
import { ElementsInspectorView } from "@pin-op/devtools-elements-ui";
import * as chromiumAdapter from "@pin-op/devtools-elements-ui/chromium-adapter";

assert.deepEqual(Object.keys(elementsUi).sort(), ["ElementsInspectorView"]);
assert.equal(elementsUi.ElementsInspectorView, ElementsInspectorView);
assert.equal(typeof ElementsInspectorView, "function");
assert.deepEqual(Object.keys(upstreamRuntime), ["createElementsInspectorView"]);
assert.equal(typeof upstreamRuntime.createElementsInspectorView, "function");
assert.deepEqual(Object.keys(chromiumAdapter), [
  "createPinOpChromiumInspectorViewFactory",
]);
assert.equal(
  typeof chromiumAdapter.createPinOpChromiumInspectorViewFactory,
  "function",
);

const chromiumDeclarations = await readFile(
  new URL(
    "../dist/chromium/upstream/PinOpChromiumInspectorAdapter.d.ts",
    import.meta.url,
  ),
  "utf8",
);
for (const expectedExport of [
  "PinOpChromiumInspectorAdapterOptions",
  "PinOpChromiumInspectorRuntime",
  "createPinOpChromiumInspectorViewFactory",
]) {
  assert.match(chromiumDeclarations, new RegExp(`\\b${expectedExport}\\b`));
}
assert.doesNotMatch(chromiumDeclarations, /export\s+\*/);

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
  "--project",
  fileURLToPath(new URL("./public-types.tsconfig.json", import.meta.url)),
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});

const declarations = await readFile(
  new URL("../dist/index.d.ts", import.meta.url),
  "utf8",
);

const expectedExports = [
  "CreateElementsRulesRenderer",
  "CreateElementsTreeRenderer",
  "DeclarationState",
  "CreateElementsInspectorView",
  "ElementsInspectorHost",
  "ElementsRulesRendererHost",
  "ElementsInspectorView",
  "ElementsTreeRendererHost",
  "GeneratedRuleSourceSnapshot",
  "InheritedRulesSnapshot",
  "InspectorAttributeSnapshot",
  "InspectorNodeKind",
  "InspectorNodeRelationship",
  "InspectorNodeSnapshot",
  "MatchedDeclarationSnapshot",
  "MatchedRuleSnapshot",
  "MatchedStylesSnapshot",
  "PseudoState",
  "PseudoStateDataSource",
  "PseudoStateDisabledReason",
  "PseudoStatePresentationState",
  "PseudoStateSnapshot",
  "RuleContextKind",
  "RuleContextSnapshot",
  "RulesDataSource",
  "RulesDiagnosticSeverity",
  "RulesDiagnosticSnapshot",
  "RulesPresentationSnapshot",
  "RulesPresentationState",
  "SourceLinkDelegate",
  "TreeDataSource",
  "TreePresentationSnapshot",
  "TreeRowSnapshot",
].sort();

for (const neutralExport of expectedExports) {
  assert.match(declarations, new RegExp(`\\b${neutralExport}\\b`));
}

const declaredExports = [...declarations.matchAll(/export(?:\s+type)?\s*\{([^}]+)\}/g)]
  .flatMap((match) => match[1].split(","))
  .map((name) => name.trim().split(/\s+as\s+/)[1] ?? name.trim())
  .filter(Boolean)
  .sort();
assert.deepEqual(declaredExports, expectedExports);
assert.doesNotMatch(declarations, /export\s+\*/);

for (const forbiddenExport of [
  "CSSModel",
  "DOMModel",
  "ElementsPanel",
  "Linkifier",
  "OverlayModel",
  "TargetManager",
]) {
  assert.doesNotMatch(declarations, new RegExp(`\\b${forbiddenExport}\\b`));
}
