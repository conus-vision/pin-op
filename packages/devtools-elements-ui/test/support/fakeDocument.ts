type FakeListener = (event: FakeEvent) => void;

export class FakeEvent {
  public defaultPrevented = false;
  public propagationStopped = false;

  public constructor(
    public readonly type: string,
    public readonly target: FakeElement,
    public readonly key?: string,
  ) {}

  public preventDefault(): void {
    this.defaultPrevented = true;
  }

  public stopPropagation(): void {
    this.propagationStopped = true;
  }
}

export class FakeElement {
  public id = "";
  public className = "";
  public hidden = false;
  public tabIndex = -1;
  public disabled = false;
  public clientHeight = 0;
  public scrollTop = 0;
  public readonly children: FakeElement[] = [];
  public readonly dataset: Record<string, string> = {};
  public parentElement: FakeElement | undefined;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private ownText = "";

  public constructor(
    private readonly owner: FakeDocument,
    public readonly tagName: string,
  ) {}

  public get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  public set textContent(value: string) {
    this.replaceChildren();
    this.ownText = String(value);
  }

  public get innerHTML(): string {
    return "";
  }

  public set innerHTML(_value: string) {
    this.owner.recordInnerHtmlAssignment();
    throw new Error("Tests prohibit innerHTML assignment");
  }

  public get outerHTML(): string {
    return "";
  }

  public set outerHTML(_value: string) {
    this.owner.recordOuterHtmlAssignment();
    throw new Error("Tests prohibit outerHTML assignment");
  }

  public append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  public appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }

  public replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) {
      child.parentElement = undefined;
    }
    this.children.length = 0;
    this.ownText = "";
    this.append(...nodes);
  }

  public remove(): void {
    const siblings = this.parentElement?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = undefined;
  }

  public setAttribute(name: string, value: string): void {
    const normalizedName = name.toLowerCase();
    const normalizedValue = String(value);
    this.attributes.set(normalizedName, normalizedValue);
    if (normalizedName === "id") this.id = normalizedValue;
    if (normalizedName === "class") this.className = normalizedValue;
    if (normalizedName === "hidden") this.hidden = true;
    if (normalizedName === "tabindex") this.tabIndex = Number(normalizedValue);
    if (normalizedName.startsWith("data-")) {
      this.dataset[dataProperty(normalizedName.slice(5))] = normalizedValue;
    }
  }

  public getAttribute(name: string): string | null {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "id" && this.id) return this.id;
    if (normalizedName === "class" && this.className) return this.className;
    if (normalizedName === "hidden" && this.hidden) return "";
    if (normalizedName === "tabindex" && this.tabIndex !== -1) {
      return String(this.tabIndex);
    }
    if (normalizedName.startsWith("data-")) {
      return this.dataset[dataProperty(normalizedName.slice(5))] ?? null;
    }
    return this.attributes.get(normalizedName) ?? null;
  }

  public hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  public removeAttribute(name: string): void {
    const normalizedName = name.toLowerCase();
    this.attributes.delete(normalizedName);
    if (normalizedName === "hidden") this.hidden = false;
    if (normalizedName === "tabindex") this.tabIndex = -1;
    if (normalizedName.startsWith("data-")) {
      delete this.dataset[dataProperty(normalizedName.slice(5))];
    }
  }

  public addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(
    type: string,
    init: { readonly target?: FakeElement; readonly key?: string } = {},
  ): FakeEvent {
    const event = new FakeEvent(type, init.target ?? this, init.key);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
    return event;
  }

  public focus(_options?: FocusOptions): void {
    this.owner.recordFocus(this);
  }

  public contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  public querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.descendants().filter((element) => (
      selectors.some((candidate) => matchesSimpleSelector(element, candidate))
    ));
  }

  public listenerCount(deep = false): number {
    const ownCount = [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
    return deep
      ? ownCount + this.children.reduce(
        (total, child) => total + child.listenerCount(true),
        0,
      )
      : ownCount;
  }

  public descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export class FakeDocument {
  public readonly body: FakeElement;
  public readonly document: Document;
  private readonly elements = new Set<FakeElement>();
  private readonly tags: string[] = [];
  private innerHtmlWrites = 0;
  private outerHtmlWrites = 0;
  private focusedElement: FakeElement | null = null;
  public beforeFocus: ((element: FakeElement) => void) | undefined;

  public constructor() {
    this.body = new FakeElement(this, "BODY");
    this.elements.add(this.body);
    const owner = this;
    this.document = {
      body: this.body,
      createElement: (tagName: string) => this.createElement(tagName),
      getElementById: (id: string) => (
        [this.body, ...this.body.descendants()].find((element) => element.id === id) ?? null
      ),
      querySelector: (selector: string) => this.querySelector(selector),
      querySelectorAll: (selector: string) => this.querySelectorAll(selector),
      get activeElement() {
        return owner.focusedElement;
      },
    } as unknown as Document;
  }

  public createElement(tagName: string): HTMLElement {
    const normalizedTag = tagName.toLowerCase();
    this.tags.push(normalizedTag);
    const element = new FakeElement(this, normalizedTag.toUpperCase());
    this.elements.add(element);
    return element as unknown as HTMLElement;
  }

  public querySelector(selector: string): FakeElement | null {
    if (matchesSimpleSelector(this.body, selector)) return this.body;
    return this.body.querySelector(selector);
  }

  public querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    const elements = [this.body, ...this.body.descendants()];
    return elements.filter((element) => (
      selectors.some((candidate) => matchesSimpleSelector(element, candidate))
    ));
  }

  public createdTags(): readonly string[] {
    return this.tags;
  }

  public innerHTMLAssignments(): number {
    return this.innerHtmlWrites;
  }

  public outerHTMLAssignments(): number {
    return this.outerHtmlWrites;
  }

  public totalListeners(): number {
    return [...this.elements].reduce(
      (total, element) => total + element.listenerCount(),
      0,
    );
  }

  public activeElement(): FakeElement | null {
    return this.focusedElement;
  }

  public recordFocus(element: FakeElement): void {
    this.focusedElement = element;
    const beforeFocus = this.beforeFocus;
    this.beforeFocus = undefined;
    beforeFocus?.(element);
  }

  public recordInnerHtmlAssignment(): void {
    this.innerHtmlWrites += 1;
  }

  public recordOuterHtmlAssignment(): void {
    this.outerHtmlWrites += 1;
  }
}

function dataProperty(attributeName: string): string {
  return attributeName.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function matchesSimpleSelector(element: FakeElement, selector: string): boolean {
  const trimmed = selector.trim();
  const match = /^(?:([a-z][a-z0-9-]*)|\.([a-z0-9_-]+))?(?:\[([a-z0-9_-]+)(?:=["']?([^\]"']+)["']?)?\])?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Unsupported fake selector: ${selector}`);
  }
  const [, tagName, className, attributeName, attributeValue] = match;
  if (tagName && element.tagName !== tagName.toUpperCase()) return false;
  if (className && !element.className.split(/\s+/).includes(className)) return false;
  if (attributeName) {
    const actual = element.getAttribute(attributeName);
    if (actual === null) return false;
    if (attributeValue !== undefined && actual !== attributeValue) return false;
  }
  return Boolean(tagName || className || attributeName);
}
