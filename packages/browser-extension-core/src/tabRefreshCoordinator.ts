import {
  PageRefreshMessageSchema,
  type PageRefreshMessage,
  type PageRefreshMode,
} from "@pin-op/protocol";
import {
  createDefaultTabRefreshState,
  type PendingTabRefresh,
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
  private readonly pendingRefreshes = new Map<number, PendingTabRefresh>();
  private readonly windowRemovals = new Map<number, Promise<void>>();
  // WebExtension tab ids are not reused within one browser runtime. Keeping all
  // terminal ids for that runtime prevents a late callback from reopening one.
  private readonly terminalTabs = new Set<number>();
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
    createDefaultTabRefreshState(tabId, windowId);
    if (this.terminalTabs.has(tabId)) {
      throw new Error("Tab refresh lifecycle is terminal");
    }
    if (this.windowRemovals.has(windowId)) {
      throw new Error("Window refresh lifecycle is closing");
    }

    const previousWindowId = this.currentPanelWindow(tabId);
    if (previousWindowId !== undefined && previousWindowId !== windowId) {
      this.pendingRefreshes.delete(tabId);
      this.clearPanelWindow(tabId, previousWindowId);
      this.revokeIndexedParticipant(tabId, previousWindowId);
    }
    this.panelWindows.set(tabId, windowId);
    const revision = this.advanceLifecycle(tabId);

    try {
      await this.ensureInitialized();
      const updated = await this.store.updateTab(tabId, (existing) => {
        if (!this.isCurrentPanelLifecycle(tabId, windowId, revision)) {
          return existing;
        }
        const moved = existing !== undefined && existing.windowId !== windowId;
        const current = existing ?? createDefaultTabRefreshState(tabId, windowId);
        const windowGeneration = this.watermarks.get(windowId)?.generation ?? 0;
        return durableSnapshot({
          tabId,
          windowId,
          autoRefreshEnabled: current.autoRefreshEnabled,
          ideHighlightEnabled: current.ideHighlightEnabled,
          participant: false,
          lastAcceptedGeneration: moved
            ? windowGeneration
            : Math.max(current.lastAcceptedGeneration, windowGeneration),
        });
      });
      const durable = updated ?? createDefaultTabRefreshState(tabId, windowId);
      if (!this.isCurrentPanelLifecycle(tabId, windowId, revision)) {
        return this.effectiveState(durable, tabId, durable.windowId);
      }
      if (durable.autoRefreshEnabled) {
        this.grantParticipant(windowId, tabId);
      } else {
        this.revokeIndexedParticipant(tabId, windowId);
      }
      return this.effectiveState(durable, tabId, windowId);
    } catch (error) {
      if (this.isCurrentLifecycle(tabId, revision)) {
        this.clearPanelWindow(tabId, windowId);
        this.pendingRefreshes.delete(tabId);
        this.revokeIndexedParticipant(tabId, windowId);
        this.retireLifecycle(tabId, revision);
      }
      throw error;
    }
  }

  public async panelClosed(
    tabId: number,
    windowId?: number,
  ): Promise<TabRefreshState | undefined> {
    if (this.terminalTabs.has(tabId)) {
      return undefined;
    }

    const currentWindowId = this.currentPanelWindow(tabId);
    if (
      windowId !== undefined &&
      currentWindowId !== undefined &&
      currentWindowId !== windowId
    ) {
      return this.storedEffectiveState(tabId);
    }
    const resolvedWindowId = currentWindowId ?? windowId;
    if (currentWindowId === undefined) {
      return this.storedEffectiveState(tabId, resolvedWindowId);
    }

    const revision = this.advanceLifecycle(tabId);
    this.clearPanelWindow(tabId, currentWindowId);
    this.pendingRefreshes.delete(tabId);
    const revoked = this.revokeIndexedParticipant(tabId, currentWindowId);
    if (revoked === undefined) {
      this.setParticipant(currentWindowId, tabId, false);
    }

    let durable: TabRefreshState | undefined;
    try {
      const windowRemoval = this.windowRemovals.get(currentWindowId);
      if (windowRemoval) {
        await windowRemoval;
      } else {
        await this.ensureInitialized();
      }
      durable = await this.storedTabState(tabId);
    } finally {
      if (this.isCurrentLifecycle(tabId, revision)) {
        this.retireLifecycle(tabId, revision);
      }
    }
    if (!durable) {
      return createDefaultTabRefreshState(tabId, currentWindowId);
    }
    return this.effectiveState(durable, tabId, durable.windowId);
  }

  public async state(tabId: number, windowId: number): Promise<TabRefreshState> {
    await this.ensureInitialized();
    const durable = await this.store.load(tabId, windowId);
    return this.effectiveState(durable, tabId, windowId);
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
    createDefaultTabRefreshState(tabId, windowId);
    const revision = this.lifecycleRevision(tabId);
    if (!settings.autoRefreshEnabled) {
      this.pendingRefreshes.delete(tabId);
      this.revokeIndexedParticipant(tabId, windowId);
    }

    await this.ensureInitialized();
    let updated: TabRefreshState | undefined;
    try {
      updated = await this.store.updateTab(tabId, (stored) => {
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return stored;
        }
        const current = stored?.windowId === windowId
          ? stored
          : createDefaultTabRefreshState(tabId, windowId);
        return durableSnapshot({
          tabId,
          windowId,
          autoRefreshEnabled: settings.autoRefreshEnabled,
          ideHighlightEnabled: settings.ideHighlightEnabled,
          participant: false,
          lastAcceptedGeneration: Math.max(
            current.lastAcceptedGeneration,
            this.watermarks.get(windowId)?.generation ?? 0,
          ),
        });
      });
    } finally {
      if (
        !settings.autoRefreshEnabled &&
        this.isCurrentPanelLifecycle(tabId, windowId, revision)
      ) {
        this.revokeIndexedParticipant(tabId, windowId);
      }
    }
    const durable = updated ?? createDefaultTabRefreshState(tabId, windowId);
    if (
      this.isCurrentPanelLifecycle(tabId, windowId, revision) &&
      settings.autoRefreshEnabled
    ) {
      this.grantParticipant(windowId, tabId);
    }
    return this.effectiveState(durable, tabId, durable.windowId);
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
      const current = currentWatermark(this.watermarks.get(windowId), windowStates);
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
        const revision = this.lifecycleRevision(snapshot.tabId);
        const updated = await this.store.updateTab(snapshot.tabId, (state) =>
          state?.windowId === windowId &&
            this.isCurrentLifecycle(snapshot.tabId, revision)
            ? durableSnapshot({
                ...state,
                participant: false,
                lastAcceptedGeneration: incoming.generation,
              })
            : state);
        if (
          !updated ||
          !this.isCurrentPanelLifecycle(snapshot.tabId, windowId, revision) ||
          this.participantWindows.get(snapshot.tabId) !== windowId ||
          !updated.autoRefreshEnabled
        ) {
          this.pendingRefreshes.delete(snapshot.tabId);
          continue;
        }
        const pending = Object.freeze({
          generation: incoming.generation,
          mode: incoming.mode,
        });
        this.pendingRefreshes.set(snapshot.tabId, pending);
        if (activeTabId === snapshot.tabId) {
          this.pendingRefreshes.delete(snapshot.tabId);
          await this.dispatch(snapshot.tabId, pending);
        }
      }
    });
  }

  public async beginWindowEpoch(windowId: number): Promise<void> {
    if (!isBrowserId(windowId)) {
      return;
    }
    this.clearRuntimePendingForWindow(windowId);
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
            ? durableSnapshot({
                ...current,
                participant: false,
                lastAcceptedGeneration: 0,
              })
            : current);
      }
    });
  }

  public async clearWindowPending(windowId: number): Promise<void> {
    if (isBrowserId(windowId)) {
      this.clearRuntimePendingForWindow(windowId);
    }
  }

  public async activateTab(tabId: number, windowId: number): Promise<void> {
    await this.ensureInitialized();
    await this.enqueue(async () => {
      if (
        this.panelWindows.get(tabId) !== windowId ||
        this.participantWindows.get(tabId) !== windowId
      ) {
        this.pendingRefreshes.delete(tabId);
        return;
      }
      const pending = this.pendingRefreshes.get(tabId);
      if (!pending) {
        return;
      }
      this.pendingRefreshes.delete(tabId);
      await this.dispatch(tabId, pending);
    });
  }

  public async removeTab(tabId: number): Promise<void> {
    createDefaultTabRefreshState(tabId, 0);
    this.markTerminalTab(tabId);
    const revision = this.advanceLifecycle(tabId);
    this.clearPanelWindow(tabId);
    this.pendingRefreshes.delete(tabId);
    this.revokeIndexedParticipant(tabId);
    try {
      await this.store.removeTab(tabId);
    } catch (error) {
      this.report(error);
    } finally {
      this.retireLifecycle(tabId, revision);
    }
  }

  public async detachTab(tabId: number, windowId: number): Promise<void> {
    if (!isBrowserId(tabId) || !isBrowserId(windowId)) {
      return;
    }
    const ownsOldWindow = this.currentPanelWindow(tabId) === windowId;
    const revision = ownsOldWindow ? this.advanceLifecycle(tabId) : undefined;
    if (ownsOldWindow) {
      this.clearPanelWindow(tabId, windowId);
      this.pendingRefreshes.delete(tabId);
      const revoked = this.revokeIndexedParticipant(tabId, windowId);
      if (revoked === undefined) {
        this.setParticipant(windowId, tabId, false);
      }
    }
    try {
      await this.ensureInitialized();
      await this.store.loadAll();
    } catch (error) {
      this.report(error);
    } finally {
      if (revision !== undefined) {
        this.retireLifecycle(tabId, revision);
      }
    }
  }

  public removeWindow(windowId: number): Promise<void> {
    const existing = this.windowRemovals.get(windowId);
    if (existing) {
      return existing;
    }
    const revisions = new Map<number, number>();
    this.fenceWindowLifecycle(windowId, revisions);
    const operation = this.performWindowRemoval(windowId, revisions);
    this.windowRemovals.set(windowId, operation);
    void operation.then(
      () => this.clearWindowRemoval(windowId, operation),
      () => this.clearWindowRemoval(windowId, operation),
    );
    return operation;
  }

  private async performWindowRemoval(
    windowId: number,
    revisions: Map<number, number>,
  ): Promise<void> {
    try {
      await this.ensureInitialized();
      this.fenceWindowLifecycle(windowId, revisions);
      await this.store.loadAll();
    } catch (error) {
      this.report(error);
    } finally {
      this.watermarks.delete(windowId);
      for (const [tabId, revision] of revisions) {
        this.retireLifecycle(tabId, revision);
      }
    }
  }

  private clearWindowRemoval(
    windowId: number,
    operation: Promise<void>,
  ): void {
    if (this.windowRemovals.get(windowId) === operation) {
      this.windowRemovals.delete(windowId);
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
            mode: "styles",
          });
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

  private markTerminalTab(tabId: number): void {
    this.terminalTabs.add(tabId);
  }

  private lifecycleRevision(tabId: number): number {
    return this.lifecycleRevisions.get(tabId) ?? 0;
  }

  private isCurrentLifecycle(tabId: number, revision: number): boolean {
    return this.lifecycleRevision(tabId) === revision;
  }

  private isCurrentPanelLifecycle(
    tabId: number,
    windowId: number,
    revision: number,
  ): boolean {
    return this.isCurrentLifecycle(tabId, revision) &&
      this.panelWindows.get(tabId) === windowId &&
      !this.terminalTabs.has(tabId) &&
      !this.windowRemovals.has(windowId);
  }

  private retireLifecycle(tabId: number, revision: number): void {
    if (this.isCurrentLifecycle(tabId, revision)) {
      this.lifecycleRevisions.delete(tabId);
    }
  }

  private fenceWindowLifecycle(
    windowId: number,
    revisions: Map<number, number>,
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
      const hadPanel = this.panelWindows.get(tabId) === windowId;
      this.clearPanelWindow(tabId, windowId);
      this.pendingRefreshes.delete(tabId);
      const revoked = this.revokeIndexedParticipant(tabId, windowId);
      if (hadPanel && revoked === undefined) {
        this.setParticipant(windowId, tabId, false);
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

  private async storedEffectiveState(
    tabId: number,
    fallbackWindowId?: number,
  ): Promise<TabRefreshState | undefined> {
    await this.ensureInitialized();
    const durable = await this.storedTabState(tabId);
    if (durable) {
      return this.effectiveState(durable, tabId, durable.windowId);
    }
    return fallbackWindowId === undefined
      ? undefined
      : createDefaultTabRefreshState(tabId, fallbackWindowId);
  }

  private effectiveState(
    durable: TabRefreshState,
    tabId: number,
    windowId: number,
  ): TabRefreshState {
    const base = durable.windowId === windowId
      ? durable
      : createDefaultTabRefreshState(
          tabId,
          windowId,
          this.watermarks.get(windowId)?.generation ?? 0,
        );
    const participant = base.autoRefreshEnabled &&
      this.panelWindows.get(tabId) === windowId &&
      this.participantWindows.get(tabId) === windowId;
    const pending = participant ? this.pendingRefreshes.get(tabId) : undefined;
    return stateSnapshot({
      tabId,
      windowId,
      autoRefreshEnabled: base.autoRefreshEnabled,
      ideHighlightEnabled: base.ideHighlightEnabled,
      participant,
      lastAcceptedGeneration: base.lastAcceptedGeneration,
      ...(pending ? { pending } : {}),
    });
  }

  private clearRuntimePendingForWindow(windowId: number): void {
    for (const tabId of this.pendingRefreshes.keys()) {
      if (
        this.panelWindows.get(tabId) === windowId ||
        this.participantWindows.get(tabId) === windowId
      ) {
        this.pendingRefreshes.delete(tabId);
      }
    }
  }

  private grantParticipant(windowId: number, tabId: number): void {
    const previousWindowId = this.participantWindows.get(tabId);
    if (previousWindowId === windowId) {
      return;
    }
    if (previousWindowId !== undefined) {
      this.participantWindows.delete(tabId);
      this.setParticipant(previousWindowId, tabId, false);
    }
    this.participantWindows.set(tabId, windowId);
    this.setParticipant(windowId, tabId, true);
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
    pending: PendingTabRefresh,
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
      mode: "styles",
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

function durableSnapshot(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: false,
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
