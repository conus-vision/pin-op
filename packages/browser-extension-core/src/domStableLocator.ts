export const DOM_STABLE_LOCATOR_VERSION = 1;
export const DOM_STABLE_LOCATOR_MAX_DEPTH = 64;
export const DOM_STABLE_LOCATOR_MAX_BOUNDARIES = 16;
export const DOM_STABLE_LOCATOR_MAX_CLASSES = 8;
export const DOM_STABLE_LOCATOR_MAX_ATTRIBUTES = 8;
export const DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH = 128;
export const DOM_TREE_RECOVERY_MAX_EXPANDED = 64;

const MAX_ID_SCAN_NODES = 4_096;
const MAX_EVIDENCE_PHYSICAL_SCAN = 256;

export interface DomStableLocator {
  readonly version: 1;
  readonly targetKind: "element" | "shadow-root" | "frame-document";
  readonly boundaries: readonly DomBoundaryLocator[];
  readonly path: readonly DomPathSegment[];
}

export interface DomBoundaryLocator {
  readonly kind: "shadow-root" | "frame-document";
  readonly hostPath: readonly DomPathSegment[];
}

export interface DomPathSegment {
  readonly tagName: string;
  readonly siblingIndex: number;
  readonly id?: string;
  readonly classes?: readonly string[];
  readonly attributes?: readonly DomLocatorAttribute[];
}

export interface DomLocatorAttribute {
  readonly name: string;
  readonly value: string;
}

export interface StableLocatorResolution {
  readonly kind: DomStableLocator["targetKind"];
  readonly node: Node;
}

export interface DomStableLocatorServiceOptions {
  readonly topDocument: Document;
  readonly frameRegistry: {
    getContextForDocument(document: Document): {
      readonly document: Document;
      readonly frameRef: string;
      readonly frameElement?: HTMLIFrameElement;
    } | undefined;
    getContext(frameRef: string): { readonly document: Document; readonly frameRef: string } | undefined;
    getContextForFrameElement(
      frameElement: HTMLIFrameElement,
      parentFrameRef: string,
    ): { readonly document: Document; readonly frameRef: string } | undefined;
    authorizeExactFrameElement(
      frameElement: HTMLIFrameElement,
      parentFrameRef: string,
    ): {
      readonly kind: "accessible" | "inaccessible";
      readonly document?: Document;
      readonly frameRef: string;
    } | undefined;
  };
  readonly isExcludedNode: (node: Node) => boolean;
}

/** Captures and proves browser-local DOM identity without selector or URL fallback. */
export class DomStableLocatorService {
  private readonly topDocument: Document;
  private readonly frameRegistry: DomStableLocatorServiceOptions["frameRegistry"];
  private readonly isExcludedNode: DomStableLocatorServiceOptions["isExcludedNode"];

  public constructor(options: DomStableLocatorServiceOptions) {
    this.topDocument = options.topDocument;
    this.frameRegistry = options.frameRegistry;
    this.isExcludedNode = options.isExcludedNode;
  }

  public capture(
    node: Node,
    kind: DomStableLocator["targetKind"],
  ): DomStableLocator {
    const target = kind === "frame-document"
      ? this.frameRegistry.getContextForDocument(node as Document)?.frameElement
      : targetElementFor(node, kind);
    if (!target || this.isExcluded(target)) throw invalidLocator();
    const captured = this.captureElement(target, new Set<Node>(), 0);
    const locator = {
      version: DOM_STABLE_LOCATOR_VERSION,
      targetKind: kind,
      boundaries: captured.boundaries,
      path: captured.path,
    } as const;
    return parseDomStableLocator(locator);
  }

