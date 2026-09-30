import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  type RulesOpenMessage,
  type SourceNavigateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type {
  ResolutionInput,
  SourceMatchesInput,
  SourceNavigationStateInput,
} from "../src/bridgeClient.js";
import { RulesSourcesClientRouter } from "../src/bridgeClient.js";
import {
  SourceDecorationManager,
  type DecorationRole,
} from "../src/presenter/decorations.js";
import {
  createPresenterDocumentHost,
  createPresenterRuntime,
  type PresenterDocumentLike,
} from "../src/presenter/runtime.js";
import { RefreshClassifierRegistry } from "../src/refresh/refreshClassifierRegistry.js";
import type { RulesSourcesPublicationPayload } from
  "../src/rules/rulesSourcesPublication.js";
import type {
  ResolvedRuleSource,
  RulesSourceResolutionBatch,
  RulesSourceResolverRequest,
} from "../src/rules/rulesSourceResolver.js";
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
      "pin-op.php",
      "pin-op.javascript",
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

  it("brands presenter-opened documents and rejects a forged adapter", async () => {
    const rawDocument = textDocument(
      "file:///workspace/dist/app.css",
      "css",
      ".card { color: red; }",
      1,
    );
    const exactEditor = {
      ...createEditor(
        rawDocument.uri.toString(),
        rawDocument.languageId,
        rawDocument.getText(),
        rawDocument.version,
      ),
      document: rawDocument,
    };
    const foreignSameIdentity = createEditor(
      rawDocument.uri.toString(),
      rawDocument.languageId,
      rawDocument.getText(),
      rawDocument.version,
    );
    const showTextDocument = vi.fn()
      .mockResolvedValueOnce(exactEditor)
      .mockResolvedValueOnce(foreignSameIdentity);
    const host = createPresenterDocumentHost({
      openTextDocument: vi.fn(async () => rawDocument),
      createPosition: (line, character) => new TestPosition(line, character),
      showTextDocument,
    });
    const adapter = await host.openTextDocument(rawDocument.uri.toString());

    expect(Object.isFrozen(adapter)).toBe(true);
    await expect(host.showTextDocument(adapter)).resolves.toMatchObject({
      documentUri: rawDocument.uri.toString(),
    });
    await expect(host.showTextDocument({
      ...adapter,
    } as PresenterDocumentLike)).rejects.toThrow(/presenter document/i);
    await expect(host.showTextDocument(adapter)).rejects.toThrow(
      /document identity/i,
    );
    expect(showTextDocument).toHaveBeenCalledTimes(2);
  });

  it("creates a frozen presenter adapter without eagerly indexing document text", async () => {
    const rawDocument = textDocument(
      "file:///workspace/dist/app.css",
      "css",
      ".card { color: red; }",
      1,
      true,
    );
    const getText = vi.spyOn(rawDocument, "getText");
    const positionAt = vi.spyOn(rawDocument, "positionAt");
    const offsetAt = vi.spyOn(rawDocument, "offsetAt");
    const createPosition = vi.fn((line: number, character: number) =>
      new TestPosition(line, character)
    );
    const host = createPresenterDocumentHost({
      openTextDocument: vi.fn(async () => rawDocument),
      createPosition,
      showTextDocument: vi.fn(async () => ({
        ...createEditor(
          rawDocument.uri.toString(),
          rawDocument.languageId,
          rawDocument.getText(),
          rawDocument.version,
        ),
        document: rawDocument,
      })),
    });

    const adapter = await host.openTextDocument(rawDocument.uri.toString());

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(getText).not.toHaveBeenCalled();
    expect(adapter.positionAt(1)).toEqual({ line: 0, character: 1 });
    expect(adapter.offsetAt({ line: 0, character: 2 })).toBe(2);
    expect(adapter.getText()).toBe(".card { color: red; }");
    expect(positionAt).toHaveBeenCalledOnce();
    expect(offsetAt).toHaveBeenCalledOnce();
    expect(createPosition).toHaveBeenCalledWith(0, 2);
    expect(getText).toHaveBeenCalledOnce();
  });

  it("tells the Rules resolver whenever any workspace stylesheet changes", () => {
    const changed: string[] = [];
    const harness = rulesRuntimeHarness({
      stylesheetsChanged: () => changed.push("stylesheets"),
    });

    harness.fireFileChange("file:///workspace/vendor/unrelated.css");
    harness.fireFileCreate("file:///workspace/build/new.CSS");
    harness.fireFileChange("file:///workspace/src/app.ts");
    harness.fireTextDocument("file:///workspace/src/open.css");
    harness.fireWorkspaceFoldersChanged();

    expect(changed).toHaveLength(4);
    harness.runtime.dispose();
  });

  it("keeps Rules authority current across active-editor and Source navigation", async () => {
    const harness = rulesRuntimeHarness();
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    const publication = harness.rulesPublications.at(-1)!;
    const source = publication.sources[0]!;

    harness.changeActiveEditor();
    harness.runtime.navigate(sourceNavigate("next"));
    await harness.flush();
    expect(harness.rulesPublications).toHaveLength(1);

    await harness.runtime.openRuleSource(rulesOpen(
      publication.inspectMessageId,
      publication.rulesGeneration,
      source.openAuthorityId,
    ));

    expect(harness.openedUris).toEqual([
      "file:///workspace/dist/app.css",
    ]);
    expect(harness.cursorSets).toEqual([{ line: 0, character: 0 }]);
    expect(harness.revealedRanges).toEqual([{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 21 },
    }]);
  });

  it("publishes Rules through only the currently bound bridge client", async () => {
    const router = new RulesSourcesClientRouter();
    const first = {
      sendRulesSources: vi.fn(() => true),
      rulesSourcesEnvelopeBytes: vi.fn(() => 8_192),
    };
    const second = {
      sendRulesSources: vi.fn(() => true),
      rulesSourcesEnvelopeBytes: vi.fn(() => 8_192),
    };
    router.bind(first);
    const harness = rulesRuntimeHarness({
      sendRulesSources: (payload) => router.sendRulesSources(payload),
      measureRulesSourcesEnvelope: (payload) =>
        router.rulesSourcesEnvelopeBytes(payload),
    });

    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    router.bind(second);
    router.unbind(first);
    await harness.runtime.stylesheetRefresh();

    expect(first.sendRulesSources).toHaveBeenCalledOnce();
    expect(second.sendRulesSources).toHaveBeenCalledOnce();
    expect(first.sendRulesSources.mock.calls[0]?.[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
    });
    expect(second.sendRulesSources.mock.calls[0]?.[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
    });
  });

  it("opens a Rules target through a host that requires native positions", async () => {
    const harness = rulesRuntimeHarness({ strictPresenterPositions: true });
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    const publication = harness.rulesPublications[0]!;

    await harness.runtime.openRuleSource(rulesOpen(
      publication.inspectMessageId,
      publication.rulesGeneration,
      publication.sources[0]!.openAuthorityId,
    ));

    expect(harness.shownUris).toEqual(["file:///workspace/dist/app.css"]);
    expect(harness.cursorSets).toEqual([{ line: 0, character: 0 }]);
    expect(harness.revealedRanges).toEqual([{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 21 },
    }]);
  });

  it("rehashes a grown target without eager presenter document adaptation", async () => {
    const harness = rulesRuntimeHarness();
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    const publication = harness.rulesPublications[0]!;
    const source = publication.sources[0]!;
    harness.growTarget(".card { color: blue; }", 2);

    await harness.runtime.openRuleSource(rulesOpen(
      publication.inspectMessageId,
      publication.rulesGeneration,
      source.openAuthorityId,
    ));

    expect(harness.openedUris).toEqual([
      "file:///workspace/dist/app.css",
    ]);
    expect(harness.presenterGetTextCalls).toBe(0);
    expect(harness.shownUris).toEqual([]);
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealedRanges).toEqual([]);
  });

  it("revokes Rules on clear/refresh/dispose and never on source.open", async () => {
    const harness = rulesRuntimeHarness();
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();
    const first = harness.rulesPublications[0]!;

    harness.runtime.open(sourceOpen("unknown-source-match"));
    expect(harness.rulesPublications).toHaveLength(1);
    await harness.runtime.stylesheetRefresh();
    expect(harness.rulesPublications.at(-1)?.rulesGeneration).toBe(2);

    harness.runtime.clear();
    await harness.runtime.openRuleSource(rulesOpen(
      first.inspectMessageId,
      first.rulesGeneration,
      first.sources[0]!.openAuthorityId,
    ));
    expect(harness.openedUris).toEqual([]);

    harness.runtime.dispose();
    await harness.runtime.openRuleSource(rulesOpen(
      first.inspectMessageId,
      first.rulesGeneration,
      first.sources[0]!.openAuthorityId,
    ));
    expect(harness.openedUris).toEqual([]);
  });

  it("watches each workspace folder and filters eager invalidation to exact dependencies", async () => {
    const harness = rulesRuntimeHarness();
    expect(harness.watcherCreations).toBe(1);
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();

    harness.fireFileChange("file:///workspace/unrelated.css");
    await harness.flush();
    expect(harness.rulesPublications).toHaveLength(1);

    harness.fireFileChange("file:///workspace/dist/app.css");
    await harness.flush();
    harness.fireTextDocument("file:///workspace/dist/app.css");
    await harness.flush();
    expect(harness.rulesPublications.map((entry) => entry.rulesGeneration))
      .toEqual([1, 2, 3]);

    harness.fireWorkspaceFoldersChanged();
    await harness.flush();
    expect(harness.rulesPublications.at(-1)?.rulesGeneration).toBe(4);
    expect(harness.watcherCreations).toBe(2);
    expect(harness.watcherDisposals).toBe(1);

    harness.runtime.dispose();
    expect(harness.watcherDisposals).toBe(2);
  });

  it.each(["text-css", "create-map", "change-scss"] as const)(
    "restarts a first in-flight Rules resolution for %s without active-editor restarts",
    async (event) => {
      const paused = deferred<RulesSourceResolutionBatch>();
      let attempt = 0;
      const harness = rulesRuntimeHarness({
        resolve(request) {
          attempt += 1;
          return attempt === 1
            ? paused.promise
            : Promise.resolve(unresolvedRulesBatch(request));
        },
      });
      harness.runtime.select(inspectMessageWithSelectedAndParent());
      await harness.flush();
      expect(harness.resolve).toHaveBeenCalledTimes(1);

      harness.changeActiveEditor();
      await harness.flush();
      expect(harness.resolve).toHaveBeenCalledTimes(1);

      if (event === "text-css") {
        harness.fireTextDocument("file:///workspace/dist/app.css");
      } else if (event === "create-map") {
        harness.fireFileCreate("file:///workspace/dist/app.css.map");
      } else {
        harness.fireFileChange("file:///workspace/src/card.scss");
      }
      await harness.flush();
      const attemptsBeforeRelease = harness.resolve.mock.calls.length;
      paused.resolve(unresolvedRulesBatch(harness.resolve.mock.calls[0]![0]));
      await harness.flush();

      expect(attemptsBeforeRelease).toBe(2);
      expect(harness.resolve.mock.calls[0]![0].signal?.aborted).toBe(true);
      expect(harness.rulesPublications).toHaveLength(1);
      expect(harness.rulesPublications[0]).toMatchObject({
        inspectMessageId: "inspect-1",
        rulesGeneration: 1,
      });
    },
  );

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

