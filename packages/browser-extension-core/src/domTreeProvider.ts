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
import { utf8ByteLength } from "@pin-op/protocol";
import {
  boundDomNodeViewPathForEnvelope,
  domProtocolEnvelopeWithinBudget,
  DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
  DOM_PROTOCOL_MAX_ATTRIBUTES,
  DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
  DOM_PROTOCOL_MAX_ATTRIBUTE_VALUE_LENGTH,
  DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH,
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  DOM_PROTOCOL_MAX_LABEL_LENGTH,
  DOM_PROTOCOL_MAX_NODE_VALUE_LENGTH,
  DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS,
  DOM_PROTOCOL_MAX_ROOT_CHILDREN_SCANNED,
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  parseDomRequest,
  truncateDomProtocolUtf16,
} from "./domProtocol.js";
import type {
  DomChildrenResponse,
  DomErrorCode,
  DomGetChildrenRequest,
  DomInvalidationBranch,
  DomNodeView,
  DomRootResponse,
  InspectorAttribute,
} from "./domProtocol.js";
import {
  DomStableLocatorService,
  isDomStableLocatorAttributeCaptureError,
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
// A reset hook may synchronously request another epoch. Bound the drain so a
// hostile page cannot keep the provider on the stack forever.
const DOCUMENT_RESET_APPLICATION_LIMIT = 16;
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
  | { readonly kind: "document-type"; readonly node: DocumentType }
  | { readonly kind: "element"; readonly node: Element }
  | { readonly kind: "text"; readonly node: Node }
  | { readonly kind: "comment"; readonly node: Node }
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
  readonly childPhysicalOffsets: readonly number[];
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
  readonly resetGuard?: () => boolean;
}

interface PendingMutationRecord {
  readonly observedRoot: Node;
  readonly record: MutationRecord;
}

interface MutationDrainAuthority {
  readonly topDocument: Document | undefined;
  readonly documentEpoch: number;
  readonly authorityGeneration: number;
}

interface DocumentResetRequest {
  readonly topDocument: Document;
  readonly documentEpoch: number;
  readonly requestGeneration: number;
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

interface PublishedRootPresentation {
  readonly nodeRef: string;
  readonly branchRevision: number;
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
  readonly publishedRootPresentation: PublishedRootPresentation | undefined;
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

interface TimerCancellationResult {
  readonly current: boolean;
  readonly cancelled: boolean;
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
  private readonly observedRootByObserver = new Map<DomTreeMutationObserver, Node>();
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
  private rollbackSuppressedFrameEvent: FrameLifecycleEvent | undefined;
  private readonly postCommitEffectBatches: PostCommitEffectBatch[] = [];
  private postCommitDeliveryScheduled = false;
  private mutationTimer: DomTreeTimerHandle | undefined;
  private frameMutationScanTimer: DomTreeTimerHandle | undefined;
  private shadowScanTimer: DomTreeTimerHandle | undefined;
  private shadowScanOffset = 0;
  private mutationProcessingDepth = 0;
  private pendingSelectedRemoval: DomTreeSelectedNodeRemoval | undefined;
  private publishedRootPresentation: PublishedRootPresentation | undefined;
  private deferredFrameDiscovery: MutationDrainAuthority | undefined;
  private deferredFrameDiscoveryScheduled = false;
  private activeDocumentReset: DocumentResetRequest | undefined;
  private pendingDocumentReset: DocumentResetRequest | undefined;
  private documentResetGeneration = 0;
  private drainingDocumentResets = false;
  private activeFrameMutationScanGuard: (() => boolean) | undefined;
  private authorityGeneration = 0;
  private activePublicationGuard: (() => boolean) | undefined;
  private externalValueReadDepth = 0;
  private deferredFrameLifecycleReadCount = 0;
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
      onMutationSettled: () => this.drainDocumentResets(),
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
    kind: DomStableLocator["targetKind"],
  ): DomStableLocator {
    try {
      return this.locatorService.capture(node, kind);
    } catch {
      throwDomTreeError("node-unavailable");
    }
  }

