import selectorParser from "postcss-selector-parser";
import { INSPECT_LIMITS, utf8ByteLength } from "@pin-op/protocol";
import {
  classifyCascade,
  type CascadeCandidate,
  type SelectorSpecificity,
} from "./cascadeClassifier.js";
import {
  createCssRuleWalkBudget,
  walkCssRules,
  type CssMatchedRuleWalkRecord,
  type CssRuleWalkBudget,
  type CssRuleWalkRecord,
  type StyleDeclarationSource,
  type StylesheetSource,
} from "./cssRuleWalker.js";
import type { DomTreeResolvedElement } from "./domTreeProvider.js";
import { truncate } from "./inspectBounds.js";
import type {
  GeneratedMatchedRuleSource,
  InheritedMatchedRules,
  MatchedDeclaration,
  MatchedRule,
  MatchedStyles,
} from "./matchedStylesTypes.js";
import type {
  StylesheetRegistryEntry,
  StylesheetRegistrySnapshot,
} from "./stylesheetRegistry.js";

export const MATCHED_STYLES_MAX_ANCESTORS = 32;

export interface MatchedStylesCollectionAuthority {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly nodeRef: string;
}

export interface MatchedStylesNodeAuthority {
  resolveElement(
    nodeRef: string,
    documentEpoch: number,
  ): DomTreeResolvedElement | undefined;
}

export interface MatchedStylesStylesheetAuthority {
  snapshot(): StylesheetRegistrySnapshot;
  entriesForElement(element: Element): readonly StylesheetRegistryEntry[];
  referenceRule(
    entry: StylesheetRegistryEntry,
    rulePath: string,
    nativeRule: object,
  ): string;
  referenceInlineRule(element: Element): string;
}

export interface MatchedStylesCollectorOptions {
  readonly domTreeProvider: MatchedStylesNodeAuthority;
  readonly stylesheets: MatchedStylesStylesheetAuthority;
  readonly isAuthorityCurrent?: (
    authority: MatchedStylesCollectionAuthority,
  ) => boolean;
}

interface RuleDraft {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly specificity: SelectorSpecificity | undefined;
  readonly contexts: CssMatchedRuleWalkRecord["contexts"];
  readonly contextsTruncated: boolean;
  readonly mediaTruncated: boolean;
  readonly active: boolean | undefined;
  readonly source: GeneratedMatchedRuleSource;
  readonly sourceOrder: number;
  readonly declarations: CssRuleWalkRecord[];
}

interface DeclarationDraft {
  readonly rule: RuleDraft;
  readonly record: CssRuleWalkRecord;
  readonly candidate: CascadeCandidate;
}

/** Synchronous browser-local matched-author snapshot for one selected node. */
export class MatchedStylesCollector {
  public constructor(private readonly options: MatchedStylesCollectorOptions) {}

