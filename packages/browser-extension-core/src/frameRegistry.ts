export interface FrameIdentity {
  readonly frameRef: string;
  readonly frameEpoch: number;
  readonly documentEpoch: number;
}

export interface FrameContext extends FrameIdentity {
  readonly document: Document;
  readonly parentFrameRef?: string;
  readonly frameElement?: HTMLIFrameElement;
}

export interface AccessibleFrameDescription extends FrameContext {
  readonly kind: "accessible";
}

export interface InaccessibleFrameDescription {
  readonly kind: "inaccessible";
  readonly locked: true;
  readonly frameRef: string;
  readonly frameEpoch: number;
  readonly documentEpoch: number;
  readonly parentFrameRef: string;
}

export type FrameDescription =
  | AccessibleFrameDescription
  | InaccessibleFrameDescription;

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TopViewportRect extends ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type FrameLifecycleType =
  | "registered"
  | "navigated"
  | "reset"
  | "invalidated"
  | "removed";

export interface FrameLifecycleEvent {
  readonly type: FrameLifecycleType;
  readonly frameRef: string;
  readonly frameEpoch: number;
  readonly documentEpoch: number;
  readonly parentFrameRef?: string;
  readonly accessible: boolean;
  readonly invalidated?: readonly FrameIdentity[];
}

export interface FrameRegistryOptions {
  readonly documentEpoch?: number;
  readonly maxFrames?: number;
  readonly maxFrameEpoch?: number;
  readonly onLifecycle?: (event: FrameLifecycleEvent) => void;
}

interface FrameRecord extends FrameIdentity {
  readonly frameRef: string;
  frameEpoch: number;
  readonly documentEpoch: number;
  readonly parentFrameRef: string;
  ownership: FrameRecordOwnership | undefined;
  active: boolean;
  document: Document | undefined;
}

interface FrameRecordOwnership {
  readonly frameElement: HTMLIFrameElement;
  readonly access: FrameElementAccess;
  readonly onLoad: EventListener;
}

interface FrameListenerDetachment {
  readonly access: FrameElementAccess;
  readonly onLoad: EventListener;
}

interface FrameElementAccess {
  readonly frameElement: HTMLIFrameElement;
  readonly addLoadListener: (listener: EventListener) => void;
  readonly removeLoadListener: (listener: EventListener) => void;
  readonly getBoundingClientRect: () => DOMRect;
}

type FrameRegistryState = "active" | "mutating" | "disposing" | "disposed";

const MAX_REF_LENGTH = 24;
const MAX_GEOMETRY_ANCESTORS = 512;
const GEOMETRY_DIMENSION_TOLERANCE = 0.5;
const EMPTY_FRAME_IDENTITIES = Object.freeze([]) as readonly FrameIdentity[];

export class FrameRegistry {
  private readonly maxFrames: number;
  private readonly maxFrameEpoch: number;
  private readonly onLifecycle: ((event: FrameLifecycleEvent) => void) | undefined;
  private readonly contexts = new Map<string, FrameContext>();
  private readonly documentRefs = new Map<Document, string>();
  private readonly records = new Map<string, FrameRecord>();
  private readonly recordByElement = new Map<HTMLIFrameElement, FrameRecord>();
  private documentEpoch: number;
  private top: FrameContext | undefined;
  private nextFrameRef = 2;
  private exhaustedFrameElements = new WeakSet<HTMLIFrameElement>();
  private state: FrameRegistryState = "active";
  private structuralRevision = 0;

  public constructor(topDocument: Document, options: FrameRegistryOptions = {}) {
    if (!isObject(topDocument)) {
      throw new TypeError("topDocument must be an object");
    }
    this.maxFrames = requirePositiveSafeInteger(options.maxFrames ?? 64, "maxFrames");
    this.maxFrameEpoch = requirePositiveSafeInteger(
      options.maxFrameEpoch ?? Number.MAX_SAFE_INTEGER,
      "maxFrameEpoch",
    );
    this.documentEpoch = requireNonNegativeSafeInteger(
      options.documentEpoch ?? 0,
      "documentEpoch",
    );
    this.onLifecycle = options.onLifecycle;
    this.top = this.createTopContext(topDocument, 1);
    this.contexts.set(this.top.frameRef, this.top);
    this.documentRefs.set(topDocument, this.top.frameRef);
  }

