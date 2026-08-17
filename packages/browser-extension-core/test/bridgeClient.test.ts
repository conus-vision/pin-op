import {
  PinOpMessageSchema,
  INSPECT_ENVELOPE_MAX_BYTES,
  PresentationSettingsMessageSchema,
  PROTOCOL_VERSION,
  SourceMatchesMessageSchema,
  SourceNavigateMessageSchema,
  SourceOpenMessageSchema,
  protocolMismatchReason,
  type PageRefreshMessage,
  type PeerStateMessage,
  type SourceMatchesMessage,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserBridgeClient,
  InspectPublisher,
  type BrowserBridgeClientOptions,
  type BrowserCredentials,
  type InspectPayload,
  type InspectSendOutcome,
} from "../src/bridgeClient.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OTHER_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";
const AUTH_TOKEN = "a".repeat(64);
const CREDENTIALS: BrowserCredentials = {
  sessionId: SESSION_ID,
  bridgeInstanceId: INSTANCE_ID,
  authToken: AUTH_TOKEN,
};

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly events: string[] = [];
  closed = false;
  throwOnSend = false;

  send(payload: string): void {
    if (this.throwOnSend) {
      throw new Error("socket send failed");
    }
    this.sent.push(payload);
    this.events.push(`send:${JSON.parse(payload).type as string}`);
  }

  close(): void {
    this.closed = true;
    this.events.push("close");
    this.onclose?.({ code: 1_000, reason: "" });
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(code = 1_006, reason = ""): void {
    this.closed = true;
    this.onclose?.({ code, reason });
  }

  serverCloseEvent(event: { code: number; reason: string }): void {
    this.closed = true;
    this.onclose?.(event);
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("BrowserBridgeClient", () => {
  it("links with a leading-zero PIN and connects only after authentication", () => {
    const harness = createHarness();

    harness.client.link("07");
    expect((harness.client as unknown as Record<string, unknown>).pair).toBeUndefined();
    harness.sockets[0].open();

    expect(JSON.parse(harness.sockets[0].sent[0])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "linkRequest",
      pin: "07",
      source: { role: "browser", id: "firefox-test" },
    });
    expect(harness.states).toEqual(["connecting", "linking"]);

    acceptLink(harness.sockets[0]);

    expect(harness.credentials).toEqual([]);
    expect(JSON.parse(harness.sockets[0].sent[1])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: AUTH_TOKEN,
      source: { role: "browser", id: "firefox-test" },
      capabilities: [
        "inspect",
        "link",
        "source-presentation",
        "presentation-settings",
        "source-navigation",
        "auto-refresh",
      ],
    });
    expect(harness.states).not.toContain("connected");

    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-before-auth",
      sentAt: "2026-07-10T10:00:00.000Z",
      metadata: {},
    });
    expect(harness.sockets[0].sent).toHaveLength(2);

    authenticate(harness.sockets[0]);

    expect(harness.states.at(-1)).toBe("connected");
    expect(harness.credentials).toEqual([CREDENTIALS]);
  });

  it("reconnects with saved credentials without retaining the PIN", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].open();
    acceptLink(harness.sockets[0]);
    authenticate(harness.sockets[0]);
    harness.sockets[0].serverClose();

    expect(harness.states.at(-1)).toBe("reconnecting");
    harness.runNextTimer();
    harness.sockets[1].open();

    const reconnectHello = JSON.parse(harness.sockets[1].sent[0]);
    expect(reconnectHello).toMatchObject({
      type: "hello",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: AUTH_TOKEN,
    });
    expect(reconnectHello).not.toHaveProperty("pin");
    expect(harness.sockets[1].sent).toHaveLength(1);
    expect(harness.credentials).toEqual([CREDENTIALS]);
  });

  it("terminates an unreachable initial link without reconnecting", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].serverClose();

    expect(harness.states.at(-1)).toBe("error");
    expect(harness.errors.at(-1)).toMatchObject({
      code: "link.unreachable",
    });
    expect(harness.delays).toEqual([]);
    expect(harness.sockets).toHaveLength(1);
  });

  it("does not reconnect credentials issued before link authentication", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].open();
    acceptLink(harness.sockets[0]);
    harness.sockets[0].serverClose();

    expect(harness.states.at(-1)).toBe("error");
    expect(harness.errors.at(-1)).toMatchObject({
      code: "link.unreachable",
    });
    expect(harness.delays).toEqual([]);
    expect(harness.credentials).toEqual([]);
  });

  it("lets an external owner disable automatic reconnect timing", () => {
    const harness = createHarness({ autoReconnect: false });

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].serverClose();

    expect(harness.states.at(-1)).toBe("disconnected");
    expect(harness.delays).toEqual([]);
  });

  it("caps saved-credential reconnects with bridge.offline", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].serverClose();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      harness.runNextTimer();
      harness.sockets.at(-1)?.serverClose();
    }

    expect(harness.delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(harness.sockets).toHaveLength(6);
    expect(harness.states.at(-1)).toBe("error");
    expect(harness.errors.at(-1)).toMatchObject({ code: "bridge.offline" });
    expect(() => harness.runNextTimer()).toThrow(
      "Expected a pending reconnect timer",
    );
  });

  it("reuses complete credentials, then sends inspect and answers ping", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    expect(JSON.parse(harness.sockets[0].sent[0])).toMatchObject({
      type: "hello",
      bridgeInstanceId: INSTANCE_ID,
    });
    expect(
      harness.client.sendInspect(
        "inspect-before-auth",
        selection(".card"),
        "firefox-test",
      ),
    ).toBe("not-connected");

    authenticate(harness.sockets[0]);
    expect(
      harness.client.sendInspect(
        "inspect-card",
        selection(".card"),
        "firefox-test",
      ),
    ).toBe("sent");
    const inspect = JSON.parse(harness.sockets[0].sent[1]);
    expect(PinOpMessageSchema.parse(inspect)).toEqual(inspect);
    expect(inspect).toMatchObject({
      type: "inspect",
      messageId: "inspect-card",
      sessionId: SESSION_ID,
      targets: [{ subject: { selector: ".card" } }],
    });

    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-1",
      sentAt: "2026-07-10T10:00:00.000Z",
      metadata: {},
    });
    expect(JSON.parse(harness.sockets[0].sent[2])).toMatchObject({
      type: "pong",
      pingMessageId: "ping-1",
    });
  });

  it("sends strict previous and next source navigation from authenticated credentials", () => {
    const harness = createHarness();
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    for (const direction of ["previous", "next"] as const) {
      expect(harness.client.sendSourceNavigation({
        inspectMessageId: "inspect-card",
        resolutionGeneration: 3,
        direction,
        sessionId: "panel-supplied-session",
        messageId: "panel-supplied-message",
      } as never)).toBe("sent");

      const message = JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}");
      expect(SourceNavigateMessageSchema.parse(message)).toEqual(message);
      expect(message).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        type: "source.navigate",
        messageId: direction === "previous" ? "message-2" : "message-3",
        sessionId: SESSION_ID,
        inspectMessageId: "inspect-card",
        resolutionGeneration: 3,
        direction,
        metadata: {},
      });
    }
  });

  it("returns inspect-style outcomes for unavailable, invalid, and failed navigation sends", () => {
    const harness = createHarness();
    const navigation = {
      inspectMessageId: "inspect-card",
      resolutionGeneration: 3,
      direction: "next" as const,
    };

    expect(harness.client.sendSourceNavigation(navigation)).toBe(
      "not-connected",
    );
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    expect(harness.client.sendSourceNavigation(navigation)).toBe(
      "not-connected",
    );
    authenticate(harness.sockets[0]);

    expect(harness.client.sendSourceNavigation({
      ...navigation,
      inspectMessageId: "",
    })).toBe("invalid-message");
    expect(harness.sockets[0].sent).toHaveLength(1);
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });

    harness.sockets[0].throwOnSend = true;
    expect(harness.client.sendSourceNavigation(navigation)).toBe(
      "transport-error",
    );
    expect(harness.errors.at(-1)?.message).toMatch(/source navigation send/i);
  });

  it("sends strict source open and presentation settings from authenticated credentials", () => {
    const harness = createHarness();
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    expect(harness.client.sendSourceOpen({
      inspectMessageId: "inspect-card",
      resolutionGeneration: 3,
      matchId: "match-card",
      sessionId: "panel-session",
    } as never)).toBe("invalid-message");
    expect(harness.client.sendPresentationSettings({
      inspectMessageId: "inspect-card",
      ideHighlightEnabled: false,
      source: { role: "ide", id: "panel-source" },
    } as never)).toBe("invalid-message");
    expect(harness.sockets[0].sent).toHaveLength(1);

    expect(harness.client.sendSourceOpen({
      inspectMessageId: "inspect-card",
      resolutionGeneration: 3,
      matchId: "match-card",
    })).toBe("sent");
    expect(harness.client.sendPresentationSettings({
      inspectMessageId: "inspect-card",
      ideHighlightEnabled: false,
    })).toBe("sent");

    const sourceOpen = JSON.parse(harness.sockets[0].sent[1] ?? "{}");
    const presentationSettings = JSON.parse(
      harness.sockets[0].sent[2] ?? "{}",
    );
    expect(SourceOpenMessageSchema.parse(sourceOpen)).toEqual(sourceOpen);
    expect(PresentationSettingsMessageSchema.parse(presentationSettings))
      .toEqual(presentationSettings);
    expect(sourceOpen).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "source.open",
      messageId: "message-2",
      sessionId: SESSION_ID,
      inspectMessageId: "inspect-card",
      resolutionGeneration: 3,
      matchId: "match-card",
      metadata: {},
    });
    expect(presentationSettings).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "presentation.settings",
      messageId: "message-3",
      sessionId: SESSION_ID,
      inspectMessageId: "inspect-card",
      ideHighlightEnabled: false,
      metadata: {},
    });
  });

  it("fails closed for unavailable, invalid, accessor-backed, and failed source presentation sends", () => {
    const harness = createHarness();
    const sourceOpen = {
      inspectMessageId: "inspect-card",
      resolutionGeneration: 3,
      matchId: "match-card",
    };
    const settings = {
      inspectMessageId: "inspect-card",
      ideHighlightEnabled: true,
    };

    expect(harness.client.sendSourceOpen(sourceOpen)).toBe("not-connected");
    expect(harness.client.sendPresentationSettings(settings)).toBe(
      "not-connected",
    );
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    expect(harness.client.sendSourceOpen({
      ...sourceOpen,
      matchId: "x".repeat(129),
    })).toBe("invalid-message");
    const hostile = { ...settings } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(hostile, "ideHighlightEnabled", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    expect(() => harness.client.sendPresentationSettings(hostile as never))
      .not.toThrow();
    expect(harness.client.sendPresentationSettings(hostile as never)).toBe(
      "invalid-message",
    );
    expect(getterCalls).toBe(0);
    expect(harness.sockets[0].sent).toHaveLength(1);

    harness.sockets[0].throwOnSend = true;
    expect(harness.client.sendSourceOpen(sourceOpen)).toBe("transport-error");
    expect(harness.client.sendPresentationSettings(settings)).toBe(
      "transport-error",
    );
  });

  it("preserves an extensible plugin fact byte-for-byte at the WebSocket boundary", () => {
    const harness = createHarness();
    const clean = selection(".card");
    const pluginFact = {
      type: "dom.tree",
      payload: {
        node: {
          nodeRef: "plugin-node",
          tree: [
            { label: "article.card", children: [] },
          ],
        },
        nextCursor: "plugin-cursor-2",
      },
      metadata: {
        tree: "plugin-owned",
        nextCursor: "plugin-metadata-cursor",
      },
    };
    const payload = {
      ...clean,
      nodeRef: "top-node",
      ancestorPath: [{ nodeRef: "top-parent" }],
      targets: clean.targets.map((target) => ({
        ...target,
        facts: [...target.facts, pluginFact],
      })),
    } as unknown as InspectPayload;

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    expect(
      harness.client.sendInspect("inspect-plugin", payload, "firefox-test"),
    ).toBe("sent");
    const serialized = harness.sockets[0].sent[1] ?? "";
    const message = JSON.parse(serialized);

    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(message).not.toHaveProperty("nodeRef");
    expect(message).not.toHaveProperty("ancestorPath");
    expect(JSON.stringify(message.targets[0].facts[0])).toBe(
      JSON.stringify(pluginFact),
    );
  });

  it("rejects malformed internal fields inside a strict inspect target", () => {
    const harness = createHarness();
    const clean = selection(".card");
    const payload = {
      ...clean,
      targets: clean.targets.map((target) => ({
        ...target,
        nodeRef: "browser-local-node",
      })),
    } as unknown as InspectPayload;

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    const sentBeforeInspect = harness.sockets[0].sent.length;

    expect(
      harness.client.sendInspect("inspect-invalid", payload, "firefox-test"),
    ).toBe("invalid-message");
    expect(harness.sockets[0].sent).toHaveLength(sentBeforeInspect);
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
  });

  it("uses a per-inspect source without changing the connection source", () => {
    const source = {
      role: "browser" as const,
      id: "window-10",
      label: "Firefox window 10",
      metadata: {
        trace: "preserved",
        browserName: "Firefox",
        windowId: 10,
        browserWindowId: 10,
        tabId: 101,
        browser_tab_id: 101,
        nested: {
          inspectedTabId: 101,
          allowed: "yes",
        },
      },
    };
    const harness = createHarness({
      source,
    });

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    const hello = JSON.parse(harness.sockets[0].sent[0]);
    expect(hello).toMatchObject({
      type: "hello",
      source: {
        role: "browser",
        id: "window-10",
        label: "Firefox window 10",
      },
    });
    expect(hello.source.metadata).toEqual({
      trace: "preserved",
      browserName: "Firefox",
      nested: { allowed: "yes" },
    });
    authenticate(harness.sockets[0]);

    const payload = {
      ...selection(".card"),
      metadata: {
        trace: "preserved",
        browserWindowId: 10,
        tabId: 101,
      },
    };
    expect(
      harness.client.sendInspect("inspect-panel-101", payload, "panel-101"),
    ).toBe("sent");
    const message = JSON.parse(harness.sockets[0].sent[1]);
    expect(message).toMatchObject({
      type: "inspect",
      source: {
        role: "browser",
        id: "panel-101",
        label: "Firefox window 10",
      },
    });
    expect(message.source.metadata).toEqual({
      trace: "preserved",
      browserName: "Firefox",
      nested: { allowed: "yes" },
    });
    expect(message.metadata).toEqual({ trace: "preserved" });
    expect(payload.metadata).toEqual({
      trace: "preserved",
      browserWindowId: 10,
      tabId: 101,
    });
    expect(source.metadata).toEqual({
      trace: "preserved",
      browserName: "Firefox",
      windowId: 10,
      browserWindowId: 10,
      tabId: 101,
      browser_tab_id: 101,
      nested: {
        inspectedTabId: 101,
        allowed: "yes",
      },
    });
  });

  it("rejects an over-budget inspect payload without sending or leaking it", () => {
    const harness = createHarness();
    const padding = "sensitive-marker".repeat(
      Math.ceil(INSPECT_ENVELOPE_MAX_BYTES / "sensitive-marker".length),
    );

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    let sent: InspectSendOutcome | undefined;
    expect(() => {
      sent = harness.client.sendInspect(
        "inspect-too-large",
        {
          ...selection(".card"),
          metadata: { padding },
        },
        "firefox-test",
      );
    }).not.toThrow();
    expect(sent).toBe("invalid-message");
    expect(harness.sockets[0].sent).toHaveLength(1);
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
    expect(harness.errors.at(-1)?.message).not.toContain("sensitive-marker");
  });

  it.each([
    ["session", "another-session", INSTANCE_ID],
    ["bridge instance", SESSION_ID, OTHER_INSTANCE_ID],
  ])(
    "rejects authentication for the wrong %s",
    (_identity, sessionId, bridgeInstanceId) => {
      const harness = createHarness();

      harness.client.connect(CREDENTIALS);
      harness.sockets[0].open();
      authenticate(harness.sockets[0], sessionId, bridgeInstanceId);

      expect(harness.states).not.toContain("connected");
      expect(harness.errors.at(-1)).toMatchObject({
        code: "protocol.invalidMessage",
      });
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);
    },
  );

  it.each(["auth.instanceChanged", "auth.tokenRejected"] as const)(
    "stops reconnect and sanitizes %s",
    (code) => {
      const harness = createHarness();

      harness.client.connect(CREDENTIALS);
      harness.sockets[0].open();
      harness.sockets[0].message({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "auth-error-1",
        code,
        message: `Rejected credential ${AUTH_TOKEN}`,
        metadata: {},
      });

      expect(harness.errors).toHaveLength(1);
      expect(harness.errors[0]).toMatchObject({ code });
      expect(harness.errors[0]?.message).not.toContain(AUTH_TOKEN);
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);
    },
  );

  it("sanitizes link errors without exposing the PIN", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].open();
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      messageId: "link-error-1",
      code: "link.rejected",
      message: "Rejected PIN 07",
      metadata: {},
    });

    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatchObject({ code: "link.rejected" });
    expect(harness.errors[0]?.message).not.toContain("07");
    expect(harness.sockets[0].closed).toBe(true);
    expect(harness.delays).toEqual([]);
  });

  it("unlinks an authenticated session before closing and clearing state", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.client.unlink();

    expect(JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}")).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "unlink",
      sessionId: SESSION_ID,
    });
    expect(harness.sockets[0].events.slice(-2)).toEqual(["send:unlink", "close"]);
    expect(harness.states.at(-1)).toBe("disconnected");
    expect(
      harness.client.sendInspect(
        "inspect-after-unlink",
        selection(".after-unlink"),
        "firefox-test",
      ),
    ).toBe("not-connected");
    expect(harness.delays).toEqual([]);
  });

  it("reports nonfatal application errors without disabling inspection", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    const payload = selection(".card");
    expect(
      harness.client.sendInspect("inspect-before-error", payload, "firefox-test"),
    ).toBe("sent");
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      messageId: "error-1",
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
      metadata: {},
    });

    expect(harness.errors.at(-1)).toMatchObject({
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
    });
    expect(harness.states.at(-1)).toBe("connected");
    expect(harness.sockets[0].closed).toBe(false);
    expect(
      harness.client.sendInspect("inspect-after-error", payload, "firefox-test"),
    ).toBe("sent");
    expect(JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}")).toMatchObject({
      type: "inspect",
      targets: [{ subject: { selector: ".card" } }],
    });
  });

  it("delivers authenticated resolution and peer-state messages to disposable listeners", () => {
    const harness = createHarness();
    const resolutions: ResolutionMessage[] = [];
    const peerStates: PeerStateMessage[] = [];
    const resolutionSubscription = harness.client.onResolution((_context, message) => {
      resolutions.push(message);
    });
    const peerSubscription = harness.client.onPeerState((message) => {
      peerStates.push(message);
    });
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.sockets[0].message(resolutionMessage("inspect-a", 1));
    harness.sockets[0].message(peerStateMessage(true, 1));
    expect(resolutions).toEqual([resolutionMessage("inspect-a", 1)]);
    expect(peerStates).toEqual([peerStateMessage(true, 1)]);

    resolutionSubscription.dispose();
    peerSubscription.dispose();
    harness.sockets[0].message(resolutionMessage("inspect-a", 2));
    harness.sockets[0].message(peerStateMessage(false, 2));
    expect(resolutions).toHaveLength(1);
    expect(peerStates).toHaveLength(1);
  });

  it("carries authenticated IDE identity separately from routed payloads", () => {
    const harness = createHarness();
    const resolutionEvents: Array<readonly [unknown, unknown]> = [];
    const navigationEvents: Array<readonly [unknown, unknown]> = [];
    harness.client.onResolution((context, message) => {
      resolutionEvents.push([context, message]);
    });
    harness.client.onSourceNavigationState((context, message) => {
      navigationEvents.push([context, message]);
    });
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    const resolution = resolutionMessage("inspect-a", 1);
    const navigation = sourceNavigationState(SESSION_ID, 1, 0);

    harness.sockets[0].message(resolution);
    harness.sockets[0].message(navigation);

    expect(resolutionEvents).toHaveLength(1);
    expect(resolutionEvents[0]?.[0]).toMatchObject({
      windowId: 10,
      sessionId: CREDENTIALS.sessionId,
      source: { role: "ide", id: "vscode-test" },
    });
    expect(resolutionEvents[0]?.[1]).toEqual(resolution);
    expect(navigationEvents[0]?.[0]).toEqual(resolutionEvents[0]?.[0]);
    expect(navigationEvents[0]?.[1]).toEqual(navigation);
  });

  it("delivers only same-session source navigation state to active listeners", () => {
    const harness = createHarness();
    const received: SourceNavigationStateMessage[] = [];
    const subscription = harness.client.onSourceNavigationState((_context, message) => {
      received.push(message);
    });
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.sockets[0].message(sourceNavigationState("other-session", 3));
    expect(received).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(harness.sockets[0].closed).toBe(false);

    const current = sourceNavigationState(SESSION_ID, 3, 0);
    harness.sockets[0].message(current);
    expect(received).toEqual([current]);

    subscription.dispose();
    harness.sockets[0].message(sourceNavigationState(SESSION_ID, 3));
    expect(received).toEqual([current]);
  });

  it("delivers only strict authenticated same-session source matches with trusted context", () => {
    const harness = createHarness();
    const received: Array<readonly [unknown, SourceMatchesMessage]> = [];
    const subscription = harness.client.onSourceMatches((context, message) => {
      received.push([context, message]);
    });
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    const current = sourceMatchesMessage(SESSION_ID, 3);

    harness.sockets[0].message(sourceMatchesMessage("other-session", 3));
    expect(received).toEqual([]);

    harness.sockets[0].message(current);
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]).toMatchObject({
      windowId: 10,
      sessionId: SESSION_ID,
      source: { role: "ide", id: "vscode-test" },
    });
    expect(received[0]?.[1]).toEqual(
      SourceMatchesMessageSchema.parse(current),
    );

    subscription.dispose();
    harness.sockets[0].message(sourceMatchesMessage(SESSION_ID, 4));
    expect(received).toHaveLength(1);
  });

  it.each([
    {
      name: "malformed JSON",
      sendInvalid: (socket: FakeSocket, _message: SourceMatchesMessage) => {
        socket.onmessage?.({ data: "{" });
      },
    },
    {
      name: "a schema-invalid protocol message",
      sendInvalid: (socket: FakeSocket, message: SourceMatchesMessage) => {
        socket.message({ ...message, uri: "file:///secret.scss" });
      },
    },
  ])("retires authenticated transport after $name", ({ sendInvalid }) => {
    const harness = createHarness();
    const received: SourceMatchesMessage[] = [];
    harness.client.onSourceMatches((_context, message) => received.push(message));
    harness.client.connect(CREDENTIALS);
    const socket = harness.sockets[0];
    socket.open();
    authenticate(socket);
    const staleMessageHandler = socket.onmessage;
    const validMessage = sourceMatchesMessage(SESSION_ID, 3);

    sendInvalid(socket, validMessage);

    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
    expect(harness.states.at(-1)).toBe("error");
    expect(socket.closed).toBe(true);
    expect(harness.delays).toEqual([]);
    expect(
      (harness.client as unknown as { authenticated: boolean }).authenticated,
    ).toBe(false);
    expect(
      (harness.client as unknown as { credentials?: BrowserCredentials })
        .credentials,
    ).toBeUndefined();
    expect(
      harness.client.sendInspect(
        "inspect-after-protocol-error",
        selection(".card"),
        "firefox-test",
      ),
    ).toBe("not-connected");

    staleMessageHandler?.({ data: JSON.stringify(validMessage) });
    socket.message(validMessage);
    expect(received).toEqual([]);
  });

  it("delivers authenticated same-session page refresh messages to disposable listeners", () => {
    const harness = createHarness();
    const received: PageRefreshMessage[] = [];
    const subscription = harness.client.onPageRefresh((message) =>
      received.push(message),
    );
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.sockets[0].message(pageRefreshMessage(1, SESSION_ID));
    harness.sockets[0].message(pageRefreshMessage(2, "another-session"));
    subscription.dispose();
    harness.sockets[0].message(pageRefreshMessage(3, SESSION_ID));

    expect(received.map(({ refreshGeneration }) => refreshGeneration)).toEqual([
      1,
    ]);
  });

  it("exposes known and unknown protocol mismatch details from close 1002 without reconnecting", () => {
    const known = createHarness();
    const knownMismatches: unknown[] = [];
    known.client.onProtocolMismatch((details) => knownMismatches.push(details));
    known.client.connect(CREDENTIALS);
    known.sockets[0].open();
    known.sockets[0].serverCloseEvent(
      Object.create({
        code: 1_002,
        reason: protocolMismatchReason(5),
      }) as { code: number; reason: string },
    );

    expect(knownMismatches).toEqual([
      { browserProtocolVersion: PROTOCOL_VERSION, peerProtocolVersion: 5 },
    ]);
    expect(known.states.at(-1)).toBe("incompatible");
    expect(known.sockets).toHaveLength(1);

    const unknown = createHarness();
    const unknownMismatches: unknown[] = [];
    unknown.client.onProtocolMismatch((details) =>
      unknownMismatches.push(details),
    );
    unknown.client.connect(CREDENTIALS);
    unknown.sockets[0].open();
    unknown.sockets[0].serverClose(1_002, "unparseable");

    expect(unknownMismatches).toEqual([
      { browserProtocolVersion: PROTOCOL_VERSION },
    ]);
    expect(unknown.states.at(-1)).toBe("incompatible");
    expect(unknown.sockets).toHaveLength(1);
  });

  it("contains throwing close-event accessors without treating them as a mismatch", () => {
    const harness = createHarness();
    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    const event = Object.create(null) as { code: number; reason: string };
    Object.defineProperties(event, {
      code: {
        get(): never {
          throw new Error("hostile close code");
        },
      },
      reason: {
        get(): never {
          throw new Error("hostile close reason");
        },
      },
    });

    expect(() => harness.sockets[0].serverCloseEvent(event)).not.toThrow();
    expect(harness.states.at(-1)).not.toBe("incompatible");
  });
});

