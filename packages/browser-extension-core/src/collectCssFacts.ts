import type { CssRuleFact } from "@pin-op/protocol";
import {
  walkCssRules,
  type CssDocumentSource,
  type CssRuleWalkRecord,
  type InaccessibleStylesheet,
  type MatchableElement,
} from "./cssRuleWalker.js";
import {
  createInspectByteBudget,
  type InspectByteBudget,
} from "./inspectBounds.js";
import type {
  MatchedRule,
  MatchedStyles,
} from "./matchedStylesTypes.js";
import { projectMatchedStylesToCssFacts } from "./matchedStylesProjection.js";
import { RuleReferenceRegistry } from "./ruleReferenceRegistry.js";

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

export function collectCssFacts(
  matchedStyles: MatchedStyles,
  budget?: InspectByteBudget,
): CssFactCollection;
export function collectCssFacts(
  element: MatchableElement,
  document: CssDocumentSource,
  budget?: InspectByteBudget,
): CssFactCollection;
/**
 * Projects facts from MatchedStyles. The element/document overload is a v6
 * compatibility adapter which first materializes matched records through the
 * shared bounded walker; it contains no second CSSOM traversal.
 */
export function collectCssFacts(
  matchedOrElement: MatchedStyles | MatchableElement,
  documentOrBudget?: CssDocumentSource | InspectByteBudget,
  optionalBudget?: InspectByteBudget,
): CssFactCollection {
  if (isMatchedStyles(matchedOrElement)) {
    return projectMatchedStylesToCssFacts(
      matchedOrElement,
      isInspectByteBudget(documentOrBudget)
        ? documentOrBudget
        : createInspectByteBudget(),
    );
  }
  const document = documentOrBudget as CssDocumentSource;
  const budget = optionalBudget ?? createInspectByteBudget();
  const registry = new RuleReferenceRegistry({
    contentSessionId: "content-v6-css-facts",
    documentEpoch: 0,
    stylesheetRevision: 0,
  });
  const recordsByRule = new Map<string, CssRuleWalkRecord[]>();
  const observedRules: MatchedRule[] = [];
  const walk = walkCssRules(matchedOrElement, document, {
    ruleReferences: registry,
    onMatchedRule(record) {
      if (!record.ruleRef) return;
      recordsByRule.set(record.ruleRef, []);
      observedRules.push({
        ruleRef: record.ruleRef,
        selectorText: record.selector,
        matchingSelectorIndices: [0],
        declarations: [],
        contexts: record.contexts,
        ...(record.contextsTruncated ? { contextsTruncated: true } : {}),
        ...(record.mediaTruncated ? { mediaTruncated: true } : {}),
        source: {
          sourceUrl: record.sourceUrl,
          rulePath: record.rulePath,
        },
      });
    },
  });
  for (const record of walk.records) {
    if (!record.ruleRef) continue;
    recordsByRule.get(record.ruleRef)?.push(record);
  }
  const matchedRules: MatchedRule[] = observedRules.map((rule) => ({
    ...rule,
    declarations: (recordsByRule.get(rule.ruleRef) ?? []).map((record) => ({
      ruleRef: rule.ruleRef,
      property: record.property,
      value: record.value,
      important: record.important,
      valueTruncated: record.valueTruncated,
      state: "unknown" as const,
      reason: "unsupported-selector-specificity" as const,
    })),
  })).filter(({ declarations }) => declarations.length > 0);
  const matched: MatchedStyles = {
    documentEpoch: 0,
    selectionRevision: 0,
    stylesRevision: 0,
    stylesheetRevision: 0,
    nodeRef: "v6-css-facts",
    rules: matchedRules,
    inherited: [],
    inaccessibleStylesheetCount: walk.inaccessibleStylesheets.length,
    partial: walk.inaccessibleStylesheets.length > 0,
    diagnostics: walk.inaccessibleStylesheets.length > 0
      ? ["stylesheet-inaccessible"]
      : [],
  };
  const projection = projectMatchedStylesToCssFacts(matched, budget);
  registry.dispose();
  return {
    facts: projection.facts,
    inaccessibleStylesheets: [...walk.inaccessibleStylesheets],
  };
}

function isMatchedStyles(value: MatchedStyles | MatchableElement): value is MatchedStyles {
  if (typeof value !== "object" || value === null) return false;
  try {
    return "nodeRef" in value && "rules" in value && "inherited" in value;
  } catch {
    return false;
  }
}

function isInspectByteBudget(
  value: CssDocumentSource | InspectByteBudget | undefined,
): value is InspectByteBudget {
  return typeof value === "object" && value !== null &&
    "remainingBytes" in value;
}
