import {
  PinOpMessageSchema,
  ClientSourceSchema,
  PresentationSettingsMessageSchema,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  SourceOpenMessageSchema,
  SourceNavigateMessageSchema,
  parseProtocolMismatchReason,
  type ClientSource,
  type InspectMessage,
  type PageRefreshMessage,
  type PeerStateMessage,
  type PresentationSettingsMessage,
  type ProtocolErrorCode,
  type ResolutionMessage,
  type SourceMatchesMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import {
  parsePanelPresentationSettingsCommand,
  parsePanelSourceOpenCommand,
  type PanelPresentationSettingsCommand,
  type PanelSourceOpenCommand,
} from "./inspectPortProtocol.js";
import { snapshotExactDataRecord } from "./protocolDataSnapshot.js";
import {
  createTransportTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "./trustedIdePeerContext.js";

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
  | "incompatible"
  | "error";

export interface BrowserProtocolMismatch {
  readonly browserProtocolVersion: typeof PROTOCOL_VERSION;
  readonly peerProtocolVersion?: number;
}

export interface BrowserSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface BrowserSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: BrowserSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(payload: string): void;
  close(): void;
}

export interface BrowserBridgeClientOptions {
  readonly url: string;
  readonly windowId: number;
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
  "targets" | "context" | "ideHighlightEnabled" | "metadata"
>;

export type InspectSendOutcome =
  | "sent"
  | "not-connected"
  | "invalid-message"
  | "transport-error";

export type SourceNavigationSendOutcome = InspectSendOutcome;
export type SourcePresentationSendOutcome = InspectSendOutcome;
export type SourceOpenInput = Omit<PanelSourceOpenCommand, "type">;
export type PresentationSettingsInput = Omit<
  PanelPresentationSettingsCommand,
  "type"
>;

export interface BrowserBridgeSubscription {
  dispose(): void;
}

export type TrustedIdeMessageListener<T> = (
  context: TrustedIdePeerContext,
  message: T,
) => void;

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
  private readonly windowId: number;
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
    TrustedIdeMessageListener<ResolutionMessage>
  >();
  private readonly peerStateListeners = new Set<
    (message: PeerStateMessage) => void
  >();
  private readonly sourceNavigationStateListeners = new Set<
    TrustedIdeMessageListener<SourceNavigationStateMessage>
  >();
  private readonly sourceMatchesListeners = new Set<
    TrustedIdeMessageListener<SourceMatchesMessage>
  >();
  private readonly pageRefreshListeners = new Set<
    (message: PageRefreshMessage) => void
  >();
  private readonly protocolMismatchListeners = new Set<
    (details: BrowserProtocolMismatch) => void
  >();

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as BrowserSocket);
    this.messageId = options.messageId ?? defaultMessageId;
    this.now = options.now ?? (() => new Date());
    if (!isBrowserId(options.windowId)) {
      throw new TypeError("Browser bridge window ID is invalid");
    }
    this.windowId = options.windowId;
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

  public sendSourceOpen(
    input: SourceOpenInput,
  ): SourcePresentationSendOutcome {
    if (!this.isConnectedTransport()) {
      return "not-connected";
    }
    const safeInput = snapshotSourceOpenInput(input);
    if (!safeInput) {
      return this.rejectSourcePresentation("Source open message");
    }

    let message: SourceOpenMessage | undefined;
    try {
      const parsed = SourceOpenMessageSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        type: "source.open",
        messageId: this.messageId(),
        sessionId: this.credentials?.sessionId,
        inspectMessageId: safeInput.inspectMessageId,
        resolutionGeneration: safeInput.resolutionGeneration,
        matchId: safeInput.matchId,
        metadata: {},
      });
      message = parsed.success ? parsed.data : undefined;
    } catch {
      message = undefined;
    }
    return message
      ? this.sendSourcePresentation(message, "source open")
      : this.rejectSourcePresentation("Source open message");
  }

  public sendPresentationSettings(
    input: PresentationSettingsInput,
  ): SourcePresentationSendOutcome {
    if (!this.isConnectedTransport()) {
      return "not-connected";
    }
    const safeInput = snapshotPresentationSettingsInput(input);
    if (!safeInput) {
      return this.rejectSourcePresentation("Presentation settings message");
    }

    let message: PresentationSettingsMessage | undefined;
    try {
      const parsed = PresentationSettingsMessageSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        type: "presentation.settings",
        messageId: this.messageId(),
        sessionId: this.credentials?.sessionId,
        inspectMessageId: safeInput.inspectMessageId,
        ideHighlightEnabled: safeInput.ideHighlightEnabled,
        metadata: {},
      });
      message = parsed.success ? parsed.data : undefined;
    } catch {
      message = undefined;
    }
    return message
      ? this.sendSourcePresentation(message, "presentation settings")
      : this.rejectSourcePresentation("Presentation settings message");
  }

  public onResolution(
    listener: TrustedIdeMessageListener<ResolutionMessage>,
  ): BrowserBridgeSubscription {
    return subscribeTrusted(this.resolutionListeners, listener);
  }

  public onPeerState(
    listener: (message: PeerStateMessage) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.peerStateListeners, listener);
  }

  public onSourceNavigationState(
    listener: TrustedIdeMessageListener<SourceNavigationStateMessage>,
  ): BrowserBridgeSubscription {
    return subscribeTrusted(this.sourceNavigationStateListeners, listener);
  }

  public onSourceMatches(
    listener: TrustedIdeMessageListener<SourceMatchesMessage>,
  ): BrowserBridgeSubscription {
    return subscribeTrusted(this.sourceMatchesListeners, listener);
  }

  public onPageRefresh(
    listener: (message: PageRefreshMessage) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.pageRefreshListeners, listener);
  }

  public onProtocolMismatch(
    listener: (details: BrowserProtocolMismatch) => void,
  ): BrowserBridgeSubscription {
    return subscribe(this.protocolMismatchListeners, listener);
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
    const message = PinOpMessageSchema.safeParse({
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
      ideHighlightEnabled: safePayload.ideHighlightEnabled,
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

  private isConnectedTransport(): boolean {
    return Boolean(
      this.socket &&
        this.credentials &&
        this.authenticated &&
        this.state === "connected",
    );
  }

  private rejectSourcePresentation(
    label: string,
  ): SourcePresentationSendOutcome {
    this.report(
      new BrowserProtocolError(
        "protocol.invalidMessage",
        `${label} exceeds protocol limits`,
      ),
    );
    return "invalid-message";
  }

  private sendSourcePresentation(
    message: SourceOpenMessage | PresentationSettingsMessage,
    label: string,
  ): SourcePresentationSendOutcome {
    const socket = this.socket;
    if (!socket || !this.isConnectedTransport()) {
      return "not-connected";
    }
    try {
      socket.send(JSON.stringify(message));
      return "sent";
    } catch {
      this.report(new Error(`WebSocket ${label} send failed`));
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
    socket.onclose = (event) => this.handleClose(socket, event);
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
    const parsed = PinOpMessageSchema.safeParse(raw);
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
      this.notifyTrustedIdeListeners(
        this.sourceNavigationStateListeners,
        this.trustedIdePeerContext(message.source.id),
        message,
      );
      return;
    }
    if (message.type === "source.matches") {
      if (
        !this.authenticated ||
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId
      ) {
        return;
      }
      this.notifyTrustedIdeListeners(
        this.sourceMatchesListeners,
        this.trustedIdePeerContext(message.source.id),
        message,
      );
      return;
    }
    if (message.type === "page.refresh") {
      if (
        !this.authenticated ||
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId
      ) {
        return;
      }
      this.notifyListeners(this.pageRefreshListeners, message);
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
        this.notifyTrustedIdeListeners(
          this.resolutionListeners,
          this.trustedIdePeerContext(message.source.id),
          message,
        );
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
      capabilities: [
        "inspect",
        "link",
        "source-presentation",
        "presentation-settings",
        "source-navigation",
        "auto-refresh",
      ],
      metadata: {},
    });
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(PinOpMessageSchema.parse(message)));
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

  private notifyTrustedIdeListeners<T>(
    listeners: Set<TrustedIdeMessageListener<T>>,
    context: TrustedIdePeerContext,
    message: T,
  ): void {
    for (const listener of [...listeners]) {
      try {
        listener(context, message);
      } catch {
        this.report(new Error("Browser bridge listener failed"));
      }
    }
  }

  private trustedIdePeerContext(sourceId: string): TrustedIdePeerContext {
    const credentials = this.credentials;
    if (!this.authenticated || !credentials) {
      throw new Error("IDE peer context requires an authenticated bridge");
    }
    return createTransportTrustedIdePeerContext(
      this.windowId,
      credentials.sessionId,
      sourceId,
    );
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

  private handleClose(
    socket: BrowserSocket,
    event: BrowserSocketCloseEvent,
  ): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.authenticated = false;
    this.detach(socket);
    const close = snapshotCloseEvent(event);
    if (close.code === PROTOCOL_MISMATCH_CLOSE_CODE) {
      this.reconnectEnabled = false;
      this.connectionIntent = undefined;
      this.credentials = undefined;
      this.pendingCredentialNotification = false;
      this.credentialsReconnectAllowed = false;
      const details = mismatchDetails(close.reason);
      this.setState("incompatible");
      this.notifyListeners(this.protocolMismatchListeners, details);
      this.report(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Pin-op protocol versions are incompatible",
        ),
      );
      return;
    }
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

function snapshotSourceOpenInput(value: unknown): SourceOpenInput | undefined {
  const record = snapshotExactDataRecord(value, [
    "inspectMessageId",
    "resolutionGeneration",
    "matchId",
  ]);
  if (!record) {
    return undefined;
  }
  const parsed = parsePanelSourceOpenCommand({
    type: "pin-op.source.open",
    inspectMessageId: record.inspectMessageId,
    resolutionGeneration: record.resolutionGeneration,
    matchId: record.matchId,
  });
  return parsed
    ? {
        inspectMessageId: parsed.inspectMessageId,
        resolutionGeneration: parsed.resolutionGeneration,
        matchId: parsed.matchId,
      }
    : undefined;
}

function snapshotPresentationSettingsInput(
  value: unknown,
): PresentationSettingsInput | undefined {
  const record = snapshotExactDataRecord(value, [
    "inspectMessageId",
    "ideHighlightEnabled",
  ]);
  if (!record) {
    return undefined;
  }
  const parsed = parsePanelPresentationSettingsCommand({
    type: "pin-op.presentation.settings",
    inspectMessageId: record.inspectMessageId,
    ideHighlightEnabled: record.ideHighlightEnabled,
  });
  return parsed
    ? {
        inspectMessageId: parsed.inspectMessageId,
        ideHighlightEnabled: parsed.ideHighlightEnabled,
      }
    : undefined;
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
    ideHighlightEnabled: payload.ideHighlightEnabled,
    metadata,
  };
}

function subscribeTrusted<T>(
  listeners: Set<TrustedIdeMessageListener<T>>,
  listener: TrustedIdeMessageListener<T>,
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

function snapshotCloseEvent(event: unknown): BrowserSocketCloseEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { code: 0, reason: "" };
  }
  const code = guardedGet(event, "code");
  const reason = guardedGet(event, "reason");
  return {
    code: Number.isInteger(code) && Number(code) >= 0 ? Number(code) : 0,
    reason: typeof reason === "string" ? reason : "",
  };
}

function guardedGet(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function mismatchDetails(reason: string): BrowserProtocolMismatch {
  const parsed = parseProtocolMismatchReason(reason);
  const peerProtocolVersion = !parsed
    ? undefined
    : parsed.expectedVersion !== PROTOCOL_VERSION
      ? parsed.expectedVersion
      : parsed.receivedVersion !== PROTOCOL_VERSION
        ? parsed.receivedVersion
        : undefined;
  return Object.freeze({
    browserProtocolVersion: PROTOCOL_VERSION,
    ...(peerProtocolVersion === undefined ? {} : { peerProtocolVersion }),
  });
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
