import type { CssDocumentSource } from "./collectCssFacts.js";
import type { DomEvent, DomRequest } from "./domProtocol.js";
import type { LocationSource } from "./inspectPayload.js";
import {
  createInspectContentLeasePortName,
  isValidContentSessionId,
  parseInspectClearPseudoStatesRequest,
  parseInspectDisposeSessionRequest,
  parseInspectRepublishRequest,
  parseInspectorLocalRequest,
  type ContentSessionId,
  type ContentInspectPort,
  type InspectRepublishRequest,
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
  parseStylesEvent,
  type StylesEvent,
  type StylesRequest,
} from "./stylesProtocol.js";
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
  MAX_STYLESHEET_REFRESH_LINKS,
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
const CONTENT_STYLES_INVALIDATION_BARRIER_KEY = Symbol.for(
  "pin-op.contentStylesInvalidationBarrier",
);
const MAX_REFRESH_INVALIDATION_PUBLICATIONS =
  MAX_STYLESHEET_REFRESH_LINKS * 2 + 16;

interface StylesInvalidationPublication {
  readonly token: object;
  readonly sequence: number;
  readonly kind: "applicability" | "stylesheet";
  readonly stylesheetRevision: number;
  readonly accepted: Promise<boolean>;
}

interface StylesInvalidationSnapshot {
  readonly sequence: number;
  readonly stylesheetRevision: number | undefined;
  readonly publications: StylesInvalidationPublication[];
  overflowed: boolean;
}

interface ContentStylesInvalidationBarrier {
  readonly signal: AbortSignal;
  snapshot(): StylesInvalidationSnapshot;
  discard(snapshot: StylesInvalidationSnapshot): void;
  dispose(): void;
  commitStylesheetRefresh(): Promise<boolean>;
  settleAfter(
    snapshot: StylesInvalidationSnapshot,
    requireStylesheetAdvance: boolean,
    signal: AbortSignal,
  ): Promise<boolean>;
}

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
  readonly clearOverlay?: () =>
    | boolean
    | void
    | Promise<boolean | void>;
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
  handle(request: DomRequest | StylesRequest): Promise<unknown>;
  republishSelection(request: InspectRepublishRequest): Promise<boolean>;
  clearPseudoStates(): boolean;
  clearOverlayForRefresh?(): boolean | void;
  invalidateStylesheetsForRefresh?(): boolean;
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
  [CONTENT_STYLES_INVALIDATION_BARRIER_KEY]?: unknown;
};

