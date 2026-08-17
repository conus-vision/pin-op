import { parseLinkCode } from "./linkCode.js";
import { parseInspectPortInvalidated } from "./inspectPortProtocol.js";
import {
  ClipboardPaste,
  MousePointer2,
  createIcons,
} from "lucide";

export type PanelOperationalState =
  | "notLinked"
  | "linking"
  | "connected"
  | "reconnecting"
  | "offline"
  | "rateLimited"
  | "incompatible"
  | "error";

export type PanelCommand =
  | {
      readonly type: "pin-op.linkWindow";
      readonly channel: string;
      readonly code: string;
    }
  | {
      readonly type: "pin-op.unlinkWindow";
      readonly channel: string;
    };

export interface PanelActions {
  readonly onPaste: () => void | Promise<void>;
  readonly onLink: () => void | Promise<void>;
  readonly onDisconnect: () => void | Promise<void>;
  readonly onInspectChanged: (enabled: boolean) => void | Promise<void>;
  readonly onLinkCodeChanged: (value: string) => void;
}

export interface PanelViewModel {
  readonly state: PanelOperationalState;
  readonly statusLabel: string;
  readonly errorText?: string;
  readonly displayLinkCode?: string;
  readonly showLinkControls: boolean;
  readonly showDisconnect: boolean;
  readonly linkInputDisabled: boolean;
  readonly linkButtonDisabled: boolean;
  readonly pasteButtonDisabled: boolean;
  readonly disconnectButtonDisabled: boolean;
  readonly inspectDisabled: boolean;
  readonly inspectChecked: boolean;
}

export interface PanelView {
  bind(actions: PanelActions): () => void;
  readLinkCode(): string;
  writeLinkCode(value: string): void;
  render(model: PanelViewModel): void;
}

export interface PanelInspectModeController {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  disable(): Promise<void>;
  handleTransportDisconnect(): void;
}

export interface PanelControllerOptions {
  readonly channel: string;
  readonly view: PanelView;
  readonly inspectController: PanelInspectModeController;
  readonly readClipboard: () => Promise<string>;
  readonly sendCommand: (message: PanelCommand) => Promise<unknown>;
  readonly subscribeWindowState: (
    listener: (message: unknown) => void | Promise<void>,
  ) => () => void;
  readonly clearLinkedState: () => void;
}

type PanelCommandError =
  | "invalidCode"
  | "stalePanel"
  | "busy"
  | "rateLimited"
  | "error";

type PanelCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PanelCommandError };

interface DisconnectRollback {
  readonly generation: number;
  readonly displayLinkCode?: string;
}

const statusLabels: Readonly<Record<PanelOperationalState, string>> = {
  notLinked: "Not linked",
  linking: "Linking",
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Linked IDE offline",
  rateLimited: "Rate limited",
  incompatible: "Extensions are incompatible",
  error: "Error",
};

export function createPanelIcons(): void {
  createIcons({
    icons: {
      ClipboardPaste,
      MousePointer2,
    },
    attrs: {
      width: "15",
      height: "15",
      "aria-hidden": "true",
    },
  });
}

export class PanelController {
  private readonly channel: string;
  private readonly view: PanelView;
  private readonly inspectController: PanelInspectModeController;
  private readonly readClipboard: () => Promise<string>;
  private readonly sendCommand: (message: PanelCommand) => Promise<unknown>;
  private readonly subscribeWindowState: PanelControllerOptions["subscribeWindowState"];
  private readonly clearLinkedState: () => void;
  private removeViewBindings: (() => void) | undefined;
  private removeStateSubscription: (() => void) | undefined;
  private state: PanelOperationalState = "notLinked";
  private errorText: string | undefined;
  private displayLinkCode: string | undefined;
  private hasLinkIntent = false;
  private busy = false;
  private operationGeneration = 0;
  private pendingLinkGeneration: number | undefined;
  private disconnectRollback: DisconnectRollback | undefined;
  private initialized = false;
  private disposed = false;

  public constructor(options: PanelControllerOptions) {
    if (!options.channel) {
      throw new Error("Panel channel is required");
    }
    this.channel = options.channel;
    this.view = options.view;
    this.inspectController = options.inspectController;
    this.readClipboard = options.readClipboard;
    this.sendCommand = options.sendCommand;
    this.subscribeWindowState = options.subscribeWindowState;
    this.clearLinkedState = options.clearLinkedState;
  }

