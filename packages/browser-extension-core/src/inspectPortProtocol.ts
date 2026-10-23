import {
  RESOLUTION_LIMITS,
  RULES_SOURCES_LIMITS,
  RulesOpenDeclarationSchema,
  type RulesOpenDeclaration,
  type RulesSourcesMessage,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import type {
  DomEvent,
  DomResponse,
} from "./domProtocol.js";
import {
  isSelectionRevision,
  parseDomRequest,
  type DomRequest,
} from "./domProtocol.js";
import type {
  PanelTabSettingsCommand,
  PanelTabStateMessage,
  ProtocolCompatibilityMessage,
  RefreshExecutionCommand,
} from "./refreshRuntimeProtocol.js";
import { snapshotExactDataRecord } from "./protocolDataSnapshot.js";
import {
  VIEWPORT_DIMENSION_MAX,
  VIEWPORT_DIMENSION_MIN,
} from "./mediaQueryViewport.js";
import {
  parseStylesRequest,
  type StylesRequest,
} from "./stylesProtocol.js";
import type {
  StylesInvalidatedEvent,
  StylesResponse,
} from "./stylesProtocol.js";

export {
  parsePanelTabSettingsCommand,
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  parseRefreshExecutionCommand,
} from "./refreshRuntimeProtocol.js";

const CONTENT_SESSION_ID_BRAND: unique symbol = Symbol(
  "pin-op.contentSessionId",
);

export type ContentSessionId = string & {
  readonly [CONTENT_SESSION_ID_BRAND]: true;
};

export const INSPECT_CONTENT_LEASE_PORT_PREFIX =
  "pin-op.inspect.contentLease.";
export const CONTENT_SESSION_ID_MAX_LENGTH = 128;
export const DEVTOOLS_PANEL_PORT_PREFIX = "pin-op.devtools.";
export const DEVTOOLS_CHANNEL_MAX_LENGTH = 128;

export const INSPECTOR_LOCAL_REQUEST_TYPES = Object.freeze([
  "dom.getRoot",
  "dom.getChildren",
  "dom.resolveLocator",
  "dom.select",
  "dom.hover",
  "dom.clearHover",
  "styles.getMatched",
  "styles.setPseudoStates",
] as const);

const INSPECTOR_LOCAL_REQUEST_TYPE_SET: ReadonlySet<string> = new Set(
  INSPECTOR_LOCAL_REQUEST_TYPES,
);

export interface InspectPortRequest {
  readonly type: "pin-op.inspect.setEnabled";
  readonly requestId: string;
  readonly enabled: boolean;
}

export type InspectPortResult =
  | {
      readonly type: "pin-op.inspect.result";
      readonly requestId: string;
      readonly ok: true;
    }
  | {
      readonly type: "pin-op.inspect.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export interface InspectPortInvalidated {
  readonly type: "pin-op.inspect.invalidated";
  readonly reason: "documentDisconnected";
}

export interface InspectRepublishRequest {
  readonly type: "pin-op.inspect.republish";
  readonly contentSessionId: ContentSessionId;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly republishToken: string;
}

export interface InspectClearPseudoStatesRequest {
  readonly type: "pin-op.inspect.clearPseudoStates";
  readonly contentSessionId: ContentSessionId;
}

export interface InspectDisposeSessionRequest {
  readonly type: "pin-op.inspect.disposeSession";
  readonly contentSessionId: ContentSessionId;
}

export interface PanelSourceNavigateCommand {
  readonly type: "pin-op.source.navigate";
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly direction: "previous" | "next";
}

export interface PanelSourceOpenCommand {
  readonly type: "pin-op.source.open";
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly matchId: string;
}

export interface PanelRulesOpenCommand {
  readonly type: "pin-op.rules.open";
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly openAuthorityId: string;
  /** The clicked declaration, when a property rather than the origin was clicked. */
  readonly declaration?: RulesOpenDeclaration;
}

/**
 * Shows the inspected page at the viewport size a Rules `@media` condition
 * names. The background resizes only the window holding the panel's own tab.
 */
export interface PanelViewportResizeCommand {
  readonly type: "pin-op.viewport.resize";
  readonly width?: number;
  readonly height?: number;
}

export interface PanelRulesSourcesInvalidatedState {
  readonly type: "pin-op.rules.invalidated";
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
}

export interface PanelInspectStartedState {
  readonly type: "pin-op.inspect.started";
  readonly inspectMessageId: string;
  readonly selectionRevision: number;
  readonly expectedRuleRefs: readonly string[];
}

export interface PanelPresentationSettingsCommand {
  readonly type: "pin-op.presentation.settings";
  readonly inspectMessageId: string;
  readonly ideHighlightEnabled: boolean;
}

/** Messages sent from the DevTools panel to its trusted background port. */
export type PanelToBackgroundInspectPortMessage =
  | InspectPortRequest
  | PanelSourceNavigateCommand
  | PanelSourceOpenCommand
  | PanelRulesOpenCommand
  | PanelViewportResizeCommand
  | PanelPresentationSettingsCommand
  | PanelTabSettingsCommand
  | DomRequest
  | StylesRequest;

/** Messages sent from the trusted background port to the DevTools panel. */
export type BackgroundToPanelInspectPortMessage =
  | InspectPortResult
  | InspectPortInvalidated
  | PanelTabStateMessage
  | ProtocolCompatibilityMessage
  | PanelInspectStartedState
  | PanelRulesSourcesInvalidatedState
  | RulesSourcesMessage
  | SourceMatchesMessage
  | SourceNavigationStateMessage
  | DomResponse
  | DomEvent
  | StylesResponse
  | StylesInvalidatedEvent;

/** Messages sent from the trusted background port to the content-script lease. */
export type BackgroundToContentInspectPortMessage =
  | InspectPortRequest
  | InspectRepublishRequest
  | InspectClearPseudoStatesRequest
  | InspectDisposeSessionRequest
  | RefreshExecutionCommand
  | DomRequest
  | StylesRequest;

/** Messages sent from the content-script lease to its trusted background port. */
export type ContentToBackgroundInspectPortMessage =
  | InspectPortResult
  | InspectPortInvalidated
  | DomResponse
  | DomEvent
  | StylesResponse
  | StylesInvalidatedEvent;

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

export function parseInspectorLocalRequest(
  value: unknown,
): DomRequest | StylesRequest | undefined {
  const type = readExactDataType(value);
  if (!type || !INSPECTOR_LOCAL_REQUEST_TYPE_SET.has(type)) return undefined;
  try {
    return type === "styles.getMatched" || type === "styles.setPseudoStates"
      ? parseStylesRequest(value)
      : parseDomRequest(value);
  } catch {
    return undefined;
  }
}

export function isInspectorLocalRequestType(value: unknown): boolean {
  return typeof value === "string" &&
    INSPECTOR_LOCAL_REQUEST_TYPE_SET.has(value);
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
    value.type !== "pin-op.inspect.setEnabled" ||
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

export function parseInspectRepublishRequest(
  value: unknown,
): InspectRepublishRequest | undefined {
  const record = snapshotExactDataRecord(value, [
    "type",
    "contentSessionId",
    "documentEpoch",
    "nodeRef",
    "selectionRevision",
    "republishToken",
  ]);
  if (
    !record ||
    record.type !== "pin-op.inspect.republish" ||
    !isValidContentSessionId(record.contentSessionId) ||
    !isSelectionRevision(record.documentEpoch) ||
    !isProtocolOpaqueId(record.nodeRef) ||
    !isSelectionRevision(record.selectionRevision) ||
    !isValidInspectRepublishToken(record.republishToken)
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    contentSessionId: record.contentSessionId,
    documentEpoch: record.documentEpoch,
    nodeRef: record.nodeRef,
    selectionRevision: record.selectionRevision,
    republishToken: record.republishToken,
  });
}

export function isValidInspectRepublishToken(
  value: unknown,
): value is string {
  return isProtocolOpaqueId(value);
}

export function parseInspectClearPseudoStatesRequest(
  value: unknown,
): InspectClearPseudoStatesRequest | undefined {
  const record = snapshotExactDataRecord(value, ["type", "contentSessionId"]);
  if (
    !record ||
    record.type !== "pin-op.inspect.clearPseudoStates" ||
    !isValidContentSessionId(record.contentSessionId)
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    contentSessionId: record.contentSessionId,
  });
}

