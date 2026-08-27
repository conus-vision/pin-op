import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../assets/panel.html", import.meta.url), "utf8");
const inspectorHtml = readFileSync(
  new URL("../assets/inspector-panel.html", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const $ = load(html);
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
      "link-onboarding",
      "inspector-workspace",
      "inspector-elements-mount",
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

  it("places compact Inspector onboarding in its own non-overlapping grid row", () => {
    expect(inspector("main.panel-layout.inspector-panel-layout")).toHaveLength(1);
    expect(inspector("#link-onboarding + #inspector-workspace")).toHaveLength(1);

    const layout = ruleDeclarations(
      /\.inspector-panel-layout\s*\{([^}]*)\}/s,
      "Inspector panel layout",
    );
    expect(layout).toMatch(
      /grid-template-areas:\s*"toolbar"\s*"protocol"\s*"onboarding"\s*"workspace"\s*"footer";/s,
    );
    expect(layout).toMatch(
      /grid-template-rows:\s*auto auto auto minmax\(0,\s*1fr\) auto;/,
    );

    const onboarding = ruleDeclarations(
      /\.inspector-panel-layout\s+\.link-onboarding\s*\{([^}]*)\}/s,
      "Inspector onboarding",
    );
    expect(onboarding).toMatch(/grid-area:\s*onboarding;/);
    expect(onboarding).toMatch(/padding:\s*6px 10px;/);
    expect(onboarding).not.toMatch(/position:\s*(?:absolute|fixed)/);
    expect(onboarding).not.toMatch(/z-index\s*:/);
    expect(css).toMatch(
      /\.inspector-panel-layout\s+\.link-onboarding-content\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0,\s*1fr\);/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.inspector-panel-layout\s+\.link-onboarding-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(css).toMatch(
      /\.panel-workspace\s*\{[^}]*grid-area:\s*workspace;[^}]*min-height:\s*0;/s,
    );
    expect($("main.panel-layout.inspector-panel-layout")).toHaveLength(0);
  });

  it("explains that browser inspection works before IDE linking", () => {
    const onboardingText = inspector("#link-onboarding").text()
      .replace(/\s+/g, " ")
      .trim();

    expect(onboardingText).toContain("Browser inspection is ready");
    expect(onboardingText).toContain("Select an element now");
    expect(onboardingText).toContain("Link VS Code to enable IDE actions");
    expect(onboardingText).not.toContain("After linking, select an element");
  });

  it("ships one compact toolbar with settings and unchanged connection controls", () => {
    expect(html.match(/class="panel-toolbar"/g)).toHaveLength(1);
    expect(openingTag("inspect-mode")).toMatch(/aria-label="Select an element"/);
    expect(openingTag("auto-refresh-enabled")).toMatch(/type="checkbox"/);
    expect(openingTag("ide-highlight-enabled")).toMatch(/type="checkbox"/);
    expect(html).toMatch(/<label[^>]*>\s*<input[^>]*id="auto-refresh-enabled"[^>]*>\s*Auto Refresh\s*<\/label>/);
    expect(html).toMatch(/<label[^>]*>\s*<input[^>]*id="ide-highlight-enabled"[^>]*>\s*IDE Highlight\s*<\/label>/);
    for (const id of [
      "toolbar-features",
      "connection-status",
      "linked-code",
      "link-controls",
      "link-code",
      "paste-button",
      "link-button",
      "disconnect-button",
      "link-onboarding",
      "operational-footer",
    ]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    expect(html).toMatch(/id="disconnect-button"[^>]*>\s*Disconnect\s*<\/button>/);
  });

  it("ships a focused unlinked onboarding surface", () => {
    const onboarding = $("#link-onboarding");
    const titleId = onboarding.attr("aria-labelledby");
    const footer = $("footer.panel-footer");

    expect(onboarding.is("[hidden]")).toBe(true);
    expect(titleId).toBe("link-onboarding-title");
    expect($(`h1#${titleId}`)).toHaveLength(1);
    expect(footer.children("#operational-footer")).toHaveLength(1);
    expect(footer.children("#panel-error")).toHaveLength(1);
    expect(footer.children("#panel-branding:not([hidden])")).toHaveLength(1);
    expect(html).toContain("Connect Pin-op to VS Code");
    expect(html).toContain(
      "click the Pin-op status item to copy its seven-digit link code",
    );
    expect(html).toContain(
      "Pin-op reveals the related ranges in the active IDE file",
    );
    expect(css).toMatch(
      /\.primary-button\s*\{[^}]*color:\s*#fff;[^}]*background:\s*var\(--primary-action\);/s,
    );
    expect(css).toMatch(
      /\.link-onboarding\s*\{[^}]*grid-area:\s*workspace;[^}]*place-items:\s*center;/s,
    );
  });

  it("defines the responsive DOM and Source workspace without duplicate panes", () => {
    for (const id of [
      "panel-workspace",
      "workspace-tabs",
      "dom-tab",
      "source-tab",
      "dom-pane",
      "pane-separator",
      "source-pane",
      "source-pane-root",
      "protocol-mismatch",
    ]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    expect(openingTag("workspace-tabs")).toMatch(/role="tablist"/);
    expect(openingTag("dom-tab")).toMatch(/role="tab"/);
    expect(openingTag("source-tab")).toMatch(/role="tab"/);
    expect(openingTag("pane-separator")).toMatch(/role="separator"/);
    expect(openingTag("source-pane-root")).toMatch(/aria-label="Source matches"/);
    expect(html).toContain("Extensions are incompatible");
    expect(html).toContain(
      "Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.",
    );
    expect(html).toContain('id="protocol-mismatch-versions"');
  });

  it("keeps navigation status above centered accessible branding", () => {
    expect(html).toMatch(
      /id="resolution-status"[\s\S]*id="panel-branding"[\s\S]*<\/footer>/,
    );
    expect(openingTag("footer-logo")).toMatch(/width="10"/);
    expect(openingTag("footer-logo")).toMatch(/height="10"/);
    expect(html).toMatch(/class="product-name"[^>]*>[\s\S]*?Pin-op<\/span>/);
    expect(html).toContain('href="mailto:info@conus.vision"');
    expect(html).toContain('href="https://conus.vision"');
    expect(html).toContain("Volodymyr Moskvin");
    expect(html).toContain("(c) 2026 ");
  });

  it("defines stable responsive constraints without absolute workspace controls", () => {
    expect(css).toMatch(/\.panel-toolbar-scroll\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.panel-toolbar\s*\{[^}]*min-width:\s*300px;/s);
    expect(css).toContain('[data-layout="split"]');
    expect(css).toContain('[data-layout="stack"]');
    expect(css).toContain('[data-layout="tabs"]');
    expect(css).toMatch(/\.workspace-pane\s*\{[^}]*min-width:\s*160px;[^}]*min-height:\s*160px;/s);
    expect(css).not.toMatch(/\.(?:panel-toolbar|workspace-tabs|source-pane)\s*\{[^}]*position:\s*absolute;/s);
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
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*flex-wrap:\s*wrap;[^}]*text-align:\s*center;/s);
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*white-space:\s*normal;/s);
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*line-height:\s*16px;/s);
  });

  it("constrains the Inspector mount so Rules owns its vertical scroll", () => {
    expect(css).toMatch(
      /#inspector-elements-mount\s*\{[^}]*display:\s*grid;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("keeps the workspace in the flexible shell row when the protocol banner is hidden", () => {
    expect(css).toMatch(
      /\.panel-layout\s*\{[^}]*grid-template-areas:\s*"toolbar"\s*"protocol"\s*"workspace"\s*"footer";/s,
    );
    expect(css).toMatch(
      /\.panel-toolbar-scroll\s*\{[^}]*grid-area:\s*toolbar;/s,
    );
    expect(css).toMatch(
      /\.protocol-mismatch\s*\{[^}]*grid-area:\s*protocol;/s,
    );
    expect(css).toMatch(
      /\.panel-workspace\s*\{[^}]*grid-area:\s*workspace;/s,
    );
    expect(css).toMatch(/\.panel-footer\s*\{[^}]*grid-area:\s*footer;/s);
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

function openingTag(id: string): string {
  const match = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`).exec(html);
  if (!match) {
    throw new Error(`Missing #${id}`);
  }
  return match[0];
}

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
