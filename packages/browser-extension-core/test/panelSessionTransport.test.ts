import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type RulesSourcesMessage,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  type DomEvent,
  type DomRequest,
} from "../src/domProtocol.js";
import { PanelSessionTransport } from "../src/panelSessionTransport.js";
import type {
  StylesGetMatchedRequest,
  StylesSetPseudoStatesRequest,
} from "../src/stylesProtocol.js";

describe("PanelSessionTransport", () => {
  it("routes matched-style queries only through the bound trusted tab and validates correlation", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const request = {
      ...stylesRequest("styles-a"),
      manualRefresh: true as const,
    };
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return stylesMatched(request);
      },
      postPanelMessage: vi.fn(),
    });
    const binding = transport.bind("panel-a", 7);
    await expect(transport.requestStyles("panel-a", request))
      .resolves.toEqual(stylesMatched(request));
    expect(sent).toEqual([{ tabId: 7, message: request }]);

    binding.dispose();
    await expect(transport.requestStyles("panel-a", request)).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-a",
      code: "cancelled",
    });
  });

  it("routes an atomic pseudo-state command only through the bound trusted tab", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const request = pseudoStatesRequest("pseudo-a");
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return pseudoStatesResponse(request);
      },
      postPanelMessage: vi.fn(),
    });
    const binding = transport.bind("panel-a", 7);

    await expect(transport.requestStyles("panel-a", request))
      .resolves.toEqual(pseudoStatesResponse(request));
    expect(sent).toEqual([{ tabId: 7, message: request }]);

    binding.dispose();
    await expect(transport.requestStyles("panel-a", request)).resolves.toEqual({
      type: "styles.error",
      requestId: "pseudo-a",
      code: "cancelled",
    });
  });

  it("fails closed when a pseudo-state response does not echo the requested states", async () => {
    const request = pseudoStatesRequest("pseudo-mismatch");
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => pseudoStatesResponse({
        ...request,
        states: ["hover"] as const,
      }),
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.requestStyles("panel-a", request)).resolves.toEqual({
      type: "styles.error",
      requestId: "pseudo-mismatch",
      code: "internal-error",
    });
  });

  it("drops mismatched style identities and stale replies after channel replacement", async () => {
    const pending = deferred<unknown>();
    const request = stylesRequest("styles-a");
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => await pending.promise,
      postPanelMessage: vi.fn(),
    });
    const first = transport.bind("panel-a", 7);
    const result = transport.requestStyles("panel-a", request);
    first.dispose();
    transport.bind("panel-a", 8);
    pending.resolve(stylesMatched({ ...request, nodeRef: "wrong" }));
    await expect(result).resolves.toEqual({
      type: "styles.error",
      requestId: "styles-a",
      code: "cancelled",
    });
  });
  it("binds DOM requests to the registered channel tab", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return rootResponse("root-a");
      },
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", rootRequest("root-a")))
      .resolves.toEqual(rootResponse("root-a"));
    expect(sent).toEqual([{
      tabId: 7,
      message: rootRequest("root-a"),
    }]);
  });

  it("keeps stable locator queries browser-local and correlates their response", async () => {
    const sent: Array<{ tabId: number; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      async sendTabMessage(tabId, message) {
        sent.push({ tabId, message });
        return locatorResponse("locator-a");
      },
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", locatorRequest("locator-a")))
      .resolves.toEqual(locatorResponse("locator-a"));
    expect(sent).toEqual([{
      tabId: 7,
      message: locatorRequest("locator-a"),
    }]);
  });

  it("maps a malformed stable locator request to invalid-request", async () => {
    const sendTabMessage = vi.fn();
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", {
      ...locatorRequest("locator-invalid"),
      locator: { ...stableLocator(), version: 2 },
    } as unknown as DomRequest)).resolves.toEqual({
      type: "dom.error",
      requestId: "locator-invalid",
      code: "invalid-request",
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it("never accepts a panel-supplied tab ID", async () => {
    const sendTabMessage = vi.fn(async () => rootResponse("root-a"));
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", {
      ...rootRequest("root-a"),
      tabId: 999,
    } as unknown as DomRequest)).resolves.toMatchObject({
      type: "dom.error",
      requestId: "root-a",
      code: "invalid-request",
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it("fails closed when a channel is disposed during a request", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((next) => {
      resolve = next;
    });
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    const pending = transport.request("panel-a", rootRequest("root-a"));
    transport.disposeChannel("panel-a");
    resolve(rootResponse("root-a"));

    await expect(pending).resolves.toMatchObject({
      type: "dom.error",
      requestId: "root-a",
      code: "session-disposed",
    });
  });

  it.each([
    ["wrong request ID", rootRequest("root-a"), rootResponse("root-b")],
    [
      "missing request ID",
      rootRequest("root-a"),
      { type: "dom.error", code: "stale-node" },
    ],
    [
      "wrong root response family",
      rootRequest("root-a"),
      childrenResponse("root-a"),
    ],
    [
      "wrong children response family",
      childrenRequest("children-a"),
      rootResponse("children-a"),
    ],
    [
      "wrong locator response family",
      locatorRequest("locator-a"),
      rootResponse("locator-a"),
    ],
    [
      "wrong root document epoch",
      { ...rootRequest("root-epoch"), documentEpoch: 2 },
      rootResponse("root-epoch"),
    ],
    [
      "wrong children document epoch",
      childrenRequest("children-epoch"),
      { ...childrenResponse("children-epoch"), documentEpoch: 2 },
    ],
    [
      "wrong children node reference",
      childrenRequest("children-node"),
      { ...childrenResponse("children-node"), nodeRef: "node-forged" },
    ],
    [
      "wrong children branch revision",
      childrenRequest("children-branch"),
      { ...childrenResponse("children-branch"), branchRevision: 1 },
    ],
    [
      "contradictory error document epoch",
      childrenRequest("children-error"),
      {
        type: "dom.error" as const,
        requestId: "children-error",
        documentEpoch: 2,
        code: "stale-branch" as const,
      },
    ],
  ])("returns a correlated internal error for a %s", async (
    _case,
    request,
    response,
  ) => {
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request("panel-a", request)).resolves.toEqual({
      type: "dom.error",
      requestId: request.requestId,
      code: "internal-error",
    });
  });

  it("accepts a correlated bounded error that omits documentEpoch", async () => {
    const response = {
      type: "dom.error" as const,
      requestId: "children-bounded-error",
      code: "stale-branch" as const,
    };
    const transport = new PanelSessionTransport({
      sendTabMessage: async () => response,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);

    await expect(transport.request(
      "panel-a",
      childrenRequest("children-bounded-error"),
    )).resolves.toEqual(response);
  });

  it("coalesces only the same selection-bound republish request", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const sendTabMessage = vi.fn(async () => new Promise<unknown>((resolve) => {
      resolvers.push(resolve);
    }));
    const transport = new PanelSessionTransport({
      sendTabMessage,
      postPanelMessage: vi.fn(),
    });
    transport.bind("panel-a", 7);
    const firstRequest = {
      type: "pin-op.inspect.republish" as const,
      contentSessionId: "content-a",
      documentEpoch: 4,
      nodeRef: "node-a",
      selectionRevision: 7,
    };

    const first = transport.republishSelection("panel-a", firstRequest);
    const second = transport.republishSelection("panel-a", firstRequest);
    const replacement = transport.republishSelection("panel-a", {
      ...firstRequest,
      nodeRef: "node-b",
      selectionRevision: 8,
    });

    expect(sendTabMessage).toHaveBeenCalledTimes(2);
    expect(sendTabMessage.mock.calls).toEqual([
      [7, firstRequest],
      [7, { ...firstRequest, nodeRef: "node-b", selectionRevision: 8 }],
    ]);
    resolvers[0]!(false);
    resolvers[1]!(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await expect(replacement).resolves.toBe(true);
  });

  it("publishes only validated events to the bound panel channel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    transport.bind("panel-b", 8);
    const peerState: PeerStateMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "peerState",
      messageId: "peer-1",
      sessionId: "session-a",
      role: "ide",
      connected: false,
      peerGeneration: 1,
      metadata: {},
    };

    transport.publish("panel-a", peerState);
    transport.publish("panel-missing", peerState);

    expect(published).toEqual([{ channel: "panel-a", message: peerState }]);
  });

  it("preserves the DOM invalidation branch limit when publishing", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    const aboveProtocolSnapshotLimit = invalidationEvent(65);
    const atDomLimit = invalidationEvent(
      DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
    );

    transport.publish("panel-a", aboveProtocolSnapshotLimit);
    transport.publish("panel-a", atDomLimit);
    transport.publish(
      "panel-a",
      invalidationEvent(DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES + 1),
    );

    expect(published).toEqual([
      { channel: "panel-a", message: aboveProtocolSnapshotLimit },
      { channel: "panel-a", message: atDomLimit },
    ]);
  });

  it("publishes only strict navigation state while preserving optional and zero fields", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    transport.bind("panel-b", 8);
    const activeZero = sourceNavigationState(2, 0);
    const noActiveMatch = sourceNavigationState(0);

    transport.publish("panel-a", activeZero);
    transport.publish("panel-a", noActiveMatch);
    transport.publish("panel-missing", activeZero);
    transport.publish("panel-b", {
      ...activeZero,
      activeMatchIndex: 2,
    } as SourceNavigationStateMessage);
    transport.publish("panel-b", {
      ...activeZero,
      sessionId: "",
    } as SourceNavigationStateMessage);

    expect(published).toEqual([
      { channel: "panel-a", message: activeZero },
      { channel: "panel-a", message: noActiveMatch },
    ]);
  });

  it("publishes only strict source matches to the bound panel channel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    const matches = sourceMatches();
    const hostile = { ...matches } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "matches", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    const inherited = Object.create(matches) as SourceMatchesMessage;
    let proxyGetterCalls = 0;
    const proxyHostile = new Proxy(matches, {
      get() {
        proxyGetterCalls += 1;
        throw new Error("proxy getter must not run");
      },
      ownKeys() {
        throw new Error("proxy reflection is hostile");
      },
    });

    transport.publish("panel-a", matches);
    transport.publish("panel-missing", matches);
    transport.publish("panel-a", {
      ...matches,
      path: "/secret.scss",
    } as SourceMatchesMessage);
    expect(() => transport.publish(
      "panel-a",
      hostile as unknown as SourceMatchesMessage,
    )).not.toThrow();
    expect(() => transport.publish("panel-a", inherited)).not.toThrow();
    expect(() => transport.publish("panel-a", proxyHostile)).not.toThrow();

    expect(getterCalls).toBe(0);
    expect(proxyGetterCalls).toBe(0);
    expect(published).toEqual([{ channel: "panel-a", message: matches }]);
  });

  it("publishes strict Rules sources only to the bound originating channel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);
    transport.bind("panel-b", 8);
    const sources = rulesSources();

    transport.publish("panel-a", sources);
    transport.publish("panel-missing", sources);
    transport.publish("panel-b", {
      ...sources,
      path: "/secret.scss",
    } as unknown as RulesSourcesMessage);

    expect(published).toEqual([{ channel: "panel-a", message: sources }]);
  });

  it("publishes only strict local generation-scoped Rules invalidation", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);

    expect(transport.publishRulesInvalidated("panel-a", "inspect-1", 2))
      .toBe(true);
    expect(transport.publishRulesInvalidated("panel-missing", "inspect-1", 2))
      .toBe(false);
    expect(transport.publishRulesInvalidated("panel-a", "", 2)).toBe(false);
    expect(transport.publishRulesInvalidated("panel-a", "inspect-1", -1))
      .toBe(false);

    expect(published).toEqual([{
      channel: "panel-a",
      message: {
        type: "pin-op.rules.invalidated",
        inspectMessageId: "inspect-1",
        rulesGeneration: 2,
      },
    }]);
  });

  it("publishes a bounded correlated inspect start only to its bound panel", () => {
    const published: Array<{ channel: string; message: unknown }> = [];
    const transport = new PanelSessionTransport({
      sendTabMessage: vi.fn(),
      postPanelMessage(channel, message) {
        published.push({ channel, message });
      },
    });
    transport.bind("panel-a", 7);

    const expectedRuleRefs = ["rule-1", "rule-2"];
    transport.publishInspectStarted("panel-a", "inspect-1", 4, expectedRuleRefs);
    expectedRuleRefs.splice(0);
    transport.publishInspectStarted("panel-missing", "inspect-2", 4, []);
    transport.publishInspectStarted("panel-a", "", 4, []);
    transport.publishInspectStarted("panel-a", "x".repeat(129), 4, []);
    transport.publishInspectStarted("panel-a", "inspect-negative", -1, []);
    transport.publishInspectStarted("panel-a", "inspect-fractional", 1.5, []);
    transport.publishInspectStarted(
      "panel-a",
      "inspect-unsafe",
      Number.MAX_SAFE_INTEGER + 1,
      [],
    );
    transport.publishInspectStarted("panel-a", "inspect-duplicate", 5, [
      "rule-1",
      "rule-1",
    ]);
    transport.publishInspectStarted(
      "panel-a",
      "inspect-too-many",
      5,
      Array.from({ length: 257 }, (_, index) => `rule-${index}`),
    );

    expect(published).toEqual([{
      channel: "panel-a",
      message: {
        type: "pin-op.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 4,
        expectedRuleRefs: ["rule-1", "rule-2"],
      },
    }]);
    const started = published[0]?.message as {
      readonly expectedRuleRefs: readonly string[];
    };
    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(started.expectedRuleRefs)).toBe(true);
  });

  it("bounds channels and releases them through their handles", () => {
    const transport = new PanelSessionTransport({
      maxChannels: 1,
      sendTabMessage: vi.fn(),
      postPanelMessage: vi.fn(),
    });
    const first = transport.bind("panel-a", 7);

    expect(() => transport.bind("panel-b", 8)).toThrow(/limit/i);
    first.dispose();
    expect(() => transport.bind("panel-b", 8)).not.toThrow();
  });
});

