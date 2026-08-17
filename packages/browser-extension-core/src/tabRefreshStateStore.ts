import type { SessionStorage } from "./browserWindowLinkStore.js";
import {
  createDefaultTabRefreshState,
  parseTabRefreshState,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";

export const TAB_REFRESH_STATE_STORAGE_KEY = "pin-op.tabRefreshStates";
export const MAX_PERSISTED_TAB_REFRESH_STATES = 4_096;
const LEGACY_TAB_REFRESH_RECOVERY_STORAGE_KEY =
  "pin-op.tabRefreshStateRecovery";
const STORED_STATE_REQUIRED_KEYS = [
  "tabId",
  "windowId",
  "autoRefreshEnabled",
  "ideHighlightEnabled",
  "participant",
  "lastAcceptedGeneration",
] as const;

interface ParsedStoredStates {
  readonly states: readonly TabRefreshState[];
  readonly needsRewrite: boolean;
}

interface ParsedStoredState {
  readonly state: TabRefreshState;
  readonly needsRewrite: boolean;
}

export class TabRefreshStateStore {
  private tail = Promise.resolve();
  private legacyRecoveryClean = false;

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
    const durable = durableState(parsed);
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      const next = states.filter((candidate) => candidate.tabId !== durable.tabId);
      next.push(durable);
      next.sort(compareStates);
      compactStates(next, durable.tabId);
      await this.writeStates(next);
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
      const durable = durableState(parsed);
      const next = states.filter((state) => state.tabId !== tabId);
      next.push(durable);
      next.sort(compareStates);
      compactStates(next, durable.tabId);
      await this.writeStates(next);
      return durable;
    });
  }

  public removeTab(tabId: number): Promise<void> {
    createDefaultTabRefreshState(tabId, 0);
    return this.enqueue(async () => {
      const states = await this.loadAllUnlocked();
      if (!states.some((state) => state.tabId === tabId)) {
        return;
      }
      await this.writeStates(states.filter((state) => state.tabId !== tabId));
    });
  }

  public clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      try {
        await this.storage.remove(LEGACY_TAB_REFRESH_RECOVERY_STORAGE_KEY);
        this.legacyRecoveryClean = true;
      } catch {
        // Legacy cleanup is never required for runtime safety.
      }
    });
  }

  private async loadAllUnlocked(): Promise<readonly TabRefreshState[]> {
    const stored = await this.storage.get(TAB_REFRESH_STATE_STORAGE_KEY);
    const value = ownDataValue(stored, TAB_REFRESH_STATE_STORAGE_KEY);
    if (value === absentValue) {
      await this.cleanupLegacyRecoveryBestEffort();
      return Object.freeze([]);
    }
    const parsed = parseStoredStates(value);
    if (!parsed) {
      try {
        await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      } catch {
        // Invalid durable data is ignored even when cleanup is unavailable.
      }
      await this.cleanupLegacyRecoveryBestEffort();
      return Object.freeze([]);
    }
    if (parsed.needsRewrite) {
      try {
        await this.writeStates(parsed.states);
      } catch {
        // Runtime ownership is already removed from the returned snapshots.
      }
    }
    await this.cleanupLegacyRecoveryBestEffort();
    return parsed.states;
  }

  private async cleanupLegacyRecoveryBestEffort(): Promise<void> {
    if (this.legacyRecoveryClean) {
      return;
    }
    try {
      const stored = await this.storage.get(
        LEGACY_TAB_REFRESH_RECOVERY_STORAGE_KEY,
      );
      if (
        ownDataValue(stored, LEGACY_TAB_REFRESH_RECOVERY_STORAGE_KEY) !==
          absentValue
      ) {
        await this.storage.remove(LEGACY_TAB_REFRESH_RECOVERY_STORAGE_KEY);
      }
      this.legacyRecoveryClean = true;
    } catch {
      // A later operation retries migration cleanup.
    }
  }

  private async writeStates(states: readonly TabRefreshState[]): Promise<void> {
    if (states.length === 0) {
      await this.storage.remove(TAB_REFRESH_STATE_STORAGE_KEY);
      return;
    }
    await this.storage.set({
      [TAB_REFRESH_STATE_STORAGE_KEY]: states.map(snapshotState),
    });
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
    participant: false,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
  };
}

function durableState(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: false,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
  });
}

function parseStoredStates(value: unknown): ParsedStoredStates | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const candidates = value.length > MAX_PERSISTED_TAB_REFRESH_STATES
    ? value.slice(-MAX_PERSISTED_TAB_REFRESH_STATES)
    : value;
  const states: TabRefreshState[] = [];
  const tabIds = new Set<number>();
  let needsRewrite = candidates.length !== value.length;
  for (const candidate of candidates) {
    const parsed = parseStoredState(candidate);
    if (!parsed || tabIds.has(parsed.state.tabId)) {
      return undefined;
    }
    tabIds.add(parsed.state.tabId);
    if (parsed.needsRewrite) {
      needsRewrite = true;
    }
    states.push(parsed.state);
  }
  const beforeSort = states.map((state) => state.tabId);
  states.sort(compareStates);
  if (states.some((state, index) => state.tabId !== beforeSort[index])) {
    needsRewrite = true;
  }
  return Object.freeze({
    states: Object.freeze(states),
    needsRewrite,
  });
}

function parseStoredState(value: unknown): ParsedStoredState | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      (keys.length !== STORED_STATE_REQUIRED_KEYS.length &&
        keys.length !== STORED_STATE_REQUIRED_KEYS.length + 1) ||
      STORED_STATE_REQUIRED_KEYS.some((key) => !keys.includes(key)) ||
      (keys.length === STORED_STATE_REQUIRED_KEYS.length + 1 &&
        !keys.includes("pending"))
    ) {
      return undefined;
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const holder = Object.getOwnPropertyDescriptor(descriptors, key);
      const descriptor = holder?.value as PropertyDescriptor | undefined;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        return undefined;
      }
      record[key] = descriptor.value;
    }
    const normalized = parseTabRefreshState({
      tabId: record.tabId,
      windowId: record.windowId,
      autoRefreshEnabled: record.autoRefreshEnabled,
      ideHighlightEnabled: record.ideHighlightEnabled,
      participant: false,
      lastAcceptedGeneration: record.lastAcceptedGeneration,
    });
    return normalized
      ? Object.freeze({
          state: durableState(normalized),
          needsRewrite: record.participant !== false || keys.includes("pending"),
        })
      : undefined;
  } catch {
    return undefined;
  }
}

function compareStates(left: TabRefreshState, right: TabRefreshState): number {
  return left.tabId - right.tabId;
}

function compactStates(states: TabRefreshState[], retainedTabId: number): void {
  while (states.length > MAX_PERSISTED_TAB_REFRESH_STATES) {
    const orphanIndex = states.findIndex(
      (state) => state.tabId !== retainedTabId,
    );
    if (orphanIndex < 0) {
      return;
    }
    states.splice(orphanIndex, 1);
  }
}
