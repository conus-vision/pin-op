import {
  DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  type DomErrorCode,
  type DomEvent,
  type DomGetChildrenRequest,
  type DomGetRootRequest,
  type DomLocatorResponse,
  type DomNodeView,
  type DomRequest,
  type DomResponse,
  type DomRootResponse,
} from "./domProtocol.js";
import {
  DOM_TREE_RECOVERY_MAX_EXPANDED,
  locatorDepth,
  type DomStableLocator,
} from "./domStableLocator.js";
import {
  classifyDomTreeRecoveryError,
  DomTreeRecoveryFatalError,
} from "./domTreeRecoveryError.js";
import {
  virtualTreeRows,
  type VirtualTreeRow,
  type VirtualViewport,
} from "./virtualTreeRows.js";

export type DomTreeKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Enter";

export interface DomTreeTransport {
  request(request: DomGetRootRequest | DomGetChildrenRequest): Promise<DomResponse>;
  dispatch(request: Exclude<DomRequest, DomGetRootRequest | DomGetChildrenRequest>): void;
  cancelPending(reason: string): void;
}

export interface DomTreeControllerOptions {
  readonly transport: DomTreeTransport;
  readonly onChange?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly createRequestId?: () => string;
}

export interface DomTreeRecoverySnapshot {
  readonly selectedLocator?: DomStableLocator;
  readonly selectedWasExpanded: boolean;
  readonly focusAnchor?: DomTreeRecoveryFocusAnchor;
  readonly expandedLocators: readonly DomStableLocator[];
}

export type DomTreeRecoveryFocusRowType = "node" | "load-more";

export interface DomTreeRecoveryFocusAnchor {
  readonly locator: DomStableLocator;
  readonly rowType: DomTreeRecoveryFocusRowType;
}

interface DomTreeNodeRow {
  readonly type: "node";
  readonly node: DomNodeView;
  readonly nodeRef: string;
  readonly parentRef?: string;
  readonly label: string;
  readonly kind: DomNodeView["kind"];
  readonly depth: number;
  readonly expandable: boolean;
  readonly selectable: boolean;
  readonly inaccessible: boolean;
  readonly branchRevision: number;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
}

interface DomTreeLoadMoreRow {
  readonly type: "load-more";
  readonly nodeRef: string;
  readonly parentRef: string;
  readonly label: string;
  readonly kind: "load-more";
  readonly depth: number;
  readonly expandable: false;
  readonly selectable: false;
  readonly inaccessible: false;
  readonly branchRevision: number;
  readonly expanded: false;
  readonly loading: boolean;
  readonly selected: false;
  readonly focused: boolean;
  readonly hovered: false;
}

export type DomTreeRow = DomTreeNodeRow | DomTreeLoadMoreRow;

export interface DomTreeSnapshot {
  readonly documentEpoch?: number;
  readonly selectedRef?: string;
  readonly focusedRef?: string;
  readonly recoveredFocusRef?: string;
  readonly hoveredRef?: string;
  readonly hoverSummary?: string;
  readonly revealRef?: string;
  readonly revealVersion: number;
  readonly loadingRoot: boolean;
  readonly recovering: boolean;
  readonly errorCode?: DomErrorCode;
  readonly totalRows: number;
}

interface NodeState {
  view: DomNodeView;
  parentRef?: string;
}

interface BranchState {
  readonly children: string[];
  readonly recoveredChildren: string[];
  revealChild?: string;
  revision: number;
  loaded: boolean;
  nextCursor?: string;
  pending?: PendingBranchRequest;
}

interface PendingBranchRequest {
  readonly token: object;
  readonly revision: number;
  readonly cursor?: string;
  readonly reconciliationBatchId?: number;
  readonly promise: Promise<void>;
}

interface ReconciliationBatchState {
  readonly pendingTokens: Set<object>;
  readonly candidates: Set<string>;
  readonly candidateLimit: number;
  readonly focusAnchor: FocusAnchor;
}

interface FocusAnchor {
  readonly index: number;
}

const LOAD_MORE_PREFIX = "pin-op:load-more:";

export class DomTreeController {
  private readonly transport: DomTreeTransport;
  private readonly listeners = new Set<() => void>();
  private readonly onError: (error: unknown) => void;
  private readonly createRequestId: () => string;
  private readonly nodes = new Map<string, NodeState>();
  private readonly branches = new Map<string, BranchState>();
  private readonly expanded = new Set<string>();
  private readonly reconciliationBatches = new Map<
    number,
    ReconciliationBatchState
  >();
  private revealPathRefs: readonly string[] = Object.freeze([]);
  private rowsCache: readonly DomTreeRow[] | undefined;
  private rootRef: string | undefined;
  private rootPrologue: readonly DomNodeView[] = Object.freeze([]);
  private rootEpilogue: readonly DomNodeView[] = Object.freeze([]);
  private rootSnapshotRevision: number | undefined;
  private rootSnapshotError: DomErrorCode | undefined;
  private selectedNodeRef: string | undefined;
  private focusedNodeRef: string | undefined;
  private hoveredNodeRef: string | undefined;
  private lastHoverRequest: string | null | undefined;
  private currentHoverSummary: string | undefined;
  private currentRevealRef: string | undefined;
  private currentRevealVersion = 0;
  private currentError: DomErrorCode | undefined;
  private currentDocumentEpoch: number | undefined;
  private rootRequest: { readonly token: object; readonly promise: Promise<void> } | undefined;
  private frozenRows: readonly DomTreeRow[] | undefined;
  private recoverySnapshot: DomTreeRecoverySnapshot | undefined;
  private recoveryFocusRef: string | undefined;
  private recoveryFocusRowType: DomTreeRecoveryFocusRowType | undefined;
  private recoveredFocusRef: string | undefined;
  private recovering = false;
  private generation = 0;
  private reconciliationBatchSequence = 0;
  private requestSequence = 0;
  private disposed = false;

  public constructor(options: DomTreeControllerOptions) {
    this.transport = options.transport;
    if (options.onChange) {
      this.listeners.add(options.onChange);
    }
    this.onError = options.onError ?? (() => undefined);
    this.createRequestId = options.createRequestId ?? (() => (
      `dom-tree-${++this.requestSequence}`
    ));
  }

  public get documentEpoch(): number | undefined {
    return this.currentDocumentEpoch;
  }

  public get focusedRef(): string | undefined {
    return this.recovering
      ? this.frozenRows?.find((row) => row.focused)?.nodeRef
      : this.focusedNodeRef;
  }

  public snapshot(): DomTreeSnapshot {
    const rows = this.rows();
    const visibleError = this.rootSnapshotError ?? this.currentError;
    const visibleSelectedRef = this.recovering
      ? rows.find((row) => row.selected)?.nodeRef
      : this.selectedNodeRef;
    const visibleFocusedRef = this.recovering
      ? rows.find((row) => row.focused)?.nodeRef
      : this.focusedNodeRef;
    const visibleHoveredRef = this.recovering
      ? rows.find((row) => row.hovered)?.nodeRef
      : this.hoveredNodeRef;
    return Object.freeze({
      ...(this.currentDocumentEpoch === undefined
        ? {}
        : { documentEpoch: this.currentDocumentEpoch }),
      ...(visibleSelectedRef === undefined
        ? {}
        : { selectedRef: visibleSelectedRef }),
      ...(visibleFocusedRef === undefined
        ? {}
        : { focusedRef: visibleFocusedRef }),
      ...(this.recoveredFocusRef === undefined
        ? {}
        : { recoveredFocusRef: this.recoveredFocusRef }),
      ...(visibleHoveredRef === undefined
        ? {}
        : { hoveredRef: visibleHoveredRef }),
      ...(this.currentHoverSummary === undefined
        ? {}
        : { hoverSummary: this.currentHoverSummary }),
      ...(this.currentRevealRef === undefined
        ? {}
        : { revealRef: this.currentRevealRef }),
      revealVersion: this.currentRevealVersion,
      loadingRoot: Boolean(this.rootRequest),
      recovering: this.recovering,
      ...(visibleError === undefined
        ? {}
        : { errorCode: visibleError }),
      totalRows: rows.length,
    });
  }

