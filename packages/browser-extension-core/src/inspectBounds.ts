import {
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  utf8ByteLength,
} from "@pin-op/protocol";

const INSPECT_ENVELOPE_RESERVE_BYTES = 256 * 1024;
const URL_VALIDATION_BASE = "https://pin-op.invalid/";

export const INSPECT_COLLECTION_MAX_BYTES =
  INSPECT_ENVELOPE_MAX_BYTES - INSPECT_ENVELOPE_RESERVE_BYTES;

export interface InspectByteBudget {
  remainingBytes: number;
}

export function createInspectByteBudget(): InspectByteBudget {
  return { remainingBytes: INSPECT_COLLECTION_MAX_BYTES };
}

export function consumeJsonBudget(
  budget: InspectByteBudget,
  value: unknown,
): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      budget.remainingBytes = 0;
      return false;
    }
    const bytes = utf8ByteLength(serialized);
    if (bytes > budget.remainingBytes) {
      budget.remainingBytes = 0;
      return false;
    }
    budget.remainingBytes -= bytes;
    return true;
  } catch {
    budget.remainingBytes = 0;
    return false;
  }
}

export function exactBoundedUrl(value: string): string | undefined {
  if (value.length > INSPECT_LIMITS.urlLength) {
    return undefined;
  }
  try {
    const parsed = new URL(value, URL_VALIDATION_BASE);
    decodeURIComponent(parsed.pathname);
    return value;
  } catch {
    return undefined;
  }
}

export function boundedPageUrl(value: string): string {
  const exact = exactBoundedUrl(value);
  if (exact) {
    return exact;
  }

  try {
    const schemeEnd = value.indexOf("://");
    if (schemeEnd <= 0) {
      return "about:blank";
    }
    const authorityStart = schemeEnd + 3;
    const boundaries = ["/", "?", "#"]
      .map((separator) => value.indexOf(separator, authorityStart))
      .filter((index) => index >= 0);
    const authorityEnd =
      boundaries.length > 0 ? Math.min(...boundaries) : value.length;
    if (authorityEnd > INSPECT_LIMITS.urlLength) {
      return "about:blank";
    }
    const parsed = new URL(`${value.slice(0, authorityEnd)}/`);
    const root = parsed.origin === "null" ? "about:blank" : `${parsed.origin}/`;
    return exactBoundedUrl(root) ?? "about:blank";
  } catch {
    return "about:blank";
  }
}

export function takeBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): T[] {
  return [...iterateBounded(source, limit)];
}

export function* iterateBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): IterableIterator<T> {
  if (limit <= 0) {
    return;
  }

  if (isIterable(source)) {
    let count = 0;
    for (const item of source) {
      yield item;
      count += 1;
      if (count >= limit) {
        return;
      }
    }
    return;
  }

  const length = boundedLength(source.length, limit);
  for (let index = 0; index < length; index += 1) {
    yield source[index]!;
  }
}

export function* enumerateBounded<T>(
  source: ArrayLike<T> | Iterable<T>,
  limit: number,
): IterableIterator<readonly [number, T]> {
  let index = 0;
  for (const item of iterateBounded(source, limit)) {
    yield [index, item] as const;
    index += 1;
  }
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function joinBounded(
  values: readonly string[],
  limit: number,
): string {
  let result = "";
  for (const value of values) {
    const remaining = limit - result.length;
    if (remaining <= 0) {
      break;
    }
    result += truncate(value, remaining);
  }
  return result;
}

export function boundedLength(value: number, limit: number): number {
  if (Number.isNaN(value) || value <= 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return limit;
  }
  return Math.min(Math.floor(value), limit);
}

function isIterable<T>(
  source: ArrayLike<T> | Iterable<T>,
): source is Iterable<T> {
  return typeof (source as Partial<Iterable<T>>)[Symbol.iterator] === "function";
}
