import type { CssDocumentSource } from "./collectCssFacts.js";
import { parseDomRequest, type DomEvent, type DomRequest } from "./domProtocol.js";
import type { LocationSource } from "./inspectPayload.js";
import {
  createInspectContentLeasePortName,
  isValidContentSessionId,
  type ContentSessionId,
  type ContentInspectPort,
} from "./inspectPortProtocol.js";
import {
  type InspectDocument,
} from "./inspectMode.js";
import {
  PageInspectionSession,
  type PageInspectionDocument,
  type PageInspectionSelection,
  type PageInspectionSessionOptions,
} from "./pageInspectionSession.js";
import {
  parseContentRefreshBootstrapRequest,
  parseContentRefreshBootstrapResult,
  parseContentRefreshCommand,
  parseContentRefreshReadyRequest,
  parseContentRefreshResult,
  parseReloadTabRequest,
  parseReloadTabResult,
  parseScrollRestoreCommand,
  type ContentRefreshBinding,
  type ContentRefreshResult,
} from "./refreshRuntimeProtocol.js";
import {
  refreshExternalStylesheets,
  type StylesheetRefreshOptions,
  type StylesheetRefreshResult,
} from "./stylesheetRefresher.js";
import {
  captureTopScrollSnapshot,
  restoreTopScrollSnapshot,
  type TopScrollRestoration,
  type TopScrollRestoreHost,
  type TopScrollSnapshot,
} from "./topScrollRestoration.js";

const CONTENT_RUNTIME_KEY = Symbol.for("pin-op.contentScriptRuntime");
const CONTENT_RUNTIME_BRAND = Symbol.for("pin-op.contentScriptRuntime.brand");
const CONTENT_REFRESH_RUNTIME_KEY = Symbol.for("pin-op.contentRefreshRuntime");
const CONTENT_REFRESH_RUNTIME_BRAND = Symbol.for(
  "pin-op.contentRefreshRuntime.brand",
);
const CONTENT_REFRESH_BOOTSTRAP_KEY = Symbol.for(
  "pin-op.contentRefreshBootstrapRuntime",
);
const CONTENT_REFRESH_BOOTSTRAP_BRAND = Symbol.for(
  "pin-op.contentRefreshBootstrapRuntime.brand",
);
const CONTENT_OVERLAY_CLEAR_KEY = Symbol.for("pin-op.contentOverlayClear");

export type ContentScriptDocument = InspectDocument & {
  readonly styleSheets: CssDocumentSource["styleSheets"];
};

