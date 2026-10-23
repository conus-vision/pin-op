import { describe, expect, it } from "vitest";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceMatch,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import type { InspectTarget } from "@pin-op/protocol";
import {
  JAVASCRIPT_SCAN_LIMITS,
  JavaScriptSourcePlugin,
  ScriptReferenceCache,
  findScriptReferences,
  parseScriptReferences,
  selectorSubjects,
} from "../src/sourcePlugins/javascriptSourcePlugin.js";
import { withDomAttributeFacts } from "../src/sourcePlugins/domFacts.js";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";
import { adaptSourceDocument } from "../src/sourcePlugins/sourceDocument.js";
import { normalizeSourceDisplayLabel } from "../src/sourcePresentationMetadata.js";

const SCRIPT = [
  'import { debounce } from "./debounce.js";',
  "",
  'const hero = document.getElementById("hero");',
  'const cards = document.querySelectorAll(".card");',
  "",
  "export function open(card) {",
  '  card.classList.add("card--open");',
  '  hero.classList.toggle("is-active", true);',
  "}",
].join("\n");

const COMPONENT = [
  'import { cx } from "./cx";',
  "",
  "export function Hero({ title, wide }) {",
  "  return (",
  '    <section className="page">',
  '      <article id="hero" className={cx("card", wide && "card--wide")} data-block="hero">',
  '        <h1 className="card__title">{title}</h1>',
  "      </article>",
  "    </section>",
  "  );",
  "}",
].join("\n");

