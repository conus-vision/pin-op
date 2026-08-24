import type {
  DeclarationState,
  GeneratedRuleSourceSnapshot,
  InheritedRulesSnapshot,
  MatchedDeclarationSnapshot,
  MatchedRuleSnapshot,
  MatchedStylesSnapshot,
  RuleContextSnapshot,
  RulesDataSource,
  RulesDiagnosticSnapshot,
  RulesPresentationSnapshot,
} from "../src/index.js";

const declarationState: DeclarationState = "winning-known-author";
const declaration: MatchedDeclarationSnapshot = {
  declarationRef: "declaration:color",
  name: "color",
  value: "rebeccapurple",
  important: false,
  state: declarationState,
};
const context: RuleContextSnapshot = {
  kind: "media",
  text: "(width >= 40rem)",
};
const generatedSource: GeneratedRuleSourceSnapshot = {
  label: "app.css",
  lineNumber: 17,
  columnNumber: 5,
};
const rule: MatchedRuleSnapshot = {
  ruleRef: "rule:primary",
  selectorText: ".fixture, body",
  matchingSelectorIndices: [0, 1],
  declarations: [declaration],
  contexts: [context],
  generatedSource,
};
const inheritedRule: InheritedRulesSnapshot = {
  nodeRef: "html",
  matchedRules: [rule],
};
const diagnostic: RulesDiagnosticSnapshot = {
  code: "stylesheet-inaccessible",
  severity: "warning",
  message: "One stylesheet could not be read",
};
const matchedStyles: MatchedStylesSnapshot = {
  documentEpoch: 1,
  selectionRevision: 2,
  stylesRevision: 3,
  stylesheetRevision: 4,
  nodeRef: "body",
  inlineStyle: rule,
  matchedRules: [rule],
  inherited: [inheritedRule],
  inaccessibleStylesheetCount: 1,
  omittedRuleCount: 0,
  diagnostics: [diagnostic],
};
const presentation: RulesPresentationSnapshot = {
  state: "ready",
  matchedStyles,
};
const dataSource: RulesDataSource = {
  snapshot: () => presentation,
  subscribe: (_listener) => () => {},
  filter: (_query) => {},
};

dataSource.filter("color");

// @ts-expect-error Matched selector indices are immutable snapshot data.
rule.matchingSelectorIndices.push(2);
// @ts-expect-error Matched declarations are immutable snapshot data.
rule.declarations.push(declaration);
// @ts-expect-error Rule contexts are immutable snapshot data.
rule.contexts.push(context);
// @ts-expect-error Matched rules are immutable snapshot data.
matchedStyles.matchedRules.push(rule);
// @ts-expect-error Inherited groups are immutable snapshot data.
matchedStyles.inherited.push(inheritedRule);
// @ts-expect-error Inherited rules are immutable snapshot data.
inheritedRule.matchedRules.push(rule);
// @ts-expect-error Diagnostics are immutable snapshot data.
matchedStyles.diagnostics.push(diagnostic);

declare const cssStyleRule: CSSStyleRule;
// @ts-expect-error CSSOM objects cannot cross the neutral matched-rule contract.
const cssomRule: MatchedRuleSnapshot = cssStyleRule;

// @ts-expect-error A generated source exposes no source URL.
const sourceWithUrl: GeneratedRuleSourceSnapshot = { label: "app.css", url: "https://example.test/app.css" };
// @ts-expect-error A generated source exposes no local path.
const sourceWithPath: GeneratedRuleSourceSnapshot = { label: "app.css", path: "C:\\private\\app.css" };
// @ts-expect-error A generated source carries no opening authority.
const sourceWithAuthority: GeneratedRuleSourceSnapshot = { label: "app.css", openAuthorityId: "authority:1" };

void cssomRule;
void sourceWithUrl;
void sourceWithPath;
void sourceWithAuthority;
