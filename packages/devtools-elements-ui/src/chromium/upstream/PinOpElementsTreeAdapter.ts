import type {
  InspectorNodeSnapshot,
  TreeDataSource,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "../../contracts.js";

export interface ChromiumDOMNodePayload {
  readonly nodeId: number;
  readonly backendNodeId: number;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly localName: string;
  readonly nodeValue: string;
  readonly attributes?: readonly string[];
  readonly childNodeCount?: number;
  readonly children?: readonly ChromiumDOMNodePayload[];
  readonly shadowRoots?: readonly ChromiumDOMNodePayload[];
  readonly contentDocument?: ChromiumDOMNodePayload;
  readonly shadowRootType?: "open" | "closed" | "user-agent";
  readonly publicId?: string;
  readonly systemId?: string;
  readonly internalSubset?: string;
  readonly documentURL?: string;
  readonly baseURL?: string;
}

export interface ChromiumDOMNode {
  readonly id: number;
  parentNode: ChromiumDOMNode | null;
  index: number | undefined;
  nextSibling: ChromiumDOMNode | null;
  previousSibling: ChromiumDOMNode | null;
  firstChild: ChromiumDOMNode | null;
  lastChild: ChromiumDOMNode | null;
  children(): ChromiumDOMNode[] | null;
  childNodeCount(): number;
  setChildNodeCount(childNodeCount: number): void;
  setChildren(children: ChromiumDOMNode[]): void;
  setChildrenPayload(payloads: readonly ChromiumDOMNodePayload[]): void;
  insertChild(
    previous: ChromiumDOMNode | undefined,
    payload: ChromiumDOMNodePayload,
  ): ChromiumDOMNode;
  nodeValue(): string;
  setNodeValueInternal(nodeValue: string): void;
  setAttributesPayload(attributes: string[]): boolean;
  nodeType(): number;
  nodeName(): string;
  shadowRoots?(): ChromiumDOMNode[];
  contentDocument?(): ChromiumDOMNode | null;
  setContentDocument?(document: ChromiumDOMNode): void;
}

export interface ChromiumDOMAgentResponse {
  getError(): string | undefined;
}

export interface ChromiumDOMAgent {
  invoke_requestChildNodes(request: {
    readonly nodeId: number;
    readonly depth?: number;
    readonly pierce?: boolean;
  }): Promise<ChromiumDOMAgentResponse>;
}

export interface ChromiumDOMModel {
  readonly agent: ChromiumDOMAgent;
  target(): ChromiumTarget;
  getAgent(): ChromiumDOMAgent;
  registerNode(node: ChromiumDOMNode): void;
  nodeForId(nodeId: number): ChromiumDOMNode | null;
  addEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void;
  removeEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void;
  dispatchEventToListeners(eventName: string, data: unknown): void;
  cssModel(): ChromiumCSSModel;
  overlayModel(): ChromiumOverlayModel;
  existingDocument(): ChromiumDOMNode | null;
  requestDocument(): Promise<ChromiumDOMNode | null>;
}

export interface ChromiumTarget {
  targetManager(): {
    getFrameManager(): {
      getFrame(frameId: string): null;
      getOrWaitForFrame(frameId: string, target: ChromiumTarget): Promise<null>;
    };
  };
}

export interface ChromiumCSSModel {
  getLayoutPropertiesFromComputedStyle(nodeId: number): Promise<null>;
}

export interface ChromiumOverlayModel {
  highlightInOverlay(...arguments_: readonly unknown[]): void;
  hideDOMNodeHighlight(): void;
}

export interface ChromiumTreeElement {
  readonly expanded: boolean;
  expand(): void;
  collapse(): void;
  node?(): ChromiumDOMNode;
}

export interface ChromiumElementsTreeOutline {
  readonly element: HTMLElement;
  rootDOMNode: ChromiumDOMNode | null;
  wireToDOMModel(model: ChromiumDOMModel): void;
  unwireFromDOMModel(model: ChromiumDOMModel): void;
  selectedDOMNode(): ChromiumDOMNode | null;
  selectDOMNode(node: ChromiumDOMNode | null, focus?: boolean): void;
  findTreeElement(node: ChromiumDOMNode): ChromiumTreeElement | null;
  addEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void;
  removeEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void;
  dispose?(): void;
}

/**
 * A source-authorized pagination affordance for a currently mounted Chromium
 * DOMNode. The runtime owns only its visual placement; the adapter revalidates
 * the parent and Pin-op service row before forwarding a request.
 */
export interface ChromiumLoadMoreParent {
  readonly parent: ChromiumDOMNode;
  readonly serviceRowRef: string;
  readonly focused: boolean;
  readonly hasMore: true;
  readonly loadedChildCount: number;
  readonly totalChildCount: number;
  readonly remainingChildCount: number;
}

export interface ChromiumLoadMoreBridge {
  update(parents: readonly ChromiumLoadMoreParent[]): void;
  dispose(): void;
}

export interface ChromiumElementsRuntime {
  readonly DOMDocument: new (
    model: ChromiumDOMModel,
    payload: ChromiumDOMNodePayload,
  ) => ChromiumDOMNode;
  readonly ElementsTreeOutline: new (
    omitRootDOMNode?: boolean,
    selectEnabled?: boolean,
    hideGutter?: boolean,
    maxTreeDepth?: number,
    enableContextMenu?: boolean,
    showComments?: boolean,
    showAIButton?: boolean,
    disableEdits?: boolean,
    expandRoot?: boolean,
  ) => ChromiumElementsTreeOutline;
  readonly selectedNodeChangedEvent: string;
  readonly elementCollapsedEvent: string;
  readonly elementExpandedEvent: string;
  installLoadMoreBridge(
    outline: ChromiumElementsTreeOutline,
    loadMore: (authority: ChromiumLoadMoreParent) => Promise<void>,
  ): ChromiumLoadMoreBridge;
  prepareReadOnlyRuntime?(): (() => void) | void;
}

export interface PinOpElementsTreeAdapterOptions {
  readonly documentURL?: string;
  readonly onError?: (error: unknown) => void;
}

export interface PinOpElementsTreeAdapterHost {
  readonly element: HTMLElement;
  dispose(): void;
}

interface SelectedNodeChangedData {
  readonly node: ChromiumDOMNode | null;
  readonly focus: boolean;
}

interface ModelEventListener {
  readonly listener: (event: { readonly data: unknown }) => void;
  readonly thisObject?: unknown;
  readonly persistent: boolean;
}

interface PendingLoadMoreRequest {
  readonly parent: ChromiumDOMNode;
  readonly documentGeneration: number;
  readonly promise: Promise<void>;
}

const syntheticDocumentNodeId = 1;

/**
 * Adapts Pin-op's browser-neutral tree snapshots to the real Chromium
 * DOMDocument/DOMNode graph expected by ElementsTreeOutline.
 *
 * The injected runtime is intentionally explicit: the extension build owns the
 * pinned Chromium imports and the small singleton shims they require. This
 * package owns only the read-only data boundary.
 */
export function createPinOpElementsTreeAdapter(
  runtime: ChromiumElementsRuntime,
  mount: HTMLElement,
  treeDataSource: TreeDataSource,
  options: PinOpElementsTreeAdapterOptions = {},
): PinOpElementsTreeAdapterHost {
  const cleanupRuntime = onceCleanup(runtime.prepareReadOnlyRuntime?.());
  try {
    return new PinOpElementsTreeAdapter(
      runtime,
      mount,
      treeDataSource,
      options,
      cleanupRuntime,
    );
  } catch (error) {
    cleanupRuntime?.();
    throw error;
  }
}

class PinOpElementsTreeAdapter implements PinOpElementsTreeAdapterHost {
  public readonly element: HTMLElement;
  private readonly model: PinOpDOMModel;
  private readonly outline: ChromiumElementsTreeOutline;
  private readonly reportError: (error: unknown) => void;
  private readonly cleanupRuntime: (() => void) | undefined;
  private readonly elementCollapsedEvent: string;
  private readonly elementExpandedEvent: string;
  private readonly selectedNodeChangedEvent: string;
  private loadMoreBridge: ChromiumLoadMoreBridge | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastSnapshot: TreePresentationSnapshot | undefined;
  private selectionSync = false;
  private readonly sourceMutationDepthByGeneration = new Map<number, number>();
  private desiredExpandedChildren = new Map<string | undefined, readonly string[]>();
  private readonly pendingLoadMore = new Map<string, PendingLoadMoreRequest>();
  private documentGeneration = 0;
  private hoveredNodeRef: string | undefined;
  private outlineWired = false;
  private disposed = false;

  public constructor(
    runtime: ChromiumElementsRuntime,
    mount: HTMLElement,
    private readonly treeDataSource: TreeDataSource,
    private readonly options: PinOpElementsTreeAdapterOptions,
    cleanupRuntime: (() => void) | void,
  ) {
    this.cleanupRuntime = cleanupRuntime || undefined;
    this.reportError = options.onError ?? (() => undefined);
    this.selectedNodeChangedEvent = runtime.selectedNodeChangedEvent;
    this.elementCollapsedEvent = runtime.elementCollapsedEvent;
    this.elementExpandedEvent = runtime.elementExpandedEvent;
    this.model = new PinOpDOMModel(
      (nodeId, requestingNode) => this.requestChildren(nodeId, requestingNode),
      node => this.onChromiumHover(node),
    );
    this.outline = new runtime.ElementsTreeOutline(
      true,
      true,
      true,
      undefined,
      false,
      true,
      false,
      true,
      false,
    );
    this.element = this.outline.element;
    try {
      this.outline.addEventListener(
        this.selectedNodeChangedEvent,
        this.onSelectedNodeChanged,
        this,
      );
      this.outline.addEventListener(
        this.elementCollapsedEvent,
        this.onElementCollapsed,
        this,
      );
      this.outline.addEventListener(
        this.elementExpandedEvent,
        this.onElementExpanded,
        this,
      );
      this.outline.wireToDOMModel(this.model);
      this.outlineWired = true;
      this.model.sealPersistentEventListeners();
      this.loadMoreBridge = runtime.installLoadMoreBridge(
        this.outline,
        this.onLoadMoreRequested,
      );
      this.element.addEventListener("pointerleave", this.onPointerLeave);
      this.element.addEventListener("mouseleave", this.onPointerLeave);
      this.element.addEventListener("focusout", this.onPointerLeave);
      mount.append(this.element);
      this.unsubscribe = treeDataSource.subscribe(this.onSourceChanged);
      this.synchronize(true, runtime.DOMDocument);
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Pin-op Chromium Elements mount and teardown failed",
        );
      }
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (this.hoveredNodeRef !== undefined) {
      this.hoveredNodeRef = undefined;
      attempt(() => this.treeDataSource.hover(undefined));
    }
    attempt(() => this.unsubscribe?.());
    this.unsubscribe = undefined;
    attempt(() => this.loadMoreBridge?.update(emptyLoadMoreParents));
    attempt(() => this.loadMoreBridge?.dispose());
    this.loadMoreBridge = undefined;
    this.pendingLoadMore.clear();
    this.sourceMutationDepthByGeneration.clear();
    attempt(() => this.element.removeEventListener("pointerleave", this.onPointerLeave));
    attempt(() => this.element.removeEventListener("mouseleave", this.onPointerLeave));
    attempt(() => this.element.removeEventListener("focusout", this.onPointerLeave));
    attempt(() => this.outline.removeEventListener(
      this.selectedNodeChangedEvent,
      this.onSelectedNodeChanged,
      this,
    ));
    attempt(() => this.outline.removeEventListener(
      this.elementCollapsedEvent,
      this.onElementCollapsed,
      this,
    ));
    attempt(() => this.outline.removeEventListener(
      this.elementExpandedEvent,
      this.onElementExpanded,
      this,
    ));
    this.model.clearDocumentEventListeners();
    this.selectionSync = true;
    try {
      attempt(() => this.outline.selectDOMNode(null, false));
      attempt(() => {
        this.outline.rootDOMNode = null;
      });
    } finally {
      this.selectionSync = false;
    }
    if (this.outlineWired) {
      this.outlineWired = false;
      attempt(() => this.outline.unwireFromDOMModel(this.model));
    }
    attempt(() => this.outline.dispose?.());
    attempt(() => this.model.dispose());
    attempt(() => this.element.remove());
    attempt(() => this.cleanupRuntime?.());
    throwCleanupFailures(failures);
  }

  private readonly onSourceChanged = (): void => {
    if (this.disposed) return;
    try {
      this.synchronize(false);
    } catch (error) {
      this.report(error);
    }
  };

  private synchronize(
    forceTopology: boolean,
    DOMDocument?: ChromiumElementsRuntime["DOMDocument"],
  ): void {
    if (this.disposed) return;
    const snapshot = this.treeDataSource.snapshot();
    const rebuild = forceTopology || !this.lastSnapshot ||
      !this.model.canReuseDocument(this.lastSnapshot, snapshot);
    if (rebuild) {
      this.documentGeneration += 1;
      this.pendingLoadMore.clear();
      this.sourceMutationDepthByGeneration.clear();
      const DocumentConstructor = DOMDocument ?? this.model.documentConstructor();
      if (!DocumentConstructor) {
        throw new Error("Chromium DOMDocument constructor is not registered");
      }
      this.model.setDocumentConstructor(DocumentConstructor);
      const previousDocumentRevision = this.model.documentRevision();
      this.model.clearDocumentEventListeners();
      const document = this.model.createDocument(
        snapshot,
        this.options.documentURL ?? "",
      );
      this.selectionSync = true;
      try {
        this.outline.selectDOMNode(null, false);
        this.outline.rootDOMNode = document;
      } finally {
        this.selectionSync = false;
      }
      if (
        this.hoveredNodeRef !== undefined &&
        (this.model.documentRevision() !== previousDocumentRevision ||
          !this.model.isInspectable(this.hoveredNodeRef))
      ) {
        this.updateHoveredNode(undefined);
      }
    } else {
      this.model.reconcileSnapshotStructure(snapshot);
      this.model.applySnapshot(snapshot);
    }
    this.lastSnapshot = snapshot;
    this.indexDesiredExpansions(snapshot);
    this.selectionSync = true;
    try {
      this.reconcileVisibleExpansion(snapshot);
      this.applySnapshotSelection(snapshot);
    } finally {
      this.selectionSync = false;
    }
    this.updateLoadMoreBridge(snapshot);
  }

  private beginSourceMutation(documentGeneration: number): void {
    const depth = this.sourceMutationDepthByGeneration.get(documentGeneration) ?? 0;
    this.sourceMutationDepthByGeneration.set(documentGeneration, depth + 1);
  }

  private finishSourceMutation(documentGeneration: number): boolean {
    const depth = this.sourceMutationDepthByGeneration.get(documentGeneration);
    if (depth === undefined) return false;
    if (depth > 1) {
      this.sourceMutationDepthByGeneration.set(documentGeneration, depth - 1);
      return false;
    }
    this.sourceMutationDepthByGeneration.delete(documentGeneration);
    return !this.disposed && documentGeneration === this.documentGeneration;
  }

  private applySnapshotSelection(snapshot: TreePresentationSnapshot): void {
    const row = snapshot.rows.find((candidate) =>
      candidate.type === "node" && candidate.selected &&
      candidate.node?.selectable !== false);
    const node = row ? this.model.nodeForRef(row.nodeRef) : null;
    this.outline.selectDOMNode(node, Boolean(row?.focused));
  }

  private indexDesiredExpansions(snapshot: TreePresentationSnapshot): void {
    const expandedChildren = new Map<string | undefined, string[]>();
    for (const row of snapshot.rows) {
      if (row.type !== "node" || !row.expanded) continue;
      const children = expandedChildren.get(row.parentRef) ?? [];
      children.push(row.nodeRef);
      expandedChildren.set(row.parentRef, children);
    }
    this.desiredExpandedChildren = expandedChildren;
  }

  private reconcileVisibleExpansion(snapshot: TreePresentationSnapshot): void {
    for (const row of snapshot.rows) {
      if (row.type !== "node") continue;
      const node = this.model.nodeForRef(row.nodeRef);
      if (!node) continue;
      const treeElement = this.outline.findTreeElement(node);
      if (!treeElement) continue;
      if (row.expanded) {
        if (!treeElement.expanded) treeElement.expand();
      } else if (treeElement.expanded) {
        treeElement.collapse();
      }
    }
  }

  private expandDesiredChildren(parentRef: string | undefined): void {
    for (const nodeRef of this.desiredExpandedChildren.get(parentRef) ?? []) {
      const node = this.model.nodeForRef(nodeRef);
      const treeElement = node ? this.outline.findTreeElement(node) : null;
      if (treeElement && !treeElement.expanded) treeElement.expand();
    }
  }

  private async requestChildren(
    nodeId: number,
    requestingNode: ChromiumDOMNode,
  ): Promise<ChromiumDOMAgentResponse> {
    if (this.disposed) {
      return failedAgentResponse("Pin-op Chromium DOM model is disposed");
    }
    const nodeRef = this.model.nodeRefForId(nodeId);
    if (!nodeRef) {
      return failedAgentResponse(`Unknown Chromium DOM node id: ${nodeId}`);
    }
    let response = successfulAgentResponse;
    let reportedError: unknown;
    const documentGeneration = this.documentGeneration;
    this.beginSourceMutation(documentGeneration);
    try {
      await this.treeDataSource.expand(nodeRef);
      if (this.disposed) {
        response = failedAgentResponse("Pin-op Chromium DOM model is disposed");
      } else if (this.model.nodeForRef(nodeRef) !== requestingNode) {
        response = failedAgentResponse("Pin-op Chromium DOM node authority changed");
      } else {
        const snapshot = this.treeDataSource.snapshot();
        if (!this.model.hydrateDOMChildren(
          requestingNode,
          nodeRef,
          snapshot,
        )) {
          response = failedAgentResponse("Pin-op Chromium DOM node authority changed");
        } else {
          this.updateLoadMoreBridge(snapshot);
        }
      }
    } catch (error) {
      reportedError = error;
      if (!this.disposed) this.report(error);
      response = failedAgentResponse(
        this.disposed ? "Pin-op Chromium DOM model is disposed" : describeError(error),
      );
    } finally {
      if (this.finishSourceMutation(documentGeneration)) {
        try {
          this.synchronize(false);
        } catch (error) {
          if (!this.disposed && error !== reportedError) this.report(error);
          if (!response.getError()) {
            response = failedAgentResponse(
              this.disposed ? "Pin-op Chromium DOM model is disposed" : describeError(error),
            );
          }
        }
        if (!response.getError()) {
          queueMicrotask(() => {
            if (this.disposed) return;
            try {
              this.expandDesiredChildren(nodeRef);
            } catch (error) {
              this.report(error);
            }
          });
        }
      }
    }
    return response;
  }

  private readonly onSelectedNodeChanged = (
    event: { readonly data: unknown },
  ): void => {
    if (this.disposed || this.selectionSync) return;
    const { node, focus } = event.data as SelectedNodeChangedData;
    if (!node) {
      this.restoreSnapshotSelection();
      return;
    }
    const nodeRef = this.model.nodeRefForId(node.id);
    if (
      !nodeRef ||
      !this.model.isSelectable(nodeRef) ||
      this.model.nodeForRef(nodeRef) !== node
    ) {
      this.restoreSnapshotSelection();
      return;
    }
    if (focus) {
      try {
        this.treeDataSource.focus(nodeRef);
      } catch (error) {
        this.report(error);
        this.restoreSnapshotSelection();
        return;
      }
      if (
        this.disposed ||
        this.model.nodeForRef(nodeRef) !== node ||
        !this.model.isSelectable(nodeRef)
      ) {
        this.restoreSnapshotSelection();
        return;
      }
    }
    let selection: Promise<void>;
    try {
      selection = this.treeDataSource.select(nodeRef);
    } catch (error) {
      this.report(error);
      this.restoreSnapshotSelection();
      return;
    }
    void selection.catch(error => {
      if (this.disposed) return;
      this.report(error);
      this.restoreSnapshotSelection();
    });
  };

  private readonly onElementCollapsed = (
    event: { readonly data: unknown },
  ): void => {
    if (this.disposed || this.selectionSync) return;
    const treeElement = event.data as ChromiumTreeElement;
    const node = treeElement.node?.();
    if (!node) return;
    const nodeRef = this.model.nodeRefForId(node.id);
    if (!nodeRef || this.model.nodeForRef(nodeRef) !== node) return;
    const row = this.treeDataSource.snapshot().rows.find(candidate =>
      candidate.type === "node" &&
      candidate.nodeRef === nodeRef &&
      candidate.expanded &&
      candidate.expandable);
    if (!row) return;
    const documentGeneration = this.documentGeneration;
    this.beginSourceMutation(documentGeneration);
    try {
      this.treeDataSource.collapse(nodeRef);
    } catch (error) {
      this.report(error);
    } finally {
      if (this.finishSourceMutation(documentGeneration)) this.synchronize(false);
    }
  };

  private readonly onElementExpanded = (
    event: { readonly data: unknown },
  ): void => {
    if (this.disposed) return;
    const treeElement = event.data as ChromiumTreeElement;
    const node = treeElement.node?.();
    if (!node) return;
    const nodeRef = this.model.nodeRefForId(node.id);
    if (!nodeRef || this.model.nodeForRef(nodeRef) !== node) return;
    this.expandDesiredChildren(nodeRef);
    if (this.selectionSync || node.children() === null) return;
    void this.expandLoadedBranch(node, nodeRef).catch(error => {
      if (!this.disposed) this.report(error);
    });
  };

  private async expandLoadedBranch(
    node: ChromiumDOMNode,
    nodeRef: string,
  ): Promise<void> {
    const documentGeneration = this.documentGeneration;
    this.beginSourceMutation(documentGeneration);
    try {
      await this.treeDataSource.expand(nodeRef);
      if (this.disposed || this.model.nodeForRef(nodeRef) !== node) return;
    } catch (error) {
      if (!this.disposed) this.report(error);
    } finally {
      if (this.finishSourceMutation(documentGeneration)) this.synchronize(false);
    }
  }

  private readonly onLoadMoreRequested = (
    authority: ChromiumLoadMoreParent,
  ): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    const parent = authority.parent;
    const parentRef = this.model.nodeRefForId(parent.id);
    if (
      !parentRef ||
      this.model.nodeForRef(parentRef) !== parent ||
      !sameLoadMorePresentationAuthority(
        authority,
        this.model.loadMoreParents(this.treeDataSource.snapshot())
          .find(candidate => candidate.parent === parent),
      )
    ) {
      return Promise.resolve();
    }
    const documentGeneration = this.documentGeneration;
    const existing = this.pendingLoadMore.get(parentRef);
    if (
      existing?.parent === parent &&
      existing.documentGeneration === documentGeneration
    ) {
      return existing.promise;
    }
    let pending: PendingLoadMoreRequest;
    const request = this.performLoadMore(
      authority,
      parentRef,
      documentGeneration,
    ).finally(() => {
      if (this.pendingLoadMore.get(parentRef) === pending) {
        this.pendingLoadMore.delete(parentRef);
      }
    });
    pending = Object.freeze({
      parent,
      documentGeneration,
      promise: request,
    });
    this.pendingLoadMore.set(parentRef, pending);
    return request;
  };

  private async performLoadMore(
    authority: ChromiumLoadMoreParent,
    parentRef: string,
    documentGeneration: number,
  ): Promise<void> {
    const parent = authority.parent;
    if (documentGeneration !== this.documentGeneration) return;
    const serviceRow = loadMoreRowFor(
      this.treeDataSource.snapshot(),
      parentRef,
      authority.serviceRowRef,
    );
    if (!serviceRow) return;
    this.beginSourceMutation(documentGeneration);
    try {
      this.treeDataSource.focus(serviceRow.nodeRef);
      if (
        this.disposed ||
        documentGeneration !== this.documentGeneration ||
        this.model.nodeForRef(parentRef) !== parent ||
        !sameLoadMoreRowAuthority(
          serviceRow,
          loadMoreRowFor(
            this.treeDataSource.snapshot(),
            parentRef,
            authority.serviceRowRef,
          ),
        )
      ) {
        return;
      }
      await this.treeDataSource.loadMore(parentRef);
      if (
        this.disposed ||
        documentGeneration !== this.documentGeneration ||
        this.model.nodeForRef(parentRef) !== parent
      ) return;
      const snapshot = this.treeDataSource.snapshot();
      if (!this.model.hydrateDOMChildren(
        parent,
        parentRef,
        snapshot,
      )) return;
    } catch (error) {
      if (
        !this.disposed &&
        documentGeneration === this.documentGeneration
      ) this.report(error);
    } finally {
      if (this.finishSourceMutation(documentGeneration)) this.synchronize(false);
    }
  }

  private readonly onPointerLeave = (): void => {
    this.updateHoveredNode(undefined);
  };

  private onChromiumHover(node: ChromiumDOMNode | null): void {
    if (this.disposed) return;
    const nodeRef = node ? this.model.nodeRefForId(node.id) : undefined;
    const inspectableRef = nodeRef && node &&
      this.model.nodeForRef(nodeRef) === node &&
      this.model.isInspectable(nodeRef) ? nodeRef : undefined;
    this.updateHoveredNode(inspectableRef);
  }

  private updateHoveredNode(nodeRef: string | undefined): void {
    if (this.disposed || this.hoveredNodeRef === nodeRef) return;
    this.hoveredNodeRef = nodeRef;
    try {
      this.treeDataSource.hover(nodeRef);
    } catch (error) {
      this.report(error);
    }
  }

  private updateLoadMoreBridge(snapshot: TreePresentationSnapshot): void {
    if (this.disposed) return;
    try {
      this.loadMoreBridge?.update(this.model.loadMoreParents(snapshot));
    } catch (error) {
      this.report(error);
    }
  }

  private restoreSnapshotSelection(): void {
    if (this.disposed || this.selectionSync) return;
    this.selectionSync = true;
    try {
      this.applySnapshotSelection(this.treeDataSource.snapshot());
    } finally {
      this.selectionSync = false;
    }
  }

  private report(error: unknown): void {
    try {
      this.reportError(error);
    } catch {
      // A diagnostic callback cannot acquire renderer authority.
    }
  }
}

