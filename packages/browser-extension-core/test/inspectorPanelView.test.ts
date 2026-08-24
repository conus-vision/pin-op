import type { TreeDataSource, TreePresentationSnapshot } from "@pin-op/devtools-elements-ui";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { InspectorPanelView } from "../src/inspectorPanelView.js";
import type { PanelActions, PanelViewModel } from "../src/panelController.js";
import { FakeDocument, type FakeElement } from "../../devtools-elements-ui/test/support/fakeDocument.js";

const inspectorHtml = readFileSync(
  new URL("../assets/inspector-panel.html", import.meta.url),
  "utf8",
);

describe("InspectorPanelView", () => {
  it("implements the existing toolbar/status view contract without a Source surface", () => {
    const harness = createHarness();
    const actions: PanelActions = {
      onPaste: vi.fn(),
      onLink: vi.fn(),
      onDisconnect: vi.fn(),
      onInspectChanged: vi.fn(),
      onLinkCodeChanged: vi.fn(),
    };
    const unbind = harness.view.bind(actions);
    harness.element("link-code").value = "48735 07";
    harness.element("link-code").dispatch("input");
    harness.element("link-form").dispatch("submit");
    harness.element("paste-button").dispatch("click");
    harness.element("disconnect-button").dispatch("click");
    harness.element("inspect-mode").dispatch("click");

    expect(actions.onLinkCodeChanged).toHaveBeenCalledOnce();
    expect(actions.onLinkCodeChanged).toHaveBeenCalledWith("48735 07");
    expect(actions.onLink).toHaveBeenCalledOnce();
    expect(actions.onPaste).toHaveBeenCalledOnce();
    expect(actions.onDisconnect).toHaveBeenCalledOnce();
    expect(actions.onInspectChanged).toHaveBeenCalledOnce();
    expect(actions.onInspectChanged).toHaveBeenCalledWith(true);

    harness.view.render(linkedModel());
    expect(harness.element("connection-status").value).toBe("Connected");
    expect(harness.element("inspector-workspace").hidden).toBe(false);
    expect(harness.element("link-onboarding").hidden).toBe(true);
    expect(harness.element("operational-footer").hidden).toBe(false);
    expect(harness.element("inspect-mode").getAttribute("aria-pressed")).toBe("true");

    unbind();
    harness.element("disconnect-button").dispatch("click");
    expect(actions.onDisconnect).toHaveBeenCalledOnce();
    expect(inspectorHtml).not.toMatch(/id="source-|>\s*Source\s*</i);
    expect(inspectorHtml).not.toContain("source-pane");
  });

  it("mounts the neutral Elements view and exposes only DOM, Rules, and a hidden extension point", () => {
    const harness = createHarness();
    const backend = new StaticTreeDataSource({ rows: [] });

    harness.view.mountTree(backend);

    expect(harness.view.domRoot.getAttribute("data-pane")).toBe("dom");
    expect(harness.view.rulesRoot.getAttribute("data-pane")).toBe("rules");
    expect(harness.view.sidebarExtensionMount.hidden).toBe(true);
    expect(harness.view.sidebarExtensionMount.getAttribute("aria-hidden")).toBe("true");
    expect(harness.element("inspector-elements-mount").textContent).toContain("DOMRules");
    expect(harness.element("inspector-elements-mount").textContent).not.toContain("Source");
    expect(() => harness.view.mountTree(backend)).toThrow(/already mounted/i);

    harness.view.dispose();
    harness.view.dispose();
    expect(harness.element("inspector-elements-mount").children).toHaveLength(0);
    expect(backend.listenerCount()).toBe(0);
  });

  it("keeps browser-local inspection visible beside usable IDE onboarding while unlinked", () => {
    const harness = createHarness();
    const backend = new StaticTreeDataSource({ rows: [] });
    harness.view.mountTree(backend);

    harness.view.render(unlinkedModel());

    expect(harness.element("connection-status").value).toBe("Not linked");
    expect(harness.element("link-controls").hidden).toBe(false);
    expect(harness.element("link-onboarding").hidden).toBe(false);
    expect(harness.element("link-code").disabled).toBe(false);
    expect(harness.element("link-button").disabled).toBe(false);
    expect(harness.element("toolbar-features").hidden).toBe(false);
    expect(harness.element("inspect-mode").disabled).toBe(false);
    expect(harness.element("inspector-workspace").hidden).toBe(false);
    expect(harness.element("operational-footer").hidden).toBe(false);
    expect(harness.view.domRoot.getAttribute("data-pane")).toBe("dom");
    expect(harness.view.rulesRoot.getAttribute("data-pane")).toBe("rules");
    expect(harness.view.sidebarExtensionMount.hidden).toBe(true);

    harness.view.dispose();
  });

  it("contains synchronous and asynchronous toolbar failures", async () => {
    const errors: unknown[] = [];
    const harness = createHarness((error) => errors.push(error));
    const syncError = new Error("sync toolbar failure");
    const asyncError = new Error("async toolbar failure");
    const actions: PanelActions = {
      onPaste: () => {
        throw syncError;
      },
      onLink: () => Promise.reject(asyncError),
      onDisconnect() {},
      onInspectChanged() {},
      onLinkCodeChanged() {},
    };
    harness.view.bind(actions);

    expect(() => harness.element("paste-button").dispatch("click")).not.toThrow();
    harness.element("link-form").dispatch("submit");
    await flushAsync();

    expect(errors).toEqual([syncError, asyncError]);
  });
});

const INSPECTOR_IDS = [
  "toolbar-features",
  "connection-status",
  "link-controls",
  "link-form",
  "link-code",
  "paste-button",
  "link-button",
  "linked-code",
  "disconnect-button",
  "inspect-mode",
  "auto-refresh-enabled",
  "ide-highlight-enabled",
  "protocol-mismatch",
  "protocol-mismatch-versions",
  "link-onboarding",
  "inspector-workspace",
  "inspector-elements-mount",
  "selected-element-summary",
  "resolution-status",
  "operational-footer",
  "panel-error",
] as const;

function createHarness(onError: (error: unknown) => void = () => {}): {
  readonly document: FakeDocument;
  readonly view: InspectorPanelView;
  element(id: (typeof INSPECTOR_IDS)[number]): MutableFakeElement;
} {
  const document = new FakeDocument();
  const elements = new Map<string, MutableFakeElement>();
  for (const id of INSPECTOR_IDS) {
    const element = (
      document.createElement(id === "link-form" ? "form" : "div")
    ) as unknown as MutableFakeElement;
    element.id = id;
    element.value = id === "connection-status" ? "Not linked" : "";
    element.checked = id === "auto-refresh-enabled" || id === "ide-highlight-enabled";
    document.body.append(element);
    elements.set(id, element);
  }
  const view = new InspectorPanelView(
    document.document,
    onError,
  );
  return {
    document,
    view,
    element(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing #${id}`);
      return element;
    },
  };
}

interface MutableFakeElement extends FakeElement {
  value: string;
  checked: boolean;
}

class StaticTreeDataSource implements TreeDataSource {
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly current: TreePresentationSnapshot) {}
  public snapshot(): TreePresentationSnapshot { return this.current; }
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public async expand(): Promise<void> {}
  public collapse(): void {}
  public async loadMore(): Promise<void> {}
  public async select(): Promise<void> {}
  public focus(): void {}
  public hover(): void {}
  public listenerCount(): number { return this.listeners.size; }
}

function linkedModel(): PanelViewModel {
  return {
    state: "connected",
    statusLabel: "Connected",
    displayLinkCode: "48735 07",
    showLinkControls: false,
    showDisconnect: true,
    linkInputDisabled: true,
    linkButtonDisabled: true,
    pasteButtonDisabled: true,
    disconnectButtonDisabled: false,
    inspectDisabled: false,
    inspectChecked: true,
  };
}

function unlinkedModel(): PanelViewModel {
  return {
    state: "notLinked",
    statusLabel: "Not linked",
    showLinkControls: true,
    showDisconnect: false,
    linkInputDisabled: false,
    linkButtonDisabled: false,
    pasteButtonDisabled: false,
    disconnectButtonDisabled: false,
    inspectDisabled: false,
    inspectChecked: false,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
