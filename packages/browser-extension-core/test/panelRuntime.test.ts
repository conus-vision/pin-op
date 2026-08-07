import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(dom.element("inspect-mode").checked).toBe(false);
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
    inspect.checked = true;
    inspect.dispatch("change");
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
    expect(dom.element("inspect-mode").checked).toBe(false);

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

  it("clears the DOM session as soon as Unlink is submitted", async () => {
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

    dom.element("unlink-button").dispatch("click");
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
    inspect.checked = true;
    inspect.dispatch("change");
    await flushAsync();
    const request = port.sent[0] as { requestId: string };
    port.emitMessage({
      type: "browser2ide.inspect.result",
      requestId: request.requestId,
      ok: true,
    });
    await flushAsync();
    expect(inspect.checked).toBe(true);

    port.emitMessage({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
    await flushAsync();

    expect(inspect.checked).toBe(false);
    expect(inspect.disabled).toBe(false);
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
  "connected-controls",
  "change-button",
  "unlink-button",
  "inspect-mode",
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
