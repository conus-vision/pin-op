import {
  INSPECT_LIMITS,
  InspectGeneratedSourceSchema,
  InspectRuleEvidenceSchema,
  RULE_EVIDENCE_LIMITS,
  RULES_SOURCES_LIMITS,
  canonicalizePublicStylesheetUrl,
  type CssRuleFact,
  type InspectGeneratedSource,
  type InspectRuleContext,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
} from "@pin-op/protocol";
import {
  consumeJsonBudget,
  createInspectByteBudget,
  type InspectByteBudget,
} from "./inspectBounds.js";
import type { InaccessibleStylesheet } from "./cssRuleWalker.js";
import type { MatchedRule, MatchedStyles } from "./matchedStylesTypes.js";

export interface MatchedStylesProjectionOptions {
  readonly inheritedAncestorIndex?: number;
  readonly pageUrl?: string;
  readonly evidenceOnly?: boolean;
}

export interface MatchedStylesFactProjection {
  readonly facts: CssRuleFact[];
  readonly ruleEvidence: InspectRuleEvidenceBatch;
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

interface CorrelatedRuleUnit {
  readonly evidence: InspectRuleEvidence;
  readonly facts: readonly CssRuleFact[];
}

/** Projects one bounded, correlated evidence unit for each displayed Rules row. */
export function projectMatchedStylesToCssFacts(
  matchedStyles: MatchedStyles,
  budget: InspectByteBudget = createInspectByteBudget(),
  options: MatchedStylesProjectionOptions = {},
): MatchedStylesFactProjection {
  const facts: CssRuleFact[] = [];
  const evidenceRules: InspectRuleEvidence[] = [];
  const rules = selectedRules(matchedStyles, options);
  const evidenceOnly = options.evidenceOnly === true;
  let omittedRuleCount = 0;

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex]!;
    if (
      evidenceRules.length >= RULE_EVIDENCE_LIMITS.rules ||
      (!evidenceOnly && facts.length >= INSPECT_LIMITS.factsPerTarget) ||
      budget.remainingBytes <= 0
    ) {
      omittedRuleCount += rules.length - ruleIndex;
      break;
    }

    const remainingFacts = evidenceOnly
      ? RULE_EVIDENCE_LIMITS.declarationsPerRule
      : INSPECT_LIMITS.factsPerTarget - facts.length;
    const unit = createCorrelatedRuleUnit(
      rule,
      Math.min(RULE_EVIDENCE_LIMITS.declarationsPerRule, remainingFacts),
      options.pageUrl,
      rule === matchedStyles.inline,
      !evidenceOnly,
    );
    if (!unit) {
      omittedRuleCount += 1;
      continue;
    }
    if (!consumeJsonBudget(budget, unit)) {
      omittedRuleCount += rules.length - ruleIndex;
      break;
    }
    evidenceRules.push(unit.evidence);
    facts.push(...unit.facts);
  }

  return {
    facts,
    ruleEvidence: {
      rules: evidenceRules,
      omittedRuleCount,
    },
    inaccessibleStylesheets: [],
  };
}

function createCorrelatedRuleUnit(
  rule: MatchedRule,
  declarationLimit: number,
  pageUrl: string | undefined,
  inline: boolean,
  includeFacts: boolean,
): CorrelatedRuleUnit | undefined {
  const declarations = rule.declarations
    .slice(0, declarationLimit)
    .map(({ property, value, important, valueTruncated }) => ({
      property,
      value,
      important,
      valueTruncated,
    }));
  const evidenceCandidate = {
    ruleRef: rule.ruleRef,
    selector: rule.selectorText,
    declarations,
    declarationsTruncated: Boolean(
      rule.declarationsTruncated || declarations.length < rule.declarations.length,
    ),
    ...(!inline ? generatedSourceFor(rule, pageUrl) : {}),
  };
  const parsedEvidence = InspectRuleEvidenceSchema.safeParse(evidenceCandidate);
  if (!parsedEvidence.success) return undefined;

  const facts: CssRuleFact[] = includeFacts
    ? parsedEvidence.data.declarations.map((declaration) => ({
        type: "css-rule",
        ruleRef: parsedEvidence.data.ruleRef,
        ...declaration,
        metadata: {},
      }))
    : [];
  return { evidence: parsedEvidence.data, facts };
}

