import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { SourceMapGenerator } from "source-map";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceMatch,
  SourcePlugin,
  SourcePosition,
  SourceRange,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
  SourceMatchesMessageSchema,
  type CssRuleFact,
  type InspectTarget,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type { SourceMatchesInput } from "../src/bridgeClient.js";
import {
  SourceExcerptRegistry,
  type SourceExcerptEditor,
} from "../src/presenter/sourceExcerptRegistry.js";
import { CssSourcePlugin } from "../src/sourcePlugins/cssSourcePlugin.js";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";
import { ScssSourcePlugin } from "../src/sourcePlugins/scssSourcePlugin.js";
import type {
  ResolvedSourceMatch,
  SourceResolution,
} from "../src/sourcePlugins/types.js";
import { memorySourceWorkspace } from "./support/memorySourceWorkspace.js";

const DOCUMENT_URI = "file:///private/customer/src/Card.tsx";
const ENCODED_SENSITIVE_PLUGIN_VALUES = [
  Buffer.from(String.raw`C:\Users\alice\workspace\src\Card.scss`).toString(
    "base64",
  ),
  Buffer.from("/home/alice/workspace/src/Card.scss").toString("base64url"),
  Buffer.from("file:///home/alice/workspace/src/Card.scss").toString("base64"),
  Buffer.from("webpack:///sources/Card.scss:17:3").toString("base64url"),
] as const;
const FOLDED_ENCODED_SENSITIVE_PLUGIN_VALUES = [
  foldBase64(ENCODED_SENSITIVE_PLUGIN_VALUES[0], " "),
  foldBase64(ENCODED_SENSITIVE_PLUGIN_VALUES[1], "\t"),
  foldBase64(ENCODED_SENSITIVE_PLUGIN_VALUES[2], "\r\n"),
] as const;
const OVERSIZED_FOLDED_ENCODED_PATH = foldBase64(
  Buffer.from(
    `C:\\workspace\\${"private\\".repeat(80)}secret.scss`,
  ).toString("base64"),
  "\r\n",
);
const SENSITIVE_PLUGIN_VALUES = [
  String.raw`C:\Users\alice\workspace\src\Card.scss`,
  "/home/alice/workspace/src/Card.scss",
  "file:///home/alice/workspace/src/Card.scss",
  "vscode-workspace://workspace-7/src/Card.scss",
  "webpack:///sources/Card.scss:17:3",
  "Card.scss:17:3",
  "Card.scss(17,3)",
  "Card.scss#L17C3",
  '{"targetKind":"element","path":[{"tag":"div","index":0}],"boundaries":[]}',
  '["html","body","div",0]',
  ...ENCODED_SENSITIVE_PLUGIN_VALUES,
  ...FOLDED_ENCODED_SENSITIVE_PLUGIN_VALUES,
  OVERSIZED_FOLDED_ENCODED_PATH,
  "app.css.map",
  "APP.JS.MAP",
  "bundle.map#generated",
  "theme.CSS.MAP ?v=7#source",
  "sourceMappingURL=app.css.map",
  " SOURCEMAPPINGURL = APP.JS.MAP ",
  "sourceMappingURL = bundle.map #generated",
  "# sourceMappingURL = app.css.map",
] as const;

