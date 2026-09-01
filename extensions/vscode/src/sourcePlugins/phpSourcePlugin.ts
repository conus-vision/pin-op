import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceDocument,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourceRange,
} from "@pin-op/plugin-api";
import type {
  InspectTarget,
  ResolutionStatus,
  RuntimeFact,
  SourceLocation,
} from "@pin-op/protocol";
import { targetDomIdentity, type DomSubjectIdentity } from "./domFacts.js";
import {
  classTokens,
  PhpMarkupCache,
  type ParsedPhpMarkup,
  type PhpMarkupElement,
} from "./phpMarkup.js";
import { classifyActiveDocumentSource } from "./sourceWorkspace.js";
import type { StatusAwareSourcePluginResult } from "./types.js";

/**
 * Instrumentation fact kinds a PHP runtime or build step can emit. They carry
 * an explicit template identity, so they resolve as `instrumented` rather than
 * as a markup guess.
 */
const TEMPLATE_FACT_KINDS = ["php.template", "wordpress.acf-block"] as const;

/** Longer element bodies fall back to the opening tag so excerpts stay useful. */
const MAX_MATCH_LENGTH = 8 * 1024;

/**
 * One element is often written more than once in a template - the branches of
 * an `if`/`else` render the same block for different page types. Those are all
 * real candidate origins, so the pane lists them instead of failing closed.
 * Beyond this many the list stops being an answer and becomes noise.
 */
const MAX_MARKUP_MATCHES = 8;

const MAX_LABEL_CLASSES = 3;
const MAX_LABEL_LENGTH = 96;

type MarkupEvidence = "markup-id" | "markup-attributes" | "markup-classes";

type MarkupOutcome =
  | {
      readonly kind: "match";
      readonly elements: readonly PhpMarkupElement[];
      readonly evidence: MarkupEvidence;
    }
  | { readonly kind: "ambiguous"; readonly evidence: MarkupEvidence }
  | { readonly kind: "none" };

/**
 * Resolves the active PHP document for the selected element.
 *
 * Instrumented template facts are authoritative when their template resolves
 * to the active document. Without instrumentation the plugin searches the
 * document's literal markup for the element's `id`, then its `data-*` /
 * `aria-*` / `role` attributes, then its full class set, and reports the first
 * tier that identifies exactly one element. Final DOM cannot prove PHP source
 * identity, so those matches stay `heuristic` and an ambiguous tier is
 * reported rather than guessed.
 */
export class PhpSourcePlugin implements SourcePlugin {
  public readonly id = "pin-op.php";
  public readonly displayName = "Pin-op PHP";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "php", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = [
    "dom-attribute",
    ...TEMPLATE_FACT_KINDS,
  ] as const;

  public constructor(private readonly markup = new PhpMarkupCache()) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<StatusAwareSourcePluginResult> {
    if (context.signal.aborted) return abortedResult();

    let parsed: ParsedPhpMarkup;
    try {
      parsed = this.markup.parseDocument(context.document);
    } catch (error) {
      return {
        status: "error",
        matches: [],
        diagnostics: [parseDiagnostic(error)],
      };
    }

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const failures = new Set<ResolutionStatus>();
    const instrumentedRoles = new Set<InspectTarget["role"]>();

    for (const target of context.selection.targets) {
      for (const fact of target.facts) {
        if (context.signal.aborted) return abortedResult();
        if (!isTemplateFact(fact)) continue;
        const reference = templateReference(fact);
        if (!reference) {
          addOnce(diagnostics, malformedTemplateDiagnostic(fact.type));
          continue;
        }
        const resolution = await context.workspace.resolveSourceUri(
          reference,
          context.selection.context.url,
        );
        if (context.signal.aborted) return abortedResult();
        const sourceKind = classifyActiveDocumentSource(
          resolution,
          context.document.uri,
        );
        if (sourceKind === "ambiguous") {
          failures.add("source-ambiguous");
          addOnce(diagnostics, ambiguousTemplateDiagnostic());
          continue;
        }
        if (sourceKind === "other-document") {
          failures.add("source-not-active-document");
          addOnce(diagnostics, otherDocumentDiagnostic());
          continue;
        }
        if (sourceKind === "not-found") {
          failures.add("source-not-found");
          addOnce(diagnostics, missingTemplateDiagnostic());
          continue;
        }
        const range = rangeFromSourceLocation(fact.source, context.document);
        if (!range) {
          failures.add("no-rule-match");
          addOnce(diagnostics, missingTemplateRangeDiagnostic(fact.type));
          continue;
        }
        matches.push({
          targetRole: target.role,
          range,
          label: templateLabel(fact),
          kind: "template",
          relation: "renders",
          confidence: "instrumented",
          metadata: { evidence: fact.type },
        });
        instrumentedRoles.add(target.role);
      }
    }

    for (const target of context.selection.targets) {
      if (context.signal.aborted) return abortedResult();
      if (instrumentedRoles.has(target.role)) continue;
      const identity = targetDomIdentity(target);
      if (!identity) {
        failures.add("no-facts");
        continue;
      }
      const outcome = findTemplateElement(parsed, identity);
      if (outcome.kind === "ambiguous") {
        failures.add("rule-match-ambiguous");
        addOnce(diagnostics, ambiguousMarkupDiagnostic(outcome.evidence));
        continue;
      }
      if (outcome.kind === "none") {
        failures.add("no-rule-match");
        continue;
      }
      for (const element of outcome.elements) {
        matches.push({
          targetRole: target.role,
          range: elementRange(element, context.document),
          label: markupLabel(element),
          kind: "template",
          relation: "renders",
          confidence: "heuristic",
          metadata: { evidence: outcome.evidence },
        });
      }
    }

    if (parsed.truncated && matches.length === 0) {
      addOnce(diagnostics, truncatedDocumentDiagnostic());
    }

    return {
      status: matches.length > 0 ? "matched" : failureStatus(failures),
      matches,
      diagnostics,
    };
  }
}

