import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { startExampleServers } from "../../../examples/basic-css/server.mjs";

interface FixtureSourceMap {
  readonly file: string;
  readonly mappings: string;
  readonly sources: string[];
}

describe("basic CSS example server", () => {
  it("serves the complete deterministic page and stylesheet matrix", async () => {
    const servers = await startFixtureServers();

    try {
      const page = await responseText(servers.pageUrl);
      const indexPage = await responseText(
        new URL("index.html", servers.pageUrl),
      );
      const externalOrigin = new URL(servers.vendorCssUrl).origin;
      const inaccessibleCssUrl = `${externalOrigin}/inaccessible.css`;

      expect(indexPage).toBe(page);
      for (const marker of [
        'id="dynamic-root"',
        'id="add-dynamic-node"',
        'id="open-shadow-host"',
        'id="same-origin-frame"',
        'id="cross-origin-frame"',
        'class="multiline-inline"',
        'id="normal-click-count"',
        'id="fixture-card"',
        'style="--inline-accent: #b42318"',
        'class="pin-op-path-miss"',
        'class="duplicate-selector"',
        'class="active-media-rule"',
        'class="runtime-injected-style"',
        'class="pin-op-virtual-unmapped"',
        'class="pin-op-external-readable"',
        'class="pin-op-inaccessible-external"',
        'id="specificity-target"',
        'id="important-target"',
        'id="inherited-parent"',
        'id="inherited-child"',
        'id="inactive-media-rule"',
        'id="inactive-supports-rule"',
        'id="nested-group-rule"',
        'id="document-adopted-target"',
        'class="document-adopted-target shared-constructed-target constructed-mutation-target"',
        'id="selector-applicability-checkbox"',
        'id="selector-applicability-field"',
        'id="selector-applicability-custom"',
        'id="sibling-applicability-root"',
        'id="slotted-applicability-node"',
      ]) {
        expect(page).toContain(marker);
      }
      for (const runtimeMarker of [
        'attachShadow({ mode: "open" })',
        'className: "shadow-action"',
        'getElementById("add-dynamic-node").addEventListener',
        'item.className = "dynamic-card"',
        'createElement("style")',
        'runtimeStyle.id = "runtime-injected-style"',
        'fixtureCard.addEventListener("click"',
        "new CSSStyleSheet()",
        "document.adoptedStyleSheets",
        "root.adoptedStyleSheets",
        "sharedConstructedSheet",
        "toggleEventlessStylesheet",
        "toggleEventlessApplicability",
        "toggleSiblingApplicability",
        "toggleSlottedApplicability",
        ".insertRule(",
        ".deleteRule(",
        ".replaceSync(",
        "cssomReplacementAlternate = !cssomReplacementAlternate",
        "ElementInternals",
      ]) {
        expect(page).toContain(runtimeMarker);
      }
      expect(page).toMatch(
        /shadowStyle\.textContent = `[\s\S]*?\.shadow-action:hover,[\s\S]*?\.shadow-action:focus[\s\S]*?`;/,
      );
      expect(page).toMatch(
        /\.sibling-applicability-anchor \+ \.sibling-applicability-target\s*\{[^}]*\}\s*\.selector-applicability-custom:state\(pin-op-active\)/,
      );
      expect(page).toContain(servers.vendorCssUrl);
      expect(page).toContain(`href="${inaccessibleCssUrl}"`);
      const stylesheetLinks = [...page.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
        .map((match) => match[0]);
      const vendorLink = stylesheetLinks.find((link) =>
        link.includes(`href="${servers.vendorCssUrl}"`)
      );
      const inaccessibleLink = stylesheetLinks.find((link) =>
        link.includes(`href="${inaccessibleCssUrl}"`)
      );
      expect(vendorLink).toContain('crossorigin="anonymous"');
      expect(inaccessibleLink).toBeDefined();
      expect(inaccessibleLink).not.toContain("crossorigin");
      expect(page).toContain('href="./dist/app.css"');
      expect(page).toContain('href="./fallback.css"');
      expect(page).toContain('href="./virtual.css"');
      expect(page).toMatch(
        /class="multiline-inline">\s*First deterministic line\.<br \/>\s*Second deterministic line\.\s*<\/span>/,
      );

      const appCssUrl = new URL("dist/app.css", servers.pageUrl);
      const sourceMapUrl = new URL("dist/app.css.map", servers.pageUrl);
      const appCss = await responseText(appCssUrl);
      const sourceMap = JSON.parse(
        await responseText(sourceMapUrl),
      ) as FixtureSourceMap;

      expect(appCss).toContain("sourceMappingURL=app.css.map");
      expect(appCss).toContain(".source-mapped-app");
      expect(appCss).toContain(".dynamic-card");
      expect(appCss).toContain(".multiline-inline");
      expect(appCss).toContain("font-family: Arial, sans-serif");
      expect(appCss).toContain("font-size: 16px");
      expect(appCss).toContain("line-height: 24px");
      expect(appCss).toContain("@media (min-width: 1px)");
      expect(appCss).toMatch(
        /\.specificity-target\s*\{[\s\S]*?\.fixture-section \.specificity-target\s*\{/,
      );
      expect(appCss).toMatch(
        /\.important-target\s*\{[\s\S]*?color:\s*#[0-9a-f]+\s*!important;/i,
      );
      expect(appCss).toMatch(
        /\.inherited-parent\s*\{[\s\S]*?font-family:/,
      );
      expect(appCss).toContain("@media (max-width: 1px)");
      expect(appCss).toContain("@supports (display: pin-op-unsupported-value)");
      expect(appCss).toMatch(
        /@supports \(display: grid\)[\s\S]*?@media \(min-width: 1px\)[\s\S]*?\.nested-group-rule/,
      );
      expect(sourceMap.file).toBe("app.css");
      expect(sourceMap.mappings.length).toBeGreaterThan(0);
      expect(sourceMap.sources).toEqual([
        "../src/card.scss",
        "../src/layout.scss",
        "../src/app.scss",
      ]);

      const servedSources = await Promise.all(
        sourceMap.sources.map((source) =>
          responseText(new URL(source, sourceMapUrl)),
        ),
      );
      const localSources = await Promise.all(
        ["card.scss", "layout.scss", "app.scss"].map((source) =>
          readFixtureFile(`src/${source}`),
        ),
      );
      expect(servedSources).toEqual(localSources);
      expect(localSources[2]).toContain("font-family: Arial, sans-serif");
      expect(localSources[2]).toContain("font-size: 16px");
      expect(localSources[2]).toContain("line-height: 24px");
      expect(localSources[0]).toContain(".specificity-target");
      expect(localSources[0]).toContain("!important");
      expect(localSources[1]).toContain(".inherited-parent");
      expect(localSources[1]).toContain("pin-op-unsupported-value");

      const servedFallback = await responseText(
        new URL("fallback.css", servers.pageUrl),
      );
      const localFallback = await readFixtureFile("fallback.css");
      expect(servedFallback).not.toBe(localFallback);
      expect(servedFallback).toBe(
        [
          ".pin-op-cssom-only {",
          "  --pin-op-fixture-source: cssom;",
          "}",
          "",
          "@layer pin-op-cssom-fixture {",
          localFallback,
          "}",
          "",
        ].join("\n"),
      );
      expect(servedFallback).toContain(".pin-op-cssom-only");
      expect(servedFallback).toContain(".pin-op-path-miss");
      expect(servedFallback).toContain(".duplicate-selector");
      expect(servedFallback.match(/\.duplicate-selector\s*\{/g)).toHaveLength(2);

      const virtualCss = await responseText(
        new URL("virtual.css", servers.pageUrl),
      );
      expect(virtualCss).toContain(".pin-op-virtual-unmapped");

      const vendorResponse = await fetch(servers.vendorCssUrl);
      expect(vendorResponse.status).toBe(200);
      expect(vendorResponse.headers.get("access-control-allow-origin")).toBe(
        "*",
      );
      await expect(vendorResponse.text()).resolves.toContain(
        ".pin-op-external-readable",
      );

      const inaccessibleResponse = await fetch(inaccessibleCssUrl);
      expect(inaccessibleResponse.status).toBe(200);
      expect(
        inaccessibleResponse.headers.get("access-control-allow-origin"),
      ).toBeNull();
      await expect(inaccessibleResponse.text()).resolves.toContain(
        ".pin-op-inaccessible-external",
      );

      const missingPageResource = await fetch(
        new URL("missing.css", servers.pageUrl),
      );
      const missingExternalResource = await fetch(
        `${externalOrigin}/missing.css`,
      );
      expect(missingPageResource.status).toBe(404);
      expect(missingExternalResource.status).toBe(404);
    } finally {
      await servers.stop();
    }
  });

  it("serves inspectable same-origin and locked cross-origin frames", async () => {
    const servers = await startFixtureServers();

    try {
      const page = await responseText(servers.pageUrl);
      const sameOriginFrameUrl = new URL(
        "frames/same-origin.html",
        servers.pageUrl,
      );
      const sameOriginCssUrl = new URL("same-origin.css", sameOriginFrameUrl);
      const externalOrigin = new URL(servers.vendorCssUrl).origin;
      const crossOriginFrameUrl = new URL(
        "/frames/cross-origin.html",
        externalOrigin,
      );
      const crossOriginCssUrl = new URL(
        "cross-origin.css",
        crossOriginFrameUrl,
      );

      expect(sameOriginFrameUrl.origin).toBe(new URL(servers.pageUrl).origin);
      expect(crossOriginFrameUrl.origin).not.toBe(
        new URL(servers.pageUrl).origin,
      );
      expect(page).toContain(`src="${sameOriginFrameUrl.pathname}"`);
      expect(page).toContain(`src="${crossOriginFrameUrl.href}"`);

      const sameOriginFrame = await responseText(sameOriginFrameUrl);
      const sameOriginCss = await responseText(sameOriginCssUrl);
      expect(sameOriginFrame).toContain('id="same-origin-frame-target"');
      expect(sameOriginFrame).toContain('href="./same-origin.css"');
      expect(sameOriginCss).toContain(".same-origin-frame-target");

      const crossOriginResponse = await fetch(crossOriginFrameUrl);
      expect(crossOriginResponse.status).toBe(200);
      expect(
        crossOriginResponse.headers.get("access-control-allow-origin"),
      ).toBeNull();
      await expect(crossOriginResponse.text()).resolves.toContain(
        'id="cross-origin-frame-target"',
      );
      const crossOriginCss = await responseText(crossOriginCssUrl);
      expect(crossOriginCss).toContain(".cross-origin-frame-target");
    } finally {
      await servers.stop();
    }
  });

  it("serves the static pseudo-preview fixture source contract across roots", async () => {
    const servers = await startFixtureServers();

    try {
      const page = await responseText(servers.pageUrl);
      const appCss = await responseText(
        new URL("dist/app.css", servers.pageUrl),
      );
      const sourceMap = JSON.parse(
        await responseText(new URL("dist/app.css.map", servers.pageUrl)),
      ) as FixtureSourceMap;
      const cardScss = await responseText(
        new URL("src/card.scss", servers.pageUrl),
      );
      const targetTag = page.match(
        /<button\b[^>]*id="pseudo-preview-target"[^>]*>/,
      )?.[0];
      const nonSelectedTag = page.match(
        /<button\b[^>]*id="pseudo-preview-non-selected"[^>]*>/,
      )?.[0];

      expect(targetTag).toBeDefined();
      expect(targetTag ?? "").toContain('class="pseudo-preview-action"');
      expect(targetTag ?? "").toContain('type="button"');
      expect(targetTag ?? "").not.toMatch(
        /\s(?:disabled|hidden|inert)(?=[\s=>])/iu,
      );
      expect(nonSelectedTag).toBeDefined();
      expect(nonSelectedTag ?? "").toContain('class="pseudo-preview-action"');
      expect(nonSelectedTag ?? "").toContain('type="button"');
      expect(nonSelectedTag ?? "").not.toMatch(
        /\s(?:disabled|hidden|inert)(?=[\s=>])/iu,
      );
      const ancestorTag = page.match(
        /<[^>]+id="pseudo-preview-ancestor"[^>]*>/,
      )?.[0];
      expect(ancestorTag).toBeDefined();
      expect(ancestorTag ?? "").toContain("pseudo-preview-scope");

      const hoverSelector = ".pseudo-preview-action:hover";
      const laterEqualSelector =
        ".pseudo-preview-scope .pseudo-preview-action";
      const appCases = [
        [hoverSelector, "--pin-op-preview-hover: active"],
        [".pseudo-preview-action:focus", "--pin-op-preview-focus: active"],
        [
          ".pseudo-preview-action:hover:focus",
          "--pin-op-preview-combined: active",
        ],
        [
          ".pseudo-preview-action:not(:hover)",
          "--pin-op-preview-unsupported-negation: active",
        ],
        [
          ".pseudo-preview-ancestor:hover .pseudo-preview-action",
          "--pin-op-preview-unsupported-ancestor: active",
        ],
        [
          ":is(.pseudo-preview-action:hover, #pseudo-preview-mixed-specificity-branch)",
          "--pin-op-preview-mixed-function: active",
        ],
      ] as const;
      for (const [selector, declaration] of appCases) {
        expect(cssRuleBody(appCss, selector)).toContain(declaration);
      }
      const hoverBody = cssRuleBody(appCss, hoverSelector);
      expect(hoverBody).toContain(
        "--pin-op-preview-source-order: hover-original",
      );
      expect(hoverBody).toContain(
        'url("../virtual.css?pin-op-preview-resource")',
      );
      expect(cssRuleBody(appCss, laterEqualSelector)).toContain(
        "--pin-op-preview-source-order: later-original",
      );
      expect(fixtureSpecificity(hoverSelector)).toEqual([0, 2, 0]);
      expect(fixtureSpecificity(laterEqualSelector)).toEqual([0, 2, 0]);
      expect(appCss.indexOf(`${hoverSelector} {`)).toBeLessThan(
        appCss.indexOf(`${laterEqualSelector} {`),
      );

      expect(cardScss).toContain(".pseudo-preview-action");
      expect(cardScss).toContain("pin-op-preview-resource");
      const cardSourceIndex = sourceMap.sources.indexOf("../src/card.scss");
      expect(cardSourceIndex).toBeGreaterThanOrEqual(0);
      const mappedSources = mappedSourceIndexesByGeneratedLine(
        sourceMap.mappings,
      );
      for (const [selector] of [
        ...appCases,
        [laterEqualSelector, ""],
      ] as const) {
        const generatedLine = generatedRuleLine(appCss, selector);
        expect(
          generatedLine,
          `${selector} must be emitted in app.css`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          mappedSources.get(generatedLine)?.has(cardSourceIndex),
          `${selector} must map back to src/card.scss`,
        ).toBe(true);
      }

      expect(cssRuleBody(page, ".same-origin-frame-target:hover"))
        .toContain("--pin-op-preview-frame-hover: active");
      expect(cssRuleBody(page, ".same-origin-frame-target:focus"))
        .toContain("--pin-op-preview-frame-focus: active");
      expect(page).toContain("installSameOriginPreviewFixture");
      expect(page).toContain("sameOriginFrame.contentDocument");
      expect(cssRuleBody(page, ".shadow-action:hover")).toContain(
        "--pin-op-preview-shadow-hover: active",
      );
      expect(cssRuleBody(page, ".shadow-action:focus")).toContain(
        "--pin-op-preview-shadow-focus: active",
      );
      expect(cssRuleBody(page, ".shadow-action:hover:focus")).toContain(
        "--pin-op-preview-shadow-combined: active",
      );
      expect(cssRuleBody(page, ".document-adopted-target:hover")).toContain(
        "--pin-op-preview-document-adopted: active",
      );
      expect(cssRuleBody(page, ".shadow-adopted-target:hover")).toContain(
        "--pin-op-preview-shadow-adopted: active",
      );
      expect(cssRuleBody(page, ".shared-constructed-target:hover:focus"))
        .toContain("--pin-op-preview-shared-constructed: active");

      expect(
        page.match(/const sharedConstructedSheet = new CSSStyleSheet\(\);/g),
      ).toHaveLength(1);
      const documentAdoption = page.match(
        /document\.adoptedStyleSheets\s*=\s*\[([\s\S]*?)\];/u,
      )?.[1];
      const shadowAdoption = page.match(
        /root\.adoptedStyleSheets\s*=\s*\[([\s\S]*?)\];/u,
      )?.[1];
      expect(documentAdoption).toBeDefined();
      expect(shadowAdoption).toBeDefined();
      expect(documentAdoption ?? "").toContain("sharedConstructedSheet");
      expect(shadowAdoption ?? "").toContain("sharedConstructedSheet");
      expect(documentAdoption ?? "").toContain("documentAdoptedSheet");
      expect(shadowAdoption ?? "").toContain("shadowAdoptedSheet");
    } finally {
      await servers.stop();
    }
  });

  it("serves a pristine static reload source contract with passive observability hooks", async () => {
    const servers = await startFixtureServers();

    try {
      // Static/server authority only. Installed native behavior remains a PARTIAL gate.
      const firstResponse = await fetch(servers.pageUrl);
      const firstPage = await firstResponse.text();
      const secondResponse = await fetch(new URL("?reload=1", servers.pageUrl));
      const secondPage = await secondResponse.text();

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(firstResponse.headers.get("cache-control")).toBe("no-store");
      expect(secondResponse.headers.get("cache-control")).toBe("no-store");
      expect(secondPage).toBe(firstPage);

      for (const counter of [
        "transition-count",
        "resource-count",
        "mutation-count",
        "input-event-count",
        "focus-event-count",
      ]) {
        expect(firstPage).toContain(
          `id="pseudo-preview-${counter}" aria-live="polite">0</output>`,
        );
        expect(secondPage).toContain(
          `id="pseudo-preview-${counter}" aria-live="polite">0</output>`,
        );
      }

      for (const hook of [
        "pinOpPseudoPreviewFixture",
        "readCounters",
        "readStyleSnapshot",
        "compareStyleSnapshots",
        "MutationObserver",
        "PerformanceObserver",
        'addEventListener("transitionrun"',
        '"beforeinput"',
        '"input"',
        '"focus"',
        '"focusin"',
        'getElementById("pseudo-preview-target")',
        'getElementById("pseudo-preview-non-selected")',
        "data-pin-op-preview-",
        "data-pin-op-runtime-",
        "pin-op-preview-resource",
      ]) {
        expect(firstPage).toContain(hook);
      }
      expect(firstPage).toMatch(
        /getComputedStyle\(pseudoPreviewTarget\)/u,
      );
      expect(firstPage).toMatch(
        /getComputedStyle\(pseudoPreviewNonSelected\)/u,
      );
      for (const comparedSide of [
        "before.selected",
        "after.selected",
        "before.nonSelected",
        "after.nonSelected",
      ]) {
        expect(firstPage).toContain(comparedSide);
      }
      const exposedFixtureApi = firstPage.match(
        /window\.pinOpPseudoPreviewFixture\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/u,
      )?.[1];
      expect(exposedFixtureApi).toBeDefined();
      for (const exposedHook of [
        "readCounters",
        "readStyleSnapshot",
        "compareStyleSnapshots",
      ]) {
        expect(exposedFixtureApi ?? "").toContain(exposedHook);
      }
      expect(firstPage).not.toContain(".dispatchEvent(");
      expect(firstPage).not.toContain(".focus(");

      for (const page of [firstPage, secondPage]) {
        const authoredMarkup = withoutEmbeddedCode(page);
        expect(authoredMarkup).not.toMatch(
          /\sdata-pin-op-preview-(?:selected|hover|focus)-[a-f0-9]{32}(?:=|\s|>)/,
        );
        expect(authoredMarkup).not.toMatch(
          /<style\b[^>]*\sdata-pin-op-runtime-[a-f0-9]{32}(?:=|\s|>)/,
        );
      }
    } finally {
      await servers.stop();
    }
  });

  it("mutates CustomStateSet through has and add/delete without events or attributes", async () => {
    const servers = await startFixtureServers();

    try {
      const page = await responseText(servers.pageUrl);
      const functionSource = page.match(
        /(function toggleEventlessApplicability\(\) \{[\s\S]*?\n      \})\n\n      function toggleSiblingApplicability/,
      )?.[1];

      expect(functionSource).toBeDefined();
      expect(functionSource).toContain(
        'supportsCustomStates.has("pin-op-active")',
      );
      expect(functionSource).toContain(
        'supportsCustomStates.add("pin-op-active")',
      );
      expect(functionSource).toContain(
        'supportsCustomStates.delete("pin-op-active")',
      );
      expect(functionSource).not.toContain("supportsCustomStates.toggle(");

      const activeStates = new Set<string>();
      const stateCalls: string[] = [];
      const eventCalls: string[] = [];
      const attributeCalls: string[] = [];
      const checkbox = {
        checked: false,
        indeterminate: false,
        dispatchEvent: () => eventCalls.push("checkbox"),
        setAttribute: () => attributeCalls.push("checkbox"),
      };
      const field = {
        value: "",
        customValidity: "",
        dispatchEvent: () => eventCalls.push("field"),
        setAttribute: () => attributeCalls.push("field"),
        setCustomValidity(value: string) {
          this.customValidity = value;
        },
      };
      const supportsCustomStates = {
        has(name: string) {
          stateCalls.push(`has:${name}`);
          return activeStates.has(name);
        },
        add(name: string) {
          stateCalls.push(`add:${name}`);
          activeStates.add(name);
        },
        delete(name: string) {
          stateCalls.push(`delete:${name}`);
          activeStates.delete(name);
        },
        toggle(name: string) {
          stateCalls.push(`toggle:${name}`);
        },
      };

      runInNewContext(
        `${functionSource}\ntoggleEventlessApplicability();\ntoggleEventlessApplicability();`,
        {
          document: {
            getElementById(id: string) {
              return id === "selector-applicability-checkbox"
                ? checkbox
                : field;
            },
          },
          supportsCustomStates,
        },
      );

      expect(stateCalls).toEqual([
        "has:pin-op-active",
        "add:pin-op-active",
        "has:pin-op-active",
        "delete:pin-op-active",
      ]);
      expect(activeStates).toEqual(new Set());
      expect(eventCalls).toEqual([]);
      expect(attributeCalls).toEqual([]);
    } finally {
      await servers.stop();
    }
  });

  it("stops both fixture origins cleanly and idempotently", async () => {
    const servers = await startFixtureServers();
    let stopped = false;

    try {
      await responseText(servers.pageUrl);
      await responseText(servers.vendorCssUrl);

      await servers.stop();
      stopped = true;
      await servers.stop();

      await expect(fetch(servers.pageUrl)).rejects.toThrow();
      await expect(fetch(servers.vendorCssUrl)).rejects.toThrow();
    } finally {
      if (!stopped) await servers.stop();
    }
  });
});

function startFixtureServers() {
  return startExampleServers({
    pagePort: 0,
    vendorPort: 0,
  });
}

async function readFixtureFile(path: string): Promise<string> {
  return readFile(
    new URL(`../../../examples/basic-css/${path}`, import.meta.url),
    "utf8",
  );
}

async function responseText(url: URL | string): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.text();
}

function withoutEmbeddedCode(page: string): string {
  return page
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "");
}

function cssRuleBody(css: string, selector: string): string {
  const prefix = `${selector} {`;
  const start = css.indexOf(prefix);
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0);
  if (start < 0) return "";
  const bodyStart = start + prefix.length;
  const end = css.indexOf("}", bodyStart);
  expect(end, `unterminated CSS rule ${selector}`).toBeGreaterThan(bodyStart);
  return end < 0 ? "" : css.slice(bodyStart, end);
}

function fixtureSpecificity(selector: string): readonly [number, number, number] {
  const ids = selector.match(/#[a-z0-9_-]+/giu)?.length ?? 0;
  const classes = selector.match(/\.[a-z0-9_-]+/giu)?.length ?? 0;
  const pseudoClasses = selector.match(/:(?!:)[a-z0-9_-]+/giu)?.length ?? 0;
  return [ids, classes + pseudoClasses, 0];
}

function generatedRuleLine(css: string, selector: string): number {
  const expected = `${selector} {`;
  return css.split(/\r?\n/u).findIndex((line) => line.trim() === expected);
}

function mappedSourceIndexesByGeneratedLine(
  mappings: string,
): ReadonlyMap<number, ReadonlySet<number>> {
  const result = new Map<number, Set<number>>();
  let sourceIndex = 0;

  for (const [generatedLine, line] of mappings.split(";").entries()) {
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const values = decodeSourceMapVlq(segment);
      if (values.length < 4) continue;
      sourceIndex += values[1] ?? 0;
      const sources = result.get(generatedLine) ?? new Set<number>();
      sources.add(sourceIndex);
      result.set(generatedLine, sources);
    }
  }

  return result;
}

function decodeSourceMapVlq(segment: string): readonly number[] {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values: number[] = [];
  let value = 0;
  let shift = 0;

  for (const character of segment) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error(`invalid source-map VLQ: ${character}`);
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) !== 0;
    const magnitude = value >>> 1;
    values.push(negative ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }

  if (shift !== 0) throw new Error("unterminated source-map VLQ");
  return values;
}
