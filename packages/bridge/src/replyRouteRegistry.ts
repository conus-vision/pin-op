export type ReplyRouteRegistrationStatus =
  | "created"
  | "refreshed"
  | "collision";

export interface ReplyRouteRegistration {
  readonly status: ReplyRouteRegistrationStatus;
  commit(): void;
  rollback(): void;
}

export interface ReplyRoute {
  readonly sessionId: string;
  readonly inspectMessageId: string;
  readonly originConnectionId: string;
  readonly ideConnectionId?: string;
  readonly resolutionGeneration?: number;
  readonly matchIds: ReadonlySet<string>;
}

interface Route extends ReplyRoute {
  readonly admissionId: symbol;
}

interface StoredRoute {
  readonly originConnectionId: string;
  readonly admissionId: symbol;
  ideConnectionId?: string;
  resolutionGeneration?: number;
  matchIds: Set<string>;
}

export interface ReplyRouteRegistryOptions {
  readonly maxRoutesPerClient?: number;
}

export class ReplyRouteRegistry {
  private readonly maxRoutesPerClient: number;
  private readonly routes = new Map<string, Map<string, StoredRoute>>();
  private readonly routesByClient = new Map<string, Map<string, undefined>>();
  private readonly routesByIde = new Map<string, Set<string>>();

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
      if (currentRoute.originConnectionId !== connectionId) {
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
    nextSessionRoutes.set(inspectMessageId, {
      originConnectionId: connectionId,
      admissionId,
      matchIds: new Set(),
    });
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
    return this.routes.get(sessionId)?.get(inspectMessageId)?.originConnectionId;
  }

  get(sessionId: string, inspectMessageId: string): ReplyRoute | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    return route
      ? this.snapshot(sessionId, inspectMessageId, route)
      : undefined;
  }

  claimResolution(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
  ): ReplyRoute | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (!route) {
      return undefined;
    }

    if (
      route.ideConnectionId !== undefined &&
      route.ideConnectionId !== ideConnectionId
    ) {
      return undefined;
    }

    if (
      route.resolutionGeneration !== undefined &&
      resolutionGeneration < route.resolutionGeneration
    ) {
      return undefined;
    }

    if (route.ideConnectionId === undefined) {
      route.ideConnectionId = ideConnectionId;
      this.getIdeRoutes(ideConnectionId).add(
        this.routeKey(sessionId, inspectMessageId),
      );
    }

    if (route.resolutionGeneration !== resolutionGeneration) {
      route.resolutionGeneration = resolutionGeneration;
      route.matchIds = new Set();
    }

    this.touchClientRoute(
      route.originConnectionId,
      sessionId,
      inspectMessageId,
    );
    return this.snapshot(sessionId, inspectMessageId, route);
  }

  replaceMatchIds(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
    matchIds: Iterable<string>,
  ): ReplyRoute | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (
      !route ||
      route.ideConnectionId !== ideConnectionId ||
      route.resolutionGeneration !== resolutionGeneration
    ) {
      return undefined;
    }

    route.matchIds = new Set(matchIds);
    this.touchClientRoute(
      route.originConnectionId,
      sessionId,
      inspectMessageId,
    );
    return this.snapshot(sessionId, inspectMessageId, route);
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
    const routeKeys = new Set([
      ...(this.routesByClient.get(connectionId)?.keys() ?? []),
      ...(this.routesByIde.get(connectionId) ?? []),
    ]);
    for (const routeKey of routeKeys) {
      this.removeByKey(routeKey);
    }
  }

  clear(): void {
    this.routes.clear();
    this.routesByClient.clear();
    this.routesByIde.clear();
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

  private getIdeRoutes(connectionId: string): Set<string> {
    const existing = this.routesByIde.get(connectionId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    this.routesByIde.set(connectionId, created);
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

    const clientRoutes = this.routesByClient.get(storedRoute.originConnectionId);
    clientRoutes?.delete(routeKey);
    if (clientRoutes?.size === 0) {
      this.routesByClient.delete(storedRoute.originConnectionId);
    }

    if (storedRoute.ideConnectionId !== undefined) {
      const ideRoutes = this.routesByIde.get(storedRoute.ideConnectionId);
      ideRoutes?.delete(routeKey);
      if (ideRoutes?.size === 0) {
        this.routesByIde.delete(storedRoute.ideConnectionId);
      }
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
      currentRoute.originConnectionId !== connectionId ||
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
        originConnectionId: evictedRoute.originConnectionId,
        admissionId: evictedRoute.admissionId,
        ideConnectionId: evictedRoute.ideConnectionId,
        resolutionGeneration: evictedRoute.resolutionGeneration,
        matchIds: new Set(evictedRoute.matchIds),
      });
      this.routes.set(evictedRoute.sessionId, sessionRoutes);

      const currentClientRoutes = this.getClientRoutes(
        evictedRoute.originConnectionId,
      );
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
      this.routesByClient.set(
        evictedRoute.originConnectionId,
        restoredClientRoutes,
      );
      if (evictedRoute.ideConnectionId !== undefined) {
        this.getIdeRoutes(evictedRoute.ideConnectionId).add(evictedRouteKey);
      }
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

  private snapshot(
    sessionId: string,
    inspectMessageId: string,
    route: StoredRoute,
  ): ReplyRoute {
    return {
      sessionId,
      inspectMessageId,
      originConnectionId: route.originConnectionId,
      ideConnectionId: route.ideConnectionId,
      resolutionGeneration: route.resolutionGeneration,
      matchIds: new Set(route.matchIds),
    };
  }

  private routeKey(sessionId: string, inspectMessageId: string): string {
    return JSON.stringify([sessionId, inspectMessageId]);
  }
}
