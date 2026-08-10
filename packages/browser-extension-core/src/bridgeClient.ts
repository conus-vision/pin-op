import {
  Browser2IdeMessageSchema,
  ClientSourceSchema,
  PROTOCOL_VERSION,
  SourceNavigateMessageSchema,
  type ClientSource,
  type InspectMessage,
  type PeerStateMessage,
  type ProtocolErrorCode,
  type ResolutionMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";

export class BrowserProtocolError extends Error {
  public readonly name = "BrowserProtocolError";

  public constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowserCredentials {
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

export type BrowserConnectionState =
  | "disconnected"
  | "connecting"
  | "linking"
  | "reconnecting"
  | "connected"
  | "error";

export interface BrowserSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(payload: string): void;
  close(): void;
}

export interface BrowserBridgeClientOptions {
  readonly url: string;
  readonly sourceId: string;
  readonly source?: ClientSource;
  readonly autoReconnect?: boolean;
  readonly socketFactory?: (url: string) => BrowserSocket;
  readonly messageId?: () => string;
  readonly now?: () => Date;
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onCredentials?: (credentials: BrowserCredentials) => void;
  readonly onStateChanged?: (state: BrowserConnectionState) => void;
  readonly onError?: (error: Error) => void;
}

export type InspectPayload = Pick<
  InspectMessage,
  "targets" | "context" | "metadata"
>;

export type InspectSendOutcome =
  | "sent"
  | "not-connected"
  | "invalid-message"
  | "transport-error";

export type SourceNavigationSendOutcome = InspectSendOutcome;

export interface BrowserBridgeSubscription {
  dispose(): void;
}

type ConnectionIntent =
  | { readonly kind: "link"; readonly pin: string }
  | { readonly kind: "credentials"; readonly credentials: BrowserCredentials };

const MAX_RECONNECT_ATTEMPTS = 5;
const browserRoutingMetadataKeys = new Set([
  "windowid",
  "tabid",
  "browserwindowid",
  "browsertabid",
  "inspectedwindowid",
  "inspectedtabid",
  "panelwindowid",
  "paneltabid",
]);

export class BrowserBridgeClient {
  private readonly socketFactory: (url: string) => BrowserSocket;
  private readonly messageId: () => string;
  private readonly now: () => Date;
  private readonly connectionSource: ClientSource;
  private readonly scheduleTimer: NonNullable<BrowserBridgeClientOptions["setTimeout"]>;
  private readonly cancelTimer: NonNullable<BrowserBridgeClientOptions["clearTimeout"]>;
  private socket: BrowserSocket | undefined;
  private connectionIntent: ConnectionIntent | undefined;
  private credentials: BrowserCredentials | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnectEnabled = false;
  private credentialsReconnectAllowed = false;
  private authenticated = false;
  private pendingCredentialNotification = false;
  private state: BrowserConnectionState = "disconnected";
  private readonly resolutionListeners = new Set<
    (message: ResolutionMessage) => void
  >();
  private readonly peerStateListeners = new Set<
    (message: PeerStateMessage) => void
  >();
  private readonly sourceNavigationStateListeners = new Set<
    (message: SourceNavigationStateMessage) => void
  >();

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as BrowserSocket);
    this.messageId = options.messageId ?? defaultMessageId;
    this.now = options.now ?? (() => new Date());
    const connectionSource = ClientSourceSchema.parse(
      options.source ?? {
        role: "browser",
        id: options.sourceId,
        metadata: {},
      },
    );
    this.connectionSource = {
      ...connectionSource,
      metadata: withoutBrowserRoutingMetadata(connectionSource.metadata),
    };
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
  }

  public link(pin: string): void {
    this.start({ kind: "link", pin });
  }

  public connect(credentials: BrowserCredentials): void {
    this.start({ kind: "credentials", credentials });
  }

  public disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      socket.close();
    }
    this.connectionIntent = undefined;
    this.credentials = undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;
    this.reconnectAttempts = 0;
    this.credentialsReconnectAllowed = false;
    this.setState("disconnected");
  }

  public unlink(): void {
    if (this.socket && this.credentials && this.authenticated) {
      this.send({
        protocolVersion: PROTOCOL_VERSION,
        type: "unlink",
        messageId: this.messageId(),
        sessionId: this.credentials.sessionId,
        metadata: {},
      });
    }
    this.disconnect();
  }

  public sendInspect(
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    return this.sendInspectMessage(inspectMessageId, payload, sourceId);
  }

  public sendSourceNavigation(
    input: Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >,
  ): SourceNavigationSendOutcome {
    if (
      !this.socket ||
      !this.credentials ||
      !this.authenticated ||
      this.state !== "connected"
    ) {
      return "not-connected";
    }
    let message: SourceNavigateMessage | undefined;
    try {
      const parsed = SourceNavigateMessageSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        type: "source.navigate",
        messageId: this.messageId(),
        sessionId: this.credentials.sessionId,
        inspectMessageId: input.inspectMessageId,
        resolutionGeneration: input.resolutionGeneration,
        direction: input.direction,
        metadata: {},
      });
      message = parsed.success ? parsed.data : undefined;
    } catch {
      message = undefined;
    }
    if (!message) {
      this.report(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Source navigation message exceeds protocol limits",
        ),
      );
      return "invalid-message";
    }
    try {
      this.socket.send(JSON.stringify(message));
      return "sent";
    } catch {
      this.report(new Error("WebSocket source navigation send failed"));
      return "transport-error";
    }
  }

  public onResolution(
    listener: (message: ResolutionMessage) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.resolutionListeners, listener);
  }

  public onPeerState(
    listener: (message: PeerStateMessage) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.peerStateListeners, listener);
  }

  public onSourceNavigationState(
    listener: (message: SourceNavigationStateMessage) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.sourceNavigationStateListeners, listener);
  }

  private sendInspectMessage(
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    if (
      !this.socket ||
      !this.credentials ||
      !this.authenticated ||
      this.state !== "connected"
    ) {
      return "not-connected";
    }
    const safePayload = withoutInternalRoutingMetadata(payload);
    const message = Browser2IdeMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      type: "inspect",
      messageId: inspectMessageId,
      sessionId: this.credentials.sessionId,
      source: {
        ...this.connectionSource,
        id: sourceId,
      },
      targets: safePayload.targets,
      context: safePayload.context,
      metadata: safePayload.metadata,
    });
    if (!message.success) {
      this.report(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Inspect message exceeds protocol limits",
        ),
      );
      return "invalid-message";
    }
    try {
      this.socket.send(JSON.stringify(message.data));
      return "sent";
    } catch {
      this.report(new Error("WebSocket inspect send failed"));
      return "transport-error";
    }
  }

  private start(intent: ConnectionIntent): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const previousSocket = this.socket;
    this.socket = undefined;
    if (previousSocket) {
      this.detach(previousSocket);
      previousSocket.close();
    }
    this.connectionIntent = intent;
    this.credentials = intent.kind === "credentials" ? intent.credentials : undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;
    this.reconnectAttempts = 0;
    this.credentialsReconnectAllowed = intent.kind === "credentials";
    this.reconnectEnabled = true;
    this.openSocket(false);
  }

  private openSocket(reconnecting: boolean): void {
    const intent = this.connectionIntent;
    if (!intent || !this.reconnectEnabled) {
      return;
    }
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      socket.onopen = null;
      if (intent.kind === "link") {
        this.setState("linking");
        this.send({
          protocolVersion: PROTOCOL_VERSION,
          type: "linkRequest",
          messageId: this.messageId(),
          pin: intent.pin,
          source: this.connectionSource,
          metadata: {},
        });
        return;
      }
      this.credentials = intent.credentials;
      this.sendHello();
    };
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onerror = () => {
      if (this.socket === socket) {
        this.fail(new Error("WebSocket connection failed"));
      }
    };
    socket.onclose = () => this.handleClose(socket);
  }

  private handleMessage(socket: BrowserSocket, data: unknown): void {
    if (this.socket !== socket) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.fail(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Bridge sent invalid JSON",
        ),
      );
      return;
    }
    const parsed = Browser2IdeMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Bridge sent an invalid protocol message",
        ),
      );
      return;
    }
    const message = parsed.data;
    if (message.type === "linkAccepted") {
      if (this.connectionIntent?.kind !== "link") {
        this.stopForProtocolError(
          new BrowserProtocolError(
            "protocol.invalidMessage",
            "Bridge sent an unexpected link response",
          ),
        );
        return;
      }
      const credentials: BrowserCredentials = {
        sessionId: message.sessionId,
        bridgeInstanceId: message.bridgeInstanceId,
        authToken: message.authToken,
      };
      this.credentials = credentials;
      this.connectionIntent = { kind: "credentials", credentials };
      this.credentialsReconnectAllowed = false;
      this.pendingCredentialNotification = true;
      this.sendHello();
      return;
    }
    if (message.type === "authenticated") {
      if (
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId ||
        message.bridgeInstanceId !== this.credentials.bridgeInstanceId
      ) {
        this.stopForProtocolError(
          new BrowserProtocolError(
            "protocol.invalidMessage",
            "Bridge authenticated an unexpected identity",
          ),
        );
        return;
      }
      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.credentialsReconnectAllowed = true;
      if (this.pendingCredentialNotification) {
        this.pendingCredentialNotification = false;
        this.options.onCredentials?.(this.credentials);
      }
      this.setState("connected");
      return;
    }
    if (message.type === "source.navigationState") {
      if (
        !this.authenticated ||
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId
      ) {
        return;
      }
      this.notifyListeners(this.sourceNavigationStateListeners, message);
      return;
    }
    if (message.type === "resolution" || message.type === "peerState") {
      if (
        !this.authenticated ||
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId
      ) {
        this.stopForProtocolError(
          new BrowserProtocolError(
            "protocol.invalidMessage",
            "Bridge sent a result for an unexpected session",
          ),
        );
        return;
      }
      if (message.type === "resolution") {
        this.notifyListeners(this.resolutionListeners, message);
      } else {
        this.notifyListeners(this.peerStateListeners, message);
      }
      return;
    }
    if (message.type === "ping" && this.authenticated) {
      this.send({
        protocolVersion: PROTOCOL_VERSION,
        type: "pong",
        messageId: this.messageId(),
        pingMessageId: message.messageId,
        sentAt: this.now().toISOString(),
        metadata: {},
      });
      return;
    }
    if (message.type === "error") {
      if (
        message.code === "auth.instanceChanged" ||
        message.code === "auth.tokenRejected"
      ) {
        this.stopForProtocolError(sanitizedAuthError(message.code));
        return;
      }
      if (this.connectionIntent?.kind === "link") {
        this.stopForProtocolError(sanitizedLinkError(message.code));
        return;
      }
      if (isNonfatalServerError(message.code)) {
        this.report(new BrowserProtocolError(message.code, message.message));
        return;
      }
      this.fail(new BrowserProtocolError(message.code, message.message));
    }
  }

  private sendHello(): void {
    if (!this.credentials) {
      return;
    }
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      messageId: this.messageId(),
      sessionId: this.credentials.sessionId,
      authToken: this.credentials.authToken,
      bridgeInstanceId: this.credentials.bridgeInstanceId,
      source: this.connectionSource,
      capabilities: ["inspect", "link", "source-navigation"],
      metadata: {},
    });
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(Browser2IdeMessageSchema.parse(message)));
  }

  private fail(error: Error): void {
    this.setState("error");
    this.report(error);
  }

  private report(error: Error): void {
    this.options.onError?.(error);
  }

  private notifyListeners<T>(listeners: Set<(message: T) => void>, message: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        this.report(new Error("Browser bridge listener failed"));
      }
    }
  }

  private stopForProtocolError(error: BrowserProtocolError): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectionIntent = undefined;
    this.credentials = undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;
    this.credentialsReconnectAllowed = false;

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      socket.close();
    }
    this.fail(error);
  }

  private handleClose(socket: BrowserSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.authenticated = false;
    this.detach(socket);
    const intent = this.connectionIntent;
    if (!this.reconnectEnabled || !intent) {
      this.setState("disconnected");
      return;
    }
    if (intent.kind === "link" || !this.credentialsReconnectAllowed) {
      this.stopForProtocolError(
        new BrowserProtocolError(
          "link.unreachable",
          "Link endpoint is unreachable",
        ),
      );
      return;
    }
    if (this.options.autoReconnect === false) {
      this.setState("disconnected");
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.stopForProtocolError(
        new BrowserProtocolError(
          "bridge.offline",
          "Bridge is offline after reconnect attempts were exhausted",
        ),
      );
      return;
    }

    this.setState("reconnecting");
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 5_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.scheduleTimer(() => {
      this.reconnectTimer = undefined;
      this.openSocket(true);
    }, delay);
  }

  private setState(state: BrowserConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChanged?.(state);
  }

  private detach(socket: BrowserSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }
}

