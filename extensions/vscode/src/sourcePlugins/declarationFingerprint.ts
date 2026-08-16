import type { CssRuleFact } from "@pin-op/protocol";
import type {
  CssDeclarationEvidence,
  NormalizedDeclaration,
} from "./types.js";

const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/i;
const TIGHT_PUNCTUATION = new Set(["(", ")", ",", "/", ":"]);

export function declarationFingerprint(
  declarations: readonly CssDeclarationEvidence[],
): readonly NormalizedDeclaration[] {
  const normalized: NormalizedDeclaration[] = [];
  for (const declaration of declarations) {
    const entry = normalizeDeclaration(declaration);
    if (!entry) return [];
    normalized.push(entry);
  }
  const properties = new Set<string>();
  for (const declaration of normalized) {
    if (properties.has(declaration.property)) return [];
    properties.add(declaration.property);
  }
  return normalized.sort(compareDeclarations);
}

export function declarationEvidenceFromFact(
  fact: CssRuleFact,
): CssDeclarationEvidence | undefined {
  const metadataValueTruncated = fact.metadata.valueTruncated;
  if (typeof metadataValueTruncated !== "boolean" || metadataValueTruncated) {
    return undefined;
  }
  const important = factPriority(fact);
  if (important === undefined) return undefined;
  return {
    property: fact.property,
    value: fact.value,
    valueComplete: true,
    important,
  };
}

function factPriority(fact: CssRuleFact): boolean | undefined {
  const hasImportant = Object.prototype.hasOwnProperty.call(
    fact.metadata,
    "important",
  );
  const hasPriority = Object.prototype.hasOwnProperty.call(
    fact.metadata,
    "priority",
  );
  const metadataImportant = fact.metadata.important;
  const metadataPriority = fact.metadata.priority;
  if (hasImportant && typeof metadataImportant !== "boolean") return undefined;
  if (
    hasPriority && metadataPriority !== "" && metadataPriority !== "important"
  ) {
    return undefined;
  }
  if (!hasImportant && !hasPriority) return undefined;
  const legacyImportant = hasPriority
    ? metadataPriority === "important"
    : undefined;
  if (
    typeof metadataImportant === "boolean" &&
    legacyImportant !== undefined &&
    metadataImportant !== legacyImportant
  ) {
    return undefined;
  }
  return typeof metadataImportant === "boolean"
    ? metadataImportant
    : legacyImportant;
}

export function declarationsContainEvidence(
  candidate: readonly NormalizedDeclaration[],
  evidence: readonly NormalizedDeclaration[],
): boolean {
  if (evidence.length === 0) return false;
  const unused = new Set(candidate.map((_entry, index) => index));
  for (const expected of evidence) {
    const match = [...unused].find((index) =>
      declarationMatches(expected, candidate[index]!)
    );
    if (match === undefined) return false;
    unused.delete(match);
  }
  return true;
}

export function normalizeCondition(value: string): string {
  return normalizeCssValue(value);
}

function normalizeDeclaration(
  declaration: CssDeclarationEvidence,
): NormalizedDeclaration | undefined {
  if (declaration.valueComplete === false) return undefined;
  const rawProperty = declaration.property.trim();
  const customProperty = rawProperty.startsWith("--");
  const property = customProperty
    ? rawProperty
    : rawProperty.toLowerCase();
  if (!property) return undefined;
  const suffixImportant = IMPORTANT_SUFFIX.test(declaration.value);
  if (suffixImportant && declaration.important === false) return undefined;
  const unprioritizedValue = declaration.value.replace(IMPORTANT_SUFFIX, "");
  const value = customProperty
    ? unprioritizedValue.trim()
    : normalizeCssValue(unprioritizedValue);
  return {
    property,
    value,
    important: declaration.important ?? suffixImportant,
  };
}

function normalizeCssValue(value: string): string {
  let output = "";
  let quote = "";
  let escaped = false;
  let pendingSpace = false;

  for (const character of value.trim()) {
    if (quote) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      appendPendingSpace();
      quote = character;
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (TIGHT_PUNCTUATION.has(character)) {
      output = output.trimEnd();
      output += character;
      pendingSpace = false;
      continue;
    }
    appendPendingSpace();
    output += character;
  }

  return output.trim();

  function appendPendingSpace(): void {
    if (
      pendingSpace &&
      output.length > 0 &&
      !TIGHT_PUNCTUATION.has(output.at(-1) ?? "")
    ) {
      output += " ";
    }
    pendingSpace = false;
  }
}

function declarationMatches(
  evidence: NormalizedDeclaration,
  candidate: NormalizedDeclaration,
): boolean {
  if (
    evidence.property !== candidate.property ||
    evidence.important !== candidate.important
  ) {
    return false;
  }
  return candidate.value === evidence.value;
}

function compareDeclarations(
  left: NormalizedDeclaration,
  right: NormalizedDeclaration,
): number {
  return left.property.localeCompare(right.property) ||
    left.value.localeCompare(right.value) ||
    Number(left.important) - Number(right.important);
}