  public resolve(locator: DomStableLocator): StableLocatorResolution | undefined {
    let parsed: DomStableLocator;
    try {
      parsed = parseDomStableLocator(locator);
    } catch {
      return undefined;
    }
    let root: Node = this.topDocument;
    let context = this.frameRegistry.getContextForDocument(this.topDocument);
    if (!context || this.isExcluded(root)) return undefined;
    const seen = new Set<Node>([root]);
    let traversed = 0;

    for (const boundary of parsed.boundaries) {
      const host = this.resolvePath(root, boundary.hostPath, seen, traversed);
      traversed += boundary.hostPath.length;
      if (!host || traversed > DOM_STABLE_LOCATOR_MAX_DEPTH) return undefined;
      if (boundary.kind === "shadow-root") {
        const shadowRoot = readOpenShadowRoot(host);
        if (!shadowRoot || this.isExcluded(shadowRoot) || seen.has(shadowRoot)) {
          return undefined;
        }
        seen.add(shadowRoot);
        root = shadowRoot;
        continue;
      }
      if (!isFrameElement(host)) return undefined;
      const description = this.resolveExactFrame(host, context.frameRef);
      if (
        !description ||
        description.kind !== "accessible" ||
        !description.document ||
        this.isExcluded(description.document) ||
        seen.has(description.document)
      ) {
        return undefined;
      }
      const childContext = this.frameRegistry.getContext(description.frameRef);
      if (!childContext || childContext.document !== description.document) return undefined;
      seen.add(description.document);
      root = description.document;
      context = childContext;
    }

    const target = this.resolvePath(root, parsed.path, seen, traversed);
    if (!target) return undefined;
    if (parsed.targetKind === "element") {
      return Object.freeze({ kind: parsed.targetKind, node: target });
    }
    if (parsed.targetKind === "shadow-root") {
      const shadowRoot = readOpenShadowRoot(target);
      return shadowRoot && !this.isExcluded(shadowRoot)
        ? Object.freeze({ kind: parsed.targetKind, node: shadowRoot })
        : undefined;
    }
    if (!isFrameElement(target)) return undefined;
    const description = this.resolveExactFrame(target, context.frameRef);
    return description?.kind === "accessible" && description.document &&
        !this.isExcluded(description.document)
      ? Object.freeze({ kind: parsed.targetKind, node: description.document })
      : undefined;
  }

  private captureElement(
    target: Element,
    seen: Set<Node>,
    depth: number,
  ): { readonly boundaries: readonly DomBoundaryLocator[]; readonly path: readonly DomPathSegment[] } {
    if (depth >= DOM_STABLE_LOCATOR_MAX_DEPTH || seen.has(target)) {
      throw invalidLocator();
    }
    seen.add(target);
    const root = containingRoot(target, seen);
    const path = capturePath(root, target, this.isExcludedNode);
    const nextDepth = depth + path.length;
    if (nextDepth > DOM_STABLE_LOCATOR_MAX_DEPTH) throw invalidLocator();
    if (root.nodeType === 9) {
      if (root !== this.topDocument && !this.frameRegistry.getContextForDocument(root as Document)) {
        throw invalidLocator();
      }
      const context = this.frameRegistry.getContextForDocument(root as Document);
      if (!context || !context.frameElement) {
        return Object.freeze({ boundaries: Object.freeze([]), path });
      }
      const parent = this.captureElement(context.frameElement, seen, nextDepth);
      return Object.freeze({
        boundaries: Object.freeze([
          ...parent.boundaries,
          Object.freeze({ kind: "frame-document" as const, hostPath: parent.path }),
        ]),
        path,
      });
    }
    if (!isOpenShadowRoot(root)) throw invalidLocator();
    const parent = this.captureElement(root.host, seen, nextDepth);
    return Object.freeze({
      boundaries: Object.freeze([
        ...parent.boundaries,
        Object.freeze({ kind: "shadow-root" as const, hostPath: parent.path }),
      ]),
      path,
    });
  }

  private resolvePath(
    root: Node,
    path: readonly DomPathSegment[],
    seen: Set<Node>,
    traversed: number,
  ): Element | undefined {
    if (path.length === 0 || traversed + path.length > DOM_STABLE_LOCATOR_MAX_DEPTH) {
      return undefined;
    }
    let parent = root;
    for (const segment of path) {
      const candidate = elementChildAt(parent, segment.siblingIndex);
      if (
        !candidate ||
        seen.has(candidate) ||
        this.isExcluded(candidate) ||
        !matchesSegment(candidate, segment)
      ) {
        return undefined;
      }
      if (segment.id !== undefined && !hasUniqueId(root, segment.id, this.isExcludedNode)) {
        return undefined;
      }
      seen.add(candidate);
      parent = candidate;
    }
    return parent.nodeType === 1 ? parent as Element : undefined;
  }

  private resolveExactFrame(
    frameElement: HTMLIFrameElement,
    parentFrameRef: string,
  ): { readonly kind: "accessible" | "inaccessible"; readonly document?: Document; readonly frameRef: string } | undefined {
    const known = this.frameRegistry.getContextForFrameElement(
      frameElement,
      parentFrameRef,
    );
    if (known) {
      return Object.freeze({
        kind: "accessible" as const,
        document: known.document,
        frameRef: known.frameRef,
      });
    }
    return this.frameRegistry.authorizeExactFrameElement(
      frameElement,
      parentFrameRef,
    );
  }

