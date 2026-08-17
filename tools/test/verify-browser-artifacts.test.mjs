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

  test(`common ${browser} artifact verifier accepts toolbar class tokens in any order`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/panel.html").toString("utf8");
    const reordered = panel.replace(
      'class="panel-toolbar"',
      "class='secondary panel-toolbar primary'",
    );
    assert.notEqual(reordered, panel);
    archive.files.set("dist/panel.html", Buffer.from(reordered));

    assert.doesNotThrow(() =>
      validateBrowserArchive(
        archive,
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
      Buffer.from(
        `${panel}\n<header class="secondary panel-toolbar"></header>\n`,
      ),
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

  test(`common ${browser} artifact verifier decodes toolbar class character references`, () => {
    for (const encodedClass of [
      "secondary panel&#45;toolbar",
      "secondary panel&#x2d;toolbar",
      "secondary&Tab;panel-toolbar",
    ]) {
      const archive = browserArchive(browser);
      const panel = archive.files.get("dist/panel.html").toString("utf8");
      archive.files.set(
        "dist/panel.html",
        Buffer.from(`${panel}\n<header class="${encodedClass}"></header>\n`),
      );

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.3.0.zip`,
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
      [
        "display-none paste control",
        '<button id="paste-button"',
        '<button style="DISPLAY : none !important" id="paste-button"',
      ],
      [
        "visibility-hidden link control",
        '<button id="link-button"',
        '<button style="visibility:hidden" id="link-button"',
      ],
    ]) {
      const archive = browserArchive(browser);
      const panel = archive.files.get("dist/panel.html").toString("utf8");
      const hidden = panel.replace(source, replacement);
      assert.notEqual(hidden, panel, name);
      archive.files.set("dist/panel.html", Buffer.from(hidden));

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.3.0.zip`,
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
          `pin-op-${browser}-0.3.0.zip`,
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
          `pin-op-${browser}-0.3.0.zip`,
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
      const panel = archive.files.get("dist/panel.html").toString("utf8");
      archive.files.set(
        "dist/panel.html",
        Buffer.from(
          panel.replace("</head>", `<style>${rule}</style>\n</head>`),
        ),
      );

      assert.throws(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.3.0.zip`,
          browser,
        ),
        /connection controls.*visible/i,
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
      const panel = archive.files.get("dist/panel.html").toString("utf8");
      archive.files.set(
        "dist/panel.html",
        Buffer.from(
          panel.replace(
            "</head>",
            "<style>.also-unrelated { display: var(--missing); }</style>\n</head>",
          ),
        ),
      );

      assert.doesNotThrow(
        () => validateBrowserArchive(
          archive,
          `pin-op-${browser}-0.3.0.zip`,
          browser,
        ),
        name,
      );
    }
  });

  test(`common ${browser} artifact verifier rejects controls outside the toolbar`, () => {
    const archive = browserArchive(browser);
    const panel = archive.files.get("dist/panel.html").toString("utf8");
    archive.files.set(
      "dist/panel.html",
      Buffer.from(moveElementAfterToolbar(panel, "paste-button")),
    );

    assert.throws(
      () => validateBrowserArchive(
        archive,
        `pin-op-${browser}-0.3.0.zip`,
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

function moveElementAfterToolbar(panel, id) {
  const start = panel.indexOf(`<button id="${id}"`);
  const end = panel.indexOf("</button>", start) + "</button>".length;
  assert.ok(start >= 0 && end >= "</button>".length);
  const element = panel.slice(start, end);
  const withoutElement = panel.slice(0, start) + panel.slice(end);
  return withoutElement.replace("</header>", `</header>\n${element}`);
}
