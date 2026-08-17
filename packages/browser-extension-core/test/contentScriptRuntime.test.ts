import { describe, expect, it, vi } from "vitest";
import {
  startContentRefreshBootstrapRuntime,
  startContentRefreshRuntime,
  startContentScriptRuntime,
} from "../src/contentScriptRuntime.js";
import { createInspectContentLeasePortName } from "../src/inspectPortProtocol.js";

describe("startContentScriptRuntime", () => {
  it("is idempotent, owns the inspect lease, and cleans up listeners", async () => {
    const runtimeMessages = messageHarness();
    const leasePort = portHarness();
    const document = documentHarness();
    const pageSession = pageSessionHarness();
    const globalScope = {};
    const sent: unknown[] = [];
    const createContentSessionId = vi.fn(() => "content-session-a");
    let sessionOptions: Record<string, unknown> | undefined;
    const options = {
      globalScope,
      document: document.document,
      location: locationSource(),
      connectRuntimePort: vi.fn(() => leasePort.port),
      sendRuntimeMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId,
      createPageInspectionSession(next: unknown) {
        sessionOptions = next as Record<string, unknown>;
        return pageSession.session;
      },
    };

    const first = startContentScriptRuntime(options);
    const second = startContentScriptRuntime(options);
    expect(second).toBe(first);
    expect(runtimeMessages.subscribe).toHaveBeenCalledOnce();
    expect(createContentSessionId).toHaveBeenCalledOnce();

    await runtimeMessages.emit({ type: "enableInspectMode" });
    expect(options.connectRuntimePort).toHaveBeenCalledWith(
      createInspectContentLeasePortName("content-session-a"),
    );
    expect(pageSession.enablePicker).toHaveBeenCalledOnce();

    const onSelection = sessionOptions?.onSelection as
      | ((selection: unknown) => boolean)
      | undefined;
    const onEvent = sessionOptions?.onEvent as
      | ((event: unknown) => void)
      | undefined;
    expect(onSelection?.({
      nodeRef: "node-card",
      documentEpoch: 1,
      selectionRevision: 7,
      ancestorPath: [
        {
          nodeRef: "node-layout",
          kind: "element",
          label: "main.layout",
          expandable: true,
          branchRevision: 0,
        },
      ],
      payload: inspectPayload(),
    })).toBe(true);
    onEvent?.({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 7,
      nodeRef: "node-card",
      ancestorPath: [
        {
          nodeRef: "node-layout",
          kind: "element",
          label: "main.layout",
          expandable: true,
          branchRevision: 0,
        },
      ],
    });
    await flushAsync();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      type: "elementSelected",
      contentSessionId: "content-session-a",
      selectionRevision: 7,
      payload: {
        context: { url: "https://example.test/page" },
        targets: [{ role: "selected" }],
      },
    });
    const publicInspectPayload = JSON.stringify(
      (sent[0] as { payload: unknown }).payload,
    );
    expect(publicInspectPayload).not.toContain("nodeRef");
    expect(publicInspectPayload).not.toContain("ancestorPath");
    expect(publicInspectPayload).not.toContain("dom.selectionChanged");
    expect(publicInspectPayload).not.toContain("dom.getRoot");
    expect(sent[1]).toEqual({
      type: "pin-op.dom.event",
      contentSessionId: "content-session-a",
      event: {
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 7,
        nodeRef: "node-card",
        ancestorPath: [
          {
            nodeRef: "node-layout",
            kind: "element",
            label: "main.layout",
            expandable: true,
            branchRevision: 0,
          },
        ],
      },
    });

    leasePort.disconnect();
    expect(pageSession.dispose).toHaveBeenCalledOnce();

    first.dispose();
    first.dispose();
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
    expect(leasePort.remove).toHaveBeenCalledOnce();

    const restarted = startContentScriptRuntime(options);
    expect(restarted).not.toBe(first);
    expect(createContentSessionId).toHaveBeenCalledTimes(2);
    restarted.dispose();
  });

  it("reports selection transport failures without leaking an unhandled rejection", async () => {
    const runtimeMessages = messageHarness();
    const document = documentHarness();
    const pageSession = pageSessionHarness();
    const reported: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: document.document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => {
        throw new Error("runtime unavailable");
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
      onError: (error) => reported.push(error),
    });

    const onSelection = sessionOptions?.onSelection as
      | ((selection: unknown) => boolean)
      | undefined;
    onSelection?.({
      nodeRef: "node-card",
      documentEpoch: 1,
      ancestorPath: [],
      payload: inspectPayload(),
    });
    await flushAsync();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(Error);
    runtime.dispose();
  });

  it("keeps one page session alive with picker off and serves DOM requests", async () => {
    const runtimeMessages = messageHarness();
    const leasePort = portHarness();
    const pageSession = pageSessionHarness();
    const createPageInspectionSession = vi.fn(() => pageSession.session);
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: vi.fn(() => leasePort.port),
      sendRuntimeMessage: vi.fn(async () => undefined),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createPageInspectionSession,
    });

    expect(createPageInspectionSession).toHaveBeenCalledOnce();
    expect(pageSession.dispose).not.toHaveBeenCalled();
    expect(pageSession.disablePicker).not.toHaveBeenCalled();

    await runtimeMessages.emit({ type: "disableInspectMode" });
    expect(pageSession.disablePicker).toHaveBeenCalledOnce();
    expect(pageSession.dispose).not.toHaveBeenCalled();

    await expect(runtimeMessages.emit({
      type: "dom.getRoot",
      requestId: "root-1",
    })).resolves.toEqual(rootResponse("root-1"));
    expect(pageSession.handle).toHaveBeenCalledWith({
      type: "dom.getRoot",
      requestId: "root-1",
    });
    expect(pageSession.dispose).not.toHaveBeenCalled();

    leasePort.disconnect();
    expect(pageSession.dispose).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("republishes a live selection and forwards page DOM events", async () => {
    const runtimeMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const sent: unknown[] = [];
    let sessionOptions: Record<string, unknown> | undefined;
    const contentSessionId = "content-session-events";
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async (message) => {
        sent.push(message);
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      createContentSessionId: () => contentSessionId,
      createPageInspectionSession(options) {
        sessionOptions = options as unknown as Record<string, unknown>;
        return pageSession.session;
      },
    });

    await runtimeMessages.emit({ type: "pin-op.inspect.republish" });
    expect(pageSession.republishSelection).toHaveBeenCalledOnce();

    const onEvent = sessionOptions?.onEvent as
      | ((event: unknown) => void)
      | undefined;
    onEvent?.({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: "node-a",
      summary: "button.save",
    });
    await flushAsync();
    expect(sent).toContainEqual({
      type: "pin-op.dom.event",
      contentSessionId,
      event: {
        type: "dom.hoverChanged",
        documentEpoch: 1,
        nodeRef: "node-a",
        summary: "button.save",
      },
    });
    runtime.dispose();
  });
});

