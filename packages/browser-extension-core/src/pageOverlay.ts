import {
  hasNeutralGeometryStyle,
  type FrameContext,
  type FrameIdentity,
  type TopViewportRect,
  type ViewportRect,
} from "./frameRegistry.js";

export interface PageOverlayFrameRegistry {
  getContext(frameRef: string): FrameContext | undefined;
  toTopViewport(
    identity: FrameIdentity,
    rect: ViewportRect,
  ): TopViewportRect | undefined;
}

export interface PageOverlayViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface PageOverlayOptions {
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly getComputedStyle?: (element: Element) => CSSStyleDeclaration;
  readonly getViewportSize?: (document: Document) => PageOverlayViewportSize | undefined;
  readonly getEventTarget?: (document: Document) => EventTarget | undefined;
  readonly addEventListener?: (
    target: EventTarget,
    type: OverlayEventType,
    listener: EventListener,
  ) => void;
  readonly removeEventListener?: (
    target: EventTarget,
    type: OverlayEventType,
    listener: EventListener,
  ) => void;
}

type OverlayEventType = "scroll" | "resize";
type RequestFrame = NonNullable<PageOverlayOptions["requestAnimationFrame"]>;
type CancelFrame = NonNullable<PageOverlayOptions["cancelAnimationFrame"]>;
type GetStyle = NonNullable<PageOverlayOptions["getComputedStyle"]>;
type GetViewportSize = NonNullable<PageOverlayOptions["getViewportSize"]>;
type GetEventTarget = NonNullable<PageOverlayOptions["getEventTarget"]>;
type AddListener = NonNullable<PageOverlayOptions["addEventListener"]>;
type RemoveListener = NonNullable<PageOverlayOptions["removeEventListener"]>;
type RenderOutcome = "published" | "failed" | "stale";

interface BoxEdges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

interface BoxModel {
  readonly margin: BoxEdges;
  readonly border: BoxEdges;
  readonly padding: BoxEdges;
  readonly decoration: FragmentDecoration;
}

type PhysicalSide = keyof BoxEdges;

interface FragmentDecoration {
  readonly breakMode: "clone" | "slice";
  readonly inlineStart: PhysicalSide;
  readonly inlineEnd: PhysicalSide;
  readonly supportsMultipleRects: boolean;
}

interface LayerGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface OverlayListener {
  readonly target: EventTarget;
  readonly type: OverlayEventType;
  readonly listener: EventListener;
}

interface HostAuthority {
  readonly revision: number;
  readonly document: Document;
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly root: HTMLElement;
}

interface RenderAuthority extends HostAuthority {
  readonly target: Element;
  readonly identity: FrameIdentity;
  readonly frameRegistry: PageOverlayFrameRegistry;
}

interface ExternalRead<T> {
  readonly value: T;
}

interface AuthorityReader {
  <T>(operation: () => T): ExternalRead<T> | undefined;
}

interface FrameContextSnapshot extends FrameIdentity {
  readonly document: Document;
  readonly parentFrameRef?: string;
}

const BOX_COLORS = Object.freeze({
  margin: "rgba(246, 178, 107, 0.55)",
  border: "rgba(255, 229, 153, 0.6)",
  padding: "rgba(147, 196, 125, 0.55)",
  content: "rgba(111, 168, 220, 0.55)",
});

const LABEL_HEIGHT = 22;
const LABEL_MAX_WIDTH = 320;
const LABEL_MAX_TEXT_LENGTH = 180;
const LABEL_MAX_TOKEN_LENGTH = 64;
const LABEL_MAX_CLASSES = 4;
const LABEL_CLASS_SCAN_LIMIT = 32;
const MAX_FRAGMENT_STYLE_KEYWORD_LENGTH = 32;
const MAX_FRAGMENT_COUNT = 64;
const MAX_VISUAL_NODE_COUNT = MAX_FRAGMENT_COUNT * 4 + 1;
const MAX_FRAME_ANCESTORS = 512;
const MAX_OWNERSHIP_ANCESTORS = 512;
const MAX_TARGET_GEOMETRY_ANCESTORS = 128;

export class PageOverlay {
  private readonly ownedNodes = new WeakSet<Node>();
  private topDocument: Document | undefined;
  private frameRegistry: PageOverlayFrameRegistry | undefined;
  private host: HTMLElement | undefined;
  private shadow: ShadowRoot | undefined;
  private root: HTMLElement | undefined;
  private published: HTMLElement | undefined;
  private requestFrame: RequestFrame | undefined;
  private cancelFrame: CancelFrame | undefined;
  private getStyle: GetStyle | undefined;
  private getViewportSize: GetViewportSize | undefined;
  private getEventTarget: GetEventTarget | undefined;
  private addListener: AddListener | undefined;
  private removeListener: RemoveListener | undefined;
  private readonly listeners: OverlayListener[] = [];
  private target: Element | undefined;
  private identity: FrameIdentity | undefined;
  private scheduledToken: object | undefined;
  private pendingFrame: number | undefined;
  private revision = 0;
  private disposed = false;

  public constructor(
    topDocument: Document,
    frameRegistry: PageOverlayFrameRegistry,
    options: PageOverlayOptions = {},
  ) {
    this.topDocument = topDocument;
    this.frameRegistry = frameRegistry;
    this.requestFrame = options.requestAnimationFrame ?? ((callback) => {
      const view = this.topDocument?.defaultView;
      if (!view) throw new Error("requestAnimationFrame is unavailable");
      return view.requestAnimationFrame(callback);
    });
    this.cancelFrame = options.cancelAnimationFrame ?? ((handle) => {
      this.topDocument?.defaultView?.cancelAnimationFrame(handle);
    });
    this.getStyle = options.getComputedStyle ?? ((element) => {
      const view = element.ownerDocument.defaultView;
      if (!view) throw new Error("getComputedStyle is unavailable");
      return view.getComputedStyle(element);
    });
    this.getViewportSize = options.getViewportSize ?? ((document) => {
      const view = document.defaultView;
      const width = document.documentElement.clientWidth || view?.innerWidth;
      const height = document.documentElement.clientHeight || view?.innerHeight;
      return typeof width === "number" && typeof height === "number"
        ? { width, height }
        : undefined;
    });
    this.getEventTarget = options.getEventTarget ?? ((document) => (
      document.defaultView ?? undefined
    ));
    this.addListener = options.addEventListener ?? ((target, type, listener) => {
      target.addEventListener(type, listener, { capture: true, passive: true });
    });
    this.removeListener = options.removeEventListener ?? ((target, type, listener) => {
      target.removeEventListener(type, listener, { capture: true });
    });
    this.createHost(topDocument);
  }

