import type * as vscode from "vscode";
import type {
  PinOpApi,
  Disposable,
  SourcePosition,
  SourceRange,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  RESOLUTION_LIMITS,
  type ResolutionDiagnosticCode,
  type InspectMessage,
  type PresentationSettingsMessage,
  type SourceNavigateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type {
  ResolutionInput,
  SourceMatchesInput,
  SourceNavigationStateInput,
} from "../bridgeClient.js";
import type { DiagnosticsTracker } from "../diagnostics.js";
import { RefreshClassifierRegistry } from "../refresh/refreshClassifierRegistry.js";
import { createPinOpApi } from "../sourcePlugins/api.js";
import { CssSourcePlugin } from "../sourcePlugins/cssSourcePlugin.js";
import { SourcePluginRegistry } from "../sourcePlugins/registry.js";
import { ScssSourcePlugin } from "../sourcePlugins/scssSourcePlugin.js";
import {
  toProtocolResolution,
  type PresenterOutcome,
} from "../sourcePlugins/resolutionOutcome.js";
import {
  VsCodeSourceWorkspace,
  type WorkspaceHost,
} from "../sourcePlugins/sourceWorkspace.js";
import type { SourceResolution } from "../sourcePlugins/types.js";
import {
  ActiveEditorCoordinator,
  type ActiveEditorLike,
  type CoordinatorInvalidation,
  type CoordinatorPublication,
  type CoordinatorHost,
} from "./activeEditorCoordinator.js";
import {
  ApplicableSourcesTreeDataProvider,
  type ApplicableSourcesTreeOptions,
} from "./applicableSourcesTree.js";
import { registerPresenterCommands } from "./commands.js";
import {
  SourceDecorationManager,
  type DecorationRole,
  type DisposableLike,
  type SourceDecorationEditorLike,
  type SourceDecorationHost,
} from "./decorations.js";
import { HighlightController } from "./highlightController.js";
import { SelectionStore } from "./selectionStore.js";
import {
  SourceExcerptRegistry,
  type SourceExcerptPublication,
} from "./sourceExcerptRegistry.js";
import {
  SourceNavigator,
  type SourceNavigationEditor,
  type SourceNavigationHost,
} from "./sourceNavigator.js";

export type PresenterEditorLike =
  & ActiveEditorLike
  & SourceDecorationEditorLike
  & SourceNavigationEditor;

export interface PresenterRuntimeHost
  extends CoordinatorHost,
    WorkspaceHost,
    SourceDecorationHost {
  getActiveEditor(): PresenterEditorLike | undefined;
  createThemeIcon(id: string): vscode.ThemeIcon;
  registerTreeDataProvider(
    provider: ApplicableSourcesTreeDataProvider,
  ): DisposableLike;
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
  getPrimaryCursor(editor: PresenterEditorLike): SourcePosition;
  setPrimaryCursor(
    editor: PresenterEditorLike,
    position: SourcePosition,
  ): void;
  onDidChangePrimaryCursor(listener: () => void): DisposableLike;
  revealRange(editor: PresenterEditorLike, range: unknown): void;
  reportError(error: unknown): void;
}

export interface PresenterRuntimeOptions {
  readonly host: PresenterRuntimeHost;
  readonly registry?: SourcePluginRegistry;
  readonly refreshClassifierRegistry?: RefreshClassifierRegistry;
  readonly workspace?: SourceWorkspace;
  readonly diagnostics?: Pick<
    DiagnosticsTracker,
    "recordResolution" | "clearResolution"
  >;
  readonly sendResolution?: (resolution: ResolutionInput) => void;
  readonly sendSourceMatches?: (matches: SourceMatchesInput) => void;
  readonly measureSourceMatchesEnvelope?: (
    matches: SourceMatchesInput,
  ) => number;
  readonly sendSourceNavigationState?: (
    state: SourceNavigationStateInput,
  ) => void;
}

export interface PresenterRuntime extends DisposableLike {
  readonly api: PinOpApi;
  readonly tree: ApplicableSourcesTreeDataProvider;
  select(message: InspectMessage): void;
  navigate(message: SourceNavigateMessage): void;
  open(message: SourceOpenMessage): void;
  applyPresentationSettings(message: PresentationSettingsMessage): void;
  clear(): void;
}

export function createPresenterRuntime(
  options: PresenterRuntimeOptions,
): PresenterRuntime {
  const { host } = options;
  const registry = options.registry ?? new SourcePluginRegistry();
  const refreshClassifierRegistry = options.refreshClassifierRegistry ??
    new RefreshClassifierRegistry();
  const api = createPinOpApi(registry, refreshClassifierRegistry);
  const builtIns: Disposable[] = [
    registry.register(new CssSourcePlugin()),
    registry.register(new ScssSourcePlugin()),
  ];
  const workspace = options.workspace ?? new VsCodeSourceWorkspace(host);
  const treeOptions: ApplicableSourcesTreeOptions = {
    createThemeIcon: (id) => host.createThemeIcon(id),
  };
  const tree = new ApplicableSourcesTreeDataProvider(treeOptions);
  const decorations = new SourceDecorationManager(host);
  const highlights = new HighlightController(decorations);
  const sourceExcerpts = new SourceExcerptRegistry({
    ...(options.measureSourceMatchesEnvelope
      ? { measureEnvelopeBytes: options.measureSourceMatchesEnvelope }
      : {}),
  });
  const sourceNavigator = new SourceNavigator(
    createSourceNavigationHost(host),
    {
      sendSourceNavigationState(state) {
        runSink(host, () => options.sendSourceNavigationState?.(state));
      },
    },
  );
  const treeRegistration = host.registerTreeDataProvider(tree);
  const commandRegistration = registerPresenterCommands(
    {
      registerCommand: (command, callback) =>
        host.registerCommand(command, callback),
      getActiveEditor: () => host.getActiveEditor(),
      createRange: (range: SourceRange) => createHostRange(host, range),
      revealRange: (editor, range) =>
        host.revealRange(editor as PresenterEditorLike, range),
      selectRangeStart: (editor, start) =>
        host.setPrimaryCursor(editor as PresenterEditorLike, start),
    },
    tree,
    (error) => reportSafely(host, error),
  );
  const store = new SelectionStore();
  const publish = (
    editor: ActiveEditorLike,
    resolution: SourceResolution,
  ): void => {
    runSink(host, () => tree.update(resolution));
    runSink(host, () =>
      highlights.update(editor as PresenterEditorLike, resolution)
    );
  };
  const clear = (invalidation?: CoordinatorInvalidation): void => {
    runSink(host, () => tree.clear());
    runSink(host, () => highlights.clear());
    runSink(host, () => options.diagnostics?.clearResolution());
    let empty: SourceMatchesInput | undefined;
    runSink(host, () => {
      empty = sourceExcerpts.invalidate(invalidation
        ? {
            inspectMessageId: invalidation.inspectMessageId,
            resolutionGeneration: invalidation.resolutionGeneration,
            ...(invalidation.editor
              ? { editor: invalidation.editor as PresenterEditorLike }
              : {}),
          }
        : undefined);
    });
    if (empty) {
      const emptySourceMatches = empty;
      runSink(host, () => options.sendSourceMatches?.(emptySourceMatches));
    }
    const navigationInvalidation = empty ?? invalidation;
    runSink(host, () => sourceNavigator.invalidate(navigationInvalidation
      ? {
          inspectMessageId: navigationInvalidation.inspectMessageId,
          resolutionGeneration: navigationInvalidation.resolutionGeneration,
        }
      : undefined));
  };
  const coordinator = new ActiveEditorCoordinator({
    host,
    registry,
    workspace,
    store,
    publish,
    onOutcome(publication) {
      const sourcePublication = createSourcePublication(
        sourceExcerpts,
        publication,
      );
      const outcome = withExcerptReadDiagnostic(
        publication.outcome,
        sourcePublication.excerptReadFailed,
      );
      runSink(host, () => {
        options.diagnostics?.recordResolution(
          outcome,
          publication.resolutionGeneration,
          publication.resolution,
        );
      });
      runSink(host, () => {
        options.sendResolution?.({
          inspectMessageId: publication.inspectMessageId,
          resolutionGeneration: publication.resolutionGeneration,
          ...toProtocolResolution(outcome),
        });
      });
      runSink(host, () => {
        sourceNavigator.update({
          inspectMessageId: publication.inspectMessageId,
          resolutionGeneration: publication.resolutionGeneration,
          ...(publication.resolution
            ? { documentUri: publication.resolution.documentUri }
            : {}),
          matches: publication.resolution?.matches ?? [],
        });
      });
      const sourceSent = options.sendSourceMatches !== undefined &&
        runSink(host, () => options.sendSourceMatches?.(
          sourcePublication.message,
        ));
      runSink(host, () => sourceNavigator.setIncludedMatches(
        sourceSent ? sourcePublication.navigationMatches : [],
      ));
    },
    clear,
    onError: (error) => reportSafely(host, error),
  });
  let disposed = false;

  return {
    api,
    tree,
    select(message) {
      runSink(host, () => highlights.beginInspect(
        message.messageId,
        message.ideHighlightEnabled,
      ));
      runSink(host, () => sourceNavigator.beginInspect(
        message.messageId,
        { publish: false },
      ));
      coordinator.select(message);
    },
    navigate(message) {
      runSink(host, () => sourceNavigator.navigate(message));
    },
    open(message) {
      const editor = host.getActiveEditor();
      const authority = editor
        ? sourceExcerpts.resolveOpen(message, editor.document)
        : undefined;
      if (!editor || !authority) {
        const empty = sourceExcerpts.invalidate();
        if (empty) runSink(host, () => options.sendSourceMatches?.(empty));
        runSink(host, () => sourceNavigator.setIncludedMatches([], true));
        return;
      }
      runSink(host, () => {
        host.setPrimaryCursor(editor, authority.range.start);
        host.revealRange(editor, createHostRange(host, authority.range));
      });
    },
    applyPresentationSettings(message) {
      runSink(host, () => highlights.applySettings(message));
    },
    clear() {
      coordinator.clearSelection();
    },
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      coordinator.dispose();
      sourceNavigator.dispose();
      commandRegistration.dispose();
      treeRegistration.dispose();
      highlights.dispose();
      tree.dispose();
      for (const registration of [...builtIns].reverse()) {
        registration.dispose();
      }
    },
  };
}

