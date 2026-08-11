export const DOM_STABLE_LOCATOR_VERSION = 1;
export const DOM_STABLE_LOCATOR_MAX_DEPTH = 64;
export const DOM_STABLE_LOCATOR_MAX_BOUNDARIES = 16;
export const DOM_STABLE_LOCATOR_MAX_CLASSES = 8;
export const DOM_STABLE_LOCATOR_MAX_ATTRIBUTES = 8;
export const DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH = 128;
export const DOM_TREE_RECOVERY_MAX_EXPANDED = 64;

const MAX_ID_SCAN_NODES = 4_096;
const MAX_EVIDENCE_PHYSICAL_SCAN = 256;
const MAX_CHILD_PHYSICAL_SCAN = 256;
const MAX_LOCATOR_VISITED_NODES = 65_536;
const READ_FAILED = Symbol("dom-stable-locator-read-failed");

class LocatorVisitBudget {
  private remaining = MAX_LOCATOR_VISITED_NODES;

  public visit(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}

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

export interface StableLocatorResolutionTransaction {
  readonly resolution: StableLocatorResolution;
  commit(): void;
  rollback(): void;
}

export interface DomStableLocatorServiceOptions {
  readonly topDocument: Document;
  readonly frameRegistry: {
    getContextForDocument(document: Document): {
      readonly document: Document;
      readonly frameRef: string;
      readonly frameElement?: HTMLIFrameElement;
      readonly parentFrameRef?: string;
    } | undefined;
    getContext(frameRef: string): { readonly document: Document; readonly frameRef: string } | undefined;
    getContextForFrameElement(
      frameElement: HTMLIFrameElement,
      parentFrameRef: string,
    ): { readonly document: Document; readonly frameRef: string } | undefined;
    hasExactFrameElementRegistration(
      frameElement: HTMLIFrameElement,
      parentFrameRef: string,
    ): boolean;
    authorizeExactFrameElement(
      frameElement: HTMLIFrameElement,
      parentFrameRef: string,
    ): {
      readonly kind: "accessible" | "inaccessible";
      readonly document?: Document;
      readonly frameRef: string;
    } | undefined;
    unregisterFrame(frameElement: HTMLIFrameElement): readonly unknown[];
  };
  readonly isExcludedNode: (node: Node) => boolean;
}

interface CapturedElementPath {
  readonly boundaries: readonly DomBoundaryLocator[];
  readonly path: readonly DomPathSegment[];
  readonly pathDepth: number;
}

type CaptureRootBoundary =
  | { readonly kind: "top" }
  | { readonly kind: "frame-document" | "shadow-root"; readonly host: Element };

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
    const captured = this.captureElement(target, new Set<Node>(), 0, new LocatorVisitBudget());
    const locator = {
      version: DOM_STABLE_LOCATOR_VERSION,
      targetKind: kind,
      boundaries: captured.boundaries,
      path: captured.path,
    } as const;
    return parseDomStableLocator(locator);
  }

  public resolve(locator: DomStableLocator): StableLocatorResolution | undefined {
    const transaction = this.beginResolve(locator);
    if (!transaction) return undefined;
    transaction.commit();
    return transaction.resolution;
  }

  public beginResolve(locator: DomStableLocator): StableLocatorResolutionTransaction | undefined {
    let parsed: DomStableLocator;
    try {
      parsed = parseDomStableLocator(locator);
    } catch {
      return undefined;
    }
    let root: Node = this.topDocument;
    const topContext = this.frameRegistry.getContextForDocument(this.topDocument);
    let rootIsDocument = readNodeType(root) === 9;
    if (!topContext || !rootIsDocument || this.isExcluded(root)) return undefined;
    let context: { readonly document: Document; readonly frameRef: string } = topContext;
    const seen = new Set<Node>([root]);
    const budget = new LocatorVisitBudget();
    const authorizedFrames: HTMLIFrameElement[] = [];
    let traversed = 0;
    let transaction: StableLocatorResolutionTransaction | undefined;
    try {
      for (const boundary of parsed.boundaries) {
        if (rootIsDocument && this.frameRegistry.getContext(context.frameRef)?.document !== root) {
          return undefined;
        }
        let shadowRoot: ShadowRoot | undefined;
        let childDocument: Document | undefined;
        let childContext: { readonly document: Document; readonly frameRef: string } | undefined;
        const host = this.resolvePath(root, boundary.hostPath, seen, traversed, budget, (candidate) => {
          if (boundary.kind === "shadow-root") {
            shadowRoot = readOpenShadowRoot(candidate, seen);
            return !!shadowRoot && !this.isExcluded(shadowRoot);
          }
          if (!isFrameElement(candidate)) return false;
          const frame = this.resolveExactFrame(candidate, context.frameRef);
          if (frame?.created) authorizedFrames.push(candidate);
          const description = frame?.description;
          if (
            !description ||
            description.kind !== "accessible" ||
            !description.document ||
            this.isExcluded(description.document) ||
            seen.has(description.document)
          ) return false;
          const resolvedContext = this.frameRegistry.getContext(description.frameRef);
          if (!resolvedContext || resolvedContext.document !== description.document) return false;
          childDocument = description.document;
          childContext = resolvedContext;
          return true;
        });
        traversed += boundary.hostPath.length;
        if (!host || traversed > DOM_STABLE_LOCATOR_MAX_DEPTH) return undefined;
        if (boundary.kind === "shadow-root") {
          if (!shadowRoot) return undefined;
          seen.add(shadowRoot);
          root = shadowRoot;
          rootIsDocument = false;
          continue;
        }
        if (!childDocument || !childContext) return undefined;
        seen.add(childDocument);
        root = childDocument;
        context = childContext;
        rootIsDocument = true;
      }

      if (rootIsDocument && this.frameRegistry.getContext(context.frameRef)?.document !== root) {
        return undefined;
      }
      let targetShadowRoot: ShadowRoot | undefined;
      let targetFrameDocument: Document | undefined;
      const target = this.resolvePath(root, parsed.path, seen, traversed, budget, (candidate) => {
        if (parsed.targetKind === "element") return true;
        if (parsed.targetKind === "shadow-root") {
          targetShadowRoot = readOpenShadowRoot(candidate, seen);
          return !!targetShadowRoot && !this.isExcluded(targetShadowRoot);
        }
        if (!isFrameElement(candidate)) return false;
        const frame = this.resolveExactFrame(candidate, context.frameRef);
        if (frame?.created) authorizedFrames.push(candidate);
        const description = frame?.description;
        if (
          !description ||
          description.kind !== "accessible" ||
          !description.document ||
          this.isExcluded(description.document)
        ) return false;
        targetFrameDocument = description.document;
        return true;
      });
      if (!target) return undefined;
      if (parsed.targetKind === "element") {
        transaction = this.createResolutionTransaction(
          Object.freeze({ kind: parsed.targetKind, node: target }),
          authorizedFrames,
        );
      } else if (parsed.targetKind === "shadow-root") {
        transaction = targetShadowRoot
          ? this.createResolutionTransaction(
            Object.freeze({ kind: parsed.targetKind, node: targetShadowRoot }),
            authorizedFrames,
          )
          : undefined;
      } else {
        transaction = targetFrameDocument
          ? this.createResolutionTransaction(
            Object.freeze({ kind: parsed.targetKind, node: targetFrameDocument }),
            authorizedFrames,
          )
          : undefined;
      }
      return transaction;
    } finally {
      if (!transaction) {
        for (let index = authorizedFrames.length - 1; index >= 0; index -= 1) {
          try {
            this.frameRegistry.unregisterFrame(authorizedFrames[index]!);
          } catch {
            // The registry owns cleanup; a failed cleanup cannot make resolution succeed.
          }
        }
      }
    }
  }

  private captureElement(
    target: Element,
    seen: Set<Node>,
    depth: number,
    budget: LocatorVisitBudget,
  ): CapturedElementPath {
    if (depth >= DOM_STABLE_LOCATOR_MAX_DEPTH || seen.has(target)) {
      throw invalidLocator();
    }
    seen.add(target);
    const root = containingRoot(target, seen, budget);
    const boundary = this.captureRootBoundary(root, seen);
    // The final page-controlled proof for this root is capturePath. Keep all
    // root/context work above it and assemble only trusted local values below.
    if (boundary.kind === "top") {
      const path = capturePath(root, target, this.isExcludedNode, budget);
      if (path.length > DOM_STABLE_LOCATOR_MAX_DEPTH) throw invalidLocator();
      return Object.freeze({
        boundaries: Object.freeze([]),
        path,
        pathDepth: path.length,
      });
    }
    const parent = this.captureElement(boundary.host, seen, depth + 1, budget);
    const path = capturePath(root, target, this.isExcludedNode, budget);
    const pathDepth = parent.pathDepth + path.length;
    if (pathDepth > DOM_STABLE_LOCATOR_MAX_DEPTH) throw invalidLocator();
    return Object.freeze({
      boundaries: Object.freeze([
        ...parent.boundaries,
        Object.freeze({ kind: boundary.kind, hostPath: parent.path }),
      ]),
      path,
      pathDepth,
    });
  }

  private captureRootBoundary(root: Node, seen: Set<Node>): CaptureRootBoundary {
    const rootType = readNodeType(root);
    if (rootType === 9) {
      if (seen.has(root)) throw invalidLocator();
      seen.add(root);
      if (this.isExcluded(root)) throw invalidLocator();
      const context = this.frameRegistry.getContextForDocument(root as Document);
      if (!context || !context.frameElement) {
        if (root !== this.topDocument) throw invalidLocator();
        return Object.freeze({ kind: "top" as const });
      }
      const parentFrameRef = context.parentFrameRef;
      const parentContext = parentFrameRef
        ? this.frameRegistry.getContext(parentFrameRef)
        : undefined;
      const exact = parentFrameRef
        ? this.frameRegistry.getContextForFrameElement(
          context.frameElement,
          parentFrameRef,
        )
        : undefined;
      if (
        !parentContext ||
        !this.frameRegistry.hasExactFrameElementRegistration(
          context.frameElement,
          parentContext.frameRef,
        ) ||
        !exact ||
        exact.frameRef !== context.frameRef ||
        exact.document !== root
      ) {
        throw invalidLocator();
      }
      return Object.freeze({ kind: "frame-document" as const, host: context.frameElement });
    }
    if (rootType !== 11 || this.isExcluded(root)) throw invalidLocator();
    const shadowRoot = exactOpenShadowRoot(root, undefined, seen);
    if (!shadowRoot) throw invalidLocator();
    seen.add(shadowRoot);
    return Object.freeze({ kind: "shadow-root" as const, host: shadowRoot.host });
  }

  private resolvePath(
    root: Node,
    path: readonly DomPathSegment[],
    seen: Set<Node>,
    traversed: number,
    budget: LocatorVisitBudget,
    prepareFinal?: (element: Element) => boolean,
  ): Element | undefined {
    if (path.length === 0 || traversed + path.length > DOM_STABLE_LOCATOR_MAX_DEPTH) {
      return undefined;
    }
    let parent = root;
    let resolved: Element | undefined;
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index]!;
      const candidate = elementChildAt(parent, segment.siblingIndex, budget);
      if (
        !candidate ||
        seen.has(candidate) ||
        this.isExcluded(candidate) ||
        !matchesSegment(
          candidate,
          segment,
          parent,
          root,
          budget,
          index === path.length - 1 ? prepareFinal : undefined,
        )
      ) {
        return undefined;
      }
      seen.add(candidate);
      parent = candidate;
      resolved = candidate;
    }
    return resolved;
  }

  private resolveExactFrame(
    frameElement: HTMLIFrameElement,
    parentFrameRef: string,
  ): {
    readonly description: { readonly kind: "accessible" | "inaccessible"; readonly document?: Document; readonly frameRef: string };
    readonly created: boolean;
  } | undefined {
    const existing = this.frameRegistry.hasExactFrameElementRegistration(
      frameElement,
      parentFrameRef,
    );
    const known = this.frameRegistry.getContextForFrameElement(
      frameElement,
      parentFrameRef,
    );
    if (known) {
      return Object.freeze({
        description: Object.freeze({
          kind: "accessible" as const,
          document: known.document,
          frameRef: known.frameRef,
        }),
        created: false,
      });
    }
    const description = this.frameRegistry.authorizeExactFrameElement(
      frameElement,
      parentFrameRef,
    );
    return description
      ? Object.freeze({ description, created: !existing })
      : undefined;
  }

  private createResolutionTransaction(
    resolution: StableLocatorResolution,
    authorizedFrames: readonly HTMLIFrameElement[],
  ): StableLocatorResolutionTransaction {
    let active = true;
    const rollback = (): void => {
      if (!active) return;
      active = false;
      for (let index = authorizedFrames.length - 1; index >= 0; index -= 1) {
        try {
          this.frameRegistry.unregisterFrame(authorizedFrames[index]!);
        } catch {
          // Failed cleanup cannot turn an unproven locator into a resolution.
        }
      }
    };
    return Object.freeze({
      resolution,
      commit: () => {
        active = false;
      },
      rollback,
    });
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
  return exactOpenShadowRoot(node)?.host;
}