describe("JavaScriptSourcePlugin", () => {
  it("only claims JavaScript and TypeScript file documents and DOM evidence", () => {
    const plugin = new JavaScriptSourcePlugin();

    expect(plugin.id).toBe("pin-op.javascript");
    expect(plugin.displayName).toBe("Pin-op JavaScript");
    expect(plugin.documentSelectors).toEqual([
      { languageId: "javascript", scheme: "file" },
      { languageId: "javascriptreact", scheme: "file" },
      { languageId: "typescript", scheme: "file" },
      { languageId: "typescriptreact", scheme: "file" },
    ]);
    expect([...plugin.supportedFactKinds]).toEqual(["dom-attribute"]);
  });

  it("resolves a querySelector literal by class and keeps the match heuristic", async () => {
    const result = await resolve(SCRIPT, [
      target("selected", { tag: "article", classes: ["card"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      targetRole: "selected",
      kind: "source",
      relation: "matches",
      confidence: "heuristic",
      label: 'querySelectorAll(".card")',
      metadata: { evidence: "script-selector" },
    });
    expect(snippet(SCRIPT, result.matches[0]!)).toBe(
      'querySelectorAll(".card")',
    );
  });

  it("resolves getElementById and ranks id evidence above class evidence", async () => {
    const result = await resolve(SCRIPT, [
      target("selected", { tag: "section", id: "hero", classes: ["is-active"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches.map((match) => [
      match.label,
      match.metadata?.["evidence"],
    ])).toEqual([
      ['getElementById("hero")', "script-id"],
      ['classList.toggle("is-active")', "script-class"],
    ]);
    // A call with more arguments ends at the literal instead of running on.
    expect(snippets(SCRIPT, result.matches)).toEqual([
      'getElementById("hero")',
      'classList.toggle("is-active"',
    ]);
  });

  it("resolves a class a script adds through classList", async () => {
    const text = [
      'toggle.addEventListener("click", () => {',
      '  menu.classList.add("open");',
      "});",
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "nav", classes: ["menu", "open"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      label: 'classList.add("open")',
      metadata: { evidence: "script-class" },
    });
    expect(snippet(text, result.matches[0]!)).toBe('classList.add("open")');
  });

  it("rejects a selector whose subject the element does not match", async () => {
    const text = 'const title = document.querySelector(".card .title");';

    const card = await resolve(text, [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);
    expect(card.status).toBe("no-rule-match");
    expect(card.matches).toEqual([]);

    const title = await resolve(text, [
      target("selected", { tag: "h2", classes: ["title"] }),
    ]);
    expect(title.status).toBe("matched");
    expect(title.matches[0]?.label).toBe('querySelector(".card .title")');
  });

  it("requires the selector's tag and every literal constraint to hold", async () => {
    const text = [
      'const a = document.querySelector("span.card");',
      'const b = document.querySelector("div.card.featured");',
      'const c = document.querySelector("div.card[data-kind=\'promo\']");',
      'const d = document.querySelector("div.card:not(.hidden) > .x, #other, .card");',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", {
        tag: "div",
        classes: ["card"],
        attributes: { "data-kind": "news" },
      }),
    ]);

    // Only the selector list whose last alternative is a plain `.card` holds.
    expect(result.matches.map((match) => match.label)).toEqual([
      'querySelector("div.card:not(.hidden) > .x, #other, .card")',
    ]);
  });

  it("ignores text inside comments", async () => {
    const text = [
      '// document.querySelector(".card")',
      '/* $(".card").addClass("active"); */',
      "const count = 1;",
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "div", classes: ["card", "active"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
  });

  it("reads template literals and never compares what a substitution wrote", async () => {
    const text = [
      "const title = root.querySelector(`#${id} .card__title`);",
      "const variant = root.querySelector(`.card--${variant}`);",
      'el.className = `card ${open ? "card--open" : ""}`;',
    ].join("\n");

    const title = await resolve(text, [
      target("selected", { tag: "h2", classes: ["card__title"] }),
    ]);
    expect(title.matches.map((match) => match.label)).toEqual([
      'querySelector("#... .card__title")',
    ]);
    expect(snippet(text, title.matches[0]!)).toBe(
      "querySelector(`#${id} .card__title`)",
    );

    const card = await resolve(text, [
      target("selected", { tag: "div", classes: ["card", "card--open"] }),
    ]);
    // `.card--${variant}` names no literal class, so only the assignment -
    // whose template and branch literals are alternatives - matches.
    expect(card.matches.map((match) => match.label)).toEqual([
      'className="card ... card--open"',
    ]);
    expect(snippet(text, card.matches[0]!)).toBe(
      'className = `card ${open ? "card--open" : ""}`',
    );
  });

  it("reads each branch of a conditional class assignment as an alternative", async () => {
    const text = [
      'nav.className = open ? "menu menu--open" : "menu";',
      'nav.dataset.state = "open";',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", {
        tag: "nav",
        classes: ["menu"],
        attributes: { "data-state": "open" },
      }),
    ]);

    expect(result.matches.map((match) => [
      match.label,
      match.metadata?.["evidence"],
    ])).toEqual([
      ['className="menu menu--open"', "script-class"],
      ['dataset.state="open"', "script-attribute"],
    ]);
    expect(snippets(text, result.matches)).toEqual([
      'className = open ? "menu menu--open" : "menu"',
      'dataset.state = "open"',
    ]);
  });

  it("resolves both the selected element and its parent independently", async () => {
    const text = [
      'const list = document.querySelector("ul.menu");',
      'list.querySelectorAll(".menu__item").forEach((item) => item.classList.add("is-ready"));',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "li", classes: ["menu__item", "is-ready"] }),
      target("parent", { tag: "ul", classes: ["menu"] }),
    ]);

    expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual([
      ["selected", 'querySelectorAll(".menu__item")'],
      ["selected", 'classList.add("is-ready")'],
      ["parent", 'querySelector("ul.menu")'],
    ]);
  });

  it("lists the strongest references first and caps a target at eight", async () => {
    const text = [
      ...Array.from(
        { length: 10 },
        (_, index) => `rows[${index}].classList.toggle("row");`,
      ),
      'const current = document.getElementById("current-row");',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "tr", id: "current-row", classes: ["row"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(8);
    // The id reference is last in the document but survives the cap.
    expect(result.matches.at(-1)).toMatchObject({
      label: 'getElementById("current-row")',
      metadata: { evidence: "script-id" },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "javascript.referencesLimited",
        severity: "info",
      }),
    ]);
  });

  it("resolves data attributes through selectors, dataset, and jQuery", async () => {
    const text = [
      'const slider = $("#home_slider");',
      'const columns = slider.data("slides-col");',
      "const blocks = document.querySelectorAll('[data-block=\"hero\"]');",
      "const state = panel.dataset.panelState;",
      '$(".home_slide").addClass("home_slide_active");',
    ].join("\n");

    const slider = await resolve(text, [
      target("selected", {
        tag: "div",
        id: "home_slider",
        attributes: { "data-slides-col": "4" },
      }),
    ]);
    expect(slider.matches.map((match) => [
      match.label,
      match.metadata?.["evidence"],
    ])).toEqual([
      ['$("#home_slider")', "script-selector"],
      ['data("slides-col")', "script-attribute"],
    ]);

    const block = await resolve(text, [
      target("selected", {
        tag: "section",
        attributes: { "data-block": "hero", "data-panel-state": "open" },
      }),
    ]);
    expect(block.matches.map((match) => match.label)).toEqual([
      "querySelectorAll('[data-block=\"hero\"]')",
      "dataset.panelState",
    ]);

    const teaser = await resolve(text, [
      target("selected", { tag: "section", attributes: { "data-block": "teaser" } }),
    ]);
    expect(teaser.status).toBe("no-rule-match");

    const slide = await resolve(text, [
      target("selected", {
        tag: "div",
        classes: ["home_slide", "home_slide_active"],
      }),
    ]);
    expect(slide.matches.map((match) => match.label)).toEqual([
      '$(".home_slide")',
      'addClass("home_slide_active")',
    ]);
  });

  it("stops before the abort deadline without returning partial matches", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new JavaScriptSourcePlugin().resolve({
      selection: selection([target("selected", { tag: "section", id: "hero" })]),
      document: scriptDocument(SCRIPT),
      workspace: workspace(),
      signal: controller.signal,
    });

    expect(result.matches).toEqual([]);
  });

  it("reports no rule match for a target without DOM identity", async () => {
    const result = await resolve(SCRIPT, [{
      role: "selected",
      depth: 0,
      subject: { selector: "article", metadata: { tag: "article" } },
      facts: [],
      metadata: {},
    }]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports a truncated scan when a large script yields no match", async () => {
    const padding = "// padding\n".repeat(
      Math.ceil(JAVASCRIPT_SCAN_LIMITS.maxLength / 11),
    );
    const result = await resolve(`${padding}document.querySelector(".card");`, [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.diagnostics?.map((entry) => entry.code)).toEqual([
      "javascript.documentTruncated",
    ]);
  });

  it("keeps every label within what the browser boundary displays", async () => {
    const text = [
      SCRIPT,
      COMPONENT,
      'el.className = "card card--open";',
      "const html = `<article class=\"card\" data-block=\"hero\"></article>`;",
      "const cols = el.dataset.slidesCol;",
    ].join("\n");
    const result = await resolve(text, [
      target("selected", {
        tag: "article",
        id: "hero",
        classes: ["card", "card--open", "card--wide"],
        attributes: { "data-block": "hero", "data-slides-col": "3" },
      }),
    ]);

    expect(result.matches.length).toBeGreaterThan(4);
    for (const match of result.matches) {
      expect(match.label.length).toBeLessThanOrEqual(96);
      expect(
        normalizeSourceDisplayLabel(match.label, "fallback", {
          kind: "source",
          relation: "matches",
          trustedStyleSelector: false,
        }),
      ).toBe(match.label);
    }
  });
});

describe("JavaScriptSourcePlugin on JSX", () => {
  it("resolves a JSX element from its tag and literal attributes together", async () => {
    const result = await resolve(COMPONENT, [
      target("selected", {
        tag: "article",
        id: "hero",
        classes: ["card", "card--wide"],
        attributes: { "data-block": "hero" },
      }),
    ], "javascriptreact");

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      label: "article#hero.card.card--wide",
      metadata: { evidence: "script-markup" },
    });
    expect(snippet(COMPONENT, result.matches[0]!)).toBe(
      '<article id="hero" className={cx("card", wide && "card--wide")} data-block="hero">',
    );
  });

  it("matches a JSX className the browser extended with runtime classes", async () => {
    const result = await resolve(COMPONENT, [
      target("selected", { tag: "h1", classes: ["card__title", "is-visible"] }),
      target("parent", { tag: "article", id: "hero", classes: ["card"] }),
    ], "typescriptreact");

    expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual([
      ["selected", "h1.card__title"],
      ["parent", "article#hero.card.card--wide"],
    ]);
  });

  it("rejects a JSX element whose tag or literal attribute contradicts the DOM", async () => {
    const heading = await resolve(COMPONENT, [
      target("selected", { tag: "h2", classes: ["card__title"] }),
    ], "javascriptreact");
    expect(heading.status).toBe("no-rule-match");

    const teaser = await resolve(COMPONENT, [
      target("selected", {
        tag: "article",
        id: "hero",
        classes: ["card"],
        attributes: { "data-block": "teaser" },
      }),
    ], "javascriptreact");
    expect(teaser.status).toBe("no-rule-match");
  });

  it("keeps a label's htmlFor pointing at the field rather than at the label", async () => {
    const text = [
      "export const Field = () => (",
      "  <>",
      '    <label htmlFor="email" className="field__label">Email</label>',
      '    <input id="email" className="field__input" />',
      "  </>",
      ");",
    ].join("\n");

    const input = await resolve(text, [
      target("selected", { tag: "input", id: "email", classes: ["field__input"] }),
    ], "typescriptreact");
    expect(input.matches.map((match) => match.label)).toEqual([
      'htmlFor="email"',
      "input#email.field__input",
    ]);

    const label = await resolve(text, [
      target("selected", { tag: "label", classes: ["field__label"] }),
    ], "typescriptreact");
    expect(label.matches.map((match) => match.label)).toEqual([
      "label.field__label",
    ]);
  });
});

