import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PROTOCOL_VERSION } from "@pin-op/protocol";
import {
  RUNTIME_METADATA_FILENAME,
  serializeRuntimeMetadata,
} from "../../tools/runtime-metadata.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const distDirectory = resolve(extensionRoot, "dist");
const require = createRequire(import.meta.url);
const sourceMapRoot = dirname(require.resolve("source-map/package.json"));
const builtinImports = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

await mkdir(distDirectory, { recursive: true });

const [extensionBuild] = await Promise.all([
  build({
    absWorkingDir: extensionRoot,
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    define: {
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
    },
    outfile: "dist/extension.cjs",
    sourcemap: true,
    metafile: true,
  }),
  build({
    absWorkingDir: extensionRoot,
    entryPoints: ["test/integration/sourcePluginApi.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    outfile: "dist/test/integration/sourcePluginApi.test.cjs",
    sourcemap: true,
  }),
]);

assertRuntimeExternals(extensionBuild.metafile);
await Promise.all([
  copyFile(
    resolve(sourceMapRoot, "lib/mappings.wasm"),
    resolve(distDirectory, "mappings.wasm"),
  ),
  writeFile(
    resolve(distDirectory, "extension-meta.json"),
    `${JSON.stringify(extensionBuild.metafile, null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(distDirectory, RUNTIME_METADATA_FILENAME),
    serializeRuntimeMetadata(PROTOCOL_VERSION),
    "utf8",
  ),
  writeThirdPartyNotices(extensionBuild.metafile),
]);

function assertRuntimeExternals(metafile) {
  const externalImports = [
    ...new Set(
      Object.values(metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((entry) => entry.external)
        .map((entry) => entry.path),
    ),
  ];
  const unsupported = externalImports
    .filter((name) => name !== "vscode" && !builtinImports.has(name))
    .sort(compareAscii);

  if (unsupported.length > 0) {
    throw new Error(
      `VS Code bundle has external runtime packages: ${unsupported.join(", ")}`,
    );
  }
}

async function writeThirdPartyNotices(metafile) {
  const packages = await bundledPackages(metafile);
  const sourceMap = packages.find((entry) => entry.name === "source-map");
  if (!sourceMap) {
    throw new Error("source-map must be bundled with the VS Code extension");
  }

  const sections = packages.map((entry) => [
    `## ${entry.name}@${entry.version}`,
    `Declared license: ${entry.license}`,
    `License file: ${entry.licenseFile}`,
    "",
    entry.licenseText,
  ].join("\n"));
  const notices = [
    "# Third-Party Notices",
    "",
    "PinOp includes the following bundled third-party software.",
    `Runtime asset: dist/mappings.wasm (from source-map@${sourceMap.version})`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");

  await writeFile(
    resolve(extensionRoot, "THIRD_PARTY_NOTICES"),
    notices,
    "utf8",
  );
}

async function bundledPackages(metafile) {
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRootFromMetafilePath(input);
    if (root) roots.set(root, root);
  }

  const packages = await Promise.all([...roots.values()].map(readPackageNotice));
  const unique = new Map();
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    const existing = unique.get(key);
    if (existing && existing.licenseText !== entry.licenseText) {
      throw new Error(`Conflicting license texts found for ${key}`);
    }
    unique.set(key, entry);
  }

  return [...unique.values()].sort((left, right) =>
    compareAscii(left.name, right.name) ||
    compareAscii(left.version, right.version)
  );
}

function packageRootFromMetafilePath(input) {
  const normalized = input.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const packagePath = normalized.slice(markerIndex + marker.length).split("/");
  const packageSegments = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2)
    : packagePath.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((part) => !part)) {
    throw new Error(`Cannot identify package root for esbuild input: ${input}`);
  }

  return resolve(
    extensionRoot,
    normalized.slice(0, markerIndex + marker.length),
    ...packageSegments,
  );
}

async function readPackageNotice(root) {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    typeof manifest.license !== "string"
  ) {
    throw new Error(`Invalid package notice metadata in ${manifestPath}`);
  }

  const licenseFile = await findLicenseFile(root);
  if (!licenseFile) {
    throw new Error(
      `Bundled package ${manifest.name}@${manifest.version} has no license file`,
    );
  }
  const licenseText = normalizeText(
    await readFile(resolve(root, licenseFile), "utf8"),
  );
  if (!licenseText) {
    throw new Error(
      `Bundled package ${manifest.name}@${manifest.version} has an empty license`,
    );
  }

  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    licenseFile,
    licenseText,
  };
}

async function findLicenseFile(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) =>
      entry.isFile() &&
      /^(?:license|licence|copying)(?:[._-].*)?$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftExact = /^licen[cs]e$/i.test(left) ? 0 : 1;
      const rightExact = /^licen[cs]e$/i.test(right) ? 0 : 1;
      return leftExact - rightExact || compareAscii(left, right);
    })[0];
}

function normalizeText(text) {
  return text.replaceAll("\r\n", "\n").trim();
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
