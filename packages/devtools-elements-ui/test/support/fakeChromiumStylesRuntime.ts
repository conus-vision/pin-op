import type { MatchedStylesSnapshot, RuleOriginDecoration } from
  "../../src/contracts.js";
import type {
  ChromiumReadOnlyStylesPane,
  ChromiumReadOnlyStylesPaneOptions,
  ChromiumReadOnlyStylesRuntime,
} from "../../src/chromium/upstream/PinOpStylesSidebarAdapter.js";

export class FakeChromiumReadOnlyStylesRuntime implements
  ChromiumReadOnlyStylesRuntime {
  public createdPane: FakeChromiumReadOnlyStylesPane | undefined;
  public createCount = 0;
  public createError: unknown;
  public leakBeforeCreateError = false;
  public leavePaneDetached = false;
  public paneRenderError: unknown;
  public paneRefreshError: unknown;
  public paneRenderCompletion: PromiseLike<void> | undefined;
  public paneRefreshCompletion: PromiseLike<void> | undefined;
  public paneClearError: unknown;
  public paneDisposeError: unknown;
  public exposeNativeToolbar = false;
  public paneCallDepth = 0;
  public maxPaneCallDepth = 0;
  public readonly paneCalls: string[] = [];
  public onPaneRender: ((snapshot: MatchedStylesSnapshot) => void) | undefined;
  public onPaneClear: (() => void) | undefined;

  public createPane(
    options: ChromiumReadOnlyStylesPaneOptions,
  ): ChromiumReadOnlyStylesPane {
    this.createCount += 1;
    if (this.leakBeforeCreateError) {
      options.mount.append(options.document.createElement("aside"));
    }
    if (this.createError !== undefined) throw this.createError;
    const pane = new FakeChromiumReadOnlyStylesPane(this, options);
    this.createdPane = pane;
    if (!this.leavePaneDetached) options.mount.append(pane.element);
    return pane;
  }

  public enterPaneCall(call: string): void {
    this.paneCallDepth += 1;
    this.maxPaneCallDepth = Math.max(
      this.maxPaneCallDepth,
      this.paneCallDepth,
    );
    this.paneCalls.push(call);
  }

  public exitPaneCall(): void {
    this.paneCallDepth -= 1;
  }
}

export class FakeChromiumReadOnlyStylesPane implements
  ChromiumReadOnlyStylesPane {
  public readonly element: HTMLElement;
  public readonly rendered: MatchedStylesSnapshot[] = [];
  public refreshCount = 0;
  public clearCount = 0;
  public disposeCount = 0;
  private readonly toolbar: HTMLElement | undefined;
  private readonly toolbarPane: HTMLElement | undefined;

  public constructor(
    private readonly runtime: FakeChromiumReadOnlyStylesRuntime,
    private readonly options: ChromiumReadOnlyStylesPaneOptions,
  ) {
    this.element = options.document.createElement("div");
    this.element.setAttribute("data-part", "chromium-read-only-styles-pane");
    if (runtime.exposeNativeToolbar) {
      this.toolbar = options.document.createElement("div");
      this.toolbar.setAttribute("data-part", "native-styles-toolbar");
      this.toolbarPane = options.document.createElement("div");
      this.toolbarPane.setAttribute("data-part", "native-styles-toolbar-pane");
      this.element.append(this.toolbar, this.toolbarPane);
    }
  }

  public toolbarElement(): HTMLElement | null {
    return this.toolbar ?? null;
  }

  public toolbarPaneElement(): HTMLElement | null {
    return this.toolbarPane ?? null;
  }

  public render(snapshot: MatchedStylesSnapshot): void | Promise<void> {
    this.runtime.enterPaneCall(`render:${snapshot.matchedRules[0]?.ruleRef ?? "inline"}`);
    try {
      this.rendered.push(snapshot);
      const renderError = this.runtime.paneRenderError;
      const onRender = this.runtime.onPaneRender;
      this.runtime.onPaneRender = undefined;
      onRender?.(snapshot);
      if (renderError !== undefined) throw renderError;
      const completion = this.runtime.paneRenderCompletion;
      this.runtime.paneRenderCompletion = undefined;
      return completion as Promise<void> | undefined;
    } finally {
      this.runtime.exitPaneCall();
    }
  }

  public refreshOrigins(): void | Promise<void> {
    this.runtime.enterPaneCall("refresh");
    try {
      this.refreshCount += 1;
      if (this.runtime.paneRefreshError !== undefined) {
        throw this.runtime.paneRefreshError;
      }
      const completion = this.runtime.paneRefreshCompletion;
      this.runtime.paneRefreshCompletion = undefined;
      return completion as Promise<void> | undefined;
    } finally {
      this.runtime.exitPaneCall();
    }
  }

  public clear(): void {
    this.runtime.enterPaneCall("clear");
    try {
      this.clearCount += 1;
      const onClear = this.runtime.onPaneClear;
      this.runtime.onPaneClear = undefined;
      onClear?.();
      if (this.runtime.paneClearError !== undefined) {
        throw this.runtime.paneClearError;
      }
      this.element.replaceChildren();
    } finally {
      this.runtime.exitPaneCall();
    }
  }

  public dispose(): void {
    this.runtime.enterPaneCall("dispose");
    try {
      this.disposeCount += 1;
      if (this.runtime.paneDisposeError !== undefined) {
        throw this.runtime.paneDisposeError;
      }
      this.element.remove();
    } finally {
      this.runtime.exitPaneCall();
    }
  }

  public resolveOrigin(ruleRef: unknown): RuleOriginDecoration | undefined {
    return this.options.resolveOrigin(ruleRef as string);
  }

  public openOrigin(ruleRef: unknown, declaration?: unknown): void {
    if (declaration === undefined) {
      this.options.openOrigin(ruleRef as string);
    } else {
      this.options.openOrigin(
        ruleRef as string,
        declaration as { property: string; occurrence: number },
      );
    }
  }

  public previewMediaQuery(conditionText: unknown): void {
    this.options.previewMediaQuery?.(conditionText as string);
  }

  public report(error: unknown): void {
    this.options.onError(error);
  }
}
