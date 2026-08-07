import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
} from "@browser2ide/protocol";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PanelDiagnostics } from "../src/panelDiagnostics.js";
import { startPanelRuntime } from "../src/panelRuntime.js";

describe("startPanelRuntime", () => {
  let dom: FakeDom;
  let clipboardReads: number;
  let messages: unknown[];
  let ports: TestRuntimePort[];
  let unload: (() => void) | undefined;
  let runtimeSend: (message: unknown) => Promise<unknown>;
  let initializeIcons: () => void;
  let reportedErrors: unknown[];
  let diagnostics: PanelDiagnostics;

  beforeEach(() => {
    dom = createFakeDom();
    clipboardReads = 0;
    messages = [];
    ports = [];
    unload = undefined;
    runtimeSend = async (message) => {
      messages.push(message);
      return isCommand(message) ? { ok: true } : undefined;
    };
    initializeIcons = vi.fn();
    reportedErrors = [];
    diagnostics = new PanelDiagnostics();
  });

  it("opens one shared port without reading clipboard or enabling inspect", async () => {
    const runtime = createRuntime();
    await runtime.ready;

    expect(ports).toHaveLength(1);
    expect(ports[0]?.name).toBe("browser2ide.devtools.test-channel");
    expect(messages).toEqual([
      { type: "browser2ide.panelReady", channel: "test-channel" },
    ]);
    expect(clipboardReads).toBe(0);
    expect(pressed(dom.element("inspect-mode"))).toBe(false);
    expect(dom.element("inspect-mode").disabled).toBe(true);
    runtime.dispose();
  });

  it("reads clipboard only after Paste and sends a normalized link command", async () => {
    const runtime = createRuntime();
    await runtime.ready;

    dom.element("paste-button").dispatch("click");
    await flushAsync();

    expect(clipboardReads).toBe(1);
    expect(dom.element("link-code").value).toBe("");
    expect(messages).toContainEqual({
      type: "browser2ide.linkWindow",
      channel: "test-channel",
      code: "4873507",
    });
    runtime.dispose();
  });

  it("recovers exactly one shared port and detaches the old listeners", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const first = requiredPort(ports, 0);
    first.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    first.disconnect();
    await flushAsync();

    expect(messages).toEqual([
      { type: "browser2ide.panelReady", channel: "test-channel" },
      { type: "browser2ide.panelReady", channel: "test-channel" },
    ]);
    expect(ports).toHaveLength(2);
    expect(first.onMessage.listenerCount).toBe(0);
    expect(requiredPort(ports, 1).onMessage.listenerCount).toBe(1);
    expect(dom.element("connection-status").value).toBe(
      "Linked IDE offline",
    );
    runtime.dispose();
  });

  it("clears the accepted code when connected arrives before the command response", async () => {
    const linkStarted = deferred<void>();
    const linkResponse = deferred<unknown>();
    runtimeSend = async (message) => {
      messages.push(message);
      if (isRecord(message) && message.type === "browser2ide.linkWindow") {
        linkStarted.resolve(undefined);
        return linkResponse.promise;
      }
      return undefined;
    };
    const runtime = createRuntime();
    await runtime.ready;

    const linkCode = dom.element("link-code");
    linkCode.value = "4873507";
    linkCode.dispatch("input");
    dom.element("link-form").dispatch("submit");
    await linkStarted.promise;
    expect(linkCode.value).toBe("4873507");

    requiredPort(ports, 0).emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
    });
    expect(linkCode.value).toBe("");

    linkResponse.resolve({ ok: true });
    await flushAsync();
    expect(linkCode.value).toBe("");
    runtime.dispose();
  });

  it("uses the lifetime port for inspect commands", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    const inspect = dom.element("inspect-mode");
    inspect.dispatch("click");
    await flushAsync();

    const inspectMessages = port.sent.filter((message) => (
      isRecord(message) && message.type === "browser2ide.inspect.setEnabled"
    ));
    expect(inspectMessages).toHaveLength(1);
    expect(inspectMessages[0]).toMatchObject({
      type: "browser2ide.inspect.setEnabled",
      enabled: true,
    });
    expect(ports).toHaveLength(1);
    runtime.dispose();
  });

  it("does not expose package metadata through the live panel DOM", () => {
    const runtime = createRuntime();

    expect(
      dom.element("connection-status").dataset.browser2ideProtocolVersion,
    ).toBeUndefined();

    runtime.dispose();
  });

  it("loads the DOM root through the shared port only after the window is linked", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    expect(port.sent).toEqual([]);

    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({
      type: "dom.getRoot",
      requestId: expect.any(String),
    });
    runtime.dispose();
  });

  it("renders page selections and selects tree rows while Inspect mode is off", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      nodeRef: "child",
      ancestorPath: [
        domNode("root", "html", true),
        domNode("child", "button.save"),
      ],
    });

    const child = dom.element("dom-tree-spacer").findByData("nodeRef", "child");
    expect(child).toBeDefined();
    expect(pressed(dom.element("inspect-mode"))).toBe(false);

    dom.element("dom-tree").dispatch("click", { target: child });
    await flushAsync();

    expect(port.sent).toContainEqual({
      type: "dom.select",
      documentEpoch: 7,
      nodeRef: "child",
    });
    runtime.dispose();
  });

  it("clears the tree and rejects a late root response after unlink", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    const rootRequest = port.sent.find((message) => (
      isRecord(message) && message.type === "dom.getRoot"
    )) as { readonly requestId: string };

    port.emitMessage({ type: "browser2ide.windowState", state: "notLinked" });
    port.emitMessage({
      type: "dom.root",
      requestId: rootRequest.requestId,
      documentEpoch: 1,
      node: domNode("late-root", "html"),
    });
    await flushAsync();

    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(reportedErrors).toEqual([]);
    runtime.dispose();
  });

  it("does not restart a navigation root query after the panel becomes unlinked", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    expect(port.sent.filter(isRootRequest)).toHaveLength(1);

    port.emitMessage({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
    port.emitMessage({ type: "browser2ide.windowState", state: "notLinked" });
    await flushAsync();

    expect(port.sent.filter(isRootRequest)).toHaveLength(1);
    runtime.dispose();
  });

  it("ignores a stale inspection invalidation before any linked session", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);

    port.emitMessage({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
    await flushAsync();

    expect(port.sent.filter(isRootRequest)).toEqual([]);
    runtime.dispose();
  });

  it("clears the DOM session as soon as Disconnect is submitted", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    expect(dom.element("dom-tree-spacer").children).toHaveLength(1);

    dom.element("disconnect-button").dispatch("click");
    await flushAsync();

    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(messages).toContainEqual({
      type: "browser2ide.unlinkWindow",
      channel: "test-channel",
    });
    runtime.dispose();
  });

  it("turns Inspect off when navigation invalidates the content lease", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    const inspect = dom.element("inspect-mode");
    inspect.dispatch("click");
    await flushAsync();
    const request = port.sent.find((message) =>
      isRecord(message) &&
      message.type === "browser2ide.inspect.setEnabled"
    ) as { requestId: string };
    port.emitMessage({
      type: "browser2ide.inspect.result",
      requestId: request.requestId,
      ok: true,
    });
    await flushAsync();
    expect(pressed(inspect)).toBe(true);

    port.emitMessage({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
    await flushAsync();

    expect(pressed(inspect)).toBe(false);
    expect(inspect.disabled).toBe(false);
    runtime.dispose();
  });

  it("shows the linked code and a single explicit Disconnect control", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    requiredPort(ports, 0).emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();

    expect(dom.element("linked-code").value).toBe("48735 07");
    expect(dom.element("linked-code").hidden).toBe(false);
    expect(dom.element("disconnect-button").hidden).toBe(false);
    runtime.dispose();
  });

  it("keeps the selected element summary while presenting ordered IDE results", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "button#save.primary")],
    });
    port.emitMessage(inspectStarted());

    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#save.primary",
    );
    expect(dom.element("resolution-status").value).toBe(
      "Resolving in VS Code",
    );

    port.emitMessage(
      resolutionMessage({
        resolutionGeneration: 2,
        selectedMatchCount: 2,
        parentMatchCount: 1,
      }),
    );
    port.emitMessage(
      resolutionMessage({
        resolutionGeneration: 1,
        status: "no-active-editor",
        selectedMatchCount: 0,
      }),
    );

    expect(dom.element("resolution-status").value).toBe(
      "3 rules highlighted · Selected 2 · Parent 1",
    );
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#save.primary",
    );
    runtime.dispose();
  });

  it("keeps a matched footer when the DOM selection arrives after resolution", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();

    port.emitMessage(inspectStarted("inspect-late-dom"));
    port.emitMessage(
      resolutionMessage({
        inspectMessageId: "inspect-late-dom",
        selectedMatchCount: 2,
        parentMatchCount: 1,
      }),
    );
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "button#late.primary")],
    });

    expect(dom.element("resolution-status").value).toBe(
      "3 rules highlighted · Selected 2 · Parent 1",
    );
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#late.primary",
    );
    expect(diagnostics.snapshot().resolution).toMatchObject({
      status: "matched",
      selectedMatchCount: 2,
      parentMatchCount: 1,
    });
    runtime.dispose();
  });

  it("records resolving and accepted bounded resolution diagnostics", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "button#save")],
    });
    port.emitMessage(inspectStarted());

    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });

    port.emitMessage(
      resolutionMessage({
        resolutionGeneration: 2,
        selectedMatchCount: 2,
        parentMatchCount: 1,
        inaccessibleStylesheetCount: 3,
        diagnosticCodes: ["resolver.plugin-timeout"],
      }),
    );

    expect(diagnostics.snapshot().resolution).toEqual({
      status: "matched",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
      parentMatchCount: 1,
      inaccessibleStylesheetCount: 3,
      diagnosticCodes: ["resolver.plugin-timeout"],
    });
    runtime.dispose();
  });

  it("does not roll diagnostics back for a stale resolution generation", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    port.emitMessage(inspectStarted());
    port.emitMessage(
      resolutionMessage({
        resolutionGeneration: 2,
        selectedMatchCount: 2,
      }),
    );

    port.emitMessage(
      resolutionMessage({
        resolutionGeneration: 1,
        status: "no-active-editor",
      }),
    );

    expect(diagnostics.snapshot().resolution).toMatchObject({
      status: "matched",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
    });
    runtime.dispose();
  });

  it("does not replace diagnostics with a stale inspect ID", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    port.emitMessage(inspectStarted("inspect-stale"));
    port.emitMessage(inspectStarted("inspect-current"));
    port.emitMessage(
      resolutionMessage({
        inspectMessageId: "inspect-current",
        resolutionGeneration: 2,
        selectedMatchCount: 2,
      }),
    );

    port.emitMessage(
      resolutionMessage({
        inspectMessageId: "inspect-stale",
        resolutionGeneration: 3,
        status: "no-active-editor",
      }),
    );

    expect(diagnostics.snapshot().resolution).toMatchObject({
      status: "matched",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
    });
    runtime.dispose();
  });

  it("shows IDE disconnect and resumes resolving after reconnect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main.content")],
    });
    port.emitMessage(inspectStarted());
    port.emitMessage(peerState(false, 1));

    expect(dom.element("resolution-status").value).toBe(
      "VS Code disconnected",
    );
    expect(diagnostics.snapshot().resolution).toEqual({
      status: "ide-disconnected",
    });

    port.emitMessage(peerState(true, 2));

    expect(dom.element("resolution-status").value).toBe(
      "Resolving in VS Code",
    );
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: main.content",
    );
    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });
    runtime.dispose();
  });

  it("shows IDE disconnected only for the exact failed inspect send", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(inspectStarted("inspect-old"));
    port.emitMessage(inspectStarted("inspect-current"));

    port.emitMessage({
      type: "browser2ide.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-old",
    });
    expect(dom.element("resolution-status").value).toBe(
      "Resolving in VS Code",
    );

    port.emitMessage({
      type: "browser2ide.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-current",
    });
    expect(dom.element("resolution-status").value).toBe(
      "VS Code disconnected",
    );
    expect(diagnostics.snapshot().resolution).toEqual({
      status: "ide-disconnected",
    });
    runtime.dispose();
  });

  it("clears runtime resolution diagnostics without wiping connection details", async () => {
    const sentAt = new Date("2026-08-07T11:00:00.000Z");
    diagnostics.setConnectionState("connected");
    diagnostics.recordMessageSent(sentAt);
    diagnostics.recordSelection([{ facts: [{ type: "css-rule" }] }], 1);
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });
    port.emitMessage(inspectStarted());
    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });

    port.emitMessage({ type: "browser2ide.windowState", state: "notLinked" });
    await flushAsync();

    expect(diagnostics.snapshot()).toMatchObject({
      connectionState: "connected",
      lastMessageSentAt: sentAt,
      inaccessibleStylesheetCount: 1,
      matchedCssFactCount: 1,
      resolution: undefined,
    });
    runtime.dispose();
  });

  it("keeps the linked identity and selection on a bridge transport error", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });

    port.emitMessage({
      type: "browser2ide.windowState",
      state: "error",
      displayLinkCode: "48735 07",
    });
    await flushAsync();

    expect(dom.element("connection-status").value).toBe("Error");
    expect(dom.element("linked-code").value).toBe("48735 07");
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: article.card",
    );
    runtime.dispose();
  });

  it("clears code, tree, selection, and footer immediately on Disconnect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });

    dom.element("disconnect-button").dispatch("click");
    await flushAsync();

    expect(dom.element("linked-code").value).toBe("");
    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(dom.element("selected-element-summary").value).toBe("");
    expect(dom.element("resolution-status").value).toBe(
      "Select an element to inspect",
    );
    expect(pressed(dom.element("inspect-mode"))).toBe(false);
    runtime.dispose();
  });

  it("restores only linked identity after Disconnect fails", async () => {
    runtimeSend = async (message) => {
      messages.push(message);
      if (isRecord(message) && message.type === "browser2ide.unlinkWindow") {
        return { ok: false, error: "busy" };
      }
      return isCommand(message) ? { ok: true } : undefined;
    };
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });
    port.emitMessage(inspectStarted());

    dom.element("disconnect-button").dispatch("click");
    await flushAsync();

    expect(dom.element("linked-code").value).toBe("48735 07");
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(dom.element("selected-element-summary").value).toBe("");
    expect(dom.element("resolution-status").value).toBe(
      "Select an element to inspect",
    );
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(pressed(dom.element("inspect-mode"))).toBe(false);
    runtime.dispose();
  });

  it("uses unload to clear the code, disconnect the port, and remove bindings", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const linkCode = dom.element("link-code");
    linkCode.value = "4873507";
    linkCode.dispatch("input");
    const port = requiredPort(ports, 0);

    unload?.();
    await runtime.closed;

    expect(linkCode.value).toBe("");
    expect(port.disconnected).toBe(true);
    expect(port.onMessage.listenerCount).toBe(0);
    expect(dom.totalListeners()).toBe(0);
    runtime.dispose();
  });

  it("keeps the operational panel running when icon initialization fails", async () => {
    const iconError = new Error("icons unavailable");
    initializeIcons = () => {
      throw iconError;
    };

    const runtime = createRuntime();
    await runtime.ready;

    expect(reportedErrors).toEqual([iconError]);
    expect(ports).toHaveLength(1);
    expect(dom.element("connection-status").value).toBe("Not linked");
    runtime.dispose();
  });

  it("clears only resolution diagnostics when the panel runtime closes", async () => {
    diagnostics.setConnectionState("connected");
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    port.emitMessage(inspectStarted());
    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });

    runtime.dispose();
    await runtime.closed;

    expect(diagnostics.snapshot().connectionState).toBe("connected");
    expect(diagnostics.snapshot().resolution).toBeUndefined();
  });

  it("ships only Disconnect and an accessible compact picker control", () => {
    const html = readFileSync(
      new URL("../assets/panel.html", import.meta.url),
      "utf8",
    );
    const css = readFileSync(
      new URL("../assets/panel.css", import.meta.url),
      "utf8",
    );

    expect(html).toContain('id="linked-code"');
    expect(html).toMatch(
      /id="disconnect-button"[\s\S]*?>[\s\S]*?Disconnect[\s\S]*?<\/button>/,
    );
    expect(html).toMatch(
      /id="inspect-mode"[\s\S]*?aria-pressed="false"[\s\S]*?title="Select an element"/,
    );
    expect(html).toContain('id="selected-element-summary"');
    expect(html).toContain('id="resolution-status"');
    expect(html).not.toContain('id="change-button"');
    expect(html).not.toContain('id="unlink-button"');
    expect(html).not.toContain('id="connected-controls"');
    expect(html).not.toContain('id="inspect-mode" type="checkbox"');
    expect(css).toContain("grid-template-rows: auto auto minmax(0, 1fr) auto");
    expect(css).toContain("@media (max-width: 360px)");
  });

  function createRuntime() {
    return startPanelRuntime({
      locationSearch: "?channel=test-channel",
      document: dom.document,
      connectRuntimePort(name) {
        const port = new TestRuntimePort(name);
        ports.push(port);
        return port;
      },
      sendRuntimeMessage: (message) => runtimeSend(message),
      async readClipboard() {
        clipboardReads += 1;
        return "48735 07";
      },
      subscribeUnload(listener) {
        unload = listener;
        return () => {
          if (unload === listener) {
            unload = undefined;
          }
        };
      },
      diagnostics,
      initializeIcons,
      onError: (error) => reportedErrors.push(error),
    });
  }
});