  public collect(
    authority: MatchedStylesCollectionAuthority,
  ): MatchedStyles | undefined {
    if (!validAuthority(authority) || !this.isCurrent(authority)) return undefined;

    let selected: DomTreeResolvedElement | undefined;
    let before: StylesheetRegistrySnapshot;
    try {
      before = this.options.stylesheets.snapshot();
      if (!sameRevisions(authority, before)) return undefined;
      selected = this.options.domTreeProvider.resolveElement(
        authority.nodeRef,
        authority.documentEpoch,
      );
    } catch {
      return undefined;
    }
    if (!selected) return undefined;

    const diagnostics = new Set<string>(
      before.diagnostics.map(({ code }) => code),
    );
    const workBudget = createCssRuleWalkBudget();
    const inline = this.collectInline(selected.element, diagnostics, workBudget);
    const direct = this.collectElement(
      selected.element,
      before,
      diagnostics,
      workBudget,
    );
    const ancestors: InheritedMatchedRules[] = [];
    let ancestor = composedParent(selected.element);
    let ancestorIndex = 1;
    const visited = new Set<object>([selected.element]);
    while (ancestor && ancestorIndex <= MATCHED_STYLES_MAX_ANCESTORS) {
      if (visited.has(ancestor)) {
        diagnostics.add("ancestor-cycle");
        break;
      }
      visited.add(ancestor);
      const ancestorInline = this.collectInline(ancestor, diagnostics, workBudget);
      const collected = this.collectElement(
        ancestor,
        before,
        diagnostics,
        workBudget,
      );
      const inheritedRules = buildRules(
        ancestorInline ? [ancestorInline, ...collected] : collected,
        true,
      );
      if (inheritedRules.length > 0) {
        ancestors.push({
          ancestorIndex,
          elementName: safeElementName(ancestor),
          rules: inheritedRules,
        });
      }
      ancestor = composedParent(ancestor);
      ancestorIndex += 1;
    }
    if (ancestor) diagnostics.add("ancestor-limit");

    const directDrafts = inline ? [inline, ...direct] : direct;
    const directRules = buildRules(directDrafts, false);
    const inlineRule = inline
      ? directRules.find(({ ruleRef }) => ruleRef === inline.ruleRef)
      : undefined;
    const rules = inlineRule
      ? directRules.filter(({ ruleRef }) => ruleRef !== inlineRule.ruleRef)
      : directRules;

    let after: StylesheetRegistrySnapshot;
    let resolvedAgain: DomTreeResolvedElement | undefined;
    try {
      after = this.options.stylesheets.snapshot();
      resolvedAgain = this.options.domTreeProvider.resolveElement(
        authority.nodeRef,
        authority.documentEpoch,
      );
    } catch {
      return undefined;
    }
    if (
      !sameRevisions(authority, after) ||
      !resolvedAgain ||
      resolvedAgain.element !== selected.element ||
      !this.isCurrent(authority)
    ) {
      return undefined;
    }

    const inaccessibleStylesheetCount = Math.max(
      before.inaccessibleStylesheetCount,
      countDiagnostic(diagnostics, "stylesheet-inaccessible"),
    );
    const result: MatchedStyles = {
      ...authority,
      ...(inlineRule ? { inline: inlineRule } : {}),
      rules,
      inherited: ancestors,
      inaccessibleStylesheetCount,
      partial: before.partial || diagnostics.size > before.diagnostics.length,
      diagnostics: [...diagnostics],
    };
    return deepFreeze(result);
  }

  private collectElement(
    element: Element,
    snapshot: StylesheetRegistrySnapshot,
    diagnostics: Set<string>,
    workBudget: CssRuleWalkBudget,
  ): RuleDraft[] {
    detectUnsupportedCrossRootSelectors(element, snapshot, diagnostics);
    let scopedEntries: readonly StylesheetRegistryEntry[];
    try {
      scopedEntries = this.options.stylesheets.entriesForElement(element);
    } catch {
      diagnostics.add("scope-unavailable");
      return [];
    }
    const currentEntries = new Set(snapshot.entries);
    const entries = scopedEntries.filter((entry) => currentEntries.has(entry));
    const entryBySheet = new Map<object, StylesheetRegistryEntry>();
    for (const entry of entries) entryBySheet.set(entry.sheet, entry);
    const roots: StylesheetSource[] = [];
    const seenRoots = new Set<object>();
    for (const entry of entries) {
      if (entry.kind === "import" || seenRoots.has(entry.sheet)) continue;
      seenRoots.add(entry.sheet);
      roots.push(entry.sheet as unknown as StylesheetSource);
    }

    const drafts: RuleDraft[] = [];
    const draftByRef = new Map<string, RuleDraft>();
    let sourceOrder = 0;
    const walk = walkCssRules(
      element,
      { pageUrl: pageUrlFor(element), styleSheets: roots },
      {
        workBudget,
        referenceRule: (nativeStylesheet, _identity, rulePath, nativeRule) => {
          const entry = entryBySheet.get(nativeStylesheet);
          if (!entry) {
            diagnostics.add("scope-sheet-partial");
            return undefined;
          }
          try {
            return this.options.stylesheets.referenceRule(entry, rulePath, nativeRule);
          } catch {
            diagnostics.add("rule-reference-unavailable");
            return undefined;
          }
        },
        onSelectorUnavailable: () => diagnostics.add("selector-unavailable"),
        onMatchedRule: (record) => {
          if (!record.ruleRef) return;
          const entry = entryBySheet.get(record.nativeStylesheet);
          if (!entry) return;
          const matching = matchingSelectors(element, record, diagnostics);
          const localPath = localRulePath(record.rulePath);
          const range = entry.generatedRanges[localPath];
          const source: GeneratedMatchedRuleSource = {
            ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
            ...(range ?? {}),
            rulePath: record.rulePath,
          };
          const draft: RuleDraft = {
            ruleRef: record.ruleRef,
            selectorText: record.selector,
            matchingSelectorIndices: matching.indices,
            specificity: matching.specificity,
            contexts: record.contexts,
            contextsTruncated: record.contextsTruncated,
            mediaTruncated: record.mediaTruncated,
            active: record.contextsTruncated || record.mediaTruncated
              ? undefined
              : combineApplicability(
                contextsActive(element, record.contexts),
                ownerActive(element, entry),
              ),
            source,
            sourceOrder: sourceOrder++,
            declarations: [],
          };
          drafts.push(draft);
          draftByRef.set(record.ruleRef, draft);
        },
      },
    );
    for (const declaration of walk.records) {
      if (!declaration.ruleRef) continue;
      draftByRef.get(declaration.ruleRef)?.declarations.push(declaration);
    }
    if (walk.inaccessibleStylesheets.length > 0) {
      diagnostics.add("stylesheet-inaccessible");
    }
    for (const reason of walk.status.reasons) diagnostics.add(reason);
    return drafts.filter(({ declarations }) => declarations.length > 0);
  }

