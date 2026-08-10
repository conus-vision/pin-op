import type * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type SourcePosition,
  type SourcePlugin,
  type SourceRange,
  type SourceWorkspace,
} from "@browser2ide/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
  type SourceNavigateMessage,
} from "@browser2ide/protocol";
import type {
  ResolutionInput,
  SourceNavigationStateInput,
} from "../src/bridgeClient.js";
import { SourceDecorationManager } from "../src/presenter/decorations.js";
import { createPresenterRuntime } from "../src/presenter/runtime.js";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";

describe("presenter runtime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses the exact inspect ID and increments generation on active-editor changes", async () => {
    const harness = runtimeHarness({ activeLanguageId: "css" });
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    harness.changeActiveEditor("file:///workspace/src/other.css", "css");
    await harness.flush();

    expect(harness.resolutions.map((entry) => [
      entry.inspectMessageId,
      entry.resolutionGeneration,
    ])).toEqual([
      ["inspect-1", 0],
      ["inspect-1", 1],
    ]);
  });

  it("keeps local plugin details out of the browser resolution", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    const localPath = "C:/private/workspace/fixture.source";
    harness.runtime.api.registerSourcePlugin(fixturePlugin(localPath));
    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(harness.resolutions.at(-1)).toMatchObject({
      status: "matched",
      selectedMatchCount: 1,
      parentMatchCount: 0,
      document: { label: "app.fixture", languageId: "fixture" },
    });
    expect(JSON.stringify(harness.resolutions.at(-1))).not.toContain(localPath);
    expect(JSON.stringify(harness.resolutions.at(-1))).not.toContain(
      "external.secret",
    );
  });

  it("stops publishing after disposal", async () => {
    const harness = runtimeHarness({ activeLanguageId: "css" });
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    harness.runtime.dispose();
    const published = harness.resolutions.length;

    harness.changeActiveEditor("file:///workspace/src/other.css", "css");
    await harness.flush();

    expect(harness.resolutions).toHaveLength(published);
  });

  it("does not move on inspect or resolution and moves once on explicit navigation", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    harness.movePrimaryCursor({ line: 0, character: 10 });

    harness.runtime.select(inspectMessageWithCustomFact());

    expect(harness.navigationStates[0]).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
    });
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);

    await harness.flush();
    expect(harness.navigationStates.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 1,
    });
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);

    harness.runtime.navigate(sourceNavigate("next"));

    expect(harness.cursorSets).toEqual([{ line: 0, character: 0 }]);
    expect(harness.revealedRanges).toEqual([{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 7 },
    }]);
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
      activeMatchIndex: 0,
    });
  });

  it("invalidates navigable ranges immediately when the active document changes", async () => {
    const harness = await resolvedRuntimeHarness();
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
    });

    harness.changeTextDocument();

    expect(harness.navigationStates.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
    });
    harness.runtime.navigate(sourceNavigate("next"));
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);
    harness.runtime.dispose();
  });

  it("records local diagnostics even when transport publication fails", async () => {
    const transportError = new Error("socket write failed");
    const harness = runtimeHarness({
      activeLanguageId: "css",
      sendError: transportError,
    });

    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();

    expect(harness.errors).toEqual([transportError]);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
  });

  it("keeps every resolution sink running when navigation state publication fails", async () => {
    const sinkError = new Error("navigation state write failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      navigationSendError: sinkError,
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(harness.runtime.tree.getMatches()).toHaveLength(1);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
    });
    expect(harness.errors).toContain(sinkError);
  });

  it("runs every update sink when tree publication and error reporting fail", async () => {
    const sinkError = new Error("tree update failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      reporterError: new Error("reporter failed"),
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    const treeUpdate = vi.spyOn(harness.runtime.tree, "update")
      .mockImplementationOnce(() => {
        throw sinkError;
      });
    const decorationUpdate = vi.spyOn(
      SourceDecorationManager.prototype,
      "update",
    );

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(treeUpdate).toHaveBeenCalledTimes(1);
    expect(decorationUpdate).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("runs every update sink when decoration publication and error reporting fail", async () => {
    const sinkError = new Error("decoration update failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      reporterError: new Error("reporter failed"),
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    const treeUpdate = vi.spyOn(harness.runtime.tree, "update");
    const decorationUpdate = vi.spyOn(
      SourceDecorationManager.prototype,
      "update",
    ).mockImplementationOnce(() => {
      throw sinkError;
    });

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(treeUpdate).toHaveBeenCalledTimes(1);
    expect(decorationUpdate).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("runs every update sink when diagnostics publication and error reporting fail", async () => {
    const sinkError = new Error("diagnostics update failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      diagnosticRecordError: sinkError,
      reporterError: new Error("reporter failed"),
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    const treeUpdate = vi.spyOn(harness.runtime.tree, "update");
    const decorationUpdate = vi.spyOn(
      SourceDecorationManager.prototype,
      "update",
    );

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(treeUpdate).toHaveBeenCalledTimes(1);
    expect(decorationUpdate).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("attempts every update sink when browser publication and error reporting fail", async () => {
    const sinkError = new Error("browser update failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      sendError: sinkError,
      reporterError: new Error("reporter failed"),
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    const treeUpdate = vi.spyOn(harness.runtime.tree, "update");
    const decorationUpdate = vi.spyOn(
      SourceDecorationManager.prototype,
      "update",
    );

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(treeUpdate).toHaveBeenCalledTimes(1);
    expect(decorationUpdate).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticRecords).toHaveLength(1);
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
    });
    expect(harness.errors).toEqual([sinkError]);
  });

  it("continues a rerun through every clear sink when tree clearing fails", async () => {
    const sinkError = new Error("tree clear failed");
    const harness = await resolvedRuntimeHarness();
    const diagnosticClears = harness.diagnosticClearCalls;
    const treeClear = vi.spyOn(harness.runtime.tree, "clear")
      .mockImplementationOnce(() => {
        throw sinkError;
      });
    const decorationClear = vi.spyOn(
      SourceDecorationManager.prototype,
      "clear",
    );

    harness.changeActiveEditor("file:///workspace/src/other.fixture", "fixture");
    await harness.flush();

    expect(treeClear).toHaveBeenCalledTimes(1);
    expect(decorationClear).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticClearCalls).toBe(diagnosticClears + 1);
    expect(harness.resolutions).toHaveLength(2);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("continues a rerun through every clear sink when decoration clearing fails", async () => {
    const sinkError = new Error("decoration clear failed");
    const harness = await resolvedRuntimeHarness();
    const diagnosticClears = harness.diagnosticClearCalls;
    const treeClear = vi.spyOn(harness.runtime.tree, "clear");
    const decorationClear = vi.spyOn(
      SourceDecorationManager.prototype,
      "clear",
    ).mockImplementationOnce(() => {
      throw sinkError;
    });

    harness.changeActiveEditor("file:///workspace/src/other.fixture", "fixture");
    await harness.flush();

    expect(treeClear).toHaveBeenCalledTimes(1);
    expect(decorationClear).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticClearCalls).toBe(diagnosticClears + 1);
    expect(harness.resolutions).toHaveLength(2);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("continues a rerun when diagnostics clearing and error reporting fail", async () => {
    const sinkError = new Error("diagnostics clear failed");
    const harness = await resolvedRuntimeHarness({
      reporterError: new Error("reporter failed"),
    });
    const diagnosticClears = harness.diagnosticClearCalls;
    const treeClear = vi.spyOn(harness.runtime.tree, "clear");
    const decorationClear = vi.spyOn(
      SourceDecorationManager.prototype,
      "clear",
    );
    harness.failNextDiagnosticClear(sinkError);

    harness.changeActiveEditor("file:///workspace/src/other.fixture", "fixture");
    await harness.flush();

    expect(treeClear).toHaveBeenCalledTimes(1);
    expect(decorationClear).toHaveBeenCalledTimes(1);
    expect(harness.diagnosticClearCalls).toBe(diagnosticClears + 1);
    expect(harness.resolutions).toHaveLength(2);
    expect(harness.errors).toEqual([sinkError]);
  });

  it("registers built-ins, retains selection, and publishes active-document matches", async () => {
    const harness = runtimeHarness({ activeLanguageId: "scss" });
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();

    expect(harness.registeredPluginIds).toEqual([
      "browser2ide.css",
      "browser2ide.scss",
    ]);
    expect(harness.openDocumentCalls).toBe(0);
    expect(harness.runtime.tree.getDocumentUri()).toBe(
      "file:///workspace/src/layout.scss",
    );
  });

  it("re-resolves after an external plugin is registered and disposed", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    harness.runtime.select(inspectMessageWithCustomFact());
    const registration = harness.runtime.api.registerSourcePlugin(
      fixturePlugin(),
    );
    await harness.flush();
    expect(harness.runtime.tree.getMatches()).toHaveLength(1);

    registration.dispose();
    await harness.flush();
    expect(harness.runtime.tree.getMatches()).toEqual([]);
  });

  it("disposes coordinator, commands, tree, decorations, and built-ins", () => {
    const harness = runtimeHarness({ activeLanguageId: "css" });
    harness.runtime.dispose();
    harness.runtime.dispose();

    expect(harness.disposed).toEqual([
      "active-editor-listener",
      "document-listener",
      "active-editor-listener",
      "primary-cursor-listener",
      "command",
      "tree-registration",
      "primary",
      "context",
    ]);
  });
});

function runtimeHarness(options: {
  readonly activeLanguageId: string;
  readonly sendError?: Error;
  readonly navigationSendError?: Error;
  readonly diagnosticRecordError?: Error;
  readonly reporterError?: Error;
}) {
  const registeredPluginIds: string[] = [];
  const disposed: string[] = [];
  const registry = new SourcePluginRegistry();
  const originalRegister = registry.register.bind(registry);
  registry.register = ((plugin: SourcePlugin) => {
    registeredPluginIds.push(plugin.id);
    return originalRegister(plugin);
  }) as SourcePluginRegistry["register"];
  const uri = options.activeLanguageId === "scss"
    ? "file:///workspace/src/layout.scss"
    : `file:///workspace/src/app.${options.activeLanguageId}`;
  const text = options.activeLanguageId === "fixture"
    ? "fixture block"
    : ".layout {}";
  const activeEditorListeners = new Set<
    (editor: ReturnType<typeof createEditor> | undefined) => void
  >();
  const documentListeners = new Set<(document: ReturnType<typeof textDocument>) => void>();
  const primaryCursorListeners = new Set<() => void>();
  const resolutions: ResolutionInput[] = [];
  const navigationStates: SourceNavigationStateInput[] = [];
  const cursorSets: SourcePosition[] = [];
  const revealedRanges: SourceRange[] = [];
  const errors: unknown[] = [];
  const diagnosticRecords: unknown[][] = [];
  let diagnosticClearCalls = 0;
  let nextDiagnosticClearError: Error | undefined;
  let editor = createEditor(uri, options.activeLanguageId, text);
  let primaryCursor: SourcePosition = { line: 0, character: 0 };
  const runtime = createPresenterRuntime({
    registry,
    workspace: workspace(),
    diagnostics: {
      recordResolution: (...arguments_) => {
        diagnosticRecords.push(arguments_);
        if (options.diagnosticRecordError) {
          throw options.diagnosticRecordError;
        }
      },
      clearResolution() {
        diagnosticClearCalls += 1;
        const error = nextDiagnosticClearError;
        nextDiagnosticClearError = undefined;
        if (error) throw error;
      },
    },
    sendResolution(resolution) {
      resolutions.push(resolution);
      if (options.sendError) throw options.sendError;
    },
    sendSourceNavigationState(state) {
      navigationStates.push(state);
      if (options.navigationSendError) throw options.navigationSendError;
    },
    host: {
      getActiveEditor: () => editor,
      getPrimaryCursor: () => primaryCursor,
      setPrimaryCursor(_editor, position) {
        primaryCursor = position;
        cursorSets.push(position);
      },
      onDidChangeActiveEditor(listener) {
        activeEditorListeners.add(listener);
        return disposable(() => {
          activeEditorListeners.delete(listener);
          disposed.push("active-editor-listener");
        });
      },
      onDidChangeTextDocument(listener) {
        documentListeners.add(listener);
        return disposable(() => {
          documentListeners.delete(listener);
          disposed.push("document-listener");
        });
      },
      onDidChangePrimaryCursor(listener) {
        primaryCursorListeners.add(listener);
        return disposable(() => {
          primaryCursorListeners.delete(listener);
          disposed.push("primary-cursor-listener");
        });
      },
      createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
      createThemeColor: (id) => ({ id }) as vscode.ThemeColor,
      overviewRulerLaneRight: 4,
      createDecorationType(_style, role) {
        return { role, dispose: () => disposed.push(role) };
      },
      createRange: (startLine, startCharacter, endLine, endCharacter) => ({
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter },
      }),
      registerTreeDataProvider: () => disposable(
        () => disposed.push("tree-registration"),
      ),
      registerCommand: () => disposable(() => disposed.push("command")),
      revealRange(_editor, range) {
        revealedRanges.push(range as SourceRange);
      },
      reportError: (error) => {
        errors.push(error);
        if (options.reporterError) throw options.reporterError;
      },
      workspaceFolders: [],
      findFiles: async () => [],
      parseUri: (value) => ({ toString: () => value }),
      readFile: async () => new Uint8Array(),
    },
  });
  return {
    runtime,
    registeredPluginIds,
    disposed,
    resolutions,
    navigationStates,
    cursorSets,
    revealedRanges,
    errors,
    diagnosticRecords,
    get diagnosticClearCalls() {
      return diagnosticClearCalls;
    },
    openDocumentCalls: 0,
    failNextDiagnosticClear(error: Error) {
      nextDiagnosticClearError = error;
    },
    changeActiveEditor(nextUri: string, languageId: string) {
      editor = createEditor(nextUri, languageId, ".card {}");
      for (const listener of activeEditorListeners) listener(editor);
    },
    changeTextDocument() {
      for (const listener of documentListeners) listener(editor.document);
    },
    movePrimaryCursor(position: SourcePosition) {
      primaryCursor = position;
    },
    changePrimaryCursor(position: SourcePosition) {
      primaryCursor = position;
      for (const listener of primaryCursorListeners) listener();
    },
    flush,
  };
}

async function resolvedRuntimeHarness(
  options: { readonly reporterError?: Error } = {},
) {
  const harness = runtimeHarness({
    activeLanguageId: "fixture",
    reporterError: options.reporterError,
  });
  harness.runtime.api.registerSourcePlugin(fixturePlugin());
  harness.runtime.select(inspectMessageWithCustomFact());
  await harness.flush();
  return harness;
}

function fixturePlugin(localPath?: string): SourcePlugin {
  return {
    id: "fixture.source",
    displayName: "Fixture Source",
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    documentSelectors: [{ languageId: "fixture", scheme: "file" }],
    supportedFactKinds: ["fixture.source"],
    async resolve() {
      return {
        matches: [
          {
            targetRole: "selected",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 7 },
            },
            label: "fixture",
            kind: "fixture",
            relation: "renders",
            confidence: "instrumented",
          },
        ],
        diagnostics: localPath
          ? [{
              code: "external.secret",
              message: `Fixture detail at ${localPath}`,
              severity: "warning",
            }]
          : undefined,
      };
    },
  };
}

function createEditor(uri: string, languageId: string, text: string) {
  return {
    documentUri: uri,
    document: textDocument(uri, languageId, text),
    setDecorations() {},
  };
}

function sourceNavigate(
  direction: SourceNavigateMessage["direction"],
  overrides: Partial<
    Pick<SourceNavigateMessage, "inspectMessageId" | "resolutionGeneration">
  > = {},
): SourceNavigateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigate",
    messageId: `navigate-${direction}`,
    sessionId: "session-1",
    inspectMessageId: overrides.inspectMessageId ?? "inspect-1",
    resolutionGeneration: overrides.resolutionGeneration ?? 0,
    direction,
    metadata: {},
  };
}

function inspectMessageWithSelectedAndParent(): InspectMessage {
  return inspect([
    cssTarget("selected", 0, ".layout > .card"),
    cssTarget("parent", 1, ".layout"),
  ]);
}

function inspectMessageWithCustomFact(): InspectMessage {
  return inspect([
    {
      role: "selected",
      depth: 0,
      subject: { selector: ".fixture", metadata: {} },
      facts: [
        {
          type: "fixture.source",
          payload: { component: "Fixture" },
          metadata: {},
        },
      ],
      metadata: {},
    },
  ]);
}

function inspect(targets: InspectMessage["targets"]): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    targets,
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: {},
  };
}

function cssTarget(
  role: "selected" | "parent",
  depth: 0 | 1,
  selector: string,
): InspectMessage["targets"][number] {
  return {
    role,
    depth,
    subject: { selector, metadata: {} },
    facts: [
      {
        type: "css-rule",
        selector,
        property: "display",
        value: "grid",
        metadata: { sourceUrl: "/dist/app.css" },
      },
    ],
    metadata: {},
  };
}

function textDocument(uri: string, languageId: string, text: string) {
  return {
    uri: { toString: () => uri },
    languageId,
    version: 1,
    getText: () => text,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: { line: number; character: number }) =>
      position.character,
  };
}

function workspace(): SourceWorkspace {
  return {
    findFiles: async () => [],
    readText: async () => "",
    resolveSourceUri: async () => ({ uris: [], status: "not-found" }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function disposable(dispose: () => void) {
  return { dispose };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
