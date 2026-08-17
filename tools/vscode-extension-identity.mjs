const EXPECTED_FIELDS = Object.freeze({
  publisher: "conus-vision",
  name: "pin-op",
  displayName: "Pin-op",
  description:
    "Highlights styles and source code in your IDE for the DOM element selected in the browser.",
  repository: "https://github.com/conus-vision/pin-op",
  bugs: "https://github.com/conus-vision/pin-op/issues",
  homepage: "https://pin-op.conus.vision",
  icon: "resources/pin-op.png",
});

const EXPECTED_COMMAND_TITLES = new Map([
  ["pin-op.start", "Pin-op: Start"],
  ["pin-op.stop", "Pin-op: Stop"],
  ["pin-op.copyLinkCode", "Pin-op: Copy Link Code"],
  ["pin-op.openDiagnostics", "Pin-op: Open Diagnostics"],
  ["pin-op.revealSourceMatch", "Pin-op: Reveal Source Match"],
]);

const EXPECTED_COLOR_IDS = Object.freeze([
  "pinOp.selectedRuleBackground",
  "pinOp.selectedRuleBorder",
  "pinOp.parentRuleBackground",
  "pinOp.parentRuleBorder",
]);
const EXPECTED_COLOR_ID_SET = new Set(EXPECTED_COLOR_IDS);
const COLOR_ID_PATTERN = /^[A-Za-z0-9.]+$/;

export function assertVsCodeExtensionIdentity(manifest, label) {
  for (const [field, expected] of Object.entries(EXPECTED_FIELDS)) {
    if (manifest?.[field] !== expected) {
      const fieldLabel = field === "displayName"
        ? "display name"
        : field === "bugs"
          ? "bugs URL"
          : field;
      throw new Error(`${label} has unexpected extension ${fieldLabel}`);
    }
  }

  const activitybar = manifest.contributes?.viewsContainers?.activitybar;
  const activityContainer = Array.isArray(activitybar)
    ? activitybar.find((container) => container?.id === "pin-op")
    : undefined;
  if (activityContainer?.title !== "Pin-op") {
    throw new Error(`${label} activitybar container pin-op has unexpected title`);
  }
  if (activityContainer.icon !== "resources/pin-op.svg") {
    throw new Error(`${label} activitybar container pin-op has unexpected icon`);
  }

  const commands = manifest.contributes?.commands;
  if (!Array.isArray(commands) || commands.length !== EXPECTED_COMMAND_TITLES.size) {
    throw new Error(`${label} has unexpected extension commands`);
  }
  for (const [commandId, expectedTitle] of EXPECTED_COMMAND_TITLES) {
    const command = commands.find((candidate) => candidate?.command === commandId);
    if (command?.title !== expectedTitle) {
      throw new Error(`${label} command ${commandId} has unexpected title`);
    }
  }

  const colors = manifest.contributes?.colors;
  if (!Array.isArray(colors)) {
    throw new Error(`${label} has unexpected extension color IDs`);
  }
  const colorIds = colors.map((color) => color?.id);
  const uniqueColorIds = new Set();
  for (const colorId of colorIds) {
    if (
      typeof colorId !== "string" ||
      colorId.startsWith(".") ||
      !COLOR_ID_PATTERN.test(colorId)
    ) {
      throw new Error(`${label} has invalid color ID ${String(colorId)}`);
    }
    if (uniqueColorIds.has(colorId)) {
      throw new Error(`${label} has duplicate color ID ${colorId}`);
    }
    uniqueColorIds.add(colorId);
    if (!EXPECTED_COLOR_ID_SET.has(colorId)) {
      throw new Error(`${label} has unexpected color ID ${colorId}`);
    }
  }
  for (const expectedColorId of EXPECTED_COLOR_IDS) {
    if (!uniqueColorIds.has(expectedColorId)) {
      throw new Error(`${label} is missing color ID ${expectedColorId}`);
    }
  }

  if (manifest.contributes?.configuration?.title !== "Pin-op") {
    throw new Error(`${label} has unexpected configuration title`);
  }
}
