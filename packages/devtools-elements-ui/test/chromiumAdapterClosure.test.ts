import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Chromium adapter closure", () => {
  it("does not bundle Pin-op's local DOM or Rules fallback renderers", async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: ["src/chromium/upstream/PinOpChromiumInspectorAdapter.ts"],
      format: "esm",
      metafile: true,
      platform: "browser",
      treeShaking: true,
      write: false,
    });

    const inputs = Object.keys(result.metafile.inputs).map(path =>
      path.replaceAll("\\", "/")
    );
    expect(inputs.some(path => path.includes("/chromium/dom/"))).toBe(false);
    expect(inputs.some(path => path.includes("/chromium/rules/"))).toBe(false);
  });
});
