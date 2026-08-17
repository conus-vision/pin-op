import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { SourcePosition, SourceRange } from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
  SourceMatchesMessageSchema,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type { SourceMatchesInput } from "../src/bridgeClient.js";
import {
  SourceExcerptRegistry,
  type SourceExcerptEditor,
} from "../src/presenter/sourceExcerptRegistry.js";
import type {
  ResolvedSourceMatch,
  SourceResolution,
} from "../src/sourcePlugins/types.js";

const DOCUMENT_URI = "file:///private/customer/src/Card.tsx";

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
