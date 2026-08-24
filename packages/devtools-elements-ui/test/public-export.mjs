import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as elementsUi from "../dist/index.js";
import { ElementsInspectorView } from "@pin-op/devtools-elements-ui";

assert.deepEqual(Object.keys(elementsUi).sort(), ["ElementsInspectorView"]);
assert.equal(elementsUi.ElementsInspectorView, ElementsInspectorView);
assert.equal(typeof ElementsInspectorView, "function");

const declarations = await readFile(
  new URL("../dist/index.d.ts", import.meta.url),
  "utf8",
);

const expectedExports = [
  "DeclarationState",
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
