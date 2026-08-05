import type {
  DomEvent,
  DomRequest,
  DomResponse,
} from "./domProtocol.js";

export const INSPECT_CONTENT_LEASE_PORT_NAME =
  "browser2ide.inspect.contentLease";
export const DEVTOOLS_PANEL_PORT_PREFIX = "browser2ide.devtools.";
export const DEVTOOLS_CHANNEL_MAX_LENGTH = 128;

export interface InspectPortRequest {
  readonly type: "browser2ide.inspect.setEnabled";
  readonly requestId: string;
  readonly enabled: boolean;
}

export type InspectPortResult =
  | {
      readonly type: "browser2ide.inspect.result";
      readonly requestId: string;
      readonly ok: true;
    }
  | {
      readonly type: "browser2ide.inspect.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export interface InspectPortInvalidated {
  readonly type: "browser2ide.inspect.invalidated";
  readonly reason: "documentDisconnected";
}

/** Messages sent from the DevTools panel to its trusted background port. */
export type PanelToBackgroundInspectPortMessage =
  | InspectPortRequest
  | DomRequest;

/** Messages sent from the trusted background port to the DevTools panel. */
export type BackgroundToPanelInspectPortMessage =
  | InspectPortResult
  | InspectPortInvalidated
  | DomResponse
  | DomEvent;

/** Messages sent from the trusted background port to the content-script lease. */
export type BackgroundToContentInspectPortMessage =
  | InspectPortRequest
  | DomRequest;

/** Messages sent from the content-script lease to its trusted background port. */
export type ContentToBackgroundInspectPortMessage =
  | InspectPortResult
  | InspectPortInvalidated
  | DomResponse
  | DomEvent;

export interface InspectPortEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface BackgroundInspectPort {
  readonly name: string;
  readonly onMessage: InspectPortEvent<(message: unknown) => void>;
  readonly onDisconnect: InspectPortEvent<() => void>;
  postMessage(message: unknown): void;
}

export interface PanelInspectPort extends BackgroundInspectPort {
  disconnect(): void;
}

export interface ContentInspectPort {
  readonly onDisconnect: InspectPortEvent<() => void>;
  disconnect(): void;
}

export function createDevtoolsPanelPortName(channel: string): string {
  if (!isValidDevtoolsChannel(channel)) {
    throw new Error("Invalid DevTools panel channel");
  }
  return `${DEVTOOLS_PANEL_PORT_PREFIX}${channel}`;
}

export function parseDevtoolsPanelPortName(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith(DEVTOOLS_PANEL_PORT_PREFIX)
  ) {
    return undefined;
  }
  const channel = value.slice(DEVTOOLS_PANEL_PORT_PREFIX.length);
  return isValidDevtoolsChannel(channel) &&
      value === createDevtoolsPanelPortName(channel)
    ? channel
    : undefined;
}

export function isValidDevtoolsChannel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DEVTOOLS_CHANNEL_MAX_LENGTH &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

export function parseInspectPortRequest(
  value: unknown,
): InspectPortRequest | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "requestId", "enabled"]) ||
    value.type !== "browser2ide.inspect.setEnabled" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.enabled !== "boolean"
  ) {
    return undefined;
  }
  return {
    type: value.type,
    requestId: value.requestId,
    enabled: value.enabled,
  };
}

export function parseInspectPortResult(
  value: unknown,
): InspectPortResult | undefined {
  if (
    !isRecord(value) ||
    value.type !== "browser2ide.inspect.result" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.ok !== "boolean"
  ) {
    return undefined;
  }
  if (value.ok) {
    return hasOnlyKeys(value, ["type", "requestId", "ok"])
      ? {
          type: value.type,
          requestId: value.requestId,
          ok: true,
        }
      : undefined;
  }
  return hasOnlyKeys(value, ["type", "requestId", "ok", "error"]) &&
      typeof value.error === "string"
    ? {
        type: value.type,
        requestId: value.requestId,
        ok: false,
        error: value.error,
      }
    : undefined;
}

export function parseInspectPortInvalidated(
  value: unknown,
): InspectPortInvalidated | undefined {
  return isRecord(value) &&
      hasOnlyKeys(value, ["type", "reason"]) &&
      value.type === "browser2ide.inspect.invalidated" &&
      value.reason === "documentDisconnected"
    ? {
        type: value.type,
        reason: value.reason,
      }
    : undefined;
}

export function parseInspectControllerCommand(value: unknown):
  | {
      readonly type: "enableInspectMode" | "disableInspectMode";
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.type === "enableInspectMode" ||
      value.type === "disableInspectMode"
    ? { type: value.type }
    : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
