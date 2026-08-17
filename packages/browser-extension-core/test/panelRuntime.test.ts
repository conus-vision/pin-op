import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let resizeObservers: TestResizeObserver[];
  let sessionStorageValues: Map<string, string>;

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
    resizeObservers = [];
    sessionStorageValues = new Map();
    vi.stubGlobal("ResizeObserver", class {
      private readonly observer: TestResizeObserver;

      public constructor(callback: ResizeObserverCallback) {
        this.observer = new TestResizeObserver(callback);
        resizeObservers.push(this.observer);
      }

      public observe(target: Element): void {
        this.observer.observe(target);
      }

      public disconnect(): void {
        this.observer.disconnect();
      }

      public unobserve(): void {}
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => sessionStorageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorageValues.set(key, value);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens one shared port without reading clipboard or enabling inspect", async () => {
    const runtime = createRuntime();
    await runtime.ready;

    expect(ports).toHaveLength(1);
    expect(ports[0]?.name).toBe("pin-op.devtools.test-channel");
    expect(messages).toEqual([
      { type: "pin-op.panelReady", channel: "test-channel" },
    ]);
    expect(clipboardReads).toBe(0);
    expect(pressed(dom.element("inspect-mode"))).toBe(false);
    expect(dom.element("inspect-mode").disabled).toBe(true);
    runtime.dispose();
  });

  it("exposes default-on settings without enabling controls before a compatible fresh snapshot", async () => {
    const runtime = createRuntime();
    expect(dom.element("auto-refresh-enabled").checked).toBe(true);
    expect(dom.element("ide-highlight-enabled").checked).toBe(true);
    expect(dom.element("auto-refresh-enabled").disabled).toBe(true);
    expect(dom.element("ide-highlight-enabled").disabled).toBe(true);
    expect(runtime.settingsController.snapshot()).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      compatibility: "pending",
      snapshotReady: false,
      controlsEnabled: false,
    });
    await runtime.ready;
    const port = requiredPort(ports, 0);

    port.emitMessage(tabState(false, false));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    port.emitMessage(compatible());
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    port.emitMessage(tabState(false, true));
    expect(runtime.settingsController.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      snapshotReady: true,
      controlsEnabled: true,
    });
    expect(dom.element("auto-refresh-enabled").checked).toBe(false);
    expect(dom.element("ide-highlight-enabled").checked).toBe(true);
    expect(dom.element("auto-refresh-enabled").disabled).toBe(false);
    expect(dom.element("ide-highlight-enabled").disabled).toBe(false);

    dom.element("auto-refresh-enabled").checked = true;
    dom.element("auto-refresh-enabled").dispatch("change");
    expect(port.sent.at(-1)).toEqual({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });

    port.emitMessage(inspectStarted("inspect-ui-settings", 1));
    dom.element("ide-highlight-enabled").checked = false;
    dom.element("ide-highlight-enabled").dispatch("change");
    expect(port.sent.slice(-2)).toEqual([{
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    }, {
      type: "pin-op.presentation.settings",
      inspectMessageId: "inspect-ui-settings",
      ideHighlightEnabled: false,
    }]);
    runtime.dispose();
  });

  it("renders source excerpts and opens only the exact current match", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    port.emitMessage(inspectStarted("inspect-source-view", 1));
    expect(dom.element("source-pane-root").text()).toContain("Resolving source matches");

    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-source-view",
      resolutionGeneration: 3,
      document: { label: "card.scss", languageId: "scss" },
    }));
    port.emitMessage(sourceMatches("inspect-source-view", 3));

    const row = dom.element("source-pane-root").findByData("matchId", "match-1");
    expect(row).toBeDefined();
    expect(row?.className).toContain("source-pane-entry");
    expect(row?.findTag("pre")?.className).toContain("source-pane-excerpt");
    expect(dom.element("source-pane-root").text()).toContain("card.scss");
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-source-view",
      resolutionGeneration: 3,
      activeMatchId: "match-1",
    }));
    const activeRow = dom.element("source-pane-root").findByData("matchId", "match-1");
    expect(activeRow?.className).toContain("is-active");
    dom.element("source-pane-root").dispatch("click", { target: activeRow });
    expect(port.sent.at(-1)).toEqual({
      type: "pin-op.source.open",
      inspectMessageId: "inspect-source-view",
      resolutionGeneration: 3,
      matchId: "match-1",
    });

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    expect(dom.element("source-pane-root").text()).toContain("Select an element to inspect");
    const sentCount = port.sent.length;
    dom.element("source-pane-root").dispatch("click", { target: row });
    expect(port.sent).toHaveLength(sentCount);
    runtime.dispose();
  });

  it.each([
    [679, 519, "tabs"],
    [679, 520, "stack"],
    [680, 519, "split"],
  ] as const)("renders the %s x %s workspace as %s", async (width, height, mode) => {
    const runtime = createRuntime();
    await runtime.ready;
    const observer = resizeObservers[0];
    expect(observer).toBeDefined();
    emitPanelResize(observer!, dom, width, height);
    await flushAsync();

    expect(dom.element("panel-workspace").dataset.layout).toBe(mode);
    expect(dom.element("pane-separator").hidden).toBe(mode === "tabs");
    expect(dom.element("workspace-tabs").hidden).toBe(mode !== "tabs");
    runtime.dispose();
  });

  it("uses the panel viewport height for the stack breakpoint", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const observer = resizeObservers[0];
    expect(observer).toBeDefined();

    emitPanelResize(observer!, dom, 679, 520, 679, 480);
    await flushAsync();

    expect(dom.element("panel-workspace").dataset.layout).toBe("stack");
    runtime.dispose();
  });

  it("falls back to the body viewport and disconnects its observer", async () => {
    Object.defineProperty(dom.document, "documentElement", {
      configurable: true,
      get: () => { throw new Error("root unavailable"); },
    });
    const runtime = createRuntime();
    await runtime.ready;
    const observer = resizeObservers[0]!;
    observer.emit(dom.body(), 679, 520);
    observer.emit(dom.element("panel-workspace"), 679, 480);
    observer.emit(dom.element("pane-separator"), 5, 5);
    await flushAsync();

    expect(dom.element("panel-workspace").dataset.layout).toBe("stack");
    runtime.dispose();
    expect(observer.disconnected).toBe(true);
  });

  it("switches tab panes accessibly and drives the persisted separator", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const observer = resizeObservers[0]!;
    emitPanelResize(observer, dom, 500, 400);
    await flushAsync();

    dom.element("source-tab").dispatch("click");
    expect(dom.element("source-tab").getAttribute("aria-selected")).toBe("true");
    expect(dom.element("source-pane").hidden).toBe(false);
    expect(dom.element("dom-pane").hidden).toBe(true);
    dom.element("source-tab").dispatch("keydown", { key: "Home" });
    expect(dom.element("dom-tab").getAttribute("aria-selected")).toBe("true");

    emitPanelResize(observer, dom, 800, 600);
    await flushAsync();
    dom.element("pane-separator").dispatch("keydown", { key: "ArrowRight" });
    expect(dom.element("pane-separator").getAttribute("aria-valuenow")).toBe("52");
    expect(sessionStorageValues.get("pin-op.panel.layout.divider")).toBe("0.52");
    dom.element("pane-separator").dispatch("pointerdown", {
      pointerId: 7,
      clientX: 400,
      clientY: 300,
    });
    dom.element("pane-separator").dispatch("pointermove", {
      pointerId: 7,
      clientX: 600,
      clientY: 300,
    });
    dom.element("pane-separator").dispatch("pointerup", { pointerId: 7 });
    expect(dom.element("pane-separator").getAttribute("aria-valuenow")).toBe("75");
    expect(Number(sessionStorageValues.get("pin-op.panel.layout.divider")))
      .toBeCloseTo((600 - 2.5) / 795);
    runtime.dispose();
  });

  it.each([
    ["split", 712, 519, "vertical", "160px", "547px", "23", "77"],
    ["stack", 679, 526, "horizontal", "160px", "361px", "31", "69"],
  ] as const)(
    "renders separator-aware Home and End tracks in %s mode",
    async (
      _mode,
      width,
      height,
      orientation,
      homeTrack,
      endTrack,
      valueMin,
      valueMax,
    ) => {
      const runtime = createRuntime();
      await runtime.ready;
      const observer = resizeObservers[0]!;
      observer.emit(dom.viewport(), width, height);
      observer.emit(dom.element("panel-workspace"), width, height);
      observer.emit(dom.element("pane-separator"), 5, 5);
      await flushAsync();
      const workspace = dom.element("panel-workspace");
      const separator = dom.element("pane-separator");

      separator.dispatch("keydown", { key: "Home" });
      expect(workspace.style["--divider-position"]).toBe(homeTrack);
      expect(separator.getAttribute("aria-orientation")).toBe(orientation);
      expect(separator.getAttribute("aria-valuemin")).toBe(valueMin);
      expect(separator.getAttribute("aria-valuemax")).toBe(valueMax);
      expect(separator.getAttribute("aria-valuenow")).toBe(valueMin);

      separator.dispatch("keydown", { key: "End" });
      expect(workspace.style["--divider-position"]).toBe(endTrack);
      expect(separator.getAttribute("aria-valuenow")).toBe(valueMax);
      runtime.dispose();
    },
  );

  it("wraps tablist keyboard focus and isolates a throwing focus call", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    emitPanelResize(resizeObservers[0]!, dom, 500, 400);
    await flushAsync();

    dom.element("source-tab").dispatch("keydown", { key: "ArrowRight" });
    expect(dom.element("dom-tab").getAttribute("aria-selected")).toBe("true");
    expect(dom.element("dom-tab").focusCalls).toBe(1);

    const focusError = new Error("focus failed");
    dom.element("source-tab").focusError = focusError;
    dom.element("dom-tab").dispatch("keydown", { key: "ArrowLeft" });
    expect(dom.element("source-tab").getAttribute("aria-selected")).toBe("true");
    expect(reportedErrors).toContain(focusError);
    runtime.dispose();
  });

  it("isolates pointer DOM failures without granting stale pointer authority", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    emitPanelResize(resizeObservers[0]!, dom, 800, 600);
    await flushAsync();
    const separator = dom.element("pane-separator");

    const captureError = new Error("capture failed");
    separator.setPointerCaptureError = captureError;
    separator.dispatch("pointerdown", { pointerId: 10, clientX: 400, clientY: 0 });
    separator.setPointerCaptureError = undefined;
    separator.dispatch("pointermove", { pointerId: 10, clientX: 700, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");
    expect(reportedErrors).toContain(captureError);

    const boundsError = new Error("bounds failed");
    dom.element("panel-workspace").boundsError = boundsError;
    separator.dispatch("pointerdown", { pointerId: 11, clientX: 400, clientY: 0 });
    expect(reportedErrors).toContain(boundsError);
    dom.element("panel-workspace").boundsError = undefined;
    separator.dispatch("pointermove", { pointerId: 11, clientX: 600, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("75");

    const releaseError = new Error("release failed");
    separator.releasePointerCaptureError = releaseError;
    separator.dispatch("pointerup", { pointerId: 11 });
    separator.dispatch("pointermove", { pointerId: 11, clientX: 200, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("75");
    expect(reportedErrors).toContain(releaseError);
    runtime.dispose();
  });

  it("releases pointer authority during layout cleanup", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    emitPanelResize(resizeObservers[0]!, dom, 800, 600);
    await flushAsync();
    const separator = dom.element("pane-separator");
    separator.dispatch("pointerdown", { pointerId: 12, clientX: 400, clientY: 0 });
    expect(separator.capturedPointers.has(12)).toBe(true);

    runtime.dispose();
    expect(separator.capturedPointers.has(12)).toBe(false);
    separator.dispatch("pointermove", { pointerId: 12, clientX: 700, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");
  });

  it("does not restore pointer authority after capture or bounds reentry", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    emitPanelResize(resizeObservers[0]!, dom, 800, 600);
    await flushAsync();
    const separator = dom.element("pane-separator");
    const workspace = dom.element("panel-workspace");

    separator.setPointerCaptureAction = () => {
      separator.dispatch("pointercancel", { pointerId: 20 });
    };
    separator.dispatch("pointerdown", { pointerId: 20, clientX: 600, clientY: 0 });
    separator.setPointerCaptureAction = undefined;
    expect(separator.capturedPointers.has(20)).toBe(false);
    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    workspace.boundsAction = () => {
      separator.dispatch("pointercancel", { pointerId: 21 });
    };
    separator.dispatch("pointerdown", { pointerId: 21, clientX: 600, clientY: 0 });
    workspace.boundsAction = undefined;
    expect(separator.capturedPointers.has(21)).toBe(false);
    separator.dispatch("pointermove", { pointerId: 21, clientX: 700, clientY: 0 });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");
    runtime.dispose();
  });

  it("renders exact mismatch versions while keeping Disconnect usable", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushAsync();

    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: 5");
    expect(dom.element("auto-refresh-enabled").disabled).toBe(true);
    expect(dom.element("ide-highlight-enabled").disabled).toBe(true);
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(dom.element("disconnect-button").disabled).toBe(false);
    runtime.dispose();
  });

  it("keeps mismatch blocking through Disconnect and notLinked until fresh compatibility", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    showReadySourceNavigation(port, "selected-before-disconnect", "inspect-before-disconnect");
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushAsync();

    dom.element("disconnect-button").dispatch("click");
    await flushAsync();
    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
    await flushAsync();

    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "incompatible",
      controlsEnabled: false,
    });
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: 5");
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(dom.element("link-controls").hidden).toBe(false);
    expect(dom.element("link-code").disabled).toBe(false);
    expect(dom.element("paste-button").disabled).toBe(false);

    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("inspect-mode").disabled).toBe(true);
    port.emitMessage(compatible());
    await flushAsync();

    expect(dom.element("protocol-mismatch").hidden).toBe(true);
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    expect(dom.element("source-pane-root").text()).toContain("Select an element to inspect");
    expect(dom.element("inspect-mode").disabled).toBe(false);
    runtime.dispose();
  });

  it.each([
    ["error", { displayLinkCode: "48735 07" }, "disconnect-button"],
    ["linking", { displayLinkCode: "48735 07" }, "disconnect-button"],
    ["rateLimited", {}, "link-controls"],
  ] as const)(
    "keeps mismatch blocking through %s until fresh compatibility",
    async (state, details, usableControl) => {
      const runtime = createRuntime();
      await runtime.ready;
      const port = requiredPort(ports, 0);
      port.emitMessage({
        type: "pin-op.windowState",
        state: "linked",
        displayLinkCode: "48735 07",
      });
      port.emitMessage(compatible());
      port.emitMessage(tabState(true, true));
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: 5,
      });
      port.emitMessage({
        type: "pin-op.windowState",
        state,
        ...details,
      });
      await flushAsync();

      expect(dom.element("protocol-mismatch").hidden).toBe(false);
      expect(runtime.settingsController.snapshot()).toMatchObject({
        compatibility: "incompatible",
        controlsEnabled: false,
      });
      expect(dom.element("protocol-mismatch-versions").textContent)
        .toBe("Browser protocol: 6 - IDE protocol: 5");
      expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
      expect(dom.element("source-navigation-footer").hidden).toBe(true);
      expect(dom.element("inspect-mode").disabled).toBe(true);
      expect(dom.element(usableControl).hidden).toBe(false);
      if (usableControl === "disconnect-button") {
        expect(dom.element(usableControl).disabled).toBe(false);
      } else {
        expect(dom.element("link-code").disabled).toBe(false);
        expect(dom.element("paste-button").disabled).toBe(false);
      }

      port.emitMessage({
        type: "pin-op.windowState",
        state: "linked",
        displayLinkCode: "48735 07",
      });
      expect(dom.element("protocol-mismatch").hidden).toBe(false);
      expect(dom.element("inspect-mode").disabled).toBe(true);
      port.emitMessage(compatible());
      await flushAsync();

      expect(dom.element("protocol-mismatch").hidden).toBe(true);
      expect(runtime.settingsController.snapshot()).toMatchObject({
        compatibility: "compatible",
        snapshotReady: false,
        controlsEnabled: false,
      });
      expect(dom.element("inspect-mode").disabled).toBe(false);
      runtime.dispose();
    },
  );

  it.each([
    [7, "7"],
    ["unknown", "unknown"],
  ] as const)(
    "refreshes a rebound mismatch to IDE protocol %s without releasing feature authority",
    async (peerProtocolVersion, expectedPeerVersion) => {
      const runtime = createRuntime();
      await runtime.ready;
      const port = requiredPort(ports, 0);
      port.emitMessage({
        type: "pin-op.windowState",
        state: "linked",
        displayLinkCode: "48735 07",
      });
      port.emitMessage(compatible());
      port.emitMessage(tabState(true, true));
      showReadySourceNavigation(
        port,
        "selected-before-relink",
        "inspect-before-relink",
      );
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: 5,
      });
      await flushAsync();

      dom.element("disconnect-button").dispatch("click");
      await flushAsync();
      port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
      port.emitMessage({
        type: "pin-op.windowState",
        state: "linking",
        displayLinkCode: "48735 07",
      });
      port.emitMessage({
        type: "pin-op.windowState",
        state: "incompatible",
        displayLinkCode: "48735 07",
      });
      port.emitMessage({
        type: "pin-op.protocol.compatibility",
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion,
      });
      port.emitMessage(tabState(false, false));
      await flushAsync();

      expect(dom.element("protocol-mismatch").hidden).toBe(false);
      expect(dom.element("protocol-mismatch-versions").textContent).toBe(
        `Browser protocol: 6 - IDE protocol: ${expectedPeerVersion}`,
      );
      expect(runtime.settingsController.snapshot()).toMatchObject({
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        compatibility: "incompatible",
        peerProtocolVersion,
        snapshotReady: false,
        controlsEnabled: false,
      });
      expect(dom.element("inspect-mode").disabled).toBe(true);
      expect(dom.element("source-pane-root").text()).toContain(
        "Extensions are incompatible",
      );
      expect(dom.element("source-navigation-footer").hidden).toBe(true);
      expect(dom.element("disconnect-button").hidden).toBe(false);
      expect(dom.element("disconnect-button").disabled).toBe(false);

      port.emitMessage({
        type: "pin-op.windowState",
        state: "linked",
        displayLinkCode: "48735 07",
      });
      expect(dom.element("protocol-mismatch").hidden).toBe(false);
      expect(dom.element("inspect-mode").disabled).toBe(true);
      port.emitMessage(compatible());
      await flushAsync();

      expect(dom.element("protocol-mismatch").hidden).toBe(true);
      expect(runtime.settingsController.snapshot()).toMatchObject({
        compatibility: "compatible",
        snapshotReady: false,
        controlsEnabled: false,
      });
      expect(dom.element("inspect-mode").disabled).toBe(false);
      runtime.dispose();
    },
  );

  it("renders an unknown IDE protocol only from a validated incompatible state", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "incompatible",
      displayLinkCode: "48735 07",
    });

    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: unknown");
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: 5");
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    runtime.dispose();
  });

  it("keeps mismatch UI and Source blocking across transport rebind until fresh compatibility", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const oldPort = requiredPort(ports, 0);
    oldPort.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    oldPort.emitMessage(compatible());
    oldPort.emitMessage(tabState(true, true));
    oldPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    oldPort.disconnect();
    await flushAsync();

    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: 5");
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(dom.element("link-controls").hidden).toBe(true);

    const currentPort = requiredPort(ports, 1);
    currentPort.emitMessage({
      type: "pin-op.windowState",
      state: "offline",
      displayLinkCode: "48735 07",
    });
    currentPort.emitMessage({
      type: "pin-op.windowState",
      state: "reconnecting",
      displayLinkCode: "48735 07",
    });
    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("protocol-mismatch-versions").textContent)
      .toBe("Browser protocol: 6 - IDE protocol: 5");
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");
    currentPort.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    currentPort.emitMessage(tabState(false, false));
    expect(dom.element("protocol-mismatch").hidden).toBe(false);
    expect(dom.element("auto-refresh-enabled").disabled).toBe(true);
    expect(dom.element("source-pane-root").text()).toContain("Extensions are incompatible");

    currentPort.emitMessage(compatible());
    expect(dom.element("protocol-mismatch").hidden).toBe(true);
    expect(dom.element("auto-refresh-enabled").disabled).toBe(true);
    currentPort.emitMessage(tabState(false, true));
    expect(dom.element("auto-refresh-enabled").disabled).toBe(false);
    expect(dom.element("source-pane-root").text()).toContain("Select an element to inspect");
    runtime.dispose();
  });

  it("requires a fresh tab snapshot after offline reconnect recovery", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(true);

    port.emitMessage({
      type: "pin-op.windowState",
      state: "offline",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.windowState",
      state: "reconnecting",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "pending",
      snapshotReady: false,
      controlsEnabled: false,
    });

    port.emitMessage(compatible());
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    port.emitMessage(tabState(false, true));
    expect(runtime.settingsController.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      snapshotReady: true,
      controlsEnabled: true,
    });
    runtime.dispose();
  });

  it("dispatches tab settings immediately and presentation settings only for a current inspect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));

    expect(runtime.settingsController.setAutoRefreshEnabled(false)).toBe(true);
    expect(runtime.settingsController.setIdeHighlightEnabled(false)).toBe(true);
    expect(port.sent.slice(-2)).toEqual([
      {
        type: "pin-op.tab.settings",
        autoRefreshEnabled: false,
        ideHighlightEnabled: true,
      },
      {
        type: "pin-op.tab.settings",
        autoRefreshEnabled: false,
        ideHighlightEnabled: false,
      },
    ]);
    expect(port.sent.some(isPresentationSettings)).toBe(false);

    port.emitMessage(inspectStarted("inspect-settings", 1));
    expect(runtime.settingsController.setIdeHighlightEnabled(true)).toBe(true);
    expect(port.sent.slice(-2)).toEqual([
      {
        type: "pin-op.tab.settings",
        autoRefreshEnabled: false,
        ideHighlightEnabled: true,
      },
      {
        type: "pin-op.presentation.settings",
        inspectMessageId: "inspect-settings",
        ideHighlightEnabled: true,
      },
    ]);

    port.emitMessage(peerState(false, 2));
    expect(runtime.settingsController.setIdeHighlightEnabled(false)).toBe(true);
    expect(port.sent.at(-1)).toEqual({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    runtime.dispose();
  });

  it("binds source matches and exact opens to the current inspect resolution", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    port.emitMessage(inspectStarted("inspect-source", 1));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-source",
      resolutionGeneration: 3,
      document: { label: "card.scss", languageId: "scss" },
    }));
    port.emitMessage(sourceMatches("inspect-source", 3));

    expect(runtime.sourcePaneController.snapshot().groups.selected.matches)
      .toHaveLength(1);
    expect(runtime.sourcePaneController.open("match-1")).toBe(true);
    expect(port.sent.at(-1)).toEqual({
      type: "pin-op.source.open",
      inspectMessageId: "inspect-source",
      resolutionGeneration: 3,
      matchId: "match-1",
    });

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    expect(runtime.sourcePaneController.snapshot().groups.selected.matches)
      .toEqual([]);
    expect(runtime.sourcePaneController.open("match-1")).toBe(false);

    port.emitMessage(inspectStarted("inspect-new", 2));
    expect(runtime.sourcePaneController.snapshot().groups.selected.matches)
      .toEqual([]);
    expect(runtime.sourcePaneController.open("match-1")).toBe(false);
    port.emitMessage(sourceMatches("inspect-source", 3));
    expect(runtime.sourcePaneController.snapshot().groups.selected.matches)
      .toEqual([]);
    runtime.dispose();
  });

  it("rejects stale old-port settings and source authority after reconnect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const oldPort = requiredPort(ports, 0);
    oldPort.emitMessage(compatible());
    oldPort.emitMessage(tabState(true, true));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(true);

    oldPort.disconnect();
    await flushAsync();
    const currentPort = requiredPort(ports, 1);
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "pending",
      snapshotReady: false,
      controlsEnabled: false,
    });

    oldPort.emitMessage(compatible());
    oldPort.emitMessage(tabState(false, false));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    currentPort.emitMessage(tabState(false, false));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    currentPort.emitMessage(compatible());
    currentPort.emitMessage(tabState(false, true));
    expect(runtime.settingsController.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      controlsEnabled: true,
    });
    runtime.dispose();
  });

  it("blocks feature authority on mismatch until compatibility, snapshot, and a fresh inspect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    port.emitMessage(inspectStarted("inspect-before-mismatch", 1));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-before-mismatch",
      resolutionGeneration: 4,
      document: { label: "card.scss", languageId: "scss" },
    }));
    port.emitMessage(sourceMatches("inspect-before-mismatch", 4));

    port.emitMessage({
      type: "pin-op.windowState",
      state: "incompatible",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushAsync();

    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "incompatible",
      controlsEnabled: false,
    });
    expect(runtime.sourcePaneController.open("match-1")).toBe(false);
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(dom.element("disconnect-button").disabled).toBe(false);

    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    port.emitMessage(compatible());
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    port.emitMessage(tabState(true, true));
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(true);
    expect(runtime.sourcePaneController.open("match-1")).toBe(false);

    port.emitMessage(inspectStarted("inspect-after-mismatch", 2));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-after-mismatch",
      resolutionGeneration: 5,
      document: { label: "card.scss", languageId: "scss" },
    }));
    port.emitMessage(sourceMatches("inspect-after-mismatch", 5));
    expect(runtime.sourcePaneController.open("match-1")).toBe(true);
    runtime.dispose();
  });

  it("fails closed when protocol mismatch arrives before the incompatible window state", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));

    port.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushAsync();

    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(dom.element("disconnect-button").hidden).toBe(false);
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);

    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    expect(dom.element("inspect-mode").disabled).toBe(true);
    port.emitMessage(compatible());
    await flushAsync();
    expect(dom.element("inspect-mode").disabled).toBe(false);
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    runtime.dispose();
  });

  it("keeps mismatch blocking when linked must mint a replacement settings binding", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    port.emitMessage({
      type: "pin-op.windowState",
      state: "offline",
      displayLinkCode: "48735 07",
    });
    port.emitMessage({
      type: "pin-op.windowState",
      state: "incompatible",
      displayLinkCode: "48735 07",
    });

    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();

    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);
    port.emitMessage(compatible());
    port.emitMessage(tabState(true, true));
    await flushAsync();
    expect(dom.element("inspect-mode").disabled).toBe(false);
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(true);
    runtime.dispose();
  });

  it("preserves mismatch across port rebind until the new port proves compatibility", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const oldPort = requiredPort(ports, 0);
    oldPort.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    oldPort.emitMessage(compatible());
    oldPort.emitMessage(tabState(true, true));
    oldPort.emitMessage({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushAsync();
    expect(dom.element("connection-status").value)
      .toBe("Extensions are incompatible");

    oldPort.disconnect();
    await flushAsync();
    const currentPort = requiredPort(ports, 1);
    expect(dom.element("connection-status").value)
      .toBe("Extensions are incompatible");
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "incompatible",
      controlsEnabled: false,
    });

    currentPort.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    currentPort.emitMessage(tabState(false, false));
    await flushAsync();
    expect(dom.element("connection-status").value)
      .toBe("Extensions are incompatible");
    expect(dom.element("inspect-mode").disabled).toBe(true);
    expect(runtime.settingsController.snapshot().controlsEnabled).toBe(false);

    currentPort.emitMessage(compatible());
    await flushAsync();
    expect(dom.element("connection-status").value).toBe("Connected");
    expect(runtime.settingsController.snapshot()).toMatchObject({
      compatibility: "compatible",
      snapshotReady: false,
      controlsEnabled: false,
    });
    currentPort.emitMessage(tabState(false, true));
    expect(runtime.settingsController.snapshot()).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      controlsEnabled: true,
    });
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
      type: "pin-op.linkWindow",
      channel: "test-channel",
      code: "4873507",
    });
    runtime.dispose();
  });

  it("recovers exactly one shared port and detaches the old listeners", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const first = requiredPort(ports, 0);
    first.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();

    first.disconnect();
    await flushAsync();

    expect(messages).toEqual([
      { type: "pin-op.panelReady", channel: "test-channel" },
      { type: "pin-op.panelReady", channel: "test-channel" },
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
      if (isRecord(message) && message.type === "pin-op.linkWindow") {
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
      type: "pin-op.windowState",
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();

    const inspect = dom.element("inspect-mode");
    inspect.dispatch("click");
    await flushAsync();

    const inspectMessages = port.sent.filter((message) => (
      isRecord(message) && message.type === "pin-op.inspect.setEnabled"
    ));
    expect(inspectMessages).toHaveLength(1);
    expect(inspectMessages[0]).toMatchObject({
      type: "pin-op.inspect.setEnabled",
      enabled: true,
    });
    expect(ports).toHaveLength(1);
    runtime.dispose();
  });

  it("does not expose package metadata through the live panel DOM", () => {
    const runtime = createRuntime();

    expect(
      dom.element("connection-status").dataset.pinOpProtocolVersion,
    ).toBeUndefined();

    runtime.dispose();
  });

  it("loads the DOM root through the shared port only after the window is linked", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    expect(port.sent).toEqual([]);

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const rootRequest = port.sent.find((message) => (
      isRecord(message) && message.type === "dom.getRoot"
    )) as { readonly requestId: string };

    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    expect(port.sent.filter(isRootRequest)).toHaveLength(1);

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const requestsBeforeUnlink = port.sent.filter(isRootRequest).length;
    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
    await flushAsync();

    expect(requestsBeforeUnlink).toBe(2);
    expect(port.sent.filter(isRootRequest)).toHaveLength(requestsBeforeUnlink);
    runtime.dispose();
  });

  it("freezes the old tree and shows Restoring DOM until one recovered swap", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(selectionChangedWithRevision(
      "old-selected",
      "button#old",
      1,
    ));

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });

    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "old-selected",
    )).toBeDefined();
    expect(dom.element("dom-tree").getAttribute("aria-busy")).toBe("true");
    expect(dom.element("dom-tree").className.split(" "))
      .toContain("is-recovering");
    expect(dom.element("resolution-status").value).toBe("Restoring DOM");
    const recoveryRoot = lastRequest(port, "dom.getRoot");
    const replacement = domNode("new-selected", "button#new");
    port.emitMessage({
      type: "dom.root",
      requestId: recoveryRoot.requestId,
      documentEpoch: 1,
      node: replacement,
    });
    await flushAsync();
    const selectedResolution = lastRequest(port, "dom.resolveLocator");
    port.emitMessage({
      type: "dom.locator",
      requestId: selectedResolution.requestId,
      documentEpoch: 1,
      node: replacement,
      ancestorPath: [replacement],
    });
    await flushAsync();

    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "old-selected",
    )).toBeUndefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "new-selected",
    )).toBeDefined();
    expect(dom.element("dom-tree").getAttribute("aria-busy")).toBe("false");
    expect(dom.element("dom-tree").className.split(" "))
      .not.toContain("is-recovering");
    expect(dom.element("resolution-status").value)
      .toBe("Select an element to inspect");
    expect(port.sent.filter((message) => (
      isRecord(message) && message.type === "dom.select"
    ))).toEqual([{
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "new-selected",
    }]);
    runtime.dispose();
  });

  it("lets a manual same-epoch selection replace frozen refs during recovery", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(selectionChangedWithRevision(
      "old-selected",
      "button#old",
      1,
      6,
    ));
    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const staleRoot = lastRequest(port, "dom.getRoot");

    port.emitMessage(selectionChangedWithRevision(
      "manual-selected",
      "button#manual",
      1,
      6,
    ));
    port.emitMessage({
      type: "dom.root",
      requestId: staleRoot.requestId,
      documentEpoch: 6,
      node: domNode("late-root", "html"),
    });
    await flushAsync();

    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "manual-selected",
    )).toBeDefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "old-selected",
    )).toBeUndefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "late-root",
    )).toBeUndefined();
    expect(dom.element("dom-tree").getAttribute("aria-busy")).toBe("false");
    expect(dom.element("selected-element-summary").value)
      .toBe("Selected: button#manual");
    expect(reportedErrors).toEqual([]);
    runtime.dispose();
  });

  it("lets a second invalidation supersede the first recovery root", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    const initialRoot = lastRequest(port, "dom.getRoot");
    port.emitMessage({
      type: "dom.root",
      requestId: initialRoot.requestId,
      documentEpoch: 1,
      node: domNode("old-root", "html"),
    });
    await flushAsync();

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const firstRoot = lastRequest(port, "dom.getRoot");
    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const secondRoot = lastRequest(port, "dom.getRoot");
    expect(secondRoot.requestId).not.toBe(firstRoot.requestId);
    port.emitMessage({
      type: "dom.root",
      requestId: firstRoot.requestId,
      documentEpoch: 2,
      node: domNode("stale-root", "html"),
    });
    port.emitMessage({
      type: "dom.root",
      requestId: secondRoot.requestId,
      documentEpoch: 2,
      node: domNode("second-root", "html"),
    });
    await flushAsync();

    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "second-root",
    )).toBeDefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "stale-root",
    )).toBeUndefined();
    expect(dom.element("resolution-status").value)
      .toBe("Select an element to inspect");
    runtime.dispose();
  });

  it("clears frozen controls and restoring status after a fatal root error", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(selectionChangedWithRevision(
      "old-selected",
      "button#old",
      1,
    ));
    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    const recoveryRoot = lastRequest(port, "dom.getRoot");

    port.emitMessage({
      type: "dom.error",
      requestId: recoveryRoot.requestId,
      code: "session-disposed",
    });
    await flushAsync();

    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(dom.element("dom-tree").getAttribute("aria-busy")).toBe("false");
    expect(dom.element("resolution-status").value)
      .toBe("Select an element to inspect");
    runtime.dispose();
  });

  it("ignores a stale inspection invalidation before any linked session", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    expect(dom.element("dom-tree-spacer").children).toHaveLength(1);

    dom.element("disconnect-button").dispatch("click");
    await flushAsync();

    expect(dom.element("dom-tree-spacer").children).toEqual([]);
    expect(messages).toContainEqual({
      type: "pin-op.unlinkWindow",
      channel: "test-channel",
    });
    runtime.dispose();
  });

  it("turns Inspect off when navigation invalidates the content lease", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();

    const inspect = dom.element("inspect-mode");
    inspect.dispatch("click");
    await flushAsync();
    const request = port.sent.find((message) =>
      isRecord(message) &&
      message.type === "pin-op.inspect.setEnabled"
    ) as { requestId: string };
    port.emitMessage({
      type: "pin-op.inspect.result",
      requestId: request.requestId,
      ok: true,
    });
    await flushAsync();
    expect(pressed(inspect)).toBe(true);

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
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
      type: "pin-op.windowState",
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
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      selectionRevision: 1,
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

  it("creates footer source icons with the supplied panel document", async () => {
    const globalCreateElementNS = vi.fn(() => {
      throw new Error("global document must not create panel icons");
    });
    vi.stubGlobal("document", { createElementNS: globalCreateElementNS });

    const runtime = createRuntime();
    await runtime.ready;

    expect(globalCreateElementNS).not.toHaveBeenCalled();
    expect(dom.element("source-previous").children[0]?.tagName).toBe("svg");
    expect(dom.element("source-next").children[0]?.tagName).toBe("svg");
    expect(dom.namespacedTags()).toContainEqual({
      namespace: "http://www.w3.org/2000/svg",
      tagName: "path",
    });
    runtime.dispose();
  });

  it("keeps selected-row and footer source navigation synchronized", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 7,
      selectionRevision: 1,
      nodeRef: "selected",
      ancestorPath: [
        domNode("root", "html", true),
        domNode("selected", "button.save"),
      ],
    });
    port.emitMessage(inspectStarted("inspect-navigation"));

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("dom-tree-spacer").findByData(
      "part",
      "source-navigation-controls",
    )).toBeDefined();

    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-navigation",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
    }));

    expect(dom.element("source-navigation-footer").hidden).toBe(false);
    expect(dom.element("source-navigation-counter").value).toBe("- / 2");
    expect(dom.element("source-previous").disabled).toBe(true);
    expect(dom.element("source-next").disabled).toBe(true);
    expect(rowSourceButton(dom, "source-previous").disabled).toBe(true);
    expect(rowSourceButton(dom, "source-next").disabled).toBe(true);

    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-navigation",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
      activeMatchIndex: 1,
    }));

    expect(dom.element("source-navigation-counter").value).toBe("2 / 2");
    expect(dom.element("source-previous").disabled).toBe(false);
    expect(dom.element("source-next").disabled).toBe(false);
    expect(rowSourceButton(dom, "source-previous").disabled).toBe(false);
    expect(rowSourceButton(dom, "source-next").disabled).toBe(false);

    dom.element("source-next").dispatch("click");
    dom.element("dom-tree").dispatch("click", {
      target: rowSourceButton(dom, "source-previous"),
    });
    await flushAsync();

    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([
      {
        type: "pin-op.source.navigate",
        inspectMessageId: "inspect-navigation",
        resolutionGeneration: 5,
        direction: "next",
      },
      {
        type: "pin-op.source.navigate",
        inspectMessageId: "inspect-navigation",
        resolutionGeneration: 5,
        direction: "previous",
      },
    ]);
    runtime.dispose();
  });

  it("invalidates reconnect navigation until a new correlation is ready", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-old", "inspect-old");
    const staleRowNext = rowSourceButton(dom, "source-next");

    port.emitMessage({ type: "pin-op.windowState", state: "offline" });
    port.emitMessage({ type: "pin-op.windowState", state: "offline" });
    port.emitMessage({
      type: "pin-op.windowState",
      state: "reconnecting",
    });
    port.emitMessage({
      type: "pin-op.windowState",
      state: "reconnecting",
    });

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("source-previous").disabled).toBe(true);
    expect(dom.element("source-next").disabled).toBe(true);
    expect(dom.element("dom-tree-spacer").findByData(
      "part",
      "source-navigation-controls",
    )).toBeUndefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "selected-old",
    )).toBeDefined();
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: main",
    );

    dom.element("source-next").dispatch("click");
    dom.element("dom-tree").dispatch("click", { target: staleRowNext });
    await flushAsync();
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([]);

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(sourceNavigationState({
      messageId: "state-old-late",
      sessionId: "session-old",
      inspectMessageId: "inspect-old",
      resolutionGeneration: 1,
      selectedMatchCount: 2,
      activeMatchIndex: 1,
    }));
    dom.element("source-previous").dispatch("click");
    await flushAsync();

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([]);

    port.emitMessage(selectionChangedWithRevision(
      "selected-new",
      "button#new.primary",
      2,
    ));
    port.emitMessage(inspectStartedWithRevision("inspect-new", 2));
    port.emitMessage(resolutionMessage({
      sessionId: "session-new",
      inspectMessageId: "inspect-new",
      resolutionGeneration: 8,
      selectedMatchCount: 2,
    }));

    expect(dom.element("source-navigation-footer").hidden).toBe(false);
    expect(dom.element("source-previous").disabled).toBe(true);
    expect(dom.element("source-next").disabled).toBe(true);
    expect(rowSourceButton(dom, "source-previous").disabled).toBe(true);
    expect(rowSourceButton(dom, "source-next").disabled).toBe(true);

    port.emitMessage(sourceNavigationState({
      messageId: "state-new",
      sessionId: "session-new",
      inspectMessageId: "inspect-new",
      resolutionGeneration: 8,
      selectedMatchCount: 2,
      activeMatchIndex: 1,
    }));

    expect(dom.element("source-navigation-counter").value).toBe("2 / 2");
    expect(dom.element("source-previous").disabled).toBe(false);
    expect(dom.element("source-next").disabled).toBe(false);
    expect(rowSourceButton(dom, "source-previous").disabled).toBe(false);
    expect(rowSourceButton(dom, "source-next").disabled).toBe(false);

    dom.element("source-next").dispatch("click");
    dom.element("dom-tree").dispatch("click", {
      target: rowSourceButton(dom, "source-previous"),
    });
    await flushAsync();

    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([
      {
        type: "pin-op.source.navigate",
        inspectMessageId: "inspect-new",
        resolutionGeneration: 8,
        direction: "next",
      },
      {
        type: "pin-op.source.navigate",
        inspectMessageId: "inspect-new",
        resolutionGeneration: 8,
        direction: "previous",
      },
    ]);
    runtime.dispose();
  });

  it.each([
    "notLinked",
    "linking",
    "offline",
    "reconnecting",
    "rateLimited",
    "error",
  ] as const)("invalidates navigation when window state becomes %s", async (state) => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-old", "inspect-old");
    const staleRowNext = rowSourceButton(dom, "source-next");

    port.emitMessage({
      type: "pin-op.windowState",
      state,
      ...(state === "error" ? { displayLinkCode: "48735 07" } : {}),
    });
    dom.element("source-next").dispatch("click");
    dom.element("dom-tree").dispatch("click", { target: staleRowNext });
    await flushAsync();

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("source-previous").disabled).toBe(true);
    expect(dom.element("source-next").disabled).toBe(true);
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([]);
    runtime.dispose();
  });

  it("accepts equal-generation cursor updates and rejects mismatched state", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "main")],
    });
    port.emitMessage(inspectStarted());
    port.emitMessage(resolutionMessage({
      resolutionGeneration: 3,
      selectedMatchCount: 2,
    }));

    port.emitMessage(sourceNavigationState({
      resolutionGeneration: 3,
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    port.emitMessage(sourceNavigationState({
      messageId: "state-2",
      resolutionGeneration: 3,
      selectedMatchCount: 2,
      activeMatchIndex: 1,
    }));
    expect(dom.element("source-navigation-counter").value).toBe("2 / 2");

    port.emitMessage(sourceNavigationState({
      messageId: "state-wrong-count",
      resolutionGeneration: 3,
      selectedMatchCount: 3,
      activeMatchIndex: 0,
    }));
    port.emitMessage(sourceNavigationState({
      messageId: "state-wrong-generation",
      resolutionGeneration: 4,
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));

    expect(dom.element("source-navigation-counter").value).toBe("2 / 2");
    runtime.dispose();
  });

  it("invalidates navigation on selection reset, inspect invalidation, and IDE disconnect", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();

    showReadySourceNavigation(port, "selected-a", "inspect-a");
    expect(dom.element("source-navigation-footer").hidden).toBe(false);

    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
    expect(dom.element("source-navigation-footer").hidden).toBe(true);

    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-b", "inspect-b");
    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    expect(dom.element("source-navigation-footer").hidden).toBe(true);

    port.emitMessage(inspectStarted("inspect-c"));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-c",
      selectedMatchCount: 2,
    }));
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-c",
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    expect(dom.element("source-navigation-footer").hidden).toBe(false);

    port.emitMessage(peerState(false, 2));
    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    runtime.dispose();
  });

  it("keeps a matched footer when the DOM selection arrives after resolution", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
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
      selectionRevision: 1,
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

  it("invalidates A when B selection arrives before B inspect starts", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();

    showReadySourceNavigation(port, "selected-a", "inspect-a");
    expect(dom.element("source-navigation-footer").hidden).toBe(false);

    port.emitMessage(selectionChangedWithRevision(
      "selected-b",
      "button#new.primary",
      2,
    ));
    dom.element("source-next").dispatch("click");
    await flushAsync();

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#new.primary",
    );
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([]);
    runtime.dispose();
  });

  it("preserves B navigation when B inspect completes before its equal selection", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-a", "inspect-a");

    port.emitMessage(inspectStartedWithRevision("inspect-b", 2));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
    }));
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
      activeMatchIndex: 1,
    }));
    port.emitMessage(selectionChangedWithRevision(
      "selected-b",
      "button#current.primary",
      2,
    ));
    dom.element("source-next").dispatch("click");
    await flushAsync();

    expect(dom.element("source-navigation-footer").hidden).toBe(false);
    expect(dom.element("source-navigation-counter").value).toBe("2 / 2");
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([{
      type: "pin-op.source.navigate",
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      direction: "next",
    }]);
    runtime.dispose();
  });

  it("drops an older same-epoch selection without regressing B", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-a", "inspect-a");

    port.emitMessage(inspectStartedWithRevision("inspect-b", 2));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
    }));
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    port.emitMessage(selectionChangedWithRevision(
      "selected-b",
      "button#current.primary",
      2,
    ));
    port.emitMessage(selectionChangedWithRevision(
      "stale-a",
      "button#stale.primary",
      1,
    ));
    dom.element("source-previous").dispatch("click");
    await flushAsync();

    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#current.primary",
    );
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "selected-b",
    )).toBeDefined();
    expect(dom.element("dom-tree-spacer").findByData(
      "nodeRef",
      "stale-a",
    )).toBeUndefined();
    expect(dom.element("source-navigation-counter").value).toBe("1 / 2");
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([{
      type: "pin-op.source.navigate",
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      direction: "previous",
    }]);
    runtime.dispose();
  });

  it("invalidates B when a newer selection arrives", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-a", "inspect-a");
    port.emitMessage(inspectStartedWithRevision("inspect-b", 2));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
    }));
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-b",
      resolutionGeneration: 5,
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    port.emitMessage(selectionChangedWithRevision(
      "selected-b",
      "button#current.primary",
      2,
    ));

    port.emitMessage(selectionChangedWithRevision(
      "selected-c",
      "button#newer.primary",
      3,
    ));
    dom.element("source-next").dispatch("click");
    await flushAsync();

    expect(dom.element("source-navigation-footer").hidden).toBe(true);
    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: button#newer.primary",
    );
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([]);
    runtime.dispose();
  });

  it("accepts a lower revision after inspect invalidation resets ownership", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    showReadySourceNavigation(port, "selected-old", "inspect-old", 20);

    port.emitMessage({
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    port.emitMessage(inspectStartedWithRevision("inspect-new-session", 1));
    port.emitMessage(resolutionMessage({
      inspectMessageId: "inspect-new-session",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
    }));
    port.emitMessage(sourceNavigationState({
      inspectMessageId: "inspect-new-session",
      resolutionGeneration: 2,
      selectedMatchCount: 2,
      activeMatchIndex: 0,
    }));
    port.emitMessage(selectionChangedWithRevision(
      "selected-new-session",
      "main#replacement",
      1,
      0,
    ));
    dom.element("source-next").dispatch("click");
    await flushAsync();

    expect(dom.element("selected-element-summary").value).toBe(
      "Selected: main#replacement",
    );
    expect(port.sent.filter(isSourceNavigationCommand)).toEqual([{
      type: "pin-op.source.navigate",
      inspectMessageId: "inspect-new-session",
      resolutionGeneration: 2,
      direction: "next",
    }]);
    runtime.dispose();
  });

  it("records resolving and accepted bounded resolution diagnostics", async () => {
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage(inspectStarted("inspect-old"));
    port.emitMessage(inspectStarted("inspect-current"));

    port.emitMessage({
      type: "pin-op.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-old",
    });
    expect(dom.element("resolution-status").value).toBe(
      "Resolving in VS Code",
    );

    port.emitMessage({
      type: "pin-op.ideState",
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });
    port.emitMessage(inspectStarted());
    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });

    port.emitMessage({ type: "pin-op.windowState", state: "notLinked" });
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
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "selected",
      ancestorPath: [domNode("selected", "article.card")],
    });

    port.emitMessage({
      type: "pin-op.windowState",
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
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
      if (isRecord(message) && message.type === "pin-op.unlinkWindow") {
        return { ok: false, error: "busy" };
      }
      return isCommand(message) ? { ok: true } : undefined;
    };
    const runtime = createRuntime();
    await runtime.ready;
    const port = requiredPort(ports, 0);
    port.emitMessage({
      type: "pin-op.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    port.emitMessage({ type: "pin-op.windowState", state: "linked" });
    await flushAsync();
    port.emitMessage({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
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
    expect(html.replace(/\s+/g, " ")).toContain(
      '<div class="resolution-row"> <output id="resolution-status" class="resolution-status" role="status">Select an element to inspect</output> <div id="source-navigation-footer" class="source-navigation-footer" hidden> <output id="source-navigation-counter"></output> <button id="source-previous" class="source-navigation-button" type="button" aria-label="Previous source match" title="Previous source match"></button> <button id="source-next" class="source-navigation-button" type="button" aria-label="Next source match" title="Next source match"></button> </div> </div>',
    );
    expect(html).not.toContain('id="change-button"');
    expect(html).not.toContain('id="unlink-button"');
    expect(html).not.toContain('id="connected-controls"');
    expect(html).not.toContain('id="inspect-mode" type="checkbox"');
    expect(css).toContain("grid-template-rows: auto auto minmax(0, 1fr) auto");
    expect(css).toContain('[data-layout="tabs"]');
    expect(css).toContain('[data-layout="stack"]');
    expect(css).toContain('[data-layout="split"]');
    expect(css).toContain(".source-navigation-controls");
    expect(css).toContain(".source-navigation-footer");
    expect(css).toMatch(/\.resolution-status\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;/s);
    expect(css).toMatch(/\.source-navigation-button\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;/s);
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
  "auto-refresh-enabled",
  "ide-highlight-enabled",
  "protocol-mismatch",
  "protocol-mismatch-versions",
  "panel-workspace",
  "workspace-tabs",
  "dom-tab",
  "source-tab",
  "dom-pane",
  "pane-separator",
  "source-pane",
  "source-pane-root",
  "selected-element-summary",
  "resolution-status",
  "source-navigation-footer",
  "source-navigation-counter",
  "source-previous",
  "source-next",
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
  public readonly tagName: string;
  public readonly namespaceURI: string | undefined;
  public readonly style: Record<string, string> = {};
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly capturedPointers = new Set<number>();
  public parentElement: FakeElement | undefined;
  public focusCalls = 0;
  public focusError: unknown;
  public setPointerCaptureError: unknown;
  public releasePointerCaptureError: unknown;
  public boundsError: unknown;
  public setPointerCaptureAction: (() => void) | undefined;
  public boundsAction: (() => void) | undefined;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public constructor(tagName = "div", namespaceURI?: string) {
    this.tagName = tagName.toLowerCase();
    this.namespaceURI = namespaceURI;
  }

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

  public text(): string {
    return this.textContent + this.children.map((child) => child.text()).join("");
  }

  public findTag(tagName: string): FakeElement | undefined {
    if (this.tagName === tagName.toLowerCase()) {
      return this;
    }
    for (const child of this.children) {
      const match = child.findTag(tagName);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  public appendChild(child: FakeElement): FakeElement {
    this.append(child);
    return child;
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
      stopPropagation() {},
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

  public focus(): void {
    this.focusCalls += 1;
    if (this.focusError) throw this.focusError;
  }

  public setPointerCapture(pointerId: number): void {
    this.setPointerCaptureAction?.();
    if (this.setPointerCaptureError) throw this.setPointerCaptureError;
    this.capturedPointers.add(pointerId);
  }

  public releasePointerCapture(pointerId: number): void {
    if (this.releasePointerCaptureError) throw this.releasePointerCaptureError;
    this.capturedPointers.delete(pointerId);
  }

  public getBoundingClientRect(): DOMRect {
    this.boundsAction?.();
    if (this.boundsError) throw this.boundsError;
    return {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
  }

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
  viewport(): FakeElement;
  body(): FakeElement;
  namespacedTags(): readonly {
    readonly namespace: string;
    readonly tagName: string;
  }[];
  totalListeners(): number;
}

function createFakeDom(): FakeDom {
  const namespacedTags: Array<{
    readonly namespace: string;
    readonly tagName: string;
  }> = [];
  const elements = new Map(
    ELEMENT_IDS.map((id) => [id, new FakeElement()] as const),
  );
  const documentElement = new FakeElement("html");
  const bodyElement = new FakeElement("body");
  documentElement.append(bodyElement);
  return {
    document: {
      documentElement,
      body: bodyElement,
      getElementById: (id) => elements.get(id as (typeof ELEMENT_IDS)[number]) ?? null,
      createElement: (tagName: string) => new FakeElement(tagName),
      createTextNode: (text: string) => {
        const node = new FakeElement("#text");
        node.textContent = text;
        return node;
      },
      createElementNS: (namespace: string, tagName: string) => {
        namespacedTags.push({ namespace, tagName });
        return new FakeElement(tagName, namespace);
      },
      activeElement: null,
    },
    element(id) {
      const element = elements.get(id as (typeof ELEMENT_IDS)[number]);
      if (!element) {
        throw new Error(`Unknown fake element: ${id}`);
      }
      return element;
    },
    viewport() {
      return documentElement;
    },
    body() {
      return bodyElement;
    },
    namespacedTags() {
      return namespacedTags;
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
    (message.type === "pin-op.linkWindow" ||
      message.type === "pin-op.unlinkWindow")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isRootRequest(value: unknown): boolean {
  return isRecord(value) && value.type === "dom.getRoot";
}

function lastRequest(
  port: TestRuntimePort,
  type: "dom.getRoot" | "dom.resolveLocator",
): { readonly requestId: string } {
  const request = [...port.sent].reverse().find((message) => (
    isRecord(message) && message.type === type
  ));
  if (!isRecord(request) || typeof request.requestId !== "string") {
    throw new Error(`Missing ${type} request`);
  }
  return { requestId: request.requestId };
}

function isSourceNavigationCommand(value: unknown): boolean {
  return isRecord(value) && value.type === "pin-op.source.navigate";
}

function domNode(nodeRef: string, label: string, expandable = false) {
  return {
    nodeRef,
    kind: "element" as const,
    label,
    expandable,
    branchRevision: 0,
    locator: {
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: [],
      path: [{ tagName: "div", siblingIndex: 0 }],
    },
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

function sourceNavigationState(
  overrides: Partial<SourceNavigationStateMessage> = {},
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: "state-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 1,
    selectedMatchCount: 1,
    metadata: {},
    ...overrides,
  };
}

class TestResizeObserver {
  private target: object | undefined;
  public disconnected = false;

  public constructor(private readonly callback: ResizeObserverCallback) {}

  public observe(target: object): void {
    this.target = target;
  }

  public disconnect(): void {
    this.disconnected = true;
    this.target = undefined;
  }

  public emit(target: object, width: number, height: number): void {
    this.callback([{
      target,
      contentRect: { width, height },
    } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function emitPanelResize(
  observer: TestResizeObserver,
  dom: FakeDom,
  viewportWidth: number,
  viewportHeight: number,
  workspaceWidth = viewportWidth,
  workspaceHeight = viewportHeight,
): void {
  observer.emit(dom.viewport(), viewportWidth, viewportHeight);
  observer.emit(
    dom.element("panel-workspace"),
    workspaceWidth,
    workspaceHeight,
  );
  observer.emit(dom.element("pane-separator"), 5, 5);
}

function compatible() {
  return {
    type: "pin-op.protocol.compatibility" as const,
    compatible: true as const,
    browserProtocolVersion: PROTOCOL_VERSION,
  };
}

function tabState(autoRefreshEnabled: boolean, ideHighlightEnabled: boolean) {
  return {
    type: "pin-op.tab.state" as const,
    autoRefreshEnabled,
    ideHighlightEnabled,
    participant: autoRefreshEnabled,
    lastAcceptedGeneration: 0,
  };
}

function sourceMatches(
  inspectMessageId: string,
  resolutionGeneration: number,
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId,
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    matches: [sourceExcerpt()],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function sourceExcerpt(): SourceExcerpt {
  return {
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
  };
}

function isPresentationSettings(message: unknown): boolean {
  return isRecord(message) && message.type === "pin-op.presentation.settings";
}

function rowSourceButton(
  dom: FakeDom,
  action: "source-previous" | "source-next",
): FakeElement {
  const button = dom.element("dom-tree-spacer").findByData("action", action);
  if (!button) {
    throw new Error(`Missing row source button: ${action}`);
  }
  return button;
}

function showReadySourceNavigation(
  port: TestRuntimePort,
  nodeRef: string,
  inspectMessageId: string,
  selectionRevision = 1,
): void {
  port.emitMessage({
    type: "dom.selectionChanged",
    documentEpoch: 1,
    selectionRevision,
    nodeRef,
    ancestorPath: [domNode(nodeRef, "main")],
  });
  port.emitMessage(inspectStarted(inspectMessageId, selectionRevision));
  port.emitMessage(resolutionMessage({
    inspectMessageId,
    selectedMatchCount: 2,
  }));
  port.emitMessage(sourceNavigationState({
    inspectMessageId,
    selectedMatchCount: 2,
    activeMatchIndex: 0,
  }));
}

function inspectStarted(
  inspectMessageId = "inspect-1",
  selectionRevision = 1,
) {
  return {
    type: "pin-op.inspect.started" as const,
    inspectMessageId,
    selectionRevision,
  };
}

function inspectStartedWithRevision(
  inspectMessageId: string,
  selectionRevision: number,
) {
  return inspectStarted(inspectMessageId, selectionRevision);
}

function selectionChangedWithRevision(
  nodeRef: string,
  label: string,
  selectionRevision: number,
  documentEpoch = 1,
) {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch,
    selectionRevision,
    nodeRef,
    ancestorPath: [domNode(nodeRef, label)],
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