function containingRoot(
  target: Element,
  seen: ReadonlySet<Node>,
  budget: LocatorVisitBudget,
): Node {
  let current: Node = target;
  const path = new Set<Node>(seen);
  for (let depth = 0; depth < DOM_STABLE_LOCATOR_MAX_DEPTH; depth += 1) {
    if (!budget.visit()) throw invalidLocator();
    const parent = readParentNode(current);
    if (!parent) throw invalidLocator();
    if (parent.nodeType === 9 || exactOpenShadowRoot(parent, undefined, path)) return parent;
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
  budget: LocatorVisitBudget,
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
    reversed.push(captureSegment(current as Element, parent, root, budget));
    current = parent;
  }
  if (reversed.length === 0) throw invalidLocator();
  return Object.freeze(reversed.reverse());
}

function captureSegment(
  element: Element,
  parent: Node,
  root: Node,
  budget: LocatorVisitBudget,
): DomPathSegment {
  const tagName = readTagName(element);
  const siblingIndex = elementSiblingIndex(parent, element, budget);
  if (siblingIndex === undefined) throw invalidLocator();
  const evidence = readCanonicalEvidence(element, parent, root, budget);
  if (!tagName || !evidence) throw invalidLocator();
  // The final uniqueness traversal in stabilizeSegmentIdentity is the last
  // page-controlled read before an ID anchor is committed.
  const id = stabilizeSegmentIdentity(element, parent, root, tagName, evidence, budget);
  if (id === READ_FAILED) throw invalidLocator();
  return Object.freeze({
    tagName,
    siblingIndex,
    ...(id === undefined ? {} : { id }),
    ...(evidence.classes.length === 0 ? {} : { classes: evidence.classes }),
    ...(evidence.attributes.length === 0 ? {} : { attributes: evidence.attributes }),
  });
}

