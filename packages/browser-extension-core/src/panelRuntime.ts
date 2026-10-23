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
  type PanelView,
} from "./panelController.js";
import { DomTreeController } from "./domTreeController.js";
import { DomTreeRecoveryCoordinator } from "./domTreeRecoveryCoordinator.js";
import { DomTreeRecoveryNotReadyError } from "./domTreeRecoveryError.js";
import {
  isSelectionRevision,
  parseDomEvent,
  type DomSelectionChangedEvent,
  type DomSelectionClearedEvent,
} from "./domProtocol.js";
import type { DomTreeDocument } from "./domTreeDocument.js";
import { PanelInspectController } from "./panelInspectController.js";
import { PanelDiagnostics } from "./panelDiagnostics.js";
import { PanelInspectTransport } from "./panelInspectTransport.js";
import {
  PanelSettingsController,
  type PanelSettingsBindingToken,
} from "./panelSettingsController.js";
import type { PanelDocument } from "./inspectorPanelView.js";
import { parseProtocolData } from "./protocolDataSnapshot.js";
import {
  ResolutionPresenter,
  type ResolutionViewModel,
} from "./resolutionPresenter.js";
import { SourceNavigationController } from "./sourceNavigationController.js";
import { SourcePaneController } from "./sourcePaneController.js";
import {
  SourcePaneView,
  type SourcePaneDocument,
  type SourcePaneViewState,
} from "./sourcePaneView.js";
import {
  createDevtoolsPanelPortName,
  isValidDevtoolsChannel,
  parseInspectPortInvalidated,
  parsePanelInspectStartedState,
  parsePanelTabStateMessage,
  parseProtocolCompatibilityMessage,
  type PanelInspectPort,
  type PanelRulesOpenCommand,
  type PanelViewportResizeCommand,
} from "./inspectPortProtocol.js";
import type { BrowserWindowConnectionState } from "./windowConnectionCoordinator.js";
import type {
  StylesRequest,
  StylesResponse,
} from "./stylesProtocol.js";

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

interface RuntimePanelView extends PanelView {
  renderResolution(model: ResolutionViewModel): void;
  bindSettings(controller: PanelSettingsController): () => void;
}

interface RuntimeSourcePaneView {
  setState(state: SourcePaneViewState): void;
}

interface PanelRuntimePresentationContext {
  readonly sourcePaneController: SourcePaneController;
  readonly sourceNavigationController: SourceNavigationController;
  readonly settingsController: PanelSettingsController;
  readonly treeController: DomTreeController;
  readonly requestStyles: (
    request: StylesRequest,
    signal: AbortSignal,
  ) => Promise<StylesResponse>;
  readonly dispatchRulesOpen: (command: PanelRulesOpenCommand) => void;
  readonly dispatchViewportResize: (
    command: PanelViewportResizeCommand,
  ) => void;
  readonly subscribeInspectorMessages: (
    listener: (message: unknown) => void,
  ) => () => void;
}

interface PanelRuntimePresentationBinding {
  readonly sourcePaneView: RuntimeSourcePaneView;
  readonly removeSettingsBindings: () => void;
  readonly removeSourceNavigationBindings: () => void;
  readonly removeLayoutBindings: () => void;
  beforeControlledTransition?(): boolean | Promise<boolean>;
  contentLeaseReplaced(): void;
  disposePresentation(): void;
}

export interface PanelRuntimePresentation {
  readonly view: RuntimePanelView;
  readonly browserLocalInspection: boolean;
  attach(context: PanelRuntimePresentationContext): PanelRuntimePresentationBinding;
}

export type PanelRuntimePresentationFactory = (
  options: PanelRuntimeOptions,
  reportError: (error: unknown) => void,
) => PanelRuntimePresentation;

/**
 * How many window states a reconnect may spend waiting for the background to
 * bring its content session back before the panel gives up on the frozen
 * selection and reloads the tree.
 */
const MAX_RECONNECT_RESTORE_RETRIES = 3;

/**
 * A tab reload tells the panel its content lease is gone the moment the old one
 * is replaced, which is before the new one has attached. The first recovery
 * attempt can therefore find no session at all. These bound how long the panel
 * waits for it, holding the frozen tree meanwhile.
 */
const MAX_INVALIDATION_RECOVERY_RETRIES = 6;
const INVALIDATION_RECOVERY_RETRY_MS = 200;

type DomSelectionAuthorityEvent =
  | DomSelectionChangedEvent
  | DomSelectionClearedEvent;

