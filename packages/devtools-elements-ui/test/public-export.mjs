import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as elementsUi from "../dist/index.js";
import * as upstreamRuntime from "../dist/upstreamRuntime.js";
import { ElementsInspectorView } from "@pin-op/devtools-elements-ui";

assert.deepEqual(Object.keys(elementsUi).sort(), ["ElementsInspectorView"]);
assert.equal(elementsUi.ElementsInspectorView, ElementsInspectorView);
assert.equal(typeof ElementsInspectorView, "function");
assert.deepEqual(Object.keys(upstreamRuntime), ["createElementsInspectorView"]);
assert.equal(typeof upstreamRuntime.createElementsInspectorView, "function");

const declarations = await readFile(
  new URL("../dist/index.d.ts", import.meta.url),
  "utf8",
);

const expectedExports = [
  "DeclarationState",
  "CreateElementsInspectorView",
  "ElementsInspectorHost",
  "ElementsInspectorView",
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