function rootRequest(requestId: string) {
  return {
    type: "dom.getRoot" as const,
    requestId,
  };
}

function rootResponse(requestId: string) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    prologue: [],
    epilogue: [],
    node: {
      nodeRef: "node-root",
      kind: "element" as const,
      nodeType: 1,
      nodeName: "HTML",
      attributes: [],
      childCount: 1,
      relationship: "dom" as const,
      selectable: true,
      label: "html",
      expandable: true,
      branchRevision: 0,
      locator: stableLocator({ path: [pathSegment({ tagName: "html" })] }),
    },
  };
}

function childrenRequest(requestId: string) {
  return {
    type: "dom.getChildren" as const,
    requestId,
    documentEpoch: 1,
    nodeRef: "node-root",
    branchRevision: 0,
  };
}

function childrenResponse(requestId: string) {
  return {
    type: "dom.children" as const,
    requestId,
    documentEpoch: 1,
    nodeRef: "node-root",
    branchRevision: 0,
    nodes: [],
  };
}

function locatorRequest(requestId: string) {
  return {
    type: "dom.resolveLocator" as const,
    requestId,
    locator: stableLocator(),
  };
}

function locatorResponse(requestId: string) {
  const node = {
    nodeRef: "node-target",
    kind: "element" as const,
    nodeType: 1,
    nodeName: "BUTTON",
    attributes: [],
    childCount: 0,
    relationship: "dom" as const,
    selectable: true,
    label: "button#save",
    expandable: false,
    branchRevision: 0,
    locator: stableLocator({
      path: [pathSegment({ tagName: "button", id: "save" })],
    }),
  };
  return {
    type: "dom.locator" as const,
    requestId,
    documentEpoch: 2,
    node,
    ancestorPath: [node],
  };
}