class PinOpDOMModel implements ChromiumDOMModel {
  public readonly agent: ChromiumDOMAgent;
  private readonly nodesById = new Map<number, ChromiumDOMNode>();
  private readonly nodeIdsByRef = new Map<string, number>();
  private readonly nodeRefsById = new Map<number, string>();
  private readonly selectableRefs = new Set<string>();
  private readonly inspectableRefs = new Set<string>();
  private readonly snapshotsByRef = new Map<string, InspectorNodeSnapshot>();
  private readonly structureByRef = new Map<string, string>();
  private readonly listeners = new Map<string, ModelEventListener[]>();
  private readonly css = new ReadOnlyCSSModel();
  private readonly overlay: ReadOnlyOverlayModel;
  private nextNodeId = syntheticDocumentNodeId + 1;
  private document: ChromiumDOMNode | null = null;
  private DOMDocument: ChromiumElementsRuntime["DOMDocument"] | undefined;
  private currentDocumentIdentity: string | undefined;
  private documentRevisionValue = 0;
  private persistentEventListenersSealed = false;
  private disposed = false;
  private readonly chromiumTarget: ChromiumTarget = {
    targetManager: () => ({
      getFrameManager: () => ({
        getFrame: () => null,
        getOrWaitForFrame: async () => null,
      }),
    }),
  };

