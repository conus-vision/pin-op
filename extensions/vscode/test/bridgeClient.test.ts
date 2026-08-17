import {
  PageRefreshMessageSchema,
  PROTOCOL_VERSION,
  SourceMatchesMessageSchema,
  SourceNavigationStateMessageSchema,
  type PresentationSettingsMessage,
  type SourceNavigateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BridgeClient,
  PageRefreshClientRouter,
  ResolutionClientRouter,
  SourceMatchesClientRouter,
  SourceNavigationClientRouter,
  type SourceMatchesInput,
} from "../src/bridgeClient.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OTHER_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";

class FakeSocket {
  onopen: (() => void) | null | undefined;
  onmessage: ((event: { data: string }) => void) | null | undefined;
  onclose: (() => void) | null | undefined;
  onerror: (() => void) | null | undefined;
  readonly sent: string[] = [];
  closed = false;
  readyState = 0;
  sendError: Error | undefined;

  send(payload: string): void {
    if (this.sendError) throw this.sendError;
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverClose(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  beginClose(): void {
    this.readyState = 2;
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("BridgeClient", () => {
  it("routes presenter outcomes only to the current bridge client", () => {
    const router = new ResolutionClientRouter();
    const first = { sendResolution: vi.fn() };
    const second = { sendResolution: vi.fn() };
    const input = resolutionInput();

    router.sendResolution(input);
    router.bind(first);
    router.sendResolution(input);
    router.bind(second);
    router.unbind(first);
    router.sendResolution(input);
    router.unbind(second);
    router.sendResolution(input);

    expect(first.sendResolution).toHaveBeenCalledTimes(1);
    expect(second.sendResolution).toHaveBeenCalledTimes(1);
  });

  it("routes page refresh only to the current bridge client", () => {
    const router = new PageRefreshClientRouter();
    const first = { sendPageRefresh: vi.fn() };
    const second = { sendPageRefresh: vi.fn() };
    const input = { mode: "styles" as const };

    router.sendPageRefresh(input);
    router.bind(first);
    router.sendPageRefresh(input);
    router.bind(second);
    router.unbind(first);
    router.sendPageRefresh(input);
    router.unbind(second);
    router.sendPageRefresh(input);

    expect(first.sendPageRefresh).toHaveBeenCalledTimes(1);
    expect(second.sendPageRefresh).toHaveBeenCalledTimes(1);
    expect(first.sendPageRefresh).toHaveBeenCalledWith(input);
    expect(second.sendPageRefresh).toHaveBeenCalledWith(input);
  });

  it("routes source navigation state only to the current bridge client", () => {
    const router = new SourceNavigationClientRouter();
    const first = { sendSourceNavigationState: vi.fn() };
    const second = { sendSourceNavigationState: vi.fn() };
    const input = sourceNavigationStateInput();

    router.sendSourceNavigationState(input);
    router.bind(first);
    router.sendSourceNavigationState(input);
    router.bind(second);
    router.unbind(first);
    router.sendSourceNavigationState(input);
    router.unbind(second);
    router.sendSourceNavigationState(input);

    expect(first.sendSourceNavigationState).toHaveBeenCalledTimes(1);
    expect(second.sendSourceNavigationState).toHaveBeenCalledTimes(1);
  });

  it("routes source matches and envelope measurement only to the current client", () => {
    const router = new SourceMatchesClientRouter();
    const first = {
      sendSourceMatches: vi.fn(),
      sourceMatchesEnvelopeBytes: vi.fn(() => 101),
    };
    const second = {
      sendSourceMatches: vi.fn(),
      sourceMatchesEnvelopeBytes: vi.fn(() => 202),
    };
    const input = sourceMatchesInput();

    expect(router.sourceMatchesEnvelopeBytes(input)).toBe(Number.POSITIVE_INFINITY);
    router.sendSourceMatches(input);
    router.bind(first);
    expect(router.sourceMatchesEnvelopeBytes(input)).toBe(101);
    router.sendSourceMatches(input);
    router.bind(second);
    router.unbind(first);
    expect(router.sourceMatchesEnvelopeBytes(input)).toBe(202);
    router.sendSourceMatches(input);
    router.unbind(second);
    router.sendSourceMatches(input);

    expect(first.sendSourceMatches).toHaveBeenCalledTimes(1);
    expect(second.sendSourceMatches).toHaveBeenCalledTimes(1);
  });

  it("sends a strict protocol-v6 resolution through the authenticated IDE route", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    const hello = JSON.parse(harness.sockets[0].sent[0] ?? "{}");
    authenticate(harness.sockets[0]);

    harness.client.sendResolution(resolutionInput());

    expect(JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}")).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "resolution",
      sessionId: SESSION_ID,
      source: { role: "ide", id: hello.source.id },
      inspectMessageId: "inspect-1",
      resolutionGeneration: 2,
      document: { label: "card.scss", languageId: "scss" },
      status: "matched",
      selectedMatchCount: 2,
      parentMatchCount: 1,
      inaccessibleStylesheetCount: 0,
      diagnosticCodes: [],
      metadata: {},
    });
  });

  it("sends a strict private-data-free page refresh after authentication", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    const hello = JSON.parse(harness.sockets[0].sent[0] ?? "{}");
    authenticate(harness.sockets[0]);

    harness.client.sendPageRefresh({
      mode: "styles",
      refreshGeneration: 99,
      messageId: "caller-message",
      sessionId: "caller-session",
      source: { role: "browser", id: "caller-source" },
      metadata: { caller: true },
      uri: "file:///private/customer/app.scss",
      path: "C:/private/customer/app.scss",
      text: "private source text",
      tabId: 42,
    } as never);

    const wirePayload = harness.sockets[0].sent.at(-1) ?? "{}";
    const message = JSON.parse(wirePayload);
    expect(PageRefreshMessageSchema.parse(message)).toEqual(message);
    expect(message).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "page.refresh",
      messageId: expect.any(String),
      sessionId: SESSION_ID,
      source: { role: "ide", id: hello.source.id },
      refreshGeneration: 1,
      mode: "styles",
      metadata: {},
    });
    expect(wirePayload).not.toContain("private");
    expect(wirePayload).not.toContain("caller-");
    expect(Object.keys(message).sort()).toEqual([
      "messageId",
      "metadata",
      "mode",
      "protocolVersion",
      "refreshGeneration",
      "sessionId",
      "source",
      "type",
    ]);
  });

  it("drops unauthenticated refresh candidates without consuming generation", () => {
    const harness = createHarness();

    harness.client.sendPageRefresh({ mode: "styles" });
    harness.client.connect();
    harness.client.sendPageRefresh({ mode: "reload" });
    harness.sockets[0].open();
    harness.client.sendPageRefresh({ mode: "styles" });
    authenticate(harness.sockets[0]);
    harness.client.sendPageRefresh({ mode: "reload" });

    expect(pageRefreshMessages(harness.sockets[0])).toEqual([
      expect.objectContaining({ mode: "reload", refreshGeneration: 1 }),
    ]);
  });

  it("keeps refresh generation monotonic across reconnects", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.client.sendPageRefresh({ mode: "styles" });

    harness.sockets[0].serverClose();
    harness.client.sendPageRefresh({ mode: "reload" });
    harness.runNextTimer();
    harness.sockets[1].open();
    harness.client.sendPageRefresh({ mode: "styles" });
    authenticate(harness.sockets[1]);
    harness.client.sendPageRefresh({ mode: "reload" });

    expect(pageRefreshMessages(harness.sockets[0])).toEqual([
      expect.objectContaining({ mode: "styles", refreshGeneration: 1 }),
    ]);
    expect(pageRefreshMessages(harness.sockets[1])).toEqual([
      expect.objectContaining({ mode: "reload", refreshGeneration: 2 }),
    ]);
  });

  it("drops a refresh and reconnects when the authenticated socket is no longer open", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.client.sendPageRefresh({ mode: "styles" });
    harness.sockets[0].beginClose();

    expect(() =>
      harness.client.sendPageRefresh({ mode: "reload" })
    ).not.toThrow();
    expect(harness.states.at(-1)).toBe("reconnecting");
    expect(harness.sockets[0].closed).toBe(true);
    expect(pageRefreshMessages(harness.sockets[0])).toEqual([
      expect.objectContaining({ mode: "styles", refreshGeneration: 1 }),
    ]);

    harness.runNextTimer();
    harness.sockets[1].open();
    authenticate(harness.sockets[1]);
    harness.client.sendPageRefresh({ mode: "reload" });

    expect(pageRefreshMessages(harness.sockets[1])).toEqual([
      expect.objectContaining({ mode: "reload", refreshGeneration: 2 }),
    ]);
  });

  it("drops a throwing authenticated send and reconnects without consuming generation", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].sendError = new Error(
      "socket send failed for file:///private/customer/app.scss",
    );

    expect(() =>
      harness.client.sendPageRefresh({ mode: "styles" })
    ).not.toThrow();
    expect(harness.states.at(-1)).toBe("reconnecting");
    expect(harness.sockets[0].closed).toBe(true);
    expect(pageRefreshMessages(harness.sockets[0])).toEqual([]);
    expect(harness.errors).toEqual([]);

    harness.runNextTimer();
    harness.sockets[1].open();
    authenticate(harness.sockets[1]);
    harness.client.sendPageRefresh({ mode: "reload" });

    expect(pageRefreshMessages(harness.sockets[1])).toEqual([
      expect.objectContaining({ mode: "reload", refreshGeneration: 1 }),
    ]);
  });

  it("rejects malformed authenticated refresh input without consuming generation", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    expect(() =>
      harness.client.sendPageRefresh({ mode: "invalid" } as never)
    ).toThrow();
    harness.client.sendPageRefresh({ mode: "styles" });

    expect(pageRefreshMessages(harness.sockets[0])).toEqual([
      expect.objectContaining({ mode: "styles", refreshGeneration: 1 }),
    ]);
  });

  it("does not send resolutions before authentication", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();

    harness.client.sendResolution(resolutionInput());

    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("sends a strict protocol-v6 source navigation state through the authenticated IDE route", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    const hello = JSON.parse(harness.sockets[0].sent[0] ?? "{}");
    authenticate(harness.sockets[0]);

    harness.client.sendSourceNavigationState({
      ...sourceNavigationStateInput(),
      messageId: "caller-message",
      sessionId: "caller-session",
      source: { role: "browser", id: "caller-source" },
      metadata: { caller: true },
    } as never);

    const message = JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}");
    expect(SourceNavigationStateMessageSchema.parse(message)).toEqual(message);
    expect(message).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: expect.any(String),
      sessionId: SESSION_ID,
      source: { role: "ide", id: hello.source.id },
      inspectMessageId: "inspect-1",
      resolutionGeneration: 4,
      selectedMatchCount: 3,
      activeMatchIndex: 1,
      metadata: {},
    });
    expect(message.messageId).not.toBe("caller-message");
  });

  it("does not send source navigation state before authentication", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();

    harness.client.sendSourceNavigationState(sourceNavigationStateInput());

    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("sends strict private-data-free source matches after authentication", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    const hello = JSON.parse(harness.sockets[0].sent[0] ?? "{}");
    authenticate(harness.sockets[0]);

    harness.client.sendSourceMatches({
      ...sourceMatchesInput(),
      messageId: "caller-message",
      sessionId: "caller-session",
      source: { role: "browser", id: "caller-source" },
      uri: "file:///private/customer/Card.tsx",
      path: "C:/private/customer/Card.tsx",
      fullDocument: "private full document",
      metadata: { caller: true },
    } as never);

    const payload = harness.sockets[0].sent.at(-1) ?? "{}";
    const message = JSON.parse(payload);
    expect(SourceMatchesMessageSchema.parse(message)).toEqual(message);
    expect(message).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: "source.matches",
      messageId: expect.any(String),
      sessionId: SESSION_ID,
      source: { role: "ide", id: hello.source.id },
      ...sourceMatchesInput(),
      metadata: {},
    });
    expect(payload).not.toContain("private/customer");
    expect(payload).not.toContain("private full");
    expect(payload).not.toContain("caller-");
  });

  it("measures the exact source matches envelope and drops it before authentication", () => {
    const harness = createHarness();
    const input = sourceMatchesInput();
    harness.client.connect();
    harness.sockets[0].open();

    const measured = harness.client.sourceMatchesEnvelopeBytes(input);
    harness.client.sendSourceMatches(input);
    expect(harness.sockets[0].sent).toHaveLength(1);

    authenticate(harness.sockets[0]);
    harness.client.sendSourceMatches(input);
    const payload = harness.sockets[0].sent.at(-1)!;
    expect(Buffer.byteLength(payload, "utf8")).toBe(measured);
  });

  it.each([
    ["omits an absent index", sourceNavigationStateInput(false), false, undefined],
    ["preserves index zero", sourceNavigationStateInput(true, 0), true, 0],
  ])("%s in source navigation state", (_name, input, present, expected) => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.client.sendSourceNavigationState(input);

    const message = JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}");
    expect(Object.hasOwn(message, "activeMatchIndex")).toBe(present);
    expect(message.activeMatchIndex).toBe(expected);
  });

  it("preserves an included activeMatchId in source navigation state", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.client.sendSourceNavigationState({
      ...sourceNavigationStateInput(),
      activeMatchId: "opaque-match-1",
    });

    const message = JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}");
    expect(SourceNavigationStateMessageSchema.parse(message)).toEqual(message);
    expect(message.activeMatchId).toBe("opaque-match-1");
  });

  it("rejects malformed source navigation state without sending wire data", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    let thrown: unknown;
    try {
      harness.client.sendSourceNavigationState({
        ...sourceNavigationStateInput(),
        selectedMatchCount: -1,
        localPath: "C:/private/card.scss",
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: "ZodError" });
    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("follows existing socket and send error handling for source navigation state", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].sendError = new Error("socket send failed");

    expect(() =>
      harness.client.sendSourceNavigationState(sourceNavigationStateInput()),
    ).toThrow("socket send failed");
    expect(harness.states.at(-1)).toBe("connected");

    harness.sockets[0].sendError = undefined;
    harness.sockets[0].onerror?.();
    harness.client.sendSourceNavigationState(sourceNavigationStateInput());

    expect(harness.states.at(-1)).toBe("error");
    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("rejects malformed resolution input with the strict protocol schema", () => {
    const harness = createHarness();
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    expect(() => harness.client.sendResolution({
      ...resolutionInput(),
      selectedMatchCount: -1,
      localPath: "C:/private/card.scss",
    } as never)).toThrow();
    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it("sends hello on open and connects only after matching authentication", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].open();

    const hello = JSON.parse(harness.sockets[0].sent[0]);
    expect(hello).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: "ide-token",
      source: { role: "ide" },
    });
    expect(hello.capabilities).toEqual([
      "resolution",
      "source-navigation",
      "auto-refresh",
      "source-presentation",
      "presentation-settings",
    ]);
    expect(harness.states).toEqual(["connecting"]);

    authenticate(harness.sockets[0]);

    expect(harness.states).toEqual(["connecting", "connected"]);
  });

  it("publishes authenticated same-session source navigation", () => {
    const harness = createHarness();
    const navigated: SourceNavigateMessage[] = [];
    harness.client.onSourceNavigate((message) => navigated.push(message));
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    const message = sourceNavigateMessage();

    harness.sockets[0].message(message);

    expect(navigated).toEqual([message]);
    expect(navigated[0]).toMatchObject({
      inspectMessageId: "inspect-1",
      resolutionGeneration: 4,
      direction: "next",
    });
  });

  it("ignores source navigation before authentication", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.client.onSourceNavigate(listener);
    harness.client.connect();
    harness.sockets[0].open();

    harness.sockets[0].message(sourceNavigateMessage());

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores source navigation for a stale session", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.client.onSourceNavigate(listener);
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.sockets[0].message(sourceNavigateMessage("stale-session"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops source navigation notifications after listener disposal", () => {
    const harness = createHarness();
    const listener = vi.fn();
    const dispose = harness.client.onSourceNavigate(listener);
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].message(sourceNavigateMessage());

    dispose();
    harness.sockets[0].message(sourceNavigateMessage());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps one source navigation listener across reconnect and clears it on dispose", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.client.onSourceNavigate(listener);
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].message(sourceNavigateMessage());

    harness.sockets[0].serverClose();
    harness.runNextTimer();
    harness.sockets[1].open();
    authenticate(harness.sockets[1]);
    harness.sockets[1].message(sourceNavigateMessage());
    harness.sockets[0].message(sourceNavigateMessage());

    expect(listener).toHaveBeenCalledTimes(2);

    harness.client.dispose();
    harness.sockets[1].message(sourceNavigateMessage());

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes source open and settings only after matching authentication and session", () => {
    const harness = createHarness();
    const opened: SourceOpenMessage[] = [];
    const settings: PresentationSettingsMessage[] = [];
    harness.client.onSourceOpen((message) => opened.push(message));
    harness.client.onPresentationSettings((message) => settings.push(message));
    harness.client.connect();
    harness.sockets[0].open();

    harness.sockets[0].message(sourceOpenMessage());
    harness.sockets[0].message(presentationSettingsMessage());
    authenticate(harness.sockets[0]);
    harness.sockets[0].message(sourceOpenMessage("stale-session"));
    harness.sockets[0].message(presentationSettingsMessage("stale-session"));
    harness.sockets[0].message(sourceOpenMessage());
    harness.sockets[0].message(presentationSettingsMessage());

    expect(opened).toEqual([sourceOpenMessage()]);
    expect(settings).toEqual([presentationSettingsMessage()]);
  });

  it("rejects non-strict source open and settings payloads", () => {
    const harness = createHarness();
    const opened = vi.fn();
    const settings = vi.fn();
    harness.client.onSourceOpen(opened);
    harness.client.onPresentationSettings(settings);
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);

    harness.sockets[0].message({
      ...sourceOpenMessage(),
      range: { startLine: 1, endLine: 2 },
    });
    harness.sockets[0].message({
      ...presentationSettingsMessage(),
      command: "reveal-file",
    });

    expect(opened).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
  });

  it("removes source presentation listeners on unsubscribe and dispose", () => {
    const harness = createHarness();
    const opened = vi.fn();
    const settings = vi.fn();
    const unsubscribeOpen = harness.client.onSourceOpen(opened);
    harness.client.onPresentationSettings(settings);
    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].message(sourceOpenMessage());
    harness.sockets[0].message(presentationSettingsMessage());

    unsubscribeOpen();
    harness.sockets[0].message(sourceOpenMessage());
    harness.client.dispose();
    harness.sockets[0].message(presentationSettingsMessage());

    expect(opened).toHaveBeenCalledTimes(1);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("ignores inspect and heartbeat traffic before authentication", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].open();
    harness.sockets[0].message(inspectMessage());
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-before-auth",
      sentAt: "2026-07-11T12:00:00.000Z",
      metadata: {},
    });

    expect(harness.inspected).toEqual([]);
    expect(harness.sockets[0].sent).toHaveLength(1);
  });

  it.each([
    ["session", "another-session", INSTANCE_ID],
    ["bridge instance", SESSION_ID, OTHER_INSTANCE_ID],
  ])(
    "rejects authentication for the wrong %s and stops the client",
    (_identity, sessionId, bridgeInstanceId) => {
      const harness = createHarness();

      harness.client.connect();
      harness.sockets[0].open();
      authenticate(harness.sockets[0], sessionId, bridgeInstanceId);

      expect(harness.states).not.toContain("connected");
      expect(harness.errors.at(-1)).toMatchObject({
        code: "protocol.invalidMessage",
      });
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);

      harness.client.connect();
      expect(harness.sockets).toHaveLength(1);
    },
  );

  it("resets capped reconnect delays only after authentication", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].open();
    harness.sockets[0].serverClose();
    harness.runNextTimer();

    harness.sockets[1].open();
    harness.sockets[1].serverClose();
    harness.runNextTimer();

    harness.sockets[2].open();
    authenticate(harness.sockets[2]);
    harness.sockets[2].serverClose();
    harness.runNextTimer();

    for (let index = 3; index < 6; index += 1) {
      harness.sockets[index].open();
      harness.sockets[index].serverClose();
      harness.runNextTimer();
    }

    expect(harness.delays).toEqual([1_000, 2_000, 1_000, 2_000, 4_000, 5_000]);
    expect(harness.states).toContain("reconnecting");
  });

  it.each(["auth.instanceChanged", "auth.tokenRejected"] as const)(
    "surfaces %s and stops automatic reconnect",
    (code) => {
      const harness = createHarness();

      harness.client.connect();
      harness.sockets[0].open();
      harness.sockets[0].message({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "auth-error-1",
        code,
        message: "Authentication failed",
        metadata: {},
      });

      expect(harness.errors).toEqual([expect.objectContaining({ code })]);
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);

      harness.client.connect();
      expect(harness.sockets).toHaveLength(1);
    },
  );

  it("publishes inspect, answers ping, and surfaces nonfatal bridge errors", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].message(inspectMessage());
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-1",
      sentAt: "2026-07-11T12:00:00.000Z",
      metadata: {},
    });
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      messageId: "bridge-error-1",
      code: "bridge.noBrowserClient",
      message: "No browser client is connected",
      metadata: {},
    });

    expect(harness.inspected).toHaveLength(1);
    expect(JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}")).toMatchObject({
      type: "pong",
      pingMessageId: "ping-1",
    });
    expect(harness.errors.at(-1)).toMatchObject({
      code: "bridge.noBrowserClient",
    });

    harness.sockets[0].onmessage?.({ data: "{" });
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
  });

  it("cancels a pending reconnect when explicitly disconnected", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].serverClose();
    harness.client.disconnect();

    expect(harness.clearedTimers).toHaveLength(1);
    expect(harness.states.at(-1)).toBe("disconnected");
  });

  it("disposes socket callbacks, retry timers, and listeners", () => {
    const harness = createHarness();

    harness.client.connect();
    harness.sockets[0].serverClose();
    harness.client.dispose();

    expect(harness.clearedTimers).toHaveLength(1);
    expect(harness.sockets[0].onopen).toBeNull();
    expect(harness.sockets[0].onmessage).toBeNull();
    expect(harness.sockets[0].onclose).toBeNull();
    expect(harness.sockets[0].onerror).toBeNull();
  });
});

