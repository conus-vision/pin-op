import {
  PROTOCOL_VERSION,
  type ClientSource,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserProtocolError,
  BrowserWindowLinkStore,
  WindowConnectionCoordinator,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type BrowserWindowLink,
  type InspectPayload,
  type SessionStorage,
} from "../src/index.js";
import type {
  InspectSendOutcome,
  SourceNavigationSendOutcome,
} from "../src/bridgeClient.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";
const AUTH_TOKEN_A = "a".repeat(32);
const AUTH_TOKEN_B = "b".repeat(32);

describe("WindowConnectionCoordinator", () => {
  it("opens one client for all panels in one browser window", async () => {
    const storage = new MemorySessionStorage({
      "browser2ide.windowLink.10": windowLink({
        port: 48_736,
        bridgeInstanceId: INSTANCE_B,
      }),
    });
    const harness = coordinatorHarness(storage);
    await harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );
    expect(harness.createdClients).toHaveLength(0);
    expect(harness.coordinator.state(10)).toBe("linking");

    const first = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "p1",
    });
    const second = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "p2",
    });
    await harness.flush();

    expect(storage.getCalls).toBe(0);
    expect(harness.createdClients).toHaveLength(1);
    expect(harness.createdClients[0]).toMatchObject({
      url: "ws://127.0.0.1:48735",
      sourceId: "window-10",
      linkCalls: ["07"],
      connectCalls: [],
    });
    first.dispose();
    expect(harness.createdClients[0].disconnectCalls).toBe(0);
    second.dispose();
    expect(harness.createdClients[0].disconnectCalls).toBe(1);
  });

  it("starts a pending link when registration races store cleanup", async () => {
    const storage = new DeferredRemoveSessionStorage();
    const harness = coordinatorHarness(storage);
    const linking = harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );
    await storage.waitForRemove();

    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    expect(harness.createdClients).toHaveLength(0);

    storage.resolveRemove();
    await linking;
    await harness.flush();

    expect(storage.getCalls).toBe(0);
    expect(harness.createdClients).toHaveLength(1);
    expect(harness.createdClients[0]).toMatchObject({
      url: "ws://127.0.0.1:48735",
      sourceId: "window-10",
      linkCalls: ["07"],
    });
  });

  it("cancels a pending link cleanup when its owning panel operation aborts", async () => {
    const storage = new DeferredRemoveSessionStorage();
    const harness = coordinatorHarness(storage);
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const controller = new AbortController();
    const linking = harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
      controller.signal,
    );
    await storage.waitForRemove();

    let outcome: "resolved" | Error | undefined;
    void linking.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error : new Error(String(error));
      },
    );
    controller.abort();
    await harness.flush();

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("aborted");
    storage.resolveRemove();
    await harness.flush();
    expect(harness.createdClients).toEqual([]);
    expect(harness.coordinator.state(10)).toBe("notLinked");
  });

  it("keeps clients and endpoints isolated between browser windows", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-201",
    });

    const first = await harness.link(10, "4873507");
    const second = await harness.link(20, "4873608");

    expect(harness.createdClients).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(first.url).toBe("ws://127.0.0.1:48735");
    expect(second.url).toBe("ws://127.0.0.1:48736");
    expect(first.sourceId).toBe("window-10");
    expect(second.sourceId).toBe("window-20");
  });

  it("loads a saved window link on the first registration", async () => {
    const harness = coordinatorHarness();
    const saved = windowLink();
    await harness.store.save(10, saved);
    const states: string[] = [];

    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => states.push(state),
    });
    expect(harness.createdClients).toHaveLength(0);
    await harness.flush();

    expect(harness.createdClients).toHaveLength(1);
    expect(harness.createdClients[0]).toMatchObject({
      url: saved.url,
      sourceId: "panel-101",
      connectCalls: [credentialsFor(saved)],
    });
    expect(states).toContain("linking");

    harness.createdClients[0].emitState("connected");
    expect(harness.coordinator.state(10)).toBe("linked");
  });

  it("publishes the exact session display code to every panel in the window", async () => {
    const harness = coordinatorHarness();
    const firstSnapshots: Array<readonly [string, string | undefined]> = [];
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state, displayLinkCode) => {
        firstSnapshots.push([state, displayLinkCode]);
      },
    });
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());

    const secondSnapshots: Array<readonly [string, string | undefined]> = [];
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
      onStateChanged: (state, displayLinkCode) => {
        secondSnapshots.push([state, displayLinkCode]);
      },
    });

    expect(firstSnapshots).toContainEqual(["linked", "48735 07"]);
    expect(secondSnapshots.at(-1)).toEqual(["linked", "48735 07"]);
  });

  it("does not present an unauthenticated pending code as a linked transport error", async () => {
    const harness = coordinatorHarness();
    const snapshots: Array<readonly [string, string | undefined]> = [];
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state, displayLinkCode) => {
        snapshots.push([state, displayLinkCode]);
      },
    });
    const client = await harness.link(10, "4873507");

    client.emitState("error");

    expect(snapshots.at(-1)).toEqual(["error", undefined]);
  });

  it.each(["auth.instanceChanged", "auth.tokenRejected"] as const)(
    "deletes the mapping and never retries after %s",
    async (code) => {
      const harness = coordinatorHarness();
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });
      const client = await harness.link(10, "4873507");
      await harness.authenticate(client, windowLink());

      client.emitState("error");
      client.emitError(new BrowserProtocolError(code, "sanitized"));
      client.emitState("disconnected");
      await harness.flush();

      await expect(harness.store.load(10)).resolves.toBeUndefined();
      expect(harness.coordinator.state(10)).toBe("notLinked");
      expect(client.disconnectCalls).toBe(1);
      expect(harness.createdClients).toHaveLength(1);
      expect(harness.timers.pendingCount()).toBe(0);
    },
  );

  it("does not let stale auth cleanup overwrite a new link state", async () => {
    const storage = new RejectableAuthRemovalStorage();
    const harness = coordinatorHarness(storage);
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const first = await harness.link(10, "4873507");
    await harness.authenticate(first, windowLink());

    first.emitState("error");
    first.emitError(
      new BrowserProtocolError("auth.tokenRejected", "sanitized"),
    );
    await storage.waitForAuthRemoval();

    const relinking = harness.coordinator.linkWindow(
      10,
      "4873608",
      browserSource("window-10-new"),
    );
    expect(harness.coordinator.state(10)).toBe("linking");
    storage.rejectAuthRemoval();
    await relinking;

    expect(harness.coordinator.state(10)).toBe("linking");
    expect(harness.createdClients).toHaveLength(2);
    expect(harness.createdClients[1].url).toBe("ws://127.0.0.1:48736");
  });

  it("maps protocol rate limiting without scheduling a retry", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");

    client.emitState("error");
    client.emitError(
      new BrowserProtocolError("link.rateLimited", "sanitized"),
    );

    expect(harness.coordinator.state(10)).toBe("rateLimited");
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("terminates an unreachable initial code link without retrying", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");

    client.emitState("disconnected");

    expect(harness.coordinator.state(10)).toBe("error");
    expect(client.linkCalls).toEqual(["07"]);
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("caps stored-credential reconnects and enters offline", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");
    const saved = windowLink();
    await harness.authenticate(client, saved);

    client.emitState("disconnected");
    expect(harness.coordinator.state(10)).toBe("reconnecting");
    expect(harness.timers.delays).toEqual([1_000]);

    for (const expectedDelay of [2_000, 4_000, 5_000, 5_000]) {
      harness.timers.runNext();
      expect(client.connectCalls.at(-1)).toEqual(credentialsFor(saved));
      client.emitState("disconnected");
      expect(harness.timers.delays.at(-1)).toBe(expectedDelay);
    }

    harness.timers.runNext();
    client.emitState("disconnected");

    expect(harness.createdClients).toHaveLength(1);
    expect(harness.coordinator.state(10)).toBe("offline");
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("cancels stored reconnect with the final panel", async () => {
    const harness = coordinatorHarness();
    const registration = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());

    client.emitState("disconnected");
    expect(harness.timers.pendingCount()).toBe(1);

    registration.dispose();
    expect(client.disconnectCalls).toBe(1);
    expect(harness.timers.pendingCount()).toBe(0);
    expect(() => harness.timers.runNext()).toThrow("Expected a pending timer");
  });

  it("resets stored reconnect backoff after online recovery", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());

    client.emitState("disconnected");
    harness.timers.runNext();
    client.emitState("disconnected");
    expect(harness.timers.delays.at(-1)).toBe(2_000);

    client.emitState("connected");
    expect(harness.coordinator.state(10)).toBe("linked");
    expect(harness.timers.pendingCount()).toBe(0);

    client.emitState("disconnected");
    expect(harness.coordinator.state(10)).toBe("reconnecting");
    expect(harness.timers.delays.at(-1)).toBe(1_000);
  });

  it("does not install a stale reconnect timer after a state callback relinks", async () => {
    const harness = coordinatorHarness();
    let relinking: Promise<void> | undefined;
    let didRelink = false;
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => {
        if (state === "reconnecting" && !didRelink) {
          didRelink = true;
          relinking = harness.coordinator.linkWindow(
            10,
            "4873608",
            browserSource("window-10-replacement"),
          );
        }
      },
    });
    const original = await harness.link(10, "4873507");
    await harness.authenticate(original, windowLink());

    original.emitState("disconnected");
    await relinking;
    await harness.flush();

    expect(harness.createdClients).toHaveLength(2);
    expect(harness.timers.pendingCount()).toBe(0);
    const replacement = harness.createdClients[1];

    replacement.emitState("disconnected");

    expect(harness.coordinator.state(10)).toBe("error");
    expect(harness.timers.pendingCount()).toBe(0);
    expect(harness.timers.delays).toEqual([]);
    expect(replacement.linkCalls).toEqual(["08"]);
  });

  it("revokes and deletes links on unlink and browser-window removal", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-201",
    });
    const first = await harness.link(10, "4873507");
    const second = await harness.link(20, "4873608");
    await harness.authenticate(first, windowLink());
    await harness.authenticate(
      second,
      windowLink({
        port: 48_736,
        sessionId: "session-20",
        bridgeInstanceId: INSTANCE_B,
        authToken: AUTH_TOKEN_B,
      }),
    );

    await harness.coordinator.unlinkWindow(10);
    await harness.coordinator.removeWindow(20);

    expect(first.unlinkCalls).toBe(1);
    expect(second.unlinkCalls).toBe(1);
    await expect(harness.store.load(10)).resolves.toBeUndefined();
    await expect(harness.store.load(20)).resolves.toBeUndefined();
    expect(harness.coordinator.state(10)).toBe("notLinked");
    expect(harness.coordinator.state(20)).toBe("notLinked");
  });

  it("disconnects and clears only the requested browser window", async () => {
    const harness = coordinatorHarness();
    const firstStates: Array<readonly [string, string | undefined]> = [];
    const secondStates: Array<readonly [string, string | undefined]> = [];
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state, code) => firstStates.push([state, code]),
    });
    harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-201",
      onStateChanged: (state, code) => secondStates.push([state, code]),
    });
    const first = await harness.link(10, "4873507");
    const second = await harness.link(20, "4873608");
    await harness.authenticate(first, windowLink());
    await harness.authenticate(
      second,
      windowLink({
        port: 48_736,
        sessionId: "session-20",
        bridgeInstanceId: INSTANCE_B,
        authToken: AUTH_TOKEN_B,
        displayLinkCode: "48736 08",
      }),
    );

    await harness.coordinator.unlinkWindow(10);

    expect(firstStates.at(-1)).toEqual(["notLinked", undefined]);
    expect(secondStates.at(-1)).toEqual(["linked", "48736 08"]);
    expect(harness.coordinator.state(20)).toBe("linked");
    await expect(harness.store.load(20)).resolves.toMatchObject({
      displayLinkCode: "48736 08",
    });
  });

  it("preserves sources without exposing internal routing metadata", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const payload: InspectPayload = {
      ...selection(".same-selection"),
      metadata: {
        existing: "preserved",
        browserWindowId: 999,
        tabId: 999,
      },
    };

    expect(
      harness.coordinator.publishInspect(
        10,
        "inspect-panel-101",
        "panel-101",
        payload,
      ),
    ).toBe("sent");
    expect(
      harness.coordinator.publishInspect(
        10,
        "inspect-panel-102",
        "panel-102",
        payload,
      ),
    ).toBe("sent");
    expect(client.inspectCalls.map(({ inspectMessageId }) => inspectMessageId))
      .toEqual(["inspect-panel-101", "inspect-panel-102"]);
    expect(client.inspectCalls.map(({ sourceId }) => sourceId)).toEqual([
      "panel-101",
      "panel-102",
    ]);
    expect(client.inspectCalls.map(({ payload }) => payload.metadata)).toEqual([
      { existing: "preserved" },
      { existing: "preserved" },
    ]);
    expect(payload.metadata).toEqual({
      existing: "preserved",
      browserWindowId: 999,
      tabId: 999,
    });
    expect(
      harness.coordinator.publishInspect(
        10,
        "inspect-not-registered",
        "not-registered",
        payload,
      ),
    ).toBe("not-connected");
    expect(
      harness.coordinator.publishInspect(
        20,
        "inspect-wrong-window",
        "panel-101",
        payload,
      ),
    ).toBe("not-connected");

    client.emitState("disconnected");
    expect(
      harness.coordinator.publishInspect(
        10,
        "inspect-disconnected",
        "panel-101",
        payload,
      ),
    ).toBe("not-connected");
  });

  it("publishes source navigation only through the current linked window client", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const first = await harness.link(10, "4873507");
    await harness.authenticate(first, windowLink());
    const previous = {
      inspectMessageId: "inspect-current",
      resolutionGeneration: 4,
      direction: "previous" as const,
    };

    expect(harness.coordinator.publishSourceNavigation(10, previous)).toBe(
      "sent",
    );
    expect(harness.coordinator.publishSourceNavigation(20, previous)).toBe(
      "not-connected",
    );
    expect(first.sourceNavigationCalls).toEqual([previous]);

    await harness.coordinator.unlinkWindow(10);
    expect(harness.coordinator.publishSourceNavigation(10, previous)).toBe(
      "not-connected",
    );

    const replacement = await harness.link(10, "4873508");
    await harness.authenticate(replacement, windowLink());
    const next = { ...previous, direction: "next" as const };
    expect(harness.coordinator.publishSourceNavigation(10, next)).toBe("sent");
    expect(first.sourceNavigationCalls).toEqual([previous]);
    expect(replacement.sourceNavigationCalls).toEqual([next]);
  });

  it.each(["returned", "thrown"] as const)(
    "moves the current window to error when source navigation transport failure is %s",
    async (failureMode) => {
      const harness = coordinatorHarness();
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });
      const client = await harness.link(10, "4873507");
      await harness.authenticate(client, windowLink());
      if (failureMode === "returned") {
        client.sourceNavigationResult = "transport-error";
      } else {
        client.throwOnSourceNavigation = true;
      }

      expect(harness.coordinator.publishSourceNavigation(10, {
        inspectMessageId: "inspect-current",
        resolutionGeneration: 4,
        direction: "next",
      })).toBe("transport-error");
      expect(harness.coordinator.state(10)).toBe("error");
    },
  );

  it("forwards protocol events only from the current window client", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const receivedResolutions: Array<[number, ResolutionMessage]> = [];
    const receivedPeerStates: Array<[number, PeerStateMessage]> = [];
    const receivedNavigationStates: Array<
      [number, SourceNavigationStateMessage]
    > = [];
    const resolutionSubscription = harness.coordinator.onResolution(
      (windowId, message) => receivedResolutions.push([windowId, message]),
    );
    const peerSubscription = harness.coordinator.onPeerState(
      (windowId, message) => receivedPeerStates.push([windowId, message]),
    );
    const navigationSubscription = harness.coordinator.onSourceNavigationState(
      (windowId, message) => receivedNavigationStates.push([windowId, message]),
    );
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const currentResolution = resolution("inspect-current", 1);
    const currentPeerState = peerState(true, 1);
    const currentNavigationState = sourceNavigationState("inspect-current", 1);

    client.emitResolution(currentResolution);
    client.emitPeerState(currentPeerState);
    client.emitSourceNavigationState(currentNavigationState);

    expect(receivedResolutions).toEqual([[10, currentResolution]]);
    expect(receivedPeerStates).toEqual([[10, currentPeerState]]);
    expect(receivedNavigationStates).toEqual([[10, currentNavigationState]]);

    await harness.coordinator.unlinkWindow(10);
    client.emitResolution(resolution("inspect-revoked", 2));
    client.emitPeerState(peerState(false, 2));
    client.emitSourceNavigationState(sourceNavigationState("inspect-revoked", 2));
    expect(receivedResolutions).toEqual([[10, currentResolution]]);
    expect(receivedPeerStates).toEqual([[10, currentPeerState]]);
    expect(receivedNavigationStates).toEqual([[10, currentNavigationState]]);

    resolutionSubscription.dispose();
    peerSubscription.dispose();
    navigationSubscription.dispose();
  });

  it("snapshots registration identity, metadata, callback, and disposal", async () => {
    const harness = coordinatorHarness();
    const originalStates: string[] = [];
    const replacementStates: string[] = [];
    const registration = {
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state: string) => originalStates.push(state),
    };
    const handle = harness.coordinator.registerPanel(registration);
    originalStates.length = 0;

    registration.windowId = 20;
    registration.tabId = 201;
    registration.sourceId = "panel-201";
    registration.onStateChanged = (state) => replacementStates.push(state);

    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    expect(originalStates).toContain("linking");
    expect(originalStates).toContain("linked");
    expect(replacementStates).toEqual([]);

    expect(
      harness.coordinator.publishInspect(
        10,
        "inspect-stable-registration",
        "panel-101",
        selection(".stable-registration"),
      ),
    ).toBe("sent");
    expect(client.inspectCalls.at(-1)).toMatchObject({
      inspectMessageId: "inspect-stable-registration",
      sourceId: "panel-101",
      payload: {
        metadata: {},
      },
    });

    handle.dispose();
    expect(client.disconnectCalls).toBe(1);

    const reusedStates: string[] = [];
    const reused = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => reusedStates.push(state),
    });
    await harness.flush();

    expect(harness.createdClients).toHaveLength(2);
    expect(reusedStates).toEqual(["offline", "linking"]);
    reused.dispose();
  });

  it("does not connect a saved mapping whose load finishes after unlink", async () => {
    const storage = new DeferredGetSessionStorage();
    const harness = coordinatorHarness(storage);
    const registration = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);

    const unlinking = harness.coordinator.unlinkWindow(10);
    storage.resolveGet({ "browser2ide.windowLink.10": windowLink() });
    await unlinking;
    await harness.flush();

    expect(harness.createdClients).toHaveLength(0);
    expect(storage.values).not.toHaveProperty("browser2ide.windowLink.10");
    expect(harness.coordinator.state(10)).toBe("notLinked");
    registration.dispose();
  });

  it.each(["unlink", "dispose"] as const)(
    "ignores stale credentials and reconnect callbacks after %s",
    async (operation) => {
      const harness = coordinatorHarness();
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });
      const client = await harness.link(10, "4873507");

      if (operation === "unlink") {
        await harness.coordinator.unlinkWindow(10);
      } else {
        harness.coordinator.dispose();
      }
      client.emitCredentials(credentialsFor(windowLink()));
      client.emitState("connected");
      client.emitState("disconnected");
      await harness.flush();

      await expect(harness.store.load(10)).resolves.toBeUndefined();
      expect(harness.createdClients).toHaveLength(1);
      expect(harness.timers.pendingCount()).toBe(0);
    },
  );

  it("ignores a saved mapping whose load finishes after disposal", async () => {
    const storage = new DeferredGetSessionStorage();
    const harness = coordinatorHarness(storage);
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);

    harness.coordinator.dispose();
    storage.resolveGet({ "browser2ide.windowLink.10": windowLink() });
    await harness.flush();

    expect(harness.createdClients).toHaveLength(0);
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("returns inert handles for invalid and duplicate registrations", async () => {
    const storage = new MemorySessionStorage();
    const harness = coordinatorHarness(storage);
    const invalid = [
      { windowId: -1, tabId: 101, sourceId: "negative-window" },
      { windowId: 10, tabId: 1.5, sourceId: "fractional-tab" },
      { windowId: 10, tabId: 101, sourceId: "" },
    ];

    for (const registration of invalid) {
      const handle = harness.coordinator.registerPanel(registration);
      expect(() => handle.dispose()).not.toThrow();
      expect(() => handle.dispose()).not.toThrow();
    }

    const valid = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const duplicateSource = harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-101",
    });
    const duplicateTab = harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 101,
      sourceId: "panel-201",
    });
    await harness.flush();

    duplicateSource.dispose();
    duplicateTab.dispose();
    expect(storage.getCalls).toBe(1);
    expect(harness.createdClients).toHaveLength(0);
    valid.dispose();
  });

  it("disposes an earlier client subscription when later setup fails", async () => {
    const createdClients: FakeWindowClient[] = [];
    const coordinator = new WindowConnectionCoordinator({
      store: new BrowserWindowLinkStore(new MemorySessionStorage()),
      createClient: (options) => {
        const client = new FakeWindowClient(options);
        client.throwOnPeerStateSubscription = true;
        createdClients.push(client);
        return client;
      },
    });

    await coordinator.linkWindow(10, "4873507", browserSource("window-10"));
    coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]?.resolutionListenerCount()).toBe(0);
    expect(createdClients[0]?.disconnectCalls).toBe(1);
    expect(coordinator.state(10)).toBe("error");
  });
});

