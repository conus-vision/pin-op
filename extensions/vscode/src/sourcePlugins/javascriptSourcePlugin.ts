import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceDocument,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
} from "@pin-op/plugin-api";
import type { InspectTarget } from "@pin-op/protocol";
import { BoundedLruCache } from "./boundedLruCache.js";
import { targetDomIdentity, type DomSubjectIdentity } from "./domFacts.js";
import {
  classTokens,
  parsePhpMarkup,
  type PhpMarkupElement,
} from "./phpMarkup.js";
import type { StatusAwareSourcePluginResult } from "./types.js";

/**
 * A deliberately small script scanner. It reads only what a DOM resolver needs
 * from JavaScript and TypeScript - string and template literals, the call,
 * attribute, or assignment each one feeds, JSX opening tags, and `dataset`
 * members - and skips comments and regular expressions so their text never
 * reads as a literal. It is not a JavaScript parser, never evaluates anything,
 * and stays linear in the length of the document.
 */
export const JAVASCRIPT_SCAN_LIMITS = {
  /** UTF-16 code units read; a longer bundle is scanned only this far. */
  maxLength: 1024 * 1024,
  /** Candidate references kept per document before the scan stops. */
  maxReferences: 10_000,
  /** Longer literals are stepped over rather than read. */
  maxLiteralLength: 64 * 1024,
  /** Longer literals are never read as selectors. */
  maxSelectorLength: 1024,
  maxNesting: 256,
} as const;

const DOCUMENT_CACHE_LIMIT = 8;

/**
 * A script usually names one element in several places: it finds the element
 * once, then flips its classes and attributes in handlers. Those are all real
 * references, so the pane lists them, strongest evidence first. Beyond this
 * many per element the list stops being an answer and becomes noise.
 */
const MAX_SCRIPT_MATCHES = 8;

const MAX_LABEL_LENGTH = 96;
const MAX_LABEL_CLASSES = 3;
const MAX_LABEL_ARGUMENTS = 4;
const MAX_RENDERED_VALUE_LENGTH = 256;
const MAX_TAG_LENGTH = 64;
const MAX_RECENT_TOKENS = 8;
const MAX_CLOSER_SEARCH_DEPTH = 16;

/** Stands in for a `${...}` substitution, whose value the scan cannot know. */
const PLACEHOLDER = "\u0000";

type ScriptEvidence =
  | "script-id"
  | "script-attribute"
  | "script-class"
  | "script-selector"
  | "script-markup";

type AttributeOperator = "=" | "~=" | "|=" | "^=" | "$=" | "*=";

interface AttributeConstraint {
  /** Lowercased attribute name. */
  readonly name: string;
  /** Absent for a presence test such as `[data-open]`. */
  readonly operator: AttributeOperator | undefined;
  readonly value: string | undefined;
  readonly caseInsensitive: boolean;
}

/**
 * One element shape a script literal can mean. Every constraint is literal
 * text; whatever a template substitution wrote is left out, not guessed.
 */
export interface ScriptSubject {
  /** Lowercased tag name, or `undefined` for any element. */
  readonly tag: string | undefined;
  readonly ids: readonly string[];
  readonly classes: readonly string[];
  readonly attributes: readonly AttributeConstraint[];
}

export interface ScriptReference {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly label: string;
  readonly evidence: ScriptEvidence;
  /**
   * Every part has to hold for the element, each through any one of its
   * alternatives. A selector list is one part with a subject per selector;
   * a JSX opening tag has a part per attribute - the branches of a
   * conditional `className` are that attribute's alternatives.
   */
  readonly parts: readonly (readonly ScriptSubject[])[];
}

export interface ParsedScript {
  readonly references: readonly ScriptReference[];
  /** True when a limit stopped the scan before the end of the document. */
  readonly truncated: boolean;
}

/**
 * Resolves the active JavaScript or TypeScript document for the selected
 * element.
 *
 * A script does not render an element the way a template does; it refers to
 * one. The plugin lists the places that do: selector literals such as
 * `querySelector(".card")`, `getElementById("hero")`, class names handed to
 * `classList` or jQuery, JSX opening tags, `className`/`class`/`id`
 * assignments and properties, `dataset` members and `data-*` attribute calls,
 * and markup written into string or template literals. Each reference is
 * compared with the element's final DOM identity - tag, id, classes, and its
 * `data-*`, `aria-*`, and `role` attributes. A literal only proves that the
 * script names something shaped like the element, so every match stays
 * `heuristic`: id evidence ranks first, then attributes, then classes.
 */
export class JavaScriptSourcePlugin implements SourcePlugin {
  public readonly id = "pin-op.javascript";
  public readonly displayName = "Pin-op JavaScript";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "javascript", scheme: "file" },
    { languageId: "javascriptreact", scheme: "file" },
    { languageId: "typescript", scheme: "file" },
    { languageId: "typescriptreact", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["dom-attribute"] as const;

  public constructor(private readonly scripts = new ScriptReferenceCache()) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<StatusAwareSourcePluginResult> {
    if (context.signal.aborted) return abortedResult();

    let parsed: ParsedScript;
    try {
      parsed = this.scripts.parseDocument(context.document);
    } catch (error) {
      return {
        status: "error",
        matches: [],
        diagnostics: [parseDiagnostic(error)],
      };
    }

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const target of context.selection.targets) {
      if (context.signal.aborted) return abortedResult();
      // A target without DOM identity has nothing to look for. `no-facts` is
      // the host's verdict on the whole selection - the registry refuses it
      // from a plugin - so such a target just contributes no matches.
      const identity = targetDomIdentity(target);
      if (!identity) continue;
      const found = findScriptReferences(parsed, identity);
      for (const reference of found.references) {
        matches.push(scriptMatch(target.role, reference, context.document));
      }
      if (found.total > found.references.length) {
        addOnce(diagnostics, limitedDiagnostic(found.references.length));
      }
    }

    if (parsed.truncated && matches.length === 0) {
      addOnce(diagnostics, truncatedDocumentDiagnostic());
    }

    return {
      status: matches.length > 0 ? "matched" : "no-rule-match",
      matches,
      diagnostics,
    };
  }
}

export class ScriptReferenceCache {
  private readonly documents = new BoundedLruCache<
    string,
    { readonly version: number; readonly text: string; readonly parsed: ParsedScript }
  >(DOCUMENT_CACHE_LIMIT);

  public parseDocument(document: SourceDocument): ParsedScript {
    const text = document.getText();
    const cached = this.documents.get(document.uri);
    if (cached?.version === document.version && cached.text === text) {
      return cached.parsed;
    }
    const parsed = parseScriptReferences(text);
    this.documents.set(document.uri, {
      version: document.version,
      text,
      parsed,
    });
    return parsed;
  }
}

export function parseScriptReferences(text: string): ParsedScript {
  return new ScriptScanner(
    text,
    Math.min(text.length, JAVASCRIPT_SCAN_LIMITS.maxLength),
  ).scan();
}

/**
 * Scores every reference against one element and keeps the strongest: id
 * evidence before attribute evidence before class evidence, then the most
 * specific, then document order.
 *
 * A literal describes an element only in part, so containment runs literal
 * into DOM: every id, class, and compared attribute value the literal writes
 * has to hold on the element, which may carry more. A literal value the DOM
 * contradicts disqualifies the reference. An attribute the DOM snapshot does
 * not carry is not evidence either way, and a tag alone is never enough.
 */
export function findScriptReferences(
  parsed: ParsedScript,
  identity: DomSubjectIdentity,
): { readonly references: readonly ScriptReference[]; readonly total: number } {
  const scored: (SubjectScore & { readonly reference: ScriptReference })[] = [];
  for (const reference of parsed.references) {
    const score = scoreReference(reference, identity);
    if (score) scored.push({ ...score, reference });
  }
  scored.sort((left, right) =>
    compareScores(left, right) ||
    left.reference.startOffset - right.reference.startOffset
  );
  return {
    references: scored
      .slice(0, MAX_SCRIPT_MATCHES)
      .map((entry) => entry.reference)
      .sort((left, right) => left.startOffset - right.startOffset),
    total: scored.length,
  };
}

const ID_TIER = 1;
const ATTRIBUTE_TIER = 2;
const CLASS_TIER = 3;

