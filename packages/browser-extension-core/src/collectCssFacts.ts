import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type ProtocolErrorCode,
} from "@pin-op/protocol";
import {
  boundedLength,
  consumeJsonBudget,
  createInspectByteBudget,
  enumerateBounded,
  exactBoundedUrl,
  type InspectByteBudget,
  truncate,
} from "./inspectBounds.js";

export interface MatchableElement {
  matches(selector: string): boolean;
}

export interface StyleDeclarationSource {
  readonly length: number;
  item(index: number): string;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
}

export interface StyleRuleSource {
  readonly selectorText: string;
  readonly style: StyleDeclarationSource;
  readonly cssRules?: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

interface NestedDeclarationsSource {
  readonly style: StyleDeclarationSource;
}

interface MediaConditionSource {
  readonly conditionText?: string;
  readonly media?: { readonly mediaText: string };
}

export interface GroupRuleSource extends MediaConditionSource {
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

interface ImportRuleSource extends MediaConditionSource {
  readonly href?: string | null;
  readonly styleSheet: StylesheetSource;
}

export type RuleSource = StyleRuleSource | GroupRuleSource | object;

interface StyleSelectorContext {
  readonly sourceSelector: string;
  readonly resolvedSelector: string;
}

interface MediaConditions {
  readonly values: readonly string[];
  readonly truncated: boolean;
}

interface MediaCondition {
  readonly value: string;
  readonly truncated: boolean;
}

export interface StylesheetSource {
  readonly href: string | null;
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

export interface CssDocumentSource {
  readonly pageUrl: string;
  readonly styleSheets: Iterable<StylesheetSource>;
}

export interface InaccessibleStylesheet {
  readonly code: Extract<
    ProtocolErrorCode,
    "browser.stylesheetInaccessible"
  >;
  readonly sourceUrl: string;
  readonly reason: string;
}

export interface CssFactCollection {
  readonly facts: CssRuleFact[];
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

interface CollectionState {
  rulesVisited: number;
  stylesheetsVisited: number;
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

export function collectCssFacts(
  element: MatchableElement,
  document: CssDocumentSource,
  budget: InspectByteBudget = createInspectByteBudget(),
): CssFactCollection {
  const facts: CssRuleFact[] = [];
  const inaccessibleStylesheets: InaccessibleStylesheet[] = [];
  const state: CollectionState = {
    rulesVisited: 0,
    stylesheetsVisited: 0,
    inaccessibleStylesheets,
  };

  for (const [stylesheetIndex, stylesheet] of enumerateBounded(
    document.styleSheets,
    INSPECT_LIMITS.stylesheets,
  )) {
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.stylesheetsVisited >= INSPECT_LIMITS.stylesheets ||
      budget.remainingBytes <= 0
    ) {
      break;
    }
    state.stylesheetsVisited += 1;

    let sourceUrl: string | undefined;
    try {
      sourceUrl = exactBoundedUrl(
        stylesheet.href ?? `inline-style://document/${stylesheetIndex}`,
      );
    } catch {
      continue;
    }
    if (!sourceUrl) {
      continue;
    }
    try {
      collectRules(
        element,
        stylesheet.cssRules,
        sourceUrl,
        `${stylesheetIndex}`,
        { values: [], truncated: false },
        undefined,
        0,
        facts,
        state,
        budget,
        new Set([stylesheet]),
      );
    } catch (error) {
      reportInaccessible(state, sourceUrl, error);
    }
  }

