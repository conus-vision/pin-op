import {
  PROTOCOL_VERSION,
  SourceNavigationStateMessageSchema,
  type SourceNavigateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BridgeClient,
  ResolutionClientRouter,
  SourceNavigationClientRouter,
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
  sendError: Error | undefined;

  send(payload: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.closed = true;
    this.onclose?.();
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

  it("sends a strict protocol-v5 resolution through the authenticated IDE route", () => {
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
    expect(hello.capabilities).toEqual(["resolution", "source-navigation"]);
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