describe("SourceExcerptRegistry", () => {
  it("publishes only active-document excerpts and protocol public fields", () => {
    const document = textDocument(
      DOCUMENT_URI,
      "typescriptreact",
      "const privateOutside = 1;\nexport function Card() {}\nconst tail = 2;",
    );
    const getText = vi.spyOn(document, "getText");
    const registry = excerptRegistry();
    const semanticMatch = {
      ...match("selected", range(1, 0, 1, 25), "Card"),
      text: "plugin-provided secret",
      uri: "file:///plugin/forged.tsx",
      metadata: { path: "C:/plugin/private.tsx" },
    } as ResolvedSourceMatch;

    const publication = registry.publish({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      editor: { document },
      resolution: resolution(document, [semanticMatch]),
    });

    expect(getText).toHaveBeenCalledTimes(1);
    expect(publication.message).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 3,
      document: { label: "Card.tsx", languageId: "typescriptreact" },
      matches: [{
        matchId: "opaque-1",
        targetRole: "selected",
        label: "Card",
        kind: "component",
        relation: "renders",
        confidence: "exact",
        startLine: 2,
        endLine: 2,
        text: "export function Card() {}",
        truncated: false,
      }],
      omittedMatchCount: 0,
    });
    const wire = JSON.stringify(wireMessage(publication.message));
    expect(SourceMatchesMessageSchema.parse(JSON.parse(wire))).toBeTruthy();
    expect(wire).not.toContain(DOCUMENT_URI);
    expect(wire).not.toContain("privateOutside");
    expect(wire).not.toContain("plugin-provided");
    expect(wire).not.toContain("forged");
    expect(wire).not.toContain("C:/plugin");
  });

  it("never serializes plugin-controlled paths, URIs, or locators", () => {
    const document = textDocument(
      "file:///private/customer/workspace/styles.scss",
      "scss",
      "a ".repeat(SENSITIVE_PLUGIN_VALUES.length).trimEnd(),
    );
    const hostileMatches = SENSITIVE_PLUGIN_VALUES.map((value, index) => ({
      ...match("selected", range(0, index * 2, 0, index * 2 + 1), value),
      kind: value,
      relation: value,
      metadata: {
        path: value,
        uri: value,
        sourceMapLocator: value,
      },
    }));
    const registry = excerptRegistry();

    const publication = registry.publish({
      inspectMessageId: "inspect-hostile-metadata",
      resolutionGeneration: 9,
      editor: { document },
      resolution: resolution(
        document,
        hostileMatches,
        "inspect-hostile-metadata",
      ),
    });
    const serialized = JSON.stringify(wireMessage(publication.message));

    for (const value of SENSITIVE_PLUGIN_VALUES) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(serializedStringFragment(value));
    }
    expect(serialized).not.toContain("/private/customer/workspace");
    expect(publication.message.matches).toHaveLength(
      SENSITIVE_PLUGIN_VALUES.length,
    );
    expect(publication.message.matches.map((entry) => entry.label)).toEqual(
      SENSITIVE_PLUGIN_VALUES.map(() => "styles.scss"),
    );
    expect(publication.message.matches.map((entry) => entry.kind)).toEqual(
      SENSITIVE_PLUGIN_VALUES.map(() => "source"),
    );
    expect(publication.message.matches.map((entry) => entry.relation)).toEqual(
      SENSITIVE_PLUGIN_VALUES.map(() => "matches"),
    );
    expect(publication.message.matches.map((entry) => entry.matchId)).toEqual(
      SENSITIVE_PLUGIN_VALUES.map((_, index) => `opaque-${index + 1}`),
    );
    for (const [index, excerpt] of publication.message.matches.entries()) {
      expect(registry.resolveOpen({
        ...openMessage(excerpt.matchId),
        inspectMessageId: "inspect-hostile-metadata",
        resolutionGeneration: 9,
      }, document)?.range).toEqual(range(0, index * 2, 0, index * 2 + 1));
    }
    expect(SourceMatchesMessageSchema.parse(JSON.parse(serialized))).toBeTruthy();
  });

  it("preserves neutral component, template, and stylesheet presentation", () => {
    const document = textDocument(
      "file:///private/customer/workspace/styles.scss",
      "scss",
      ".card {} Card Twig",
    );

    const publication = excerptRegistry().publish({
      inspectMessageId: "inspect-safe-metadata",
      resolutionGeneration: 2,
      editor: { document },
      resolution: resolution(document, [
        {
          ...match("selected", range(0, 0, 0, 8), ".card:hover"),
          pluginId: "pin-op.scss",
          kind: "style-rule",
          relation: "styles",
          confidence: "sourcemap",
        },
        {
          ...match("parent", range(0, 9, 0, 13), "Card"),
          kind: "component",
          relation: "renders",
        },
        {
          ...match("parent", range(0, 14, 0, 18), "Twig template block"),
          kind: "template",
          relation: "templates",
          confidence: "instrumented",
        },
      ], "inspect-safe-metadata"),
    });

    expect(publication.message.matches).toEqual([
      expect.objectContaining({
        label: ".card:hover",
        kind: "style-rule",
        relation: "styles",
        confidence: "sourcemap",
      }),
      expect.objectContaining({
        label: "Card",
        kind: "component",
        relation: "renders",
      }),
      expect.objectContaining({
        label: "Twig template block",
        kind: "template",
        relation: "templates",
        confidence: "instrumented",
      }),
    ]);
  });

  it("preserves selectors and component labels that only resemble locators", () => {
    const labels = [
      ".app.css.map",
      "#app.css.map",
      "[data-map='app.css.map']",
      "App.map",
      "SourceMappingURL",
      "SourceMapCard",
      "ButtonCard",
      "Button Card",
      "Q2Fy ZA==",
      "Q2Fy= ZA==",
    ] as const;
    const document = textDocument(
      "file:///private/customer/workspace/styles.scss",
      "scss",
      "x ".repeat(labels.length).trimEnd(),
    );
    const matches = labels.map((label, index) => ({
      ...match("selected", range(0, index * 2, 0, index * 2 + 1), label),
      kind: label.startsWith(".") || label.startsWith("#") ||
          label.startsWith("[")
        ? "style-rule"
        : "component",
      relation: label.startsWith(".") || label.startsWith("#") ||
          label.startsWith("[")
        ? "styles"
        : "renders",
    }));

    const publication = excerptRegistry().publish({
      inspectMessageId: "inspect-safe-lookalikes",
      resolutionGeneration: 3,
      editor: { document },
      resolution: resolution(
        document,
        matches,
        "inspect-safe-lookalikes",
      ),
    });

    expect(publication.message.matches.map((entry) => entry.label)).toEqual(
      labels,
    );
    expect(
      SourceMatchesMessageSchema.parse(
        JSON.parse(JSON.stringify(wireMessage(publication.message))),
      ),
    ).toBeTruthy();
  });

  it("serializes button.map from the real trusted CSS plugin", async () => {
    const documentUri = "file:///workspace/dist/app.css";
    const text = "button.map { color: red; }";
    const selection = cssSelection(
      "inspect-css-map-selector",
      "button.map",
      "/dist/app.css",
    );
    const sourceResolution = await resolveRegisteredPlugin(
      new CssSourcePlugin(),
      sourcePluginDocument(documentUri, "css", text),
      memorySourceWorkspace({ [documentUri]: text }),
      selection,
    );
    const editorDocument = textDocument(documentUri, "css", text);

    const publication = excerptRegistry().publish({
      inspectMessageId: selection.messageId,
      resolutionGeneration: 1,
      editor: { document: editorDocument },
      resolution: sourceResolution,
    });
    const serialized = JSON.stringify(wireMessage(publication.message));

    expect(sourceResolution.matches).toHaveLength(1);
    expect(Reflect.get(sourceResolution.matches[0]!, "labelProvenance")).toBe(
      "builtin-style-selector",
    );
    expect(publication.message.matches).toEqual([
      expect.objectContaining({
        label: "button.map",
        kind: "style-rule",
        relation: "styles",
      }),
    ]);
    expect(SourceMatchesMessageSchema.parse(JSON.parse(serialized))).toBeTruthy();
  });

  it("serializes custom-element.map from the real trusted SCSS plugin", async () => {
    const activeUri = "file:///workspace/src/components.scss";
    const generatedUri = "file:///workspace/dist/app.css";
    const mapUri = `${generatedUri}.map`;
    const selector = "custom-element.map";
    const original = `${selector} { color: red; }`;
    const generated = [
      `${selector} { color: red; }`,
      "/*# sourceMappingURL=app.css.map */",
    ].join("\n");
    const sourceMap = new SourceMapGenerator({ file: "app.css" });
    sourceMap.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "../src/components.scss",
    });
    const selection = cssSelection(
      "inspect-scss-map-selector",
      selector,
      "/dist/app.css",
    );
    const sourceResolution = await resolveRegisteredPlugin(
      new ScssSourcePlugin(),
      sourcePluginDocument(activeUri, "scss", original),
      memorySourceWorkspace({
        [activeUri]: original,
        [generatedUri]: generated,
        [mapUri]: sourceMap.toString(),
      }),
      selection,
    );
    const editorDocument = textDocument(activeUri, "scss", original);

    const publication = excerptRegistry().publish({
      inspectMessageId: selection.messageId,
      resolutionGeneration: 1,
      editor: { document: editorDocument },
      resolution: sourceResolution,
    });
    const serialized = JSON.stringify(wireMessage(publication.message));

    expect(sourceResolution.matches).toHaveLength(1);
    expect(Reflect.get(sourceResolution.matches[0]!, "labelProvenance")).toBe(
      "builtin-style-selector",
    );
    expect(publication.message.matches).toEqual([
      expect.objectContaining({
        label: selector,
        kind: "style-rule",
        relation: "styles",
      }),
    ]);
    expect(SourceMatchesMessageSchema.parse(JSON.parse(serialized))).toBeTruthy();
  });

  it("does not trust a third-party plugin that spoofs selector provenance", async () => {
    const documentUri = "file:///workspace/app.css";
    const text = "x x x";
    const pluginDocument = sourcePluginDocument(documentUri, "css", text);
    const labels = ["button.map", "app.css.map", "layout.js.map"] as const;
    const forgedMatches = labels.map((label, index) => ({
      targetRole: "selected" as const,
      range: {
        start: { line: 0, character: index * 2 },
        end: { line: 0, character: index * 2 + 1 },
      },
      label,
      kind: index === 0 ? "style-rule" : index === 1 ? "source" : "template",
      relation: index === 0 ? "styles" : index === 1 ? "matches" : "templates",
      confidence: "exact" as const,
      labelProvenance: "builtin-style-selector",
    } as SourceMatch));
    const hostilePlugin: SourcePlugin = {
      id: "pin-op.css",
      displayName: "Spoofed CSS",
      apiVersion: 2,
      documentSelectors: [{ languageId: "css", scheme: "file" }],
      supportedFactKinds: ["css-rule"],
      async resolve() {
        return { matches: forgedMatches };
      },
    };
    const selection = cssSelection(
      "inspect-third-party-map-labels",
      ".fixture",
      "/app.css",
    );
    const sourceResolution = await resolveRegisteredPlugin(
      hostilePlugin,
      pluginDocument,
      memorySourceWorkspace({ [documentUri]: text }),
      selection,
    );
    const editorDocument = textDocument(documentUri, "css", text);

    const publication = excerptRegistry().publish({
      inspectMessageId: selection.messageId,
      resolutionGeneration: 1,
      editor: { document: editorDocument },
      resolution: sourceResolution,
    });
    const serialized = JSON.stringify(wireMessage(publication.message));

    expect(sourceResolution.matches.map((entry) =>
      Reflect.get(entry, "labelProvenance")
    )).toEqual(labels.map(() => "plugin"));
    expect(publication.message.matches.map((entry) => entry.label)).toEqual(
      labels.map(() => "app.css"),
    );
    for (const label of labels) expect(serialized).not.toContain(label);
    expect(SourceMatchesMessageSchema.parse(JSON.parse(serialized))).toBeTruthy();
  });

  it("fails closed when plugin display metadata cannot be normalized", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    const hostile = match("selected", range(0, 0, 0, 8));
    Object.defineProperty(hostile, "label", {
      get() {
        throw new Error("private path getter failed");
      },
    });
    const registry = excerptRegistry();

    let publication: ReturnType<typeof registry.publish> | undefined;
    expect(() => {
      publication = registry.publish({
        inspectMessageId: "inspect-normalizer-failure",
        resolutionGeneration: 1,
        editor: { document },
        resolution: resolution(
          document,
          [hostile],
          "inspect-normalizer-failure",
        ),
      });
    }).not.toThrow();

    expect(publication?.message.matches).toEqual([]);
    expect(registry.resolveOpen({
      ...openMessage("opaque-1"),
      inspectMessageId: "inspect-normalizer-failure",
      resolutionGeneration: 1,
    }, document)).toBeUndefined();
  });

  it("fails closed when host-derived presentation metadata cannot be read", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    document.uri.toString = () => {
      throw new Error("workspace URI getter failed");
    };
    const registry = excerptRegistry();
    let publication: ReturnType<typeof registry.publish> | undefined;

    expect(() => {
      publication = registry.publish({
        inspectMessageId: "inspect-host-normalizer-failure",
        resolutionGeneration: 1,
        editor: { document },
        resolution: {
          selectionMessageId: "inspect-host-normalizer-failure",
          documentUri: DOCUMENT_URI,
          documentVersion: document.version,
          matches: [match("selected", range(0, 0, 0, 8))],
          diagnostics: [],
        },
      });
    }).not.toThrow();

    expect(publication?.message).toMatchObject({
      document: { label: "untitled", languageId: "unknown" },
      matches: [],
      omittedMatchCount: 0,
    });
    expect(publication?.navigationMatches).toEqual([]);
  });

  it("fails closed when active-document identity cannot be revalidated", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    let uriReads = 0;
    document.uri.toString = () => {
      uriReads += 1;
      if (uriReads === 1) return DOCUMENT_URI;
      throw new Error("workspace URI changed during publication");
    };
    const registry = excerptRegistry();
    let publication: ReturnType<typeof registry.publish> | undefined;

    expect(() => {
      publication = registry.publish({
        inspectMessageId: "inspect-document-revalidation-failure",
        resolutionGeneration: 1,
        editor: { document },
        resolution: {
          selectionMessageId: "inspect-document-revalidation-failure",
          documentUri: DOCUMENT_URI,
          documentVersion: document.version,
          matches: [match("selected", range(0, 0, 0, 8))],
          diagnostics: [],
        },
      });
    }).not.toThrow();

    expect(publication?.message).toMatchObject({
      document: { label: "Card.tsx", languageId: "css" },
      matches: [],
    });
    expect(publication?.navigationMatches).toEqual([]);
  });

  it("fails closed when invalidation metadata cannot be read", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    document.uri.toString = () => {
      throw new Error("workspace URI getter failed");
    };
    const registry = excerptRegistry();
    let invalidation: SourceMatchesInput | undefined;

    expect(() => {
      invalidation = registry.invalidate({
        inspectMessageId: "inspect-invalidation-normalizer-failure",
        resolutionGeneration: 4,
        editor: { document },
      });
    }).not.toThrow();

    expect(invalidation).toEqual({
      inspectMessageId: "inspect-invalidation-normalizer-failure",
      resolutionGeneration: 4,
      document: { label: "untitled", languageId: "unknown" },
      matches: [],
      omittedMatchCount: 0,
    });
  });

  it("reduces encoded URI segments to a public basename", () => {
    const document = textDocument(
      "file:///private/customer/hidden%2Fnested%5CCard.tsx",
      "typescriptreact",
      "x",
    );

    const publication = excerptRegistry().publish({
      inspectMessageId: "inspect-label",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 1)),
      ], "inspect-label"),
    });

    expect(publication.message.document.label).toBe("Card.tsx");
  });

  it("rejects resolutions that do not match the active document URI and version", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}", 4);
    const getText = vi.spyOn(document, "getText");
    const registry = excerptRegistry();

    const wrongUri = registry.publish({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 1,
      editor: { document },
      resolution: {
        ...resolution(document, [match("selected", range(0, 0, 0, 8))]),
        documentUri: "file:///private/customer/src/Other.css",
      },
    });
    const wrongVersion = registry.publish({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      editor: { document },
      resolution: {
        ...resolution(document, [match("selected", range(0, 0, 0, 8))]),
        documentVersion: 3,
      },
    });

    expect(wrongUri.message.matches).toEqual([]);
    expect(wrongVersion.message.matches).toEqual([]);
    expect(getText).not.toHaveBeenCalled();
  });

  it("deduplicates exact ranges with selected precedence and orders each role by range", () => {
    const document = textDocument(
      DOCUMENT_URI,
      "css",
      ".a {} .b {} .c {} .d {}",
    );
    const registry = excerptRegistry();

    const publication = registry.publish({
      inspectMessageId: "inspect-order",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("parent", range(0, 18, 0, 23), "parent-late"),
        match("selected", range(0, 6, 0, 11), "selected-late"),
        match("parent", range(0, 0, 0, 5), "parent-duplicate"),
        match("selected", range(0, 0, 0, 5), "selected-first"),
        match("parent", range(0, 12, 0, 17), "parent-first"),
        match("selected", range(0, 6, 0, 11), "selected-duplicate"),
      ], "inspect-order"),
    });

    expect(publication.message.matches.map((entry) => [
      entry.targetRole,
      entry.label,
      entry.startLine,
    ])).toEqual([
      ["selected", "selected-first", 1],
      ["selected", "selected-duplicate", 1],
      ["parent", "parent-first", 1],
      ["parent", "parent-late", 1],
    ]);
    expect(publication.navigationMatches.map((entry) => entry.matchId)).toEqual(
      publication.message.matches.map((entry) => entry.matchId),
    );
  });

  it("caps publication at 32 matches and counts deduplicated omissions", () => {
    const text = "x".repeat(80);
    const document = textDocument(DOCUMENT_URI, "plaintext", text);
    const matches = Array.from({ length: 34 }, (_, index) =>
      match("selected", range(0, index * 2, 0, index * 2 + 1), `m-${index}`)
    );
    matches.push(match("parent", range(0, 0, 0, 1), "duplicate"));

    const publication = excerptRegistry().publish({
      inspectMessageId: "inspect-count",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, matches, "inspect-count"),
    });

    expect(publication.message.matches).toHaveLength(
      SOURCE_PRESENTATION_LIMITS.matches,
    );
    expect(publication.message.omittedMatchCount).toBe(2);
  });

  it("preserves at most 80 logical lines and binds truncation to the complete range", () => {
    const lines = Array.from(
      { length: 81 },
      (_, index) => `line-${index + 1}`,
    );
    const text = lines.map((line, index) =>
      index === lines.length - 1 ? line : `${line}${indexedLineEnding(index)}`
    ).join("");
    const document = textDocument(DOCUMENT_URI, "plaintext", text);
    const completeRange = rangeFromOffsets(document, 0, text.length);
    const registry = excerptRegistry();

    const publication = registry.publish({
      inspectMessageId: "inspect-lines",
      resolutionGeneration: 1,
      editor: { document },
      resolution: resolution(document, [
        match("selected", completeRange, "all-lines"),
      ], "inspect-lines"),
    });
    const excerpt = publication.message.matches[0]!;

    expect(excerpt.text.split(/\r\n|\r|\n/)).toHaveLength(80);
    expect(excerpt.text).toContain("line-80");
    expect(excerpt.text).not.toContain("line-81");
    expect(excerpt.truncated).toBe(true);
    expect(registry.resolveOpen(openMessage(excerpt.matchId, {
      inspectMessageId: "inspect-lines",
      resolutionGeneration: 1,
    }), document)?.range)
      .toEqual(completeRange);
  });

  it("truncates UTF-8 at 8 KiB without splitting or corrupting code points", () => {
    const exactPrefix = `${"\u00e9".repeat(4094)}\u{1f600}`;
    const text = `${exactPrefix}z`;
    const document = textDocument(DOCUMENT_URI, "plaintext", text);
    const registry = excerptRegistry();

    const publication = registry.publish({
      inspectMessageId: "inspect-utf8",
      resolutionGeneration: 2,
      editor: { document },
      resolution: resolution(document, [
        match("selected", rangeFromOffsets(document, 0, text.length), "utf8"),
      ], "inspect-utf8"),
    });
    const excerpt = publication.message.matches[0]!;

    expect(Buffer.byteLength(excerpt.text, "utf8")).toBe(
      SOURCE_PRESENTATION_LIMITS.textBytes,
    );
    expect(excerpt.text).toBe(exactPrefix);
    expect(excerpt.text).not.toContain("\ufffd");
    expect(excerpt.truncated).toBe(true);

    const splitBoundaryText = `${"a".repeat(8191)}\u{1f600}`;
    const splitDocument = textDocument(
      DOCUMENT_URI,
      "plaintext",
      splitBoundaryText,
    );
    const splitPublication = registry.publish({
      inspectMessageId: "inspect-utf8-split",
      resolutionGeneration: 0,
      editor: { document: splitDocument },
      resolution: resolution(splitDocument, [
        match(
          "selected",
          rangeFromOffsets(splitDocument, 0, splitBoundaryText.length),
          "utf8-split",
        ),
      ], "inspect-utf8-split"),
    });
    expect(splitPublication.message.matches[0]?.text).toBe("a".repeat(8191));
  });

  it("keeps the complete serialized source.matches envelope within 256 KiB", () => {
    const excerptText = "x".repeat(SOURCE_PRESENTATION_LIMITS.textBytes);
    const text = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.matches },
      () => excerptText,
    ).join(" ");
    const document = textDocument(DOCUMENT_URI, "plaintext", text);
    const matches = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.matches },
      (_, index) => {
        const start = index * (excerptText.length + 1);
        return match(
          "selected",
          rangeFromOffsets(document, start, start + excerptText.length),
          `match-${index}`,
        );
      },
    );
    const registry = excerptRegistry({
      measureEnvelopeBytes: (message) => wireBytes(message),
    });

    const publication = registry.publish({
      inspectMessageId: "inspect-envelope",
      resolutionGeneration: 8,
      editor: { document },
      resolution: resolution(document, matches, "inspect-envelope"),
    });

    expect(wireBytes(publication.message)).toBeLessThanOrEqual(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
    );
    expect(publication.message.omittedMatchCount).toBeGreaterThan(0);
    expect(
      publication.message.matches.length + publication.message.omittedMatchCount,
    ).toBe(SOURCE_PRESENTATION_LIMITS.matches);
    expect(SourceMatchesMessageSchema.parse(wireMessage(publication.message)))
      .toBeTruthy();
  });

  it("bounds document and match labels to the strict protocol schema", () => {
    const document = textDocument(
      `file:///private/${"d".repeat(200)}.css`,
      `css${"x".repeat(100)}`,
      ".card {}",
    );
    const long = `\u0000 ${"l".repeat(200)}`;
    const publication = excerptRegistry().publish({
      inspectMessageId: "inspect-fields",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [{
        ...match("selected", range(0, 0, 0, 8), long),
        kind: long,
        relation: long,
      }], "inspect-fields"),
    });

    expect(publication.message.document.label.length).toBeLessThanOrEqual(
      RESOLUTION_LIMITS.labelLength,
    );
    expect(publication.message.document.languageId.length).toBeLessThanOrEqual(
      RESOLUTION_LIMITS.languageIdLength,
    );
    expect(publication.message.matches[0]?.label.length).toBeLessThanOrEqual(
      RESOLUTION_LIMITS.labelLength,
    );
    expect(SourceMatchesMessageSchema.parse(wireMessage(publication.message)))
      .toBeTruthy();
  });

  it("uses stable opaque IDs within a publication and stales them on replacement", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    const registry = excerptRegistry();
    const first = registry.publish({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 8), "first"),
      ]),
    });
    const firstId = first.message.matches[0]!.matchId;

    expect(first.navigationMatches[0]?.matchId).toBe(firstId);
    expect(registry.resolveOpen(openMessage(firstId), document)?.matchId).toBe(
      firstId,
    );

    const second = registry.publish({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 1,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 8), "first"),
      ]),
    });
    expect(second.message.matches[0]?.matchId).toBe("opaque-2");
    expect(registry.resolveOpen(openMessage(firstId), document)).toBeUndefined();
  });

  it("deeply isolates and freezes every published and authority object", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    const completeRange = range(0, 0, 0, 8);
    const registry = excerptRegistry();
    const publication = registry.publish({
      inspectMessageId: "inspect-copies",
      resolutionGeneration: 4,
      editor: { document },
      resolution: resolution(document, [
        match("selected", completeRange, "copies"),
      ], "inspect-copies"),
    });
    const matchId = publication.message.matches[0]!.matchId;
    const intent = openMessage(matchId, {
      inspectMessageId: "inspect-copies",
      resolutionGeneration: 4,
    });
    const firstAuthority = registry.resolveOpen(intent, document)!;
    const secondAuthority = registry.resolveOpen(intent, document)!;
    const navigation = publication.navigationMatches[0]!;

    expect(firstAuthority).not.toBe(secondAuthority);
    expect(firstAuthority.range).not.toBe(secondAuthority.range);
    expect(firstAuthority.range).not.toBe(navigation.range);
    expect(firstAuthority.range.start).not.toBe(navigation.range.start);
    expectDeepFrozen(publication);
    expectDeepFrozen(firstAuthority);
    expectDeepFrozen(secondAuthority);

    expect(Reflect.set(completeRange.start, "line", 99)).toBe(true);
    expect(registry.resolveOpen(intent, document)?.range).toEqual(
      range(0, 0, 0, 8),
    );

    const firstEmpty = registry.invalidate();
    const secondEmpty = registry.invalidate();
    expect(firstEmpty).toBeDefined();
    expect(secondEmpty).toBeDefined();
    expect(firstEmpty).not.toBe(secondEmpty);
    expect(firstEmpty?.document).not.toBe(secondEmpty?.document);
    expect(firstEmpty?.matches).not.toBe(secondEmpty?.matches);
    expect(firstEmpty?.document).toEqual({
      label: "Card.tsx",
      languageId: "css",
    });
    expectDeepFrozen(firstEmpty);
    expectDeepFrozen(secondEmpty);
  });

  it("retries generated ID collisions without overwriting authority", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".a {} .b {}");
    const generated = ["shared-id", "shared-id", "unique-id"];
    const registry = excerptRegistry({
      createMatchId: () => generated.shift() ?? "unexpected-id",
    });
    const publication = registry.publish({
      inspectMessageId: "inspect-collision",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 5), "first"),
        match("selected", range(0, 6, 0, 11), "second"),
      ], "inspect-collision"),
    });

    expect(publication.message.matches.map((entry) => entry.matchId)).toEqual([
      "shared-id",
      "unique-id",
    ]);
    expect(registry.resolveOpen(openMessage("shared-id", {
      inspectMessageId: "inspect-collision",
    }), document)?.range).toEqual(range(0, 0, 0, 5));
    expect(registry.resolveOpen(openMessage("unique-id", {
      inspectMessageId: "inspect-collision",
    }), document)?.range).toEqual(range(0, 6, 0, 11));
  });

  it("retries invalid opaque IDs before publishing a valid one", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    const generated: unknown[] = [
      "",
      "x".repeat(RESOLUTION_LIMITS.opaqueIdLength + 1),
      42,
      "valid-id",
    ];
    const registry = excerptRegistry({
      createMatchId: (() => generated.shift()) as () => string,
    });

    const publication = registry.publish({
      inspectMessageId: "inspect-invalid-id",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 8)),
      ], "inspect-invalid-id"),
    });

    expect(publication.message.matches[0]?.matchId).toBe("valid-id");
    expect(SourceMatchesMessageSchema.parse(wireMessage(publication.message)))
      .toBeTruthy();
  });

  it.each(["collision", "invalid", "throwing"] as const)(
    "fails closed with bounded retries for a repeated %s generator",
    (failure) => {
      const document = textDocument(DOCUMENT_URI, "css", ".a {} .b {}");
      let calls = 0;
      const registry = excerptRegistry({
        createMatchId: () => {
          calls += 1;
          if (failure === "throwing") throw new Error("generator failed");
          return failure === "invalid" ? "" : "same-id";
        },
      });
      const matches = failure === "collision"
        ? [
            match("selected", range(0, 0, 0, 5), "first"),
            match("selected", range(0, 6, 0, 11), "second"),
          ]
        : [match("selected", range(0, 0, 0, 5), "first")];

      const publication = registry.publish({
        inspectMessageId: "inspect-generator-failure",
        resolutionGeneration: 0,
        editor: { document },
        resolution: resolution(
          document,
          matches,
          "inspect-generator-failure",
        ),
      });

      expect(publication.message.matches).toEqual([]);
      expect(publication.message.omittedMatchCount).toBe(matches.length);
      expect(publication.navigationMatches).toEqual([]);
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(32);
      expect(registry.resolveOpen(openMessage("same-id", {
        inspectMessageId: "inspect-generator-failure",
      }), document)).toBeUndefined();
    },
  );

  it("reserves worst-case escaped opaque IDs in the fallback envelope", () => {
    const excerptText = "x".repeat(7_911);
    const text = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.matches },
      () => excerptText,
    ).join(" ");
    const document = textDocument(DOCUMENT_URI, "plaintext", text);
    const semanticMatches = Array.from(
      { length: SOURCE_PRESENTATION_LIMITS.matches },
      (_, index) => {
        const start = index * (excerptText.length + 1);
        return match(
          "selected",
          rangeFromOffsets(document, start, start + excerptText.length),
        );
      },
    );
    let nextId = 0;
    const registry = new SourceExcerptRegistry({
      createMatchId: () => `opaque-${++nextId}`,
    });
    const escapedOpaqueId = "\u0000".repeat(RESOLUTION_LIMITS.opaqueIdLength);

    const publication = registry.publish({
      inspectMessageId: escapedOpaqueId,
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, semanticMatches, escapedOpaqueId),
    });
    const worstCaseWire = {
      protocolVersion: PROTOCOL_VERSION,
      type: "source.matches" as const,
      messageId: escapedOpaqueId,
      sessionId: escapedOpaqueId,
      source: { role: "ide" as const, id: escapedOpaqueId },
      ...publication.message,
      metadata: {},
    };

    expect(Buffer.byteLength(JSON.stringify(worstCaseWire), "utf8"))
      .toBeLessThanOrEqual(SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES);
    expect(publication.message.omittedMatchCount).toBeGreaterThan(0);
    expect(SourceMatchesMessageSchema.parse(worstCaseWire)).toBeTruthy();
  });

  it("validates every private authority field and never trusts a browser range", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}", 7);
    const completeRange = range(0, 0, 0, 8);
    const registry = excerptRegistry();
    const publication = registry.publish({
      inspectMessageId: "inspect-authority",
      resolutionGeneration: 6,
      editor: { document },
      resolution: resolution(document, [
        match("selected", completeRange, "authority"),
      ], "inspect-authority"),
    });
    const matchId = publication.message.matches[0]!.matchId;
    const intent = openMessage(matchId, {
      inspectMessageId: "inspect-authority",
      resolutionGeneration: 6,
    });

    expect(registry.resolveOpen({
      ...intent,
      range: range(99, 0, 100, 0),
      uri: "file:///browser/forged.css",
      command: "delete-everything",
    } as SourceOpenMessage, document)?.range).toEqual(completeRange);
    expect(registry.resolveOpen({
      ...intent,
      inspectMessageId: "inspect-stale",
    }, document)).toBeUndefined();
    expect(registry.resolveOpen({
      ...intent,
      resolutionGeneration: 5,
    }, document)).toBeUndefined();
    expect(registry.resolveOpen({ ...intent, matchId: "forged" }, document))
      .toBeUndefined();
    expect(registry.resolveOpen(intent, {
      ...document,
      uri: { toString: () => "file:///private/customer/src/Other.tsx" },
    })).toBeUndefined();
    expect(registry.resolveOpen(intent, { ...document, version: 8 }))
      .toBeUndefined();
  });

  it("invalidates all authority and returns an empty current source state", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    const registry = excerptRegistry();
    const publication = registry.publish({
      inspectMessageId: "inspect-clear",
      resolutionGeneration: 2,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 8), "clear"),
      ], "inspect-clear"),
    });
    const matchId = publication.message.matches[0]!.matchId;

    const empty = registry.invalidate({
      inspectMessageId: "inspect-clear",
      resolutionGeneration: 3,
      editor: { document: { ...document, version: 2 } },
    });

    expect(empty).toEqual({
      inspectMessageId: "inspect-clear",
      resolutionGeneration: 3,
      document: { label: "Card.tsx", languageId: "css" },
      matches: [],
      omittedMatchCount: 0,
    });
    expect(registry.resolveOpen(openMessage(matchId, {
      inspectMessageId: "inspect-clear",
      resolutionGeneration: 2,
    }), document)).toBeUndefined();
    expect(wireBytes(empty)).toBeLessThanOrEqual(
      SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
    );
  });

  it("fails closed when the active document cannot be read", () => {
    const document = textDocument(DOCUMENT_URI, "css", ".card {}");
    document.getText = () => {
      throw new Error("read failed for private path");
    };
    const registry = excerptRegistry();

    const publication = registry.publish({
      inspectMessageId: "inspect-read-error",
      resolutionGeneration: 0,
      editor: { document },
      resolution: resolution(document, [
        match("selected", range(0, 0, 0, 8), "read-error"),
      ], "inspect-read-error"),
    });

    expect(publication.message.matches).toEqual([]);
    expect(publication.navigationMatches).toEqual([]);
  });
});

