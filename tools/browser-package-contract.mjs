import { createHash } from "node:crypto";
import { load } from "cheerio";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import ts from "typescript";
import { parseRuntimeMetadata } from "./runtime-metadata.mjs";

const PANEL_HTML_MARKERS = Object.freeze([
  ["Auto Refresh control", "Auto Refresh"],
  ["IDE Highlight control", "IDE Highlight"],
  ["DOM tree asset", 'id="dom-tree"'],
  ["DOM tree asset", 'id="dom-tree-spacer"'],
  ["DOM tree asset", 'id="dom-tree-empty"'],
  ["DOM tree asset", 'role="tree"'],
  ["connection controls", "Disconnect"],
  ["workspace", 'id="panel-workspace"'],
  ["workspace", 'id="workspace-tabs"'],
  ["DOM workspace", 'id="dom-tab"'],
  ["DOM workspace", 'id="dom-pane"'],
  ["Source workspace", 'id="source-tab"'],
  ["Source workspace", 'id="source-pane"'],
  ["source pane", 'id="source-pane-root"'],
  ["responsive workspace", 'id="pane-separator"'],
  ["incompatibility copy", "Extensions are incompatible"],
  [
    "incompatibility copy",
    "Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.",
  ],
  ["resolution footer", 'class="panel-footer"'],
  ["resolution footer", 'id="resolution-status"'],
  ["source navigation footer", "source-navigation-footer"],
  ["branded footer", 'id="panel-branding"'],
  ["branded footer", 'href="mailto:info@conus.vision"'],
  ["branded footer", 'href="https://conus.vision"'],
]);
const PANEL_CSS_MARKERS = Object.freeze([
  ["responsive toolbar", ".panel-toolbar-scroll"],
  ["responsive split layout", '[data-layout="split"]'],
  ["responsive stack layout", '[data-layout="stack"]'],
  ["responsive tab layout", '[data-layout="tabs"]'],
  ["workspace style", ".workspace-pane"],
  ["DOM tree style", ".dom-tree-row"],
  ["DOM tree style", ".is-shadow-root"],
  ["DOM tree style", ".is-frame-document"],
  ["DOM tree style", ".is-inaccessible"],
  ["resolution footer style", ".panel-footer"],
  ["resolution footer style", '.resolution-status[data-tone="success"]'],
  ["resolution footer style", '.resolution-status[data-tone="warning"]'],
  ["resolution footer style", '.resolution-status[data-tone="error"]'],
  ["source navigation controls", ".source-navigation-controls"],
  ["source excerpt style", ".source-pane-excerpt"],
  ["branded footer style", ".panel-branding"],
]);
const PANEL_BUNDLE_MARKERS = Object.freeze([
  ["source presentation capability", "source-presentation"],
  ["source matches", "source.matches"],
  ["source open", "source.open"],
  ["source navigation intent", "source.navigate"],
  ["source navigation state", "source.navigationState"],
  ["opaque match identity", "matchId"],
  ["locator recovery", "dom.resolveLocator"],
]);
const INSPECTOR_BUNDLE_MARKERS = Object.freeze([
  ["pseudo-state request", "styles.setPseudoStates"],
  ["pseudo-state response", "styles.pseudoStates"],
  ["pseudo-state revision", "pseudoStateRevision"],
  ["bounded pseudo-state list", '["hover","focus"]'],
]);
const ELEMENTS_RUNTIME_BUNDLE_MARKERS = Object.freeze([
  ["Elements Inspector factory", "createElementsInspectorView"],
  ["read-only Rules", "aria-readonly"],
  ["Rules renderer", "Rules"],
  ["pseudo-state label prefix", "Preview :"],
  ["pseudo-state control attribute", "data-pseudo-state"],
]);
const INSPECTOR_CSS_MARKERS = Object.freeze([
  ["pseudo-state button selector", ".pseudo-state-button"],
  ["pseudo-state menu selector", ".pseudo-state-menu"],
]);
const CONTENT_SCRIPT_BUNDLE_MARKERS = Object.freeze([
  ["selection preview marker", "data-pin-op-preview-selected-"],
  ["hover preview marker", "data-pin-op-preview-hover-"],
  ["focus preview marker", "data-pin-op-preview-focus-"],
  ["runtime style marker", "data-pin-op-runtime-"],
  ["runtime artifact node exclusion", "isRuntimeArtifactNode"],
  ["runtime artifact attribute exclusion", "isRuntimeArtifactAttributeName"],
  ["runtime artifact mutation exclusion", "isRuntimeArtifactAttributeMutation"],
]);
const RULES_SOURCE_PROPERTY_MARKERS = Object.freeze([
  ["Rules inspect correlation", "inspectMessageId"],
  ["Rules generation", "rulesGeneration"],
  ["Rules open authority", "openAuthorityId"],
  ["Rules publication rule reference", "ruleRef"],
  ["Rules publication sources", "sources"],
  ["Rules unresolved count", "unresolvedRuleCount"],
  ["Rules source document", "document"],
  ["Rules source label", "label"],
  ["Rules source language", "languageId"],
  ["Rules source start line", "startLine"],
  ["Rules source start column", "startColumn"],
  ["Rules source confidence", "confidence"],
  ["Rules metadata", "metadata"],
]);
const RUNTIME_TEXT_ASSET_PATHS = Object.freeze([
  "manifest.json",
  "dist/background.js",
  "dist/chromiumElementsRuntime.js",
  "dist/contentScript.js",
  "dist/devtools.html",
  "dist/devtools.js",
  "dist/devtools-elements.css",
  "dist/inspector-panel.html",
  "dist/inspectorPanel.js",
  "dist/panel.css",
  "dist/panel.html",
  "dist/panel.js",
  "dist/pin-op.svg",
  "dist/runtime-metadata.json",
]);
const VISIBILITY_PROPERTIES = new Set([
  "display",
  "visibility",
  "content-visibility",
]);
const STYLE_CONTEXT_AT_RULES = new Set(["layer", "media", "supports"]);
const HIDDEN_CSS_VALUES = new Map([
  ["display", new Set(["none", "contents"])],
  ["visibility", new Set(["hidden", "collapse"])],
  ["content-visibility", new Set(["hidden"])],
]);
const INITIAL_CSS_VALUES = new Map([
  ["display", "inline"],
  ["visibility", "visible"],
  ["content-visibility", "visible"],
]);
const VISIBLE_DISPLAY_VALUES = new Set([
  "block",
  "flex",
  "flow",
  "flow-root",
  "grid",
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "inline-table",
  "list-item",
  "ruby",
  "ruby-base",
  "ruby-base-container",
  "ruby-text",
  "ruby-text-container",
  "run-in",
  "table",
  "table-caption",
  "table-cell",
  "table-column",
  "table-column-group",
  "table-footer-group",
  "table-header-group",
  "table-row",
  "table-row-group",
  "-webkit-box",
  "-webkit-inline-box",
]);
const CSS_WIDE_KEYWORDS = new Set([
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "unset",
]);
const MAX_CUSTOM_PROPERTY_DEPTH = 32;
const MAX_RESOLVED_CSS_VALUE_LENGTH = 16_384;
const MAX_STYLE_CONTEXTS = 12;
const STATIC_CODE_CAPABILITIES = new Set(["eval", "Function", "importScripts"]);
const MAX_STATIC_STRING_CANDIDATES = 32;
const MAX_STATIC_STRING_LENGTH = 256;

