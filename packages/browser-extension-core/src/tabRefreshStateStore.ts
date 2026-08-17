import type { SessionStorage } from "./browserWindowLinkStore.js";
import {
  createDefaultTabRefreshState,
  parseTabRefreshState,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";

export const TAB_REFRESH_STATE_STORAGE_KEY = "pin-op.tabRefreshStates";
export const MAX_PERSISTED_TAB_REFRESH_STATES = 4_096;
const TAB_REFRESH_STATE_RECOVERY_STORAGE_KEY =
  "pin-op.tabRefreshStateRecovery";

// The coordinator finalizer keeps the guarded tab lifecycle stable while the
// terminal journal is committed. One store instance owns writes per runtime.
type RemovalFinalizer = <T>(operation: () => Promise<T>) => Promise<T>;

export class TabRefreshStateStore {
  private tail = Promise.resolve();
  private recoveryKnownClear = false;

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
    return this.updateTabWithPersistence(tabId, update, false);
  }

  public updateTabDurably(
    tabId: number,
    update: (
      current: TabRefreshState | undefined,
    ) => TabRefreshState | undefined,
  ): Promise<TabRefreshState | undefined> {
    return this.updateTabWithPersistence(tabId, update, true);
  }

  private updateTabWithPersistence(
    tabId: number,
    update: (
      current: TabRefreshState | undefined,
    ) => TabRefreshState | undefined,
    durable: boolean,
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
      if (durable) {
        await this.writeForward(next);
      } else {
        await this.storage.set({
          [TAB_REFRESH_STATE_STORAGE_KEY]: next.map(snapshotState),
        });
      }
      return parsed;
    });
  }

  public removeTab(
    tabId: number,
    canRemove: (current: TabRefreshState) => boolean = alwaysRemove,
    finalize: RemovalFinalizer = finalizeImmediately,
  ): Promise<void> {
    createDefaultTabRefreshState(tabId, 0);
    if (typeof canRemove !== "function") {
      return Promise.reject(new TypeError("Invalid tab removal guard"));
    }
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const current = states.find((state) => state.tabId === tabId);
      if (!current || !canRemove(current)) {
        return;
      }
      await this.commitGuardedRemoval(
        states,
        current,
        states.filter((state) => state.tabId !== tabId),
        canRemove,
        finalize,
      );
    });
  }

  public removeTabFromWindow(
    tabId: number,
    windowId: number,
    canRemove: (current: TabRefreshState) => boolean = alwaysRemove,
    finalize: RemovalFinalizer = finalizeImmediately,
  ): Promise<TabRefreshState | undefined> {
    createDefaultTabRefreshState(tabId, windowId);
    if (typeof canRemove !== "function") {
      return Promise.reject(new TypeError("Invalid tab removal guard"));
    }
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const current = states.find((state) => state.tabId === tabId);
      if (current?.windowId !== windowId || !canRemove(current)) {
        return undefined;
      }
      const removed = await this.commitGuardedRemoval(
        states,
        current,
        states.filter((state) => state.tabId !== tabId),
        canRemove,
        finalize,
      );
      return removed ? current : undefined;
    });
  }

  public removeWindow(windowId: number): Promise<void> {
    createDefaultTabRefreshState(0, windowId);
    return this.removeMatching((state) => state.windowId === windowId);
  }

  public clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.clearRecovery();
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
    });
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
      await this.writeStates(next);
    });
  }

  private async writeStates(
    states: readonly TabRefreshState[],
  ): Promise<void> {
    if (states.length === 0) {
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      return;
    }
    await this.storage.set({
      [TAB_REFRESH_STATE_STORAGE_KEY]: states.map(snapshotState),
    });
  }

  private async commitGuardedRemoval(
    states: readonly TabRefreshState[],
    current: TabRefreshState,
    committed: readonly TabRefreshState[],
    canRemove: (current: TabRefreshState) => boolean,
    finalize: RemovalFinalizer,
  ): Promise<boolean> {
    const fallback = states.map((state) =>
      state.tabId === current.tabId ? failClosedState(state) : state);
    await this.writeRecovery(fallback);
    await this.writeStates(committed);

    let removalStillCurrent: boolean;
    try {
      removalStillCurrent = canRemove(current);
    } catch (error) {
      await this.restoreRecovery(fallback);
      throw error;
    }
    if (!removalStillCurrent) {
      await this.restoreRecovery(fallback);
      return false;
    }

    // Promote the fallback before clearing speculative recovery. This keeps
    // every crash point fail-closed until finalization owns the tab lifecycle.
    await this.writeStates(fallback);
    await this.writeRecovery(fallback);
    await this.clearRecovery();
    if (!canRemove(current)) {
      return false;
    }

    return finalize(async () => {
      if (!canRemove(current)) {
        return false;
      }
      await this.writeRecovery(fallback);
      await this.writeStates(committed);
      await this.clearRecovery();
      return true;
    });
  }

  private async restoreRecovery(
    states: readonly TabRefreshState[],
  ): Promise<void> {
    await this.writeStates(states);
    await this.clearRecovery();
  }

  private async writeRecovery(
    states: readonly TabRefreshState[],
  ): Promise<void> {
    this.recoveryKnownClear = false;
    await this.storage.set({
      [TAB_REFRESH_STATE_RECOVERY_STORAGE_KEY]: states.map(snapshotState),
    });
  }

  private async writeForward(
    states: readonly TabRefreshState[],
  ): Promise<void> {
    await this.writeRecovery(states);
    await this.writeStates(states);
    await this.clearRecovery();
  }

  private async recoverPendingWriteUnlocked(): Promise<void> {
    if (this.recoveryKnownClear) {
      return;
    }
    const stored = await this.storage.get(
      TAB_REFRESH_STATE_RECOVERY_STORAGE_KEY,
    );
    const value = ownDataValue(
      stored,
      TAB_REFRESH_STATE_RECOVERY_STORAGE_KEY,
    );
    if (value === absentValue) {
      this.recoveryKnownClear = true;
      return;
    }
    const states = parseStoredStates(value);
    if (!states) {
      const primary = await this.storage.get(TAB_REFRESH_STATE_STORAGE_KEY);
      const primaryValue = ownDataValue(
        primary,
        TAB_REFRESH_STATE_STORAGE_KEY,
      );
      if (primaryValue !== absentValue) {
        const primaryStates = parseStoredStates(primaryValue);
        if (primaryStates) {
          await this.writeStates(primaryStates.map(failClosedState));
        } else {
          await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
        }
      }
      await this.clearRecovery();
      throw new Error("Invalid tab refresh recovery journal");
    }
    await this.writeStates(states);
    await this.clearRecovery();
  }

  private async clearRecovery(): Promise<void> {
    this.recoveryKnownClear = false;
    await this.storage.remove(TAB_REFRESH_STATE_RECOVERY_STORAGE_KEY);
    this.recoveryKnownClear = true;
  }

  private async loadAllUnlocked(): Promise<readonly TabRefreshState[]> {
    await this.recoverPendingWriteUnlocked();
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
    const states = parseStoredStates(value);
    if (!states) {
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      return Object.freeze([]);
    }
    return states;
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
const alwaysRemove = () => true;
const finalizeImmediately: RemovalFinalizer = (operation) => operation();

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

function failClosedState(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: false,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
  });
}

function parseStoredStates(
  value: unknown,
): readonly TabRefreshState[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PERSISTED_TAB_REFRESH_STATES
  ) {
    return undefined;
  }
  const states: TabRefreshState[] = [];
  const tabIds = new Set<number>();
  for (const candidate of value) {
    const parsed = parseTabRefreshState(candidate);
    if (!parsed || tabIds.has(parsed.tabId)) {
      return undefined;
    }
    tabIds.add(parsed.tabId);
    states.push(parsed);
  }
  states.sort(compareStates);
  return Object.freeze(states);
}

function compareStates(left: TabRefreshState, right: TabRefreshState): number {
  return left.tabId - right.tabId;
}