  public get topContext(): FrameContext | undefined {
    return this.state === "active" ? this.top : undefined;
  }

  public getContext(frameRef: string): FrameContext | undefined {
    if (this.state !== "active" || !isFrameRef(frameRef)) {
      return undefined;
    }
    return this.contexts.get(frameRef);
  }

  public getContextForDocument(document: Document): FrameContext | undefined {
    if (this.state !== "active" || !isObject(document)) {
      return undefined;
    }
    const frameRef = this.documentRefs.get(document);
    return frameRef ? this.contexts.get(frameRef) : undefined;
  }

  public accessibleContexts(): readonly FrameContext[] {
    if (this.state !== "active") {
      return Object.freeze([]) as readonly FrameContext[];
    }
    return Object.freeze([...this.contexts.values()]);
  }

  public registerChildFrame(
    frameElement: HTMLIFrameElement,
    parentFrameRef = this.top?.frameRef,
  ): FrameDescription | undefined {
    return this.describeFrame(frameElement, parentFrameRef);
  }

  /** Registers an unseen live frame once; later calls only return its current description. */
  public describeFrame(
    frameElement: HTMLIFrameElement,
    parentFrameRef = this.top?.frameRef,
  ): FrameDescription | undefined {
    if (
      this.state !== "active" ||
      !isObject(frameElement) ||
      !parentFrameRef ||
      !isFrameRef(parentFrameRef) ||
      !this.contexts.has(parentFrameRef) ||
      this.exhaustedFrameElements.has(frameElement)
    ) {
      return undefined;
    }
    const existing = this.recordByElement.get(frameElement);
    if (existing) {
      return this.describe(existing);
    }
    if (this.records.size + 1 >= this.maxFrames) {
      return undefined;
    }

    let registeredRecord: FrameRecord | undefined;
    this.state = "mutating";
    try {
      const access = captureFrameElementAccess(frameElement);
      if (!access) {
        return undefined;
      }
      const frameRef = this.reserveFrameRef();
      const registryRef = new WeakRef(this);
      const onLoad: EventListener = function handleFrameLoad(): void {
        registryRef.deref()?.handleLoadByRef(frameRef);
      };
      const ownership = Object.freeze({ frameElement, access, onLoad });
      const record: FrameRecord = {
        frameRef,
        frameEpoch: 1,
        documentEpoch: this.documentEpoch,
        parentFrameRef,
        ownership,
        active: false,
        document: this.inspectDocument(frameElement),
      };
      try {
        access.addLoadListener(onLoad);
      } catch {
        record.document = undefined;
        record.ownership = undefined;
        if (!tryRemoveLoadListener({ access, onLoad })) {
          this.nextFrameRef += 1;
        }
        return undefined;
      }
      this.bumpStructuralRevision();
      this.records.set(record.frameRef, record);
      this.recordByElement.set(frameElement, record);
      this.installContext(record);
      record.active = true;
      this.nextFrameRef += 1;
      registeredRecord = record;
    } finally {
      this.state = "active";
    }
    if (!registeredRecord) {
      return undefined;
    }
    this.emit("registered", registeredRecord);
    return this.describe(registeredRecord);
  }

  public unregisterFrame(
    frameElementOrRef: HTMLIFrameElement | string,
  ): readonly FrameIdentity[] {
    if (this.state !== "active") {
      return EMPTY_FRAME_IDENTITIES;
    }
    const record = typeof frameElementOrRef === "string"
      ? isFrameRef(frameElementOrRef)
        ? this.records.get(frameElementOrRef)
        : undefined
      : isObject(frameElementOrRef)
        ? this.recordByElement.get(frameElementOrRef)
        : undefined;
    if (!record) {
      return EMPTY_FRAME_IDENTITIES;
    }
    let invalidated: readonly FrameIdentity[] = EMPTY_FRAME_IDENTITIES;
    this.state = "mutating";
    try {
      this.bumpStructuralRevision();
      invalidated = this.removeSubtree(record);
    } finally {
      this.state = "active";
    }
    this.emit("removed", record, invalidated, false);
    return invalidated;
  }