  return { facts, inaccessibleStylesheets };
}

function collectRules(
  element: MatchableElement,
  rules: ArrayLike<RuleSource> | Iterable<RuleSource>,
  sourceUrl: string,
  parentPath: string,
  media: MediaConditions,
  parentSelector: StyleSelectorContext | undefined,
  depth: number,
  facts: CssRuleFact[],
  state: CollectionState,
  budget: InspectByteBudget,
  activeStylesheets: ReadonlySet<object>,
): void {
  if (
    depth > INSPECT_LIMITS.cssRuleDepth ||
    facts.length >= INSPECT_LIMITS.factsPerTarget ||
    state.rulesVisited >= INSPECT_LIMITS.cssRules ||
    budget.remainingBytes <= 0
  ) {
    return;
  }

  const remainingRules = INSPECT_LIMITS.cssRules - state.rulesVisited;
  for (const [ruleIndex, rule] of enumerateBounded(
    rules,
    remainingRules,
  )) {
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.rulesVisited >= INSPECT_LIMITS.cssRules ||
      budget.remainingBytes <= 0
    ) {
      return;
    }
    state.rulesVisited += 1;
    const rulePath = `${parentPath}.${ruleIndex}`;

    if (isImportRuleCandidate(rule)) {
      collectImportedStylesheet(
        element,
        rule,
        sourceUrl,
        media,
        depth,
        facts,
        state,
        budget,
        activeStylesheets,
      );
      if (
        facts.length >= INSPECT_LIMITS.factsPerTarget ||
        state.rulesVisited >= INSPECT_LIMITS.cssRules ||
        budget.remainingBytes <= 0
      ) {
        return;
      }
      continue;
    }

    let childSelector = parentSelector;
    try {
      if (isStyleRule(rule)) {
        const selector = resolveStyleSelector(
          rule.selectorText,
          parentSelector,
        );
        if (!selector) {
          continue;
        }
        const matches = matchesSelector(element, selector.resolvedSelector);
        if (matches === undefined) {
          continue;
        }
        if (matches) {
          collectDeclarations(
            rule.style,
            selector.sourceSelector,
            sourceUrl,
            rulePath,
            media,
            facts,
            budget,
          );
        }
        childSelector = selector;
        if (
          facts.length >= INSPECT_LIMITS.factsPerTarget ||
          state.rulesVisited >= INSPECT_LIMITS.cssRules ||
          budget.remainingBytes <= 0
        ) {
          return;
        }
      } else if (isNestedDeclarationsRule(rule) && parentSelector) {
        const matches = matchesSelector(
          element,
          parentSelector.resolvedSelector,
        );
        if (matches === undefined) {
          continue;
        }
        if (matches) {
          collectDeclarations(
            rule.style,
            parentSelector.sourceSelector,
            sourceUrl,
            rulePath,
            media,
            facts,
            budget,
          );
        }
      }
    } catch {
      continue;
    }
    if (!isGroupRule(rule)) {
      continue;
    }

    let nestedRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
    try {
      nestedRules = rule.cssRules;
    } catch {
      continue;
    }
    if (depth >= INSPECT_LIMITS.cssRuleDepth) {
      continue;
    }
    const condition = readMediaCondition(rule);
    const nextMedia = appendMediaCondition(media, condition);
    collectRules(
      element,
      nestedRules,
      sourceUrl,
      rulePath,
      nextMedia,
      childSelector,
      depth + 1,
      facts,
      state,
      budget,
      activeStylesheets,
    );
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.rulesVisited >= INSPECT_LIMITS.cssRules ||
      budget.remainingBytes <= 0
    ) {
      return;
    }
  }
}

function collectDeclarations(
  style: StyleDeclarationSource,
  selector: string,
  sourceUrl: string,
  rulePath: string,
  media: MediaConditions,
  facts: CssRuleFact[],
  budget: InspectByteBudget,
): void {
  const remainingFacts = INSPECT_LIMITS.factsPerTarget - facts.length;
  const declarationLimit = Math.min(
    INSPECT_LIMITS.declarationsPerRule,
    remainingFacts,
  );
  const declarationNames: string[] = [];
  const declarationCount = boundedLength(style.length, declarationLimit);
  for (let index = 0; index < declarationCount; index += 1) {
    try {
      const property = style.item(index);
      if (
        property &&
        property.length <= INSPECT_LIMITS.propertyNameLength
      ) {
        declarationNames.push(property);
      }
    } catch {
      continue;
    }
  }

  for (const property of declarationNames) {
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      budget.remainingBytes <= 0
    ) {
      return;
    }

    try {
      const important = readImportantPriority(style, property);
      if (important === undefined) continue;
      const rawValue = style.getPropertyValue(property);
      const valueTruncated = rawValue.length > INSPECT_LIMITS.valueLength;
      const fact: CssRuleFact = {
        type: "css-rule",
        selector,
        property,
        value: truncate(
          rawValue,
          INSPECT_LIMITS.valueLength,
        ).trim(),
        metadata: {
          sourceUrl,
          media: [...media.values],
          mediaTruncated: media.truncated,
          rulePath: truncate(rulePath, INSPECT_LIMITS.selectorLength),
          valueTruncated,
          important,
        },
      };
      if (!consumeJsonBudget(budget, fact)) {
        return;
      }
      facts.push(fact);
    } catch {
      continue;
    }
  }
}

function readImportantPriority(
  style: StyleDeclarationSource,
  property: string,
): boolean | undefined {
  const priority = style.getPropertyPriority(property);
  if (priority === "") return false;
  if (priority === "important") return true;
  return undefined;
}

function collectImportedStylesheet(
  element: MatchableElement,
  rule: RuleSource,
  containingSourceUrl: string,
  media: MediaConditions,
  depth: number,
  facts: CssRuleFact[],
  state: CollectionState,
  budget: InspectByteBudget,
  activeStylesheets: ReadonlySet<object>,
): void {
  if (
    depth >= INSPECT_LIMITS.cssRuleDepth ||
    facts.length >= INSPECT_LIMITS.factsPerTarget ||
    state.stylesheetsVisited >= INSPECT_LIMITS.stylesheets ||
    state.rulesVisited >= INSPECT_LIMITS.cssRules ||
    budget.remainingBytes <= 0
  ) {
    return;
  }

  const stylesheetNamespace = state.stylesheetsVisited;
  state.stylesheetsVisited += 1;

  let importedStylesheet: StylesheetSource;
  try {
    const candidate = (rule as Partial<ImportRuleSource>).styleSheet;
    if (!isStylesheetSource(candidate)) {
      return;
    }
    importedStylesheet = candidate;
  } catch (error) {
    reportInaccessible(
      state,
      diagnosticImportUrl(rule, containingSourceUrl),
      error,
    );
    return;
  }

  if (activeStylesheets.has(importedStylesheet)) {
    return;
  }

  let sourceUrl: string | undefined;
  try {
    const stylesheetHref = importedStylesheet.href;
    sourceUrl = stylesheetHref === null
      ? exactImportRuleUrl(rule)
      : exactBoundedUrl(stylesheetHref);
  } catch (error) {
    reportInaccessible(
      state,
      diagnosticImportUrl(rule, containingSourceUrl),
      error,
    );
    return;
  }
  if (!sourceUrl) {
    return;
  }

  let importedRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
  try {
    importedRules = importedStylesheet.cssRules;
  } catch (error) {
    reportInaccessible(state, sourceUrl, error);
    return;
  }

  const condition = readMediaCondition(rule as MediaConditionSource);
  const nextMedia = appendMediaCondition(media, condition);
  const nextActiveStylesheets = new Set(activeStylesheets);
  nextActiveStylesheets.add(importedStylesheet);
  collectRules(
    element,
    importedRules,
    sourceUrl,
    `${stylesheetNamespace}`,
    nextMedia,
    undefined,
    depth + 1,
    facts,
    state,
    budget,
    nextActiveStylesheets,
  );
}

function resolveStyleSelector(
  selector: string,
  parent: StyleSelectorContext | undefined,
): StyleSelectorContext | undefined {
  if (
    selector.length === 0 ||
    selector.length > INSPECT_LIMITS.selectorLength
  ) {
    return undefined;
  }

  const resolvedSelector = parent
    ? resolveNestedSelector(selector, parent.resolvedSelector)
    : lexicallyValidSelector(selector)
      ? selector
      : undefined;
  if (!resolvedSelector) {
    return undefined;
  }

  return {
    sourceSelector: selector,
    resolvedSelector,
  };
}

function resolveNestedSelector(
  selector: string,
  parentSelector: string,
): string | undefined {
  const replacement = `:is(${parentSelector})`;
  let result = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let nestingSelectorFound = false;
  let parentheses = 0;
  let brackets = 0;
  let topLevelComma = false;

  for (const character of selector) {
    if (escaped) {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      quote = character;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) {
        return undefined;
      }
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) {
        return undefined;
      }
      brackets -= 1;
    } else if (
      character === "," &&
      parentheses === 0 &&
      brackets === 0
    ) {
      topLevelComma = true;
    }

