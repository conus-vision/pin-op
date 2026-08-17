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
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
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
  let elements;
  try {
    elements = parseStaticHtmlElements(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${artifactLabel} ${path} has invalid static HTML: ${error.message}`,
    );
  }

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
  if (specification.visible !== false && isStaticallyHidden(control)) {
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

function isStaticallyHidden(element) {
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
  }
  return false;
}

function inlineStyleHides(style) {
  if (typeof style !== "string") return false;
  const declarations = style.replace(/\/\*[\s\S]*?\*\//g, "").split(";");
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .replace(/\s*!important\s*$/i, "")
      .trim()
      .toLowerCase();
    if (property === "display" && value === "none") return true;
    if (property === "visibility" && value === "hidden") return true;
  }
  return false;
}

function parseStaticHtmlElements(html) {
  const document = {
    tagName: "#document",
    attributes: new Map(),
    parent: undefined,
  };
  const elements = [];
  const stack = [document];
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const commentEnd = html.indexOf("-->", start + 4);
      if (commentEnd < 0) throw new Error("unterminated comment");
      cursor = commentEnd + 3;
      continue;
    }
    const end = findTagEnd(html, start + 1);
    if (end < 0) throw new Error("unterminated tag");
    const body = html.slice(start + 1, end).trim();
    cursor = end + 1;
    if (body === "" || body.startsWith("!") || body.startsWith("?")) {
      continue;
    }
    if (body.startsWith("/")) {
      const match = /^\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*$/.exec(body);
      if (!match) throw new Error(`malformed closing tag <${body}>`);
      const tagName = match[1].toLowerCase();
      const current = stack.at(-1);
      if (current.tagName !== tagName) {
        throw new Error(
          `closing tag </${tagName}> does not match <${current.tagName}>`,
        );
      }
      stack.pop();
      continue;
    }

    const parsed = parseOpeningTag(body);
    if (!parsed) continue;
    const element = {
      tagName: parsed.tagName,
      attributes: parsed.attributes,
      parent: stack.at(-1),
    };
    elements.push(element);
    if (!parsed.selfClosing && !VOID_ELEMENTS.has(parsed.tagName)) {
      stack.push(element);
    }
  }

  if (stack.length !== 1) {
    throw new Error(`unclosed <${stack.at(-1).tagName}> tag`);
  }
  return elements;
}

function findTagEnd(html, start) {
  let quote;
  for (let cursor = start; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor;
    }
  }
  return -1;
}

function parseOpeningTag(body) {
  const tagMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(body);
  if (!tagMatch) return undefined;
  const tagName = tagMatch[0].toLowerCase();
  const attributes = new Map();
  let cursor = tagMatch[0].length;
  let selfClosing = false;

  while (cursor < body.length) {
    while (/\s/.test(body[cursor])) cursor += 1;
    if (cursor >= body.length) break;
    if (body[cursor] === "/" && body.slice(cursor + 1).trim() === "") {
      selfClosing = true;
      break;
    }

    const nameStart = cursor;
    while (
      cursor < body.length &&
      !/[\s"'=<>`/]/.test(body[cursor])
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      throw new Error(`malformed attribute in <${tagName}>`);
    }
    const name = body.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(body[cursor])) cursor += 1;
    let value = "";
    if (body[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(body[cursor])) cursor += 1;
      const quote = body[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        const valueEnd = body.indexOf(quote, cursor);
        if (valueEnd < 0) {
          throw new Error(`unterminated ${name} attribute in <${tagName}>`);
        }
        value = body.slice(valueStart, valueEnd);
        cursor = valueEnd + 1;
      } else {
        const valueStart = cursor;
        while (cursor < body.length && !/\s/.test(body[cursor])) cursor += 1;
        value = body.slice(valueStart, cursor);
      }
    }
    if (attributes.has(name)) {
      throw new Error(`duplicate ${name} attribute in <${tagName}>`);
    }
    attributes.set(name, value);
  }
  return { attributes, selfClosing, tagName };
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
