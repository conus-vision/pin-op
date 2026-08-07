import type * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type SourcePlugin,
  type SourceWorkspace,
} from "@browser2ide/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
} from "@browser2ide/protocol";
import type { ResolutionInput } from "../src/bridgeClient.js";
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
  const resolutions: ResolutionInput[] = [];
  const errors: unknown[] = [];
  const diagnosticRecords: unknown[][] = [];
  let diagnosticClearCalls = 0;
  let nextDiagnosticClearError: Error | undefined;
  let editor = createEditor(uri, options.activeLanguageId, text);
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
    host: {
      getActiveEditor: () => editor,
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
      revealRange() {},
      selectRangeStart() {},
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
    document: textDocument(uri, languageId, text),
    setDecorations() {},
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
