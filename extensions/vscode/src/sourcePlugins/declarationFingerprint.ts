import type { CssResolutionFact } from "./cssFacts.js";
import type {
  CssDeclarationEvidence,
  NormalizedDeclaration,
} from "./types.js";

const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/i;
const TIGHT_PUNCTUATION = new Set(["(", ")", ",", "/", ":"]);
// A closing parenthesis ends a value token: what follows it is a new token and
// keeps its separating space, unlike the punctuation that opens or joins one.
const TIGHT_BEFORE_NEXT = new Set(["(", ",", "/", ":"]);

export function declarationFingerprint(
  declarations: readonly CssDeclarationEvidence[],
): readonly NormalizedDeclaration[] {
  const normalized: NormalizedDeclaration[] = [];
  const declared = new Set<string>();
  for (const declaration of declarations) {
    const entries = normalizeDeclaration(declaration);
    if (entries.length === 0) return [];
    const name = declaration.property.trim().toLowerCase();
    if (declared.has(name)) return [];
    declared.add(name);
    normalized.push(...entries);
  }
  // A shorthand and a longhand can set the same side; the later one wins, the
  // way the browser reads the rule.
  return settleOverlaps(normalized).sort(compareDeclarations);
}

/** The last declaration of a property wins, unless an earlier one is important. */
function settleOverlaps(
  declarations: readonly NormalizedDeclaration[],
): NormalizedDeclaration[] {
  const winners = new Map<string, NormalizedDeclaration>();
  for (const declaration of declarations) {
    const previous = winners.get(declaration.property);
    if (previous?.important && !declaration.important) continue;
    winners.set(declaration.property, declaration);
  }
  return [...winners.values()];
}

export function declarationEvidenceFromFact(
  fact: CssResolutionFact,
): CssDeclarationEvidence | undefined {
  if (fact.valueTruncated) return undefined;
  return {
    property: fact.property,
    value: fact.value,
    valueComplete: true,
    important: fact.important,
  };
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

export function completeDeclarationFingerprint(
  declarations: readonly CssDeclarationEvidence[],
): readonly NormalizedDeclaration[] | undefined {
  if (declarations.some((declaration) => declaration.valueComplete === false)) {
    return undefined;
  }
  const fingerprint = declarationFingerprint(declarations);
  if (declarations.length === 0) return fingerprint;
  return fingerprint.length > 0 ? fingerprint : undefined;
}

export function equalDeclarationFingerprints(
  left: readonly NormalizedDeclaration[],
  right: readonly NormalizedDeclaration[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      entry.property === candidate.property &&
      entry.value === candidate.value &&
      entry.important === candidate.important;
  });
}

export function normalizeCondition(value: string): string {
  return normalizeCssValue(value);
}

const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/;

/**
 * Compares what the browser reports for a rule with what the file declares.
 *
 * A stylesheet still carries prefixed fallbacks -- `-moz-box-sizing` beside
 * `box-sizing` -- and a browser that does not know a prefixed property drops it
 * without a trace, so the file legitimately declares more than the browser can
 * report. Only prefixed declarations the browser did not report are allowed to
 * be missing; everything else must match exactly, and the caller still requires
 * the match to be the only one in the file.
 */
export function equalReportedDeclarations(
  reported: readonly NormalizedDeclaration[],
  declared: readonly NormalizedDeclaration[],
): boolean {
  const retained = declarationsBrowsersKeep(reported, declared);
  return reported.length === retained.length &&
    reported.every((entry, index) => {
      const candidate = retained[index];
      return candidate !== undefined &&
        entry.property === candidate.property &&
        entry.important === candidate.important &&
        (entry.value === candidate.value ||
          readsAsPixels(entry.value, candidate.value));
    });
}

/**
 * The declarations a browser could have reported: a prefixed fallback it does
 * not know is dropped without a trace, and the stylesheet keeps it anyway.
 */
export function declarationsBrowsersKeep(
  reported: readonly NormalizedDeclaration[],
  declared: readonly NormalizedDeclaration[],
): readonly NormalizedDeclaration[] {
  const reportedProperties = new Set(reported.map(({ property }) => property));
  return declared.filter(({ property }) =>
    !VENDOR_PREFIX.test(property) || reportedProperties.has(property)
  );
}

