export type PanelLayoutMode = "split" | "stack" | "tabs";
export type PanelLayoutTab = "dom" | "source";

export interface PanelLayoutSeparatorModel {
  readonly enabled: boolean;
  readonly orientation: "vertical" | "horizontal" | null;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly valueNow: number;
  readonly valueText: string;
}

export interface PanelLayoutSnapshot {
  readonly mode: PanelLayoutMode;
  readonly width: number;
  readonly height: number;
  readonly workspaceWidth: number;
  readonly workspaceHeight: number;
  readonly activeTab: PanelLayoutTab;
  readonly dividerProportion: number;
  readonly dividerPosition: number;
  readonly separator: PanelLayoutSeparatorModel;
}

export interface PanelResizeObserverEntryLike {
  readonly target: object;
  readonly contentRect: {
    readonly width: number;
    readonly height: number;
  };
}

export interface PanelResizeObserverLike {
  observe(target: object): void;
  disconnect(): void;
}

export type PanelResizeObserverFactory = (
  callback: (entries: readonly PanelResizeObserverEntryLike[]) => void,
) => PanelResizeObserverLike;

export interface PanelLayoutScheduler {
  schedule(callback: () => void): () => void;
}

export interface PanelSessionStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PanelLayoutControllerOptions {
  readonly createResizeObserver: PanelResizeObserverFactory;
  readonly scheduler?: PanelLayoutScheduler;
  readonly storage?: PanelSessionStateStorage;
  readonly storageKey?: string;
}

interface ScheduledResizeCell {
  readonly binding: ObserverBindingCell;
  pending: LayoutMeasurementUpdate | undefined;
  cancel: (() => void) | undefined;
}

interface ObserverBindingCell {
  readonly generation: number;
  readonly target: object;
  readonly workspaceTarget: object;
  readonly separatorTarget: object | undefined;
  observer: PanelResizeObserverLike | undefined;
  handle: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
}

interface LayoutDimensions {
  readonly width: number;
  readonly height: number;
}

interface LayoutMeasurementUpdate {
  readonly viewport?: LayoutDimensions;
  readonly workspace?: LayoutDimensions;
  readonly separator?: LayoutDimensions;
}

const SPLIT_WIDTH = 680;
const STACK_HEIGHT = 520;
const MIN_PANE_PIXELS = 160;
const NORMAL_KEY_STEP = 0.02;
const FAST_KEY_STEP = 0.1;
const DEFAULT_DIVIDER = 0.5;
const FALLBACK_SEPARATOR_PIXELS = 5;
const DEFAULT_STORAGE_KEY = "pin-op.panel.layout.divider";

const defaultScheduler: PanelLayoutScheduler = Object.freeze({
  schedule(callback: () => void): () => void {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        callback();
      }
    });
    return () => {
      active = false;
    };
  },
});

export class PanelLayoutController {
  private readonly listeners = new Set<(snapshot: PanelLayoutSnapshot) => void>();
  private readonly scheduler: PanelLayoutScheduler;
  private readonly storageKey: string;
  private current: PanelLayoutSnapshot;
  private activeTab: PanelLayoutTab = "dom";
  private dividerProportion: number;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private workspaceWidth = 0;
  private workspaceHeight = 0;
  private separatorThickness = 0;
  private observerBinding: ObserverBindingCell | undefined;
  private bindingGeneration = 0;
  private scheduledResize: ScheduledResizeCell | undefined;
  private readonly notificationQueue: PanelLayoutSnapshot[] = [];
  private notifying = false;
  private disposed = false;

  public constructor(private readonly options: PanelLayoutControllerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.dividerProportion = this.restoreDivider();
    this.current = createSnapshot(
      0,
      0,
      0,
      0,
      0,
      this.activeTab,
      this.dividerProportion,
    );
  }

