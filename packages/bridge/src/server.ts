import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  probeProtocolVersion,
  protocolMismatchReason,
  type PinOpMessage,
  type ProtocolErrorCode,
} from "@pin-op/protocol";
import {
  ClientRegistry,
  createGuardedWebSocketConnection,
  sendConnectionSafely,
  supportsCapability,
  type BridgeConnection,
  type RegisteredClient,
} from "./clientRegistry.js";
import { startHeartbeat, type Heartbeat } from "./heartbeat.js";
import { LinkAuthenticator } from "./linkAuthenticator.js";
import {
  PeerStateRegistry,
  type PeerStateSnapshot,
  type PeerStateTransition,
} from "./peerStateRegistry.js";
import { ReplyRouteRegistry } from "./replyRouteRegistry.js";
import { routeMessage } from "./router.js";

export interface BridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly sessionId?: string;
  readonly authenticator?: LinkAuthenticator;
  readonly registry?: ClientRegistry;
  readonly peerStateRegistry?: PeerStateRegistry;
  readonly replyRoutes?: ReplyRouteRegistry;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxPayloadBytes?: number;
}

export interface BridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
  getLinkInfo(): { readonly bridgeInstanceId: string; readonly pin: string };
  onClientCountChanged(
    listener: (counts: {
      readonly browser: number;
      readonly ide: number;
    }) => void,
  ): { dispose(): void };
  readonly registry: ClientRegistry;
  readonly authenticator: LinkAuthenticator;
}

interface ClientCounts {
  readonly browser: number;
  readonly ide: number;
}

type ClientCountListener = (counts: ClientCounts) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 48_735;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const BRIDGE_MAX_PAYLOAD_BYTES = 1024 * 1024;