/**
 * A page without a doctype puts the browser in quirks mode, where a bare number
 * is read as pixels. The stylesheet wrote the number; the browser reports the
 * length it made of it, and that is the same declaration.
 */
function readsAsPixels(reported: string, declared: string): boolean {
  return /^-?(?:\d+|\d*\.\d+)px$/.test(reported) &&
    reported.slice(0, -2) === declared;
}

/**
 * Applies the cascade inside one rule. A stylesheet may declare a property more
 * than once -- a prefixed fallback, or a value overwritten a few lines later --
 * and the browser keeps exactly one of them: the last, unless an earlier one
 * was marked important. Reading the rule the same way is what lets it be
 * compared with what the browser reports.
 */
export function declarationsAfterInRuleCascade(
  declarations: readonly CssDeclarationEvidence[],
): readonly CssDeclarationEvidence[] {
  const winners = new Map<string, CssDeclarationEvidence>();
  for (const declaration of declarations) {
    const rawProperty = declaration.property.trim();
    const key = rawProperty.startsWith("--")
      ? rawProperty
      : rawProperty.toLowerCase();
    const previous = winners.get(key);
    if (previous && isImportant(previous) && !isImportant(declaration)) continue;
    winners.set(key, declaration);
  }
  return [...winners.values()];
}

function isImportant(declaration: CssDeclarationEvidence): boolean {
  return declaration.important ?? IMPORTANT_SUFFIX.test(declaration.value);
}

function normalizeDeclaration(
  declaration: CssDeclarationEvidence,
): readonly NormalizedDeclaration[] {
  if (declaration.valueComplete === false) return [];
  const rawProperty = declaration.property.trim();
  const customProperty = rawProperty.startsWith("--");
  const property = customProperty ? rawProperty : rawProperty.toLowerCase();
  if (!property) return [];
  const suffixImportant = IMPORTANT_SUFFIX.test(declaration.value);
  if (suffixImportant && declaration.important === false) return [];
  const unprioritizedValue = declaration.value.replace(IMPORTANT_SUFFIX, "");
  const important = declaration.important ?? suffixImportant;
  if (customProperty) {
    return [{ property, value: unprioritizedValue.trim(), important }];
  }
  const value = canonicalizeSidesValue(
    property,
    normalizeCssValue(unprioritizedValue),
  );
  return expandPositionalShorthand(property, value, important) ??
    [{ property, value, important }];
}

/**
 * Reads a shorthand as the parts it sets, so the four sides a stylesheet writes
 * out one by one and the `inset: 0` a browser hands back read the same. Only
 * shorthands whose parts map one to one by position are expanded here.
 */
function expandPositionalShorthand(
  property: string,
  value: string,
  important: boolean,
): NormalizedDeclaration[] | undefined {
  const corners = CORNER_LONGHANDS[property];
  if (corners) {
    const groups = splitTopLevel(value, "/");
    if (groups.length > 2) return undefined;
    const horizontal = splitTopLevel(groups[0] ?? "", " ");
    const vertical = groups[1] === undefined
      ? horizontal
      : splitTopLevel(groups[1], " ");
    if (horizontal.length !== corners.length) return undefined;
    if (vertical.length !== corners.length) return undefined;
    return corners.map((corner, index) => ({
      property: corner,
      value: horizontal[index] === vertical[index]
        ? horizontal[index]!
        : horizontal[index] + " " + vertical[index],
      important,
    }));
  }
  const parts = SIDE_LONGHANDS[property] ?? AXIS_LONGHANDS[property];
  if (!parts) return undefined;
  const components = splitTopLevel(value, " ");
  if (components.length !== parts.length) return undefined;
  return parts.map((part, index) => ({
    property: part,
    value: components[index]!,
    important,
  }));
}

const SIDE_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  inset: ["top", "right", "bottom", "left"],
  "border-width": [
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ],
  "border-style": [
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
  ],
  "border-color": [
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
  "scroll-margin": [
    "scroll-margin-top",
    "scroll-margin-right",
    "scroll-margin-bottom",
    "scroll-margin-left",
  ],
  "scroll-padding": [
    "scroll-padding-top",
    "scroll-padding-right",
    "scroll-padding-bottom",
    "scroll-padding-left",
  ],
};