export function parseInspectDisposeSessionRequest(
  value: unknown,
): InspectDisposeSessionRequest | undefined {
  const record = snapshotExactDataRecord(value, ["type", "contentSessionId"]);
  if (
    !record ||
    record.type !== "pin-op.inspect.disposeSession" ||
    !isValidContentSessionId(record.contentSessionId)
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    contentSessionId: record.contentSessionId,
  });
}

export function parseInspectPortResult(
  value: unknown,
): InspectPortResult | undefined {
  if (
    !isRecord(value) ||
    value.type !== "pin-op.inspect.result" ||
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
      value.type === "pin-op.inspect.invalidated" &&
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
    record.type !== "pin-op.source.navigate" ||
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

export function parsePanelSourceOpenCommand(
  value: unknown,
): PanelSourceOpenCommand | undefined {
  const record = snapshotExactDataRecord(value, [
    "type",
    "inspectMessageId",
    "resolutionGeneration",
    "matchId",
  ]);
  if (
    !record ||
    record.type !== "pin-op.source.open" ||
    !isProtocolOpaqueId(record.inspectMessageId) ||
    !isResolutionGeneration(record.resolutionGeneration) ||
    !isProtocolOpaqueId(record.matchId)
  ) {
    return undefined;
  }
  return {
    type: record.type,
    inspectMessageId: record.inspectMessageId,
    resolutionGeneration: record.resolutionGeneration,
    matchId: record.matchId,
  };
}

const RULES_OPEN_COMMAND_KEYS = [
  "type",
  "inspectMessageId",
  "rulesGeneration",
  "openAuthorityId",
] as const;

export function parsePanelRulesOpenCommand(
  value: unknown,
): PanelRulesOpenCommand | undefined {
  const record = snapshotExactDataRecord(value, RULES_OPEN_COMMAND_KEYS) ??
    snapshotExactDataRecord(value, [...RULES_OPEN_COMMAND_KEYS, "declaration"]);
  if (
    !record ||
    record.type !== "pin-op.rules.open" ||
    !isProtocolOpaqueId(record.inspectMessageId) ||
    !isResolutionGeneration(record.rulesGeneration) ||
    !isProtocolOpaqueId(record.openAuthorityId)
  ) {
    return undefined;
  }
  const declaration = Object.hasOwn(record, "declaration")
    ? parseRulesOpenDeclaration(record.declaration)
    : undefined;
  if (Object.hasOwn(record, "declaration") && !declaration) return undefined;
  return Object.freeze({
    type: record.type,
    inspectMessageId: record.inspectMessageId,
    rulesGeneration: record.rulesGeneration,
    openAuthorityId: record.openAuthorityId,
    ...(declaration ? { declaration } : {}),
  });
}

export function parsePanelViewportResizeCommand(
  value: unknown,
): PanelViewportResizeCommand | undefined {
  const record = snapshotExactDataRecord(value, ["type", "width", "height"]) ??
    snapshotExactDataRecord(value, ["type", "width"]) ??
    snapshotExactDataRecord(value, ["type", "height"]);
  if (
    !record ||
    record.type !== "pin-op.viewport.resize" ||
    (Object.hasOwn(record, "width") && !isViewportDimension(record.width)) ||
    (Object.hasOwn(record, "height") && !isViewportDimension(record.height))
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    ...(Object.hasOwn(record, "width") ? { width: record.width as number } : {}),
    ...(Object.hasOwn(record, "height") ? { height: record.height as number } : {}),
  });
}

function isViewportDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= VIEWPORT_DIMENSION_MIN &&
    (value as number) <= VIEWPORT_DIMENSION_MAX;
}

