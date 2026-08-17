import type { RefreshMode } from "@pin-op/plugin-api";
import type { RefreshClassifierRegistry } from "./refreshClassifierRegistry.js";

const DIRECT_SETTLE_MS = 150;
const PREPROCESSOR_QUIET_MS = 750;
const PREPROCESSOR_MAX_MS = 2_000;
const PREPROCESSOR_SUFFIXES = [".scss", ".sass", ".less"] as const;

export interface RefreshCandidateSink {
  publish(mode: RefreshMode): void;
}

export interface RefreshDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
}

export interface RefreshDocumentChangeEventLike {
  readonly document: RefreshDocumentLike;
  readonly contentChanges: readonly unknown[];
}

export interface DisposableLike {
  dispose(): void;
}

export interface SaveObserverEventSink extends DisposableLike {
  onDidChangeTextDocument(event: RefreshDocumentChangeEventLike): void;
  onDidSaveTextDocument(document: RefreshDocumentLike): void;
  onDidCloseTextDocument(document: RefreshDocumentLike): void;
  onDidGeneratedCssFileEvent(): void;
}

export interface GeneratedCssWatcherLike extends DisposableLike {
  onDidCreate(listener: () => void): DisposableLike;
  onDidChange(listener: () => void): DisposableLike;
  onDidDelete(listener: () => void): DisposableLike;
}

export interface SaveObserverEventHost {
  onDidChangeTextDocument(
    listener: (event: RefreshDocumentChangeEventLike) => void,
  ): DisposableLike;
  onDidSaveTextDocument(
    listener: (document: RefreshDocumentLike) => void,
  ): DisposableLike;
  onDidCloseTextDocument(
    listener: (document: RefreshDocumentLike) => void,
  ): DisposableLike;
  createFileSystemWatcher(pattern: string): GeneratedCssWatcherLike;
}

export interface SaveObserverOptions {
  readonly classifierRegistry: RefreshClassifierRegistry;
  readonly sink: RefreshCandidateSink;
  readonly now?: () => number;
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class SaveObserver {
  private readonly dirtyUris = new Set<string>();
  private readonly scheduleTimer: NonNullable<SaveObserverOptions["setTimeout"]>;
  private readonly cancelTimer: NonNullable<SaveObserverOptions["clearTimeout"]>;
  private readonly clock: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingMode: RefreshMode | undefined;
  private preprocessorDeadline: number | undefined;
  private disposed = false;

  public constructor(private readonly options: SaveObserverOptions) {
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
    this.clock = options.now ?? Date.now;
  }

  public onDidChangeTextDocument(
    event: RefreshDocumentChangeEventLike,
  ): void {
    if (this.disposed) return;
    if (event.contentChanges.length > 0) {
      this.dirtyUris.add(event.document.uri.toString());
    }
  }

  public onDidSaveTextDocument(document: RefreshDocumentLike): void {
    if (this.disposed) return;
    const uri = document.uri.toString();
    if (!this.dirtyUris.delete(uri)) return;

    const mode = this.options.classifierRegistry.classify({
      uri,
      languageId: document.languageId,
    });
    if (!mode) return;

    this.pendingMode = strongerMode(this.pendingMode, mode);
    let settleMs = DIRECT_SETTLE_MS;
    if (this.pendingMode === "reload") {
      this.preprocessorDeadline = undefined;
    } else if (isPreprocessorUri(uri)) {
      const now = this.clock();
      this.preprocessorDeadline ??= now + PREPROCESSOR_MAX_MS;
      settleMs = Math.min(
        PREPROCESSOR_QUIET_MS,
        Math.max(0, this.preprocessorDeadline - now),
      );
    }
    this.schedule(settleMs);
  }

  public onDidCloseTextDocument(document: RefreshDocumentLike): void {
    if (this.disposed) return;
    this.dirtyUris.delete(document.uri.toString());
  }

  public onDidGeneratedCssFileEvent(): void {
    if (this.disposed) return;
    if (this.preprocessorDeadline === undefined || !this.pendingMode) return;
    this.schedule(Math.min(
      DIRECT_SETTLE_MS,
      Math.max(0, this.preprocessorDeadline - this.clock()),
    ));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    this.timer = undefined;
    this.pendingMode = undefined;
    this.preprocessorDeadline = undefined;
    this.dirtyUris.clear();
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    this.timer = this.scheduleTimer(() => {
      this.timer = undefined;
      const pendingMode = this.pendingMode;
      this.pendingMode = undefined;
      this.preprocessorDeadline = undefined;
      if (pendingMode) this.options.sink.publish(pendingMode);
    }, delay);
  }
}

export function bindSaveObserverEvents(
  host: SaveObserverEventHost,
  observer: SaveObserverEventSink,
): readonly DisposableLike[] {
  const watcher = host.createFileSystemWatcher("**/*.css");
  return [
    observer,
    host.onDidChangeTextDocument((event) =>
      observer.onDidChangeTextDocument(event)
    ),
    host.onDidSaveTextDocument((document) =>
      observer.onDidSaveTextDocument(document)
    ),
    host.onDidCloseTextDocument((document) =>
      observer.onDidCloseTextDocument(document)
    ),
    watcher,
    watcher.onDidCreate(() => observer.onDidGeneratedCssFileEvent()),
    watcher.onDidChange(() => observer.onDidGeneratedCssFileEvent()),
    watcher.onDidDelete(() => observer.onDidGeneratedCssFileEvent()),
  ];
}

function isPreprocessorUri(uri: string): boolean {
  try {
    const pathname = new URL(uri).pathname.toLowerCase();
    return PREPROCESSOR_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
  } catch {
    return false;
  }
}

function strongerMode(
  current: RefreshMode | undefined,
  candidate: RefreshMode,
): RefreshMode {
  return current === "reload" || candidate === "reload" ? "reload" : "styles";
}
