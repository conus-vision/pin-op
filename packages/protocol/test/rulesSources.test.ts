import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  PROTOCOL_VERSION,
  PublicStylesheetUrlSchema,
  RULE_EVIDENCE_LIMITS,
  RULES_SOURCES_ENVELOPE_MAX_BYTES,
  RULES_SOURCES_LIMITS,
  RulesOpenMessageSchema,
  RulesSourceDocumentSchema,
  RulesSourcesMessageSchema,
  canonicalizePublicStylesheetUrl,
  createRulesSourcesMessageSchema,
  parseMessage,
} from "../src/index.js";

const source = { role: "ide" as const, id: "vscode-1" };

function rulesSourcesMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: "rules-sources-1",
    sessionId: "session-1",
    source,
    inspectMessageId: "inspect-1",
    rulesGeneration: 3,
    sources: [
      {
        ruleRef: "rule-1",
        openAuthorityId: "open-1",
        document: { label: "app.css", languageId: "css" },
        startLine: 12,
        startColumn: 4,
        confidence: "exact",
      },
    ],
    unresolvedRuleCount: 0,
    metadata: {},
    ...overrides,
  };
}

function rulesOpenMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.open",
    messageId: "rules-open-1",
    sessionId: "session-1",
    inspectMessageId: "inspect-1",
    rulesGeneration: 3,
    openAuthorityId: "open-1",
    metadata: {},
    ...overrides,
  };
}

describe("protocol v7 correlated rule source messages", () => {
  it("publishes the exact rules source limits", () => {
    expect(RULES_SOURCES_LIMITS).toEqual({
      sources: 256,
      unresolvedRules: 256,
      labelLength: 128,
      authorityIdLength: 128,
      propertyNameLength: 256,
      line: 10_000_000,
      column: 1_000_000,
    });
    expect(RULES_SOURCES_ENVELOPE_MAX_BYTES).toBe(128 * 1024);
  });

  it("parses a strict IDE-authored rules.sources message", () => {
    const message = rulesSourcesMessage();

    expect(RulesSourcesMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
  });

  it("accepts CSS and SCSS source documents and closed confidence values", () => {
    for (const languageId of ["css", "scss"] as const) {
      for (const confidence of ["exact", "sourcemap"] as const) {
        const message = rulesSourcesMessage({
          sources: [
            {
              ruleRef: `rule-${languageId}-${confidence}`,
              openAuthorityId: `open-${languageId}-${confidence}`,
              document: { label: `app.${languageId}`, languageId },
              startLine: RULES_SOURCES_LIMITS.line,
              startColumn: RULES_SOURCES_LIMITS.column,
              confidence,
            },
          ],
        });
        expect(RulesSourcesMessageSchema.safeParse(message).success).toBe(true);
      }
    }
  });

  it("rejects non-IDE authors and unknown document/confidence values", () => {
    expect(() => RulesSourcesMessageSchema.parse(
      rulesSourcesMessage({ source: { role: "browser", id: "browser-1" } }),
    )).toThrow();
    expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
      sources: [{
        ruleRef: "rule-1",
        openAuthorityId: "open-1",
        document: { label: "app.ts", languageId: "typescript" },
        startLine: 1,
        startColumn: 1,
        confidence: "heuristic",
      }],
    }))).toThrow();
  });

  it.each([
    "../app.css",
    ".",
    "..",
    "folder/app.css",
    "folder\\app.css",
    "C:app.css",
    "file:app.css",
    "https:app.css",
    "app\u0000.css",
    "app\u0085.css",
    "app\u202Ecss",
    "app\u2066css",
    "app\u2028css",
    "app\u2029css",
  ])("rejects hostile source document label %j", (label) => {
    expect(RulesSourceDocumentSchema.safeParse({
      label,
      languageId: "css",
    }).success).toBe(false);
  });

  it("requires unique rule refs and open authorities", () => {
    const entry = (ruleRef: string, openAuthorityId: string) => ({
      ruleRef,
      openAuthorityId,
      document: { label: "app.css", languageId: "css" },
      startLine: 1,
      startColumn: 1,
      confidence: "exact",
    });

    expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
      sources: [entry("rule-1", "open-1"), entry("rule-1", "open-2")],
    }))).toThrow();
    expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
      sources: [entry("rule-1", "open-1"), entry("rule-2", "open-1")],
    }))).toThrow();
  });

  it("bounds source counts, unresolved counts, positions, and identifiers", () => {
    const base = rulesSourcesMessage().sources[0]!;
    expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
      sources: Array.from(
        { length: RULES_SOURCES_LIMITS.sources + 1 },
        (_, index) => ({
          ...base,
          ruleRef: `rule-${index}`,
          openAuthorityId: `open-${index}`,
        }),
      ),
    }))).toThrow();
    expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
      unresolvedRuleCount: RULES_SOURCES_LIMITS.unresolvedRules + 1,
    }))).toThrow();
    for (const patch of [
      { startLine: 0 },
      { startLine: RULES_SOURCES_LIMITS.line + 1 },
      { startColumn: 0 },
      { startColumn: RULES_SOURCES_LIMITS.column + 1 },
      { ruleRef: "r".repeat(RULE_EVIDENCE_LIMITS.ruleRefLength + 1) },
      {
        openAuthorityId: "o".repeat(
          RULES_SOURCES_LIMITS.authorityIdLength + 1,
        ),
      },
    ]) {
      expect(() => RulesSourcesMessageSchema.parse(rulesSourcesMessage({
        sources: [{ ...base, ...patch }],
      }))).toThrow();
    }
  });

  it("enforces the UTF-8 serialized envelope budget", () => {
    const message = rulesSourcesMessage();
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");

    expect(createRulesSourcesMessageSchema(bytes).safeParse(message).success)
      .toBe(true);
    expect(createRulesSourcesMessageSchema(bytes - 1).safeParse(message).success)
      .toBe(false);
    const oversized = rulesSourcesMessage({
      sources: Array.from(
        { length: RULES_SOURCES_LIMITS.sources },
        (_, index) => ({
          ruleRef: `${index.toString(36)}-${"r".repeat(120)}`,
          openAuthorityId: `${index.toString(36)}-${"o".repeat(120)}`,
          document: {
            label: "\u{1F642}".repeat(64),
            languageId: "css",
          },
          startLine: 1,
          startColumn: 1,
          confidence: "exact",
        }),
      ),
    });
    expect(createRulesSourcesMessageSchema(Number.MAX_SAFE_INTEGER)
      .safeParse(oversized).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8"))
      .toBeGreaterThan(RULES_SOURCES_ENVELOPE_MAX_BYTES);
    expect(RulesSourcesMessageSchema.safeParse(oversized).success).toBe(false);
  });

  it("parses only the minimal correlated rules.open intent", () => {
    const message = rulesOpenMessage();

    expect(RulesOpenMessageSchema.parse(message)).toEqual(message);
    expect(parseMessage(message)).toEqual(message);
    for (const forbidden of [
      "ruleRef",
      "uri",
      "path",
      "url",
      "mapPath",
      "line",
      "column",
      "range",
      "command",
    ]) {
      expect(() => RulesOpenMessageSchema.parse(
        rulesOpenMessage({ [forbidden]: forbidden }),
      )).toThrow();
    }
  });

  it("carries a clicked declaration by name and occurrence only", () => {
    const message = rulesOpenMessage({
      declaration: { property: "margin-top", occurrence: 1 },
    });
    expect(RulesOpenMessageSchema.parse(message)).toEqual(message);
    expect(RulesOpenMessageSchema.parse(rulesOpenMessage({
      declaration: { property: "--brand-color", occurrence: 0 },
    })).declaration?.property).toBe("--brand-color");
    for (const declaration of [
      { property: "", occurrence: 0 },
      { property: "color: red", occurrence: 0 },
      { property: "color", occurrence: -1 },
      { property: "color", occurrence: 1.5 },
      { property: "color", occurrence: 128 },
      { property: "color", occurrence: 0, line: 3 },
      { property: "color" },
    ]) {
      expect(RulesOpenMessageSchema.safeParse(
        rulesOpenMessage({ declaration }),
      ).success).toBe(false);
    }
  });

  it("rejects v6 rule source messages", () => {
    expect(() => parseMessage(rulesSourcesMessage({ protocolVersion: 6 })))
      .toThrow();
    expect(() => parseMessage(rulesOpenMessage({ protocolVersion: 6 })))
      .toThrow();
  });
});