    const addition = character === "&" ? replacement : character;
    if (
      result.length + addition.length >
      INSPECT_LIMITS.selectorLength
    ) {
      return undefined;
    }
    result += addition;
    nestingSelectorFound ||= character === "&";
  }

  if (escaped || quote || parentheses !== 0 || brackets !== 0) {
    return undefined;
  }
  if (nestingSelectorFound) {
    return result;
  }
  if (topLevelComma) {
    return undefined;
  }

  const descendantSelector = `${replacement} ${selector.trim()}`;
  return descendantSelector.length <= INSPECT_LIMITS.selectorLength
    ? descendantSelector
    : undefined;
}

function lexicallyValidSelector(selector: string): boolean {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;

  for (const character of selector) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) {
        return false;
      }
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) {
        return false;
      }
      brackets -= 1;
    }
  }

  return !escaped && !quote && parentheses === 0 && brackets === 0;
}

function matchesSelector(
  element: MatchableElement,
  selector: string,
): boolean | undefined {
  try {
    return element.matches(selector);
  } catch {
    return undefined;
  }
}

function isStyleRule(rule: RuleSource): rule is StyleRuleSource {
  const candidate = rule as Partial<StyleRuleSource>;
  return (
    typeof candidate.selectorText === "string" &&
    typeof candidate.style === "object" &&
    candidate.style !== null
  );
}

