import {
  ChevronLeft,
  ChevronRight,
  type IconNode,
} from "lucide";
import type {
  PanelActions,
  PanelView,
  PanelViewModel,
} from "./panelController.js";
import type { ResolutionViewModel } from "./resolutionPresenter.js";
import type {
  PanelLayoutController,
  PanelLayoutSnapshot,
} from "./panelLayoutController.js";
import type {
  PanelSettingsController,
  PanelSettingsViewModel,
} from "./panelSettingsController.js";
import type {
  SourceNavigationController,
  SourceNavigationViewModel,
} from "./sourceNavigationController.js";
import { createLucideElement } from "./lucideElement.js";

export interface PanelDocument {
  getElementById(id: string): unknown;
  createElement(tagName: string): unknown;
  createTextNode(text: string): unknown;
  createElementNS(namespace: string, qualifiedName: string): Element;
}

export class DomPanelView implements PanelView {
  private readonly linkControls: PanelElement;
  private readonly linkForm: PanelElement;
  private readonly linkCode: PanelElement;
  private readonly pasteButton: PanelElement;
  private readonly linkButton: PanelElement;
  private readonly linkedCode: PanelElement;
  private readonly disconnectButton: PanelElement;
  private readonly inspectToggle: PanelElement;
  private readonly autoRefreshToggle: PanelElement;
  private readonly ideHighlightToggle: PanelElement;
  private readonly connectionStatus: PanelElement;
  private readonly protocolMismatch: PanelElement;
  private readonly protocolMismatchVersions: PanelElement;
  private readonly workspace: PanelElement;
  private readonly workspaceTabs: PanelElement;
  private readonly domTab: PanelElement;
  private readonly sourceTab: PanelElement;
  private readonly domPane: PanelElement;
  private readonly separator: PanelElement;
  private readonly sourcePane: PanelElement;
  private readonly sourcePaneRoot: PanelElement;
  private readonly selectedElementSummary: PanelElement;
  private readonly resolutionStatus: PanelElement;
  private readonly sourceNavigationFooter: PanelElement;
  private readonly sourceNavigationCounter: PanelElement;
  private readonly sourcePrevious: PanelElement;
  private readonly sourceNext: PanelElement;
  private readonly panelError: PanelElement;

  public constructor(
    document: PanelDocument,
    private readonly onError: (error: unknown) => void,
  ) {
    this.linkControls = required(document, "link-controls");
    this.linkForm = required(document, "link-form");
    this.linkCode = required(document, "link-code");
    this.pasteButton = required(document, "paste-button");
    this.linkButton = required(document, "link-button");
    this.linkedCode = required(document, "linked-code");
    this.disconnectButton = required(document, "disconnect-button");
    this.inspectToggle = required(document, "inspect-mode");
    this.autoRefreshToggle = required(document, "auto-refresh-enabled");
    this.ideHighlightToggle = required(document, "ide-highlight-enabled");
    this.connectionStatus = required(document, "connection-status");
    this.protocolMismatch = required(document, "protocol-mismatch");
    this.protocolMismatchVersions = required(
      document,
      "protocol-mismatch-versions",
    );
    this.workspace = required(document, "panel-workspace");
    this.workspaceTabs = required(document, "workspace-tabs");
    this.domTab = required(document, "dom-tab");
    this.sourceTab = required(document, "source-tab");
    this.domPane = required(document, "dom-pane");
    this.separator = required(document, "pane-separator");
    this.sourcePane = required(document, "source-pane");
    this.sourcePaneRoot = required(document, "source-pane-root");
    this.selectedElementSummary = required(
      document,
      "selected-element-summary",
    );
    this.resolutionStatus = required(document, "resolution-status");
    this.sourceNavigationFooter = required(
      document,
      "source-navigation-footer",
    );
    this.sourceNavigationCounter = required(
      document,
      "source-navigation-counter",
    );
    this.sourcePrevious = required(document, "source-previous");
    this.sourceNext = required(document, "source-next");
    this.panelError = required(document, "panel-error");

    this.sourcePrevious.replaceChildren(
      createNavigationIcon(document, ChevronLeft),
    );
    this.sourceNext.replaceChildren(
      createNavigationIcon(document, ChevronRight),
    );
  }