function generatedSourceFor(
  rule: MatchedRule,
  pageUrl: string | undefined,
): { readonly generatedSource: InspectGeneratedSource } | Record<string, never> {
  const rawSourceUrl = rule.source?.sourceUrl;
  const sourceUrl = rawSourceUrl
    ? canonicalizePublicStylesheetUrl(rawSourceUrl, { baseUrl: pageUrl })
    : undefined;
  if (!sourceUrl) return {};

  const contexts: InspectRuleContext[] = [];
  let contextsTruncated = Boolean(
    rule.contextsTruncated || rule.mediaTruncated,
  );
  let unsupportedGroupContext = false;
  for (const context of rule.contexts) {
    if (context.kind !== "media" && context.kind !== "supports") {
      unsupportedGroupContext = true;
      continue;
    }
    if (contexts.length >= RULE_EVIDENCE_LIMITS.contextsPerRule) {
      contextsTruncated = true;
      continue;
    }
    const normalized = normalizeContextTrivia(context.text);
    if (normalized.length === 0) {
      contextsTruncated = true;
      continue;
    }
    if (normalized.length > RULE_EVIDENCE_LIMITS.contextTextLength) {
      contextsTruncated = true;
    }
    contexts.push({
      kind: context.kind,
      conditionText: normalized.slice(
        0,
        RULE_EVIDENCE_LIMITS.contextTextLength,
      ),
    });
  }

  const source = rule.source;
  const startComplete =
    validPosition(source?.startLine, RULES_SOURCES_LIMITS.line) &&
    validPosition(source?.startColumn, RULES_SOURCES_LIMITS.column);
  const endComplete =
    validPosition(source?.endLine, RULES_SOURCES_LIMITS.line) &&
    validPosition(source?.endColumn, RULES_SOURCES_LIMITS.column);
  const rulePath = validRulePath(source?.rulePath) ? source.rulePath : undefined;
  if (!startComplete && !rulePath) return {};

  const candidate = {
    sourceUrl,
    ...(startComplete
      ? { startLine: source!.startLine!, startColumn: source!.startColumn! }
      : {}),
    ...(startComplete && endComplete
      ? { endLine: source!.endLine!, endColumn: source!.endColumn! }
      : {}),
    ...(rulePath ? { rulePath } : {}),
    contexts,
    contextsTruncated,
    unsupportedGroupContext,
  };
  const parsed = InspectGeneratedSourceSchema.safeParse(candidate);
  return parsed.success ? { generatedSource: parsed.data } : {};
}

function validPosition(value: number | undefined, maximum: number): boolean {
  return Number.isInteger(value) && value! >= 1 && value! <= maximum;
}

function validRulePath(value: string | undefined): value is string {
  return Boolean(
    value &&
      value.length <= RULE_EVIDENCE_LIMITS.rulePathLength &&
      /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value) &&
      value.split(".").every((segment) =>
        Number.isSafeInteger(Number(segment))
      ),
  );
}

function normalizeContextTrivia(value: string): string {
  return value.trim();
}

function selectedRules(
  matchedStyles: MatchedStyles,
  options: MatchedStylesProjectionOptions,
): readonly MatchedRule[] {
  if (options.inheritedAncestorIndex !== undefined) {
    return matchedStyles.inherited.find(
      ({ ancestorIndex }) => ancestorIndex === options.inheritedAncestorIndex,
    )?.rules ?? [];
  }
  return matchedStyles.inline
    ? [matchedStyles.inline, ...matchedStyles.rules]
    : matchedStyles.rules;
}
