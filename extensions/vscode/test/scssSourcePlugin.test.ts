import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceMatch,
  SourceWorkspace,
} from "@pinop/plugin-api";
import type { CssRuleFact, InspectTarget } from "@pinop/protocol";
import { ScssSourcePlugin } from "../src/sourcePlugins/scssSourcePlugin.js";
import { memorySourceWorkspace } from "./support/memorySourceWorkspace.js";

describe("ScssSourcePlugin", () => {
  it("maps selected and parent rules to complete blocks in layout.scss", async () => {
    const fixture = await fixtureFiles();
    const activeUri = "file:///workspace/examples/basic-css/src/layout.scss";
    const result = await resolveScss(
      activeUri,
      fixture[activeUri]!,
      fixture,
      selection([
        cssTarget("selected", ".layout > .card", "/dist/app.css", {
          property: "max-width",
          value: "32rem",
          rulePath: "0.4",
        }),
        cssTarget("parent", ".layout", "/dist/app.css", {
          property: "display",
          value: "grid",
          rulePath: "0.3",
        }),
      ]),
    );

    expect(result.matches.map((match) => match.targetRole)).toEqual([
      "parent",
      "selected",
    ]);
    expect(snippets(fixture[activeUri]!, result.matches)).toEqual([
      ".layout {\n  display: grid;\n  gap: 1.5rem;\n}",
      ".layout > .card {\n  max-width: 32rem;\n}",
    ]);
    expect(
      result.matches.every((match) => match.confidence === "sourcemap"),
    ).toBe(true);
    expect(result.status).toBe("matched");
  });

  it("maps an _ORB stylesheet through the workspace-bound resolver", async () => {
    const root = "file:///D:/sites/_ORB";
    const activeUri = `${root}/wp-content/themes/orbiter/style.scss`;
    const generatedUri = `${root}/wp-content/themes/orbiter/style.css`;
    const mapUri = `${generatedUri}.map`;
    const generator = new SourceMapGenerator({ file: "style.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "style.scss",
    });
    const original = ".home_slide_title { color: red; }";
    const generated = `${original}\n/*# sourceMappingURL=style.css.map */`;
    const workspace = memorySourceWorkspace(
      {
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: generator.toString(),
        [`${root}/wp-admin/css/style.css`]: "body {}",
        [`${root}/wp-includes/css/style.css`]: "body {}",
      },
      [root],
    );
    const selected = selection([cssTarget(
      "selected",
      ".home_slide_title",
      "/_ORB/wp-content/themes/orbiter/style.css?v=7",
      { rulePath: "0.0" },
    )], "http://localhost/_ORB/");

    const result = await new ScssSourcePlugin().resolve({
      selection: selected,
      document: document(activeUri, original),
      workspace,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({
        targetRole: "selected",
        confidence: "sourcemap",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: original.length },
        },
      }),
    ]);
    expect(result.diagnostics).toEqual([{
      code: "scss.sourceWorkspaceBound",
      message: "Workspace-bound: _ORB",
      severity: "info",
    }]);
    expect(result.diagnostics?.map((entry) => entry.code)).not.toContain(
      "scss.generatedSourceAmbiguous",
    );
  });

  it("uses the mapped position for repeated and nested SCSS rules", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const mapUri = `${generatedUri}.map`;
    const original = [
      ".card {",
      "  &.featured { color: red; }",
      "}",
      ".other {",
      "  &.featured { color: blue; }",
      "}",
    ].join("\n");
    const generated = [
      ".card.featured { color: red; }",
      ".other.featured { color: blue; }",
      "/*# sourceMappingURL=app.css.map */",
    ].join("\n");
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 2, column: 2 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 5, column: 2 },
      source: "../src/card.scss",
    });
    const result = await resolveScss(
      activeUri,
      original,
      {
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: generator.toString(),
      },
      selection([
        cssTarget("selected", ".other.featured", "/dist/app.css", {
          property: "color",
          value: "blue",
          rulePath: "0.1",
        }),
      ]),
    );

    expect(result.matches).toHaveLength(1);
    expect(snippets(original, result.matches)[0]).toContain("&.featured");
    expect(snippets(original, result.matches)[0]).toContain("color: blue");
    expect(result.status).toBe("matched");
  });

  it("uses the conservative fingerprint fallback before source-map mapping", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const mapUri = `${generatedUri}.map`;
    const original = [
      ".card {",
      "  &.featured {",
      "    color: blue;",
      "  }",
      "}",
    ].join("\n");
    const generated = [
      ".card.featured { color: blue; }",
      "/*# sourceMappingURL=app.css.map */",
    ].join("\n");
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 2, column: 2 },
      source: "../src/card.scss",
    });

    const result = await resolveScss(
      activeUri,
      original,
      {
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: generator.toString(),
      },
      selection([cssTarget(
        "selected",
        ".card.featured",
        "/dist/app.css",
        { property: "color", value: "blue", rulePath: "9.9" },
      )]),
    );

    expect(result.status).toBe("matched");
    expect(snippets(original, result.matches)).toEqual([
      "&.featured {\n    color: blue;\n  }",
    ]);
  });

  it("rejects a mapped SCSS column that the document would clamp", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const mapUri = `${generatedUri}.map`;
    const original = [
      ".card {",
      "  color: red;",
      "}",
    ].join("\n");
    const generated = [
      ".card { color: red; }",
      "/*# sourceMappingURL=app.css.map */",
    ].join("\n");
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 2, column: 999 },
      source: "../src/card.scss",
    });

    const result = await resolveScss(
      activeUri,
      original,
      {
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: generator.toString(),
      },
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
    );

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics?.map((entry) => entry.code)).toContain(
      "scss.mappingMissing",
    );
  });

  it("rejects ambiguous generated fingerprint matches before loading a map", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const original = ".card { color: red; }";
    const generated = [
      ".card { color: red; }",
      ".card { color: red; }",
    ].join("\n");

    const result = await resolveScss(
      activeUri,
      original,
      { [activeUri]: original, [generatedUri]: generated },
      selection([cssTarget(
        "selected",
        ".card",
        "/dist/app.css",
        { rulePath: "9.9" },
      )]),
    );

    expect(result.status).toBe("rule-match-ambiguous");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics?.map((entry) => entry.code)).not.toContain(
      "scss.sourceMapMissing",
    );
  });

  it("does not load a source map when generated CSS has no eligible rule", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const result = await resolveScss(
      activeUri,
      ".card { color: red; }",
      {
        [activeUri]: ".card { color: red; }",
        [generatedUri]: ".other { color: blue; }",
      },
      selection([cssTarget(
        "selected",
        ".card",
        "/dist/app.css",
        { rulePath: "9.9" },
      )]),
    );

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics?.map((entry) => entry.code)).not.toContain(
      "scss.sourceMapMissing",
    );
  });

  it("does not guess a nested SCSS selector when mapping is absent", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const original = [
      ".card {",
      "  &.featured { color: red; }",
      "}",
    ].join("\n");
    const result = await resolveScss(
      activeUri,
      original,
      {
        [activeUri]: original,
        [generatedUri]: ".card.featured { color: red; }",
      },
      selection([cssTarget(
        "selected",
        ".card.featured",
        "/dist/app.css",
        { rulePath: "9.9" },
      )]),
    );

    expect(result.status).toBe("source-map-missing");
    expect(result.matches).toEqual([]);
  });

  it.each(["automatic", "workspace-bound"] as const)(
    "does not trust a %s unique-basename source-map target as active",
    async (strategy) => {
      const activeUri = "file:///workspace/src/card.scss";
      const generatedUri = "file:///workspace/dist/app.css";
      const mapUri = `${generatedUri}.map`;
      const original = ".card { color: red; }";
      const generated = [
        ".card { color: red; }",
        "/*# sourceMappingURL=app.css.map */",
      ].join("\n");
      const generator = new SourceMapGenerator({ file: "app.css" });
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 1, column: 0 },
        source: "../src/card.scss",
      });
      const files = {
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: generator.toString(),
      };
      const baseWorkspace = memoryWorkspace(files);
      const result = await new ScssSourcePlugin().resolve({
        selection: selection([cssTarget(
          "selected",
          ".card",
          "/dist/app.css",
        )]),
        document: document(activeUri, original),
        workspace: {
          ...baseWorkspace,
          async resolveSourceUri(sourceUrl, baseUrl) {
            if (sourceUrl.endsWith("card.scss")) {
              return strategy === "automatic"
                ? {
                  uris: [activeUri],
                  status: "unique-basename",
                  strategy,
                }
                : {
                  uris: [activeUri],
                  status: "unique-basename",
                  strategy,
                  workspaceFolderUri: "file:///workspace",
                };
            }
            return baseWorkspace.resolveSourceUri(sourceUrl, baseUrl);
          },
        },
        signal: new AbortController().signal,
      });

      expect(result.matches).toEqual([]);
      expect(result.status).toBe("source-not-found");
      expect(result.diagnostics?.map((entry) => entry.code)).toContain(
        "scss.originalSourceNotFound",
      );
    },
  );

  it("uses a unique generated basename only in automatic mode", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/build/app.css";
    const mapUri = `${generatedUri}.map`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const files = {
      [activeUri]: ".card { color: red; }",
      [generatedUri]: [
        ".card { color: red; }",
        "/*# sourceMappingURL=app.css.map */",
      ].join("\n"),
      [mapUri]: generator.toString(),
    };
    const base = memoryWorkspace(files);
    const result = await new ScssSourcePlugin().resolve({
      selection: selection([cssTarget(
        "selected",
        ".card",
        "/assets/app.css",
      )]),
      document: document(activeUri, files[activeUri]),
      workspace: {
        ...base,
        resolveSourceUri: async (sourceUrl, baseUrl) =>
          sourceUrl === "/assets/app.css"
            ? {
              uris: [generatedUri],
              status: "unique-basename",
              strategy: "automatic",
            }
            : base.resolveSourceUri(sourceUrl, baseUrl),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("matched");
    expect(result.matches).toEqual([
      expect.objectContaining({ confidence: "sourcemap" }),
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: "scss.generatedSourceHeuristic",
        message:
          "Generated CSS used automatic basename matching: /assets/app.css",
        severity: "info",
      },
      {
        code: "scss.sourceAutomatic",
        message: "Automatic source matching",
        severity: "info",
      },
    ]);
  });

  it("rejects a workspace-bound unique generated basename", async () => {
    const result = await resolveWithGeneratedResolution({
      uris: ["file:///workspace/build/app.css"],
      status: "unique-basename",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///workspace",
    });

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("source-not-found");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "scss.generatedSourceNotFound" }),
      {
        code: "scss.sourceWorkspaceBound",
        message: "Workspace-bound: workspace",
        severity: "info",
      },
    ]);
  });

  it("keeps ambiguous generated source resolution ambiguous", async () => {
    const result = await resolveWithGeneratedResolution({
      uris: [],
      status: "ambiguous",
      strategy: "automatic",
    });

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("source-ambiguous");
    expect(result.diagnostics?.map((entry) => entry.code)).toEqual([
      "scss.generatedSourceAmbiguous",
      "scss.sourceAutomatic",
    ]);
  });

  it.each([
    ["missing-map", "source-map-missing", "scss.sourceMapMissing"],
    ["unreadable-map", "source-map-invalid", "scss.sourceMapReadFailed"],
    ["invalid-map", "source-map-invalid", "scss.sourceMapInvalid"],
    ["unmapped", "no-rule-match", "scss.mappingMissing"],
    ["missing-original", "source-not-found", "scss.originalSourceNotFound"],
    ["other-original", "source-not-active-document", "scss.sourceNotActiveDocument"],
    ["ambiguous-original", "source-ambiguous", "scss.sourceAmbiguous"],
  ] as const)(
    "reduces %s to %s without a match",
    async (kind, status, code) => {
      const result = await resolveBrokenMap(kind);
      expect(result.status).toBe(status);
      expect(result.matches).toEqual([]);
      expect(result.diagnostics?.map((entry) => entry.code)).toContain(code);
    },
  );

  it("deduplicates strategy diagnostics by code and message", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const files = { [activeUri]: ".card {}" };
    const base = memoryWorkspace(files);
    const result = await new ScssSourcePlugin().resolve({
      selection: selection([
        cssTarget("selected", ".card", "/dist/app.css"),
        cssTarget("parent", ".layout", "/dist/layout.css"),
        cssTarget("parent", ".panel", "/dist/panel.css"),
      ]),
      document: document(activeUri, files[activeUri]),
      workspace: {
        ...base,
        resolveSourceUri: async (sourceUrl) => ({
          uris: [],
          status: "not-found",
          strategy: "workspace-bound",
          workspaceFolderUri: sourceUrl === "/dist/layout.css"
            ? "file:///workspaces/SECOND"
            : "file:///workspaces/FIRST",
        }),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("source-not-found");
    expect(result.diagnostics?.map((entry) => entry.code)).toEqual([
      "scss.generatedSourceNotFound",
      "scss.generatedSourceNotFound",
      "scss.generatedSourceNotFound",
      "scss.sourceWorkspaceBound",
      "scss.sourceWorkspaceBound",
    ]);
    expect(result.diagnostics?.slice(-2)).toEqual([
      {
        code: "scss.sourceWorkspaceBound",
        message: "Workspace-bound: FIRST",
        severity: "info",
      },
      {
        code: "scss.sourceWorkspaceBound",
        message: "Workspace-bound: SECOND",
        severity: "info",
      },
    ]);
  });

  it("does not expose the workspace URI in a bound diagnostic", async () => {
    const result = await resolveWithGeneratedResolution({
      uris: ["file:///workspace/build/app.css"],
      status: "unique-basename",
      strategy: "workspace-bound",
      workspaceFolderUri:
        "file:///C:/Users/alice/private-project/_ORB%20Workspace/",
    });

    expect(result.diagnostics).toContainEqual({
      code: "scss.sourceWorkspaceBound",
      message: "Workspace-bound: _ORB Workspace",
      severity: "info",
    });
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain("file:///");
    expect(serialized).not.toContain("C:/Users/alice/private-project");
  });

  it("removes control and bidi characters from workspace labels", async () => {
    const controls =
      "\u0000\u001f\u007f\u0080\u009f\u061c\u200e\u200f" +
      "\u2028\u2029\u202a\u202e\u2066\u2069";
    const label = `  Project${controls} Workspace  `;
    const result = await resolveWithGeneratedResolution({
      uris: ["file:///workspace/build/app.css"],
      status: "unique-basename",
      strategy: "workspace-bound",
      workspaceFolderUri: `file:///workspaces/${encodeURIComponent(label)}`,
    });

    expect(result.diagnostics?.at(-1)).toEqual({
      code: "scss.sourceWorkspaceBound",
      message: "Workspace-bound: Project Workspace",
      severity: "info",
    });
  });

  it("uses a safe fallback when workspace label sanitization is empty", async () => {
    const label = "\u0000\u0080\u2028\u202e\u2066";
    const result = await resolveWithGeneratedResolution({
      uris: [],
      status: "ambiguous",
      strategy: "workspace-bound",
      workspaceFolderUri: `file:///workspaces/${encodeURIComponent(label)}`,
    });

    expect(result.diagnostics?.at(-1)).toEqual({
      code: "scss.sourceWorkspaceBound",
      message: "Workspace-bound: ambiguous workspace",
      severity: "info",
    });
  });

  it("caps displayed workspace labels at 128 Unicode code points", async () => {
    const displayedLabel = `${"a".repeat(127)}\u{1f600}`;
    const result = await resolveWithGeneratedResolution({
      uris: ["file:///workspace/build/app.css"],
      status: "unique-basename",
      strategy: "workspace-bound",
      workspaceFolderUri:
        `file:///workspaces/${encodeURIComponent(`${displayedLabel}tail`)}`,
    });

    expect(result.diagnostics?.at(-1)).toEqual({
      code: "scss.sourceWorkspaceBound",
      message: `Workspace-bound: ${displayedLabel}`,
      severity: "info",
    });
    expect([...displayedLabel]).toHaveLength(128);
  });

  it("rejects unsupported source resolution strategies", async () => {
    await expect(resolveWithGeneratedResolution({
      uris: [],
      status: "not-found",
      strategy: "future-strategy",
    } as unknown as Resolution)).rejects.toThrow(
      "Unsupported SCSS source resolution strategy: future-strategy",
    );
  });

  it("returns an empty result when generated source resolution is cancelled", async () => {
    let finishResolution: ((resolution: Resolution) => void) | undefined;
    let markResolutionStarted: (() => void) | undefined;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    const deferredResolution = new Promise<Resolution>((resolve) => {
      finishResolution = resolve;
    });
    const activeUri = "file:///workspace/src/card.scss";
    const base = memoryWorkspace({ [activeUri]: ".card {}" });
    const controller = new AbortController();
    const pending = new ScssSourcePlugin().resolve({
      selection: selection([cssTarget(
        "selected",
        ".card",
        "/dist/app.css",
      )]),
      document: document(activeUri, ".card {}"),
      workspace: {
        ...base,
        resolveSourceUri: async () => {
          markResolutionStarted?.();
          return deferredResolution;
        },
      },
      signal: controller.signal,
    });
    await resolutionStarted;

    controller.abort();
    finishResolution?.({
      uris: ["file:///workspace/dist/app.css"],
      status: "exact",
      strategy: "future-strategy",
    } as unknown as Resolution);

    await expect(pending).resolves.toEqual({
      status: "no-rule-match",
      matches: [],
      diagnostics: [],
    });
  });

  it("stops after an aborted generated CSS read", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const mapUri = `${generatedUri}.map`;
    const reads: string[] = [];
    let finishGeneratedRead: ((value: string) => void) | undefined;
    const controller = new AbortController();
    const plugin = new ScssSourcePlugin();
    const pending = plugin.resolve({
      selection: selection([
        cssTarget("selected", ".card", "/dist/app.css"),
      ]),
      document: document(activeUri, ".card {}"),
      workspace: {
        ...memoryWorkspace({
          [activeUri]: ".card {}",
          [generatedUri]: "",
          [mapUri]: JSON.stringify({
            version: 3,
            file: "app.css",
            sources: ["../src/card.scss"],
            names: [],
            mappings: "AAAA",
          }),
        }),
        async readText(uri) {
          reads.push(uri);
          if (uri === generatedUri) {
            return new Promise((resolve) => {
              finishGeneratedRead = resolve;
            });
          }
          if (uri === mapUri) return "{}";
          throw new Error(`Unexpected read: ${uri}`);
        },
      },
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();
    finishGeneratedRead?.(
      ".card {}\n/*# sourceMappingURL=app.css.map */",
    );
    const result = await pending;

    expect(reads).toEqual([generatedUri]);
    expect(result).toEqual({
      status: "no-rule-match",
      matches: [],
      diagnostics: [],
    });
  });
});

async function fixtureFiles(): Promise<Record<string, string>> {
  const root = "file:///workspace/examples/basic-css";
  const entries = await Promise.all([
    ["dist/app.css", "../../../examples/basic-css/dist/app.css"],
    ["dist/app.css.map", "../../../examples/basic-css/dist/app.css.map"],
    ["src/card.scss", "../../../examples/basic-css/src/card.scss"],
    ["src/layout.scss", "../../../examples/basic-css/src/layout.scss"],
  ].map(async ([uri, path]) => [
    `${root}/${uri}`,
    (await readFile(new URL(path!, import.meta.url), "utf8")).replace(/\r\n/g, "\n"),
  ]));
  return Object.fromEntries(entries);
}

async function resolveBrokenMap(
  kind:
    | "missing-map"
    | "unreadable-map"
    | "invalid-map"
    | "unmapped"
    | "missing-original"
    | "other-original"
    | "ambiguous-original",
) {
  const activeUri = "file:///workspace/src/card.scss";
  const generatedUri = "file:///workspace/dist/app.css";
  const mapUri = `${generatedUri}.map`;
  const map = {
    version: 3,
    file: "app.css",
    sources: [kind === "missing-original"
      ? "../src/missing.scss"
      : kind === "other-original"
        ? "../src/other.scss"
        : kind === "ambiguous-original"
          ? "shared.scss"
          : "../src/card.scss"],
    names: [],
    mappings: kind === "unmapped" ? "" : "AAAA",
  };
  const directive = kind === "missing-map"
    ? ""
    : "\n/*# sourceMappingURL=app.css.map */";
  return resolveScss(
    activeUri,
    ".card {}",
    {
      [activeUri]: ".card {}",
      [generatedUri]: `.card {}${directive}`,
      ...(kind === "invalid-map"
        ? { [mapUri]: "{invalid" }
        : kind === "unmapped" ||
            kind === "missing-original" ||
            kind === "other-original" ||
            kind === "ambiguous-original"
          ? { [mapUri]: JSON.stringify(map) }
          : {}),
      ...(kind === "other-original"
        ? { "file:///workspace/src/other.scss": ".card {}" }
        : {}),
      ...(kind === "ambiguous-original"
        ? {
          "file:///workspace/packages/a/shared.scss": ".card {}",
          "file:///workspace/packages/b/shared.scss": ".card {}",
        }
        : {}),
    },
    selection([cssTarget("selected", ".card", "/dist/app.css")]),
  );
}

type Resolution = Awaited<ReturnType<SourceWorkspace["resolveSourceUri"]>>;

async function resolveWithGeneratedResolution(
  resolution: Resolution,
) {
  const activeUri = "file:///workspace/src/card.scss";
  const generatedUri = "file:///workspace/build/app.css";
  const files = {
    [activeUri]: ".card { color: red; }",
    [generatedUri]: ".card { color: red; }",
  };
  const base = memoryWorkspace(files);
  return new ScssSourcePlugin().resolve({
    selection: selection([cssTarget(
      "selected",
      ".card",
      "/assets/app.css",
    )]),
    document: document(activeUri, files[activeUri]),
    workspace: {
      ...base,
      resolveSourceUri: async (sourceUrl, baseUrl) =>
        sourceUrl === "/assets/app.css"
          ? resolution
          : base.resolveSourceUri(sourceUrl, baseUrl),
    },
    signal: new AbortController().signal,
  });
}

async function resolveScss(
  activeUri: string,
  activeText: string,
  files: Readonly<Record<string, string>>,
  selected: SelectionSnapshot,
) {
  return new ScssSourcePlugin().resolve({
    selection: selected,
    document: document(activeUri, activeText),
    workspace: memoryWorkspace(files),
    signal: new AbortController().signal,
  });
}

function memoryWorkspace(
  files: Readonly<Record<string, string>>,
): SourceWorkspace {
  return {
    findFiles: async () => Object.keys(files),
    async readText(uri) {
      const text = files[uri];
      if (text === undefined) throw new Error(`Missing fixture: ${uri}`);
      return text;
    },
    async resolveSourceUri(sourceUrl, baseUrl) {
      const resolved = new URL(sourceUrl, baseUrl);
      if (
        resolved.protocol === "file:" &&
        resolved.toString().startsWith("file:///workspace/")
      ) {
        return {
          uris: [resolved.toString()],
          status: "exact",
          strategy: "workspace-bound",
          workspaceFolderUri: "file:///workspace",
        };
      }
      const pathname = decodeURIComponent(resolved.pathname);
      const exact = Object.keys(files).filter((uri) =>
        decodeURIComponent(new URL(uri).pathname).endsWith(pathname),
      );
      if (exact.length === 1) {
        return { uris: exact, status: "exact", strategy: "automatic" };
      }
      if (exact.length > 1) {
        return { uris: [], status: "ambiguous", strategy: "automatic" };
      }
      const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
      const fallback = Object.keys(files).filter((uri) =>
        decodeURIComponent(new URL(uri).pathname).endsWith(`/${basename}`),
      );
      if (fallback.length === 1) {
        return {
          uris: fallback,
          status: "unique-basename",
          strategy: "automatic",
        };
      }
      return {
        uris: [],
        status: fallback.length > 1 ? "ambiguous" : "not-found",
        strategy: "automatic",
      };
    },
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
  };
}

function selection(
  targets: readonly InspectTarget[],
  url = "http://localhost:4173/page",
): SelectionSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets,
    context: { url, metadata: {} },
    metadata: {},
  };
}