export function createBridgeServer(
  options: BridgeServerOptions = {},
): BridgeServer {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    throw new Error(`Bridge host must be ${DEFAULT_HOST}`);
  }

  const port = options.port ?? DEFAULT_PORT;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new Error("Bridge handshake timeout must be a positive number");
  }
  const heartbeatIntervalMs = options.heartbeatIntervalMs;
  if (
    heartbeatIntervalMs !== undefined &&
    (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0)
  ) {
    throw new Error("Bridge heartbeat interval must be a positive number");
  }
  const maxPayloadBytes =
    options.maxPayloadBytes === undefined
      ? BRIDGE_MAX_PAYLOAD_BYTES
      : options.maxPayloadBytes;
  if (
    !Number.isInteger(maxPayloadBytes) ||
    maxPayloadBytes <= 0 ||
    maxPayloadBytes > BRIDGE_MAX_PAYLOAD_BYTES
  ) {
    throw new Error(
      `Bridge max payload must be an integer from 1 to ${BRIDGE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }

  const defaultSessionId = options.sessionId ?? "default";
  const registry = options.registry ?? new ClientRegistry();
  const peerStateRegistry = options.peerStateRegistry ?? new PeerStateRegistry();
  const replyRoutes = options.replyRoutes ?? new ReplyRouteRegistry();
  const authenticator =
    options.authenticator ?? new LinkAuthenticator({ sessionId: defaultSessionId });
  const activeSockets = new Map<WebSocket, BridgeConnection>();
  const handshakeTimers = new Map<
    WebSocket,
    ReturnType<typeof setTimeout>
  >();
  const countListeners = new Set<ClientCountListener>();
  let server: WebSocketServer | undefined;
  let heartbeat: Heartbeat | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let startedSuccessfully = false;

  const notifyClientCounts = (): void => {
    const counts: ClientCounts = {
      browser: registry.countByRole("browser"),
      ide: registry.countByRole("ide"),
    };

    for (const listener of [...countListeners]) {
      try {
        listener({ ...counts });
      } catch {
        // One consumer must not prevent other listeners or server cleanup.
      }
    }
  };

  const publishPeerState = (
    transition: PeerStateTransition,
    excludedClientId?: string,
  ): void => {
    const message = createPeerStateMessage(transition.sessionId, transition);
    for (const client of [
      ...registry.findBySessionAndRole(transition.sessionId, "browser"),
      ...registry.findBySessionAndRole(transition.sessionId, "simulator"),
    ]) {
      if (client.id === excludedClientId) {
        continue;
      }
      sendSocketMessage(client.connection, message);
    }
  };

  const updatePeerState = (sessionId: string): void => {
    const transition = peerStateRegistry.updateIdeCount(
      sessionId,
      registry.countBySessionAndRole(sessionId, "ide"),
    );
    if (transition) {
      publishPeerState(transition);
    }
  };

  const sendCurrentPeerState = (client: RegisteredClient): void => {
    const transition = peerStateRegistry.updateIdeCount(
      client.sessionId,
      registry.countBySessionAndRole(client.sessionId, "ide"),
    );
    if (transition) {
      publishPeerState(transition, client.id);
    }
    const snapshot = peerStateRegistry.get(client.sessionId);
    sendSocketMessage(
      client.connection,
      createPeerStateMessage(client.sessionId, snapshot),
    );
  };

  const onClientRemoved = (client: RegisteredClient): void => {
    replyRoutes.removeClient(client.id);
    if (client.source.role === "ide") {
      updatePeerState(client.sessionId);
    }
    notifyClientCounts();
  };

  const clearHandshakeTimer = (socket: WebSocket): void => {
    const timer = handshakeTimers.get(socket);
    if (timer) {
      clearTimeout(timer);
      handshakeTimers.delete(socket);
    }
  };

  return {
    registry,
    authenticator,
    async start() {
      if (stopPromise) {
        throw new Error(
          startedSuccessfully
            ? "BridgeServer cannot be restarted; create a new BridgeServer"
            : "BridgeServer cannot start while stopping",
        );
      }

      if (server) {
        return;
      }

      if (startPromise) {
        return startPromise;
      }

      if (startedSuccessfully) {
        throw new Error(
          "BridgeServer cannot be restarted; create a new BridgeServer",
        );
      }

      startPromise = (async () => {
        const nextServer = new WebSocketServer({
          host,
          port,
          maxPayload: maxPayloadBytes,
          verifyClient: ({ origin }: { origin: string }) =>
            isAllowedWebSocketOrigin(origin),
        });
        nextServer.on("connection", (socket) => {
          const connection = createGuardedWebSocketConnection(socket);
          activeSockets.set(socket, connection);
          const handshakeTimer = setTimeout(() => {
            handshakeTimers.delete(socket);
            connection.terminate();
          }, handshakeTimeoutMs);
          handshakeTimer.unref();
          handshakeTimers.set(socket, handshakeTimer);
          socket.once("close", () => {
            activeSockets.delete(socket);
            clearHandshakeTimer(socket);
          });
          socket.on("error", () => {
            if (
              socket.readyState !== socket.CLOSING &&
              socket.readyState !== socket.CLOSED
            ) {
              connection.terminate();
            }
          });
          handleConnection(
            socket,
            connection,
            registry,
            replyRoutes,
            authenticator,
            notifyClientCounts,
            onClientRemoved,
            updatePeerState,
            sendCurrentPeerState,
            () => clearHandshakeTimer(socket),
          );
        });

        try {
          await new Promise<void>((resolve, reject) => {
            nextServer.once("listening", resolve);
            nextServer.once("error", reject);
          });
        } catch (error) {
          nextServer.removeAllListeners();
          nextServer.close();
          throw error;
        }

        server = nextServer;
        heartbeat = startHeartbeat(
          registry,
          heartbeatIntervalMs,
          onClientRemoved,
        );
        startedSuccessfully = true;
      })();

      try {
        await startPromise;
      } finally {
        startPromise = undefined;
      }
    },
    async stop() {
      if (stopPromise) {
        return stopPromise;
      }

      if (startedSuccessfully && !server && !startPromise) {
        return;
      }

      stopPromise = (async () => {
        const pendingStart = startPromise;
        if (pendingStart) {
          await pendingStart.catch(() => undefined);
        }

        heartbeat?.stop();
        heartbeat = undefined;

        registry.clear();
        peerStateRegistry.clear();
        replyRoutes.clear();
        authenticator.revokeAll();
        notifyClientCounts();

        for (const timer of handshakeTimers.values()) {
          clearTimeout(timer);
        }
        handshakeTimers.clear();

        for (const connection of activeSockets.values()) {
          connection.close?.();
          connection.terminate();
        }

        await new Promise<void>((resolve, reject) => {
          if (!server) {
            resolve();
            return;
          }

          const closingServer = server;
          server = undefined;
          closingServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      })();

      try {
        await stopPromise;
      } finally {
        stopPromise = undefined;
      }
    },
    getUrl() {
      const address = server?.address();
      const resolvedPort =
        typeof address === "object" && address ? (address as AddressInfo).port : port;
      return `ws://${host}:${resolvedPort}`;
    },
    getLinkInfo() {
      return authenticator.linkInfo();
    },
    onClientCountChanged(listener) {
      countListeners.add(listener);
      return {
        dispose() {
          countListeners.delete(listener);
        },
      };
    },
  };
}