interface SubjectScore {
  readonly tier: number;
  readonly specificity: number;
}

function compareScores(left: SubjectScore, right: SubjectScore): number {
  return left.tier - right.tier || right.specificity - left.specificity;
}

function scoreReference(
  reference: ScriptReference,
  identity: DomSubjectIdentity,
): SubjectScore | undefined {
  let tier = Number.POSITIVE_INFINITY;
  let specificity = 0;
  for (const part of reference.parts) {
    let best: SubjectScore | undefined;
    let viable = false;
    for (const subject of part) {
      const outcome = scoreSubject(subject, identity);
      if (outcome === "contradicted") continue;
      viable = true;
      if (outcome !== "neutral" && (!best || compareScores(outcome, best) < 0)) {
        best = outcome;
      }
    }
    if (!viable) return undefined;
    if (best) {
      tier = Math.min(tier, best.tier);
      specificity += best.specificity;
    }
  }
  return Number.isFinite(tier) ? { tier, specificity } : undefined;
}

function scoreSubject(
  subject: ScriptSubject,
  identity: DomSubjectIdentity,
): SubjectScore | "neutral" | "contradicted" {
  if (
    subject.tag !== undefined &&
    identity.tag !== undefined &&
    subject.tag !== identity.tag.toLowerCase()
  ) {
    return "contradicted";
  }
  let ids = 0;
  let attributes = 0;
  let classes = 0;
  for (const id of subject.ids) {
    if (id !== identity.id) return "contradicted";
    ids += 1;
  }
  for (const className of subject.classes) {
    if (!identity.classes.includes(className)) return "contradicted";
    classes += 1;
  }
  for (const attribute of subject.attributes) {
    const outcome = attributeOutcome(attribute, identity);
    if (outcome !== "satisfied") {
      if (outcome === "contradicted") return outcome;
      continue;
    }
    if (attribute.name === "id") ids += 1;
    else if (attribute.name === "class") classes += 1;
    else attributes += 1;
  }
  const specificity = ids + attributes + classes;
  if (ids > 0) return { tier: ID_TIER, specificity };
  if (attributes > 0) return { tier: ATTRIBUTE_TIER, specificity };
  return classes > 0 ? { tier: CLASS_TIER, specificity } : "neutral";
}

function attributeOutcome(
  constraint: AttributeConstraint,
  identity: DomSubjectIdentity,
): "satisfied" | "neutral" | "contradicted" {
  let actual: string | undefined;
  if (constraint.name === "id") {
    actual = identity.id;
  } else if (constraint.name === "class") {
    actual = identity.classes.length > 0
      ? identity.classes.join(" ")
      : undefined;
  } else if (isObservableAttribute(constraint.name)) {
    // The snapshot is bounded and a script may add the attribute later, so a
    // missing attribute is not a contradiction.
    actual = identity.attributes.get(constraint.name);
    if (actual === undefined) return "neutral";
  } else {
    // The browser never sends other attributes, so they cannot be compared.
    return "neutral";
  }
  if (actual === undefined) return "contradicted";
  if (constraint.operator === undefined || constraint.value === undefined) {
    return "satisfied";
  }
  return attributeValueMatches(actual, constraint) ? "satisfied" : "contradicted";
}

function attributeValueMatches(
  actual: string,
  constraint: AttributeConstraint,
): boolean {
  const fold = (value: string) =>
    constraint.caseInsensitive ? value.toLowerCase() : value;
  const subject = fold(actual);
  const value = fold(constraint.value ?? "");
  switch (constraint.operator) {
    case "=":
      return subject === value;
    case "~=":
      return isStaticToken(value) && subject.split(/\s+/u).includes(value);
    case "|=":
      return subject === value || subject.startsWith(`${value}-`);
    case "^=":
      return value.length > 0 && subject.startsWith(value);
    case "$=":
      return value.length > 0 && subject.endsWith(value);
    case "*=":
      return value.length > 0 && subject.includes(value);
    default:
      return false;
  }
}

function scriptMatch(
  targetRole: InspectTarget["role"],
  reference: ScriptReference,
  document: SourceDocument,
): SourceMatch {
  return {
    targetRole,
    range: {
      start: document.positionAt(reference.startOffset),
      end: document.positionAt(reference.endOffset),
    },
    label: reference.label,
    // The closed presentation vocabulary has no script category; `source`
    // and `matches` are its neutral values, and the host would rewrite any
    // other category to them anyway.
    kind: "source",
    relation: "matches",
    confidence: "heuristic",
    metadata: { evidence: reference.evidence },
  };
}

// Scanner ------------------------------------------------------------------

interface Token {
  readonly kind: "start" | "name" | "number" | "string" | "template" | "regex" | "punct";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const START_TOKEN: Token = { kind: "start", value: "", start: 0, end: 0 };

type CalleeRole =
  | "id"
  | "classes"
  | "class-list"
  | "attribute"
  | "test-id"
  | "data"
  | "other";

interface CallSite {
  readonly name: string;
  readonly role: CalleeRole;
  /** Where the reference range starts: the callee, or its `classList`. */
  readonly start: number;
  readonly label: string;
  /** Rendered literal arguments, for the label. */
  readonly literals: string[];
  pending:
    | {
        readonly evidence: ScriptEvidence;
        readonly subjects: ScriptSubject[];
        end: number;
      }
    | undefined;
}

/**
 * A value literals are assigned to: `className="card"`, `el.id = "x"`,
 * `{ class: "a" }`, `data-block={"hero"}`. Every literal that reaches it
 * before the expression ends adds an alternative - the branches of a
 * conditional name different classes for the same element.
 */
interface ValueContext {
  readonly kind: "classes" | "id" | "attribute";
  /** Lowercased attribute name for an `attribute` context. */
  readonly attribute: string;
  readonly name: string;
  readonly operator: string;
  readonly start: number;
  /** The JSX opening tag this attribute belongs to. */
  readonly element: JsxElement | undefined;
  end: number;
  readonly subjects: ScriptSubject[];
  readonly values: { readonly start: number; readonly text: string }[];
  closed: boolean;
}

interface JsxElement {
  /** Offset of the opening `<`. */
  readonly start: number;
  readonly attributes: ValueContext[];
  closed: boolean;
}

interface Segment {
  readonly cooked: number;
  readonly raw: number;
}

/** A literal while it is read: escape-decoded text plus its offset map. */
interface LiteralText {
  readonly contentStart: number;
  value: string;
  /** Cooked-to-raw offset map; absent while the text maps one to one. */
  segments: Segment[] | undefined;
  oversized: boolean;
}

interface ScannedLiteral extends Readonly<LiteralText> {
  /** Offset of the opening quote. */
  readonly start: number;
  /** Offset just past the closing quote. */
  readonly end: number;
}

interface TemplateState extends LiteralText {
  readonly start: number;
  readonly destination: Destination;
  substitutionStart: number;
}

interface Frame {
  readonly opener: "root" | "(" | "[" | "{" | "${";
  readonly call: CallSite | undefined;
  /** A value context every literal nested in this bracket feeds. */
  readonly container: ValueContext | undefined;
  /** Start of `dataset` for a `dataset[...]` access. */
  readonly datasetStart: number | undefined;
  readonly template: TemplateState | undefined;
  expression: ValueContext | undefined;
  element: JsxElement | undefined;
  argument: number;
  firstArgument: string | undefined;
}

type Destination =
  | { readonly kind: "value"; readonly context: ValueContext }
  | { readonly kind: "call"; readonly frame: Frame; readonly argument: number }
  | { readonly kind: "dataset"; readonly start: number }
  | { readonly kind: "plain" };

const CLASS_LIST_METHODS = words("add remove toggle contains replace");
const CLASS_CALLEES = words(
  "getElementsByClassName addClass removeClass toggleClass hasClass",
);
const ATTRIBUTE_CALLEES = words(
  "getAttribute setAttribute hasAttribute removeAttribute toggleAttribute getAttributeNode attr removeAttr",
);

/** Keywords after which an operand, and so a regular expression, can start. */
const OPERAND_KEYWORDS = words(
  "await case delete do else extends in instanceof new of return throw typeof void yield",
);
const NON_CALLEE_KEYWORDS = words(
  `${[...OPERAND_KEYWORDS].join(" ")} catch class const for function if let switch var while with`,
);

/** Attributes whose value is the id of the element they point at. */
const ID_REFERENCE_NAMES = words("htmlFor for");

/** Operators that bind the literals after them to the name before them. */
const CONTEXT_OPERATORS = words("= : += == === != !==");

/** Operators that end the expression a value context reads. */
const EXPRESSION_BOUNDARIES = words(
  "; > => = += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=",
);

/** Multi-character punctuators, longest first, keyed by their first code unit. */
const PUNCTUATORS = groupPunctuators(
  ">>>= ... === !== **= <<= >>= >>> &&= ||= ??= => == != <= >= && || ?? ?. ++ -- += -= *= /= %= &= |= ^= ** << >>",
);

const TAB = 0x09;
const LINE_FEED = 0x0a;
const VERTICAL_TAB = 0x0b;
const FORM_FEED = 0x0c;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const QUOTE_DOUBLE = 0x22;
const HASH = 0x23;
const DOLLAR = 0x24;
const QUOTE_SINGLE = 0x27;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const STAR = 0x2a;
const PLUS = 0x2b;
const COMMA = 0x2c;
const HYPHEN = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;
const LESS_THAN = 0x3c;
const EQUALS = 0x3d;
const GREATER_THAN = 0x3e;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const CARET = 0x5e;
const UNDERSCORE = 0x5f;
const BACKTICK = 0x60;
const OPEN_BRACE = 0x7b;
const PIPE = 0x7c;
const CLOSE_BRACE = 0x7d;
const TILDE = 0x7e;

class ScriptScanner {
  private readonly references: ScriptReference[] = [];
  private readonly frames: Frame[] = [createFrame("root", undefined)];
  private readonly recent: Token[] = [];
  private index = 0;
  private truncated = false;
  private stopped = false;

