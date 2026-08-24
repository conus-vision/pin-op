import {
  INSPECT_LIMITS,
  type CssRuleFact,
} from "@pin-op/protocol";
import {
  consumeJsonBudget,
  createInspectByteBudget,
  type InspectByteBudget,
} from "./inspectBounds.js";
import type { InaccessibleStylesheet } from "./cssRuleWalker.js";
import type {
  MatchedRule,
  MatchedStyles,
} from "./matchedStylesTypes.js";

export interface MatchedStylesProjectionOptions {
  readonly inheritedAncestorIndex?: number;
}

export interface MatchedStylesFactProjection {
  readonly facts: CssRuleFact[];
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

/** Projects legacy inspect evidence from already-collected matched records. */
export function projectMatchedStylesToCssFacts(
  matchedStyles: MatchedStyles,
  budget: InspectByteBudget = createInspectByteBudget(),
  options: MatchedStylesProjectionOptions = {},
): MatchedStylesFactProjection {
  const facts: CssRuleFact[] = [];
  const rules = selectedRules(matchedStyles, options);
  if (budget.remainingBytes > 0) {
    outer: for (const rule of rules) {
      for (const declaration of rule.declarations) {
        if (
          facts.length >= INSPECT_LIMITS.factsPerTarget ||
          budget.remainingBytes <= 0
        ) {
          break outer;
        }
        const media = rule.contexts
          .filter(({ kind }) => kind === "media")
          .map(({ text }) => text);
        const fact: CssRuleFact = {
          type: "css-rule",
          selector: rule.selectorText,
          property: declaration.property,
          value: declaration.value,
          metadata: {
            ruleRef: rule.ruleRef,
            ...(rule.source?.sourceUrl
              ? { sourceUrl: rule.source.sourceUrl }
              : {}),
            media,
            mediaTruncated: rule.mediaTruncated ?? false,
            rulePath: rule.source?.rulePath ?? "0",
            valueTruncated: declaration.valueTruncated,
            important: declaration.important,
          },
        };
        if (!consumeJsonBudget(budget, fact)) break outer;
        facts.push(fact);
      }
    }
  }
  return { facts, inaccessibleStylesheets: [] };
}

function selectedRules(
  matchedStyles: MatchedStyles,
  options: MatchedStylesProjectionOptions,
): readonly MatchedRule[] {
  if (options.inheritedAncestorIndex !== undefined) {
    return matchedStyles.inherited.find(({ ancestorIndex }) => (
      ancestorIndex === options.inheritedAncestorIndex
    ))?.rules ?? [];
  }
  return matchedStyles.inline
    ? [matchedStyles.inline, ...matchedStyles.rules]
    : matchedStyles.rules;
}
