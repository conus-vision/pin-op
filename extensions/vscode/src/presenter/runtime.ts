import type * as vscode from "vscode";
import type {
  PinOpApi,
  Disposable,
  SourcePosition,
  SourceRange,
  SourceWorkspace,
} from "@pinop/plugin-api";
import type {
  InspectMessage,
  SourceNavigateMessage,
} from "@pinop/protocol";
import type {
  ResolutionInput,
  SourceNavigationStateInput,
} from "../bridgeClient.js";
import type { DiagnosticsTracker } from "../diagnostics.js";
import { createPinOpApi } from "../sourcePlugins/api.js";
import { CssSourcePlugin } from "../sourcePlugins/cssSourcePlugin.js";
import { SourcePluginRegistry } from "../sourcePlugins/registry.js";
import { ScssSourcePlugin } from "../sourcePlugins/scssSourcePlugin.js";
import { toProtocolResolution } from "../sourcePlugins/resolutionOutcome.js";
import {
  VsCodeSourceWorkspace,
  type WorkspaceHost,
} from "../sourcePlugins/sourceWorkspace.js";
import type { SourceResolution } from "../sourcePlugins/types.js";
import {
  ActiveEditorCoordinator,
  type ActiveEditorLike,
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
import { SelectionStore } from "./selectionStore.js";
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
  readonly workspace?: SourceWorkspace;
  readonly diagnostics?: Pick<
    DiagnosticsTracker,
    "recordResolution" | "clearResolution"
  >;
  readonly sendResolution?: (resolution: ResolutionInput) => void;
  readonly sendSourceNavigationState?: (
    state: SourceNavigationStateInput,
  ) => void;
}

export interface PresenterRuntime extends DisposableLike {
  readonly api: PinOpApi;
  readonly tree: ApplicableSourcesTreeDataProvider;
  select(message: InspectMessage): void;
  navigate(message: SourceNavigateMessage): void;
  clear(): void;
}

export function createPresenterRuntime(
  options: PresenterRuntimeOptions,
): PresenterRuntime {
  const { host } = options;
  const registry = options.registry ?? new SourcePluginRegistry();
  const api = createPinOpApi(registry);
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
      decorations.update(editor as PresenterEditorLike, resolution)
    );
  };
  const clear = (): void => {
    runSink(host, () => tree.clear());
    runSink(host, () => decorations.clear());
    runSink(host, () => options.diagnostics?.clearResolution());
    runSink(host, () => sourceNavigator.invalidate());
  };
  const coordinator = new ActiveEditorCoordinator({
    host,
    registry,
    workspace,
    store,
    publish,
    onOutcome(publication) {
      runSink(host, () => {
        options.diagnostics?.recordResolution(
          publication.outcome,
          publication.resolutionGeneration,
          publication.resolution,
        );
      });
      runSink(host, () => {
        options.sendResolution?.({
          inspectMessageId: publication.inspectMessageId,
          resolutionGeneration: publication.resolutionGeneration,
          ...toProtocolResolution(publication.outcome),
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
    },
    clear,
    onError: (error) => reportSafely(host, error),
  });
  let disposed = false;

  return {
    api,
    tree,
    select(message) {
      runSink(host, () => sourceNavigator.beginInspect(message.messageId));
      coordinator.select(message);
    },
    navigate(message) {
      runSink(host, () => sourceNavigator.navigate(message));
    },
    clear() {
      coordinator.clearSelection();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      coordinator.dispose();
      sourceNavigator.dispose();
      commandRegistration.dispose();
      treeRegistration.dispose();
      decorations.dispose();
      tree.dispose();
      for (const registration of [...builtIns].reverse()) {
        registration.dispose();
      }
    },
  };
}

function runSink(host: PresenterRuntimeHost, sink: () => void): void {
  try {
    sink();
  } catch (error) {
    reportSafely(host, error);
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
