import { randomUUID } from "node:crypto";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
  type PinOpMessage,
  type ClientRole,
  type ErrorMessage,
  type ProtocolCapability,
  type ProtocolErrorCode,
} from "@pinop/protocol";
import {
  sendConnectionSafely,
  supportsCapability,
  type ClientRegistry,
  type RegisteredClient,
} from "./clientRegistry.js";
import { ReplyRouteRegistry } from "./replyRouteRegistry.js";

export function routeMessage(
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: PinOpMessage,
): void {
  switch (message.type) {
    case "inspect":
      if (sender.source.role === "browser" || sender.source.role === "simulator") {
        const registration = replyRoutes.register(
          message.sessionId,
          message.messageId,
          sender.id,
        );
        if (registration.status === "collision") {
          sendError(
            sender,
            "protocol.invalidMessage",
            "Message does not match protocol",
          );
          return;
        }

        if (sendToRoles(registry, sender.sessionId, ["ide"], message) === 0) {
          if (registration.status === "created") {
            registration.rollback();
          }
          sendError(
            sender,
            "bridge.noIdeClient",
            "No IDE client is connected to this session",
          );
        } else {
          registration.commit();
        }
      }
      return;
    case "resolution":
      if (
        sender.source.role !== "ide" ||
        message.source.id !== sender.source.id
      ) {
        sendError(
          sender,
          "protocol.invalidMessage",
          "Message does not match protocol",
        );
        return;
      }

      if (message.sessionId !== sender.sessionId) {
        sendError(
          sender,
          "bridge.noBrowserClient",
          "No browser client is connected to this session",
        );
        return;
      }

      routeBrowserReply(registry, replyRoutes, sender, message);
      return;
    case "source.navigate":
      if (
        (sender.source.role !== "browser" &&
          sender.source.role !== "simulator") ||
        message.sessionId !== sender.sessionId ||
        !supportsCapability(sender, "source-navigation")
      ) {
        sendError(
          sender,
          "protocol.invalidMessage",
          "Message does not match protocol",
        );
        return;
      }

      if (
        replyRoutes.peek(message.sessionId, message.inspectMessageId) !==
        sender.id
      ) {
        sendError(
          sender,
          "protocol.invalidMessage",
          "Message does not match protocol",
        );
        return;
      }

      const recipients = registry
        .findBySessionAndRole(message.sessionId, "ide")
        .filter((client) => supportsCapability(client, "source-navigation"));
      if (recipients.length === 0) {
        sendError(
          sender,
          "bridge.noIdeClient",
          "No IDE client is connected to this session",
        );
        return;
      }

      if (
        replyRoutes.resolve(message.sessionId, message.inspectMessageId) !==
        sender.id
      ) {
        sendError(
          sender,
          "protocol.invalidMessage",
          "Message does not match protocol",
        );
        return;
      }

      if (
        sendToClients(recipients, message) === 0
      ) {
        sendError(
          sender,
          "bridge.noIdeClient",
          "No IDE client is connected to this session",
        );
      }
      return;
    case "source.navigationState":
      if (
        sender.source.role !== "ide" ||
        message.source.id !== sender.source.id ||
        !supportsCapability(sender, "source-navigation")
      ) {
        sendError(
          sender,
          "protocol.invalidMessage",
          "Message does not match protocol",
        );
        return;
      }

      if (message.sessionId !== sender.sessionId) {
        sendError(
          sender,
          "bridge.noBrowserClient",
          "No browser client is connected to this session",
        );
        return;
      }

      routeBrowserReply(
        registry,
        replyRoutes,
        sender,
        message,
        "source-navigation",
      );
      return;
    case "error":
      sendMessage(sender, message);
      return;
    default:
      return;
  }
}

function routeBrowserReply(
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: Extract<
    PinOpMessage,
    { type: "resolution" | "source.navigationState" }
  >,
  requiredRecipientCapability?: ProtocolCapability,
): void {
  const connectionId = requiredRecipientCapability
    ? replyRoutes.peek(message.sessionId, message.inspectMessageId)
    : replyRoutes.resolve(message.sessionId, message.inspectMessageId);
  if (connectionId === undefined) {
    sendError(
      sender,
      "bridge.noBrowserClient",
      "No browser client is connected to this session",
    );
    return;
  }

  const recipient = registry.get(connectionId);
  if (
    !recipient ||
    recipient.sessionId !== message.sessionId ||
    (recipient.source.role !== "browser" && recipient.source.role !== "simulator")
  ) {
    replyRoutes.remove(message.sessionId, message.inspectMessageId);
    sendError(
      sender,
      "bridge.noBrowserClient",
      "No browser client is connected to this session",
    );
    return;
  }

  if (
    requiredRecipientCapability &&
    !supportsCapability(recipient, requiredRecipientCapability)
  ) {
    sendError(
      sender,
      "bridge.noBrowserClient",
      "No browser client is connected to this session",
    );
    return;
  }

  if (
    requiredRecipientCapability &&
    replyRoutes.resolve(message.sessionId, message.inspectMessageId) !==
      connectionId
  ) {
    sendError(
      sender,
      "bridge.noBrowserClient",
      "No browser client is connected to this session",
    );
    return;
  }

  if (!sendMessage(recipient, message)) {
    replyRoutes.remove(message.sessionId, message.inspectMessageId);
    sendError(
      sender,
      "bridge.noBrowserClient",
      "No browser client is connected to this session",
    );
  }
}

export function sendError(
  client: RegisteredClient,
  code: ProtocolErrorCode,
  message: string,
  fatal = false,
): boolean {
  return sendMessage(client, {
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    messageId: randomUUID(),
    code,
    message,
    details: { fatal },
    metadata: {},
  });
}

export function sendMessage(
  client: RegisteredClient,
  message: PinOpMessage | ErrorMessage,
): boolean {
  const parsed = PinOpMessageSchema.parse(message);
  return sendConnectionSafely(client.connection, JSON.stringify(parsed));
}

function sendToRoles(
  registry: ClientRegistry,
  sessionId: string,
  roles: ClientRole[],
  message: PinOpMessage,
): number {
  let sent = 0;
  for (const role of roles) {
    for (const client of registry.findBySessionAndRole(sessionId, role)) {
      if (sendMessage(client, message)) {
        sent += 1;
      }
    }
  }
  return sent;
}

function sendToClients(
  clients: readonly RegisteredClient[],
  message: PinOpMessage,
): number {
  let sent = 0;
  for (const client of clients) {
    if (sendMessage(client, message)) {
      sent += 1;
    }
  }
  return sent;
}
