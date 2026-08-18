import {
  PROTOCOL_VERSION,
  type PageRefreshMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import { TabRefreshCoordinator } from "../src/tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "../src/tabRefreshStateStore.js";

describe("TabRefreshCoordinator", () => {
  it("keeps ownership runtime-only and requires panel re-registration after restart", async () => {
    const context = setup();
    const opened = await context.coordinator.panelOpened(11, 7);

    expect(opened).toMatchObject({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: true,
    });
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, true);
    expect(await context.store.loadAll()).toEqual([{
      ...opened,
      participant: false,
    }]);

    const replacement = setup(context.storage);
    await replacement.coordinator.initialize();
    expect(replacement.setRefreshParticipant).not.toHaveBeenCalled();
    expect(await replacement.coordinator.state(11, 7)).toMatchObject({
      participant: false,
      autoRefreshEnabled: true,
    });

    const reopened = await replacement.coordinator.panelOpened(11, 7);
    expect(reopened).toMatchObject({ participant: true });
    expect(replacement.setRefreshParticipant).toHaveBeenCalledWith(7, 11, true);
  });

  it("never trusts stale ownership or pending work when normalization cannot persist", async () => {
    const storage = normalizationWriteFailureStorage({
      "pin-op.tabRefreshStates": [{
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: false,
        participant: true,
        lastAcceptedGeneration: 5,
        pending: { generation: 5, mode: "reload" },
      }],
    });
    const context = setup(storage, () => 11);

    await context.coordinator.initialize();
    await context.coordinator.activateTab(11, 7);

    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    expect(context.dispatchRefresh).not.toHaveBeenCalled();
    expect(await context.coordinator.state(11, 7)).toEqual({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 5,
    });

    const opened = await context.coordinator.panelOpened(11, 7);
    expect(opened).toMatchObject({ participant: true });
    expect(opened).not.toHaveProperty("pending");
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, true);

    context.setRefreshParticipant.mockClear();
    const closing = context.coordinator.panelClosed(11, 7);
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, false);
    await closing;
  });

  it("closes an enabled panel without losing its preference or restoring ownership", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));
    expect(await context.coordinator.state(11, 7)).toHaveProperty(
      "pending",
      { generation: 4, mode: "reload" },
    );
    context.setRefreshParticipant.mockClear();

    const closing = context.coordinator.panelClosed(11, 7);

    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, false);
    const closed = await closing;
    expect(closed).toMatchObject({
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    });
    expect(closed).not.toHaveProperty("pending");
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(7, 11, false);

    const replacement = setup(context.storage);
    await replacement.coordinator.initialize();
    expect(replacement.setRefreshParticipant).not.toHaveBeenCalled();
    expect(await replacement.coordinator.state(11, 7)).toEqual(closed);

    const reopened = await replacement.coordinator.panelOpened(11, 7);
    expect(reopened).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
      lastAcceptedGeneration: 4,
    });
    expect(reopened).not.toHaveProperty("pending");
    expect(replacement.setRefreshParticipant).toHaveBeenLastCalledWith(
      7,
      11,
      true,
    );
  });

  it("lets panel close win a race with an in-flight panel open", async () => {
    const context = setup();

    const opening = context.coordinator.panelOpened(11, 7);
    const closing = context.coordinator.panelClosed(11, 7);
    await Promise.all([opening, closing]);

    expect(await context.coordinator.state(11, 7)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(7, 11, false);

    const replacement = setup(context.storage);
    await replacement.coordinator.initialize();
    expect(replacement.setRefreshParticipant).not.toHaveBeenCalled();
  });

  it("persists panel close while an older refresh dispatch is blocked", async () => {
    const dispatchGate = deferred<void>();
    const context = setup(
      undefined,
      () => 11,
      async () => dispatchGate.promise,
    );
    await context.coordinator.panelOpened(11, 7);
    const refreshing = context.coordinator.acceptPageRefresh(
      7,
      refresh(1, "reload"),
    );
    await vi.waitFor(() => expect(context.dispatchRefresh).toHaveBeenCalledOnce());

    let closed = false;
    const closing = context.coordinator.panelClosed(11, 7).then((state) => {
      closed = true;
      return state;
    });
    await vi.waitFor(() => expect(closed).toBe(true));
    const closedBeforeDispatch = closed;
    const replacement = setup(context.storage);
    if (closedBeforeDispatch) {
      await replacement.coordinator.initialize();
    }

    dispatchGate.resolve();
    await Promise.all([refreshing, closing]);

    expect(closedBeforeDispatch).toBe(true);
    expect(replacement.setRefreshParticipant).not.toHaveBeenCalled();
    expect(await replacement.coordinator.state(11, 7)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
  });

  it("does not let initialization or a stale open regrant ownership after close", async () => {
    const initialLoad = deferred<Record<string, unknown>>();
    const storage = gatedInitialStorage(initialLoad.promise);
    const context = setup(storage);

    const opening = context.coordinator.panelOpened(11, 7);
    const closing = context.coordinator.panelClosed(11, 7);
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(7, 11, false);

    initialLoad.resolve({
      "pin-op.tabRefreshStates": [{
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: true,
        participant: true,
        lastAcceptedGeneration: 0,
      }],
    });
    await Promise.all([opening, closing]);

    expect(
      context.setRefreshParticipant.mock.calls.filter(([, , value]) => value),
    ).toEqual([]);
    expect(await context.coordinator.state(11, 7)).toMatchObject({
      participant: false,
      autoRefreshEnabled: true,
    });
  });

  it("lets disable win when it overlaps the first panel open", async () => {
    const initialLoad = deferred<Record<string, unknown>>();
    const context = setup(gatedInitialStorage(initialLoad.promise));

    const opening = context.coordinator.panelOpened(11, 7);
    const disabling = context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    initialLoad.resolve({});

    const [, disabled] = await Promise.all([opening, disabling]);

    expect(disabled).toMatchObject({
      autoRefreshEnabled: false,
      participant: false,
    });
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(
      7,
      11,
      false,
    );
    expect(await context.coordinator.state(11, 7)).toMatchObject({
      autoRefreshEnabled: false,
      participant: false,
    });
  });

  it("retries initialization after transient storage failure without duplicate ownership", async () => {
    const storage = transientReadFailureStorage({
      "pin-op.tabRefreshStates": [{
        tabId: 11,
        windowId: 7,
        autoRefreshEnabled: true,
        ideHighlightEnabled: false,
        participant: true,
        lastAcceptedGeneration: 5,
      }],
    });
    const context = setup(storage);

    await expect(context.coordinator.initialize()).rejects.toThrow(
      "transient storage failure",
    );
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();

    await expect(context.coordinator.state(11, 7)).resolves.toMatchObject({
      participant: false,
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 5,
    });
    await context.coordinator.initialize();
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
  });

  it("retires runtime lifecycle bookkeeping after a failed panel open", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    storage.failNextGet();

    await expect(context.coordinator.panelOpened(11, 7)).rejects.toThrow(
      "transient storage failure",
    );

    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
    expect(context.setRefreshParticipant).not.toHaveBeenCalledWith(
      7,
      11,
      true,
    );
  });

  it("lets a new panel supersede close while an old refresh remains blocked", async () => {
    const dispatchGate = deferred<void>();
    const context = setup(
      undefined,
      () => 11,
      async () => dispatchGate.promise,
    );
    await context.coordinator.panelOpened(11, 7);
    const refreshing = context.coordinator.acceptPageRefresh(
      7,
      refresh(1, "styles"),
    );
    await vi.waitFor(() => expect(context.dispatchRefresh).toHaveBeenCalledOnce());
    context.setRefreshParticipant.mockClear();

    let closed = false;
    let reopened = false;
    const closing = context.coordinator.panelClosed(11, 7).then((state) => {
      closed = true;
      return state;
    });
    const reopening = context.coordinator.panelOpened(11, 7).then((state) => {
      reopened = true;
      return state;
    });
    await flushMicrotasks(32);
    const lifecycleSettledBeforeDispatch = closed && reopened;

    dispatchGate.resolve();
    await Promise.all([refreshing, closing, reopening]);

    expect(lifecycleSettledBeforeDispatch).toBe(true);
    expect(context.setRefreshParticipant.mock.calls).toEqual([
      [7, 11, false],
      [7, 11, true],
    ]);
    expect(await context.coordinator.state(11, 7)).toMatchObject({
      participant: true,
      autoRefreshEnabled: true,
    });
  });

  it("does not let a blocked window refresh overwrite a later tab close", async () => {
    const dispatchGate = deferred<void>();
    const context = setup(
      undefined,
      () => 11,
      async () => dispatchGate.promise,
    );
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(12, 7);
    const refreshing = context.coordinator.acceptPageRefresh(
      7,
      refresh(1, "reload"),
    );
    await vi.waitFor(() => expect(context.dispatchRefresh).toHaveBeenCalledOnce());

    await context.coordinator.panelClosed(12, 7);
    dispatchGate.resolve();
    await refreshing;

    expect(await context.coordinator.state(12, 7)).toMatchObject({
      autoRefreshEnabled: true,
      participant: false,
    });
    expect(await context.coordinator.state(12, 7)).not.toHaveProperty("pending");
  });

  it("does not let an accepted settings update regrant after panel close", async () => {
    const dispatchGate = deferred<void>();
    const context = setup(
      undefined,
      () => 11,
      async () => dispatchGate.promise,
    );
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(12, 7);
    const refreshing = context.coordinator.acceptPageRefresh(
      7,
      refresh(1, "styles"),
    );
    await vi.waitFor(() => expect(context.dispatchRefresh).toHaveBeenCalledOnce());
    const settings = context.coordinator.updateSettings(12, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });

    await context.coordinator.panelClosed(12, 7);
    dispatchGate.resolve();
    await Promise.all([refreshing, settings]);

    expect(await context.coordinator.state(12, 7)).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
    });
  });

  it("refreshes the active participant and leaves only newest work for inactive tabs", async () => {
    let activeTabId = 11;
    const context = setup(undefined, () => activeTabId);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(12, 7);

    await context.coordinator.acceptPageRefresh(7, refresh(1, "styles"));
    expect(context.dispatchRefresh).toHaveBeenCalledTimes(1);
    expect(context.dispatchRefresh).toHaveBeenLastCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "styles",
    });
    expect(await context.coordinator.state(11, 7)).not.toHaveProperty("pending");
    expect(await context.coordinator.state(12, 7)).toHaveProperty(
      "pending",
      { generation: 1, mode: "styles" },
    );

    await context.coordinator.acceptPageRefresh(7, refresh(2, "styles"));
    await context.coordinator.acceptPageRefresh(7, refresh(2, "reload"));
    await context.coordinator.acceptPageRefresh(7, refresh(1, "reload"));
    expect(await context.coordinator.state(12, 7)).toHaveProperty(
      "pending",
      { generation: 2, mode: "reload" },
    );

    activeTabId = 12;
    await context.coordinator.activateTab(12, 7);
    await context.coordinator.activateTab(12, 7);
    expect(context.dispatchRefresh.mock.calls.filter(([tabId]) => tabId === 12))
      .toEqual([
        [
          12,
          {
            type: "pin-op.refresh.execute",
            refreshGeneration: 2,
            mode: "reload",
          },
        ],
      ]);
  });

  it("discards pending work while disabled and never replays disabled generations", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(3, "styles"));
    expect(await context.coordinator.state(11, 7)).toHaveProperty(
      "pending",
      { generation: 3, mode: "styles" },
    );

    const disabled = await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    expect(disabled).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    expect(disabled).not.toHaveProperty("pending");
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(7, 11, false);

    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));
    const enabled = await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    expect(enabled).toMatchObject({
      participant: true,
      lastAcceptedGeneration: 4,
    });
    expect(context.setRefreshParticipant).toHaveBeenLastCalledWith(7, 11, true);
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).not.toHaveBeenCalled();

    await context.coordinator.acceptPageRefresh(7, refresh(5, "styles"));
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).toHaveBeenCalledOnce();
    expect(context.dispatchRefresh).toHaveBeenCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 5,
      mode: "styles",
    });
  });

  it("does not change participation for an IDE Highlight-only update", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    context.setRefreshParticipant.mockClear();

    const enabled = await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    expect(enabled).toMatchObject({
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: true,
    });
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();

    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    context.setRefreshParticipant.mockClear();
    const disabled = await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
    expect(disabled).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
    });
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
  });

  it("does not create participation when settings arrive before panel-open", async () => {
    const context = setup();

    const state = await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });

    expect(state).toMatchObject({ participant: false });
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
  });

  it("keeps a reopened disabled panel out of refresh participation", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
    const closed = await context.coordinator.panelClosed(11, 7);
    expect(closed).toMatchObject({
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
      participant: false,
    });
    context.setRefreshParticipant.mockClear();

    const reopened = await context.coordinator.panelOpened(11, 7);

    expect(reopened).toMatchObject({
      autoRefreshEnabled: false,
      participant: false,
    });
    expect(context.setRefreshParticipant).not.toHaveBeenCalledWith(7, 11, true);
  });

  it("cleans tab and window ownership without touching other windows", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(12, 7);
    await context.coordinator.panelOpened(21, 8);

    await context.coordinator.removeTab(11);
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, false);
    expect((await context.store.loadAll()).map(({ tabId }) => tabId)).toEqual([
      12,
      21,
    ]);

    await context.coordinator.removeWindow(7);
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 12, false);
    expect((await context.store.loadAll()).map(({ tabId }) => tabId)).toEqual([
      12,
      21,
    ]);
  });

  it("dispatches refresh after removed window participation is reopened", async () => {
    let activeTabId = 99;
    const context = setup(undefined, () => activeTabId);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.removeWindow(7);

    const reopened = await context.coordinator.panelOpened(11, 7);
    expect(reopened).toMatchObject({
      autoRefreshEnabled: true,
      participant: true,
    });

    await context.coordinator.acceptPageRefresh(7, refresh(1, "reload"));
    expect(await context.coordinator.state(11, 7)).toHaveProperty(
      "pending",
      { generation: 1, mode: "reload" },
    );

    activeTabId = 11;
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).toHaveBeenCalledOnce();
    expect(context.dispatchRefresh).toHaveBeenCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "reload",
    });
  });

  it("preserves a fail-closed window snapshot for a later panel move", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));

    await context.coordinator.removeWindow(7);

    expect(await context.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    }]);
    const moved = await context.coordinator.panelOpened(11, 8);
    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
  });

  it("lets a waiting moved panel consume the durable window snapshot", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    const snapshotRead = storage.gateNextGet();

    const removing = context.coordinator.removeWindow(7);
    await snapshotRead.started;
    const opening = context.coordinator.panelOpened(11, 8);
    snapshotRead.release();
    const [, moved] = await Promise.all([removing, opening]);

    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      participant: false,
    }]);
  });

  it("rejects a stale same-window panel while window removal owns lifecycle", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    const snapshotRead = storage.gateNextGet();

    const removing = context.coordinator.removeWindow(7);
    await snapshotRead.started;
    await expect(context.coordinator.panelOpened(11, 7)).rejects.toThrow(
      "Window refresh lifecycle is closing",
    );
    snapshotRead.release();
    await removing;

    expect(await context.store.loadAll()).toEqual([
      expect.objectContaining({
        tabId: 11,
        windowId: 7,
        participant: false,
      }),
    ]);
  });

  it("retires window lifecycle fences when best-effort storage access fails", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(12, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await context.coordinator.updateSettings(12, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: true,
    });
    storage.failNextGet();

    await expect(context.coordinator.removeWindow(7)).resolves.toBeUndefined();

    expect(lifecycleRevisionTabIds(context.coordinator)).toEqual([]);
    expect(await context.store.loadAll()).toEqual([
      expect.objectContaining({
        tabId: 11,
        autoRefreshEnabled: false,
        participant: false,
      }),
      expect.objectContaining({
        tabId: 12,
        autoRefreshEnabled: false,
        participant: false,
      }),
    ]);

    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, false);
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 12, false);
  });

  it("retires lifecycle revisions after terminal tab and window removal", async () => {
    const context = setup();
    for (let tabId = 1; tabId <= 32; tabId += 1) {
      await context.coordinator.panelOpened(tabId, 7);
    }

    await context.coordinator.removeWindow(7);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);

    for (let tabId = 33; tabId <= 64; tabId += 1) {
      await context.coordinator.panelOpened(tabId, 8);
      await context.coordinator.removeTab(tabId);
    }
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("lets window-removal authority absorb a concurrent panel close", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);

    const removing = context.coordinator.removeWindow(7);
    const closing = context.coordinator.panelClosed(11, 7);
    await Promise.all([removing, closing]);

    expect(await context.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 0,
    }]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("establishes terminal authority before I/O and rejects every later panel open", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);

    const removalRead = storage.gateNextGet();
    const removing = context.coordinator.removeTab(11);
    await removalRead.started;

    await expect(context.coordinator.panelOpened(11, 8)).rejects.toThrow(
      "Tab refresh lifecycle is terminal",
    );
    removalRead.release();
    await removing;
    await expect(context.coordinator.panelOpened(11, 8)).rejects.toThrow(
      "Tab refresh lifecycle is terminal",
    );
    expect(await context.store.loadAll()).toEqual([]);
    expect(context.setRefreshParticipant).not.toHaveBeenCalledWith(
      8,
      11,
      true,
    );
  });

  it("keeps terminal authority when best-effort preference deletion fails", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));

    storage.failNextRemoveFor("pin-op.tabRefreshStates");

    await expect(context.coordinator.removeTab(11)).resolves.toBeUndefined();
    await expect(context.coordinator.panelOpened(11, 8)).rejects.toThrow(
      "Tab refresh lifecycle is terminal",
    );

    const replacement = setup(storage);
    await replacement.coordinator.initialize();
    expect(await replacement.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    }]);
  });

  it("retires lifecycle bookkeeping while terminal authority survives read failure", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    const opened = await context.coordinator.panelOpened(11, 7);
    storage.failNextGet();

    await expect(context.coordinator.removeTab(11)).resolves.toBeUndefined();

    expect(await context.store.loadAll()).toEqual([{
      ...opened,
      participant: false,
    }]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
    await expect(context.coordinator.panelOpened(11, 8)).rejects.toThrow(
      "Tab refresh lifecycle is terminal",
    );

    await context.coordinator.removeTab(11);
    expect(await context.store.loadAll()).toEqual([]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("clears the synchronous ownership index when a tab is removed", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.removeTab(11);
    context.setRefreshParticipant.mockClear();

    const closing = context.coordinator.panelClosed(11);

    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    await expect(closing).resolves.toBeUndefined();
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("lets terminal removal win over a concurrent windowless panel close", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);

    const removalWrite = storage.gateNextRemove();
    const removing = context.coordinator.removeTab(11);
    await removalWrite.started;
    const closing = context.coordinator.panelClosed(11);
    removalWrite.release();

    await expect(Promise.all([removing, closing])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(await context.store.loadAll()).toEqual([]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("keeps session terminal authority without evicting stale tab ids", async () => {
    const context = setup();
    for (let tabId = 1; tabId <= 4_100; tabId += 1) {
      await context.coordinator.removeTab(tabId);
      await context.coordinator.panelClosed(tabId);
    }

    expect(terminalAuthorityCount(context.coordinator)).toBe(4_100);
    await context.coordinator.panelClosed(1);
    await expect(context.coordinator.panelOpened(1, 7)).rejects.toThrow(
      "Tab refresh lifecycle is terminal",
    );
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("clears the synchronous ownership index on an exact tab detach", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.detachTab(11, 7);
    context.setRefreshParticipant.mockClear();

    const closing = context.coordinator.panelClosed(11);

    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    await expect(closing).resolves.toMatchObject({
      tabId: 11,
      windowId: 7,
      participant: false,
    });
  });

  it("clears only the removed window from the synchronous ownership index", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(21, 8);
    await context.coordinator.removeWindow(7);
    context.setRefreshParticipant.mockClear();

    const removedClosing = context.coordinator.panelClosed(11);
    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    await expect(removedClosing).resolves.toMatchObject({
      tabId: 11,
      windowId: 7,
      participant: false,
    });

    context.setRefreshParticipant.mockClear();
    const retainedClosing = context.coordinator.panelClosed(21);
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(8, 21, false);
    await retainedClosing;
  });

  it("moves a participating tab to an exact new window without carrying pending work", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(3, "reload"));

    const moved = await context.coordinator.panelOpened(11, 8);

    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      participant: true,
      autoRefreshEnabled: true,
    });
    expect(moved).not.toHaveProperty("pending");
    expect(context.setRefreshParticipant.mock.calls.slice(-2)).toEqual([
      [7, 11, false],
      [8, 11, true],
    ]);
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      participant: false,
    }]);
  });

  it("ignores a known old-window close after the tab has moved", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    const moved = await context.coordinator.panelOpened(11, 8);
    context.setRefreshParticipant.mockClear();

    const updating = context.coordinator.updateSettings(11, 8, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
    });
    const staleClosing = context.coordinator.panelClosed(11, 7);

    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    await Promise.all([updating, staleClosing]);
    expect(context.setRefreshParticipant).not.toHaveBeenCalledWith(
      8,
      11,
      false,
    );
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      ideHighlightEnabled: true,
      participant: false,
    }]);
  });

  it("does not let an old-window close supersede an in-flight moved open", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);

    const gate = storage.gateNextGet();
    const opening = context.coordinator.panelOpened(11, 8);
    await gate.started;
    context.setRefreshParticipant.mockClear();
    const staleClosing = context.coordinator.panelClosed(11, 7);

    expect(context.setRefreshParticipant).not.toHaveBeenCalled();
    gate.release();
    const [moved] = await Promise.all([opening, staleClosing]);
    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      participant: true,
    });
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      participant: false,
    }]);
    expect(context.setRefreshParticipant.mock.calls).toEqual([
      [8, 11, true],
    ]);
  });

  it("immediately revokes the moved owner when close has no window id", async () => {
    const context = setup();
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.panelOpened(11, 8);
    await context.coordinator.detachTab(11, 7);
    context.setRefreshParticipant.mockClear();

    const closing = context.coordinator.panelClosed(11);

    expect(context.setRefreshParticipant).toHaveBeenCalledWith(8, 11, false);
    await closing;
  });

  it("starts a new window epoch below persisted generations and clears stale pending", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(100, "reload"));
    expect(await context.coordinator.state(11, 7)).toHaveProperty(
      "pending",
      { generation: 100, mode: "reload" },
    );

    await context.coordinator.beginWindowEpoch(7);
    expect(await context.coordinator.state(11, 7)).toMatchObject({
      lastAcceptedGeneration: 0,
    });
    expect(await context.coordinator.state(11, 7)).not.toHaveProperty("pending");

    await context.coordinator.acceptPageRefresh(7, refresh(1, "styles"));
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).toHaveBeenCalledOnce();
    expect(context.dispatchRefresh).toHaveBeenCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "styles",
    });
  });

  it("clears incompatible pending work until a fresh window epoch", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(5, "reload"));
    expect(await context.coordinator.state(11, 7)).toHaveProperty(
      "pending",
      { generation: 5, mode: "reload" },
    );

    await context.coordinator.clearWindowPending(7);
    await context.coordinator.activateTab(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(5, "reload"));
    expect(context.dispatchRefresh).not.toHaveBeenCalled();
    expect(await context.coordinator.state(11, 7)).not.toHaveProperty("pending");

    await context.coordinator.beginWindowEpoch(7);
    await context.coordinator.acceptPageRefresh(7, refresh(1, "styles"));
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).toHaveBeenCalledOnce();
    expect(context.dispatchRefresh).toHaveBeenCalledWith(11, {
      type: "pin-op.refresh.execute",
      refreshGeneration: 1,
      mode: "styles",
    });
  });

  it("retains an exact old-window snapshot when a tab detaches", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.acceptPageRefresh(7, refresh(1, "reload"));
    context.setRefreshParticipant.mockClear();

    await context.coordinator.detachTab(11, 7);

    expect(context.setRefreshParticipant).toHaveBeenCalledOnce();
    expect(context.setRefreshParticipant).toHaveBeenCalledWith(7, 11, false);
    expect(await context.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: true,
      participant: false,
      lastAcceptedGeneration: 1,
    }]);
    await context.coordinator.acceptPageRefresh(7, refresh(2, "reload"));
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).not.toHaveBeenCalled();
  });

  it("preserves disabled preferences when detach completes before moved open", async () => {
    const context = setup(undefined, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));

    await context.coordinator.detachTab(11, 7);

    expect(await context.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    }]);

    const moved = await context.coordinator.panelOpened(11, 8);
    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
  });

  it("detaches without a durable ownership write and restarts nonparticipating", async () => {
    const storage = gateableStorage();
    const context = setup(storage, () => 99);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
    });
    await context.coordinator.acceptPageRefresh(7, refresh(4, "reload"));
    storage.failNextStateSets();

    await expect(context.coordinator.detachTab(11, 7)).resolves.toBeUndefined();

    const replacement = setup(storage);
    await replacement.coordinator.initialize();
    expect(await replacement.store.loadAll()).toEqual([{
      tabId: 11,
      windowId: 7,
      autoRefreshEnabled: true,
      ideHighlightEnabled: false,
      participant: false,
      lastAcceptedGeneration: 4,
    }]);
    expect(replacement.setRefreshParticipant).not.toHaveBeenCalled();
  });

  it("does not let a delayed old-window detach remove a moved participant", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    context.setRefreshParticipant.mockClear();

    const gate = storage.gateNextGet();
    const detaching = context.coordinator.detachTab(11, 7);
    await gate.started;
    const opening = context.coordinator.panelOpened(11, 8);
    gate.release();
    const [, moved] = await Promise.all([detaching, opening]);

    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: true,
      participant: true,
    });
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      participant: false,
    }]);
    expect(context.setRefreshParticipant).not.toHaveBeenCalledWith(
      8,
      11,
      false,
    );
  });

  it("preserves disabled preferences when detach races a moved panel open", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });

    const gate = storage.gateNextGet();
    const detaching = context.coordinator.detachTab(11, 7);
    await gate.started;
    const opening = context.coordinator.panelOpened(11, 8);
    gate.release();
    const [, moved] = await Promise.all([detaching, opening]);

    expect(moved).toMatchObject({
      tabId: 11,
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    expect(await context.store.loadAll()).toEqual([{
      ...moved,
      participant: false,
    }]);
  });

  it("ignores refresh for another window and reports dispatch failures without replay", async () => {
    const onError = vi.fn();
    const context = setup(undefined, () => 11, async () => {
      throw new Error("content unavailable");
    }, onError);
    await context.coordinator.panelOpened(11, 7);

    await context.coordinator.acceptPageRefresh(8, refresh(1, "reload"));
    expect(context.dispatchRefresh).not.toHaveBeenCalled();
    await context.coordinator.acceptPageRefresh(7, refresh(1, "reload"));
    expect(onError).toHaveBeenCalledOnce();
    expect(await context.coordinator.state(11, 7)).not.toHaveProperty("pending");
    await context.coordinator.activateTab(11, 7);
    expect(context.dispatchRefresh).toHaveBeenCalledOnce();
  });
});