function cssTarget(
  role: "selected" | "parent",
  selector: string,
  sourceUrl: string,
  options: {
    readonly property?: string;
    readonly value?: string;
    readonly rulePath?: string;
  } = {},
): InspectTarget & { facts: CssRuleFact[] } {
  return {
    role,
    depth: role === "selected" ? 0 : 1,
    subject: { selector, metadata: {} },
    facts: [
      {
        type: "css-rule",
        selector,
        property: options.property ?? "color",
        value: options.value ?? "red",
        metadata: {
          sourceUrl,
          media: [],
          mediaTruncated: false,
          rulePath: options.rulePath ?? "0.0",
          valueTruncated: false,
          important: false,
        },
      },
    ],
    metadata: {},
  };
}

function document(uri: string, text: string): SourceDocument {
  const lines = text.split("\n");
  return {
    uri,
    languageId: "scss",
    version: 1,
    getText: () => text,
    positionAt(offset) {
      const before = text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n");
      return { line: before.length - 1, character: before.at(-1)?.length ?? 0 };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      return lines.slice(0, line).reduce((total, value) => total + value.length + 1, 0) +
        Math.max(0, Math.min(position.character, lines[line]?.length ?? 0));
    },
  };
}

function snippets(text: string, matches: readonly SourceMatch[]): string[] {
  const source = document("file:///snippet.scss", text);
  return matches.map((match) => text.slice(
    source.offsetAt(match.range.start),
    source.offsetAt(match.range.end),
  ));
}