function createHarness() {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  const states: string[] = [];
  const errors: unknown[] = [];
  const inspected: unknown[] = [];
  let nextTimerId = 0;
  const client = new BridgeClient({
    url: "ws://127.0.0.1:48735",
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    authToken: "ide-token",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback, delay) => {
      delays.push(delay);
      const timerId = ++nextTimerId;
      timers.set(timerId, callback);
      return timerId as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      const timerId = timer as unknown as number;
      clearedTimers.push(timerId);
      timers.delete(timerId);
    },
  });
  client.onConnectionStateChanged((state) => states.push(state));
  client.onProtocolError((error) => errors.push(error));
  client.onInspect((message) => inspected.push(message));

  return {
    client,
    sockets,
    delays,
    clearedTimers,
    states,
    errors,
    inspected,
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

function pageRefreshMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((message) => message.type === "page.refresh");
}

function inspectMessage() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: SESSION_ID,
    source: { role: "browser", id: "browser-1", metadata: {} },
    ideHighlightEnabled: true,
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: "#save", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function resolutionInput() {
  return {
    inspectMessageId: "inspect-1",
    resolutionGeneration: 2,
    document: { label: "card.scss", languageId: "scss" },
    status: "matched" as const,
    selectedMatchCount: 2,
    parentMatchCount: 1,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
  };
}

