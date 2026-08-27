import { describe, expect, it, vi } from "vitest";
import type {
  MatchedStylesSnapshot,
  PseudoStateDataSource,
  PseudoStateSnapshot,
  RuleOriginDecoration,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
  TreePresentationSnapshot,
} from "../src/contracts.js";
import {
  createPinOpChromiumInspectorViewFactory,
  type PinOpChromiumInspectorAdapterOptions,
  type PinOpChromiumInspectorRuntime,
} from "../src/chromium/upstream/PinOpChromiumInspectorAdapter.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";
import { FakeChromiumElementsRuntime } from
  "./support/fakeChromiumElementsRuntime.js";
import { FakeChromiumReadOnlyStylesRuntime } from
  "./support/fakeChromiumStylesRuntime.js";

describe("PinOpChromiumInspectorAdapter", () => {
  it("composes the Chromium DOM and Styles adapters inside the Pin-op shell", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const runtime = combinedRuntime(treeRuntime, stylesRuntime);
    const treeSource = new FakeElementsBackend(treeSnapshot());
    const rulesSource = new StaticRulesDataSource(readyRules());

    const createView = createPinOpChromiumInspectorViewFactory(runtime);
    const host = createView(
      document.document,
      mount as unknown as HTMLElement,
      treeSource,
    );
    host.bindRulesDataSource(rulesSource);

    expect(treeRuntime.createdOutline).toBeDefined();
    expect(stylesRuntime.createCount).toBe(1);
    expect(stylesRuntime.createdPane?.rendered).toEqual([
      readyRules().matchedStyles,
    ]);
    expect((host.domRoot as unknown as FakeElement).children.at(-1)).toBe(
      treeRuntime.createdOutline?.element,
    );
    expect((host.rulesRoot as unknown as FakeElement).children.at(-1)).toBe(
      stylesRuntime.createdPane?.element,
    );
    expect(host.sidebarExtensionMount.getAttribute("data-part")).toBe(
      "sidebar-extension",
    );

    host.dispose();
    expect(treeRuntime.cleanupCount).toBe(1);
    expect(stylesRuntime.createdPane?.disposeCount).toBe(1);
    expect(mount.children).toEqual([]);
  });

  it("forwards Source and pseudo-state boundaries through the composed host", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const sourceLinks = new RecordingSourceLinkDelegate();
    const pseudoStates = new RecordingPseudoStateDataSource();
    const host = createPinOpChromiumInspectorViewFactory(combinedRuntime(
      treeRuntime,
      stylesRuntime,
    ))(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(treeSnapshot()),
    );

    host.bindRulesDataSource(
      new StaticRulesDataSource(readyRules()),
      sourceLinks,
      pseudoStates,
    );

    const pane = required(stylesRuntime.createdPane);
    expect(pane.resolveOrigin("rule:html")).toEqual(sourceLinks.origin);
    pane.openOrigin("rule:html");
    expect(sourceLinks.opened).toEqual(["rule:html"]);
    expect(pseudoStates.listenerCount()).toBe(1);
    expect((host.rulesRoot as unknown as FakeElement).children).toEqual([
      required((host.rulesRoot as unknown as FakeElement).querySelector(
        '[data-part="rules-message"]',
      )),
      required((host.rulesRoot as unknown as FakeElement).querySelector(
        '[data-part="pseudo-state-controls"]',
      )),
      pane.element,
    ]);

    const inspector = host.element as unknown as FakeElement;
    const sidebar = required(inspector.children[1]);
    const tabList = required(sidebar.children[0]);
    required(tabList.children[1]).dispatch("click");
    expect((host.rulesRoot as unknown as FakeElement).hidden).toBe(true);
    expect((host.sidebarExtensionMount as unknown as FakeElement).hidden).toBe(
      false,
    );

    host.dispose();
    expect(pseudoStates.listenerCount()).toBe(0);
  });

  it("routes DOM and Styles diagnostics through one powerless observer", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const runtime = combinedRuntime(treeRuntime, stylesRuntime);
    const treeError = new Error("tree diagnostic");
    const stylesError = new Error("styles diagnostic");
    const treeSource = new ThrowingFocusElementsBackend(
      treeSnapshot(),
      treeError,
    );
    const onError = vi.fn(() => {
      throw new Error("observer failure");
    });
    const host = createPinOpChromiumInspectorViewFactory(runtime, { onError })(
      document.document,
      mount as unknown as HTMLElement,
      treeSource,
    );
    host.bindRulesDataSource(new StaticRulesDataSource(readyRules()));

    const html = required(treeRuntime.createdOutline?.rootDOMNode?.children()?.[0]);
    expect(() => treeRuntime.createdOutline?.simulateUserSelection(html, true))
      .not.toThrow();
    expect(() => stylesRuntime.createdPane?.report(stylesError))
      .not.toThrow();
    expect(onError.mock.calls.map(([error]) => error)).toEqual([
      treeError,
      stylesError,
    ]);
    expect(() => host.dispose()).not.toThrow();
  });

  it("snapshots one diagnostic observer from accessor-backed options", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const treeError = new Error("tree diagnostic");
    const stylesError = new Error("styles diagnostic");
    const sharedObserver = vi.fn();
    const laterObserver = vi.fn();
    let observerReads = 0;
    const options = Object.defineProperty({}, "onError", {
      get: (): ((error: unknown) => void) => {
        observerReads += 1;
        return observerReads === 1 ? sharedObserver : laterObserver;
      },
    }) as PinOpChromiumInspectorAdapterOptions;
    const createView = createPinOpChromiumInspectorViewFactory(
      combinedRuntime(treeRuntime, stylesRuntime),
      options,
    );
    const host = createView(
      document.document,
      mount as unknown as HTMLElement,
      new ThrowingFocusElementsBackend(treeSnapshot(), treeError),
    );
    host.bindRulesDataSource(new StaticRulesDataSource(readyRules()));

    const html = required(treeRuntime.createdOutline?.rootDOMNode?.children()?.[0]);
    treeRuntime.createdOutline?.simulateUserSelection(html, true);
    stylesRuntime.createdPane?.report(stylesError);

    expect(observerReads).toBe(1);
    expect(sharedObserver.mock.calls.map(([error]) => error)).toEqual([
      treeError,
      stylesError,
    ]);
    expect(laterObserver).not.toHaveBeenCalled();
    host.dispose();
  });

  it("rolls back the composed view when Chromium DOM construction fails", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const constructionError = new Error("tree construction failed");
    Object.defineProperty(treeRuntime, "ElementsTreeOutline", {
      configurable: true,
      value: class {
        public constructor() {
          throw constructionError;
        }
      },
    });

    expect(() => createPinOpChromiumInspectorViewFactory(combinedRuntime(
      treeRuntime,
      stylesRuntime,
    ))(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(treeSnapshot()),
    )).toThrow(constructionError);

    expect(treeRuntime.cleanupCount).toBe(1);
    expect(stylesRuntime.createCount).toBe(0);
    expect(mount.children).toEqual([]);
    expect(document.totalListeners()).toBe(0);
  });

  it.each([
    ["subscription", "subscribeError"],
    ["snapshot render", "snapshotError"],
  ] as const)("rolls back a failed Styles %s binding", (_label, failure) => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    document.body.append(mount);
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const source = new FailingRulesDataSource(readyRules());
    const bindingError = new Error(`${failure} failed`);
    source[failure] = bindingError;
    const host = createPinOpChromiumInspectorViewFactory(combinedRuntime(
      treeRuntime,
      stylesRuntime,
    ))(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(treeSnapshot()),
    );

    expect(() => host.bindRulesDataSource(source)).toThrow(bindingError);
    expect(stylesRuntime.createdPane?.disposeCount).toBe(1);
    expect(source.listenerCount()).toBe(0);
    expect((host.rulesRoot as unknown as FakeElement).children).toEqual([]);

    expect(() => host.dispose()).not.toThrow();
    expect(treeRuntime.cleanupCount).toBe(1);
    expect(mount.children).toEqual([]);
    expect(document.totalListeners()).toBe(0);
  });

  it("contains a native Styles render failure and keeps the composed host reusable", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const treeRuntime = new FakeChromiumElementsRuntime();
    const stylesRuntime = new FakeChromiumReadOnlyStylesRuntime();
    const renderError = new Error("native render failed");
    const onError = vi.fn();
    stylesRuntime.paneRenderError = renderError;
    const host = createPinOpChromiumInspectorViewFactory(combinedRuntime(
      treeRuntime,
      stylesRuntime,
    ), { onError })(
      document.document,
      mount as unknown as HTMLElement,
      new FakeElementsBackend(treeSnapshot()),
    );

    expect(() => host.bindRulesDataSource(
      new StaticRulesDataSource(readyRules()),
    )).not.toThrow();
    expect(onError).toHaveBeenCalledWith(renderError);
    expect(stylesRuntime.createdPane?.clearCount).toBe(1);

    stylesRuntime.paneRenderError = undefined;
    host.dispose();
    expect(stylesRuntime.createdPane?.disposeCount).toBe(1);
  });
});

