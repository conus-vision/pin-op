import {
  PROTOCOL_VERSION,
  type PageRefreshMessage,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserProtocolError,
  type BrowserProtocolMismatch,
  type InspectPayload,
  type InspectSendOutcome,
  type PresentationSettingsInput,
  type SourceOpenInput,
  type SourceNavigationSendOutcome,
  type SourcePresentationSendOutcome,
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
import { InspectCorrelationStore } from "../src/inspectCorrelationStore.js";
import {
  createTransportTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "../src/trustedIdePeerContext.js";
import { PanelSessionTransport } from "../src/panelSessionTransport.js";
import type {
  BrowserWindowConnectionState,
  PanelRegistration,
} from "../src/windowConnectionCoordinator.js";
import type {
  TabRefreshSettings,
} from "../src/tabRefreshCoordinator.js";
import type { TabRefreshState } from "../src/refreshRuntimeProtocol.js";

const DEVTOOLS_URL = "moz-extension://pin-op/dist/devtools.html";
const PANEL_URL = "moz-extension://pin-op/dist/panel.html";
const DEFAULT_CONTENT_SESSION_ID = "content-session-default";

describe("BackgroundRouter", () => {
  it("registers panel participation and publishes strict tab-local settings snapshots", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-refresh",
      17,
      "source-refresh",
    );
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
    expect(port.sent).toContainEqual({
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
      lastAcceptedGeneration: 0,
    });

    port.emitMessage({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    expect(harness.contentRefresh.revokedTabs).toEqual([17]);
    port.emitMessage({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      tabId: 999,
    });
    await flushMicrotasks();

    expect(harness.tabRefresh.settingCalls).toEqual([
      [
        17,
        10,
        { autoRefreshEnabled: false, ideHighlightEnabled: false },
      ],
    ]);
    expect(port.sent.at(-1)).toEqual({
      type: "pin-op.tab.state",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 0,
    });
  });

  it("revokes active refresh work and participation when the panel closes", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-refresh-close",
      17,
      "source-refresh-close",
    );
    await flushMicrotasks();
    harness.contentRefresh.revokedTabs.length = 0;

    port.disconnect();

    expect(harness.contentRefresh.revokedTabs).toEqual([17]);
    expect(harness.tabRefresh.panelCloseCalls).toEqual([[17, 10]]);
    await flushMicrotasks();
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
  });

  it("restores every exact window participant when another open panel relinks", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
      [27, 20],
    ]);
    const harness = createHarness({ tabs });
    const firstPort = await harness.registerAndConnect(
      "channel-relink",
      17,
      "source-relink",
    );
    const secondPort = await harness.registerAndConnect(
      "channel-relink-sibling",
      18,
      "source-relink-sibling",
    );
    const otherPort = await harness.registerAndConnect(
      "channel-other-window",
      27,
      "source-other-window",
    );
    await flushMicrotasks();

    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink",
    }, panelSender("channel-relink"))).resolves.toEqual({ ok: true });
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(await harness.tabRefresh.state(18, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(await harness.tabRefresh.state(27, 20)).toMatchObject({
      participant: true,
    });
    const firstMessageStart = firstPort.sent.length;
    const secondMessageStart = secondPort.sent.length;
    const otherMessageStart = otherPort.sent.length;

    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-sibling",
      code: "4873507",
    }, panelSender("channel-relink-sibling"))).resolves.toEqual({ ok: true });
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toEqual([
      [17, 10],
      [18, 10],
      [27, 20],
      [17, 10],
      [18, 10],
    ]);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(await harness.tabRefresh.state(18, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(
      firstPort.sent
        .slice(firstMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(
      secondPort.sent
        .slice(secondMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(otherPort.sent).toHaveLength(otherMessageStart);

    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([[10, refresh]]);
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toEqual([
      [10, 17, refresh],
      [10, 18, refresh],
    ]);
  });

  it("defers page refresh until every window panel finishes relink restoration", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    const harness = createHarness({ tabs });
    await harness.registerAndConnect(
      "channel-refresh-during-restore-first",
      17,
      "source-refresh-during-restore-first",
    );
    await harness.registerAndConnect(
      "channel-refresh-during-restore-second",
      18,
      "source-refresh-during-restore-second",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-refresh-during-restore-first",
    }, panelSender("channel-refresh-during-restore-first"))).resolves.toEqual({
      ok: true,
    });

    const secondRestoreStarted = deferred<void>();
    const releaseSecondRestore = deferred<void>();
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) => {
      if (tabId === 18) {
        secondRestoreStarted.resolve();
        await releaseSecondRestore.promise;
      }
      return {
        ...defaultTabState(tabId, windowId),
        participant: true,
      };
    };

    const relink = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-refresh-during-restore-first",
      code: "4873507",
    }, panelSender("channel-refresh-during-restore-first"));
    await secondRestoreStarted.promise;

    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();

    expect(harness.tabRefresh.refreshCalls).toEqual([]);

    releaseSecondRestore.resolve();
    await expect(relink).resolves.toEqual({ ok: true });
    await flushMicrotasks();

    expect(harness.tabRefresh.refreshCalls).toEqual([[10, refresh]]);
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toEqual([
      [10, 17, refresh],
      [10, 18, refresh],
    ]);
  });

  it("holds a window command lease through stale-link compensation", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    const staleRestore = deferred<TabRefreshState>();
    const compensationStarted = deferred<void>();
    const releaseCompensation = deferred<void>();
    let unlinkAttempt = 0;
    const harness = createHarness({
      tabs,
      unlinkWindow: async () => {
        unlinkAttempt += 1;
        if (unlinkAttempt === 2) {
          compensationStarted.resolve();
          await releaseCompensation.promise;
        }
      },
    });
    const stalePort = await harness.registerAndConnect(
      "channel-window-lease-stale",
      17,
      "source-window-lease-stale",
    );
    await harness.registerAndConnect(
      "channel-window-lease-current",
      18,
      "source-window-lease-current",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-window-lease-stale",
    }, panelSender("channel-window-lease-stale"))).resolves.toEqual({
      ok: true,
    });
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) =>
      tabId === 17
        ? await staleRestore.promise
        : {
            ...defaultTabState(tabId, windowId),
            participant: true,
          };
    const panelOpenBaseline = harness.tabRefresh.panelOpenCalls.length;

    const staleLink = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-window-lease-stale",
      code: "4873507",
    }, panelSender("channel-window-lease-stale"));
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelOpenCalls).toHaveLength(
        panelOpenBaseline + 1,
      );
    });
    stalePort.disconnect();
    staleRestore.resolve({
      ...defaultTabState(17, 10),
      participant: true,
    });
    await compensationStarted.promise;

    const overlappingResult = await harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-window-lease-current",
      code: "4873507",
    }, panelSender("channel-window-lease-current"));

    releaseCompensation.resolve();
    await expect(staleLink).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(overlappingResult).toEqual({
      ok: false,
      error: "busy",
    });
    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-window-lease-current",
      code: "4873507",
    }, panelSender("channel-window-lease-current"))).resolves.toEqual({
      ok: true,
    });
    await flushMicrotasks();

    expect(harness.coordinator.unlinks).toEqual([10, 10]);
    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toEqual([
      [10, 18, refresh],
    ]);
  });

  it("allows window commands in different windows to overlap", async () => {
    const tabs = new Map([
      [17, 10],
      [27, 20],
    ]);
    const firstLinkStarted = deferred<void>();
    const releaseFirstLink = deferred<void>();
    const harness = createHarness({
      tabs,
      linkWindow: async (windowId) => {
        if (windowId === 10) {
          firstLinkStarted.resolve();
          await releaseFirstLink.promise;
        }
      },
    });
    await harness.registerAndConnect(
      "channel-window-lease-first",
      17,
      "source-window-lease-first",
    );
    await harness.registerAndConnect(
      "channel-window-lease-other",
      27,
      "source-window-lease-other",
    );
    await flushMicrotasks();

    const firstLink = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-window-lease-first",
      code: "4873507",
    }, panelSender("channel-window-lease-first"));
    await firstLinkStarted.promise;

    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-window-lease-other",
      code: "4873507",
    }, panelSender("channel-window-lease-other"))).resolves.toEqual({
      ok: true,
    });
    releaseFirstLink.resolve();
    await expect(firstLink).resolves.toEqual({ ok: true });
    expect(harness.coordinator.links.map(({ windowId }) => windowId)).toEqual([
      10,
      20,
    ]);
  });

  it("compensates a partial window restore and retries every participant", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      tabs,
      linkWindow: async (windowId) => {
        harness.coordinator.emitState(windowId, "linked");
      },
      unlinkWindow: async (windowId) => {
        harness.coordinator.emitState(windowId, "notLinked");
      },
    });
    const firstPort = await harness.registerAndConnect(
      "channel-relink-retry",
      17,
      "source-relink-retry",
    );
    const secondPort = await harness.registerAndConnect(
      "channel-relink-retry-sibling",
      18,
      "source-relink-retry-sibling",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-retry",
    }, panelSender("channel-relink-retry"))).resolves.toEqual({ ok: true });

    const restoreCalls: number[] = [];
    let siblingFailures = 0;
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) => {
      restoreCalls.push(tabId);
      if (tabId === 18 && siblingFailures++ === 0) {
        throw new Error("transient sibling snapshot failure");
      }
      return {
        ...defaultTabState(tabId, windowId),
        participant: true,
      };
    };
    const firstFailedMessageStart = firstPort.sent.length;
    const secondFailedMessageStart = secondPort.sent.length;
    const firstWindowStateStart = windowStates(firstPort).length;
    const secondWindowStateStart = windowStates(secondPort).length;

    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-retry",
      code: "4873507",
    }, panelSender("channel-relink-retry"))).resolves.toEqual({
      ok: false,
      error: "error",
    });
    await flushMicrotasks();

    expect(restoreCalls).toEqual([17, 18]);
    expect(harness.coordinator.unlinks).toEqual([10, 10]);
    expect(harness.tabRefresh.removedWindows).toEqual([10, 10]);
    expect(windowStates(firstPort).slice(firstWindowStateStart)).toContain(
      "linked",
    );
    expect(windowStates(secondPort).slice(secondWindowStateStart)).toContain(
      "linked",
    );
    expect(windowStates(firstPort).at(-1)).toBe("notLinked");
    expect(windowStates(secondPort).at(-1)).toBe("notLinked");
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(await harness.tabRefresh.state(18, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(
      firstPort.sent
        .slice(firstFailedMessageStart)
        .filter(isPanelTabStateMessage),
    ).not.toContainEqual(expect.objectContaining({ participant: true }));
    expect(
      secondPort.sent
        .slice(secondFailedMessageStart)
        .filter(isPanelTabStateMessage),
    ).not.toContainEqual(expect.objectContaining({ participant: true }));
    const rejectedRefresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, rejectedRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);

    const firstRetryMessageStart = firstPort.sent.length;
    const secondRetryMessageStart = secondPort.sent.length;
    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-retry-sibling",
      code: "4873507",
    }, panelSender("channel-relink-retry-sibling"))).resolves.toEqual({
      ok: true,
    });
    await flushMicrotasks();

    expect(restoreCalls).toEqual([17, 18, 17, 18]);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(await harness.tabRefresh.state(18, 10)).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(
      firstPort.sent
        .slice(firstRetryMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(
      secondPort.sent
        .slice(secondRetryMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
    const acceptedRefresh = pageRefresh(2);
    harness.pageRefreshes.emit(10, acceptedRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([
      [10, acceptedRefresh],
    ]);
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toEqual([
      [10, 17, acceptedRefresh],
      [10, 18, acceptedRefresh],
    ]);
  });

  it("compensates a failed current-state read and retries restoration", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-relink-snapshot",
      17,
      "source-relink-snapshot",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-snapshot",
    }, panelSender("channel-relink-snapshot"))).resolves.toEqual({ ok: true });
    let stateReadAttempt = 0;
    harness.tabRefresh.stateBehavior = async (tabId, windowId) => {
      stateReadAttempt += 1;
      if (stateReadAttempt === 1) {
        throw new Error("transient current-state read failure");
      }
      return {
        ...defaultTabState(tabId, windowId),
        participant: true,
      };
    };
    const failedMessageStart = port.sent.length;

    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-snapshot",
      code: "4873507",
    }, panelSender("channel-relink-snapshot"))).resolves.toEqual({
      ok: false,
      error: "error",
    });
    await flushMicrotasks();

    expect(stateReadAttempt).toBe(1);
    expect(harness.coordinator.unlinks).toEqual([10, 10]);
    expect(
      port.sent.slice(failedMessageStart).filter(isPanelTabStateMessage),
    ).not.toContainEqual(expect.objectContaining({ participant: true }));
    const rejectedRefresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, rejectedRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);

    const retryMessageStart = port.sent.length;
    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-snapshot",
      code: "4873507",
    }, panelSender("channel-relink-snapshot"))).resolves.toEqual({ ok: true });
    await flushMicrotasks();

    expect(stateReadAttempt).toBe(2);
    expect(
      port.sent.slice(retryMessageStart).filter(isPanelTabStateMessage).at(-1),
    ).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });
  });

  it("commits multi-panel restoration snapshots atomically after every state read", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    const harness = createHarness({ tabs });
    const firstPort = await harness.registerAndConnect(
      "channel-atomic-restore-first",
      17,
      "source-atomic-restore-first",
    );
    const secondPort = await harness.registerAndConnect(
      "channel-atomic-restore-second",
      18,
      "source-atomic-restore-second",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-atomic-restore-first",
    }, panelSender("channel-atomic-restore-first"))).resolves.toEqual({
      ok: true,
    });

    const stateReads: number[] = [];
    let failSecondRead = true;
    harness.tabRefresh.stateBehavior = async (tabId, windowId) => {
      stateReads.push(tabId);
      if (tabId === 18 && failSecondRead) {
        failSecondRead = false;
        throw new Error("transient second-panel state failure");
      }
      return {
        ...defaultTabState(tabId, windowId),
        participant: true,
      };
    };
    const firstFailedMessageStart = firstPort.sent.length;
    const secondFailedMessageStart = secondPort.sent.length;

    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-atomic-restore-first",
      code: "4873507",
    }, panelSender("channel-atomic-restore-first"))).resolves.toEqual({
      ok: false,
      error: "error",
    });
    await flushMicrotasks();

    expect(stateReads).toEqual([17, 18]);
    expect(
      firstPort.sent
        .slice(firstFailedMessageStart)
        .filter(isPanelTabStateMessage),
    ).not.toContainEqual(expect.objectContaining({ participant: true }));
    expect(
      secondPort.sent
        .slice(secondFailedMessageStart)
        .filter(isPanelTabStateMessage),
    ).not.toContainEqual(expect.objectContaining({ participant: true }));
    expect(harness.coordinator.unlinks).toEqual([10, 10]);
    const rejectedRefresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, rejectedRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);

    const firstRetryMessageStart = firstPort.sent.length;
    const secondRetryMessageStart = secondPort.sent.length;
    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-atomic-restore-second",
      code: "4873507",
    }, panelSender("channel-atomic-restore-second"))).resolves.toEqual({
      ok: true,
    });
    await flushMicrotasks();

    expect(stateReads).toEqual([17, 18, 17, 18]);
    expect(harness.tabRefresh.panelOpenCalls).toEqual([
      [17, 10],
      [18, 10],
      [17, 10],
      [18, 10],
      [17, 10],
      [18, 10],
    ]);
    expect(
      firstPort.sent
        .slice(firstRetryMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({ participant: true });
    expect(
      secondPort.sent
        .slice(secondRetryMessageStart)
        .filter(isPanelTabStateMessage)
        .at(-1),
    ).toMatchObject({ participant: true });
    const acceptedRefresh = pageRefresh(2);
    harness.pageRefreshes.emit(10, acceptedRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toEqual([
      [10, 17, acceptedRefresh],
      [10, 18, acceptedRefresh],
    ]);
  });

  it("does not overwrite settings queued during relink restoration", async () => {
    const tabs = new Map([[17, 10]]);
    const restorePostflightStarted = deferred<void>();
    const releaseRestorePostflight = deferred<void>();
    let gateRestorePostflight = false;
    let linkLookup = 0;
    const harness = createHarness({
      tabs,
      getTab: async (tabId) => {
        if (gateRestorePostflight && tabId === 17) {
          linkLookup += 1;
          if (linkLookup === 3) {
            restorePostflightStarted.resolve();
            await releaseRestorePostflight.promise;
          }
        }
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      },
    });
    const port = await harness.registerAndConnect(
      "channel-relink-settings",
      17,
      "source-relink-settings",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-settings",
    }, panelSender("channel-relink-settings"))).resolves.toEqual({ ok: true });
    const settingsBaseline = harness.tabRefresh.settingCalls.length;
    gateRestorePostflight = true;

    const linking = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-settings",
      code: "4873507",
    }, panelSender("channel-relink-settings"));
    await restorePostflightStarted.promise;

    port.emitMessage({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await vi.waitFor(() => {
      expect(harness.tabRefresh.settingCalls).toHaveLength(
        settingsBaseline + 1,
      );
    });
    expect(port.sent.filter(isPanelTabStateMessage).at(-1)).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });

    releaseRestorePostflight.resolve();
    await expect(linking).resolves.toEqual({ ok: true });
    await flushMicrotasks();

    expect(port.sent.filter(isPanelTabStateMessage).at(-1)).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);
  });

  it("preserves invalidation when a captured panel moves before restore commit", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    const siblingPostflightStarted = deferred<void>();
    const releaseSiblingPostflight = deferred<void>();
    let gateSiblingPostflight = false;
    let siblingLinkLookup = 0;
    const harness = createHarness({
      tabs,
      getTab: async (tabId) => {
        if (gateSiblingPostflight && tabId === 18) {
          siblingLinkLookup += 1;
          if (siblingLinkLookup === 3) {
            siblingPostflightStarted.resolve();
            await releaseSiblingPostflight.promise;
          }
        }
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      },
    });
    const movedPort = await harness.registerAndConnect(
      "channel-relink-reused-record",
      17,
      "source-relink-reused-record",
    );
    await harness.registerAndConnect(
      "channel-relink-reused-sibling",
      18,
      "source-relink-reused-sibling",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-reused-record",
    }, panelSender("channel-relink-reused-record"))).resolves.toEqual({
      ok: true,
    });
    gateSiblingPostflight = true;

    const oldWindowLink = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-reused-sibling",
      code: "4873507",
    }, panelSender("channel-relink-reused-sibling"));
    await siblingPostflightStarted.promise;

    tabs.set(17, 20);
    movedPort.emitMessage({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelOpenCalls).toContainEqual([17, 20]);
      expect(harness.tabRefresh.settingCalls).toContainEqual([
        17,
        20,
        { autoRefreshEnabled: true, ideHighlightEnabled: true },
      ]);
    });
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-reused-record",
    }, panelSender("channel-relink-reused-record"))).resolves.toEqual({
      ok: true,
    });
    const movedPanelOpenBaseline = harness.tabRefresh.panelOpenCalls.filter(
      ([tabId, windowId]) => tabId === 17 && windowId === 20,
    ).length;

    releaseSiblingPostflight.resolve();
    const oldWindowResult = await oldWindowLink;
    await expect(harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-reused-record",
      code: "4873507",
    }, panelSender("channel-relink-reused-record"))).resolves.toEqual({
      ok: true,
    });
    await flushMicrotasks();

    expect(oldWindowResult).toEqual({ ok: false, error: "error" });
    expect(
      harness.tabRefresh.panelOpenCalls.filter(
        ([tabId, windowId]) => tabId === 17 && windowId === 20,
      ),
    ).toHaveLength(movedPanelOpenBaseline + 1);
    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(20, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedParticipantRefreshCalls).toContainEqual([
      20,
      17,
      refresh,
    ]);
  });

  it("compensates when another panel closes during window restoration", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 10],
    ]);
    const siblingRestore = deferred<TabRefreshState>();
    const harness = createHarness({ tabs });
    await harness.registerAndConnect(
      "channel-relink-close-owner",
      17,
      "source-relink-close-owner",
    );
    const siblingPort = await harness.registerAndConnect(
      "channel-relink-close-sibling",
      18,
      "source-relink-close-sibling",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-close-owner",
    }, panelSender("channel-relink-close-owner"))).resolves.toEqual({ ok: true });
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) =>
      tabId === 18
        ? await siblingRestore.promise
        : {
            ...defaultTabState(tabId, windowId),
            participant: true,
          };
    const panelOpenBaseline = harness.tabRefresh.panelOpenCalls.length;

    const linking = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-close-owner",
      code: "4873507",
    }, panelSender("channel-relink-close-owner"));
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelOpenCalls).toHaveLength(
        panelOpenBaseline + 2,
      );
      expect(harness.tabRefresh.panelOpenCalls.slice(-2)).toEqual([
        [17, 10],
        [18, 10],
      ]);
    });

    siblingPort.disconnect();
    siblingRestore.resolve({
      ...defaultTabState(18, 10),
      participant: true,
    });
    await expect(linking).resolves.toEqual({
      ok: false,
      error: "error",
    });
    await flushMicrotasks();

    expect(harness.coordinator.unlinks).toEqual([10, 10]);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
    });
    expect(await harness.tabRefresh.state(18, 10)).toMatchObject({
      participant: false,
    });
    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);
  });

  it("does not restore refresh authority when the panel closes during relink initialization", async () => {
    const restore = deferred<TabRefreshState>();
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-relink-close",
      17,
      "source-relink-close",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-close",
    }, panelSender("channel-relink-close"))).resolves.toEqual({ ok: true });
    harness.tabRefresh.panelOpenedBehavior = () => restore.promise;

    const linking = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-close",
      code: "4873507",
    }, panelSender("channel-relink-close"));
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelOpenCalls).toHaveLength(2);
    });

    port.disconnect();
    restore.resolve({
      ...defaultTabState(17, 10),
      participant: true,
    });
    await expect(linking).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();

    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
    });
    const refresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, refresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);
  });

  it("does not restore old-window authority when the panel moves during relink initialization", async () => {
    const tabs = new Map([[17, 10]]);
    const restore = deferred<TabRefreshState>();
    let restoreAttempt = 0;
    const harness = createHarness({ tabs });
    await harness.registerAndConnect(
      "channel-relink-move",
      17,
      "source-relink-move",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-relink-move",
    }, panelSender("channel-relink-move"))).resolves.toEqual({ ok: true });
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) => {
      restoreAttempt += 1;
      return restoreAttempt === 1
        ? await restore.promise
        : {
            ...defaultTabState(tabId, windowId),
            participant: true,
          };
    };

    const linking = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-relink-move",
      code: "4873507",
    }, panelSender("channel-relink-move"));
    await vi.waitFor(() => expect(restoreAttempt).toBe(1));

    tabs.set(17, 20);
    restore.resolve({
      ...defaultTabState(17, 10),
      participant: true,
    });
    await expect(linking).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();

    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
    });
    expect(await harness.tabRefresh.state(17, 20)).toMatchObject({
      participant: true,
    });
    const staleWindowRefresh = pageRefresh(1);
    harness.pageRefreshes.emit(10, staleWindowRefresh);
    await flushMicrotasks();
    expect(harness.tabRefresh.acceptedRefreshCalls).toEqual([]);
  });

  it("does not reopen refresh participation from a linked callback for a stale link", async () => {
    const linkGate = deferred<void>();
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      linkWindow: async () => {
        harness.coordinator.emitState(10, "linked");
        await linkGate.promise;
      },
    });
    const port = await harness.registerAndConnect(
      "channel-stale-relink",
      17,
      "source-stale-relink",
    );
    await flushMicrotasks();
    await expect(harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-stale-relink",
    }, panelSender("channel-stale-relink"))).resolves.toEqual({ ok: true });
    const panelOpenCount = harness.tabRefresh.panelOpenCalls.length;

    const linking = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-stale-relink",
      code: "4873507",
    }, panelSender("channel-stale-relink"));
    await vi.waitFor(() => expect(harness.coordinator.links).toHaveLength(1));
    await flushMicrotasks();
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
    });

    port.disconnect();
    linkGate.resolve();
    await expect(linking).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toHaveLength(panelOpenCount);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
    });
  });

  it("publishes a fresh tab snapshot only after linked compatibility", async () => {
    const harness = createHarness({ initialPanelState: "notLinked" });
    const preHandshake = deferred<TabRefreshState>();
    const postCompatibility = deferred<TabRefreshState>();
    harness.tabRefresh.panelOpenedBehavior = () => preHandshake.promise;
    harness.tabRefresh.stateBehavior = () => postCompatibility.promise;
    const port = await harness.registerAndConnect(
      "channel-ordering",
      17,
      "source-ordering",
    );

    preHandshake.resolve(defaultTabState(17, 10));
    await flushMicrotasks();

    const earlyStateIndex = port.sent.findIndex(isPanelTabStateMessage);
    expect(earlyStateIndex).toBeGreaterThanOrEqual(0);
    expect(port.sent.findIndex(isCompatibleMessage)).toBe(-1);
    expect(harness.tabRefresh.stateCalls).toEqual([]);
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(1);

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();

    const compatibilityIndex = port.sent.findIndex(isCompatibleMessage);
    expect(compatibilityIndex).toBeGreaterThan(earlyStateIndex);
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(1);

    postCompatibility.resolve({
      ...defaultTabState(17, 10),
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
    });
    await flushMicrotasks();

    const snapshots = port.sent.filter(isPanelTabStateMessage);
    expect(snapshots).toHaveLength(2);
    expect(port.sent.lastIndexOf(snapshots[1])).toBeGreaterThan(
      compatibilityIndex,
    );
    expect(snapshots[1]).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
    });
    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
  });

  it("does not reuse a delayed panel-open snapshot after compatibility", async () => {
    const harness = createHarness();
    const panelOpened = deferred<TabRefreshState>();
    const freshState = deferred<TabRefreshState>();
    let initialized = false;
    harness.tabRefresh.panelOpenedBehavior = async () => {
      const state = await panelOpened.promise;
      initialized = true;
      return state;
    };
    harness.tabRefresh.stateBehavior = () => {
      expect(initialized).toBe(true);
      return freshState.promise;
    };
    const port = await harness.registerAndConnect(
      "channel-delayed-open",
      17,
      "source-delayed-open",
    );
    await flushMicrotasks();

    expect(port.sent.findIndex(isCompatibleMessage)).toBeGreaterThanOrEqual(0);
    expect(harness.tabRefresh.stateCalls).toEqual([]);
    expect(port.sent.filter(isPanelTabStateMessage)).toEqual([]);

    panelOpened.resolve({
      ...defaultTabState(17, 10),
      ideHighlightEnabled: false,
      participant: true,
    });
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);
    expect(port.sent.filter(isPanelTabStateMessage)).toEqual([]);

    freshState.resolve({
      ...defaultTabState(17, 10),
      ideHighlightEnabled: false,
      participant: true,
    });
    await flushMicrotasks();
    expect(port.sent.filter(isPanelTabStateMessage)).toEqual([{
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 0,
    }]);
  });

  it("publishes a fresh snapshot after offline recovery without reopening participation", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-recovery-settings",
      17,
      "source-recovery-settings",
    );
    await flushMicrotasks();
    const initialStateReads = harness.tabRefresh.stateCalls.length;
    const marker = port.sent.length;
    harness.tabRefresh.setState({
      ...defaultTabState(17, 10),
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });

    harness.coordinator.emitState(10, "offline");
    await flushMicrotasks();
    harness.coordinator.emitState(10, "reconnecting");
    await flushMicrotasks();
    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
    expect(harness.tabRefresh.stateCalls).toHaveLength(initialStateReads + 1);
    const recoveryMessages = port.sent.slice(marker);
    const compatibilityIndex = recoveryMessages.findIndex(isCompatibleMessage);
    const snapshotIndex = recoveryMessages.findIndex(isPanelTabStateMessage);
    expect(compatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(compatibilityIndex);
    expect(recoveryMessages[snapshotIndex]).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
  });

  it("drops a delayed linked snapshot from an old panel activation", async () => {
    const harness = createHarness();
    const stale = deferred<TabRefreshState>();
    const current = deferred<TabRefreshState>();
    const staleInitialization = deferred<TabRefreshState>();
    const currentInitialization = deferred<TabRefreshState>();
    let initialization = 0;
    let stateRead = 0;
    harness.tabRefresh.panelOpenedBehavior = () => {
      initialization += 1;
      return initialization === 1
        ? staleInitialization.promise
        : currentInitialization.promise;
    };
    harness.tabRefresh.stateBehavior = () => {
      stateRead += 1;
      return stateRead === 1 ? stale.promise : current.promise;
    };
    const oldPort = await harness.registerAndConnect(
      "channel-stale-settings",
      17,
      "source-stale-settings",
    );
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([]);
    staleInitialization.resolve(defaultTabState(17, 10));
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);

    oldPort.disconnect();
    const currentPort = harness.panelPort("channel-stale-settings");
    harness.router.connectPort(currentPort);
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);
    currentInitialization.resolve(defaultTabState(17, 10));
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10], [17, 10]]);

    stale.resolve({
      ...defaultTabState(17, 10),
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    await flushMicrotasks();
    expect(currentPort.sent.filter(isPanelTabStateMessage)).toEqual([]);

    current.resolve(defaultTabState(17, 10));
    await flushMicrotasks();
    expect(currentPort.sent.filter(isPanelTabStateMessage)).toEqual([{
      type: "pin-op.tab.state",
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 0,
    }]);
  });

  it("posts offline without waiting for a delayed linked snapshot", async () => {
    const harness = createHarness();
    const delayed = deferred<TabRefreshState>();
    harness.tabRefresh.stateBehavior = () => delayed.promise;
    const port = await harness.registerAndConnect(
      "channel-offline-snapshot",
      17,
      "source-offline-snapshot",
    );
    await flushMicrotasks();
    const snapshotBaseline = port.sent.filter(isPanelTabStateMessage).length;

    harness.coordinator.emitState(10, "offline");
    await flushMicrotasks();

    expect(windowStates(port).at(-1)).toBe("offline");
    delayed.resolve(defaultTabState(17, 10));
    await flushMicrotasks();
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(
      snapshotBaseline,
    );
  });

  it("posts incompatibility without waiting for a delayed linked snapshot", async () => {
    const harness = createHarness();
    const delayed = deferred<TabRefreshState>();
    harness.tabRefresh.stateBehavior = () => delayed.promise;
    const port = await harness.registerAndConnect(
      "channel-mismatch-snapshot",
      17,
      "source-mismatch-snapshot",
    );
    await flushMicrotasks();
    const snapshotBaseline = port.sent.filter(isPanelTabStateMessage).length;

    harness.coordinator.emitState(10, "incompatible", {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushMicrotasks();

    expect(windowStates(port).at(-1)).toBe("incompatible");
    expect(messagesOfType(port, "pin-op.protocol.compatibility").at(-1))
      .toMatchObject({
        compatible: false,
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: 5,
      });
    delayed.resolve(defaultTabState(17, 10));
    await flushMicrotasks();
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(
      snapshotBaseline,
    );
  });

  it("disposes inspection while a linked snapshot never resolves", async () => {
    const harness = createHarness();
    const never = deferred<TabRefreshState>();
    harness.tabRefresh.stateBehavior = () => never.promise;
    const port = await harness.registerAndConnect(
      "channel-hung-snapshot",
      17,
      "source-hung-snapshot",
    );
    await harness.attachContentSession(17, "content-hung-snapshot");
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    harness.coordinator.emitState(10, "incompatible", {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(windowStates(port).at(-1)).toBe("incompatible");
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "pin-op.inspect.disposeSession" },
    ]);
  });

  it("retries failed panel initialization on a later linked transition", async () => {
    const harness = createHarness();
    let initializationAttempt = 0;
    harness.tabRefresh.panelOpenedBehavior = async (tabId, windowId) => {
      initializationAttempt += 1;
      if (initializationAttempt === 1) {
        throw new Error("transient panel initialization failure");
      }
      return {
        ...defaultTabState(tabId, windowId),
        participant: true,
      };
    };
    harness.tabRefresh.stateBehavior = async (tabId, windowId) => ({
      ...defaultTabState(tabId, windowId),
      ideHighlightEnabled: false,
      participant: true,
    });
    const port = await harness.registerAndConnect(
      "channel-init-retry",
      17,
      "source-init-retry",
    );
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
    expect(harness.tabRefresh.stateCalls).toEqual([]);
    expect(harness.reportedErrors).toHaveLength(1);
    const marker = port.sent.length;

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();

    expect(harness.tabRefresh.panelOpenCalls).toEqual([
      [17, 10],
      [17, 10],
    ]);
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);
    const retryMessages = port.sent.slice(marker);
    const compatibilityIndex = retryMessages.findIndex(isCompatibleMessage);
    const snapshotIndex = retryMessages.findIndex(isPanelTabStateMessage);
    expect(snapshotIndex).toBeGreaterThan(compatibilityIndex);
    expect(retryMessages[snapshotIndex]).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
    });

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();
    expect(harness.tabRefresh.panelOpenCalls).toHaveLength(2);
    expect(harness.tabRefresh.stateCalls).toHaveLength(2);
  });

  it("retries a transient linked state read on the next transition", async () => {
    const harness = createHarness({ initialPanelState: "notLinked" });
    let stateRead = 0;
    harness.tabRefresh.stateBehavior = async (tabId, windowId) => {
      stateRead += 1;
      if (stateRead === 1) {
        throw new Error("transient tab state failure");
      }
      return {
        ...defaultTabState(tabId, windowId),
        autoRefreshEnabled: false,
        ideHighlightEnabled: true,
      };
    };
    const port = await harness.registerAndConnect(
      "channel-state-retry",
      17,
      "source-state-retry",
    );
    await flushMicrotasks();
    const snapshotBaseline = port.sent.filter(isPanelTabStateMessage).length;

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([[17, 10]]);
    expect(harness.reportedErrors).toHaveLength(1);
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(
      snapshotBaseline,
    );

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();
    expect(harness.tabRefresh.stateCalls).toEqual([
      [17, 10],
      [17, 10],
    ]);
    expect(port.sent.filter(isPanelTabStateMessage).at(-1)).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
    });
    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
  });

  it("invalidates a linked snapshot when a newer state is only queued", async () => {
    const blockedLookup = deferred<
      { id: number; windowId: number } | undefined
    >();
    const delayed = deferred<TabRefreshState>();
    let blockNextLookup = false;
    let blockedCalls = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (blockNextLookup && ++blockedCalls === 1) {
          return blockedLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    harness.tabRefresh.stateBehavior = () => delayed.promise;
    const port = await harness.registerAndConnect(
      "channel-revision",
      17,
      "source-revision",
    );
    await flushMicrotasks();
    const snapshotBaseline = port.sent.filter(isPanelTabStateMessage).length;
    blockNextLookup = true;

    harness.coordinator.emitState(10, "offline");
    await Promise.resolve();
    delayed.resolve(defaultTabState(17, 10));
    await flushMicrotasks();

    expect(blockedCalls).toBe(1);
    expect(port.sent.filter(isPanelTabStateMessage)).toHaveLength(
      snapshotBaseline,
    );
    blockedLookup.resolve({ id: 17, windowId: 10 });
    await flushMicrotasks();
    expect(windowStates(port).at(-1)).toBe("offline");
  });

  it("keeps eligibility independent of panel state and revokes explicit window authority", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-revoke", 17, "source-revoke");
    await flushMicrotasks();
    expect(harness.contentRefresh.windowEligibility).toEqual([]);

    harness.coordinator.emitState(10, "offline");
    expect(harness.contentRefresh.windowEligibility).toEqual([]);

    harness.protocolMismatches.emit(10, {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    expect(harness.contentRefresh.revokedWindows).toContain(10);

    const revocationCount = harness.contentRefresh.revokedWindows.length;
    const unlink = harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-revoke",
    }, panelSender("channel-revoke"));
    expect(harness.contentRefresh.revokedWindows).toHaveLength(
      revocationCount,
    );
    await expect(unlink).resolves.toEqual({ ok: true });
    expect(harness.contentRefresh.revokedWindows.at(-1)).toBe(10);
  });

  it("routes page refresh by the exact window and uses current tab highlight state for inspect", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-refresh",
      17,
      "source-refresh",
    );
    await harness.attachContentSession(17);
    harness.tabRefresh.setState({
      tabId: 17,
      windowId: 10,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 0,
    });
    const message = pageRefresh(3);

    harness.pageRefreshes.emit(10, message);
    await flushMicrotasks();
    expect(harness.tabRefresh.refreshCalls).toEqual([[10, message]]);

    await expect(
      harness.router.routeMessage(
        selectedMessage(DEFAULT_CONTENT_SESSION_ID),
        contentSender(17, 10),
      ),
    ).resolves.toEqual({ ok: true });
    expect(harness.coordinator.published.at(-1)?.payload)
      .toMatchObject({ ideHighlightEnabled: false });
    expect(port.disconnected).toBe(false);
  });

  it("clears exact-window pending refresh when the peer becomes incompatible", async () => {
    const harness = createHarness();

    harness.protocolMismatches.emit(10, {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    await flushMicrotasks();

    expect(harness.tabRefresh.clearedPendingWindows).toEqual([10]);
  });

  it("blocks incompatible panel features while preserving explicit disconnect", async () => {
    const mismatch: BrowserProtocolMismatch = {
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    };
    const harness = createHarness({
      initialPanelState: "incompatible",
      initialProtocolMismatch: mismatch,
    });
    const port = await harness.registerAndConnect(
      "channel-mismatch",
      17,
      "source-mismatch",
    );
    await flushMicrotasks();

    expect(port.sent).toContainEqual({
      type: "pin-op.protocol.compatibility",
      compatible: false,
      browserProtocolVersion: PROTOCOL_VERSION,
      peerProtocolVersion: 5,
    });
    port.emitMessage({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await flushMicrotasks();
    expect(harness.tabRefresh.settingCalls).toEqual([]);

    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
          channel: "channel-mismatch",
        },
        panelSender("channel-mismatch"),
      ),
    ).resolves.toEqual({ ok: true });
    expect(harness.coordinator.unlinks).toEqual([10]);
    expect(harness.tabRefresh.removedWindows).toEqual([10]);
  });
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
    expect(messagesOfType(port, "pin-op.windowState")).toEqual([
      {
        type: "pin-op.windowState",
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

    expect(messagesOfType(port, "pin-op.windowState").at(-1)).toEqual({
      type: "pin-op.windowState",
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

  it("fails closed when a panel disappears during pending registration", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({ getTab: async () => tabLookup.promise });
    const port = harness.panelPort("channel-pending-close");
    harness.router.connectPort(port);
    const registration = harness.router.routeMessage(
      registerMessage("channel-pending-close", 17, "source-pending-close"),
      devtoolsSender(),
    );
    await flushMicrotasks();

    port.disconnect();

    expect(harness.contentRefresh.revokedTabs).toContain(17);
    expect(harness.tabRefresh.panelCloseCalls).toContainEqual([17, undefined]);
    tabLookup.resolve({ id: 17, windowId: 10 });
    await expect(registration).resolves.toBeUndefined();
    expect(harness.coordinator.registrations).toEqual([]);
    expect(harness.tabRefresh.panelOpenCalls).toEqual([]);
  });

  it("lets a new same-channel panel supersede a closed pending port", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({ getTab: async () => tabLookup.promise });
    const oldPort = harness.panelPort("channel-pending-reopen");
    harness.router.connectPort(oldPort);
    const registration = harness.router.routeMessage(
      registerMessage("channel-pending-reopen", 17, "source-pending-reopen"),
      devtoolsSender(),
    );
    await flushMicrotasks();
    oldPort.disconnect();
    const newPort = harness.panelPort("channel-pending-reopen");
    harness.router.connectPort(newPort);

    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(registration).resolves.toEqual({ ok: true });
    await flushMicrotasks();
    expect(newPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual([
      "source-pending-reopen",
    ]);
    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
  });

  it("does not let a superseded pending channel revoke the new panel owner", async () => {
    const oldLookup = deferred<{ id: number; windowId: number }>();
    let lookup = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookup += 1;
        return lookup === 1
          ? oldLookup.promise
          : { id: tabId, windowId: 10 };
      },
    });
    const oldPort = harness.panelPort("channel-pending-old");
    harness.router.connectPort(oldPort);
    const oldRegistration = harness.router.routeMessage(
      registerMessage("channel-pending-old", 17, "source-pending-old"),
      devtoolsSender(),
    );
    await flushMicrotasks();
    const newPort = await harness.registerAndConnect(
      "channel-pending-new",
      17,
      "source-pending-new",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelCloseCalls.length = 0;
    harness.contentRefresh.revokedTabs.length = 0;

    oldPort.disconnect();
    oldLookup.resolve({ id: 17, windowId: 10 });

    await expect(oldRegistration).resolves.toBeUndefined();
    expect(newPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual(["source-pending-new"]);
    expect(harness.tabRefresh.panelCloseCalls).toEqual([]);
    expect(harness.contentRefresh.revokedTabs).toEqual([]);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: true,
    });
  });

  it("marks a removed tab terminal before closing its active panel", async () => {
    const events = createRouterSubscriptionHarness();
    const harness = createHarness({ subscriptions: events.subscriptions });
    const port = await harness.registerAndConnect(
      "channel-terminal-order",
      17,
      "source-terminal-order",
    );
    await flushMicrotasks();
    harness.tabRefresh.lifecycleCalls.length = 0;

    events.removeTab(17);

    expect(port.disconnected).toBe(true);
    expect(harness.tabRefresh.lifecycleCalls.slice(0, 2)).toEqual([
      "removeTab:17",
      "panelClosed:17:10",
    ]);
  });

  it("fences a removed window before closing its active panels", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-window-order",
      17,
      "source-window-order",
    );
    await flushMicrotasks();
    harness.tabRefresh.lifecycleCalls.length = 0;

    await harness.router.removeWindow(10);

    expect(port.disconnected).toBe(true);
    expect(harness.tabRefresh.lifecycleCalls.slice(0, 2)).toEqual([
      "removeWindow:10",
      "panelClosed:17:10",
    ]);
  });

  it("does not let a delayed old-window close overwrite the new panel owner", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const oldPort = await harness.registerAndConnect(
      "channel-old-window",
      17,
      "source-old-window",
    );
    await flushMicrotasks();
    const closeGate = deferred<void>();
    let delayedCloseCalls = 0;
    harness.tabRefresh.panelClosedBehavior = async () => {
      delayedCloseCalls += 1;
      await closeGate.promise;
    };

    tabs.set(17, 20);
    const newPort = harness.panelPort("channel-new-window");
    harness.router.connectPort(newPort);
    const registration = harness.router.routeMessage(
      registerMessage("channel-new-window", 17, "source-new-window"),
      devtoolsSender(),
    );
    await vi.waitFor(() => expect(delayedCloseCalls).toBe(1));

    expect(oldPort.disconnected).toBe(true);
    expect(newPort.disconnected).toBe(false);
    expect(harness.tabRefresh.panelCloseCalls).toContainEqual([17, 10]);
    expect(harness.coordinator.activeSources()).toEqual([]);

    closeGate.resolve();
    await expect(registration).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelOpenCalls.at(-1)).toEqual([17, 20]);
    });
    expect(await harness.tabRefresh.state(17, 20)).toMatchObject({
      windowId: 20,
      participant: true,
    });

    harness.tabRefresh.panelClosedBehavior = undefined;
    await harness.tabRefresh.panelClosed(17, 10);
    expect(await harness.tabRefresh.state(17, 20)).toMatchObject({
      windowId: 20,
      participant: true,
    });
  });

  it("bounds pending ports and disconnects malformed, duplicate, and overflow ports", () => {
    const harness = createHarness({ maxPanelPorts: 2 });
    const malformed = harness.port("pin-op.devtools.bad/channel");
    const wrongPage = harness.panelPort("wrong-page", {
      url: "moz-extension://pin-op/dist/other.html?channel=wrong-page",
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
    expect(messagesOfType(recoveredPort, "pin-op.windowState")).toEqual([
      {
        type: "pin-op.windowState",
        state: "notLinked",
      },
    ]);

    const sentCount = recoveredPort.sent.length;
    oldRegistration?.onStateChanged?.("linked");
    expect(recoveredPort.sent).toHaveLength(sentCount);
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
    await flushMicrotasks();

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
      type: "pin-op.inspect.started",
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

    expect(messagesOfType(panel, "pin-op.inspect.started")).toEqual([{
      type: "pin-op.inspect.started",
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
      harness.resolutions.emit(
        trustedIdePeer(),
        resolution(inspectMessageId, 1),
      );
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-2", 1));

    expect(messagesOfType(panel, "resolution")).toHaveLength(1);
    expect(panel.sent.filter((message) =>
      isRecord(message) &&
      (message.type === "pin-op.inspect.started" ||
        message.type === "pin-op.ideState")
    )).toEqual([
      {
        type: "pin-op.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 1,
      },
      {
        type: "pin-op.inspect.started",
        inspectMessageId: "inspect-2",
        selectionRevision: 1,
      },
      {
        type: "pin-op.ideState",
        status: "ide-disconnected",
        inspectMessageId: "inspect-2",
      },
    ]);
    expect(messagesOfType(panel, "pin-op.ideState")).toEqual([
      {
        type: "pin-op.ideState",
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 9));
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-2", 1));

    expect(messagesOfType(panel, "pin-op.inspect.started")).toEqual([
      {
        type: "pin-op.inspect.started",
        inspectMessageId: "inspect-1",
        selectionRevision: 1,
      },
      {
        type: "pin-op.inspect.started",
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 1));

    expect(messagesOfType(panel, "resolution")).toEqual([]);
    expect(messagesOfType(panel, "pin-op.ideState")).toEqual([
      {
        type: "pin-op.ideState",
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

    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 1));

    expect(messagesOfType(panelA, "resolution")).toEqual([
      resolution("inspect-1", 2),
    ]);
    expect(messagesOfType(panelB, "resolution")).toEqual([]);
  });

  it("rejects mismatched transport identity without consuming resolution authority", async () => {
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
    const trusted = trustedIdePeer();
    const spoofed = {
      ...resolution("inspect-1", 1),
      sessionId: "session-b",
      source: { role: "ide", id: "vscode-b" },
    } as ResolutionMessage;

    harness.resolutions.emit(trusted, spoofed);
    harness.resolutions.emit(trusted, resolution("inspect-1", 1));

    expect(messagesOfType(panel, "resolution")).toEqual([
      resolution("inspect-1", 1),
    ]);
  });

  it("publishes current source matches only to the exact active panel", async () => {
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
    const resolutionContext = trustedIdePeer();
    harness.resolutions.emit(
      resolutionContext,
      matchedResolution("inspect-1", 1),
    );
    const current = sourceMatchesMessage("inspect-1", 1);

    harness.sourceMatches.emit(
      trustedIdePeer({ windowId: 20 }),
      current,
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 0),
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 1, { sourceId: "vscode-b" }),
    );
    let spoofGetterCalls = 0;
    const spoofedContext = new Proxy({} as TrustedIdePeerContext, {
      get() {
        spoofGetterCalls += 1;
        throw new Error("spoofed context getter must not run");
      },
    });
    expect(() => harness.sourceMatches.emit(spoofedContext, current))
      .not.toThrow();
    expect(spoofGetterCalls).toBe(0);
    expect(messagesOfType(panelA, "source.matches")).toEqual([]);

    harness.sourceMatches.emit(trustedIdePeer(), current);

    expect(messagesOfType(panelA, "source.matches")).toEqual([current]);
    expect(messagesOfType(panelB, "source.matches")).toEqual([]);
  });

  it("publishes an empty pre-resolution clear without granting commands", async () => {
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
    const clear = sourceMatchesMessage("inspect-1", 9, { matches: [] });

    harness.sourceMatches.emit(trustedIdePeer(), clear);
    panel.emitMessage(panelSourceOpen("match-1", "inspect-1", 9));
    panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();

    expect(messagesOfType(panel, "source.matches")).toEqual([clear]);
    expect(harness.coordinator.sourceOpens).toEqual([]);
    expect(harness.coordinator.presentationSettings).toEqual([]);
  });

  it("opens only an exact mapped match with the pinned transport context", async () => {
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
    harness.resolutions.emit(
      trustedIdePeer(),
      matchedResolution("inspect-1", 2),
    );
    const matchesContext = trustedIdePeer();
    harness.sourceMatches.emit(
      matchesContext,
      sourceMatchesMessage("inspect-1", 2),
    );

    panel.emitMessage(panelSourceOpen("match-1", "inspect-1", 2));
    panel.emitMessage(panelSourceOpen("unknown", "inspect-1", 2));
    panel.emitMessage(panelSourceOpen("match-1", "inspect-1", 1));
    panel.emitMessage(panelSourceOpen("match-1", "inspect-missing", 2));
    panel.emitMessage({
      ...panelSourceOpen("match-1", "inspect-1", 2),
      uri: "file:///secret.scss",
      path: "/secret.scss",
      range: { startLine: 1, endLine: 3 },
      sessionId: "panel-session",
      source: { role: "ide", id: "panel-spoof" },
    });
    await flushMicrotasks();

    expect(harness.coordinator.sourceOpens).toEqual([{
      context: matchesContext,
      input: {
        inspectMessageId: "inspect-1",
        resolutionGeneration: 2,
        matchId: "match-1",
      },
    }]);
  });

  it("rejects duplicate match IDs atomically and preserves prior authority", async () => {
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
    harness.resolutions.emit(
      trustedIdePeer(),
      matchedResolution("inspect-1", 1),
    );
    const acceptedContext = trustedIdePeer();
    harness.sourceMatches.emit(
      acceptedContext,
      sourceMatchesMessage("inspect-1", 1),
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 1, {
        matches: [sourceExcerpt("match-1"), sourceExcerpt("match-1")],
      }),
    );

    panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();

    expect(messagesOfType(panel, "source.matches")).toEqual([
      sourceMatchesMessage("inspect-1", 1),
    ]);
    expect(harness.coordinator.sourceOpens).toEqual([{
      context: acceptedContext,
      input: {
        inspectMessageId: "inspect-1",
        resolutionGeneration: 1,
        matchId: "match-1",
      },
    }]);
  });

  it("publishes settings only for the exact current resolved inspect", async () => {
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

    panel.emitMessage(panelPresentationSettings(false));
    panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();
    expect(harness.coordinator.presentationSettings).toEqual([]);
    expect(harness.coordinator.sourceOpens).toEqual([]);

    const resolutionContext = trustedIdePeer();
    harness.resolutions.emit(
      resolutionContext,
      matchedResolution("inspect-1", 1),
    );
    panel.emitMessage(panelPresentationSettings(false));
    panel.emitMessage(panelPresentationSettings(true, "inspect-missing"));
    panel.emitMessage({
      ...panelPresentationSettings(true),
      resolutionGeneration: 1,
      sourceId: "panel-spoof",
    });
    await flushMicrotasks();

    expect(harness.coordinator.presentationSettings).toEqual([{
      context: resolutionContext,
      input: {
        inspectMessageId: "inspect-1",
        ideHighlightEnabled: false,
      },
    }]);
    expect(harness.coordinator.sourceOpens).toEqual([]);
  });

  it.each<BrowserWindowConnectionState>([
    "reconnecting",
    "offline",
    "rateLimited",
    "error",
    "incompatible",
    "notLinked",
  ])("revokes source presentation authority across %s state", async (state) => {
    const { harness, panel } = await createReadySourceHarness();

    harness.coordinator.emitState(10, state);
    await flushMicrotasks();
    panel.emitMessage(panelSourceOpen());
    panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(harness.coordinator.sourceOpens).toEqual([]);
    expect(harness.coordinator.presentationSettings).toEqual([]);

    harness.coordinator.emitState(10, "linked");
    await flushMicrotasks();
    panel.emitMessage(panelSourceOpen());
    panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();

    expect(harness.coordinator.sourceOpens).toEqual([]);
    expect(harness.coordinator.presentationSettings).toEqual([]);
  });

  it("revokes authority before an unavailable state waits on tab verification", async () => {
    const blockedLookup = deferred<
      { id: number; windowId: number } | undefined
    >();
    let blockNextLookup = false;
    let blockedCalls = 0;
    const ready = await createReadySourceHarness({
      getTab: async (tabId) => {
        if (blockNextLookup && ++blockedCalls === 1) {
          return blockedLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    blockNextLookup = true;

    ready.harness.coordinator.emitState(10, "offline");
    await Promise.resolve();
    ready.panel.emitMessage(panelSourceOpen());
    ready.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();

    expect(ready.harness.coordinator.sourceOpens).toEqual([]);
    expect(ready.harness.coordinator.presentationSettings).toEqual([]);

    blockedLookup.resolve({ id: 17, windowId: 10 });
    await flushMicrotasks();
  });

  it("revokes source presentation authority on peer disconnect and explicit unlink", async () => {
    const first = await createReadySourceHarness();

    first.harness.peerStates.emit(10, peerState(false, 2));
    first.harness.coordinator.emitState(10, "linked");
    first.panel.emitMessage(panelSourceOpen());
    first.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();

    expect(first.harness.coordinator.sourceOpens).toEqual([]);
    expect(first.harness.coordinator.presentationSettings).toEqual([]);

    const second = await createReadySourceHarness();
    await second.harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-1",
    }, panelSender("channel-1"));
    second.harness.coordinator.emitState(10, "linked");
    second.panel.emitMessage(panelSourceOpen());
    second.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();

    expect(second.harness.coordinator.sourceOpens).toEqual([]);
    expect(second.harness.coordinator.presentationSettings).toEqual([]);
  });

  it("rejects source presentation after panel rebind, tab move, or document invalidation", async () => {
    const rebound = await createReadySourceHarness();
    rebound.panel.emitMessage(panelSourceOpen());
    rebound.panel.disconnect();
    const replacement = rebound.harness.panelPort("channel-1");
    rebound.harness.router.connectPort(replacement);
    replacement.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(rebound.harness.coordinator.sourceOpens).toEqual([]);
    expect(rebound.harness.coordinator.presentationSettings).toEqual([]);

    const tabs = new Map([[17, 10]]);
    const moved = await createReadySourceHarness({ tabs });
    tabs.set(17, 20);
    moved.panel.emitMessage(panelSourceOpen());
    moved.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(moved.harness.coordinator.sourceOpens).toEqual([]);
    expect(moved.harness.coordinator.presentationSettings).toEqual([]);

    const invalidated = await createReadySourceHarness();
    invalidated.contentLease.disconnect();
    await flushMicrotasks();
    await invalidated.harness.inspectCoordinator.whenIdle(17);
    invalidated.panel.emitMessage(panelSourceOpen());
    invalidated.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(invalidated.harness.coordinator.sourceOpens).toEqual([]);
    expect(invalidated.harness.coordinator.presentationSettings).toEqual([]);
  });

  it("rejects cross-channel commands and callbacks retained past router disposal", async () => {
    const ready = await createReadySourceHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    const panelB = await ready.harness.registerAndConnect(
      "channel-2",
      18,
      "source-18",
    );

    panelB.emitMessage(panelSourceOpen());
    panelB.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(ready.harness.coordinator.sourceOpens).toEqual([]);
    expect(ready.harness.coordinator.presentationSettings).toEqual([]);

    const staleListener = ready.panel.onMessage.snapshot()[0];
    ready.harness.router.dispose();
    staleListener?.(panelSourceOpen());
    staleListener?.(panelPresentationSettings(false));
    await flushMicrotasks();
    expect(ready.harness.coordinator.sourceOpens).toEqual([]);
    expect(ready.harness.coordinator.presentationSettings).toEqual([]);
  });

  it.each<SourcePresentationSendOutcome>([
    "not-connected",
    "invalid-message",
    "transport-error",
  ])("fails closed when source open returns %s", async (outcome) => {
    const { harness, panel } = await createReadySourceHarness();
    harness.coordinator.sourceOpenOutcome = outcome;

    panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();
    panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();

    expect(harness.coordinator.sourceOpens).toHaveLength(1);
    expect(messagesOfType(panel, "pin-op.ideState")).toEqual([{
      type: "pin-op.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-1",
    }]);
  });

  it("fails closed when presentation settings returns non-sent or throws", async () => {
    const nonSent = await createReadySourceHarness();
    nonSent.harness.coordinator.presentationSettingsOutcome = "not-connected";
    nonSent.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    nonSent.panel.emitMessage(panelPresentationSettings(true));
    await flushMicrotasks();

    expect(nonSent.harness.coordinator.presentationSettings).toHaveLength(1);
    expect(messagesOfType(nonSent.panel, "pin-op.ideState")).toHaveLength(1);

    const thrown = await createReadySourceHarness();
    thrown.harness.coordinator.throwOnPresentationSettings = true;
    thrown.panel.emitMessage(panelPresentationSettings(false));
    await flushMicrotasks();
    thrown.panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();

    expect(thrown.harness.coordinator.presentationSettings).toHaveLength(1);
    expect(thrown.harness.coordinator.sourceOpens).toEqual([]);
    expect(messagesOfType(thrown.panel, "pin-op.ideState")).toHaveLength(1);
    expect(thrown.harness.reportedErrors).toHaveLength(1);
  });

  it("keeps a failed source command scoped to its originating window", async () => {
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
    await harness.attachContentSession(17, "content-a");
    await harness.router.routeMessage(
      selectedMessage("content-a"),
      contentSender(17, 10),
    );
    harness.resolutions.emit(
      trustedIdePeer(),
      matchedResolution("inspect-1", 1),
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 1),
    );

    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.attachContentSession(18, "content-b");
    await harness.router.routeMessage(
      selectedMessage("content-b"),
      contentSender(18, 20),
    );
    const contextB = trustedIdePeer({ windowId: 20 });
    harness.resolutions.emit(
      contextB,
      matchedResolution("inspect-2", 1),
    );
    harness.sourceMatches.emit(
      contextB,
      sourceMatchesMessage("inspect-2", 1),
    );

    harness.coordinator.sourceOpenOutcome = "not-connected";
    panelA.emitMessage(panelSourceOpen("match-1", "inspect-1", 1));
    await flushMicrotasks();
    harness.coordinator.sourceOpenOutcome = "sent";
    panelB.emitMessage(panelSourceOpen("match-1", "inspect-2", 1));
    await flushMicrotasks();

    expect(harness.coordinator.sourceOpens).toHaveLength(2);
    expect(harness.coordinator.sourceOpens[1]).toEqual({
      context: contextB,
      input: {
        inspectMessageId: "inspect-2",
        resolutionGeneration: 1,
        matchId: "match-1",
      },
    });
    expect(messagesOfType(panelA, "pin-op.ideState")).toHaveLength(1);
    expect(messagesOfType(panelB, "pin-op.ideState")).toEqual([]);
  });

  it("revokes only the originating correlation when source open throws", async () => {
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
    await harness.attachContentSession(17, "content-a");
    await harness.router.routeMessage(
      selectedMessage("content-a"),
      contentSender(17, 10),
    );
    harness.resolutions.emit(
      trustedIdePeer(),
      matchedResolution("inspect-1", 1),
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 1),
    );

    const panelB = await harness.registerAndConnect(
      "channel-b",
      18,
      "source-b",
    );
    await harness.attachContentSession(18, "content-b");
    await harness.router.routeMessage(
      selectedMessage("content-b"),
      contentSender(18, 20),
    );
    const contextB = trustedIdePeer({ windowId: 20 });
    harness.resolutions.emit(
      contextB,
      matchedResolution("inspect-2", 1),
    );
    harness.sourceMatches.emit(
      contextB,
      sourceMatchesMessage("inspect-2", 1),
    );

    harness.coordinator.throwOnSourceOpen = true;
    panelA.emitMessage(panelSourceOpen("match-1", "inspect-1", 1));
    await flushMicrotasks();
    harness.coordinator.throwOnSourceOpen = false;
    panelA.emitMessage(panelSourceOpen("match-1", "inspect-1", 1));
    panelB.emitMessage(panelSourceOpen("match-1", "inspect-2", 1));
    await flushMicrotasks();

    expect(harness.coordinator.sourceOpens).toHaveLength(2);
    expect(harness.coordinator.sourceOpens[1]).toEqual({
      context: contextB,
      input: {
        inspectMessageId: "inspect-2",
        resolutionGeneration: 1,
        matchId: "match-1",
      },
    });
    expect(messagesOfType(panelA, "pin-op.ideState")).toEqual([{
      type: "pin-op.ideState",
      status: "ide-disconnected",
      inspectMessageId: "inspect-1",
    }]);
    expect(messagesOfType(panelB, "pin-op.ideState")).toEqual([]);
    expect(harness.reportedErrors).toHaveLength(1);
  });

  it("does not let an old failed postflight discard newer source authority", async () => {
    const postflightLookup = deferred<
      { id: number; windowId: number } | undefined
    >();
    let deferNextLookup = false;
    const ready = await createReadySourceHarness({
      getTab: async (tabId) => {
        if (deferNextLookup) {
          deferNextLookup = false;
          return postflightLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    ready.harness.coordinator.sourceOpenOutcome = "not-connected";
    ready.harness.coordinator.onSourceOpen = () => {
      deferNextLookup = true;
    };

    ready.panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();
    expect(ready.harness.coordinator.sourceOpens).toEqual([{
      context: ready.matchesContext,
      input: {
        inspectMessageId: "inspect-1",
        resolutionGeneration: 1,
        matchId: "match-1",
      },
    }]);

    const nextResolutionContext = trustedIdePeer();
    ready.harness.resolutions.emit(
      nextResolutionContext,
      matchedResolution("inspect-1", 2),
    );
    const nextMatchesContext = trustedIdePeer();
    ready.harness.sourceMatches.emit(
      nextMatchesContext,
      sourceMatchesMessage("inspect-1", 2),
    );
    ready.harness.coordinator.sourceOpenOutcome = "sent";
    ready.harness.coordinator.onSourceOpen = undefined;

    postflightLookup.resolve({ id: 17, windowId: 10 });
    await flushMicrotasks();
    expect(messagesOfType(ready.panel, "pin-op.ideState")).toEqual([]);

    ready.panel.emitMessage(panelSourceOpen("match-1", "inspect-1", 2));
    await flushMicrotasks();

    expect(ready.harness.coordinator.sourceOpens).toEqual([
      {
        context: ready.matchesContext,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 1,
          matchId: "match-1",
        },
      },
      {
        context: nextMatchesContext,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 2,
          matchId: "match-1",
        },
      },
    ]);
  });

  it("does not let a failed postflight discard same-generation empty source matches", async () => {
    const postflightLookup = deferred<
      { id: number; windowId: number } | undefined
    >();
    let deferNextLookup = false;
    const ready = await createReadySourceHarness({
      getTab: async (tabId) => {
        if (deferNextLookup) {
          deferNextLookup = false;
          return postflightLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    ready.harness.coordinator.sourceOpenOutcome = "not-connected";
    ready.harness.coordinator.onSourceOpen = () => {
      deferNextLookup = true;
    };

    ready.panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();
    expect(ready.harness.coordinator.sourceOpens).toHaveLength(1);

    const clearMessage = sourceMatchesMessage("inspect-1", 1, {
      matches: [],
    });
    ready.harness.sourceMatches.emit(ready.matchesContext, clearMessage);
    expect(messagesOfType(ready.panel, "source.matches").at(-1)).toEqual(
      clearMessage,
    );
    ready.harness.coordinator.sourceOpenOutcome = "sent";
    ready.harness.coordinator.onSourceOpen = undefined;

    postflightLookup.resolve({ id: 17, windowId: 10 });
    await flushMicrotasks();
    expect(messagesOfType(ready.panel, "pin-op.ideState")).toEqual([]);

    const refreshedMatchesContext = trustedIdePeer();
    ready.harness.sourceMatches.emit(
      refreshedMatchesContext,
      sourceMatchesMessage("inspect-1", 1),
    );
    ready.panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();

    expect(ready.harness.coordinator.sourceOpens).toEqual([
      {
        context: ready.matchesContext,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 1,
          matchId: "match-1",
        },
      },
      {
        context: refreshedMatchesContext,
        input: {
          inspectMessageId: "inspect-1",
          resolutionGeneration: 1,
          matchId: "match-1",
        },
      },
    ]);
  });

  it.each(["source.open", "presentation.settings"] as const)(
    "postflight-revokes %s authority after a silent tab move",
    async (command) => {
      const tabs = new Map([[17, 10]]);
      const { harness, panel } = await createReadySourceHarness({ tabs });
      if (command === "source.open") {
        harness.coordinator.onSourceOpen = () => tabs.set(17, 20);
        panel.emitMessage(panelSourceOpen());
      } else {
        harness.coordinator.onPresentationSettings = () => tabs.set(17, 20);
        panel.emitMessage(panelPresentationSettings(false));
      }
      await flushMicrotasks();
      const publishedBefore = messagesOfType(panel, "source.matches").length;

      harness.sourceMatches.emit(
        trustedIdePeer(),
        sourceMatchesMessage("inspect-1", 1),
      );

      expect(messagesOfType(panel, "source.matches")).toHaveLength(
        publishedBefore,
      );
    },
  );

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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));

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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));

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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));

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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));
    const first = sourceNavigationState("inspect-1", 2, 0);
    const second = sourceNavigationState("inspect-1", 2, 1);

    harness.sourceNavigationStates.emit(
      trustedIdePeer({ windowId: 20 }),
      first,
    );
    harness.sourceNavigationStates.emit(trustedIdePeer(), first);
    harness.sourceNavigationStates.emit(trustedIdePeer(), second);
    harness.sourceNavigationStates.emit(
      trustedIdePeer(),
      sourceNavigationState("inspect-1", 1),
    );
    harness.sourceNavigationStates.emit(
      trustedIdePeer(),
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));

    panel.emitMessage(panelSourceNavigation("next"));
    await flushMicrotasks();
    harness.sourceNavigationStates.emit(
      trustedIdePeer(),
      sourceNavigationState("inspect-1", 2, 0),
    );

    expect(messagesOfType(panel, "pin-op.ideState")).toEqual([{
      type: "pin-op.ideState",
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
    harness.resolutions.emit(trustedIdePeer(), resolution("inspect-1", 2));

    panel.emitMessage(panelSourceNavigation("previous"));
    await flushMicrotasks();
    harness.sourceNavigationStates.emit(
      trustedIdePeer(),
      sourceNavigationState("inspect-1", 2, 0),
    );

    expect(messagesOfType(panel, "pin-op.ideState")).toEqual([{
      type: "pin-op.ideState",
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
      { type: "pin-op.inspect.republish" },
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

  it("revokes source authority before publishing a connected peer replacement", async () => {
    const correlations = new InspectCorrelationStore();
    const harness = createHarness({ inspectCorrelationStore: correlations });
    harness.peerStates.emit(10, peerState(true, 1, "session-a"));
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
    harness.resolutions.emit(
      trustedIdePeer(),
      matchedResolution("inspect-1", 1),
    );
    harness.sourceMatches.emit(
      trustedIdePeer(),
      sourceMatchesMessage("inspect-1", 1),
    );
    const route = {
      channel: "channel-1",
      tabId: 17,
      windowId: 10,
      inspectMessageId: "inspect-1",
      resolutionGeneration: 1,
      matchId: "match-1",
    } as const;
    expect(correlations.authorizeSourceOpen(route)).toBeDefined();
    const replacement = peerState(true, 1, "session-b");
    const disposeWindow = vi.spyOn(correlations, "disposeWindow");
    const publishToPanel = vi.spyOn(panel, "postMessage");

    harness.peerStates.emit(10, replacement);

    expect(disposeWindow).toHaveBeenCalledWith(10);
    expect(publishToPanel).toHaveBeenCalledWith(replacement);
    expect(disposeWindow.mock.invocationCallOrder[0]).toBeLessThan(
      publishToPanel.mock.invocationCallOrder[0] as number,
    );
    expect(correlations.authorizeSourceOpen(route)).toBeUndefined();
    expect(messagesOfType(panel, "peerState")).toEqual([replacement]);
    panel.emitMessage(panelSourceOpen());
    await flushMicrotasks();
    expect(harness.coordinator.sourceOpens).toEqual([]);
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
          message.type === "pin-op.inspect.republish"
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
          message.type === "pin-op.inspect.republish"
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

    harness.resolutions.emit(
      trustedIdePeer(),
      resolution(String(firstId), 99),
    );
    harness.resolutions.emit(
      trustedIdePeer(),
      resolution(String(secondId), 1),
    );

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
          message.type === "pin-op.inspect.republish"
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
      ["tab", 17, { type: "pin-op.inspect.republish" }],
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
      type: "pin-op.inspect.setEnabled",
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
      locator: { ...request.locator, version: 2 },
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
      type: "pin-op.inspect.setEnabled",
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
      type: "pin-op.inspect.setEnabled",
      requestId: "spoof",
      tabId: 99,
      enabled: true,
    });
    panelPort.emitMessage({
      type: "pin-op.inspect.setEnabled",
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
      { type: "pin-op.inspect.disposeSession" },
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
          type: "pin-op.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
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
    expect(harness.tabRefresh.epochCalls).toEqual([10]);
  });

  it("starts a refresh epoch for a new IDE peer but not a transient browser reconnect", async () => {
    const harness = createHarness();
    const panel = await harness.registerAndConnect(
      "channel-peer-epoch",
      17,
      "source-peer-epoch",
    );
    await flushMicrotasks();
    panel.disconnect();

    harness.peerStates.emit(10, peerState(true, 1));
    await flushMicrotasks();
    harness.peerStates.emit(10, peerState(true, 1));
    await flushMicrotasks();
    harness.peerStates.emit(10, peerState(false, 2));
    harness.peerStates.emit(10, peerState(true, 3));
    await flushMicrotasks();

    expect(harness.tabRefresh.epochCalls).toEqual([10, 10]);
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
          type: "pin-op.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    const revocationStart = harness.contentRefresh.revokedWindows.length;
    tabs.set(17, 30);
    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    port.emitMessage({
      type: "pin-op.inspect.setEnabled",
      requestId: "moved-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(harness.coordinator.links.map(({ windowId }) => windowId)).toEqual([20]);
    expect(harness.coordinator.unlinks).toEqual([30]);
    expect(
      harness.contentRefresh.revokedWindows.slice(revocationStart),
    ).toEqual([30]);
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
        { type: "pin-op.inspect.disposeSession" },
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

  it("does not revoke either window when migrated Unlink finds its destination busy", async () => {
    const tabs = new Map([
      [17, 10],
      [18, 20],
    ]);
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const harness = createHarness({
      tabs,
      linkWindow: async (windowId) => {
        if (windowId === 20) {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        }
      },
    });
    await harness.registerAndConnect(
      "channel-migrated-unlink",
      17,
      "source-migrated-unlink",
    );
    await harness.registerAndConnect(
      "channel-destination-blocker",
      18,
      "source-destination-blocker",
    );
    await flushMicrotasks();

    const blockingLink = harness.router.routeMessage({
      type: "pin-op.linkWindow",
      channel: "channel-destination-blocker",
      code: "4873507",
    }, panelSender("channel-destination-blocker"));
    await blockerStarted.promise;
    const revocationStart = harness.contentRefresh.revokedWindows.length;
    tabs.set(17, 20);

    const migratedUnlinkResult = await harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-migrated-unlink",
    }, panelSender("channel-migrated-unlink"));
    releaseBlocker.resolve();
    await expect(blockingLink).resolves.toEqual({ ok: true });

    expect(migratedUnlinkResult).toEqual({
      ok: false,
      error: "busy",
    });

    expect(
      harness.contentRefresh.revokedWindows.slice(revocationStart),
    ).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
  });

  it("does not revoke either window when migrated Unlink loses its panel during preflight", async () => {
    const tabs = new Map([[17, 10]]);
    const preflightStarted = deferred<void>();
    const releasePreflight = deferred<void>();
    let gatePreflight = false;
    const harness = createHarness({
      tabs,
      getTab: async (tabId) => {
        if (gatePreflight) {
          gatePreflight = false;
          preflightStarted.resolve();
          await releasePreflight.promise;
        }
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      },
    });
    const port = await harness.registerAndConnect(
      "channel-stale-migrated-unlink",
      17,
      "source-stale-migrated-unlink",
    );
    await flushMicrotasks();
    const revocationStart = harness.contentRefresh.revokedWindows.length;
    tabs.set(17, 20);
    gatePreflight = true;

    const unlinking = harness.router.routeMessage({
      type: "pin-op.unlinkWindow",
      channel: "channel-stale-migrated-unlink",
    }, panelSender("channel-stale-migrated-unlink"));
    await preflightStarted.promise;
    port.disconnect();
    releasePreflight.resolve();

    await expect(unlinking).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(
      harness.contentRefresh.revokedWindows.slice(revocationStart),
    ).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
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
      type: "pin-op.inspect.setEnabled",
      requestId: "closed-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
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
        { type: "pin-op.inspect.disposeSession" },
      ],
    ]);
    expect(harness.coordinator.unlinks).toEqual([]);
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(port.sent).toContainEqual({
      type: "pin-op.inspect.result",
      requestId: "closed-enable",
      ok: false,
      error: "stalePanel",
    });
  });

  it("does not return a valid binding while its panel teardown is pending", async () => {
    let tabExists = true;
    const closeGate = deferred<void>();
    const harness = createHarness({
      getTab: async (tabId) =>
        tabExists ? { id: tabId, windowId: 10 } : undefined,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelClosedBehavior = async () => closeGate.promise;

    tabExists = false;
    port.emitMessage({
      type: "pin-op.inspect.setEnabled",
      requestId: "pending-teardown",
      enabled: true,
    });
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelCloseCalls).toEqual([[17, 10]]);
    });

    tabExists = true;
    let validLookupSettled = false;
    const concurrent = harness.router.routeMessage(
      {
        type: "pin-op.unlinkWindow",
        channel: "channel-1",
      },
      panelSender("channel-1"),
    ).then((result) => {
      validLookupSettled = true;
      return result;
    });
    await flushMicrotasks();
    const settledBeforeTeardown = validLookupSettled;
    closeGate.resolve();

    await expect(concurrent).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();
    expect(settledBeforeTeardown).toBe(false);
    expect(harness.coordinator.unlinks).toEqual([]);
    expect(port.sent).toContainEqual({
      type: "pin-op.inspect.result",
      requestId: "pending-teardown",
      ok: false,
      error: "stalePanel",
    });
  });

  it("retries a failed pending teardown before a valid lookup can use the binding", async () => {
    let tabExists = true;
    const firstCloseGate = deferred<void>();
    let closeAttempt = 0;
    const harness = createHarness({
      getTab: async (tabId) =>
        tabExists ? { id: tabId, windowId: 10 } : undefined,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelClosedBehavior = async () => {
      closeAttempt += 1;
      if (closeAttempt === 1) {
        await firstCloseGate.promise;
        throw new Error("transient close failure");
      }
    };

    tabExists = false;
    port.emitMessage({
      type: "pin-op.inspect.setEnabled",
      requestId: "failed-pending-teardown",
      enabled: true,
    });
    await vi.waitFor(() => expect(closeAttempt).toBe(1));

    tabExists = true;
    let validLookupSettled = false;
    const concurrent = harness.router.routeMessage(
      {
        type: "pin-op.unlinkWindow",
        channel: "channel-1",
      },
      panelSender("channel-1"),
    ).then((result) => {
      validLookupSettled = true;
      return result;
    });
    await flushMicrotasks();
    const settledBeforeTeardown = validLookupSettled;
    firstCloseGate.resolve();

    await expect(concurrent).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await flushMicrotasks();
    expect(settledBeforeTeardown).toBe(false);
    expect(harness.tabRefresh.panelCloseCalls).toEqual([
      [17, 10],
      [17, 10],
    ]);
    expect(harness.coordinator.unlinks).toEqual([]);
    expect(harness.reportedErrors).toContainEqual(
      new Error("transient close failure"),
    );
    expect(port.sent).toContainEqual({
      type: "pin-op.inspect.result",
      requestId: "failed-pending-teardown",
      ok: false,
      error: "stalePanel",
    });
  });

  it("waits for panel-close teardown before activating a reconnect", async () => {
    const closeGate = deferred<void>();
    const harness = createHarness();
    const oldPort = await harness.registerAndConnect(
      "channel-reconnect-barrier",
      17,
      "source-reconnect-barrier",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelClosedBehavior = async () => closeGate.promise;

    oldPort.disconnect();
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelCloseCalls).toContainEqual([17, 10]);
    });
    const reconnect = harness.panelPort("channel-reconnect-barrier");
    harness.router.connectPort(reconnect);
    await flushMicrotasks();

    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(reconnect.sent).toEqual([]);

    closeGate.resolve();
    await vi.waitFor(() => {
      expect(harness.coordinator.activeSources()).toEqual([
        "source-reconnect-barrier",
      ]);
    });
  });

  it("waits for superseded panel teardown before committing a replacement", async () => {
    const closeGate = deferred<void>();
    const harness = createHarness();
    const oldPort = await harness.registerAndConnect(
      "channel-replacement-old",
      17,
      "source-replacement-old",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelClosedBehavior = async () => closeGate.promise;
    oldPort.disconnect();
    await vi.waitFor(() => {
      expect(harness.tabRefresh.panelCloseCalls).toContainEqual([17, 10]);
    });

    const replacementPort = harness.panelPort("channel-replacement-new");
    harness.router.connectPort(replacementPort);
    let registrationSettled = false;
    const registration = harness.router.routeMessage(
      registerMessage(
        "channel-replacement-new",
        17,
        "source-replacement-new",
      ),
      devtoolsSender(),
    ).then((result) => {
      registrationSettled = true;
      return result;
    });
    await flushMicrotasks();

    expect(registrationSettled).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual([]);

    closeGate.resolve();
    await expect(registration).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(harness.coordinator.activeSources()).toEqual([
        "source-replacement-new",
      ]);
    });
  });

  it("keeps replacement unavailable until a failed old teardown retries", async () => {
    const firstClose = deferred<void>();
    let closeAttempt = 0;
    const harness = createHarness();
    const oldPort = await harness.registerAndConnect(
      "channel-retry-old",
      17,
      "source-retry-old",
    );
    await flushMicrotasks();
    harness.tabRefresh.panelClosedBehavior = async () => {
      closeAttempt += 1;
      if (closeAttempt === 1) {
        await firstClose.promise;
        throw new Error("transient replacement close failure");
      }
    };
    oldPort.disconnect();
    await vi.waitFor(() => expect(closeAttempt).toBe(1));

    const replacementPort = harness.panelPort("channel-retry-new");
    harness.router.connectPort(replacementPort);
    const failedRegistration = harness.router.routeMessage(
      registerMessage("channel-retry-new", 17, "source-retry-new"),
      devtoolsSender(),
    );
    firstClose.resolve();

    await expect(failedRegistration).resolves.toBeUndefined();
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(replacementPort.sent).toEqual([]);

    await expect(harness.router.routeMessage(
      registerMessage("channel-retry-new", 17, "source-retry-new"),
      devtoolsSender(),
    )).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(closeAttempt).toBe(2);
      expect(harness.coordinator.activeSources()).toEqual([
        "source-retry-new",
      ]);
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
        type: "pin-op.linkWindow",
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
      type: "pin-op.linkWindow",
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
          type: "pin-op.unlinkWindow",
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
          type: "pin-op.linkWindow",
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
          type: "pin-op.unlinkWindow",
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
            type: "pin-op.linkWindow",
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
      type: "pin-op.linkWindow",
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
          type: "pin-op.linkWindow",
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
          type: "pin-op.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "error" });
    expect(failed.reportedErrors).toHaveLength(1);
    expect(failed.reportedErrors[0]).toBeInstanceOf(Error);
    expect((failed.reportedErrors[0] as Error).message).toBe(
      "Pin-op panel command failed",
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
        type: "pin-op.linkWindow",
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
        type: "pin-op.linkWindow",
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
              type: "pin-op.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "pin-op.unlinkWindow",
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
              type: "pin-op.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "pin-op.unlinkWindow",
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
              type: "pin-op.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "pin-op.unlinkWindow",
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
              type: "pin-op.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "pin-op.unlinkWindow",
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
        type: "pin-op.linkWindow",
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
      { type: "pin-op.inspect.disposeSession" },
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
      { type: "pin-op.inspect.disposeSession" },
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
        type: "pin-op.unlinkWindow",
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
        type: "pin-op.linkWindow",
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
      type: "pin-op.inspect.setEnabled",
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
      type: "pin-op.inspect.result",
      requestId: "pending-enable",
      ok: false,
      error: "stalePanel",
    });
    expect(port.sent).not.toContainEqual({
      type: "pin-op.inspect.result",
      requestId: "pending-enable",
      ok: true,
    });

    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(port.sent).not.toContainEqual({
      type: "pin-op.inspect.result",
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
      ["tab", 17, { type: "pin-op.inspect.disposeSession" }],
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
      type: "pin-op.inspect.setEnabled",
      requestId: "detached-enable",
      enabled: true,
    });
    await flushMicrotasks();

    events.detach(17, 10);

    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(inspectResults(port)).toEqual([
      {
        type: "pin-op.inspect.result",
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
        { type: "pin-op.inspect.disposeSession" },
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

  it("retains closed-panel refresh settings on detach without rebinding on attach", async () => {
    const tabs = new Map([[17, 10]]);
    const events = createRouterSubscriptionHarness();
    const harness = createHarness({ tabs, subscriptions: events.subscriptions });
    const panel = await harness.registerAndConnect(
      "channel-closed-move",
      17,
      "source-closed-move",
    );
    await flushMicrotasks();
    panel.disconnect();

    events.detach(17, 10);
    tabs.set(17, 20);
    events.attach(17, 20);
    await flushMicrotasks();

    expect(harness.tabRefresh.detachedTabs).toEqual([[17, 10]]);
    expect(harness.tabRefresh.hasState(17)).toBe(true);
    expect(await harness.tabRefresh.state(17, 10)).toMatchObject({
      participant: false,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });
    expect(harness.tabRefresh.panelOpenCalls).toEqual([[17, 10]]);
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
        type: "pin-op.inspect.setEnabled",
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
          type: "pin-op.inspect.result",
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
        type: "pin-op.inspect.setEnabled",
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
          type: "pin-op.inspect.result",
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
      type: "pin-op.inspect.setEnabled",
      requestId: "enable-before-disable",
      enabled: true,
    });
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    port.emitMessage({
      type: "pin-op.inspect.setEnabled",
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
        type: "pin-op.inspect.result",
        requestId: "enable-before-disable",
        ok: true,
      },
      {
        type: "pin-op.inspect.result",
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

  it("releases a stale window lease before command dispatch", async () => {
    const preflightStarted = deferred<void>();
    const releasePreflight = deferred<void>();
    let gatePreflight = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (gatePreflight) {
          gatePreflight = false;
          preflightStarted.resolve();
          await releasePreflight.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    const firstPort = await harness.registerAndConnect(
      "channel-preflight-lease",
      17,
      "source-preflight-lease",
    );
    await flushMicrotasks();
    gatePreflight = true;

    const staleLink = harness.router.routeMessage(
      {
        type: "pin-op.linkWindow",
        channel: "channel-preflight-lease",
        code: "4873507",
      },
      panelSender("channel-preflight-lease"),
    );
    await preflightStarted.promise;
    firstPort.disconnect();
    const recoveredPort = harness.panelPort("channel-preflight-lease");
    harness.router.connectPort(recoveredPort);
    await flushMicrotasks();

    await expect(harness.router.routeMessage(
      {
        type: "pin-op.unlinkWindow",
        channel: "channel-preflight-lease",
      },
      panelSender("channel-preflight-lease"),
    )).resolves.toEqual({ ok: true });

    releasePreflight.resolve();
    await expect(staleLink).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(harness.coordinator.links).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([10]);
  });

  it("serializes a recovered port behind a stale same-window command", async () => {
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
        type: "pin-op.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();
    firstPort.disconnect();

    const recoveredPort = harness.panelPort("channel-1");
    harness.router.connectPort(recoveredPort);
    await flushMicrotasks();
    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "busy" });
    expect(harness.coordinator.unlinks).toEqual([]);

    linkResult.resolve();
    await expect(staleLink).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    await expect(
      harness.router.routeMessage(
        {
          type: "pin-op.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
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
      type: "pin-op.inspect.setEnabled",
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
      { type: "pin-op.inspect.disposeSession" },
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
  readonly inspectCorrelationStore?: InspectCorrelationStore;
  readonly initialPanelState?: BrowserWindowConnectionState;
  readonly initialProtocolMismatch?: BrowserProtocolMismatch;
}

function createHarness(options: HarnessOptions = {}) {
  const tabs = options.tabs ?? new Map([[17, 10]]);
  const getTabCalls: number[] = [];
  const inspectCalls: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const resolutions = new FakeEvent<(
    context: TrustedIdePeerContext,
    message: ResolutionMessage,
  ) => void>();
  const peerStates = new FakeEvent<
    (windowId: number, message: PeerStateMessage) => void
  >();
  const sourceNavigationStates = new FakeEvent<
    (
      context: TrustedIdePeerContext,
      message: SourceNavigationStateMessage,
    ) => void
  >();
  const sourceMatches = new FakeEvent<
    (
      context: TrustedIdePeerContext,
      message: SourceMatchesMessage,
    ) => void
  >();
  const pageRefreshes = new FakeEvent<
    (windowId: number, message: PageRefreshMessage) => void
  >();
  const protocolMismatches = new FakeEvent<
    (windowId: number, details: BrowserProtocolMismatch) => void
  >();
  const tabRefresh = new FakeTabRefreshCoordinator();
  const contentRefresh = new FakeContentRefreshCoordinator();
  const coordinator = new FakeWindowCoordinator(
    options.linkWindow,
    options.unlinkWindow,
    options.publishInspect,
    options.publishSourceNavigation,
    options.initialPanelState ?? "linked",
    options.initialProtocolMismatch,
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
    sourceMatches,
    pageRefreshes,
    protocolMismatches,
    tabRefresh,
    contentRefresh,
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
    tabRefreshCoordinator: tabRefresh,
    contentRefreshCoordinator: contentRefresh,
    inspectCoordinator,
    panelSessionTransport: options.panelSessionTransport,
    inspectCorrelationStore: options.inspectCorrelationStore,
    subscriptions: options.subscriptions,
    subscribeResolutions: (
      listener: (
        peerContext: TrustedIdePeerContext,
        message: ResolutionMessage,
      ) => void,
    ) => {
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
        peerContext: TrustedIdePeerContext,
        message: SourceNavigationStateMessage,
      ) => void,
    ) => {
      sourceNavigationStates.addListener(listener);
      return () => sourceNavigationStates.removeListener(listener);
    },
    subscribeSourceMatches: (listener) => {
      sourceMatches.addListener(listener);
      return () => sourceMatches.removeListener(listener);
    },
    subscribePageRefreshes: (listener) => {
      pageRefreshes.addListener(listener);
      return () => pageRefreshes.removeListener(listener);
    },
    subscribeProtocolMismatches: (listener) => {
      protocolMismatches.addListener(listener);
      return () => protocolMismatches.removeListener(listener);
    },
    inspectMessageId: (() => {
      let sequence = 0;
      return () => `inspect-${++sequence}`;
    })(),
    onError: (error) => reportedErrors.push(error),
  });
  return harness;
}

async function createReadySourceHarness(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  const panel = await harness.registerAndConnect(
    "channel-1",
    17,
    "source-17",
  );
  const contentLease = await harness.attachContentSession(17);
  await harness.router.routeMessage(
    selectedMessage(DEFAULT_CONTENT_SESSION_ID),
    contentSender(17, 10),
  );
  const resolutionContext = trustedIdePeer();
  harness.resolutions.emit(
    resolutionContext,
    matchedResolution("inspect-1", 1),
  );
  const matchesContext = trustedIdePeer();
  harness.sourceMatches.emit(
    matchesContext,
    sourceMatchesMessage("inspect-1", 1),
  );
  return {
    harness,
    panel,
    contentLease,
    resolutionContext,
    matchesContext,
  };
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

interface PublishedSourceOpen {
  readonly context: TrustedIdePeerContext;
  readonly input: SourceOpenInput;
}

interface PublishedPresentationSettings {
  readonly context: TrustedIdePeerContext;
  readonly input: PresentationSettingsInput;
}

class FakeWindowCoordinator {
  public readonly registrations: PanelRegistration[] = [];
  public readonly published: PublishedInspect[] = [];
  public readonly sourceNavigations: PublishedSourceNavigation[] = [];
  public readonly sourceOpens: PublishedSourceOpen[] = [];
  public readonly presentationSettings: PublishedPresentationSettings[] = [];
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
  public sourceOpenOutcome: SourcePresentationSendOutcome = "sent";
  public presentationSettingsOutcome: SourcePresentationSendOutcome = "sent";
  public throwOnSourceOpen = false;
  public throwOnPresentationSettings = false;
  public readonly refreshParticipants: Array<[number, number, boolean]> = [];
  public onPublish?: (publication: PublishedInspect) => void;
  public onSourceOpen?: (publication: PublishedSourceOpen) => void;
  public onPresentationSettings?: (
    publication: PublishedPresentationSettings,
  ) => void;
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
    private readonly initialProtocolMismatch?: BrowserProtocolMismatch,
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
    registration.onStateChanged?.(
      this.initialPanelState,
      undefined,
      this.initialProtocolMismatch,
    );
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

  public publishSourceOpen(
    context: TrustedIdePeerContext,
    input: SourceOpenInput,
  ): SourcePresentationSendOutcome {
    const publication = { context, input: { ...input } };
    this.sourceOpens.push(publication);
    this.onSourceOpen?.(publication);
    if (this.throwOnSourceOpen) {
      throw new Error("source open failed");
    }
    return this.sourceOpenOutcome;
  }

  public publishPresentationSettings(
    context: TrustedIdePeerContext,
    input: PresentationSettingsInput,
  ): SourcePresentationSendOutcome {
    const publication = { context, input: { ...input } };
    this.presentationSettings.push(publication);
    this.onPresentationSettings?.(publication);
    if (this.throwOnPresentationSettings) {
      throw new Error("presentation settings failed");
    }
    return this.presentationSettingsOutcome;
  }

  public async removeWindow(windowId: number): Promise<void> {
    this.removedWindows.push(windowId);
  }

  public activeSources(): string[] {
    return [...this.active]
      .map((registration) => registration.sourceId)
      .sort();
  }

  public emitState(
    windowId: number,
    state: BrowserWindowConnectionState,
    protocolMismatch?: BrowserProtocolMismatch,
  ): void {
    for (const registration of this.active) {
      if (registration.windowId === windowId) {
        registration.onStateChanged?.(state, undefined, protocolMismatch);
      }
    }
  }
}

class FakeContentRefreshCoordinator {
  public readonly revokedTabs: number[] = [];
  public readonly revokedWindows: number[] = [];
  public readonly windowEligibility: Array<[number, boolean]> = [];
  public readonly participation: Array<[number, number, boolean]> = [];
  public readonly observedUpdates: Array<[number, unknown]> = [];

  public async dispatch(): Promise<void> {}
  public async routeMessage(): Promise<undefined> { return undefined; }
  public observeTabUpdate(tabId: number, update: unknown): void {
    this.observedUpdates.push([tabId, update]);
  }
  public async tabUpdated(): Promise<void> {}
  public async removeTab(): Promise<void> {}
  public async detachTab(): Promise<void> {}
  public setTabParticipation(
    tabId: number,
    windowId: number,
    participant: boolean,
  ): void {
    this.participation.push([tabId, windowId, participant]);
  }
  public setWindowEligibility(windowId: number, eligible: boolean): void {
    this.windowEligibility.push([windowId, eligible]);
  }
  public revokeTab(tabId: number): void { this.revokedTabs.push(tabId); }
  public revokeWindow(windowId: number): void {
    this.revokedWindows.push(windowId);
  }
  public dispose(): void {}
}

class FakeTabRefreshCoordinator {
  public readonly lifecycleCalls: string[] = [];
  public readonly panelOpenCalls: Array<[number, number]> = [];
  public readonly panelCloseCalls: Array<[number, number | undefined]> = [];
  public readonly stateCalls: Array<[number, number]> = [];
  public readonly settingCalls: Array<[
    number,
    number,
    TabRefreshSettings,
  ]> = [];
  public readonly refreshCalls: Array<[number, PageRefreshMessage]> = [];
  public readonly acceptedRefreshCalls: Array<
    [number, PageRefreshMessage]
  > = [];
  public readonly acceptedParticipantRefreshCalls: Array<
    [number, number, PageRefreshMessage]
  > = [];
  public readonly activatedTabs: Array<[number, number]> = [];
  public readonly removedTabs: number[] = [];
  public readonly removedWindows: number[] = [];
  public readonly epochCalls: number[] = [];
  public readonly detachedTabs: Array<[number, number]> = [];
  public readonly clearedPendingWindows: number[] = [];
  public panelOpenedBehavior?: (
    tabId: number,
    windowId: number,
  ) => Promise<TabRefreshState>;
  public panelClosedBehavior?: (
    tabId: number,
    windowId: number | undefined,
  ) => Promise<void>;
  public stateBehavior?: (
    tabId: number,
    windowId: number,
  ) => Promise<TabRefreshState>;
  public readonly refreshParticipants: Array<[number, number, boolean]> = [];
  private readonly states = new Map<number, TabRefreshState>();
  private readonly panelWindows = new Map<number, number>();
  private readonly lifecycleRevisions = new Map<number, number>();
  private readonly terminalTabs = new Set<number>();
  private nextLifecycleRevision = 1;

  public async panelOpened(
    tabId: number,
    windowId: number,
  ): Promise<TabRefreshState> {
    this.panelOpenCalls.push([tabId, windowId]);
    if (this.terminalTabs.has(tabId)) {
      throw new Error("Tab refresh lifecycle is terminal");
    }
    this.panelWindows.set(tabId, windowId);
    const revision = this.advanceLifecycle(tabId);
    try {
      const existing = this.states.get(tabId);
      const current = existing ?? defaultTabState(tabId, windowId);
      const next = this.panelOpenedBehavior
        ? await this.panelOpenedBehavior(tabId, windowId)
        : {
            ...current,
            windowId,
            participant: current.autoRefreshEnabled,
          };
      if (this.isCurrentLifecycle(tabId, revision)) {
        this.states.set(tabId, next);
      }
      return next;
    } catch (error) {
      if (
        this.isCurrentLifecycle(tabId, revision) &&
        this.panelWindows.get(tabId) === windowId
      ) {
        this.panelWindows.delete(tabId);
      }
      throw error;
    }
  }

  public async panelClosed(
    tabId: number,
    windowId?: number,
  ): Promise<TabRefreshState | undefined> {
    this.lifecycleCalls.push(`panelClosed:${tabId}:${windowId ?? "unknown"}`);
    this.panelCloseCalls.push([tabId, windowId]);
    if (this.terminalTabs.has(tabId)) {
      return undefined;
    }
    const ownerWindowId = this.panelWindows.get(tabId);
    if (
      windowId !== undefined &&
      ownerWindowId !== undefined &&
      ownerWindowId !== windowId
    ) {
      return this.states.get(tabId);
    }
    if (ownerWindowId === undefined) {
      await this.panelClosedBehavior?.(tabId, windowId);
      return this.states.get(tabId);
    }
    const revision = this.advanceLifecycle(tabId);
    const existing = this.states.get(tabId);
    const current = existing ?? defaultTabState(tabId, ownerWindowId);
    const next = {
      tabId,
      windowId: ownerWindowId,
      autoRefreshEnabled: current.autoRefreshEnabled,
      ideHighlightEnabled: current.ideHighlightEnabled,
      participant: false,
      lastAcceptedGeneration: current.lastAcceptedGeneration,
    };
    this.panelWindows.delete(tabId);
    this.states.set(tabId, next);
    await this.panelClosedBehavior?.(tabId, windowId);
    if (!this.isCurrentLifecycle(tabId, revision)) {
      return this.states.get(tabId);
    }
    return next;
  }

  public setRefreshParticipant(
    windowId: number,
    tabId: number,
    participant: boolean,
  ): void {
    this.refreshParticipants.push([windowId, tabId, participant]);
  }

  public async state(tabId: number, windowId: number): Promise<TabRefreshState> {
    this.stateCalls.push([tabId, windowId]);
    if (this.stateBehavior) {
      return await this.stateBehavior(tabId, windowId);
    }
    const current = this.states.get(tabId);
    return current?.windowId === windowId
      ? current
      : defaultTabState(tabId, windowId);
  }

  public setState(state: TabRefreshState): void {
    this.states.set(state.tabId, state);
  }

  public hasState(tabId: number): boolean {
    return this.states.has(tabId);
  }

  public async updateSettings(
    tabId: number,
    windowId: number,
    settings: TabRefreshSettings,
  ): Promise<TabRefreshState> {
    this.settingCalls.push([tabId, windowId, { ...settings }]);
    const current = await this.state(tabId, windowId);
    const next = {
      tabId,
      windowId,
      autoRefreshEnabled: settings.autoRefreshEnabled,
      ideHighlightEnabled: settings.ideHighlightEnabled,
      participant: settings.autoRefreshEnabled,
      lastAcceptedGeneration: current.lastAcceptedGeneration,
    };
    this.states.set(tabId, next);
    return next;
  }

  public async acceptPageRefresh(
    windowId: number,
    message: PageRefreshMessage,
  ): Promise<void> {
    this.refreshCalls.push([windowId, message]);
    const participants = [...this.states.values()].filter((state) =>
      state.windowId === windowId &&
      state.autoRefreshEnabled &&
      state.participant
    );
    if (participants.length > 0) {
      this.acceptedRefreshCalls.push([windowId, message]);
      for (const participant of participants) {
        this.acceptedParticipantRefreshCalls.push([
          windowId,
          participant.tabId,
          message,
        ]);
      }
    }
  }

  public async beginWindowEpoch(windowId: number): Promise<void> {
    this.epochCalls.push(windowId);
  }

  public async clearWindowPending(windowId: number): Promise<void> {
    this.clearedPendingWindows.push(windowId);
  }

  public async detachTab(tabId: number, windowId: number): Promise<void> {
    this.detachedTabs.push([tabId, windowId]);
    if (this.panelWindows.get(tabId) === windowId) {
      this.panelWindows.delete(tabId);
    }
    const current = this.states.get(tabId);
    if (current?.windowId === windowId) {
      this.states.set(tabId, {
        tabId: current.tabId,
        windowId: current.windowId,
        autoRefreshEnabled: current.autoRefreshEnabled,
        ideHighlightEnabled: current.ideHighlightEnabled,
        participant: false,
        lastAcceptedGeneration: current.lastAcceptedGeneration,
      });
    }
  }

  public async activateTab(tabId: number, windowId: number): Promise<void> {
    this.activatedTabs.push([tabId, windowId]);
  }

  public async removeTab(tabId: number): Promise<void> {
    this.lifecycleCalls.push(`removeTab:${tabId}`);
    this.removedTabs.push(tabId);
    this.terminalTabs.add(tabId);
    this.panelWindows.delete(tabId);
    this.states.delete(tabId);
    this.lifecycleRevisions.delete(tabId);
  }

  public async removeWindow(windowId: number): Promise<void> {
    this.lifecycleCalls.push(`removeWindow:${windowId}`);
    this.removedWindows.push(windowId);
    for (const [tabId, state] of this.states) {
      if (state.windowId === windowId) {
        this.panelWindows.delete(tabId);
        this.states.set(tabId, {
          tabId: state.tabId,
          windowId: state.windowId,
          autoRefreshEnabled: state.autoRefreshEnabled,
          ideHighlightEnabled: state.ideHighlightEnabled,
          participant: false,
          lastAcceptedGeneration: state.lastAcceptedGeneration,
        });
        this.lifecycleRevisions.delete(tabId);
      }
    }
  }

  private advanceLifecycle(tabId: number): number {
    const revision = this.nextLifecycleRevision;
    this.nextLifecycleRevision += 1;
    this.lifecycleRevisions.set(tabId, revision);
    return revision;
  }

  private isCurrentLifecycle(tabId: number, revision: number): boolean {
    return this.lifecycleRevisions.get(tabId) === revision;
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
    type: "pin-op.registerDevtools",
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
    ideHighlightEnabled: true,
    metadata: {},
  };
}

function defaultTabState(tabId: number, windowId: number): TabRefreshState {
  return {
    tabId,
    windowId,
    autoRefreshEnabled: true,
    ideHighlightEnabled: true,
    participant: false,
    lastAcceptedGeneration: 0,
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
    type: "pin-op.dom.event" as const,
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
      isRecord(message) && message.type === "pin-op.inspect.result",
  );
}

function windowStates(port: FakePort): unknown[] {
  return port.sent.flatMap((message) =>
    isRecord(message) && message.type === "pin-op.windowState"
      ? [message.state]
      : [],
  );
}

function createRouterSubscriptionHarness(): {
  readonly subscriptions: BackgroundRouterSubscriptions;
  detach(tabId: number, oldWindowId: number): void;
  attach(tabId: number, newWindowId: number): void;
  removeTab(tabId: number): void;
} {
  let detached: ((tabId: number, oldWindowId: number) => void) | undefined;
  let attached: ((tabId: number, newWindowId: number) => void) | undefined;
  let removed: ((tabId: number) => void) | undefined;
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
      subscribeTabRemoved(listener) {
        removed = listener;
        return () => {
          if (removed === listener) {
            removed = undefined;
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
    removeTab(tabId) {
      if (!removed) {
        throw new Error("Missing tab remove listener");
      }
      removed(tabId);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isCompatibleMessage(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.type === "pin-op.protocol.compatibility" &&
    message.compatible === true
  );
}

function isPanelTabStateMessage(message: unknown): boolean {
  return isRecord(message) && message.type === "pin-op.tab.state";
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
      call[2].type === "pin-op.inspect.republish",
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

function matchedResolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    ...resolution(inspectMessageId, resolutionGeneration),
    status: "matched",
    document: { label: "card.scss", languageId: "scss" },
    selectedMatchCount: 1,
  };
}

function sourceMatchesMessage(
  inspectMessageId: string,
  resolutionGeneration: number,
  overrides: {
    readonly sessionId?: string;
    readonly sourceId?: string;
    readonly matches?: readonly SourceExcerpt[];
  } = {},
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `source-matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: overrides.sessionId ?? "session-a",
    source: { role: "ide", id: overrides.sourceId ?? "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    matches: overrides.matches ?? [sourceExcerpt("match-1")],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function sourceExcerpt(matchId: string): SourceExcerpt {
  return {
    matchId,
    targetRole: "selected",
    label: `card.scss:${matchId}`,
    kind: "rule",
    relation: "selected",
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: ".card { color: red; }",
    truncated: false,
  };
}

function trustedIdePeer(
  overrides: {
    readonly windowId?: number;
    readonly sessionId?: string;
    readonly sourceId?: string;
  } = {},
): TrustedIdePeerContext {
  return createTransportTrustedIdePeerContext(
    overrides.windowId ?? 10,
    overrides.sessionId ?? "session-a",
    overrides.sourceId ?? "vscode-a",
  );
}

function panelSourceNavigation(
  direction: "previous" | "next",
  inspectMessageId = "inspect-1",
  resolutionGeneration = 2,
) {
  return {
    type: "pin-op.source.navigate" as const,
    inspectMessageId,
    resolutionGeneration,
    direction,
  };
}

function panelSourceOpen(
  matchId = "match-1",
  inspectMessageId = "inspect-1",
  resolutionGeneration = 1,
) {
  return {
    type: "pin-op.source.open" as const,
    inspectMessageId,
    resolutionGeneration,
    matchId,
  };
}

function panelPresentationSettings(
  ideHighlightEnabled: boolean,
  inspectMessageId = "inspect-1",
) {
  return {
    type: "pin-op.presentation.settings" as const,
    inspectMessageId,
    ideHighlightEnabled,
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
