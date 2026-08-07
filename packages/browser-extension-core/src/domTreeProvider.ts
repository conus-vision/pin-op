import {
  DomNodeRegistry,
  type NodeScope,
  type RetentionReason,
} from "./domNodeRegistry.js";
import {
  FrameRegistry,
  type FrameContext,
  type FrameDescription,
  type FrameIdentity,
  type FrameLifecycleEvent,
  type TopViewportRect,
  type ViewportRect,
} from "./frameRegistry.js";
import {
  DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  DOM_PROTOCOL_MAX_LABEL_LENGTH,
  parseDomRequest,
} from "./domProtocol.js";
import type {
  DomChildrenResponse,
  DomErrorCode,
  DomGetChildrenRequest,
  DomInvalidationBranch,
  DomNodeView,
  DomRootResponse,
} from "./domProtocol.js";

const CHILD_PAGE_SIZE = 50;
const CHILD_PAGE_PHYSICAL_SCAN_LIMIT = 256;
const DEFAULT_MAX_RECORDS = 4_096;
const ELEMENT_LABEL_MAX_ATTRIBUTES = 4;
const ELEMENT_LABEL_MAX_ATTRIBUTE_SCAN = 32;
const ELEMENT_LABEL_MAX_CLASSES = 4;
const ELEMENT_LABEL_MAX_TOKEN_LENGTH = 64;
const FRAME_MUTATION_SCAN_LIMIT = 1_024;
const FRAME_MUTATION_OPERATION_LIMIT = FRAME_MUTATION_SCAN_LIMIT * 4;
const MAX_SHADOW_CONTAINMENT_DEPTH = 512;
const SHADOW_SCAN_BATCH_SIZE = 8;
const SHADOW_SCAN_INTERVAL_MS = 1_000;

export type DomChildrenRequest = DomGetChildrenRequest;

export class DomTreeProviderError extends Error {
  public constructor(public readonly code: DomErrorCode) {
    super(code);
    this.name = "DomTreeProviderError";
  }
}

export interface DomTreeMutationObserver {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
  takeRecords?(): readonly MutationRecord[];
}

export interface DomTreeProviderOptions {
  readonly documentEpoch?: number;
  readonly maxCursors?: number;
  readonly maxRecords?: number;
  readonly createMutationObserver?: (
    callback: (records: readonly MutationRecord[]) => void,
  ) => DomTreeMutationObserver;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly onInvalidated?: (branch: DomInvalidationBranch) => void;
  readonly getSelectedNodeRef?: () => string | undefined;
  readonly onSelectedNodeRemoved?: (event: DomTreeSelectedNodeRemoval) => void;
  readonly onFrameLifecycle?: (event: FrameLifecycleEvent) => void;
  readonly onMutationSettled?: () => void;
  readonly isExcludedNode?: (node: Node) => boolean;
}

export interface DomTreeSelectedNodeRemoval {
  readonly nodeRef: string;
  readonly documentEpoch: number;
}

export interface DomTreeElementIdentity extends FrameIdentity {
  readonly nodeRef: string;
}

export interface DomTreeRevealedElement extends DomTreeElementIdentity {
  readonly ancestorPath: readonly DomNodeView[];
}

export interface DomTreeResolvedElement extends DomTreeElementIdentity {
  readonly element: Element;
}

export type DomTreeSessionRetention = Extract<
  RetentionReason,
  "selected" | "hovered"
>;

export interface DomTreeFrameAuthority {
  getContext(frameRef: string): FrameContext | undefined;
  getContextForDocument(document: Document): FrameContext | undefined;
  accessibleContexts(): readonly FrameContext[];
  toTopViewport(
    identity: FrameIdentity,
    rect: ViewportRect,
  ): TopViewportRect | undefined;
}

interface NodeRecord {
  readonly scope: NodeScope;
  readonly kind: DomNodeView["kind"];
  readonly parentRef?: string;
  readonly expandable?: boolean;
  readonly label?: string;
}

type LogicalChild =
  | { readonly kind: "element"; readonly node: Element }
  | { readonly kind: "shadow-root"; readonly node: ShadowRoot }
  | {
      readonly kind: "frame-document";
      readonly node: Document;
      readonly scope: FrameContext;
    };

interface CursorRecord {
  readonly nodeRef: string;
  readonly documentEpoch: number;
  readonly branchRevision: number;
  readonly offset: number;
  readonly physicalOffset: number;
  readonly active: boolean;
}

interface LogicalChildPage {
  readonly children: readonly LogicalChild[];
  readonly hasMore: boolean;
  readonly nextPhysicalOffset: number;
}

interface ExpandedBranch {
  readonly scope: NodeScope;
  revision: number;
}

interface FrameTraversalEntry {
  readonly node: Node;
  entered: boolean;
  childNodes: ArrayLike<Node> | undefined;
  childCount: number;
  nextChildIndex: number;
  shadowRoot: ShadowRoot | undefined;
  shadowQueued: boolean;
}

type FrameMutationAction = "register" | "unregister";

interface PendingFrameMutationScan {
  readonly action: FrameMutationAction;
  readonly ownerRoot: Node;
  readonly root: Node;
  readonly stack: FrameTraversalEntry[];
}

interface PendingMutationRecord {
  readonly observedRoot: Node;
  readonly record: MutationRecord;
}

interface PendingElementMutationRoot {
  readonly node: Node;
  readonly ownerRoot: Node;
  readonly parentRef?: string;
  readonly scope?: NodeScope;
}

interface OwnedFrame {
  readonly frameElement: HTMLIFrameElement;
  readonly parentFrameRef: string;
}

type LogicalPathEntry =
  | {
      readonly kind: "element";
      readonly node: Element;
      readonly scope: NodeScope;
    }
  | {
      readonly kind: "shadow-root";
      readonly node: ShadowRoot;
      readonly scope: NodeScope;
    }
  | {
      readonly kind: "frame-document";
      readonly node: Document;
      readonly scope: FrameContext;
    };

export class DomTreeProvider {
  private nodeRegistry: DomNodeRegistry;
  private readonly frameRegistry: FrameRegistry;
  private topDocument: Document | undefined;
  private readonly records = new Map<string, NodeRecord>();
  private refsByNode = new WeakMap<Node, string>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly expandedBranches = new Map<string, ExpandedBranch>();
  private readonly branchGenerations = new Map<string, number>();
  private readonly exhaustedBranches = new Set<string>();
  private readonly transientRecordRetentions = new Map<string, number>();
  private readonly expandedShadowHosts = new Set<string>();
  private readonly shadowRootRefs = new Map<string, string>();
  private readonly rootObservers = new Map<Node, DomTreeMutationObserver>();
  private readonly frameDescriptions = new Map<string, FrameDescription>();
  private readonly frameRefsByElement = new WeakMap<HTMLIFrameElement, string>();
  private readonly frameDocumentsByRef = new Map<string, Document>();
  private readonly ownedFramesByRef = new Map<string, OwnedFrame>();
  private readonly inactiveFrameRefs = new Set<string>();
  private readonly maxCursors: number;
  private readonly maxRecords: number;
  private documentEpoch: number;
  private readonly createMutationObserver: NonNullable<
    DomTreeProviderOptions["createMutationObserver"]
  >;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly onInvalidated: ((branch: DomInvalidationBranch) => void) | undefined;
  private readonly getSelectedNodeRef: (() => string | undefined) | undefined;
  private readonly onSelectedNodeRemoved: (
    (event: DomTreeSelectedNodeRemoval) => void
  ) | undefined;
  private readonly onFrameLifecycle: (
    (event: FrameLifecycleEvent) => void
  ) | undefined;
  private readonly onMutationSettled: (() => void) | undefined;
  private readonly isExcludedNodePredicate: (
    (node: Node) => boolean
  ) | undefined;
  private readonly frameAuthorityView: DomTreeFrameAuthority;
  private readonly pendingMutations: PendingMutationRecord[] = [];
  private readonly pendingFrameMutationScans: PendingFrameMutationScan[] = [];
  private mutationTimer: ReturnType<typeof setTimeout> | undefined;
  private frameMutationScanTimer: ReturnType<typeof setTimeout> | undefined;
  private shadowScanTimer: ReturnType<typeof setTimeout> | undefined;
  private shadowScanOffset = 0;
  private mutationProcessingDepth = 0;
  private pendingSelectedRemoval: DomTreeSelectedNodeRemoval | undefined;
  private nextCursor = 1;
  private frameTracking = false;
  private disposed = false;

