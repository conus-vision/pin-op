import { PROTOCOL_VERSION } from "@pin-op/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInspectorPanelRuntime,
  type InspectorPanelRuntimeOptions,
} from "../src/inspectorPanelRuntime.js";
import type { PanelInspectPort } from "../src/inspectPortProtocol.js";
import { PanelDiagnostics } from "../src/panelDiagnostics.js";
import { FakeDocument, type FakeElement } from "../../devtools-elements-ui/test/support/fakeDocument.js";

describe("startInspectorPanelRuntime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("owns an IDE-independent matched-style model and resets it on inspect invalidation", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    expect(runtime.matchedStylesModel.snapshot().state).toBe("idle");

    port.emitMessage({
      type: "styles.invalidated",
      documentEpoch: 1,
      stylesRevision: 3,
      stylesheetRevision: 1,
    });
    expect(runtime.matchedStylesModel.snapshot().state).toBe("idle");

    const first = runtime.matchedStylesModel.select({
      documentEpoch: 1,
      nodeRef: "node-card",
      selectionRevision: 2,
    });
    const request = lastMessage(port.sent, "styles.getMatched") as {
      requestId: string;
      documentEpoch: number;
      nodeRef: string;
      selectionRevision: number;
    };
    port.emitMessage(stylesMatched(request, 3, 1));
    await first;
    expect(runtime.matchedStylesModel.snapshot().state).toBe("ready");

    port.emitMessage({
      type: "styles.invalidated",
      documentEpoch: 1,
      stylesRevision: 4,
      stylesheetRevision: 1,
    });
    await Promise.resolve();
    const reload = lastMessage(port.sent, "styles.getMatched") as typeof request;
    expect(reload.requestId).not.toBe(request.requestId);
    port.emitMessage(stylesMatched(reload, 4, 1));
    await Promise.resolve();
    expect(runtime.matchedStylesModel.snapshot()).toMatchObject({
      state: "ready",
      key: { stylesRevision: 4, stylesheetRevision: 1 },
    });

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    expect(runtime.matchedStylesModel.snapshot().state).toBe("idle");
    runtime.dispose();
  });

  it("loads and renders Rules directly from the selected DOM node without source resolution", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 6,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();

    port.emitMessage(selection("selected-card", 6, 4));
    await flushAsync();

    const request = lastMessage(port.sent, "styles.getMatched") as {
      requestId: string;
      documentEpoch: number;
      nodeRef: string;
      selectionRevision: number;
    };
    expect(request).toMatchObject({
      documentEpoch: 6,
      nodeRef: "selected-card",
      selectionRevision: 4,
    });
    expect(harness.document.querySelector('[data-pane="rules"]')
      ?.getAttribute("data-state")).toBe("loading");
    expect(harness.sent).toEqual([
      { type: "pin-op.panelReady", channel: "inspector-channel" },
    ]);

    const response = stylesMatched(request, 9, 2);
    port.emitMessage({
      ...response,
      styles: {
        ...response.styles,
        rules: [{
          ruleRef: "rule-card",
          selectorText: ".selected-card",
          matchingSelectorIndices: [0],
          declarations: [{
            ruleRef: "rule-card",
            property: "color",
            value: "rebeccapurple",
            important: true,
            valueTruncated: false,
            state: "winning-known-author",
            reason: "highest-precedence-known-author-declaration",
          }],
          contexts: [{ kind: "media", text: "screen" }],
          source: {
            sourceUrl: "https://example.test/app.css?build=1",
            startLine: 17,
            startColumn: 5,
            endLine: 18,
            endColumn: 2,
            rulePath: "0.3",
          },
        }],
      },
    });
    await flushAsync();

    expect(harness.document.querySelector('[data-pane="rules"]')
      ?.getAttribute("data-state")).toBe("ready");
    expect(harness.document.querySelector('[data-rule-ref="rule-card"]')
      ?.textContent).toContain(".selected-card");
    expect(harness.document.querySelector('[data-rule-ref="rule-card"]')
      ?.textContent).toContain("color: rebeccapurple !important;");
    expect(harness.document.body.textContent).not.toContain("Source");

    runtime.dispose();
  });

  it("manually refreshes the current browser-local Rules query and exposes its revision probe", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    expect(harness.element("refresh-styles").disabled).toBe(true);

    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 6,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    port.emitMessage(selection("selected-card", 6, 4));
    await flushAsync();
    expect(harness.element("refresh-styles").disabled).toBe(false);

    const initialRequest = lastMessage(port.sent, "styles.getMatched") as {
      requestId: string;
      documentEpoch: number;
      nodeRef: string;
      selectionRevision: number;
    };
    const initialResponse = stylesMatched(initialRequest, 9, 2);
    port.emitMessage({
      ...initialResponse,
      styles: {
        ...initialResponse.styles,
        rules: [matchedRule("rule-stable", ".selected-card")],
      },
    });
    await flushAsync();

    const rulesRoot = harness.document.querySelector('[data-pane="rules"]');
    expect(rulesRoot).not.toBeNull();
    if (!rulesRoot) throw new Error("Missing Rules root");
    expect(rulesRoot.getAttribute("data-document-epoch")).toBe("6");
    expect(rulesRoot.getAttribute("data-selection-revision")).toBe("4");
    expect(rulesRoot.getAttribute("data-styles-revision")).toBe("9");
    expect(rulesRoot.getAttribute("data-stylesheet-revision")).toBe("2");
    expect(rulesRoot.getAttribute("data-probe-rule-ref")).toBe("rule-stable");

    harness.element("refresh-styles").dispatch("click");
    await flushAsync();
    const refreshRequest = lastMessage(port.sent, "styles.getMatched") as typeof initialRequest;
    expect(refreshRequest).toMatchObject({
      documentEpoch: 6,
      nodeRef: "selected-card",
      selectionRevision: 4,
    });
    expect(refreshRequest.requestId).not.toBe(initialRequest.requestId);
    const refreshResponse = stylesMatched(refreshRequest, 10, 2);
    port.emitMessage({
      ...refreshResponse,
      styles: {
        ...refreshResponse.styles,
        rules: [matchedRule("rule-stable", ".selected-card")],
      },
    });
    await flushAsync();

    expect(rulesRoot.getAttribute("data-styles-revision")).toBe("10");
    expect(rulesRoot.getAttribute("data-stylesheet-revision")).toBe("2");
    expect(rulesRoot.getAttribute("data-probe-rule-ref")).toBe("rule-stable");

    port.emitMessage({
      type: "dom.selectionCleared",
      documentEpoch: 6,
      selectionRevision: 5,
      nodeRef: "selected-card",
    });
    await flushAsync();
    expect(harness.element("refresh-styles").disabled).toBe(true);
    const requestCount = port.sent.filter((message) => (
      isType(message, "styles.getMatched")
    )).length;
    harness.element("refresh-styles").dispatch("click");
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "styles.getMatched")))
      .toHaveLength(requestCount);

    runtime.dispose();
  });

  it("renders browser-local partial Rules before any IDE link state", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);

    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 12,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    port.emitMessage(selection("unlinked-card", 12, 3));
    await flushAsync();

    const request = lastMessage(port.sent, "styles.getMatched") as {
      requestId: string;
      documentEpoch: number;
      nodeRef: string;
      selectionRevision: number;
    };
    const response = stylesMatched(request, 5, 2);
    port.emitMessage({
      ...response,
      styles: {
        ...response.styles,
        rules: [matchedRule("rule-unlinked", ".unlinked-card")],
        inaccessibleStylesheetCount: 1,
        partial: true,
        diagnostics: ["stylesheet-inaccessible"],
      },
    });
    await flushAsync();

    expect(runtime.matchedStylesModel.snapshot()).toMatchObject({
      state: "partial",
      key: {
        documentEpoch: 12,
        nodeRef: "unlinked-card",
        selectionRevision: 3,
      },
    });
    expect(harness.document.querySelector('[data-pane="rules"]')
      ?.getAttribute("data-state")).toBe("partial");
    expect(harness.document.querySelector('[data-rule-ref="rule-unlinked"]')
      ?.textContent).toContain(".unlinked-card");
    expect(harness.document.querySelector('[data-node-ref="unlinked-card"]'))
      .not.toBeNull();
    expect(harness.element("connection-status").dataset.state).toBe("notLinked");
    expect(harness.element("link-controls").hidden).toBe(false);
    expect(harness.element("link-onboarding").hidden).toBe(false);
    expect(harness.element("link-code").disabled).toBe(false);
    expect(harness.element("link-button").disabled).toBe(false);
    expect(harness.element("toolbar-features").hidden).toBe(false);
    expect(harness.element("inspect-mode").disabled).toBe(false);
    expect(harness.element("inspector-workspace").hidden).toBe(false);
    expect(harness.element("operational-footer").hidden).toBe(false);
    expect(harness.document.querySelector('[data-part="sidebar-extension"]')
      ?.hidden).toBe(true);
    expect(harness.sent).toEqual([
      { type: "pin-op.panelReady", channel: "inspector-channel" },
    ]);

    harness.element("inspect-mode").dispatch("click");
    await flushAsync();
    const enableInspect = lastMessage(port.sent, "pin-op.inspect.setEnabled");
    expect(enableInspect.enabled).toBe(true);
    port.emitMessage({
      type: "pin-op.inspect.result",
      requestId: enableInspect.requestId,
      ok: true,
    });
    await waitForPressed(harness.element("inspect-mode"));
    expect(harness.element("inspect-mode").getAttribute("aria-pressed"))
      .toBe("true");

    runtime.dispose();
  });

  it("retains browser-local Rules when the same content lease loses only its IDE link", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 13,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    port.emitMessage(selection("retained-card", 13, 6));
    await flushAsync();
    const request = lastMessage(port.sent, "styles.getMatched") as {
      requestId: string;
      documentEpoch: number;
      nodeRef: string;
      selectionRevision: number;
    };
    const response = stylesMatched(request, 8, 4);
    port.emitMessage({
      ...response,
      styles: {
        ...response.styles,
        rules: [matchedRule("rule-retained", ".retained-card")],
      },
    });
    await flushAsync();
    expect(runtime.matchedStylesModel.snapshot().state).toBe("ready");
    const rootRequestCount = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;

    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
    await flushAsync();

    expect(runtime.matchedStylesModel.snapshot()).toMatchObject({
      state: "ready",
      key: { nodeRef: "retained-card" },
    });
    expect(harness.document.querySelector('[data-rule-ref="rule-retained"]')
      ?.textContent).toContain(".retained-card");
    expect(harness.document.querySelector('[data-node-ref="retained-card"]'))
      .not.toBeNull();
    expect(harness.element("link-onboarding").hidden).toBe(false);
    expect(harness.element("inspector-workspace").hidden).toBe(false);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestCount);

    port.emitMessage({ type: "pin-op.windowState", state: "error" });
    await flushAsync();

    expect(runtime.matchedStylesModel.snapshot()).toMatchObject({
      state: "ready",
      key: { nodeRef: "retained-card" },
    });
    expect(harness.document.querySelector('[data-rule-ref="rule-retained"]'))
      .not.toBeNull();
    expect(harness.element("link-controls").hidden).toBe(false);
    expect(harness.element("inspector-workspace").hidden).toBe(false);
    expect(port.disconnected).toBe(false);

    port.disconnect();
    await waitForPortCount(harness.ports, 2);
    const replacementPort = requiredPort(harness.ports, 1);

    expect(runtime.matchedStylesModel.snapshot().state).toBe("idle");
    expect(replacementPort.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);

    runtime.dispose();
  });

  it("uses the shared panel ownership while mounting only the neutral Inspector shell", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;

    expect(harness.ports).toHaveLength(1);
    expect(harness.sent).toEqual([
      { type: "pin-op.panelReady", channel: "inspector-channel" },
    ]);
    expect(harness.document.querySelector('[data-part="inspector-workspace"]')).not.toBeNull();
    expect(harness.document.querySelector('[data-pane="dom"]')).not.toBeNull();
    expect(harness.document.querySelector('[data-pane="rules"]')).not.toBeNull();
    expect(harness.document.body.textContent).not.toContain("Source");
    expect(harness.document.document.getElementById("source-pane-root")).toBeNull();
    expect(harness.document.document.getElementById("dom-tree")).toBeNull();

    harness.element("link-code").value = "48735 07";
    harness.element("link-code").dispatch("input");
    harness.element("link-form").dispatch("submit");
    await waitForMessage(harness.sent, "pin-op.linkWindow");
    expect(harness.sent.filter((message) => isType(message, "pin-op.linkWindow")))
      .toHaveLength(1);

    const port = requiredPort(harness.ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    port.emitMessage({
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 0,
    });
    await flushAsync();

    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 2,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();
    expect(harness.document.querySelector('[data-node-ref="root"]')).not.toBeNull();

    harness.element("inspect-mode").dispatch("click");
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "pin-op.inspect.setEnabled")))
      .toHaveLength(1);
    const enableInspect = lastMessage(port.sent, "pin-op.inspect.setEnabled");
    port.emitMessage({
      type: "pin-op.inspect.result",
      requestId: enableInspect.requestId,
      ok: true,
    });
    await flushAsync();

    harness.element("auto-refresh-enabled").checked = false;
    harness.element("auto-refresh-enabled").dispatch("change");
    expect(port.sent.filter((message) => isType(message, "pin-op.tab.settings")))
      .toHaveLength(1);

    harness.element("disconnect-button").dispatch("click");
    await waitForMessageCount(port.sent, "pin-op.inspect.setEnabled", 2);
    const disableInspect = lastMessage(port.sent, "pin-op.inspect.setEnabled");
    port.emitMessage({
      type: "pin-op.inspect.result",
      requestId: disableInspect.requestId,
      ok: true,
    });
    await waitForMessage(harness.sent, "pin-op.unlinkWindow");
    expect(harness.sent.filter((message) => isType(message, "pin-op.unlinkWindow")))
      .toHaveLength(1);

    runtime.dispose();
    await runtime.closed;
    expect(port.disconnected).toBe(true);
    expect(harness.document.querySelector('[data-part="inspector-workspace"]')).toBeNull();
    expect(harness.unload).toBeUndefined();
  });

  it("rejects stale epoch/revision and post-dispose DOM events before presentation", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 4,
      node: domNode("root", "HTML", true),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();

    port.emitMessage(selection("stale-epoch", 3, 99));
    port.emitMessage(selection("current", 4, 7));
    port.emitMessage(selection("stale-revision", 4, 6));
    await flushAsync();

    expect(harness.document.querySelector('[data-node-ref="stale-epoch"]')).toBeNull();
    expect(harness.document.querySelector('[data-node-ref="stale-revision"]')).toBeNull();
    expect(harness.document.querySelector('[data-node-ref="current"]')).not.toBeNull();
    expect(harness.element("selected-element-summary").value).toBe("Selected: current");

    const retainedMount = harness.element("inspector-elements-mount");
    runtime.dispose();
    await runtime.closed;
    port.emitMessage(selection("post-dispose", 4, 8));
    await flushAsync();
    expect(retainedMount.children).toHaveLength(0);
    expect(harness.document.querySelector('[data-node-ref="post-dispose"]')).toBeNull();
  });

  it("clears renderer hover before disposing the shared transport", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 3,
      node: domNode("hovered-root", "HTML"),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();
    const tree = harness.document.querySelector(".elements-tree-outline");
    const row = harness.document.querySelector('[data-node-ref="hovered-root"]');
    if (!tree || !row) throw new Error("Missing rendered root row");
    tree.dispatch("pointermove", { target: row });
    expect(lastMessage(port.sent, "dom.hover")).toMatchObject({
      type: "dom.hover",
      documentEpoch: 3,
      nodeRef: "hovered-root",
    });

    runtime.dispose();
    await runtime.closed;

    const clearHover = lastMessage(port.sent, "dom.clearHover");
    expect(clearHover).toMatchObject({
      type: "dom.clearHover",
      documentEpoch: 3,
    });
    expect(port.disconnected).toBe(true);
  });

  it("keeps incompatible authority from enabling settings or rendering selection", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "incompatible",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    port.emitMessage({
      type: "pin-op.tab.state",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 0,
    });
    port.emitMessage(selection("blocked", 1, 1));
    await flushAsync();

    expect(harness.element("protocol-mismatch").hidden).toBe(false);
    expect(harness.element("auto-refresh-enabled").disabled).toBe(true);
    expect(harness.element("ide-highlight-enabled").disabled).toBe(true);
    expect(harness.document.querySelector('[data-node-ref="blocked"]')).toBeNull();
    expect(harness.element("selected-element-summary").value).toBe("");
    runtime.dispose();
  });

  it("retires an existing tree on incompatibility and reloads only after compatible linked authority returns", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    const firstRoot = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: firstRoot.requestId,
      documentEpoch: 2,
      node: domNode("root", "HTML"),
      prologue: [],
      epilogue: [],
    });
    port.emitMessage(selection("selected", 2, 4));
    await flushAsync();
    expect(harness.document.querySelector('[data-node-ref="selected"]')).not.toBeNull();

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    expect(harness.document.querySelector('[data-node-ref="root"]')).toBeNull();
    expect(harness.document.querySelector('[data-node-ref="selected"]')).toBeNull();
    expect(harness.element("selected-element-summary").value).toBe("");

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await waitForMessageCount(port.sent, "dom.getRoot", 2);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(2);
    runtime.dispose();
  });

  it("does not replay linked authority from before a compatibility mismatch", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    expect(runtime.settingsController.snapshot().compatibility).toBe("incompatible");
    expect(harness.element("protocol-mismatch").hidden).toBe(false);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await waitForMessageCount(port.sent, "dom.getRoot", 2);
    expect(runtime.settingsController.snapshot().compatibility).toBe("compatible");
    expect(harness.element("protocol-mismatch").hidden).toBe(true);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(2);
    runtime.dispose();
  });

  it("does not carry post-mismatch linked authority across a transport rebind", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const firstPort = requiredPort(harness.ports, 0);
    firstPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
    firstPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    firstPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
    firstPort.disconnect();
    await waitForPortCount(harness.ports, 2);
    const replacementPort = requiredPort(harness.ports, 1);

    replacementPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    expect(replacementPort.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(0);

    replacementPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
    replacementPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await waitForMessageCount(replacementPort.sent, "dom.getRoot", 1);
    expect(replacementPort.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);
    runtime.dispose();
  });

  it("does not let a disconnect subscriber restore authority from the retired port", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const firstPort = requiredPort(harness.ports, 0);
    firstPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
    firstPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    let injected = false;
    runtime.settingsController.subscribe(() => {
      if (
        !injected &&
        runtime.settingsController.snapshot().compatibility === "pending"
      ) {
        injected = true;
        firstPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
      }
    });

    firstPort.disconnect();
    await waitForPortCount(harness.ports, 2);
    const replacementPort = requiredPort(harness.ports, 1);
    replacementPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(replacementPort.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);

    replacementPort.emitMessage({ type: "pin-op.windowState", state: "linked" });
    replacementPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await waitForMessageCount(replacementPort.sent, "dom.getRoot", 1);
    expect(replacementPort.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);
    runtime.dispose();
  });

  it("lets a nested accepted mismatch supersede an outer compatible route", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    let injected = false;
    const unsubscribe = runtime.settingsController.subscribe(() => {
      if (
        !injected &&
        runtime.settingsController.snapshot().compatibility === "compatible"
      ) {
        injected = true;
        port.emitMessage({
          type: "pin-op.protocol.compatibility",
          compatible: false,
          browserProtocolVersion: PROTOCOL_VERSION,
          peerProtocolVersion: PROTOCOL_VERSION - 1,
        });
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("incompatible");
    expect(harness.element("connection-status").dataset.state).toBe("incompatible");
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);
    port.emitMessage(selection("blocked-after-reentry", 1, 1));
    expect(harness.document.querySelector('[data-node-ref="blocked-after-reentry"]'))
      .toBeNull();
    unsubscribe();
    runtime.dispose();
  });

  it("lets a nested accepted compatible route prevent an outer stale mismatch clear", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 2,
      node: domNode("retained-root", "HTML"),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();
    let injected = false;
    const unsubscribe = runtime.settingsController.subscribe(() => {
      if (
        !injected &&
        runtime.settingsController.snapshot().compatibility === "incompatible"
      ) {
        injected = true;
        port.emitMessage({
          type: "pin-op.protocol.compatibility",
          compatible: true,
          browserProtocolVersion: PROTOCOL_VERSION,
        });
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("compatible");
    expect(harness.element("connection-status").dataset.state).toBe("connected");
    expect(harness.element("protocol-mismatch").hidden).toBe(true);
    expect(harness.document.querySelector('[data-node-ref="retained-root"]')).not.toBeNull();
    unsubscribe();
    runtime.dispose();
  });

  it("lets a nested incompatible window state supersede an outer compatible route", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequestsBefore = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;
    let injected = false;
    const unsubscribe = runtime.settingsController.subscribe(() => {
      if (
        !injected &&
        runtime.settingsController.snapshot().compatibility === "compatible"
      ) {
        injected = true;
        port.emitMessage({ type: "pin-op.windowState", state: "incompatible" });
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("incompatible");
    expect(harness.element("connection-status").dataset.state).toBe("incompatible");
    expect(harness.element("protocol-mismatch").hidden).toBe(false);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.inspect.started",
      inspectMessageId: "blocked-after-window-state-reentry",
      selectionRevision: 1,
    });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore);
    expect(harness.element("resolution-status").value)
      .toBe("Select an element to inspect");
    unsubscribe();
    runtime.dispose();
  });

  it("keeps a nested linked state within the outer compatible transition", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequestsBefore = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;
    let injected = false;
    const unsubscribe = runtime.settingsController.subscribe(() => {
      if (
        !injected &&
        runtime.settingsController.snapshot().compatibility === "compatible"
      ) {
        injected = true;
        port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("compatible");
    expect(harness.element("connection-status").dataset.state).toBe("connected");
    expect(harness.element("protocol-mismatch").hidden).toBe(true);
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore + 1);
    unsubscribe();
    runtime.dispose();
  });

  it("does not resume a compatibility route after a settings subscriber disposes", async () => {
    const harness = createHarness();
    const diagnostics = new PanelDiagnostics();
    const clearResolution = vi.spyOn(diagnostics, "clearResolution");
    const runtime = harness.start({ diagnostics });
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    let disposedBySubscriber = false;
    runtime.settingsController.subscribe(() => {
      if (
        !disposedBySubscriber &&
        runtime.settingsController.snapshot().compatibility === "incompatible"
      ) {
        disposedBySubscriber = true;
        runtime.dispose();
      }
    });
    const clearsBefore = clearResolution.mock.calls.length;

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await runtime.closed;

    expect(disposedBySubscriber).toBe(true);
    expect(clearResolution).toHaveBeenCalledTimes(clearsBefore + 1);
    expect(port.disconnected).toBe(true);
  });

  it("does not resume a compatibility route after a settings subscriber revokes its binding", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    await flushAsync();
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    let revokedBySubscriber = false;
    runtime.settingsController.subscribe(() => {
      if (
        !revokedBySubscriber &&
        runtime.settingsController.snapshot().compatibility === "compatible"
      ) {
        revokedBySubscriber = true;
        port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    port.emitMessage({
      type: "pin-op.inspect.started",
      inspectMessageId: "stale-after-revoke",
      selectionRevision: 1,
    });
    await flushAsync();

    expect(revokedBySubscriber).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("pending");
    expect(harness.element("connection-status").dataset.state).toBe("notLinked");
    expect(harness.element("resolution-status").value)
      .toBe("Select an element to inspect");
    runtime.dispose();
  });

  it.each(["revoke", "replace"] as const)(
    "does not resume a compatibility route after a settings subscriber directly %ss its controller binding",
    async (action) => {
      const harness = createHarness();
      const runtime = harness.start();
      await runtime.ready;
      const port = requiredPort(harness.ports, 0);
      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: PROTOCOL_VERSION - 1,
      });
      await flushAsync();
      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      await flushAsync();
      const rootRequestsBefore = port.sent.filter((message) =>
        isType(message, "dom.getRoot")
      ).length;
      let invalidated = false;
      runtime.settingsController.subscribe(() => {
        if (
          !invalidated &&
          runtime.settingsController.snapshot().compatibility === "compatible"
        ) {
          invalidated = true;
          if (action === "revoke") {
            runtime.settingsController.revokeBinding();
          } else {
            runtime.settingsController.beginBinding();
          }
        }
      });

      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();

      expect(invalidated).toBe(true);
      expect(runtime.settingsController.snapshot().compatibility).toBe("pending");
      expect(harness.element("connection-status").dataset.state)
        .toBe("incompatible");
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(rootRequestsBefore);

      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();

      expect(runtime.settingsController.snapshot().compatibility)
        .toBe("compatible");
      expect(harness.element("connection-status").dataset.state)
        .toBe("connected");
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(rootRequestsBefore + 1);
      runtime.dispose();
    },
  );

  it.each(["revoke", "replace"] as const)(
    "recovers when the initial binding publication directly %ss its returned token",
    async (action) => {
      const harness = createHarness();
      const runtime = harness.start();
      let invalidated = false;
      runtime.settingsController.subscribe(() => {
        if (!invalidated) {
          invalidated = true;
          if (action === "revoke") {
            runtime.settingsController.revokeBinding();
          } else {
            runtime.settingsController.beginBinding();
          }
        }
      });
      await runtime.ready;
      const port = requiredPort(harness.ports, 0);

      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(1);

      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();

      expect(invalidated).toBe(true);
      expect(runtime.settingsController.snapshot().compatibility)
        .toBe("compatible");
      expect(harness.element("connection-status").dataset.state)
        .toBe("connected");
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(1);
      runtime.dispose();
    },
  );

  it("does not let an outer binding publication overwrite a nested linked activation", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    let injected = false;
    runtime.settingsController.subscribe(() => {
      if (!injected) {
        injected = true;
        requiredPort(harness.ports, 0).emitMessage({
          type: "pin-op.windowState",
          state: "linked",
        });
      }
    });
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility)
      .toBe("compatible");
    expect(harness.element("connection-status").dataset.state)
      .toBe("connected");
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(1);
    runtime.dispose();
  });

  it("does not let an outer incompatible route clobber a nested linked activation", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "offline" });
    await flushAsync();
    const rootRequestsBefore = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;
    let injected = false;
    runtime.settingsController.subscribe(() => {
      if (!injected) {
        injected = true;
        port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      }
    });

    port.emitMessage({ type: "pin-op.windowState", state: "incompatible" });
    await flushAsync();

    expect(injected).toBe(true);
    expect(runtime.settingsController.snapshot().compatibility).toBe("pending");
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore);

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    expect(runtime.settingsController.snapshot().compatibility)
      .toBe("compatible");
    runtime.dispose();
  });

  it.each(["revoke", "replace"] as const)(
    "recovers after incompatible window-state publication directly %ss its binding",
    async (action) => {
      const harness = createHarness();
      const runtime = harness.start();
      await runtime.ready;
      const port = requiredPort(harness.ports, 0);
      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();
      const rootRequestsBefore = port.sent.filter((message) =>
        isType(message, "dom.getRoot")
      ).length;
      let invalidated = false;
      runtime.settingsController.subscribe(() => {
        if (
          !invalidated &&
          runtime.settingsController.snapshot().compatibility === "incompatible"
        ) {
          invalidated = true;
          if (action === "revoke") {
            runtime.settingsController.revokeBinding();
          } else {
            runtime.settingsController.beginBinding();
          }
        }
      });

      port.emitMessage({ type: "pin-op.windowState", state: "incompatible" });
      await flushAsync();
      await vi.waitFor(() => {
        expect(harness.element("connection-status").dataset.state)
          .toBe("incompatible");
      });
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(rootRequestsBefore);

      port.emitMessage({ type: "pin-op.windowState", state: "linked" });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: true,
        browserProtocolVersion: PROTOCOL_VERSION,
      });
      await flushAsync();

      expect(invalidated).toBe(true);
      expect(runtime.settingsController.snapshot().compatibility)
        .toBe("compatible");
      expect(harness.element("connection-status").dataset.state)
        .toBe("connected");
      expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
        .toHaveLength(rootRequestsBefore + 1);
      runtime.dispose();
    },
  );

  it("fails the loaded tree closed when mismatch publication loses its binding", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    const rootRequest = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 2,
      node: domNode("loaded-before-binding-loss", "HTML"),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();
    const rootRequestsBefore = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;
    let invalidated = false;
    runtime.settingsController.subscribe(() => {
      const snapshot = runtime.settingsController.snapshot();
      if (
        !invalidated &&
        snapshot.compatibility === "incompatible" &&
        snapshot.peerProtocolVersion === PROTOCOL_VERSION - 1
      ) {
        invalidated = true;
        runtime.settingsController.revokeBinding();
      }
    });

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: PROTOCOL_VERSION - 1,
    });
    port.emitMessage({
      type: "pin-op.inspect.started",
      inspectMessageId: "blocked-after-binding-loss",
      selectionRevision: 1,
    });
    await flushAsync();

    expect(invalidated).toBe(true);
    expect(harness.document.querySelector(
      '[data-node-ref="loaded-before-binding-loss"]',
    )).toBeNull();
    expect(harness.element("resolution-status").value)
      .toBe("Select an element to inspect");

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore + 1);
    runtime.dispose();
  });

  it("retires a tab-state binding replacement before the next session event", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    const rootRequestsBefore = port.sent.filter((message) =>
      isType(message, "dom.getRoot")
    ).length;
    let replaced = false;
    runtime.settingsController.subscribe(() => {
      if (!replaced && runtime.settingsController.snapshot().snapshotReady) {
        replaced = true;
        runtime.settingsController.beginBinding();
      }
    });

    port.emitMessage({
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 1,
    });
    port.emitMessage({
      type: "pin-op.inspect.started",
      inspectMessageId: "blocked-after-tab-binding-loss",
      selectionRevision: 1,
    });
    await flushAsync();

    expect(replaced).toBe(true);
    expect(harness.element("resolution-status").value)
      .toBe("VS Code disconnected");

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
    await flushAsync();
    expect(runtime.settingsController.snapshot().compatibility)
      .toBe("compatible");
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(rootRequestsBefore);
    runtime.dispose();
  });

  it("recovers through one existing coordinator and unload owns idempotent teardown", async () => {
    const harness = createHarness();
    const runtime = harness.start();
    await runtime.ready;
    const port = requiredPort(harness.ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const firstRoot = lastMessage(port.sent, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: firstRoot.requestId,
      documentEpoch: 1,
      node: domNode("root", "HTML"),
      prologue: [],
      epilogue: [],
    });
    await flushAsync();

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    await flushAsync();
    expect(port.sent.filter((message) => isType(message, "dom.getRoot")))
      .toHaveLength(2);

    harness.unload?.();
    runtime.dispose();
    await runtime.closed;
    expect(port.disconnectCalls).toBe(1);
    expect(harness.unload).toBeUndefined();
  });

  it("does not initialize icons or ports after a synchronous unload subscription", async () => {
    const harness = createHarness();
    const initializeIcons = vi.fn();
    const runtime = harness.start({
      initializeIcons,
      subscribeUnload(listener) {
        listener();
        return vi.fn();
      },
    });

    await runtime.ready;
    await runtime.closed;

    expect(initializeIcons).not.toHaveBeenCalled();
    expect(harness.ports).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(harness.element("inspector-elements-mount").children).toHaveLength(0);
  });

  it("ignores a deferred panel-ready rejection after disposal", async () => {
    const harness = createHarness();
    const panelReady = deferred<unknown>();
    const errors: unknown[] = [];
    const runtime = harness.start({
      sendRuntimeMessage(message) {
        harness.sent.push(message);
        return panelReady.promise;
      },
      onError(error) {
        errors.push(error);
      },
    });
    await waitForMessage(harness.sent, "pin-op.panelReady");

    runtime.dispose();
    await runtime.closed;
    panelReady.reject(new Error("late panel ready failure"));
    await runtime.ready;

    expect(errors).toEqual([]);
    expect(harness.ports).toEqual([]);
    expect(harness.element("inspector-elements-mount").children).toHaveLength(0);
  });

  it("rolls back the mounted tree and settings listeners when presentation attach throws", () => {
    const harness = createHarness();
    const ideHighlight = harness.element("ide-highlight-enabled");
    const addEventListener = ideHighlight.addEventListener.bind(ideHighlight);
    ideHighlight.addEventListener = (type, listener) => {
      if (type === "change") {
        throw new Error("settings binding failed");
      }
      addEventListener(type, listener);
    };
    const listenersBefore = harness.document.totalListeners();

    expect(() => harness.start()).toThrow("settings binding failed");

    expect(harness.element("inspector-elements-mount").children).toHaveLength(0);
    expect(harness.document.totalListeners()).toBe(listenersBefore);
    expect(harness.ports).toEqual([]);
    expect(harness.sent).toEqual([]);
  });
});

