import {
  PROTOCOL_VERSION,
  type PageRefreshMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "../src/browserWindowLinkStore.js";
import { TabRefreshCoordinator } from "../src/tabRefreshCoordinator.js";
import { TabRefreshStateStore } from "../src/tabRefreshStateStore.js";

describe("TabRefreshCoordinator", () => {
  it("makes a default-on tab a persistent participant when its panel opens", async () => {
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

    const replacement = setup(context.storage);
    await replacement.coordinator.initialize();
    expect(replacement.setRefreshParticipant).toHaveBeenCalledWith(7, 11, true);
    expect(await replacement.coordinator.state(11, 7)).toMatchObject({
      participant: true,
      autoRefreshEnabled: true,
    });
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
    await flushMicrotasks();
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
      participant: true,
      ideHighlightEnabled: false,
      lastAcceptedGeneration: 5,
    });
    await context.coordinator.initialize();
    expect(context.setRefreshParticipant.mock.calls).toEqual([
      [7, 11, true],
    ]);
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
      21,
    ]);
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

  it("does not let delayed terminal removal delete a newer panel lifecycle", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);

    const gate = storage.gateNextGet();
    const removing = context.coordinator.removeTab(11);
    await gate.started;
    const opening = context.coordinator.panelOpened(11, 8);
    gate.release();
    const [, moved] = await Promise.all([removing, opening]);

    expect(await context.store.loadAll()).toEqual([moved]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(1);

    await context.coordinator.removeTab(11);
    expect(await context.store.loadAll()).toEqual([]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(0);
  });

  it("rechecks terminal lifecycle after the storage removal read", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });

    const coordinatorRead = storage.gateNextGet();
    const removing = context.coordinator.removeTab(11);
    await coordinatorRead.started;
    coordinatorRead.release();
    const removalRead = storage.gateNextGet();
    await removalRead.started;

    const opening = context.coordinator.panelOpened(11, 8);
    removalRead.release();
    const [, moved] = await Promise.all([removing, opening]);

    expect(moved).toMatchObject({
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    expect(await context.store.loadAll()).toEqual([moved]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(1);
  });

  it("restores preferences when a new panel opens during the storage removal write", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    await context.coordinator.panelOpened(11, 7);
    await context.coordinator.updateSettings(11, 7, {
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
    });

    const removalWrite = storage.gateNextRemove();
    const removing = context.coordinator.removeTab(11);
    await removalWrite.started;

    const opening = context.coordinator.panelOpened(11, 8);
    removalWrite.release();
    const [, moved] = await Promise.all([removing, opening]);

    expect(moved).toMatchObject({
      windowId: 8,
      autoRefreshEnabled: false,
      ideHighlightEnabled: false,
      participant: false,
    });
    expect(await context.store.loadAll()).toEqual([moved]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(1);
  });

  it("retains a terminal lifecycle fence until failed storage teardown retries", async () => {
    const storage = gateableStorage();
    const context = setup(storage);
    const opened = await context.coordinator.panelOpened(11, 7);
    storage.failNextGet();

    await expect(context.coordinator.removeTab(11)).rejects.toThrow(
      "transient storage failure",
    );

    expect(await context.store.loadAll()).toEqual([opened]);
    expect(lifecycleRevisionCount(context.coordinator)).toBe(1);

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
    await expect(removedClosing).resolves.toBeUndefined();

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
    expect(await context.store.loadAll()).toEqual([moved]);
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
    expect(await context.store.loadAll()).toEqual([moved]);
    expect(context.setRefreshParticipant.mock.calls).toEqual([
      [7, 11, false],
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
    expect(await context.store.loadAll()).toEqual([moved]);
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
    expect(await context.store.loadAll()).toEqual([moved]);
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

function gateableStorage(): SessionStorage & {
  gateNextGet(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  gateNextRemove(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  failNextGet(): void;
} {
  const values = new Map<string, unknown>();
  let failNextGet = false;
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
    failNextGet() {
      failNextGet = true;
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
      for (const [key, value] of Object.entries(records)) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(key: string) {
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
