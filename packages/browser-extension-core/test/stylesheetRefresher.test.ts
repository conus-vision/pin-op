import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshExternalStylesheets,
  STYLESHEET_REFRESH_TIMEOUT_MS,
} from "../src/stylesheetRefresher.js";

describe("refreshExternalStylesheets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clones eligible top-document links beside the original and preserves authored attributes", async () => {
    const page = pageHarness("https://example.test/app/page");
    const original = page.link({
      rel: "preload stylesheet alternate",
      href: "/assets/app.css?theme=dark#sheet",
      media: "screen",
      integrity: "sha256-test",
      crossorigin: "anonymous",
      nonce: "nonce-value",
      disabled: "",
      "data-owned": "author",
    });
    const sibling = page.link({ rel: "stylesheet", href: "/after.css" });

    const refreshing = refreshExternalStylesheets(page.document, 17);

    const replacement = page.replacementFor(original);
    const siblingReplacement = page.replacementFor(sibling);
    expect(page.nodes).toEqual([original, replacement, sibling, siblingReplacement]);
    expect(replacement.attributesObject()).toEqual({
      rel: "preload stylesheet alternate",
      href: "https://example.test/assets/app.css?theme=dark&pin-op-refresh=17#sheet",
      media: "screen",
      integrity: "sha256-test",
      crossorigin: "anonymous",
      nonce: "nonce-value",
      disabled: "",
      "data-owned": "author",
    });
    expect(page.nodes).toContain(original);

    replacement.emit("load");
    siblingReplacement.emit("load");
    await expect(refreshing).resolves.toEqual({ attempted: 2, updated: 2, failed: 0 });
    expect(Object.isFrozen(await refreshing)).toBe(true);
    expect(page.nodes).toEqual([replacement, siblingReplacement]);
  });

  it("replaces one existing cache-buster instead of appending duplicates", async () => {
    const page = pageHarness("https://example.test/");
    const first = page.link({
      rel: "stylesheet",
      href: "/app.css?pin-op-refresh=1&x=2&pin-op-refresh=old",
    });

    const refreshing = refreshExternalStylesheets(page.document, 91);
    const replacement = page.replacementFor(first);
    const url = new URL(replacement.getAttribute("href")!);
    expect(url.searchParams.getAll("pin-op-refresh")).toEqual(["91"]);
    expect(url.searchParams.get("x")).toBe("2");
    replacement.emit("load");
    await refreshing;

    const again = refreshExternalStylesheets(page.document, 92);
    const second = page.replacementFor(replacement);
    const secondUrl = new URL(second.getAttribute("href")!);
    expect(secondUrl.searchParams.getAll("pin-op-refresh")).toEqual(["92"]);
    second.emit("load");
    await expect(again).resolves.toEqual({ attempted: 1, updated: 1, failed: 0 });
  });

  it("retains the old link on error and on timeout", async () => {
    vi.useFakeTimers();
    const page = pageHarness("https://example.test/");
    const failed = page.link({ rel: "stylesheet", href: "/failed.css" });
    const timedOut = page.link({ rel: "stylesheet", href: "/slow.css" });

    const refreshing = refreshExternalStylesheets(page.document, 3);
    const failedReplacement = page.replacementFor(failed);
    const timedOutReplacement = page.replacementFor(timedOut);
    failedReplacement.emit("error");
    expect(page.nodes).toContain(failed);
    expect(page.nodes).not.toContain(failedReplacement);

    await vi.advanceTimersByTimeAsync(STYLESHEET_REFRESH_TIMEOUT_MS);
    await expect(refreshing).resolves.toEqual({ attempted: 2, updated: 0, failed: 2 });
    expect(page.nodes).toEqual([failed, timedOut]);
    expect(page.nodes).not.toContain(timedOutReplacement);
  });

  it("keeps successful replacements when another stylesheet fails", async () => {
    const page = pageHarness("https://example.test/");
    const success = page.link({ rel: "stylesheet", href: "/ok.css" });
    const failure = page.link({ rel: "stylesheet", href: "/bad.css" });

    const refreshing = refreshExternalStylesheets(page.document, 4);
    const successReplacement = page.replacementFor(success);
    const failureReplacement = page.replacementFor(failure);
    successReplacement.emit("load");
    failureReplacement.emit("error");

    await expect(refreshing).resolves.toEqual({ attempted: 2, updated: 1, failed: 1 });
    expect(page.nodes).toEqual([successReplacement, failure]);
  });

  it("ignores inline, unsupported, non-stylesheet, and child-document resources", async () => {
    const page = pageHarness("https://example.test/");
    page.style();
    page.link({ rel: "icon", href: "/icon.css" });
    page.link({ rel: "stylesheet", href: "data:text/css,body{}" });
    page.link({ rel: "stylesheet", href: "blob:https://example.test/id" });
    page.link({ rel: "stylesheet", href: "file:///tmp/app.css" });
    page.link({ rel: "stylesheet" });
    page.document.adoptedStyleSheets = [{}];

    await expect(refreshExternalStylesheets(page.document, 5)).resolves.toEqual({
      attempted: 0,
      updated: 0,
      failed: 0,
    });
    expect(page.nodes).toHaveLength(6);

    const child = pageHarness("https://example.test/frame", false);
    child.link({ rel: "stylesheet", href: "/frame.css" });
    await expect(refreshExternalStylesheets(child.document, 5)).resolves.toEqual({
      attempted: 0,
      updated: 0,
      failed: 0,
    });
    expect(child.nodes).toHaveLength(1);
  });

  it("contains hostile DOM access without stranding the refresh promise", async () => {
    const page = pageHarness("https://example.test/");
    const hostile = page.link({ rel: "stylesheet", href: "/hostile.css" });
    Object.defineProperty(hostile, "parentNode", {
      configurable: true,
      get() {
        throw new Error("blocked parent");
      },
    });

    await expect(refreshExternalStylesheets(page.document, 6)).resolves.toEqual({
      attempted: 1,
      updated: 0,
      failed: 1,
    });
  });

  it("retains the original when the replacement loses DOM authority before load", async () => {
    const page = pageHarness("https://example.test/");
    const original = page.link({ rel: "stylesheet", href: "/app.css" });

    const refreshing = refreshExternalStylesheets(page.document, 7);
    const replacement = page.replacementFor(original);
    replacement.remove();
    replacement.emit("load");

    await expect(refreshing).resolves.toEqual({
      attempted: 1,
      updated: 0,
      failed: 1,
    });
    expect(page.nodes).toEqual([original]);
  });

  it("aborts pending replacements and makes late resource events inert", async () => {
    vi.useFakeTimers();
    const page = pageHarness("https://example.test/");
    const original = page.link({ rel: "stylesheet", href: "/pending.css" });
    const controller = new AbortController();

    const refreshing = refreshExternalStylesheets(page.document, 8, {
      signal: controller.signal,
    });
    const replacement = page.replacementFor(original);
    expect(replacement.listenerCount("load")).toBe(1);
    expect(replacement.listenerCount("error")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    expect(page.nodes).toEqual([original]);
    expect(replacement.listenerCount("load")).toBe(0);
    expect(replacement.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    replacement.emit("load");
    replacement.emit("error");
    expect(page.nodes).toEqual([original]);
    await expect(refreshing).resolves.toEqual({
      attempted: 1,
      updated: 0,
      failed: 1,
    });
  });
});

