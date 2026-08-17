import type { SessionStorage } from "./browserWindowLinkStore.js";
import {
  createDefaultTabRefreshState,
  parseTabRefreshState,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";

export const TAB_REFRESH_STATE_STORAGE_KEY = "pin-op.tabRefreshStates";
export const MAX_PERSISTED_TAB_REFRESH_STATES = 4_096;

export class TabRefreshStateStore {
  private tail = Promise.resolve();

  public constructor(private readonly storage: SessionStorage) {}

  public load(tabId: number, windowId: number): Promise<TabRefreshState> {
    const defaults = createDefaultTabRefreshState(tabId, windowId);
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      return states.find(
        (state) => state.tabId === tabId && state.windowId === windowId,
      ) ?? defaults;
    });
  }

  public loadAll(): Promise<readonly TabRefreshState[]> {
    return this.enqueue(() => this.loadAllUnlocked());
  }

  public save(state: TabRefreshState): Promise<void> {
    const parsed = parseTabRefreshState(state);
    if (!parsed) {
      return Promise.reject(new TypeError("Invalid browser tab refresh state"));
    }
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const next = states.filter((candidate) => candidate.tabId !== parsed.tabId);
      next.push(parsed);
      next.sort(compareStates);
      if (next.length > MAX_PERSISTED_TAB_REFRESH_STATES) {
        throw new RangeError("Too many browser tab refresh states");
      }
      await this.storage.set({
        [TAB_REFRESH_STATE_STORAGE_KEY]: next.map(snapshotState),
      });
    });
  }

  public updateTab(
    tabId: number,
    update: (
      current: TabRefreshState | undefined,
    ) => TabRefreshState | undefined,
  ): Promise<TabRefreshState | undefined> {
    createDefaultTabRefreshState(tabId, 0);
    if (typeof update !== "function") {
      return Promise.reject(new TypeError("Invalid tab refresh state updater"));
    }
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const current = states.find((state) => state.tabId === tabId);
      const candidate = update(current);
      if (candidate === undefined) {
        return current;
      }
      const parsed = parseTabRefreshState(candidate);
      if (!parsed || parsed.tabId !== tabId) {
        throw new TypeError("Invalid browser tab refresh state update");
      }
      const next = states.filter((state) => state.tabId !== tabId);
      next.push(parsed);
      next.sort(compareStates);
      if (next.length > MAX_PERSISTED_TAB_REFRESH_STATES) {
        throw new RangeError("Too many browser tab refresh states");
      }
      await this.storage.set({
        [TAB_REFRESH_STATE_STORAGE_KEY]: next.map(snapshotState),
      });
      return parsed;
    });
  }

  public removeTab(tabId: number): Promise<void> {
    createDefaultTabRefreshState(tabId, 0);
    return this.removeMatching((state) => state.tabId === tabId);
  }

  public removeWindow(windowId: number): Promise<void> {
    createDefaultTabRefreshState(0, windowId);
    return this.removeMatching((state) => state.windowId === windowId);
  }

  public clear(): Promise<void> {
    return this.enqueue(() => this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY));
  }

  private removeMatching(
    predicate: (state: TabRefreshState) => boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const next = states.filter((state) => !predicate(state));
      if (next.length === states.length) {
        return;
      }
      if (next.length === 0) {
        await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
        return;
      }
      await this.storage.set({
        [TAB_REFRESH_STATE_STORAGE_KEY]: next.map(snapshotState),
      });
    });
  }

  private async loadAllUnlocked(): Promise<readonly TabRefreshState[]> {
    let stored: Record<string, unknown>;
    try {
      stored = await this.storage.get(TAB_REFRESH_STATE_STORAGE_KEY);
    } catch (error) {
      throw error;
    }
    const value = ownDataValue(stored, TAB_REFRESH_STATE_STORAGE_KEY);
    if (value === absentValue) {
      return Object.freeze([]);
    }
    if (
      !Array.isArray(value) ||
      value.length > MAX_PERSISTED_TAB_REFRESH_STATES
    ) {
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      return Object.freeze([]);
    }
    const states: TabRefreshState[] = [];
    const tabIds = new Set<number>();
    for (const candidate of value) {
      const parsed = parseTabRefreshState(candidate);
      if (!parsed || tabIds.has(parsed.tabId)) {
        await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
        return Object.freeze([]);
      }
      tabIds.add(parsed.tabId);
      states.push(parsed);
    }
    states.sort(compareStates);
    return Object.freeze(states);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const absentValue = Symbol("pin-op.absentTabRefreshState");

function ownDataValue(
  value: unknown,
  key: string,
): unknown | typeof absentValue {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return absentValue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return absentValue;
    }
    return Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : absentValue;
  } catch {
    return absentValue;
  }
}

function snapshotState(state: TabRefreshState): Record<string, unknown> {
  return {
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: state.participant,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
    ...(state.pending
      ? {
          pending: {
            generation: state.pending.generation,
            mode: state.pending.mode,
          },
        }
      : {}),
  };
}

function compareStates(left: TabRefreshState, right: TabRefreshState): number {
  return left.tabId - right.tabId;
}
