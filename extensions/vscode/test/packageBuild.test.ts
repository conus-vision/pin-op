import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const bundleUrl = new URL("../dist/extension.cjs", import.meta.url);
const metafileUrl = new URL("../dist/extension-meta.json", import.meta.url);
const wasmUrl = new URL("../dist/mappings.wasm", import.meta.url);
const runtimeMetadataUrl = new URL(
  "../dist/runtime-metadata.json",
  import.meta.url,
);
const sourceWasmUrl = new URL(
  "../node_modules/source-map/lib/mappings.wasm",
  import.meta.url,
);
const noticesUrl = new URL("../THIRD_PARTY_NOTICES", import.meta.url);
const vscodeIgnoreUrl = new URL("../.vscodeignore", import.meta.url);
const packageScriptUrl = new URL("../package-vsix.mjs", import.meta.url);
const buildScriptUrl = new URL("../esbuild.mjs", import.meta.url);
const extensionSourceUrl = new URL("../src/extension.ts", import.meta.url);
const installedSmokeUrl = new URL(
  "../smoke-installed-vsix.mjs",
  import.meta.url,
);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

beforeAll(() => {
  execFileSync(process.execPath, ["esbuild.mjs"], {
    cwd: extensionRoot,
    stdio: "pipe",
  });
});

