export type ReplyRouteRegistrationStatus =
  | "created"
  | "refreshed"
  | "collision";

export interface ReplyRouteRegistration {
  readonly status: ReplyRouteRegistrationStatus;
  commit(): boolean;
  rollback(): void;
}

export interface RuleSourceAuthority {
  readonly ruleRef: string;
  readonly openAuthorityId: string;
}

export interface RulesSourcesPreparation {
  commit(): boolean;
  rollback(): void;
}

export interface ReplyRoute {
  readonly sessionId: string;
  readonly inspectMessageId: string;
  readonly originConnectionId: string;
  readonly expectedRuleRefs: ReadonlySet<string>;
  readonly ideConnectionId?: string;
  readonly resolutionGeneration?: number;
  readonly resolutionClaimed: boolean;
  readonly matchIds: ReadonlySet<string>;
  readonly rulesGeneration?: number;
  readonly ruleOpenAuthorityIds: ReadonlySet<string>;
}

type Route = StoredReplyRoute & {
  readonly sessionId: string;
  readonly inspectMessageId: string;
};

interface StoredReplyRoute {
  readonly originConnectionId: string;
  readonly expectedRuleRefs: ReadonlySet<string>;
  ideConnectionId?: string;
  resolutionGeneration?: number;
  resolutionClaimed: boolean;
  excerptMatchIds: Set<string>;
  rulesGeneration?: number;
  ruleOpenAuthorityIds: Set<string>;
}

export interface ReplyRouteRegistryOptions {
  readonly maxRoutesPerClient?: number;
}

export class ReplyRouteRegistry {
  private readonly maxRoutesPerClient: number;
  private readonly routes = new Map<string, Map<string, StoredReplyRoute>>();
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
    expectedRuleRefs: Iterable<string> = [],
  ): ReplyRouteRegistration {
    const proposedExpectedRuleRefs = new Set(expectedRuleRefs);
    const currentRoute = this.routes.get(sessionId)?.get(inspectMessageId);
    if (currentRoute !== undefined) {
      if (
        currentRoute.originConnectionId !== connectionId ||
        !setsEqual(currentRoute.expectedRuleRefs, proposedExpectedRuleRefs)
      ) {
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
        this.routes.get(sessionId) ?? new Map<string, StoredReplyRoute>();
      sessionRoutes.set(inspectMessageId, {
        originConnectionId: connectionId,
        expectedRuleRefs: proposedExpectedRuleRefs,
        resolutionClaimed: false,
        excerptMatchIds: new Set(),
        ruleOpenAuthorityIds: new Set(),
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
      true,
    );
  }

  claimSourceInvalidation(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
  ): ReplyRoute | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (!route) {
      return undefined;
    }
    if (route.ideConnectionId === undefined) {
      route.excerptMatchIds = new Set();
      this.touchClientRoute(
        route.originConnectionId,
        sessionId,
        inspectMessageId,
      );
      return this.snapshot(sessionId, inspectMessageId, route);
    }
    return this.claimAuthority(
      sessionId,
      inspectMessageId,
      ideConnectionId,
      resolutionGeneration,
      false,
    );
  }

  private claimAuthority(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    resolutionGeneration: number,
    resolutionClaimed: boolean,
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
    route.excerptMatchIds = new Set();
    route.resolutionClaimed = resolutionClaimed;

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
      route.resolutionGeneration !== resolutionGeneration ||
      !route.resolutionClaimed
    ) {
      return undefined;
    }

    route.excerptMatchIds = new Set(matchIds);
    this.touchClientRoute(
      route.originConnectionId,
      sessionId,
      inspectMessageId,
    );
    return this.snapshot(sessionId, inspectMessageId, route);
  }

  prepareRulesSources(
    sessionId: string,
    inspectMessageId: string,
    ideConnectionId: string,
    rulesGeneration: number,
    sources: Iterable<RuleSourceAuthority>,
    unresolvedRuleCount: number,
  ): RulesSourcesPreparation | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (
      !route ||
      (route.ideConnectionId !== undefined &&
        route.ideConnectionId !== ideConnectionId) ||
      !Number.isInteger(rulesGeneration) ||
      !Number.isInteger(unresolvedRuleCount) ||
      unresolvedRuleCount < 0 ||
      (route.rulesGeneration === undefined
        ? rulesGeneration !== 1
        : rulesGeneration <= route.rulesGeneration)
    ) {
      return undefined;
    }

    const expectedRevision = this.revision;
    const publishedRuleRefs = new Set<string>();
    const proposedAuthorityIds = new Set<string>();
    let sourceCount = 0;
    for (const source of sources) {
      sourceCount += 1;
      if (
        !route.expectedRuleRefs.has(source.ruleRef) ||
        publishedRuleRefs.has(source.ruleRef) ||
        source.openAuthorityId.length === 0 ||
        proposedAuthorityIds.has(source.openAuthorityId)
      ) {
        return undefined;
      }
      publishedRuleRefs.add(source.ruleRef);
      proposedAuthorityIds.add(source.openAuthorityId);
    }
    if (sourceCount + unresolvedRuleCount !== route.expectedRuleRefs.size) {
      return undefined;
    }

    const expectedRulesGeneration = route.rulesGeneration;
    let settled = false;
    return {
      commit: () => {
        if (settled) {
          return false;
        }
        settled = true;
        const currentRoute = this.routes
          .get(sessionId)
          ?.get(inspectMessageId);
        if (
          this.revision !== expectedRevision ||
          currentRoute !== route ||
          currentRoute.rulesGeneration !== expectedRulesGeneration ||
          (currentRoute.ideConnectionId !== undefined &&
            currentRoute.ideConnectionId !== ideConnectionId)
        ) {
          return false;
        }

        if (currentRoute.ideConnectionId === undefined) {
          currentRoute.ideConnectionId = ideConnectionId;
          this.getIdeRoutes(ideConnectionId).add(
            this.routeKey(sessionId, inspectMessageId),
          );
        }
        currentRoute.rulesGeneration = rulesGeneration;
        currentRoute.ruleOpenAuthorityIds = proposedAuthorityIds;
        this.touchClientRoute(
          currentRoute.originConnectionId,
          sessionId,
          inspectMessageId,
        );
        return true;
      },
      rollback: () => {
        settled = true;
      },
    };
  }

  authorizeRulesOpen(
    sessionId: string,
    inspectMessageId: string,
    originConnectionId: string,
    rulesGeneration: number,
    openAuthorityId: string,
  ): ReplyRoute | undefined {
    const route = this.routes.get(sessionId)?.get(inspectMessageId);
    if (
      !route ||
      route.originConnectionId !== originConnectionId ||
      route.ideConnectionId === undefined ||
      route.rulesGeneration !== rulesGeneration ||
      !route.ruleOpenAuthorityIds.has(openAuthorityId)
    ) {
      return undefined;
    }

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
    route: StoredReplyRoute,
  ): ReplyRoute {
    return {
      sessionId,
      inspectMessageId,
      originConnectionId: route.originConnectionId,
      expectedRuleRefs: new Set(route.expectedRuleRefs),
      ideConnectionId: route.ideConnectionId,
      resolutionGeneration: route.resolutionGeneration,
      resolutionClaimed: route.resolutionClaimed,
      matchIds: new Set(route.excerptMatchIds),
      rulesGeneration: route.rulesGeneration,
      ruleOpenAuthorityIds: new Set(route.ruleOpenAuthorityIds),
    };
  }

  private routeKey(sessionId: string, inspectMessageId: string): string {
    return JSON.stringify([sessionId, inspectMessageId]);
  }

  private markMutated(): void {
    this.revision += 1;
  }
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
