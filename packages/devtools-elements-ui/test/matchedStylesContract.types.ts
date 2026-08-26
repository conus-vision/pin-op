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
  SourceLinkDelegate,
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
  pseudoStateRevision: 2,
  pseudoStates: ["hover", "focus"],
  nodeRef: "body",
  inlineStyle: rule,
  matchedRules: [rule],
  inherited: [inheritedRule],
  inaccessibleStylesheetCount: 1,
  unsupportedRuleCount: 1,
  approximateRuleCount: 1,
  omittedRuleCount: 0,
  diagnostics: [diagnostic],
};
const presentation: RulesPresentationSnapshot = {
  state: "ready",
  matchedStyles,
};
const emptyPresentation: RulesPresentationSnapshot = { state: "empty" };
const loadingPresentation: RulesPresentationSnapshot = { state: "loading" };
const partialPresentation: RulesPresentationSnapshot = {
  state: "partial",
  matchedStyles,
};
const errorPresentation: RulesPresentationSnapshot = {
  state: "error",
  message: "Rules unavailable",
  diagnostics: [diagnostic],
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
// @ts-expect-error Active pseudo states are immutable snapshot data.
matchedStyles.pseudoStates.push("hover");

// @ts-expect-error Declaration values are immutable snapshot data.
declaration.value = "blue";
// @ts-expect-error Declaration states are immutable snapshot data.
declaration.state = "inactive";
// @ts-expect-error Declaration references are immutable snapshot data.
declaration.declarationRef = "declaration:other";
// @ts-expect-error Declaration names are immutable snapshot data.
declaration.name = "background";
// @ts-expect-error Declaration importance is immutable snapshot data.
declaration.important = true;
// @ts-expect-error Declaration state reasons are immutable snapshot data.
declaration.stateReason = "Other reason";
// @ts-expect-error Context text is immutable snapshot data.
context.text = "(width >= 80rem)";
// @ts-expect-error Context kinds are immutable snapshot data.
context.kind = "supports";
// @ts-expect-error Generated source labels are immutable snapshot data.
generatedSource.label = "other.css";
// @ts-expect-error Generated source line positions are immutable snapshot data.
generatedSource.lineNumber = 18;
// @ts-expect-error Generated source column positions are immutable snapshot data.
generatedSource.columnNumber = 6;
// @ts-expect-error Rule selector text is immutable snapshot data.
rule.selectorText = "body";
// @ts-expect-error Rule references are immutable snapshot data.
rule.ruleRef = "rule:other";
// @ts-expect-error A rule's selector-index array property is immutable.
rule.matchingSelectorIndices = [0];
// @ts-expect-error A rule's declaration array property is immutable.
rule.declarations = [declaration];
// @ts-expect-error A rule's context array property is immutable.
rule.contexts = [context];
// @ts-expect-error A rule's generated source object is immutable snapshot data.
rule.generatedSource = generatedSource;
// @ts-expect-error Inherited node references are immutable snapshot data.
inheritedRule.nodeRef = "body";
// @ts-expect-error Inherited inline-style objects are immutable snapshot data.
inheritedRule.inlineStyle = rule;
// @ts-expect-error An inherited group's matched-rule array property is immutable.
inheritedRule.matchedRules = [rule];
// @ts-expect-error Matched inline-style objects are immutable snapshot data.
matchedStyles.inlineStyle = rule;
// @ts-expect-error Document epochs are immutable snapshot data.
matchedStyles.documentEpoch = 2;
// @ts-expect-error Selection revisions are immutable snapshot data.
matchedStyles.selectionRevision = 3;
// @ts-expect-error Style revisions are immutable snapshot data.
matchedStyles.stylesRevision = 4;
// @ts-expect-error Stylesheet revisions are immutable snapshot data.
matchedStyles.stylesheetRevision = 5;
// @ts-expect-error Pseudo-state revisions are immutable snapshot data.
matchedStyles.pseudoStateRevision = 3;
// @ts-expect-error The pseudo-state array property is immutable snapshot data.
matchedStyles.pseudoStates = [];
// @ts-expect-error Selected node references are immutable snapshot data.
matchedStyles.nodeRef = "html";
// @ts-expect-error Inaccessible stylesheet counts are immutable snapshot data.
matchedStyles.inaccessibleStylesheetCount = 0;
// @ts-expect-error Unsupported rule counts are immutable snapshot data.
matchedStyles.unsupportedRuleCount = 0;
// @ts-expect-error Approximate rule counts are immutable snapshot data.
matchedStyles.approximateRuleCount = 0;
// @ts-expect-error Omitted rule counts are immutable snapshot data.
matchedStyles.omittedRuleCount = 1;
// @ts-expect-error The matched-rule array property is immutable snapshot data.
matchedStyles.matchedRules = [rule];
// @ts-expect-error The inherited-group array property is immutable snapshot data.
matchedStyles.inherited = [inheritedRule];
// @ts-expect-error The diagnostic array property is immutable snapshot data.
matchedStyles.diagnostics = [diagnostic];
// @ts-expect-error Diagnostic codes are immutable snapshot data.
diagnostic.code = "other-code";
// @ts-expect-error Diagnostic severities are immutable snapshot data.
diagnostic.severity = "warning";
// @ts-expect-error Diagnostic messages are immutable snapshot data.
diagnostic.message = "Other message";
// @ts-expect-error Presentation discriminants are immutable snapshot data.
presentation.state = "ready";
// @ts-expect-error Presentation payloads are immutable snapshot data.
presentation.matchedStyles = matchedStyles;
// @ts-expect-error Empty presentation discriminants are immutable.
emptyPresentation.state = "empty";
// @ts-expect-error Loading presentation discriminants are immutable.
loadingPresentation.state = "loading";
// @ts-expect-error Partial presentation discriminants are immutable.
partialPresentation.state = "partial";
// @ts-expect-error Partial presentation payloads are immutable.
partialPresentation.matchedStyles = matchedStyles;
// @ts-expect-error Error presentation discriminants are immutable.
errorPresentation.state = "error";
// @ts-expect-error Error presentation messages are immutable.
errorPresentation.message = "Other error";
// @ts-expect-error Error presentation diagnostic array properties are immutable.
errorPresentation.diagnostics = [diagnostic];
// @ts-expect-error Error presentation diagnostics are readonly arrays.
errorPresentation.diagnostics.push(diagnostic);

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

type ForbiddenDomCssomObject =
  | CSSRule
  | CSSStyleDeclaration
  | StyleSheet
  | EventTarget
  | Event
  | Range
  | Selection
  | MediaList
  | DOMTokenList;

type ContainsForbiddenDomCssomObject<T, Seen = never> =
  [T] extends [Seen]
    ? false
    : T extends ForbiddenDomCssomObject
      ? true
      : T extends (...args: infer Arguments) => infer Result
        ? ContainsForbiddenDomCssomObject<Arguments[number] | Result, Seen | T>
        : T extends readonly (infer Item)[]
          ? ContainsForbiddenDomCssomObject<Item, Seen | T>
          : T extends object
            ? true extends {
              [Key in keyof T]-?: ContainsForbiddenDomCssomObject<
                T[Key],
                Seen | T
              >;
            }[keyof T]
              ? true
              : false
            : false;

type ExportedRulesContract = {
  readonly declaration: MatchedDeclarationSnapshot;
  readonly context: RuleContextSnapshot;
  readonly generatedSource: GeneratedRuleSourceSnapshot;
  readonly rule: MatchedRuleSnapshot;
  readonly inherited: InheritedRulesSnapshot;
  readonly matchedStyles: MatchedStylesSnapshot;
  readonly diagnostic: RulesDiagnosticSnapshot;
  readonly presentation: RulesPresentationSnapshot;
  readonly dataSource: RulesDataSource;
  readonly sourceLink: SourceLinkDelegate;
};

type HasForbiddenDomCssomObject<T> =
  true extends ContainsForbiddenDomCssomObject<T> ? true : false;
type ExpectFalse<T extends false> = T;
type NeutralRulesContractContainsNoDomCssom = ExpectFalse<
  HasForbiddenDomCssomObject<ExportedRulesContract>
>;

declare const noDomCssomProof: NeutralRulesContractContainsNoDomCssom;
void noDomCssomProof;
