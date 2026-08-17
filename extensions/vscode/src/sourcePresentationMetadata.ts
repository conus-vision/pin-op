import { Buffer } from "node:buffer";
import {
  RESOLUTION_LIMITS,
  SOURCE_EXCERPT_KINDS,
  SOURCE_EXCERPT_RELATIONS,
  type SourceExcerpt,
} from "@pin-op/protocol";

const SOURCE_KINDS: ReadonlySet<string> = new Set(SOURCE_EXCERPT_KINDS);
const SOURCE_RELATIONS: ReadonlySet<string> = new Set(
  SOURCE_EXCERPT_RELATIONS,
);
const DISPLAY_PUNCTUATION: ReadonlySet<string> = new Set(
  " !\"#$&'()*+,-.:<=>@[]^_|~",
);
const LANGUAGE_ID_PUNCTUATION: ReadonlySet<string> = new Set("+-._");
const MAX_DISPLAY_INPUT_LENGTH = RESOLUTION_LIMITS.labelLength * 4;
const BASE64_CANDIDATE = /^[A-Za-z0-9+/_-]+={0,2}$/u;
const MIN_BASE64_CANDIDATE_LENGTH = 8;
const SOURCE_LOCATOR_SUFFIX = /:\d+(?::\d+)?$/u;
const PARENTHESIZED_SOURCE_LOCATOR_SUFFIX = /\.[a-z0-9]+\(\d+(?:,\d+)?\)$/iu;
const FRAGMENT_SOURCE_LOCATOR_SUFFIX = /\.[a-z0-9]+#L\d+(?:C\d+)?$/iu;
const SOURCE_MAPPING_URL_DIRECTIVE = /^(?:#\s*)?sourceMappingURL\s*=/iu;
const RELATIVE_SOURCE_MAP_LABEL =
  /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._@()+,'&-]*\.map(?:\s*(?:[?#].*)?)?$/iu;
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
  try {
    if (
      typeof value !== "string" ||
      value.length > MAX_DISPLAY_INPUT_LENGTH
    ) {
      return fallback;
    }
    const cleaned = cleanText(value);
    if (!isNeutralDisplayLabel(cleaned)) return fallback;
    return boundUtf16(cleaned, RESOLUTION_LIMITS.labelLength) || fallback;
  } catch {
    return fallback;
  }
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
    isSensitiveDisplayMetadata(value) ||
    hasEncodedSensitiveMetadata(value)
  ) {
    return false;
  }
  return [...value].every(isDisplayCharacter);
}

function isSensitiveDisplayMetadata(value: string): boolean {
  return value.includes("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    SOURCE_LOCATOR_SUFFIX.test(value) ||
    PARENTHESIZED_SOURCE_LOCATOR_SUFFIX.test(value) ||
    FRAGMENT_SOURCE_LOCATOR_SUFFIX.test(value) ||
    SOURCE_MAPPING_URL_DIRECTIVE.test(value) ||
    RELATIVE_SOURCE_MAP_LABEL.test(value) ||
    isStructuredLocator(value) ||
    isAbsoluteUri(value);
}

function hasEncodedSensitiveMetadata(value: string): boolean {
  const decoded = decodeBase64Candidate(value);
  return decoded !== undefined &&
    isSensitiveDisplayMetadata(cleanText(decoded));
}

function decodeBase64Candidate(value: string): string | undefined {
  if (
    value.length < MIN_BASE64_CANDIDATE_LENGTH ||
    value.length > MAX_DISPLAY_INPUT_LENGTH ||
    !BASE64_CANDIDATE.test(value)
  ) {
    return undefined;
  }

  const hasPadding = value.endsWith("=");
  if (hasPadding && value.length % 4 !== 0) return undefined;
  const unpadded = value.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) return undefined;
  const canonicalInput = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Buffer.from(canonicalInput, "base64");
  if (bytes.length === 0 || bytes.length > MAX_DISPLAY_INPUT_LENGTH) {
    return undefined;
  }
  if (
    bytes.toString("base64").replace(/=+$/u, "") !== canonicalInput
  ) {
    return undefined;
  }

  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
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
