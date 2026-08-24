import { describe, expect, it } from "vitest";
import {
  STYLESHEET_LIMITS,
  type StylesheetRegistryEntry,
} from "../src/stylesheetRegistry.js";
import { StylesheetFingerprint } from "../src/stylesheetFingerprint.js";

describe("StylesheetFingerprint", () => {
  it("hashes each shared sheet object once and combines per-scope owner/adoption state", () => {
    let cssRuleReads = 0;
    const rule = {
      cssText: ".shared { color: red }",
      get cssRules() {
        cssRuleReads += 1;
        return [];
      },
    };
    const shared = {
      href: null,
      disabled: false,
      media: { mediaText: "screen" },
      get cssRules() {
        cssRuleReads += 1;
        return [rule];
      },
    };
    const first = entry(shared, "scope-1", "sheet-1", 0, owner({ media: "screen" }));
    const second = entry(shared, "scope-2", "sheet-2", 1, owner({ media: "print" }));
    const scanner = new StylesheetFingerprint();

    const initial = scanner.scan([first, second]);
    expect(initial.partial).toBe(false);
    expect(initial.uniqueSheetObjectsScanned).toBe(1);
    expect(cssRuleReads).toBe(2);

    cssRuleReads = 0;
    const unchanged = scanner.scan([first, second]);
    expect(unchanged.digest).toBe(initial.digest);
    expect(unchanged.changed).toBe(false);
    expect(cssRuleReads).toBe(2);

    second.sourceOrder = 0;
    second.ownerState!.media = "all";
    const rootStateChanged = scanner.scan([first, second]);
    expect(rootStateChanged.changed).toBe(true);
    expect(rootStateChanged.digest).not.toBe(initial.digest);
  });

  it("detects CSS text, disabled/media, and every bounded link/style owner state", () => {
    const rule = { cssText: ".card { color: red }" };
    const sheet = {
      href: "https://example.test/app.css?theme=dark",
      disabled: false,
      media: { mediaText: "screen" },
      cssRules: [rule],
    };
    const ownerState = owner({
      media: "screen",
      disabled: false,
      rel: "stylesheet",
      href: "/app.css?theme=dark",
      title: "default",
      alternate: false,
    });
    const candidate = entry(sheet, "scope", "sheet", 0, ownerState);
    const scanner = new StylesheetFingerprint();
    const before = scanner.scan([candidate]);

    rule.cssText = ".card { color: blue }";
    expect(scanner.scan([candidate]).changed).toBe(true);
    sheet.disabled = true;
    expect(scanner.scan([candidate]).changed).toBe(true);
    sheet.media.mediaText = "print";
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.media = "print";
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.disabled = true;
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.rel = "alternate stylesheet";
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.href = "/print.css";
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.title = "print";
    expect(scanner.scan([candidate]).changed).toBe(true);
    ownerState.alternate = true;
    const after = scanner.scan([candidate]);
    expect(after.changed).toBe(true);
    expect(after.digest).not.toBe(before.digest);
  });

  it("marks inaccessible sheets partial without throwing or retrying within a pass", () => {
    let reads = 0;
    const inaccessible = {
      href: "https://cdn.example.test/blocked.css",
      disabled: false,
      media: { mediaText: "" },
      get cssRules(): never {
        reads += 1;
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const scanner = new StylesheetFingerprint();

    const result = scanner.scan([
      entry(inaccessible, "scope", "blocked", 0, owner({})),
      entry(inaccessible, "shadow", "blocked-shadow", 0, owner({})),
    ]);

    expect(result.partial).toBe(true);
    expect(result.inaccessibleSheetCount).toBe(1);
    expect(result.uniqueSheetObjectsScanned).toBe(1);
    expect(reads).toBe(1);
  });

  it("rotates a deterministic rule cursor after the session-global rule ceiling", () => {
    const rules = Array.from(
      { length: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot * 2 + 8 },
      (_, index) => ({ cssText: `.rule-${index} { --n: ${index} }` }),
    );
    const sheet = {
      href: null,
      disabled: false,
      media: { mediaText: "" },
      cssRules: rules,
    };
    const scanner = new StylesheetFingerprint();
    const candidate = entry(sheet, "scope", "huge", 0, owner({}));

    const first = scanner.scan([candidate]);
    expect(first.partial).toBe(true);
    expect(first.rulesVisited).toBe(
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot,
    );
    expect(first.nextCursor).toEqual({ sheetIndex: 0, ruleOffset: 4096 });

    const second = scanner.scan([candidate]);
    expect(second.rulesVisited).toBe(
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot,
    );
    expect(second.nextCursor.ruleOffset).toBe(8192);
    const baselineTail = scanner.scan([candidate]);
    expect(baselineTail.rulesVisited).toBe(8);
    expect(baselineTail.nextCursor.ruleOffset).toBe(0);
    rules.at(-1)!.cssText = ".rule-last { --n: changed }";
    const afterMutation = [
      scanner.scan([candidate]),
      scanner.scan([candidate]),
      scanner.scan([candidate]),
    ];
    expect(afterMutation.some(({ changed }) => changed)).toBe(true);
  });

  it("rotates after byte and elapsed-time truncation instead of multiplying budgets by root", () => {
    const hugeRule = {
      cssText: "x".repeat(STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass + 1),
    };
    const byteScanner = new StylesheetFingerprint();
    const byteResult = byteScanner.scan([
      entry({
        href: null,
        disabled: false,
        media: { mediaText: "" },
        cssRules: [hugeRule],
      }, "scope", "bytes", 0, owner({})),
    ]);
    expect(byteResult.partial).toBe(true);
    expect(byteResult.bytesRead).toBeLessThanOrEqual(
      STYLESHEET_LIMITS.fingerprintCssTextBytesPerPass,
    );

    let clock = 0;
    const timeScanner = new StylesheetFingerprint({
      now: () => {
        clock += 7;
        return clock;
      },
    });
    const timeResult = timeScanner.scan(Array.from({ length: 4 }, (_, index) => (
      entry({
        href: null,
        disabled: false,
        media: { mediaText: "" },
        cssRules: [{ cssText: `.r-${index} { color: red }` }],
      }, `scope-${index}`, `sheet-${index}`, 0, owner({}))
    )));
    expect(timeResult.partial).toBe(true);
    expect(timeResult.nextCursor.sheetIndex).toBeGreaterThan(0);

    let slowRuleClock = 0;
    const slowRuleScanner = new StylesheetFingerprint({
      now: () => {
        slowRuleClock += 7;
        return slowRuleClock;
      },
    });
    const slowRuleResult = slowRuleScanner.scan([entry({
      href: null,
      disabled: false,
      media: { mediaText: "" },
      cssRules: Array.from({ length: 100 }, (_, index) => ({
        cssText: `.slow-${index} { --n: ${index} }`,
      })),
    }, "slow-scope", "slow-sheet", 0, owner({}))]);
    expect(slowRuleResult.partial).toBe(true);
    expect(slowRuleResult.nextCursor.ruleOffset).toBeGreaterThan(0);
    expect(slowRuleResult.nextCursor.ruleOffset).toBeLessThan(100);
  });
});

type MutableOwnerState = {
  media: string;
  disabled: boolean;
  rel: string;
  href: string;
  title: string;
  alternate: boolean;
};

function owner(values: Partial<MutableOwnerState>): MutableOwnerState {
  return {
    media: "",
    disabled: false,
    rel: "stylesheet",
    href: "",
    title: "",
    alternate: false,
    ...values,
  };
}

function entry(
  sheet: object,
  scopeRef: string,
  sheetIdentity: string,
  sourceOrder: number,
  ownerState: MutableOwnerState,
): MutableEntry {
  return {
    scope: {} as Document,
    scopeRef,
    scopeKind: "document",
    sheet: sheet as CSSStyleSheet,
    sheetRef: sheetIdentity,
    sheetIdentity,
    kind: "external",
    sourceOrder,
    generatedRanges: {},
    ownerState,
    rulePathPrefix: "",
  };
}

type MutableEntry = Omit<StylesheetRegistryEntry, "sourceOrder" | "ownerState"> & {
  sourceOrder: number;
  ownerState?: MutableOwnerState;
};
