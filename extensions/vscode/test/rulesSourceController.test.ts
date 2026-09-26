import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { SourceDocument, SourcePosition, SourceRange } from
  "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
  type RulesOpenMessage,
} from "@pin-op/protocol";
import { RulesOpenAuthorityRegistry } from
  "../src/rules/rulesOpenAuthorityRegistry.js";
import {
  RulesSourceController,
  type RulesSourceControllerHost,
} from "../src/rules/rulesSourceController.js";
import {
  RulesSourcesPublication,
  type RulesSourcesPublicationPayload,
} from "../src/rules/rulesSourcesPublication.js";
import type {
  ResolvedRuleSource,
  RulesSourceResolutionBatch,
  RulesSourceResolverRequest,
} from "../src/rules/rulesSourceResolver.js";
import type { RulesSourceSnapshotWorkspace } from
  "../src/sourcePlugins/sourceWorkspace.js";

describe("RulesSourceController", () => {
  it("resolves every accepted inspect and sends one complete publication including empty", async () => {
    const harness = controllerHarness();

    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    await harness.controller.acceptInspect(inspect("inspect-2"));
    await harness.controller.republish();

    expect(harness.resolve).toHaveBeenCalledTimes(3);
    expect(harness.publications).toHaveLength(3);
    expect(harness.publications[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      unresolvedRuleCount: 0,
      sources: [{ ruleRef: "rule-a" }],
    });
    expect(harness.publications[1]).toEqual({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      sources: [],
      unresolvedRuleCount: 0,
    });
    expect(harness.publications[2]).toEqual({
      inspectMessageId: "inspect-2",
      rulesGeneration: 2,
      sources: [],
      unresolvedRuleCount: 0,
    });
  });

  it("makes a canceled older resolver inert when a newer inspect wins", async () => {
    const first = deferred<RulesSourceResolutionBatch>();
    const resolve = vi.fn((request: RulesSourceResolverRequest) =>
      request.selectionMessageId === "inspect-1"
        ? first.promise
        : Promise.resolve(batch("inspect-2", resolved("rule-b")))
    );
    const harness = controllerHarness({ resolve });

    const stale = harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const current = harness.controller.acceptInspect(inspect("inspect-2", "rule-b"));
    first.resolve(batch("inspect-1", resolved("rule-a")));
    await Promise.all([stale, current]);

    expect(resolve.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(harness.publications).toHaveLength(1);
    expect(harness.publications[0]).toMatchObject({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
    });
  });

  it("publishes a complete unresolved batch when the current resolver fails", async () => {
    const harness = controllerHarness({
      resolve: vi.fn(async () => {
        throw new Error("private resolver detail");
      }),
    });

    await harness.controller.acceptInspect(
      inspect("inspect-1", "rule-a", "rule-b"),
    );

    expect(harness.publications).toEqual([{
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [],
      unresolvedRuleCount: 2,
    }]);
    expect(harness.failures).toEqual(["rules-source-resolution-failed"]);
  });

  it("activates before local send and commits only an accepted frame", async () => {
    let harness!: ReturnType<typeof controllerHarness>;
    const send = vi.fn((payload: RulesSourcesPublicationPayload) => {
      const source = payload.sources[0]!;
      expect(harness.registry.authorize({
        inspectMessageId: payload.inspectMessageId,
        rulesGeneration: payload.rulesGeneration,
        openAuthorityId: source.openAuthorityId,
      })).toBeDefined();
      return true;
    });
    harness = controllerHarness({ send });

    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]![0];
    expect(harness.registry.authorize({
      inspectMessageId: payload.inspectMessageId,
      rulesGeneration: payload.rulesGeneration,
      openAuthorityId: payload.sources[0]!.openAuthorityId,
    })).toBeDefined();
  });

  it.each(["returned-failure", "throw"] as const)(
    "restores empty state after a new-inspect local send %s",
    async (failure) => {
      const harness = controllerHarness({
        send: failure === "throw"
          ? vi.fn(() => {
              throw new Error("private socket detail");
            })
          : vi.fn(() => false),
      });

      await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));

      expect(harness.registry.current()).toBeUndefined();
      expect(harness.failures).toEqual(["rules-sources-send-failed"]);
    },
  );

  it("makes a route inert when its first generation is not locally accepted", async () => {
    const send = vi.fn(() => false);
    const harness = controllerHarness({ send });

    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    send.mockReturnValue(true);
    await harness.controller.republish();

    expect(harness.publications).toHaveLength(1);
    expect(harness.publications[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
    });
    expect(harness.registry.current()).toBeUndefined();

    await harness.controller.acceptInspect(inspect("inspect-2", "rule-a"));
    expect(harness.publications.at(-1)).toMatchObject({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
    });
  });

  it("does not revive the prior inspect when a newer inspect send fails", async () => {
    const send = vi.fn(() => true);
    const harness = controllerHarness({ send });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const first = harness.publications[0]!.sources[0]!;
    send.mockReturnValue(false);

    await harness.controller.acceptInspect(inspect("inspect-2", "rule-a"));

    expect(harness.registry.current()).toBeUndefined();
    expect(harness.registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: first.openAuthorityId,
    })).toBeUndefined();
  });

  it.each(["accepted", "returned-failure", "throw"] as const)(
    "does not let stale %s send cleanup cancel a reentrant newer inspect",
    async (outcome) => {
      let nextInspect: Promise<void> | undefined;
      let harness!: ReturnType<typeof controllerHarness>;
      const send = vi.fn((payload: RulesSourcesPublicationPayload) => {
        if (payload.inspectMessageId === "inspect-1") {
          nextInspect = harness.controller.acceptInspect(
            inspect("inspect-2", "rule-b"),
          );
          if (outcome === "throw") throw new Error("stale local send failed");
          return outcome === "accepted";
        }
        return true;
      });
      harness = controllerHarness({ send });

      await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
      await nextInspect;

      expect(harness.publications.map((payload) => ({
        inspectMessageId: payload.inspectMessageId,
        rulesGeneration: payload.rulesGeneration,
      }))).toEqual([
        { inspectMessageId: "inspect-1", rulesGeneration: 1 },
        { inspectMessageId: "inspect-2", rulesGeneration: 1 },
      ]);
      expect(harness.registry.current()).toMatchObject({
        inspectMessageId: "inspect-2",
        rulesGeneration: 1,
      });
      expect(harness.failures).toEqual([]);
    },
  );

  it("re-resolves when the map a generated-only answer could not use arrives", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    expect(harness.controller.dependencyUris()).toContain(
      "file:///workspace/dist/app.css.map",
    );

    // A build writes the CSS first and its map a moment later. The map is not
    // among the answer's dependencies, because the answer could not use it -
    // watching it anyway is what lets its arrival resolve the origin again.
    await expect(harness.controller.dependencyChanged(
      "file:///workspace/dist/app.css.map",
    )).resolves.toBe(true);
  });

  it("commits a locally accepted generation before a reentrant republish fails", async () => {
    let acceptReplacement = false;
    let republish: Promise<void> | undefined;
    let harness!: ReturnType<typeof controllerHarness>;
    const send = vi.fn((payload: RulesSourcesPublicationPayload) => {
      if (payload.rulesGeneration === 1) {
        republish = harness.controller.republish();
        return true;
      }
      return acceptReplacement;
    });
    harness = controllerHarness({ send });

    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    await republish;

    expect(harness.registry.current()).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
    });
    // The map that belongs to a watched stylesheet is watched with it, so a
    // build writing the map after the CSS resolves the origin again.
    expect(harness.controller.dependencyUris()).toEqual([
      "file:///workspace/dist/app.css",
      "file:///workspace/dist/app.css.map",
    ]);
    expect(harness.failures).toEqual(["rules-sources-send-failed"]);

    acceptReplacement = true;
    harness.change(
      "file:///workspace/dist/app.css",
      ".card { color: blue; }",
    );
    await expect(harness.controller.dependencyChanged(
      "file:///workspace/dist/app.css",
    )).resolves.toBe(true);
    expect(harness.registry.current()).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 3,
    });
  });

  it.each(["returned-failure", "throw"] as const)(
    "rolls back a stale %s before a reentrant first publication also fails",
    async (outcome) => {
      let allowSend = false;
      let republish: Promise<void> | undefined;
      let harness!: ReturnType<typeof controllerHarness>;
      const send = vi.fn((payload: RulesSourcesPublicationPayload) => {
        if (allowSend) return true;
        if (payload.rulesGeneration === 1) {
          republish = harness.controller.republish();
          if (outcome === "throw") throw new Error("stale local send failed");
        }
        return false;
      });
      harness = controllerHarness({ send });

      await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
      await republish;

      expect(harness.publications.map((payload) => payload.rulesGeneration))
        .toEqual([1, 2]);
      expect(harness.registry.current()).toBeUndefined();
      expect(harness.failures).toEqual(["rules-sources-send-failed"]);

      allowSend = true;
      await harness.controller.republish();
      expect(harness.publications.map((payload) => payload.rulesGeneration))
        .toEqual([1, 2]);
    },
  );

  it("restores a prior same-inspect snapshot after local republish failure", async () => {
    const send = vi.fn(() => true);
    const harness = controllerHarness({ send });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const first = harness.publications[0]!.sources[0]!;
    send.mockReturnValue(false);

    await harness.controller.republish();

    expect(harness.registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: first.openAuthorityId,
    })).toBeDefined();
    expect(harness.registry.current()).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
    });
  });

  it("retains the prior snapshot when same-inspect publication preparation fails", async () => {
    let rejectMeasurement = false;
    const harness = controllerHarness({
      measureEnvelopeBytes(payload) {
        if (rejectMeasurement) throw new Error("serialization failed");
        return measureEnvelope(payload);
      },
    });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const first = harness.publications[0]!.sources[0]!;
    rejectMeasurement = true;

    await harness.controller.republish();

    expect(harness.publications).toHaveLength(1);
    expect(harness.registry.current()).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
    });
    expect(harness.registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: first.openAuthorityId,
    })).toBeDefined();
  });

  it("replaces a restored generation when click-time revalidation finds it stale", async () => {
    const send = vi.fn(() => true);
    const harness = controllerHarness({ send });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const first = harness.publications[0]!.sources[0]!;
    send.mockReturnValue(false);
    await harness.controller.republish();
    expect(harness.registry.current()).toMatchObject({ rulesGeneration: 1 });

    harness.change("file:///workspace/dist/app.css", ".card { color: blue; }");
    send.mockReturnValue(true);
    await harness.controller.open(openMessage(first.openAuthorityId));

    expect(harness.publications.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 3,
    });
    expect(harness.registry.current()).toMatchObject({ rulesGeneration: 3 });
    expect(harness.registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: first.openAuthorityId,
    })).toBeUndefined();
  });

  it("opens a current authority repeatedly through the fixed editor sequence", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const source = harness.publications[0]!.sources[0]!;

    await harness.controller.open(openMessage(source.openAuthorityId));
    await harness.controller.open(openMessage(source.openAuthorityId));

    expect(harness.events).toEqual([
      "open", "show", "cursor", "reveal",
      "open", "show", "cursor", "reveal",
    ]);
    expect(harness.cursorSets).toEqual([
      { line: 0, character: 0 },
      { line: 0, character: 0 },
    ]);
    expect(harness.revealed).toEqual([
      ruleRange(),
      ruleRange(),
    ]);
  });

  it("lands a clicked declaration on its value and falls back to the rule", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const source = harness.publications[0]!.sources[0]!;

    await harness.controller.open({
      ...openMessage(source.openAuthorityId),
      declaration: { property: "color", occurrence: 0 },
    });
    await harness.controller.open({
      ...openMessage(source.openAuthorityId),
      declaration: { property: "margin", occurrence: 0 },
    });

    // ".card { color: red; }" -- the value starts after "color: ".
    expect(harness.cursorSets).toEqual([
      { line: 0, character: 15 },
      { line: 0, character: 0 },
    ]);
    expect(harness.revealed).toEqual([
      { start: { line: 0, character: 15 }, end: { line: 0, character: 15 } },
      ruleRange(),
    ]);
  });

  it("lets only the newest concurrent open set the cursor and reveal", async () => {
    const firstShown = deferred<RulesEditor>();
    const secondRange: SourceRange = {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 20 },
    };
    const cssText = ".card { color: red; }";
    const scssUri = "file:///workspace/src/card.scss";
    const resolve = vi.fn(async (request: RulesSourceResolverRequest) => batch(
      request.selectionMessageId,
      resolved("rule-a"),
      {
        kind: "resolved",
        ruleRef: "rule-b",
        document: { uri: scssUri, languageId: "scss", version: 1 },
        range: secondRange,
        confidence: "sourcemap",
        dependencies: [
          {
            kind: "generated-css",
            uri: "file:///workspace/dist/app.css",
            documentVersion: 1,
            contentHash: digest(cssText),
          },
          {
            kind: "original-source",
            uri: scssUri,
            documentVersion: 1,
            contentHash: digest(cssText),
          },
        ],
      },
    ));
    const showTextDocument = vi.fn((sourceDocument: SourceDocument) =>
      sourceDocument.uri.endsWith("app.css")
        ? firstShown.promise
        : Promise.resolve(editor(sourceDocument))
    );
    const harness = controllerHarness({ resolve, showTextDocument });
    await harness.controller.acceptInspect(
      inspect("inspect-1", "rule-a", "rule-b"),
    );
    const first = harness.publications[0]!.sources.find(
      (source) => source.ruleRef === "rule-a",
    )!;
    const second = harness.publications[0]!.sources.find(
      (source) => source.ruleRef === "rule-b",
    )!;

    const openingFirst = harness.controller.open(
      openMessage(first.openAuthorityId),
    );
    await until(() => showTextDocument.mock.calls.length === 1);
    await harness.controller.open(openMessage(second.openAuthorityId));
    firstShown.resolve(editor(document(
      "file:///workspace/dist/app.css",
      cssText,
      1,
    )));
    await openingFirst;

    expect(showTextDocument.mock.calls.map(([sourceDocument]) =>
      sourceDocument.uri
    )).toEqual([
      "file:///workspace/dist/app.css",
      scssUri,
    ]);
    expect(harness.cursorSets).toEqual([secondRange.start]);
    expect(harness.revealed).toEqual([secondRange]);
    expect(harness.failures).toEqual([]);
    expect(harness.publications).toHaveLength(1);
  });

  it("rehashes every dependency after openTextDocument and never shows a stale target", async () => {
    const opened = deferred<SourceDocument>();
    const harness = controllerHarness({
      openTextDocument: vi.fn(() => opened.promise),
    });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const source = harness.publications[0]!.sources[0]!;

    const opening = harness.controller.open(openMessage(source.openAuthorityId));
    harness.change("file:///workspace/dist/app.css", ".card { color: blue; }");
    opened.resolve(document(
      "file:///workspace/dist/app.css",
      ".card { color: blue; }",
      2,
    ));
    await opening;
    await harness.flush();

    expect(harness.openTextDocument).toHaveBeenCalledOnce();
    expect(harness.showTextDocument).not.toHaveBeenCalled();
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealed).toEqual([]);
    expect(harness.publications.at(-1)).toMatchObject({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
    });
    expect(harness.failures).toContain("rules-source-open-stale");
  });

  it("rehashes every dependency after showTextDocument and suppresses cursor/reveal", async () => {
    const shown = deferred<RulesEditor>();
    const harness = controllerHarness({
      showTextDocument: vi.fn(() => shown.promise),
    });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const source = harness.publications[0]!.sources[0]!;

    const opening = harness.controller.open(openMessage(source.openAuthorityId));
    await until(() => harness.showTextDocument.mock.calls.length === 1);
    harness.change("file:///workspace/dist/app.css", ".card { color: blue; }");
    shown.resolve(editor(document(
      "file:///workspace/dist/app.css",
      ".card { color: blue; }",
      2,
    )));
    await opening;
    await harness.flush();

    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealed).toEqual([]);
    expect(harness.registry.current()).toMatchObject({ rulesGeneration: 2 });
    expect(harness.failures).toContain("rules-source-open-stale");
  });

  it("keeps a newer inspect authoritative when an older open finishes", async () => {
    const shown = deferred<RulesEditor>();
    const harness = controllerHarness({
      showTextDocument: vi.fn(() => shown.promise),
    });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const first = harness.publications[0]!.sources[0]!;
    const opening = harness.controller.open(openMessage(first.openAuthorityId));
    await until(() => harness.showTextDocument.mock.calls.length === 1);

    await harness.controller.acceptInspect(inspect("inspect-2", "rule-a"));
    const second = harness.publications.at(-1)!.sources[0]!;
    shown.resolve(editor(document(
      "file:///workspace/dist/app.css",
      ".card { color: red; }",
      1,
    )));
    await opening;

    expect(harness.registry.current()).toMatchObject({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
    });
    expect(harness.registry.authorize({
      inspectMessageId: "inspect-2",
      rulesGeneration: 1,
      openAuthorityId: second.openAuthorityId,
    })).toBeDefined();
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealed).toEqual([]);
  });

  it.each([
    "file:///workspace/dist/app.css",
    "file:///workspace/dist/app.css.map",
    "file:///workspace/src/card.scss",
  ])("fails closed when dependency %s changes", async (changedUri) => {
    const harness = controllerHarness({ mapped: true });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const source = harness.publications[0]!.sources[0]!;
    harness.change(changedUri, `${harness.files.get(changedUri)}\n/* changed */`);

    await harness.controller.open(openMessage(source.openAuthorityId));

    expect(harness.showTextDocument).not.toHaveBeenCalled();
    expect(harness.cursorSets).toEqual([]);
    expect(harness.revealed).toEqual([]);
  });

  it("rejects workspace removal, invalid range, and foreign returned editor identity", async () => {
    const cases: Array<{
      readonly mutate: (harness: ReturnType<typeof controllerHarness>) => void;
      readonly expectOpen: boolean;
      readonly expectShow: boolean;
    }> = [
      {
        mutate: (harness) => harness.removeWorkspaceOwnership(),
        expectOpen: false,
        expectShow: false,
      },
      {
        mutate: (harness) => harness.useInvalidOpenedRange(),
        expectOpen: true,
        expectShow: false,
      },
      {
        mutate: (harness) => harness.returnForeignEditor(),
        expectOpen: true,
        expectShow: true,
      },
    ];

    for (const testCase of cases) {
      const harness = controllerHarness();
      await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
      const source = harness.publications[0]!.sources[0]!;
      testCase.mutate(harness);

      await harness.controller.open(openMessage(source.openAuthorityId));

      expect(harness.openTextDocument.mock.calls.length > 0)
        .toBe(testCase.expectOpen);
      expect(harness.showTextDocument.mock.calls.length > 0)
        .toBe(testCase.expectShow);
      expect(harness.cursorSets).toEqual([]);
      expect(harness.revealed).toEqual([]);
      harness.controller.dispose();
    }
  });

  it("clears without republishing on foreign, stale, disconnected, or disposed open", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const authorityId = harness.publications[0]!.sources[0]!.openAuthorityId;

    await harness.controller.open(openMessage(authorityId, {
      inspectMessageId: "foreign",
    }));
    expect(harness.publications).toHaveLength(1);
    expect(harness.registry.current()).toBeUndefined();

    await harness.controller.acceptInspect(inspect("inspect-2", "rule-a"));
    harness.controller.disconnect();
    await harness.controller.open(openMessage(authorityId));
    expect(harness.publications).toHaveLength(2);

    harness.controller.dispose();
    await harness.controller.open(openMessage(authorityId));
    expect(harness.publications).toHaveLength(2);
    expect(harness.openTextDocument).not.toHaveBeenCalled();
  });

  it("invalidates without republishing for a stale same-inspect generation", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    const authorityId = harness.publications[0]!.sources[0]!.openAuthorityId;

    await harness.controller.open(openMessage(authorityId, {
      rulesGeneration: 0,
    }));

    expect(harness.publications).toHaveLength(1);
    expect(harness.registry.current()).toBeUndefined();
    expect(harness.openTextDocument).not.toHaveBeenCalled();
  });

  it("revokes and re-resolves on dependency, workspace, stylesheet, and page events", async () => {
    const harness = controllerHarness();
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));

    expect(await harness.controller.dependencyChanged(
      "file:///workspace/unrelated.css",
    )).toBe(false);
    expect(harness.publications).toHaveLength(1);
    expect(await harness.controller.dependencyChanged(
      "file:///workspace/dist/app.css",
    )).toBe(true);
    await harness.controller.workspaceChanged();
    await harness.controller.stylesheetRefresh();
    await harness.controller.pageRefresh();

    expect(harness.publications.map((entry) => entry.rulesGeneration))
      .toEqual([1, 2, 3, 4, 5]);
  });

  it("retains exact dependencies and retries an in-flight replacement", async () => {
    const paused = deferred<RulesSourceResolutionBatch>();
    let attempt = 0;
    const resolve = vi.fn((request: RulesSourceResolverRequest) => {
      attempt += 1;
      return attempt === 2
        ? paused.promise
        : Promise.resolve(batch(
            request.selectionMessageId,
            resolved("rule-a"),
          ));
    });
    const harness = controllerHarness({ resolve });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));

    const refreshing = harness.controller.stylesheetRefresh();
    await until(() => resolve.mock.calls.length === 2);
    expect("isResolutionInFlight" in harness.controller).toBe(true);
    expect((harness.controller as unknown as {
      isResolutionInFlight(): boolean;
    }).isResolutionInFlight()).toBe(true);
    expect(harness.registry.current()).toBeUndefined();
    expect(harness.controller.dependencyUris()).toContain(
      "file:///workspace/dist/app.css",
    );

    const retrying = harness.controller.dependencyChanged(
      "file:///workspace/dist/app.css",
    );
    await until(() => resolve.mock.calls.length === 3);
    paused.resolve(batch("inspect-1", resolved("rule-a")));
    expect(await retrying).toBe(true);
    await refreshing;

    expect(resolve.mock.calls[1]![0].signal?.aborted).toBe(true);
    expect(harness.publications.map((entry) => entry.rulesGeneration))
      .toEqual([1, 2]);
    expect((harness.controller as unknown as {
      isResolutionInFlight(): boolean;
    }).isResolutionInFlight()).toBe(false);
  });

  it("retries an in-flight replacement when a newly discovered map changes", async () => {
    const oldMapUri = "file:///workspace/dist/app.css.map";
    const nextMapUri = "file:///workspace/dist/app.next.css.map";
    const staleMapText = '{"version":3,"file":"stale.css"}';
    const freshMapText = '{"version":3,"file":"fresh.css"}';
    const paused = deferred<RulesSourceResolutionBatch>();
    let attempt = 0;
    const resolve = vi.fn((request: RulesSourceResolverRequest) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(batch(
          request.selectionMessageId,
          mappedResolved("rule-a", oldMapUri, '{"version":3}'),
        ));
      }
      if (attempt === 2) return paused.promise;
      return Promise.resolve(batch(
        request.selectionMessageId,
        mappedResolved("rule-a", nextMapUri, freshMapText),
      ));
    });
    const harness = controllerHarness({ resolve });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));

    const refreshing = harness.controller.stylesheetRefresh();
    await until(() => resolve.mock.calls.length === 2);
    expect(harness.controller.dependencyUris()).toContain(oldMapUri);
    expect(harness.controller.dependencyUris()).not.toContain(nextMapUri);

    harness.restore(nextMapUri, freshMapText);
    await expect(harness.controller.dependencyChanged(nextMapUri))
      .resolves.toBe(true);
    paused.resolve(batch(
      "inspect-1",
      mappedResolved("rule-a", nextMapUri, staleMapText),
    ));
    await refreshing;

    expect(resolve.mock.calls[1]![0].signal?.aborted).toBe(true);
    expect(harness.publications.map((entry) => entry.rulesGeneration))
      .toEqual([1, 2]);
    const latest = harness.publications.at(-1)!;
    expect(harness.registry.authorize({
      inspectMessageId: latest.inspectMessageId,
      rulesGeneration: latest.rulesGeneration,
      openAuthorityId: latest.sources[0]!.openAuthorityId,
    })?.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({
      uri: nextMapUri,
      contentHash: digest(freshMapText),
    })]));
  });

  it("retains mapped dependencies across fallback so recreation republishes SCSS", async () => {
    const mapUri = "file:///workspace/dist/app.css.map";
    const scssUri = "file:///workspace/src/card.scss";
    const harness = controllerHarness({ mapped: true });
    await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
    expect(harness.publications[0]!.sources[0]).toMatchObject({
      confidence: "sourcemap",
    });

    harness.remove(mapUri);
    expect(await harness.controller.dependencyChanged(mapUri)).toBe(true);
    expect(harness.publications.at(-1)).toMatchObject({
      rulesGeneration: 2,
      sources: [],
      unresolvedRuleCount: 1,
    });
    expect(harness.controller.dependencyUris()).toEqual(expect.arrayContaining([
      mapUri,
      scssUri,
    ]));

    harness.restore(mapUri, '{"version":3}');
    expect(await harness.controller.dependencyChanged(mapUri)).toBe(true);
    expect(harness.publications.at(-1)).toMatchObject({
      rulesGeneration: 3,
      sources: [{ confidence: "sourcemap" }],
      unresolvedRuleCount: 0,
    });
  });

  it.each(["new-inspect", "document-navigation", "disconnect", "dispose"] as const)(
    "revokes the prior authority on %s",
    async (event) => {
      const harness = controllerHarness();
      await harness.controller.acceptInspect(inspect("inspect-1", "rule-a"));
      const source = harness.publications[0]!.sources[0]!;

      if (event === "new-inspect") {
        await harness.controller.acceptInspect(inspect("inspect-2"));
      } else if (event === "document-navigation") {
        harness.controller.documentNavigated();
      } else if (event === "disconnect") {
        harness.controller.disconnect();
      } else {
        harness.controller.dispose();
      }

      expect(harness.registry.authorize({
        inspectMessageId: "inspect-1",
        rulesGeneration: 1,
        openAuthorityId: source.openAuthorityId,
      })).toBeUndefined();
    },
  );
});