const ELEMENT_IDS = [
  "connection-status",
  "link-controls",
  "link-form",
  "link-code",
  "paste-button",
  "link-button",
  "linked-code",
  "disconnect-button",
  "inspect-mode",
  "selected-element-summary",
  "resolution-status",
  "panel-error",
  "dom-tree",
  "dom-tree-spacer",
  "dom-tree-empty",
] as const;

class FakeElement {
  public className = "";
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public scrollTop = 0;
  public clientHeight = 120;
  public textContent = "";
  public readonly style: Record<string, string> = {};
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | undefined;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  public replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) {
      child.parentElement = undefined;
    }
    this.children.length = 0;
    this.append(...children);
  }

  public addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string, init: Record<string, unknown> = {}): void {
    const event = {
      target: this,
      preventDefault() {},
      ...init,
    } as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  public contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  public findByData(key: string, value: string): FakeElement | undefined {
    if (this.dataset[key] === value) {
      return this;
    }
    for (const child of this.children) {
      const match = child.findByData(key, value);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  public focus(): void {}

  public listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

interface FakeDom {
  readonly document: { getElementById(id: string): FakeElement | null };
  element(id: string): FakeElement;
  totalListeners(): number;
}

function createFakeDom(): FakeDom {
  const elements = new Map(
    ELEMENT_IDS.map((id) => [id, new FakeElement()] as const),
  );
  return {
    document: {
      getElementById: (id) => elements.get(id as (typeof ELEMENT_IDS)[number]) ?? null,
      createElement: () => new FakeElement(),
      activeElement: null,
    },
    element(id) {
      const element = elements.get(id as (typeof ELEMENT_IDS)[number]);
      if (!element) {
        throw new Error(`Unknown fake element: ${id}`);
      }
      return element;
    },
    totalListeners() {
      return [...elements.values()].reduce(
        (total, element) => total + element.listenerCount(),
        0,
      );
    },
  };
}

class TestRuntimePort {
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakePortEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakePortEvent<() => void>();

  public constructor(public readonly name: string) {}

  public postMessage(message: unknown): void {
    if (this.disconnected) {
      throw new Error("Port is disconnected");
    }
    this.sent.push(message);
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakePortEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }
}

function requiredPort(ports: TestRuntimePort[], index: number): TestRuntimePort {
  const port = ports[index];
  if (!port) {
    throw new Error(`Missing runtime port ${index}`);
  }
  return port;
}

function isCommand(message: unknown): boolean {
  return (
    isRecord(message) &&
    (message.type === "browser2ide.linkWindow" ||
      message.type === "browser2ide.unlinkWindow")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isRootRequest(value: unknown): boolean {
  return isRecord(value) && value.type === "dom.getRoot";
}

function domNode(nodeRef: string, label: string, expandable = false) {
  return {
    nodeRef,
    kind: "element" as const,
    label,
    expandable,
    branchRevision: 0,
  };
}

function pressed(element: FakeElement): boolean {
  return element.getAttribute("aria-pressed") === "true";
}

function resolutionMessage(
  overrides: Partial<ResolutionMessage> = {},
): ResolutionMessage {
  const status = overrides.status ?? "matched";
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 1,
    status,
    selectedMatchCount: status === "matched" ? 1 : 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
    ...overrides,
  };
}

function inspectStarted(inspectMessageId = "inspect-1") {
  return {
    type: "browser2ide.inspect.started" as const,
    inspectMessageId,
  };
}

function peerState(connected: boolean, peerGeneration: number) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState" as const,
    messageId: `peer-${peerGeneration}`,
    sessionId: "session-1",
    role: "ide" as const,
    connected,
    peerGeneration,
    metadata: {},
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
