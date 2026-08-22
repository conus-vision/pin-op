import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
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

    const implementations = sourceFiles(path.join(packageRoot, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(implementations).not.toMatch(
      /\b(?:innerHTML|outerHTML)\b|contentEditable/,
    );
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
    expect(unscopedSelectors(css)).toEqual([]);
    expect(css).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(/);
  });

  it("rejects a selector whose first class only looks like the inspector root", () => {
    const css = ".pin-op-elements-inspector-leak { color: red; }";

    expect(unscopedSelectors(css)).toEqual([
      ".pin-op-elements-inspector-leak",
    ]);
  });

  it("finds every unscoped rule nested inside CSS at-rules", () => {
    const css = `
      @media (width > 320px) {
        .leak-inside-media { color: red; }
      }
      @supports (display: grid) {
        .leak-inside-supports { display: grid; }
      }
    `;

    expect(unscopedSelectors(css)).toEqual([
      ".leak-inside-media",
      ".leak-inside-supports",
    ]);
  });

  it("pins the derived stylesheet to LF bytes in a package-local attribute", () => {
    const attributesPath = path.join(packageRoot, ".gitattributes");
    const attributes = existsSync(attributesPath)
      ? readFileSync(attributesPath, "utf8")
      : "";

    expect(hasStylesheetLfAttribute(attributes)).toBe(true);
  });

  it("recognizes the stylesheet LF rule in CRLF attributes content", () => {
    const attributes = "assets/devtools-elements.css text eol=lf\r\n";

    expect(hasStylesheetLfAttribute(attributes)).toBe(true);
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

describe("FakeDocument safety guards", () => {
  it("keeps listeners observable after their element is detached", () => {
    const document = new FakeDocument();
    const detached = document.createElement("div") as unknown as FakeElement;
    const listener = (): void => {};
    detached.addEventListener("click", listener);
    document.body.append(detached);

    detached.remove();

    expect(document.totalListeners()).toBe(1);
    detached.removeEventListener("click", listener);
    expect(document.totalListeners()).toBe(0);
  });

  it("fails fast on innerHTML and outerHTML assignments", () => {
    const document = new FakeDocument();
    const innerTarget = document.createElement("div");
    const outerTarget = document.createElement("div");

    expect(() => {
      innerTarget.innerHTML = "<script>unsafe()</script>";
    }).toThrow(/innerHTML/);
    expect(() => {
      outerTarget.outerHTML = "<script>unsafe()</script>";
    }).toThrow(/outerHTML/);
    expect(document.innerHTMLAssignments()).toBe(1);
    expect(document.outerHTMLAssignments()).toBe(1);
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
  const selectors: string[] = [];
  postcss.parse(css, { from: undefined }).walkRules((rule) => {
    selectors.push(...rule.selectors);
  });
  return selectors;
}

function unscopedSelectors(css: string): string[] {
  return stylesheetSelectors(css).filter((selector) => (
    !/^\.pin-op-elements-inspector(?![-_a-zA-Z0-9\u0080-\uFFFF\\])/.test(selector)
  ));
}

function hasStylesheetLfAttribute(attributes: string): boolean {
  return attributes
    .split(/\r?\n/)
    .includes("assets/devtools-elements.css text eol=lf");
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
