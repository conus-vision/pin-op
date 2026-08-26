import type {
  ClientSource,
  PeerStateMessage,
  PageRefreshMessage,
  ResolutionMessage,
  RulesSourcesMessage,
  SourceMatchesMessage,
  SourceNavigateMessage,
  SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import {
  BackgroundContentRefreshCoordinator,
  BackgroundInspectCoordinator,
  BackgroundInspectSession,
  BrowserWindowLinkStore,
  DomTreeRecoveryCoordinator,
  MatchedStylesModel,
  refreshExternalStylesheets,
  RulesSourcesController,
  WindowConnectionCoordinator,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type BrowserProtocolMismatch,
  type BrowserWindowLink,
  type InspectPayload,
  type SessionStorage,
  type StylesGetMatchedRequest,
  type StylesResponse,
  type WindowConnectionClient,
} from "../src/index.js";
import { PseudoStatePreview } from "../src/pseudoStatePreview.js";
import { StylesheetRegistry } from "../src/stylesheetRegistry.js";
import type { ContentSessionId } from "../src/inspectPortProtocol.js";
import type {
  InspectSendOutcome,
  PresentationSettingsInput,
  RulesOpenInput,
  SourceOpenInput,
  SourceNavigationSendOutcome,
  SourcePresentationSendOutcome,
  TrustedIdeMessageListener,
} from "../src/bridgeClient.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";

describe("browser-window workflow", () => {
  it.each([
    {
      label: "stylesheet refresh",
      matchedBoundary: "stylesheet-refresh",
      rulesBoundary: "stylesheet-refresh",
    },
    {
      label: "page reload/navigation",
      matchedBoundary: "navigation",
      rulesBoundary: "document-navigation",
    },
    {
      label: "panel disconnect/session dispose",
      matchedBoundary: "dispose",
      rulesBoundary: "dispose",
    },
    {
      label: "content lease replacement",
      matchedBoundary: "content-lease-replaced",
      rulesBoundary: "transport-invalidation",
    },
  ] as const)(
    "fences deferred production authority after $label and accepts only a fresh generation",
    async ({ matchedBoundary, rulesBoundary }) => {
      const pending: Array<{
        readonly request: StylesGetMatchedRequest;
        readonly result: ReturnType<typeof deferred<StylesResponse>>;
      }> = [];
      const publishedMatched: Array<{
        readonly documentEpoch: number;
        readonly nodeRef: string;
        readonly stylesRevision: number;
      }> = [];
      let nextRequestId = 0;
      const createMatchedModel = () => {
        const model = new MatchedStylesModel({
          createRequestId: () => `workflow-styles-${++nextRequestId}`,
          request(request) {
            if (request.type !== "styles.getMatched") {
              throw new Error("Unexpected pseudo-state request");
            }
            const result = deferred<StylesResponse>();
            pending.push({ request, result });
            return result.promise;
          },
        });
        model.subscribe((snapshot) => {
          if (
            (snapshot.state !== "ready" && snapshot.state !== "partial") ||
            !snapshot.styles
          ) {
            return;
          }
          publishedMatched.push({
            documentEpoch: snapshot.styles.documentEpoch,
            nodeRef: snapshot.styles.nodeRef,
            stylesRevision: snapshot.styles.stylesRevision,
          });
        });
        return model;
      };
      const rulesOpens: unknown[] = [];
      const createRulesController = () =>
        new RulesSourcesController((command) => rulesOpens.push(command));
      let matched = createMatchedModel();
      let rules = createRulesController();
      rules.beginInspect("inspect-stale", new Set(["rule-stale"]));
      expect(rules.accept(rulesSources(
        "inspect-stale",
        1,
        "rule-stale",
      ))).toBe("published");

      const staleLoad = matched.select({
        documentEpoch: 4,
        nodeRef: "node-stale",
        selectionRevision: 7,
      });
      expect(pending).toHaveLength(1);

      if (matchedBoundary === "stylesheet-refresh") {
        matched.invalidate({
          type: "styles.invalidated",
          documentEpoch: 4,
          stylesRevision: 9,
          stylesheetRevision: 4,
          pseudoStateRevision: 0,
          pseudoStates: [],
        });
      } else if (matchedBoundary === "dispose") {
        matched.dispose();
      } else {
        matched.reset(matchedBoundary);
      }
      if (rulesBoundary === "dispose") rules.dispose();
      else rules.invalidate(rulesBoundary);

      pending[0]!.result.resolve(workflowMatchedResponse(
        pending[0]!.request,
        8,
        3,
      ));
      await staleLoad;
      await flushMicrotasks();

      expect(publishedMatched).toEqual([]);
      expect(rules.accept(rulesSources(
        "inspect-stale",
        2,
        "rule-stale",
      ))).toBe("ignored");
      rules.open("rule-stale");
      expect(rulesOpens).toEqual([]);

      if (matchedBoundary === "dispose") {
        matched = createMatchedModel();
        rules = createRulesController();
      }
      const freshSelection = matchedBoundary === "stylesheet-refresh"
        ? undefined
        : {
          documentEpoch: 5,
          nodeRef: "node-fresh",
          selectionRevision: 1,
        };
      const freshLoad = freshSelection
        ? matched.select(freshSelection)
        : Promise.resolve();
      await flushMicrotasks();
      expect(pending).toHaveLength(2);
      pending[1]!.result.resolve(workflowMatchedResponse(
        pending[1]!.request,
        matchedBoundary === "stylesheet-refresh" ? 9 : 1,
        matchedBoundary === "stylesheet-refresh" ? 4 : 1,
      ));
      await freshLoad;
      await flushMicrotasks();

      expect(publishedMatched).toEqual([{
        documentEpoch: matchedBoundary === "stylesheet-refresh" ? 4 : 5,
        nodeRef: matchedBoundary === "stylesheet-refresh"
          ? "node-stale"
          : "node-fresh",
        stylesRevision: matchedBoundary === "stylesheet-refresh" ? 9 : 1,
      }]);
      expect(matched.snapshot().state).toBe("ready");

      rules.beginInspect("inspect-fresh", new Set(["rule-fresh"]));
      expect(rules.accept(rulesSources(
        "inspect-fresh",
        1,
        "rule-fresh",
      ))).toBe("published");
      rules.open("rule-fresh");
      expect(rulesOpens).toEqual([{
        type: "pin-op.rules.open",
        inspectMessageId: "inspect-fresh",
        rulesGeneration: 1,
        openAuthorityId: "open-rule-fresh",
      }]);

      matched.dispose();
      rules.dispose();
    },
  );

  it.each([
    ["stylesheet refresh", "stylesheet", true],
    ["page reload/navigation", "navigation", false],
    ["DOM recovery", "recovery", false],
    ["panel disconnect/session dispose", "session-dispose", false],
    ["content lease replacement", "lease-replacement", false],
    ["protocol mismatch", "protocol-mismatch", false],
    ["connection disposal", "connection-dispose", false],
  ] as const)(
    "runs the shared production-owner cleanup before %s",
    async (_label, transition, authorStylesheetChanged) => {
      const events: string[] = [];
      const preview = new PseudoStatePreview();
      const polling = new Map<number, () => void>();
      let nextPoll = 0;
      const pollResults: boolean[] = [];
      const registry = new StylesheetRegistry({
        document: workflowStylesheetDocument() as unknown as Document,
        contentSessionId: `workflow-${transition}`,
        documentEpoch: 4,
        setInterval(callback) {
          const handle = ++nextPoll;
          polling.set(handle, callback);
          return handle;
        },
        clearInterval(handle) {
          polling.delete(handle as number);
        },
      });
      registry.startPolling((changed) => pollResults.push(changed));
      const staleFingerprintPoll = [...polling.values()][0]!;

      const pending: Array<{
        readonly request: StylesGetMatchedRequest;
        readonly result: ReturnType<typeof deferred<StylesResponse>>;
      }> = [];
      const publishedMatched: string[] = [];
      let nextRequestId = 0;
      const matched = new MatchedStylesModel({
        createRequestId: () => `matrix-styles-${++nextRequestId}`,
        request(request) {
          if (request.type !== "styles.getMatched") {
            throw new Error("Unexpected pseudo-state request");
          }
          const result = deferred<StylesResponse>();
          pending.push({ request, result });
          return result.promise;
        },
      });
      matched.subscribe((snapshot) => {
        if (snapshot.state === "ready" || snapshot.state === "partial") {
          publishedMatched.push(snapshot.styles?.nodeRef ?? "missing");
        }
      });
      const rulesOpens: unknown[] = [];
      const rules = new RulesSourcesController((command) => {
        rulesOpens.push(command);
      });
      rules.beginInspect("matrix-stale", new Set(["rule-stale"]));
      expect(rules.accept(rulesSources("matrix-stale", 1, "rule-stale")))
        .toBe("published");
      const staleMatchedLoad = matched.select({
        documentEpoch: 4,
        nodeRef: "node-stale",
        selectionRevision: 1,
      });

      const cleanup = (): boolean => {
        events.push("pseudo:clear");
        expect(preview.clear().complete).toBe(true);

        registry.invalidateApplicability(`${transition}-applicability`);
        events.push("styles/applicability:advance");
        if (authorStylesheetChanged) {
          registry.invalidate("author-refresh");
          events.push("stylesheet:advance");
        }
        const revisions = registry.revisions;
        if (authorStylesheetChanged) {
          matched.invalidate({
            type: "styles.invalidated",
            ...revisions,
            pseudoStateRevision: 1,
            pseudoStates: [],
          });
        } else {
          matched.reset(transition === "recovery"
            ? "navigation"
            : "content-lease-replaced");
        }
        registry.stopPolling();
        registry.startPolling((changed) => pollResults.push(changed));

        rules.invalidate("transport-invalidation");
        events.push("rules:revoke");
        return true;
      };

      try {
        await invokeWorkflowTransition(transition, cleanup, () => {
          events.push(`effect:${transition}`);
        });
        expect(events).toEqual([
          "pseudo:clear",
          "styles/applicability:advance",
          ...(authorStylesheetChanged ? ["stylesheet:advance"] : []),
          "rules:revoke",
          `effect:${transition}`,
        ]);
        expect(registry.revisions).toMatchObject({
          stylesRevision: authorStylesheetChanged ? 2 : 1,
          stylesheetRevision: authorStylesheetChanged ? 1 : 0,
        });

        staleFingerprintPoll();
        expect(pollResults).toEqual([]);
        pending[0]!.result.resolve(workflowMatchedResponse(
          pending[0]!.request,
          0,
          0,
        ));
        await staleMatchedLoad;
        await flushMicrotasks();
        expect(publishedMatched).toEqual([]);
        expect(rules.accept(rulesSources("matrix-stale", 2, "rule-stale")))
          .toBe("ignored");
        rules.open("rule-stale");
        expect(rulesOpens).toEqual([]);

        const freshLoad = authorStylesheetChanged
          ? Promise.resolve()
          : matched.select({
            documentEpoch: 4,
            nodeRef: "node-fresh",
            selectionRevision: 2,
          });
        await flushMicrotasks();
        expect(pending).toHaveLength(2);
        const freshFingerprintPoll = [...polling.values()][0]!;
        expect(freshFingerprintPoll).not.toBe(staleFingerprintPoll);
        freshFingerprintPoll();
        expect(pollResults).toEqual([false]);
        const revisions = registry.revisions;
        pending[1]!.result.resolve(workflowMatchedResponse(
          pending[1]!.request,
          revisions.stylesRevision,
          revisions.stylesheetRevision,
        ));
        await freshLoad;
        await flushMicrotasks();
        expect(publishedMatched).toEqual([
          authorStylesheetChanged ? "node-stale" : "node-fresh",
        ]);

        rules.beginInspect("matrix-fresh", new Set(["rule-fresh"]));
        expect(rules.accept(rulesSources("matrix-fresh", 1, "rule-fresh")))
          .toBe("published");
        rules.open("rule-fresh");
        expect(rulesOpens).toHaveLength(1);
      } finally {
        matched.dispose();
        rules.dispose();
        registry.dispose();
      }
    },
  );

  it("orders cleanup and correlated authority invalidation before controlled unlink", async () => {
    const storage = new MemorySessionStorage();
    const instance = new FakeBridgeInstance({
      port: 48_735,
      pin: "07",
      credentials: credentials("session-a", INSTANCE_A, "a"),
    });
    const cleanupAck = deferred<void>();
    const events: string[] = [];
    const dispatchedRulesOpens: unknown[] = [];
    const rules = new RulesSourcesController((command) => {
      dispatchedRulesOpens.push(command);
    });
    rules.beginInspect("inspect-old", new Set(["rule-old"]));
    expect(rules.accept(rulesSources("inspect-old", 1, "rule-old")))
      .toBe("published");
    let transitionRevision = 0;
    let stylesRevision = 4;
    let stylesheetRevision = 2;
    let pseudoStateRevision = 1;
    const staleRevision = transitionRevision;
    const staleFingerprint = deferred<void>();
    const staleMatched = deferred<void>();
    const staleSettlements: string[] = [];
    const staleWork = [
      staleFingerprint.promise.then(() => {
        if (transitionRevision === staleRevision) staleSettlements.push("fingerprint");
      }),
      staleMatched.promise.then(() => {
        if (transitionRevision === staleRevision) staleSettlements.push("matched");
      }),
    ];
    const coordinator = new WindowConnectionCoordinator({
      store: new BrowserWindowLinkStore(storage),
      createClient: (options) => instance.createClient(options),
      beforeControlledTransition: async () => {
        events.push("pseudo:clear");
        pseudoStateRevision += 1;
        stylesRevision += 1;
        transitionRevision += 1;
        events.push("styles:invalidate");
        rules.invalidate("disconnect");
        events.push("rules:revoke");
        await cleanupAck.promise;
        events.push("cleanup:ack");
        return true;
      },
    } as ConstructorParameters<typeof WindowConnectionCoordinator>[0] & {
      readonly beforeControlledTransition: () => Promise<boolean>;
    });
    const registration = coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-controlled-transition",
    });
    await coordinator.linkWindow(10, "4873507", browserSource("window-10"));
    await flushMicrotasks();
    const client = instance.clients[0];
    if (!client) throw new Error("Expected linked window client");

    const unlinking = coordinator.unlinkWindow(10);
    try {
      await Promise.resolve();
      expect(events).toEqual([
        "pseudo:clear",
        "styles:invalidate",
        "rules:revoke",
      ]);
      expect({ stylesRevision, stylesheetRevision, pseudoStateRevision })
        .toEqual({ stylesRevision: 5, stylesheetRevision: 2, pseudoStateRevision: 2 });
      expect(client.unlinkCalls).toBe(0);

      staleFingerprint.resolve();
      staleMatched.resolve();
      await Promise.all(staleWork);
      expect(staleSettlements).toEqual([]);
      expect(rules.accept(rulesSources("inspect-old", 2, "rule-old")))
        .toBe("ignored");
      rules.open("rule-old");
      expect(dispatchedRulesOpens).toEqual([]);

      cleanupAck.resolve();
      await unlinking;
      expect(events.at(-1)).toBe("cleanup:ack");
      expect(client.unlinkCalls).toBe(1);

      rules.beginInspect("inspect-fresh", new Set(["rule-fresh"]));
      expect(rules.accept(rulesSources("inspect-fresh", 2, "rule-fresh")))
        .toBe("ignored");
      expect(rules.accept(rulesSources("inspect-fresh", 1, "rule-fresh")))
        .toBe("published");
    } finally {
      cleanupAck.resolve();
      await unlinking;
      registration.dispose();
      coordinator.dispose();
    }
  });

  it("isolates two linked browser windows while reusing each window connection", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    const instanceA = new FakeBridgeInstance({
      port: 48_735,
      pin: "07",
      credentials: credentials("session-a", INSTANCE_A, "a"),
    });
    const instanceB = new FakeBridgeInstance({
      port: 48_736,
      pin: "08",
      credentials: credentials("session-b", INSTANCE_B, "b"),
    });
    const instances = new Map([
      [instanceA.url, instanceA],
      [instanceB.url, instanceB],
    ]);
    const coordinator = new WindowConnectionCoordinator({
      store,
      createClient: (options) => {
        const instance = instances.get(options.url);
        if (!instance) {
          throw new Error(`Unexpected bridge endpoint: ${options.url}`);
        }
        return instance.createClient(options);
      },
    });

    await coordinator.linkWindow(10, "4873507", browserSource("window-10"));
    await coordinator.linkWindow(20, "4873608", browserSource("window-20"));

    const panel101 = coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    let panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    const panel201 = coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-201",
    });
    const panel202 = coordinator.registerPanel({
      windowId: 20,
      tabId: 202,
      sourceId: "panel-202",
    });
    await flushMicrotasks();

    expect(coordinator.state(10)).toBe("linked");
    expect(coordinator.state(20)).toBe("linked");
    expect(instanceA.clients).toHaveLength(1);
    expect(instanceB.clients).toHaveLength(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceB.linkPins).toEqual(["08"]);
    expect(storage.values).toEqual({
      "pin-op.windowLink.10": savedLink(instanceA),
      "pin-op.windowLink.20": savedLink(instanceB),
    });

    for (const [windowId, tabId] of [
      [10, 101],
      [10, 102],
      [20, 201],
      [20, 202],
    ] as const) {
      expect(
        coordinator.publishInspect(
          windowId,
          `inspect-${tabId}`,
          `panel-${tabId}`,
          selection(tabId),
        ),
      ).toBe("sent");
    }

    expect(instanceA.sourceIds).toEqual(["panel-101", "panel-102"]);
    expect(instanceB.sourceIds).toEqual(["panel-201", "panel-202"]);
    expect(instanceA.sourceIds).not.toContain("panel-201");
    expect(instanceB.sourceIds).not.toContain("panel-101");
    expect(instanceA.received.map(({ payload }) => payload.metadata)).toEqual([
      {},
      {},
    ]);
    expect(instanceB.received.map(({ payload }) => payload.metadata)).toEqual([
      {},
      {},
    ]);
    expect(
      coordinator.publishInspect(
        10,
        "inspect-wrong-window-a",
        "panel-201",
        selection(201),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        20,
        "inspect-wrong-window-b",
        "panel-101",
        selection(101),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-unknown-source",
        "unknown-source",
        selection(101),
      ),
    ).toBe("not-connected");

    panel102.dispose();
    panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    expect(
      coordinator.publishInspect(
        10,
        "inspect-panel-102-reused",
        "panel-102",
        selection(102),
      ),
    ).toBe("sent");

    expect(instanceA.clients).toHaveLength(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceA.connectCredentials).toEqual([]);
    await expect(store.load(10)).resolves.toEqual(savedLink(instanceA));

    panel101.dispose();
    panel102.dispose();
    expect(instanceA.activeClientCount).toBe(0);
    expect(instanceA.clients[0]?.disconnectCalls).toBe(1);
    await expect(store.load(10)).resolves.toEqual(savedLink(instanceA));

    panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    await flushMicrotasks();

    expect(instanceA.clients).toHaveLength(2);
    expect(instanceA.activeClientCount).toBe(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceA.connectCredentials).toEqual([instanceA.credentials]);
    expect(
      coordinator.publishInspect(
        10,
        "inspect-panel-102-reconnected",
        "panel-102",
        selection(102),
      ),
    ).toBe("sent");

    await coordinator.removeWindow(10);

    expect(instanceA.activeClientCount).toBe(0);
    expect(instanceA.clients[0]?.unlinkCalls).toBe(0);
    expect(instanceA.clients[1]?.unlinkCalls).toBe(1);
    expect(coordinator.state(10)).toBe("notLinked");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-removed-panel-101",
        "panel-101",
        selection(101),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-removed-panel-102",
        "panel-102",
        selection(102),
      ),
    ).toBe("not-connected");
    await expect(store.load(10)).resolves.toBeUndefined();

    const reusedRegistrationStates: string[] = [];
    const reusedRegistration = coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => reusedRegistrationStates.push(state),
    });
    await flushMicrotasks();
    expect(reusedRegistrationStates).toEqual(["notLinked"]);
    expect(instanceA.clients).toHaveLength(2);
    reusedRegistration.dispose();

    expect(coordinator.state(20)).toBe("linked");
    expect(instanceB.activeClientCount).toBe(1);
    expect(
      coordinator.publishInspect(
        20,
        "inspect-panel-202-final",
        "panel-202",
        selection(202),
      ),
    ).toBe("sent");
    await expect(store.load(20)).resolves.toEqual(savedLink(instanceB));
    expect(storage.values).toEqual({
      "pin-op.windowLink.20": savedLink(instanceB),
    });

    panel102.dispose();
    panel201.dispose();
    panel202.dispose();
    coordinator.dispose();
  });
});