function createSourcePublication(
  registry: SourceExcerptRegistry,
  publication: CoordinatorPublication,
): SourceExcerptPublication {
  if (publication.editor && publication.resolution) {
    return registry.publish({
      inspectMessageId: publication.inspectMessageId,
      resolutionGeneration: publication.resolutionGeneration,
      editor: publication.editor as PresenterEditorLike,
      resolution: publication.resolution,
    });
  }
  const message = registry.invalidate({
    inspectMessageId: publication.inspectMessageId,
    resolutionGeneration: publication.resolutionGeneration,
    ...(publication.editor
      ? { editor: publication.editor as PresenterEditorLike }
      : {}),
  });
  if (!message) throw new Error("Source excerpt state was not initialized");
  return { message, navigationMatches: [], excerptReadFailed: false };
}

function withExcerptReadDiagnostic(
  outcome: PresenterOutcome,
  excerptReadFailed: boolean,
): PresenterOutcome {
  if (!excerptReadFailed) return outcome;
  const code: ResolutionDiagnosticCode = "resolver.source-read-failed";
  return {
    ...outcome,
    diagnosticCodes: [
      code,
      ...outcome.diagnosticCodes.filter((entry) => entry !== code),
    ].slice(0, RESOLUTION_LIMITS.diagnosticCodes),
  };
}

