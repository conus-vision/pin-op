import {
  CssRuleFactSchema,
  InspectRuleEvidenceSchema,
  InspectTargetSchema,
  canonicalizePublicStylesheetUrl,
  type CssRuleFact,
  type InspectRuleContext,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
  type InspectTarget,
} from "@pin-op/protocol";

const DEFAULT_PAGE_URL = "http://localhost:4173/page";
let nextRuleRef = 0;

export interface CssFixtureDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important?: boolean;
  readonly valueTruncated?: boolean;
}

export interface CorrelatedCssRuleFixture {
  readonly ruleRef: string;
  selector: string;
  sourceUrl: string;
  rulePath: string | undefined;
  startLine: number | undefined;
  startColumn: number | undefined;
  contexts: InspectRuleContext[];
  contextsTruncated: boolean;
  unsupportedGroupContext: boolean;
  declarationsTruncated: boolean;
}

export type CorrelatedCssTargetFixture = Omit<InspectTarget, "facts"> & {
  facts: CssRuleFact[];
  readonly correlatedRules: CorrelatedCssRuleFixture[];
};

export interface CorrelatedCssRuleOptions {
  readonly sourceUrl: string;
  readonly rulePath?: string | null;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly contexts?: readonly InspectRuleContext[];
  readonly contextsTruncated?: boolean;
  readonly unsupportedGroupContext?: boolean;
  readonly declarationsTruncated?: boolean;
  readonly declarations?: readonly CssFixtureDeclaration[];
}

export function createCorrelatedCssTarget(
  role: "selected" | "parent",
  selector: string,
  options: CorrelatedCssRuleOptions,
): CorrelatedCssTargetFixture {
  const target: CorrelatedCssTargetFixture = {
    role,
    depth: role === "selected" ? 0 : 1,
    subject: { selector, metadata: {} },
    facts: [],
    metadata: {},
    correlatedRules: [],
  };
  addCorrelatedCssRule(target, selector, options);
  return target;
}

export function addCorrelatedCssRule(
  target: CorrelatedCssTargetFixture,
  selector: string,
  options: CorrelatedCssRuleOptions,
): CorrelatedCssRuleFixture {
  const sourceUrl = canonicalizePublicStylesheetUrl(options.sourceUrl, {
    baseUrl: DEFAULT_PAGE_URL,
  });
  if (!sourceUrl) {
    throw new Error(`Invalid correlated CSS fixture source: ${options.sourceUrl}`);
  }
  const ruleRef = `css-fixture-rule-${++nextRuleRef}`;
  const rule: CorrelatedCssRuleFixture = {
    ruleRef,
    selector,
    sourceUrl,
    rulePath: options.rulePath === null
      ? undefined
      : options.rulePath ?? "0.99",
    startLine: options.startLine,
    startColumn: options.startColumn,
    contexts: [...(options.contexts ?? [])],
    contextsTruncated: options.contextsTruncated ?? false,
    unsupportedGroupContext: options.unsupportedGroupContext ?? false,
    declarationsTruncated: options.declarationsTruncated ?? false,
  };
  target.correlatedRules.push(rule);
  for (const declaration of options.declarations ?? [{
    property: "color",
    value: "red",
  }]) {
    target.facts.push(CssRuleFactSchema.parse({
      type: "css-rule",
      ruleRef,
      property: declaration.property,
      value: declaration.value,
      important: declaration.important ?? false,
      valueTruncated: declaration.valueTruncated ?? false,
      metadata: {},
    }));
  }
  return rule;
}

export function primaryCorrelatedCssRule(
  target: CorrelatedCssTargetFixture,
): CorrelatedCssRuleFixture {
  const rule = target.correlatedRules[0];
  if (!rule) throw new Error("Correlated CSS fixture has no primary rule");
  return rule;
}

export function projectCorrelatedCssFixtures(
  fixtures: readonly CorrelatedCssTargetFixture[],
): {
  readonly targets: readonly InspectTarget[];
  readonly ruleEvidence: InspectRuleEvidenceBatch;
} {
  const rules: InspectRuleEvidence[] = [];
  const targets = fixtures.map((fixture) => {
    const facts = fixture.facts.map((fact) => CssRuleFactSchema.parse(fact));
    const refs = new Set(facts.map(({ ruleRef }) => ruleRef));
    for (const rule of fixture.correlatedRules) {
      if (!refs.has(rule.ruleRef)) continue;
      const declarations = facts
        .filter(({ ruleRef }) => ruleRef === rule.ruleRef)
        .map(({ property, value, important, valueTruncated }) => ({
          property,
          value,
          important,
          valueTruncated,
        }));
      const hasStart = rule.startLine !== undefined &&
        rule.startColumn !== undefined;
      rules.push(InspectRuleEvidenceSchema.parse({
        ruleRef: rule.ruleRef,
        selector: rule.selector,
        declarations,
        declarationsTruncated: rule.declarationsTruncated,
        ...(hasStart || rule.rulePath !== undefined
          ? {
              generatedSource: {
                sourceUrl: rule.sourceUrl,
                ...(hasStart
                  ? {
                      startLine: rule.startLine,
                      startColumn: rule.startColumn,
                    }
                  : {}),
                ...(rule.rulePath === undefined
                  ? {}
                  : { rulePath: rule.rulePath }),
                contexts: rule.contexts,
                contextsTruncated: rule.contextsTruncated,
                unsupportedGroupContext: rule.unsupportedGroupContext,
              },
            }
          : {}),
      }));
    }
    return InspectTargetSchema.parse({
      role: fixture.role,
      depth: fixture.depth,
      subject: fixture.subject,
      facts,
      metadata: fixture.metadata,
    });
  });
  return {
    targets,
    ruleEvidence: { rules, omittedRuleCount: 0 },
  };
}
