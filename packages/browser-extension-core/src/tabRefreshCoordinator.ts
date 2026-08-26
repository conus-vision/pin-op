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

export interface TabRefreshCompletion {
  readonly tabId: number;
  readonly windowId: number;
  readonly refreshGeneration: number;
  readonly mode: PageRefreshMode;
  readonly accepted: boolean;
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
  readonly beforeControlledTransition?: (
    tabId: number,
  ) => boolean | void | Promise<boolean | void>;
  readonly onError?: (error: unknown) => void;
}

type WindowWatermarkMode = PageRefreshMode | "unknown";

interface WindowWatermark {
  readonly generation: number;
  readonly mode: WindowWatermarkMode;
}

interface TabRefreshOperation {
  readonly windowId: number;
  readonly revision: number;
  readonly pending: PendingTabRefresh;
  readonly onTabCompleted:
    | ((completion: TabRefreshCompletion) => void)
    | undefined;
  phase: "pending" | "dispatching";
  completed: boolean;
}

interface RefreshAdmissionCommit {
  readonly tabId: number;
  readonly before: TabRefreshState;
  readonly after: TabRefreshState;
}

export class TabRefreshCoordinator {
  private readonly store: TabRefreshStateStore;
  private readonly getActiveTabId: TabRefreshCoordinatorOptions["getActiveTabId"];
  private readonly dispatchRefresh: TabRefreshCoordinatorOptions["dispatchRefresh"];
  private readonly setRefreshParticipant: TabRefreshCoordinatorOptions["setRefreshParticipant"];
  private readonly beforeControlledTransition: TabRefreshCoordinatorOptions["beforeControlledTransition"];
  private readonly onError: TabRefreshCoordinatorOptions["onError"];
  private readonly watermarks = new Map<number, WindowWatermark>();
  private readonly lifecycleRevisions = new Map<number, number>();
  private readonly panelWindows = new Map<number, number>();
  private readonly participantWindows = new Map<number, number>();
  private readonly pendingRefreshes = new Map<number, TabRefreshOperation>();
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
    this.beforeControlledTransition = options.beforeControlledTransition;
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
    if (previousWindowId !== undefined) {
      this.cancelTabRefresh(tabId);
    }
    if (previousWindowId !== undefined && previousWindowId !== windowId) {
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
        return durableSnapshot({
          tabId,
          windowId,
          autoRefreshEnabled: current.autoRefreshEnabled,
          ideHighlightEnabled: current.ideHighlightEnabled,
          participant: false,
          ...durableWatermarkSnapshot(
            moved ? undefined : existing,
            this.watermarks.get(windowId),
          ),
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
        this.cancelTabRefresh(tabId);
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
    this.cancelTabRefresh(tabId);
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
      this.cancelTabRefresh(tabId);
      this.revokeIndexedParticipant(tabId, windowId);
    }

    await this.ensureInitialized();
    let updated: TabRefreshState | undefined;
    try {
      updated = await this.store.updateTab(tabId, (stored) => {
        if (!this.isCurrentLifecycle(tabId, revision)) {
          return stored;
        }
        const storedForWindow = stored?.windowId === windowId
          ? stored
          : undefined;
        return durableSnapshot({
          tabId,
          windowId,
          autoRefreshEnabled: settings.autoRefreshEnabled,
          ideHighlightEnabled: settings.ideHighlightEnabled,
          participant: false,
          ...durableWatermarkSnapshot(
            storedForWindow,
            this.watermarks.get(windowId),
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
    onAccepted?: () => boolean | void | Promise<boolean | void>,
    onTabCompleted?: (completion: TabRefreshCompletion) => void,
  ): Promise<boolean> {
    const parsed = PageRefreshMessageSchema.safeParse(message);
    if (!parsed.success || !isBrowserId(windowId)) {
      return false;
    }
    await this.ensureInitialized();
    return await this.enqueue(async () => {
      const states = await this.store.loadAll();
      const windowStates = states.filter((state) => state.windowId === windowId);
      const current = currentWatermark(this.watermarks.get(windowId), windowStates);
      const incoming = {
        generation: parsed.data.refreshGeneration,
        mode: parsed.data.mode,
      } satisfies WindowWatermark;
      if (!isNewerRefresh(incoming, current)) {
        return false;
      }
      const admitted = await onAccepted?.();
      if (admitted === false) {
        return false;
      }
      const previousWatermark = this.watermarks.get(windowId);
      this.watermarks.set(windowId, incoming);

      let activeTabId: number | undefined;
      try {
        activeTabId = await this.getActiveTabId(windowId);
      } catch (error) {
        this.report(error);
      }

      const commits: RefreshAdmissionCommit[] = [];
      const stages: Array<{
        readonly tabId: number;
        readonly revision: number;
        readonly updated: TabRefreshState | undefined;
      }> = [];
      try {
        for (const snapshot of windowStates) {
          const revision = this.lifecycleRevision(snapshot.tabId);
          let commit: RefreshAdmissionCommit | undefined;
          let updated: TabRefreshState | undefined;
          try {
            updated = await this.store.updateTab(snapshot.tabId, (state) => {
              if (
                state?.windowId !== windowId ||
                !this.isCurrentLifecycle(snapshot.tabId, revision)
              ) {
                return state;
              }
              const after = durableSnapshot({
                ...state,
                participant: false,
                lastAcceptedGeneration: incoming.generation,
                lastAcceptedMode: incoming.mode,
              });
              commit = { tabId: snapshot.tabId, before: state, after };
              return after;
            });
          } catch (error) {
            if (commit) commits.push(commit);
            throw error;
          }
          if (commit) commits.push(commit);
          stages.push({ tabId: snapshot.tabId, revision, updated });
        }
      } catch (error) {
        const rolledBack = await this.rollbackRefreshAdmission(commits);
        if (
          rolledBack &&
          this.watermarks.get(windowId) === incoming
        ) {
          if (previousWatermark) {
            this.watermarks.set(windowId, previousWatermark);
          } else {
            this.watermarks.delete(windowId);
          }
        }
        throw error;
      }
      let activeOperation:
        | { readonly tabId: number; readonly operation: TabRefreshOperation }
        | undefined;
      for (const stage of stages) {
        if (
          !stage.updated ||
          !this.isCurrentPanelLifecycle(
            stage.tabId,
            windowId,
            stage.revision,
          ) ||
          this.participantWindows.get(stage.tabId) !== windowId ||
          !stage.updated.autoRefreshEnabled
        ) {
          this.cancelTabRefresh(stage.tabId);
          continue;
        }
        const pending = Object.freeze({
          generation: incoming.generation,
          mode: incoming.mode,
        });
        this.cancelTabRefresh(stage.tabId);
        if (
          !this.isCurrentPanelLifecycle(
            stage.tabId,
            windowId,
            stage.revision,
          ) ||
          this.participantWindows.get(stage.tabId) !== windowId
        ) {
          continue;
        }
        const operation: TabRefreshOperation = {
          windowId,
          revision: stage.revision,
          pending,
          onTabCompleted,
          phase: "pending",
          completed: false,
        };
        this.pendingRefreshes.set(stage.tabId, operation);
        if (activeTabId === stage.tabId) {
          activeOperation = { tabId: stage.tabId, operation };
        }
      }
      if (activeOperation) {
        await this.dispatch(activeOperation.tabId, activeOperation.operation);
      }
      return true;
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
                tabId: current.tabId,
                windowId: current.windowId,
                autoRefreshEnabled: current.autoRefreshEnabled,
                ideHighlightEnabled: current.ideHighlightEnabled,
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
        this.cancelTabRefresh(tabId);
        return;
      }
      const operation = this.pendingRefreshes.get(tabId);
      if (!operation || operation.phase !== "pending") {
        return;
      }
      await this.dispatch(tabId, operation);
    });
  }

  public async removeTab(tabId: number): Promise<void> {
    createDefaultTabRefreshState(tabId, 0);
    this.markTerminalTab(tabId);
    const revision = this.advanceLifecycle(tabId);
    this.clearPanelWindow(tabId);
    this.cancelTabRefresh(tabId);
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
      this.cancelTabRefresh(tabId);
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
        const candidate = stateWatermark(state);
        if (isNewerRefresh(candidate, current)) {
          this.watermarks.set(state.windowId, candidate);
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
      this.cancelTabRefresh(tabId);
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
    const storedForWindow = durable.windowId === windowId ? durable : undefined;
    const base = storedForWindow ?? createDefaultTabRefreshState(tabId, windowId);
    const participant = base.autoRefreshEnabled &&
      this.panelWindows.get(tabId) === windowId &&
      this.participantWindows.get(tabId) === windowId;
    const operation = participant ? this.pendingRefreshes.get(tabId) : undefined;
    const pending = operation?.phase === "pending"
      ? operation.pending
      : undefined;
    return stateSnapshot({
      tabId,
      windowId,
      autoRefreshEnabled: base.autoRefreshEnabled,
      ideHighlightEnabled: base.ideHighlightEnabled,
      participant,
      ...durableWatermarkSnapshot(
        storedForWindow,
        this.watermarks.get(windowId),
      ),
      ...(pending ? { pending } : {}),
    });
  }

  private clearRuntimePendingForWindow(windowId: number): void {
    for (const [tabId, operation] of [...this.pendingRefreshes]) {
      if (operation.windowId === windowId) {
        this.completeTabRefresh(tabId, operation, false);
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
    operation: TabRefreshOperation,
  ): Promise<void> {
    if (!this.isCurrentRefreshOperation(tabId, operation)) {
      this.completeTabRefresh(tabId, operation, false);
      return;
    }
    operation.phase = "dispatching";
    await this.prepareControlledTransition(tabId);
    if (!this.isCurrentRefreshOperation(tabId, operation)) {
      this.completeTabRefresh(tabId, operation, false);
      return;
    }
    try {
      await this.dispatchRefresh(tabId, {
        type: "pin-op.refresh.execute",
        refreshGeneration: operation.pending.generation,
        mode: operation.pending.mode,
      });
    } catch (error) {
      this.report(error);
      this.completeTabRefresh(tabId, operation, false);
      return;
    }
    this.completeTabRefresh(
      tabId,
      operation,
      this.isCurrentRefreshOperation(tabId, operation),
    );
  }

  private isCurrentRefreshOperation(
    tabId: number,
    operation: TabRefreshOperation,
  ): boolean {
    return !operation.completed &&
      this.pendingRefreshes.get(tabId) === operation &&
      this.isCurrentPanelLifecycle(
        tabId,
        operation.windowId,
        operation.revision,
      ) &&
      this.participantWindows.get(tabId) === operation.windowId;
  }

  private cancelTabRefresh(tabId: number): void {
    const operation = this.pendingRefreshes.get(tabId);
    if (operation) this.completeTabRefresh(tabId, operation, false);
  }

  private completeTabRefresh(
    tabId: number,
    operation: TabRefreshOperation,
    accepted: boolean,
  ): void {
    if (operation.completed) return;
    operation.completed = true;
    if (this.pendingRefreshes.get(tabId) === operation) {
      this.pendingRefreshes.delete(tabId);
    }
    const callback = operation.onTabCompleted;
    if (!callback) return;
    const completion: TabRefreshCompletion = Object.freeze({
      tabId,
      windowId: operation.windowId,
      refreshGeneration: operation.pending.generation,
      mode: operation.pending.mode,
      accepted,
    });
    try {
      callback(completion);
    } catch (error) {
      this.report(error);
    }
  }

  private async rollbackRefreshAdmission(
    commits: readonly RefreshAdmissionCommit[],
  ): Promise<boolean> {
    let rolledBack = true;
    for (const commit of [...commits].reverse()) {
      let restored = false;
      try {
        await this.store.updateTab(commit.tabId, (current) => {
          if (sameDurableState(current, commit.before)) {
            restored = true;
            return undefined;
          }
          if (!sameDurableState(current, commit.after)) return undefined;
          restored = true;
          return commit.before;
        });
      } catch (error) {
        this.report(error);
        rolledBack = false;
      }
      if (!restored) rolledBack = false;
    }
    return rolledBack;
  }

  private async prepareControlledTransition(tabId: number): Promise<void> {
    const callback = this.beforeControlledTransition;
    if (!callback) return;
    try {
      const acknowledged = await callback(tabId);
      if (acknowledged === false) {
        this.report(new Error("Refresh cleanup was not acknowledged"));
      }
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
    const candidate = stateWatermark(state);
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
      watermarkModePrecedence(incoming.mode) >
        watermarkModePrecedence(current.mode));
}

function stateWatermark(state: TabRefreshState): WindowWatermark {
  return {
    generation: state.lastAcceptedGeneration,
    mode: state.lastAcceptedMode ??
      (state.lastAcceptedGeneration > 0 ? "unknown" : "styles"),
  };
}

function durableWatermarkSnapshot(
  state: TabRefreshState | undefined,
  remembered: WindowWatermark | undefined,
): Pick<TabRefreshState, "lastAcceptedGeneration" | "lastAcceptedMode"> {
  if (state) {
    const stored = stateWatermark(state);
    if (!remembered || !isNewerRefresh(remembered, stored)) {
      return {
        lastAcceptedGeneration: state.lastAcceptedGeneration,
        ...(state.lastAcceptedMode
          ? { lastAcceptedMode: state.lastAcceptedMode }
          : {}),
      };
    }
  }
  if (!remembered) {
    return { lastAcceptedGeneration: 0 };
  }
  return {
    lastAcceptedGeneration: remembered.generation,
    ...(remembered.mode !== "unknown" &&
        (remembered.generation > 0 || remembered.mode === "reload")
      ? { lastAcceptedMode: remembered.mode }
      : {}),
  };
}

function watermarkModePrecedence(mode: WindowWatermarkMode): number {
  switch (mode) {
    case "styles":
      return 0;
    case "reload":
      return 1;
    case "unknown":
      return 2;
  }
}

function durableSnapshot(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: false,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
    ...(state.lastAcceptedMode
      ? { lastAcceptedMode: state.lastAcceptedMode }
      : {}),
  });
}

function sameDurableState(
  value: TabRefreshState | undefined,
  expected: TabRefreshState,
): boolean {
  return value?.tabId === expected.tabId &&
    value.windowId === expected.windowId &&
    value.autoRefreshEnabled === expected.autoRefreshEnabled &&
    value.ideHighlightEnabled === expected.ideHighlightEnabled &&
    value.lastAcceptedGeneration === expected.lastAcceptedGeneration &&
    value.lastAcceptedMode === expected.lastAcceptedMode;
}

function stateSnapshot(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    tabId: state.tabId,
    windowId: state.windowId,
    autoRefreshEnabled: state.autoRefreshEnabled,
    ideHighlightEnabled: state.ideHighlightEnabled,
    participant: state.participant,
    lastAcceptedGeneration: state.lastAcceptedGeneration,
    ...(state.lastAcceptedMode
      ? { lastAcceptedMode: state.lastAcceptedMode }
      : {}),
    ...(state.pending
      ? { pending: Object.freeze({ ...state.pending }) }
      : {}),
  });
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
