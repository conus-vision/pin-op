import type {
  ChromiumDOMModel,
  ChromiumDOMNode,
  ChromiumDOMNodePayload,
  ChromiumElementsRuntime,
  ChromiumElementsTreeOutline,
  ChromiumLoadMoreBridge,
  ChromiumLoadMoreParent,
  ChromiumTreeElement,
} from "../../src/chromium/upstream/PinOpElementsTreeAdapter.js";

type Listener = {
  readonly callback: (event: { readonly data: unknown }) => void;
  readonly thisObject?: unknown;
};

type ElementEvent = {
  readonly relatedTarget?: unknown;
  readonly type: string;
};

type ElementListener = (event: ElementEvent) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  public add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  public contains(token: string): boolean {
    return this.values.has(token);
  }
}

export class FakeChromiumElement {
  public readonly children: FakeChromiumElement[] = [];
  public readonly classList = new FakeClassList();
  public parent: FakeChromiumMount | undefined;
  public removed = false;
  /** Layout the scroll-preserving selection path reads. */
  public rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  public overflowY = "visible";
  public parentElement: FakeChromiumElement | null = null;

  public getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } {
    return { ...this.rect };
  }

  public getRootNode(): FakeChromiumElement {
    return this;
  }

  public get ownerDocument(): {
    defaultView: {
      getComputedStyle(element: FakeChromiumElement): { overflowY: string };
    };
  } {
    return {
      defaultView: {
        getComputedStyle: (element: FakeChromiumElement) => ({
          overflowY: element.overflowY,
        }),
      },
    };
  }
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<ElementListener>>();

  public contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  public append(...children: FakeChromiumElement[]): void {
    this.children.push(...children);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public remove(): void {
    this.removed = true;
    this.parent?.remove(this);
  }

  public addEventListener(type: string, listener: ElementListener): void {
    const listeners = this.listeners.get(type) ?? new Set<ElementListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: ElementListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string, event: Omit<ElementEvent, "type"> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ ...event, type });
    }
  }
}

export class FakeChromiumMount {
  public readonly children: FakeChromiumElement[] = [];

  public append(...elements: FakeChromiumElement[]): void {
    for (const element of elements) {
      element.remove();
      element.removed = false;
      element.parent = this;
      this.children.push(element);
    }
  }

  public remove(element: FakeChromiumElement): void {
    const index = this.children.indexOf(element);
    if (index >= 0) this.children.splice(index, 1);
    element.parent = undefined;
  }
}

export class FakeChromiumDOMNode implements ChromiumDOMNode {
  public readonly id: number;
  public parentNode: FakeChromiumDOMNode | null = null;
  public index: number | undefined;
  public nextSibling: FakeChromiumDOMNode | null = null;
  public previousSibling: FakeChromiumDOMNode | null = null;
  public firstChild: FakeChromiumDOMNode | null = null;
  public lastChild: FakeChromiumDOMNode | null = null;
  public ownerDocument: FakeChromiumDOMDocument | null = null;
  public readonly payload: ChromiumDOMNodePayload;
  public readonly setChildNodeCountCalls: number[] = [];
  private childrenInternal: FakeChromiumDOMNode[] | null = null;
  private childNodeCountInternal: number;
  private nodeValueInternal: string;
  private attributesInternal: string[];
  private readonly shadowRootsInternal: FakeChromiumDOMNode[] = [];
  private contentDocumentInternal: FakeChromiumDOMDocument | null = null;

  public constructor(
    private readonly model: ChromiumDOMModel,
    payload: ChromiumDOMNodePayload,
  ) {
    this.payload = payload;
    this.id = payload.nodeId;
    this.childNodeCountInternal = payload.childNodeCount ?? 0;
    this.nodeValueInternal = payload.nodeValue;
    this.attributesInternal = [...(payload.attributes ?? [])];
    model.registerNode(this);
  }

  protected initialize(ownerDocument: FakeChromiumDOMDocument): void {
    this.ownerDocument = ownerDocument;
    if (this.payload.children !== undefined) {
      this.setChildrenPayload(this.payload.children);
    }
    for (const payload of this.payload.shadowRoots ?? []) {
      const root = new FakeChromiumDOMNode(this.model, payload);
      root.ownerDocument = ownerDocument;
      root.parentNode = this;
      root.initializePayloadChildren();
      this.shadowRootsInternal.push(root);
    }
    if (this.payload.contentDocument) {
      const document = new FakeChromiumDOMDocument(
        this.model,
        this.payload.contentDocument,
      );
      document.parentNode = this;
      this.contentDocumentInternal = document;
    }
  }