interface CanonicalEvidence {
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attributes: readonly DomLocatorAttribute[];
}

function readCanonicalEvidence(
  element: Element,
  expectedParent: Node,
  expectedRoot: Node,
  budget: LocatorVisitBudget,
): CanonicalEvidence | undefined {
  if (
    readParentNode(element) !== expectedParent ||
    !hasExpectedRoot(element, expectedRoot, budget)
  ) return undefined;
  const rawId = readIdStrict(element);
  if (rawId === READ_FAILED) return undefined;
  const classes = readCanonicalClasses(element);
  const attributes = readCanonicalAttributes(element);
  if (
    !classes ||
    !attributes ||
    readParentNode(element) !== expectedParent ||
    !hasExpectedRoot(element, expectedRoot, budget)
  ) return undefined;
  return Object.freeze({
    ...(boundedNonEmpty(rawId) === undefined ? {} : { id: boundedNonEmpty(rawId) }),
    classes,
    attributes,
  });
}

function readCanonicalClasses(element: Element): readonly string[] | undefined {
  try {
    const classList = element.classList;
    const length = readBoundedCollectionLength(classList, MAX_EVIDENCE_PHYSICAL_SCAN);
    const selected: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const value = readCollectionItem(classList, index);
      if (value === READ_FAILED || typeof value !== "string") return undefined;
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
    return undefined;
  }
}