interface FakeBridgeConfiguration {
  readonly port: number;
  readonly pin: string;
  readonly credentials: BrowserCredentials;
}

class FakeBridgeInstance {
  public readonly url: string;
  public readonly pin: string;
  public readonly credentials: BrowserCredentials;
  public readonly clients: FakeWindowClient[] = [];
  public readonly linkPins: string[] = [];
  public readonly connectCredentials: BrowserCredentials[] = [];
  public readonly received: Array<{
    inspectMessageId: string;
    payload: InspectPayload;
    sourceId: string;
  }> = [];

  public constructor(configuration: FakeBridgeConfiguration) {
    this.url = `ws://127.0.0.1:${configuration.port}`;
    this.pin = configuration.pin;
    this.credentials = configuration.credentials;
  }

  public get sourceIds(): string[] {
    return this.received.map(({ sourceId }) => sourceId);
  }

  public get activeClientCount(): number {
    return this.clients.filter((client) => client.active).length;
  }

  public createClient(options: BrowserBridgeClientOptions): FakeWindowClient {
    const client = new FakeWindowClient(this, options);
    this.clients.push(client);
    return client;
  }

  public acceptLink(client: FakeWindowClient, pin: string): void {
    this.linkPins.push(pin);
    if (pin !== this.pin) {
      throw new Error("Unexpected PIN");
    }
    client.activate();
    client.emitCredentials(this.credentials);
    client.emitState("connected");
  }

