import { parseRuntimeMetadata } from "./runtime-metadata.mjs";

const PANEL_HTML_MARKERS = Object.freeze([
  ["toolbar", 'class="panel-toolbar"'],
  ["Auto Refresh control", 'id="auto-refresh-enabled"'],
  ["Auto Refresh control", "Auto Refresh"],
  ["IDE Highlight control", 'id="ide-highlight-enabled"'],
  ["IDE Highlight control", "IDE Highlight"],
  ["DOM tree asset", 'id="dom-tree"'],
  ["DOM tree asset", 'id="dom-tree-spacer"'],
  ["DOM tree asset", 'id="dom-tree-empty"'],
  ["DOM tree asset", 'role="tree"'],
  ["linked code asset", 'id="linked-code"'],
  ["connection controls", 'id="connection-status"'],
  ["connection controls", 'id="link-controls"'],
  ["connection controls", 'id="link-code"'],
  ["connection controls", 'aria-label="VS Code window code"'],
  ["connection controls", 'id="paste-button"'],
  ["connection controls", 'id="link-button"'],
  ["connection controls", 'id="disconnect-button"'],
  ["connection controls", "Disconnect"],
  ["picker asset", 'id="inspect-mode"'],
  ["picker asset", 'aria-label="Select an element"'],
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
  assertSingleMarker(
    archive,
    artifactLabel,
    "dist/panel.html",
    "toolbar",
    'class="panel-toolbar"',
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
    expectedProtocolVersion: 6,
    label: metadataLabel,
  });
}

function assertSingleMarker(
  archive,
  artifactLabel,
  path,
  label,
  marker,
) {
  const bytes = archive.files.get(path);
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${artifactLabel} is missing ${path}`);
  }
  const count = bytes.toString("utf8").split(marker).length - 1;
  if (count !== 1) {
    throw new Error(
      `${artifactLabel} ${label} must appear exactly one time in ${path}; found ${count}`,
    );
  }
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
