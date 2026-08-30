import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import type {
  CreateElementsRulesRenderer,
  CreateElementsTreeRenderer,
  RulesDataSource,
  RulesPresentationSnapshot,
  TreePresentationSnapshot,
} from "../src/contracts.js";
import { ElementsInspectorShell } from "../src/elementsInspectorShell.js";
import { elementsSession, withTextValue } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("ElementsInspectorShell", () => {
  it("delegates Rules rendering to an injected renderer and owns its host", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    const rules = new StaticRulesDataSource(elementsSession.rules);
    const rendererElement = document.createElement("div") as unknown as FakeElement;
    rendererElement.setAttribute("data-part", "injected-rules-renderer");
    const calls: Parameters<CreateElementsRulesRenderer>[] = [];
    const rendered: unknown[] = [];
    let disposeCalls = 0;
    const createRulesRenderer: CreateElementsRulesRenderer = (...args) => {
      calls.push(args);
      (args[1] as unknown as FakeElement).append(rendererElement);
      return {
        render(snapshot): void {
          rendered.push(snapshot);
        },
        clear(): void {},
        dispose(): void {
          disposeCalls += 1;
          rendererElement.remove();
        },
      };
    };
    document.body.append(mount);

    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      rules,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      document.document,
      view.rulesRoot,
      rules,
      undefined,
      undefined,
    ]);
    expect(rendered).toEqual([elementsSession.rules.matchedStyles]);
    expect(view.rulesRoot.querySelector('[data-part="injected-rules-renderer"]')).toBe(
      rendererElement,
    );
    expect(view.rulesRoot.querySelector('[data-part="styles-sidebar"]')).toBeNull();

    view.dispose();
    view.dispose();

    expect(disposeCalls).toBe(1);
    expect(rendererElement.parentElement).toBeUndefined();
    expect(rules.listenerCount()).toBe(0);
  });

  it("keeps the injected Rules mount attached across presentation updates", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    const rules = new StaticRulesDataSource(elementsSession.rules);
    const rendererElement = document.createElement("div") as unknown as FakeElement;
    const parents: Array<FakeElement | undefined> = [];
    const createRulesRenderer: CreateElementsRulesRenderer = (
      _document,
      rulesMount,
    ) => {
      (rulesMount as unknown as FakeElement).append(rendererElement);
      return {
        render(): void {
          parents.push(rendererElement.parentElement);
        },
        clear(): void {
          parents.push(rendererElement.parentElement);
        },
        dispose(): void {
          rendererElement.remove();
        },
      };
    };
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      rules,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );
    const sourceTab = required(
      view.element.querySelectorAll('[role="tab"]')[1],
    ) as unknown as FakeElement;
    const rulesTab = required(
      view.element.querySelectorAll('[role="tab"]')[0],
    ) as unknown as FakeElement;

    rules.publish(Object.freeze({ state: "loading" }));
    rules.publish(Object.freeze({ state: "partial", matchedStyles: elementsSession.rules.matchedStyles }));
    sourceTab.dispatch("click");
    rulesTab.dispatch("click");
    rules.publish(elementsSession.rules);

    expect(parents).toHaveLength(4);
    expect(parents.every((parent) => parent === view.rulesRoot)).toBe(true);
    expect(rendererElement.parentElement).toBe(view.rulesRoot);
    expect(view.rulesRoot.querySelector('[data-part="rules-message"]')).not.toBeNull();

    view.dispose();
  });

  it("gives a partial snapshot the whole pane and no status line", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    const rules = new StaticRulesDataSource(elementsSession.rules);
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      rules,
    );

    rules.publish(Object.freeze({
      state: "partial",
      matchedStyles: elementsSession.rules.matchedStyles,
    }));
    const message = required(
      view.rulesRoot.querySelector('[data-part="rules-message"]'),
    ) as unknown as FakeElement;

    // What could not be read is reported in the footer; the pane keeps its room.
    expect(message.hidden).toBe(true);
    expect(message.textContent).toBe("");
    expect(view.rulesRoot.getAttribute("data-state")).toBe("partial");

    view.dispose();
  });

  it("keeps a newer reentrant Rules status after an older clear resumes", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const rules = new StaticRulesDataSource(elementsSession.rules);
    let publishReadyFromClear = false;
    const createRulesRenderer: CreateElementsRulesRenderer = (
      _document,
      rulesMount,
    ) => {
      const element = document.createElement("div") as unknown as FakeElement;
      (rulesMount as unknown as FakeElement).append(element);
      return {
        render(): void {},
        clear(): void {
          if (!publishReadyFromClear) return;
          publishReadyFromClear = false;
          rules.publish(elementsSession.rules);
        },
        dispose(): void {
          element.remove();
        },
      };
    };
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
      rules,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );
    publishReadyFromClear = true;

    rules.publish(Object.freeze({ state: "loading" }));

    const message = required(
      view.rulesRoot.querySelector('[data-part="rules-message"]'),
    );
    expect(message.hidden).toBe(true);
    expect(message.textContent).toBe("");
    expect(view.rulesRoot.getAttribute("data-state")).toBe("ready");

    view.dispose();
  });

  it("fully rolls back a failed Rules bind even when renderer disposal throws", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const rules = new ThrowingSnapshotRulesDataSource(
      new Error("initial Rules snapshot failed"),
    );
    const disposeError = new Error("Rules renderer dispose failed");
    let factoryCalls = 0;
    const createRulesRenderer: CreateElementsRulesRenderer = (
      _document,
      rulesMount,
    ) => {
      factoryCalls += 1;
      const element = document.createElement("div") as unknown as FakeElement;
      (rulesMount as unknown as FakeElement).append(element);
      return {
        render(): void {},
        clear(): void {},
        dispose(): void {
          element.remove();
          throw disposeError;
        },
      };
    };
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
      undefined,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let failure: unknown;
      try {
        view.bindRulesDataSource(rules);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        rules.snapshotError,
        disposeError,
      ]);
      expect(rules.listenerCount()).toBe(0);
      expect(view.rulesRoot.children).toHaveLength(0);
    }
    expect(factoryCalls).toBe(2);

    expect(() => view.dispose()).not.toThrow();
  });

  it("restores the empty Rules shell when initial renderer work throws", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const rules = new StaticRulesDataSource(elementsSession.rules);
    const renderError = new Error("initial Rules render failed");
    const clearError = new Error("initial Rules clear failed");
    let failure: Error = renderError;
    const createRulesRenderer: CreateElementsRulesRenderer = (
      _document,
      rulesMount,
    ) => {
      const element = document.createElement("div") as unknown as FakeElement;
      (rulesMount as unknown as FakeElement).append(element);
      return {
        render(): void {
          if (failure === renderError) throw failure;
        },
        clear(): void {
          if (failure === clearError) throw failure;
        },
        dispose(): void {
          element.remove();
        },
      };
    };
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
      undefined,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );

    expect(() => view.bindRulesDataSource(rules)).toThrow(renderError);
    expectEmptyRulesShell(view);

    rules.publish(Object.freeze({ state: "loading" }));
    failure = clearError;
    expect(() => view.bindRulesDataSource(rules)).toThrow(clearError);
    expectEmptyRulesShell(view);

    view.dispose();
  });

  it("removes renderer DOM when a mount-owning Rules factory throws", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const factoryError = new Error("Rules factory failed");
    const leaked = document.createElement("div") as unknown as FakeElement;
    const createRulesRenderer: CreateElementsRulesRenderer = (
      _document,
      rulesMount,
    ) => {
      (rulesMount as unknown as FakeElement).append(leaked);
      throw factoryError;
    };
    document.body.append(mount);
    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
      undefined,
      undefined,
      undefined,
      undefined,
      createRulesRenderer,
    );

    expect(() => view.bindRulesDataSource(
      new StaticRulesDataSource(elementsSession.rules),
    )).toThrow(factoryError);
    expect(view.rulesRoot.children).toHaveLength(0);
    expect(leaked.parentElement).toBeUndefined();

    view.dispose();
  });


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

    const view = new TestInspectorShell(
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

    expect(() => new TestInspectorShell(
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
    const tabList = required(root.querySelector('[role="tablist"]'));
    const extensionMount = required(root.querySelector('[data-part="sidebar-extension"]'));

    expect(root.children[0]).toBe(domPane);
    expect(root.children[1]?.getAttribute("data-part")).toBe("sidebar-resizer");
    expect(root.children[2]).toBe(sidebar);
    expect(domPane.getAttribute("aria-label")).toBe("DOM tree");
    expect(domPane.querySelector('[data-part="pane-title"]')).toBeNull();
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Rules", "Source"]);
    expect(tabs[0]?.tagName).toBe("BUTTON");
    expect(tabs[0]?.getAttribute("type")).toBe("button");
    expect(tabList.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(rulesPanel.id);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
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

  it("bridges the operating-system color scheme into Chromium theme classes", () => {
    const colorScheme = new FakeMediaQueryList(true);
    const stacked = new FakeMediaQueryList(false);
    const queries: string[] = [];
    const document = new FakeDocument({
      matchMedia: (query: string): MediaQueryList => {
        queries.push(query);
        return query === "(prefers-color-scheme: dark)" ? colorScheme : stacked;
      },
    });
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);

    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    expect(queries).toContain("(prefers-color-scheme: dark)");
    expect(view.element.classList.contains("theme-with-dark-background")).toBe(false);
    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(true);
    expect(colorScheme.listenerCount()).toBe(1);

    colorScheme.publish(false);

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(false);

    view.dispose();

    expect(colorScheme.listenerCount()).toBe(0);
    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(false);
  });

  it("coordinates Chromium theme ownership across inspector instances", () => {
    const firstScheme = new FakeMediaQueryList(true);
    const secondScheme = new FakeMediaQueryList(false);
    const schemes = [firstScheme, secondScheme];
    const document = new FakeDocument({
      matchMedia: (query: string): MediaQueryList => (
        query === "(prefers-color-scheme: dark)"
          ? required(schemes.shift())
          : new FakeMediaQueryList(false)
      ),
    });
    const firstMount = document.createElement("main") as unknown as FakeElement;
    const secondMount = document.createElement("main") as unknown as FakeElement;
    document.body.append(firstMount, secondMount);

    const first = new TestInspectorShell(
      document.document,
      firstMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    const second = new TestInspectorShell(
      document.document,
      secondMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(true);

    first.dispose();

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(false);

    secondScheme.publish(true);

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(true);

    second.dispose();

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(false);
    expect(firstScheme.listenerCount()).toBe(0);
    expect(secondScheme.listenerCount()).toBe(0);
  });

  it("resizes the sidebar by pointer and keyboard and remembers the size", () => {
    const stored = new Map<string, string>();
    const view = {
      matchMedia: (query: string): MediaQueryList => (
        new FakeMediaQueryList(false, query) as unknown as MediaQueryList
      ),
      localStorage: {
        getItem: (key: string): string | null => stored.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          stored.set(key, value);
        },
      },
    };
    const document = new FakeDocument(view as unknown as Pick<Window, "matchMedia">);
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);
    const inspector = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    const root = required(mount.querySelector(".pin-op-elements-inspector"));
    const resizer = required(mount.querySelector('[data-part="sidebar-resizer"]'));
    root.rect = rect(0, 0, 800, 600);
    resizer.rect = rect(496, 0, 0, 600);

    expect(resizer.getAttribute("role")).toBe("separator");
    expect(resizer.getAttribute("aria-orientation")).toBe("vertical");

    resizer.dispatch("pointerdown", { pointerId: 7, clientX: 496, clientY: 300 });
    expect(resizer.capturedPointers.has(7)).toBe(true);
    expect(resizer.dataset.state).toBe("active");

    resizer.dispatch("pointermove", { pointerId: 7, clientX: 420, clientY: 300 });
    expect(root.style.getPropertyValue("--pin-op-elements-sidebar-width"))
      .toBe("380px");

    // A drag past the minimum pane size clamps instead of hiding the tree.
    resizer.dispatch("pointermove", { pointerId: 7, clientX: 20, clientY: 300 });
    expect(root.style.getPropertyValue("--pin-op-elements-sidebar-width"))
      .toBe("640px");

    resizer.dispatch("pointerup", { pointerId: 7, clientX: 20, clientY: 300 });
    expect(resizer.capturedPointers.has(7)).toBe(false);
    expect(resizer.dataset.state).toBeUndefined();
    expect(stored.get("pin-op.inspector.sidebar-width")).toBe("640");

    const shrink = resizer.dispatch("keydown", { key: "ArrowRight" });
    expect(shrink.defaultPrevented).toBe(true);
    expect(root.style.getPropertyValue("--pin-op-elements-sidebar-width"))
      .toBe("624px");
    expect(stored.get("pin-op.inspector.sidebar-width")).toBe("624");

    expect(resizer.dispatch("keydown", { key: "ArrowUp" }).defaultPrevented)
      .toBe(false);

    inspector.dispose();

    const restored = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    const restoredRoot = required(mount.querySelector(".pin-op-elements-inspector"));

    expect(restoredRoot.style.getPropertyValue("--pin-op-elements-sidebar-width"))
      .toBe("624px");

    restored.dispose();
  });

  it("selects Chromium's untinted baseline surfaces while mounted", () => {
    const colorScheme = new FakeMediaQueryList(false);
    const document = new FakeDocument({
      matchMedia: (): MediaQueryList => colorScheme,
    });
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);

    expect(document.documentElement.classList.contains("baseline-grayscale")).toBe(false);

    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    expect(document.documentElement.classList.contains("baseline-grayscale")).toBe(true);

    colorScheme.publish(true);

    expect(document.documentElement.classList.contains("baseline-grayscale")).toBe(true);

    view.dispose();

    expect(document.documentElement.classList.contains("baseline-grayscale")).toBe(false);
  });

  it("restores a pre-existing Chromium baseline theme after disposal", () => {
    const colorScheme = new FakeMediaQueryList(false);
    const document = new FakeDocument({
      matchMedia: (): MediaQueryList => colorScheme,
    });
    document.documentElement.classList.add("baseline-grayscale");
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);

    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    view.dispose();

    expect(document.documentElement.classList.contains("baseline-grayscale")).toBe(true);
  });

  it("restores a pre-existing Chromium dark theme after disposal", () => {
    const colorScheme = new FakeMediaQueryList(false);
    const document = new FakeDocument({
      matchMedia: (): MediaQueryList => colorScheme,
    });
    document.documentElement.classList.add("theme-with-dark-background");
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);

    const view = new TestInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(true);

    view.dispose();

    expect(document.documentElement.classList.contains("theme-with-dark-background")).toBe(true);
    expect(colorScheme.listenerCount()).toBe(0);
  });

  it("implements a horizontal roving tablist with native keyboard focus", () => {
    const harness = createHarness();
    const root = required(harness.mount.querySelector(".pin-op-elements-inspector"));
    const rules = required(root.querySelectorAll('[role="tab"]')[0]) as unknown as FakeElement;
    const source = required(root.querySelectorAll('[role="tab"]')[1]) as unknown as FakeElement;

    rules.focus();
    const right = rules.dispatch("keydown", { key: "ArrowRight" });
    expect(right.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(source);
    expect(rules.getAttribute("aria-selected")).toBe("false");
    expect(rules.getAttribute("tabindex")).toBe("-1");
    expect(source.getAttribute("aria-selected")).toBe("true");
    expect(source.getAttribute("tabindex")).toBe("0");

    const wrappedRight = source.dispatch("keydown", { key: "ArrowRight" });
    expect(wrappedRight.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(rules);

    const wrappedLeft = rules.dispatch("keydown", { key: "ArrowLeft" });
    expect(wrappedLeft.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(source);

    const home = source.dispatch("keydown", { key: "Home" });
    expect(home.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(rules);

    const end = rules.dispatch("keydown", { key: "End" });
    expect(end.defaultPrevented).toBe(true);
    expect(harness.document.activeElement()).toBe(source);

    const ignored = source.dispatch("keydown", { key: "ArrowDown" });
    expect(ignored.defaultPrevented).toBe(false);
    expect(harness.document.activeElement()).toBe(source);

    harness.view.dispose();
    expect(harness.document.totalListeners()).toBe(0);
  });

  it("keeps every ARIA ID reference unique to its inspector instance", () => {
    const document = new FakeDocument();
    const occupiedIds = [
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
    const firstView = new TestInspectorShell(
      document.document,
      firstMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );
    const secondView = new TestInspectorShell(
      document.document,
      secondMount as unknown as HTMLElement,
      new FakeElementsBackend(elementsSession.tree),
    );

    const roots = [firstView.element, secondView.element] as unknown as FakeElement[];
    const documentIds = document.querySelectorAll("[id]").map((element) => element.id);
    expect(new Set(documentIds).size).toBe(documentIds.length);
    for (const root of roots) {
      const domPane = required(root.querySelector('[data-pane="dom"]'));
      const rulesTab = required(root.querySelector('[role="tab"]'));
      const sourceTab = required(root.querySelectorAll('[role="tab"]')[1]);
      const rulesPanel = required(root.querySelector('[data-pane="rules"]'));
      const sourcePanel = required(root.querySelector('[data-part="sidebar-extension"]'));
      expect(domPane.getAttribute("aria-label")).toBe("DOM tree");
      expect(domPane.getAttribute("aria-labelledby")).toBeNull();
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
    const renderedTree = required(
      harness.mount.querySelector('[data-part="test-tree-renderer"]'),
    );
    expect(harness.backend.listenerCount()).toBe(1);

    harness.view.dispose();
    harness.view.dispose();
    harness.backend.publish(withTextValue("must not render"));

    expect(harness.backend.listenerCount()).toBe(0);
    expect(harness.document.totalListeners()).toBe(0);
    expect(harness.mount.children).toHaveLength(0);
    expect(renderedTree.parentElement).toBeUndefined();
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
    expect(css).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(220px,\s*var\(--pin-op-elements-sidebar-width,\s*38%\)\)/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*clip;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__dom-pane,[\s\S]*?\.pin-op-elements-inspector \.pin-op-elements-inspector__sidebar\s*\{[^}]*overflow:\s*clip;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__dom-pane\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(css).not.toMatch(/pin-op-elements-inspector__pane-title/);
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__tree,[\s\S]*?\.pin-op-elements-inspector \.pin-op-elements-inspector__rules\s*\{[^}]*min-block-size:\s*0;[^}]*overflow:\s*auto;/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.pin-op-elements-inspector\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*grid-template-rows:\s*minmax\(160px,\s*1fr\)\s+auto\s+minmax\(120px,\s*var\(--pin-op-elements-sidebar-height,\s*45%\)\);/s,
    );
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

  it("styles only the selected sidebar tab with the DevTools active indicator", () => {
    const css = readFileSync(
      path.join(packageRoot, "assets", "devtools-elements.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__tab\s*\{[^}]*border-block-end:\s*2px solid transparent;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__tab\[aria-selected="true"\]\s*\{[^}]*border-block-end-color:\s*Highlight;[^}]*color:\s*Highlight;/s,
    );
  });

  it("keeps the native Rules pane full-width around the toolbar :hov control", () => {
    const css = readFileSync(
      path.join(packageRoot, "assets", "devtools-elements.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__rules\s*\{[^}]*position:\s*relative;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pseudo-state-toolbar-item\s*\{[^}]*position:\s*relative;[^}]*flex:\s*none;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.styles-pane\s*\{[^}]*inline-size:\s*100%;/s,
    );
    expect(css).not.toMatch(
      /\[data-part="chromium-read-only-styles-pane"\]::\-webkit-scrollbar/,
    );
    expect(css).not.toMatch(
      /\[data-part="chromium-read-only-styles-pane"\]\s*\{[^}]*scrollbar-(?:width|color)/s,
    );
    expect(css).not.toMatch(
      /\.pin-op-elements-inspector \.pseudo-state-controls\s*\{[^}]*display:\s*contents;/s,
    );
    expect(css).toMatch(
      /\.pseudo-state-description\[role="status"\],[\s\S]*?\.pseudo-state-description\[role="alert"\]\s*\{[^}]*position:\s*static;[^}]*clip-path:\s*none;[^}]*white-space:\s*normal;/s,
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
  const view = new TestInspectorShell(
    document.document,
    mount as unknown as HTMLElement,
    backend,
  );
  return { document, mount, backend, view };
}

/**
 * The production shell always receives Chromium's renderers. Tests inject
 * deterministic stand-ins so shell ownership is observable on its own.
 */
class TestInspectorShell extends ElementsInspectorShell {
  public constructor(
    document: Document,
    mount: HTMLElement,
    treeDataSource: Parameters<CreateElementsTreeRenderer>[2],
    rulesDataSource?: RulesDataSource,
    sourceLinkDelegate?: Parameters<CreateElementsRulesRenderer>[3],
    pseudoStateDataSource?: Parameters<CreateElementsRulesRenderer>[4],
    createTreeRenderer: CreateElementsTreeRenderer = createTestTreeRenderer,
    createRulesRenderer: CreateElementsRulesRenderer = createTestRulesRenderer,
  ) {
    super(
      document,
      mount,
      treeDataSource,
      rulesDataSource,
      sourceLinkDelegate,
      pseudoStateDataSource,
      createTreeRenderer,
      createRulesRenderer,
    );
  }
}

const createTestTreeRenderer: CreateElementsTreeRenderer = (
  document,
  mount,
  treeDataSource,
) => {
  const host = document.createElement("div");
  host.setAttribute("data-part", "test-tree-renderer");
  mount.append(host);
  const unsubscribe = treeDataSource.subscribe(() => {
    host.textContent = String(treeDataSource.snapshot().rows.length);
  });
  host.textContent = String(treeDataSource.snapshot().rows.length);
  return {
    dispose(): void {
      unsubscribe();
      host.textContent = "";
      host.remove();
    },
  };
};

const createTestRulesRenderer: CreateElementsRulesRenderer = (
  document,
  mount,
) => {
  const host = document.createElement("div");
  host.setAttribute("data-part", "test-rules-renderer");
  mount.append(host);
  return {
    render(): void {},
    clear(): void {},
    dispose(): void {
      host.remove();
    },
  };
};

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

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  } as DOMRect;
}

class FakeMediaQueryList {
  public matches: boolean;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  public constructor(matches: boolean, public readonly media = "") {
    this.matches = matches;
  }

  public addEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    if (type === "change") this.listeners.add(listener);
  }

  public removeEventListener(
    type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    if (type === "change") this.listeners.delete(listener);
  }

  public publish(matches: boolean): void {
    this.matches = matches;
    const event = { matches } as MediaQueryListEvent;
    for (const listener of [...this.listeners]) listener(event);
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

class ThrowingSnapshotRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(public readonly snapshotError: Error) {}

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

class ThrowingUnsubscribePseudoStateDataSource extends MutablePseudoStateDataSource {
  public constructor(
    snapshot: PseudoSnapshot,
    private readonly unsubscribeError: Error,
  ) {
    super(snapshot);
  }

  public override subscribe(listener: () => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      unsubscribe();
      throw this.unsubscribeError;
    };
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

function expectEmptyRulesShell(view: ElementsInspectorView): void {
  expect(view.rulesRoot.children).toHaveLength(0);
  expect(view.rulesRoot.getAttribute("data-state")).toBe("empty");
  expect(view.rulesRoot.getAttribute("aria-busy")).toBe("false");
  for (const attribute of [
    "data-document-epoch",
    "data-selection-revision",
    "data-styles-revision",
    "data-stylesheet-revision",
    "data-pseudo-state-revision",
    "data-pseudo-states",
    "data-probe-rule-ref",
  ]) {
    expect(view.rulesRoot.getAttribute(attribute)).toBeNull();
  }
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
