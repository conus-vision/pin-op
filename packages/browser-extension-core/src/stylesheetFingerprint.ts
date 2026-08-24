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
  readonly rulePath?: readonly number[];
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
  readonly pendingWindows: Map<string, string>;
  traversal?: RuleTraversal;
  pendingRule?: TraversedRule;
  cssTextByteOffset: number;
}

interface TraversedRule {
  readonly rule: object;
  readonly path: readonly number[];
  readonly cursorOffset: number;
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
  private readonly activeTraversals = new Set<RuleTraversal>();

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
    let rulesVisited = 0;
    let bytesRead = 0;
    let uniqueSheetObjectsScanned = 0;
    let inaccessibleSheetCount = 0;
    let partial = false;
    let completedSheets = 0;
    const timeExpired = (): boolean => (
      elapsedMs(startedAt, safeNow(this.now)) >
        STYLESHEET_LIMITS.fingerprintTimeBudgetMs
    );

    while (completedSheets < unique.length) {
      if (completedSheets > 0 && timeExpired()) {
        partial = true;
        break;
      }
      const current = unique[sheetIndex]!;
      const sheet = current.sheet as unknown as object;
      const cache: SheetCache = this.cache.get(sheet) ?? {
        windows: new Map<string, string>(),
        pendingWindows: new Map<string, string>(),
        cssTextByteOffset: 0,
      };
      this.cache.set(sheet, cache);
      uniqueSheetObjectsScanned += 1;

      const metadata = sheetMetadataDigest(sheet);
      if (this.initialized && cache.metadata !== undefined && cache.metadata !== metadata) {
        semanticChange = true;
      }
      cache.metadata = metadata;

      if (!cache.traversal) {
        cache.pendingWindows.clear();
        cache.pendingRule = undefined;
        cache.cssTextByteOffset = 0;
        try {
          cache.traversal = new RuleTraversal(sheet);
          this.activeTraversals.add(cache.traversal);
        } catch {
          inaccessibleSheetCount += 1;
          partial = true;
          markInaccessible(cache, metadata, this.initialized, (changed) => {
            semanticChange ||= changed;
          });
          completedSheets += 1;
          sheetIndex = (sheetIndex + 1) % unique.length;
          continue;
        }
      }

      const traversal = cache.traversal;
      let traversalFailed = false;
      let traversalCompleted = false;
      let truncatedHere = false;
      while (true) {
        if (
          rulesVisited >= STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot ||
          bytesRead >= STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass
        ) {
          truncatedHere = true;
          break;
        }

        if (!cache.pendingRule) {
          const advanced = traversal.advance(
            STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - rulesVisited,
            timeExpired,
          );
          rulesVisited += advanced.pulls;
          if (advanced.kind === "rule") {
            cache.pendingRule = advanced.value;
          } else if (advanced.kind === "done") {
            traversalCompleted = true;
            break;
          } else if (advanced.kind === "error") {
            traversalFailed = true;
            break;
          } else {
            truncatedHere = true;
            break;
          }
        }

        const pending = cache.pendingRule;
        if (!pending) continue;
        const cssText = safeStringProperty(pending.rule, "cssText") ?? "";
        const textStart = cache.cssTextByteOffset;
        const remainingText = sliceUtf8From(cssText, textStart);
        const remainingBudget =
          STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass - bytesRead;
        const bounded = takeUtf8Prefix(remainingText, remainingBudget);
        const fragmentKey = [
          pending.path.join("."),
          String(textStart),
          String(bounded.bytes),
        ].join(":");
        const fragmentDigest = digestStrings([
          pending.path.join("."),
          bounded.text,
        ]);
        const previousFragment = cache.windows.get(fragmentKey);
        if (
          this.initialized &&
          previousFragment !== undefined &&
          previousFragment !== fragmentDigest
        ) {
          semanticChange = true;
        }
        cache.pendingWindows.set(fragmentKey, fragmentDigest);
        bytesRead += bounded.bytes;
        if (bounded.truncated) {
          cache.cssTextByteOffset += bounded.bytes;
          truncatedHere = true;
          break;
        }
        cache.pendingRule = undefined;
        cache.cssTextByteOffset = 0;
      }

      if (traversalFailed) {
        inaccessibleSheetCount += 1;
        partial = true;
        this.activeTraversals.delete(traversal);
        traversal.close();
        cache.traversal = undefined;
        cache.pendingRule = undefined;
        cache.cssTextByteOffset = 0;
        cache.pendingWindows.clear();
        markInaccessible(cache, metadata, this.initialized, (changed) => {
          semanticChange ||= changed;
        });
        completedSheets += 1;
        sheetIndex = (sheetIndex + 1) % unique.length;
        continue;
      }

      if (traversalCompleted) {
        const completedDigest = digestStrings([
          metadata,
          `pulls:${traversal.pullsTotal}`,
          ...[...cache.pendingWindows.entries()]
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
        cache.windows.clear();
        for (const [key, value] of cache.pendingWindows) {
          cache.windows.set(key, value);
        }
        cache.pendingWindows.clear();
        this.activeTraversals.delete(traversal);
        cache.traversal = undefined;
        cache.pendingRule = undefined;
        cache.cssTextByteOffset = 0;
        completedSheets += 1;
        sheetIndex = (sheetIndex + 1) % unique.length;
        continue;
      }

      if (truncatedHere) {
        partial = true;
        break;
      }

      // A live traversal either completes, fails, or consumes a bounded pass.
      if (cache.traversal) {
        partial = true;
        break;
      }
    }

    const cursorCache = partial
      ? this.cache.get(unique[sheetIndex]!.sheet as unknown as object)
      : undefined;
    const cursorTraversal = cursorCache?.traversal;
    const cursorPath = cursorCache?.pendingRule?.path ?? cursorTraversal?.cursorPath();
    const cursorOffset = cursorCache?.pendingRule?.cursorOffset ??
      cursorTraversal?.pullsTotal ?? 0;
    const nextCursor: StylesheetFingerprintCursor = Object.freeze({
      sheetIndex: partial ? sheetIndex : startSheet,
      ruleOffset: partial ? cursorOffset : 0,
      ...(partial && (cursorCache?.cssTextByteOffset ?? 0) > 0
        ? { cssTextByteOffset: cursorCache!.cssTextByteOffset }
        : {}),
      ...(partial && cursorPath && cursorPath.length > 1
        ? { rulePath: Object.freeze([...cursorPath]) }
        : {}),
    });
    this.cursor = nextCursor;
    const digest = digestStrings([
      inventoryDigest,
      ...unique.map(({ sheet }) => {
        const current = this.cache.get(sheet as unknown as object);
        return digestStrings([
          current?.metadata ?? "",
          current?.full ?? "",
          ...[...(current?.pendingWindows ?? new Map()).entries()]
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
    for (const traversal of this.activeTraversals) traversal.close();
    this.activeTraversals.clear();
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

type TraversalAdvance =
  | { readonly kind: "rule"; readonly pulls: number; readonly value: TraversedRule }
  | { readonly kind: "done" | "budget" | "time" | "error"; readonly pulls: number };

interface RuleFrameBase {
  readonly pathPrefix: readonly number[];
  readonly ownerRule?: object;
  position: number;
}

interface IndexedRuleFrame extends RuleFrameBase {
  readonly kind: "indexed";
  readonly source: ArrayLike<unknown>;
}

interface IterableRuleFrame extends RuleFrameBase {
  readonly kind: "iterable";
  readonly iterator: Iterator<unknown>;
}

type RuleFrame = IndexedRuleFrame | IterableRuleFrame;

class RuleTraversal {
  private readonly frames: RuleFrame[];
  private readonly activeRules = new Set<object>();
  private pendingDescend: TraversedRule | undefined;
  private closed = false;
  public pullsTotal = 0;

  public constructor(sheet: object) {
    this.frames = [openRuleFrame(requiredRuleList(sheet), Object.freeze([]))];
  }

  public advance(
    maximumPulls: number,
    timeExpired: () => boolean,
  ): TraversalAdvance {
    let pulls = 0;
    while (!this.closed) {
      const descendError = this.openPendingDescendant();
      if (descendError) {
        this.close();
        return { kind: "error", pulls };
      }

      const frame = this.frames.at(-1);
      if (!frame) {
        this.closed = true;
        return { kind: "done", pulls };
      }
      if (frame.kind === "indexed") {
        const length = arrayLikeLength(frame.source);
        if (length === undefined) {
          this.close();
          return { kind: "error", pulls };
        }
        if (frame.position >= length) {
          this.popFrame(frame);
          continue;
        }
      }
      if (pulls >= maximumPulls) return { kind: "budget", pulls };
      if (timeExpired()) return { kind: "time", pulls };

      const cursorOffset = this.pullsTotal;
      const position = frame.position;
      let value: unknown;
      if (frame.kind === "indexed") {
        frame.position += 1;
        pulls += 1;
        this.pullsTotal += 1;
        try {
          value = frame.source[position];
        } catch {
          this.close();
          return { kind: "error", pulls };
        }
      } else {
        let step: IteratorResult<unknown>;
        pulls += 1;
        this.pullsTotal += 1;
        try {
          step = frame.iterator.next();
          if (typeof step !== "object" || step === null) {
            throw new Error("invalid iterator result");
          }
          if (step.done === true) {
            this.popFrame(frame);
            continue;
          }
          value = step.value;
          frame.position += 1;
        } catch {
          this.close();
          return { kind: "error", pulls };
        }
      }
      if (typeof value !== "object" || value === null) continue;
      const traversed: TraversedRule = Object.freeze({
        rule: value,
        path: Object.freeze([...frame.pathPrefix, position]),
        cursorOffset,
      });
      this.pendingDescend = traversed;
      return { kind: "rule", pulls, value: traversed };
    }
    return { kind: "done", pulls };
  }

  public cursorPath(): readonly number[] | undefined {
    if (this.pendingDescend) return this.pendingDescend.path;
    const frame = this.frames.at(-1);
    return frame
      ? Object.freeze([...frame.pathPrefix, frame.position])
      : undefined;
  }

  public close(): void {
    if (this.closed && this.frames.length === 0) return;
    this.closed = true;
    for (const frame of [...this.frames].reverse()) {
      if (frame.kind !== "iterable") continue;
      try {
        const close = frame.iterator.return;
        if (typeof close === "function") close.call(frame.iterator);
      } catch {
        // Iterator cleanup cannot expand stylesheet authority.
      }
    }
    this.frames.splice(0);
    this.activeRules.clear();
    this.pendingDescend = undefined;
  }

  private openPendingDescendant(): boolean {
    const pending = this.pendingDescend;
    if (!pending) return false;
    this.pendingDescend = undefined;
    if (this.activeRules.has(pending.rule)) return false;
    let hasNested: boolean;
    let raw: unknown;
    try {
      hasNested = "cssRules" in pending.rule;
      raw = hasNested
        ? (pending.rule as { readonly cssRules?: unknown }).cssRules
        : undefined;
    } catch {
      return true;
    }
    if (!hasNested || raw === undefined) return false;
    try {
      const frame = openRuleFrame(raw, pending.path, pending.rule);
      this.activeRules.add(pending.rule);
      this.frames.push(frame);
      return false;
    } catch {
      return true;
    }
  }

  private popFrame(frame: RuleFrame): void {
    this.frames.pop();
    if (frame.ownerRule) this.activeRules.delete(frame.ownerRule);
  }
}

function requiredRuleList(value: object): unknown {
  let raw: unknown;
  try {
    raw = (value as { readonly cssRules?: unknown }).cssRules;
  } catch {
    throw new Error("cssRules inaccessible");
  }
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules inaccessible");
  }
  return raw;
}

function openRuleFrame(
  raw: unknown,
  pathPrefix: readonly number[],
  ownerRule?: object,
): RuleFrame {
  if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new Error("cssRules inaccessible");
  }
  const length = arrayLikeLength(raw as ArrayLike<unknown>);
  if (length !== undefined) {
    return {
      kind: "indexed",
      source: raw as ArrayLike<unknown>,
      pathPrefix,
      position: 0,
      ...(ownerRule ? { ownerRule } : {}),
    };
  }
  let iteratorMethod: unknown;
  let iterator: unknown;
  try {
    iteratorMethod = (raw as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator];
    if (typeof iteratorMethod !== "function") throw new Error("not iterable");
    iterator = iteratorMethod.call(raw);
  } catch {
    throw new Error("cssRules inaccessible");
  }
  if (
    typeof iterator !== "object" ||
    iterator === null ||
    typeof (iterator as { readonly next?: unknown }).next !== "function"
  ) {
    throw new Error("cssRules inaccessible");
  }
  return {
    kind: "iterable",
    iterator: iterator as Iterator<unknown>,
    pathPrefix,
    position: 0,
    ...(ownerRule ? { ownerRule } : {}),
  };
}

function arrayLikeLength(value: ArrayLike<unknown>): number | undefined {
  try {
    const length = value.length;
    return typeof length === "number" &&
      Number.isSafeInteger(length) &&
      length >= 0
      ? length
      : undefined;
  } catch {
    return undefined;
  }
}

function markInaccessible(
  cache: SheetCache,
  metadata: string,
  initialized: boolean,
  reportChange: (changed: boolean) => void,
): void {
  const inaccessibleDigest = digestStrings([metadata, "inaccessible"]);
  reportChange(
    initialized &&
    cache.full !== undefined &&
    cache.full !== inaccessibleDigest,
  );
  cache.full = inaccessibleDigest;
  cache.windows.clear();
  cache.pendingWindows.clear();
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