  private initializePayloadChildren(): void {
    if (!this.ownerDocument) throw new Error("Fake node requires an owner document");
    this.initialize(this.ownerDocument);
  }

  public children(): FakeChromiumDOMNode[] | null {
    return this.childrenInternal ? [...this.childrenInternal] : null;
  }

  public shadowRoots(): FakeChromiumDOMNode[] {
    return [...this.shadowRootsInternal];
  }

  public contentDocument(): FakeChromiumDOMDocument | null {
    return this.contentDocumentInternal;
  }

  public setContentDocument(document: ChromiumDOMNode): void {
    this.contentDocumentInternal = document as FakeChromiumDOMDocument;
    this.contentDocumentInternal.parentNode = this;
  }

  public setChildrenPayload(payloads: readonly ChromiumDOMNodePayload[]): void {
    if (!this.ownerDocument) return;
    // Exercise the adapter's invariant that a bounded page cannot replace the
    // source-owned total count, even if a runtime derives count from payloads.
    this.childNodeCountInternal = payloads.length;
    this.childrenInternal = payloads.map((payload) => {
      const child = payload.nodeType === 9
        ? new FakeChromiumDOMDocument(this.model, payload)
        : new FakeChromiumDOMNode(this.model, payload);
      child.parentNode = this;
      if (!(child instanceof FakeChromiumDOMDocument)) {
        child.ownerDocument = this.ownerDocument;
        child.initializePayloadChildren();
      }
      return child;
    });
    this.relinkChildren();
  }

  public setChildren(children: ChromiumDOMNode[]): void {
    this.childrenInternal = children as FakeChromiumDOMNode[];
    this.relinkChildren();
  }

  public childNodeCount(): number {
    return this.childNodeCountInternal;
  }

  /**
   * Mirrors Chromium DOMNode.getChildNodes(): the agent promise is chained only
   * with `then`, so a rejected request would skip the callback entirely. The
   * returned chain exists only so tests can assert that the discarded Chromium
   * chain resolves rather than becoming an unhandled rejection.
   */
  public requestChildrenThroughChromiumChainForTest(
    callback: (children: readonly ChromiumDOMNode[] | null) => void,
  ): Promise<void> {
    return this.model.getAgent().invoke_requestChildNodes({ nodeId: this.id })
      .then(response => {
        callback(response.getError() ? null : this.children());
      });
  }

  public insertChild(
    previous: ChromiumDOMNode | undefined,
    payload: ChromiumDOMNodePayload,
  ): FakeChromiumDOMNode {
    if (!this.ownerDocument) throw new Error("Fake node requires an owner document");
    const child = new FakeChromiumDOMNode(this.model, payload);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    child.initializePayloadChildren();
    this.childrenInternal ??= [];
    const previousIndex = previous
      ? this.childrenInternal.indexOf(previous as FakeChromiumDOMNode)
      : -1;
    this.childrenInternal.splice(previousIndex + 1, 0, child);
    this.childNodeCountInternal = this.childrenInternal.length;
    this.relinkChildren();
    return child;
  }

  public nodeValue(): string {
    return this.nodeValueInternal;
  }

  public setNodeValueInternal(nodeValue: string): void {
    this.nodeValueInternal = nodeValue;
  }

  public setAttributesPayload(attributes: string[]): boolean {
    const changed = JSON.stringify(this.attributesInternal) !== JSON.stringify(attributes);
    this.attributesInternal = [...attributes];
    return changed;
  }

  public attributesForTest(): readonly string[] {
    return [...this.attributesInternal];
  }

  public setChildNodeCount(childNodeCount: number): void {
    this.childNodeCountInternal = childNodeCount;
    this.setChildNodeCountCalls.push(childNodeCount);
  }

  public nodeType(): number {
    return this.payload.nodeType;
  }

  public nodeName(): string {
    return this.payload.nodeName;
  }

  private relinkChildren(): void {
    const children = this.childrenInternal ?? [];
    this.firstChild = children[0] ?? null;
    this.lastChild = children.at(-1) ?? null;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child) continue;
      child.parentNode = this;
      child.index = index;
      child.previousSibling = children[index - 1] ?? null;
      child.nextSibling = children[index + 1] ?? null;
    }
  }
}

