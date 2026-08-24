import { utf8ByteLength } from "@pin-op/protocol";
import {
  STYLESHEET_LIMITS,
  readStylesheetOwnerState,
  type StylesheetOwnerState,
  type StylesheetRegistryEntry,
} from "./stylesheetRegistry.js";

export interface StylesheetFingerprintCursor {
  readonly sheetIndex: number;
  readonly ruleOffset: number;
  readonly cssTextByteOffset?: number;
}

export interface StylesheetFingerprintResult {
  readonly digest: string;
  readonly changed: boolean;
  readonly partial: boolean;
  readonly rulesVisited: number;
  readonly bytesRead: number;
  readonly uniqueSheetObjectsScanned: number;
  readonly inaccessibleSheetCount: number;
  readonly nextCursor: StylesheetFingerprintCursor;
}

export interface StylesheetFingerprintOptions {
  readonly now?: () => number;
}

interface SheetCache {
  metadata?: string;
  full?: string;
  readonly windows: Map<string, string>;
}

interface FlatRule {
  readonly rule: object;
  readonly index: number;
}

/**
 * Stateful bounded fingerprint scanner. Shared sheet objects are scanned once
 * per pass while adoption/order/owner state remains distinct for every root.
 */
export class StylesheetFingerprint {
  private readonly now: () => number;
  private cache = new WeakMap<object, SheetCache>();
  private cursor: StylesheetFingerprintCursor = Object.freeze({
    sheetIndex: 0,
    ruleOffset: 0,
  });
  private inventoryDigest: string | undefined;
  private initialized = false;

  public constructor(options: StylesheetFingerprintOptions = {}) {
    this.now = options.now ?? defaultNow;
  }

