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
  private readonly lifecycleRevisions = new Map<number, number>();
  private readonly panelWindows = new Map<number, number>();
  private readonly participantWindows = new Map<number, number>();
  private nextLifecycleRevision = 1;
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
    this.panelWindows.set(tabId, windowId);
    const revision = this.advanceLifecycle(tabId);
    try {
      await this.ensureInitialized();
      let previous: TabRefreshState | undefined;
      const updated = await this.store.updateTab(tabId, (existing) => {
        previous = existing;
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return existing;
        }
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
        return next;
      });
      const next = updated ?? createDefaultTabRefreshState(tabId, windowId);
      if (!this.isCurrentLifecycle(tabId, revision)) {
        return next;
      }
      if (
        previous?.participant &&
        previous.windowId !== next.windowId
      ) {
        this.setParticipant(previous.windowId, previous.tabId, false);
      }
      this.updateParticipant(next);
      return next;
    } catch (error) {
      if (this.isCurrentLifecycle(tabId, revision)) {
        this.clearPanelWindow(tabId, windowId);
      }
      throw error;
    }
  }

  public async panelClosed(
    tabId: number,
    windowId?: number,
  ): Promise<TabRefreshState | undefined> {
    if (windowId !== undefined) {
      let currentWindowId = this.currentPanelWindow(tabId);
      if (currentWindowId === undefined) {
        await this.ensureInitialized();
        currentWindowId = this.currentPanelWindow(tabId);
        if (currentWindowId === undefined) {
          const current = await this.storedTabState(tabId);
          currentWindowId = this.currentPanelWindow(tabId);
          if (currentWindowId === undefined && current?.windowId !== windowId) {
            return current;
          }
        }
      }
      if (currentWindowId !== undefined && currentWindowId !== windowId) {
        return this.storedTabState(tabId);
      }
    }
    const revision = this.advanceLifecycle(tabId);
    this.clearPanelWindow(tabId, windowId);
    const participantWindowId = this.revokeIndexedParticipant(tabId);
    if (participantWindowId === undefined && windowId !== undefined) {
      this.setParticipant(windowId, tabId, false);
    }
    await this.ensureInitialized();
    const updated = await this.store.updateTabDurably(tabId, (existing) => {
      if (!this.isCurrentLifecycle(tabId, revision)) {
        return existing;
      }
      if (
        windowId !== undefined &&
        existing !== undefined &&
        existing.windowId !== windowId
      ) {
        return existing;
      }
      const resolvedWindowId = existing?.windowId ?? windowId;
      if (resolvedWindowId === undefined) {
        return undefined;
      }
      const current = existing ??
        createDefaultTabRefreshState(tabId, resolvedWindowId);
      return stateSnapshot({
        tabId,
        windowId: current.windowId,
        autoRefreshEnabled: current.autoRefreshEnabled,
        ideHighlightEnabled: current.ideHighlightEnabled,
        participant: false,
        lastAcceptedGeneration: current.lastAcceptedGeneration,
      });
    });
    if (updated && this.isCurrentLifecycle(tabId, revision)) {
      this.updateParticipant(updated);
    }
    return updated;
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
    const revision = this.lifecycleRevision(tabId);
    await this.ensureInitialized();
    return this.enqueue(async () => {
      let previous: TabRefreshState | undefined;
      let response: TabRefreshState | undefined;
      const updated = await this.store.updateTab(tabId, (stored) => {
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return stored;
        }
        const existing = stored?.windowId === windowId ? stored : undefined;
        previous = existing;
        const current = existing ??
          createDefaultTabRefreshState(tabId, windowId);
        const enabling = !current.autoRefreshEnabled &&
          settings.autoRefreshEnabled;
        const generation = Math.max(
          current.lastAcceptedGeneration,
          this.watermarks.get(windowId)?.generation ?? 0,
        );
        const pending = settings.autoRefreshEnabled && !enabling
          ? current.pending
          : undefined;
        response = stateSnapshot({
          tabId,
          windowId,
          autoRefreshEnabled: settings.autoRefreshEnabled,
          ideHighlightEnabled: settings.ideHighlightEnabled,
          participant: settings.autoRefreshEnabled && existing !== undefined,
          lastAcceptedGeneration: generation,
          ...(pending ? { pending } : {}),
        });
        return existing ? response : stored;
      });
      if (!this.isCurrentLifecycle(tabId, revision)) {
        return updated ?? createDefaultTabRefreshState(tabId, windowId);
      }
      const next = response ?? updated ??
        createDefaultTabRefreshState(tabId, windowId);
      if (previous && previous.participant !== next.participant) {
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
      const revisions = new Map(
        windowStates.map((state) => [
          state.tabId,
          this.lifecycleRevision(state.tabId),
        ] as const),
      );
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

      for (const snapshot of windowStates) {
        const revision = revisions.get(snapshot.tabId) ?? 0;
        let command:
          | { readonly generation: number; readonly mode: PageRefreshMode }
          | undefined;
        await this.store.updateTab(snapshot.tabId, (state) => {
          if (
            !this.isCurrentLifecycle(snapshot.tabId, revision) ||
            state?.windowId !== windowId
          ) {
            return state;
          }
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
            return withoutPending(next);
          }
          if (activeTabId === state.tabId) {
            command = pending;
            next = withoutPending(next);
          }
          return next;
        });
        if (
          command &&
          this.isCurrentLifecycle(snapshot.tabId, revision)
        ) {
          await this.dispatch(snapshot.tabId, command);
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
        await this.store.updateTab(state.tabId, (current) =>
          current?.windowId === windowId
            ? stateSnapshot({
                tabId: current.tabId,
                windowId: current.windowId,
                autoRefreshEnabled: current.autoRefreshEnabled,
                ideHighlightEnabled: current.ideHighlightEnabled,
                participant: current.participant,
                lastAcceptedGeneration: 0,
              })
            : current);
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
          await this.store.updateTab(state.tabId, (current) =>
            current?.windowId === windowId && current.pending
              ? withoutPending(current)
              : current);
        }
      }
    });
  }

  public async activateTab(tabId: number, windowId: number): Promise<void> {
    const revision = this.lifecycleRevision(tabId);
    await this.ensureInitialized();
    await this.enqueue(async () => {
      let pending:
        | { readonly generation: number; readonly mode: PageRefreshMode }
        | undefined;
      await this.store.updateTab(tabId, (state) => {
        if (
          !this.isCurrentLifecycle(tabId, revision) ||
          state?.windowId !== windowId ||
          !state.pending ||
          !state.participant ||
          !state.autoRefreshEnabled
        ) {
          return state;
        }
        pending = state.pending;
        return withoutPending(state);
      });
      if (pending && this.isCurrentLifecycle(tabId, revision)) {
        await this.dispatch(tabId, pending);
      }
    });
  }

  public async removeTab(tabId: number): Promise<void> {
    const revision = this.advanceLifecycle(tabId);
    let completed = false;
    this.clearPanelWindow(tabId);
    let revokedWindowId = this.revokeIndexedParticipant(tabId);
    try {
      await this.ensureInitialized();
      if (this.isCurrentLifecycle(tabId, revision)) {
        this.clearPanelWindow(tabId);
        revokedWindowId ??= this.revokeIndexedParticipant(tabId);
      }
      await this.enqueue(async () => {
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return;
        }
        const states = await this.store.loadAll();
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return;
        }
        const state = states.find((candidate) => candidate.tabId === tabId);
        if (state?.participant && state.windowId !== revokedWindowId) {
          this.setParticipant(state.windowId, state.tabId, false);
        }
        if (this.isCurrentLifecycle(tabId, revision)) {
          await this.store.removeTab(
            tabId,
            () => this.isCurrentLifecycle(tabId, revision),
          );
        }
      });
      completed = true;
    } finally {
      if (completed) {
        this.retireLifecycle(tabId, revision);
      }
    }
  }

  public async detachTab(tabId: number, windowId: number): Promise<void> {
    if (!isBrowserId(tabId) || !isBrowserId(windowId)) {
      return;
    }
    this.clearPanelWindow(tabId, windowId);
    let revokedWindowId = this.revokeIndexedParticipant(tabId, windowId);
    await this.ensureInitialized();
    this.clearPanelWindow(tabId, windowId);
    revokedWindowId ??= this.revokeIndexedParticipant(tabId, windowId);
    await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const state = states.find(
        (candidate) =>
          candidate.tabId === tabId && candidate.windowId === windowId,
      );
      if (!state) {
        return;
      }
      if (state.participant && state.windowId !== revokedWindowId) {
        this.setParticipant(windowId, tabId, false);
      }
      await this.store.updateTab(tabId, (current) =>
        current?.windowId === windowId
          ? stateSnapshot({
              tabId: current.tabId,
              windowId: current.windowId,
              autoRefreshEnabled: current.autoRefreshEnabled,
              ideHighlightEnabled: current.ideHighlightEnabled,
              participant: false,
              lastAcceptedGeneration: current.lastAcceptedGeneration,
            })
          : current);
    });
  }

  public async removeWindow(windowId: number): Promise<void> {
    const revisions = new Map<number, number>();
    const revokedTabIds = new Set<number>();
    let completed = false;
    this.fenceWindowLifecycle(windowId, revisions, revokedTabIds);
    try {
      await this.ensureInitialized();
      this.fenceWindowLifecycle(windowId, revisions, revokedTabIds);
      await this.enqueue(async () => {
        const states = await this.store.loadAll();
        for (const state of states) {
          if (state.windowId !== windowId) {
            continue;
          }
          let revision = revisions.get(state.tabId);
          if (revision === undefined) {
            const currentWindowId = this.currentPanelWindow(state.tabId);
            if (
              currentWindowId !== undefined &&
              currentWindowId !== windowId
            ) {
              continue;
            }
            revision = this.advanceLifecycle(state.tabId);
            revisions.set(state.tabId, revision);
          }
          if (!this.isCurrentLifecycle(state.tabId, revision)) {
            continue;
          }
          if (state.participant && !revokedTabIds.has(state.tabId)) {
            this.setParticipant(windowId, state.tabId, false);
            revokedTabIds.add(state.tabId);
          }
          if (this.isCurrentLifecycle(state.tabId, revision)) {
            await this.store.removeTabFromWindow(
              state.tabId,
              windowId,
              () => this.isCurrentLifecycle(state.tabId, revision),
            );
          }
        }
        this.watermarks.delete(windowId);
      });
      completed = true;
    } finally {
      if (completed) {
        for (const [tabId, revision] of revisions) {
          this.retireLifecycle(tabId, revision);
        }
      }
    }
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialization) {
      return this.initialization;
    }
    const attempt = this.store.loadAll().then((states) => {
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
        if (state.participant && this.lifecycleRevision(state.tabId) === 0) {
          this.panelWindows.set(state.tabId, state.windowId);
          this.updateParticipant(state);
        }
      }
    });
    let retryable!: Promise<void>;
    retryable = attempt.catch((error: unknown) => {
      if (this.initialization === retryable) {
        this.initialization = undefined;
      }
      throw error;
    });
    this.initialization = retryable;
    return retryable;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private advanceLifecycle(tabId: number): number {
    const revision = this.nextLifecycleRevision;
    this.nextLifecycleRevision += 1;
    this.lifecycleRevisions.set(tabId, revision);
    return revision;
  }

  private lifecycleRevision(tabId: number): number {
    return this.lifecycleRevisions.get(tabId) ?? 0;
  }

  private isCurrentLifecycle(tabId: number, revision: number): boolean {
    return this.lifecycleRevision(tabId) === revision;
  }

  private retireLifecycle(tabId: number, revision: number): void {
    if (this.isCurrentLifecycle(tabId, revision)) {
      this.lifecycleRevisions.delete(tabId);
    }
  }

  private fenceWindowLifecycle(
    windowId: number,
    revisions: Map<number, number>,
    revokedTabIds: Set<number>,
  ): void {
    const tabIds = new Set<number>();
    for (const [tabId, panelWindowId] of this.panelWindows) {
      if (panelWindowId === windowId) {
        tabIds.add(tabId);
      }
    }
    for (const [tabId, participantWindowId] of this.participantWindows) {
      if (participantWindowId === windowId) {
        tabIds.add(tabId);
      }
    }
    for (const tabId of tabIds) {
      let revision = revisions.get(tabId);
      if (revision === undefined) {
        revision = this.advanceLifecycle(tabId);
        revisions.set(tabId, revision);
      } else if (!this.isCurrentLifecycle(tabId, revision)) {
        continue;
      }
      this.clearPanelWindow(tabId, windowId);
      if (this.revokeIndexedParticipant(tabId, windowId) !== undefined) {
        revokedTabIds.add(tabId);
      }
    }
  }

  private currentPanelWindow(tabId: number): number | undefined {
    return this.panelWindows.get(tabId) ?? this.participantWindows.get(tabId);
  }

  private clearPanelWindow(tabId: number, expectedWindowId?: number): void {
    const windowId = this.panelWindows.get(tabId);
    if (
      windowId === undefined ||
      (expectedWindowId !== undefined && windowId !== expectedWindowId)
    ) {
      return;
    }
    this.panelWindows.delete(tabId);
  }

  private async storedTabState(
    tabId: number,
  ): Promise<TabRefreshState | undefined> {
    const states = await this.store.loadAll();
    return states.find((state) => state.tabId === tabId);
  }

  private revokeIndexedParticipant(
    tabId: number,
    expectedWindowId?: number,
  ): number | undefined {
    const windowId = this.participantWindows.get(tabId);
    if (
      windowId === undefined ||
      (expectedWindowId !== undefined && windowId !== expectedWindowId)
    ) {
      return undefined;
    }
    this.participantWindows.delete(tabId);
    this.setParticipant(windowId, tabId, false);
    return windowId;
  }

  private updateParticipant(state: TabRefreshState): void {
    if (state.participant) {
      this.participantWindows.set(state.tabId, state.windowId);
    } else {
      this.participantWindows.delete(state.tabId);
    }
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
