import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BROWSER_ARCHIVE_FILES,
  validateBrowserArchive,
} from "../verify-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const panelHtml = readFileSync(
  resolve(repositoryRoot, "packages/browser-extension-core/assets/panel.html"),
  "utf8",
);
const panelCss = readFileSync(
  resolve(repositoryRoot, "packages/browser-extension-core/assets/panel.css"),
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

const requiredMarkers = [
  {
    label: "toolbar",
    path: "dist/panel.html",
    marker: 'class="panel-toolbar"',
  },
  {
    label: "picker",
    path: "dist/panel.html",
    marker: 'id="inspect-mode"',
  },
  {
    label: "Auto Refresh",
    path: "dist/panel.html",
    marker: "Auto Refresh",
  },
  {
    label: "IDE Highlight",
    path: "dist/panel.html",
    marker: "IDE Highlight",
  },
  {
    label: "connection controls",
    path: "dist/panel.html",
    marker: 'id="link-code"',
  },
  {
    label: "DOM workspace",
    path: "dist/panel.html",
    marker: 'id="dom-pane"',
  },
  {
    label: "Source workspace",
    path: "dist/panel.html",
    marker: 'id="source-pane"',
  },
  {
    label: "source pane",
    path: "dist/panel.html",
    marker: 'id="source-pane-root"',
  },
  {
    label: "incompatibility copy",
    path: "dist/panel.html",
    marker:
      "Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.",
  },
  {
    label: "branded footer",
    path: "dist/panel.html",
    marker: 'href="mailto:info@conus.vision"',
  },
  {
    label: "source navigation footer",
    path: "dist/panel.html",
    marker: "source-navigation-footer",
  },
  {
    label: "responsive toolbar",
    path: "dist/panel.css",
    marker: ".panel-toolbar-scroll",
  },
  {
    label: "responsive split layout",
    path: "dist/panel.css",
    marker: '[data-layout="split"]',
  },
  {
    label: "responsive stack layout",
    path: "dist/panel.css",
    marker: '[data-layout="stack"]',
  },
  {
    label: "responsive tab layout",
    path: "dist/panel.css",
    marker: '[data-layout="tabs"]',
  },
  {
    label: "source excerpt style",
    path: "dist/panel.css",
    marker: ".source-pane-excerpt",
  },
  {
    label: "source navigation controls",
    path: "dist/panel.css",
    marker: ".source-navigation-controls",
  },
  {
    label: "source matches",
    path: "dist/panel.js",
    marker: "source.matches",
  },
  {
    label: "source open",
    path: "dist/panel.js",
    marker: "source.open",
  },
  {
    label: "source navigation intent",
    path: "dist/panel.js",
    marker: "source.navigate",
  },
  {
    label: "source navigation state",
    path: "dist/panel.js",
    marker: "source.navigationState",
  },
  {
    label: "opaque match identity",
    path: "dist/panel.js",
    marker: "matchId",
  },
  {
    label: "locator recovery",
    path: "dist/panel.js",
    marker: "dom.resolveLocator",
  },
];

for (const browser of ["firefox", "chrome"]) {
  test(`common ${browser} artifact verifier accepts protocol v6 and the current panel`, () => {
    assert.doesNotThrow(() =>
      validateBrowserArchive(
        browserArchive(browser),
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
    );
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
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
      /runtime metadata protocolVersion expected 6 but found 5/i,
    );
  });

  for (const { label, path, marker } of requiredMarkers) {
    test(`common ${browser} artifact verifier requires ${label}`, () => {
      const archive = browserArchive(browser);
      const original = archive.files.get(path).toString("utf8");
      const withoutMarker = original.replaceAll(
        marker,
        "missing-contract-marker",
      );
      assert.notEqual(withoutMarker, original);
      assert.equal(withoutMarker.includes(marker), false);
      archive.files.set(path, Buffer.from(withoutMarker));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.3.0.zip`,
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
        `pin-op-${browser}-0.3.0.zip`,
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
        `pin-op-${browser}-0.3.0.zip`,
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
        `pin-op-${browser}-0.3.0.zip`,
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
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
      /unexpected manifest description/i,
    );
  });

  test(`common ${browser} artifact verifier requires the renamed panel image`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/panel.html").toString("utf8");
    const legacyPanel = panel.replace(
      'src="./pin-op.svg"',
      `src="./${["pin", "op"].join("")}.svg"`,
    );
    assert.notEqual(legacyPanel, panel);
    archive.files.set("dist/panel.html", Buffer.from(legacyPanel));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
      /panel must reference \.\/pin-op\.svg/i,
    );
  });

  test(`common ${browser} artifact verifier requires visible Pin-op panel identity`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/panel.html").toString("utf8");
    const legacyPanel = panel.replaceAll("Pin-op", ["Pin", "Op"].join(""));
    assert.notEqual(legacyPanel, panel);
    archive.files.set("dist/panel.html", Buffer.from(legacyPanel));

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
      /panel must present Pin-op in its title and branded footer/i,
    );
  });

  test(`common ${browser} artifact verifier requires exactly one toolbar`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/panel.html").toString("utf8");
    archive.files.set(
      "dist/panel.html",
      Buffer.from(`${panel}\n<header class="panel-toolbar"></header>\n`),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.3.0.zip`,
        browser,
      ),
      /toolbar.*exactly one/i,
    );
  });
}

test("common Firefox artifact verifier preserves the Gecko extension ID", () => {
  const archive = browserArchive("firefox");
  const manifest = JSON.parse(archive.files.get("manifest.json").toString("utf8"));
  manifest.browser_specific_settings.gecko.id = "pin-op@example.test";
  archive.files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));

  assert.throws(
    () => validateBrowserArchive(archive, "pin-op-firefox-0.3.0.zip", "firefox"),
    /unexpected Firefox Gecko ID/i,
  );
});

function browserArchive(browser) {
  const files = new Map(
    BROWSER_ARCHIVE_FILES.map((path) => [path, Buffer.from(`fixture ${path}`)]),
  );
  files.set("LICENSE", readFileSync(resolve(repositoryRoot, "LICENSE")));
  files.set(
    "manifest.json",
    readFileSync(resolve(repositoryRoot, `extensions/${browser}/manifest.json`)),
  );
  files.set("dist/panel.html", Buffer.from(panelHtml));
  files.set("dist/panel.css", Buffer.from(panelCss));
  files.set("dist/panel.js", Buffer.from(panelBundle));
  files.set(
    "dist/runtime-metadata.json",
    Buffer.from('{"schemaVersion":1,"protocolVersion":6}\n'),
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