  public async initialize(): Promise<void> {
    if (this.disposed || this.initialized) {
      return;
    }
    this.initialized = true;
    this.removeViewBindings = this.view.bind({
      onPaste: () => this.pasteAndLink(),
      onLink: () => this.link(this.view.readLinkCode()),
      onDisconnect: () => this.disconnect(),
      onInspectChanged: (enabled) => this.setInspectEnabled(enabled),
      onLinkCodeChanged: () => {
        this.errorText = undefined;
        this.render();
      },
    });
    this.removeStateSubscription = this.subscribeWindowState((message) =>
      this.handleWindowState(message),
    );
    this.render();
  }

  public async handleTransportDisconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const disconnectRollback = this.disconnectRollback;
    this.disconnectRollback = undefined;
    this.operationGeneration += 1;
    this.pendingLinkGeneration = undefined;
    this.busy = false;
    this.inspectController.handleTransportDisconnect();
    if (disconnectRollback) {
      this.hasLinkIntent = true;
      this.displayLinkCode = disconnectRollback.displayLinkCode;
    }
    if (this.hasLinkIntent) {
      this.state = "offline";
    }
    this.render();
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.operationGeneration += 1;
    this.pendingLinkGeneration = undefined;
    this.disconnectRollback = undefined;
    this.view.writeLinkCode("");
    this.removeStateSubscription?.();
    this.removeStateSubscription = undefined;
    this.removeViewBindings?.();
    this.removeViewBindings = undefined;
    try {
      await this.inspectController.disable();
    } catch {
      this.inspectController.handleTransportDisconnect();
    }
  }

  private async pasteAndLink(): Promise<void> {
    if (this.disposed || this.busy) {
      return;
    }
    const generation = ++this.operationGeneration;
    this.errorText = undefined;
    this.render();
    let clipboard: string;
    try {
      clipboard = await this.readClipboard();
    } catch {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.state = "error";
      this.errorText = "Paste the seven-digit code manually";
      this.render();
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    await this.link(clipboard);
  }

  private async link(rawCode: string): Promise<void> {
    if (this.disposed || this.busy) {
      return;
    }
    let code: string;
    try {
      code = parseLinkCode(rawCode.trim()).value;
    } catch {
      this.state = "error";
      this.errorText = "Enter a valid seven-digit code";
      this.render();
      return;
    }

    const generation = ++this.operationGeneration;
    this.disconnectRollback = undefined;
    this.pendingLinkGeneration = generation;
    await this.disableInspect();
    if (!this.isCurrent(generation)) {
      return;
    }
    if (this.pendingLinkGeneration === generation) {
      this.view.writeLinkCode(code);
    }
    this.displayLinkCode = formatDisplayLinkCode(code);
    this.hasLinkIntent = true;
    this.busy = true;
    this.state = "linking";
    this.errorText = undefined;
    this.render();
    await this.runCommand(
      {
        type: "pin-op.linkWindow",
        channel: this.channel,
        code,
      },
      generation,
    );
  }

  private async disconnect(): Promise<void> {
    if (this.disposed || !this.hasLinkIntent) {
      return;
    }
    const generation = ++this.operationGeneration;
    this.pendingLinkGeneration = undefined;
    this.busy = false;
    this.disconnectRollback = {
      generation,
      displayLinkCode: this.displayLinkCode,
    };
    await this.disableInspect();
    if (!this.isCurrent(generation)) {
      return;
    }
    if (!this.disconnectRollback && this.state === "notLinked") {
      this.render();
      return;
    }
    this.clearLinkedState();
    this.displayLinkCode = undefined;
    this.hasLinkIntent = false;
    this.busy = true;
    this.errorText = undefined;
    this.render();
    await this.runCommand(
      {
        type: "pin-op.unlinkWindow",
        channel: this.channel,
      },
      generation,
    );
    if (!this.isCurrent(generation) || this.busy) {
      return;
    }
    if (this.state === "notLinked") {
      this.view.writeLinkCode("");
      this.render();
    }
  }

  private async runCommand(
    command: PanelCommand,
    generation: number,
  ): Promise<void> {
    let response: unknown;
    try {
      response = await this.sendCommand(command);
    } catch {
      if (!this.isCurrent(generation)) {
        return;
      }
      if (command.type === "pin-op.linkWindow") {
        this.pendingLinkGeneration = undefined;
        this.displayLinkCode = undefined;
        this.hasLinkIntent = false;
      } else if (
        !this.restoreDisconnect(generation) &&
        this.state === "notLinked"
      ) {
        this.busy = false;
        this.render();
        return;
      }
      this.busy = false;
      this.state = "error";
      this.errorText = "Pin-op background is unavailable";
      this.render();
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    if (command.type === "pin-op.linkWindow") {
      this.pendingLinkGeneration = undefined;
    }
    this.busy = false;
    const result = parseCommandResult(response);
    if (!result) {
      if (
        command.type === "pin-op.unlinkWindow" &&
        !this.restoreDisconnect(generation) &&
        this.state === "notLinked"
      ) {
        this.render();
        return;
      }
      this.state = "error";
      this.errorText = "Pin-op background returned an invalid response";
    } else if (!result.ok) {
      if (
        command.type === "pin-op.linkWindow" &&
        result.error !== "busy" &&
        result.error !== "stalePanel"
      ) {
        this.hasLinkIntent = false;
        this.displayLinkCode = undefined;
      }
      if (
        command.type === "pin-op.unlinkWindow" &&
        !this.restoreDisconnect(generation) &&
        this.state === "notLinked"
      ) {
        this.render();
        return;
      }
      this.applyCommandError(result.error);
    } else if (command.type === "pin-op.linkWindow") {
      this.view.writeLinkCode("");
    } else {
      this.disconnectRollback = undefined;
      this.state = "notLinked";
      this.hasLinkIntent = false;
      this.displayLinkCode = undefined;
      this.view.writeLinkCode("");
    }
    this.render();
  }

  private async handleWindowState(message: unknown): Promise<void> {
    if (parseInspectPortInvalidated(message)) {
      if (!this.disposed) {
        this.inspectController.handleTransportDisconnect();
        this.errorText = undefined;
        this.render();
      }
      return;
    }
    const windowState = parseWindowState(message);
    if (!windowState || this.disposed) {
      return;
    }
    const nextState = windowState.state;
    this.state = nextState;
    if (nextState === "notLinked") {
      this.disconnectRollback = undefined;
      this.hasLinkIntent = false;
      this.displayLinkCode = undefined;
      this.clearLinkedState();
    } else if (
      retainsLinkIntent(nextState, windowState.displayLinkCode)
    ) {
      this.hasLinkIntent = true;
      if (windowState.displayLinkCode) {
        this.displayLinkCode = windowState.displayLinkCode;
      } else if (nextState === "linking") {
        this.displayLinkCode = undefined;
      }
    } else if (!windowState.displayLinkCode) {
      this.hasLinkIntent = false;
      this.displayLinkCode = undefined;
    }
    if (nextState === "connected") {
      if (this.pendingLinkGeneration === this.operationGeneration) {
        this.pendingLinkGeneration = undefined;
        this.view.writeLinkCode("");
      }
      this.errorText = undefined;
    } else {
      await this.disableInspect();
    }
    this.render();
  }

  private async setInspectEnabled(enabled: boolean): Promise<void> {
    if (
      this.disposed ||
      (enabled &&
        (this.state !== "connected" || this.busy))
    ) {
      this.render();
      return;
    }
    try {
      await this.inspectController.setEnabled(enabled);
      this.errorText = undefined;
    } catch {
      this.inspectController.handleTransportDisconnect();
      this.errorText = "Inspect connection is unavailable";
    }
    this.render();
  }

  private async disableInspect(): Promise<void> {
    try {
      await this.inspectController.disable();
    } catch {
      this.inspectController.handleTransportDisconnect();
    }
  }

  private applyCommandError(error: PanelCommandError): void {
    switch (error) {
      case "rateLimited":
        this.state = "rateLimited";
        this.errorText = "Too many attempts. Try again in one minute.";
        return;
      case "invalidCode":
        this.state = "error";
        this.errorText = "Enter a valid seven-digit code";
        return;
      case "stalePanel":
        this.state = "error";
        this.errorText = "Reopen Pin-op DevTools and try again";
        return;
      case "busy":
        this.state = "error";
        this.errorText = "Another Pin-op action is still running";
        return;
      case "error":
        this.state = "error";
        this.errorText = "Pin-op could not complete the action";
    }
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const showLinkControls =
      !this.hasLinkIntent &&
      (this.state === "notLinked" ||
        this.state === "rateLimited" ||
        this.state === "error");
    const validCode = validNormalizedCode(this.view.readLinkCode());
    const inspectDisabled =
      this.busy || this.state !== "connected";
    this.view.render({
      state: this.state,
      statusLabel: statusLabels[this.state],
      errorText: this.errorText,
      displayLinkCode: this.displayLinkCode,
      showLinkControls,
      showDisconnect: this.hasLinkIntent,
      linkInputDisabled: this.busy,
      linkButtonDisabled: this.busy || !validCode,
      pasteButtonDisabled: this.busy,
      disconnectButtonDisabled: this.busy,
      inspectDisabled,
      inspectChecked: !inspectDisabled && this.inspectController.enabled,
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.operationGeneration === generation;
  }

  private restoreDisconnect(generation: number): boolean {
    const rollback = this.disconnectRollback;
    if (!rollback || rollback.generation !== generation) {
      return false;
    }
    this.disconnectRollback = undefined;
    this.hasLinkIntent = true;
    this.displayLinkCode = rollback.displayLinkCode;
    return true;
  }
}

function validNormalizedCode(value: string): boolean {
  try {
    parseLinkCode(value.trim());
    return true;
  } catch {
    return false;
  }
}

interface ParsedWindowState {
  readonly state: PanelOperationalState;
  readonly displayLinkCode?: string;
}

function parseWindowState(value: unknown): ParsedWindowState | undefined {
  if (
    !isRecord(value) ||
    (!hasOnlyKeys(value, ["type", "state"]) &&
      !hasOnlyKeys(value, ["type", "state", "displayLinkCode"])) ||
    value.type !== "pin-op.windowState"
  ) {
    return undefined;
  }
  let state: PanelOperationalState;
  switch (value.state) {
    case "notLinked":
    case "linking":
    case "reconnecting":
    case "offline":
    case "rateLimited":
    case "incompatible":
    case "error":
      state = value.state;
      break;
    case "linked":
      state = "connected";
      break;
    default:
      return undefined;
  }
  if (value.displayLinkCode === undefined) {
    return { state };
  }
  if (
    typeof value.displayLinkCode !== "string" ||
    !canCarryDisplayLinkCode(state) ||
    !isFormattedLinkCode(value.displayLinkCode)
  ) {
    return undefined;
  }
  return { state, displayLinkCode: value.displayLinkCode };
}

function parseCommandResult(value: unknown): PanelCommandResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.ok === true && hasOnlyKeys(value, ["ok"])) {
    return { ok: true };
  }
  if (
    value.ok !== false ||
    !hasOnlyKeys(value, ["ok", "error"]) ||
    !isCommandError(value.error)
  ) {
    return undefined;
  }
  return { ok: false, error: value.error };
}

function isCommandError(value: unknown): value is PanelCommandError {
  return (
    value === "invalidCode" ||
    value === "stalePanel" ||
    value === "busy" ||
    value === "rateLimited" ||
    value === "error"
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function canCarryDisplayLinkCode(state: PanelOperationalState): boolean {
  return (
    state === "linking" ||
    state === "connected" ||
    state === "reconnecting" ||
    state === "offline" ||
    state === "incompatible" ||
    state === "error"
  );
}

function retainsLinkIntent(
  state: PanelOperationalState,
  displayLinkCode: string | undefined,
): boolean {
  return (
    state === "linking" ||
    state === "connected" ||
    state === "reconnecting" ||
    state === "offline" ||
    state === "incompatible" ||
    (state === "error" && displayLinkCode !== undefined)
  );
}

function isFormattedLinkCode(value: string): boolean {
  try {
    return formatDisplayLinkCode(parseLinkCode(value).value) === value;
  } catch {
    return false;
  }
}

function formatDisplayLinkCode(value: string): string {
  return `${value.slice(0, 5)} ${value.slice(5)}`;
}