  public show(element: Element, frameIdentity: FrameIdentity): void {
    if (this.disposed || !this.host || !this.root) return;
    const revision = this.bumpRevision();
    this.target = element;
    this.identity = undefined;
    const previousListeners = this.takeListeners();
    this.removeRegistrations(previousListeners);
    if (!this.isShowAuthority(revision, element)) return;
    const identity = snapshotIdentity(
      frameIdentity,
      () => this.isShowAuthority(revision, element),
    );
    if (!identity) {
      if (this.isShowAuthority(revision, element)) this.clear();
      return;
    }
    this.identity = identity;
    if (!this.isAuthorityRevision(revision, element, identity)) return;
    this.scheduleRender();
  }

  public clear(): void {
    if (this.disposed) return;
    const revision = this.bumpRevision();
    this.releaseCurrent(revision);
  }

  public ownsNode(node: Node): boolean {
    if (!isObject(node)) return false;
    const seen = new Set<object>();
    let current: object = node;
    try {
      const ownerDocument = (node as { readonly ownerDocument?: unknown }).ownerDocument;
      if (!isObject(ownerDocument)) return false;
      for (let depth = 0; depth < MAX_OWNERSHIP_ANCESTORS; depth += 1) {
        if (seen.has(current)) return false;
        seen.add(current);
        if (this.ownedNodes.has(current as Node)) {
          return (current as { readonly ownerDocument?: unknown }).ownerDocument ===
            ownerDocument;
        }
        const parentNode = (current as { readonly parentNode?: unknown }).parentNode;
        if (parentNode === null || !isObject(parentNode)) return false;
        current = parentNode;
      }
      return false;
    } catch {
      return false;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const revision = this.bumpRevision();
    const host = this.host;
    this.releaseCurrent(revision);

    this.topDocument = undefined;
    this.frameRegistry = undefined;
    this.host = undefined;
    this.shadow = undefined;
    this.root = undefined;
    this.published = undefined;
    this.requestFrame = undefined;
    this.cancelFrame = undefined;
    this.getStyle = undefined;
    this.getViewportSize = undefined;
    this.getEventTarget = undefined;
    this.addListener = undefined;
    this.removeListener = undefined;

    try {
      host?.remove();
    } catch {
      // Disposal remains authoritative if a hostile DOM rejects removal.
    }
  }

  private createHost(document: Document): void {
    let host: HTMLElement | undefined;
    try {
      host = document.createElement("div");
      this.ownedNodes.add(host);
      configureHost(host);
      const shadowRoot = host.attachShadow({ mode: "closed" });
      this.ownedNodes.add(shadowRoot);
      const root = document.createElement("div");
      this.ownedNodes.add(root);
      configureRoot(root);
      shadowRoot.append(root);
      document.documentElement.append(host);
      this.host = host;
      this.shadow = shadowRoot;
      this.root = root;
    } catch {
      try {
        host?.remove();
      } catch {
        // Constructor failure leaves no usable overlay authority.
      }
      this.host = undefined;
      this.shadow = undefined;
      this.root = undefined;
    }
  }

  private scheduleRender(): void {
    const target = this.target;
    const identity = this.identity;
    const requestFrame = this.requestFrame;
    const cancelFrame = this.cancelFrame;
    if (
      this.disposed ||
      !target ||
      !identity ||
      !requestFrame ||
      this.scheduledToken
    ) {
      return;
    }
    const token = {};
    this.scheduledToken = token;
    let callbackRan = false;
    try {
      const handle = requestFrame((timestamp) => {
        void timestamp;
        callbackRan = true;
        if (this.scheduledToken !== token) return;
        this.scheduledToken = undefined;
        this.pendingFrame = undefined;
        this.render();
      });
      if (this.scheduledToken === token) {
        this.pendingFrame = handle;
      } else if (!callbackRan && cancelFrame) {
        try {
          cancelFrame(handle);
        } catch {
          // The token is already non-authoritative.
        }
      }
    } catch {
      if (this.scheduledToken === token) {
        this.scheduledToken = undefined;
        this.pendingFrame = undefined;
        if (this.target === target && this.identity === identity) {
          this.clear();
        } else {
          this.scheduleRender();
        }
      }
    }
  }

  private render(): void {
    const authority = this.captureAuthority();
    if (!authority) return;
    let outcome: RenderOutcome;
    try {
      outcome = this.renderCurrent(authority);
    } catch {
      outcome = this.isAuthority(authority) ? "failed" : "stale";
    }
    if (outcome === "failed" && this.isAuthority(authority)) {
      this.clear();
    }
  }

  private renderCurrent(authority: RenderAuthority): RenderOutcome {
    const read: AuthorityReader = <T>(operation: () => T) => (
      this.readExternal(authority, operation)
    );
    if (!this.ensureHostAttached(authority, read)) return this.currentOutcome(authority);
    const targetContext = this.readTargetContext(authority, read);
    if (!targetContext) return this.currentOutcome(authority);

    const getStyle = this.getStyle;
    if (!getStyle) return "failed";
    const styleRead = read(() => getStyle(authority.target));
    if (!styleRead) return "stale";
    if (!isObject(styleRead.value)) return "failed";
    if (!this.hasNeutralTargetAncestry(
      authority,
      targetContext.document,
      styleRead.value,
      getStyle,
      read,
    )) {
      return this.currentOutcome(authority);
    }
    const boxModel = readBoxModel(styleRead.value, read);
    if (!boxModel) return this.currentOutcome(authority);

    const rectListRead = read(() => authority.target.getClientRects());
    if (!rectListRead || !isObject(rectListRead.value)) {
      return rectListRead ? "failed" : "stale";
    }
    const lengthRead = read(() => rectListRead.value.length);
    if (!lengthRead) return "stale";
    const rectCount = lengthRead.value;
    if (
      !Number.isSafeInteger(rectCount) ||
      rectCount < 1 ||
      rectCount > MAX_FRAGMENT_COUNT ||
      rectCount * 4 + 1 > MAX_VISUAL_NODE_COUNT
    ) {
      return "failed";
    }
    if (rectCount > 1 && !boxModel.decoration.supportsMultipleRects) {
      return "failed";
    }

    const boundingRectRead = read(() => authority.target.getBoundingClientRect());
    if (!boundingRectRead) return "stale";
    const sourceBounds = readViewportRect(boundingRectRead.value, read);
    if (!sourceBounds) return this.currentOutcome(authority);
    const translatedBoundsRead = read(() => (
      authority.frameRegistry.toTopViewport(authority.identity, sourceBounds)
    ));
    if (!translatedBoundsRead) return "stale";
    const translatedBounds = readTopViewportRect(translatedBoundsRead.value, read);
    if (
      !translatedBounds ||
      translatedBounds.width !== sourceBounds.width ||
      translatedBounds.height !== sourceBounds.height
    ) {
      return this.currentOutcome(authority);
    }
    const offsetX = translatedBounds.x - sourceBounds.x;
    const offsetY = translatedBounds.y - sourceBounds.y;
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return "failed";

    const fragmentGeometries: Array<
      Record<"margin" | "border" | "padding" | "content", LayerGeometry>
    > = [];
    for (let index = 0; index < rectCount; index += 1) {
      const rectRead = read(() => rectListRead.value[index]);
      if (!rectRead) return "stale";
      const sourceRect = readViewportRect(rectRead.value, read);
      if (!sourceRect) return this.currentOutcome(authority);
      const translated = offsetViewportRect(sourceRect, offsetX, offsetY);
      if (!translated) return "failed";
      const geometries = createLayerGeometries(
        translated,
        boxModel,
        index,
        rectCount,
      );
      if (!Object.values(geometries).every(isValidLayerGeometry)) return "failed";
      fragmentGeometries.push(geometries);
    }

    const bounds: LayerGeometry = {
      left: translatedBounds.x,
      top: translatedBounds.y,
      width: translatedBounds.width,
      height: translatedBounds.height,
    };
    const labelText = readLabelText(
      authority.target,
      bounds.width,
      bounds.height,
      read,
    );
    if (labelText === undefined) return this.currentOutcome(authority);

    const viewportRead = this.getViewportSize
      ? read(() => this.getViewportSize?.(authority.document))
      : { value: undefined };
    if (!viewportRead) return "stale";
    const viewport = readViewportSize(viewportRead.value, read);
    if (!this.isAuthority(authority)) return "stale";

    const container = this.createOwnedElement(authority, read);
    if (!container) return this.currentOutcome(authority);
    if (!this.mutateExternal(authority, () => configureRenderContainer(container))) {
      this.removeContainer(container);
      return "stale";
    }
    const visualNodes: HTMLElement[] = [];
    for (const geometries of fragmentGeometries) {
      for (const box of ["margin", "border", "padding", "content"] as const) {
        const layer = this.createOwnedElement(authority, read);
        if (!layer) {
          this.removeContainer(container);
          return this.currentOutcome(authority);
        }
        if (!this.mutateExternal(authority, () => {
          configureLayer(layer, box, geometries[box]);
        })) {
          this.removeContainer(container);
          return "stale";
        }
        visualNodes.push(layer);
      }
    }

    const label = this.createOwnedElement(authority, read);
    if (!label) {
      this.removeContainer(container);
      return this.currentOutcome(authority);
    }
    if (!this.mutateExternal(authority, () => {
      configureLabel(label);
      label.textContent = labelText;
      positionLabel(label, bounds, viewport);
    })) {
      this.removeContainer(container);
      return "stale";
    }
    visualNodes.push(label);
    if (!this.mutateExternal(authority, () => container.append(...visualNodes))) {
      this.removeContainer(container);
      return "stale";
    }

    const listenerOutcome = this.refreshListeners(authority, read);
    if (listenerOutcome !== "published") {
      this.removeContainer(container);
      return listenerOutcome;
    }
    const finalContext = this.readTargetContext(authority, read);
    if (!finalContext || finalContext.document !== targetContext.document) {
      this.removeContainer(container);
      return this.currentOutcome(authority);
    }
    return this.publish(authority, container, read);
  }

  private captureAuthority(): RenderAuthority | undefined {
    const target = this.target;
    const identity = this.identity;
    const document = this.topDocument;
    const frameRegistry = this.frameRegistry;
    const host = this.host;
    const shadow = this.shadow;
    const root = this.root;
    if (
      this.disposed ||
      !target ||
      !identity ||
      !document ||
      !frameRegistry ||
      !host ||
      !shadow ||
      !root
    ) {
      return undefined;
    }
    return {
      revision: this.revision,
      target,
      identity,
      document,
      frameRegistry,
      host,
      shadow,
      root,
    };
  }

  private isAuthority(authority: RenderAuthority): boolean {
    return (
      !this.disposed &&
      this.revision === authority.revision &&
      this.target === authority.target &&
      this.identity === authority.identity &&
      this.topDocument === authority.document &&
      this.frameRegistry === authority.frameRegistry &&
      this.host === authority.host &&
      this.shadow === authority.shadow &&
      this.root === authority.root
    );
  }

  private currentOutcome(authority: RenderAuthority): "failed" | "stale" {
    return this.isAuthority(authority) ? "failed" : "stale";
  }

  private readExternal<T>(
    authority: RenderAuthority,
    operation: () => T,
  ): ExternalRead<T> | undefined {
    if (!this.isAuthority(authority)) return undefined;
    const value = operation();
    return this.isAuthority(authority) ? { value } : undefined;
  }

  private mutateExternal(authority: RenderAuthority, operation: () => void): boolean {
    if (!this.isAuthority(authority)) return false;
    operation();
    return this.isAuthority(authority);
  }

  private ensureHostAttached(
    authority: HostAuthority,
    read: AuthorityReader,
  ): boolean {
    const documentElementRead = read(() => authority.document.documentElement);
    const shadowHostRead = read(() => authority.shadow.host);
    const shadowModeRead = read(() => authority.shadow.mode);
    if (
      !documentElementRead ||
      !shadowHostRead ||
      !shadowModeRead ||
      shadowHostRead.value !== authority.host ||
      shadowModeRead.value !== "closed"
    ) {
      return false;
    }
    const documentElement = documentElementRead.value;
    const hostParentRead = read(() => authority.host.parentNode);
    const hostOwnerRead = read(() => authority.host.ownerDocument);
    if (!hostParentRead || !hostOwnerRead) return false;
    if (
      hostParentRead.value !== documentElement ||
      hostOwnerRead.value !== authority.document
    ) {
      const appendRead = read(() => documentElement.append(authority.host));
      if (!appendRead) return false;
    }

    const rootParentRead = read(() => authority.root.parentNode);
    const rootOwnerRead = read(() => authority.root.ownerDocument);
    const shadowLengthRead = read(() => authority.shadow.childNodes.length);
    const shadowFirstRead = read(() => authority.shadow.firstChild);
    if (
      !rootParentRead ||
      !rootOwnerRead ||
      !shadowLengthRead ||
      !shadowFirstRead
    ) {
      return false;
    }
    if (
      rootParentRead.value !== authority.shadow ||
      rootOwnerRead.value !== authority.document ||
      shadowLengthRead.value !== 1 ||
      shadowFirstRead.value !== authority.root
    ) {
      const replaceRead = read(() => authority.shadow.replaceChildren(authority.root));
      if (!replaceRead) return false;
    }

    const connectedRead = read(() => authority.host.isConnected);
    const finalHostOwnerRead = read(() => authority.host.ownerDocument);
    const finalShadowOwnerRead = read(() => authority.shadow.ownerDocument);
    const finalRootOwnerRead = read(() => authority.root.ownerDocument);
    const finalHostParentRead = read(() => authority.host.parentNode);
    const finalRootParentRead = read(() => authority.root.parentNode);
    const finalShadowLengthRead = read(() => authority.shadow.childNodes.length);
    const finalShadowFirstRead = read(() => authority.shadow.firstChild);
    return !!connectedRead &&
      connectedRead.value === true &&
      !!finalHostOwnerRead &&
      finalHostOwnerRead.value === authority.document &&
      !!finalShadowOwnerRead &&
      finalShadowOwnerRead.value === authority.document &&
      !!finalRootOwnerRead &&
      finalRootOwnerRead.value === authority.document &&
      !!finalHostParentRead &&
      finalHostParentRead.value === documentElement &&
      !!finalRootParentRead &&
      finalRootParentRead.value === authority.shadow &&
      !!finalShadowLengthRead &&
      finalShadowLengthRead.value === 1 &&
      !!finalShadowFirstRead &&
      finalShadowFirstRead.value === authority.root;
  }

  private createOwnedElement(
    authority: RenderAuthority,
    read: AuthorityReader,
  ): HTMLElement | undefined {
    const elementRead = read(() => authority.document.createElement("div"));
    if (!elementRead) return undefined;
    this.ownedNodes.add(elementRead.value);
    return elementRead.value;
  }

  private readTargetContext(
    authority: RenderAuthority,
    read: AuthorityReader,
  ): FrameContextSnapshot | undefined {
    const contextRead = read(() => (
      authority.frameRegistry.getContext(authority.identity.frameRef)
    ));
    if (!contextRead) return undefined;
    const context = readFrameContext(contextRead.value, read);
    if (!context || !sameIdentity(context, authority.identity)) return undefined;
    const ownerDocumentRead = read(() => authority.target.ownerDocument);
    return ownerDocumentRead?.value === context.document ? context : undefined;
  }

  private hasNeutralTargetAncestry(
    authority: RenderAuthority,
    targetDocument: Document,
    targetStyle: object,
    getStyle: GetStyle,
    read: AuthorityReader,
  ): boolean {
    const seen = new Set<object>();
    let current: object = authority.target;
    let style = targetStyle;
    for (let depth = 0; depth < MAX_TARGET_GEOMETRY_ANCESTORS; depth += 1) {
      if (seen.has(current) || !this.isAuthority(authority)) return false;
      seen.add(current);
      if (
        !hasNeutralGeometryStyle(style, () => this.isAuthority(authority))
      ) {
        return false;
      }

      const assignedSlotRead = read(() => (
        (current as { readonly assignedSlot?: unknown }).assignedSlot
      ));
      if (!assignedSlotRead) return false;
      if (assignedSlotRead.value !== null) {
        if (!isObject(assignedSlotRead.value)) return false;
        current = assignedSlotRead.value;
      } else {
        const parentElementRead = read(() => (
          (current as { readonly parentElement?: unknown }).parentElement
        ));
        if (!parentElementRead) return false;
        if (parentElementRead.value !== null) {
          if (!isObject(parentElementRead.value)) return false;
          current = parentElementRead.value;
        } else {
          const getRootNodeRead = read(() => (
            (current as { readonly getRootNode?: unknown }).getRootNode
          ));
          const getRootNode = getRootNodeRead?.value;
          if (typeof getRootNode !== "function") {
            return false;
          }
          const rootRead = read(() => getRootNode.call(current) as unknown);
          if (!rootRead) return false;
          if (rootRead.value === targetDocument) {
            return this.isAuthority(authority);
          }
          if (!isObject(rootRead.value)) return false;
          const modeRead = read(() => (
            (rootRead.value as { readonly mode?: unknown }).mode
          ));
          const hostRead = read(() => (
            (rootRead.value as { readonly host?: unknown }).host
          ));
          if (
            !modeRead ||
            modeRead.value !== "open" ||
            !hostRead ||
            !isObject(hostRead.value)
          ) {
            return false;
          }
          current = hostRead.value;
        }
      }

      const styleRead = read(() => getStyle(current as Element));
      if (!styleRead || !isObject(styleRead.value)) return false;
      style = styleRead.value;
    }
    return false;
  }

  private refreshListeners(
    authority: RenderAuthority,
    read: AuthorityReader,
  ): RenderOutcome {
    const previous = this.takeListeners();
    this.removeRegistrations(previous);
    if (!this.isAuthority(authority)) return "stale";
    const targets = this.collectEventTargets(authority, read);
    if (!targets) return this.currentOutcome(authority);
    const addListener = this.addListener;
    const removeListener = this.removeListener;
    if (!addListener || !removeListener) return "failed";

    for (const target of targets) {
      for (const type of ["scroll", "resize"] as const) {
        if (!this.isAuthority(authority)) return "stale";
        const listener: EventListener = () => this.scheduleRender();
        const registration = { target, type, listener };
        this.listeners.push(registration);
        try {
          addListener(target, type, listener);
        } catch {
          if (this.isAuthority(authority)) throw new Error("listener registration failed");
          this.removeRegistration(registration, removeListener);
          return "stale";
        }
        if (!this.isAuthority(authority)) {
          this.removeRegistration(registration, removeListener);
          return "stale";
        }
      }
    }
    return "published";
  }

  private collectEventTargets(
    authority: RenderAuthority,
    read: AuthorityReader,
  ): EventTarget[] | undefined {
    const targets: EventTarget[] = [];
    const seenRefs = new Set<string>();
    const seenTargets = new Set<EventTarget>();
    let frameRef: string | undefined = authority.identity.frameRef;
    let first = true;
    for (let depth = 0; frameRef && depth < MAX_FRAME_ANCESTORS; depth += 1) {
      if (seenRefs.has(frameRef)) return undefined;
      seenRefs.add(frameRef);
      const contextRead = read(() => authority.frameRegistry.getContext(frameRef!));
      if (!contextRead) return undefined;
      const context = readFrameContext(contextRead.value, read);
      if (!context) return undefined;
      if (first && !sameIdentity(context, authority.identity)) return undefined;
      first = false;
      const getEventTarget = this.getEventTarget;
      if (!getEventTarget) return undefined;
      const targetRead = read(() => getEventTarget(context.document));
      if (!targetRead || !targetRead.value) return undefined;
      if (!seenTargets.has(targetRead.value)) {
        seenTargets.add(targetRead.value);
        targets.push(targetRead.value);
      }
      frameRef = context.parentFrameRef;
    }
    if (frameRef) return undefined;
    targets.reverse();
    return targets;
  }

  private publish(
    authority: RenderAuthority,
    container: HTMLElement,
    read: AuthorityReader,
  ): RenderOutcome {
    const previous = this.published;
    try {
      if (!this.ensureHostAttached(authority, read)) {
        this.removeContainer(container);
        return this.currentOutcome(authority);
      }
      if (!this.mutateExternal(authority, () => authority.root.append(container))) {
        this.removeContainer(container);
        return "stale";
      }
      if (!this.ensureHostAttached(authority, read)) {
        this.removeContainer(container);
        return this.currentOutcome(authority);
      }
      this.published = container;
      if (!this.mutateExternal(authority, () => {
        setImportantStyle(container, "display", "block");
        setImportantStyle(authority.host, "display", "block");
      })) {
        if (this.published === container) this.published = previous;
        this.removeContainer(container);
        return "stale";
      }
      if (!this.ensureHostAttached(authority, read)) {
        if (this.published === container) this.published = previous;
        this.removeContainer(container);
        return this.currentOutcome(authority);
      }
      if (previous && previous !== container) this.removeContainer(previous);
      return "published";
    } catch {
      if (this.published === container) this.published = previous;
      this.removeContainer(container);
      return this.currentOutcome(authority);
    }
  }

  private releaseCurrent(revision: number): void {
    const token = this.scheduledToken;
    const pendingFrame = this.pendingFrame;
    const cancelFrame = this.cancelFrame;
    const registrations = this.takeListeners();
    const published = this.published;
    const document = this.topDocument;
    const host = this.host;
    const shadow = this.shadow;
    const root = this.root;
    this.scheduledToken = undefined;
    this.pendingFrame = undefined;
    this.target = undefined;
    this.identity = undefined;
    this.published = undefined;

    if (token && pendingFrame !== undefined && cancelFrame) {
      try {
        cancelFrame(pendingFrame);
      } catch {
        // State is already released if cancellation is rejected.
      }
    }
    this.removeRegistrations(registrations);
    if (published) this.removeContainer(published);
    if (this.revision === revision && this.published === undefined && host) {
      try {
        setImportantStyle(host, "display", "none");
      } catch {
        // Removing the published container remains the visibility authority.
      }
      if (document && shadow && root) {
        this.restoreReleasedHost({ revision, document, host, shadow, root });
      }
    }
  }

  private restoreReleasedHost(authority: HostAuthority): void {
    const read: AuthorityReader = <T>(operation: () => T) => {
      if (!this.isReleasedHostAuthority(authority)) return undefined;
      const value = operation();
      return this.isReleasedHostAuthority(authority) ? { value } : undefined;
    };
    let restored = false;
    try {
      restored = this.ensureHostAttached(authority, read);
    } catch {
      // A compromised host is retired below if cleanup authority remains current.
    }
    if (restored || !this.isReleasedHostAuthority(authority)) return;

    this.host = undefined;
    this.shadow = undefined;
    this.root = undefined;
    try {
      setImportantStyle(authority.host, "display", "none");
    } catch {
      // Removal below remains the retirement authority.
    }
    try {
      authority.host.remove();
    } catch {
      // Weak ownership tracking does not retain the retired host.
    }
  }

  private isReleasedHostAuthority(authority: HostAuthority): boolean {
    return (
      !this.disposed &&
      this.revision === authority.revision &&
      this.target === undefined &&
      this.identity === undefined &&
      this.published === undefined &&
      this.topDocument === authority.document &&
      this.host === authority.host &&
      this.shadow === authority.shadow &&
      this.root === authority.root
    );
  }

  private takeListeners(): OverlayListener[] {
    return this.listeners.splice(0);
  }

  private removeRegistrations(registrations: readonly OverlayListener[]): void {
    const removeListener = this.removeListener;
    if (!removeListener) return;
    for (const registration of [...registrations].reverse()) {
      this.removeRegistration(registration, removeListener);
    }
  }

  private removeRegistration(
    registration: OverlayListener,
    removeListener: RemoveListener,
  ): void {
    const index = this.listeners.indexOf(registration);
    if (index >= 0) this.listeners.splice(index, 1);
    try {
      removeListener(registration.target, registration.type, registration.listener);
    } catch {
      // Bookkeeping remains authoritative if a page target rejects cleanup.
    }
  }

  private removeContainer(container: HTMLElement): void {
    try {
      setImportantStyle(container, "display", "none");
    } catch {
      // Removal is still attempted.
    }
    try {
      container.remove();
    } catch {
      // A hidden owned container cannot publish visual state.
    }
  }

  private isShowAuthority(revision: number, target: Element): boolean {
    return (
      !this.disposed &&
      this.revision === revision &&
      this.target === target &&
      this.identity === undefined
    );
  }

  private isAuthorityRevision(
    revision: number,
    target: Element,
    identity: FrameIdentity,
  ): boolean {
    return (
      !this.disposed &&
      this.revision === revision &&
      this.target === target &&
      this.identity === identity
    );
  }

  private bumpRevision(): number {
    this.revision += 1;
    return this.revision;
  }
}

function configureHost(host: HTMLElement): void {
  host.setAttribute("data-pin-op-page-overlay", "");
  setImportantStyle(host, "all", "initial");
  setVisualSafety(host, true);
  setImportantStyle(host, "position", "fixed");
  setImportantStyle(host, "top", "0");
  setImportantStyle(host, "right", "0");
  setImportantStyle(host, "bottom", "0");
  setImportantStyle(host, "left", "0");
  setImportantStyle(host, "z-index", "2147483647");
  setImportantStyle(host, "display", "none");
}

function configureRoot(root: HTMLElement): void {
  root.style.all = "initial";
  setVisualSafety(root);
  root.style.position = "fixed";
  root.style.top = "0";
  root.style.right = "0";
  root.style.bottom = "0";
  root.style.left = "0";
}

function configureRenderContainer(container: HTMLElement): void {
  container.setAttribute("data-pin-op-render", "");
  container.style.all = "initial";
  setVisualSafety(container);
  container.style.position = "absolute";
  container.style.top = "0";
  container.style.right = "0";
  container.style.bottom = "0";
  container.style.left = "0";
  container.style.display = "none";
}

function configureLayer(
  layer: HTMLElement,
  box: keyof typeof BOX_COLORS,
  geometry: LayerGeometry,
): void {
  layer.setAttribute("data-pin-op-box", box);
  layer.style.all = "initial";
  setVisualSafety(layer);
  layer.style.position = "absolute";
  layer.style.backgroundColor = BOX_COLORS[box];
  layer.style.boxSizing = "border-box";
  applyGeometry(layer, geometry);
}

function configureLabel(label: HTMLElement): void {
  label.setAttribute("data-pin-op-label", "");
  label.style.all = "initial";
  setVisualSafety(label);
  label.style.position = "absolute";
  label.style.boxSizing = "border-box";
  label.style.height = `${LABEL_HEIGHT}px`;
  label.style.padding = "2px 4px";
  label.style.overflow = "hidden";
  label.style.color = "#ffffff";
  label.style.backgroundColor = "#202124";
  label.style.font = "12px/18px sans-serif";
  label.style.whiteSpace = "nowrap";
  label.style.textOverflow = "ellipsis";
}

function setVisualSafety(element: HTMLElement, important = false): void {
  element.setAttribute("aria-hidden", "true");
  if (important) {
    setImportantStyle(element, "pointer-events", "none");
    setImportantStyle(element, "direction", "ltr");
    setImportantStyle(element, "unicode-bidi", "isolate");
    return;
  }
  element.style.pointerEvents = "none";
  element.style.direction = "ltr";
  element.style.unicodeBidi = "isolate";
}

function setImportantStyle(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, "important");
}