/**
 * Scores every element the template could have rendered, then reports the
 * strongest, most specific evidence tier and every element that reaches it.
 *
 * A template holds an element's *static* markup: the browser adds classes and
 * attributes at runtime, and PHP adds more. So the containment runs template
 * into DOM - every literal class the template writes has to be on the selected
 * element, but the element may carry extra classes the template never wrote.
 * A literal value that contradicts the DOM disqualifies the element outright.
 */
export function findTemplateElement(
  parsed: ParsedPhpMarkup,
  identity: DomSubjectIdentity,
): MarkupOutcome {
  const candidates: {
    readonly element: PhpMarkupElement;
    readonly tier: number;
    readonly evidence: MarkupEvidence;
    readonly specificity: number;
  }[] = [];

  for (const element of parsed.elements) {
    const scored = scoreElement(element, identity);
    if (scored) candidates.push({ element, ...scored });
  }
  if (candidates.length === 0) return { kind: "none" };

  const tier = Math.min(...candidates.map((candidate) => candidate.tier));
  const inTier = candidates.filter((candidate) => candidate.tier === tier);
  const specificity = Math.max(
    ...inTier.map((candidate) => candidate.specificity),
  );
  const best = inTier.filter(
    (candidate) => candidate.specificity === specificity,
  );
  const evidence = best[0]!.evidence;
  return best.length <= MAX_MARKUP_MATCHES
    ? {
        kind: "match",
        elements: best.map((candidate) => candidate.element),
        evidence,
      }
    : { kind: "ambiguous", evidence };
}

function scoreElement(
  element: PhpMarkupElement,
  identity: DomSubjectIdentity,
): { readonly tier: number; readonly evidence: MarkupEvidence; readonly specificity: number } | undefined {
  if (identity.tag !== undefined && element.tag !== identity.tag) {
    return undefined;
  }

  const declaredId = literalAttribute(element, "id");
  if (declaredId !== undefined && declaredId !== identity.id) {
    return undefined;
  }

  const declaredClasses = literalClassTokens(element);
  if (declaredClasses.some((token) => !identity.classes.includes(token))) {
    return undefined;
  }

  let attributeScore = 0;
  for (const attribute of element.attributes) {
    if (!isComparableAttributeName(attribute.name) || attribute.dynamic) {
      continue;
    }
    const value = identity.attributes.get(attribute.name);
    // An attribute the DOM dropped is not evidence either way; a different
    // value is a contradiction.
    if (value === undefined) continue;
    if (value !== attribute.literalValue) return undefined;
    attributeScore += 1;
  }

  const specificity = attributeScore + declaredClasses.length;
  if (declaredId !== undefined) {
    return { tier: 1, evidence: "markup-id", specificity };
  }
  if (attributeScore > 0) {
    return { tier: 2, evidence: "markup-attributes", specificity };
  }
  return declaredClasses.length > 0
    ? { tier: 3, evidence: "markup-classes", specificity }
    : undefined;
}

function isComparableAttributeName(name: string): boolean {
  return name === "role" ||
    name.startsWith("data-") ||
    name.startsWith("aria-");
}

/**
 * The literal half of a `class` attribute. A PHP expression inside it only
 * contributes classes this scan cannot read, so the literal tokens still have
 * to hold.
 */
function literalClassTokens(element: PhpMarkupElement): readonly string[] {
  const declared = element.attributes.find(
    (attribute) => attribute.name === "class",
  );
  return declared ? classTokens(declared.literalValue) : [];
}

/** Dynamic values cannot be compared literally, so they never match. */
function literalAttribute(
  element: PhpMarkupElement,
  name: string,
): string | undefined {
  const attribute = element.attributes.find(
    (candidate) => candidate.name === name,
  );
  if (!attribute || attribute.dynamic) return undefined;
  return attribute.literalValue;
}

function elementRange(
  element: PhpMarkupElement,
  document: SourceDocument,
): SourceRange {
  const end = element.endOffset - element.startOffset > MAX_MATCH_LENGTH
    ? element.openEndOffset
    : element.endOffset;
  return {
    start: document.positionAt(element.startOffset),
    end: document.positionAt(end),
  };
}

