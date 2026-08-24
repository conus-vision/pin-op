import {
  INSPECT_LIMITS,
  type CssRuleFact,
} from "@pin-op/protocol";
import {
  consumeJsonBudget,
  createInspectByteBudget,
  type InspectByteBudget,
} from "./inspectBounds.js";
import {
  walkCssRules,
  type CssDocumentSource,
  type InaccessibleStylesheet,
  type MatchableElement,
} from "./cssRuleWalker.js";

export type {
  CssDocumentSource,
  GroupRuleSource,
  InaccessibleStylesheet,
  MatchableElement,
  RuleSource,
  StyleDeclarationSource,
  StyleRuleSource,
  StylesheetSource,
} from "./cssRuleWalker.js";

export interface CssFactCollection {
  readonly facts: CssRuleFact[];
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

/** Projects the shared CSSOM walk onto the legacy inspect fact contract. */
export function collectCssFacts(
  element: MatchableElement,
  document: CssDocumentSource,
  budget: InspectByteBudget = createInspectByteBudget(),
): CssFactCollection {
  const facts: CssRuleFact[] = [];
  const walk = walkCssRules(element, document);

  if (budget.remainingBytes > 0) {
    for (const record of walk.records) {
      if (
        facts.length >= INSPECT_LIMITS.factsPerTarget ||
        budget.remainingBytes <= 0
      ) {
        break;
      }
      const fact: CssRuleFact = {
        type: "css-rule",
        selector: record.selector,
        property: record.property,
        value: record.value,
        metadata: {
          sourceUrl: record.sourceUrl,
          media: [...record.media],
          mediaTruncated: record.mediaTruncated,
          rulePath: record.rulePath,
          valueTruncated: record.valueTruncated,
          important: record.important,
        },
      };
      if (!consumeJsonBudget(budget, fact)) break;
      facts.push(fact);
    }
  }

  return {
    facts,
    inaccessibleStylesheets: [...walk.inaccessibleStylesheets],
  };
}
