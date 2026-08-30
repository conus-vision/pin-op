import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";
import postcss from "postcss";
import ts from "typescript";

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
  "errorWave.svg": "fd5dc2adee295375b0e96df8c7adf96be0ee6169155306f636786ae633f9f640",
  "filter.svg": "fb827ba04c06cb587cf0f76adece7488274ee4048b29b6cb6c17b02fda1a6a4a",
  "goto-filled.svg": "d33003aaa6ba863743b2c881d2af713585856b1182a12431873d3b26ac7b9edf",
  "open-externally.svg": "5fcb85adf49ec2ab8ee9961c9dad144e7368132051a86fd1fbcf22845fff724d",
  "refresh.svg": "35788c9fa85372e560426654c2b27421b55d1b868a7b49cb85ab795da6e5983b",
  "triangle-down.svg": "849ee04c3f54b9167e5e0cb791baca667b3c59efa0ec6f97227b32dea2e1be4b",
  "triangle-right.svg": "be18d57199e26de957ae4fa8c8bf5bca89456e5ecf225075dab4a95f89535e85",
  "triangle-up.svg": "90fb77f6cab8df35681d1db88e078fa8aaac4a9336f17fc6f2aabbc86efc2af5",
  "warning-filled.svg": "4445b327116ab32f274898a876c7bb8e0813d97dfe2eae05adf8ee9b5ac43cb0",
});

