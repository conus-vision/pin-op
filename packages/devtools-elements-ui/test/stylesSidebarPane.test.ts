import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  MatchedStylesSnapshot,
  RuleOriginDecoration,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
} from "../src/contracts.js";
import { ElementsInspectorView } from "../src/elementsInspectorView.js";
import { elementsSession } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Chromium-derived read-only Rules renderer", () => {
  it("renders inline, matched, and inherited sections with honest cascade detail", () => {
    const harness = createHarness();
    const sections = harness.rulesRoot.querySelectorAll(
      '[data-part="rules-section"]',
    );

    expect(sections.map((section) => section.getAttribute("data-section-kind")))
      .toEqual(["inline", "matched", "matched", "inherited"]);
    expect(sections.map((section) => section.textContent)).toEqual([
      expect.stringContaining("element.style"),
      expect.stringContaining(".card"),
      expect.stringContaining("button.secondary"),
      expect.stringContaining("html"),
    ]);

    const selectors = harness.rulesRoot.querySelectorAll(
      '[data-part="rule-selector"]',
    );
    expect(selectors.map((selector) => ({
      matched: selector.getAttribute("data-selector-matches"),
      text: selector.textContent,
    }))).toEqual([
      { matched: null, text: "element.style" },
      { matched: "true", text: ".card" },
      { matched: "false", text: '[data-label="<img src=x onerror=alert(1)>"]' },
      { matched: "true", text: "button.secondary" },
      { matched: "true", text: "html" },
    ]);

    const important = required(
      harness.rulesRoot.querySelector('[data-declaration-ref="decl:color"]'),
    );
    expect(important.textContent).toBe("color: rebeccapurple !important;");
    expect(important.getAttribute("data-declaration-state"))
      .toBe("winning-known-author");
    expect(important.getAttribute("title"))
      .toBe("Highest known author declaration; unavailable origins may still apply");

    const overridden = required(
      harness.rulesRoot.querySelector('[data-declaration-ref="decl:margin"]'),
    );
    expect(overridden.className.split(/\s+/)).toContain("overloaded");
    expect(overridden.getAttribute("title")).toBe("Overridden by a later author rule");

    const inactive = required(
      harness.rulesRoot.querySelector('[data-declaration-ref="decl:display"]'),
    );
    expect(inactive.className.split(/\s+/)).not.toContain("overloaded");
    expect(inactive.getAttribute("data-declaration-state")).toBe("inactive");

    const unknown = required(
      harness.rulesRoot.querySelector('[data-declaration-ref="decl:custom"]'),
    );
    expect(unknown.className.split(/\s+/)).toContain("rules-declaration-unknown");
    expect(unknown.getAttribute("title")).toBe("Cascade result is unknown");

    expect(harness.rulesRoot.querySelectorAll('[data-part="rule-context"]')
      .map((context) => ({
        kind: context.getAttribute("data-context-kind"),
        text: context.textContent,
      }))).toEqual([
      { kind: "media", text: "@media (width >= 40rem)" },
      { kind: "supports", text: "@supports (display: grid)" },
      { kind: "unknown", text: "@unknown page-controlled <script>alert(1)</script>" },
    ]);

    const origin = required(
      harness.rulesRoot.querySelector('[data-rule-origin="rule:card"]'),
    );
    expect(origin.tagName).toBe("SPAN");
    expect(origin.textContent).toBe("app.css:17:5");
    expect(origin.getAttribute("role")).toBeNull();
    expect(origin.getAttribute("tabindex")).toBeNull();

    expect(harness.rulesRoot.textContent).toContain("2 stylesheets inaccessible");
    expect(harness.rulesRoot.textContent).toContain("3 matching rules omitted");
    expect(harness.rulesRoot.textContent).toContain("Bounded scan was truncated");
    expect(harness.rulesRoot.querySelector('[data-diagnostic-severity="warning"]'))
      .not.toBeNull();

    expect(harness.document.createdTags()).not.toContain("img");
    expect(harness.document.createdTags()).not.toContain("script");
    expect(harness.document.innerHTMLAssignments()).toBe(0);
    expect(harness.document.outerHTMLAssignments()).toBe(0);
  });

  it("uses valid list ownership and labelled inherited groups", () => {
    const harness = createHarness();
    const ruleLists = harness.rulesRoot.querySelectorAll(
      '[data-part="rules-list"]',
    );

    expect(ruleLists).toHaveLength(2);
    for (const list of harness.rulesRoot.querySelectorAll('[role="list"]')) {
      expect(list.children.every((child) => (
        child.tagName === "LI" || child.getAttribute("role") === "listitem"
      ))).toBe(true);
    }

    const inheritedGroup = required(
      harness.rulesRoot.querySelector('[data-part="inherited-group"]'),
    );
    expect(inheritedGroup.tagName).toBe("SECTION");
    expect(inheritedGroup.getAttribute("role")).toBe("group");

    const headingId = required(inheritedGroup.getAttribute("aria-labelledby"));
    const heading = required(
      harness.document.document.getElementById(headingId) as unknown as FakeElement | null,
    );
    expect(inheritedGroup.contains(heading)).toBe(true);
    expect(
      /^H[1-6]$/.test(heading.tagName) || (
        heading.getAttribute("role") === "heading" &&
        heading.getAttribute("aria-level") !== null
      ),
    ).toBe(true);
  });

  it("keeps empty Rules status content outside list ownership", () => {
    const harness = createHarness(Object.freeze({
      state: "ready",
      matchedStyles: emptyMatchedStyles(),
    }));
    const status = required(harness.rulesRoot.querySelector('[role="status"]'));

    expect(status.textContent).toBe("No matching styles");
    expect(status.parentElement?.getAttribute("role")).not.toBe("list");
    for (const list of harness.rulesRoot.querySelectorAll('[role="list"]')) {
      expect(list.children.every((child) => (
        child.tagName === "LI" || child.getAttribute("role") === "listitem"
      ))).toBe(true);
    }
  });

  it("exposes current revision authority and a stable Rules probe without visible noise", () => {
    const initialStyles = richMatchedStyles();
    const harness = createHarness(Object.freeze({
      state: "ready",
      matchedStyles: initialStyles,
    }));

    expect(harness.rulesRoot.getAttribute("data-document-epoch")).toBe("2");
    expect(harness.rulesRoot.getAttribute("data-selection-revision")).toBe("5");
    expect(harness.rulesRoot.getAttribute("data-styles-revision")).toBe("8");
    expect(harness.rulesRoot.getAttribute("data-stylesheet-revision")).toBe("3");
    expect(harness.rulesRoot.getAttribute("data-pseudo-state-revision")).toBe("2");
    expect(harness.rulesRoot.getAttribute("data-pseudo-states")).toBe("hover focus");
    expect(harness.rulesRoot.getAttribute("data-probe-rule-ref")).toBe("rule:card");

    harness.rules.publish(Object.freeze({
      state: "ready",
      matchedStyles: deepFreeze({
        ...initialStyles,
        stylesRevision: 9,
        pseudoStateRevision: 3,
        pseudoStates: ["focus"],
      }),
    }));

    expect(harness.rulesRoot.getAttribute("data-styles-revision")).toBe("9");
    expect(harness.rulesRoot.getAttribute("data-stylesheet-revision")).toBe("3");
    expect(harness.rulesRoot.getAttribute("data-pseudo-state-revision")).toBe("3");
    expect(harness.rulesRoot.getAttribute("data-pseudo-states")).toBe("focus");
    expect(harness.rulesRoot.getAttribute("data-probe-rule-ref")).toBe("rule:card");

    harness.rules.publish(Object.freeze({ state: "loading" }));
    for (const attribute of [
      "data-document-epoch",
      "data-selection-revision",
      "data-styles-revision",
      "data-stylesheet-revision",
      "data-pseudo-state-revision",
      "data-pseudo-states",
      "data-probe-rule-ref",
    ]) {
      expect(harness.rulesRoot.getAttribute(attribute)).toBeNull();
    }
  });

  it("filters locally and keeps Chromium-style keyboard focus among visible sections", () => {
    const harness = createHarness();
    const sectionsRoot = required(
      harness.rulesRoot.querySelector('[data-part="rules-sections"]'),
    );
    const sections = harness.rulesRoot.querySelectorAll(
      '[data-part="rules-section"]',
    );
    const first = required(sections[0]);
    const second = required(sections[1]);

    first.focus();
    const down = sectionsRoot.dispatch("keydown", {
      key: "ArrowDown",
      target: first,
    });
    expect(down.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(second);
    expect(first.getAttribute("tabindex")).toBe("-1");
    expect(second.getAttribute("tabindex")).toBe("0");

    const filter = required(
      harness.rulesRoot.querySelector('[data-part="rules-filter"]'),
    ) as FakeElement & { value: string };
    expect(filter.tagName).toBe("INPUT");
    expect(filter.getAttribute("type")).toBe("search");
    expect(filter.getAttribute("aria-label")).toBe("Filter styles");
    filter.value = "font-family";
    filter.dispatch("input");

    expect(harness.rules.filterCalls).toEqual(["font-family"]);
    expect(sections.map((section) => section.hidden)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(required(sections[3]).getAttribute("tabindex")).toBe("0");

    filter.value = "<script>";
    filter.dispatch("input");
    expect(harness.rules.filterCalls).toEqual(["font-family", "<script>"]);
    expect(required(
      harness.rulesRoot.querySelector('[data-part="inherited-group"]'),
    ).hidden).toBe(true);
    expect(harness.document.createdTags()).not.toContain("script");
  });

  it("contains no mutation, editor, checkbox, popover, or write shortcut surface", () => {
    const harness = createHarness();

    expect(harness.rulesRoot.getAttribute("aria-readonly")).toBe("true");
    expect(harness.rulesRoot.querySelector('input[type="checkbox"]')).toBeNull();
    expect(harness.rulesRoot.querySelector("button")).toBeNull();
    expect(harness.rulesRoot.querySelector("[contenteditable]")).toBeNull();
    expect(harness.rulesRoot.querySelector('[data-action="add-rule"]')).toBeNull();
    expect(harness.rulesRoot.querySelector('[data-action="add-property"]')).toBeNull();
    expect(harness.rulesRoot.querySelector('[data-part="mutation-context-menu"]')).toBeNull();
    expect(harness.rulesRoot.querySelector('[data-part="value-popover"]')).toBeNull();
    expect(harness.rulesRoot.querySelector('[data-part="color-popover"]')).toBeNull();

    const origin = required(
      harness.rulesRoot.querySelector('[data-rule-origin="rule:card"]'),
    );
    origin.dispatch("click");
    const sectionsRoot = required(
      harness.rulesRoot.querySelector('[data-part="rules-sections"]'),
    );
    for (const key of ["Enter", " ", "Delete", "Backspace"]) {
      sectionsRoot.dispatch("keydown", { key, target: origin });
    }
    expect(harness.sourceLinks.openedRuleRefs).toEqual([]);

    for (const part of ["rule-selector", "property-name", "property-value"]) {
      for (const element of harness.rulesRoot.querySelectorAll(`[data-part="${part}"]`)) {
        expect(element.getAttribute("contenteditable")).toBeNull();
        expect(element.getAttribute("tabindex")).toBeNull();
      }
    }

    const derivedSources = [
      "StylesSidebarPane.ts",
      "StylePropertiesSection.ts",
      "StylePropertyTreeElement.ts",
      "PropertyRenderer.ts",
      "StylePropertyUtils.ts",
    ].map((file) => readFileSync(
      path.join(packageRoot, "src", "chromium", "rules", file),
      "utf8",
    )).join("\n");
    expect(derivedSources).not.toMatch(
      /\b(?:CSSModel|DOMModel|Linkifier|ContextMenu|Popover|contentEditable|setDisabled|setProperty|startEditing|addRule|addProperty|undo|redo)\b/,
    );
    expect(derivedSources).not.toMatch(/addEventListener\(["']contextmenu["']/);
  });

  it("makes an exact IDE origin the only click target and stops propagation", () => {
    const harness = createHarness();
    harness.sourceLinks.publish("rule:card", {
      label: "card.scss",
      languageId: "scss",
      startLine: 41,
      startColumn: 3,
      confidence: "sourcemap",
      clickable: true,
    });
    harness.rules.publish({
      state: "partial",
      matchedStyles: richMatchedStyles(),
    });

    const origin = required(
      harness.rulesRoot.querySelector('[data-rule-origin="rule:card"]'),
    );
    const section = required(
      harness.rulesRoot.querySelector('[data-rule-ref="rule:card"]'),
    );
    expect(origin.tagName).toBe("BUTTON");
    expect(origin.textContent).toBe("card.scss:41");
    expect(origin.getAttribute("type")).toBe("button");
    expect(origin.getAttribute("data-source-link-status")).toBe("ready");

    const click = origin.dispatch("click");
    expect(click.defaultPrevented).toBe(true);
    expect(click.propagationStopped).toBe(true);
    expect(harness.sourceLinks.openedRuleRefs).toEqual(["rule:card"]);

    section.dispatch("click");
    expect(harness.sourceLinks.openedRuleRefs).toEqual(["rule:card"]);
  });

  it.each(["pending", "stale", "incompatible"] as const)(
    "keeps generated evidence visible and non-clickable while Rules origin is %s",
    (state) => {
      const harness = createHarness();
      harness.sourceLinks.publish("rule:card", {
        label: "stale.scss",
        languageId: "scss",
        startLine: 99,
        startColumn: 1,
        confidence: "sourcemap",
        clickable: false,
        state,
      });
      harness.rules.publish({
        state: "partial",
        matchedStyles: richMatchedStyles(),
      });

      const origin = required(
        harness.rulesRoot.querySelector('[data-rule-origin="rule:card"]'),
      );
      expect(origin.tagName).toBe("SPAN");
      expect(origin.textContent).toBe("app.css:17:5");
      expect(origin.getAttribute("data-source-link-status")).toBe(state);
      origin.dispatch("click");
      expect(harness.sourceLinks.openedRuleRefs).toEqual([]);
    },
  );
});

class FakeRulesDataSource implements RulesDataSource {
  public readonly filterCalls: string[] = [];
  private readonly listeners = new Set<() => void>();

  public constructor(private current: RulesPresentationSnapshot) {}

  public snapshot(): RulesPresentationSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public filter(query: string): void {
    this.filterCalls.push(query);
  }

  public publish(snapshot: RulesPresentationSnapshot): void {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeSourceLinkDelegate implements SourceLinkDelegate {
  public readonly openedRuleRefs: string[] = [];
  private readonly origins = new Map<string, RuleOriginDecoration>();

  public originFor(ruleRef: string): RuleOriginDecoration | undefined {
    return this.origins.get(ruleRef);
  }

  public openRuleOrigin(ruleRef: string): void {
    this.openedRuleRefs.push(ruleRef);
  }

  public publish(ruleRef: string, origin: RuleOriginDecoration): void {
    this.origins.set(ruleRef, origin);
  }
}

function createHarness(
  snapshot: RulesPresentationSnapshot = Object.freeze({
    state: "partial",
    matchedStyles: richMatchedStyles(),
  }),
) {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  document.body.append(mount);
  const rules = new FakeRulesDataSource(snapshot);
  const sourceLinks = new FakeSourceLinkDelegate();
  const view = new ElementsInspectorView(
    document.document,
    mount as unknown as HTMLElement,
    new FakeElementsBackend(elementsSession.tree),
    rules,
    sourceLinks,
  );
  return {
    document,
    mount,
    rules,
    rulesRoot: view.rulesRoot as unknown as FakeElement,
    sourceLinks,
    view,
  };
}

function emptyMatchedStyles(): MatchedStylesSnapshot {
  return deepFreeze({
    documentEpoch: 2,
    selectionRevision: 5,
    stylesRevision: 8,
    stylesheetRevision: 3,
    pseudoStateRevision: 0,
    pseudoStates: [],
    nodeRef: "node:empty",
    matchedRules: [],
    inherited: [],
    inaccessibleStylesheetCount: 0,
    unsupportedRuleCount: 0,
    approximateRuleCount: 0,
    omittedRuleCount: 0,
    diagnostics: [],
  });
}

function richMatchedStyles(): MatchedStylesSnapshot {
  return deepFreeze({
    documentEpoch: 2,
    selectionRevision: 5,
    stylesRevision: 8,
    stylesheetRevision: 3,
    pseudoStateRevision: 2,
    pseudoStates: ["hover", "focus"],
    nodeRef: "node:card",
    inlineStyle: {
      ruleRef: "rule:inline",
      selectorText: "element.style",
      matchingSelectorIndices: [],
      declarations: [declaration("decl:inline", "display", "block")],
      contexts: [],
    },
    matchedRules: [
      {
        ruleRef: "rule:card",
        selectorText: '.card, [data-label="<img src=x onerror=alert(1)>"]',
        matchingSelectorIndices: [0],
        declarations: [
          declaration("decl:color", "color", "rebeccapurple", {
            important: true,
            stateReason: "Highest known author declaration; unavailable origins may still apply",
          }),
          declaration("decl:margin", "margin", "0", {
            state: "overridden-known-author",
            stateReason: "Overridden by a later author rule",
          }),
          declaration("decl:display", "display", "grid", {
            state: "inactive",
            stateReason: "Media query is inactive",
          }),
          declaration("decl:custom", "--accent", "var(--missing)", {
            state: "unknown",
            stateReason: "Cascade result is unknown",
          }),
        ],
        contexts: [
          { kind: "media", text: "(width >= 40rem)" },
          { kind: "supports", text: "(display: grid)" },
        ],
        generatedSource: {
          label: "app.css",
          lineNumber: 17,
          columnNumber: 5,
        },
      },
      {
        ruleRef: "rule:secondary",
        selectorText: "button.secondary",
        matchingSelectorIndices: [0],
        declarations: [declaration("decl:padding", "padding", "1rem")],
        contexts: [
          { kind: "unknown", text: "page-controlled <script>alert(1)</script>" },
        ],
      },
    ],
    inherited: [
      {
        nodeRef: "html",
        matchedRules: [
          {
            ruleRef: "rule:html",
            selectorText: "html",
            matchingSelectorIndices: [0],
            declarations: [declaration(
              "decl:font-family",
              "font-family",
              "system-ui",
            )],
            contexts: [],
          },
        ],
      },
    ],
    inaccessibleStylesheetCount: 2,
    unsupportedRuleCount: 1,
    approximateRuleCount: 1,
    omittedRuleCount: 3,
    diagnostics: [
      {
        code: "bounded-scan",
        severity: "warning",
        message: "Bounded scan was truncated",
      },
    ],
  });
}

function declaration(
  declarationRef: string,
  name: string,
  value: string,
  overrides: Partial<MatchedStylesSnapshot["matchedRules"][number]["declarations"][number]> = {},
) {
  return {
    declarationRef,
    name,
    value,
    important: false,
    state: "winning-known-author" as const,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Missing required Rules fixture node");
  }
  return value;
}
