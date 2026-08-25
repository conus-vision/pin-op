import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  RULES_SOURCES_ENVELOPE_MAX_BYTES,
  type InspectRuleEvidenceBatch,
} from "@pin-op/protocol";
import { RulesOpenAuthorityRegistry } from
  "../src/rules/rulesOpenAuthorityRegistry.js";
import {
  RulesSourcesPublication,
  type RulesSourcesPublicationPayload,
} from "../src/rules/rulesSourcesPublication.js";
import type {
  ResolvedRuleSource,
  RulesSourceResolutionBatch,
} from "../src/rules/rulesSourceResolver.js";

describe("RulesSourcesPublication", () => {
  it("preserves unique evidence order and prepares only complete public entries", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const ids = [uuid(1), uuid(2)];
    const publication = publisher(registry, {
      createAuthorityId: () => ids.shift()!,
    });
    const prepared = publication.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a", "rule-b", "rule-c"),
      resolution: batch(
        resolved("rule-c", "file:///workspace/src/card.scss", "scss"),
        resolved("rule-a", "file:///workspace/dist/app.css", "css"),
        { kind: "unresolved", ruleRef: "rule-b", reason: "missing-map" },
      ),
      workspaceGeneration: 7,
    });

    expect(prepared.payload).toEqual({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [
        {
          ruleRef: "rule-a",
          document: { label: "app.css", languageId: "css" },
          startLine: 2,
          startColumn: 3,
          confidence: "exact",
          openAuthorityId: uuid(1),
        },
        {
          ruleRef: "rule-c",
          document: { label: "card.scss", languageId: "scss" },
          startLine: 2,
          startColumn: 3,
          confidence: "sourcemap",
          openAuthorityId: uuid(2),
        },
      ],
      unresolvedRuleCount: 1,
    });
    expect(JSON.stringify(prepared.payload)).not.toContain("file:///workspace");
    expect(JSON.stringify(prepared.payload)).not.toContain("contentHash");
    expect(JSON.stringify(prepared.payload)).not.toContain('"range"');

    prepared.activate();
    expect(registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: uuid(1),
    })).toMatchObject({
      documentUri: "file:///workspace/dist/app.css",
      workspaceGeneration: 7,
    });
    prepared.commit();
  });

  it("counts duplicate evidence once and maintains completeness", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const prepared = publisher(registry).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a", "rule-a", "rule-b"),
      resolution: batch(
        { kind: "unresolved", ruleRef: "rule-a", reason: "duplicate-rule-ref" },
        resolved("rule-b"),
      ),
      workspaceGeneration: 0,
    });

    expect(prepared.payload.sources.map((source) => source.ruleRef))
      .toEqual(["rule-b"]);
    expect(prepared.payload.unresolvedRuleCount).toBe(1);
    expect(
      prepared.payload.sources.length + prepared.payload.unresolvedRuleCount,
    ).toBe(2);
  });

  it("fails a rule closed when the resolver returns its ref more than once", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const prepared = publisher(registry).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a"),
      resolution: batch(
        { kind: "unresolved", ruleRef: "rule-a", reason: "first" },
        resolved("rule-a"),
      ),
      workspaceGeneration: 0,
    });

    expect(prepared.payload).toMatchObject({
      sources: [],
      unresolvedRuleCount: 1,
    });
  });

  it("budgets the real UTF-8 envelope with fixed-length placeholders", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const measure = vi.fn(measureEnvelope);
    const first = resolved("rule-a");
    const second = resolved(
      "rule-b",
      "file:///workspace/src/карточка.scss",
      "scss",
    );
    const oneSourceBudget = measureEnvelope({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [{
        ruleRef: "rule-a",
        document: { label: "app.css", languageId: "css" },
        startLine: 2,
        startColumn: 3,
        confidence: "exact",
        openAuthorityId: uuid(0),
      }],
      unresolvedRuleCount: 2,
    });
    const prepared = publisher(registry, {
      envelopeMaxBytes: oneSourceBudget,
      measureEnvelopeBytes: measure,
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a", "rule-b", "rule-c"),
      resolution: batch(first, second, resolved("rule-c")),
      workspaceGeneration: 0,
    });

    expect(prepared.payload.sources.map((source) => source.ruleRef))
      .toEqual(["rule-a"]);
    expect(prepared.payload.unresolvedRuleCount).toBe(2);
    expect(measure(prepared.payload)).toBeLessThanOrEqual(oneSourceBudget);
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({
      sources: [expect.objectContaining({
        openAuthorityId: "00000000-0000-4000-8000-000000000000",
      })],
    }));
  });

  it("budgets maximum JSON-escaped opaque IDs in the default envelope", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const empty: RulesSourcesPublicationPayload = {
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [],
      unresolvedRuleCount: 1,
    };
    const prepared = new RulesSourcesPublication(registry, {
      envelopeMaxBytes: measureEscapedMaximumEnvelope(empty),
      createAuthorityId: () => uuid(1),
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a"),
      resolution: batch(resolved("rule-a")),
      workspaceGeneration: 0,
    });

    expect(prepared.payload.sources).toEqual([]);
    expect(prepared.payload.unresolvedRuleCount).toBe(1);
  });

  it("omits every later resolved entry after the first envelope overflow", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const firstPayload: RulesSourcesPublicationPayload = {
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [{
        ruleRef: "rule-a",
        document: { label: "app.css", languageId: "css" },
        startLine: 2,
        startColumn: 3,
        confidence: "exact",
        openAuthorityId: uuid(0),
      }],
      unresolvedRuleCount: 2,
    };
    const prepared = publisher(registry, {
      envelopeMaxBytes: measureEnvelope(firstPayload),
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a", "rule-b", "rule-c"),
      resolution: batch(
        resolved("rule-a"),
        resolved("rule-b", `file:///workspace/${"x".repeat(110)}.css`),
        resolved("rule-c"),
      ),
      workspaceGeneration: 0,
    });

    expect(prepared.payload.sources.map((source) => source.ruleRef))
      .toEqual(["rule-a"]);
    expect(prepared.payload.unresolvedRuleCount).toBe(2);
  });

  it("does not generate authorities for entries omitted from the final envelope", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const createAuthorityId = vi.fn(() => uuid(1));
    const emptyBudget = measureEnvelope({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      sources: [],
      unresolvedRuleCount: 1,
    });
    const prepared = publisher(registry, {
      createAuthorityId,
      envelopeMaxBytes: emptyBudget,
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a"),
      resolution: batch(resolved(
        "rule-a",
        `file:///workspace/${"a".repeat(110)}.css`,
      )),
      workspaceGeneration: 0,
    });

    expect(prepared.payload.sources).toEqual([]);
    expect(prepared.payload.unresolvedRuleCount).toBe(1);
    expect(createAuthorityId).not.toHaveBeenCalled();
  });

  it("restores only a prior same-inspect registry snapshot on rollback", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const first = publisher(registry, {
      createAuthorityId: () => uuid(1),
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a"),
      resolution: batch(resolved("rule-a")),
      workspaceGeneration: 0,
    });
    first.activate();
    first.commit();

    const replacement = publisher(registry, {
      createAuthorityId: () => uuid(2),
    }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 2,
      ruleEvidence: evidence("rule-a"),
      resolution: batch(resolved("rule-a")),
      workspaceGeneration: 0,
    });
    replacement.activate();
    replacement.rollback();
    expect(registry.authorize({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      openAuthorityId: uuid(1),
    })).toBeDefined();

    const foreign = publisher(registry, {
      createAuthorityId: () => uuid(3),
    }).prepare({
      inspectMessageId: "inspect-2",
      rulesGeneration: 3,
      ruleEvidence: evidence("rule-a"),
      resolution: {
        ...batch(resolved("rule-a")),
        selectionMessageId: "inspect-2",
      },
      workspaceGeneration: 0,
    });
    foreign.activate();
    foreign.rollback();
    expect(registry.current()).toBeUndefined();
  });

  it("rejects mismatched batches and envelopes that cannot fit even empty", () => {
    const registry = new RulesOpenAuthorityRegistry();
    const publication = publisher(registry);

    expect(() => publication.prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence("rule-a"),
      resolution: { ...batch(resolved("rule-a")), selectionMessageId: "other" },
      workspaceGeneration: 0,
    })).toThrow(/inspect/i);
    expect(() => publisher(registry, { envelopeMaxBytes: 1 }).prepare({
      inspectMessageId: "inspect-1",
      rulesGeneration: 1,
      ruleEvidence: evidence(),
      resolution: batch(),
      workspaceGeneration: 0,
    })).toThrow(/envelope/i);
  });
});

