import {
  INSPECT_LIMITS,
  type DomAttributeFact,
  type InspectSubject,
  type InspectTarget,
  type RuntimeFact,
} from "@pin-op/protocol";

/**
 * The browser sends the selected element's identity in the target subject.
 * Template resolvers dispatch on fact kinds, so the host restates that bounded
 * identity as the built-in `dom-attribute` facts the plugin contract documents.
 * Nothing here reaches the wire; it only shapes the host-side snapshot.
 */
const MAX_DOM_ATTRIBUTE_FACTS = 32;

export interface DomSubjectIdentity {
  readonly tag: string | undefined;
  readonly id: string | undefined;
  readonly classes: readonly string[];
  readonly attributes: ReadonlyMap<string, string>;
}

export function withDomAttributeFacts(
  targets: readonly InspectTarget[],
): readonly InspectTarget[] {
  return targets.map((target) => {
    const added = domAttributeFacts(target.subject).filter(
      (fact) => !hasFact(target.facts, fact),
    );
    if (added.length === 0) return target;
    const room = Math.max(0, INSPECT_LIMITS.factsPerTarget - target.facts.length);
    if (room === 0) return target;
    return { ...target, facts: [...target.facts, ...added.slice(0, room)] };
  });
}

export function domAttributeFacts(
  subject: InspectSubject,
): readonly DomAttributeFact[] {
  const identity = domSubjectIdentity(subject);
  const facts: DomAttributeFact[] = [];
  if (identity.id) {
    facts.push(domAttributeFact("id", identity.id));
  }
  if (identity.classes.length > 0) {
    facts.push(domAttributeFact("class", identity.classes.join(" ")));
  }
  for (const [name, value] of identity.attributes) {
    if (facts.length >= MAX_DOM_ATTRIBUTE_FACTS) break;
    facts.push(domAttributeFact(name, value));
  }
  return facts;
}

/** Reads the bounded DOM identity a template resolver can search for. */
export function domSubjectIdentity(subject: InspectSubject): DomSubjectIdentity {
  const metadata = subject.metadata as Record<string, unknown> | undefined;
  const attributes = new Map<string, string>();
  for (const attribute of subject.attributes ?? []) {
    const name = attribute.name.toLowerCase();
    if (name === "id" || name === "class" || attributes.has(name)) continue;
    attributes.set(name, attribute.value);
  }
  return {
    tag: boundedIdentifier(metadata?.["tag"]),
    id: boundedIdentifier(metadata?.["id"]) ?? boundedIdentifier(subject.nodeId),
    classes: boundedClasses(metadata?.["classes"]),
    attributes,
  };
}

/**
 * Reads a target's DOM identity from the `dom-attribute` facts a resolver
 * declares, falling back to the subject for the tag name the facts cannot
 * carry. Returns `undefined` when the target carries no DOM evidence at all.
 */
export function targetDomIdentity(
  target: InspectTarget,
): DomSubjectIdentity | undefined {
  const attributes = new Map<string, string>();
  let id: string | undefined;
  let classes: readonly string[] = [];
  for (const fact of target.facts) {
    if (!isDomAttributeFact(fact)) continue;
    const name = fact.name.toLowerCase();
    if (name === "id") {
      id ??= boundedIdentifier(fact.value);
      continue;
    }
    if (name === "class") {
      if (classes.length === 0) classes = boundedClasses(splitClasses(fact.value));
      continue;
    }
    if (!attributes.has(name)) attributes.set(name, fact.value);
  }
  if (id === undefined && classes.length === 0 && attributes.size === 0) {
    return undefined;
  }
  return {
    tag: domSubjectIdentity(target.subject).tag,
    id,
    classes,
    attributes,
  };
}

function splitClasses(value: string): readonly string[] {
  return value.split(/\s+/u).filter((token) => token.length > 0);
}

/**
 * `PluginRuntimeFact.type` is an open string, so the runtime-fact union does
 * not discriminate on its own.
 */
export function isDomAttributeFact(fact: RuntimeFact): fact is DomAttributeFact {
  return fact.type === "dom-attribute" && "name" in fact && "value" in fact;
}

function domAttributeFact(name: string, value: string): DomAttributeFact {
  return {
    type: "dom-attribute",
    name: name.slice(0, INSPECT_LIMITS.attributeNameLength),
    value: value.slice(0, INSPECT_LIMITS.valueLength),
    metadata: {},
  };
}

function hasFact(
  facts: readonly RuntimeFact[],
  candidate: DomAttributeFact,
): boolean {
  return facts.some(
    (fact) => isDomAttributeFact(fact) && fact.name === candidate.name,
  );
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, INSPECT_LIMITS.attributeNameLength).trim();
  return bounded.length > 0 ? bounded : undefined;
}

function boundedClasses(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const classes: string[] = [];
  for (const entry of value) {
    if (classes.length >= INSPECT_LIMITS.classNames) break;
    const bounded = boundedIdentifier(entry);
    if (bounded && !classes.includes(bounded)) classes.push(bounded);
  }
  return classes;
}