// zod@3.25.76 v3's describe helper clones schemas through this.constructor.
// PostCSS and postcss-selector-parser were reviewed at their pinned versions:
// their constructor references clone typed AST nodes and wire prototypes; they
// do not resolve or invoke the global Function/eval capabilities. Trust only
// these reviewed helpers in the exact protocol-v7 legacy/Inspector esbuild
// outputs, hashing the raw archived bytes. Any retained helper requires
// deliberate review.
export const TRUSTED_ZOD_V3_BUNDLE_PROVENANCE = Object.freeze([
  Object.freeze({ browser: "chrome", path: "dist/background.js", sha256: "51d5726e9c07ba2b0d43e461876470e30bb3edbd76e79d13dd6b26967b0a959b", inspectorSha256: "418cc29318cf323edc5827b5b7dbfdc00898add0f81b76846fe69af59a4c9551" }),
  Object.freeze({ browser: "chrome", path: "dist/contentScript.js", sha256: "86c347b40d11fecd68fdf09ab96cf93895352ea003f704640c66780d560f9ee8", inspectorSha256: "86c347b40d11fecd68fdf09ab96cf93895352ea003f704640c66780d560f9ee8" }),
  Object.freeze({ browser: "chrome", path: "dist/devtools.js", sha256: "88f98da93c272282d2a025f603441d5f2a97bbd92821ad944ab08264ea6bca47", inspectorSha256: "b27daa5bc3e1033c88a4cfc734cd647d24e8d0fdacac5cdc80fab11686fadc07" }),
  Object.freeze({ browser: "chrome", path: "dist/inspectorPanel.js", sha256: "ec4ce2834741b1d1ba68a8b6c2c3446eb5f3b26bf70ea54d42a2bc6d80fd9f8b", inspectorSha256: "ec4ce2834741b1d1ba68a8b6c2c3446eb5f3b26bf70ea54d42a2bc6d80fd9f8b" }),
  Object.freeze({ browser: "chrome", path: "dist/chromiumElementsRuntime.js", sha256: "af14f70d2a6ebd0c7c465836448fd5c780149c7874f14187ef5eeec60e686a17", inspectorSha256: "af14f70d2a6ebd0c7c465836448fd5c780149c7874f14187ef5eeec60e686a17" }),
  Object.freeze({ browser: "chrome", path: "dist/panel.js", sha256: "b61c6f4660ef3df0e93286bad8de19960c12f0f7d277353d5b5db464fde29483", inspectorSha256: "b61c6f4660ef3df0e93286bad8de19960c12f0f7d277353d5b5db464fde29483" }),
  Object.freeze({ browser: "firefox", path: "dist/background.js", sha256: "f4cb9afbcf76e95d1a86849d112fedec178346827a300320474dce36da6e40ce", inspectorSha256: "188ab7b04531cd878fb457b800d5a93362108f22c838b3580136c1b340c82b96" }),
  Object.freeze({ browser: "firefox", path: "dist/contentScript.js", sha256: "86c347b40d11fecd68fdf09ab96cf93895352ea003f704640c66780d560f9ee8", inspectorSha256: "86c347b40d11fecd68fdf09ab96cf93895352ea003f704640c66780d560f9ee8" }),
  Object.freeze({ browser: "firefox", path: "dist/devtools.js", sha256: "9ccd3f59c92b024c4400e0c2c230e19262caed0855b292e448edd9d3707a6b58", inspectorSha256: "bd70c7203c3aa689dbea242a3f9bbafd898b38d962cc8db8cd69e083b8e5c86d" }),
  Object.freeze({ browser: "firefox", path: "dist/inspectorPanel.js", sha256: "ec4ce2834741b1d1ba68a8b6c2c3446eb5f3b26bf70ea54d42a2bc6d80fd9f8b", inspectorSha256: "ec4ce2834741b1d1ba68a8b6c2c3446eb5f3b26bf70ea54d42a2bc6d80fd9f8b" }),
  Object.freeze({ browser: "firefox", path: "dist/chromiumElementsRuntime.js", sha256: "af14f70d2a6ebd0c7c465836448fd5c780149c7874f14187ef5eeec60e686a17", inspectorSha256: "af14f70d2a6ebd0c7c465836448fd5c780149c7874f14187ef5eeec60e686a17" }),
  Object.freeze({ browser: "firefox", path: "dist/panel.js", sha256: "b61c6f4660ef3df0e93286bad8de19960c12f0f7d277353d5b5db464fde29483", inspectorSha256: "b61c6f4660ef3df0e93286bad8de19960c12f0f7d277353d5b5db464fde29483" }),
]);

export function assertRulesSourceJavaScriptContract(
  source,
  artifactLabel,
  { requiredStrings = [] } = {},
) {
  const sourceFile = ts.createSourceFile(
    `${artifactLabel}.js`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`${artifactLabel} contains invalid static JavaScript`);
  }
  const exactStrings = new Set();
  const exactProperties = new Set();
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      exactStrings.add(node.text);
    }
    const propertyName = javaScriptPropertyName(node);
    if (propertyName !== undefined) exactProperties.add(propertyName);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [label, marker] of requiredStrings) {
    if (!exactStrings.has(marker)) {
      throw new Error(
        `${artifactLabel} ${label} is missing exact JavaScript string ${marker}`,
      );
    }
  }
  for (const [label, marker] of RULES_SOURCE_PROPERTY_MARKERS) {
    if (!exactProperties.has(marker)) {
      throw new Error(
        `${artifactLabel} ${label} is missing exact JavaScript property ${marker}:`,
      );
    }
  }
  const forbiddenRulesOpenLiteral = [...exactStrings].find(
    (value) => isForbiddenRulesOpenLiteral(value),
  );
  if (forbiddenRulesOpenLiteral !== undefined) {
    throw new Error(
      `${artifactLabel} contains forbidden Rules open acknowledgement ` +
        forbiddenRulesOpenLiteral,
    );
  }
}

function javaScriptPropertyName(node) {
  if (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return staticPropertyName(node.name);
  }
  if (ts.isBindingElement(node)) {
    return staticPropertyName(node.propertyName ?? node.name);
  }
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isForbiddenRulesOpenLiteral(value) {
  if (value === "rules.open" || value === "pin-op.rules.open") return false;
  return /^(?:pin-op\.)?rules\.open[A-Za-z0-9._:-]+$/.test(value);
}

export function assertBrowserPackageRuntimeContract(
  archive,
  { artifactLabel, metadataLabel, platform, panelVariant },
) {
  if (panelVariant !== "legacy" && panelVariant !== "inspector") {
    throw new Error(`${artifactLabel} requires an explicit browser panel variant`);
  }
  const expectedPanelPage = panelVariant === "legacy"
    ? "/dist/panel.html"
    : "/dist/inspector-panel.html";
  for (const path of ["dist/devtools.js", "dist/background.js"]) {
    assertCompiledPanelPage(archive, artifactLabel, path, expectedPanelPage);
  }
  assertStaticPanelResourceBoundary(
    archive,
    artifactLabel,
    "dist/panel.html",
    ["./panel.css"],
    ["./panel.js"],
    [],
  );
  assertStaticPanelResourceBoundary(
    archive,
    artifactLabel,
    "dist/inspector-panel.html",
    ["./panel.css", "./devtools-elements.css"],
    ["./inspectorPanel.js"],
    ["./inspectorPanel.js"],
  );
  assertNoRemoteCssResources(
    archive,
    artifactLabel,
    "dist/panel.css",
    "panel",
  );
  assertScopedChromiumCss(archive, artifactLabel);
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/devtools-elements.css",
    INSPECTOR_CSS_MARKERS,
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/inspectorPanel.js",
    [["Inspector runtime", "inspector-workspace"], ...INSPECTOR_BUNDLE_MARKERS],
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/chromiumElementsRuntime.js",
    ELEMENTS_RUNTIME_BUNDLE_MARKERS,
  );
  assertStaticElementsRuntimeBoundary(archive, artifactLabel);
  assertNoLocalPathsInRuntimeAssets(archive, artifactLabel);
  assertBrowserBundlesAreStatic(
    archive,
    artifactLabel,
    platform,
    panelVariant,
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/panel.html",
    PANEL_HTML_MARKERS,
  );
  assertPanelHtmlContract(archive, artifactLabel);
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/panel.css",
    PANEL_CSS_MARKERS,
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/inspector-panel.html",
    [
      ["Inspector workspace", 'id="inspector-workspace"'],
      ["Inspector mount", 'id="inspector-elements-mount"'],
      ["Inspector bundle", 'src="./inspectorPanel.js"'],
    ],
  );
  assertRulesSourceJavaScriptContract(
    archive.files.get("dist/inspectorPanel.js").toString("utf8"),
    `${artifactLabel} dist/inspectorPanel.js`,
    {
      requiredStrings: [
        ["matched styles request", "styles.getMatched"],
        ["Rules source publication", "rules.sources"],
        ["Rules source open intent", "pin-op.rules.open"],
      ],
    },
  );
  assertRulesSourceJavaScriptContract(
    archive.files.get("dist/background.js").toString("utf8"),
    `${artifactLabel} dist/background.js`,
    {
      requiredStrings: [
        ["Rules source capability", "rules-sources"],
        ["Rules source publication", "rules.sources"],
        ["Rules source open", "rules.open"],
        ["Rules source open intent", "pin-op.rules.open"],
      ],
    },
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/panel.js",
    PANEL_BUNDLE_MARKERS,
  );
  assertTextMarkers(
    archive,
    artifactLabel,
    "dist/contentScript.js",
    CONTENT_SCRIPT_BUNDLE_MARKERS,
  );
  parseRuntimeMetadata(archive.files.get("dist/runtime-metadata.json"), {
    expectedProtocolVersion: 7,
    label: metadataLabel,
  });
}

function assertCompiledPanelPage(
  archive,
  artifactLabel,
  path,
  expectedPanelPage,
) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  const sourceFile = ts.createSourceFile(
    path,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`${artifactLabel} ${path} contains invalid static JavaScript`);
  }
  let panelPage;
  const visit = (node) => {
    if (
      panelPage === undefined &&
      ts.isFunctionDeclaration(node) &&
      node.body?.getText(sourceFile).includes("Invalid compiled panel page")
    ) {
      for (const statement of node.body.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            declaration.initializer &&
            (ts.isStringLiteral(declaration.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(declaration.initializer)) &&
            declaration.initializer.text.startsWith("/dist/")
          ) {
            panelPage = declaration.initializer.text;
          }
        }
      }
    }
    if (panelPage === undefined) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (panelPage !== expectedPanelPage) {
    const expectedVariant = expectedPanelPage === "/dist/panel.html"
      ? "legacy panel"
      : "Inspector panel";
    throw new Error(
      `${artifactLabel} ${path} expected ${expectedVariant} ` +
        `${expectedPanelPage}; found ${panelPage ?? "no compiled panel page"}`,
    );
  }
}

