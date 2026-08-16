import * as vscode from "vscode";
import type { PinOpApi } from "@pin-op/plugin-api";
import {
  BridgeClient,
  ResolutionClientRouter,
  SourceNavigationClientRouter,
  type ConnectionState,
} from "./bridgeClient.js";
import { BridgeManager } from "./bridgeManager.js";
import { readBridgeConfiguration } from "./config.js";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "./diagnostics.js";
import {
  createPresenterRuntime,
  type PresenterEditorLike,
  type PresenterRuntime,
  type PresenterRuntimeHost,
} from "./presenter/runtime.js";
import { replacePrimarySelection } from "./presenter/sourceNavigator.js";
import {
  ExtensionRuntimeController,
  registerRuntimeCommands,
} from "./runtimeController.js";
import { StatusBarController } from "./statusBarController.js";

let manager: BridgeManager | undefined;
let runtimeController: ExtensionRuntimeController | undefined;
let clientState: ConnectionState = "disconnected";
let output: vscode.OutputChannel | undefined;
let presenterRuntime: PresenterRuntime | undefined;
let diagnostics: DiagnosticsTracker | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<PinOpApi> {
  output = vscode.window.createOutputChannel("PinOp");
  diagnostics = new DiagnosticsTracker();
  const resolutionClients = new ResolutionClientRouter();
  const sourceNavigationClients = new SourceNavigationClientRouter();

  const runtime = createPresenterRuntime({
    host: createPresenterHost(),
    diagnostics,
    sendResolution: (resolution) =>
      resolutionClients.sendResolution(resolution),
    sendSourceNavigationState: (state) =>
      sourceNavigationClients.sendSourceNavigationState(state),
  });
  presenterRuntime = runtime;

  const configuration = readBridgeConfiguration(
    vscode.workspace.getConfiguration("pinop"),
  );
  manager = new BridgeManager({ configuration });

  const primaryStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const toggleStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  const status = new StatusBarController({
    primary: primaryStatus,
    toggle: toggleStatus,
  });
  const controller = new ExtensionRuntimeController({
    manager,
    status,
    createClient(options) {
      const nextClient = new BridgeClient(options);
      nextClient.onConnectionStateChanged((state) => {
        clientState = state;
      });
      nextClient.onProtocolError((message) => {
        const safeMessage = {
          ...message,
          message: `Bridge reported ${message.code}`,
          details: {},
        };
        diagnostics?.recordProtocolError(safeMessage);
        output?.appendLine(`protocol error ${message.code}`);
      });
      nextClient.onInspect((message) => {
        diagnostics?.recordInspect(message);
        output?.appendLine(`inspect ${message.messageId}`);
        runtime.select(message);
      });
      const unsubscribeSourceNavigate = nextClient.onSourceNavigate((message) =>
        runtime.navigate(message)
      );
      resolutionClients.bind(nextClient);
      sourceNavigationClients.bind(nextClient);
      return {
        connect: () => nextClient.connect(),
        dispose() {
          unsubscribeSourceNavigate();
          resolutionClients.unbind(nextClient);
          sourceNavigationClients.unbind(nextClient);
          runtime.clear();
          nextClient.dispose();
        },
      };
    },
    writeClipboard: (value) => vscode.env.clipboard.writeText(value),
    showInformationMessage: (message) =>
      vscode.window.showInformationMessage(message),
    showWarningMessage: (message) => vscode.window.showWarningMessage(message),
  });
  runtimeController = controller;

  const runtimeCommands = registerRuntimeCommands(
    {
      registerCommand: (command, callback) =>
        vscode.commands.registerCommand(command, callback),
      reportError: reportRuntimeError,
    },
    controller,
  );

  context.subscriptions.push(
    output,
    runtime,
    runtimeCommands,
    {
      dispose() {
        void controller.dispose().catch(reportRuntimeError);
      },
    },
    vscode.commands.registerCommand("pinop.openDiagnostics", () => {
      if (output && manager && diagnostics) {
        writeBridgeDiagnostics(
          output,
          diagnostics.snapshot(manager.snapshot(), clientState),
        );
        output.show(true);
      }
    }),
  );

  void controller.start().catch(reportRuntimeError);

  return runtime.api;
}