interface RulesEditor {
  readonly documentUri: string;
  readonly document: SourceDocument;
}

function controllerHarness(options: {
  readonly resolve?: (
    request: RulesSourceResolverRequest,
  ) => Promise<RulesSourceResolutionBatch>;
  readonly send?: (payload: RulesSourcesPublicationPayload) => boolean;
  readonly openTextDocument?: () => PromiseLike<SourceDocument>;
  readonly showTextDocument?: (
    document: SourceDocument,
  ) => PromiseLike<RulesEditor>;
  readonly measureEnvelopeBytes?: (
    payload: RulesSourcesPublicationPayload,
  ) => number;
  readonly mapped?: boolean;
} = {}) {
  const cssUri = "file:///workspace/dist/app.css";
  const mapUri = `${cssUri}.map`;
  const scssUri = "file:///workspace/src/card.scss";
  const files = new Map<string, { text: string; version: number }>([
    [cssUri, { text: ".card { color: red; }", version: 1 }],
    [mapUri, { text: '{"version":3}', version: 1 }],
    [scssUri, { text: ".card { color: red; }", version: 1 }],
  ]);
  let workspaceGeneration = 0;
  let ownsWorkspace = true;
  let invalidOpenedRange = false;
  let foreignEditor = false;
  const workspace: RulesSourceSnapshotWorkspace = {
    findFiles: async () => [...files.keys()],
    readText: async (uri) => files.get(uri)!.text,
    resolveSourceUri: async () => ({
      uris: [cssUri],
      status: "exact",
      strategy: "automatic",
    }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: (uri) => ownsWorkspace && uri.startsWith("file:///workspace/"),
    currentRulesSourceGeneration: () => workspaceGeneration,
    async readRulesSourceSnapshot(uri) {
      const entry = files.get(uri);
      if (!entry) throw new Error("missing fixture");
      return { uri, text: entry.text, documentVersion: entry.version };
    },
  };
  const dynamicResolved = (ruleRef: string): ResolvedRuleSource => {
    const css = files.get(cssUri)!;
    if (!options.mapped) {
      return {
        kind: "resolved",
        ruleRef,
        document: { uri: cssUri, languageId: "css", version: css.version },
        range: ruleRange(),
        confidence: "exact",
        dependencies: [snapshotDependency("generated-css", cssUri, css)],
      };
    }
    const map = files.get(mapUri)!;
    const scss = files.get(scssUri)!;
    return {
      kind: "resolved",
      ruleRef,
      document: { uri: scssUri, languageId: "scss", version: scss.version },
      range: ruleRange(),
      confidence: "sourcemap",
      dependencies: [
        snapshotDependency("generated-css", cssUri, css),
        snapshotDependency("external-source-map", mapUri, map),
        snapshotDependency("original-source", scssUri, scss),
      ],
    };
  };
  const resolve = vi.fn(options.resolve ?? (async (request) => batch(
    request.selectionMessageId,
    ...[...new Set(request.ruleEvidence.rules.map((rule) => rule.ruleRef))]
      .map(dynamicResolved),
  )));
  const registry = new RulesOpenAuthorityRegistry();
  let nextAuthority = 0;
  const publication = new RulesSourcesPublication(registry, {
    measureEnvelopeBytes: options.measureEnvelopeBytes ?? measureEnvelope,
    createAuthorityId: () => uuid(++nextAuthority),
  });
  const publications: RulesSourcesPublicationPayload[] = [];
  const send = vi.fn((payload: RulesSourcesPublicationPayload) => {
    publications.push(payload);
    return options.send?.(payload) ?? true;
  });
  const events: string[] = [];
  const cursorSets: SourcePosition[] = [];
  const revealed: SourceRange[] = [];
  const failures: string[] = [];
  const openTextDocument = vi.fn(async (uri: string) => {
    events.push("open");
    if (options.openTextDocument) return options.openTextDocument();
    const entry = files.get(uri)!;
    return document(
      uri,
      entry.text,
      entry.version,
      invalidOpenedRange ? 5 : undefined,
    );
  });
  const showTextDocument = vi.fn(async (sourceDocument: SourceDocument) => {
    events.push("show");
    if (options.showTextDocument) return options.showTextDocument(sourceDocument);
    return foreignEditor
      ? editor(document("file:///workspace/foreign.css", ".foreign {}", 1))
      : editor(sourceDocument);
  });
  const host: RulesSourceControllerHost<SourceDocument, RulesEditor> = {
    openTextDocument,
    showTextDocument,
    setPrimaryCursor(_editor, position) {
      events.push("cursor");
      cursorSets.push(position);
    },
    revealRange(_editor, range) {
      events.push("reveal");
      revealed.push(range);
    },
    reportFailure(code) {
      failures.push(code);
    },
  };
  const controller = new RulesSourceController({
    workspace,
    resolver: { resolve },
    registry,
    publication,
    sendRulesSources: send,
    host,
  });

  return {
    controller,
    registry,
    resolve,
    publications,
    files,
    events,
    cursorSets,
    revealed,
    failures,
    openTextDocument,
    showTextDocument,
    change(uri: string, text: string) {
      const current = files.get(uri)!;
      files.set(uri, { text, version: current.version + 1 });
      workspaceGeneration += 1;
    },
    remove(uri: string) {
      files.delete(uri);
      workspaceGeneration += 1;
    },
    restore(uri: string, text: string) {
      files.set(uri, { text, version: 1 });
      workspaceGeneration += 1;
    },
    removeWorkspaceOwnership() {
      ownsWorkspace = false;
      workspaceGeneration += 1;
    },
    useInvalidOpenedRange() {
      invalidOpenedRange = true;
    },
    returnForeignEditor() {
      foreignEditor = true;
    },
    flush,
  };
}

function inspect(messageId: string, ...ruleRefs: string[]): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId,
    sessionId: "session-1",
    source: { role: "browser", id: "chrome", metadata: {} },
    ideHighlightEnabled: true,
    targets: [],
    ruleEvidence: {
      rules: ruleRefs.map((ruleRef) => ({
        ruleRef,
        selector: ".card",
        declarations: [{
          property: "color",
          value: "red",
          important: false,
          valueTruncated: false,
        }],
        declarationsTruncated: false,
        generatedSource: {
          sourceUrl: "http://localhost:4173/dist/app.css",
          rulePath: "0.0",
          contexts: [],
          contextsTruncated: false,
          unsupportedGroupContext: false,
        },
      })),
      omittedRuleCount: 0,
    },
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: {},
  };
}

