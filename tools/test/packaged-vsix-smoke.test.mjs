import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { withTemporaryDirectory } from "./test-helpers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installedSmokePath = resolve(
  repositoryRoot,
  "extensions/vscode/smoke-installed-vsix.mjs",
);
const installerUrl = new URL("../install-vsix-for-smoke.mjs", import.meta.url);
const runtimeOptionsUrl = new URL("../vscode-smoke-runtime.mjs", import.meta.url);
const directVerifierPath = resolve(
  repositoryRoot,
  "extensions/vscode/verify-vsix.mjs",
);
const projectLicense = await readFile(resolve(repositoryRoot, "LICENSE"));
const vscodeNotices = await readFile(
  resolve(repositoryRoot, "extensions/vscode/THIRD_PARTY_NOTICES"),
);
const mappingsWasm = await readFile(
  resolve(
    repositoryRoot,
    "extensions/vscode/node_modules/source-map/lib/mappings.wasm",
  ),
);
const vscodeIcon = await readFile(
  resolve(repositoryRoot, "extensions/vscode/resources/pin-op.png"),
);
const extensionBundleFixture = [
  'const vscode = require("vscode");',
  'const capabilities = ["resolution", "source-navigation"];',
  'const sourceNavigateType = "source.navigate";',
  'const sourceNavigationStateType = "source.navigationState";',
  "",
].join("\n");
const legacyDisplayName = ["Pin", "Op"].join("");
const legacyAssetStem = ["pin", "op"].join("");
const invalidContributionMutations = [
  {
    name: "activity bar icon",
    mutate(manifest) {
      manifest.contributes.viewsContainers.activitybar[0].icon =
        `resources/${legacyAssetStem}.svg`;
    },
    expectedError: /activitybar container pin-op has unexpected icon/i,
  },
  {
    name: "activity bar title",
    mutate(manifest) {
      manifest.contributes.viewsContainers.activitybar[0].title =
        legacyDisplayName;
    },
    expectedError: /activitybar container pin-op has unexpected title/i,
  },
  {
    name: "command title",
    mutate(manifest) {
      manifest.contributes.commands[0].title = `${legacyDisplayName}: Start`;
    },
    expectedError: /command pin-op\.start has unexpected title/i,
  },
  {
    name: "configuration title",
    mutate(manifest) {
      manifest.contributes.configuration.title = legacyDisplayName;
    },
    expectedError: /unexpected configuration title/i,
  },
  {
    name: "hyphenated color ID",
    mutate(manifest) {
      manifest.contributes.colors[0].id = "pin-op.selectedRuleBackground";
    },
    expectedError: /invalid color ID pin-op\.selectedRuleBackground/i,
  },
  {
    name: "leading-dot color ID",
    mutate(manifest) {
      manifest.contributes.colors[0].id = ".pinOp.selectedRuleBackground";
    },
    expectedError: /invalid color ID \.pinOp\.selectedRuleBackground/i,
  },
  {
    name: "noncanonical color ID",
    mutate(manifest) {
      manifest.contributes.colors[0].id = "pinOp.otherRuleBackground";
    },
    expectedError: /unexpected color ID pinOp\.otherRuleBackground/i,
  },
  {
    name: "missing color ID",
    mutate(manifest) {
      manifest.contributes.colors.pop();
    },
    expectedError: /missing color ID pinOp\.parentRuleBorder/i,
  },
  {
    name: "extra color ID",
    mutate(manifest) {
      manifest.contributes.colors.push({ id: "pinOp.extraRuleBorder" });
    },
    expectedError: /unexpected color ID pinOp\.extraRuleBorder/i,
  },
  {
    name: "duplicate color ID",
    mutate(manifest) {
      manifest.contributes.colors[3].id =
        manifest.contributes.colors[0].id;
    },
    expectedError: /duplicate color ID pinOp\.selectedRuleBackground/i,
  },
];

test("installed VSIX smoke never invokes the machine CLI installer", async () => {
  const source = await readFile(installedSmokePath, "utf8");

  assert.doesNotMatch(source, /resolveCliArgsFromVSCodeExecutablePath/);
  assert.doesNotMatch(source, /--install-extension|--list-extensions/);
  assert.doesNotMatch(source, /spawnSync/);
  assert.match(source, /installVerifiedVsix/);
});