function excerptRegistry(
  overrides: Partial<ConstructorParameters<typeof SourceExcerptRegistry>[0]> = {},
): SourceExcerptRegistry {
  let nextId = 0;
  return new SourceExcerptRegistry({
    createMatchId: () => `opaque-${++nextId}`,
    measureEnvelopeBytes: (message) => wireBytes(message),
    ...overrides,
  });
}

function wireMessage(message: SourceMatchesInput) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches" as const,
    messageId: "message-00000000-0000-4000-8000-000000000000",
    sessionId: "session-1",
    source: { role: "ide" as const, id: "vscode-test" },
    ...message,
    metadata: {},
  };
}

function wireBytes(message: SourceMatchesInput): number {
  return Buffer.byteLength(JSON.stringify(wireMessage(message)), "utf8");
}

function serializedStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function foldBase64(value: string, separator: string): string {
  return value.match(/.{1,4}/gu)?.join(separator) ?? value;
}

async function resolveRegisteredPlugin(
  plugin: SourcePlugin,
  document: SourceDocument,
  workspace: SourceWorkspace,
  selection: SelectionSnapshot,
): Promise<SourceResolution> {
  const registry = new SourcePluginRegistry();
  registry.register(plugin);
  const dispatch = await registry.resolve(
    selection,
    document,
    workspace,
    new AbortController().signal,
  );
  if (dispatch.kind !== "resolved") {
    throw new Error(`Expected resolved dispatch, received ${dispatch.kind}`);
  }
  return dispatch.resolution;
}

