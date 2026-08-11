import type { DomTreeController } from "./domTreeController.js";
import type {
  DomGetRootRequest,
  DomResolveLocatorRequest,
  DomResponse,
  DomSelectionChangedEvent,
} from "./domProtocol.js";
import {
  locatorDepth,
  type DomStableLocator,
} from "./domStableLocator.js";
import {
  classifyDomTreeRecoveryError,
  DomTreeRecoveryFatalError,
} from "./domTreeRecoveryError.js";

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
      const focusAnchor = snapshot.focusAnchor;
      const focusKey = focusAnchor
        ? locatorKey(focusAnchor.locator)
        : undefined;
      let focusAttempted = focusKey === locatorKey(rootResponse.node.locator);
      if (snapshot.selectedLocator) {
        const selected = await this.resolveLocator(
          snapshot.selectedLocator,
          rootResponse.documentEpoch,
          rootResponse.node.nodeRef,
          token,
          contentSessionGeneration,
        );
        if (!this.isCurrent(token, contentSessionGeneration)) {
          return;
        }
        if (selected) {
          this.controller.installRecoveredPath(selected, {
            selected: true,
            expanded: snapshot.selectedWasExpanded,
            ...(focusKey === locatorKey(snapshot.selectedLocator) && focusAnchor
              ? { focusIntent: focusAnchor.rowType }
              : {}),
          });
          selectedNodeRef = selected.node.nodeRef;
        }
        if (focusKey === locatorKey(snapshot.selectedLocator)) {
          focusAttempted = true;
        }
      }

      const selectedKey = snapshot.selectedLocator
        ? locatorKey(snapshot.selectedLocator)
        : undefined;
      for (const stableLocator of orderedUniqueLocators(
        snapshot.expandedLocators,
      )) {
        const stableLocatorKey = locatorKey(stableLocator);
        if (stableLocatorKey === selectedKey) {
          continue;
        }
        const expanded = await this.resolveLocator(
          stableLocator,
          rootResponse.documentEpoch,
          rootResponse.node.nodeRef,
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
            ...(stableLocatorKey === focusKey && focusAnchor
              ? { focusIntent: focusAnchor.rowType }
              : {}),
          });
        }
        if (stableLocatorKey === focusKey) {
          focusAttempted = true;
        }
      }

      if (focusAnchor && !focusAttempted) {
        const focused = await this.resolveLocator(
          focusAnchor.locator,
          rootResponse.documentEpoch,
          rootResponse.node.nodeRef,
          token,
          contentSessionGeneration,
        );
        if (!this.isCurrent(token, contentSessionGeneration)) {
          return;
        }
        if (focused) {
          this.controller.installRecoveredPath(focused, {
            selected: false,
            expanded: focusAnchor.rowType === "load-more",
            focusIntent: focusAnchor.rowType,
          });
        }
      }

      await this.controller.hydrateRecoveredBranches();
      if (!this.isCurrent(token, contentSessionGeneration)) {
        return;
      }
      this.controller.finishRecovery();
      if (!this.isCurrent(token, contentSessionGeneration)) {
        return;
      }
      if (
        selectedNodeRef &&
        this.ownsRecoveredSelection(selectedNodeRef, rootResponse.documentEpoch)
      ) {
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
      if (error instanceof DomTreeRecoveryFatalError) {
        return;
      }
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
    rootRef: string,
    token: object,
    contentSessionGeneration: number,
  ) {
    const request: DomResolveLocatorRequest = {
      type: "dom.resolveLocator",
      requestId: this.createRequestId(),
      locator: stableLocator,
    };
    const response = await this.transport.request(request);
    if (!this.isCurrent(token, contentSessionGeneration)) {
      return undefined;
    }
    if (response.type === "dom.error") {
      if (
        response.requestId !== request.requestId ||
        (response.documentEpoch !== undefined &&
          response.documentEpoch !== documentEpoch)
      ) {
        throw new DomTreeRecoveryFatalError(
          "locator",
          "DOM recovery locator response lost session ownership",
          response.code,
        );
      }
      if (classifyDomTreeRecoveryError("locator", response.code) === "partial") {
        return undefined;
      }
      throw new DomTreeRecoveryFatalError(
        "locator",
        `DOM recovery locator failed: ${response.code}`,
        response.code,
      );
    }
    if (
      response.type !== "dom.locator" ||
      response.requestId !== request.requestId ||
      response.documentEpoch !== documentEpoch ||
      locatorKey(response.node.locator) !== locatorKey(stableLocator) ||
      response.ancestorPath.length === 0 ||
      response.ancestorPath[0]?.nodeRef !== rootRef ||
      response.ancestorPath.at(-1)?.nodeRef !== response.node.nodeRef
    ) {
      throw new DomTreeRecoveryFatalError(
        "locator",
        "DOM recovery locator response lost session ownership",
      );
    }
    return response;
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

  private ownsRecoveredSelection(
    nodeRef: string,
    documentEpoch: number,
  ): boolean {
    const snapshot = this.controller.snapshot();
    return !snapshot.recovering &&
      snapshot.documentEpoch === documentEpoch &&
      snapshot.selectedRef === nodeRef &&
      this.controller.rows().some((row) => (
        row.type === "node" && row.nodeRef === nodeRef && row.selected
      ));
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

function locatorKey(locator: DomStableLocator): string {
  return JSON.stringify(locator);
}
