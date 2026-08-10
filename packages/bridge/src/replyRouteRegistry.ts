export type ReplyRouteRegistrationStatus =
  | "created"
  | "refreshed"
  | "collision";

export interface ReplyRouteRegistration {
  readonly status: ReplyRouteRegistrationStatus;
  commit(): void;
  rollback(): void;
}

interface Route {
  readonly sessionId: string;
  readonly inspectMessageId: string;
  readonly connectionId: string;
  readonly admissionId: symbol;
}

interface StoredRoute {
  readonly connectionId: string;
  readonly admissionId: symbol;
}

export interface ReplyRouteRegistryOptions {
  readonly maxRoutesPerClient?: number;
}

export class ReplyRouteRegistry {
  private readonly maxRoutesPerClient: number;
  private readonly routes = new Map<string, Map<string, StoredRoute>>();
  private readonly routesByClient = new Map<string, Map<string, undefined>>();

  constructor(options: ReplyRouteRegistryOptions = {}) {
    const maxRoutesPerClient = options.maxRoutesPerClient ?? 256;
    if (!Number.isInteger(maxRoutesPerClient) || maxRoutesPerClient <= 0) {
      throw new Error("Reply route limit must be a positive integer");
    }

    this.maxRoutesPerClient = maxRoutesPerClient;
  }

  register(
    sessionId: string,
    inspectMessageId: string,
    connectionId: string,
  ): ReplyRouteRegistration {
    const sessionRoutes = this.routes.get(sessionId);
    const currentRoute = sessionRoutes?.get(inspectMessageId);
    if (currentRoute !== undefined) {
      if (currentRoute.connectionId !== connectionId) {
        return this.createRegistration("collision");
      }

      this.touchClientRoute(connectionId, sessionId, inspectMessageId);
      return this.createRegistration("refreshed");
    }

    let clientRoutes = this.getClientRoutes(connectionId);
    let evictedRoute: Route | undefined;
    let previousClientRouteKeys: string[] | undefined;
    if (clientRoutes.size >= this.maxRoutesPerClient) {
      const leastRecentlyUsed = clientRoutes.keys().next().value;
      if (leastRecentlyUsed !== undefined) {
        evictedRoute = this.routeFromKey(leastRecentlyUsed);
        previousClientRouteKeys = [...clientRoutes.keys()];
        this.removeByKey(leastRecentlyUsed);
      }
      clientRoutes = this.getClientRoutes(connectionId);
    }

    const nextSessionRoutes =
      sessionRoutes ?? new Map<string, StoredRoute>();
    const admissionId = Symbol();
    nextSessionRoutes.set(inspectMessageId, { connectionId, admissionId });
    this.routes.set(sessionId, nextSessionRoutes);
    const createdRouteKey = this.routeKey(sessionId, inspectMessageId);
    clientRoutes.set(createdRouteKey, undefined);
    let settled = false;
    let rolledBack = false;
    return {
      status: "created",
      commit() {
        settled = true;
      },
      rollback: () => {
        if (settled || rolledBack) {
          return;
        }
        rolledBack = true;
        this.rollbackCreatedRoute(
          createdRouteKey,
          connectionId,
          admissionId,
          evictedRoute,
          previousClientRouteKeys,
        );
      },
    };
  }

  resolve(sessionId: string, inspectMessageId: string): string | undefined {
    const connectionId = this.peek(sessionId, inspectMessageId);
    if (connectionId === undefined) {
      return undefined;
    }

    this.touchClientRoute(connectionId, sessionId, inspectMessageId);
    return connectionId;
  }

  peek(sessionId: string, inspectMessageId: string): string | undefined {
    return this.routes.get(sessionId)?.get(inspectMessageId)?.connectionId;
  }

  remove(sessionId: string, inspectMessageId: string): boolean {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (route === undefined) {
      return false;
    }

    this.removeByKey(this.routeKey(sessionId, inspectMessageId));
    return true;
  }

  removeClient(connectionId: string): void {
    const clientRoutes = this.routesByClient.get(connectionId);
    if (!clientRoutes) {
      return;
    }

    for (const routeKey of [...clientRoutes.keys()]) {
      this.removeByKey(routeKey);
    }
  }

