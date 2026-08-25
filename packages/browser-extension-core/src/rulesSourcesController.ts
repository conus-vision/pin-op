import {
  RESOLUTION_LIMITS,
  RULES_SOURCES_LIMITS,
  RulesSourcesMessageSchema,
  type RulesSourcesMessage,
} from "@pin-op/protocol";
import { parseRulesSourcesProtocolData } from "./protocolDataSnapshot.js";
import type { PanelRulesOpenCommand } from "./inspectPortProtocol.js";

export type RulesOriginState =
  | "pending"
  | "ready"
  | "stale"
  | "incompatible";

export interface RuleOrigin {
  readonly label: string;
  readonly languageId: "css" | "scss";
  readonly startLine: number;
  readonly startColumn: number;
  readonly confidence: "exact" | "sourcemap";
  readonly clickable: true;
}

export type RulesSourcesInvalidationReason =
  | "disconnect"
  | "stylesheet-refresh"
  | "page-refresh"
  | "document-navigation"
  | "frame-navigation"
  | "transport-invalidation";

interface StoredOrigin extends RuleOrigin {
  readonly openAuthorityId: string;
}

interface InspectAuthority {
  readonly inspectMessageId: string;
  readonly expectedRuleRefs: ReadonlySet<string>;
  rulesGeneration: number;
  origins: ReadonlyMap<string, StoredOrigin>;
}

export class RulesSourcesController {
  private authority: InspectAuthority | undefined;
  private readonly listeners = new Set<() => void>();
  private compatible = true;
  private state: RulesOriginState = "pending";
  private disposed = false;

  public constructor(
    private readonly dispatch: (command: PanelRulesOpenCommand) => void,
  ) {}

  public beginInspect(
    inspectMessageId: string,
    expectedRuleRefs: ReadonlySet<string>,
  ): void {
    if (this.disposed || !this.compatible || !isOpaqueId(inspectMessageId)) {
      return;
    }
    const refs = copyExpectedRefs(expectedRuleRefs);
    if (!refs) return;
    this.authority = {
      inspectMessageId,
      expectedRuleRefs: refs,
      rulesGeneration: 0,
      origins: new Map(),
    };
    this.state = "pending";
    this.publish();
  }

  public accept(message: unknown): "published" | "ignored" {
    if (this.disposed || !this.compatible || !this.authority) {
      return "ignored";
    }
    const parsed = parseRulesSourcesProtocolData(
      message,
      RulesSourcesMessageSchema,
    );
    const authority = this.authority;
    if (
      !parsed ||
      parsed.inspectMessageId !== authority.inspectMessageId ||
      (authority.rulesGeneration === 0
        ? parsed.rulesGeneration !== 1
        : parsed.rulesGeneration <= authority.rulesGeneration) ||
      !coversExpectedRules(parsed, authority.expectedRuleRefs)
    ) {
      return "ignored";
    }

    const origins = new Map<string, StoredOrigin>();
    for (const source of parsed.sources) {
      origins.set(source.ruleRef, Object.freeze({
        label: source.document.label,
        languageId: source.document.languageId,
        startLine: source.startLine,
        startColumn: source.startColumn,
        confidence: source.confidence,
        clickable: true,
        openAuthorityId: source.openAuthorityId,
      }));
    }
    authority.rulesGeneration = parsed.rulesGeneration;
    authority.origins = origins;
    this.state = "ready";
    this.publish();
    return "published";
  }

  public originFor(ruleRef: string): RuleOrigin | undefined {
    if (this.disposed || this.state !== "ready") return undefined;
    const source = this.authority?.origins.get(ruleRef);
    return source
      ? Object.freeze({
          label: source.label,
          languageId: source.languageId,
          startLine: source.startLine,
          startColumn: source.startColumn,
          confidence: source.confidence,
          clickable: true,
        })
      : undefined;
  }

  public status(): RulesOriginState {
    return this.state;
  }

  public open(ruleRef: string): void {
    if (this.disposed || this.state !== "ready") return;
    const authority = this.authority;
    const source = authority?.origins.get(ruleRef);
    if (!authority || !source) return;
    this.dispatch(Object.freeze({
      type: "pin-op.rules.open",
      inspectMessageId: authority.inspectMessageId,
      rulesGeneration: authority.rulesGeneration,
      openAuthorityId: source.openAuthorityId,
    }));
  }

  public invalidatePublication(
    inspectMessageId: string,
    rulesGeneration: number,
  ): void {
    const authority = this.authority;
    if (
      this.disposed ||
      this.state !== "ready" ||
      !authority ||
      !isOpaqueId(inspectMessageId) ||
      !Number.isSafeInteger(rulesGeneration) ||
      rulesGeneration <= 0 ||
      rulesGeneration > RESOLUTION_LIMITS.generation ||
      authority.inspectMessageId !== inspectMessageId ||
      authority.rulesGeneration !== rulesGeneration
    ) {
      return;
    }
    this.invalidate("transport-invalidation");
  }

  public invalidate(_reason: RulesSourcesInvalidationReason): void {
    if (this.disposed) return;
    const nextState = this.compatible ? "stale" : "incompatible";
    const changed = this.authority !== undefined || this.state !== nextState;
    this.authority = undefined;
    this.state = nextState;
    if (changed) this.publish();
  }

  public setCompatible(compatible: boolean): void {
    if (this.disposed || this.compatible === compatible) return;
    this.compatible = compatible;
    this.authority = undefined;
    this.state = compatible ? "pending" : "incompatible";
    this.publish();
  }

  public subscribe(listener: () => void): () => void {
    if (this.disposed) {
      throw new Error("Rules sources controller is disposed");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.authority = undefined;
    this.listeners.clear();
    this.state = "stale";
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function copyExpectedRefs(
  expectedRuleRefs: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  try {
    if (
      expectedRuleRefs.size > RULES_SOURCES_LIMITS.sources ||
      !Number.isSafeInteger(expectedRuleRefs.size)
    ) {
      return undefined;
    }
    const refs = new Set<string>();
    for (const ruleRef of expectedRuleRefs) {
      if (!isOpaqueId(ruleRef)) return undefined;
      refs.add(ruleRef);
    }
    return refs;
  } catch {
    return undefined;
  }
}

function coversExpectedRules(
  message: RulesSourcesMessage,
  expectedRuleRefs: ReadonlySet<string>,
): boolean {
  if (
    message.sources.length + message.unresolvedRuleCount !==
      expectedRuleRefs.size
  ) {
    return false;
  }
  return message.sources.every(({ ruleRef }) => expectedRuleRefs.has(ruleRef));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= RESOLUTION_LIMITS.opaqueIdLength;
}