  public acceptCredentials(
    client: FakeWindowClient,
    supplied: BrowserCredentials,
  ): void {
    this.connectCredentials.push(supplied);
    if (JSON.stringify(supplied) !== JSON.stringify(this.credentials)) {
      throw new Error("Unexpected credentials");
    }
    client.activate();
    client.emitState("connected");
  }

  public receive(
    client: FakeWindowClient,
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    if (!client.active) {
      return "not-connected";
    }
    this.received.push({ inspectMessageId, payload, sourceId });
    return "sent";
  }
}

class FakeWindowClient implements WindowConnectionClient {
  public active = false;
  public disconnectCalls = 0;
  public unlinkCalls = 0;
  public onDisconnectEffect: (() => void) | undefined;
  private protocolMismatchListener:
    | ((mismatch: BrowserProtocolMismatch) => void)
    | undefined;

  public constructor(
    private readonly instance: FakeBridgeInstance,
    private readonly options: BrowserBridgeClientOptions,
  ) {}

  public link(pin: string): void {
    this.instance.acceptLink(this, pin);
  }

  public connect(credentials: BrowserCredentials): void {
    this.instance.acceptCredentials(this, credentials);
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
    this.active = false;
    this.onDisconnectEffect?.();
  }

  public unlink(): void {
    this.unlinkCalls += 1;
    this.active = false;
  }