function runSink(host: PresenterRuntimeHost, sink: () => void): boolean {
  try {
    sink();
    return true;
  } catch (error) {
    reportSafely(host, error);
    return false;
  }
}

function reportSafely(host: PresenterRuntimeHost, error: unknown): void {
  try {
    host.reportError(error);
  } catch {
    // Error reporting must not suppress the independent resolution sinks.
  }
}

function createSourceNavigationHost(
  host: PresenterRuntimeHost,
): SourceNavigationHost {
  return {
    getActiveEditor: () => host.getActiveEditor(),
    getPrimaryCursor: (editor) =>
      host.getPrimaryCursor(editor as PresenterEditorLike),
    setPrimaryCursor: (editor, position) =>
      host.setPrimaryCursor(editor as PresenterEditorLike, position),
    revealRange: (editor, range) =>
      host.revealRange(
        editor as PresenterEditorLike,
        createHostRange(host, range),
      ),
    onDidChangeActiveEditor: (listener) =>
      host.onDidChangeActiveEditor(() => listener()),
    onDidChangePrimaryCursor: (listener) =>
      host.onDidChangePrimaryCursor(listener),
  };
}

function createHostRange(
  host: PresenterRuntimeHost,
  range: SourceRange,
): unknown {
  return host.createRange(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export type { DecorationRole };