  public toTopViewport(identity: FrameIdentity, rect: ViewportRect): TopViewportRect | undefined {
    if (this.state !== "active" || !isObject(identity)) {
      return undefined;
    }
    const structuralRevision = this.structuralRevision;
    const identitySnapshot = snapshotFrameIdentity(identity, () => (
      this.state === "active" && this.structuralRevision === structuralRevision
    ));
    if (!identitySnapshot || !isObject(rect)) {
      return undefined;
    }
    let context = this.contexts.get(identitySnapshot.frameRef);
    if (!context || !sameFrameIdentity(context, identitySnapshot)) {
      return undefined;
    }
    const targetContext = context;
    const isAuthoritative = (): boolean => (
      this.state === "active" &&
      this.structuralRevision === structuralRevision &&
      this.contexts.get(targetContext.frameRef) === targetContext &&
      sameFrameIdentity(targetContext, identitySnapshot)
    );
    const rectX = readGeometryValue(() => rect.x, isAuthoritative);
    if (!rectX || typeof rectX.value !== "number" || !Number.isFinite(rectX.value)) {
      return undefined;
    }
    const rectY = readGeometryValue(() => rect.y, isAuthoritative);
    if (!rectY || typeof rectY.value !== "number" || !Number.isFinite(rectY.value)) {
      return undefined;
    }
    const rectWidth = readGeometryValue(() => rect.width, isAuthoritative);
    if (
      !rectWidth ||
      typeof rectWidth.value !== "number" ||
      !Number.isFinite(rectWidth.value) ||
      rectWidth.value < 0
    ) {
      return undefined;
    }
    const rectHeight = readGeometryValue(() => rect.height, isAuthoritative);
    if (
      !rectHeight ||
      typeof rectHeight.value !== "number" ||
      !Number.isFinite(rectHeight.value) ||
      rectHeight.value < 0
    ) {
      return undefined;
    }
    let x = rectX.value;
    let y = rectY.value;
    const width = rectWidth.value;
    const height = rectHeight.value;
    while (context.parentFrameRef) {
      if (!isAuthoritative() || this.contexts.get(context.frameRef) !== context) {
        return undefined;
      }
      const frameElement = context.frameElement;
      const record = this.records.get(context.frameRef);
      const ownership = record?.ownership;
      const parent = this.contexts.get(context.parentFrameRef);
      if (
        !frameElement ||
        !record ||
        !record.active ||
        !sameFrameIdentity(record, context) ||
        !ownership ||
        ownership.frameElement !== frameElement ||
        !parent
      ) {
        return undefined;
      }
      const offset = readFrameOffset(ownership.access, isAuthoritative);
      if (
        !offset ||
        !isAuthoritative() ||
        this.contexts.get(parent.frameRef) !== parent
      ) {
        return undefined;
      }
      x += offset.x;
      y += offset.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return undefined;
      }
      context = parent;
    }
    const right = x + width;
    const bottom = y + height;
    if (!Number.isFinite(right) || !Number.isFinite(bottom)) {
      return undefined;
    }
    if (!isAuthoritative()) {
      return undefined;
    }
    return Object.freeze({
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right,
      bottom,
    });
  }

  public resetTopDocument(topDocument: Document, documentEpoch: number): boolean {
    if (this.state !== "active" || !isObject(topDocument)) {
      return false;
    }
    const nextDocumentEpoch = requireNonNegativeSafeInteger(
      documentEpoch,
      "documentEpoch",
    );
    if (nextDocumentEpoch <= this.documentEpoch) {
      throw new RangeError("documentEpoch must be greater than the current epoch");
    }
    const previousTop = this.top;
    if (!previousTop) {
      return false;
    }
    this.state = "mutating";
    try {
      this.bumpStructuralRevision();
      this.removeAllRecords();
      this.contexts.clear();
      this.documentRefs.clear();
      this.documentEpoch = nextDocumentEpoch;
      this.exhaustedFrameElements = new WeakSet<HTMLIFrameElement>();
      this.top = this.createTopContext(topDocument, 1);
      this.contexts.set(this.top.frameRef, this.top);
      this.documentRefs.set(topDocument, this.top.frameRef);
    } finally {
      this.state = "active";
    }
    this.emitTop("reset");
    return true;
  }

  public dispose(): void {
    if (this.state !== "active") {
      return;
    }
    this.state = "disposing";
    try {
      this.bumpStructuralRevision();
      this.removeAllRecords();
      this.contexts.clear();
      this.documentRefs.clear();
      this.top = undefined;
    } finally {
      this.state = "disposed";
    }
  }

  private handleLoadByRef(frameRef: string): void {
    if (this.state !== "active") {
      return;
    }
    const record = this.records.get(frameRef);
    if (record) {
      this.handleLoad(record);
    }
  }

  private handleLoad(record: FrameRecord): void {
    const ownership = record.ownership;
    if (
      this.state !== "active" ||
      !record.active ||
      !ownership ||
      this.records.get(record.frameRef) !== record
    ) {
      return;
    }
    this.state = "mutating";
    this.bumpStructuralRevision();
    record.active = false;
    let eventType: "navigated" | "invalidated" | undefined;
    let invalidated: readonly FrameIdentity[] = EMPTY_FRAME_IDENTITIES;
    try {
      if (record.frameEpoch >= this.maxFrameEpoch) {
        this.exhaustedFrameElements.add(ownership.frameElement);
        invalidated = this.removeSubtree(record);
        eventType = "invalidated";
      } else {
        this.removeContextOwnership(record);
        record.document = undefined;
        invalidated = this.removeDescendants(record.frameRef);
        if (this.records.get(record.frameRef) !== record) {
          return;
        }
        const nextDocument = this.inspectDocument(ownership.frameElement);
        if (
          this.records.get(record.frameRef) !== record ||
          record.ownership !== ownership
        ) {
          return;
        }
        record.frameEpoch += 1;
        record.document = nextDocument;
        this.installContext(record);
        record.active = true;
        eventType = "navigated";
      }
    } finally {
      this.state = "active";
    }
    if (eventType) {
      this.emit(eventType, record, invalidated);
    }
  }

  private installContext(record: FrameRecord): void {
    const ownership = record.ownership;
    if (!record.document || !ownership) {
      return;
    }
    const currentOwner = this.documentRefs.get(record.document);
    if (currentOwner !== undefined && currentOwner !== record.frameRef) {
      record.document = undefined;
      return;
    }
    const currentContext = this.contexts.get(record.frameRef);
    if (currentContext && !sameFrameIdentity(currentContext, record)) {
      record.document = undefined;
      return;
    }
    const context = Object.freeze({
      frameRef: record.frameRef,
      frameEpoch: record.frameEpoch,
      documentEpoch: record.documentEpoch,
      document: record.document,
      parentFrameRef: record.parentFrameRef,
      frameElement: ownership.frameElement,
    });
    this.contexts.set(context.frameRef, context);
    this.documentRefs.set(context.document, context.frameRef);
  }

  private removeContextOwnership(record: FrameRecord): void {
    const context = this.contexts.get(record.frameRef);
    if (context && sameFrameIdentity(context, record)) {
      this.contexts.delete(record.frameRef);
    }
    if (
      record.document &&
      this.documentRefs.get(record.document) === record.frameRef
    ) {
      this.documentRefs.delete(record.document);
    }
  }

  private describe(record: FrameRecord): FrameDescription | undefined {
    if (!record.active) {
      return undefined;
    }
    if (!record.document) {
      return Object.freeze({
        kind: "inaccessible" as const,
        locked: true as const,
        frameRef: record.frameRef,
        frameEpoch: record.frameEpoch,
        documentEpoch: this.documentEpoch,
        parentFrameRef: record.parentFrameRef,
      });
    }
    const context = this.contexts.get(record.frameRef);
    if (!context) {
      return undefined;
    }
    return Object.freeze({ kind: "accessible" as const, ...context });
  }

  private inspectDocument(frameElement: HTMLIFrameElement): Document | undefined {
    try {
      const document = frameElement.contentDocument;
      if (!document) {
        return undefined;
      }
      const contentWindow = frameElement.contentWindow;
      if (!contentWindow || contentWindow.document !== document) {
        return undefined;
      }
      return document;
    } catch {
      return undefined;
    }
  }

  private removeDescendants(parentFrameRef: string): readonly FrameIdentity[] {
    const records = this.collectDescendants(parentFrameRef);
    return this.removeRecords(records);
  }

  private removeAllRecords(): void {
    this.removeRecords([...this.records.values()]);
  }

  private removeSubtree(record: FrameRecord): readonly FrameIdentity[] {
    return this.removeRecords([record, ...this.collectDescendants(record.frameRef)]);
  }

  private collectDescendants(parentFrameRef: string): FrameRecord[] {
    const descendants: FrameRecord[] = [];
    const visit = (parentRef: string): void => {
      for (const candidate of this.records.values()) {
        if (candidate.parentFrameRef === parentRef) {
          descendants.push(candidate);
          visit(candidate.frameRef);
        }
      }
    };
    visit(parentFrameRef);
    return descendants;
  }

  private removeRecords(records: readonly FrameRecord[]): readonly FrameIdentity[] {
    if (records.length === 0) {
      return EMPTY_FRAME_IDENTITIES;
    }
    const unique = records.filter(
      (record, index) => records.indexOf(record) === index && this.records.get(record.frameRef) === record,
    );
    if (unique.length === 0) {
      return EMPTY_FRAME_IDENTITIES;
    }
    const invalidated = Object.freeze(unique.map((record) => freezeIdentity(record)));
    const detachments: FrameListenerDetachment[] = [];
    for (const record of unique) {
      record.active = false;
      const ownership = record.ownership;
      this.records.delete(record.frameRef);
      if (ownership) {
        this.recordByElement.delete(ownership.frameElement);
        detachments.push({
          access: ownership.access,
          onLoad: ownership.onLoad,
        });
      }
      this.removeContextOwnership(record);
      record.document = undefined;
      record.ownership = undefined;
    }
    for (const detachment of detachments.reverse()) {
      tryRemoveLoadListener(detachment);
    }
    return invalidated;
  }

  private reserveFrameRef(): string {
    if (!Number.isSafeInteger(this.nextFrameRef)) {
      throw new Error("FrameRegistry reference space exhausted");
    }
    return `frame-${this.nextFrameRef}`;
  }

  private bumpStructuralRevision(): void {
    this.structuralRevision += 1;
  }

  private createTopContext(document: Document, frameEpoch: number): FrameContext {
    return Object.freeze({
      frameRef: "frame-1",
      frameEpoch,
      documentEpoch: this.documentEpoch,
      document,
    });
  }

  private emit(
    type: FrameLifecycleType,
    record: FrameRecord,
    invalidated?: readonly FrameIdentity[],
    accessible = record.document !== undefined,
  ): void {
    this.emitEvent({
      type,
      frameRef: record.frameRef,
      frameEpoch: record.frameEpoch,
      documentEpoch: this.documentEpoch,
      parentFrameRef: record.parentFrameRef,
      accessible,
      ...(invalidated ? { invalidated } : {}),
    });
  }

  private emitTop(type: FrameLifecycleType): void {
    const top = this.top;
    if (!top) {
      return;
    }
    this.emitEvent({
      type,
      frameRef: top.frameRef,
      frameEpoch: top.frameEpoch,
      documentEpoch: top.documentEpoch,
      accessible: true,
    });
  }

  private emitEvent(event: FrameLifecycleEvent): void {
    if (!this.onLifecycle) {
      return;
    }
    try {
      this.onLifecycle(Object.freeze(event));
    } catch {
      // Lifecycle observers must not disrupt page-frame bookkeeping.
    }
  }
}

