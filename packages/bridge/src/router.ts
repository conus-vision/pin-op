import { randomUUID } from "node:crypto";
import {
  Browser2IdeMessageSchema,
  PROTOCOL_VERSION,
  type Browser2IdeMessage,
  type ClientRole,
  type ErrorMessage,
  type ProtocolErrorCode,
} from "@browser2ide/protocol";
import {
  sendConnectionSafely,
  type ClientRegistry,
  type RegisteredClient,
} from "./clientRegistry.js";
import { ReplyRouteRegistry } from "./replyRouteRegistry.js";

export function routeMessage(
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: Browser2IdeMessage,
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

      routeResolution(registry, replyRoutes, sender, message);
      return;
    case "error":
      sendMessage(sender, message);
      return;
    default:
      return;
  }
}

function routeResolution(
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: Extract<Browser2IdeMessage, { type: "resolution" }>,
): void {
  const connectionId = replyRoutes.resolve(
    message.sessionId,
    message.inspectMessageId,
  );
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
  message: Browser2IdeMessage | ErrorMessage,
): boolean {
  const parsed = Browser2IdeMessageSchema.parse(message);
  return sendConnectionSafely(client.connection, JSON.stringify(parsed));
}

function sendToRoles(
  registry: ClientRegistry,
  sessionId: string,
  roles: ClientRole[],
  message: Browser2IdeMessage,
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