  private collectInline(
    element: Element,
    diagnostics: Set<string>,
    workBudget: CssRuleWalkBudget,
  ): RuleDraft | undefined {
    const style = safeStyle(element);
    if (!style) return undefined;
    const declarations = readInlineDeclarations(style, workBudget, diagnostics);
    if (declarations.length === 0) return undefined;
    let ruleRef: string;
    try {
      ruleRef = this.options.stylesheets.referenceInlineRule(element);
    } catch {
      diagnostics.add("rule-reference-unavailable");
      return undefined;
    }
    return {
      ruleRef,
      selectorText: "element.style",
      matchingSelectorIndices: [],
      specificity: [1_000_000, 0, 0],
      contexts: [],
      contextsTruncated: false,
      mediaTruncated: false,
      active: true,
      source: { rulePath: "0" },
      sourceOrder: Number.MAX_SAFE_INTEGER,
      declarations: declarations.map((declaration) => ({
        ...declaration,
        selector: "element.style",
        resolvedSelector: "element.style",
        sourceUrl: "",
        stylesheetIdentity: "inline",
        rulePath: "0",
        media: [],
        mediaTruncated: false,
        contexts: [],
        contextsTruncated: false,
        ruleRef,
      })),
    };
  }

  private isCurrent(authority: MatchedStylesCollectionAuthority): boolean {
    try {
      return this.options.isAuthorityCurrent?.(authority) ?? true;
    } catch {
      return false;
    }
  }
}

function buildRules(drafts: readonly RuleDraft[], inherited: boolean): MatchedRule[] {
  const declarationDrafts: DeclarationDraft[] = [];
  let declarationOrder = 0;
  for (const rule of drafts) {
    for (const record of rule.declarations) {
      declarationDrafts.push({
        rule,
        record,
        candidate: {
          property: record.property,
          value: record.value,
          important: record.important,
          specificity: rule.specificity,
          sourceOrder: rule.sourceOrder * INSPECT_LIMITS.declarationsPerRule +
            declarationOrder++,
          contexts: rule.contexts,
          active: rule.active,
          inherited,
        },
      });
    }
  }
  const candidates = declarationDrafts.map(({ candidate }) => candidate);
  const byRule = new Map<RuleDraft, MatchedDeclaration[]>();
  for (const draft of declarationDrafts) {
    const classification = classifyCascade(draft.candidate, candidates);
    const declaration: MatchedDeclaration = {
      ruleRef: draft.rule.ruleRef,
      property: draft.record.property,
      value: draft.record.value,
      important: draft.record.important,
      valueTruncated: draft.record.valueTruncated,
      ...classification,
    };
    const declarations = byRule.get(draft.rule) ?? [];
    declarations.push(declaration);
    byRule.set(draft.rule, declarations);
  }
  return drafts.flatMap((draft) => {
    const declarations = byRule.get(draft);
    if (!declarations || declarations.length === 0) return [];
    return [{
      ruleRef: draft.ruleRef,
      selectorText: draft.selectorText,
      matchingSelectorIndices: draft.matchingSelectorIndices,
      declarations,
      contexts: draft.contexts,
      ...(draft.contextsTruncated ? { contextsTruncated: true } : {}),
      ...(draft.mediaTruncated ? { mediaTruncated: true } : {}),
      source: draft.source,
    }];
  });
}