function readBoxModel(
  style: object,
  read: AuthorityReader,
): BoxModel | undefined {
  const margin = readEdges(style, "margin", true, read);
  const border = readEdges(style, "border", false, read);
  const padding = readEdges(style, "padding", false, read);
  const decoration = readFragmentDecoration(style, read);
  return margin && border && padding && decoration
    ? { margin, border, padding, decoration }
    : undefined;
}

function readFragmentDecoration(
  style: object,
  read: AuthorityReader,
): FragmentDecoration | undefined {
  const values = style as Record<string, unknown>;
  let breakMode = readStyleKeyword(values, "boxDecorationBreak", read);
  if (breakMode === undefined) {
    breakMode = readStyleKeyword(values, "webkitBoxDecorationBreak", read);
  }
  const writingMode = readStyleKeyword(values, "writingMode", read);
  const direction = readStyleKeyword(values, "direction", read);
  const display = readStyleKeyword(values, "display", read);
  if (
    (breakMode !== "slice" && breakMode !== "clone") ||
    (direction !== "ltr" && direction !== "rtl") ||
    display === undefined
  ) {
    return undefined;
  }
  const supportsMultipleRects =
    display === "inline" || display === "inline flow";
  if (writingMode === "horizontal-tb") {
    return {
      breakMode,
      inlineStart: direction === "ltr" ? "left" : "right",
      inlineEnd: direction === "ltr" ? "right" : "left",
      supportsMultipleRects,
    };
  }
  if (writingMode === "vertical-rl" || writingMode === "vertical-lr") {
    return {
      breakMode,
      inlineStart: direction === "ltr" ? "top" : "bottom",
      inlineEnd: direction === "ltr" ? "bottom" : "top",
      supportsMultipleRects,
    };
  }
  return undefined;
}

