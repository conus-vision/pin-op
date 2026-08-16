import { describe, expect, it, vi } from "vitest";
import { startContentScriptRuntime } from "../src/contentScriptRuntime.js";
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
  const handle = vi.fn(async (request: { requestId?: string }) =>
    rootResponse(request.requestId ?? "missing")
  );
  const dispose = vi.fn();
  return {
    enablePicker,
    disablePicker,
    republishSelection,
    handle,
    dispose,
    session: {
      enablePicker,
      disablePicker,
      republishSelection,
      handle,
      dispose,
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
