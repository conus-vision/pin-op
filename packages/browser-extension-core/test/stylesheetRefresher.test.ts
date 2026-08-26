import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTransientStylesheetRefreshNode,
  refreshExternalStylesheets,
  STYLESHEET_REFRESH_TIMEOUT_MS,
} from "../src/stylesheetRefresher.js";
import { StylesheetRegistry } from "../src/stylesheetRegistry.js";

describe("refreshExternalStylesheets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes controlled-transition cleanup before enumerating or cloning author stylesheets", async () => {
    const page = pageHarness("https://example.test/");
    const original = page.link({ rel: "stylesheet", href: "/app.css" });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const events: string[] = [];
    const refreshing = refreshExternalStylesheets(page.document, 9, {
      beforeControlledTransition: async () => {
        events.push("cleanup-started");
        await cleanupGate;
        events.push("cleanup-finished");
      },
    });

    try {
      await Promise.resolve();
      expect(events).toEqual(["cleanup-started"]);
      expect(page.nodes).toEqual([original]);

      releaseCleanup();
      await vi.waitFor(() => expect(page.nodes).toHaveLength(2));
      const replacement = page.replacementFor(original);
      events.push("replacement-inserted");
      replacement.emit("load");

      await expect(refreshing).resolves.toEqual({
        attempted: 1,
        updated: 1,
        failed: 0,
      });
      expect(events).toEqual([
        "cleanup-started",
        "cleanup-finished",
        "replacement-inserted",
      ]);
    } finally {
      releaseCleanup();
      const replacement = page.nodes.find((node) =>
        node instanceof FakeLink && node !== original
      );
      replacement?.emit("load");
      await refreshing;
    }
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

  it.each(["load", "error", "abort", "timeout"] as const)(
    "removes a moved transient replacement from its current parent after %s",
    async (outcome) => {
      if (outcome === "timeout") vi.useFakeTimers();
      const page = pageHarness("https://example.test/");
      const original = page.link({ rel: "stylesheet", href: "/app.css" });
      const destinationAuthor = page.foreignLink({
        rel: "stylesheet",
        href: "/destination.css",
      });
      const controller = new AbortController();

      const refreshing = refreshExternalStylesheets(page.document, 71, {
        signal: controller.signal,
      });
      const replacement = page.replacementFor(original);
      page.moveToForeignParent(replacement);
      expect(page.nodes).toEqual([original]);
      expect(page.foreignNodes).toEqual([destinationAuthor, replacement]);

      if (outcome === "load") replacement.emit("load");
      if (outcome === "error") replacement.emit("error");
      if (outcome === "abort") controller.abort();
      if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(STYLESHEET_REFRESH_TIMEOUT_MS);
      }

      await expect(refreshing).resolves.toEqual({
        attempted: 1,
        updated: 0,
        failed: 1,
      });
      expect(page.nodes).toEqual([original]);
      expect(page.foreignNodes).toEqual([destinationAuthor]);
      expect(isTransientStylesheetRefreshNode(replacement)).toBe(false);
    },
  );

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

  it("commits one author revision only after a replacement loads", async () => {
    const page = pageHarness("https://example.test/");
    const original = page.link({ rel: "stylesheet", href: "/app.css" });
    const registry = liveRegistry(page);

    const onStylesheetsUpdated = vi.fn(() => {
      registry.invalidate("author-refresh");
    });
    const refreshing = refreshExternalStylesheets(page.document, 9, {
      onStylesheetsUpdated,
    });
    const replacement = page.replacementFor(original);
    expect(isTransientStylesheetRefreshNode(original)).toBe(false);
    expect(isTransientStylesheetRefreshNode(replacement)).toBe(true);
    await Promise.resolve();
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 0,
      stylesRevision: 0,
    });

    replacement.emit("load");
    await refreshing;
    await Promise.resolve();

    expect(isTransientStylesheetRefreshNode(replacement)).toBe(false);
    expect(onStylesheetsUpdated).toHaveBeenCalledOnce();
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 1,
      stylesRevision: 1,
    });
    registry.dispose();
  });

  it.each(["throw", "reject"] as const)(
    "fails a committed refresh when its authority callback ends by %s",
    async (outcome) => {
      const page = pageHarness("https://example.test/");
      const original = page.link({ rel: "stylesheet", href: "/app.css" });
      const authorityError = new Error(`authority callback ${outcome}`);
      const refreshing = refreshExternalStylesheets(page.document, 11, {
        onStylesheetsUpdated: outcome === "throw"
          ? () => { throw authorityError; }
          : async () => { throw authorityError; },
      });
      page.replacementFor(original).emit("load");

      await expect(refreshing).rejects.toBe(authorityError);
    },
  );

  it.each(["error", "abort", "timeout"] as const)(
    "does not advance author revisions when a transient replacement ends by %s",
    async (outcome) => {
      if (outcome === "timeout") vi.useFakeTimers();
      const page = pageHarness("https://example.test/");
      const original = page.link({ rel: "stylesheet", href: "/app.css" });
      const registry = liveRegistry(page);
      const controller = new AbortController();
      const refreshing = refreshExternalStylesheets(page.document, 10, {
        signal: controller.signal,
      });
      const replacement = page.replacementFor(original);
      await Promise.resolve();
      expect(registry.revisions.stylesheetRevision).toBe(0);

      if (outcome === "error") replacement.emit("error");
      if (outcome === "abort") controller.abort();
      if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(STYLESHEET_REFRESH_TIMEOUT_MS);
      }
      await refreshing;
      await Promise.resolve();

      expect(isTransientStylesheetRefreshNode(replacement)).toBe(false);
      expect(registry.revisions).toMatchObject({
        stylesheetRevision: 0,
        stylesRevision: 0,
      });
      registry.dispose();
    },
  );
});

