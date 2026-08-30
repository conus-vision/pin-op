import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inspectorHtml = readFileSync(
  new URL("../assets/inspector-panel.html", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const inspector = load(inspectorHtml);
const STATUS_TOKENS = [
  "--status-success",
  "--status-info",
  "--status-warning",
  "--status-error",
] as const;

describe("DevTools panel assets", () => {
  it("checks out the pinned Inspector asset with LF endings", () => {
    const attributes = readFileSync(
      new URL("../.gitattributes", import.meta.url),
      "utf8",
    );

    expect(attributes.split(/\r?\n/u)).toContain(
      "assets/inspector-panel.html text eol=lf",
    );
  });

  it("ships a separate fixed Inspector asset with the existing toolbar contract", () => {
    for (const id of [
      "toolbar-features",
      "connection-status",
      "linked-code",
      "link-controls",
      "link-code",
      "paste-button",
      "link-button",
      "disconnect-button",
      "inspect-mode",
      "refresh-styles",
      "auto-refresh-enabled",
      "ide-highlight-enabled",
      "protocol-mismatch",
      "protocol-mismatch-versions",
      "inspector-workspace",
      "inspector-elements-mount",
      "inspector-status",
      "operational-footer",
      "selected-element-summary",
      "resolution-status",
      "panel-error",
    ]) {
      expect(inspector(`[id="${id}"]`)).toHaveLength(1);
    }
    expect(inspector("#source-tab, #source-pane, #source-pane-root")).toHaveLength(0);
    expect(inspectorHtml).not.toMatch(/>\s*Source\s*</i);
    expect(inspector("#inspector-elements-mount").attr("aria-label"))
      .toBe("Elements inspector mount");
    expect(inspector('link[href="./panel.css"]')).toHaveLength(1);
    expect(inspector('link[href="./devtools-elements.css"]')).toHaveLength(1);
    const inspectorBootstrap = inspector('script[src="./inspectorPanel.js"]');
    expect(inspectorBootstrap).toHaveLength(1);
    expect(inspectorBootstrap.attr("type")).toBe("module");
    expect(inspector('script[type="module"]')).toHaveLength(1);
    expect(inspector("#refresh-styles").attr("aria-label")).toBe("Refresh styles");
    expect(inspector("#refresh-styles").attr("title")).toBe("Refresh styles");
    expect(inspector("#refresh-styles").is(":disabled")).toBe(true);
    expect(inspector("#refresh-styles [data-lucide=\"refresh-cw\"]"))
      .toHaveLength(1);
    expect(inspectorHtml).not.toContain("location.search");
  });

  it("names the product and its author on one line under the status row", () => {
    const credit = inspector("#panel-credit");

    expect(credit).toHaveLength(1);
    expect(inspector("#inspector-status + #panel-credit.panel-credit"))
      .toHaveLength(1);
    expect(credit.text().replace(/\s+/g, " ").trim()).toBe(
      "Pin-op by Volodymyr Moskvin (info@conus.vision) (c) Conus Vision " +
        "(https://conus.vision)",
    );
    expect(inspector("#panel-credit-mail").attr("href"))
      .toBe("mailto:info@conus.vision");
    const site = inspector("#panel-credit-site");
    expect(site.attr("href")).toBe("https://conus.vision");
    expect(site.attr("rel")).toBe("noreferrer noopener");

    const strip = ruleDeclarations(
      /\.panel-credit\s*\{([^}]*)\}/s,
      "Inspector credit strip",
    );
    expect(strip).toMatch(/grid-area:\s*credit;/);
    expect(strip).toMatch(/justify-content:\s*flex-end;/);
    expect(strip).toMatch(/max-height:\s*18px;/);
    expect(strip).toMatch(/overflow:\s*hidden;/);
  });

  it("keeps the Inspector shell compact without onboarding", () => {
    expect(inspector("main.panel-layout.inspector-panel-layout")).toHaveLength(1);
    expect(inspector("#link-onboarding, .link-onboarding")).toHaveLength(0);
    expect(inspector("#panel-branding")).toHaveLength(0);
    expect(inspector("#inspector-workspace + #inspector-status.inspector-status"))
      .toHaveLength(1);
    expect(inspector("#inspector-status").attr("role")).toBe("group");
    expect(inspector("#inspector-status").attr("aria-label"))
      .toBe("Inspector status");
    expect(inspector("#inspector-status > #operational-footer")).toHaveLength(1);
    expect(inspector("#inspector-status > #panel-error")).toHaveLength(1);

    const layout = ruleDeclarations(
      /\.inspector-panel-layout\s*\{([^}]*)\}/s,
      "Inspector panel layout",
    );
    expect(layout).toMatch(
      /grid-template-areas:\s*"toolbar"\s*"protocol"\s*"workspace"\s*"status"\s*"credit";/s,
    );
    expect(layout).toMatch(
      /grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) minmax\(0,\s*26px\) minmax\(0,\s*18px\);/,
    );

    const toolbar = ruleDeclarations(
      /\.inspector-panel-layout\s+\.panel-toolbar\s*\{([^}]*)\}/s,
      "Inspector toolbar",
    );
    expect(toolbar).toMatch(/min-height:\s*32px;/);
    expect(toolbar).toMatch(/padding:\s*2px 4px;/);

    const status = ruleDeclarations(
      /\.inspector-status\s*\{([^}]*)\}/s,
      "Inspector status",
    );
    expect(status).toMatch(/grid-area:\s*status;/);
    expect(status).toMatch(/max-height:\s*26px;/);
    expect(status).toMatch(/overflow:\s*hidden;/);
    expect(css).toMatch(
      /\.panel-workspace\s*\{[^}]*grid-area:\s*workspace;[^}]*min-height:\s*0;/s,
    );
  });





  it("keeps the Source pane presentation the Inspector tab still renders", () => {
    expect(css).toMatch(/\.source-pane-excerpt\s*\{[^}]*overflow:\s*auto;/s);
    expect(css).toContain(".source-pane-entry.is-active");
    expect(css).toMatch(/\.source-pane-list\s*\{[^}]*list-style:\s*none;/s);
    expect(css).toMatch(
      /\.source-pane-entry-heading\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, max-content\) auto;/s,
    );
    expect(css).toMatch(
      /\.source-pane-entry-lines\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(css).toMatch(/\.source-pane-open\s*\{[^}]*height:\s*22px;/s);
    expect(css).not.toContain(".source-pane-entry:focus-visible");
  });

  it("constrains the Inspector mount so Rules owns its vertical scroll", () => {
    expect(css).toMatch(
      /#inspector-elements-mount\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*clip;/s,
    );
  });


  it("keeps semantic status text above WCAG AA contrast in both palettes", () => {
    const palettes = [
      {
        name: "light",
        background: "#ffffff",
        declarations: ruleDeclarations(/:root\s*\{([^}]*)\}/s, "light root"),
      },
      {
        name: "dark",
        background: "#1e1e1e",
        declarations: ruleDeclarations(
          /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/s,
          "dark root",
        ),
      },
    ] as const;

    for (const palette of palettes) {
      for (const token of STATUS_TOKENS) {
        const foreground = customProperty(palette.declarations, token);
        expect(foreground, `${palette.name} ${token} must be a hex color`).toMatch(
          /^#[0-9a-f]{6}$/i,
        );
        expect(
          contrastRatio(foreground, palette.background),
          `${palette.name} ${token} contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("uses semantic status tokens and forced-colors system colors", () => {
    expect(css).not.toMatch(
      /\bcolor:\s*#(?:267a4b|1769aa|986000|bd3732)\b/i,
    );
    expect(css).toMatch(
      /\.status\[data-state="connected"\]\s*\{[^}]*color:\s*var\(--status-success\);/s,
    );
    expect(css).toMatch(
      /\.status\[data-state="linking"\],[^}]*\.status\[data-state="reconnecting"\]\s*\{[^}]*color:\s*var\(--status-info\);/s,
    );
    expect(css).toMatch(
      /\.status\[data-state="offline"\],[^}]*\.status\[data-state="rateLimited"\]\s*\{[^}]*color:\s*var\(--status-warning\);/s,
    );
    expect(css).toMatch(
      /\.source-pane-status\[data-state="error"\],[^}]*\.source-pane-status\[data-state="incompatible"\]\s*\{[^}]*color:\s*var\(--status-error\);/s,
    );

    const forcedColors = ruleDeclarations(
      /@media\s*\(forced-colors:\s*active\)\s*\{\s*:root\s*\{([^}]*)\}/s,
      "forced-colors root",
    );
    for (const token of STATUS_TOKENS) {
      expect(customProperty(forcedColors, token)).toMatch(
        /^(?:CanvasText|LinkText)$/,
      );
    }
  });
});


function ruleDeclarations(pattern: RegExp, description: string): string {
  const match = pattern.exec(css);
  if (!match?.[1]) {
    throw new Error(`Missing ${description} declarations`);
  }
  return match[1];
}

function customProperty(declarations: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*:\\s*([^;]+);`).exec(declarations);
  if (!match?.[1]) {
    throw new Error(`Missing ${property} custom property`);
  }
  return match[1].trim();
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!channels) {
    throw new Error(`Expected six-digit hex color, received ${color}`);
  }
  const [red, green, blue] = channels.slice(1).map((channel) => {
    const value = Number.parseInt(channel!, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
