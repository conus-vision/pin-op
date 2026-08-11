import type { DomTreeController } from "./domTreeController.js";
import type {
  DomGetRootRequest,
  DomResolveLocatorRequest,
  DomResponse,
  DomSelectionChangedEvent,
} from "./domProtocol.js";
import type { DomStableLocator } from "./domStableLocator.js";

export interface DomTreeRecoveryTransport {
  request(
    request: DomGetRootRequest | DomResolveLocatorRequest,
  ): Promise<DomResponse>;
}

export interface DomTreeRecoveryCoordinatorOptions {
  readonly controller: DomTreeController;
  readonly transport: DomTreeRecoveryTransport;
  readonly createRequestId?: () => string;
}

export class DomTreeRecoveryCoordinator {
  private readonly controller: DomTreeController;
  private readonly transport: DomTreeRecoveryTransport;
  private readonly createRequestId: () => string;
  private recoveryToken: object | undefined;
  private contentSessionGeneration = 0;
  private requestSequence = 0;
  private disposed = false;

  public constructor(options: DomTreeRecoveryCoordinatorOptions) {
    this.controller = options.controller;
    this.transport = options.transport;
    this.createRequestId = options.createRequestId ?? (() => (
      `dom-recovery-${++this.requestSequence}`
    ));
  }

  public async begin(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const token = {};
    this.recoveryToken = token;
    const contentSessionGeneration = ++this.contentSessionGeneration;
    const snapshot = this.controller.beginRecovery();
    const rootRequest: DomGetRootRequest = {
      type: "dom.getRoot",
      requestId: this.createRequestId(),
    };

    try {
      const rootResponse = await this.transport.request(rootRequest);
      if (!this.isCurrent(token, contentSessionGeneration)) {
        return;
      }
      if (
        rootResponse.type !== "dom.root" ||
        rootResponse.requestId !== rootRequest.requestId
      ) {
        this.abortCurrent(
          token,
          contentSessionGeneration,
          "DOM recovery root failed",
        );
        return;
      }
      this.controller.installRecoveryRoot(rootResponse);

      let selectedNodeRef: string | undefined;
      if (snapshot.selectedLocator) {
        const selected = await this.resolveLocator(
          snapshot.selectedLocator,
          rootResponse.documentEpoch,
          token,
          contentSessionGeneration,
        );
        if (!this.isCurrent(token, contentSessionGeneration)) {
          return;
        }
        if (selected) {
          this.controller.installRecoveredPath(selected, {
            selected: true,
            expanded: false,
          });
          selectedNodeRef = selected.node.nodeRef;
        }
      }

      const selectedKey = snapshot.selectedLocator
        ? locatorKey(snapshot.selectedLocator)
        : undefined;
      for (const stableLocator of orderedUniqueLocators(
        snapshot.expandedLocators,
      )) {
        if (locatorKey(stableLocator) === selectedKey) {
          continue;
        }
        const expanded = await this.resolveLocator(
          stableLocator,
          rootResponse.documentEpoch,
          token,
          contentSessionGeneration,
        );
        if (!this.isCurrent(token, contentSessionGeneration)) {
          return;
        }
        if (expanded) {
          this.controller.installRecoveredPath(expanded, {
            selected: false,
            expanded: true,
          });
        }
      }

      await this.controller.hydrateRecoveredBranches();
      if (!this.isCurrent(token, contentSessionGeneration)) {
        return;
      }
      this.controller.finishRecovery();
      if (selectedNodeRef) {
        await this.controller.select(selectedNodeRef);
      }
      if (this.isCurrent(token, contentSessionGeneration)) {
        this.recoveryToken = undefined;
      }
    } catch (error) {
      if (!this.isCurrent(token, contentSessionGeneration)) {
        return;
      }
      this.abortCurrent(
        token,
        contentSessionGeneration,
        "DOM recovery failed",
      );
      throw error;
    }
  }

  public handleManualSelection(_event: DomSelectionChangedEvent): void {
    if (this.disposed || !this.recoveryToken) {
      return;
    }
    this.invalidateAttempt();
    this.controller.cancelRecovery("Manual DOM selection replaced recovery");
  }

  public cancel(reason: string): void {
    if (this.disposed) {
      return;
    }
    const wasRecovering = Boolean(this.recoveryToken) ||
      this.controller.snapshot().recovering;
    this.invalidateAttempt();
    if (wasRecovering) {
      this.controller.cancelRecovery(reason);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancel("DOM tree recovery disposed");
    this.disposed = true;
  }

  private async resolveLocator(
    stableLocator: DomStableLocator,
    documentEpoch: number,
    token: object,
    contentSessionGeneration: number,
  ) {
    const request: DomResolveLocatorRequest = {
      type: "dom.resolveLocator",
      requestId: this.createRequestId(),
      locator: stableLocator,
    };
    let response: DomResponse;
    try {
      response = await this.transport.request(request);
    } catch {
      return undefined;
    }
    if (!this.isCurrent(token, contentSessionGeneration)) {
      return undefined;
    }
    return response.type === "dom.locator" &&
        response.requestId === request.requestId &&
        response.documentEpoch === documentEpoch &&
        locatorKey(response.node.locator) === locatorKey(stableLocator)
      ? response
      : undefined;
  }

  private abortCurrent(
    token: object,
    contentSessionGeneration: number,
    reason: string,
  ): void {
    if (!this.isCurrent(token, contentSessionGeneration)) {
      return;
    }
    this.invalidateAttempt();
    this.controller.cancelRecovery(reason);
  }

  private invalidateAttempt(): void {
    this.recoveryToken = undefined;
    this.contentSessionGeneration += 1;
  }

  private isCurrent(
    token: object,
    contentSessionGeneration: number,
  ): boolean {
    return !this.disposed &&
      this.recoveryToken === token &&
      this.contentSessionGeneration === contentSessionGeneration;
  }
}

function orderedUniqueLocators(
  locators: readonly DomStableLocator[],
): readonly DomStableLocator[] {
  const seen = new Set<string>();
  return [...locators]
    .map((stableLocator, index) => ({
      stableLocator,
      index,
      depth: locatorDepth(stableLocator),
    }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .filter(({ stableLocator }) => {
      const key = locatorKey(stableLocator);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(({ stableLocator }) => stableLocator);
}

function locatorDepth(locator: DomStableLocator): number {
  return locator.path.length + locator.boundaries.reduce(
    (total, boundary) => total + boundary.hostPath.length,
    0,
  );
}

function locatorKey(locator: DomStableLocator): string {
  return JSON.stringify(locator);
}
