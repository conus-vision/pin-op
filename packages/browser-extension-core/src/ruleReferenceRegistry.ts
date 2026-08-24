import { INSPECT_LIMITS } from "@pin-op/protocol";
import { isValidContentSessionId } from "./inspectPortProtocol.js";

export const RULE_REFERENCE_MAX_LENGTH = 128;
export const RULE_REFERENCE_MAX_ENTRIES = INSPECT_LIMITS.cssRules;

export interface RuleReferenceScope {
  readonly contentSessionId: string;
  readonly documentEpoch: number;
  readonly stylesheetRevision: number;
}

export interface RuleReferenceGeneration {
  readonly contentSessionId?: string;
  readonly documentEpoch: number;
  readonly stylesheetRevision: number;
}

interface RuleReferenceEntry {
  readonly nativeRule: object;
  readonly sheetIdentity: string;
  readonly rulePath: string;
  readonly scope: RuleReferenceScope;
}

const RULE_REFERENCE_PATTERN = /^rule-[A-Za-z0-9_-]+$/;

/**
 * Keeps native CSSOM rules behind generation-bound, unguessable references.
 * A reset is the lifecycle boundary for navigation, stylesheet replacement,
 * content-lease replacement, and frame teardown; dispose is terminal.
 */
export class RuleReferenceRegistry {
  private scope: RuleReferenceScope;
  private forward = new WeakMap<object, Map<string, Map<string, string>>>();
  private reverse = new Map<string, RuleReferenceEntry>();
  private disposed = false;

  public constructor(scope: RuleReferenceScope) {
    this.scope = freezeScope(requireScope(scope));
  }

  public get size(): number {
    return this.reverse.size;
  }

  public reference(
    sheetIdentity: string,
    rulePath: string,
    nativeRule: object,
  ): string {
    this.requireLive();
    requireSheetIdentity(sheetIdentity);
    requireRulePath(rulePath);
    if (typeof nativeRule !== "object" || nativeRule === null) {
      throw new TypeError("nativeRule must be an object");
    }

    const sheets = this.forward.get(nativeRule);
    const existing = sheets?.get(sheetIdentity)?.get(rulePath);
    if (existing) return existing;
    if (this.reverse.size >= RULE_REFERENCE_MAX_ENTRIES) {
      throw new Error("RuleReferenceRegistry capacity exceeded");
    }

    const ruleRef = this.createUniqueReference();
    const entry: RuleReferenceEntry = {
      nativeRule,
      sheetIdentity,
      rulePath,
      scope: this.scope,
    };
    const nextSheets = sheets ?? new Map<string, Map<string, string>>();
    const paths = nextSheets.get(sheetIdentity) ?? new Map<string, string>();
    paths.set(rulePath, ruleRef);
    nextSheets.set(sheetIdentity, paths);
    this.forward.set(nativeRule, nextSheets);
    this.reverse.set(ruleRef, entry);
    return ruleRef;
  }

  /** Internal native lookup; callers must present the complete live generation. */
  public resolve(
    ruleRef: string,
    scope: RuleReferenceScope,
  ): object | undefined {
    if (
      this.disposed ||
      !isRuleReference(ruleRef) ||
      !isScope(scope) ||
      !sameScope(scope, this.scope)
    ) {
      return undefined;
    }
    const entry = this.reverse.get(ruleRef);
    return entry && sameScope(entry.scope, scope)
      ? entry.nativeRule
      : undefined;
  }

  public reset(generation: RuleReferenceGeneration): void {
    this.requireLive();
    const nextScope = requireScope({
      contentSessionId: generation.contentSessionId ?? this.scope.contentSessionId,
      documentEpoch: generation.documentEpoch,
      stylesheetRevision: generation.stylesheetRevision,
    });
    this.scope = freezeScope(nextScope);
    this.forward = new WeakMap<object, Map<string, Map<string, string>>>();
    this.reverse.clear();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.forward = new WeakMap<object, Map<string, Map<string, string>>>();
    this.reverse.clear();
  }

  private requireLive(): void {
    if (this.disposed) {
      throw new Error("RuleReferenceRegistry is disposed");
    }
  }

  private createUniqueReference(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = createRandomReference();
      if (!this.reverse.has(candidate)) return candidate;
    }
    throw new Error("RuleReferenceRegistry could not allocate a unique reference");
  }
}

function createRandomReference(): string {
  const crypto = globalThis.crypto;
  let opaque: string | undefined;
  if (crypto && typeof crypto.randomUUID === "function") {
    opaque = crypto.randomUUID();
  } else if (crypto && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    opaque = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }
  const ruleRef = opaque ? `rule-${opaque}` : "";
  if (!isRuleReference(ruleRef)) {
    throw new Error("secure random rule references are unavailable");
  }
  return ruleRef;
}

function requireScope(scope: RuleReferenceScope): RuleReferenceScope {
  if (!isScope(scope)) {
    throw new TypeError("rule reference scope is invalid");
  }
  return scope;
}

function isScope(value: RuleReferenceScope): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    isValidContentSessionId(value.contentSessionId) &&
    isGeneration(value.documentEpoch) &&
    isGeneration(value.stylesheetRevision)
  );
}

function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function freezeScope(scope: RuleReferenceScope): RuleReferenceScope {
  return Object.freeze({ ...scope });
}

function sameScope(left: RuleReferenceScope, right: RuleReferenceScope): boolean {
  return (
    left.contentSessionId === right.contentSessionId &&
    left.documentEpoch === right.documentEpoch &&
    left.stylesheetRevision === right.stylesheetRevision
  );
}

function requireSheetIdentity(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > INSPECT_LIMITS.selectorLength
  ) {
    throw new TypeError("sheetIdentity is invalid");
  }
}

function requireRulePath(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > INSPECT_LIMITS.selectorLength ||
    !/^\d+(?:\.\d+)*$/.test(value)
  ) {
    throw new TypeError("rulePath is invalid");
  }
}

function isRuleReference(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= RULE_REFERENCE_MAX_LENGTH &&
    RULE_REFERENCE_PATTERN.test(value)
  );
}
