import type {
  Disposable,
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  RESOLUTION_LIMITS,
  type InspectMessage,
} from "@pin-op/protocol";
import {
  adaptSourceDocument,
  type TextDocumentLike,
} from "../sourcePlugins/sourceDocument.js";
import {
  reduceResolutionOutcome,
  type PresenterDocument,
  type PresenterOutcome,
} from "../sourcePlugins/resolutionOutcome.js";
import type {
  PluginResolutionCandidate,
  ResolvedPluginDiagnostic,
  SourcePluginDispatch,
  SourceResolution,
} from "../sourcePlugins/types.js";
import type { SelectionStore } from "./selectionStore.js";
import { visibleMatches } from "./visibleMatches.js";

export interface ActiveEditorLike {
  readonly document: TextDocumentLike;
}

export interface CoordinatorHost {
  getActiveEditor(): ActiveEditorLike | undefined;
  onDidChangeActiveEditor(
    listener: (editor: ActiveEditorLike | undefined) => void,
  ): Disposable;
  onDidChangeTextDocument(
    listener: (document: TextDocumentLike) => void,
  ): Disposable;
}

export interface SourcePluginRegistryLike {
  resolve(
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<SourcePluginDispatch>;
  onDidChange(listener: () => void): Disposable;
}

export interface CoordinatorPublication {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly editor?: ActiveEditorLike;
  readonly outcome: PresenterOutcome;
  readonly resolution?: SourceResolution;
}

export interface ActiveEditorCoordinatorOptions {
  readonly host: CoordinatorHost;
  readonly registry: SourcePluginRegistryLike;
  readonly workspace: SourceWorkspace;
  readonly store: SelectionStore;
  readonly publish: (
    editor: ActiveEditorLike,
    resolution: SourceResolution,
  ) => void;
  readonly onOutcome?: (publication: CoordinatorPublication) => void;
  readonly clear: () => void;
  readonly onError?: (error: unknown) => void;
  readonly editDebounceMs?: number;
}

export class ActiveEditorCoordinator implements Disposable {
  private readonly subscriptions: Disposable[];
  private readonly editDebounceMs: number;
  private workGeneration = 0;
  private resolutionGeneration = 0;
  private abort: AbortController | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  public constructor(
    private readonly options: ActiveEditorCoordinatorOptions,
  ) {
    this.editDebounceMs = options.editDebounceMs ?? 150;
    this.subscriptions = [
      options.host.onDidChangeActiveEditor(() => this.rerunImmediately()),
      options.host.onDidChangeTextDocument((document) =>
        this.handleDocumentChange(document),
      ),
      options.registry.onDidChange(() => this.rerunImmediately()),
    ];
  }

  public select(message: InspectMessage): void {
    if (this.disposed) return;
    this.options.store.replace(message);
    this.resolutionGeneration = 0;
    void this.refresh();
  }

  public clearSelection(): void {
    if (this.disposed) return;
    this.options.store.clear();
    this.clearEditTimer();
    this.invalidateCurrent();
  }

  public async refresh(): Promise<void> {
    if (this.disposed || !this.options.store.current()) return;
    this.clearEditTimer();
    const workGeneration = this.invalidateCurrent();
    await this.resolveCurrent(this.resolutionGeneration, workGeneration);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEditTimer();
    this.abort?.abort();
    this.abort = undefined;
    this.workGeneration += 1;
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private handleDocumentChange(document: TextDocumentLike): void {
    if (this.disposed || !this.options.store.current()) return;
    const active = this.options.host.getActiveEditor();
    if (!active || active.document.uri.toString() !== document.uri.toString()) {
      return;
    }

    this.advanceResolutionGeneration();
    this.clearEditTimer();
    const workGeneration = this.invalidateCurrent();
    const resolutionGeneration = this.resolutionGeneration;
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.resolveCurrent(resolutionGeneration, workGeneration);
    }, this.editDebounceMs);
  }

  private rerunImmediately(): void {
    if (this.disposed || !this.options.store.current()) return;
    this.advanceResolutionGeneration();
    void this.refresh();
  }

  private advanceResolutionGeneration(): void {
    this.resolutionGeneration = Math.min(
      this.resolutionGeneration + 1,
      RESOLUTION_LIMITS.generation,
    );
  }

  private invalidateCurrent(): number {
    this.abort?.abort();
    this.abort = undefined;
    this.workGeneration += 1;
    try {
      this.options.clear();
    } catch (error) {
      this.reportError(error);
    }
    return this.workGeneration;
  }

