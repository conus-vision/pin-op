import type { CssDocumentSource } from "./collectCssFacts.js";
import {
  DomTreeProvider,
  DomTreeProviderError,
  type DomTreeElementIdentity,
  type DomTreeFrameAuthority,
  type DomTreeProviderOptions,
  type DomTreeResolvedElement,
  type DomTreeRevealedElement,
  type DomTreeSessionRetention,
} from "./domTreeProvider.js";
import {
  parseDomRequest,
  type DomChildrenResponse,
  type DomErrorCode,
  type DomErrorResponse,
  type DomEvent,
  type DomGetChildrenRequest,
  type DomInvalidationBranch,
  type DomNodeView,
  type DomRequest,
  type DomResponse,
  type DomRootResponse,
  type DomHoverChangedEvent,
  type DomSelectionChangedEvent,
} from "./domProtocol.js";
import type { DomStableLocator } from "./domStableLocator.js";
import type {
  FrameContext,
  FrameIdentity,
} from "./frameRegistry.js";
import {
  createInspectPayload,
  type InspectPayloadWithDiagnostics,
  type LocationSource,
} from "./inspectPayload.js";
import {
  InspectMode,
  type InspectDocument,
  type InspectableElement,
  type InspectModeOptions,
} from "./inspectMode.js";
import {
  PageOverlay,
  type PageOverlayOptions,
} from "./pageOverlay.js";

export const PAGE_INSPECTION_SELECTION_INTERVAL_MS = 100;

export type PageInspectionDocument = Document & {
  readonly styleSheets: CssDocumentSource["styleSheets"];
};

export interface PageInspectionSelection {
  readonly nodeRef: string;
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly ancestorPath: readonly DomNodeView[];
  readonly payload: InspectPayloadWithDiagnostics;
}

export interface PageInspectionTreeProvider {
  readonly currentDocumentEpoch: number;
  readonly frameAuthority: DomTreeFrameAuthority;
  getRoot(expectedEpoch?: number): DomRootResponse;
  getChildren(request: DomGetChildrenRequest): DomChildrenResponse;
  resolveLocator(locator: DomStableLocator): {
    readonly node: DomNodeView;
    readonly ancestorPath: readonly DomNodeView[];
  } | undefined;
  lookupElement(element: Element): DomTreeElementIdentity | undefined;
  revealElement(element: Element): DomTreeRevealedElement;
  resolveElement(
    nodeRef: string,
    documentEpoch: number,
  ): DomTreeResolvedElement | undefined;
  retainNode(
    nodeRef: string,
    documentEpoch: number,
    reason: DomTreeSessionRetention,
  ): boolean;
  releaseNode(nodeRef: string, reason: DomTreeSessionRetention): void;
  startFrameTracking(): void;
  resetDocument(document: Document, documentEpoch: number): void;
  dispose(): void;
}

export interface PageInspectionOverlay {
  show(element: Element, frameIdentity: FrameIdentity): void;
  clear(): void;
  ownsNode(node: Node): boolean;
  dispose(): void;
}

export interface PageInspectionMode {
  addDocument(document: InspectDocument): void;
  removeDocument(document: InspectDocument): void;
  enable(): void;
  disable(): void;
  dispose(): void;
}

export interface PageInspectionSessionOptions {
  readonly document: PageInspectionDocument;
  readonly location: LocationSource | (() => LocationSource);
  readonly documentEpoch?: number;
  readonly selectionIntervalMs?: number;
  readonly onSelection: (
    selection: PageInspectionSelection,
  ) => boolean;
  readonly onEvent?: (event: DomEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly overlayOptions?: PageOverlayOptions;
  readonly createInspectPayload?: (
    element: InspectableElement,
    document: CssDocumentSource,
    location: LocationSource,
  ) => InspectPayloadWithDiagnostics;
  readonly createTreeProvider?: (
    document: Document,
    options: DomTreeProviderOptions,
  ) => PageInspectionTreeProvider;
  readonly createOverlay?: (
    document: Document,
    frameAuthority: DomTreeFrameAuthority,
    options: PageOverlayOptions,
  ) => PageInspectionOverlay;
  readonly createInspectMode?: (
    options: InspectModeOptions,
  ) => PageInspectionMode;
}

interface SelectedState extends DomTreeResolvedElement {
  readonly ancestorPath: readonly DomNodeView[];
}

interface HoveredState extends FrameIdentity {
  readonly element: Element;
  readonly nodeRef?: string;
  readonly summary: string;
}

type HoverDelivery = "emit" | "return";

type PendingPageHover =
  | {
      readonly kind: "target";
      readonly element: InspectableElement;
      readonly pickerRevision: number;
      readonly hoverRevision: number;
    }
  | {
      readonly kind: "clear";
      readonly pickerRevision: number;
      readonly hoverRevision: number;
    };

interface SelectionAttemptOptions {
  readonly emitSelectionEvent: boolean;
  readonly pageInput: boolean;
  readonly throwErrors?: boolean;
}

type SelectionTarget =
  | {
      readonly kind: "element";
      readonly element: InspectableElement;
      readonly documentEpoch: number;
    }
  | {
      readonly kind: "ref";
      readonly nodeRef: string;
      readonly documentEpoch: number;
    };

interface SelectionPreparationToken {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly selected: SelectedState | undefined;
}

interface SelectionAuthorityToken {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly selected: SelectedState;
}

interface PreparedSelection {
  readonly authority: SelectionAuthorityToken;
  readonly emitSelectionEvent: boolean;
  readonly event: DomSelectionChangedEvent;
  readonly selection: PageInspectionSelection;
}

interface HoverUpgrade {
  readonly previous: HoveredState;
  readonly upgraded: HoveredState;
}

interface PageLeaveListenerCell {
  handle?: (event: Event) => void;
}

interface PageLeaveRegistration {
  readonly cell: PageLeaveListenerCell;
  readonly listener: EventListener;
}

export class PageInspectionSession {
  private document: PageInspectionDocument;
  private readonly provider: PageInspectionTreeProvider;
  private overlay: PageInspectionOverlay;
  private readonly mode: PageInspectionMode;
  private readonly selectionIntervalMs: number;
  private readonly now: () => number;
  private readonly payloadFactory: NonNullable<
    PageInspectionSessionOptions["createInspectPayload"]
  >;
  private readonly overlayFactory: NonNullable<
    PageInspectionSessionOptions["createOverlay"]
  >;
  private readonly overlayOptions: PageOverlayOptions;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly trackedDocuments = new Set<InspectDocument>();
  private readonly pageLeaveRegistrations = new Map<
    InspectDocument,
    PageLeaveRegistration
  >();
  private selected: SelectedState | undefined;
  private hovered: HoveredState | undefined;
  private pendingPageHover: PendingPageHover | undefined;
  private pendingHoverFrame: number | undefined;
  private lastSelectionAt: number | undefined;
  private hoverRevision = 0;
  private pickerRevision = 0;
  private selectionRevision = 0;
  private selectionPreparing = false;
  private activeSelectionPublications = 0;
  private republishingSelection = false;
  private selectionPreparationTail: Promise<void> = Promise.resolve();
  private pickerActive = false;
  private resettingDocument = false;
  private disposed = false;

