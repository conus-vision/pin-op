import { describe, expect, it } from "vitest";
import type {
  CreateElementsRulesRenderer,
  CreateElementsTreeRenderer,
  MatchedStylesSnapshot,
  RulesDataSource,
  RulesPresentationSnapshot,
} from "../src/contracts.js";
import { ElementsInspectorShell } from "../src/elementsInspectorShell.js";
import { elementsSession } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

describe("matched styles contract", () => {
  it("provides a deeply immutable runtime snapshot with display-only source data", () => {
    const presentation = elementsSession.rules as unknown as RulesPresentationSnapshot;
    expect(presentation.state).toBe("ready");
    if (presentation.state !== "ready") {
      throw new Error("Expected the fixture to expose ready matched styles");
    }

    const styles = presentation.matchedStyles;
    const rule = required(styles.matchedRules[0]);
    const declaration = required(rule.declarations[0]);
    const context = required(rule.contexts[0]);
    const inherited = required(styles.inherited[0]);
    const generatedSource = required(rule.generatedSource);

    expect([
      presentation,
      styles,
      styles.inlineStyle,
      styles.matchedRules,
      rule,
      rule.matchingSelectorIndices,
      rule.declarations,
      declaration,
      rule.contexts,
      context,
      styles.inherited,
      inherited,
      inherited.matchedRules,
      styles.diagnostics,
      styles.pseudoStates,
      generatedSource,
    ].every((value) => Object.isFrozen(value))).toBe(true);
    expect(styles).toMatchObject({
      pseudoStateRevision: 2,
      pseudoStates: ["hover", "focus"],
      unsupportedRuleCount: 1,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 1,
    });
    expect(generatedSource).toEqual({
      label: "app.css",
      lineNumber: 17,
      columnNumber: 5,
    });
    expect(inherited).toMatchObject({
      ancestorIndex: 1,
      displayLabel: "html#root.app-shell",
    });
    expect(Object.keys(inherited)).not.toContain("nodeRef");
    expect(Object.keys(generatedSource)).not.toEqual(
      expect.arrayContaining(["url", "uri", "path", "range", "openAuthorityId"]),
    );
    expect(() => {
      (rule.declarations as unknown as Array<unknown>).push({});
    }).toThrow(TypeError);
    expect(() => {
      (generatedSource as { label: string }).label = "C:\\private\\app.css";
    }).toThrow(TypeError);
  });

  it("transitions the Rules shell without changing the DOM selection", () => {
    const matchedStyles = readyMatchedStyles();
    const rules = new FakeRulesDataSource({ state: "empty" });
    const harness = createHarness(rules);

    expectRulesState(harness, "empty");
    // A pane that empties without saying why reads as the panel breaking, and
    // this is the state a selection lost to page script lands in.
    expect(harness.view.rulesRoot.textContent).toContain("No element selected");

    rules.publish({ state: "loading" });
    expectRulesState(harness, "loading");
    expect(harness.view.rulesRoot.getAttribute("aria-busy")).toBe("true");

    rules.publish({ state: "ready", matchedStyles });
    expectRulesState(harness, "ready");

    rules.publish({ state: "partial", matchedStyles });
    expectRulesState(harness, "partial");

    rules.publish({
      state: "error",
      message: "Styles unavailable <img src=x onerror=alert(1)>",
      diagnostics: Object.freeze([
        Object.freeze({
          code: "rules-unavailable",
          severity: "error" as const,
          message: "Rules could not be read",
        }),
      ]),
    });
    expectRulesState(harness, "error");
    expect(harness.view.rulesRoot.textContent).toContain(
      "Styles unavailable <img src=x onerror=alert(1)>",
    );
    expect(harness.mount.querySelector("img")).toBeNull();
    expect(harness.document.createdTags()).not.toContain("img");

    expect(harness.treeBackend.selected).toEqual([]);
    expect(rules.listenerCount()).toBe(1);
    harness.view.dispose();
    expect(rules.listenerCount()).toBe(0);
  });

  it("cleans an eager Rules subscription when its initial snapshot throws", () => {
    const snapshotError = new Error("initial Rules snapshot failed");
    const rules = new EagerThrowingRulesDataSource(snapshotError);
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);
    const treeBackend = new FakeElementsBackend(elementsSession.tree);

    expect(() => new ElementsInspectorShell(
      document.document,
      mount as unknown as HTMLElement,
      treeBackend,
      rules,
      undefined,
      undefined,
      createTestTreeRenderer,
      createTestRulesRenderer,
    )).toThrow(snapshotError);

    expect(rules.listenerCount()).toBe(0);
    expect(treeBackend.listenerCount()).toBe(0);
    expect(document.totalListeners()).toBe(0);
    expect(mount.children).toHaveLength(0);
  });
});

class FakeRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private current: RulesPresentationSnapshot) {}

  public snapshot(): RulesPresentationSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

class EagerThrowingRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly snapshotError: Error) {}

  public snapshot(): RulesPresentationSnapshot {
    throw this.snapshotError;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }

  public filter(_query: string): void {}

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function createHarness(rules: RulesDataSource) {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  document.body.append(mount);
  const treeBackend = new FakeElementsBackend(elementsSession.tree);
  const view = new ElementsInspectorShell(
    document.document,
    mount as unknown as HTMLElement,
    treeBackend,
    rules,
    undefined,
    undefined,
    createTestTreeRenderer,
    createTestRulesRenderer,
  );
  return { document, mount, rules, treeBackend, view };
}

function expectRulesState(
  harness: ReturnType<typeof createHarness>,
  state: RulesPresentationSnapshot["state"],
): void {
  expect(harness.view.rulesRoot.getAttribute("data-state")).toBe(state);
  expect(harness.view.rulesRoot.getAttribute("aria-busy")).toBe(
    state === "loading" ? "true" : "false",
  );
}

const createTestTreeRenderer: CreateElementsTreeRenderer = (
  document,
  mount,
  treeDataSource,
) => {
  const host = document.createElement("div");
  mount.append(host);
  const unsubscribe = treeDataSource.subscribe(() => {});
  return {
    dispose(): void {
      unsubscribe();
      host.remove();
    },
  };
};

const createTestRulesRenderer: CreateElementsRulesRenderer = (
  document,
  mount,
) => {
  const host = document.createElement("div");
  mount.append(host);
  return {
    render(): void {},
    clear(): void {},
    dispose(): void {
      host.remove();
    },
  };
};

function readyMatchedStyles(): MatchedStylesSnapshot {
  const presentation = elementsSession.rules as unknown as RulesPresentationSnapshot;
  if (presentation.state !== "ready") {
    throw new Error("Expected the fixture to expose ready matched styles");
  }
  return presentation.matchedStyles;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Missing expected matched styles fixture value");
  }
  return value;
}