/** Validates a clicked Rules declaration exactly as the wire schema does. */
export function parseRulesOpenDeclaration(
  value: unknown,
): RulesOpenDeclaration | undefined {
  try {
    const parsed = RulesOpenDeclarationSchema.safeParse(value);
    return parsed.success
      ? Object.freeze({
          property: parsed.data.property,
          occurrence: parsed.data.occurrence,
        })
      : undefined;
  } catch {
    return undefined;
  }
}

export function parsePanelRulesSourcesInvalidatedState(
  value: unknown,
): PanelRulesSourcesInvalidatedState | undefined {
  const record = snapshotExactDataRecord(value, [
    "type",
    "inspectMessageId",
    "rulesGeneration",
  ]);
  if (
    !record ||
    record.type !== "pin-op.rules.invalidated" ||
    !isProtocolOpaqueId(record.inspectMessageId) ||
    !isResolutionGeneration(record.rulesGeneration) ||
    record.rulesGeneration === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    inspectMessageId: record.inspectMessageId,
    rulesGeneration: record.rulesGeneration,
  });
}

export function parsePanelInspectStartedState(
  value: unknown,
): PanelInspectStartedState | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const expectedKeys = [
      "type",
      "inspectMessageId",
      "selectionRevision",
      "expectedRuleRefs",
    ] as const;
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      expectedKeys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value");
      })
    ) {
      return undefined;
    }
    const type = descriptors.type!.value as unknown;
    const inspectMessageId = descriptors.inspectMessageId!.value as unknown;
    const selectionRevision = descriptors.selectionRevision!.value as unknown;
    const refsValue = descriptors.expectedRuleRefs!.value as unknown;
    const expectedRuleRefs = snapshotExpectedRuleRefs(refsValue);
    if (
      type !== "pin-op.inspect.started" ||
      !isProtocolOpaqueId(inspectMessageId) ||
      !isSelectionRevision(selectionRevision) ||
      !expectedRuleRefs
    ) {
      return undefined;
    }
    return Object.freeze({
      type,
      inspectMessageId,
      selectionRevision,
      expectedRuleRefs,
    });
  } catch {
    return undefined;
  }
}

