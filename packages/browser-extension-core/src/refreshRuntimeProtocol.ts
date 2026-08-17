import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  type PageRefreshMode,
} from "@pin-op/protocol";

export interface PendingTabRefresh {
  readonly generation: number;
  readonly mode: PageRefreshMode;
}

export interface TabRefreshState {
  readonly tabId: number;
  readonly windowId: number;
  readonly autoRefreshEnabled: boolean;
  readonly ideHighlightEnabled: boolean;
  readonly participant: boolean;
  readonly lastAcceptedGeneration: number;
  readonly pending?: PendingTabRefresh;
}

export interface RefreshExecutionCommand {
  readonly type: "pin-op.refresh.execute";
  readonly refreshGeneration: number;
  readonly mode: PageRefreshMode;
}

export interface PanelTabSettingsCommand {
  readonly type: "pin-op.tab.settings";
  readonly autoRefreshEnabled: boolean;
  readonly ideHighlightEnabled: boolean;
}

export interface PanelTabStateMessage {
  readonly type: "pin-op.tab.state";
  readonly autoRefreshEnabled: boolean;
  readonly ideHighlightEnabled: boolean;
  readonly participant: boolean;
  readonly lastAcceptedGeneration: number;
  readonly pending?: PendingTabRefresh;
}

export type ProtocolCompatibilityMessage =
  | {
      readonly type: "pin-op.protocol.compatibility";
      readonly compatible: true;
      readonly browserProtocolVersion: typeof PROTOCOL_VERSION;
    }
  | {
      readonly type: "pin-op.protocol.compatibility";
      readonly compatible: false;
      readonly browserProtocolVersion: typeof PROTOCOL_VERSION;
      readonly peerProtocolVersion: number | "unknown";
    };

const TAB_STATE_REQUIRED_KEYS = [
  "tabId",
  "windowId",
  "autoRefreshEnabled",
  "ideHighlightEnabled",
  "participant",
  "lastAcceptedGeneration",
] as const;
const PANEL_STATE_REQUIRED_KEYS = [
  "type",
  "autoRefreshEnabled",
  "ideHighlightEnabled",
  "participant",
  "lastAcceptedGeneration",
] as const;
const MAX_PROTOCOL_VERSION = 0x7fffffff;

export function createDefaultTabRefreshState(
  tabId: number,
  windowId: number,
  lastAcceptedGeneration = 0,
): TabRefreshState {
  if (
    !isBrowserId(tabId) ||
    !isBrowserId(windowId) ||
    !isGeneration(lastAcceptedGeneration)
  ) {
    throw new TypeError("Invalid browser tab refresh identity");
  }
  return Object.freeze({
    tabId,
    windowId,
    autoRefreshEnabled: true,
    ideHighlightEnabled: true,
    participant: false,
    lastAcceptedGeneration,
  });
}

export function parseTabRefreshState(
  value: unknown,
): TabRefreshState | undefined {
  const record = snapshotExactOptionalRecord(
    value,
    TAB_STATE_REQUIRED_KEYS,
    "pending",
  );
  if (
    !record ||
    !isBrowserId(record.tabId) ||
    !isBrowserId(record.windowId) ||
    typeof record.autoRefreshEnabled !== "boolean" ||
    typeof record.ideHighlightEnabled !== "boolean" ||
    typeof record.participant !== "boolean" ||
    !isGeneration(record.lastAcceptedGeneration)
  ) {
    return undefined;
  }
  const pending = record.pending === undefined
    ? undefined
    : parsePendingTabRefresh(record.pending);
  if (
    (record.pending !== undefined && !pending) ||
    (pending &&
      (!record.autoRefreshEnabled ||
        !record.participant ||
        pending.generation !== record.lastAcceptedGeneration))
  ) {
    return undefined;
  }
  return freezeTabState({
    tabId: record.tabId,
    windowId: record.windowId,
    autoRefreshEnabled: record.autoRefreshEnabled,
    ideHighlightEnabled: record.ideHighlightEnabled,
    participant: record.participant,
    lastAcceptedGeneration: record.lastAcceptedGeneration,
    ...(pending ? { pending } : {}),
  });
}

export function parseRefreshExecutionCommand(
  value: unknown,
): RefreshExecutionCommand | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "refreshGeneration",
    "mode",
  ]);
  return record?.type === "pin-op.refresh.execute" &&
      isGeneration(record.refreshGeneration) &&
      isRefreshMode(record.mode)
    ? Object.freeze({
        type: record.type,
        refreshGeneration: record.refreshGeneration,
        mode: record.mode,
      })
    : undefined;
}

export function parsePanelTabSettingsCommand(
  value: unknown,
): PanelTabSettingsCommand | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "autoRefreshEnabled",
    "ideHighlightEnabled",
  ]);
  return record?.type === "pin-op.tab.settings" &&
      typeof record.autoRefreshEnabled === "boolean" &&
      typeof record.ideHighlightEnabled === "boolean"
    ? Object.freeze({
        type: record.type,
        autoRefreshEnabled: record.autoRefreshEnabled,
        ideHighlightEnabled: record.ideHighlightEnabled,
      })
    : undefined;
}