describe("public stylesheet URL boundary", () => {
  it("canonicalizes relative sources with one configurable public policy", () => {
    expect(canonicalizePublicStylesheetUrl("../assets/app.css", {
      baseUrl: "https://example.test/pages/current.html",
    })).toBe("https://example.test/assets/app.css");

    const prefix = "https://example.test/";
    const internalOnlyUrl = `${prefix}${"a".repeat(
      RULE_EVIDENCE_LIMITS.sourceUrlLength + 1 - prefix.length,
    )}`;
    expect(canonicalizePublicStylesheetUrl(internalOnlyUrl)).toBeUndefined();
    expect(canonicalizePublicStylesheetUrl(internalOnlyUrl, {
      maxLength: INSPECT_LIMITS.urlLength,
    })).toBe(internalOnlyUrl);

    for (const hostile of [
      "/var/private/app.css",
      "\\\\server\\share\\app.css",
      "https://user@example.test/app.css",
      "https://EXAMPLE.test/app.css",
      "https://example.test/app.css#",
      "https://example.test/app%00.css",
    ]) {
      expect(canonicalizePublicStylesheetUrl(hostile, {
        baseUrl: "https://example.test/page",
      })).toBeUndefined();
    }
  });

  it.each([
    "https://example.test/app.css",
    "https://example.test/app.css?v=100%",
    "http://localhost:3000/assets/app.css?theme=dark",
    "http://127.0.0.1/private.css",
    "https://[::1]/private.css",
  ])("accepts canonical public stylesheet URL %s", (url) => {
    expect(PublicStylesheetUrlSchema.parse(url)).toBe(url);
  });

  it.each([
    "",
    "/app.css",
    "./app.css",
    "/var/private/app.css",
    "C:\\private\\app.css",
    "\\\\server\\share\\app.css",
    "file:///private/app.css",
    "blob:https://example.test/id",
    "data:text/css,body{}",
    "chrome-extension://abc/app.css",
    "moz-extension://abc/app.css",
    "resource://gre/app.css",
    "about:blank",
    "javascript:alert(1)",
    "https://user@example.test/app.css",
    "https://user:pass@example.test/app.css",
    "https://example.test/app.css#",
    "https://example.test/app.css#fragment",
    "https:\\example.test\\app.css",
    "https://example.test:443/app.css",
    "https://EXAMPLE.test/app.css",
    "https://example.test/a/../app.css",
    "https://example.test/app.css\u0000",
    "https://example.test/app.css\u0085",
    "https://example.test/app\u202E.css",
    "https://example.test/app\u2066.css",
    "https://example.test/app%00.css",
    "https://example.test/app%C2%85.css",
    "https://example.test/app%E2%81%A6.css",
    "https://example.test/app%5Csecret.css",
  ])("rejects non-public or non-canonical stylesheet URL %j", (url) => {
    expect(PublicStylesheetUrlSchema.safeParse(url).success).toBe(false);
  });
});