function handleConnection(
  socket: WebSocket,
  connection: BridgeConnection,
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  authenticator: LinkAuthenticator,
  notifyClientCounts: () => void,
  onClientRemoved: (client: RegisteredClient) => void,
  updatePeerState: (sessionId: string) => void,
  sendCurrentPeerState: (client: RegisteredClient) => void,
  clearHandshakeTimer: () => void,
): void {
  let registered: RegisteredClient | undefined;
  let linkAttempted = false;
  let closing = false;

  const removeRegistration = (): RegisteredClient | undefined => {
    const client = registered;
    registered = undefined;
    if (client) {
      if (registry.remove(client.id)) {
        onClientRemoved(client);
      } else {
        replyRoutes.removeClient(client.id);
      }
    }
    return client;
  };

  const closeConnection = (code?: number, reason?: string): void => {
    closing = true;
    clearHandshakeTimer();
    connection.close?.(code, reason);
  };

  socket.on("message", (data) => {
    if (closing) {
      return;
    }

    const payload = data.toString();
    const versionProbe = probeProtocolVersion(payload);
    if (!versionProbe.compatible) {
      closeConnection(
        PROTOCOL_MISMATCH_CLOSE_CODE,
        protocolMismatchReason(versionProbe.receivedVersion),
      );
      return;
    }

    let message: PinOpMessage;

    try {
      message = PinOpMessageSchema.parse(JSON.parse(payload));
    } catch {
      sendSocketError(
        connection,
        "protocol.invalidMessage",
        "Message does not match protocol",
        true,
      );
      closeConnection();
      return;
    }

    if (message.type === "linkRequest") {
      if (linkAttempted || registered) {
        sendSocketError(
          connection,
          "protocol.invalidMessage",
          "Only one link request is allowed per connection",
          true,
        );
        closeConnection();
        return;
      }

      linkAttempted = true;
      if (!handleLinkRequest(connection, authenticator, message)) {
        closeConnection();
      }
      return;
    }

    if (!registered) {
      if (message.type !== "hello") {
        sendSocketError(
          connection,
          "protocol.invalidMessage",
          "Client must authenticate with hello",
          true,
        );
        closeConnection();
        return;
      }

      const bridgeInstanceId = authenticator.linkInfo().bridgeInstanceId;
      if (message.bridgeInstanceId !== bridgeInstanceId) {
        sendSocketError(
          connection,
          "auth.instanceChanged",
          "Bridge instance changed",
          true,
        );
        closeConnection();
        return;
      }

      const validation = authenticator.validateToken(
        message.sessionId,
        message.source.role,
        message.authToken,
        bridgeInstanceId,
      );
      if (validation !== "accepted") {
        sendSocketError(
          connection,
          validation === "instanceChanged"
            ? "auth.instanceChanged"
            : "auth.tokenRejected",
          validation === "instanceChanged"
            ? "Bridge instance changed"
            : "Authentication token rejected",
          true,
        );
        closeConnection();
        return;
      }

      clearHandshakeTimer();
      registered = registry.add({
        connection,
        source: message.source,
        sessionId: message.sessionId,
        authToken: message.authToken,
        capabilities: message.capabilities,
      });
      notifyClientCounts();
      sendSocketMessage(connection, {
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticated",
        messageId: randomUUID(),
        sessionId: message.sessionId,
        bridgeInstanceId,
        metadata: {},
      });
      if (
        registered.source.role === "browser" ||
        registered.source.role === "simulator"
      ) {
        sendCurrentPeerState(registered);
      } else {
        updatePeerState(registered.sessionId);
      }
      return;
    }

    if (message.type === "hello") {
      sendSocketError(
        connection,
        "protocol.invalidMessage",
        "Client is already authenticated",
        true,
      );
      closeConnection();
      return;
    }

    if (!isAllowedInboundMessage(registered, message)) {
      sendSocketError(
        connection,
        "protocol.invalidMessage",
        "Message does not match protocol",
        true,
      );
      closeConnection();
      return;
    }

    if (message.type === "unlink") {
      closing = true;
      clearHandshakeTimer();
      const client = registered;
      registered = undefined;
      const removed = client ? registry.remove(client.id) : false;
      if (client) {
        authenticator.revokeToken(client.authToken);
      }
      if (removed) {
        onClientRemoved(client);
      } else if (client) {
        replyRoutes.removeClient(client.id);
      }
      connection.close?.();
      return;
    }

    if (message.type === "pong") {
      registry.markAlive(registered.id);
      return;
    }

    routeMessage(registry, replyRoutes, registered, message);
  });

  socket.on("close", () => {
    closing = true;
    clearHandshakeTimer();
    removeRegistration();
  });
}

