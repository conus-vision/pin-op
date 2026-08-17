export type ReplyRouteRegistrationStatus =
  | "created"
  | "refreshed"
  | "collision";

export interface ReplyRouteRegistration {
  readonly status: ReplyRouteRegistrationStatus;
  commit(): boolean;
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

type Route = ReplyRoute;

interface StoredRoute {
  readonly originConnectionId: string;
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
  private revision = 0;

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
    const currentRoute = this.routes.get(sessionId)?.get(inspectMessageId);
    if (currentRoute !== undefined) {
      if (currentRoute.originConnectionId !== connectionId) {
        return this.createSettledRegistration("collision");
      }

      return this.createDeferredRegistration("refreshed", () => {
        if (
          this.routes.get(sessionId)?.get(inspectMessageId) !== currentRoute
        ) {
          return false;
        }
        this.touchClientRoute(connectionId, sessionId, inspectMessageId);
        return true;
      });
    }

    const clientRoutes = this.routesByClient.get(connectionId);
    const evictedRouteKey =
      (clientRoutes?.size ?? 0) >= this.maxRoutesPerClient
        ? clientRoutes?.keys().next().value
        : undefined;
    return this.createDeferredRegistration("created", () => {
      if (this.routes.get(sessionId)?.has(inspectMessageId)) {
        return false;
      }

      if (evictedRouteKey !== undefined) {
        this.removeByKey(evictedRouteKey);
      }

      const sessionRoutes =
        this.routes.get(sessionId) ?? new Map<string, StoredRoute>();
      sessionRoutes.set(inspectMessageId, {
        originConnectionId: connectionId,
        matchIds: new Set(),
      });
      this.routes.set(sessionId, sessionRoutes);
      this.getClientRoutes(connectionId).set(
        this.routeKey(sessionId, inspectMessageId),
        undefined,
      );
      this.markMutated();
      return true;
    });
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
    return this.claimAuthority(
      sessionId,
      inspectMessageId,
      ideConnectionId,
      resolutionGeneration,
      false,
    );
  }

  claimSourceInvalidation(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
  ): ReplyRoute | undefined {
    return this.claimAuthority(
      sessionId,
      inspectMessageId,
      ideConnectionId,
      resolutionGeneration,
      true,
    );
  }

  private claimAuthority(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
    clearMatchIds: boolean,
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

    const generationChanged =
      route.resolutionGeneration !== resolutionGeneration;
    if (generationChanged) {
      route.resolutionGeneration = resolutionGeneration;
    }
    if (generationChanged || clearMatchIds) {
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
    this.markMutated();
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
    this.markMutated();
  }

  private createDeferredRegistration(
    status: Exclude<ReplyRouteRegistrationStatus, "collision">,
    apply: () => boolean,
  ): ReplyRouteRegistration {
    const expectedRevision = this.revision;
    let settled = false;
    return {
      status,
      commit: () => {
        if (settled) {
          return false;
        }
        settled = true;
        return this.revision === expectedRevision && apply();
      },
      rollback: () => {
        settled = true;
      },
    };
  }

  private createSettledRegistration(
    status: "collision",
  ): ReplyRouteRegistration {
    return { status, commit: () => false, rollback() {} };
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

  private touchClientRoute(
    connectionId: string,
    sessionId: string,
    inspectMessageId: string,
  ): void {
    const clientRoutes = this.getClientRoutes(connectionId);
    const key = this.routeKey(sessionId, inspectMessageId);
    clientRoutes.delete(key);
    clientRoutes.set(key, undefined);
    this.markMutated();
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
    this.markMutated();
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

  private markMutated(): void {
    this.revision += 1;
  }
}
