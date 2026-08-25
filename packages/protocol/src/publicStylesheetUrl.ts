import { z } from "zod";
import { RULE_EVIDENCE_LIMITS } from "./limits.js";

const FORBIDDEN_PUBLIC_TEXT =
  /[\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const RAW_POSIX_STYLESHEET_PATH =
  /^\/(?:applications|bin|boot|dev|etc|home|lib(?:64)?|media|mnt|opt|private|proc|root|run|sbin|srv|sys|tmp|users?|usr|var|workspace)(?:\/|$)/iu;
const URL_SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:/iu;

export interface PublicStylesheetUrlOptions {
  readonly baseUrl?: string;
  readonly maxLength?: number;
}

/**
 * Resolves browser-local relative stylesheet references without normalizing
 * hostile absolute authority into a value that could cross a trust boundary.
 */
export function canonicalizePublicStylesheetUrl(
  value: string,
  options: PublicStylesheetUrlOptions = {},
): string | undefined {
  const maximum = options.maxLength ?? RULE_EVIDENCE_LIMITS.sourceUrlLength;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    value.length < 1 ||
    value.length > maximum ||
    FORBIDDEN_PUBLIC_TEXT.test(value) ||
    value.includes("#") ||
    value.startsWith("//") ||
    RAW_POSIX_STYLESHEET_PATH.test(value) ||
    /^~(?:[\\/]|$)/u.test(value) ||
    /^[a-z]:[\\/]/iu.test(value)
  ) {
    return undefined;
  }

  const absoluteInput = URL_SCHEME_PREFIX.test(value);
  if (!absoluteInput && !options.baseUrl) return undefined;

  let parsed: URL;
  try {
    parsed = absoluteInput
      ? new URL(value)
      : new URL(value, options.baseUrl);
  } catch {
    return undefined;
  }

  if (
    parsed.href.length > maximum ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (absoluteInput && parsed.href !== value)
  ) {
    return undefined;
  }

  let decodedPathAndQuery: string;
  try {
    const queryWithLiteralPercentsEscaped = parsed.search.replace(
      /%(?![\da-f]{2})/giu,
      "%25",
    );
    decodedPathAndQuery = `${decodeURIComponent(parsed.pathname)}${
      decodeURIComponent(queryWithLiteralPercentsEscaped)
    }`;
  } catch {
    return undefined;
  }
  if (FORBIDDEN_PUBLIC_TEXT.test(decodedPathAndQuery)) return undefined;

  return parsed.href;
}

export const PublicStylesheetUrlSchema = z
  .string()
  .min(1)
  .max(RULE_EVIDENCE_LIMITS.sourceUrlLength)
  .superRefine((value, context) => {
    if (canonicalizePublicStylesheetUrl(value) !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stylesheet URL must be canonical public HTTP(S)",
      });
    }
  });
