import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceMapConsumer, SourceMapGenerator } from "source-map";
import type { SourceWorkspace } from "@pin-op/plugin-api";
import {
  RULES_SOURCE_MAP_MAX_BYTES,
  SOURCE_MAP_CACHE_MAX_BYTES,
  SOURCE_MAP_CACHE_MAX_MAPPINGS,
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

  it("publishes weighted source-map cache budgets", () => {
    expect(SOURCE_MAP_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(SOURCE_MAP_CACHE_MAX_MAPPINGS).toBe(131_072);
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

  it("requires the exact selector-start segment and ignores declaration mappings", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 4, column: 2 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 7 },
      original: { line: 1, column: 0 },
      source: "../src/mixins.scss",
    });
    generator.setSourceContent("../src/card.scss", ".card { color: red; }");
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    const resolved = await new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 21, 0, 6),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    expect(resolved).toMatchObject({
      kind: "mapped",
      sourceUrl: "http://localhost:4173/src/card.scss",
      line: 4,
      column: 2,
      sourceContent: ".card { color: red; }",
      mapKind: "external",
      mapText: generator.toString(),
      mapContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects a map without a segment exactly at the selector start", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 1 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    await expect(new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card{}\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 7, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    )).resolves.toMatchObject({ kind: "unmapped" });
  });

  it("rejects contradictory original positions at the exact selector start", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 2, column: 0 },
      source: "../src/card.scss",
    });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    await expect(new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card{}\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 7, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    )).resolves.toMatchObject({ kind: "unmapped" });
  });

  it("rejects canonical source aliases with conflicting selector content", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 3 },
      original: { line: 1, column: 3 },
      source: "../src/./card.scss",
    });
    generator.setSourceContent(
      "../src/card.scss",
      ".card { color: red; }",
    );
    generator.setSourceContent(
      "../src/./card.scss",
      ".evil { color: blue; }",
    );
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    await expect(new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 21, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    )).resolves.toMatchObject({
      kind: "invalid",
      diagnostics: [{ code: "scss.sourceMapInvalid" }],
    });
  });

  it("rejects conflicting query and fragment aliases outside the selector", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss?v=1#actual",
    });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss?v=2#evil",
    });
    generator.setSourceContent(
      "../src/card.scss?v=1#actual",
      ".card { color: red; }",
    );
    generator.setSourceContent(
      "../src/card.scss?v=2#evil",
      ".evil { color: blue; }",
    );
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    await expect(new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card { color: red; }\n.other {}\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 21, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    )).resolves.toMatchObject({
      kind: "invalid",
      diagnostics: [{ code: "scss.sourceMapInvalid" }],
    });
  });

  it("rejects sourceRoot aliases that the source-map consumer collapses", async () => {
    const generator = new SourceMapGenerator({
      file: "app.css",
      sourceRoot: "src",
    });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 3 },
      original: { line: 1, column: 3 },
      source: "card.scss",
    });
    generator.setSourceContent(
      "/card.scss",
      ".card { color: red; }",
    );
    generator.setSourceContent(
      "card.scss",
      ".evil { color: blue; }",
    );
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": generator.toString(),
    });

    await expect(new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 21, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    )).resolves.toMatchObject({
      kind: "invalid",
      diagnostics: [{ code: "scss.sourceMapInvalid" }],
    });
  });

  it("propagates one defined canonical content across null aliases", async () => {
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/./card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 3 },
      original: { line: 1, column: 3 },
      source: "../src/card.scss",
    });
    const rawMap = generator.toJSON();
    rawMap.sourcesContent = [null, ".evil { color: blue; }"];
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css.map": JSON.stringify(rawMap),
    });

    const resolved = await new SourceMapLoader().resolveSelectorPrelude(
      "file:///workspace/dist/app.css",
      ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
      generatedRuleAt(0, 0, 21, 0, 5),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    expect(resolved).toMatchObject({ kind: "mapped" });
    if (resolved.kind !== "mapped") throw new Error("expected mapping");
    expect(resolved.sourceContent).toBe(".evil { color: blue; }");
    expect(resolved.selectorMappings.map((mapping) => mapping.sourceContent))
      .toEqual([
        ".evil { color: blue; }",
        ".evil { color: blue; }",
      ]);
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

  it("rejects an oversized inline source map before JSON parsing", async () => {
    const oversized = JSON.stringify({
      ...rawMap,
      sourcesContent: ["x".repeat(RULES_SOURCE_MAP_MAX_BYTES)],
    });
    const encoded = Buffer.from(oversized).toString("base64");

    const loaded = await new SourceMapLoader().load(
      "file:///workspace/dist/oversized.css",
      `a{}\n/*# sourceMappingURL=data:application/json;base64,${encoded} */`,
      memoryWorkspace({}),
    );

    expect(loaded.rawMap).toBeUndefined();
    expect(loaded.diagnostics[0]?.code).toBe("scss.sourceMapInvalid");
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
    let observed: unknown;
    void pending.catch((error: unknown) => {
      observed = error;
    });

    controller.abort();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const promptOutcome = observed;
    finishRead?.(JSON.stringify(rawMap));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(promptOutcome).toMatchObject({ name: "AbortError" });
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

  it("evicts decoded maps when their retained bytes exceed the cache budget", async () => {
    const firstUri = "file:///workspace/dist/first.map";
    const secondUri = "file:///workspace/dist/second.map";
    const firstText = JSON.stringify({
      ...rawMap,
      file: "first.css",
      sourcesContent: ["a".repeat(128)],
    });
    const secondText = JSON.stringify({
      ...rawMap,
      file: "second.css",
      sourcesContent: ["b".repeat(128)],
    });
    const loader = new SourceMapLoader({
      maxDecodedBytes: Math.max(
        Buffer.byteLength(firstText),
        Buffer.byteLength(secondText),
      ),
    });
    const workspace = memoryWorkspace({
      [firstUri]: firstText,
      [secondUri]: secondText,
    });
    const parse = vi.spyOn(JSON, "parse");

    const first = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=first.map */",
      workspace,
    );
    await loader.load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=second.map */",
      workspace,
    );
    const reloaded = await loader.load(
      "file:///workspace/dist/app.css",
      "a{}\n/*# sourceMappingURL=first.map */",
      workspace,
    );

    expect(parse).toHaveBeenCalledTimes(3);
    expect(reloaded.rawMap).not.toBe(first.rawMap);
  });

  it("does not retain decoded inline text outside the weighted map cache", async () => {
    const firstText = JSON.stringify({
      ...rawMap,
      file: "inline-first.css",
      sourcesContent: ["a".repeat(128)],
    });
    const secondText = JSON.stringify({
      ...rawMap,
      file: "inline-second.css",
      sourcesContent: ["b".repeat(128)],
    });
    const loader = new SourceMapLoader({
      maxDecodedBytes: Math.max(
        Buffer.byteLength(firstText),
        Buffer.byteLength(secondText),
      ),
    });
    const workspace = memoryWorkspace({});
    const decode = vi.spyOn(globalThis, "decodeURIComponent");
    const load = (name: string, text: string) => {
      const reference = `data:application/json,${encodeURIComponent(text)}`;
      return loader.load(
        `file:///workspace/dist/${name}.css`,
        `a{}\n/*# sourceMappingURL=${reference} */`,
        workspace,
      );
    };

    await load("first", firstText);
    await load("second", secondText);
    await load("first", firstText);

    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("evicts mapping indexes when their record weight exceeds the cache budget", async () => {
    const loader = new SourceMapLoader({ maxMappingRecords: 1 });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/first.map": generatedMap(
        "../src/first.scss",
        1,
      ),
      "file:///workspace/dist/second.map": generatedMap(
        "../src/second.scss",
        1,
      ),
    });
    const scan = vi.spyOn(SourceMapConsumer, "with");
    const resolve = (mapName: string) => loader.resolve(
      "file:///workspace/dist/app.css",
      `a{}\n/*# sourceMappingURL=${mapName}.map */`,
      generatedRuleAt(0, 0),
      workspace,
      "http://localhost:4173/dist/app.css",
    );

    await resolve("first");
    await resolve("second");
    await resolve("first");

    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("accounts for a mapping index that finishes after its caller aborts", async () => {
    const loader = new SourceMapLoader({ maxMappingRecords: 1 });
    const workspace = memoryWorkspace({
      "file:///workspace/dist/first.map": generatedMap(
        "../src/first.scss",
        1,
      ),
      "file:///workspace/dist/second.map": generatedMap(
        "../src/second.scss",
        1,
      ),
    });
    const originalWith = SourceMapConsumer.with.bind(SourceMapConsumer);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const scan = vi.spyOn(SourceMapConsumer, "with");
    scan.mockImplementationOnce(async (map, sourceMapUrl, callback) => {
      markStarted();
      await buildGate;
      const result = await originalWith(map, sourceMapUrl, callback);
      markFinished();
      return result;
    });
    const resolve = (mapName: string, signal?: AbortSignal) => loader.resolve(
      "file:///workspace/dist/app.css",
      `a{}\n/*# sourceMappingURL=${mapName}.map */`,
      generatedRuleAt(0, 0),
      workspace,
      "http://localhost:4173/dist/app.css",
      signal,
    );
    const controller = new AbortController();

    const abandoned = resolve("first", controller.signal);
    await started;
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    releaseBuild();
    await finished;
    await resolve("second");
    await resolve("first");

    expect(scan).toHaveBeenCalledTimes(3);
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
  selectorStartCharacter = character,
  selectorEndCharacter = Math.min(endCharacter, character + 1),
): StylesheetRule {
  return {
    selector: "a",
    range: {
      start: { line, character },
      end: { line, character: endCharacter },
    },
    startOffset: 0,
    endOffset: 3,
    selectorPreludeRange: {
      start: { line, character: selectorStartCharacter },
      end: { line, character: selectorEndCharacter },
    },
    selectorPreludeStartOffset: 0,
    selectorPreludeEndOffset: 1,
    contexts: [],
    hasUnsupportedGroupingContext: false,
    hasCompleteDeclarationFingerprint: true,
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
