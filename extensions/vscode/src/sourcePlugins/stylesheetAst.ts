import { createHash } from "node:crypto";
import postcss, {
  type AtRule,
  type Container,
  type Declaration,
  type Document,
  type Root,
  type Rule,
} from "postcss";
import selectorParser from "postcss-selector-parser";
import { parse as parseScss } from "postcss-scss";
import type {
  SourceDocument,
  SourcePosition,
  SourceRange,
} from "@pin-op/plugin-api";
import {
  INSPECT_LIMITS,
  type CssRuleFact,
} from "@pin-op/protocol";
import { BoundedLruCache } from "./boundedLruCache.js";
import {
  parseBrowserRulePath,
  stableCssRuleIdentity,
} from "./cssFacts.js";
import {
  declarationEvidenceFromFact,
  declarationFingerprint,
  declarationsContainEvidence,
  normalizeCondition,
} from "./declarationFingerprint.js";
import type {
  CssDeclarationEvidence,
  RuleFingerprint,
} from "./types.js";

export type StylesheetSyntax = "css" | "scss";

export interface StylesheetRule {
  readonly selector: string;
  readonly range: SourceRange;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly fingerprint: RuleFingerprint;
}

type RuleIndex = ReadonlyMap<string, StylesheetRule | null>;
type FallbackIndex = ReadonlyMap<string, readonly StylesheetRule[] | null>;

export interface ParsedStylesheet {
  readonly uri: string;
  readonly syntax: StylesheetSyntax;
  readonly document: SourceDocument;
  readonly rules: readonly StylesheetRule[];
  readonly pathIndex: RuleIndex;
  readonly fallbackIndex: FallbackIndex;
  readonly fallbackMediaIndex: FallbackIndex;
}

const FALLBACK_BUCKET_LIMIT = 32;
const FALLBACK_ENTRY_LIMIT = INSPECT_LIMITS.cssRules * 2;
export const DOCUMENT_STYLESHEET_CACHE_LIMIT = 32;
export const GENERATED_STYLESHEET_CACHE_LIMIT = 32;

interface CachedDocumentStylesheet {
  readonly version: number;
  readonly contentHash: string;
  readonly parsed: ParsedStylesheet;
}

export class StylesheetAstCache {
  private readonly documents = new BoundedLruCache<
    string,
    CachedDocumentStylesheet
  >(DOCUMENT_STYLESHEET_CACHE_LIMIT);
  private readonly generated = new BoundedLruCache<string, ParsedStylesheet>(
    GENERATED_STYLESHEET_CACHE_LIMIT,
  );

  public parseDocument(
    document: SourceDocument,
    syntax: StylesheetSyntax,
  ): ParsedStylesheet {
    const key = `${syntax}:${document.uri}`;
    const text = document.getText();
    const contentHash = hashText(text);
    const cached = this.documents.get(key);
    if (
      cached?.version === document.version &&
      cached.contentHash === contentHash
    ) {
      return cached.parsed;
    }

    const parsed = parseStylesheet(document, syntax, text);
    this.documents.set(key, { version: document.version, contentHash, parsed });
    return parsed;
  }

  public parseText(
    uri: string,
    syntax: StylesheetSyntax,
    text: string,
  ): ParsedStylesheet {
    const hash = hashText(text);
    const key = `${syntax}:${uri}:${hash}`;
    const cached = this.generated.get(key);
    if (cached) return cached;

    const parsed = parseStylesheet(textDocument(uri, text), syntax, text);
    this.generated.set(key, parsed);
    return parsed;
  }
}

export function findMatchingCssRules(
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
  document: SourceDocument,
  declarations?: readonly CssDeclarationEvidence[],
): StylesheetRule[] {
  const exact = findExactCssRules(stylesheet, fact, document);
  if (exact.length > 0) return exact;
  if (!canFingerprintFallback(fact, document)) return [];
  return [...findRulesByFingerprint(stylesheet, fact, declarations)];
}