function freezeIdentity(identity: FrameIdentity): FrameIdentity {
  return Object.freeze({
    frameRef: identity.frameRef,
    frameEpoch: identity.frameEpoch,
    documentEpoch: identity.documentEpoch,
  });
}

function tryRemoveLoadListener(detachment: FrameListenerDetachment): boolean {
  try {
    detachment.access.removeLoadListener(detachment.onLoad);
    return true;
  } catch {
    // Maps remain authoritative even if a hostile event target rejects cleanup.
    return false;
  }
}

type GeometryAuthority = () => boolean;

interface GeometryRead<T> {
  readonly value: T;
}

function readGeometryValue<T>(
  read: () => T,
  isAuthoritative: GeometryAuthority,
): GeometryRead<T> | undefined {
  if (!isAuthoritative()) {
    return undefined;
  }
  try {
    const value = read();
    return isAuthoritative() ? { value } : undefined;
  } catch {
    return undefined;
  }
}

function readFrameOffset(
  access: FrameElementAccess,
  isAuthoritative: GeometryAuthority,
): { x: number; y: number } | undefined {
  const frameElement = access.frameElement;
  const rectRead = readGeometryValue(
    () => access.getBoundingClientRect(),
    isAuthoritative,
  );
  if (!rectRead || !isObject(rectRead.value)) {
    return undefined;
  }
  const rect = rectRead.value;
  const rectX = readGeometryValue(() => rect.x, isAuthoritative);
  const rectY = readGeometryValue(() => rect.y, isAuthoritative);
  const rectLeft = readGeometryValue(() => rect.left, isAuthoritative);
  const rectTop = readGeometryValue(() => rect.top, isAuthoritative);
  const rectRight = readGeometryValue(() => rect.right, isAuthoritative);
  const rectBottom = readGeometryValue(() => rect.bottom, isAuthoritative);
  const rectWidth = readGeometryValue(() => rect.width, isAuthoritative);
  const rectHeight = readGeometryValue(() => rect.height, isAuthoritative);
  const clientLeft = readGeometryValue(() => frameElement.clientLeft, isAuthoritative);
  const clientTop = readGeometryValue(() => frameElement.clientTop, isAuthoritative);
  const offsetWidth = readGeometryValue(() => frameElement.offsetWidth, isAuthoritative);
  const offsetHeight = readGeometryValue(() => frameElement.offsetHeight, isAuthoritative);
  if (
    !rectX ||
    !rectY ||
    !rectLeft ||
    !rectTop ||
    !rectRight ||
    !rectBottom ||
    !rectWidth ||
    !rectHeight ||
    !clientLeft ||
    !clientTop ||
    !offsetWidth ||
    !offsetHeight ||
    !Number.isFinite(rectX.value) ||
    !Number.isFinite(rectY.value) ||
    !Number.isFinite(rectLeft.value) ||
    !Number.isFinite(rectTop.value) ||
    !Number.isFinite(rectRight.value) ||
    !Number.isFinite(rectBottom.value) ||
    !isFiniteNonNegative(rectWidth.value) ||
    !isFiniteNonNegative(rectHeight.value) ||
    !isFiniteNonNegative(clientLeft.value) ||
    !isFiniteNonNegative(clientTop.value) ||
    !isFiniteNonNegative(offsetWidth.value) ||
    !isFiniteNonNegative(offsetHeight.value) ||
    Math.abs(rectWidth.value - offsetWidth.value) > GEOMETRY_DIMENSION_TOLERANCE ||
    Math.abs(rectHeight.value - offsetHeight.value) > GEOMETRY_DIMENSION_TOLERANCE ||
    !hasUntransformedAncestry(frameElement, isAuthoritative)
  ) {
    return undefined;
  }
  const x = rectLeft.value + clientLeft.value;
  const y = rectTop.value + clientTop.value;
  return (
    isAuthoritative() &&
    Number.isFinite(x) &&
    Number.isFinite(y)
  ) ? { x, y } : undefined;
}