function setup(
  storage = memoryStorage(),
  activeTab: () => number | undefined = () => undefined,
  dispatch: (tabId: number, command: unknown) => Promise<void> = async () => undefined,
  onError = vi.fn(),
) {
  const store = new TabRefreshStateStore(storage);
  const dispatchRefresh = vi.fn(dispatch);
  const setRefreshParticipant = vi.fn();
  const coordinator = new TabRefreshCoordinator({
    store,
    getActiveTabId: async () => activeTab(),
    dispatchRefresh,
    setRefreshParticipant,
    onError,
  });
  return {
    storage,
    store,
    coordinator,
    dispatchRefresh,
    setRefreshParticipant,
  };
}

function lifecycleRevisionCount(coordinator: TabRefreshCoordinator): number {
  return (coordinator as unknown as {
    readonly lifecycleRevisions: ReadonlyMap<number, number>;
  }).lifecycleRevisions.size;
}

function lifecycleRevisionTabIds(
  coordinator: TabRefreshCoordinator,
): number[] {
  return [...(coordinator as unknown as {
    readonly lifecycleRevisions: ReadonlyMap<number, number>;
  }).lifecycleRevisions.keys()].sort((left, right) => left - right);
}

function terminalAuthorityCount(coordinator: TabRefreshCoordinator): number {
  return (coordinator as unknown as {
    readonly terminalTabs?: ReadonlySet<number>;
  }).terminalTabs?.size ?? Number.POSITIVE_INFINITY;
}

