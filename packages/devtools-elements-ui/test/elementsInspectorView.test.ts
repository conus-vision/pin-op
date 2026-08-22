import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ElementsInspectorView } from "../src/elementsInspectorView.js";
import { elementsSession, withTextValue } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("ElementsInspectorView", () => {
  it("mounts DOM on the left and the sole visible Rules tab on the right", () => {
    const harness = createHarness();
    const root = required(harness.mount.querySelector(".pin-op-elements-inspector"));
    const domPane = required(root.querySelector('[data-pane="dom"]'));
    const sidebar = required(root.querySelector('[data-pane="sidebar"]'));
    const rulesPanel = required(root.querySelector('[data-pane="rules"]'));
    const tabs = root.querySelectorAll('[role="tab"]');
    const extensionMount = required(root.querySelector('[data-part="sidebar-extension"]'));

    expect(root.children[0]).toBe(domPane);
    expect(root.children[1]).toBe(sidebar);
    expect(domPane.querySelector('[data-part="pane-title"]')?.textContent).toBe("DOM");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Rules"]);
    expect(tabs[0]?.tagName).toBe("BUTTON");
    expect(tabs[0]?.getAttribute("type")).toBe("button");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(rulesPanel.id);
    expect(rulesPanel.getAttribute("role")).toBe("tabpanel");
    expect(rulesPanel.children).toHaveLength(0);
    expect(extensionMount.hidden).toBe(true);
    expect(extensionMount.getAttribute("aria-hidden")).toBe("true");
    expect(tabs.some((tab) => tab.textContent === "Source")).toBe(false);
  });

  it("renders and refreshes page-controlled text only as text", () => {
    const harness = createHarness();
    const initialText = "Hello <img src=x onerror=alert(1)>";
    const textRow = required(harness.mount.querySelector('[data-node-ref="intro-text"]'));

    expect(textRow.textContent).toBe(initialText);
    expect(harness.document.createdTags()).not.toContain("img");
    expect(harness.mount.querySelector("img")).toBeNull();

    harness.backend.publish(withTextValue("Updated <script>alert(1)</script>"));

    const updatedText = required(
      harness.mount.querySelector('[data-node-ref="intro-text"]'),
    );
    expect(updatedText.textContent).toBe("Updated <script>alert(1)</script>");
    expect(harness.document.createdTags()).not.toContain("script");
    expect(harness.mount.querySelector("script")).toBeNull();
  });

  it("contains no Pin-op toolbar ownership or editable/inline surfaces", () => {
    const harness = createHarness();
    const root = required(harness.mount.querySelector(".pin-op-elements-inspector"));

    expect(root.textContent).not.toMatch(
      /Link|Disconnect|Auto Refresh|IDE Highlight|Source/,
    );
    expect(root.querySelector("[contenteditable]")).toBeNull();
    expect(root.querySelector("input, textarea, select")).toBeNull();
    expect(root.querySelector("script, style")).toBeNull();
    expect(
      [root, ...root.descendants()].some((element) => element.hasAttribute("style")),
    ).toBe(false);
    expect(harness.document.innerHTMLAssignments()).toBe(0);

    const implementation = readFileSync(
      path.join(packageRoot, "src", "elementsInspectorView.ts"),
      "utf8",
    );
    expect(implementation).not.toMatch(/\binnerHTML\b|contentEditable/);
  });

  it("removes subscriptions, DOM listeners, and owned elements on dispose", () => {
    const harness = createHarness();
    const renderedRows = required(
      harness.mount.querySelector('[data-part="dom-rows"]'),
    );
    const beforeDispose = renderedRows.textContent;
    expect(harness.backend.listenerCount()).toBe(1);

    harness.view.dispose();
    harness.view.dispose();
    harness.backend.publish(withTextValue("must not render"));

    expect(harness.backend.listenerCount()).toBe(0);
    expect(harness.document.totalListeners()).toBe(0);
    expect(harness.mount.children).toHaveLength(0);
    expect(renderedRows.textContent).toBe(beforeDispose);
  });

  it("keeps every stylesheet selector below the inspector root", () => {
    const css = readFileSync(
      path.join(packageRoot, "assets", "devtools-elements.css"),
      "utf8",
    );
    const selectors = stylesheetSelectors(css);

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toMatch(/^\.pin-op-elements-inspector(?:\b|[\s.:#[>+~])/);
    }
    expect(css).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(/);
  });

  it("mechanically rejects Chromium SDK, host, legacy UI, and panel imports", () => {
    const chromiumRoot = path.join(packageRoot, "src", "chromium");
    const forbidden = /(?:\/sdk\/|\/host\/|ui\/legacy|ElementsPanel|CSSModel|DOMModel|OverlayModel|TargetManager|Linkifier)/;
    const violations: string[] = [];

    for (const blockedImport of [
      'import SDK from "../../core/sdk/sdk.js";',
      'import Host from "../../core/host/host.js";',
      'import * as UI from "../../ui/legacy/legacy.js";',
      'import { ElementsPanel } from "./panel.js";',
      'import { CSSModel, DOMModel } from "./models.js";',
      'import { OverlayModel, TargetManager } from "./target.js";',
      'export { Linkifier } from "./link.js";',
    ]) {
      expect(
        moduleImportStatements(blockedImport).some((statement) => forbidden.test(statement)),
      ).toBe(true);
    }

    for (const file of sourceFiles(chromiumRoot)) {
      const source = readFileSync(file, "utf8");
      for (const statement of moduleImportStatements(source)) {
        if (forbidden.test(statement)) {
          violations.push(
            `${path.relative(packageRoot, file)}: ${statement.replace(/\s+/g, " ")}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function createHarness() {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  document.body.append(mount);
  const backend = new FakeElementsBackend(elementsSession.tree);
  const view = new ElementsInspectorView(
    document.document,
    mount as unknown as HTMLElement,
    backend,
  );
  return { document, mount, backend, view };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Missing expected rendered element");
  }
  return value;
}

function stylesheetSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  for (const match of withoutComments.matchAll(/(?:^|})\s*([^@}{][^{]*)\{/g)) {
    const group = match[1]?.trim();
    if (!group) continue;
    selectors.push(...group.split(",").map((selector) => selector.trim()));
  }
  return selectors;
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function moduleImportStatements(source: string): string[] {
  return [
    ...source.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*["'][^"']+["']\s*;?/g,
    ),
    ...source.matchAll(/\bimport\s*["'][^"']+["']\s*;?/g),
    ...source.matchAll(/\bimport\s*\(\s*["'][^"']+["']\s*\)/g),
  ].flatMap((match) => match[0] ? [match[0]] : []);
}