function matchingSelectors(
  element: Element,
  record: CssMatchedRuleWalkRecord,
  diagnostics: Set<string>,
): { readonly indices: readonly number[]; readonly specificity: SelectorSpecificity | undefined } {
  if (record.selector !== record.resolvedSelector) {
    diagnostics.add("unsupported-nested-selector");
    return { indices: [0], specificity: undefined };
  }
  let selectors: readonly string[];
  try {
    selectors = selectorParser().astSync(record.selector).nodes.map(
      (selector) => selector.toString().trim(),
    );
  } catch {
    diagnostics.add("selector-unavailable");
    return { indices: [], specificity: undefined };
  }
  const indices: number[] = [];
  let specificity: SelectorSpecificity | undefined;
  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index]!;
    let matches = false;
    try {
      matches = element.matches(selector);
    } catch {
      diagnostics.add("selector-unavailable");
      continue;
    }
    if (!matches) continue;
    indices.push(index);
    const next = specificityFor(selector);
    if (!next) {
      diagnostics.add("unsupported-selector-specificity");
      specificity = undefined;
      continue;
    }
    if (specificity === undefined || compareSpecificity(next, specificity) > 0) {
      specificity = next;
    }
  }
  return { indices, specificity };
}

function ownerActive(
  element: Element,
  entry: StylesheetRegistryEntry,
): boolean | undefined {
  const sheetApplicability = sheetActive(element, entry.sheet);
  const state = entry.ownerState;
  if (!state) return sheetApplicability;
  const ownerApplicability = state.disabled || state.alternate
    ? false
    : state.media.trim()
      ? mediaActive(element, state.media)
      : true;
  return combineApplicability(sheetApplicability, ownerApplicability);
}

function sheetActive(element: Element, sheet: CSSStyleSheet): boolean | undefined {
  let disabled: unknown;
  try {
    disabled = (sheet as unknown as { readonly disabled?: unknown }).disabled;
  } catch {
    return undefined;
  }
  if (disabled === true) return false;
  if (disabled !== undefined && disabled !== false) return undefined;

  let media: unknown;
  try {
    media = (sheet as unknown as { readonly media?: unknown }).media;
  } catch {
    return undefined;
  }
  if (media === undefined || media === null) return true;
  if (typeof media !== "object") return undefined;
  let mediaText: unknown;
  try {
    mediaText = (media as { readonly mediaText?: unknown }).mediaText;
  } catch {
    return undefined;
  }
  if (typeof mediaText !== "string") return undefined;
  return mediaText.trim() ? mediaActive(element, mediaText) : true;
}

function combineApplicability(
  left: boolean | undefined,
  right: boolean | undefined,
): boolean | undefined {
  if (left === false || right === false) return false;
  return left === undefined || right === undefined ? undefined : true;
}

function specificityFor(selector: string): SelectorSpecificity | undefined {
  let root: ReturnType<ReturnType<typeof selectorParser>["astSync"]>;
  try {
    root = selectorParser().astSync(selector);
  } catch {
    return undefined;
  }
  if (root.nodes.length !== 1) return undefined;
  return specificityForNodes(
    root.nodes[0]!.nodes as unknown as readonly SpecificityNode[],
  );
}

interface SpecificityNode {
  readonly type: string;
  readonly value?: string;
  readonly nodes?: readonly SpecificityNode[];
}

function specificityForNodes(
  nodes: readonly SpecificityNode[],
): SelectorSpecificity | undefined {
  let identifiers = 0;
  let classes = 0;
  let types = 0;
  for (const node of nodes) {
    switch (node.type) {
      case "id":
        identifiers += 1;
        break;
      case "class":
      case "attribute":
        classes += 1;
        break;
      case "tag":
        types += 1;
        break;
      case "pseudo": {
        const value = node.value?.toLowerCase() ?? "";
        if (value === ":host" || value === ":host-context" || value === "::slotted") {
          return undefined;
        }
        if (value.startsWith("::")) {
          types += 1;
          break;
        }
        if (node.nodes && node.nodes.length > 0) {
          if (value === ":where") break;
          if (value !== ":is" && value !== ":not" && value !== ":has") {
            return undefined;
          }
          let maximum: SelectorSpecificity | undefined;
          for (const selectorNode of node.nodes) {
            if (selectorNode.type !== "selector" || !selectorNode.nodes) return undefined;
            const nested = specificityForNodes(selectorNode.nodes);
            if (!nested) return undefined;
            if (!maximum || compareSpecificity(nested, maximum) > 0) maximum = nested;
          }
          if (!maximum) return undefined;
          identifiers += maximum[0];
          classes += maximum[1];
          types += maximum[2];
          break;
        }
        classes += 1;
        break;
      }
      case "universal":
      case "combinator":
      case "comment":
        break;
      default:
        return undefined;
    }
  }
  return [identifiers, classes, types];
}