class FakeWindowClient {
  public readonly url: string;
  public readonly sourceId: string;
  public readonly autoReconnect: boolean | undefined;
  public readonly linkCalls: string[] = [];
  public readonly connectCalls: BrowserCredentials[] = [];
  public readonly inspectCalls: Array<{
    inspectMessageId: string;
    payload: InspectPayload;
    sourceId: string;
  }> = [];
  public readonly sourceNavigationCalls: Array<
    Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >
  > = [];
  public disconnectCalls = 0;
  public unlinkCalls = 0;
  public inspectResult: InspectSendOutcome = "sent";
  public sourceNavigationResult: SourceNavigationSendOutcome = "sent";
  public throwOnSourceNavigation = false;
  public throwOnPeerStateSubscription = false;
  private readonly resolutionListeners = new Set<
    (message: ResolutionMessage) => void
  >();
  private readonly peerStateListeners = new Set<
    (message: PeerStateMessage) => void
  >();
  private readonly sourceNavigationStateListeners = new Set<
    (message: SourceNavigationStateMessage) => void
  >();

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.url = options.url;
    this.sourceId = options.sourceId;
    this.autoReconnect = options.autoReconnect;
  }

  public link(pin: string): void {
    this.linkCalls.push(pin);
  }

  public connect(credentials: BrowserCredentials): void {
    this.connectCalls.push(credentials);
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }

  public unlink(): void {
    this.unlinkCalls += 1;
  }

  public sendInspect(
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    this.inspectCalls.push({ inspectMessageId, payload, sourceId });
    return this.inspectResult;
  }

  public sendSourceNavigation(
    input: Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >,
  ): SourceNavigationSendOutcome {
    this.sourceNavigationCalls.push({ ...input });
    if (this.throwOnSourceNavigation) {
      throw new Error("source navigation send failed");
    }
    return this.sourceNavigationResult;
  }

  public onResolution(listener: (message: ResolutionMessage) => void) {
    this.resolutionListeners.add(listener);
    return {
      dispose: () => this.resolutionListeners.delete(listener),
    };
  }

  public onPeerState(listener: (message: PeerStateMessage) => void) {
    if (this.throwOnPeerStateSubscription) {
      throw new Error("peer-state subscription failed");
    }
    this.peerStateListeners.add(listener);
    return {
      dispose: () => this.peerStateListeners.delete(listener),
    };
  }

  public onSourceNavigationState(
    listener: (message: SourceNavigationStateMessage) => void,
  ) {
    this.sourceNavigationStateListeners.add(listener);
    return {
      dispose: () => this.sourceNavigationStateListeners.delete(listener),
    };
  }

  public emitResolution(message: ResolutionMessage): void {
    for (const listener of this.resolutionListeners) {
      listener(message);
    }
  }

  public resolutionListenerCount(): number {
    return this.resolutionListeners.size;
  }

  public emitPeerState(message: PeerStateMessage): void {
    for (const listener of this.peerStateListeners) {
      listener(message);
    }
  }

  public emitSourceNavigationState(message: SourceNavigationStateMessage): void {
    for (const listener of this.sourceNavigationStateListeners) {
      listener(message);
    }
  }

  public emitCredentials(credentials: BrowserCredentials): void {
    this.options.onCredentials?.(credentials);
  }

  public emitState(state: BrowserConnectionState): void {
    this.options.onStateChanged?.(state);
  }

  public emitError(error: Error): void {
    this.options.onError?.(error);
  }
}