const IDS = [
  "toolbar-features",
  "connection-status",
  "link-controls",
  "link-form",
  "link-code",
  "paste-button",
  "link-button",
  "linked-code",
  "disconnect-button",
  "inspect-mode",
  "refresh-styles",
  "auto-refresh-enabled",
  "ide-highlight-enabled",
  "protocol-mismatch",
  "protocol-mismatch-versions",
  "link-onboarding",
  "inspector-workspace",
  "inspector-elements-mount",
  "selected-element-summary",
  "resolution-status",
  "operational-footer",
  "panel-error",
] as const;

function createHarness(): {
  readonly document: FakeDocument;
  readonly ports: TestRuntimePort[];
  readonly sent: unknown[];
  unload: (() => void) | undefined;
  element(id: (typeof IDS)[number]): MutableFakeElement;
  start(
    overrides?: Partial<InspectorPanelRuntimeOptions>,
  ): ReturnType<typeof startInspectorPanelRuntime>;
} {
  const document = new FakeDocument();
  const elements = new Map<string, MutableFakeElement>();
  for (const id of IDS) {
    const tagName = id === "link-form"
      ? "form"
      : id.includes("enabled") ? "input" : "div";
    const element = document.createElement(tagName) as unknown as MutableFakeElement;
    element.id = id;
    element.value = id === "connection-status" ? "Not linked" : "";
    element.checked = id === "auto-refresh-enabled" || id === "ide-highlight-enabled";
    document.body.append(element);
    elements.set(id, element);
  }
  const ports: TestRuntimePort[] = [];
  const sent: unknown[] = [];
  const harness = {
    document,
    ports,
    sent,
    unload: undefined as (() => void) | undefined,
    element(id: (typeof IDS)[number]): MutableFakeElement {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing #${id}`);
      return element;
    },
    start(overrides: Partial<InspectorPanelRuntimeOptions> = {}) {
      return startInspectorPanelRuntime({
        locationSearch: "?channel=inspector-channel",
        document: document.document,
        connectRuntimePort(name) {
          const port = new TestRuntimePort(name);
          ports.push(port);
          return port;
        },
        sendRuntimeMessage: overrides.sendRuntimeMessage ?? (async (message) => {
          sent.push(message);
          return isType(message, "pin-op.unlinkWindow") || isType(message, "pin-op.linkWindow")
            ? { ok: true }
            : undefined;
        }),
        readClipboard: async () => "48735 07",
        subscribeUnload: overrides.subscribeUnload ?? ((listener) => {
          harness.unload = listener;
          return () => {
            if (harness.unload === listener) harness.unload = undefined;
          };
        }),
        initializeIcons: overrides.initializeIcons ?? (() => {}),
        ...(overrides.onError ? { onError: overrides.onError } : {}),
        ...(overrides.diagnostics ? { diagnostics: overrides.diagnostics } : {}),
      });
    },
  };
  return harness;
}

