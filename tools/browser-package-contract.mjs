import { load } from "cheerio";
import postcss from "postcss";
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
const HIDDEN_CSS_VALUES = new Map([
  ["display", "none"],
  ["visibility", "hidden"],
  ["content-visibility", "hidden"],
]);

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
  let hidingRules;
  try {
    hidingRules = parseStylesheetHidingRules(cssBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${artifactLabel} ${cssPath} has invalid static CSS: ${error.message}`,
    );
  }
  const { elements, matchesSelector } = document;
  const visibilityContext = { hidingRules, matchesSelector };

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

function isStaticallyHidden(element, { hidingRules, matchesSelector }) {
  for (
    let current = element;
    current?.tagName !== "#document";
    current = current.parent
  ) {
    if (current.attributes.has("hidden")) return true;
    if (current.attributes.get("aria-hidden")?.trim().toLowerCase() === "true") {
      return true;
    }
    if (inlineStyleHides(current.attributes.get("style"))) return true;
    if (
      hidingRules.some((rule) => matchesSelector(current, rule.selector))
    ) {
      return true;
    }
  }
  return false;
}

function inlineStyleHides(style) {
  if (typeof style !== "string") return false;
  try {
    const root = postcss.parse(`element { ${style} }`);
    return root.first?.nodes?.some(declarationHides) ?? false;
  } catch {
    return false;
  }
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
  return {
    elements: [...wrappers.values()],
    matchesSelector(element, selector) {
      return $(element.node).is(selector);
    },
  };
}

function parseStylesheetHidingRules(css) {
  const rules = [];
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.nodes?.some(declarationHides)) {
      rules.push({ selector: rule.selector });
    }
  });
  return rules;
}

function declarationHides(node) {
  if (node.type !== "decl") return false;
  const property = decodeCssIdentifier(node.prop);
  const value = decodeCssIdentifier(node.value);
  const hiddenValue = HIDDEN_CSS_VALUES.get(property);
  return hiddenValue !== undefined && hiddenValue === value;
}

function decodeCssIdentifier(identifier) {
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
  return decoded.toLowerCase();
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