class MemorySessionStorage implements SessionStorage {
  public readonly values: Record<string, unknown>;
  public readonly removals: string[] = [];
  public getCalls = 0;

  public constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }

  public async get(key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    return Object.hasOwn(this.values, key) ? { [key]: this.values[key] } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  public async remove(key: string): Promise<void> {
    this.removals.push(key);
    delete this.values[key];
  }
}

class DeferredGetSessionStorage extends MemorySessionStorage {
  private resolvePendingGet:
    | ((values: Record<string, unknown>) => void)
    | undefined;
  private readonly pendingGet = new Promise<Record<string, unknown>>(
    (resolve) => {
      this.resolvePendingGet = resolve;
    },
  );

  public override async get(_key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    const values = await this.pendingGet;
    Object.assign(this.values, values);
    return values;
  }

  public resolveGet(values: Record<string, unknown>): void {
    this.resolvePendingGet?.(values);
    this.resolvePendingGet = undefined;
  }
}

class DeferredRemoveSessionStorage extends MemorySessionStorage {
  private readonly removeStarted = deferred<void>();
  private readonly removeCompletion = deferred<void>();

  public override async remove(key: string): Promise<void> {
    this.removeStarted.resolve();
    await this.removeCompletion.promise;
    await super.remove(key);
  }