  public constructor(
    private readonly text: string,
    private readonly limit: number,
  ) {}

  public scan(): ParsedScript {
    if (this.text.startsWith("#!")) this.skipLine();
    while (this.index < this.limit && !this.stopped) this.step();
    while (this.frames.length > 1) this.popFrame(undefined);
    this.closeExpression();
    this.abandonElement(this.top());
    return {
      references: this.references,
      truncated: this.truncated || this.limit < this.text.length,
    };
  }

  private step(): void {
    const code = this.text.charCodeAt(this.index);
    if (isScriptWhitespace(code)) {
      this.index += 1;
      return;
    }
    switch (code) {
      case SLASH:
        this.slash();
        return;
      case QUOTE_DOUBLE:
      case QUOTE_SINGLE:
        this.string(code);
        return;
      case BACKTICK:
        this.template();
        return;
      case OPEN_PAREN:
        this.openFrame("(", this.callSite(), undefined);
        return;
      case OPEN_BRACKET:
        this.openFrame(
          "[",
          undefined,
          isName(this.token(1), "dataset") ? this.token(1).start : undefined,
        );
        return;
      case OPEN_BRACE:
        // `className="a" {...props}`: a block or a spread after a complete
        // operand starts something new.
        if (isComplete(this.token(1))) this.closeExpression();
        this.openFrame("{", undefined, undefined);
        return;
      case CLOSE_PAREN:
      case CLOSE_BRACKET:
      case CLOSE_BRACE:
        this.close(code);
        return;
    }
    if (
      isDigit(code) ||
      (code === DOT && isDigit(this.text.charCodeAt(this.index + 1)))
    ) {
      this.number();
      return;
    }
    if (isNameStart(code)) {
      this.name();
      return;
    }
    this.punctuator(code);
  }

  // Tokens -----------------------------------------------------------------

  private name(): void {
    const start = this.index;
    let end = start + 1;
    while (end < this.limit && isNameCharacter(this.text.charCodeAt(end))) {
      end += 1;
    }
    this.index = end;
    const value = this.text.slice(start, end);
    const hyphen = this.token(1);
    const head = this.token(2);
    if (
      isPunct(hyphen, "-") &&
      hyphen.end === start &&
      head.kind === "name" &&
      head.end === hyphen.start
    ) {
      // JSX spells attributes such as `data-block` and `aria-controls` with a
      // hyphen; read them back as one name.
      this.recent.splice(-2, 2, {
        kind: "name",
        value: `${head.value}-${value}`,
        start: head.start,
        end,
      });
      return;
    }
    this.beforeOperand();
    if (value === "function" || value === "class") this.closeExpression();
    if (isPunct(this.token(1), ".") && isName(this.token(2), "dataset")) {
      this.emit({
        startOffset: this.token(2).start,
        endOffset: end,
        label: boundedLabel(`dataset.${value}`),
        evidence: "script-attribute",
        parts: [[attributeSubject(datasetAttributeName(value), undefined)]],
      });
    }
    this.push({ kind: "name", value, start, end });
  }

  private number(): void {
    const start = this.index;
    let end = start + 1;
    while (end < this.limit) {
      const code = this.text.charCodeAt(end);
      if (!isNameCharacter(code) && code !== DOT) break;
      end += 1;
    }
    this.index = end;
    this.beforeOperand();
    this.push({ kind: "number", value: "", start, end });
  }

  private punctuator(code: number): void {
    const start = this.index;
    let value = PUNCTUATORS.get(code)?.find((candidate) =>
      this.text.startsWith(candidate, start)
    ) ?? String.fromCharCode(code);
    if (value === "?.") {
      const after = this.text.charCodeAt(start + 2);
      if (isDigit(after)) {
        value = "?";
      } else {
        this.index = start + 2;
        // `a?.(x)` and `a?.[x]` keep `a` as the callee or the object.
        if (after === OPEN_PAREN || after === OPEN_BRACKET) return;
        this.push({ kind: "punct", value: ".", start, end: this.index });
        return;
      }
    }
    this.index = start + value.length;
    this.operator(value, start);
  }

  private operator(value: string, start: number): void {
    const frame = this.top();
    const target = CONTEXT_OPERATORS.has(value) && this.bindsValue(value, frame)
      ? this.contextTarget(value === ":")
      : undefined;
    if (target) {
      const { dataset, ...context } = target;
      this.closeExpression();
      if (dataset) this.dropDatasetMember(context.start);
      frame.expression = {
        ...context,
        operator: value,
        // `htmlFor` names another element's id, never the tag's own.
        element: value === "=" && !ID_REFERENCE_NAMES.has(context.name)
          ? frame.element
          : undefined,
        end: this.index,
        subjects: [],
        values: [],
        closed: false,
      };
    } else if (value === ",") {
      this.closeExpression();
      frame.argument += 1;
    } else if (EXPRESSION_BOUNDARIES.has(value)) {
      this.closeExpression();
      if (value === ">") this.finishElement(frame, this.index);
      else if (value === ";") this.abandonElement(frame);
    } else if (value === "<" && this.opensElement()) {
      this.abandonElement(frame);
      frame.element = { start, attributes: [], closed: false };
    }
    this.push({ kind: "punct", value, start, end: this.index });
  }

  /**
   * `:` binds a value only to an object literal key; elsewhere it is the
   * second branch of a conditional, a `case`, or a type annotation.
   */
  private bindsValue(value: string, frame: Frame): boolean {
    if (value !== ":") return true;
    const before = this.token(2);
    return frame.opener === "{" && (isPunct(before, "{") || isPunct(before, ","));
  }

  /**
   * `<` opens a JSX element when a name follows it directly and it stands
   * where an operand belongs - never after a complete operand, as in `a <b`
   * or the type arguments of `Array<string>`.
   */
  private opensElement(): boolean {
    const next = this.text.charCodeAt(this.index);
    if (!isAsciiLetter(next) && next !== UNDERSCORE && next !== DOLLAR) {
      return false;
    }
    const before = this.token(1);
    return !isComplete(before) || isPunct(before, "}");
  }

  private slash(): void {
    const next = this.text.charCodeAt(this.index + 1);
    if (next === SLASH) {
      this.skipLine();
      return;
    }
    if (next === STAR) {
      const end = this.text.indexOf("*/", this.index + 2);
      this.index = end < 0 || end + 2 > this.limit ? this.limit : end + 2;
      return;
    }
    // `</div>` closes a JSX element; it never starts a regular expression.
    if (this.text.charCodeAt(this.index - 1) === LESS_THAN) {
      this.index += 1;
      this.operator("/", this.index - 1);
      return;
    }
    if (regexAllowed(this.token(1)) && this.regex()) return;
    this.punctuator(SLASH);
  }

