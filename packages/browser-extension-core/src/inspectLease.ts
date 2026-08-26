import type {
  ContentInspectPort,
  ContentSessionId,
} from "./inspectPortProtocol.js";

export interface InspectLeaseTarget {
  enable(): void;
  disable(): void;
}

interface InspectLeaseConnection {
  readonly port: ContentInspectPort;
  readonly onDisconnect: () => void;
}

export class ContentInspectLease {
  private connection: InspectLeaseConnection | undefined;

  public constructor(
    private readonly target: InspectLeaseTarget,
    private readonly createPort: () => ContentInspectPort,
  ) {}

  public enable(): void {
    const previousConnection = this.connection;
    if (previousConnection) {
      this.close(previousConnection, true);
    }

    const port = this.createPort();
    const connection: InspectLeaseConnection = {
      port,
      onDisconnect: () => this.handleDisconnect(connection),
    };
    this.connection = connection;
    port.onDisconnect.addListener(connection.onDisconnect);
    try {
      this.target.enable();
    } catch (error) {
      this.close(connection, true);
      throw error;
    }
  }

  public disable(): void {
    this.target.disable();
    const connection = this.connection;
    if (connection) {
      this.close(connection, true);
    }
  }

  private handleDisconnect(connection: InspectLeaseConnection): void {
    if (this.connection !== connection) {
      return;
    }
    this.close(connection, false);
    this.target.disable();
  }

  private close(
    connection: InspectLeaseConnection,
    disconnect: boolean,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    connection.port.onDisconnect.removeListener(connection.onDisconnect);
    if (!disconnect) {
      return;
    }
    try {
      connection.port.disconnect();
    } catch {
      // The browser may already have closed the lease.
    }
  }
}

interface RegisteredInspectLease {
  readonly port: ContentInspectPort;
  readonly onDisconnect: () => void;
  readonly contentSessionId?: ContentSessionId;
}

export interface DetachedBackgroundInspectLease {
  readonly contentSessionId: ContentSessionId | undefined;
  release(): void;
}

export class BackgroundInspectLeaseRegistry {
  private readonly leases = new Map<number, RegisteredInspectLease>();

  public attach(
    tabId: number,
    port: ContentInspectPort,
    onUnexpectedDisconnect: () => void,
    contentSessionId?: ContentSessionId,
  ): void {
    this.release(tabId);
    const lease: RegisteredInspectLease = {
      port,
      contentSessionId,
      onDisconnect: () => {
        if (this.leases.get(tabId) === lease) {
          this.leases.delete(tabId);
          onUnexpectedDisconnect();
        }
      },
    };
    this.leases.set(tabId, lease);
    port.onDisconnect.addListener(lease.onDisconnect);
  }

  public release(tabId: number): void {
    this.detach(tabId)?.release();
  }

  public isCurrent(tabId: number, contentSessionId: ContentSessionId): boolean {
    return this.leases.get(tabId)?.contentSessionId === contentSessionId;
  }

  public has(tabId: number): boolean {
    return this.leases.has(tabId);
  }

  public contentSessionId(tabId: number): ContentSessionId | undefined {
    return this.leases.get(tabId)?.contentSessionId;
  }

  /** Revokes disconnect callbacks now while retaining an addressable lease identity. */
  public detach(tabId: number): DetachedBackgroundInspectLease | undefined {
    const lease = this.leases.get(tabId);
    if (!lease) {
      return undefined;
    }
    this.leases.delete(tabId);
    lease.port.onDisconnect.removeListener(lease.onDisconnect);
    let active = true;
    return {
      contentSessionId: lease.contentSessionId,
      release() {
        if (!active) return;
        active = false;
        try {
          lease.port.disconnect();
        } catch {
          // The content side may already have observed the disconnect.
        }
      },
    };
  }
}
