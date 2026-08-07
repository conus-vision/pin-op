import type {
  PanelActions,
  PanelView,
  PanelViewModel,
} from "./panelController.js";

export interface PanelDocument {
  getElementById(id: string): unknown;
}

export class DomPanelView implements PanelView {
  private readonly linkControls: PanelElement;
  private readonly linkForm: PanelElement;
  private readonly linkCode: PanelElement;
  private readonly pasteButton: PanelElement;
  private readonly linkButton: PanelElement;
  private readonly connectedControls: PanelElement;
  private readonly changeButton: PanelElement;
  private readonly unlinkButton: PanelElement;
  private readonly inspectToggle: PanelElement;
  private readonly connectionStatus: PanelElement;
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
    this.connectedControls = required(document, "connected-controls");
    this.changeButton = required(document, "change-button");
    this.unlinkButton = required(document, "unlink-button");
    this.inspectToggle = required(document, "inspect-mode");
    this.connectionStatus = required(document, "connection-status");
    this.panelError = required(document, "panel-error");
  }

  public bind(actions: PanelActions): () => void {
    const submit = (event: Event): void => {
      event.preventDefault();
      this.run(actions.onLink);
    };
    const paste = (): void => this.run(actions.onPaste);
    const change = (): void => this.run(actions.onChangeIde);
    const unlink = (): void => this.run(actions.onUnlink);
    const inspect = (): void =>
      this.run(() => actions.onInspectChanged(this.inspectToggle.checked));
    const input = (): void => actions.onLinkCodeChanged(this.linkCode.value);

    this.linkForm.addEventListener("submit", submit);
    this.pasteButton.addEventListener("click", paste);
    this.changeButton.addEventListener("click", change);
    this.unlinkButton.addEventListener("click", unlink);
    this.inspectToggle.addEventListener("change", inspect);
    this.linkCode.addEventListener("input", input);

    return () => {
      this.linkForm.removeEventListener("submit", submit);
      this.pasteButton.removeEventListener("click", paste);
      this.changeButton.removeEventListener("click", change);
      this.unlinkButton.removeEventListener("click", unlink);
      this.inspectToggle.removeEventListener("change", inspect);
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
    this.connectedControls.hidden = !model.showConnectedControls;
    this.linkCode.disabled = model.linkInputDisabled;
    this.pasteButton.disabled = model.pasteButtonDisabled;
    this.linkButton.disabled = model.linkButtonDisabled;
    this.changeButton.disabled = model.changeButtonDisabled;
    this.unlinkButton.disabled = model.unlinkButtonDisabled;
    this.inspectToggle.disabled = model.inspectDisabled;
    this.inspectToggle.checked = model.inspectChecked;
    this.panelError.value = model.errorText ?? "";
    this.panelError.hidden = model.errorText === undefined;
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