function readStyleKeyword(
  values: Record<string, unknown>,
  property: string,
  read: AuthorityReader,
): string | undefined {
  const valueRead = read(() => values[property]);
  if (
    !valueRead ||
    typeof valueRead.value !== "string" ||
    valueRead.value.length > MAX_FRAGMENT_STYLE_KEYWORD_LENGTH
  ) {
    return undefined;
  }
  return valueRead.value.trim().toLowerCase();
}

function readEdges(
  style: object,
  prefix: "margin" | "border" | "padding",
  allowNegative: boolean,
  read: AuthorityReader,
): BoxEdges | undefined {
  const suffix = prefix === "border" ? "Width" : "";
  const values = style as Record<string, unknown>;
  const top = read(() => values[`${prefix}Top${suffix}`]);
  const right = read(() => values[`${prefix}Right${suffix}`]);
  const bottom = read(() => values[`${prefix}Bottom${suffix}`]);
  const left = read(() => values[`${prefix}Left${suffix}`]);
  if (!top || !right || !bottom || !left) return undefined;
  const parsed = [top.value, right.value, bottom.value, left.value]
    .map((value) => parseLength(value, allowNegative));
  return parsed.every((value): value is number => value !== undefined)
    ? { top: parsed[0], right: parsed[1], bottom: parsed[2], left: parsed[3] }
    : undefined;
}