  private captureDisplayLocator(
    node: Node,
    kind: DomStableLocator["targetKind"],
  ): DomStableLocator | undefined {
    try {
      return this.locatorService.capture(node, kind);
    } catch (error) {
      if (isDomStableLocatorAttributeCaptureError(error)) return undefined;
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
      const node = this.viewElement(element, context);
      const auxiliary = this.rootAuxiliaryViews(
        this.topDocument!,
        element,
        context,
        node.nodeRef,
      );
      const response = this.boundRootResponse({
        type: "dom.root" as const,
        requestId: "root",
        documentEpoch: this.documentEpoch,
        node,
        prologue: auxiliary.prologue,
        epilogue: auxiliary.epilogue,
      });
      const validate = () => this.validateLivePathViews(
        [response.node],
        response.documentEpoch,
      ) && this.validatePublishedViews(
        [...response.prologue, ...response.epilogue],
        response.documentEpoch,
      );
      if (!operation.publish(validate) || !operation.finalize(validate, () => {
        const previousRootRef = this.publishedRootPresentation?.nodeRef;
        if (
          previousRootRef &&
          previousRootRef !== response.node.nodeRef &&
          !this.records.has(previousRootRef) &&
          !this.expandedBranches.has(previousRootRef)
        ) {
          this.branchGenerations.delete(previousRootRef);
          this.exhaustedBranches.delete(previousRootRef);
        }
        this.publishedRootPresentation = Object.freeze({
          nodeRef: response.node.nodeRef,
          branchRevision: response.node.branchRevision,
        });
        return true;
      })) {
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
    const locators = page.children.map((child) => (
      isRecoverableKind(child.kind)
        ? this.captureDisplayLocator(child.node, child.kind)
        : undefined
    ));
    const materializedRefs: string[] = [];
    let nodes: readonly DomNodeView[];
    try {
      nodes = Object.freeze(page.children.map((child, index) => {
        const locator = locators[index];
        const view = child.kind === "element"
          ? this.viewElement(child.node, record!.scope, request.nodeRef, locator!)
          : child.kind === "shadow-root"
            ? this.viewShadowRoot(child.node, record!.scope, request.nodeRef, locator!)
            : child.kind === "frame-document"
              ? this.viewFrameDocument(child.node, child.scope, request.nodeRef, locator!)
              : child.kind === "document-type"
                ? this.viewDocumentType(child.node, record!.scope, request.nodeRef)
                : this.viewCharacterData(child.node, child.kind, record!.scope, request.nodeRef);
        this.retainTransientRecord(view.nodeRef);
        materializedRefs.push(view.nodeRef);
        return view;
      }));
    } finally {
      for (const nodeRef of materializedRefs) {
        this.releaseTransientRecord(nodeRef);
      }
    }
    const bounded = this.boundChildrenResponseNodes({
      type: "dom.children",
      requestId: request.requestId,
      documentEpoch: this.documentEpoch,
      nodeRef: request.nodeRef,
      branchRevision: branch.revision,
      nodes,
    }, page.hasMore);
    nodes = bounded.nodes;
    const nextOffset = offset + nodes.length;
    const nextPhysicalOffset = nodes.length < page.children.length
      ? page.childPhysicalOffsets[nodes.length - 1]
      : page.nextPhysicalOffset;
    if (bounded.needsCursor && nextPhysicalOffset === undefined) {
      throwDomTreeError("node-unavailable");
    }
    const nextCursor = bounded.needsCursor
      ? this.createCursor({
          nodeRef: request.nodeRef,
          documentEpoch: request.documentEpoch,
          branchRevision: branch.revision,
          offset: nextOffset,
          physicalOffset: nextPhysicalOffset!,
        })
      : undefined;
    const response = freezeChildrenResponse({
      type: "dom.children",
      requestId: request.requestId,
      documentEpoch: this.documentEpoch,
      nodeRef: request.nodeRef,
      branchRevision: branch.revision,
      nodes,
      ...(nextCursor ? { nextCursor } : {}),
    }, nodes);
    if (!serializedWithinBudget(response)) throwDomTreeError("node-unavailable");
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
        if (!isRecoverableKind(record.kind)) {
          throwDomTreeError("node-unavailable");
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
      const result = boundDomNodeViewPathForEnvelope(
        reversed.reverse(),
        (ancestorPath) => ({
          type: "dom.selectionChanged",
          documentEpoch,
          selectionRevision: Number.MAX_SAFE_INTEGER,
          nodeRef,
          ancestorPath,
        }),
        { requireTargetLocator: true },
      );
      if (!result) throwDomTreeError("node-unavailable");
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
    const materializedPath = this.materializeLogicalPath(path);
    const target = materializedPath?.at(-1);
    const context = this.frameRegistry.getContext(scope.frameRef);
    if (!materializedPath || !target || !context || !sameNodeScope(context, scope)) {
      throwDomTreeError("node-unavailable");
    }
    const ancestorPath = boundDomNodeViewPathForEnvelope(
      materializedPath,
      (boundedPath) => ({
        type: "dom.selectionChanged",
        documentEpoch: context.documentEpoch,
        selectionRevision: Number.MAX_SAFE_INTEGER,
        nodeRef: target.nodeRef,
        ancestorPath: boundedPath,
      }),
      { requireTargetLocator: true },
    );
    if (!ancestorPath) throwDomTreeError("node-unavailable");
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
    if (!record) {
      return undefined;
    }
    if (record.kind !== "element") throwDomTreeError("node-unavailable");
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
    const locator = this.captureLocator(element, "element");
    const locatorResolution = this.resolveLocatorForLiveValidation(locator);
    if (
      locatorResolution?.kind !== "element" ||
      locatorResolution.node !== element
    ) {
      throwDomTreeError("node-unavailable");
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
      const materializedPath = path ? this.materializeLogicalPath(path) : undefined;
      const materializedNode = materializedPath?.at(-1);
      if (
        !materializedPath ||
        !materializedNode ||
        materializedNode.kind !== resolved.kind
      ) return undefined;
      const ancestorPath = boundDomNodeViewPathForEnvelope(
        materializedPath,
        (boundedPath) => ({
          type: "dom.locator",
          requestId: "\u0000".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
          documentEpoch: this.documentEpoch,
          node: boundedPath.at(-1),
          ancestorPath: boundedPath,
        }),
        { requireTargetLocator: true },
      );
      const node = ancestorPath?.at(-1);
      if (!ancestorPath || !node || node.kind !== resolved.kind) return undefined;
      const resolvedPath = path;
      if (!resolvedPath) return undefined;
      const validate = () => this.validateLiveResolvedLocator(
        locator,
        resolved.kind,
        resolved.node,
        resolvedPath,
        materializedPath,
        materializedNode,
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
    const acceptedEpoch = Math.max(
      this.documentEpoch,
      this.activeDocumentReset?.documentEpoch ?? -1,
      this.pendingDocumentReset?.documentEpoch ?? -1,
    );
    if (
      !topDocument ||
      typeof topDocument !== "object" ||
      !Number.isSafeInteger(documentEpoch) ||
      documentEpoch <= acceptedEpoch
    ) {
      throw new RangeError("documentEpoch must be greater than the current epoch");
    }
    const request = Object.freeze({
      topDocument,
      documentEpoch,
      requestGeneration: ++this.documentResetGeneration,
    });
    this.authorityGeneration += 1;
    this.pendingDocumentReset = request;
    this.drainDocumentResets();
  }

  private drainDocumentResets(): void {
    if (
      this.drainingDocumentResets ||
      this.frameRegistry.mutationInProgress
    ) return;
    if (this.disposed) {
      this.pendingDocumentReset = undefined;
      return;
    }

    this.drainingDocumentResets = true;
    let appliedResets = 0;
    let applicationLimitExceeded = false;
    try {
      while (!this.disposed && this.pendingDocumentReset) {
        if (appliedResets >= DOCUMENT_RESET_APPLICATION_LIMIT) {
          this.pendingDocumentReset = undefined;
          applicationLimitExceeded = true;
          break;
        }
        appliedResets += 1;
        const next = this.pendingDocumentReset;
        this.pendingDocumentReset = undefined;
        this.activeDocumentReset = next;
        try {
          this.applyDocumentReset(next);
        } catch (error) {
          if (this.isDocumentResetCurrent(next)) throw error;
        } finally {
          if (this.activeDocumentReset === next) {
            this.activeDocumentReset = undefined;
          }
        }
      }
      if (applicationLimitExceeded) {
        this.activeDocumentReset = undefined;
        this.dispose();
        throwDomTreeError("node-unavailable");
      }
    } finally {
      this.activeDocumentReset = undefined;
      if (this.disposed) this.pendingDocumentReset = undefined;
      this.drainingDocumentResets = false;
    }
  }

  private applyDocumentReset(request: DocumentResetRequest): void {
    const isCurrent = () => this.isDocumentResetCurrent(request);
    if (!isCurrent()) return;
    const deferFrameDiscovery = this.frameTracking &&
      this.outwardEffectBuffer !== undefined;
    this.deferredFrameDiscovery = undefined;
    this.postCommitEffectBatches.length = 0;
    let frameReset = false;
    try {
      frameReset = this.frameRegistry.resetTopDocument(
        request.topDocument,
        request.documentEpoch,
      );
    } finally {
      // dispose() can reenter while FrameRegistry is detaching a listener. Its
      // first registry disposal is then intentionally inert; retry once the
      // registry reset has restored an active state.
      if (this.disposed) this.frameRegistry.dispose();
    }
    if (!frameReset) {
      if (!isCurrent()) return;
      throwDomTreeError("node-unavailable");
    }
    if (!isCurrent()) return;
    const locatorService = this.createLocatorService(request.topDocument);
    if (!isCurrent()) return;
    this.locatorService = locatorService;
    this.nodeRegistry.resetDocument(request.documentEpoch);
    if (!isCurrent()) return;
    this.cancelScheduledWork();
    if (!isCurrent()) return;
    this.disconnectAllObservers(isCurrent);
    if (!isCurrent()) return;
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
    this.publishedRootPresentation = undefined;
    this.shadowScanOffset = 0;
    this.topDocument = request.topDocument;
    this.documentEpoch = request.documentEpoch;
    this.observeRoot(request.topDocument, isCurrent);
    if (!isCurrent()) return;
    if (this.frameTracking) {
      if (deferFrameDiscovery) {
        this.deferFrameDiscovery({
          topDocument: request.topDocument,
          documentEpoch: request.documentEpoch,
          authorityGeneration: this.authorityGeneration,
        });
      } else {
        const scanGuard = () => this.isDocumentResetScanCurrent(request);
        this.queueFrameDiscovery(request.topDocument, scanGuard);
        if (!isCurrent()) return;
        this.processFrameMutationScanSlice();
      }
    }
  }

  private isDocumentResetCurrent(request: DocumentResetRequest): boolean {
    return !this.disposed &&
      this.activeDocumentReset === request &&
      this.pendingDocumentReset === undefined &&
      this.documentResetGeneration === request.requestGeneration;
  }

  private isDocumentResetScanCurrent(request: DocumentResetRequest): boolean {
    return !this.disposed &&
      this.topDocument === request.topDocument &&
      this.documentEpoch === request.documentEpoch &&
      this.documentResetGeneration === request.requestGeneration;
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
    this.documentResetGeneration += 1;
    this.activeDocumentReset = undefined;
    this.pendingDocumentReset = undefined;
    this.activeFrameMutationScanGuard = undefined;
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
    this.publishedRootPresentation = undefined;
    this.deferredFrameDiscovery = undefined;
    this.frameTracking = false;
  }

  private viewElement(
    element: Element,
    scope: NodeScope,
    parentRef?: string,
    locator = this.captureDisplayLocator(element, "element"),
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
        hasLogicalChild(element)
      )
    );
    const label = createElementLabel(element);
    const inaccessible = frameElement && frame?.kind !== "accessible";
    const childCount = frameElement
      ? frame?.kind === "accessible" ? 1 : 0
      : safeChildCount(element, getOpenShadowRoot(element) ? 1 : 0);
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
      nodeType: 1,
      nodeName: readNodeName(element, "ELEMENT"),
      attributes: readInspectorAttributes(element),
      childCount,
      relationship: "dom",
      selectable: !inaccessible,
      label,
      expandable,
      ...(inaccessible ? { inaccessible: true } : {}),
      branchRevision: this.branchRevisionFor(nodeRef),
      ...(locator ? { locator } : {}),
    });
  }

  private viewShadowRoot(
    shadowRoot: ShadowRoot,
    scope: NodeScope,
    parentRef?: string,
    locator = this.captureDisplayLocator(shadowRoot, "shadow-root"),
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
      nodeType: 11,
      nodeName: readNodeName(shadowRoot, "#document-fragment"),
      attributes: Object.freeze([]),
      childCount: safeChildCount(shadowRoot),
      relationship: "shadow-root",
      selectable: false,
      label: "#shadow-root (open)",
      expandable: true,
      branchRevision: this.branchRevisionFor(nodeRef),
      ...(locator ? { locator } : {}),
    });
  }

