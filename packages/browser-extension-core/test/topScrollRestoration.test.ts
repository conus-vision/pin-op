import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTopScrollSnapshot,
  MAX_TOP_SCROLL_COORDINATE,
  parseTopScrollSnapshot,
  restoreTopScrollSnapshot,
  TOP_SCROLL_RESTORE_DELAY_MS,
  TOP_SCROLL_SNAPSHOT_TTL_MS,
  TopScrollSnapshotLeaseStore,
  type TopScrollSnapshot,
  type TopScrollSnapshotStorage,
} from "../src/topScrollRestoration.js";

describe("top scroll snapshots", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures a normalized, bounded, immutable data-only snapshot", () => {
    const snapshot = captureTopScrollSnapshot({
      tabId: 12,
      url: "HTTPS://Example.TEST:443/a/../page?q=1#section",
      refreshGeneration: 9,
      scrollX: -10,
      scrollY: Number.MAX_VALUE,
      createdAt: 1_000,
    });

    expect(snapshot).toEqual({
      tabId: 12,
      url: "https://example.test/page?q=1#section",
      refreshGeneration: 9,
      scrollX: 0,
      scrollY: MAX_TOP_SCROLL_COORDINATE,
      createdAt: 1_000,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("rejects malformed snapshots and unsupported page identities", () => {
    const valid = snapshot();
    expect(parseTopScrollSnapshot(valid)).toEqual(valid);
    expect(parseTopScrollSnapshot({ ...valid, extra: true })).toBeUndefined();
    expect(parseTopScrollSnapshot({ ...valid, scrollX: Number.NaN })).toBeUndefined();
    expect(parseTopScrollSnapshot({ ...valid, scrollY: -1 })).toBeUndefined();
    expect(parseTopScrollSnapshot({ ...valid, tabId: -1 })).toBeUndefined();
    expect(parseTopScrollSnapshot({ ...valid, url: "data:text/html,test" })).toBeUndefined();
    expect(() => captureTopScrollSnapshot({
      ...valid,
      url: "https://user:secret@example.test/page",
    })).toThrow(TypeError);
    expect(() => captureTopScrollSnapshot({
      tabId: 1,
      url: "https://example.test/",
      refreshGeneration: 1,
      scrollX: Number.NaN,
      scrollY: 0,
      createdAt: 0,
    })).toThrow(TypeError);

    const getter = vi.fn(() => 10);
    const hostile = { ...valid } as Record<string, unknown>;
    Object.defineProperty(hostile, "scrollX", { enumerable: true, get: getter });
    expect(parseTopScrollSnapshot(hostile)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("leases once only for the exact tab, normalized URL, and generation", async () => {
    const storage = memoryStorage();
    const leases = new TopScrollSnapshotLeaseStore(storage);
    const saved = snapshot({ createdAt: 500 });
    await leases.persist(saved);

    await expect(leases.claim({
      tabId: saved.tabId,
      url: "https://EXAMPLE.test:443/page",
      refreshGeneration: saved.refreshGeneration,
      now: 1_000,
    })).resolves.toEqual(saved);
    await expect(leases.claim({
      tabId: saved.tabId,
      url: saved.url,
      refreshGeneration: saved.refreshGeneration,
      now: 1_000,
    })).resolves.toBeUndefined();
    expect(storage.remove).toHaveBeenCalledOnce();
  });

  it("rejects and consumes mismatched, expired, future, and malformed stored data", async () => {
    const cases: Array<{
      stored: unknown;
      claim?: Partial<{ tabId: number; url: string; refreshGeneration: number; now: number }>;
      removed?: boolean;
    }> = [
      { stored: snapshot(), claim: { tabId: 8 }, removed: false },
      { stored: snapshot(), claim: { url: "https://example.test/other" } },
      { stored: snapshot(), claim: { refreshGeneration: 8 } },
      {
        stored: snapshot({ createdAt: 1_000 }),
        claim: { now: 1_000 + TOP_SCROLL_SNAPSHOT_TTL_MS + 1 },
      },
      { stored: snapshot({ createdAt: 2_000 }), claim: { now: 1_000 } },
      { stored: { untrusted: true } },
    ];

    for (const testCase of cases) {
      const storage = memoryStorage(testCase.stored);
      const leases = new TopScrollSnapshotLeaseStore(storage);
      await expect(leases.claim({
        tabId: testCase.claim?.tabId ?? 7,
        url: testCase.claim?.url ?? "https://example.test/page",
        refreshGeneration: testCase.claim?.refreshGeneration ?? 9,
        now: testCase.claim?.now ?? 1_500,
      })).resolves.toBeUndefined();
      expect(storage.remove).toHaveBeenCalledTimes(testCase.removed === false ? 0 : 1);
    }
  });
});

describe("restoreTopScrollSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores only top-level scroll at DOMContentLoaded, load, and 250ms with current clamping", async () => {
    vi.useFakeTimers();
    const page = restoreHarness({
      readyState: "loading",
      scrollWidth: 900,
      scrollHeight: 1_100,
      clientWidth: 300,
      clientHeight: 400,
    });
    const restoring = restoreTopScrollSnapshot(
      snapshot({ scrollX: 800, scrollY: 900 }),
      page.host,
    );

    expect(page.scrolls).toEqual([]);
    page.emitDocument("DOMContentLoaded");
    expect(page.scrolls).toEqual([{ x: 600, y: 700 }]);

    page.dimensions.scrollWidth = 1_300;
    page.dimensions.scrollHeight = 1_600;
    page.emitWindow("load");
    expect(page.scrolls).toEqual([
      { x: 600, y: 700 },
      { x: 800, y: 900 },
    ]);

    page.dimensions.scrollWidth = 700;
    page.dimensions.scrollHeight = 800;
    await vi.advanceTimersByTimeAsync(TOP_SCROLL_RESTORE_DELAY_MS);
    expect(page.scrolls).toEqual([
      { x: 600, y: 700 },
      { x: 800, y: 900 },
      { x: 400, y: 400 },
    ]);
    expect(page.documentListenerCount()).toBe(0);
    expect(page.windowListenerCount()).toBe(0);
    restoring.dispose();
  });

  it("handles already-fired lifecycle events and keeps all three attempts nonfatal", async () => {
    vi.useFakeTimers();
    const page = restoreHarness({
      readyState: "complete",
      scrollWidth: 500,
      scrollHeight: 600,
      clientWidth: 100,
      clientHeight: 100,
      throwScrolls: 2,
    });

    expect(() => restoreTopScrollSnapshot(snapshot(), page.host)).not.toThrow();
    expect(page.scrollAttemptCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(TOP_SCROLL_RESTORE_DELAY_MS);
    expect(page.scrollAttemptCount()).toBe(3);
    expect(page.scrolls).toEqual([{ x: 10, y: 20 }]);
    await vi.runAllTimersAsync();
    expect(page.scrollAttemptCount()).toBe(3);
  });

  it("never restores negative coordinates when the viewport exceeds the document", async () => {
    vi.useFakeTimers();
    const page = restoreHarness({
      readyState: "complete",
      scrollWidth: 100,
      scrollHeight: 100,
      clientWidth: 500,
      clientHeight: 600,
    });

    restoreTopScrollSnapshot(snapshot(), page.host);
    await vi.advanceTimersByTimeAsync(TOP_SCROLL_RESTORE_DELAY_MS);

    expect(page.scrolls).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("falls back to three nonfatal attempts when lifecycle listener hooks are hostile", async () => {
    vi.useFakeTimers();
    const page = restoreHarness({
      readyState: "loading",
      scrollWidth: 500,
      scrollHeight: 600,
      clientWidth: 100,
      clientHeight: 100,
      throwDocumentAdd: true,
      throwWindowAdd: true,
    });

    expect(() => restoreTopScrollSnapshot(snapshot(), page.host)).not.toThrow();
    expect(page.scrollAttemptCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(TOP_SCROLL_RESTORE_DELAY_MS);
    expect(page.scrollAttemptCount()).toBe(3);
    expect(page.documentListenerCount()).toBe(0);
    expect(page.windowListenerCount()).toBe(0);
  });
});

function snapshot(overrides: Partial<TopScrollSnapshot> = {}): TopScrollSnapshot {
  return Object.freeze({
    tabId: 7,
    url: "https://example.test/page",
    refreshGeneration: 9,
    scrollX: 10,
    scrollY: 20,
    createdAt: 1_000,
    ...overrides,
  });
}

function memoryStorage(initial?: unknown) {
  const values = new Map<number, unknown>();
  if (initial !== undefined) values.set(7, initial);
  return {
    read: vi.fn(async (tabId: number) => values.get(tabId)),
    write: vi.fn(async (value: TopScrollSnapshot) => {
      values.set(value.tabId, value);
    }),
    remove: vi.fn(async (tabId: number) => {
      values.delete(tabId);
    }),
  } satisfies TopScrollSnapshotStorage;
}

function restoreHarness(input: {
  readyState: DocumentReadyState;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  throwScrolls?: number;
  throwDocumentAdd?: boolean;
  throwWindowAdd?: boolean;
}) {
  const documentListeners = new Map<string, Set<EventListener>>();
  const windowListeners = new Map<string, Set<EventListener>>();
  const dimensions = {
    scrollWidth: input.scrollWidth,
    scrollHeight: input.scrollHeight,
    clientWidth: input.clientWidth,
    clientHeight: input.clientHeight,
  };
  const scrolls: Array<{ x: number; y: number }> = [];
  let attempts = 0;
  const add = (map: Map<string, Set<EventListener>>, type: string, listener: EventListener) => {
    const listeners = map.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    map.set(type, listeners);
  };
  const remove = (map: Map<string, Set<EventListener>>, type: string, listener: EventListener) => {
    map.get(type)?.delete(listener);
  };
  const document = {
    readyState: input.readyState,
    documentElement: dimensions,
    body: dimensions,
    addEventListener(type: string, listener: EventListener) {
      if (input.throwDocumentAdd) throw new Error("document listener blocked");
      add(documentListeners, type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      remove(documentListeners, type, listener);
    },
  };
  const view: Record<string, unknown> & {
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    scrollTo(x: number, y: number): void;
  } = {
    addEventListener(type: string, listener: EventListener) {
      if (input.throwWindowAdd) throw new Error("window listener blocked");
      add(windowListeners, type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      remove(windowListeners, type, listener);
    },
    scrollTo(x: number, y: number) {
      attempts += 1;
      if (attempts <= (input.throwScrolls ?? 0)) throw new Error("scroll blocked");
      scrolls.push({ x, y });
    },
  };
  view.top = view;
  const emit = (map: Map<string, Set<EventListener>>, type: string) => {
    for (const listener of [...(map.get(type) ?? [])]) listener({ type } as Event);
  };
  return {
    host: {
      document: document as unknown as Document,
      view: view as unknown as Window,
    },
    dimensions,
    scrolls,
    scrollAttemptCount: () => attempts,
    emitDocument: (type: string) => emit(documentListeners, type),
    emitWindow: (type: string) => emit(windowListeners, type),
    documentListenerCount: () => [...documentListeners.values()].reduce((sum, set) => sum + set.size, 0),
    windowListenerCount: () => [...windowListeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
