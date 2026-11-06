import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import AdmZip from "adm-zip";
import {
  FIREFOX_ADDON_ID,
  verifySignedFirefox,
} from "../verify-signed-firefox.mjs";

const VERSION = "0.5.0";

function releaseFiles(overrides = {}) {
  return {
    "manifest.json": JSON.stringify({
      version: VERSION,
      browser_specific_settings: { gecko: { id: FIREFOX_ADDON_ID } },
    }),
    "dist/background.js": "console.log('background');",
    [`dist/${"long-name-".repeat(8)}.js`]: "// wraps in the JAR manifest",
    ...overrides,
  };
}

function archive(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

function jarManifest(files) {
  const sections = Object.entries(files).map(([name, content]) => {
    const line = `Name: ${name}`;
    // JAR manifests wrap at 72 bytes with a leading space.
    const wrapped = line.length > 72
      ? `${line.slice(0, 72)}\n ${line.slice(72)}`
      : line;
    return `${wrapped}\nDigest-Algorithms: SHA1 SHA256\n` +
      `SHA1-Digest: ${createHash("sha1").update(content).digest("base64")}\n` +
      `SHA256-Digest: ${createHash("sha256").update(content).digest("base64")}\n`;
  });
  return `Manifest-Version: 1.0\n\n${sections.join("\n")}`;
}

/**
 * Shaped like the file Firefox Add-ons serves: its JAR manifest lists the COSE
 * manifest and signature as well as every file of the add-on.
 */
function signed(files, extra = {}) {
  const cose = {
    "META-INF/cose.manifest": "Manifest-Version: 1.0\n",
    "META-INF/cose.sig": "cose",
  };
  return archive({
    ...files,
    ...cose,
    "META-INF/manifest.mf": jarManifest({ ...files, ...cose }),
    "META-INF/mozilla.sf": "Signature-Version: 1.0\n",
    "META-INF/mozilla.rsa": `DER certificate for CN=${FIREFOX_ADDON_ID}`,
    ...extra,
  });
}

test("accepts the release build with only Mozilla's signature added", () => {
  const files = releaseFiles();
  const result = verifySignedFirefox({
    xpi: signed(files),
    zip: archive(files),
    version: VERSION,
  });
  assert.equal(result.files, 3);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("rejects an XPI Mozilla has not signed", () => {
  const files = releaseFiles();
  assert.throws(
    () => verifySignedFirefox({ xpi: archive(files), zip: archive(files), version: VERSION }),
    /not signed: META-INF\/manifest\.mf/,
  );
});

test("rejects an XPI whose files differ from the release ZIP", () => {
  const files = releaseFiles();
  const tampered = { ...files, "dist/background.js": "fetch('https://evil.test')" };
  assert.throws(
    () => verifySignedFirefox({ xpi: signed(tampered), zip: archive(files), version: VERSION }),
    /differs from the release ZIP in dist\/background\.js/,
  );
});

test("rejects added and missing files", () => {
  const files = releaseFiles();
  assert.throws(
    () => verifySignedFirefox({
      xpi: signed({ ...files, "dist/extra.js": "x" }),
      zip: archive(files),
      version: VERSION,
    }),
    /file the release ZIP does not: dist\/extra\.js/,
  );
  const fewer = { ...files };
  delete fewer["dist/background.js"];
  assert.throws(
    () => verifySignedFirefox({ xpi: signed(fewer), zip: archive(files), version: VERSION }),
    /missing a file of the release ZIP: dist\/background\.js/,
  );
});

test("accepts a manifest.json written out again with the same JSON", () => {
  // The listed 0.5.0 file came back this way: the release's own JSON, every
  // array on its own lines, no final newline. Mozilla signed those bytes.
  const files = releaseFiles({
    "manifest.json": [
      "{",
      `  "version": "${VERSION}",`,
      '  "background": {',
      '    "scripts": ["dist/background.js"]',
      "  },",
      '  "permissions": ["activeTab", "tabs"],',
      `  "browser_specific_settings": { "gecko": { "id": "${FIREFOX_ADDON_ID}" } }`,
      "}",
      "",
    ].join("\n"),
  });
  const rewritten = {
    ...files,
    "manifest.json": JSON.stringify(JSON.parse(files["manifest.json"]), null, 2),
  };
  assert.notEqual(rewritten["manifest.json"], files["manifest.json"]);

  const result = verifySignedFirefox({
    xpi: signed(rewritten),
    zip: archive(files),
    version: VERSION,
  });
  assert.equal(result.files, 3);
});

test("rejects a rewritten manifest.json that says something else", () => {
  const files = releaseFiles();
  const manifest = JSON.parse(files["manifest.json"]);
  for (const changed of [
    { ...manifest, permissions: ["<all_urls>"] },
    { ...manifest, version: "0.5.1" },
  ]) {
    assert.throws(
      () => verifySignedFirefox({
        xpi: signed({ ...files, "manifest.json": JSON.stringify(changed, null, 2) }),
        zip: archive(files),
        version: VERSION,
      }),
      /differs from the release ZIP in manifest\.json/,
    );
  }
  // Only the manifest may come back rewritten; any other file must match.
  assert.throws(
    () => verifySignedFirefox({
      xpi: signed({ ...files, "dist/background.js": "console.log('background');\n" }),
      zip: archive(files),
      version: VERSION,
    }),
    /differs from the release ZIP in dist\/background\.js/,
  );
});

test("rejects a signed manifest that does not match the files", () => {
  const files = releaseFiles();
  const xpi = signed(files, {
    "META-INF/manifest.mf": jarManifest({ ...files, "dist/background.js": "other" }),
  });
  assert.throws(
    () => verifySignedFirefox({ xpi, zip: archive(files), version: VERSION }),
    /digest does not match dist\/background\.js/,
  );
});

test("holds the COSE files the JAR manifest lists to their digests", () => {
  const files = releaseFiles();
  assert.throws(
    () => verifySignedFirefox({
      xpi: signed(files, { "META-INF/cose.sig": "swapped" }),
      zip: archive(files),
      version: VERSION,
    }),
    /digest does not match META-INF\/cose\.sig/,
  );
  const cose = { "META-INF/cose.manifest": "Manifest-Version: 1.0\n" };
  assert.throws(
    () => verifySignedFirefox({
      xpi: signed(files, {
        "META-INF/manifest.mf": jarManifest({
          ...files,
          ...cose,
          "META-INF/cose.extra": "x",
        }),
      }),
      zip: archive(files),
      version: VERSION,
    }),
    /lists a file the XPI lacks: META-INF\/cose\.extra/,
  );
});

test("rejects another version or another add-on's signature", () => {
  const files = releaseFiles();
  assert.throws(
    () => verifySignedFirefox({ xpi: signed(files), zip: archive(files), version: "0.5.1" }),
    /XPI version must be 0\.5\.1, received 0\.5\.0/,
  );
  assert.throws(
    () => verifySignedFirefox({
      xpi: signed(files, { "META-INF/mozilla.rsa": "DER certificate for CN=other@example.test" }),
      zip: archive(files),
      version: VERSION,
    }),
    /not issued to info@conus\.vision/,
  );
});