export function startPanelRuntimeWithPresentation(
  options: PanelRuntimeOptions,
  createPresentation: PanelRuntimePresentationFactory,
): PanelRuntime {
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
  const presentation = createPresentation(options, reportError);
  const browserLocalInspection = presentation.browserLocalInspection;
  const view = presentation.view;
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
  let pendingReconnectRestore = false;
  let restoreAttemptsLeft = 0;
  let treeSessionRestore: object | undefined;
  let domRecoveryStatusGeneration = 0;
  let acceptedSelectionDocumentEpoch: number | undefined;
  let acceptedSelectionRevision: number | undefined;
  let lastConsumedDomSelection: {
    readonly documentEpoch: number;
    readonly selectionRevision: number;
    readonly type: DomSelectionAuthorityEvent["type"];
    readonly fingerprint: string;
    readonly conflicted: boolean;
  } | undefined;
  let activeInspectSelectionRevision: number | undefined;
  let settingsBinding: PanelSettingsBindingToken | undefined;
  let settingsBindingActivationAuthority: object | undefined;
  let compatibility: "pending" | "compatible" | "incompatible" = "pending";
  let acceptedCompatibilityRouteAuthority: object | undefined;
  let nonLinkedConnectionRouteAuthority: object | undefined;
  let mismatchBlocked = false;
  let deferredLinkedState: unknown;
  let compatibilityFailureRouteDepth = 0;
  // Source excerpts only exist while a VS Code window is linked, so the idle
  // pane has to say how to link instead of asking for a selection it cannot
  // resolve. Message order at startup is not stable, so the pane follows this
  // connection state rather than any single message.
  const invalidationRecoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  let ideLinked = false;
  let unlinkedHeadline = "No IDE linked";
  let sourcePaneStateKind: SourcePaneViewState["kind"] = "empty";

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
      const restorable = treeSessionActive && !preserveMismatch;
      presentationBinding.contentLeaseReplaced();
      if (restorable) {
        suspendTreeSessionForReconnect();
      } else {
        deactivateTreeSession();
      }
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
  treeController = new DomTreeController({
    transport: {
      request: (request) => inspectTransport.requestDom(request),
      dispatch: (request) => inspectTransport.dispatchDom(request),
      cancelPending: (reason) => inspectTransport.cancelDomRequests(reason),
    },
    onError: reportError,
  });
  let presentationBinding!: PanelRuntimePresentationBinding;
  const recoveryCoordinator = new DomTreeRecoveryCoordinator({
    controller: treeController,
    transport: {
      request: (request) => inspectTransport.requestDom(request),
    },
    beforeControlledTransition: () =>
      presentationBinding.beforeControlledTransition?.() ?? true,
  });
  presentationBinding = presentation.attach({
    sourcePaneController,
    sourceNavigationController,
    settingsController,
    treeController,
    requestStyles: (request, signal) =>
      inspectTransport.requestStyles(request, signal),
    dispatchRulesOpen: (command) =>
      inspectTransport.dispatchRulesOpen(command),
    dispatchViewportResize: (command) =>
      inspectTransport.dispatchViewportResize(command),
    subscribeInspectorMessages(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  });
  const {
    sourcePaneView,
    removeSettingsBindings,
    removeSourceNavigationBindings,
    removeLayoutBindings,
  } = presentationBinding;
  setSourcePaneIdle();
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
    allowInspectWithoutIde: browserLocalInspection,
  });

  function setSourcePaneState(state: SourcePaneViewState): void {
    sourcePaneStateKind = state.kind;
    sourcePaneView.setState(state);
  }

  function setSourcePaneIdle(): void {
    setSourcePaneState(ideLinked
      ? { kind: "empty", statusText: "Select an element to inspect" }
      : { kind: "not-linked", statusText: unlinkedHeadline });
  }

  /** Leaves published excerpts alone; only the link walkthrough is replaced. */
  function clearSourcePaneLinkGuidance(): void {
    if (sourcePaneStateKind === "not-linked") setSourcePaneIdle();
  }

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
          if (browserLocalInspection && !mismatchBlocked) {
            resumeTreeSession();
          }
        }
      })
      .catch(async (error) => {
        if (disposed) {
          return;
        }
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
    if (disposed) {
      return;
    }
    currentSettingsBinding();
    if (disposed) {
      return;
    }
    const compatibilityMessage = parseProtocolCompatibilityMessage(message);
    const tabState = parsePanelTabStateMessage(message);
    const inspectStarted = validatedInspectStarted(message);
    const domEvent = validatedDomEvent(message);
    const sourceMatches = parseProtocolData(message, SourceMatchesMessageSchema);
    const windowState = validatedWindowState(message);
    if (windowState && windowState.state !== "linked") {
      nonLinkedConnectionRouteAuthority = {};
    }
    let forwardToStateListeners = true;
    let compatibilityRouteAuthority: object | undefined;
    if (compatibilityMessage) {
      const binding = currentSettingsBinding();
      if (!binding) {
        return;
      }
      if (
        compatibilityMessage.compatible &&
        mismatchBlocked &&
        deferredLinkedState === undefined
      ) {
        return;
      }
      const previousAuthority = acceptedCompatibilityRouteAuthority;
      const previousConnectionAuthority = nonLinkedConnectionRouteAuthority;
      if (!compatibilityMessage.compatible) {
        compatibilityFailureRouteDepth += 1;
      }
      let acceptedCompatibility = false;
      let compatibilityRouteStillCurrent = false;
      try {
        acceptedCompatibility = settingsController.acceptCompatibility(
          binding,
          compatibilityMessage,
        );
        if (!acceptedCompatibility) {
          isCurrentSettingsBinding(binding);
        } else {
          compatibilityRouteStillCurrent =
            !disposed &&
            isCurrentSettingsBinding(binding) &&
            acceptedCompatibilityRouteAuthority === previousAuthority &&
            nonLinkedConnectionRouteAuthority === previousConnectionAuthority;
        }
      } finally {
        if (!compatibilityMessage.compatible) {
          compatibilityFailureRouteDepth -= 1;
        }
      }
      if (!acceptedCompatibility) {
        return;
      }
      if (!compatibilityRouteStillCurrent) {
        return;
      }
      compatibilityRouteAuthority = {};
      acceptedCompatibilityRouteAuthority = compatibilityRouteAuthority;
      const isCurrentRoute = (): boolean =>
        !disposed &&
        isCurrentSettingsBinding(binding) &&
        acceptedCompatibilityRouteAuthority === compatibilityRouteAuthority &&
        nonLinkedConnectionRouteAuthority === previousConnectionAuthority;
      compatibility = compatibilityMessage.compatible
        ? "compatible"
        : "incompatible";
      sourcePaneController.setCompatible(compatibilityMessage.compatible);
      if (!isCurrentRoute()) {
        return;
      }
      if (!compatibilityMessage.compatible) {
        mismatchBlocked = true;
        deferredLinkedState = undefined;
        clearLinkedInspectionState(true);
        if (!isCurrentRoute()) {
          return;
        }
        notifyStateListeners({
          type: "pin-op.windowState",
          state: "incompatible",
        }, isCurrentRoute);
        if (!isCurrentRoute()) {
          return;
        }
      } else if (mismatchBlocked) {
        mismatchBlocked = false;
        setSourcePaneIdle();
        if (!isCurrentRoute()) {
          return;
        }
        const linkedState = deferredLinkedState;
        deferredLinkedState = undefined;
        if (linkedState) {
          notifyStateListeners(linkedState, isCurrentRoute);
          if (!isCurrentRoute()) {
            return;
          }
          resumeTreeSession();
        }
      }
    } else if (tabState) {
      const binding = currentSettingsBinding();
      if (!binding) {
        return;
      }
      if (
        !settingsController.acceptTabState(binding, tabState) ||
        !isCurrentSettingsBinding(binding)
      ) {
        return;
      }
    } else if (inspectStarted) {
      if (!currentSettingsBinding() || compatibility === "incompatible") {
        return;
      }
      const inspectDocumentEpoch = treeController.documentEpoch ??
        acceptedSelectionDocumentEpoch;
      const ownership = acceptSelectionOwnership(
        inspectStarted.selectionRevision,
        inspectDocumentEpoch,
        treeController.documentEpoch,
      );
      if (
        ownership === "stale" ||
        (
          ownership === "current" &&
          inspectDocumentEpoch !== undefined &&
          lastConsumedDomSelection?.documentEpoch === inspectDocumentEpoch &&
          lastConsumedDomSelection.selectionRevision ===
            inspectStarted.selectionRevision &&
          (
            lastConsumedDomSelection.type === "dom.selectionCleared" ||
            lastConsumedDomSelection.conflicted
          )
        )
      ) {
        return;
      }
      activeInspectSelectionRevision = inspectStarted.selectionRevision;
      sourceNavigationController.beginInspect(inspectStarted.inspectMessageId);
      sourcePaneController.beginInspect(inspectStarted.inspectMessageId);
      settingsController.beginInspect(inspectStarted.inspectMessageId);
      setSourcePaneState({
        kind: "loading",
        statusText: "Resolving source matches",
      });
      const model = resolutionPresenter.beginCorrelatedInspect(
        inspectStarted.inspectMessageId,
      );
      if (model) {
        diagnostics.recordResolving();
        view.renderResolution(model);
      }
    } else if (domEvent) {
      if (
        (!browserLocalInspection && !currentSettingsBinding()) ||
        compatibility === "incompatible"
      ) {
        return;
      }
      let beginsSelection = false;
      let selectionOwnership: "current" | "advanced" | undefined;
      if (
        domEvent.type === "dom.selectionChanged" ||
        domEvent.type === "dom.selectionCleared"
      ) {
        const ownership = acceptDomSelectionOwnership(
          domEvent,
          treeController.documentEpoch,
        );
        if (ownership !== "current" && ownership !== "advanced") {
          return;
        }
        selectionOwnership = ownership;
      }
      if (domEvent.type === "dom.selectionChanged") {
        domRecoveryStatusGeneration += 1;
        recoveryCoordinator.handleManualSelection(domEvent);
        void controller?.finishInspectPick().catch(reportError);
        if (selectionOwnership === "advanced") {
          activeInspectSelectionRevision = undefined;
          sourceNavigationController.invalidate();
          if (!mismatchBlocked) {
            setSourcePaneState({
              kind: "loading",
              statusText: "Resolving source matches",
            });
          }
          sourcePaneController.invalidate();
          settingsController.invalidateInspect();
          beginsSelection = true;
        } else if (
          activeInspectSelectionRevision !== domEvent.selectionRevision
        ) {
          sourceNavigationController.invalidate();
          sourcePaneController.invalidate();
          settingsController.invalidateInspect();
        }
      }
      treeController.handleEvent(domEvent);
      if (domEvent.type === "dom.selectionCleared") {
        domRecoveryStatusGeneration += 1;
        activeInspectSelectionRevision = undefined;
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
        if (!mismatchBlocked) {
          setSourcePaneIdle();
        }
        resetResolutionState();
      } else if (domEvent.type === "dom.selectionChanged") {
        const selected = domEvent.ancestorPath.at(-1);
        if (beginsSelection) {
          diagnostics.clearResolution();
        }
        if (selected) {
          const model = beginsSelection
            ? resolutionPresenter.beginSelection(selected.label)
            : resolutionPresenter.updateSelectedElement(selected.label);
          view.renderResolution(model);
        } else if (beginsSelection) {
          view.renderResolution(resolutionPresenter.reset());
        }
      }
    } else if (validatedResolution(message)) {
      const resolution = ResolutionMessageSchema.parse(message);
      const acceptedSourceResolution = sourcePaneController.acceptResolution(resolution);
      const model = resolutionPresenter.acceptResolution(resolution);
      if (model) {
        sourceNavigationController.acceptResolution(resolution);
        diagnostics.recordResolution(resolution);
        view.renderResolution(model);
        if (acceptedSourceResolution && resolution.status !== "matched") {
          setSourcePaneState({
            kind: resolution.status === "error" ? "error" : "empty",
            statusText: model.statusText,
          });
        }
      }
    } else if (sourceMatches) {
      if (sourcePaneController.acceptMatches(sourceMatches) === "published") {
        setSourcePaneState({ kind: "ready" });
      }
    } else if (validatedSourceNavigationState(message)) {
      const navigationState = SourceNavigationStateMessageSchema.parse(message);
      sourcePaneController.acceptNavigationState(navigationState);
      sourceNavigationController.acceptState(navigationState);
    } else if (validatedPeerState(message)) {
      const peer = PeerStateMessageSchema.parse(message);
      if (peer.connected) {
        ideLinked = true;
        unlinkedHeadline = "IDE disconnected";
        clearSourcePaneLinkGuidance();
      } else {
        ideLinked = false;
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
        setSourcePaneState({
          kind: "not-linked",
          statusText: "IDE disconnected",
        });
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
      ideLinked = false;
      const model = resolutionPresenter.ideDisconnected(
        message.inspectMessageId,
      );
      if (model) {
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
        setSourcePaneState({
          kind: "not-linked",
          statusText: "IDE disconnected",
        });
        diagnostics.recordIdeDisconnected();
        view.renderResolution(model);
      }
    } else if (windowState && (
      windowState.state === "linked" ||
      windowState.state === "offline" ||
      windowState.state === "reconnecting"
    )) {
      if (!acceptSettingsWindowState(windowState.state)) {
        return;
      }
      if (windowState.state === "linked") {
        ideLinked = true;
        unlinkedHeadline = "IDE disconnected";
        clearSourcePaneLinkGuidance();
        deferredLinkedState = message;
        if (!settingsBinding) {
          if (!activatePanelBinding()) {
            return;
          }
          deferredLinkedState = message;
        }
        if (mismatchBlocked) {
          forwardToStateListeners = false;
        }
      } else {
        ideLinked = false;
        sourceNavigationController.invalidate();
        settingsController.invalidateInspect();
        if (mismatchBlocked) {
          sourcePaneController.setCompatible(false);
          compatibility = "incompatible";
          setSourcePaneState({
            kind: "incompatible",
            statusText: "Extensions are incompatible",
          });
        } else {
          sourcePaneController.disconnect();
          compatibility = "pending";
          setSourcePaneState({
            kind: "not-linked",
            statusText: "IDE disconnected",
          });
        }
      }
      if (!mismatchBlocked) {
        resumeTreeSession();
      }
    } else if (parseInspectPortInvalidated(message)) {
      const shouldRecover = treeSessionActive;
      resetSelectionOwnership();
      sourceNavigationController.invalidate();
      sourcePaneController.invalidate();
      settingsController.invalidateInspect();
      setSourcePaneIdle();
      if (shouldRecover) {
        const statusGeneration = ++domRecoveryStatusGeneration;
        resetResolutionState("restoring");
        recoverInvalidatedTree(
          statusGeneration,
          MAX_INVALIDATION_RECOVERY_RETRIES,
        );
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
      if (!acceptSettingsWindowState(windowState.state)) {
        return;
      }
      deferredLinkedState = undefined;
      ideLinked = false;
      unlinkedHeadline = "No IDE linked";
      clearLinkedInspectionState();
      if (!mismatchBlocked) setSourcePaneIdle();
    } else if (windowState?.state === "incompatible") {
      if (!settingsBinding && !activatePanelBinding()) {
        return;
      }
      if (!acceptSettingsWindowState(windowState.state)) {
        return;
      }
      compatibility = "incompatible";
      mismatchBlocked = true;
      deferredLinkedState = undefined;
      clearLinkedInspectionState(true);
      sourcePaneController.setCompatible(false);
      setSourcePaneState({
        kind: "incompatible",
        statusText: "Extensions are incompatible",
      });
    } else if (windowState?.state === "error") {
      if (!acceptSettingsWindowState(windowState.state)) {
        return;
      }
      if (hasDisplayLinkCode(message)) {
        sourceNavigationController.invalidate();
        sourcePaneController.invalidate();
        settingsController.invalidateInspect();
      } else {
        clearLinkedInspectionState();
      }
      if (mismatchBlocked) {
        enforceMismatchBlock();
      }
    }
    if (forwardToStateListeners) {
      notifyStateListeners(
        message,
        compatibilityRouteAuthority
          ? () => acceptedCompatibilityRouteAuthority ===
            compatibilityRouteAuthority
          : undefined,
      );
    }
  }

  async function sendPanelCommand(message: PanelCommand): Promise<unknown> {
    if (!browserLocalInspection) {
      deactivateTreeSession();
    }
    return options.sendRuntimeMessage(message);
  }

  function activatePanelBinding(): boolean {
    if (disposed) {
      return false;
    }
    const previousBinding = settingsBinding;
    const activationAuthority = {};
    settingsBindingActivationAuthority = activationAuthority;
    const binding = settingsController.beginBinding(mismatchBlocked);
    if (disposed || settingsBindingActivationAuthority !== activationAuthority) {
      return false;
    }
    if (!settingsController.isCurrentBinding(binding)) {
      settingsBindingActivationAuthority = {};
      if (settingsBinding === previousBinding) {
        settingsBinding = undefined;
        failClosedSettingsAuthority();
      }
      return false;
    }
    settingsBinding = binding;
    sourcePaneController.beginBinding();
    if (
      disposed ||
      settingsBindingActivationAuthority !== activationAuthority ||
      !isCurrentSettingsBinding(binding)
    ) {
      return false;
    }
    compatibility = mismatchBlocked ? "incompatible" : "pending";
    deferredLinkedState = undefined;
    return true;
  }

  function currentSettingsBinding(): PanelSettingsBindingToken | undefined {
    const binding = settingsBinding;
    if (!binding) {
      return undefined;
    }
    return isCurrentSettingsBinding(binding) ? binding : undefined;
  }

  function isCurrentSettingsBinding(
    binding: PanelSettingsBindingToken,
  ): boolean {
    if (settingsBinding !== binding) {
      return false;
    }
    if (settingsController.isCurrentBinding(binding)) {
      return true;
    }
    settingsBinding = undefined;
    settingsBindingActivationAuthority = {};
    failClosedSettingsAuthority();
    return false;
  }

  function failClosedSettingsAuthority(): void {
    deferredLinkedState = undefined;
    clearLinkedInspectionState(
      mismatchBlocked,
      compatibilityFailureRouteDepth > 0,
    );
  }

  function acceptSettingsWindowState(
    state: BrowserWindowConnectionState,
  ): boolean {
    if (mismatchBlocked && (
      state === "linked" ||
      state === "offline" ||
      state === "reconnecting"
    )) {
      return true;
    }
    if (mismatchBlocked && state !== "incompatible") {
      const previousBinding = settingsBinding;
      settingsBindingActivationAuthority = {};
      settingsController.revokeBinding(true);
      if (settingsBinding === previousBinding) {
        settingsBinding = undefined;
      } else if (settingsBinding !== undefined) {
        return false;
      }
      compatibility = "incompatible";
      return true;
    }
    const binding = settingsBinding;
    if (binding) {
      const accepted = settingsController.acceptWindowState(binding, state);
      if (!accepted) {
        isCurrentSettingsBinding(binding);
        return false;
      }
      if (state !== "linked" && state !== "incompatible") {
        if (settingsBinding !== binding) {
          return false;
        }
        settingsBindingActivationAuthority = {};
        settingsBinding = undefined;
        compatibility = "pending";
        return true;
      }
      if (!isCurrentSettingsBinding(binding)) {
        if (settingsBinding !== undefined) {
          return false;
        }
      }
    }
    if (state !== "linked" && state !== "incompatible") {
      settingsBindingActivationAuthority = {};
      if (settingsBinding === binding) {
        settingsBinding = undefined;
      } else if (settingsBinding !== undefined) {
        return false;
      }
      compatibility = "pending";
    }
    return true;
  }

  function disconnectFeatureControllers(preserveMismatch = false): void {
    sourcePaneController.disconnect();
    const previousBinding = settingsBinding;
    settingsBindingActivationAuthority = {};
    if (previousBinding && !preserveMismatch) {
      settingsController.acceptWindowState(previousBinding, "offline");
    } else {
      settingsController.revokeBinding(preserveMismatch);
    }
    if (settingsBinding === previousBinding) {
      settingsBinding = undefined;
    }
    compatibility = preserveMismatch ? "incompatible" : "pending";
    mismatchBlocked = preserveMismatch;
    ideLinked = false;
    setSourcePaneState(preserveMismatch
      ? { kind: "incompatible", statusText: "Extensions are incompatible" }
      : { kind: "not-linked", statusText: "IDE disconnected" });
    if (!preserveMismatch) {
      deferredLinkedState = undefined;
    }
  }

  function notifyStateListeners(
    message: unknown,
    isCurrent: () => boolean = () => true,
  ): void {
    for (const listener of [...stateListeners]) {
      if (!isCurrent()) {
        return;
      }
      void Promise.resolve(listener(message)).catch(reportError);
    }
  }

  /**
   * A dropped background port is a blip -- the browser suspends an idle
   * background page and the panel reconnects seconds later. Freeze the tree on
   * what it last showed instead of emptying it, so the reconnect can put the
   * same selection back rather than leaving cleared panels behind.
   */
  function suspendTreeSessionForReconnect(): void {
    domRecoveryStatusGeneration += 1;
    resetSelectionOwnership();
    sourceNavigationController.invalidate();
    sourcePaneController.invalidate();
    settingsController.invalidateInspect();
    try {
      treeController.beginRecovery();
    } catch (error) {
      reportError(error);
      deactivateTreeSession();
      return;
    }
    pendingReconnectRestore = true;
    restoreAttemptsLeft = MAX_RECONNECT_RESTORE_RETRIES;
    resetResolutionState("restoring");
  }

  /** Resumes the tree after a reconnect, restoring the frozen selection first. */
  function resumeTreeSession(): void {
    if (!pendingReconnectRestore) {
      // A restore in flight owns the tree: a second window state would drop the
      // recovered selection on the floor and reload an empty root instead.
      if (treeSessionRestore) {
        return;
      }
      treeSessionActive = true;
      void treeController.loadRoot();
      return;
    }
    pendingReconnectRestore = false;
    treeSessionActive = true;
    const restore = {};
    treeSessionRestore = restore;
    const statusGeneration = ++domRecoveryStatusGeneration;
    const settle = (): void => {
      if (treeSessionRestore === restore) {
        treeSessionRestore = undefined;
      }
    };
    resetResolutionState("restoring");
    void recoveryCoordinator.begin()
      .then(() => {
        settle();
        finishRecoveryStatus(statusGeneration);
      })
      .catch((error) => {
        settle();
        // The content session was not there yet; the frozen tree still is, so
        // wait for the next window state rather than throwing the selection
        // away. Bounded, because a tree frozen forever is its own defect.
        if (
          error instanceof DomTreeRecoveryNotReadyError &&
          restoreAttemptsLeft > 0
        ) {
          restoreAttemptsLeft -= 1;
          pendingReconnectRestore = true;
          return;
        }
        reportError(error);
        finishRecoveryStatus(statusGeneration);
        // The selection could not be restored; the panel must still come back
        // with a live tree instead of staying frozen on stale rows.
        reloadTreeSession();
      });
  }

  /**
   * The frozen tree is the only copy of what the panel was showing, so a
   * content session that has not arrived yet must not cost it. Resetting is
   * reserved for a recovery that genuinely failed.
   */
  function recoverInvalidatedTree(
    statusGeneration: number,
    attemptsLeft: number,
  ): void {
    void recoveryCoordinator.begin()
      .then(() => finishRecoveryStatus(statusGeneration))
      .catch((error) => {
        if (
          error instanceof DomTreeRecoveryNotReadyError &&
          attemptsLeft > 0 &&
          !disposed &&
          domRecoveryStatusGeneration === statusGeneration
        ) {
          scheduleInvalidationRecoveryRetry(() => {
            if (disposed || domRecoveryStatusGeneration !== statusGeneration) {
              return;
            }
            recoverInvalidatedTree(statusGeneration, attemptsLeft - 1);
          });
          return;
        }
        reportError(error);
        finishRecoveryStatus(statusGeneration);
        // Recovery restores the previous selection; when it cannot, the
        // panel must still come back with a live tree instead of staying
        // empty until the next manual pick.
        reloadTreeSession();
      });
  }

  function scheduleInvalidationRecoveryRetry(retry: () => void): void {
    const timer = globalThis.setTimeout(() => {
      invalidationRecoveryTimers.delete(timer);
      retry();
    }, INVALIDATION_RECOVERY_RETRY_MS);
    invalidationRecoveryTimers.add(timer);
  }

  function deactivateTreeSession(): void {
    treeSessionActive = false;
    pendingReconnectRestore = false;
    treeSessionRestore = undefined;
    domRecoveryStatusGeneration += 1;
    resetSelectionOwnership();
    sourceNavigationController.invalidate();
    sourcePaneController.invalidate();
    setSourcePaneIdle();
    settingsController.invalidateInspect();
    recoveryCoordinator.cancel("DOM tree session deactivated");
    treeController.reset();
  }

  function clearLinkedInspectionState(
    preserveMismatch = mismatchBlocked,
    forceBrowserInspectionReset = false,
  ): void {
    if (
      browserLocalInspection &&
      !preserveMismatch &&
      !forceBrowserInspectionReset
    ) {
      activeInspectSelectionRevision = undefined;
      sourceNavigationController.invalidate();
      sourcePaneController.disconnect();
      settingsController.invalidateInspect();
      compatibility = "pending";
      deferredLinkedState = undefined;
      const model = resolutionPresenter.ideDisconnected();
      diagnostics.recordIdeDisconnected();
      if (model) {
        view.renderResolution(model);
      }
      return;
    }
    deactivateTreeSession();
    if (preserveMismatch) {
      enforceMismatchBlock();
    } else {
      sourcePaneController.disconnect();
      compatibility = "pending";
    }
    resetResolutionState();
  }

  function enforceMismatchBlock(): void {
    compatibility = "incompatible";
    sourceNavigationController.invalidate();
    sourcePaneController.setCompatible(false);
    settingsController.invalidateInspect();
    setSourcePaneState({
      kind: "incompatible",
      statusText: "Extensions are incompatible",
    });
  }

  /** Drops whatever the tree held and asks the content session for a new root. */
  function reloadTreeSession(): void {
    if (disposed || mismatchBlocked) return;
    pendingReconnectRestore = false;
    treeSessionRestore = undefined;
    try {
      recoveryCoordinator.cancel("DOM recovery could not restore the session");
      treeController.reset();
      resetSelectionOwnership();
      resetResolutionState();
      treeSessionActive = true;
      void treeController.loadRoot().catch(reportError);
    } catch (error) {
      reportError(error);
    }
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
    acceptedSelectionDocumentEpoch = undefined;
    acceptedSelectionRevision = undefined;
    lastConsumedDomSelection = undefined;
    activeInspectSelectionRevision = undefined;
  }

  function acceptDomSelectionOwnership(
    event: DomSelectionAuthorityEvent,
    minimumDocumentEpoch: number | undefined,
  ): "stale" | "duplicate" | "conflict" | "current" | "advanced" {
    const ownership = acceptSelectionOwnership(
      event.selectionRevision,
      event.documentEpoch,
      minimumDocumentEpoch,
    );
    if (ownership === "stale") return ownership;

    const fingerprint = JSON.stringify(event);
    const lastConsumed = lastConsumedDomSelection;
    if (
      lastConsumed?.documentEpoch === event.documentEpoch &&
      lastConsumed.selectionRevision === event.selectionRevision
    ) {
      if (lastConsumed.fingerprint === fingerprint) {
        return "duplicate";
      }
      if (!lastConsumed.conflicted) {
        lastConsumedDomSelection = Object.freeze({
          ...lastConsumed,
          conflicted: true,
        });
      }
      return "conflict";
    }
    lastConsumedDomSelection = Object.freeze({
      documentEpoch: event.documentEpoch,
      selectionRevision: event.selectionRevision,
      type: event.type,
      fingerprint,
      conflicted: false,
    });
    return ownership;
  }

  function acceptSelectionOwnership(
    selectionRevision: number,
    documentEpoch: number | undefined,
    minimumDocumentEpoch: number | undefined,
  ): "stale" | "current" | "advanced" {
    if (
      documentEpoch !== undefined &&
      minimumDocumentEpoch !== undefined &&
      documentEpoch < minimumDocumentEpoch
    ) {
      return "stale";
    }

    if (
      documentEpoch !== undefined &&
      acceptedSelectionDocumentEpoch !== undefined &&
      documentEpoch < acceptedSelectionDocumentEpoch
    ) {
      return "stale";
    }

    const epochAdvanced =
      documentEpoch !== undefined &&
      acceptedSelectionDocumentEpoch !== undefined &&
      documentEpoch > acceptedSelectionDocumentEpoch;
    if (
      !epochAdvanced &&
      acceptedSelectionRevision !== undefined &&
      selectionRevision < acceptedSelectionRevision
    ) {
      return "stale";
    }

    const revisionAdvanced =
      acceptedSelectionRevision === undefined ||
      selectionRevision > acceptedSelectionRevision;
    if (epochAdvanced) {
      lastConsumedDomSelection = undefined;
    }
    if (documentEpoch !== undefined) {
      acceptedSelectionDocumentEpoch = documentEpoch;
    }
    acceptedSelectionRevision = selectionRevision;
    return epochAdvanced || revisionAdvanced ? "advanced" : "current";
  }

  function dispose(): void {
    if (closePromise) {
      return;
    }
    disposed = true;
    for (const timer of invalidationRecoveryTimers) globalThis.clearTimeout(timer);
    invalidationRecoveryTimers.clear();
    const remove = removeUnload;
    removeUnload = undefined;
    remove?.();
    stateListeners.clear();
    removeSourceNavigationBindings();
    removeSettingsBindings();
    removeLayoutBindings();
    disconnectFeatureControllers(false);
    diagnostics.clearResolution();
    recoveryCoordinator.dispose();
    presentationBinding.disposePresentation();
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
      if (disposed) {
        return;
      }
      try {
        (options.initializeIcons ?? createPanelIcons)();
      } catch (error) {
        reportError(error);
      }
    })
    .then(() => disposed ? undefined : controller.initialize())
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
): ReturnType<typeof parsePanelInspectStartedState> {
  return parsePanelInspectStartedState(message);
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