function parseLength(value: unknown, allowNegative: boolean): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return allowNegative ? parsed : Math.max(0, parsed);
}

function readViewportRect(
  value: unknown,
  read: AuthorityReader,
): ViewportRect | undefined {
  if (!isObject(value)) return undefined;
  const rect = value as Record<string, unknown>;
  const x = read(() => rect.x);
  const y = read(() => rect.y);
  const width = read(() => rect.width);
  const height = read(() => rect.height);
  return x && y && width && height &&
      isFiniteNumber(x.value) &&
      isFiniteNumber(y.value) &&
      isFiniteNonNegative(width.value) &&
      isFiniteNonNegative(height.value)
    ? { x: x.value, y: y.value, width: width.value, height: height.value }
    : undefined;
}

function readTopViewportRect(
  value: unknown,
  read: AuthorityReader,
): TopViewportRect | undefined {
  const rect = readViewportRect(value, read);
  if (!rect) return undefined;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return Number.isFinite(right) && Number.isFinite(bottom)
    ? {
        ...rect,
        left: rect.x,
        top: rect.y,
        right,
        bottom,
      }
    : undefined;
}

function offsetViewportRect(
  rect: ViewportRect,
  offsetX: number,
  offsetY: number,
): TopViewportRect | undefined {
  const x = rect.x + offsetX;
  const y = rect.y + offsetY;
  const right = x + rect.width;
  const bottom = y + rect.height;
  return Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(right) &&
      Number.isFinite(bottom)
    ? {
        x,
        y,
        width: rect.width,
        height: rect.height,
        left: x,
        top: y,
        right,
        bottom,
      }
    : undefined;
}