  public sendInspect(
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    return this.instance.receive(this, inspectMessageId, payload, sourceId);
  }

  public sendSourceNavigation(
    _input: Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >,
  ): SourceNavigationSendOutcome {
    return this.active ? "sent" : "not-connected";
  }

  public sendSourceOpen(_input: SourceOpenInput): SourcePresentationSendOutcome {
    return this.active ? "sent" : "not-connected";
  }

  public sendRulesOpen(_input: RulesOpenInput): SourcePresentationSendOutcome {
    return this.active ? "sent" : "not-connected";
  }

  public sendPresentationSettings(
    _input: PresentationSettingsInput,
  ): SourcePresentationSendOutcome {
    return this.active ? "sent" : "not-connected";
  }

  public onResolution(
    _listener: TrustedIdeMessageListener<ResolutionMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onPeerState(_listener: (message: PeerStateMessage) => void) {
    return { dispose(): void {} };
  }

  public onSourceNavigationState(
    _listener: TrustedIdeMessageListener<SourceNavigationStateMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onSourceMatches(
    _listener: TrustedIdeMessageListener<SourceMatchesMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onRulesSources(
    _listener: TrustedIdeMessageListener<RulesSourcesMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onPageRefresh(_listener: (message: PageRefreshMessage) => void) {
    return { dispose(): void {} };
  }

  public onProtocolMismatch(
    listener: (mismatch: BrowserProtocolMismatch) => void,
  ) {
    this.protocolMismatchListener = listener;
    return {
      dispose: () => {
        if (this.protocolMismatchListener === listener) {
          this.protocolMismatchListener = undefined;
        }
      },
    };
  }

  public activate(): void {
    this.active = true;
  }

  public emitCredentials(credentials: BrowserCredentials): void {
    this.options.onCredentials?.(credentials);
  }

  public emitState(state: BrowserConnectionState): void {
    this.options.onStateChanged?.(state);
  }

  public emitProtocolMismatch(mismatch: BrowserProtocolMismatch): void {
    this.protocolMismatchListener?.(mismatch);
  }
}

class MemorySessionStorage implements SessionStorage {
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return Object.hasOwn(this.values, key) ? { [key]: this.values[key] } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  public async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

function browserSource(id: string): ClientSource {
  return { role: "browser", id, metadata: {} };
}

function credentials(
  sessionId: string,
  bridgeInstanceId: string,
  tokenCharacter: string,
): BrowserCredentials {
  return {
    sessionId,
    bridgeInstanceId,
    authToken: tokenCharacter.repeat(32),
  };
}

function savedLink(instance: FakeBridgeInstance): BrowserWindowLink {
  return {
    url: instance.url,
    port: Number(new URL(instance.url).port),
    displayLinkCode: `${new URL(instance.url).port} ${instance.pin}`,
    ...instance.credentials,
  };
}

function selection(tabId: number): InspectPayload {
  return {
    ideHighlightEnabled: true,
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: {
          selector: `.tab-${tabId}`,
          metadata: {},
        },
        facts: [],
        metadata: {},
      },
    ],
    context: {
      url: `http://localhost:${tabId}`,
      metadata: {},
    },
    ruleEvidence: {
      rules: [],
      omittedRuleCount: 0,
    },
    metadata: {},
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

type WorkflowTransition =
  | "stylesheet"
  | "navigation"
  | "recovery"
  | "session-dispose"
  | "lease-replacement"
  | "protocol-mismatch"
  | "connection-dispose";

async function invokeWorkflowTransition(
  transition: WorkflowTransition,
  cleanup: () => boolean,
  effect: () => void,
): Promise<void> {
  let effectObserved = false;
  const observeEffect = () => {
    if (effectObserved) return;
    effectObserved = true;
    effect();
  };
  if (transition === "stylesheet") {
    const view: { top?: unknown } = {};
    view.top = view;
    await refreshExternalStylesheets({
      defaultView: view,
      baseURI: "https://example.test/app.html",
      querySelectorAll() {
        observeEffect();
        return [];
      },
    } as unknown as Document, 1, {
      beforeControlledTransition: cleanup,
    });
    return;
  }
  if (transition === "navigation") {
    const coordinator = new BackgroundContentRefreshCoordinator({
      snapshotStorage: {
        async read() { return undefined; },
        async write() {},
        async remove() { observeEffect(); },
      },
      async executeContentScript() {},
      async sendTopFrameMessage() { return undefined; },
      async reloadTab() {},
      beforeControlledTransition: cleanup,
    });
    coordinator.setWindowEligibility(10, true);
    coordinator.setTabParticipation(101, 10, true);
    expect(coordinator.observeTabUpdate(101, {
      status: "loading",
      url: "https://example.test/next",
      windowId: 10,
    })).toBe(true);
    await flushMicrotasks();
    return;
  }
  if (transition === "recovery") {
    const sentinel = new Error("workflow recovery boundary");
    const coordinator = new DomTreeRecoveryCoordinator({
      controller: {
        beginRecovery() {
          observeEffect();
          throw sentinel;
        },
      } as unknown as ConstructorParameters<
        typeof DomTreeRecoveryCoordinator
      >[0]["controller"],
      transport: {
        async request() {
          throw new Error("Recovery transport must follow beginRecovery");
        },
      },
      beforeControlledTransition: cleanup,
    });
    await expect(coordinator.begin()).rejects.toBe(sentinel);
    return;
  }
  if (transition === "session-dispose" || transition === "lease-replacement") {
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type ===
            "pin-op.inspect.disposeSession"
        ) {
          expect(cleanup()).toBe(true);
          if (transition === "session-dispose") observeEffect();
        }
        return true;
      },
    });
    const session = new BackgroundInspectSession(
      coordinator,
      101,
      () => undefined,
      transition === "lease-replacement"
        ? { onContentLeaseReplacing: () => observeEffect() }
        : {},
    );
    await session.whenIdle();
    coordinator.attachContentLease(
      101,
      "workflow-content-a" as ContentSessionId,
      new WorkflowContentPort(),
    );
    if (transition === "session-dispose") {
      await session.controlledDispose();
    } else {
      coordinator.attachContentLease(
        101,
        "workflow-content-b" as ContentSessionId,
        new WorkflowContentPort(),
      );
      await coordinator.whenIdle(101);
    }
    return;
  }

  const instance = new FakeBridgeInstance({
    port: 48_735,
    pin: "07",
    credentials: credentials("session-a", INSTANCE_A, "a"),
  });
  const coordinator = new WindowConnectionCoordinator({
    store: new BrowserWindowLinkStore(new MemorySessionStorage()),
    createClient: (options) => instance.createClient(options),
    beforeControlledTransition: cleanup,
  });
  coordinator.registerPanel({
    windowId: 10,
    tabId: 101,
    sourceId: `workflow-${transition}`,
  });
  await coordinator.linkWindow(10, "4873507", browserSource("window-10"));
  await flushMicrotasks();
  const client = instance.clients[0];
  if (!client) throw new Error("Expected linked workflow client");
  if (transition === "protocol-mismatch") {
    coordinator.onProtocolMismatch(() => observeEffect());
    client.emitProtocolMismatch({
      browserProtocolVersion: 7,
      peerProtocolVersion: 6,
    });
    await flushMicrotasks();
  } else {
    client.onDisconnectEffect = observeEffect;
    coordinator.dispose();
    await flushMicrotasks();
  }
}

function workflowStylesheetDocument() {
  const view: { top?: unknown } & Record<string, unknown> = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
    CSS: { supports: () => true },
  };
  view.top = view;
  return {
    nodeType: 9,
    styleSheets: [],
    adoptedStyleSheets: [],
    documentElement: { tagName: "HTML" },
    defaultView: view,
    childNodes: [],
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
}

class WorkflowContentPort {
  public readonly name = "pin-op.inspect.contentLease";
  public readonly onDisconnect = new WorkflowPortEvent<() => void>();
  public disconnected = false;

