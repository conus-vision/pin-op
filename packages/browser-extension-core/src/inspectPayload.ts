import {
  INSPECT_LIMITS,
  RULE_EVIDENCE_LIMITS,
  type InspectRuleEvidence,
  type InspectRuleEvidenceBatch,
  type InspectTarget,
} from "@pin-op/protocol";
import type { InspectPayload } from "./bridgeClient.js";
import {
  type CssDocumentSource,
  type InaccessibleStylesheet,
} from "./collectCssFacts.js";
import { createElementSnapshot } from "./elementSnapshot.js";
import type { InspectableElement } from "./inspectMode.js";
import {
  boundedPageUrl,
  createInspectByteBudget,
  joinBounded,
  type InspectByteBudget,
} from "./inspectBounds.js";
import type { MatchedStyles } from "./matchedStylesTypes.js";
import { projectMatchedStylesToCssFacts } from "./matchedStylesProjection.js";

export interface LocationSource {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export type InspectPayloadWithDiagnostics = InspectPayload & {
  readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[];
};

interface CollectedTarget extends InspectTarget {
  readonly ruleEvidence: InspectRuleEvidenceBatch;
  readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[];
}

export function createInspectPayload(
  element: InspectableElement,
  _document: CssDocumentSource,
  location: LocationSource,
  matchedStyles: MatchedStyles,
): InspectPayloadWithDiagnostics {
  if (!matchedStyles) throw new TypeError("MatchedStyles is required");
  const pageUrl = boundedPageUrl(location.href);
  const budget = createInspectByteBudget();
  const selected = collectTarget(
    "selected",
    0,
    element,
    pageUrl,
    budget,
    matchedStyles,
  );
  const domParentAncestorIndex = matchedStyles.domParentAncestorIndex;
  const parent = element.parentElement
    ? collectTarget(
        "parent",
        1,
        element.parentElement,
        pageUrl,
        budget,
        matchedStyles,
        domParentAncestorIndex ?? null,
      )
    : undefined;
  const collected = parent ? [selected, parent] : [selected];
  const inaccessibleStylesheets: InaccessibleStylesheet[] = [];
  const displayedInheritedEvidence = matchedStyles.inherited
    .filter(({ ancestorIndex }) =>
      !parent || ancestorIndex !== domParentAncestorIndex
    )
    .map(({ ancestorIndex }) =>
      projectMatchedStylesToCssFacts(matchedStyles, budget, {
        inheritedAncestorIndex: ancestorIndex,
        pageUrl,
        evidenceOnly: true,
      }).ruleEvidence
    );
  const ruleEvidence = mergeRuleEvidence(collected, displayedInheritedEvidence);
  const evidenceByRef = new Map(
    ruleEvidence.rules.map((evidence) => [evidence.ruleRef, evidence]),
  );
  const targets = collected.map(({
    inaccessibleStylesheets: _ignoredInaccessible,
    ruleEvidence: _ignoredEvidence,
    ...target
  }) => ({
    ...target,
    facts: target.facts.filter((fact) => {
      if (fact.type !== "css-rule" || !("ruleRef" in fact)) return true;
      const evidence = evidenceByRef.get(fact.ruleRef);
      return evidence?.declarations.some((declaration) =>
        declaration.property === fact.property &&
        declaration.value === fact.value &&
        declaration.important === fact.important &&
        declaration.valueTruncated === fact.valueTruncated
      ) ?? false;
    }),
  }));

  return {
    ideHighlightEnabled: true,
    targets,
    ruleEvidence,
    context: {
      url: pageUrl,
      route: joinBounded(
        [location.pathname, location.search, location.hash],
        INSPECT_LIMITS.routeLength,
      ),
      metadata: {
        inaccessibleStylesheetCount: matchedStyles.inaccessibleStylesheetCount,
      },
    },
    metadata: {},
    inaccessibleStylesheets,
  };
}

function collectTarget(
  role: "selected" | "parent",
  depth: 0 | 1,
  element: InspectableElement,
  pageUrl: string,
  budget: InspectByteBudget,
  matchedStyles: MatchedStyles,
  inheritedAncestorIndex?: number | null,
): CollectedTarget {
  const subject = createElementSnapshot(element, pageUrl, budget);
  const collection = inheritedAncestorIndex === null
    ? {
        facts: [],
        ruleEvidence: { rules: [], omittedRuleCount: 0 },
        inaccessibleStylesheets: [],
      }
    : projectMatchedStylesToCssFacts(
        matchedStyles,
        budget,
        inheritedAncestorIndex === undefined
          ? { pageUrl }
          : { inheritedAncestorIndex, pageUrl },
      );
  return {
    role,
    depth,
    subject,
    facts: collection.facts,
    ruleEvidence: collection.ruleEvidence,
    metadata: {},
    inaccessibleStylesheets: collection.inaccessibleStylesheets,
  };
}

function mergeRuleEvidence(
  targets: readonly CollectedTarget[],
  additional: readonly InspectRuleEvidenceBatch[] = [],
): InspectRuleEvidenceBatch {
  const batches = [
    ...targets.map(({ ruleEvidence }) => ruleEvidence),
    ...additional,
  ];
  const rules: InspectRuleEvidence[] = [];
  const byRef = new Map<string, InspectRuleEvidence>();
  let omittedRuleCount = batches.reduce(
    (count, batch) => count + batch.omittedRuleCount,
    0,
  );
  for (const batch of batches) {
    for (const evidence of batch.rules) {
      const existing = byRef.get(evidence.ruleRef);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(evidence)) {
          omittedRuleCount += 1;
        }
        continue;
      }
      if (rules.length >= RULE_EVIDENCE_LIMITS.rules) {
        omittedRuleCount += 1;
        continue;
      }
      rules.push(evidence);
      byRef.set(evidence.ruleRef, evidence);
    }
  }
  return { rules, omittedRuleCount };
}
