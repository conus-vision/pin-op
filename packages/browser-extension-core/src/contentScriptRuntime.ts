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

const CONTENT_RUNTIME_KEY = Symbol.for("browser2ide.contentScriptRuntime");
const CONTENT_RUNTIME_BRAND = Symbol.for("browser2ide.contentScriptRuntime.brand");

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

export interface ContentPageInspectionSession {
  enablePicker(): void;
  disablePicker(): void;
  handle(request: DomRequest): Promise<unknown>;
  republishSelection(): Promise<boolean>;
  dispose(): void;
}

type BrandedContentScriptRuntime = ContentScriptRuntime & {
  readonly [CONTENT_RUNTIME_BRAND]: true;
};

type ContentRuntimeScope = object & {
  [CONTENT_RUNTIME_KEY]?: unknown;
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
    if (isExactTypeMessage(message, "browser2ide.inspect.republish")) {
      return session.republishSelection().catch((error) => {
        reportError(error);
        return false;
      });
    }
    if (isExactTypeMessage(message, "browser2ide.inspect.disposeSession")) {
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

function publishSelection(
  options: ContentScriptRuntimeOptions,
  contentSessionId: ContentSessionId,
  selection: PageInspectionSelection,
  reportError: (error: unknown) => void,
): void {
  void options.sendRuntimeMessage({
    type: "elementSelected",
    contentSessionId,
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
    type: "browser2ide.dom.event",
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