function createLayerGeometries(
  borderBox: TopViewportRect,
  boxModel: BoxModel,
  fragmentIndex: number,
  fragmentCount: number,
): Record<"margin" | "border" | "padding" | "content", LayerGeometry> {
  const margin = fragmentEdges(boxModel.margin, boxModel.decoration, fragmentIndex, fragmentCount);
  const border = fragmentEdges(boxModel.border, boxModel.decoration, fragmentIndex, fragmentCount);
  const padding = fragmentEdges(boxModel.padding, boxModel.decoration, fragmentIndex, fragmentCount);
  const paddingBox = inset(borderBox, border);
  return {
    margin: {
      left: borderBox.x - margin.left,
      top: borderBox.y - margin.top,
      width: Math.max(0, borderBox.width + margin.left + margin.right),
      height: Math.max(0, borderBox.height + margin.top + margin.bottom),
    },
    border: {
      left: borderBox.x,
      top: borderBox.y,
      width: Math.max(0, borderBox.width),
      height: Math.max(0, borderBox.height),
    },
    padding: paddingBox,
    content: inset(paddingBox, padding),
  };
}

function fragmentEdges(
  edges: BoxEdges,
  decoration: FragmentDecoration,
  fragmentIndex: number,
  fragmentCount: number,
): BoxEdges {
  if (decoration.breakMode === "clone" || fragmentCount === 1) return edges;
  const adjusted = { ...edges };
  if (fragmentIndex !== 0) adjusted[decoration.inlineStart] = 0;
  if (fragmentIndex !== fragmentCount - 1) adjusted[decoration.inlineEnd] = 0;
  return adjusted;
}