  public rows(): readonly DomTreeRow[] {
    if (this.frozenRows) {
      return this.frozenRows;
    }
    if (this.rowsCache) {
      return this.rowsCache;
    }
    if (!this.rootRef || !this.nodes.has(this.rootRef)) {
      this.rowsCache = Object.freeze([]);
      return this.rowsCache;
    }
    const result: DomTreeRow[] = [];
    for (const node of this.rootPrologue) {
      this.appendAuxiliaryRow(node, result);
    }
    this.appendRows(this.rootRef, undefined, 1, result, new Set());
    for (const node of this.rootEpilogue) {
      this.appendAuxiliaryRow(node, result);
    }
    this.rowsCache = Object.freeze(result);
    return this.rowsCache;
  }

  public visibleRows(
    viewport: VirtualViewport,
  ): readonly VirtualTreeRow<DomTreeRow>[] {
    return virtualTreeRows(this.rows(), viewport);
  }

  public expandedRefs(): readonly string[] {
    return Object.freeze([...this.expanded]);
  }

  public subscribe(listener: () => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public isExpanded(nodeRef: string): boolean {
    return this.expanded.has(nodeRef);
  }

  public beginRecovery(): DomTreeRecoverySnapshot {
    if (this.disposed) {
      return emptyRecoverySnapshot();
    }
    const alreadyRecovering = this.recovering;
    if (!alreadyRecovering) {
      this.frozenRows = this.rows();
      this.recoverySnapshot = this.captureRecoverySnapshot();
    }
    const snapshot = this.recoverySnapshot ?? emptyRecoverySnapshot();
    this.cancelPending("DOM tree recovery started");
    this.generation += 1;
    this.clearLiveState(undefined);
    this.recovering = true;
    if (!alreadyRecovering) {
      this.notify();
    }
    return snapshot;
  }

  public installRecoveryRoot(response: DomRootResponse): void {
    if (this.disposed || !this.recovering) {
      return;
    }
    this.currentDocumentEpoch = response.documentEpoch;
    this.currentError = undefined;
    this.rootSnapshotError = undefined;
    this.rootRef = response.node.nodeRef;
    this.rootPrologue = Object.freeze([...response.prologue]);
    this.rootEpilogue = Object.freeze([...response.epilogue]);
    this.rootSnapshotRevision = response.node.branchRevision;
    this.upsertNode(response.node, undefined);
    this.focusedNodeRef = response.node.nodeRef;
    const focusAnchor = this.recoverySnapshot?.focusAnchor;
    if (
      focusAnchor &&
      response.node.locator &&
      locatorKey(focusAnchor.locator) === locatorKey(response.node.locator)
    ) {
      this.recoveryFocusRef = response.node.nodeRef;
      this.recoveryFocusRowType = focusAnchor.rowType;
    }
    this.invalidateRows();
  }

  public installRecoveredPath(
    response: DomLocatorResponse,
    options: {
      readonly selected: boolean;
      readonly expanded: boolean;
      readonly focusIntent?: DomTreeRecoveryFocusRowType;
    },
  ): void {
    if (
      this.disposed ||
      !this.recovering ||
      response.documentEpoch !== this.currentDocumentEpoch ||
      response.ancestorPath.length === 0 ||
      response.ancestorPath[0]?.nodeRef !== this.rootRef ||
      !isRecoverableLocatorResponse(response) ||
      (options.selected && !isSelectableElementView(response.node))
    ) {
      return;
    }

    let parentRef: string | undefined;
    for (const [index, view] of response.ancestorPath.entries()) {
      this.upsertNode(view, parentRef);
      if (parentRef) {
        const parent = this.nodes.get(parentRef);
        if (parent) {
          const branch = this.branchFor(parent.view);
          if (!branch.recoveredChildren.includes(view.nodeRef)) {
            branch.recoveredChildren.push(view.nodeRef);
          }
          if (options.selected) {
            branch.revealChild = view.nodeRef;
          }
        }
      }
      if (
        (options.selected || options.focusIntent) &&
        index < response.ancestorPath.length - 1
      ) {
        this.expanded.add(view.nodeRef);
      }
      parentRef = view.nodeRef;
    }

    if (options.expanded && response.node.expandable && !response.node.inaccessible) {
      this.expanded.add(response.node.nodeRef);
    }
    if (options.selected) {
      this.revealPathRefs = Object.freeze(
        response.ancestorPath.map((view) => view.nodeRef),
      );
      this.selectedNodeRef = response.node.nodeRef;
      this.currentRevealRef = response.node.nodeRef;
      this.currentRevealVersion += 1;
    }
    if (options.focusIntent) {
      this.recoveryFocusRef = response.node.nodeRef;
      this.recoveryFocusRowType = options.focusIntent;
    }
    this.currentError = undefined;
    this.invalidateRows();
  }

  public async hydrateRecoveredBranches(): Promise<void> {
    if (this.disposed || !this.recovering) {
      return;
    }
    const generation = this.generation;
    const expandedRefs = [...this.expanded].sort((left, right) => (
      this.nodeDepth(left) - this.nodeDepth(right)
    ));
    for (const nodeRef of expandedRefs) {
      if (!this.isCurrentRecovery(generation)) {
        return;
      }
      await this.fetchRecoveryChildren(nodeRef, generation);
    }
  }

  public finishRecovery(): void {
    if (this.disposed || !this.recovering) {
      return;
    }
    this.commitRecoveredChildren();
    this.recoveredFocusRef = this.restoreRecoveryFocus();
    this.recovering = false;
    this.frozenRows = undefined;
    this.recoverySnapshot = undefined;
    this.recoveryFocusRef = undefined;
    this.recoveryFocusRowType = undefined;
    this.invalidateRows();
    this.notify();
  }

  public cancelRecovery(reason: string): void {
    if (this.disposed || !this.recovering) {
      return;
    }
    this.cancelPending(reason);
    this.generation += 1;
    this.recovering = false;
    this.frozenRows = undefined;
    this.recoverySnapshot = undefined;
    this.clearLiveState(undefined);
    this.notify();
  }

  public async loadRoot(): Promise<void> {
    if (this.disposed || this.recovering) {
      return;
    }
    if (this.rootRef && this.currentDocumentEpoch !== undefined) {
      return;
    }
    if (this.rootRequest) {
      return this.rootRequest.promise;
    }
    const generation = this.generation;
    const expectedEpoch = this.currentDocumentEpoch;
    const token = {};
    const request: DomGetRootRequest = {
      type: "dom.getRoot",
      requestId: this.createRequestId(),
      ...(expectedEpoch === undefined ? {} : { documentEpoch: expectedEpoch }),
    };
    const pendingTask = createPendingTask();
    const promise = pendingTask.promise;
    this.rootRequest = { token, promise };
    const task = (async (): Promise<void> => {
      try {
        const response = await this.transport.request(request);
        if (!this.isCurrent(generation) || this.rootRequest?.token !== token) {
          return;
        }
        if (response.type === "dom.error") {
          this.applyError(response.code);
          return;
        }
        if (
          response.type !== "dom.root" ||
          response.requestId !== request.requestId ||
          (expectedEpoch !== undefined && response.documentEpoch !== expectedEpoch)
        ) {
          return;
        }
        if (this.currentDocumentEpoch === undefined) {
          this.currentDocumentEpoch = response.documentEpoch;
        }
        this.currentError = undefined;
        this.rootSnapshotError = undefined;
        this.rootRef = response.node.nodeRef;
        this.rootPrologue = Object.freeze([...response.prologue]);
        this.rootEpilogue = Object.freeze([...response.epilogue]);
        this.rootSnapshotRevision = response.node.branchRevision;
        this.upsertNode(response.node, undefined);
        if (!this.focusedNodeRef) {
          this.focusedNodeRef = response.node.nodeRef;
        }
      } catch (error) {
        if (this.isCurrent(generation)) {
          this.reportError(error);
        }
      } finally {
        if (this.rootRequest?.token === token) {
          this.rootRequest = undefined;
          this.notify();
        }
      }
    })();
    void task.then(pendingTask.resolve, pendingTask.reject);
    this.notify();
    return promise;
  }

  public async expand(nodeRef: string): Promise<void> {
    if (this.disposed || this.recovering) {
      return;
    }
    const state = this.nodes.get(nodeRef);
    if (!state || !state.view.expandable || state.view.inaccessible) {
      return;
    }
    if (!this.expanded.has(nodeRef)) {
      this.expanded.add(nodeRef);
      this.notify();
    }
    const branch = this.branchFor(state.view);
    if (!branch.loaded && !branch.pending) {
      await this.fetchChildren(nodeRef, undefined);
    }
  }

  public collapse(nodeRef: string): void {
    if (this.disposed || this.recovering || !this.expanded.has(nodeRef)) {
      return;
    }
    const previousRows = this.rows();
    const focusAnchor = this.focusAnchor(previousRows);
    const focusedWasDescendant = this.isDescendantRow(
      previousRows,
      nodeRef,
      this.focusedNodeRef,
    );
    this.expanded.delete(nodeRef);
    this.invalidateRows();
    if (focusedWasDescendant) {
      this.focusedNodeRef = nodeRef;
    } else {
      this.reconcileFocus(focusAnchor);
    }
    this.notify();
  }

  public async toggle(nodeRef: string): Promise<void> {
    if (this.disposed || this.recovering) {
      return;
    }
    if (this.expanded.has(nodeRef)) {
      this.collapse(nodeRef);
      return;
    }
    await this.expand(nodeRef);
  }

  public async loadMore(parentRef: string): Promise<void> {
    if (this.disposed || this.recovering) {
      return;
    }
    const node = this.nodes.get(parentRef);
    const branch = this.branches.get(parentRef);
    if (!node || !node.view.expandable || node.view.inaccessible) {
      return;
    }
    if (!branch?.loaded) {
      await this.fetchChildren(parentRef, undefined);
      return;
    }
    if (branch.nextCursor) {
      await this.fetchChildren(parentRef, branch.nextCursor);
    }
  }

  public focus(nodeRef: string): void {
    if (this.disposed || this.recovering || !this.isVisibleRef(nodeRef)) {
      return;
    }
    this.recoveredFocusRef = undefined;
    this.focusedNodeRef = nodeRef;
    this.notify();
  }

  public async select(nodeRef: string): Promise<void> {
    if (
      this.disposed ||
      this.recovering ||
      this.currentDocumentEpoch === undefined
    ) {
      return;
    }
    const state = this.nodes.get(nodeRef);
    if (
      !state ||
      !state.view.selectable ||
      state.view.inaccessible ||
      this.isDeferredPruneNode(nodeRef)
    ) {
      return;
    }
    try {
      this.transport.dispatch({
        type: "dom.select",
        documentEpoch: this.currentDocumentEpoch,
        nodeRef,
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  public hover(nodeRef?: string): void {
    if (
      this.disposed ||
      this.recovering ||
      this.currentDocumentEpoch === undefined
    ) {
      return;
    }
    if (nodeRef === undefined) {
      this.clearHover();
      return;
    }
    const state = this.nodes.get(nodeRef);
    if (
      !state ||
      !state.view.selectable ||
      state.view.inaccessible ||
      this.isDeferredPruneNode(nodeRef)
    ) {
      return;
    }
    if (this.lastHoverRequest === nodeRef) {
      return;
    }
    try {
      this.transport.dispatch({
        type: "dom.hover",
        documentEpoch: this.currentDocumentEpoch,
        nodeRef,
      });
      this.lastHoverRequest = nodeRef;
    } catch (error) {
      this.reportError(error);
    }
  }

  public clearHover(): void {
    if (
      this.disposed ||
      this.recovering ||
      this.currentDocumentEpoch === undefined
    ) {
      return;
    }
    if (this.lastHoverRequest === null) {
      return;
    }
    try {
      this.transport.dispatch({
        type: "dom.clearHover",
        documentEpoch: this.currentDocumentEpoch,
      });
      this.lastHoverRequest = null;
    } catch (error) {
      this.reportError(error);
    }
  }

  public async handleKey(key: DomTreeKey): Promise<void> {
    if (this.disposed || this.recovering) {
      return;
    }
    const rows = this.rows();
    if (rows.length === 0) {
      return;
    }
    const currentRef = this.focusedNodeRef ?? rows[0]?.nodeRef;
    const index = rows.findIndex((row) => row.nodeRef === currentRef);
    const current = rows[index < 0 ? 0 : index];
    if (!current) {
      return;
    }

    switch (key) {
      case "ArrowUp":
        this.focusAdjacentRow(rows, index < 0 ? 0 : index, -1);
        return;
      case "ArrowDown":
        this.focusAdjacentRow(rows, index < 0 ? 0 : index, 1);
        return;
      case "ArrowLeft":
        if (current.type === "node" && current.expanded) {
          this.collapse(current.nodeRef);
        } else if (current.parentRef) {
          this.focus(current.parentRef);
        }
        return;
      case "ArrowRight":
        if (current.type === "load-more") {
          await this.loadMore(current.parentRef);
          return;
        }
        if (current.expandable && !current.expanded) {
          await this.expand(current.nodeRef);
          return;
        }
        if (current.expanded) {
          const child = rows[index + 1];
          if (child?.depth === current.depth + 1) {
            this.focusRow(child);
          }
        }
        return;
      case "Enter":
        if (current.type === "load-more") {
          await this.loadMore(current.parentRef);
        } else {
          await this.select(current.nodeRef);
        }
    }
  }

  public handleEvent(event: DomEvent): void {
    if (this.disposed || this.recovering) {
      return;
    }
    if (
      event.type === "dom.selectionChanged" &&
      !isRecoverableSelectionPath(event.nodeRef, event.ancestorPath)
    ) {
      return;
    }
    if (
      this.currentDocumentEpoch !== undefined &&
      event.documentEpoch < this.currentDocumentEpoch
    ) {
      return;
    }
    if (
      this.currentDocumentEpoch === undefined ||
      event.documentEpoch > this.currentDocumentEpoch
    ) {
      this.resetState(event.documentEpoch, "DOM document changed");
    }
    if (event.documentEpoch !== this.currentDocumentEpoch) {
      return;
    }

    switch (event.type) {
      case "dom.selectionChanged":
        this.applySelection(event.nodeRef, event.ancestorPath);
        return;
      case "dom.hoverChanged":
        this.currentHoverSummary = event.summary;
        this.lastHoverRequest = event.nodeRef ?? null;
        this.hoveredNodeRef = event.nodeRef && this.nodes.has(event.nodeRef)
          ? event.nodeRef
          : undefined;
        this.notify();
        return;
      case "dom.invalidated":
        const reconciliationBatchId = this.beginReconciliationBatch(
          event.branches.length,
        );
        for (const invalidation of event.branches) {
          this.invalidateBranch(
            invalidation.nodeRef,
            invalidation.branchRevision,
            reconciliationBatchId,
          );
        }
        this.finishReconciliationBatchIfIdle(reconciliationBatchId);
        this.notify();
    }
  }

  public reset(): void {
    if (this.disposed) {
      return;
    }
    this.resetState(undefined, "DOM session changed");
    this.notify();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancelPending("DOM tree disposed");
    this.disposed = true;
    this.generation += 1;
    this.rootRequest = undefined;
    this.frozenRows = undefined;
    this.recoverySnapshot = undefined;
    this.recovering = false;
    this.recoveredFocusRef = undefined;
    this.nodes.clear();
    this.branches.clear();
    this.expanded.clear();
    this.reconciliationBatches.clear();
    this.revealPathRefs = Object.freeze([]);
    this.rootRef = undefined;
    this.rootPrologue = Object.freeze([]);
    this.rootEpilogue = Object.freeze([]);
    this.rootSnapshotRevision = undefined;
    this.rootSnapshotError = undefined;
    this.selectedNodeRef = undefined;
    this.focusedNodeRef = undefined;
    this.hoveredNodeRef = undefined;
    this.lastHoverRequest = undefined;
    this.rowsCache = Object.freeze([]);
    this.listeners.clear();
  }

  private captureRecoverySnapshot(): DomTreeRecoverySnapshot {
    const selectedRef = this.selectedNodeRef;
    const selectedLocator = selectedRef
      ? this.nodes.get(selectedRef)?.view.locator
      : undefined;
    const focusAnchor = this.captureRecoveryFocusAnchor();
    const ordered = [...this.expanded]
      .map((nodeRef, index) => {
        const stableLocator = this.nodes.get(nodeRef)?.view.locator;
        return stableLocator
          ? { stableLocator, depth: locatorDepth(stableLocator), index }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => (
        left.depth - right.depth || left.index - right.index
      ));
    const seen = new Set<string>();
    const expandedLocators: DomStableLocator[] = [];
    for (const { stableLocator } of ordered) {
      const key = locatorKey(stableLocator);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      expandedLocators.push(stableLocator);
      if (expandedLocators.length === DOM_TREE_RECOVERY_MAX_EXPANDED) {
        break;
      }
    }
    return Object.freeze({
      ...(selectedLocator ? { selectedLocator } : {}),
      selectedWasExpanded: selectedRef !== undefined &&
        this.expanded.has(selectedRef),
      ...(focusAnchor ? { focusAnchor } : {}),
      expandedLocators: Object.freeze(expandedLocators),
    });
  }

  private captureRecoveryFocusAnchor(): DomTreeRecoveryFocusAnchor | undefined {
    const focusedRow = this.rows().find((row) => (
      row.nodeRef === this.focusedNodeRef
    ));
    if (!focusedRow) {
      return undefined;
    }
    const nodeRef = focusedRow.type === "load-more"
      ? focusedRow.parentRef
      : focusedRow.nodeRef;
    const stableLocator = this.nodes.get(nodeRef)?.view.locator;
    return stableLocator
      ? Object.freeze({
        locator: stableLocator,
        rowType: focusedRow.type,
      })
      : undefined;
  }

  private async fetchRecoveryChildren(
    nodeRef: string,
    recoveryGeneration: number,
  ): Promise<void> {
    const state = this.nodes.get(nodeRef);
    if (
      !state ||
      !state.view.expandable ||
      state.view.inaccessible ||
      this.currentDocumentEpoch === undefined ||
      !this.isCurrentRecovery(recoveryGeneration)
    ) {
      return;
    }
    const branch = this.branchFor(state.view);
    if (branch.loaded) {
      return;
    }
    if (branch.pending) {
      return branch.pending.promise;
    }
    const revision = state.view.branchRevision;
    const epoch = this.currentDocumentEpoch;
    const token = {};
    const request: DomGetChildrenRequest = {
      type: "dom.getChildren",
      requestId: this.createRequestId(),
      documentEpoch: epoch,
      nodeRef,
      branchRevision: revision,
    };
    const pendingTask = createPendingTask();
    const promise = pendingTask.promise;
    branch.pending = { token, revision, promise };
    const task = (async (): Promise<void> => {
      try {
        const response = await this.transport.request(request);
        const currentNode = this.nodes.get(nodeRef);
        const currentBranch = this.branches.get(nodeRef);
        if (
          !this.isCurrentRecovery(recoveryGeneration) ||
          !currentBranch ||
          currentBranch.pending?.token !== token ||
          this.currentDocumentEpoch !== epoch ||
          currentNode?.view.branchRevision !== revision
        ) {
          return;
        }
        if (response.type === "dom.error") {
          if (
            response.requestId !== request.requestId ||
            (response.documentEpoch !== undefined &&
              response.documentEpoch !== epoch)
          ) {
            throw new DomTreeRecoveryFatalError(
              "branch",
              "DOM recovery branch response lost session ownership",
              response.code,
            );
          }
          if (classifyDomTreeRecoveryError("branch", response.code) === "partial") {
            return;
          }
          throw new DomTreeRecoveryFatalError(
            "branch",
            `DOM recovery branch failed: ${response.code}`,
            response.code,
          );
        }
        if (
          response.type !== "dom.children" ||
          response.requestId !== request.requestId ||
          response.documentEpoch !== epoch ||
          response.nodeRef !== nodeRef ||
          response.branchRevision !== revision
        ) {
          throw new DomTreeRecoveryFatalError(
            "branch",
            "DOM recovery branch response lost session ownership",
          );
        }
        this.replacePageChildren(currentBranch, nodeRef, response.nodes);
        currentBranch.loaded = true;
        currentBranch.nextCursor = response.nextCursor;
        this.currentError = undefined;
        this.invalidateRows();
      } catch (error) {
        if (this.isCurrentRecovery(recoveryGeneration)) {
          throw error;
        }
      } finally {
        const currentBranch = this.branches.get(nodeRef);
        if (currentBranch?.pending?.token === token) {
          currentBranch.pending = undefined;
        }
      }
    })();
    void task.then(pendingTask.resolve, pendingTask.reject);
    return promise;
  }

  private nodeDepth(nodeRef: string): number {
    let depth = 0;
    let currentRef: string | undefined = nodeRef;
    const seen = new Set<string>();
    while (currentRef && !seen.has(currentRef)) {
      seen.add(currentRef);
      depth += 1;
      currentRef = this.nodes.get(currentRef)?.parentRef;
    }
    return depth;
  }

  private async fetchChildren(
    nodeRef: string,
    cursor: string | undefined,
    focusAnchorOverride?: FocusAnchor,
    reconciliationBatchId?: number,
  ): Promise<void> {
    const state = this.nodes.get(nodeRef);
    if (
      !state ||
      this.currentDocumentEpoch === undefined ||
      this.disposed ||
      this.recovering
    ) {
      return;
    }
    const branch = this.branchFor(state.view);
    if (branch.pending) {
      return branch.pending.promise;
    }
    const revision = branch.revision;
    const epoch = this.currentDocumentEpoch;
    const generation = this.generation;
    const token = {};
    const previousRows = this.rows();
    const pendingFocusAnchor = focusAnchorOverride ?? this.focusAnchor(previousRows);
    const focusedRow = previousRows.find(
      (row) => row.nodeRef === this.focusedNodeRef,
    );
    const moveFocusedServiceRow = focusedRow?.type === "load-more";
    let provisionalFocusRef: string | undefined;
    let firstPageFailed = false;
    const request: DomGetChildrenRequest = {
      type: "dom.getChildren",
      requestId: this.createRequestId(),
      documentEpoch: epoch,
      nodeRef,
      branchRevision: revision,
      ...(cursor ? { cursor } : {}),
    };
    this.registerReconciliationToken(reconciliationBatchId, token);
    const pendingTask = createPendingTask();
    const promise = pendingTask.promise;
    branch.pending = {
      token,
      revision,
      cursor,
      reconciliationBatchId,
      promise,
    };
    const task = (async (): Promise<void> => {
      try {
        const response = await this.transport.request(request);
        const currentBranch = this.branches.get(nodeRef);
        if (
          !this.isCurrent(generation) ||
          currentBranch?.pending?.token !== token ||
          this.currentDocumentEpoch !== epoch ||
          currentBranch.revision !== revision
        ) {
          return;
        }
        if (response.type === "dom.error") {
          if (!cursor) {
            firstPageFailed = true;
            this.failFirstPageRefresh(
              currentBranch,
              nodeRef,
              pendingFocusAnchor,
              reconciliationBatchId,
            );
          }
          const correlated = (
            (response.requestId === undefined ||
              response.requestId === request.requestId) &&
            (response.documentEpoch === undefined ||
              response.documentEpoch === epoch)
          );
          this.applyError(correlated ? response.code : "internal-error");
          return;
        }
        if (
          response.type !== "dom.children" ||
          response.requestId !== request.requestId ||
          response.documentEpoch !== epoch ||
          response.nodeRef !== nodeRef ||
          response.branchRevision !== revision
        ) {
          if (!cursor) {
            firstPageFailed = true;
            this.failFirstPageRefresh(
              currentBranch,
              nodeRef,
              pendingFocusAnchor,
              reconciliationBatchId,
            );
          }
          this.applyError("internal-error");
          return;
        }
        const previousRows = this.rows();
        const useFocusAnchorOverride =
          focusAnchorOverride !== undefined &&
          this.focusedNodeRef === provisionalFocusRef;
        const focusAnchor = useFocusAnchorOverride || this.focusedNodeRef === undefined
          ? pendingFocusAnchor
          : this.focusAnchor(previousRows);
        if (useFocusAnchorOverride) {
          this.focusedNodeRef = undefined;
        }
        if (cursor) {
          for (const child of response.nodes) {
            if (
              this.adoptPageChild(child, nodeRef) &&
              !currentBranch.children.includes(child.nodeRef)
            ) {
              currentBranch.children.push(child.nodeRef);
            }
          }
          this.rebuildRevealPathFromSelection();
        } else {
          this.replacePageChildren(
            currentBranch,
            nodeRef,
            response.nodes,
            reconciliationBatchId,
          );
        }
        currentBranch.loaded = true;
        currentBranch.nextCursor = response.nextCursor;
        this.currentError = undefined;
        this.invalidateRows();
        this.reconcileFocus(focusAnchor);
      } catch (error) {
        const currentBranch = this.branches.get(nodeRef);
        if (
          this.isCurrent(generation) &&
          currentBranch?.pending?.token === token &&
          currentBranch.revision === revision &&
          this.currentDocumentEpoch === epoch
        ) {
          if (!cursor) {
            firstPageFailed = true;
            this.failFirstPageRefresh(
              currentBranch,
              nodeRef,
              pendingFocusAnchor,
              reconciliationBatchId,
            );
          }
          this.applyError("internal-error");
          this.reportError(error);
        }
      } finally {
        const currentBranch = this.branches.get(nodeRef);
        if (currentBranch?.pending?.token === token) {
          const focusAnchor = firstPageFailed
            ? pendingFocusAnchor
            : this.focusAnchor(this.rows());
          currentBranch.pending = undefined;
          this.settleReconciliationToken(reconciliationBatchId, token);
          this.invalidateRows();
          this.reconcileFocus(focusAnchor);
          this.notify();
        } else {
          this.settleReconciliationToken(reconciliationBatchId, token);
        }
      }
    })();
    void task.then(pendingTask.resolve, pendingTask.reject);
    this.invalidateRows();
    if (moveFocusedServiceRow) {
      this.moveFocusToNearestFocusable(pendingFocusAnchor);
      provisionalFocusRef = this.focusedNodeRef;
    }
    this.notify();
    return promise;
  }

  private applySelection(
    nodeRef: string,
    ancestorPath: readonly DomNodeView[],
  ): void {
    if (!isRecoverableSelectionPath(nodeRef, ancestorPath)) {
      return;
    }
    this.recoveredFocusRef = undefined;
    this.replaceRevealPath(ancestorPath);
    let parentRef: string | undefined;
    for (const [index, view] of ancestorPath.entries()) {
      if (parentRef) {
        this.detachNodeFromOtherOwners(view.nodeRef, parentRef);
        this.releaseDeferredCandidate(view.nodeRef);
      }
      this.upsertNode(view, parentRef);
      if (parentRef) {
        const parent = this.nodes.get(parentRef);
        if (parent) {
          const branch = this.branchFor(parent.view);
          branch.revealChild = view.nodeRef;
        }
      }
      if (index < ancestorPath.length - 1) {
        this.expanded.add(view.nodeRef);
      }
      parentRef = view.nodeRef;
    }
    this.revealPathRefs = Object.freeze(ancestorPath.map((view) => view.nodeRef));
    this.selectedNodeRef = nodeRef;
    this.focusedNodeRef = nodeRef;
    this.currentRevealRef = nodeRef;
    this.currentRevealVersion += 1;
    this.currentError = undefined;
    this.notify();
  }

  private invalidateBranch(
    nodeRef: string,
    branchRevision: number,
    reconciliationBatchId?: number,
  ): void {
    const state = this.nodes.get(nodeRef);
    if (!state) {
      return;
    }
    const branch = state.view.expandable
      ? this.branchFor(state.view)
      : this.branches.get(nodeRef);
    const currentRevision = branch?.revision ?? state.view.branchRevision;
    if (branchRevision <= currentRevision) {
      return;
    }
    const previousRows = this.rows();
    const focusAnchor = this.focusAnchor(previousRows);
    if (branch) {
      if (branch.pending) {
        this.settleReconciliationToken(
          branch.pending.reconciliationBatchId,
          branch.pending.token,
        );
      }
      branch.revision = branchRevision;
      branch.loaded = false;
      branch.nextCursor = undefined;
      branch.pending = undefined;
    }
    if (nodeRef !== this.rootRef) {
      state.view = Object.freeze({
        ...state.view,
        branchRevision,
      });
    }
    this.invalidateRows();
    this.reconcileFocus(focusAnchor);
    if (
      nodeRef === this.rootRef &&
      branchRevision > (this.rootSnapshotRevision ?? -1)
    ) {
      void this.refreshRootSnapshot(nodeRef, branchRevision);
    }
    if (this.expanded.has(nodeRef)) {
      void this.fetchChildren(
        nodeRef,
        undefined,
        focusAnchor,
        reconciliationBatchId,
      );
    }
  }

  private async refreshRootSnapshot(
    nodeRef: string,
    requiredRevision: number,
  ): Promise<void> {
    if (
      this.disposed ||
      this.recovering ||
      this.rootRef !== nodeRef ||
      this.currentDocumentEpoch === undefined ||
      (this.rootSnapshotRevision ?? -1) >= requiredRevision
    ) {
      return;
    }
    if (this.rootRequest) {
      await this.rootRequest.promise;
      const currentRevision = this.branches.get(nodeRef)?.revision ??
        this.nodes.get(nodeRef)?.view.branchRevision;
      if (currentRevision !== undefined) {
        await this.refreshRootSnapshot(nodeRef, currentRevision);
      }
      return;
    }
    const generation = this.generation;
    const expectedEpoch = this.currentDocumentEpoch;
    const token = {};
    const request: DomGetRootRequest = {
      type: "dom.getRoot",
      requestId: this.createRequestId(),
      documentEpoch: expectedEpoch,
    };
    const pendingTask = createPendingTask();
    const promise = pendingTask.promise;
    this.rootRequest = { token, promise };
    const task = (async (): Promise<void> => {
      try {
        const response = await this.transport.request(request);
        const current = this.nodes.get(nodeRef);
        if (
          !this.isCurrent(generation) ||
          this.rootRequest?.token !== token ||
          this.currentDocumentEpoch !== expectedEpoch ||
          this.rootRef !== nodeRef ||
          !current
        ) return;
        if (response.type === "dom.error") {
          const correlated = (
            (response.requestId === undefined ||
              response.requestId === request.requestId) &&
            (response.documentEpoch === undefined ||
              response.documentEpoch === expectedEpoch)
          );
          this.applyRootSnapshotError(
            correlated ? response.code : "internal-error",
          );
          return;
        }
        if (
          response.type !== "dom.root" ||
          response.requestId !== request.requestId ||
          response.documentEpoch !== expectedEpoch ||
          response.node.nodeRef !== nodeRef
        ) {
          this.applyRootSnapshotError("internal-error");
          return;
        }
        const latestRevision = this.branches.get(nodeRef)?.revision ??
          current.view.branchRevision;
        if (response.node.branchRevision < latestRevision) {
          if (latestRevision <= requiredRevision) {
            this.applyRootSnapshotError("internal-error");
          }
          return;
        }
        this.rootSnapshotError = undefined;
        this.rootPrologue = Object.freeze([...response.prologue]);
        this.rootEpilogue = Object.freeze([...response.epilogue]);
        this.rootSnapshotRevision = response.node.branchRevision;
        this.upsertNode(response.node, undefined);
        this.invalidateRows();
      } catch (error) {
        if (
          this.isCurrent(generation) &&
          this.rootRequest?.token === token &&
          this.currentDocumentEpoch === expectedEpoch &&
          this.rootRef === nodeRef
        ) {
          this.applyRootSnapshotError("internal-error");
          this.reportError(error);
        }
      } finally {
        if (this.rootRequest?.token === token) {
          this.rootRequest = undefined;
          this.notify();
          const latestRevision = this.branches.get(nodeRef)?.revision ??
            this.nodes.get(nodeRef)?.view.branchRevision;
          if (
            latestRevision !== undefined &&
            latestRevision > requiredRevision
          ) void this.refreshRootSnapshot(nodeRef, latestRevision);
        }
      }
    })();
    void task.then(pendingTask.resolve, pendingTask.reject);
    this.notify();
    return promise;
  }

  private branchFor(view: DomNodeView): BranchState {
    let branch = this.branches.get(view.nodeRef);
    if (!branch) {
      branch = {
        children: [],
        recoveredChildren: [],
        revision: view.branchRevision,
        loaded: false,
      };
      this.branches.set(view.nodeRef, branch);
    } else if (view.branchRevision > branch.revision) {
      branch.revision = view.branchRevision;
      branch.loaded = false;
      branch.nextCursor = undefined;
    }
    return branch;
  }

  private upsertNode(view: DomNodeView, parentRef: string | undefined): void {
    const existing = this.nodes.get(view.nodeRef);
    const desiredRevision = this.branches.get(view.nodeRef)?.revision ??
      existing?.view.branchRevision;
    if (
      existing &&
      desiredRevision !== undefined &&
      view.branchRevision < desiredRevision
    ) {
      this.nodes.set(view.nodeRef, {
        view: existing.view,
        ...(parentRef === undefined ? {} : { parentRef }),
      });
      return;
    }
    if (existing && existing.view.branchRevision !== view.branchRevision) {
      this.invalidateBranch(view.nodeRef, view.branchRevision);
    }
    this.nodes.set(view.nodeRef, {
      view: Object.freeze({ ...view }),
      ...(parentRef === undefined ? {} : { parentRef }),
    });
    if (view.expandable) {
      this.branchFor(view);
    }
  }

  private removeSubtree(nodeRef: string): void {
    if (this.hasLiveOwner(nodeRef)) {
      return;
    }
    for (const batch of this.reconciliationBatches.values()) {
      batch.candidates.delete(nodeRef);
    }
    const branch = this.branches.get(nodeRef);
    if (branch) {
      const descendants = new Set([
        ...branch.children,
        ...branch.recoveredChildren,
        ...(branch.revealChild ? [branch.revealChild] : []),
      ]);
      this.branches.delete(nodeRef);
      for (const childRef of descendants) {
        this.removeSubtree(childRef);
      }
    }
    this.expanded.delete(nodeRef);
    this.nodes.delete(nodeRef);
    if (this.focusedNodeRef === nodeRef) {
      this.focusedNodeRef = undefined;
    }
    if (this.hoveredNodeRef === nodeRef) {
      this.hoveredNodeRef = undefined;
    }
  }

  private appendRows(
    nodeRef: string,
    parentRef: string | undefined,
    depth: number,
    result: DomTreeRow[],
    visited: Set<string>,
  ): void {
    if (visited.has(nodeRef)) {
      return;
    }
    const state = this.nodes.get(nodeRef);
    if (!state) {
      return;
    }
    visited.add(nodeRef);
    const branch = this.branches.get(nodeRef);
    const isExpanded = this.expanded.has(nodeRef);
    result.push(Object.freeze({
      type: "node",
      node: state.view,
      nodeRef,
      ...(parentRef ? { parentRef } : {}),
      label: state.view.label,
      kind: state.view.kind,
      depth,
      expandable: state.view.expandable,
      selectable: state.view.selectable,
      inaccessible: state.view.inaccessible === true,
      branchRevision: state.view.branchRevision,
      expanded: isExpanded,
      loading: Boolean(branch?.pending),
      selected: this.selectedNodeRef === nodeRef,
      focused: this.focusedNodeRef === nodeRef,
      hovered: this.hoveredNodeRef === nodeRef,
    }));
    if (!isExpanded || !branch) {
      return;
    }
    for (const childRef of branch.children) {
      this.appendRows(childRef, nodeRef, depth + 1, result, visited);
    }
    if (
      branch.revealChild &&
      !branch.children.includes(branch.revealChild)
    ) {
      this.appendRows(
        branch.revealChild,
        nodeRef,
        depth + 1,
        result,
        visited,
      );
    }
    for (const recoveredChild of branch.recoveredChildren) {
      if (
        !branch.children.includes(recoveredChild) &&
        recoveredChild !== branch.revealChild
      ) {
        this.appendRows(
          recoveredChild,
          nodeRef,
          depth + 1,
          result,
          visited,
        );
      }
    }
    if (
      branch.nextCursor ||
      branch.pending ||
      (!branch.loaded && branch.children.length === 0)
    ) {
      const loading = Boolean(branch.pending);
      result.push(Object.freeze({
        type: "load-more",
        nodeRef: `${LOAD_MORE_PREFIX}${nodeRef}`,
        parentRef: nodeRef,
        label: loading ? "Loading" : branch.nextCursor ? "Load more" : "Load children",
        kind: "load-more",
        depth: depth + 1,
        expandable: false,
        selectable: false,
        inaccessible: false,
        branchRevision: branch.revision,
        expanded: false,
        loading,
        selected: false,
        focused: this.focusedNodeRef === `${LOAD_MORE_PREFIX}${nodeRef}`,
        hovered: false,
      }));
    }
  }

  private appendAuxiliaryRow(node: DomNodeView, result: DomTreeRow[]): void {
    result.push(Object.freeze({
      type: "node",
      node,
      nodeRef: node.nodeRef,
      label: node.label,
      kind: node.kind,
      depth: 1,
      expandable: false,
      selectable: false,
      inaccessible: node.inaccessible === true,
      branchRevision: node.branchRevision,
      expanded: false,
      loading: false,
      selected: false,
      focused: this.focusedNodeRef === node.nodeRef,
      hovered: false,
    }));
  }

  private focusRow(row: DomTreeRow | undefined): void {
    if (!isFocusableRow(row)) {
      return;
    }
    this.focusedNodeRef = row.nodeRef;
    this.notify();
  }

  private focusAdjacentRow(
    rows: readonly DomTreeRow[],
    currentIndex: number,
    direction: -1 | 1,
  ): void {
    for (
      let index = currentIndex + direction;
      index >= 0 && index < rows.length;
      index += direction
    ) {
      const row = rows[index];
      if (isFocusableRow(row)) {
        this.focusRow(row);
        return;
      }
    }
  }

  private replaceRevealPath(ancestorPath: readonly DomNodeView[]): void {
    const nextRefs = new Set(ancestorPath.map((view) => view.nodeRef));
    const nextChildren = new Map<string, string>();
    for (let index = 0; index < ancestorPath.length - 1; index += 1) {
      const parent = ancestorPath[index];
      const child = ancestorPath[index + 1];
      if (parent && child) {
        nextChildren.set(parent.nodeRef, child.nodeRef);
      }
    }

    for (let index = 0; index < this.revealPathRefs.length - 1; index += 1) {
      const parentRef = this.revealPathRefs[index];
      const childRef = this.revealPathRefs[index + 1];
      if (!parentRef || !childRef || nextChildren.get(parentRef) === childRef) {
        continue;
      }
      const branch = this.branches.get(parentRef);
      if (branch?.revealChild === childRef) {
        branch.revealChild = undefined;
      }
    }

    this.rootRef = ancestorPath[0]?.nodeRef;
    for (const oldRef of [...this.revealPathRefs].reverse()) {
      if (
        !nextRefs.has(oldRef) &&
        oldRef !== this.rootRef &&
        !this.isPageChild(oldRef)
      ) {
        this.removeSubtree(oldRef);
      }
    }
  }

  private beginReconciliationBatch(branchCount: number): number {
    while (
      this.reconciliationBatches.size >=
      DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES
    ) {
      const oldestBatchId = this.reconciliationBatches.keys().next().value;
      if (typeof oldestBatchId !== "number") {
        break;
      }
      this.finishReconciliationBatch(oldestBatchId);
    }
    const id = ++this.reconciliationBatchSequence;
    this.reconciliationBatches.set(id, {
      pendingTokens: new Set(),
      candidates: new Set(),
      candidateLimit: Math.max(1, branchCount) *
        DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
      focusAnchor: this.focusAnchor(this.rows()),
    });
    return id;
  }

  private registerReconciliationToken(
    batchId: number | undefined,
    token: object,
  ): void {
    if (batchId === undefined) {
      return;
    }
    this.reconciliationBatches.get(batchId)?.pendingTokens.add(token);
  }

  private settleReconciliationToken(
    batchId: number | undefined,
    token: object,
  ): void {
    if (batchId === undefined) {
      return;
    }
    const batch = this.reconciliationBatches.get(batchId);
    if (!batch || !batch.pendingTokens.delete(token)) {
      return;
    }
    this.finishReconciliationBatchIfIdle(batchId);
  }

  private finishReconciliationBatchIfIdle(batchId: number): void {
    const batch = this.reconciliationBatches.get(batchId);
    if (batch?.pendingTokens.size === 0) {
      this.finishReconciliationBatch(batchId);
    }
  }

  private finishReconciliationBatch(batchId: number): void {
    const batch = this.reconciliationBatches.get(batchId);
    if (!batch) {
      return;
    }
    this.reconciliationBatches.delete(batchId);
    for (const nodeRef of batch.candidates) {
      if (this.hasDeferredCandidate(nodeRef) || this.hasLiveOwner(nodeRef)) {
        continue;
      }
      this.removeSubtree(nodeRef);
    }
    this.invalidateRows();
    this.reconcileFocus(batch.focusAnchor);
  }

  private clearPageChildren(
    branch: BranchState,
    parentRef: string,
    reconciliationBatchId?: number,
  ): void {
    const previousChildren = [...branch.children];
    branch.children.length = 0;
    for (const childRef of previousChildren) {
      this.detachPageChild(branch, parentRef, childRef);
      this.deferDetachedSubtree(childRef, reconciliationBatchId);
    }
    this.rebuildRevealPathFromSelection();
  }

  private replacePageChildren(
    branch: BranchState,
    parentRef: string,
    children: readonly DomNodeView[],
    reconciliationBatchId?: number,
  ): void {
    const previousChildren = [...branch.children];
    const nextChildren: string[] = [];
    for (const child of children) {
      if (
        this.adoptPageChild(child, parentRef) &&
        !nextChildren.includes(child.nodeRef)
      ) {
        nextChildren.push(child.nodeRef);
      }
    }
    branch.children.splice(0, branch.children.length, ...nextChildren);
    const retained = new Set(nextChildren);
    for (const childRef of previousChildren) {
      if (!retained.has(childRef)) {
        this.detachPageChild(branch, parentRef, childRef);
        this.deferDetachedSubtree(childRef, reconciliationBatchId);
      }
    }
    this.rebuildRevealPathFromSelection();
  }

  private failFirstPageRefresh(
    branch: BranchState,
    parentRef: string,
    focusAnchor: FocusAnchor,
    reconciliationBatchId?: number,
  ): void {
    this.clearPageChildren(branch, parentRef, reconciliationBatchId);
    branch.loaded = false;
    branch.nextCursor = undefined;
    this.invalidateRows();
    this.reconcileFocus(focusAnchor);
  }

  private deferDetachedSubtree(
    nodeRef: string,
    reconciliationBatchId?: number,
  ): void {
    if (this.hasLiveOwner(nodeRef)) {
      this.releaseDeferredCandidate(nodeRef);
      return;
    }
    const batch = reconciliationBatchId === undefined
      ? undefined
      : this.reconciliationBatches.get(reconciliationBatchId);
    if (!batch) {
      this.removeSubtree(nodeRef);
      return;
    }
    if (batch.candidates.has(nodeRef)) {
      return;
    }
    while (batch.candidates.size >= batch.candidateLimit) {
      const oldestCandidate = batch.candidates.values().next().value;
      if (typeof oldestCandidate !== "string") {
        break;
      }
      batch.candidates.delete(oldestCandidate);
      if (
        !this.hasDeferredCandidate(oldestCandidate) &&
        !this.hasLiveOwner(oldestCandidate)
      ) {
        this.removeSubtree(oldestCandidate);
      }
    }
    batch.candidates.add(nodeRef);
  }

  private releaseDeferredCandidate(nodeRef: string): void {
    for (const batch of this.reconciliationBatches.values()) {
      batch.candidates.delete(nodeRef);
    }
  }

  private hasDeferredCandidate(nodeRef: string): boolean {
    for (const batch of this.reconciliationBatches.values()) {
      if (batch.candidates.has(nodeRef)) {
        return true;
      }
    }
    return false;
  }

  private adoptPageChild(view: DomNodeView, parentRef: string): boolean {
    if (this.wouldCreateOwnershipCycle(parentRef, view.nodeRef)) {
      return false;
    }
    this.detachNodeFromOtherOwners(view.nodeRef, parentRef);
    this.upsertNode(view, parentRef);
    this.releaseDeferredCandidate(view.nodeRef);
    return true;
  }

  private detachPageChild(
    branch: BranchState,
    parentRef: string,
    childRef: string,
  ): void {
    const preserveSelectedReveal = (
      branch.revealChild === childRef &&
      this.selectedNodeRef !== undefined &&
      this.revealPathRefs.includes(childRef)
    );
    if (branch.revealChild === childRef && !preserveSelectedReveal) {
      branch.revealChild = undefined;
    }
    removeAll(branch.recoveredChildren, childRef);
    const child = this.nodes.get(childRef);
    if (child?.parentRef === parentRef && !preserveSelectedReveal) {
      this.nodes.set(childRef, { view: child.view });
    }
  }

  private detachNodeFromOtherOwners(
    nodeRef: string,
    parentRef: string,
  ): void {
    for (const [ownerRef, branch] of this.branches) {
      if (ownerRef === parentRef) {
        continue;
      }
      removeAll(branch.children, nodeRef);
      removeAll(branch.recoveredChildren, nodeRef);
      if (branch.revealChild === nodeRef) {
        branch.revealChild = undefined;
      }
    }
  }

  private wouldCreateOwnershipCycle(
    parentRef: string,
    childRef: string,
  ): boolean {
    if (childRef === this.rootRef || childRef === parentRef) {
      return true;
    }
    let currentRef: string | undefined = parentRef;
    const visited = new Set<string>();
    while (currentRef && !visited.has(currentRef)) {
      if (currentRef === childRef) {
        return true;
      }
      visited.add(currentRef);
      currentRef = this.nodes.get(currentRef)?.parentRef;
    }
    return false;
  }

  private rebuildRevealPathFromSelection(): void {
    const selectedRef = this.selectedNodeRef;
    if (!selectedRef || !this.rootRef || !this.nodes.has(selectedRef)) {
      return;
    }
    const reversedPath: string[] = [];
    const visited = new Set<string>();
    let currentRef: string | undefined = selectedRef;
    while (currentRef && !visited.has(currentRef)) {
      visited.add(currentRef);
      reversedPath.push(currentRef);
      if (currentRef === this.rootRef) {
        break;
      }
      currentRef = this.nodes.get(currentRef)?.parentRef;
    }
    this.clearRevealEdges();
    if (reversedPath.at(-1) !== this.rootRef) {
      this.revealPathRefs = Object.freeze([]);
      return;
    }
    const nextPath = reversedPath.reverse();
    for (let index = 0; index < nextPath.length - 1; index += 1) {
      const parentRef = nextPath[index];
      const childRef = nextPath[index + 1];
      if (!parentRef || !childRef) {
        continue;
      }
      const parent = this.nodes.get(parentRef);
      if (!parent) {
        continue;
      }
      this.branchFor(parent.view).revealChild = childRef;
      this.expanded.add(parentRef);
    }
    this.revealPathRefs = Object.freeze(nextPath);
  }

  private clearRevealEdges(): void {
    for (let index = 0; index < this.revealPathRefs.length - 1; index += 1) {
      const parentRef = this.revealPathRefs[index];
      const childRef = this.revealPathRefs[index + 1];
      if (!parentRef || !childRef) {
        continue;
      }
      const branch = this.branches.get(parentRef);
      if (branch?.revealChild === childRef) {
        branch.revealChild = undefined;
      }
    }
  }

  private hasLiveOwner(nodeRef: string): boolean {
    if (
      this.rootPrologue.some((node) => node.nodeRef === nodeRef) ||
      this.rootEpilogue.some((node) => node.nodeRef === nodeRef)
    ) {
      return true;
    }

    const pending = this.rootRef ? [this.rootRef] : [];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const currentRef = pending.pop();
      if (!currentRef || visited.has(currentRef)) {
        continue;
      }
      if (currentRef === nodeRef) {
        return true;
      }
      visited.add(currentRef);
      const branch = this.branches.get(currentRef);
      if (!branch) {
        continue;
      }
      pending.push(...branch.children, ...branch.recoveredChildren);
      if (branch.revealChild) {
        pending.push(branch.revealChild);
      }
    }
    return false;
  }

  private isDeferredPruneNode(nodeRef: string): boolean {
    const pending = [...this.reconciliationBatches.values()].flatMap(
      (batch) => [...batch.candidates],
    );
    const visited = new Set<string>();
    while (pending.length > 0) {
      const currentRef = pending.pop();
      if (!currentRef || visited.has(currentRef)) {
        continue;
      }
      if (currentRef === nodeRef) {
        return true;
      }
      visited.add(currentRef);
      const branch = this.branches.get(currentRef);
      if (!branch) {
        continue;
      }
      pending.push(...branch.children, ...branch.recoveredChildren);
      if (branch.revealChild) {
        pending.push(branch.revealChild);
      }
    }
    return false;
  }

  private commitRecoveredChildren(): void {
    for (const branch of this.branches.values()) {
      for (const childRef of branch.recoveredChildren) {
        if (
          childRef !== branch.revealChild &&
          !branch.children.includes(childRef)
        ) {
          branch.children.push(childRef);
        }
      }
      branch.recoveredChildren.length = 0;
    }
  }

  private restoreRecoveryFocus(): string | undefined {
    const nodeRef = this.recoveryFocusRef;
    const state = nodeRef ? this.nodes.get(nodeRef) : undefined;
    if (!nodeRef || !state || state.view.inaccessible) {
      this.focusedNodeRef = this.rootRef;
      return undefined;
    }
    if (this.recoveryFocusRowType === "load-more") {
      const branch = this.branches.get(nodeRef);
      const hasLoadMoreRow = this.expanded.has(nodeRef) && Boolean(
        branch && (
          branch.nextCursor ||
          branch.pending ||
          (!branch.loaded && branch.children.length === 0)
        )
      );
      if (!hasLoadMoreRow) {
        this.focusedNodeRef = this.rootRef;
        return undefined;
      }
      const loadMoreRef = `${LOAD_MORE_PREFIX}${nodeRef}`;
      this.focusedNodeRef = loadMoreRef;
      return loadMoreRef;
    }
    this.focusedNodeRef = nodeRef;
    return nodeRef;
  }

  private isPageChild(nodeRef: string): boolean {
    for (const branch of this.branches.values()) {
      if (
        branch.children.includes(nodeRef) ||
        branch.recoveredChildren.includes(nodeRef)
      ) {
        return true;
      }
    }
    return false;
  }

  private isDescendantRow(
    rows: readonly DomTreeRow[],
    ancestorRef: string,
    candidateRef: string | undefined,
  ): boolean {
    if (!candidateRef || candidateRef === ancestorRef) {
      return false;
    }
    const ancestorIndex = rows.findIndex((row) => row.nodeRef === ancestorRef);
    const candidateIndex = rows.findIndex((row) => row.nodeRef === candidateRef);
    if (ancestorIndex < 0 || candidateIndex <= ancestorIndex) {
      return false;
    }
    const ancestor = rows[ancestorIndex];
    const candidate = rows[candidateIndex];
    return Boolean(
      ancestor &&
      candidate &&
      candidate.depth > ancestor.depth &&
      rows.slice(ancestorIndex + 1, candidateIndex).every((row) => (
        row.depth > ancestor.depth
      )),
    );
  }

  private focusAnchor(rows: readonly DomTreeRow[]): FocusAnchor {
    return {
      index: rows.findIndex((row) => row.nodeRef === this.focusedNodeRef),
    };
  }

  private reconcileFocus(anchor: FocusAnchor): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.focusedNodeRef = undefined;
      return;
    }
    if (rows.some((row) => row.nodeRef === this.focusedNodeRef)) {
      return;
    }
    if (
      this.focusedNodeRef &&
      this.isDeferredPruneNode(this.focusedNodeRef)
    ) {
      return;
    }
    const index = anchor.index < 0
      ? 0
      : Math.min(anchor.index, rows.length - 1);
    this.focusedNodeRef = rows[index]?.nodeRef ?? rows[0]?.nodeRef;
  }

  private moveFocusToNearestFocusable(anchor: FocusAnchor): void {
    const rows = this.rows();
    const anchorIndex = anchor.index < 0
      ? 0
      : Math.min(anchor.index, Math.max(0, rows.length - 1));
    this.focusedNodeRef = nearestFocusableRow(rows, anchorIndex)?.nodeRef;
    this.invalidateRows();
  }

  private invalidateRows(): void {
    this.rowsCache = undefined;
  }

  private isVisibleRef(nodeRef: string): boolean {
    return this.rows().some((row) => (
      row.nodeRef === nodeRef && isFocusableRow(row)
    ));
  }

  private applyError(code: DomErrorCode): void {
    this.currentError = code;
    if (code === "stale-document" || code === "session-disposed") {
      this.resetState(
        undefined,
        code === "stale-document"
          ? "DOM document changed"
          : "DOM session disposed",
      );
    }
  }

  private applyRootSnapshotError(code: DomErrorCode): void {
    if (code === "stale-document" || code === "session-disposed") {
      this.applyError(code);
      return;
    }
    this.rootSnapshotError = code;
    this.invalidateRows();
  }

  private resetState(
    documentEpoch: number | undefined,
    cancellationReason: string,
  ): void {
    this.cancelPending(cancellationReason);
    this.generation += 1;
    this.recovering = false;
    this.frozenRows = undefined;
    this.recoverySnapshot = undefined;
    this.clearLiveState(documentEpoch);
  }

  private clearLiveState(documentEpoch: number | undefined): void {
    this.rootRequest = undefined;
    this.recoveryFocusRef = undefined;
    this.recoveryFocusRowType = undefined;
    this.recoveredFocusRef = undefined;
    this.nodes.clear();
    this.branches.clear();
    this.expanded.clear();
    this.reconciliationBatches.clear();
    this.revealPathRefs = Object.freeze([]);
    this.rootRef = undefined;
    this.rootPrologue = Object.freeze([]);
    this.rootEpilogue = Object.freeze([]);
    this.rootSnapshotRevision = undefined;
    this.rootSnapshotError = undefined;
    this.selectedNodeRef = undefined;
    this.focusedNodeRef = undefined;
    this.hoveredNodeRef = undefined;
    this.lastHoverRequest = undefined;
    this.currentHoverSummary = undefined;
    this.currentRevealRef = undefined;
    this.currentError = undefined;
    this.currentDocumentEpoch = documentEpoch;
    this.invalidateRows();
  }

  private cancelPending(reason: string): void {
    try {
      this.transport.cancelPending(reason);
    } catch (error) {
      this.reportError(error);
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isCurrentRecovery(generation: number): boolean {
    return this.recovering && this.isCurrent(generation);
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Panel diagnostics cannot break tree state ownership.
    }
  }

  private notify(): void {
    if (this.disposed) {
      return;
    }
    this.invalidateRows();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.reportError(error);
      }
    }
  }
}

function isRecoverableSelectionPath(
  nodeRef: string,
  ancestorPath: readonly DomNodeView[],
): boolean {
  const target = ancestorPath.at(-1);
  return Boolean(
    target &&
    target.nodeRef === nodeRef &&
    target.locator &&
    isSelectableElementView(target) &&
    ancestorPath.every(isRecoverablePathView),
  );
}

function isRecoverableLocatorResponse(response: DomLocatorResponse): boolean {
  const target = response.ancestorPath.at(-1);
  return Boolean(
    target &&
    target.locator &&
    response.ancestorPath.every(isRecoverablePathView) &&
    sameDomNodeViewAuthority(response.node, target),
  );
}

function isRecoverablePathView(view: DomNodeView): boolean {
  return (
    view.kind === "element" ||
    view.kind === "shadow-root" ||
    view.kind === "frame-document"
  ) && (
    view.locator === undefined || view.locator.targetKind === view.kind
  );
}

function isSelectableElementView(view: DomNodeView): boolean {
  return view.kind === "element" && view.selectable && !view.inaccessible;
}

function sameDomNodeViewAuthority(
  left: DomNodeView,
  right: DomNodeView,
): boolean {
  if (
    left.nodeRef !== right.nodeRef ||
    left.kind !== right.kind ||
    left.nodeType !== right.nodeType ||
    left.nodeName !== right.nodeName ||
    left.nodeValue !== right.nodeValue ||
    left.publicId !== right.publicId ||
    left.systemId !== right.systemId ||
    left.childCount !== right.childCount ||
    left.relationship !== right.relationship ||
    left.selectable !== right.selectable ||
    left.label !== right.label ||
    left.expandable !== right.expandable ||
    left.inaccessible !== right.inaccessible ||
    left.branchRevision !== right.branchRevision ||
    left.attributes.length !== right.attributes.length ||
    !left.attributes.every((attribute, index) => (
      attribute.name === right.attributes[index]?.name &&
      attribute.value === right.attributes[index]?.value
    ))
  ) {
    return false;
  }
  if (!left.locator || !right.locator) {
    return left.locator === right.locator;
  }
  try {
    return locatorKey(left.locator) === locatorKey(right.locator);
  } catch {
    return false;
  }
}

function removeAll(values: string[], value: string): void {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] === value) {
      values.splice(index, 1);
    }
  }
}

function isFocusableRow(row: DomTreeRow | undefined): row is DomTreeRow {
  return Boolean(row && (row.type === "node" || !row.loading));
}

function nearestFocusableRow(
  rows: readonly DomTreeRow[],
  anchorIndex: number,
): DomTreeRow | undefined {
  for (let distance = 0; distance < rows.length; distance += 1) {
    const next = rows[anchorIndex + distance];
    if (isFocusableRow(next)) return next;
    if (distance === 0) continue;
    const previous = rows[anchorIndex - distance];
    if (isFocusableRow(previous)) return previous;
  }
  return undefined;
}

function emptyRecoverySnapshot(): DomTreeRecoverySnapshot {
  return Object.freeze({
    selectedWasExpanded: false,
    expandedLocators: Object.freeze([]),
  });
}

function createPendingTask(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function locatorKey(locator: DomStableLocator): string {
  return JSON.stringify(locator);
}
