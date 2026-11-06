import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

export const FIREFOX_ADDON_ID = "info@conus.vision";

/**
 * The files Mozilla adds when it signs an add-on: a JAR manifest of every
 * file's digest, its signature file and PKCS#7 signature, and the COSE
 * manifest and signature newer Firefox releases check first.
 */
const REQUIRED_SIGNATURE_FILES = Object.freeze([
  "META-INF/manifest.mf",
  "META-INF/mozilla.sf",
  "META-INF/mozilla.rsa",
]);
const OPTIONAL_SIGNATURE_FILES = Object.freeze([
  "META-INF/cose.manifest",
  "META-INF/cose.sig",
]);

/**
 * The file Firefox Add-ons signs can carry `manifest.json` written out again:
 * the listed 0.5.0 file holds the release's own JSON with every array on its
 * own lines and no final newline. Mozilla signs those bytes, so the manifest
 * is held to meaning, not spelling.
 */
const REWRITTEN_AS_JSON = new Set(["manifest.json"]);

/**
 * Checks that a Mozilla-signed `.xpi` downloaded from Firefox Add-ons is the
 * release's own Firefox package and nothing else.
 *
 * Firefox verifies Mozilla's signature itself when it installs the file; this
 * check is what the release adds on top of that. Every file of the unsigned
 * release ZIP must be in the XPI byte for byte -- `manifest.json` as the same
 * JSON -- the XPI may add only Mozilla's signature files, the signed JAR
 * manifest must list the SHA-256 of every file it carries exactly, and the
 * manifest and signing certificate must name this add-on and the release
 * version.
 */
export function verifySignedFirefox({ xpi, zip, version }) {
  const signed = readEntries(xpi, "XPI");
  const unsigned = readEntries(zip, "release ZIP");

  for (const name of REQUIRED_SIGNATURE_FILES) {
    if (!signed.has(name)) {
      throw new Error(`XPI is not signed: ${name} is missing`);
    }
  }
  const signatureFiles = new Set([
    ...REQUIRED_SIGNATURE_FILES,
    ...OPTIONAL_SIGNATURE_FILES,
  ]);
  for (const name of signed.keys()) {
    if (signatureFiles.has(name)) continue;
    if (!unsigned.has(name)) {
      throw new Error(`XPI contains a file the release ZIP does not: ${name}`);
    }
  }
  for (const [name, bytes] of unsigned) {
    const signedBytes = signed.get(name);
    if (!signedBytes) {
      throw new Error(`XPI is missing a file of the release ZIP: ${name}`);
    }
    if (
      !signedBytes.equals(bytes) &&
      !(REWRITTEN_AS_JSON.has(name) && sameJson(signedBytes, bytes))
    ) {
      throw new Error(`XPI differs from the release ZIP in ${name}`);
    }
  }

  // The signature covers the files as the XPI carries them.
  const listed = jarManifestDigests(signed.get("META-INF/manifest.mf"));
  for (const name of unsigned.keys()) {
    const digest = listed.get(name);
    if (!digest) {
      throw new Error(`Signed manifest does not cover ${name}`);
    }
    if (digest !== createHash("sha256").update(signed.get(name)).digest("base64")) {
      throw new Error(`Signed manifest digest does not match ${name}`);
    }
  }
  // Mozilla's JAR manifest also covers the COSE manifest and signature.
  for (const [name, digest] of listed) {
    if (unsigned.has(name)) continue;
    if (!OPTIONAL_SIGNATURE_FILES.includes(name) || !signed.has(name)) {
      throw new Error(`Signed manifest lists a file the XPI lacks: ${name}`);
    }
    if (digest !== createHash("sha256").update(signed.get(name)).digest("base64")) {
      throw new Error(`Signed manifest digest does not match ${name}`);
    }
  }

  const manifest = JSON.parse(signed.get("manifest.json").toString("utf8"));
  if (manifest.version !== version) {
    throw new Error(
      `XPI version must be ${version}, received ${String(manifest.version)}`,
    );
  }
  if (manifest.browser_specific_settings?.gecko?.id !== FIREFOX_ADDON_ID) {
    throw new Error(`XPI add-on ID must be ${FIREFOX_ADDON_ID}`);
  }
  // Mozilla issues the signing certificate to the add-on ID, so a file signed
  // for any other add-on cannot pass for this one.
  if (!signed.get("META-INF/mozilla.rsa").includes(Buffer.from(FIREFOX_ADDON_ID))) {
    throw new Error(`XPI signature is not issued to ${FIREFOX_ADDON_ID}`);
  }

  return {
    sha256: createHash("sha256").update(xpi).digest("hex"),
    files: unsigned.size,
  };
}

function readEntries(bytes, label) {
  let archive;
  try {
    archive = new AdmZip(bytes);
  } catch (error) {
    throw new Error(`${label} is not a readable ZIP archive`, { cause: error });
  }
  const entries = new Map();
  for (const entry of archive.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`${label} contains an unsafe path: ${name}`);
    }
    if (entries.has(name)) {
      throw new Error(`${label} contains ${name} twice`);
    }
    entries.set(name, entry.getData());
  }
  return entries;
}

/** The same JSON value, whatever whitespace or key order spells it. */
function sameJson(left, right) {
  try {
    return canonicalJson(JSON.parse(left.toString("utf8"))) ===
      canonicalJson(JSON.parse(right.toString("utf8")));
  } catch {
    return false;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reads `Name:` and `SHA256-Digest:` pairs from a JAR manifest. */
function jarManifestDigests(bytes) {
  // A JAR manifest wraps long lines by starting the continuation with a space.
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\n /g, "");
  const digests = new Map();
  for (const section of text.split(/\n{2,}/)) {
    const fields = new Map();
    for (const line of section.split("\n")) {
      const separator = line.indexOf(": ");
      if (separator > 0) {
        fields.set(line.slice(0, separator), line.slice(separator + 2).trim());
      }
    }
    const name = fields.get("Name");
    if (name === undefined) continue;
    const digest = fields.get("SHA256-Digest");
    if (!digest) throw new Error(`Signed manifest has no SHA-256 for ${name}`);
    digests.set(name, digest);
  }
  return digests;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [xpiPath, zipPath, version] = process.argv.slice(2);
  if (!xpiPath || !zipPath || !version) {
    console.error(
      "Usage: node tools/verify-signed-firefox.mjs <signed.xpi> <pin-op-firefox-X.Y.Z.zip> <X.Y.Z>",
    );
    process.exit(2);
  }
  try {
    const xpi = await readFile(xpiPath);
    const result = verifySignedFirefox({
      xpi,
      zip: await readFile(zipPath),
      version,
    });
    const releaseName = `pin-op-firefox-${version}.xpi`;
    if (basename(xpiPath) !== releaseName) {
      throw new Error(`Rename the XPI to ${releaseName} before attaching it`);
    }
    const checksum = `${result.sha256}  ${releaseName}\n`;
    await writeFile(`${xpiPath}.sha256`, checksum, "utf8");
    console.log(
      `${releaseName}: Mozilla-signed release build of ${result.files} files`,
    );
    process.stdout.write(checksum);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