describe("VS Code package build", () => {
  it("has no external package requires except vscode", () => {
    const bundle = readFileSync(bundleUrl, "utf8");
    const requires = [
      ...bundle.matchAll(/\brequire\((["'])([^"'./][^"']*)\1\)/g),
    ].map((match) => match[2]);
    const externalPackages = [...new Set(requires)]
      .filter((name) => name !== "vscode" && !builtins.has(name))
      .sort();

    expect(externalPackages).toEqual([]);
    expect(requires).toContain("vscode");
  });

  it("copies the source-map runtime WASM beside the bundle", () => {
    expect(existsSync(wasmUrl)).toBe(true);
    if (!existsSync(wasmUrl)) return;

    expect(readFileSync(wasmUrl)).toEqual(readFileSync(sourceWasmUrl));
  });

  it("writes exact structured runtime protocol metadata", () => {
    expect(existsSync(runtimeMetadataUrl)).toBe(true);
    if (!existsSync(runtimeMetadataUrl)) return;

    expect(JSON.parse(readFileSync(runtimeMetadataUrl, "utf8"))).toEqual({
      schemaVersion: 1,
      protocolVersion: 6,
    });
    const buildScript = readFileSync(buildScriptUrl, "utf8");
    expect(buildScript).toContain("PROTOCOL_VERSION");
    expect(buildScript).toContain(
      "serializeRuntimeMetadata(PROTOCOL_VERSION)",
    );
  });

  it("packages the current IDE capabilities and messages", () => {
    const bundle = readFileSync(bundleUrl, "utf8");

    expect(bundle).toMatch(
      /capabilities:\s*\[\s*"resolution",\s*"source-navigation",\s*"auto-refresh",\s*"source-presentation",\s*"presentation-settings"\s*\]/,
    );
    expect(bundle).toContain("page.refresh");
    expect(bundle).toContain("source.navigate");
    expect(bundle).toContain("source.navigationState");
  });

  it("bundles the save observer implementation", () => {
    const metafile = JSON.parse(readFileSync(metafileUrl, "utf8")) as {
      outputs: Record<
        string,
        { inputs: Record<string, { bytesInOutput?: number }> }
      >;
    };

    expect(
      metafile.outputs["dist/extension.cjs"]?.inputs[
        "src/refresh/saveObserver.ts"
      ]?.bytesInOutput,
    ).toBeGreaterThan(0);
  });

  it("binds save events after activation command setup and immediately owns them", () => {
    const source = readFileSync(extensionSourceUrl, "utf8");
    const runtimeCommands = source.indexOf("const runtimeCommands =");
    const diagnosticsCommand = source.indexOf("const diagnosticsCommand =");
    const observerBinding = source.indexOf(
      "const saveObserverSubscriptions = bindSaveObserverEvents(",
    );
    const subscriptionOwnership = source.indexOf(
      "context.subscriptions.push(",
    );

    expect(runtimeCommands).toBeGreaterThanOrEqual(0);
    expect(diagnosticsCommand).toBeGreaterThan(runtimeCommands);
    expect(observerBinding).toBeGreaterThan(diagnosticsCommand);
    expect(subscriptionOwnership).toBeGreaterThan(observerBinding);
  });

  it("pins protocol 6 and current capabilities in the installed smoke", () => {
    const smoke = readFileSync(installedSmokeUrl, "utf8");

    expect(smoke).toContain('"runtime-metadata.json"');
    expect(smoke).toContain("metadata.protocolVersion !== 6");
    expect(smoke).toContain("schema 1/protocol 6");
    expect(smoke).toContain("INSTALLED_VSIX_PROTOCOL_V6_OK");
    expect(smoke).toContain('"source-navigation"');
    expect(smoke).toContain('"source.navigationState"');
    expect(smoke).not.toContain("requiredRuntimeMarkers");
    expect(smoke).not.toContain("PROTOCOL_VERSION\\s*=");
    expect(smoke).not.toMatch(/protocol[- _]?v?5/i);
  });

  it("covers every bundled third-party package with full notices", () => {
    expect(existsSync(metafileUrl)).toBe(true);
    expect(existsSync(noticesUrl)).toBe(true);
    if (!existsSync(metafileUrl) || !existsSync(noticesUrl)) return;

    const metafile = JSON.parse(readFileSync(metafileUrl, "utf8")) as {
      inputs: Record<string, unknown>;
    };
    const packageRoots = new Map(
      Object.keys(metafile.inputs)
        .map(packageFromMetafilePath)
        .filter((entry): entry is { name: string; root: string } =>
          entry !== undefined
        )
        .map((entry) => [entry.name, entry.root]),
    );
    const bundledPackages = [...packageRoots.keys()].sort();
    const notices = readFileSync(noticesUrl, "utf8");
    const noticedPackages = [...notices.matchAll(/^## (.+)@[^\r\n]+$/gm)]
      .map((match) => match[1])
      .sort();

    expect(noticedPackages).toEqual(bundledPackages);
    for (const [name, root] of packageRoots) {
      const manifest = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf8"),
      ) as { version: string };
      const licenseFile = readdirSync(root)
        .filter((file) =>
          /^(?:license|licence|copying)(?:[._-].*)?$/i.test(file)
        )
        .sort()[0];
      expect(licenseFile, `${name} license file`).toBeDefined();
      if (!licenseFile) continue;

      const licenseText = readFileSync(resolve(root, licenseFile), "utf8")
        .replaceAll("\r\n", "\n")
        .trim();
      const sectionStart = notices.indexOf(
        `## ${name}@${manifest.version}\n`,
      );
      const sectionEnd = notices.indexOf("\n## ", sectionStart + 1);
      const section = notices.slice(
        sectionStart,
        sectionEnd < 0 ? notices.length : sectionEnd,
      );
      expect(section, `${name} full license text`).toContain(licenseText);
    }
    expect(notices).toMatch(
      /Runtime asset: dist\/mappings\.wasm \(from source-map@[^)]+\)/,
    );
  });

  it("selects runtime assets and excludes package tooling", () => {
    const patterns = readFileSync(vscodeIgnoreUrl, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    expect(patterns).toContain("!dist/extension.cjs");
    expect(patterns).toContain("!dist/mappings.wasm");
    expect(patterns).toContain("!dist/runtime-metadata.json");
    expect(patterns).toContain("package-vsix.mjs");
    expect(patterns).toContain("verify-vsix.mjs");
  });

  it("normalizes the packaged VSIX before verification", () => {
    const source = readFileSync(packageScriptUrl, "utf8");
    const packageCall = source.indexOf('"package",');
    const normalizeCall = source.indexOf(
      "await normalizeBrowserArchive(artifactPath)",
    );
    const verifyCall = source.indexOf('resolve(extensionRoot, "verify-vsix.mjs")');

    expect(packageCall).toBeGreaterThanOrEqual(0);
    expect(normalizeCall).toBeGreaterThan(packageCall);
    expect(verifyCall).toBeGreaterThan(normalizeCall);
  });
});

function packageFromMetafilePath(
  path: string,
): { name: string; root: string } | undefined {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const packagePath = normalized.slice(markerIndex + marker.length).split("/");
  const packageSegments = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2).join("/")
    : packagePath[0];
  if (!packageSegments) return undefined;

  return {
    name: packageSegments,
    root: resolve(
      extensionRoot,
      normalized.slice(0, markerIndex + marker.length),
      packageSegments,
    ),
  };
}