  public constructor(private readonly options: PageInspectionSessionOptions) {
    this.document = options.document;
    this.selectionIntervalMs = requireNonnegativeNumber(
      options.selectionIntervalMs ?? PAGE_INSPECTION_SELECTION_INTERVAL_MS,
      "selectionIntervalMs",
    );
    this.now = options.now ?? Date.now;
    this.payloadFactory = options.createInspectPayload ?? createInspectPayload;
    this.requestFrame = options.requestAnimationFrame ?? ((callback) => {
      const view = this.document.defaultView;
      if (!view) throw new Error("requestAnimationFrame is unavailable");
      return view.requestAnimationFrame(callback);
    });
    this.cancelFrame = options.cancelAnimationFrame ?? ((handle) => {
      this.document.defaultView?.cancelAnimationFrame(handle);
    });
    const createProvider = options.createTreeProvider ?? (
      (document, providerOptions) => new DomTreeProvider(
        document,
        providerOptions,
      )
    );
    this.provider = createProvider(options.document, {
      documentEpoch: options.documentEpoch,
      getSelectedNodeRef: () => this.selected?.nodeRef,
      onInvalidated: (branch) => this.handleInvalidation(
        branch,
        options.documentEpoch ?? 0,
      ),
      onSelectedNodeRemoved: (event) => this.handleSelectedNodeRemoved(event),
      onFrameLifecycle: () => this.handleFrameLifecycle(),
      onMutationSettled: () => this.handleMutationSettled(),
      isExcludedNode: (node) => this.isOverlayNode(node),
    });
    this.overlayFactory = options.createOverlay ?? (
      (document, frameAuthority, overlayOptions) => new PageOverlay(
        document,
        frameAuthority,
        overlayOptions,
      )
    );
    this.overlayOptions = options.overlayOptions ?? {};
    this.overlay = this.overlayFactory(
      options.document,
      this.provider.frameAuthority,
      this.overlayOptions,
    );
    const createMode = options.createInspectMode ?? (
      (modeOptions) => new InspectMode(modeOptions)
    );
    this.mode = createMode({
      document: options.document,
      isOverlayNode: (node) => this.isOverlayNode(node as Node),
      onClearHover: () => this.clearPageHover(),
      onEscape: () => this.handleEscape(),
      onHover: (element) => this.hover(element),
      onSelect: (element) => this.selectPageElement(element),
      onError: (error) => this.reportError(error),
    });
    this.trackedDocuments.add(options.document);
    this.attachPageLeaveListener(options.document);
    this.provider.startFrameTracking();
    this.syncFrameDocuments();
  }

  public get pickerEnabled(): boolean {
    return this.pickerActive && !this.disposed;
  }

  public enablePicker(): void {
    if (this.disposed || this.pickerActive) {
      return;
    }
    this.syncFrameDocuments();
    this.pickerRevision += 1;
    this.pickerActive = true;
    this.mode.enable();
  }

  public disablePicker(): void {
    if (this.disposed || !this.pickerActive) {
      return;
    }
    this.pickerRevision += 1;
    this.pickerActive = false;
    this.mode.disable();
    this.clearHover();
  }

  public resetDocument(
    document: PageInspectionDocument,
    documentEpoch: number,
  ): void {
    if (this.disposed) {
      return;
    }
    if (
      !Number.isSafeInteger(documentEpoch) ||
      documentEpoch <= this.provider.currentDocumentEpoch
    ) {
      throw new RangeError("documentEpoch must advance the current epoch");
    }

    this.resettingDocument = true;
    try {
      this.pickerActive = false;
      this.pickerRevision += 1;
      this.hoverRevision += 1;
      this.mode.disable();
      this.selectionRevision += 1;
      this.cancelPendingHoverFrame();
      if (this.hovered?.nodeRef) {
        this.provider.releaseNode(this.hovered.nodeRef, "hovered");
      }
      this.hovered = undefined;
      if (this.selected) {
        this.provider.releaseNode(this.selected.nodeRef, "selected");
      }
      this.selected = undefined;
      this.lastSelectionAt = undefined;

      for (const tracked of this.trackedDocuments) {
        this.detachPageLeaveListener(tracked);
        this.mode.removeDocument(tracked);
      }
      this.trackedDocuments.clear();

      const previousOverlay = this.overlay;
      previousOverlay.clear();
      this.provider.resetDocument(document, documentEpoch);
      this.document = document;
      this.overlay = this.overlayFactory(
        document,
        this.provider.frameAuthority,
        this.overlayOptions,
      );
      previousOverlay.dispose();
    } finally {
      this.resettingDocument = false;
    }
    this.syncFrameDocuments();
  }

  public hover(element: InspectableElement): void {
    if (
      !this.pickerEnabled ||
      typeof element !== "object" ||
      element === null
    ) {
      return;
    }
    this.queuePageHover(Object.freeze({
      kind: "target",
      element,
      pickerRevision: this.pickerRevision,
      hoverRevision: this.hoverRevision,
    }));
  }

  public hoverByRef(nodeRef: string, documentEpoch: number): void {
    if (this.disposed) {
      return;
    }
    try {
      const next = this.resolveHoveredState(nodeRef, documentEpoch);
      this.applyHover(next, "emit");
    } catch (error) {
      this.reportError(error);
    }
  }

  public clearHover(documentEpoch?: number): void {
    if (
      this.disposed ||
      (documentEpoch !== undefined &&
        documentEpoch !== this.provider.currentDocumentEpoch)
    ) {
      return;
    }
    this.clearHoverState("emit");
  }

  public clearOverlayForRefresh(): void {
    if (this.disposed) {
      return;
    }
    this.clearHoverState("emit");
  }

  public async selectByRef(
    nodeRef: string,
    documentEpoch: number,
  ): Promise<void> {
    await this.queueSelection({
      kind: "ref",
      nodeRef,
      documentEpoch,
    }, {
      emitSelectionEvent: true,
      pageInput: false,
    });
  }

