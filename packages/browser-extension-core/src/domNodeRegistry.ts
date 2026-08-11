export interface NodeScope {
  readonly documentEpoch: number;
  readonly frameRef: string;
  readonly frameEpoch: number;
}

export type RetentionReason = "selected" | "hovered" | "expanded";

export interface NodeWeakReference {
  deref(): Node | undefined;
}

export interface DomNodeRegistryOptions {
  readonly maxReverseEntries: number;
  readonly documentEpoch?: number;
  readonly createWeakRef?: (node: Node) => NodeWeakReference;
}

interface NodeEntry {
  readonly ref: string;
  readonly scope: NodeScope;
  readonly weakNode: NodeWeakReference;
  readonly sequence: number;
  readonly reasons: Set<RetentionReason>;
}

export interface DomNodeRegistrySnapshot {
  readonly registry: DomNodeRegistry;
  readonly documentEpoch: number;
  readonly nextRef: number;
  readonly nextSequence: number;
  readonly structuralRevision: number;
  readonly entries: readonly DomNodeRegistrySnapshotEntry[];
}

export interface DomNodeRegistrySnapshotEntry {
  readonly node: Node;
  readonly ref: string;
  readonly scope: NodeScope;
  readonly weakNode: NodeWeakReference;
  readonly sequence: number;
  readonly reasons: readonly RetentionReason[];
}

type EntryDerefResult =
  | { readonly kind: "live"; readonly node: Node }
  | { readonly kind: "dead" }
  | { readonly kind: "stale" };

interface PruneResult {
  readonly removed: number;
  readonly interrupted: boolean;
}

const MAX_REF_LENGTH = 24;
const MAX_SHADOW_ANCESTRY_DEPTH = 512;
const RETENTION_ORDER: readonly RetentionReason[] = [
  "selected",
  "hovered",
  "expanded",
];

export class DomNodeRegistry {
  private readonly maxReverseEntries: number;
  private readonly createWeakRef: (node: Node) => NodeWeakReference;
  private forward = new WeakMap<Node, Map<string, string>>();
  private readonly reverse = new Map<string, NodeEntry>();
  private readonly retained = new Map<string, Node>();
  private documentEpoch: number;
  private nextRef = 1;
  private nextSequence = 1;
  private structuralRevision = 0;
  private readonly dereferencing = new Set<NodeEntry>();

  public constructor(options: DomNodeRegistryOptions) {
    this.maxReverseEntries = requirePositiveSafeInteger(
      options.maxReverseEntries,
      "maxReverseEntries",
    );
    this.documentEpoch = requireNonNegativeSafeInteger(
      options.documentEpoch ?? 0,
      "documentEpoch",
    );
    this.createWeakRef = options.createWeakRef ?? ((node) => new WeakRef(node));
  }

  public get size(): number {
    return this.reverse.size;
  }

  public get retainedSize(): number {
    return this.retained.size;
  }

  /** Captures the live authority needed to undo a bounded provider operation. */
  public snapshot(): DomNodeRegistrySnapshot | undefined {
    const revision = this.structuralRevision;
    const entries: DomNodeRegistrySnapshotEntry[] = [];
    for (const [ref, entry] of this.reverse) {
      const result = this.dereferenceEntry(ref, entry, entry.scope);
      if (result.kind !== "live" || this.structuralRevision !== revision) {
        return undefined;
      }
      entries.push(Object.freeze({
        node: result.node,
        ref,
        scope: entry.scope,
        weakNode: entry.weakNode,
        sequence: entry.sequence,
        reasons: Object.freeze([...entry.reasons]),
      }));
    }
    if (this.structuralRevision !== revision) return undefined;
    return Object.freeze({
      registry: this,
      documentEpoch: this.documentEpoch,
      nextRef: this.nextRef,
      nextSequence: this.nextSequence,
      structuralRevision: revision,
      entries: Object.freeze(entries),
    });
  }