  /** Returns false for a `/` that turns out not to open a regular expression. */
  private regex(): boolean {
    let index = this.index + 1;
    let inClass = false;
    while (index < this.limit) {
      const code = this.text.charCodeAt(index);
      if (isLineTerminator(code)) return false;
      if (code === BACKSLASH) {
        if (isLineTerminator(this.text.charCodeAt(index + 1))) return false;
        index += 2;
        continue;
      }
      if (code === OPEN_BRACKET) inClass = true;
      else if (code === CLOSE_BRACKET) inClass = false;
      else if (code === SLASH && !inClass) break;
      index += 1;
    }
    if (index >= this.limit) return false;
    index += 1;
    while (index < this.limit && isNameCharacter(this.text.charCodeAt(index))) {
      index += 1;
    }
    const start = this.index;
    this.index = index;
    this.push({ kind: "regex", value: "", start, end: index });
    return true;
  }

  private skipLine(): void {
    while (
      this.index < this.limit &&
      !isLineTerminator(this.text.charCodeAt(this.index))
    ) {
      this.index += 1;
    }
  }

  // Literals ---------------------------------------------------------------

  private string(quote: number): void {
    const literal = this.readQuoted(quote);
    if (!literal) return;
    this.beforeOperand();
    const frame = this.top();
    const destination = this.destinationFor(frame);
    if (frame.call && frame.argument === 0 && frame.firstArgument === undefined) {
      frame.firstArgument = literal.oversized ? "" : literal.value;
    }
    this.accept(literal, destination);
    this.push({
      kind: "string",
      value: literal.value.length <= 64 ? literal.value : "",
      start: literal.start,
      end: literal.end,
    });
  }

  /**
   * Returns `undefined` for a quote the line ends inside - an apostrophe in
   * JSX text, say - and the scan resumes on the next line.
   */
  private readQuoted(quote: number): ScannedLiteral | undefined {
    const start = this.index;
    const literal: LiteralText = {
      contentStart: start + 1,
      value: "",
      segments: undefined,
      oversized: false,
    };
    let index = literal.contentStart;
    let runStart = index;
    while (index < this.limit) {
      const code = this.text.charCodeAt(index);
      if (code === quote) {
        appendText(literal, this.text.slice(runStart, index));
        this.index = index + 1;
        return { ...literal, start, end: index + 1 };
      }
      if (code === LINE_FEED || code === CARRIAGE_RETURN) break;
      if (code === BACKSLASH) {
        appendText(literal, this.text.slice(runStart, index));
        index += appendEscape(literal, this.text, index, this.limit);
        runStart = index;
        continue;
      }
      index += 1;
    }
    this.index = Math.min(index, this.limit);
    return undefined;
  }

  private template(): void {
    const start = this.index;
    this.beforeOperand();
    const state: TemplateState = {
      start,
      contentStart: start + 1,
      destination: this.destinationFor(this.top()),
      value: "",
      segments: undefined,
      oversized: false,
      substitutionStart: start,
    };
    this.index = start + 1;
    this.continueTemplate(state);
  }

  /** Reads template text up to the closing backtick or the next `${`. */
  private continueTemplate(state: TemplateState): void {
    let index = this.index;
    let runStart = index;
    while (index < this.limit) {
      const code = this.text.charCodeAt(index);
      if (code === BACKTICK) {
        appendText(state, this.text.slice(runStart, index));
        this.index = index + 1;
        this.finishTemplate(state);
        return;
      }
      if (code === DOLLAR && this.text.charCodeAt(index + 1) === OPEN_BRACE) {
        appendText(state, this.text.slice(runStart, index));
        state.substitutionStart = index;
        this.index = index;
        this.openFrame("${", undefined, undefined, state);
        return;
      }
      if (code === BACKSLASH) {
        appendText(state, this.text.slice(runStart, index));
        index += appendEscape(state, this.text, index, this.limit);
        runStart = index;
        continue;
      }
      index += 1;
    }
    this.index = this.limit;
  }

  private closeSubstitution(state: TemplateState): void {
    state.segments ??= [{ cooked: 0, raw: state.contentStart }];
    state.segments.push({ cooked: state.value.length, raw: state.substitutionStart });
    appendText(state, PLACEHOLDER);
    state.segments.push({ cooked: state.value.length, raw: this.index });
    this.continueTemplate(state);
  }

  private finishTemplate(state: TemplateState): void {
    this.accept(
      {
        start: state.start,
        end: this.index,
        contentStart: state.contentStart,
        value: state.value,
        segments: state.segments,
        oversized: state.oversized,
      },
      state.destination,
    );
    this.push({ kind: "template", value: "", start: state.start, end: this.index });
  }

  // Brackets ---------------------------------------------------------------

  private openFrame(
    opener: Frame["opener"],
    call: CallSite | undefined,
    datasetStart: number | undefined,
    template?: TemplateState,
  ): void {
    const start = this.index;
    this.index += opener.length;
    if (this.frames.length >= JAVASCRIPT_SCAN_LIMITS.maxNesting) {
      this.stop();
      return;
    }
    const parent = this.top();
    this.frames.push({
      ...createFrame(
        opener,
        liveContext(parent.expression) ?? liveContext(parent.container),
      ),
      call,
      datasetStart,
      template,
    });
    this.push({ kind: "punct", value: opener, start, end: this.index });
  }

  private close(code: number): void {
    const start = this.index;
    this.index += 1;
    const closer = String.fromCharCode(code);
    const depth = this.matchingFrame(closer);
    if (depth === undefined) {
      this.push({ kind: "punct", value: closer, start, end: this.index });
      return;
    }
    while (this.frames.length - 1 > depth) this.popFrame(undefined);
    const frame = this.popFrame(this.index);
    if (frame.template) {
      this.closeSubstitution(frame.template);
      return;
    }
    this.push({ kind: "punct", value: closer, start, end: this.index });
  }

  private matchingFrame(closer: string): number | undefined {
    const lowest = Math.max(1, this.frames.length - MAX_CLOSER_SEARCH_DEPTH);
    for (let depth = this.frames.length - 1; depth >= lowest; depth -= 1) {
      const opener = this.frames[depth]!.opener;
      if (
        (closer === ")" && opener === "(") ||
        (closer === "]" && opener === "[") ||
        (closer === "}" && (opener === "{" || opener === "${"))
      ) {
        return depth;
      }
      // A stray closer never unwinds a template substitution.
      if (opener === "${") return undefined;
    }
    return undefined;
  }

  private popFrame(closeEnd: number | undefined): Frame {
    const frame = this.frames.pop()!;
    if (frame.expression) this.flushContext(frame.expression);
    this.abandonElement(frame);
    if (frame.call?.pending) this.flushCall(frame.call);
    const container = liveContext(frame.container);
    if (container && closeEnd !== undefined) {
      container.end = Math.max(container.end, closeEnd);
    }
    return frame;
  }

  private top(): Frame {
    return this.frames[this.frames.length - 1]!;
  }

  private callSite(): CallSite | undefined {
    let position = 1;
    // `querySelector<HTMLElement>(".card")`: step back over type arguments.
    if (isPunct(this.token(1), ">") || isPunct(this.token(1), ">>")) {
      let depth = 0;
      for (; position <= this.recent.length; position += 1) {
        const token = this.token(position);
        if (token.kind !== "punct" && token.kind !== "name") return undefined;
        if (token.value === ">") depth += 1;
        else if (token.value === ">>") depth += 2;
        else if (token.value === "<") depth -= 1;
        if (depth === 0) break;
      }
      position += 1;
    }
    const callee = this.token(position);
    if (callee.kind !== "name" || NON_CALLEE_KEYWORDS.has(callee.value)) {
      return undefined;
    }
    const receiver = isPunct(this.token(position + 1), ".")
      ? this.token(position + 2)
      : undefined;
    const classList = isName(receiver, "classList") &&
      CLASS_LIST_METHODS.has(callee.value);
    return {
      name: callee.value,
      role: classList ? "class-list" : calleeRole(callee.value),
      start: classList ? receiver!.start : callee.start,
      label: classList ? `classList.${callee.value}` : callee.value,
      literals: [],
      pending: undefined,
    };
  }