test("installed VSIX smoke has no implicit machine runtime fallback", async () => {
  const source = await readFile(installedSmokePath, "utf8");

  assert.match(source, /resolveVSCodeTestRuntimeOptions/);
  assert.match(source, /\.\.\.runtimeOptions/);
  assert.doesNotMatch(source, /LOCALAPPDATA|defaultVSCodeExecutablePath/);
});

test("installed VSIX smoke pins protocol 6 and current navigation capabilities", async () => {
  const source = await readFile(installedSmokePath, "utf8");

  assert.match(source, /metadata\.protocolVersion !== 6/);
  assert.match(source, /protocol 6/);
  assert.match(source, /"source-navigation"/);
  assert.match(source, /"source\.navigationState"/);
  assert.match(source, /INSTALLED_VSIX_PROTOCOL_V6_OK/);
  assert.doesNotMatch(source, /protocol[- _]?v?5/i);
});

test("VSIX smoke defaults to stable in the repository runtime cache", async () => {
  const resolveRuntimeOptions = await loadRuntimeOptionsResolver();

  const options = await resolveRuntimeOptions({}, repositoryRoot);

  assert.deepEqual(options, {
    cachePath: join(repositoryRoot, ".vscode-test"),
    reuseMachineInstall: false,
    version: "stable",
  });
  assert.equal(Object.hasOwn(options, "vscodeExecutablePath"), false);
});

test("VSIX smoke accepts an explicit absolute existing executable override", async () => {
  const resolveRuntimeOptions = await loadRuntimeOptionsResolver();
  await withTemporaryDirectory("pin-op-vscode-runtime-", async (directory) => {
    const executablePath = join(directory, "Code.exe");
    await writeFile(executablePath, "fixture");

    assert.deepEqual(
      await resolveRuntimeOptions({
        VSCODE_EXECUTABLE_PATH: executablePath,
        VSCODE_TEST_VERSION: "not-used-with-an-override",
      }, repositoryRoot),
      {
        reuseMachineInstall: false,
        vscodeExecutablePath: executablePath,
      },
    );
    await assert.rejects(
      resolveRuntimeOptions({ VSCODE_EXECUTABLE_PATH: "Code.exe" }, repositoryRoot),
      /VSCODE_EXECUTABLE_PATH must be absolute/,
    );
    await assert.rejects(
      resolveRuntimeOptions({
        VSCODE_EXECUTABLE_PATH: join(directory, "missing.exe"),
      }, repositoryRoot),
      /VSCODE_EXECUTABLE_PATH must reference an existing file/,
    );
  });
});

test("VSIX smoke narrowly validates the isolated runtime version", async () => {
  const resolveRuntimeOptions = await loadRuntimeOptionsResolver();
  for (const version of ["stable", "1.85.0", "1.123.456"]) {
    assert.deepEqual(
      await resolveRuntimeOptions({ VSCODE_TEST_VERSION: version }, repositoryRoot),
      {
        cachePath: join(repositoryRoot, ".vscode-test"),
        reuseMachineInstall: false,
        version,
      },
    );
  }
  for (const version of [
    "",
    "insiders",
    "latest",
    "1.85",
    "1.85.0-insider",
    "../1.85.0",
    " 1.85.0",
  ]) {
    await assert.rejects(
      resolveRuntimeOptions({ VSCODE_TEST_VERSION: version }, repositoryRoot),
      /VSCODE_TEST_VERSION must be stable or an exact 1\.x\.x release/,
    );
  }
});

