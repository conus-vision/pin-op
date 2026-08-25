import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  RULES_SOURCES_ENVELOPE_MAX_BYTES,
  RULES_SOURCES_LIMITS,
  RulesSourceSchema,
  utf8ByteLength,
  type InspectRuleEvidenceBatch,
  type RulesSourcesMessage,
} from "@pin-op/protocol";
import {
  RulesOpenAuthorityRegistry,
  type PreparedRuleOpenAuthorityGeneration,
  type StoredRuleOpenAuthority,
} from "./rulesOpenAuthorityRegistry.js";
import {
  projectRulesSource,
  type ResolvedRuleSource,
  type RulesSourceResolutionBatch,
} from "./rulesSourceResolver.js";

export type PublishedRulesSource = RulesSourcesMessage["sources"][number];

export interface RulesSourcesPublicationPayload {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly sources: readonly PublishedRulesSource[];
  readonly unresolvedRuleCount: number;
}

export interface RulesSourcesPublicationRequest {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly ruleEvidence: InspectRuleEvidenceBatch;
  readonly resolution: RulesSourceResolutionBatch;
  readonly workspaceGeneration: number;
}

export interface RulesSourcesPublicationOptions {
  readonly envelopeMaxBytes?: number;
  readonly measureEnvelopeBytes?: (
    payload: RulesSourcesPublicationPayload,
  ) => number;
  readonly createAuthorityId?: () => string;
}

export interface PreparedRulesSourcesPublication {
  readonly payload: RulesSourcesPublicationPayload;
  activate(): void;
  commit(): void;
  rollback(): void;
}

export const RULE_OPEN_AUTHORITY_PLACEHOLDER =
  "00000000-0000-4000-8000-000000000000";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ESCAPED_OPAQUE_ID = "\u0000".repeat(
  RESOLUTION_LIMITS.opaqueIdLength,
);

export class RulesSourcesPublication {
  private readonly envelopeMaxBytes: number;
  private readonly measureEnvelopeBytes: (
    payload: RulesSourcesPublicationPayload,
  ) => number;
  private readonly createAuthorityId: () => string;

  public constructor(
    private readonly registry: RulesOpenAuthorityRegistry,
    options: RulesSourcesPublicationOptions = {},
  ) {
    this.envelopeMaxBytes = options.envelopeMaxBytes ??
      RULES_SOURCES_ENVELOPE_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.envelopeMaxBytes) ||
      this.envelopeMaxBytes < 1 ||
      this.envelopeMaxBytes > RULES_SOURCES_ENVELOPE_MAX_BYTES
    ) {
      throw new Error("Rules sources envelope budget is invalid");
    }
    this.measureEnvelopeBytes = options.measureEnvelopeBytes ??
      measureConservativeEnvelope;
    this.createAuthorityId = options.createAuthorityId ?? randomUUID;
  }

  public prepare(
    request: RulesSourcesPublicationRequest,
  ): PreparedRulesSourcesPublication {
    validateRequest(request);
    const expectedRuleRefs = orderedUniqueRuleRefs(request.ruleEvidence);
    const resolved = uniqueResolvedByRuleRef(
      request.resolution,
      new Set(expectedRuleRefs),
    );
    const emptyPayload = freezePayload({
      inspectMessageId: request.inspectMessageId,
      rulesGeneration: request.rulesGeneration,
      sources: [],
      unresolvedRuleCount: expectedRuleRefs.length,
    });
    this.assertEnvelope(emptyPayload);

    const packed: Array<{
      readonly source: Omit<PublishedRulesSource, "openAuthorityId">;
      readonly resolved: ResolvedRuleSource;
    }> = [];
    let omittedTail = false;
    for (const ruleRef of expectedRuleRefs) {
      if (omittedTail) continue;
      const local = resolved.get(ruleRef);
      if (!local) continue;
      const projection = projectRulesSource(local);
      const source = {
        ...projection,
        openAuthorityId: RULE_OPEN_AUTHORITY_PLACEHOLDER,
      } satisfies PublishedRulesSource;
      const candidateSources = [
        ...packed.map((entry) => ({
          ...entry.source,
          openAuthorityId: RULE_OPEN_AUTHORITY_PLACEHOLDER,
        })),
        source,
      ];
      const candidate = freezePayload({
        inspectMessageId: request.inspectMessageId,
        rulesGeneration: request.rulesGeneration,
        sources: candidateSources,
        unresolvedRuleCount: expectedRuleRefs.length - candidateSources.length,
      });
      if (
        candidateSources.length > RULES_SOURCES_LIMITS.sources ||
        this.measure(candidate) > this.envelopeMaxBytes
      ) {
        omittedTail = true;
        continue;
      }
      const { openAuthorityId: _placeholder, ...publicSource } = source;
      packed.push({ source: publicSource, resolved: local });
    }

    const sources: PublishedRulesSource[] = [];
    const authorities: StoredRuleOpenAuthority[] = [];
    for (const entry of packed) {
      const openAuthorityId = this.createAuthorityId();
      if (
        openAuthorityId.length !== RULE_OPEN_AUTHORITY_PLACEHOLDER.length ||
        !UUID_PATTERN.test(openAuthorityId)
      ) {
        throw new Error("Rules open authority ID must be a fixed-length UUID");
      }
      const source = RulesSourceSchema.parse({
        ...entry.source,
        openAuthorityId,
      });
      sources.push(source);
      authorities.push({
        openAuthorityId,
        inspectMessageId: request.inspectMessageId,
        rulesGeneration: request.rulesGeneration,
        ruleRef: entry.resolved.ruleRef,
        documentUri: entry.resolved.document.uri,
        documentVersion: entry.resolved.document.version,
        range: entry.resolved.range,
        workspaceGeneration: request.workspaceGeneration,
        dependencies: entry.resolved.dependencies,
      });
    }
    const payload = freezePayload({
      inspectMessageId: request.inspectMessageId,
      rulesGeneration: request.rulesGeneration,
      sources,
      unresolvedRuleCount: expectedRuleRefs.length - sources.length,
    });
    if (
      payload.sources.length + payload.unresolvedRuleCount !==
        expectedRuleRefs.length
    ) {
      throw new Error("Rules sources publication is incomplete");
    }
    this.assertEnvelope(payload);
    const registryPreparation = this.registry.prepare({
      inspectMessageId: request.inspectMessageId,
      rulesGeneration: request.rulesGeneration,
      authorities,
    });
    return preparedPublication(this.registry, registryPreparation, payload);
  }

  private assertEnvelope(payload: RulesSourcesPublicationPayload): void {
    if (this.measure(payload) > this.envelopeMaxBytes) {
      throw new Error("Rules sources envelope exceeds its byte budget");
    }
  }

  private measure(payload: RulesSourcesPublicationPayload): number {
    const bytes = this.measureEnvelopeBytes(payload);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("Rules sources envelope measurement is invalid");
    }
    return bytes;
  }
}