export function findExactCssRules(
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
  document: SourceDocument,
): StylesheetRule[] {
  if (fact.source !== undefined) {
    if (!validSourcePosition(fact.source.line, fact.source.column)) return [];
    const requested = {
      line: fact.source.line - 1,
      character: fact.source.column - 1,
    };
    const offset = document.offsetAt(requested);
    if (!samePosition(document.positionAt(offset), requested)) return [];
    const smallest = smallestRule(stylesheet.rules.filter(
      (rule) => rule.startOffset <= offset && offset < rule.endOffset,
    ));
    return smallest ? [smallest] : [];
  }

  if (Object.prototype.hasOwnProperty.call(fact.metadata, "rulePath")) {
    const browserPath = parseBrowserRulePath(fact.metadata.rulePath);
    if (browserPath === undefined) return [];
    const rule = stylesheet.pathIndex.get(browserPath);
    return rule ? [rule] : [];
  }

  return [];
}

export function canFingerprintFallback(
  fact: CssRuleFact,
  document?: SourceDocument,
): boolean {
  if (stableCssRuleIdentity(fact) === undefined) return false;
  if (factMedia(fact) === null) return false;
  if (fact.source !== undefined) {
    if (!validSourcePosition(fact.source.line, fact.source.column)) return false;
    if (!document) return true;
    const requested = {
      line: fact.source.line - 1,
      character: fact.source.column - 1,
    };
    return samePosition(
      document.positionAt(document.offsetAt(requested)),
      requested,
    );
  }
  if (Object.prototype.hasOwnProperty.call(fact.metadata, "rulePath")) {
    return parseBrowserRulePath(fact.metadata.rulePath) !== undefined;
  }
  return true;
}

export function findRulesByFingerprint(
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
  declarations?: readonly CssDeclarationEvidence[],
): readonly StylesheetRule[] {
  if (!canFingerprintFallback(fact)) return [];
  const bucket = fingerprintBucket(stylesheet, fact);
  if (!bucket) return [];
  const factDeclaration = declarationEvidenceFromFact(fact);
  const evidence = declarationFingerprint(
    declarations ?? (factDeclaration ? [factDeclaration] : []),
  );
  if (evidence.length === 0) return [];
  return bucket.filter((rule) =>
    declarationsContainEvidence(rule.fingerprint.declarations, evidence)
  );
}

function fingerprintBucket(
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
): readonly StylesheetRule[] {
  const selector = fallbackSelectorKey(fact.selector);
  if (selector === undefined) return [];
  const media = factMedia(fact);
  if (media === null) return [];
  const bucket = stylesheet.fallbackMediaIndex.get(
    fallbackMediaKey(selector, media),
  );
  return bucket ?? [];
}

export function smallestContainingRule(
  rules: readonly StylesheetRule[],
  offset: number,
): StylesheetRule | undefined {
  return smallestRule(rules.filter(
    (rule) => rule.startOffset <= offset && offset < rule.endOffset,
  ));
}

export function normalizeSelector(selector: string): string | undefined {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;
  try {
    return selectorParser().processSync(trimmed, { lossless: false }).trim();
  } catch {
    return undefined;
  }
}

function parseStylesheet(
  document: SourceDocument,
  syntax: StylesheetSyntax,
  text = document.getText(),
): ParsedStylesheet {
  const root = syntax === "scss"
    ? parseScss(text, { from: document.uri })
    : postcss.parse(text, { from: document.uri });
  const rules: StylesheetRule[] = [];
  const rulesByNode = new Map<Rule, StylesheetRule>();
  root.walkRules((node) => {
    const rule = ruleFromNode(node, document);
    if (!rule) return;
    rules.push(rule);
    rulesByNode.set(node, rule);
  });

  if (syntax === "scss") {
    return emptyIndexedStylesheet(document, syntax, rules);
  }

  const indexes = new CssomIndexBuilder(rulesByNode);
  indexes.index(root);
  return {
    uri: document.uri,
    syntax,
    document,
    rules,
    pathIndex: indexes.pathIndex,
    fallbackIndex: indexes.fallbackIndex,
    fallbackMediaIndex: indexes.fallbackMediaIndex,
  };
}

function emptyIndexedStylesheet(
  document: SourceDocument,
  syntax: StylesheetSyntax,
  rules: readonly StylesheetRule[],
): ParsedStylesheet {
  return {
    uri: document.uri,
    syntax,
    document,
    rules,
    pathIndex: new Map(),
    fallbackIndex: new Map(),
    fallbackMediaIndex: new Map(),
  };
}

