import type * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type SourcePosition,
  type SourcePlugin,
  type SourceRange,
  type SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
  type PresentationSettingsMessage,
  type SourceNavigateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type {
  ResolutionInput,
  SourceMatchesInput,
  SourceNavigationStateInput,
} from "../src/bridgeClient.js";
import {
  SourceDecorationManager,
  type DecorationRole,
} from "../src/presenter/decorations.js";
import { createPresenterRuntime } from "../src/presenter/runtime.js";
import { RefreshClassifierRegistry } from "../src/refresh/refreshClassifierRegistry.js";
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

  it("publishes empty Source before same-generation navigation on inspect invalidation", () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });

    harness.runtime.select(inspectMessageWithCustomFact());

    expect(harness.transportEvents.slice(0, 2)).toEqual([
      "source.matches",
      "source.navigationState",
    ]);
    expect(harness.sourceMatches[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      matches: [],
      omittedMatchCount: 0,
    });
    expect(harness.navigationStates[0]).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
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
      resolutionGeneration: 1,
      selectedMatchCount: 0,
    });
    harness.runtime.navigate(sourceNavigate("next", {
      resolutionGeneration: 1,
    }));
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);
    harness.runtime.dispose();
  });

  it("publishes resolution, initial navigation, Source, then active ID navigation", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(harness.transportEvents.slice(-4)).toEqual([
      "resolution",
      "source.navigationState",
      "source.matches",
      "source.navigationState",
    ]);
    expect(harness.sourceMatches.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      document: { label: "app.fixture", languageId: "fixture" },
      matches: [{
        targetRole: "selected",
        label: "fixture",
        startLine: 1,
        endLine: 1,
        text: "fixture",
        truncated: false,
      }],
      omittedMatchCount: 0,
    });
    const payload = JSON.stringify(harness.sourceMatches.at(-1));
    expect(payload).not.toContain("file:///workspace");
    expect(payload).not.toContain("fixture block");
    const recentStates = harness.navigationStates.slice(-2);
    expect(recentStates[0]).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
    });
    expect(recentStates[1]).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      activeMatchId: harness.sourceMatches.at(-1)!.matches[0]!.matchId,
    });
  });

  it("publishes SCSS excerpts when raw TextDocument requires Position instances", async () => {
    const harness = runtimeHarness({
      activeLanguageId: "scss",
      activeText: "$gap: 8px;\r\n.card {\r\n  gap: $gap;\r\n}",
      strictDocumentPositions: true,
    });
    harness.runtime.api.registerSourcePlugin(scssFixturePlugin());

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(harness.resolutions.at(-1)).toMatchObject({
      status: "matched",
      selectedMatchCount: 1,
      parentMatchCount: 0,
      document: { label: "layout.scss", languageId: "scss" },
    });
    expect(harness.sourceMatches.at(-1)).toMatchObject({
      document: { label: "layout.scss", languageId: "scss" },
      matches: [{
        targetRole: "selected",
        label: ".card",
        startLine: 2,
        endLine: 4,
        text: ".card {\r\n  gap: $gap;\r\n}",
      }],
    });
  });

  it("discards source IDs when the transport does not enqueue them", async () => {
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      sourceMatchesSendResult: false,
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());
    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();
    const droppedId = harness.sourceMatches.at(-1)!.matches[0]!.matchId;

    expect(harness.navigationStates.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 1,
      activeMatchIndex: 0,
    });
    harness.runtime.open(sourceOpen(droppedId));
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);
  });

  it("publishes an empty source state and bounded diagnostics on excerpt read failure", async () => {
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      excerptReadError: new Error("private read detail"),
    });
    harness.runtime.api.registerSourcePlugin(fixturePlugin());

    harness.runtime.select(inspectMessageWithCustomFact());
    await harness.flush();

    expect(harness.sourceMatches.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      matches: [],
      omittedMatchCount: 0,
    });
    expect(harness.resolutions.at(-1)?.diagnosticCodes).toContain(
      "resolver.source-read-failed",
    );
    expect(harness.diagnosticRecords[0]?.[0]).toMatchObject({
      diagnosticCodes: ["resolver.source-read-failed"],
    });
    expect(JSON.stringify(harness.resolutions.at(-1))).not.toContain(
      "private read detail",
    );
  });

  it("opens only the current opaque authority at the complete range", async () => {
    const harness = await resolvedRuntimeHarness();
    const source = harness.sourceMatches.at(-1)!;
    const matchId = source.matches[0]!.matchId;

    harness.runtime.open({
      ...sourceOpen(matchId),
      range: {
        start: { line: 99, character: 0 },
        end: { line: 100, character: 0 },
      },
      uri: "file:///browser/forged.fixture",
    } as SourceOpenMessage);

    expect(harness.cursorSets).toEqual([{ line: 0, character: 0 }]);
    expect(harness.revealedRanges).toEqual([{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 7 },
    }]);

    harness.runtime.open(sourceOpen("forged-match"));
    expect(harness.cursorSets).toHaveLength(1);
    expect(harness.revealedRanges).toHaveLength(1);
    expect(harness.sourceMatches.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      matches: [],
      omittedMatchCount: 0,
    });
    harness.runtime.dispose();
  });

  it("invalidates source authority immediately on active-document version changes", async () => {
    const harness = await resolvedRuntimeHarness();
    const staleId = harness.sourceMatches.at(-1)!.matches[0]!.matchId;
    const eventCount = harness.transportEvents.length;

    harness.changeTextDocument("fixture changed");

    expect(harness.transportEvents.slice(eventCount)).toEqual([
      "source.matches",
      "source.navigationState",
    ]);
    expect(harness.sourceMatches.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 1,
      matches: [],
    });
    expect(harness.navigationStates.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 1,
      selectedMatchCount: 0,
    });
    harness.runtime.open(sourceOpen(staleId));
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);
    harness.runtime.dispose();
  });

  it("publishes included Selected and Parent IDs while the counter stays selected-only", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    harness.runtime.api.registerSourcePlugin(fixturePlugin(true));
    harness.runtime.select(inspectMessageWithCustomFact(true));
    await harness.flush();
    const matches = harness.sourceMatches.at(-1)!.matches;
    const selectedId = matches.find((entry) => entry.targetRole === "selected")!
      .matchId;
    const parentId = matches.find((entry) => entry.targetRole === "parent")!
      .matchId;

    harness.changePrimaryCursor({ line: 0, character: 2 });
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
      activeMatchIndex: 0,
      activeMatchId: selectedId,
    });

    harness.changePrimaryCursor({ line: 0, character: 10 });
    expect(harness.navigationStates.at(-1)).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 1,
      activeMatchId: parentId,
    });
  });

  it("toggles decorations without clearing source, tree, navigation, or open authority", async () => {
    const harness = await resolvedRuntimeHarness();
    const sourcePublications = harness.sourceMatches.length;
    const matchId = harness.sourceMatches.at(-1)!.matches[0]!.matchId;
    const selectedBefore = harness.lastDecorationRanges("primary");

    harness.runtime.applyPresentationSettings(presentationSettings(false));

    expect(harness.lastDecorationRanges("primary")).toEqual([]);
    expect(harness.lastDecorationRanges("context")).toEqual([]);
    expect(harness.runtime.tree.getMatches()).toHaveLength(1);
    expect(harness.sourceMatches).toHaveLength(sourcePublications);
    expect(harness.navigationStates.at(-1)).toMatchObject({
      selectedMatchCount: 1,
    });

    harness.runtime.open(sourceOpen(matchId));
    expect(harness.cursorSets.at(-1)).toEqual({ line: 0, character: 0 });

    harness.runtime.applyPresentationSettings(presentationSettings(true));
    expect(harness.lastDecorationRanges("primary")).toEqual(selectedBefore);
    expect(harness.sourceMatches).toHaveLength(sourcePublications);
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

  it("still publishes invalidation navigation when empty Source sending fails", () => {
    const sendError = new Error("source invalidation write failed");
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      sourceMatchesSendError: sendError,
    });

    harness.runtime.select(inspectMessageWithCustomFact());

    expect(harness.transportEvents.slice(0, 2)).toEqual([
      "source.matches",
      "source.navigationState",
    ]);
    expect(harness.navigationStates[0]).toEqual({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 0,
      selectedMatchCount: 0,
    });
    expect(harness.errors).toEqual([sendError]);
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
      "pin-op.css",
      "pin-op.scss",
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

  it("registers refresh classifiers into the injected registry", () => {
    const refreshClassifierRegistry = new RefreshClassifierRegistry();
    const harness = runtimeHarness({
      activeLanguageId: "fixture",
      refreshClassifierRegistry,
    });

    harness.runtime.api.registerRefreshClassifier({
      id: "fixture.refresh",
      classify: () => "reload",
    });

    expect(refreshClassifierRegistry.classify({
      uri: "file:///workspace/app.fixture",
      languageId: "fixture",
    })).toBe("reload");
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
  readonly activeText?: string;
  readonly strictDocumentPositions?: boolean;
  readonly refreshClassifierRegistry?: RefreshClassifierRegistry;
  readonly sendError?: Error;
  readonly navigationSendError?: Error;
  readonly diagnosticRecordError?: Error;
  readonly reporterError?: Error;
  readonly excerptReadError?: Error;
  readonly sourceMatchesSendError?: Error;
  readonly sourceMatchesSendResult?: boolean;
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
  const text = options.activeText ?? (options.activeLanguageId === "fixture"
    ? "fixture block"
    : ".layout {}");
  const activeEditorListeners = new Set<
    (editor: ReturnType<typeof createEditor> | undefined) => void
  >();
  const documentListeners = new Set<(document: ReturnType<typeof textDocument>) => void>();
  const primaryCursorListeners = new Set<() => void>();
  const resolutions: ResolutionInput[] = [];
  const sourceMatches: SourceMatchesInput[] = [];
  const navigationStates: SourceNavigationStateInput[] = [];
  const transportEvents: string[] = [];
  const decorationCalls: Array<{
    readonly role: DecorationRole;
    readonly ranges: readonly unknown[];
  }> = [];
  const cursorSets: SourcePosition[] = [];
  const revealedRanges: SourceRange[] = [];
  const errors: unknown[] = [];
  const diagnosticRecords: unknown[][] = [];
  let diagnosticClearCalls = 0;
  let nextDiagnosticClearError: Error | undefined;
  let editor = createEditor(
    uri,
    options.activeLanguageId,
    text,
    1,
    (role, ranges) => decorationCalls.push({ role, ranges }),
    options.strictDocumentPositions,
  );
  if (options.excerptReadError) {
    const getText = editor.document.getText.bind(editor.document);
    let reads = 0;
    vi.spyOn(editor.document, "getText").mockImplementation(() => {
      reads += 1;
      if (reads === 2) throw options.excerptReadError;
      return getText();
    });
  }
  let primaryCursor: SourcePosition = { line: 0, character: 0 };
  const runtime = createPresenterRuntime({
    registry,
    refreshClassifierRegistry: options.refreshClassifierRegistry,
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
      transportEvents.push("resolution");
      if (options.sendError) throw options.sendError;
    },
    sendSourceMatches(matches) {
      sourceMatches.push(matches);
      transportEvents.push("source.matches");
      if (options.sourceMatchesSendError) {
        throw options.sourceMatchesSendError;
      }
      return options.sourceMatchesSendResult ?? true;
    },
    measureSourceMatchesEnvelope(matches) {
      return Buffer.byteLength(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "source.matches",
        messageId: "00000000-0000-4000-8000-000000000000",
        sessionId: "session-1",
        source: { role: "ide", id: "vscode-test" },
        ...matches,
        metadata: {},
      }), "utf8");
    },
    sendSourceNavigationState(state) {
      navigationStates.push(state);
      transportEvents.push("source.navigationState");
      if (options.navigationSendError) throw options.navigationSendError;
      return true;
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
    sourceMatches,
    navigationStates,
    transportEvents,
    decorationCalls,
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
      editor = createEditor(
        nextUri,
        languageId,
        ".card {}",
        1,
        (role, ranges) => decorationCalls.push({ role, ranges }),
        options.strictDocumentPositions,
      );
      for (const listener of activeEditorListeners) listener(editor);
    },
    changeTextDocument(nextText = editor.document.getText()) {
      editor = createEditor(
        editor.documentUri,
        editor.document.languageId,
        nextText,
        editor.document.version + 1,
        (role, ranges) => decorationCalls.push({ role, ranges }),
        options.strictDocumentPositions,
      );
      for (const listener of documentListeners) listener(editor.document);
    },
    movePrimaryCursor(position: SourcePosition) {
      primaryCursor = position;
    },
    changePrimaryCursor(position: SourcePosition) {
      primaryCursor = position;
      for (const listener of primaryCursorListeners) listener();
    },
    lastDecorationRanges(role: DecorationRole): readonly unknown[] {
      return decorationCalls.filter((call) => call.role === role).at(-1)
        ?.ranges ?? [];
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

function fixturePlugin(localPathOrParent?: string | boolean): SourcePlugin {
  const localPath = typeof localPathOrParent === "string"
    ? localPathOrParent
    : undefined;
  const includeParent = localPathOrParent === true;
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
          ...(includeParent
            ? [{
                targetRole: "parent" as const,
                range: {
                  start: { line: 0, character: 8 },
                  end: { line: 0, character: 13 },
                },
                label: "fixture-parent",
                kind: "fixture",
                relation: "contains",
                confidence: "instrumented" as const,
              }]
            : []),
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

function scssFixturePlugin(): SourcePlugin {
  return {
    id: "fixture.scss-source",
    displayName: "SCSS Fixture Source",
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    documentSelectors: [{ languageId: "scss", scheme: "file" }],
    supportedFactKinds: ["fixture.source"],
    async resolve() {
      return {
        matches: [{
          targetRole: "selected",
          range: {
            start: { line: 1, character: 0 },
            end: { line: 3, character: 1 },
          },
          label: ".card",
          kind: "style-rule",
          relation: "styles",
          confidence: "sourcemap",
        }],
      };
    },
  };
}

function createEditor(
  uri: string,
  languageId: string,
  text: string,
  version = 1,
  onDecorate: (
    role: DecorationRole,
    ranges: readonly unknown[],
  ) => void = () => undefined,
  strictDocumentPositions = false,
) {
  return {
    documentUri: uri,
    document: textDocument(
      uri,
      languageId,
      text,
      version,
      strictDocumentPositions,
    ),
    setDecorations(
      type: { readonly role?: DecorationRole },
      ranges: readonly unknown[],
    ) {
      if (type.role) onDecorate(type.role, ranges);
    },
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

function sourceOpen(
  matchId: string,
  overrides: Partial<
    Pick<SourceOpenMessage, "inspectMessageId" | "resolutionGeneration">
  > = {},
): SourceOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId: `open-${matchId}`,
    sessionId: "session-1",
    inspectMessageId: overrides.inspectMessageId ?? "inspect-1",
    resolutionGeneration: overrides.resolutionGeneration ?? 0,
    matchId,
    metadata: {},
  };
}

function presentationSettings(
  ideHighlightEnabled: boolean,
  inspectMessageId = "inspect-1",
): PresentationSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "presentation.settings",
    messageId: `settings-${ideHighlightEnabled}`,
    sessionId: "session-1",
    inspectMessageId,
    ideHighlightEnabled,
    metadata: {},
  };
}

function inspectMessageWithSelectedAndParent(): InspectMessage {
  return inspect([
    cssTarget("selected", 0, ".layout > .card"),
    cssTarget("parent", 1, ".layout"),
  ]);
}

function inspectMessageWithCustomFact(includeParent = false): InspectMessage {
  const selected = {
    role: "selected" as const,
    depth: 0 as const,
    subject: { selector: ".fixture", metadata: {} },
    facts: [
      {
        type: "fixture.source",
        payload: { component: "Fixture" },
        metadata: {},
      },
    ],
    metadata: {},
  };
  return inspect([
    selected,
    ...(includeParent
      ? [{
          ...selected,
          role: "parent" as const,
          depth: 1 as const,
          subject: { selector: ".fixture-parent", metadata: {} },
        }]
      : []),
  ]);
}

function inspect(targets: InspectMessage["targets"]): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    ideHighlightEnabled: true,
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

function textDocument(
  uri: string,
  languageId: string,
  text: string,
  version = 1,
  strictPositions = false,
) {
  class StrictPosition {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  return {
    uri: { toString: () => uri },
    languageId,
    version,
    getText: () => text,
    positionAt(offset: number) {
      const bounded = Math.max(0, Math.min(Math.floor(offset), text.length));
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= bounded) {
        line += 1;
      }
      const character = Math.min(bounded, lineEnd(line)) - lineStarts[line]!;
      return strictPositions
        ? new StrictPosition(line, character)
        : { line, character };
    },
    offsetAt(position: { line: number; character: number }) {
      if (strictPositions && !(position instanceof StrictPosition)) {
        throw new TypeError("Invalid argument: position must be a Position");
      }
      const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
      return Math.max(
        lineStarts[line]!,
        Math.min(lineStarts[line]! + position.character, lineEnd(line)),
      );
    },
  };

  function lineEnd(line: number): number {
    const next = lineStarts[line + 1];
    if (next === undefined) return text.length;
    const lineFeed = next - 1;
    return text[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
  }
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
