import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { RefreshClassifierRegistry } from "../src/refresh/refreshClassifierRegistry.js";
import {
  SaveObserver,
  bindSaveObserverEvents,
  type DisposableLike,
  type RefreshDocumentChangeEventLike,
  type RefreshDocumentLike,
} from "../src/refresh/saveObserver.js";

describe("SaveObserver", () => {
  it("publishes styles 150 ms after a changed CSS document is saved", () => {
    const harness = createHarness();
    const css = document("file:///workspace/app.css", "css");

    harness.observer.onDidChangeTextDocument({
      document: css,
      contentChanges: [{}],
    });
    harness.observer.onDidSaveTextDocument(css);

    harness.advance(149);
    expect(harness.publish).not.toHaveBeenCalled();

    harness.advance(1);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith("styles");
  });

  it("ignores unchanged saves and document events without content changes", () => {
    const harness = createHarness();
    const css = document("file:///workspace/app.css", "css");

    harness.observer.onDidSaveTextDocument(css);
    harness.observer.onDidChangeTextDocument({
      document: css,
      contentChanges: [],
    });
    harness.observer.onDidSaveTextDocument(css);
    harness.advance(1_000);

    expect(harness.publish).not.toHaveBeenCalled();
  });

  it("consumes a dirty marker on the first save", () => {
    const harness = createHarness();
    const css = document("file:///workspace/app.css", "css");

    harness.observer.onDidChangeTextDocument({
      document: css,
      contentChanges: [{}],
    });
    harness.observer.onDidSaveTextDocument(css);
    harness.observer.onDidSaveTextDocument(css);
    harness.advance(150);

    expect(harness.publish).toHaveBeenCalledTimes(1);
  });

  it("clears a dirty marker when its document closes", () => {
    const harness = createHarness();
    const css = document("file:///workspace/app.css", "css");

    harness.observer.onDidChangeTextDocument({
      document: css,
      contentChanges: [{}],
    });
    harness.observer.onDidCloseTextDocument(css);
    harness.observer.onDidSaveTextDocument(css);
    harness.advance(150);

    expect(harness.publish).not.toHaveBeenCalled();
  });

  it.each([
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "vue",
    "php",
    "html",
  ])(
    "publishes reload 150 ms after a changed .%s save",
    (extension) => {
      const harness = createHarness();
      const script = document(
        `file:///workspace/app.${extension}`,
        extension,
      );

      changeAndSave(harness.observer, script);
      harness.advance(149);
      expect(harness.publish).not.toHaveBeenCalled();
      harness.advance(1);

      expect(harness.publish).toHaveBeenCalledWith("reload");
    },
  );

  it("uses the same save callback for Auto Save", () => {
    const harness = createHarness();
    const script = document("file:///workspace/auto.ts", "typescript");

    changeAndSave(harness.observer, script);
    harness.advance(150);

    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledWith("reload");
  });

  it("settles non-preprocessor custom styles after 150 ms", () => {
    const harness = createHarness();
    harness.classifierRegistry.register({
      id: "fixture.custom-styles",
      classify: ({ uri }) =>
        uri.endsWith(".customstyle") ? "styles" : undefined,
    });
    const component = document(
      "file:///workspace/App.customstyle",
      "customstyle",
    );

    changeAndSave(harness.observer, component);
    harness.advance(149);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.publish).toHaveBeenCalledWith("styles");
  });

  it("classifies canonical URI and language through its exact registry", () => {
    const harness = createHarness();
    const classify = vi.spyOn(harness.classifierRegistry, "classify");
    const css = document(
      "file:///workspace/folder%20name/app.css",
      "css",
    );

    changeAndSave(harness.observer, css);

    expect(classify).toHaveBeenCalledWith({
      uri: "file:///workspace/folder%20name/app.css",
      languageId: "css",
    });
  });

  it("uses a monotonic clock by default", () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_234);
    const timer = 1 as ReturnType<typeof setTimeout>;
    const scheduleTimer = vi.fn(() => timer);
    const observer = new SaveObserver({
      classifierRegistry: new RefreshClassifierRegistry(),
      sink: { publish: vi.fn() },
      setTimeout: scheduleTimer,
      clearTimeout: vi.fn(),
    });

    try {
      changeAndSave(
        observer,
        document("file:///workspace/app.scss", "scss"),
      );

      expect(monotonicNow).toHaveBeenCalled();
      expect(scheduleTimer).toHaveBeenCalledWith(expect.any(Function), 750);
    } finally {
      observer.dispose();
      monotonicNow.mockRestore();
    }
  });

  it("coalesces direct saves without downgrading reload to styles", () => {
    const harness = createHarness();
    const script = document("file:///workspace/app.ts", "typescript");
    const css = document("file:///workspace/app.css", "css");

    changeAndSave(harness.observer, script);
    harness.advance(50);
    changeAndSave(harness.observer, css);
    harness.advance(149);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith("reload");
    harness.advance(1_000);
    expect(harness.publish).toHaveBeenCalledTimes(1);
  });

  it.each(["scss", "sass", "less"])(
    "waits 750 ms of quiet after a changed .%s save",
    (extension) => {
      const harness = createHarness();
      const source = document(
        `file:///workspace/app.${extension}`,
        extension,
      );

      changeAndSave(harness.observer, source);
      harness.advance(749);
      expect(harness.publish).not.toHaveBeenCalled();
      harness.advance(1);

      expect(harness.publish).toHaveBeenCalledOnce();
      expect(harness.publish).toHaveBeenCalledWith("styles");
    },
  );

  it("settles 150 ms after generated CSS changes in an open build window", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");

    changeAndSave(harness.observer, source);
    harness.advance(700);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(149);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledWith("styles");
  });

  it("dispatches by the initial two-second deadline despite repeated CSS events", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");

    changeAndSave(harness.observer, source);
    for (let elapsed = 140; elapsed <= 1_960; elapsed += 140) {
      harness.advance(140);
      harness.observer.onDidGeneratedCssFileEvent();
      expect(harness.pendingTimerCount()).toBe(1);
    }
    harness.advance(39);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.now()).toBe(2_000);
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledWith("styles");
  });

  it("does not extend the initial deadline after repeated preprocessor saves", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.less", "less");

    changeAndSave(harness.observer, source);
    harness.advance(700);
    changeAndSave(harness.observer, source);
    harness.advance(700);
    changeAndSave(harness.observer, source);
    harness.advance(599);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.now()).toBe(2_000);
    expect(harness.publish).toHaveBeenCalledOnce();
  });

  it.each([
    ["direct CSS", document("file:///workspace/generated.css", "css")],
    [
      "custom styles",
      document("file:///workspace/App.customstyle", "customstyle"),
    ],
  ])(
    "clamps a pending %s save to the initial preprocessor deadline",
    (kind, styleDocument) => {
      const harness = createHarness();
      if (kind === "custom styles") {
        harness.classifierRegistry.register({
          id: "fixture.custom-styles-deadline",
          classify: ({ uri }) => uri.endsWith(".customstyle")
            ? "styles"
            : undefined,
        });
      }
      const source = document("file:///workspace/app.scss", "scss");

      changeAndSave(harness.observer, source);
      harness.advance(700);
      changeAndSave(harness.observer, source);
      harness.advance(700);
      changeAndSave(harness.observer, source);
      harness.advance(550);
      changeAndSave(harness.observer, styleDocument);
      harness.advance(49);
      expect(harness.publish).not.toHaveBeenCalled();
      harness.advance(1);

      expect(harness.now()).toBe(2_000);
      expect(harness.publish).toHaveBeenCalledOnce();
      expect(harness.publish).toHaveBeenCalledWith("styles");
    },
  );

  it("ignores generated CSS events outside a preprocessor build window", () => {
    const harness = createHarness();

    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(1_000);

    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("does not let an open build window or CSS output delay reload", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");
    const script = document("file:///workspace/app.ts", "typescript");

    changeAndSave(harness.observer, source);
    harness.advance(500);
    changeAndSave(harness.observer, script);
    harness.advance(100);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(49);
    expect(harness.publish).not.toHaveBeenCalled();
    harness.advance(1);

    expect(harness.now()).toBe(650);
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledWith("reload");
    harness.advance(2_000);
    expect(harness.publish).toHaveBeenCalledOnce();
  });

  it("covers CSS before reload dispatch and closes the retained window silently", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");
    const script = document("file:///workspace/app.ts", "typescript");

    changeAndSave(harness.observer, source);
    harness.advance(500);
    changeAndSave(harness.observer, script);
    harness.advance(100);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(50);

    expect(harness.now()).toBe(650);
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.publish).toHaveBeenCalledWith("reload");
    expect(harness.pendingTimerCount()).toBe(1);

    harness.advance(1_349);
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.pendingTimerCount()).toBe(1);
    harness.advance(1);

    expect(harness.now()).toBe(2_000);
    expect(harness.publish).toHaveBeenCalledOnce();
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("emits late CSS after reload at 150 ms clamped to the original deadline", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");
    const script = document("file:///workspace/app.ts", "typescript");

    changeAndSave(harness.observer, source);
    harness.advance(500);
    changeAndSave(harness.observer, script);
    harness.advance(150);
    expect(harness.publish).toHaveBeenLastCalledWith("reload");
    expect(harness.pendingTimerCount()).toBe(1);

    harness.advance(1_300);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(49);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    harness.advance(1);

    expect(harness.now()).toBe(2_000);
    expect(harness.publish.mock.calls).toEqual([["reload"], ["styles"]]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it.each([
    ["direct CSS", document("file:///workspace/unrelated.css", "css"), 150],
    [
      "custom styles",
      document("file:///workspace/App.customstyle", "customstyle"),
      150,
    ],
    ["preprocessor", document("file:///workspace/other.less", "less"), 750],
  ])(
    "keeps a retained build window after an ordinary %s dispatch",
    (kind, styleDocument, settleMs) => {
      const harness = createHarness();
      if (kind === "custom styles") {
        harness.classifierRegistry.register({
          id: "fixture.custom-styles-retained-window",
          classify: ({ uri }) => uri.endsWith(".customstyle")
            ? "styles"
            : undefined,
        });
      }
      const source = document("file:///workspace/app.scss", "scss");
      const script = document("file:///workspace/app.ts", "typescript");

      changeAndSave(harness.observer, source);
      harness.advance(500);
      changeAndSave(harness.observer, script);
      harness.advance(150);
      expect(harness.publish.mock.calls).toEqual([["reload"]]);

      harness.advance(50);
      changeAndSave(harness.observer, styleDocument);
      harness.advance(settleMs);
      expect(harness.publish.mock.calls).toEqual([["reload"], ["styles"]]);
      expect(harness.pendingTimerCount()).toBe(1);

      harness.advance(100);
      harness.observer.onDidGeneratedCssFileEvent();
      harness.advance(149);
      expect(harness.publish).toHaveBeenCalledTimes(2);
      harness.advance(1);

      expect(harness.publish.mock.calls).toEqual([
        ["reload"],
        ["styles"],
        ["styles"],
      ]);
      expect(harness.pendingTimerCount()).toBe(0);
    },
  );

  it("keeps a generated event as the closing cause through a direct save", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");
    const script = document("file:///workspace/app.ts", "typescript");
    const css = document("file:///workspace/unrelated.css", "css");

    changeAndSave(harness.observer, source);
    harness.advance(500);
    changeAndSave(harness.observer, script);
    harness.advance(150);

    harness.advance(350);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(50);
    changeAndSave(harness.observer, css);
    harness.advance(149);
    expect(harness.publish.mock.calls).toEqual([["reload"]]);
    harness.advance(1);

    expect(harness.publish.mock.calls).toEqual([["reload"], ["styles"]]);
    expect(harness.pendingTimerCount()).toBe(0);

    harness.advance(100);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(1_000);
    expect(harness.publish).toHaveBeenCalledTimes(2);
  });

  it("lets a newer preprocessor save replace a generated closing cause", () => {
    const harness = createHarness();
    const source = document("file:///workspace/app.scss", "scss");
    const script = document("file:///workspace/app.ts", "typescript");

    changeAndSave(harness.observer, source);
    harness.advance(500);
    changeAndSave(harness.observer, script);
    harness.advance(150);

    harness.advance(350);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(50);
    changeAndSave(harness.observer, source);
    harness.advance(749);
    expect(harness.publish.mock.calls).toEqual([["reload"]]);
    harness.advance(1);

    expect(harness.now()).toBe(1_800);
    expect(harness.publish.mock.calls).toEqual([["reload"], ["styles"]]);
    expect(harness.pendingTimerCount()).toBe(1);

    harness.advance(100);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(99);
    expect(harness.publish).toHaveBeenCalledTimes(2);
    harness.advance(1);

    expect(harness.now()).toBe(2_000);
    expect(harness.publish.mock.calls).toEqual([
      ["reload"],
      ["styles"],
      ["styles"],
    ]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("disposes every timer and state idempotently", () => {
    const harness = createHarness();
    const classify = vi.spyOn(harness.classifierRegistry, "classify");
    const pending = document("file:///workspace/pending.scss", "scss");
    const dirty = document("file:///workspace/dirty.ts", "typescript");

    changeAndSave(harness.observer, pending);
    harness.observer.onDidChangeTextDocument({
      document: dirty,
      contentChanges: [{}],
    });
    expect(harness.pendingTimerCount()).toBe(1);

    harness.observer.dispose();
    harness.observer.dispose();
    expect(harness.pendingTimerCount()).toBe(0);

    harness.observer.onDidSaveTextDocument(dirty);
    changeAndSave(harness.observer, pending);
    harness.observer.onDidGeneratedCssFileEvent();
    harness.advance(3_000);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.pendingTimerCount()).toBe(0);
  });
});

describe("bindSaveObserverEvents", () => {
  it("binds one CSS watcher and returns every disposable", () => {
    const documentChanges = eventSource<RefreshDocumentChangeEventLike>();
    const documentSaves = eventSource<RefreshDocumentLike>();
    const documentCloses = eventSource<RefreshDocumentLike>();
    const cssCreates = eventSource<void>();
    const cssChanges = eventSource<void>();
    const cssDeletes = eventSource<void>();
    const watcherDispose = vi.fn();
    const observer = {
      onDidChangeTextDocument: vi.fn(),
      onDidSaveTextDocument: vi.fn(),
      onDidCloseTextDocument: vi.fn(),
      onDidGeneratedCssFileEvent: vi.fn(),
      dispose: vi.fn(),
    };
    const createFileSystemWatcher = vi.fn(() => ({
      onDidCreate: cssCreates.subscribe,
      onDidChange: cssChanges.subscribe,
      onDidDelete: cssDeletes.subscribe,
      dispose: watcherDispose,
    }));

    const disposables = bindSaveObserverEvents({
      onDidChangeTextDocument: documentChanges.subscribe,
      onDidSaveTextDocument: documentSaves.subscribe,
      onDidCloseTextDocument: documentCloses.subscribe,
      createFileSystemWatcher,
    }, observer);
    const css = document("file:///workspace/app.css", "css");
    const change = { document: css, contentChanges: [{}] };
    documentChanges.fire(change);
    documentSaves.fire(css);
    documentCloses.fire(css);
    cssCreates.fire();
    cssChanges.fire();
    cssDeletes.fire();

    expect(createFileSystemWatcher).toHaveBeenCalledOnce();
    expect(createFileSystemWatcher).toHaveBeenCalledWith("**/*.css");
    expect(observer.onDidChangeTextDocument).toHaveBeenCalledWith(change);
    expect(observer.onDidSaveTextDocument).toHaveBeenCalledWith(css);
    expect(observer.onDidCloseTextDocument).toHaveBeenCalledWith(css);
    expect(observer.onDidGeneratedCssFileEvent).toHaveBeenCalledTimes(3);
    expect(disposables).toHaveLength(8);

    for (const disposable of disposables) disposable.dispose();
    expect(observer.dispose).toHaveBeenCalledOnce();
    expect(watcherDispose).toHaveBeenCalledOnce();
    expect(documentChanges.listenerCount()).toBe(0);
    expect(documentSaves.listenerCount()).toBe(0);
    expect(documentCloses.listenerCount()).toBe(0);
    expect(cssCreates.listenerCount()).toBe(0);
    expect(cssChanges.listenerCount()).toBe(0);
    expect(cssDeletes.listenerCount()).toBe(0);
  });
});

function createHarness() {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<
    number,
    { readonly callback: () => void; readonly dueAt: number }
  >();
  const publish = vi.fn();
  const classifierRegistry = new RefreshClassifierRegistry();
  const observer = new SaveObserver({
    classifierRegistry,
    sink: { publish },
    now: () => now,
    setTimeout(callback, delay) {
      const timerId = ++nextTimerId;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      timers.delete(timer as unknown as number);
    },
  });

  return {
    observer,
    publish,
    classifierRegistry,
    now: () => now,
    pendingTimerCount: () => timers.size,
    advance(duration: number): void {
      const target = now + duration;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) =>
            left[1].dueAt - right[1].dueAt || left[0] - right[0]
          )[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
  };
}

function changeAndSave(
  observer: SaveObserver,
  changedDocument: ReturnType<typeof document>,
): void {
  observer.onDidChangeTextDocument({
    document: changedDocument,
    contentChanges: [{}],
  });
  observer.onDidSaveTextDocument(changedDocument);
}

function document(uri: string, languageId: string) {
  return {
    uri: { toString: () => uri },
    languageId,
  };
}

function eventSource<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe(listener: (event: T) => void): DisposableLike {
      listeners.add(listener);
      return {
        dispose: () => listeners.delete(listener),
      };
    },
    fire(event: T): void {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}
