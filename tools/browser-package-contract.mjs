import { load } from "cheerio";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
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

export function assertBrowserPackageRuntimeContract(
  archive,
  { artifactLabel, metadataLabel },
) {
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
    "dist/panel.js",
    PANEL_BUNDLE_MARKERS,
  );
  parseRuntimeMetadata(archive.files.get("dist/runtime-metadata.json"), {
    expectedProtocolVersion: 6,
    label: metadataLabel,
  });
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
  let decoded = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (/\s/.test(character)) return undefined;
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const next = input[index + 1];
    if (next === undefined || next === "\n" || next === "\r" || next === "\f") {
      return undefined;
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
  return lowercase ? decoded.toLowerCase() : decoded;
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
