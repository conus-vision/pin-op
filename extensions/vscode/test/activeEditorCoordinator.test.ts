import { describe, expect, it, vi } from "vitest";
import type {
  Disposable,
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
} from "@pin-op/protocol";
import {
  ActiveEditorCoordinator,
  type ActiveEditorLike,
  type CoordinatorPublication,
  type CoordinatorHost,
  type SourcePluginRegistryLike,
} from "../src/presenter/activeEditorCoordinator.js";
import { SelectionStore } from "../src/presenter/selectionStore.js";
import type {
  PluginResolutionCandidate,
  SourcePluginDispatch,
  SourceResolution,
} from "../src/sourcePlugins/types.js";

describe("ActiveEditorCoordinator", () => {
  it("publishes no-active-editor instead of silently returning", async () => {
    const harness = outcomeHarness({ activeEditor: undefined });

    harness.coordinator.select(inspectMessage("inspect-no-editor"));
    await harness.flush();

    expect(harness.outcomes).toEqual([
      expect.objectContaining({
        inspectMessageId: "inspect-no-editor",
        resolutionGeneration: 0,
        outcome: expect.objectContaining({ status: "no-active-editor" }),
      }),
    ]);
    expect(harness.resolveCalls).toHaveLength(0);
  });

  it("distinguishes unsupported documents from no facts", async () => {
    const unsupported = outcomeHarness({
      activeEditor: editor("file:///src/app.ts", "typescript", 1),
      dispatch: {
        kind: "unsupported-document",
        documentUri: "file:///src/app.ts",
        documentVersion: 1,
      },
    });
    unsupported.coordinator.select(inspectMessage("unsupported"));
    await unsupported.flush();

    const noFacts = outcomeHarness();
    noFacts.coordinator.select(inspectMessage("no-facts", false));
    await noFacts.flush();

    expect(unsupported.outcomes[0]?.outcome.status).toBe(
      "unsupported-document",
    );
    expect(noFacts.outcomes[0]?.outcome.status).toBe("no-facts");
  });

  it("counts normalized selected ranges before immediate-parent ranges", async () => {
    const matches = [
      resolvedMatch("parent", 0, 4, "parent-duplicate"),
      resolvedMatch("selected", 0, 4, "selected"),
      resolvedMatch("selected", 5, 9, "selected-a"),
      resolvedMatch("selected", 5, 9, "selected-b"),
      resolvedMatch("parent", 10, 14, "parent"),
    ];
    const harness = outcomeHarness({
      dispatch: resolvedDispatch("inspect-ranges", matches),
    });

    harness.coordinator.select(inspectMessage("inspect-ranges"));
    await harness.flush();

    expect(harness.outcomes[0]?.outcome).toMatchObject({
      status: "matched",
      selectedMatchCount: 2,
      parentMatchCount: 1,
    });
    expect(harness.outcomes[0]?.resolution?.matches).toHaveLength(3);
  });

  it("reuses the inspect ID and increments generation on every rerun trigger", async () => {
    vi.useFakeTimers();
    try {
      const harness = outcomeHarness();
      harness.coordinator.select(inspectMessage("inspect-generation"));
      await harness.flush();
      harness.changeActiveEditor(editor("file:///src/other.css", "css", 1));
      await harness.flush();
      harness.changeDocumentVersion(2);
      await vi.advanceTimersByTimeAsync(150);
      await harness.flush();
      harness.emitPluginChange();
      await harness.flush();

      expect(harness.outcomes.map((entry) => [
        entry.inspectMessageId,
        entry.resolutionGeneration,
      ])).toEqual([
        ["inspect-generation", 0],
        ["inspect-generation", 1],
        ["inspect-generation", 2],
        ["inspect-generation", 3],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes exactly one current outcome and ignores cancelled work", async () => {
    const harness = deferredOutcomeHarness();
    harness.coordinator.select(inspectMessage("old"));
    harness.coordinator.select(inspectMessage("new"));

    harness.resolve("old", resolvedDispatch("old"));
    harness.resolve("new", resolvedDispatch("new"));
    await harness.flush();

    expect(harness.outcomes.map((entry) => [
      entry.inspectMessageId,
      entry.resolutionGeneration,
    ])).toEqual([["new", 0]]);
    expect(harness.signals.get("old")?.aborted).toBe(true);
  });

  it("still publishes the current outcome when local presentation fails", async () => {
    const localError = new Error("decoration failed");
    const harness = outcomeHarness({ publishError: localError });

    harness.coordinator.select(inspectMessage("inspect-presentation-error"));
    await harness.flush();

    expect(harness.errors).toEqual([localError]);
    expect(harness.outcomes).toEqual([
      expect.objectContaining({
        inspectMessageId: "inspect-presentation-error",
        resolutionGeneration: 0,
      }),
    ]);
  });

  it("reports invalidation clear failures safely and still publishes the current outcome", async () => {
    const clearError = new Error("clear failed");
    const reporterError = new Error("reporter failed");
    const harness = outcomeHarness({ clearError, reporterError });

    harness.coordinator.select(inspectMessage("inspect-clear-error"));
    await harness.flush();

    expect(harness.errors).toEqual([clearError]);
    expect(harness.resolveCalls).toHaveLength(1);
    expect(harness.outcomes).toEqual([
      expect.objectContaining({
        inspectMessageId: "inspect-clear-error",
        resolutionGeneration: 0,
      }),
    ]);
  });

  it("retains selection and resolves it against each active editor", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.select(inspectMessage("inspect-1"));
    await harness.flush();
    harness.changeActiveEditor(editor("file:///src/card.scss", "scss", 1));
    await harness.flush();

    expect(harness.resolveCalls.map((call) => call.document.languageId)).toEqual([
      "css",
      "scss",
    ]);
    expect(harness.openDocumentCalls).toBe(0);
  });

  it("debounces active document changes by 150ms", async () => {
    vi.useFakeTimers();
    try {
      const harness = coordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      await harness.flush();
      harness.changeDocumentVersion(2);
      harness.changeDocumentVersion(3);
      await vi.advanceTimersByTimeAsync(149);
      expect(harness.resolveCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.resolveCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and ignores a stale resolution", async () => {
    const harness = deferredCoordinatorHarness();
    harness.coordinator.select(inspectMessage("old"));
    harness.coordinator.select(inspectMessage("new"));
    expect(harness.signals.get("old")?.aborted).toBe(true);
    harness.resolve("old", resolution("old"));
    harness.resolve("new", resolution("new"));
    await harness.flush();

    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "new",
    ]);
  });

  it("clears and aborts immediately before a replacement selection settles", async () => {
    const harness = deferredCoordinatorHarness();
    harness.coordinator.select(inspectMessage("old"));
    harness.resolve("old", resolution("old"));
    await harness.flush();
    const clearCalls = harness.clearCalls;

    harness.coordinator.select(inspectMessage("new"));

    expect(harness.clearCalls).toBe(clearCalls + 1);
    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "old",
    ]);

    harness.resolve("new", resolution("new"));
    await harness.flush();
    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "old",
      "new",
    ]);
  });

  it("invalidates immediately while debouncing active document resolution", async () => {
    vi.useFakeTimers();
    try {
      const harness = deferredCoordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      const clearCalls = harness.clearCalls;

      harness.changeDocumentVersion(2);

      expect(harness.clearCalls).toBe(clearCalls + 1);
      expect(harness.signals.get("inspect-1")?.aborted).toBe(true);
      expect(harness.resolveCalls).toHaveLength(1);

      harness.resolve(
        "inspect-1",
        resolution("inspect-1", harness.resolveCalls[0]!.document),
      );
      await harness.flush();
      expect(harness.published).toEqual([]);

      await vi.advanceTimersByTimeAsync(149);
      expect(harness.resolveCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.resolveCalls.map((call) => call.document.version)).toEqual([
        1,
        2,
      ]);
      expect(harness.published).toEqual([]);

      harness.resolve(
        "inspect-1",
        resolution("inspect-1", harness.resolveCalls[1]!.document),
      );
      await harness.flush();
      expect(harness.published.map((entry) => entry.documentVersion)).toEqual([
        2,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("identifies invalidation with the current inspect, generation, and editor version", async () => {
    vi.useFakeTimers();
    try {
      const harness = coordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-authority"));
      await harness.flush();

      expect(harness.invalidations.at(-1)).toMatchObject({
        inspectMessageId: "inspect-authority",
        resolutionGeneration: 0,
        editor: { document: { version: 1 } },
      });

      harness.changeDocumentVersion(2);
      expect(harness.invalidations.at(-1)).toMatchObject({
        inspectMessageId: "inspect-authority",
        resolutionGeneration: 1,
        editor: { document: { version: 2 } },
      });

      await vi.advanceTimersByTimeAsync(150);
      await harness.flush();
      harness.changeActiveEditor(editor("file:///src/other.css", "css", 4));
      expect(harness.invalidations.at(-1)).toMatchObject({
        inspectMessageId: "inspect-authority",
        resolutionGeneration: 2,
        editor: { document: { version: 4 } },
      });

      harness.coordinator.clearSelection();
      expect(harness.invalidations.at(-1)).toMatchObject({
        inspectMessageId: "inspect-authority",
        resolutionGeneration: 2,
        editor: { document: { version: 4 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears on selection, editor, plugin, and explicit-clear triggers", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.select(inspectMessage("inspect-1"));
    expect(harness.clearCalls).toBe(1);
    await harness.flush();
    harness.changeActiveEditor(undefined);
    expect(harness.clearCalls).toBe(2);
    await harness.flush();
    harness.changeActiveEditor(editor("file:///src/app.css", "css", 1));
    expect(harness.clearCalls).toBe(3);
    harness.emitPluginChange();
    expect(harness.clearCalls).toBe(4);
    await harness.flush();
    harness.coordinator.clearSelection();
    expect(harness.clearCalls).toBe(5);
    await harness.flush();

    expect(harness.resolveCalls).toHaveLength(3);
  });

  it("disposes subscriptions, timers, and pending work", async () => {
    vi.useFakeTimers();
    try {
      const harness = coordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      await harness.flush();
      harness.changeDocumentVersion(2);
      harness.coordinator.dispose();
      await vi.advanceTimersByTimeAsync(150);
      harness.emitPluginChange();

      expect(harness.resolveCalls).toHaveLength(1);
      expect(harness.disposals()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

function coordinatorHarness() {
  let activeEditor: ActiveEditorLike | undefined = editor(
    "file:///src/app.css",
    "css",
    1,
  );
  const activeListeners = new Set<(editor: ActiveEditorLike | undefined) => void>();
  const documentListeners = new Set<(document: SourceDocumentLike) => void>();
  const pluginListeners = new Set<() => void>();
  const resolveCalls: Array<{
    selection: SelectionSnapshot;
    document: SourceDocument;
    signal: AbortSignal;
  }> = [];
  const published: SourceResolution[] = [];
  const invalidations: unknown[] = [];
  let clearCalls = 0;
  let openDocumentCalls = 0;
  let disposed = 0;
  const host: CoordinatorHost = {
    getActiveEditor: () => activeEditor,
    onDidChangeActiveEditor(listener) {
      activeListeners.add(listener);
      return disposable(() => {
        activeListeners.delete(listener);
        disposed += 1;
      });
    },
    onDidChangeTextDocument(listener) {
      documentListeners.add(listener);
      return disposable(() => {
        documentListeners.delete(listener);
        disposed += 1;
      });
    },
  };
  const registry: SourcePluginRegistryLike = {
    onDidChange(listener) {
      pluginListeners.add(listener);
      return disposable(() => {
        pluginListeners.delete(listener);
        disposed += 1;
      });
    },
    async resolve(selection, document, _workspace, signal) {
      resolveCalls.push({ selection, document, signal });
      return resolvedDispatch(
        selection.messageId,
        resolution(selection.messageId, document).matches,
      );
    },
  };
  const coordinator = new ActiveEditorCoordinator({
    host,
    registry,
    workspace: workspace(),
    store: new SelectionStore(),
    publish: (_editor, result) => published.push(result),
    clear: (...arguments_: unknown[]) => {
      clearCalls += 1;
      invalidations.push(arguments_[0]);
    },
  });

  return {
    coordinator,
    resolveCalls,
    published,
    invalidations,
    get clearCalls() {
      return clearCalls;
    },
    get openDocumentCalls() {
      return openDocumentCalls;
    },
    changeActiveEditor(next: ActiveEditorLike | undefined) {
      activeEditor = next;
      for (const listener of activeListeners) listener(next);
    },
    changeDocumentVersion(version: number) {
      if (!activeEditor) return;
      activeEditor = editor(
        activeEditor.document.uri.toString(),
        activeEditor.document.languageId,
        version,
      );
      for (const listener of documentListeners) {
        listener(activeEditor.document);
      }
    },
    emitPluginChange() {
      for (const listener of pluginListeners) listener();
    },
    disposals: () => disposed,
    flush,
  };
}

function deferredCoordinatorHarness() {
  let activeEditor: ActiveEditorLike | undefined = editor(
    "file:///src/app.css",
    "css",
    1,
  );
  const documentListeners = new Set<(document: SourceDocumentLike) => void>();
  const pending = new Map<
    string,
    (resolution: SourcePluginDispatch) => void
  >();
  const signals = new Map<string, AbortSignal>();
  const resolveCalls: Array<{
    selection: SelectionSnapshot;
    document: SourceDocument;
    signal: AbortSignal;
  }> = [];
  const published: SourceResolution[] = [];
  let clearCalls = 0;
  const registry: SourcePluginRegistryLike = {
    onDidChange: () => disposable(() => undefined),
    resolve(selection, document, _workspace, signal) {
      signals.set(selection.messageId, signal);
      resolveCalls.push({ selection, document, signal });
      return new Promise((resolve) => pending.set(selection.messageId, resolve));
    },
  };
  const coordinator = new ActiveEditorCoordinator({
    host: {
      getActiveEditor: () => activeEditor,
      onDidChangeActiveEditor: () => disposable(() => undefined),
      onDidChangeTextDocument(listener) {
        documentListeners.add(listener);
        return disposable(() => documentListeners.delete(listener));
      },
    },
    registry,
    workspace: workspace(),
    store: new SelectionStore(),
    publish: (_editor, result) => published.push(result),
    clear: () => {
      clearCalls += 1;
    },
  });
  return {
    coordinator,
    published,
    signals,
    resolveCalls,
    get clearCalls() {
      return clearCalls;
    },
    changeDocumentVersion(version: number) {
      if (!activeEditor) return;
      activeEditor = editor(
        activeEditor.document.uri.toString(),
        activeEditor.document.languageId,
        version,
      );
      for (const listener of documentListeners) {
        listener(activeEditor.document);
      }
    },
    resolve(messageId: string, result: SourceResolution) {
      const dispatch = resolvedDispatch(
        result.selectionMessageId,
        result.matches,
      );
      pending.get(messageId)?.(
        dispatch.kind === "resolved"
          ? { ...dispatch, resolution: result }
          : dispatch,
      );
    },
    flush,
  };
}

function outcomeHarness(
  options: {
    readonly activeEditor?: ActiveEditorLike;
    readonly dispatch?: SourcePluginDispatch;
    readonly publishError?: Error;
    readonly clearError?: Error;
    readonly reporterError?: Error;
  } = {},
) {
  let activeEditor = Object.hasOwn(options, "activeEditor")
    ? options.activeEditor
    : editor("file:///src/app.css", "css", 1);
  const activeListeners = new Set<
    (editor: ActiveEditorLike | undefined) => void
  >();
  const documentListeners = new Set<(document: SourceDocumentLike) => void>();
  const pluginListeners = new Set<() => void>();
  const outcomes: CoordinatorPublication[] = [];
  const errors: unknown[] = [];
  const resolveCalls: Array<{
    readonly selection: SelectionSnapshot;
    readonly signal: AbortSignal;
  }> = [];
  const registry: SourcePluginRegistryLike = {
    onDidChange(listener) {
      pluginListeners.add(listener);
      return disposable(() => pluginListeners.delete(listener));
    },
    async resolve(selection, _document, _workspace, signal) {
      resolveCalls.push({ selection, signal });
      return withSelectionId(
        options.dispatch ?? resolvedDispatch(selection.messageId),
        selection.messageId,
      );
    },
  };
  const coordinator = new ActiveEditorCoordinator({
    host: {
      getActiveEditor: () => activeEditor,
      onDidChangeActiveEditor(listener) {
        activeListeners.add(listener);
        return disposable(() => activeListeners.delete(listener));
      },
      onDidChangeTextDocument(listener) {
        documentListeners.add(listener);
        return disposable(() => documentListeners.delete(listener));
      },
    },
    registry,
    workspace: workspace(),
    store: new SelectionStore(),
    publish: () => {
      if (options.publishError) throw options.publishError;
    },
    clear: () => {
      if (options.clearError) throw options.clearError;
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    onError: (error) => {
      errors.push(error);
      if (options.reporterError) throw options.reporterError;
    },
  });

  return {
    coordinator,
    outcomes,
    errors,
    resolveCalls,
    changeActiveEditor(next: ActiveEditorLike | undefined) {
      activeEditor = next;
      for (const listener of activeListeners) listener(next);
    },
    changeDocumentVersion(version: number) {
      if (!activeEditor) return;
      activeEditor = editor(
        activeEditor.document.uri.toString(),
        activeEditor.document.languageId,
        version,
      );
      for (const listener of documentListeners) listener(activeEditor.document);
    },
    emitPluginChange() {
      for (const listener of pluginListeners) listener();
    },
    flush,
  };
}

function deferredOutcomeHarness() {
  const pending = new Map<
    string,
    (dispatch: SourcePluginDispatch) => void
  >();
  const signals = new Map<string, AbortSignal>();
  const outcomes: CoordinatorPublication[] = [];
  const coordinator = new ActiveEditorCoordinator({
    host: {
      getActiveEditor: () => editor("file:///src/app.css", "css", 1),
      onDidChangeActiveEditor: () => disposable(() => undefined),
      onDidChangeTextDocument: () => disposable(() => undefined),
    },
    registry: {
      onDidChange: () => disposable(() => undefined),
      resolve(selection, _document, _workspace, signal) {
        signals.set(selection.messageId, signal);
        return new Promise((resolve) => pending.set(selection.messageId, resolve));
      },
    },
    workspace: workspace(),
    store: new SelectionStore(),
    publish: () => undefined,
    clear: () => undefined,
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  return {
    coordinator,
    outcomes,
    signals,
    resolve(messageId: string, dispatch: SourcePluginDispatch) {
      pending.get(messageId)?.(dispatch);
    },
    flush,
  };
}

interface SourceDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: { line: number; character: number }): number;
}

function editor(
  uri: string,
  languageId: string,
  version: number,
): ActiveEditorLike {
  return {
    document: {
      uri: { toString: () => uri },
      languageId,
      version,
      getText: () => ".card {} .title {} .layout {}",
      positionAt: (offset) => ({ line: 0, character: offset }),
      offsetAt: (position) => position.character,
    },
  };
}

function resolution(
  selectionMessageId: string,
  document: SourceDocument = {
    uri: "file:///src/app.css",
    languageId: "css",
    version: 1,
    getText: () => "",
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
  },
): SourceResolution {
  return {
    selectionMessageId,
    documentUri: document.uri,
    documentVersion: document.version,
    matches: [],
    diagnostics: [],
  };
}

function inspectMessage(messageId: string, withFacts = true): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId,
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: withFacts
          ? [
              {
                type: "css-rule",
                selector: ".card",
                property: "color",
                value: "red",
                metadata: { sourceUrl: "/dist/app.css" },
              },
            ]
          : [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: {},
  };
}

function resolvedDispatch(
  selectionMessageId: string,
  matches: readonly SourceResolution["matches"][number][] = [],
): SourcePluginDispatch {
  const diagnostics: SourceResolution["diagnostics"] = [];
  const resolution: SourceResolution = {
    selectionMessageId,
    documentUri: "file:///src/app.css",
    documentVersion: 1,
    matches,
    diagnostics,
  };
  const candidate: PluginResolutionCandidate = {
    pluginId: "fixture",
    status: matches.length > 0 ? "matched" : "no-rule-match",
    matches,
    diagnostics,
  };
  return {
    kind: "resolved",
    resolution,
    candidates: [candidate],
  };
}

function withSelectionId(
  dispatch: SourcePluginDispatch,
  selectionMessageId: string,
): SourcePluginDispatch {
  if (dispatch.kind !== "resolved") return dispatch;
  return {
    ...dispatch,
    resolution: { ...dispatch.resolution, selectionMessageId },
  };
}

function resolvedMatch(
  targetRole: "selected" | "parent",
  startCharacter: number,
  endCharacter: number,
  pluginId: string,
): SourceResolution["matches"][number] {
  return {
    pluginId,
    targetRole,
    range: {
      start: { line: 0, character: startCharacter },
      end: { line: 0, character: endCharacter },
    },
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "exact",
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

function disposable(dispose: () => void): Disposable {
  return { dispose };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
