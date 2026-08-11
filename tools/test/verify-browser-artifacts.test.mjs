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
  'const navigationStateType = "source.navigationState";',
  'const resolveLocatorType = "dom.resolveLocator";',
  "",
].join("\n");

const requiredMarkers = [
  {
    label: "source navigation footer",
    path: "dist/panel.html",
    marker: "source-navigation-footer",
  },
  {
    label: "source navigation controls",
    path: "dist/panel.css",
    marker: ".source-navigation-controls",
  },
  {
    label: "source navigation state",
    path: "dist/panel.js",
    marker: "source.navigationState",
  },
  {
    label: "locator recovery",
    path: "dist/panel.js",
    marker: "dom.resolveLocator",
  },
];

for (const browser of ["firefox", "chrome"]) {
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
          `browser2ide-${browser}-0.3.0.zip`,
          browser,
        ),
        new RegExp(`${label}.*${escapeRegex(marker)}`, "i"),
      );
    });
  }
}

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
    Buffer.from('{"schemaVersion":1,"protocolVersion":5}\n'),
  );
  return { files, paths: [...BROWSER_ARCHIVE_FILES] };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