test("validated VSIX payload installs under its canonical artifact identity", async () => {
  const installVerifiedVsix = await loadInstaller();
  await withTemporaryDirectory("pin-op-vsix-install-", async (directory) => {
    const artifactPath = join(directory, "pin-op.vsix");
    const extensionsDirectory = join(directory, "extensions");
    await mkdir(extensionsDirectory);
    writeVsix(artifactPath);

    const result = await installVerifiedVsix(artifactPath, extensionsDirectory);
    const expectedDirectory = join(
      extensionsDirectory,
      "conus-vision.pin-op-0.3.0",
    );

    assert.deepEqual(result, {
      extensionDirectory: expectedDirectory,
      extensionId: "conus-vision.pin-op",
      version: "0.3.0",
    });
    assert.deepEqual(await readdir(extensionsDirectory), [
      "conus-vision.pin-op-0.3.0",
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(expectedDirectory, "package.json"), "utf8")),
      expectedManifest(),
    );
    assert.equal(
      await readFile(join(expectedDirectory, "dist/extension.cjs"), "utf8"),
      extensionBundleFixture,
    );
    await assert.rejects(
      readFile(join(expectedDirectory, "extension.vsixmanifest")),
      { code: "ENOENT" },
    );
  });
});

test("VSIX installation rejects a bundle without current navigation capabilities", async () => {
  const installVerifiedVsix = await loadInstaller();
  await withTemporaryDirectory("pin-op-vsix-capabilities-", async (directory) => {
    const artifactPath = join(directory, "capabilities.vsix");
    const extensionsDirectory = join(directory, "extensions");
    await mkdir(extensionsDirectory);
    writeVsix(artifactPath, {}, {
      bundle: 'const vscode = require("vscode");\n',
    });

    await assert.rejects(
      installVerifiedVsix(artifactPath, extensionsDirectory),
      /VSIX bundle is missing current source-navigation capability/i,
    );
    assert.deepEqual(await readdir(extensionsDirectory), []);
  });
});

test("VSIX installation rejects unsafe archive entries before extraction", async (t) => {
  const installVerifiedVsix = await loadInstaller();
  for (const [name, writeArchive, expectedError] of [
    ["traversal", writeTraversalVsix, /dangerous archive path \.\.\/evil\.txt/],
    ["symbolic link", writeSymlinkVsix, /symbolic link entry extension\/link/],
    [
      "case collision",
      writeCaseCollisionVsix,
      /case-insensitive path collision: extension\/package\.json and Extension\/package\.json/,
    ],
  ]) {
    await t.test(name, async () => {
      await withTemporaryDirectory("pin-op-vsix-unsafe-", async (directory) => {
        const artifactPath = join(directory, "unsafe.vsix");
        const extensionsDirectory = join(directory, "extensions");
        await mkdir(extensionsDirectory);
        await writeArchive(artifactPath);

        await assert.rejects(
          installVerifiedVsix(artifactPath, extensionsDirectory),
          expectedError,
        );
        assert.deepEqual(await readdir(extensionsDirectory), []);
        await assert.rejects(access(join(directory, "evil.txt")), { code: "ENOENT" });
      });
    });
  }
});

test("VSIX installation validates identity before deriving its directory", async () => {
  const installVerifiedVsix = await loadInstaller();
  for (const [field, value, expectedError] of [
    ["publisher", "../outside", /unexpected extension publisher/],
    ["name", "../../outside", /unexpected extension name/],
    ["displayName", ["Pin", "Op"].join(""), /unexpected extension display name/],
    ["repository", "https://example.test/repository", /unexpected extension repository/],
    ["bugs", "https://example.test/issues", /unexpected extension bugs URL/],
    ["homepage", "https://example.test", /unexpected extension homepage/],
    ["version", "../0.3.0", /extension version must be 0\.3\.0/],
    ["icon", "resources/unexpected.png", /unexpected extension icon/],
  ]) {
    await withTemporaryDirectory("pin-op-vsix-identity-", async (directory) => {
      const artifactPath = join(directory, "identity.vsix");
      const extensionsDirectory = join(directory, "extensions");
      await mkdir(extensionsDirectory);
      writeVsix(artifactPath, { [field]: value });

      await assert.rejects(
        installVerifiedVsix(artifactPath, extensionsDirectory),
        expectedError,
      );
      assert.deepEqual(await readdir(extensionsDirectory), []);
    });
  }
});

