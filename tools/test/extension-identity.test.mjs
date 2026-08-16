import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const iconSizes = [16, 32, 48, 96, 128];
const legacyAssetStem = ["pin", "op"].join("");

test("VS Code manifest declares the complete Pin-op identity", () => {
  const manifest = readJson("extensions/vscode/package.json");

  assert.equal(manifest.name, "pin-op");
  assert.equal(manifest.displayName, "Pin-op");
  assert.equal(manifest.publisher, "conus-vision");
  assert.equal(`${manifest.publisher}.${manifest.name}`, "conus-vision.pin-op");
  assert.equal(manifest.repository, "https://github.com/conus-vision/pin-op");
  assert.equal(manifest.bugs, "https://github.com/conus-vision/pin-op/issues");
  assert.equal(manifest.homepage, "https://pin-op.conus.vision");
  assert.equal(manifest.icon, "resources/pin-op.png");
  assert.ok(manifest.contributes);
  const activitybar = manifest.contributes.viewsContainers?.activitybar;
  assert.ok(Array.isArray(activitybar));
  assert.ok(activitybar.length > 0);
  const activityContainer = activitybar.find(({ id }) => id === "pin-op");
  assert.ok(activityContainer, "pin-op activitybar container should exist");
  assert.equal(activityContainer.icon, "resources/pin-op.svg");
  assert.equal(activityContainer.title, "Pin-op");
  assert.equal(manifest.contributes.configuration.title, "Pin-op");
  const commands = manifest.contributes.commands;
  assert.ok(Array.isArray(commands));
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.match(command.command, /^pin-op\./);
    assert.match(command.title, /^Pin-op:/);
  }
  const configurationProperties =
    manifest.contributes.configuration.properties;
  assert.ok(configurationProperties);
  const configurationKeys = Object.keys(configurationProperties);
  assert.ok(configurationKeys.length > 0);
  for (const key of configurationKeys) {
    assert.match(key, /^pin-op\./);
  }
  const views = manifest.contributes.views;
  assert.ok(views);
  const viewIds = Object.keys(views);
  assert.ok(viewIds.length > 0);
  for (const id of viewIds) {
    assert.match(id, /^pin-op(?:\.|$)/);
  }
  const colors = manifest.contributes.colors;
  assert.ok(Array.isArray(colors));
  assert.ok(colors.length > 0);
  for (const color of colors) {
    assert.match(color.id, /^pin-op\./);
  }
});

test("source plugin fixture presents the Pin-op identity", () => {
  const manifest = readJson("extensions/source-plugin-fixture/package.json");

  assert.equal(manifest.displayName, "Pin-op Source Plugin Fixture");
});

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} manifest presents Pin-op and renamed icons`, () => {
    const manifest = readJson(`extensions/${browser}/manifest.json`);

    assert.equal(manifest.name, "Pin-op");
    assert.deepEqual(
      manifest.icons,
      Object.fromEntries(
        iconSizes.map((size) => [size, `dist/icons/pin-op-${size}.png`]),
      ),
    );
    if (browser === "firefox") {
      assert.equal(
        manifest.browser_specific_settings.gecko.id,
        "info@conus.vision",
      );
    }
  });
}

test("browser extension HTML presents Pin-op and the renamed vector asset", () => {
  const panel = readText("packages/browser-extension-core/assets/panel.html");
  assert.match(panel, /<title>Pin-op<\/title>/);
  assert.match(panel, /src="\.\/pin-op\.svg"/);
  assert.match(panel, /<h1>Pin-op<\/h1>/);

  for (const browser of ["chrome", "firefox"]) {
    assert.match(
      readText(`extensions/${browser}/src/devtools.html`),
      /<title>Pin-op DevTools<\/title>/,
    );
  }
});

test("tracked extension assets use only the pin-op filenames", () => {
  for (const relativePath of [
    "extensions/vscode/resources/pin-op.png",
    "extensions/vscode/resources/pin-op.svg",
    "packages/browser-extension-core/assets/pin-op.svg",
    ...iconSizes.map(
      (size) => `packages/browser-extension-core/assets/icons/pin-op-${size}.png`,
    ),
  ]) {
    assert.equal(exists(relativePath), true, `${relativePath} should exist`);
  }

  for (const relativePath of [
    `extensions/vscode/resources/${legacyAssetStem}.png`,
    `extensions/vscode/resources/${legacyAssetStem}.svg`,
    `packages/browser-extension-core/assets/${legacyAssetStem}.svg`,
    ...iconSizes.map(
      (size) =>
        `packages/browser-extension-core/assets/icons/${legacyAssetStem}-${size}.png`,
    ),
  ]) {
    assert.equal(exists(relativePath), false, `${relativePath} should be absent`);
  }
});

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return existsSync(resolve(repositoryRoot, relativePath));
}
