import { randomUUID } from "node:crypto";
import type { ClientRole, ClientSource } from "@browser2ide/protocol";
import WebSocket from "ws";

export interface BridgeConnection {
  send(payload: string): boolean;
  terminate(): void;
  close?: () => void;
}

export function createGuardedWebSocketConnection(
  socket: WebSocket,
): BridgeConnection {
  return {
    send(payload) {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      try {
        socket.send(payload, (error) => {
          if (error) {
            terminateWebSocket(socket);
          }
        });
        return true;
      } catch {
        terminateWebSocket(socket);
        return false;
      }
    },
    terminate() {
      terminateWebSocket(socket);
    },
    close() {
      if (
        socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED
      ) {
        return;
      }

      try {
        socket.close();
      } catch {
        terminateWebSocket(socket);
      }
    },
  };
}

export function sendConnectionSafely(
  connection: BridgeConnection,
  payload: string,
): boolean {
  try {
    return connection.send(payload);
  } catch {
    terminateConnectionSafely(connection);
    return false;
  }
}

export function terminateConnectionSafely(
  connection: BridgeConnection,
): void {
  try {
    connection.terminate();
  } catch {
    // Connection failures are terminal and must not escape the bridge loop.
  }
}

function terminateWebSocket(socket: WebSocket): void {
  try {
    socket.terminate();
  } catch {
    // The socket is already unusable.
  }
}

export interface ClientRegistration {
  readonly connection: BridgeConnection;
  readonly source: ClientSource;
  readonly sessionId: string;
  readonly authToken: string;
}

export interface RegisteredClient extends ClientRegistration {
  readonly id: string;
  missedPongs: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();

  add(client: ClientRegistration): RegisteredClient {
    const entry: RegisteredClient = {
      ...client,
      id: randomUUID(),
      missedPongs: 0,
    };

    this.clients.set(entry.id, entry);
    return entry;
  }

  remove(id: string): boolean {
    return this.clients.delete(id);
  }

  get(id: string): RegisteredClient | undefined {
    return this.clients.get(id);
  }

  countByRole(role: ClientRole): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.source.role === role) {
        count += 1;
      }
    }
    return count;
  }

  clear(): void {
    this.clients.clear();
  }

  findBySessionAndRole(
    sessionId: string,
    role: ClientRole,
  ): RegisteredClient[] {
    return this.all().filter(
      (client) => client.sessionId === sessionId && client.source.role === role,
    );
  }

  markAlive(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.missedPongs = 0;
    }
  }

  markPingSent(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.missedPongs += 1;
    }
  }

  all(): RegisteredClient[] {
    return [...this.clients.values()];
  }
}