export class FakeChromiumDOMDocument extends FakeChromiumDOMNode {
  public constructor(model: ChromiumDOMModel, payload: ChromiumDOMNodePayload) {
    super(model, payload);
    this.ownerDocument = this;
    this.initialize(this);
  }
}

export class FakeChromiumTreeElement implements ChromiumTreeElement {
  public expanded = false;
  public readonly listItemElement =
    new FakeChromiumElement() as unknown as HTMLElement;

  public constructor(
    private readonly chromiumNode: ChromiumDOMNode,
    private readonly onExpandCall: () => void,
  ) {}

  public expand(): void {
    this.onExpandCall();
    this.expanded = true;
  }

  public collapse(): void {
    this.expanded = false;
  }

  public node(): ChromiumDOMNode {
    return this.chromiumNode;
  }
}

export class FakeChromiumElementsTreeOutline
implements ChromiumElementsTreeOutline {
  public readonly element = new FakeChromiumElement() as unknown as HTMLElement;
  public readonly constructorArguments: readonly unknown[];
  public wiredModel: ChromiumDOMModel | undefined;
  public unwiredModel: ChromiumDOMModel | undefined;
  public disposeCount = 0;
  public rootSetCount = 0;
  public expandCallCount = 0;
  public readonly selectDOMNodeCalls: Array<{
    readonly focus: boolean;
    readonly node: ChromiumDOMNode | null;
  }> = [];
  private rootInternal: ChromiumDOMNode | null = null;
  private selectedInternal: ChromiumDOMNode | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly treeElements = new Map<ChromiumDOMNode, FakeChromiumTreeElement>();
  private readonly persistentModelListener = (): void => undefined;
  private readonly persistentModelListenerContext = {};

  public constructor(...constructorArguments: readonly unknown[]) {
    this.constructorArguments = constructorArguments;
  }

  public get rootDOMNode(): ChromiumDOMNode | null {
    return this.rootInternal;
  }

  public set rootDOMNode(node: ChromiumDOMNode | null) {
    this.rootSetCount += 1;
    this.rootInternal = node;
    this.treeElements.clear();
    if (node) {
      this.indexTree(node);
      this.wiredModel?.addEventListener(
        "TopLayerElementsChanged",
        (): void => undefined,
        { document: node },
      );
    }
  }

  public wireToDOMModel(model: ChromiumDOMModel): void {
    this.wiredModel = model;
    model.addEventListener(
      "NodeInserted",
      this.persistentModelListener,
      this.persistentModelListenerContext,
    );
  }

  public unwireFromDOMModel(model: ChromiumDOMModel): void {
    this.unwiredModel = model;
    model.removeEventListener(
      "NodeInserted",
      this.persistentModelListener,
      this.persistentModelListenerContext,
    );
  }

  public selectedDOMNode(): ChromiumDOMNode | null {
    return this.selectedInternal;
  }

  public readonly deferredScrollCalls: number[] = [];

  /** Chromium's reveal scroll, so a test can see whether it was suppressed. */
  public deferredScrollIntoView(_treeElement: unknown, center: boolean): void {
    this.deferredScrollCalls.push(center ? 1 : 0);
  }

  public selectDOMNode(node: ChromiumDOMNode | null, focus = false): void {
    this.selectDOMNodeCalls.push({ node, focus });
    this.deferredScrollIntoView(this.treeElements.get(node as ChromiumDOMNode), true);
    this.selectedInternal = node;
    this.emit("SelectedNodeChanged", { node, focus });
  }

  public simulateUserSelection(node: ChromiumDOMNode, focus = true): void {
    this.selectedInternal = node;
    this.emit("SelectedNodeChanged", { node, focus });
  }

  public simulateUserCollapse(node: ChromiumDOMNode): void {
    const treeElement = this.treeElements.get(node);
    if (!treeElement) throw new Error("Node has no tree element");
    treeElement.expanded = false;
    this.emit("ElementCollapsed", treeElement);
  }

  public simulateUserExpansion(node: ChromiumDOMNode): void {
    const treeElement = this.treeElements.get(node);
    if (!treeElement) throw new Error("Node has no tree element");
    treeElement.expand();
    this.emit("ElementExpanded", treeElement);
  }

  public findTreeElement(node: ChromiumDOMNode): FakeChromiumTreeElement | null {
    return this.treeElements.get(node) ?? null;
  }

  public addEventListener(
    eventName: string,
    callback: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push({ callback, thisObject });
    this.listeners.set(eventName, listeners);
  }

  public removeEventListener(
    eventName: string,
    callback: (event: { readonly data: unknown }) => void,
    thisObject?: unknown,
  ): void {
    const listeners = this.listeners.get(eventName) ?? [];
    this.listeners.set(eventName, listeners.filter((listener) =>
      listener.callback !== callback || listener.thisObject !== thisObject));
  }

  public async requestChildren(node: ChromiumDOMNode): Promise<void> {
    const agent = this.wiredModel?.getAgent() as {
      invoke_requestChildNodes(
        request: { readonly nodeId: number },
      ): Promise<{ getError(): string | undefined }>;
    } | undefined;
    if (!agent) throw new Error("Outline is not wired to a DOM model");
    const response = await agent.invoke_requestChildNodes({ nodeId: node.id });
    if (response.getError()) throw new Error(response.getError());
    this.indexTree(node);
  }

  public dispose(): void {
    this.disposeCount += 1;
  }

  private emit(eventName: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(eventName) ?? [])]) {
      listener.callback.call(listener.thisObject, { data });
    }
  }

  private indexTree(node: ChromiumDOMNode): void {
    if (!this.treeElements.has(node)) {
      this.treeElements.set(node, new FakeChromiumTreeElement(
        node,
        () => { this.expandCallCount += 1; },
      ));
    }
    for (const child of node.children() ?? []) this.indexTree(child);
    for (const root of node.shadowRoots?.() ?? []) this.indexTree(root);
    const contentDocument = node.contentDocument?.();
    if (contentDocument) this.indexTree(contentDocument);
  }
}

