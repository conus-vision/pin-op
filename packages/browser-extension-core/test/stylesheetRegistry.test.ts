import { describe, expect, it, vi } from "vitest";
import {
  STYLESHEET_LIMITS,
  StylesheetRegistry,
  type StylesheetRegistryEntry,
} from "../src/stylesheetRegistry.js";

describe("StylesheetRegistry", () => {
  it("fixes one session-global set of stylesheet budgets", () => {
    expect(STYLESHEET_LIMITS).toEqual({
      scopeSheetPairsPerSession: 256,
      uniqueSheetObjectsPerSession: 256,
      rulesVisitedPerSessionSnapshot: 4096,
      declarationsPerRule: 128,
      inlineTextBytesPerSheet: 512 * 1024,
      inlineTextBytesPerSession: 2 * 1024 * 1024,
      scopesPerSession: 64,
      fingerprintCssTextBytesPerPass: 2 * 1024 * 1024,
      fingerprintTimeBudgetMs: 12,
      fingerprintIntervalTargetMs: 1000,
    });
    expect(Object.isFrozen(STYLESHEET_LIMITS)).toBe(true);
  });

  it("inventories exact scope/sheet pairs, imports, frames, and local order", () => {
    const imported = sheet("https://example.test/shared.css", [
      styleRule(".imported", "color: purple"),
    ]);
    const documentSheet = sheet("https://example.test/shared.css", [
      importRule(imported),
      styleRule(".document", "color: red"),
    ]);
    const sharedConstructed = sheet(null, [
      styleRule(".shared", "display: grid"),
    ]);
    const shadowOwned = sheet(null, [styleRule(".shadow", "color: blue")]);
    const shadowStyle = styleOwner(".shadow { color: blue; }", shadowOwned);
    const shadow = scope("shadow", [shadowOwned], [sharedConstructed], [shadowStyle]);
    const openHost = host(shadow);
    const closedHost = host(undefined);
    const frameSheet = sheet("https://example.test/shared.css", [
      styleRule(".frame", "color: green"),
    ]);
    const frameDocument = scope("document", [frameSheet], [], []);
    const frame = { contentDocument: frameDocument };
    const document = scope(
      "document",
      [documentSheet],
      [sharedConstructed],
      [openHost, closedHost, frame],
    );
    const registry = createRegistry(document);

    const snapshot = registry.snapshot();
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.partial).toBe(false);
    expect(snapshot.entries.map(entryIdentity)).toEqual([
      ["document", "external", 0, "https://example.test/shared.css"],
      ["document", "import", 1, "https://example.test/shared.css"],
      ["document", "adopted", 2, undefined],
      ["shadow-root", "owner", 0, undefined],
      ["shadow-root", "adopted", 1, undefined],
      ["document", "external", 0, "https://example.test/shared.css"],
    ]);
    expect(new Set(snapshot.entries.map(({ sheetIdentity }) => sheetIdentity)).size)
      .toBe(snapshot.entries.length);
    expect(snapshot.uniqueSheetObjectCount).toBe(5);
    expect(snapshot.entries.filter(({ sheet }) => sheet === sharedConstructed))
      .toHaveLength(2);
    expect(snapshot.entries.some(({ scope }) => scope === closedHost)).toBe(false);

    const documentElement = elementIn(document, new Set([".document", ".shared"]));
    const shadowElement = elementIn(shadow, new Set([".shadow", ".shared"]));
    expect(registry.entriesForElement(documentElement).map(({ scopeKind }) => scopeKind))
      .toEqual(["document", "document", "document"]);
    expect(registry.entriesForElement(shadowElement).map(({ scopeKind }) => scopeKind))
      .toEqual(["shadow-root", "shadow-root"]);
    expect(registry.entriesForElement(shadowElement).some(({ sheet }) => (
      sheet === documentSheet
    ))).toBe(false);
  });

  it("detects eventless adopted stylesheet add, remove, and reorder", () => {
    const first = sheet(null, [styleRule(".first", "color: red")]);
    const second = sheet(null, [styleRule(".second", "color: blue")]);
    const third = sheet(null, [styleRule(".third", "color: green")]);
    const document = scope("document", [], [first, second], []);
    const registry = createRegistry(document);

    document.adoptedStyleSheets.reverse();
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.map(({ sheet }) => sheet)).toEqual([
      second,
      first,
    ]);

    document.adoptedStyleSheets.pop();
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.map(({ sheet }) => sheet)).toEqual([
      second,
    ]);

    document.adoptedStyleSheets.push(third);
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.map(({ sheet }) => sheet)).toEqual([
      second,
      third,
    ]);
  });

  it("detects eventless open-shadow insertion and frame document replacement", () => {
    const nodes: object[] = [];
    const document = scope("document", [], [], nodes);
    const registry = createRegistry(document);
    const shadowSheet = sheet(null, [styleRule(".shadow", "color: blue")]);
    const shadow = scope("shadow", [shadowSheet], [], []);

    nodes.push(host(shadow));
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.some(({ scope }) => scope === shadow)).toBe(true);

    const firstFrame = scope("document", [
      sheet("https://frame.test/first.css", []),
    ], [], []);
    const secondFrame = scope("document", [
      sheet("https://frame.test/second.css", []),
    ], [], []);
    const frame = { contentDocument: firstFrame };
    nodes.push(frame);
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.some(({ scope }) => scope === firstFrame)).toBe(true);

    frame.contentDocument = secondFrame;
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.snapshot().entries.some(({ scope }) => scope === firstFrame)).toBe(false);
    expect(registry.snapshot().entries.some(({ scope }) => scope === secondFrame)).toBe(true);
  });

  it("maps bounded inline owner ranges only after complete CSSOM/AST proof", () => {
    const validSheet = sheet(null, [
      styleRule(".card", "color: red; margin: 0 !important"),
      groupRule("media", "screen", [styleRule(".card", "display: grid")]),
    ]);
    const validOwner = styleOwner([
      "/* comments do not consume a CSSOM index */",
      ".card { color: red; margin: 0 !important; }",
      "@media screen {",
      "  .card { display: grid; }",
      "}",
    ].join("\n"), validSheet);
    const malformedSheet = sheet(null, [styleRule(".bad", "color: red")]);
    const malformedOwner = styleOwner(".bad { color: red", malformedSheet);
    const ambiguousSheet = sheet(null, [styleRule(".one", "color: red")]);
    const ambiguousOwner = styleOwner(
      ".one { color: red } .extra { color: blue }",
      ambiguousSheet,
    );
    const external = sheet("https://example.test/app.css", [
      styleRule(".external", "color: black"),
    ]);
    const document = scope(
      "document",
      [validSheet, malformedSheet, ambiguousSheet, external],
      [],
      [validOwner, malformedOwner, ambiguousOwner],
    );

    const entries = createRegistry(document).snapshot().entries;
    const valid = entries.find(({ sheet }) => sheet === validSheet);
    expect(valid?.generatedRanges).toEqual({
      "0": {
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 44,
      },
      "1.0": {
        startLine: 4,
        startColumn: 3,
        endLine: 4,
        endColumn: 27,
      },
    });
    expect(entries.find(({ sheet }) => sheet === malformedSheet)?.generatedRanges)
      .toEqual({});
    expect(entries.find(({ sheet }) => sheet === ambiguousSheet)?.generatedRanges)
      .toEqual({});
    expect(entries.find(({ sheet }) => sheet === external)?.generatedRanges)
      .toEqual({});
  });

  it.each([
    ["media", "screen", "print"],
    ["supports", "(display: grid)", "(display: block)"],
    ["layer", "theme", "alternate"],
    ["scope", "(.layout)", "(.other)"],
    ["container", "sidebar (width > 10px)", "main (width > 20px)"],
    ["starting-style", "", "unexpected"],
    ["future-group", "alpha", "beta"],
  ])("rejects an unproven @%s grouping prelude", (name, expected, actual) => {
    const nested = styleRule(".card", "color: red");
    const nativeGroup: FakeRule = {
      cssText: `@${name}${actual ? ` ${actual}` : ""} { ${nested.cssText} }`,
      cssRules: [nested],
    };
    const grouped = sheet(null, [nativeGroup]);
    const source = `@${name}${expected ? ` ${expected}` : ""} { .card { color: red; } }`;
    const owner = styleOwner(source, grouped);
    const document = scope("document", [grouped], [], [owner]);

    const entry = createRegistry(document).snapshot().entries[0];

    expect(entry?.generatedRanges).toEqual({});
  });

  it("bounds inaccessible, oversized, hostile, and session-global inventory", () => {
    const inaccessible = {
      href: "https://cdn.example.test/blocked.css",
      get cssRules(): never {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const oversized = sheet(null, [styleRule(".large", "color: red")]);
    const oversizedOwner = styleOwner(
      `.large { --value: ${"x".repeat(STYLESHEET_LIMITS.inlineTextBytesPerSheet)}; }`,
      oversized,
    );
    const tooMany = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession + 8 },
      (_, index) => sheet(`https://example.test/${index}.css`, []),
    );
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile getter");
      },
    });
    const document = scope(
      "document",
      [inaccessible, oversized, hostile, ...tooMany],
      [],
      [oversizedOwner],
    );

    const snapshot = createRegistry(document).snapshot();
    expect(snapshot.entries).toHaveLength(
      STYLESHEET_LIMITS.scopeSheetPairsPerSession,
    );
    expect(snapshot.partial).toBe(true);
    expect(snapshot.omittedScopeSheetPairCount).toBeGreaterThan(0);
    expect(snapshot.inaccessibleStylesheetCount).toBeGreaterThan(0);
    expect(snapshot.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "stylesheet-inaccessible",
        "inline-text-too-large",
        "scope-sheet-pair-limit",
      ]),
    );
  });

  it("bounds primitive iterable pulls and safely closes throwing rule iterators", () => {
    const primitivePulls: number[] = [];
    let primitiveCloses = 0;
    const primitiveRules = trackedRuleIterable(
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot * 2,
      (index) => index,
      primitivePulls,
      () => { primitiveCloses += 1; },
    );
    const primitiveSheet = {
      href: null,
      disabled: false,
      media: { mediaText: "" },
      cssRules: primitiveRules,
    };

    const primitiveRegistry = createRegistry(scope(
      "document",
      [primitiveSheet as unknown as FakeSheet],
      [],
      [],
    ));
    const primitiveSnapshot = primitiveRegistry.snapshot();

    expect(primitivePulls.every((pulls) => (
      pulls <= STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot
    ))).toBe(true);
    expect(primitiveSnapshot.partial).toBe(true);
    expect(primitiveSnapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "rules-visited-limit",
    }));
    primitiveRegistry.dispose();
    expect(primitiveCloses).toBe(primitivePulls.length);

    const throwingPulls: number[] = [];
    let throwingCloses = 0;
    const throwingRules = trackedRuleIterable(
      4,
      () => {
        throw new Error("hostile next");
      },
      throwingPulls,
      () => { throwingCloses += 1; },
    );
    const throwingRegistry = createRegistry(scope("document", [{
      href: null,
      disabled: false,
      media: { mediaText: "" },
      cssRules: throwingRules,
    } as unknown as FakeSheet], [], []));
    const throwingSnapshot = throwingRegistry.snapshot();

    expect(throwingPulls.every((pulls) => pulls === 1)).toBe(true);
    expect(throwingCloses).toBe(throwingPulls.length);
    expect(throwingSnapshot.partial).toBe(true);
    throwingRegistry.dispose();
  });

  it("shares the CSSOM rule-visit budget across every stylesheet scope pair", () => {
    const rulesPerSheet = Math.ceil(
      STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot * 0.75,
    );
    const first = sheet(null, Array.from(
      { length: rulesPerSheet },
      (_, index) => styleRule(`.first-${index}`, "color: red"),
    ));
    const second = sheet(null, Array.from(
      { length: rulesPerSheet },
      (_, index) => styleRule(`.second-${index}`, "color: blue"),
    ));

    const snapshot = createRegistry(scope("document", [first, second], [], []))
      .snapshot();

    expect(snapshot.partial).toBe(true);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "rules-visited-limit",
    }));
  });

  it("advances stylesheet and aggregate revisions for DOM, CSSOM, owner, and explicit changes", () => {
    let mutationCallback: ((records: readonly unknown[]) => void) | undefined;
    const disconnect = vi.fn();
    const rule = styleRule(".card", "color: red");
    const app = sheet("https://example.test/app.css", [rule]);
    const owner = linkOwner(app, {
      media: "screen",
      rel: "stylesheet",
      href: "/app.css",
      title: "default",
    });
    app.ownerNode = owner;
    const document = scope("document", [app], [], [owner]);
    const invalidations: unknown[] = [];
    const registry = createRegistry(document, {
      onInvalidated: (event) => invalidations.push(event),
      createMutationObserver(callback) {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect };
      },
    });

    expect(registry.checkForChanges()).toBe(false);
    rule.cssText = ".card { color: blue; }";
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 1,
      stylesRevision: 1,
    });
    app.disabled = true;
    app.media.mediaText = "print";
    owner.attributes.media = "print";
    owner.disabled = true;
    owner.attributes.rel = "alternate stylesheet";
    owner.attributes.href = "/print.css?theme=dark";
    owner.attributes.title = "print";
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 2,
      stylesRevision: 2,
    });
    owner.attributes.title = "print-v2";
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 3,
      stylesRevision: 3,
    });

    document.styleSheets.push(sheet("https://example.test/new.css", []));
    mutationCallback?.([{
      type: "childList",
      target: document,
      addedNodes: [{ tagName: "STYLE" }],
      removedNodes: [],
    }]);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 4,
      stylesRevision: 4,
    });
    registry.invalidate("soft-refresh");
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 5,
      stylesRevision: 5,
    });
    expect(invalidations).toHaveLength(5);

    registry.dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    mutationCallback?.([{ type: "childList" }]);
    expect(invalidations).toHaveLength(5);
  });

  it("ignores unrelated DOM mutations and preserves rule refs", () => {
    let mutationCallback: ((records: readonly unknown[]) => void) | undefined;
    const nativeRule = styleRule(".card", "color: red");
    const app = sheet(null, [nativeRule]);
    const owner = styleOwner(".card { color: red; }", app);
    const document = scope("document", [app], [], [owner]);
    const registry = createRegistry(document, {
      createMutationObserver(callback) {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });
    const entry = registry.snapshot().entries[0]!;
    const ruleRef = registry.referenceRule(entry, "0", nativeRule);

    mutationCallback?.([{
      type: "childList",
      target: { tagName: "DIV" },
      addedNodes: [{ tagName: "SPAN" }],
      removedNodes: [],
    }]);

    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 0,
      stylesRevision: 0,
    });
    expect(registry.resolveRule(ruleRef)).toBe(nativeRule);

    mutationCallback?.([{
      type: "characterData",
      target: { parentElement: owner },
    }]);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 1,
      stylesRevision: 1,
    });
    expect(registry.resolveRule(ruleRef)).toBeUndefined();
  });

  it("polls only while active, rotates partial fingerprints, and resets identity on navigation", () => {
    const intervals = new Map<number, () => void>();
    const clearInterval = vi.fn((handle: number) => intervals.delete(handle));
    let nextHandle = 1;
    const app = sheet("https://example.test/app.css", [styleRule(".a", "color:red")]);
    const firstDocument = scope("document", [app], [], []);
    const applicabilityCheck = vi.fn();
    const registry = createRegistry(firstDocument, {
      setInterval(callback) {
        const handle = nextHandle++;
        intervals.set(handle, callback);
        return handle;
      },
      clearInterval,
    });

    expect(intervals).toHaveLength(0);
    registry.startPolling(applicabilityCheck);
    registry.startPolling(applicabilityCheck);
    expect(intervals).toHaveLength(1);
    app.cssRules[0]!.cssText = ".a { color: blue }";
    [...intervals.values()][0]?.();
    expect(registry.revisions.stylesheetRevision).toBe(1);
    expect(applicabilityCheck).toHaveBeenLastCalledWith(true);
    [...intervals.values()][0]?.();
    expect(applicabilityCheck).toHaveBeenLastCalledWith(false);

    const oldIdentity = registry.snapshot().entries[0]?.sheetIdentity;
    const nextDocument = scope("document", [app], [], []);
    registry.resetDocument(nextDocument as unknown as Document, 8);
    expect(registry.revisions).toEqual({
      documentEpoch: 8,
      stylesheetRevision: 0,
      stylesRevision: 0,
    });
    expect(registry.snapshot().entries[0]?.sheetIdentity).not.toBe(oldIdentity);
    expect(clearInterval).toHaveBeenCalled();
    expect(intervals).toHaveLength(1);

    registry.stopPolling();
    expect(intervals).toHaveLength(0);
    registry.dispose();
    expect(() => registry.snapshot()).toThrow(/disposed/i);
  });

  it("preserves rule identity for applicability-only changes and revokes it on sheet changes", () => {
    const nativeRule = styleRule(".card", "color: red");
    const app = sheet("https://example.test/app.css", [nativeRule]);
    const registry = createRegistry(scope("document", [app], [], []));
    const entry = registry.snapshot().entries[0]!;
    const first = registry.referenceRule(entry, "0", nativeRule);

    registry.invalidateApplicability("checked-state-change");
    expect(registry.referenceRule(entry, "0", nativeRule)).toBe(first);
    expect(registry.resolveRule(first)).toBe(nativeRule);
    expect(registry.revisions).toMatchObject({
      stylesheetRevision: 0,
      stylesRevision: 1,
    });

    nativeRule.cssText = ".card { color: blue }";
    expect(registry.checkForChanges()).toBe(true);
    expect(registry.resolveRule(first)).toBeUndefined();
    const currentEntry = registry.snapshot().entries[0]!;
    expect(registry.referenceRule(currentEntry, "0", nativeRule)).not.toBe(first);
  });
});

