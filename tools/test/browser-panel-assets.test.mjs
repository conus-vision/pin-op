import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoChromiumUpstreamInputs,
  assertVerifiedNativeInspectorBuild,
} from "../browser-panel-assets.mjs";

test("negative Chromium gate rejects every native runtime authority on POSIX and Windows paths", () => {
  const forbiddenInputs = [
    "node_modules/chrome-devtools-frontend/front_end/core/sdk/DOMModel.ts",
    "node_modules/.pnpm/chrome-devtools-frontend@1.0.1681091/node_modules/chrome-devtools-frontend/front_end/ui/legacy/Widget.ts",
    "third_party/chromium-devtools-frontend/UPSTREAM.json",
    "third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/ElementsTreeOutline.ts",
    "third_party/chromium-devtools-frontend/patches/1.0.1681091/entrypoints/read-only-elements.ts",
    "third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/entrypoints/read-only-styles.ts",
    "packages/devtools-elements-ui/dist/chromium/upstream/PinOpChromiumInspectorAdapter.js",
    "packages/devtools-elements-ui/src/chromium/dom/ElementsTreeOutline.ts",
    "tools/browser-chromium-inspector-entry.ts",
  ];

  for (const input of forbiddenInputs) {
    for (const candidate of [input, `..\\..\\${input.replaceAll("/", "\\")}`]) {
      assert.throws(
        () => assertNoChromiumUpstreamInputs({inputs: {[candidate]: {}}}, "bootstrap"),
        /native Chromium runtime input/i,
        candidate,
      );
    }
  }

  assert.doesNotThrow(() => assertNoChromiumUpstreamInputs({
    inputs: {
      "src/inspectorPanel.ts": {},
      "node_modules/chrome-devtools-frontend-helper/index.js": {},
      "packages/devtools-elements-ui/dist/elementsInspectorShell.js": {},
    },
  }, "bootstrap"));
});

test("positive native gate accepts an exact union with overlapping owners", () => {
  assert.doesNotThrow(() => assertVerifiedNativeInspectorBuild(
    validNativeBuild(),
    "native runtime",
  ));
});

test("positive native gate rejects sparse, duplicate, missing, and extra inventories", () => {
  const duplicate = validNativeBuild();
  duplicate.runtimeVerification.elements.verifiedInputKeys = [
    "dom.ts",
    "dom.ts",
    "shared.ts",
  ];
  assert.throws(
    () => assertVerifiedNativeInspectorBuild(duplicate),
    /unique/i,
  );

  const sparse = validNativeBuild();
  const sparseInputs = new Array(2);
  sparseInputs[0] = "dom.ts";
  sparse.runtimeVerification.elements.verifiedInputKeys = sparseInputs;
  assert.throws(
    () => assertVerifiedNativeInspectorBuild(sparse),
    /dense/i,
  );

  const missing = validNativeBuild();
  missing.runtimeVerification.localInputKeys = [];
  assert.throws(
    () => assertVerifiedNativeInspectorBuild(missing),
    /exact union/i,
  );

  const extra = validNativeBuild();
  extra.runtimeVerification.styles.verifiedInputKeys.push("foreign.ts");
  assert.throws(
    () => assertVerifiedNativeInspectorBuild(extra),
    /exact union/i,
  );
});

test("positive native gate rejects malformed attestations", () => {
  for (const mutate of [
    build => { build.runtimeVerification.elements.chromiumInputAttestation.fileCount = -1; },
    build => { build.runtimeVerification.elements.overlayAttestation.sha256 = "not-a-hash"; },
    build => { build.runtimeVerification.styles.packageInputAttestation.extra = true; },
    build => { build.runtimeVerification.styles.stylesOverlayAttestation = null; },
    build => { build.runtimeVerification.styles.baseOverlayAttestation.sha256 = "A".repeat(64); },
    build => { build.runtimeVerification.elements.requiredLicenseFiles[1] = undefined; },
    build => { build.runtimeVerification.styles.requiredLicenseFiles[0].path = ""; },
  ]) {
    const build = validNativeBuild();
    mutate(build);
    assert.throws(
      () => assertVerifiedNativeInspectorBuild(build),
      /attestation|license|dense/i,
    );
  }
});