  public scan(
    entries: readonly StylesheetRegistryEntry[],
  ): StylesheetFingerprintResult {
    const startedAt = safeNow(this.now);
    const unique = uniqueSheets(entries);
    const inventoryDigest = digestStrings(entries.map(entryDigest));
    let semanticChange = this.initialized &&
      this.inventoryDigest !== inventoryDigest;
    this.inventoryDigest = inventoryDigest;

    if (unique.length === 0) {
      this.cursor = Object.freeze({ sheetIndex: 0, ruleOffset: 0 });
      const digest = digestStrings([inventoryDigest]);
      const result = freezeResult({
        digest,
        changed: semanticChange,
        partial: false,
        rulesVisited: 0,
        bytesRead: 0,
        uniqueSheetObjectsScanned: 0,
        inaccessibleSheetCount: 0,
        nextCursor: this.cursor,
      });
      this.initialized = true;
      return result;
    }

    const startSheet = this.cursor.sheetIndex % unique.length;
    let sheetIndex = startSheet;
    let ruleOffset = this.cursor.ruleOffset;
    let cssTextByteOffset = this.cursor.cssTextByteOffset ?? 0;
    let rulesVisited = 0;
    let bytesRead = 0;
    let uniqueSheetObjectsScanned = 0;
    let inaccessibleSheetCount = 0;
    let partial = false;
    let completedSheets = 0;

    while (completedSheets < unique.length) {
      if (
        completedSheets > 0 &&
        elapsedMs(startedAt, safeNow(this.now)) >
          STYLESHEET_LIMITS.fingerprintTimeBudgetMs
      ) {
        partial = true;
        break;
      }
      const current = unique[sheetIndex]!;
      const sheet = current.sheet as unknown as object;
      const cache: SheetCache = this.cache.get(sheet) ?? {
        windows: new Map<string, string>(),
      };
      this.cache.set(sheet, cache);
      uniqueSheetObjectsScanned += 1;

      const metadata = sheetMetadataDigest(sheet);
      if (this.initialized && cache.metadata !== undefined && cache.metadata !== metadata) {
        semanticChange = true;
      }
      cache.metadata = metadata;

      let flat: FlatRule[];
      try {
        flat = flattenRules(
          sheet,
          ruleOffset + STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot + 1,
        );
      } catch {
        inaccessibleSheetCount += 1;
        partial = true;
        const inaccessibleDigest = digestStrings([metadata, "inaccessible"]);
        if (
          this.initialized &&
          cache.full !== undefined &&
          cache.full !== inaccessibleDigest
        ) {
          semanticChange = true;
        }
        cache.full = inaccessibleDigest;
        completedSheets += 1;
        sheetIndex = (sheetIndex + 1) % unique.length;
        ruleOffset = 0;
        cssTextByteOffset = 0;
        continue;
      }

      if (ruleOffset > flat.length) ruleOffset = 0;
      const windowStart = ruleOffset;
      const textStart = cssTextByteOffset;
      const parts: string[] = [metadata, `${windowStart}:${textStart}`];
      let truncatedHere = false;
      while (ruleOffset < flat.length) {
        if (
          rulesVisited >= STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot ||
          bytesRead >= STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass
        ) {
          truncatedHere = true;
          break;
        }
        const { rule, index } = flat[ruleOffset]!;
        const cssText = safeStringProperty(rule, "cssText") ?? "";
        const remainingText = sliceUtf8From(cssText, cssTextByteOffset);
        const remainingBudget =
          STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass - bytesRead;
        const bounded = takeUtf8Prefix(remainingText, remainingBudget);
        parts.push(`${index}:${bounded.text}`);
        bytesRead += bounded.bytes;
        if (bounded.truncated) {
          cssTextByteOffset += bounded.bytes;
          truncatedHere = true;
          break;
        }
        rulesVisited += 1;
        ruleOffset += 1;
        cssTextByteOffset = 0;
        if (
          rulesVisited % 32 === 0 &&
          elapsedMs(startedAt, safeNow(this.now)) >
            STYLESHEET_LIMITS.fingerprintTimeBudgetMs
        ) {
          truncatedHere = true;
          break;
        }
      }

      const windowKey = `${windowStart}:${textStart}`;
      const windowDigest = digestStrings(parts);
      const previousWindow = cache.windows.get(windowKey);
      if (
        this.initialized &&
        previousWindow !== undefined &&
        previousWindow !== windowDigest
      ) {
        semanticChange = true;
      }
      cache.windows.set(windowKey, windowDigest);

      if (truncatedHere) {
        partial = true;
        break;
      }

      const completedDigest = digestStrings([
        metadata,
        ...[...cache.windows.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}:${value}`),
      ]);
      if (
        this.initialized &&
        cache.full !== undefined &&
        cache.full !== completedDigest
      ) {
        semanticChange = true;
      }
      cache.full = completedDigest;
      completedSheets += 1;
      sheetIndex = (sheetIndex + 1) % unique.length;
      ruleOffset = 0;
      cssTextByteOffset = 0;
    }

    const nextCursor: StylesheetFingerprintCursor = Object.freeze({
      sheetIndex,
      ruleOffset,
      ...(cssTextByteOffset > 0 ? { cssTextByteOffset } : {}),
    });
    this.cursor = partial
      ? nextCursor
      : Object.freeze({ sheetIndex: startSheet, ruleOffset: 0 });
    const digest = digestStrings([
      inventoryDigest,
      ...unique.map(({ sheet }) => {
        const current = this.cache.get(sheet as unknown as object);
        return digestStrings([
          current?.metadata ?? "",
          current?.full ?? "",
          ...[...(current?.windows ?? new Map()).entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}:${value}`),
        ]);
      }),
    ]);
    const result = freezeResult({
      digest,
      changed: semanticChange,
      partial,
      rulesVisited,
      bytesRead,
      uniqueSheetObjectsScanned,
      inaccessibleSheetCount,
      nextCursor: this.cursor,
    });
    this.initialized = true;
    return result;
  }

  public reset(): void {
    this.cache = new WeakMap();
    this.cursor = Object.freeze({ sheetIndex: 0, ruleOffset: 0 });
    this.inventoryDigest = undefined;
    this.initialized = false;
  }
}

function uniqueSheets(entries: readonly StylesheetRegistryEntry[]): Array<{
  readonly sheet: CSSStyleSheet;
}> {
  const seen = new Set<object>();
  const result: Array<{ readonly sheet: CSSStyleSheet }> = [];
  for (const entry of entries) {
    const sheet = entry.sheet as unknown as object;
    if (typeof sheet !== "object" || sheet === null || seen.has(sheet)) continue;
    seen.add(sheet);
    result.push({ sheet: entry.sheet });
  }
  return result;
}

function entryDigest(entry: StylesheetRegistryEntry): string {
  return [
    entry.scopeRef,
    entry.sheetRef,
    entry.sheetIdentity,
    entry.kind,
    String(entry.sourceOrder),
    entry.sourceUrl ?? "",
    entry.rulePathPrefix,
    ownerStateDigest(
      entry.owner
        ? readStylesheetOwnerState(entry.owner)
        : entry.ownerState,
    ),
  ].join("\u001f");
}