function createRegistry(
  document: ReturnType<typeof scope>,
  options: Partial<ConstructorParameters<typeof StylesheetRegistry>[0]> = {},
): StylesheetRegistry {
  return new StylesheetRegistry({
    document: document as unknown as Document,
    contentSessionId: "content-registry-test",
    documentEpoch: 3,
    ...options,
  });
}

function entryIdentity(entry: StylesheetRegistryEntry): readonly unknown[] {
  return [entry.scopeKind, entry.kind, entry.sourceOrder, entry.sourceUrl];
}

type FakeRule = {
  selectorText?: string;
  conditionText?: string;
  cssText: string;
  cssRules?: FakeRule[];
  style?: ReturnType<typeof declaration>;
  styleSheet?: FakeSheet;
};

type FakeSheet = {
  href: string | null;
  cssRules: FakeRule[];
  disabled: boolean;
  media: { mediaText: string };
  ownerNode?: ReturnType<typeof styleOwner> | ReturnType<typeof linkOwner>;
};

function declaration(css: string) {
  const parts = css.split(";").map((part) => part.trim()).filter(Boolean);
  const values = parts.map((part) => {
    const colon = part.indexOf(":");
    const name = part.slice(0, colon).trim();
    const raw = part.slice(colon + 1).trim();
    const important = /\s*!important$/i.test(raw);
    return {
      name,
      value: raw.replace(/\s*!important$/i, "").trim(),
      important,
    };
  });
  return {
    length: values.length,
    item: (index: number) => values[index]?.name ?? "",
    getPropertyValue: (name: string) => values.find((value) => value.name === name)?.value ?? "",
    getPropertyPriority: (name: string) => values.find((value) => value.name === name)?.important ? "important" : "",
  };
}

