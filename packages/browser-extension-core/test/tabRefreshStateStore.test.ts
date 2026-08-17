import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import {
  MAX_PERSISTED_TAB_REFRESH_STATES,
  TabRefreshStateStore,
} from "../src/tabRefreshStateStore.js";

describe("TabRefreshStateStore", () => {
  it("persists only preferences and generation across store instances", async () => {
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
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 4,
    });
    expect(storage.value("pin-op.tabRefreshStates")).toEqual([{
      ...defaults,
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 4,
    }]);
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

  it("updates one tab atomically from its latest persisted state", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await store.save({
      ...state(11, 7),
      lastAcceptedGeneration: 4,
      pending: { generation: 4, mode: "reload" },
    });

    const updated = await store.updateTab(11, (current) => current
      ? {
          ...current,
          participant: false,
          pending: undefined,
        }
      : undefined);

    expect(updated).toMatchObject({
      tabId: 11,
      autoRefreshEnabled: true,
      participant: false,
      lastAcceptedGeneration: 4,
    });
    expect(updated).not.toHaveProperty("pending");
    expect(await store.load(11, 7)).toEqual(updated);
  });

  it("removes terminal tabs and finally the storage key", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    await store.save(state(11, 7));
    await store.save(state(12, 7));
    await store.save(state(21, 8));

    await store.removeTab(11);
    expect((await store.loadAll()).map(({ tabId }) => tabId)).toEqual([12, 21]);
    await store.removeTab(12);
    expect((await store.loadAll()).map(({ tabId }) => tabId)).toEqual([21]);
    await store.removeTab(21);
    expect(await store.loadAll()).toEqual([]);
    expect(storage.remove).toHaveBeenCalledWith("pin-op.tabRefreshStates");
    expect(storage.remove).not.toHaveBeenCalledWith(
      "pin-op.tabRefreshStateRecovery",
    );
  });

  it("recovers a fail-closed snapshot when terminal deletion fails", async () => {
    const storage = memoryStorage();
    const store = new TabRefreshStateStore(storage);
    const current = {
      ...state(11, 8),
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 6,
      pending: { generation: 6, mode: "reload" as const },
    } as const;
    await store.save(current);
    storage.failNextRemoveFor("pin-op.tabRefreshStates");

    await expect(store.removeTab(11)).rejects.toThrow(
      "transient storage remove failure",
    );

    const replacement = new TabRefreshStateStore(storage);
    expect(await replacement.loadAll()).toEqual([{
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 6,
    }]);
    await replacement.removeTab(11);
    expect(await replacement.loadAll()).toEqual([]);
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

  it("continues serial storage work after a transient read failure", async () => {
    const storage = transientReadFailureStorage({
      "pin-op.tabRefreshStates": [state(11, 7)],
    });
    const store = new TabRefreshStateStore(storage);

    await expect(store.loadAll()).rejects.toThrow("transient storage failure");
    await expect(store.loadAll()).resolves.toEqual([{
      ...state(11, 7),
      participant: false,
    }]);
  });

  it("normalizes stale runtime ownership even when the compaction write fails", async () => {
    const stale = {
      ...state(11, 7),
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 9,
      pending: { generation: 9, mode: "reload" as const },
    };
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [stale],
    });
    storage.failNextSetFor("pin-op.tabRefreshStates");
    const store = new TabRefreshStateStore(storage);

    await expect(store.loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 9,
    }]);
    expect(storage.value("pin-op.tabRefreshStates")).toEqual([stale]);

    const replacement = new TabRefreshStateStore(storage);
    await expect(replacement.loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 9,
    }]);
  });

  it("preserves preferences while discarding malformed legacy runtime fields", async () => {
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [{
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: false,
        ideHighlightEnabled: false,
        participant: "stale-owner",
        lastAcceptedGeneration: 8,
        pending: { malformed: true },
      }],
    });

    await expect(new TabRefreshStateStore(storage).loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 8,
    }]);
  });

  it("ignores and removes a legacy recovery journal without trusting it", async () => {
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [{
        ...state(11, 7),
        autoRefreshEnabled: false,
        ideHighlightEnabled: false,
        participant: false,
        lastAcceptedGeneration: 6,
      }],
      "pin-op.tabRefreshStateRecovery": [{
        ...state(11, 7),
        lastAcceptedGeneration: 99,
      }],
    });

    await expect(new TabRefreshStateStore(storage).loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 6,
    }]);
    expect(storage.value("pin-op.tabRefreshStateRecovery")).toBeUndefined();
  });

  it("compacts orphan preference snapshots to the startup bound", async () => {
    const stored = Array.from(
      { length: MAX_PERSISTED_TAB_REFRESH_STATES + 2 },
      (_, index) => ({
        ...state(index + 1, 7),
        participant: false,
      }),
    );
    const storage = memoryStorage({ "pin-op.tabRefreshStates": stored });

    const loaded = await new TabRefreshStateStore(storage).loadAll();

    expect(loaded).toHaveLength(MAX_PERSISTED_TAB_REFRESH_STATES);
    expect(loaded[0]?.tabId).toBe(3);
    expect(storage.value("pin-op.tabRefreshStates")).toEqual(loaded);
  });

  it("evicts an orphan preference instead of blocking a new tab at the bound", async () => {
    const stored = Array.from(
      { length: MAX_PERSISTED_TAB_REFRESH_STATES },
      (_, index) => ({
        ...state(index + 1, 7),
        participant: false,
      }),
    );
    const storage = memoryStorage({ "pin-op.tabRefreshStates": stored });
    const store = new TabRefreshStateStore(storage);

    await expect(store.save(state(
      MAX_PERSISTED_TAB_REFRESH_STATES + 1,
      7,
    ))).resolves.toBeUndefined();

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(MAX_PERSISTED_TAB_REFRESH_STATES);
    expect(loaded.some(({ tabId }) => tabId === 1)).toBe(false);
    expect(loaded.some(
      ({ tabId }) => tabId === MAX_PERSISTED_TAB_REFRESH_STATES + 1,
    )).toBe(true);
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
  failNextSetFor(key: string): void;
  failNextRemoveFor(key: string): void;
  value(key: string): unknown;
} {
  const values = new Map(Object.entries(initial));
  let failedSetKey: string | undefined;
  let failedRemoveKey: string | undefined;
  return {
    async get(key: string) {
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    set: vi.fn(async (records: Record<string, unknown>) => {
      if (failedSetKey && Object.hasOwn(records, failedSetKey)) {
        failedSetKey = undefined;
        throw new Error("transient storage set failure");
      }
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    }),
    remove: vi.fn(async (key: string) => {
      if (failedRemoveKey === key) {
        failedRemoveKey = undefined;
        throw new Error("transient storage remove failure");
      }
      values.delete(key);
    }),
    failNextSetFor(key: string) {
      failedSetKey = key;
    },
    failNextRemoveFor(key: string) {
      failedRemoveKey = key;
    },
    value(key: string) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
  };
}

function transientReadFailureStorage(
  initial: Record<string, unknown>,
): SessionStorage {
  const storage = memoryStorage(initial);
  let failed = false;
  return {
    async get(key: string) {
      if (!failed) {
        failed = true;
        throw new Error("transient storage failure");
      }
      return storage.get(key);
    },
    set: (records) => storage.set(records),
    remove: (key) => storage.remove(key),
  };
}
