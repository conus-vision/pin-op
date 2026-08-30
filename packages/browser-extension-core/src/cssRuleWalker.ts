import {
  INSPECT_LIMITS,
  utf8ByteLength,
  type ProtocolErrorCode,
} from "@pin-op/protocol";
import {
  readAuthoredDeclarations,
  type AuthoredDeclaration,
  type AuthoredLonghand,
  type ShorthandExpander,
} from "./authoredDeclarations.js";
import {
  boundedLength,
  enumerateBounded,
  exactBoundedUrl,
  INSPECT_COLLECTION_MAX_BYTES,
  truncate,
} from "./inspectBounds.js";
import type { RuleReferenceRegistry } from "./ruleReferenceRegistry.js";

export interface MatchableElement {
  matches(selector: string): boolean;
}

export interface StyleDeclarationSource {
  readonly length: number;
  /** Serialized declaration block; absent sources are presented as longhands. */
  readonly cssText?: string;
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

export interface StylesheetSource {
  readonly href: string | null;
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

export interface CssDocumentSource {
  readonly pageUrl: string;
  readonly styleSheets: Iterable<StylesheetSource>;
  readonly adoptedStyleSheets?: Iterable<StylesheetSource>;
}

export interface InaccessibleStylesheet {
  readonly code: Extract<
    ProtocolErrorCode,
    "browser.stylesheetInaccessible"
  >;
  readonly sourceUrl: string;
  readonly reason: string;
}

export type CssRuleContextKind =
  | "media"
  | "supports"
  | "layer"
  | "scope"
  | "container"
  | "starting-style"
  | "unknown";

export interface CssRuleContextRecord {
  readonly kind: CssRuleContextKind;
  readonly text: string;
}

/** Plain internal projection: it deliberately contains no DOM/CSSOM objects. */
export interface CssRuleWalkRecord {
  readonly selector: string;
  readonly resolvedSelector: string;
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueTruncated: boolean;
  /** Present when the record is a shorthand: the longhands it sets. */
  readonly longhands?: readonly AuthoredLonghand[];
  readonly sourceUrl: string;
  readonly stylesheetIdentity: string;
  readonly rulePath: string;
  readonly media: readonly string[];
  readonly mediaTruncated: boolean;
  readonly contexts: readonly CssRuleContextRecord[];
  readonly contextsTruncated: boolean;
  readonly ruleRef?: string;
}

/** Browser-local observer record; native values must never be serialized. */
export interface CssMatchedRuleWalkRecord {
  readonly nativeRule: object;
  readonly nativeStylesheet: StylesheetSource;
  readonly selector: string;
  readonly resolvedSelector: string;
  readonly sourceUrl: string;
  readonly stylesheetIdentity: string;
  readonly rulePath: string;
  readonly media: readonly string[];
  readonly mediaTruncated: boolean;
  readonly contexts: readonly CssRuleContextRecord[];
  readonly contextsTruncated: boolean;
  readonly declarationsTruncated: boolean;
  readonly ruleRef?: string;
}

/** Browser-local selector candidate observed before current applicability. */
export interface CssStyleRuleCandidateRecord {
  readonly nativeRule: object;
  readonly nativeStylesheet: StylesheetSource;
  readonly selector: string;
  readonly resolvedSelector: string;
  readonly sourceUrl: string;
  readonly stylesheetIdentity: string;
  readonly rulePath: string;
  readonly media: readonly string[];
  readonly mediaTruncated: boolean;
  readonly contexts: readonly CssRuleContextRecord[];
  readonly contextsTruncated: boolean;
}

export interface CssRuleWalkOptions {
  readonly workBudget?: CssRuleWalkBudget;
  readonly isRuntimeStylesheet?: (stylesheet: object) => boolean;
  readonly ruleReferences?: Pick<RuleReferenceRegistry, "reference">;
  readonly referenceRule?: (
    stylesheet: StylesheetSource,
    stylesheetIdentity: string,
    rulePath: string,
    nativeRule: object,
  ) => string | undefined;
  readonly expandShorthand?: ShorthandExpander;
  readonly onStyleRuleCandidate?: (record: CssStyleRuleCandidateRecord) => void;
  readonly onMatchedRule?: (record: CssMatchedRuleWalkRecord) => void;
  readonly onSelectorUnavailable?: (selector: string) => void;
}

export type CssRuleWalkTruncationReason =
  | "facts-per-target-limit"
  | "css-rules-limit"
  | "byte-limit"
  | "declarations-per-rule-limit"
  | "stylesheets-limit"
  | "runtime-artifact-exclusion-failed"
  | "rule-depth-limit"
  | "context-limit";

export interface CssRuleWalkStatus {
  readonly truncated: boolean;
  readonly reasons: readonly CssRuleWalkTruncationReason[];
}

export interface CssRuleWalk {
  readonly records: IterableIterator<CssRuleWalkRecord>;
  readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[];
  readonly status: CssRuleWalkStatus;
}

/** Mutable authority shared by every CSSOM walk contributing to one snapshot. */
export interface CssRuleWalkBudget {
  remainingStylesheets: number;
  remainingRules: number;
  remainingDeclarations: number;
  remainingBytes: number;
}

interface StyleSelectorContext {
  readonly sourceSelector: string;
  readonly resolvedSelector: string;
}

interface BoundedValues<T> {
  readonly values: readonly T[];
  readonly truncated: boolean;
}

interface BoundedValue<T> {
  readonly value: T;
  readonly truncated: boolean;
  readonly sourceBytes: number;
}

interface WalkState {
  rulesVisited: number;
  stylesheetsVisited: number;
  recordsEmitted: number;
  nextStylesheetIdentity: number;
  nextRootIndex: number;
  runtimeBoundaryProbes: number;
  stylesheetBoundaryClosed: boolean;
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
  readonly truncationReasons: CssRuleWalkTruncationReason[];
  readonly options: CssRuleWalkOptions;
  readonly workBudget: CssRuleWalkBudget;
}

interface StylesheetWalkContext {
  readonly sourceUrl: string;
  readonly stylesheetIdentity: string;
  readonly nativeStylesheet: StylesheetSource;
}

const EMPTY_MEDIA: BoundedValues<string> = {
  values: [],
  truncated: false,
};
const EMPTY_CONTEXTS: BoundedValues<CssRuleContextRecord> = {
  values: [],
  truncated: false,
};
const CSS_SUPPORTS_RULE_TYPE = 12;

export function createCssRuleWalkBudget(): CssRuleWalkBudget {
  return {
    remainingStylesheets: INSPECT_LIMITS.stylesheets,
    remainingRules: INSPECT_LIMITS.cssRules,
    remainingDeclarations: INSPECT_LIMITS.factsPerTarget,
    remainingBytes: INSPECT_COLLECTION_MAX_BYTES,
  };
}

/**
 * Creates a one-shot, bounded CSSOM traversal. Records are yielded lazily so a
 * consumer can stop without causing further page-controlled CSSOM reads.
 */
export function walkCssRules(
  element: MatchableElement,
  document: CssDocumentSource,
  options: CssRuleWalkOptions = {},
): CssRuleWalk {
  const inaccessibleStylesheets: InaccessibleStylesheet[] = [];
  const state: WalkState = {
    rulesVisited: 0,
    stylesheetsVisited: 0,
    recordsEmitted: 0,
    nextStylesheetIdentity: 0,
    nextRootIndex: 0,
    runtimeBoundaryProbes: 0,
    stylesheetBoundaryClosed: false,
    inaccessibleStylesheets,
    truncationReasons: [],
    options,
    workBudget: options.workBudget ?? createCssRuleWalkBudget(),
  };
  const status: CssRuleWalkStatus = Object.freeze({
    get truncated() {
      return state.truncationReasons.length > 0;
    },
    get reasons() {
      return Object.freeze([...state.truncationReasons]);
    },
  });
  return {
    records: walkDocument(element, document, state),
    inaccessibleStylesheets,
    status,
  };
}

function* walkDocument(
  element: MatchableElement,
  document: CssDocumentSource,
  state: WalkState,
): IterableIterator<CssRuleWalkRecord> {
  let rootIndex = 0;
  let regularSheets: Iterable<StylesheetSource>;
  try {
    regularSheets = document.styleSheets;
  } catch {
    return;
  }
  yield* walkRootStylesheets(element, regularSheets, rootIndex, state);
  rootIndex = state.nextRootIndex;
  if (reachedWalkLimit(state)) return;

  let adoptedSheets: Iterable<StylesheetSource> | undefined;
  try {
    adoptedSheets = document.adoptedStyleSheets;
  } catch {
    return;
  }
  if (!adoptedSheets) return;
  yield* walkRootStylesheets(element, adoptedSheets, rootIndex, state);
}

function* walkRootStylesheets(
  element: MatchableElement,
  stylesheets: Iterable<StylesheetSource>,
  startingRootIndex: number,
  state: WalkState,
): IterableIterator<CssRuleWalkRecord> {
  let rootIndex = startingRootIndex;
  try {
    for (const stylesheet of enumerateStylesheetsBounded(stylesheets, state)) {
      if (isRuntimeStylesheet(state, stylesheet)) {
        continue;
      }
      if (stylesheetLimitReached(state)) return;
      state.nextRootIndex = rootIndex + 1;
      state.stylesheetsVisited += 1;
      state.workBudget.remainingStylesheets -= 1;
      const stylesheetIdentity = reserveStylesheetIdentity(state);

      let sourceUrl: string | undefined;
      try {
        sourceUrl = exactBoundedUrl(
          stylesheet.href ?? `inline-style://document/${rootIndex}`,
        );
      } catch {
        rootIndex += 1;
        continue;
      }
      if (!sourceUrl) {
        rootIndex += 1;
        continue;
      }
      if (!consumeWalkBytes(state, sourceUrl)) return;

      let rules: ArrayLike<RuleSource> | Iterable<RuleSource>;
      try {
        rules = stylesheet.cssRules;
      } catch (error) {
        reportInaccessible(state, sourceUrl, error);
        rootIndex += 1;
        continue;
      }

      try {
        yield* walkRules(
          element,
          rules,
          { sourceUrl, stylesheetIdentity, nativeStylesheet: stylesheet },
          `${rootIndex}`,
          EMPTY_MEDIA,
          EMPTY_CONTEXTS,
          undefined,
          0,
          state,
          new Set([stylesheet]),
        );
      } catch (error) {
        reportInaccessible(state, sourceUrl, error);
      }
      rootIndex += 1;
    }
  } catch {
    return;
  } finally {
    state.nextRootIndex = rootIndex;
  }
}

function* enumerateStylesheetsBounded(
  stylesheets: Iterable<StylesheetSource>,
  state: WalkState,
): IterableIterator<StylesheetSource> {
  const iterator = stylesheets[Symbol.iterator]();
  let exhausted = false;
  let rawPulls = 0;
  const rawPullLimit = INSPECT_LIMITS.stylesheets * 2;
  try {
    while (!reachedWalkLimit(state) && rawPulls < rawPullLimit) {
      if (
        !state.options.isRuntimeStylesheet &&
        stylesheetLimitReached(state)
      ) return;
      const result = iterator.next();
      rawPulls += 1;
      if (result.done) {
        exhausted = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!exhausted && rawPulls >= rawPullLimit) {
      markTruncation(state, "stylesheets-limit");
    }
    if (!exhausted) {
      try {
        iterator.return?.();
      } catch {
        // Page-controlled iterator cleanup is best effort.
      }
    }
  }
}

function* walkRules(
  element: MatchableElement,
  rules: ArrayLike<RuleSource> | Iterable<RuleSource>,
  stylesheet: StylesheetWalkContext,
  parentPath: string,
  media: BoundedValues<string>,
  contexts: BoundedValues<CssRuleContextRecord>,
  parentSelector: StyleSelectorContext | undefined,
  depth: number,
  state: WalkState,
  activeStylesheets: ReadonlySet<object>,
): IterableIterator<CssRuleWalkRecord> {
  if (depth > INSPECT_LIMITS.cssRuleDepth) {
    markTruncation(state, "rule-depth-limit");
    return;
  }
  if (reachedWalkLimit(state)) return;

  const remainingRules = Math.min(
    INSPECT_LIMITS.cssRules - state.rulesVisited,
    state.workBudget.remainingRules,
  );
  if (knownLengthExceeds(rules, remainingRules)) {
    markTruncation(state, "css-rules-limit");
  }
  for (const [ruleIndex, rule] of enumerateBounded(rules, remainingRules)) {
    if (reachedWalkLimit(state)) return;
    state.rulesVisited += 1;
    state.workBudget.remainingRules -= 1;
    const rulePath = `${parentPath}.${ruleIndex}`;

    if (isImportRuleCandidate(rule)) {
      yield* walkImportedStylesheet(
        element,
        rule,
        stylesheet.sourceUrl,
        media,
        contexts,
        depth,
        state,
        activeStylesheets,
      );
      if (reachedWalkLimit(state)) return;
      continue;
    }

    let childSelector = parentSelector;
    let nestedStyleRule = false;
    try {
      if (isStyleRule(rule)) {
        nestedStyleRule = true;
        const sourceSelector = rule.selectorText;
        if (!consumeWalkBytes(state, sourceSelector)) return;
        const selector = resolveStyleSelector(sourceSelector, parentSelector);
        if (!selector) {
          notifySelectorUnavailable(state, sourceSelector);
          continue;
        }
        notifyStyleRuleCandidate(state, {
          nativeRule: rule,
          nativeStylesheet: stylesheet.nativeStylesheet,
          selector: selector.sourceSelector,
          resolvedSelector: selector.resolvedSelector,
          sourceUrl: stylesheet.sourceUrl,
          stylesheetIdentity: stylesheet.stylesheetIdentity,
          rulePath,
          media: [...media.values],
          mediaTruncated: media.truncated,
          contexts: contexts.values.map((context) => ({ ...context })),
          contextsTruncated: contexts.truncated,
        });
        if (hasScopeSensitiveSelector(selector.resolvedSelector)) {
          notifySelectorUnavailable(state, selector.resolvedSelector);
        }
        const matches = matchesSelector(element, selector.resolvedSelector);
        if (matches === undefined) {
          notifySelectorUnavailable(state, selector.resolvedSelector);
          continue;
        }
        if (matches) {
          yield* walkDeclarations(
            rule,
            rule.style,
            selector,
            stylesheet,
            rulePath,
            media,
            contexts,
            state,
          );
        }
        childSelector = selector;
        if (reachedWalkLimit(state)) return;
      } else if (isNestedDeclarationsRule(rule) && parentSelector) {
        const matches = matchesSelector(element, parentSelector.resolvedSelector);
        if (matches === undefined) {
          notifySelectorUnavailable(state, parentSelector.resolvedSelector);
          continue;
        }
        if (matches) {
          yield* walkDeclarations(
            rule,
            rule.style,
            parentSelector,
            stylesheet,
            rulePath,
            media,
            contexts,
            state,
          );
        }
      }
    } catch {
      continue;
    }
    if (!isGroupRule(rule)) continue;
    if (depth >= INSPECT_LIMITS.cssRuleDepth) {
      markTruncation(state, "rule-depth-limit");
      continue;
    }

    const context = nestedStyleRule ? undefined : readRuleContext(rule);
    if (
      context &&
      !consumeWalkByteCount(state, context.sourceBytes)
    ) {
      return;
    }
    if (context && reachedWalkLimit(state)) return;
    let nestedRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
    try {
      nestedRules = rule.cssRules;
    } catch {
      continue;
    }
    const nextContexts = context
      ? appendBounded(contexts, context, INSPECT_LIMITS.mediaConditions)
      : contexts;
    const nextMedia = context?.value.kind === "media"
      ? appendBounded(
        media,
        {
          value: context.value.text,
          truncated: context.truncated,
          sourceBytes: 0,
        },
        INSPECT_LIMITS.mediaConditions,
      )
      : media;
    if (
      (!contexts.truncated && nextContexts.truncated) ||
      (!media.truncated && nextMedia.truncated)
    ) {
      markTruncation(state, "context-limit");
    }
    yield* walkRules(
      element,
      nestedRules,
      stylesheet,
      rulePath,
      nextMedia,
      nextContexts,
      childSelector,
      depth + 1,
      state,
      activeStylesheets,
    );
    if (reachedWalkLimit(state)) return;
  }
}

function* walkDeclarations(
  nativeRule: object,
  style: StyleDeclarationSource,
  selector: StyleSelectorContext,
  stylesheet: StylesheetWalkContext,
  rulePath: string,
  media: BoundedValues<string>,
  contexts: BoundedValues<CssRuleContextRecord>,
  state: WalkState,
): IterableIterator<CssRuleWalkRecord> {
  const remainingRecords = Math.min(
    INSPECT_LIMITS.factsPerTarget - state.recordsEmitted,
    state.workBudget.remainingDeclarations,
  );
  const declarationLimit = Math.min(
    INSPECT_LIMITS.declarationsPerRule,
    remainingRecords,
  );
  const declarationNames: string[] = [];
  let declaredLength: number;
  try {
    declaredLength = style.length;
  } catch {
    return;
  }
  const declarationCount = boundedLength(declaredLength, declarationLimit);
  if (declaredLength > INSPECT_LIMITS.declarationsPerRule) {
    markTruncation(state, "declarations-per-rule-limit");
  }
  if (declaredLength > remainingRecords) {
    markTruncation(state, "facts-per-target-limit");
  }
  for (let index = 0; index < declarationCount; index += 1) {
    state.workBudget.remainingDeclarations -= 1;
    try {
      const property = style.item(index);
      if (typeof property !== "string") continue;
      if (!consumeWalkBytes(state, property)) return;
      if (property && property.length <= INSPECT_LIMITS.propertyNameLength) {
        declarationNames.push(property);
      }
    } catch {
      continue;
    }
  }

  let ruleRef: string | undefined;
  if (declarationNames.length > 0) {
    ruleRef = state.options.referenceRule?.(
      stylesheet.nativeStylesheet,
      stylesheet.stylesheetIdentity,
      rulePath,
      nativeRule,
    ) ?? state.options.ruleReferences?.reference(
      stylesheet.stylesheetIdentity,
      rulePath,
      nativeRule,
    );
  }
  const longhands: PresentedDeclaration[] = [];
  for (const property of declarationNames) {
    try {
      const priority = style.getPropertyPriority(property);
      if (typeof priority !== "string") continue;
      if (!consumeWalkBytes(state, priority)) break;
      if (priority !== "" && priority !== "important") continue;
      const rawValue = style.getPropertyValue(property);
      if (typeof rawValue !== "string") continue;
      if (!consumeWalkBytes(state, rawValue)) break;
      longhands.push({
        property,
        value: truncate(rawValue, INSPECT_LIMITS.valueLength).trim(),
        important: priority === "important",
        valueTruncated: rawValue.length > INSPECT_LIMITS.valueLength,
      });
    } catch {
      continue;
    }
  }

  // The rule is presented the way it is written -- `margin: 0`, not its four
  // longhands -- whenever its serialized text accounts for every longhand the
  // CSSOM holds. The longhands ride along on the record so the cascade is still
  // decided one longhand at a time.
  const authored = longhands.length === declaredLength
    ? authoredForm(style, longhands, state)
    : undefined;
  const presented = authored ?? longhands;

  const records: CssRuleWalkRecord[] = [];
  for (const declaration of presented) {
    if (state.recordsEmitted >= INSPECT_LIMITS.factsPerTarget) break;
    records.push({
      selector: selector.sourceSelector,
      resolvedSelector: selector.resolvedSelector,
      property: declaration.property,
      value: declaration.value,
      important: declaration.important,
      valueTruncated: declaration.valueTruncated,
      ...(declaration.longhands ? { longhands: declaration.longhands } : {}),
      sourceUrl: stylesheet.sourceUrl,
      stylesheetIdentity: stylesheet.stylesheetIdentity,
      rulePath: truncate(rulePath, INSPECT_LIMITS.selectorLength),
      media: [...media.values],
      mediaTruncated: media.truncated,
      contexts: contexts.values.map((context) => ({ ...context })),
      contextsTruncated: contexts.truncated,
      ...(ruleRef ? { ruleRef } : {}),
    });
    state.recordsEmitted += 1;
  }
  state.options.onMatchedRule?.({
    nativeRule,
    nativeStylesheet: stylesheet.nativeStylesheet,
    selector: selector.sourceSelector,
    resolvedSelector: selector.resolvedSelector,
    sourceUrl: stylesheet.sourceUrl,
    stylesheetIdentity: stylesheet.stylesheetIdentity,
    rulePath,
    media: [...media.values],
    mediaTruncated: media.truncated,
    contexts: contexts.values.map((context) => ({ ...context })),
    contextsTruncated: contexts.truncated,
    declarationsTruncated: presented.length > records.length ||
      (!authored && declaredLength > records.length),
    ...(ruleRef ? { ruleRef } : {}),
  });
  for (const record of records) yield record;
}

interface PresentedDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueTruncated: boolean;
  readonly longhands?: readonly AuthoredLonghand[];
}

function authoredForm(
  style: StyleDeclarationSource,
  longhands: readonly PresentedDeclaration[],
  state: WalkState,
): readonly PresentedDeclaration[] | undefined {
  let cssText: unknown;
  try {
    cssText = style.cssText;
  } catch {
    return undefined;
  }
  if (typeof cssText !== "string" || cssText === "") return undefined;
  // A soft charge: the text carries the declarations already charged as
  // longhands, so a rule too large for what is left simply stays longhand.
  if (!offerWalkBytes(state, cssText)) return undefined;
  const authored = readAuthoredDeclarations(
    cssText,
    longhands,
    state.options.expandShorthand,
  );
  return authored?.map((declaration) => ({
    property: declaration.property,
    value: truncate(declaration.value, INSPECT_LIMITS.valueLength).trim(),
    important: declaration.important,
    valueTruncated: declaration.value.length > INSPECT_LIMITS.valueLength,
    ...(coversOtherProperties(declaration)
      ? { longhands: declaration.longhands }
      : {}),
  }));
}

function coversOtherProperties(declaration: AuthoredDeclaration): boolean {
  const [only] = declaration.longhands;
  return declaration.longhands.length !== 1 ||
    only?.property !== declaration.property;
}

function* walkImportedStylesheet(
  element: MatchableElement,
  rule: RuleSource,
  containingSourceUrl: string,
  media: BoundedValues<string>,
  contexts: BoundedValues<CssRuleContextRecord>,
  depth: number,
  state: WalkState,
  activeStylesheets: ReadonlySet<object>,
): IterableIterator<CssRuleWalkRecord> {
  if (depth >= INSPECT_LIMITS.cssRuleDepth || reachedWalkLimit(state)) return;

  if (stylesheetLimitReached(state, false)) {
    if (state.stylesheetBoundaryClosed) {
      stylesheetLimitReached(state);
      return;
    }
    if (
      state.options.isRuntimeStylesheet &&
      state.runtimeBoundaryProbes < INSPECT_LIMITS.stylesheets
    ) {
      state.runtimeBoundaryProbes += 1;
      let boundaryCandidate: StylesheetSource | undefined;
      try {
        const candidate = (rule as Partial<ImportRuleSource>).styleSheet;
        boundaryCandidate = isStylesheetSource(candidate) ? candidate : undefined;
      } catch {
        state.stylesheetBoundaryClosed = true;
        stylesheetLimitReached(state);
        return;
      }
      if (
        boundaryCandidate &&
        (
          isRuntimeStylesheet(state, boundaryCandidate) ||
          activeStylesheets.has(boundaryCandidate)
        )
      ) return;
    }
    state.stylesheetBoundaryClosed = true;
    stylesheetLimitReached(state);
    return;
  }

  let importedStylesheet: StylesheetSource;
  try {
    const candidate = (rule as Partial<ImportRuleSource>).styleSheet;
    if (!isStylesheetSource(candidate)) return;
    importedStylesheet = candidate;
  } catch (error) {
    consumeStylesheetAuthority(state);
    reportInaccessible(
      state,
      diagnosticImportUrl(rule, containingSourceUrl),
      error,
    );
    return;
  }
  if (isRuntimeStylesheet(state, importedStylesheet)) return;
  if (activeStylesheets.has(importedStylesheet)) return;

  const stylesheetNamespace = state.stylesheetsVisited;
  consumeStylesheetAuthority(state);
  const stylesheetIdentity = reserveStylesheetIdentity(state);

  let sourceUrl: string | undefined;
  try {
    sourceUrl = importedStylesheet.href === null
      ? exactImportRuleUrl(rule)
      : exactBoundedUrl(importedStylesheet.href);
  } catch (error) {
    reportInaccessible(
      state,
      diagnosticImportUrl(rule, containingSourceUrl),
      error,
    );
    return;
  }
  if (!sourceUrl) return;
  if (!consumeWalkBytes(state, sourceUrl)) return;

  const importContext = readImportMediaContext(rule);
  if (
    importContext &&
    !consumeWalkByteCount(state, importContext.sourceBytes)
  ) {
    return;
  }
  if (importContext && reachedWalkLimit(state)) return;
  let importedRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
  try {
    importedRules = importedStylesheet.cssRules;
  } catch (error) {
    reportInaccessible(state, sourceUrl, error);
    return;
  }

  const nextContexts = importContext
    ? appendBounded(contexts, importContext, INSPECT_LIMITS.mediaConditions)
    : contexts;
  const nextMedia = importContext
    ? appendBounded(
      media,
      {
        value: importContext.value.text,
        truncated: importContext.truncated,
        sourceBytes: 0,
      },
      INSPECT_LIMITS.mediaConditions,
    )
    : media;
  const nextActiveStylesheets = new Set(activeStylesheets);
  nextActiveStylesheets.add(importedStylesheet);
  try {
    yield* walkRules(
      element,
      importedRules,
      {
        sourceUrl,
        stylesheetIdentity,
        nativeStylesheet: importedStylesheet,
      },
      `${stylesheetNamespace}`,
      nextMedia,
      nextContexts,
      undefined,
      depth + 1,
      state,
      nextActiveStylesheets,
    );
  } catch (error) {
    reportInaccessible(state, sourceUrl, error);
  }
}

function isRuntimeStylesheet(
  state: WalkState,
  stylesheet: object,
): boolean {
  try {
    return state.options.isRuntimeStylesheet?.(stylesheet) === true;
  } catch (error) {
    markTruncation(state, "runtime-artifact-exclusion-failed");
    reportInaccessible(
      state,
      "runtime-artifact://stylesheet-classification",
      error,
    );
    return true;
  }
}

function resolveStyleSelector(
  selector: string,
  parent: StyleSelectorContext | undefined,
): StyleSelectorContext | undefined {
  if (selector.length === 0 || selector.length > INSPECT_LIMITS.selectorLength) {
    return undefined;
  }
  const resolvedSelector = parent
    ? resolveNestedSelector(selector, parent.resolvedSelector)
    : lexicallyValidSelector(selector)
      ? selector
      : undefined;
  return resolvedSelector
    ? { sourceSelector: selector, resolvedSelector }
    : undefined;
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
      if (result.length >= INSPECT_LIMITS.selectorLength) return undefined;
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (result.length >= INSPECT_LIMITS.selectorLength) return undefined;
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (result.length >= INSPECT_LIMITS.selectorLength) return undefined;
      result += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      if (result.length >= INSPECT_LIMITS.selectorLength) return undefined;
      result += character;
      quote = character;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) return undefined;
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) return undefined;
      brackets -= 1;
    } else if (character === "," && parentheses === 0 && brackets === 0) {
      topLevelComma = true;
    }

    const addition = character === "&" ? replacement : character;
    if (result.length + addition.length > INSPECT_LIMITS.selectorLength) {
      return undefined;
    }
    result += addition;
    nestingSelectorFound ||= character === "&";
  }
  if (escaped || quote || parentheses !== 0 || brackets !== 0) return undefined;
  if (nestingSelectorFound) return result;
  if (topLevelComma) return undefined;
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
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) return false;
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) return false;
      brackets -= 1;
    }
  }
  return !escaped && !quote && parentheses === 0 && brackets === 0;
}