type Attributes = Record<string, string>;

class FakeParent {
  public readonly nodes: Array<FakeLink | FakeStyle> = [];

  public insertBefore(node: FakeLink, reference: FakeLink | FakeStyle | null): FakeLink {
    const index = reference === null ? this.nodes.length : this.nodes.indexOf(reference);
    if (index < 0) throw new Error("unknown reference");
    node.parentNode = this;
    this.nodes.splice(index, 0, node);
    return node;
  }

  public removeChild(node: FakeLink | FakeStyle): FakeLink | FakeStyle {
    const index = this.nodes.indexOf(node);
    if (index < 0) throw new Error("unknown child");
    this.nodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

class FakeLink {
  public parentNode: FakeParent | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  public constructor(attributes: Attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      this.attributes.set(name, value);
    }
  }

  public get nextSibling(): FakeLink | FakeStyle | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.nodes.indexOf(this);
    return this.parentNode.nodes[index + 1] ?? null;
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public cloneNode(): FakeLink {
    return new FakeLink(this.attributesObject());
  }

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public remove(): void {
    this.parentNode?.removeChild(this);
  }

  public emit(type: "load" | "error"): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  public listenerCount(type: "load" | "error"): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  public attributesObject(): Attributes {
    return Object.fromEntries(this.attributes);
  }
}

class FakeStyle {
  public parentNode: FakeParent | null = null;
}

function pageHarness(baseURI: string, top = true) {
  const parent = new FakeParent();
  const view: { top?: unknown } = {};
  view.top = top ? view : {};
  const document = {
    baseURI,
    defaultView: view,
    adoptedStyleSheets: [] as unknown[],
    querySelectorAll(selector: string) {
      return selector === "link" ? parent.nodes.filter((node) => node instanceof FakeLink) : [];
    },
  };
  return {
    document: document as unknown as Document & { adoptedStyleSheets: unknown[] },
    nodes: parent.nodes,
    link(attributes: Attributes) {
      const link = new FakeLink(attributes);
      link.parentNode = parent;
      parent.nodes.push(link);
      return link;
    },
    style() {
      const style = new FakeStyle();
      style.parentNode = parent;
      parent.nodes.push(style);
      return style;
    },
    replacementFor(original: FakeLink): FakeLink {
      const index = parent.nodes.indexOf(original);
      const replacement = parent.nodes[index + 1];
      if (!(replacement instanceof FakeLink)) {
        throw new Error("Expected adjacent replacement link");
      }
      return replacement;
    },
  };
}