function assertStaticPanelResourceBoundary(
  archive,
  artifactLabel,
  path,
  expectedStylesheets,
  expectedScripts,
  expectedModuleScripts,
) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  const $ = load(bytes.toString("utf8"));
  const stylesheets = [];
  const scripts = [];
  const moduleScripts = [];

  if ($("style").length > 0 || $("[style]").length > 0) {
    throw new Error(`${artifactLabel} ${path} contains inline style`);
  }
  if ($("base").length > 0) {
    throw new Error(`${artifactLabel} ${path} contains remote UI resource base`);
  }
  $("*").each((_index, element) => {
    const tagName = element.tagName?.toLowerCase();
    for (const [name, value] of Object.entries(element.attribs ?? {})) {
      if (/^on/i.test(name)) {
        throw new Error(`${artifactLabel} ${path} contains inline event handler`);
      }
      const attribute = name.toLowerCase();
      if (attribute === "srcdoc") {
        throw new Error(`${artifactLabel} ${path} contains inline frame srcdoc`);
      }
      if (attribute === "ping") {
        throw new Error(`${artifactLabel} ${path} contains remote UI resource ${value}`);
      }
      if (attribute === "srcset" || attribute === "imagesrcset") {
        assertSafeLocalSrcset(value, artifactLabel, path);
      }
      if (
        (attribute === "href" && tagName !== "a" && tagName !== "area") ||
        attribute === "xlink:href" ||
        attribute === "background"
      ) {
        assertSafeLocalUiResource(value, artifactLabel, path);
      }
      if (
        (tagName === "form" && attribute === "action") ||
        attribute === "formaction"
      ) {
        throw new Error(`${artifactLabel} ${path} contains remote UI resource ${value}`);
      }
      if (
        (tagName === "a" || tagName === "area") &&
        attribute === "href" &&
        !isApprovedPanelNavigation(value)
      ) {
        throw new Error(`${artifactLabel} ${path} contains remote UI resource ${value}`);
      }
      if (
        hasRemoteCssResource(value)
      ) {
        throw new Error(`${artifactLabel} ${path} contains remote UI resource ${value}`);
      }
    }
    if (
      tagName === "meta" &&
      ($(element).attr("http-equiv") ?? "").trim().toLowerCase() === "refresh"
    ) {
      throw new Error(`${artifactLabel} ${path} contains meta refresh`);
    }
  });
  $("script").each((_index, element) => {
    const source = $(element).attr("src");
    if (!source || $(element).text().trim()) {
      throw new Error(`${artifactLabel} ${path} contains inline script`);
    }
    scripts.push(source);
    if (($(element).attr("type") ?? "").trim().toLowerCase() === "module") {
      moduleScripts.push(source);
    }
  });
  $("link").each((_index, element) => {
    const rel = ($(element).attr("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (rel.includes("stylesheet")) {
      stylesheets.push($(element).attr("href") ?? "");
    }
  });
  for (const [selector, attribute] of [
    ["script[src]", "src"],
    ["link[href]", "href"],
    ["img[src]", "src"],
    ["iframe[src]", "src"],
    ["frame[src]", "src"],
    ["object[data]", "data"],
    ["embed[src]", "src"],
    ["source[src]", "src"],
    ["audio[src]", "src"],
    ["video[src]", "src"],
    ["video[poster]", "poster"],
    ["track[src]", "src"],
    ["input[src]", "src"],
  ]) {
    $(selector).each((_index, element) => {
      const resource = $(element).attr(attribute) ?? "";
      if (!isSafeLocalUiResource(resource)) {
        throw new Error(
          `${artifactLabel} ${path} contains remote UI resource ${resource}`,
        );
      }
    });
  }
  if (!sameStrings(stylesheets, expectedStylesheets)) {
    throw new Error(`${artifactLabel} ${path} has unexpected stylesheet order`);
  }
  if (!sameStrings(scripts, expectedScripts)) {
    throw new Error(`${artifactLabel} ${path} has unexpected script resources`);
  }
  if (!sameStrings(moduleScripts, expectedModuleScripts)) {
    throw new Error(`${artifactLabel} ${path} has unexpected module scripts`);
  }
}

function assertStaticElementsRuntimeBoundary(archive, artifactLabel) {
  const inspectorPath = "dist/inspectorPanel.js";
  const runtimePath = "dist/chromiumElementsRuntime.js";
  const inspectorModule = parseStaticModule(archive, artifactLabel, inspectorPath);
  const runtimeModule = parseStaticModule(archive, artifactLabel, runtimePath);
  const inspectorImports = inspectorModule.statements.filter(
    ts.isImportDeclaration,
  );
  if (
    inspectorImports.length !== 1 ||
    !ts.isStringLiteral(inspectorImports[0].moduleSpecifier) ||
    inspectorImports[0].moduleSpecifier.text !== "./chromiumElementsRuntime.js"
  ) {
    throw new Error(
      `${artifactLabel} ${inspectorPath} must statically import exactly ./chromiumElementsRuntime.js`,
    );
  }
  const importedFactory = inspectorImports[0].importClause?.namedBindings;
  if (
    !importedFactory ||
    !ts.isNamedImports(importedFactory) ||
    !importedFactory.elements.some(
      (element) =>
        (element.propertyName ?? element.name).text ===
          "createElementsInspectorView",
    )
  ) {
    throw new Error(
      `${artifactLabel} ${inspectorPath} must statically import createElementsInspectorView`,
    );
  }
  if (runtimeModule.statements.some((statement) =>
    ts.isImportDeclaration(statement) ||
    (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
  )) {
    throw new Error(`${artifactLabel} ${runtimePath} must be a bundled ESM module`);
  }
  const exportsFactory = runtimeModule.statements
    .filter(ts.isExportDeclaration)
    .some((statement) =>
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => element.name.text === "createElementsInspectorView",
      )
    );
  if (!exportsFactory) {
    throw new Error(
      `${artifactLabel} ${runtimePath} must export createElementsInspectorView`,
    );
  }
}

function parseStaticModule(archive, artifactLabel, path) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  const sourceFile = ts.createSourceFile(
    path,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`${artifactLabel} ${path} contains invalid static JavaScript`);
  }
  return sourceFile;
}

function assertNoRemoteCssResources(archive, artifactLabel, path, kind) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  let root;
  try {
    root = postcss.parse(bytes.toString("utf8"), { from: path });
  } catch (error) {
    throw new Error(`${artifactLabel} has invalid ${kind} CSS: ${error.message}`);
  }
  root.walkAtRules((atRule) => {
    if (decodeCssIdentifier(atRule.name) === "import") {
      throw new Error(`${artifactLabel} contains remote ${kind} CSS resource`);
    }
  });
  root.walkDecls((declaration) => {
    if (hasRemoteCssResource(declaration.value)) {
      throw new Error(`${artifactLabel} contains remote ${kind} CSS resource`);
    }
  });
}

function assertScopedChromiumCss(archive, artifactLabel) {
  const path = "dist/devtools-elements.css";
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  let root;
  try {
    root = postcss.parse(bytes.toString("utf8"), { from: path });
  } catch (error) {
    throw new Error(`${artifactLabel} has invalid Chromium CSS: ${error.message}`);
  }
  root.walkAtRules((atRule) => {
    const name = decodeCssIdentifier(atRule.name);
    if (name === "import") {
      throw new Error(`${artifactLabel} contains remote Chromium CSS resource`);
    }
    if (isKeyframesAtRuleName(name)) {
      const keyframeName = decodeCssIdentifier(atRule.params);
      if (!/^pin-op-elements-[a-z0-9_-]+$/.test(keyframeName ?? "")) {
        throw new Error(`${artifactLabel} contains global Chromium CSS keyframes`);
      }
      return;
    }
    if (!["container", "layer", "media", "supports"].includes(name)) {
      throw new Error(`${artifactLabel} contains global Chromium CSS at-rule ${atRule.name}`);
    }
  });
  root.walkDecls((declaration) => {
    walkCssResourceFunctions(declaration.value, () => {
      throw new Error(`${artifactLabel} contains remote Chromium CSS resource`);
    });
  });
  root.walkRules((rule) => {
    if (isKeyframeRule(rule)) return;
    for (const selector of rule.selectors) {
      if (!isScopedChromiumSelector(selector)) {
        throw new Error(
          `${artifactLabel} contains unscoped Chromium CSS selector ${selector}`,
        );
      }
    }
  });
}

