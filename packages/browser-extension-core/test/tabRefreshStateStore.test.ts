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
    expect(storage.remove).toHaveBeenLastCalledWith(
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
    await expect(store.loadAll()).resolves.toEqual([state(11, 7)]);
  });

  it("fails closed a valid primary state before reporting a malformed recovery journal", async () => {
    const primary = {
      ...state(11, 7),
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 9,
      pending: { generation: 9, mode: "reload" as const },
    };
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [primary],
      "pin-op.tabRefreshStateRecovery": { malformed: true },
    });
    const store = new TabRefreshStateStore(storage);

    await expect(store.loadAll()).rejects.toThrow(
      "Invalid tab refresh recovery journal",
    );
    expect(storage.value("pin-op.tabRefreshStates")).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 9,
    }]);
    expect(storage.value("pin-op.tabRefreshStateRecovery")).toBeUndefined();
    await expect(store.loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 9,
    }]);
  });

  it("retries malformed recovery cleanup without defaulting on after a failed fail-closed write", async () => {
    const storage = memoryStorage({
      "pin-op.tabRefreshStates": [{
        ...state(11, 7),
        autoRefreshEnabled: false,
        ideHighlightEnabled: false,
        participant: false,
        lastAcceptedGeneration: 6,
      }],
      "pin-op.tabRefreshStateRecovery": "corrupt",
    });
    storage.failNextSetFor("pin-op.tabRefreshStates");

    await expect(new TabRefreshStateStore(storage).loadAll()).rejects.toThrow(
      "transient storage set failure",
    );
    expect(storage.value("pin-op.tabRefreshStateRecovery")).toBe("corrupt");

    const replacement = new TabRefreshStateStore(storage);
    await expect(replacement.loadAll()).rejects.toThrow(
      "Invalid tab refresh recovery journal",
    );
    await expect(replacement.loadAll()).resolves.toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 6,
    }]);
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
