import { describe, expect, it } from "vitest";
import type {
  MatchedStylesSnapshot,
  PseudoStateDataSource,
  PseudoStateSnapshot,
  RuleOriginDecoration,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
} from "../src/contracts.js";
import { createPinOpStylesRulesRenderer } from
  "../src/chromium/upstream/PinOpStylesSidebarAdapter.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import {
  FakeChromiumReadOnlyStylesRuntime,
} from "./support/fakeChromiumStylesRuntime.js";

describe("PinOpStylesSidebarAdapter", () => {
  it("keeps the native pane as a stable direct child and renders only changed snapshots", () => {
    const harness = createHarness();
    const first = styles("rule:first", 1);
    const second = styles("rule:second", 2);

    harness.host.render(first);
    harness.host.render(first);
    harness.host.render(second);

    expect(harness.mount.children).toEqual([
      harness.sentinel,
      harness.pane.element as unknown as FakeElement,
    ]);
    expect(harness.pane.rendered).toEqual([first, second]);
    expect(harness.pane.refreshCount).toBe(1);
    expect(harness.pane.element.parentElement).toBe(
      harness.mount as unknown as HTMLElement,
    );
    expect(harness.dataSource.listenerCount()).toBe(0);
  });

  it("refreshes origins after clear only following a new full render", () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);

    harness.host.render(snapshot);
    harness.host.clear();
    harness.host.render(snapshot);
    harness.host.render(snapshot);

    expect(harness.pane.clearCount).toBe(1);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(1);
    expect(harness.pane.element).toBe(
      harness.mount.children[1] as unknown as HTMLElement,
    );
  });

  it("recovers from refresh and clear failures without leaving native content", () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    const refreshError = new Error("origin refresh failed");
    const clearError = new Error("native clear failed");
    harness.host.render(snapshot);
    harness.pane.element.append(harness.document.createElement("script"));
    harness.runtime.paneRefreshError = refreshError;
    harness.runtime.paneClearError = clearError;

    expect(() => harness.host.render(snapshot)).not.toThrow();
    expect(harness.pane.element.children).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
    expect((harness.errors[0] as AggregateError).errors).toEqual([
      refreshError,
      clearError,
    ]);

    harness.pane.element.append(harness.document.createElement("span"));
    expect(() => harness.host.clear()).not.toThrow();
    expect(harness.pane.element.children).toHaveLength(0);
    expect(harness.errors).toHaveLength(2);
    expect(harness.errors[1]).toBe(clearError);
  });

  it("exposes only current sanitized origins and revalidates clickable open authority", () => {
    const origin = Object.freeze({
      label: "theme.scss",
      languageId: "scss",
      startLine: 73,
      startColumn: 5,
      confidence: "sourcemap",
      clickable: true,
    } satisfies RuleOriginDecoration);
    const source = new FakeSourceLinkDelegate(origin);
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));

    const resolved = harness.pane.resolveOrigin("rule:one");
    harness.pane.openOrigin("rule:one");
    harness.pane.openOrigin("rule:stale");
    harness.pane.openOrigin({ toString: () => "rule:one" });

    expect(resolved).toEqual(origin);
    expect(resolved).not.toBe(origin);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(source.originRequests).toEqual(["rule:one", "rule:one"]);
    expect(source.opened).toEqual(["rule:one"]);

    harness.host.render(styles("rule:two", 2));
    expect(harness.pane.resolveOrigin("rule:one")).toBeUndefined();
  });

  it("revokes a source open when origin lookup reenters with newer authority", () => {
    const source = new FakeSourceLinkDelegate({
      label: "theme.scss",
      languageId: "scss",
      startLine: 73,
      startColumn: 5,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));
    source.onOriginFor = () => harness.host.render(styles("rule:two", 2));

    harness.pane.openOrigin("rule:one");

    expect(source.opened).toEqual([]);
    expect(harness.pane.resolveOrigin("rule:one")).toBeUndefined();
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("revalidates authority after reading a hostile open callback", () => {
    const source = new FakeSourceLinkDelegate({
      label: "theme.scss",
      languageId: "scss",
      startLine: 73,
      startColumn: 5,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));
    Object.defineProperty(source, "openRuleOrigin", {
      configurable: true,
      get: () => {
        harness.host.render(styles("rule:two", 2));
        return (ruleRef: string): void => source.opened.push(ruleRef);
      },
    });

    harness.pane.openOrigin("rule:one");

    expect(source.opened).toEqual([]);
  });

  it("does not touch source delegate getters for unknown or stale rule refs", () => {
    const source = new FakeSourceLinkDelegate({
      label: "theme.scss",
      languageId: "scss",
      startLine: 73,
      startColumn: 5,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));
    let openGetterReads = 0;
    Object.defineProperty(source, "openRuleOrigin", {
      configurable: true,
      get: () => {
        openGetterReads += 1;
        return (ruleRef: string): void => source.opened.push(ruleRef);
      },
    });

    harness.pane.openOrigin("rule:unknown");
    harness.host.render(styles("rule:two", 2));
    harness.pane.openOrigin("rule:one");

    expect(openGetterReads).toBe(0);
    expect(source.originRequests).toEqual([]);
    expect(source.opened).toEqual([]);
  });

  it("rejects a clickable origin whose authority state is not ready", () => {
    const source = new FakeSourceLinkDelegate({
      label: "stale.scss",
      languageId: "scss",
      startLine: 7,
      startColumn: 1,
      confidence: "sourcemap",
      clickable: true,
      state: "stale",
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));

    expect(harness.pane.resolveOrigin("rule:one")).toBeUndefined();
    harness.pane.openOrigin("rule:one");

    expect(source.opened).toEqual([]);
    expect(harness.errors).toHaveLength(2);
  });

  it.each([
    ["dot", "."],
    ["dot-dot", ".."],
    ["colon", "C:theme.scss"],
    ["C0 control", "theme\t.scss"],
    ["C1 control", "theme\u0085.scss"],
    ["bidi control", "theme\u202e.scss"],
    ["too long", "x".repeat(129)],
  ])("rejects a source label outside the protocol safe-basename contract: %s", (
    _case,
    label,
  ) => {
    const source = new FakeSourceLinkDelegate({
      label,
      languageId: "scss",
      startLine: 1,
      startColumn: 1,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));

    expect(harness.pane.resolveOrigin("rule:one")).toBeUndefined();
    expect(harness.errors).toHaveLength(1);
  });

  it("accepts a 128-code-unit protocol-safe source basename", () => {
    const label = `${"x".repeat(123)}.scss`;
    const source = new FakeSourceLinkDelegate({
      label,
      languageId: "scss",
      startLine: 1,
      startColumn: 1,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));

    expect(harness.pane.resolveOrigin("rule:one")?.label).toBe(label);
    expect(harness.errors).toEqual([]);
  });

  it("makes a missing or invalid source delegate inert and reports delegate failures", () => {
    const missing = createHarness();
    missing.host.render(styles("rule:one", 1));
    expect(missing.pane.resolveOrigin("rule:one")).toBeUndefined();
    expect(() => missing.pane.openOrigin("rule:one")).not.toThrow();

    const originError = new Error("origin lookup failed");
    const openError = new Error("open failed");
    const source: SourceLinkDelegate = {
      originFor: () => {
        throw originError;
      },
      openRuleOrigin: () => {
        throw openError;
      },
    };
    const failing = createHarness({ source });
    failing.host.render(styles("rule:one", 1));
    expect(failing.pane.resolveOrigin("rule:one")).toBeUndefined();

    const invalidSource = new FakeSourceLinkDelegate({
      label: "../../private/theme.scss",
      languageId: "scss",
      startLine: 0,
      startColumn: 1,
      confidence: "sourcemap",
      clickable: true,
    } as RuleOriginDecoration);
    const invalid = createHarness({ source: invalidSource });
    invalid.host.render(styles("rule:one", 1));
    expect(invalid.pane.resolveOrigin("rule:one")).toBeUndefined();

    const clickable = new FakeSourceLinkDelegate({
      label: "theme.css",
      languageId: "css",
      startLine: 2,
      startColumn: 1,
      confidence: "exact",
      clickable: true,
    });
    const openFailing = createHarness({ source: clickable });
    clickable.openError = openError;
    openFailing.host.render(styles("rule:one", 1));
    expect(() => openFailing.pane.openOrigin("rule:one")).not.toThrow();

    expect(failing.errors).toEqual([originError]);
    expect(invalid.errors).toHaveLength(1);
    expect(openFailing.errors).toEqual([openError]);
  });

  it("owns the pseudo-state controller as a direct sibling and disposes its subscription", () => {
    const pseudo = new FakePseudoStateDataSource();
    const harness = createHarness({ pseudo });
    const controls = required(
      harness.mount.querySelector('[data-part="pseudo-state-controls"]'),
    );

    expect(harness.mount.children).toEqual([
      harness.sentinel,
      controls,
      harness.pane.element as unknown as FakeElement,
    ]);
    expect(controls.parentElement).toBe(harness.mount);
    expect(pseudo.listenerCount()).toBe(1);

    harness.host.dispose();
    expect(pseudo.listenerCount()).toBe(0);
    expect(harness.mount.children).toEqual([harness.sentinel]);
    expect(harness.document.totalListeners()).toBe(0);
  });

  it("rolls back every new node when the runtime factory throws", () => {
    const runtime = new FakeChromiumReadOnlyStylesRuntime();
    runtime.leakBeforeCreateError = true;
    runtime.createError = new Error("factory failed");
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const sentinel = document.createElement("p") as unknown as FakeElement;
    mount.append(sentinel);

    expect(() => createPinOpStylesRulesRenderer(runtime)(
      document.document,
      mount as unknown as HTMLElement,
      new FakeRulesDataSource(),
    )).toThrow(runtime.createError);
    expect(mount.children).toEqual([sentinel]);
  });

  it("rejects a detached native pane and tears it down atomically", () => {
    const runtime = new FakeChromiumReadOnlyStylesRuntime();
    runtime.leavePaneDetached = true;
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const sentinel = document.createElement("p") as unknown as FakeElement;
    mount.append(sentinel);

    expect(() => createPinOpStylesRulesRenderer(runtime)(
      document.document,
      mount as unknown as HTMLElement,
      new FakeRulesDataSource(),
    )).toThrow(/direct child/i);
    expect(runtime.createdPane?.disposeCount).toBe(1);
    expect(mount.children).toEqual([sentinel]);
  });

  it("cleans the native pane when pseudo-state initialization fails", () => {
    const runtime = new FakeChromiumReadOnlyStylesRuntime();
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const sentinel = document.createElement("p") as unknown as FakeElement;
    mount.append(sentinel);
    const pseudo = new FakePseudoStateDataSource();
    pseudo.subscribeError = new Error("pseudo subscribe failed");

    expect(() => createPinOpStylesRulesRenderer(runtime)(
      document.document,
      mount as unknown as HTMLElement,
      new FakeRulesDataSource(),
      undefined,
      pseudo,
    )).toThrow(pseudo.subscribeError);
    expect(runtime.createdPane?.disposeCount).toBe(1);
    expect(pseudo.listenerCount()).toBe(0);
    expect(mount.children).toEqual([sentinel]);
    expect(document.totalListeners()).toBe(0);
  });

  it("contains render failures, clears partial native state, and retries a full render", () => {
    const renderError = new Error("native render failed");
    const clearError = new Error("native clear failed");
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    harness.runtime.paneRenderError = renderError;
    harness.runtime.paneClearError = clearError;

    expect(() => harness.host.render(snapshot)).not.toThrow();
    expect(harness.pane.clearCount).toBe(1);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toBeInstanceOf(AggregateError);
    expect((harness.errors[0] as AggregateError).errors).toEqual([
      renderError,
      clearError,
    ]);

    harness.runtime.paneRenderError = undefined;
    harness.runtime.paneClearError = undefined;
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
  });

  it("does not let a stale outer render clear a newer reentrant snapshot", () => {
    const harness = createHarness();
    const first = styles("rule:first", 1);
    const second = styles("rule:second", 2);
    harness.runtime.paneRenderError = new Error("stale outer failure");
    harness.runtime.onPaneRender = () => {
      harness.runtime.paneRenderError = undefined;
      harness.host.render(second);
    };

    harness.host.render(first);
    harness.host.render(second);

    expect(harness.pane.rendered).toEqual([first, second]);
    expect(harness.pane.refreshCount).toBe(1);
    expect(harness.pane.clearCount).toBe(0);
  });

  it("fully rerenders the latest snapshot after an older serialized render fails", () => {
    const harness = createHarness();
    const baseline = styles("rule:baseline", 1);
    const stale = styles("rule:stale", 2);
    harness.host.render(baseline);
    harness.runtime.paneRenderError = new Error("stale outer failure");
    harness.runtime.onPaneRender = () => {
      harness.runtime.paneRenderError = undefined;
      harness.host.render(baseline);
    };

    harness.host.render(stale);

    expect(harness.pane.rendered).toEqual([baseline, stale, baseline]);
    expect(harness.pane.refreshCount).toBe(0);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("keeps a newer render authoritative when a stale snapshot getter reenters then throws", () => {
    const source = new FakeSourceLinkDelegate({
      label: "latest.scss", languageId: "scss", startLine: 4, startColumn: 2,
      confidence: "sourcemap", clickable: true,
    });
    const harness = createHarness({ source });
    const latest = styles("rule:latest", 2);
    const getterError = new Error("hostile matchedRules getter");
    const stale = reentrantStyles(styles("rule:stale", 1), () => {
      harness.host.render(latest);
      throw getterError;
    });

    harness.host.render(stale);

    expect(harness.pane.rendered).toEqual([latest]);
    expect(harness.pane.clearCount).toBe(0);
    expect(harness.pane.resolveOrigin("rule:latest")?.label).toBe("latest.scss");
    expect(harness.pane.resolveOrigin("rule:stale")).toBeUndefined();
    expect(harness.errors).toEqual([getterError]);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("ignores a nonthrowing stale outer snapshot after its getter renders newer state", () => {
    const source = new FakeSourceLinkDelegate({
      label: "latest.css", languageId: "css", startLine: 1, startColumn: 1,
      confidence: "exact", clickable: true,
    });
    const harness = createHarness({ source });
    const staleBase = styles("rule:stale", 1);
    const latest = styles("rule:latest", 2);
    const stale = reentrantStyles(staleBase, () => {
      harness.host.render(latest);
      return staleBase.matchedRules;
    });

    harness.host.render(stale);

    expect(harness.pane.rendered).toEqual([latest]);
    expect(harness.pane.resolveOrigin("rule:latest")?.label).toBe("latest.css");
    expect(harness.pane.resolveOrigin("rule:stale")).toBeUndefined();
    expect(harness.errors).toEqual([]);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("keeps a reentrant clear authoritative when the stale snapshot getter throws", () => {
    const harness = createHarness();
    harness.host.render(styles("rule:baseline", 0));
    const getterError = new Error("stale getter after clear");
    const stale = reentrantStyles(styles("rule:stale", 1), () => {
      harness.host.clear();
      throw getterError;
    });

    harness.host.render(stale);

    expect(harness.pane.rendered.map(snapshot => snapshot.stylesRevision)).toEqual([0]);
    expect(harness.pane.clearCount).toBe(1);
    expect(harness.pane.resolveOrigin("rule:baseline")).toBeUndefined();
    expect(harness.errors).toEqual([getterError]);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("keeps reentrant disposal authoritative when a stale getter returns", () => {
    const harness = createHarness();
    const staleBase = styles("rule:stale", 1);
    const stale = reentrantStyles(staleBase, () => {
      harness.host.dispose();
      return staleBase.matchedRules;
    });

    harness.host.render(stale);

    expect(harness.pane.rendered).toEqual([]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(harness.mount.children).toEqual([harness.sentinel]);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("serializes reentrant presentation and coalesces to the latest desired state", () => {
    const harness = createHarness();
    const first = styles("rule:first", 1);
    const second = styles("rule:second", 2);
    const third = styles("rule:third", 3);
    harness.runtime.onPaneRender = () => {
      harness.host.render(second);
      harness.host.clear();
      harness.host.render(third);
    };

    harness.host.render(first);

    expect(harness.pane.rendered).toEqual([first, third]);
    expect(harness.pane.clearCount).toBe(0);
    expect(harness.runtime.paneCalls).toEqual([
      "render:rule:first",
      "render:rule:third",
    ]);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("keeps a newer render authoritative when native clear reenters", () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    harness.host.render(snapshot);
    harness.runtime.onPaneClear = () => harness.host.render(snapshot);

    harness.host.clear();
    harness.host.render(snapshot);

    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(1);
    expect(harness.runtime.maxPaneCallDepth).toBe(1);
  });

  it("reattaches the same pane element when native rendering detaches it", () => {
    const harness = createHarness();
    const paneElement = harness.pane.element;
    harness.runtime.onPaneRender = () => paneElement.remove();

    harness.host.render(styles("rule:one", 1));

    expect(harness.pane.element).toBe(paneElement);
    expect(paneElement.parentElement).toBe(
      harness.mount as unknown as HTMLElement,
    );
  });

  it("restores pseudo controls immediately before the stable native pane", () => {
    const pseudo = new FakePseudoStateDataSource();
    const harness = createHarness({ pseudo });
    const controls = required(
      harness.mount.querySelector('[data-part="pseudo-state-controls"]'),
    );
    harness.mount.append(controls);

    harness.host.render(styles("rule:one", 1));

    expect(harness.mount.children).toEqual([
      harness.sentinel,
      controls,
      harness.pane.element as unknown as FakeElement,
    ]);

    harness.pane.element.remove();
    harness.host.render(styles("rule:two", 2));
    expect(harness.mount.children).toEqual([
      harness.sentinel,
      controls,
      harness.pane.element as unknown as FakeElement,
    ]);
  });

  it("aggregates teardown failures, removes owned nodes, and never retries disposal", () => {
    const pseudoError = new Error("pseudo unsubscribe failed");
    const paneError = new Error("native dispose failed");
    const pseudo = new FakePseudoStateDataSource();
    pseudo.unsubscribeError = pseudoError;
    const harness = createHarness({ pseudo });
    harness.runtime.paneDisposeError = paneError;
    let failure: unknown;

    try {
      harness.host.dispose();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([pseudoError, paneError]);
    expect(harness.mount.children).toEqual([harness.sentinel]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(pseudo.unsubscribeCount).toBe(1);
    expect(() => harness.host.dispose()).not.toThrow();
    expect(harness.pane.disposeCount).toBe(1);
    expect(pseudo.unsubscribeCount).toBe(1);
  });

  it("revokes source and diagnostic callbacks before native disposal", () => {
    const source = new FakeSourceLinkDelegate({
      label: "theme.scss",
      languageId: "scss",
      startLine: 3,
      startColumn: 1,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });
    harness.host.render(styles("rule:one", 1));
    harness.host.dispose();

    expect(harness.pane.resolveOrigin("rule:one")).toBeUndefined();
    expect(() => harness.pane.openOrigin("rule:one")).not.toThrow();
    harness.pane.report(new Error("late runtime error"));
    expect(source.originRequests).toEqual([]);
    expect(source.opened).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("does not create executable markup and suppresses throwing error observers", () => {
    const runtime = new FakeChromiumReadOnlyStylesRuntime();
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const host = createPinOpStylesRulesRenderer(runtime, {
      onError: () => {
        throw new Error("observer is not authority");
      },
    })(
      document.document,
      mount as unknown as HTMLElement,
      new FakeRulesDataSource(),
    );
    runtime.createdPane?.report(new Error("runtime diagnostic"));

    expect(document.createdTags()).not.toContain("script");
    expect(document.createdTags()).not.toContain("style");
    expect(document.innerHTMLAssignments()).toBe(0);
    expect(document.outerHTMLAssignments()).toBe(0);
    expect(() => host.dispose()).not.toThrow();
  });
});

function createHarness(options: {
  readonly source?: SourceLinkDelegate;
  readonly pseudo?: PseudoStateDataSource;
} = {}) {
  const runtime = new FakeChromiumReadOnlyStylesRuntime();
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  const sentinel = document.createElement("p") as unknown as FakeElement;
  const dataSource = new FakeRulesDataSource();
  const errors: unknown[] = [];
  mount.append(sentinel);
  document.body.append(mount);
  const host = createPinOpStylesRulesRenderer(runtime, {
    onError: error => errors.push(error),
  })(
    document.document,
    mount as unknown as HTMLElement,
    dataSource,
    options.source,
    options.pseudo,
  );
  return {
    runtime,
    document,
    mount,
    sentinel,
    dataSource,
    host,
    pane: required(runtime.createdPane),
    errors,
  };
}

class FakeRulesDataSource implements RulesDataSource {
  private readonly listeners = new Set<() => void>();

  public snapshot(): RulesPresentationSnapshot {
    return Object.freeze({ state: "empty" });
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

class FakePseudoStateDataSource implements PseudoStateDataSource {
  private readonly listeners = new Set<() => void>();
  public subscribeError: unknown;
  public unsubscribeError: unknown;
  public unsubscribeCount = 0;

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
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
      if (this.unsubscribeError !== undefined) throw this.unsubscribeError;
    };
  }

  public async setStates(_states: readonly ("hover" | "focus")[]): Promise<void> {}

  public listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeSourceLinkDelegate implements SourceLinkDelegate {
  public readonly originRequests: string[] = [];
  public readonly opened: string[] = [];
  public openError: unknown;
  public onOriginFor: (() => void) | undefined;

  public constructor(private readonly origin: RuleOriginDecoration) {}

  public originFor(ruleRef: string): RuleOriginDecoration | undefined {
    this.originRequests.push(ruleRef);
    const onOriginFor = this.onOriginFor;
    this.onOriginFor = undefined;
    onOriginFor?.();
    return this.origin;
  }

  public openRuleOrigin(ruleRef: string): void {
    if (this.openError !== undefined) throw this.openError;
    this.opened.push(ruleRef);
  }
}

function styles(ruleRef: string, stylesRevision: number): MatchedStylesSnapshot {
  return Object.freeze({
    documentEpoch: 1,
    selectionRevision: 1,
    stylesRevision,
    stylesheetRevision: 1,
    pseudoStateRevision: 0,
    pseudoStates: Object.freeze([]),
    nodeRef: "node:one",
    matchedRules: Object.freeze([Object.freeze({
      ruleRef,
      selectorText: ".target",
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

function reentrantStyles(
  base: MatchedStylesSnapshot,
  readMatchedRules: () => MatchedStylesSnapshot["matchedRules"],
): MatchedStylesSnapshot {
  const snapshot = {...base};
  Object.defineProperty(snapshot, "matchedRules", {get: readMatchedRules});
  return snapshot;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value");
  return value;
}
