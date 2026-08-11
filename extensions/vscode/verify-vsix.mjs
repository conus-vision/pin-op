import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeMetadata } from "../../tools/runtime-metadata.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const artifactPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : undefined;
if (!artifactPath) {
  throw new Error("Usage: node verify-vsix.mjs <path-to-vsix>");
}

const require = createRequire(import.meta.url);
const vsceRequire = createRequire(require.resolve("@vscode/vsce/package.json"));
const yauzl = vsceRequire("yauzl");
const entries = await readZip(artifactPath);
const paths = [...entries.keys()].sort(compareAscii);
const requiredPaths = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES",
  "extension/dist/extension.cjs",
  "extension/dist/mappings.wasm",
  "extension/dist/runtime-metadata.json",
  "extension/package.json",
  "extension/readme.md",
  "extension/resources/browser2ide.svg",
];
const forbiddenPath =
  /(?:^|\/)(?:node_modules|src|test)(?:\/|$)|\.vscode-test|\.map$/;

for (const path of requiredPaths) {
  if (!entries.has(path)) throw new Error(`VSIX is missing ${path}`);
}
for (const path of paths) {
  if (forbiddenPath.test(path)) {
    throw new Error(`VSIX contains forbidden path ${path}`);
  }
}

const manifest = JSON.parse(
  entries.get("extension/package.json").toString("utf8"),
);
if (manifest.main !== "./dist/extension.cjs") {
  throw new Error(`VSIX manifest has unexpected main: ${manifest.main}`);
}
parseRuntimeMetadata(entries.get("extension/dist/runtime-metadata.json"), {
  expectedProtocolVersion: 5,
  label: "VSIX runtime metadata",
});

const bundle = entries.get("extension/dist/extension.cjs").toString("utf8");
if (!bundle.includes("source-navigation")) {
  throw new Error("VSIX bundle is missing current source-navigation capability");
}
for (const type of ["source.navigate", "source.navigationState"]) {
  if (!bundle.includes(type)) {
    throw new Error(`VSIX bundle is missing current ${type} message`);
  }
}
const runtimeRequires = [
  ...bundle.matchAll(/\brequire\((["'])([^"'./][^"']*)\1\)/g),
].map((match) => match[2]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const unsupported = [...new Set(runtimeRequires)]
  .filter((name) => name !== "vscode" && !builtins.has(name))
  .sort(compareAscii);
if (unsupported.length > 0) {
  throw new Error(
    `VSIX bundle has external runtime packages: ${unsupported.join(", ")}`,
  );
}
if (!runtimeRequires.includes("vscode")) {
  throw new Error("VSIX bundle does not declare the vscode runtime external");
}

const sourceWasm = await readFile(
  resolve(extensionRoot, "node_modules/source-map/lib/mappings.wasm"),
);
if (!entries.get("extension/dist/mappings.wasm").equals(sourceWasm)) {
  throw new Error("VSIX mappings.wasm differs from the source-map runtime asset");
}
const sourceNotices = await readFile(
  resolve(extensionRoot, "THIRD_PARTY_NOTICES"),
);
if (!entries.get("extension/THIRD_PARTY_NOTICES").equals(sourceNotices)) {
  throw new Error("VSIX third-party notices differ from the generated notices");
}

console.log("Verified VSIX entries:");
for (const path of paths) console.log(path);
console.log("External package requires: vscode");

function readZip(path) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const files = new Map();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            if (files.has(entry.fileName)) {
              reject(new Error(`VSIX contains duplicate path ${entry.fileName}`));
              return;
            }
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolvePromise(files));
      zip.readEntry();
    });
  });
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
