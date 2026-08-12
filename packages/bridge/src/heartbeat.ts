import { randomUUID } from "node:crypto";
import {
  PinOpMessageSchema,
  PROTOCOL_VERSION,
} from "@pinop/protocol";
import {
  sendConnectionSafely,
  terminateConnectionSafely,
  type ClientRegistry,
  type RegisteredClient,
} from "./clientRegistry.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface Heartbeat {
  stop(): void;
}

export function startHeartbeat(
  registry: ClientRegistry,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  onClientEvicted: (client: RegisteredClient) => void = () => undefined,
): Heartbeat {
  const interval = setInterval(() => {
    for (const client of registry.all()) {
      if (client.missedPongs >= 2) {
        const removed = registry.remove(client.id);
        terminateConnectionSafely(client.connection);
        if (removed) {
          onClientEvicted(client);
        }
        continue;
      }

      registry.markPingSent(client.id);
      const ping = PinOpMessageSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        type: "ping",
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        metadata: {},
      });
      sendConnectionSafely(client.connection, JSON.stringify(ping));
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