const AXIS_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  gap: ["row-gap", "column-gap"],
  overflow: ["overflow-x", "overflow-y"],
  "overscroll-behavior": ["overscroll-behavior-x", "overscroll-behavior-y"],
  "place-content": ["align-content", "justify-content"],
  "place-items": ["align-items", "justify-items"],
  "place-self": ["align-self", "justify-self"],
  "margin-block": ["margin-block-start", "margin-block-end"],
  "margin-inline": ["margin-inline-start", "margin-inline-end"],
  "padding-block": ["padding-block-start", "padding-block-end"],
  "padding-inline": ["padding-inline-start", "padding-inline-end"],
  "inset-block": ["inset-block-start", "inset-block-end"],
  "inset-inline": ["inset-inline-start", "inset-inline-end"],
};

const CORNER_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
};

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

  return canonicalizeCssTokens(output.trim());

  function appendPendingSpace(): void {
    if (
      pendingSpace &&
      output.length > 0 &&
      !TIGHT_BEFORE_NEXT.has(output.at(-1) ?? "")
    ) {
      output += " ";
    }
    pendingSpace = false;
  }
}

/**
 * A stylesheet and a browser spell the same declaration differently: the author
 * writes `#0b57d0` and `0`, the CSSOM hands back `rgb(11, 87, 208)` and `0px`.
 * Both sides of a comparison come through here, so the spelling is settled on a
 * canonical form rather than on either side's habits. Only forms whose meaning
 * is identical are folded together -- `0%` is left alone, because it is not the
 * same value as `0px`.
 */
function canonicalizeCssTokens(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '"' || character === "'") {
      const end = closingQuote(value, index);
      output += canonicalizeQuotedText(value.slice(index, end));
      index = end;
      continue;
    }
    if (startsFunction(value, index, "url")) {
      const end = closingParenthesis(value, index + 3);
      output += value.slice(index, end);
      index = end;
      continue;
    }
    const colorFunction = startsFunction(value, index, "rgba")
      ? 4
      : startsFunction(value, index, "rgb")
      ? 3
      : 0;
    if (colorFunction) {
      const end = closingParenthesis(value, index + colorFunction);
      const canonical = canonicalizeColorFunction(
        value.slice(index + colorFunction + 1, end - 1),
      );
      if (canonical) {
        output += canonical;
        index = end;
        continue;
      }
    }
    if (character === "#") {
      const hex = readHexColor(value, index);
      if (hex) {
        output += hex.text;
        index = hex.end;
        continue;
      }
    }
    const numeric = readNumeric(value, index);
    if (numeric) {
      output += numeric.text;
      index = numeric.end;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * A preprocessor settles on double quotes when it writes CSS out, so the same
 * font name reads as `'x'` in the source and `"x"` in the generated file. Text
 * that would have to be escaped to change quotes is left exactly as written.
 */
function canonicalizeQuotedText(text: string): string {
  if (text.length < 2 || text[0] !== "'" || text.at(-1) !== "'") return text;
  const body = text.slice(1, -1);
  return body.includes('"') || body.includes("\\") ? text : `"${body}"`;
}

function closingQuote(value: string, start: number): number {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (character === quote) break;
  }
  return index;
}

function startsFunction(value: string, start: number, name: string): boolean {
  return value.slice(start, start + name.length).toLowerCase() === name &&
    value[start + name.length] === "(" &&
    !isIdentifierCharacter(value[start - 1] ?? "");
}

/** One past the parenthesis that closes the one at `open`. */
function closingParenthesis(value: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < value.length) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = closingQuote(value, index);
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return value.length;
}

function isIdentifierCharacter(character: string): boolean {
  return /[A-Za-z0-9_-]/.test(character);
}

function canonicalizeColorFunction(body: string): string | undefined {
  const parts = body.split("/");
  if (parts.length > 2) return undefined;
  const channels = parts[0]!.split(/[\s,]+/).filter(Boolean);
  if (channels.length < 3 || channels.length > 4) return undefined;
  const alphaSource = parts[1]?.trim() ?? channels[3];
  const rgb = channels.slice(0, 3).map((channel) => colorChannel(channel));
  if (rgb.some((channel) => channel === undefined)) return undefined;
  const alpha = alphaSource === undefined ? 1 : alphaChannel(alphaSource);
  if (alpha === undefined) return undefined;
  return formatColor(rgb as number[], alpha);
}