function ruleFromNode(
  node: Rule,
  document: SourceDocument,
): StylesheetRule | undefined {
  const start = node.source?.start?.offset;
  const end = node.source?.end?.offset;
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return {
    selector: node.selector,
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end),
    },
    startOffset: start,
    endOffset: end,
    fingerprint: {
      selector: normalizeSelector(node.selector),
      declarations: declarationFingerprint(directDeclarations(node)),
      conditions: containingMedia(node).map(normalizeCondition),
    },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function directDeclarations(node: Rule): CssDeclarationEvidence[] {
  return (node.nodes ?? [])
    .filter((child): child is Declaration => child.type === "decl")
    .map((declaration) => ({
      property: declaration.prop,
      value: declaration.value,
      important: declaration.important,
    }));
}

type ContainerContext = "rules" | "keyframes";
type RootPhase = "initial" | "imports" | "namespaces" | "body";

interface AtRuleClassification {
  readonly kind: "count" | "drop" | "uncertain";
  readonly childContext?: ContainerContext;
  readonly namespacePrefix?: string;
  readonly recurse?: boolean;
}

// Deliberately limited to rule types used by the read-only MVP. New or
// feature-gated CSSOM rule types fail closed until a browser parity fixture is
// added here.
const GROUP_AT_RULES = new Set([
  "container",
  "layer",
  "media",
  "scope",
  "starting-style",
  "supports",
]);
const LEAF_AT_RULES = new Set([
  "color-profile",
  "counter-style",
  "font-face",
  "font-feature-values",
  "font-palette-values",
  "page",
  "property",
  "view-transition",
]);
const KEYFRAMES_AT_RULES = new Set(["keyframes", "-webkit-keyframes"]);
const RESERVED_FONT_FAMILY_NAMES = new Set([
  "caption", "cursive", "default", "emoji", "fangsong", "fantasy", "icon", "math",
  "menu", "message-box", "monospace", "sans-serif", "serif", "small-caption",
  "status-bar", "system-ui", "ui-monospace", "ui-rounded", "ui-sans-serif",
  "ui-serif",
]);

class CssomIndexBuilder {
  public readonly pathIndex = new Map<string, StylesheetRule | null>();
  public readonly fallbackIndex: FallbackIndex;
  public readonly fallbackMediaIndex: FallbackIndex;

  private readonly selectorValidity = new Map<Rule, boolean>();
  private readonly namespaces = new Set<string>();
  private readonly fallback = new FallbackIndexBuilder();
  private visitedRules = 0;

  public constructor(
    private readonly rulesByNode: ReadonlyMap<Rule, StylesheetRule>,
  ) {
    this.fallbackIndex = this.fallback.selectorIndex;
    this.fallbackMediaIndex = this.fallback.mediaIndex;
  }

  public index(root: Root): void {
    this.indexContainer(root, [], undefined, "rules", true, 0);
  }