  private async resolveCurrent(
    resolutionGeneration: number,
    workGeneration: number,
  ): Promise<void> {
    if (this.disposed) return;
    const selection = this.options.store.current();
    if (!selection) return;
    const editor = this.options.host.getActiveEditor();
    const inaccessibleStylesheetCount = inaccessibleCount(selection);

    if (!editor) {
      this.publishCurrent(
        selection,
        resolutionGeneration,
        workGeneration,
        {
          outcome: reduceResolutionOutcome(
            [failureCandidate("no-active-editor")],
            { inaccessibleStylesheetCount },
          ),
        },
      );
      return;
    }

    const document = adaptSourceDocument(editor.document);
    const presenterDocument = summarizeDocument(document);
    const abort = new AbortController();
    this.abort = abort;

    try {
      const dispatch = await this.options.registry.resolve(
        selection,
        document,
        this.options.workspace,
        abort.signal,
      );
      if (!this.isCurrent(selection, workGeneration, abort.signal)) return;

      if (dispatch.kind === "unsupported-document") {
        const resolution = emptyResolution(selection, document);
        this.publishCurrent(
          selection,
          resolutionGeneration,
          workGeneration,
          {
            editor,
            resolution,
            outcome: reduceResolutionOutcome(
              [failureCandidate("unsupported-document")],
              { document: presenterDocument, inaccessibleStylesheetCount },
            ),
          },
        );
        return;
      }

      if (factCount(selection) === 0) {
        const resolution = { ...dispatch.resolution, matches: [] };
        this.publishCurrent(
          selection,
          resolutionGeneration,
          workGeneration,
          {
            editor,
            resolution,
            outcome: reduceResolutionOutcome(
              [failureCandidate("no-facts")],
              {
                document: presenterDocument,
                inaccessibleStylesheetCount,
                localDiagnostics: resolution.diagnostics,
              },
            ),
          },
        );
        return;
      }

      const visible = visibleMatches(dispatch.resolution.matches, document);
      const invalidDiagnostics = invalidRangeDiagnostics(
        visible.rejectedMatchCount,
      );
      const localDiagnostics = [
        ...dispatch.resolution.diagnostics,
        ...invalidDiagnostics,
      ];
      const resolution: SourceResolution = {
        ...dispatch.resolution,
        matches: visible.matches,
        diagnostics: localDiagnostics,
      };
      const outcome = reduceResolutionOutcome(dispatch.candidates, {
        document: presenterDocument,
        matches: visible.matches,
        inaccessibleStylesheetCount,
        localDiagnostics,
        rejectedMatchCount: visible.rejectedMatchCount,
      });
      this.publishCurrent(
        selection,
        resolutionGeneration,
        workGeneration,
        { editor, resolution, outcome },
      );
    } catch (error) {
      if (!this.isCurrent(selection, workGeneration, abort.signal)) return;
      this.reportError(error);
      const diagnostic: ResolvedPluginDiagnostic = {
        pluginId: "pinop.presenter",
        code: "plugin.exception",
        message: localErrorMessage(error),
        severity: "error",
      };
      const resolution: SourceResolution = {
        ...emptyResolution(selection, document),
        diagnostics: [diagnostic],
      };
      this.publishCurrent(
        selection,
        resolutionGeneration,
        workGeneration,
        {
          editor,
          resolution,
          outcome: reduceResolutionOutcome(
            [{ ...failureCandidate("error"), diagnostics: [diagnostic] }],
            {
              document: presenterDocument,
              inaccessibleStylesheetCount,
              localDiagnostics: [diagnostic],
            },
          ),
        },
      );
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private publishCurrent(
    selection: SelectionSnapshot,
    resolutionGeneration: number,
    workGeneration: number,
    publication: Omit<
      CoordinatorPublication,
      "inspectMessageId" | "resolutionGeneration"
    >,
  ): void {
    if (!this.isCurrent(selection, workGeneration)) return;
    if (publication.editor && publication.resolution) {
      try {
        this.options.publish(publication.editor, publication.resolution);
      } catch (error) {
        this.reportError(error);
      }
    }
    try {
      this.options.onOutcome?.({
        inspectMessageId: selection.messageId,
        resolutionGeneration,
        ...publication,
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A failing error reporter must not interrupt the current generation.
    }
  }

  private isCurrent(
    selection: SelectionSnapshot,
    workGeneration: number,
    signal?: AbortSignal,
  ): boolean {
    return !this.disposed &&
      signal?.aborted !== true &&
      workGeneration === this.workGeneration &&
      this.options.store.current()?.messageId === selection.messageId;
  }

  private clearEditTimer(): void {
    if (this.editTimer === undefined) return;
    clearTimeout(this.editTimer);
    this.editTimer = undefined;
  }
}

function failureCandidate(
  status: PluginResolutionCandidate["status"],
): PluginResolutionCandidate {
  return {
    pluginId: "pinop.presenter",
    status,
    matches: [],
    diagnostics: [],
  };
}

function emptyResolution(
  selection: SelectionSnapshot,
  document: SourceDocument,
): SourceResolution {
  return {
    selectionMessageId: selection.messageId,
    documentUri: document.uri,
    documentVersion: document.version,
    matches: [],
    diagnostics: [],
  };
}

function factCount(selection: SelectionSnapshot): number {
  return selection.targets.reduce(
    (count, target) => count + target.facts.length,
    0,
  );
}

function inaccessibleCount(selection: SelectionSnapshot): number {
  const value = selection.context.metadata.inaccessibleStylesheetCount;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? Math.min(value, RESOLUTION_LIMITS.count)
    : 0;
}

function summarizeDocument(document: SourceDocument): PresenterDocument {
  let label = "untitled";
  try {
    const parsed = new URL(document.uri);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (segment) label = decodeURIComponent(segment);
  } catch {
    const segment = document.uri.split(/[\\/]/).filter(Boolean).at(-1);
    if (segment) label = segment;
  }
  return { label, languageId: document.languageId || "unknown" };
}

function invalidRangeDiagnostics(
  rejectedMatchCount: number,
): readonly ResolvedPluginDiagnostic[] {
  if (rejectedMatchCount === 0) return [];
  return [{
    pluginId: "pinop.presenter",
    code: "plugin.invalidRange",
    message: `${rejectedMatchCount} source match range(s) were outside the active document`,
    severity: "warning",
  }];
}

function localErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.stack ?? error.message
    : String(error);
}