  /** Restores a snapshot by rebuilding weak indexes from its live entries. */
  public restore(snapshot: DomNodeRegistrySnapshot): boolean {
    if (
      snapshot.registry !== this ||
      snapshot.documentEpoch !== this.documentEpoch ||
      !Number.isSafeInteger(snapshot.nextRef) || snapshot.nextRef < 1 ||
      !Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 1 ||
      !Number.isSafeInteger(snapshot.structuralRevision) || snapshot.structuralRevision < 0 ||
      snapshot.entries.length > this.maxReverseEntries
    ) {
      return false;
    }
    const nextForward = new WeakMap<Node, Map<string, string>>();
    const nextReverse = new Map<string, NodeEntry>();
    const nextRetained = new Map<string, Node>();
    try {
      for (const snapshotEntry of snapshot.entries) {
        if (
          !isNodeLike(snapshotEntry.node) ||
          !isNodeRef(snapshotEntry.ref) ||
          !this.isCurrentScope(snapshotEntry.scope) ||
          deref(snapshotEntry.weakNode) !== snapshotEntry.node ||
          !Number.isSafeInteger(snapshotEntry.sequence) || snapshotEntry.sequence < 1 ||
          nextReverse.has(snapshotEntry.ref)
        ) {
          return false;
        }
        const reasons = new Set(snapshotEntry.reasons);
        if (
          reasons.size !== snapshotEntry.reasons.length ||
          [...reasons].some((reason) => !isRetentionReason(reason))
        ) {
          return false;
        }
        const refs = nextForward.get(snapshotEntry.node) ?? new Map<string, string>();
        const scopeKey = createScopeKey(snapshotEntry.scope);
        if (refs.has(scopeKey)) return false;
        refs.set(scopeKey, snapshotEntry.ref);
        nextForward.set(snapshotEntry.node, refs);
        nextReverse.set(snapshotEntry.ref, {
          ref: snapshotEntry.ref,
          scope: snapshotEntry.scope,
          weakNode: snapshotEntry.weakNode,
          sequence: snapshotEntry.sequence,
          reasons,
        });
        if (reasons.size > 0) nextRetained.set(snapshotEntry.ref, snapshotEntry.node);
      }
    } catch {
      return false;
    }
    this.forward = nextForward;
    this.reverse.clear();
    for (const [ref, entry] of nextReverse) this.reverse.set(ref, entry);
    this.retained.clear();
    for (const [ref, node] of nextRetained) this.retained.set(ref, node);
    this.nextRef = snapshot.nextRef;
    this.nextSequence = snapshot.nextSequence;
    this.structuralRevision = snapshot.structuralRevision;
    return true;
  }

  public reference(node: Node, scope: NodeScope): string {
    if (!isNodeLike(node)) {
      throw new TypeError("node must be an object");
    }
    const validatedScope = freezeScope(this.requireCurrentScope(scope));
    const scopeKey = createScopeKey(validatedScope);
    const forwardRefs = this.forward.get(node);
    const existingRef = forwardRefs?.get(scopeKey);
    if (existingRef) {
      const existing = this.reverse.get(existingRef);
      if (
        existing &&
        sameScope(existing.scope, validatedScope)
      ) {
        const result = this.dereferenceEntry(existingRef, existing, validatedScope);
        if (result.kind === "stale") {
          throwRegistryChanged();
        }
        if (result.kind === "live" && result.node === node) {
          if (!this.touch(existingRef, existing)) {
            throwRegistryChanged();
          }
          return existingRef;
        }
        if (result.kind === "dead") {
          this.remove(existingRef, existing);
        }
      }
    }

    const creationRevision = this.structuralRevision;
    const ref = this.reserveRef();
    const creationIsAuthoritative = (): boolean => (
      this.structuralRevision === creationRevision &&
      this.isCurrentScope(validatedScope)
    );
    const weakNode = createValidatedWeakReference(
      this.createWeakRef,
      node,
      creationIsAuthoritative,
    );
    if (!creationIsAuthoritative()) {
      throwRegistryChanged();
    }
    const entry: NodeEntry = {
      ref,
      scope: validatedScope,
      weakNode,
      sequence: this.nextSequence,
      reasons: new Set(),
    };
    this.makeRoom(validatedScope);
    if (!this.isCurrentScope(validatedScope)) {
      throwRegistryChanged();
    }
    this.bumpStructuralRevision();
    this.reverse.set(ref, entry);
    const refs = this.forward.get(node) ?? new Map<string, string>();
    refs.set(scopeKey, ref);
    this.forward.set(node, refs);
    this.nextRef += 1;
    this.nextSequence += 1;
    return ref;
  }

  public resolve(nodeRef: string, scope: NodeScope): Node | undefined {
    if (!this.isCurrentScope(scope) || !isNodeRef(nodeRef)) {
      return undefined;
    }
    const entry = this.reverse.get(nodeRef);
    if (!entry || !sameScope(entry.scope, scope)) {
      return undefined;
    }
    const result = this.dereferenceEntry(nodeRef, entry, scope);
    if (result.kind === "stale") {
      return undefined;
    }
    if (result.kind === "dead") {
      this.remove(nodeRef, entry);
      return undefined;
    }
    if (!this.touch(nodeRef, entry)) {
      return undefined;
    }
    return result.node;
  }