  public async republishSelection(): Promise<boolean> {
    const selected = this.selected;
    if (
      this.disposed ||
      !selected ||
      this.selectionPreparing ||
      this.activeSelectionPublications > 0 ||
      this.republishingSelection
    ) {
      return false;
    }
    const authority: SelectionAuthorityToken = Object.freeze({
      documentEpoch: selected.documentEpoch,
      selectionRevision: this.selectionRevision,
      selected,
    });
    this.republishingSelection = true;
    try {
      let payload: InspectPayloadWithDiagnostics | undefined;
      try {
        const resolved = this.resolveLiveSelection(authority);
        if (!resolved) {
          if (this.isSelectionAuthorityLocallyCurrent(authority)) {
            this.clearUnavailableSelection(selected);
          }
          return false;
        }
        payload = this.createPayloadFor(
          resolved.element as InspectableElement,
          selected,
          () => this.isSelectionAuthorityCurrent(authority),
        );
      } catch (error) {
        this.reportError(error);
        if (this.isSelectionAuthorityLocallyCurrent(authority)) {
          this.clearUnavailableSelection(selected);
        }
        return false;
      }
      if (
        !payload ||
        !this.isSelectionAuthorityCurrent(authority)
      ) {
        return false;
      }
      const published = this.publishSelection(Object.freeze({
        nodeRef: selected.nodeRef,
        documentEpoch: selected.documentEpoch,
        selectionRevision: authority.selectionRevision,
        ancestorPath: selected.ancestorPath,
        payload,
      }), authority);
      return published && this.isSelectionAuthorityCurrent(authority);
    } finally {
      this.republishingSelection = false;
    }
  }

  public async handle(
    request: DomRequest,
  ): Promise<DomResponse | readonly DomEvent[]> {
    let parsed: DomRequest;
    try {
      parsed = parseDomRequest(request);
    } catch {
      return errorResponse("invalid-request");
    }
    if (this.disposed) {
      return errorResponse(
        "session-disposed",
        "requestId" in parsed ? parsed.requestId : undefined,
        "documentEpoch" in parsed ? parsed.documentEpoch : undefined,
      );
    }
    try {
      if (parsed.type === "dom.getRoot") {
        const response = this.provider.getRoot(parsed.documentEpoch);
        return Object.freeze({ ...response, requestId: parsed.requestId });
      }
      if (parsed.type === "dom.getChildren") {
        return this.provider.getChildren(parsed);
      }
      if (parsed.type === "dom.resolveLocator") {
        try {
          const resolved = this.provider.resolveLocator(parsed.locator);
          return resolved
            ? Object.freeze({
              type: "dom.locator" as const,
              requestId: parsed.requestId,
              documentEpoch: this.provider.currentDocumentEpoch,
              node: resolved.node,
              ancestorPath: resolved.ancestorPath,
            })
            : errorResponse(
              "node-unavailable",
              parsed.requestId,
              this.provider.currentDocumentEpoch,
            );
        } catch {
          return errorResponse(
            "node-unavailable",
            parsed.requestId,
            this.provider.currentDocumentEpoch,
          );
        }
      }
      if (parsed.type === "dom.hover") {
        const event = this.applyHover(
          this.resolveHoveredState(parsed.nodeRef, parsed.documentEpoch),
          "return",
          true,
        );
        return event
          ? Object.freeze([event])
          : Object.freeze([]) as readonly DomEvent[];
      }
      if (parsed.type === "dom.clearHover") {
        if (parsed.documentEpoch !== this.provider.currentDocumentEpoch) {
          throw new DomTreeProviderError("stale-document");
        }
        const event = this.clearHoverState("return");
        return Object.freeze([event ?? this.createClearedHoverEvent()]);
      }
      const event = await this.queueSelection(
        {
          kind: "ref",
          nodeRef: parsed.nodeRef,
          documentEpoch: parsed.documentEpoch,
        },
        {
          emitSelectionEvent: false,
          pageInput: false,
          throwErrors: true,
        },
      );
      return event
        ? Object.freeze([event])
        : Object.freeze([]) as readonly DomEvent[];
    } catch (error) {
      return reduceError(error, parsed);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pickerActive = false;
    this.pickerRevision += 1;
    this.hoverRevision += 1;
    this.selectionRevision += 1;
    try {
      this.mode.dispose();
    } catch {
      // Continue releasing every independently owned resource.
    }
    this.cancelPendingHoverFrame();
    const hoveredNodeRef = this.hovered?.nodeRef;
    this.hovered = undefined;
    const selectedNodeRef = this.selected?.nodeRef;
    this.selected = undefined;
    if (hoveredNodeRef) {
      try {
        this.provider.releaseNode(hoveredNodeRef, "hovered");
      } catch {
        // Provider disposal below remains authoritative cleanup.
      }
    }
    if (selectedNodeRef) {
      try {
        this.provider.releaseNode(selectedNodeRef, "selected");
      } catch {
        // Provider disposal below remains authoritative cleanup.
      }
    }
    try {
      this.overlay.clear();
    } catch {
      // Overlay disposal still gets a chance to remove owned nodes.
    }
    try {
      this.overlay.dispose();
    } catch {
      // Disposal is terminal even when page DOM hooks are hostile.
    }
    try {
      this.provider.dispose();
    } catch {
      // The session is already inert and cannot retry owned callbacks safely.
    }
    for (const tracked of [...this.pageLeaveRegistrations.keys()]) {
      this.detachPageLeaveListener(tracked);
    }
    this.trackedDocuments.clear();
  }

  private async selectPageElement(element: InspectableElement): Promise<void> {
    if (!this.pickerEnabled) {
      return;
    }
    let documentEpoch: number;
    try {
      documentEpoch = this.provider.currentDocumentEpoch;
    } catch (error) {
      this.reportError(error);
      return;
    }
    await this.queueSelection({
      kind: "element",
      element,
      documentEpoch,
    }, {
      emitSelectionEvent: true,
      pageInput: true,
    });
  }

  private queueSelection(
    target: SelectionTarget,
    attempt: SelectionAttemptOptions,
  ): Promise<DomSelectionChangedEvent | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    const rejectReentrantPreparation = this.selectionPreparing;
    const preparation = this.selectionPreparationTail.then(() => (
      rejectReentrantPreparation
        ? undefined
        : this.prepareSelection(target, attempt)
    ));
    const completion = preparation.then((prepared) => (
      this.completePreparedSelection(prepared)
    ));
    this.selectionPreparationTail = preparation.then(
      () => undefined,
      () => undefined,
    );
    return completion;
  }

