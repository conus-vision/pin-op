import {
  PageRefreshMessageSchema,
  type PageRefreshMessage,
  type PageRefreshMode,
} from "@pin-op/protocol";
import {
  createDefaultTabRefreshState,
  type RefreshExecutionCommand,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";
import { TabRefreshStateStore } from "./tabRefreshStateStore.js";

export interface TabRefreshSettings {
  readonly autoRefreshEnabled: boolean;
  readonly ideHighlightEnabled: boolean;
}

export interface TabRefreshCoordinatorOptions {
  readonly store: TabRefreshStateStore;
  readonly getActiveTabId: (windowId: number) => Promise<number | undefined>;
  readonly dispatchRefresh: (
    tabId: number,
    command: RefreshExecutionCommand,
  ) => Promise<void> | void;
  readonly setRefreshParticipant: (
    windowId: number,
    tabId: number,
    participant: boolean,
  ) => void;
  readonly onError?: (error: unknown) => void;
}

interface WindowWatermark {
  readonly generation: number;
  readonly mode: PageRefreshMode;
}

export class TabRefreshCoordinator {
  private readonly store: TabRefreshStateStore;
  private readonly getActiveTabId: TabRefreshCoordinatorOptions["getActiveTabId"];
  private readonly dispatchRefresh: TabRefreshCoordinatorOptions["dispatchRefresh"];
  private readonly setRefreshParticipant: TabRefreshCoordinatorOptions["setRefreshParticipant"];
  private readonly onError: TabRefreshCoordinatorOptions["onError"];
  private readonly watermarks = new Map<number, WindowWatermark>();
  private initialization: Promise<void> | undefined;
  private tail = Promise.resolve();

  public constructor(options: TabRefreshCoordinatorOptions) {
    this.store = options.store;
    this.getActiveTabId = options.getActiveTabId;
    this.dispatchRefresh = options.dispatchRefresh;
    this.setRefreshParticipant = options.setRefreshParticipant;
    this.onError = options.onError;
  }

  public initialize(): Promise<void> {
    return this.ensureInitialized();
  }

  public async panelOpened(
    tabId: number,
    windowId: number,
  ): Promise<TabRefreshState> {
    await this.ensureInitialized();
    return this.enqueue(async () => {
      const states = await this.store.loadAll();
      const existing = states.find((state) => state.tabId === tabId);
      const moved = existing !== undefined && existing.windowId !== windowId;
      const current = existing ?? createDefaultTabRefreshState(tabId, windowId);
      const windowGeneration = this.watermarks.get(windowId)?.generation ?? 0;
      const generation = moved
        ? windowGeneration
        : Math.max(current.lastAcceptedGeneration, windowGeneration);
      const pending = !moved && current.pending?.generation === generation
        ? current.pending
        : undefined;
      const next = stateSnapshot({
        tabId,
        windowId,
        autoRefreshEnabled: current.autoRefreshEnabled,
        ideHighlightEnabled: current.ideHighlightEnabled,
        participant: current.autoRefreshEnabled,
        lastAcceptedGeneration: generation,
        ...(pending ? { pending } : {}),
      });
      await this.store.save(next);
      if (moved && existing.participant) {
        this.setParticipant(existing.windowId, existing.tabId, false);
      }
      this.updateParticipant(next);
      return next;
    });
  }

  public async panelClosed(
    tabId: number,
    windowId: number,
  ): Promise<TabRefreshState> {
    this.setParticipant(windowId, tabId, false);
    await this.ensureInitialized();
    return this.enqueue(async () => {
      const states = await this.store.loadAll();
      const existing = states.find(
        (state) => state.tabId === tabId && state.windowId === windowId,
      );
      const current = existing ?? createDefaultTabRefreshState(tabId, windowId);
      const next = stateSnapshot({
        tabId,
        windowId,
        autoRefreshEnabled: current.autoRefreshEnabled,
        ideHighlightEnabled: current.ideHighlightEnabled,
        participant: false,
        lastAcceptedGeneration: current.lastAcceptedGeneration,
      });
      if (existing) {
        await this.store.save(next);
      }
      this.updateParticipant(next);
      return next;
    });
  }

  public async state(tabId: number, windowId: number): Promise<TabRefreshState> {
    await this.ensureInitialized();
    return this.enqueue(async () => {
      const states = await this.store.loadAll();
      const existing = states.find((candidate) => candidate.tabId === tabId);
      if (existing?.windowId === windowId) {
        return existing;
      }
      return createDefaultTabRefreshState(
        tabId,
        windowId,
        this.watermarks.get(windowId)?.generation ?? 0,
      );
    });
  }

  public async updateSettings(
    tabId: number,
    windowId: number,
    settings: TabRefreshSettings,
  ): Promise<TabRefreshState> {
    if (
      typeof settings?.autoRefreshEnabled !== "boolean" ||
      typeof settings.ideHighlightEnabled !== "boolean"
    ) {
      throw new TypeError("Invalid browser tab refresh settings");
    }
    await this.ensureInitialized();
    return this.enqueue(async () => {
      const states = await this.store.loadAll();
      const existing = states.find(
        (state) => state.tabId === tabId && state.windowId === windowId,
      );
      const current = existing ?? createDefaultTabRefreshState(tabId, windowId);
      const enabling = !current.autoRefreshEnabled &&
        settings.autoRefreshEnabled;
      const generation = Math.max(
        current.lastAcceptedGeneration,
        this.watermarks.get(windowId)?.generation ?? 0,
      );
      const pending = settings.autoRefreshEnabled && !enabling
        ? current.pending
        : undefined;
      const next = stateSnapshot({
        tabId,
        windowId,
        autoRefreshEnabled: settings.autoRefreshEnabled,
        ideHighlightEnabled: settings.ideHighlightEnabled,
        participant: settings.autoRefreshEnabled && existing !== undefined,
        lastAcceptedGeneration: generation,
        ...(pending ? { pending } : {}),
      });
      if (!existing) {
        return next;
      }
      await this.store.save(next);
      if (current.participant !== next.participant) {
        this.updateParticipant(next);
      }
      return next;
    });
  }

  public async acceptPageRefresh(
    windowId: number,
    message: PageRefreshMessage,
  ): Promise<void> {
    const parsed = PageRefreshMessageSchema.safeParse(message);
    if (!parsed.success || !isBrowserId(windowId)) {
      return;
    }
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const windowStates = states.filter((state) => state.windowId === windowId);
      const current = currentWatermark(
        this.watermarks.get(windowId),
        windowStates,
      );
      const incoming: WindowWatermark = {
        generation: parsed.data.refreshGeneration,
        mode: parsed.data.mode,
      };
      if (!isNewerRefresh(incoming, current)) {
        return;
      }
      this.watermarks.set(windowId, incoming);

      let activeTabId: number | undefined;
      try {
        activeTabId = await this.getActiveTabId(windowId);
      } catch (error) {
        this.report(error);
      }

      for (const state of windowStates) {
        const pending = state.autoRefreshEnabled && state.participant
          ? {
              generation: incoming.generation,
              mode: incoming.mode,
            } as const
          : undefined;
        let next = stateSnapshot({
          ...state,
          lastAcceptedGeneration: incoming.generation,
          ...(pending ? { pending } : {}),
        });
        if (!pending) {
          next = withoutPending(next);
        }
        if (activeTabId === state.tabId && pending) {
          next = withoutPending(next);
          await this.store.save(next);
          await this.dispatch(next.tabId, pending);
        } else {
          await this.store.save(next);
        }
      }
    });
  }

  public async beginWindowEpoch(windowId: number): Promise<void> {
    if (!isBrowserId(windowId)) {
      return;
    }
    await this.ensureInitialized();
    await this.enqueue(async () => {
      this.watermarks.set(windowId, { generation: 0, mode: "styles" });
      const states = await this.store.loadAll();
      for (const state of states) {
        if (state.windowId !== windowId) {
          continue;
        }
        await this.store.save(stateSnapshot({
          tabId: state.tabId,
          windowId: state.windowId,
          autoRefreshEnabled: state.autoRefreshEnabled,
          ideHighlightEnabled: state.ideHighlightEnabled,
          participant: state.participant,
          lastAcceptedGeneration: 0,
        }));
      }
    });
  }

  public async clearWindowPending(windowId: number): Promise<void> {
    if (!isBrowserId(windowId)) {
      return;
    }
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      for (const state of states) {
        if (state.windowId === windowId && state.pending) {
          await this.store.save(withoutPending(state));
        }
      }
    });
  }

  public async activateTab(tabId: number, windowId: number): Promise<void> {
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const state = states.find(
        (candidate) =>
          candidate.tabId === tabId && candidate.windowId === windowId,
      );
      if (!state?.pending || !state.participant || !state.autoRefreshEnabled) {
        return;
      }
      const pending = state.pending;
      await this.store.save(withoutPending(state));
      await this.dispatch(tabId, pending);
    });
  }

  public async removeTab(tabId: number): Promise<void> {
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const state = states.find((candidate) => candidate.tabId === tabId);
      if (state?.participant) {
        this.setParticipant(state.windowId, state.tabId, false);
      }
      await this.store.removeTab(tabId);
    });
  }

  public async detachTab(tabId: number, windowId: number): Promise<void> {
    if (!isBrowserId(tabId) || !isBrowserId(windowId)) {
      return;
    }
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const state = states.find(
        (candidate) =>
          candidate.tabId === tabId && candidate.windowId === windowId,
      );
      if (!state) {
        return;
      }
      if (state.participant) {
        this.setParticipant(windowId, tabId, false);
      }
      await this.store.removeTab(tabId);
    });
  }

  public async removeWindow(windowId: number): Promise<void> {
    await this.ensureInitialized();
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      for (const state of states) {
        if (state.windowId === windowId && state.participant) {
          this.setParticipant(windowId, state.tabId, false);
        }
      }
      this.watermarks.delete(windowId);
      await this.store.removeWindow(windowId);
    });
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= this.store.loadAll().then((states) => {
      for (const state of states) {
        const current = this.watermarks.get(state.windowId);
        if (!current || state.lastAcceptedGeneration > current.generation) {
          this.watermarks.set(state.windowId, {
            generation: state.lastAcceptedGeneration,
            mode: state.pending?.mode ?? "styles",
          });
        } else if (
          state.lastAcceptedGeneration === current.generation &&
          state.pending?.mode === "reload"
        ) {
          this.watermarks.set(state.windowId, {
            generation: current.generation,
            mode: "reload",
          });
        }
        if (state.participant) {
          this.setParticipant(state.windowId, state.tabId, true);
        }
      }
    });
    return this.initialization;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private updateParticipant(state: TabRefreshState): void {
    this.setParticipant(
      state.windowId,
      state.tabId,
      state.participant,
    );
  }

  private setParticipant(
    windowId: number,
    tabId: number,
    participant: boolean,
  ): void {
    try {
      this.setRefreshParticipant(windowId, tabId, participant);
    } catch (error) {
      this.report(error);
    }
  }

  private async dispatch(
    tabId: number,
    pending: { readonly generation: number; readonly mode: PageRefreshMode },
  ): Promise<void> {
    try {
      await this.dispatchRefresh(tabId, {
        type: "pin-op.refresh.execute",
        refreshGeneration: pending.generation,
        mode: pending.mode,
      });
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics never change refresh ownership.
    }
  }
}

function currentWatermark(
  remembered: WindowWatermark | undefined,
  states: readonly TabRefreshState[],
): WindowWatermark | undefined {
  let current = remembered;
  for (const state of states) {
    const candidate = {
      generation: state.lastAcceptedGeneration,
      mode: state.pending?.mode ?? "styles",
    } as const;
    if (isNewerRefresh(candidate, current)) {
      current = candidate;
    }
  }
  return current;
}

function isNewerRefresh(
  incoming: WindowWatermark,
  current: WindowWatermark | undefined,
): boolean {
  return !current ||
    incoming.generation > current.generation ||
    (incoming.generation === current.generation &&
      incoming.mode === "reload" &&
      current.mode === "styles");
}

function withoutPending(state: TabRefreshState): TabRefreshState {
  return stateSnapshot({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: state.participant,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
  });
}

function stateSnapshot(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: state.participant,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
    ...(state.pending
      ? { pending: Object.freeze({ ...state.pending }) }
      : {}),
  });
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