  private indexContainer(
    container: Container,
    parentPath: readonly number[],
    owner: Rule | undefined,
    context: ContainerContext,
    inheritedTrusted: boolean,
    depth: number,
  ): void {
    let pathTrusted = inheritedTrusted;
    let cssomIndex = 0;
    let cssRuleSeen = container.type !== "rule";
    let declarationsPending = false;
    let rootPhase: RootPhase = "initial";
    const isRoot = container.type === "root" || container.type === "document";

    const flushDeclarations = (): void => {
      if (!declarationsPending || !owner) return;
      const path = [...parentPath, cssomIndex];
      const withinBudget = this.visitRule();
      if (pathTrusted && withinBudget) {
        this.addPath(path, owner);
      }
      const rule = this.rulesByNode.get(owner);
      if (rule) {
        this.fallback.add(
          rule,
          containingMediaFrom(container),
          pathTrusted && withinBudget,
        );
      }
      cssomIndex += 1;
      declarationsPending = false;
    };

    const markUncertain = (): void => {
      pathTrusted = false;
      declarationsPending = false;
      cssRuleSeen = true;
      if (isRoot) rootPhase = "body";
    };

    for (const node of container.nodes ?? []) {
      if (node.type === "decl") {
        if (owner && cssRuleSeen) declarationsPending = true;
        continue;
      }
      if (node.type === "comment") continue;

      if (node.type === "rule") {
        if (context === "keyframes") {
          flushDeclarations();
          this.visitRule();
          cssomIndex += 1;
          cssRuleSeen = true;
          continue;
        }
        if (!this.validSelector(node, owner !== undefined)) {
          markUncertain();
          continue;
        }

        flushDeclarations();
        if (isRoot) rootPhase = "body";
        const path = [...parentPath, cssomIndex];
        const withinBudget = this.visitRule();
        const rule = this.rulesByNode.get(node);
        if (rule) {
          this.fallback.add(
            rule,
            containingMedia(node),
            pathTrusted && withinBudget,
          );
          if (pathTrusted && withinBudget) this.addPath(path, node);
        } else {
          pathTrusted = false;
        }
        cssomIndex += 1;
        cssRuleSeen = true;
        if (depth < INSPECT_LIMITS.cssRuleDepth) {
          this.indexContainer(
            node,
            path,
            node,
            "rules",
            pathTrusted && withinBudget,
            depth + 1,
          );
        }
        continue;
      }

      if (node.type !== "atrule") {
        markUncertain();
        continue;
      }

      const classification = classifyAtRule(
        node,
        isRoot,
        rootPhase,
        owner !== undefined,
        this.namespaces,
      );
      if (classification.kind === "drop") continue;
      if (classification.kind === "uncertain") {
        markUncertain();
        continue;
      }

      flushDeclarations();
      const name = node.name.toLowerCase();
      if (isRoot) {
        rootPhase = nextRootPhase(rootPhase, name, node.nodes !== undefined);
        if (classification.namespacePrefix !== undefined) {
          this.namespaces.add(classification.namespacePrefix);
        }
      }
      const path = [...parentPath, cssomIndex];
      const withinBudget = this.visitRule();
      cssomIndex += 1;
      cssRuleSeen = true;
      if (
        classification.recurse &&
        node.nodes &&
        depth < INSPECT_LIMITS.cssRuleDepth
      ) {
        this.indexContainer(
          node,
          path,
          owner,
          classification.childContext ?? "rules",
          pathTrusted && withinBudget,
          depth + 1,
        );
      }
    }
    flushDeclarations();
  }

  private validSelector(rule: Rule, relativeAllowed: boolean): boolean {
    const cached = this.selectorValidity.get(rule);
    if (cached !== undefined) return cached;
    const selector = rule.selector;
    let valid = selector.length > 0 &&
      selector.length <= INSPECT_LIMITS.selectorLength;
    if (valid) valid = validSelectorAst(
      selector,
      relativeAllowed,
      this.namespaces,
    );
    this.selectorValidity.set(rule, valid);
    return valid;
  }

  private visitRule(): boolean {
    const withinBudget = this.visitedRules < INSPECT_LIMITS.cssRules;
    this.visitedRules += 1;
    return withinBudget;
  }

  private addPath(path: readonly number[], node: Rule): void {
    const rule = this.rulesByNode.get(node);
    if (!rule) return;
    const key = path.join(".");
    if (this.pathIndex.has(key)) {
      this.pathIndex.set(key, null);
      return;
    }
    this.pathIndex.set(key, rule);
  }
}

class FallbackIndexBuilder {
  public readonly selectorIndex = new Map<
    string,
    readonly StylesheetRule[] | null
  >();
  public readonly mediaIndex = new Map<
    string,
    readonly StylesheetRule[] | null
  >();

  private entries = 0;
  private disabled = false;

  public add(
    rule: StylesheetRule,
    media: readonly string[],
    trusted: boolean,
  ): void {
    if (this.disabled || !trusted) return;
    const normalizedSelector = rule.fingerprint.selector;
    if (normalizedSelector === undefined) return;
    const selector = fallbackSelectorKey(normalizedSelector);
    if (selector === undefined) return;
    this.addToIndex(this.selectorIndex, selector, rule);
    this.addToIndex(
      this.mediaIndex,
      fallbackMediaKey(selector, media.map(normalizeCondition)),
      rule,
    );
  }

  private addToIndex(
    index: Map<string, readonly StylesheetRule[] | null>,
    key: string,
    rule: StylesheetRule,
  ): void {
    if (this.disabled) return;
    const bucket = index.get(key);
    if (bucket === null || bucket?.includes(rule)) return;
    this.entries += 1;
    if (this.entries > FALLBACK_ENTRY_LIMIT) {
      this.disabled = true;
      this.selectorIndex.clear();
      this.mediaIndex.clear();
      return;
    }
    if (bucket && bucket.length >= FALLBACK_BUCKET_LIMIT) {
      index.set(key, null);
      return;
    }
    index.set(key, bucket ? [...bucket, rule] : [rule]);
  }
}

