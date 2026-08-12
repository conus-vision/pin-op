import { readFile } from "node:fs/promises";
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
        'class="pinop-path-miss"',
        'class="duplicate-selector"',
        'class="active-media-rule"',
        'class="runtime-injected-style"',
        'class="pinop-virtual-unmapped"',
        'class="pinop-external-readable"',
        'class="pinop-inaccessible-external"',
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
      ]) {
        expect(page).toContain(runtimeMarker);
      }
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

      const servedFallback = await responseText(
        new URL("fallback.css", servers.pageUrl),
      );
      const localFallback = await readFixtureFile("fallback.css");
      expect(servedFallback).not.toBe(localFallback);
      expect(servedFallback).toBe(
        [
          ".pinop-cssom-only {",
          "  --pinop-fixture-source: cssom;",
          "}",
          "",
          "@layer pinop-cssom-fixture {",
          localFallback,
          "}",
          "",
        ].join("\n"),
      );
      expect(servedFallback).toContain(".pinop-cssom-only");
      expect(servedFallback).toContain(".pinop-path-miss");
      expect(servedFallback).toContain(".duplicate-selector");
      expect(servedFallback.match(/\.duplicate-selector\s*\{/g)).toHaveLength(2);

      const virtualCss = await responseText(
        new URL("virtual.css", servers.pageUrl),
      );
      expect(virtualCss).toContain(".pinop-virtual-unmapped");

      const vendorResponse = await fetch(servers.vendorCssUrl);
      expect(vendorResponse.status).toBe(200);
      expect(vendorResponse.headers.get("access-control-allow-origin")).toBe(
        "*",
      );
      await expect(vendorResponse.text()).resolves.toContain(
        ".pinop-external-readable",
      );

      const inaccessibleResponse = await fetch(inaccessibleCssUrl);
      expect(inaccessibleResponse.status).toBe(200);
      expect(
        inaccessibleResponse.headers.get("access-control-allow-origin"),
      ).toBeNull();
      await expect(inaccessibleResponse.text()).resolves.toContain(
        ".pinop-inaccessible-external",
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
