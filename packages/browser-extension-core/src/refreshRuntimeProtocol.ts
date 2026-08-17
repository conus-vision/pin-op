import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  type PageRefreshMode,
} from "@pin-op/protocol";
import {
  parseTopScrollSnapshot,
  type TopScrollSnapshot,
} from "./topScrollRestoration.js";
import {
  MAX_STYLESHEET_REFRESH_LINKS,
  type StylesheetRefreshResult,
} from "./stylesheetRefresher.js";

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

export interface ContentRefreshBinding {
  readonly tabId: number;
  readonly frameId: 0;
  readonly pageUrl: string;
  readonly contentRuntimeId: string;
}

export interface ContentRefreshBootstrapRequest {
  readonly type: "pin-op.refresh.content.bootstrap";
  readonly pageUrl: string;
  readonly contentRuntimeId: string;
}

export interface ContentRefreshBootstrapResult extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.content.bootstrap.result";
  readonly accepted: boolean;
}

export interface ContentRefreshReadyRequest extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.content.ready";
}

export interface ContentRefreshCommand extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.content.execute";
  readonly refreshGeneration: number;
  readonly mode: PageRefreshMode;
}

export interface ReloadTabRequest extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.reload.request";
  readonly refreshGeneration: number;
  readonly snapshot: TopScrollSnapshot;
}

export interface ReloadTabResult extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.reload.result";
  readonly refreshGeneration: number;
  readonly accepted: boolean;
}

export interface ScrollRestoreCommand extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.scroll.restore";
  readonly refreshGeneration: number;
  readonly snapshot: TopScrollSnapshot;
}

export interface ContentRefreshResult extends ContentRefreshBinding {
  readonly type: "pin-op.refresh.content.result";
  readonly refreshGeneration: number;
  readonly mode: PageRefreshMode;
  readonly accepted: boolean;
  readonly stylesheet?: StylesheetRefreshResult;
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
const CONTENT_RUNTIME_ID_MAX_LENGTH = 128;

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
    !isGeneration(record.lastAcceptedGeneration) ||
    (record.participant && !record.autoRefreshEnabled)
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

export function parseContentRefreshReadyRequest(
  value: unknown,
): ContentRefreshReadyRequest | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
  ]);
  const binding = parseContentBinding(record);
  return record?.type === "pin-op.refresh.content.ready" && binding
    ? Object.freeze({ type: record.type, ...binding })
    : undefined;
}

export function parseContentRefreshBootstrapRequest(
  value: unknown,
): ContentRefreshBootstrapRequest | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "pageUrl",
    "contentRuntimeId",
  ]);
  const pageUrl = normalizedPageUrl(record?.pageUrl);
  return record?.type === "pin-op.refresh.content.bootstrap" &&
      pageUrl !== undefined &&
      pageUrl === record.pageUrl &&
      isContentRuntimeId(record.contentRuntimeId)
    ? Object.freeze({
        type: record.type,
        pageUrl,
        contentRuntimeId: record.contentRuntimeId,
      })
    : undefined;
}

export function parseContentRefreshBootstrapResult(
  value: unknown,
): ContentRefreshBootstrapResult | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "accepted",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
  ]);
  const binding = parseContentBinding(record);
  return record?.type === "pin-op.refresh.content.bootstrap.result" &&
      typeof record.accepted === "boolean" &&
      binding
    ? Object.freeze({
        type: record.type,
        accepted: record.accepted,
        ...binding,
      })
    : undefined;
}

export function parseContentRefreshCommand(
  value: unknown,
): ContentRefreshCommand | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
    "refreshGeneration",
    "mode",
  ]);
  const binding = parseContentBinding(record);
  return record?.type === "pin-op.refresh.content.execute" &&
      binding &&
      isGeneration(record.refreshGeneration) &&
      isRefreshMode(record.mode)
    ? Object.freeze({
      type: record.type,
      ...binding,
      refreshGeneration: record.refreshGeneration,
      mode: record.mode,
    })
    : undefined;
}

export function parseReloadTabRequest(
  value: unknown,
): ReloadTabRequest | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
    "refreshGeneration",
    "snapshot",
  ]);
  const binding = parseContentBinding(record);
  const snapshot = parseTopScrollSnapshot(record?.snapshot);
  return record?.type === "pin-op.refresh.reload.request" &&
      binding &&
      isGeneration(record.refreshGeneration) &&
      snapshotMatches(snapshot, binding, record.refreshGeneration)
    ? Object.freeze({
      type: record.type,
      ...binding,
      refreshGeneration: record.refreshGeneration,
      snapshot,
    })
    : undefined;
}