function compareSpecificity(
  left: SelectorSpecificity,
  right: SelectorSpecificity,
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function contextsActive(
  element: Element,
  contexts: CssMatchedRuleWalkRecord["contexts"],
): boolean | undefined {
  let unknown = false;
  for (const context of contexts) {
    let active: boolean | undefined = true;
    if (context.kind === "media") active = mediaActive(element, context.text);
    if (context.kind === "supports") active = supportsActive(element, context.text);
    if (active === false) return false;
    if (active === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

function mediaActive(element: Element, condition: string): boolean | undefined {
  try {
    const root = element.getRootNode() as Document | ShadowRoot;
    const document = (root as Document).nodeType === 9
      ? root as Document
      : (root as ShadowRoot).ownerDocument;
    const matchMedia = document.defaultView?.matchMedia;
    return typeof matchMedia === "function"
      ? matchMedia.call(document.defaultView, condition).matches
      : undefined;
  } catch {
    return undefined;
  }
}

function supportsActive(element: Element, condition: string): boolean | undefined {
  try {
    const root = element.getRootNode() as Document | ShadowRoot;
    const document = (root as Document).nodeType === 9
      ? root as Document
      : (root as ShadowRoot).ownerDocument;
    const css = (document.defaultView as unknown as {
      readonly CSS?: { supports?: (query: string) => boolean };
    } | null)?.CSS;
    return typeof css?.supports === "function" ? css.supports(condition) : undefined;
  } catch {
    return undefined;
  }
}

function readInlineDeclarations(
  style: StyleDeclarationSource,
  workBudget: CssRuleWalkBudget,
  diagnostics: Set<string>,
): Array<Pick<
  CssRuleWalkRecord,
  "property" | "value" | "important" | "valueTruncated"
>> {
  const result: Array<Pick<
    CssRuleWalkRecord,
    "property" | "value" | "important" | "valueTruncated"
  >> = [];
  let declaredLength: number;
  try {
    declaredLength = style.length;
  } catch {
    diagnostics.add("inline-declaration-unavailable");
    return result;
  }
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    diagnostics.add("inline-declaration-unavailable");
    return result;
  }
  if (declaredLength === 0) return result;
  if (workBudget.remainingRules <= 0) {
    diagnostics.add("css-rules-limit");
    return result;
  }
  workBudget.remainingRules -= 1;
  if (declaredLength > INSPECT_LIMITS.declarationsPerRule) {
    diagnostics.add("declarations-per-rule-limit");
  }
  if (declaredLength > workBudget.remainingDeclarations) {
    diagnostics.add("facts-per-target-limit");
  }
  const length = Math.min(
    declaredLength,
    INSPECT_LIMITS.declarationsPerRule,
    workBudget.remainingDeclarations,
  );
  for (let index = 0; index < length; index += 1) {
    workBudget.remainingDeclarations -= 1;
    try {
      const property = style.item(index);
      if (typeof property !== "string") {
        diagnostics.add("inline-declaration-unavailable");
        continue;
      }
      if (!consumeInlineBytes(workBudget, property, diagnostics)) break;
      if (!property || property.length > INSPECT_LIMITS.propertyNameLength) continue;
      const priority = style.getPropertyPriority(property);
      if (typeof priority !== "string") {
        diagnostics.add("inline-declaration-unavailable");
        continue;
      }
      if (!consumeInlineBytes(workBudget, priority, diagnostics)) break;
      if (priority !== "" && priority !== "important") continue;
      const rawValue = style.getPropertyValue(property);
      if (typeof rawValue !== "string") {
        diagnostics.add("inline-declaration-unavailable");
        continue;
      }
      if (!consumeInlineBytes(workBudget, rawValue, diagnostics)) break;
      result.push({
        property,
        value: truncate(rawValue, INSPECT_LIMITS.valueLength).trim(),
        important: priority === "important",
        valueTruncated: rawValue.length > INSPECT_LIMITS.valueLength,
      });
    } catch {
      diagnostics.add("inline-declaration-unavailable");
      continue;
    }
  }
  return result;
}

function consumeInlineBytes(
  workBudget: CssRuleWalkBudget,
  value: string,
  diagnostics: Set<string>,
): boolean {
  let bytes: number;
  try {
    bytes = utf8ByteLength(value);
  } catch {
    workBudget.remainingBytes = 0;
    diagnostics.add("byte-limit");
    return false;
  }
  if (bytes > workBudget.remainingBytes) {
    workBudget.remainingBytes = 0;
    diagnostics.add("byte-limit");
    return false;
  }
  workBudget.remainingBytes -= bytes;
  return true;
}

function safeStyle(element: Element): StyleDeclarationSource | undefined {
  try {
    const style = (element as unknown as { readonly style?: unknown }).style;
    return typeof style === "object" && style !== null
      ? style as StyleDeclarationSource
      : undefined;
  } catch {
    return undefined;
  }
}

function composedParent(element: Element): Element | undefined {
  try {
    const slot = (element as unknown as { readonly assignedSlot?: unknown }).assignedSlot;
    if (typeof slot === "object" && slot !== null) return slot as Element;
  } catch {
    return undefined;
  }
  try {
    if (element.parentElement) return element.parentElement;
  } catch {
    return undefined;
  }
  try {
    const root = element.getRootNode();
    const host = (root as ShadowRoot).host;
    return typeof host === "object" && host !== null ? host : undefined;
  } catch {
    return undefined;
  }
}

function detectUnsupportedCrossRootSelectors(
  element: Element,
  snapshot: StylesheetRegistrySnapshot,
  diagnostics: Set<string>,
): void {
  let shadowRoot: object | undefined;
  try {
    const candidate = (element as unknown as { readonly shadowRoot?: unknown }).shadowRoot;
    if (typeof candidate === "object" && candidate !== null) shadowRoot = candidate;
  } catch {
    diagnostics.add("cross-root-scope-unavailable");
  }
  if (
    shadowRoot &&
    safeStringProperty(shadowRoot, "mode") !== "closed" &&
    snapshot.entries.some(({ scope }) => scope === shadowRoot)
  ) {
    diagnostics.add("unsupported-host-selector-scope");
  }

  let assignedSlot: object | undefined;
  try {
    const candidate = (element as unknown as { readonly assignedSlot?: unknown }).assignedSlot;
    if (typeof candidate === "object" && candidate !== null) assignedSlot = candidate;
  } catch {
    diagnostics.add("cross-root-scope-unavailable");
  }
  if (!assignedSlot) return;
  let slotRoot: object | undefined;
  try {
    const getRootNode = (assignedSlot as { readonly getRootNode?: unknown }).getRootNode;
    const candidate = typeof getRootNode === "function"
      ? getRootNode.call(assignedSlot)
      : undefined;
    if (typeof candidate === "object" && candidate !== null) slotRoot = candidate;
  } catch {
    diagnostics.add("cross-root-scope-unavailable");
  }
  if (slotRoot && snapshot.entries.some(({ scope }) => scope === slotRoot)) {
    diagnostics.add("unsupported-slotted-selector-scope");
  }
}

function safeStringProperty(value: object, property: PropertyKey): string | undefined {
  try {
    const candidate = (value as Record<PropertyKey, unknown>)[property];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function localRulePath(rulePath: string): string {
  const separator = rulePath.indexOf(".");
  return separator < 0 ? rulePath : rulePath.slice(separator + 1);
}

function pageUrlFor(element: Element): string {
  try {
    const root = element.getRootNode() as Document | ShadowRoot;
    const document = (root as Document).nodeType === 9
      ? root as Document
      : (root as ShadowRoot).ownerDocument;
    return document.location?.href ?? "http://localhost/";
  } catch {
    return "http://localhost/";
  }
}

function safeElementName(element: Element): string {
  try {
    return truncate(element.tagName.toLowerCase(), INSPECT_LIMITS.selectorLength);
  } catch {
    return "element";
  }
}

function validAuthority(authority: MatchedStylesCollectionAuthority): boolean {
  return typeof authority.nodeRef === "string" && authority.nodeRef.length > 0 &&
    [
      authority.documentEpoch,
      authority.selectionRevision,
      authority.stylesRevision,
      authority.stylesheetRevision,
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

function sameRevisions(
  authority: MatchedStylesCollectionAuthority,
  snapshot: StylesheetRegistrySnapshot,
): boolean {
  return authority.documentEpoch === snapshot.documentEpoch &&
    authority.stylesRevision === snapshot.stylesRevision &&
    authority.stylesheetRevision === snapshot.stylesheetRevision;
}

function countDiagnostic(diagnostics: ReadonlySet<string>, value: string): number {
  return diagnostics.has(value) ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
