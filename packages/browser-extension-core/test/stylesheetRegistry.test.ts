import { describe, expect, it, vi } from "vitest";
import { INSPECT_LIMITS } from "@pin-op/protocol";
import {
  STYLESHEET_LIMITS,
  StylesheetRegistry,
  type StylesheetRegistryEntry,
} from "../src/stylesheetRegistry.js";
import { PinOpRuntimeArtifacts } from "../src/pinOpRuntimeArtifacts.js";

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

  it.each([
    "https://example.test/app.css#secret",
    "file:///private/app.css",
    "blob:https://example.test/id",
    "data:text/css,body{}",
    "chrome-extension://abc/app.css",
    "moz-extension://abc/app.css",
    "resource://gre/app.css",
    "about:blank",
    "javascript:alert(1)",
    "/var/private/app.css",
    "/Users/alice/app.css",
    "/workspace/project/app.css",
    "/mnt/c/app.css",
    "C:\\private\\app.css",
    "\\\\server\\share\\app.css",
    "//server/share/app.css",
    "https://user@example.test/app.css",
    "https://EXAMPLE.test/app.css",
    "https://example.test/app.css\u0085hidden",
    "https://example.test/app.css\u2066hidden",
    "https://example.test/app%00.css",
    "https://example.test/app%C2%85.css",
    "https://example.test/app%E2%81%A6.css",
    "https://example.test/app%5Csecret.css",
  ])("retains rules but omits hostile raw source authority %j", (href) => {
    const document = scope(
      "document",
      [sheet(href, [styleRule(".card", "color: red")])],
      [],
      [],
    );
    (document as typeof document & { location: { href: string } }).location = {
      href: "https://example.test/page",
    };

    const snapshot = createRegistry(document).snapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.sourceUrl).toBeUndefined();
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

  it("inventories document stylesheets beyond plain descendant discovery", () => {
    const app = sheet("https://example.test/app.css", [
      styleRule(".app", "color: red"),
    ]);
    const plainDescendants = Array.from(
      { length: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot + 1 },
      () => ({ tagName: "DIV", childNodes: [] }),
    );
    const snapshot = createRegistry(scope(
      "document",
      [app],
      [],
      plainDescendants,
    )).snapshot();

    expect(snapshot.entries.map(({ sheet }) => sheet)).toContain(app);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "scope-limit",
    }));
    expect(snapshot.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "scope-sheet-pair-limit",
    }));
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
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.length).toBeLessThanOrEqual(
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

  it("charges rejected CSSOM pulls to one session-global rule budget", () => {
    let hostileSlotPulls = 0;
    let secondSheetPulls = 0;
    const hostileRules = new Proxy(
      { length: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot },
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) {
            hostileSlotPulls += 1;
            throw new Error("hostile CSSOM slot");
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const secondRules = new Proxy([styleRule(".second", "color: blue")], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) {
          secondSheetPulls += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    let firstRuleRead = true;
    let secondRuleRead = true;
    const first = {
      href: null,
      disabled: false,
      media: { mediaText: "" },
      get cssRules() {
        const rules = firstRuleRead ? hostileRules : [];
        firstRuleRead = false;
        return rules;
      },
    };
    const second = {
      href: null,
      disabled: false,
      media: { mediaText: "" },
      get cssRules() {
        const rules = secondRuleRead ? secondRules : [];
        secondRuleRead = false;
        return rules;
      },
    };

    const snapshot = createRegistry(scope(
      "document",
      [first, second] as unknown as FakeSheet[],
      [],
      [],
    )).snapshot();

    expect({
      hostileSlotPulls,
      secondSheetPulls,
      partial: snapshot.partial,
      diagnosticCodes: snapshot.diagnostics.map(({ code }) => code),
    }).toEqual({
      hostileSlotPulls: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot,
      secondSheetPulls: 0,
      partial: true,
      diagnosticCodes: expect.arrayContaining(["rules-visited-limit"]),
    });
  });

  it("charges nested inline-correlation pulls to the global rule budget", () => {
    let nestedPulls = 0;
    let secondSheetPulls = 0;
    const nestedRules = new Proxy(
      { length: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - 1 },
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) {
            nestedPulls += 1;
            return Number(key);
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    let nestedRuleRead = true;
    const grouped = {
      conditionText: "screen",
      cssText: "@media screen { .nested { color: red; } }",
      get cssRules() {
        const rules = nestedRuleRead ? nestedRules : [];
        nestedRuleRead = false;
        return rules;
      },
    };
    const first = sheet(null, [grouped as unknown as FakeRule]);
    const owner = styleOwner(
      "@media screen { .nested { color: red; } }",
      first,
    );
    const secondRules = new Proxy([styleRule(".second", "color: blue")], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) {
          secondSheetPulls += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    let secondRuleRead = true;
    const second = {
      href: null,
      disabled: false,
      media: { mediaText: "" },
      get cssRules() {
        const rules = secondRuleRead ? secondRules : [];
        secondRuleRead = false;
        return rules;
      },
    };

    const snapshot = createRegistry(scope(
      "document",
      [first, second] as unknown as FakeSheet[],
      [],
      [owner],
    )).snapshot();

    expect({
      nestedPulls,
      secondSheetPulls,
      diagnosticCodes: snapshot.diagnostics.map(({ code }) => code),
    }).toEqual({
      nestedPulls: STYLESHEET_LIMITS.rulesVisitedPerSessionSnapshot - 1,
      secondSheetPulls: 0,
      diagnosticCodes: expect.arrayContaining(["rules-visited-limit"]),
    });
  });

  it("shares one candidate-pull budget across all roots and stylesheet lists", () => {
    const discoveryPassPulls: number[] = [];
    const stylesheetPassPulls: number[] = [];
    let activePass = -1;
    const beginPass = (): void => {
      activePass += 1;
      discoveryPassPulls[activePass] = 0;
      stylesheetPassPulls[activePass] = 0;
    };
    const chargeDiscoveryPull = (): void => {
      discoveryPassPulls[activePass] = (
        discoveryPassPulls[activePass] ?? 0
      ) + 1;
    };
    const chargeStylesheetPull = (): void => {
      stylesheetPassPulls[activePass] = (
        stylesheetPassPulls[activePass] ?? 0
      ) + 1;
    };
    const shared = sheet(null, []);
    const roots = Array.from(
      { length: STYLESHEET_LIMITS.scopesPerSession },
      (_, index) => scope(index === 0 ? "document" : "shadow", [], [], []),
    );
    const hosts = roots.slice(1).map((shadowRoot) => host(shadowRoot));
    const ownerCandidates = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      () => ({ tagName: "DIV" }),
    );
    for (const [index, root] of roots.entries()) {
      root.styleSheets = countedArrayLike(
        Array.from(
          { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
          () => shared,
        ),
        chargeStylesheetPull,
      );
      root.adoptedStyleSheets = countedArrayLike(
        Array.from(
          { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
          () => shared,
        ),
        chargeStylesheetPull,
      );
      Object.defineProperty(root, "childNodes", {
        configurable: true,
        get() {
          if (index === 0) beginPass();
          return countedArrayLike(
            index === 0 ? hosts : [],
            chargeDiscoveryPull,
          );
        },
      });
      root.querySelectorAll = (selector: string): object[] => {
        if (selector === "*") {
          if (index === 0) {
            beginPass();
            return countedArrayLike(hosts, chargeDiscoveryPull);
          }
          return countedArrayLike([], chargeDiscoveryPull);
        }
        if (selector.includes("style") || selector.includes("link")) {
          return countedArrayLike(ownerCandidates, chargeStylesheetPull);
        }
        return countedArrayLike([], chargeStylesheetPull);
      };
    }

    const snapshot = createRegistry(roots[0]!).snapshot();

    expect(discoveryPassPulls).toEqual([hosts.length, hosts.length]);
    expect(stylesheetPassPulls).toEqual([
      STYLESHEET_LIMITS.scopeSheetPairsPerSession,
      STYLESHEET_LIMITS.scopeSheetPairsPerSession,
    ]);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "scope-sheet-pair-limit",
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

    const stalePoll = [...intervals.values()][0];
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

    applicabilityCheck.mockClear();
    app.cssRules[0]!.cssText = ".a { color: green }";
    stalePoll?.();
    expect(registry.revisions).toEqual({
      documentEpoch: 8,
      stylesheetRevision: 0,
      stylesRevision: 0,
    });
    expect(applicabilityCheck).not.toHaveBeenCalled();
    [...intervals.values()][0]?.();
    expect(registry.revisions.stylesheetRevision).toBe(1);
    expect(applicabilityCheck).toHaveBeenLastCalledWith(true);

    registry.stopPolling();
    expect(intervals).toHaveLength(0);
    registry.dispose();
    expect(() => registry.snapshot()).toThrow(/disposed/i);
  });

  it.each(["stopPolling", "dispose"] as const)(
    "makes a captured fingerprint poll inert after %s and accepts only a fresh poll generation",
    (boundary) => {
      const intervals = new Map<number, () => void>();
      let nextHandle = 1;
      const setInterval = (callback: () => void) => {
        const handle = nextHandle++;
        intervals.set(handle, callback);
        return handle;
      };
      const clearInterval = (handle: number) => intervals.delete(handle);
      const invalidated = vi.fn();
      const applicabilityCheck = vi.fn();
      const app = sheet(
        "https://example.test/app.css",
        [styleRule(".a", "color:red")],
      );
      const document = scope("document", [app], [], []);
      const registry = createRegistry(document, {
        setInterval,
        clearInterval,
        onInvalidated: invalidated,
      });
      registry.startPolling(applicabilityCheck);
      const stalePoll = [...intervals.values()][0];

      if (boundary === "stopPolling") registry.stopPolling();
      else registry.dispose();
      expect(intervals).toHaveLength(0);

      app.cssRules[0]!.cssText = ".a { color: green }";
      stalePoll?.();
      expect(invalidated).not.toHaveBeenCalled();
      expect(applicabilityCheck).not.toHaveBeenCalled();
      if (boundary === "stopPolling") {
        expect(registry.revisions).toMatchObject({
          stylesheetRevision: 0,
          stylesRevision: 0,
        });
      }

      const freshRegistry = boundary === "stopPolling"
        ? registry
        : createRegistry(document, {
          setInterval,
          clearInterval,
          onInvalidated: invalidated,
        });
      freshRegistry.startPolling(applicabilityCheck);
      if (boundary === "dispose") {
        app.cssRules[0]!.cssText = ".a { color: blue }";
      }
      const freshPoll = [...intervals.values()][0];
      expect(freshPoll).not.toBe(stalePoll);
      freshPoll?.();

      expect(invalidated).toHaveBeenCalledOnce();
      expect(applicabilityCheck).toHaveBeenCalledOnce();
      expect(applicabilityCheck).toHaveBeenCalledWith(true);
      expect(freshRegistry.revisions).toMatchObject({
        stylesheetRevision: 1,
        stylesRevision: 1,
      });
      freshRegistry.dispose();
    },
  );

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

  it("binds inline rule identity to the element and stylesheet generation", () => {
    const document = scope("document", [], [], []);
    const registry = createRegistry(document);
    const firstElement = elementIn(document, new Set());
    const secondElement = elementIn(document, new Set());

    const first = registry.referenceInlineRule(firstElement);
    expect(registry.referenceInlineRule(firstElement)).toBe(first);
    expect(registry.referenceInlineRule(secondElement)).not.toBe(first);
    expect(registry.resolveRule(first)).toBe(firstElement);

    registry.invalidateApplicability("inline-selector-state");
    expect(registry.referenceInlineRule(firstElement)).toBe(first);
    registry.resetDocument(document as unknown as Document, 4);
    expect(registry.resolveRule(first)).toBeUndefined();
    expect(registry.referenceInlineRule(firstElement)).not.toBe(first);
  });

  it("excludes only exact runtime owners and sheets from inventory, digest, and mutations", () => {
    let mutationCallback: ((records: readonly unknown[]) => void) | undefined;
    const authorSheet = sheet(null, [styleRule(".author", "color: green")]);
    const spoofedOwner = styleOwner(".author { color: green; }", authorSheet);
    spoofedOwner.attributes["data-pin-op-runtime-artifact"] = "";
    const runtimeSheet = sheet(null, [styleRule(".runtime", "color: red")]);
    const runtimeOwner = styleOwner(".runtime { color: red; }", runtimeSheet);
    const document = scope(
      "document",
      [authorSheet, runtimeSheet],
      [runtimeSheet],
      [spoofedOwner, runtimeOwner],
    );
    const registry = createRegistry(document, {
      isRuntimeNode: (node) => node === runtimeOwner,
      isRuntimeStylesheet: (candidate) => candidate === runtimeSheet,
      createMutationObserver(callback) {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });

    expect(registry.snapshot().entries.map(({ sheet }) => sheet)).toEqual([authorSheet]);
    mutationCallback?.([{
      type: "childList",
      target: document,
      addedNodes: [runtimeOwner],
      removedNodes: [],
    }]);
    expect(registry.revisions).toMatchObject({ stylesheetRevision: 0, stylesRevision: 0 });

    const authorOwner = styleOwner(".late { color: blue; }", sheet(null, []));
    const runtimeDescendants = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      () => runtimeOwner,
    );
    const container = {
      tagName: "DIV",
      querySelectorAll: () => [...runtimeDescendants, authorOwner],
    };
    mutationCallback?.([{
      type: "childList",
      target: document,
      addedNodes: [container],
      removedNodes: [],
    }]);
    expect(registry.revisions).toMatchObject({ stylesheetRevision: 1, stylesRevision: 1 });
  });

  it.each(["sheet", "owner"] as const)(
    "fails closed with a partial inventory when runtime %s classification throws",
    (variant) => {
      const authorSheet = sheet(null, [styleRule(".author", "color: green")]);
      const authorOwner = styleOwner(".author { color: green; }", authorSheet);
      const document = scope("document", [authorSheet], [], [authorOwner]);
      const registry = createRegistry(document, {
        ...(variant === "sheet"
          ? {
              isRuntimeStylesheet(): boolean {
                throw new Error("sheet ownership unavailable");
              },
            }
          : {
              isRuntimeNode(): boolean {
                throw new Error("node ownership unavailable");
              },
            }),
      });

      expect(registry.snapshot()).toMatchObject({
        entries: [],
        partial: true,
        inaccessibleStylesheetCount: 1,
        diagnostics: [expect.objectContaining({
          code: "runtime-artifact-exclusion-failed",
        })],
      });
    },
  );

  it("reports partial inventory when exact runtime ownership cannot read ownerNode", () => {
    const artifacts = new PinOpRuntimeArtifacts({
      getRandomValues(bytes) {
        bytes.fill(8);
        return bytes;
      },
    });
    const authorSheet = sheet("https://example.test/author.css", [
      styleRule(".author", "color: green"),
    ]);
    Object.defineProperty(authorSheet, "ownerNode", {
      get() {
        throw new Error("owner identity unavailable");
      },
    });
    const document = scope("document", [authorSheet], [], []);
    const registry = createRegistry(document, {
      isRuntimeStylesheet: (candidate) => artifacts.isRuntimeStylesheet(candidate),
    });

    expect(registry.snapshot()).toMatchObject({
      entries: [],
      partial: true,
      inaccessibleStylesheetCount: 1,
      diagnostics: [expect.objectContaining({
        code: "runtime-artifact-exclusion-failed",
      })],
    });
  });

  it("invalidates and exposes a partial snapshot when mutation exclusion throws", () => {
    let mutationCallback: ((records: readonly unknown[]) => void) | undefined;
    let throwDuringMutation = false;
    const authorSheet = sheet(null, [styleRule(".author", "color: green")]);
    const authorOwner = styleOwner(".author { color: green; }", authorSheet);
    const document = scope("document", [authorSheet], [], [authorOwner]);
    const registry = createRegistry(document, {
      isRuntimeNode() {
        if (throwDuringMutation) throw new Error("mutation ownership unavailable");
        return false;
      },
      createMutationObserver(callback) {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });
    throwDuringMutation = true;

    mutationCallback?.([{
      type: "attributes",
      target: authorOwner,
      attributeName: "media",
    }]);

    expect(registry.revisions).toMatchObject({ stylesheetRevision: 1, stylesRevision: 1 });
    expect(registry.snapshot()).toMatchObject({
      entries: [],
      partial: true,
      diagnostics: [expect.objectContaining({
        code: "runtime-artifact-exclusion-failed",
      })],
    });
  });

  it("does not let runtime childList nodes exhaust author mutation authority", () => {
    let mutationCallback: ((records: readonly unknown[]) => void) | undefined;
    const runtimeOwner = styleOwner(".runtime {}", sheet(null, []));
    const authorOwner = styleOwner(".author {}", sheet(null, []));
    const document = scope("document", [], [], []);
    const registry = createRegistry(document, {
      isRuntimeNode: (node) => node === runtimeOwner,
      createMutationObserver(callback) {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });
    const runtimeNodes = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      () => runtimeOwner,
    );

    mutationCallback?.([{
      type: "childList",
      target: document,
      addedNodes: [...runtimeNodes, authorOwner],
      removedNodes: [],
    }]);

    expect(registry.revisions).toMatchObject({ stylesheetRevision: 1, stylesRevision: 1 });
  });

  it("does not let bounded exact runtime candidates hide an author sheet", () => {
    const runtimeSheet = sheet(null, []);
    const runtimeOwner = styleOwner("", runtimeSheet);
    const authorSheet = sheet(null, [styleRule(".author", "color: green")]);
    const authorOwner = styleOwner(".author { color: green; }", authorSheet);
    const runtimeOwners = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      () => runtimeOwner,
    );
    const runtimeSheets = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      () => runtimeSheet,
    );
    const document = scope(
      "document",
      [...runtimeSheets, authorSheet],
      [],
      [...runtimeOwners, authorOwner],
    );
    const registry = createRegistry(document, {
      isRuntimeNode: (node) => node === runtimeOwner,
      isRuntimeStylesheet: (candidate) => candidate === runtimeSheet,
    });

    expect(registry.snapshot()).toMatchObject({
      entries: [{ sheet: authorSheet }],
      partial: false,
      omittedScopeSheetPairCount: 0,
    });
    expect(registry.checkForChanges()).toBe(false);
    expect(registry.revisions).toMatchObject({ stylesheetRevision: 0, stylesRevision: 0 });
  });

  it("does not charge an iterable completion probe to author candidate authority", () => {
    const runtimeSheet = sheet(null, []);
    const authorSheets = Array.from(
      { length: STYLESHEET_LIMITS.scopeSheetPairsPerSession },
      (_, index) => sheet(`https://example.test/${index}.css`, []),
    );
    const document = scope("document", [], authorSheets, []);
    Object.defineProperty(document, "styleSheets", {
      configurable: true,
      value: {
        *[Symbol.iterator]() {
          yield runtimeSheet;
        },
      },
    });
    const registry = createRegistry(document, {
      isRuntimeStylesheet: (candidate) => candidate === runtimeSheet,
    });

    expect(registry.snapshot()).toMatchObject({
      partial: false,
      omittedScopeSheetPairCount: 0,
    });
    expect(registry.snapshot().entries).toHaveLength(authorSheets.length);
  });

  it("does not let exact runtime discovery nodes consume author scope authority", () => {
    const authorSheet = sheet(null, [styleRule(".shadow", "color: green")]);
    const authorOwner = styleOwner(".shadow { color: green; }", authorSheet);
    const authorShadow = scope("shadow", [authorSheet], [], [authorOwner]);
    const authorHost = host(authorShadow);
    const pageNodes = Array.from({ length: 3_840 }, () => ({}));
    const runtimeNodes = Array.from({ length: 256 }, () => ({}));
    const runtimeSet = new Set(runtimeNodes);
    const document = scope(
      "document",
      [],
      [],
      [...pageNodes, ...runtimeNodes, authorHost],
    );
    const registry = createRegistry(document, {
      isRuntimeNode: (node) => runtimeSet.has(node),
    });

    expect(registry.snapshot()).toMatchObject({
      entries: [{ sheet: authorSheet, scopeKind: "shadow-root" }],
      partial: false,
      omittedScopeCount: 0,
    });
  });

  it("keeps inherited import mount ownership separate from inline range ownership", () => {
    const imported = sheet(null, [styleRule(".imported", "color: green")]);
    const root = sheet(null, [importRule(imported)]);
    const owner = styleOwner(".imported { color: green; }", root);
    const registry = createRegistry(scope("document", [root], [], [owner]));
    const imports = registry.snapshot().entries.filter(({ kind }) => kind === "import");

    expect(imports).toHaveLength(1);
    expect(imports.every((entry) => entry.owner === owner)).toBe(true);
    expect(imports[0]?.generatedRanges).toEqual({});
  });

  it("snapshots nested import media/supports and marks layer provenance unsupported", () => {
    const leaf = sheet("https://example.test/leaf.css", []);
    const supportsImport = Object.assign(importRule(leaf), {
      supportsText: "(display: grid)",
    });
    const middle = sheet("https://example.test/middle.css", [supportsImport]);
    const mediaImport = Object.assign(importRule(middle), {
      media: { mediaText: "(min-width: 40rem)" },
    });
    const layered = sheet("https://example.test/layered.css", []);
    const layerImport = Object.assign(importRule(layered), { layerName: "theme" });
    const root = sheet("https://example.test/root.css", [mediaImport, layerImport]);
    const registry = createRegistry(scope("document", [root], [], []));
    const entries = registry.snapshot().entries;

    expect(entries.find(({ sheet }) => sheet === middle)?.importContexts).toEqual([
      { kind: "media", text: "(min-width: 40rem)" },
    ]);
    expect(entries.find(({ sheet }) => sheet === leaf)?.importContexts).toEqual([
      { kind: "media", text: "(min-width: 40rem)" },
      { kind: "supports", text: "(display: grid)" },
    ]);
    expect(entries.find(({ sheet }) => sheet === layered))
      .toMatchObject({ importContextUnsupported: true });
    const leafEntry = entries.find(({ sheet }) => sheet === leaf);
    expect(leafEntry?.origin).toMatchObject({
      kind: "external",
      sheet: root,
    });
    expect(leafEntry?.importChain).toEqual([
      expect.objectContaining({
        parentSheet: root,
        rule: mediaImport,
        ruleIndex: 0,
        importedSheet: middle,
        contexts: [{ kind: "media", text: "(min-width: 40rem)" }],
        unsupported: false,
      }),
      expect.objectContaining({
        parentSheet: middle,
        rule: supportsImport,
        ruleIndex: 0,
        importedSheet: leaf,
        contexts: [{ kind: "supports", text: "(display: grid)" }],
        unsupported: false,
      }),
    ]);
  });

  it("retains an adopted top sheet as the exact origin of imported entries", () => {
    const leaf = sheet("https://example.test/leaf.css", []);
    const exactImport = importRule(leaf);
    const root = sheet(null, [exactImport]);
    const registry = createRegistry(scope("document", [], [root], []));
    const leafEntry = registry.snapshot().entries.find(({ sheet }) => sheet === leaf);

    expect(leafEntry?.origin).toEqual({ kind: "adopted", sheet: root });
    expect(leafEntry?.importChain).toEqual([
      expect.objectContaining({
        parentSheet: root,
        rule: exactImport,
        ruleIndex: 0,
        importedSheet: leaf,
      }),
    ]);
  });

  it("snapshots stylesheet owner identity once per digest candidate", () => {
    const authorSheet = sheet("https://example.test/author.css", [
      styleRule(".author", "color: green"),
    ]);
    const owner = linkOwner(authorSheet, {
      rel: "stylesheet",
      href: "https://example.test/author.css",
    });
    let ownerReads = 0;
    Object.defineProperty(authorSheet, "ownerNode", {
      configurable: true,
      get() {
        ownerReads += 1;
        return owner;
      },
    });
    const registry = createRegistry(scope("document", [authorSheet], [], [owner]));
    registry.snapshot();
    ownerReads = 0;

    expect(registry.checkForChanges()).toBe(false);
    expect(ownerReads).toBe(1);
  });

  it.each([
    ["rel", INSPECT_LIMITS.valueLength],
    ["media", INSPECT_LIMITS.valueLength],
    ["href", INSPECT_LIMITS.urlLength],
  ] as const)("fails closed on an oversized owner %s value", (name, maximum) => {
    const authorSheet = sheet("https://example.test/author.css", [
      styleRule(".author", "color: green"),
    ]);
    const owner = linkOwner(authorSheet, {
      rel: "stylesheet",
      href: "https://example.test/author.css",
      [name]: "x".repeat(maximum + 1),
    });
    authorSheet.ownerNode = owner;
    const registry = createRegistry(scope("document", [authorSheet], [], [owner]));

    const snapshot = registry.snapshot();

    expect(snapshot).toMatchObject({
      partial: true,
      inaccessibleStylesheetCount: 1,
    });
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "stylesheet-inaccessible",
    }));
    expect(snapshot.entries[0]?.ownerState).toBeUndefined();
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
    childNodes: nodes,
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

function countedArrayLike<T>(values: T[], onPull: () => void): T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) onPull();
      return Reflect.get(target, key, receiver);
    },
  });
}
