import { RESOLUTION_LIMITS } from "@pin-op/protocol";

export const TOP_SCROLL_SNAPSHOT_TTL_MS = 30_000;
export const TOP_SCROLL_RESTORE_DELAY_MS = 250;
export const MAX_TOP_SCROLL_COORDINATE = 10_000_000;

export interface TopScrollSnapshot {
  readonly tabId: number;
  readonly url: string;
  readonly refreshGeneration: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly createdAt: number;
}

export interface TopScrollCaptureInput {
  readonly tabId: number;
  readonly url: string;
  readonly refreshGeneration: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly createdAt: number;
}

export interface TopScrollSnapshotClaim {
  readonly tabId: number;
  readonly url: string;
  readonly refreshGeneration: number;
  readonly now: number;
}

export interface TopScrollSnapshotStorage {
  read(tabId: number): Promise<unknown>;
  write(snapshot: TopScrollSnapshot): Promise<void>;
  remove(tabId: number): Promise<void>;
}

export interface TopScrollRestoreHost {
  readonly document: Document;
  readonly view: Window;
}

export interface TopScrollRestoration {
  dispose(): void;
}

interface TopScrollRestorationOptions {
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

const SNAPSHOT_KEYS = [
  "tabId",
  "url",
  "refreshGeneration",
  "scrollX",
  "scrollY",
  "createdAt",
] as const;

export function captureTopScrollSnapshot(
  input: TopScrollCaptureInput,
): TopScrollSnapshot {
  if (!input || typeof input !== "object") {
    throw new TypeError("Scroll snapshot input is required");
  }
  return freezeSnapshot({
    tabId: requireBrowserId(input.tabId),
    url: normalizePageUrl(input.url),
    refreshGeneration: requireGeneration(input.refreshGeneration),
    scrollX: captureCoordinate(input.scrollX),
    scrollY: captureCoordinate(input.scrollY),
    createdAt: requireTimestamp(input.createdAt),
  });
}

export function parseTopScrollSnapshot(
  value: unknown,
): TopScrollSnapshot | undefined {
  const record = snapshotExactRecord(value, SNAPSHOT_KEYS);
  if (!record) return undefined;
  try {
    const url = normalizePageUrl(record.url);
    if (url !== record.url) return undefined;
    return freezeSnapshot({
      tabId: requireBrowserId(record.tabId),
      url,
      refreshGeneration: requireGeneration(record.refreshGeneration),
      scrollX: requireStoredCoordinate(record.scrollX),
      scrollY: requireStoredCoordinate(record.scrollY),
      createdAt: requireTimestamp(record.createdAt),
    });
  } catch {
    return undefined;
  }
}

export class TopScrollSnapshotLeaseStore {
  private tail = Promise.resolve();

  public constructor(private readonly storage: TopScrollSnapshotStorage) {}

  public persist(value: TopScrollSnapshot): Promise<void> {
    const snapshot = parseTopScrollSnapshot(value);
    if (!snapshot) {
      return Promise.reject(new TypeError("Invalid top scroll snapshot"));
    }
    return this.enqueue(async () => {
      await this.storage.write(snapshot);
    });
  }

