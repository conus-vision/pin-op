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

function signed(files, extra = {}) {
  return archive({
    ...files,
    "META-INF/manifest.mf": jarManifest(files),
    "META-INF/mozilla.sf": "Signature-Version: 1.0\n",
    "META-INF/mozilla.rsa": `DER certificate for CN=${FIREFOX_ADDON_ID}`,
    "META-INF/cose.manifest": "Manifest-Version: 1.0\n",
    "META-INF/cose.sig": "cose",
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