function colorChannel(channel: string): number | undefined {
  const percent = channel.endsWith("%");
  const numeric = Number.parseFloat(percent ? channel.slice(0, -1) : channel);
  if (!Number.isFinite(numeric)) return undefined;
  return clampChannel(percent ? (numeric * 255) / 100 : numeric);
}

function alphaChannel(channel: string): number | undefined {
  const percent = channel.endsWith("%");
  const numeric = Number.parseFloat(percent ? channel.slice(0, -1) : channel);
  if (!Number.isFinite(numeric)) return undefined;
  const alpha = percent ? numeric / 100 : numeric;
  return Math.min(1, Math.max(0, alpha));
}

function clampChannel(channel: number): number {
  return Math.min(255, Math.max(0, Math.round(channel)));
}

function readHexColor(
  value: string,
  start: number,
): { readonly text: string; readonly end: number } | undefined {
  let end = start + 1;
  while (end < value.length && /[0-9a-fA-F]/.test(value[end]!)) end += 1;
  const digits = value.slice(start + 1, end);
  if (![3, 4, 6, 8].includes(digits.length)) return undefined;
  if (isIdentifierCharacter(value[end] ?? "")) return undefined;
  const wide = digits.length >= 6;
  const pair = (position: number): number => Number.parseInt(
    wide
      ? digits.slice(position * 2, position * 2 + 2)
      : digits[position]!.repeat(2),
    16,
  );
  const channels = [pair(0), pair(1), pair(2)];
  const hasAlpha = digits.length === 4 || digits.length === 8;
  const alpha = hasAlpha ? pair(3) / 255 : 1;
  return { text: formatColor(channels, alpha), end };
}

function formatColor(channels: readonly number[], alpha: number): string {
  const body = channels.join(", ");
  return alpha >= 1
    ? `rgb(${body})`
    : `rgba(${body}, ${formatNumber(Math.round(alpha * 1000) / 1000)})`;
}

const ZERO_LENGTH_UNITS = new Set([
  "px",
  "em",
  "rem",
  "ex",
  "ch",
  "cm",
  "mm",
  "in",
  "pt",
  "pc",
  "q",
  "vw",
  "vh",
  "vmin",
  "vmax",
]);

function readNumeric(
  value: string,
  start: number,
): { readonly text: string; readonly end: number } | undefined {
  if (isIdentifierCharacter(value[start - 1] ?? "")) return undefined;
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(value.slice(start));
  if (!match) return undefined;
  let end = start + match[0].length;
  let unit = "";
  while (end < value.length && /[A-Za-z%]/.test(value[end]!)) {
    unit += value[end];
    end += 1;
  }
  const numeric = Number.parseFloat(match[0]);
  if (!Number.isFinite(numeric)) return undefined;
  // A zero length is a zero however it is spelled; a zero percentage is not.
  if (numeric === 0 && ZERO_LENGTH_UNITS.has(unit.toLowerCase())) {
    return { text: "0", end };
  }
  return { text: `${formatNumber(numeric)}${unit}`, end };
}

function formatNumber(numeric: number): string {
  return Object.is(numeric, -0) ? "0" : String(numeric);
}

/** Box shorthands: one value stands for four sides, or two for the two axes. */
const FOUR_SIDED_PROPERTIES = new Set([
  "margin",
  "padding",
  "inset",
  "border-width",
  "border-style",
  "border-color",
  "border-image-width",
  "border-image-outset",
  "scroll-margin",
  "scroll-padding",
]);

const TWO_SIDED_PROPERTIES = new Set([
  "gap",
  "overflow",
  "overscroll-behavior",
  "place-content",
  "place-items",
  "place-self",
  "margin-block",
  "margin-inline",
  "padding-block",
  "padding-inline",
  "inset-block",
  "inset-inline",
  "scroll-margin-block",
  "scroll-margin-inline",
  "scroll-padding-block",
  "scroll-padding-inline",
]);

