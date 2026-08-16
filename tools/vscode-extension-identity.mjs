const EXPECTED_FIELDS = Object.freeze({
  publisher: "conus-vision",
  name: "pin-op",
  displayName: "Pin-op",
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

  if (manifest.contributes?.configuration?.title !== "Pin-op") {
    throw new Error(`${label} has unexpected configuration title`);
  }
}
