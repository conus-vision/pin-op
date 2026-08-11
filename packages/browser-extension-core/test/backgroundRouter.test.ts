import {
  PROTOCOL_VERSION,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserProtocolError,
  type InspectPayload,
  type InspectSendOutcome,
  type SourceNavigationSendOutcome,
} from "../src/bridgeClient.js";
import {
  BackgroundInspectCoordinator,
} from "../src/backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundMessageSender,
  type BackgroundRouterSubscriptions,
  type BackgroundRuntimePort,
} from "../src/backgroundRouter.js";
import {
  createDevtoolsPanelPortName,
  createInspectContentLeasePortName,
} from "../src/inspectPortProtocol.js";
import { PanelSessionTransport } from "../src/panelSessionTransport.js";
import type {
  BrowserWindowConnectionState,
  PanelRegistration,
} from "../src/windowConnectionCoordinator.js";

const DEVTOOLS_URL = "moz-extension://browser2ide/dist/devtools.html";
const PANEL_URL = "moz-extension://browser2ide/dist/panel.html";
const DEFAULT_CONTENT_SESSION_ID = "content-session-default";

describe("BackgroundRouter", () => {
  it("accepts registration only from the exact injected DevTools URL", async () => {
    const harness = createHarness();
    const registration = registerMessage("channel-1", 17, "source-17");

    expect(await harness.router.routeMessage(registration, {})).toBeUndefined();
    expect(
      await harness.router.routeMessage(registration, {
        url: `${DEVTOOLS_URL}?panel=true`,
      }),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...registration, windowId: 999 },
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(harness.getTabCalls).toEqual([]);

    expect(
      await harness.router.routeMessage(registration, devtoolsSender()),
    ).toEqual({ ok: true });
    expect(harness.getTabCalls).toEqual([17]);

    const absentUrlHarness = createHarness({ expectedDevtoolsUrl: undefined });
    expect(
      await absentUrlHarness.router.routeMessage(
        registration,
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(absentUrlHarness.getTabCalls).toEqual([]);
  });

  it("derives the window, keeps exact re-registration idempotent, and posts state", async () => {
    const harness = createHarness({ initialPanelState: "notLinked" });
    const registration = registerMessage("channel-1", 17, "source-17");

    await harness.router.routeMessage(registration, devtoolsSender());
    const port = harness.panelPort("channel-1");
    harness.router.connectPort(port);
    await harness.router.routeMessage(registration, devtoolsSender());

    expect(harness.coordinator.registrations).toHaveLength(1);
    expect(harness.coordinator.registrations[0]).toMatchObject({
      windowId: 10,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(port.sent).toEqual([
      {
        type: "browser2ide.windowState",
        state: "notLinked",
      },
    ]);
  });

  it("forwards the session display code only with a linked window state", async () => {
    const harness = createHarness({ initialPanelState: "notLinked" });
    const registration = registerMessage("channel-1", 17, "source-17");
    await harness.router.routeMessage(registration, devtoolsSender());
    const port = harness.panelPort("channel-1");
    harness.router.connectPort(port);

    harness.coordinator.registrations[0]?.onStateChanged?.(
      "linked",
      "48735 07",
    );
    await flushMicrotasks();

    expect(port.sent.at(-1)).toEqual({
      type: "browser2ide.windowState",
      state: "linked",
      displayLinkCode: "48735 07",
    });
  });

  it("coalesces concurrent exact re-announcements", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let getTabCalls = 0;
    const harness = createHarness({
      getTab: async () => {
        getTabCalls += 1;
        return tabLookup.promise;
      },
    });
    const registration = registerMessage("channel-1", 17, "source-17");

    const first = harness.router.routeMessage(registration, devtoolsSender());
    const second = harness.router.routeMessage(registration, devtoolsSender());
    expect(getTabCalls).toBe(1);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    harness.router.connectPort(harness.panelPort("channel-1"));
    expect(harness.coordinator.registrations).toHaveLength(1);
  });

  it("invalidates unresolved registrations across window removal", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({
      getTab: async () => tabLookup.promise,
    });
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );

    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(registration).resolves.toBeUndefined();
    harness.router.connectPort(harness.panelPort("channel-1"));
    expect(harness.coordinator.registrations).toEqual([]);
  });

  it("allows an unresolved registration in another window to complete", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({
      getTab: async (tabId) =>
        tabId === 18 ? tabLookup.promise : { id: tabId, windowId: 10 },
    });
    const windowAPort = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const registration = harness.router.routeMessage(
      registerMessage("channel-b", 18, "source-b"),
      devtoolsSender(),
    );

    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 18, windowId: 20 });

    await expect(registration).resolves.toEqual({ ok: true });
    const windowBPort = harness.panelPort("channel-b");
    harness.router.connectPort(windowBPort);
    expect(windowAPort.disconnected).toBe(true);
    expect(windowBPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual(["source-b"]);
  });

  it("binds a valid panel port that arrives before registration", async () => {
    const harness = createHarness();
    const port = harness.panelPort("channel-1");

    harness.router.connectPort(port);
    expect(port.disconnected).toBe(false);
    expect(harness.coordinator.registrations).toEqual([]);

    await harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );

    expect(harness.coordinator.registrations).toHaveLength(1);
    expect(harness.coordinator.registrations[0]).toMatchObject({
      windowId: 10,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("bounds pending ports and disconnects malformed, duplicate, and overflow ports", () => {
    const harness = createHarness({ maxPanelPorts: 2 });
    const malformed = harness.port("browser2ide.devtools.bad/channel");
    const wrongPage = harness.panelPort("wrong-page", {
      url: "moz-extension://browser2ide/dist/other.html?channel=wrong-page",
    });
    const first = harness.panelPort("first");
    const duplicate = harness.panelPort("first");
    const second = harness.panelPort("second");
    const overflow = harness.panelPort("third");

    harness.router.connectPort(malformed);
    harness.router.connectPort(wrongPage);
    harness.router.connectPort(first);
    harness.router.connectPort(duplicate);
    harness.router.connectPort(second);
    harness.router.connectPort(overflow);

    expect(malformed.disconnected).toBe(true);
    expect(wrongPage.disconnected).toBe(true);
    expect(first.disconnected).toBe(false);
    expect(duplicate.disconnected).toBe(true);
    expect(second.disconnected).toBe(false);
    expect(overflow.disconnected).toBe(true);
  });

  it.each(["before", "after"] as const)(
    "atomically supersedes a live same-tab channel when the new port arrives %s the announcement",
    async (portOrder) => {
      const harness = createHarness();
      const oldPort = await harness.registerAndConnect(
        "old-channel",
        17,
        "old-source",
      );
      const delayedOldDisconnect = oldPort.queueDisconnect();
      const newPort = harness.panelPort("new-channel");
      if (portOrder === "before") {
        harness.router.connectPort(newPort);
      }

      const result = await harness.router.routeMessage(
        registerMessage("new-channel", 17, "new-source"),
        devtoolsSender(),
      );
      if (portOrder === "after") {
        harness.router.connectPort(newPort);
      }

      expect(result).toEqual({ ok: true });
      expect(oldPort.disconnected).toBe(true);
      expect(newPort.disconnected).toBe(false);
      expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
      expect(harness.coordinator.registrations).toHaveLength(2);
      expect(harness.coordinator.disposeCalls).toBe(1);

      delayedOldDisconnect();

      expect(newPort.disconnected).toBe(false);
      expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
      expect(harness.coordinator.disposeCalls).toBe(1);
    },
  );

  it("does not let an older re-announcement reclaim a superseded tab", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    let deferNextLookup = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (deferNextLookup) {
          deferNextLookup = false;
          return staleLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    await harness.registerAndConnect("old-channel", 17, "old-source");
    deferNextLookup = true;
    const staleAnnouncement = harness.router.routeMessage(
      registerMessage("old-channel", 17, "old-source"),
      devtoolsSender(),
    );
    const newPort = harness.panelPort("new-channel");
    harness.router.connectPort(newPort);

    await expect(
      harness.router.routeMessage(
        registerMessage("new-channel", 17, "new-source"),
        devtoolsSender(),
      ),
    ).resolves.toEqual({ ok: true });
    staleLookup.resolve({ id: 17, windowId: 10 });

    await expect(staleAnnouncement).resolves.toBeUndefined();
    expect(newPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
    expect(harness.coordinator.disposeCalls).toBe(1);
  });

  it("does not roll a moved tab back when lookups resolve 10, 20, then 10", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    let lookup = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookup += 1;
        if (lookup <= 2) {
          return { id: tabId, windowId: 10 };
        }
        if (lookup === 3) {
          return staleLookup.promise;
        }
        return { id: tabId, windowId: 20 };
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    const staleAnnouncement = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await expect(
      harness.router.routeMessage(
        selectedMessage(DEFAULT_CONTENT_SESSION_ID),
        contentSender(17, 20),
      ),
    ).resolves.toBeUndefined();
    await harness.attachContentSession(17, "content-session-moved");
    await expect(
      harness.router.routeMessage(
        selectedMessage("content-session-moved"),
        contentSender(17, 20),
      ),
    ).resolves.toEqual({ ok: true });
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });

    staleLookup.resolve({ id: 17, windowId: 10 });
    await expect(staleAnnouncement).resolves.toEqual({ ok: true });

    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(port.disconnected).toBe(false);
  });

  it("refreshes a recovered panel through its pending registration before activation", async () => {
    const movedLookup = deferred<{ id: number; windowId: number }>();
    let lookup = 0;
    const harness = createHarness({
      initialPanelState: "notLinked",
      getTab: async (tabId) => {
        lookup += 1;
        return lookup === 1
          ? { id: tabId, windowId: 10 }
          : movedLookup.promise;
      },
    });
    const oldPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const oldRegistration = harness.coordinator.registrations[0];
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await flushMicrotasks();

    oldPort.disconnect();
    const recoveredPort = harness.panelPort("channel-1");
    harness.router.connectPort(recoveredPort);

    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([10]);
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(recoveredPort.sent).toEqual([]);

    movedLookup.resolve({ id: 17, windowId: 20 });
    await expect(registration).resolves.toEqual({ ok: true });

    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([10, 20]);
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(recoveredPort.sent).toEqual([
      {
        type: "browser2ide.windowState",
        state: "notLinked",
      },
    ]);

    oldRegistration?.onStateChanged?.("linked");
    expect(recoveredPort.sent).toHaveLength(1);
  });

  it("uses attach as the authority when initial registration lookup returns stale A", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    const events = createRouterSubscriptionHarness();
    let lookup = 0;
    const harness = createHarness({
      subscriptions: events.subscriptions,
      getTab: async (tabId) => {
        lookup += 1;
        return lookup === 1
          ? staleLookup.promise
          : { id: tabId, windowId: 20 };
      },
    });
    const port = harness.panelPort("channel-1");
    harness.router.connectPort(port);
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await flushMicrotasks();

    events.detach(17, 10);
    events.attach(17, 20);
    staleLookup.resolve({ id: 17, windowId: 10 });

    await expect(registration).resolves.toEqual({ ok: true });
    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([20]);
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(port.disconnected).toBe(false);
  });

  it("rejects conflicting channel tuples and cross-tab source hijacks", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    await harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    const first = harness.panelPort("channel-1");
    harness.router.connectPort(first);
    const delayedDisconnect = first.queueDisconnect();
    await harness.registerAndConnect("channel-2", 18, "source-18");

    expect(
      await harness.router.routeMessage(
        registerMessage("channel-1", 18, "spoofed-source"),
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        registerMessage("hijack-channel", 17, "source-18"),
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(harness.coordinator.activeSources()).toEqual([
      "source-17",
      "source-18",
    ]);

    first.disconnect();
    const recovered = harness.panelPort("channel-1");
    harness.router.connectPort(recovered);
    delayedDisconnect();

    expect(harness.coordinator.activeSources()).toEqual([
      "source-17",
      "source-18",
    ]);
    expect(harness.coordinator.registrations).toHaveLength(3);
    expect(harness.coordinator.disposeCalls).toBe(1);
  });

  it("publishes a validated payload only for the sender tab's active source", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.registerAndConnect("channel-2", 18, "source-18");
    await harness.attachContentSession(17);
    const payloadWithDiagnostics = {
      ...inspectPayload(),
      inaccessibleStylesheets: [{ sourceUrl: "x", reason: "denied" }],
      panelTabId: 18,
    };

    expect(
      await harness.router.routeMessage(
        selectedMessage(DEFAULT_CONTENT_SESSION_ID, payloadWithDiagnostics),
        contentSender(17, 10),
      ),
    ).toEqual({ ok: true });

    expect(harness.coordinator.published).toEqual([
      {
        windowId: 10,
        inspectMessageId: "inspect-1",
        sourceId: "source-17",
        payload: inspectPayload(),
      },
    ]);
    expect(harness.coordinator.published[0]?.payload).not.toHaveProperty(
      "inspectMessageId",
    );
    expect(harness.coordinator.published[0]?.payload).not.toHaveProperty(
      "nodeRef",
    );
  });

  it("posts the exact local inspect start before publishing over WebSocket", async () => {
    let panel!: FakePort;
    let localMessagesAtPublish: unknown[] = [];
    const harness = createHarness({
      publishInspect() {
        localMessagesAtPublish = [...panel.sent];
        return "sent";
      },
    });
    panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );

    expect(localMessagesAtPublish).toContainEqual({
      type: "browser2ide.inspect.started",
      inspectMessageId: "inspect-1",
      selectionRevision: 1,
    });
    expect(harness.coordinator.published[0]).toEqual({
      windowId: 10,
      inspectMessageId: "inspect-1",
      sourceId: "source-17",
      payload: inspectPayload(),
    });
  });

  it("requires a bounded selection revision before starting an inspect", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    await expect(harness.router.routeMessage(
      selectedMessageWithRevision(DEFAULT_CONTENT_SESSION_ID, 4),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });
    for (const selectionRevision of [
      "4",
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(harness.router.routeMessage(
        selectedMessageWithRevision(
          DEFAULT_CONTENT_SESSION_ID,
          selectionRevision,
        ),
        contentSender(17, 10),
      )).resolves.toBeUndefined();
    }

    expect(messagesOfType(panel, "browser2ide.inspect.started")).toEqual([{
      type: "browser2ide.inspect.started",
      inspectMessageId: "inspect-1",
      selectionRevision: 4,
    }]);
    expect(harness.coordinator.published).toHaveLength(1);
  });

  it("records correlation before send and removes it after send failure", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    harness.coordinator.onPublish = ({ inspectMessageId }) => {
      harness.resolutions.emit(resolution(inspectMessageId, 1));
    };

    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    expect(messagesOfType(panel, "resolution")).toEqual([
      resolution("inspect-1", 1),
    ]);

    harness.coordinator.onPublish = undefined;
    harness.coordinator.publishOutcome = "not-connected";
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-2", 1));

    expect(messagesOfType(panel, "resolution")).toHaveLength(1);
    expect(panel.sent.filter((message) =>
      isRecord(message) &&
      (message.type === "browser2ide.inspect.started" ||
        message.type === "browser2ide.ideState")
    )).toEqual([
      {
        type: "browser2ide.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 1,
      },
      {
        type: "browser2ide.inspect.started",
        inspectMessageId: "inspect-2",
        selectionRevision: 1,
      },
      {
        type: "browser2ide.ideState",
        status: "ide-disconnected",
        inspectMessageId: "inspect-2",
      },
    ]);
    expect(messagesOfType(panel, "browser2ide.ideState")).toEqual([
      {
        type: "browser2ide.ideState",
        status: "ide-disconnected",
        inspectMessageId: "inspect-2",
      },
    ]);
  });

  it("supersedes rapid local inspect starts and rejects the stale resolution", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 9));
    harness.resolutions.emit(resolution("inspect-2", 1));

    expect(messagesOfType(panel, "browser2ide.inspect.started")).toEqual([
      {
        type: "browser2ide.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 1,
      },
      {
        type: "browser2ide.inspect.started",
        inspectMessageId: "inspect-2",
        selectionRevision: 1,
      },
    ]);
    expect(messagesOfType(panel, "resolution")).toEqual([
      resolution("inspect-2", 1),
    ]);
  });

  it("rejects delayed selection and DOM events from a retired content document", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    const firstSessionId = "content-session-a";
    const firstLease = harness.port(
      createInspectContentLeasePortName(firstSessionId),
      contentSender(17, 10),
    );
    harness.router.connectPort(firstLease);
    const firstEvent = selectionChangedWithRevision("node-a", 20);

    await expect(harness.router.routeMessage(
      selectedMessageWithRevision(firstSessionId, 20),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });
    await expect(harness.router.routeMessage(
      domEventMessage(firstSessionId, firstEvent),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });

    firstLease.disconnect();
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    const secondSessionId = "content-session-b";
    const secondLease = harness.port(
      createInspectContentLeasePortName(secondSessionId),
      contentSender(17, 10),
    );
    harness.router.connectPort(secondLease);
    const secondEvent = selectionChangedWithRevision("node-b", 1);

    await expect(harness.router.routeMessage(
      selectedMessageWithRevision(firstSessionId, 21),
      contentSender(17, 10),
    )).resolves.toBeUndefined();
    await expect(harness.router.routeMessage(
      domEventMessage(firstSessionId, firstEvent),
      contentSender(17, 10),
    )).resolves.toBeUndefined();
    await expect(harness.router.routeMessage(
      selectedMessageWithRevision(secondSessionId, 1),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });
    await expect(harness.router.routeMessage(
      domEventMessage(secondSessionId, secondEvent),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });

    expect(harness.coordinator.published.map(({ inspectMessageId }) =>
      inspectMessageId
    )).toEqual(["inspect-1", "inspect-2"]);
    expect(messagesOfType(panel, "dom.selectionChanged")).toEqual([
      firstEvent,
      secondEvent,
    ]);
  });

  it("removes correlation when inspect publication throws", async () => {
    const harness = createHarness({
      publishInspect() {
        throw new Error("unexpected transport failure");
      },
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    await expect(harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    )).resolves.toEqual({ ok: true });
    harness.resolutions.emit(resolution("inspect-1", 1));

    expect(messagesOfType(panel, "resolution")).toEqual([]);
    expect(messagesOfType(panel, "browser2ide.ideState")).toEqual([
      {
        type: "browser2ide.ideState",
        status: "ide-disconnected",
        inspectMessageId: "inspect-1",
      },
    ]);
    expect(harness.reportedErrors).toHaveLength(1);
  });

  it("routes increasing resolution generations only to the originating panel", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 10],
      ]),
    });
    const panelA = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );

    harness.resolutions.emit(resolution("inspect-1", 2));
    harness.resolutions.emit(resolution("inspect-1", 1));

    expect(messagesOfType(panelA, "resolution")).toEqual([
      resolution("inspect-1", 2),
    ]);
    expect(messagesOfType(panelB, "resolution")).toEqual([]);
  });

  it("forwards repeated strict source navigation for the current correlation without DOM work", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));
    harness.inspectCalls.length = 0;
    const navigation = panelSourceNavigation("previous");

    panel.emitMessage(navigation);
    panel.emitMessage(panelSourceNavigation("next"));
    panel.emitMessage({ ...navigation, sessionId: "panel-session" });
    panel.emitMessage({ ...navigation, messageId: "panel-message" });
    panel.emitMessage({ ...navigation, direction: "first" });
    await flushMicrotasks();

    expect(harness.coordinator.sourceNavigations).toEqual([
      {
        windowId: 10,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 2,
          direction: "previous",
        },
      },
      {
        windowId: 10,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 2,
          direction: "next",
        },
      },
    ]);
    expect(harness.inspectCalls).toEqual([]);
  });

  it("rejects unknown, stale-generation, and cross-channel source navigation", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    const panelA = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));

    panelA.emitMessage(panelSourceNavigation("next", "inspect-missing", 2));
    panelA.emitMessage(panelSourceNavigation("next", "inspect-1", 1));
    panelB.emitMessage(panelSourceNavigation("next", "inspect-1", 2));
    await flushMicrotasks();

    expect(harness.coordinator.sourceNavigations).toEqual([]);
  });

  it("rejects source navigation when its tab silently moves windows", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));

    tabs.set(17, 20);
    panel.emitMessage(panelSourceNavigation("next"));
    await flushMicrotasks();

    expect(harness.coordinator.sourceNavigations).toEqual([]);
  });

  it("rejects source navigation from a stale panel activation", async () => {
    const harness = createHarness();
    const first = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const staleListener = first.onMessage.snapshot()[0];
    expect(staleListener).toBeDefined();

    first.disconnect();
    const replacement = harness.panelPort("channel-1");
    harness.router.connectPort(replacement);
    const replacementSessionId = "content-session-replacement";
    await harness.attachContentSession(17, replacementSessionId);
    await harness.router.routeMessage(
      selectedMessage(replacementSessionId),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));

    staleListener?.(panelSourceNavigation("previous"));
    replacement.emitMessage(panelSourceNavigation("next"));
    await flushMicrotasks();

    expect(harness.coordinator.sourceNavigations).toEqual([{
      windowId: 10,
      input: {
        inspectMessageId: "inspect-1",
        resolutionGeneration: 2,
        direction: "next",
      },
    }]);
  });

  it("routes repeated navigation state only to its correlated panel channel", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    const panelA = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));
    const first = sourceNavigationState("inspect-1", 2, 0);
    const second = sourceNavigationState("inspect-1", 2, 1);

    harness.sourceNavigationStates.emit(20, first);
    harness.sourceNavigationStates.emit(10, first);
    harness.sourceNavigationStates.emit(10, second);
    harness.sourceNavigationStates.emit(
      10,
      sourceNavigationState("inspect-1", 1),
    );
    harness.sourceNavigationStates.emit(
      10,
      sourceNavigationState("inspect-missing", 2),
    );

    expect(messagesOfType(panelA, "source.navigationState")).toEqual([
      first,
      second,
    ]);
    expect(messagesOfType(panelB, "source.navigationState")).toEqual([]);
  });

  it.each<SourceNavigationSendOutcome>([
    "not-connected",
    "invalid-message",
    "transport-error",
  ])("fails closed when source navigation returns %s", async (outcome) => {
    const harness = createHarness({
      publishSourceNavigation: () => outcome,
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));

    panel.emitMessage(panelSourceNavigation("next"));
    await flushMicrotasks();
    harness.sourceNavigationStates.emit(
      10,
      sourceNavigationState("inspect-1", 2, 0),
    );

    expect(messagesOfType(panel, "browser2ide.ideState")).toEqual([{
      type: "browser2ide.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-1",
    }]);
    expect(messagesOfType(panel, "source.navigationState")).toEqual([]);
  });

  it("fails closed and reports a thrown source navigation send", async () => {
    const harness = createHarness({
      publishSourceNavigation() {
        throw new Error("unexpected source navigation failure");
      },
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.resolutions.emit(resolution("inspect-1", 2));

    panel.emitMessage(panelSourceNavigation("previous"));
    await flushMicrotasks();
    harness.sourceNavigationStates.emit(
      10,
      sourceNavigationState("inspect-1", 2, 0),
    );

    expect(messagesOfType(panel, "browser2ide.ideState")).toEqual([{
      type: "browser2ide.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-1",
    }]);
    expect(messagesOfType(panel, "source.navigationState")).toEqual([]);
    expect(harness.reportedErrors).toHaveLength(1);
  });

  it("rejects stale peer state and republishes selection after IDE reconnect", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    harness.peerStates.emit(10, peerState(false, 3));
    harness.peerStates.emit(10, peerState(true, 4));
    harness.peerStates.emit(10, peerState(false, 2));
    await flushMicrotasks();

    expect(messagesOfType(panel, "peerState")).toEqual([
      peerState(false, 3),
      peerState(true, 4),
    ]);
    expect(harness.inspectCalls).toContainEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.republish" },
    ]);
  });

  it("republishes for the first connected peer snapshot", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    harness.inspectCalls.length = 0;

    harness.peerStates.emit(10, peerState(true, 1));
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(1);
  });

  it("republishes for a new connected peer session", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    harness.inspectCalls.length = 0;

    harness.peerStates.emit(10, peerState(true, 1, "session-a"));
    await flushMicrotasks();
    const firstSessionCalls = republishCallCount(harness.inspectCalls);

    harness.peerStates.emit(10, peerState(true, 1, "session-b"));
    await flushMicrotasks();

    expect(firstSessionCalls).toBe(1);
    expect(republishCallCount(harness.inspectCalls)).toBe(2);
  });

  it("defers browser reconnect republish while the IDE peer is disconnected", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    harness.inspectCalls.length = 0;
    const registration = harness.coordinator.registrations[0];

    harness.peerStates.emit(10, peerState(false, 1));
    registration?.onStateChanged?.("offline");
    registration?.onStateChanged?.("reconnecting");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(0);

    harness.peerStates.emit(10, peerState(true, 2));
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(1);
  });

  it("defers IDE reconnect republish while the browser bridge is offline", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    harness.inspectCalls.length = 0;
    const registration = harness.coordinator.registrations[0];

    harness.peerStates.emit(10, peerState(false, 1));
    registration?.onStateChanged?.("offline");
    await flushMicrotasks();
    harness.peerStates.emit(10, peerState(true, 2));
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(0);

    registration?.onStateChanged?.("linked");
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(1);
  });

  it("dedupes a later initial peer signal after browser republish completed", async () => {
    let harness!: ReturnType<typeof createHarness>;
    const republishFinished = deferred<void>();
    harness = createHarness({
      sendTabMessage: async (tabId, message) => {
        if (
          isRecord(message) &&
          message.type === "browser2ide.inspect.republish"
        ) {
          await harness.router.routeMessage(
            selectedMessage(DEFAULT_CONTENT_SESSION_ID),
            contentSender(tabId, 10),
          );
          republishFinished.resolve();
          return true;
        }
        return undefined;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.inspectCalls.length = 0;
    const registration = harness.coordinator.registrations[0];

    registration?.onStateChanged?.("offline");
    registration?.onStateChanged?.("reconnecting");
    registration?.onStateChanged?.("linked");
    await republishFinished.promise;
    expect(republishCallCount(harness.inspectCalls)).toBe(1);
    expect(harness.coordinator.published).toHaveLength(2);

    harness.peerStates.emit(10, peerState(true, 1));
    await flushMicrotasks();

    expect(republishCallCount(harness.inspectCalls)).toBe(1);
    expect(harness.coordinator.published.map(({ inspectMessageId }) =>
      inspectMessageId
    )).toEqual(["inspect-1", "inspect-2"]);
  });

  it("republishes reconnect selection with a new current inspect ID", async () => {
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      sendTabMessage: async (tabId, message) => {
        if (
          isRecord(message) &&
          message.type === "browser2ide.inspect.republish"
        ) {
          await harness.router.routeMessage(
            selectedMessage(DEFAULT_CONTENT_SESSION_ID),
            contentSender(tabId, 10),
          );
          return true;
        }
        return undefined;
      },
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await harness.attachContentSession(17);

    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    const firstId = harness.coordinator.published[0]?.inspectMessageId;

    harness.peerStates.emit(10, peerState(false, 1));
    harness.peerStates.emit(10, peerState(true, 2));
    await flushMicrotasks();

    const secondId = harness.coordinator.published[1]?.inspectMessageId;
    expect(firstId).toBe("inspect-1");
    expect(secondId).toBe("inspect-2");
    expect(secondId).not.toBe(firstId);

    harness.resolutions.emit(resolution(String(firstId), 99));
    harness.resolutions.emit(resolution(String(secondId), 1));

    expect(messagesOfType(panel, "resolution")).toEqual([
      resolution("inspect-2", 1),
    ]);
  });

  it("republishes once when the browser reconnects with unchanged peer generation", async () => {
    let harness!: ReturnType<typeof createHarness>;
    const republishResults: unknown[] = [];
    const twoRepublishesFinished = deferred<void>();
    harness = createHarness({
      sendTabMessage: async (tabId, message) => {
        if (
          isRecord(message) &&
          message.type === "browser2ide.inspect.republish"
        ) {
          republishResults.push(await harness.router.routeMessage(
            selectedMessage(DEFAULT_CONTENT_SESSION_ID),
            contentSender(tabId, 10),
          ));
          if (republishResults.length === 2) {
            twoRepublishesFinished.resolve();
          }
          return true;
        }
        return undefined;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    harness.peerStates.emit(10, peerState(true, 7));
    await flushMicrotasks();
    const initialPeerRepublishes = republishCallCount(harness.inspectCalls);
    const publicationsBeforeBridgeReconnect = harness.coordinator.published.length;
    const registration = harness.coordinator.registrations[0];

    registration?.onStateChanged?.("offline");
    registration?.onStateChanged?.("reconnecting");
    registration?.onStateChanged?.("linked");
    registration?.onStateChanged?.("linked");
    harness.peerStates.emit(10, peerState(true, 7));
    await twoRepublishesFinished.promise;

    expect(initialPeerRepublishes).toBe(1);
    expect(republishCallCount(harness.inspectCalls)).toBe(
      initialPeerRepublishes + 1,
    );
    expect(republishResults).toEqual([{ ok: true }, { ok: true }]);
    expect(harness.coordinator.published).toHaveLength(
      publicationsBeforeBridgeReconnect + 1,
    );
  });

  it("bounds peer state per window and clears it across unlink and removal", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    const registration = harness.coordinator.registrations[0];

    harness.peerStates.emit(10, peerState(false, 40, "session-a"));
    harness.peerStates.emit(10, peerState(true, 1, "session-b"));
    harness.peerStates.emit(10, peerState(true, 2, "session-b"));
    harness.peerStates.emit(10, peerState(false, 1, "session-b"));

    expect(peerStateHistory(harness.router)).toEqual([
      [
        10,
        { sessionId: "session-b", connected: true, generation: 2 },
      ],
    ]);
    expect(messagesOfType(panel, "peerState").slice(-2)).toEqual([
      peerState(true, 1, "session-b"),
      peerState(true, 2, "session-b"),
    ]);

    registration?.onStateChanged?.("notLinked");
    await flushMicrotasks();
    expect(peerStateHistory(harness.router)).toEqual([]);
    harness.peerStates.emit(10, peerState(false, 99, "late-unlinked"));
    expect(peerStateHistory(harness.router)).toEqual([]);

    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    harness.peerStates.emit(10, peerState(true, 1, "session-c"));
    expect(peerStateHistory(harness.router)).toEqual([
      [
        10,
        { sessionId: "session-c", connected: true, generation: 1 },
      ],
    ]);

    await harness.router.removeWindow(10);
    expect(peerStateHistory(harness.router)).toEqual([]);
    harness.peerStates.emit(10, peerState(false, 99, "late-session"));
    expect(peerStateHistory(harness.router)).toEqual([]);
  });

  it("scopes peer state and reconnect republish to its browser window", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    const panelA = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.inspectCoordinator.whenIdle(17);
    await harness.inspectCoordinator.whenIdle(18);
    harness.inspectCalls.length = 0;

    harness.peerStates.emit(10, peerState(false, 1));
    harness.peerStates.emit(10, peerState(true, 2));
    await flushMicrotasks();

    expect(messagesOfType(panelA, "peerState")).toEqual([
      peerState(false, 1),
      peerState(true, 2),
    ]);
    expect(messagesOfType(panelB, "peerState")).toEqual([]);
    expect(harness.inspectCalls).toEqual([
      ["tab", 17, { type: "browser2ide.inspect.republish" }],
    ]);
  });

  it("routes DOM requests through the registered tab while picker is off", async () => {
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.getRoot"
          ? domRoot(String(message.requestId))
          : undefined,
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    panel.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "picker-off",
      enabled: false,
    });
    panel.emitMessage({
      type: "dom.getRoot",
      requestId: "root-1",
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(harness.inspectCalls).toContainEqual([
      "tab",
      17,
      { type: "dom.getRoot", requestId: "root-1" },
    ]);
    expect(messagesOfType(panel, "dom.root")).toEqual([domRoot("root-1")]);
  });

  it("routes locator resolution errors from the current content session", async () => {
    const request = domResolveLocator("locator-1");
    const response = {
      type: "dom.error" as const,
      requestId: request.requestId,
      documentEpoch: 3,
      code: "node-unavailable" as const,
    };
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.resolveLocator"
          ? response
          : undefined,
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    panel.emitMessage(request);
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(harness.inspectCalls).toContainEqual(["tab", 17, request]);
    expect(messagesOfType(panel, "dom.error")).toEqual([response]);
  });

  it("settles an invalid locator query without dispatching it", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const request = domResolveLocator("locator-invalid");
    const invalidRequest = {
      ...request,
      locator: { ...request.locator, extra: true },
    };

    panel.emitMessage(invalidRequest);
    await flushMicrotasks();

    expect(messagesOfType(panel, "dom.error")).toEqual([{
      type: "dom.error",
      requestId: request.requestId,
      code: "invalid-request",
    }]);
    expect(harness.inspectCalls).not.toContainEqual([
      "tab",
      17,
      invalidRequest,
    ]);
  });

  it("settles a mismatched locator response with the panel request ID", async () => {
    const request = domResolveLocator("locator-current");
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.resolveLocator"
          ? {
              type: "dom.error",
              requestId: "locator-stale",
              code: "node-unavailable",
            }
          : undefined,
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);

    panel.emitMessage(request);
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(messagesOfType(panel, "dom.error")).toEqual([{
      type: "dom.error",
      requestId: request.requestId,
      code: "internal-error",
    }]);
  });

  it.each([
    {
      type: "dom.getRoot" as const,
      requestId: "root-after-unlink",
    },
    {
      type: "dom.getChildren" as const,
      requestId: "children-after-unlink",
      documentEpoch: 1,
      nodeRef: "node-root",
      branchRevision: 0,
    },
    domResolveLocator("locator-after-unlink"),
  ])("settles queued $type after unlink before dispatch", async (request) => {
    const enable = deferred<void>();
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
        return undefined;
      },
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    panel.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "blocking-enable",
      enabled: true,
    });
    panel.emitMessage(request);
    await flushMicrotasks();

    harness.coordinator.registrations[0]?.onStateChanged?.("notLinked");
    await flushMicrotasks();
    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(messagesOfType(panel, "dom.error")).toContainEqual({
      type: "dom.error",
      requestId: request.requestId,
      code: "session-disposed",
    });
    expect(harness.inspectCalls).not.toContainEqual(["tab", 17, request]);
  });

  it("settles an in-flight DOM query when its tab migrates", async () => {
    const tabs = new Map([[17, 10]]);
    const query = deferred<unknown>();
    const harness = createHarness({
      tabs,
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.getRoot"
          ? query.promise
          : undefined,
    });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    panel.emitMessage({ type: "dom.getRoot", requestId: "migrating-root" });
    await flushMicrotasks();

    tabs.set(17, 20);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 20),
    );
    query.resolve(domRoot("migrating-root"));
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(messagesOfType(panel, "dom.root")).toEqual([]);
    expect(messagesOfType(panel, "dom.error")).toContainEqual({
      type: "dom.error",
      requestId: "migrating-root",
      code: "session-disposed",
    });
  });

  it("does not deliver an old DOM query result to a replacement panel port", async () => {
    const query = deferred<unknown>();
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.getRoot"
          ? query.promise
          : undefined,
    });
    const original = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    original.emitMessage({ type: "dom.getRoot", requestId: "old-root" });
    await flushMicrotasks();

    original.disconnect();
    const replacement = harness.panelPort("channel-1");
    harness.router.connectPort(replacement);
    await flushMicrotasks();
    query.resolve(domRoot("old-root"));
    await flushMicrotasks();

    expect(original.disconnected).toBe(true);
    expect(messagesOfType(replacement, "dom.root")).toEqual([]);
    expect(messagesOfType(replacement, "dom.error")).toEqual([]);
  });

  it("settles a DOM query when the panel operation throws unexpectedly", async () => {
    const panelSessions = new PanelSessionTransport({
      sendTabMessage: async () => undefined,
      postPanelMessage: () => undefined,
    });
    panelSessions.request = async () => {
      throw new Error("unexpected panel transport failure");
    };
    const harness = createHarness({ panelSessionTransport: panelSessions });
    const panel = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    panel.emitMessage({ type: "dom.getRoot", requestId: "throwing-root" });
    await flushMicrotasks();

    expect(messagesOfType(panel, "dom.error")).toEqual([{
      type: "dom.error",
      requestId: "throwing-root",
      code: "internal-error",
    }]);
    expect(harness.reportedErrors).toHaveLength(1);
  });

  it("allows an in-flight selection in another window to publish", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let deferWindowB = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (deferWindowB && tabId === 18) {
          return tabLookup.promise;
        }
        return { id: tabId, windowId: tabId === 17 ? 10 : 20 };
      },
    });
    await harness.registerAndConnect("channel-a", 17, "source-a");
    await harness.registerAndConnect("channel-b", 18, "source-b");
    await harness.attachContentSession(18);
    deferWindowB = true;

    const publishing = harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(18, 20),
    );
    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 18, windowId: 20 });

    await expect(publishing).resolves.toEqual({ ok: true });
    expect(harness.coordinator.published).toEqual([
      {
        windowId: 20,
        inspectMessageId: "inspect-1",
        sourceId: "source-b",
        payload: inspectPayload(),
      },
    ]);
    expect(harness.coordinator.activeSources()).toEqual(["source-b"]);
  });

  it("does not publish an in-flight selection from a removed window", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let deferSelection = false;
    const harness = createHarness({
      getTab: async (tabId) =>
        deferSelection ? tabLookup.promise : { id: tabId, windowId: 10 },
    });
    await harness.registerAndConnect("channel-a", 17, "source-a");
    await harness.attachContentSession(17);
    deferSelection = true;

    const publishing = harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(publishing).resolves.toBeUndefined();
    expect(harness.coordinator.published).toEqual([]);
  });

  it("fails closed for invalid payloads, inactive tabs, and sender window mismatches", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);

    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID, {
        ...inspectPayload(),
        targets: [],
      }),
      contentSender(17, 10),
    );
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 999),
    );
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(18, 10),
    );

    expect(harness.coordinator.published).toEqual([]);
  });

  it("keeps inspect commands and content leases bound to browser-derived tabs", async () => {
    const harness = createHarness();
    const panelPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    panelPort.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "spoof",
      tabId: 99,
      enabled: true,
    });
    panelPort.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "trusted",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    const crossTabLease = harness.port(createInspectContentLeasePortName(
      "cross-tab-session",
    ), {
      tab: { id: 99, windowId: 10 },
    });
    harness.router.connectPort(crossTabLease);

    expect(harness.inspectCalls).toEqual([
      ["inject", { target: { tabId: 17 }, files: ["dist/contentScript.js"] }],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(crossTabLease.disconnected).toBe(true);
  });

  it("removes a browser window and tears down its registrations", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    await harness.router.removeWindow(10);
    await harness.inspectCoordinator.whenIdle(17);

    expect(harness.coordinator.removedWindows).toEqual([10]);
    expect(harness.coordinator.disposeCalls).toBe(1);
    expect(port.disconnected).toBe(true);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
    await harness.router.routeMessage(
      selectedMessage(DEFAULT_CONTENT_SESSION_ID),
      contentSender(17, 10),
    );
    expect(harness.coordinator.published).toEqual([]);
  });

  it("links and unlinks only the window derived from the trusted panel binding", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");

    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    expect(harness.coordinator.links).toEqual([
      {
        windowId: 10,
        code: "4873507",
        source: {
          role: "browser",
          id: "source-17",
          metadata: {},
        },
      },
    ]);
    expect(harness.coordinator.unlinks).toEqual([10]);
  });

  it("migrates a moved tab before Link, Unlink, and Inspect", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    tabs.set(17, 20);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    tabs.set(17, 30);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "moved-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(harness.coordinator.links.map(({ windowId }) => windowId)).toEqual([20]);
    expect(harness.coordinator.unlinks).toEqual([30]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 30,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(harness.inspectCalls).toEqual([
      ["inject", { target: { tabId: 17 }, files: ["dist/contentScript.js"] }],
      [
        "tab",
        17,
        { type: "browser2ide.inspect.disposeSession" },
      ],
      ["inject", { target: { tabId: 17 }, files: ["dist/contentScript.js"] }],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(harness.getTabCalls).toEqual([
      17,
      17,
      17,
      17,
      17,
      17,
      17,
      17,
      17,
      17,
    ]);
  });

  it("invalidates a closed tab before window commands or Inspect", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    tabs.delete(17);

    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "closed-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "stalePanel" });

    expect(harness.inspectCalls).toEqual([
      [
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ],
      [
        "tab",
        17,
        { type: "browser2ide.inspect.disposeSession" },
      ],
    ]);
    expect(harness.coordinator.unlinks).toEqual([]);
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(port.sent).toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "closed-enable",
      ok: false,
      error: "stalePanel",
    });
  });

  it("does not dispatch a command after its tab lookup loses the panel", async () => {
    const movedTab = deferred<{ id: number; windowId: number }>();
    let lookupCount = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookupCount += 1;
        return lookupCount === 1
          ? { id: tabId, windowId: 10 }
          : movedTab.promise;
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    const command = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await Promise.resolve();
    port.disconnect();
    movedTab.resolve({ id: 17, windowId: 20 });

    await expect(command).resolves.toEqual({ ok: false, error: "stalePanel" });
    expect(harness.coordinator.links).toEqual([]);
  });

  it("rejects spoofed panel URLs, channels, IDs, and extra command keys", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const link = {
      type: "browser2ide.linkWindow",
      channel: "channel-1",
      code: "4873507",
    } as const;

    expect(
      await harness.router.routeMessage(link, {
        url: `${PANEL_URL}?channel=channel-1#spoof`,
      }),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...link, channel: "channel-2" },
        panelSender("channel-2"),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...link, windowId: 99 },
        panelSender("channel-1"),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
          tabId: 99,
        },
        panelSender("channel-1"),
      ),
    ).toBeUndefined();
    expect(harness.coordinator.links).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
  });

  it("returns sanitized failures for invalid codes and stale panel bindings", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "0999907",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "invalidCode" });

    port.disconnect();
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "stalePanel" });
    expect(harness.coordinator.links).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
  });

  it("rejects malformed or oversized link codes before coordinator dispatch", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");

    for (const code of ["48735 07", "48735070", "48735x7", ""] as const) {
      expect(
        await harness.router.routeMessage(
          {
            type: "browser2ide.linkWindow",
            channel: "channel-1",
            code,
          },
          panelSender("channel-1"),
        ),
      ).toBeUndefined();
    }
    expect(harness.coordinator.links).toEqual([]);
  });

  it("allows only one reentrant command per active panel channel", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const message = {
      type: "browser2ide.linkWindow",
      channel: "channel-1",
      code: "4873507",
    } as const;

    const first = harness.router.routeMessage(
      message,
      panelSender("channel-1"),
    );
    await Promise.resolve();
    await expect(
      harness.router.routeMessage(message, panelSender("channel-1")),
    ).resolves.toEqual({ ok: false, error: "busy" });
    linkResult.resolve();
    await expect(first).resolves.toEqual({ ok: true });

    expect(harness.coordinator.links).toHaveLength(1);
  });

  it("maps coordinator rate limits and errors without exposing their messages", async () => {
    const rateLimited = createHarness({
      linkWindow: async () => {
        throw new BrowserProtocolError(
          "link.rateLimited",
          "secret server detail",
        );
      },
    });
    await rateLimited.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await expect(
      rateLimited.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "rateLimited" });
    expect(rateLimited.reportedErrors).toEqual([]);

    const failed = createHarness({
      unlinkWindow: async () => {
        throw new Error("secret storage detail");
      },
    });
    await failed.registerAndConnect("channel-1", 17, "source-17");
    await expect(
      failed.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "error" });
    expect(failed.reportedErrors).toHaveLength(1);
    expect(failed.reportedErrors[0]).toBeInstanceOf(Error);
    expect((failed.reportedErrors[0] as Error).message).toBe(
      "Browser2IDE panel command failed",
    );
    expect((failed.reportedErrors[0] as Error).message).not.toContain(
      "secret storage detail",
    );
  });

  it("does not report success after an async command loses its panel binding", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const result = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    port.disconnect();
    linkResult.resolve();

    await expect(result).resolves.toEqual({ ok: false, error: "stalePanel" });
  });

  it("does not report an async command error to a stale panel binding", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const result = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    port.disconnect();
    linkResult.reject(new Error("secret stale failure"));

    await expect(result).resolves.toEqual({ ok: false, error: "stalePanel" });
  });

  it.each(["link", "unlink"] as const)(
    "cancels an in-flight %s from window A when the tab migrates to B",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const operation = deferred<void>();
      const signals: AbortSignal[] = [];
      const behavior = async (signal: AbortSignal | undefined): Promise<void> => {
        if (signal) {
          signals.push(signal);
        }
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        linkWindow: async (_windowId, _code, _source, signal) =>
          behavior(signal),
        unlinkWindow: async (_windowId, signal) => behavior(signal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      await harness.attachContentSession(17);
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      tabs.set(17, 20);
      await expect(
        harness.router.routeMessage(
          selectedMessage(DEFAULT_CONTENT_SESSION_ID),
          contentSender(17, 20),
        ),
      ).resolves.toBeUndefined();

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      operation.resolve();
      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    },
  );

  it.each(["link", "unlink"] as const)(
    "suspends an in-flight %s on detach and reactivates it only after attach",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const events = createRouterSubscriptionHarness();
      const operation = deferred<void>();
      const signals: AbortSignal[] = [];
      const behavior = async (signal: AbortSignal | undefined): Promise<void> => {
        if (signal) {
          signals.push(signal);
        }
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        subscriptions: events.subscriptions,
        linkWindow: async (_windowId, _code, _source, signal) =>
          behavior(signal),
        unlinkWindow: async (_windowId, signal) => behavior(signal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      events.detach(17, 10);

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(harness.coordinator.activeSources()).toEqual([]);

      tabs.set(17, 20);
      events.attach(17, 20);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);

      operation.resolve();
      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
    },
  );

  it.each(["link", "unlink"] as const)(
    "does not acknowledge a quiet A-to-B move after deferred %s",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const operation = deferred<void>();
      let signal: AbortSignal | undefined;
      const behavior = async (currentSignal: AbortSignal | undefined) => {
        signal = currentSignal;
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        linkWindow: async (_windowId, _code, _source, currentSignal) =>
          behavior(currentSignal),
        unlinkWindow: async (_windowId, currentSignal) =>
          behavior(currentSignal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      tabs.set(17, 20);
      operation.resolve();

      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });
      expect(signal?.aborted).toBe(true);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
    },
  );

  it.each(["link", "unlink"] as const)(
    "refreshes a quiet A-to-B move after deferred %s rejects",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const operation = deferred<void>();
      let signal: AbortSignal | undefined;
      const behavior = async (currentSignal: AbortSignal | undefined) => {
        signal = currentSignal;
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        linkWindow: async (_windowId, _code, _source, currentSignal) =>
          behavior(currentSignal),
        unlinkWindow: async (_windowId, currentSignal) =>
          behavior(currentSignal),
      });
      await harness.registerAndConnect("channel-1", 17, "source-17");
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      tabs.set(17, 20);
      operation.reject(new Error("secret late coordinator failure"));

      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });
      expect(signal?.aborted).toBe(true);
      expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
        .toEqual([10, 20]);
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
      expect(harness.reportedErrors).toEqual([]);
    },
  );

  it("drops an old A state callback and migrates before deferred Link settles", async () => {
    const tabs = new Map([[17, 10]]);
    const operation = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      initialPanelState: "notLinked",
      tabs,
      linkWindow: async (_windowId, _code, _source, currentSignal) => {
        signal = currentSignal;
        await operation.promise;
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    const oldRegistration = harness.coordinator.registrations[0];
    const command = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    tabs.set(17, 20);
    oldRegistration?.onStateChanged?.("linked");
    await flushMicrotasks();

    const statesBeforeSettle = windowStates(port);
    const abortedBeforeSettle = signal?.aborted;
    const windowsBeforeSettle = harness.coordinator.registrations.map(
      ({ windowId }) => windowId,
    );
    operation.resolve();

    await expect(command).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(statesBeforeSettle).not.toContain("linked");
    expect(abortedBeforeSettle).toBe(true);
    expect(windowsBeforeSettle).toEqual([10, 20]);
  });

  it("validates and preserves linking-to-linked state order", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    const registration = harness.coordinator.registrations[0];
    const lookupBaseline = harness.getTabCalls.length;

    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();

    expect(harness.getTabCalls.slice(lookupBaseline)).toEqual([17, 17]);
    expect(windowStates(port).slice(-2)).toEqual(["linking", "linked"]);
  });

  it("starts inspection only when linking and retains it while credentials remain", async () => {
    const harness = createHarness({ initialPanelState: "notLinked" });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const registration = harness.coordinator.registrations[0];
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(injectionCount(harness.inspectCalls)).toBe(0);

    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(injectionCount(harness.inspectCalls)).toBe(1);

    const contentLease = new FakePort(
      createInspectContentLeasePortName("content-session-link"),
      contentSender(17, 10),
    );
    harness.router.connectPort(contentLease);
    registration?.onStateChanged?.("offline");
    registration?.onStateChanged?.("reconnecting");
    await flushMicrotasks();

    expect(contentLease.disconnected).toBe(false);
    expect(injectionCount(harness.inspectCalls)).toBe(1);

    registration?.onStateChanged?.("notLinked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(contentLease.disconnected).toBe(true);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
    expect(port.disconnected).toBe(false);
  });

  it("recovers once per trusted content lease across repeated navigations", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const registration = harness.coordinator.registrations[0];
    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    const firstLease = new FakePort(
      createInspectContentLeasePortName("content-session-first"),
      contentSender(17, 10),
    );
    harness.router.connectPort(firstLease);
    firstLease.disconnect();
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(injectionCount(harness.inspectCalls)).toBe(2);

    const secondLease = new FakePort(
      createInspectContentLeasePortName("content-session-second"),
      contentSender(17, 10),
    );
    harness.router.connectPort(secondLease);
    expect(secondLease.disconnected).toBe(false);
    secondLease.disconnect();
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(injectionCount(harness.inspectCalls)).toBe(3);

    const thirdLease = new FakePort(
      createInspectContentLeasePortName("content-session-third"),
      contentSender(17, 10),
    );
    harness.router.connectPort(thirdLease);
    expect(thirdLease.disconnected).toBe(false);
  });

  it("fails closed after one recovery injection failure without retrying", async () => {
    let injectionAttempts = 0;
    const harness = createHarness({
      executeScript: async () => {
        injectionAttempts += 1;
        if (injectionAttempts === 2) {
          throw new Error("Protected page");
        }
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);
    const registration = harness.coordinator.registrations[0];
    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    const contentLease = new FakePort(
      createInspectContentLeasePortName("content-session-before-failure"),
      contentSender(17, 10),
    );
    harness.router.connectPort(contentLease);
    contentLease.disconnect();
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(injectionAttempts).toBe(2);

    registration?.onStateChanged?.("linked");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(injectionAttempts).toBe(2);

    const unownedLease = new FakePort(
      createInspectContentLeasePortName("content-session-unowned"),
      contentSender(17, 10),
    );
    harness.router.connectPort(unownedLease);
    expect(unownedLease.disconnected).toBe(true);
  });

  it("disposes inspection on unlink and recreates it only for a new link", async () => {
    const harness = createHarness({
      sendTabMessage: async (_tabId, message) =>
        isRecord(message) && message.type === "dom.getRoot"
          ? domRoot(String(message.requestId))
          : undefined,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.inspectCoordinator.whenIdle(17);
    const registration = harness.coordinator.registrations[0];

    registration?.onStateChanged?.("linking");
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();
    registration?.onStateChanged?.("notLinked");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
    const callsAfterUnlink = harness.inspectCalls.length;
    port.emitMessage({ type: "dom.getRoot", requestId: "after-unlink" });
    await flushMicrotasks();
    expect(harness.inspectCalls).toHaveLength(callsAfterUnlink);

    registration?.onStateChanged?.("linking");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "inject",
      {
        target: { tabId: 17 },
        files: ["dist/contentScript.js"],
      },
    ]);
  });

  it("does not let a pending A state verification block initial B state", async () => {
    const pendingAState = deferred<{ id: number; windowId: number }>();
    const events = createRouterSubscriptionHarness();
    const tabs = new Map([[17, 10]]);
    let lookup = 0;
    const harness = createHarness({
      initialPanelState: "notLinked",
      tabs,
      subscriptions: events.subscriptions,
      getTab: async (tabId) => {
        lookup += 1;
        if (lookup === 3) {
          return pendingAState.promise;
        }
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    const oldRegistration = harness.coordinator.registrations[0];
    const stateBaseline = windowStates(port).length;

    oldRegistration?.onStateChanged?.("linked");
    await flushMicrotasks();
    tabs.set(17, 20);
    events.detach(17, 10);
    events.attach(17, 20);
    await flushMicrotasks();

    const lookupsBeforeAResolution = lookup;
    const statesBeforeAResolution = windowStates(port).slice(stateBaseline);
    const registrationsBeforeAResolution =
      harness.coordinator.registrations.map(({ windowId }) => windowId);
    pendingAState.resolve({ id: 17, windowId: 10 });
    await flushMicrotasks();

    expect(lookupsBeforeAResolution).toBe(4);
    expect(statesBeforeAResolution).toEqual(["notLinked"]);
    expect(registrationsBeforeAResolution).toEqual([10, 20]);
    expect(windowStates(port).slice(stateBaseline)).toEqual(["notLinked"]);
    expect(harness.reportedErrors).toEqual([]);
  });

  it("ignores state callbacks after the panel port closes", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    const registration = harness.coordinator.registrations[0];
    const lookupBaseline = harness.getTabCalls.length;
    const sentBaseline = [...port.sent];

    port.disconnect();
    registration?.onStateChanged?.("linked");
    await flushMicrotasks();

    expect(harness.getTabCalls).toHaveLength(lookupBaseline);
    expect(port.sent).toEqual(sentBaseline);
  });

  it("invalidates a quietly closed tab after a deferred command", async () => {
    const tabs = new Map([[17, 10]]);
    const operation = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      tabs,
      unlinkWindow: async (_windowId, currentSignal) => {
        signal = currentSignal;
        await operation.promise;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);
    const command = harness.router.routeMessage(
      {
        type: "browser2ide.unlinkWindow",
        channel: "channel-1",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    tabs.delete(17);
    operation.resolve();

    await expect(command).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(signal?.aborted).toBe(true);
    expect(harness.coordinator.activeSources()).toEqual([]);
  });

  it("cancels an in-flight window command when its tab closes", async () => {
    const tabs = new Map([[17, 10]]);
    const operation = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      tabs,
      linkWindow: async (_windowId, _code, _source, currentSignal) => {
        signal = currentSignal;
        await operation.promise;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.attachContentSession(17);
    const command = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    tabs.delete(17);
    await expect(
      harness.router.routeMessage(
        selectedMessage(DEFAULT_CONTENT_SESSION_ID),
        contentSender(17, 10),
      ),
    ).resolves.toBeUndefined();

    expect(signal?.aborted).toBe(true);
    operation.resolve();
    await expect(command).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(harness.coordinator.activeSources()).toEqual([]);
  });

  it("settles pending Inspect as stale when its tab migrates to another window", async () => {
    const tabs = new Map([[17, 10]]);
    const enable = deferred<void>();
    const harness = createHarness({
      tabs,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await harness.attachContentSession(17);
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "pending-enable",
      enabled: true,
    });
    await flushMicrotasks();

    tabs.set(17, 20);
    await expect(
      harness.router.routeMessage(
        selectedMessage(DEFAULT_CONTENT_SESSION_ID),
        contentSender(17, 20),
      ),
    ).resolves.toBeUndefined();

    expect(port.sent).toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: false,
      error: "stalePanel",
    });
    expect(port.sent).not.toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: true,
    });

    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(port.sent).not.toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: true,
    });
    expect(harness.inspectCalls).toEqual([
      [
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
      ["tab", 17, { type: "browser2ide.inspect.disposeSession" }],
      [
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ],
    ]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("settles pending Inspect on detach and reactivates only after attach", async () => {
    const tabs = new Map([[17, 10]]);
    const events = createRouterSubscriptionHarness();
    const enable = deferred<void>();
    const harness = createHarness({
      tabs,
      subscriptions: events.subscriptions,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "detached-enable",
      enabled: true,
    });
    await flushMicrotasks();

    events.detach(17, 10);

    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(inspectResults(port)).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "detached-enable",
        ok: false,
        error: "stalePanel",
      },
    ]);

    tabs.set(17, 20);
    events.attach(17, 20);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });

    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(inspectResults(port)).toHaveLength(1);
    expect(harness.inspectCalls).toEqual([
      [
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
      [
        "tab",
        17,
        { type: "browser2ide.inspect.disposeSession" },
      ],
      [
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ],
    ]);
  });

  it.each(["executeScript", "sendTabMessage"] as const)(
    "does not acknowledge a quiet A-to-B move during deferred Inspect %s",
    async (stage) => {
      const tabs = new Map([[17, 10]]);
      const enable = deferred<void>();
      const harness = createHarness({
        tabs,
        executeScript: async () => {
          if (stage === "executeScript") {
            await enable.promise;
          }
        },
        sendTabMessage: async (_tabId, message) => {
          if (
            stage === "sendTabMessage" &&
            isRecord(message) &&
            message.type === "enableInspectMode"
          ) {
            await enable.promise;
          }
        },
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      port.emitMessage({
        type: "browser2ide.inspect.setEnabled",
        requestId: `quiet-${stage}`,
        enabled: true,
      });
      await flushMicrotasks();

      tabs.set(17, 20);
      enable.resolve();
      await harness.inspectCoordinator.whenIdle(17);
      await flushMicrotasks();
      await harness.inspectCoordinator.whenIdle(17);

      expect(inspectResults(port)).toEqual([
        {
          type: "browser2ide.inspect.result",
          requestId: `quiet-${stage}`,
          ok: false,
          error: "stalePanel",
        },
      ]);
      expect(harness.inspectCalls.at(-1)).toEqual([
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ]);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    },
  );

  it.each(["executeScript", "sendTabMessage"] as const)(
    "refreshes a quiet A-to-B move after Inspect %s rejects",
    async (stage) => {
      const tabs = new Map([[17, 10]]);
      const failure = deferred<void>();
      const harness = createHarness({
        tabs,
        executeScript: async () => {
          if (stage === "executeScript") {
            await failure.promise;
          }
        },
        sendTabMessage: async (_tabId, message) => {
          if (
            stage === "sendTabMessage" &&
            isRecord(message) &&
            message.type === "enableInspectMode"
          ) {
            await failure.promise;
          }
        },
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      port.emitMessage({
        type: "browser2ide.inspect.setEnabled",
        requestId: `failed-${stage}`,
        enabled: true,
      });
      await flushMicrotasks();

      tabs.set(17, 20);
      failure.reject(new Error("secret inspect failure"));
      await harness.inspectCoordinator.whenIdle(17);
      await flushMicrotasks();
      await harness.inspectCoordinator.whenIdle(17);

      expect(inspectResults(port)).toEqual([
        {
          type: "browser2ide.inspect.result",
          requestId: `failed-${stage}`,
          ok: false,
          error: "stalePanel",
        },
      ]);
      expect(harness.inspectCalls.at(-1)).toEqual([
        "inject",
        {
          target: { tabId: 17 },
          files: ["dist/contentScript.js"],
        },
      ]);
      expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
        .toEqual(stage === "executeScript" ? [10] : [10, 20]);
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
      expect(port.disconnected).toBe(false);
    },
  );

  it("does not acknowledge a quiet move during deferred Inspect disable", async () => {
    const tabs = new Map([[17, 10]]);
    const disable = deferred<void>();
    const harness = createHarness({
      tabs,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "disableInspectMode") {
          await disable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "enable-before-disable",
      enabled: true,
    });
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "quiet-disable",
      enabled: false,
    });
    await flushMicrotasks();
    tabs.set(17, 20);
    disable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(inspectResults(port)).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "enable-before-disable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "quiet-disable",
        ok: false,
        error: "stalePanel",
      },
    ]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("does not let a stale command block a recovered port on the same channel", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const firstPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const staleLink = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();
    firstPort.disconnect();

    const recoveredPort = harness.panelPort("channel-1");
    harness.router.connectPort(recoveredPort);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    linkResult.resolve();
    await expect(staleLink).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(harness.coordinator.unlinks).toEqual([10]);
  });

  it("disposes subscriptions, ports, inspect ownership, and panel registration once", async () => {
    const removedListeners: string[] = [];
    const harness = createHarness({
      subscriptions: {
        subscribeRuntimeMessages() {
          return () => removedListeners.push("message");
        },
        subscribeRuntimePorts() {
          return () => removedListeners.push("port");
        },
        subscribeWindowRemoved() {
          return () => removedListeners.push("window");
        },
        subscribeTabDetached() {
          return () => removedListeners.push("detached");
        },
        subscribeTabAttached() {
          return () => removedListeners.push("attached");
        },
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    harness.router.dispose();
    harness.router.dispose();
    await harness.inspectCoordinator.whenIdle(17);

    expect(removedListeners).toEqual([
      "message",
      "port",
      "window",
      "detached",
      "attached",
    ]);
    expect(harness.coordinator.disposeCalls).toBe(1);
    expect(port.disconnected).toBe(true);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "browser2ide.inspect.disposeSession" },
    ]);
  });
});