function rulesRuntimeHarness(options: {
  readonly resolve?: (
    request: RulesSourceResolverRequest,
  ) => Promise<RulesSourceResolutionBatch>;
  readonly stylesheetsChanged?: () => void;
  readonly strictPresenterPositions?: boolean;
  readonly sendRulesSources?: (
    payload: RulesSourcesPublicationPayload,
  ) => boolean;
  readonly measureRulesSourcesEnvelope?: (
    payload: RulesSourcesPublicationPayload,
  ) => number;
} = {}) {
  const cssUri = "file:///workspace/dist/app.css";
  let cssText = ".card { color: red; }";
  let cssVersion = 1;
  const cssHash = createHash("sha256").update(cssText).digest("hex");
  let workspaceGeneration = 0;
  const rulesWorkspace: SourceWorkspace & {
    currentRulesSourceGeneration(): number;
    readRulesSourceSnapshot(uri: string): Promise<{
      readonly uri: string;
      readonly text: string;
      readonly documentVersion: number;
    }>;
  } = {
    findFiles: async () => [cssUri],
    readText: async () => cssText,
    resolveSourceUri: async () => ({
      uris: [cssUri],
      status: "exact",
      strategy: "automatic",
    }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
    currentRulesSourceGeneration: () => workspaceGeneration,
    readRulesSourceSnapshot: async (uri) => ({
      uri,
      text: cssText,
      documentVersion: cssVersion,
    }),
  };
  const rulesPublications: RulesSourcesPublicationPayload[] = [];
  const openedUris: string[] = [];
  const shownUris: string[] = [];
  let presenterGetTextCalls = 0;
  const cursorSets: SourcePosition[] = [];
  const revealedRanges: SourceRange[] = [];
  const activeEditorListeners = new Set<
    (editor: ReturnType<typeof createEditor> | undefined) => void
  >();
  const documentChangeListeners = new Set<
    (document: ReturnType<typeof textDocument>) => void
  >();
  const workspaceFolderListeners = new Set<() => void>();
  const fileCreateListeners = new Set<(uri: { toString(): string }) => void>();
  const fileChangeListeners = new Set<(uri: { toString(): string }) => void>();
  const fileDeleteListeners = new Set<(uri: { toString(): string }) => void>();
  let watcherCreations = 0;
  let watcherDisposals = 0;
  let editor = createEditor(
    "file:///workspace/src/active.css",
    "css",
    ".active {}",
    1,
  );
  const presenterDocuments = createPresenterDocumentHost({
    async openTextDocument(uri) {
      openedUris.push(uri);
      const source = textDocument(
        uri,
        "css",
        cssText,
        cssVersion,
        options.strictPresenterPositions,
      );
      return {
        ...source,
        getText() {
          presenterGetTextCalls += 1;
          return source.getText();
        },
      };
    },
    createPosition: (line, character) => new TestPosition(line, character),
    async showTextDocument(document_) {
      shownUris.push(document_.uri.toString());
      editor = {
        ...createEditor(
        document_.uri.toString(),
        document_.languageId,
        document_.getText(),
        document_.version,
        ),
        document: document_ as ReturnType<typeof textDocument>,
      };
      return editor;
    },
  });
  const resolve = vi.fn(options.resolve ?? (async (
    request: RulesSourceResolverRequest,
  ) => ({
    selectionMessageId: request.selectionMessageId,
    results: [...new Set(request.ruleEvidence.rules.map((rule) => rule.ruleRef))]
      .map((ruleRef): ResolvedRuleSource => ({
        kind: "resolved",
        ruleRef,
        document: { uri: cssUri, languageId: "css", version: 1 },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 21 },
        },
        confidence: "exact",
        dependencies: [{
          kind: "generated-css",
          uri: cssUri,
          documentVersion: 1,
          contentHash: cssHash,
        }],
      })),
  })));
  const runtime = createPresenterRuntime({
    workspace: rulesWorkspace,
    rulesSourceResolver: {
      resolve,
      ...(options.stylesheetsChanged
        ? { stylesheetsChanged: options.stylesheetsChanged }
        : {}),
    },
    sendRulesSources(payload) {
      rulesPublications.push(payload);
      return options.sendRulesSources?.(payload) ?? true;
    },
    measureRulesSourcesEnvelope(payload) {
      if (options.measureRulesSourcesEnvelope) {
        return options.measureRulesSourcesEnvelope(payload);
      }
      return Buffer.byteLength(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "rules.sources",
        messageId: "00000000-0000-4000-8000-000000000000",
        sessionId: "session-1",
        source: { role: "ide", id: "vscode-test" },
        ...payload,
        metadata: {},
      }), "utf8");
    },
    host: {
      ...presenterDocuments,
      getActiveEditor: () => editor,
      getPrimaryCursor: () => ({ line: 0, character: 0 }),
      setPrimaryCursor(_editor, position) {
        cursorSets.push(position);
      },
      revealRange(_editor, range) {
        revealedRanges.push(range as SourceRange);
      },
      onDidChangeActiveEditor(listener) {
        activeEditorListeners.add(listener);
        return disposable(() => activeEditorListeners.delete(listener));
      },
      onDidChangeTextDocument(listener) {
        documentChangeListeners.add(listener as (
          document: ReturnType<typeof textDocument>,
        ) => void);
        return disposable(() => documentChangeListeners.delete(listener as (
          document: ReturnType<typeof textDocument>,
        ) => void));
      },
      onDidChangeWorkspaceFolders(listener) {
        workspaceFolderListeners.add(listener);
        return disposable(() => workspaceFolderListeners.delete(listener));
      },
      createRulesSourceFileWatcher() {
        watcherCreations += 1;
        return {
          onDidCreate(listener) {
            fileCreateListeners.add(listener);
            return disposable(() => fileCreateListeners.delete(listener));
          },
          onDidChange(listener) {
            fileChangeListeners.add(listener);
            return disposable(() => fileChangeListeners.delete(listener));
          },
          onDidDelete(listener) {
            fileDeleteListeners.add(listener);
            return disposable(() => fileDeleteListeners.delete(listener));
          },
          dispose() {
            watcherDisposals += 1;
          },
        };
      },
      onDidChangePrimaryCursor: () => disposable(() => undefined),
      createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
      createThemeColor: (id) => ({ id }) as vscode.ThemeColor,
      overviewRulerLaneRight: 4,
      createDecorationType: (_style, role) => ({
        role,
        dispose: () => undefined,
      }),
      createRange: (startLine, startCharacter, endLine, endCharacter) => ({
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter },
      }),
      registerTreeDataProvider: () => disposable(() => undefined),
      registerCommand: () => disposable(() => undefined),
      reportError: () => undefined,
      workspaceFolders: [{ uri: { toString: () => "file:///workspace" } }],
      findFiles: async () => [],
      joinPath: (base) => base,
      parseUri: (value) => ({ toString: () => value }),
      readFile: async () => new Uint8Array(),
      stat: async () => ({ size: Buffer.byteLength(cssText, "utf8") }),
      getOpenTextDocument: () => undefined,
      openWorkspaceTextDocument: async (uri) => textDocument(
        uri.toString(),
        "css",
        cssText,
        cssVersion,
      ),
      currentRulesSourceGeneration: () => workspaceGeneration,
      advanceRulesSourceGeneration() {
        workspaceGeneration += 1;
      },
    },
  });

  return {
    runtime,
    resolve,
    rulesPublications,
    openedUris,
    shownUris,
    cursorSets,
    revealedRanges,
    get presenterGetTextCalls() {
      return presenterGetTextCalls;
    },
    get watcherCreations() {
      return watcherCreations;
    },
    get watcherDisposals() {
      return watcherDisposals;
    },
    changeActiveEditor() {
      editor = createEditor(
        "file:///workspace/src/other.css",
        "css",
        ".other {}",
        1,
      );
      for (const listener of activeEditorListeners) listener(editor);
    },
    fireFileChange(uri: string) {
      const value = { toString: () => uri };
      for (const listener of fileChangeListeners) listener(value);
    },
    fireFileCreate(uri: string) {
      const value = { toString: () => uri };
      for (const listener of fileCreateListeners) listener(value);
    },
    fireTextDocument(uri: string) {
      const value = textDocument(uri, "css", cssText, cssVersion);
      for (const listener of documentChangeListeners) listener(value);
    },
    growTarget(text: string, version: number) {
      cssText = text;
      cssVersion = version;
    },
    fireWorkspaceFoldersChanged() {
      for (const listener of workspaceFolderListeners) listener();
    },
    flush,
  };
}

