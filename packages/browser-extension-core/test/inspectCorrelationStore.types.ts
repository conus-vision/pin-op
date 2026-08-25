import {
  InspectCorrelationStore,
  type RulesOpenAuthority,
  type SourceOpenAuthority,
} from "../src/inspectCorrelationStore.js";

const store = new InspectCorrelationStore();
const ruleEvidence = {
  rules: [],
  omittedRuleCount: 0,
} as const;

store.record("panel-a", "inspect-a", 7, 10, ruleEvidence);

// @ts-expect-error Source authority must always bind to an exact browser window.
store.record("panel-a", "inspect-a", 7);

// @ts-expect-error Correlation recording must bind final serialized rule evidence.
store.record("panel-a", "inspect-a", 7, 10);

declare const rulesAuthority: RulesOpenAuthority;
declare const sourceAuthority: SourceOpenAuthority;

store.authorizeNavigation(sourceAuthority);

// @ts-expect-error Rules authority cannot be used for Source navigation.
store.authorizeNavigation(rulesAuthority);

// @ts-expect-error Rules authority cannot be discarded as Source authority.
store.discardSourcePresentationAuthority(rulesAuthority);

// @ts-expect-error Source authority cannot be discarded as Rules authority.
store.discardRulesOpenAuthority(sourceAuthority);

// @ts-expect-error Rules and Source generations are independent brands.
const sourceGeneration: SourceOpenAuthority["resolutionGeneration"] =
  rulesAuthority.rulesGeneration;

// @ts-expect-error Source and Rules generations are independent brands.
const rulesGeneration: RulesOpenAuthority["rulesGeneration"] =
  sourceAuthority.resolutionGeneration;