interface HarnessOptions {
  readonly expectedDevtoolsUrl?: string;
  readonly maxPanelPorts?: number;
  readonly tabs?: ReadonlyMap<number, number>;
  readonly getTab?: (
    tabId: number,
  ) => Promise<{ id: number; windowId: number } | undefined>;
  readonly subscriptions?: BackgroundRouterSubscriptions;
  readonly executeScript?: (details: {
    target: { tabId: number };
    files: string[];
  }) => Promise<unknown>;
  readonly sendTabMessage?: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly linkWindow?: (
    windowId: number,
    code: string,
    source: unknown,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly unlinkWindow?: (
    windowId: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly publishInspect?: (
    publication: PublishedInspect,
  ) => InspectSendOutcome;
  readonly publishSourceNavigation?: (
    publication: PublishedSourceNavigation,
  ) => SourceNavigationSendOutcome;
  readonly panelSessionTransport?: PanelSessionTransport;
  readonly initialPanelState?: BrowserWindowConnectionState;
}

function createHarness(options: HarnessOptions = {}) {
  const tabs = options.tabs ?? new Map([[17, 10]]);
  const getTabCalls: number[] = [];
  const inspectCalls: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const resolutions = new FakeEvent<(message: ResolutionMessage) => void>();
  const peerStates = new FakeEvent<
    (windowId: number, message: PeerStateMessage) => void
  >();
  const sourceNavigationStates = new FakeEvent<
    (windowId: number, message: SourceNavigationStateMessage) => void
  >();
  const coordinator = new FakeWindowCoordinator(
    options.linkWindow,
    options.unlinkWindow,
    options.publishInspect,
    options.publishSourceNavigation,
    options.initialPanelState ?? "linked",
  );
  const inspectCoordinator = new BackgroundInspectCoordinator({
    async executeScript(details) {
      inspectCalls.push(["inject", details]);
      await options.executeScript?.(details);
    },
    async sendTabMessage(tabId, message) {
      inspectCalls.push(["tab", tabId, message]);
      return await options.sendTabMessage?.(tabId, message);
    },
  });
  const harness = {
    coordinator,
    getTabCalls,
    inspectCalls,
    reportedErrors,
    resolutions,
    peerStates,
    sourceNavigationStates,
    inspectCoordinator,
    router: undefined as unknown as ReturnType<typeof createBackgroundRouter>,
    port(
      name: string,
      sender: BackgroundMessageSender = {},
    ): FakePort {
      return new FakePort(name, sender);
    },
    panelPort(
      channel: string,
      sender: BackgroundMessageSender = panelSender(channel),
    ): FakePort {
      return new FakePort(createDevtoolsPanelPortName(channel), sender);
    },
    async registerAndConnect(
      channel: string,
      tabId: number,
      sourceId: string,
    ): Promise<FakePort> {
      await harness.router.routeMessage(
        registerMessage(channel, tabId, sourceId),
        devtoolsSender(),
      );
      const port = harness.panelPort(channel);
      harness.router.connectPort(port);
      return port;
    },
    async attachContentSession(
      tabId: number,
      contentSessionId = DEFAULT_CONTENT_SESSION_ID,
    ): Promise<FakePort> {
      await flushMicrotasks();
      await inspectCoordinator.whenIdle(tabId);
      const port = harness.port(
        createInspectContentLeasePortName(contentSessionId),
        { tab: { id: tabId } },
      );
      harness.router.connectPort(port);
      return port;
    },
  };
  harness.router = createBackgroundRouter({
    expectedDevtoolsUrl: Object.hasOwn(options, "expectedDevtoolsUrl")
      ? options.expectedDevtoolsUrl
      : DEVTOOLS_URL,
    expectedPanelUrl: PANEL_URL,
    maxPanelPorts: options.maxPanelPorts,
    getTab:
      options.getTab ??
      (async (tabId) => {
        getTabCalls.push(tabId);
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      }),
    coordinator,
    inspectCoordinator,
    panelSessionTransport: options.panelSessionTransport,
    subscriptions: options.subscriptions,
    subscribeResolutions: (listener: (message: ResolutionMessage) => void) => {
      resolutions.addListener(listener);
      return () => resolutions.removeListener(listener);
    },
    subscribePeerStates: (
      listener: (windowId: number, message: PeerStateMessage) => void,
    ) => {
      peerStates.addListener(listener);
      return () => peerStates.removeListener(listener);
    },
    subscribeSourceNavigationStates: (
      listener: (
        windowId: number,
        message: SourceNavigationStateMessage,
      ) => void,
    ) => {
      sourceNavigationStates.addListener(listener);
      return () => sourceNavigationStates.removeListener(listener);
    },
    inspectMessageId: (() => {
      let sequence = 0;
      return () => `inspect-${++sequence}`;
    })(),
    onError: (error) => reportedErrors.push(error),
  });
  return harness;
}

interface PublishedInspect {
  readonly windowId: number;
  readonly inspectMessageId: string;
  readonly sourceId: string;
  readonly payload: InspectPayload;
}

interface PublishedSourceNavigation {
  readonly windowId: number;
  readonly input: Pick<
    SourceNavigateMessage,
    "inspectMessageId" | "resolutionGeneration" | "direction"
  >;
}

class FakeWindowCoordinator {
  public readonly registrations: PanelRegistration[] = [];
  public readonly published: PublishedInspect[] = [];
  public readonly sourceNavigations: PublishedSourceNavigation[] = [];
  public readonly removedWindows: number[] = [];
  public readonly links: Array<{
    windowId: number;
    code: string;
    source: unknown;
  }> = [];
  public readonly unlinks: number[] = [];
  public disposeCalls = 0;
  public publishOutcome: InspectSendOutcome = "sent";
  public sourceNavigationOutcome: SourceNavigationSendOutcome = "sent";
  public onPublish?: (publication: PublishedInspect) => void;
  private readonly active = new Set<PanelRegistration>();

  public constructor(
    private readonly linkBehavior?: (
      windowId: number,
      code: string,
      source: unknown,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly unlinkBehavior?: (
      windowId: number,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly publishBehavior?: (
      publication: PublishedInspect,
    ) => InspectSendOutcome,
    private readonly publishSourceNavigationBehavior?: (
      publication: PublishedSourceNavigation,
    ) => SourceNavigationSendOutcome,
    private readonly initialPanelState: BrowserWindowConnectionState = "linked",
  ) {}

  public async linkWindow(
    windowId: number,
    code: string,
    source: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    this.links.push({ windowId, code, source });
    await this.linkBehavior?.(windowId, code, source, signal);
  }

  public async unlinkWindow(
    windowId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.unlinks.push(windowId);
    await this.unlinkBehavior?.(windowId, signal);
  }

  public registerPanel(registration: PanelRegistration): { dispose(): void } {
    this.registrations.push(registration);
    this.active.add(registration);
    registration.onStateChanged?.(this.initialPanelState);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.disposeCalls += 1;
        this.active.delete(registration);
      },
    };
  }

  public publishInspect(
    windowId: number,
    inspectMessageId: string,
    sourceId: string,
    payload: InspectPayload,
  ): InspectSendOutcome {
    const publication = { windowId, inspectMessageId, sourceId, payload };
    this.published.push(publication);
    this.onPublish?.(publication);
    return this.publishBehavior?.(publication) ?? this.publishOutcome;
  }

  public publishSourceNavigation(
    windowId: number,
    input: PublishedSourceNavigation["input"],
  ): SourceNavigationSendOutcome {
    const publication = { windowId, input: { ...input } };
    this.sourceNavigations.push(publication);
    return this.publishSourceNavigationBehavior?.(publication) ??
      this.sourceNavigationOutcome;
  }

  public async removeWindow(windowId: number): Promise<void> {
    this.removedWindows.push(windowId);
  }

  public activeSources(): string[] {
    return [...this.active]
      .map((registration) => registration.sourceId)
      .sort();
  }
}

class FakePort implements BackgroundRuntimePort {
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public constructor(
    public readonly name: string,
    public readonly sender: BackgroundMessageSender,
  ) {}

  public postMessage(message: unknown): void {
    if (this.disconnected) {
      throw new Error("Port is disconnected");
    }
    this.sent.push(message);
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  public queueDisconnect(): () => void {
    const listeners = this.onDisconnect.snapshot();
    return () => {
      for (const listener of listeners) {
        listener();
      }
    };
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
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

  public snapshot(): T[] {
    return [...this.listeners];
  }
}

function registerMessage(channel: string, tabId: number, sourceId: string) {
  return {
    type: "browser2ide.registerDevtools",
    channel,
    tabId,
    sourceId,
  } as const;
}

function devtoolsSender(): BackgroundMessageSender {
  return { url: DEVTOOLS_URL };
}

function panelSender(channel: string): BackgroundMessageSender {
  return { url: `${PANEL_URL}?channel=${encodeURIComponent(channel)}` };
}

function contentSender(tabId: number, windowId: number): BackgroundMessageSender {
  return { tab: { id: tabId, windowId } };
}

function inspectPayload(): InspectPayload {
  return {
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
  };
}

function selectedMessage(
  contentSessionId: string,
  payload: InspectPayload = inspectPayload(),
  selectionRevision = 1,
) {
  return {
    type: "elementSelected" as const,
    contentSessionId,
    selectionRevision,
    payload,
  };
}

function selectedMessageWithRevision(
  contentSessionId: string,
  selectionRevision: unknown,
  payload: InspectPayload = inspectPayload(),
) {
  return {
    type: "elementSelected" as const,
    contentSessionId,
    selectionRevision,
    payload,
  };
}

function domEventMessage(contentSessionId: string, event: unknown) {
  return {
    type: "browser2ide.dom.event" as const,
    contentSessionId,
    event,
  };
}

function selectionChangedWithRevision(
  nodeRef: string,
  selectionRevision: number,
) {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch: 1,
    selectionRevision,
    nodeRef,
    ancestorPath: [],
  };
}

function selectionChanged(nodeRef: string) {
  return {
    type: "dom.selectionChanged" as const,
    documentEpoch: 1,
    selectionRevision: 1,
    nodeRef,
    ancestorPath: [],
  };
}

function inspectResults(port: FakePort): unknown[] {
  return port.sent.filter(
    (message) =>
      isRecord(message) && message.type === "browser2ide.inspect.result",
  );
}

function windowStates(port: FakePort): unknown[] {
  return port.sent.flatMap((message) =>
    isRecord(message) && message.type === "browser2ide.windowState"
      ? [message.state]
      : [],
  );
}

function createRouterSubscriptionHarness(): {
  readonly subscriptions: BackgroundRouterSubscriptions;
  detach(tabId: number, oldWindowId: number): void;
  attach(tabId: number, newWindowId: number): void;
} {
  let detached: ((tabId: number, oldWindowId: number) => void) | undefined;
  let attached: ((tabId: number, newWindowId: number) => void) | undefined;
  return {
    subscriptions: {
      subscribeRuntimeMessages() {
        return () => {};
      },
      subscribeRuntimePorts() {
        return () => {};
      },
      subscribeWindowRemoved() {
        return () => {};
      },
      subscribeTabDetached(listener) {
        detached = listener;
        return () => {
          if (detached === listener) {
            detached = undefined;
          }
        };
      },
      subscribeTabAttached(listener) {
        attached = listener;
        return () => {
          if (attached === listener) {
            attached = undefined;
          }
        };
      },
    },
    detach(tabId, oldWindowId) {
      if (!detached) {
        throw new Error("Missing tab detach listener");
      }
      detached(tabId, oldWindowId);
    },
    attach(tabId, newWindowId) {
      if (!attached) {
        throw new Error("Missing tab attach listener");
      }
      attached(tabId, newWindowId);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function injectionCount(calls: readonly unknown[]): number {
  return calls.filter(
    (call) => Array.isArray(call) && call[0] === "inject",
  ).length;
}

function republishCallCount(calls: readonly unknown[]): number {
  return calls.filter(
    (call) =>
      Array.isArray(call) &&
      isRecord(call[2]) &&
      call[2].type === "browser2ide.inspect.republish",
  ).length;
}

function messagesOfType(port: FakePort, type: string): unknown[] {
  return port.sent.filter(
    (message) => isRecord(message) && message.type === type,
  );
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

function panelSourceNavigation(
  direction: "previous" | "next",
  inspectMessageId = "inspect-1",
  resolutionGeneration = 2,
) {
  return {
    type: "browser2ide.source.navigate" as const,
    inspectMessageId,
    resolutionGeneration,
    direction,
  };
}

function sourceNavigationState(
  inspectMessageId: string,
  resolutionGeneration: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${inspectMessageId}-${resolutionGeneration}-${activeMatchIndex ?? "none"}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    selectedMatchCount: activeMatchIndex === undefined ? 0 : 2,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}

function peerState(
  connected: boolean,
  peerGeneration: number,
  sessionId = "session-a",
): PeerStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: `peer-${peerGeneration}`,
    sessionId,
    role: "ide",
    connected,
    peerGeneration,
    metadata: {},
  };
}

function peerStateHistory(
  router: ReturnType<typeof createBackgroundRouter>,
): unknown[] {
  const state = router as unknown as {
    peerStates: Map<unknown, unknown>;
  };
  return [...state.peerStates.entries()];
}

function domRoot(requestId: string) {
  return {
    type: "dom.root" as const,
    requestId,
    documentEpoch: 1,
    node: {
      nodeRef: "node-root",
      kind: "element" as const,
      label: "html",
      expandable: true,
      branchRevision: 0,
      locator: {
        version: 1 as const,
        targetKind: "element" as const,
        boundaries: [],
        path: [{ tagName: "html", siblingIndex: 0 }],
      },
    },
  };
}

function domResolveLocator(requestId: string) {
  return {
    type: "dom.resolveLocator" as const,
    requestId,
    locator: {
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: [],
      path: [{ tagName: "button", siblingIndex: 0, id: "save" }],
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