  public constructor(
    topDocument: Document,
    options: DomTreeProviderOptions = {},
  ) {
    this.topDocument = topDocument;
    this.documentEpoch = options.documentEpoch ?? 0;
    this.maxCursors = requirePositiveSafeInteger(
      options.maxCursors ?? 128,
      "maxCursors",
    );
    this.maxRecords = requirePositiveSafeInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "maxRecords",
    );
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.onInvalidated = options.onInvalidated;
    this.getSelectedNodeRef = options.getSelectedNodeRef;
    this.onSelectedNodeRemoved = options.onSelectedNodeRemoved;
    this.onFrameLifecycle = options.onFrameLifecycle;
    this.onMutationSettled = options.onMutationSettled;
    this.isExcludedNodePredicate = options.isExcludedNode;
    this.nodeRegistry = new DomNodeRegistry({
      documentEpoch: this.documentEpoch,
      maxReverseEntries: this.maxRecords,
    });
    this.frameRegistry = new FrameRegistry(topDocument, {
      documentEpoch: this.documentEpoch,
      onLifecycle: (event) => this.handleFrameLifecycle(event),
    });
    this.frameAuthorityView = Object.freeze({
      getContext: (frameRef: string) => this.frameRegistry.getContext(frameRef),
      getContextForDocument: (document: Document) => (
        this.frameRegistry.getContextForDocument(document)
      ),
      accessibleContexts: () => this.frameRegistry.accessibleContexts(),
      toTopViewport: (identity: FrameIdentity, rect: ViewportRect) => (
        this.frameRegistry.toTopViewport(identity, rect)
      ),
    });
    this.createMutationObserver = options.createMutationObserver ?? ((callback) => {
      const observer = new MutationObserver((records) => callback(records));
      return observer;
    });
    this.observeRoot(topDocument);
  }

  public get currentDocumentEpoch(): number {
    return this.documentEpoch;
  }

  public get frameAuthority(): DomTreeFrameAuthority {
    return this.frameAuthorityView;
  }

  private isNodeExcluded(node: Node): boolean {
    try {
      return this.isExcludedNodePredicate?.(node) === true;
    } catch {
      return true;
    }
  }

  public startFrameTracking(): void {
    this.requireActive();
    if (this.frameTracking) {
      return;
    }
    this.frameTracking = true;
    for (const context of this.frameRegistry.accessibleContexts()) {
      this.queueFrameDiscovery(context.document);
    }
    this.processFrameMutationScanSlice();
  }

  public getRoot(expectedEpoch?: number): DomRootResponse {
    this.requireActive();
    if (expectedEpoch !== undefined && !isNonNegativeSafeInteger(expectedEpoch)) {
      throwDomTreeError("invalid-request");
    }
    if (expectedEpoch !== undefined && expectedEpoch !== this.documentEpoch) {
      throwDomTreeError("stale-document");
    }
    this.flushMutationBarrier();
    const context = this.frameRegistry.topContext;
    const element = this.topDocument?.documentElement;
    if (!context || !element) {
      throwDomTreeError("node-unavailable");
    }
    const node = this.viewElement(element, context);
    return Object.freeze({
      type: "dom.root",
      requestId: "root",
      documentEpoch: this.documentEpoch,
      node,
    });
  }

  public getChildren(request: DomChildrenRequest): DomChildrenResponse {
    this.requireActive();
    try {
      const parsed = parseDomRequest(request);
      if (parsed.type !== "dom.getChildren") {
        throw new Error("wrong request type");
      }
      request = parsed;
    } catch {
      throw new DomTreeProviderError("invalid-request");
    }
    if (request.documentEpoch !== this.documentEpoch) {
      throwDomTreeError("stale-document");
    }
    this.flushMutationBarrier();
    if (this.exhaustedBranches.has(request.nodeRef)) {
      throwDomTreeError("internal-error");
    }
    const record = this.records.get(request.nodeRef);
    const node = record
      ? this.resolveNode(request.nodeRef, record.scope)
      : undefined;
    if (!node) {
      throwDomTreeError("unknown-node");
    }
    const requestedCursor = request.cursor
      ? this.cursors.get(request.cursor)
      : undefined;
    let branch = this.expandedBranches.get(request.nodeRef);
    if (!branch) {
      const branchRevision = this.branchGenerations.get(request.nodeRef) ?? 1;
      if (request.branchRevision !== branchRevision) {
        throwDomTreeError("stale-branch");
      }
      if (request.cursor) {
        if (!requestedCursor) {
          throwDomTreeError("invalid-cursor");
        }
        if (
          requestedCursor.nodeRef !== request.nodeRef ||
          requestedCursor.documentEpoch !== request.documentEpoch
        ) {
          throwDomTreeError("invalid-request");
        }
        throwDomTreeError("stale-branch");
      }
      branch = { scope: record!.scope, revision: branchRevision };
      this.expandedBranches.set(request.nodeRef, branch);
      if (!this.nodeRegistry.retain(request.nodeRef, "expanded")) {
        this.expandedBranches.delete(request.nodeRef);
        throwDomTreeError("node-unavailable");
      }
      this.touchRecord(request.nodeRef);
      this.branchGenerations.set(request.nodeRef, branchRevision);
      if (node.nodeType === 1) {
        this.trackExpandedShadowHost(request.nodeRef, node as Element, record!.scope);
      } else if (record!.kind === "shadow-root" || record!.kind === "frame-document") {
        this.observeRoot(node);
      }
    } else if (
      node.nodeType === 1 &&
      this.discoverShadowRoot(request.nodeRef, node as Element, record!.scope)
    ) {
      this.invalidateBranch(request.nodeRef);
    }
    if (request.branchRevision !== branch.revision) {
      throwDomTreeError("stale-branch");
    }
    if (node.nodeType === 1 && isFrameElement(node as Element)) {
      this.describeFrame(
        node as HTMLIFrameElement,
        record!.scope,
        request.nodeRef,
        true,
      );
    }
    let offset = 0;
    let physicalOffset = 0;
    if (request.cursor) {
      if (!requestedCursor) {
        throwDomTreeError("invalid-cursor");
      }
      if (
        requestedCursor.nodeRef !== request.nodeRef ||
        requestedCursor.documentEpoch !== request.documentEpoch
      ) {
        throwDomTreeError("invalid-request");
      }
      if (
        !requestedCursor.active ||
        requestedCursor.branchRevision !== branch.revision
      ) {
        throwDomTreeError("stale-branch");
      }
      offset = requestedCursor.offset;
      physicalOffset = requestedCursor.physicalOffset;
    }
    const page = this.logicalChildPage(
      node,
      request.nodeRef,
      record!.scope,
      physicalOffset,
    );
    const materializedRefs: string[] = [];
    let nodes: readonly DomNodeView[];
    try {
      nodes = Object.freeze(page.children.map((child) => {
        const view = child.kind === "element"
          ? this.viewElement(child.node, record!.scope, request.nodeRef)
          : child.kind === "shadow-root"
            ? this.viewShadowRoot(child.node, record!.scope, request.nodeRef)
            : this.viewFrameDocument(child.node, child.scope, request.nodeRef);
        this.retainTransientRecord(view.nodeRef);
        materializedRefs.push(view.nodeRef);
        return view;
      }));
    } finally {
      for (const nodeRef of materializedRefs) {
        this.releaseTransientRecord(nodeRef);
      }
    }
    const nextOffset = offset + nodes.length;
    const nextCursor = page.hasMore
      ? this.createCursor({
          nodeRef: request.nodeRef,
          documentEpoch: request.documentEpoch,
          branchRevision: branch.revision,
          offset: nextOffset,
          physicalOffset: page.nextPhysicalOffset,
        })
      : undefined;
    return Object.freeze({
      type: "dom.children",
      requestId: request.requestId,
      documentEpoch: this.documentEpoch,
      nodeRef: request.nodeRef,
      branchRevision: branch.revision,
      nodes,
      ...(nextCursor ? { nextCursor } : {}),
    });
  }

  public ancestorPath(
    nodeRef: string,
    documentEpoch: number,
  ): readonly DomNodeView[] {
    this.requireActive();
    if (!isIdentifier(nodeRef) || !isNonNegativeSafeInteger(documentEpoch)) {
      throwDomTreeError("invalid-request");
    }
    if (documentEpoch !== this.documentEpoch) {
      throwDomTreeError("stale-document");
    }
    this.flushMutationBarrier();
    const reversed: DomNodeView[] = [];
    const seen = new Set<string>();
    let currentRef: string | undefined = nodeRef;
    while (currentRef) {
      if (
        seen.has(currentRef) ||
        reversed.length >= DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH
      ) {
        throwDomTreeError("node-unavailable");
      }
      seen.add(currentRef);
      const record = this.records.get(currentRef);
      if (!record) {
        throwDomTreeError("unknown-node");
      }
      const node = this.resolveNode(currentRef, record.scope);
      if (!node) {
        throwDomTreeError("unknown-node");
      }
      reversed.push(record.kind === "shadow-root"
        ? this.viewShadowRoot(node as ShadowRoot, record.scope, record.parentRef)
        : record.kind === "frame-document"
          ? this.viewFrameDocument(node as Document, record.scope as FrameContext, record.parentRef)
          : this.viewElement(node as Element, record.scope, record.parentRef));
      currentRef = record.parentRef;
    }
    return Object.freeze(reversed.reverse());
  }

  public lookupElement(element: Element): DomTreeElementIdentity | undefined {
    this.requireActive();
    if (!isElementNode(element)) {
      return undefined;
    }
    this.flushMutationBarrier();
    const nodeRef = this.refsByNode.get(element);
    const record = nodeRef ? this.records.get(nodeRef) : undefined;
    if (!nodeRef || record?.kind !== "element") {
      return undefined;
    }
    const context = this.frameRegistry.getContext(record.scope.frameRef);
    const attachedScope = this.attachedScopeFor(element);
    if (
      !context ||
      !sameNodeScope(context, record.scope) ||
      !attachedScope ||
      !sameNodeScope(attachedScope, record.scope) ||
      this.resolveNode(nodeRef, record.scope) !== element
    ) {
      return undefined;
    }
    return Object.freeze({
      nodeRef,
      frameRef: context.frameRef,
      frameEpoch: context.frameEpoch,
      documentEpoch: context.documentEpoch,
    });
  }

  public revealElement(element: Element): DomTreeRevealedElement {
    this.requireActive();
    if (!isElementNode(element)) {
      throwDomTreeError("invalid-request");
    }
    this.flushMutationBarrier();
    const scope = this.attachedScopeFor(element);
    if (!scope) {
      throwDomTreeError("node-unavailable");
    }
    const parentPath = this.planLogicalParentPath(element, scope);
    if (!parentPath) {
      throwDomTreeError("node-unavailable");
    }
    const path: readonly LogicalPathEntry[] = Object.freeze([
      ...parentPath,
      { kind: "element" as const, node: element, scope },
    ]);
    if (path.length > DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH) {
      throwDomTreeError("node-unavailable");
    }
    const ancestorPath = this.materializeLogicalPath(path);
    const target = ancestorPath?.at(-1);
    const context = this.frameRegistry.getContext(scope.frameRef);
    if (!ancestorPath || !target || !context || !sameNodeScope(context, scope)) {
      throwDomTreeError("node-unavailable");
    }
    return Object.freeze({
      nodeRef: target.nodeRef,
      frameRef: context.frameRef,
      frameEpoch: context.frameEpoch,
      documentEpoch: context.documentEpoch,
      ancestorPath,
    });
  }

  public resolveElement(
    nodeRef: string,
    documentEpoch: number,
  ): DomTreeResolvedElement | undefined {
    this.requireActive();
    if (!isIdentifier(nodeRef) || !isNonNegativeSafeInteger(documentEpoch)) {
      throwDomTreeError("invalid-request");
    }
    if (documentEpoch !== this.documentEpoch) {
      throwDomTreeError("stale-document");
    }
    this.flushMutationBarrier();
    const record = this.records.get(nodeRef);
    if (record?.kind !== "element") {
      return undefined;
    }
    const element = this.resolveNode(nodeRef, record.scope);
    const context = this.frameRegistry.getContext(record.scope.frameRef);
    const attachedScope = isElementNode(element)
      ? this.attachedScopeFor(element)
      : undefined;
    if (
      !isElementNode(element) ||
      !context ||
      !sameNodeScope(context, record.scope) ||
      !attachedScope ||
      !sameNodeScope(attachedScope, record.scope)
    ) {
      return undefined;
    }
    return Object.freeze({
      element,
      nodeRef,
      frameRef: context.frameRef,
      frameEpoch: context.frameEpoch,
      documentEpoch: context.documentEpoch,
    });
  }

  public retainNode(
    nodeRef: string,
    documentEpoch: number,
    reason: DomTreeSessionRetention,
  ): boolean {
    if (!isSessionRetentionReason(reason)) {
      return false;
    }
    return this.resolveElement(nodeRef, documentEpoch) !== undefined &&
      this.nodeRegistry.retain(nodeRef, reason);
  }

  public releaseNode(
    nodeRef: string,
    reason: DomTreeSessionRetention,
  ): void {
    if (isSessionRetentionReason(reason)) {
      this.nodeRegistry.release(nodeRef, reason);
    }
  }

  public resetDocument(topDocument: Document, documentEpoch: number): void {
    this.requireActive();
    if (
      !topDocument ||
      typeof topDocument !== "object" ||
      !Number.isSafeInteger(documentEpoch) ||
      documentEpoch <= this.documentEpoch
    ) {
      throw new RangeError("documentEpoch must be greater than the current epoch");
    }
    if (!this.frameRegistry.resetTopDocument(topDocument, documentEpoch)) {
      throwDomTreeError("node-unavailable");
    }
    this.nodeRegistry.resetDocument(documentEpoch);
    this.cancelScheduledWork();
    this.disconnectAllObservers();
    this.records.clear();
    this.refsByNode = new WeakMap<Node, string>();
    this.cursors.clear();
    this.expandedBranches.clear();
    this.branchGenerations.clear();
    this.exhaustedBranches.clear();
    this.transientRecordRetentions.clear();
    this.expandedShadowHosts.clear();
    this.shadowRootRefs.clear();
    this.frameDescriptions.clear();
    this.frameDocumentsByRef.clear();
    this.ownedFramesByRef.clear();
    this.inactiveFrameRefs.clear();
    this.pendingMutations.length = 0;
    this.pendingFrameMutationScans.length = 0;
    this.pendingSelectedRemoval = undefined;
    this.shadowScanOffset = 0;
    this.topDocument = topDocument;
    this.documentEpoch = documentEpoch;
    this.observeRoot(topDocument);
    if (this.frameTracking) {
      this.queueFrameDiscovery(topDocument);
      this.processFrameMutationScanSlice();
    }
  }

  public collapse(nodeRef: string, documentEpoch: number): void {
    this.requireActive();
    if (!isIdentifier(nodeRef) || !isNonNegativeSafeInteger(documentEpoch)) {
      throwDomTreeError("invalid-request");
    }
    if (documentEpoch !== this.documentEpoch) {
      throwDomTreeError("stale-document");
    }
    this.flushMutationBarrier();
    const collapsedRecord = this.records.get(nodeRef);
    if (!collapsedRecord) {
      throwDomTreeError("unknown-node");
    }
    const collapsedNode = this.resolveNode(
      nodeRef,
      collapsedRecord.scope,
    );
    const collapsedBranches = new Set(
      [...this.expandedBranches.keys()].filter((candidate) => (
        this.isAtOrBelow(candidate, nodeRef)
      )),
    );
    const collapsedFrameRefs = this.collectFrameRefsAtOrBelow(
      nodeRef,
      collapsedNode,
    );
    for (const frameRef of collapsedFrameRefs) {
      this.inactiveFrameRefs.add(frameRef);
    }
    this.releaseFrameDocuments(collapsedFrameRefs, false);
    for (const [hostRef, shadowRef] of [...this.shadowRootRefs]) {
      const hostCollapsed = this.isAtOrBelow(hostRef, nodeRef);
      if (hostCollapsed || this.isAtOrBelow(shadowRef, nodeRef)) {
        const record = this.records.get(shadowRef);
        const shadowRoot = record
          ? this.resolveNode(shadowRef, record.scope)
          : undefined;
        if (shadowRoot) {
          this.disconnectObserver(shadowRoot);
        }
        if (hostCollapsed) {
          this.shadowRootRefs.delete(hostRef);
        }
      }
    }
    for (const branchRef of collapsedBranches) {
      this.nodeRegistry.release(branchRef, "expanded");
      this.expandedBranches.delete(branchRef);
      this.expandedShadowHosts.delete(branchRef);
    }
    for (const [cursor, record] of this.cursors) {
      if (collapsedBranches.has(record.nodeRef)) {
        this.cursors.delete(cursor);
      }
    }
    this.pruneCollapsedFrameMutationScans(collapsedNode);
    this.stopShadowScanIfIdle();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduledWork();
    this.disconnectAllObservers();
    for (const nodeRef of this.expandedBranches.keys()) {
      this.nodeRegistry.release(nodeRef, "expanded");
    }
    this.frameRegistry.dispose();
    this.nodeRegistry = new DomNodeRegistry({
      documentEpoch: this.documentEpoch,
      maxReverseEntries: this.maxRecords,
    });
    this.topDocument = undefined;
    this.records.clear();
    this.refsByNode = new WeakMap<Node, string>();
    this.cursors.clear();
    this.expandedBranches.clear();
    this.branchGenerations.clear();
    this.exhaustedBranches.clear();
    this.transientRecordRetentions.clear();
    this.expandedShadowHosts.clear();
    this.shadowRootRefs.clear();
    this.frameDescriptions.clear();
    this.frameDocumentsByRef.clear();
    this.ownedFramesByRef.clear();
    this.inactiveFrameRefs.clear();
    this.pendingMutations.length = 0;
    this.pendingFrameMutationScans.length = 0;
    this.pendingSelectedRemoval = undefined;
    this.frameTracking = false;
  }

  private viewElement(
    element: Element,
    scope: NodeScope,
    parentRef?: string,
  ): DomNodeView {
    const nodeRef = this.referenceNode(element, scope);
    const existing = this.records.get(nodeRef);
    const frameElement = isFrameElement(element);
    const frame = frameElement
      ? this.describeFrame(element, scope, nodeRef)
      : undefined;
    const expandable = frame?.kind === "accessible" || (
      !frameElement && (
        getOpenShadowRoot(element) !== undefined ||
        hasElementChild(element)
      )
    );
    const label = createElementLabel(element);
    this.storeReferencedRecord(nodeRef, {
      scope,
      kind: "element",
      expandable,
      label,
      ...(parentRef ?? existing?.parentRef
        ? { parentRef: parentRef ?? existing?.parentRef }
        : {}),
    });
    return Object.freeze({
      nodeRef,
      kind: "element",
      label,
      expandable,
      ...(frameElement && frame?.kind !== "accessible" ? { inaccessible: true } : {}),
      branchRevision: this.branchRevisionFor(nodeRef),
    });
  }

  private viewShadowRoot(
    shadowRoot: ShadowRoot,
    scope: NodeScope,
    parentRef?: string,
  ): DomNodeView {
    const nodeRef = this.referenceNode(shadowRoot, scope);
    const existing = this.records.get(nodeRef);
    this.storeReferencedRecord(nodeRef, {
      scope,
      kind: "shadow-root",
      ...(parentRef ?? existing?.parentRef
        ? { parentRef: parentRef ?? existing?.parentRef }
        : {}),
    });
    return Object.freeze({
      nodeRef,
      kind: "shadow-root",
      label: "#shadow-root (open)",
      expandable: true,
      branchRevision: this.branchRevisionFor(nodeRef),
    });
  }

  private viewFrameDocument(
    document: Document,
    scope: FrameContext,
    parentRef?: string,
  ): DomNodeView {
    const nodeRef = this.referenceNode(document, scope);
    this.frameDocumentsByRef.set(scope.frameRef, document);
    this.observeRoot(document);
    const existing = this.records.get(nodeRef);
    this.storeReferencedRecord(nodeRef, {
      scope,
      kind: "frame-document",
      ...(parentRef ?? existing?.parentRef
        ? { parentRef: parentRef ?? existing?.parentRef }
        : {}),
    });
    return Object.freeze({
      nodeRef,
      kind: "frame-document",
      label: "#document",
      expandable: true,
      branchRevision: this.branchRevisionFor(nodeRef),
    });
  }

  private referenceNode(node: Node, scope: NodeScope): string {
    if (this.isNodeExcluded(node)) {
      throwDomTreeError("node-unavailable");
    }
    const knownRef = this.refsByNode.get(node);
    const knownRecord = knownRef ? this.records.get(knownRef) : undefined;
    if (!knownRecord || !sameNodeScope(knownRecord.scope, scope)) {
      this.ensureRecordCapacity();
    }
    let nodeRef: string;
    try {
      nodeRef = this.nodeRegistry.reference(node, scope);
    } catch {
      throwDomTreeError("node-unavailable");
    }
    this.refsByNode.set(node, nodeRef);
    return nodeRef;
  }

  private resolveNode(nodeRef: string, scope: NodeScope): Node | undefined {
    const node = this.nodeRegistry.resolve(nodeRef, scope);
    if (node && !this.isNodeExcluded(node)) {
      this.touchRecord(nodeRef);
      return node;
    }
    return undefined;
  }

  private storeReferencedRecord(nodeRef: string, record: NodeRecord): void {
    if (!this.records.has(nodeRef) && this.records.size >= this.maxRecords) {
      throwDomTreeError("internal-error");
    }
    this.records.delete(nodeRef);
    this.records.set(nodeRef, record);
  }

  private touchRecord(nodeRef: string): void {
    const record = this.records.get(nodeRef);
    if (!record) {
      return;
    }
    this.records.delete(nodeRef);
    this.records.set(nodeRef, record);
  }

  private ensureRecordCapacity(): void {
    if (this.records.size < this.maxRecords) {
      return;
    }
    const selectedPath = this.protectSelectedRecordPath();
    const shadowOwnershipRefs = new Set<string>();
    for (const [hostRef, shadowRef] of this.shadowRootRefs) {
      shadowOwnershipRefs.add(hostRef);
      shadowOwnershipRefs.add(shadowRef);
    }
    for (const [nodeRef, record] of [...this.records]) {
      if (this.nodeRegistry.retentionReasons(nodeRef).length > 0) {
        continue;
      }
      if (
        selectedPath.has(nodeRef) ||
        shadowOwnershipRefs.has(nodeRef) ||
        this.frameDescriptions.has(nodeRef) ||
        this.transientRecordRetentions.has(nodeRef)
      ) {
        const node = this.nodeRegistry.resolve(nodeRef, record.scope);
        if (node) {
          this.touchRecord(nodeRef);
          continue;
        }
        this.evictRecordMetadata(nodeRef);
        if (this.records.size < this.maxRecords) {
          return;
        }
        continue;
      }
      this.evictRecordMetadata(nodeRef);
      return;
    }
    throwDomTreeError("node-unavailable");
  }

  private protectSelectedRecordPath(): ReadonlySet<string> {
    const selectedRef = this.readSelectedNodeRef();
    if (!selectedRef) {
      return new Set<string>();
    }
    const protectedRefs = new Set<string>();
    let currentRef: string | undefined = selectedRef;
    for (let depth = 0; currentRef && depth < this.maxRecords; depth += 1) {
      if (protectedRefs.has(currentRef)) {
        throwDomTreeError("node-unavailable");
      }
      const record = this.records.get(currentRef);
      if (!record) {
        throwDomTreeError("node-unavailable");
      }
      const node = this.nodeRegistry.resolve(currentRef, record.scope);
      if (!node) {
        throwDomTreeError("node-unavailable");
      }
      this.touchRecord(currentRef);
      protectedRefs.add(currentRef);
      currentRef = record.parentRef;
    }
    if (currentRef) {
      throwDomTreeError("node-unavailable");
    }
    return protectedRefs;
  }

  private evictRecordMetadata(nodeRef: string): void {
    this.records.delete(nodeRef);
    this.branchGenerations.delete(nodeRef);
    this.exhaustedBranches.delete(nodeRef);
    this.transientRecordRetentions.delete(nodeRef);
    this.expandedBranches.delete(nodeRef);
    this.expandedShadowHosts.delete(nodeRef);
    this.frameDescriptions.delete(nodeRef);
    for (const [hostRef, shadowRef] of [...this.shadowRootRefs]) {
      if (hostRef === nodeRef || shadowRef === nodeRef) {
        this.shadowRootRefs.delete(hostRef);
      }
    }
    for (const [cursor, record] of this.cursors) {
      if (record.nodeRef === nodeRef) {
        this.cursors.delete(cursor);
      }
    }
  }

  private retainTransientRecord(nodeRef: string): void {
    this.transientRecordRetentions.set(
      nodeRef,
      (this.transientRecordRetentions.get(nodeRef) ?? 0) + 1,
    );
  }

  private releaseTransientRecord(nodeRef: string): void {
    const count = this.transientRecordRetentions.get(nodeRef);
    if (count === undefined || count <= 1) {
      this.transientRecordRetentions.delete(nodeRef);
      return;
    }
    this.transientRecordRetentions.set(nodeRef, count - 1);
  }

  private logicalChildPage(
    node: Node,
    nodeRef: string,
    scope: NodeScope,
    physicalOffset: number,
  ): LogicalChildPage {
    const children: LogicalChild[] = [];
    if (node.nodeType === 1 && isFrameElement(node as Element)) {
      const description = this.frameDescriptions.get(nodeRef) ??
        this.describeFrame(node as HTMLIFrameElement, scope, nodeRef);
      if (
        description?.kind === "accessible" &&
        physicalOffset === 0 &&
        !this.isNodeExcluded(description.document)
      ) {
        children.push({
          kind: "frame-document",
          node: description.document,
          scope: description,
        });
      }
      return freezeLogicalChildPage(children, false, 1);
    }
    let syntheticChildCount = 0;
    if (node.nodeType === 1) {
      const shadowRoot = getOpenShadowRoot(node as Element);
      if (shadowRoot && !this.isNodeExcluded(shadowRoot)) {
        syntheticChildCount = 1;
        if (physicalOffset === 0) {
          children.push({ kind: "shadow-root", node: shadowRoot });
          physicalOffset = 1;
        }
      }
    }
    const childNodes = readChildNodes(node);
    if (!childNodes) {
      return freezeLogicalChildPage(children, false, physicalOffset);
    }
    let childIndex = Math.max(0, physicalOffset - syntheticChildCount);
    let visitedNodes = 0;
    while (
      childIndex < childNodes.length &&
      visitedNodes < CHILD_PAGE_PHYSICAL_SCAN_LIMIT &&
      children.length < CHILD_PAGE_SIZE
    ) {
      const child = childNodes[childIndex];
      childIndex += 1;
      visitedNodes += 1;
      if (child?.nodeType === 1 && !this.isNodeExcluded(child)) {
        children.push({ kind: "element", node: child as Element });
      }
    }
    const nextPhysicalOffset = syntheticChildCount + childIndex;
    return freezeLogicalChildPage(
      children,
      childIndex < childNodes.length,
      nextPhysicalOffset,
    );
  }

  private describeFrame(
    frameElement: HTMLIFrameElement,
    scope: NodeScope,
    nodeRef: string,
    activateSubtree = false,
  ): FrameDescription | undefined {
    const description = this.frameRegistry.describeFrame(frameElement, scope.frameRef);
    if (!description) {
      return undefined;
    }
    this.trackFrameDescription(
      frameElement,
      description,
      nodeRef,
      activateSubtree,
    );
    return description;
  }

  private createCursor(record: Omit<CursorRecord, "active">): string {
    if (!Number.isSafeInteger(this.nextCursor)) {
      throwDomTreeError("internal-error");
    }
    const cursor = `cursor-${this.nextCursor}`;
    this.nextCursor += 1;
    while (this.cursors.size >= this.maxCursors) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.cursors.delete(oldest);
    }
    this.cursors.set(cursor, Object.freeze({ ...record, active: true }));
    return cursor;
  }

  private queueMutations(
    observedRoot: Node,
    records: readonly MutationRecord[],
  ): void {
    if (this.disposed) {
      return;
    }
    for (const record of records) {
      this.pendingMutations.push({ observedRoot, record });
    }
    if (this.mutationTimer !== undefined) {
      return;
    }
    this.mutationTimer = this.scheduleTimeout(() => {
      this.mutationTimer = undefined;
      this.processMutations();
    }, 16);
  }

  private processMutations(): void {
    this.mutationProcessingDepth += 1;
    try {
      this.processPendingMutationRecords();
    } finally {
      this.mutationProcessingDepth -= 1;
      if (this.mutationProcessingDepth === 0) {
        this.emitPendingSelectedRemoval();
        this.emitMutationSettled();
      }
    }
  }

  private processPendingMutationRecords(): void {
    const records = this.pendingMutations.splice(0);
    const affected = new Set<string>();
    const addedRoots: PendingElementMutationRoot[] = [];
    const removedRoots: PendingElementMutationRoot[] = [];
    for (const pending of records) {
      if (!this.rootObservers.has(pending.observedRoot)) {
        continue;
      }
      const mutation = pending.record;
      if (this.isNodeExcluded(mutation.target)) {
        continue;
      }
      if (mutation.type === "attributes") {
        if (mutation.target.nodeType !== 1) {
          continue;
        }
        const targetRef = this.refsByNode.get(mutation.target);
        const targetRecord = targetRef
          ? this.records.get(targetRef)
          : undefined;
        if (
          !targetRef ||
          targetRecord?.kind !== "element" ||
          targetRecord.label === createElementLabel(mutation.target as Element)
        ) {
          continue;
        }
        const visibleBranchRef = targetRecord.parentRef ?? targetRef;
        if (this.expandedBranches.has(visibleBranchRef)) {
          affected.add(visibleBranchRef);
        }
        continue;
      }
      if (mutation.type !== "childList") {
        continue;
      }
      const targetRef = this.refsByNode.get(mutation.target);
      const targetRecord = targetRef
        ? this.records.get(targetRef)
        : undefined;
      const targetScope = targetRecord?.scope ??
        this.scopeForMutationTarget(mutation.target);
      let elementTreeChanged = false;
      const removedNodes = mutation.removedNodes;
      for (let index = 0; index < removedNodes.length; index += 1) {
        const removed = removedNodes[index];
        if (removed?.nodeType === 1) {
          removedRoots.push({
            node: removed,
            ownerRoot: pending.observedRoot,
            ...(targetRef ? { parentRef: targetRef } : {}),
            ...(targetScope ? { scope: targetScope } : {}),
          });
          elementTreeChanged ||= !this.isNodeExcluded(removed);
        }
      }
      const addedNodes = mutation.addedNodes;
      for (let index = 0; index < addedNodes.length; index += 1) {
        const added = addedNodes[index];
        if (added?.nodeType === 1 && !this.isNodeExcluded(added)) {
          addedRoots.push({
            node: added,
            ownerRoot: pending.observedRoot,
            ...(targetRef ? { parentRef: targetRef } : {}),
            ...(targetScope ? { scope: targetScope } : {}),
          });
          elementTreeChanged = true;
        }
      }
      if (!elementTreeChanged) {
        continue;
      }
      if (targetRef && this.expandedBranches.has(targetRef)) {
        affected.add(targetRef);
      }
      const parentRef = targetRef
        ? targetRecord?.parentRef
        : undefined;
      const targetElement = mutation.target.nodeType === 1
        ? mutation.target as Element
        : undefined;
      const visibleExpandableChanged = targetRecord?.kind === "element" &&
        targetElement !== undefined &&
        !isFrameElement(targetElement) &&
        targetRecord.expandable !== (
          getOpenShadowRoot(targetElement) !== undefined ||
          hasElementChild(targetElement)
        );
      if (
        visibleExpandableChanged &&
        parentRef &&
        this.expandedBranches.has(parentRef)
      ) {
        affected.add(parentRef);
      }
    }
    const movedRoots = new Set<Node>();
    for (const removed of removedRoots) {
      const movedRef = this.refsByNode.get(removed.node);
      const movedRecord = movedRef
        ? this.records.get(movedRef)
        : undefined;
      const finalScope = this.attachedScopeFor(removed.node);
      if (
        !movedRef ||
        !movedRecord ||
        !finalScope ||
        !sameNodeScope(movedRecord.scope, finalScope)
      ) {
        continue;
      }
      const finalParentRef = this.replaceMovedNodePath(
        removed.node,
        movedRef,
        movedRecord,
        finalScope,
      );
      if (!finalParentRef) {
        continue;
      }
      movedRoots.add(removed.node);
      if (this.expandedBranches.has(finalParentRef)) {
        affected.add(finalParentRef);
      }
    }
    for (const root of removedRoots) {
      if (movedRoots.has(root.node)) {
        continue;
      }
      this.pendingFrameMutationScans.push({
        action: "unregister",
        ownerRoot: root.ownerRoot,
        root: root.node,
        stack: [createFrameTraversalEntry(root.node)],
      });
    }
    for (const root of addedRoots) {
      if (movedRoots.has(root.node)) {
        continue;
      }
      this.pendingFrameMutationScans.push({
        action: "register",
        ownerRoot: root.ownerRoot,
        root: root.node,
        stack: [createFrameTraversalEntry(root.node)],
      });
    }
    if (removedRoots.length > 0 || addedRoots.length > 0) {
      this.processFrameMutationScanSlice();
    }
    for (const root of removedRoots) {
      if (movedRoots.has(root.node)) {
        continue;
      }
      this.disconnectObserversWithin(root.node);
      const invalidated = this.nodeRegistry.invalidateSubtree(root.node);
      this.releaseInvalidatedRefs(invalidated);
    }
    this.invalidateBranches(affected);
  }

  private flushMutationBarrier(): void {
    for (const [root, observer] of this.rootObservers) {
      try {
        const records = observer.takeRecords?.() ?? [];
        for (const record of records) {
          this.pendingMutations.push({ observedRoot: root, record });
        }
      } catch {
        // Other observed roots remain authoritative if one adapter fails.
      }
    }
    if (this.mutationTimer !== undefined) {
      this.cancelTimeout(this.mutationTimer);
      this.mutationTimer = undefined;
    }
    if (this.pendingMutations.length > 0) {
      this.processMutations();
    }
  }

  private invalidateBranch(nodeRef: string): void {
    this.invalidateBranches([nodeRef]);
  }

  private invalidateBranches(nodeRefs: Iterable<string>): void {
    const branches: Array<{
      readonly nodeRef: string;
      readonly branch: ExpandedBranch;
    }> = [];
    const seen = new Set<string>();
    for (const nodeRef of nodeRefs) {
      if (seen.has(nodeRef)) {
        continue;
      }
      seen.add(nodeRef);
      const branch = this.expandedBranches.get(nodeRef);
      if (branch) {
        branches.push({ nodeRef, branch });
      }
    }
    if (branches.some(({ branch }) => branch.revision >= Number.MAX_SAFE_INTEGER)) {
      const failedRefs = new Set(branches.map(({ nodeRef }) => nodeRef));
      for (const nodeRef of failedRefs) {
        this.exhaustedBranches.add(nodeRef);
      }
      for (const [cursor, record] of this.cursors) {
        if (failedRefs.has(record.nodeRef) && record.active) {
          this.cursors.set(cursor, Object.freeze({ ...record, active: false }));
        }
      }
      throwDomTreeError("internal-error");
    }
    for (const { nodeRef, branch } of branches) {
      branch.revision += 1;
      this.branchGenerations.set(nodeRef, branch.revision);
    }
    const invalidatedRefs = new Set(branches.map(({ nodeRef }) => nodeRef));
    for (const [cursor, record] of this.cursors) {
      if (invalidatedRefs.has(record.nodeRef) && record.active) {
        this.cursors.set(cursor, Object.freeze({ ...record, active: false }));
      }
    }
    for (const { nodeRef, branch } of branches) {
      try {
        this.onInvalidated?.(Object.freeze({
          nodeRef,
          branchRevision: branch.revision,
        }));
      } catch {
        // Consumer callbacks cannot disrupt DOM ownership bookkeeping.
      }
    }
  }

  private trackExpandedShadowHost(
    nodeRef: string,
    host: Element,
    scope: NodeScope,
  ): void {
    this.expandedShadowHosts.add(nodeRef);
    this.discoverShadowRoot(nodeRef, host, scope);
    this.scheduleShadowScan();
  }

  private branchRevisionFor(nodeRef: string): number {
    return this.expandedBranches.get(nodeRef)?.revision
      ?? this.branchGenerations.get(nodeRef)
      ?? 1;
  }

  private discoverShadowRoot(
    hostRef: string,
    host: Element,
    scope: NodeScope,
  ): boolean {
    const shadowRoot = getOpenShadowRoot(host);
    if (
      this.isNodeExcluded(host) ||
      !shadowRoot ||
      this.isNodeExcluded(shadowRoot) ||
      this.shadowRootRefs.has(hostRef)
    ) {
      return false;
    }
    const view = this.viewShadowRoot(shadowRoot, scope, hostRef);
    this.shadowRootRefs.set(hostRef, view.nodeRef);
    this.observeRoot(shadowRoot);
    return true;
  }

  private scheduleShadowScan(): void {
    if (
      this.shadowScanTimer !== undefined ||
      this.disposed ||
      this.expandedShadowHosts.size === 0
    ) {
      return;
    }
    this.shadowScanTimer = this.scheduleTimeout(() => {
      this.shadowScanTimer = undefined;
      this.scanExpandedShadowHosts();
      this.scheduleShadowScan();
    }, SHADOW_SCAN_INTERVAL_MS);
  }

  private scanExpandedShadowHosts(): void {
    if (this.disposed) {
      return;
    }
    const hostRefs = [...this.expandedShadowHosts];
    if (hostRefs.length === 0) {
      this.shadowScanOffset = 0;
      return;
    }
    const count = Math.min(SHADOW_SCAN_BATCH_SIZE, hostRefs.length);
    for (let index = 0; index < count; index += 1) {
      const hostRef = hostRefs[(this.shadowScanOffset + index) % hostRefs.length]!;
      const branch = this.expandedBranches.get(hostRef);
      const record = this.records.get(hostRef);
      const host = branch && record
        ? this.resolveNode(hostRef, branch.scope)
        : undefined;
      if (!branch || !record || host?.nodeType !== 1) {
        this.expandedShadowHosts.delete(hostRef);
        this.shadowRootRefs.delete(hostRef);
        continue;
      }
      if (this.discoverShadowRoot(hostRef, host as Element, record.scope)) {
        this.invalidateBranch(hostRef);
      }
    }
    this.shadowScanOffset = (this.shadowScanOffset + count) % hostRefs.length;
  }

  private scopeForMutationTarget(target: Node): NodeScope | undefined {
    let document: Document | undefined;
    try {
      document = target.nodeType === 9
        ? target as Document
        : (target as { readonly ownerDocument?: Document }).ownerDocument;
    } catch {
      return undefined;
    }
    return document
      ? this.frameRegistry.getContextForDocument(document)
      : undefined;
  }

  private attachedScopeFor(node: Node): NodeScope | undefined {
    const seen = new Set<Node>();
    let current: Node | undefined = node;
    for (let depth = 0; current && depth < this.maxRecords; depth += 1) {
      if (seen.has(current)) {
        return undefined;
      }
      seen.add(current);
      if (this.isNodeExcluded(current)) {
        return undefined;
      }
      if (current.nodeType === 9) {
        return this.frameRegistry.getContextForDocument(current as Document);
      }
      current = readShadowIncludingParent(current);
    }
    return undefined;
  }

  private replaceMovedNodePath(
    node: Node,
    movedRef: string,
    movedRecord: NodeRecord,
    scope: NodeScope,
  ): string | undefined {
    const path = this.planLogicalParentPath(node, scope);
    if (!path) {
      return undefined;
    }
    const views = this.materializeLogicalPath(
      path,
      new Set([movedRef]),
      (parentRef) => {
        const currentMovedRecord = this.records.get(movedRef);
        if (
          currentMovedRecord !== movedRecord ||
          this.nodeRegistry.resolve(movedRef, movedRecord.scope) !== node
        ) {
          return false;
        }
        this.records.set(movedRef, {
          ...movedRecord,
          parentRef,
        });
        return true;
      },
    );
    return views?.at(-1)?.nodeRef;
  }

  private materializeLogicalPath(
    path: readonly LogicalPathEntry[],
    additionallyProtected: ReadonlySet<string> = new Set<string>(),
    commit?: (finalRef: string) => boolean,
  ): readonly DomNodeView[] | undefined {
    if (
      path.length === 0 ||
      path.length > this.maxRecords ||
      path.some(({ node }) => this.isNodeExcluded(node))
    ) {
      return undefined;
    }
    const existingRefs = new Map<Node, string>();
    const protectedRefs = new Set<string>(additionallyProtected);
    for (const entry of path) {
      const nodeRef = this.authoritativePathRef(entry);
      if (nodeRef) {
        existingRefs.set(entry.node, nodeRef);
        protectedRefs.add(nodeRef);
      }
    }
    const fixedRefs = this.fixedRecordAuthorityOutside(protectedRefs);
    const pathRefs = new Set(existingRefs.values());
    const additionalRecordCount = [...additionallyProtected].filter((nodeRef) => (
      this.records.has(nodeRef) && !pathRefs.has(nodeRef)
    )).length;
    if (path.length + additionalRecordCount + fixedRefs.size > this.maxRecords) {
      return undefined;
    }
    const missingRecords = path.length - existingRefs.size;
    const temporaryRetentions = new Set<string>();
    for (const nodeRef of protectedRefs) {
      if (!this.retainPathRecord(nodeRef, temporaryRetentions)) {
        this.releasePathRetentions(temporaryRetentions);
        return undefined;
      }
    }
    if (!this.reserveRecordCapacity(missingRecords, protectedRefs, fixedRefs)) {
      this.releasePathRetentions(temporaryRetentions);
      return undefined;
    }

    const createdRefs = new Set<string>();
    const originalRecords = new Map<string, NodeRecord>();
    const newlyObservedRoots = new Set<Node>();
    const views: DomNodeView[] = [];
    let parentRef: string | undefined;
    try {
      for (const entry of path) {
        const knownRef = existingRefs.get(entry.node);
        if (knownRef) {
          const record = this.records.get(knownRef);
          if (!record) {
            throw new Error("path record disappeared during replacement");
          }
          originalRecords.set(knownRef, record);
        }
        const wasObserved = this.rootObservers.has(entry.node);
        const view = this.materializePathEntry(entry, parentRef);
        if (!wasObserved && this.rootObservers.has(entry.node)) {
          newlyObservedRoots.add(entry.node);
        }
        if (knownRef && view.nodeRef !== knownRef) {
          throw new Error("path reference changed during replacement");
        }
        if (!knownRef) {
          createdRefs.add(view.nodeRef);
        }
        protectedRefs.add(view.nodeRef);
        if (!this.retainPathRecord(view.nodeRef, temporaryRetentions)) {
          throw new Error("path reference could not be retained");
        }
        views.push(view);
        parentRef = view.nodeRef;
      }
      if (!parentRef || !this.validateMaterializedPath(path, parentRef)) {
        throw new Error("path replacement was not authoritative");
      }
      if (commit && !commit(parentRef)) {
        throw new Error("path commit was not authoritative");
      }
      return Object.freeze(views);
    } catch {
      for (const nodeRef of createdRefs) {
        this.evictRecordMetadata(nodeRef);
      }
      for (const [nodeRef, record] of originalRecords) {
        if (this.records.has(nodeRef)) {
          this.records.set(nodeRef, record);
        }
      }
      for (const root of newlyObservedRoots) {
        this.disconnectObserver(root);
      }
      return undefined;
    } finally {
      this.releasePathRetentions(temporaryRetentions);
    }
  }

  private planLogicalParentPath(
    node: Node,
    scope: NodeScope,
  ): readonly LogicalPathEntry[] | undefined {
    const path: LogicalPathEntry[] = [];
    const seen = new Set<Node>();
    const appendParentPath = (target: Node, targetScope: NodeScope): boolean => {
      const pending: LogicalPathEntry[] = [];
      let current = readShadowIncludingParent(target);
      while (current) {
        if (seen.size >= this.maxRecords || seen.has(current)) {
          return false;
        }
        seen.add(current);
        if (current.nodeType === 9) {
          const context = this.frameRegistry.getContextForDocument(
            current as Document,
          );
          if (!context || !sameNodeScope(context, targetScope)) {
            return false;
          }
          if (context.parentFrameRef) {
            const frameElement = context.frameElement;
            const parentContext = this.frameRegistry.getContext(
              context.parentFrameRef,
            );
            if (
              !frameElement ||
              !parentContext ||
              !appendParentPath(frameElement, parentContext) ||
              seen.size >= this.maxRecords ||
              seen.has(frameElement)
            ) {
              return false;
            }
            seen.add(frameElement);
            path.push({
              kind: "element",
              node: frameElement,
              scope: parentContext,
            });
            path.push({
              kind: "frame-document",
              node: context.document,
              scope: context,
            });
          }
          for (let index = pending.length - 1; index >= 0; index -= 1) {
            path.push(pending[index]!);
          }
          return true;
        }
        if (current.nodeType === 1) {
          pending.push({
            kind: "element",
            node: current as Element,
            scope: targetScope,
          });
        } else if (isOpenShadowRoot(current)) {
          pending.push({
            kind: "shadow-root",
            node: current,
            scope: targetScope,
          });
        } else {
          return false;
        }
        current = readShadowIncludingParent(current);
      }
      return false;
    };
    return appendParentPath(node, scope) ? path : undefined;
  }

  private authoritativePathRef(entry: LogicalPathEntry): string | undefined {
    if (this.isNodeExcluded(entry.node)) {
      return undefined;
    }
    const nodeRef = this.refsByNode.get(entry.node);
    const record = nodeRef ? this.records.get(nodeRef) : undefined;
    if (
      !nodeRef ||
      !record ||
      record.kind !== entry.kind ||
      !sameNodeScope(record.scope, entry.scope)
    ) {
      return undefined;
    }
    if (this.nodeRegistry.resolve(nodeRef, record.scope) !== entry.node) {
      this.evictRecordMetadata(nodeRef);
      return undefined;
    }
    this.touchRecord(nodeRef);
    return nodeRef;
  }

  private fixedRecordAuthorityOutside(
    excluded: ReadonlySet<string>,
  ): ReadonlySet<string> {
    const shadowOwnershipRefs = new Set<string>();
    for (const [hostRef, shadowRef] of this.shadowRootRefs) {
      shadowOwnershipRefs.add(hostRef);
      shadowOwnershipRefs.add(shadowRef);
    }
    const fixed = new Set<string>();
    for (const nodeRef of this.records.keys()) {
      if (excluded.has(nodeRef)) {
        continue;
      }
      if (
        this.nodeRegistry.retentionReasons(nodeRef).length > 0 ||
        shadowOwnershipRefs.has(nodeRef) ||
        this.frameDescriptions.has(nodeRef) ||
        this.transientRecordRetentions.has(nodeRef)
      ) {
        fixed.add(nodeRef);
      }
    }
    return fixed;
  }

  private reserveRecordCapacity(
    additionalRecords: number,
    protectedRefs: ReadonlySet<string>,
    fixedRefs: ReadonlySet<string>,
  ): boolean {
    while (this.records.size + additionalRecords > this.maxRecords) {
      const candidate = [...this.records.keys()].find((nodeRef) => (
        !protectedRefs.has(nodeRef) && !fixedRefs.has(nodeRef)
      ));
      if (!candidate) {
        return false;
      }
      this.evictRecordMetadata(candidate);
    }
    return true;
  }

  private retainPathRecord(
    nodeRef: string,
    temporaryRetentions: Set<string>,
  ): boolean {
    if (this.nodeRegistry.retentionReasons(nodeRef).includes("selected")) {
      return true;
    }
    if (!this.nodeRegistry.retain(nodeRef, "selected")) {
      return false;
    }
    temporaryRetentions.add(nodeRef);
    return true;
  }

  private releasePathRetentions(nodeRefs: ReadonlySet<string>): void {
    for (const nodeRef of nodeRefs) {
      this.nodeRegistry.release(nodeRef, "selected");
    }
  }

  private materializePathEntry(
    entry: LogicalPathEntry,
    parentRef: string | undefined,
  ): DomNodeView {
    if (entry.kind === "element") {
      return this.viewElement(entry.node, entry.scope, parentRef);
    }
    if (entry.kind === "shadow-root") {
      if (!parentRef) {
        throw new Error("shadow root path is missing its host");
      }
      const view = this.viewShadowRoot(entry.node, entry.scope, parentRef);
      this.shadowRootRefs.set(parentRef, view.nodeRef);
      this.observeRoot(entry.node);
      return view;
    }
    if (!parentRef) {
      throw new Error("frame document path is missing its frame");
    }
    return this.viewFrameDocument(
      entry.node,
      entry.scope,
      parentRef,
    );
  }

  private validateMaterializedPath(
    path: readonly LogicalPathEntry[],
    finalParentRef: string,
  ): boolean {
    let expectedParentRef: string | undefined;
    let actualFinalRef: string | undefined;
    for (const entry of path) {
      const nodeRef = this.refsByNode.get(entry.node);
      const record = nodeRef ? this.records.get(nodeRef) : undefined;
      if (
        this.isNodeExcluded(entry.node) ||
        !nodeRef ||
        !record ||
        record.kind !== entry.kind ||
        record.parentRef !== expectedParentRef ||
        !sameNodeScope(record.scope, entry.scope) ||
        this.nodeRegistry.resolve(nodeRef, record.scope) !== entry.node
      ) {
        return false;
      }
      expectedParentRef = nodeRef;
      actualFinalRef = nodeRef;
    }
    return actualFinalRef === finalParentRef;
  }

  private observeRoot(root: Node): void {
    if (this.isNodeExcluded(root) || this.rootObservers.has(root)) {
      return;
    }
    try {
      const observer = this.createMutationObserver((records) => (
        this.queueMutations(root, records)
      ));
      observer.observe(root, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      this.rootObservers.set(root, observer);
    } catch {
      // A hostile root cannot be allowed to break the rest of the tree.
    }
  }

  private readSelectedNodeRef(): string | undefined {
    try {
      const nodeRef = this.getSelectedNodeRef?.();
      return typeof nodeRef === "string" ? nodeRef : undefined;
    } catch {
      return undefined;
    }
  }

  private releaseInvalidatedRefs(
    nodeRefs: readonly string[],
    notifySelectedRemoval = true,
  ): void {
    if (nodeRefs.length === 0) {
      return;
    }
    const invalidated = new Set(nodeRefs);
    const selectedRef = notifySelectedRemoval
      ? this.readSelectedNodeRef()
      : undefined;
    const selectedWasRemoved = selectedRef !== undefined && invalidated.has(selectedRef);
    for (const nodeRef of invalidated) {
      this.expandedBranches.delete(nodeRef);
      this.branchGenerations.delete(nodeRef);
      this.exhaustedBranches.delete(nodeRef);
      this.expandedShadowHosts.delete(nodeRef);
      this.shadowRootRefs.delete(nodeRef);
      this.frameDescriptions.delete(nodeRef);
      this.records.delete(nodeRef);
    }
    for (const [cursor, record] of this.cursors) {
      if (invalidated.has(record.nodeRef)) {
        this.cursors.delete(cursor);
      }
    }
    this.stopShadowScanIfIdle();
    if (notifySelectedRemoval && selectedWasRemoved) {
      this.pendingSelectedRemoval ??= Object.freeze({
        nodeRef: selectedRef,
        documentEpoch: this.documentEpoch,
      });
    }
  }

  private emitPendingSelectedRemoval(): void {
    const event = this.pendingSelectedRemoval;
    this.pendingSelectedRemoval = undefined;
    if (!event) {
      return;
    }
    try {
      this.onSelectedNodeRemoved?.(event);
    } catch {
      // Consumer callbacks cannot disrupt DOM ownership bookkeeping.
    }
  }

  private emitMutationSettled(): void {
    try {
      this.onMutationSettled?.();
    } catch {
      // Consumer reconciliation cannot disrupt DOM ownership bookkeeping.
    }
  }

  private registerDiscoveredFrame(frameElement: HTMLIFrameElement): void {
    if (this.isNodeExcluded(frameElement)) {
      return;
    }
    let ownerDocument: Document | undefined;
    try {
      ownerDocument = frameElement.ownerDocument;
    } catch {
      return;
    }
    const parent = ownerDocument
      ? this.frameRegistry.getContextForDocument(ownerDocument)
      : undefined;
    if (!parent) {
      return;
    }
    const description = this.frameRegistry.describeFrame(frameElement, parent.frameRef);
    if (description) {
      this.trackFrameDescription(frameElement, description, undefined, false);
    }
  }

  private queueFrameDiscovery(document: Document): void {
    if (
      this.disposed ||
      this.pendingFrameMutationScans.some((scan) => (
        scan.action === "register" && scan.root === document
      ))
    ) {
      return;
    }
    this.pendingFrameMutationScans.push({
      action: "register",
      ownerRoot: document,
      root: document,
      stack: [createFrameTraversalEntry(document)],
    });
    if (this.frameMutationScanTimer === undefined) {
      this.frameMutationScanTimer = this.scheduleTimeout(() => {
        this.frameMutationScanTimer = undefined;
        this.processFrameMutationScanSlice();
      }, 0);
    }
  }

  private processFrameMutationScanSlice(): void {
    let visitedNodes = 0;
    let operations = 0;
    while (
      this.pendingFrameMutationScans.length > 0 &&
      visitedNodes < FRAME_MUTATION_SCAN_LIMIT &&
      operations < FRAME_MUTATION_OPERATION_LIMIT
    ) {
      operations += 1;
      const scan = this.pendingFrameMutationScans[0]!;
      if (
        scan.action === "register" &&
        (
          !this.rootObservers.has(scan.ownerRoot) ||
          (
            scan.root !== scan.ownerRoot &&
            !containsNode(scan.ownerRoot, scan.root)
          )
        )
      ) {
        this.pendingFrameMutationScans.shift();
        continue;
      }
      const entry = scan.stack[scan.stack.length - 1];
      if (!entry) {
        this.pendingFrameMutationScans.shift();
        continue;
      }
      if (!entry.entered) {
        entry.entered = true;
        visitedNodes += 1;
        if (
          scan.action === "register" &&
          this.isNodeExcluded(entry.node)
        ) {
          scan.stack.pop();
          continue;
        }
        if (entry.node.nodeType === 1) {
          const element = entry.node as Element;
          if (isFrameElement(element)) {
            if (scan.action === "register") {
              this.registerDiscoveredFrame(element);
            } else {
              this.unregisterDiscoveredFrame(element);
            }
          }
          entry.shadowRoot = getOpenShadowRoot(element);
        }
        entry.childNodes = readChildNodes(entry.node);
        entry.childCount = entry.childNodes?.length ?? 0;
        continue;
      }
      if (entry.nextChildIndex < entry.childCount) {
        const child = entry.childNodes?.[entry.nextChildIndex];
        entry.nextChildIndex += 1;
        if (child) {
          scan.stack.push(createFrameTraversalEntry(child));
        }
        continue;
      }
      if (!entry.shadowQueued) {
        entry.shadowQueued = true;
        if (entry.shadowRoot) {
          scan.stack.push(createFrameTraversalEntry(entry.shadowRoot));
        }
        continue;
      }
      scan.stack.pop();
    }
    if (
      this.pendingFrameMutationScans.length > 0 &&
      this.frameMutationScanTimer === undefined &&
      !this.disposed
    ) {
      this.frameMutationScanTimer = this.scheduleTimeout(() => {
        this.frameMutationScanTimer = undefined;
        this.processFrameMutationScanSlice();
      }, 0);
    }
  }

  private pruneCollapsedFrameMutationScans(
    collapsedNode: Node | undefined,
  ): void {
    for (let index = this.pendingFrameMutationScans.length - 1; index >= 0; index -= 1) {
      const scan = this.pendingFrameMutationScans[index]!;
      if (scan.action !== "register") {
        continue;
      }
      const ownerReleased = !this.rootObservers.has(scan.ownerRoot);
      const rootCollapsed = collapsedNode !== undefined && (
        scan.root === collapsedNode || containsNode(collapsedNode, scan.root)
      );
      if (ownerReleased || rootCollapsed) {
        this.pendingFrameMutationScans.splice(index, 1);
      }
    }
    if (
      this.pendingFrameMutationScans.length === 0 &&
      this.frameMutationScanTimer !== undefined
    ) {
      this.cancelTimeout(this.frameMutationScanTimer);
      this.frameMutationScanTimer = undefined;
    }
  }

  private unregisterDiscoveredFrame(frameElement: HTMLIFrameElement): void {
    const frameRef = this.frameRefsByElement.get(frameElement);
    const invalidated = this.frameRegistry.unregisterFrame(frameElement);
    this.frameRefsByElement.delete(frameElement);
    if (frameRef && invalidated.length === 0) {
      this.releaseFrameIdentity(frameRef, true);
    }
    for (const identity of invalidated) {
      this.releaseFrameIdentity(identity.frameRef, true);
    }
  }

  private trackFrameDescription(
    frameElement: HTMLIFrameElement,
    description: FrameDescription,
    nodeRef?: string,
    activateSubtree = false,
  ): void {
    const parentFrameRef = description.parentFrameRef;
    if (parentFrameRef === undefined) {
      throwDomTreeError("internal-error");
    }
    if (activateSubtree) {
      this.inactiveFrameRefs.delete(description.frameRef);
    }
    this.frameRefsByElement.set(frameElement, description.frameRef);
    this.ownedFramesByRef.set(description.frameRef, {
      frameElement,
      parentFrameRef,
    });
    if (nodeRef) {
      this.frameDescriptions.set(nodeRef, description);
    }
    if (
      description.kind === "accessible" &&
      !this.inactiveFrameRefs.has(description.frameRef)
    ) {
      this.frameDocumentsByRef.set(description.frameRef, description.document);
      this.observeRoot(description.document);
    }
  }

  private collectFrameRefsAtOrBelow(
    nodeRef: string,
    collapsedNode?: Node,
  ): readonly string[] {
    const frameRefs = new Set<string>();
    const collapsedRecord = this.records.get(nodeRef);
    if (collapsedRecord?.kind === "frame-document") {
      frameRefs.add(collapsedRecord.scope.frameRef);
    }
    for (const [candidate, description] of this.frameDescriptions) {
      if (frameRefs.size >= FRAME_MUTATION_SCAN_LIMIT) {
        break;
      }
      if (this.isAtOrBelow(candidate, nodeRef)) {
        frameRefs.add(description.frameRef);
      }
    }
    for (const [frameRef, ownership] of this.ownedFramesByRef) {
      if (frameRefs.size >= FRAME_MUTATION_SCAN_LIMIT) {
        break;
      }
      if (
        collapsedNode &&
        isShadowIncludingDescendant(collapsedNode, ownership.frameElement)
      ) {
        frameRefs.add(frameRef);
      }
    }
    const childrenByParent = new Map<string, string[]>();
    let inspected = 0;
    for (const [frameRef, ownership] of this.ownedFramesByRef) {
      if (inspected >= FRAME_MUTATION_SCAN_LIMIT) {
        break;
      }
      inspected += 1;
      const children = childrenByParent.get(ownership.parentFrameRef) ?? [];
      children.push(frameRef);
      childrenByParent.set(ownership.parentFrameRef, children);
    }
    const pending = [...frameRefs];
    for (
      let index = 0;
      index < pending.length && index < FRAME_MUTATION_SCAN_LIMIT;
      index += 1
    ) {
      for (const childFrameRef of childrenByParent.get(pending[index]!) ?? []) {
        if (
          frameRefs.size >= FRAME_MUTATION_SCAN_LIMIT ||
          frameRefs.has(childFrameRef)
        ) {
          continue;
        }
        frameRefs.add(childFrameRef);
        pending.push(childFrameRef);
      }
    }
    return Object.freeze([...frameRefs]);
  }

  private releaseFrameDocuments(
    frameRefs: readonly string[],
    notifySelectedRemoval = true,
  ): void {
    const documents = new Set<Document>();
    for (const frameRef of frameRefs) {
      const document = this.frameDocumentsByRef.get(frameRef);
      this.frameDocumentsByRef.delete(frameRef);
      if (document) {
        documents.add(document);
      }
    }
    for (const document of documents) {
      this.disconnectObserversWithin(document);
      const invalidated = this.nodeRegistry.invalidateSubtree(document);
      this.releaseInvalidatedRefs(invalidated, notifySelectedRemoval);
    }
  }

  private releaseFrameIdentity(
    frameRef: string,
    releaseOwnership = false,
  ): void {
    this.releaseFrameDocuments([frameRef]);
    for (const [nodeRef, description] of this.frameDescriptions) {
      if (description.frameRef === frameRef) {
        this.frameDescriptions.delete(nodeRef);
      }
    }
    if (releaseOwnership) {
      const ownership = this.ownedFramesByRef.get(frameRef);
      if (ownership) {
        this.frameRefsByElement.delete(ownership.frameElement);
      }
      this.ownedFramesByRef.delete(frameRef);
      this.inactiveFrameRefs.delete(frameRef);
    }
  }

  private handleFrameLifecycle(event: FrameLifecycleEvent): void {
    if (this.disposed || event.type === "reset") {
      return;
    }
    const frameNodeRefs = [...this.frameDescriptions.entries()]
      .filter(([, description]) => description.frameRef === event.frameRef)
      .map(([nodeRef]) => nodeRef);
    if (event.type !== "registered") {
      this.releaseFrameIdentity(
        event.frameRef,
        event.type !== "navigated",
      );
    }
    for (const identity of event.invalidated ?? []) {
      this.releaseFrameIdentity(identity.frameRef, true);
    }
    if (event.type === "registered" || event.type === "navigated") {
      const context = this.frameRegistry.getContext(event.frameRef);
      if (context) {
        const description = Object.freeze({
          kind: "accessible" as const,
          ...context,
        });
        if (context.frameElement) {
          this.frameRefsByElement.set(context.frameElement, context.frameRef);
          if (context.parentFrameRef) {
            this.ownedFramesByRef.set(context.frameRef, {
              frameElement: context.frameElement,
              parentFrameRef: context.parentFrameRef,
            });
          }
        }
        if (!this.inactiveFrameRefs.has(context.frameRef)) {
          this.frameDocumentsByRef.set(context.frameRef, context.document);
          this.observeRoot(context.document);
        }
        for (const nodeRef of frameNodeRefs) {
          this.frameDescriptions.set(nodeRef, description);
        }
      } else if (event.parentFrameRef) {
        const description = Object.freeze({
          kind: "inaccessible" as const,
          locked: true as const,
          frameRef: event.frameRef,
          frameEpoch: event.frameEpoch,
          documentEpoch: event.documentEpoch,
          parentFrameRef: event.parentFrameRef,
        });
        for (const nodeRef of frameNodeRefs) {
          this.frameDescriptions.set(nodeRef, description);
        }
      }
    }
    if (event.type === "navigated" || event.type === "invalidated") {
      const affected = new Set<string>();
      for (const nodeRef of frameNodeRefs) {
        affected.add(nodeRef);
        const parentRef = this.records.get(nodeRef)?.parentRef;
        if (parentRef) {
          affected.add(parentRef);
        }
      }
      this.invalidateBranches(affected);
    }
    if (this.mutationProcessingDepth === 0) {
      this.emitPendingSelectedRemoval();
    }
    if (
      this.frameTracking &&
      (event.type === "registered" || event.type === "navigated")
    ) {
      const context = this.frameRegistry.getContext(event.frameRef);
      if (context) {
        this.queueFrameDiscovery(context.document);
      }
    }
    try {
      this.onFrameLifecycle?.(event);
    } catch {
      // Consumer callbacks cannot disrupt frame authority bookkeeping.
    }
  }

  private cancelScheduledWork(): void {
    if (this.mutationTimer !== undefined) {
      this.cancelTimeout(this.mutationTimer);
      this.mutationTimer = undefined;
    }
    if (this.shadowScanTimer !== undefined) {
      this.cancelTimeout(this.shadowScanTimer);
      this.shadowScanTimer = undefined;
    }
    if (this.frameMutationScanTimer !== undefined) {
      this.cancelTimeout(this.frameMutationScanTimer);
      this.frameMutationScanTimer = undefined;
    }
  }

  private stopShadowScanIfIdle(): void {
    if (
      this.expandedShadowHosts.size === 0 &&
      this.shadowScanTimer !== undefined
    ) {
      this.cancelTimeout(this.shadowScanTimer);
      this.shadowScanTimer = undefined;
      this.shadowScanOffset = 0;
    }
  }

  private disconnectAllObservers(): void {
    for (const observer of this.rootObservers.values()) {
      try {
        observer.disconnect();
      } catch {
        // Ownership is released even if a hostile observer adapter throws.
      }
    }
    this.rootObservers.clear();
  }

  private disconnectObserver(root: Node): void {
    const observer = this.rootObservers.get(root);
    if (!observer) {
      return;
    }
    this.rootObservers.delete(root);
    try {
      observer.disconnect();
    } catch {
      // Ownership is released even if a hostile observer adapter throws.
    }
  }

  private disconnectObserversWithin(root: Node): void {
    for (const observedRoot of [...this.rootObservers.keys()]) {
      if (
        observedRoot === root ||
        containsNode(root, observedRoot) ||
        isShadowRootHostedWithin(observedRoot, root)
      ) {
        this.disconnectObserver(observedRoot);
      }
    }
  }

  private isAtOrBelow(nodeRef: string, ancestorRef: string): boolean {
    const seen = new Set<string>();
    let currentRef: string | undefined = nodeRef;
    for (
      let depth = 0;
      currentRef &&
      !seen.has(currentRef) &&
      depth < this.maxRecords;
      depth += 1
    ) {
      if (currentRef === ancestorRef) {
        return true;
      }
      seen.add(currentRef);
      currentRef = this.records.get(currentRef)?.parentRef;
    }
    return false;
  }

  private requireActive(): void {
    if (this.disposed) {
      throwDomTreeError("session-disposed");
    }
  }
}