export function parseReloadTabResult(
  value: unknown,
): ReloadTabResult | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
    "refreshGeneration",
    "accepted",
  ]);
  const binding = parseContentBinding(record);
  return record?.type === "pin-op.refresh.reload.result" &&
      binding &&
      isGeneration(record.refreshGeneration) &&
      typeof record.accepted === "boolean"
    ? Object.freeze({
      type: record.type,
      ...binding,
      refreshGeneration: record.refreshGeneration,
      accepted: record.accepted,
    })
    : undefined;
}

export function parseScrollRestoreCommand(
  value: unknown,
): ScrollRestoreCommand | undefined {
  const record = snapshotExactRecord(value, [
    "type",
    "tabId",
    "frameId",
    "pageUrl",
    "contentRuntimeId",
    "refreshGeneration",
    "snapshot",
  ]);
  const binding = parseContentBinding(record);
  const snapshot = parseTopScrollSnapshot(record?.snapshot);
  return record?.type === "pin-op.refresh.scroll.restore" &&
      binding &&
      isGeneration(record.refreshGeneration) &&
      snapshotMatches(snapshot, binding, record.refreshGeneration)
    ? Object.freeze({
      type: record.type,
      ...binding,
      refreshGeneration: record.refreshGeneration,
      snapshot,
    })
    : undefined;
}

export function parseContentRefreshResult(
  value: unknown,
): ContentRefreshResult | undefined {
  const record = snapshotExactOptionalRecord(
    value,
    [
      "type",
      "tabId",
      "frameId",
      "pageUrl",
      "contentRuntimeId",
      "refreshGeneration",
      "mode",
      "accepted",
    ],
    "stylesheet",
  );
  const binding = parseContentBinding(record);
  const stylesheet = record?.stylesheet === undefined
    ? undefined
    : parseStylesheetResult(record.stylesheet);
  if (
    record?.type !== "pin-op.refresh.content.result" ||
    !binding ||
    !isGeneration(record.refreshGeneration) ||
    !isRefreshMode(record.mode) ||
    typeof record.accepted !== "boolean" ||
    (record.stylesheet !== undefined && !stylesheet) ||
    (stylesheet && (record.mode !== "styles" || !record.accepted))
  ) {
    return undefined;
  }
  return Object.freeze({
    type: record.type,
    ...binding,
    refreshGeneration: record.refreshGeneration,
    mode: record.mode,
    accepted: record.accepted,
    ...(stylesheet ? { stylesheet } : {}),
  });
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
    !isGeneration(record.lastAcceptedGeneration) ||
    (record.participant && !record.autoRefreshEnabled)
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

function parseContentBinding(
  record: Record<string, unknown> | undefined,
): ContentRefreshBinding | undefined {
  if (
    !record ||
    !isBrowserId(record.tabId) ||
    record.frameId !== 0 ||
    !isContentRuntimeId(record.contentRuntimeId)
  ) {
    return undefined;
  }
  const pageUrl = normalizedPageUrl(record.pageUrl);
  return pageUrl && pageUrl === record.pageUrl
    ? Object.freeze({
      tabId: record.tabId,
      frameId: 0,
      pageUrl,
      contentRuntimeId: record.contentRuntimeId,
    })
    : undefined;
}

function snapshotMatches(
  snapshot: TopScrollSnapshot | undefined,
  binding: ContentRefreshBinding,
  generation: unknown,
): snapshot is TopScrollSnapshot {
  return Boolean(
    snapshot &&
    snapshot.tabId === binding.tabId &&
    snapshot.url === binding.pageUrl &&
    snapshot.refreshGeneration === generation,
  );
}

function parseStylesheetResult(
  value: unknown,
): StylesheetRefreshResult | undefined {
  const record = snapshotExactRecord(value, ["attempted", "updated", "failed"]);
  if (
    !record ||
    !isBoundedCount(record.attempted) ||
    !isBoundedCount(record.updated) ||
    !isBoundedCount(record.failed) ||
    record.updated + record.failed !== record.attempted
  ) {
    return undefined;
  }
  return Object.freeze({
    attempted: record.attempted,
    updated: record.updated,
    failed: record.failed,
  });
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

function isContentRuntimeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= CONTENT_RUNTIME_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

function normalizedPageUrl(value: unknown): string | undefined {
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
      return undefined;
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_STYLESHEET_REFRESH_LINKS;
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