export class FakeChromiumElementsRuntime implements ChromiumElementsRuntime {
  public readonly DOMDocument = FakeChromiumDOMDocument;
  public readonly selectedNodeChangedEvent = "SelectedNodeChanged";
  public readonly elementCollapsedEvent = "ElementCollapsed";
  public readonly elementExpandedEvent = "ElementExpanded";
  public readonly ElementsTreeOutline: ChromiumElementsRuntime["ElementsTreeOutline"];
  public createdOutline: FakeChromiumElementsTreeOutline | undefined;
  public prepareCount = 0;
  public cleanupCount = 0;
  public loadMoreBridgeCleanupCount = 0;
  public loadMoreParents: readonly ChromiumLoadMoreParent[] = Object.freeze([]);
  public readonly loadMoreUpdateHistory: Array<readonly ChromiumLoadMoreParent[]> = [];
  public focusedLoadMoreRef: string | undefined;
  private loadMoreHandler:
    ((authority: ChromiumLoadMoreParent) => Promise<void>) | undefined;

  public constructor() {
    const runtime = this;
    this.ElementsTreeOutline = class extends FakeChromiumElementsTreeOutline {
      public constructor(...arguments_: readonly unknown[]) {
        super(...arguments_);
        runtime.createdOutline = this;
      }
    };
  }

  public prepareReadOnlyRuntime(): () => void {
    this.prepareCount += 1;
    return () => {
      this.cleanupCount += 1;
    };
  }

  public installLoadMoreBridge(
    _outline: ChromiumElementsTreeOutline,
    loadMore: (authority: ChromiumLoadMoreParent) => Promise<void>,
  ): ChromiumLoadMoreBridge {
    this.loadMoreHandler = loadMore;
    let disposed = false;
    return {
      update: parents => {
        if (disposed) throw new Error("Load-more bridge is disposed");
        this.loadMoreParents = parents;
        this.focusedLoadMoreRef = parents.find(parent => parent.focused)?.serviceRowRef;
        this.loadMoreUpdateHistory.push(parents);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.loadMoreBridgeCleanupCount += 1;
        this.loadMoreHandler = undefined;
        this.loadMoreParents = Object.freeze([]);
        this.focusedLoadMoreRef = undefined;
      },
    };
  }

  public requestLoadMore(parent: ChromiumDOMNode): Promise<void> {
    if (!this.loadMoreHandler) throw new Error("Load-more bridge is not installed");
    const authority = this.loadMoreParents.find(candidate => candidate.parent === parent);
    if (!authority) {
      return Promise.reject(new Error("Load-more parent is not presented"));
    }
    return this.loadMoreHandler(authority);
  }

  public requestLoadMoreAuthority(authority: ChromiumLoadMoreParent): Promise<void> {
    if (!this.loadMoreHandler) throw new Error("Load-more bridge is not installed");
    return this.loadMoreHandler(authority);
  }

  public totalExpandCalls(): number {
    return this.createdOutline?.expandCallCount ?? 0;
  }
}