  public bind(actions: PanelActions): () => void {
    const submit = (event: Event): void => {
      event.preventDefault();
      this.run(actions.onLink);
    };
    const paste = (): void => this.run(actions.onPaste);
    const disconnect = (): void => this.run(actions.onDisconnect);
    const inspect = (): void =>
      this.run(() =>
        actions.onInspectChanged(
          this.inspectToggle.getAttribute("aria-pressed") !== "true",
        ),
      );
    const input = (): void => actions.onLinkCodeChanged(this.linkCode.value);

    this.linkForm.addEventListener("submit", submit);
    this.pasteButton.addEventListener("click", paste);
    this.disconnectButton.addEventListener("click", disconnect);
    this.inspectToggle.addEventListener("click", inspect);
    this.linkCode.addEventListener("input", input);

    return () => {
      this.linkForm.removeEventListener("submit", submit);
      this.pasteButton.removeEventListener("click", paste);
      this.disconnectButton.removeEventListener("click", disconnect);
      this.inspectToggle.removeEventListener("click", inspect);
      this.linkCode.removeEventListener("input", input);
    };
  }

  public readLinkCode(): string {
    return this.linkCode.value;
  }

  public writeLinkCode(value: string): void {
    this.linkCode.value = value;
  }

  public render(model: PanelViewModel): void {
    this.connectionStatus.value = model.statusLabel;
    this.connectionStatus.dataset.state = model.state;
    this.linkControls.hidden = !model.showLinkControls;
    this.linkedCode.value = model.displayLinkCode ?? "";
    this.linkedCode.hidden =
      !model.showDisconnect || model.displayLinkCode === undefined;
    this.disconnectButton.hidden = !model.showDisconnect;
    this.linkCode.disabled = model.linkInputDisabled;
    this.pasteButton.disabled = model.pasteButtonDisabled;
    this.linkButton.disabled = model.linkButtonDisabled;
    this.disconnectButton.disabled = model.disconnectButtonDisabled;
    this.inspectToggle.disabled = model.inspectDisabled;
    this.inspectToggle.setAttribute(
      "aria-pressed",
      String(model.inspectChecked),
    );
    this.inspectToggle.dataset.state = model.inspectChecked ? "active" : "idle";
    this.panelError.value = model.errorText ?? "";
    this.panelError.hidden = model.errorText === undefined;
  }

  public renderResolution(model: ResolutionViewModel): void {
    this.selectedElementSummary.value = model.selectedElement
      ? `Selected: ${model.selectedElement}`
      : "";
    this.selectedElementSummary.hidden = model.selectedElement === undefined;
    this.resolutionStatus.value = model.detailText
      ? `${model.statusText} · ${model.detailText}`
      : model.statusText;
    this.resolutionStatus.dataset.kind = model.kind;
    this.resolutionStatus.dataset.tone = model.tone;
  }

  public bindSourceNavigation(
    controller: SourceNavigationController,
  ): () => void {
    const previous = (event: Event): void => {
      event.preventDefault();
      this.run(() => controller.navigate("previous"));
    };
    const next = (event: Event): void => {
      event.preventDefault();
      this.run(() => controller.navigate("next"));
    };
    const render = (): void => {
      this.renderSourceNavigation(controller.snapshot());
    };

    this.sourcePrevious.addEventListener("click", previous);
    this.sourceNext.addEventListener("click", next);
    const unsubscribe = controller.subscribe(render);
    render();

    return () => {
      unsubscribe();
      this.sourcePrevious.removeEventListener("click", previous);
      this.sourceNext.removeEventListener("click", next);
    };
  }

  public bindSettings(controller: PanelSettingsController): () => void {
    const autoRefresh = (): void => {
      controller.setAutoRefreshEnabled(this.autoRefreshToggle.checked);
    };
    const ideHighlight = (): void => {
      controller.setIdeHighlightEnabled(this.ideHighlightToggle.checked);
    };
    const render = (): void => this.renderSettings(controller.snapshot());

    this.autoRefreshToggle.addEventListener("change", autoRefresh);
    this.ideHighlightToggle.addEventListener("change", ideHighlight);
    const unsubscribe = controller.subscribe(render);
    render();

    return () => {
      unsubscribe();
      this.autoRefreshToggle.removeEventListener("change", autoRefresh);
      this.ideHighlightToggle.removeEventListener("change", ideHighlight);
    };
  }

