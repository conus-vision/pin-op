import {
  PeerStateMessageSchema,
  ResolutionMessageSchema,
  SourceMatchesMessageSchema,
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
import {
  PanelSettingsController,
  type PanelSettingsBindingToken,
} from "./panelSettingsController.js";
import type { PanelInspectStartedState } from "./panelSessionTransport.js";
import { DomPanelView, type PanelDocument } from "./panelView.js";
import { parseProtocolData } from "./protocolDataSnapshot.js";
import { ResolutionPresenter } from "./resolutionPresenter.js";
import { SourceNavigationController } from "./sourceNavigationController.js";
import { SourcePaneController } from "./sourcePaneController.js";
import {
  createDevtoolsPanelPortName,
  isValidDevtoolsChannel,
  parseInspectPortInvalidated,
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";
import type { BrowserWindowConnectionState } from "./windowConnectionCoordinator.js";

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
  readonly sourcePaneController: SourcePaneController;
  readonly settingsController: PanelSettingsController;
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
  let settingsBinding: PanelSettingsBindingToken | undefined;
  let compatibility: "pending" | "compatible" | "incompatible" = "pending";
  let mismatchBlocked = false;
  let deferredLinkedState: unknown;

  let inspectTransport!: PanelInspectTransport;
  const sourcePaneController = new SourcePaneController((message) =>
    inspectTransport.dispatchSourceOpen(message),
  );
  const settingsController = new PanelSettingsController((message) => {
    if (message.type === "pin-op.tab.settings") {
      inspectTransport.dispatchTabSettings(message);
    } else {
      inspectTransport.dispatchPresentationSettings(message);
    }
  });
  inspectTransport = new PanelInspectTransport(
    () => options.connectRuntimePort(createDevtoolsPanelPortName(channel)),
    () => {
      const preserveMismatch = mismatchBlocked;
      deactivateTreeSession();
      disconnectFeatureControllers(preserveMismatch);
      void controller.handleTransportDisconnect()
        .catch(reportError)
        .then(() => {
          if (preserveMismatch && !disposed) {
            notifyStateListeners({
              type: "pin-op.windowState",
              state: "incompatible",
            });
          }
          return ensurePanelPort();
        })
        .catch(reportError);
    },
    (message) => routePanelMessage(message),
    activatePanelBinding,
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
    const compatibilityMessage = parseProtocolCompatibilityMessage(message);
    const tabState = parsePanelTabStateMessage(message);
    const inspectStarted = validatedInspectStarted(message);
    const domEvent = validatedDomEvent(message);
    const sourceMatches = parseProtocolData(message, SourceMatchesMessageSchema);
    const windowState = validatedWindowState(message);
    let forwardToStateListeners = true;
    if (compatibilityMessage) {
      if (!settingsBinding) {
        return;
      }
      if (!settingsController.acceptCompatibility(
        settingsBinding,
        compatibilityMessage,
      )) {
        return;
      }
      compatibility = compatibilityMessage.compatible
        ? "compatible"
        : "incompatible";
      sourcePaneController.setCompatible(compatibilityMessage.compatible);
      if (!compatibilityMessage.compatible) {
        mismatchBlocked = true;
        sourceNavigationController.invalidate();
        settingsController.invalidateInspect();
        notifyStateListeners({
          type: "pin-op.windowState",
          state: "incompatible",
        });
      } else if (mismatchBlocked) {
        mismatchBlocked = false;
        const linkedState = deferredLinkedState;
        deferredLinkedState = undefined;
        if (linkedState) {
          notifyStateListeners(linkedState);
        }
      }
    } else if (tabState) {
      if (!settingsBinding) {
        return;
      }
      settingsController.acceptTabState(settingsBinding, tabState);
    } else if (inspectStarted) {
      if (compatibility === "incompatible") {
        return;
      }
      if (
        acceptedSelectionRevision !== undefined &&
        inspectStarted.selectionRevision < acceptedSelectionRevision
      ) {
        return;
      }
      acceptedSelectionRevision = inspectStarted.selectionRevision;
      activeInspectSelectionRevision = inspectStarted.selectionRevision;
      sourceNavigationController.beginInspect(inspectStarted.inspectMessageId);
      sourcePaneController.beginInspect(inspectStarted.inspectMessageId);
      settingsController.beginInspect(inspectStarted.inspectMessageId);
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
          sourcePaneController.invalidate();
          settingsController.invalidateInspect();
        } else if (
          activeInspectSelectionRevision !== domEvent.selectionRevision
        ) {
          sourceNavigationController.invalidate();
          sourcePaneController.invalidate();
          settingsController.invalidateInspect();
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
      sourcePaneController.acceptResolution(resolution);
      const model = resolutionPresenter.acceptResolution(resolution);
      if (model) {
        sourceNavigationController.acceptResolution(resolution);
        diagnostics.recordResolution(resolution);
        view.renderResolution(model);
      }
    } else if (sourceMatches) {
      sourcePaneController.acceptMatches(sourceMatches);
    } else if (validatedSourceNavigationState(message)) {
      const navigationState = SourceNavigationStateMessageSchema.parse(message);
      sourcePaneController.acceptNavigationState(navigationState);
      sourceNavigationController.acceptState(navigationState);
    } else if (validatedPeerState(message)) {
      const peer = PeerStateMessageSchema.parse(message);
      if (!peer.connected) {
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
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
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
        diagnostics.recordIdeDisconnected();
        view.renderResolution(model);
      }
    } else if (windowState && (
      windowState.state === "linked" ||
      windowState.state === "offline" ||
      windowState.state === "reconnecting"
    )) {
      acceptSettingsWindowState(windowState.state);
      if (windowState.state === "linked") {
        deferredLinkedState = message;
        if (!settingsBinding) {
          activatePanelBinding();
          deferredLinkedState = message;
        }
        if (mismatchBlocked) {
          forwardToStateListeners = false;
        }
      } else {
        sourceNavigationController.invalidate();
        sourcePaneController.disconnect();
        settingsController.invalidateInspect();
        compatibility = "pending";
      }
      treeSessionActive = true;
      void treeController.loadRoot();
    } else if (parseInspectPortInvalidated(message)) {
      const shouldRecover = treeSessionActive;
      resetSelectionOwnership();
      sourceNavigationController.invalidate();
      sourcePaneController.invalidate();
      settingsController.invalidateInspect();
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
    } else if (windowState && (
      windowState.state === "notLinked" ||
      windowState.state === "linking" ||
      windowState.state === "rateLimited"
    )) {
      acceptSettingsWindowState(windowState.state);
      mismatchBlocked = false;
      deferredLinkedState = undefined;
      clearLinkedInspectionState();
    } else if (windowState?.state === "incompatible") {
      acceptSettingsWindowState(windowState.state);
      compatibility = "incompatible";
      mismatchBlocked = true;
      sourcePaneController.setCompatible(false);
      settingsController.invalidateInspect();
      clearLinkedInspectionState(true);
    } else if (windowState?.state === "error") {
      acceptSettingsWindowState(windowState.state);
      if (hasDisplayLinkCode(message)) {
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
      } else {
        clearLinkedInspectionState();
      }
    }
    if (forwardToStateListeners) {
      notifyStateListeners(message);
    }
  }

  async function sendPanelCommand(message: PanelCommand): Promise<unknown> {
    deactivateTreeSession();
    return options.sendRuntimeMessage(message);
  }

  function activatePanelBinding(): void {
    settingsBinding = settingsController.beginBinding();
    sourcePaneController.beginBinding();
    compatibility = mismatchBlocked ? "incompatible" : "pending";
    if (mismatchBlocked) {
      settingsController.acceptWindowState(settingsBinding, "incompatible");
    }
    if (!mismatchBlocked) {
      deferredLinkedState = undefined;
    }
  }

  function acceptSettingsWindowState(
    state: BrowserWindowConnectionState,
  ): void {
    if (settingsBinding) {
      settingsController.acceptWindowState(settingsBinding, state);
    }
    if (state !== "linked" && state !== "incompatible") {
      settingsBinding = undefined;
      compatibility = "pending";
    }
  }

  function disconnectFeatureControllers(preserveMismatch = false): void {
    sourcePaneController.disconnect();
    if (settingsBinding) {
      settingsController.acceptWindowState(settingsBinding, "offline");
    }
    settingsBinding = undefined;
    compatibility = preserveMismatch ? "incompatible" : "pending";
    mismatchBlocked = preserveMismatch;
    if (!preserveMismatch) {
      deferredLinkedState = undefined;
    }
  }

  function notifyStateListeners(message: unknown): void {
    for (const listener of [...stateListeners]) {
      void Promise.resolve(listener(message)).catch(reportError);
    }
  }

  function deactivateTreeSession(): void {
    treeSessionActive = false;
    domRecoveryStatusGeneration += 1;
    resetSelectionOwnership();
    sourceNavigationController.invalidate();
    sourcePaneController.invalidate();
    settingsController.invalidateInspect();
    recoveryCoordinator.cancel("DOM tree session deactivated");
    treeController.reset();
  }

  function clearLinkedInspectionState(preserveMismatch = false): void {
    deactivateTreeSession();
    if (!preserveMismatch) {
      sourcePaneController.disconnect();
      compatibility = "pending";
    }
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
    disconnectFeatureControllers(false);
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

  return {
    ready,
    closed,
    sourcePaneController,
    settingsController,
    dispose,
  };
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

function validatedWindowState(
  message: unknown,
): { readonly state: BrowserWindowConnectionState } | undefined {
  if (
    !isRecord(message) ||
    (!hasOnlyKeys(message, ["type", "state"]) &&
      !hasOnlyKeys(message, ["type", "state", "displayLinkCode"])) ||
    message.type !== "pin-op.windowState" ||
    !isBrowserWindowConnectionState(message.state) ||
    (message.displayLinkCode !== undefined &&
      typeof message.displayLinkCode !== "string")
  ) {
    return undefined;
  }
  return { state: message.state };
}

function isBrowserWindowConnectionState(
  value: unknown,
): value is BrowserWindowConnectionState {
  return value === "notLinked" ||
    value === "linking" ||
    value === "linked" ||
    value === "reconnecting" ||
    value === "offline" ||
    value === "rateLimited" ||
    value === "incompatible" ||
    value === "error";
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