  // Contexts ---------------------------------------------------------------

  private contextTarget(
    allowStringKey: boolean,
  ):
    | (Pick<ValueContext, "kind" | "attribute" | "name" | "start"> & {
        readonly dataset: boolean;
      })
    | undefined {
    const token = this.token(1);
    if (
      token.kind !== "name" &&
      (token.kind !== "string" || !allowStringKey)
    ) {
      return undefined;
    }
    const name = token.value;
    if (
      token.kind === "name" &&
      isPunct(this.token(2), ".") &&
      isName(this.token(3), "dataset")
    ) {
      return {
        kind: "attribute",
        attribute: datasetAttributeName(name),
        name: `dataset.${name}`,
        start: this.token(3).start,
        dataset: true,
      };
    }
    const kind = contextKind(name);
    if (!kind) return undefined;
    return {
      kind,
      attribute: kind === "attribute" ? name.toLowerCase() : "",
      name,
      start: token.start,
      dataset: false,
    };
  }

  /**
   * `el.dataset.state = "open"` is one reference: the bare member access the
   * name recorded gives way to the assignment that carries a value.
   */
  private dropDatasetMember(start: number): void {
    const last = this.references[this.references.length - 1];
    if (last?.startOffset === start && last.endOffset === this.token(1).end) {
      this.references.pop();
    }
  }

  /**
   * A new operand right after a complete one - the next JSX attribute, or the
   * next statement - means the expression a value context read has ended.
   */
  private beforeOperand(): void {
    if (isComplete(this.token(1))) this.closeExpression();
  }

  private closeExpression(): void {
    const frame = this.top();
    if (!frame.expression) return;
    this.flushContext(frame.expression);
    frame.expression = undefined;
  }

  private destinationFor(frame: Frame): Destination {
    if (frame.call && frame.call.role !== "other") {
      return { kind: "call", frame, argument: frame.argument };
    }
    const context = liveContext(frame.expression) ?? liveContext(frame.container);
    if (context) return { kind: "value", context };
    if (frame.datasetStart !== undefined) {
      return { kind: "dataset", start: frame.datasetStart };
    }
    if (frame.call) return { kind: "call", frame, argument: frame.argument };
    return { kind: "plain" };
  }

  private accept(literal: ScannedLiteral, destination: Destination): void {
    if (literal.oversized) return;
    switch (destination.kind) {
      case "value":
        this.addToContext(destination.context, literal);
        return;
      case "dataset":
        this.datasetKey(destination.start, literal);
        return;
      case "call": {
        const call = destination.frame.call!;
        if (call.literals.length < MAX_LABEL_ARGUMENTS) {
          call.literals.push(quoted(renderValue(literal.value)));
        }
        const recognized = roleSubjects(
          call,
          destination.argument,
          destination.frame.firstArgument,
          literal.value,
        );
        if (recognized) {
          this.contribute(call, recognized.evidence, [recognized.subject], literal);
        } else {
          this.acceptGeneric(literal, call);
        }
        return;
      }
      case "plain":
        this.acceptGeneric(literal, undefined);
    }
  }

  /** A literal no call or attribute explains may still be a selector or markup. */
  private acceptGeneric(literal: ScannedLiteral, call: CallSite | undefined): void {
    const subjects = selectorSubjects(literal.value);
    if (subjects) {
      if (subjects.length === 0) return;
      if (call) {
        this.contribute(call, "script-selector", subjects, literal);
      } else {
        this.emit({
          startOffset: literal.start,
          endOffset: literal.end,
          label: boundedLabel(quoted(renderValue(literal.value))),
          evidence: "script-selector",
          parts: [subjects],
        });
      }
      return;
    }
    this.acceptMarkup(literal);
  }

  /**
   * Markup a script writes as text - `innerHTML` templates, jQuery's
   * `$('<div class="card">')`, lit-html - is read with the markup scanner the
   * PHP provider uses; a script literal simply carries no `<?php` blocks.
   */
  private acceptMarkup(literal: ScannedLiteral): void {
    const value = literal.value;
    if (!value.includes("=") || !/<[A-Za-z]/u.test(value)) return;
    let elements: readonly PhpMarkupElement[];
    try {
      elements = parsePhpMarkup(value).elements;
    } catch {
      return;
    }
    for (const element of elements) {
      const subject = markupSubject(element);
      if (!hasConstraint(subject)) continue;
      this.emit({
        startOffset: rawOffset(literal, element.startOffset),
        endOffset: rawOffset(literal, element.openEndOffset),
        label: markupLabel(subject.tag, [subject]),
        evidence: "script-markup",
        parts: [[subject]],
      });
    }
  }

  private addToContext(context: ValueContext, literal: ScannedLiteral): void {
    context.end = Math.max(context.end, literal.end);
    const subject = contextSubject(context, literal.value);
    if (subject) {
      context.subjects.push(subject);
      context.values.push({ start: literal.start, text: renderValue(literal.value) });
    }
    // `data-bs-target="#menu"` also names the element it points at.
    if (context.kind === "attribute") this.acceptGeneric(literal, undefined);
  }

  private datasetKey(start: number, literal: ScannedLiteral): void {
    if (!isStaticToken(literal.value)) return;
    this.emit({
      startOffset: start,
      endOffset: this.throughCloser(literal.end, CLOSE_BRACKET),
      label: boundedLabel(`dataset[${quoted(renderValue(literal.value))}]`),
      evidence: "script-attribute",
      parts: [[attributeSubject(datasetAttributeName(literal.value), undefined)]],
    });
  }

  private contribute(
    call: CallSite,
    evidence: ScriptEvidence,
    subjects: readonly ScriptSubject[],
    literal: ScannedLiteral,
  ): void {
    const end = this.throughCloser(literal.end, CLOSE_PAREN);
    const pending = call.pending ??= { evidence, subjects: [], end };
    pending.subjects.push(...subjects);
    pending.end = Math.max(pending.end, end);
  }

  private flushCall(call: CallSite): void {
    const pending = call.pending!;
    call.pending = undefined;
    this.emit({
      startOffset: call.start,
      endOffset: pending.end,
      label: boundedLabel(`${call.label}(${call.literals.join(", ")})`),
      evidence: pending.evidence,
      parts: [pending.subjects],
    });
  }

  /** Hands a finished attribute to its JSX element, or emits it on its own. */
  private flushContext(context: ValueContext): void {
    if (context.closed) return;
    context.closed = true;
    if (context.subjects.length === 0) return;
    if (context.element && !context.element.closed) {
      context.element.attributes.push(context);
      return;
    }
    this.emitContext(context);
  }

  private emitContext(context: ValueContext): void {
    const tokens = [...new Set(
      [...context.values]
        .sort((left, right) => left.start - right.start)
        .flatMap((value) => value.text.split(" "))
        .filter(Boolean),
    )];
    const operator = context.operator === "=" || context.operator === ":"
      ? "="
      : ` ${context.operator} `;
    this.emit({
      startOffset: context.start,
      endOffset: context.end,
      label: boundedLabel(`${context.name}${operator}${quoted(tokens.join(" "))}`),
      evidence: context.kind === "id"
        ? "script-id"
        : context.kind === "classes"
          ? "script-class"
          : "script-attribute",
      parts: [context.subjects],
    });
  }

  /**
   * A JSX opening tag is one reference, like a template element: its tag and
   * every literal attribute have to agree with the DOM together.
   */
  private finishElement(frame: Frame, end: number): void {
    const element = frame.element;
    if (!element) return;
    frame.element = undefined;
    element.closed = true;
    if (element.attributes.length === 0) return;
    const tag = jsxTagName(this.text, element.start + 1);
    // `<Card>` is a component whose rendered tag the scan cannot know.
    const intrinsic = /^[a-z]/u.test(tag) && !tag.includes(".")
      ? tag.toLowerCase()
      : undefined;
    const parts = element.attributes.map((attribute) => attribute.subjects);
    this.emit({
      startOffset: element.start,
      endOffset: end,
      label: markupLabel(tag, parts.flat()),
      evidence: "script-markup",
      parts: intrinsic ? [[subjectOf({ tag: intrinsic })], ...parts] : parts,
    });
  }