function styleRule(selector: string, css: string): FakeRule {
  return {
    selectorText: selector,
    cssText: `${selector} { ${css} }`,
    style: declaration(css),
  };
}

function groupRule(kind: "media" | "supports", condition: string, rules: FakeRule[]): FakeRule {
  return {
    conditionText: condition,
    cssText: `@${kind} ${condition} { ${rules.map(({ cssText }) => cssText).join(" ")} }`,
    cssRules: rules,
  };
}

function importRule(imported: FakeSheet): FakeRule {
  return {
    cssText: `@import url(${imported.href});`,
    styleSheet: imported,
  };
}

function sheet(href: string | null, cssRules: FakeRule[]): FakeSheet {
  return {
    href,
    cssRules,
    disabled: false,
    media: { mediaText: "" },
  };
}

function styleOwner(textContent: string, ownedSheet: FakeSheet) {
  const owner = {
    tagName: "STYLE",
    textContent,
    sheet: ownedSheet,
    attributes: {} as Record<string, string>,
    disabled: false,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    },
  };
  ownedSheet.ownerNode = owner;
  return owner;
}

function linkOwner(ownedSheet: FakeSheet, attributes: Record<string, string>) {
  return {
    tagName: "LINK",
    textContent: "",
    sheet: ownedSheet,
    attributes,
    disabled: false,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    },
  };
}