function cssSelection(
  messageId: string,
  selector: string,
  sourceUrl: string,
): SelectionSnapshot {
  const target: InspectTarget & { facts: CssRuleFact[] } = {
    role: "selected",
    depth: 0,
    subject: { selector, metadata: {} },
    facts: [{
      type: "css-rule",
      selector,
      property: "color",
      value: "red",
      metadata: {
        sourceUrl,
        media: [],
        mediaTruncated: false,
        rulePath: "0.0",
        valueTruncated: false,
        important: false,
      },
    }],
    metadata: {},
  };
  return {
    sessionId: "session-1",
    messageId,
    targets: [target],
    context: { url: "http://localhost:4173/page", metadata: {} },
    metadata: {},
  };
}

function sourcePluginDocument(
  uri: string,
  languageId: string,
  initialText: string,
): SourceDocument {
  const document = textDocument(uri, languageId, initialText);
  return {
    uri,
    languageId,
    version: document.version,
    getText: document.getText,
    positionAt: document.positionAt,
    offsetAt: document.offsetAt,
  };
}

function resolution(
  document: SourceExcerptEditor["document"],
  matches: readonly ResolvedSourceMatch[],
  selectionMessageId = "inspect-1",
): SourceResolution {
  return {
    selectionMessageId,
    documentUri: document.uri.toString(),
    documentVersion: document.version,
    matches,
    diagnostics: [],
  };
}