export function createPanelTabStateMessage(
  state: TabRefreshState,
): PanelTabStateMessage {
  const parsed = parseTabRefreshState(state);
  if (!parsed) {
    throw new TypeError("Invalid browser tab refresh state");
  }
  return freezePanelState({
    type: "pin-op.tab.state",
    autoRefreshEnabled: parsed.autoRefreshEnabled,
    ideHighlightEnabled: parsed.ideHighlightEnabled,
    participant: parsed.participant,
    lastAcceptedGeneration: parsed.lastAcceptedGeneration,
    ...(parsed.pending ? { pending: parsed.pending } : {}),
  });
}

export function parsePanelTabStateMessage(
  value: unknown,
): PanelTabStateMessage | undefined {
  const record = snapshotExactOptionalRecord(
    value,
    PANEL_STATE_REQUIRED_KEYS,
    "pending",
  );
  if (
    !record ||
    record.type !== "pin-op.tab.state" ||
    typeof record.autoRefreshEnabled !== "boolean" ||
    typeof record.ideHighlightEnabled !== "boolean" ||
    typeof record.participant !== "boolean" ||
    !isGeneration(record.lastAcceptedGeneration)
  ) {
    return undefined;
  }
  const pending = record.pending === undefined
    ? undefined
    : parsePendingTabRefresh(record.pending);
  if (
    (record.pending !== undefined && !pending) ||
    (pending &&
      (!record.autoRefreshEnabled ||
        !record.participant ||
        pending.generation !== record.lastAcceptedGeneration))
  ) {
    return undefined;
  }
  return freezePanelState({
    type: record.type,
    autoRefreshEnabled: record.autoRefreshEnabled,
    ideHighlightEnabled: record.ideHighlightEnabled,
    participant: record.participant,
    lastAcceptedGeneration: record.lastAcceptedGeneration,
    ...(pending ? { pending } : {}),
  });
}

export function parseProtocolCompatibilityMessage(
  value: unknown,
): ProtocolCompatibilityMessage | undefined {
  const compatible = snapshotExactRecord(value, [
    "type",
    "compatible",
    "browserProtocolVersion",
  ]);
  if (
    compatible?.type === "pin-op.protocol.compatibility" &&
    compatible.compatible === true &&
    compatible.browserProtocolVersion === PROTOCOL_VERSION
  ) {
    return Object.freeze({
      type: compatible.type,
      compatible: true,
      browserProtocolVersion: PROTOCOL_VERSION,
    });
  }

  const incompatible = snapshotExactRecord(value, [
    "type",
    "compatible",
    "browserProtocolVersion",
    "peerProtocolVersion",
  ]);
  if (
    incompatible?.type !== "pin-op.protocol.compatibility" ||
    incompatible.compatible !== false ||
    incompatible.browserProtocolVersion !== PROTOCOL_VERSION ||
    (incompatible.peerProtocolVersion !== "unknown" &&
      !isProtocolVersion(incompatible.peerProtocolVersion))
  ) {
    return undefined;
  }
  return Object.freeze({
    type: incompatible.type,
    compatible: false,
    browserProtocolVersion: PROTOCOL_VERSION,
    peerProtocolVersion: incompatible.peerProtocolVersion,
  });
}

function parsePendingTabRefresh(
  value: unknown,
): PendingTabRefresh | undefined {
  const record = snapshotExactRecord(value, ["generation", "mode"]);
  return record &&
      isGeneration(record.generation) &&
      isRefreshMode(record.mode)
    ? Object.freeze({ generation: record.generation, mode: record.mode })
    : undefined;
}

function freezeTabState(state: TabRefreshState): TabRefreshState {
  return Object.freeze({
    ...state,
    ...(state.pending ? { pending: Object.freeze({ ...state.pending }) } : {}),
  });
}

function freezePanelState(state: PanelTabStateMessage): PanelTabStateMessage {
  return Object.freeze({
    ...state,
    ...(state.pending ? { pending: Object.freeze({ ...state.pending }) } : {}),
  });
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= RESOLUTION_LIMITS.generation;
}

function isRefreshMode(value: unknown): value is PageRefreshMode {
  return value === "styles" || value === "reload";
}

function isProtocolVersion(value: unknown): value is number {
  return Number.isInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_PROTOCOL_VERSION;
}

function snapshotExactOptionalRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKey: string,
): Record<string, unknown> | undefined {
  const keys = ownDataKeys(value);
  if (
    !keys ||
    (keys.length !== requiredKeys.length &&
      keys.length !== requiredKeys.length + 1) ||
    requiredKeys.some((key) => !keys.includes(key)) ||
    (keys.length === requiredKeys.length + 1 && !keys.includes(optionalKey))
  ) {
    return undefined;
  }
  return snapshotDataRecord(value, keys);
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  const keys = ownDataKeys(value);
  return keys &&
      keys.length === expectedKeys.length &&
      expectedKeys.every((key) => keys.includes(key))
    ? snapshotDataRecord(value, expectedKeys)
    : undefined;
}

function ownDataKeys(value: unknown): readonly string[] | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => {
        if (typeof key !== "string") {
          return true;
        }
        const holder = Reflect.getOwnPropertyDescriptor(descriptors, key);
        const descriptor = holder?.value as PropertyDescriptor | undefined;
        return !descriptor || !Object.hasOwn(descriptor, "value");
      })
    ) {
      return undefined;
    }
    return keys as string[];
  } catch {
    return undefined;
  }
}

function snapshotDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
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
