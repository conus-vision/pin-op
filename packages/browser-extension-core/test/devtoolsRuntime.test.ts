import { describe, expect, it } from "vitest";
import {
  registerDevtoolsPanel,
  startDevtoolsRuntime,
} from "../src/devtoolsRuntime.js";

describe("registerDevtoolsPanel", () => {
  it("registers a trusted source and re-announces it for panel recovery", async () => {
    let onShown: (() => void) | undefined;
    let runtimeListener: ((message: unknown) => void) | undefined;
    const removed: string[] = [];
    const sent: unknown[] = [];
    const created: unknown[] = [];
    const registration = await registerDevtoolsPanel({
      inspectedTabId: 42,
      channelId: "channel-1",
      sourceId: "firefox-source-1",
      async createPanel(title, icon, page) {
        created.push({ title, icon, page });
        return {
          addShownListener: (listener) => (onShown = listener),
          removeShownListener: () => removed.push("shown"),
        };
      },
      addRuntimeMessageListener(listener) {
        runtimeListener = listener;
        return () => removed.push("runtime");
      },
      async sendRuntimeMessage(message) {
        sent.push(message);
      },
    });

    expect(created).toEqual([
      {
        title: "PinOp",
        icon: "/dist/pinop.svg",
        page: "/dist/panel.html?channel=channel-1",
      },
    ]);
    expect(sent).toEqual([
      {
        type: "pinop.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
    ]);
    runtimeListener?.({ type: "pinop.panelReady", channel: "other" });
    runtimeListener?.({
      type: "pinop.panelReady",
      channel: "channel-1",
    });
    onShown?.();
    expect(sent).toEqual([
      {
        type: "pinop.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
      {
        type: "pinop.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
      {
        type: "pinop.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
    ]);

    registration.dispose();
    expect(removed).toEqual(["shown", "runtime"]);
  });

  it("removes its runtime listener when panel creation fails", async () => {
    const removed: string[] = [];

    await expect(
      registerDevtoolsPanel({
        inspectedTabId: 42,
        channelId: "channel-1",
        sourceId: "firefox-source-1",
        async createPanel() {
          throw new Error("panel unavailable");
        },
        addRuntimeMessageListener() {
          return () => removed.push("runtime");
        },
        async sendRuntimeMessage() {},
      }),
    ).rejects.toThrow("panel unavailable");

    expect(removed).toEqual(["runtime"]);
  });
});

describe("startDevtoolsRuntime", () => {
  it("owns registration startup and unload cleanup", async () => {
    const sent: unknown[] = [];
    const removals: string[] = [];
    let unload: (() => void) | undefined;
    let nextId = 0;
    const runtime = startDevtoolsRuntime({
      inspectedTabId: 42,
      sourcePrefix: "firefox",
      createId: () => `id-${++nextId}`,
      async createPanel() {
        return {
          addShownListener() {},
          removeShownListener: () => removals.push("shown"),
        };
      },
      subscribeRuntimeMessages() {
        return () => removals.push("runtime");
      },
      async sendRuntimeMessage(message) {
        sent.push(message);
      },
      subscribeUnload(listener) {
        unload = listener;
        return () => removals.push("unload");
      },
    });

    await runtime.ready;
    expect(sent).toEqual([
      {
        type: "pinop.registerDevtools",
        channel: "id-1",
        tabId: 42,
        sourceId: "firefox-id-2",
      },
    ]);

    unload?.();
    runtime.dispose();
    expect(removals).toEqual(["unload", "shown", "runtime"]);
  });

  it("disposes a late registration after unload during panel creation", async () => {
    let resolvePanel!: (panel: {
      addShownListener(): void;
      removeShownListener(): void;
    }) => void;
    let unload: (() => void) | undefined;
    const removed: string[] = [];
    const panelPromise = new Promise<{
      addShownListener(): void;
      removeShownListener(): void;
    }>((resolve) => {
      resolvePanel = resolve;
    });
    const runtime = startDevtoolsRuntime({
      inspectedTabId: 42,
      sourcePrefix: "firefox",
      createId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
      createPanel: () => panelPromise,
      subscribeRuntimeMessages: () => () => removed.push("runtime"),
      sendRuntimeMessage: async () => undefined,
      subscribeUnload(listener) {
        unload = listener;
        return () => removed.push("unload");
      },
    });

    unload?.();
    resolvePanel({
      addShownListener() {},
      removeShownListener: () => removed.push("shown"),
    });
    await runtime.ready;
    expect(removed).toEqual(["unload", "shown", "runtime"]);
  });
});
