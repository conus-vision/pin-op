import { describe, expect, it, vi } from "vitest";
import {
  PanelLayoutController,
  type PanelLayoutScheduler,
  type PanelResizeObserverEntryLike,
  type PanelResizeObserverFactory,
  type PanelResizeObserverLike,
  type PanelSessionStateStorage,
} from "../src/panelLayoutController.js";

describe("PanelLayoutController", () => {
  it.each([
    [679, 519, "tabs"],
    [679, 520, "stack"],
    [680, 519, "split"],
    [680, 520, "split"],
  ] as const)("selects the exact responsive mode at %d x %d", (width, height, mode) => {
    const harness = createHarness();
    harness.controller.start(harness.target);

    harness.resize(width, height);
    harness.flush();

    expect(harness.controller.snapshot()).toMatchObject({ width, height, mode });
  });

  it.each([
    ["tabs", 220, 520, 220, 300, 5],
    ["stack", 679, 520, 679, 480, 5],
    ["tabs", 679, 520, 679, 324, 5],
    ["stack", 679, 520, 679, 325, 5],
    ["tabs", 680, 519, 324, 519, 5],
    ["split", 680, 519, 325, 519, 5],
    ["tabs", 680, 519, 324, 325, 5],
    ["stack", 680, 520, 324, 325, 5],
    ["split", 680, 520, 325, 325, 5],
  ] as const)(
    "selects %s for a %dx%d viewport with a %dx%d workspace and %dpx separator",
    (
      mode,
      viewportWidth,
      viewportHeight,
      workspaceWidth,
      workspaceHeight,
      separatorExtent,
    ) => {
      const harness = createHarness();
      harness.controller.start(
        harness.target,
        harness.workspace,
        harness.separator,
      );
      const observer = harness.observers[0]!;

      observer.emit(harness.target, viewportWidth, viewportHeight);
      observer.emit(harness.workspace, workspaceWidth, workspaceHeight);
      observer.emit(harness.separator, separatorExtent, separatorExtent);
      harness.flush();

      expect(harness.controller.snapshot()).toMatchObject({
        width: viewportWidth,
        height: viewportHeight,
        workspaceWidth,
        workspaceHeight,
        mode,
        separator: {
          orientation: mode === "split"
            ? "vertical"
            : mode === "stack"
              ? "horizontal"
              : null,
        },
      });
    },
  );

  it("falls back to tabs when the workspace shrinks and safely re-enters stack", () => {
    const harness = createHarness();
    harness.controller.start(
      harness.target,
      harness.workspace,
      harness.separator,
    );
    const observer = harness.observers[0]!;
    observer.emit(harness.target, 679, 520);
    observer.emit(harness.workspace, 679, 480);
    observer.emit(harness.separator, 5, 5);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("stack");

    observer.emit(harness.workspace, 220, 300);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("tabs");

    observer.emit(harness.workspace, 679, 480);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("stack");
  });

  it("uses separator thickness rather than its cross-axis size", () => {
    const harness = createHarness();
    harness.controller.start(
      harness.target,
      harness.workspace,
      harness.separator,
    );
    const observer = harness.observers[0]!;
    observer.emit(harness.target, 800, 600);
    observer.emit(harness.workspace, 800, 600);
    observer.emit(harness.separator, 5, 600);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("split");

    observer.emit(harness.target, 679, 520);
    observer.emit(harness.workspace, 679, 480);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("stack");
  });

  it("retains measured separator thickness while tabs hide the separator", () => {
    const harness = createHarness();
    harness.controller.start(
      harness.target,
      harness.workspace,
      harness.separator,
    );
    const observer = harness.observers[0]!;
    observer.emit(harness.target, 679, 520);
    observer.emit(harness.workspace, 679, 322);
    observer.emit(harness.separator, 679, 5);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("tabs");

    observer.emit(harness.separator, 0, 0);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("tabs");

    observer.emit(harness.workspace, 679, 325);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("stack");
  });

  it("uses a safe separator fallback before its first visible measurement", () => {
    const harness = createHarness();
    harness.controller.start(
      harness.target,
      harness.workspace,
      harness.separator,
    );
    const observer = harness.observers[0]!;
    observer.emit(harness.target, 679, 520);
    observer.emit(harness.workspace, 679, 324);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("tabs");

    observer.emit(harness.workspace, 679, 325);
    harness.flush();
    expect(harness.controller.snapshot().mode).toBe("stack");
  });

  it.each([
    [Number.NaN, 600, 0, 600, "stack"],
    [Number.POSITIVE_INFINITY, 600, 0, 600, "stack"],
    [-1, 600, 0, 600, "stack"],
    [700, Number.NEGATIVE_INFINITY, 700, 0, "split"],
  ] as const)(
    "sanitizes hostile dimensions %s x %s",
    (width, height, expectedWidth, expectedHeight, mode) => {
      const harness = createHarness();
      harness.controller.start(harness.target);

      harness.resize(width, height);
      harness.flush();

      expect(harness.controller.snapshot()).toMatchObject({
        width: expectedWidth,
        height: expectedHeight,
        mode,
      });
    },
  );

  it("coalesces resize noise and publishes only the latest dimensions", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.controller.subscribe(listener);
    harness.controller.start(harness.target);

    harness.resize(400, 300);
    harness.resize(500, 600);
    harness.resize(900, 700);

    expect(listener).not.toHaveBeenCalled();
    expect(harness.scheduler.size()).toBe(1);
    harness.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      width: 900,
      height: 700,
      mode: "split",
    }));
  });

  it("ignores entries for another target and stale callbacks after rebind", () => {
    const harness = createHarness();
    const nextTarget = {};
    harness.controller.start(harness.target);
    const staleObserver = harness.observers[0]!;
    staleObserver.emit(harness.target, 900, 700);

    harness.controller.start(nextTarget);
    staleObserver.emit(harness.target, 1000, 800);
    harness.observers[1]!.emit({}, 700, 700);
    harness.observers[1]!.emit(nextTarget, 500, 600);
    harness.flush();

    expect(staleObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.controller.snapshot()).toMatchObject({
      width: 500,
      height: 600,
      mode: "stack",
    });
  });

  it("keeps a new target resize pending when an uncancelled old callback runs first", () => {
    const scheduler = new ManualScheduler();
    const observers: FakeResizeObserver[] = [];
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        const observer = new FakeResizeObserver(callback);
        observers.push(observer);
        return observer;
      },
      scheduler,
    });
    const oldTarget = {};
    const newTarget = {};
    controller.start(oldTarget);
    observers[0]!.emit(oldTarget, 900, 700);

    controller.start(newTarget);
    observers[1]!.emit(newTarget, 500, 600);
    expect(scheduler.callbacks).toHaveLength(2);

    scheduler.run(0);
    expect(controller.snapshot()).toMatchObject({ width: 0, height: 0 });
    scheduler.run(1);
    expect(controller.snapshot()).toMatchObject({
      width: 500,
      height: 600,
      mode: "stack",
    });
  });

  it("keeps an uncancelled scheduled callback inert after disposal", () => {
    const scheduler = new ManualScheduler();
    const observers: FakeResizeObserver[] = [];
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        const observer = new FakeResizeObserver(callback);
        observers.push(observer);
        return observer;
      },
      scheduler,
    });
    const target = {};
    controller.start(target);
    observers[0]!.emit(target, 900, 700);
    const disposedSnapshot = controller.snapshot();

    controller.dispose();
    scheduler.run(0);

    expect(controller.snapshot()).toBe(disposedSnapshot);
  });

  it("keeps a factory rebind authoritative before the old factory returns", () => {
    const scheduler = new FakeScheduler();
    const records: Array<{
      callback: (entries: readonly PanelResizeObserverEntryLike[]) => void;
      observer: FakeResizeObserver;
    }> = [];
    const oldTarget = {};
    const newTarget = {};
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        const observer = new FakeResizeObserver(callback);
        records.push({ callback, observer });
        factoryCalls += 1;
        if (factoryCalls === 1) {
          controller.start(newTarget);
        }
        return observer;
      },
      scheduler,
    });

    controller.start(oldTarget);
    expect(records).toHaveLength(2);
    expect(records[0]!.observer.observe).not.toHaveBeenCalled();
    expect(records[0]!.observer.disconnect).toHaveBeenCalledTimes(1);
    expect(records[1]!.observer.observe).toHaveBeenCalledWith(newTarget);

    records[0]!.callback([{
      target: oldTarget,
      contentRect: { width: 1000, height: 800 },
    }]);
    records[1]!.callback([{
      target: newTarget,
      contentRect: { width: 500, height: 600 },
    }]);
    scheduler.flush();
    expect(controller.snapshot()).toMatchObject({ width: 500, height: 600 });

    controller.dispose();
    expect(records[1]!.observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not install an observer returned after its factory disposes", () => {
    let controller: PanelLayoutController;
    let leakedCallback: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const observer = new FakeResizeObserver(() => undefined);
    controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        leakedCallback = callback;
        controller.dispose();
        return observer;
      },
    });
    const target = {};
    const snapshot = controller.snapshot();

    controller.start(target);
    leakedCallback!([{
      target,
      contentRect: { width: 900, height: 700 },
    }]);

    expect(observer.observe).not.toHaveBeenCalled();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toBe(snapshot);
  });

  it("does not let an old factory failure clear a newer binding", () => {
    const observers: PanelResizeObserverLike[] = [];
    const oldTarget = {};
    const newTarget = {};
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          controller.start(newTarget);
          throw new Error("old factory failed");
        }
        const observer = { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
    });

    controller.start(oldTarget);
    controller.dispose();

    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledWith(newTarget);
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps an observe-time rebind authoritative", () => {
    const callbacks: Array<(entries: readonly PanelResizeObserverEntryLike[]) => void> = [];
    const observers: PanelResizeObserverLike[] = [];
    const oldTarget = {};
    const newTarget = {};
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        callbacks.push(callback);
        factoryCalls += 1;
        const observer: PanelResizeObserverLike = factoryCalls === 1
          ? {
            observe: () => controller.start(newTarget),
            disconnect: vi.fn(),
          }
          : { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
      scheduler: new FakeScheduler(),
    });

    controller.start(oldTarget);
    expect(callbacks).toHaveLength(2);
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(observers[1]!.observe).toHaveBeenCalledWith(newTarget);

    controller.dispose();
    expect(observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not retain an observer when observe disposes the controller", () => {
    let controller: PanelLayoutController;
    let leakedCallback: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const disconnect = vi.fn();
    controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        leakedCallback = callback;
        return {
          observe: () => controller.dispose(),
          disconnect,
        };
      },
    });
    const target = {};
    const snapshot = controller.snapshot();

    controller.start(target);
    leakedCallback!([{
      target,
      contentRect: { width: 900, height: 700 },
    }]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toBe(snapshot);
  });

  it("allows a same-target retry after observe throws", () => {
    const observers: PanelResizeObserverLike[] = [];
    let factoryCalls = 0;
    const controller = new PanelLayoutController({
      createResizeObserver: () => {
        factoryCalls += 1;
        const observer: PanelResizeObserverLike = factoryCalls === 1
          ? {
            observe: () => { throw new Error("observe failed"); },
            disconnect: vi.fn(),
          }
          : { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
    });
    const target = {};

    expect(controller.start(target)).toBe(true);
    expect(controller.start(target)).toBe(true);

    expect(factoryCalls).toBe(2);
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(observers[1]!.observe).toHaveBeenCalledWith(target);
  });

  it("does not let an old observe failure clear a newer binding", () => {
    const observers: PanelResizeObserverLike[] = [];
    const oldTarget = {};
    const newTarget = {};
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: () => {
        factoryCalls += 1;
        const observer: PanelResizeObserverLike = factoryCalls === 1
          ? {
            observe: () => {
              controller.start(newTarget);
              throw new Error("old observe failed");
            },
            disconnect: vi.fn(),
          }
          : { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
    });

    controller.start(oldTarget);
    controller.dispose();

    expect(observers).toHaveLength(2);
    expect(observers[1]!.observe).toHaveBeenCalledWith(newTarget);
    expect(observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps a workspace-observe rebind authoritative", () => {
    const oldTarget = {};
    const oldWorkspace = {};
    const oldSeparator = {};
    const newTarget = {};
    const observers: PanelResizeObserverLike[] = [];
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: () => {
        factoryCalls += 1;
        const observer: PanelResizeObserverLike = factoryCalls === 1
          ? {
            observe: vi.fn((target: object) => {
              if (target === oldWorkspace) {
                controller.start(newTarget);
                throw new Error("old workspace observe failed");
              }
            }),
            disconnect: vi.fn(),
          }
          : { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
    });

    controller.start(oldTarget, oldWorkspace, oldSeparator);
    expect(observers).toHaveLength(2);
    const oldObserve = vi.mocked(observers[0]!.observe);
    expect(oldObserve).toHaveBeenCalledTimes(2);
    expect(oldObserve.mock.calls[0]?.[0]).toBe(oldTarget);
    expect(oldObserve.mock.calls[1]?.[0]).toBe(oldWorkspace);
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(observers[1]!.observe).toHaveBeenCalledWith(newTarget);

    controller.dispose();
    expect(observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps a reentrant disconnect binding authoritative and leaks no callback authority", () => {
    const scheduler = new FakeScheduler();
    const callbacks: Array<(entries: readonly PanelResizeObserverEntryLike[]) => void> = [];
    const observers: PanelResizeObserverLike[] = [];
    const firstTarget = {};
    const secondTarget = {};
    const newestTarget = {};
    let controller: PanelLayoutController;
    let factoryCalls = 0;
    controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        callbacks.push(callback);
        factoryCalls += 1;
        const observer: PanelResizeObserverLike = factoryCalls === 1
          ? {
            observe: vi.fn(),
            disconnect: () => {
              controller.start(newestTarget);
              throw new Error("disconnect failed");
            },
          }
          : { observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      },
      scheduler,
    });
    controller.start(firstTarget);

    controller.start(secondTarget);
    expect(observers).toHaveLength(2);
    expect(observers[1]!.observe).toHaveBeenCalledWith(newestTarget);

    callbacks[0]!([{
      target: firstTarget,
      contentRect: { width: 1000, height: 800 },
    }]);
    callbacks[1]!([{
      target: newestTarget,
      contentRect: { width: 500, height: 600 },
    }]);
    scheduler.flush();
    expect(controller.snapshot()).toMatchObject({ width: 500, height: 600 });
  });

  it("restores, clamps, and persists divider proportions rather than pixels", () => {
    const storage = new MemoryStorage("0.1");
    const harness = createHarness({ storage });
    harness.controller.start(harness.target);
    harness.resize(800, 600);
    harness.flush();

    expect(harness.controller.snapshot().dividerProportion).toBe(0.2);
    expect(harness.controller.setDividerFromPosition(640)).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBe(0.8);
    expect(storage.writes).toEqual([["pin-op.panel.layout.divider", "0.8"]]);
  });

  it("keeps both panes at least 160px at the narrowest viable dimensions", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(679, 520);
    harness.flush();

    expect(harness.controller.setDividerProportion(0.9)).toBe(true);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "stack",
      dividerProportion: 1 - 160 / 520,
    });

    harness.resize(680, 519);
    harness.flush();
    expect(harness.controller.setDividerProportion(0.9)).toBe(true);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "split",
      dividerProportion: 1 - 160 / 680,
    });
  });

  it.each([
    ["split", 712, 519, 707, 23, 77],
    ["stack", 679, 526, 521, 31, 69],
  ] as const)(
    "includes the measured separator in %s Home and End bounds",
    (mode, width, height, paneExtent, valueMin, valueMax) => {
      const harness = createHarness();
      harness.controller.start(
        harness.target,
        harness.workspace,
        harness.separator,
      );
      const observer = harness.observers[0]!;
      observer.emit(harness.target, width, height);
      observer.emit(harness.workspace, width, height);
      observer.emit(harness.separator, 5, 5);
      harness.flush();

      expect(harness.controller.snapshot().mode).toBe(mode);
      expect(harness.controller.handleSeparatorKey("Home")).toBe(true);
      expect(harness.controller.snapshot()).toMatchObject({
        dividerProportion: 160 / paneExtent,
        dividerPosition: 160,
        separator: {
          valueMin,
          valueMax,
          valueNow: valueMin,
        },
      });

      expect(harness.controller.handleSeparatorKey("End")).toBe(true);
      expect(harness.controller.snapshot()).toMatchObject({
        dividerProportion: 1 - 160 / paneExtent,
        dividerPosition: paneExtent - 160,
        separator: {
          valueMin,
          valueMax,
          valueNow: valueMax,
        },
      });
      expect(
        paneExtent -
          harness.controller.snapshot().dividerProportion * paneExtent,
      ).toBeCloseTo(160);
    },
  );

  it.each([
    ["garbage", 0.5],
    ["", 0.5],
    ["null", 0.5],
    ["2", 1],
    ["-2", 0],
    ["NaN", 0.5],
  ] as const)("validates stored divider value %j", (stored, expected) => {
    const harness = createHarness({ storage: new MemoryStorage(stored) });
    expect(harness.controller.snapshot().dividerProportion).toBe(expected);
  });

  it("survives storage read and write failures", () => {
    const storage: PanelSessionStateStorage = {
      getItem: () => { throw new Error("read failed"); },
      setItem: () => { throw new Error("write failed"); },
    };
    const harness = createHarness({ storage });

    expect(harness.controller.snapshot().dividerProportion).toBe(0.5);
    expect(() => harness.controller.setDividerProportion(0.75)).not.toThrow();
    expect(harness.controller.snapshot().dividerProportion).toBe(0.75);
  });

  it("rejects a non-string storage result without reading hostile properties", () => {
    const length = vi.fn(() => 3);
    const hostile = {};
    Object.defineProperty(hostile, "length", { get: length });
    const storage = {
      getItem: () => hostile,
      setItem: vi.fn(),
    } as unknown as PanelSessionStateStorage;

    expect(() => new PanelLayoutController({
      createResizeObserver: () => ({ observe() {}, disconnect() {} }),
      storage,
    })).not.toThrow();
    expect(length).not.toHaveBeenCalled();
  });

  it("preserves the selected tab while moving through every layout mode", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);

    expect(harness.controller.snapshot().activeTab).toBe("dom");
    expect(harness.controller.setActiveTab("source")).toBe(true);
    expect(harness.controller.setActiveTab("SOURCE")).toBe(false);
    expect(harness.controller.setActiveTab({ toString: () => "dom" })).toBe(false);

    harness.resize(680, 519);
    harness.flush();
    harness.resize(679, 520);
    harness.flush();
    harness.resize(679, 519);
    harness.flush();

    expect(harness.controller.snapshot()).toMatchObject({
      mode: "tabs",
      activeTab: "source",
    });
  });

  it("supports deterministic separator keyboard commands and accessible values", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(800, 600);
    harness.flush();

    expect(harness.controller.handleSeparatorKey("ArrowRight")).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBeCloseTo(0.52);
    expect(harness.controller.handleSeparatorKey("ArrowLeft", true)).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBeCloseTo(0.42);
    expect(harness.controller.handleSeparatorKey("Home")).toBe(true);
    expect(harness.controller.snapshot().separator).toEqual({
      enabled: true,
      orientation: "vertical",
      valueMin: 20,
      valueMax: 80,
      valueNow: 20,
      valueText: "20%",
    });
    expect(harness.controller.handleSeparatorKey("End")).toBe(true);
    expect(harness.controller.snapshot().separator.valueNow).toBe(80);
    expect(harness.controller.handleSeparatorKey("Enter")).toBe(false);

    harness.resize(679, 600);
    harness.flush();
    expect(harness.controller.snapshot().separator.orientation).toBe("horizontal");
  });

  it("moves Home and End to exact pane minimums when percentages are fractional", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(680, 519);
    harness.flush();

    expect(harness.controller.handleSeparatorKey("Home")).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBe(160 / 680);
    expect(harness.controller.handleSeparatorKey("End")).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBe(1 - 160 / 680);
  });

  it("accepts only horizontal arrows for a split layout", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(800, 600);
    harness.flush();
    const initial = harness.controller.snapshot().dividerProportion;

    expect(harness.controller.handleSeparatorKey("ArrowUp")).toBe(false);
    expect(harness.controller.handleSeparatorKey("ArrowDown")).toBe(false);
    expect(harness.controller.snapshot().dividerProportion).toBe(initial);
    expect(harness.controller.handleSeparatorKey("ArrowLeft")).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBeCloseTo(initial - 0.02);
  });

  it("accepts only vertical arrows for a stacked layout", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(679, 600);
    harness.flush();
    const initial = harness.controller.snapshot().dividerProportion;

    expect(harness.controller.handleSeparatorKey("ArrowLeft")).toBe(false);
    expect(harness.controller.handleSeparatorKey("ArrowRight")).toBe(false);
    expect(harness.controller.snapshot().dividerProportion).toBe(initial);
    expect(harness.controller.handleSeparatorKey("ArrowUp")).toBe(true);
    expect(harness.controller.snapshot().dividerProportion).toBeCloseTo(initial - 0.02);
  });

  it("accepts a synchronous scheduler without suppressing later resizes", () => {
    const observers: FakeResizeObserver[] = [];
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        const observer = new FakeResizeObserver(callback);
        observers.push(observer);
        return observer;
      },
      scheduler: {
        schedule(callback) {
          callback();
          return () => undefined;
        },
      },
    });
    const target = {};
    controller.start(target);

    observers[0]!.emit(target, 500, 600);
    observers[0]!.emit(target, 900, 400);

    expect(controller.snapshot()).toMatchObject({
      width: 900,
      height: 400,
      mode: "split",
    });
  });

  it("coalesces a resize emitted reentrantly by the scheduler", () => {
    let emit: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const target = {};
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        emit = callback;
        return { observe() {}, disconnect() {} };
      },
      scheduler: {
        schedule(callback) {
          emit!([{ target, contentRect: { width: 900, height: 400 } }]);
          callback();
          return () => undefined;
        },
      },
    });
    controller.start(target);

    emit!([{ target, contentRect: { width: 500, height: 600 } }]);

    expect(controller.snapshot()).toMatchObject({
      width: 900,
      height: 400,
      mode: "split",
    });
  });

  it("applies the pending resize when scheduling throws before the callback", () => {
    let emit: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const target = {};
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        emit = callback;
        return { observe() {}, disconnect() {} };
      },
      scheduler: {
        schedule() {
          throw new Error("schedule failed");
        },
      },
    });
    controller.start(target);

    expect(() => emit!([{
      target,
      contentRect: { width: 900, height: 400 },
    }])).not.toThrow();
    expect(controller.snapshot()).toMatchObject({ width: 900, height: 400 });
  });

  it("does not apply a resize twice when scheduling throws after the callback", () => {
    let emit: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const target = {};
    const listener = vi.fn();
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        emit = callback;
        return { observe() {}, disconnect() {} };
      },
      scheduler: {
        schedule(callback) {
          callback();
          throw new Error("late schedule failure");
        },
      },
    });
    controller.subscribe(listener);
    controller.start(target);

    expect(() => emit!([{
      target,
      contentRect: { width: 900, height: 400 },
    }])).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ width: 900, height: 400 });
  });

  it("disables separator commands in tabs mode", () => {
    const harness = createHarness();
    harness.controller.start(harness.target);
    harness.resize(500, 400);
    harness.flush();

    expect(harness.controller.handleSeparatorKey("ArrowRight")).toBe(false);
    expect(harness.controller.setDividerFromPosition(200)).toBe(false);
    expect(harness.controller.snapshot().separator.enabled).toBe(false);
  });

  it("returns deeply immutable snapshots", () => {
    const snapshot = createHarness().controller.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.separator)).toBe(true);
  });

  it("isolates listener failures and serializes reentrant updates", () => {
    const harness = createHarness();
    const observed: string[] = [];
    harness.controller.subscribe((snapshot) => {
      observed.push(`first:${snapshot.activeTab}`);
      if (snapshot.activeTab === "source") {
        harness.controller.setActiveTab("dom");
      }
      throw new Error("view failed");
    });
    harness.controller.subscribe((snapshot) => {
      observed.push(`second:${snapshot.activeTab}`);
    });

    expect(() => harness.controller.setActiveTab("source")).not.toThrow();
    expect(observed).toEqual([
      "first:source",
      "second:source",
      "first:dom",
      "second:dom",
    ]);
  });

  it("is idempotent and invokes no callbacks after disposal", () => {
    const harness = createHarness();
    const listener = vi.fn(() => harness.controller.dispose());
    const laterListener = vi.fn();
    harness.controller.subscribe(listener);
    harness.controller.subscribe(laterListener);

    expect(harness.controller.start(harness.target)).toBe(true);
    expect(harness.controller.start(harness.target)).toBe(true);
    expect(harness.observers).toHaveLength(1);
    harness.resize(900, 700);
    harness.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(laterListener).not.toHaveBeenCalled();

    const stale = harness.observers[0]!;
    const disposedSnapshot = harness.controller.snapshot();
    expect(() => harness.controller.dispose()).not.toThrow();
    stale.emit(harness.target, 400, 600);
    harness.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.controller.snapshot()).toBe(disposedSnapshot);
    expect(harness.controller.start({})).toBe(false);
    expect(harness.controller.setActiveTab("source")).toBe(false);
  });

  it("fails safely when observer construction, observation, or disconnection throws", () => {
    const target = {};
    const controller = new PanelLayoutController({
      createResizeObserver: () => { throw new Error("construct failed"); },
    });
    expect(() => controller.start(target)).not.toThrow();
    expect(controller.snapshot()).toMatchObject({
      mode: "tabs",
      width: 0,
      height: 0,
      dividerProportion: 0.5,
    });

    const failingObserver: PanelResizeObserverLike = {
      observe: () => { throw new Error("observe failed"); },
      disconnect: () => { throw new Error("disconnect failed"); },
    };
    const another = new PanelLayoutController({
      createResizeObserver: () => failingObserver,
    });
    expect(() => another.start({})).not.toThrow();
    expect(() => another.start({})).not.toThrow();
    expect(() => another.dispose()).not.toThrow();
  });

  it("remains disposable when scheduled-work cancellation throws", () => {
    let emit: ((entries: readonly PanelResizeObserverEntryLike[]) => void) | undefined;
    const controller = new PanelLayoutController({
      createResizeObserver: (callback) => {
        emit = callback;
        return { observe() {}, disconnect() {} };
      },
      scheduler: {
        schedule: () => () => { throw new Error("cancel failed"); },
      },
    });
    const target = {};
    controller.start(target);
    emit!([{ target, contentRect: { width: 700, height: 600 } }]);

    expect(() => controller.dispose()).not.toThrow();
  });
});

