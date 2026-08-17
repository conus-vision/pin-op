import {
  RESOLUTION_LIMITS,
  type SourceExcerpt,
} from "@pin-op/protocol";

const SOURCE_KINDS: ReadonlySet<string> = new Set([
  "component",
  "fixture",
  "rule",
  "source",
  "style-rule",
] as const satisfies readonly SourceExcerpt["kind"][]);
const SOURCE_RELATIONS: ReadonlySet<string> = new Set([
  "applies",
  "contains",
  "declared-in",
  "matches",
  "parent",
  "renders",
  "selected",
  "styles",
] as const satisfies readonly SourceExcerpt["relation"][]);
const DISPLAY_PUNCTUATION: ReadonlySet<string> = new Set(
  " !\"#$&'()*+,-.:<=>@[]^_|~",
);
const LANGUAGE_ID_PUNCTUATION: ReadonlySet<string> = new Set("+-._");
const SOURCE_LOCATOR_SUFFIX = /:\d+(?::\d+)?$/u;
const PARENTHESIZED_SOURCE_LOCATOR_SUFFIX = /\.[a-z0-9]+\(\d+(?:,\d+)?\)$/iu;
const FRAGMENT_SOURCE_LOCATOR_SUFFIX = /\.[a-z0-9]+#L\d+(?:C\d+)?$/iu;
const UNICODE_DISPLAY_CHARACTER = /^[\p{L}\p{M}\p{N}]$/u;

export function normalizeSourceKind(value: unknown): SourceExcerpt["kind"] {
  return typeof value === "string" && SOURCE_KINDS.has(value)
    ? value as SourceExcerpt["kind"]
    : "source";
}

export function normalizeSourceRelation(
  value: unknown,
): SourceExcerpt["relation"] {
  return typeof value === "string" && SOURCE_RELATIONS.has(value)
    ? value as SourceExcerpt["relation"]
    : "matches";
}

export function normalizeSourceDisplayLabel(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  const cleaned = cleanText(value);
  if (!isNeutralDisplayLabel(cleaned)) return fallback;
  return boundUtf16(cleaned, RESOLUTION_LIMITS.labelLength) || fallback;
}

export function sourceDocumentLabel(documentUri: unknown): string {
  if (typeof documentUri !== "string") return "untitled";
  try {
    const parsed = new URL(documentUri);
    const encodedSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!encodedSegment) return "untitled";
    const decodedSegment = decodeURIComponent(encodedSegment);
    const candidate = basename(decodedSegment);
    return normalizeSourceDisplayLabel(candidate, "untitled");
  } catch {
    return "untitled";
  }
}

export function normalizeLanguageId(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const cleaned = cleanText(value);
  if (
    cleaned.length === 0 ||
    [...cleaned].some((character) => !isLanguageIdCharacter(character))
  ) {
    return "unknown";
  }
  return boundUtf16(cleaned, RESOLUTION_LIMITS.languageIdLength) || "unknown";
}

function isNeutralDisplayLabel(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    SOURCE_LOCATOR_SUFFIX.test(value) ||
    PARENTHESIZED_SOURCE_LOCATOR_SUFFIX.test(value) ||
    FRAGMENT_SOURCE_LOCATOR_SUFFIX.test(value) ||
    isStructuredLocator(value) ||
    isAbsoluteUri(value)
  ) {
    return false;
  }
  return [...value].every(isDisplayCharacter);
}

function isStructuredLocator(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 0;
  } catch {
    return false;
  }
}

function isDisplayCharacter(character: string): boolean {
  return isAsciiLetterOrDigit(character) ||
    DISPLAY_PUNCTUATION.has(character) ||
    UNICODE_DISPLAY_CHARACTER.test(character);
}

function isLanguageIdCharacter(character: string): boolean {
  return isAsciiLetterOrDigit(character) ||
    LANGUAGE_ID_PUNCTUATION.has(character);
}

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a);
}

function cleanText(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("").trim();
}

function boundUtf16(value: string, limit: number): string {
  let bounded = value.slice(0, limit);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded;
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "untitled";
}