  public start(
    target: object,
    workspaceTarget: object = target,
    separatorTarget?: object,
  ): boolean {
    if (
      this.disposed ||
      !isObject(target) ||
      !isObject(workspaceTarget) ||
      (separatorTarget !== undefined && !isObject(separatorTarget))
    ) {
      return false;
    }
    const previous = this.observerBinding;
    if (
      previous?.target === target &&
      previous.workspaceTarget === workspaceTarget &&
      previous.separatorTarget === separatorTarget
    ) {
      return true;
    }

    const binding: ObserverBindingCell = {
      generation: ++this.bindingGeneration,
      target,
      workspaceTarget,
      separatorTarget,
      observer: undefined,
      handle: undefined,
    };
    this.observerBinding = binding;
    if (previous) {
      this.retireObserverBinding(previous);
    }
    if (!this.isCurrentBinding(binding)) {
      return true;
    }

    this.resetMeasurements(binding.separatorTarget !== undefined);
    if (!this.isCurrentBinding(binding)) {
      return true;
    }

    binding.handle = (entries) => {
      this.acceptResizeEntries(binding, entries);
    };
    const callback = (entries: readonly PanelResizeObserverEntryLike[]) => {
      binding.handle?.(entries);
    };

    let observer: PanelResizeObserverLike | undefined;
    try {
      observer = this.options.createResizeObserver(callback);
    } catch {
      this.retireObserverBinding(binding);
      return true;
    }
    if (!this.isCurrentBinding(binding)) {
      binding.handle = undefined;
      this.disconnectDetachedObserver(observer);
      return true;
    }

    binding.observer = observer;
    for (const observedTarget of uniqueTargets(binding)) {
      try {
        observer.observe(observedTarget);
      } catch {
        this.retireObserverBinding(binding);
        return true;
      }
      if (!this.isCurrentBinding(binding)) {
        return true;
      }
    }
    return true;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bindingGeneration += 1;
    const binding = this.observerBinding;
    if (binding) {
      this.retireObserverBinding(binding);
    }
    this.listeners.clear();
    this.notificationQueue.length = 0;
  }

  public snapshot(): PanelLayoutSnapshot {
    return this.current;
  }