class FakeScheduler implements PanelLayoutScheduler {
  private readonly pending = new Set<() => void>();

  public schedule(callback: () => void): () => void {
    this.pending.add(callback);
    return () => this.pending.delete(callback);
  }

  public flush(): void {
    for (const callback of [...this.pending]) {
      this.pending.delete(callback);
      callback();
    }
  }

  public size(): number {
    return this.pending.size;
  }
}

class ManualScheduler implements PanelLayoutScheduler {
  public readonly callbacks: Array<() => void> = [];

  public schedule(callback: () => void): () => void {
    this.callbacks.push(callback);
    return () => undefined;
  }

  public run(index: number): void {
    this.callbacks[index]!();
  }
}

class FakeResizeObserver implements PanelResizeObserverLike {
  public readonly disconnect = vi.fn();
  public readonly observe = vi.fn();

  public constructor(
    private readonly callback: (entries: readonly PanelResizeObserverEntryLike[]) => void,
  ) {}

  public emit(target: object, width: number, height: number): void {
    this.callback([{ target, contentRect: { width, height } }]);
  }
}

class MemoryStorage implements PanelSessionStateStorage {
  public readonly writes: Array<[string, string]> = [];

  public constructor(private value: string | null = null) {}

  public getItem(): string | null {
    return this.value;
  }

  public setItem(key: string, value: string): void {
    this.value = value;
    this.writes.push([key, value]);
  }
}

function createHarness(options: { storage?: PanelSessionStateStorage } = {}) {
  const target = {};
  const workspace = {};
  const separator = {};
  const scheduler = new FakeScheduler();
  const observers: FakeResizeObserver[] = [];
  const createResizeObserver: PanelResizeObserverFactory = (callback) => {
    const observer = new FakeResizeObserver(callback);
    observers.push(observer);
    return observer;
  };
  const controller = new PanelLayoutController({
    createResizeObserver,
    scheduler,
    storage: options.storage,
  });
  return {
    controller,
    target,
    workspace,
    separator,
    scheduler,
    observers,
    resize(width: number, height: number): void {
      observers.at(-1)!.emit(target, width, height);
    },
    flush(): void {
      scheduler.flush();
    },
  };
}