function stableLocator(overrides: Partial<{
  version: number;
  targetKind: string;
  boundaries: Array<{
    kind: string;
    hostPath: ReturnType<typeof pathSegment>[];
  }>;
  path: ReturnType<typeof pathSegment>[];
}> = {}) {
  return {
    version: 1,
    targetKind: "element",
    boundaries: [],
    path: [pathSegment()],
    ...overrides,
  };
}

function pathSegment(overrides: Partial<{
  tagName: string;
  siblingIndex: number;
  id: string;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
}> = {}) {
  return {
    tagName: "div",
    siblingIndex: 0,
    ...overrides,
  };
}

function sourceNavigationState(
  selectedMatchCount: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${activeMatchIndex ?? "none"}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    selectedMatchCount,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}

function invalidationEvent(branchCount: number): DomEvent {
  return {
    type: "dom.invalidated",
    documentEpoch: 1,
    branches: Array.from({ length: branchCount }, (_, index) => ({
      nodeRef: `node-${index}`,
      branchRevision: index,
    })),
  };
}

function sourceMatches(): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: "source-matches-1",
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    document: { label: "card.scss", languageId: "scss" },
    matches: [{
      matchId: "match-1",
      targetRole: "selected",
      label: "card.scss:1",
      kind: "rule",
      relation: "selected",
      confidence: "exact",
      startLine: 1,
      endLine: 3,
      text: ".card {\n  color: red;\n}",
      truncated: false,
    }],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function rulesSources(): RulesSourcesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: "rules-sources-1",
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    sources: [{
      ruleRef: "rule-1",
      openAuthorityId: "authority-1",
      document: { label: "card.scss", languageId: "scss" },
      startLine: 41,
      startColumn: 3,
      confidence: "sourcemap",
    }],
    unresolvedRuleCount: 0,
    metadata: {},
  };
}