function isImportRuleCandidate(rule: RuleSource): rule is ImportRuleSource {
  return (
    !hasProperty(rule, "selectorText") &&
    !hasProperty(rule, "cssRules") &&
    hasProperty(rule, "styleSheet")
  );
}

function isStylesheetSource(value: unknown): value is StylesheetSource {
  return (
    typeof value === "object" &&
    value !== null &&
    hasProperty(value, "href") &&
    hasProperty(value, "cssRules")
  );
}

function isGroupRule(rule: RuleSource): rule is GroupRuleSource {
  return hasProperty(rule, "cssRules");
}

function readMediaCondition(rule: MediaConditionSource): MediaCondition {
  try {
    const media = rule.media;
    if (
      typeof media !== "object" ||
      media === null ||
      typeof media.mediaText !== "string"
    ) {
      return { value: "", truncated: false };
    }
    const condition =
      typeof rule.conditionText === "string"
        ? rule.conditionText
        : media.mediaText;
    return {
      value: truncate(condition, INSPECT_LIMITS.valueLength).trim(),
      truncated: condition.length > INSPECT_LIMITS.valueLength,
    };
  } catch {
    return { value: "", truncated: false };
  }
}

function appendMediaCondition(
  media: MediaConditions,
  condition: MediaCondition,
): MediaConditions {
  const conditionDropped = condition.value !== "" &&
    media.values.length >= INSPECT_LIMITS.mediaConditions;
  const values = condition.value &&
      media.values.length < INSPECT_LIMITS.mediaConditions
    ? [...media.values, condition.value]
    : media.values;
  const truncated = media.truncated || condition.truncated || conditionDropped;
  return values === media.values && truncated === media.truncated
    ? media
    : { values, truncated };
}

function exactImportRuleUrl(rule: RuleSource): string | undefined {
  const href = (rule as Partial<ImportRuleSource>).href;
  return typeof href === "string" ? exactBoundedUrl(href) : undefined;
}

function diagnosticImportUrl(
  rule: RuleSource,
  containingSourceUrl: string,
): string {
  try {
    return exactImportRuleUrl(rule) ?? containingSourceUrl;
  } catch {
    return containingSourceUrl;
  }
}

function reportInaccessible(
  state: CollectionState,
  sourceUrl: string,
  error: unknown,
): void {
  if (
    state.inaccessibleStylesheets.length >=
    INSPECT_LIMITS.inaccessibleStylesheets
  ) {
    return;
  }
  state.inaccessibleStylesheets.push({
    code: "browser.stylesheetInaccessible",
    sourceUrl,
    reason: truncate(messageOf(error), INSPECT_LIMITS.valueLength),
  });
}

function hasProperty(value: object, property: PropertyKey): boolean {
  try {
    return property in value;
  } catch {
    return false;
  }
}

function isNestedDeclarationsRule(
  rule: RuleSource,
): rule is NestedDeclarationsSource {
  if ("selectorText" in rule || "cssRules" in rule) {
    return false;
  }
  const candidate = rule as Partial<NestedDeclarationsSource> & {
    readonly constructor?: { readonly name?: unknown };
  };
  if (typeof candidate.style !== "object" || candidate.style === null) {
    return false;
  }
  const constructorName = candidate.constructor?.name;
  return (
    constructorName === undefined ||
    constructorName === "Object" ||
    constructorName === "CSSNestedDeclarations"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
