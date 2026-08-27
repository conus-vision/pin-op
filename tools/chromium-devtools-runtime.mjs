import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

export const CHROMIUM_DEVTOOLS_PIN = Object.freeze({
  packageName: "chrome-devtools-frontend",
  version: "1.0.1681091",
  gitHead: "23cccaa78f7458a5aad99c1af98dc1856d2494a3",
  integrity:
    "sha512-cXBay271CnEb+Y+Cxre3mjGDHFKhXVo9mGfNCVAruen/iwF+jnG6Z55mnC7yh078HD1rmKhBM9tKLKQbjVniVQ==",
});

const REVIEWED_FILE_HASHES = Object.freeze({
  "front_end/panels/elements/ElementsTreeOutline.ts":
    "36049536b7e146addc2de9784790d8ae630f28c1640b3b679506d9e4cc7bfd9d",
  "front_end/panels/elements/StylesSidebarPane.ts":
    "575f17e4eee88efa04c627277f9c490233317181c429b535b110001fc1ad8e28",
  LICENSE: "ff11d445fb41a1087c7630e120ab15f1a2cb67c1b707173cb494141805fca35e",
});

const REVIEWED_ENTRYPOINTS = new Set(
  Object.keys(REVIEWED_FILE_HASHES).filter(relativePath => relativePath.endsWith(".ts")),
);

const REVIEWED_INPUT_ATTESTATIONS = Object.freeze({
  "front_end/panels/elements/ElementsTreeOutline.ts": Object.freeze({
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  }),
  "front_end/panels/elements/StylesSidebarPane.ts": Object.freeze({
    fileCount: 1021,
    sha256: "84023be2c6e729cc646f50776644bf88500f1a576605b7744818954fda3fc860",
  }),
});