  clear(): void {
    this.routes.clear();
    this.routesByClient.clear();
  }

  private getClientRoutes(connectionId: string): Map<string, undefined> {
    const existing = this.routesByClient.get(connectionId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, undefined>();
    this.routesByClient.set(connectionId, created);
    return created;
  }

  private createRegistration(
    status: ReplyRouteRegistrationStatus,
  ): ReplyRouteRegistration {
    return { status, commit() {}, rollback() {} };
  }

  private touchClientRoute(
    connectionId: string,
    sessionId: string,
    inspectMessageId: string,
  ): void {
    const clientRoutes = this.getClientRoutes(connectionId);
    const key = this.routeKey(sessionId, inspectMessageId);
    clientRoutes.delete(key);
    clientRoutes.set(key, undefined);
  }

  private removeByKey(routeKey: string): void {
    const route = this.routeFromKey(routeKey);
    const { sessionId, inspectMessageId } = route;
    const sessionRoutes = this.routes.get(sessionId);
    const storedRoute = sessionRoutes?.get(inspectMessageId);
    if (storedRoute === undefined || !sessionRoutes) {
      return;
    }

    sessionRoutes.delete(inspectMessageId);
    if (sessionRoutes.size === 0) {
      this.routes.delete(sessionId);
    }

    const clientRoutes = this.routesByClient.get(storedRoute.connectionId);
    clientRoutes?.delete(routeKey);
    if (clientRoutes?.size === 0) {
      this.routesByClient.delete(storedRoute.connectionId);
    }
  }

  private rollbackCreatedRoute(
    createdRouteKey: string,
    connectionId: string,
    admissionId: symbol,
    evictedRoute: Route | undefined,
    previousClientRouteKeys: string[] | undefined,
  ): void {
    const [sessionId, inspectMessageId] = JSON.parse(createdRouteKey) as [
      string,
      string,
    ];
    const currentRoute = this.routes.get(sessionId)?.get(inspectMessageId);
    if (
      currentRoute === undefined ||
      currentRoute.connectionId !== connectionId ||
      currentRoute.admissionId !== admissionId
    ) {
      return;
    }

    this.removeByKey(createdRouteKey);
    if (evictedRoute && previousClientRouteKeys) {
      const sessionRoutes =
        this.routes.get(evictedRoute.sessionId) ??
        new Map<string, StoredRoute>();
      sessionRoutes.set(evictedRoute.inspectMessageId, {
        connectionId: evictedRoute.connectionId,
        admissionId: evictedRoute.admissionId,
      });
      this.routes.set(evictedRoute.sessionId, sessionRoutes);

      const currentClientRoutes = this.getClientRoutes(evictedRoute.connectionId);
      const currentKeys = [...currentClientRoutes.keys()];
      const evictedRouteKey = this.routeKey(
        evictedRoute.sessionId,
        evictedRoute.inspectMessageId,
      );
      const restoredClientRoutes = new Map<string, undefined>();
      for (const routeKey of previousClientRouteKeys) {
        if (routeKey === evictedRouteKey || currentKeys.includes(routeKey)) {
          restoredClientRoutes.set(routeKey, undefined);
        }
      }
      for (const routeKey of currentKeys) {
        if (!restoredClientRoutes.has(routeKey)) {
          restoredClientRoutes.set(routeKey, undefined);
        }
      }
      this.routesByClient.set(evictedRoute.connectionId, restoredClientRoutes);
    }
  }

  private routeFromKey(routeKey: string): Route {
    const [sessionId, inspectMessageId] = JSON.parse(routeKey) as [
      string,
      string,
    ];
    const storedRoute = this.routes.get(sessionId)?.get(inspectMessageId);
    if (storedRoute === undefined) {
      throw new Error("Reply route index is inconsistent");
    }
    return { sessionId, inspectMessageId, ...storedRoute };
  }

  private routeKey(sessionId: string, inspectMessageId: string): string {
    return JSON.stringify([sessionId, inspectMessageId]);
  }
}