  public bindLayout(controller: PanelLayoutController): () => void {
    let disposed = false;
    let pointerAuthority: {
      readonly pointerId: number;
      captured: boolean;
    } | undefined;
    const selectDom = (): void => this.run(() => {
      controller.setActiveTab("dom");
    });
    const selectSource = (): void => this.run(() => {
      controller.setActiveTab("source");
    });
    const tabKey = (event: Event): void => {
      const key = (event as KeyboardEvent).key;
      const target = event.target === (this.sourceTab as unknown as EventTarget)
        ? "source"
        : "dom";
      const next = key === "Home"
        ? "dom"
        : key === "End"
          ? "source"
          : key === "ArrowLeft"
            ? target === "dom" ? "source" : "dom"
            : key === "ArrowRight"
              ? target === "dom" ? "source" : "dom"
              : undefined;
      if (!next) return;
      event.preventDefault();
      this.run(() => {
        controller.setActiveTab(next);
        const focusTarget = next === "dom" ? this.domTab : this.sourceTab;
        focusTarget.focus?.();
      });
    };
    const separatorKey = (event: Event): void => {
      const keyboardEvent = event as KeyboardEvent;
      if (controller.handleSeparatorKey(keyboardEvent.key, keyboardEvent.shiftKey)) {
        event.preventDefault();
      }
    };
    const updateFromPointer = (event: Event): void => this.run(() => {
      const pointer = event as PointerEvent;
      const authority = pointerAuthority;
      if (
        disposed ||
        !authority ||
        pointer.pointerId !== authority.pointerId
      ) {
        return;
      }
      const bounds = this.workspace.getBoundingClientRect?.();
      if (disposed || pointerAuthority !== authority) return;
      const snapshot = controller.snapshot();
      if (!bounds || !snapshot.separator.enabled) return;
      const position = snapshot.mode === "split"
        ? pointer.clientX - bounds.left
        : pointer.clientY - bounds.top;
      controller.setDividerFromPosition(position);
    });
    const releasePointer = (authority: {
      readonly pointerId: number;
      captured: boolean;
    }): void => {
      if (pointerAuthority === authority) {
        pointerAuthority = undefined;
      }
      if (!authority.captured) return;
      authority.captured = false;
      this.separator.releasePointerCapture?.(authority.pointerId);
    };
    const pointerDown = (event: Event): void => this.run(() => {
      const pointer = event as PointerEvent;
      if (disposed || !controller.snapshot().separator.enabled) return;
      const previousAuthority = pointerAuthority;
      if (previousAuthority) {
        releasePointer(previousAuthority);
      }
      const authority = { pointerId: pointer.pointerId, captured: false };
      pointerAuthority = authority;
      try {
        if (this.separator.setPointerCapture) {
          this.separator.setPointerCapture(pointer.pointerId);
          authority.captured = true;
        }
      } catch (error) {
        if (pointerAuthority === authority) {
          pointerAuthority = undefined;
        }
        throw error;
      }
      if (disposed || pointerAuthority !== authority) {
        releasePointer(authority);
        return;
      }
      updateFromPointer(event);
      event.preventDefault();
    });
    const pointerUp = (event: Event): void => this.run(() => {
      const pointer = event as PointerEvent;
      const authority = pointerAuthority;
      if (!authority || authority.pointerId !== pointer.pointerId) return;
      releasePointer(authority);
    });
    const render = (snapshot = controller.snapshot()): void => {
      this.renderLayout(snapshot);
    };

    this.domTab.addEventListener("click", selectDom);
    this.sourceTab.addEventListener("click", selectSource);
    this.domTab.addEventListener("keydown", tabKey);
    this.sourceTab.addEventListener("keydown", tabKey);
    this.separator.addEventListener("keydown", separatorKey);
    this.separator.addEventListener("pointerdown", pointerDown);
    this.separator.addEventListener("pointermove", updateFromPointer);
    this.separator.addEventListener("pointerup", pointerUp);
    this.separator.addEventListener("pointercancel", pointerUp);
    const unsubscribe = controller.subscribe(render);
    controller.start(this.workspace);
    render();

    return () => {
      disposed = true;
      unsubscribe();
      this.domTab.removeEventListener("click", selectDom);
      this.sourceTab.removeEventListener("click", selectSource);
      this.domTab.removeEventListener("keydown", tabKey);
      this.sourceTab.removeEventListener("keydown", tabKey);
      this.separator.removeEventListener("keydown", separatorKey);
      this.separator.removeEventListener("pointerdown", pointerDown);
      this.separator.removeEventListener("pointermove", updateFromPointer);
      this.separator.removeEventListener("pointerup", pointerUp);
      this.separator.removeEventListener("pointercancel", pointerUp);
      const authority = pointerAuthority;
      if (authority) {
        this.run(() => releasePointer(authority));
      }
    };
  }