function refresh(
  refreshGeneration: number,
  mode: "styles" | "reload",
): PageRefreshMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: `refresh-${refreshGeneration}-${mode}`,
    sessionId: "session-1",
    source: { role: "ide", id: "ide-1" },
    refreshGeneration,
    mode,
    metadata: {},
  };
}

function memoryStorage(): SessionStorage {
  const values = new Map<string, unknown>();
  return {
    async get(key: string) {
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function gatedInitialStorage(
  initial: Promise<Record<string, unknown>>,
): SessionStorage {
  const values = new Map<string, unknown>();
  let firstGet = true;
  return {
    async get(key: string) {
      if (firstGet) {
        firstGet = false;
        const loaded = await initial;
        for (const [storedKey, value] of Object.entries(loaded)) {
          values.set(storedKey, structuredClone(value));
        }
      }
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function transientReadFailureStorage(
  initial: Record<string, unknown>,
): SessionStorage {
  const values = new Map(Object.entries(initial));
  let failed = false;
  return {
    async get(key: string) {
      if (!failed) {
        failed = true;
        throw new Error("transient storage failure");
      }
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function normalizationWriteFailureStorage(
  initial: Record<string, unknown>,
): SessionStorage {
  const values = new Map(Object.entries(initial));
  let failedStateWrite = false;
  return {
    async get(key: string) {
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      if (
        !failedStateWrite &&
        Object.hasOwn(records, "pin-op.tabRefreshStates")
      ) {
        failedStateWrite = true;
        throw new Error("normalization write unavailable");
      }
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
}

function gateableStorage(): SessionStorage & {
  gateNextGet(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  gateNextRemove(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  gateSetFor(key: string, occurrence?: number): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  gateRemoveFor(key: string): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  failNextStateSets(count?: number): void;
  failNextGet(): void;
  failNextRemoveFor(key: string): void;
} {
  const values = new Map<string, unknown>();
  let failNextGet = false;
  let failedStateSetsRemaining = 0;
  let failedRemoveKey: string | undefined;
  let nextGate:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly released: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  let nextRemoveGate:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly released: ReturnType<typeof deferred<void>>;
    }
    | undefined;
  let targetedSetGate:
    | {
        readonly key: string;
        remaining: number;
        readonly started: ReturnType<typeof deferred<void>>;
        readonly released: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  let targetedRemoveGate:
    | {
        readonly key: string;
        readonly started: ReturnType<typeof deferred<void>>;
        readonly released: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  return {
    gateNextGet() {
      if (nextGate) {
        throw new Error("A storage read gate is already pending");
      }
      const started = deferred<void>();
      const released = deferred<void>();
      nextGate = { started, released };
      return {
        started: started.promise,
        release: () => released.resolve(),
      };
    },
    gateNextRemove() {
      if (nextRemoveGate) {
        throw new Error("A storage removal gate is already pending");
      }
      const started = deferred<void>();
      const released = deferred<void>();
      nextRemoveGate = { started, released };
      return {
        started: started.promise,
        release: () => released.resolve(),
      };
    },
    gateSetFor(key: string, occurrence = 1) {
      if (targetedSetGate || occurrence < 1) {
        throw new Error("A targeted storage write gate is already pending");
      }
      const started = deferred<void>();
      const released = deferred<void>();
      targetedSetGate = { key, remaining: occurrence, started, released };
      return {
        started: started.promise,
        release: () => released.resolve(),
      };
    },
    gateRemoveFor(key: string) {
      if (targetedRemoveGate) {
        throw new Error("A targeted storage removal gate is already pending");
      }
      const started = deferred<void>();
      const released = deferred<void>();
      targetedRemoveGate = { key, started, released };
      return {
        started: started.promise,
        release: () => released.resolve(),
      };
    },
    failNextGet() {
      failNextGet = true;
    },
    failNextStateSets(count = 1) {
      failedStateSetsRemaining = count;
    },
    failNextRemoveFor(key: string) {
      failedRemoveKey = key;
    },
    async get(key: string) {
      if (failNextGet) {
        failNextGet = false;
        throw new Error("transient storage failure");
      }
      const gate = nextGate;
      nextGate = undefined;
      if (gate) {
        gate.started.resolve();
        await gate.released.promise;
      }
      return values.has(key) ? { [key]: values.get(key) } : {};
    },
    async set(records: Record<string, unknown>) {
      const setGate = targetedSetGate;
      if (setGate && Object.hasOwn(records, setGate.key)) {
        setGate.remaining -= 1;
        if (setGate.remaining === 0) {
          targetedSetGate = undefined;
          setGate.started.resolve();
          await setGate.released.promise;
        }
      }
      if (
        Object.hasOwn(records, "pin-op.tabRefreshStates") &&
        failedStateSetsRemaining > 0
      ) {
        failedStateSetsRemaining -= 1;
        throw new Error("transient state write failure");
      }
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
      if (failedRemoveKey === key) {
        failedRemoveKey = undefined;
        throw new Error("transient storage remove failure");
      }
      const removeGate = targetedRemoveGate;
      if (removeGate?.key === key) {
        targetedRemoveGate = undefined;
        removeGate.started.resolve();
        await removeGate.released.promise;
      }
      const gate = nextRemoveGate;
      nextRemoveGate = undefined;
      if (gate) {
        gate.started.resolve();
        await gate.released.promise;
      }
      values.delete(key);
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

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}