function preparedPublication(
  registry: RulesOpenAuthorityRegistry,
  preparation: PreparedRuleOpenAuthorityGeneration,
  payload: RulesSourcesPublicationPayload,
): PreparedRulesSourcesPublication {
  return Object.freeze({
    payload,
    activate: () => registry.activate(preparation),
    commit: () => registry.commit(preparation),
    rollback: () => registry.rollback(preparation),
  });
}

function validateRequest(request: RulesSourcesPublicationRequest): void {
  if (
    request.inspectMessageId !== request.resolution.selectionMessageId ||
    request.inspectMessageId.length < 1 ||
    request.inspectMessageId.length > 128
  ) {
    throw new Error("Rules source resolution inspect ID does not match");
  }
  if (!Number.isSafeInteger(request.rulesGeneration) || request.rulesGeneration < 1) {
    throw new Error("Rules source generation is invalid");
  }
  if (
    !Number.isSafeInteger(request.workspaceGeneration) ||
    request.workspaceGeneration < 0
  ) {
    throw new Error("Rules source workspace generation is invalid");
  }
}

function orderedUniqueRuleRefs(
  evidence: InspectRuleEvidenceBatch,
): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rule of evidence.rules) {
    if (!seen.has(rule.ruleRef)) {
      seen.add(rule.ruleRef);
      ordered.push(rule.ruleRef);
    }
  }
  return ordered;
}

function uniqueResolvedByRuleRef(
  batch: RulesSourceResolutionBatch,
  expected: ReadonlySet<string>,
): ReadonlyMap<string, ResolvedRuleSource> {
  const resolved = new Map<string, ResolvedRuleSource>();
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const result of batch.results) {
    if (!expected.has(result.ruleRef)) continue;
    if (seen.has(result.ruleRef)) {
      resolved.delete(result.ruleRef);
      duplicates.add(result.ruleRef);
      continue;
    }
    seen.add(result.ruleRef);
    if (result.kind === "resolved") resolved.set(result.ruleRef, result);
  }
  return resolved;
}

function freezePayload(
  payload: RulesSourcesPublicationPayload,
): RulesSourcesPublicationPayload {
  return Object.freeze({
    inspectMessageId: payload.inspectMessageId,
    rulesGeneration: payload.rulesGeneration,
    sources: Object.freeze(payload.sources.map((source) => Object.freeze({
      ...source,
      document: Object.freeze({ ...source.document }),
    }))),
    unresolvedRuleCount: payload.unresolvedRuleCount,
  });
}

function measureConservativeEnvelope(
  payload: RulesSourcesPublicationPayload,
): number {
  return utf8ByteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: MAX_ESCAPED_OPAQUE_ID,
    sessionId: MAX_ESCAPED_OPAQUE_ID,
    source: { role: "ide", id: MAX_ESCAPED_OPAQUE_ID },
    ...payload,
    metadata: {},
  }));
}
