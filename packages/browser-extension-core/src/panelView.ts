import type {
  PanelActions,
  PanelView,
  PanelViewModel,
} from "./panelController.js";
import type { ResolutionViewModel } from "./resolutionPresenter.js";

export interface PanelDocument {
  getElementById(id: string): unknown;
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
  private readonly connectionStatus: PanelElement;
  private readonly selectedElementSummary: PanelElement;
  private readonly resolutionStatus: PanelElement;
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
    this.connectionStatus = required(document, "connection-status");
    this.selectedElementSummary = required(
      document,
      "selected-element-summary",
    );
    this.resolutionStatus = required(document, "resolution-status");
    this.panelError = required(document, "panel-error");
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

  private run(action: () => void | Promise<void>): void {
    void Promise.resolve(action()).catch(this.onError);
  }
}

interface PanelElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  readonly dataset: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function required(document: PanelDocument, id: string): PanelElement {
  const element = document.getElementById(id);
  if (!element || typeof element !== "object") {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as PanelElement;
}
