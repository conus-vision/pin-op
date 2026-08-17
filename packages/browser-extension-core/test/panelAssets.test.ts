import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../assets/panel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");
const STATUS_TOKENS = [
  "--status-success",
  "--status-info",
  "--status-warning",
  "--status-error",
] as const;

describe("DevTools panel assets", () => {
  it("ships one compact toolbar with settings and unchanged connection controls", () => {
    expect(html.match(/class="panel-toolbar"/g)).toHaveLength(1);
    expect(openingTag("inspect-mode")).toMatch(/aria-label="Select an element"/);
    expect(openingTag("auto-refresh-enabled")).toMatch(/type="checkbox"/);
    expect(openingTag("ide-highlight-enabled")).toMatch(/type="checkbox"/);
    expect(html).toMatch(/<label[^>]*>\s*<input[^>]*id="auto-refresh-enabled"[^>]*>\s*Auto Refresh\s*<\/label>/);
    expect(html).toMatch(/<label[^>]*>\s*<input[^>]*id="ide-highlight-enabled"[^>]*>\s*IDE Highlight\s*<\/label>/);
    for (const id of [
      "connection-status",
      "linked-code",
      "link-controls",
      "link-code",
      "paste-button",
      "link-button",
      "disconnect-button",
    ]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    expect(html).toMatch(/id="disconnect-button"[^>]*>\s*Disconnect\s*<\/button>/);
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
