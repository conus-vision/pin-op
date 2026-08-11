import {
  DomNodeRegistry,
  type DomNodeRegistrySnapshot,
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
import {
  DomStableLocatorService,
  type DomStableLocator,
  type StableLocatorResolution,
} from "./domStableLocator.js";

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
const ROLLBACK_FRAME_RECONCILIATION_MAX_ATTEMPTS = 16;
const ROLLBACK_FRAME_RECONCILIATION_MAX_EFFECTS = 256;
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

type DomTreeTimerHandle = number | ReturnType<typeof globalThis.setTimeout>;
type DomTreeScheduleTimeout = (
  callback: () => void,
  delay: number,
) => DomTreeTimerHandle;
type DomTreeCancelTimeout = (timer: DomTreeTimerHandle) => void;

export interface DomTreeProviderOptions {
  readonly documentEpoch?: number;
  readonly maxCursors?: number;
  readonly maxRecords?: number;
  readonly createMutationObserver?: (
    callback: (records: readonly MutationRecord[]) => void,
  ) => DomTreeMutationObserver;
  readonly setTimeout?: DomTreeScheduleTimeout;
  readonly clearTimeout?: DomTreeCancelTimeout;
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

export interface DomTreeResolvedLocator {
  readonly node: DomNodeView;
  readonly ancestorPath: readonly DomNodeView[];
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

interface SelectedNodeRefRead {
  readonly valid: boolean;
  readonly nodeRef: string | undefined;
}

interface ProviderMaterializationMetadata {
  readonly records: readonly (readonly [string, NodeRecord])[];
  readonly branchGenerations: readonly (readonly [string, number])[];
  readonly exhaustedBranches: readonly string[];
  readonly transientRecordRetentions: readonly (readonly [string, number])[];
  readonly expandedBranches: readonly (readonly [string, ExpandedBranch])[];
  readonly expandedShadowHosts: readonly string[];
  readonly shadowRootRefs: readonly (readonly [string, string])[];
  readonly frameDescriptions: readonly (readonly [string, FrameDescription])[];
  readonly frameDocumentsByRef: readonly (readonly [string, Document])[];
  readonly ownedFramesByRef: readonly (readonly [string, OwnedFrame])[];
  readonly inactiveFrameRefs: readonly string[];
  readonly cursors: readonly (readonly [string, CursorRecord])[];
  readonly nextCursor: number;
  readonly frameTracking: boolean;
  readonly shadowScanOffset: number;
  readonly pendingMutations: readonly PendingMutationRecord[];
  readonly pendingFrameMutationScans: readonly PendingFrameMutationScan[];
  readonly pendingSelectedRemoval: DomTreeSelectedNodeRemoval | undefined;
  readonly mutationTimer: DomTreeTimerHandle | undefined;
  readonly frameMutationScanTimer: DomTreeTimerHandle | undefined;
  readonly shadowScanTimer: DomTreeTimerHandle | undefined;
}

interface ProviderAuthoritySnapshot {
  readonly topDocument: Document | undefined;
  readonly documentEpoch: number;
  readonly authorityGeneration: number;
  readonly nodeRegistry: DomNodeRegistrySnapshot;
  readonly refsByNode: readonly (readonly [Node, string])[];
  readonly rootObservers: readonly (readonly [Node, DomTreeMutationObserver])[];
  readonly metadata: ProviderMaterializationMetadata;
}

interface RollbackTimerState {
  mutationTimer: DomTreeTimerHandle | undefined;
  frameMutationScanTimer: DomTreeTimerHandle | undefined;
  shadowScanTimer: DomTreeTimerHandle | undefined;
}

interface ProviderAuthorityOperation {
  publish(validate?: () => boolean): boolean;
  finalize(validate?: () => boolean, beforeEnqueue?: () => boolean): boolean;
  rollback(cleanup?: () => void): boolean;
}

interface PostCommitEffectBatch {
  readonly snapshot: ProviderAuthoritySnapshot;
  readonly effects: readonly ProviderOutwardEffect[];
}

type ProviderOutwardEffect =
  | { readonly kind: "frame"; readonly event: FrameLifecycleEvent }
  | { readonly kind: "invalidated"; readonly branch: DomInvalidationBranch }
  | { readonly kind: "selected-removed"; readonly event: DomTreeSelectedNodeRemoval }
  | { readonly kind: "mutation-settled" };

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
  private locatorService: DomStableLocatorService;
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
  private frameRefsByElement = new WeakMap<HTMLIFrameElement, string>();
  private readonly frameDocumentsByRef = new Map<string, Document>();
  private readonly ownedFramesByRef = new Map<string, OwnedFrame>();
  private readonly inactiveFrameRefs = new Set<string>();
  private readonly maxCursors: number;
  private readonly maxRecords: number;
  private documentEpoch: number;
  private readonly createMutationObserver: NonNullable<
    DomTreeProviderOptions["createMutationObserver"]
  >;
  private readonly scheduleTimeout: DomTreeScheduleTimeout;
  private readonly cancelTimeout: DomTreeCancelTimeout;
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
  private outwardEffectBuffer: ProviderOutwardEffect[] | undefined;
  private rollbackEffectSuppressionDepth = 0;
  private readonly postCommitEffectBatches: PostCommitEffectBatch[] = [];
  private postCommitDeliveryScheduled = false;
  private mutationTimer: DomTreeTimerHandle | undefined;
  private frameMutationScanTimer: DomTreeTimerHandle | undefined;
  private shadowScanTimer: DomTreeTimerHandle | undefined;
  private shadowScanOffset = 0;
  private mutationProcessingDepth = 0;
  private pendingSelectedRemoval: DomTreeSelectedNodeRemoval | undefined;
  private authorityGeneration = 0;
  private activePublicationGuard: (() => boolean) | undefined;
  private externalValueReadDepth = 0;
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
    this.scheduleTimeout = options.setTimeout ?? ((handler, timeout) => {
      const view = this.topDocument?.defaultView;
      return view
        ? view.setTimeout(handler, timeout)
        : globalThis.setTimeout(handler, timeout);
    });
    this.cancelTimeout = options.clearTimeout ?? ((timer) => {
      const view = this.topDocument?.defaultView;
      if (view) {
        view.clearTimeout(timer as number);
        return;
      }
      globalThis.clearTimeout(timer);
    });
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
    this.locatorService = this.createLocatorService(topDocument);
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

  private createLocatorService(topDocument: Document): DomStableLocatorService {
    return new DomStableLocatorService({
      topDocument,
      frameRegistry: this.frameRegistry,
      isExcludedNode: (node) => this.isNodeExcluded(node),
    });
  }

  private captureLocator(
    node: Node,
    kind: DomNodeView["kind"],
  ): DomStableLocator {
    try {
      return this.locatorService.capture(node, kind);
    } catch {
      throwDomTreeError("node-unavailable");
    }
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
    const operation = this.beginProviderAuthorityOperation();
    if (!operation) {
      throwDomTreeError("node-unavailable");
    }
    let committed = false;
    try {
      const context = this.frameRegistry.topContext;
      const element = this.topDocument?.documentElement;
      if (!context || !element) {
        throwDomTreeError("node-unavailable");
      }
      const response = Object.freeze({
        type: "dom.root" as const,
        requestId: "root",
        documentEpoch: this.documentEpoch,
        node: this.viewElement(element, context),
      });
      const validate = () => this.validateLivePathViews(
        [response.node],
        response.documentEpoch,
      );
      if (!operation.publish(validate) || !operation.finalize(validate)) {
        throwDomTreeError("node-unavailable");
      }
      committed = true;
      return response;
    } finally {
      if (!committed && !operation.rollback()) {
        throwDomTreeError("node-unavailable");
      }
    }
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
    const authorityOperation = this.beginProviderAuthorityOperation();
    if (!authorityOperation) {
      throwDomTreeError("node-unavailable");
    }
    let authorityCommitted = false;
    try {
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
    const locators = page.children.map((child) => this.captureLocator(
      child.node,
      child.kind,
    ));
    const materializedRefs: string[] = [];
    let nodes: readonly DomNodeView[];
    try {
      nodes = Object.freeze(page.children.map((child, index) => {
        const locator = locators[index]!;
        const view = child.kind === "element"
          ? this.viewElement(child.node, record!.scope, request.nodeRef, locator)
          : child.kind === "shadow-root"
            ? this.viewShadowRoot(child.node, record!.scope, request.nodeRef, locator)
            : this.viewFrameDocument(child.node, child.scope, request.nodeRef, locator);
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
    const response = Object.freeze({
      type: "dom.children",
      requestId: request.requestId,
      documentEpoch: this.documentEpoch,
      nodeRef: request.nodeRef,
      branchRevision: branch.revision,
      nodes,
      ...(nextCursor ? { nextCursor } : {}),
    });
    const validate = () => this.validateLiveChildPage(
      node,
      request.nodeRef,
      record!.scope,
      physicalOffset,
      page,
      response.nodes,
      response.documentEpoch,
      response.branchRevision,
      request.cursor,
      requestedCursor,
      nextCursor,
    );
    authorityCommitted = authorityOperation.publish(validate) &&
      authorityOperation.finalize(validate);
    if (!authorityCommitted) throwDomTreeError("node-unavailable");
    return response;
    } finally {
      if (!authorityCommitted && !authorityOperation.rollback()) {
        throwDomTreeError("node-unavailable");
      }
    }
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
    const authorityOperation = this.beginProviderAuthorityOperation();
    if (!authorityOperation) throwDomTreeError("node-unavailable");
    let committed = false;
    try {
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
      const result = Object.freeze(reversed.reverse());
      const validate = () => this.validateLivePathViews(result, documentEpoch);
      committed = authorityOperation.publish(validate) && authorityOperation.finalize(validate);
      if (!committed) throwDomTreeError("node-unavailable");
      return result;
    } finally {
      if (!committed && !authorityOperation.rollback()) {
        throwDomTreeError("node-unavailable");
      }
    }
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

  public resolveLocator(locator: DomStableLocator): DomTreeResolvedLocator | undefined {
    this.requireActive();
    this.flushMutationBarrier();
    if (this.outwardEffectBuffer) return undefined;
    const authorityOperation = this.beginProviderAuthorityOperation();
    if (!authorityOperation) return undefined;
    let transaction: ReturnType<DomStableLocatorService["beginResolve"]>;
    let committed = false;
    try {
      transaction = this.locatorService.beginResolve(locator);
      if (!transaction) return undefined;
      const resolved = transaction.resolution;
      if (this.isNodeExcluded(resolved.node)) return undefined;
      const path = this.logicalPathForResolvedLocator(resolved.kind, resolved.node);
      const ancestorPath = path ? this.materializeLogicalPath(path) : undefined;
      const node = ancestorPath?.at(-1);
      if (!ancestorPath || !node || node.kind !== resolved.kind) return undefined;
      const resolvedPath = path;
      if (!resolvedPath) return undefined;
      const validate = () => this.validateLiveResolvedLocator(
        locator,
        resolved.kind,
        resolved.node,
        resolvedPath,
        ancestorPath,
        node,
      );
      committed = authorityOperation.publish(validate) && authorityOperation.finalize(
        validate,
        () => {
          transaction!.commit();
          return true;
        },
      );
      if (!committed) return undefined;
      return Object.freeze({ node, ancestorPath });
    } catch {
      return undefined;
    } finally {
      if (!committed) {
        authorityOperation.rollback(() => transaction?.rollback());
      }
    }
  }

  private logicalPathForResolvedLocator(
    kind: DomStableLocator["targetKind"],
    node: Node,
  ): readonly LogicalPathEntry[] | undefined {
    if (kind === "element") {
      if (!isElementNode(node)) return undefined;
      const scope = this.attachedScopeFor(node);
      if (!scope) return undefined;
      const parentPath = this.planLogicalParentPath(node, scope);
      if (!parentPath) return undefined;
      return Object.freeze([...parentPath, { kind, node, scope }]);
    }
    if (kind === "shadow-root") {
      if (!isOpenShadowRoot(node) || this.isNodeExcluded(node.host)) return undefined;
      const scope = this.attachedScopeFor(node.host);
      if (!scope) return undefined;
      const parentPath = this.planLogicalParentPath(node.host, scope);
      if (!parentPath) return undefined;
      return Object.freeze([
        ...parentPath,
        { kind: "element" as const, node: node.host, scope },
        { kind, node, scope },
      ]);
    }
    if (node.nodeType !== 9) return undefined;
    const context = this.frameRegistry.getContextForDocument(node as Document);
    const frameElement = context?.frameElement;
    const parentContext = context?.parentFrameRef
      ? this.frameRegistry.getContext(context.parentFrameRef)
      : undefined;
    const parentPath = frameElement && parentContext
      ? this.planLogicalParentPath(frameElement, parentContext)
      : undefined;
    return context && frameElement && parentPath
      ? Object.freeze([
        ...parentPath,
        { kind: "element" as const, node: frameElement, scope: parentContext! },
        { kind, node: node as Document, scope: context },
      ])
      : undefined;
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
    this.authorityGeneration += 1;
    this.postCommitEffectBatches.length = 0;
    if (!this.frameRegistry.resetTopDocument(topDocument, documentEpoch)) {
      throwDomTreeError("node-unavailable");
    }
    this.locatorService = this.createLocatorService(topDocument);
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
    this.authorityGeneration += 1;
    this.disposed = true;
    this.postCommitEffectBatches.length = 0;
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
    locator = this.captureLocator(element, "element"),
    newlyRegisteredFrames?: Set<HTMLIFrameElement>,
  ): DomNodeView {
    const nodeRef = this.referenceNode(element, scope);
    const existing = this.records.get(nodeRef);
    const frameElement = isFrameElement(element);
    const frameWasRegistered = frameElement && this.frameRegistry
      .hasExactFrameElementRegistration(element, scope.frameRef);
    const frame = frameElement
      ? this.describeFrame(element, scope, nodeRef)
      : undefined;
    if (frameElement && frame && !frameWasRegistered) {
      newlyRegisteredFrames?.add(element);
    }
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
      locator,
    });
  }

  private viewShadowRoot(
    shadowRoot: ShadowRoot,
    scope: NodeScope,
    parentRef?: string,
    locator = this.captureLocator(shadowRoot, "shadow-root"),
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
      locator,
    });
  }

  private viewFrameDocument(
    document: Document,
    scope: FrameContext,
    parentRef?: string,
    locator = this.captureLocator(document, "frame-document"),
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
      locator,
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
    const selected = this.readSelectedNodeRef();
    if (!selected.valid) {
      throwDomTreeError("node-unavailable");
    }
    const selectedRef = selected.nodeRef;
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

  private invalidateBranches(nodeRefs: Iterable<string>): boolean {
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
      if (!this.emitInvalidated(Object.freeze({
        nodeRef,
        branchRevision: branch.revision,
      }))) {
        return false;
      }
    }
    return true;
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
    const authorityOperation = this.beginProviderAuthorityOperation();
    if (!authorityOperation) return undefined;
    let authorityCommitted = false;
    try {
    const locators = path.map((entry) => this.captureLocator(entry.node, entry.kind));
    const metadataSnapshot = this.snapshotMaterializationMetadata();
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
      this.restoreMaterializationMetadata(metadataSnapshot);
      return undefined;
    }

    const createdRefs = new Set<string>();
    const originalRecords = new Map<string, NodeRecord>();
    const newlyObservedRoots = new Set<Node>();
    const newlyRegisteredFrames = new Set<HTMLIFrameElement>();
    const views: DomNodeView[] = [];
    let parentRef: string | undefined;
    try {
      for (let index = 0; index < path.length; index += 1) {
        const entry = path[index]!;
        const knownRef = existingRefs.get(entry.node);
        if (knownRef) {
          const record = this.records.get(knownRef);
          if (!record) {
            throw new Error("path record disappeared during replacement");
          }
          originalRecords.set(knownRef, record);
        }
        const wasObserved = this.rootObservers.has(entry.node);
        const view = this.materializePathEntry(
          entry,
          parentRef,
          locators[index]!,
          newlyRegisteredFrames,
        );
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
      this.releasePathRetentions(temporaryRetentions);
      temporaryRetentions.clear();
      const validate = () => (
        this.validateMaterializedPath(path, parentRef!) &&
        this.validateLiveLogicalPath(path, views, parentRef!, this.documentEpoch)
      );
      authorityCommitted = authorityOperation.publish(validate) &&
        authorityOperation.finalize(validate);
      if (!authorityCommitted) return undefined;
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
      for (const frameElement of [...newlyRegisteredFrames].reverse()) {
        this.unregisterDiscoveredFrame(frameElement);
      }
      this.restoreMaterializationMetadata(metadataSnapshot);
      return undefined;
    } finally {
      this.releasePathRetentions(temporaryRetentions);
    }
    } finally {
      if (!authorityCommitted) authorityOperation.rollback();
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

  private snapshotProviderAuthority(): ProviderAuthoritySnapshot | undefined {
    const nodeRegistry = this.nodeRegistry.snapshot();
    if (!nodeRegistry) return undefined;
    const refsByNode: Array<readonly [Node, string]> = [];
    for (const { node, ref } of nodeRegistry.entries) {
      if (this.refsByNode.get(node) === ref) refsByNode.push([node, ref]);
    }
    return {
      topDocument: this.topDocument,
      documentEpoch: this.documentEpoch,
      authorityGeneration: this.authorityGeneration,
      nodeRegistry,
      refsByNode: Object.freeze(refsByNode),
      rootObservers: Object.freeze([...this.rootObservers]),
      metadata: this.snapshotMaterializationMetadata(),
    };
  }

  private beginProviderAuthorityOperation(): ProviderAuthorityOperation | undefined {
    const snapshot = this.snapshotProviderAuthority();
    if (!snapshot) return undefined;
    const parentBuffer = this.outwardEffectBuffer;
    const buffer = parentBuffer ?? [];
    const ownsBuffer = parentBuffer === undefined;
    // Nested operations share the owner journal but own only their suffix.
    const effectSavepoint = buffer.length;
    const parentPublicationGuard = this.activePublicationGuard;
    const publicationGuard = () => (
      this.isProviderAuthorityCurrent(snapshot) &&
      (parentPublicationGuard?.() ?? true)
    );
    if (ownsBuffer) this.outwardEffectBuffer = buffer;
    if (ownsBuffer) this.activePublicationGuard = publicationGuard;
    let closed = false;
    let published = false;
    return {
      publish: (_validate = () => true) => {
        if (closed || published || (ownsBuffer && this.outwardEffectBuffer !== buffer)) return false;
        // Publishing only seals the internal operation. The complete live proof
        // happens in finalize, immediately before effects enter the outbox.
        if (!this.isProviderAuthorityCurrent(snapshot)) return false;
        published = true;
        return true;
      },
      finalize: (validate = () => true, beforeEnqueue) => {
        if (closed || !published) return false;
        if (!this.isProviderAuthorityCurrent(snapshot) || !validate()) {
          return false;
        }
        if (beforeEnqueue) {
          try {
            if (!beforeEnqueue()) return false;
          } catch {
            return false;
          }
          if (!this.isProviderAuthorityCurrent(snapshot) || !validate()) return false;
        }
        if (ownsBuffer && this.outwardEffectBuffer !== buffer) return false;
        if (ownsBuffer && this.activePublicationGuard !== publicationGuard) return false;
        closed = true;
        if (ownsBuffer) {
          this.activePublicationGuard = parentPublicationGuard;
          this.outwardEffectBuffer = undefined;
          this.enqueuePostCommitEffects(buffer, snapshot);
        }
        return true;
      },
      rollback: (cleanup) => {
        if (closed || (ownsBuffer && !published && this.outwardEffectBuffer !== buffer)) return false;
        let restored = true;
        const discardEffectsSinceSavepoint = (): boolean => {
          if (this.outwardEffectBuffer !== buffer) return false;
          buffer.length = effectSavepoint;
          return true;
        };
        try {
          cleanup?.();
        } catch {
          restored = false;
        }
        try {
          if (!this.isProviderAuthorityCurrent(snapshot)) {
            restored = false;
          } else {
            restored = this.reconcileRollbackFrameAuthority(
              snapshot,
              buffer,
              effectSavepoint,
            ) && restored;
          }
        } catch {
          restored = false;
        } finally {
          if (!discardEffectsSinceSavepoint()) restored = false;
          closed = true;
          if (ownsBuffer) {
            if (this.outwardEffectBuffer === buffer) this.outwardEffectBuffer = undefined;
            if (this.activePublicationGuard === publicationGuard) {
              this.activePublicationGuard = parentPublicationGuard;
            }
          }
        }
        return restored;
      },
    };
  }

  private isProviderAuthorityCurrent(snapshot: ProviderAuthoritySnapshot): boolean {
    return !this.disposed &&
      this.topDocument === snapshot.topDocument &&
      this.documentEpoch === snapshot.documentEpoch &&
      this.authorityGeneration === snapshot.authorityGeneration;
  }

  private reconcileRollbackFrameAuthority(
    snapshot: ProviderAuthoritySnapshot,
    buffer: ProviderOutwardEffect[],
    effectSavepoint: number,
  ): boolean {
    if (this.outwardEffectBuffer !== buffer) return false;
    const temporaryFrameRefs = new Set<string>();
    const retainedEvents: FrameLifecycleEvent[] = [];
    let effectCursor = effectSavepoint;
    let processedEffects = 0;

    for (
      let attempt = 0;
      attempt < ROLLBACK_FRAME_RECONCILIATION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      if (
        !this.isProviderAuthorityCurrent(snapshot) ||
        this.outwardEffectBuffer !== buffer
      ) return false;
      const end = buffer.length;
      const effects = Object.freeze(buffer.slice(effectCursor, end));
      effectCursor = end;
      processedEffects += effects.length;
      if (processedEffects > ROLLBACK_FRAME_RECONCILIATION_MAX_EFFECTS) return false;
      const retained = this.rollbackBufferedFrameRegistrations(
        effects,
        snapshot,
        temporaryFrameRefs,
      );
      if (!retained) return false;
      retainedEvents.push(...retained);

      if (!this.restoreProviderAuthority(snapshot, retainedEvents)) {
        if (
          this.isProviderAuthorityCurrent(snapshot) &&
          this.outwardEffectBuffer === buffer &&
          buffer.length > effectCursor
        ) continue;
        return false;
      }
      if (buffer.length > effectCursor) continue;

      if (!this.replayRetainedFrameEvents(snapshot, retainedEvents)) return false;
      if (buffer.length > effectCursor) continue;
      const converged = this.hasConvergedFrameAuthority();
      if (buffer.length > effectCursor) continue;
      if (!converged) return false;
      return true;
    }
    return false;
  }

  private replayRetainedFrameEvents(
    snapshot: ProviderAuthoritySnapshot,
    events: readonly FrameLifecycleEvent[],
  ): boolean {
    this.rollbackEffectSuppressionDepth += 1;
    try {
      for (const event of events) {
        if (!this.isProviderAuthorityCurrent(snapshot)) return false;
        if (!this.handleFrameLifecycle(event)) return false;
      }
      return this.isProviderAuthorityCurrent(snapshot);
    } finally {
      this.rollbackEffectSuppressionDepth -= 1;
    }
  }

  private hasConvergedFrameAuthority(): boolean {
    try {
      for (const [frameRef, document] of this.frameDocumentsByRef) {
        const context = this.frameRegistry.getContext(frameRef);
        if (!context || context.document !== document || !this.rootObservers.has(document)) {
          return false;
        }
      }
      for (const description of this.frameDescriptions.values()) {
        const context = this.frameRegistry.getContext(description.frameRef);
        if (description.kind === "accessible") {
          if (
            !context ||
            context.document !== description.document ||
            context.frameEpoch !== description.frameEpoch ||
            context.documentEpoch !== description.documentEpoch ||
            context.parentFrameRef !== description.parentFrameRef
          ) return false;
        } else if (context) {
          return false;
        }
      }
      for (const [frameRef, owned] of this.ownedFramesByRef) {
        const context = this.frameRegistry.getContext(frameRef);
        if (
          !context ||
          context.frameElement !== owned.frameElement ||
          context.parentFrameRef !== owned.parentFrameRef
        ) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private rollbackBufferedFrameRegistrations(
    effects: readonly ProviderOutwardEffect[],
    snapshot: ProviderAuthoritySnapshot,
    temporaryFrameRefs: Set<string> = new Set<string>(),
  ): readonly FrameLifecycleEvent[] | undefined {
    if (!this.isProviderAuthorityCurrent(snapshot)) return undefined;
    const events = effects.flatMap((effect) => effect.kind === "frame" ? [effect.event] : []);
    const registeredFrameRefs = events
      .filter((event) => event.type === "registered")
      .map((event) => event.frameRef)
      .filter((frameRef) => {
        if (temporaryFrameRefs.has(frameRef)) return false;
        temporaryFrameRefs.add(frameRef);
        return true;
      })
      .reverse();
    for (const frameRef of registeredFrameRefs) {
      this.frameRegistry.unregisterFrame(frameRef);
      if (!this.isProviderAuthorityCurrent(snapshot)) return undefined;
    }
    return Object.freeze(events.flatMap((event) => {
      if (temporaryFrameRefs.has(event.frameRef)) return [];
      const invalidated = event.invalidated?.filter((identity) => (
        !temporaryFrameRefs.has(identity.frameRef)
      ));
      if (invalidated?.length === event.invalidated?.length) return [event];
      const { invalidated: _discarded, ...withoutInvalidated } = event;
      return [Object.freeze({
        ...withoutInvalidated,
        ...(invalidated?.length ? { invalidated: Object.freeze(invalidated) } : {}),
      })];
    }));
  }

  private restoreProviderAuthority(
    snapshot: ProviderAuthoritySnapshot,
    retainedEvents: readonly FrameLifecycleEvent[] = [],
  ): boolean {
    try {
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      const retainedFrames = new Set(
        snapshot.metadata.ownedFramesByRef.map(([, owned]) => owned.frameElement),
      );
      const newFrames = [...this.ownedFramesByRef.values()]
        .filter(({ frameElement }) => !retainedFrames.has(frameElement))
        .map(({ frameElement }) => frameElement)
        .reverse();
      for (const frameElement of newFrames) {
        if (!this.isProviderAuthorityCurrent(snapshot)) return false;
        const frameRef = this.frameRefsByElement.get(frameElement);
        this.unregisterDiscoveredFrame(frameElement);
        if (
          !this.isProviderAuthorityCurrent(snapshot) ||
          this.frameRefsByElement.get(frameElement) !== undefined ||
          (frameRef !== undefined && this.ownedFramesByRef.has(frameRef))
        ) {
          return false;
        }
      }

      const expectedObservers = new Map(snapshot.rootObservers);
      const retainedFrameRefs = new Set(retainedEvents.map(({ frameRef }) => frameRef));
      const retainedSnapshotDocuments = new Set(snapshot.metadata.frameDocumentsByRef
        .filter(([frameRef]) => retainedFrameRefs.has(frameRef))
        .map(([, document]) => document));
      for (const root of [...this.rootObservers.keys()]) {
        if (expectedObservers.has(root)) continue;
        if (!this.isProviderAuthorityCurrent(snapshot)) return false;
        this.disconnectObserver(root);
        if (
          !this.isProviderAuthorityCurrent(snapshot) ||
          this.rootObservers.get(root) !== undefined
        ) {
          return false;
        }
      }
      for (const [root, observer] of expectedObservers) {
        if (
          this.rootObservers.get(root) !== observer &&
          !retainedSnapshotDocuments.has(root as Document)
        ) return false;
      }
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      if (!this.restoreSnapshotTimers(snapshot)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      if (!this.nodeRegistry.restore(snapshot.nodeRegistry)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;

      this.refsByNode = new WeakMap<Node, string>();
      for (const [node, ref] of snapshot.refsByNode) this.refsByNode.set(node, ref);
      this.restoreMaterializationMetadata(snapshot.metadata);
      restoreMap(this.rootObservers, snapshot.rootObservers);
      this.frameRefsByElement = new WeakMap<HTMLIFrameElement, string>();
      for (const [frameRef, owned] of snapshot.metadata.ownedFramesByRef) {
        this.frameRefsByElement.set(owned.frameElement, frameRef);
      }
      return true;
    } catch {
      return false;
    }
  }

  private restoreSnapshotTimers(snapshot: ProviderAuthoritySnapshot): boolean {
    const timers: RollbackTimerState = {
      mutationTimer: this.mutationTimer,
      frameMutationScanTimer: this.frameMutationScanTimer,
      shadowScanTimer: this.shadowScanTimer,
    };
    if (!this.areRollbackTimersCurrent(snapshot, timers)) return false;
    const metadata = snapshot.metadata;
    if (
      (metadata.mutationTimer !== undefined && timers.mutationTimer !== metadata.mutationTimer) ||
      (metadata.frameMutationScanTimer !== undefined &&
        timers.frameMutationScanTimer !== metadata.frameMutationScanTimer) ||
      (metadata.shadowScanTimer !== undefined && timers.shadowScanTimer !== metadata.shadowScanTimer)
    ) {
      return false;
    }
    return this.cancelRollbackTimers(snapshot, timers);
  }

  private areRollbackTimersCurrent(
    snapshot: ProviderAuthoritySnapshot,
    timers: RollbackTimerState,
  ): boolean {
    return this.isProviderAuthorityCurrent(snapshot) &&
      this.mutationTimer === timers.mutationTimer &&
      this.frameMutationScanTimer === timers.frameMutationScanTimer &&
      this.shadowScanTimer === timers.shadowScanTimer;
  }

  private cancelRollbackTimers(
    snapshot: ProviderAuthoritySnapshot,
    timers: RollbackTimerState,
  ): boolean {
    const timerNames: readonly (keyof RollbackTimerState)[] = [
      "mutationTimer",
      "frameMutationScanTimer",
      "shadowScanTimer",
    ];
    for (const timer of timerNames) {
      if (!this.areRollbackTimersCurrent(snapshot, timers)) return false;
      const handle = timers[timer];
      if (snapshot.metadata[timer] !== undefined) {
        if (handle !== snapshot.metadata[timer]) return false;
        continue;
      }
      if (handle === undefined) continue;
      let cancelled = true;
      try {
        this.cancelTimeout(handle);
      } catch {
        cancelled = false;
      }
      if (!this.areRollbackTimersCurrent(snapshot, timers) || !cancelled) return false;
      this[timer] = undefined;
      timers[timer] = undefined;
    }
    return this.areRollbackTimersCurrent(snapshot, timers);
  }

  private snapshotMaterializationMetadata(): ProviderMaterializationMetadata {
    return {
      records: [...this.records],
      branchGenerations: [...this.branchGenerations],
      exhaustedBranches: [...this.exhaustedBranches],
      transientRecordRetentions: [...this.transientRecordRetentions],
      expandedBranches: snapshotExpandedBranches(this.expandedBranches),
      expandedShadowHosts: [...this.expandedShadowHosts],
      shadowRootRefs: [...this.shadowRootRefs],
      frameDescriptions: [...this.frameDescriptions],
      frameDocumentsByRef: [...this.frameDocumentsByRef],
      ownedFramesByRef: [...this.ownedFramesByRef],
      inactiveFrameRefs: [...this.inactiveFrameRefs],
      cursors: [...this.cursors],
      nextCursor: this.nextCursor,
      frameTracking: this.frameTracking,
      shadowScanOffset: this.shadowScanOffset,
      pendingMutations: [...this.pendingMutations],
      pendingFrameMutationScans: snapshotPendingFrameMutationScans(
        this.pendingFrameMutationScans,
      ),
      pendingSelectedRemoval: this.pendingSelectedRemoval,
      mutationTimer: this.mutationTimer,
      frameMutationScanTimer: this.frameMutationScanTimer,
      shadowScanTimer: this.shadowScanTimer,
    };
  }

  private restoreMaterializationMetadata(snapshot: ProviderMaterializationMetadata): void {
    restoreMap(this.records, snapshot.records);
    restoreMap(this.branchGenerations, snapshot.branchGenerations);
    restoreSet(this.exhaustedBranches, snapshot.exhaustedBranches);
    restoreMap(this.transientRecordRetentions, snapshot.transientRecordRetentions);
    restoreMap(this.expandedBranches, snapshotExpandedBranches(snapshot.expandedBranches));
    restoreSet(this.expandedShadowHosts, snapshot.expandedShadowHosts);
    restoreMap(this.shadowRootRefs, snapshot.shadowRootRefs);
    restoreMap(this.frameDescriptions, snapshot.frameDescriptions);
    restoreMap(this.frameDocumentsByRef, snapshot.frameDocumentsByRef);
    restoreMap(this.ownedFramesByRef, snapshot.ownedFramesByRef);
    restoreSet(this.inactiveFrameRefs, snapshot.inactiveFrameRefs);
    restoreMap(this.cursors, snapshot.cursors);
    // Cursors are opaque capabilities: rollback may remove their records, but
    // must never make a previously issued token available again.
    this.nextCursor = Math.max(this.nextCursor, snapshot.nextCursor);
    this.frameTracking = snapshot.frameTracking;
    this.shadowScanOffset = snapshot.shadowScanOffset;
    this.pendingMutations.splice(0, this.pendingMutations.length, ...snapshot.pendingMutations);
    this.pendingFrameMutationScans.splice(
      0,
      this.pendingFrameMutationScans.length,
      ...snapshotPendingFrameMutationScans(snapshot.pendingFrameMutationScans),
    );
    this.pendingSelectedRemoval = snapshot.pendingSelectedRemoval;
    this.mutationTimer = snapshot.mutationTimer;
    this.frameMutationScanTimer = snapshot.frameMutationScanTimer;
    this.shadowScanTimer = snapshot.shadowScanTimer;
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
    locator: DomStableLocator,
    newlyRegisteredFrames: Set<HTMLIFrameElement>,
  ): DomNodeView {
    if (entry.kind === "element") {
      return this.viewElement(
        entry.node,
        entry.scope,
        parentRef,
        locator,
        newlyRegisteredFrames,
      );
    }
    if (entry.kind === "shadow-root") {
      if (!parentRef) {
        throw new Error("shadow root path is missing its host");
      }
      const view = this.viewShadowRoot(entry.node, entry.scope, parentRef, locator);
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
      locator,
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

  private validatePublishedViews(
    views: readonly DomNodeView[],
    documentEpoch: number,
  ): boolean {
    if (this.disposed || this.documentEpoch !== documentEpoch) return false;
    return views.every((view) => {
      const record = this.records.get(view.nodeRef);
      if (
        !record ||
        record.kind !== view.kind ||
        record.scope.documentEpoch !== documentEpoch ||
        this.nodeRegistry.resolve(view.nodeRef, record.scope) === undefined
      ) {
        return false;
      }
      if (record.kind === "frame-document") {
        const context = this.frameRegistry.getContext(record.scope.frameRef);
        return !!context && sameNodeScope(context, record.scope as FrameContext);
      }
      return true;
    });
  }

  private validateLiveResolvedLocator(
    locator: DomStableLocator,
    kind: DomStableLocator["targetKind"],
    target: Node,
    path: readonly LogicalPathEntry[],
    views: readonly DomNodeView[],
    node: DomNodeView,
  ): boolean {
    const resolved = this.resolveLocatorForLiveValidation(locator);
    return !!resolved &&
      resolved.kind === kind &&
      resolved.node === target &&
      node.kind === kind &&
      this.validateMaterializedPath(path, node.nodeRef) &&
      this.validateLiveLogicalPath(path, views, node.nodeRef, this.documentEpoch);
  }

  private validateLiveLogicalPath(
    path: readonly LogicalPathEntry[],
    views: readonly DomNodeView[],
    finalRef: string,
    documentEpoch: number,
  ): boolean {
    if (
      path.length !== views.length ||
      !this.validatePublishedViews(views, documentEpoch) ||
      !this.validateLivePathViews(views, documentEpoch)
    ) {
      return false;
    }
    return path.every((entry, index) => {
      const view = views[index]!;
      const record = this.records.get(view.nodeRef);
      return record?.kind === entry.kind &&
        record.scope.documentEpoch === documentEpoch &&
        sameNodeScope(record.scope, entry.scope) &&
        this.nodeRegistry.resolve(view.nodeRef, record.scope) === entry.node;
    }) && views.at(-1)?.nodeRef === finalRef;
  }

  private validateLivePathViews(
    views: readonly DomNodeView[],
    documentEpoch: number,
  ): boolean {
    if (views.length === 0 || !this.validatePublishedViews(views, documentEpoch)) {
      return false;
    }
    try {
      const finalView = views.at(-1)!;
      const finalRecord = this.records.get(finalView.nodeRef);
      const finalNode = finalRecord
        ? this.nodeRegistry.resolve(finalView.nodeRef, finalRecord.scope)
        : undefined;
      if (!finalRecord || !finalNode) return false;
      const livePath = this.logicalPathForResolvedLocator(finalRecord.kind, finalNode);
      if (!livePath || livePath.length !== views.length) return false;
      for (let index = 0; index < views.length; index += 1) {
        const view = views[index]!;
        const entry = livePath[index]!;
        const record = this.records.get(view.nodeRef);
        if (
          !record ||
          record.kind !== entry.kind ||
          !sameNodeScope(record.scope, entry.scope) ||
          this.nodeRegistry.resolve(view.nodeRef, record.scope) !== entry.node
        ) {
          return false;
        }
      }
      return this.validateLiveViews(views, documentEpoch);
    } catch {
      return false;
    }
  }

  private validateLiveChildPage(
    parent: Node,
    parentRef: string,
    scope: NodeScope,
    physicalOffset: number,
    expected: LogicalChildPage,
    views: readonly DomNodeView[],
    documentEpoch: number,
    branchRevision: number,
    cursor: string | undefined,
    expectedCursor: CursorRecord | undefined,
    nextCursor: string | undefined,
  ): boolean {
    try {
      const parentRecord = this.records.get(parentRef);
      const resolvedParent = parentRecord
        ? this.nodeRegistry.resolve(parentRef, parentRecord.scope)
        : undefined;
      if (
        !this.validateLiveViews(views, documentEpoch) ||
        !parentRecord ||
        resolvedParent !== parent ||
        !sameNodeScope(parentRecord.scope, scope) ||
        parentRecord.scope.documentEpoch !== documentEpoch ||
        this.expandedBranches.get(parentRef)?.revision !== branchRevision ||
        (cursor !== undefined && (
          !expectedCursor ||
          this.cursors.get(cursor) !== expectedCursor ||
          !expectedCursor.active ||
          expectedCursor.nodeRef !== parentRef ||
          expectedCursor.documentEpoch !== documentEpoch ||
          expectedCursor.branchRevision !== branchRevision ||
          expectedCursor.physicalOffset !== physicalOffset
        )) ||
        (nextCursor !== undefined && (
          this.cursors.get(nextCursor)?.nodeRef !== parentRef ||
          this.cursors.get(nextCursor)?.documentEpoch !== documentEpoch ||
          this.cursors.get(nextCursor)?.branchRevision !== branchRevision ||
          !this.cursors.get(nextCursor)?.active
        ))
      ) {
        return false;
      }
      const liveParentPath = this.logicalPathForResolvedLocator(parentRecord.kind, parent);
      if (!liveParentPath || !this.validateMaterializedPath(liveParentPath, parentRef)) {
        return false;
      }
      const current = this.logicalChildPage(parent, parentRef, scope, physicalOffset);
      if (
        current.hasMore !== expected.hasMore ||
        current.nextPhysicalOffset !== expected.nextPhysicalOffset ||
        current.children.length !== expected.children.length ||
        current.children.length !== views.length
      ) {
        return false;
      }
      return current.children.every((child, index) => {
        const expectedChild = expected.children[index]!;
        const view = views[index]!;
        const record = this.records.get(view.nodeRef);
        return child.kind === expectedChild.kind &&
          child.node === expectedChild.node &&
          child.kind === view.kind &&
          !!record &&
          this.nodeRegistry.resolve(view.nodeRef, record.scope) === child.node &&
          (child.kind !== "frame-document" || (
            expectedChild.kind === "frame-document" &&
            sameNodeScope(child.scope, expectedChild.scope)
          ));
      });
    } catch {
      return false;
    }
  }

  private validateLiveViews(
    views: readonly DomNodeView[],
    documentEpoch: number,
  ): boolean {
    if (!this.validatePublishedViews(views, documentEpoch)) return false;
    return views.every((view) => this.validateViewLocator(view));
  }

  private validateViewLocator(view: DomNodeView): boolean {
    const record = this.records.get(view.nodeRef);
    const node = record
      ? this.nodeRegistry.resolve(view.nodeRef, record.scope)
      : undefined;
    const resolved = this.resolveLocatorForLiveValidation(view.locator);
    return !!record &&
      !!node &&
      !!resolved &&
      resolved.kind === view.kind &&
      resolved.node === node;
  }

  private resolveLocatorForLiveValidation(
    locator: DomStableLocator,
  ): StableLocatorResolution | undefined {
    const buffer = this.outwardEffectBuffer ?? [];
    const previousBuffer = this.outwardEffectBuffer;
    const effectOffset = buffer.length;
    if (!previousBuffer) this.outwardEffectBuffer = buffer;
    let transaction: ReturnType<DomStableLocatorService["beginResolve"]>;
    try {
      transaction = this.locatorService.beginResolve(locator);
      return transaction?.resolution;
    } catch {
      return undefined;
    } finally {
      try {
        transaction?.rollback();
      } catch {
        // Validation is read-only from the provider's perspective.
      }
      buffer.length = effectOffset;
      if (!previousBuffer) this.outwardEffectBuffer = undefined;
    }
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

  private readSelectedNodeRef(): SelectedNodeRefRead {
    if (!this.getSelectedNodeRef) {
      return Object.freeze({ valid: true, nodeRef: undefined });
    }
    if (!this.publicationCanContinue()) {
      return Object.freeze({ valid: false, nodeRef: undefined });
    }
    let nodeRef: string | undefined;
    this.externalValueReadDepth += 1;
    try {
      const selected = this.getSelectedNodeRef();
      nodeRef = typeof selected === "string" ? selected : undefined;
    } catch {
      // A selected-ref provider is optional and cannot break ownership cleanup.
    } finally {
      this.externalValueReadDepth -= 1;
    }
    if (!this.publicationCanContinue()) {
      return Object.freeze({ valid: false, nodeRef: undefined });
    }
    return Object.freeze({ valid: true, nodeRef });
  }

  private releaseInvalidatedRefs(
    nodeRefs: readonly string[],
    notifySelectedRemoval = true,
  ): boolean {
    if (nodeRefs.length === 0) {
      return true;
    }
    const invalidated = new Set(nodeRefs);
    const selected = notifySelectedRemoval
      ? this.readSelectedNodeRef()
      : Object.freeze({ valid: true, nodeRef: undefined });
    if (!selected.valid) return false;
    const selectedRef = selected.nodeRef;
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
    if (notifySelectedRemoval && selectedRef !== undefined && selectedWasRemoved) {
      this.pendingSelectedRemoval ??= Object.freeze({
        nodeRef: selectedRef,
        documentEpoch: this.documentEpoch,
      });
    }
    return true;
  }

  private emitPendingSelectedRemoval(): boolean {
    const event = this.pendingSelectedRemoval;
    this.pendingSelectedRemoval = undefined;
    if (!event) {
      return true;
    }
    return this.emitSelectedNodeRemoved(event);
  }

  private emitMutationSettled(): boolean {
    if (this.outwardEffectBuffer) {
      if (this.rollbackEffectSuppressionDepth === 0) {
        this.outwardEffectBuffer.push({ kind: "mutation-settled" });
      }
      return true;
    }
    return this.onMutationSettled
      ? this.invokeOutwardCallback(this.onMutationSettled)
      : true;
  }

  private emitInvalidated(branch: DomInvalidationBranch): boolean {
    if (this.outwardEffectBuffer) {
      if (this.rollbackEffectSuppressionDepth === 0) {
        this.outwardEffectBuffer.push({ kind: "invalidated", branch });
      }
      return true;
    }
    return this.onInvalidated
      ? this.invokeOutwardCallback(() => this.onInvalidated?.(branch))
      : true;
  }

  private emitSelectedNodeRemoved(event: DomTreeSelectedNodeRemoval): boolean {
    if (this.outwardEffectBuffer) {
      if (this.rollbackEffectSuppressionDepth === 0) {
        this.outwardEffectBuffer.push({ kind: "selected-removed", event });
      }
      return true;
    }
    return this.onSelectedNodeRemoved
      ? this.invokeOutwardCallback(() => this.onSelectedNodeRemoved?.(event))
      : true;
  }

  private invokeOutwardCallback(callback: (() => void) | undefined): boolean {
    if (!this.publicationCanContinue()) return false;
    try {
      callback?.();
    } catch {
      // Consumer callbacks cannot disrupt DOM ownership bookkeeping.
    }
    return this.publicationCanContinue();
  }

  private publicationCanContinue(): boolean {
    try {
      return this.activePublicationGuard?.() ?? true;
    } catch {
      return false;
    }
  }

  private enqueuePostCommitEffects(
    effects: readonly ProviderOutwardEffect[],
    snapshot: ProviderAuthoritySnapshot,
  ): void {
    if (effects.length === 0) return;
    this.postCommitEffectBatches.push(Object.freeze({
      snapshot,
      effects: Object.freeze([...effects]),
    }));
    if (this.postCommitDeliveryScheduled) return;
    this.postCommitDeliveryScheduled = true;
    globalThis.queueMicrotask(() => this.flushPostCommitEffects());
  }

  private flushPostCommitEffects(): void {
    this.postCommitDeliveryScheduled = false;
    const batches = this.postCommitEffectBatches.splice(0, this.postCommitEffectBatches.length);
    for (const batch of batches) {
      if (!this.isProviderAuthorityCurrent(batch.snapshot)) continue;
      for (const effect of batch.effects) {
        if (!this.isProviderAuthorityCurrent(batch.snapshot)) break;
        if (!this.emitCommittedOutwardEffect(effect)) break;
      }
    }
  }

  private emitCommittedOutwardEffect(effect: ProviderOutwardEffect): boolean {
    if (effect.kind === "frame") {
      return this.emitFrameLifecycle(effect.event);
    } else if (effect.kind === "invalidated") {
      return this.emitInvalidated(effect.branch);
    } else if (effect.kind === "selected-removed") {
      return this.emitSelectedNodeRemoved(effect.event);
    } else {
      return this.emitMutationSettled();
    }
  }

  private emitFrameLifecycle(event: FrameLifecycleEvent): boolean {
    if (this.outwardEffectBuffer) {
      if (this.rollbackEffectSuppressionDepth === 0) {
        this.outwardEffectBuffer.push({ kind: "frame", event });
      }
      return true;
    }
    return this.onFrameLifecycle
      ? this.invokeOutwardCallback(() => this.onFrameLifecycle?.(event))
      : true;
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
  ): boolean {
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
      if (!this.releaseInvalidatedRefs(invalidated, notifySelectedRemoval)) {
        return false;
      }
    }
    return true;
  }

  private releaseFrameIdentity(
    frameRef: string,
    releaseOwnership = false,
  ): boolean {
    if (!this.releaseFrameDocuments([frameRef])) return false;
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
    return true;
  }

  private handleFrameLifecycle(event: FrameLifecycleEvent): boolean {
    if (!this.outwardEffectBuffer) {
      this.authorityGeneration += 1;
    }
    if (this.externalValueReadDepth > 0 && this.activePublicationGuard) {
      return false;
    }
    if (this.disposed || event.type === "reset") {
      return true;
    }
    const frameNodeRefs = [...this.frameDescriptions.entries()]
      .filter(([, description]) => description.frameRef === event.frameRef)
      .map(([nodeRef]) => nodeRef);
    if (event.type !== "registered") {
      if (!this.releaseFrameIdentity(
        event.frameRef,
        event.type !== "navigated",
      )) return false;
    }
    for (const identity of event.invalidated ?? []) {
      if (!this.releaseFrameIdentity(identity.frameRef, true)) return false;
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
      if (!this.invalidateBranches(affected)) return false;
    }
    if (this.mutationProcessingDepth === 0) {
      if (!this.emitPendingSelectedRemoval()) return false;
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
    return this.emitFrameLifecycle(event);
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

function restoreMap<Key, Value>(
  target: Map<Key, Value>,
  entries: readonly (readonly [Key, Value])[],
): void {
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function restoreSet<Value>(target: Set<Value>, values: readonly Value[]): void {
  target.clear();
  for (const value of values) target.add(value);
}

function snapshotExpandedBranches(
  entries: Iterable<readonly [string, ExpandedBranch]>,
): readonly (readonly [string, ExpandedBranch])[] {
  return Object.freeze(Array.from(entries, ([nodeRef, branch]) => (
    [nodeRef, { scope: branch.scope, revision: branch.revision }] as const
  )));
}

function snapshotPendingFrameMutationScans(
  scans: readonly PendingFrameMutationScan[],
): readonly PendingFrameMutationScan[] {
  return Object.freeze(scans.map((scan) => Object.freeze({
    action: scan.action,
    ownerRoot: scan.ownerRoot,
    root: scan.root,
    stack: scan.stack.map((entry) => ({ ...entry })),
  })));
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