const SLASHED_SIDES_PROPERTIES = new Set([
  "border-radius",
  "border-image-slice",
]);

/**
 * `padding: 2em 0` and `padding: 2em 0 2em 0` are the same four sides: a
 * stylesheet tends to write every side out, while the browser hands back the
 * shortest spelling. Both are read here as the sides they set.
 */
function canonicalizeSidesValue(property: string, value: string): string {
  if (PROPERTY_NAMING_VALUES.has(property)) {
    return canonicalizePropertyNamingValue(value);
  }
  if (SHADOW_PROPERTIES.has(property)) return canonicalizeShadowValue(value);
  if (SLASHED_SIDES_PROPERTIES.has(property)) {
    const groups = splitTopLevel(value, "/");
    return groups.length <= 2
      ? groups.map((group) => expandSides(group, 4) ?? group).join("/")
      : value;
  }
  const sides = FOUR_SIDED_PROPERTIES.has(property)
    ? 4
    : TWO_SIDED_PROPERTIES.has(property)
    ? 2
    : 0;
  return sides === 0 ? value : expandSides(value, sides) ?? value;
}

/** Values that name other properties, which browsers report in their own terms. */
const PROPERTY_NAMING_VALUES = new Set([
  "transition",
  "transition-property",
  "will-change",
]);

const VENDOR_PREFIXED_IDENT = /^-(?:webkit|moz|ms|o)-([a-z][a-z0-9-]*)$/;
const TIME_VALUE = /^-?(?:\d+|\d*\.\d+)m?s$/;

/**
 * Reads a value that names properties the way the browser reports it: each
 * browser answers with the property names it knows -- Firefox reads
 * `-moz-transform` as `transform` -- and it leaves out a delay of `0s` it never
 * has to write. Both sides are read the same way, so the same declaration
 * matches whichever browser reported it.
 */
function canonicalizePropertyNamingValue(value: string): string {
  return splitTopLevel(value, ",")
    .map((layer) => {
      const tokens = splitTopLevel(layer, " ").map((token) => {
        const prefixed = VENDOR_PREFIXED_IDENT.exec(token);
        return prefixed ? prefixed[1]! : token;
      });
      const times = tokens.filter((token) => TIME_VALUE.test(token));
      const last = tokens.at(-1);
      return times.length >= 2 && last === "0s"
        ? tokens.slice(0, -1).join(" ")
        : tokens.join(" ");
    })
    .join(",");
}

const SHADOW_PROPERTIES = new Set(["box-shadow", "text-shadow"]);
const SHADOW_LENGTH = /^[+-]?(?:\d|\.\d)|^(?:calc|min|max|clamp)\(/;

/**
 * A shadow names its colour wherever the author liked; the browser always
 * serializes it first. Each layer is read here as the colour it uses and the
 * lengths it offsets by, in one settled order.
 */
function canonicalizeShadowValue(value: string): string {
  const layers = splitTopLevel(value, ",");
  const canonical: string[] = [];
  for (const layer of layers) {
    const tokens = splitTopLevel(layer, " ");
    const lengths: string[] = [];
    const colors: string[] = [];
    let inset = false;
    for (const token of tokens) {
      if (token.toLowerCase() === "inset") inset = true;
      else if (SHADOW_LENGTH.test(token)) lengths.push(token);
      else colors.push(token);
    }
    if (colors.length > 1 || lengths.length < 2 || lengths.length > 4) {
      return value;
    }
    canonical.push([
      ...(inset ? ["inset"] : []),
      ...lengths,
      ...colors,
    ].join(" "));
  }
  return canonical.join(",");
}

function expandSides(value: string, sides: 2 | 4): string | undefined {
  const parts = splitTopLevel(value, " ");
  if (parts.length < 1 || parts.length > sides) return undefined;
  if (parts.some((part) => part.includes(","))) return undefined;
  const [first, second, third, fourth] = parts;
  if (sides === 2) {
    return `${first} ${second ?? first}`;
  }
  return [
    first,
    second ?? first,
    third ?? first,
    fourth ?? second ?? first,
  ].join(" ");
}

/** Splits on a separator that sits outside quotes and parentheses. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === separator && depth === 0) {
      if (current !== "") parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") parts.push(current);
  return parts;
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