describe("parseScriptReferences", () => {
  it("does not let regular expressions, division, or JSX text derail the scan", async () => {
    const text = [
      "const quote = /[\"']/g;",
      "const ratio = width / height / 2;",
      "const note = <p>Don't panic</p>;",
      'const card = document.querySelector(".card");',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "div", classes: ["card"] }),
    ], "javascriptreact");

    expect(result.matches.map((match) => match.label)).toEqual([
      'querySelector(".card")',
    ]);
  });

  it("does not read prose, paths, or versions as selectors", async () => {
    const text = [
      'import "./card.css";',
      'throw new Error("Could not find .card in the page");',
      'const version = "1.2.3";',
      'console.log("e.g. .card");',
    ].join("\n");
    const result = await resolve(text, [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
  });

  it("reads markup a script writes into string and template literals", async () => {
    const text = [
      "list.innerHTML = items.map((item) => `",
      '  <li class="menu__item ${item.active ? "is-active" : ""}" data-id="${item.id}">${item.label}</li>`).join("");',
      "$('<div class=\"toast\" role=\"status\">').appendTo(document.body);",
      'const hint = "<p class=\\"hint\\">Hi</p>";',
    ].join("\n");

    const item = await resolve(text, [
      target("selected", {
        tag: "li",
        classes: ["menu__item", "is-active"],
        attributes: { "data-id": "7" },
      }),
    ]);
    expect(item.matches).toHaveLength(1);
    expect(item.matches[0]).toMatchObject({
      label: "li.menu__item",
      metadata: { evidence: "script-markup" },
    });
    expect(snippet(text, item.matches[0]!)).toBe(
      '<li class="menu__item ${item.active ? "is-active" : ""}" data-id="${item.id}">',
    );

    const toast = await resolve(text, [
      target("selected", { tag: "div", classes: ["toast"], attributes: { role: "status" } }),
    ]);
    expect(snippets(text, toast.matches)).toEqual([
      '<div class="toast" role="status">',
    ]);

    const hint = await resolve(text, [
      target("selected", { tag: "p", classes: ["hint"] }),
    ]);
    // Escapes are decoded for the comparison but the range stays raw.
    expect(snippets(text, hint.matches)).toEqual(['<p class=\\"hint\\">']);
  });

  it("parses selector lists down to each selector's subject", () => {
    expect(selectorSubjects(".a > .b, #c")).toEqual([
      { tag: undefined, ids: [], classes: ["b"], attributes: [] },
      { tag: undefined, ids: ["c"], classes: [], attributes: [] },
    ]);
    expect(selectorSubjects("li:not(.done) .md\\:flex[data-x='1' i]")).toEqual([
      {
        tag: undefined,
        ids: [],
        classes: ["md:flex"],
        attributes: [
          { name: "data-x", operator: "=", value: "1", caseInsensitive: true },
        ],
      },
    ]);
    expect(selectorSubjects("button")).toBeUndefined();
    expect(selectorSubjects("ul li")).toBeUndefined();
    expect(selectorSubjects("Could not find .card")).toBeUndefined();
    expect(selectorSubjects("./card.css")).toBeUndefined();
    expect(selectorSubjects("#")).toBeUndefined();
  });

  it("stays linear on hostile input and survives unterminated literals", () => {
    const start = performance.now();
    for (const text of [
      `const s = "${"<a".repeat(20_000)}=";`,
      "`${".repeat(10_000),
      "(".repeat(50_000),
      "x = /abc\n".repeat(20_000),
      "'\n".repeat(50_000),
      'const s = `abc ${x + "q"',
      // Each `/` could open a regular expression whose class never closes.
      "/[\\];".repeat(50_000),
    ]) {
      expect(() => parseScriptReferences(text)).not.toThrow();
    }
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it("still reads regular expressions after stray slashes on other lines", () => {
    const text = [
      "/[\\];".repeat(20),
      'const pattern = /\.card/; document.querySelector(".card");',
    ].join("\n");
    const found = findScriptReferences(parseScriptReferences(text), {
      tag: "div",
      id: undefined,
      classes: ["card"],
      attributes: new Map(),
    });
    expect(found.references.map((reference) => reference.label))
      .toEqual(['querySelector(".card")']);
  });

  it("caches a parse per document version", () => {
    const cache = new ScriptReferenceCache();
    const first = cache.parseDocument(scriptDocument(SCRIPT));

    expect(cache.parseDocument(scriptDocument(SCRIPT))).toBe(first);
    expect(
      cache.parseDocument(scriptDocument(`${SCRIPT}\n`, "javascript", 2)),
    ).not.toBe(first);
  });
});

describe("JavaScriptSourcePlugin in the source registry", () => {
  it("publishes matches the registry accepts, including CRLF documents", async () => {
    const text = COMPONENT.replaceAll("\n", "\r\n");
    const registry = new SourcePluginRegistry();
    registry.register(new JavaScriptSourcePlugin());

    const dispatch = await registry.resolve(
      selection([
        target("selected", { tag: "h1", classes: ["card__title"] }),
        target("parent", { tag: "article", id: "hero", classes: ["card"] }),
      ]),
      scriptDocument(text, "typescriptreact"),
      workspace(),
      new AbortController().signal,
    );

    expect(dispatch.kind).toBe("resolved");
    if (dispatch.kind !== "resolved") return;
    expect(dispatch.candidates).toEqual([
      expect.objectContaining({
        pluginId: "pin-op.javascript",
        status: "matched",
        diagnostics: [],
      }),
    ]);
    expect(dispatch.resolution.matches.map((match) => [
      match.targetRole,
      match.kind,
      match.relation,
      snippet(text, match),
    ])).toEqual([
      ["parent", "source", "matches", '<article id="hero" className={cx("card", wide && "card--wide")} data-block="hero">'],
      ["selected", "source", "matches", '<h1 className="card__title">'],
    ]);
  });

  it("reports a miss as a status the registry accepts from a plugin", async () => {
    const registry = new SourcePluginRegistry();
    registry.register(new JavaScriptSourcePlugin());

    const dispatch = await registry.resolve(
      selection([
        target("selected", { tag: "div", classes: ["absent"] }),
        {
          role: "parent",
          depth: 1,
          subject: { selector: "body", metadata: { tag: "body" } },
          facts: [],
          metadata: {},
        },
      ]),
      scriptDocument(SCRIPT),
      workspace(),
      new AbortController().signal,
    );

    expect(dispatch.kind).toBe("resolved");
    if (dispatch.kind !== "resolved") return;
    expect(dispatch.candidates).toEqual([
      expect.objectContaining({
        pluginId: "pin-op.javascript",
        status: "no-rule-match",
        diagnostics: [],
      }),
    ]);
  });
});

async function resolve(
  text: string,
  targets: readonly InspectTarget[],
  languageId = "javascript",
) {
  return new JavaScriptSourcePlugin().resolve({
    selection: selection(targets),
    document: scriptDocument(text, languageId),
    workspace: workspace(),
    signal: new AbortController().signal,
  });
}

function selection(targets: readonly InspectTarget[]): SelectionSnapshot {
  return {
    sessionId: "session-a",
    messageId: "inspect-a",
    targets: withDomAttributeFacts(targets),
    ruleEvidence: { rules: [], omittedRuleCount: 0 },
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
  };
}

function target(
  role: "selected" | "parent",
  identity: {
    readonly tag: string;
    readonly id?: string;
    readonly classes?: readonly string[];
    readonly attributes?: Readonly<Record<string, string>>;
  },
): InspectTarget {
  const attributes = Object.entries(identity.attributes ?? {}).map(
    ([name, value]) => ({ name, value, metadata: {} }),
  );
  return {
    role,
    depth: role === "selected" ? 0 : 1,
    subject: {
      selector: identity.tag,
      ...(identity.id ? { nodeId: identity.id } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
      metadata: {
        tag: identity.tag,
        id: identity.id ?? "",
        classes: identity.classes ?? [],
        pageUrl: "https://example.test/page",
      },
    },
    facts: [],
    metadata: {},
  };
}

function scriptDocument(
  text: string,
  languageId = "javascript",
  version = 1,
): SourceDocument {
  return adaptSourceDocument({
    uri: { toString: () => "file:///workspace/src/app.js" },
    languageId,
    version,
    getText: () => text,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
  });
}

function workspace(): SourceWorkspace {
  return {
    findFiles: async () => [],
    readText: async () => "",
    resolveSourceUri: async () => ({
      status: "not-found",
      uris: [],
      strategy: "workspace-bound",
    }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function snippets(
  text: string,
  matches: readonly SourceMatch[],
): readonly string[] {
  return matches.map((match) => snippet(text, match));
}

function snippet(text: string, match: SourceMatch): string {
  const document = scriptDocument(text);
  return text.slice(
    document.offsetAt(match.range.start),
    document.offsetAt(match.range.end),
  );
}