  private viewFrameDocument(
    document: Document,
    scope: FrameContext,
    parentRef?: string,
    locator = this.captureDisplayLocator(document, "frame-document"),
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
      nodeType: 9,
      nodeName: readNodeName(document, "#document"),
      attributes: Object.freeze([]),
      childCount: safeChildCount(document),
      relationship: "frame-document",
      selectable: false,
      label: "#document",
      expandable: true,
      branchRevision: this.branchRevisionFor(nodeRef),
      ...(locator ? { locator } : {}),
    });
  }

  private viewCharacterData(
    node: Node,
    kind: "text" | "comment",
    scope: NodeScope,
    parentRef?: string,
  ): DomNodeView {
    const nodeRef = this.referenceNode(node, scope);
    const existing = this.records.get(nodeRef);
    this.storeReferencedRecord(nodeRef, {
      scope,
      kind,
      ...(parentRef ?? existing?.parentRef
        ? { parentRef: parentRef ?? existing?.parentRef }
        : {}),
    });
    const nodeValue = readNodeValue(node);
    const label = characterDataLabel(kind, nodeValue);
    return Object.freeze({
      nodeRef,
      kind,
      nodeType: kind === "text" ? 3 : 8,
      nodeName: readNodeName(node, kind === "text" ? "#text" : "#comment"),
      ...(nodeValue === undefined ? {} : { nodeValue }),
      attributes: Object.freeze([]),
      childCount: 0,
      relationship: "dom",
      selectable: false,
      label,
      expandable: false,
      branchRevision: this.branchRevisionFor(nodeRef),
    });
  }

  private viewDocumentType(
    node: DocumentType,
    scope: NodeScope,
    parentRef?: string,
  ): DomNodeView {
    const nodeRef = this.referenceNode(node, scope);
    const existing = this.records.get(nodeRef);
    this.storeReferencedRecord(nodeRef, {
      scope,
      kind: "document-type",
      ...(parentRef ?? existing?.parentRef
        ? { parentRef: parentRef ?? existing?.parentRef }
        : {}),
    });
    const name = readDocumentTypeName(node);
    const publicId = readDocumentTypeId(node, "publicId");
    const systemId = readDocumentTypeId(node, "systemId");
    return Object.freeze({
      nodeRef,
      kind: "document-type",
      nodeType: 10,
      nodeName: name,
      ...(publicId === undefined ? {} : { publicId }),
      ...(systemId === undefined ? {} : { systemId }),
      attributes: Object.freeze([]),
      childCount: 0,
      relationship: "dom",
      selectable: false,
      label: documentTypeLabel(name, publicId, systemId),
      expandable: false,
      branchRevision: this.branchRevisionFor(nodeRef),
    });
  }

  private rootAuxiliaryViews(
    document: Document,
    documentElement: Element,
    scope: NodeScope,
    rootRef: string,
  ): {
    readonly prologue: readonly DomNodeView[];
    readonly epilogue: readonly DomNodeView[];
  } {
    const prologue: DomNodeView[] = [];
    const epilogue: DomNodeView[] = [];
    const childNodes = readChildNodes(document);
    if (!childNodes) {
      return Object.freeze({
        prologue: Object.freeze(prologue),
        epilogue: Object.freeze(epilogue),
      });
    }
    const scanCount = boundedArrayLikeLength(
      childNodes,
      DOM_PROTOCOL_MAX_ROOT_CHILDREN_SCANNED,
    );
    let afterDocumentElement = false;
    for (
      let index = 0;
      index < scanCount && prologue.length + epilogue.length < DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS;
      index += 1
    ) {
      const child = safeArrayLikeItem(childNodes, index);
      if (!child || this.isNodeExcluded(child)) continue;
      if (child === documentElement) {
        afterDocumentElement = true;
        continue;
      }
      const nodeType = readNodeType(child);
      if (!afterDocumentElement && nodeType === 10) {
        prologue.push(this.viewDocumentType(
          child as DocumentType,
          scope,
          rootRef,
        ));
      } else if (nodeType === 8) {
        const view = this.viewCharacterData(child, "comment", scope, rootRef);
        (afterDocumentElement ? epilogue : prologue).push(view);
      }
    }
    return Object.freeze({
      prologue: Object.freeze(prologue),
      epilogue: Object.freeze(epilogue),
    });
  }

  private boundRootResponse(response: DomRootResponse): DomRootResponse {
    let node = sizeDomNodeView(response.node);
    let prologue = response.prologue.map(sizeDomNodeView);
    let epilogue = response.epilogue.map(sizeDomNodeView);
    const limit = DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES -
      DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH * 6 - 64;
    let serializedBytes = serializedRootResponseByteLength(
      response,
      node.serializedBytes,
      prologue.map(({ serializedBytes }) => serializedBytes),
      epilogue.map(({ serializedBytes }) => serializedBytes),
    );
    if (serializedBytes > limit) {
      const all = [node, ...prologue, ...epilogue];
      for (
        let index = all.length - 1;
        index >= 0 && serializedBytes > limit;
        index -= 1
      ) {
        const before = all[index]!;
        const reduced = reduceSizedOptionalNodeSnapshot(
          before,
          serializedBytes - limit,
        );
        all[index] = reduced;
        serializedBytes -= before.serializedBytes - reduced.serializedBytes;
      }
      node = all[0]!;
      prologue = all.slice(1, response.prologue.length + 1);
      epilogue = all.slice(response.prologue.length + 1);
    }
    while (serializedBytes > limit) {
      if (epilogue.length > 0) {
        const removed = epilogue.pop()!;
        serializedBytes -= removed.serializedBytes + (epilogue.length > 0 ? 1 : 0);
      } else if (prologue.length > 0) {
        const removed = prologue.pop()!;
        serializedBytes -= removed.serializedBytes + (prologue.length > 0 ? 1 : 0);
      } else {
        throwDomTreeError("node-unavailable");
      }
    }
    const candidate = freezeRootResponse(
      response,
      node.view,
      prologue.map(({ view }) => view),
      epilogue.map(({ view }) => view),
    );
    if (!serializedWithinBudget(candidate, limit)) throwDomTreeError("node-unavailable");
    return candidate;
  }

  private boundChildrenResponseNodes(
    response: DomChildrenResponse,
    hasMore: boolean,
  ): {
    readonly nodes: readonly DomNodeView[];
    readonly needsCursor: boolean;
  } {
    const nodes = response.nodes.map(sizeDomNodeView);
    let needsCursor = hasMore;
    let sizingCursor = needsCursor
      ? "cursor-9007199254740991"
      : response.nextCursor;
    let serializedBytes = serializedChildrenResponseByteLength(
      response,
      nodes.map(({ serializedBytes }) => serializedBytes),
      sizingCursor,
    );
    if (serializedBytes > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES) {
      for (
        let index = nodes.length - 1;
        index >= 0 && serializedBytes > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES;
        index -= 1
      ) {
        const before = nodes[index]!;
        const reduced = reduceSizedOptionalNodeSnapshot(
          before,
          serializedBytes - DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
        );
        nodes[index] = reduced;
        serializedBytes -= before.serializedBytes - reduced.serializedBytes;
      }
    }
    if (serializedBytes > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES && !needsCursor) {
      needsCursor = true;
      sizingCursor = "cursor-9007199254740991";
      serializedBytes = serializedChildrenResponseByteLength(
        response,
        nodes.map(({ serializedBytes }) => serializedBytes),
        sizingCursor,
      );
    }
    while (
      serializedBytes > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES &&
      nodes.length > 1
    ) {
      const removed = nodes.pop()!;
      serializedBytes -= removed.serializedBytes + (nodes.length > 0 ? 1 : 0);
    }
    if (serializedBytes > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES) {
      throwDomTreeError("node-unavailable");
    }
    return Object.freeze({
      nodes: Object.freeze(nodes.map(({ view }) => view)),
      needsCursor,
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
    const childPhysicalOffsets: number[] = [];
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
        childPhysicalOffsets.push(1);
      }
      return freezeLogicalChildPage(children, childPhysicalOffsets, false, 1);
    }
    let syntheticChildCount = 0;
    if (node.nodeType === 1) {
      const shadowRoot = getOpenShadowRoot(node as Element);
      if (shadowRoot && !this.isNodeExcluded(shadowRoot)) {
        syntheticChildCount = 1;
        if (physicalOffset === 0) {
          children.push({ kind: "shadow-root", node: shadowRoot });
          childPhysicalOffsets.push(1);
          physicalOffset = 1;
        }
      }
    }
    const childNodes = readChildNodes(node);
    if (!childNodes) {
      return freezeLogicalChildPage(
        children,
        childPhysicalOffsets,
        false,
        physicalOffset,
      );
    }
    let childIndex = Math.max(0, physicalOffset - syntheticChildCount);
    let visitedNodes = 0;
    while (
      childIndex < childNodes.length &&
      visitedNodes < CHILD_PAGE_PHYSICAL_SCAN_LIMIT &&
      children.length < CHILD_PAGE_SIZE
    ) {
      const child = safeArrayLikeItem(childNodes, childIndex);
      childIndex += 1;
      visitedNodes += 1;
      if (!child || this.isNodeExcluded(child)) continue;
      const childType = readNodeType(child);
      if (childType === 1) {
        children.push({ kind: "element", node: child as Element });
      } else if (childType === 3) {
        children.push({ kind: "text", node: child });
      } else if (childType === 8) {
        children.push({ kind: "comment", node: child });
      } else if (childType === 10) {
        children.push({ kind: "document-type", node: child as DocumentType });
      }
      if (children.length > childPhysicalOffsets.length) {
        childPhysicalOffsets.push(syntheticChildCount + childIndex);
      }
    }
    const nextPhysicalOffset = syntheticChildCount + childIndex;
    return freezeLogicalChildPage(
      children,
      childPhysicalOffsets,
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
    const authority: MutationDrainAuthority = {
      topDocument: this.topDocument,
      documentEpoch: this.documentEpoch,
      authorityGeneration: this.authorityGeneration,
    };
    const parentPublicationGuard = this.activePublicationGuard;
    const mutationPublicationGuard = () => (
      this.isMutationDrainAuthorityCurrent(authority) &&
      (parentPublicationGuard?.() ?? true)
    );
    const parentEffectBuffer = this.outwardEffectBuffer;
    const effectBuffer = parentEffectBuffer ?? [];
    const ownsEffectBuffer = parentEffectBuffer === undefined;
    const effectSavepoint = effectBuffer.length;
    if (ownsEffectBuffer) {
      this.outwardEffectBuffer = effectBuffer;
    }
    this.activePublicationGuard = mutationPublicationGuard;
    let completed = false;
    let committedEffects: readonly ProviderOutwardEffect[] = [];
    this.mutationProcessingDepth += 1;
    try {
      completed = this.processPendingMutationRecords(authority);
    } finally {
      this.mutationProcessingDepth -= 1;
      if (
        this.mutationProcessingDepth === 0 &&
        completed &&
        mutationPublicationGuard()
      ) {
        const selectedRemovalEmitted = this.emitPendingSelectedRemoval();
        if (selectedRemovalEmitted && mutationPublicationGuard()) {
          this.emitMutationSettled();
        }
      }
      if (!completed || !mutationPublicationGuard()) {
        effectBuffer.length = effectSavepoint;
      } else if (ownsEffectBuffer) {
        committedEffects = Object.freeze(effectBuffer.slice(effectSavepoint));
      }
      if (ownsEffectBuffer && this.outwardEffectBuffer === effectBuffer) {
        this.outwardEffectBuffer = undefined;
      }
      if (this.activePublicationGuard === mutationPublicationGuard) {
        this.activePublicationGuard = parentPublicationGuard;
      }
    }
    if (ownsEffectBuffer) {
      for (const effect of committedEffects) {
        if (!this.isMutationDrainAuthorityCurrent(authority)) break;
        if (!this.emitCommittedOutwardEffect(effect)) break;
      }
    }
  }

  private processPendingMutationRecords(
    authority: MutationDrainAuthority,
  ): boolean {
    const isCurrent = () => this.isMutationDrainAuthorityCurrent(authority);
    const records = this.pendingMutations.splice(0);
    const affected = new Set<string>();
    const forcedAffected = new Set<string>();
    const addedRoots: PendingElementMutationRoot[] = [];
    const removedRoots: PendingElementMutationRoot[] = [];
    for (const pending of records) {
      if (!isCurrent()) return false;
      if (!this.rootObservers.has(pending.observedRoot)) {
        continue;
      }
      const mutation = pending.record;
      if (this.isNodeExcluded(mutation.target)) {
        if (!isCurrent()) return false;
        continue;
      }
      if (!isCurrent()) return false;
      if (mutation.type === "characterData") {
        const targetRef = this.refsByNode.get(mutation.target);
        const targetRecord = targetRef ? this.records.get(targetRef) : undefined;
        const parent = readShadowIncludingParent(mutation.target);
        if (!isCurrent()) return false;
        const parentRef = targetRecord?.parentRef ?? (
          parent ? this.refsByNode.get(parent) : undefined
        );
        const targetType = readNodeType(mutation.target);
        if (!isCurrent()) return false;
        if (
          parentRef &&
          parent === this.topDocument &&
          (targetType === 8 || targetType === 10)
        ) {
          forcedAffected.add(parentRef);
        } else if (parentRef && this.expandedBranches.has(parentRef)) {
          affected.add(parentRef);
        }
        continue;
      }
      if (mutation.type === "attributes") {
        if (mutation.target.nodeType !== 1) {
          if (!isCurrent()) return false;
          continue;
        }
        if (!isCurrent()) return false;
        const targetRef = this.refsByNode.get(mutation.target);
        const targetRecord = targetRef
          ? this.records.get(targetRef)
          : undefined;
        if (!targetRef || targetRecord?.kind !== "element") {
          continue;
        }
        const presentationOwnerRef = targetRecord.parentRef;
        if (
          presentationOwnerRef &&
          this.expandedBranches.has(presentationOwnerRef)
        ) {
          affected.add(presentationOwnerRef);
        } else if (!presentationOwnerRef) {
          forcedAffected.add(targetRef);
        }
        continue;
      }
      if (mutation.type !== "childList") {
        continue;
      }
      const targetRef = this.mutationTargetRef(mutation.target);
      if (!isCurrent()) return false;
      const targetRecord = targetRef
        ? this.records.get(targetRef)
        : undefined;
      const targetScope = targetRecord?.scope ??
        this.scopeForMutationTarget(mutation.target);
      if (!isCurrent()) return false;
      let logicalTreeChanged = false;
      let rootAuxiliaryChanged = false;
      const removedNodes = mutation.removedNodes;
      for (let index = 0; index < removedNodes.length; index += 1) {
        if (!isCurrent()) return false;
        const removed = removedNodes[index];
        const removedType = removed ? readNodeType(removed) : undefined;
        if (!isCurrent()) return false;
        if (removedType === 1) {
          removedRoots.push({
            node: removed,
            ownerRoot: pending.observedRoot,
            ...(targetRef ? { parentRef: targetRef } : {}),
            ...(targetScope ? { scope: targetScope } : {}),
          });
          logicalTreeChanged ||= !this.isNodeExcluded(removed);
        } else if (
          removed &&
          (removedType === 3 || removedType === 8 || removedType === 10) &&
          !this.isNodeExcluded(removed)
        ) {
          if (!isCurrent()) return false;
          logicalTreeChanged = true;
          rootAuxiliaryChanged ||= mutation.target === this.topDocument &&
            (removedType === 8 || removedType === 10);
          const invalidated = this.nodeRegistry.invalidateSubtree(removed);
          if (!isCurrent() || !this.releaseInvalidatedRefs(invalidated)) {
            return false;
          }
        }
      }
      const addedNodes = mutation.addedNodes;
      for (let index = 0; index < addedNodes.length; index += 1) {
        if (!isCurrent()) return false;
        const added = addedNodes[index];
        const addedType = added ? readNodeType(added) : undefined;
        if (!isCurrent()) return false;
        if (addedType === 1 && added && !this.isNodeExcluded(added)) {
          if (!isCurrent()) return false;
          addedRoots.push({
            node: added,
            ownerRoot: pending.observedRoot,
            ...(targetRef ? { parentRef: targetRef } : {}),
            ...(targetScope ? { scope: targetScope } : {}),
          });
          logicalTreeChanged = true;
        } else if (
          added &&
          (addedType === 3 || addedType === 8 || addedType === 10) &&
          !this.isNodeExcluded(added)
        ) {
          if (!isCurrent()) return false;
          logicalTreeChanged = true;
          rootAuxiliaryChanged ||= mutation.target === this.topDocument &&
            (addedType === 8 || addedType === 10);
        }
      }
      if (!logicalTreeChanged) {
        continue;
      }
      const parentRef = targetRef
        ? targetRecord?.parentRef
        : undefined;
      if (targetRef && this.expandedBranches.has(targetRef)) {
        affected.add(targetRef);
      } else if (
        targetRef &&
        (!parentRef || this.expandedBranches.has(parentRef))
      ) {
        forcedAffected.add(targetRef);
      }
      if (targetRef && rootAuxiliaryChanged) {
        forcedAffected.add(targetRef);
      }
      if (parentRef && this.expandedBranches.has(parentRef)) {
        affected.add(parentRef);
      }
    }
    const movedRoots = new Set<Node>();
    for (const removed of removedRoots) {
      if (!isCurrent()) return false;
      const movedRef = this.refsByNode.get(removed.node);
      const movedRecord = movedRef
        ? this.records.get(movedRef)
        : undefined;
      const finalScope = this.attachedScopeFor(removed.node);
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
      if (!finalParentRef) {
        continue;
      }
      movedRoots.add(removed.node);
      if (this.expandedBranches.has(finalParentRef)) {
        affected.add(finalParentRef);
      }
    }
    for (const root of removedRoots) {
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
    }
    for (const root of removedRoots) {
      if (!isCurrent()) return false;
      if (movedRoots.has(root.node)) {
        continue;
      }
      this.disconnectObserversWithin(root.node);
      if (!isCurrent()) return false;
      const invalidated = this.nodeRegistry.invalidateSubtree(root.node);
      if (!isCurrent() || !this.releaseInvalidatedRefs(invalidated)) {
        return false;
      }
    }
    return isCurrent() &&
      this.invalidateBranches(affected, forcedAffected) &&
      isCurrent();
  }

  private isMutationDrainAuthorityCurrent(
    authority: MutationDrainAuthority,
  ): boolean {
    return !this.disposed &&
      this.topDocument === authority.topDocument &&
      this.documentEpoch === authority.documentEpoch &&
      this.authorityGeneration === authority.authorityGeneration;
  }

  private mutationTargetRef(target: Node): string | undefined {
    const direct = this.refsByNode.get(target);
    if (target !== this.topDocument) return direct;
    const publishedRootRef = this.publishedRootPresentation?.nodeRef;
    if (publishedRootRef) return publishedRootRef;
    try {
      const topDocument = this.topDocument;
      const documentElement = topDocument?.documentElement;
      if (!topDocument || !documentElement) return undefined;
      const nodeRef = this.refsByNode.get(documentElement);
      const record = nodeRef ? this.records.get(nodeRef) : undefined;
      const context = this.frameRegistry.topContext;
      if (
        !nodeRef ||
        !record ||
        record.kind !== "element" ||
        !context ||
        !sameNodeScope(record.scope, context) ||
        this.nodeRegistry.resolve(nodeRef, record.scope) !== documentElement
      ) {
        if (nodeRef) this.evictRecordMetadata(nodeRef);
        return undefined;
      }
      return nodeRef;
    } catch {
      return undefined;
    }
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
      const cancellation = this.cancelTimerSlot("mutationTimer");
      if (!cancellation.current) return;
    }
    if (this.pendingMutations.length > 0) {
      this.processMutations();
    }
  }

  private invalidateBranch(nodeRef: string): void {
    this.invalidateBranches([nodeRef]);
  }

  private invalidateBranches(
    nodeRefs: Iterable<string>,
    forcedNodeRefs: Iterable<string> = [],
  ): boolean {
    const branches: Array<{
      readonly nodeRef: string;
      readonly branch?: ExpandedBranch;
      readonly revision: number;
    }> = [];
    const seen = new Set<string>();
    const append = (nodeRef: string, forced: boolean): void => {
      if (seen.has(nodeRef)) {
        return;
      }
      const branch = this.expandedBranches.get(nodeRef);
      if (!branch && !forced) return;
      seen.add(nodeRef);
      branches.push({
        nodeRef,
        ...(branch ? { branch } : {}),
        revision: branch?.revision ??
          this.branchGenerations.get(nodeRef) ??
          (this.publishedRootPresentation?.nodeRef === nodeRef
            ? this.publishedRootPresentation.branchRevision
            : 1),
      });
    };
    for (const nodeRef of nodeRefs) {
      append(nodeRef, false);
    }
    for (const nodeRef of forcedNodeRefs) {
      append(nodeRef, true);
    }
    if (branches.some(({ revision }) => revision >= Number.MAX_SAFE_INTEGER)) {
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
    for (const entry of branches) {
      const revision = entry.revision + 1;
      if (entry.branch) entry.branch.revision = revision;
      this.branchGenerations.set(entry.nodeRef, revision);
      if (this.publishedRootPresentation?.nodeRef === entry.nodeRef) {
        this.publishedRootPresentation = Object.freeze({
          nodeRef: entry.nodeRef,
          branchRevision: revision,
        });
      }
    }
    const invalidatedRefs = new Set(branches.map(({ nodeRef }) => nodeRef));
    for (const [cursor, record] of this.cursors) {
      if (invalidatedRefs.has(record.nodeRef) && record.active) {
        this.cursors.set(cursor, Object.freeze({ ...record, active: false }));
      }
    }
    for (const { nodeRef } of branches) {
      const revision = this.branchGenerations.get(nodeRef);
      if (revision === undefined) throwDomTreeError("internal-error");
      if (!this.emitInvalidated(Object.freeze({
        nodeRef,
        branchRevision: revision,
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
      ?? (this.publishedRootPresentation?.nodeRef === nodeRef
        ? this.publishedRootPresentation.branchRevision
        : undefined)
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
    const deferredFrameLifecycleReadCount = this.deferredFrameLifecycleReadCount;
    const parentPublicationGuard = this.activePublicationGuard;
    const publicationGuard = () => (
      this.isProviderAuthorityCurrent(snapshot) &&
      this.deferredFrameLifecycleReadCount === deferredFrameLifecycleReadCount &&
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
        if (!this.isProviderAuthorityCurrent(snapshot) || !publicationGuard()) return false;
        published = true;
        return true;
      },
      finalize: (validate = () => true, beforeEnqueue) => {
        if (closed || !published) return false;
        if (!this.isProviderAuthorityCurrent(snapshot) || !publicationGuard() || !validate()) {
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

      if (!this.restoreProviderAuthority(snapshot)) {
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
        const previousSuppressedEvent = this.rollbackSuppressedFrameEvent;
        this.rollbackSuppressedFrameEvent = event;
        try {
          if (!this.handleFrameLifecycle(event)) return false;
        } finally {
          this.rollbackSuppressedFrameEvent = previousSuppressedEvent;
        }
      }
      return this.isProviderAuthorityCurrent(snapshot);
    } finally {
      this.rollbackEffectSuppressionDepth -= 1;
    }
  }

  private hasConvergedFrameAuthority(): boolean {
    try {
      const requiredObservedRoots = this.requiredObservedRoots();
      if (!requiredObservedRoots || requiredObservedRoots.size !== this.rootObservers.size) {
        return false;
      }
      for (const root of requiredObservedRoots) {
        const observer = this.rootObservers.get(root);
        if (!observer || this.observedRootByObserver.get(observer) !== root) {
          return false;
        }
      }
      for (const [root, observer] of this.rootObservers) {
        if (
          !requiredObservedRoots.has(root) ||
          this.observedRootByObserver.get(observer) !== root
        ) return false;
      }
      if (this.observedRootByObserver.size !== this.rootObservers.size) return false;
      for (const [observer, root] of this.observedRootByObserver) {
        if (
          !requiredObservedRoots.has(root) ||
          this.rootObservers.get(root) !== observer
        ) return false;
      }
      for (const [frameRef, document] of this.frameDocumentsByRef) {
        const context = this.frameRegistry.getContext(frameRef);
        const owned = this.ownedFramesByRef.get(frameRef);
        if (
          !context ||
          context.document !== document ||
          !owned ||
          context.frameElement !== owned.frameElement ||
          context.parentFrameRef !== owned.parentFrameRef ||
          this.frameRefsByElement.get(owned.frameElement) !== frameRef
        ) {
          return false;
        }
      }
      for (const description of this.frameDescriptions.values()) {
        const context = this.frameRegistry.getContext(description.frameRef);
        const owned = this.ownedFramesByRef.get(description.frameRef);
        if (
          !owned ||
          this.frameRefsByElement.get(owned.frameElement) !== description.frameRef
        ) return false;
        if (description.kind === "accessible") {
          if (
            !context ||
            context.frameElement !== owned.frameElement ||
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
          context.parentFrameRef !== owned.parentFrameRef ||
          this.frameRefsByElement.get(owned.frameElement) !== frameRef
        ) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private requiredObservedRoots(): ReadonlySet<Node> | undefined {
    const topDocument = this.topDocument;
    if (!topDocument) return undefined;
    const roots = new Set<Node>([topDocument]);
    for (const document of this.frameDocumentsByRef.values()) {
      roots.add(document);
    }
    for (const [hostRef, shadowRootRef] of this.shadowRootRefs) {
      const hostRecord = this.records.get(hostRef);
      const shadowRecord = this.records.get(shadowRootRef);
      if (!hostRecord || !shadowRecord || shadowRecord.kind !== "shadow-root") {
        return undefined;
      }
      const host = this.nodeRegistry.resolve(hostRef, hostRecord.scope);
      const shadowRoot = this.nodeRegistry.resolve(shadowRootRef, shadowRecord.scope);
      if (!host || !shadowRoot || !isExactOpenShadowRoot(host, shadowRoot)) {
        return undefined;
      }
      roots.add(shadowRoot);
    }
    return roots;
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
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      if (!this.restoreSnapshotTimers(snapshot)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      if (!this.nodeRegistry.restore(snapshot.nodeRegistry)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;

      this.refsByNode = new WeakMap<Node, string>();
      for (const [node, ref] of snapshot.refsByNode) this.refsByNode.set(node, ref);
      this.restoreMaterializationMetadata(snapshot.metadata);
      if (!this.restoreRootObservers(snapshot, expectedObservers)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
      this.frameRefsByElement = new WeakMap<HTMLIFrameElement, string>();
      for (const [frameRef, owned] of snapshot.metadata.ownedFramesByRef) {
        this.frameRefsByElement.set(owned.frameElement, frameRef);
      }
      return true;
    } catch {
      return false;
    }
  }

  private restoreRootObservers(
    snapshot: ProviderAuthoritySnapshot,
    expectedObservers: ReadonlyMap<Node, DomTreeMutationObserver>,
  ): boolean {
    if (!this.isProviderAuthorityCurrent(snapshot)) return false;
    const instances = new Set<DomTreeMutationObserver>([
      ...this.observedRootByObserver.keys(),
      ...this.rootObservers.values(),
    ]);
    for (const observer of instances) {
      const root = this.observedRootByObserver.get(observer) ?? findObservedRoot(
        this.rootObservers,
        observer,
      );
      if (!root) return false;
      if (expectedObservers.get(root) === observer) continue;
      if (!this.disconnectObserverInstance(root, observer)) return false;
      if (!this.isProviderAuthorityCurrent(snapshot)) return false;
    }
    for (const [root, observer] of this.rootObservers) {
      if (expectedObservers.get(root) !== observer) return false;
    }
    for (const [observer, root] of this.observedRootByObserver) {
      if (expectedObservers.get(root) !== observer) return false;
    }
    for (const [root, observer] of expectedObservers) {
      const existingRoot = this.observedRootByObserver.get(observer);
      if (existingRoot !== undefined && existingRoot !== root) return false;
      const existingObserver = this.rootObservers.get(root);
      if (existingObserver !== undefined && existingObserver !== observer) return false;
      this.rootObservers.set(root, observer);
      this.observedRootByObserver.set(observer, root);
    }
    return this.isProviderAuthorityCurrent(snapshot);
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
    let cancelled = true;
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
      const cancellation = this.cancelTimerSlot(timer, handle);
      timers[timer] = this[timer];
      if (!cancellation.current || !this.areRollbackTimersCurrent(snapshot, timers)) {
        return false;
      }
      if (!cancellation.cancelled) {
        cancelled = false;
      }
    }
    return cancelled && this.areRollbackTimersCurrent(snapshot, timers);
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
      publishedRootPresentation: this.publishedRootPresentation,
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
    this.publishedRootPresentation = snapshot.publishedRootPresentation;
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
      if (!finalRecord || !finalNode || !isRecoverableKind(finalRecord.kind)) {
        return false;
      }
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
      if (!isRecoverableKind(parentRecord.kind)) return false;
      const liveParentPath = this.logicalPathForResolvedLocator(parentRecord.kind, parent);
      if (!liveParentPath || !this.validateMaterializedPath(liveParentPath, parentRef)) {
        return false;
      }
      const current = this.logicalChildPage(parent, parentRef, scope, physicalOffset);
      if (
        current.hasMore !== expected.hasMore ||
        current.nextPhysicalOffset !== expected.nextPhysicalOffset ||
        current.children.length !== expected.children.length ||
        current.childPhysicalOffsets.length !== expected.childPhysicalOffsets.length ||
        views.length > current.children.length ||
        !current.childPhysicalOffsets.every((value, index) => (
          value === expected.childPhysicalOffsets[index]
        ))
      ) {
        return false;
      }
      const expectedNextPhysicalOffset = views.length < current.children.length
        ? current.childPhysicalOffsets[views.length - 1]
        : current.nextPhysicalOffset;
      const liveNextCursor = nextCursor === undefined
        ? undefined
        : this.cursors.get(nextCursor);
      if (nextCursor !== undefined && (
        liveNextCursor?.offset !== (expectedCursor?.offset ?? 0) + views.length ||
        liveNextCursor.physicalOffset !== expectedNextPhysicalOffset
      )) {
        return false;
      }
      return views.every((view, index) => {
        const child = current.children[index]!;
        const expectedChild = expected.children[index]!;
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
    if (!view.locator) {
      return !!record && !!node && record.kind === view.kind;
    }
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

  private observeRoot(
    root: Node,
    isCurrent: () => boolean = () => true,
  ): void {
    if (!isCurrent()) return;
    const excluded = this.isNodeExcluded(root);
    if (!isCurrent() || excluded || this.rootObservers.has(root)) {
      return;
    }
    let observer: DomTreeMutationObserver | undefined;
    const observerTopDocument = this.topDocument;
    const observerDocumentEpoch = this.documentEpoch;
    try {
      observer = this.createMutationObserver((records) => (
        observer &&
        this.isCurrentObserver(
          root,
          observer,
          observerTopDocument,
          observerDocumentEpoch,
        )
          ? this.queueMutations(root, records)
          : undefined
      ));
      if (!isCurrent()) {
        this.disconnectObserverInstance(root, observer);
        return;
      }
      this.observedRootByObserver.set(observer, root);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      if (!isCurrent()) {
        if (
          this.observedRootByObserver.get(observer) === root ||
          this.rootObservers.get(root) === observer
        ) {
          this.disconnectObserverInstance(root, observer);
        }
        return;
      }
      if (this.observedRootByObserver.get(observer) !== root) return;
      if (this.rootObservers.has(root)) {
        this.disconnectObserverInstance(root, observer);
        return;
      }
      this.rootObservers.set(root, observer);
    } catch {
      if (observer) this.disconnectObserverInstance(root, observer);
      // A hostile root cannot be allowed to break the rest of the tree.
    }
  }

  private isCurrentObserver(
    root: Node,
    observer: DomTreeMutationObserver,
    topDocument: Document | undefined,
    documentEpoch: number,
  ): boolean {
    return !this.disposed &&
      this.topDocument === topDocument &&
      this.documentEpoch === documentEpoch &&
      this.rootObservers.get(root) === observer &&
      this.observedRootByObserver.get(observer) === root;
  }

  private readSelectedNodeRef(): SelectedNodeRefRead {
    if (!this.getSelectedNodeRef) {
      return Object.freeze({ valid: true, nodeRef: undefined });
    }
    if (this.rollbackEffectSuppressionDepth === 0 && !this.publicationCanContinue()) {
      return Object.freeze({ valid: false, nodeRef: undefined });
    }
    let nodeRef: string | undefined;
    const deferredFrameLifecycleReadCount = this.deferredFrameLifecycleReadCount;
    this.externalValueReadDepth += 1;
    try {
      const selected = this.getSelectedNodeRef();
      nodeRef = typeof selected === "string" ? selected : undefined;
    } catch {
      // A selected-ref provider is optional and cannot break ownership cleanup.
    } finally {
      this.externalValueReadDepth -= 1;
    }
    if (this.rollbackEffectSuppressionDepth === 0 && !this.publicationCanContinue()) {
      return Object.freeze({ valid: false, nodeRef: undefined });
    }
    if (this.deferredFrameLifecycleReadCount !== deferredFrameLifecycleReadCount) {
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
      if (event !== this.rollbackSuppressedFrameEvent) {
        this.outwardEffectBuffer.push({ kind: "frame", event });
      }
      return true;
    }
    return this.onFrameLifecycle
      ? this.invokeOutwardCallback(() => this.onFrameLifecycle?.(event))
      : true;
  }

  private registerDiscoveredFrame(
    frameElement: HTMLIFrameElement,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const excluded = this.isNodeExcluded(frameElement);
    if (!isCurrent() || excluded) {
      return;
    }
    let ownerDocument: Document | undefined;
    try {
      ownerDocument = frameElement.ownerDocument;
    } catch {
      return;
    }
    if (!isCurrent()) return;
    const parent = ownerDocument
      ? this.frameRegistry.getContextForDocument(ownerDocument)
      : undefined;
    if (!isCurrent()) return;
    if (!parent) {
      return;
    }
    const description = this.frameRegistry.describeFrame(
      frameElement,
      parent.frameRef,
      isCurrent,
    );
    if (!isCurrent()) return;
    if (description) {
      this.trackFrameDescription(
        frameElement,
        description,
        undefined,
        false,
        isCurrent,
      );
    }
  }

  private queueFrameDiscovery(
    document: Document,
    resetGuard = this.activeFrameMutationScanGuard,
  ): void {
    if (
      this.disposed ||
      (resetGuard !== undefined && !resetGuard()) ||
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
      ...(resetGuard ? { resetGuard } : {}),
    });
    if (this.frameMutationScanTimer === undefined) {
      this.frameMutationScanTimer = this.scheduleTimeout(() => {
        this.frameMutationScanTimer = undefined;
        this.processFrameMutationScanSlice();
      }, 0);
    }
  }

  private deferFrameDiscovery(authority: MutationDrainAuthority): void {
    this.deferredFrameDiscovery = authority;
    if (this.deferredFrameDiscoveryScheduled) return;
    this.deferredFrameDiscoveryScheduled = true;
    globalThis.queueMicrotask(() => this.flushDeferredFrameDiscovery());
  }

  private flushDeferredFrameDiscovery(): void {
    this.deferredFrameDiscoveryScheduled = false;
    const authority = this.deferredFrameDiscovery;
    if (!authority || !this.isMutationDrainAuthorityCurrent(authority)) {
      if (this.deferredFrameDiscovery === authority) {
        this.deferredFrameDiscovery = undefined;
      }
      return;
    }
    if (this.outwardEffectBuffer !== undefined || this.mutationProcessingDepth > 0) {
      this.deferFrameDiscovery(authority);
      return;
    }
    this.deferredFrameDiscovery = undefined;
    const topDocument = authority.topDocument;
    if (!topDocument || !this.frameTracking) return;
    this.queueFrameDiscovery(topDocument);
    this.processFrameMutationScanSlice();
  }

  private processFrameMutationScanSlice(): void {
    let visitedNodes = 0;
    let operations = 0;
    const previousGuard = this.activeFrameMutationScanGuard;
    try {
      while (
        this.pendingFrameMutationScans.length > 0 &&
        visitedNodes < FRAME_MUTATION_SCAN_LIMIT &&
        operations < FRAME_MUTATION_OPERATION_LIMIT
      ) {
        operations += 1;
        const scan = this.pendingFrameMutationScans[0]!;
        const isCurrent = (): boolean => (
          !this.disposed && (scan.resetGuard?.() ?? true)
        );
        const abandonIfStale = (): boolean => {
          if (isCurrent()) return false;
          for (
            let index = this.pendingFrameMutationScans.length - 1;
            index >= 0;
            index -= 1
          ) {
            const candidate = this.pendingFrameMutationScans[index]!;
            if (
              candidate === scan ||
              (
                scan.resetGuard !== undefined &&
                candidate.resetGuard === scan.resetGuard
              )
            ) {
              this.pendingFrameMutationScans.splice(index, 1);
            }
          }
          return true;
        };
        this.activeFrameMutationScanGuard = scan.resetGuard;
        if (abandonIfStale()) continue;
        if (scan.action === "register") {
          const ownerObserved = this.rootObservers.has(scan.ownerRoot);
          const rootAttached = scan.root === scan.ownerRoot ||
            containsNode(scan.ownerRoot, scan.root);
          if (abandonIfStale()) continue;
          if (!ownerObserved || !rootAttached) {
            this.pendingFrameMutationScans.shift();
            continue;
          }
        }
        const entry = scan.stack[scan.stack.length - 1];
        if (!entry) {
          this.pendingFrameMutationScans.shift();
          continue;
        }
        if (!entry.entered) {
          entry.entered = true;
          visitedNodes += 1;
          if (scan.action === "register") {
            const excluded = this.isNodeExcluded(entry.node);
            if (abandonIfStale()) continue;
            if (excluded) {
              scan.stack.pop();
              continue;
            }
          }
          const nodeType = entry.node.nodeType;
          if (abandonIfStale()) continue;
          if (nodeType === 1) {
            const element = entry.node as Element;
            const frameElement = isFrameElement(element);
            if (abandonIfStale()) continue;
            if (frameElement) {
              if (scan.action === "register") {
                this.registerDiscoveredFrame(element, isCurrent);
              } else {
                this.unregisterDiscoveredFrame(element);
              }
              if (abandonIfStale()) continue;
            }
            entry.shadowRoot = getOpenShadowRoot(element);
            if (abandonIfStale()) continue;
          }
          const childNodes = readChildNodes(entry.node);
          if (abandonIfStale()) continue;
          entry.childNodes = childNodes;
          entry.childCount = childNodes?.length ?? 0;
          continue;
        }
        if (entry.nextChildIndex < entry.childCount) {
          const child = entry.childNodes?.[entry.nextChildIndex];
          if (abandonIfStale()) continue;
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
    } finally {
      this.activeFrameMutationScanGuard = previousGuard;
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
      this.cancelTimerSlot("frameMutationScanTimer");
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
    isCurrent: () => boolean = () => !this.disposed,
  ): void {
    if (!isCurrent()) return;
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
      this.observeRoot(description.document, isCurrent);
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
    const frameScanGuard = this.activeFrameMutationScanGuard;
    const isCurrent = (): boolean => (
      !this.disposed && (frameScanGuard?.() ?? true)
    );
    if (this.disposed) return true;
    if (event.type !== "reset" && !isCurrent()) return false;
    const deferredFrameLifecycleReadCount = this.deferredFrameLifecycleReadCount;
    const effectSavepoint = this.outwardEffectBuffer?.length;
    if (!this.outwardEffectBuffer) {
      this.authorityGeneration += 1;
    }
    if (this.externalValueReadDepth > 0 && this.activePublicationGuard) {
      if (this.outwardEffectBuffer) {
        this.outwardEffectBuffer.push({ kind: "frame", event });
        this.deferredFrameLifecycleReadCount += 1;
      }
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
      )) {
        this.journalDeferredFrameLifecycle(event, effectSavepoint, deferredFrameLifecycleReadCount);
        return false;
      }
    }
    for (const identity of event.invalidated ?? []) {
      if (!this.releaseFrameIdentity(identity.frameRef, true)) return false;
    }
    if (event.type === "registered" || event.type === "navigated") {
      const context = this.frameRegistry.getContext(event.frameRef);
      if (!isCurrent()) return false;
      if (context) {
        const description = Object.freeze({
          kind: "accessible" as const,
          ...context,
        });
        if (!this.inactiveFrameRefs.has(context.frameRef)) {
          this.observeRoot(context.document, isCurrent);
          if (!isCurrent()) return false;
        }
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
        }
        for (const nodeRef of frameNodeRefs) {
          this.frameDescriptions.set(nodeRef, description);
        }
      } else if (event.parentFrameRef) {
        if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
      if (context) {
        this.queueFrameDiscovery(context.document, frameScanGuard);
      }
    }
    if (!isCurrent()) return false;
    return this.emitFrameLifecycle(event);
  }

  private journalDeferredFrameLifecycle(
    event: FrameLifecycleEvent,
    effectSavepoint: number | undefined,
    deferredFrameLifecycleReadCount: number,
  ): void {
    const buffer = this.outwardEffectBuffer;
    if (
      !buffer ||
      effectSavepoint === undefined ||
      this.deferredFrameLifecycleReadCount === deferredFrameLifecycleReadCount
    ) return;
    const index = buffer.findIndex((effect, offset) => (
      offset >= effectSavepoint && effect.kind === "frame"
    ));
    buffer.splice(index < 0 ? buffer.length : index, 0, { kind: "frame", event });
  }

  private cancelScheduledWork(): void {
    const timers: readonly (readonly [keyof RollbackTimerState, DomTreeTimerHandle | undefined])[] = [
      ["mutationTimer", this.mutationTimer],
      ["shadowScanTimer", this.shadowScanTimer],
      ["frameMutationScanTimer", this.frameMutationScanTimer],
    ];
    for (const [timer, handle] of timers) {
      const cancellation = this.cancelTimerSlot(timer, handle);
      if (!cancellation.current) return;
    }
  }

  private cancelTimerSlot(
    timer: keyof RollbackTimerState,
    expectedHandle = this[timer],
  ): TimerCancellationResult {
    const authority = {
      topDocument: this.topDocument,
      documentEpoch: this.documentEpoch,
      authorityGeneration: this.authorityGeneration,
      disposed: this.disposed,
    };
    const isCurrent = (): boolean => (
      this.topDocument === authority.topDocument &&
      this.documentEpoch === authority.documentEpoch &&
      this.authorityGeneration === authority.authorityGeneration &&
      this.disposed === authority.disposed &&
      this[timer] === undefined
    );
    if (expectedHandle === undefined) {
      return Object.freeze({
        current: this[timer] === undefined,
        cancelled: true,
      });
    }
    if (this[timer] !== expectedHandle) {
      return Object.freeze({ current: false, cancelled: false });
    }
    this[timer] = undefined;
    let cancelled = true;
    try {
      this.cancelTimeout(expectedHandle);
    } catch {
      cancelled = false;
    }
    return Object.freeze({ current: isCurrent(), cancelled });
  }

  private stopShadowScanIfIdle(): void {
    if (
      this.expandedShadowHosts.size === 0 &&
      this.shadowScanTimer !== undefined
    ) {
      const cancellation = this.cancelTimerSlot("shadowScanTimer");
      if (!cancellation.current) return;
      this.shadowScanOffset = 0;
    }
  }

  private disconnectAllObservers(
    isCurrent: () => boolean = () => true,
  ): boolean {
    for (const [observer, root] of [...this.observedRootByObserver]) {
      this.disconnectObserverInstance(root, observer);
      if (!isCurrent()) return false;
    }
    for (const [root, observer] of [...this.rootObservers]) {
      this.disconnectObserverInstance(root, observer);
      if (!isCurrent()) return false;
    }
    if (!isCurrent()) return false;
    this.rootObservers.clear();
    this.observedRootByObserver.clear();
    return isCurrent();
  }

  private disconnectObserver(root: Node): void {
    const observers = new Set<DomTreeMutationObserver>();
    const tracked = this.rootObservers.get(root);
    if (tracked) observers.add(tracked);
    for (const [observer, observedRoot] of this.observedRootByObserver) {
      if (observedRoot === root) observers.add(observer);
    }
    for (const observer of observers) {
      this.disconnectObserverInstance(root, observer);
    }
  }

  private disconnectObserverInstance(
    root: Node,
    observer: DomTreeMutationObserver,
  ): boolean {
    if (this.rootObservers.get(root) === observer) {
      this.rootObservers.delete(root);
    }
    if (this.observedRootByObserver.get(observer) === root) {
      this.observedRootByObserver.delete(observer);
    }
    try {
      observer.disconnect();
      return true;
    } catch {
      // Ownership is released even if a hostile observer adapter throws.
      return false;
    }
  }

  private disconnectObserversWithin(root: Node): void {
    const observedRoots = new Set<Node>([
      ...this.rootObservers.keys(),
      ...this.observedRootByObserver.values(),
    ]);
    for (const observedRoot of observedRoots) {
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
  childPhysicalOffsets: readonly number[],
  hasMore: boolean,
  nextPhysicalOffset: number,
): LogicalChildPage {
  return Object.freeze({
    children: Object.freeze(children),
    childPhysicalOffsets: Object.freeze(childPhysicalOffsets),
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

function hasLogicalChild(node: Node): boolean {
  const childNodes = readChildNodes(node);
  if (!childNodes) return true;
  try {
    const length = childNodes.length;
    return typeof length === "number" &&
      Number.isSafeInteger(length) &&
      length >= 0
      ? length > 0
      : true;
  } catch {
    return true;
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

function readNodeType(node: Node): number | undefined {
  try {
    const nodeType = (node as { readonly nodeType?: unknown }).nodeType;
    return typeof nodeType === "number" && Number.isSafeInteger(nodeType)
      ? nodeType
      : undefined;
  } catch {
    return undefined;
  }
}

function readNodeName(node: Node, fallback: string): string {
  try {
    const nodeName = (node as { readonly nodeName?: unknown }).nodeName;
    if (typeof nodeName === "string" && nodeName.length > 0) {
      return truncateDomProtocolUtf16(
        nodeName,
        DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
      );
    }
  } catch {
    // Use the bounded kind-specific fallback.
  }
  return fallback;
}

function readNodeValue(node: Node): string | undefined {
  try {
    const value = (node as { readonly nodeValue?: unknown }).nodeValue;
    return typeof value === "string"
      ? truncateDomProtocolUtf16(value, DOM_PROTOCOL_MAX_NODE_VALUE_LENGTH)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDocumentTypeName(node: DocumentType): string {
  try {
    const name = (node as { readonly name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      return truncateDomProtocolUtf16(
        name,
        DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
      );
    }
  } catch {
    // Fall back to nodeName below.
  }
  return readNodeName(node, "html");
}

function readDocumentTypeId(
  node: DocumentType,
  key: "publicId" | "systemId",
): string | undefined {
  try {
    const value = (node as unknown as Record<string, unknown>)[key];
    return typeof value === "string"
      ? truncateDomProtocolUtf16(value, DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH)
      : undefined;
  } catch {
    return undefined;
  }
}

function readInspectorAttributes(element: Element): readonly InspectorAttribute[] {
  let attributes: ArrayLike<{ readonly name?: unknown; readonly value?: unknown }>;
  try {
    attributes = element.attributes;
  } catch {
    return Object.freeze([]);
  }
  const result: InspectorAttribute[] = [];
  const count = boundedArrayLikeLength(attributes, DOM_PROTOCOL_MAX_ATTRIBUTES);
  for (let index = 0; index < count; index += 1) {
    try {
      const attribute = attributes[index];
      const name = attribute?.name;
      const value = attribute?.value;
      if (typeof name !== "string" || name.length === 0 || typeof value !== "string") {
        continue;
      }
      result.push(Object.freeze({
        name: truncateDomProtocolUtf16(
          name,
          DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
        ),
        value: truncateDomProtocolUtf16(
          value,
          DOM_PROTOCOL_MAX_ATTRIBUTE_VALUE_LENGTH,
        ),
      }));
    } catch {
      return Object.freeze([]);
    }
  }
  return Object.freeze(result);
}

function safeChildCount(node: Node, syntheticCount = 0): number {
  const childNodes = readChildNodes(node);
  if (!childNodes) return syntheticCount;
  try {
    const length = childNodes.length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > Number.MAX_SAFE_INTEGER - syntheticCount
    ) {
      return syntheticCount;
    }
    return length + syntheticCount;
  } catch {
    return syntheticCount;
  }
}

function safeArrayLikeItem<T>(value: ArrayLike<T>, index: number): T | undefined {
  try {
    return value[index];
  } catch {
    return undefined;
  }
}

function characterDataLabel(kind: "text" | "comment", value?: string): string {
  const bounded = truncateDomProtocolUtf16(
    value ?? (kind === "text" ? "#text" : "#comment"),
    500,
  );
  return kind === "text"
    ? bounded || "#text"
    : truncateDomProtocolUtf16(
      `<!--${bounded}-->`,
      DOM_PROTOCOL_MAX_LABEL_LENGTH,
    );
}

function documentTypeLabel(
  name: string,
  publicId?: string,
  systemId?: string,
): string {
  let label = `<!DOCTYPE ${name}`;
  if (publicId !== undefined && publicId.length > 0) {
    label += ` PUBLIC "${publicId}"`;
    if (systemId !== undefined && systemId.length > 0) label += ` "${systemId}"`;
  } else if (systemId !== undefined && systemId.length > 0) {
    label += ` SYSTEM "${systemId}"`;
  }
  return truncateDomProtocolUtf16(
    `${label}>`,
    DOM_PROTOCOL_MAX_LABEL_LENGTH,
  );
}

function isRecoverableKind(
  kind: DomNodeView["kind"],
): kind is DomStableLocator["targetKind"] {
  return kind === "element" || kind === "shadow-root" || kind === "frame-document";
}

interface SizedDomNodeView {
  readonly view: DomNodeView;
  readonly serializedBytes: number;
}

function sizeDomNodeView(view: DomNodeView): SizedDomNodeView {
  return Object.freeze({
    view,
    serializedBytes: requiredSerializedUtf8ByteLength(view),
  });
}

function reduceSizedOptionalNodeSnapshot(
  sized: SizedDomNodeView,
  requiredSavings: number,
): SizedDomNodeView {
  let view = sized.view;
  let serializedBytes = sized.serializedBytes;
  if (view.attributes.length > 0) {
    let retainedAttributeCount = view.attributes.length;
    let attributeSavings = 0;
    while (
      retainedAttributeCount > 0 &&
      attributeSavings < requiredSavings
    ) {
      const attribute = view.attributes[retainedAttributeCount - 1]!;
      attributeSavings += requiredSerializedUtf8ByteLength(attribute) +
        (retainedAttributeCount > 1 ? 1 : 0);
      retainedAttributeCount -= 1;
    }
    view = Object.freeze({
      ...view,
      attributes: Object.freeze(view.attributes.slice(0, retainedAttributeCount)),
    });
    serializedBytes -= attributeSavings;
    if (sized.serializedBytes - serializedBytes >= requiredSavings) {
      return Object.freeze({ view, serializedBytes });
    }
  }

  // After attributes, only four optional fields remain. Reserializing after each
  // removal is a fixed bound independent of page-controlled collection sizes.
  while (sized.serializedBytes - serializedBytes < requiredSavings) {
    const reduced = reduceOptionalNodeSnapshot(view);
    if (reduced === view) break;
    const reducedBytes = requiredSerializedUtf8ByteLength(reduced);
    if (reducedBytes > serializedBytes) throwDomTreeError("node-unavailable");
    view = reduced;
    serializedBytes = reducedBytes;
  }
  return Object.freeze({ view, serializedBytes });
}

function serializedRootResponseByteLength(
  response: DomRootResponse,
  nodeBytes: number,
  prologueBytes: readonly number[],
  epilogueBytes: readonly number[],
): number {
  return serializedJsonObjectByteLength([
    serializedJsonMemberByteLength("type", response.type),
    serializedJsonMemberByteLength("requestId", response.requestId),
    serializedJsonMemberByteLength("documentEpoch", response.documentEpoch),
    serializedKnownJsonMemberByteLength("node", nodeBytes),
    serializedKnownJsonMemberByteLength(
      "prologue",
      serializedJsonArrayByteLength(prologueBytes),
    ),
    serializedKnownJsonMemberByteLength(
      "epilogue",
      serializedJsonArrayByteLength(epilogueBytes),
    ),
  ]);
}

function serializedChildrenResponseByteLength(
  response: DomChildrenResponse,
  nodeBytes: readonly number[],
  nextCursor: string | undefined,
): number {
  const members = [
    serializedJsonMemberByteLength("type", response.type),
    serializedJsonMemberByteLength("requestId", response.requestId),
    serializedJsonMemberByteLength("documentEpoch", response.documentEpoch),
    serializedJsonMemberByteLength("nodeRef", response.nodeRef),
    serializedJsonMemberByteLength("branchRevision", response.branchRevision),
    serializedKnownJsonMemberByteLength(
      "nodes",
      serializedJsonArrayByteLength(nodeBytes),
    ),
  ];
  if (nextCursor !== undefined) {
    members.push(serializedJsonMemberByteLength("nextCursor", nextCursor));
  }
  return serializedJsonObjectByteLength(members);
}

function serializedJsonObjectByteLength(memberBytes: readonly number[]): number {
  return 2 + memberBytes.reduce((total, bytes) => total + bytes, 0) +
    Math.max(0, memberBytes.length - 1);
}

function serializedJsonArrayByteLength(itemBytes: readonly number[]): number {
  return 2 + itemBytes.reduce((total, bytes) => total + bytes, 0) +
    Math.max(0, itemBytes.length - 1);
}

function serializedJsonMemberByteLength(name: string, value: unknown): number {
  return serializedKnownJsonMemberByteLength(
    name,
    requiredSerializedUtf8ByteLength(value),
  );
}

function serializedKnownJsonMemberByteLength(
  name: string,
  valueBytes: number,
): number {
  return requiredSerializedUtf8ByteLength(name) + 1 + valueBytes;
}

function requiredSerializedUtf8ByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return utf8ByteLength(serialized);
  } catch {
    // Fall through to the same fail-closed provider error as envelope validation.
  }
  throwDomTreeError("node-unavailable");
}

function reduceOptionalNodeSnapshot(node: DomNodeView): DomNodeView {
  if (node.attributes.length > 0) {
    return Object.freeze({
      ...node,
      attributes: Object.freeze(node.attributes.slice(0, -1)),
    });
  }
  if (Object.prototype.hasOwnProperty.call(node, "nodeValue")) {
    const { nodeValue: _nodeValue, ...rest } = node;
    return Object.freeze(rest);
  }
  if (Object.prototype.hasOwnProperty.call(node, "systemId")) {
    const { systemId: _systemId, ...rest } = node;
    return Object.freeze(rest);
  }
  if (Object.prototype.hasOwnProperty.call(node, "publicId")) {
    const { publicId: _publicId, ...rest } = node;
    return Object.freeze(rest);
  }
  if (Object.prototype.hasOwnProperty.call(node, "locator")) {
    const { locator: _locator, ...rest } = node;
    return Object.freeze(rest);
  }
  return node;
}

function freezeRootResponse(
  template: DomRootResponse,
  node: DomNodeView,
  prologue: readonly DomNodeView[],
  epilogue: readonly DomNodeView[],
): DomRootResponse {
  return Object.freeze({
    type: "dom.root",
    requestId: template.requestId,
    documentEpoch: template.documentEpoch,
    node,
    prologue: Object.freeze([...prologue]),
    epilogue: Object.freeze([...epilogue]),
  });
}

function freezeChildrenResponse(
  template: DomChildrenResponse,
  nodes: readonly DomNodeView[],
): DomChildrenResponse {
  return Object.freeze({
    type: "dom.children",
    requestId: template.requestId,
    documentEpoch: template.documentEpoch,
    nodeRef: template.nodeRef,
    branchRevision: template.branchRevision,
    nodes: Object.freeze([...nodes]),
    ...(template.nextCursor ? { nextCursor: template.nextCursor } : {}),
  });
}

function serializedWithinBudget(
  value: unknown,
  maximumBytes = DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
): boolean {
  return domProtocolEnvelopeWithinBudget(value, maximumBytes);
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
  return truncateDomProtocolUtf16(
    value.replace(/[\s.#\[\]<>&"'`=\\/\u0000-\u001f\u007f]/g, "_"),
    ELEMENT_LABEL_MAX_TOKEN_LENGTH,
  );
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
        names.push(truncateDomProtocolUtf16(
          normalized,
          ELEMENT_LABEL_MAX_TOKEN_LENGTH,
        ));
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

function isExactOpenShadowRoot(host: Node, candidate: Node): boolean {
  try {
    const element = host as Element;
    const shadowRoot = candidate as ShadowRoot;
    return element.nodeType === 1 &&
      shadowRoot.mode === "open" &&
      shadowRoot.host === element &&
      element.shadowRoot === shadowRoot;
  } catch {
    return false;
  }
}

function findObservedRoot(
  observers: ReadonlyMap<Node, DomTreeMutationObserver>,
  candidate: DomTreeMutationObserver,
): Node | undefined {
  for (const [root, observer] of observers) {
    if (observer === candidate) return root;
  }
  return undefined;
}