function inset(box: LayerGeometry, edges: BoxEdges): LayerGeometry {
  return {
    left: box.left + edges.left,
    top: box.top + edges.top,
    width: Math.max(0, box.width - edges.left - edges.right),
    height: Math.max(0, box.height - edges.top - edges.bottom),
  };
}

function applyGeometry(element: HTMLElement, geometry: LayerGeometry): void {
  element.style.left = `${geometry.left}px`;
  element.style.top = `${geometry.top}px`;
  element.style.width = `${geometry.width}px`;
  element.style.height = `${geometry.height}px`;
}

function isValidLayerGeometry(geometry: LayerGeometry): boolean {
  return (
    isFiniteNumber(geometry.left) &&
    isFiniteNumber(geometry.top) &&
    isFiniteNonNegative(geometry.width) &&
    isFiniteNonNegative(geometry.height)
  );
}

function readLabelText(
  element: Element,
  width: number,
  height: number,
  read: AuthorityReader,
): string | undefined {
  const tagName = read(() => element.tagName);
  const id = read(() => element.id);
  const classList = read(() => element.classList);
  if (
    !tagName ||
    !id ||
    !classList ||
    typeof tagName.value !== "string" ||
    typeof id.value !== "string" ||
    !isObject(classList.value)
  ) {
    return undefined;
  }
  const classLength = read(() => classList.value.length);
  if (!classLength || !Number.isSafeInteger(classLength.value) || classLength.value < 0) {
    return undefined;
  }
  const classes: string[] = [];
  const scanCount = Math.min(classLength.value, LABEL_CLASS_SCAN_LIMIT);
  for (let index = 0; index < scanCount && classes.length < LABEL_MAX_CLASSES; index += 1) {
    const className = read(() => {
      const item = classList.value.item;
      return typeof item === "function"
        ? item.call(classList.value, index)
        : (classList.value as unknown as Record<number, unknown>)[index];
    });
    if (!className) return undefined;
    if (className.value === null || className.value === undefined) continue;
    if (typeof className.value !== "string") return undefined;
    const bounded = boundToken(className.value);
    if (bounded) classes.push(bounded);
  }
  const tag = boundToken(tagName.value).toLowerCase() || "element";
  const boundedId = boundToken(id.value);
  let descriptor = tag;
  if (boundedId) descriptor += `#${boundedId}`;
  for (const className of classes) descriptor += `.${className}`;
  const dimensions = `${formatDimension(width)} x ${formatDimension(height)}`;
  const descriptorLimit = LABEL_MAX_TEXT_LENGTH - dimensions.length - 1;
  if (descriptor.length > descriptorLimit) {
    descriptor = `${descriptor.slice(0, Math.max(0, descriptorLimit - 3))}...`;
  }
  return `${descriptor} ${dimensions}`;
}