  private isExcluded(node: Node): boolean {
    try {
      return this.isExcludedNode(node);
    } catch {
      return true;
    }
  }
}

function targetElementFor(
  node: Node,
  kind: Exclude<DomStableLocator["targetKind"], "frame-document">,
): Element | undefined {
  if (kind === "element") return node.nodeType === 1 ? node as Element : undefined;
  return isOpenShadowRoot(node) ? node.host : undefined;
}

function containingRoot(target: Element, seen: ReadonlySet<Node>): Node {
  let current: Node = target;
  const path = new Set<Node>(seen);
  for (let depth = 0; depth < DOM_STABLE_LOCATOR_MAX_DEPTH; depth += 1) {
    const parent = readParentNode(current);
    if (!parent) throw invalidLocator();
    if (parent.nodeType === 9 || isOpenShadowRoot(parent)) return parent;
    if (path.has(parent)) throw invalidLocator();
    path.add(parent);
    current = parent;
  }
  throw invalidLocator();
}

function capturePath(
  root: Node,
  target: Element,
  isExcludedNode: (node: Node) => boolean,
): readonly DomPathSegment[] {
  const reversed: DomPathSegment[] = [];
  const seen = new Set<Node>();
  let current: Node = target;
  while (current !== root) {
    if (seen.size >= DOM_STABLE_LOCATOR_MAX_DEPTH || seen.has(current) || current.nodeType !== 1) {
      throw invalidLocator();
    }
    seen.add(current);
    if (isExcludedNode(current)) throw invalidLocator();
    const parent = readParentNode(current);
    if (!parent || parent === current || isExcludedNode(parent)) throw invalidLocator();
    reversed.push(captureSegment(current as Element, parent));
    current = parent;
  }
  if (reversed.length === 0 || isExcludedNode(root)) throw invalidLocator();
  return Object.freeze(reversed.reverse());
}

function captureSegment(element: Element, parent: Node): DomPathSegment {
  const tagName = readTagName(element);
  const siblingIndex = elementSiblingIndex(parent, element);
  if (!tagName || siblingIndex === undefined) throw invalidLocator();
  const id = boundedNonEmpty(readCaptureId(element));
  const classes = captureClasses(element);
  const attributes = captureAttributes(element);
  return Object.freeze({
    tagName,
    siblingIndex,
    ...(id === undefined ? {} : { id }),
    ...(classes.length === 0 ? {} : { classes }),
    ...(attributes.length === 0 ? {} : { attributes }),
  });
}

function captureClasses(element: Element): readonly string[] {
  try {
    const classList = element.classList;
    const length = readBoundedCollectionLength(classList);
    const selected: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const value = readCollectionItem(classList, index);
      if (typeof value !== "string") throw invalidLocator();
      if (boundedNonEmpty(value) !== undefined && !hasWhitespace(value)) {
        insertBoundedCanonical(
          selected,
          value,
          DOM_STABLE_LOCATOR_MAX_CLASSES,
          (candidate) => candidate,
        );
      }
    }
    return Object.freeze(selected);
  } catch {
    throw invalidLocator();
  }
}

function captureAttributes(element: Element): readonly DomLocatorAttribute[] {
  try {
    const attributes = element.attributes;
    const length = readBoundedCollectionLength(attributes);
    const selected: DomLocatorAttribute[] = [];
    for (let index = 0; index < length; index += 1) {
      const attribute = readCollectionItem(attributes, index);
      if (!attribute || typeof attribute !== "object") throw invalidLocator();
      const name = String((attribute as { readonly name?: unknown }).name).toLowerCase();
      const value = String((attribute as { readonly value?: unknown }).value);
      if (isApprovedAttributeName(name) && boundedText(value) !== undefined) {
        insertBoundedCanonical(
          selected,
          Object.freeze({ name, value }),
          DOM_STABLE_LOCATOR_MAX_ATTRIBUTES,
          ({ name: candidate }) => candidate,
        );
      }
    }
    return Object.freeze(selected);
  } catch {
    throw invalidLocator();
  }
}

function readBoundedCollectionLength(collection: { readonly length: number }): number {
  const length = collection.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_EVIDENCE_PHYSICAL_SCAN) {
    throw invalidLocator();
  }
  return length;
}

function readCollectionItem(collection: object, index: number): unknown {
  const candidate = collection as {
    readonly item?: (index: number) => unknown;
    readonly [index: number]: unknown;
  };
  return typeof candidate.item === "function"
    ? candidate.item(index)
    : candidate[index];
}