function subscribe<T>(
  listeners: Set<(message: T) => void>,
  listener: (message: T) => void,
): BrowserBridgeSubscription {
  if (typeof listener !== "function") {
    throw new TypeError("Browser bridge listener must be a function");
  }
  listeners.add(listener);
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.delete(listener);
    },
  };
}

export function withoutInternalRoutingMetadata(
  payload: InspectPayload,
): InspectPayload {
  const metadata = { ...payload.metadata };
  delete metadata.browserWindowId;
  delete metadata.tabId;
  return {
    targets: payload.targets,
    context: payload.context,
    metadata,
  };
}

function withoutBrowserRoutingMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeBrowserMetadataValue(metadata) as Record<string, unknown>;
}

function sanitizeBrowserMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeBrowserMetadataValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!browserRoutingMetadataKeys.has(normalizedKey)) {
      sanitized[key] = sanitizeBrowserMetadataValue(nestedValue);
    }
  }
  return sanitized;
}

export interface InspectPublisherOptions {
  readonly send: (payload: InspectPayload) => void;
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class InspectPublisher {
  private readonly schedule: NonNullable<InspectPublisherOptions["setTimeout"]>;
  private readonly cancel: NonNullable<InspectPublisherOptions["clearTimeout"]>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentHash: string | undefined;
  private pending:
    | { readonly hash: string; readonly payload: InspectPayload }
    | undefined;

  public constructor(private readonly options: InspectPublisherOptions) {
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
  }

  public publish(payload: InspectPayload): void {
    const hash = JSON.stringify(payload);
    if (hash === this.lastSentHash) {
      this.pending = undefined;
      return;
    }
    if (hash === this.pending?.hash) {
      return;
    }
    if (this.timer === undefined) {
      this.sendNow(payload, hash);
      return;
    }
    this.pending = { hash, payload };
  }

  public dispose(): void {
    this.reset();
  }

  public reset(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
    this.lastSentHash = undefined;
  }

  private sendNow(payload: InspectPayload, hash: string): void {
    this.options.send(payload);
    this.lastSentHash = hash;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        this.sendNow(pending.payload, pending.hash);
      }
    }, 100);
  }
}

function defaultMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sanitizedAuthError(
  code: "auth.instanceChanged" | "auth.tokenRejected",
): BrowserProtocolError {
  const message =
    code === "auth.instanceChanged"
      ? "Bridge instance changed; link again"
      : "Bridge authentication was rejected; link again";
  return new BrowserProtocolError(code, message);
}

function sanitizedLinkError(code: ProtocolErrorCode): BrowserProtocolError {
  const message =
    code === "link.rateLimited"
      ? "Link request rate limited"
      : "Link request rejected";
  return new BrowserProtocolError(code, message);
}

function isNonfatalServerError(code: ProtocolErrorCode): boolean {
  return code === "bridge.noIdeClient";
}