function publisher(
  registry: RulesOpenAuthorityRegistry,
  overrides: Partial<ConstructorParameters<typeof RulesSourcesPublication>[1]> = {},
): RulesSourcesPublication {
  let id = 0;
  return new RulesSourcesPublication(registry, {
    envelopeMaxBytes: RULES_SOURCES_ENVELOPE_MAX_BYTES,
    measureEnvelopeBytes: measureEnvelope,
    createAuthorityId: () => uuid(++id),
    ...overrides,
  });
}

function measureEnvelope(payload: RulesSourcesPublicationPayload): number {
  return Buffer.byteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: "00000000-0000-4000-8000-000000000000",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-test" },
    ...payload,
    metadata: {},
  }), "utf8");
}

function measureEscapedMaximumEnvelope(
  payload: RulesSourcesPublicationPayload,
): number {
  const opaque = "\u0000".repeat(128);
  return Buffer.byteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: opaque,
    sessionId: opaque,
    source: { role: "ide", id: opaque },
    ...payload,
    metadata: {},
  }), "utf8");
}

function evidence(...ruleRefs: string[]): InspectRuleEvidenceBatch {
  return {
    rules: ruleRefs.map((ruleRef) => ({
      ruleRef,
      selector: `.${ruleRef}`,
      declarations: [{
        property: "color",
        value: "red",
        important: false,
        valueTruncated: false,
      }],
      declarationsTruncated: false,
      generatedSource: {
        sourceUrl: "http://localhost:4173/dist/app.css",
        rulePath: "0.0",
        contexts: [],
        contextsTruncated: false,
        unsupportedGroupContext: false,
      },
    })),
    omittedRuleCount: 0,
  };
}

function batch(
  ...results: RulesSourceResolutionBatch["results"]
): RulesSourceResolutionBatch {
  return { selectionMessageId: "inspect-1", results };
}

function resolved(
  ruleRef: string,
  uri = "file:///workspace/dist/app.css",
  languageId: "css" | "scss" = "css",
): ResolvedRuleSource {
  const mapped = languageId === "scss";
  return {
    kind: "resolved",
    ruleRef,
    document: { uri, languageId, version: mapped ? 3 : 2 },
    range: {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 1 },
    },
    confidence: mapped ? "sourcemap" : "exact",
    dependencies: mapped
      ? [
          dependency("generated-css", "file:///workspace/dist/app.css", 1),
          dependency("original-source", uri, 3),
        ]
      : [dependency("generated-css", uri, 2)],
  };
}

function dependency(
  kind: ResolvedRuleSource["dependencies"][number]["kind"],
  uri: string,
  version: number,
): ResolvedRuleSource["dependencies"][number] {
  return {
    kind,
    uri,
    documentVersion: version,
    contentHash: version.toString(16).padStart(64, "0"),
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