  public retain(nodeRef: string, reason: RetentionReason): boolean {
    if (!isNodeRef(nodeRef) || !isRetentionReason(reason)) {
      return false;
    }
    const entry = this.reverse.get(nodeRef);
    if (!entry) {
      return false;
    }
    const result = this.dereferenceEntry(nodeRef, entry, entry.scope);
    if (result.kind === "stale") {
      return false;
    }
    if (result.kind === "dead") {
      this.remove(nodeRef, entry);
      return false;
    }
    this.bumpStructuralRevision();
    entry.reasons.add(reason);
    this.retained.set(nodeRef, result.node);
    if (!this.touch(nodeRef, entry)) {
      return false;
    }
    return true;
  }

  public release(nodeRef: string, reason: RetentionReason): void {
    if (!isNodeRef(nodeRef) || !isRetentionReason(reason)) {
      return;
    }
    const entry = this.reverse.get(nodeRef);
    if (!entry || !this.isEntryAuthoritative(nodeRef, entry, entry.scope)) {
      return;
    }
    if (!entry.reasons.has(reason)) {
      return;
    }
    this.bumpStructuralRevision();
    entry.reasons.delete(reason);
    if (entry.reasons.size === 0) {
      this.retained.delete(nodeRef);
    }
  }

  public retentionReasons(nodeRef: string): readonly RetentionReason[] {
    const entry = isNodeRef(nodeRef) ? this.reverse.get(nodeRef) : undefined;
    if (!entry || !this.isEntryAuthoritative(nodeRef, entry, entry.scope)) {
      return Object.freeze([]) as readonly RetentionReason[];
    }
    return Object.freeze(
      RETENTION_ORDER.filter((reason) => entry.reasons.has(reason)),
    );
  }

  public invalidateSubtree(root: Node): readonly string[] {
    if (!isNodeLike(root)) {
      return Object.freeze([]) as readonly string[];
    }
    const operationRevision = this.structuralRevision;
    const operationDocumentEpoch = this.documentEpoch;
    const rootContains = readContains(root);
    if (
      !rootContains ||
      this.structuralRevision !== operationRevision ||
      this.documentEpoch !== operationDocumentEpoch
    ) {
      return Object.freeze([]) as readonly string[];
    }
    const entries = [...this.reverse.values()].sort((left, right) => left.sequence - right.sequence);
    const invalidated: string[] = [];
    const dead: string[] = [];
    const liveNodes = new Map<string, Node>();
    for (const entry of entries) {
      const result = this.dereferenceEntry(entry.ref, entry, entry.scope);
      if (result.kind === "stale") {
        return Object.freeze([]) as readonly string[];
      }
      if (result.kind === "dead") {
        dead.push(entry.ref);
        continue;
      }
      const node = result.node;
      liveNodes.set(entry.ref, node);
      if (node !== root) {
        const contained = contains(root, rootContains, node);
        if (
          contained === undefined ||
          this.structuralRevision !== operationRevision ||
          this.documentEpoch !== operationDocumentEpoch
        ) {
          return Object.freeze([]) as readonly string[];
        }
        if (!contained) {
          const shadowContained = isShadowIncludingDescendant(root, node);
          if (
            shadowContained === undefined ||
            this.structuralRevision !== operationRevision ||
            this.documentEpoch !== operationDocumentEpoch
          ) {
            return Object.freeze([]) as readonly string[];
          }
          if (shadowContained) {
            invalidated.push(entry.ref);
          }
          continue;
        }
      }
      invalidated.push(entry.ref);
    }
    if (
      this.structuralRevision !== operationRevision ||
      this.documentEpoch !== operationDocumentEpoch
    ) {
      return Object.freeze([]) as readonly string[];
    }
    for (const ref of dead) {
      const entry = this.reverse.get(ref);
      if (entry) {
        this.remove(ref, entry);
      }
    }
    for (const ref of invalidated) {
      const entry = this.reverse.get(ref);
      if (entry) {
        this.remove(ref, entry, liveNodes.get(ref));
      }
    }
    return Object.freeze(invalidated);
  }

  public resetDocument(documentEpoch: number): void {
    const nextDocumentEpoch = requireNonNegativeSafeInteger(documentEpoch, "documentEpoch");
    if (nextDocumentEpoch <= this.documentEpoch) {
      throw new RangeError("documentEpoch must be greater than the current epoch");
    }
    this.bumpStructuralRevision();
    this.documentEpoch = nextDocumentEpoch;
    this.forward = new WeakMap<Node, Map<string, string>>();
    this.reverse.clear();
    this.retained.clear();
  }