function classifyAtRule(
  rule: AtRule,
  isRoot: boolean,
  rootPhase: RootPhase,
  nestedInStyle: boolean,
  namespaces: ReadonlySet<string>,
): AtRuleClassification {
  const name = rule.name.toLowerCase();
  const hasBlock = rule.nodes !== undefined;
  const hasParameters = rule.params.trim().length > 0;
  if (name === "charset") return { kind: "drop" };
  if (name === "import") {
    return !hasBlock && validImportParams(rule.params) && isRoot &&
        (rootPhase === "initial" || rootPhase === "imports")
      ? { kind: "count" }
      : { kind: "uncertain" };
  }
  if (name === "namespace") {
    if (hasBlock || !hasParameters || !isRoot || rootPhase === "body") {
      return { kind: "uncertain" };
    }
    const prefix = namespacePrefix(rule.params);
    return prefix === undefined
      ? { kind: "uncertain" }
      : { kind: "count", ...(prefix === null ? {} : { namespacePrefix: prefix }) };
  }
  if (GROUP_AT_RULES.has(name)) {
    if (!validGroupAtRule(rule, namespaces)) {
      return { kind: "uncertain" };
    }
    return { kind: "count", recurse: hasBlock, childContext: "rules" };
  }
  if (KEYFRAMES_AT_RULES.has(name)) {
    return nestedInStyle || !hasBlock || !hasParameters
      ? { kind: "uncertain" }
      : { kind: "count", recurse: true, childContext: "keyframes" };
  }
  if (LEAF_AT_RULES.has(name)) {
    return nestedInStyle || !validLeafAtRule(rule)
      ? { kind: "uncertain" }
      : { kind: "count" };
  }
  return { kind: "uncertain" };
}

function nextRootPhase(
  phase: RootPhase,
  name: string,
  hasBlock: boolean,
): RootPhase {
  if (name === "import") return "imports";
  if (name === "namespace") return "namespaces";
  if (
    name === "layer" && !hasBlock &&
    (phase === "initial" || phase === "imports")
  ) return phase;
  return "body";
}

function validSelectorAst(
  value: string,
  relativeAllowed: boolean,
  namespaces: ReadonlySet<string>,
): boolean {
  try {
    const root = selectorParser().astSync(value);
    return root.nodes.length > 0 && root.nodes.every((selector) => {
      if (!validSelectorSequence(selector.nodes, relativeAllowed)) return false;
      let valid = true;
      selector.walk((node) => {
        if (
          node.type === "selector" &&
          !validSelectorSequence(node.nodes, true)
        ) {
          valid = false;
        } else if (node.type === "nesting") {
          const next = node.next();
          valid = relativeAllowed &&
            next?.type !== "tag" && next?.type !== "universal";
        } else if (
          selectorParser.isNamespace(node) &&
          typeof node.namespace === "string" &&
          node.namespace !== "*" &&
          !namespaces.has(node.namespace)
        ) {
          valid = false;
        }
        return valid;
      });
      return valid;
    });
  } catch {
    return false;
  }
}

function validSelectorSequence(
  nodes: readonly { readonly type: string; readonly value?: string }[],
  relativeAllowed: boolean,
): boolean {
  const significant = nodes.filter((node) => node.type !== "comment");
  return significant.length > 0 && significant.every((node, index) => {
    if (node.type === "combinator") {
      return index < significant.length - 1 &&
        significant[index + 1]!.type !== "combinator" &&
        (relativeAllowed || index > 0);
    }
    return !isPseudoElement(node.value ?? "") || index === significant.length - 1;
  });
}

function isPseudoElement(value: string): boolean {
  return value.startsWith("::") ||
    [":after", ":before", ":first-letter", ":first-line"]
      .includes(value.toLowerCase());
}

function validLeafAtRule(rule: AtRule): boolean {
  const name = rule.name.toLowerCase();
  const params = rule.params.trim();
  if (rule.nodes === undefined || params.length > INSPECT_LIMITS.valueLength) {
    return false;
  }
  if (name === "font-face" || name === "view-transition") return params === "";
  if (
    name === "property" || name === "font-palette-values" ||
    name === "color-profile"
  ) return /^--[_A-Za-z][_A-Za-z0-9-]*$/.test(params);
  if (name === "counter-style") {
    return simpleName(params) && params.toLowerCase() !== "none";
  }
  if (name === "font-feature-values") {
    return params.split(",").every((family) =>
      family.trim().split(/\s+/).every((part) =>
        simpleName(part) && !RESERVED_FONT_FAMILY_NAMES.has(part.toLowerCase())
      )
    );
  }
  if (name === "page") {
    return params === "" || params.split(",").every((entry) => {
      const match = /^(?:([-_A-Za-z][-_A-Za-z0-9]*))?(?::(left|right|first|blank))?$/i
        .exec(entry.trim());
      return !!match && (!!match[2] || (!!match[1] && simpleName(match[1])));
    });
  }
  return false;
}

