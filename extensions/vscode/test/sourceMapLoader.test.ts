import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceMapConsumer, SourceMapGenerator } from "source-map";
import type { SourceWorkspace } from "@pinop/plugin-api";
import {
  SOURCE_MAP_CACHE_LIMIT,
  SourceMapLoader,
} from "../src/sourcePlugins/sourceMapLoader.js";
import type { StylesheetRule } from "../src/sourcePlugins/stylesheetAst.js";

const rawMap = {
  version: 3,
  file: "app.css",
  sourceRoot: "",
  sources: ["../src/app.scss"],
  names: [],
  mappings: "AAAA",
};

describe("SourceMapLoader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads an external source map relative to generated CSS", async () => {
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": JSON.stringify(rawMap),
    });
    const loaded = await new SourceMapLoader().load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=app.css.map */",
      workspace,
    );

    expect(loaded.mapUri).toBe("file:///workspace/dist/app.css.map");
    expect(loaded.rawMap?.sources).toEqual(["../src/app.scss"]);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("maps the supplied rule without promoting its source to a workspace URI", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 3, column: 2 },
      source: "../src/app.scss",
    });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    const resolved = await new SourceMapLoader().resolve(
      "file:///workspace/dist/app.css",
      "x{}\na{}\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(1, 0),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    expect(resolved).toEqual({
      kind: "mapped",
      mapUri: "file:///workspace/dist/app.css.map",
      sourceUrl: "http://localhost:4173/src/app.scss",
      line: 3,
      column: 2,
      diagnostics: [],
    });
  });

  it("does not borrow a preceding same-line rule mapping", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/first.scss",
    });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    const resolved = await new SourceMapLoader().resolve(
      "file:///workspace/dist/app.css",
      ".first{color:red}.second{color:blue}\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 17, 36),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    expect(resolved).toEqual({
      kind: "unmapped",
      mapUri: "file:///workspace/dist/app.css.map",
      diagnostics: [],
    });
  });

  it("scans unchanged map content only once across repeated rule lookups", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/first.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 8 },
      original: { line: 1, column: 0 },
      source: "../src/second.scss",
    });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });
    const loader = new SourceMapLoader();
    const scan = vi.spyOn(SourceMapConsumer, "with");
    const generatedText =
      ".first{}.second{}\n/*# sourceMappingURL=app.css.map */";

    await loader.resolve(
      "file:///workspace/dist/app.css",
      generatedText,
      generatedRuleAt(0, 0, 8),
      workspace,
      "http://localhost:4173/dist/app.css",
    );
    await loader.resolve(
      "file:///workspace/dist/app.css",
      generatedText,
      generatedRuleAt(0, 8, 17),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the mapping index when map content changes at the same URI", async () => {
    const mapUri = "file:///workspace/dist/app.css.map";
    const files: Record<string, string> = {
      [mapUri]: generatedMap("../src/first.scss", 1),
    };
    const workspace = memoryWorkspace(files);
    const loader = new SourceMapLoader();
    const scan = vi.spyOn(SourceMapConsumer, "with");
    const generatedText = "a{}\n/*# sourceMappingURL=app.css.map */";
    const resolve = () => loader.resolve(
      "file:///workspace/dist/app.css",
      generatedText,
      generatedRuleAt(0, 0),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    const first = await resolve();
    await resolve();
    files[mapUri] = generatedMap("../src/second.scss", 2);
    const second = await resolve();
    await resolve();

    expect(first).toMatchObject({
      kind: "mapped",
      sourceUrl: "http://localhost:4173/src/first.scss",
      line: 1,
    });
    expect(second).toMatchObject({
      kind: "mapped",
      sourceUrl: "http://localhost:4173/src/second.scss",
      line: 2,
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("reduces missing, unreadable, invalid, and unmapped source maps", async () => {
    const loader = new SourceMapLoader();
    const missing = await loader.resolve(
      "file:///workspace/dist/missing.css",
      "a{}",
      generatedRuleAt(0, 0),
      memoryWorkspace({}),
      "http://localhost:4173/dist/missing.css",
    );
    const unreadable = await loader.resolve(
      "file:///workspace/dist/unreadable.css",
      "a{}\n/*# sourceMappingURL=unreadable.css.map */",
      generatedRuleAt(0, 0),
      memoryWorkspace({}),
      "http://localhost:4173/dist/unreadable.css",
    );
    const invalid = await loader.resolve(
      "file:///workspace/dist/invalid.css",
      "a{}\n/*# sourceMappingURL=invalid.css.map */",
      generatedRuleAt(0, 0),
      memoryWorkspace({
        "file:///workspace/dist/invalid.css.map": "{not-json",
      }),
      "http://localhost:4173/dist/invalid.css",
    );
    const unmapped = await loader.resolve(
      "file:///workspace/dist/unmapped.css",
      "a{}\n/*# sourceMappingURL=unmapped.css.map */",
      generatedRuleAt(0, 0),
      memoryWorkspace({
        "file:///workspace/dist/unmapped.css.map": JSON.stringify({
          ...rawMap,
          mappings: "",
        }),
      }),
      "http://localhost:4173/dist/unmapped.css",
    );

    expect(missing.kind).toBe("missing");
    expect(missing.diagnostics[0]?.code).toBe("scss.sourceMapMissing");
    expect(unreadable.kind).toBe("invalid");
    expect(unreadable).toMatchObject({
      diagnosticCode: "resolver.source-read-failed",
    });
    expect(unreadable.diagnostics[0]?.code).toBe("scss.sourceMapReadFailed");
    expect(invalid.kind).toBe("invalid");
    expect(invalid).toMatchObject({
      diagnosticCode: "resolver.source-read-failed",
    });
    expect(invalid.diagnostics[0]?.code).toBe("scss.sourceMapInvalid");
    expect(unmapped).toEqual({
      kind: "unmapped",
      mapUri: "file:///workspace/dist/unmapped.css.map",
      diagnostics: [],
    });
  });

  it("loads base64 and percent-encoded inline source maps", async () => {
    const json = JSON.stringify(rawMap);
    const encoded = Buffer.from(json).toString("base64");
    const loader = new SourceMapLoader();
    const base64 = await loader.load(
      "file:///workspace/dist/app.css",
      `a{}\n/*# sourceMappingURL=data:application/json;base64,${encoded} */`,
      memoryWorkspace({}),
    );
    const percent = await loader.load(
      "file:///workspace/dist/other.css",
      `a{}\n/*# sourceMappingURL=data:application/json,${encodeURIComponent(json)} */`,
      memoryWorkspace({}),
    );

    expect(base64.mapUri).toBe(
      "file:///workspace/dist/app.css#inline-source-map",
    );
    expect(base64.rawMap?.file).toBe("app.css");
    expect(percent.rawMap?.sources).toEqual(["../src/app.scss"]);
  });

  it("uses the last directive and reports missing or invalid maps", async () => {
    const loader = new SourceMapLoader();
    const missing = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}",
      memoryWorkspace({}),
    );
    const invalid = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=invalid.map */",
      memoryWorkspace({
        "file:///workspace/dist/invalid.map": "{not-json",
      }),
    );
    const last = await loader.load(
      "file:///workspace/dist/app.css",
      "/*# sourceMappingURL=missing.map */\na{}\n/*# sourceMappingURL=valid.map */",
      memoryWorkspace({
        "file:///workspace/dist/valid.map": JSON.stringify(rawMap),
      }),
    );

    expect(missing.diagnostics[0]?.code).toBe("scss.sourceMapMissing");
    expect(invalid.diagnostics[0]?.code).toBe("scss.sourceMapInvalid");
    expect(last.mapUri).toBe("file:///workspace/dist/valid.map");
  });

  it("aborts an external map read without parsing a late result", async () => {
    const controller = new AbortController();
    let finishRead: ((value: string) => void) | undefined;
    const workspace = memoryWorkspace({});
    workspace.readText = () => new Promise((resolve) => {
      finishRead = resolve;
    });
    const pending = new SourceMapLoader().load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=app.css.map */",
      workspace,
      controller.signal,
    );
    await Promise.resolve();

    controller.abort();
    finishRead?.(JSON.stringify(rawMap));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reuses the current map and evicts least-recent historical maps", async () => {
    const loader = new SourceMapLoader();
    const workspace = memoryWorkspace({});
    const first = await loadInlineMap(loader, workspace, "first");
    const current = await loadInlineMap(loader, workspace, "current");
    for (let index = 0; index < SOURCE_MAP_CACHE_LIMIT - 2; index += 1) {
      await loadInlineMap(loader, workspace, `filler-${index}`);
    }

    expect((await loadInlineMap(loader, workspace, "current")).rawMap).toBe(
      current.rawMap,
    );
    await loadInlineMap(loader, workspace, "overflow");

    expect((await loadInlineMap(loader, workspace, "current")).rawMap).toBe(
      current.rawMap,
    );
    expect((await loadInlineMap(loader, workspace, "first")).rawMap).not.toBe(
      first.rawMap,
    );
  });
});