  public disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

class WorkflowPortEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) listener(...args);
  }
}

function rulesSources(
  inspectMessageId: string,
  rulesGeneration: number,
  ruleRef: string,
): RulesSourcesMessage {
  return {
    protocolVersion: 7,
    type: "rules.sources",
    messageId: `rules-${inspectMessageId}-${rulesGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "ide-a" },
    inspectMessageId,
    rulesGeneration,
    sources: [{
      ruleRef,
      openAuthorityId: `open-${ruleRef}`,
      document: { label: "card.scss", languageId: "scss" },
      startLine: 1,
      startColumn: 1,
      confidence: "sourcemap",
    }],
    unresolvedRuleCount: 0,
    metadata: {},
  };
}

function workflowMatchedResponse(
  request: StylesGetMatchedRequest,
  stylesRevision: number,
  stylesheetRevision: number,
): Extract<StylesResponse, { readonly type: "styles.matched" }> {
  return {
    type: "styles.matched",
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision,
    stylesheetRevision,
    pseudoStateRevision: request.pseudoStateRevision,
    pseudoStates: request.pseudoStates,
    styles: {
      documentEpoch: request.documentEpoch,
      nodeRef: request.nodeRef,
      selectionRevision: request.selectionRevision,
      stylesRevision,
      stylesheetRevision,
      pseudoStateRevision: request.pseudoStateRevision,
      pseudoStates: request.pseudoStates,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      unsupportedRuleCount: 0,
      approximateRuleCount: 0,
      partial: false,
      diagnostics: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
