export interface PeerStateSnapshot {
  readonly connected: boolean;
  readonly peerGeneration: number;
}

export interface PeerStateTransition extends PeerStateSnapshot {
  readonly sessionId: string;
}

export class PeerStateRegistry {
  private readonly states = new Map<string, PeerStateSnapshot>();

  get(sessionId: string): PeerStateSnapshot {
    return this.states.get(sessionId) ?? {
      connected: false,
      peerGeneration: 0,
    };
  }

  updateIdeCount(
    sessionId: string,
    count: number,
  ): PeerStateTransition | undefined {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("IDE count must be a nonnegative integer");
    }

    const previous = this.get(sessionId);
    const connected = count > 0;
    if (connected === previous.connected) {
      return undefined;
    }

    const next = {
      connected,
      peerGeneration: previous.peerGeneration + 1,
    };
    this.states.set(sessionId, next);
    return { sessionId, ...next };
  }

  clear(): void {
    this.states.clear();
  }
}
