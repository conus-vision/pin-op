import { INSPECT_LIMITS } from "@pin-op/protocol";

/** One longhand of a rule, already read from the CSSOM by the caller. */
export interface LonghandDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

export interface AuthoredLonghand {
  readonly property: string;
  readonly value: string;
}

/**
 * One declaration as the rule spells it. A stylesheet that says `margin: 0`
 * holds four longhands in the CSSOM; presenting the four is both unlike every
 * other inspector and unlike the file the declaration came from, so the
 * shorthand is presented and its longhands ride along for the cascade.
 */
export interface AuthoredDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly longhands: readonly AuthoredLonghand[];
}

/**
 * Answers which longhands a shorthand covers. Only the browser knows the true
 * expansion -- `border` also resets `border-image-*` -- so the answer is asked
 * of the browser rather than kept as a table here.
 */
export type ShorthandExpander = (
  property: string,
  value: string,
) => readonly string[] | undefined;

export interface ParsedDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/i;
const MAX_RULE_TEXT_LENGTH = INSPECT_LIMITS.declarationsPerRule *
  (INSPECT_LIMITS.propertyNameLength + INSPECT_LIMITS.valueLength);

/**
 * Rebuilds the rule's own declaration list from its serialized text, keeping
 * every longhand accounted for. Returns `undefined` whenever the text and the
 * CSSOM cannot be reconciled exactly: the caller then presents the longhands,
 * which is always faithful even when it is verbose.
 */
export function readAuthoredDeclarations(
  cssText: string,
  longhands: readonly LonghandDeclaration[],
  expand?: ShorthandExpander,
): readonly AuthoredDeclaration[] | undefined {
  if (cssText.length > MAX_RULE_TEXT_LENGTH) return undefined;
  const parsed = parseDeclarationList(cssText);
  if (!parsed || parsed.length === 0) return undefined;

  const byProperty = new Map<string, LonghandDeclaration>();
  for (const longhand of longhands) {
    if (byProperty.has(longhand.property)) return undefined;
    byProperty.set(longhand.property, longhand);
  }
  if (byProperty.size === 0) return undefined;

  const claimed = new Set<string>();
  const declarations: AuthoredDeclaration[] = [];
  for (const entry of parsed) {
    const members = coveredLonghands(entry, byProperty, expand);
    if (!members) return undefined;
    const covered: AuthoredLonghand[] = [];
    for (const property of members) {
      const longhand = byProperty.get(property);
      if (
        !longhand ||
        claimed.has(property) ||
        longhand.important !== entry.important
      ) {
        return undefined;
      }
      claimed.add(property);
      covered.push({ property, value: longhand.value });
    }
    declarations.push({
      property: entry.property,
      value: entry.value,
      important: entry.important,
      longhands: covered,
    });
  }
  // Every longhand the CSSOM holds must belong to exactly one presented
  // declaration, or the presentation would quietly drop part of the rule.
  return claimed.size === byProperty.size ? declarations : undefined;
}

/** Splits a serialized declaration block; `undefined` when it is not one. */
export function parseDeclarationList(
  cssText: string,
): readonly ParsedDeclaration[] | undefined {
  const declarations: ParsedDeclaration[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;

  for (let index = 0; index <= cssText.length; index += 1) {
    const character = index < cssText.length ? cssText[index]! : ";";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) return undefined;
      depth -= 1;
      continue;
    }
    if (character !== ";" || depth > 0) continue;

    const chunk = cssText.slice(start, index);
    start = index + 1;
    if (chunk.trim() === "") continue;
    const declaration = parseDeclaration(chunk);
    if (!declaration) return undefined;
    if (declarations.length >= INSPECT_LIMITS.declarationsPerRule) {
      return undefined;
    }
    declarations.push(declaration);
  }

  return quote || depth > 0 ? undefined : declarations;
}

/**
 * Expands shorthands through a detached element, so the answer is the browser's
 * own parser rather than a table that would drift from it.
 */
export function createShorthandExpander(
  documentSource: object,
): ShorthandExpander | undefined {
  const scratch = scratchStyle(documentSource);
  if (!scratch) return undefined;
  const cache = new Map<string, readonly string[] | undefined>();

  return (property, value) => {
    const key = `${property}|${value}`;
    if (cache.has(key)) return cache.get(key);
    const expansion = cache.size < INSPECT_LIMITS.cssRules
      ? expandOnce(scratch, property, value)
      : undefined;
    cache.set(key, expansion);
    return expansion;
  };
}

interface ScratchStyle {
  readonly length: number;
  cssText: string;
  item(index: number): string;
  setProperty(property: string, value: string): void;
}

function scratchStyle(documentSource: object): ScratchStyle | undefined {
  try {
    const factory = (documentSource as {
      createElement?: (name: string) => { style?: unknown };
    }).createElement;
    if (typeof factory !== "function") return undefined;
    const style = factory.call(documentSource, "span")?.style;
    if (!style || typeof style !== "object") return undefined;
    const candidate = style as Partial<ScratchStyle>;
    if (
      typeof candidate.item !== "function" ||
      typeof candidate.setProperty !== "function" ||
      typeof candidate.length !== "number"
    ) {
      return undefined;
    }
    return style as ScratchStyle;
  } catch {
    return undefined;
  }
}

function expandOnce(
  scratch: ScratchStyle,
  property: string,
  value: string,
): readonly string[] | undefined {
  try {
    scratch.cssText = "";
    scratch.setProperty(property, value);
    const count = scratch.length;
    if (
      typeof count !== "number" ||
      count < 1 ||
      count > INSPECT_LIMITS.declarationsPerRule
    ) {
      return undefined;
    }
    const expansion: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = scratch.item(index);
      if (typeof name !== "string" || name === "") return undefined;
      expansion.push(name);
    }
    scratch.cssText = "";
    // A property that expands to itself is a longhand, not a shorthand.
    return expansion.length === 1 && expansion[0] === property
      ? undefined
      : expansion;
  } catch {
    return undefined;
  }
}

function coveredLonghands(
  entry: ParsedDeclaration,
  byProperty: ReadonlyMap<string, LonghandDeclaration>,
  expand?: ShorthandExpander,
): readonly string[] | undefined {
  if (byProperty.has(entry.property)) return [entry.property];
  if (!expand) return undefined;
  let expansion: readonly string[] | undefined;
  try {
    expansion = expand(entry.property, entry.value);
  } catch {
    return undefined;
  }
  return expansion && expansion.length > 0 ? expansion : undefined;
}

function parseDeclaration(chunk: string): ParsedDeclaration | undefined {
  const separator = topLevelColon(chunk);
  if (separator === undefined) return undefined;
  const property = chunk.slice(0, separator).trim();
  if (property === "" || property.length > INSPECT_LIMITS.propertyNameLength) {
    return undefined;
  }
  const remainder = chunk.slice(separator + 1).trim();
  const important = IMPORTANT_SUFFIX.test(remainder);
  const value = important
    ? remainder.replace(IMPORTANT_SUFFIX, "").trim()
    : remainder;
  return value === "" ? undefined : { property, value, important };
}

function topLevelColon(chunk: string): number | undefined {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    const character = chunk[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === ":" && depth === 0) return index;
  }
  return undefined;
}