function validGroupAtRule(
  rule: AtRule,
  namespaces: ReadonlySet<string>,
): boolean {
  const name = rule.name.toLowerCase();
  const block = rule.nodes !== undefined;
  const params = rule.params.trim();
  if (params.length > INSPECT_LIMITS.valueLength) return false;
  if (name === "media") return block && balancedParentheses(params);
  if (name === "supports") return block && simpleCondition(params);
  if (name === "container") return block && simpleContainer(params);
  if (name === "starting-style") return block && params === "";
  if (name === "layer") {
    const names = params.split(",").map((entry) => entry.trim());
    return block
      ? params === "" || (names.length === 1 && layerName(names[0]!))
      : names.length > 0 && names.every(layerName);
  }
  if (name === "scope") {
    if (!block || params === "") return block;
    const match = /^(?:\(([^()]+)\))?(?:\s+to\s+\(([^()]+)\))?$/i.exec(params);
    const selectors = match?.slice(1).filter((entry): entry is string => !!entry);
    return !!selectors?.length && selectors.every((selector) =>
      validSelectorAst(selector, false, namespaces)
    );
  }
  return false;
}

function simpleCondition(value: string): boolean {
  if (/[;{}]/.test(value) || !balancedParentheses(value)) return false;
  const negated = /^not\s+/i.test(value);
  const pattern = /^(?:not\s+)?\([^()]+\)(?:\s+(and|or)\s+\([^()]+\))*$/i;
  if (!pattern.test(value)) return false;
  const operators = [...value.matchAll(/\)\s+(and|or)\s+\(/gi)]
    .map((match) => match[1]!.toLowerCase());
  return (!negated || operators.length === 0) && new Set(operators).size <= 1;
}

function simpleContainer(value: string): boolean {
  if (simpleCondition(value)) return true;
  const match = /^([^\s(),]+)(?:\s+(.+))?$/.exec(value);
  return !!match && validContainerName(match[1]!) &&
    match[2] !== undefined && simpleCondition(match[2]);
}

function validContainerName(value: string): boolean {
  return simpleName(value) &&
    !["and", "default", "none", "not", "or"].includes(value.toLowerCase());
}

function layerName(value: string): boolean {
  return value.split(".").every(simpleName);
}

function simpleName(value: string): boolean {
  return /^-?[_A-Za-z][_A-Za-z0-9-]*$/.test(value) &&
    !["initial", "inherit", "revert", "revert-layer", "unset"]
      .includes(value.toLowerCase());
}

