import type * as vscode from "vscode";
import type {
  PinOpApi,
  Disposable,
  SourceDocument,
  SourcePosition,
  SourceRange,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  RESOLUTION_LIMITS,
  type ResolutionDiagnosticCode,
  type InspectMessage,
  type PresentationSettingsMessage,
  type RulesOpenMessage,
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
import { RulesOpenAuthorityRegistry } from
  "../rules/rulesOpenAuthorityRegistry.js";
import {
  RulesSourceController,
  type RulesSourceFailureCode,
} from "../rules/rulesSourceController.js";
import {
  RulesSourcesPublication,
  type RulesSourcesPublicationPayload,
} from "../rules/rulesSourcesPublication.js";
import {
  RulesSourceResolver,
  type RulesSourceResolverRequest,
  type RulesSourceResolutionBatch,
} from "../rules/rulesSourceResolver.js";
import { createPinOpApi } from "../sourcePlugins/api.js";
import { CssSourcePlugin } from "../sourcePlugins/cssSourcePlugin.js";
import { SourcePluginRegistry } from "../sourcePlugins/registry.js";
import { PhpSourcePlugin } from "../sourcePlugins/phpSourcePlugin.js";
import { ScssSourcePlugin } from "../sourcePlugins/scssSourcePlugin.js";
import type { TextDocumentLike } from "../sourcePlugins/sourceDocument.js";
import {
  toProtocolResolution,
  type PresenterOutcome,
} from "../sourcePlugins/resolutionOutcome.js";
import {
  VsCodeSourceWorkspace,
  rulesSourceSnapshotWorkspace,
  type RulesSourceDocumentLike,
  type UriLike,
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

declare const presenterDocumentBrand: unique symbol;

export interface PresenterDocumentLike extends SourceDocument {
  readonly [presenterDocumentBrand]: true;
}

export interface PresenterDocumentHost<Editor extends PresenterEditorLike> {
  openTextDocument(uri: string): PromiseLike<TextDocumentLike>;
  createPosition(line: number, character: number): SourcePosition;
  showTextDocument(document: TextDocumentLike): PromiseLike<Editor>;
}

export interface RulesSourceFileWatcherLike extends DisposableLike {
  onDidCreate(listener: (uri: UriLike) => void): DisposableLike;
  onDidChange(listener: (uri: UriLike) => void): DisposableLike;
  onDidDelete(listener: (uri: UriLike) => void): DisposableLike;
}

export interface PresenterRuntimeHost
  extends CoordinatorHost,
    Omit<WorkspaceHost, "openTextDocument">,
    SourceDecorationHost {
  openWorkspaceTextDocument?(
    uri: UriLike,
  ): PromiseLike<RulesSourceDocumentLike>;
  openTextDocument(uri: string): Promise<PresenterDocumentLike>;
  showTextDocument(
    document: PresenterDocumentLike,
  ): Promise<PresenterEditorLike>;
  advanceRulesSourceGeneration?(): void;
  onDidChangeWorkspaceFolders?(
    listener: () => void,
  ): DisposableLike;
  createRulesSourceFileWatcher?(
    folderUri: UriLike,
  ): RulesSourceFileWatcherLike;
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
  readonly sendSourceMatches?: (matches: SourceMatchesInput) => boolean;
  readonly measureSourceMatchesEnvelope?: (
    matches: SourceMatchesInput,
  ) => number;
  readonly sendSourceNavigationState?: (
    state: SourceNavigationStateInput,
  ) => boolean;
  readonly rulesSourceResolver?: {
    resolve(
      request: RulesSourceResolverRequest,
    ): Promise<RulesSourceResolutionBatch>;
  };
  readonly sendRulesSources?: (
    payload: RulesSourcesPublicationPayload,
  ) => boolean;
  readonly measureRulesSourcesEnvelope?: (
    payload: RulesSourcesPublicationPayload,
  ) => number;
}

export interface PresenterRuntime extends DisposableLike {
  readonly api: PinOpApi;
  readonly tree: ApplicableSourcesTreeDataProvider;
  select(message: InspectMessage): void;
  navigate(message: SourceNavigateMessage): void;
  open(message: SourceOpenMessage): void;
  openRuleSource(message: RulesOpenMessage): Promise<void>;
  stylesheetRefresh(): Promise<void>;
  pageRefresh(): Promise<void>;
  applyPresentationSettings(message: PresentationSettingsMessage): void;
  clear(): void;
}

export function createPresenterDocumentHost<Editor extends PresenterEditorLike>(
  host: PresenterDocumentHost<Editor>,
): Pick<PresenterRuntimeHost, "openTextDocument" | "showTextDocument"> {
  const registeredDocuments = new WeakMap<
    PresenterDocumentLike,
    TextDocumentLike
  >();
  return {
    async openTextDocument(uri) {
      const source = await host.openTextDocument(uri);
      const adapter = Object.freeze({
        get uri() {
          return source.uri.toString();
        },
        get languageId() {
          return source.languageId;
        },
        get version() {
          return source.version;
        },
        getText: () => source.getText(),
        positionAt(offset: number) {
          const position = source.positionAt(offset);
          return { line: position.line, character: position.character };
        },
        offsetAt: (position: SourcePosition) => source.offsetAt(
          host.createPosition(position.line, position.character),
        ),
      }) as PresenterDocumentLike;
      registeredDocuments.set(adapter, source);
      return adapter;
    },
    async showTextDocument(document) {
      const source = registeredDocuments.get(document);
      if (!source) throw new Error("Unknown presenter document adapter");
      const editor = await host.showTextDocument(source);
      if (editor.document !== source) {
        throw new Error("Presenter editor document identity changed");
      }
      return editor;
    },
  };
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
    registry.register(new PhpSourcePlugin()),
  ];
  const workspace = options.workspace ?? new VsCodeSourceWorkspace(
    createRulesWorkspaceHost(host),
  );
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
        if (!options.sendSourceNavigationState) return false;
        return runBooleanSink(
          host,
          () => options.sendSourceNavigationState!(state),
        );
      },
    },
  );
  const rulesWorkspace = rulesSourceSnapshotWorkspace(workspace);
  const rulesRegistry = new RulesOpenAuthorityRegistry();
  const rulesController = rulesWorkspace
    ? new RulesSourceController<PresenterDocumentLike, PresenterEditorLike>({
        workspace: rulesWorkspace,
        resolver: options.rulesSourceResolver ?? new RulesSourceResolver(workspace),
        registry: rulesRegistry,
        publication: new RulesSourcesPublication(rulesRegistry, {
          ...(options.measureRulesSourcesEnvelope
            ? { measureEnvelopeBytes: options.measureRulesSourcesEnvelope }
            : {}),
        }),
        sendRulesSources: options.sendRulesSources ?? (() => false),
        host: {
          openTextDocument: (uri) => host.openTextDocument(uri),
          showTextDocument: (document) => host.showTextDocument(document),
          setPrimaryCursor: (editor, position) =>
            host.setPrimaryCursor(editor, position),
          revealRange: (editor, range) =>
            host.revealRange(editor, createHostRange(host, range)),
          reportFailure: (code) => reportRulesFailure(host, code),
        },
      })
    : undefined;
  const rulesLifecycle = rulesController
    ? bindRulesSourceLifecycle(host, rulesController)
    : undefined;
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
        runBooleanSink(
          host,
          () => options.sendSourceMatches!(sourcePublication.message),
        );
      if (!sourceSent) {
        runSink(host, () => sourceExcerpts.invalidate());
      }
      runSink(host, () => sourceNavigator.setIncludedMatches(
        sourceSent ? sourcePublication.navigationMatches : [],
        sourceSent,
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
      void rulesController?.acceptInspect(message).catch((error) =>
        reportSafely(host, error)
      );
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
    async openRuleSource(message) {
      await rulesController?.open(message);
    },
    async stylesheetRefresh() {
      if (!rulesController) return;
      advanceRulesSourceGeneration(host);
      await rulesController.stylesheetRefresh();
    },
    async pageRefresh() {
      if (!rulesController) return;
      advanceRulesSourceGeneration(host);
      await rulesController.pageRefresh();
    },
    applyPresentationSettings(message) {
      runSink(host, () => highlights.applySettings(message));
    },
    clear() {
      rulesController?.clear();
      coordinator.clearSelection();
    },
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      rulesLifecycle?.dispose();
      rulesController?.dispose();
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

function createRulesWorkspaceHost(host: PresenterRuntimeHost): WorkspaceHost {
  return {
    get workspaceFolders() {
      return host.workspaceFolders;
    },
    findFiles: (pattern, exclude) => host.findFiles(pattern, exclude),
    joinPath: (base, ...pathSegments) => host.joinPath(base, ...pathSegments),
    parseUri: (value) => host.parseUri(value),
    readFile: (uri) => host.readFile(uri),
    stat: (uri) => host.stat(uri),
    ...(host.getOpenTextDocument
      ? { getOpenTextDocument: (uri: UriLike) => host.getOpenTextDocument!(uri) }
      : {}),
    ...(host.openWorkspaceTextDocument
      ? {
          openTextDocument: (uri: UriLike) =>
            host.openWorkspaceTextDocument!(uri),
        }
      : {}),
    ...(host.currentRulesSourceGeneration
      ? {
          currentRulesSourceGeneration: () =>
            host.currentRulesSourceGeneration!(),
        }
      : {}),
  };
}

function bindRulesSourceLifecycle(
  host: PresenterRuntimeHost,
  controller: RulesSourceController<PresenterDocumentLike, PresenterEditorLike>,
): DisposableLike {
  let disposed = false;
  let watcherSubscriptions: DisposableLike[] = [];
  const report = (error: unknown): void => reportSafely(host, error);
  const handleDependency = (uri: UriLike, closedOnly: boolean): void => {
    if (disposed) return;
    if (closedOnly && host.getOpenTextDocument?.(uri)) return;
    const value = uri.toString();
    if (!controller.isDependencyRelevant(value)) return;
    advanceRulesSourceGeneration(host);
    void controller.dependencyChanged(value).catch(report);
  };
  const rebuildWatchers = (): void => {
    for (const subscription of watcherSubscriptions.reverse()) {
      subscription.dispose();
    }
    watcherSubscriptions = [];
    if (!host.createRulesSourceFileWatcher) return;
    for (const folder of host.workspaceFolders) {
      const watcher = host.createRulesSourceFileWatcher(folder.uri);
      watcherSubscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => handleDependency(uri, true)),
        watcher.onDidChange((uri) => handleDependency(uri, true)),
        watcher.onDidDelete((uri) => handleDependency(uri, true)),
      );
    }
  };
  const subscriptions: DisposableLike[] = [
    host.onDidChangeTextDocument((document) =>
      handleDependency(document.uri, false)
    ),
  ];
  if (host.onDidChangeWorkspaceFolders) {
    subscriptions.push(host.onDidChangeWorkspaceFolders(() => {
      if (disposed) return;
      advanceRulesSourceGeneration(host);
      rebuildWatchers();
      void controller.workspaceChanged().catch(report);
    }));
  }
  rebuildWatchers();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of watcherSubscriptions.reverse()) {
        subscription.dispose();
      }
      watcherSubscriptions = [];
      for (const subscription of subscriptions.reverse()) {
        subscription.dispose();
      }
    },
  };
}

function advanceRulesSourceGeneration(host: PresenterRuntimeHost): void {
  try {
    host.advanceRulesSourceGeneration?.();
  } catch (error) {
    reportSafely(host, error);
  }
}

function reportRulesFailure(
  host: PresenterRuntimeHost,
  code: RulesSourceFailureCode,
): void {
  const error = new Error(code);
  error.name = "RulesSourceError";
  reportSafely(host, error);
}

function createSourcePublication(
  registry: SourceExcerptRegistry,
  publication: CoordinatorPublication,
): SourceExcerptPublication {
  if (
    publication.editor &&
    publication.sourceDocument &&
    publication.resolution
  ) {
    return registry.publish({
      inspectMessageId: publication.inspectMessageId,
      resolutionGeneration: publication.resolutionGeneration,
      editor: publication.editor as PresenterEditorLike,
      sourceDocument: publication.sourceDocument,
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

function runBooleanSink(
  host: PresenterRuntimeHost,
  sink: () => boolean,
): boolean {
  try {
    return sink();
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