interface MutableFakeElement extends FakeElement {
  value: string;
  checked: boolean;
}

class TestRuntimePort implements PanelInspectPort {
  public readonly sent: unknown[] = [];
  public readonly onMessage = new FakePortEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakePortEvent<() => void>();
  public disconnected = false;
  public disconnectCalls = 0;

  public constructor(public readonly name: string) {}
  public postMessage(message: unknown): void { this.sent.push(message); }
  public disconnect(): void {
    this.disconnectCalls += 1;
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
  public emitMessage(message: unknown): void { this.onMessage.emit(message); }
}

class FakePortEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();
  public addListener(listener: T): void { this.listeners.add(listener); }
  public removeListener(listener: T): void { this.listeners.delete(listener); }
  public emit(...args: Parameters<T>): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

function domNode(nodeRef: string, nodeName: string, expandable = false) {
  return {
    nodeRef,
    kind: "element" as const,
    nodeType: 1,
    nodeName,
    attributes: [],
    childCount: expandable ? 1 : 0,
    relationship: "dom" as const,
    selectable: true,
    expandable,
    branchRevision: 1,
    label: nodeRef,
    locator: {
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: [],
      path: [{ tagName: nodeName.toLowerCase(), siblingIndex: 0 }],
    },
  };
}

function selection(nodeRef: string, documentEpoch: number, selectionRevision: number) {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch,
    selectionRevision,
    nodeRef,
    ancestorPath: [
      domNode("root", "HTML", true),
      domNode(nodeRef, "DIV"),
    ],
  };
}