function combinedRuntime(
  treeRuntime: FakeChromiumElementsRuntime,
  stylesRuntime: FakeChromiumReadOnlyStylesRuntime,
): PinOpChromiumInspectorRuntime {
  return Object.assign(treeRuntime, {
    createPane: stylesRuntime.createPane.bind(stylesRuntime),
  });
}

class StaticRulesDataSource implements RulesDataSource {
  public constructor(private readonly value: RulesPresentationSnapshot) {}

  public snapshot(): RulesPresentationSnapshot {
    return this.value;
  }

  public subscribe(_listener: () => void): () => void {
    return () => undefined;
  }

  public filter(_query: string): void {}
}

class FailingRulesDataSource extends StaticRulesDataSource {
  public subscribeError: unknown;
  public snapshotError: unknown;
  private readonly listeners = new Set<() => void>();

  public override snapshot(): RulesPresentationSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError;
    return super.snapshot();
  }

  public override subscribe(listener: () => void): () => void {
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

class ThrowingFocusElementsBackend extends FakeElementsBackend {
  public constructor(
    snapshot: TreePresentationSnapshot,
    private readonly focusError: Error,
  ) {
    super(snapshot);
  }

  public override focus(nodeRef: string): void {
    super.focus(nodeRef);
    throw this.focusError;
  }
}

class RecordingSourceLinkDelegate implements SourceLinkDelegate {
  public readonly opened: string[] = [];
  public readonly origin: RuleOriginDecoration = Object.freeze({
    label: "style.scss",
    languageId: "scss",
    startLine: 770,
    startColumn: 3,
    confidence: "sourcemap",
    clickable: true,
  });

  public originFor(_ruleRef: string): RuleOriginDecoration {
    return this.origin;
  }

  public openRuleOrigin(ruleRef: string): void {
    this.opened.push(ruleRef);
  }
}

class RecordingPseudoStateDataSource implements PseudoStateDataSource {
  private readonly listeners = new Set<() => void>();

  public snapshot(): PseudoStateSnapshot {
    return Object.freeze({
      state: "ready",
      states: Object.freeze([]),
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 0,
    });
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async setStates(_states: readonly ("hover" | "focus")[]): Promise<void> {}

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function treeSnapshot(): TreePresentationSnapshot {
  return Object.freeze({
    rows: Object.freeze([Object.freeze({
      type: "node" as const,
      nodeRef: "html",
      depth: 0,
      expanded: false,
      expandable: false,
      selected: true,
      focused: true,
      hovered: false,
      node: Object.freeze({
        nodeRef: "html",
        kind: "element" as const,
        nodeType: 1,
        nodeName: "HTML",
        attributes: Object.freeze([]),
        childCount: 0,
        relationship: "dom" as const,
        selectable: true,
        expandable: false,
        branchRevision: 0,
      }),
    })]),
  });
}

function readyRules(): Extract<RulesPresentationSnapshot, { state: "ready" }> {
  return Object.freeze({
    state: "ready" as const,
    matchedStyles: matchedStyles(),
  });
}

function matchedStyles(): MatchedStylesSnapshot {
  return Object.freeze({
    documentEpoch: 1,
    selectionRevision: 1,
    stylesRevision: 1,
    stylesheetRevision: 1,
    pseudoStateRevision: 0,
    pseudoStates: Object.freeze([]),
    nodeRef: "html",
    matchedRules: Object.freeze([Object.freeze({
      ruleRef: "rule:html",
      selectorText: "html",
      matchingSelectorIndices: Object.freeze([0]),
      declarations: Object.freeze([]),
      contexts: Object.freeze([]),
    })]),
    inherited: Object.freeze([]),
    unsupportedRuleCount: 0,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 0,
    omittedRuleCount: 0,
    diagnostics: Object.freeze([]),
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be present");
  }
  return value;
}
