import { randomUUID } from "node:crypto";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
  type PinOpMessage,
  type ErrorMessage,
  type ProtocolErrorCode,
} from "@pin-op/protocol";
import {
  sendConnectionSafely,
  supportsCapability,
  type ClientRegistry,
  type RegisteredClient,
} from "./clientRegistry.js";
import {
  ReplyRouteRegistry,
  type ReplyRoute,
} from "./replyRouteRegistry.js";

export function routeMessage(
  registry: ClientRegistry,
  replyRoutes: ReplyRouteRegistry,
  sender: RegisteredClient,
  message: PinOpMessage,
): void {
  switch (message.type) {
    case "inspect":
      if (
        (sender.source.role !== "browser" &&
          sender.source.role !== "simulator") ||
        message.sessionId !== sender.sessionId ||
        message.source.role !== sender.source.role ||
        message.source.id !== sender.source.id ||
        !supportsCapability(sender, "inspect")
      ) {
        sendInvalid(sender);
        return;
      }

      const registration = replyRoutes.register(
        message.sessionId,
        message.messageId,
        sender.id,
      );
      if (registration.status === "collision") {
        sendInvalid(sender);
        return;
      }

      const resolutionClients = registry
        .findBySessionAndRole(message.sessionId, "ide")
        .filter((client) => supportsCapability(client, "resolution"));
      if (sendToClients(resolutionClients, message) === 0) {
        registration.rollback();
        sendNoIde(sender);
        return;
      }

      if (!registration.commit()) {
        sendInvalid(sender);
      }
      return;
    case "resolution":
      if (
        sender.source.role !== "ide" ||
        message.source.id !== sender.source.id ||
        !supportsCapability(sender, "resolution")
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

      const claimedRoute = replyRoutes.claimResolution(
        message.sessionId,
        message.inspectMessageId,
        sender.id,
        message.resolutionGeneration,
      );
      if (!claimedRoute) {
        sendNoBrowser(sender);
        return;
      }

      const resolutionRecipient = getOriginRecipient(registry, claimedRoute);
      if (!resolutionRecipient || !sendMessage(resolutionRecipient, message)) {
        replyRoutes.remove(message.sessionId, message.inspectMessageId);
        sendNoBrowser(sender);
      }
      return;
    case "source.matches": {
      if (
        sender.source.role !== "ide" ||
        message.source.id !== sender.source.id ||
        message.sessionId !== sender.sessionId ||
        !supportsCapability(sender, "source-presentation")
      ) {
        sendInvalid(sender);
        return;
      }

      const isEmptyInvalidation = message.matches.length === 0 &&
        message.omittedMatchCount === 0;
      if (
        isEmptyInvalidation &&
        !supportsCapability(sender, "resolution")
      ) {
        sendInvalid(sender);
        return;
      }

      const route = replyRoutes.get(
        message.sessionId,
        message.inspectMessageId,
      );
      const recipient = route ? getOriginRecipient(registry, route) : undefined;
      if (
        !route ||
        !recipient ||
        !supportsCapability(recipient, "source-presentation")
      ) {
        sendNoBrowser(sender);
        return;
      }

      const updatedRoute = isEmptyInvalidation
        ? replyRoutes.claimSourceInvalidation(
            message.sessionId,
            message.inspectMessageId,
            sender.id,
            message.resolutionGeneration,
          )
        : replyRoutes.replaceMatchIds(
            message.sessionId,
            message.inspectMessageId,
            sender.id,
            message.resolutionGeneration,
            message.matches.map((match) => match.matchId),
          );
      if (!updatedRoute || !sendMessage(recipient, message)) {
        if (updatedRoute) {
          replyRoutes.remove(message.sessionId, message.inspectMessageId);
        }
        sendNoBrowser(sender);
      }
      return;
    }
    case "source.open": {
      if (
        (sender.source.role !== "browser" &&
          sender.source.role !== "simulator") ||
        message.sessionId !== sender.sessionId ||
        !supportsCapability(sender, "source-presentation")
      ) {
        sendInvalid(sender);
        return;
      }

      const route = replyRoutes.get(
        message.sessionId,
        message.inspectMessageId,
      );
      if (
        !route ||
        route.originConnectionId !== sender.id ||
        route.resolutionGeneration !== message.resolutionGeneration ||
        !route.matchIds.has(message.matchId)
      ) {
        sendInvalid(sender);
        return;
      }

      const recipient = getIdeRecipient(registry, route);
      if (
        !recipient ||
        !supportsCapability(recipient, "source-presentation")
      ) {
        sendNoIde(sender);
        return;
      }

      replyRoutes.resolve(message.sessionId, message.inspectMessageId);
      if (!sendMessage(recipient, message)) {
        sendNoIde(sender);
      }
      return;
    }
    case "presentation.settings": {
      if (
        (sender.source.role !== "browser" &&
          sender.source.role !== "simulator") ||
        message.sessionId !== sender.sessionId ||
        !supportsCapability(sender, "presentation-settings")
      ) {
        sendInvalid(sender);
        return;
      }

      const route = replyRoutes.get(
        message.sessionId,
        message.inspectMessageId,
      );
      if (!route || route.originConnectionId !== sender.id) {
        sendInvalid(sender);
        return;
      }

      const recipient = getIdeRecipient(registry, route);
      if (
        !recipient ||
        !supportsCapability(recipient, "presentation-settings")
      ) {
        sendNoIde(sender);
        return;
      }

      replyRoutes.resolve(message.sessionId, message.inspectMessageId);
      if (!sendMessage(recipient, message)) {
        sendNoIde(sender);
      }
      return;
    }
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

      const navigationRoute = replyRoutes.get(
        message.sessionId,
        message.inspectMessageId,
      );
      if (
        !navigationRoute ||
        navigationRoute.originConnectionId !== sender.id ||
        navigationRoute.resolutionGeneration !== message.resolutionGeneration
      ) {
        sendInvalid(sender);
        return;
      }

      const navigationRecipient = getIdeRecipient(registry, navigationRoute);
      if (
        !navigationRecipient ||
        !supportsCapability(navigationRecipient, "source-navigation")
      ) {
        sendNoIde(sender);
        return;
      }

      replyRoutes.resolve(message.sessionId, message.inspectMessageId);
      if (!sendMessage(navigationRecipient, message)) {
        sendNoIde(sender);
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

      const stateRoute = replyRoutes.get(
        message.sessionId,
        message.inspectMessageId,
      );
      const stateRecipient = stateRoute
        ? getOriginRecipient(registry, stateRoute)
        : undefined;
      const isZeroState =
        message.selectedMatchCount === 0 &&
        message.activeMatchIndex === undefined &&
        message.activeMatchId === undefined;
      const isOwnedGeneration =
        stateRoute?.ideConnectionId === sender.id &&
        stateRoute.resolutionGeneration === message.resolutionGeneration;
      const isClearingState =
        isZeroState &&
        ((stateRoute?.ideConnectionId === undefined &&
          supportsCapability(sender, "resolution")) ||
          isOwnedGeneration);
      const isAuthoritativeState =
        !isZeroState &&
        isOwnedGeneration &&
        stateRoute.resolutionClaimed &&
        (message.activeMatchId === undefined ||
          stateRoute.matchIds.has(message.activeMatchId));
      if (
        !stateRoute ||
        (!isClearingState && !isAuthoritativeState) ||
        !stateRecipient ||
        !supportsCapability(stateRecipient, "source-navigation")
      ) {
        sendNoBrowser(sender);
        return;
      }

      replyRoutes.resolve(message.sessionId, message.inspectMessageId);
      if (!sendMessage(stateRecipient, message)) {
        replyRoutes.remove(message.sessionId, message.inspectMessageId);
        sendNoBrowser(sender);
      }
      return;
    case "page.refresh":
      if (
        sender.source.role !== "ide" ||
        message.source.id !== sender.source.id ||
        message.sessionId !== sender.sessionId ||
        !supportsCapability(sender, "auto-refresh")
      ) {
        sendInvalid(sender);
        return;
      }

      sendToClients(
        [
          ...registry.findBySessionAndRole(message.sessionId, "browser"),
          ...registry.findBySessionAndRole(message.sessionId, "simulator"),
        ].filter((client) => supportsCapability(client, "auto-refresh")),
        message,
      );
      return;
    case "error":
      sendMessage(sender, message);
      return;
    default:
      return;
  }
}

function getOriginRecipient(
  registry: ClientRegistry,
  route: ReplyRoute,
): RegisteredClient | undefined {
  const recipient = registry.get(route.originConnectionId);
  if (
    !recipient ||
    recipient.sessionId !== route.sessionId ||
    (recipient.source.role !== "browser" && recipient.source.role !== "simulator")
  ) {
    return undefined;
  }
  return recipient;
}

function getIdeRecipient(
  registry: ClientRegistry,
  route: ReplyRoute,
): RegisteredClient | undefined {
  if (route.ideConnectionId === undefined) {
    return undefined;
  }
  const recipient = registry.get(route.ideConnectionId);
  if (
    !recipient ||
    recipient.sessionId !== route.sessionId ||
    recipient.source.role !== "ide"
  ) {
    return undefined;
  }
  return recipient;
}

function sendInvalid(sender: RegisteredClient): void {
  sendError(sender, "protocol.invalidMessage", "Message does not match protocol");
}

function sendNoBrowser(sender: RegisteredClient): void {
  sendError(
    sender,
    "bridge.noBrowserClient",
    "No browser client is connected to this session",
  );
}

function sendNoIde(sender: RegisteredClient): void {
  sendError(
    sender,
    "bridge.noIdeClient",
    "No IDE client is connected to this session",
  );
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