function readCanonicalAttributes(element: Element): readonly DomLocatorAttribute[] | undefined {
  try {
    const attributes = element.attributes;
    const length = readBoundedCollectionLength(attributes, MAX_EVIDENCE_PHYSICAL_SCAN);
    const selected: DomLocatorAttribute[] = [];
    for (let index = 0; index < length; index += 1) {
      const attribute = readCollectionItem(attributes, index);
      if (!attribute || attribute === READ_FAILED || typeof attribute !== "object") return undefined;
      const name = readAttributeName(attribute);
      const value = readAttributeValue(attribute);
      if (name === READ_FAILED || value === READ_FAILED) return undefined;
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
    return undefined;
  }
}

function readBoundedCollectionLength(collection: unknown, maximum: number): number {
  try {
    if (!collection || typeof collection !== "object") throw invalidLocator();
    const length = (collection as { readonly length?: unknown }).length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum
    ) {
      throw invalidLocator();
    }
    return length;
  } catch {
    throw invalidLocator();
  }
}

function readCollectionItem(collection: object, index: number): unknown | typeof READ_FAILED {
  try {
    return (collection as { readonly [index: number]: unknown })[index];
  } catch {
    return READ_FAILED;
  }
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

function elementChildAt(
  parent: Node,
  siblingIndex: number,
  budget: LocatorVisitBudget,
): Element | undefined {
  if (!Number.isSafeInteger(siblingIndex) || siblingIndex < 0) return undefined;
  const children = snapshotChildNodes(parent, budget);
  if (!children) return undefined;
  const candidate = elementChildAtSnapshot(children, siblingIndex);
  const verifiedChildren = snapshotChildNodes(parent, budget);
  if (
    !candidate ||
    !verifiedChildren ||
    !sameChildNodeSnapshot(children, verifiedChildren) ||
    elementChildAtSnapshot(verifiedChildren, siblingIndex) !== candidate
  ) return undefined;
  return candidate;
}

interface ChildNodeSnapshot {
  readonly node: Node;
  readonly nodeType: number;
}

function elementChildAtSnapshot(
  children: readonly ChildNodeSnapshot[],
  siblingIndex: number,
): Element | undefined {
  let index = 0;
  for (const child of children) {
    if (child.nodeType !== 1) continue;
    if (index === siblingIndex) return child.node as Element;
    index += 1;
  }
  return undefined;
}

function elementSiblingIndex(
  parent: Node,
  target: Element,
  budget: LocatorVisitBudget,
): number | undefined {
  const children = snapshotChildNodes(parent, budget);
  if (!children || readParentNode(target) !== parent) return undefined;
  const previous = readPreviousElementSibling(target);
  if (previous === undefined) return undefined;
  let siblingIndex = 0;
  if (previous !== null) {
    let current: Element | null = target;
    const seen = new Set<Element>();
    while (current) {
      if (seen.size >= MAX_CHILD_PHYSICAL_SCAN || seen.has(current)) {
        return undefined;
      }
      seen.add(current);
      const next = readPreviousElementSibling(current);
      if (next === undefined) return undefined;
      if (next !== null && readParentNode(next) !== parent) return undefined;
      current = next;
      if (next !== null) siblingIndex += 1;
    }
  }
  return confirmElementSiblingIndex(parent, target, children, siblingIndex, budget);
}

function confirmElementSiblingIndex(
  parent: Node,
  target: Element,
  initialChildren: readonly ChildNodeSnapshot[],
  expectedIndex: number,
  budget: LocatorVisitBudget,
): number | undefined {
  const verifiedChildren = snapshotChildNodes(parent, budget);
  if (!verifiedChildren || !sameChildNodeSnapshot(initialChildren, verifiedChildren)) {
    return undefined;
  }
  const finalChildren = snapshotChildNodes(parent, budget);
  if (
    !finalChildren ||
    !sameChildNodeSnapshot(verifiedChildren, finalChildren) ||
    !hasExactElementSiblingIndex(finalChildren, target, expectedIndex)
  ) return undefined;
  return expectedIndex;
}

function snapshotChildNodes(
  parent: Node,
  budget: LocatorVisitBudget,
): readonly ChildNodeSnapshot[] | undefined {
  const children = readChildCollection(parent);
  if (!children) return undefined;
  const snapshot: ChildNodeSnapshot[] = [];
  for (let physicalIndex = 0; physicalIndex < children.length; physicalIndex += 1) {
    if (!budget.visit()) return undefined;
    const child = readCollectionItem(children.collection, physicalIndex);
    if (!child || typeof child !== "object") return undefined;
    const node = child as Node;
    const nodeType = readNodeType(node);
    if (nodeType === undefined) return undefined;
    snapshot.push(Object.freeze({ node, nodeType }));
  }
  return Object.freeze(snapshot);
}

function sameChildNodeSnapshot(
  left: readonly ChildNodeSnapshot[],
  right: readonly ChildNodeSnapshot[],
): boolean {
  return left.length === right.length && left.every((child, index) => (
    child.node === right[index]?.node && child.nodeType === right[index]?.nodeType
  ));
}

function hasExactElementSiblingIndex(
  children: readonly ChildNodeSnapshot[],
  target: Element,
  expectedIndex: number,
): boolean {
  let elementIndex = 0;
  let targetCount = 0;
  for (const child of children) {
    if (child.nodeType !== 1) continue;
    if (child.node === target) {
      targetCount += 1;
      if (elementIndex !== expectedIndex) return false;
    } else if (elementIndex === expectedIndex) {
      return false;
    }
    elementIndex += 1;
  }
  return targetCount === 1;
}

function readPreviousElementSibling(element: Element): Element | null | undefined {
  try {
    const previous = element.previousElementSibling;
    return previous === null || previous?.nodeType === 1 ? previous : undefined;
  } catch {
    return undefined;
  }
}

function matchesSegment(
  element: Element,
  segment: DomPathSegment,
  parent: Node,
  root: Node,
  budget: LocatorVisitBudget,
  prepareFinal?: (element: Element) => boolean,
): boolean {
  if (prepareFinal && !prepareFinal(element)) return false;
  if (readTagName(element) !== segment.tagName) return false;
  const siblingIndex = elementSiblingIndex(parent, element, budget);
  if (siblingIndex !== segment.siblingIndex) return false;
  const evidence = readCanonicalEvidence(element, parent, root, budget);
  if (!evidence) return false;
  // This must remain after every structural and final-target proof: the last
  // scan jointly commits the candidate fingerprint and unique-ID boundary.
  const id = stabilizeSegmentIdentity(
    element,
    parent,
    root,
    segment.tagName,
    evidence,
    budget,
  );
  if (
    id === READ_FAILED ||
    id !== segment.id ||
    !sameStringValues(evidence.classes, segment.classes) ||
    !sameAttributes(evidence.attributes, segment.attributes)
  ) {
    return false;
  }
  return true;
}

function stabilizeSegmentIdentity(
  element: Element,
  parent: Node,
  root: Node,
  tagName: string,
  evidence: CanonicalEvidence,
  budget: LocatorVisitBudget,
): string | undefined | typeof READ_FAILED {
  const firstUnique = evidence.id === undefined
    ? undefined
    : uniqueIdStatus(root, evidence.id, budget);
  if (firstUnique === READ_FAILED) return READ_FAILED;
  const verifiedEvidence = readCanonicalEvidence(element, parent, root, budget);
  if (
    readTagName(element) !== tagName ||
    !verifiedEvidence ||
    !sameCanonicalEvidence(evidence, verifiedEvidence)
  ) return READ_FAILED;
  const secondUnique = evidence.id === undefined
    ? undefined
    : uniqueIdStatus(root, evidence.id, budget);
  if (secondUnique === READ_FAILED) return READ_FAILED;
  const finalEvidence = readCanonicalEvidence(element, parent, root, budget);
  if (
    readTagName(element) !== tagName ||
    !finalEvidence ||
    !sameCanonicalEvidence(evidence, finalEvidence)
  ) return READ_FAILED;
  const finalUnique = evidence.id === undefined
    ? undefined
    : uniqueIdStatus(root, evidence.id, budget);
  if (finalUnique === READ_FAILED) return READ_FAILED;
  return firstUnique === true && secondUnique === true && finalUnique === true
    ? evidence.id
    : undefined;
}

function sameCanonicalEvidence(
  left: CanonicalEvidence,
  right: CanonicalEvidence,
): boolean {
  return (
    left.id === right.id &&
    sameStringValues(left.classes, right.classes) &&
    sameAttributes(left.attributes, right.attributes)
  );
}

function uniqueIdStatus(
  root: Node,
  id: string,
  budget: LocatorVisitBudget,
): boolean | typeof READ_FAILED {
  const pending: Array<{ readonly node: Node; readonly children?: { readonly collection: object; readonly length: number }; next?: number }> = [{ node: root }];
  const seen = new Set<Node>();
  let matches = 0;
  while (pending.length > 0) {
    const current = pending[pending.length - 1]!;
    if (!current.children) {
      if (
        seen.size >= MAX_ID_SCAN_NODES ||
        !budget.visit() ||
        seen.has(current.node)
      ) return READ_FAILED;
      seen.add(current.node);
      if (readNodeType(current.node) === 1) {
        const currentId = readIdStrict(current.node as Element);
        if (currentId === READ_FAILED) return READ_FAILED;
        if (currentId === id && ++matches > 1) return false;
      }
      const children = readChildCollection(current.node);
      if (!children) return READ_FAILED;
      (current as { children: { readonly collection: object; readonly length: number }; next: number }).children = children;
      (current as { next: number }).next = 0;
    }
    if (current.next! >= current.children!.length) {
      pending.pop();
      continue;
    }
    const child = readCollectionItem(current.children!.collection, current.next!++);
    if (!isNode(child)) return READ_FAILED;
    pending.push({ node: child });
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
  const id = readIdStrict(element);
  return id === READ_FAILED ? undefined : id;
}

function readIdStrict(element: Element): string | typeof READ_FAILED {
  try {
    return typeof element.id === "string" ? element.id : READ_FAILED;
  } catch {
    return READ_FAILED;
  }
}

function readAttributeName(attribute: object): string | typeof READ_FAILED {
  try {
    const name = (attribute as { readonly name?: unknown }).name;
    return typeof name === "string" ? name.toLowerCase() : READ_FAILED;
  } catch {
    return READ_FAILED;
  }
}

function readAttributeValue(attribute: object): string | typeof READ_FAILED {
  try {
    const value = (attribute as { readonly value?: unknown }).value;
    return typeof value === "string" ? value : READ_FAILED;
  } catch {
    return READ_FAILED;
  }
}

function readChildCollection(
  node: Node,
): { readonly collection: object; readonly length: number } | undefined {
  try {
    const collection = node.childNodes;
    const length = readBoundedCollectionLength(collection, MAX_CHILD_PHYSICAL_SCAN);
    return Object.freeze({ collection, length });
  } catch {
    return undefined;
  }
}

function readNodeType(node: Node): number | undefined {
  try {
    return typeof node.nodeType === "number" ? node.nodeType : undefined;
  } catch {
    return undefined;
  }
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && readNodeType(value as Node) !== undefined;
}

function sameStringValues(
  actual: readonly string[],
  expected: readonly string[] | undefined,
): boolean {
  const values = expected ?? [];
  return actual.length === values.length && actual.every((value, index) => value === values[index]);
}

function sameAttributes(
  actual: readonly DomLocatorAttribute[],
  expected: readonly DomLocatorAttribute[] | undefined,
): boolean {
  const values = expected ?? [];
  return actual.length === values.length && actual.every(({ name, value }, index) => (
    name === values[index]?.name && value === values[index]?.value
  ));
}

function readParentNode(node: Node): Node | undefined {
  try {
    return node.parentNode ?? undefined;
  } catch {
    return undefined;
  }
}

function hasExpectedRoot(
  node: Node,
  expectedRoot: Node,
  budget: LocatorVisitBudget,
): boolean {
  const seen = new Set<Node>();
  let current: Node | undefined = node;
  while (current && current !== expectedRoot) {
    if (
      seen.size >= DOM_STABLE_LOCATOR_MAX_DEPTH ||
      !budget.visit() ||
      seen.has(current)
    ) return false;
    seen.add(current);
    current = readParentNode(current);
  }
  return current === expectedRoot;
}

function readOpenShadowRoot(
  element: Element,
  seen?: ReadonlySet<Node>,
): ShadowRoot | undefined {
  try {
    const root = element.shadowRoot;
    return exactOpenShadowRoot(root, element, seen);
  } catch {
    return undefined;
  }
}

function exactOpenShadowRoot(
  node: unknown,
  expectedHost?: Element,
  seen?: ReadonlySet<Node>,
): ShadowRoot | undefined {
  try {
    if (!node || typeof node !== "object") return undefined;
    const root = node as ShadowRoot;
    if (root.nodeType !== 11 || root.mode !== "open" || seen?.has(root)) {
      return undefined;
    }
    const host = root.host;
    if (
      !host ||
      host.nodeType !== 1 ||
      (expectedHost !== undefined && host !== expectedHost) ||
      host.shadowRoot !== root ||
      root.parentNode !== null
    ) {
      return undefined;
    }
    const getRootNode = root.getRootNode;
    return typeof getRootNode === "function" && getRootNode.call(root) === root
      ? root
      : undefined;
  } catch {
    return undefined;
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
