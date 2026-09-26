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

  it("passes inherited ancestor identity and its display label through unchanged", () => {
    const harness = createHarness();
    const inherited = Object.freeze({
      ancestorIndex: 2,
      displayLabel: "main#app.shell",
      matchedRules: Object.freeze([]),
    });
    const snapshot = Object.freeze({
      ...styles("rule:inherited-contract", 1),
      inherited: Object.freeze([inherited]),
    });

    harness.host.render(snapshot);

    expect(harness.pane.rendered[0]!.inherited[0]).toBe(inherited);
    expect(harness.pane.rendered[0]!.inherited[0]).not.toHaveProperty("nodeRef");
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

  it("forwards only a sanitized clicked declaration with a current open", () => {
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

    harness.pane.openOrigin("rule:one", { property: "margin-top", occurrence: 1 });
    harness.pane.openOrigin("rule:one", { property: "color: red", occurrence: 0 });
    harness.pane.openOrigin("rule:one", { property: "color", occurrence: -1 });
    harness.pane.openOrigin("rule:stale", { property: "color", occurrence: 0 });

    expect(source.opened).toEqual(["rule:one"]);
    expect(source.openedDeclarations).toEqual([
      { property: "margin-top", occurrence: 1 },
    ]);
    expect(Object.isFrozen(source.openedDeclarations[0])).toBe(true);
  });

  it("forwards bounded media conditions to the delegate preview", () => {
    const source = new FakeSourceLinkDelegate({
      label: "theme.scss",
      languageId: "scss",
      startLine: 73,
      startColumn: 5,
      confidence: "sourcemap",
      clickable: true,
    });
    const harness = createHarness({ source });

    harness.pane.previewMediaQuery("(max-width: 600px)");
    harness.pane.previewMediaQuery("   ");
    harness.pane.previewMediaQuery("x".repeat(4096));
    harness.pane.previewMediaQuery(42);

    expect(source.mediaPreviews).toEqual(["(max-width: 600px)"]);
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

  it("mounts the pseudo-state preview in the native toolbar when one exists", () => {
    const pseudo = new FakePseudoStateDataSource();
    const harness = createHarness({ pseudo, nativeToolbar: true });
    const toolbar = required(
      harness.pane.element.querySelector('[data-part="native-styles-toolbar"]'),
    );
    const toolbarPane = required(
      harness.pane.element.querySelector('[data-part="native-styles-toolbar-pane"]'),
    );
    const button = required(
      harness.pane.element.querySelector('[data-part="pseudo-state-toolbar-item"]'),
    );
    const previews = required(
      harness.pane.element.querySelector('[data-part="pseudo-state-pane"]'),
    );

    expect(button.parentElement).toBe(toolbar);
    expect(previews.parentElement).toBe(toolbarPane);
    expect(harness.mount.querySelector('[data-part="pseudo-state-controls"]'))
      .toBe(null);
    expect(harness.mount.children.length).toBe(2);
    expect(harness.mount.children.at(-1)).toBe(
      harness.pane.element as unknown as FakeElement,
    );

    harness.pane.element.remove();
    harness.host.render(styles("rule:one", 1));

    expect(harness.mount.children.at(-1)).toBe(
      harness.pane.element as unknown as FakeElement,
    );
    expect(harness.mount.children.length).toBe(2);

    harness.host.dispose();

    expect(toolbar.children.length).toBe(0);
    expect(toolbarPane.children.length).toBe(0);
    expect(pseudo.listenerCount()).toBe(0);
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

  it("serializes async rendering, coalesces pending requests, and commits only the current completion", async () => {
    const harness = createHarness();
    const pending = deferred();
    const first = styles("rule:first", 1);
    const skipped = styles("rule:skipped", 2);
    const latest = styles("rule:latest", 3);
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(first);
    harness.host.render(skipped);
    harness.host.render(latest);

    expect(harness.pane.rendered).toEqual([first]);
    expect(harness.pane.refreshCount).toBe(0);

    pending.resolve();
    await flushPromises();

    expect(harness.pane.rendered).toEqual([first, latest]);
    expect(harness.pane.refreshCount).toBe(0);
    harness.host.render(latest);
    expect(harness.pane.refreshCount).toBe(1);
  });

  it("fully rerenders the same snapshot requested during an older async render", async () => {
    const harness = createHarness();
    const pending = deferred();
    const snapshot = styles("rule:one", 1);
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(snapshot);
    harness.host.render(snapshot);

    expect(harness.pane.rendered).toEqual([snapshot]);
    expect(harness.pane.refreshCount).toBe(0);

    pending.resolve();
    await flushPromises();

    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
    harness.host.render(snapshot);
    expect(harness.pane.refreshCount).toBe(1);
  });

  it("contains async render rejection and retries the exact snapshot with a full render", async () => {
    const renderError = new Error("async native render failed");
    const harness = createHarness({
      onError: () => {
        throw new Error("observer is not authority");
      },
    });
    const pending = deferred();
    const snapshot = styles("rule:one", 1);
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(snapshot);
    pending.reject(renderError);
    await flushPromises();

    expect(harness.pane.clearCount).toBe(1);
    expect(harness.errors).toEqual([renderError]);

    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("treats an undefined async rejection reason as failure", async () => {
    const harness = createHarness();
    const pending = deferred();
    const snapshot = styles("rule:one", 1);
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(snapshot);
    pending.reject(undefined);
    await flushPromises();

    expect(harness.pane.clearCount).toBe(1);
    expect(harness.errors).toEqual([undefined]);
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("contains a native Promise whose own constructor is hostile", async () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    const constructorError = new Error("hostile promise constructor");
    const completion = Promise.resolve();
    let constructorReads = 0;
    Object.defineProperty(completion, "constructor", {
      configurable: true,
      get: () => {
        constructorReads += 1;
        throw constructorError;
      },
    });
    harness.runtime.paneRenderCompletion = completion;

    expect(() => harness.host.render(snapshot)).not.toThrow();
    await flushPromises();

    expect(constructorReads).toBe(1);
    expect(harness.errors).toEqual([constructorError]);
    expect(harness.pane.clearCount).toBe(1);
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("contains a native Promise with a hostile own then accessor", async () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    const thenError = new Error("hostile promise then");
    const completion = Promise.resolve();
    let thenReads = 0;
    Object.defineProperty(completion, "then", {
      configurable: true,
      get: () => {
        thenReads += 1;
        throw thenError;
      },
    });
    harness.runtime.paneRenderCompletion = completion;

    expect(() => harness.host.render(snapshot)).not.toThrow();
    await flushPromises();

    expect(thenReads).toBe(1);
    expect(harness.errors).toEqual([thenError]);
    expect(harness.pane.clearCount).toBe(1);
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("contains rejection from a non-Promise thenable and permits full retry", async () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    const renderError = new Error("structural thenable rejected");
    harness.runtime.paneRenderCompletion = {
      then: (_resolve, reject) => reject(renderError),
    };

    expect(() => harness.host.render(snapshot)).not.toThrow();
    await flushPromises();

    expect(harness.errors).toEqual([renderError]);
    expect(harness.pane.clearCount).toBe(1);
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("ignores self-thenable fulfillment instead of recursively assimilating it", async () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    const recursiveError = new Error("self thenable was assimilated");
    let thenCalls = 0;
    const completion = {
      then: (
        resolve: (value?: unknown) => void,
        reject: (error: unknown) => void,
      ): void => {
        thenCalls += 1;
        if (thenCalls === 1) resolve(completion);
        else reject(recursiveError);
      },
    };
    harness.runtime.paneRenderCompletion = completion as unknown as
      PromiseLike<void>;

    expect(() => harness.host.render(snapshot)).not.toThrow();
    await flushPromises();

    expect(thenCalls).toBe(1);
    expect(harness.errors).toEqual([]);
    expect(harness.pane.clearCount).toBe(0);
    harness.host.render(snapshot);
    expect(harness.pane.refreshCount).toBe(1);
  });

  it("ignores a foreign thenable passed as the void fulfillment value", async () => {
    const harness = createHarness();
    const snapshot = styles("rule:one", 1);
    let foreignThenCalls = 0;
    const foreignCompletion = {
      then: (): void => {
        foreignThenCalls += 1;
        throw new Error("foreign thenable gained authority");
      },
    };
    harness.runtime.paneRenderCompletion = {
      then: resolve => resolve(foreignCompletion as unknown as void),
    };

    expect(() => harness.host.render(snapshot)).not.toThrow();
    await flushPromises();

    expect(foreignThenCalls).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.pane.clearCount).toBe(0);
    harness.host.render(snapshot);
    expect(harness.pane.refreshCount).toBe(1);
  });

  it("ignores late foreign fulfillment after disposal without unhandled work", async () => {
    const harness = createHarness();
    let fulfillLater: ((value?: unknown) => void) | undefined;
    let foreignThenCalls = 0;
    const foreignCompletion = {
      then: (): void => {
        foreignThenCalls += 1;
        throw new Error("late foreign thenable gained authority");
      },
    };
    harness.runtime.paneRenderCompletion = {
      then: resolve => {
        fulfillLater = resolve as (value?: unknown) => void;
      },
    };

    harness.host.render(styles("rule:one", 1));
    harness.host.dispose();
    fulfillLater?.(foreignCompletion);
    await flushPromises();

    expect(foreignThenCalls).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(harness.mount.children).toEqual([harness.sentinel]);
  });

  it("fences late rejection from a non-Promise thenable after disposal", async () => {
    const harness = createHarness();
    let rejectLater: ((error: unknown) => void) | undefined;
    harness.runtime.paneRenderCompletion = {
      then: (_resolve, reject) => {
        rejectLater = reject;
      },
    };

    expect(() => harness.host.render(styles("rule:one", 1))).not.toThrow();
    harness.host.dispose();
    await Promise.resolve();
    expect(rejectLater).toBeTypeOf("function");

    rejectLater?.(new Error("late structural rejection"));
    await flushPromises();

    expect(harness.errors).toEqual([]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(harness.mount.children).toEqual([harness.sentinel]);
  });

  it("keeps newer source authority and presentation after a stale async failure", async () => {
    const source = new FakeSourceLinkDelegate({
      label: "latest.scss", languageId: "scss", startLine: 8, startColumn: 2,
      confidence: "sourcemap", clickable: true,
    });
    const harness = createHarness({ source });
    const pending = deferred();
    const stale = styles("rule:stale", 1);
    const latest = styles("rule:latest", 2);
    const staleError = new Error("stale async failure");
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(stale);
    harness.host.render(latest);

    expect(harness.pane.resolveOrigin("rule:stale")).toBeUndefined();
    expect(harness.pane.resolveOrigin("rule:latest")?.label).toBe("latest.scss");
    pending.reject(staleError);
    await flushPromises();

    expect(harness.pane.rendered).toEqual([stale, latest]);
    expect(harness.pane.clearCount).toBe(0);
    expect(harness.errors).toEqual([staleError]);
    expect(harness.pane.resolveOrigin("rule:latest")?.label).toBe("latest.scss");
    harness.host.render(latest);
    expect(harness.pane.refreshCount).toBe(1);
  });

  it("lets clear supersede an async completion without reviving the old snapshot", async () => {
    const harness = createHarness();
    const pending = deferred();
    const snapshot = styles("rule:one", 1);
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(snapshot);
    harness.host.clear();
    pending.resolve();
    await flushPromises();

    expect(harness.pane.clearCount).toBe(1);
    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(0);
  });

  it("disposes immediately during async rendering and fences late rejection", async () => {
    const pseudo = new FakePseudoStateDataSource();
    const harness = createHarness({ pseudo });
    const pending = deferred();
    harness.runtime.paneRenderCompletion = pending.promise;

    harness.host.render(styles("rule:one", 1));
    expect(pseudo.listenerCount()).toBe(1);
    harness.host.dispose();

    expect(harness.pane.disposeCount).toBe(1);
    expect(pseudo.listenerCount()).toBe(0);
    expect(harness.mount.children).toEqual([harness.sentinel]);

    pending.reject(new Error("late render rejection"));
    await flushPromises();

    expect(harness.errors).toEqual([]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(() => harness.host.dispose()).not.toThrow();
  });

  it("finishes disposal requested reentrantly by an async failure observer", async () => {
    let disposeHost = (): void => {};
    const harness = createHarness({ onError: () => disposeHost() });
    const pending = deferred();
    const renderError = new Error("async render failed before disposal");
    harness.runtime.paneRenderCompletion = pending.promise;
    disposeHost = () => harness.host.dispose();

    harness.host.render(styles("rule:one", 1));
    pending.reject(renderError);
    await flushPromises();

    expect(harness.errors).toEqual([renderError]);
    expect(harness.pane.disposeCount).toBe(1);
    expect(harness.mount.children).toEqual([harness.sentinel]);
    expect(() => harness.host.dispose()).not.toThrow();
  });

  it("recovers from an async origin refresh failure with a later full render", async () => {
    const harness = createHarness();
    const pending = deferred();
    const snapshot = styles("rule:one", 1);
    const refreshError = new Error("async refresh failed");
    harness.host.render(snapshot);
    harness.runtime.paneRefreshCompletion = pending.promise;

    harness.host.render(snapshot);
    pending.reject(refreshError);
    await flushPromises();

    expect(harness.errors).toEqual([refreshError]);
    expect(harness.pane.clearCount).toBe(1);

    harness.host.render(snapshot);
    expect(harness.pane.rendered).toEqual([snapshot, snapshot]);
    expect(harness.pane.refreshCount).toBe(1);
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
  readonly nativeToolbar?: boolean;
  readonly onError?: (error: unknown) => void;
} = {}) {
  const runtime = new FakeChromiumReadOnlyStylesRuntime();
  runtime.exposeNativeToolbar = options.nativeToolbar === true;
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  const sentinel = document.createElement("p") as unknown as FakeElement;
  const dataSource = new FakeRulesDataSource();
  const errors: unknown[] = [];
  mount.append(sentinel);
  document.body.append(mount);
  const host = createPinOpStylesRulesRenderer(runtime, {
    onError: error => {
      errors.push(error);
      options.onError?.(error);
    },
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
  public readonly openedDeclarations: unknown[] = [];
  public readonly mediaPreviews: string[] = [];
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

  public openRuleOrigin(ruleRef: string, ...declaration: unknown[]): void {
    if (this.openError !== undefined) throw this.openError;
    this.opened.push(ruleRef);
    this.openedDeclarations.push(...declaration);
  }

  public previewMediaQuery(conditionText: string): void {
    this.mediaPreviews.push(conditionText);
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