export async function deactivate(): Promise<void> {
  const controller = runtimeController;
  runtimeController = undefined;
  if (controller) {
    await controller.dispose().catch(reportRuntimeError);
  } else {
    await manager?.stop().catch(reportRuntimeError);
  }
  presenterRuntime?.dispose();
  presenterRuntime = undefined;
  diagnostics = undefined;
  manager = undefined;
  output?.dispose();
  output = undefined;
  clientState = "disconnected";
}

function reportRuntimeError(error: unknown): void {
  clientState = "error";
  const code = errorCode(error);
  output?.appendLine(`PinOp operation failed${code ? ` (${code})` : ""}`);
}

function reportPresenterError(error: unknown): void {
  output?.appendLine(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
}

function createPresenterHost(): PresenterRuntimeHost {
  return {
    get workspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri,
      }));
    },
    findFiles: (pattern, exclude) => vscode.workspace.findFiles(pattern, exclude),
    joinPath: (base, ...pathSegments) =>
      vscode.Uri.joinPath(base as vscode.Uri, ...pathSegments),
    parseUri: (value) => vscode.Uri.parse(value),
    readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
    stat: (uri) => vscode.workspace.fs.stat(uri as vscode.Uri),
    getActiveEditor: () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? presenterEditor(editor) : undefined;
    },
    onDidChangeActiveEditor: (listener) =>
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        listener(editor ? presenterEditor(editor) : undefined),
      ),
    onDidChangeTextDocument: (listener) =>
      vscode.workspace.onDidChangeTextDocument((event) =>
        listener(event.document),
      ),
    onDidChangePrimaryCursor: (listener) =>
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) listener();
      }),
    createThemeIcon: (id) => new vscode.ThemeIcon(id),
    createThemeColor: (id) => new vscode.ThemeColor(id),
    overviewRulerLaneRight: vscode.OverviewRulerLane.Right,
    registerTreeDataProvider: (provider) =>
      vscode.window.registerTreeDataProvider(
        "pinop.applicableRules",
        provider,
      ),
    registerCommand: (command, callback) =>
      vscode.commands.registerCommand(command, callback),
    createDecorationType: (options) =>
      vscode.window.createTextEditorDecorationType(options),
    createRange: (startLine, startColumn, endLine, endColumn) =>
      new vscode.Range(startLine, startColumn, endLine, endColumn),
    getPrimaryCursor: (editor) => vscodeEditor(editor).selection.active,
    setPrimaryCursor: (editor, position_) => {
      const position = new vscode.Position(position_.line, position_.character);
      const textEditor = vscodeEditor(editor);
      const primary = new vscode.Selection(position, position);
      textEditor.selections = replacePrimarySelection(
        textEditor.selections,
        primary,
      );
    },
    revealRange: (editor, range) =>
      vscodeEditor(editor).revealRange(
        range as vscode.Range,
        vscode.TextEditorRevealType.InCenter,
      ),
    reportError: reportPresenterError,
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : undefined;
}

type VsCodePresenterEditor = PresenterEditorLike & {
  readonly source: vscode.TextEditor;
};

function presenterEditor(editor: vscode.TextEditor): VsCodePresenterEditor {
  return {
    source: editor,
    documentUri: editor.document.uri.toString(),
    document: editor.document,
    setDecorations(decorationType, ranges) {
      editor.setDecorations(
        decorationType as vscode.TextEditorDecorationType,
        ranges as readonly vscode.Range[],
      );
    },
  };
}

function vscodeEditor(editor: PresenterEditorLike): vscode.TextEditor {
  return (editor as VsCodePresenterEditor).source;
}