function namespacePrefix(value: string): string | null | undefined {
  const match = /^(?:(-?[_A-Za-z][_A-Za-z0-9-]*)\s+)?(?:url\(\s*[^()'"\s]+\s*\)|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')$/i
    .exec(value.trim());
  return match ? match[1] ?? null : undefined;
}

function validImportParams(value: string): boolean {
  if (value.length > INSPECT_LIMITS.valueLength) return false;
  const match = /^(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|url\(\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^()'"\s]+)\s*\))(?:\s+(.+))?$/i
    .exec(value.trim());
  if (!match) return false;
  let tail = match[1]?.trim() ?? "";
  const layer = /^layer(?:\(\s*([^()]*)\s*\))?(?:\s+|$)/i.exec(tail);
  if (layer) {
    if (layer[1] !== undefined && !layerName(layer[1].trim())) return false;
    tail = tail.slice(layer[0].length).trim();
  }
  const supports = consumeFunction(tail, "supports");
  if (supports) {
    const condition = /^(?:not\s+|\()/i.test(supports[0])
      ? supports[0]
      : `(${supports[0]})`;
    if (!simpleCondition(condition)) return false;
    tail = supports[1];
  }
  return tail === "" || validImportMedia(tail);
}

function consumeFunction(
  value: string,
  name: string,
): readonly [body: string, rest: string] | undefined {
  const prefix = `${name}(`;
  if (!value.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
  let depth = 1;
  let quote = "";
  let escaped = false;
  for (let index = prefix.length; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        const rest = value.slice(index + 1);
        if (rest !== "" && !/^\s/.test(rest)) return undefined;
        return [
          value.slice(prefix.length, index).trim(),
          rest.trim(),
        ];
      }
    }
  }
  return undefined;
}

function validImportMedia(value: string): boolean {
  return value.split(",").every((entry) => {
    const parts = entry.trim().split(/\s+and\s+/i);
    if (parts.length === 1 && simpleMediaFeature(parts[0]!)) return true;
    const type = parts.shift()?.toLowerCase();
    return !!type && ["all", "print", "screen"].includes(type) &&
      parts.every(simpleMediaFeature);
  });
}

function simpleMediaFeature(value: string): boolean {
  return /^\(\s*[-_A-Za-z][-_A-Za-z0-9]*(?:\s*:\s*[^(){};\s][^(){};]*)?\s*\)$/
    .test(value.trim());
}

function balancedParentheses(value: string): boolean {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === "" && !escaped;
}

function validSourcePosition(line: number, column: number): boolean {
  return Number.isSafeInteger(line) &&
    Number.isSafeInteger(column) &&
    line >= 1 &&
    column >= 1;
}

function samePosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function fallbackSelectorKey(selector: string): string | undefined {
  if (selector.length === 0 || selector.length > INSPECT_LIMITS.selectorLength) {
    return undefined;
  }
  return normalizeSelector(selector);
}

function factMedia(
  fact: CssRuleFact,
): readonly string[] | null {
  const mediaTruncated = fact.metadata.mediaTruncated;
  if (typeof mediaTruncated !== "boolean" || mediaTruncated) return null;
  const value = fact.metadata.media;
  if (
    !Array.isArray(value) ||
    value.length > INSPECT_LIMITS.mediaConditions ||
    !value.every((entry) =>
      typeof entry === "string" &&
      entry.trim().length > 0 &&
      entry.length <= INSPECT_LIMITS.valueLength
    )
  ) {
    return null;
  }
  return value.map(normalizeCondition);
}

function fallbackMediaKey(
  selector: string,
  media: readonly string[],
): string {
  return JSON.stringify([selector, media]);
}

function containingMedia(node: Rule): readonly string[] {
  return containingMediaFrom(node.parent);
}

function containingMediaFrom(
  node: Container | Document | undefined,
): readonly string[] {
  const media: string[] = [];
  let current: Container | Document | undefined = node;
  while (current) {
    if (
      current.type === "atrule" &&
      (current as AtRule).name.toLowerCase() === "media"
    ) {
      media.unshift(normalizeMedia((current as AtRule).params));
    }
    current = current.parent;
  }
  return media;
}

function normalizeMedia(value: string): string {
  return normalizeCondition(value);
}

function smallestRule(
  rules: readonly StylesheetRule[],
): StylesheetRule | undefined {
  return [...rules].sort(
    (left, right) =>
      left.endOffset - left.startOffset - (right.endOffset - right.startOffset),
  )[0];
}

function textDocument(uri: string, text: string): SourceDocument {
  const lineOffsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineOffsets.push(index + 1);
  }
  return {
    uri,
    languageId: "",
    version: 0,
    getText: () => text,
    positionAt: (offset) => positionAt(lineOffsets, text.length, offset),
    offsetAt: (position) => offsetAt(lineOffsets, text, position),
  };
}

function positionAt(
  lineOffsets: readonly number[],
  length: number,
  offset: number,
): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, length));
  let low = 0;
  let high = lineOffsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineOffsets[middle] ?? 0) > clamped) high = middle;
    else low = middle + 1;
  }
  const line = Math.max(0, low - 1);
  return { line, character: clamped - (lineOffsets[line] ?? 0) };
}

function offsetAt(
  lineOffsets: readonly number[],
  text: string,
  position: SourcePosition,
): number {
  const line = Math.max(0, Math.min(position.line, lineOffsets.length - 1));
  const start = lineOffsets[line] ?? 0;
  const next = lineOffsets[line + 1] ?? text.length;
  const lineEnd = line + 1 < lineOffsets.length ? Math.max(start, next - 1) : next;
  return start + Math.max(0, Math.min(position.character, lineEnd - start));
}