function lastMessage(messages: readonly unknown[], type: string): Record<string, unknown> {
  const message = [...messages].reverse().find((value) => isType(value, type));
  if (!message || typeof message !== "object") throw new Error(`Missing ${type}`);
  return message as Record<string, unknown>;
}

function isType(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type);
}

function requiredPort(ports: readonly TestRuntimePort[], index: number): TestRuntimePort {
  const port = ports[index];
  if (!port) throw new Error(`Missing port ${index}`);
  return port;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForMessage(
  messages: readonly unknown[],
  type: string,
): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (messages.some((message) => isType(message, type))) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitForMessageCount(
  messages: readonly unknown[],
  type: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (messages.filter((message) => isType(message, type)).length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${type} count ${count}`);
}

async function waitForPortCount(
  ports: readonly TestRuntimePort[],
  count: number,
): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (ports.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for port count ${count}`);
}

async function waitForPressed(element: FakeElement): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (element.getAttribute("aria-pressed") === "true") {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for Inspect mode");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stylesMatched(
  request: {
    readonly requestId: string;
    readonly documentEpoch: number;
    readonly nodeRef: string;
    readonly selectionRevision: number;
  },
  stylesRevision: number,
  stylesheetRevision: number,
) {
  return {
    ...request,
    type: "styles.matched" as const,
    stylesRevision,
    stylesheetRevision,
    styles: {
      documentEpoch: request.documentEpoch,
      nodeRef: request.nodeRef,
      selectionRevision: request.selectionRevision,
      stylesRevision,
      stylesheetRevision,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}

function matchedRule(ruleRef: string, selectorText: string) {
  return {
    ruleRef,
    selectorText,
    matchingSelectorIndices: [0],
    declarations: [{
      ruleRef,
      property: "color",
      value: "rebeccapurple",
      important: false,
      valueTruncated: false,
      state: "winning-known-author" as const,
      reason: "highest-precedence-known-author-declaration" as const,
    }],
    contexts: [],
  };
}
