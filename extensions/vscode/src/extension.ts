import * as vscode from "vscode";
import type { Browser2IDEApi } from "@browser2ide/plugin-api";
import {
  BridgeClient,
  ResolutionClientRouter,
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
): Promise<Browser2IDEApi> {
  output = vscode.window.createOutputChannel("Browser2IDE");
  diagnostics = new DiagnosticsTracker();
  const resolutionClients = new ResolutionClientRouter();

  const runtime = createPresenterRuntime({
    host: createPresenterHost(),
    diagnostics,
    sendResolution: (resolution) =>
      resolutionClients.sendResolution(resolution),
  });
  presenterRuntime = runtime;

  const configuration = readBridgeConfiguration(
    vscode.workspace.getConfiguration("browser2ide"),
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
      resolutionClients.bind(nextClient);
      return {
        connect: () => nextClient.connect(),
        dispose() {
          resolutionClients.unbind(nextClient);
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
    vscode.commands.registerCommand("browser2ide.openDiagnostics", () => {
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
  output?.appendLine(`Browser2IDE operation failed${code ? ` (${code})` : ""}`);
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
    parseUri: (value) => vscode.Uri.parse(value),
    readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
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
    createThemeIcon: (id) => new vscode.ThemeIcon(id),
    createThemeColor: (id) => new vscode.ThemeColor(id),
    overviewRulerLaneRight: vscode.OverviewRulerLane.Right,
    registerTreeDataProvider: (provider) =>
      vscode.window.registerTreeDataProvider(
        "browser2ide.applicableRules",
        provider,
      ),
    registerCommand: (command, callback) =>
      vscode.commands.registerCommand(command, callback),
    createDecorationType: (options) =>
      vscode.window.createTextEditorDecorationType(options),
    createRange: (startLine, startColumn, endLine, endColumn) =>
      new vscode.Range(startLine, startColumn, endLine, endColumn),
    revealRange: (editor, range) =>
      vscodeEditor(editor).revealRange(
        range as vscode.Range,
        vscode.TextEditorRevealType.InCenter,
      ),
    selectRangeStart: (editor, start) => {
      const position = new vscode.Position(start.line, start.character);
      vscodeEditor(editor).selection = new vscode.Selection(position, position);
    },
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