export interface ContentScriptRuntimeOptions {
  readonly globalScope: object;
  readonly document: ContentScriptDocument;
  readonly location: LocationSource;
  readonly connectRuntimePort: (name: string) => ContentInspectPort;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly subscribeRuntimeMessages: (
    listener: (message: unknown) => unknown,
  ) => () => void;
  readonly createPageInspectionSession?: (
    options: PageInspectionSessionOptions,
  ) => ContentPageInspectionSession;
  readonly createContentSessionId?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface ContentScriptRuntime {
  dispose(): void;
}

export interface ContentRefreshRuntimeOptions {
  readonly globalScope: object;
  readonly document: Document;
  readonly view: Window;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly contentRuntimeId: string;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly subscribeRuntimeMessages: (
    listener: (message: unknown) => unknown,
  ) => () => void;
  readonly clearOverlay?: () => void;
  readonly refreshStylesheets?: (
    document: Document,
    generation: number,
    options?: StylesheetRefreshOptions,
  ) => Promise<StylesheetRefreshResult>;
  readonly restoreScroll?: (
    snapshot: TopScrollSnapshot,
    host: TopScrollRestoreHost,
  ) => TopScrollRestoration;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface ContentRefreshRuntime {
  republishReady(): void;
  dispose(): void;
}

export interface ContentRefreshBootstrapRuntimeOptions {
  readonly globalScope: object;
  readonly document: Document;
  readonly view: Window;
  readonly location: { readonly href: string };
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly subscribeRuntimeMessages: (
    listener: (message: unknown) => unknown,
  ) => () => void;
  readonly createContentRuntimeId?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface ContentRefreshBootstrapRuntime {
  republish(): void;
  dispose(): void;
}

export interface ContentPageInspectionSession {
  enablePicker(): void;
  disablePicker(): void;
  handle(request: DomRequest): Promise<unknown>;
  republishSelection(): Promise<boolean>;
  clearOverlayForRefresh?(): void;
  dispose(): void;
}

type BrandedContentScriptRuntime = ContentScriptRuntime & {
  readonly [CONTENT_RUNTIME_BRAND]: true;
};

type ContentRuntimeScope = object & {
  [CONTENT_RUNTIME_KEY]?: unknown;
  [CONTENT_REFRESH_RUNTIME_KEY]?: unknown;
  [CONTENT_REFRESH_BOOTSTRAP_KEY]?: unknown;
  [CONTENT_OVERLAY_CLEAR_KEY]?: unknown;
};

type BrandedContentRefreshRuntime = ContentRefreshRuntime & {
  readonly [CONTENT_REFRESH_RUNTIME_BRAND]: true;
};

type BrandedContentRefreshBootstrapRuntime =
  ContentRefreshBootstrapRuntime & {
    readonly [CONTENT_REFRESH_BOOTSTRAP_BRAND]: true;
  };

export function startContentScriptRuntime(
  options: ContentScriptRuntimeOptions,
): ContentScriptRuntime {
  const scope = options.globalScope as ContentRuntimeScope;
  const existing = scope[CONTENT_RUNTIME_KEY];
  if (isContentScriptRuntime(existing)) {
    return existing;
  }

  const contentSessionId = createContentSessionId(options);
  const contentLeasePortName = createInspectContentLeasePortName(
    contentSessionId,
  );

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot break content-script ownership.
    }
  };
  const createSession = options.createPageInspectionSession ??
    ((sessionOptions) => new PageInspectionSession(sessionOptions));
  const session = createSession({
    document: options.document as unknown as PageInspectionDocument,
    location: options.location,
    onSelection: (selection) => {
      publishSelection(options, contentSessionId, selection, reportError);
      return true;
    },
    onEvent: (event) =>
      publishDomEvent(options, contentSessionId, event, reportError),
    onError: reportError,
  });
  const clearOverlayForRefresh = (): void => session.clearOverlayForRefresh?.();
  scope[CONTENT_OVERLAY_CLEAR_KEY] = clearOverlayForRefresh;
  let disposed = false;
  const removeRuntimeMessages = options.subscribeRuntimeMessages((message) => {
    if (disposed) {
      return undefined;
    }
    const enabled = parseInspectModeMessage(message);
    if (enabled !== undefined) {
      try {
        if (enabled) {
          session.enablePicker();
        } else {
          session.disablePicker();
        }
      } catch (error) {
        reportError(error);
      }
      return undefined;
    }
    if (isExactTypeMessage(message, "pin-op.inspect.republish")) {
      return session.republishSelection().catch((error) => {
        reportError(error);
        return false;
      });
    }
    if (isExactTypeMessage(message, "pin-op.inspect.disposeSession")) {
      runtime.dispose();
      return undefined;
    }
    try {
      return session.handle(parseDomRequest(message));
    } catch {
      return undefined;
    }
  });

  let leasePort: ContentInspectPort | undefined;
  const onLeaseDisconnected = (): void => runtime.dispose();

  const runtime: BrandedContentScriptRuntime = {
    [CONTENT_RUNTIME_BRAND]: true,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      removeRuntimeMessages();
      const port = leasePort;
      leasePort = undefined;
      if (port) {
        port.onDisconnect.removeListener(onLeaseDisconnected);
        try {
          port.disconnect();
        } catch {
          // The background may already have released the content lease.
        }
      }
      session.dispose();
      if (scope[CONTENT_OVERLAY_CLEAR_KEY] === clearOverlayForRefresh) {
        delete scope[CONTENT_OVERLAY_CLEAR_KEY];
      }
      if (scope[CONTENT_RUNTIME_KEY] === runtime) {
        delete scope[CONTENT_RUNTIME_KEY];
      }
    },
  };
  scope[CONTENT_RUNTIME_KEY] = runtime;
  try {
    leasePort = options.connectRuntimePort(contentLeasePortName);
    leasePort.onDisconnect.addListener(onLeaseDisconnected);
  } catch (error) {
    reportError(error);
    runtime.dispose();
  }
  return runtime;
}

