import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHROMIUM_DEVTOOLS_PIN,
  bundleChromiumDevToolsModule,
  verifyChromiumDevToolsPackage,
} from "../chromium-devtools-runtime.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("Chromium DevTools runtime is pinned to the reviewed official package", async () => {
  assert.deepEqual(CHROMIUM_DEVTOOLS_PIN, {
    packageName: "chrome-devtools-frontend",
    version: "1.0.1681091",
    gitHead: "23cccaa78f7458a5aad99c1af98dc1856d2494a3",
    integrity:
      "sha512-cXBay271CnEb+Y+Cxre3mjGDHFKhXVo9mGfNCVAruen/iwF+jnG6Z55mnC7yh078HD1rmKhBM9tKLKQbjVniVQ==",
  });

  const runtimeManifest = JSON.parse(await readFile(
    path.join(
      repositoryRoot,
      "third_party",
      "chromium-devtools-frontend",
      "RUNTIME.json",
    ),
    "utf8",
  ));
  assert.deepEqual(runtimeManifest.package, CHROMIUM_DEVTOOLS_PIN);

  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  assert.equal(verified.version, CHROMIUM_DEVTOOLS_PIN.version);
  assert.equal(
    verified.files["front_end/panels/elements/ElementsTreeOutline.ts"],
    "36049536b7e146addc2de9784790d8ae630f28c1640b3b679506d9e4cc7bfd9d",
  );
  assert.equal(
    verified.files["front_end/panels/elements/StylesSidebarPane.ts"],
    "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28",
  );
  assert.equal(
    verified.files.LICENSE,
    "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
  );

  const lockfile = await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  assert.match(
    lockfile,
    new RegExp(
      `chrome-devtools-frontend@${CHROMIUM_DEVTOOLS_PIN.version.replaceAll(".", "\\.")}:[\\s\\S]{0,160}` +
        CHROMIUM_DEVTOOLS_PIN.integrity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
});

test("esbuild compiles the real upstream Elements tree and generated CSS modules", async () => {
  const result = await bundleChromiumDevToolsModule({
    repositoryRoot,
    entryPoint: "front_end/panels/elements/ElementsTreeOutline.ts",
    write: false,
  });
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  });

  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/ElementsTreeOutline.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/ElementsTreeElement.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/ui/legacy/Treeoutline.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/elementsTreeOutline.css",
  )));

  const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(javascript);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /ElementsTreeOutline\s*=\s*class/);
  assert.match(output, /elements-tree-outline/);
  assert.match(output, /style\.textContent = cssText/);
  assert.match(output, /var elementsTreeOutline_default = ['"]\/\*/);
  assert.doesNotMatch(output, /node:worker_threads/);
});

test("runtime refuses unreviewed Chromium entrypoints", async () => {
  await assert.rejects(
    bundleChromiumDevToolsModule({
      repositoryRoot,
      entryPoint: "front_end/panels/network/NetworkPanel.ts",
      write: false,
    }),
    /not a reviewed Chromium DevTools entry point/i,
  );
});

test("esbuild compiles the real upstream Rules pane", async () => {
  const result = await bundleChromiumDevToolsModule({
    repositoryRoot,
    entryPoint: "front_end/panels/elements/StylesSidebarPane.ts",
    write: false,
  });
  assert.deepEqual(result.chromiumInputAttestation, {
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  });

  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/StylesSidebarPane.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/StylePropertiesSection.ts",
  )));
  assert.ok(inputs.some(value => value.endsWith(
    "/chrome-devtools-frontend/front_end/panels/elements/stylesSidebarPane.css",
  )));

  const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(javascript);
  const output = new TextDecoder().decode(javascript.contents);
  assert.match(output, /StylesSidebarPane\s*=\s*class/);
  assert.match(output, /var stylesSidebarPane_default = (?:['"]\/\*|`\/\*\*)/);
  assert.doesNotMatch(output, /node:worker_threads/);
  assert.doesNotMatch(
    output,
    /setProperty\(["']--image-file-baseline-(?:high|limited|low)-availability/,
  );
});
