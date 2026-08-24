import {
  ElementsInspectorView,
  type TreeDataSource,
} from "@pin-op/devtools-elements-ui";
import type {
  PanelActions,
  PanelView,
  PanelViewModel,
} from "./panelController.js";
import type { PanelDocument } from "./panelView.js";
import type { ResolutionViewModel } from "./resolutionPresenter.js";
import type {
  PanelSettingsController,
  PanelSettingsViewModel,
} from "./panelSettingsController.js";

export type InspectorPanelDocument = PanelDocument & Document;

export class InspectorPanelView implements PanelView {
  private readonly toolbarFeatures: InspectorPanelElement;
  private readonly linkControls: InspectorPanelElement;
  private readonly linkForm: InspectorPanelElement;
  private readonly linkCode: InspectorPanelElement;
  private readonly pasteButton: InspectorPanelElement;
  private readonly linkButton: InspectorPanelElement;
  private readonly linkedCode: InspectorPanelElement;
  private readonly disconnectButton: InspectorPanelElement;
  private readonly inspectToggle: InspectorPanelElement;
  private readonly autoRefreshToggle: InspectorPanelElement;
  private readonly ideHighlightToggle: InspectorPanelElement;
  private readonly connectionStatus: InspectorPanelElement;
  private readonly protocolMismatch: InspectorPanelElement;
  private readonly protocolMismatchVersions: InspectorPanelElement;
  private readonly linkOnboarding: InspectorPanelElement;
  private readonly workspace: InspectorPanelElement;
  private readonly mount: HTMLElement;
  private readonly selectedElementSummary: InspectorPanelElement;
  private readonly resolutionStatus: InspectorPanelElement;
  private readonly operationalFooter: InspectorPanelElement;
  private readonly panelError: InspectorPanelElement;
  private elementsView: ElementsInspectorView | undefined;
  private disposed = false;

  public constructor(
    private readonly document: InspectorPanelDocument,
    private readonly onError: (error: unknown) => void,
  ) {
    this.toolbarFeatures = required(document, "toolbar-features");
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
    this.linkOnboarding = required(document, "link-onboarding");
    this.workspace = required(document, "inspector-workspace");
    this.mount = required(
      document,
      "inspector-elements-mount",
    ) as unknown as HTMLElement;
    this.selectedElementSummary = required(
      document,
      "selected-element-summary",
    );
    this.resolutionStatus = required(document, "resolution-status");
    this.operationalFooter = required(document, "operational-footer");
    this.panelError = required(document, "panel-error");
  }

  public get domRoot(): HTMLElement {
    return this.requiredElementsView().domRoot;
  }

  public get rulesRoot(): HTMLElement {
    return this.requiredElementsView().rulesRoot;
  }

  public get sidebarExtensionMount(): HTMLElement {
    return this.requiredElementsView().sidebarExtensionMount;
  }

  public mountTree(source: TreeDataSource): ElementsInspectorView {
    if (this.disposed) {
      throw new Error("Inspector panel view is disposed");
    }
    if (this.elementsView) {
      throw new Error("Elements Inspector is already mounted");
    }
    const view = new ElementsInspectorView(this.document, this.mount, source);
    this.elementsView = view;
    return view;
  }

  public bind(actions: PanelActions): () => void {
    let disposed = false;
    const submit = (event: Event): void => {
      event.preventDefault();
      if (!disposed) this.run(actions.onLink);
    };
    const paste = (): void => {
      if (!disposed) this.run(actions.onPaste);
    };
    const disconnect = (): void => {
      if (!disposed) this.run(actions.onDisconnect);
    };
    const inspect = (): void => {
      if (disposed) return;
      this.run(() => actions.onInspectChanged(
        this.inspectToggle.getAttribute("aria-pressed") !== "true",
      ));
    };
    const input = (): void => {
      if (!disposed) actions.onLinkCodeChanged(this.linkCode.value);
    };

    this.linkForm.addEventListener("submit", submit);
    this.pasteButton.addEventListener("click", paste);
    this.disconnectButton.addEventListener("click", disconnect);
    this.inspectToggle.addEventListener("click", inspect);
    this.linkCode.addEventListener("input", input);
    return () => {
      if (disposed) return;
      disposed = true;
      this.linkForm.removeEventListener("submit", submit);
      this.pasteButton.removeEventListener("click", paste);
      this.disconnectButton.removeEventListener("click", disconnect);
      this.inspectToggle.removeEventListener("click", inspect);
      this.linkCode.removeEventListener("input", input);
    };
  }

  public bindSettings(controller: PanelSettingsController): () => void {
    let disposed = false;
    let autoRefreshBound = false;
    let ideHighlightBound = false;
    let unsubscribe: (() => void) | undefined;
    const autoRefresh = (): void => {
      if (!disposed) {
        controller.setAutoRefreshEnabled(this.autoRefreshToggle.checked);
      }
    };
    const ideHighlight = (): void => {
      if (!disposed) {
        controller.setIdeHighlightEnabled(this.ideHighlightToggle.checked);
      }
    };
    const render = (): void => {
      if (!disposed) this.renderSettings(controller.snapshot());
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (autoRefreshBound) {
        this.autoRefreshToggle.removeEventListener("change", autoRefresh);
        autoRefreshBound = false;
      }
      if (ideHighlightBound) {
        this.ideHighlightToggle.removeEventListener("change", ideHighlight);
        ideHighlightBound = false;
      }
    };
    try {
      this.autoRefreshToggle.addEventListener("change", autoRefresh);
      autoRefreshBound = true;
      this.ideHighlightToggle.addEventListener("change", ideHighlight);
      ideHighlightBound = true;
      unsubscribe = controller.subscribe(render);
      render();
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  public readLinkCode(): string {
    return this.linkCode.value;
  }

  public writeLinkCode(value: string): void {
    this.linkCode.value = value;
  }

  public render(model: PanelViewModel): void {
    if (this.disposed) return;
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
    this.inspectToggle.setAttribute("aria-pressed", String(model.inspectChecked));
    this.inspectToggle.dataset.state = model.inspectChecked ? "active" : "idle";
    this.panelError.value = model.errorText ?? "";
    this.panelError.hidden = model.errorText === undefined;

    this.toolbarFeatures.hidden = false;
    this.linkOnboarding.hidden = !model.showLinkControls;
    this.workspace.hidden = false;
    this.operationalFooter.hidden = false;
  }

  public renderResolution(model: ResolutionViewModel): void {
    if (this.disposed) return;
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

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const view = this.elementsView;
    this.elementsView = undefined;
    view?.dispose();
  }

  private requiredElementsView(): ElementsInspectorView {
    if (!this.elementsView || this.disposed) {
      throw new Error("Elements Inspector is not mounted");
    }
    return this.elementsView;
  }

  private renderSettings(model: PanelSettingsViewModel): void {
    if (this.disposed) return;
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

  private run(action: () => void | Promise<void>): void {
    try {
      void Promise.resolve(action()).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }
}

interface InspectorPanelElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  readonly dataset: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function required(document: PanelDocument, id: string): InspectorPanelElement {
  const element = document.getElementById(id);
  if (!isInspectorPanelElement(element)) {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element;
}

function isInspectorPanelElement(value: unknown): value is InspectorPanelElement {
  return Boolean(
    value &&
    typeof value === "object" &&
    "dataset" in value &&
    "addEventListener" in value &&
    "removeEventListener" in value &&
    "getAttribute" in value &&
    "setAttribute" in value,
  );
}