function readRuleContext(
  rule: GroupRuleSource,
): BoundedValue<CssRuleContextRecord> {
  const constructorName = readConstructorName(rule);
  const mediaCondition = (
    constructorName === "CSSMediaRule" || hasProperty(rule, "media")
  )
    ? readMediaCondition(rule)
    : undefined;
  if (constructorName === "CSSMediaRule" || mediaCondition) {
    const condition = mediaCondition ?? {
      value: "",
      truncated: false,
      sourceBytes: 0,
    };
    return {
      value: { kind: "media", text: condition.value },
      truncated: condition.truncated,
      sourceBytes: condition.sourceBytes,
    };
  }

  let kind: CssRuleContextKind;
  switch (constructorName) {
    case "CSSSupportsRule":
      kind = "supports";
      break;
    case "CSSLayerBlockRule":
      kind = "layer";
      break;
    case "CSSScopeRule":
      kind = "scope";
      break;
    case "CSSContainerRule":
      kind = "container";
      break;
    case "CSSStartingStyleRule":
      kind = "starting-style";
      break;
    default:
      kind = hasRuleType(rule, CSS_SUPPORTS_RULE_TYPE)
        ? "supports"
        : "unknown";
  }

  const rawText = kind === "starting-style"
    ? ""
    : kind === "layer"
      ? readStringProperty(rule, "name") ?? readCssHeader(rule)
      : readStringProperty(rule, "conditionText") ?? readCssHeader(rule);
  return boundedContext(kind, rawText);
}

