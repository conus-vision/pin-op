import {
  PROTOCOL_VERSION,
  type ClientSource,
  type PageRefreshMessage,
  type PeerStateMessage,
  type PresentationSettingsMessage,
  type ResolutionMessage,
  type SourceMatchesMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserProtocolError,
  BrowserWindowLinkStore,
  WindowConnectionCoordinator,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type BrowserProtocolMismatch,
  type BrowserWindowLink,
  type InspectPayload,
  type SessionStorage,
} from "../src/index.js";
import { BackgroundInspectCoordinator } from "../src/backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundContentRefreshRuntime,
  type BackgroundMessageSender,
  type BackgroundRuntimePort,
} from "../src/backgroundRouter.js";
import type {
  InspectSendOutcome,
  SourceNavigationSendOutcome,
} from "../src/bridgeClient.js";
import {
  createTransportTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "../src/trustedIdePeerContext.js";
import { createDevtoolsPanelPortName } from "../src/inspectPortProtocol.js";
import { TabRefreshCoordinator } from "../src/tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "../src/tabRefreshStateStore.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";
const AUTH_TOKEN_A = "a".repeat(32);
const AUTH_TOKEN_B = "b".repeat(32);
const DEVTOOLS_URL = "moz-extension://pin-op/dist/devtools.html";
const PANEL_URL = "moz-extension://pin-op/dist/panel.html";

describe("WindowConnectionCoordinator", () => {
  it("opens one client for all panels in one browser window", async () => {
    const storage = new MemorySessionStorage({
      "pin-op.windowLink.10": windowLink({
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

  it("retains the linked client after the last panel closes while a tab participates", async () => {
    const harness = coordinatorHarness();
    await harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );
    const panel = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await harness.flush();
    const client = harness.createdClients[0];
    await harness.authenticate(client, windowLink());

    harness.coordinator.setRefreshParticipant(10, 101, true);
    panel.dispose();
    expect(client.disconnectCalls).toBe(0);

    harness.coordinator.setRefreshParticipant(10, 101, false);
    expect(client.disconnectCalls).toBe(1);
    expect(harness.coordinator.state(10)).toBe("offline");
  });

  it("cancels retained connection ownership through the real tab lifecycle", async () => {
    const storage = new MemorySessionStorage();
    const harness = coordinatorHarness(storage);
    await harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );
    const panel = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await harness.flush();
    const client = harness.createdClients[0];
    await harness.authenticate(client, windowLink());
    const tabs = new TabRefreshCoordinator({
      store: new TabRefreshStateStore(storage),
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: (windowId, tabId, participant) =>
        harness.coordinator.setRefreshParticipant(
          windowId,
          tabId,
          participant,
        ),
    });
    await tabs.panelOpened(101, 10);
    panel.dispose();
    expect(client.disconnectCalls).toBe(0);

    await tabs.panelClosed(101, 10);

    expect(client.disconnectCalls).toBe(1);
    expect(harness.coordinator.state(10)).toBe("offline");
    const replacement = new TabRefreshCoordinator({
      store: new TabRefreshStateStore(storage),
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: (windowId, tabId, participant) =>
        harness.coordinator.setRefreshParticipant(
          windowId,
          tabId,
          participant,
        ),
    });
    await replacement.initialize();
    expect(harness.createdClients).toHaveLength(1);
  });

  it("cancels a restored reconnect before unknown-window close awaits storage", async () => {
    const storage = new MemorySessionStorage();
    const harness = coordinatorHarness(storage);
    const saved = windowLink();
    await harness.store.save(10, saved);
    const tabStore = new TabRefreshStateStore(storage);
    await tabStore.save({
      tabId: 101,
      windowId: 10,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 0,
    });
    const tabs = new TabRefreshCoordinator({
      store: tabStore,
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: (windowId, tabId, participant) =>
        harness.coordinator.setRefreshParticipant(
          windowId,
          tabId,
          participant,
        ),
    });
    await tabs.initialize();
    await harness.flush();
    const client = harness.createdClients[0];
    expect(client.connectCalls).toEqual([credentialsFor(saved)]);
    client.emitState("connected");
    client.emitState("disconnected");
    expect(harness.timers.pendingCount()).toBe(1);

    const tabLookup = deferred<{ id: number; windowId: number }>();
    const router = createBackgroundRouter({
      expectedDevtoolsUrl: DEVTOOLS_URL,
      expectedPanelUrl: PANEL_URL,
      getTab: async () => tabLookup.promise,
      coordinator: harness.coordinator,
      tabRefreshCoordinator: tabs,
      inspectCoordinator: new BackgroundInspectCoordinator({
        executeScript: async () => undefined,
        sendTabMessage: async () => undefined,
      }),
    });
    const channel = "restored-pending-close";
    const port = new TestRuntimePort(
      createDevtoolsPanelPortName(channel),
      { url: `${PANEL_URL}?channel=${channel}` },
    );
    router.connectPort(port);
    const registration = router.routeMessage({
      type: "pin-op.registerDevtools",
      channel,
      tabId: 101,
      sourceId: "restored-pending-source",
    }, { url: DEVTOOLS_URL });
    await flushMicrotasks();

    port.disconnect();
    if (harness.timers.pendingCount() > 0) {
      harness.timers.runNext();
    }

    expect(client.connectCalls).toEqual([credentialsFor(saved)]);
    tabLookup.resolve({ id: 101, windowId: 10 });
    await expect(registration).resolves.toBeUndefined();
    expect(await tabs.state(101, 10)).toMatchObject({ participant: false });
    router.dispose();
  });

  it("lets terminal tab removal cancel pending registration before a late disconnect", async () => {
    const storage = new DeferredRemoveSessionStorage();
    const harness = coordinatorHarness(storage);
    const tabStore = new TabRefreshStateStore(storage);
    await tabStore.save({
      tabId: 101,
      windowId: 10,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    });
    const tabs = new TabRefreshCoordinator({
      store: tabStore,
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: () => undefined,
    });
    await tabs.initialize();

    const tabLookup = deferred<{ id: number; windowId: number }>();
    let removeTab: ((tabId: number) => void) | undefined;
    const router = createBackgroundRouter({
      expectedDevtoolsUrl: DEVTOOLS_URL,
      expectedPanelUrl: PANEL_URL,
      getTab: async () => tabLookup.promise,
      coordinator: harness.coordinator,
      tabRefreshCoordinator: tabs,
      inspectCoordinator: new BackgroundInspectCoordinator({
        executeScript: async () => undefined,
        sendTabMessage: async () => undefined,
      }),
      subscriptions: {
        subscribeRuntimeMessages() { return () => undefined; },
        subscribeRuntimePorts() { return () => undefined; },
        subscribeWindowRemoved() { return () => undefined; },
        subscribeTabDetached() { return () => undefined; },
        subscribeTabAttached() { return () => undefined; },
        subscribeTabRemoved(listener) {
          removeTab = listener;
          return () => undefined;
        },
      },
    });
    const channels = [
      "terminal-pending-registration-a",
      "terminal-pending-registration-b",
    ];
    const registrations = channels.map((channel, index) =>
      router.routeMessage({
        type: "pin-op.registerDevtools",
        channel,
        tabId: 101,
        sourceId: `terminal-pending-source-${index}`,
      }, { url: DEVTOOLS_URL }));
    const ports = channels.map((channel) => new TestRuntimePort(
      createDevtoolsPanelPortName(channel),
      { url: `${PANEL_URL}?channel=${channel}` },
    ));
    for (const port of ports) {
      router.connectPort(port);
    }
    await flushMicrotasks();

    removeTab?.(101);
    await storage.waitForRemove();
    expect(ports.every((port) => port.disconnected)).toBe(true);

    for (const port of ports) {
      port.disconnect();
    }
    storage.resolveRemove();
    tabLookup.resolve({ id: 101, windowId: 10 });
    await expect(Promise.all(registrations)).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await flushMicrotasks();

    expect(await tabStore.loadAll()).toEqual([]);
    expect(lifecycleRevisionCount(tabs)).toBe(0);
    router.dispose();
  });

  it.each(["absent", "rejected"] as const)(
    "revokes a restored reconnect when panel tab lookup is %s",
    async (lookupFailure) => {
      const storage = new MemorySessionStorage();
      const harness = coordinatorHarness(storage);
      const saved = windowLink();
      await harness.store.save(10, saved);
      const tabStore = new TabRefreshStateStore(storage);
      await tabStore.save({
        tabId: 101,
        windowId: 10,
        autoRefreshEnabled: true,
        ideHighlightEnabled: false,
        participant: true,
        lastAcceptedGeneration: 3,
      });
      const tabs = new TabRefreshCoordinator({
        store: tabStore,
        getActiveTabId: async () => undefined,
        dispatchRefresh: async () => undefined,
        setRefreshParticipant: (windowId, tabId, participant) =>
          harness.coordinator.setRefreshParticipant(
            windowId,
            tabId,
            participant,
          ),
      });
      await tabs.initialize();
      await harness.flush();
      const client = harness.createdClients[0];
      expect(client).toBeDefined();
      client?.emitState("connected");
      client?.emitState("disconnected");
      expect(harness.timers.pendingCount()).toBe(1);

      let lookupCount = 0;
      const revokedTabs: number[] = [];
      const router = createBackgroundRouter({
        expectedDevtoolsUrl: DEVTOOLS_URL,
        expectedPanelUrl: PANEL_URL,
        getTab: async (tabId) => {
          lookupCount += 1;
          if (lookupCount === 1) {
            return { id: tabId, windowId: 10 };
          }
          if (lookupFailure === "rejected") {
            throw new Error("transient browser tab lookup failure");
          }
          return undefined;
        },
        coordinator: harness.coordinator,
        tabRefreshCoordinator: tabs,
        contentRefreshCoordinator: recordingContentRefresh(revokedTabs),
        inspectCoordinator: new BackgroundInspectCoordinator({
          executeScript: async () => undefined,
          sendTabMessage: async () => undefined,
        }),
      });
      const channel = `invalidated-${lookupFailure}`;
      await router.routeMessage({
        type: "pin-op.registerDevtools",
        channel,
        tabId: 101,
        sourceId: `source-${lookupFailure}`,
      }, { url: DEVTOOLS_URL });
      const port = new TestRuntimePort(
        createDevtoolsPanelPortName(channel),
        { url: `${PANEL_URL}?channel=${channel}` },
      );
      router.connectPort(port);
      await flushMicrotasks();
      const connectCount = client?.connectCalls.length ?? 0;

      await expect(router.routeMessage({
        type: "pin-op.unlinkWindow",
        channel,
      }, { url: `${PANEL_URL}?channel=${channel}` })).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });
      await flushMicrotasks();

      expect(revokedTabs).toEqual([101]);
      expect(await tabs.state(101, 10)).toMatchObject({
        autoRefreshEnabled: true,
        ideHighlightEnabled: false,
        participant: false,
        lastAcceptedGeneration: 3,
      });
      expect(harness.timers.pendingCount()).toBe(0);
      expect(client?.connectCalls).toHaveLength(connectCount);
      port.disconnect();
      router.dispose();
    },
  );

  it("retries failed invalid-binding close and recovers it after background restart", async () => {
    const storage = new FailNextTabStateSetStorage();
    const harness = coordinatorHarness(storage);
    const saved = windowLink();
    await harness.store.save(10, saved);
    const tabStore = new TabRefreshStateStore(storage);
    await tabStore.save({
      tabId: 101,
      windowId: 10,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 3,
    });
    const tabs = new TabRefreshCoordinator({
      store: tabStore,
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: (windowId, tabId, participant) =>
        harness.coordinator.setRefreshParticipant(
          windowId,
          tabId,
          participant,
        ),
    });
    await tabs.initialize();
    await harness.flush();
    const panelClosed = vi.spyOn(tabs, "panelClosed");

    let lookupCount = 0;
    let tabExists = true;
    const errors: unknown[] = [];
    const router = createBackgroundRouter({
      expectedDevtoolsUrl: DEVTOOLS_URL,
      expectedPanelUrl: PANEL_URL,
      getTab: async (tabId) => {
        lookupCount += 1;
        return tabExists ? { id: tabId, windowId: 10 } : undefined;
      },
      coordinator: harness.coordinator,
      tabRefreshCoordinator: tabs,
      inspectCoordinator: new BackgroundInspectCoordinator({
        executeScript: async () => undefined,
        sendTabMessage: async () => undefined,
      }),
      onError: (error) => errors.push(error),
    });
    const channel = "failed-invalid-binding-close";
    await router.routeMessage({
      type: "pin-op.registerDevtools",
      channel,
      tabId: 101,
      sourceId: "failed-invalid-binding-source",
    }, { url: DEVTOOLS_URL });
    const port = new TestRuntimePort(
      createDevtoolsPanelPortName(channel),
      { url: `${PANEL_URL}?channel=${channel}` },
    );
    router.connectPort(port);
    await flushMicrotasks();
    expect(await tabStore.loadAll()).toEqual([
      expect.objectContaining({
        tabId: 101,
        windowId: 10,
        participant: true,
      }),
    ]);

    const lookupCountBeforeClose = lookupCount;
    tabExists = false;
    const setCountBeforeClose = storage.setKeys.length;
    storage.failNextTabStateSet();
    await expect(router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel,
    }, { url: `${PANEL_URL}?channel=${channel}` })).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(lookupCount).toBe(lookupCountBeforeClose + 1);
    expect(panelClosed).toHaveBeenCalledWith(101, 10);
    const firstClose = panelClosed.mock.results[0]?.value;
    await expect(firstClose).rejects.toThrow(
      "transient tab state write failure",
    );
    expect(storage.setKeys.slice(setCountBeforeClose)).toContainEqual([
      "pin-op.tabRefreshStates",
    ]);
    expect(storage.failedTabStateSets).toBe(1);
    await vi.waitFor(() => expect(errors).toContainEqual(
      new Error("transient tab state write failure"),
    ));

    const replacementHarness = coordinatorHarness(storage);
    const replacementStore = new TabRefreshStateStore(storage);
    const replacementTabs = new TabRefreshCoordinator({
      store: replacementStore,
      getActiveTabId: async () => undefined,
      dispatchRefresh: async () => undefined,
      setRefreshParticipant: (windowId, tabId, participant) =>
        replacementHarness.coordinator.setRefreshParticipant(
          windowId,
          tabId,
          participant,
        ),
    });
    await replacementTabs.initialize();
    await replacementHarness.flush();

    expect(await replacementTabs.state(101, 10)).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 3,
    });
    expect(replacementHarness.createdClients).toHaveLength(0);

    await expect(router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel,
    }, { url: `${PANEL_URL}?channel=${channel}` })).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();
    expect(lookupCount).toBe(lookupCountBeforeClose + 1);
    expect(panelClosed).toHaveBeenCalledTimes(2);
    router.dispose();
  });

  it("restores a retained participant connection and publishes state without a panel", async () => {
    const harness = coordinatorHarness();
    const saved = windowLink();
    await harness.store.save(10, saved);
    const states: string[] = [];
    const subscription = harness.coordinator.onStateChanged(
      (windowId, state) => states.push(`${windowId}:${state}`),
    );

    harness.coordinator.setRefreshParticipant(10, 101, true);
    await harness.flush();

    expect(harness.createdClients).toHaveLength(1);
    expect(harness.createdClients[0]).toMatchObject({
      url: saved.url,
      connectCalls: [credentialsFor(saved)],
    });
    expect(states).toContain("10:linking");

    harness.createdClients[0].emitState("connected");
    expect(states.at(-1)).toBe("10:linked");
    harness.createdClients[0].emitState("disconnected");
    expect(states.at(-1)).toBe("10:reconnecting");

    subscription.dispose();
  });

  it("forwards refresh and mismatch only from the current retained window client", async () => {
    const harness = coordinatorHarness();
    await harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );
    const panel = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await harness.flush();
    harness.coordinator.setRefreshParticipant(10, 101, true);
    panel.dispose();
    const refreshes: Array<[number, PageRefreshMessage]> = [];
    const mismatches: Array<[number, BrowserProtocolMismatch]> = [];
    harness.coordinator.onPageRefresh((windowId, message) =>
      refreshes.push([windowId, message]),
    );
    harness.coordinator.onProtocolMismatch((windowId, details) =>
      mismatches.push([windowId, details]),
    );

    const client = harness.createdClients[0];
    await harness.authenticate(client, windowLink());
    client.emitPageRefresh(pageRefresh(1));
    client.emitProtocolMismatch({
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });

    expect(refreshes).toEqual([[10, pageRefresh(1)]]);
    expect(mismatches).toEqual([
      [
        10,
        { browserProtocolVersion: PROTOCOL_VERSION, peerProtocolVersion: 5 },
      ],
    ]);
    expect(harness.coordinator.state(10)).toBe("incompatible");
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
    const receivedResolutions: Array<
      [TrustedIdePeerContext, ResolutionMessage]
    > = [];
    const receivedPeerStates: Array<[number, PeerStateMessage]> = [];
    const receivedNavigationStates: Array<
      [TrustedIdePeerContext, SourceNavigationStateMessage]
    > = [];
    const resolutionSubscription = harness.coordinator.onResolution(
      (context, message) => receivedResolutions.push([context, message]),
    );
    const peerSubscription = harness.coordinator.onPeerState(
      (windowId, message) => receivedPeerStates.push([windowId, message]),
    );
    const navigationSubscription = harness.coordinator.onSourceNavigationState(
      (context, message) => receivedNavigationStates.push([context, message]),
    );
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const currentResolution = resolution("inspect-current", 1);
    const currentPeerState = peerState(true, 1);
    const currentNavigationState = sourceNavigationState("inspect-current", 1);
    const trusted = trustedIdePeer();

    client.emitResolution(trusted, currentResolution);
    client.emitPeerState(currentPeerState);
    client.emitSourceNavigationState(trusted, currentNavigationState);

    expect(receivedResolutions).toEqual([[trusted, currentResolution]]);
    expect(receivedPeerStates).toEqual([[10, currentPeerState]]);
    expect(receivedNavigationStates).toEqual([[trusted, currentNavigationState]]);

    await harness.coordinator.unlinkWindow(10);
    client.emitResolution(trusted, resolution("inspect-revoked", 2));
    client.emitPeerState(peerState(false, 2));
    client.emitSourceNavigationState(
      trusted,
      sourceNavigationState("inspect-revoked", 2),
    );
    expect(receivedResolutions).toEqual([[trusted, currentResolution]]);
    expect(receivedPeerStates).toEqual([[10, currentPeerState]]);
    expect(receivedNavigationStates).toEqual([[trusted, currentNavigationState]]);

    resolutionSubscription.dispose();
    peerSubscription.dispose();
    navigationSubscription.dispose();
  });

  it("rejects a routed payload that disagrees with authenticated IDE context", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const received: ResolutionMessage[] = [];
    harness.coordinator.onResolution((_context, message) => received.push(message));
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const trusted = trustedIdePeer();
    const spoofed = {
      ...resolution("inspect-spoofed", 1),
      source: { role: "ide", id: "vscode-b" },
    } as ResolutionMessage;

    client.emitResolution(trusted, spoofed);

    expect(received).toEqual([]);
  });

  it("forwards source matches only from the current trusted window client", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const received: Array<[TrustedIdePeerContext, SourceMatchesMessage]> = [];
    harness.coordinator.onSourceMatches((context, message) =>
      received.push([context, message]),
    );
    const first = await harness.link(10, "4873507");
    await harness.authenticate(first, windowLink());
    const currentContext = trustedIdePeer();
    const currentMessage = sourceMatches("inspect-current", 1);
    const staleCallback = first.captureSourceMatchesListener();

    first.emitSourceMatches(
      createTransportTrustedIdePeerContext(20, "session-a", "vscode-a"),
      currentMessage,
    );
    first.emitSourceMatches(currentContext, {
      ...currentMessage,
      source: { role: "ide", id: "vscode-b" },
    } as SourceMatchesMessage);
    first.emitSourceMatches({
      windowId: 10,
      sessionId: "session-a",
      source: { role: "ide", id: "vscode-a" },
    } as TrustedIdePeerContext, currentMessage);
    expect(received).toEqual([]);

    first.emitSourceMatches(currentContext, currentMessage);
    expect(received).toEqual([[currentContext, currentMessage]]);

    const replacement = await harness.link(10, "4873508");
    await harness.authenticate(replacement, windowLink());
    staleCallback(currentContext, sourceMatches("inspect-stale", 2));
    expect(received).toEqual([[currentContext, currentMessage]]);

    const replacementContext = trustedIdePeer();
    const replacementMessage = sourceMatches("inspect-replacement", 3);
    replacement.emitSourceMatches(replacementContext, replacementMessage);
    expect(received).toEqual([
      [currentContext, currentMessage],
      [replacementContext, replacementMessage],
    ]);
  });

  it("publishes exact source presentation commands only for current IDE authority", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const context = trustedIdePeer();
    client.emitSourceMatches(context, sourceMatches("inspect-current", 1));
    const sourceOpen = {
      inspectMessageId: "inspect-current",
      resolutionGeneration: 1,
      matchId: "match-current",
    };
    const settings = {
      inspectMessageId: "inspect-current",
      ideHighlightEnabled: false,
    };

    expect(harness.coordinator.publishSourceOpen(context, sourceOpen)).toBe(
      "sent",
    );
    expect(
      harness.coordinator.publishPresentationSettings(context, settings),
    ).toBe("sent");
    expect(client.sourceOpenCalls).toEqual([sourceOpen]);
    expect(client.presentationSettingsCalls).toEqual([settings]);

    for (const rejectedContext of [
      trustedIdePeer(),
      createTransportTrustedIdePeerContext(20, "session-a", "vscode-a"),
      createTransportTrustedIdePeerContext(10, "other-session", "vscode-a"),
      createTransportTrustedIdePeerContext(10, "session-a", "vscode-b"),
    ]) {
      expect(
        harness.coordinator.publishSourceOpen(rejectedContext, sourceOpen),
      ).toBe("not-connected");
      expect(
        harness.coordinator.publishPresentationSettings(
          rejectedContext,
          settings,
        ),
      ).toBe("not-connected");
    }

    expect(harness.coordinator.publishSourceOpen(context, {
      ...sourceOpen,
      sessionId: "panel-session",
    } as never)).toBe("invalid-message");
    expect(harness.coordinator.publishPresentationSettings(context, {
      ...settings,
      source: { role: "ide", id: "panel-source" },
    } as never)).toBe("invalid-message");
    const hostile = { ...settings } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "ideHighlightEnabled", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    expect(() =>
      harness.coordinator.publishPresentationSettings(
        context,
        hostile as never,
      )
    ).not.toThrow();
    expect(
      harness.coordinator.publishPresentationSettings(context, hostile as never),
    ).toBe("invalid-message");
    expect(getterCalls).toBe(0);
    expect(client.sourceOpenCalls).toEqual([sourceOpen]);
    expect(client.presentationSettingsCalls).toEqual([settings]);
  });

  it.each([
    {
      name: "source open returns transport-error",
      configure(client: FakeWindowClient): void {
        client.sourceOpenResult = "transport-error";
      },
      publish(
        coordinator: WindowConnectionCoordinator,
        context: TrustedIdePeerContext,
      ): InspectSendOutcome {
        return coordinator.publishSourceOpen(context, {
          inspectMessageId: "inspect-current",
          resolutionGeneration: 1,
          matchId: "match-current",
        });
      },
    },
    {
      name: "source open throws",
      configure(client: FakeWindowClient): void {
        client.throwOnSourceOpen = true;
      },
      publish(
        coordinator: WindowConnectionCoordinator,
        context: TrustedIdePeerContext,
      ): InspectSendOutcome {
        return coordinator.publishSourceOpen(context, {
          inspectMessageId: "inspect-current",
          resolutionGeneration: 1,
          matchId: "match-current",
        });
      },
    },
    {
      name: "presentation settings returns transport-error",
      configure(client: FakeWindowClient): void {
        client.presentationSettingsResult = "transport-error";
      },
      publish(
        coordinator: WindowConnectionCoordinator,
        context: TrustedIdePeerContext,
      ): InspectSendOutcome {
        return coordinator.publishPresentationSettings(context, {
          inspectMessageId: "inspect-current",
          ideHighlightEnabled: false,
        });
      },
    },
    {
      name: "presentation settings throws",
      configure(client: FakeWindowClient): void {
        client.throwOnPresentationSettings = true;
      },
      publish(
        coordinator: WindowConnectionCoordinator,
        context: TrustedIdePeerContext,
      ): InspectSendOutcome {
        return coordinator.publishPresentationSettings(context, {
          inspectMessageId: "inspect-current",
          ideHighlightEnabled: false,
        });
      },
    },
  ])("retires and reconnects when $name", async ({ configure, publish }) => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const peerStates: PeerStateMessage[] = [];
    const refreshes: PageRefreshMessage[] = [];
    const sourceContexts: TrustedIdePeerContext[] = [];
    harness.coordinator.onPeerState((_windowId, message) =>
      peerStates.push(message),
    );
    harness.coordinator.onPageRefresh((_windowId, message) =>
      refreshes.push(message),
    );
    harness.coordinator.onSourceMatches((context) =>
      sourceContexts.push(context),
    );
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const oldContext = trustedIdePeer();
    const staleSourceMatchesCallback = client.captureSourceMatchesListener();
    client.emitSourceMatches(oldContext, sourceMatches("inspect-current", 1));
    client.emitPeerState(peerState(true, 1));
    client.emitPageRefresh(pageRefresh(1));
    configure(client);

    expect(publish(harness.coordinator, oldContext)).toBe("transport-error");

    expect(client.disconnectCalls).toBe(1);
    expect(harness.coordinator.state(10)).toBe("reconnecting");
    expect(harness.timers.pendingCount()).toBe(1);
    client.emitPeerState(peerState(false, 2));
    client.emitPageRefresh(pageRefresh(2));
    expect(peerStates).toEqual([peerState(true, 1)]);
    expect(refreshes).toEqual([pageRefresh(1)]);
    expect(harness.coordinator.publishPresentationSettings(oldContext, {
      inspectMessageId: "inspect-current",
      ideHighlightEnabled: true,
    })).toBe("not-connected");
    expect(client.disconnectCalls).toBe(1);
    expect(harness.timers.pendingCount()).toBe(1);

    harness.timers.runNext();
    expect(client.connectCalls.at(-1)).toEqual(credentialsFor(windowLink()));
    client.emitState("connected");
    expect(harness.coordinator.state(10)).toBe("linked");
    expect(harness.timers.pendingCount()).toBe(0);

    staleSourceMatchesCallback(
      oldContext,
      sourceMatches("inspect-stale", 2),
    );
    expect(sourceContexts).toEqual([oldContext]);
    expect(harness.coordinator.publishSourceOpen(oldContext, {
      inspectMessageId: "inspect-current",
      resolutionGeneration: 1,
      matchId: "match-current",
    })).toBe("not-connected");

    client.sourceOpenResult = "sent";
    client.presentationSettingsResult = "sent";
    client.throwOnSourceOpen = false;
    client.throwOnPresentationSettings = false;
    const newContext = trustedIdePeer();
    client.emitSourceMatches(newContext, sourceMatches("inspect-current", 3));
    expect(sourceContexts).toEqual([oldContext, newContext]);
    expect(harness.coordinator.publishSourceOpen(newContext, {
      inspectMessageId: "inspect-current",
      resolutionGeneration: 3,
      matchId: "match-current",
    })).toBe("sent");
    expect(harness.coordinator.publishPresentationSettings(newContext, {
      inspectMessageId: "inspect-current",
      ideHighlightEnabled: true,
    })).toBe("sent");
  });

  it("revokes source authority across same-client reconnects with identical identity", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const received: TrustedIdePeerContext[] = [];
    harness.coordinator.onSourceMatches((context) => received.push(context));
    const client = await harness.link(10, "4873507");
    await harness.authenticate(client, windowLink());
    const oldContext = trustedIdePeer();
    const currentMessage = sourceMatches("inspect-current", 1);
    client.emitSourceMatches(oldContext, currentMessage);
    const staleCallback = client.captureSourceMatchesListener();
    const settings = {
      inspectMessageId: "inspect-current",
      ideHighlightEnabled: true,
    };
    expect(
      harness.coordinator.publishPresentationSettings(oldContext, settings),
    ).toBe("sent");

    client.emitState("disconnected");
    expect(
      harness.coordinator.publishPresentationSettings(oldContext, settings),
    ).toBe("not-connected");
    harness.timers.runNext();
    client.emitState("connected");
    expect(
      harness.coordinator.publishPresentationSettings(oldContext, settings),
    ).toBe("not-connected");

    staleCallback(oldContext, currentMessage);
    expect(received).toEqual([oldContext]);
    expect(
      harness.coordinator.publishPresentationSettings(oldContext, settings),
    ).toBe("not-connected");

    const newContext = trustedIdePeer();
    client.emitSourceMatches(newContext, sourceMatches("inspect-current", 2));
    expect(received).toEqual([oldContext, newContext]);
    expect(
      harness.coordinator.publishPresentationSettings(newContext, settings),
    ).toBe("sent");
    expect(client.presentationSettingsCalls).toEqual([settings, settings]);
  });

  it.each(["unlink", "dispose"] as const)(
    "revokes source presentation callbacks and sends after %s",
    async (operation) => {
      const harness = coordinatorHarness();
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });
      const received: SourceMatchesMessage[] = [];
      harness.coordinator.onSourceMatches((_context, message) =>
        received.push(message),
      );
      const client = await harness.link(10, "4873507");
      await harness.authenticate(client, windowLink());
      const context = trustedIdePeer();
      const current = sourceMatches("inspect-current", 1);
      client.emitSourceMatches(context, current);
      const staleCallback = client.captureSourceMatchesListener();

      if (operation === "unlink") {
        await harness.coordinator.unlinkWindow(10);
      } else {
        harness.coordinator.dispose();
      }
      staleCallback(context, sourceMatches("inspect-stale", 2));

      expect(received).toEqual([current]);
      expect(harness.coordinator.publishSourceOpen(context, {
        inspectMessageId: "inspect-current",
        resolutionGeneration: 1,
        matchId: "match-current",
      })).toBe("not-connected");
      expect(client.sourceOpenCalls).toEqual([]);
    },
  );

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
    storage.resolveGet({ "pin-op.windowLink.10": windowLink() });
    await unlinking;
    await harness.flush();

    expect(harness.createdClients).toHaveLength(0);
    expect(storage.values).not.toHaveProperty("pin-op.windowLink.10");
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
    storage.resolveGet({ "pin-op.windowLink.10": windowLink() });
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
  public readonly sourceOpenCalls: Array<
    Pick<
      SourceOpenMessage,
      "inspectMessageId" | "resolutionGeneration" | "matchId"
    >
  > = [];
  public readonly presentationSettingsCalls: Array<
    Pick<
      PresentationSettingsMessage,
      "inspectMessageId" | "ideHighlightEnabled"
    >
  > = [];
  public disconnectCalls = 0;
  public unlinkCalls = 0;
  public inspectResult: InspectSendOutcome = "sent";
  public sourceNavigationResult: SourceNavigationSendOutcome = "sent";
  public sourceOpenResult: InspectSendOutcome = "sent";
  public presentationSettingsResult: InspectSendOutcome = "sent";
  public throwOnSourceNavigation = false;
  public throwOnSourceOpen = false;
  public throwOnPresentationSettings = false;
  public throwOnPeerStateSubscription = false;
  private readonly resolutionListeners = new Set<
    (context: TrustedIdePeerContext, message: ResolutionMessage) => void
  >();
  private readonly peerStateListeners = new Set<
    (message: PeerStateMessage) => void
  >();
  private readonly sourceNavigationStateListeners = new Set<
    (
      context: TrustedIdePeerContext,
      message: SourceNavigationStateMessage,
    ) => void
  >();
  private readonly sourceMatchesListeners = new Set<
    (
      context: TrustedIdePeerContext,
      message: SourceMatchesMessage,
    ) => void
  >();
  private readonly pageRefreshListeners = new Set<
    (message: PageRefreshMessage) => void
  >();
  private readonly protocolMismatchListeners = new Set<
    (details: BrowserProtocolMismatch) => void
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
    this.emitState("disconnected");
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

  public sendSourceOpen(
    input: Pick<
      SourceOpenMessage,
      "inspectMessageId" | "resolutionGeneration" | "matchId"
    >,
  ): InspectSendOutcome {
    this.sourceOpenCalls.push({ ...input });
    if (this.throwOnSourceOpen) {
      throw new Error("source open send failed");
    }
    return this.sourceOpenResult;
  }

  public sendPresentationSettings(
    input: Pick<
      PresentationSettingsMessage,
      "inspectMessageId" | "ideHighlightEnabled"
    >,
  ): InspectSendOutcome {
    this.presentationSettingsCalls.push({ ...input });
    if (this.throwOnPresentationSettings) {
      throw new Error("presentation settings send failed");
    }
    return this.presentationSettingsResult;
  }

  public onResolution(
    listener: (
      context: TrustedIdePeerContext,
      message: ResolutionMessage,
    ) => void,
  ) {
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
    listener: (
      context: TrustedIdePeerContext,
      message: SourceNavigationStateMessage,
    ) => void,
  ) {
    this.sourceNavigationStateListeners.add(listener);
    return {
      dispose: () => this.sourceNavigationStateListeners.delete(listener),
    };
  }

  public onPageRefresh(listener: (message: PageRefreshMessage) => void) {
    this.pageRefreshListeners.add(listener);
    return {
      dispose: () => this.pageRefreshListeners.delete(listener),
    };
  }

  public onSourceMatches(
    listener: (
      context: TrustedIdePeerContext,
      message: SourceMatchesMessage,
    ) => void,
  ) {
    this.sourceMatchesListeners.add(listener);
    return {
      dispose: () => this.sourceMatchesListeners.delete(listener),
    };
  }

  public onProtocolMismatch(
    listener: (details: BrowserProtocolMismatch) => void,
  ) {
    this.protocolMismatchListeners.add(listener);
    return {
      dispose: () => this.protocolMismatchListeners.delete(listener),
    };
  }

  public emitResolution(
    context: TrustedIdePeerContext,
    message: ResolutionMessage,
  ): void {
    for (const listener of this.resolutionListeners) {
      listener(context, message);
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

  public emitSourceNavigationState(
    context: TrustedIdePeerContext,
    message: SourceNavigationStateMessage,
  ): void {
    for (const listener of this.sourceNavigationStateListeners) {
      listener(context, message);
    }
  }

  public emitPageRefresh(message: PageRefreshMessage): void {
    for (const listener of this.pageRefreshListeners) {
      listener(message);
    }
  }

  public emitSourceMatches(
    context: TrustedIdePeerContext,
    message: SourceMatchesMessage,
  ): void {
    for (const listener of this.sourceMatchesListeners) {
      listener(context, message);
    }
  }

  public captureSourceMatchesListener(): (
    context: TrustedIdePeerContext,
    message: SourceMatchesMessage,
  ) => void {
    const listener = this.sourceMatchesListeners.values().next().value as
      | ((
        context: TrustedIdePeerContext,
        message: SourceMatchesMessage,
      ) => void)
      | undefined;
    if (!listener) {
      throw new Error("Expected a source matches listener");
    }
    return listener;
  }

  public emitProtocolMismatch(details: BrowserProtocolMismatch): void {
    for (const listener of this.protocolMismatchListeners) {
      listener(details);
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

class TestRuntimePort implements BackgroundRuntimePort {
  public readonly onMessage = new TestRuntimeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new TestRuntimeEvent<() => void>();
  public disconnected = false;

  public constructor(
    public readonly name: string,
    public readonly sender: BackgroundMessageSender,
  ) {}

  public postMessage(_message: unknown): void {
    if (this.disconnected) {
      throw new Error("Port is disconnected");
    }
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

class TestRuntimeEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
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

class FailNextTabStateSetStorage extends MemorySessionStorage {
  public failedTabStateSets = 0;
  public readonly setKeys: string[][] = [];
  private failTabStateSet = false;

  public failNextTabStateSet(): void {
    this.failTabStateSet = true;
  }

  public override async set(values: Record<string, unknown>): Promise<void> {
    this.setKeys.push(Object.keys(values));
    if (
      this.failTabStateSet &&
      Object.hasOwn(values, "pin-op.tabRefreshStates")
    ) {
      this.failTabStateSet = false;
      this.failedTabStateSets += 1;
      throw new Error("transient tab state write failure");
    }
    await super.set(values);
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

function recordingContentRefresh(
  revokedTabs: number[],
): BackgroundContentRefreshRuntime {
  return {
    async dispatch() {},
    async routeMessage() { return undefined; },
    observeTabUpdate() {},
    async tabUpdated() {},
    setTabParticipation() {},
    setWindowEligibility() {},
    revokeTab(tabId) { revokedTabs.push(tabId); },
    revokeWindow() {},
    async removeTab() {},
    async detachTab() {},
    dispose() {},
  };
}

function trustedIdePeer(): TrustedIdePeerContext {
  return createTransportTrustedIdePeerContext(10, "session-a", "vscode-a");
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

function lifecycleRevisionCount(coordinator: TabRefreshCoordinator): number {
  return (coordinator as unknown as {
    readonly lifecycleRevisions: ReadonlyMap<number, number>;
  }).lifecycleRevisions.size;
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
    ideHighlightEnabled: true,
    metadata: {},
  };
}

function sourceMatches(
  inspectMessageId: string,
  resolutionGeneration: number,
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `source-matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    matches: [{
      matchId: "match-current",
      targetRole: "selected",
      label: "card.scss:1",
      kind: "rule",
      relation: "selected",
      confidence: "exact",
      startLine: 1,
      endLine: 3,
      text: ".card {\n  color: red;\n}",
      truncated: false,
    }],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function pageRefresh(refreshGeneration: number): PageRefreshMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: `refresh-${refreshGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    refreshGeneration,
    mode: "styles",
    metadata: {},
  };
}