  public async waitForRemove(): Promise<void> {
    await this.removeStarted.promise;
  }

  public resolveRemove(): void {
    this.removeCompletion.resolve();
  }
}

class RejectableAuthRemovalStorage extends MemorySessionStorage {
  private removeCalls = 0;
  private readonly authRemovalStarted = deferred<void>();
  private readonly authRemoval = deferred<void>();

  public override async remove(key: string): Promise<void> {
    this.removeCalls += 1;
    if (this.removeCalls === 2) {
      this.authRemovalStarted.resolve();
      await this.authRemoval.promise;
    }
    await super.remove(key);
  }

  public async waitForAuthRemoval(): Promise<void> {
    await this.authRemovalStarted.promise;
  }

  public rejectAuthRemoval(): void {
    this.authRemoval.reject(new Error("session storage unavailable"));
  }
}

function coordinatorHarness(storage: SessionStorage = new MemorySessionStorage()) {
  const createdClients: FakeWindowClient[] = [];
  const store = new BrowserWindowLinkStore(storage);
  const timers = manualTimers();
  const coordinator = new WindowConnectionCoordinator({
    store,
    createClient: (options) => {
      const client = new FakeWindowClient(options);
      createdClients.push(client);
      return client;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  return {
    coordinator,
    createdClients,
    store,
    timers,
    async link(windowId: number, code: string): Promise<FakeWindowClient> {
      const before = createdClients.length;
      await coordinator.linkWindow(
        windowId,
        code,
        browserSource(`window-${windowId}`),
      );
      const client = createdClients[before];
      if (!client) {
        throw new Error("Expected linkWindow to create a client");
      }
      return client;
    },
    async authenticate(
      client: FakeWindowClient,
      saved: BrowserWindowLink,
    ): Promise<void> {
      client.emitCredentials(credentialsFor(saved));
      client.emitState("connected");
      await flushMicrotasks();
      expect(coordinator.state(windowIdFor(saved))).toBe("linked");
    },
    flush: flushMicrotasks,
  };
}

function resolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    status: "no-active-editor",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function peerState(
  connected: boolean,
  peerGeneration: number,
): PeerStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: `peer-${peerGeneration}`,
    sessionId: "session-a",
    role: "ide",
    connected,
    peerGeneration,
    metadata: {},
  };
}

function sourceNavigationState(
  inspectMessageId: string,
  resolutionGeneration: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    selectedMatchCount: 2,
    activeMatchIndex: 0,
    metadata: {},
  };
}