test("common VSIX verifier accepts reordered canonical color IDs", async () => {
  const installVerifiedVsix = await loadInstaller();
  await withTemporaryDirectory("pin-op-vsix-reordered-colors-", async (directory) => {
    const artifactPath = join(directory, "reordered.vsix");
    const extensionsDirectory = join(directory, "extensions");
    await mkdir(extensionsDirectory);
    const manifest = expectedManifest();
    manifest.contributes.colors.reverse();
    writeVsix(artifactPath, manifest);

    const result = await installVerifiedVsix(artifactPath, extensionsDirectory);

    assert.equal(result.extensionId, "conus-vision.pin-op");
  });
});

test("direct VSIX verifier accepts reordered canonical color IDs", async () => {
  await withTemporaryDirectory("pin-op-direct-vsix-reordered-colors-", async (directory) => {
    const artifactPath = join(directory, "reordered.vsix");
    const manifest = expectedManifest();
    manifest.contributes.colors.reverse();
    writeVsix(artifactPath, manifest);

    const result = spawnSync(
      process.execPath,
      [directVerifierPath, artifactPath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    assert.equal(
      result.status,
      0,
      `reordered archive was rejected:\n${result.stdout}${result.stderr}`,
    );
  });
});

for (const mutation of invalidContributionMutations) {
  test(`common VSIX verifier rejects invalid ${mutation.name}`, async () => {
    const installVerifiedVsix = await loadInstaller();
    await withTemporaryDirectory("pin-op-vsix-contribution-", async (directory) => {
      const artifactPath = join(directory, "identity.vsix");
      const extensionsDirectory = join(directory, "extensions");
      await mkdir(extensionsDirectory);
      const manifest = expectedManifest();
      mutation.mutate(manifest);
      writeVsix(artifactPath, manifest);

      await assert.rejects(
        installVerifiedVsix(artifactPath, extensionsDirectory),
        mutation.expectedError,
      );
      assert.deepEqual(await readdir(extensionsDirectory), []);
    });
  });

  test(`direct VSIX verifier rejects invalid ${mutation.name}`, async () => {
    await withTemporaryDirectory("pin-op-direct-vsix-contribution-", async (directory) => {
      const artifactPath = join(directory, "identity.vsix");
      const manifest = expectedManifest();
      mutation.mutate(manifest);
      writeVsix(artifactPath, manifest);

      const result = spawnSync(
        process.execPath,
        [directVerifierPath, artifactPath],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      assert.notEqual(
        result.status,
        0,
        `mutated archive was accepted:\n${result.stdout}${result.stderr}`,
      );
      assert.match(`${result.stdout}\n${result.stderr}`, mutation.expectedError);
    });
  });
}

test("VSIX installation rejects VSIX manifest identity mismatches", async (t) => {
  const installVerifiedVsix = await loadInstaller();
  const manifestXml = expectedVsixManifestXml();
  for (const [name, xml, expectedError] of [
    [
      "publisher",
      manifestXml.replace('Publisher="conus-vision"', 'Publisher="other"'),
      /extension\.vsixmanifest publisher other does not match extension\/package\.json/,
    ],
    [
      "name",
      manifestXml.replace('Id="pin-op"', 'Id="other"'),
      /extension\.vsixmanifest name other does not match extension\/package\.json/,
    ],
    [
      "version",
      manifestXml.replace('Version="0.3.0"', 'Version="0.3.1"'),
      /extension\.vsixmanifest version 0\.3\.1 does not match extension\/package\.json/,
    ],
  ]) {
    await t.test(name, async () => {
      await withTemporaryDirectory("pin-op-vsix-xml-identity-", async (directory) => {
        const artifactPath = join(directory, "identity.vsix");
        const extensionsDirectory = join(directory, "extensions");
        await mkdir(extensionsDirectory);
        writeVsix(artifactPath, {}, { manifestXml: xml });

        await assert.rejects(
          installVerifiedVsix(artifactPath, extensionsDirectory),
          expectedError,
        );
        assert.deepEqual(await readdir(extensionsDirectory), []);
      });
    });
  }
});

test("VSIX installation rejects an invalid Marketplace icon", async () => {
  const installVerifiedVsix = await loadInstaller();
  await withTemporaryDirectory("pin-op-vsix-icon-", async (directory) => {
    const artifactPath = join(directory, "icon.vsix");
    const extensionsDirectory = join(directory, "extensions");
    await mkdir(extensionsDirectory);
    writeVsix(artifactPath, {}, { icon: Buffer.from("not a png") });

    await assert.rejects(
      installVerifiedVsix(artifactPath, extensionsDirectory),
      /pin-op\.png.*valid PNG/i,
    );
    assert.deepEqual(await readdir(extensionsDirectory), []);
  });
});

test("VSIX installation rejects malformed or entity-bearing metadata XML", async (t) => {
  const installVerifiedVsix = await loadInstaller();
  for (const [name, xmlOverrides, expectedError] of [
    [
      "malformed VSIX manifest",
      { manifestXml: "<PackageManifest>" },
      /invalid XML in extension\.vsixmanifest/,
    ],
    [
      "malformed content types",
      { contentTypesXml: "<Types>" },
      /invalid XML in \[Content_Types\]\.xml/,
    ],
    [
      "external entity declaration",
      {
        manifestXml: expectedVsixManifestXml().replace(
          "<PackageManifest",
          '<!DOCTYPE PackageManifest SYSTEM "file:///pin-op-test">\n<PackageManifest',
        ),
      },
      /extension\.vsixmanifest must not contain a DOCTYPE declaration/,
    ],
  ]) {
    await t.test(name, async () => {
      await withTemporaryDirectory("pin-op-vsix-invalid-xml-", async (directory) => {
        const artifactPath = join(directory, "invalid-xml.vsix");
        const extensionsDirectory = join(directory, "extensions");
        await mkdir(extensionsDirectory);
        writeVsix(artifactPath, {}, xmlOverrides);

        await assert.rejects(
          installVerifiedVsix(artifactPath, extensionsDirectory),
          expectedError,
        );
        assert.deepEqual(await readdir(extensionsDirectory), []);
      });
    });
  }
});

test("VSIX installation requires payload content type declarations", async (t) => {
  const installVerifiedVsix = await loadInstaller();
  const contentTypesXml = expectedContentTypesXml();
  for (const [name, xml, expectedError] of [
    [
      "missing payload type",
      contentTypesXml.replace(
        '<Default Extension=".wasm" ContentType="application/wasm"/>',
        "",
      ),
      /\[Content_Types\]\.xml is missing required \.wasm content type application\/wasm/,
    ],
    [
      "mismatched payload type",
      contentTypesXml.replace(
        '<Default Extension=".json" ContentType="application/json"/>',
        '<Default Extension=".json" ContentType="text/plain"/>',
      ),
      /\[Content_Types\]\.xml declares \.json as text\/plain; expected application\/json/,
    ],
  ]) {
    await t.test(name, async () => {
      await withTemporaryDirectory("pin-op-vsix-content-types-", async (directory) => {
        const artifactPath = join(directory, "content-types.vsix");
        const extensionsDirectory = join(directory, "extensions");
        await mkdir(extensionsDirectory);
        writeVsix(artifactPath, {}, { contentTypesXml: xml });

        await assert.rejects(
          installVerifiedVsix(artifactPath, extensionsDirectory),
          expectedError,
        );
        assert.deepEqual(await readdir(extensionsDirectory), []);
      });
    });
  }
});

async function loadInstaller() {
  let module;
  try {
    module = await import(installerUrl.href);
  } catch (error) {
    assert.fail(
      `VSIX smoke installer module is unavailable: ${error.code ?? error.message}`,
    );
  }
  assert.equal(typeof module.installVerifiedVsix, "function");
  return module.installVerifiedVsix;
}

async function loadRuntimeOptionsResolver() {
  let module;
  try {
    module = await import(runtimeOptionsUrl.href);
  } catch (error) {
    assert.fail(
      `VS Code smoke runtime module is unavailable: ${error.code ?? error.message}`,
    );
  }
  assert.equal(typeof module.resolveVSCodeTestRuntimeOptions, "function");
  return module.resolveVSCodeTestRuntimeOptions;
}

function expectedManifest(overrides = {}) {
  return {
    name: "pin-op",
    displayName: "Pin-op",
    publisher: "conus-vision",
    repository: "https://github.com/conus-vision/pin-op",
    bugs: "https://github.com/conus-vision/pin-op/issues",
    homepage: "https://pin-op.conus.vision",
    version: "0.3.0",
    main: "./dist/extension.cjs",
    icon: "resources/pin-op.png",
    contributes: {
      commands: [
        { command: "pin-op.start", title: "Pin-op: Start" },
        { command: "pin-op.stop", title: "Pin-op: Stop" },
        { command: "pin-op.copyLinkCode", title: "Pin-op: Copy Link Code" },
        { command: "pin-op.openDiagnostics", title: "Pin-op: Open Diagnostics" },
        { command: "pin-op.revealSourceMatch", title: "Pin-op: Reveal Source Match" },
      ],
      viewsContainers: {
        activitybar: [
          {
            id: "pin-op",
            title: "Pin-op",
            icon: "resources/pin-op.svg",
          },
        ],
      },
      configuration: {
        title: "Pin-op",
        properties: {
          "pin-op.sessionId": { type: "string", default: "default" },
        },
      },
      colors: [
        { id: "pinOp.selectedRuleBackground" },
        { id: "pinOp.selectedRuleBorder" },
        { id: "pinOp.parentRuleBackground" },
        { id: "pinOp.parentRuleBorder" },
      ],
    },
    ...overrides,
  };
}

function writeVsix(path, manifestOverrides = {}, archiveOverrides = {}) {
  const zip = new AdmZip();
  for (const [name, content] of [
    [
      "[Content_Types].xml",
      archiveOverrides.contentTypesXml ?? expectedContentTypesXml(),
    ],
    [
      "extension.vsixmanifest",
      archiveOverrides.manifestXml ?? expectedVsixManifestXml(),
    ],
    ["extension/LICENSE.txt", projectLicense],
    ["extension/THIRD_PARTY_NOTICES", vscodeNotices],
    [
      "extension/dist/extension.cjs",
      archiveOverrides.bundle ?? extensionBundleFixture,
    ],
    ["extension/dist/mappings.wasm", mappingsWasm],
    [
      "extension/dist/runtime-metadata.json",
      '{"schemaVersion":1,"protocolVersion":5}\n',
    ],
    ["extension/package.json", JSON.stringify(expectedManifest(manifestOverrides))],
    ["extension/readme.md", "readme"],
    ["extension/resources/pin-op.svg", "<svg></svg>"],
    ["extension/resources/pin-op.png", archiveOverrides.icon ?? vscodeIcon],
  ]) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  zip.writeZip(path);
}

function expectedVsixManifestXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="pin-op" Version="0.3.0" Publisher="conus-vision" />
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;
}

function expectedContentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".cjs" ContentType="application/octet-stream"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".svg" ContentType="image/svg+xml"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".wasm" ContentType="application/wasm"/></Types>`;
}

async function writeTraversalVsix(path) {
  const zip = new AdmZip();
  zip.addFile("xx/evil.txt", Buffer.from("unsafe"));
  await writeFile(
    path,
    replaceZipEntryName(zip.toBuffer(), "xx/evil.txt", "../evil.txt"),
  );
}

function writeSymlinkVsix(path) {
  const zip = new AdmZip();
  zip.addFile("extension/link", Buffer.from("target"));
  const entry = zip.getEntry("extension/link");
  entry.attr = (0o120777 << 16) >>> 0;
  entry.header.made = (3 << 8) | 20;
  zip.writeZip(path);
}

function writeCaseCollisionVsix(path) {
  const zip = new AdmZip();
  zip.addFile("extension/package.json", Buffer.from("one"));
  zip.addFile("Extension/package.json", Buffer.from("two"));
  zip.writeZip(path);
}

function replaceZipEntryName(buffer, source, replacement) {
  assert.equal(Buffer.byteLength(source), Buffer.byteLength(replacement));
  const result = Buffer.from(buffer);
  const sourceBytes = Buffer.from(source);
  const replacementBytes = Buffer.from(replacement);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(sourceBytes, offset)) >= 0) {
    replacementBytes.copy(result, offset);
    offset += sourceBytes.length;
    replacements += 1;
  }
  assert.equal(replacements, 2);
  return result;
}