function isAllowedInboundMessage(
  client: RegisteredClient,
  message: PinOpMessage,
): boolean {
  switch (message.type) {
    case "unlink":
      return message.sessionId === client.sessionId;
    case "inspect":
      return (
        (client.source.role === "browser" ||
          client.source.role === "simulator") &&
        message.sessionId === client.sessionId &&
        message.source.role === client.source.role &&
        message.source.id === client.source.id &&
        supportsCapability(client, "inspect")
      );
    case "resolution":
      return (
        client.source.role === "ide" &&
        message.sessionId === client.sessionId &&
        message.source.id === client.source.id &&
        supportsCapability(client, "resolution")
      );
    case "source.matches":
      return (
        client.source.role === "ide" &&
        message.sessionId === client.sessionId &&
        message.source.id === client.source.id &&
        supportsCapability(client, "source-presentation")
      );
    case "source.open":
      return (
        (client.source.role === "browser" ||
          client.source.role === "simulator") &&
        message.sessionId === client.sessionId &&
        supportsCapability(client, "source-presentation")
      );
    case "presentation.settings":
      return (
        (client.source.role === "browser" ||
          client.source.role === "simulator") &&
        message.sessionId === client.sessionId &&
        supportsCapability(client, "presentation-settings")
      );
    case "source.navigate":
      return (
        (client.source.role === "browser" ||
          client.source.role === "simulator") &&
        message.sessionId === client.sessionId &&
        supportsCapability(client, "source-navigation")
      );
    case "source.navigationState":
      return (
        client.source.role === "ide" &&
        message.sessionId === client.sessionId &&
        message.source.id === client.source.id &&
        supportsCapability(client, "source-navigation")
      );
    case "page.refresh":
      return (
        client.source.role === "ide" &&
        message.sessionId === client.sessionId &&
        message.source.id === client.source.id &&
        supportsCapability(client, "auto-refresh")
      );
    case "pong":
      return true;
    default:
      return false;
  }
}

function handleLinkRequest(
  connection: BridgeConnection,
  authenticator: LinkAuthenticator,
  message: Extract<PinOpMessage, { type: "linkRequest" }>,
): boolean {
  const role = message.source.role;
  if (role !== "browser" && role !== "simulator") {
    sendSocketError(
      connection,
      "protocol.invalidMessage",
      "Message does not match protocol",
      true,
    );
    return false;
  }

  const attempt = authenticator.attemptLink(message.pin, role);
  if ("accepted" in attempt) {
    sendSocketMessage(connection, {
      protocolVersion: PROTOCOL_VERSION,
      type: "linkAccepted",
      messageId: randomUUID(),
      sessionId: attempt.accepted.sessionId,
      bridgeInstanceId: attempt.accepted.bridgeInstanceId,
      authToken: attempt.accepted.authToken.value,
      expiresAt: attempt.accepted.authToken.expiresAt.toISOString(),
      metadata: {},
    });
    return true;
  }

  if (attempt.errorCode === "link.rateLimited") {
    sendSocketError(
      connection,
      "link.rateLimited",
      "Link request rate limited",
      false,
      { retryAt: attempt.retryAt.toISOString() },
    );
    return false;
  }

  sendSocketError(connection, "link.rejected", "Link request rejected");
  return false;
}

function sendSocketMessage(
  connection: BridgeConnection,
  message: PinOpMessage,
): void {
  const parsed = PinOpMessageSchema.parse(message);
  sendConnectionSafely(connection, JSON.stringify(parsed));
}

function createPeerStateMessage(
  sessionId: string,
  snapshot: PeerStateSnapshot,
): PinOpMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "peerState",
    messageId: randomUUID(),
    sessionId,
    role: "ide",
    connected: snapshot.connected,
    peerGeneration: snapshot.peerGeneration,
    metadata: {},
  };
}

function sendSocketError(
  connection: BridgeConnection,
  code: ProtocolErrorCode,
  message: string,
  fatal = false,
  details: Record<string, unknown> = {},
): void {
  sendSocketMessage(connection, {
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    messageId: randomUUID(),
    code,
    message,
    details: { fatal, ...details },
    metadata: {},
  });
}

function isAllowedWebSocketOrigin(origin: string): boolean {
  if (!origin) {
    return true;
  }

  try {
    const protocol = new URL(origin).protocol;
    return protocol === "moz-extension:" || protocol === "chrome-extension:";
  } catch {
    return false;
  }
}
