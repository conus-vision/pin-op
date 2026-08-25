import type { SelectionSnapshot } from "@pin-op/plugin-api";
import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type InspectRuleContext,
  type InspectRuleEvidence,
  type RuntimeFact,
} from "@pin-op/protocol";
import { declarationEvidenceFromFact } from "./declarationFingerprint.js";
import type { CssDeclarationEvidence } from "./types.js";

export interface TargetCssFact {
  readonly targetRole: "selected" | "parent";
  readonly fact: CssResolutionFact;
  readonly sourceUrl: string;
  readonly declarations: readonly CssDeclarationEvidence[];
}

export interface CompleteCssRuleEvidence {
  readonly selector: string;
  readonly declarations: readonly CssDeclarationEvidence[];
  readonly contexts: readonly InspectRuleContext[];
}

export function completeCssRuleEvidence(
  evidence: InspectRuleEvidence,
): CompleteCssRuleEvidence | undefined {
  const generated = evidence.generatedSource;
  if (
    !generated ||
    evidence.declarationsTruncated ||
    evidence.declarations.some((declaration) => declaration.valueTruncated) ||
    generated.contextsTruncated ||
    generated.unsupportedGroupContext
  ) {
    return undefined;
  }
  return {
    selector: evidence.selector,
    declarations: evidence.declarations.map((declaration) => ({
      property: declaration.property,
      value: declaration.value,
      important: declaration.important,
      valueComplete: true,
    })),
    contexts: generated.contexts,
  };
}

/** IDE-local correlated view. Selector/source/context remain owned by evidence on wire. */
export type CssResolutionFact = Omit<CssRuleFact, "metadata"> & {
  readonly selector: string;
  readonly source?: {
    readonly uri: string;
    readonly line: number;
    readonly column: number;
  };
  readonly metadata: Readonly<Record<string, unknown>>;
};

export function targetCssFacts(
  selection: SelectionSnapshot,
): TargetCssFact[] {
  const unique = new Map<string, {
    readonly targetRole: TargetCssFact["targetRole"];
    readonly fact: CssResolutionFact;
    readonly sourceUrl: string;
    readonly declarations: CssDeclarationEvidence[];
    readonly declarationKeys: Set<string>;
  }>();
  const evidenceByRef = new Map(
    selection.ruleEvidence.rules.map((evidence) => [
      evidence.ruleRef,
      evidence,
    ] as const),
  );
  let unstableFactIndex = 0;
  for (const target of selection.targets) {
    for (const fact of target.facts) {
      if (fact.type !== "css-rule") continue;
      if (!isCssRuleFact(fact)) continue;
      const evidence = evidenceByRef.get(fact.ruleRef);
      const correlatedFact = evidence
        ? correlateCssFact(fact, evidence)
        : undefined;
      if (!correlatedFact) continue;
      const sourceUrl = cssFactSourceUrl(correlatedFact);
      if (!sourceUrl) continue;
      const stableIdentity = stableCssRuleIdentity(correlatedFact);
      const key = JSON.stringify([
        target.role,
        sourceUrl,
        correlatedFact.selector,
        stableIdentity ?? `unstable:${unstableFactIndex++}`,
        correlatedFact.metadata.media ?? null,
        correlatedFact.metadata.mediaTruncated ?? null,
      ]);
      let entry = unique.get(key);
      if (!entry) {
        entry = {
          targetRole: target.role,
          fact: correlatedFact,
          sourceUrl,
          declarations: [],
          declarationKeys: new Set(),
        };
        unique.set(key, entry);
      }
      const declaration = declarationEvidenceFromFact(correlatedFact);
      if (!declaration) continue;
      const declarationKey = JSON.stringify(declaration);
      if (!entry.declarationKeys.has(declarationKey)) {
        entry.declarationKeys.add(declarationKey);
        entry.declarations.push(declaration);
      }
    }
  }
  return [...unique.values()].map((entry) => ({
    targetRole: entry.targetRole,
    fact: entry.fact,
    sourceUrl: entry.sourceUrl,
    declarations: entry.declarations,
  }));
}

export function stableCssRuleIdentity(
  fact: CssResolutionFact,
): string | undefined {
  if (fact.source !== undefined) {
    return validSourcePosition(fact.source.line, fact.source.column) &&
        typeof fact.source.uri === "string" &&
        fact.source.uri.length > 0 &&
        fact.source.uri.length <= INSPECT_LIMITS.urlLength
      ? JSON.stringify([
        "source",
        fact.source.uri,
        fact.source.line,
        fact.source.column,
      ])
      : undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(fact.metadata, "rulePath")) {
    return undefined;
  }
  const path = parseBrowserRulePath(fact.metadata.rulePath);
  return path === undefined
    ? undefined
    : JSON.stringify(["rule-path", fact.metadata.rulePath]);
}

export function parseBrowserRulePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > INSPECT_LIMITS.selectorLength
  ) {
    return undefined;
  }
  const segments = value.split(".");
  if (
    segments.length < 2 ||
    segments.length > INSPECT_LIMITS.cssRuleDepth + 2
  ) {
    return undefined;
  }
  for (const [index, segment] of segments.entries()) {
    if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
    const numeric = Number(segment);
    const upperBound = index === 0
      ? INSPECT_LIMITS.stylesheets
      : INSPECT_LIMITS.cssRules;
    if (!Number.isSafeInteger(numeric) || numeric >= upperBound) {
      return undefined;
    }
  }
  return segments.slice(1).join(".");
}

function validSourcePosition(line: number, column: number): boolean {
  return Number.isSafeInteger(line) &&
    Number.isSafeInteger(column) &&
    line >= 1 &&
    column >= 1;
}

function isCssRuleFact(fact: RuntimeFact): fact is CssRuleFact {
  return fact.type === "css-rule" &&
    "ruleRef" in fact &&
    "property" in fact &&
    "value" in fact &&
    "important" in fact &&
    "valueTruncated" in fact;
}

export function cssFactSourceUrl(
  fact: CssResolutionFact,
): string | undefined {
  for (const candidate of [
    fact.metadata.sourceUrl,
    fact.metadata.stylesheet,
    fact.source?.uri,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function correlateCssFact(
  fact: CssRuleFact,
  evidence: InspectRuleEvidence,
): CssResolutionFact | undefined {
  const generated = evidence.generatedSource;
  if (
    !generated ||
    fact.valueTruncated ||
    generated.contextsTruncated ||
    generated.unsupportedGroupContext
  ) {
    return undefined;
  }
  const media = generated.contexts
    .filter((context) => context.kind === "media")
    .map((context) => context.conditionText);
  const unsupportedForLegacyResolver = generated.contexts.some(
    (context) => context.kind === "supports",
  );
  const metadata: Readonly<Record<string, unknown>> = {
    sourceUrl: generated.sourceUrl,
    media,
    mediaTruncated: generated.contextsTruncated ||
      generated.unsupportedGroupContext || unsupportedForLegacyResolver,
    contexts: generated.contexts,
    contextsTruncated: generated.contextsTruncated,
    unsupportedGroupContext: generated.unsupportedGroupContext,
    declarationsTruncated: evidence.declarationsTruncated,
    important: fact.important,
    valueTruncated: fact.valueTruncated,
    ...(generated.rulePath === undefined
      ? {}
      : { rulePath: generated.rulePath }),
  };
  return {
    ...fact,
    selector: evidence.selector,
    ...(generated.startLine !== undefined &&
        generated.startColumn !== undefined
      ? {
          source: {
            uri: generated.sourceUrl,
            line: generated.startLine,
            column: generated.startColumn,
          },
        }
      : {}),
    metadata,
  };
}
