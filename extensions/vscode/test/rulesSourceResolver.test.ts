import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { SourceMapGenerator } from "source-map";
import { describe, expect, it, vi } from "vitest";
import type { SourceWorkspace } from "@pin-op/plugin-api";
import {
  RULE_EVIDENCE_LIMITS,
  utf8ByteLength,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
} from "@pin-op/protocol";
import {
  RULES_SOURCE_BATCH_MAX_BYTES,
  RulesSourceResolver,
  projectRulesSource,
} from "../src/rules/rulesSourceResolver.js";
import {
  RULES_STYLESHEET_MAX_BYTES,
  RULES_STYLESHEET_MAX_RULES,
  StylesheetAstCache,
} from "../src/sourcePlugins/stylesheetAst.js";
import {
  RULES_SOURCE_MAP_MAX_BYTES,
  RULES_SOURCE_MAP_MAX_MAPPINGS,
} from "../src/sourcePlugins/sourceMapLoader.js";
import {
  RulesSourceSnapshotLimitError,
} from "../src/sourcePlugins/sourceWorkspace.js";

describe("RulesSourceResolver", () => {
  it("publishes conservative Rules resolution budgets", () => {
    expect(RULES_STYLESHEET_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(RULES_STYLESHEET_MAX_RULES).toBe(4_096);
    expect(RULES_SOURCE_MAP_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(RULES_SOURCE_MAP_MAX_MAPPINGS).toBe(65_536);
    expect(RULES_SOURCE_BATCH_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it("caps retained text across 256 unique CSS, map, and SCSS sources", async () => {
    const files: Record<string, string> = {};
    const rules: InspectRuleEvidence[] = [];
    const retainedWeights: number[] = [];
    for (let index = 0; index < RULE_EVIDENCE_LIMITS.rules; index += 1) {
      const cssUri = `file:///workspace/dist/rule-${index}.css`;
      const mapUri = `${cssUri}.map`;
      const scssUri = `file:///workspace/src/rule-${index}.scss`;
      const selector = `.rule-${index}`;
      const ruleText = `${selector} { color: red; }`;
      const generator = new SourceMapGenerator({ file: `rule-${index}.css` });
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 1, column: 0 },
        source: `../src/rule-${index}.scss`,
      });
      files[cssUri] = `${ruleText}\n/*# sourceMappingURL=rule-${index}.css.map */`;
      files[mapUri] = generator.toString();
      files[scssUri] = ruleText;
      retainedWeights.push(
        utf8ByteLength(files[cssUri]) +
          utf8ByteLength(files[mapUri]) +
          utf8ByteLength(files[scssUri]),
      );
      rules.push(evidence({
        selector,
        sourceUrl: `http://localhost:4173/dist/rule-${index}.css`,
        startLine: 1,
        startColumn: 1,
        rulePath: "0.0",
        declarations: [{ property: "color", value: "red" }],
      }));
    }
    const resolver = new RulesSourceResolver(
      memoryWorkspace(files),
      undefined,
      undefined,
      { maxRetainedSourceBytes: retainedWeights[0] },
    );

    const batch = await resolver.resolve({
      selectionMessageId: "inspect-aggregate-budget",
      pageUrl: "http://localhost:4173/page",
      ruleEvidence: { rules, omittedRuleCount: 0 },
      signal: new AbortController().signal,
    });

    expect(batch.results[0]).toMatchObject({
      kind: "resolved",
      confidence: "sourcemap",
    });
    expect(batch.results.slice(1)).toHaveLength(
      RULE_EVIDENCE_LIMITS.rules - 1,
    );
    expect(batch.results.slice(1).every((result) =>
      result.kind === "unresolved" && result.reason === "source-budget-exceeded"
    )).toBe(true);
  });

  it("fails closed when the workspace lacks real document snapshots", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const capable = memoryWorkspace({
      [cssUri]: ".card { color: red; }",
    });
    const workspace: SourceWorkspace = {
      findFiles: capable.findFiles.bind(capable),
      readText: capable.readText.bind(capable),
      resolveSourceUri: capable.resolveSourceUri.bind(capable),
      resolveRelativeUri: capable.resolveRelativeUri.bind(capable),
      isWorkspaceUri: capable.isWorkspaceUri.bind(capable),
    };

    await expect(resolveOne(
      workspace,
      evidence({ selector: ".card" }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "rules-source-snapshot-unavailable",
    });
  });

  it("fails closed when the snapshot workspace lacks a change generation", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const capable = memoryWorkspace({
      [cssUri]: ".card { color: red; }",
    });
    const { currentRulesSourceGeneration: _generation, ...workspace } = capable;

    await expect(resolveOne(
      workspace,
      evidence({ selector: ".card" }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "rules-source-snapshot-unavailable",
    });
  });

  it("uses dirty snapshot text and retains real versions only internally", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const base = memoryWorkspace({
      [cssUri]: ".card { color: blue; }",
    });
    let rawReads = 0;
    const workspace = {
      ...base,
      async readText() {
        rawReads += 1;
        throw new Error("Rules must not read disk text");
      },
      async readRulesSourceSnapshot(uri: string) {
        return {
          uri,
          text: ".card { color: red; }",
          documentVersion: 17,
        };
      },
    } as SourceWorkspace & {
      readRulesSourceSnapshot(
        uri: string,
        maxBytes: number,
        signal?: AbortSignal,
      ): Promise<{
        readonly uri: string;
        readonly text: string;
        readonly documentVersion: number;
      }>;
    };
    const result = await resolveOne(
      workspace,
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      document: {
        uri: cssUri,
        languageId: "css",
        version: 17,
      },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 21 },
      },
      dependencies: [{
        kind: "generated-css",
        uri: cssUri,
        documentVersion: 17,
      }],
    });
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(projectRulesSource(result)).toEqual({
      ruleRef: result.ruleRef,
      document: { label: "app.css", languageId: "css" },
      startLine: 1,
      startColumn: 1,
      confidence: "exact",
    });
    expect(projectRulesSource(result)).not.toHaveProperty("uri");
    expect(projectRulesSource(result)).not.toHaveProperty("range");
    expect(projectRulesSource(result)).not.toHaveProperty("version");
    expect(projectRulesSource(result)).not.toHaveProperty("dependencies");
    expect(projectRulesSource(result).document).not.toHaveProperty("uri");
    expect(projectRulesSource(result).document).not.toHaveProperty("version");
    expect(rawReads).toBe(0);
  });

  it("resolves and projects an exact generated CSS block by position and rule path", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = [
      ".other { color: blue; }",
      ".card { color: red !important; display: grid; }",
    ].join("\n");
    const workspace = memoryWorkspace({ [cssUri]: css });
    const rule = evidence({
      selector: ".card",
      sourceUrl: "http://localhost:4173/dist/app.css?v=7",
      startLine: 2,
      startColumn: 1,
      rulePath: "0.1",
      declarations: [
        { property: "color", value: "red", important: true },
        { property: "display", value: "grid" },
      ],
    });

    const result = await resolveOne(workspace, rule);

    expect(result).toMatchObject({
      kind: "resolved",
      ruleRef: rule.ruleRef,
      document: {
        uri: cssUri,
        languageId: "css",
      },
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: css.split("\n")[1]!.length },
      },
      confidence: "exact",
      dependencies: [{
        kind: "generated-css",
        uri: cssUri,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(projectRulesSource(result)).toEqual({
      ruleRef: rule.ruleRef,
      document: { label: "app.css", languageId: "css" },
      startLine: 2,
      startColumn: 1,
      confidence: "exact",
    });
    expect(projectRulesSource(result)).not.toHaveProperty("uri");
    expect(projectRulesSource(result)).not.toHaveProperty("range");
    expect(projectRulesSource(result)).not.toHaveProperty("version");
    expect(projectRulesSource(result)).not.toHaveProperty("dependencies");
    expect(result.document.version).toBe(1);
    expect(Object.isFrozen(result.dependencies)).toBe(true);
    expect(result.dependencies.every(Object.isFrozen)).toBe(true);
  });

  it("refuses unique-basename candidates as non-exact workspace matches", async () => {
    const candidate = "file:///workspace/other/app.css";
    const base = memoryWorkspace({ [candidate]: ".card { color: red; }" });
    const workspace: SourceWorkspace = {
      ...base,
      resolveSourceUri: async () => ({
        uris: [candidate],
        status: "unique-basename",
        strategy: "automatic",
      }),
    };
    const rule = evidence({ selector: ".card" });

    await expect(resolveOne(workspace, rule)).resolves.toEqual({
      kind: "unresolved",
      ruleRef: rule.ruleRef,
      reason: "non-exact-workspace-match",
    });
  });

  it("uses the exact selector-start mapping and never a declaration-body mixin mapping", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/card.scss";
    const mixinUri = "file:///workspace/src/mixins.scss";
    const scss = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 7 },
      original: { line: 1, column: 0 },
      source: "../src/mixins.scss",
    });
    generator.setSourceContent("../src/card.scss", scss);
    const css = ".card { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const workspace = memoryWorkspace({
      [cssUri]: css,
      [mapUri]: generator.toString(),
      [scssUri]: scss,
      [mixinUri]: "@mixin paint { color: red; }",
    });
    const rule = evidence({
      selector: ".card",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: scss.length + 1,
      rulePath: "0.0",
    });

    const result = await resolveOne(workspace, rule);

    expect(result).toMatchObject({
      kind: "resolved",
      ruleRef: rule.ruleRef,
      document: {
        uri: scssUri,
        languageId: "scss",
      },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: scss.length },
      },
      confidence: "sourcemap",
      dependencies: [
        {
          kind: "generated-css",
          uri: cssUri,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          kind: "external-source-map",
          uri: mapUri,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          kind: "original-source",
          uri: scssUri,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
  });

  it.each([
    ["a declaration-body start", 9, undefined],
    ["a mismatched end", 1, 10],
    ["a zero-length range", 1, 1],
  ])("limits %s to unique-fingerprint CSS fallback", async (
    _case,
    startColumn,
    endColumn,
  ) => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const scss = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const css = `${scss}\n/*# sourceMappingURL=app.css.map */`;
    const rule = evidence({
      selector: ".card",
      startLine: 1,
      startColumn,
      ...(endColumn === undefined
        ? {}
        : { endLine: 1, endColumn }),
      rulePath: "0.0",
    });

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: scss,
    }), rule);

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("does not promote a rule-path match with an end-only range to SCSS", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const rule = evidence({ selector: ".card", rulePath: "0.0" });
    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: block,
    }), {
      ...rule,
      generatedSource: {
        ...rule.generatedSource!,
        endLine: 1,
        endColumn: block.length + 1,
      },
    });

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("fences generated CSS after unique-fingerprint relocation", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const initial = ".card { color: red; }";
    const base = memoryWorkspace({ [cssUri]: initial });
    let reads = 0;
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        if (uri === cssUri && ++reads > 1) {
          return ".card { color: blue; }";
        }
        return base.readText(uri);
      },
    };

    await expect(resolveOne(workspace, evidence({
      selector: ".card",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
      rulePath: "0.0",
    }))).resolves.toMatchObject({
      kind: "unresolved",
      reason: "stale-input",
    });
    expect(reads).toBe(2);
  });

  it("distinguishes identical rules by numeric path and ordered media/supports ancestry", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = [
      "@supports (display: flex) {",
      "  .card { color: red; }",
      "}",
      "@media (min-width: 40rem) {",
      "  @supports (display: grid) {",
      "    .card { color: red; }",
      "  }",
      "}",
    ].join("\n");
    const rule = evidence({
      selector: ".card",
      rulePath: "0.1.0.0",
      contexts: [
        { kind: "media", conditionText: " (min-width:40rem) " },
        { kind: "supports", conditionText: "(display:grid)" },
      ],
    });

    const result = await resolveOne(memoryWorkspace({ [cssUri]: css }), rule);

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      range: { start: { line: 5, character: 4 } },
      confidence: "exact",
    });
  });

  it("relocates one complete fingerprint to verified CSS but never promotes it through a map", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const css = [
      ".moved { color: blue; }",
      ".card { color: red; display: grid; }",
      "/*# sourceMappingURL=app.css.map */",
    ].join("\n");
    const rule = evidence({
      selector: ".card",
      startLine: 1,
      startColumn: 1,
      rulePath: "0.0",
      declarations: [
        { property: "color", value: "red" },
        { property: "display", value: "grid" },
      ],
    });

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: ".card { color: red; display: grid; }",
    }), rule);

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      range: { start: { line: 1, character: 0 } },
      confidence: "exact",
    });
  });

  it("fails closed for ambiguous fingerprints and downgrades invalid positions to CSS", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const duplicate = [
      ".card { color: red; }",
      ".card { color: red; }",
    ].join("\n");
    const ambiguous = evidence({
      selector: ".card",
      rulePath: "0.99",
    });
    const unique = evidence({
      selector: ".card",
      startLine: 99,
      startColumn: 1,
      rulePath: "0.99",
    });

    await expect(resolveOne(
      memoryWorkspace({ [cssUri]: duplicate }),
      ambiguous,
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "generated-css-not-exact",
    });
    await expect(resolveOne(
      memoryWorkspace({ [cssUri]: ".card { color: red; }" }),
      unique,
    )).resolves.toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("rejects changed CSS, parse errors, incomplete evidence, and unsupported grouping", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const changed = evidence({ selector: ".card" });
    const parseError = evidence({ selector: ".card" });
    const truncated = {
      ...evidence({ selector: ".card" }),
      declarationsTruncated: true,
    } as InspectRuleEvidence;
    const unsupportedBase = evidence({ selector: ".card" });
    const unsupported = {
      ...unsupportedBase,
      generatedSource: {
        ...unsupportedBase.generatedSource!,
        unsupportedGroupContext: true,
      },
    } as InspectRuleEvidence;

    await expect(resolveOne(memoryWorkspace({
      [cssUri]: ".card { color: blue; }",
    }), changed)).resolves.toMatchObject({ kind: "unresolved" });
    await expect(resolveOne(memoryWorkspace({
      [cssUri]: ".card { color: red; ",
    }), parseError)).resolves.toMatchObject({
      kind: "unresolved",
      reason: "generated-source-parse-error",
    });
    await expect(resolveOne(memoryWorkspace({
      [cssUri]: ".card { color: red; }",
    }), truncated)).resolves.toMatchObject({
      kind: "unresolved",
      reason: "incomplete-rule-evidence",
    });
    await expect(resolveOne(memoryWorkspace({
      [cssUri]: "@layer theme { .card { color: red; } }",
    }), unsupported)).resolves.toMatchObject({
      kind: "unresolved",
      reason: "incomplete-rule-evidence",
    });
  });

  it("falls back to independently verified CSS for missing, invalid, or unmapped maps", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const fixtures = [
      ".card { color: red; }",
      ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
      `.card { color: red; }\n/*# sourceMappingURL=data:application/json,${
        encodeURIComponent(JSON.stringify({
          version: 3,
          file: "app.css",
          sources: ["../src/card.scss"],
          names: [],
          mappings: "",
        }))
      } */`,
    ];
    for (const [index, css] of fixtures.entries()) {
      const files: Record<string, string> = { [cssUri]: css };
      if (index === 1) files[`${cssUri}.map`] = "{not-json";
      const result = await resolveOne(
        memoryWorkspace(files),
        evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
      );
      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    }
  });

  it("falls back to CSS when selector-prelude mappings contradict or omit the exact start", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = ".card, .tile { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const contradictory = new SourceMapGenerator({ file: "app.css" });
    contradictory.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    contradictory.addMapping({
      generated: { line: 1, column: 7 },
      original: { line: 1, column: 0 },
      source: "../src/tile.scss",
    });
    const noStart = new SourceMapGenerator({ file: "app.css" });
    noStart.addMapping({
      generated: { line: 1, column: 1 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    for (const map of [contradictory, noStart]) {
      const result = await resolveOne(memoryWorkspace({
        [cssUri]: css,
        [`${cssUri}.map`]: map.toString(),
        "file:///workspace/src/card.scss": ".card, .tile { color: red; }",
        "file:///workspace/src/tile.scss": ".card, .tile { color: red; }",
      }), evidence({ selector: ".card, .tile", startLine: 1, startColumn: 1 }));
      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    }
  });

  it("falls back to CSS when same-file selector mappings point at different SCSS rules", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const selector = ".card, .tile";
    const block = `${selector} { color: red; }`;
    const scss = `${block}\n${block}`;
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 1, column: 7 },
      original: { line: 2, column: 0 },
      source: "../src/card.scss",
    });
    generator.setSourceContent("../src/card.scss", scss);

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: scss,
    }), evidence({
      selector,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: block.length + 1,
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("falls back to CSS when the selector start maps into the original declaration body", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 8 },
      source: "../src/card.scss",
    });
    generator.setSourceContent("../src/card.scss", block);

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: block,
    }), evidence({
      selector: ".card",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: block.length + 1,
    }));

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it.each(["css", "less", "pcss"])(
    "does not label a mapped .%s target as SCSS",
    async (extension) => {
      const cssUri = "file:///workspace/dist/app.css";
      const originalUri = `file:///workspace/src/card.${extension}`;
      const block = ".card { color: red; }";
      const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
      const generator = new SourceMapGenerator({ file: "app.css" });
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 1, column: 0 },
        source: `../src/card.${extension}`,
      });

      const result = await resolveOne(memoryWorkspace({
        [cssUri]: css,
        [`${cssUri}.map`]: generator.toString(),
        [originalUri]: block,
      }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));

      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    },
  );

  it("resolves an inline map with query-bearing CSS, sourceRoot, and sourcesContent", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const scss = ".card { color: red; }";
    const generator = new SourceMapGenerator({
      file: "app.css",
      sourceRoot: "../src/",
    });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "card.scss",
    });
    generator.setSourceContent("card.scss", scss);
    const encoded = Buffer.from(generator.toString()).toString("base64");
    const css = `${scss}\n/*# sourceMappingURL=data:application/json;base64,${encoded} */`;
    const rule = evidence({
      selector: ".card",
      sourceUrl: "http://localhost:4173/dist/app.css?v=7",
      startLine: 1,
      startColumn: 1,
    });

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [scssUri]: scss,
    }), rule);

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: scssUri, languageId: "scss" },
      confidence: "sourcemap",
      dependencies: [
        { kind: "generated-css", uri: cssUri },
        { kind: "original-source", uri: scssUri },
      ],
    });
    if (result.kind !== "resolved") throw new Error("expected resolution");
    expect(result.dependencies.map(({ kind }) => kind)).toEqual([
      "generated-css",
      "original-source",
    ]);
  });

  it("charges encoded and decoded inline source-map text to the batch budget", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const scss = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const rawMap = generator.toString();
    const reference = `data:application/json;base64,${
      Buffer.from(rawMap).toString("base64")
    }`;
    const css = `${scss}\n/*# sourceMappingURL=${reference} */`;
    const resolver = new RulesSourceResolver(
      memoryWorkspace({ [cssUri]: css, [scssUri]: scss }),
      undefined,
      undefined,
      {
        maxRetainedSourceBytes: utf8ByteLength(css) +
          utf8ByteLength(reference) +
          utf8ByteLength(rawMap) - 1,
      },
    );

    const batch = await resolver.resolve({
      selectionMessageId: "inspect-inline-budget",
      pageUrl: "http://localhost:4173/page",
      ruleEvidence: {
        rules: [evidence({
          selector: ".card",
          startLine: 1,
          startColumn: 1,
        })],
        omittedRuleCount: 0,
      },
      signal: new AbortController().signal,
    });

    expect(batch.results).toMatchObject([{
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    }]);
  });

  it("verifies nested SCSS selectors and ordered contexts at the smallest containing rule with CRLF", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const contexts = [
      { kind: "media", conditionText: "(min-width: 40rem)" },
      { kind: "supports", conditionText: "(display: grid)" },
    ] as const;
    const css = [
      "@media (min-width: 40rem) {",
      "  @supports (display: grid) {",
      "    .card__title { color: red; display: grid; }",
      "  }",
      "}",
      "/*# sourceMappingURL=app.css.map */",
    ].join("\r\n");
    const scss = [
      "@media (min-width: 40rem) {",
      "  @supports (display: grid) {",
      "    .card {",
      "      &__title { color: red; display: grid; }",
      "    }",
      "  }",
      "}",
    ].join("\r\n");
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 3, column: 4 },
      original: { line: 4, column: 6 },
      source: "../src/card.scss",
    });
    generator.setSourceContent("../src/card.scss", scss);
    const rule = evidence({
      selector: ".card__title",
      startLine: 3,
      startColumn: 5,
      rulePath: "0.0.0.0",
      contexts,
      declarations: [
        { property: "color", value: "red" },
        { property: "display", value: "grid" },
      ],
    });

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: scss,
    }), rule);

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: scssUri, languageId: "scss" },
      range: { start: { line: 3, character: 6 } },
      confidence: "sourcemap",
    });
  });

  it("resolves a bounded batch across multiple original SCSS files", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const cardUri = "file:///workspace/src/card.scss";
    const tileUri = "file:///workspace/src/tile.scss";
    const card = ".card { color: red; }";
    const tile = ".tile { color: blue; }";
    const css = `${card}\n${tile}\n/*# sourceMappingURL=app.css.map */`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/tile.scss",
    });
    generator.setSourceContent("../src/card.scss", card);
    generator.setSourceContent("../src/tile.scss", tile);
    const rules = [
      evidence({
        selector: ".card",
        startLine: 1,
        startColumn: 1,
        rulePath: "0.0",
        declarations: [{ property: "color", value: "red" }],
      }),
      evidence({
        selector: ".tile",
        startLine: 2,
        startColumn: 1,
        rulePath: "0.1",
        declarations: [{ property: "color", value: "blue" }],
      }),
    ];

    const batch = await resolveBatch(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [cardUri]: card,
      [tileUri]: tile,
    }), rules);

    expect(batch.results).toMatchObject([
      {
        kind: "resolved",
        document: { uri: cardUri, languageId: "scss" },
        confidence: "sourcemap",
      },
      {
        kind: "resolved",
        document: { uri: tileUri, languageId: "scss" },
        confidence: "sourcemap",
      },
    ]);
  });

  it("keeps CSS authority when the original is missing, outside, stale, invalid, or unverifiable", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    generator.setSourceContent("../src/card.scss", ".card { color: red; }");
    const css = ".card { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const baseFiles = {
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
    };
    const variants: readonly Readonly<Record<string, string>>[] = [
      baseFiles,
      { ...baseFiles, [scssUri]: ".card { color: blue; }" },
      { ...baseFiles, [scssUri]: ".card { color: red; " },
      { ...baseFiles, [scssUri]: ".card { @include paint; }" },
    ];
    for (const files of variants) {
      const result = await resolveOne(
        memoryWorkspace(files),
        evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
      );
      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    }

    const outside = "file:///outside/card.scss";
    const outsideBase = memoryWorkspace({
      ...baseFiles,
      [outside]: ".card { color: red; }",
    });
    const outsideWorkspace: SourceWorkspace = {
      ...outsideBase,
      async resolveSourceUri(sourceUrl, baseUrl) {
        if (sourceUrl.endsWith("/src/card.scss")) {
          return {
            uris: [outside],
            status: "exact",
            strategy: "automatic",
          };
        }
        return outsideBase.resolveSourceUri(sourceUrl, baseUrl);
      },
    };
    await expect(resolveOne(
      outsideWorkspace,
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    )).resolves.toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
    });
  });

  it("falls back to CSS for ambiguous original matches, original parse errors, and mixin-only declarations", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const css = ".card { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const ambiguous = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [mapUri]: generator.toString(),
      "file:///workspace/packages/a/src/card.scss": ".card { color: red; }",
      "file:///workspace/packages/b/src/card.scss": ".card { color: red; }",
    }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));
    expect(ambiguous).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });

    for (const scss of [
      ".card { color: red; ",
      ".card { @include paint; }",
    ]) {
      const result = await resolveOne(memoryWorkspace({
        [cssUri]: css,
        [mapUri]: generator.toString(),
        "file:///workspace/src/card.scss": scss,
      }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));
      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    }
  });

  it("rejects ambiguous and outside generated CSS before reading it", async () => {
    const rule = evidence({ selector: ".card" });
    const base = memoryWorkspace({});
    for (const resolution of [
      {
        uris: [],
        status: "ambiguous",
        strategy: "automatic",
      },
      {
        uris: ["file:///outside/app.css"],
        status: "exact",
        strategy: "automatic",
      },
    ] as const) {
      const workspace: SourceWorkspace = {
        ...base,
        resolveSourceUri: async () => resolution,
      };
      await expect(resolveOne(workspace, rule)).resolves.toMatchObject({
        kind: "unresolved",
        reason: "non-exact-workspace-match",
      });
    }
  });

  it("fails closed for cancellation, stale input, omitted evidence, and duplicate refs", async () => {
    const workspace = memoryWorkspace({
      "file:///workspace/dist/app.css": ".card { color: red; }",
    });
    const rule = evidence({ selector: ".card" });
    const controller = new AbortController();
    controller.abort();
    await expect(resolveBatch(workspace, [rule], {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(resolveBatch(workspace, [rule], {
      isCurrent: () => false,
    })).resolves.toMatchObject({
      results: [{ kind: "unresolved", reason: "stale-input" }],
    });
    await expect(resolveBatch(workspace, [rule], {
      omittedRuleCount: 1,
    })).resolves.toMatchObject({
      results: [{
        kind: "unresolved",
        reason: "truncated-rule-evidence",
      }],
    });
    await expect(resolveBatch(workspace, [rule, rule])).resolves.toMatchObject({
      results: [{ kind: "unresolved", reason: "duplicate-rule-ref" }],
    });
  });

  it("aborts promptly while exact workspace resolution is still pending", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const base = memoryWorkspace({ [cssUri]: ".card { color: red; }" });
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const workspace: SourceWorkspace = {
      ...base,
      async resolveSourceUri(sourceUrl, baseUrl) {
        markStarted();
        await gate;
        return base.resolveSourceUri(sourceUrl, baseUrl);
      },
    };
    const controller = new AbortController();
    const pending = resolveBatch(
      workspace,
      [evidence({ selector: ".card" })],
      { signal: controller.signal },
    );
    let observed: unknown;
    void pending.catch((error: unknown) => {
      observed = error;
    });
    await started;

    controller.abort();
    await flushMicrotasks();
    const promptOutcome = observed;
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(promptOutcome).toMatchObject({ name: "AbortError" });
  });

  it("aborts promptly while a generated stylesheet read is still pending", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const base = memoryWorkspace({ [cssUri]: ".card { color: red; }" });
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        if (uri === cssUri) {
          markStarted();
          await gate;
        }
        return base.readText(uri);
      },
    };
    const controller = new AbortController();
    const pending = resolveBatch(
      workspace,
      [evidence({ selector: ".card" })],
      { signal: controller.signal },
    );
    let observed: unknown;
    void pending.catch((error: unknown) => {
      observed = error;
    });
    await started;

    controller.abort();
    await flushMicrotasks();
    const promptOutcome = observed;
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(promptOutcome).toMatchObject({ name: "AbortError" });
  });

  it("invalidates a source-map result if generated CSS changes during resolution", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const initial = ".card { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const base = memoryWorkspace({
      [cssUri]: initial,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: ".card { color: red; }",
    });
    let generatedReads = 0;
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        if (uri === cssUri && ++generatedReads > 1) {
          return ".card { color: blue; }";
        }
        return base.readText(uri);
      },
    };

    await expect(resolveOne(
      workspace,
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "stale-input",
    });
  });

  it("invalidates a CSS fallback if generated content changes while its map is read", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const initial = ".card { color: red; }\n/*# sourceMappingURL=app.css.map */";
    const base = memoryWorkspace({
      [cssUri]: initial,
      [`${cssUri}.map`]: "{not-json",
    });
    let generatedReads = 0;
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        if (uri === cssUri && ++generatedReads > 1) {
          return ".card { color: blue; }";
        }
        return base.readText(uri);
      },
    };

    await expect(resolveOne(
      workspace,
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "stale-input",
    });
  });

  it("does not emit SCSS when an external map changes after its initial read", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const initialMap = generator.toString();
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const base = memoryWorkspace({
      [cssUri]: css,
      [mapUri]: initialMap,
      [scssUri]: block,
    });
    let mapReads = 0;
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        if (uri === mapUri && ++mapReads > 1) {
          return `${initialMap} `;
        }
        return base.readText(uri);
      },
    };

    const result = await resolveOne(
      workspace,
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    );

    expect(mapReads).toBe(2);
    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
      dependencies: [{ kind: "generated-css", uri: cssUri }],
    });
  });

  it("rejects an oversized generated stylesheet before granting CSS authority", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = `.card { color: red; }/*${
      "x".repeat(RULES_STYLESHEET_MAX_BYTES)
    }*/`;

    await expect(resolveOne(
      memoryWorkspace({ [cssUri]: css }),
      evidence({ selector: ".card", startLine: 1, startColumn: 1 }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "generated-source-too-large",
    });
  });

  it("rejects a custom snapshot that violates the consumer byte cap", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const base = memoryWorkspace({
      [cssUri]: ".card { color: red; }",
    });
    const workspace = {
      ...base,
      async readRulesSourceSnapshot(uri: string) {
        return {
          uri,
          text: `a{}${"x".repeat(RULES_STYLESHEET_MAX_BYTES)}`,
          documentVersion: 1,
        };
      },
    };
    const ast = new StylesheetAstCache();
    const parse = vi.spyOn(ast, "parseText");

    const result = await resolveOne(
      workspace,
      evidence({ selector: ".card" }),
      ast,
    );

    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "generated-source-too-large",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects a generated stylesheet beyond the Rules AST rule limit", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = `${Array.from(
      { length: RULES_STYLESHEET_MAX_RULES },
      (_entry, index) => `.filler-${index}{}`,
    ).join("")}.target { color: red; }`;

    await expect(resolveOne(
      memoryWorkspace({ [cssUri]: css }),
      evidence({ selector: ".target", rulePath: "0.4096" }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "generated-source-too-complex",
    });
  });

  it("counts generated at-rules against the Rules AST rule limit", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const css = `.target { color: red; }${Array.from(
      { length: RULES_STYLESHEET_MAX_RULES },
      (_entry, index) => `@media filler-${index} {}`,
    ).join("")}`;

    await expect(resolveOne(
      memoryWorkspace({ [cssUri]: css }),
      evidence({ selector: ".target", rulePath: "0.0" }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "generated-source-too-complex",
    });
  });

  it("falls back to CSS for oversized original SCSS", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const scss = `${block}/*${
      "x".repeat(RULES_STYLESHEET_MAX_BYTES)
    }*/`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });

    const result = await resolveOne(memoryWorkspace({
      [cssUri]: css,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: scss,
    }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("falls back to CSS when original SCSS exceeds the at-rule AST limit", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const original = `${block}${Array.from(
      { length: RULES_STYLESHEET_MAX_RULES },
      (_entry, index) => `@mixin filler-${index} {}`,
    ).join("")}`;
    const result = await resolveOne(memoryWorkspace({
      [cssUri]: `${block}\n/*# sourceMappingURL=app.css.map */`,
      [`${cssUri}.map`]: generator.toString(),
      [scssUri]: original,
    }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));

    expect(result).toMatchObject({
      kind: "resolved",
      document: { uri: cssUri, languageId: "css" },
      confidence: "exact",
    });
  });

  it("falls back to CSS for oversized or over-indexed external maps", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/card.scss";
    const block = ".card { color: red; }";
    const css = `${block}\n/*# sourceMappingURL=app.css.map */`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const oversized = `${generator.toString()}${
      " ".repeat(RULES_SOURCE_MAP_MAX_BYTES)
    }`;
    const overIndexed = JSON.stringify({
      version: 3,
      file: "app.css",
      sources: ["../src/card.scss"],
      names: [],
      mappings: [
        "AAAA",
        ...Array(RULES_SOURCE_MAP_MAX_MAPPINGS).fill("CAAA"),
      ].join(","),
    });

    for (const map of [oversized, overIndexed]) {
      const result = await resolveOne(memoryWorkspace({
        [cssUri]: css,
        [mapUri]: map,
        [scssUri]: block,
      }), evidence({ selector: ".card", startLine: 1, startColumn: 1 }));
      expect(result).toMatchObject({
        kind: "resolved",
        document: { uri: cssUri, languageId: "css" },
        confidence: "exact",
      });
    }
  });

  it("coalesces repeated generated/map/original reads and parses within one batch", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/components.scss";
    const card = ".card { color: red; }";
    const tile = ".tile { color: blue; }";
    const stylesheet = `${card}\n${tile}`;
    const css = `${stylesheet}\n/*# sourceMappingURL=app.css.map */`;
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/components.scss",
    });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 2, column: 0 },
      source: "../src/components.scss",
    });
    generator.setSourceContent("../src/components.scss", stylesheet);
    const base = memoryWorkspace({
      [cssUri]: css,
      [mapUri]: generator.toString(),
      [scssUri]: stylesheet,
    });
    const reads = new Map<string, number>();
    let resolutions = 0;
    const workspace: SourceWorkspace = {
      ...base,
      async readText(uri) {
        reads.set(uri, (reads.get(uri) ?? 0) + 1);
        return base.readText(uri);
      },
      async resolveSourceUri(sourceUrl, baseUrl) {
        resolutions += 1;
        return base.resolveSourceUri(sourceUrl, baseUrl);
      },
    };
    const ast = new StylesheetAstCache();
    const parse = vi.spyOn(ast, "parseText");
    const rules = [
      evidence({
        selector: ".card",
        startLine: 1,
        startColumn: 1,
        rulePath: "0.0",
        declarations: [{ property: "color", value: "red" }],
      }),
      evidence({
        selector: ".tile",
        startLine: 2,
        startColumn: 1,
        rulePath: "0.1",
        declarations: [{ property: "color", value: "blue" }],
      }),
    ];

    const batch = await new RulesSourceResolver(workspace, ast).resolve({
      selectionMessageId: "inspect-coalesced",
      pageUrl: "http://localhost:4173/page",
      ruleEvidence: { rules, omittedRuleCount: 0 },
      signal: new AbortController().signal,
    });

    expect(batch.results.map((result) =>
      result.kind === "resolved" ? result.document.languageId : result.kind
    )).toEqual(["scss", "scss"]);
    expect(reads).toEqual(new Map([
      [cssUri, 3],
      [mapUri, 3],
      [scssUri, 3],
    ]));
    expect(resolutions).toBe(2);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("coalesces query and fragment aliases by canonical map snapshot", async () => {
    const firstCssUri = "file:///workspace/dist/first.css";
    const secondCssUri = "file:///workspace/dist/second.css";
    const mapUri = "file:///workspace/dist/shared.map";
    const scssUri = "file:///workspace/src/card.scss";
    const ruleText = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "shared.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const firstMapText = generator.toString();
    const secondMapText = JSON.stringify({
      ...JSON.parse(firstMapText),
      file: "changed.css",
    });
    const files: Record<string, string> = {
      [firstCssUri]: `${ruleText}\n/*# sourceMappingURL=shared.map?v=1 */`,
      [secondCssUri]: `${ruleText}\n/*# sourceMappingURL=shared.map?v=2#fragment */`,
      [mapUri]: firstMapText,
      [scssUri]: ruleText,
    };
    const base = memoryWorkspace(files);
    let canonicalMapReads = 0;
    const workspace = {
      ...base,
      async readRulesSourceSnapshot(
        uri: string,
        maxBytes: number,
        signal?: AbortSignal,
      ) {
        if (stripQueryAndFragment(uri) === mapUri) canonicalMapReads += 1;
        return base.readRulesSourceSnapshot(uri, maxBytes, signal);
      },
    };
    const resolver = new RulesSourceResolver(workspace);
    const parse = vi.spyOn(JSON, "parse");
    const update = vi.spyOn(
      Object.getPrototypeOf(createHash("sha256")),
      "update",
    );
    const rules = [
      evidence({
        selector: ".card",
        sourceUrl: "http://localhost:4173/dist/first.css",
        startLine: 1,
        startColumn: 1,
      }),
      evidence({
        selector: ".card",
        sourceUrl: "http://localhost:4173/dist/second.css",
        startLine: 1,
        startColumn: 1,
      }),
    ];

    try {
      const first = await resolver.resolve({
        selectionMessageId: "inspect-map-aliases-a",
        pageUrl: "http://localhost:4173/page",
        ruleEvidence: { rules, omittedRuleCount: 0 },
      });
      expect(first.results.every((result) =>
        result.kind === "resolved" && result.document.languageId === "scss"
      )).toBe(true);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(update.mock.calls.filter(([value]) => value === firstMapText))
        .toHaveLength(3);
      expect(canonicalMapReads).toBe(3);

      files[mapUri] = secondMapText;
      await resolver.resolve({
        selectionMessageId: "inspect-map-aliases-b",
        pageUrl: "http://localhost:4173/page",
        ruleEvidence: { rules: [rules[0]!], omittedRuleCount: 0 },
      });

      expect(parse).toHaveBeenCalledTimes(2);
      expect(update.mock.calls.filter(([value]) => value === secondMapText))
        .toHaveLength(3);
      expect(canonicalMapReads).toBe(6);
    } finally {
      parse.mockRestore();
      update.mockRestore();
    }
  });

  it("validates and hashes one shared invalid map once per content hash", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const rules = Array.from(
      { length: RULE_EVIDENCE_LIMITS.rules },
      (_entry, index) => `.rule-${index} { color: red; }`,
    );
    const files: Record<string, string> = {
      [cssUri]: `${rules.join("\n")}\n/*# sourceMappingURL=app.css.map */`,
      [mapUri]: `{"version":3,"padding":"${
        "x".repeat(RULES_SOURCE_MAP_MAX_BYTES - 128)
      }`,
    };
    const workspace = memoryWorkspace(files);
    const resolver = new RulesSourceResolver(workspace);
    const parse = vi.spyOn(JSON, "parse");
    const update = vi.spyOn(
      Object.getPrototypeOf(createHash("sha256")),
      "update",
    );
    const evidenceBatch = rules.map((_text, index) => evidence({
      selector: `.rule-${index}`,
      rulePath: `0.${index}`,
      declarations: [{ property: "color", value: "red" }],
    }));

    try {
      const first = await resolver.resolve({
        selectionMessageId: "inspect-invalid-map-a",
        pageUrl: "http://localhost:4173/page",
        ruleEvidence: { rules: evidenceBatch, omittedRuleCount: 0 },
        signal: new AbortController().signal,
      });
      expect(first.results).toHaveLength(RULE_EVIDENCE_LIMITS.rules);
      expect(first.results.every((result) =>
        result.kind === "resolved" && result.document.languageId === "css"
      )).toBe(true);
      expect({
        parseCalls: parse.mock.calls.length,
        hashCalls: update.mock.calls.filter(
          ([value]) => value === files[mapUri],
        ).length,
      }).toEqual({ parseCalls: 1, hashCalls: 1 });

      const firstInvalidMap = files[mapUri]!;
      files[mapUri] = `${firstInvalidMap.slice(0, -1)}y`;
      await resolver.resolve({
        selectionMessageId: "inspect-invalid-map-b",
        pageUrl: "http://localhost:4173/page",
        ruleEvidence: { rules: [evidenceBatch[0]!], omittedRuleCount: 0 },
        signal: new AbortController().signal,
      });

      expect(parse).toHaveBeenCalledTimes(2);
      expect(update.mock.calls.filter(([value]) => value === firstInvalidMap))
        .toHaveLength(1);
      expect(update.mock.calls.filter(([value]) => value === files[mapUri]))
        .toHaveLength(1);
    } finally {
      parse.mockRestore();
      update.mockRestore();
    }
  });

  it.each([
    ["generated CSS", "generated"],
    ["external source map", "map"],
    ["original SCSS", "original"],
  ] as const)("batch-end revalidates %s after rule-one fencing", async (
    _label,
    changedKind,
  ) => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/components.scss";
    const stylesheet = [
      ".card { color: red; }",
      ".tile { color: blue; }",
    ].join("\n");
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/components.scss",
    });
    generator.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 2, column: 0 },
      source: "../src/components.scss",
    });
    const files: Record<string, string> = {
      [cssUri]: `${stylesheet}\n/*# sourceMappingURL=app.css.map */`,
      [mapUri]: generator.toString(),
      [scssUri]: stylesheet,
    };
    const targetUri = changedKind === "generated"
      ? cssUri
      : changedKind === "map"
      ? mapUri
      : scssUri;
    const base = memoryWorkspace(files);
    const reads = new Map<string, number>();
    const versions = new Map(Object.keys(files).map((uri) => [uri, 1]));
    const workspace = {
      ...base,
      async readRulesSourceSnapshot(
        uri: string,
        maxBytes: number,
        signal?: AbortSignal,
      ) {
        const count = (reads.get(uri) ?? 0) + 1;
        reads.set(uri, count);
        const snapshot = await base.readRulesSourceSnapshot(
          uri,
          maxBytes,
          signal,
        );
        const version = versions.get(uri)!;
        if (uri === targetUri && count === 2) {
          files[uri] = `${files[uri]}\n/* changed */`;
          versions.set(uri, version + 1);
        }
        return { ...snapshot, documentVersion: version };
      },
    };
    const batch = await new RulesSourceResolver(workspace).resolve({
      selectionMessageId: `inspect-stale-${changedKind}`,
      pageUrl: "http://localhost:4173/page",
      ruleEvidence: {
        rules: [
          evidence({
            selector: ".card",
            startLine: 1,
            startColumn: 1,
            rulePath: "0.0",
            declarations: [{ property: "color", value: "red" }],
          }),
          evidence({
            selector: ".tile",
            startLine: 2,
            startColumn: 1,
            rulePath: "0.1",
            declarations: [{ property: "color", value: "blue" }],
          }),
        ],
        omittedRuleCount: 0,
      },
      signal: new AbortController().signal,
    });

    expect(batch.results).toEqual([
      expect.objectContaining({ kind: "unresolved", reason: "stale-input" }),
      expect.objectContaining({ kind: "unresolved", reason: "stale-input" }),
    ]);
    expect(reads.get(targetUri)).toBe(3);
  });

  it("rejects a batch when the workspace changes during the final sweep", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const mapUri = `${cssUri}.map`;
    const scssUri = "file:///workspace/src/card.scss";
    const ruleText = ".card { color: red; }";
    const generator = new SourceMapGenerator({ file: "app.css" });
    generator.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/card.scss",
    });
    const files: Record<string, string> = {
      [cssUri]: `${ruleText}\n/*# sourceMappingURL=app.css.map */`,
      [mapUri]: generator.toString(),
      [scssUri]: ruleText,
    };
    const base = memoryWorkspace(files);
    let generation = 1;
    let mapReads = 0;
    let markMapSweepStarted!: () => void;
    const mapSweepStarted = new Promise<void>((resolve) => {
      markMapSweepStarted = resolve;
    });
    let releaseMapSweep!: () => void;
    const mapSweepGate = new Promise<void>((resolve) => {
      releaseMapSweep = resolve;
    });
    const workspace = {
      ...base,
      currentRulesSourceGeneration: () => generation,
      async readRulesSourceSnapshot(
        uri: string,
        maxBytes: number,
        signal?: AbortSignal,
      ) {
        if (uri === mapUri && ++mapReads === 3) {
          markMapSweepStarted();
          await mapSweepGate;
        }
        return base.readRulesSourceSnapshot(uri, maxBytes, signal);
      },
    };

    const pending = new RulesSourceResolver(workspace).resolve({
      selectionMessageId: "inspect-final-sweep-change",
      pageUrl: "http://localhost:4173/page",
      ruleEvidence: {
        rules: [evidence({
          selector: ".card",
          startLine: 1,
          startColumn: 1,
          rulePath: "0.0",
          declarations: [{ property: "color", value: "red" }],
        })],
        omittedRuleCount: 0,
      },
      signal: new AbortController().signal,
    });
    await mapSweepStarted;
    files[cssUri] = `${files[cssUri]}\n/* changed during sweep */`;
    generation += 1;
    releaseMapSweep();

    await expect(pending).resolves.toMatchObject({
      results: [{ kind: "unresolved", reason: "stale-input" }],
    });
  });

  it("rejects a generation change that stabilizes before the final sweep", async () => {
    const cssUri = "file:///workspace/dist/app.css";
    const base = memoryWorkspace({
      [cssUri]: ".card { color: red; }",
    });
    let generation = 1;
    let reads = 0;
    const workspace = {
      ...base,
      currentRulesSourceGeneration: () => generation,
      async readRulesSourceSnapshot(
        uri: string,
        maxBytes: number,
        signal?: AbortSignal,
      ) {
        const snapshot = await base.readRulesSourceSnapshot(
          uri,
          maxBytes,
          signal,
        );
        if (++reads === 2) generation += 1;
        return snapshot;
      },
    };

    await expect(resolveOne(
      workspace,
      evidence({ selector: ".card" }),
    )).resolves.toMatchObject({
      kind: "unresolved",
      reason: "stale-input",
    });
    expect(reads).toBe(3);
  });
});

async function resolveOne(
  workspace: SourceWorkspace,
  rule: InspectRuleEvidence,
  ast = new StylesheetAstCache(),
) {
  const batch = await new RulesSourceResolver(workspace, ast).resolve({
    selectionMessageId: "inspect-1",
    pageUrl: "http://localhost:4173/page",
    ruleEvidence: { rules: [rule], omittedRuleCount: 0 },
    signal: new AbortController().signal,
  });
  expect(batch.selectionMessageId).toBe("inspect-1");
  expect(batch.results).toHaveLength(1);
  return batch.results[0]!;
}

async function resolveBatch(
  workspace: SourceWorkspace,
  rules: readonly InspectRuleEvidence[],
  options: {
    readonly signal?: AbortSignal;
    readonly isCurrent?: () => boolean;
    readonly omittedRuleCount?: number;
  } = {},
) {
  return new RulesSourceResolver(workspace).resolve({
    selectionMessageId: "inspect-1",
    pageUrl: "http://localhost:4173/page",
    ruleEvidence: {
      rules,
      omittedRuleCount: options.omittedRuleCount ?? 0,
    },
    signal: options.signal ?? new AbortController().signal,
    ...(options.isCurrent === undefined ? {} : { isCurrent: options.isCurrent }),
  });
}

let nextRuleRef = 0;

function evidence(options: {
  readonly selector: string;
  readonly sourceUrl?: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly rulePath?: string;
  readonly contexts?: readonly {
    readonly kind: "media" | "supports";
    readonly conditionText: string;
  }[];
  readonly declarations?: readonly {
    readonly property: string;
    readonly value: string;
    readonly important?: boolean;
  }[];
}): InspectRuleEvidence {
  return {
    ruleRef: `rule-${++nextRuleRef}`,
    selector: options.selector,
    declarations: (options.declarations ?? [{
      property: "color",
      value: "red",
    }]).map((declaration) => ({
      ...declaration,
      important: declaration.important ?? false,
      valueTruncated: false,
    })),
    declarationsTruncated: false,
    generatedSource: {
      sourceUrl: options.sourceUrl ??
        "http://localhost:4173/dist/app.css",
      ...(options.startLine === undefined || options.startColumn === undefined
        ? {}
        : {
            startLine: options.startLine,
            startColumn: options.startColumn,
          }),
      ...(options.endLine === undefined || options.endColumn === undefined
        ? {}
        : {
            endLine: options.endLine,
            endColumn: options.endColumn,
          }),
      rulePath: options.rulePath ?? "0.0",
      contexts: options.contexts ?? [],
      contextsTruncated: false,
      unsupportedGroupContext: false,
    },
  } as InspectRuleEvidence;
}

function memoryWorkspace(
  files: Readonly<Record<string, string>>,
): SourceWorkspace & {
  currentRulesSourceGeneration(): number;
  readRulesSourceSnapshot(
    uri: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly uri: string;
    readonly text: string;
    readonly documentVersion: number;
  }>;
} {
  return {
    findFiles: async () => Object.keys(files),
    async readText(uri) {
      const text = files[stripQueryAndFragment(uri)];
      if (text === undefined) throw new Error(`Missing fixture: ${uri}`);
      return text;
    },
    async resolveSourceUri(sourceUrl, baseUrl) {
      const resolved = new URL(sourceUrl, baseUrl);
      const pathname = decodeURIComponent(resolved.pathname);
      const exact = Object.keys(files).filter((uri) =>
        decodeURIComponent(new URL(uri).pathname).endsWith(pathname)
      );
      return exact.length === 1
        ? { uris: exact, status: "exact", strategy: "automatic" }
        : {
            uris: [],
            status: exact.length > 1 ? "ambiguous" : "not-found",
            strategy: "automatic",
          };
    },
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => stripQueryAndFragment(uri).startsWith(
      "file:///workspace/",
    ),
    currentRulesSourceGeneration: () => 0,
    async readRulesSourceSnapshot(uri, maxBytes, signal) {
      if (signal?.aborted) throw namedAbortError();
      const text = await this.readText(uri);
      if (utf8ByteLength(text) > maxBytes) {
        throw new RulesSourceSnapshotLimitError();
      }
      if (signal?.aborted) throw namedAbortError();
      return {
        uri: stripQueryAndFragment(uri),
        text,
        documentVersion: 1,
      };
    },
  };
}

function stripQueryAndFragment(uri: string): string {
  const parsed = new URL(uri);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function namedAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