function insertBoundedCanonical<T>(
  values: T[],
  value: T,
  maximum: number,
  keyOf: (value: T) => string,
): void {
  const key = keyOf(value);
  let index = 0;
  while (index < values.length && compareCodeUnits(keyOf(values[index]!), key) < 0) {
    index += 1;
  }
  if (index < values.length && keyOf(values[index]!) === key) return;
  if (index < maximum) values.splice(index, 0, value);
  if (values.length > maximum) values.pop();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function elementChildAt(parent: Node, siblingIndex: number): Element | undefined {
  if (!Number.isSafeInteger(siblingIndex) || siblingIndex < 0) return undefined;
  let index = 0;
  for (const child of readChildNodes(parent)) {
    if (child.nodeType !== 1) continue;
    if (index === siblingIndex) return child as Element;
    index += 1;
  }
  return undefined;
}

function elementSiblingIndex(parent: Node, target: Element): number | undefined {
  const previous = readPreviousElementSibling(target);
  if (previous !== undefined) {
    let index = 0;
    let current: Element | null = target;
    const seen = new Set<Element>();
    while (current) {
      if (seen.has(current)) {
        return undefined;
      }
      seen.add(current);
      current = readPreviousElementSibling(current) ?? null;
      if (current) index += 1;
    }
    return index;
  }
  let index = 0;
  for (const child of readChildNodes(parent)) {
    if (child.nodeType !== 1) continue;
    if (child === target) return index;
    index += 1;
  }
  return undefined;
}

function readPreviousElementSibling(element: Element): Element | null | undefined {
  try {
    return "previousElementSibling" in element
      ? element.previousElementSibling
      : undefined;
  } catch {
    return undefined;
  }
}

function matchesSegment(element: Element, segment: DomPathSegment): boolean {
  if (readTagName(element) !== segment.tagName) return false;
  if (segment.id !== undefined && readId(element) !== segment.id) return false;
  const classValues = readClasses(element);
  if (!classValues) return false;
  const classes = new Set(classValues);
  if (segment.classes?.some((value) => !classes.has(value))) return false;
  const attributeValues = readAttributes(element);
  if (!attributeValues) return false;
  const attributes = new Map(attributeValues.map(({ name, value }) => [name, value]));
  return !segment.attributes?.some(({ name, value }) => attributes.get(name) !== value);
}

function hasUniqueId(
  root: Node,
  id: string,
  isExcludedNode: (node: Node) => boolean,
): boolean {
  const pending = [root];
  const seen = new Set<Node>();
  let matches = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current) || isExcludedNode(current)) continue;
    if (seen.size >= MAX_ID_SCAN_NODES) return false;
    seen.add(current);
    if (current.nodeType === 1 && readId(current as Element) === id) {
      matches += 1;
      if (matches > 1) return false;
    }
    const children = readChildNodes(current);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return matches === 1;
}

function readTagName(element: Element): string | undefined {
  try {
    const tagName = element.tagName.toLowerCase();
    return /^[a-z][a-z0-9._:-]*$/.test(tagName) && tagName.length <= DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH
      ? tagName
      : undefined;
  } catch {
    return undefined;
  }
}

function readId(element: Element): string | undefined {
  try {
    return typeof element.id === "string" ? element.id : undefined;
  } catch {
    return undefined;
  }
}

function readCaptureId(element: Element): string | undefined {
  try {
    const id = element.id;
    if (typeof id !== "string") throw invalidLocator();
    return id;
  } catch {
    throw invalidLocator();
  }
}

function readClasses(element: Element): readonly string[] | undefined {
  try {
    return Array.from(element.classList, (value) => String(value));
  } catch {
    return undefined;
  }
}

function readAttributes(element: Element): readonly DomLocatorAttribute[] | undefined {
  try {
    const values: DomLocatorAttribute[] = [];
    for (const attribute of Array.from(element.attributes)) {
      const name = String(attribute.name).toLowerCase();
      const value = String(attribute.value);
      values.push(Object.freeze({ name, value }));
    }
    return Object.freeze(values);
  } catch {
    return undefined;
  }
}

function readChildNodes(node: Node): readonly Node[] {
  try {
    return Array.from(node.childNodes);
  } catch {
    return Object.freeze([]);
  }
}

function readParentNode(node: Node): Node | undefined {
  try {
    return node.parentNode ?? undefined;
  } catch {
    return undefined;
  }
}

