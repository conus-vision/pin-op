import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import { TabRefreshStateStore } from "../src/tabRefreshStateStore.js";

describe("TabRefreshStateStore", () => {
  it("returns default-on tab-local state and persists it across store instances", async () => {
    const storage = memoryStorage();
    const first = new TabRefreshStateStore(storage);

    const defaults = await first.load(11, 7);
    expect(defaults).toEqual({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 0,
    });

    await first.save({
      ...defaults,
      participant: true,
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 4,
      pending: { generation: 4, mode: "styles" },
    });
    const replacement = new TabRefreshStateStore(storage);
    expect(await replacement.load(11, 7)).toEqual({
      ...defaults,
      participant: true,
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 4,
      pending: { generation: 4, mode: "styles" },
    });
  });

  it("rejects the complete persisted collection instead of partially trusting it", async () => {
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [
        {
          tabId: 11,
          windowId: 7,
          autoRefreshEnabled: false,
          ideHighlightEnabled: false,
          participant: false,
          lastAcceptedGeneration: 20,
        },
        {
          tabId: 12,
          windowId: 7,
          autoRefreshEnabled: true,
          ideHighlightEnabled: true,
          participant: true,
          lastAcceptedGeneration: 20,
          source: "must-not-survive",
        },
      ],
    });
    const store = new TabRefreshStateStore(storage);

    expect(await store.load(11, 7)).toEqual({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 0,
    });
    expect(storage.remove).toHaveBeenCalledWith("pin-op.tabRefreshStates");
    expect(await store.loadAll()).toEqual([]);
  });

  it("serializes concurrent saves without losing another tab", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await Promise.all([
      store.save({
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        participant: true,
        lastAcceptedGeneration: 1,
      }),
      store.save({
        tabId: 12,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        participant: true,
        lastAcceptedGeneration: 1,
      }),
    ]);

    expect(await store.loadAll()).toEqual([
      expect.objectContaining({ tabId: 11 }),
      expect.objectContaining({ tabId: 12 }),
    ]);
  });

  it("removes a tab, a window, and finally the storage key", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await store.save(state(11, 7));
    await store.save(state(12, 7));
    await store.save(state(21, 8));

    await store.removeTab(11);
    expect((await store.loadAll()).map(({ tabId }) => tabId)).toEqual([12, 21]);
    await store.removeWindow(7);
    expect((await store.loadAll()).map(({ tabId }) => tabId)).toEqual([21]);
    await store.removeWindow(8);
    expect(await store.loadAll()).toEqual([]);
    expect(storage.remove).toHaveBeenLastCalledWith("pin-op.tabRefreshStates");
  });

  it("rejects invalid state before writing", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await expect(
      store.save({ ...state(11, 7), tabId: -1 }),
    ).rejects.toThrow();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("does not return a tab state through a different window binding", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await store.save({
      ...state(11, 7),
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });

    expect(await store.load(11, 8)).toEqual({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 0,
    });
  });
});

function state(tabId: number, windowId: number) {
  return {
    tabId,
    windowId,
    autoRefreshEnabled: true,
    ideHighlightEnabled: true,
    participant: true,
    lastAcceptedGeneration: 0,
  } as const;
}

function memoryStorage(initial: Record<string, unknown> = {}): SessionStorage & {
  readonly remove: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  const values = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    set: vi.fn(async (records: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}