const REVIEWED_IMAGE_HASHES = Object.freeze({
  "arrow-collapse.svg": "560c000f11f363d016e4f183fe4d2d5db81e814eb4de3ceb0d84c18e673e4b0e",
  "arrow-drop-down-dark.svg": "f11634d22b8d833af0960dc52e628c56cba1029e6fbcc84b3b3b990438e83039",
  "arrow-drop-down-light.svg": "e2825adc9df196ec67e8dd7b6c37494b7b0b03d9eed42b195a0b9c7576582ce7",
  "arrow-drop-down.svg": "3e445565421d0793a77d0cd3a49cb72276a9d40f57654a7d7445c68b4c8f18e6",
  "checker.svg": "72737a4aab8c143dfc925213d109699a3c951feff3aceb62fc95da9eefe5f0a3",
  "cross-circle-filled.svg": "5f1368d7df47300270264c2f75a8c4e1b006491d2ccff95aacfbabde58806cf3",
  "empty.svg": "c56243778feca8d4a078b41a1d504139d4b5f95506b355d3f0d6c85eb6c4e4a6",
  "goto-filled.svg": "d33003aaa6ba863743b2c881d2af713585856b1182a12431873d3b26ac7b9edf",
  "refresh.svg": "35788c9fa85372e560426654c2b27421b55d1b868a7b49cb85ab795da6e5983b",
  "triangle-down.svg": "849ee04c3f54b9167e5e0cb791baca667b3c59efa0ec6f97227b32dea2e1be4b",
  "triangle-right.svg": "be18d57199e26de957ae4fa8c8bf5bca89456e5ecf225075dab4a95f89535e85",
  "triangle-up.svg": "90fb77f6cab8df35681d1db88e078fa8aaac4a9336f17fc6f2aabbc86efc2af5",
  "warning-filled.svg": "4445b327116ab32f274898a876c7bb8e0813d97dfe2eae05adf8ee9b5ac43cb0",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertWithin(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${description} is outside ${root}: ${candidate}`);
  }
  return candidate;
}

async function resolvePackageRoot(repositoryRoot) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const packageLink = path.join(
    physicalRepositoryRoot,
    "node_modules",
    CHROMIUM_DEVTOOLS_PIN.packageName,
  );
  return await realpath(packageLink);
}

export async function verifyChromiumDevToolsPackage(repositoryRoot) {
  const packageRoot = await resolvePackageRoot(repositoryRoot);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (
    manifest.name !== CHROMIUM_DEVTOOLS_PIN.packageName ||
    manifest.version !== CHROMIUM_DEVTOOLS_PIN.version ||
    manifest.license !== "BSD-3-Clause"
  ) {
    throw new Error(
      `Expected ${CHROMIUM_DEVTOOLS_PIN.packageName}@${CHROMIUM_DEVTOOLS_PIN.version} with BSD-3-Clause license`,
    );
  }

  const files = {};
  for (const [relativePath, expectedHash] of Object.entries(REVIEWED_FILE_HASHES)) {
    const absolutePath = assertWithin(
      packageRoot,
      path.resolve(packageRoot, ...relativePath.split("/")),
      "Reviewed Chromium DevTools file",
    );
    const actualHash = sha256(await readFile(absolutePath));
    if (actualHash !== expectedHash) {
      throw new Error(
        `Chromium DevTools file hash mismatch for ${relativePath}: ${actualHash}`,
      );
    }
    files[relativePath] = actualHash;
  }

  for (const [imageName, expectedHash] of Object.entries(REVIEWED_IMAGE_HASHES)) {
    const relativePath = `front_end/Images/src/${imageName}`;
    const absolutePath = assertWithin(
      packageRoot,
      path.join(packageRoot, ...relativePath.split("/")),
      "Reviewed Chromium image",
    );
    const actualHash = sha256(await readFile(absolutePath));
    if (actualHash !== expectedHash) {
      throw new Error(`Chromium DevTools image hash mismatch for ${imageName}: ${actualHash}`);
    }
    files[relativePath] = actualHash;
  }

  return Object.freeze({
    packageRoot,
    version: manifest.version,
    gitHead: CHROMIUM_DEVTOOLS_PIN.gitHead,
    files: Object.freeze(files),
  });
}

function createChromiumCssModulePlugin(packageRoot) {
  const frontEndRoot = path.join(packageRoot, "front_end");
  return {
    name: "chromium-devtools-css-module",
    setup(buildContext) {
      buildContext.onResolve({ filter: /\.css\.js$/ }, async args => {
        const cssPath = path.resolve(args.resolveDir, args.path.slice(0, -3));
        const physicalCssPath = await realpath(cssPath);
        assertWithin(frontEndRoot, physicalCssPath, "Chromium CSS module");
        return { path: physicalCssPath, namespace: "chromium-css-module" };
      });
      buildContext.onLoad(
        { filter: /\.css$/, namespace: "chromium-css-module" },
        async args => {
          const css = await readFile(args.path, "utf8");
          return {
            contents: `export default ${JSON.stringify(css)};\n`,
            loader: "js",
            resolveDir: path.dirname(args.path),
          };
        },
      );
    },
  };
}

function createChromiumGeneratedModulePlugin(packageRoot) {
  const frontEndRoot = path.join(packageRoot, "front_end");
  return {
    name: "chromium-devtools-generated-modules",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/locales\.js$/ }, args => {
        const importer = path.resolve(args.importer);
        const expectedImporter = path.join(frontEndRoot, "core", "i18n", "i18nImpl.ts");
        if (importer !== expectedImporter) {
          return undefined;
        }
        return { path: "english-only-locales", namespace: "chromium-generated" };
      });
      buildContext.onResolve({ filter: /\.skill\.js$/ }, args => {
        assertWithin(frontEndRoot, path.resolve(args.resolveDir), "Chromium generated skill importer");
        return { path: args.path, namespace: "chromium-generated-skill" };
      });
      buildContext.onResolve({ filter: /Images\/Images\.js$/ }, args => {
        const generatedPath = path.resolve(args.resolveDir, args.path);
        const expectedPath = path.join(frontEndRoot, "Images", "Images.js");
        if (generatedPath !== expectedPath) {
          return undefined;
        }
        return { path: expectedPath, namespace: "chromium-generated-images" };
      });
      buildContext.onLoad(
        { filter: /^english-only-locales$/, namespace: "chromium-generated" },
        () => ({
          contents:
            "export const LOCALES = ['en-US'];\n" +
            "export const BUNDLED_LOCALES = ['en-US'];\n" +
            "export const DEFAULT_LOCALE = 'en-US';\n" +
            "export const REMOTE_FETCH_PATTERN = '';\n" +
            "export const LOCAL_FETCH_PATTERN = './locales/@LOCALE@.json';\n",
          loader: "js",
        }),
      );
      buildContext.onLoad(
        { filter: /.*/, namespace: "chromium-generated-skill" },
        args => {
          const name = path.basename(args.path, ".skill.js");
          return {
            contents:
              "export const skill = Object.freeze({\n" +
              `  name: ${JSON.stringify(name)},\n` +
              "  description: '',\n" +
              "  allowedTools: Object.freeze([]),\n" +
              "  instructions: '',\n" +
              "});\n",
            loader: "js",
          };
        },
      );
      buildContext.onLoad(
        { filter: /Images\.js$/, namespace: "chromium-generated-images" },
        async () => {
          const imageRoot = path.join(frontEndRoot, "Images", "src");
          const availableImages = new Set(await readdir(imageRoot));
          const imageNames = Object.keys(REVIEWED_IMAGE_HASHES);
          if (!imageNames.every(name => availableImages.has(name))) {
            throw new Error("Reviewed Chromium image set is incomplete");
          }
          const imagePaths = imageNames.map(name => path.join(imageRoot, name));
          const declarations = await Promise.all(imagePaths.map(async (imagePath, index) => {
            const name = imageNames[index].slice(0, -4);
            const data = (await readFile(imagePath)).toString("base64");
            const url = `url(\"data:image/svg+xml;base64,${data}\")`;
            return `style.setProperty(${JSON.stringify(`--image-file-${name}`)}, ${JSON.stringify(url)});`;
          }));
          return {
            contents:
              "const root = document.documentElement.style;\n" +
              `${declarations.map(declaration => declaration.replaceAll("style.", "root.")).join("\n")}\n`,
            loader: "js",
            watchFiles: imagePaths,
          };
        },
      );
    },
  };
}

