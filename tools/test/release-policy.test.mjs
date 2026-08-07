import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAsciiFilename,
  assertTextEqual,
  assertVersion,
  normalizeArchivePath,
  rejectSensitivePath,
} from "../release-policy.mjs";

test("archive paths reject traversal and absolute forms", () => {
  for (const path of [
    "../secret.txt",
    "dist/../../secret.txt",
    "dist\\..\\secret.txt",
    "/absolute.txt",
    "C:\\absolute.txt",
  ]) {
    assert.throws(
      () => normalizeArchivePath(path, "fixture.zip", false),
      /dangerous archive path/,
    );
  }
  assert.equal(
    normalizeArchivePath("dist/panel.js", "fixture.zip", false),
    "dist/panel.js",
  );
});

test("release archives reject sensitive path segments", () => {
  for (const path of [
    ".env",
    "config/.env.production",
    "node_modules/package/index.js",
    ".vscode-test/vscode.exe",
    "private/secret.json",
    "private/credentials.yml",
    ".npmrc",
    "home/.netrc",
    "home/.pypirc",
    "home/.git-credentials",
    "ssh/id_rsa",
    "ssh/id_dsa",
    "ssh/id_ecdsa",
    "ssh/id_ed25519",
    "tls/server.key",
    "tls/private.pem",
    "tls/client.p12",
    "tls/client.pfx",
    "tls/client.pkcs12",
    "tls/store.jks",
    "tls/app.keystore",
    "tls/private.der",
    "ssh/user.ppk",
    "kerberos/user.keytab",
    "vpn/profile.ovpn",
    "oauth/client_secret.json",
    "cloud/service-account-prod.json",
    "home/.docker/config.json",
    "home/.kube/config",
  ]) {
    assert.throws(
      () => rejectSensitivePath(path, "fixture.zip"),
      /forbidden path/,
    );
  }
  assert.doesNotThrow(() => rejectSensitivePath("src/secretary.ts", "fixture.zip"));
  assert.doesNotThrow(() => rejectSensitivePath("LICENSE", "fixture.zip"));
  assert.doesNotThrow(() => rejectSensitivePath("ssh/id_ed25519.pub", "fixture.zip"));
  assert.doesNotThrow(() => rejectSensitivePath("docs/public.crt", "fixture.zip"));
});

test("release versions must match the expected product version", () => {
  assert.doesNotThrow(() => assertVersion("0.3.0", "manifest", "0.3.0"));
  assert.throws(
    () => assertVersion("0.3.1", "manifest", "0.3.0"),
    /manifest version must be 0\.3\.0, received 0\.3\.1/,
  );
});

test("checksum artifact names must be printable ASCII", () => {
  assert.doesNotThrow(() => assertAsciiFilename("browser2ide-firefox-0.3.0.zip"));
  assert.throws(() => assertAsciiFilename("bröwser.zip"), /printable ASCII/);
  assert.throws(() => assertAsciiFilename("line\nbreak.zip"), /printable ASCII/);
});

test("tracked text comparison ignores checkout line endings", () => {
  assert.doesNotThrow(() => assertTextEqual("MIT\r\nlicense\r\n", "MIT\nlicense\n"));
  assert.throws(() => assertTextEqual("MIT\nlicense\n", "different\n"), /differs/);
});
