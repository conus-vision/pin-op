import { describe, expect, it } from "vitest";
import {
  STYLES_PROTOCOL_MAX_CONTEXTS,
  STYLES_PROTOCOL_MAX_DECLARATIONS_PER_RULE,
  STYLES_PROTOCOL_MAX_DIAGNOSTICS,
  STYLES_PROTOCOL_MAX_INHERITED_GROUPS,
  STYLES_PROTOCOL_MAX_MATCHING_SELECTOR_INDICES,
  STYLES_PROTOCOL_MAX_RULES,
  STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES,
  isStylesResponseForRequest,
  parseStylesEvent,
  parseStylesRequest,
  parseStylesResponse,
  stylesProtocolEnvelopeWithinBudget,
  type StylesGetMatchedRequest,
} from "../src/stylesProtocol.js";

describe("stylesProtocol", () => {
  it("parses the exact request, matched response, invalidation event, and every error code", () => {
    const request = stylesRequest();
    expect(parseStylesRequest(request)).toEqual(request);
    const manualRequest = { ...request, manualRefresh: true as const };
    expect(parseStylesRequest(manualRequest)).toEqual(manualRequest);

    const matched = matchedResponse();
    expect(parseStylesResponse(matched)).toEqual(matched);
    expect(parseStylesEvent({
      type: "styles.invalidated",
      documentEpoch: 4,
      stylesRevision: 8,
      stylesheetRevision: 3,
    })).toEqual({
      type: "styles.invalidated",
      documentEpoch: 4,
      stylesRevision: 8,
      stylesheetRevision: 3,
    });

    for (const code of [
      "invalid-request",
      "stale-document",
      "stale-selection",
      "unknown-node",
      "inaccessible",
      "cancelled",
      "internal-error",
    ] as const) {
      expect(parseStylesResponse({
        type: "styles.error",
        requestId: "styles-1",
        code,
      })).toEqual({ type: "styles.error", requestId: "styles-1", code });
    }
  });

  it("requires exact keys at every level", () => {
    expect(() => parseStylesRequest({ ...stylesRequest(), tabId: 9 }))
      .toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({ ...matchedResponse(), channel: "x" }))
      .toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...matchedResponse(),
      styles: { ...matchedResponse().styles, nativeRule: {} },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...matchedResponse(),
      styles: {
        ...matchedResponse().styles,
        rules: [{ ...matchedResponse().styles.rules[0], editable: true }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesEvent({
      type: "styles.invalidated",
      documentEpoch: 4,
      stylesRevision: 8,
      stylesheetRevision: 3,
      reason: "page-controlled",
    })).toThrow(/styles protocol/i);
    for (const manualRefresh of [false, 1, "true", null]) {
      expect(() => parseStylesRequest({ ...stylesRequest(), manualRefresh }))
        .toThrow(/styles protocol/i);
    }
  });

  it("rejects invalid revision pairs and mismatched nested identities", () => {
    expect(() => parseStylesResponse({
      ...matchedResponse(),
      stylesRevision: 2,
      stylesheetRevision: 3,
      styles: {
        ...matchedResponse().styles,
        stylesRevision: 2,
        stylesheetRevision: 3,
      },
    })).toThrow(/styles protocol/i);
    for (const [key, value] of [
      ["documentEpoch", 99],
      ["nodeRef", "other-node"],
      ["selectionRevision", 99],
      ["stylesRevision", 99],
      ["stylesheetRevision", 99],
    ] as const) {
      expect(() => parseStylesResponse({
        ...matchedResponse(),
        styles: { ...matchedResponse().styles, [key]: value },
      })).toThrow(/styles protocol/i);
    }
    expect(() => parseStylesEvent({
      type: "styles.invalidated",
      documentEpoch: 1,
      stylesRevision: 1,
      stylesheetRevision: 2,
    })).toThrow(/styles protocol/i);
  });

  it("rejects hostile getters, proxies, symbols, sparse arrays, and non-data records without invoking page code", () => {
    let getterCalls = 0;
    const getter = {
      get type() {
        getterCalls += 1;
        return "styles.getMatched";
      },
      requestId: "styles-1",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
    };
    expect(() => parseStylesRequest(getter)).toThrow(/styles protocol/i);
    expect(getterCalls).toBe(0);

    let proxyCalls = 0;
    const proxy = new Proxy(stylesRequest(), {
      getOwnPropertyDescriptor() {
        proxyCalls += 1;
        throw new Error("page code");
      },
    });
    expect(() => parseStylesRequest(proxy)).toThrow(/styles protocol/i);
    expect(proxyCalls).toBeGreaterThan(0);

    const symbolRecord = { ...stylesRequest() } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol("hidden")] = true;
    expect(() => parseStylesRequest(symbolRecord)).toThrow(/styles protocol/i);

    const sparse = matchedResponse();
    const rules = new Array(1);
    expect(() => parseStylesResponse({
      ...sparse,
      styles: { ...sparse.styles, rules },
    })).toThrow(/styles protocol/i);
  });

  it("enforces every nested count and string bound", () => {
    const response = matchedResponse();
    const rule = response.styles.rules[0]!;
    const tooMany = (length: number, value: unknown) =>
      Array.from({ length: length + 1 }, () => value);

    expect(() => parseStylesResponse({
      ...response,
      styles: { ...response.styles, rules: tooMany(STYLES_PROTOCOL_MAX_RULES, rule) },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        inherited: tooMany(STYLES_PROTOCOL_MAX_INHERITED_GROUPS, {
          ancestorIndex: 1,
          elementName: "div",
          rules: [],
        }),
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: { ...response.styles, diagnostics: tooMany(STYLES_PROTOCOL_MAX_DIAGNOSTICS, "partial") },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ...rule,
          declarations: tooMany(STYLES_PROTOCOL_MAX_DECLARATIONS_PER_RULE, rule.declarations[0]),
        }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ...rule,
          contexts: tooMany(STYLES_PROTOCOL_MAX_CONTEXTS, { kind: "media", text: "screen" }),
        }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ...rule,
          matchingSelectorIndices: tooMany(STYLES_PROTOCOL_MAX_MATCHING_SELECTOR_INDICES, 0),
        }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{ ...rule, selectorText: "x".repeat(2_049) }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ...rule,
          declarations: [{ ...rule.declarations[0], value: "x".repeat(16_385) }],
        }],
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        inaccessibleStylesheetCount: 257,
      },
    })).toThrow(/styles protocol/i);
    expect(() => parseStylesResponse({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ...rule,
          source: {
            sourceUrl: "https://example.test/app.css",
            startLine: 5,
            startColumn: 2,
            endLine: 5,
            endColumn: 1,
            rulePath: "0",
          },
        }],
      },
    })).toThrow(/styles protocol/i);
  });

  it("enforces the 512 KiB serialized response ceiling using UTF-8 bytes", () => {
    expect(STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES).toBe(512 * 1024);
    expect(stylesProtocolEnvelopeWithinBudget(matchedResponse())).toBe(true);
    expect(stylesProtocolEnvelopeWithinBudget({ value: "😀".repeat(140_000) }))
      .toBe(false);

    const response = matchedResponse();
    const largeRules = Array.from({ length: 40 }, (_, index) => ({
      ...response.styles.rules[0],
      ruleRef: `rule-${index}`,
      declarations: [{
        ...response.styles.rules[0]!.declarations[0],
        ruleRef: `rule-${index}`,
        value: "😀".repeat(8_000),
      }],
    }));
    expect(() => parseStylesResponse({
      ...response,
      styles: { ...response.styles, rules: largeRules },
    })).toThrow(/styles protocol/i);
  });

  it("correlates request IDs and every echoed identity", () => {
    const request = stylesRequest();
    expect(isStylesResponseForRequest(request, matchedResponse())).toBe(true);
    for (const response of [
      { ...matchedResponse(), requestId: "other" },
      { ...matchedResponse(), documentEpoch: 5 },
      { ...matchedResponse(), nodeRef: "other" },
      { ...matchedResponse(), selectionRevision: 8 },
    ]) {
      expect(isStylesResponseForRequest(request, response)).toBe(false);
    }
    expect(isStylesResponseForRequest(request, {
      type: "styles.error",
      requestId: request.requestId,
      code: "cancelled",
    })).toBe(true);
  });
});