export function parsePanelPresentationSettingsCommand(
  value: unknown,
): PanelPresentationSettingsCommand | undefined {
  const record = snapshotExactDataRecord(value, [
    "type",
    "inspectMessageId",
    "ideHighlightEnabled",
  ]);
  if (
    !record ||
    record.type !== "pin-op.presentation.settings" ||
    !isProtocolOpaqueId(record.inspectMessageId) ||
    typeof record.ideHighlightEnabled !== "boolean"
  ) {
    return undefined;
  }
  return {
    type: record.type,
    inspectMessageId: record.inspectMessageId,
    ideHighlightEnabled: record.ideHighlightEnabled,
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

function isProtocolOpaqueId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= RESOLUTION_LIMITS.opaqueIdLength;
}

function isResolutionGeneration(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= RESOLUTION_LIMITS.generation;
}

function snapshotExpectedRuleRefs(
  value: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthHolder = Reflect.getOwnPropertyDescriptor(descriptors, "length");
  const lengthDescriptor = lengthHolder?.value as PropertyDescriptor | undefined;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > RULES_SOURCES_LIMITS.sources
  ) {
    return undefined;
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => typeof key !== "string")
  ) {
    return undefined;
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      !isProtocolOpaqueId(descriptor.value) ||
      seen.has(descriptor.value)
    ) {
      return undefined;
    }
    seen.add(descriptor.value);
    refs.push(descriptor.value);
  }
  return Object.freeze(refs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function readExactDataType(value: unknown): string | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
