import {
  PeerStateMessageSchema,
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
} from "@pin-op/protocol";
import {
  createPanelIcons,
  PanelController,
  type PanelCommand,
} from "./panelController.js";
import { DomTreeController } from "./domTreeController.js";
import { DomTreeRecoveryCoordinator } from "./domTreeRecoveryCoordinator.js";
import {
  isSelectionRevision,
  parseDomEvent,
} from "./domProtocol.js";
import { DomTreeView, type DomTreeDocument } from "./domTreeView.js";
import { PanelInspectController } from "./panelInspectController.js";
import { PanelDiagnostics } from "./panelDiagnostics.js";
import { PanelInspectTransport } from "./panelInspectTransport.js";
import type { PanelInspectStartedState } from "./panelSessionTransport.js";
import { DomPanelView, type PanelDocument } from "./panelView.js";
import { ResolutionPresenter } from "./resolutionPresenter.js";
import { SourceNavigationController } from "./sourceNavigationController.js";
import {
  createDevtoolsPanelPortName,
  isValidDevtoolsChannel,
  parseInspectPortInvalidated,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";

export interface PanelRuntimeOptions {
  readonly locationSearch: string;
  readonly document: PanelDocument & DomTreeDocument;
  readonly connectRuntimePort: (name: string) => PanelInspectPort;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly readClipboard: () => Promise<string>;
  readonly subscribeUnload: (listener: () => void) => () => void;
  readonly diagnostics?: PanelDiagnostics;
  readonly initializeIcons?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface PanelRuntime {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  dispose(): void;
}

export function startPanelRuntime(options: PanelRuntimeOptions): PanelRuntime {
  const channel = new URLSearchParams(options.locationSearch).get("channel") ?? "";
  if (!isValidDevtoolsChannel(channel)) {
    throw new Error("Invalid DevTools panel channel");
  }
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot break panel ownership.
    }
  };
  const diagnostics = options.diagnostics ?? new PanelDiagnostics();
  const view = new DomPanelView(options.document, reportError);
  const resolutionPresenter = new ResolutionPresenter();
  view.renderResolution(resolutionPresenter.snapshot());
  const stateListeners = new Set<(message: unknown) => void | Promise<void>>();
  let disposed = false;
  let recovery: Promise<void> | undefined;
  let removeUnload: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  let controller: PanelController;
  let treeController: DomTreeController;
  let treeSessionActive = false;
  let domRecoveryStatusGeneration = 0;
  let acceptedSelectionRevision: number | undefined;
  let activeInspectSelectionRevision: number | undefined;

  const inspectTransport = new PanelInspectTransport(
    () => options.connectRuntimePort(createDevtoolsPanelPortName(channel)),
    () => {
      deactivateTreeSession();
      void controller.handleTransportDisconnect().catch(reportError);
      void ensurePanelPort();
    },
    (message) => routePanelMessage(message),
  );
  const sourceNavigationController = new SourceNavigationController(
    (message) => inspectTransport.dispatchSourceNavigation(message),
  );
  const removeSourceNavigationBindings =
    view.bindSourceNavigation(sourceNavigationController);
  treeController = new DomTreeController({
    transport: {
      request: (request) => inspectTransport.requestDom(request),
      dispatch: (request) => inspectTransport.dispatchDom(request),
      cancelPending: (reason) => inspectTransport.cancelDomRequests(reason),
    },
    onError: reportError,
  });
  const recoveryCoordinator = new DomTreeRecoveryCoordinator({
    controller: treeController,
    transport: {
      request: (request) => inspectTransport.requestDom(request),
    },
  });
  const treeView = new DomTreeView({
    document: options.document,
    controller: treeController,
    sourceNavigationController,
    onError: reportError,
  });
  const inspectController = new PanelInspectController((message) =>
    inspectTransport.send(message),
  );
  controller = new PanelController({
    channel,
    view,
    inspectController,
    readClipboard: options.readClipboard,
    sendCommand: sendPanelCommand,
    subscribeWindowState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    clearLinkedState: clearLinkedInspectionState,
  });

  function ensurePanelPort(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (recovery) {
      return recovery;
    }
    const pending = options
      .sendRuntimeMessage({
        type: "pin-op.panelReady",
        channel,
      })
      .then(() => {
        if (!disposed) {
          inspectTransport.connect();
        }
      })
      .catch(async (error) => {
        reportError(error);
        await controller.handleTransportDisconnect();
      });
    let tracked: Promise<void>;
    tracked = pending.finally(() => {
      if (recovery === tracked) {
        recovery = undefined;
      }
    });
    recovery = tracked;
    return tracked;
  }

  function routePanelMessage(message: unknown): void {
    const inspectStarted = validatedInspectStarted(message);
    const domEvent = validatedDomEvent(message);
    if (inspectStarted) {
      if (
        acceptedSelectionRevision !== undefined &&
        inspectStarted.selectionRevision < acceptedSelectionRevision
      ) {
        return;
      }
      acceptedSelectionRevision = inspectStarted.selectionRevision;
      activeInspectSelectionRevision = inspectStarted.selectionRevision;
      sourceNavigationController.beginInspect(inspectStarted.inspectMessageId);
      const model = resolutionPresenter.beginCorrelatedInspect(
        inspectStarted.inspectMessageId,
      );
      if (model) {
        diagnostics.recordResolving();
        view.renderResolution(model);
      }
    } else if (domEvent) {
      if (domEvent.type === "dom.selectionChanged") {
        if (
          acceptedSelectionRevision !== undefined &&
          domEvent.selectionRevision < acceptedSelectionRevision
        ) {
          return;
        }
        domRecoveryStatusGeneration += 1;
        recoveryCoordinator.handleManualSelection(domEvent);
        if (
          acceptedSelectionRevision === undefined ||
          domEvent.selectionRevision > acceptedSelectionRevision
        ) {
          acceptedSelectionRevision = domEvent.selectionRevision;
          activeInspectSelectionRevision = undefined;
          sourceNavigationController.invalidate();
        } else if (
          activeInspectSelectionRevision !== domEvent.selectionRevision
        ) {
          sourceNavigationController.invalidate();
        }
      }
      treeController.handleEvent(domEvent);
      if (domEvent.type === "dom.selectionChanged") {
        const selected = domEvent.ancestorPath.at(-1);
        if (selected) {
          const model = resolutionPresenter.updateSelectedElement(
            selected.label,
          );
          view.renderResolution(model);
        }
      }
    } else if (validatedResolution(message)) {
      const resolution = ResolutionMessageSchema.parse(message);
      const model = resolutionPresenter.acceptResolution(resolution);
      if (model) {
        sourceNavigationController.acceptResolution(resolution);
        diagnostics.recordResolution(resolution);
        view.renderResolution(model);
      }
    } else if (validatedSourceNavigationState(message)) {
      sourceNavigationController.acceptState(
        SourceNavigationStateMessageSchema.parse(message),
      );
    } else if (validatedPeerState(message)) {
      const peer = PeerStateMessageSchema.parse(message);
      if (!peer.connected) {
        sourceNavigationController.invalidate();
      }
      const model = peer.connected
        ? resolutionPresenter.restartResolution()
        : resolutionPresenter.ideDisconnected();
      if (model) {
        if (model.kind === "resolving") {
          diagnostics.recordResolving();
        } else if (model.kind === "ide-disconnected") {
          diagnostics.recordIdeDisconnected();
        } else if (model.kind === "idle") {
          diagnostics.clearResolution();
        }
        view.renderResolution(model);
      }
    } else if (isIdeDisconnected(message)) {
      const model = resolutionPresenter.ideDisconnected(
        message.inspectMessageId,
      );
      if (model) {
        sourceNavigationController.invalidate();
        diagnostics.recordIdeDisconnected();
        view.renderResolution(model);
      }
    } else if (
      isWindowState(message, "linked") ||
      isWindowState(message, "offline") ||
      isWindowState(message, "reconnecting")
    ) {
      if (!isWindowState(message, "linked")) {
        sourceNavigationController.invalidate();
      }
      treeSessionActive = true;
      void treeController.loadRoot();
    } else if (parseInspectPortInvalidated(message)) {
      const shouldRecover = treeSessionActive;
      resetSelectionOwnership();
      sourceNavigationController.invalidate();
      if (shouldRecover) {
        const statusGeneration = ++domRecoveryStatusGeneration;
        resetResolutionState("restoring");
        void recoveryCoordinator.begin()
          .then(() => finishRecoveryStatus(statusGeneration))
          .catch((error) => {
            reportError(error);
            finishRecoveryStatus(statusGeneration);
          });
      } else {
        recoveryCoordinator.cancel("Inactive DOM session invalidated");
        treeController.reset();
        resetResolutionState();
      }
    } else if (
      isWindowState(message, "notLinked") ||
      isWindowState(message, "linking") ||
      isWindowState(message, "rateLimited")
    ) {
      clearLinkedInspectionState();
    } else if (isWindowState(message, "error")) {
      if (hasDisplayLinkCode(message)) {
        sourceNavigationController.invalidate();
      } else {
        clearLinkedInspectionState();
      }
    }
    for (const listener of [...stateListeners]) {
      void Promise.resolve(listener(message)).catch(reportError);
    }
  }

  async function sendPanelCommand(message: PanelCommand): Promise<unknown> {
    deactivateTreeSession();
    return options.sendRuntimeMessage(message);
  }

  function deactivateTreeSession(): void {
    treeSessionActive = false;
    domRecoveryStatusGeneration += 1;
    resetSelectionOwnership();
    sourceNavigationController.invalidate();
    recoveryCoordinator.cancel("DOM tree session deactivated");
    treeController.reset();
  }

  function clearLinkedInspectionState(): void {
    deactivateTreeSession();
    resetResolutionState();
  }

  function resetResolutionState(status?: "restoring"): void {
    diagnostics.clearResolution();
    const model = resolutionPresenter.reset();
    view.renderResolution(status === "restoring"
      ? { ...model, statusText: "Restoring DOM" }
      : model);
  }

  function finishRecoveryStatus(statusGeneration: number): void {
    if (
      disposed ||
      statusGeneration !== domRecoveryStatusGeneration ||
      treeController.snapshot().recovering
    ) {
      return;
    }
    resetResolutionState();
  }

  function resetSelectionOwnership(): void {
    acceptedSelectionRevision = undefined;
    activeInspectSelectionRevision = undefined;
  }

  function dispose(): void {
    if (closePromise) {
      return;
    }
    disposed = true;
    const remove = removeUnload;
    removeUnload = undefined;
    remove?.();
    stateListeners.clear();
    removeSourceNavigationBindings();
    diagnostics.clearResolution();
    recoveryCoordinator.dispose();
    treeView.dispose();
    treeController.dispose();
    closePromise = controller
      .dispose()
      .catch(reportError)
      .finally(resolveClosed);
    inspectTransport.dispose();
  }

  const unloadSubscription = options.subscribeUnload(dispose);
  if (disposed) {
    unloadSubscription();
  } else {
    removeUnload = unloadSubscription;
  }

  const ready = Promise.resolve()
    .then(() => {
      try {
        (options.initializeIcons ?? createPanelIcons)();
      } catch (error) {
        reportError(error);
      }
    })
    .then(() => controller.initialize())
    .then(ensurePanelPort)
    .catch(reportError);

  return { ready, closed, dispose };
}

