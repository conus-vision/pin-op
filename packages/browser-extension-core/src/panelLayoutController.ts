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
  readonly activeTab: PanelLayoutTab;
  readonly dividerProportion: number;
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
  readonly generation: number;
  readonly target: object;
  pending: { width: number; height: number } | undefined;
  cancel: (() => void) | undefined;
}

const SPLIT_WIDTH = 680;
const STACK_HEIGHT = 520;
const MIN_PANE_PIXELS = 160;
const NORMAL_KEY_STEP = 0.02;
const FAST_KEY_STEP = 0.1;
const DEFAULT_DIVIDER = 0.5;
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
  private target: object | undefined;
  private observer: PanelResizeObserverLike | undefined;
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
      this.activeTab,
      this.dividerProportion,
    );
  }

  public start(target: object): boolean {
    if (this.disposed || !isObject(target)) {
      return false;
    }
    if (this.target === target) {
      return true;
    }

    this.detachObserver();
    this.target = target;
    const generation = ++this.bindingGeneration;
    this.applyDimensions(0, 0);

    let observer: PanelResizeObserverLike | undefined;
    try {
      observer = this.options.createResizeObserver((entries) => {
        this.acceptResizeEntries(generation, target, entries);
      });
      this.observer = observer;
      observer.observe(target);
    } catch {
      this.observer = undefined;
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          // An unavailable observer leaves the controller at its safe default.
        }
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
    this.detachObserver();
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
    this.publish(createSnapshot(
      this.current.width,
      this.current.height,
      this.activeTab,
      this.dividerProportion,
    ));
    return true;
  }

  public setDividerProportion(value: number): boolean {
    if (this.disposed || !Number.isFinite(value)) {
      return false;
    }
    const next = clampDivider(
      clamp(value, 0, 1),
      this.current.mode,
      this.current.width,
      this.current.height,
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
    const extent = currentExtent(
      this.current.mode,
      this.current.width,
      this.current.height,
    );
    if (extent <= 0) {
      return false;
    }
    return this.setDividerProportion(position / extent);
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
    const bounds = dividerBounds(currentExtent(
      this.current.mode,
      this.current.width,
      this.current.height,
    ));
    if (key === "Home") {
      return this.setDividerProportion(bounds.minimum);
    }
    if (key === "End") {
      return this.setDividerProportion(bounds.maximum);
    }
    const direction = key === "ArrowLeft" || key === "ArrowUp"
      ? -1
      : key === "ArrowRight" || key === "ArrowDown"
        ? 1
        : 0;
    if (direction === 0) {
      return false;
    }
    const step = faster ? FAST_KEY_STEP : NORMAL_KEY_STEP;
    return this.setDividerProportion(this.dividerProportion + direction * step);
  }

  private acceptResizeEntries(
    generation: number,
    target: object,
    entries: readonly PanelResizeObserverEntryLike[],
  ): void {
    if (
      this.disposed
      || generation !== this.bindingGeneration
      || target !== this.target
    ) {
      return;
    }
    let latest: { width: number; height: number } | undefined;
    try {
      for (const entry of entries) {
        if (entry.target === target) {
          latest = {
            width: sanitizeDimension(entry.contentRect.width),
            height: sanitizeDimension(entry.contentRect.height),
          };
        }
      }
    } catch {
      return;
    }
    if (!latest) {
      return;
    }
    const currentSchedule = this.scheduledResize;
    if (
      currentSchedule
      && currentSchedule.generation === generation
      && currentSchedule.target === target
    ) {
      currentSchedule.pending = latest;
      return;
    }

    const schedule: ScheduledResizeCell = {
      generation,
      target,
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
      if (!completedSynchronously && this.scheduledResize === schedule) {
        schedule.cancel = cancel;
      }
    } catch {
      this.flushScheduledResize(schedule);
    }
  }

  private flushScheduledResize(schedule: ScheduledResizeCell): void {
    if (
      this.scheduledResize !== schedule
      || this.disposed
      || schedule.generation !== this.bindingGeneration
      || schedule.target !== this.target
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
    this.applyDimensions(resize.width, resize.height);
  }

  private applyDimensions(width: number, height: number): void {
    const safeWidth = sanitizeDimension(width);
    const safeHeight = sanitizeDimension(height);
    const mode = selectMode(safeWidth, safeHeight);
    this.dividerProportion = clampDivider(
      this.dividerProportion,
      mode,
      safeWidth,
      safeHeight,
    );
    this.publish(createSnapshot(
      safeWidth,
      safeHeight,
      this.activeTab,
      this.dividerProportion,
    ));
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
    this.publish(createSnapshot(
      this.current.width,
      this.current.height,
      this.activeTab,
      this.dividerProportion,
    ));
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

  private detachObserver(): void {
    const schedule = this.scheduledResize;
    if (schedule && this.scheduledResize === schedule) {
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
    const observer = this.observer;
    this.observer = undefined;
    this.target = undefined;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        // A detached callback is authority-inert through its generation token.
      }
    }
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
  activeTab: PanelLayoutTab,
  dividerProportion: number,
): PanelLayoutSnapshot {
  const mode = selectMode(width, height);
  const separator = createSeparator(mode, width, height, dividerProportion);
  return Object.freeze({
    mode,
    width,
    height,
    activeTab,
    dividerProportion,
    separator,
  });
}

function createSeparator(
  mode: PanelLayoutMode,
  width: number,
  height: number,
  dividerProportion: number,
): PanelLayoutSeparatorModel {
  const extent = currentExtent(mode, width, height);
  const bounds = dividerBounds(extent);
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

function selectMode(width: number, height: number): PanelLayoutMode {
  if (width >= SPLIT_WIDTH) {
    return "split";
  }
  return height >= STACK_HEIGHT ? "stack" : "tabs";
}

function clampDivider(
  value: number,
  mode: PanelLayoutMode,
  width: number,
  height: number,
): number {
  if (mode === "tabs") {
    return clamp(value, 0, 1);
  }
  const bounds = dividerBounds(currentExtent(mode, width, height));
  return clamp(value, bounds.minimum, bounds.maximum);
}

function dividerBounds(extent: number): { minimum: number; maximum: number } {
  if (extent < MIN_PANE_PIXELS * 2) {
    return { minimum: DEFAULT_DIVIDER, maximum: DEFAULT_DIVIDER };
  }
  const minimum = MIN_PANE_PIXELS / extent;
  return { minimum, maximum: 1 - minimum };
}

function currentExtent(
  mode: PanelLayoutMode,
  width: number,
  height: number,
): number {
  return mode === "split" ? width : mode === "stack" ? height : 0;
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
    && left.activeTab === right.activeTab
    && left.dividerProportion === right.dividerProportion;
}