function sourceNavigateMessage(
  sessionId = SESSION_ID,
): SourceNavigateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigate",
    messageId: "source-navigate-1",
    sessionId,
    inspectMessageId: "inspect-1",
    resolutionGeneration: 4,
    direction: "next",
    metadata: {},
  };
}

function sourceOpenMessage(sessionId = SESSION_ID): SourceOpenMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.open",
    messageId: "source-open-1",
    sessionId,
    inspectMessageId: "inspect-1",
    resolutionGeneration: 4,
    matchId: "opaque-match-1",
    metadata: {},
  };
}

function presentationSettingsMessage(
  sessionId = SESSION_ID,
): PresentationSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "presentation.settings",
    messageId: "settings-1",
    sessionId,
    inspectMessageId: "inspect-1",
    ideHighlightEnabled: false,
    metadata: {},
  };
}

function sourceMatchesInput(): SourceMatchesInput {
  return {
    inspectMessageId: "inspect-1",
    resolutionGeneration: 4,
    document: { label: "Card.tsx", languageId: "typescriptreact" },
    matches: [{
      matchId: "opaque-match-1",
      targetRole: "selected",
      label: "Card",
      kind: "component",
      relation: "renders",
      confidence: "exact",
      startLine: 2,
      endLine: 4,
      text: "export function Card() {}",
      truncated: false,
    }],
    omittedMatchCount: 0,
  };
}

function sourceNavigationStateInput(
  includeActiveMatchIndex = true,
  activeMatchIndex = 1,
) {
  return {
    inspectMessageId: "inspect-1",
    resolutionGeneration: 4,
    selectedMatchCount: 3,
    ...(includeActiveMatchIndex ? { activeMatchIndex } : {}),
  };
}