  public subscribe(
    listener: (snapshot: PanelLayoutSnapshot) => void,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setActiveTab(value: unknown): boolean {
    if (this.disposed || (value !== "dom" && value !== "source")) {
      return false;
    }
    if (value === this.activeTab) {
      return true;
    }
    this.activeTab = value;
    this.publish(this.createCurrentSnapshot());
    return true;
  }

  public setDividerProportion(value: number): boolean {
    if (this.disposed || !Number.isFinite(value)) {
      return false;
    }
    const next = clampDivider(
      clamp(value, 0, 1),
      this.current.mode,
      this.workspaceWidth,
      this.workspaceHeight,
      this.currentSeparatorExtent(),
    );
    this.setDivider(next, true);
    return true;
  }

  public setDividerFromPosition(position: number): boolean {
    if (
      this.disposed
      || !this.current.separator.enabled
      || !Number.isFinite(position)
    ) {
      return false;
    }
    const extent = paneExtent(
      this.current.mode,
      this.workspaceWidth,
      this.workspaceHeight,
      this.currentSeparatorExtent(),
    );
    if (extent <= 0) {
      return false;
    }
    const centeredPosition = position - this.currentSeparatorExtent() / 2;
    return this.setDividerProportion(centeredPosition / extent);
  }

  public handleSeparatorKey(key: unknown, faster = false): boolean {
    if (
      this.disposed
      || !this.current.separator.enabled
      || typeof key !== "string"
      || typeof faster !== "boolean"
    ) {
      return false;
    }
    const bounds = dividerBounds(paneExtent(
      this.current.mode,
      this.workspaceWidth,
      this.workspaceHeight,
      this.currentSeparatorExtent(),
    ));
    if (key === "Home") {
      return this.setDividerProportion(bounds.minimum);
    }
    if (key === "End") {
      return this.setDividerProportion(bounds.maximum);
    }
    const direction = this.current.mode === "split"
      ? key === "ArrowLeft"
        ? -1
        : key === "ArrowRight"
          ? 1
          : 0
      : key === "ArrowUp"
        ? -1
        : key === "ArrowDown"
          ? 1
          : 0;
    if (direction === 0) {
      return false;
    }
    const step = faster ? FAST_KEY_STEP : NORMAL_KEY_STEP;
    return this.setDividerProportion(this.dividerProportion + direction * step);
  }

  private acceptResizeEntries(
    binding: ObserverBindingCell,
    entries: readonly PanelResizeObserverEntryLike[],
  ): void {
    if (!this.isCurrentBinding(binding)) {
      return;
    }
    let latest: LayoutMeasurementUpdate | undefined;
    try {
      for (const entry of entries) {
        const dimensions = {
          width: sanitizeDimension(entry.contentRect.width),
          height: sanitizeDimension(entry.contentRect.height),
        };
        if (entry.target === binding.target) {
          latest = {
            ...latest,
            viewport: dimensions,
          };
        }
        if (entry.target === binding.workspaceTarget) {
          latest = {
            ...latest,
            workspace: dimensions,
          };
        }
        if (entry.target === binding.separatorTarget) {
          latest = {
            ...latest,
            separator: dimensions,
          };
        }
      }
    } catch {
      return;
    }
    if (!latest || !this.isCurrentBinding(binding)) {
      return;
    }
    const currentSchedule = this.scheduledResize;
    if (
      currentSchedule
      && currentSchedule.binding === binding
    ) {
      currentSchedule.pending = mergeMeasurements(
        currentSchedule.pending,
        latest,
      );
      return;
    }

    const schedule: ScheduledResizeCell = {
      binding,
      pending: latest,
      cancel: undefined,
    };
    this.scheduledResize = schedule;
    try {
      let completedSynchronously = false;
      const cancel = this.scheduler.schedule(() => {
        completedSynchronously = true;
        this.flushScheduledResize(schedule);
      });
      if (
        !completedSynchronously
        && this.scheduledResize === schedule
        && this.isCurrentBinding(binding)
      ) {
        schedule.cancel = cancel;
      }
    } catch {
      this.flushScheduledResize(schedule);
    }
  }

  private flushScheduledResize(schedule: ScheduledResizeCell): void {
    if (
      this.scheduledResize !== schedule
      || !this.isCurrentBinding(schedule.binding)
    ) {
      return;
    }
    this.scheduledResize = undefined;
    const resize = schedule.pending;
    schedule.pending = undefined;
    schedule.cancel = undefined;
    if (!resize) {
      return;
    }
    this.applyMeasurements(resize);
  }

  private applyMeasurements(update: LayoutMeasurementUpdate): void {
    if (update.viewport) {
      this.viewportWidth = update.viewport.width;
      this.viewportHeight = update.viewport.height;
    }
    if (update.workspace) {
      this.workspaceWidth = update.workspace.width;
      this.workspaceHeight = update.workspace.height;
    }
    if (update.separator) {
      const thickness = measuredSeparatorThickness(
        this.current.mode,
        update.separator.width,
        update.separator.height,
      );
      if (thickness > 0) {
        this.separatorThickness = thickness;
      }
    }
    const mode = selectMode(
      this.viewportWidth,
      this.viewportHeight,
      this.workspaceWidth,
      this.workspaceHeight,
      this.separatorThickness,
    );
    this.dividerProportion = clampDivider(
      this.dividerProportion,
      mode,
      this.workspaceWidth,
      this.workspaceHeight,
      separatorExtent(mode, this.separatorThickness),
    );
    this.publish(this.createCurrentSnapshot());
  }

  private setDivider(value: number, persist: boolean): void {
    if (value === this.dividerProportion) {
      return;
    }
    this.dividerProportion = value;
    if (persist) {
      try {
        this.options.storage?.setItem(this.storageKey, String(value));
      } catch {
        // Session persistence is optional; layout state remains usable in memory.
      }
    }
    this.publish(this.createCurrentSnapshot());
  }

  private resetMeasurements(hasSeparator: boolean): void {
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.workspaceWidth = 0;
    this.workspaceHeight = 0;
    this.separatorThickness = hasSeparator ? FALLBACK_SEPARATOR_PIXELS : 0;
    this.publish(this.createCurrentSnapshot());
  }

  private createCurrentSnapshot(): PanelLayoutSnapshot {
    return createSnapshot(
      this.viewportWidth,
      this.viewportHeight,
      this.workspaceWidth,
      this.workspaceHeight,
      this.separatorThickness,
      this.activeTab,
      this.dividerProportion,
    );
  }

  private currentSeparatorExtent(): number {
    return separatorExtent(this.current.mode, this.separatorThickness);
  }

  private restoreDivider(): number {
    let stored: string | null | undefined;
    try {
      stored = this.options.storage?.getItem(this.storageKey);
    } catch {
      return DEFAULT_DIVIDER;
    }
    if (typeof stored !== "string" || stored.length === 0) {
      return DEFAULT_DIVIDER;
    }
    try {
      const parsed: unknown = JSON.parse(stored);
      return typeof parsed === "number" && Number.isFinite(parsed)
        ? clamp(parsed, 0, 1)
        : DEFAULT_DIVIDER;
    } catch {
      return DEFAULT_DIVIDER;
    }
  }

  private retireObserverBinding(binding: ObserverBindingCell): void {
    if (this.observerBinding === binding) {
      this.observerBinding = undefined;
    }
    binding.handle = undefined;
    const schedule = this.scheduledResize;
    if (schedule?.binding === binding && this.scheduledResize === schedule) {
      this.scheduledResize = undefined;
      const cancel = schedule.cancel;
      schedule.pending = undefined;
      schedule.cancel = undefined;
      try {
        cancel?.();
      } catch {
        // Removing the current cell first makes a leaked callback inert.
      }
    }
    const observer = binding.observer;
    binding.observer = undefined;
    if (observer) {
      this.disconnectDetachedObserver(observer);
    }
  }

  private disconnectDetachedObserver(observer: PanelResizeObserverLike): void {
    try {
      observer.disconnect();
    } catch {
      // Its binding handle was cleared before this external call.
    }
  }

  private isCurrentBinding(binding: ObserverBindingCell): boolean {
    return !this.disposed
      && this.observerBinding === binding
      && binding.generation === this.bindingGeneration;
  }

  private publish(snapshot: PanelLayoutSnapshot): void {
    if (this.disposed || snapshotsEqual(this.current, snapshot)) {
      return;
    }
    this.current = snapshot;
    this.notificationQueue.push(snapshot);
    if (this.notifying) {
      return;
    }
    this.notifying = true;
    try {
      while (!this.disposed && this.notificationQueue.length > 0) {
        const next = this.notificationQueue.shift()!;
        for (const listener of [...this.listeners]) {
          if (this.disposed) {
            break;
          }
          if (!this.listeners.has(listener)) {
            continue;
          }
          try {
            listener(next);
          } catch {
            // A failed view must not prevent other panel surfaces from updating.
          }
        }
      }
    } finally {
      this.notifying = false;
      if (this.disposed) {
        this.notificationQueue.length = 0;
      }
    }
  }
}

function createSnapshot(
  width: number,
  height: number,
  workspaceWidth: number,
  workspaceHeight: number,
  separatorThickness: number,
  activeTab: PanelLayoutTab,
  dividerProportion: number,
): PanelLayoutSnapshot {
  const mode = selectMode(
    width,
    height,
    workspaceWidth,
    workspaceHeight,
    separatorThickness,
  );
  const measuredSeparator = separatorExtent(mode, separatorThickness);
  const availablePaneExtent = paneExtent(
    mode,
    workspaceWidth,
    workspaceHeight,
    measuredSeparator,
  );
  const separator = createSeparator(
    mode,
    availablePaneExtent,
    dividerProportion,
  );
  return Object.freeze({
    mode,
    width,
    height,
    workspaceWidth,
    workspaceHeight,
    activeTab,
    dividerProportion,
    dividerPosition: availablePaneExtent * dividerProportion,
    separator,
  });
}

function createSeparator(
  mode: PanelLayoutMode,
  availablePaneExtent: number,
  dividerProportion: number,
): PanelLayoutSeparatorModel {
  const bounds = dividerBounds(availablePaneExtent);
  const valueNow = Math.round(dividerProportion * 100);
  return Object.freeze({
    enabled: mode !== "tabs",
    orientation: mode === "split" ? "vertical" : mode === "stack" ? "horizontal" : null,
    valueMin: Math.round(bounds.minimum * 100),
    valueMax: Math.round(bounds.maximum * 100),
    valueNow,
    valueText: `${valueNow}%`,
  });
}

function selectMode(
  width: number,
  height: number,
  workspaceWidth: number,
  workspaceHeight: number,
  separatorThickness: number,
): PanelLayoutMode {
  if (width >= SPLIT_WIDTH) {
    return panesFit(workspaceWidth, separatorThickness) ? "split" : "tabs";
  }
  return height >= STACK_HEIGHT && panesFit(workspaceHeight, separatorThickness)
    ? "stack"
    : "tabs";
}

function panesFit(workspaceExtent: number, measuredSeparator: number): boolean {
  return workspaceExtent >= MIN_PANE_PIXELS * 2 + measuredSeparator;
}

function clampDivider(
  value: number,
  mode: PanelLayoutMode,
  width: number,
  height: number,
  measuredSeparator: number,
): number {
  if (mode === "tabs") {
    return clamp(value, 0, 1);
  }
  const bounds = dividerBounds(paneExtent(
    mode,
    width,
    height,
    measuredSeparator,
  ));
  return clamp(value, bounds.minimum, bounds.maximum);
}

function dividerBounds(extent: number): { minimum: number; maximum: number } {
  if (extent < MIN_PANE_PIXELS * 2) {
    return { minimum: DEFAULT_DIVIDER, maximum: DEFAULT_DIVIDER };
  }
  const minimum = MIN_PANE_PIXELS / extent;
  return { minimum, maximum: 1 - minimum };
}

function axisExtent(
  mode: PanelLayoutMode,
  width: number,
  height: number,
): number {
  return mode === "split" ? width : mode === "stack" ? height : 0;
}

function paneExtent(
  mode: PanelLayoutMode,
  width: number,
  height: number,
  measuredSeparator: number,
): number {
  return Math.max(0, axisExtent(mode, width, height) - measuredSeparator);
}

function separatorExtent(mode: PanelLayoutMode, thickness: number): number {
  return mode === "tabs" ? 0 : thickness;
}

function measuredSeparatorThickness(
  mode: PanelLayoutMode,
  width: number,
  height: number,
): number {
  if (mode === "split") {
    return width;
  }
  if (mode === "stack") {
    return height;
  }
  if (width <= 0) {
    return height;
  }
  if (height <= 0) {
    return width;
  }
  return Math.min(width, height);
}

function mergeMeasurements(
  current: LayoutMeasurementUpdate | undefined,
  next: LayoutMeasurementUpdate,
): LayoutMeasurementUpdate {
  return {
    ...current,
    ...next,
  };
}

function uniqueTargets(binding: ObserverBindingCell): readonly object[] {
  const targets = [binding.target];
  if (binding.workspaceTarget !== binding.target) {
    targets.push(binding.workspaceTarget);
  }
  if (
    binding.separatorTarget !== undefined &&
    !targets.includes(binding.separatorTarget)
  ) {
    targets.push(binding.separatorTarget);
  }
  return targets;
}

function sanitizeDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function snapshotsEqual(
  left: PanelLayoutSnapshot,
  right: PanelLayoutSnapshot,
): boolean {
  return left.mode === right.mode
    && left.width === right.width
    && left.height === right.height
    && left.workspaceWidth === right.workspaceWidth
    && left.workspaceHeight === right.workspaceHeight
    && left.activeTab === right.activeTab
    && left.dividerProportion === right.dividerProportion
    && left.dividerPosition === right.dividerPosition
    && left.separator.valueMin === right.separator.valueMin
    && left.separator.valueMax === right.separator.valueMax
    && left.separator.valueNow === right.separator.valueNow;
}