export function startContentRefreshRuntime(
  options: ContentRefreshRuntimeOptions,
): ContentRefreshRuntime {
  const scope = options.globalScope as ContentRuntimeScope;
  const existing = scope[CONTENT_REFRESH_RUNTIME_KEY];
  if (isContentRefreshRuntime(existing)) {
    existing.republishReady();
    return existing;
  }
  if (!isTopView(options.view)) {
    throw new Error("Content refresh runtime requires the top frame");
  }
  const binding = createRefreshBinding(options);
  const refreshStylesheets = options.refreshStylesheets ??
    refreshExternalStylesheets;
  const restoreScroll = options.restoreScroll ?? restoreTopScrollSnapshot;
  const now = options.now ?? Date.now;
  const clearOverlay = (): void => {
    const candidate = options.clearOverlay ?? scope[CONTENT_OVERLAY_CLEAR_KEY];
    if (typeof candidate === "function") {
      candidate();
    }
  };
  let disposed = false;
  let restoration: TopScrollRestoration | undefined;
  let activeRefreshOperation: {
    readonly controller: AbortController;
  } | undefined;
  let commandTail = Promise.resolve();

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot change refresh ownership.
    }
  };
  const removeRuntimeMessages = options.subscribeRuntimeMessages((message) => {
    if (disposed) return undefined;
    const command = parseContentRefreshCommand(message);
    if (!command || !sameRefreshBinding(command, binding)) return undefined;
    activeRefreshOperation?.controller.abort();
    const operation = { controller: new AbortController() };
    activeRefreshOperation = operation;
    const execute = async (): Promise<ContentRefreshResult | undefined> => {
      if (
        disposed ||
        operation.controller.signal.aborted ||
        activeRefreshOperation !== operation
      ) {
        return undefined;
      }
      try {
        return await executeRefreshCommand(
          options,
          binding,
          command.refreshGeneration,
          command.mode,
          refreshStylesheets,
          operation.controller.signal,
          clearOverlay,
          now,
          () =>
            !disposed &&
            !operation.controller.signal.aborted &&
            activeRefreshOperation === operation,
          reportError,
        );
      } finally {
        if (activeRefreshOperation === operation) {
          activeRefreshOperation = undefined;
        }
      }
    };
    const result = commandTail.then(execute, execute);
    commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });

  const publishReady = (): void => {
    const ready = parseContentRefreshReadyRequest({
      type: "pin-op.refresh.content.ready",
      ...binding,
    });
    if (!ready) {
      reportError(new Error("Invalid content refresh binding"));
      return;
    }
    void options.sendRuntimeMessage(ready).then((response) => {
      if (disposed) return;
      const command = parseScrollRestoreCommand(response);
      if (!command || !sameRefreshBinding(command, binding)) return;
      try {
        restoration?.dispose();
        restoration = restoreScroll(command.snapshot, {
          document: options.document,
          view: options.view,
        });
      } catch (error) {
        reportError(error);
      }
    }).catch(reportError);
  };

  const runtime: BrandedContentRefreshRuntime = {
    [CONTENT_REFRESH_RUNTIME_BRAND]: true,
    republishReady: publishReady,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      activeRefreshOperation?.controller.abort();
      activeRefreshOperation = undefined;
      try {
        removeRuntimeMessages();
      } catch {
        // The host may already have removed the listener.
      }
      try {
        restoration?.dispose();
      } catch {
        // Scroll restoration is best-effort during teardown.
      }
      restoration = undefined;
      if (scope[CONTENT_REFRESH_RUNTIME_KEY] === runtime) {
        delete scope[CONTENT_REFRESH_RUNTIME_KEY];
      }
    },
  };
  scope[CONTENT_REFRESH_RUNTIME_KEY] = runtime;
  publishReady();

  return runtime;
}