function createFrameTraversalEntry(node: Node): FrameTraversalEntry {
  return {
    node,
    entered: false,
    childNodes: undefined,
    childCount: 0,
    nextChildIndex: 0,
    shadowRoot: undefined,
    shadowQueued: false,
  };
}

function freezeLogicalChildPage(
  children: readonly LogicalChild[],
  hasMore: boolean,
  nextPhysicalOffset: number,
): LogicalChildPage {
  return Object.freeze({
    children: Object.freeze(children),
    hasMore,
    nextPhysicalOffset,
  });
}

function isFrameElement(element: Element): element is HTMLIFrameElement {
  try {
    return String(element.tagName).toUpperCase() === "IFRAME";
  } catch {
    return false;
  }
}

function isElementNode(value: unknown): value is Element {
  try {
    return typeof value === "object" && value !== null &&
      (value as { readonly nodeType?: unknown }).nodeType === 1;
  } catch {
    return false;
  }
}

function getOpenShadowRoot(element: Element): ShadowRoot | undefined {
  try {
    const shadowRoot = element.shadowRoot;
    return shadowRoot?.mode === "open" ? shadowRoot : undefined;
  } catch {
    return undefined;
  }
}

function isOpenShadowRoot(node: Node): node is ShadowRoot {
  if (node.nodeType !== 11) {
    return false;
  }
  try {
    const shadowRoot = node as ShadowRoot;
    return shadowRoot.mode === "open" &&
      typeof shadowRoot.host === "object" &&
      shadowRoot.host !== null;
  } catch {
    return false;
  }
}