function hasUntransformedAncestry(
  frameElement: HTMLIFrameElement,
  isAuthoritative: GeometryAuthority,
): boolean {
  const ownerDocumentRead = readGeometryValue(
    () => frameElement.ownerDocument,
    isAuthoritative,
  );
  if (!ownerDocumentRead || !isObject(ownerDocumentRead.value)) {
    return false;
  }
  const ownerDocument = ownerDocumentRead.value;
  const defaultViewRead = readGeometryValue(
    () => ownerDocument.defaultView,
    isAuthoritative,
  );
  if (!defaultViewRead || !isObject(defaultViewRead.value)) {
    return false;
  }
  const defaultView = defaultViewRead.value;
  const getComputedStyleRead = readGeometryValue(
    () => defaultView.getComputedStyle,
    isAuthoritative,
  );
  if (!getComputedStyleRead || typeof getComputedStyleRead.value !== "function") {
    return false;
  }
  const getComputedStyle = getComputedStyleRead.value;

  const seen = new Set<object>();
  let current: object = frameElement;
  for (let depth = 0; depth < MAX_GEOMETRY_ANCESTORS; depth += 1) {
    if (!isAuthoritative() || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const styleRead = readGeometryValue(
      () => getComputedStyle.call(defaultView, current as Element),
      isAuthoritative,
    );
    if (
      !styleRead ||
      !isObject(styleRead.value) ||
      !hasNeutralGeometryStyle(styleRead.value, isAuthoritative)
    ) {
      return false;
    }
    const assignedSlotRead = readGeometryValue(
      () => (current as { readonly assignedSlot?: unknown }).assignedSlot,
      isAuthoritative,
    );
    if (!assignedSlotRead) {
      return false;
    }
    const assignedSlot = assignedSlotRead.value;
    if (assignedSlot !== null) {
      if (!isObject(assignedSlot)) {
        return false;
      }
      current = assignedSlot;
      continue;
    }
    const parentElementRead = readGeometryValue(
      () => (current as { readonly parentElement?: unknown }).parentElement,
      isAuthoritative,
    );
    if (!parentElementRead) {
      return false;
    }
    const parentElement = parentElementRead.value;
    if (parentElement !== null) {
      if (!isObject(parentElement)) {
        return false;
      }
      current = parentElement;
      continue;
    }

    const getRootNodeRead = readGeometryValue(
      () => (current as { readonly getRootNode?: unknown }).getRootNode,
      isAuthoritative,
    );
    const getRootNode = getRootNodeRead?.value;
    if (typeof getRootNode !== "function") {
      return false;
    }
    const rootRead = readGeometryValue(
      () => getRootNode.call(current) as unknown,
      isAuthoritative,
    );
    if (!rootRead) {
      return false;
    }
    const root = rootRead.value;
    if (root === ownerDocument) {
      return isAuthoritative();
    }
    if (!isObject(root)) {
      return false;
    }
    const modeRead = readGeometryValue(
      () => (root as { readonly mode?: unknown }).mode,
      isAuthoritative,
    );
    if (!modeRead || modeRead.value !== "open") {
      return false;
    }
    const hostRead = readGeometryValue(
      () => (root as { readonly host?: unknown }).host,
      isAuthoritative,
    );
    if (!hostRead || !isObject(hostRead.value)) {
      return false;
    }
    current = hostRead.value;
  }
  return false;
}

function hasNeutralGeometryStyle(
  style: object,
  isAuthoritative: GeometryAuthority,
): boolean {
  const values = style as Record<string, unknown>;
  const transform = readGeometryValue(() => values.transform, isAuthoritative);
  const zoom = readGeometryValue(() => values.zoom, isAuthoritative);
  const translate = readGeometryValue(() => values.translate, isAuthoritative);
  const rotate = readGeometryValue(() => values.rotate, isAuthoritative);
  const scale = readGeometryValue(() => values.scale, isAuthoritative);
  const perspective = readGeometryValue(() => values.perspective, isAuthoritative);
  const offsetPath = readGeometryValue(() => values.offsetPath, isAuthoritative);
  const motionPath = readGeometryValue(() => values.motionPath, isAuthoritative);
  return (
    !!transform &&
    !!zoom &&
    !!translate &&
    !!rotate &&
    !!scale &&
    !!perspective &&
    !!offsetPath &&
    !!motionPath &&
    transform.value === "none" &&
    isUnitZoom(zoom.value) &&
    isNeutralTranslate(translate.value) &&
    isNeutralRotate(rotate.value) &&
    isNeutralScale(scale.value) &&
    isNoneStyleValue(perspective.value) &&
    isNoneStyleValue(offsetPath.value) &&
    isNoneStyleValue(motionPath.value)
  );
}

function isUnitZoom(value: unknown): boolean {
  if (value === undefined || value === 1) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "normal" || normalized === "1" || normalized === "100%";
}

function isNeutralTranslate(value: unknown): boolean {
  const normalized = normalizeOptionalStyleValue(value);
  if (normalized === undefined || normalized === "none") {
    return true;
  }
  const components = normalized.split(/\s+/);
  return (
    components.length >= 1 &&
    components.length <= 3 &&
    components.every(isZeroLengthOrPercentage)
  );
}

function isNeutralRotate(value: unknown): boolean {
  const normalized = normalizeOptionalStyleValue(value);
  if (normalized === undefined || normalized === "none") {
    return true;
  }
  const components = normalized.split(/\s+/);
  const angle = components.at(-1);
  if (!angle || !isZeroAngle(angle)) {
    return false;
  }
  if (components.length === 1) {
    return true;
  }
  if (components.length === 2) {
    return /^(?:x|y|z)$/.test(components[0]);
  }
  if (components.length !== 4) {
    return false;
  }
  const axis = components.slice(0, 3).map(Number);
  return axis.every(Number.isFinite) && axis.some((component) => component !== 0);
}

function isNeutralScale(value: unknown): boolean {
  const normalized = normalizeOptionalStyleValue(value);
  if (normalized === undefined || normalized === "none") {
    return true;
  }
  const components = normalized.split(/\s+/);
  return (
    components.length >= 1 &&
    components.length <= 3 &&
    components.every(isUnitScaleComponent)
  );
}

function isNoneStyleValue(value: unknown): boolean {
  const normalized = normalizeOptionalStyleValue(value);
  return normalized === undefined || normalized === "none";
}

function normalizeOptionalStyleValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return "<invalid>";
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

function isZeroLengthOrPercentage(value: string): boolean {
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px|%)?$/.test(value);
}