function openMessage(
  openAuthorityId: string,
  overrides: Partial<
    Pick<RulesOpenMessage, "inspectMessageId" | "rulesGeneration">
  > = {},
): RulesOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.open",
    messageId: "rules-open-1",
    sessionId: "session-1",
    inspectMessageId: overrides.inspectMessageId ?? "inspect-1",
    rulesGeneration: overrides.rulesGeneration ?? 1,
    openAuthorityId,
    metadata: {},
  };
}

function batch(
  selectionMessageId: string,
  ...results: RulesSourceResolutionBatch["results"]
): RulesSourceResolutionBatch {
  return { selectionMessageId, results };
}

function resolved(ruleRef: string): ResolvedRuleSource {
  const text = ".card { color: red; }";
  return {
    kind: "resolved",
    ruleRef,
    document: {
      uri: "file:///workspace/dist/app.css",
      languageId: "css",
      version: 1,
    },
    range: ruleRange(),
    confidence: "exact",
    dependencies: [{
      kind: "generated-css",
      uri: "file:///workspace/dist/app.css",
      documentVersion: 1,
      contentHash: digest(text),
    }],
  };
}

function mappedResolved(
  ruleRef: string,
  mapUri: string,
  mapText: string,
): ResolvedRuleSource {
  const cssText = ".card { color: red; }";
  const scssText = ".card { color: red; }";
  return {
    kind: "resolved",
    ruleRef,
    document: {
      uri: "file:///workspace/src/card.scss",
      languageId: "scss",
      version: 1,
    },
    range: ruleRange(),
    confidence: "sourcemap",
    dependencies: [
      {
        kind: "generated-css",
        uri: "file:///workspace/dist/app.css",
        documentVersion: 1,
        contentHash: digest(cssText),
      },
      {
        kind: "external-source-map",
        uri: mapUri,
        documentVersion: 1,
        contentHash: digest(mapText),
      },
      {
        kind: "original-source",
        uri: "file:///workspace/src/card.scss",
        documentVersion: 1,
        contentHash: digest(scssText),
      },
    ],
  };
}

function snapshotDependency(
  kind: ResolvedRuleSource["dependencies"][number]["kind"],
  uri: string,
  entry: { readonly text: string; readonly version: number },
): ResolvedRuleSource["dependencies"][number] {
  return {
    kind,
    uri,
    documentVersion: entry.version,
    contentHash: digest(entry.text),
  };
}

function ruleRange(): SourceRange {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 21 },
  };
}

function document(
  uri: string,
  text: string,
  version: number,
  forcedOffset?: number,
): SourceDocument {
  return {
    uri,
    languageId: uri.endsWith(".scss") ? "scss" : "css",
    version,
    getText: () => text,
    positionAt(offset) {
      const bounded = Math.min(Math.max(0, offset), text.length);
      return { line: 0, character: bounded };
    },
    offsetAt(position) {
      return forcedOffset ?? Math.min(Math.max(0, position.character), text.length);
    },
  };
}

function editor(sourceDocument: SourceDocument): RulesEditor {
  return { documentUri: sourceDocument.uri, document: sourceDocument };
}

function measureEnvelope(payload: RulesSourcesPublicationPayload): number {
  return Buffer.byteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: uuid(0),
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-test" },
    ...payload,
    metadata: {},
  }), "utf8");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}