  /** A tag the scan lost track of still reports its attributes one by one. */
  private abandonElement(frame: Frame): void {
    const element = frame.element;
    if (!element) return;
    frame.element = undefined;
    element.closed = true;
    for (const attribute of element.attributes) this.emitContext(attribute);
  }

  /**
   * Extends a range over a closing `)` or `]` that directly follows, so
   * `querySelector(".card")` reads whole. A call with further arguments - an
   * inline handler, say - ends at the literal instead of swallowing them.
   */
  private throughCloser(offset: number, closer: number): number {
    let index = offset;
    while (index < this.limit && isScriptWhitespace(this.text.charCodeAt(index))) {
      index += 1;
    }
    return index < this.limit && this.text.charCodeAt(index) === closer
      ? index + 1
      : offset;
  }

  private emit(reference: ScriptReference): void {
    if (reference.endOffset <= reference.startOffset) return;
    if (this.references.length >= JAVASCRIPT_SCAN_LIMITS.maxReferences) {
      this.stop();
      return;
    }
    this.references.push(reference);
  }

  private stop(): void {
    this.truncated = true;
    this.stopped = true;
    this.index = this.limit;
  }

  /** The token `position` steps back; 1 is the most recent. */
  private token(position: number): Token {
    return this.recent[this.recent.length - position] ?? START_TOKEN;
  }