  public sourceRoot(): HTMLElement {
    return this.sourcePaneRoot as unknown as HTMLElement;
  }

  public renderSourceNavigation(model: SourceNavigationViewModel): void {
    this.sourceNavigationFooter.hidden = !model.visible;
    this.sourceNavigationCounter.value = model.counter;
    this.sourcePrevious.disabled = model.disabled;
    this.sourceNext.disabled = model.disabled;
  }

  private renderSettings(model: PanelSettingsViewModel): void {
    this.autoRefreshToggle.checked = model.autoRefreshEnabled;
    this.ideHighlightToggle.checked = model.ideHighlightEnabled;
    this.autoRefreshToggle.disabled = !model.controlsEnabled;
    this.ideHighlightToggle.disabled = !model.controlsEnabled;
    const incompatible = model.compatibility === "incompatible";
    this.protocolMismatch.hidden = !incompatible;
    this.protocolMismatchVersions.textContent = incompatible
      ? `Browser protocol: ${model.browserProtocolVersion ?? "unknown"} - IDE protocol: ${model.peerProtocolVersion ?? "unknown"}`
      : "";
  }

  private renderLayout(model: PanelLayoutSnapshot): void {
    this.workspace.dataset.layout = model.mode;
    setStyleProperty(
      this.workspace.style,
      "--divider-proportion",
      `${model.dividerProportion * 100}%`,
    );
    const tabs = model.mode === "tabs";
    this.workspaceTabs.hidden = !tabs;
    this.separator.hidden = !model.separator.enabled;
    this.domPane.hidden = tabs && model.activeTab !== "dom";
    this.sourcePane.hidden = tabs && model.activeTab !== "source";
    this.domTab.setAttribute("aria-selected", String(model.activeTab === "dom"));
    this.sourceTab.setAttribute("aria-selected", String(model.activeTab === "source"));
    this.domTab.setAttribute("tabindex", model.activeTab === "dom" ? "0" : "-1");
    this.sourceTab.setAttribute("tabindex", model.activeTab === "source" ? "0" : "-1");
    if (model.separator.orientation) {
      this.separator.setAttribute("aria-orientation", model.separator.orientation);
    } else {
      this.separator.removeAttribute("aria-orientation");
    }
    this.separator.setAttribute("aria-valuemin", String(model.separator.valueMin));
    this.separator.setAttribute("aria-valuemax", String(model.separator.valueMax));
    this.separator.setAttribute("aria-valuenow", String(model.separator.valueNow));
    this.separator.setAttribute("aria-valuetext", model.separator.valueText);
    this.separator.setAttribute("tabindex", model.separator.enabled ? "0" : "-1");
  }

  private run(action: () => void | Promise<void>): void {
    try {
      void Promise.resolve(action()).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }
}

interface PanelElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  className: string;
  readonly dataset: Record<string, string>;
  readonly style: PanelStyle;
  replaceChildren(...children: unknown[]): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus?(): void;
  getBoundingClientRect?(): { readonly left: number; readonly top: number };
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface PanelStyle {
  [key: string]: unknown;
  setProperty?: (name: string, value: string) => void;
}

function required(document: PanelDocument, id: string): PanelElement {
  const element = document.getElementById(id);
  if (!element || typeof element !== "object") {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as PanelElement;
}

function createNavigationIcon(
  ownerDocument: PanelDocument,
  icon: IconNode,
): unknown {
  const element = createLucideElement(ownerDocument, icon);
  element.setAttribute("aria-hidden", "true");
  return element;
}

function setStyleProperty(style: PanelStyle, name: string, value: string): void {
  if (typeof style.setProperty === "function") {
    style.setProperty(name, value);
  } else {
    style[name] = value;
  }
}