function host(shadowRoot: ReturnType<typeof scope> | undefined) {
  return {
    shadowRoot,
    tagName: "DIV",
  };
}

function scope(
  kind: "document" | "shadow",
  styleSheets: FakeSheet[],
  adoptedStyleSheets: FakeSheet[],
  nodes: object[],
) {
  const targetListeners = new Map<string, Set<EventListener>>();
  return {
    nodeType: kind === "document" ? 9 : 11,
    host: kind === "shadow" ? {} : undefined,
    styleSheets,
    adoptedStyleSheets,
    documentElement: kind === "document" ? { tagName: "HTML" } : undefined,
    defaultView: kind === "document" ? {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      CSS: { supports: () => true },
    } : undefined,
    querySelectorAll(selector: string) {
      if (selector === "*") return nodes;
      if (selector.includes("style") || selector.includes("link")) {
        return nodes.filter((node) => ["STYLE", "LINK"].includes(
          String((node as { tagName?: unknown }).tagName ?? ""),
        ));
      }
      if (selector.includes("iframe") || selector.includes("frame")) {
        return nodes.filter((node) => "contentDocument" in node);
      }
      return [];
    },
    addEventListener(type: string, listener: EventListener) {
      const listeners = targetListeners.get(type) ?? new Set();
      listeners.add(listener);
      targetListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      targetListeners.get(type)?.delete(listener);
    },
  };
}

function elementIn(root: object, matching: Set<string>) {
  return {
    getRootNode: () => root,
    matches: (selector: string) => matching.has(selector),
    parentElement: null,
  } as unknown as Element;
}

function trackedRuleIterable<T>(
  count: number,
  valueAt: (index: number) => T,
  pulls: number[],
  onClose: () => void,
): Iterable<T> {
  return {
    [Symbol.iterator]() {
      const iteratorIndex = pulls.push(0) - 1;
      let index = 0;
      return {
        next(): IteratorResult<T> {
          pulls[iteratorIndex]! += 1;
          if (index >= count) return { done: true, value: undefined };
          const value = valueAt(index);
          index += 1;
          return { done: false, value };
        },
        return(): IteratorResult<T> {
          onClose();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