function unresolvedRulesBatch(
  request: RulesSourceResolverRequest,
): RulesSourceResolutionBatch {
  return {
    selectionMessageId: request.selectionMessageId,
    results: [...new Set(
      request.ruleEvidence.rules.map((rule) => rule.ruleRef),
    )].map((ruleRef) => ({
      kind: "unresolved" as const,
      ruleRef,
      reason: "fixture-paused",
    })),
  };
}

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
  const presenterDocuments = createPresenterDocumentHost({
    openTextDocument: async () => editor.document,
    createPosition: (line, character) => new TestPosition(line, character),
    showTextDocument: async () => editor,
  });
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
      ...presenterDocuments,
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

function rulesOpen(
  inspectMessageId: string,
  rulesGeneration: number,
  openAuthorityId: string,
): RulesOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.open",
    messageId: "rules-open-1",
    sessionId: "session-1",
    inspectMessageId,
    rulesGeneration,
    openAuthorityId,
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
  const rules = targets.flatMap((target, targetIndex) =>
    target.facts.flatMap((fact) =>
      fact.type === "css-rule" && "ruleRef" in fact
        ? [{
            ruleRef: fact.ruleRef,
            selector: target.subject.selector,
            declarations: [{
              property: fact.property,
              value: fact.value,
              important: fact.important,
              valueTruncated: fact.valueTruncated,
            }],
            declarationsTruncated: false,
            generatedSource: {
              sourceUrl: "http://localhost:4173/dist/app.css",
              rulePath: `${targetIndex}.0`,
              contexts: [],
              contextsTruncated: false,
              unsupportedGroupContext: false,
            },
          }]
        : []
    )
  );
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    ideHighlightEnabled: true,
    targets,
    ruleEvidence: { rules, omittedRuleCount: 0 },
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
        ruleRef: `rule-${role}`,
        property: "display",
        value: "grid",
        important: false,
        valueTruncated: false,
        metadata: {},
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
        ? new TestPosition(line, character)
        : { line, character };
    },
    offsetAt(position: { line: number; character: number }) {
      if (strictPositions && !(position instanceof TestPosition)) {
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

class TestPosition {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