function readOpenShadowRoot(element: Element): ShadowRoot | undefined {
  try {
    const root = element.shadowRoot;
    return root?.mode === "open" ? root : undefined;
  } catch {
    return undefined;
  }
}

function isOpenShadowRoot(node: Node): node is ShadowRoot {
  try {
    return node.nodeType === 11 && (node as ShadowRoot).mode === "open";
  } catch {
    return false;
  }
}

function isFrameElement(element: Element): element is HTMLIFrameElement {
  return readTagName(element) === "iframe";
}

function boundedNonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH
    ? value
    : undefined;
}

function boundedText(value: string): string | undefined {
  return value.length <= DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH ? value : undefined;
}

function hasWhitespace(value: string): boolean {
  return /[\t\n\f\r ]/.test(value);
}

function isApprovedAttributeName(name: string): boolean {
  return name === "role" || /^(?:aria|data)-[a-z0-9_.:-]+$/.test(name);
}

const LOCATOR_KEYS = [
  "version",
  "targetKind",
  "boundaries",
  "path",
] as const;

const BOUNDARY_KEYS = ["kind", "hostPath"] as const;

const PATH_SEGMENT_KEYS = [
  "tagName",
  "siblingIndex",
  "id",
  "classes",
  "attributes",
] as const;

const ATTRIBUTE_KEYS = ["name", "value"] as const;

const TARGET_KINDS = new Set<DomStableLocator["targetKind"]>([
  "element",
  "shadow-root",
  "frame-document",
]);

const BOUNDARY_KINDS = new Set<DomBoundaryLocator["kind"]>([
  "shadow-root",
  "frame-document",
]);

export function parseDomStableLocator(value: unknown): DomStableLocator {
  const record = snapshotRecord(value, LOCATOR_KEYS);
  assertKeys(record, LOCATOR_KEYS, LOCATOR_KEYS);
  if (record.version !== DOM_STABLE_LOCATOR_VERSION) {
    throw invalidLocator();
  }
  if (
    typeof record.targetKind !== "string" ||
    !TARGET_KINDS.has(record.targetKind as DomStableLocator["targetKind"])
  ) {
    throw invalidLocator();
  }

  let totalSegments = 0;
  const boundaries = parseBoundedArray(
    record.boundaries,
    DOM_STABLE_LOCATOR_MAX_BOUNDARIES,
    (boundary) => {
      const parsed = parseBoundary(boundary);
      totalSegments += parsed.hostPath.length;
      assertTotalDepth(totalSegments);
      return parsed;
    },
  );
  const path = parsePath(record.path);
  totalSegments += path.length;
  assertTotalDepth(totalSegments);

  return Object.freeze({
    version: DOM_STABLE_LOCATOR_VERSION,
    targetKind: record.targetKind as DomStableLocator["targetKind"],
    boundaries,
    path,
  });
}

function parseBoundary(value: unknown): DomBoundaryLocator {
  const record = snapshotRecord(value, BOUNDARY_KEYS);
  assertKeys(record, BOUNDARY_KEYS, BOUNDARY_KEYS);
  if (
    typeof record.kind !== "string" ||
    !BOUNDARY_KINDS.has(record.kind as DomBoundaryLocator["kind"])
  ) {
    throw invalidLocator();
  }
  return Object.freeze({
    kind: record.kind as DomBoundaryLocator["kind"],
    hostPath: parsePath(record.hostPath),
  });
}

function parsePath(value: unknown): readonly DomPathSegment[] {
  return parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_DEPTH,
    parsePathSegment,
  );
}

function parsePathSegment(value: unknown): DomPathSegment {
  const record = snapshotRecord(value, PATH_SEGMENT_KEYS);
  assertKeys(record, PATH_SEGMENT_KEYS, ["tagName", "siblingIndex"]);
  const tagName = assertCanonicalTagName(record.tagName);
  const siblingIndex = assertSafeNonnegativeInteger(record.siblingIndex);
  const id = hasOwn(record, "id")
    ? assertBoundedToken(record.id, true)
    : undefined;
  const classes = hasOwn(record, "classes")
    ? parseClasses(record.classes)
    : undefined;
  const attributes = hasOwn(record, "attributes")
    ? parseAttributes(record.attributes)
    : undefined;

  return Object.freeze({
    tagName,
    siblingIndex,
    ...(id === undefined ? {} : { id }),
    ...(classes === undefined ? {} : { classes }),
    ...(attributes === undefined ? {} : { attributes }),
  });
}

