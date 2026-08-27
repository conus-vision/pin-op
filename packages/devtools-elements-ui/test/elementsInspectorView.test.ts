import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import type {
  CreateElementsTreeRenderer,
  RulesDataSource,
  RulesPresentationSnapshot,
  TreePresentationSnapshot,
} from "../src/contracts.js";
import { ElementsInspectorView } from "../src/elementsInspectorView.js";
import { elementsSession, withTextValue } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("ElementsInspectorView", () => {
  it("delegates the DOM mount to an injected tree renderer and owns its host", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    const rendererElement = document.createElement("div") as unknown as FakeElement;
    rendererElement.setAttribute("data-part", "injected-tree-renderer");
    const calls: Parameters<CreateElementsTreeRenderer>[] = [];
    let disposeCalls = 0;
    const createTreeRenderer: CreateElementsTreeRenderer = (...args) => {
      calls.push(args);
      (args[1] as unknown as FakeElement).append(rendererElement);
      return {
        dispose(): void {
          disposeCalls += 1;
          rendererElement.remove();
        },
      };
    };
    document.body.append(mount);

    const view = new ElementsInspectorView(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      undefined,
      undefined,
      undefined,
      createTreeRenderer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([document.document, view.domRoot, backend]);
    expect(view.domRoot.querySelector('[data-part="injected-tree-renderer"]')).toBe(
      rendererElement,
    );
    expect(view.domRoot.querySelector('[data-part="dom-rows"]')).toBeNull();
    expect(disposeCalls).toBe(0);

    view.dispose();
    view.dispose();

    expect(disposeCalls).toBe(1);
    expect(rendererElement.parentElement).toBeUndefined();
    expect(mount.children).toHaveLength(0);
  });

  it("rolls back an injected tree renderer when later construction fails", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    const rendererElement = document.createElement("div") as unknown as FakeElement;
    const snapshotError = new Error("initial Rules snapshot failed");
    const rules = new ThrowingSnapshotRulesDataSource(snapshotError);
    let disposeCalls = 0;
    const createTreeRenderer: CreateElementsTreeRenderer = (
      _document,
      rendererMount,
    ) => {
      (rendererMount as unknown as FakeElement).append(rendererElement);
      return {
        dispose(): void {
          disposeCalls += 1;
          rendererElement.remove();
        },
      };
    };
    document.body.append(mount);

    expect(() => new ElementsInspectorView(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      rules,
      undefined,
      undefined,
      createTreeRenderer,
    )).toThrow(snapshotError);

    expect(disposeCalls).toBe(1);
    expect(rendererElement.parentElement).toBeUndefined();
    expect(rules.listenerCount()).toBe(0);
    expect(document.totalListeners()).toBe(0);
    expect(mount.children).toHaveLength(0);
  });

  it("mounts DOM on the left and switches between Rules and Source", () => {
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
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Rules", "Source"]);
    expect(tabs[0]?.tagName).toBe("BUTTON");
    expect(tabs[0]?.getAttribute("type")).toBe("button");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(rulesPanel.id);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.getAttribute("aria-controls")).toBe(extensionMount.id);
    expect(rulesPanel.getAttribute("role")).toBe("tabpanel");
    expect(extensionMount.getAttribute("role")).toBe("tabpanel");
    expect(rulesPanel.children).toHaveLength(0);
    expect(extensionMount.hidden).toBe(true);

    (tabs[1] as unknown as FakeElement).dispatch("click");

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(rulesPanel.hidden).toBe(true);
    expect(extensionMount.hidden).toBe(false);

    (tabs[0] as unknown as FakeElement).dispatch("click");

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(rulesPanel.hidden).toBe(false);
    expect(extensionMount.hidden).toBe(true);
  });

  it("keeps every ARIA ID reference unique to its inspector instance", () => {
    const document = new FakeDocument();
    const occupiedIds = [
      "pin-op-elements-dom-title",
      "pin-op-elements-rules-tab",
      "pin-op-elements-rules-panel",
      "pin-op-elements-source-tab",
      "pin-op-elements-source-panel",
    ];
    for (const id of occupiedIds) {
      const occupied = document.createElement("div") as unknown as FakeElement;
      occupied.setAttribute("data-existing", "true");
      occupied.setAttribute("id", id);
      document.body.append(occupied);
    }

    const firstMount = document.createElement("main") as unknown as FakeElement;
    const secondMount = document.createElement("main") as unknown as FakeElement;
    document.body.append(firstMount, secondMount);
    const firstView = new ElementsInspectorView(
      document.document,
      firstMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    const secondView = new ElementsInspectorView(
      document.document,
      secondMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    const roots = [firstView.element, secondView.element] as unknown as FakeElement[];
    const documentIds = document.querySelectorAll("[id]").map((element) => element.id);
    expect(new Set(documentIds).size).toBe(documentIds.length);
    for (const root of roots) {
      const domPane = required(root.querySelector('[data-pane="dom"]'));
      const domTitle = required(root.querySelector('[data-part="pane-title"]'));
      const rulesTab = required(root.querySelector('[role="tab"]'));
      const sourceTab = required(root.querySelectorAll('[role="tab"]')[1]);
      const rulesPanel = required(root.querySelector('[data-pane="rules"]'));
      const sourcePanel = required(root.querySelector('[data-part="sidebar-extension"]'));
      expectOwnedIdReference(document, root, domPane, "aria-labelledby", domTitle);
      expectOwnedIdReference(document, root, rulesTab, "aria-controls", rulesPanel);
      expectOwnedIdReference(document, root, rulesPanel, "aria-labelledby", rulesTab);
      expectOwnedIdReference(document, root, sourceTab, "aria-controls", sourcePanel);
      expectOwnedIdReference(document, root, sourcePanel, "aria-labelledby", sourceTab);
    }
    for (const id of occupiedIds) {
      expect(document.document.getElementById(id)?.getAttribute("data-existing")).toBe("true");
    }

    firstView.dispose();
    secondView.dispose();
  });

  it("renders and refreshes page-controlled text only as text", () => {
    const harness = createHarness();
    const initialText = "Hello <img src=x onerror=alert(1)>";
    const textRow = required(
      harness.mount.querySelector('[data-node-ref="intro-text"]')
        ?.querySelector(".webkit-html-text-node"),
    );

    expect(textRow.textContent).toBe(initialText);
    expect(harness.document.createdTags()).not.toContain("img");
    expect(harness.mount.querySelector("img")).toBeNull();

    harness.backend.publish(withTextValue("Updated <script>alert(1)</script>"));

    const updatedText = required(
      harness.mount.querySelector('[data-node-ref="intro-text"]')
        ?.querySelector(".webkit-html-text-node"),
    );
    expect(updatedText.textContent).toBe("Updated <script>alert(1)</script>");
    expect(harness.document.createdTags()).not.toContain("script");
    expect(harness.mount.querySelector("script")).toBeNull();
  });

  it("binds the :hov preview to Rules and resets it with selection authority", () => {
    const harness = createHarness();
    const rules = new StaticRulesDataSource(elementsSession.rules);
    const pseudo = new MutablePseudoStateDataSource({
      state: "ready",
      states: Object.freeze(["hover"]),
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 0,
    });
    const bindRulesDataSource = harness.view.bindRulesDataSource as unknown as (
      dataSource: RulesDataSource,
      sourceLinkDelegate: undefined,
      pseudoStateDataSource: MutablePseudoStateDataSource,
    ) => void;
    bindRulesDataSource.call(harness.view, rules, undefined, pseudo);

    const button = required(
      harness.view.rulesRoot.querySelector('[data-part="pseudo-state-button"]'),
    ) as unknown as FakeElement;
    const hover = required(
      harness.view.rulesRoot.querySelector('[data-pseudo-state="hover"]'),
    ) as unknown as FakeElement & { checked: boolean };
    expect(button.textContent).toBe(":hov");
    expect(button.getAttribute("aria-label")).toMatch(/preview/i);
    expect(hover.checked).toBe(true);
    expect(pseudo.listenerCount()).toBe(1);

    pseudo.publish({
      state: "unavailable",
      reason: "no-selection",
      states: Object.freeze([]),
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 0,
    });

    const resetButton = required(
      harness.view.rulesRoot.querySelector('[data-part="pseudo-state-button"]'),
    ) as unknown as FakeElement;
    const resetHover = required(
      harness.view.rulesRoot.querySelector('[data-pseudo-state="hover"]'),
    ) as unknown as FakeElement & { checked: boolean };
    expect(resetButton.disabled).toBe(true);
    expect(resetHover.checked).toBe(false);

    harness.view.dispose();
    expect(pseudo.listenerCount()).toBe(0);
  });

  it("keeps the :hov toolbar mounted while an atomic Rules reload is pending", () => {
    const harness = createHarness();
    const rules = new StaticRulesDataSource(elementsSession.rules);
    const pseudo = new MutablePseudoStateDataSource({
      state: "ready",
      states: Object.freeze(["hover"]),
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 0,
    });
    const bindRulesDataSource = harness.view.bindRulesDataSource as unknown as (
      dataSource: RulesDataSource,
      sourceLinkDelegate: undefined,
      pseudoStateDataSource: MutablePseudoStateDataSource,
    ) => void;
    bindRulesDataSource.call(harness.view, rules, undefined, pseudo);

    pseudo.publish({
      state: "loading",
      states: Object.freeze(["hover"]),
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 0,
    });
    rules.publish(Object.freeze({ state: "loading" }));

    const button = required(
      harness.view.rulesRoot.querySelector('[data-part="pseudo-state-button"]'),
    ) as unknown as FakeElement;
    const hover = required(
      harness.view.rulesRoot.querySelector('[data-pseudo-state="hover"]'),
    ) as unknown as FakeElement & { checked: boolean };
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(hover.checked).toBe(true);
    expect(harness.view.rulesRoot.textContent).toContain("Loading styles");

    harness.view.dispose();
  });

  it("contains no Pin-op toolbar ownership or editable/inline surfaces", () => {
    const harness = createHarness();
    const root = required(harness.mount.querySelector(".pin-op-elements-inspector"));

    expect(root.textContent).not.toMatch(
      /Link|Disconnect|Auto Refresh|IDE Highlight/,
    );
    expect(root.querySelector("[contenteditable]")).toBeNull();
    expect(root.querySelector("input, textarea, select")).toBeNull();
    expect(root.querySelector("script, style")).toBeNull();
    expect(root.hasAttribute("style")).toBe(false);
    expect(root.querySelector("[style]")).toBeNull();
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
    expect(harness.backend.listenerCount()).toBe(1);

    harness.view.dispose();
    harness.view.dispose();
    harness.backend.publish(withTextValue("must not render"));

    expect(harness.backend.listenerCount()).toBe(0);
    expect(harness.document.totalListeners()).toBe(0);
    expect(harness.mount.children).toHaveLength(0);
    expect(renderedRows.textContent).toBe("");
    expect(renderedRows.children).toHaveLength(0);
  });

  it("does not commit rows when snapshot reentrancy disposes the view", () => {
    const backend = new SnapshotHookBackend(elementsSession.tree);
    const harness = createHarness(backend);
    const retainedRows = required(
      harness.mount.querySelector('[data-part="dom-rows"]'),
    );
    backend.beforeSnapshot = () => harness.view.dispose();

    backend.publish(withTextValue("must not commit after dispose"));

    expect(harness.mount.children).toHaveLength(0);
    expect(retainedRows.textContent).toBe("");
    expect(retainedRows.children).toHaveLength(0);
  });

  it("does not let an outer render overwrite a newer nested render", () => {
    const backend = new SnapshotHookBackend(elementsSession.tree);
    const harness = createHarness(backend);
    const rows = required(harness.mount.querySelector('[data-part="dom-rows"]'));
    backend.beforeSnapshot = () => {
      backend.publish(withTextValue("newer nested render"));
    };

    backend.publish(withTextValue("stale outer render"));

    expect(
      required(
        rows.querySelector('[data-node-ref="intro-text"]')
          ?.querySelector(".webkit-html-text-node"),
      ).textContent,
    ).toBe("newer nested render");
  });

  it("removes owned DOM when unsubscribe throws and never retries cleanup", () => {
    const backend = new ThrowingUnsubscribeBackend(elementsSession.tree);
    const harness = createHarness(backend);
    let disposeError: unknown;

    try {
      harness.view.dispose();
    } catch (error) {
      disposeError = error;
    }

    expect(disposeError).toBe(backend.unsubscribeError);
    expect(backend.unsubscribeAttempts).toBe(1);
    expect(backend.listenerCount()).toBe(0);
    expect(harness.mount.children).toHaveLength(0);
    expect(harness.document.totalListeners()).toBe(0);
    expect(() => harness.view.dispose()).not.toThrow();
    expect(backend.unsubscribeAttempts).toBe(1);
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

  it("resets the exact Rules origin button without losing keyboard focus", () => {
    const css = readFileSync(
      path.join(packageRoot, "assets", "devtools-elements.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.pin-op-elements-inspector button\.rule-origin\s*\{[^}]*appearance:\s*none;[^}]*block-size:\s*auto;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*cursor:\s*pointer;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector button\.rule-origin:focus-visible\s*\{[^}]*outline:\s*2px solid Highlight;/s,
    );
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

function createHarness(
  backend: FakeElementsBackend = new FakeElementsBackend(elementsSession.tree),
) {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  document.body.append(mount);
  const view = new ElementsInspectorView(
    document.document,
    mount as unknown as HTMLElement,
    backend,
  );
  return { document, mount, backend, view };
}

class SnapshotHookBackend extends FakeElementsBackend {
  public beforeSnapshot: (() => void) | undefined;

  public override snapshot(): TreePresentationSnapshot {
    const snapshot = super.snapshot();
    const beforeSnapshot = this.beforeSnapshot;
    this.beforeSnapshot = undefined;
    beforeSnapshot?.();
    return snapshot;
  }
}

class ThrowingUnsubscribeBackend extends FakeElementsBackend {
  public readonly unsubscribeError = new Error("unsubscribe failed");
  public unsubscribeAttempts = 0;

  public override subscribe(listener: () => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.unsubscribeAttempts += 1;
      unsubscribe();
      throw this.unsubscribeError;
    };
  }
}

type PseudoState = "hover" | "focus";
type PseudoSnapshot = Readonly<{
  state: "ready" | "loading" | "unavailable";
  states: readonly PseudoState[];
  unsupportedRuleCount: number;
  inaccessibleStylesheetCount: number;
  approximateRuleCount: number;
  reason?: "no-selection";
}>;

class StaticRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private current: RulesPresentationSnapshot) {}

  public snapshot(): RulesPresentationSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public filter(_query: string): void {}

  public publish(snapshot: RulesPresentationSnapshot): void {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

class ThrowingSnapshotRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly snapshotError: Error) {}

  public snapshot(): RulesPresentationSnapshot {
    throw this.snapshotError;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public filter(_query: string): void {}

  public listenerCount(): number {
    return this.listeners.size;
  }
}

class MutablePseudoStateDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private current: PseudoSnapshot) {}

  public snapshot(): PseudoSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async setStates(_states: readonly PseudoState[]): Promise<void> {}

  public publish(snapshot: PseudoSnapshot): void {
    this.current = Object.freeze({
      ...snapshot,
      states: Object.freeze([...snapshot.states]),
    });
    for (const listener of [...this.listeners]) listener();
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function expectOwnedIdReference(
  document: FakeDocument,
  root: FakeElement,
  source: FakeElement,
  attribute: "aria-controls" | "aria-labelledby",
  target: FakeElement,
): void {
  const id = required(source.getAttribute(attribute));
  expect(target.id).toBe(id);
  expect(document.document.getElementById(id)).toBe(target);
  expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  expect(root.contains(target)).toBe(true);
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
