import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productDescription =
  "Highlights styles and source code in your IDE for the selected DOM element. Pin-op by Volodymyr Moskvin. (c) 2026 Conus Vision.";
const expectedNames = new Map([
  ["package.json", "@pin-op/workspace"],
  ["packages/protocol/package.json", "@pin-op/protocol"],
  ["packages/bridge/package.json", "@pin-op/bridge"],
  ["packages/browser-extension-core/package.json", "@pin-op/browser-extension-core"],
  ["packages/plugin-api/package.json", "@pin-op/plugin-api"],
  ["extensions/vscode/package.json", "pin-op"],
  ["extensions/chrome/package.json", "pin-op-chrome"],
  ["extensions/firefox/package.json", "pin-op-firefox"],
  ["extensions/source-plugin-fixture/package.json", "pin-op-source-plugin-fixture"],
  ["tools/simulator/package.json", "@pin-op/simulator"],
]);

test("workspace manifests use the canonical pin-op technical identities", async () => {
  for (const [path, expectedName] of expectedNames) {
    const manifest = await readManifest(path);
    assert.equal(manifest.name, expectedName, path);
  }
});

test("public package metadata uses canonical pin-op URLs and IDs", async () => {
  assert.ok(productDescription.length <= 132);

  const root = await readManifest("package.json");
  assert.equal(root.description, productDescription);
  assert.equal(root.repository?.url, "https://github.com/conus-vision/pin-op.git");
  assert.equal(root.bugs, "https://github.com/conus-vision/pin-op/issues");
  assert.equal(root.homepage, "https://pin-op.conus.vision");

  const vscode = await readManifest("extensions/vscode/package.json");
  assert.equal(vscode.description, productDescription);
  assert.equal(vscode.publisher, "conus-vision");
  assert.equal(vscode.repository, "https://github.com/conus-vision/pin-op");
  assert.equal(vscode.bugs, "https://github.com/conus-vision/pin-op/issues");
  assert.equal(vscode.homepage, "https://pin-op.conus.vision");

  for (const browser of ["chrome", "firefox"]) {
    const manifest = await readManifest(`extensions/${browser}/manifest.json`);
    assert.equal(manifest.description, productDescription, browser);
  }

  const fixture = await readManifest("extensions/source-plugin-fixture/package.json");
  assert.deepEqual(fixture.extensionDependencies, ["conus-vision.pin-op"]);

  const simulator = await readManifest("tools/simulator/package.json");
  assert.deepEqual(simulator.bin, { "pin-op-simulator": "./dist/sendInspect.js" });
});

test("fixture README uses its canonical pin-op workspace filter", async () => {
  const readme = await readFile(
    resolve(repositoryRoot, "extensions/source-plugin-fixture/README.md"),
    "utf8",
  );
  assert.match(
    readme,
    /corepack pnpm --filter pin-op-source-plugin-fixture build/,
  );
  assert.doesNotMatch(readme, /pnpm --filter source-plugin-fixture build/);
});

async function readManifest(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}