function isZeroAngle(value: string): boolean {
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:deg|grad|rad|turn)?$/.test(value);
}

function isUnitScaleComponent(value: string): boolean {
  const percentage = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/.exec(value);
  if (percentage) {
    return Number(percentage[1]) === 100;
  }
  const number = Number(value);
  return value !== "" && Number.isFinite(number) && number === 1;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function captureFrameElementAccess(value: unknown): FrameElementAccess | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    const frameElement = value as HTMLIFrameElement;
    const addEventListener = frameElement.addEventListener;
    const removeEventListener = frameElement.removeEventListener;
    const getBoundingClientRect = frameElement.getBoundingClientRect;
    if (
      typeof addEventListener !== "function" ||
      typeof removeEventListener !== "function" ||
      typeof getBoundingClientRect !== "function"
    ) {
      return undefined;
    }
    return Object.freeze({
      frameElement,
      addLoadListener: (listener: EventListener) => {
        addEventListener.call(frameElement, "load", listener);
      },
      removeLoadListener: (listener: EventListener) => {
        removeEventListener.call(frameElement, "load", listener);
      },
      getBoundingClientRect: () => getBoundingClientRect.call(frameElement),
    });
  } catch {
    return undefined;
  }
}

function snapshotFrameIdentity(
  value: FrameIdentity,
  isAuthoritative: () => boolean,
): FrameIdentity | undefined {
  try {
    const frameRef = value.frameRef;
    if (!isAuthoritative() || !isFrameRef(frameRef)) {
      return undefined;
    }
    const frameEpoch = value.frameEpoch;
    if (!isAuthoritative() || !isNonNegativeSafeInteger(frameEpoch)) {
      return undefined;
    }
    const documentEpoch = value.documentEpoch;
    if (!isAuthoritative() || !isNonNegativeSafeInteger(documentEpoch)) {
      return undefined;
    }
    return Object.freeze({ frameRef, frameEpoch, documentEpoch });
  } catch {
    return undefined;
  }
}

function sameFrameIdentity(left: FrameIdentity, right: FrameIdentity): boolean {
  return (
    left.frameRef === right.frameRef &&
    left.frameEpoch === right.frameEpoch &&
    left.documentEpoch === right.documentEpoch
  );
}

function isFrameRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REF_LENGTH && /^frame-[1-9]\d*$/.test(value);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
