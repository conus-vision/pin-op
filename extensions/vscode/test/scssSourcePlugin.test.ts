import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceMatch,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { CssRuleFact, InspectTarget } from "@browser2ide/protocol";
import { ScssSourcePlugin } from "../src/sourcePlugins/scssSourcePlugin.js";

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

  it("does not trust a unique-basename source-map target as active", async () => {
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
            return { uris: [activeUri], status: "unique-basename" };
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
  });

  it("does not trust a unique-basename generated stylesheet path", async () => {
    const activeUri = "file:///workspace/src/card.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const files = {
      [activeUri]: ".card { color: red; }",
      [generatedUri]: ".card { color: red; }",
    };
    const baseWorkspace = memoryWorkspace(files);
    const reads: string[] = [];
    const result = await new ScssSourcePlugin().resolve({
      selection: selection([cssTarget(
        "selected",
        ".card",
        "/dist/app.css",
      )]),
      document: document(activeUri, files[activeUri]),
      workspace: {
        ...baseWorkspace,
        async readText(uri) {
          reads.push(uri);
          return baseWorkspace.readText(uri);
        },
        async resolveSourceUri(sourceUrl, baseUrl) {
          if (sourceUrl === "/dist/app.css") {
            return { uris: [generatedUri], status: "unique-basename" };
          }
          return baseWorkspace.resolveSourceUri(sourceUrl, baseUrl);
        },
      },
      signal: new AbortController().signal,
    });

    expect(result.matches).toEqual([]);
    expect(reads).toEqual([]);
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
        return { uris: [resolved.toString()], status: "exact" };
      }
      const pathname = decodeURIComponent(resolved.pathname);
      const exact = Object.keys(files).filter((uri) =>
        decodeURIComponent(new URL(uri).pathname).endsWith(pathname),
      );
      if (exact.length === 1) return { uris: exact, status: "exact" };
      if (exact.length > 1) return { uris: [], status: "ambiguous" };
      const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
      const fallback = Object.keys(files).filter((uri) =>
        decodeURIComponent(new URL(uri).pathname).endsWith(`/${basename}`),
      );
      if (fallback.length === 1) {
        return { uris: fallback, status: "unique-basename" };
      }
      return {
        uris: [],
        status: fallback.length > 1 ? "ambiguous" : "not-found",
      };
    },
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
  };
}

function selection(targets: readonly InspectTarget[]): SelectionSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets,
    context: { url: "http://localhost:4173/page", metadata: {} },
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