function manualTimers() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const cleared: number[] = [];

  return {
    delays,
    cleared,
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const id = ++nextId;
      callbacks.set(id, callback);
      delays.push(delay);
      return id as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>): void {
      const id = timer as unknown as number;
      cleared.push(id);
      callbacks.delete(id);
    },
    runNext(): void {
      const entry = callbacks.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!entry) {
        throw new Error("Expected a pending timer");
      }
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pendingCount(): number {
      return callbacks.size;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function browserSource(id: string): ClientSource {
  return { role: "browser", id, metadata: {} };
}

function windowLink(
  override: Partial<BrowserWindowLink> = {},
): BrowserWindowLink {
  const port = override.port ?? 48_735;
  return {
    url: override.url ?? `ws://127.0.0.1:${port}`,
    port,
    sessionId: override.sessionId ?? "session-10",
    bridgeInstanceId: override.bridgeInstanceId ?? INSTANCE_A,
    authToken: override.authToken ?? AUTH_TOKEN_A,
    displayLinkCode: override.displayLinkCode ?? `${port} 07`,
  };
}

function credentialsFor(link: BrowserWindowLink): BrowserCredentials {
  return {
    sessionId: link.sessionId,
    bridgeInstanceId: link.bridgeInstanceId,
    authToken: link.authToken,
  };
}

function windowIdFor(link: BrowserWindowLink): number {
  return link.port === 48_736 ? 20 : 10;
}

function selection(selector: string): InspectPayload {
  return {
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector, metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}