  private prepareSelection(
    target: SelectionTarget,
    attempt: SelectionAttemptOptions,
  ): PreparedSelection | undefined {
    const startRevision = this.selectionRevision;
    const startSelected = this.selected;
    if (!this.isSelectionSnapshotCurrent(
      target.documentEpoch,
      startRevision,
      startSelected,
    )) {
      const error = new DomTreeProviderError(
        this.disposed ? "session-disposed" : "stale-document",
      );
      this.reportError(error);
      if (attempt.throwErrors) throw error;
      return undefined;
    }
    let pageSelectionAt: number | undefined;
    if (attempt.pageInput) {
      pageSelectionAt = this.readClock();
      if (
        pageSelectionAt === undefined ||
        !this.isSelectionSnapshotCurrent(
          target.documentEpoch,
          startRevision,
          startSelected,
        ) ||
        (this.lastSelectionAt !== undefined &&
          pageSelectionAt - this.lastSelectionAt < this.selectionIntervalMs)
      ) {
        return undefined;
      }
    }
    const operation = ++this.selectionRevision;
    const preparationToken: SelectionPreparationToken = Object.freeze({
      documentEpoch: target.documentEpoch,
      selectionRevision: operation,
      selected: startSelected,
    });
    let previous = startSelected;
    let next: SelectedState | undefined;
    let retainedNewSelection = false;
    let releasedPreviousSelection = false;
    let hoverUpgrade: HoverUpgrade | undefined;
    this.selectionPreparing = true;
    try {
      const element = this.resolveSelectionTarget(target, preparationToken);
      if (!element) {
        throw new DomTreeProviderError("unknown-node");
      }
      if (!this.isSelectionPreparationCurrent(preparationToken)) {
        return undefined;
      }
      let revealed = this.snapshotRevealedElement(
        this.provider.revealElement(element as Element),
        () => this.isSelectionPreparationCurrent(preparationToken),
      );
      if (!revealed) {
        throw new DomTreeProviderError("node-unavailable");
      }
      const createdPayload = this.createPayloadFor(
        element,
        revealed,
        () => this.isSelectionPreparationCurrent(preparationToken),
      );
      if (!createdPayload) {
        throw new Error("Inspect payload is unavailable");
      }
      if (!this.isSelectionPreparationCurrent(preparationToken)) {
        return undefined;
      }
      const confirmed = this.snapshotRevealedElement(
        this.provider.revealElement(element as Element),
        () => this.isSelectionPreparationCurrent(preparationToken),
      );
      if (
        !confirmed ||
        confirmed.nodeRef !== revealed.nodeRef ||
        !sameFrameIdentity(confirmed, revealed)
      ) {
        throw new DomTreeProviderError("node-unavailable");
      }
      revealed = confirmed;
      if (!this.isSelectionPreparationCurrent(preparationToken)) {
        return undefined;
      }

      retainedNewSelection = previous?.nodeRef !== revealed.nodeRef;
      if (
        retainedNewSelection &&
        !this.provider.retainNode(
          revealed.nodeRef,
          revealed.documentEpoch,
          "selected",
        )
      ) {
        throw new DomTreeProviderError("node-unavailable");
      }
      if (!this.isSelectionPreparationCurrent(preparationToken)) {
        if (retainedNewSelection && !this.disposed) {
          this.provider.releaseNode(revealed.nodeRef, "selected");
        }
        return undefined;
      }
      next = Object.freeze({
        element: element as Element,
        nodeRef: revealed.nodeRef,
        frameRef: revealed.frameRef,
        frameEpoch: revealed.frameEpoch,
        documentEpoch: revealed.documentEpoch,
        ancestorPath: revealed.ancestorPath,
      });
      if (previous && previous.nodeRef !== next.nodeRef) {
        this.provider.releaseNode(previous.nodeRef, "selected");
        releasedPreviousSelection = true;
      }
      if (!this.isSelectionPreparationCurrent(preparationToken)) {
        if (retainedNewSelection && !this.disposed) {
          this.provider.releaseNode(next.nodeRef, "selected");
        }
        return undefined;
      }
      this.selected = next;
      const authority: SelectionAuthorityToken = Object.freeze({
        documentEpoch: next.documentEpoch,
        selectionRevision: operation,
        selected: next,
      });
      hoverUpgrade = this.upgradeMatchingHover(next);
      const overlayState = this.hovered;
      if (overlayState) {
        this.overlay.show(overlayState.element, overlayState);
      } else {
        this.clearOverlaySafely();
      }
      if (!this.isSelectionAuthorityLocallyCurrent(authority)) {
        return undefined;
      }
      if (attempt.pageInput) {
        this.lastSelectionAt = pageSelectionAt;
      }
      const event: DomSelectionChangedEvent = Object.freeze({
        type: "dom.selectionChanged",
        documentEpoch: next.documentEpoch,
        selectionRevision: operation,
        nodeRef: next.nodeRef,
        ancestorPath: next.ancestorPath,
      });
      const selection: PageInspectionSelection = Object.freeze({
        nodeRef: next.nodeRef,
        documentEpoch: next.documentEpoch,
        selectionRevision: operation,
        ancestorPath: next.ancestorPath,
        payload: createdPayload,
      });
      return Object.freeze({
        authority,
        emitSelectionEvent: attempt.emitSelectionEvent,
        event,
        selection,
      });
    } catch (error) {
      if (!this.disposed && next && this.selected === next) {
        if (hoverUpgrade && this.hovered === hoverUpgrade.upgraded) {
          this.hoverRevision += 1;
          this.hovered = hoverUpgrade.previous;
          this.provider.releaseNode(next.nodeRef, "hovered");
        }
        let restored = previous;
        if (releasedPreviousSelection && previous) {
          try {
            if (!this.provider.retainNode(
              previous.nodeRef,
              previous.documentEpoch,
              "selected",
            )) {
              restored = undefined;
            }
          } catch {
            restored = undefined;
          }
        }
        this.selected = restored;
        if (retainedNewSelection) {
          this.provider.releaseNode(next.nodeRef, "selected");
        }
        this.restoreAuthoritativeOverlay();
      }
      this.reportError(error);
      if (attempt.throwErrors) {
        throw error;
      }
      return undefined;
    } finally {
      this.selectionPreparing = false;
    }
  }

  private completePreparedSelection(
    prepared: PreparedSelection | undefined,
  ): DomSelectionChangedEvent | undefined {
    if (!prepared) {
      return undefined;
    }
    if (!this.publishSelection(
      prepared.selection,
      prepared.authority,
    )) {
      return undefined;
    }
    if (!this.isSelectionAuthorityCurrent(prepared.authority)) {
      return undefined;
    }
    if (prepared.emitSelectionEvent) {
      this.emitEvent(prepared.event);
      if (!this.isSelectionAuthorityCurrent(prepared.authority)) {
        return undefined;
      }
    }
    return prepared.event;
  }

  private upgradeMatchingHover(selected: SelectedState): HoverUpgrade | undefined {
    const previous = this.hovered;
    if (
      !previous ||
      previous.nodeRef ||
      previous.element !== selected.element ||
      !sameFrameIdentity(previous, selected)
    ) {
      return undefined;
    }
    if (!this.provider.retainNode(
      selected.nodeRef,
      selected.documentEpoch,
      "hovered",
    )) {
      throw new DomTreeProviderError("node-unavailable");
    }
    const upgraded: HoveredState = Object.freeze({
      element: previous.element,
      nodeRef: selected.nodeRef,
      frameRef: selected.frameRef,
      frameEpoch: selected.frameEpoch,
      documentEpoch: selected.documentEpoch,
      summary: previous.summary,
    });
    this.hoverRevision += 1;
    this.hovered = upgraded;
    return { previous, upgraded };
  }

  private handleEscape(): void {
    if (!this.pickerEnabled) {
      return;
    }
    if (this.hovered) {
      this.clearHoverState("emit");
    } else {
      this.disablePicker();
    }
  }