describe("startContentRefreshRuntime", () => {
  it("runs style refresh for one exact top-frame binding without an inspect port", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const sent: unknown[] = [];
    const clearOverlay = vi.fn();
    const refreshStylesheets = vi.fn(async () => Object.freeze({
      attempted: 2,
      updated: 1,
      failed: 1,
    }));
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 21,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        return undefined;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
      refreshStylesheets,
    });
    await flushAsync();
    expect(sent).toEqual([{
      type: "pin-op.refresh.content.ready",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
    }]);

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      refreshGeneration: 5,
      mode: "styles",
    })).resolves.toEqual({
      type: "pin-op.refresh.content.result",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-a",
      refreshGeneration: 5,
      mode: "styles",
      accepted: true,
      stylesheet: { attempted: 2, updated: 1, failed: 1 },
    });
    expect(clearOverlay).toHaveBeenCalledOnce();
    expect(refreshStylesheets).toHaveBeenCalledWith(
      page.document,
      5,
      { signal: expect.any(AbortSignal) },
    );

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 21,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "another-runtime",
      refreshGeneration: 6,
      mode: "styles",
    })).resolves.toBeUndefined();
    expect(clearOverlay).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
  });

  it("captures and requests an exact background reload without treating acceptance as navigation", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    page.view.scrollX = 34;
    page.view.scrollY = 78;
    const clearOverlay = vi.fn();
    const reload = vi.fn();
    page.view.location = { reload };
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 22,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      now: () => 2_000,
      sendRuntimeMessage: async (message) => {
        if ((message as { type?: string }).type === "pin-op.refresh.content.ready") {
          return undefined;
        }
        expect(message).toEqual({
          type: "pin-op.refresh.reload.request",
          tabId: 22,
          frameId: 0,
          pageUrl: "https://example.test/page",
          contentRuntimeId: "refresh-runtime-b",
          refreshGeneration: 8,
          snapshot: {
            tabId: 22,
            url: "https://example.test/page",
            refreshGeneration: 8,
            scrollX: 34,
            scrollY: 78,
            createdAt: 2_000,
          },
        });
        return {
          type: "pin-op.refresh.reload.result",
          tabId: 22,
          frameId: 0,
          pageUrl: "https://example.test/page",
          contentRuntimeId: "refresh-runtime-b",
          refreshGeneration: 8,
          accepted: true,
        };
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      clearOverlay,
    });
    await flushAsync();

    await expect(runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      refreshGeneration: 8,
      mode: "reload",
    })).resolves.toEqual({
      type: "pin-op.refresh.content.result",
      tabId: 22,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-b",
      refreshGeneration: 8,
      mode: "reload",
      accepted: true,
    });
    expect(clearOverlay).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("claims a background-leased snapshot on ready and restores it once", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const snapshot = {
      tabId: 23,
      url: "https://example.test/page",
      refreshGeneration: 11,
      scrollX: 1,
      scrollY: 2,
      createdAt: 3_000,
    } as const;
    const restoration = { dispose: vi.fn() };
    const restoreScroll = vi.fn(() => restoration);
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 23,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-c",
      sendRuntimeMessage: async () => ({
        type: "pin-op.refresh.scroll.restore",
        tabId: 23,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "refresh-runtime-c",
        refreshGeneration: 11,
        snapshot,
      }),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      restoreScroll,
    });
    await flushAsync();
    expect(restoreScroll).toHaveBeenCalledOnce();
    expect(restoreScroll).toHaveBeenCalledWith(snapshot, {
      document: page.document,
      view: page.view,
    });
    runtime.dispose();
    expect(restoration.dispose).toHaveBeenCalledOnce();
  });

  it("clears a colocated inspection overlay without coupling refresh lifetime to its port", async () => {
    const globalScope = {};
    const inspectMessages = messageHarness();
    const refreshMessages = messageHarness();
    const pageSession = pageSessionHarness();
    const inspectRuntime = startContentScriptRuntime({
      globalScope,
      document: documentHarness().document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: inspectMessages.subscribe,
      createPageInspectionSession: () => pageSession.session,
    });
    const page = refreshPageHarness();
    const refreshRuntime = startContentRefreshRuntime({
      globalScope,
      document: page.document,
      view: page.view,
      tabId: 24,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: refreshMessages.subscribe,
      refreshStylesheets: async () => ({ attempted: 0, updated: 0, failed: 0 }),
    });
    await flushAsync();

    await refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      refreshGeneration: 12,
      mode: "styles",
    });
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledOnce();

    inspectRuntime.dispose();
    expect(pageSession.dispose).toHaveBeenCalledOnce();
    await refreshMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 24,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-d",
      refreshGeneration: 13,
      mode: "styles",
    });
    expect(pageSession.clearOverlayForRefresh).toHaveBeenCalledOnce();
    refreshRuntime.dispose();
  });

  it("revokes a queued refresh command when its runtime is disposed", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const refreshStylesheets = vi.fn(async () => ({
      attempted: 0,
      updated: 0,
      failed: 0,
    }));
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 25,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-e",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();

    const pending = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 25,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-e",
      refreshGeneration: 14,
      mode: "styles",
    });
    runtime.dispose();

    await expect(pending).resolves.toBeUndefined();
    expect(refreshStylesheets).not.toHaveBeenCalled();
  });

  it("aborts an in-flight stylesheet refresh when disposed", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    let signal: AbortSignal | undefined;
    let resolveRefresh: ((result: {
      attempted: number;
      updated: number;
      failed: number;
    }) => void) | undefined;
    const refreshStylesheets = vi.fn((
      _document: Document,
      _generation: number,
      options?: { readonly signal?: AbortSignal },
    ) => {
      signal = options?.signal;
      return new Promise<{ attempted: number; updated: number; failed: number }>(
        (resolve) => {
          resolveRefresh = resolve;
          signal?.addEventListener("abort", () => resolve({
            attempted: 1,
            updated: 0,
            failed: 1,
          }), { once: true });
        },
      );
    });
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 26,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-f",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const pending = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 26,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-f",
      refreshGeneration: 15,
      mode: "styles",
    });
    await flushAsync();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    runtime.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    resolveRefresh?.({ attempted: 1, updated: 0, failed: 1 });
  });

  it("aborts an in-flight stylesheet refresh superseded by a newer command", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((result: {
      attempted: number;
      updated: number;
      failed: number;
    }) => void) | undefined;
    const refreshStylesheets = vi.fn((
      _document: Document,
      generation: number,
      options?: { readonly signal?: AbortSignal },
    ) => {
      if (generation !== 16) {
        return Promise.resolve({ attempted: 1, updated: 1, failed: 0 });
      }
      firstSignal = options?.signal;
      return new Promise<{ attempted: number; updated: number; failed: number }>(
        (resolve) => {
          resolveFirst = resolve;
          firstSignal?.addEventListener("abort", () => resolve({
            attempted: 1,
            updated: 0,
            failed: 1,
          }), { once: true });
        },
      );
    });
    const runtime = startContentRefreshRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      tabId: 27,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      sendRuntimeMessage: async () => undefined,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      refreshStylesheets,
    });
    await flushAsync();
    const first = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 27,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      refreshGeneration: 16,
      mode: "styles",
    });
    await flushAsync();
    const second = runtimeMessages.emit({
      type: "pin-op.refresh.content.execute",
      tabId: 27,
      frameId: 0,
      pageUrl: "https://example.test/page",
      contentRuntimeId: "refresh-runtime-g",
      refreshGeneration: 17,
      mode: "styles",
    });
    await flushAsync();
    const firstWasAborted = firstSignal?.aborted ?? false;
    if (!firstWasAborted) {
      resolveFirst?.({ attempted: 1, updated: 0, failed: 1 });
    }

    const [firstResult, secondResult] = await Promise.all([first, second]);
    runtime.dispose();

    expect(firstWasAborted).toBe(true);
    expect(firstResult).toBeUndefined();
    expect(secondResult).toMatchObject({
      accepted: true,
      refreshGeneration: 17,
      mode: "styles",
      stylesheet: { attempted: 1, updated: 1, failed: 0 },
    });
    expect(refreshStylesheets.mock.calls.map((call) => call[1])).toEqual([16, 17]);
  });
});

