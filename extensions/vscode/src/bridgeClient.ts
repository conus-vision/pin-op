import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
  type ErrorMessage,
  type InspectMessage,
  type ResolutionMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";

export type ResolutionInput = Pick<
  ResolutionMessage,
  | "inspectMessageId"
  | "resolutionGeneration"
  | "document"
  | "status"
  | "selectedMatchCount"
  | "parentMatchCount"
  | "inaccessibleStylesheetCount"
  | "diagnosticCodes"
>;

export interface ResolutionSender {
  sendResolution(resolution: ResolutionInput): void;
}

export class ResolutionClientRouter implements ResolutionSender {
  private client: ResolutionSender | undefined;

  public bind(client: ResolutionSender): void {
    this.client = client;
  }

  public unbind(client: ResolutionSender): void {
    if (this.client === client) this.client = undefined;
  }

  public sendResolution(resolution: ResolutionInput): void {
    this.client?.sendResolution(resolution);
  }
}

export type SourceNavigationStateInput = Pick<
  SourceNavigationStateMessage,
  | "inspectMessageId"
  | "resolutionGeneration"
  | "selectedMatchCount"
  | "activeMatchIndex"
>;

export interface SourceNavigationStateSender {
  sendSourceNavigationState(state: SourceNavigationStateInput): void;
}