  public claim(input: TopScrollSnapshotClaim): Promise<TopScrollSnapshot | undefined> {
    return this.enqueue(async () => {
      const binding = parseClaim(input);
      if (!binding) return undefined;
      const stored = await this.storage.read(binding.tabId);
      if (stored === undefined) return undefined;
      const snapshot = parseTopScrollSnapshot(stored);
      await this.storage.remove(binding.tabId);
      if (
        !snapshot ||
        snapshot.tabId !== binding.tabId ||
        snapshot.url !== binding.url ||
        snapshot.refreshGeneration !== binding.refreshGeneration ||
        snapshot.createdAt > binding.now ||
        binding.now - snapshot.createdAt > TOP_SCROLL_SNAPSHOT_TTL_MS
      ) {
        return undefined;
      }
      return snapshot;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function restoreTopScrollSnapshot(
  value: TopScrollSnapshot,
  host: TopScrollRestoreHost,
  options: TopScrollRestorationOptions = {},
): TopScrollRestoration {
  const snapshot = parseTopScrollSnapshot(value);
  if (!snapshot) throw new TypeError("Invalid top scroll snapshot");
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  let disposed = false;
  let domAttempted = false;
  let loadAttempted = false;
  let delayedAttempted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const removeDomListener = (): void => {
    try {
      host.document.removeEventListener("DOMContentLoaded", onDomContentLoaded);
    } catch {
      // A hostile document cannot retain restoration authority.
    }
  };
  const removeLoadListener = (): void => {
    try {
      host.view.removeEventListener("load", onLoad);
    } catch {
      // A hostile window cannot retain restoration authority.
    }
  };
  const attempt = (): void => {
    if (disposed || !isTopView(host.view)) return;
    try {
      const bounds = readScrollBounds(host.document);
      host.view.scrollTo(
        Math.min(snapshot.scrollX, bounds.x),
        Math.min(snapshot.scrollY, bounds.y),
      );
    } catch {
      // Later lifecycle attempts may succeed after page initialization.
    }
  };
  const runDomAttempt = (): void => {
    if (disposed || domAttempted) return;
    domAttempted = true;
    removeDomListener();
    attempt();
  };
  const runLoadAttempt = (): void => {
    if (disposed || loadAttempted) return;
    runDomAttempt();
    loadAttempted = true;
    removeLoadListener();
    attempt();
    try {
      timer = schedule(() => {
        timer = undefined;
        if (disposed || delayedAttempted) return;
        delayedAttempted = true;
        attempt();
        dispose();
      }, TOP_SCROLL_RESTORE_DELAY_MS);
    } catch {
      delayedAttempted = true;
      dispose();
    }
  };
  const onDomContentLoaded: EventListener = () => runDomAttempt();
  const onLoad: EventListener = () => runLoadAttempt();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeDomListener();
    removeLoadListener();
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };
  const restoration = Object.freeze({ dispose });

  if (!isTopView(host.view)) {
    dispose();
    return restoration;
  }
  try {
    host.document.addEventListener("DOMContentLoaded", onDomContentLoaded);
  } catch {
    runDomAttempt();
  }
  try {
    host.view.addEventListener("load", onLoad);
  } catch {
    runLoadAttempt();
  }

  const readyState = readReadyState(host.document);
  if (readyState === "interactive" || readyState === "complete") {
    runDomAttempt();
  }
  if (readyState === "complete") {
    runLoadAttempt();
  }
  return restoration;
}

function parseClaim(value: unknown): TopScrollSnapshotClaim | undefined {
  const record = snapshotExactRecord(value, [
    "tabId",
    "url",
    "refreshGeneration",
    "now",
  ]);
  if (!record) return undefined;
  try {
    return Object.freeze({
      tabId: requireBrowserId(record.tabId),
      url: normalizePageUrl(record.url),
      refreshGeneration: requireGeneration(record.refreshGeneration),
      now: requireTimestamp(record.now),
    });
  } catch {
    return undefined;
  }
}

function freezeSnapshot(value: TopScrollSnapshot): TopScrollSnapshot {
  return Object.freeze({ ...value });
}

function normalizePageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new TypeError("Invalid page URL");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Unsupported page URL");
  }
  if (url.username || url.password) {
    throw new TypeError("Credentialed page URLs are unsupported");
  }
  return url.href;
}

function captureCoordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Scroll coordinate must be finite");
  }
  return Math.min(Math.max(value, 0), MAX_TOP_SCROLL_COORDINATE);
}

function requireStoredCoordinate(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TOP_SCROLL_COORDINATE
  ) {
    throw new TypeError("Invalid stored scroll coordinate");
  }
  return value;
}

function requireBrowserId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Invalid browser tab ID");
  }
  return Number(value);
}

function requireGeneration(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > RESOLUTION_LIMITS.generation
  ) {
    throw new TypeError("Invalid refresh generation");
  }
  return Number(value);
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Invalid snapshot timestamp");
  }
  return Number(value);
}

function readReadyState(document: Document): DocumentReadyState | undefined {
  try {
    const value = document.readyState;
    return value === "loading" || value === "interactive" || value === "complete"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isTopView(view: Window): boolean {
  try {
    return view.top === view;
  } catch {
    return false;
  }
}

function readScrollBounds(document: Document): { readonly x: number; readonly y: number } {
  const root = readDimensions(document.documentElement);
  const body = readDimensions(document.body);
  return Object.freeze({
    x: Math.min(
      Math.max(
        Math.max(root.scrollWidth, body.scrollWidth) - Math.max(root.clientWidth, body.clientWidth),
        0,
      ),
      MAX_TOP_SCROLL_COORDINATE,
    ),
    y: Math.min(
      Math.max(
        Math.max(root.scrollHeight, body.scrollHeight) - Math.max(root.clientHeight, body.clientHeight),
        0,
      ),
      MAX_TOP_SCROLL_COORDINATE,
    ),
  });
}

function readDimensions(value: Element | null): {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
} {
  if (!value) {
    return { scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0 };
  }
  try {
    return {
      scrollWidth: dimension(value.scrollWidth),
      scrollHeight: dimension(value.scrollHeight),
      clientWidth: dimension(value.clientWidth),
      clientHeight: dimension(value.clientHeight),
    };
  } catch {
    return { scrollWidth: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0 };
  }
}

function dimension(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TOP_SCROLL_COORDINATE)
    : 0;
}

function snapshotExactRecord(
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
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return undefined;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const holder = Reflect.getOwnPropertyDescriptor(descriptors, key);
      const descriptor = holder?.value as PropertyDescriptor | undefined;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
