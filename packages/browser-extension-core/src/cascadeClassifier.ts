import type { CssRuleContextRecord } from "./cssRuleWalker.js";
import type {
  MatchedDeclarationReason,
  MatchedDeclarationState,
} from "./matchedStylesTypes.js";

export type SelectorSpecificity = readonly [number, number, number];

export interface CascadeCandidate {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly specificity: SelectorSpecificity | undefined;
  readonly sourceOrder: number;
  readonly contexts: readonly CssRuleContextRecord[];
  readonly active: boolean | undefined;
  readonly inherited: boolean;
}

export interface CascadeClassification {
  readonly state: MatchedDeclarationState;
  readonly reason: MatchedDeclarationReason;
}

const SHORTHAND_PROPERTIES = new Set([
  "all",
  "animation",
  "background",
  "border",
  "border-block",
  "border-color",
  "border-image",
  "border-inline",
  "border-radius",
  "border-style",
  "border-width",
  "columns",
  "flex",
  "flex-flow",
  "font",
  "gap",
  "grid",
  "grid-area",
  "grid-column",
  "grid-row",
  "grid-template",
  "inset",
  "inset-block",
  "inset-inline",
  "list-style",
  "margin",
  "margin-block",
  "margin-inline",
  "mask",
  "offset",
  "outline",
  "overflow",
  "padding",
  "padding-block",
  "padding-inline",
  "place-content",
  "place-items",
  "place-self",
  "text-decoration",
  "text-emphasis",
  "transition",
]);

const SHORTHAND_LONGHAND_RELATIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    inset: Object.freeze(["top", "right", "bottom", "left"]),
    "inset-block": Object.freeze(["inset-block-start", "inset-block-end"]),
    "inset-inline": Object.freeze(["inset-inline-start", "inset-inline-end"]),
    "border-color": Object.freeze([
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
    ]),
    "border-style": Object.freeze([
      "border-top-style",
      "border-right-style",
      "border-bottom-style",
      "border-left-style",
    ]),
    "border-width": Object.freeze([
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
    ]),
    "place-items": Object.freeze(["align-items", "justify-items"]),
    "place-content": Object.freeze(["align-content", "justify-content"]),
    "place-self": Object.freeze(["align-self", "justify-self"]),
    gap: Object.freeze(["row-gap", "column-gap"]),
    overflow: Object.freeze(["overflow-x", "overflow-y"]),
    "flex-flow": Object.freeze(["flex-direction", "flex-wrap"]),
  });

/**
 * Classifies one declaration only against the author declarations present in
 * the same bounded snapshot. It deliberately never consults computed style.
 */
export function classifyCascade(
  candidate: CascadeCandidate,
  declarations: readonly CascadeCandidate[],
): CascadeClassification {
  const unsafe = unsafeReason(candidate);
  if (unsafe) return unsafe;

  const environmentalHazard = declarations.find((declaration) => (
    declaration.active !== false &&
    !hasUnsupportedContext(declaration.contexts) &&
    (isAnimationOrTransition(declaration.property) ||
      (isShorthand(declaration.property) &&
        shorthandMayAffect(declaration.property, candidate.property)))
  ));
  if (environmentalHazard) {
    return isAnimationOrTransition(environmentalHazard.property)
      ? { state: "unknown", reason: "animation-or-transition-cascade" }
      : { state: "unknown", reason: "unsupported-shorthand" };
  }

  const contenders = declarations.filter((declaration) => (
    declaration.property === candidate.property && !unsafeReason(declaration)
  ));
  let winner = candidate;
  for (const contender of contenders) {
    if (comparePrecedence(contender, winner) > 0) winner = contender;
  }
  return winner === candidate
    ? {
      state: "winning-known-author",
      reason: "highest-precedence-known-author-declaration",
    }
    : {
      state: "overridden-known-author",
      reason: "lower-precedence-author-declaration",
    };
}

function unsafeReason(
  candidate: CascadeCandidate,
): CascadeClassification | undefined {
  if (candidate.active === false) {
    return { state: "inactive", reason: "inactive-group-condition" };
  }
  for (const context of candidate.contexts) {
    switch (context.kind) {
      case "layer":
        return { state: "unknown", reason: "unsupported-cascade-layer" };
      case "scope":
        return { state: "unknown", reason: "unsupported-cascade-scope" };
      case "container":
        return { state: "unknown", reason: "unsupported-container-query" };
      case "starting-style":
        return { state: "unknown", reason: "unsupported-starting-style" };
      case "unknown":
        return { state: "unknown", reason: "unsupported-group-context" };
      default:
        break;
    }
  }
  if (candidate.active === undefined) {
    return { state: "unknown", reason: "unknown-group-applicability" };
  }
  if (candidate.inherited) {
    return { state: "unknown", reason: "inherited-author-declaration" };
  }
  if (candidate.property.startsWith("--")) {
    return { state: "unknown", reason: "custom-property-cascade" };
  }
  if (/\bvar\s*\(/i.test(candidate.value)) {
    return { state: "unknown", reason: "variable-dependent-value" };
  }
  if (isAnimationOrTransition(candidate.property)) {
    return { state: "unknown", reason: "animation-or-transition-cascade" };
  }
  if (isShorthand(candidate.property)) {
    return { state: "unknown", reason: "unsupported-shorthand" };
  }
  if (!candidate.specificity) {
    return { state: "unknown", reason: "unsupported-selector-specificity" };
  }
  return undefined;
}

function isShorthand(property: string): boolean {
  return SHORTHAND_PROPERTIES.has(property.toLowerCase());
}

function isAnimationOrTransition(property: string): boolean {
  const normalized = property.toLowerCase();
  return normalized === "animation" || normalized.startsWith("animation-") ||
    normalized === "transition" || normalized.startsWith("transition-");
}

function shorthandMayAffect(shorthand: string, property: string): boolean {
  const normalizedShorthand = shorthand.toLowerCase();
  const normalizedProperty = property.toLowerCase();
  if (normalizedShorthand === "all") return true;
  if (SHORTHAND_LONGHAND_RELATIONS[normalizedShorthand]?.includes(normalizedProperty)) {
    return true;
  }
  if (normalizedProperty.startsWith(`${normalizedShorthand}-`)) return true;
  if (normalizedShorthand === "font") {
    return normalizedProperty.startsWith("font-") || normalizedProperty === "line-height";
  }
  if (normalizedShorthand === "border") return normalizedProperty.startsWith("border-");
  if (normalizedShorthand === "border-radius") {
    return normalizedProperty.startsWith("border-") && normalizedProperty.endsWith("-radius");
  }
  if (normalizedShorthand === "background") {
    return normalizedProperty.startsWith("background-");
  }
  return false;
}

function hasUnsupportedContext(contexts: readonly CssRuleContextRecord[]): boolean {
  return contexts.some(({ kind }) => (
    kind === "layer" || kind === "scope" || kind === "container" ||
    kind === "starting-style" || kind === "unknown"
  ));
}

function comparePrecedence(left: CascadeCandidate, right: CascadeCandidate): number {
  if (left.important !== right.important) return left.important ? 1 : -1;
  const leftSpecificity = left.specificity!;
  const rightSpecificity = right.specificity!;
  for (let index = 0; index < leftSpecificity.length; index += 1) {
    const difference = leftSpecificity[index]! - rightSpecificity[index]!;
    if (difference !== 0) return difference;
  }
  return left.sourceOrder - right.sourceOrder;
}