function match(
  targetRole: "selected" | "parent",
  sourceRange: SourceRange,
  label = "Card",
): ResolvedSourceMatch {
  return {
    pluginId: `fixture.${label}`,
    targetRole,
    range: sourceRange,
    label,
    kind: "component",
    relation: "renders",
    confidence: "exact",
  };
}

function openMessage(
  matchId: string,
  overrides: Partial<
    Pick<SourceOpenMessage, "inspectMessageId" | "resolutionGeneration">
  > = {},
): SourceOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId: "open-1",
    sessionId: "session-1",
    inspectMessageId: overrides.inspectMessageId ?? "inspect-1",
    resolutionGeneration: overrides.resolutionGeneration ?? 0,
    matchId,
    metadata: {},
  };
}

function textDocument(
  uri: string,
  languageId: string,
  initialText: string,
  version = 1,
): SourceExcerptEditor["document"] & { getText: () => string } {
  const lineStarts = [0];
  for (let index = 0; index < initialText.length; index += 1) {
    if (initialText[index] === "\n") lineStarts.push(index + 1);
  }
  return {
    uri: { toString: () => uri },
    languageId,
    version,
    getText: () => initialText,
    positionAt(offset) {
      const bounded = Math.max(0, Math.min(Math.floor(offset), initialText.length));
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= bounded) {
        line += 1;
      }
      return { line, character: bounded - lineStarts[line]! };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
      return Math.max(
        lineStarts[line]!,
        Math.min(lineStarts[line]! + position.character, lineEnd(line)),
      );
    },
  };

  function lineEnd(line: number): number {
    const next = lineStarts[line + 1];
    if (next === undefined) return initialText.length;
    const lineFeed = next - 1;
    return initialText[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
  }
}

function rangeFromOffsets(
  document: SourceExcerptEditor["document"],
  start: number,
  end: number,
): SourceRange {
  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): SourceRange {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter),
  };
}

function position(line: number, character: number): SourcePosition {
  return { line, character };
}

function indexedLineEnding(index: number): string {
  return index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n";
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.set(value, "__mutation_probe__", true)).toBe(false);
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
}
