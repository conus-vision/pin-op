import {
  RESOLUTION_LIMITS,
  type SourceNavigationStateMessage,
} from "@pinop/protocol";
import type {
  DomEvent,
  DomRequest,
  DomResponse,
} from "./domProtocol.js";

const CONTENT_SESSION_ID_BRAND: unique symbol = Symbol(
  "pinop.contentSessionId",
);

export type ContentSessionId = string & {
  readonly [CONTENT_SESSION_ID_BRAND]: true;
};

export const INSPECT_CONTENT_LEASE_PORT_PREFIX =
  "pinop.inspect.contentLease.";
export const CONTENT_SESSION_ID_MAX_LENGTH = 128;
export const DEVTOOLS_PANEL_PORT_PREFIX = "pinop.devtools.";
export const DEVTOOLS_CHANNEL_MAX_LENGTH = 128;

export interface InspectPortRequest {
  readonly type: "pinop.inspect.setEnabled";
  readonly requestId: string;
  readonly enabled: boolean;
}

export type InspectPortResult =
  | {
      readonly type: "pinop.inspect.result";
      readonly requestId: string;
      readonly ok: true;
    }
  | {
      readonly type: "pinop.inspect.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export interface InspectPortInvalidated {
  readonly type: "pinop.inspect.invalidated";
  readonly reason: "documentDisconnected";
}

export interface PanelSourceNavigateCommand {
  readonly type: "pinop.source.navigate";
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly direction: "previous" | "next";
}

/** Messages sent from the DevTools panel to its trusted background port. */
export type PanelToBackgroundInspectPortMessage =
  | InspectPortRequest
  | PanelSourceNavigateCommand
  | DomRequest;

/** Messages sent from the trusted background port to the DevTools panel. */
export type BackgroundToPanelInspectPortMessage =
  | InspectPortResult
  | InspectPortInvalidated
  | SourceNavigationStateMessage
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

export function createInspectContentLeasePortName(
  contentSessionId: string,
): string {
  if (!isValidContentSessionId(contentSessionId)) {
    throw new Error("Invalid content session ID");
  }
  return `${INSPECT_CONTENT_LEASE_PORT_PREFIX}${contentSessionId}`;
}

export function parseInspectContentLeasePortName(
  value: unknown,
): ContentSessionId | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith(INSPECT_CONTENT_LEASE_PORT_PREFIX)
  ) {
    return undefined;
  }
  const contentSessionId = value.slice(
    INSPECT_CONTENT_LEASE_PORT_PREFIX.length,
  );
  return isValidContentSessionId(contentSessionId) &&
      value === createInspectContentLeasePortName(contentSessionId)
    ? contentSessionId
    : undefined;
}

export function isValidContentSessionId(
  value: unknown,
): value is ContentSessionId {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= CONTENT_SESSION_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
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
    value.type !== "pinop.inspect.setEnabled" ||
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
    value.type !== "pinop.inspect.result" ||
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
      value.type === "pinop.inspect.invalidated" &&
      value.reason === "documentDisconnected"
    ? {
        type: value.type,
        reason: value.reason,
      }
    : undefined;
}

export function parsePanelSourceNavigateCommand(
  value: unknown,
): PanelSourceNavigateCommand | undefined {
  const record = snapshotExactDataRecord(value, [
    "type",
    "inspectMessageId",
    "resolutionGeneration",
    "direction",
  ]);
  if (
    !record ||
    record.type !== "pinop.source.navigate" ||
    typeof record.inspectMessageId !== "string" ||
    record.inspectMessageId.length === 0 ||
    record.inspectMessageId.length > RESOLUTION_LIMITS.opaqueIdLength ||
    typeof record.resolutionGeneration !== "number" ||
    !Number.isSafeInteger(record.resolutionGeneration) ||
    record.resolutionGeneration < 0 ||
    record.resolutionGeneration > RESOLUTION_LIMITS.generation ||
    (record.direction !== "previous" && record.direction !== "next")
  ) {
    return undefined;
  }
  return {
    type: record.type,
    inspectMessageId: record.inspectMessageId,
    resolutionGeneration: record.resolutionGeneration,
    direction: record.direction,
  };
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

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return undefined;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const holder = Reflect.getOwnPropertyDescriptor(descriptors, key);
      const descriptor = holder?.value as PropertyDescriptor | undefined;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        return undefined;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