export class SourceNavigationClientRouter
  implements SourceNavigationStateSender
{
  private client: SourceNavigationStateSender | undefined;

  public bind(client: SourceNavigationStateSender): void {
    this.client = client;
  }

  public unbind(client: SourceNavigationStateSender): void {
    if (this.client === client) this.client = undefined;
  }

  public sendSourceNavigationState(state: SourceNavigationStateInput): void {
    this.client?.sendSourceNavigationState(state);
  }
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export interface SocketLike {
  onopen?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  send(payload: string): void;
  close(): void;
}

export interface BridgeClientOptions {
  readonly url: string;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
  readonly socketFactory?: (url: string) => SocketLike;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class BridgeClient {
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly scheduleTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly inspectListeners = new Set<(message: InspectMessage) => void>();
  private readonly sourceNavigateListeners = new Set<
    (message: SourceNavigateMessage) => void
  >();
  private readonly protocolErrorListeners = new Set<
    (message: ErrorMessage) => void
  >();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly sourceId = `vscode-${randomUUID()}`;
  private socket: SocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnectEnabled = false;
  private terminalFailure = false;
  private state: ConnectionState = "disconnected";

  constructor(private readonly options: BridgeClientOptions) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
  }

  connect(): void {
    if (this.terminalFailure) {
      return;
    }
    this.reconnectEnabled = true;
    if (!this.socket && !this.reconnectTimer) {
      this.openSocket();
    }
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detachSocket(socket);
    }
    socket?.close();
    this.setState("disconnected");
  }

  dispose(): void {
    this.disconnect();
    this.inspectListeners.clear();
    this.sourceNavigateListeners.clear();
    this.protocolErrorListeners.clear();
    this.stateListeners.clear();
  }

  onInspect(listener: (message: InspectMessage) => void): () => void {
    this.inspectListeners.add(listener);
    return () => this.inspectListeners.delete(listener);
  }

  onSourceNavigate(listener: (message: SourceNavigateMessage) => void): () => void {
    this.sourceNavigateListeners.add(listener);
    return () => this.sourceNavigateListeners.delete(listener);
  }

  onConnectionStateChanged(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onProtocolError(listener: (message: ErrorMessage) => void): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  sendResolution(resolution: ResolutionInput): void {
    const message = ResolutionMessageSchema.parse({
      ...resolution,
      protocolVersion: PROTOCOL_VERSION,
      type: "resolution",
      messageId: randomUUID(),
      sessionId: this.options.sessionId,
      source: { role: "ide", id: this.sourceId },
      metadata: {},
    });
    if (!this.socket || this.state !== "connected") return;
    this.socket.send(JSON.stringify(message));
  }

  sendSourceNavigationState(state: SourceNavigationStateInput): void {
    const message = SourceNavigationStateMessageSchema.parse({
      ...state,
      protocolVersion: PROTOCOL_VERSION,
      type: "source.navigationState",
      messageId: randomUUID(),
      sessionId: this.options.sessionId,
      source: { role: "ide", id: this.sourceId },
      metadata: {},
    });
    if (!this.socket || this.state !== "connected") return;
    this.socket.send(JSON.stringify(message));
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      socket.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "hello",
          messageId: randomUUID(),
          sessionId: this.options.sessionId,
          authToken: this.options.authToken,
          bridgeInstanceId: this.options.bridgeInstanceId,
          source: { role: "ide", id: this.sourceId, metadata: {} },
          capabilities: ["resolution", "source-navigation"],
          metadata: {},
        }),
      );
    };
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onerror = () => this.setState("error");
    socket.onclose = () => this.handleClose(socket);
  }

  private handleMessage(socket: SocketLike, data: unknown): void {
    if (this.socket !== socket) {
      return;
    }

    const payload = typeof data === "string" ? data : data instanceof Buffer ? data.toString() : String(data);
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      this.emitProtocolError(localProtocolError("Bridge sent invalid JSON"));
      this.setState("error");
      return;
    }

    const parsed = PinOpMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.emitProtocolError(
        localProtocolError("Bridge sent an invalid protocol message"),
      );
      this.setState("error");
      return;
    }

    if (parsed.data.type === "authenticated") {
      if (
        parsed.data.sessionId !== this.options.sessionId ||
        parsed.data.bridgeInstanceId !== this.options.bridgeInstanceId
      ) {
        this.stopForProtocolError(
          localProtocolError("Bridge authenticated an unexpected identity"),
        );
        return;
      }
      this.reconnectAttempts = 0;
      this.setState("connected");
      return;
    }
    if (parsed.data.type === "inspect" && this.state === "connected") {
      for (const listener of this.inspectListeners) {
        listener(parsed.data);
      }
    }
    if (
      parsed.data.type === "source.navigate" &&
      this.state === "connected" &&
      parsed.data.sessionId === this.options.sessionId
    ) {
      for (const listener of this.sourceNavigateListeners) {
        listener(parsed.data);
      }
    }
    if (parsed.data.type === "error") {
      if (
        parsed.data.code === "auth.instanceChanged" ||
        parsed.data.code === "auth.tokenRejected"
      ) {
        this.stopForProtocolError(parsed.data);
        return;
      }
      this.emitProtocolError(parsed.data);
    }
    if (parsed.data.type === "ping" && this.state === "connected") {
      socket.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: "pong",
          messageId: randomUUID(),
          pingMessageId: parsed.data.messageId,
          sentAt: new Date().toISOString(),
          metadata: {},
        }),
      );
    }
  }

  private handleClose(socket: SocketLike): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = undefined;
    this.detachSocket(socket);
    if (!this.reconnectEnabled) {
      this.setState("disconnected");
      return;
    }

    this.setState("reconnecting");
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 5_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.scheduleTimer(() => {
      this.reconnectTimer = undefined;
      if (this.reconnectEnabled) {
        this.openSocket();
      }
    }, delay);
  }

  private emitProtocolError(message: ErrorMessage): void {
    for (const listener of this.protocolErrorListeners) {
      listener(message);
    }
  }

  private stopForProtocolError(message: ErrorMessage): void {
    this.emitProtocolError(message);
    this.terminalFailure = true;
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detachSocket(socket);
      socket.close();
    }
    this.setState("error");
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private detachSocket(socket: SocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }
}

function localProtocolError(message: string): ErrorMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    messageId: randomUUID(),
    code: "protocol.invalidMessage",
    message,
    metadata: {},
  };
}