export const CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME = Object.freeze({
  schemaVersion: 1,
  packageVersion: CHROMIUM_DEVTOOLS_PIN.version,
  overlayRoot: `third_party/chromium-devtools-frontend/patches/${CHROMIUM_DEVTOOLS_PIN.version}`,
  maxUnminifiedBytes: 1280 * 1024,
  browserTargets: Object.freeze(["chrome116", "firefox142"]),
  manifestSha256: "6b59e990946b8a4851e1c540b79c63d2dd050150d6e47721d9703cd8c1609e5f",
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

function normalizeRelativePath(value) {
  return value.replaceAll(path.sep, "/");
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files;
}

function assertHashInventory(actual, reviewed, description) {
  const actualKeys = Object.keys(actual).sort();
  const reviewedKeys = Object.keys(reviewed).sort();
  if (
    actualKeys.length !== reviewedKeys.length ||
    actualKeys.some((value, index) => value !== reviewedKeys[index])
  ) {
    throw new Error(`${description} inventory mismatch`);
  }
  for (const relativePath of actualKeys) {
    if (actual[relativePath] !== reviewed[relativePath]) {
      throw new Error(`${description} hash mismatch for ${relativePath}: ${actual[relativePath]}`);
    }
  }
}

function sourceMemberName(node) {
  if (!(
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isParameter(node) ||
    ts.isImportSpecifier(node)
  )) {
    return null;
  }
  const name = node?.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

export function applyChromiumReadOnlySourceTransform(source, transform, relativePath) {
  const removedMembers = new Set(transform?.removeMembers ?? []);
  if (removedMembers.size === 0) {
    throw new Error(`Chromium read-only source transform removes no members: ${relativePath}`);
  }
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const removedDeclarations = new Set();
  const containsRemovedThisMember = node => {
    let found = false;
    const visit = current => {
      if (found) return;
      if (ts.isPropertyAccessExpression(current) &&
          current.expression.kind === ts.SyntaxKind.ThisKeyword &&
          removedMembers.has(current.name.text)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };
  const transformer = context => {
    let classDepth = 0;
    const isRemovedThisAccess = node => ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword && removedMembers.has(node.name.text);
    const isRemovedThisCall = node => ts.isCallExpression(node) && (
      isRemovedThisAccess(node.expression) ||
      (ts.isPropertyAccessExpression(node.expression) &&
       ["bind", "call", "apply"].includes(node.expression.name.text) &&
       isRemovedThisAccess(node.expression.expression))
    );
    const visit = node => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        classDepth++;
        const updated = ts.visitEachChild(node, visit, context);
        classDepth--;
        return updated;
      }
      const memberName = sourceMemberName(node);
      if (classDepth > 0 && ts.isParameter(node) && memberName && removedMembers.has(memberName)) {
        removedDeclarations.add(memberName);
        return ts.factory.updateParameterDeclaration(
          node, node.modifiers, node.dotDotDotToken,
          ts.factory.createIdentifier("__pinOpReadOnlyParameter"),
          node.questionToken, node.type, node.initializer,
        );
      }
      if (classDepth > 0 && memberName && removedMembers.has(memberName) && !ts.isParameter(node) &&
          !ts.isImportSpecifier(node) && !ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
        removedDeclarations.add(memberName);
        return undefined;
      }
      // Remove only exact wiring statements. Never rewrite a property merely
      // because it has the same spelling: classList.remove and lifecycle
      // remove() calls are part of the upstream rendering behaviour.
      if (classDepth > 0 && ts.isExpressionStatement(node) && (
        (ts.isBinaryExpression(node.expression) && isRemovedThisAccess(node.expression.left)) ||
        isRemovedThisCall(node.expression) ||
        (ts.isCallExpression(node.expression) && node.expression.arguments.some(isRemovedThisCall))
      )) {
        return undefined;
      }
      if (classDepth > 0 && ts.isIfStatement(node) && (
        containsRemovedThisMember(node.expression) || /\.moveTo\s*\(/.test(node.getText(sourceFile))
      )) return undefined;
      if (classDepth > 0 && ts.isPropertyAssignment(node) && containsRemovedThisMember(node.initializer)) {
        return ts.factory.updatePropertyAssignment(
          node, node.name,
          ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, ts.factory.createBlock([])),
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  };
  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    const missingDeclarations = [...removedMembers].filter(name => !removedDeclarations.has(name));
    if (missingDeclarations.length > 0) {
      throw new Error(
        `Chromium read-only source transform did not match ${relativePath}: ${missingDeclarations.join(", ")}`,
      );
    }
    const printed = ts.createPrinter({newLine: ts.NewLineKind.LineFeed}).printFile(transformed.transformed[0]);
    const printedSource = ts.createSourceFile(
      relativePath,
      printed,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const retainedDeclarations = new Set();
    let inspectClassDepth = 0;
    const inspect = node => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        inspectClassDepth++;
        ts.forEachChild(node, inspect);
        inspectClassDepth--;
        return;
      }
      const name = sourceMemberName(node);
      if (inspectClassDepth > 0 && name && removedMembers.has(name) && !ts.isParameter(node) && !ts.isImportSpecifier(node) &&
          !ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
        retainedDeclarations.add(name);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(printedSource);
    if (retainedDeclarations.size > 0) {
      throw new Error(
        `Chromium read-only source transform retained declarations in ${relativePath}: ${[...retainedDeclarations].sort().join(", ")}`,
      );
    }
    return printed;
  } finally {
    transformed.dispose();
  }
}

export async function verifyChromiumReadOnlyElementsOverlay(repositoryRoot) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const verifiedPackage = await verifyChromiumDevToolsPackage(physicalRepositoryRoot);
  const overlayRoot = assertWithin(
    physicalRepositoryRoot,
    path.resolve(physicalRepositoryRoot, ...CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.overlayRoot.split("/")),
    "Chromium read-only overlay",
  );
  const manifestPath = path.join(overlayRoot, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.manifestSha256) {
    throw new Error("Chromium read-only overlay manifest hash mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.schemaVersion ||
    manifest.package?.name !== CHROMIUM_DEVTOOLS_PIN.packageName ||
    manifest.package?.version !== CHROMIUM_DEVTOOLS_PIN.version ||
    manifest.package?.gitHead !== CHROMIUM_DEVTOOLS_PIN.gitHead ||
    manifest.maxUnminifiedBytes !== CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.maxUnminifiedBytes ||
    !Array.isArray(manifest.browserTargets) ||
    manifest.browserTargets.length !== CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.browserTargets.length ||
    manifest.browserTargets.some(
      (target, index) => target !== CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.browserTargets[index]
    )
  ) {
    throw new Error("Chromium read-only overlay manifest does not match the pinned runtime");
  }
  assertHashInventory(
    manifest.requiredImageFiles,
    Object.fromEntries(Object.entries(REVIEWED_IMAGE_HASHES).map(([name, digest]) => [
      `front_end/Images/src/${name}`,
      digest,
    ])),
    "Chromium read-only shared image",
  );
  if (
    !Array.isArray(manifest.reviewedSharedInputInventory) ||
    !manifest.reviewedSharedInputInventory.every(input =>
      /^chromium-shared-(?:css|generated|images):[A-Za-z0-9_./-]+$/.test(input)) ||
    !Number.isSafeInteger(manifest.reviewedSharedPayloadAttestation?.fileCount) ||
    !/^[0-9a-f]{64}$/.test(manifest.reviewedSharedPayloadAttestation?.sha256 ?? "")
  ) {
    throw new Error("Chromium read-only shared payload metadata mismatch");
  }
  if (
    typeof manifest.entryPoint !== "string" ||
    !/^entrypoints\/[A-Za-z0-9_./-]+\.ts$/.test(manifest.entryPoint)
  ) {
    throw new Error("Chromium read-only overlay has an invalid entry point");
  }
  if (
    typeof manifest.testOnlyEntryPoint !== "string" ||
    !/^entrypoints\/[A-Za-z0-9_./-]+\.ts$/.test(manifest.testOnlyEntryPoint) ||
    manifest.testOnlyEntryPoint === manifest.entryPoint
  ) {
    throw new Error("Chromium read-only overlay has an invalid test-only entry point");
  }

  const overlayFiles = {};
  for (const absolute of await listFiles(overlayRoot)) {
    const relative = normalizeRelativePath(path.relative(overlayRoot, absolute));
    if (relative !== "manifest.json") {
      overlayFiles[relative] = sha256(await readFile(absolute));
    }
  }
  assertHashInventory(overlayFiles, manifest.overlayFiles, "Chromium read-only overlay file");
  if (overlayFiles[manifest.testOnlyEntryPoint] === undefined) {
    throw new Error("Chromium read-only test-only entry point is not reviewed");
  }

  const upstreamFiles = {};
  for (const relativePath of Object.keys(manifest.upstreamFiles ?? {})) {
    if (!/^front_end\/[A-Za-z0-9_./-]+\.ts$/.test(relativePath)) {
      throw new Error(`Invalid Chromium read-only upstream path: ${relativePath}`);
    }
    const absolute = assertWithin(
      verifiedPackage.packageRoot,
      path.resolve(verifiedPackage.packageRoot, ...relativePath.split("/")),
      "Chromium read-only upstream file",
    );
    upstreamFiles[relativePath] = sha256(await readFile(absolute));
  }
  assertHashInventory(upstreamFiles, manifest.upstreamFiles, "Chromium read-only upstream file");

  const sourceTransforms = new Map();
  for (const [relativePath, transform] of Object.entries(manifest.sourceTransforms ?? {})) {
    if (upstreamFiles[relativePath] === undefined) {
      throw new Error(`Chromium read-only source transform is not hash-pinned: ${relativePath}`);
    }
    if (
      transform?.sourceSha256 !== upstreamFiles[relativePath] ||
      typeof transform?.transformedSha256 !== "string" ||
      !Array.isArray(transform?.removeMembers) ||
      transform.removeMembers.length === 0 ||
      new Set(transform.removeMembers).size !== transform.removeMembers.length ||
      transform.removeMembers.some(name => !/^#?[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
    ) {
      throw new Error(`Chromium read-only source transform is invalid: ${relativePath}`);
    }
    const absolutePath = path.resolve(verifiedPackage.packageRoot, ...relativePath.split("/"));
    const transformedSource = applyChromiumReadOnlySourceTransform(
      await readFile(absolutePath, "utf8"),
      transform,
      relativePath,
    );
    const transformedSha256 = sha256(transformedSource);
    if (transformedSha256 !== transform.transformedSha256) {
      throw new Error(
        `Chromium read-only transformed source hash mismatch for ${relativePath}: ${transformedSha256}`,
      );
    }
    sourceTransforms.set(relativePath, Object.freeze({...transform, absolutePath, transformedSource}));
  }
  if (sourceTransforms.size !== 3) {
    throw new Error("Chromium read-only overlay must transform exactly the reviewed DOM tree sources");
  }

  if (!Array.isArray(manifest.resolutions) || manifest.resolutions.length === 0) {
    throw new Error("Chromium read-only overlay must declare exact resolutions");
  }
  const resolutions = new Map();
  for (const resolution of manifest.resolutions) {
    if (
      !/^front_end\/[A-Za-z0-9_./-]+\.ts$/.test(resolution?.importer ?? "") ||
      !/^\.\.?\/[A-Za-z0-9_./-]+\.js$/.test(resolution?.specifier ?? "") ||
      !/^facades\/[A-Za-z0-9_./-]+\.ts$/.test(resolution?.facade ?? "")
    ) {
      throw new Error("Chromium read-only overlay resolution must name an exact importer, specifier, and facade");
    }
    const key = `${resolution.importer}\0${resolution.specifier}`;
    if (resolutions.has(key)) {
      throw new Error(`Duplicate Chromium read-only overlay resolution: ${resolution.importer} ${resolution.specifier}`);
    }
    if (upstreamFiles[resolution.importer] === undefined) {
      throw new Error(`Chromium read-only overlay importer is not hash-pinned: ${resolution.importer}`);
    }
    const importer = assertWithin(
      verifiedPackage.packageRoot,
      path.resolve(verifiedPackage.packageRoot, ...resolution.importer.split("/")),
      "Chromium read-only overlay importer",
    );
    const source = await readFile(importer, "utf8");
    if (!source.includes(`'${resolution.specifier}'`) && !source.includes(`"${resolution.specifier}"`)) {
      throw new Error(`Chromium read-only overlay specifier is absent from ${resolution.importer}: ${resolution.specifier}`);
    }
    const facade = assertWithin(
      overlayRoot,
      path.resolve(overlayRoot, ...resolution.facade.split("/")),
      "Chromium read-only facade",
    );
    if (overlayFiles[resolution.facade] === undefined) {
      throw new Error(`Chromium read-only facade is not reviewed: ${resolution.facade}`);
    }
    resolutions.set(key, facade);
  }

  const entryPoint = assertWithin(
    overlayRoot,
    path.resolve(overlayRoot, ...manifest.entryPoint.split("/")),
    "Chromium read-only entry point",
  );
  const verifiedOverlay = Object.freeze({
    overlayRoot,
    entryPoint,
    manifest: Object.freeze(manifest),
    resolutions,
    sourceTransforms,
    overlayFiles: Object.freeze(overlayFiles),
    upstreamFiles: Object.freeze(upstreamFiles),
    packageRoot: verifiedPackage.packageRoot,
  });
  CHROMIUM_READ_ONLY_OVERLAY_AUTHORITIES.add(verifiedOverlay);
  return verifiedOverlay;
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

const CHROMIUM_SHARED_NAMESPACES = Object.freeze({
  css: "chromium-shared-css",
  generated: "chromium-shared-generated",
  images: "chromium-shared-images",
});
const CHROMIUM_SHARED_RUNTIME_BRANDS = new WeakMap();
const CHROMIUM_READ_ONLY_OVERLAY_AUTHORITIES = new WeakSet();
const CHROMIUM_ENGLISH_LOCALES_PAYLOAD =
  "export const LOCALES = ['en-US'];\n" +
  "export const BUNDLED_LOCALES = ['en-US'];\n" +
  "export const DEFAULT_LOCALE = 'en-US';\n" +
  "export const REMOTE_FETCH_PATTERN = '';\n" +
  "export const LOCAL_FETCH_PATTERN = './locales/@LOCALE@.json';\n";

export async function createChromiumSharedRuntimePlugins({packageRoot, allowedImporters}) {
  if (!(allowedImporters instanceof Set) || !Object.isFrozen(allowedImporters)) {
    throw new Error("Chromium shared allowedImporters must be a frozen Set");
  }
  const importerSnapshot = [...allowedImporters];
  const physicalPackageRoot = await realpath(packageRoot);
  const reviewedImporters = new Set();
  for (const importer of importerSnapshot) {
    if (typeof importer !== "string" || !path.isAbsolute(importer)) {
      throw new Error("Chromium shared reviewed importer must be an absolute real path");
    }
    let physicalImporter;
    try {
      physicalImporter = await realpath(importer);
    } catch {
      throw new Error(`Chromium shared reviewed importer does not exist: ${importer}`);
    }
    if (path.resolve(importer) !== physicalImporter) {
      throw new Error(`Chromium shared reviewed importer is not a real path: ${importer}`);
    }
    if (reviewedImporters.has(physicalImporter)) {
      throw new Error(`Chromium shared reviewed importer collision: ${physicalImporter}`);
    }
    reviewedImporters.add(physicalImporter);
  }
  const imagePayload = await createChromiumImagesPayload(physicalPackageRoot);
  const allowImporter = importer => reviewedImporters.has(path.resolve(importer));
  const resolvedCssInputs = new Map();
  const cssPhysicalPaths = new Map();
  const loadedCssPayloads = new Map();
  const resolvedGeneratedInputs = new Set();
  // The module path a bundle records must name the package, not the checkout:
  // an absolute path would put this machine's directories in the output and
  // make the same sources measure differently on another one.
  const resolveCssInput = async ({cssPath, importer}) => {
    if (!allowImporter(path.resolve(importer))) return undefined;
    const physicalCssPath = await realpath(cssPath);
    assertWithin(
      path.join(physicalPackageRoot, "front_end"),
      physicalCssPath,
      "Chromium shared CSS module",
    );
    const packagePath = normalizeRelativePath(
      path.relative(physicalPackageRoot, physicalCssPath),
    );
    resolvedCssInputs.set(packagePath, `${CHROMIUM_SHARED_NAMESPACES.css}:${packagePath}`);
    cssPhysicalPaths.set(packagePath, physicalCssPath);
    return {path: packagePath, namespace: CHROMIUM_SHARED_NAMESPACES.css};
  };
  const imagesModulePath = path.join(physicalPackageRoot, "front_end", "Images", "Images.js");
  const resolveImagesInput = ({importer}) => {
    if (!allowImporter(path.resolve(importer))) return undefined;
    resolvedGeneratedInputs.add(CHROMIUM_IMAGES_PACKAGE_PATH);
    return {path: CHROMIUM_IMAGES_PACKAGE_PATH, namespace: CHROMIUM_SHARED_NAMESPACES.images};
  };
  const plugins = Object.freeze([
    createChromiumCssModulePlugin(
      physicalPackageRoot,
      resolveCssInput,
      cssPhysicalPaths,
      loadedCssPayloads,
    ),
    createChromiumGeneratedModulePlugin(
      physicalPackageRoot,
      allowImporter,
      resolveImagesInput,
      resolvedGeneratedInputs,
      imagePayload,
    ),
    createChromiumBrowserRuntimePlugin(physicalPackageRoot, allowImporter),
  ].map(plugin => Object.freeze(plugin)));
  const verifyInputs = inputKeys => {
    if (!Array.isArray(inputKeys)) {
      throw new Error("Chromium shared input inventory must be an array");
    }
    const generatedInputs = [];
    const inputInventory = [];
    const payloadRows = [];
    for (const input of inputKeys) {
      if (input.startsWith(`${CHROMIUM_SHARED_NAMESPACES.css}:`)) {
        const cssPath = input.slice(CHROMIUM_SHARED_NAMESPACES.css.length + 1);
        if (path.isAbsolute(cssPath) || !cssPath.endsWith(".css")) {
          throw new Error(`Invalid Chromium shared CSS input: ${input}`);
        }
        const physicalCssPath = cssPhysicalPaths.get(cssPath);
        if (physicalCssPath !== undefined) {
          assertWithin(physicalPackageRoot, physicalCssPath, "Chromium shared CSS input");
        }
        const canonicalInput = resolvedCssInputs.get(cssPath);
        const payload = loadedCssPayloads.get(cssPath);
        if (!canonicalInput || payload === undefined) {
          throw new Error(`Unregistered Chromium shared CSS input: ${input}`);
        }
        inputInventory.push(canonicalInput);
        payloadRows.push(`${canonicalInput}\0${sha256(payload)}`);
      } else if (input === `${CHROMIUM_SHARED_NAMESPACES.generated}:english-only-locales`) {
        const canonicalInput = `${CHROMIUM_SHARED_NAMESPACES.generated}:english-only-locales`;
        generatedInputs.push(canonicalInput);
        inputInventory.push(canonicalInput);
        payloadRows.push(`${canonicalInput}\0${sha256(CHROMIUM_ENGLISH_LOCALES_PAYLOAD)}`);
      } else if (input === `${CHROMIUM_SHARED_NAMESPACES.images}:${CHROMIUM_IMAGES_PACKAGE_PATH}`) {
        const canonicalInput = `${CHROMIUM_SHARED_NAMESPACES.images}:front_end/Images/Images.js`;
        generatedInputs.push(canonicalInput);
        inputInventory.push(canonicalInput);
        payloadRows.push(`${canonicalInput}\0${sha256(imagePayload.contents)}`);
      } else {
        throw new Error(`Unreviewed Chromium shared input: ${input}`);
      }
    }
    payloadRows.sort();
    return Object.freeze({
      generatedInputs: Object.freeze(generatedInputs.sort()),
      inputInventory: Object.freeze(inputInventory.sort()),
      payloadAttestation: Object.freeze({
        fileCount: payloadRows.length,
        sha256: sha256(`${payloadRows.join("\n")}\n`),
      }),
    });
  };
  const runtime = Object.freeze({
    plugins,
    namespaces: CHROMIUM_SHARED_NAMESPACES,
    resolveCssInput,
    resolveImagesInput,
    verifyInputs,
  });
  CHROMIUM_SHARED_RUNTIME_BRANDS.set(runtime, physicalPackageRoot);
  return runtime;
}

export function assertChromiumSharedRuntimeAuthority(runtime, physicalPackageRoot) {
  if (
    CHROMIUM_SHARED_RUNTIME_BRANDS.get(runtime) !== physicalPackageRoot ||
    runtime.namespaces !== CHROMIUM_SHARED_NAMESPACES
  ) {
    throw new Error("Chromium shared runtime has invalid package or namespace authority");
  }
}

const CHROMIUM_IMAGES_PACKAGE_PATH = "front_end/Images/Images.js";

function createChromiumCssModulePlugin(packageRoot, resolveCssInput, cssPhysicalPaths, loadedCssPayloads) {
  const frontEndRoot = path.join(packageRoot, "front_end");
  return {
    name: "chromium-devtools-css-module",
    setup(buildContext) {
      buildContext.onResolve({ filter: /\.css\.js$/ }, async args => {
        if (!/^\.\.?\//.test(args.path)) return undefined;
        const cssPath = path.resolve(args.resolveDir, args.path.slice(0, -3));
        return await resolveCssInput({cssPath, importer: args.importer});
      });
      buildContext.onLoad(
        { filter: /\.css$/, namespace: CHROMIUM_SHARED_NAMESPACES.css },
        async args => {
          const registeredCssPath = cssPhysicalPaths.get(args.path);
          const physicalCssPath = registeredCssPath ?? await realpath(args.path);
          assertWithin(frontEndRoot, physicalCssPath, "Chromium shared CSS load");
          if (!registeredCssPath) {
            throw new Error(`Unregistered Chromium shared CSS load: ${args.path}`);
          }
          const relativeCssPath = normalizeRelativePath(
            path.relative(packageRoot, physicalCssPath),
          );
          const css = sanitizeChromiumSharedCss(
            await readFile(physicalCssPath, "utf8"),
            relativeCssPath,
          );
          const contents = `export default ${JSON.stringify(css)};\n`;
          loadedCssPayloads.set(relativeCssPath, contents);
          return {
            contents,
            loader: "js",
            resolveDir: path.dirname(physicalCssPath),
          };
        },
      );
    },
  };
}

// Chromium prints " == $0" beside the selected node so the console can refer
// to it. Pin-op exposes no console, so the hint would promise a binding that
// does not exist.
const CONSOLE_SELECTION_HINT_RULE_COUNT = 3;

const UNUSED_APPLICATION_TOKEN_COUNTS = Object.freeze({
  "--app-color-ai-assistance-input-divider": 2,
  "--app-color-google-ai-blue": 1,
  "--app-color-google-ai-green": 1,
  "--app-gradient-google-ai": 1,
});

/**
 * Keeps the actual pinned DevTools token values used by Elements while
 * removing non-rendering comments, unavailable product fonts, and the exact
 * AI-only application tokens that have no consumer in Pin-op's runtime graph.
 */
export function sanitizeChromiumSharedCss(
  css,
  relativeCssPath,
  { enforceReviewedTransformCounts = true } = {},
) {
  if (typeof css !== "string" ||
      typeof relativeCssPath !== "string" ||
      !relativeCssPath.startsWith("front_end/") ||
      !relativeCssPath.endsWith(".css") ||
      typeof enforceReviewedTransformCounts !== "boolean") {
    throw new TypeError("Chromium shared CSS sanitizer received invalid input");
  }
  const root = postcss.parse(css, {from: relativeCssPath});
  root.walkComments(comment => comment.remove());

  if (relativeCssPath === "front_end/application_tokens.css") {
    const removed = new Map(
      Object.keys(UNUSED_APPLICATION_TOKEN_COUNTS).map(name => [name, 0]),
    );
    root.walkDecls(declaration => {
      if (!removed.has(declaration.prop)) return;
      removed.set(declaration.prop, removed.get(declaration.prop) + 1);
      declaration.remove();
    });
    if (enforceReviewedTransformCounts) {
      for (const [name, expected] of Object.entries(UNUSED_APPLICATION_TOKEN_COUNTS)) {
        if (removed.get(name) !== expected) {
          throw new Error(
            `Chromium shared CSS reviewed AI token count changed: ${name}`,
          );
        }
      }
    }
  }

  if (relativeCssPath === "front_end/design_system_tokens.css") {
    let replacedProductFonts = 0;
    root.walkDecls(declaration => {
      const next = declaration.value.replace(
        /'Google Sans Text',\s*'Google Sans',\s*/g,
        () => {
          replacedProductFonts += 1;
          return "";
        },
      );
      declaration.value = next;
    });
    if (enforceReviewedTransformCounts && replacedProductFonts !== 1) {
      throw new Error(
        "Chromium shared CSS reviewed product-font count changed",
      );
    }
  }

  if (relativeCssPath === "front_end/panels/elements/elementsTreeOutline.css") {
    let removedHints = 0;
    root.walkRules(rule => {
      if (!rule.selector.includes(".selected-hint")) return;
      removedHints += 1;
      rule.remove();
    });
    if (enforceReviewedTransformCounts &&
      removedHints !== CONSOLE_SELECTION_HINT_RULE_COUNT) {
      throw new Error(
        "Chromium shared CSS reviewed console selection-hint count changed",
      );
    }
  }

  return root.toString();
}

async function createChromiumImagesPayload(packageRoot) {
  const imageRoot = path.join(packageRoot, "front_end", "Images", "src");
  const availableImages = new Set(await readdir(imageRoot));
  const imageNames = Object.keys(REVIEWED_IMAGE_HASHES);
  if (!imageNames.every(name => availableImages.has(name))) {
    throw new Error("Reviewed Chromium image set is incomplete");
  }
  const watchFiles = imageNames.map(name => path.join(imageRoot, name));
  const declarations = await Promise.all(watchFiles.map(async (imagePath, index) => {
    const name = imageNames[index].slice(0, -4);
    const data = (await readFile(imagePath)).toString("base64");
    const url = `url(\"data:image/svg+xml;base64,${data}\")`;
    return `root.setProperty(${JSON.stringify(`--image-file-${name}`)}, ${JSON.stringify(url)});`;
  }));
  return Object.freeze({
    contents: `const root = document.documentElement.style;\n${declarations.join("\n")}\n`,
    watchFiles: Object.freeze(watchFiles),
  });
}

function createChromiumGeneratedModulePlugin(
  packageRoot,
  allowImporter,
  resolveImagesInput,
  resolvedGeneratedInputs,
  imagePayload,
) {
  const frontEndRoot = path.join(packageRoot, "front_end");
  const expectedImagesPath = path.join(frontEndRoot, "Images", "Images.js");
  const expectedImagesInput = CHROMIUM_IMAGES_PACKAGE_PATH;
  return {
    name: "chromium-devtools-generated-modules",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/locales\.js$/ }, args => {
        if (!allowImporter(path.resolve(args.importer))) return undefined;
        const importer = path.resolve(args.importer);
        const expectedImporter = path.join(frontEndRoot, "core", "i18n", "i18nImpl.ts");
        if (importer !== expectedImporter) {
          return undefined;
        }
        resolvedGeneratedInputs.add("english-only-locales");
        return { path: "english-only-locales", namespace: CHROMIUM_SHARED_NAMESPACES.generated };
      });
      buildContext.onResolve({ filter: /Images\/Images\.js$/ }, args => {
        if (!allowImporter(path.resolve(args.importer))) return undefined;
        const generatedPath = path.resolve(args.resolveDir, args.path);
        if (generatedPath !== expectedImagesPath) {
          return undefined;
        }
        return resolveImagesInput({importer: args.importer});
      });
      buildContext.onLoad(
        { filter: /^english-only-locales$/, namespace: CHROMIUM_SHARED_NAMESPACES.generated },
        () => {
          if (!resolvedGeneratedInputs.has("english-only-locales")) {
            throw new Error("Unregistered Chromium shared locales load");
          }
          return {contents: CHROMIUM_ENGLISH_LOCALES_PAYLOAD, loader: "js"};
        },
      );
      buildContext.onLoad(
        { filter: /Images\.js$/, namespace: CHROMIUM_SHARED_NAMESPACES.images },
        args => {
          if (args.path !== expectedImagesInput || !resolvedGeneratedInputs.has(expectedImagesInput)) {
            throw new Error(`Unregistered Chromium shared images load: ${args.path}`);
          }
          return {contents: imagePayload.contents, loader: "js", watchFiles: imagePayload.watchFiles};
        },
      );
    },
  };
}

function createChromiumDirectGateSkillPlugin(packageRoot) {
  const exactImporter = path.join(
    packageRoot,
    "front_end",
    "models",
    "ai_assistance",
    "skills",
    "SkillRegistry.ts",
  );
  return Object.freeze({
    name: "chromium-devtools-direct-gate-skills",
    setup(buildContext) {
      buildContext.onResolve({filter: /\.skill\.js$/}, args => {
        if (path.resolve(args.importer) !== exactImporter) return undefined;
        return {path: args.path, namespace: "chromium-direct-gate-skill"};
      });
      buildContext.onLoad({filter: /.*/, namespace: "chromium-direct-gate-skill"}, args => ({
        contents: "export const skill = Object.freeze({" +
          `name:${JSON.stringify(path.basename(args.path, ".skill.js"))},` +
          "description:'',allowedTools:Object.freeze([]),instructions:''});\n",
        loader: "js",
      }));
    },
  });
}

function createChromiumBrowserRuntimePlugin(packageRoot, allowImporter) {
  const platformRoot = path.join(packageRoot, "front_end", "core", "platform");
  const hostRuntimePath = path.join(platformRoot, "HostRuntime.ts");
  const browserRuntimePath = path.join(platformRoot, "browser", "browser.ts");
  return {
    name: "chromium-devtools-browser-runtime",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/node\/node\.js$/ }, args => {
        if (!allowImporter(path.resolve(args.importer))) return undefined;
        if (path.resolve(args.importer) !== hostRuntimePath) {
          return undefined;
        }
        return { path: browserRuntimePath };
      });
    },
  };
}

function createChromiumReadOnlyOverlayPlugin(overlay, shared) {
  const frontEndRoot = path.join(overlay.packageRoot, "front_end");
  return {
    name: "chromium-devtools-read-only-elements-overlay",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^#chromium\// }, async args => {
        const importer = path.resolve(args.importer);
        if (!relativePathWithin(overlay.overlayRoot, importer)) {
          return undefined;
        }
        const relative = args.path.slice("#chromium/".length);
        if (!/^[A-Za-z0-9_./-]+\.js$/.test(relative)) {
          throw new Error(`Invalid Chromium read-only package import: ${args.path}`);
        }
        if (relative.endsWith(".css.js")) {
          const cssRelative = relative.slice(0, -3);
          return await shared.resolveCssInput({
            cssPath: assertWithin(
              frontEndRoot,
              path.resolve(frontEndRoot, ...cssRelative.split("/")),
              "Chromium read-only CSS import",
            ),
            importer,
          });
        }
        const sourceRelative = `${relative.slice(0, -3)}.ts`;
        return {
          path: assertWithin(
            frontEndRoot,
            path.resolve(frontEndRoot, ...sourceRelative.split("/")),
            "Chromium read-only package import",
          ),
        };
      });
      buildContext.onResolve({ filter: /.*/ }, args => {
        if (!args.importer) return undefined;
        const importer = path.resolve(args.importer);
        const relativeImporter = normalizeRelativePath(path.relative(overlay.packageRoot, importer));
        if (relativeImporter.startsWith("../") || path.isAbsolute(relativeImporter)) return undefined;
        const facade = overlay.resolutions.get(`${relativeImporter}\0${args.path}`);
        return facade ? { path: facade } : undefined;
      });
    },
  };
}

