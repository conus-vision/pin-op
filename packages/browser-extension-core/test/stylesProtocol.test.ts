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
  type StylesSetPseudoStatesRequest,
} from "../src/stylesProtocol.js";

describe("stylesProtocol", () => {
  it("parses the exact request, matched response, invalidation event, and every error code", () => {
    const request = stylesRequest();
    expect(parseStylesRequest(request)).toEqual(request);
    const manualRequest = { ...request, manualRefresh: true as const };
    expect(parseStylesRequest(manualRequest)).toEqual(manualRequest);

    const matched = matchedResponse();
    expect(parseStylesResponse(matched)).toEqual(matched);
    const setRequest = pseudoStatesRequest();
    expect(parseStylesRequest(setRequest)).toEqual(setRequest);
    const setResponse = pseudoStatesResponse();
    expect(parseStylesResponse(setResponse)).toEqual(setResponse);
    expect(parseStylesEvent({
      type: "styles.invalidated",
      documentEpoch: 4,
      stylesRevision: 8,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover", "focus"],
    })).toEqual({
      type: "styles.invalidated",
      documentEpoch: 4,
      stylesRevision: 8,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover", "focus"],
    });

    for (const code of [
      "invalid-request",
      "stale-document",
      "stale-selection",
      "stale-styles",
      "stale-pseudo-state",
      "unknown-node",
      "node-unavailable",
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

  it("requires canonical pseudo-state commands and deeply freezes accepted arrays", () => {
    for (const states of [
      [],
      ["hover"],
      ["focus"],
      ["hover", "focus"],
    ] as const) {
      const request = parseStylesRequest({ ...pseudoStatesRequest(), states });
      const response = parseStylesResponse({ ...pseudoStatesResponse(), states });
      expect(request).toMatchObject({ type: "styles.setPseudoStates", states });
      expect(response).toMatchObject({ type: "styles.pseudoStates", states });
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.states)).toBe(true);
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.type === "styles.pseudoStates" && response.states)).toBe(true);
    }

    for (const states of [
      ["focus", "hover"],
      ["hover", "hover"],
      ["focus", "focus"],
      ["hover", "focus", "hover"],
      ["active"],
    ]) {
      expect(() => parseStylesRequest({ ...pseudoStatesRequest(), states }))
        .toThrow(/styles protocol/i);
      expect(() => parseStylesResponse({ ...pseudoStatesResponse(), states }))
        .toThrow(/styles protocol/i);
    }

    const sparse = new Array(2);
    sparse[0] = "hover";
    expect(() => parseStylesRequest({ ...pseudoStatesRequest(), states: sparse }))
      .toThrow(/styles protocol/i);

    let getterCalls = 0;
    const accessor = ["hover"];
    Object.defineProperty(accessor, 0, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hover";
      },
    });
    expect(() => parseStylesRequest({ ...pseudoStatesRequest(), states: accessor }))
      .toThrow(/styles protocol/i);
    expect(getterCalls).toBe(0);

    const symbolStates = ["hover"] as unknown as Record<PropertyKey, unknown>;
    symbolStates[Symbol("hidden")] = true;
    expect(() => parseStylesRequest({ ...pseudoStatesRequest(), states: symbolStates }))
      .toThrow(/styles protocol/i);
  });

  it("requires exact pseudo command keys, revision CAS values, and bounded result counts", () => {
    expect(() => parseStylesRequest({ ...pseudoStatesRequest(), extra: true }))
      .toThrow(/styles protocol/i);
    const { expectedStylesRevision: _missing, ...missingCas } = pseudoStatesRequest();
    expect(() => parseStylesRequest(missingCas)).toThrow(/styles protocol/i);
    for (const [key, value] of [
      ["expectedStylesRevision", -1],
      ["expectedPseudoStateRevision", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(() => parseStylesRequest({ ...pseudoStatesRequest(), [key]: value }))
        .toThrow(/styles protocol/i);
    }
    expect(() => parseStylesRequest({
      ...pseudoStatesRequest(),
      expectedStylesRevision: 1,
      expectedPseudoStateRevision: 2,
    })).toThrow(/styles protocol/i);

    expect(() => parseStylesResponse({ ...pseudoStatesResponse(), extra: true }))
      .toThrow(/styles protocol/i);
    for (const [key, value] of [
      ["stylesRevision", 2],
      ["stylesheetRevision", 10],
      ["pseudoStateRevision", 10],
      ["unsupportedRuleCount", STYLES_PROTOCOL_MAX_RULES + 1],
      ["inaccessibleStylesheetCount", 257],
      ["approximateRuleCount", STYLES_PROTOCOL_MAX_RULES + 1],
    ] as const) {
      expect(() => parseStylesResponse({ ...pseudoStatesResponse(), [key]: value }))
        .toThrow(/styles protocol/i);
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
      pseudoStateRevision: 2,
      pseudoStates: ["hover", "focus"],
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
      ["pseudoStateRevision", 99],
      ["pseudoStates", ["focus"]],
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
      pseudoStateRevision: 0,
      pseudoStates: [],
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

    const setRequest = pseudoStatesRequest();
    expect(isStylesResponseForRequest(setRequest, pseudoStatesResponse())).toBe(true);
    expect(isStylesResponseForRequest(setRequest, matchedResponse())).toBe(false);
    expect(isStylesResponseForRequest(request, pseudoStatesResponse())).toBe(false);
    expect(isStylesResponseForRequest(setRequest, {
      ...pseudoStatesResponse(),
      selectionRevision: setRequest.selectionRevision + 1,
    })).toBe(false);
  });
});

function stylesRequest(): StylesGetMatchedRequest {
  return {
    type: "styles.getMatched",
    requestId: "styles-1",
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    pseudoStateRevision: 2,
    pseudoStates: ["hover", "focus"],
  };
}

function pseudoStatesRequest(): StylesSetPseudoStatesRequest {
  return {
    type: "styles.setPseudoStates",
    requestId: "pseudo-1",
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    expectedStylesRevision: 8,
    expectedPseudoStateRevision: 2,
    states: ["hover", "focus"],
  };
}

function pseudoStatesResponse() {
  return {
    type: "styles.pseudoStates" as const,
    requestId: "pseudo-1",
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    stylesRevision: 9,
    stylesheetRevision: 3,
    pseudoStateRevision: 3,
    states: ["hover", "focus"] as const,
    unsupportedRuleCount: 1,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 1,
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
    pseudoStateRevision: 2,
    pseudoStates: ["hover", "focus"] as const,
    styles: {
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      stylesRevision: 8,
      stylesheetRevision: 3,
      pseudoStateRevision: 2,
      pseudoStates: ["hover", "focus"] as const,
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
      unsupportedRuleCount: 1,
      approximateRuleCount: 1,
      partial: false,
      diagnostics: [],
    },
  };
}