type BrandedContentRefreshRuntime = ContentRefreshRuntime & {
  readonly [CONTENT_REFRESH_RUNTIME_BRAND]: true;
  readonly binding: ContentRefreshBinding;
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
  let stylesInvalidationPublication: StylesInvalidationPublication | undefined;
  let stylesInvalidationSequence = 0;
  const activeStylesInvalidationSnapshots =
    new Set<StylesInvalidationSnapshot>();
  const stylesInvalidationController = new AbortController();
  let activeStylesheetRefreshCommit:
    | { publication?: StylesInvalidationPublication }
    | undefined;
  let session!: ContentPageInspectionSession;
  const stylesInvalidationBarrier: ContentStylesInvalidationBarrier = {
    signal: stylesInvalidationController.signal,
    snapshot: () => {
      const snapshot: StylesInvalidationSnapshot = {
        sequence: stylesInvalidationSequence,
        stylesheetRevision: stylesInvalidationPublication?.stylesheetRevision,
        publications: [],
        overflowed: stylesInvalidationController.signal.aborted,
      };
      if (!snapshot.overflowed) {
        activeStylesInvalidationSnapshots.add(snapshot);
      }
      return snapshot;
    },
    discard: (snapshot) => {
      activeStylesInvalidationSnapshots.delete(snapshot);
    },
    dispose: () => {
      if (stylesInvalidationController.signal.aborted) return;
      stylesInvalidationController.abort();
      activeStylesheetRefreshCommit = undefined;
      for (const snapshot of activeStylesInvalidationSnapshots) {
        snapshot.overflowed = true;
      }
      activeStylesInvalidationSnapshots.clear();
    },
    commitStylesheetRefresh: () => {
      if (
        stylesInvalidationController.signal.aborted ||
        activeStylesheetRefreshCommit
      ) {
        return Promise.resolve(false);
      }
      const commit: { publication?: StylesInvalidationPublication } = {};
      activeStylesheetRefreshCommit = commit;
      let committed = false;
      try {
        committed = session.invalidateStylesheetsForRefresh?.() === true;
      } catch (error) {
        reportError(error);
      } finally {
        if (activeStylesheetRefreshCommit === commit) {
          activeStylesheetRefreshCommit = undefined;
        }
      }
      const publication = commit.publication;
      return committed && publication?.kind === "stylesheet"
        ? publication.accepted
        : Promise.resolve(false);
    },
    settleAfter: async (snapshot, requireStylesheetAdvance, signal) => {
      let observedPublicationCount = 0;
      let observedStylesheetAdvance = false;
      try {
        while (true) {
          await drainInvalidationPublications();
          if (
            signal.aborted ||
            stylesInvalidationController.signal.aborted ||
            snapshot.overflowed
          ) {
            return false;
          }
          while (observedPublicationCount < snapshot.publications.length) {
            const publication =
              snapshot.publications[observedPublicationCount];
            if (
              !publication ||
              !await awaitInvalidationAcceptance(
                publication.accepted,
                signal,
                stylesInvalidationController.signal,
              )
            ) {
              return false;
            }
            observedPublicationCount += 1;
            if (
              publication.kind === "stylesheet" &&
              (snapshot.stylesheetRevision === undefined ||
                publication.stylesheetRevision > snapshot.stylesheetRevision)
            ) {
              observedStylesheetAdvance = true;
            }
          }
          await drainInvalidationPublications();
          if (
            signal.aborted ||
            stylesInvalidationController.signal.aborted ||
            snapshot.overflowed
          ) {
            return false;
          }
          if (observedPublicationCount < snapshot.publications.length) continue;
          return !requireStylesheetAdvance || observedStylesheetAdvance;
        }
      } finally {
        activeStylesInvalidationSnapshots.delete(snapshot);
      }
    },
  };
  const createSession = options.createPageInspectionSession ??
    ((sessionOptions) => new PageInspectionSession(sessionOptions));
  let activeRepublishPublication:
    | { readonly token: string; accepted?: Promise<boolean> }
    | undefined;
  session = createSession({
    document: options.document as unknown as PageInspectionDocument,
    contentSessionId,
    location: options.location,
    onSelection: (selection) => {
      const publication = activeRepublishPublication;
      const accepted = publishSelection(
        options,
        contentSessionId,
        selection,
        publication?.token,
        reportError,
      );
      if (publication && activeRepublishPublication === publication) {
        publication.accepted = accepted;
      }
      return true;
    },
    onEvent: (event) =>
      publishDomEvent(options, contentSessionId, event, reportError),
    onStylesInvalidated: (event) => {
      const token = {};
      const publication: StylesInvalidationPublication = {
        token,
        sequence: stylesInvalidationSequence + 1,
        kind: event.kind,
        stylesheetRevision: event.stylesheetRevision,
        accepted: publishStylesEvent(
          options,
          contentSessionId,
          {
            type: "styles.invalidated",
            documentEpoch: event.documentEpoch,
            stylesRevision: event.stylesRevision,
            stylesheetRevision: event.stylesheetRevision,
            pseudoStateRevision: event.pseudoStateRevision,
            pseudoStates: event.pseudoStates,
          },
          reportError,
        ),
      };
      stylesInvalidationSequence = publication.sequence;
      stylesInvalidationPublication = publication;
      for (const snapshot of activeStylesInvalidationSnapshots) {
        if (
          snapshot.overflowed ||
          snapshot.publications.length >=
            MAX_REFRESH_INVALIDATION_PUBLICATIONS
        ) {
          snapshot.overflowed = true;
          continue;
        }
        snapshot.publications.push(publication);
      }
      if (
        activeStylesheetRefreshCommit &&
        publication.kind === "stylesheet" &&
        !activeStylesheetRefreshCommit.publication
      ) {
        activeStylesheetRefreshCommit.publication = publication;
      }
    },
    onStylesInspectPublicationRenewed: (event) => publishStylesEvent(
      options,
      contentSessionId,
      event,
      reportError,
    ),
    onError: reportError,
  });
  const awaitControlledCleanup = async (
    cleanup: () => boolean | void,
  ): Promise<boolean> => {
    const previousPublication = stylesInvalidationPublication?.token;
    const cleaned = cleanup();
    if (cleaned === false) return false;
    const publication = stylesInvalidationPublication;
    if (!publication || publication.token === previousPublication) return true;
    const acceptance = await awaitAbortableOperation(
      publication.accepted,
      stylesInvalidationController.signal,
    );
    return !acceptance.aborted && acceptance.value;
  };
  const clearOverlayForRefresh = (): Promise<boolean> =>
    awaitControlledCleanup(() => session.clearOverlayForRefresh?.());
  scope[CONTENT_OVERLAY_CLEAR_KEY] = clearOverlayForRefresh;
  scope[CONTENT_STYLES_INVALIDATION_BARRIER_KEY] = stylesInvalidationBarrier;
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
    const republishRequest = parseInspectRepublishRequest(message);
    if (republishRequest) {
      if (republishRequest.contentSessionId !== contentSessionId) return false;
      const publication: {
        readonly token: string;
        accepted?: Promise<boolean>;
      } = { token: republishRequest.republishToken };
      activeRepublishPublication = publication;
      let pending: Promise<boolean>;
      try {
        pending = session.republishSelection(republishRequest);
      } catch (error) {
        reportError(error);
        if (activeRepublishPublication === publication) {
          activeRepublishPublication = undefined;
        }
        return false;
      }
      return pending.then(async (republished) => {
          if (!republished || !publication.accepted) return false;
          return await publication.accepted;
        })
        .catch((error) => {
          reportError(error);
          return false;
        })
        .finally(() => {
          if (activeRepublishPublication === publication) {
            activeRepublishPublication = undefined;
          }
        });
    }
    const clearPseudoStates = parseInspectClearPseudoStatesRequest(message);
    if (clearPseudoStates) {
      if (clearPseudoStates.contentSessionId !== contentSessionId) return false;
      return awaitControlledCleanup(() => session.clearPseudoStates())
        .catch((error: unknown) => {
          reportError(error);
          return false;
        });
    }
    const disposeSession = parseInspectDisposeSessionRequest(message);
    if (disposeSession) {
      if (disposeSession.contentSessionId !== contentSessionId) return false;
      return awaitControlledCleanup(() => session.clearPseudoStates())
        .then((acknowledged) => {
          if (!acknowledged) return false;
          runtime.dispose();
          return true;
        })
        .catch((error: unknown) => {
          reportError(error);
          return false;
        });
    }
    const request = parseInspectorLocalRequest(message);
    return request ? session.handle(request) : undefined;
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
      stylesInvalidationBarrier.dispose();
      removeRuntimeMessages();
      const port = leasePort;
      leasePort = undefined;
      try {
        session.dispose();
      } catch (error) {
        reportError(error);
      }
      if (port) {
        port.onDisconnect.removeListener(onLeaseDisconnected);
        try {
          port.disconnect();
        } catch {
          // The background may already have released the content lease.
        }
      }
      if (scope[CONTENT_OVERLAY_CLEAR_KEY] === clearOverlayForRefresh) {
        delete scope[CONTENT_OVERLAY_CLEAR_KEY];
      }
      if (
        scope[CONTENT_STYLES_INVALIDATION_BARRIER_KEY] ===
          stylesInvalidationBarrier
      ) {
        delete scope[CONTENT_STYLES_INVALIDATION_BARRIER_KEY];
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
  if (!isTopView(options.view)) {
    throw new Error("Content refresh runtime requires the top frame");
  }
  const binding = createRefreshBinding(options);
  const existing = scope[CONTENT_REFRESH_RUNTIME_KEY];
  if (isContentRefreshRuntime(existing)) {
    if (sameRefreshBinding(existing.binding, binding)) {
      existing.republishReady();
      return existing;
    }
    existing.dispose();
  }
  const refreshStylesheets = options.refreshStylesheets ??
    refreshExternalStylesheets;
  const restoreScroll = options.restoreScroll ?? restoreTopScrollSnapshot;
  const now = options.now ?? Date.now;
  const clearOverlay = (): boolean | void | Promise<boolean | void> => {
    const candidate = options.clearOverlay ?? scope[CONTENT_OVERLAY_CLEAR_KEY];
    if (typeof candidate === "function") {
      return candidate();
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
          command.refreshCommandId,
          command.refreshGeneration,
          command.mode,
          refreshStylesheets,
          operation.controller.signal,
          clearOverlay,
          () => readStylesInvalidationBarrier(scope),
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
    binding,
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
  refreshCommandId: string,
  refreshGeneration: number,
  mode: "styles" | "reload",
  refreshStylesheets: NonNullable<ContentRefreshRuntimeOptions["refreshStylesheets"]>,
  signal: AbortSignal,
  clearOverlay: () => boolean | void | Promise<boolean | void>,
  getStylesInvalidationBarrier: () =>
    ContentStylesInvalidationBarrier | undefined,
  now: () => number,
  isActive: () => boolean,
  reportError: (error: unknown) => void,
): Promise<ContentRefreshResult | undefined> {
  if (!isActive()) return undefined;

  if (mode === "styles") {
    try {
      const beforeControlledTransition = onceControlledCleanup(clearOverlay);
      const controlledCleanup = await awaitAbortableOperation(
        beforeControlledTransition(),
        signal,
      );
      if (controlledCleanup.aborted || !isActive()) return undefined;
      if (controlledCleanup.value === false) {
        throw new Error("Stylesheet refresh cleanup was not acknowledged");
      }
      const initialStylesInvalidationBarrier = getStylesInvalidationBarrier();
      let stylesInvalidationBarrier = initialStylesInvalidationBarrier;
      let invalidationSnapshot = stylesInvalidationBarrier?.snapshot();
      try {
        let refreshCommitCount = 0;
        let refreshCommitBarrier: ContentStylesInvalidationBarrier | undefined;
        const refreshCommitAcknowledgements: Array<{
          readonly barrier: ContentStylesInvalidationBarrier;
          readonly acknowledgement: Promise<boolean>;
        }> = [];
        const stylesheet = await refreshStylesheets(
          options.document,
          refreshGeneration,
          {
            signal,
            beforeControlledTransition,
            onStylesheetsUpdated: () => {
              refreshCommitCount += 1;
              const currentBarrier = getStylesInvalidationBarrier();
              if (currentBarrier !== stylesInvalidationBarrier) {
                if (stylesInvalidationBarrier && invalidationSnapshot) {
                  stylesInvalidationBarrier.discard(invalidationSnapshot);
                }
                stylesInvalidationBarrier = currentBarrier;
                invalidationSnapshot = currentBarrier?.snapshot();
              }
              refreshCommitBarrier = currentBarrier;
              if (currentBarrier) {
                refreshCommitAcknowledgements.push(
                  {
                    barrier: currentBarrier,
                    acknowledgement:
                      currentBarrier.commitStylesheetRefresh(),
                  },
                );
              }
            },
          },
        );
        if (!isActive()) return undefined;
        const finalStylesInvalidationBarrier =
          getStylesInvalidationBarrier();
        const encounteredStylesAuthority = Boolean(
          initialStylesInvalidationBarrier ||
          refreshCommitBarrier ||
          finalStylesInvalidationBarrier,
        );
        const stableStylesAuthority = stylesheet.updated > 0
          ? finalStylesInvalidationBarrier === refreshCommitBarrier
          : finalStylesInvalidationBarrier ===
            initialStylesInvalidationBarrier;
        if (
          encounteredStylesAuthority &&
          (
            !stableStylesAuthority ||
            (stylesheet.updated > 0 &&
              (
                refreshCommitCount !== 1 ||
                !refreshCommitBarrier ||
                refreshCommitAcknowledgements.length !== 1
              )) ||
            (stylesheet.updated === 0 &&
              (
                refreshCommitCount !== 0 ||
                refreshCommitAcknowledgements.length !== 0
              ))
          )
        ) {
          throw new Error("Stylesheet refresh authority changed during commit");
        }
        const refreshCommitAccepted = await Promise.all(
          refreshCommitAcknowledgements.map((entry) =>
            awaitInvalidationAcceptance(
              entry.acknowledgement,
              signal,
              entry.barrier.signal,
            )
          ),
        );
        if (!isActive()) return undefined;
        if (
          !refreshCommitAccepted.every(Boolean) ||
          getStylesInvalidationBarrier() !== finalStylesInvalidationBarrier
        ) {
          throw new Error("Stylesheet refresh ownership was not accepted");
        }
        if (!isActive()) return undefined;
        const invalidationAccepted =
          stylesInvalidationBarrier && invalidationSnapshot
            ? await stylesInvalidationBarrier.settleAfter(
                invalidationSnapshot,
                false,
                signal,
              )
            : true;
        if (!isActive()) return undefined;
        if (
          !invalidationAccepted ||
          getStylesInvalidationBarrier() !== finalStylesInvalidationBarrier
        ) {
          throw new Error("Stylesheet refresh invalidation was not accepted");
        }
        return createRefreshResult(
          binding,
          refreshCommandId,
          refreshGeneration,
          mode,
          true,
          stylesheet,
        );
      } finally {
        if (stylesInvalidationBarrier && invalidationSnapshot) {
          stylesInvalidationBarrier.discard(invalidationSnapshot);
        }
      }
    } catch (error) {
      reportError(error);
      return createRefreshResult(
        binding,
        refreshCommandId,
        refreshGeneration,
        mode,
        false,
      );
    }
  }

  try {
    const controlledCleanup = await awaitAbortableOperation(
      Promise.resolve(clearOverlay()),
      signal,
    );
    if (controlledCleanup.aborted || !isActive()) return undefined;
    if (controlledCleanup.value === false) {
      throw new Error("Reload cleanup was not acknowledged");
    }
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
      refreshCommandId,
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
      response.refreshCommandId === refreshCommandId &&
      response.refreshGeneration === refreshGeneration &&
      response.accepted,
    );
    return createRefreshResult(
      binding,
      refreshCommandId,
      refreshGeneration,
      mode,
      accepted,
    );
  } catch (error) {
    reportError(error);
    return createRefreshResult(
      binding,
      refreshCommandId,
      refreshGeneration,
      mode,
      false,
    );
  }
}

function createRefreshResult(
  binding: ContentRefreshBinding,
  refreshCommandId: string,
  refreshGeneration: number,
  mode: "styles" | "reload",
  accepted: boolean,
  stylesheet?: StylesheetRefreshResult,
): ContentRefreshResult {
  const result = parseContentRefreshResult({
    type: "pin-op.refresh.content.result",
    ...binding,
    refreshCommandId,
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
  republishToken: string | undefined,
  reportError: (error: unknown) => void,
): Promise<boolean> {
  let publication: Promise<unknown>;
  try {
    publication = options.sendRuntimeMessage({
      type: "elementSelected",
      contentSessionId,
      documentEpoch: selection.documentEpoch,
      nodeRef: selection.nodeRef,
      ancestorPath: selection.ancestorPath,
      selectionRevision: selection.selectionRevision,
      ...(republishToken ? { republishToken } : {}),
      payload: selection.payload,
    });
  } catch (error) {
    reportError(error);
    return Promise.resolve(false);
  }
  return publication.then(
    (response) => isAcceptedBackgroundRoute(response),
    (error: unknown) => {
      reportError(error);
      return false;
    },
  );
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

function publishStylesEvent(
  options: ContentScriptRuntimeOptions,
  contentSessionId: ContentSessionId,
  event: StylesEvent,
  reportError: (error: unknown) => void,
): Promise<boolean> {
  let parsed: StylesEvent;
  try {
    parsed = parseStylesEvent(event);
  } catch {
    return Promise.resolve(false);
  }
  let publication: Promise<unknown>;
  try {
    publication = options.sendRuntimeMessage({
      type: "pin-op.styles.event",
      contentSessionId,
      event: parsed,
    });
  } catch (error) {
    reportError(error);
    return Promise.resolve(false);
  }
  return publication.then(
    (response) => isAcceptedBackgroundRoute(response),
    (error: unknown) => {
      reportError(error);
      return false;
    },
  );
}

function onceControlledCleanup(
  cleanup: () => boolean | void | Promise<boolean | void>,
): () => Promise<boolean | void> {
  let pending: Promise<boolean | void> | undefined;
  return () => {
    if (!pending) {
      try {
        pending = Promise.resolve(cleanup());
      } catch (error) {
        pending = Promise.reject(error);
      }
    }
    return pending;
  };
}

function readStylesInvalidationBarrier(
  scope: ContentRuntimeScope,
): ContentStylesInvalidationBarrier | undefined {
  const candidate = scope[CONTENT_STYLES_INVALIDATION_BARRIER_KEY];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as ContentStylesInvalidationBarrier).snapshot !== "function" ||
    typeof (candidate as ContentStylesInvalidationBarrier).discard !== "function" ||
    typeof (candidate as ContentStylesInvalidationBarrier).dispose !== "function" ||
    typeof (candidate as ContentStylesInvalidationBarrier)
      .commitStylesheetRefresh !== "function" ||
    typeof (candidate as ContentStylesInvalidationBarrier).settleAfter !== "function"
  ) {
    return undefined;
  }
  return candidate as ContentStylesInvalidationBarrier;
}

function drainInvalidationPublications(): Promise<void> {
  return new Promise((resolve) => globalThis.queueMicrotask(resolve));
}

function awaitAbortableOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<
  | { readonly aborted: true }
  | { readonly aborted: false; readonly value: T }
> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (completion: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      completion();
    };
    const onAbort = (): void => finish(() => resolve({ aborted: true }));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve({ aborted: false, value })),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function awaitInvalidationAcceptance(
  acceptance: Promise<boolean>,
  ...signals: readonly AbortSignal[]
): Promise<boolean> {
  const uniqueSignals = [...new Set(signals)];
  if (uniqueSignals.some((signal) => signal.aborted)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      for (const signal of uniqueSignals) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(accepted);
    };
    const onAbort = (): void => finish(false);
    for (const signal of uniqueSignals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void acceptance.then(finish, () => finish(false));
    if (uniqueSignals.some((signal) => signal.aborted)) finish(false);
  });
}

function isAcceptedBackgroundRoute(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    (value as { readonly ok?: unknown }).ok === true;
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