function createChromiumBrowserRuntimePlugin(packageRoot) {
  const platformRoot = path.join(packageRoot, "front_end", "core", "platform");
  const hostRuntimePath = path.join(platformRoot, "HostRuntime.ts");
  const browserRuntimePath = path.join(platformRoot, "browser", "browser.ts");
  return {
    name: "chromium-devtools-browser-runtime",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/node\/node\.js$/ }, args => {
        if (path.resolve(args.importer) !== hostRuntimePath) {
          return undefined;
        }
        return { path: browserRuntimePath };
      });
    },
  };
}

async function attestChromiumInputs(repositoryRoot, packageRoot, metafile) {
  const inputHashes = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    let inputPath;
    if (input.startsWith("chromium-css-module:")) {
      inputPath = input.slice("chromium-css-module:".length);
    } else if (input.startsWith("chromium-")) {
      continue;
    } else {
      inputPath = path.resolve(repositoryRoot, input);
    }

    const physicalInputPath = await realpath(inputPath);
    const relativePath = assertWithin(
      packageRoot,
      physicalInputPath,
      "Chromium DevTools bundle input",
    ).slice(packageRoot.length + 1).replaceAll(path.sep, "/");
    if (!inputHashes.has(relativePath)) {
      inputHashes.set(relativePath, sha256(await readFile(physicalInputPath)));
    }
  }

  const rows = [...inputHashes]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relativePath, hash]) => `${relativePath}\0${hash}`);
  return Object.freeze({
    fileCount: rows.length,
    sha256: sha256(`${rows.join("\n")}\n`),
  });
}

export async function bundleChromiumDevToolsModule({
  repositoryRoot,
  entryPoint,
  write = false,
  outfile,
}) {
  if (typeof entryPoint !== "string" || !/^front_end\/[A-Za-z0-9_./-]+\.ts$/.test(entryPoint)) {
    throw new Error(`Invalid Chromium DevTools entry point: ${entryPoint}`);
  }
  if (!REVIEWED_ENTRYPOINTS.has(entryPoint)) {
    throw new Error(`Not a reviewed Chromium DevTools entry point: ${entryPoint}`);
  }
  const verified = await verifyChromiumDevToolsPackage(repositoryRoot);
  const entryAbsolute = await realpath(assertWithin(
    verified.packageRoot,
    path.resolve(verified.packageRoot, ...entryPoint.split("/")),
    "Chromium DevTools entry point",
  ));
  assertWithin(verified.packageRoot, entryAbsolute, "Chromium DevTools entry point");

  const result = await build({
    absWorkingDir: path.resolve(repositoryRoot),
    entryPoints: [entryAbsolute],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome116", "firefox115"],
    treeShaking: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    write,
    outfile: outfile ?? path.join(path.resolve(repositoryRoot), "chromium-devtools-runtime.js"),
    logLevel: "silent",
    plugins: [
      createChromiumBrowserRuntimePlugin(verified.packageRoot),
      createChromiumCssModulePlugin(verified.packageRoot),
      createChromiumGeneratedModulePlugin(verified.packageRoot),
    ],
  });
  const chromiumInputAttestation = await attestChromiumInputs(
    path.resolve(repositoryRoot),
    verified.packageRoot,
    result.metafile,
  );
  const expectedAttestation = REVIEWED_INPUT_ATTESTATIONS[entryPoint];
  if (
    chromiumInputAttestation.fileCount !== expectedAttestation.fileCount ||
    chromiumInputAttestation.sha256 !== expectedAttestation.sha256
  ) {
    throw new Error(
      `Chromium DevTools input closure mismatch for ${entryPoint}: ` +
      `${chromiumInputAttestation.fileCount} files, ${chromiumInputAttestation.sha256}`,
    );
  }
  return Object.assign(result, { chromiumInputAttestation });
}