export function startContentRefreshBootstrapRuntime(
  options: ContentRefreshBootstrapRuntimeOptions,
): ContentRefreshBootstrapRuntime {
  if (!isTopView(options.view)) {
    return Object.freeze({ republish(): void {}, dispose(): void {} });
  }
  const scope = options.globalScope as ContentRuntimeScope;
  const existing = scope[CONTENT_REFRESH_BOOTSTRAP_KEY];
  if (isContentRefreshBootstrapRuntime(existing)) {
    existing.republish();
    return existing;
  }

  const contentRuntimeId = createRefreshRuntimeId(options);
  let disposed = false;
  let publication = 0;
  let boundRuntime: ContentRefreshRuntime | undefined;
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot change content-runtime ownership.
    }
  };
  const republish = (): void => {
    if (disposed) return;
    const request = parseContentRefreshBootstrapRequest({
      type: "pin-op.refresh.content.bootstrap",
      pageUrl: options.location.href,
      contentRuntimeId,
    });
    if (!request) {
      reportError(new Error("Invalid content refresh bootstrap binding"));
      return;
    }
    publication += 1;
    const current = publication;
    void options.sendRuntimeMessage(request).then((response) => {
      if (disposed || publication !== current) return;
      const result = parseContentRefreshBootstrapResult(response);
      if (
        !result?.accepted ||
        result.pageUrl !== request.pageUrl ||
        result.contentRuntimeId !== contentRuntimeId
      ) {
        return;
      }
      boundRuntime = startContentRefreshRuntime({
        globalScope: options.globalScope,
        document: options.document,
        view: options.view,
        tabId: result.tabId,
        pageUrl: result.pageUrl,
        contentRuntimeId,
        sendRuntimeMessage: options.sendRuntimeMessage,
        subscribeRuntimeMessages: options.subscribeRuntimeMessages,
        onError: options.onError,
      });
    }).catch(reportError);
  };
  const runtime: BrandedContentRefreshBootstrapRuntime = {
    [CONTENT_REFRESH_BOOTSTRAP_BRAND]: true,
    republish,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      publication += 1;
      boundRuntime?.dispose();
      boundRuntime = undefined;
      if (scope[CONTENT_REFRESH_BOOTSTRAP_KEY] === runtime) {
        delete scope[CONTENT_REFRESH_BOOTSTRAP_KEY];
      }
    },
  };
  scope[CONTENT_REFRESH_BOOTSTRAP_KEY] = runtime;
  republish();
  return runtime;
}

async function executeRefreshCommand(
  options: ContentRefreshRuntimeOptions,
  binding: ContentRefreshBinding,
  refreshGeneration: number,
  mode: "styles" | "reload",
  refreshStylesheets: NonNullable<ContentRefreshRuntimeOptions["refreshStylesheets"]>,
  signal: AbortSignal,
  clearOverlay: () => void,
  now: () => number,
  isActive: () => boolean,
  reportError: (error: unknown) => void,
): Promise<ContentRefreshResult | undefined> {
  if (!isActive()) return undefined;
  try {
    clearOverlay();
  } catch (error) {
    reportError(error);
  }

  if (mode === "styles") {
    try {
      const stylesheet = await refreshStylesheets(
        options.document,
        refreshGeneration,
        { signal },
      );
      if (!isActive()) return undefined;
      return createRefreshResult(
        binding,
        refreshGeneration,
        mode,
        true,
        stylesheet,
      );
    } catch (error) {
      reportError(error);
      return createRefreshResult(binding, refreshGeneration, mode, false);
    }
  }

  try {
    const createdAt = now();
    const snapshot = captureTopScrollSnapshot({
      tabId: binding.tabId,
      url: binding.pageUrl,
      refreshGeneration,
      scrollX: readScrollCoordinate(options.view, "scrollX"),
      scrollY: readScrollCoordinate(options.view, "scrollY"),
      createdAt,
    });
    const request = parseReloadTabRequest({
      type: "pin-op.refresh.reload.request",
      ...binding,
      refreshGeneration,
      snapshot,
    });
    if (!request) throw new Error("Invalid reload request");
    if (!isActive()) return undefined;
    const response = parseReloadTabResult(
      await options.sendRuntimeMessage(request),
    );
    if (!isActive()) return undefined;
    const accepted = Boolean(
      response &&
      sameRefreshBinding(response, binding) &&
      response.refreshGeneration === refreshGeneration &&
      response.accepted,
    );
    return createRefreshResult(
      binding,
      refreshGeneration,
      mode,
      accepted,
    );
  } catch (error) {
    reportError(error);
    return createRefreshResult(binding, refreshGeneration, mode, false);
  }
}

function createRefreshResult(
  binding: ContentRefreshBinding,
  refreshGeneration: number,
  mode: "styles" | "reload",
  accepted: boolean,
  stylesheet?: StylesheetRefreshResult,
): ContentRefreshResult {
  const result = parseContentRefreshResult({
    type: "pin-op.refresh.content.result",
    ...binding,
    refreshGeneration,
    mode,
    accepted,
    ...(stylesheet ? { stylesheet } : {}),
  });
  if (!result) throw new Error("Invalid content refresh result");
  return result;
}