function readImportMediaContext(
  rule: RuleSource,
): BoundedValue<CssRuleContextRecord> | undefined {
  const condition = readMediaCondition(rule as MediaConditionSource);
  return condition?.value
    ? {
      value: { kind: "media", text: condition.value },
      truncated: condition.truncated,
      sourceBytes: condition.sourceBytes,
    }
    : undefined;
}

function boundedContext(
  kind: CssRuleContextKind,
  rawText: string,
): BoundedValue<CssRuleContextRecord> {
  return {
    value: {
      kind,
      text: truncate(rawText, INSPECT_LIMITS.valueLength).trim(),
    },
    truncated: rawText.length > INSPECT_LIMITS.valueLength,
    sourceBytes: utf8ByteLength(rawText),
  };
}

function readMediaCondition(
  rule: MediaConditionSource,
): BoundedValue<string> | undefined {
  try {
    const conditionText = rule.conditionText;
    if (typeof conditionText === "string") {
      return boundedContextText(conditionText);
    }
    const media = rule.media;
    if (typeof media !== "object" || media === null) {
      return undefined;
    }
    const mediaText = media.mediaText;
    return typeof mediaText === "string"
      ? boundedContextText(mediaText)
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedContextText(rawText: string): BoundedValue<string> {
  return {
    value: truncate(rawText, INSPECT_LIMITS.valueLength).trim(),
    truncated: rawText.length > INSPECT_LIMITS.valueLength,
    sourceBytes: utf8ByteLength(rawText),
  };
}

function appendBounded<T>(
  current: BoundedValues<T>,
  next: BoundedValue<T>,
  limit: number,
): BoundedValues<T> {
  const dropped = current.values.length >= limit;
  return {
    values: dropped ? current.values : [...current.values, next.value],
    truncated: current.truncated || next.truncated || dropped,
  };
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

function notifySelectorUnavailable(state: WalkState, selector: string): void {
  try {
    state.options.onSelectorUnavailable?.(
      truncate(selector, INSPECT_LIMITS.selectorLength),
    );
  } catch {
    // Diagnostics supplied by a caller cannot make page traversal fail.
  }
}

function notifyStyleRuleCandidate(
  state: WalkState,
  record: CssStyleRuleCandidateRecord,
): void {
  try {
    state.options.onStyleRuleCandidate?.(record);
  } catch {
    // Observer evidence cannot change the bounded stylesheet walk.
  }
}

function hasScopeSensitiveSelector(selector: string): boolean {
  return /:host(?:-context)?\b|::slotted\b|(?:^|[^\\])&/i.test(selector);
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

function isNestedDeclarationsRule(
  rule: RuleSource,
): rule is NestedDeclarationsSource {
  if (hasProperty(rule, "selectorText") || hasProperty(rule, "cssRules")) {
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

function readConstructorName(rule: object): string {
  try {
    const constructor = (rule as {
      readonly constructor?: { readonly name?: unknown };
    }).constructor;
    return typeof constructor?.name === "string" ? constructor.name : "";
  } catch {
    return "";
  }
}

function readStringProperty(
  rule: object,
  property: PropertyKey,
): string | undefined {
  try {
    const value = (rule as Record<PropertyKey, unknown>)[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasRuleType(rule: object, type: number): boolean {
  try {
    return (rule as { readonly type?: unknown }).type === type;
  } catch {
    return false;
  }
}

function readCssHeader(rule: object): string {
  const cssText = readStringProperty(rule, "cssText") ?? "";
  const blockStart = cssText.indexOf("{");
  return (blockStart >= 0 ? cssText.slice(0, blockStart) : cssText).trim();
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
  state: WalkState,
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

function reserveStylesheetIdentity(state: WalkState): string {
  const identity = `sheet-${state.nextStylesheetIdentity}`;
  state.nextStylesheetIdentity += 1;
  return identity;
}

function reachedWalkLimit(state: WalkState): boolean {
  const factsLimit = state.recordsEmitted >= INSPECT_LIMITS.factsPerTarget ||
    state.workBudget.remainingDeclarations <= 0;
  const rulesLimit = state.rulesVisited >= INSPECT_LIMITS.cssRules ||
    state.workBudget.remainingRules <= 0;
  const byteLimit = state.workBudget.remainingBytes <= 0;
  if (factsLimit) markTruncation(state, "facts-per-target-limit");
  if (rulesLimit) markTruncation(state, "css-rules-limit");
  if (byteLimit) markTruncation(state, "byte-limit");
  return factsLimit || rulesLimit || byteLimit;
}

function stylesheetLimitReached(
  state: WalkState,
  mark = true,
): boolean {
  const stylesheetLimit = state.stylesheetsVisited >= INSPECT_LIMITS.stylesheets ||
    state.workBudget.remainingStylesheets <= 0;
  if (stylesheetLimit && mark) markTruncation(state, "stylesheets-limit");
  return stylesheetLimit;
}

function consumeStylesheetAuthority(state: WalkState): void {
  state.stylesheetsVisited += 1;
  state.workBudget.remainingStylesheets -= 1;
}

function consumeWalkBytes(state: WalkState, value: string): boolean {
  let bytes: number;
  try {
    bytes = utf8ByteLength(value);
  } catch {
    state.workBudget.remainingBytes = 0;
    markTruncation(state, "byte-limit");
    return false;
  }
  return consumeWalkByteCount(state, bytes);
}

/** Charges bytes when they fit, and otherwise declines without closing the walk. */
function offerWalkBytes(state: WalkState, value: string): boolean {
  let bytes: number;
  try {
    bytes = utf8ByteLength(value);
  } catch {
    return false;
  }
  if (bytes > state.workBudget.remainingBytes) return false;
  state.workBudget.remainingBytes -= bytes;
  return true;
}

function consumeWalkByteCount(state: WalkState, bytes: number): boolean {
  if (bytes > state.workBudget.remainingBytes) {
    state.workBudget.remainingBytes = 0;
    markTruncation(state, "byte-limit");
    return false;
  }
  state.workBudget.remainingBytes -= bytes;
  return true;
}

function knownLengthExceeds(
  source: ArrayLike<unknown> | Iterable<unknown>,
  limit: number,
): boolean {
  try {
    const length = (source as Partial<ArrayLike<unknown>>).length;
    return typeof length === "number" && Number.isFinite(length) && length > limit;
  } catch {
    return false;
  }
}

function markTruncation(
  state: WalkState,
  reason: CssRuleWalkTruncationReason,
): void {
  if (!state.truncationReasons.includes(reason)) {
    state.truncationReasons.push(reason);
  }
}

function hasProperty(value: object, property: PropertyKey): boolean {
  try {
    return property in value;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Stylesheet access failed";
  }
}