async function loadInlineMap(
  loader: SourceMapLoader,
  workspace: SourceWorkspace,
  name: string,
) {
  const map = JSON.stringify({ ...rawMap, file: `${name}.css` });
  return loader.load(
    `file:///workspace/dist/${name}.css`,
    `a{}\n/*# sourceMappingURL=data:application/json,${encodeURIComponent(map)} */`,
    workspace,
  );
}

function memoryWorkspace(
  files: Readonly<Record<string, string>>,
): SourceWorkspace {
  return {
    findFiles: async () => [],
    async readText(uri) {
      const text = files[uri];
      if (text === undefined) throw new Error(`Missing fixture: ${uri}`);
      return text;
    },
    resolveSourceUri: async () => ({ uris: [], status: "not-found" }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
  };
}

function generatedRuleAt(
  line: number,
  character: number,
  endCharacter = character + 3,
): StylesheetRule {
  return {
    selector: "a",
    range: {
      start: { line, character },
      end: { line, character: endCharacter },
    },
    startOffset: 0,
    endOffset: 3,
    fingerprint: {
      selector: "a",
      declarations: [],
      conditions: [],
    },
  };
}

function generatedMap(source: string, originalLine: number): string {
  const generator = new SourceMapGenerator({ file: "app.css" });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: originalLine, column: 0 },
    source,
  });
  return generator.toString();
}
