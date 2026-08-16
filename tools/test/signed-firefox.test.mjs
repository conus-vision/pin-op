import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

import { verifySignedFirefoxXpi } from "../verify-signed-firefox.mjs";

const version = "0.3.0";
const geckoId = "info@conus.vision";
const signatureEntries = [
  "META-INF/cose.manifest",
  "META-INF/cose.sig",
  "META-INF/manifest.mf",
  "META-INF/mozilla.rsa",
  "META-INF/mozilla.sf",
];

test("signed Firefox XPI preserves every runtime byte and adds only signing metadata", async () => {
  await withArchives(async ({ unsignedPath, signedPath }) => {
    assert.doesNotThrow(() =>
      verifySignedFirefoxXpi(unsignedPath, signedPath, version, geckoId),
    );
  });
});

test("signed Firefox XPI rejects changed or missing runtime content", async () => {
  await withArchives(async ({ unsignedPath, directory, runtime }) => {
    const changed = resolve(directory, "changed.xpi");
    writeArchive(changed, { ...runtime, "dist/background.js": "changed" }, signatureEntries);
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, changed, version, geckoId),
      /runtime entry differs/i,
    );

    const missing = resolve(directory, "missing.xpi");
    const { "dist/background.js": _removed, ...withoutRuntime } = runtime;
    writeArchive(missing, withoutRuntime, signatureEntries);
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, missing, version, geckoId),
      /missing runtime entry/i,
    );
  });
});

test("signed Firefox XPI rejects extra payload and incomplete signing metadata", async () => {
  await withArchives(async ({ unsignedPath, directory, runtime }) => {
    const payload = resolve(directory, "payload.xpi");
    writeArchive(payload, { ...runtime, "dist/injected.js": "unsafe" }, signatureEntries);
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, payload, version, geckoId),
      /unexpected signed XPI entry/i,
    );

    const metaPayload = resolve(directory, "meta-payload.xpi");
    writeArchive(metaPayload, runtime, [...signatureEntries, "META-INF/attacker.js"]);
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, metaPayload, version, geckoId),
      /unexpected signed XPI entry/i,
    );

    const incomplete = resolve(directory, "incomplete.xpi");
    writeArchive(incomplete, runtime, signatureEntries.slice(1));
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, incomplete, version, geckoId),
      /missing signing entry/i,
    );
  });
});

test("signed Firefox XPI validates manifest version and Gecko identity", async () => {
  await withArchives(async ({ unsignedPath, signedPath }) => {
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, signedPath, "0.2.1", geckoId),
      /manifest version/i,
    );
    assert.throws(
      () => verifySignedFirefoxXpi(unsignedPath, signedPath, version, "other@example.com"),
      /Gecko ID/i,
    );
  });
});

async function withArchives(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "pinop-signed-xpi-"));
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "Pin-op",
    version,
    browser_specific_settings: { gecko: { id: geckoId } },
  });
  const runtime = {
    "manifest.json": manifest,
    "dist/background.js": "runtime bytes\n",
    "dist/panel.html": "<!doctype html>\n",
  };
  const unsignedPath = resolve(directory, "unsigned.zip");
  const signedPath = resolve(directory, "signed.xpi");
  writeArchive(unsignedPath, runtime, []);
  writeArchive(signedPath, runtime, signatureEntries);
  try {
    await callback({ directory, runtime, signedPath, unsignedPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function writeArchive(path, runtime, signatures) {
  const archive = new AdmZip();
  for (const [name, content] of Object.entries(runtime)) {
    archive.addFile(name, Buffer.from(content));
  }
  for (const name of signatures) {
    archive.addFile(name, Buffer.from(`signature:${name}\n`));
  }
  archive.writeZip(path);
}