function validatedDomEvent(message: unknown) {
  try {
    return parseDomEvent(message);
  } catch {
    return undefined;
  }
}

function validatedInspectStarted(
  message: unknown,
): PanelInspectStartedState | undefined {
  if (
    !isRecord(message) ||
    !hasOnlyKeys(message, [
      "type",
      "inspectMessageId",
      "selectionRevision",
    ]) ||
    message.type !== "pin-op.inspect.started" ||
    !isOpaqueId(message.inspectMessageId) ||
    !isSelectionRevision(message.selectionRevision)
  ) {
    return undefined;
  }
  return {
    type: message.type,
    inspectMessageId: message.inspectMessageId,
    selectionRevision: message.selectionRevision,
  };
}

function validatedResolution(message: unknown): boolean {
  return ResolutionMessageSchema.safeParse(message).success;
}

function validatedPeerState(message: unknown): boolean {
  return PeerStateMessageSchema.safeParse(message).success;
}

function validatedSourceNavigationState(message: unknown): boolean {
  return SourceNavigationStateMessageSchema.safeParse(message).success;
}

function isIdeDisconnected(
  message: unknown,
): message is {
  readonly type: "pin-op.ideState";
  readonly status: "ide-disconnected";
  readonly inspectMessageId: string;
} {
  return Boolean(
    isRecord(message) &&
    hasOnlyKeys(message, ["type", "status", "inspectMessageId"]) &&
    message.type === "pin-op.ideState" &&
    message.status === "ide-disconnected" &&
    isOpaqueId(message.inspectMessageId),
  );
}

function isWindowState(message: unknown, state: string): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "pin-op.windowState" &&
    (message as Record<string, unknown>).state === state,
  );
}

function hasDisplayLinkCode(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    typeof (message as Record<string, unknown>).displayLinkCode === "string",
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
