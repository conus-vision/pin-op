import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../assets/panel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/panel.css", import.meta.url), "utf8");

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
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*flex-wrap:\s*wrap;[^}]*text-align:\s*center;/s);
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*white-space:\s*normal;/s);
    expect(css).toMatch(/\.panel-branding\s*\{[^}]*line-height:\s*16px;/s);
  });
});

function openingTag(id: string): string {
  const match = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`).exec(html);
  if (!match) {
    throw new Error(`Missing #${id}`);
  }
  return match[0];
}