  public prune(): number {
    return this.pruneEntries().removed;
  }

  private makeRoom(scope: NodeScope): void {
    const pruned = this.pruneEntries();
    if (pruned.interrupted || !this.isCurrentScope(scope)) {
      throwRegistryChanged();
    }
    while (this.reverse.size >= this.maxReverseEntries) {
      const candidate = [...this.reverse.entries()].find(([, entry]) => entry.reasons.size === 0);
      if (!candidate) {
        throw new Error("DomNodeRegistry capacity is fully retained");
      }
      const result = this.dereferenceEntry(candidate[0], candidate[1], candidate[1].scope);
      if (result.kind === "stale") {
        throwRegistryChanged();
      }
      this.remove(
        candidate[0],
        candidate[1],
        result.kind === "live" ? result.node : undefined,
      );
    }
  }

  private pruneEntries(): PruneResult {
    let removed = 0;
    for (const [ref, entry] of [...this.reverse.entries()]) {
      const result = this.dereferenceEntry(ref, entry, entry.scope);
      if (result.kind === "stale") {
        return { removed, interrupted: true };
      }
      if (result.kind === "dead" && this.remove(ref, entry)) {
        removed += 1;
      }
    }
    return { removed, interrupted: false };
  }

  private reserveRef(): string {
    if (!Number.isSafeInteger(this.nextRef)) {
      throw new Error("DomNodeRegistry reference space exhausted");
    }
    return `node-${this.nextRef}`;
  }

  private remove(ref: string, entry: NodeEntry, node?: Node): boolean {
    if (!this.isEntryAuthoritative(ref, entry, entry.scope)) {
      return false;
    }
    this.bumpStructuralRevision();
    if (node) {
      const refs = this.forward.get(node);
      const scopeKey = createScopeKey(entry.scope);
      if (refs?.get(scopeKey) === ref) {
        refs.delete(scopeKey);
        if (refs.size === 0) {
          this.forward.delete(node);
        }
      }
    }
    this.reverse.delete(ref);
    this.retained.delete(ref);
    entry.reasons.clear();
    return true;
  }

  private touch(ref: string, entry: NodeEntry): boolean {
    if (!this.isEntryAuthoritative(ref, entry, entry.scope)) {
      return false;
    }
    this.bumpStructuralRevision();
    this.reverse.delete(ref);
    this.reverse.set(ref, entry);
    return true;
  }

  private dereferenceEntry(
    ref: string,
    entry: NodeEntry,
    scope: NodeScope,
  ): EntryDerefResult {
    if (
      !this.isEntryAuthoritative(ref, entry, scope) ||
      this.dereferencing.has(entry)
    ) {
      return { kind: "stale" };
    }
    const revision = this.structuralRevision;
    this.dereferencing.add(entry);
    let node: Node | undefined;
    try {
      node = deref(entry.weakNode);
    } finally {
      this.dereferencing.delete(entry);
    }
    if (
      this.structuralRevision !== revision ||
      !this.isEntryAuthoritative(ref, entry, scope)
    ) {
      return { kind: "stale" };
    }
    return node ? { kind: "live", node } : { kind: "dead" };
  }

  private isEntryAuthoritative(
    ref: string,
    entry: NodeEntry,
    scope: NodeScope,
  ): boolean {
    return (
      this.reverse.get(ref) === entry &&
      sameScope(entry.scope, scope) &&
      this.isCurrentScope(entry.scope)
    );
  }

  private bumpStructuralRevision(): void {
    this.structuralRevision += 1;
  }

  private requireCurrentScope(scope: NodeScope): NodeScope {
    if (!this.isCurrentScope(scope)) {
      throw new TypeError("scope is invalid or belongs to another document epoch");
    }
    return scope;
  }

  private isCurrentScope(scope: NodeScope): boolean {
    return (
      isNodeScope(scope) &&
      scope.documentEpoch === this.documentEpoch
    );
  }
}