type Attributes = Record<string, string>;

class FakeParent {
  public readonly nodes: Array<FakeLink | FakeStyle> = [];
  private mutationCallback: ((records: readonly unknown[]) => void) | undefined;
  private readonly mutationRecords: unknown[] = [];
  private mutationScheduled = false;
  private mutationTarget: object = this;

  public setMutationTarget(target: object): void {
    this.mutationTarget = target;
  }

  public observeMutations(
    callback: ((records: readonly unknown[]) => void) | undefined,
  ): void {
    this.mutationCallback = callback;
  }

  public insertBefore(node: FakeLink, reference: FakeLink | FakeStyle | null): FakeLink {
    const index = reference === null ? this.nodes.length : this.nodes.indexOf(reference);
    if (index < 0) throw new Error("unknown reference");
    node.parentNode = this;
    this.nodes.splice(index, 0, node);
    this.recordMutation([node], []);
    return node;
  }

  public removeChild(node: FakeLink | FakeStyle): FakeLink | FakeStyle {
    const index = this.nodes.indexOf(node);
    if (index < 0) throw new Error("unknown child");
    this.nodes.splice(index, 1);
    node.parentNode = null;
    this.recordMutation([], [node]);
    return node;
  }

  private recordMutation(
    addedNodes: readonly object[],
    removedNodes: readonly object[],
  ): void {
    if (!this.mutationCallback) return;
    this.mutationRecords.push({
      type: "childList",
      target: this.mutationTarget,
      addedNodes,
      removedNodes,
    });
    if (this.mutationScheduled) return;
    this.mutationScheduled = true;
    queueMicrotask(() => {
      this.mutationScheduled = false;
      const records = this.mutationRecords.splice(0);
      this.mutationCallback?.(records);
    });
  }
}

class FakeLink {
  public readonly tagName = "LINK";
  public readonly textContent = "";
  public readonly sheet: {
    href: string | null;
    cssRules: unknown[];
    disabled: boolean;
    media: { mediaText: string };
    ownerNode: FakeLink;
  };
  public disabled = false;
  public parentNode: FakeParent | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  public constructor(attributes: Attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      this.attributes.set(name, value);
    }
    this.sheet = {
      href: attributes.href ?? null,
      cssRules: [],
      disabled: false,
      media: { mediaText: "" },
      ownerNode: this,
    };
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
    if (name === "href") this.sheet.href = value;
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
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
  public readonly tagName = "STYLE";
  public parentNode: FakeParent | null = null;
}

function pageHarness(baseURI: string, top = true) {
  const parent = new FakeParent();
  const foreignParent = new FakeParent();
  const view: {
    top?: unknown;
    addEventListener: () => void;
    removeEventListener: () => void;
    matchMedia: () => {
      matches: boolean;
      addEventListener: () => void;
      removeEventListener: () => void;
    };
    CSS: { supports: () => boolean };
  } = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
    CSS: { supports: () => true },
  };
  view.top = top ? view : {};
  const document = {
    nodeType: 9,
    baseURI,
    defaultView: view,
    documentElement: { tagName: "HTML" },
    childNodes: parent.nodes,
    adoptedStyleSheets: [] as unknown[],
    get styleSheets() {
      return parent.nodes
        .filter((node): node is FakeLink => node instanceof FakeLink)
        .map((node) => node.sheet);
    },
    querySelectorAll(selector: string) {
      if (selector === "*") return parent.nodes;
      if (selector === "link" || selector.includes("style") || selector.includes("link")) {
        return parent.nodes.filter((node) => (
          node instanceof FakeLink || node instanceof FakeStyle
        ));
      }
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  parent.setMutationTarget(document);
  return {
    document: document as unknown as Document & { adoptedStyleSheets: unknown[] },
    nodes: parent.nodes,
    foreignNodes: foreignParent.nodes,
    observeMutations(callback: ((records: readonly unknown[]) => void) | undefined) {
      parent.observeMutations(callback);
    },
    link(attributes: Attributes) {
      const link = new FakeLink(attributes);
      link.parentNode = parent;
      parent.nodes.push(link);
      return link;
    },
    foreignLink(attributes: Attributes) {
      const link = new FakeLink(attributes);
      link.parentNode = foreignParent;
      foreignParent.nodes.push(link);
      return link;
    },
    moveToForeignParent(link: FakeLink) {
      link.parentNode?.removeChild(link);
      foreignParent.insertBefore(link, null);
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

function liveRegistry(page: ReturnType<typeof pageHarness>): StylesheetRegistry {
  return new StylesheetRegistry({
    document: page.document,
    contentSessionId: "stylesheet-refresh-integration",
    documentEpoch: 1,
    isRuntimeNode: isTransientStylesheetRefreshNode,
    createMutationObserver(callback) {
      page.observeMutations(callback);
      return {
        observe() {},
        disconnect() {
          page.observeMutations(undefined);
        },
      };
    },
  });
}