function boundToken(value: string): string {
  return value.length <= LABEL_MAX_TOKEN_LENGTH
    ? value
    : `${value.slice(0, LABEL_MAX_TOKEN_LENGTH - 3)}...`;
}

function formatDimension(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function readViewportSize(
  value: PageOverlayViewportSize | undefined,
  read: AuthorityReader,
): PageOverlayViewportSize | undefined {
  if (!isObject(value)) return undefined;
  const width = read(() => value.width);
  const height = read(() => value.height);
  return width && height &&
      isFiniteNonNegative(width.value) &&
      isFiniteNonNegative(height.value)
    ? { width: width.value, height: height.value }
    : undefined;
}

function positionLabel(
  label: HTMLElement,
  bounds: LayerGeometry,
  viewport: PageOverlayViewportSize | undefined,
): void {
  let maxWidth = LABEL_MAX_WIDTH;
  let left = bounds.left;
  let top = bounds.top - LABEL_HEIGHT;
  if (viewport) {
    maxWidth = Math.min(LABEL_MAX_WIDTH, viewport.width);
    left = clamp(left, 0, Math.max(0, viewport.width - maxWidth));
    if (top < 0) top = bounds.top + bounds.height;
    top = clamp(top, 0, Math.max(0, viewport.height - LABEL_HEIGHT));
  } else if (top < 0) {
    top = bounds.top + bounds.height;
  }
  label.style.left = `${left}px`;
  label.style.top = `${top}px`;
  label.style.maxWidth = `${maxWidth}px`;
}

function readFrameContext(
  value: FrameContext | undefined,
  read: AuthorityReader,
): FrameContextSnapshot | undefined {
  if (!isObject(value)) return undefined;
  const frameRef = read(() => value.frameRef);
  const frameEpoch = read(() => value.frameEpoch);
  const documentEpoch = read(() => value.documentEpoch);
  const document = read(() => value.document);
  const parentFrameRef = read(() => value.parentFrameRef);
  if (
    !frameRef ||
    !frameEpoch ||
    !documentEpoch ||
    !document ||
    !parentFrameRef ||
    typeof frameRef.value !== "string" ||
    !isNonNegativeSafeInteger(frameEpoch.value) ||
    !isNonNegativeSafeInteger(documentEpoch.value) ||
    !isObject(document.value) ||
    (parentFrameRef.value !== undefined && typeof parentFrameRef.value !== "string")
  ) {
    return undefined;
  }
  return {
    frameRef: frameRef.value,
    frameEpoch: frameEpoch.value,
    documentEpoch: documentEpoch.value,
    document: document.value,
    ...(parentFrameRef.value === undefined
      ? {}
      : { parentFrameRef: parentFrameRef.value }),
  };
}

function snapshotIdentity(
  value: FrameIdentity,
  isAuthoritative: () => boolean,
): FrameIdentity | undefined {
  if (!isObject(value) || !isAuthoritative()) return undefined;
  try {
    const frameRef = value.frameRef;
    if (!isAuthoritative() || typeof frameRef !== "string") return undefined;
    const frameEpoch = value.frameEpoch;
    if (!isAuthoritative() || !isNonNegativeSafeInteger(frameEpoch)) return undefined;
    const documentEpoch = value.documentEpoch;
    if (!isAuthoritative() || !isNonNegativeSafeInteger(documentEpoch)) return undefined;
    return Object.freeze({ frameRef, frameEpoch, documentEpoch });
  } catch {
    return undefined;
  }
}

function sameIdentity(left: FrameIdentity, right: FrameIdentity): boolean {
  return (
    left.frameRef === right.frameRef &&
    left.frameEpoch === right.frameEpoch &&
    left.documentEpoch === right.documentEpoch
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