function stylesRequest(): StylesGetMatchedRequest {
  return {
    type: "styles.getMatched",
    requestId: "styles-1",
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
  };
}

function matchedResponse() {
  return {
    type: "styles.matched" as const,
    requestId: "styles-1",
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    stylesRevision: 8,
    stylesheetRevision: 3,
    styles: {
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      stylesRevision: 8,
      stylesheetRevision: 3,
      inline: {
        ruleRef: "rule-inline",
        selectorText: "element.style",
        matchingSelectorIndices: [0],
        declarations: [{
          ruleRef: "rule-inline",
          property: "color",
          value: "red",
          important: false,
          valueTruncated: false,
          state: "winning-known-author" as const,
          reason: "highest-precedence-known-author-declaration" as const,
        }],
        contexts: [],
        source: { rulePath: "0" },
      },
      rules: [{
        ruleRef: "rule-1",
        selectorText: ".card",
        matchingSelectorIndices: [0],
        declarationsTruncated: true,
        declarations: [{
          ruleRef: "rule-1",
          property: "display",
          value: "grid",
          important: false,
          valueTruncated: false,
          state: "winning-known-author" as const,
          reason: "highest-precedence-known-author-declaration" as const,
        }],
        contexts: [{ kind: "media" as const, text: "screen" }],
        source: {
          sourceUrl: "https://example.test/app.css?build=1",
          startLine: 3,
          startColumn: 1,
          endLine: 5,
          endColumn: 2,
          rulePath: "0.1",
        },
      }],
      inherited: [{ ancestorIndex: 1, elementName: "main", rules: [] }],
      inaccessibleStylesheetCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}