function readShadowIncludingParent(node: Node): Node | undefined {
  try {
    const parent = node.parentNode;
    if (parent && typeof parent === "object") {
      return parent;
    }
  } catch {
    return undefined;
  }
  if (!isOpenShadowRoot(node)) {
    return undefined;
  }
  try {
    return node.host;
  } catch {
    return undefined;
  }
}

function hasElementChild(node: Node): boolean {
  const count = readChildElementCount(node);
  const first = readFirstElementChild(node);
  return count === false && first === false ? false : true;
}

function readChildElementCount(node: Node): boolean | undefined {
  try {
    const value = (node as unknown as { readonly childElementCount?: unknown })
      .childElementCount;
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value > 0
      : undefined;
  } catch {
    return undefined;
  }
}

function readFirstElementChild(node: Node): boolean | undefined {
  try {
    const value = (node as unknown as { readonly firstElementChild?: unknown })
      .firstElementChild;
    if (value === null) {
      return false;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      (value as Node).nodeType !== 1
    ) {
      return undefined;
    }
    return readShadowIncludingParent(value as Node) === node
      ? true
      : undefined;
  } catch {
    return undefined;
  }
}

function readChildNodes(node: Node): ArrayLike<Node> | undefined {
  try {
    const childNodes = (node as { readonly childNodes?: unknown }).childNodes;
    return childNodes && typeof childNodes === "object" &&
        typeof (childNodes as { readonly length?: unknown }).length === "number"
      ? childNodes as ArrayLike<Node>
      : undefined;
  } catch {
    return undefined;
  }
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function createElementLabel(element: Element): string {
  let tagName = "element";
  try {
    tagName = boundedDisplayToken(
      String(element.tagName).toLowerCase(),
    ) || "element";
  } catch {
    // Keep the fail-closed fallback.
  }
  let label = tagName;
  let id = "";
  try {
    id = boundedDisplayToken(String(element.id));
  } catch {
    id = "";
  }
  if (id) {
    label = appendLabelSegment(label, `#${id}`);
  }
  for (const className of readElementClassNames(element)) {
    label = appendLabelSegment(label, `.${className}`);
  }
  for (const attributeName of readApprovedAttributeNames(element)) {
    label = appendLabelSegment(label, ` [${attributeName}]`);
  }
  return label;
}

function appendLabelSegment(label: string, segment: string): string {
  return label.length + segment.length <= DOM_PROTOCOL_MAX_LABEL_LENGTH
    ? label + segment
    : label;
}

function boundedDisplayToken(value: string): string {
  return value
    .replace(/[\s.#\[\]<>&"'`=\\/\u0000-\u001f\u007f]/g, "_")
    .slice(0, ELEMENT_LABEL_MAX_TOKEN_LENGTH);
}

function readElementClassNames(element: Element): readonly string[] {
  let classList: ArrayLike<unknown>;
  try {
    classList = element.classList;
  } catch {
    return Object.freeze([]) as readonly string[];
  }
  const classes: string[] = [];
  const count = boundedArrayLikeLength(
    classList,
    ELEMENT_LABEL_MAX_CLASSES,
  );
  for (let index = 0; index < count; index += 1) {
    try {
      const className = boundedDisplayToken(String(classList[index]));
      if (className && !classes.includes(className)) {
        classes.push(className);
      }
    } catch {
      // Skip unreadable page-controlled class entries.
    }
  }
  return Object.freeze(classes);
}

function readApprovedAttributeNames(element: Element): readonly string[] {
  let attributes: ArrayLike<{ readonly name?: unknown }>;
  try {
    attributes = element.attributes;
  } catch {
    return Object.freeze([]) as readonly string[];
  }
  const names: string[] = [];
  const count = boundedArrayLikeLength(
    attributes,
    ELEMENT_LABEL_MAX_ATTRIBUTE_SCAN,
  );
  for (let index = 0; index < count; index += 1) {
    if (names.length >= ELEMENT_LABEL_MAX_ATTRIBUTES) {
      break;
    }
    try {
      const normalized = String(attributes[index]?.name).toLowerCase();
      if (
        isApprovedDisplayAttribute(normalized) &&
        !names.includes(normalized)
      ) {
        names.push(normalized.slice(0, ELEMENT_LABEL_MAX_TOKEN_LENGTH));
      }
    } catch {
      // Skip unreadable page-controlled attribute names.
    }
  }
  return Object.freeze(names);
}

function isApprovedDisplayAttribute(name: string): boolean {
  return name === "role" || /^(?:data|aria)-[a-z0-9_.:-]+$/.test(name);
}

function boundedArrayLikeLength(value: ArrayLike<unknown>, limit: number): number {
  try {
    const length = value.length;
    return typeof length === "number" && Number.isFinite(length) && length > 0
      ? Math.min(Math.floor(length), limit)
      : 0;
  } catch {
    return 0;
  }
}

function throwDomTreeError(code: DomErrorCode): never {
  throw new DomTreeProviderError(code);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH;
}

function isSessionRetentionReason(
  value: unknown,
): value is DomTreeSessionRetention {
  return value === "selected" || value === "hovered";
}

function sameNodeScope(left: NodeScope, right: NodeScope): boolean {
  return left.documentEpoch === right.documentEpoch &&
    left.frameRef === right.frameRef &&
    left.frameEpoch === right.frameEpoch;
}

function containsNode(root: Node, candidate: Node): boolean {
  try {
    const contains = root.contains;
    return typeof contains === "function" && contains.call(root, candidate) === true;
  } catch {
    return false;
  }
}

function isShadowIncludingDescendant(root: Node, candidate: Node): boolean {
  const seen = new Set<Node>();
  let current: Node | undefined = candidate;
  for (
    let depth = 0;
    current && depth < MAX_SHADOW_CONTAINMENT_DEPTH;
    depth += 1
  ) {
    if (current === root) {
      return true;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = readShadowIncludingParent(current);
  }
  return false;
}

function isShadowRootHostedWithin(candidate: Node, root: Node): boolean {
  let current: Node;
  try {
    const shadowRoot = candidate as ShadowRoot;
    if (shadowRoot.mode !== "open" || !shadowRoot.host) {
      return false;
    }
    current = shadowRoot.host;
  } catch {
    return false;
  }
  const seen = new Set<Node>();
  for (let depth = 0; depth < MAX_SHADOW_CONTAINMENT_DEPTH; depth += 1) {
    if (current === root || containsNode(root, current)) {
      return true;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    let parent: Node | null;
    try {
      parent = current.parentNode;
    } catch {
      return false;
    }
    if (parent) {
      current = parent;
      continue;
    }
    try {
      const shadowRoot = current as ShadowRoot;
      if (shadowRoot.mode !== "open" || !shadowRoot.host) {
        return false;
      }
      current = shadowRoot.host;
    } catch {
      return false;
    }
  }
  return false;
}