function createRefreshBinding(
  options: ContentRefreshRuntimeOptions,
): ContentRefreshBinding {
  const ready = parseContentRefreshReadyRequest({
    type: "pin-op.refresh.content.ready",
    tabId: options.tabId,
    frameId: 0,
    pageUrl: options.pageUrl,
    contentRuntimeId: options.contentRuntimeId,
  });
  if (!ready) throw new TypeError("Invalid content refresh binding");
  return Object.freeze({
    tabId: ready.tabId,
    frameId: ready.frameId,
    pageUrl: ready.pageUrl,
    contentRuntimeId: ready.contentRuntimeId,
  });
}

function sameRefreshBinding(
  value: ContentRefreshBinding,
  expected: ContentRefreshBinding,
): boolean {
  return value.tabId === expected.tabId &&
    value.frameId === 0 &&
    value.pageUrl === expected.pageUrl &&
    value.contentRuntimeId === expected.contentRuntimeId;
}

function readScrollCoordinate(
  view: Window,
  key: "scrollX" | "scrollY",
): number {
  try {
    const value = view[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function isTopView(view: Window): boolean {
  try {
    return view.top === view;
  } catch {
    return false;
  }
}

function publishSelection(
  options: ContentScriptRuntimeOptions,
  contentSessionId: ContentSessionId,
  selection: PageInspectionSelection,
  reportError: (error: unknown) => void,
): void {
  void options.sendRuntimeMessage({
    type: "elementSelected",
    contentSessionId,
    selectionRevision: selection.selectionRevision,
    payload: selection.payload,
  }).catch(reportError);
}

function publishDomEvent(
  options: ContentScriptRuntimeOptions,
  contentSessionId: ContentSessionId,
  event: DomEvent,
  reportError: (error: unknown) => void,
): void {
  void options.sendRuntimeMessage({
    type: "pin-op.dom.event",
    contentSessionId,
    event,
  }).catch(reportError);
}

function parseInspectModeMessage(value: unknown): boolean | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return undefined;
  }
  if (value.type === "enableInspectMode") {
    return true;
  }
  if (value.type === "disableInspectMode") {
    return false;
  }
  return undefined;
}

function isContentScriptRuntime(
  value: unknown,
): value is BrandedContentScriptRuntime {
  return (
    Boolean(value && typeof value === "object") &&
    (value as Partial<BrandedContentScriptRuntime>)[CONTENT_RUNTIME_BRAND] === true &&
    typeof (value as Partial<BrandedContentScriptRuntime>).dispose === "function"
  );
}

function isContentRefreshRuntime(
  value: unknown,
): value is BrandedContentRefreshRuntime {
  return (
    Boolean(value && typeof value === "object") &&
    (value as Partial<BrandedContentRefreshRuntime>)[CONTENT_REFRESH_RUNTIME_BRAND] === true &&
    typeof (value as Partial<BrandedContentRefreshRuntime>).dispose === "function"
  );
}

function isContentRefreshBootstrapRuntime(
  value: unknown,
): value is BrandedContentRefreshBootstrapRuntime {
  return Boolean(value && typeof value === "object") &&
    (value as Partial<BrandedContentRefreshBootstrapRuntime>)[
      CONTENT_REFRESH_BOOTSTRAP_BRAND
    ] === true &&
    typeof (value as Partial<BrandedContentRefreshBootstrapRuntime>).republish ===
      "function" &&
    typeof (value as Partial<BrandedContentRefreshBootstrapRuntime>).dispose ===
      "function";
}

let refreshRuntimeSequence = 0;

function createRefreshRuntimeId(
  options: ContentRefreshBootstrapRuntimeOptions,
): string {
  let value: unknown;
  try {
    value = options.createContentRuntimeId?.() ?? globalThis.crypto?.randomUUID?.();
  } catch {
    value = undefined;
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    return value;
  }
  refreshRuntimeSequence += 1;
  return `refresh-${Date.now().toString(36)}-${refreshRuntimeSequence.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isExactTypeMessage(value: unknown, type: string): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    value.type === type;
}

function createContentSessionId(
  options: ContentScriptRuntimeOptions,
): ContentSessionId {
  const value = options.createContentSessionId?.() ?? defaultContentSessionId();
  if (!isValidContentSessionId(value)) {
    throw new Error("Content session ID generator returned an invalid value");
  }
  return value;
}

let contentSessionSequence = 0;

function defaultContentSessionId(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") {
      return randomUuid.call(globalThis.crypto);
    }
  } catch {
    // Use a process-local fallback when extension crypto is unavailable.
  }
  contentSessionSequence += 1;
  return `content-${Date.now().toString(36)}-${contentSessionSequence.toString(36)}`;
}