function parseClasses(value: unknown): readonly string[] {
  const classes = parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_CLASSES,
    (item) => assertClassToken(item),
  );
  assertStrictlySorted(classes, (item) => item);
  return classes;
}

function parseAttributes(value: unknown): readonly DomLocatorAttribute[] {
  const attributes = parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_ATTRIBUTES,
    parseAttribute,
  );
  assertStrictlySorted(attributes, (attribute) => attribute.name);
  return attributes;
}

function parseAttribute(value: unknown): DomLocatorAttribute {
  const record = snapshotRecord(value, ATTRIBUTE_KEYS);
  assertKeys(record, ATTRIBUTE_KEYS, ATTRIBUTE_KEYS);
  const name = assertApprovedAttributeName(record.name);
  const attributeValue = assertBoundedText(record.value, false);
  return Object.freeze({ name, value: attributeValue });
}

function assertCanonicalTagName(value: unknown): string {
  const tagName = assertBoundedText(value, true);
  if (!/^[a-z][a-z0-9._:-]*$/.test(tagName)) {
    throw invalidLocator();
  }
  return tagName;
}

function assertApprovedAttributeName(value: unknown): string {
  const name = assertBoundedText(value, true);
  if (
    name !== "role" &&
    !/^(?:aria|data)-[a-z0-9_.:-]+$/.test(name)
  ) {
    throw invalidLocator();
  }
  return name;
}

function assertClassToken(value: unknown): string {
  const token = assertBoundedText(value, true);
  if (/[\t\n\f\r ]/.test(token)) {
    throw invalidLocator();
  }
  return token;
}

function assertBoundedToken(value: unknown, nonEmpty: boolean): string {
  return assertBoundedText(value, nonEmpty);
}

function assertBoundedText(value: unknown, nonEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH ||
    (nonEmpty && value.length === 0)
  ) {
    throw invalidLocator();
  }
  return value;
}

function assertSafeNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidLocator();
  }
  return value;
}

function assertTotalDepth(totalSegments: number): void {
  if (totalSegments > DOM_STABLE_LOCATOR_MAX_DEPTH) {
    throw invalidLocator();
  }
}

function assertStrictlySorted<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (keyOf(values[index - 1]!) >= keyOf(values[index]!)) {
      throw invalidLocator();
    }
  }
}

function parseBoundedArray<T>(
  value: unknown,
  maximumLength: number,
  parseItem: (item: unknown) => T,
): readonly T[] {
  const properties = snapshotOwnDataProperties(value, "array");
  const lengthProperty = properties.find(({ key }) => key === "length");
  const length = lengthProperty?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximumLength ||
    properties.length !== length + 1
  ) {
    throw invalidLocator();
  }

  const values: unknown[] = new Array(length);
  for (const { key, value: item } of properties) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isCanonicalArrayIndex(key, length)) {
      throw invalidLocator();
    }
    values[Number(key)] = item;
  }
  const snapshot = Object.freeze(values);
  const parsed: T[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(snapshot, String(index))) {
      throw invalidLocator();
    }
    parsed.push(parseItem(snapshot[index]));
  }
  return Object.freeze(parsed);
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

interface OwnDataProperty {
  readonly key: PropertyKey;
  readonly value: unknown;
}

function snapshotOwnDataProperties(
  value: unknown,
  expectedKind: "record" | "array",
): readonly OwnDataProperty[] {
  try {
    if (value === null || typeof value !== "object") {
      throw invalidLocator();
    }
    const isArray = Array.isArray(value);
    if ((expectedKind === "array") !== isArray) {
      throw invalidLocator();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const properties: OwnDataProperty[] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptorHolder = Reflect.getOwnPropertyDescriptor(
        descriptors,
        key,
      );
      const descriptor = descriptorHolder?.value as
        | PropertyDescriptor
        | undefined;
      if (!descriptor || !hasOwn(descriptor, "value")) {
        throw invalidLocator();
      }
      properties.push(Object.freeze({ key, value: descriptor.value }));
    }
    return Object.freeze(properties);
  } catch {
    throw invalidLocator();
  }
}

function snapshotRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const properties = snapshotOwnDataProperties(value, "record");
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const { key, value: propertyValue } of properties) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw invalidLocator();
    }
    snapshot[key] = propertyValue;
  }
  return Object.freeze(snapshot);
}

function assertKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !hasOwn(value, key))
  ) {
    throw invalidLocator();
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidLocator(): TypeError {
  return new TypeError("Invalid stable DOM locator");
}