  public constructor(
    private readonly requestChildren: (
      nodeId: number,
      requestingNode: ChromiumDOMNode,
    ) => Promise<ChromiumDOMAgentResponse>,
    hoverNode: (node: ChromiumDOMNode | null) => void,
  ) {
    const requestChildNodes = async (
      request: {
        readonly nodeId: number;
        readonly depth?: number;
        readonly pierce?: boolean;
      },
    ): Promise<ChromiumDOMAgentResponse> => {
      if (this.disposed) {
        return failedAgentResponse("Pin-op Chromium DOM model is disposed");
      }
      if (request.depth !== undefined || request.pierce !== undefined) {
        return failedAgentResponse(
          "Pin-op bounded child requests do not allow depth or pierce",
        );
      }
      const requestingNode = this.nodesById.get(request.nodeId);
      if (!requestingNode) {
        return failedAgentResponse(`Unknown Chromium DOM node id: ${request.nodeId}`);
      }
      return this.requestChildren(request.nodeId, requestingNode);
    };
    const agentTarget = Object.freeze({
      invoke_requestChildNodes: requestChildNodes,
    }) as ChromiumDOMAgent;
    this.agent = new Proxy(agentTarget, {
      get: (target, property, receiver) => {
        if (property === "invoke_requestChildNodes") {
          return Reflect.get(target, property, receiver);
        }
        if (typeof property === "string" && property.startsWith("invoke_")) {
          return async (): Promise<ChromiumDOMAgentResponse> =>
            failedAgentResponse(
              `Pin-op Chromium DOM agent is read-only; ${property} is forbidden`,
            );
        }
        return Reflect.get(target, property, receiver);
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
    this.overlay = new ReadOnlyOverlayModel(hoverNode);
  }

  public target(): ChromiumTarget {
    return this.chromiumTarget;
  }

  public getAgent(): ChromiumDOMAgent {
    return this.agent;
  }

  public registerNode(node: ChromiumDOMNode): void {
    this.nodesById.set(node.id, node);
  }

  public nodeForId(nodeId: number): ChromiumDOMNode | null {
    return this.nodesById.get(nodeId) ?? null;
  }

  public nodeForRef(nodeRef: string): ChromiumDOMNode | null {
    const nodeId = this.nodeIdsByRef.get(nodeRef);
    return nodeId === undefined ? null : this.nodeForId(nodeId);
  }

  public nodeRefForId(nodeId: number): string | undefined {
    return this.nodeRefsById.get(nodeId);
  }

  public isSelectable(nodeRef: string): boolean {
    return this.selectableRefs.has(nodeRef);
  }

  public isInspectable(nodeRef: string): boolean {
    return this.inspectableRefs.has(nodeRef);
  }

  public addEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push({
      listener,
      thisObject,
      persistent: !this.persistentEventListenersSealed,
    });
    this.listeners.set(eventName, listeners);
  }

  public removeEventListener(
    eventName: string,
    listener: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void {
    const listeners = this.listeners.get(eventName) ?? [];
    this.listeners.set(eventName, listeners.filter((candidate) =>
      candidate.listener !== listener || candidate.thisObject !== thisObject));
  }

  public dispatchEventToListeners(eventName: string, data: unknown): void {
    for (const candidate of [...(this.listeners.get(eventName) ?? [])]) {
      candidate.listener.call(candidate.thisObject, { data });
    }
  }

  public cssModel(): ChromiumCSSModel {
    return this.css;
  }

  public overlayModel(): ChromiumOverlayModel {
    return this.overlay;
  }

  public existingDocument(): ChromiumDOMNode | null {
    return this.document;
  }

  public async requestDocument(): Promise<ChromiumDOMNode | null> {
    return this.document;
  }

  public setDocumentConstructor(
    DOMDocument: ChromiumElementsRuntime["DOMDocument"],
  ): void {
    this.DOMDocument = DOMDocument;
  }

  public documentConstructor(): ChromiumElementsRuntime["DOMDocument"] | undefined {
    return this.DOMDocument;
  }

  public sealPersistentEventListeners(): void {
    this.persistentEventListenersSealed = true;
  }

  public clearDocumentEventListeners(): void {
    for (const [eventName, listeners] of this.listeners) {
      const persistent = listeners.filter(listener => listener.persistent);
      if (persistent.length > 0) {
        this.listeners.set(eventName, persistent);
      } else {
        this.listeners.delete(eventName);
      }
    }
  }

  public listenerCountForTest(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.length;
    return count;
  }

  public documentRevision(): number {
    return this.documentRevisionValue;
  }

  public canReuseDocument(
    previous: TreePresentationSnapshot,
    current: TreePresentationSnapshot,
  ): boolean {
    const previousGraph = new SnapshotGraph(previous);
    const currentGraph = new SnapshotGraph(current);
    if (currentGraph.documentIdentity() !== this.currentDocumentIdentity) return false;
    if (!equalNodeRefs(
      previousGraph.topLevelRows().map(row => row.nodeRef),
      currentGraph.topLevelRows().map(row => row.nodeRef),
    )) {
      return false;
    }
    const reconcilableMissingRows = new Set<string>();
    for (const row of currentGraph.rows()) {
      const node = this.nodeForRef(row.nodeRef);
      if (node) {
        if (this.structureByRef.get(row.nodeRef) !== structureKey(row)) return false;
        continue;
      }
      const parentRef = row.parentRef;
      if (!parentRef) return false;
      if (reconcilableMissingRows.has(parentRef)) {
        reconcilableMissingRows.add(row.nodeRef);
        continue;
      }
      const parentRow = currentGraph.rowForRef(parentRef);
      if (
        !parentRow?.expanded ||
        !this.nodeForRef(parentRef) ||
        row.node?.relationship !== "dom"
      ) return false;
      reconcilableMissingRows.add(row.nodeRef);
    }
    const hiddenRows = new Set<string>();
    const removedDOMRows = new Set<string>();
    for (const row of previousGraph.rows()) {
      if (currentGraph.rowForRef(row.nodeRef)) continue;
      const parentRef = row.parentRef;
      const parent = parentRef ? currentGraph.rowForRef(parentRef) : undefined;
      if (!parentRef) return false;
      if (hiddenRows.has(parentRef) || (parent && !parent.expanded)) {
        hiddenRows.add(row.nodeRef);
        continue;
      }
      if (
        removedDOMRows.has(parentRef) ||
        (parent?.expanded && row.node?.relationship === "dom")
      ) {
        removedDOMRows.add(row.nodeRef);
        continue;
      }
      return false;
    }
    return true;
  }

  public reconcileSnapshotStructure(snapshot: TreePresentationSnapshot): void {
    const graph = new SnapshotGraph(snapshot);
    for (const row of graph.rows()) {
      if (!row.expanded || !row.node) continue;
      const parent = this.nodeForRef(row.nodeRef);
      if (!parent) continue;
      const desiredRows = graph.domChildRows(row.nodeRef);
      const currentChildren = parent.children();
      const desiredRefs = desiredRows.map(child => child.nodeRef);
      if (currentChildren === null) {
        if (desiredRows.length === 0) continue;
        parent.setChildrenPayload(
          desiredRows.map(child => this.payloadForRow(graph, child)),
        );
        parent.setChildNodeCount(row.node.childCount);
        this.dispatchEventToListeners("ChildNodeCountUpdated", parent);
        continue;
      }
      if (equalNodeRefs(
        currentChildren.map(child => this.nodeRefForId(child.id)),
        desiredRefs,
      )) continue;
      this.reconcileDOMChildren(parent, row, desiredRows, graph);
    }
  }

  public applySnapshot(snapshot: TreePresentationSnapshot): void {
    const graph = new SnapshotGraph(snapshot);
    this.selectableRefs.clear();
    this.inspectableRefs.clear();
    for (const row of graph.rows()) {
      const next = row.node;
      if (!next) continue;
      if (next.selectable !== false) this.selectableRefs.add(row.nodeRef);
      if (next.kind === "element" && next.selectable) {
        this.inspectableRefs.add(row.nodeRef);
      }
      const node = this.nodeForRef(row.nodeRef);
      const previous = this.snapshotsByRef.get(row.nodeRef);
      if (node && previous) {
        this.applyContentChanges(node, previous, next);
      }
      this.snapshotsByRef.set(row.nodeRef, next);
      this.structureByRef.set(row.nodeRef, structureKey(row));
    }
  }

  public createDocument(
    snapshot: TreePresentationSnapshot,
    documentURL: string,
  ): ChromiumDOMNode {
    if (!this.DOMDocument) {
      throw new Error("Chromium DOMDocument constructor is not registered");
    }
    const graph = new SnapshotGraph(snapshot);
    const nextDocumentIdentity = graph.documentIdentity();
    if (
      nextDocumentIdentity !== undefined &&
      this.currentDocumentIdentity !== undefined &&
      nextDocumentIdentity !== this.currentDocumentIdentity
    ) {
      this.nodeIdsByRef.clear();
      this.nodeRefsById.clear();
      this.documentRevisionValue += 1;
    }
    if (nextDocumentIdentity !== undefined) {
      this.currentDocumentIdentity = nextDocumentIdentity;
    }
    this.snapshotsByRef.clear();
    this.structureByRef.clear();
    this.nodesById.clear();
    const payload: ChromiumDOMNodePayload = {
      nodeId: syntheticDocumentNodeId,
      backendNodeId: syntheticDocumentNodeId,
      nodeType: 9,
      nodeName: "#document",
      localName: "",
      nodeValue: "",
      childNodeCount: graph.topLevelRows().length,
      children: graph.topLevelRows().map((row) => this.payloadForRow(graph, row)),
      documentURL,
      baseURL: documentURL,
    };
    this.document = new this.DOMDocument(this, payload);
    this.restoreSourceChildNodeCounts(graph);
    this.applySnapshot(snapshot);
    return this.document;
  }

  public hydrateDOMChildren(
    node: ChromiumDOMNode,
    nodeRef: string,
    snapshot: TreePresentationSnapshot,
  ): boolean {
    const graph = new SnapshotGraph(snapshot);
    const sourceRow = graph.rowForRef(nodeRef);
    if (!sourceRow?.node || this.nodeForRef(nodeRef) !== node) return false;
    const childRows = graph.domChildRows(nodeRef);
    const existingChildren = node.children();
    const existingRefs = existingChildren?.map(child => this.nodeRefForId(child.id));
    const canAppend = existingRefs !== undefined && existingRefs.every(
      (childRef, index) => childRef === childRows[index]?.nodeRef,
    );
    let structureChanged = false;
    let structureEventDispatched = false;
    if (existingChildren === null) {
      node.setChildrenPayload(
        childRows.map((row) => this.payloadForRow(graph, row)),
      );
      structureChanged = true;
    } else if (!canAppend) {
      this.reconcileDOMChildren(node, sourceRow, childRows, graph);
      structureEventDispatched = true;
    } else {
      let previous = existingChildren.at(-1);
      for (const row of childRows.slice(existingChildren.length)) {
        previous = node.insertChild(
          previous,
          this.payloadForRow(graph, row),
        );
        structureChanged = true;
      }
    }
    node.setChildNodeCount(sourceRow.node.childCount);
    this.applySnapshot(snapshot);
    if (structureChanged && !structureEventDispatched) {
      this.dispatchEventToListeners("ChildNodeCountUpdated", node);
    }
    return true;
  }

  public loadMoreParents(
    snapshot: TreePresentationSnapshot,
  ): readonly ChromiumLoadMoreParent[] {
    const graph = new SnapshotGraph(snapshot);
    const presentedParents = new Set<string>();
    const parents: ChromiumLoadMoreParent[] = [];
    for (const serviceRow of graph.loadMoreRows()) {
      const parentRef = serviceRow.parentRef;
      if (!parentRef || presentedParents.has(parentRef)) continue;
      const parent = this.nodeForRef(parentRef);
      const parentRow = graph.rowForRef(parentRef);
      if (!parent || !parentRow?.node) continue;
      const loadedChildCount = graph.childRows(parentRef).length;
      const totalChildCount = parentRow.node.childCount;
      parents.push(Object.freeze({
        parent,
        serviceRowRef: serviceRow.nodeRef,
        focused: serviceRow.focused,
        hasMore: true as const,
        loadedChildCount,
        totalChildCount,
        remainingChildCount: Math.max(0, totalChildCount - loadedChildCount),
      }));
      presentedParents.add(parentRef);
    }
    return Object.freeze(parents);
  }

  public dispose(): void {
    this.disposed = true;
    this.document = null;
    this.nodesById.clear();
    this.nodeIdsByRef.clear();
    this.nodeRefsById.clear();
    this.selectableRefs.clear();
    this.inspectableRefs.clear();
    this.snapshotsByRef.clear();
    this.structureByRef.clear();
    this.listeners.clear();
  }

  private payloadForRow(
    graph: SnapshotGraph,
    row: TreeRowSnapshot,
  ): ChromiumDOMNodePayload {
    const snapshot = row.node;
    if (!snapshot) {
      throw new Error(`Chromium node row is missing its payload: ${row.nodeRef}`);
    }
    const nodeId = this.nodeIdForRef(row.nodeRef);
    const domChildren = graph.domChildRows(row.nodeRef);
    const shadowRoots = graph.shadowRootRows(row.nodeRef);
    const frameDocument = graph.frameDocumentRow(row.nodeRef);
    const payload: ChromiumDOMNodePayload = {
      nodeId,
      backendNodeId: nodeId,
      nodeType: snapshot.nodeType,
      nodeName: snapshot.nodeName,
      localName: snapshot.nodeType === 1 ? snapshot.nodeName.toLowerCase() : "",
      nodeValue: snapshot.nodeValue ?? "",
      attributes: flattenAttributes(snapshot),
      childNodeCount: snapshot.childCount,
      ...(domChildren.length > 0 ? {
        children: domChildren.map((child) => this.payloadForRow(graph, child)),
      } : {}),
      ...(shadowRoots.length > 0 ? {
        shadowRoots: shadowRoots.map((root) => this.payloadForRow(graph, root)),
      } : {}),
      ...(frameDocument ? {
        contentDocument: this.payloadForRow(graph, frameDocument),
      } : {}),
      ...(snapshot.kind === "shadow-root" ? {
        shadowRootType: shadowRootType(snapshot.nodeValue),
      } : {}),
      ...(snapshot.kind === "document-type" ? {
        publicId: snapshot.publicId ?? "",
        systemId: snapshot.systemId ?? "",
        internalSubset: "",
      } : {}),
      ...(snapshot.kind === "frame-document" ? {
        documentURL: "",
        baseURL: "",
      } : {}),
    };
    return payload;
  }

  private restoreSourceChildNodeCounts(graph: SnapshotGraph): void {
    for (const row of graph.rows()) {
      const node = this.nodeForRef(row.nodeRef);
      if (node && row.node) node.setChildNodeCount(row.node.childCount);
    }
  }

  private applyContentChanges(
    node: ChromiumDOMNode,
    previous: InspectorNodeSnapshot,
    next: InspectorNodeSnapshot,
  ): void {
    const previousAttributes = new Map(
      previous.attributes.map(attribute => [attribute.name, attribute.value]),
    );
    const nextAttributes = new Map(
      next.attributes.map(attribute => [attribute.name, attribute.value]),
    );
    if (!equalAttributes(previous.attributes, next.attributes)) {
      node.setAttributesPayload([...flattenAttributes(next)]);
      for (const [name, value] of nextAttributes) {
        if (previousAttributes.get(name) !== value) {
          this.dispatchEventToListeners("AttrModified", { node, name });
        }
      }
      for (const name of previousAttributes.keys()) {
        if (!nextAttributes.has(name)) {
          this.dispatchEventToListeners("AttrRemoved", { node, name });
        }
      }
    }
    if ((previous.nodeValue ?? "") !== (next.nodeValue ?? "")) {
      node.setNodeValueInternal(next.nodeValue ?? "");
      this.dispatchEventToListeners("CharacterDataModified", node);
    }
    if (previous.childCount !== next.childCount) {
      node.setChildNodeCount(next.childCount);
      this.dispatchEventToListeners("ChildNodeCountUpdated", node);
    }
  }

  private reconcileDOMChildren(
    parent: ChromiumDOMNode,
    parentRow: TreeRowSnapshot,
    desiredRows: readonly TreeRowSnapshot[],
    graph: SnapshotGraph,
  ): void {
    const currentChildren = parent.children() ?? [];
    const currentByRef = new Map<string, ChromiumDOMNode>();
    for (const child of currentChildren) {
      const childRef = this.nodeRefForId(child.id);
      if (childRef) currentByRef.set(childRef, child);
    }
    const desiredChildren: ChromiumDOMNode[] = [];
    let insertionTail = currentChildren.at(-1);
    for (const row of desiredRows) {
      let child = currentByRef.get(row.nodeRef);
      if (!child) {
        const detached = this.nodeForRef(row.nodeRef);
        if (detached?.parentNode === null) child = detached;
      }
      if (!child) {
        child = parent.insertChild(
          insertionTail,
          this.payloadForRow(graph, row),
        );
        insertionTail = child;
      }
      desiredChildren.push(child);
    }
    const desiredSet = new Set(desiredChildren);
    const removedChildren = currentChildren.filter(child => !desiredSet.has(child));
    parent.setChildren(desiredChildren);
    relinkChildren(parent, desiredChildren);
    for (const child of removedChildren) {
      detachNode(child);
      this.dropDetachedSubtree(child);
    }
    parent.setChildNodeCount(parentRow.node?.childCount ?? desiredChildren.length);
    this.dispatchEventToListeners("ChildNodeCountUpdated", parent);
  }

  private dropDetachedSubtree(node: ChromiumDOMNode): void {
    for (const child of node.children() ?? []) this.dropDetachedSubtree(child);
    for (const root of node.shadowRoots?.() ?? []) this.dropDetachedSubtree(root);
    const contentDocument = node.contentDocument?.();
    if (contentDocument) this.dropDetachedSubtree(contentDocument);
    const nodeRef = this.nodeRefsById.get(node.id);
    this.nodesById.delete(node.id);
    if (!nodeRef) return;
    this.nodeIdsByRef.delete(nodeRef);
    this.nodeRefsById.delete(node.id);
    this.selectableRefs.delete(nodeRef);
    this.inspectableRefs.delete(nodeRef);
    this.snapshotsByRef.delete(nodeRef);
    this.structureByRef.delete(nodeRef);
  }

  private nodeIdForRef(nodeRef: string): number {
    const existing = this.nodeIdsByRef.get(nodeRef);
    if (existing !== undefined) return existing;
    if (!Number.isSafeInteger(this.nextNodeId)) {
      throw new Error("Pin-op Chromium DOM node id space is exhausted");
    }
    const nodeId = this.nextNodeId;
    this.nextNodeId += 1;
    this.nodeIdsByRef.set(nodeRef, nodeId);
    this.nodeRefsById.set(nodeId, nodeRef);
    return nodeId;
  }
}

class SnapshotGraph {
  private readonly nodeRows: readonly TreeRowSnapshot[];
  private readonly loadMoreRowsInternal: readonly TreeRowSnapshot[];
  private readonly rowsByRef = new Map<string, TreeRowSnapshot>();
  private readonly rowsByParentRef = new Map<string | undefined, TreeRowSnapshot[]>();

  public constructor(snapshot: TreePresentationSnapshot) {
    const seen = new Set<string>();
    const depthStack: Array<TreeRowSnapshot | undefined> = [];
    const rows: TreeRowSnapshot[] = [];
    const loadMoreRows: TreeRowSnapshot[] = [];
    for (const row of snapshot.rows) {
      if (row.type !== "node") {
        loadMoreRows.push(row);
        continue;
      }
      if (!row.node) {
        throw new Error(`Chromium node row is missing its payload: ${row.nodeRef}`);
      }
      if (seen.has(row.nodeRef)) {
        throw new Error(`Duplicate Chromium node ref: ${row.nodeRef}`);
      }
      seen.add(row.nodeRef);
      const inferredParent = row.depth > 0
        ? depthStack[row.depth - 1]?.nodeRef
        : undefined;
      const parentRef = row.parentRef ?? inferredParent;
      const normalized = parentRef === row.parentRef
        ? row
        : { ...row, parentRef };
      rows.push(normalized);
      this.rowsByRef.set(normalized.nodeRef, normalized);
      const siblings = this.rowsByParentRef.get(parentRef) ?? [];
      siblings.push(normalized);
      this.rowsByParentRef.set(parentRef, siblings);
      depthStack[row.depth] = normalized;
      depthStack.length = row.depth + 1;
    }
    this.nodeRows = rows;
    this.loadMoreRowsInternal = loadMoreRows;
  }

  public rows(): readonly TreeRowSnapshot[] {
    return this.nodeRows;
  }

  public topLevelRows(): readonly TreeRowSnapshot[] {
    return this.rowsByParentRef.get(undefined) ?? [];
  }

  public rowForRef(nodeRef: string): TreeRowSnapshot | undefined {
    return this.rowsByRef.get(nodeRef);
  }

  public loadMoreRows(): readonly TreeRowSnapshot[] {
    return this.loadMoreRowsInternal;
  }

  public documentIdentity(): string | undefined {
    const topLevelRows = this.topLevelRows();
    return topLevelRows.find(row =>
      row.node?.kind === "element" && row.node.relationship === "dom")?.nodeRef ??
      topLevelRows.find(row =>
        row.node?.kind !== "document-type" && row.node?.kind !== "comment")?.nodeRef ??
      topLevelRows[0]?.nodeRef;
  }

  public domChildRows(nodeRef: string): readonly TreeRowSnapshot[] {
    return this.childRows(nodeRef).filter((row) => row.node?.relationship === "dom");
  }

  public shadowRootRows(nodeRef: string): readonly TreeRowSnapshot[] {
    return this.childRows(nodeRef).filter((row) =>
      row.node?.relationship === "shadow-root");
  }

  public frameDocumentRow(nodeRef: string): TreeRowSnapshot | undefined {
    return this.childRows(nodeRef).find((row) =>
      row.node?.relationship === "frame-document");
  }

  public childRows(nodeRef: string): readonly TreeRowSnapshot[] {
    return this.rowsByParentRef.get(nodeRef) ?? [];
  }
}

class ReadOnlyCSSModel implements ChromiumCSSModel {
  public async getLayoutPropertiesFromComputedStyle(_nodeId: number): Promise<null> {
    return null;
  }
}

class ReadOnlyOverlayModel implements ChromiumOverlayModel {
  public constructor(
    private readonly hoverNode: (node: ChromiumDOMNode | null) => void,
  ) {}

  public highlightInOverlay(...arguments_: readonly unknown[]): void {
    const highlight = arguments_[0];
    if (!isRecord(highlight) || !isChromiumDOMNode(highlight.node)) return;
    this.hoverNode(highlight.node);
  }

  public hideDOMNodeHighlight(): void {
    this.hoverNode(null);
  }
}

const successfulAgentResponse: ChromiumDOMAgentResponse = Object.freeze({
  getError: () => undefined,
});

const emptyLoadMoreParents: readonly ChromiumLoadMoreParent[] = Object.freeze([]);

function failedAgentResponse(message: string): ChromiumDOMAgentResponse {
  return Object.freeze({ getError: () => message });
}

function flattenAttributes(snapshot: InspectorNodeSnapshot): readonly string[] {
  return snapshot.attributes.flatMap(({ name, value }) => [name, value]);
}

function shadowRootType(
  value: string | undefined,
): "open" | "closed" | "user-agent" {
  if (value === "closed" || value === "user-agent") return value;
  return "open";
}

function loadMoreRowFor(
  snapshot: TreePresentationSnapshot,
  parentRef: string,
  serviceRowRef?: string,
): TreeRowSnapshot | undefined {
  return snapshot.rows.find(row =>
    row.type === "load-more" &&
    row.parentRef === parentRef &&
    (serviceRowRef === undefined || row.nodeRef === serviceRowRef));
}

function sameLoadMoreRowAuthority(
  expected: TreeRowSnapshot,
  current: TreeRowSnapshot | undefined,
): boolean {
  return current?.type === "load-more" &&
    current.nodeRef === expected.nodeRef &&
    current.parentRef === expected.parentRef &&
    current.depth === expected.depth;
}

function sameLoadMorePresentationAuthority(
  expected: ChromiumLoadMoreParent,
  current: ChromiumLoadMoreParent | undefined,
): boolean {
  return current?.parent === expected.parent &&
    current.serviceRowRef === expected.serviceRowRef;
}

function structureKey(row: TreeRowSnapshot): string {
  return JSON.stringify([
    row.parentRef,
    row.depth,
    row.node?.kind,
    row.node?.nodeType,
    row.node?.nodeName,
    row.node?.relationship,
  ]);
}

function equalAttributes(
  left: InspectorNodeSnapshot["attributes"],
  right: InspectorNodeSnapshot["attributes"],
): boolean {
  return left.length === right.length && left.every((attribute, index) =>
    attribute.name === right[index]?.name &&
    attribute.value === right[index]?.value);
}

function equalNodeRefs(
  left: readonly (string | undefined)[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every(
    (nodeRef, index) => nodeRef === right[index],
  );
}

function relinkChildren(
  parent: ChromiumDOMNode,
  children: readonly ChromiumDOMNode[],
): void {
  parent.firstChild = children[0] ?? null;
  parent.lastChild = children.at(-1) ?? null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    child.parentNode = parent;
    child.index = index;
    child.previousSibling = children[index - 1] ?? null;
    child.nextSibling = children[index + 1] ?? null;
  }
}

function detachNode(node: ChromiumDOMNode): void {
  node.parentNode = null;
  node.index = undefined;
  node.previousSibling = null;
  node.nextSibling = null;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isChromiumDOMNode(value: unknown): value is ChromiumDOMNode {
  if (!isRecord(value)) return false;
  try {
    return Number.isSafeInteger(value.id) &&
      typeof value.children === "function" &&
      typeof value.nodeType === "function";
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwCleanupFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "Pin-op Chromium Elements teardown failed");
}

function onceCleanup(
  cleanup: (() => void) | void,
): (() => void) | undefined {
  if (!cleanup) return undefined;
  let called = false;
  return (): void => {
    if (called) return;
    called = true;
    cleanup();
  };
}