describe("startContentRefreshBootstrapRuntime", () => {
  it("binds a top document through background before starting refresh", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    const sent: unknown[] = [];
    const runtime = startContentRefreshBootstrapRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      location: { href: "https://example.test/page" },
      createContentRuntimeId: () => "runtime-bootstrap-a",
      sendRuntimeMessage: async (message) => {
        sent.push(message);
        if ((message as { type?: string }).type ===
          "pin-op.refresh.content.bootstrap") {
          return {
            type: "pin-op.refresh.content.bootstrap.result",
            accepted: true,
            tabId: 31,
            frameId: 0,
            pageUrl: "https://example.test/page",
            contentRuntimeId: "runtime-bootstrap-a",
          };
        }
        return undefined;
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
    });
    await flushAsync();
    await flushAsync();

    expect(sent).toEqual([
      {
        type: "pin-op.refresh.content.bootstrap",
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-bootstrap-a",
      },
      {
        type: "pin-op.refresh.content.ready",
        tabId: 31,
        frameId: 0,
        pageUrl: "https://example.test/page",
        contentRuntimeId: "runtime-bootstrap-a",
      },
    ]);
    runtime.dispose();
  });

  it("is a silent no-op in child frames", async () => {
    const runtimeMessages = messageHarness();
    const page = refreshPageHarness();
    page.view.top = {} as Window;
    const sendRuntimeMessage = vi.fn(async () => undefined);
    const onError = vi.fn();

    const runtime = startContentRefreshBootstrapRuntime({
      globalScope: {},
      document: page.document,
      view: page.view,
      location: { href: "https://example.test/frame" },
      sendRuntimeMessage,
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      onError,
    });
    await flushAsync();

    expect(sendRuntimeMessage).not.toHaveBeenCalled();
    expect(runtimeMessages.remove).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

function messageHarness() {
  let listener: ((message: unknown) => unknown) | undefined;
  const remove = vi.fn();
  return {
    subscribe: vi.fn((next: (message: unknown) => unknown) => {
      listener = next;
      return remove;
    }),
    remove,
    async emit(message: unknown) {
      return await listener?.(message);
    },
  };
}

function portHarness() {
  let listener: (() => void) | undefined;
  const remove = vi.fn(() => {
    listener = undefined;
  });
  return {
    port: {
      onDisconnect: {
        addListener(next: () => void) {
          listener = next;
        },
        removeListener: remove,
      },
      disconnect: vi.fn(),
    },
    remove,
    disconnect() {
      listener?.();
    },
  };
}

function documentHarness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const captureAdds: string[] = [];
  const captureRemoves: string[] = [];
  return {
    document: {
      styleSheets: [],
      addEventListener(
        type: string,
        listener: (event: unknown) => void,
        options: boolean | { readonly capture?: boolean; readonly passive?: boolean },
      ) {
        expect(readCapture(options)).toBe(true);
        if (type === "touchstart" || type === "touchend") {
          expect(options).toEqual({ capture: true, passive: false });
        }
        listeners.set(type, listener);
        captureAdds.push(type);
      },
      removeEventListener(
        type: string,
        listener: (event: unknown) => void,
        options: boolean | { readonly capture?: boolean; readonly passive?: boolean },
      ) {
        expect(readCapture(options)).toBe(true);
        if (listeners.get(type) === listener) {
          listeners.delete(type);
        }
        captureRemoves.push(type);
      },
    },
    captureAdds,
    captureRemoves,
    click(target: unknown) {
      for (const type of [
        "pointerdown",
        "pointerup",
        "click",
      ]) {
        listeners.get(type)?.({
          type,
          target,
          isTrusted: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
          composedPath: () => [target],
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {},
        });
      }
    },
  };
}

function readCapture(
  options: boolean | { readonly capture?: boolean },
): boolean {
  return typeof options === "boolean" ? options : options.capture === true;
}

function locationSource() {
  return {
    href: "https://example.test/page",
    pathname: "/page",
    search: "",
    hash: "",
  };
}

function inspectPayload() {
  return {
    targets: [
      {
        role: "selected" as const,
        depth: 0 as const,
        subject: {
          selector: ".card",
          tag: "article",
          id: "hero",
          classes: ["card"],
          metadata: {},
        },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
  };
}

function pageSessionHarness() {
  const enablePicker = vi.fn();
  const disablePicker = vi.fn();
  const republishSelection = vi.fn(async () => true);
  const clearOverlayForRefresh = vi.fn();
  const handle = vi.fn(async (request: { requestId?: string }) =>
    rootResponse(request.requestId ?? "missing")
  );
  const dispose = vi.fn();
  return {
    enablePicker,
    disablePicker,
    republishSelection,
    clearOverlayForRefresh,
    handle,
    dispose,
    session: {
      enablePicker,
      disablePicker,
      republishSelection,
      clearOverlayForRefresh,
      handle,
      dispose,
    },
  };
}

function refreshPageHarness() {
  const view: Record<string, unknown> = {
    scrollX: 0,
    scrollY: 0,
  };
  view.top = view;
  const document = {
    baseURI: "https://example.test/page",
    defaultView: view,
    querySelectorAll: () => [],
    documentElement: {
      scrollWidth: 0,
      scrollHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
    },
    body: null,
    readyState: "complete",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.assign(view, {
    document,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
  });
  return {
    document: document as unknown as Document,
    view: view as unknown as Window & {
      scrollX: number;
      scrollY: number;
      location?: { reload: () => void };
    },
  };
}

function rootResponse(requestId: string) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    node: {
      nodeRef: "node-root",
      kind: "element" as const,
      label: "html",
      expandable: true,
      branchRevision: 0,
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