  private isPageHoverAuthoritative(
    pickerRevision: number,
    hoverRevision: number,
  ): boolean {
    return this.pickerEnabled &&
      this.pickerRevision === pickerRevision &&
      this.hoverRevision === hoverRevision;
  }

  private processPageHover(pending: PendingPageHover): void {
    if (!this.isPageHoverAuthoritative(
      pending.pickerRevision,
      pending.hoverRevision,
    )) {
      return;
    }
    if (pending.kind === "clear") {
      const event = this.clearHoverState("return");
      if (event) {
        this.emitEvent(event);
      }
      return;
    }

    const element = pending.element;
    if (
      !isElementLike(element) ||
      !this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      )
    ) {
      return;
    }
    const ownerDocument = readOwnerDocument(element);
    if (
      !ownerDocument ||
      !isElementAttached(element as unknown as Element, ownerDocument) ||
      !this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      )
    ) {
      return;
    }
    let owned = true;
    try {
      owned = this.overlay.ownsNode(element as unknown as Node);
    } catch {
      return;
    }
    if (
      owned ||
      !this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      )
    ) {
      return;
    }

    let known: DomTreeElementIdentity | undefined;
    let context: FrameContext | undefined;
    try {
      known = this.provider.lookupElement(element as unknown as Element);
      if (!this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      )) {
        return;
      }
      context = known
        ? this.provider.frameAuthority.getContext(known.frameRef)
        : ownerDocument
          ? this.provider.frameAuthority.getContextForDocument(ownerDocument)
          : undefined;
    } catch (error) {
      this.reportError(error);
      return;
    }
    if (
      !this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      ) ||
      !context ||
      context.documentEpoch !== this.provider.currentDocumentEpoch ||
      (known !== undefined && !sameFrameIdentity(known, context)) ||
      !isElementAttached(element as unknown as Element, ownerDocument)
    ) {
      return;
    }
    const summary = summarizeElement(element);
    if (
      !summary ||
      !this.isPageHoverAuthoritative(
        pending.pickerRevision,
        pending.hoverRevision,
      )
    ) {
      return;
    }
    const next: HoveredState = Object.freeze({
      element: element as unknown as Element,
      ...(known ? { nodeRef: known.nodeRef } : {}),
      frameRef: context.frameRef,
      frameEpoch: context.frameEpoch,
      documentEpoch: context.documentEpoch,
      summary,
    });
    const event = this.applyHover(next, "return");
    if (event) {
      this.emitEvent(event);
    }
  }

  private resolveSelectionTarget(
    target: SelectionTarget,
    authority: SelectionPreparationToken,
  ): InspectableElement | undefined {
    if (target.kind === "element") {
      return this.isSelectionPreparationCurrent(authority)
        ? target.element
        : undefined;
    }
    let resolved: DomTreeResolvedElement | undefined;
    try {
      resolved = this.provider.resolveElement(
        target.nodeRef,
        target.documentEpoch,
      );
    } catch (error) {
      if (!this.isSelectionPreparationCurrent(authority)) {
        return undefined;
      }
      throw error;
    }
    if (!this.isSelectionPreparationCurrent(authority)) {
      return undefined;
    }
    const snapshot = this.snapshotResolvedElement(
      resolved,
      () => this.isSelectionPreparationCurrent(authority),
    );
    return snapshot?.nodeRef === target.nodeRef &&
        snapshot.documentEpoch === target.documentEpoch
      ? snapshot.element as InspectableElement
      : undefined;
  }

  private snapshotResolvedElement(
    resolved: DomTreeResolvedElement | undefined,
    isAuthoritative: () => boolean,
  ): DomTreeResolvedElement | undefined {
    if (!resolved || !isAuthoritative()) {
      return undefined;
    }
    try {
      const element = resolved.element;
      if (!isAuthoritative()) return undefined;
      const nodeRef = resolved.nodeRef;
      if (!isAuthoritative()) return undefined;
      const frameRef = resolved.frameRef;
      if (!isAuthoritative()) return undefined;
      const frameEpoch = resolved.frameEpoch;
      if (!isAuthoritative()) return undefined;
      const documentEpoch = resolved.documentEpoch;
      if (!isAuthoritative() || !isElementLike(element)) return undefined;
      return Object.freeze({
        element,
        nodeRef,
        frameRef,
        frameEpoch,
        documentEpoch,
      });
    } catch {
      return undefined;
    }
  }

  private snapshotRevealedElement(
    revealed: DomTreeRevealedElement,
    isAuthoritative: () => boolean,
  ): DomTreeRevealedElement | undefined {
    if (!isAuthoritative()) {
      return undefined;
    }
    try {
      const nodeRef = revealed.nodeRef;
      if (!isAuthoritative()) return undefined;
      const frameRef = revealed.frameRef;
      if (!isAuthoritative()) return undefined;
      const frameEpoch = revealed.frameEpoch;
      if (!isAuthoritative()) return undefined;
      const documentEpoch = revealed.documentEpoch;
      if (!isAuthoritative()) return undefined;
      const ancestorPath = revealed.ancestorPath;
      if (!isAuthoritative()) return undefined;
      return Object.freeze({
        nodeRef,
        frameRef,
        frameEpoch,
        documentEpoch,
        ancestorPath,
      });
    } catch {
      return undefined;
    }
  }

  private requireResolvedElement(
    nodeRef: string,
    documentEpoch: number,
  ): DomTreeResolvedElement {
    const resolved = this.provider.resolveElement(nodeRef, documentEpoch);
    if (!resolved) {
      throw new DomTreeProviderError("unknown-node");
    }
    return resolved;
  }

  private resolveHoveredState(
    nodeRef: string,
    documentEpoch: number,
  ): HoveredState {
    const resolved = this.requireResolvedElement(nodeRef, documentEpoch);
    const summary = summarizeElement(resolved.element as InspectableElement);
    if (!summary) {
      throw new DomTreeProviderError("node-unavailable");
    }
    return Object.freeze({
      element: resolved.element,
      nodeRef: resolved.nodeRef,
      frameRef: resolved.frameRef,
      frameEpoch: resolved.frameEpoch,
      documentEpoch: resolved.documentEpoch,
      summary,
    });
  }

  private applyHover(
    next: HoveredState,
    delivery: HoverDelivery,
    throwErrors = false,
  ): DomHoverChangedEvent | undefined {
    if (this.disposed) {
      return undefined;
    }
    const operation = ++this.hoverRevision;
    const previous = this.hovered;
    const retainedNewHover = Boolean(
      next.nodeRef && previous?.nodeRef !== next.nodeRef,
    );
    let releasedPreviousHover = false;
    try {
      if (
        retainedNewHover &&
        next.nodeRef &&
        !this.provider.retainNode(next.nodeRef, next.documentEpoch, "hovered")
      ) {
        throw new DomTreeProviderError("node-unavailable");
      }
      if (
        this.disposed ||
        operation !== this.hoverRevision ||
        this.hovered !== previous
      ) {
        if (retainedNewHover && next.nodeRef && !this.disposed) {
          this.provider.releaseNode(next.nodeRef, "hovered");
        }
        return undefined;
      }
      if (previous?.nodeRef && previous.nodeRef !== next.nodeRef) {
        this.provider.releaseNode(previous.nodeRef, "hovered");
        releasedPreviousHover = true;
      }
      this.hovered = next;
      this.overlay.show(next.element, next);
    } catch (error) {
      if (
        !this.disposed &&
        operation === this.hoverRevision &&
        this.hovered === next
      ) {
        let restored = previous;
        if (releasedPreviousHover && previous?.nodeRef) {
          try {
            if (!this.provider.retainNode(
              previous.nodeRef,
              previous.documentEpoch,
              "hovered",
            )) {
              restored = undefined;
            }
          } catch {
            restored = undefined;
          }
        }
        this.hovered = restored;
        if (retainedNewHover && next.nodeRef) {
          this.provider.releaseNode(next.nodeRef, "hovered");
        }
        this.restoreAuthoritativeOverlay();
      }
      this.reportError(error);
      if (throwErrors) throw error;
      return undefined;
    }
    if (
      this.disposed ||
      operation !== this.hoverRevision ||
      this.hovered !== next
    ) {
      return undefined;
    }
    const event: DomHoverChangedEvent = Object.freeze({
      type: "dom.hoverChanged",
      documentEpoch: next.documentEpoch,
      ...(next.nodeRef ? { nodeRef: next.nodeRef } : {}),
      summary: next.summary,
    });
    this.cancelPendingHoverFrame();
    if (delivery === "emit") {
      this.emitEvent(event);
    }
    return event;
  }

  private clearPageHover(): void {
    if (this.pickerEnabled) {
      this.queuePageHover(Object.freeze({
        kind: "clear",
        pickerRevision: this.pickerRevision,
        hoverRevision: this.hoverRevision,
      }));
    }
  }

  private clearHoverState(
    delivery: HoverDelivery,
  ): DomHoverChangedEvent | undefined {
    this.cancelPendingHoverFrame();
    const previous = this.hovered;
    if (!previous) {
      this.clearOverlaySafely();
      return undefined;
    }
    this.hoverRevision += 1;
    this.hovered = undefined;
    if (previous.nodeRef) {
      this.provider.releaseNode(previous.nodeRef, "hovered");
    }
    this.clearOverlaySafely();
    const event = this.createClearedHoverEvent();
    if (delivery === "emit") {
      this.emitEvent(event);
    }
    return event;
  }

  private restoreAuthoritativeOverlay(): void {
    const hovered = this.hovered;
    if (hovered) {
      try {
        this.overlay.show(hovered.element, hovered);
      } catch (error) {
        this.reportError(error);
        this.clearOverlaySafely();
      }
      return;
    }
    this.clearOverlaySafely();
  }

  private clearOverlaySafely(): void {
    try {
      this.overlay.clear();
    } catch (error) {
      this.reportError(error);
    }
  }

  private createClearedHoverEvent(): DomHoverChangedEvent {
    return Object.freeze({
      type: "dom.hoverChanged",
      documentEpoch: this.provider.currentDocumentEpoch,
    });
  }

  private queuePageHover(pending: PendingPageHover): void {
    if (this.disposed) {
      return;
    }
    this.pendingPageHover = pending;
    if (this.pendingHoverFrame !== undefined) {
      return;
    }
    try {
      this.pendingHoverFrame = this.requestFrame(() => {
        this.pendingHoverFrame = undefined;
        const latest = this.pendingPageHover;
        this.pendingPageHover = undefined;
        if (latest && !this.disposed) {
          this.processPageHover(latest);
        }
      });
    } catch (error) {
      this.pendingHoverFrame = undefined;
      this.pendingPageHover = undefined;
      this.reportError(error);
    }
  }

  private cancelPendingHoverFrame(): void {
    const handle = this.pendingHoverFrame;
    this.pendingHoverFrame = undefined;
    this.pendingPageHover = undefined;
    if (handle === undefined) {
      return;
    }
    try {
      this.cancelFrame(handle);
    } catch {
      // The cleared token keeps a leaked frame callback harmless.
    }
  }

  private handleSelectedNodeRemoved(event: {
    readonly nodeRef: string;
    readonly documentEpoch: number;
  }): void {
    if (
      this.disposed ||
      this.selected?.nodeRef !== event.nodeRef ||
      this.selected.documentEpoch !== event.documentEpoch
    ) {
      return;
    }
    const selected = this.selected;
    if (
      this.pendingPageHover?.kind === "target" &&
      this.pendingPageHover.element === selected.element
    ) {
      this.cancelPendingHoverFrame();
    }
    this.selectionRevision += 1;
    const removedHover = this.hovered?.nodeRef === event.nodeRef;
    if (removedHover) {
      this.hoverRevision += 1;
      this.provider.releaseNode(event.nodeRef, "hovered");
      this.hovered = undefined;
      this.cancelPendingHoverFrame();
    }
    this.provider.releaseNode(event.nodeRef, "selected");
    this.selected = undefined;
    this.restoreAuthoritativeOverlay();
    if (removedHover) {
      this.emitEvent(Object.freeze({
        type: "dom.hoverChanged",
        documentEpoch: event.documentEpoch,
      }));
    }
  }

  private clearUnavailableSelection(selected: SelectedState): void {
    if (this.selected !== selected) {
      return;
    }
    this.selectionRevision += 1;
    this.provider.releaseNode(selected.nodeRef, "selected");
    this.selected = undefined;
    if (!this.hovered) {
      this.clearOverlaySafely();
    }
  }

  private handleInvalidation(
    branch: DomInvalidationBranch,
    fallbackDocumentEpoch: number,
  ): void {
    if (this.disposed) {
      return;
    }
    this.emitEvent(Object.freeze({
      type: "dom.invalidated",
      documentEpoch: this.provider?.currentDocumentEpoch ??
        fallbackDocumentEpoch,
      branches: Object.freeze([branch]),
    }));
    if (this.provider) {
      this.reconcileRetainedAuthority();
    }
  }

  private handleFrameLifecycle(): void {
    if (this.disposed || this.resettingDocument) {
      return;
    }
    this.syncFrameDocuments();
    this.reconcileRetainedAuthority();
  }

  private handleMutationSettled(): void {
    if (this.disposed || this.resettingDocument) {
      return;
    }
    this.reconcileRetainedAuthority();
  }

  private reconcileRetainedAuthority(): void {
    let hoverRemoved = false;
    const hovered = this.hovered;
    if (
      hovered &&
      !this.isHoveredStateCurrent(hovered) &&
      this.hovered === hovered
    ) {
      this.hoverRevision += 1;
      if (hovered.nodeRef) {
        this.provider.releaseNode(hovered.nodeRef, "hovered");
      }
      this.hovered = undefined;
      this.cancelPendingHoverFrame();
      hoverRemoved = true;
    }

    const selected = this.selected;
    if (
      selected &&
      !this.isSelectedStateCurrent(selected) &&
      this.selected === selected
    ) {
      this.selectionRevision += 1;
      this.provider.releaseNode(selected.nodeRef, "selected");
      this.selected = undefined;
    }

    if (hoverRemoved || selected !== this.selected) {
      this.restoreAuthoritativeOverlay();
    }
    if (hoverRemoved) {
      this.emitEvent(this.createClearedHoverEvent());
    }
  }

  private isHoveredStateCurrent(hovered: HoveredState): boolean {
    try {
      if (hovered.nodeRef) {
        const resolved = this.provider.resolveElement(
          hovered.nodeRef,
          hovered.documentEpoch,
        );
        return Boolean(
          resolved &&
          resolved.element === hovered.element &&
          sameFrameIdentity(resolved, hovered),
        );
      }
      const context = this.provider.frameAuthority.getContext(hovered.frameRef);
      const ownerDocument = readOwnerDocument(
        hovered.element as InspectableElement,
      );
      return Boolean(
        context &&
        ownerDocument === context.document &&
        sameFrameIdentity(context, hovered) &&
        isElementAttached(hovered.element, ownerDocument),
      );
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private isSelectedStateCurrent(selected: SelectedState): boolean {
    if (this.selected !== selected) {
      return false;
    }
    return this.isSelectionAuthorityCurrent(Object.freeze({
      documentEpoch: selected.documentEpoch,
      selectionRevision: this.selectionRevision,
      selected,
    }));
  }

  private isSelectionSnapshotCurrent(
    documentEpoch: number,
    selectionRevision: number,
    selected: SelectedState | undefined,
  ): boolean {
    let currentDocumentEpoch: number;
    try {
      currentDocumentEpoch = this.provider.currentDocumentEpoch;
    } catch {
      return false;
    }
    return !this.disposed &&
      currentDocumentEpoch === documentEpoch &&
      this.selectionRevision === selectionRevision &&
      this.selected === selected;
  }

  private isSelectionPreparationCurrent(
    authority: SelectionPreparationToken,
  ): boolean {
    return this.isSelectionSnapshotCurrent(
      authority.documentEpoch,
      authority.selectionRevision,
      authority.selected,
    );
  }

  private isSelectionAuthorityLocallyCurrent(
    authority: SelectionAuthorityToken,
  ): boolean {
    return this.isSelectionSnapshotCurrent(
      authority.documentEpoch,
      authority.selectionRevision,
      authority.selected,
    ) && authority.selected.nodeRef === this.selected?.nodeRef;
  }

  private resolveLiveSelection(
    authority: SelectionAuthorityToken,
  ): DomTreeResolvedElement | undefined {
    if (!this.isSelectionAuthorityLocallyCurrent(authority)) {
      return undefined;
    }
    let raw: DomTreeResolvedElement | undefined;
    try {
      raw = this.provider.resolveElement(
        authority.selected.nodeRef,
        authority.documentEpoch,
      );
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
    if (!this.isSelectionAuthorityLocallyCurrent(authority)) {
      return undefined;
    }
    const resolved = this.snapshotResolvedElement(
      raw,
      () => this.isSelectionAuthorityLocallyCurrent(authority),
    );
    if (
      !resolved ||
      !this.isSelectionAuthorityLocallyCurrent(authority) ||
      resolved.nodeRef !== authority.selected.nodeRef ||
      resolved.element !== authority.selected.element ||
      !sameFrameIdentity(resolved, authority.selected)
    ) {
      return undefined;
    }
    return resolved;
  }

  private isSelectionAuthorityCurrent(
    authority: SelectionAuthorityToken,
  ): boolean {
    return this.resolveLiveSelection(authority) !== undefined;
  }

  private syncFrameDocuments(): void {
    if (this.disposed || this.resettingDocument || !this.mode) {
      return;
    }
    const current = new Set<InspectDocument>();
    try {
      for (const context of this.provider.frameAuthority.accessibleContexts()) {
        current.add(context.document as unknown as InspectDocument);
      }
    } catch (error) {
      this.reportError(error);
      return;
    }
    for (const document of current) {
      if (!this.trackedDocuments.has(document)) {
        this.trackedDocuments.add(document);
        this.mode.addDocument(document);
        this.attachPageLeaveListener(document);
      }
    }
    for (const document of [...this.trackedDocuments]) {
      if (!current.has(document)) {
        this.trackedDocuments.delete(document);
        this.detachPageLeaveListener(document);
        this.mode.removeDocument(document);
      }
    }
  }

  private attachPageLeaveListener(document: InspectDocument): void {
    if (this.disposed || this.pageLeaveRegistrations.has(document)) {
      return;
    }
    const target = document as unknown as Document;
    const cell: PageLeaveListenerCell = {};
    const listener: EventListener = (event) => {
      cell.handle?.(event);
    };
    const registration: PageLeaveRegistration = { cell, listener };
    cell.handle = (event): void => {
      if (
        this.disposed ||
        !this.trackedDocuments.has(document) ||
        this.pageLeaveRegistrations.get(document) !== registration ||
        !isTrustedPageExit(event)
      ) {
        return;
      }
      if (
        !this.disposed &&
        this.trackedDocuments.has(document) &&
        this.pageLeaveRegistrations.get(document) === registration
      ) {
        this.clearHover();
      }
    };
    this.pageLeaveRegistrations.set(document, registration);
    try {
      target.addEventListener("pointerleave", listener, true);
    } catch (error) {
      cell.handle = undefined;
      if (this.pageLeaveRegistrations.get(document) === registration) {
        this.pageLeaveRegistrations.delete(document);
      }
      try {
        target.removeEventListener("pointerleave", listener, true);
      } catch {
        // The detached cell makes a partially installed listener inert.
      }
      this.reportError(error);
      return;
    }
    if (
      this.disposed ||
      !this.trackedDocuments.has(document) ||
      this.pageLeaveRegistrations.get(document) !== registration
    ) {
      cell.handle = undefined;
      if (this.pageLeaveRegistrations.get(document) === registration) {
        this.pageLeaveRegistrations.delete(document);
      }
      try {
        target.removeEventListener("pointerleave", listener, true);
      } catch {
        // The stale listener cannot retain session authority.
      }
      return;
    }
  }

  private detachPageLeaveListener(document: InspectDocument): void {
    const registration = this.pageLeaveRegistrations.get(document);
    if (!registration) {
      return;
    }
    registration.cell.handle = undefined;
    this.pageLeaveRegistrations.delete(document);
    try {
      (document as unknown as Document).removeEventListener(
        "pointerleave",
        registration.listener,
        true,
      );
    } catch {
      // Session state no longer authorizes callbacks from this document.
    }
  }

  private readClock(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private isOverlayNode(node: Node): boolean {
    try {
      const overlay = this.overlay as PageInspectionOverlay | undefined;
      return overlay ? overlay.ownsNode(node) : false;
    } catch {
      return true;
    }
  }

  private readLocation(): LocationSource | undefined {
    try {
      return typeof this.options.location === "function"
        ? this.options.location()
        : this.options.location;
    } catch {
      return undefined;
    }
  }

  private createPayloadFor(
    element: InspectableElement,
    expectedFrame: FrameIdentity,
    isAuthoritative: () => boolean,
  ): InspectPayloadWithDiagnostics | undefined {
    if (!isAuthoritative()) {
      return undefined;
    }
    const document = readOwnerDocument(element);
    if (
      !document ||
      !isAuthoritative() ||
      !this.isElementInFrame(element, document, expectedFrame)
    ) {
      return undefined;
    }
    const location = this.readDocumentLocation(document);
    if (!isAuthoritative()) {
      return undefined;
    }
    const styleSheets = readStyleSheets(document);
    if (
      !location ||
      !styleSheets ||
      !isAuthoritative() ||
      !this.isElementInFrame(element, document, expectedFrame)
    ) {
      return undefined;
    }
    if (!isAuthoritative()) {
      return undefined;
    }
    const payload = this.payloadFactory(
      element,
      {
        pageUrl: location.href,
        styleSheets,
      },
      location,
    );
    return isAuthoritative() &&
        this.isElementInFrame(element, document, expectedFrame) &&
        isAuthoritative()
      ? payload
      : undefined;
  }

  private isElementInFrame(
    element: InspectableElement,
    document: Document,
    expectedFrame: FrameIdentity,
  ): boolean {
    try {
      const context = this.provider.frameAuthority.getContextForDocument(
        document,
      );
      return readOwnerDocument(element) === document &&
        context?.document === document &&
        sameFrameIdentity(context, expectedFrame) &&
        context.documentEpoch === this.provider.currentDocumentEpoch;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private readDocumentLocation(document: Document): LocationSource | undefined {
    let candidate: unknown;
    try {
      candidate = (document as unknown as {
        readonly location?: unknown;
      }).location;
    } catch {
      return undefined;
    }
    if (candidate === undefined) {
      candidate = this.readLocation();
    }
    return snapshotLocation(candidate);
  }

  private publishSelection(
    selection: PageInspectionSelection,
    authority: SelectionAuthorityToken,
  ): boolean {
    if (!this.isSelectionAuthorityCurrent(authority)) {
      return false;
    }
    this.activeSelectionPublications += 1;
    let accepted = false;
    try {
      accepted = this.options.onSelection(selection) === true;
    } catch (error) {
      this.reportError(error);
    } finally {
      this.activeSelectionPublications -= 1;
    }
    return accepted && this.isSelectionAuthorityCurrent(authority);
  }

  private emitEvent(event: DomEvent): void {
    if (this.disposed) {
      return;
    }
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot change session authority.
    }
  }
}

function reduceError(error: unknown, request: DomRequest): DomErrorResponse {
  const code = error instanceof DomTreeProviderError
    ? error.code
    : "internal-error";
  return errorResponse(
    code,
    "requestId" in request ? request.requestId : undefined,
    "documentEpoch" in request ? request.documentEpoch : undefined,
  );
}

function errorResponse(
  code: DomErrorCode,
  requestId?: string,
  documentEpoch?: number,
): DomErrorResponse {
  return Object.freeze({
    type: "dom.error",
    ...(requestId ? { requestId } : {}),
    ...(documentEpoch !== undefined ? { documentEpoch } : {}),
    code,
  });
}

function requireNonnegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}

function sameFrameIdentity(
  left: FrameIdentity,
  right: FrameIdentity,
): boolean {
  return left.frameRef === right.frameRef &&
    left.frameEpoch === right.frameEpoch &&
    left.documentEpoch === right.documentEpoch;
}

function isElementLike(value: unknown): value is InspectableElement & Element {
  try {
    return typeof value === "object" && value !== null &&
      (value as { readonly nodeType?: unknown }).nodeType === 1;
  } catch {
    return false;
  }
}

function isTrustedPageExit(event: Event): boolean {
  try {
    return event.isTrusted === true &&
      (event as PointerEvent).relatedTarget === null;
  } catch {
    return false;
  }
}

function readOwnerDocument(element: InspectableElement): Document | undefined {
  try {
    const document = (element as unknown as {
      readonly ownerDocument?: unknown;
    }).ownerDocument;
    return typeof document === "object" && document !== null
      ? document as Document
      : undefined;
  } catch {
    return undefined;
  }
}

function readStyleSheets(
  document: Document,
): CssDocumentSource["styleSheets"] | undefined {
  try {
    const styleSheets = (document as unknown as {
      readonly styleSheets?: unknown;
    }).styleSheets;
    return (typeof styleSheets === "object" && styleSheets !== null) ||
        typeof styleSheets === "function"
      ? styleSheets as CssDocumentSource["styleSheets"]
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotLocation(value: unknown): LocationSource | undefined {
  if ((typeof value !== "object" || value === null) &&
      typeof value !== "function") {
    return undefined;
  }
  try {
    const location = value as Partial<LocationSource>;
    return Object.freeze({
      href: String(location.href),
      pathname: String(location.pathname),
      search: String(location.search),
      hash: String(location.hash),
    });
  } catch {
    return undefined;
  }
}

function isElementAttached(
  element: Element,
  document: Document | undefined,
): boolean {
  if (!document) {
    return false;
  }
  try {
    const connected = (element as { readonly isConnected?: unknown })
      .isConnected;
    if (typeof connected === "boolean") {
      return connected;
    }
    const root = (document as { readonly documentElement?: unknown })
      .documentElement;
    if (root === element) {
      return true;
    }
    const contains = (root as { readonly contains?: unknown } | null)
      ?.contains;
    return typeof contains === "function" && Boolean(
      contains.call(root, element),
    );
  } catch {
    return false;
  }
}

function summarizeElement(element: InspectableElement): string | undefined {
  let tag = "";
  let id = "";
  let classList: ArrayLike<unknown>;
  try {
    tag = String(element.tagName).toLowerCase().slice(0, 64);
    id = String(element.id).slice(0, 64);
    classList = element.classList as unknown as ArrayLike<unknown>;
  } catch {
    return undefined;
  }
  if (!tag) {
    return undefined;
  }
  let summary = tag;
  if (id) {
    summary += `#${id}`;
  }
  let length = 0;
  try {
    const candidate = Number(classList.length);
    length = Number.isSafeInteger(candidate)
      ? Math.min(Math.max(candidate, 0), 32)
      : 0;
  } catch {
    return undefined;
  }
  let included = 0;
  for (let index = 0; index < length && included < 4; index += 1) {
    try {
      const className = String(classList[index]).slice(0, 64);
      if (className) {
        summary += `.${className}`;
        included += 1;
      }
    } catch {
      return undefined;
    }
  }
  return summary.slice(0, 512);
}