describe("InspectPublisher", () => {
  it("deduplicates selections and sends only the latest pending value per 100ms", () => {
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const cleared: number[] = [];
    const sent: string[] = [];
    let timerId = 0;
    const publisher = new InspectPublisher({
      send: (payload) => sent.push(payload.targets[0]?.subject.selector ?? ""),
      setTimeout(callback, delay) {
        timers.push(callback);
        delays.push(delay);
        return ++timerId;
      },
      clearTimeout: (timer) => cleared.push(timer as number),
    });

    publisher.publish(selection(".card"));
    publisher.publish(selection(".card"));
    publisher.publish(selection(".featured"));
    publisher.publish(selection(".layout"));
    expect(sent).toEqual([".card"]);

    timers.shift()?.();
    expect(sent).toEqual([".card", ".layout"]);
    expect(delays).toEqual([100, 100]);

    publisher.dispose();
    expect(cleared).toEqual([2]);
  });

  it("allows the same selection after a connection reset", () => {
    const sent: string[] = [];
    const publisher = new InspectPublisher({
      send: (payload) => sent.push(payload.targets[0]?.subject.selector ?? ""),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    publisher.publish(selection(".card"));
    publisher.reset();
    publisher.publish(selection(".card"));

    expect(sent).toEqual([".card", ".card"]);
  });
});

function createHarness(
  options: Pick<BrowserBridgeClientOptions, "autoReconnect" | "source"> = {},
) {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const errors: Error[] = [];
  const credentials: BrowserCredentials[] = [];
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let timerSequence = 0;
  const client = new BrowserBridgeClient({
    url: "ws://127.0.0.1:48735",
    windowId: 10,
    sourceId: "firefox-test",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    messageId: () => `message-${++sequence}`,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    setTimeout: (callback, delay) => {
      delays.push(delay);
      const timerId = ++timerSequence;
      timers.set(timerId, callback);
      return timerId as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
    onCredentials: (value) => credentials.push(value),
    onStateChanged: (state) => states.push(state),
    onError: (error) => errors.push(error),
    ...options,
  });

  return {
    client,
    sockets,
    states,
    errors,
    credentials,
    delays,
    runNextTimer(): void {
      const entry = timers.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!entry) {
        throw new Error("Expected a pending reconnect timer");
      }
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

function acceptLink(socket: FakeSocket): void {
  socket.message({
    protocolVersion: PROTOCOL_VERSION,
    type: "linkAccepted",
    messageId: "accepted-1",
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    authToken: AUTH_TOKEN,
    expiresAt: "2026-08-01T00:00:00.000Z",
    metadata: {},
  });
}

function authenticate(
  socket: FakeSocket,
  sessionId = SESSION_ID,
  bridgeInstanceId = INSTANCE_ID,
): void {
  socket.message({
    protocolVersion: PROTOCOL_VERSION,
    type: "authenticated",
    messageId: "authenticated-1",
    sessionId,
    bridgeInstanceId,
    metadata: {},
  });
}

function selection(selector: string) {
  return {
    targets: [
      {
        role: "selected" as const,
        depth: 0 as const,
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

function pageRefreshMessage(
  refreshGeneration: number,
  sessionId: string,
): PageRefreshMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "page.refresh",
    messageId: `refresh-${refreshGeneration}`,
    sessionId,
    source: { role: "ide", id: "vscode-test" },
    refreshGeneration,
    mode: "styles",
    metadata: {},
  };
}

function resolutionMessage(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${resolutionGeneration}`,
    sessionId: SESSION_ID,
    source: { role: "ide", id: "vscode-test" },
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

function peerStateMessage(
  connected: boolean,
  peerGeneration: number,
): PeerStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: `peer-${peerGeneration}`,
    sessionId: SESSION_ID,
    role: "ide",
    connected,
    peerGeneration,
    metadata: {},
  };
}

function sourceNavigationState(
  sessionId: string,
  resolutionGeneration: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${resolutionGeneration}-${activeMatchIndex ?? "none"}`,
    sessionId,
    source: { role: "ide", id: "vscode-test" },
    inspectMessageId: "inspect-card",
    resolutionGeneration,
    selectedMatchCount: activeMatchIndex === undefined ? 0 : 2,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}

function sourceMatchesMessage(
  sessionId: string,
  resolutionGeneration: number,
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `source-matches-${resolutionGeneration}`,
    sessionId,
    source: { role: "ide", id: "vscode-test" },
    inspectMessageId: "inspect-card",
    resolutionGeneration,
    document: { label: "card.scss", languageId: "scss" },
    matches: [{
      matchId: "match-card",
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