function ownerStateDigest(state: StylesheetOwnerState | undefined): string {
  if (!state) return "";
  return [
    state.media,
    state.disabled ? "1" : "0",
    state.rel,
    state.href,
    state.title,
    state.alternate ? "1" : "0",
  ].join("\u001e");
}

function sheetMetadataDigest(sheet: object): string {
  return digestStrings([
    safeStringProperty(sheet, "href") ?? "",
    safeBooleanProperty(sheet, "disabled") ? "disabled" : "enabled",
    safeNestedStringProperty(sheet, "media", "mediaText") ?? "",
  ]);
}

function flattenRules(sheet: object, maximum: number): FlatRule[] {
  const root = readRuleList(sheet, maximum);
  const result: FlatRule[] = [];
  const active = new Set<object>();
  const visit = (rules: readonly object[]): void => {
    for (const rule of rules) {
      if (result.length >= maximum) return;
      const index = result.length;
      result.push({ rule, index });
      if (active.has(rule)) continue;
      let nested: readonly object[] | undefined;
      try {
        nested = readOptionalRuleList(rule, maximum - result.length);
      } catch {
        throw new Error("nested rules inaccessible");
      }
      if (!nested) continue;
      active.add(rule);
      visit(nested);
      active.delete(rule);
    }
  };
  visit(root);
  return result;
}

function readRuleList(value: object, maximum: number): readonly object[] {
  const raw = (value as { readonly cssRules?: unknown }).cssRules;
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules inaccessible");
  }
  return boundedObjects(
    raw as ArrayLike<unknown> | Iterable<unknown>,
    maximum,
  );
}

function readOptionalRuleList(
  value: object,
  maximum: number,
): readonly object[] | undefined {
  if (!("cssRules" in value)) return undefined;
  const raw = (value as { readonly cssRules?: unknown }).cssRules;
  if (raw === undefined) return undefined;
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules inaccessible");
  }
  return boundedObjects(
    raw as ArrayLike<unknown> | Iterable<unknown>,
    maximum,
  );
}

function boundedObjects(
  values: ArrayLike<unknown> | Iterable<unknown>,
  maximum: number,
): object[] {
  const result: object[] = [];
  if (Symbol.iterator in Object(values)) {
    for (const value of values as Iterable<unknown>) {
      if (typeof value === "object" && value !== null) result.push(value);
      if (result.length >= maximum) break;
    }
    return result;
  }
  const length = Math.min(
    safeLength((values as ArrayLike<unknown>).length),
    maximum,
  );
  for (let index = 0; index < length; index += 1) {
    const value = (values as ArrayLike<unknown>)[index];
    if (typeof value === "object" && value !== null) result.push(value);
  }
  return result;
}

function safeLength(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeStringProperty(value: object, key: PropertyKey): string | undefined {
  try {
    const candidate = (value as Record<PropertyKey, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function safeBooleanProperty(value: object, key: PropertyKey): boolean {
  try {
    return (value as Record<PropertyKey, unknown>)[key] === true;
  } catch {
    return false;
  }
}

function safeNestedStringProperty(
  value: object,
  key: PropertyKey,
  nestedKey: PropertyKey,
): string | undefined {
  try {
    const nested = (value as Record<PropertyKey, unknown>)[key];
    return typeof nested === "object" && nested !== null
      ? safeStringProperty(nested, nestedKey)
      : undefined;
  } catch {
    return undefined;
  }
}

function takeUtf8Prefix(value: string, budget: number): {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} {
  if (budget <= 0) return { text: "", bytes: 0, truncated: value.length > 0 };
  const total = utf8ByteLength(value);
  if (total <= budget) return { text: value, bytes: total, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = utf8ByteLength(character);
    if (bytes + size > budget) break;
    text += character;
    bytes += size;
  }
  return { text, bytes, truncated: true };
}

function sliceUtf8From(value: string, byteOffset: number): string {
  if (byteOffset <= 0) return value;
  let seen = 0;
  let index = 0;
  for (const character of value) {
    if (seen >= byteOffset) break;
    seen += utf8ByteLength(character);
    index += character.length;
  }
  return value.slice(index);
}

function digestStrings(values: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function elapsedMs(start: number, current: number): number {
  return Math.max(0, current - start);
}

function defaultNow(): number {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function freezeResult(result: StylesheetFingerprintResult): StylesheetFingerprintResult {
  return Object.freeze({ ...result, nextCursor: Object.freeze({ ...result.nextCursor }) });
}