function stylesRequest(requestId: string): StylesGetMatchedRequest {
  return {
    type: "styles.getMatched",
    requestId,
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    pseudoStateRevision: 2,
    pseudoStates: ["hover"],
  };
}

function pseudoStatesRequest(requestId: string): StylesSetPseudoStatesRequest {
  return {
    type: "styles.setPseudoStates",
    requestId,
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    expectedStylesRevision: 8,
    expectedPseudoStateRevision: 2,
    states: ["hover", "focus"],
  };
}

function stylesMatched(request: StylesGetMatchedRequest) {
  return {
    type: "styles.matched" as const,
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision: 8,
    stylesheetRevision: 3,
    pseudoStateRevision: request.pseudoStateRevision,
    pseudoStates: request.pseudoStates,
    styles: {
      documentEpoch: request.documentEpoch,
      nodeRef: request.nodeRef,
      selectionRevision: request.selectionRevision,
      stylesRevision: 8,
      stylesheetRevision: 3,
      pseudoStateRevision: request.pseudoStateRevision,
      pseudoStates: request.pseudoStates,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      unsupportedRuleCount: 0,
      approximateRuleCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}

function pseudoStatesResponse(request: StylesSetPseudoStatesRequest) {
  return {
    type: "styles.pseudoStates" as const,
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision: 9,
    stylesheetRevision: 3,
    pseudoStateRevision: 3,
    states: request.states,
    unsupportedRuleCount: 1,
    inaccessibleStylesheetCount: 2,
    approximateRuleCount: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