function createValidatedWeakReference(
  factory: (node: Node) => NodeWeakReference,
  node: Node,
  isAuthoritative: () => boolean,
): NodeWeakReference {
  const candidate = factory(node) as unknown;
  if (!isAuthoritative()) {
    throwRegistryChanged();
  }
  if (!isObject(candidate)) {
    throw new TypeError("createWeakRef must return an object");
  }
  let candidateDeref: unknown;
  try {
    candidateDeref = (candidate as { readonly deref?: unknown }).deref;
  } catch {
    throw new TypeError("createWeakRef returned an unreadable deref method");
  }
  if (!isAuthoritative()) {
    throwRegistryChanged();
  }
  if (typeof candidateDeref !== "function") {
    throw new TypeError("createWeakRef must return a deref function");
  }
  let initial: unknown;
  try {
    initial = candidateDeref.call(candidate);
  } catch {
    throw new TypeError("createWeakRef deref failed during validation");
  }
  if (!isAuthoritative()) {
    throwRegistryChanged();
  }
  if (initial !== node) {
    throw new TypeError("createWeakRef must initially resolve the supplied node");
  }
  const expected = new WeakRef(node);
  if (!isAuthoritative()) {
    throwRegistryChanged();
  }
  return {
    deref(): Node | undefined {
      try {
        const actual = candidateDeref.call(candidate) as unknown;
        const expectedNode = expected.deref();
        return actual === expectedNode && isNodeLike(actual) ? actual : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function throwRegistryChanged(): never {
  throw new Error("DomNodeRegistry changed during weak reference access");
}

function deref(reference: NodeWeakReference): Node | undefined {
  try {
    const node = reference.deref();
    return isNodeLike(node) ? node : undefined;
  } catch {
    return undefined;
  }
}

function readContains(root: Node): ((other: Node) => unknown) | undefined {
  try {
    const candidate = root as unknown as { contains?: (other: Node) => boolean };
    return typeof candidate.contains === "function" ? candidate.contains : undefined;
  } catch {
    return undefined;
  }
}

function contains(
  root: Node,
  rootContains: (other: Node) => unknown,
  node: Node,
): boolean | undefined {
  try {
    const result = rootContains.call(root, node);
    return typeof result === "boolean" ? result : undefined;
  } catch {
    return undefined;
  }
}

function isShadowIncludingDescendant(root: Node, node: Node): boolean | undefined {
  let current: Node = node;
  let crossedShadowBoundary = false;
  const seen = new Set<Node>();
  for (let depth = 0; depth < MAX_SHADOW_ANCESTRY_DEPTH; depth += 1) {
    if (current === root) {
      return crossedShadowBoundary ? true : undefined;
    }
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    const parent = readNodeProperty(current, "parentNode");
    if (parent.kind === "invalid") {
      return undefined;
    }
    if (parent.kind === "node") {
      current = parent.value;
      continue;
    }

    const host = readOptionalNodeProperty(current, "host");
    if (host.kind === "invalid") {
      return undefined;
    }
    if (host.kind === "absent") {
      return false;
    }
    crossedShadowBoundary = true;
    current = host.value;
  }
  return undefined;
}

type NodePropertyResult =
  | { readonly kind: "node"; readonly value: Node }
  | { readonly kind: "null" }
  | { readonly kind: "invalid" };

function readNodeProperty(node: Node, property: "parentNode"): NodePropertyResult {
  try {
    const value = (node as unknown as Record<string, unknown>)[property];
    if (value === null) {
      return { kind: "null" };
    }
    return isNodeLike(value)
      ? { kind: "node", value }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

type OptionalNodePropertyResult =
  | { readonly kind: "node"; readonly value: Node }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

function readOptionalNodeProperty(
  node: Node,
  property: "host",
): OptionalNodePropertyResult {
  try {
    if (!Reflect.has(node as object, property)) {
      return { kind: "absent" };
    }
    const value = (node as unknown as Record<string, unknown>)[property];
    return isNodeLike(value)
      ? { kind: "node", value }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function createScopeKey(scope: NodeScope): string {
  return `${scope.documentEpoch}:${scope.frameRef}:${scope.frameEpoch}`;
}

function freezeScope(scope: NodeScope): NodeScope {
  return Object.freeze({
    documentEpoch: scope.documentEpoch,
    frameRef: scope.frameRef,
    frameEpoch: scope.frameEpoch,
  });
}

function sameScope(left: NodeScope, right: NodeScope): boolean {
  return (
    left.documentEpoch === right.documentEpoch &&
    left.frameRef === right.frameRef &&
    left.frameEpoch === right.frameEpoch
  );
}

function isNodeScope(value: NodeScope): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    isNonNegativeSafeInteger(value.documentEpoch) &&
    isFrameRef(value.frameRef) &&
    isNonNegativeSafeInteger(value.frameEpoch)
  );
}

function isNodeLike(value: unknown): value is Node {
  return typeof value === "object" && value !== null;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isRetentionReason(value: unknown): value is RetentionReason {
  return RETENTION_ORDER.includes(value as RetentionReason);
}

function isNodeRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REF_LENGTH && /^node-[1-9]\d*$/.test(value);
}

function isFrameRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REF_LENGTH && /^frame-[1-9]\d*$/.test(value);
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