function rangeFromSourceLocation(
  location: SourceLocation | undefined,
  document: SourceDocument,
): SourceRange | undefined {
  if (!location) return undefined;
  const text = document.getText();
  const start = document.positionAt(
    clampOffset(document, text, location.line, location.column),
  );
  const end = location.endLine !== undefined && location.endColumn !== undefined
    ? document.positionAt(
        clampOffset(document, text, location.endLine, location.endColumn),
      )
    : document.positionAt(
        clampOffset(document, text, location.line + 1, 1),
      );
  if (end.line < start.line) return undefined;
  if (end.line === start.line && end.character <= start.character) {
    return undefined;
  }
  return { start, end };
}

function clampOffset(
  document: SourceDocument,
  text: string,
  oneBasedLine: number,
  oneBasedColumn: number,
): number {
  const offset = document.offsetAt({
    line: Math.max(0, oneBasedLine - 1),
    character: Math.max(0, oneBasedColumn - 1),
  });
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return Math.min(offset, text.length);
}

function isTemplateFact(
  fact: RuntimeFact,
): fact is Extract<RuntimeFact, { readonly payload: unknown }> {
  return (TEMPLATE_FACT_KINDS as readonly string[]).includes(fact.type);
}

function templateReference(
  fact: Extract<RuntimeFact, { readonly payload: unknown }>,
): string | undefined {
  const template = fact.payload["template"];
  if (typeof template === "string" && template.length > 0) return template;
  const uri = fact.source?.uri;
  return typeof uri === "string" && uri.length > 0 ? uri : undefined;
}

function templateLabel(
  fact: Extract<RuntimeFact, { readonly payload: unknown }>,
): string {
  const blockName = fact.payload["blockName"];
  const candidate = typeof blockName === "string" ? blockName : undefined;
  return safeLabelSegment(candidate) ?? "PHP template block";
}

function markupLabel(element: PhpMarkupElement): string {
  const id = literalAttribute(element, "id");
  const declared = literalAttribute(element, "class");
  const classes = declared ? classTokens(declared).slice(0, MAX_LABEL_CLASSES) : [];
  const label = [
    element.tag,
    ...(id ? [`#${id}`] : []),
    ...classes.map((className) => `.${className}`),
  ].join("");
  return label.slice(0, MAX_LABEL_LENGTH) || "PHP template block";
}

/** Keeps a label free of the path separators the host boundary rejects. */
function safeLabelSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const segment = value.split(/[/\\]/u).filter(Boolean).at(-1)?.trim();
  return segment && segment.length > 0
    ? segment.slice(0, MAX_LABEL_LENGTH)
    : undefined;
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
    code: "php.parseFailed",
    message: `PHP markup could not be read: ${messageOf(error)}`,
    severity: "error",
  };
}

function malformedTemplateDiagnostic(factType: string): PluginDiagnostic {
  return {
    code: "php.templateFactMalformed",
    message: `A ${factType} fact carries no template identity.`,
    severity: "warning",
  };
}

function ambiguousTemplateDiagnostic(): PluginDiagnostic {
  return {
    code: "php.sourceAmbiguous",
    message: "The instrumented template maps to more than one workspace file.",
    severity: "warning",
  };
}

function otherDocumentDiagnostic(): PluginDiagnostic {
  return {
    code: "php.sourceNotActiveDocument",
    message: "The instrumented template is not the active document.",
    severity: "info",
  };
}

function missingTemplateDiagnostic(): PluginDiagnostic {
  return {
    code: "php.sourceNotFound",
    message: "The instrumented template is not in the active workspace.",
    severity: "info",
  };
}

function missingTemplateRangeDiagnostic(factType: string): PluginDiagnostic {
  return {
    code: "php.templateRangeMissing",
    message: `A ${factType} fact resolved to this document without a usable source range.`,
    severity: "warning",
  };
}

function ambiguousMarkupDiagnostic(evidence: MarkupEvidence): PluginDiagnostic {
  return {
    code: "php.markupAmbiguous",
    message:
      "More than one element in this template matches the selected element. Add instrumentation for an exact match.",
    severity: "warning",
    metadata: { evidence },
  };
}

function truncatedDocumentDiagnostic(): PluginDiagnostic {
  return {
    code: "php.documentTruncated",
    message: "This template is too large to scan completely.",
    severity: "warning",
  };
}

function failureStatus(failures: ReadonlySet<ResolutionStatus>): ResolutionStatus {
  for (const status of [
    "source-ambiguous",
    "source-not-active-document",
    "source-not-found",
    "rule-match-ambiguous",
    "no-facts",
    "no-rule-match",
  ] as const) {
    if (failures.has(status)) return status;
  }
  return "no-rule-match";
}

function abortedResult(): StatusAwareSourcePluginResult {
  return { status: "no-rule-match", matches: [], diagnostics: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
