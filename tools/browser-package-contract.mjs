import { parseRuntimeMetadata } from "./runtime-metadata.mjs";

const PANEL_HTML_MARKERS = Object.freeze([
  ["DOM tree asset", 'id="dom-tree"'],
  ["DOM tree asset", 'id="dom-tree-spacer"'],
  ["DOM tree asset", 'id="dom-tree-empty"'],
  ["DOM tree asset", 'role="tree"'],
  ["linked code asset", 'id="linked-code"'],
  ["panel asset", 'id="disconnect-button"'],
  ["panel asset", "Disconnect"],
  ["picker asset", 'id="inspect-mode"'],
  ["picker asset", 'aria-label="Select an element"'],
  ["resolution footer", 'class="panel-footer"'],
  ["resolution footer", 'id="resolution-status"'],
  ["source navigation footer", "source-navigation-footer"],
]);
const PANEL_CSS_MARKERS = Object.freeze([
  ["DOM tree style", ".dom-tree-row"],
  ["DOM tree style", ".is-shadow-root"],
  ["DOM tree style", ".is-frame-document"],
  ["DOM tree style", ".is-inaccessible"],
  ["resolution footer style", ".panel-footer"],
  ["resolution footer style", '.resolution-status[data-tone="success"]'],
  ["resolution footer style", '.resolution-status[data-tone="warning"]'],
  ["resolution footer style", '.resolution-status[data-tone="error"]'],
  ["source navigation controls", ".source-navigation-controls"],
]);
const PANEL_BUNDLE_MARKERS = Object.freeze([
  ["source navigation state", "source.navigationState"],
  ["locator recovery", "dom.resolveLocator"],
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
    expectedProtocolVersion: 5,
    label: metadataLabel,
  });
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