test("positive native gate requires two exact outputs and one closed runtime module", () => {
  for (const [pattern, mutate] of [
    [/exactly Inspector bootstrap and native runtime outputs/i, build => {
      build.inspectorRuntimeResult.metafile.outputs["dist/runtime.css"] = {
        bytes: 1, imports: [], exports: [], inputs: {},
      };
    }],
    [/output path/i, build => {
      const output = build.elementsRuntimeResult.metafile.outputs["dist/chromiumElementsRuntime.js"];
      delete build.elementsRuntimeResult.metafile.outputs["dist/chromiumElementsRuntime.js"];
      build.elementsRuntimeResult.metafile.outputs["dist/renamed.js"] = output;
    }],
    [/export only createElementsInspectorView/i, build => {
      runtimeOutput(build).exports.push("rawAuthority");
    }],
    [/zero output imports/i, build => {
      runtimeOutput(build).imports.push({path: "./foreign.js", kind: "import-statement"});
    }],
    [/runtime byte attestation/i, build => {
      build.runtimeVerification.minifiedBytes++;
    }],
  ]) {
    const build = validNativeBuild();
    mutate(build);
    assert.throws(
      () => assertVerifiedNativeInspectorBuild(build),
      pattern,
    );
  }
});

function validNativeBuild() {
  const runtimeInputs = Object.fromEntries(
    ["dom.ts", "entry.ts", "shared.ts", "styles.ts"].map(path => [path, {}]),
  );
  const runtimeOutput = {
    bytes: 4096,
    entryPoint: "tools/browser-chromium-inspector-entry.ts",
    exports: ["createElementsInspectorView"],
    imports: [],
    inputs: Object.fromEntries(Object.keys(runtimeInputs).map(path => [path, {bytesInOutput: 1}])),
  };
  const panelOutput = {
    bytes: 512,
    entryPoint: "extensions/chrome/src/inspectorPanel.ts",
    exports: [],
    imports: [{
      external: true,
      kind: "import-statement",
      path: "./chromiumElementsRuntime.js",
    }],
    inputs: {"extensions/chrome/src/inspectorPanel.ts": {bytesInOutput: 1}},
  };
  const attestation = () => ({fileCount: 1, sha256: "a".repeat(64)});
  const license = path => ({path, sha256: "b".repeat(64)});
  return {
    inspectorRuntimeResult: {
      metafile: {
        inputs: {...runtimeInputs, "extensions/chrome/src/inspectorPanel.ts": {}},
        outputs: {
          "dist/inspectorPanel.js": panelOutput,
          "dist/chromiumElementsRuntime.js": runtimeOutput,
        },
      },
    },
    inspectorPanelResult: {
      metafile: {
        inputs: {"extensions/chrome/src/inspectorPanel.ts": {}},
        outputs: {"dist/inspectorPanel.js": panelOutput},
      },
    },
    elementsRuntimeResult: {
      metafile: {
        inputs: runtimeInputs,
        outputs: {"dist/chromiumElementsRuntime.js": runtimeOutput},
      },
    },
    runtimeVerification: {
      minifiedBytes: runtimeOutput.bytes,
      verifiedInputKeys: Object.keys(runtimeInputs),
      localInputKeys: ["entry.ts"],
      elements: {
        verifiedInputKeys: ["dom.ts", "shared.ts"],
        chromiumInputAttestation: attestation(),
        overlayAttestation: attestation(),
        requiredLicenseFiles: [license("LICENSE")],
      },
      styles: {
        verifiedInputKeys: ["shared.ts", "styles.ts"],
        packageInputAttestation: attestation(),
        stylesOverlayAttestation: attestation(),
        baseOverlayAttestation: attestation(),
        requiredLicenseFiles: [license("LICENSE")],
      },
    },
  };
}

function runtimeOutput(build) {
  return build.elementsRuntimeResult.metafile.outputs[
    "dist/chromiumElementsRuntime.js"
  ];
}