export function createChromiumReadOnlySourceTransformPlugin(overlay) {
  if (!CHROMIUM_READ_ONLY_OVERLAY_AUTHORITIES.has(overlay)) {
    throw new Error("Chromium read-only source transforms require a verified overlay authority");
  }
  const transformsByPath = new Map(
    [...overlay.sourceTransforms.values()].map(transform => [path.resolve(transform.absolutePath), transform]),
  );
  return {
    name: "chromium-devtools-read-only-source-transforms",
    setup(buildContext) {
      buildContext.onLoad({filter: /\.ts$/}, async args => {
        const transform = transformsByPath.get(path.resolve(args.path));
        if (!transform) return undefined;
        return {
          contents: transform.transformedSource,
          loader: "ts",
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

async function attestChromiumInputs(repositoryRoot, packageRoot, metafile) {
  const inputHashes = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    let inputPath;
    if (input.startsWith(`${CHROMIUM_SHARED_NAMESPACES.css}:`)) {
      // A shared CSS input names its place in the package.
      inputPath = path.resolve(
        packageRoot,
        input.slice(CHROMIUM_SHARED_NAMESPACES.css.length + 1),
      );
    } else if (input.startsWith("chromium-")) {
      continue;
    } else {
      inputPath = path.resolve(repositoryRoot, input);
    }

    const physicalInputPath = await realpath(inputPath);
    const relativeToPackage = path.relative(packageRoot, physicalInputPath);
    if (
      relativeToPackage.startsWith(`..${path.sep}`) ||
      relativeToPackage === ".." ||
      path.isAbsolute(relativeToPackage)
    ) {
      continue;
    }
    const relativePath = normalizeRelativePath(relativeToPackage);
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

function relativePathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return normalizeRelativePath(relative);
}

async function classifyChromiumReadOnlyMetafileInputs({
  repositoryRoot,
  packageRoot,
  overlayRoot,
  metafile,
}) {
  if (!metafile?.inputs || typeof metafile.inputs !== "object") {
    throw new Error("Chromium read-only build has no metafile input inventory");
  }
  const packageInputs = [];
  const overlayInputs = [];
  const generatedInputs = [];
  const exactGeneratedInputs = new Set([
    `${CHROMIUM_SHARED_NAMESPACES.generated}:english-only-locales`,
    `${CHROMIUM_SHARED_NAMESPACES.images}:${CHROMIUM_IMAGES_PACKAGE_PATH}`,
  ]);
  for (const input of Object.keys(metafile.inputs)) {
    const cssNamespace = input.startsWith(`${CHROMIUM_SHARED_NAMESPACES.css}:`) ?
      `${CHROMIUM_SHARED_NAMESPACES.css}:` : undefined;
    if (cssNamespace) {
      // The input names its place in the package, not on this machine.
      const absolutePath = await realpath(
        path.resolve(packageRoot, input.slice(cssNamespace.length)),
      );
      const relativePath = relativePathWithin(packageRoot, absolutePath);
      if (!relativePath) {
        throw new Error(`Chromium CSS input is outside the pinned package: ${input}`);
      }
      packageInputs.push({input, absolutePath, relativePath});
      continue;
    }
    if (input.startsWith("chromium-")) {
      if (!exactGeneratedInputs.has(input)) {
        throw new Error(`Unreviewed Chromium generated namespace input: ${input}`);
      }
      generatedInputs.push(input);
      continue;
    }

    const absolutePath = await realpath(path.resolve(repositoryRoot, input));
    const packageRelativePath = relativePathWithin(packageRoot, absolutePath);
    if (packageRelativePath) {
      packageInputs.push({input, absolutePath, relativePath: packageRelativePath});
      continue;
    }
    const overlayRelativePath = relativePathWithin(overlayRoot, absolutePath);
    if (overlayRelativePath) {
      overlayInputs.push({input, absolutePath, relativePath: overlayRelativePath});
      continue;
    }
    throw new Error(`Chromium read-only input is outside the pinned package and overlay: ${input}`);
  }
  return Object.freeze({
    packageInputs: Object.freeze(packageInputs),
    overlayInputs: Object.freeze(overlayInputs),
    generatedInputs: Object.freeze(generatedInputs),
  });
}

export async function verifyChromiumReadOnlyMetafileInputs({repositoryRoot, metafile}) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const overlay = await verifyChromiumReadOnlyElementsOverlay(physicalRepositoryRoot);
  return await classifyChromiumReadOnlyMetafileInputs({
    repositoryRoot: physicalRepositoryRoot,
    packageRoot: overlay.packageRoot,
    overlayRoot: overlay.overlayRoot,
    metafile,
  });
}

async function attestClassifiedInputs(inputs) {
  const inputHashes = new Map();
  for (const input of inputs) {
    if (!inputHashes.has(input.relativePath)) {
      inputHashes.set(input.relativePath, sha256(await readFile(input.absolutePath)));
    }
  }
  const rows = [...inputHashes]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([relativePath, hash]) => `${relativePath}\0${hash}`);
  return Object.freeze({fileCount: rows.length, sha256: sha256(`${rows.join("\n")}\n`)});
}

async function requiredChromiumLicenseFiles(packageRoot, packageInputs) {
  const thirdPartyRoots = new Set();
  for (const input of packageInputs) {
    const match = /^front_end\/third_party\/([^/]+)\//.exec(input.relativePath);
    if (match) thirdPartyRoots.add(`front_end/third_party/${match[1]}`);
  }

  const licensePaths = new Set(["LICENSE"]);
  for (const relativeRoot of [...thirdPartyRoots].sort()) {
    const absoluteRoot = path.resolve(packageRoot, ...relativeRoot.split("/"));
    let foundLicense = false;
    for (const absolute of await listFiles(absoluteRoot)) {
      if (/^(?:license|licence|copying)(?:[._-].*)?$/i.test(path.basename(absolute))) {
        foundLicense = true;
        licensePaths.add(normalizeRelativePath(path.relative(packageRoot, absolute)));
      }
    }
    if (!foundLicense) {
      throw new Error(`Chromium third-party input has no discoverable license: ${relativeRoot}`);
    }
  }
  return Object.freeze(await Promise.all([...licensePaths].sort().map(async relativePath => Object.freeze({
    path: relativePath,
    sha256: sha256(await readFile(path.resolve(packageRoot, ...relativePath.split("/")))),
  }))));
}

function assertAttestation(actual, expected, description) {
  if (
    actual.fileCount !== expected?.fileCount || actual.sha256 !== expected?.sha256
  ) {
    throw new Error(
      `${description} mismatch: ${actual.fileCount} files, ${actual.sha256}`,
    );
  }
}

function normalizedMetafileInput(value) {
  return value.replaceAll("\\", "/");
}

function reachableMetafileInputs({repositoryRoot, entryPoint, metafile}) {
  if (!metafile?.inputs || typeof metafile.inputs !== "object") {
    throw new Error("Chromium read-only build has no metafile input inventory");
  }
  const inputs = Object.keys(metafile.inputs);
  const byNormalizedPath = new Map();
  for (const input of inputs) {
    const normalized = normalizedMetafileInput(input);
    if (byNormalizedPath.has(normalized)) {
      throw new Error(`Ambiguous Chromium read-only metafile input: ${normalized}`);
    }
    byNormalizedPath.set(normalized, input);
  }
  const relativeEntryPoint = normalizedMetafileInput(path.relative(repositoryRoot, entryPoint));
  const absoluteEntryPoint = normalizedMetafileInput(path.resolve(entryPoint));
  const entryInput = byNormalizedPath.get(relativeEntryPoint) ??
    byNormalizedPath.get(absoluteEntryPoint) ??
    inputs.find(input => {
      if (input.startsWith("chromium-")) return false;
      return normalizedMetafileInput(path.resolve(repositoryRoot, input)) === absoluteEntryPoint;
    });
  if (!entryInput) {
    throw new Error("Chromium read-only production entry is absent from the metafile");
  }

  const owningOutputs = Object.entries(metafile.outputs ?? {}).filter(([, output]) =>
    output.inputs && Object.hasOwn(output.inputs, entryInput));
  if (owningOutputs.length !== 1) {
    throw new Error(
      `Chromium read-only production entry must contribute to exactly one output; found ${owningOutputs.length}`,
    );
  }
  const [owningOutputPath, owningOutput] = owningOutputs[0];
  const projectedInputs = [];
  for (const outputInput of Object.keys(owningOutput.inputs)) {
    const resolved = byNormalizedPath.get(normalizedMetafileInput(outputInput));
    if (!resolved) {
      throw new Error(`Chromium read-only output input is not in the metafile: ${outputInput}`);
    }
    projectedInputs.push(resolved);
  }
  return Object.freeze({
    entryInput,
    inputs: Object.freeze(projectedInputs),
    owningOutputPath,
    owningOutput,
  });
}

function outputForReachableEntry(metafile, reachable) {
  return [reachable.owningOutputPath, reachable.owningOutput];
}

export async function prepareChromiumReadOnlyElementsBuild(repositoryRoot) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const overlay = await verifyChromiumReadOnlyElementsOverlay(physicalRepositoryRoot);
  const reviewedImporters = Object.freeze(new Set([
    ...Object.keys(overlay.upstreamFiles).map(relativePath =>
      path.resolve(overlay.packageRoot, ...relativePath.split("/"))),
    ...Object.keys(overlay.manifest.overlayFiles).map(relativePath =>
      path.resolve(overlay.overlayRoot, ...relativePath.split("/"))),
  ]));
  const shared = await createChromiumSharedRuntimePlugins({
    packageRoot: overlay.packageRoot,
    allowedImporters: reviewedImporters,
  });
  const createScopedPlugins = sharedRuntime => {
    assertChromiumSharedRuntimeAuthority(sharedRuntime, overlay.packageRoot);
    return Object.freeze([
      createChromiumReadOnlyOverlayPlugin(overlay, sharedRuntime),
      createChromiumReadOnlySourceTransformPlugin(overlay),
    ].map(plugin => Object.freeze(plugin)));
  };
  const scopedPlugins = createScopedPlugins(shared);
  const plugins = Object.freeze([...scopedPlugins, ...shared.plugins]);

  const verifyBuild = async (result, sharedRuntime = shared) => {
    assertChromiumSharedRuntimeAuthority(sharedRuntime, overlay.packageRoot);
    const reachable = reachableMetafileInputs({
      repositoryRoot: physicalRepositoryRoot,
      entryPoint: overlay.entryPoint,
      metafile: result?.metafile,
    });
    const reachableMetafile = {
      inputs: Object.fromEntries(
        reachable.inputs.map(input => [input, result.metafile.inputs[input]]),
      ),
    };
    const classifiedInputs = await classifyChromiumReadOnlyMetafileInputs({
      repositoryRoot: physicalRepositoryRoot,
      packageRoot: overlay.packageRoot,
      overlayRoot: overlay.overlayRoot,
      metafile: reachableMetafile,
    });
    const sharedInputVerification = sharedRuntime.verifyInputs(reachable.inputs.filter(input =>
      Object.values(sharedRuntime.namespaces).some(namespace => input.startsWith(`${namespace}:`))));
    if (
      JSON.stringify(sharedInputVerification.inputInventory) !==
      JSON.stringify(overlay.manifest.reviewedSharedInputInventory)
    ) {
      throw new Error("Chromium read-only shared input inventory mismatch");
    }
    assertAttestation(
      sharedInputVerification.payloadAttestation,
      overlay.manifest.reviewedSharedPayloadAttestation,
      "Chromium read-only shared payload",
    );
    const chromiumInputAttestation = await attestClassifiedInputs(classifiedInputs.packageInputs);
    const overlayAttestation = await attestClassifiedInputs(classifiedInputs.overlayInputs);
    assertAttestation(
      chromiumInputAttestation,
      overlay.manifest.reviewedInputClosure,
      "Chromium read-only input closure",
    );
    assertAttestation(
      overlayAttestation,
      overlay.manifest.reviewedOverlayClosure,
      "Chromium read-only overlay closure",
    );
    const requiredLicenseFiles = await requiredChromiumLicenseFiles(
      overlay.packageRoot,
      classifiedInputs.packageInputs,
    );
    assertHashInventory(
      Object.fromEntries(requiredLicenseFiles.map(file => [file.path, file.sha256])),
      overlay.manifest.requiredLicenseFiles,
      "Chromium read-only license",
    );

    const [, output] = outputForReachableEntry(result.metafile, reachable);
    const standalone = typeof output.entryPoint === "string" &&
      normalizedMetafileInput(path.resolve(physicalRepositoryRoot, output.entryPoint)) ===
        normalizedMetafileInput(path.resolve(overlay.entryPoint));
    if (standalone && (
      !Array.isArray(output.exports) || output.exports.length !== 1 ||
      output.exports[0] !== "chromiumElementsRuntime"
    )) {
      throw new Error("Chromium read-only production entry must export only chromiumElementsRuntime");
    }
    const outputBytes = standalone ? output.bytes : reachable.inputs.reduce(
      (total, input) => total + (output.inputs?.[input]?.bytesInOutput ?? 0),
      0,
    );
    if (!Number.isSafeInteger(outputBytes)) {
      throw new Error("Chromium read-only runtime build did not produce JavaScript");
    }
    if (outputBytes > overlay.manifest.maxUnminifiedBytes) {
      throw new Error(
        `Chromium read-only runtime exceeds ${overlay.manifest.maxUnminifiedBytes} bytes: ${outputBytes}`,
      );
    }
    return Object.freeze({
      chromiumInputAttestation,
      overlayAttestation,
      requiredLicenseFiles,
      unminifiedBytes: outputBytes,
      verifiedInputKeys: Object.freeze([...reachable.inputs].sort()),
      generatedInputs: sharedInputVerification.generatedInputs,
      sharedInputInventory: sharedInputVerification.inputInventory,
      payloadAttestation: sharedInputVerification.payloadAttestation,
    });
  };

  return Object.freeze({
    entryPoint: overlay.entryPoint,
    plugins,
    scopedPlugins,
    createScopedPlugins: Object.freeze(createScopedPlugins),
    sharedRuntime: shared,
    sharedImporterPaths: Object.freeze([...reviewedImporters].sort()),
    browserTargets: CHROMIUM_READ_ONLY_ELEMENTS_RUNTIME.browserTargets,
    verifyBuild,
  });
}

export async function bundleChromiumReadOnlyElementsRuntime({
  repositoryRoot,
  write = false,
  outfile,
}) {
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const prepared = await prepareChromiumReadOnlyElementsBuild(physicalRepositoryRoot);
  const result = await build({
    absWorkingDir: physicalRepositoryRoot,
    entryPoints: [prepared.entryPoint],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: prepared.browserTargets,
    treeShaking: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    write,
    outfile: outfile ?? path.join(physicalRepositoryRoot, "chromium-read-only-elements-runtime.js"),
    logLevel: "silent",
    plugins: prepared.plugins,
  });
  Object.assign(result, await prepared.verifyBuild(result));
  Object.defineProperty(result, "sharedRuntime", {
    value: prepared.sharedRuntime,
    enumerable: false,
  });
  return result;
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

  const packageImporters = Object.freeze(new Set(await listFiles(verified.packageRoot)));
  const shared = await createChromiumSharedRuntimePlugins({
    packageRoot: verified.packageRoot,
    allowedImporters: packageImporters,
  });
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
    plugins: Object.freeze([...shared.plugins, createChromiumDirectGateSkillPlugin(verified.packageRoot)]),
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
