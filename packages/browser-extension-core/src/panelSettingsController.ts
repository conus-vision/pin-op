import { PROTOCOL_VERSION } from "@pin-op/protocol";
import type { BrowserWindowConnectionState } from "./windowConnectionCoordinator.js";
import type { PanelPresentationSettingsCommand } from "./inspectPortProtocol.js";
import {
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  type PanelTabSettingsCommand,
} from "./refreshRuntimeProtocol.js";

export type { PanelPresentationSettingsCommand } from "./inspectPortProtocol.js";

export type PanelSettingsCommand =
  | PanelTabSettingsCommand
  | PanelPresentationSettingsCommand;

export type PanelSettingsDispatch = (message: PanelSettingsCommand) => void;

export interface PanelSettingsViewModel {
  readonly autoRefreshEnabled: boolean;
  readonly ideHighlightEnabled: boolean;
  readonly compatibility: "pending" | "compatible" | "incompatible";
  readonly snapshotReady: boolean;
  readonly controlsEnabled: boolean;
  readonly browserProtocolVersion?: number;
  readonly peerProtocolVersion?: number | "unknown";
}

const panelSettingsBindingTokenBrand: unique symbol = Symbol(
  "panelSettingsBindingToken",
);

export interface PanelSettingsBindingToken {
  readonly [panelSettingsBindingTokenBrand]: true;
}

const initialModel: PanelSettingsViewModel = Object.freeze({
  autoRefreshEnabled: true,
  ideHighlightEnabled: true,
  compatibility: "pending",
  snapshotReady: false,
  controlsEnabled: false,
});

export class PanelSettingsController {
  private readonly listeners = new Set<() => void>();
  private current = initialModel;
  private inspectMessageId: string | undefined;
  private bindingToken: PanelSettingsBindingToken | undefined;

  public constructor(private readonly dispatch: PanelSettingsDispatch) {}

  public acceptCompatibility(
    token: PanelSettingsBindingToken,
    message: unknown,
  ): boolean {
    if (token !== this.bindingToken) {
      return false;
    }
    const parsed = parseProtocolCompatibilityMessage(message);
    if (!parsed) {
      return false;
    }
    this.inspectMessageId = undefined;
    this.update(parsed.compatible
      ? {
        ...initialModel,
        compatibility: "compatible",
      }
      : {
        ...initialModel,
        compatibility: "incompatible",
        browserProtocolVersion: parsed.browserProtocolVersion,
        peerProtocolVersion: parsed.peerProtocolVersion,
      });
    return true;
  }

  public acceptTabState(
    token: PanelSettingsBindingToken,
    message: unknown,
  ): boolean {
    if (token !== this.bindingToken) {
      return false;
    }
    const parsed = parsePanelTabStateMessage(message);
    if (!parsed || this.current.compatibility !== "compatible") {
      return false;
    }
    this.update({
      autoRefreshEnabled: parsed.autoRefreshEnabled,
      ideHighlightEnabled: parsed.ideHighlightEnabled,
      compatibility: "compatible",
      snapshotReady: true,
      controlsEnabled: true,
    });
    return true;
  }

  public acceptWindowState(
    token: PanelSettingsBindingToken,
    state: BrowserWindowConnectionState,
  ): boolean {
    if (token !== this.bindingToken) {
      return false;
    }
    if (state === "incompatible") {
      this.inspectMessageId = undefined;
      this.update({
        ...initialModel,
        compatibility: "incompatible",
        browserProtocolVersion: PROTOCOL_VERSION,
        peerProtocolVersion: "unknown",
      });
    } else if (state !== "linked") {
      this.bindingToken = undefined;
      this.inspectMessageId = undefined;
      this.update(initialModel);
    }
    return true;
  }

  public beginBinding(preserveIncompatible = false): PanelSettingsBindingToken {
    const token = Object.freeze({
      [panelSettingsBindingTokenBrand]: true as const,
    });
    const preserved = preserveIncompatible &&
        this.current.compatibility === "incompatible"
      ? this.current
      : initialModel;
    this.bindingToken = token;
    this.inspectMessageId = undefined;
    this.update(preserved);
    return token;
  }

  public revokeBinding(preserveIncompatible = false): void {
    this.bindingToken = undefined;
    this.inspectMessageId = undefined;
    if (!preserveIncompatible || this.current.compatibility !== "incompatible") {
      this.update(initialModel);
    }
  }

  public beginInspect(inspectMessageId: string): boolean {
    if (!this.current.controlsEnabled || !isOpaqueId(inspectMessageId)) {
      this.inspectMessageId = undefined;
      return false;
    }
    this.inspectMessageId = inspectMessageId;
    return true;
  }

  public invalidateInspect(): void {
    this.inspectMessageId = undefined;
  }

  public setAutoRefreshEnabled(enabled: boolean): boolean {
    if (!this.current.controlsEnabled || typeof enabled !== "boolean") {
      return false;
    }
    if (enabled === this.current.autoRefreshEnabled) {
      return true;
    }
    this.update({ ...this.current, autoRefreshEnabled: enabled });
    this.dispatchTabSettings();
    return true;
  }

  public setIdeHighlightEnabled(enabled: boolean): boolean {
    if (!this.current.controlsEnabled || typeof enabled !== "boolean") {
      return false;
    }
    if (enabled === this.current.ideHighlightEnabled) {
      return true;
    }
    this.update({ ...this.current, ideHighlightEnabled: enabled });
    this.dispatchTabSettings();
    if (this.inspectMessageId) {
      this.dispatch(Object.freeze({
        type: "pin-op.presentation.settings",
        inspectMessageId: this.inspectMessageId,
        ideHighlightEnabled: enabled,
      }));
    }
    return true;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public snapshot(): PanelSettingsViewModel {
    return this.current;
  }

  private dispatchTabSettings(): void {
    this.dispatch(Object.freeze({
      type: "pin-op.tab.settings",
      autoRefreshEnabled: this.current.autoRefreshEnabled,
      ideHighlightEnabled: this.current.ideHighlightEnabled,
    }));
  }

  private update(model: PanelSettingsViewModel): void {
    this.current = Object.freeze({ ...model });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failed view must not prevent other panel surfaces from updating.
      }
    }
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