  private push(token: Token): void {
    if (this.recent.length >= MAX_RECENT_TOKENS) this.recent.shift();
    this.recent.push(token);
  }
}

function createFrame(
  opener: Frame["opener"],
  container: ValueContext | undefined,
): Frame {
  return {
    opener,
    call: undefined,
    container,
    datasetStart: undefined,
    template: undefined,
    expression: undefined,
    element: undefined,
    argument: 0,
    firstArgument: undefined,
  };
}

function liveContext(context: ValueContext | undefined): ValueContext | undefined {
  return context && !context.closed ? context : undefined;
}

function calleeRole(name: string): CalleeRole {
  if (name === "getElementById") return "id";
  if (CLASS_CALLEES.has(name)) return "classes";
  if (ATTRIBUTE_CALLEES.has(name)) return "attribute";
  if (name.endsWith("ByTestId")) return "test-id";
  // jQuery's `.data("slides-col")` reads `data-slides-col`.
  if (name === "data") return "data";
  return "other";
}

function contextKind(name: string): ValueContext["kind"] | undefined {
  if (name === "className" || name === "class") return "classes";
  if (name === "id" || ID_REFERENCE_NAMES.has(name)) return "id";
  return isObservableAttribute(name.toLowerCase()) ? "attribute" : undefined;
}

function roleSubjects(
  call: CallSite,
  argument: number,
  firstArgument: string | undefined,
  value: string,
): { readonly evidence: ScriptEvidence; readonly subject: ScriptSubject } | undefined {
  const found = (evidence: ScriptEvidence, subject: ScriptSubject | undefined) =>
    subject ? { evidence, subject } : undefined;
  switch (call.role) {
    case "id":
      return argument === 0 ? found("script-id", idSubject(value)) : undefined;
    case "classes":
      return argument === 0
        ? found("script-class", classSubject(value))
        : undefined;
    case "class-list":
      if (call.name === "toggle" && argument > 0) return undefined;
      if (call.name === "replace" && argument > 1) return undefined;
      return found("script-class", classSubject(value));
    case "attribute": {
      if (argument === 0) {
        const name = attributeName(value);
        return name !== undefined && isObservableAttribute(name)
          ? found("script-attribute", attributeSubject(name, undefined))
          : undefined;
      }
      if (
        argument !== 1 ||
        (call.name !== "setAttribute" && call.name !== "attr")
      ) {
        return undefined;
      }
      const name = attributeName(firstArgument ?? "");
      if (name === "id") return found("script-id", idSubject(value));
      if (name === "class") return found("script-class", classSubject(value));
      return name !== undefined && isObservableAttribute(name)
        ? found("script-attribute", attributeSubject(name, value))
        : undefined;
    }
    case "test-id":
      return argument === 0 && isStaticToken(value)
        ? found("script-attribute", attributeSubject("data-testid", value))
        : undefined;
    case "data":
      return argument === 0 && isStaticToken(value)
        ? found(
            "script-attribute",
            attributeSubject(datasetAttributeName(value), undefined),
          )
        : undefined;
    case "other":
      return undefined;
  }
}

function contextSubject(
  context: ValueContext,
  value: string,
): ScriptSubject | undefined {
  switch (context.kind) {
    case "classes":
      return classSubject(value);
    case "id":
      return idSubject(value);
    case "attribute":
      return attributeSubject(context.attribute, value);
  }
}

function classSubject(value: string): ScriptSubject | undefined {
  const classes = [...new Set(
    classTokens(value).filter((token) => !token.includes(PLACEHOLDER)),
  )];
  return classes.length > 0 ? subjectOf({ classes }) : undefined;
}

function idSubject(value: string): ScriptSubject | undefined {
  const id = value.trim();
  return isStaticToken(id) ? subjectOf({ ids: [id] }) : undefined;
}

/**
 * A literal value is compared with the DOM; a value a substitution wrote only
 * says that the attribute is there.
 */
function attributeSubject(name: string, value: string | undefined): ScriptSubject {
  return subjectOf({
    attributes: [
      value === undefined || value.includes(PLACEHOLDER)
        ? { name, operator: undefined, value: undefined, caseInsensitive: false }
        : { name, operator: "=", value, caseInsensitive: false },
    ],
  });
}

function markupSubject(element: PhpMarkupElement): ScriptSubject {
  const ids: string[] = [];
  const classes: string[] = [];
  const attributes: AttributeConstraint[] = [];
  for (const attribute of element.attributes) {
    if (attribute.name === "id") {
      ids.push(...(idSubject(attribute.literalValue)?.ids ?? []));
    } else if (attribute.name === "class" || attribute.name === "classname") {
      classes.push(...(classSubject(attribute.literalValue)?.classes ?? []));
    } else if (isObservableAttribute(attribute.name)) {
      attributes.push(
        ...attributeSubject(attribute.name, attribute.literalValue).attributes,
      );
    }
  }
  return { tag: element.tag, ids, classes, attributes };
}

function subjectOf(parts: Partial<ScriptSubject>): ScriptSubject {
  return {
    tag: parts.tag,
    ids: parts.ids ?? [],
    classes: parts.classes ?? [],
    attributes: parts.attributes ?? [],
  };
}

function hasConstraint(subject: ScriptSubject): boolean {
  return subject.ids.length > 0 ||
    subject.classes.length > 0 ||
    subject.attributes.length > 0;
}

function attributeName(value: string): string | undefined {
  const name = value.trim().toLowerCase();
  return isStaticToken(name) ? name : undefined;
}

function isStaticToken(value: string): boolean {
  return value.length > 0 && !/[\s\u0000]/u.test(value);
}

/** The attributes the browser snapshot carries besides `id` and `class`. */
function isObservableAttribute(name: string): boolean {
  return name === "role" ||
    (name.startsWith("data-") && name.length > 5) ||
    (name.startsWith("aria-") && name.length > 5);
}

/** `dataset.slidesCol` and jQuery's `.data("slidesCol")` read `data-slides-col`. */
function datasetAttributeName(key: string): string {
  return `data-${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

function jsxTagName(text: string, start: number): string {
  let end = start;
  while (end < text.length && end - start < MAX_TAG_LENGTH) {
    const code = text.charCodeAt(end);
    if (!isNameCharacter(code) && code !== DOT && code !== HYPHEN && code !== COLON) {
      break;
    }
    end += 1;
  }
  return text.slice(start, end);
}

function isComplete(token: Token): boolean {
  switch (token.kind) {
    case "number":
    case "string":
    case "template":
    case "regex":
      return true;
    case "name":
      return !OPERAND_KEYWORDS.has(token.value);
    case "punct":
      return token.value === ")" || token.value === "]" || token.value === "}";
    default:
      return false;
  }
}

function regexAllowed(previous: Token): boolean {
  switch (previous.kind) {
    case "start":
      return true;
    case "name":
      return OPERAND_KEYWORDS.has(previous.value);
    case "punct":
      return previous.value !== ")" &&
        previous.value !== "]" &&
        previous.value !== "}";
    default:
      return false;
  }
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.kind === "name" && token.value === value;
}

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(" "));
}

function groupPunctuators(list: string): ReadonlyMap<number, readonly string[]> {
  const grouped = new Map<number, string[]>();
  for (const punctuator of list.split(" ")) {
    const first = punctuator.charCodeAt(0);
    grouped.set(first, [...(grouped.get(first) ?? []), punctuator]);
  }
  return grouped;
}

function appendText(literal: LiteralText, text: string): void {
  if (literal.oversized || text.length === 0) return;
  if (literal.value.length + text.length > JAVASCRIPT_SCAN_LIMITS.maxLiteralLength) {
    literal.oversized = true;
    return;
  }
  literal.value += text;
}

/** Decodes the escape at `index` into the literal and returns its raw length. */
function appendEscape(
  literal: LiteralText,
  text: string,
  index: number,
  limit: number,
): number {
  const escape = decodeEscape(text, index, limit);
  if (!literal.oversized) {
    literal.segments ??= [{ cooked: 0, raw: literal.contentStart }];
    literal.segments.push({ cooked: literal.value.length, raw: index });
    appendText(literal, escape.value);
    literal.segments.push({
      cooked: literal.value.length,
      raw: index + escape.length,
    });
  }
  return escape.length;
}

function rawOffset(literal: ScannedLiteral, cooked: number): number {
  const segments = literal.segments;
  let raw = literal.contentStart + cooked;
  if (segments) {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (segments[middle]!.cooked <= cooked) low = middle;
      else high = middle - 1;
    }
    const segment = segments[low]!;
    raw = segment.raw + (cooked - segment.cooked);
  }
  return Math.min(raw, literal.end - 1);
}

function decodeEscape(
  text: string,
  index: number,
  limit: number,
): { readonly value: string; readonly length: number } {
  if (index + 1 >= limit) return { value: "", length: 1 };
  const next = text.charCodeAt(index + 1);
  switch (next) {
    case 0x6e /* n */:
      return { value: "\n", length: 2 };
    case 0x74 /* t */:
      return { value: "\t", length: 2 };
    case 0x72 /* r */:
      return { value: "\r", length: 2 };
    case 0x62 /* b */:
      return { value: "\b", length: 2 };
    case 0x66 /* f */:
      return { value: "\f", length: 2 };
    case 0x76 /* v */:
      return { value: "\v", length: 2 };
    case 0x78 /* x */: {
      const code = hexValue(text.slice(index + 2, index + 4), 2);
      return code === undefined
        ? { value: "x", length: 2 }
        : { value: String.fromCharCode(code), length: 4 };
    }
    case 0x75 /* u */: {
      if (text.charCodeAt(index + 2) === OPEN_BRACE) {
        const close = text.indexOf("}", index + 3);
        const code = close > index + 3 && close <= index + 9
          ? hexValue(text.slice(index + 3, close), close - index - 3)
          : undefined;
        return code === undefined || code > 0x10ffff
          ? { value: "u", length: 2 }
          : { value: String.fromCodePoint(code), length: close - index + 1 };
      }
      const code = hexValue(text.slice(index + 2, index + 6), 4);
      return code === undefined
        ? { value: "u", length: 2 }
        : { value: String.fromCharCode(code), length: 6 };
    }
    case CARRIAGE_RETURN:
      return {
        value: "",
        length: text.charCodeAt(index + 2) === LINE_FEED ? 3 : 2,
      };
    case LINE_FEED:
    case 0x2028:
    case 0x2029:
      return { value: "", length: 2 };
    default: {
      const character = String.fromCodePoint(text.codePointAt(index + 1)!);
      return { value: character, length: 1 + character.length };
    }
  }
}

function hexValue(value: string, length: number): number | undefined {
  if (value.length !== length || !/^[0-9A-Fa-f]+$/u.test(value)) return undefined;
  return Number.parseInt(value, 16);
}

function isScriptWhitespace(code: number): boolean {
  return code === SPACE ||
    code === TAB ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN ||
    code === VERTICAL_TAB ||
    code === FORM_FEED ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000;
}

function isLineTerminator(code: number): boolean {
  return code === LINE_FEED ||
    code === CARRIAGE_RETURN ||
    code === 0x2028 ||
    code === 0x2029;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameStart(code: number): boolean {
  return isAsciiLetter(code) ||
    code === UNDERSCORE ||
    code === DOLLAR ||
    code === BACKSLASH ||
    (code >= 0x80 && !isScriptWhitespace(code));
}

function isNameCharacter(code: number): boolean {
  return isNameStart(code) || isDigit(code);
}

// Selectors ----------------------------------------------------------------

/**
 * Type selectors a real selector uses. Requiring one keeps prose such as
 * `"Could not find .card"`, which parses as a descendant selector, from
 * reading as a reference. Custom element names always carry a hyphen.
 */
const KNOWN_TAGS = words(
  "a abbr address area article aside audio b base bdi bdo big blockquote body br button canvas caption center cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee math menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr " +
    "svg g path circle ellipse line polyline polygon rect text tspan textpath use defs symbol clippath mask pattern image foreignobject lineargradient radialgradient stop filter marker",
);

/**
 * Parses a selector list and returns each selector's subject - its last
 * compound, the element the selector actually matches. Returns `undefined`
 * for text that is not a selector list, and an empty list for one whose
 * subjects name no id, class, or attribute.
 */
export function selectorSubjects(value: string): readonly ScriptSubject[] | undefined {
  if (
    value.length > JAVASCRIPT_SCAN_LIMITS.maxSelectorLength ||
    !/[#.[]/u.test(value)
  ) {
    return undefined;
  }
  const reader = new SelectorReader(value);
  const subjects: ScriptSubject[] = [];
  for (;;) {
    const subject = reader.complexSelector();
    if (!subject) return undefined;
    if (hasConstraint(subject)) subjects.push(subject);
    if (reader.done) return subjects;
    if (!reader.eat(COMMA)) return undefined;
  }
}

class SelectorReader {
  private index = 0;

  public constructor(private readonly text: string) {}

  public get done(): boolean {
    return this.index >= this.text.length;
  }

  public eat(code: number): boolean {
    if (this.peek() !== code) return false;
    this.index += 1;
    return true;
  }

  public complexSelector(): ScriptSubject | undefined {
    this.skipWhitespace();
    // A relative selector such as jQuery's `find("> li")`.
    if (this.eatCombinator()) this.skipWhitespace();
    let subject = this.compound();
    if (!subject) return undefined;
    for (;;) {
      const spaced = this.skipWhitespace();
      if (this.done || this.peek() === COMMA) return subject;
      if (this.eatCombinator()) this.skipWhitespace();
      else if (!spaced) return undefined;
      subject = this.compound();
      if (!subject) return undefined;
    }
  }

  private compound(): ScriptSubject | undefined {
    let tag: string | undefined;
    const ids: string[] = [];
    const classes: string[] = [];
    const attributes: AttributeConstraint[] = [];
    let parts = 0;
    if (this.eat(STAR)) {
      parts += 1;
    } else if (this.startsIdentifier()) {
      const name = this.identifier();
      if (name === undefined || !isKnownTag(name)) return undefined;
      tag = name.includes(PLACEHOLDER) ? undefined : name.toLowerCase();
      parts += 1;
    }
    for (;;) {
      const code = this.peek();
      if (code === HASH || code === DOT) {
        this.index += 1;
        const name = this.identifier();
        if (name === undefined) return undefined;
        if (!name.includes(PLACEHOLDER)) {
          (code === HASH ? ids : classes).push(name);
        }
      } else if (code === OPEN_BRACKET) {
        const attribute = this.attribute();
        if (attribute === undefined) return undefined;
        if (attribute) attributes.push(attribute);
      } else if (code === COLON) {
        if (!this.pseudo()) return undefined;
      } else {
        break;
      }
      parts += 1;
    }
    return parts > 0 ? { tag, ids, classes, attributes } : undefined;
  }

  /** Returns `null` for a valid attribute selector the scan cannot compare. */
  private attribute(): AttributeConstraint | null | undefined {
    this.index += 1;
    this.skipWhitespace();
    const rawName = this.identifier();
    if (rawName === undefined) return undefined;
    this.skipWhitespace();
    let operator: AttributeOperator | undefined;
    let value: string | undefined;
    let caseInsensitive = false;
    if (this.peek() !== CLOSE_BRACKET) {
      operator = this.attributeOperator();
      if (!operator) return undefined;
      this.skipWhitespace();
      const quote = this.peek();
      value = quote === QUOTE_DOUBLE || quote === QUOTE_SINGLE
        ? this.quotedValue(quote)
        : this.identifier();
      if (value === undefined) return undefined;
      this.skipWhitespace();
      const flag = this.peek() | 0x20;
      if (flag === 0x69 /* i */ || flag === 0x73 /* s */) {
        caseInsensitive = flag === 0x69;
        this.index += 1;
        this.skipWhitespace();
      }
    }
    if (!this.eat(CLOSE_BRACKET)) return undefined;
    if (rawName.includes(PLACEHOLDER)) return null;
    const name = rawName.toLowerCase();
    if (value === undefined || value.includes(PLACEHOLDER)) {
      return { name, operator: undefined, value: undefined, caseInsensitive: false };
    }
    return { name, operator, value, caseInsensitive };
  }

  private attributeOperator(): AttributeOperator | undefined {
    const code = this.peek();
    if (code === EQUALS) {
      this.index += 1;
      return "=";
    }
    if (this.text.charCodeAt(this.index + 1) !== EQUALS) return undefined;
    const operator: AttributeOperator | undefined = code === TILDE
      ? "~="
      : code === PIPE
        ? "|="
        : code === CARET
          ? "^="
          : code === DOLLAR
            ? "$="
            : code === STAR
              ? "*="
              : undefined;
    if (operator) this.index += 2;
    return operator;
  }

  private pseudo(): boolean {
    this.index += 1;
    this.eat(COLON);
    if (this.identifier() === undefined) return false;
    if (this.peek() !== OPEN_PAREN) return true;
    // Arguments such as `:not(.a .b)` or `:nth-child(2n of .x)` describe
    // other elements or states; they are skipped, never compared.
    let depth = 0;
    while (!this.done) {
      const code = this.peek();
      if (code === BACKSLASH) {
        this.index += 2;
        continue;
      }
      if (code === QUOTE_DOUBLE || code === QUOTE_SINGLE) {
        if (this.quotedValue(code) === undefined) return false;
        continue;
      }
      this.index += 1;
      if (code === OPEN_PAREN) depth += 1;
      else if (code === CLOSE_PAREN && --depth === 0) return true;
    }
    return false;
  }

  private quotedValue(quote: number): string | undefined {
    this.index += 1;
    let value = "";
    while (!this.done) {
      const code = this.peek();
      if (code === quote) {
        this.index += 1;
        return value;
      }
      if (isLineTerminator(code)) return undefined;
      if (code === BACKSLASH) {
        if (isLineTerminator(this.text.charCodeAt(this.index + 1))) {
          this.index += 2;
          continue;
        }
        const escaped = this.escape();
        if (escaped === undefined) return undefined;
        value += escaped;
        continue;
      }
      value += this.text[this.index];
      this.index += 1;
    }
    return undefined;
  }

  private startsIdentifier(): boolean {
    const code = this.peek();
    if (code === HYPHEN) {
      const next = this.text.charCodeAt(this.index + 1);
      return next === HYPHEN || isCssNameStart(next);
    }
    return isCssNameStart(code);
  }

  private identifier(): string | undefined {
    if (!this.startsIdentifier()) return undefined;
    let value = "";
    while (!this.done) {
      const code = this.peek();
      if (code === BACKSLASH) {
        const escaped = this.escape();
        if (escaped === undefined) return undefined;
        value += escaped;
        continue;
      }
      if (!isCssNameStart(code) && !isDigit(code) && code !== HYPHEN) break;
      value += this.text[this.index];
      this.index += 1;
    }
    return /[^-]/u.test(value) ? value : undefined;
  }

  /** Reads a CSS escape such as `\:` in `.md\:flex` or `\31 ` for a digit. */
  private escape(): string | undefined {
    this.index += 1;
    if (this.done || isLineTerminator(this.peek())) return undefined;
    let hex = "";
    while (hex.length < 6 && !this.done && isHexDigit(this.peek())) {
      hex += this.text[this.index];
      this.index += 1;
    }
    if (hex.length > 0) {
      if (!this.done && isCssWhitespace(this.peek())) this.index += 1;
      const point = Number.parseInt(hex, 16);
      return point === 0 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)
        ? "�"
        : String.fromCodePoint(point);
    }
    const character = String.fromCodePoint(this.text.codePointAt(this.index)!);
    this.index += character.length;
    return character;
  }

  private eatCombinator(): boolean {
    const code = this.peek();
    if (code !== GREATER_THAN && code !== PLUS && code !== TILDE) return false;
    this.index += 1;
    return true;
  }

  private skipWhitespace(): boolean {
    const start = this.index;
    while (!this.done && isCssWhitespace(this.peek())) this.index += 1;
    return this.index > start;
  }

  private peek(): number {
    return this.text.charCodeAt(this.index);
  }
}

function isKnownTag(name: string): boolean {
  if (name.includes(PLACEHOLDER)) return true;
  const lowered = name.toLowerCase();
  return KNOWN_TAGS.has(lowered) ||
    (lowered.includes("-") && isAsciiLetter(lowered.charCodeAt(0)));
}

function isCssNameStart(code: number): boolean {
  return isAsciiLetter(code) ||
    code === UNDERSCORE ||
    code === BACKSLASH ||
    code === 0 ||
    code >= 0x80;
}

function isCssWhitespace(code: number): boolean {
  return code === SPACE ||
    code === TAB ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN ||
    code === FORM_FEED;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66);
}

// Labels and diagnostics ---------------------------------------------------

/** One line of display text; substitutions show as `...`. */
function renderValue(value: string): string {
  return value
    .slice(0, MAX_RENDERED_VALUE_LENGTH)
    .replaceAll(PLACEHOLDER, "...")
    .replace(/\s+/gu, " ")
    .trim();
}

function quoted(rendered: string): string {
  return rendered.includes('"') && !rendered.includes("'")
    ? `'${rendered}'`
    : `"${rendered}"`;
}

/** Labels an element the way the PHP provider does: `article#hero.card`. */
function markupLabel(
  tag: string | undefined,
  subjects: readonly ScriptSubject[],
): string {
  const ids = [...new Set(subjects.flatMap((subject) => subject.ids))];
  const classes = [...new Set(subjects.flatMap((subject) => subject.classes))];
  const attribute = ids.length === 0 && classes.length === 0
    ? subjects.flatMap((subject) => subject.attributes)[0]
    : undefined;
  return boundedLabel([
    tag ?? "",
    ...ids.slice(0, 1).map((id) => `#${id}`),
    ...classes.slice(0, MAX_LABEL_CLASSES).map((name) => `.${name}`),
    ...(attribute
      ? [
          attribute.value === undefined
            ? `[${attribute.name}]`
            : `[${attribute.name}=${quoted(renderValue(attribute.value))}]`,
        ]
      : []),
  ].join("")) || "markup";
}

function boundedLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  let bounded = label.slice(0, MAX_LABEL_LENGTH - 3);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  return `${bounded}...`;
}

function addOnce(
  diagnostics: PluginDiagnostic[],
  diagnostic: PluginDiagnostic,
): void {
  if (diagnostics.some((entry) => entry.code === diagnostic.code)) return;
  diagnostics.push(diagnostic);
}

function parseDiagnostic(error: unknown): PluginDiagnostic {
  return {
    code: "javascript.parseFailed",
    message: `The script could not be read: ${messageOf(error)}`,
    severity: "error",
  };
}

function limitedDiagnostic(listed: number): PluginDiagnostic {
  return {
    code: "javascript.referencesLimited",
    message:
      `More places in this script refer to the element than are listed; the ${listed} strongest are shown.`,
    severity: "info",
    metadata: { listed },
  };
}

function truncatedDocumentDiagnostic(): PluginDiagnostic {
  return {
    code: "javascript.documentTruncated",
    message: "This script is too large to scan completely.",
    severity: "warning",
  };
}

function abortedResult(): StatusAwareSourcePluginResult {
  return { status: "no-rule-match", matches: [], diagnostics: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