const LOCAL_PATH_PATTERNS = Object.freeze([
  [
    "local file URI",
    /(?:^|[^A-Za-z0-9+.-])(file:\/\/\/*[^\s\/"'`<>][^\s"'`<>]*)/m,
  ],
  [
    "local Windows device path",
    /(?:^|[\s"'`=(\[{,;])((?:\\\\|\/\/)[?.][\\/][^\s"'`<>]+)/m,
  ],
  [
    "local drive path",
    /(?:^|[^A-Za-z0-9])([A-Za-z]:[\\/]+[^\\/\s"'`<>][^\s"'`<>]*)/m,
  ],
  [
    "local UNC path",
    /(?:^|[\s"'`=(\[{,;])((?:\\\\|\/\/)[A-Za-z0-9][A-Za-z0-9._$-]*[\\/][^\\/\s"'`<>]+)/m,
  ],
  [
    "local POSIX path",
    /(?:^|[^A-Za-z0-9:/.])((?:\/Users\/[^/\s"'`<>]+|\/home\/[^/\s"'`<>]+|\/root|\/private|\/tmp|\/var\/folders\/[^/\s"'`<>]+|\/workspaces?(?:\/[^/\s"'`<>]+)?|\/mnt\/[A-Za-z]|\/opt|\/srv)\/[^\s"'`<>]+)/m,
  ],
]);

function assertNoLocalPathsInRuntimeAssets(archive, artifactLabel) {
  for (const path of RUNTIME_TEXT_ASSET_PATHS) {
    const bytes = archive.files.get(path);
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`${artifactLabel} is missing ${path}`);
    }
    const text = bytes.toString("utf8");
    const match = path.endsWith(".js")
      ? findJavaScriptCommentLocalPath(text)
      : findEmbeddedLocalPath(text);
    if (!match) continue;
    const { line, column } = lineAndColumnAt(text, match.index);
    throw new Error(
      `${artifactLabel} ${path} contains ${match.kind} at ${line}:${column}`,
    );
  }
}

function findJavaScriptCommentLocalPath(source) {
  const sourceFile = ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const seen = new Set();
  const matches = [];
  const inspectRanges = (ranges) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const match = findEmbeddedLocalPath(source.slice(range.pos, range.end));
      if (match) {
        matches.push({ ...match, index: range.pos + match.index });
      }
    }
  };
  const visit = (node) => {
    inspectRanges(ts.getLeadingCommentRanges(source, node.pos));
    inspectRanges(ts.getTrailingCommentRanges(source, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches.sort((left, right) => left.index - right.index)[0];
}

function findEmbeddedLocalPath(value) {
  for (const [kind, pattern] of LOCAL_PATH_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const matchedPath = match[1];
    return {
      kind,
      index: value.indexOf(matchedPath, match.index),
    };
  }
  return undefined;
}

function lineAndColumnAt(value, index) {
  const before = value.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: index - lastNewline };
}

function assertBrowserBundlesAreStatic(
  archive,
  artifactLabel,
  platform,
  panelVariant,
) {
  for (const path of [
    "dist/background.js",
    "dist/chromiumElementsRuntime.js",
    "dist/contentScript.js",
    "dist/devtools.js",
    "dist/panel.js",
    "dist/inspectorPanel.js",
  ]) {
    const bytes = archive.files.get(path);
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`${artifactLabel} is missing ${path}`);
    }
    const source = bytes.toString("utf8");
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    assertStaticJavaScript(source, artifactLabel, path, {
      platform,
      panelVariant,
      sourceSha256,
    });
    if (
      /(?:third_party\/)?chromium-devtools-frontend[\\/]upstream[\\/]/i.test(
        source,
      )
    ) {
      throw new Error(`${artifactLabel} ${path} contains an upstream snapshot import`);
    }
  }
}

function isSafeLocalUiResource(resource) {
  return (
    /^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(resource) &&
    !resource.split("/").includes("..")
  );
}

function assertSafeLocalUiResource(resource, artifactLabel, path) {
  if (!isSafeLocalUiResource(resource)) {
    throw new Error(
      `${artifactLabel} ${path} contains remote UI resource ${resource}`,
    );
  }
}

function assertSafeLocalSrcset(srcset, artifactLabel, path) {
  const candidates = srcset.split(",").map((candidate) => candidate.trim());
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => {
      const [resource, ...descriptors] = candidate.split(/\s+/);
      return (
        !resource ||
        !isSafeLocalUiResource(resource) ||
        descriptors.length > 1 ||
        (descriptors.length === 1 && !/^\d+(?:\.\d+)?x$|^\d+w$/.test(descriptors[0]))
      );
    })
  ) {
    throw new Error(`${artifactLabel} ${path} contains remote UI resource srcset`);
  }
}

function isApprovedPanelNavigation(resource) {
  return resource === "mailto:info@conus.vision" ||
    resource === "https://conus.vision";
}

function walkCssResourceFunctions(value, callback) {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  valueParser(withoutComments).walk((node) => {
    if (node.type !== "function") return;
    const name = decodeCssIdentifier(node.value);
    if (["url", "image-set", "-webkit-image-set"].includes(name)) {
      callback(node, name);
    }
  });
}

function hasRemoteCssResource(value) {
  let remote = false;
  walkCssResourceFunctions(value, (node, name) => {
    if (name !== "url") {
      remote = true;
      return;
    }
    const rawResource = valueParser.stringify(node.nodes).trim();
    const resource = rawResource.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    const decodedResource = decodeCssEscapedText(resource)?.trim();
    if (
      decodedResource === undefined ||
      (!isSafeLocalUiResource(decodedResource) &&
        !/^#[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(decodedResource))
    ) {
      remote = true;
    }
  });
  return remote;
}

function isKeyframesAtRuleName(name) {
  return /^(?:-[a-z]+-)?keyframes$/.test(name ?? "");
}

function isKeyframeRule(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (
      parent.type === "atrule" &&
      isKeyframesAtRuleName(decodeCssIdentifier(parent.name))
    ) {
      return true;
    }
  }
  return false;
}

function isScopedChromiumSelector(selector) {
  let scoped = true;
  try {
    selectorParser((root) => {
      root.each((candidate) => {
        const nodes = candidate.nodes;
        if (
          nodes[0]?.type !== "class" ||
          nodes[0].value !== "pin-op-elements-inspector"
        ) {
          scoped = false;
          return;
        }
        let descendantBoundary = false;
        for (const node of nodes.slice(1)) {
          if (node.type !== "combinator") continue;
          const combinator = node.value.trim();
          if (combinator === "||") {
            scoped = false;
            return;
          }
          if ((combinator === "+" || combinator === "~") && !descendantBoundary) {
            scoped = false;
            return;
          }
          if (combinator === "" || combinator === ">") {
            descendantBoundary = true;
          }
        }
      });
    }).processSync(selector);
  } catch {
    return false;
  }
  return scoped;
}

function assertStaticJavaScript(
  source,
  artifactLabel,
  path,
  { platform, panelVariant, sourceSha256 },
) {
  const analysisPath = path.replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(
    analysisPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`${artifactLabel} ${path} contains invalid static JavaScript`);
  }
  const checker = createStaticJavaScriptChecker(sourceFile, analysisPath);
  const capabilityAliases = new Map();
  const globalObjectAliases = new Set();
  const staticStringAliases = new Map();
  collectStaticJavaScriptAliases(
    sourceFile,
    checker,
    capabilityAliases,
    globalObjectAliases,
    staticStringAliases,
    { platform, panelVariant, path, sourceSha256 },
  );
  const provenance = { platform, panelVariant, path, sourceSha256 };
  const reviewedAstClones = collectReviewedPostCssAstClones(
    sourceFile,
    checker,
  );
  const trustedAstClones = hasTrustedBundleProvenance(provenance) &&
      reviewedAstClones.length === 2
    ? new Set(reviewedAstClones)
    : new Set();

  let violation;
  const reject = (kind, node) => {
    violation = { kind, node };
  };
  const visit = (node) => {
    if (violation) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const localPath = findEmbeddedLocalPath(node.text);
      if (localPath) {
        reject(localPath.kind, node);
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        reject("remote code loading", node);
        return;
      }
      const reflectedCapability = reflectedCodeCapability(
        node,
        checker,
        capabilityAliases,
        globalObjectAliases,
        staticStringAliases,
      );
      const capability = reflectedCapability ?? invokedCodeCapability(
        node.expression,
        checker,
        capabilityAliases,
        globalObjectAliases,
        staticStringAliases,
      );
      if (capability) {
        reject(
          capability === "importScripts"
            ? "remote code loading"
            : "dynamic code evaluation",
          node,
        );
        return;
      }
    }
    if (ts.isNewExpression(node)) {
      const capability = resolveCodeCapability(
        node.expression,
        checker,
        capabilityAliases,
        globalObjectAliases,
        staticStringAliases,
      );
      if (capability === "Function" || capability === "eval") {
        if (trustedAstClones.has(node)) {
          ts.forEachChild(node, visit);
          return;
        }
        reject("dynamic code evaluation", node);
        return;
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const capability = resolveCodeCapability(
        node.tag,
        checker,
        capabilityAliases,
        globalObjectAliases,
        staticStringAliases,
      );
      if (capability) {
        reject(
          capability === "importScripts"
            ? "remote code loading"
            : "dynamic code evaluation",
          node,
        );
        return;
      }
    }
    const referencedCapability = globalCodeCapabilityReference(
      node,
      checker,
      globalObjectAliases,
      staticStringAliases,
    ) ?? destructuredGlobalCodeCapability(
      node,
      checker,
      globalObjectAliases,
      staticStringAliases,
    );
    if (referencedCapability) {
      reject(
        referencedCapability === "importScripts"
          ? "remote code loading"
          : "dynamic code evaluation",
        node,
      );
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (violation) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      violation.node.getStart(sourceFile),
    );
    throw new Error(
      `${artifactLabel} ${path} contains ${violation.kind} at ${line + 1}:${character + 1} ` +
        `(sha256 ${sourceSha256})`,
    );
  }
}

function createStaticJavaScriptChecker(sourceFile, path) {
  const options = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = {
    fileExists: (candidate) => candidate === path,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => candidate === path ? sourceFile : undefined,
    readFile: (candidate) => candidate === path ? sourceFile.text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  return ts.createProgram([path], options, host).getTypeChecker();
}

function collectStaticJavaScriptAliases(
  sourceFile,
  checker,
  capabilityAliases,
  globalObjectAliases,
  staticStringAliases,
  provenance,
) {
  const assignments = [];
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      assignments.push({
        name: node.name,
        initializer: node.initializer,
        source: node,
      });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push({
        name: node.left,
        initializer: node.right,
        source: node,
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  collectStaticStringAliases(assignments, checker, staticStringAliases);

  const schemaCloneAssignments = assignments.filter((assignment) =>
    isZodSchemaCloneConstructorAliasSyntax(assignment, checker)
  );
  const hasTrustedBundleProvenanceValue = hasTrustedBundleProvenance(provenance);
  const trustedSchemaCloneAssignment =
    hasTrustedBundleProvenanceValue && schemaCloneAssignments.length === 1
      ? schemaCloneAssignments[0]
      : undefined;

  for (let pass = 0; pass <= assignments.length; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      const symbol = checker.getSymbolAtLocation(assignment.name);
      if (!symbol) continue;
      if (
        !globalObjectAliases.has(symbol) &&
        isGlobalObjectExpression(
          assignment.initializer,
          checker,
          globalObjectAliases,
        )
      ) {
        globalObjectAliases.add(symbol);
        changed = true;
      }
      const capability = assignment === trustedSchemaCloneAssignment
        ? undefined
        : resolveCodeCapability(
          assignment.initializer,
          checker,
          capabilityAliases,
          globalObjectAliases,
          staticStringAliases,
        );
      if (capability && capabilityAliases.get(symbol) !== capability) {
        capabilityAliases.set(symbol, capability);
        changed = true;
      }
    }
    if (!changed) return;
  }
}

function hasTrustedBundleProvenance(provenance) {
  const digestKey = provenance.panelVariant === "inspector"
    ? "inspectorSha256"
    : "sha256";
  return TRUSTED_ZOD_V3_BUNDLE_PROVENANCE.some(
    (entry) =>
      entry.browser === provenance.platform &&
      entry.path === provenance.path &&
      entry[digestKey] === provenance.sourceSha256,
  );
}

function collectReviewedPostCssAstClones(sourceFile, checker) {
  const clones = [];
  const visit = (node) => {
    if (isReviewedPostCssAstCloneConstructor(node, checker)) clones.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return clones;
}

function isReviewedPostCssAstCloneConstructor(node, checker) {
  if (
    !ts.isNewExpression(node) ||
    (node.arguments?.length ?? 0) !== 0 ||
    node.typeArguments?.length
  ) {
    return false;
  }
  const constructor = staticMember(node.expression);
  const receiver = constructor && unwrapStaticExpression(constructor.expression);
  if (
    constructor?.name !== "constructor" ||
    !ts.isIdentifier(receiver) ||
    !ts.isVariableDeclaration(node.parent) ||
    node.parent.initializer !== node ||
    !ts.isIdentifier(node.parent.name)
  ) {
    return false;
  }

  let owner = node.parent.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (
    !owner ||
    owner.parameters.length !== 2 ||
    !ts.isIdentifier(owner.parameters[0].name) ||
    !owner.body ||
    !ts.isBlock(owner.body)
  ) {
    return false;
  }
  const receiverSymbol = checker.getSymbolAtLocation(receiver);
  if (
    !receiverSymbol ||
    receiverSymbol !== checker.getSymbolAtLocation(owner.parameters[0].name)
  ) {
    return false;
  }

  let copiesOwnProperties = false;
  const inspect = (candidate) => {
    if (
      ts.isForInStatement(candidate) &&
      ts.isIdentifier(unwrapStaticExpression(candidate.expression)) &&
      checker.getSymbolAtLocation(unwrapStaticExpression(candidate.expression)) ===
        receiverSymbol
    ) {
      copiesOwnProperties = true;
      return;
    }
    ts.forEachChild(candidate, inspect);
  };
  inspect(owner.body);
  return copiesOwnProperties;
}

function collectStaticStringAliases(assignments, checker, staticStringAliases) {
  for (let pass = 0; pass <= assignments.length; pass += 1) {
    let changed = false;
    for (const assignment of assignments) {
      const symbol = checker.getSymbolAtLocation(assignment.name);
      if (!symbol) continue;
      const values = staticStrings(
        assignment.initializer,
        checker,
        staticStringAliases,
      );
      if (!values) continue;
      const known = staticStringAliases.get(symbol) ?? new Set();
      for (const value of values) {
        if (known.size >= MAX_STATIC_STRING_CANDIDATES) break;
        if (!known.has(value)) {
          known.add(value);
          changed = true;
        }
      }
      if (known.size > 0) staticStringAliases.set(symbol, known);
    }
    if (!changed) return;
  }
}

function isZodSchemaCloneConstructorAliasSyntax(assignment, checker) {
  if (!ts.isVariableDeclaration(assignment.source)) return false;
  const constructor = staticMember(assignment.initializer);
  if (
    constructor?.name !== "constructor" ||
    unwrapStaticExpression(constructor.expression).kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return false;
  }

  const declarationList = assignment.source.parent;
  const variableStatement = declarationList?.parent;
  const body = variableStatement?.parent;
  const method = body?.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    declarationList.declarations.length !== 1 ||
    !ts.isVariableStatement(variableStatement) ||
    !ts.isBlock(body) ||
    !ts.isMethodDeclaration(method) ||
    !ts.isIdentifier(method.name) ||
    method.name.text !== "describe" ||
    method.parameters.length !== 1 ||
    !ts.isIdentifier(method.parameters[0].name) ||
    body.statements.length !== 2 ||
    body.statements[0] !== variableStatement ||
    !ts.isReturnStatement(body.statements[1])
  ) {
    return false;
  }

  const returned = unwrapStaticExpression(body.statements[1].expression);
  if (
    !ts.isNewExpression(returned) ||
    returned.arguments?.length !== 1 ||
    !ts.isObjectLiteralExpression(returned.arguments[0]) ||
    checker.getSymbolAtLocation(returned.expression) !==
      checker.getSymbolAtLocation(assignment.name)
  ) {
    return false;
  }

  const [spread, description] = returned.arguments[0].properties;
  if (
    returned.arguments[0].properties.length !== 2 ||
    !ts.isSpreadAssignment(spread) ||
    !isThisDefinitionReference(spread.expression)
  ) {
    return false;
  }
  const parameterSymbol = checker.getSymbolAtLocation(method.parameters[0].name);
  if (ts.isShorthandPropertyAssignment(description)) {
    return description.name.text === "description" &&
      checker.getShorthandAssignmentValueSymbol(description) === parameterSymbol;
  }
  return ts.isPropertyAssignment(description) &&
    staticPropertyName(description.name) === "description" &&
    checker.getSymbolAtLocation(unwrapStaticExpression(description.initializer)) ===
      parameterSymbol;
}

function isThisDefinitionReference(expression) {
  const member = staticMember(expression);
  return member?.name === "_def" &&
    unwrapStaticExpression(member.expression).kind === ts.SyntaxKind.ThisKeyword;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticString(name.expression);
  return undefined;
}

function invokedCodeCapability(
  expression,
  checker,
  capabilityAliases,
  globalObjectAliases,
  staticStringAliases,
) {
  const direct = resolveCodeCapability(
    expression,
    checker,
    capabilityAliases,
    globalObjectAliases,
    staticStringAliases,
  );
  if (direct) return direct;

  for (const member of staticMembers(expression, checker, staticStringAliases)) {
    if (!["apply", "bind", "call"].includes(member.name)) continue;
    const capability = resolveCodeCapability(
      member.expression,
      checker,
      capabilityAliases,
      globalObjectAliases,
      staticStringAliases,
    );
    if (capability) return capability;
  }
  return undefined;
}

function reflectedCodeCapability(
  call,
  checker,
  capabilityAliases,
  globalObjectAliases,
  staticStringAliases,
) {
  for (const member of staticMembers(
    call.expression,
    checker,
    staticStringAliases,
  )) {
    if (
      !["apply", "construct"].includes(member.name) ||
      !isUnboundGlobalIdentifier(member.expression, "Reflect", checker)
    ) {
      continue;
    }
    const capability = resolveCodeCapability(
      call.arguments[0],
      checker,
      capabilityAliases,
      globalObjectAliases,
      staticStringAliases,
    );
    if (capability) return capability;
  }
  return undefined;
}

function resolveCodeCapability(
  expression,
  checker,
  capabilityAliases,
  globalObjectAliases,
  staticStringAliases,
) {
  const node = unwrapStaticExpression(expression);
  if (!node) return undefined;
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol && capabilityAliases.has(symbol)) {
      return capabilityAliases.get(symbol);
    }
    if (symbol && hasLocalDeclaration(symbol, node.getSourceFile())) {
      return undefined;
    }
    if (["eval", "Function", "importScripts"].includes(node.text)) {
      return node.text;
    }
    return undefined;
  }

  for (const member of staticMembers(node, checker, staticStringAliases)) {
    if (
      isGlobalObjectExpression(member.expression, checker, globalObjectAliases) &&
      ["eval", "Function", "importScripts"].includes(member.name)
    ) {
      return member.name;
    }
    if (member.name === "constructor") return "Function";
  }
  return undefined;
}

function isGlobalObjectExpression(expression, checker, globalObjectAliases) {
  const node = unwrapStaticExpression(expression);
  if (!node || !ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol && globalObjectAliases.has(symbol)) return true;
  return ["globalThis", "window", "self", "global"].includes(node.text) &&
    !hasLocalDeclaration(symbol, node.getSourceFile());
}

function isUnboundGlobalIdentifier(node, name, checker) {
  const expression = unwrapStaticExpression(node);
  return ts.isIdentifier(expression) &&
    expression.text === name &&
    !hasLocalDeclaration(
      checker.getSymbolAtLocation(expression),
      expression.getSourceFile(),
    );
}

function hasLocalDeclaration(symbol, sourceFile) {
  return Boolean(symbol?.declarations?.some(
    (declaration) => declaration.getSourceFile() === sourceFile,
  ));
}

function globalCodeCapabilityReference(
  node,
  checker,
  globalObjectAliases,
  staticStringAliases,
) {
  if (ts.isIdentifier(node)) {
    if (!STATIC_CODE_CAPABILITIES.has(node.text)) return undefined;
    if (!isValueIdentifierReference(node)) return undefined;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (hasLocalDeclaration(symbol, node.getSourceFile())) return undefined;
    if (node.text === "Function" &&
        (isExactEsbuildFunctionHelperReference(node) ||
         isInertFunctionInstanceofReference(node))) {
      return undefined;
    }
    return node.text;
  }

  for (const member of staticMembers(node, checker, staticStringAliases)) {
    if (
      STATIC_CODE_CAPABILITIES.has(member.name) &&
      isGlobalObjectExpression(member.expression, checker, globalObjectAliases)
    ) {
      return member.name;
    }
  }
  return undefined;
}

function isInertFunctionInstanceofReference(node) {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node;
}

function destructuredGlobalCodeCapability(
  node,
  checker,
  globalObjectAliases,
  staticStringAliases,
) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isObjectBindingPattern(node.name) ||
    !node.initializer ||
    !isGlobalObjectExpression(node.initializer, checker, globalObjectAliases)
  ) {
    return undefined;
  }
  for (const element of node.name.elements) {
    const property = element.propertyName ?? element.name;
    const names = ts.isComputedPropertyName(property)
      ? staticStrings(property.expression, checker, staticStringAliases)
      : ts.isIdentifier(property) || ts.isStringLiteralLike(property)
      ? new Set([property.text])
      : undefined;
    for (const name of names ?? []) {
      if (STATIC_CODE_CAPABILITIES.has(name)) return name;
    }
  }
  return undefined;
}

function isValueIdentifierReference(node) {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) &&
      (parent.name === node || parent.propertyName === node))
  ) {
    return false;
  }
  return ts.isShorthandPropertyAssignment(parent) || ts.isInExpressionContext(node);
}

function isExactEsbuildFunctionHelperReference(node) {
  const callMember = node.parent;
  if (
    !ts.isPropertyAccessExpression(callMember) ||
    callMember.expression !== node ||
    callMember.name.text !== "call"
  ) {
    return false;
  }
  const bindMember = callMember.parent;
  if (
    !ts.isPropertyAccessExpression(bindMember) ||
    bindMember.expression !== callMember ||
    bindMember.name.text !== "bind"
  ) {
    return false;
  }
  const invocation = bindMember.parent;
  return ts.isCallExpression(invocation) &&
    invocation.expression === bindMember &&
    invocation.arguments.length === 1 &&
    isExactObjectPrototypeHasOwnProperty(invocation.arguments[0]);
}

function isExactObjectPrototypeHasOwnProperty(node) {
  const hasOwnProperty = staticMember(node);
  if (!hasOwnProperty || hasOwnProperty.name !== "hasOwnProperty") return false;
  const prototype = staticMember(hasOwnProperty.expression);
  const object = prototype && unwrapStaticExpression(prototype.expression);
  return prototype?.name === "prototype" &&
    ts.isIdentifier(object) &&
    object.text === "Object";
}

function staticMember(node, checker, staticStringAliases) {
  const members = staticMembers(node, checker, staticStringAliases);
  return members.length === 1 ? members[0] : undefined;
}

function staticMembers(node, checker, staticStringAliases) {
  const expression = unwrapStaticExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    return [{ expression: expression.expression, name: expression.name.text }];
  }
  if (ts.isElementAccessExpression(expression)) {
    const names = staticStrings(
      expression.argumentExpression,
      checker,
      staticStringAliases,
    );
    return [...(names ?? [])].map((name) => ({
      expression: expression.expression,
      name,
    }));
  }
  return [];
}

function staticString(node, checker, staticStringAliases) {
  const values = staticStrings(node, checker, staticStringAliases);
  return values?.size === 1 ? values.values().next().value : undefined;
}

function staticStrings(node, checker, staticStringAliases) {
  const expression = unwrapStaticExpression(node);
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return new Set([expression.text]);
  if (ts.isIdentifier(expression) && checker && staticStringAliases) {
    const values = staticStringAliases.get(checker.getSymbolAtLocation(expression));
    return values ? new Set(values) : undefined;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return concatenateStaticStrings(
      staticStrings(expression.left, checker, staticStringAliases),
      staticStrings(expression.right, checker, staticStringAliases),
    );
  }
  if (ts.isTemplateExpression(expression)) {
    let values = new Set([expression.head.text]);
    for (const span of expression.templateSpans) {
      values = concatenateStaticStrings(
        values,
        staticStrings(span.expression, checker, staticStringAliases),
      );
      if (!values) return undefined;
      values = new Set(
        [...values]
          .map((value) => value + span.literal.text)
          .filter((value) => value.length <= MAX_STATIC_STRING_LENGTH),
      );
      if (values.size === 0) return undefined;
    }
    return values;
  }
  return undefined;
}

function concatenateStaticStrings(left, right) {
  if (!left || !right) return undefined;
  const values = new Set();
  for (const leftValue of left) {
    for (const rightValue of right) {
      const value = leftValue + rightValue;
      if (value.length <= MAX_STATIC_STRING_LENGTH) values.add(value);
      if (values.size >= MAX_STATIC_STRING_CANDIDATES) return values;
    }
  }
  return values.size > 0 ? values : undefined;
}

function unwrapStaticExpression(node) {
  let expression = node;
  while (expression) {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      expression = expression.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      expression = expression.right;
      continue;
    }
    if (ts.isCommaListExpression(expression)) {
      expression = expression.elements.at(-1);
      continue;
    }
    return expression;
  }
  return undefined;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPanelHtmlContract(archive, artifactLabel) {
  const path = "dist/panel.html";
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  let document;
  try {
    document = parseStaticHtmlElements(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${artifactLabel} ${path} has invalid static HTML: ${error.message}`,
    );
  }
  const cssPath = "dist/panel.css";
  const cssBytes = archive.files.get(cssPath);
  if (!Buffer.isBuffer(cssBytes)) {
    throw new Error(`${artifactLabel} is missing ${cssPath}`);
  }
  let styleCascade;
  try {
    styleCascade = parsePanelStyleCascade(
      document,
      cssBytes.toString("utf8"),
    );
  } catch (error) {
    throw new Error(
      `${artifactLabel} panel styles have invalid static CSS: ${error.message}`,
    );
  }
  const { elements } = document;
  const visibilityContext = { styleCascade };

  const toolbars = elements.filter((element) =>
    hasClassToken(element, "panel-toolbar")
  );
  if (toolbars.length !== 1) {
    throw new Error(
      `${artifactLabel} toolbar class="panel-toolbar" must appear exactly one time ` +
        `by class token in ${path}; ` +
        `found ${toolbars.length}`,
    );
  }
  const toolbar = toolbars[0];
  const featureGroup = requireSingleClassElement(
    elements,
    "toolbar-features",
    artifactLabel,
    path,
  );
  const connectionGroup = requireSingleClassElement(
    elements,
    "connection-summary",
    artifactLabel,
    path,
  );
  for (const [group, className] of [
    [featureGroup, "toolbar-features"],
    [connectionGroup, "connection-summary"],
  ]) {
    if (!isDescendantOf(group, toolbar)) {
      throw new Error(
        `${artifactLabel} toolbar group .${className} must be inside the toolbar in ${path}`,
      );
    }
  }

  for (const specification of [
    {
      id: "inspect-mode",
      label: "picker asset",
      tagName: "button",
      attributes: { "aria-label": "Select an element" },
    },
    {
      id: "auto-refresh-enabled",
      label: "Auto Refresh control",
      tagName: "input",
      attributes: { type: "checkbox" },
    },
    {
      id: "ide-highlight-enabled",
      label: "IDE Highlight control",
      tagName: "input",
      attributes: { type: "checkbox" },
    },
  ]) {
    requireControl(
      elements,
      specification,
      featureGroup,
      "toolbar-features",
      visibilityContext,
      artifactLabel,
      path,
    );
  }

  const connectionControls = new Map();
  for (const specification of [
    {
      id: "connection-status",
      tagName: "output",
      visible: true,
    },
    { id: "linked-code", tagName: "output", visible: false },
    { id: "link-controls", tagName: "section", visible: true },
    {
      id: "link-code",
      tagName: "input",
      visible: true,
      attributes: { "aria-label": "VS Code window code" },
    },
    { id: "paste-button", tagName: "button", visible: true },
    { id: "link-button", tagName: "button", visible: true },
    { id: "disconnect-button", tagName: "button", visible: false },
  ]) {
    const control = requireControl(
      elements,
      { label: "connection controls", ...specification },
      connectionGroup,
      "connection-summary",
      visibilityContext,
      artifactLabel,
      path,
    );
    connectionControls.set(specification.id, control);
  }

  const linkControls = connectionControls.get("link-controls");
  for (const id of ["link-code", "paste-button", "link-button"]) {
    if (!isDescendantOf(connectionControls.get(id), linkControls)) {
      throw new Error(
        `${artifactLabel} connection controls id="${id}" must be inside ` +
          `id="link-controls" in ${path}`,
      );
    }
  }
}

function requireSingleClassElement(
  elements,
  className,
  artifactLabel,
  path,
) {
  const matches = elements.filter((element) =>
    hasClassToken(element, className)
  );
  if (matches.length !== 1) {
    throw new Error(
      `${artifactLabel} toolbar must contain exactly one .${className} in ${path}; ` +
        `found ${matches.length}`,
    );
  }
  return matches[0];
}

function requireControl(
  elements,
  specification,
  container,
  containerClass,
  visibilityContext,
  artifactLabel,
  path,
) {
  const matches = elements.filter(
    (element) => element.attributes.get("id") === specification.id,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${artifactLabel} ${specification.label} must contain exactly one ` +
        `id="${specification.id}" in ${path}; found ${matches.length}`,
    );
  }
  const control = matches[0];
  if (control.tagName !== specification.tagName) {
    throw new Error(
      `${artifactLabel} ${specification.label} id="${specification.id}" must be ` +
        `a <${specification.tagName}> in ${path}`,
    );
  }
  if (!isDescendantOf(control, container)) {
    throw new Error(
      `${artifactLabel} ${specification.label} id="${specification.id}" must be ` +
        `inside .${containerClass} in the toolbar in ${path}`,
    );
  }
  for (const [name, expected] of Object.entries(
    specification.attributes ?? {},
  )) {
    if (control.attributes.get(name) !== expected) {
      throw new Error(
        `${artifactLabel} ${specification.label} id="${specification.id}" must have ` +
          `${name}="${expected}" in ${path}`,
      );
    }
  }
  if (
    specification.visible !== false &&
    isStaticallyHidden(control, visibilityContext)
  ) {
    throw new Error(
      `${artifactLabel} ${specification.label} id="${specification.id}" must be ` +
        `visible in ${path}`,
    );
  }
  return control;
}

function hasClassToken(element, className) {
  return (element.attributes.get("class") ?? "")
    .split(/\s+/)
    .includes(className);
}

function isDescendantOf(element, ancestor) {
  for (let current = element?.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function isStaticallyHidden(element, { styleCascade }) {
  for (
    let current = element;
    current?.tagName !== "#document";
    current = current.parent
  ) {
    if (current.attributes.has("hidden")) return true;
    if (current.attributes.get("aria-hidden")?.trim().toLowerCase() === "true") {
      return true;
    }
  }
  return styleCascadeHides(element, styleCascade);
}

function styleCascadeHides(element, cascade) {
  return cascade.variants.some((variant) =>
    styleCascadeVariantHides(element, variant)
  );
}

function styleCascadeVariantHides(element, cascade) {
  const visibility = resolveComputedProperty(element, "visibility", cascade);
  if (resolvedPropertyHides("visibility", visibility, true)) return true;

  for (
    let current = element;
    current?.tagName !== "#document";
    current = current.parent
  ) {
    for (const property of ["display", "content-visibility"]) {
      const resolution = resolveComputedProperty(current, property, cascade);
      if (resolvedPropertyHides(property, resolution, current === element)) {
        return true;
      }
    }
  }
  return false;
}

function resolvedPropertyHides(property, resolution, isTarget) {
  if (!resolution.resolved) return true;
  const keyword = parseCssKeyword(resolution.value);
  if (keyword === "contents" && property === "display") return isTarget;
  if (HIDDEN_CSS_VALUES.get(property)?.has(keyword)) return true;
  return !isKnownVisiblePropertyValue(property, resolution.value);
}

function isKnownVisiblePropertyValue(property, value) {
  const words = parseCssWords(value);
  if (!words) return false;
  if (property === "visibility") return words.join(" ") === "visible";
  if (property === "content-visibility") {
    return words.length === 1 && ["auto", "visible"].includes(words[0]);
  }
  if (property !== "display") return false;
  if (words.length === 1) return VISIBLE_DISPLAY_VALUES.has(words[0]);
  const outer = new Set(["block", "inline", "run-in"]);
  const inner = new Set(["flow", "flow-root", "table", "flex", "grid", "ruby"]);
  return words.length === 2 && outer.has(words[0]) && inner.has(words[1]);
}

function parseStaticHtmlElements(html) {
  const $ = load(html);
  const document = {
    tagName: "#document",
    attributes: new Map(),
    parent: undefined,
  };
  const nodes = $("*").toArray();
  const wrappers = new Map(
    nodes.map((node) => [
      node,
      {
        tagName: node.tagName.toLowerCase(),
        attributes: new Map(Object.entries(node.attribs ?? {})),
        node,
        parent: undefined,
      },
    ]),
  );
  for (const [node, element] of wrappers) {
    element.parent = wrappers.get(node.parent) ?? document;
  }
  const styleSources = $("link, style").toArray().flatMap((node) => {
    const tagName = node.tagName.toLowerCase();
    const attributes = new Map(Object.entries(node.attribs ?? {}));
    if (tagName === "link") {
      const rel = (attributes.get("rel") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      return rel.includes("stylesheet")
        ? [{ attributes, kind: "link" }]
        : [];
    }
    const type = (attributes.get("type") ?? "text/css").trim().toLowerCase();
    return type === "text/css"
      ? [{ attributes, css: $(node).text(), kind: "style" }]
      : [];
  });
  return {
    elements: [...wrappers.values()],
    styleSources,
    matchesSelector(element, selector) {
      return $(element.node).is(selector);
    },
  };
}

function parsePanelStyleCascade(document, panelCss) {
  const state = {
    contextIds: new WeakMap(),
    contexts: [],
    declarations: [],
    inlineDeclarations: new Map(),
    order: 0,
  };
  let linkedPanelCssCount = 0;
  let inlineStyleIndex = 0;
  for (const source of document.styleSources) {
    if (source.kind === "link") {
      const href = source.attributes.get("href");
      if (!isPackagedPanelStylesheetHref(href)) {
        throw new Error(`unsupported linked stylesheet ${JSON.stringify(href)}`);
      }
      linkedPanelCssCount += 1;
      appendStylesheetDeclarations(panelCss, "dist/panel.css", state);
      continue;
    }
    inlineStyleIndex += 1;
    appendStylesheetDeclarations(
      source.css,
      `dist/panel.html <style ${inlineStyleIndex}>`,
      state,
    );
  }
  if (linkedPanelCssCount !== 1) {
    throw new Error(
      `dist/panel.html must link ./panel.css exactly once; found ${linkedPanelCssCount}`,
    );
  }

  for (const element of document.elements) {
    const style = element.attributes.get("style");
    if (typeof style !== "string") continue;
    const root = postcss.parse(`element { ${style} }`, {
      from: "dist/panel.html style attribute",
    });
    const declarations = [];
    for (const node of root.first?.nodes ?? []) {
      if (node.type !== "decl") continue;
      const property = normalizeCssProperty(node.prop);
      if (!isRelevantCssProperty(property)) continue;
      declarations.push({
        element,
        important: node.important,
        order: state.order,
        property,
        specificity: [1, 0, 0, 0],
        value: node.value,
      });
      state.order += 1;
    }
    state.inlineDeclarations.set(element, declarations);
  }

  return {
    variants: buildStyleCascadeVariants(state, document.matchesSelector),
  };
}

function isPackagedPanelStylesheetHref(href) {
  if (typeof href !== "string") return false;
  try {
    const base = new URL("https://package.invalid/dist/panel.html");
    const resolved = new URL(href, base);
    return resolved.origin === base.origin &&
      resolved.pathname === "/dist/panel.css" &&
      resolved.search === "" &&
      resolved.hash === "";
  } catch {
    return false;
  }
}

function appendStylesheetDeclarations(css, label, state) {
  const root = postcss.parse(css, { from: label });
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === "import") {
      throw new Error(`${label} must not import another stylesheet`);
    }
  });
  root.walkRules((rule) => {
    const declarations = (rule.nodes ?? []).flatMap((node) => {
      if (node.type !== "decl") return [];
      const property = normalizeCssProperty(node.prop);
      return isRelevantCssProperty(property)
        ? [{ node, property }]
        : [];
    });
    if (declarations.length === 0) return;
    const { contextIds, layered } = styleContextForRule(rule, label, state);
    const selectors = parseSelectorEntries(rule.selector, label);
    for (const { node, property } of declarations) {
      const order = state.order;
      state.order += 1;
      for (const selector of selectors) {
        state.declarations.push({
          important: node.important,
          contextIds,
          layered,
          order,
          property,
          selector: selector.text,
          specificity: [0, ...selector.specificity],
          value: node.value,
        });
      }
    }
  });
}

function styleContextForRule(rule, label, state) {
  const atRules = [];
  for (let current = rule.parent; current?.type !== "root"; current = current?.parent) {
    if (current?.type === "atrule") atRules.unshift(current);
  }

  const ids = [];
  let layered = false;
  let parentId;
  for (const atRule of atRules) {
    const name = decodeCssIdentifier(atRule.name);
    if (!STYLE_CONTEXT_AT_RULES.has(name)) {
      throw new Error(
        `${label} uses unsupported @${atRule.name} context for static visibility`,
      );
    }
    if (name === "layer") layered = true;
    let id = state.contextIds.get(atRule);
    if (id === undefined) {
      if (state.contexts.length >= MAX_STYLE_CONTEXTS) {
        throw new Error(
          `${label} exceeds ${MAX_STYLE_CONTEXTS} static style contexts`,
        );
      }
      id = state.contexts.length;
      state.contextIds.set(atRule, id);
      state.contexts.push({ id, parentId });
    }
    ids.push(id);
    parentId = id;
  }
  return { contextIds: ids, layered };
}

function buildStyleCascadeVariants(state, matchesSelector) {
  const activations = enumerateStyleContextActivations(state.contexts);
  return activations.map((activeContexts) => ({
    declarations: state.declarations.filter((declaration) =>
      declaration.contextIds.every((id) => activeContexts.has(id))
    ),
    inlineDeclarations: state.inlineDeclarations,
    matchesSelector,
    winnerCache: new WeakMap(),
  }));
}

function enumerateStyleContextActivations(contexts) {
  // Each context may be active independently, but a nested context requires its parent.
  const activations = [];
  const active = new Set();

  function visit(index) {
    if (index === contexts.length) {
      activations.push(new Set(active));
      return;
    }

    const context = contexts[index];
    visit(index + 1);
    if (context.parentId === undefined || active.has(context.parentId)) {
      active.add(context.id);
      visit(index + 1);
      active.delete(context.id);
    }
  }

  visit(0);
  return activations;
}

function normalizeCssProperty(property) {
  const decoded = decodeCssIdentifier(property, false);
  if (decoded?.startsWith("--")) return decoded;
  return decoded?.toLowerCase();
}

function isRelevantCssProperty(property) {
  return typeof property === "string" &&
    (property.startsWith("--") || VISIBILITY_PROPERTIES.has(property));
}

function parseSelectorEntries(selector, label) {
  let root;
  try {
    root = selectorParser().astSync(selector);
  } catch (error) {
    throw new Error(`${label} has invalid selector ${JSON.stringify(selector)}: ${error.message}`);
  }
  return root.nodes.map((node) => ({
    specificity: selectorSpecificity(node),
    text: node.toString().trim(),
  }));
}

function selectorSpecificity(node) {
  const specificity = [0, 0, 0];
  for (const child of node.nodes ?? []) {
    const contribution = selectorNodeSpecificity(child);
    for (let index = 0; index < specificity.length; index += 1) {
      specificity[index] += contribution[index];
    }
  }
  return specificity;
}

function selectorNodeSpecificity(node) {
  if (node.type === "id") return [1, 0, 0];
  if (node.type === "class" || node.type === "attribute") return [0, 1, 0];
  if (node.type === "tag") return [0, 0, 1];
  if (node.type !== "pseudo") return [0, 0, 0];
  if (node.value.startsWith("::")) return [0, 0, 1];

  const name = decodeCssIdentifier(node.value.slice(1)) ?? "";
  if (name === "where") return [0, 0, 0];
  if (["is", "not", "has"].includes(name)) {
    return maximumSpecificity((node.nodes ?? []).map(selectorSpecificity));
  }
  if (["nth-child", "nth-last-child"].includes(name)) {
    const nested = maximumSpecificity((node.nodes ?? []).map(selectorSpecificity));
    return [nested[0], nested[1] + 1, nested[2]];
  }
  return [0, 1, 0];
}

function maximumSpecificity(values) {
  return values.reduce(
    (maximum, value) => compareSpecificity(value, maximum) > 0 ? value : maximum,
    [0, 0, 0],
  );
}

function compareSpecificity(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function winningDeclaration(element, property, cascade) {
  let elementCache = cascade.winnerCache.get(element);
  if (!elementCache) {
    elementCache = new Map();
    cascade.winnerCache.set(element, elementCache);
  }
  if (elementCache.has(property)) return elementCache.get(property);

  let winner;
  for (const declaration of cascade.declarations) {
    if (declaration.property !== property) continue;
    let matches;
    try {
      matches = cascade.matchesSelector(element, declaration.selector);
    } catch (error) {
      throw new Error(
        `unsupported static selector ${JSON.stringify(declaration.selector)}: ${error.message}`,
      );
    }
    if (matches && declarationWins(declaration, winner)) winner = declaration;
  }
  for (const declaration of cascade.inlineDeclarations.get(element) ?? []) {
    if (declaration.property === property && declarationWins(declaration, winner)) {
      winner = declaration;
    }
  }
  elementCache.set(property, winner);
  return winner;
}

function declarationWins(candidate, current) {
  if (!current) return true;
  if (candidate.important !== current.important) return candidate.important;
  const candidateLayered = Boolean(candidate.layered);
  const currentLayered = Boolean(current.layered);
  if (candidateLayered !== currentLayered) {
    return candidate.important ? candidateLayered : !candidateLayered;
  }
  const specificity = compareSpecificity(candidate.specificity, current.specificity);
  if (specificity !== 0) return specificity > 0;
  return candidate.order > current.order;
}

function resolveComputedProperty(element, property, cascade, trail = []) {
  if (!element || element.tagName === "#document") {
    return { resolved: true, value: INITIAL_CSS_VALUES.get(property) };
  }
  if (trail.some((entry) => entry.element === element && entry.property === property)) {
    return { resolved: false };
  }
  const nextTrail = [...trail, { element, property }];
  const declaration = winningDeclaration(element, property, cascade);
  if (!declaration) {
    if (property === "visibility") {
      return resolveComputedProperty(element.parent, property, cascade, nextTrail);
    }
    return { resolved: true, value: INITIAL_CSS_VALUES.get(property) };
  }

  const resolution = resolveCssValue(declaration.value, element, cascade, {
    customTrail: [],
    depth: 0,
  });
  if (!resolution.resolved) return resolution;
  const keyword = parseCssKeyword(resolution.value);
  if (!CSS_WIDE_KEYWORDS.has(keyword)) return resolution;
  if (keyword === "initial") {
    return { resolved: true, value: INITIAL_CSS_VALUES.get(property) };
  }
  if (keyword === "inherit" || (keyword === "unset" && property === "visibility")) {
    return resolveComputedProperty(element.parent, property, cascade, nextTrail);
  }
  if (keyword === "unset") {
    return { resolved: true, value: INITIAL_CSS_VALUES.get(property) };
  }
  return { resolved: false };
}

function resolveCssValue(value, element, cascade, state) {
  if (state.depth > MAX_CUSTOM_PROPERTY_DEPTH) return { resolved: false };
  const parsed = valueParser(value);
  return resolveValueNodes(parsed.nodes, element, cascade, state);
}

function resolveValueNodes(nodes, element, cascade, state) {
  let value = "";
  for (const node of nodes) {
    let fragment;
    if (node.type === "function") {
      const functionName = decodeCssIdentifier(node.value) ?? "";
      if (functionName === "var") {
        const resolution = resolveVarFunction(node, element, cascade, state);
        if (!resolution.resolved) return resolution;
        fragment = resolution.value;
      } else {
        const inner = resolveValueNodes(node.nodes, element, cascade, {
          ...state,
          depth: state.depth + 1,
        });
        if (!inner.resolved) return inner;
        fragment = `${node.value}(${node.before ?? ""}${inner.value}${node.after ?? ""})`;
      }
    } else {
      fragment = valueParser.stringify(node);
    }
    value += fragment;
    if (value.length > MAX_RESOLVED_CSS_VALUE_LENGTH) return { resolved: false };
  }
  return { resolved: true, value };
}

function resolveVarFunction(node, element, cascade, state) {
  const comma = node.nodes.findIndex(
    (child) => child.type === "div" && child.value === ",",
  );
  const nameNodes = comma < 0 ? node.nodes : node.nodes.slice(0, comma);
  const significant = nameNodes.filter(
    (child) => child.type !== "space" && child.type !== "comment",
  );
  const name = significant.length === 1 && significant[0].type === "word"
    ? decodeCssIdentifier(significant[0].value, false)
    : undefined;
  if (!name?.startsWith("--")) return { resolved: false };

  const custom = resolveCustomProperty(element, name, cascade, {
    customTrail: state.customTrail,
    depth: state.depth + 1,
  });
  if (custom.resolved) return custom;
  if (comma < 0) return { resolved: false };
  return resolveValueNodes(node.nodes.slice(comma + 1), element, cascade, {
    ...state,
    depth: state.depth + 1,
  });
}

function resolveCustomProperty(element, name, cascade, state) {
  if (
    !element ||
    element.tagName === "#document" ||
    state.depth > MAX_CUSTOM_PROPERTY_DEPTH
  ) {
    return { resolved: false };
  }
  if (
    state.customTrail.some(
      (entry) => entry.element === element && entry.name === name,
    )
  ) {
    return { resolved: false };
  }
  const declaration = winningDeclaration(element, name, cascade);
  if (!declaration) {
    return resolveCustomProperty(element.parent, name, cascade, state);
  }

  const keyword = parseCssKeyword(declaration.value);
  if (keyword === "inherit" || keyword === "unset") {
    return resolveCustomProperty(element.parent, name, cascade, state);
  }
  if (["initial", "revert", "revert-layer"].includes(keyword)) {
    return { resolved: false };
  }
  return resolveCssValue(declaration.value, element, cascade, {
    customTrail: [...state.customTrail, { element, name }],
    depth: state.depth + 1,
  });
}

function parseCssKeyword(value) {
  const words = parseCssWords(value);
  return words?.length === 1 ? words[0] : undefined;
}

function parseCssWords(value) {
  const nodes = valueParser(value).nodes.filter(
    (node) => node.type !== "space" && node.type !== "comment",
  );
  if (nodes.some((node) => node.type !== "word")) return undefined;
  const words = nodes.map((node) => decodeCssIdentifier(node.value));
  return words.some((word) => word === undefined) ? undefined : words;
}

function decodeCssIdentifier(identifier, lowercase = true) {
  const input = identifier.trim();
  if (/\s/.test(input)) return undefined;
  const decoded = decodeCssEscapedText(input);
  if (decoded === undefined) return undefined;
  return lowercase ? decoded.toLowerCase() : decoded;
}

function decodeCssEscapedText(input) {
  let decoded = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const next = input[index + 1];
    if (next === undefined) return undefined;
    if (next === "\n" || next === "\f") {
      index += 1;
      continue;
    }
    if (next === "\r") {
      index += input[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (!/[0-9a-f]/i.test(next)) {
      decoded += next;
      index += 1;
      continue;
    }

    let hexadecimal = "";
    let cursor = index + 1;
    while (cursor < input.length && hexadecimal.length < 6) {
      if (!/[0-9a-f]/i.test(input[cursor])) break;
      hexadecimal += input[cursor];
      cursor += 1;
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    decoded += String.fromCodePoint(
      codePoint === 0 || codePoint > 0x10ffff ? 0xfffd : codePoint,
    );
    if (/\s/.test(input[cursor] ?? "")) cursor += 1;
    index = cursor - 1;
  }
  return decoded;
}

function assertTextMarkers(archive, artifactLabel, path, markers) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  const text = bytes.toString("utf8");
  for (const [label, marker] of markers) {
    if (!text.includes(marker)) {
      throw new Error(
        `${artifactLabel} ${label} is missing ${marker} in ${path}`,
      );
    }
  }
}
