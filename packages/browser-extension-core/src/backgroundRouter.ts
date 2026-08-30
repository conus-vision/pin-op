import {
  ClientSourceSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  RulesSourcesMessageSchema,
  SourceMatchesMessageSchema,
  type ClientSource,
  type PageRefreshMessage,
  type PeerStateMessage,
  type ResolutionMessage,
  type RulesSourcesMessage,
  type SourceMatchesMessage,
  type SourceNavigateMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import {
  BrowserProtocolError,
  type BrowserProtocolMismatch,
  type InspectPayload,
  type InspectSendOutcome,
  type PresentationSettingsInput,
  type RulesOpenInput,
  type SourceOpenInput,
  type SourceNavigationSendOutcome,
  type SourcePresentationSendOutcome,
} from "./bridgeClient.js";
import {
  BackgroundInspectSession,
  type BackgroundInspectCoordinator,
  type InspectSessionInvalidationReason,
} from "./backgroundInspectSession.js";
import {
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  isSelectionRevision,
  parseDomEvent,
  parseDomResponse,
  type DomEvent,
  type DomErrorCode,
  type DomRequest,
} from "./domProtocol.js";
import {
  InspectCorrelationStore,
  type PresentationSettingsAuthority,
  type RulesOpenAuthority,
  type SourceOpenAuthority,
} from "./inspectCorrelationStore.js";
import {
  parseProtocolData,
  parseRulesSourcesProtocolData,
} from "./protocolDataSnapshot.js";
import {
  isTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "./trustedIdePeerContext.js";
import type {
  BackgroundContentRefreshCoordinator,
  BackgroundTabUpdate,
} from "./backgroundContentRefresh.js";
import {
  isValidContentSessionId,
  isValidDevtoolsChannel,
  isValidInspectRepublishToken,
  parseInspectContentLeasePortName,
  parseInspectorLocalRequest,
  parseDevtoolsPanelPortName,
  parseInspectPortRequest,
  parsePanelPresentationSettingsCommand,
  parsePanelRulesOpenCommand,
  parsePanelSourceOpenCommand,
  parsePanelSourceNavigateCommand,
  parsePanelTabSettingsCommand,
  type ContentSessionId,
  type InspectRepublishRequest,
  type PanelInspectPort,
  type PanelPresentationSettingsCommand,
  type PanelRulesOpenCommand,
  type PanelSourceOpenCommand,
  type PanelSourceNavigateCommand,
} from "./inspectPortProtocol.js";
import { PanelSessionTransport } from "./panelSessionTransport.js";
import {
  STYLES_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  parseStylesEvent,
  parseStylesResponse,
  type StylesErrorCode,
  type StylesEvent,
  type StylesRequest,
} from "./stylesProtocol.js";
import {
  createPanelTabStateMessage,
  type ProtocolCompatibilityMessage,
  type RefreshExecutionCommand,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";
import type {
  TabRefreshCompletion,
  TabRefreshCoordinator,
  TabRefreshSettings,
} from "./tabRefreshCoordinator.js";
import type {
  BrowserWindowConnectionState,
  ControlledWindowTransition,
  PanelRegistration,
} from "./windowConnectionCoordinator.js";
import { parseLinkCode } from "./linkCode.js";

export const DEFAULT_MAX_PANEL_PORTS = 64;

export interface BackgroundTab {
  readonly id?: number;
  readonly windowId?: number;
}

export interface BackgroundMessageSender {
  readonly url?: string;
  readonly frameId?: number;
  readonly tab?: BackgroundTab;
}

export interface BackgroundRuntimePort extends PanelInspectPort {
  readonly sender?: BackgroundMessageSender;
}

export interface BackgroundWindowCoordinator {
  linkWindow(
    windowId: number,
    code: string,
    source: ClientSource,
    signal?: AbortSignal,
  ): Promise<void>;
  unlinkWindow(windowId: number, signal?: AbortSignal): Promise<void>;
  registerPanel(registration: PanelRegistration): { dispose(): void };
  publishInspect(
    windowId: number,
    inspectMessageId: string,
    sourceId: string,
    payload: InspectPayload,
  ): InspectSendOutcome;
  publishSourceNavigation(
    windowId: number,
    input: Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >,
  ): SourceNavigationSendOutcome;
  publishSourceOpen(
    context: TrustedIdePeerContext,
    input: SourceOpenInput,
  ): SourcePresentationSendOutcome;
  publishRulesOpen(
    context: TrustedIdePeerContext,
    input: RulesOpenInput,
  ): SourcePresentationSendOutcome;
  publishPresentationSettings(
    context: TrustedIdePeerContext,
    input: PresentationSettingsInput,
  ): SourcePresentationSendOutcome;
  setRefreshParticipant(
    windowId: number,
    tabId: number,
    participant: boolean,
  ): void;
  removeWindow(windowId: number): Promise<void>;
}

export type BackgroundTabRefreshCoordinator = Pick<
  TabRefreshCoordinator,
  | "panelOpened"
  | "panelClosed"
  | "state"
  | "updateSettings"
  | "acceptPageRefresh"
  | "beginWindowEpoch"
  | "clearWindowPending"
  | "activateTab"
  | "detachTab"
  | "removeTab"
  | "removeWindow"
>;

export type BackgroundContentRefreshRuntime = Pick<
  BackgroundContentRefreshCoordinator,
  | "dispatch"
  | "routeMessage"
  | "observeTabUpdate"
  | "tabUpdated"
  | "setTabParticipation"
  | "setWindowEligibility"
  | "revokeTab"
  | "revokeWindow"
  | "removeTab"
  | "detachTab"
  | "dispose"
>;

export type BackgroundCommandError =
  | "invalidCode"
  | "stalePanel"
  | "busy"
  | "rateLimited"
  | "error";

export type BackgroundRouteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: BackgroundCommandError };

export interface BackgroundRouterSubscriptions {
  subscribeRuntimeMessages(
    listener: (
      message: unknown,
      sender: BackgroundMessageSender,
    ) => Promise<unknown>,
  ): () => void;
  subscribeRuntimePorts(
    listener: (port: BackgroundRuntimePort) => void,
  ): () => void;
  subscribeWindowRemoved(listener: (windowId: number) => void): () => void;
  subscribeTabDetached(
    listener: (tabId: number, oldWindowId: number) => void,
  ): () => void;
  subscribeTabAttached(
    listener: (tabId: number, newWindowId: number) => void,
  ): () => void;
  subscribeTabActivated?(
    listener: (tabId: number, windowId: number) => void,
  ): () => void;
  subscribeTabRemoved?(listener: (tabId: number) => void): () => void;
  subscribeTabUpdated?(
    listener: (tabId: number, update: BackgroundTabUpdate) => void,
  ): () => void;
}

export interface BackgroundRouterOptions {
  readonly browserLocalInspection?: boolean;
  readonly expectedDevtoolsUrl?: string;
  readonly expectedPanelUrl?: string;
  readonly maxPanelPorts?: number;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly coordinator: BackgroundWindowCoordinator;
  readonly tabRefreshCoordinator: BackgroundTabRefreshCoordinator;
  readonly contentRefreshCoordinator?: BackgroundContentRefreshRuntime;
  readonly inspectCoordinator: BackgroundInspectCoordinator;
  readonly panelSessionTransport?: PanelSessionTransport;
  readonly inspectCorrelationStore?: InspectCorrelationStore;
  readonly inspectMessageId?: () => string;
  readonly subscribeResolutions?: (
    listener: (
      peerContext: TrustedIdePeerContext,
      message: ResolutionMessage,
    ) => void,
  ) => () => void;
  readonly subscribePeerStates?: (
    listener: (windowId: number, message: PeerStateMessage) => void,
  ) => () => void;
  readonly subscribeSourceNavigationStates?: (
    listener: (
      peerContext: TrustedIdePeerContext,
      message: SourceNavigationStateMessage,
    ) => void,
  ) => () => void;
  readonly subscribeSourceMatches?: (
    listener: (
      peerContext: TrustedIdePeerContext,
      message: SourceMatchesMessage,
    ) => void,
  ) => () => void;
  readonly subscribeRulesSources?: (
    listener: (
      peerContext: TrustedIdePeerContext,
      message: RulesSourcesMessage,
    ) => void,
  ) => () => void;
  readonly subscribePageRefreshes?: (
    listener: (windowId: number, message: PageRefreshMessage) => void,
  ) => () => void;
  readonly subscribeProtocolMismatches?: (
    listener: (windowId: number, details: BrowserProtocolMismatch) => void,
  ) => () => void;
  readonly subscriptions?: BackgroundRouterSubscriptions;
  readonly onError?: (error: unknown) => void;
}

interface RegistrationIdentity {
  readonly channel: string;
  readonly tabId: number;
  readonly sourceId: string;
}

interface ChannelBinding extends RegistrationIdentity {
  readonly windowId: number;
  readonly generation: number;
  readonly suspended: boolean;
}

interface PendingRegistration extends RegistrationIdentity {
  readonly generation: number;
  readonly disposeGeneration: number;
  readonly bindingGeneration: number | undefined;
  detachedWindowId?: number;
  panelClosed: boolean;
  promise: Promise<BackgroundRouteResult | undefined>;
}

interface StylesSelectionAuthority {
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly selected: boolean;
}

interface InspectPublicationToken {
  documentEpoch: number | undefined;
  readonly selectionRevision: number;
}

interface StylesInvalidationAuthority {
  readonly documentEpoch: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
}

type StylesSelectionEvent = Extract<
  DomEvent,
  { readonly type: "dom.selectionChanged" | "dom.selectionCleared" }
>;

interface BufferedInspectSelection {
  readonly payload: InspectPayload;
  readonly selectionRevision: number;
  readonly contentSessionId: ContentSessionId;
  readonly selectionEvent?: StylesSelectionEvent;
}

interface RefreshRepublishAuthority extends StylesInvalidationAuthority {
  readonly contentSessionId: ContentSessionId;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly republishToken: string;
  readonly phase: "pending" | "committed";
}

interface PanelPortRecord {
  readonly channel: string;
  readonly port: BackgroundRuntimePort;
  readonly generation: number;
  readonly onDisconnect: () => void;
  onMessage: (message: unknown) => void;
  activationToken?: object;
  bindingGeneration?: number;
  registration?: { dispose(): void };
  inspectSession?: BackgroundInspectSession;
  inspectTabId?: number;
  inspectWindowId?: number;
  contentSessionId?: ContentSessionId;
  contentLeaseArrival?: ContentLeaseArrival;
  contentLeaseEverAttached?: boolean;
  replacingContentSessionId?: ContentSessionId;
  rejectPendingContentLeaseReplacements?: boolean;
  stylesSelectionAuthority?: StylesSelectionAuthority;
  stylesInvalidationAuthority?: StylesInvalidationAuthority;
  refreshRepublishAuthority?: RefreshRepublishAuthority;
  pendingRefreshRenewalToken?: string;
  pendingWindowTransitionSelection?: PendingWindowTransitionSelection;
  inspectPublicationToken?: InspectPublicationToken;
  republishPublication?: InspectRepublishRequest;
  availabilityRepublish?: {
    readonly token: string;
    readonly windowId: number;
    readonly epoch: number;
  };
  panelSessionBinding?: { dispose(): void };
  inspectCommandTail: Promise<void>;
  windowStateQueue?: WindowStateQueue;
  windowStateRevision: number;
  tabStateInitialization?: Promise<boolean>;
  tabStateInitialized: boolean;
  tabStateInvalidatedByUnlink: boolean;
  lastWindowState?: BrowserWindowConnectionState;
  republishWindowId?: number;
  republishedAvailabilityEpoch: number;
  republishInFlightEpoch?: number;
  contentRecoveryAvailable: boolean;
  inspectionFailedClosed: boolean;
}

interface PanelTabStateActivation {
  readonly record: PanelPortRecord;
  readonly binding: ChannelBinding;
  readonly token: object;
}

interface WindowStateQueue {
  tail: Promise<void>;
}

/**
 * Resolves once the inspection session that owns it has either attached its
 * first content lease or been torn down, so a DOM read that arrives while the
 * lease is still being established can wait instead of failing closed.
 */
interface ContentLeaseArrival {
  readonly ready: Promise<void>;
  settle(): void;
}

function createContentLeaseArrival(): ContentLeaseArrival {
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { ready, settle };
}

interface BufferedSelectionHolder {
  bufferedSelectionEvent?: StylesSelectionEvent;
  bufferedInspectSelection?: BufferedInspectSelection;
}

interface ControlledInspectCleanup extends BufferedSelectionHolder {
  readonly record: PanelPortRecord;
  readonly activationToken: object;
  readonly binding: ChannelBinding;
  readonly contentSessionId: ContentSessionId;
  readonly promise: Promise<boolean>;
  readonly transientRetainers: Set<object>;
  readonly windowTransitionRetainers: Set<object>;
  settled: boolean;
  retainForWindowState: boolean;
  republishOnRelease: boolean;
}

interface PreparedControlledWindowTransition {
  readonly cleanups: readonly ControlledInspectCleanup[];
  readonly promise: Promise<boolean>;
  readonly retainToken?: object;
}

interface ExpectedNestedWindowTransition {
  readonly commandToken: object;
  readonly kind: ControlledWindowTransition["kind"];
  readonly prepared: PreparedControlledWindowTransition;
}

interface PendingTabRefreshTransition extends BufferedSelectionHolder {
  readonly token: object;
  readonly record: PanelPortRecord;
  readonly activationToken: object;
  readonly binding: ChannelBinding;
  readonly contentSessionId: ContentSessionId;
  readonly windowId: number;
  readonly refreshGeneration: number;
  readonly mode: PageRefreshMessage["mode"];
  readonly initialStylesInvalidationAuthority:
    | StylesInvalidationAuthority
    | undefined;
  cleanup?: ControlledInspectCleanup;
}

interface PendingTabRefreshAdmission {
  readonly token: object;
  readonly record: PanelPortRecord;
  readonly windowId: number;
  readonly transition: PendingTabRefreshTransition;
}

interface PendingWindowTransitionSelection extends BufferedSelectionHolder {
  readonly activationToken: object;
  readonly binding: ChannelBinding;
  readonly contentSessionId: ContentSessionId;
  readonly windowId: number;
}

interface WindowAvailabilityState {
  bridgeConnected: boolean | undefined;
  epoch: number;
  initialPeerCoveredEpoch?: number;
}

interface PanelCommandRecord {
  readonly commandToken: object;
  readonly activationToken: object;
  readonly bindingGeneration?: number;
  readonly abortController?: AbortController;
}

interface WindowCommandCompletion {
  readonly promise: Promise<void>;
  release(): void;
}

interface PanelTeardownRequirement {
  readonly binding: ChannelBinding;
  record?: PanelPortRecord;
  inspectRetirement?: Promise<void>;
  deferControlledSideEffects?: boolean;
  preservePanelState?: boolean;
  invalidateBinding: boolean;
}

interface RetiringInspectCleanup {
  readonly requirement: PanelTeardownRequirement;
  readonly binding: ChannelBinding;
  readonly recordGeneration: number;
  readonly contentSessionId: ContentSessionId;
  latestAuthority: StylesInvalidationAuthority | undefined;
}

type PanelWindowCommand =
  | {
      readonly type: "pin-op.linkWindow";
      readonly channel: string;
      readonly code: string;
    }
  | {
      readonly type: "pin-op.unlinkWindow";
      readonly channel: string;
    };

const okResult = Object.freeze({ ok: true } as const);
const nullContentRefreshRuntime: BackgroundContentRefreshRuntime = Object.freeze({
  async dispatch(): Promise<void> {},
  async routeMessage(): Promise<undefined> { return undefined; },
  observeTabUpdate(): boolean { return false; },
  async tabUpdated(): Promise<void> {},
  setTabParticipation(): void {},
  setWindowEligibility(): void {},
  revokeTab(): void {},
  revokeWindow(): void {},
  async removeTab(): Promise<void> {},
  async detachTab(): Promise<void> {},
  dispose(): void {},
});

export class BackgroundRouter {
  private readonly browserLocalInspection: boolean;
  private readonly expectedDevtoolsUrl: string | undefined;
  private readonly expectedPanelUrl: string | undefined;
  private readonly maxPanelPorts: number;
  private readonly getTab: BackgroundRouterOptions["getTab"];
  private readonly coordinator: BackgroundWindowCoordinator;
  private readonly tabRefreshCoordinator: BackgroundTabRefreshCoordinator;
  private readonly contentRefreshCoordinator: BackgroundContentRefreshRuntime;
  private readonly inspectCoordinator: BackgroundInspectCoordinator;
  private readonly panelSessions: PanelSessionTransport;
  private readonly correlations: InspectCorrelationStore;
  private readonly inspectMessageId: () => string;
  private readonly onError: BackgroundRouterOptions["onError"];
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly channelByTab = new Map<number, string>();
  private readonly channelBySource = new Map<string, string>();
  private readonly pendingRegistrations = new Map<
    string,
    PendingRegistration
  >();
  private readonly panelPorts = new Map<string, PanelPortRecord>();
  private readonly panelCommands = new Map<string, PanelCommandRecord>();
  private readonly windowCommands = new Map<number, object>();
  private readonly windowCommandCompletions = new Map<
    number,
    WindowCommandCompletion
  >();
  private readonly expectedNestedWindowTransitions = new Map<
    number,
    ExpectedNestedWindowTransition
  >();
  private readonly panelTeardowns = new Map<
    string,
    { readonly binding: ChannelBinding; readonly promise: Promise<boolean> }
  >();
  private readonly requiredPanelTeardowns = new Map<
    string,
    PanelTeardownRequirement
  >();
  private readonly retiringInspectCleanups = new Map<
    number,
    RetiringInspectCleanup
  >();
  private readonly removedWindows = new Set<number>();
  private readonly peerBlockedWindows = new Set<number>();
  private readonly windowRefreshEpochs = new Map<number, number>();
  private readonly controlledInspectCleanups = new Map<
    string,
    ControlledInspectCleanup
  >();
  private readonly pendingTabRefreshTransitions = new Map<
    string,
    PendingTabRefreshTransition
  >();
  private readonly pendingTabRefreshAdmissions = new Map<
    string,
    PendingTabRefreshAdmission
  >();
  private readonly removeSubscriptions: Array<() => void> = [];
  private readonly peerStates = new Map<
    number,
    {
      readonly sessionId: string;
      readonly connected: boolean;
      readonly generation: number;
    }
  >();
  private readonly peerTransitionTails = new Map<number, Promise<void>>();
  private readonly peerTransitionAuthorities = new Map<number, object>();
  private readonly availabilityStates = new Map<
    number,
    WindowAvailabilityState
  >();
  private nextGeneration = 1;
  private nextRepublishToken = 1;
  private disposeGeneration = 1;
  private disposed = false;
  private disposing = false;
  private disposePromise: Promise<void> | undefined;

  public constructor(options: BackgroundRouterOptions) {
    this.browserLocalInspection = options.browserLocalInspection === true;
    this.expectedDevtoolsUrl = options.expectedDevtoolsUrl;
    this.expectedPanelUrl = options.expectedPanelUrl;
    this.maxPanelPorts = validPanelPortLimit(options.maxPanelPorts);
    this.getTab = options.getTab;
    this.coordinator = options.coordinator;
    this.tabRefreshCoordinator = options.tabRefreshCoordinator;
    this.contentRefreshCoordinator = options.contentRefreshCoordinator ??
      nullContentRefreshRuntime;
    this.inspectCoordinator = options.inspectCoordinator;
    this.correlations = options.inspectCorrelationStore ??
      new InspectCorrelationStore();
    this.inspectMessageId = options.inspectMessageId ??
      createInspectMessageId;
    this.panelSessions = options.panelSessionTransport ??
      new PanelSessionTransport({
        maxChannels: this.maxPanelPorts,
        sendTabMessage: (tabId, message) =>
          this.inspectCoordinator.sendTabMessage(tabId, message),
        postPanelMessage: (channel, message) =>
          this.postToActiveChannel(channel, message),
      });
    this.onError = options.onError;
    if (options.subscribeResolutions) {
      this.removeSubscriptions.push(
        options.subscribeResolutions((peerContext, message) =>
          this.receiveResolution(peerContext, message),
        ),
      );
    }
    if (options.subscribePeerStates) {
      this.removeSubscriptions.push(
        options.subscribePeerStates((windowId, message) =>
          this.receivePeerState(windowId, message),
        ),
      );
    }
    if (options.subscribeSourceNavigationStates) {
      this.removeSubscriptions.push(
        options.subscribeSourceNavigationStates((peerContext, message) =>
          this.receiveSourceNavigationState(peerContext, message),
        ),
      );
    }
    if (options.subscribePageRefreshes) {
      this.removeSubscriptions.push(
        options.subscribePageRefreshes((windowId, message) => {
          this.acceptPageRefreshAfterWindowCommand(windowId, message);
        }),
      );
    }
    if (options.subscribeSourceMatches) {
      this.removeSubscriptions.push(
        options.subscribeSourceMatches((peerContext, message) =>
          this.receiveSourceMatches(peerContext, message),
        ),
      );
    }
    if (options.subscribeRulesSources) {
      this.removeSubscriptions.push(
        options.subscribeRulesSources((peerContext, message) =>
          this.receiveRulesSources(peerContext, message),
        ),
      );
    }
    if (options.subscribeProtocolMismatches) {
      this.removeSubscriptions.push(
        options.subscribeProtocolMismatches((windowId) =>
          this.receiveProtocolMismatch(windowId),
        ),
      );
    }
    this.attachSubscriptions(options.subscriptions);
  }

  public async routeMessage(
    message: unknown,
    sender: BackgroundMessageSender,
  ): Promise<unknown> {
    const stylesEvent = parseContentStylesEventMessage(message);
    if (this.disposed || this.disposing) {
      return stylesEvent
        ? this.publishRetiringStylesInvalidation(
            stylesEvent.event,
            stylesEvent.contentSessionId,
            sender,
          )
        : undefined;
    }

    const registration = parseRegistrationMessage(message);
    if (registration) {
      if (!this.isTrustedDevtoolsSender(sender)) {
        return undefined;
      }
      return this.registerDevtools(registration);
    }

    const command = parsePanelWindowCommand(message);
    if (command) {
      if (!this.isExpectedPanelSender(sender, command.channel)) {
        return undefined;
      }
      const binding = this.bindings.get(command.channel);
      if (!binding) {
        return this.panelPorts.has(command.channel)
          ? { ok: false, error: "stalePanel" }
          : undefined;
      }
      return this.executePanelWindowCommand(command, binding);
    }

    const domEvent = parseContentDomEventMessage(message);
    if (domEvent) {
      return this.publishContentDomEvent(
        domEvent.event,
        domEvent.contentSessionId,
        sender,
      );
    }
    if (stylesEvent) {
      const retiring = this.publishRetiringStylesInvalidation(
        stylesEvent.event,
        stylesEvent.contentSessionId,
        sender,
      );
      if (retiring) return retiring;
      return this.publishContentStylesEvent(
        stylesEvent.event,
        stylesEvent.contentSessionId,
        sender,
      );
    }

    const selection = parseElementSelectedMessage(message);
    if (!selection) {
      return this.contentRefreshCoordinator.routeMessage(message, sender);
    }
    return this.publishSelection(
      selection.payload,
      selection.selectionRevision,
      selection.contentSessionId,
      selection.republishToken,
      selection.selectionEvent,
      sender,
    );
  }

  public connectPort(port: BackgroundRuntimePort): void {
    if (this.disposed || this.disposing) {
      safeDisconnect(port);
      return;
    }
    const contentSessionId = parseInspectContentLeasePortName(port.name);
    if (contentSessionId) {
      this.connectContentLease(port, contentSessionId);
      return;
    }

    const channel = parseDevtoolsPanelPortName(port.name);
    if (
      !channel ||
      !this.isExpectedPanelSender(port.sender, channel) ||
      this.panelPorts.has(channel) ||
      this.panelPorts.size >= this.maxPanelPorts
    ) {
      safeDisconnect(port);
      return;
    }

    let record: PanelPortRecord;
    record = {
      channel,
      port,
      generation: this.allocateGeneration(),
      onDisconnect: () => this.closePanelPort(record, false),
      onMessage: (message) => this.rejectPendingInspect(record, message),
      inspectCommandTail: Promise.resolve(),
      windowStateRevision: 0,
      tabStateInitialized: false,
      tabStateInvalidatedByUnlink: false,
      republishedAvailabilityEpoch: 0,
      contentRecoveryAvailable: false,
      inspectionFailedClosed: false,
    };
    this.panelPorts.set(channel, record);
    port.onMessage.addListener(record.onMessage);
    port.onDisconnect.addListener(record.onDisconnect);

    const pending = this.pendingRegistrations.get(channel);
    if (pending && this.isCurrentPending(pending)) {
      pending.panelClosed = false;
    }
    const binding = this.bindings.get(channel);
    if (binding && !this.pendingRegistrations.has(channel)) {
      this.activatePanelPort(record, binding);
    }
  }

  public beforeControlledWindowTransition(
    transition: ControlledWindowTransition,
  ): Promise<boolean> {
    if (this.disposed || !isBrowserId(transition.windowId)) {
      return Promise.resolve(true);
    }
    const expected = this.expectedNestedWindowTransitions.get(
      transition.windowId,
    );
    if (
      expected?.kind === transition.kind &&
      this.isCurrentWindowCommand(transition.windowId, expected.commandToken)
    ) {
      this.expectedNestedWindowTransitions.delete(transition.windowId);
      return expected.prepared.promise;
    }
    return this.prepareControlledWindowTransition(
      transition.windowId,
      true,
    );
  }

  public beforeControlledTabTransition(
    tabId: number,
    command?: RefreshExecutionCommand,
  ): Promise<boolean> {
    if (this.disposed || !isBrowserId(tabId)) {
      return Promise.resolve(true);
    }
    return this.prepareControlledInspectTabTransition(tabId, command);
  }

  public async removeWindow(windowId: number): Promise<void> {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    await this.prepareControlledWindowTransition(windowId, false);
    if (this.disposed || this.removedWindows.has(windowId)) {
      return;
    }
    const tabRefreshRemoval = this.tabRefreshCoordinator.removeWindow(
      windowId,
    );
    this.contentRefreshCoordinator.revokeWindow(windowId);
    this.revokeInspectWindow(windowId);
    this.removedWindows.add(windowId);
    this.windowRefreshEpochs.delete(windowId);
    this.peerStates.delete(windowId);
    this.peerTransitionTails.delete(windowId);
    this.peerTransitionAuthorities.delete(windowId);
    this.availabilityStates.delete(windowId);
    const removedBindings = [...this.bindings.values()].filter(
      (binding) => !binding.suspended && binding.windowId === windowId,
    );
    for (const binding of removedBindings) {
      const port = this.panelPorts.get(binding.channel);
      if (port) {
        this.closePanelPort(port, true);
      }
      this.removeBinding(binding);
    }
    await Promise.all([
      tabRefreshRemoval,
      this.coordinator.removeWindow(windowId),
    ]);
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    let resolveDisposal!: () => void;
    this.disposePromise = new Promise<void>((resolve) => {
      resolveDisposal = resolve;
    });
    this.disposing = true;
    this.disposeGeneration += 1;

    for (const record of this.panelPorts.values()) {
      record.inspectPublicationToken = undefined;
    }
    for (const record of [...this.panelPorts.values()]) {
      this.closePanelPort(record, true);
    }
    this.disposed = true;
    this.disposing = false;
    const teardowns = [...this.panelTeardowns.values()].map(
      ({ promise }) => promise,
    );
    void this.finishDisposal(teardowns).then(resolveDisposal);
    return this.disposePromise;
  }

  private async finishDisposal(
    teardowns: readonly Promise<boolean>[],
  ): Promise<void> {
    try {
      await Promise.all(teardowns);
    } catch (error) {
      this.reportError(error);
    }
    for (const removeSubscription of this.removeSubscriptions.splice(0)) {
      try {
        removeSubscription();
      } catch (error) {
        this.reportError(error);
      }
    }
    this.pendingRegistrations.clear();
    this.panelCommands.clear();
    for (const commandToken of new Set(this.windowCommands.values())) {
      this.releaseWindowCommand(commandToken);
    }
    this.windowCommandCompletions.clear();
    this.expectedNestedWindowTransitions.clear();
    this.panelTeardowns.clear();
    this.requiredPanelTeardowns.clear();
    this.retiringInspectCleanups.clear();
    this.controlledInspectCleanups.clear();
    this.pendingTabRefreshTransitions.clear();
    this.pendingTabRefreshAdmissions.clear();
    this.bindings.clear();
    this.channelByTab.clear();
    this.channelBySource.clear();
    this.removedWindows.clear();
    this.peerBlockedWindows.clear();
    this.windowRefreshEpochs.clear();
    this.peerStates.clear();
    this.peerTransitionTails.clear();
    this.peerTransitionAuthorities.clear();
    this.availabilityStates.clear();
    try {
      this.contentRefreshCoordinator.dispose();
    } catch (error) {
      this.reportError(error);
    }
  }

  private attachSubscriptions(
    subscriptions: BackgroundRouterSubscriptions | undefined,
  ): void {
    if (!subscriptions) {
      return;
    }
    this.removeSubscriptions.push(
      subscriptions.subscribeRuntimeMessages((message, sender) =>
        this.routeMessage(message, sender),
      ),
      subscriptions.subscribeRuntimePorts((port) => this.connectPort(port)),
      subscriptions.subscribeWindowRemoved((windowId) => {
        void this.removeWindow(windowId).catch((error) =>
          this.reportError(error),
        );
      }),
      subscriptions.subscribeTabDetached((tabId, oldWindowId) => {
        this.suspendDetachedTab(tabId, oldWindowId);
      }),
      subscriptions.subscribeTabAttached((tabId, newWindowId) => {
        this.attachMovedTab(tabId, newWindowId);
      }),
    );
    if (subscriptions.subscribeTabActivated) {
      this.removeSubscriptions.push(
        subscriptions.subscribeTabActivated((tabId, windowId) => {
          void this.tabRefreshCoordinator
            .activateTab(tabId, windowId)
            .catch((error) => this.reportError(error));
        }),
      );
    }
    if (subscriptions.subscribeTabRemoved) {
      this.removeSubscriptions.push(
        subscriptions.subscribeTabRemoved((tabId) => {
          this.removeTab(tabId);
        }),
      );
    }
    if (subscriptions.subscribeTabUpdated) {
      this.removeSubscriptions.push(
        subscriptions.subscribeTabUpdated((tabId, update) => {
          void this.updateTab(tabId, update).catch((error) =>
            this.reportError(error),
          );
        }),
      );
    }
  }

  private removeTab(tabId: number): void {
    if (this.disposed || !isBrowserId(tabId)) {
      return;
    }
    const tabRefreshRemoval = this.tabRefreshCoordinator.removeTab(tabId);
    this.contentRefreshCoordinator.revokeTab(tabId);
    this.revokeInspectTab(tabId);
    this.cancelPendingRegistrationsForTab(tabId);
    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const port = channel ? this.panelPorts.get(channel) : undefined;
    if (port) {
      this.closePanelPort(port, true);
    }
    if (binding) {
      this.removeBinding(binding);
    }
    void tabRefreshRemoval.catch((error) => this.reportError(error));
    void this.contentRefreshCoordinator
      .removeTab(tabId)
      .catch((error) => this.reportError(error));
  }

  private cancelPendingRegistrationsForTab(tabId: number): void {
    const channels: string[] = [];
    for (const [channel, pending] of this.pendingRegistrations) {
      if (pending.tabId !== tabId || !this.isCurrentPending(pending)) {
        continue;
      }
      pending.panelClosed = true;
      this.pendingRegistrations.delete(channel);
      channels.push(channel);
    }
    for (const channel of channels) {
      const port = this.panelPorts.get(channel);
      if (port) {
        this.closePanelPort(port, true);
      }
    }
  }

  private suspendDetachedTab(tabId: number, oldWindowId: number): void {
    if (
      this.disposed ||
      !isBrowserId(tabId) ||
      !isBrowserId(oldWindowId)
    ) {
      return;
    }
    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = binding ? this.panelPorts.get(binding.channel) : undefined;
    const joinsExistingTeardown = Boolean(
      binding &&
      binding.tabId === tabId &&
      (binding.windowId === oldWindowId || binding.suspended) &&
      this.hasRequiredPanelTeardown(binding),
    );
    const moveRetirement =
      binding &&
        record &&
        !joinsExistingTeardown &&
        binding.tabId === tabId &&
        binding.windowId === oldWindowId &&
        !binding.suspended &&
        record.inspectSession &&
        record.contentSessionId
        ? this.requestPanelTeardown(binding, false, record, true)
        : undefined;
    const moveRetirementRequirement = moveRetirement && binding
      ? this.requiredPanelTeardowns.get(binding.channel)
      : undefined;
    const joinsRequiredTeardown = joinsExistingTeardown ||
      moveRetirement !== undefined;
    for (const pending of this.pendingRegistrations.values()) {
      if (pending.tabId === tabId && this.isCurrentPending(pending)) {
        pending.detachedWindowId = oldWindowId;
      }
    }
    const detach = (teardownCompleted = false): void => {
      const teardownRevokedTab = Boolean(
        teardownCompleted &&
        moveRetirementRequirement &&
        (!moveRetirementRequirement.preservePanelState ||
          moveRetirementRequirement.invalidateBinding),
      );
      if (
        !joinsRequiredTeardown ||
        (moveRetirement && !teardownRevokedTab)
      ) {
        this.contentRefreshCoordinator.revokeTab(tabId);
        this.revokeInspectTab(tabId);
      }
      void this.tabRefreshCoordinator
        .detachTab(tabId, oldWindowId)
        .catch((error) => this.reportError(error));
      void this.contentRefreshCoordinator
        .detachTab(tabId)
        .catch((error) => this.reportError(error));
    };
    if (
      !binding ||
      binding.tabId !== tabId ||
      binding.windowId !== oldWindowId ||
      binding.suspended
    ) {
      if (joinsExistingTeardown && binding) {
        const detachedBinding = binding.suspended
          ? {
              ...binding,
              generation: this.allocateGeneration(),
            }
          : binding;
        if (detachedBinding !== binding) {
          this.bindings.set(detachedBinding.channel, detachedBinding);
        }
        void this.awaitPanelTeardownForActivation(detachedBinding)
          .then(detach)
          .catch((error) => this.reportError(error));
      } else {
        detach();
      }
      return;
    }

    const suspended: ChannelBinding = {
      ...binding,
      generation: this.allocateGeneration(),
      suspended: true,
    };
    this.bindings.set(suspended.channel, suspended);
    if (record && !joinsRequiredTeardown) {
      this.clearPanelActivation(record, true);
    }
    if (joinsRequiredTeardown) {
      void (moveRetirement ?? this.awaitPanelTeardownForActivation(binding))
        .then(detach)
        .catch((error) => this.reportError(error));
    } else {
      detach();
    }
  }

  private attachMovedTab(tabId: number, newWindowId: number): void {
    if (
      this.disposed ||
      !isBrowserId(tabId) ||
      !isBrowserId(newWindowId)
    ) {
      return;
    }
    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    if (binding) {
      if (binding.tabId !== tabId || !binding.suspended) {
        return;
      }
      if (this.hasRequiredPanelTeardown(binding)) {
        const pendingBinding: ChannelBinding = {
          ...binding,
          windowId: newWindowId,
          generation: this.allocateGeneration(),
          suspended: true,
        };
        this.bindings.set(pendingBinding.channel, pendingBinding);
        void this.attachMovedBindingAfterTeardown(
          pendingBinding,
          newWindowId,
        );
        return;
      }
      const replacement = this.replaceBindingWindow(binding, newWindowId);
      const record = this.panelPorts.get(replacement.channel);
      if (record) {
        this.activatePanelPort(record, replacement);
      }
      return;
    }

    const pending = [...this.pendingRegistrations.values()]
      .filter(
        (candidate) =>
          candidate.tabId === tabId &&
          candidate.detachedWindowId !== undefined &&
          this.isCurrentPending(candidate),
      )
      .sort((left, right) => right.generation - left.generation)[0];
    if (
      !pending ||
      (this.channelBySource.has(pending.sourceId) &&
        this.channelBySource.get(pending.sourceId) !== pending.channel)
    ) {
      return;
    }
    const required = this.requiredPanelTeardowns.get(pending.channel);
    if (required) {
      void this.attachPendingAfterTeardown(
        pending,
        required.binding,
        newWindowId,
      );
      return;
    }
    const replacement: ChannelBinding = {
      channel: pending.channel,
      tabId: pending.tabId,
      sourceId: pending.sourceId,
      windowId: newWindowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    this.channelByTab.set(replacement.tabId, replacement.channel);
    this.channelBySource.set(replacement.sourceId, replacement.channel);
    const record = this.panelPorts.get(replacement.channel);
    if (record) {
      this.activatePanelPort(record, replacement);
    }
  }

  private replaceBindingWindow(
    binding: ChannelBinding,
    windowId: number,
  ): ChannelBinding {
    const replacement: ChannelBinding = {
      channel: binding.channel,
      tabId: binding.tabId,
      sourceId: binding.sourceId,
      windowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    return replacement;
  }

  private sourceRemainsAvailable(
    pending: PendingRegistration,
    supersededBinding: ChannelBinding,
  ): boolean {
    const channel = this.channelBySource.get(pending.sourceId);
    return channel === undefined ||
      channel === pending.channel ||
      channel === supersededBinding.channel;
  }

  private registerDevtools(
    identity: RegistrationIdentity,
  ): Promise<BackgroundRouteResult | undefined> {
    const currentBinding = this.bindings.get(identity.channel);
    if (currentBinding && !sameIdentity(currentBinding, identity)) {
      return Promise.resolve(undefined);
    }
    const currentPending = this.pendingRegistrations.get(identity.channel);
    if (currentPending) {
      return sameIdentity(currentPending, identity)
        ? currentPending.promise
        : Promise.resolve(undefined);
    }

    const pending: PendingRegistration = {
      ...identity,
      generation: this.allocateGeneration(),
      disposeGeneration: this.disposeGeneration,
      bindingGeneration: currentBinding?.generation,
      panelClosed: false,
      promise: Promise.resolve(undefined),
    };
    this.pendingRegistrations.set(identity.channel, pending);
    pending.promise = this.resolveRegistration(pending);
    return pending.promise;
  }

  private async resolveRegistration(
    pending: PendingRegistration,
  ): Promise<BackgroundRouteResult | undefined> {
    try {
      let tab: BackgroundTab | undefined;
      try {
        tab = await this.getTab(pending.tabId);
      } catch {
        return undefined;
      }
      if (!this.isCurrentPending(pending)) {
        return undefined;
      }
      if (pending.panelClosed) {
        return undefined;
      }
      const required = this.requiredPanelTeardowns.get(pending.channel);
      if (
        required &&
        !await this.awaitPanelTeardownForActivation(required.binding)
      ) {
        return undefined;
      }
      if (!this.isCurrentPending(pending) || pending.panelClosed) {
        return undefined;
      }
      const currentBinding = this.bindings.get(pending.channel);
      if (currentBinding) {
        if (!sameIdentity(currentBinding, pending)) {
          return undefined;
        }
        if (
          pending.bindingGeneration === undefined ||
          currentBinding.generation !== pending.bindingGeneration
        ) {
          const resolved = resolvedTab(tab, pending.tabId);
          const activeBinding =
            currentBinding.suspended &&
            resolved &&
            !this.removedWindows.has(resolved.windowId) &&
            currentBinding.windowId !== resolved.windowId
              ? this.replaceBindingWindow(currentBinding, resolved.windowId)
              : currentBinding;
          if (activeBinding.suspended) {
            return undefined;
          }
          const port = this.panelPorts.get(activeBinding.channel);
          if (port) {
            this.activatePanelPort(port, activeBinding);
          }
          return okResult;
        }
      }

      const resolved = resolvedTab(tab, pending.tabId);
      if (!resolved || this.removedWindows.has(resolved.windowId)) {
        return undefined;
      }

      if (currentBinding) {
        let activeBinding = currentBinding;
        if (currentBinding.windowId !== resolved.windowId) {
          const replacement: ChannelBinding = {
            channel: pending.channel,
            tabId: pending.tabId,
            sourceId: pending.sourceId,
            windowId: resolved.windowId,
            generation: pending.generation,
            suspended: false,
          };
          this.bindings.set(replacement.channel, replacement);
          activeBinding = replacement;
        }
        const port = this.panelPorts.get(activeBinding.channel);
        if (port) {
          this.activatePanelPort(port, activeBinding);
        }
        return okResult;
      }
      if (pending.bindingGeneration !== undefined) {
        return undefined;
      }
      if (pending.detachedWindowId === resolved.windowId) {
        return undefined;
      }

      const tabChannel = this.channelByTab.get(pending.tabId);
      const supersededBinding =
        tabChannel && tabChannel !== pending.channel
          ? this.bindings.get(tabChannel)
          : undefined;
      if (
        tabChannel &&
        tabChannel !== pending.channel &&
        (!supersededBinding ||
          supersededBinding.tabId !== pending.tabId ||
          supersededBinding.generation > pending.generation)
      ) {
        return undefined;
      }
      const sourceChannel = this.channelBySource.get(pending.sourceId);
      if (sourceChannel && sourceChannel !== pending.channel) {
        const sourceBinding = this.bindings.get(sourceChannel);
        if (
          !sourceBinding ||
          sourceBinding.tabId !== pending.tabId ||
          sourceBinding !== supersededBinding
        ) {
          return undefined;
        }
      }
      if (!this.isCurrentPending(pending)) {
        return undefined;
      }

      const binding: ChannelBinding = {
        channel: pending.channel,
        tabId: pending.tabId,
        sourceId: pending.sourceId,
        windowId: resolved.windowId,
        generation: pending.generation,
        suspended: false,
      };
      if (supersededBinding) {
        const supersededPort = this.panelPorts.get(
          supersededBinding.channel,
        );
        if (supersededPort) {
          this.closePanelPort(supersededPort, true);
        }
        if (
          this.hasRequiredPanelTeardown(supersededBinding) &&
          !await this.awaitPanelTeardownForActivation(supersededBinding)
        ) {
          return undefined;
        }
        if (
          !this.isCurrentPending(pending) ||
          pending.panelClosed ||
          this.bindings.get(supersededBinding.channel) !== supersededBinding ||
          this.channelByTab.get(pending.tabId) !== supersededBinding.channel ||
          !this.sourceRemainsAvailable(pending, supersededBinding)
        ) {
          return undefined;
        }
        this.removeBinding(supersededBinding);
      }
      this.bindings.set(binding.channel, binding);
      this.channelByTab.set(binding.tabId, binding.channel);
      this.channelBySource.set(binding.sourceId, binding.channel);
      const port = this.panelPorts.get(binding.channel);
      if (port) {
        this.activatePanelPort(port, binding);
      }
      return okResult;
    } finally {
      if (this.pendingRegistrations.get(pending.channel) === pending) {
        this.pendingRegistrations.delete(pending.channel);
      }
    }
  }

  private activatePanelPort(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): void {
    if (!this.canActivatePanelPort(record, binding)) {
      return;
    }
    if (!this.hasRequiredPanelTeardown(binding)) {
      this.activatePanelPortNow(record, binding);
      return;
    }
    void this.activatePanelPortAfterTeardown(record, binding);
  }

  private async activatePanelPortAfterTeardown(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): Promise<void> {
    if (!await this.awaitPanelTeardownForActivation(binding)) {
      return;
    }
    if (this.canActivatePanelPort(record, binding)) {
      this.activatePanelPortNow(record, binding);
    }
  }

  private async attachMovedBindingAfterTeardown(
    binding: ChannelBinding,
    newWindowId: number,
  ): Promise<void> {
    if (!await this.awaitPanelTeardownForActivation(binding)) {
      return;
    }
    if (
      this.disposed ||
      this.bindings.get(binding.channel) !== binding ||
      !binding.suspended
    ) {
      return;
    }
    const record = this.panelPorts.get(binding.channel);
    if (!record) {
      return;
    }
    let tab: BackgroundTab | undefined;
    let lookupFailed = false;
    try {
      tab = await this.getTab(binding.tabId);
    } catch {
      lookupFailed = true;
    }
    if (
      this.disposed ||
      this.panelPorts.get(record.channel) !== record ||
      this.bindings.get(binding.channel) !== binding ||
      !binding.suspended
    ) {
      return;
    }
    const resolved = resolvedTab(tab, binding.tabId);
    const resolvedWindowId = lookupFailed
      ? newWindowId
      : resolved?.windowId;
    if (
      resolvedWindowId === undefined ||
      this.removedWindows.has(resolvedWindowId)
    ) {
      await this.invalidatePanelBinding(binding);
      return;
    }
    const replacement = this.replaceBindingWindow(binding, resolvedWindowId);
    this.activatePanelPort(record, replacement);
  }

  private async attachPendingAfterTeardown(
    pending: PendingRegistration,
    binding: ChannelBinding,
    newWindowId: number,
  ): Promise<void> {
    if (!await this.awaitPanelTeardownForActivation(binding)) {
      return;
    }
    if (
      !this.isCurrentPending(pending) ||
      pending.panelClosed
    ) {
      return;
    }
    const sourceChannel = this.channelBySource.get(pending.sourceId);
    const tabChannel = this.channelByTab.get(pending.tabId);
    if (
      (sourceChannel && sourceChannel !== pending.channel) ||
      (tabChannel && tabChannel !== pending.channel)
    ) {
      return;
    }
    const current = this.bindings.get(pending.channel);
    if (current && (!sameIdentity(current, pending) || !current.suspended)) {
      return;
    }
    const replacement = current
      ? this.replaceBindingWindow(current, newWindowId)
      : {
          channel: pending.channel,
          tabId: pending.tabId,
          sourceId: pending.sourceId,
          windowId: newWindowId,
          generation: this.allocateGeneration(),
          suspended: false,
        };
    this.bindings.set(replacement.channel, replacement);
    this.channelByTab.set(replacement.tabId, replacement.channel);
    this.channelBySource.set(replacement.sourceId, replacement.channel);
    const record = this.panelPorts.get(replacement.channel);
    if (record) {
      this.activatePanelPort(record, replacement);
    }
  }

  private canActivatePanelPort(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): boolean {
    return (
      this.panelPorts.get(record.channel) === record &&
      this.bindings.get(binding.channel) === binding &&
      !binding.suspended &&
      !(
        record.bindingGeneration === binding.generation &&
        record.registration !== undefined
      )
    );
  }

  private activatePanelPortNow(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): void {
    if (
      !this.canActivatePanelPort(record, binding) ||
      this.hasRequiredPanelTeardown(binding)
    ) {
      return;
    }

    const preserveInspection = Boolean(
      record.inspectSession &&
        record.inspectTabId === binding.tabId &&
        record.inspectWindowId === binding.windowId,
    );
    const previousRepublishWindowId = record.republishWindowId;
    const previousRepublishedEpoch = record.republishedAvailabilityEpoch;
    this.clearPanelActivation(record, true, preserveInspection);
    if (!preserveInspection) {
      record.inspectionFailedClosed = false;
    }
    record.port.onMessage.removeListener(record.onMessage);
    const token = {};
    const windowStateQueue: WindowStateQueue = {
      tail: Promise.resolve(),
    };
    const onMessage = (message: unknown): void => {
      this.queueInspectRequest(record, token, message);
    };
    record.onMessage = onMessage;
    record.activationToken = token;
    record.bindingGeneration = binding.generation;
    record.windowStateQueue = windowStateQueue;
    record.lastWindowState = undefined;
    record.republishWindowId = binding.windowId;
    record.republishedAvailabilityEpoch =
      previousRepublishWindowId === binding.windowId
        ? previousRepublishedEpoch
        : (this.availabilityStates.get(binding.windowId)?.epoch ?? 0);
    record.port.onMessage.addListener(onMessage);

    let registration: { dispose(): void };
    try {
      registration = this.coordinator.registerPanel({
        windowId: binding.windowId,
        tabId: binding.tabId,
        sourceId: binding.sourceId,
        onStateChanged: (state, displayLinkCode, protocolMismatch) =>
          this.queueWindowState(
            record,
            token,
            binding,
            windowStateQueue,
            state,
            displayLinkCode,
            protocolMismatch,
          ),
      });
    } catch (error) {
      this.reportError(error);
      this.closePanelPort(record, true);
      return;
    }

    if (!this.isCurrentActivation(record, token, binding)) {
      registration.dispose();
      this.disposeInspectionSession(record, false);
      return;
    }
    record.registration = registration;
    void this.ensurePanelTabStateInitialized(
      record,
      token,
      binding,
    );
  }

  private async updateTab(
    tabId: number,
    update: BackgroundTabUpdate,
  ): Promise<void> {
    if (this.disposed || !isBrowserId(tabId)) return;
    const navigated = this.contentRefreshCoordinator.observeTabUpdate(
      tabId,
      update,
    );
    if (navigated) {
      this.revokeInspectTab(tabId);
    }
    let participant = false;
    if (isBrowserId(update.windowId)) {
      try {
        const state = await this.tabRefreshCoordinator.state(
          tabId,
          update.windowId,
        );
        participant = state.tabId === tabId &&
          state.windowId === update.windowId &&
          state.participant &&
          state.autoRefreshEnabled;
      } catch (error) {
        this.reportError(error);
      }
    }
    await this.contentRefreshCoordinator.tabUpdated(tabId, update, participant);
  }

  private ensurePanelTabStateInitialized(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
  ): Promise<boolean> {
    if (!this.isCurrentActivation(record, token, binding)) {
      return Promise.resolve(false);
    }
    if (record.tabStateInitialized) {
      return Promise.resolve(true);
    }
    const pending = record.tabStateInitialization;
    if (pending) {
      return pending;
    }
    const initialization = this.initializePanelTabState(
      record,
      token,
      binding,
      record.windowStateRevision,
    );
    record.tabStateInitialization = initialization;
    void initialization.then((initialized) => {
      if (record.tabStateInitialization !== initialization) {
        return;
      }
      record.tabStateInitialization = undefined;
      if (
        initialized &&
        this.isCurrentActivation(record, token, binding)
      ) {
        record.tabStateInitialized = true;
      }
    });
    return initialization;
  }

  private async restoreWindowPanelTabStatesAfterLink(
    windowId: number,
    commandRecord: PanelPortRecord,
    commandBinding: ChannelBinding,
    command: PanelCommandRecord,
  ): Promise<BackgroundCommandError | undefined> {
    if (
      !this.isCurrentWindowPanelCommand(
        windowId,
        commandRecord,
        commandBinding,
        command,
      )
    ) {
      return "stalePanel";
    }
    const activations = this.windowPanelTabStateActivations(windowId)
      .filter(({ record }) => record.tabStateInvalidatedByUnlink);
    const restored: PanelTabStateActivation[] = [];

    for (const activation of activations) {
      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }
      if (
        !this.isCurrentActivation(
          activation.record,
          activation.token,
          activation.binding,
        ) ||
        !activation.record.tabStateInvalidatedByUnlink
      ) {
        return "error";
      }
      const initialization = await this.ensurePanelTabStateInitialized(
        activation.record,
        activation.token,
        activation.binding,
      );
      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }
      if (
        !initialization ||
        !this.isCurrentActivation(
          activation.record,
          activation.token,
          activation.binding,
        ) ||
        !activation.record.tabStateInvalidatedByUnlink
      ) {
        return "error";
      }
      restored.push(activation);
    }

    for (const activation of restored) {
      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }
      const postflight = await this.refreshPanelBinding(
        activation.binding,
        activation.record,
        activation.token,
      );
      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }
      if (
        postflight !== activation.binding ||
        !this.isCurrentActivation(
          activation.record,
          activation.token,
          activation.binding,
        ) ||
        !activation.record.tabStateInvalidatedByUnlink
      ) {
        return "error";
      }
    }

    const restoreError = await this.commitRestoredPanelTabStates(
      restored,
      windowId,
      commandRecord,
      commandBinding,
      command,
    );
    if (restoreError) {
      return restoreError;
    }
    if (
      !this.isCurrentWindowPanelCommand(
        windowId,
        commandRecord,
        commandBinding,
        command,
      )
    ) {
      return "stalePanel";
    }
    return undefined;
  }

  private async commitRestoredPanelTabStates(
    activations: readonly PanelTabStateActivation[],
    windowId: number,
    commandRecord: PanelPortRecord,
    commandBinding: ChannelBinding,
    command: PanelCommandRecord,
  ): Promise<BackgroundCommandError | undefined> {
    const barriers = activations.map(({ record }) =>
      this.createPanelTabStateBarrier(record)
    );
    try {
      await Promise.all(barriers.map(({ ready }) => ready));
      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }

      const snapshots: Array<{
        readonly activation: PanelTabStateActivation;
        readonly state: TabRefreshState;
      }> = [];
      for (const activation of activations) {
        if (
          !this.isCurrentWindowPanelCommand(
            windowId,
            commandRecord,
            commandBinding,
            command,
          )
        ) {
          return "stalePanel";
        }
        if (
          !this.isCurrentActivation(
            activation.record,
            activation.token,
            activation.binding,
          ) ||
          !activation.record.tabStateInvalidatedByUnlink
        ) {
          return "error";
        }

        let state: TabRefreshState;
        try {
          state = await this.tabRefreshCoordinator.state(
            activation.binding.tabId,
            activation.binding.windowId,
          );
        } catch (error) {
          this.reportError(error);
          return "error";
        }

        if (
          !this.isCurrentWindowPanelCommand(
            windowId,
            commandRecord,
            commandBinding,
            command,
          )
        ) {
          return "stalePanel";
        }
        if (
          !this.isCurrentActivation(
            activation.record,
            activation.token,
            activation.binding,
          ) ||
          !activation.record.tabStateInvalidatedByUnlink
        ) {
          return "error";
        }
        snapshots.push({ activation, state });
      }

      if (
        !this.isCurrentWindowPanelCommand(
          windowId,
          commandRecord,
          commandBinding,
          command,
        )
      ) {
        return "stalePanel";
      }
      if (snapshots.some(({ activation }) =>
        !this.isCurrentActivation(
          activation.record,
          activation.token,
          activation.binding,
        ) ||
        !activation.record.tabStateInvalidatedByUnlink
      )) {
        return "error";
      }

      for (const { activation, state } of snapshots) {
        this.postToCurrentPort(
          activation.record,
          activation.token,
          createPanelTabStateMessage(state),
        );
        activation.record.tabStateInvalidatedByUnlink = false;
      }
      return undefined;
    } finally {
      for (const { release } of barriers) {
        release();
      }
    }
  }

  private createPanelTabStateBarrier(
    record: PanelPortRecord,
  ): { readonly ready: Promise<void>; release(): void } {
    let signalReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = record.inspectCommandTail
      .catch((error) => this.reportError(error))
      .then(() => {
        signalReady();
        return released;
      });
    record.inspectCommandTail = barrier.catch((error) =>
      this.reportError(error)
    );
    return { ready, release };
  }

  private windowPanelTabStateActivations(
    windowId: number,
  ): PanelTabStateActivation[] {
    const activations: PanelTabStateActivation[] = [];
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      const token = record.activationToken;
      if (
        binding?.windowId === windowId &&
        token &&
        record.registration &&
        this.isCurrentActivation(record, token, binding)
      ) {
        activations.push({ record, binding, token });
      }
    }
    return activations;
  }

  private invalidateWindowPanelTabStates(windowId: number): void {
    for (const { record } of this.windowPanelTabStateActivations(windowId)) {
      record.tabStateInitialization = undefined;
      record.tabStateInitialized = false;
      record.tabStateInvalidatedByUnlink = true;
    }
  }

  private async compensateFailedWindowRefreshRestore(
    windowId: number,
    commandToken: object,
  ): Promise<boolean> {
    if (!this.isCurrentWindowCommand(windowId, commandToken)) {
      return false;
    }
    this.beginWindowRefreshEpoch(windowId);
    this.peerBlockedWindows.add(windowId);
    const acknowledged = await this.prepareControlledWindowTransition(
      windowId,
      true,
    );
    if (!acknowledged) {
      this.reportError(new Error(
        "Failed refresh restore cleanup was not acknowledged",
      ));
    }
    if (!this.isCurrentWindowCommand(windowId, commandToken)) {
      return false;
    }
    this.contentRefreshCoordinator.revokeWindow(windowId);
    this.invalidateWindowPanelTabStates(windowId);
    try {
      await this.coordinator.unlinkWindow(windowId);
    } catch (error) {
      this.reportError(error);
    }
    if (!this.isCurrentWindowCommand(windowId, commandToken)) {
      return false;
    }
    try {
      await this.tabRefreshCoordinator.removeWindow(windowId);
    } catch (error) {
      this.reportError(error);
    }
    if (!this.isCurrentWindowCommand(windowId, commandToken)) {
      return false;
    }
    this.invalidateWindowPanelTabStates(windowId);
    return true;
  }

  private async initializePanelTabState(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
    revision: number,
  ): Promise<boolean> {
    try {
      const state = await this.tabRefreshCoordinator.panelOpened(
        binding.tabId,
        binding.windowId,
      );
      if (!this.isCurrentActivation(record, token, binding)) {
        return false;
      }
      if (
        record.windowStateRevision === revision &&
        record.lastWindowState !== "linked" &&
        !record.tabStateInvalidatedByUnlink
      ) {
        this.postToCurrentPort(
          record,
          token,
          createPanelTabStateMessage(state),
        );
      }
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private clearPanelActivation(
    record: PanelPortRecord,
    settlePendingInspect = false,
    preserveInspection = false,
  ): void {
    this.dropPendingTabRefreshTransition(record);
    record.pendingWindowTransitionSelection = undefined;
    this.controlledInspectCleanups.delete(record.channel);
    const activationToken = record.activationToken;
    if (preserveInspection) {
      this.revokeInspectChannel(record.channel);
      if (settlePendingInspect) {
        record.inspectSession?.suspend("stalePanel");
      }
    } else {
      this.disposeInspectionSession(record, settlePendingInspect);
    }
    record.activationToken = undefined;
    record.bindingGeneration = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    record.windowStateQueue = undefined;
    record.windowStateRevision += 1;
    record.tabStateInitialization = undefined;
    record.tabStateInitialized = false;
    record.tabStateInvalidatedByUnlink = false;
    record.lastWindowState = undefined;
    record.republishWindowId = undefined;
    record.republishInFlightEpoch = undefined;
    record.republishedAvailabilityEpoch = 0;
    if (activationToken) {
      this.abortPanelCommand(record, activationToken);
    }
    const registration = record.registration;
    record.registration = undefined;
    registration?.dispose();
  }

  private startInspectionSession(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): void {
    if (
      record.inspectSession ||
      record.panelSessionBinding ||
      record.inspectionFailedClosed
    ) {
      return;
    }
    record.contentRecoveryAvailable = false;
    record.contentSessionId = undefined;
    record.contentLeaseArrival?.settle();
    record.contentLeaseArrival = undefined;
    record.replacingContentSessionId = undefined;
    record.rejectPendingContentLeaseReplacements = undefined;
    record.pendingWindowTransitionSelection = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    record.contentLeaseArrival = createContentLeaseArrival();
    const panelSessionBinding = this.panelSessions.bind(
      record.channel,
      binding.tabId,
    );
    let session!: BackgroundInspectSession;
    session = new BackgroundInspectSession(
      this.inspectCoordinator,
      binding.tabId,
      (message) => {
        this.postToActiveChannel(record.channel, message);
      },
      {
        onContentLeaseReplacementStarted: (previousContentSessionId) => {
          if (
            this.panelPorts.get(record.channel) !== record ||
            record.inspectSession !== session ||
            record.contentSessionId !== previousContentSessionId
          ) {
            return;
          }
          record.replacingContentSessionId = previousContentSessionId;
          record.panelSessionBinding?.dispose();
          record.panelSessionBinding = this.panelSessions.bind(
            record.channel,
            binding.tabId,
          );
          const cleanup = this.controlledInspectCleanups.get(record.channel);
          const refreshTransition = this.pendingTabRefreshTransitions.get(
            record.channel,
          );
          const expectsReloadReplacement =
            refreshTransition?.mode === "reload" &&
            refreshTransition.cleanup === cleanup &&
            refreshTransition.contentSessionId === previousContentSessionId;
          if (
            cleanup?.contentSessionId === previousContentSessionId &&
            this.isCurrentControlledCleanup(cleanup) &&
            !expectsReloadReplacement
          ) {
            record.rejectPendingContentLeaseReplacements = true;
          }
        },
        onContentLeaseReplacing: (previousContentSessionId) => {
          if (
            this.panelPorts.get(record.channel) !== record ||
            record.inspectSession !== session ||
            record.contentSessionId !== previousContentSessionId
          ) {
            return;
          }
          this.revokeInspectChannel(record.channel);
          record.replacingContentSessionId = undefined;
          this.dropPendingTabRefreshTransition(record);
          record.pendingWindowTransitionSelection = undefined;
          this.controlledInspectCleanups.delete(record.channel);
          this.postToActiveChannel(record.channel, {
            type: "pin-op.inspect.invalidated",
            reason: "documentDisconnected",
          });
          record.panelSessionBinding?.dispose();
          record.panelSessionBinding = undefined;
          record.contentSessionId = undefined;
          record.stylesSelectionAuthority = undefined;
          record.stylesInvalidationAuthority = undefined;
          record.refreshRepublishAuthority = undefined;
          record.republishPublication = undefined;
          record.availabilityRepublish = undefined;
          record.contentRecoveryAvailable = false;
        },
        onContentLeaseAttached: (contentSessionId) => {
          if (
            this.panelPorts.get(record.channel) === record &&
            record.inspectSession === session
          ) {
            if (record.rejectPendingContentLeaseReplacements) {
              record.inspectionFailedClosed = true;
              this.disposeInspectionSession(record, false);
              return;
            }
            record.replacingContentSessionId = undefined;
            this.dropPendingTabRefreshTransition(record);
            record.pendingWindowTransitionSelection = undefined;
            this.controlledInspectCleanups.delete(record.channel);
            if (!record.panelSessionBinding) {
              record.panelSessionBinding = this.panelSessions.bind(
                record.channel,
                binding.tabId,
              );
            }
            const previousContentSessionId = record.contentSessionId;
            if (
              previousContentSessionId &&
              previousContentSessionId !== contentSessionId
            ) {
              this.postToActiveChannel(record.channel, {
                type: "pin-op.inspect.invalidated",
                reason: "documentDisconnected",
              });
            }
            record.contentSessionId = contentSessionId;
            record.contentLeaseEverAttached = true;
            record.contentLeaseArrival?.settle();
            record.contentLeaseArrival = undefined;
            record.stylesSelectionAuthority = undefined;
            record.stylesInvalidationAuthority = undefined;
            record.refreshRepublishAuthority = undefined;
            record.republishPublication = undefined;
            record.availabilityRepublish = undefined;
            record.contentRecoveryAvailable = true;
            record.inspectionFailedClosed = false;
          }
        },
        onInvalidated: (reason) =>
          this.handleInspectionInvalidation(record, session, reason),
      },
    );
    record.panelSessionBinding = panelSessionBinding;
    record.inspectSession = session;
    record.inspectTabId = binding.tabId;
    record.inspectWindowId = binding.windowId;
  }

  private handleInspectionInvalidation(
    record: PanelPortRecord,
    session: BackgroundInspectSession,
    reason: InspectSessionInvalidationReason,
  ): void {
    if (
      this.panelPorts.get(record.channel) !== record ||
      record.inspectSession !== session
    ) {
      return;
    }
    record.contentSessionId = undefined;
    record.contentLeaseArrival?.settle();
    record.contentLeaseArrival = undefined;
    record.replacingContentSessionId = undefined;
    record.rejectPendingContentLeaseReplacements = undefined;
    record.pendingWindowTransitionSelection = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    const binding = this.bindings.get(record.channel);
    const token = record.activationToken;
    const recover = reason === "documentDisconnected" &&
      record.contentRecoveryAvailable &&
      token !== undefined &&
      binding !== undefined &&
      this.isCurrentActivation(record, token, binding) &&
      canRecoverInspectionSession(
        record.lastWindowState,
        this.browserLocalInspection,
      );
    record.contentRecoveryAvailable = false;
    if (!recover) {
      record.inspectionFailedClosed = true;
    }
    this.disposeInspectionSession(record, false);
    if (!recover || !binding) {
      return;
    }
    try {
      this.startInspectionSession(record, binding);
    } catch (error) {
      record.inspectionFailedClosed = true;
      this.reportError(error);
    }
  }

  private disposeInspectionSession(
    record: PanelPortRecord,
    settlePendingInspect: boolean,
  ): void {
    this.dropPendingTabRefreshTransition(record);
    record.pendingWindowTransitionSelection = undefined;
    this.controlledInspectCleanups.delete(record.channel);
    const session = record.inspectSession;
    record.inspectSession = undefined;
    record.inspectTabId = undefined;
    record.inspectWindowId = undefined;
    record.contentSessionId = undefined;
    record.contentLeaseArrival?.settle();
    record.contentLeaseArrival = undefined;
    record.replacingContentSessionId = undefined;
    record.rejectPendingContentLeaseReplacements = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    record.panelSessionBinding?.dispose();
    record.panelSessionBinding = undefined;
    record.contentRecoveryAvailable = false;
    this.panelSessions.disposeChannel(record.channel);
    this.revokeInspectChannel(record.channel);
    if (settlePendingInspect) {
      session?.retire("stalePanel");
    } else {
      session?.disconnect();
    }
  }

  private closePanelPort(record: PanelPortRecord, disconnect: boolean): void {
    if (this.panelPorts.get(record.channel) !== record) {
      return;
    }
    const binding = this.bindings.get(record.channel);
    const token = record.activationToken;
    const activeBinding = binding && token &&
        this.isCurrentActivation(record, token, binding)
      ? binding
      : undefined;
    const requiredTeardown = binding
      ? this.requiredPanelTeardowns.get(binding.channel)
      : undefined;
    const joinsRequiredTeardown = Boolean(
      binding &&
      requiredTeardown &&
      sameIdentity(requiredTeardown.binding, binding),
    );
    const pending = this.pendingRegistrations.get(record.channel);
    const closedPending = pending && this.isCurrentPending(pending)
      ? pending
      : undefined;
    if (closedPending) {
      closedPending.panelClosed = true;
    }
    const tabOwnerChannel = closedPending
      ? this.channelByTab.get(closedPending.tabId)
      : undefined;
    const pendingOwnsTab = !tabOwnerChannel ||
      tabOwnerChannel === record.channel;
    const closedTabId = activeBinding?.tabId ??
      (closedPending && pendingOwnsTab ? closedPending.tabId : undefined);
    const closedWindowId = activeBinding?.windowId ??
      (binding && closedPending && sameIdentity(binding, closedPending)
        ? binding.windowId
        : undefined);
    this.panelPorts.delete(record.channel);
    record.port.onMessage.removeListener(record.onMessage);
    record.port.onDisconnect.removeListener(record.onDisconnect);
    if (!activeBinding && joinsRequiredTeardown && binding) {
      void this.requestPanelTeardown(binding, false, record, false)
        .then(() => this.clearRetiredPanelActivation(record))
        .catch((error) => this.reportError(error));
    } else if (!activeBinding) {
      this.clearPanelActivation(record);
    }
    if (closedTabId !== undefined) {
      if (activeBinding) {
        void this.requestPanelTeardown(activeBinding, false, record);
      } else if (!joinsRequiredTeardown) {
        this.contentRefreshCoordinator.revokeTab(closedTabId);
        void this.tabRefreshCoordinator
          .panelClosed(closedTabId, closedWindowId)
          .catch((error) => this.reportError(error));
      }
    }
    if (disconnect) {
      safeDisconnect(record.port);
    }
  }

  private rejectPendingInspect(
    record: PanelPortRecord,
    message: unknown,
  ): void {
    const request = parseInspectPortRequest(message);
    if (!request || this.panelPorts.get(record.channel) !== record) {
      return;
    }
    try {
      record.port.postMessage({
        type: "pin-op.inspect.result",
        requestId: request.requestId,
        ok: false,
        error: "stalePanel",
      });
    } catch {
      // Port teardown owns eventual cleanup.
    }
  }

  private async executePanelWindowCommand(
    command: PanelWindowCommand,
    binding: ChannelBinding,
  ): Promise<BackgroundRouteResult> {
    const record = this.panelPorts.get(command.channel);
    const activationToken = record?.activationToken;
    if (
      !record ||
      !activationToken ||
      !record.registration ||
      !this.isCurrentActivation(record, activationToken, binding)
    ) {
      return { ok: false, error: "stalePanel" };
    }
    const pendingCommand = this.panelCommands.get(command.channel);
    if (pendingCommand?.activationToken === activationToken) {
      return { ok: false, error: "busy" };
    }

    if (command.type === "pin-op.linkWindow") {
      try {
        parseLinkCode(command.code);
      } catch {
        return { ok: false, error: "invalidCode" };
      }
    }

    let leasedWindowId = binding.windowId;
    if (this.windowCommands.has(leasedWindowId)) {
      return { ok: false, error: "busy" };
    }
    const commandToken = {};
    this.acquireWindowCommand(leasedWindowId, commandToken);
    let dispatchedBinding: ChannelBinding | undefined;
    let dispatchedCommand: PanelCommandRecord | undefined;
    let unlinkTransition: PreparedControlledWindowTransition | undefined;
    try {
      const pendingRecord: PanelCommandRecord = {
        commandToken,
        activationToken,
      };
      this.panelCommands.set(command.channel, pendingRecord);
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentActivationToken = record.activationToken;
      if (
        !refreshed ||
        !currentActivationToken ||
        !record.registration ||
        this.panelCommands.get(command.channel)?.commandToken !== commandToken ||
        !this.isCurrentWindowCommand(leasedWindowId, commandToken) ||
        !this.isCurrentActivation(
          record,
          currentActivationToken,
          refreshed,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      let source: ClientSource;
      try {
        source = ClientSourceSchema.parse({
          role: "browser",
          id: refreshed.sourceId,
          metadata: {},
        });
      } catch {
        return { ok: false, error: "stalePanel" };
      }
      if (refreshed.windowId !== leasedWindowId) {
        if (!this.isCurrentWindowCommand(leasedWindowId, commandToken)) {
          return { ok: false, error: "stalePanel" };
        }
        if (this.windowCommands.has(refreshed.windowId)) {
          return { ok: false, error: "busy" };
        }
        this.releaseWindowCommandForWindow(leasedWindowId, commandToken);
        leasedWindowId = refreshed.windowId;
        this.acquireWindowCommand(leasedWindowId, commandToken);
      }

      const abortController = new AbortController();
      const dispatchedRecord: PanelCommandRecord = {
        commandToken,
        activationToken: currentActivationToken,
        bindingGeneration: refreshed.generation,
        abortController,
      };
      this.panelCommands.set(command.channel, dispatchedRecord);
      dispatchedBinding = refreshed;
      dispatchedCommand = dispatchedRecord;

      if (command.type === "pin-op.linkWindow") {
        this.peerBlockedWindows.delete(refreshed.windowId);
        await this.tabRefreshCoordinator.beginWindowEpoch(refreshed.windowId);
        if (
          !this.isCurrentWindowPanelCommand(
            refreshed.windowId,
            record,
            refreshed,
            dispatchedRecord,
          )
        ) {
          return { ok: false, error: "stalePanel" };
        }
        this.beginWindowRefreshEpoch(refreshed.windowId);
        await this.coordinator.linkWindow(
          refreshed.windowId,
          command.code,
          source,
          abortController.signal,
        );
      } else {
        this.beginWindowRefreshEpoch(refreshed.windowId);
        this.peerBlockedWindows.add(refreshed.windowId);
        unlinkTransition = this.beginControlledWindowTransition(
          refreshed.windowId,
          true,
        );
        const acknowledged = await unlinkTransition.promise;
        if (!acknowledged) {
          this.reportError(new Error(
            "Window unlink cleanup was not acknowledged",
          ));
        }
        if (
          !this.isCurrentWindowPanelCommand(
            refreshed.windowId,
            record,
            refreshed,
            dispatchedRecord,
          )
        ) {
          return { ok: false, error: "stalePanel" };
        }
        this.contentRefreshCoordinator.revokeWindow(refreshed.windowId);
        await this.invokeCoordinatorUnlink(
          refreshed.windowId,
          abortController.signal,
          commandToken,
          unlinkTransition,
        );
        this.invalidateWindowPanelTabStates(refreshed.windowId);
        await this.tabRefreshCoordinator.removeWindow(refreshed.windowId);
        this.invalidateWindowPanelTabStates(refreshed.windowId);
      }
      if (
        !this.isCurrentWindowPanelCommand(
          refreshed.windowId,
          record,
          refreshed,
          dispatchedRecord,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      // A completed coordinator side effect cannot always be rolled back. The
      // postflight prevents acknowledging it to a panel that silently moved.
      const postflight = await this.refreshPanelBinding(
        refreshed,
        record,
        dispatchedRecord.activationToken,
      );
      if (
        postflight !== refreshed ||
        !this.isCurrentWindowPanelCommand(
          refreshed.windowId,
          record,
          refreshed,
          dispatchedRecord,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      if (
        command.type === "pin-op.linkWindow" &&
        this.windowPanelTabStateActivations(refreshed.windowId).some(
          ({ record: candidate }) =>
            candidate.tabStateInvalidatedByUnlink,
        )
      ) {
        const restoreError = await this.restoreWindowPanelTabStatesAfterLink(
          refreshed.windowId,
          record,
          refreshed,
          dispatchedRecord,
        );
        if (restoreError) {
          const compensated = await this.compensateFailedWindowRefreshRestore(
            refreshed.windowId,
            commandToken,
          );
          if (!compensated) {
            return { ok: false, error: "stalePanel" };
          }
          return { ok: false, error: restoreError };
        }
      }
      if (
        !this.isCurrentWindowPanelCommand(
          refreshed.windowId,
          record,
          refreshed,
          dispatchedRecord,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      return okResult;
    } catch (error) {
      if (!dispatchedBinding || !dispatchedCommand) {
        return { ok: false, error: "stalePanel" };
      }
      const postflight = await this.refreshPanelBinding(
        dispatchedBinding,
        record,
        dispatchedCommand.activationToken,
      );
      if (
        postflight !== dispatchedBinding ||
        !this.isCurrentWindowPanelCommand(
          dispatchedBinding.windowId,
          record,
          dispatchedBinding,
          dispatchedCommand,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      const commandError = sanitizedCommandError(error);
      if (commandError === "error") {
        this.reportError(new Error("Pin-op panel command failed"));
      }
      return { ok: false, error: commandError };
    } finally {
      if (
        this.panelCommands.get(command.channel)?.commandToken === commandToken
      ) {
        this.panelCommands.delete(command.channel);
      }
      this.releasePendingWindowTransitionSelections(leasedWindowId);
      this.releaseWindowCommand(commandToken);
      if (unlinkTransition) {
        this.releasePreparedControlledWindowTransition(unlinkTransition);
      }
    }
  }

  private queueInspectRequest(
    record: PanelPortRecord,
    activationToken: object,
    message: unknown,
  ): void {
    const settings = parsePanelTabSettingsCommand(message);
    if (settings) {
      if (record.lastWindowState !== "incompatible") {
        this.queueTabSettings(record, activationToken, settings);
      }
      return;
    }
    if (record.lastWindowState === "incompatible") {
      const request = parseInspectPortRequest(message);
      if (request) {
        this.postInspectFailure(record, request.requestId);
      }
      return;
    }
    const request = parseInspectPortRequest(message);
    if (!request) {
      const rulesOpen = parsePanelRulesOpenCommand(message);
      if (rulesOpen) {
        this.publishRulesOpen(record, activationToken, rulesOpen);
        return;
      }
      const sourceOpen = parsePanelSourceOpenCommand(message);
      if (sourceOpen) {
        this.publishSourceOpen(record, activationToken, sourceOpen);
        return;
      }
      const presentationSettings = parsePanelPresentationSettingsCommand(
        message,
      );
      if (presentationSettings) {
        this.publishPresentationSettings(
          record,
          activationToken,
          presentationSettings,
        );
        return;
      }
      const navigation = parsePanelSourceNavigateCommand(message);
      if (navigation) {
        this.publishSourceNavigation(record, activationToken, navigation);
        return;
      }
      const inspectorRequest = parseInspectorLocalRequest(message);
      if (
        inspectorRequest?.type === "styles.getMatched" ||
        inspectorRequest?.type === "styles.setPseudoStates"
      ) {
        this.queueStylesRequest(record, activationToken, inspectorRequest);
        return;
      }
      if (inspectorRequest) {
        this.queueDomRequest(record, activationToken, inspectorRequest);
        return;
      }
      const stylesRequestId = readInspectorQueryRequestId(
        message,
        "styles.getMatched",
      ) ?? readInspectorQueryRequestId(message, "styles.setPseudoStates");
      if (stylesRequestId) {
        this.postStylesQueryError(record, stylesRequestId, "invalid-request");
        return;
      }
      const requestId = readInspectorQueryRequestId(message);
      if (requestId) this.postDomQueryError(record, requestId, "invalid-request");
      return;
    }
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentToken = record.activationToken;
      const session = record.inspectSession;
      if (
        !refreshed ||
        !currentToken ||
        !session ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }

      const outcome = await session.execute(request);
      if (!outcome || outcome.delivered) {
        return;
      }
      if (
        record.activationToken !== currentToken ||
        record.inspectSession !== session ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }
      const postflight = await this.refreshPanelBinding(
        refreshed,
        record,
        currentToken,
      );
      if (
        postflight !== refreshed ||
        record.activationToken !== currentToken ||
        record.inspectSession !== session ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }
      this.postToCurrentPort(record, currentToken, outcome.result);
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
      this.postInspectFailure(record, request.requestId);
    });
  }

  private queueTabSettings(
    record: PanelPortRecord,
    activationToken: object,
    settings: TabRefreshSettings,
  ): void {
    const currentBinding = this.bindings.get(record.channel);
    if (
      !settings.autoRefreshEnabled &&
      currentBinding &&
      this.isCurrentActivation(record, activationToken, currentBinding)
    ) {
      this.contentRefreshCoordinator.revokeTab(currentBinding.tabId);
    }
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        isProtocolIncompatible(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const token = record.activationToken;
      if (
        !refreshed ||
        !token ||
        isProtocolIncompatible(record) ||
        !this.isCurrentActivation(record, token, refreshed)
      ) {
        return;
      }
      const state = await this.tabRefreshCoordinator.updateSettings(
        refreshed.tabId,
        refreshed.windowId,
        {
          autoRefreshEnabled: settings.autoRefreshEnabled,
          ideHighlightEnabled: settings.ideHighlightEnabled,
        },
      );
      if (this.isCurrentActivation(record, token, refreshed)) {
        this.postToCurrentPort(
          record,
          token,
          createPanelTabStateMessage(state),
        );
      }
    });
    record.inspectCommandTail = operation.catch((error) =>
      this.reportError(error),
    );
  }

  private publishSourceNavigation(
    record: PanelPortRecord,
    activationToken: object,
    navigation: PanelSourceNavigateCommand,
  ): void {
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding) ||
        !this.correlations.authorizeNavigation({
          channel: record.channel,
          inspectMessageId: navigation.inspectMessageId,
          resolutionGeneration: navigation.resolutionGeneration,
          tabId: binding.tabId,
        })
      ) {
        return;
      }

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      if (
        refreshed !== binding ||
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding) ||
        !this.correlations.authorizeNavigation({
          channel: record.channel,
          inspectMessageId: navigation.inspectMessageId,
          resolutionGeneration: navigation.resolutionGeneration,
          tabId: binding.tabId,
        })
      ) {
        return;
      }

      let outcome: SourceNavigationSendOutcome;
      try {
        outcome = this.coordinator.publishSourceNavigation(binding.windowId, {
          inspectMessageId: navigation.inspectMessageId,
          resolutionGeneration: navigation.resolutionGeneration,
          direction: navigation.direction,
        });
      } catch (error) {
        this.reportError(error);
        outcome = "transport-error";
      }
      if (outcome === "sent") {
        return;
      }
      if (
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding) ||
        !this.correlations.authorizeNavigation({
          channel: record.channel,
          inspectMessageId: navigation.inspectMessageId,
          resolutionGeneration: navigation.resolutionGeneration,
          tabId: binding.tabId,
        })
      ) {
        return;
      }
      this.correlations.discard(navigation.inspectMessageId);
      this.panelSessions.publishIdeDisconnected(
        record.channel,
        navigation.inspectMessageId,
      );
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
    });
  }

  private publishSourceOpen(
    record: PanelPortRecord,
    activationToken: object,
    command: PanelSourceOpenCommand,
  ): void {
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }
      const authority = this.correlations.authorizeSourceOpen({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
        resolutionGeneration: command.resolutionGeneration,
        matchId: command.matchId,
      });
      if (!authority) {
        return;
      }

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentAuthority = this.correlations.authorizeSourceOpen({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
        resolutionGeneration: command.resolutionGeneration,
        matchId: command.matchId,
      });
      if (
        refreshed !== binding ||
        !record.registration ||
        !currentAuthority ||
        currentAuthority.context !== authority.context ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }

      let outcome: SourcePresentationSendOutcome;
      try {
        outcome = this.coordinator.publishSourceOpen(authority.context, {
          inspectMessageId: command.inspectMessageId,
          resolutionGeneration: command.resolutionGeneration,
          matchId: command.matchId,
        });
      } catch (error) {
        this.reportError(error);
        outcome = "transport-error";
      }
      await this.finishSourcePresentation(
        record,
        activationToken,
        binding,
        authority,
        outcome,
      );
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
    });
  }

  private publishRulesOpen(
    record: PanelPortRecord,
    activationToken: object,
    command: PanelRulesOpenCommand,
  ): void {
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }
      const authority = this.correlations.authorizeRulesOpen({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
        rulesGeneration: command.rulesGeneration,
        openAuthorityId: command.openAuthorityId,
      });
      if (!authority) return;

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentAuthority = this.correlations.authorizeRulesOpen({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
        rulesGeneration: command.rulesGeneration,
        openAuthorityId: command.openAuthorityId,
      });
      if (
        refreshed !== binding ||
        !record.registration ||
        !currentAuthority ||
        currentAuthority.context !== authority.context ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }

      let outcome: SourcePresentationSendOutcome;
      try {
        outcome = this.coordinator.publishRulesOpen(authority.context, {
          inspectMessageId: command.inspectMessageId,
          rulesGeneration: command.rulesGeneration,
          openAuthorityId: command.openAuthorityId,
        });
      } catch (error) {
        this.reportError(error);
        outcome = "transport-error";
      }
      await this.finishRulesOpen(
        record,
        activationToken,
        binding,
        authority,
        outcome,
      );
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
    });
  }

  private async finishRulesOpen(
    record: PanelPortRecord,
    activationToken: object,
    binding: ChannelBinding,
    authority: RulesOpenAuthority,
    outcome: SourcePresentationSendOutcome,
  ): Promise<void> {
    const postflight = await this.refreshPanelBinding(
      binding,
      record,
      activationToken,
    );
    if (
      postflight !== binding ||
      !record.registration ||
      this.hasInspectTransitionGate(record) ||
      !this.isCurrentActivation(record, activationToken, binding) ||
      outcome === "sent" ||
      !this.correlations.discardRulesOpenAuthority(authority)
    ) {
      return;
    }
    this.panelSessions.publishIdeDisconnected(
      record.channel,
      authority.inspectMessageId,
    );
  }

  private publishPresentationSettings(
    record: PanelPortRecord,
    activationToken: object,
    command: PanelPresentationSettingsCommand,
  ): void {
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        !record.registration ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }
      const authority = this.correlations.authorizePresentationSettings({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
      });
      if (!authority) {
        return;
      }

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentAuthority = this.correlations.authorizePresentationSettings({
        channel: record.channel,
        tabId: binding.tabId,
        windowId: binding.windowId,
        inspectMessageId: command.inspectMessageId,
      });
      if (
        refreshed !== binding ||
        !record.registration ||
        !currentAuthority ||
        currentAuthority.context !== authority.context ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }

      let outcome: SourcePresentationSendOutcome;
      try {
        outcome = this.coordinator.publishPresentationSettings(
          authority.context,
          {
            inspectMessageId: command.inspectMessageId,
            ideHighlightEnabled: command.ideHighlightEnabled,
          },
        );
      } catch (error) {
        this.reportError(error);
        outcome = "transport-error";
      }
      await this.finishSourcePresentation(
        record,
        activationToken,
        binding,
        authority,
        outcome,
      );
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
    });
  }

  private async finishSourcePresentation(
    record: PanelPortRecord,
    activationToken: object,
    binding: ChannelBinding,
    authority: SourceOpenAuthority | PresentationSettingsAuthority,
    outcome: SourcePresentationSendOutcome,
  ): Promise<void> {
    const postflight = await this.refreshPanelBinding(
      binding,
      record,
      activationToken,
    );
    if (
      postflight !== binding ||
      !record.registration ||
      this.hasInspectTransitionGate(record) ||
      !this.isCurrentActivation(record, activationToken, binding)
    ) {
      return;
    }
    if (outcome === "sent") {
      return;
    }
    if (!this.correlations.discardSourcePresentationAuthority(authority)) {
      return;
    }
    this.panelSessions.publishIdeDisconnected(
      record.channel,
      authority.inspectMessageId,
    );
  }

  private queueDomRequest(
    record: PanelPortRecord,
    activationToken: object,
    request: DomRequest,
  ): void {
    const requestId = domQueryRequestId(request);
    const settleQuery = (code: DomErrorCode): void => {
      if (requestId) {
        this.postDomQueryError(record, requestId, code);
      }
    };
    const queuedContentSessionId = record.contentSessionId;
    const queuedInspectSession = record.inspectSession;
    const operation = record.inspectCommandTail.then(async () => {
      const contentSessionId = await this.resolveQueuedContentSession(
        record,
        queuedContentSessionId,
        queuedInspectSession,
      );
      const binding = this.bindings.get(record.channel);
      if (
        !contentSessionId ||
        record.contentSessionId !== contentSessionId ||
        this.hasInspectTransitionGate(record) ||
        !binding ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settleQuery("session-disposed");
        return;
      }
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      if (
        refreshed !== binding ||
        record.contentSessionId !== contentSessionId ||
        record.activationToken !== activationToken ||
        !record.inspectSession ||
        !record.panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settleQuery("session-disposed");
        return;
      }
      const inspectSession = record.inspectSession;
      const panelSessionBinding = record.panelSessionBinding;
      await inspectSession.whenIdle();
      if (
        record.inspectSession !== inspectSession ||
        record.contentSessionId !== contentSessionId ||
        record.panelSessionBinding !== panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settleQuery("session-disposed");
        return;
      }
      if (requestId) {
        const response = await this.panelSessions.request(record.channel, request);
        if (
        record.inspectSession !== inspectSession ||
        record.contentSessionId !== contentSessionId ||
        record.panelSessionBinding !== panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
        ) {
          settleQuery("session-disposed");
          return;
        }
        this.postToCurrentPort(record, activationToken, response);
        return;
      }
      await this.panelSessions.dispatch(record.channel, request);
      if (
        record.inspectSession !== inspectSession ||
        record.contentSessionId !== contentSessionId ||
        record.panelSessionBinding !== panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        return;
      }
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
      settleQuery("internal-error");
    });
  }

  /**
   * Resolves the content session a queued read belongs to. A panel that opens --
   * or that reconnects to a background the browser had suspended -- takes its
   * first read while the content lease is still being attached; that is a
   * session on its way in, not a disposed one, so wait for the lease this very
   * inspection session establishes instead of failing the read closed. The wait
   * ends with the lease or with the session's teardown, never on a timer. Once
   * this panel has held a content lease the wait is over for good: a later read
   * without one crossed a session boundary the panel was told about, and it
   * still fails closed.
   */
  private async resolveQueuedContentSession(
    record: PanelPortRecord,
    queuedContentSessionId: ContentSessionId | undefined,
    queuedInspectSession: BackgroundInspectSession | undefined,
  ): Promise<ContentSessionId | undefined> {
    if (
      queuedContentSessionId !== undefined ||
      record.contentLeaseEverAttached ||
      queuedInspectSession === undefined ||
      record.inspectSession !== queuedInspectSession
    ) {
      return queuedContentSessionId;
    }
    await record.contentLeaseArrival?.ready;
    return record.inspectSession === queuedInspectSession
      ? record.contentSessionId
      : undefined;
  }

  private queueStylesRequest(
    record: PanelPortRecord,
    activationToken: object,
    request: StylesRequest,
  ): void {
    const settle = (code: StylesErrorCode): void => {
      this.postStylesQueryError(record, request.requestId, code);
    };
    const queuedContentSessionId = record.contentSessionId;
    const queuedInspectSession = record.inspectSession;
    const operation = record.inspectCommandTail.then(async () => {
      const contentSessionId = await this.resolveQueuedContentSession(
        record,
        queuedContentSessionId,
        queuedInspectSession,
      );
      const binding = this.bindings.get(record.channel);
      if (
        !contentSessionId ||
        record.contentSessionId !== contentSessionId ||
        this.hasInspectTransitionGate(record) ||
        !binding ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settle("cancelled");
        return;
      }
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      if (
        refreshed !== binding ||
        record.contentSessionId !== contentSessionId ||
        record.activationToken !== activationToken ||
        !record.inspectSession ||
        !record.panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settle("cancelled");
        return;
      }
      const inspectSession = record.inspectSession;
      const panelSessionBinding = record.panelSessionBinding;
      await inspectSession.whenIdle();
      if (
        record.inspectSession !== inspectSession ||
        record.contentSessionId !== contentSessionId ||
        record.panelSessionBinding !== panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settle("cancelled");
        return;
      }
      const response = await this.panelSessions.requestStyles(
        record.channel,
        request,
      );
      if (
        record.inspectSession !== inspectSession ||
        record.contentSessionId !== contentSessionId ||
        record.panelSessionBinding !== panelSessionBinding ||
        this.hasInspectTransitionGate(record) ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settle("cancelled");
        return;
      }
      this.postToCurrentPort(record, activationToken, response);
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
      settle("internal-error");
    });
  }

  private postStylesQueryError(
    record: PanelPortRecord,
    requestId: string,
    code: StylesErrorCode,
  ): void {
    if (this.panelPorts.get(record.channel) !== record) return;
    let response: ReturnType<typeof parseStylesResponse>;
    try {
      response = parseStylesResponse({ type: "styles.error", requestId, code });
    } catch {
      return;
    }
    try {
      record.port.postMessage(response);
    } catch {
      // A disconnected original port rejects its own pending panel request.
    }
  }

  private postDomQueryError(
    record: PanelPortRecord,
    requestId: string,
    code: DomErrorCode,
  ): void {
    if (this.panelPorts.get(record.channel) !== record) {
      return;
    }
    const response = parseDomResponse({
      type: "dom.error",
      requestId,
      code,
    });
    try {
      record.port.postMessage(response);
    } catch {
      // A disconnected original port rejects its own pending panel request.
    }
  }

  private async refreshPanelBinding(
    binding: ChannelBinding,
    record: PanelPortRecord,
    activationToken: object,
  ): Promise<ChannelBinding | undefined> {
    if (!this.isCurrentActivation(record, activationToken, binding)) {
      return undefined;
    }
    if (this.hasRequiredPanelTeardown(binding)) {
      await this.settleRequiredPanelTeardown(binding);
      return undefined;
    }

    let tab: BackgroundTab | undefined;
    try {
      tab = await this.getTab(binding.tabId);
    } catch {
      tab = undefined;
    }
    if (!this.isCurrentActivation(record, activationToken, binding)) {
      return undefined;
    }
    if (this.hasRequiredPanelTeardown(binding)) {
      await this.settleRequiredPanelTeardown(binding);
      return undefined;
    }

    const resolved = resolvedTab(tab, binding.tabId);
    if (!resolved || this.removedWindows.has(resolved.windowId)) {
      await this.invalidatePanelBinding(binding);
      return undefined;
    }
    if (binding.windowId === resolved.windowId) {
      return binding;
    }

    if (record.inspectSession && record.contentSessionId) {
      this.abortPanelCommand(record, activationToken);
      const retirement = this.requestPanelTeardown(
        binding,
        false,
        record,
        true,
      );
      void this.finishQuietBindingMoveAfterRetirement(
        binding,
        record,
        retirement,
      ).catch((error) => this.reportError(error));
      return undefined;
    }

    const replacement: ChannelBinding = {
      channel: binding.channel,
      tabId: binding.tabId,
      sourceId: binding.sourceId,
      windowId: resolved.windowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    this.activatePanelPort(record, replacement);
    const replacementToken = record.activationToken;
    return replacementToken &&
        record.registration &&
        this.isCurrentActivation(record, replacementToken, replacement)
      ? replacement
      : undefined;
  }

  private async finishQuietBindingMoveAfterRetirement(
    binding: ChannelBinding,
    record: PanelPortRecord,
    retirement: Promise<boolean>,
  ): Promise<void> {
    if (
      !await retirement ||
      this.disposed ||
      this.panelPorts.get(record.channel) !== record ||
      this.bindings.get(binding.channel) !== binding
    ) {
      return;
    }
    let tab: BackgroundTab | undefined;
    try {
      tab = await this.getTab(binding.tabId);
    } catch {
      tab = undefined;
    }
    if (
      this.disposed ||
      this.panelPorts.get(record.channel) !== record ||
      this.bindings.get(binding.channel) !== binding
    ) {
      return;
    }
    const resolved = resolvedTab(tab, binding.tabId);
    if (!resolved || this.removedWindows.has(resolved.windowId)) {
      await this.invalidatePanelBinding(binding);
      return;
    }
    const replacement = resolved.windowId === binding.windowId
      ? binding
      : this.replaceBindingWindow(binding, resolved.windowId);
    this.activatePanelPort(record, replacement);
  }

  private invalidatePanelBinding(
    binding: ChannelBinding,
  ): Promise<boolean> {
    return this.requestPanelTeardown(binding, true);
  }

  private requestPanelTeardown(
    binding: ChannelBinding,
    invalidateBinding: boolean,
    record = this.panelPorts.get(binding.channel),
    preservePanelState = false,
  ): Promise<boolean> {
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (required && !sameIdentity(required.binding, binding)) {
      return Promise.resolve(false);
    }
    if (required) {
      required.invalidateBinding ||= invalidateBinding;
      required.record ??= record;
      required.preservePanelState &&= preservePanelState && !invalidateBinding;
    } else {
      this.requiredPanelTeardowns.set(binding.channel, {
        binding,
        record,
        invalidateBinding,
        preservePanelState: preservePanelState && !invalidateBinding,
      });
    }
    const existing = this.panelTeardowns.get(binding.channel);
    if (
      existing &&
      required &&
      existing.binding === required.binding
    ) {
      return existing.promise;
    }
    const teardownBinding = required?.binding ?? binding;
    const promise = this.performPanelBindingTeardown(teardownBinding).finally(() => {
      if (this.panelTeardowns.get(binding.channel)?.promise === promise) {
        this.panelTeardowns.delete(binding.channel);
      }
    });
    this.panelTeardowns.set(binding.channel, {
      binding: teardownBinding,
      promise,
    });
    return promise;
  }

  private async awaitPanelTeardownForActivation(
    binding: ChannelBinding,
  ): Promise<boolean> {
    const pending = this.panelTeardowns.get(binding.channel);
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (!required || !sameIdentity(required.binding, binding)) {
      return true;
    }
    return pending?.binding === required.binding
      ? await pending.promise
      : await this.requestPanelTeardown(
          required.binding,
          required?.invalidateBinding ?? false,
        );
  }

  private async settleRequiredPanelTeardown(
    binding: ChannelBinding,
  ): Promise<void> {
    const completed = await this.awaitPanelTeardownForActivation(binding);
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (
      !completed &&
      required &&
      sameIdentity(required.binding, binding)
    ) {
      await this.requestPanelTeardown(
        required.binding,
        required.invalidateBinding,
      );
    }
  }

  private hasRequiredPanelTeardown(binding: ChannelBinding): boolean {
    const required = this.requiredPanelTeardowns.get(binding.channel);
    return Boolean(required && sameIdentity(required.binding, binding));
  }

  private async performPanelBindingTeardown(
    binding: ChannelBinding,
  ): Promise<boolean> {
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (required?.binding !== binding) {
      return true;
    }
    const inspectRetirement = this.beginPanelInspectRetirement(required);
    try {
      if (required.deferControlledSideEffects) {
        await inspectRetirement;
        if (!required.preservePanelState || required.invalidateBinding) {
          this.contentRefreshCoordinator.revokeTab(binding.tabId);
          await this.tabRefreshCoordinator.panelClosed(
            binding.tabId,
            binding.windowId,
          );
        }
      } else if (required.preservePanelState && !required.invalidateBinding) {
        await inspectRetirement;
      } else {
        this.contentRefreshCoordinator.revokeTab(binding.tabId);
        await Promise.all([
          inspectRetirement,
          this.tabRefreshCoordinator.panelClosed(
            binding.tabId,
            binding.windowId,
          ),
        ]);
      }
    } catch (error) {
      this.reportError(error);
      return false;
    }
    if (required.preservePanelState && !required.invalidateBinding) {
      const currentBinding = this.bindings.get(binding.channel);
      const record = required.record;
      if (
        currentBinding &&
        sameIdentity(currentBinding, binding) &&
        record &&
        this.panelPorts.get(binding.channel) === record
      ) {
        this.clearPanelActivation(record, true);
      }
    }
    const completed = this.requiredPanelTeardowns.get(binding.channel);
    if (completed?.binding !== binding) {
      return true;
    }
    if (completed.invalidateBinding) {
      const currentBinding = this.bindings.get(binding.channel);
      const record = this.panelPorts.get(binding.channel);
      if (
        currentBinding &&
        sameIdentity(currentBinding, binding) &&
        record
      ) {
        record.port.onMessage.removeListener(record.onMessage);
        this.clearPanelActivation(record, true);
        record.onMessage = (message) =>
          this.rejectPendingInspect(record, message);
        record.port.onMessage.addListener(record.onMessage);
      }
      if (currentBinding && sameIdentity(currentBinding, binding)) {
        this.removeBinding(currentBinding, true);
      }
    }
    if (this.requiredPanelTeardowns.get(binding.channel) === completed) {
      this.requiredPanelTeardowns.delete(binding.channel);
    }
    return true;
  }

  private postInspectFailure(
    record: PanelPortRecord,
    requestId: string,
  ): void {
    if (this.panelPorts.get(record.channel) !== record) {
      return;
    }
    try {
      record.port.postMessage({
        type: "pin-op.inspect.result",
        requestId,
        ok: false,
        error: "stalePanel",
      });
    } catch {
      // Port teardown owns eventual cleanup.
    }
  }

  private connectContentLease(
    port: BackgroundRuntimePort,
    contentSessionId: ContentSessionId,
  ): void {
    const tabId = port.sender?.tab?.id;
    if (!isBrowserId(tabId)) {
      safeDisconnect(port);
      return;
    }
    this.inspectCoordinator.attachContentLease(tabId, contentSessionId, port);
  }

  private async publishSelection(
    payload: InspectPayload,
    selectionRevision: number,
    contentSessionId: ContentSessionId,
    republishToken: string | undefined,
    selectionEvent: StylesSelectionEvent | undefined,
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) {
      return undefined;
    }
    const channel = this.channelByTab.get(senderTab.id);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = channel ? this.panelPorts.get(channel) : undefined;
    const activationToken = record?.activationToken;
    if (
      !binding ||
      !record ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      record.replacingContentSessionId === contentSessionId ||
      record.bindingGeneration !== binding.generation ||
      !record.registration ||
      !activationToken ||
      !this.isCurrentActivation(record, activationToken, binding)
    ) {
      return undefined;
    }
    if (
      senderTab.windowId !== undefined &&
      senderTab.windowId !== binding.windowId
    ) {
      await this.refreshPanelBinding(binding, record, activationToken);
      return undefined;
    }
    let selectionAuthority = record.stylesSelectionAuthority;
    if (
      selectionAuthority &&
      (selectionRevision < selectionAuthority.selectionRevision ||
        (!selectionAuthority.selected &&
          selectionRevision === selectionAuthority.selectionRevision))
    ) {
      return undefined;
    }
    if (this.hasInspectTransitionGate(record)) {
      this.bufferPendingInspectSelection(
        record,
        payload,
        selectionRevision,
        contentSessionId,
        republishToken,
        selectionEvent,
      );
      return undefined;
    }
    if (
      republishToken === undefined &&
      selectionEvent &&
      !(
        selectionAuthority?.selected &&
        selectionAuthority.documentEpoch === selectionEvent.documentEpoch &&
        selectionAuthority.nodeRef === selectionEvent.nodeRef &&
        selectionAuthority.selectionRevision ===
          selectionEvent.selectionRevision
      )
    ) {
      if (!this.observeStylesSelectionAuthority(record, selectionEvent)) {
        return undefined;
      }
      this.panelSessions.publish(binding.channel, selectionEvent);
      selectionAuthority = record.stylesSelectionAuthority;
    }
    if (
      republishToken === undefined &&
      selectionAuthority?.selected &&
      this.matchesRefreshRepublishAuthority(
        record,
        contentSessionId,
        selectionAuthority.documentEpoch,
        selectionAuthority.nodeRef,
        selectionRevision,
      )
    ) {
      return undefined;
    }
    const refreshRepublishAuthority = republishToken !== undefined &&
        record.refreshRepublishAuthority?.republishToken === republishToken
      ? record.refreshRepublishAuthority
      : undefined;
    if (republishToken !== undefined) {
      const republishPublication = record.republishPublication;
      if (
        !republishPublication ||
        republishPublication.republishToken !== republishToken ||
        republishPublication.contentSessionId !== contentSessionId ||
        republishPublication.selectionRevision !== selectionRevision ||
        !selectionAuthority?.selected ||
        selectionAuthority.documentEpoch !==
          republishPublication.documentEpoch ||
        selectionAuthority.nodeRef !== republishPublication.nodeRef ||
        selectionAuthority.selectionRevision !==
          republishPublication.selectionRevision ||
        (selectionEvent !== undefined &&
          (selectionEvent.documentEpoch !==
              republishPublication.documentEpoch ||
            selectionEvent.nodeRef !== republishPublication.nodeRef ||
            selectionEvent.selectionRevision !==
              republishPublication.selectionRevision))
      ) {
        this.rejectPendingRefreshRepublishAuthority(
          record,
          refreshRepublishAuthority,
        );
        return undefined;
      }
    }
    const availabilityRepublish = republishToken === undefined
      ? undefined
      : record.availabilityRepublish?.token === republishToken
      ? record.availabilityRepublish
      : undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    const publicationToken: InspectPublicationToken = {
      documentEpoch: selectionAuthority?.documentEpoch,
      selectionRevision,
    };
    record.inspectPublicationToken = publicationToken;
    this.correlations.disposeChannel(binding.channel);
    try {
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
    if (
      !refreshed ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      this.hasInspectTransitionGate(record) ||
      record.inspectPublicationToken !== publicationToken ||
      (senderTab.windowId !== undefined &&
        senderTab.windowId !== refreshed.windowId)
    ) {
      return undefined;
    }

    let inspectMessageId: string;
    let tabState: TabRefreshState;
    try {
      tabState = await this.tabRefreshCoordinator.state(
        refreshed.tabId,
        refreshed.windowId,
      );
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
    if (
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      this.hasInspectTransitionGate(record) ||
      record.inspectPublicationToken !== publicationToken ||
      !record.activationToken ||
      !this.isCurrentActivation(record, record.activationToken, refreshed)
    ) {
      return undefined;
    }
    const inspectPayload: InspectPayload = {
      targets: payload.targets,
      ruleEvidence: payload.ruleEvidence,
      context: payload.context,
      ideHighlightEnabled: tabState.ideHighlightEnabled,
      metadata: payload.metadata,
    };
    try {
      if (
        record.inspectPublicationToken !== publicationToken ||
        this.hasInspectTransitionGate(record)
      ) {
        return undefined;
      }
      inspectMessageId = this.inspectMessageId();
      this.correlations.record(
        refreshed.channel,
        inspectMessageId,
        refreshed.tabId,
        refreshed.windowId,
        inspectPayload.ruleEvidence,
      );
      const route = this.correlations.routeForInspect(inspectMessageId);
      if (!route) {
        throw new Error("Inspect correlation was not recorded");
      }
      this.panelSessions.publishInspectStarted(
        refreshed.channel,
        inspectMessageId,
        selectionRevision,
        [...route.expectedRuleRefs],
      );
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
    let outcome: InspectSendOutcome;
    try {
      outcome = this.coordinator.publishInspect(
        refreshed.windowId,
        inspectMessageId,
        refreshed.sourceId,
        inspectPayload,
      );
    } catch (error) {
      this.reportError(error);
      outcome = "transport-error";
    }
    if (outcome !== "sent") {
      this.correlations.discard(inspectMessageId);
      this.panelSessions.publishIdeDisconnected(
        refreshed.channel,
        inspectMessageId,
      );
    } else {
      this.commitRefreshRepublishAuthority(
        record,
        refreshRepublishAuthority,
      );
      if (
        availabilityRepublish &&
        !this.hasInspectTransitionGate(record) &&
        this.availabilityStates.get(availabilityRepublish.windowId)?.epoch ===
          availabilityRepublish.epoch
      ) {
        record.republishedAvailabilityEpoch = Math.max(
          record.republishedAvailabilityEpoch,
          availabilityRepublish.epoch,
        );
      }
    }
      return okResult;
    } finally {
      this.rejectPendingRefreshRepublishAuthority(
        record,
        refreshRepublishAuthority,
      );
    }
  }

  private async publishContentDomEvent(
    event: DomEvent,
    contentSessionId: ContentSessionId,
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) {
      return undefined;
    }
    const channel = this.channelByTab.get(senderTab.id);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = channel ? this.panelPorts.get(channel) : undefined;
    const activationToken = record?.activationToken;
    if (
      !binding ||
      !record ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      record.replacingContentSessionId === contentSessionId ||
      record.bindingGeneration !== binding.generation ||
      !record.registration ||
      !activationToken ||
      !this.isCurrentActivation(record, activationToken, binding) ||
      (senderTab.windowId !== undefined &&
        senderTab.windowId !== binding.windowId)
    ) {
      return undefined;
    }
    if (this.hasInspectTransitionGate(record)) {
      this.bufferPendingSelectionEvent(record, event);
      return undefined;
    }
    if (!this.observeStylesSelectionAuthority(record, event)) {
      return undefined;
    }
    this.panelSessions.publish(binding.channel, event);
    return okResult;
  }

  private async publishContentStylesEvent(
    event: StylesEvent,
    contentSessionId: ContentSessionId,
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) return undefined;
    const channel = this.channelByTab.get(senderTab.id);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = channel ? this.panelPorts.get(channel) : undefined;
    if (
      !binding ||
      !record ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      (this.hasInspectTransitionGate(record) &&
        event.type !== "styles.invalidated") ||
      record.bindingGeneration !== binding.generation ||
      (senderTab.windowId !== undefined && senderTab.windowId !== binding.windowId)
    ) return undefined;
    if (event.type === "styles.invalidated") {
      const authority = record.stylesInvalidationAuthority;
      if (
        authority &&
        (event.documentEpoch < authority.documentEpoch ||
          (event.documentEpoch === authority.documentEpoch &&
            (event.stylesRevision <= authority.stylesRevision ||
              event.stylesheetRevision < authority.stylesheetRevision)))
      ) {
        return undefined;
      }
      record.stylesInvalidationAuthority = Object.freeze({
        documentEpoch: event.documentEpoch,
        stylesRevision: event.stylesRevision,
        stylesheetRevision: event.stylesheetRevision,
      });
      record.refreshRepublishAuthority = undefined;
      record.inspectPublicationToken = undefined;
      record.republishPublication = undefined;
      record.availabilityRepublish = undefined;
      this.correlations.disposeChannel(binding.channel);
      this.panelSessions.publish(binding.channel, event);
      return okResult;
    }
    const authority = record.stylesSelectionAuthority;
    if (
      !authority?.selected ||
      authority.documentEpoch !== event.documentEpoch ||
      authority.nodeRef !== event.nodeRef ||
      authority.selectionRevision !== event.selectionRevision
    ) {
      return undefined;
    }
    if (
      event.type === "styles.inspectPublicationRenewed" &&
      this.matchesRefreshRepublishAuthority(
        record,
        contentSessionId,
        event.documentEpoch,
        event.nodeRef,
        event.selectionRevision,
      )
    ) {
      if (record.refreshRepublishAuthority?.phase === "pending") {
        record.pendingRefreshRenewalToken =
          record.refreshRepublishAuthority.republishToken;
      }
      return okResult;
    }
    const request = this.currentRepublishRequest(record);
    if (!request) return undefined;
    const republished = await this.panelSessions.republishSelection(
      binding.channel,
      request,
    );
    return republished ? okResult : undefined;
  }

  private publishRetiringStylesInvalidation(
    event: StylesEvent,
    contentSessionId: ContentSessionId,
    sender: BackgroundMessageSender,
  ): BackgroundRouteResult | undefined {
    if (event.type !== "styles.invalidated") return undefined;
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) return undefined;
    const cleanup = this.retiringInspectCleanups.get(senderTab.id);
    if (
      !cleanup ||
      cleanup.contentSessionId !== contentSessionId ||
      cleanup.binding.tabId !== senderTab.id ||
      cleanup.requirement.record?.generation !== cleanup.recordGeneration ||
      this.requiredPanelTeardowns.get(cleanup.binding.channel) !==
        cleanup.requirement ||
      cleanup.requirement.binding !== cleanup.binding
    ) {
      return undefined;
    }
    const previous = cleanup.latestAuthority;
    if (
      previous &&
      (event.documentEpoch < previous.documentEpoch ||
        (event.documentEpoch === previous.documentEpoch &&
          (event.stylesRevision <= previous.stylesRevision ||
            event.stylesheetRevision < previous.stylesheetRevision)))
    ) {
      return undefined;
    }
    cleanup.latestAuthority = Object.freeze({
      documentEpoch: event.documentEpoch,
      stylesRevision: event.stylesRevision,
      stylesheetRevision: event.stylesheetRevision,
    });
    return okResult;
  }

  private observeStylesSelectionAuthority(
    record: PanelPortRecord,
    event: DomEvent,
  ): boolean {
    if (
      event.type !== "dom.selectionChanged" &&
      event.type !== "dom.selectionCleared"
    ) {
      return true;
    }
    const current = record.stylesSelectionAuthority;
    if (!this.canObserveStylesSelectionEvent(current, event)) {
      return false;
    }
    const publicationToken = record.inspectPublicationToken;
    const matchesCurrentPublication = event.type === "dom.selectionChanged" &&
      publicationToken !== undefined &&
      publicationToken.selectionRevision === event.selectionRevision &&
      (publicationToken.documentEpoch === undefined ||
        publicationToken.documentEpoch === event.documentEpoch);
    if (matchesCurrentPublication) {
      publicationToken.documentEpoch = event.documentEpoch;
    } else {
      record.inspectPublicationToken = undefined;
      this.correlations.disposeChannel(record.channel);
    }
    record.refreshRepublishAuthority = undefined;
    record.stylesSelectionAuthority = {
      documentEpoch: event.documentEpoch,
      nodeRef: event.nodeRef,
      selectionRevision: event.selectionRevision,
      selected: event.type === "dom.selectionChanged",
    };
    return true;
  }

  private beginPanelInspectRetirement(
    requirement: PanelTeardownRequirement,
  ): Promise<void> {
    if (requirement.inspectRetirement) {
      return requirement.inspectRetirement;
    }
    const { binding, record } = requirement;
    if (!record) {
      const completed = Promise.resolve();
      requirement.inspectRetirement = completed;
      return completed;
    }
    const session = record.inspectSession;
    const contentSessionId = record.contentSessionId;
    let cleanup: RetiringInspectCleanup | undefined;
    if (session && contentSessionId) {
      requirement.deferControlledSideEffects = true;
      cleanup = {
        requirement,
        binding,
        recordGeneration: record.generation,
        contentSessionId,
        latestAuthority: record.stylesInvalidationAuthority,
      };
      this.retiringInspectCleanups.set(binding.tabId, cleanup);
    }

    let retirement: Promise<void>;
    if (!session) {
      retirement = Promise.resolve();
    } else if (requirement.invalidateBinding) {
      session.retire("stalePanel");
      retirement = contentSessionId
        ? session.whenIdle()
        : Promise.resolve();
    } else {
      const controlledDispose = session.controlledDispose();
      retirement = contentSessionId
        ? controlledDispose
        : Promise.resolve();
    }

    this.dropPendingTabRefreshTransition(record);
    record.pendingWindowTransitionSelection = undefined;
    this.controlledInspectCleanups.delete(record.channel);
    record.inspectSession = undefined;
    record.inspectTabId = undefined;
    record.inspectWindowId = undefined;
    record.contentSessionId = undefined;
    record.contentLeaseArrival?.settle();
    record.contentLeaseArrival = undefined;
    record.replacingContentSessionId = undefined;
    record.rejectPendingContentLeaseReplacements = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    record.pendingRefreshRenewalToken = undefined;
    record.inspectPublicationToken = undefined;
    record.republishPublication = undefined;
    record.availabilityRepublish = undefined;
    record.contentRecoveryAvailable = false;
    record.panelSessionBinding?.dispose();
    record.panelSessionBinding = undefined;
    this.panelSessions.disposeChannel(record.channel);
    if (!cleanup && this.panelPorts.get(record.channel) !== record) {
      this.clearRetiredPanelActivation(record);
    }

    const completed = retirement.then(
      () => undefined,
      (error: unknown) => {
        this.reportError(error);
      },
    ).then(() => {
      if (
        cleanup &&
        this.retiringInspectCleanups.get(binding.tabId) === cleanup
      ) {
        this.retiringInspectCleanups.delete(binding.tabId);
      }
      this.revokeInspectChannel(binding.channel);
      if (cleanup && this.panelPorts.get(record.channel) !== record) {
        this.clearRetiredPanelActivation(record);
      }
    });
    requirement.inspectRetirement = completed;
    return completed;
  }

  private clearRetiredPanelActivation(record: PanelPortRecord): void {
    const activationToken = record.activationToken;
    record.activationToken = undefined;
    record.bindingGeneration = undefined;
    record.windowStateQueue = undefined;
    record.windowStateRevision += 1;
    record.tabStateInitialization = undefined;
    record.tabStateInitialized = false;
    record.tabStateInvalidatedByUnlink = false;
    record.lastWindowState = undefined;
    record.republishWindowId = undefined;
    record.republishInFlightEpoch = undefined;
    record.republishedAvailabilityEpoch = 0;
    if (activationToken) this.abortPanelCommand(record, activationToken);
    const registration = record.registration;
    record.registration = undefined;
    registration?.dispose();
  }

  private canObserveStylesSelectionEvent(
    current: StylesSelectionAuthority | undefined,
    event: StylesSelectionEvent,
  ): boolean {
    if (!current) return true;
    const selectedToClearedTie = current.selected &&
      event.type === "dom.selectionCleared" &&
      event.documentEpoch === current.documentEpoch &&
      event.selectionRevision === current.selectionRevision &&
      event.nodeRef === current.nodeRef;
    return event.documentEpoch > current.documentEpoch ||
      (event.documentEpoch === current.documentEpoch &&
        (event.selectionRevision > current.selectionRevision ||
          (event.selectionRevision === current.selectionRevision &&
            selectedToClearedTie)));
  }

  private selectionAuthorityForEvent(
    event: StylesSelectionEvent,
  ): StylesSelectionAuthority {
    return {
      documentEpoch: event.documentEpoch,
      nodeRef: event.nodeRef,
      selectionRevision: event.selectionRevision,
      selected: event.type === "dom.selectionChanged",
    };
  }

  private sameSelectionEvent(
    first: StylesSelectionEvent,
    second: StylesSelectionEvent,
  ): boolean {
    return first.type === second.type &&
      first.documentEpoch === second.documentEpoch &&
      first.nodeRef === second.nodeRef &&
      first.selectionRevision === second.selectionRevision;
  }

  private bufferedInspectMatchesEvent(
    buffered: BufferedInspectSelection | undefined,
    event: StylesSelectionEvent,
    contentSessionId: ContentSessionId,
  ): buffered is BufferedInspectSelection {
    if (
      event.type !== "dom.selectionChanged" ||
      buffered?.contentSessionId !== contentSessionId ||
      buffered.selectionRevision !== event.selectionRevision
    ) return false;
    const embedded = buffered.selectionEvent;
    return !embedded || this.sameSelectionEvent(embedded, event);
  }

  private matchesSelectionAuthority(
    authority: StylesSelectionAuthority | undefined,
    event: StylesSelectionEvent,
  ): boolean {
    return authority?.documentEpoch === event.documentEpoch &&
      authority.nodeRef === event.nodeRef &&
      authority.selectionRevision === event.selectionRevision &&
      authority.selected === (event.type === "dom.selectionChanged");
  }

  private latestBufferedSelectionEvent(
    holder: BufferedSelectionHolder,
  ): StylesSelectionEvent | undefined {
    const explicit = holder.bufferedSelectionEvent;
    const embedded = holder.bufferedInspectSelection?.selectionEvent;
    if (!explicit) return embedded;
    return embedded && this.canObserveStylesSelectionEvent(
        this.selectionAuthorityForEvent(explicit),
        embedded,
      )
      ? embedded
      : explicit;
  }

  private mergeBufferedSelectionEvent(
    record: PanelPortRecord,
    holder: BufferedSelectionHolder,
    event: StylesSelectionEvent,
  ): boolean {
    const latest = this.latestBufferedSelectionEvent(holder);
    const current = latest
      ? this.selectionAuthorityForEvent(latest)
      : record.stylesSelectionAuthority;
    if (
      !this.canObserveStylesSelectionEvent(current, event) &&
      !this.matchesSelectionAuthority(current, event)
    ) return false;
    if (!latest || !this.sameSelectionEvent(latest, event)) {
      holder.bufferedSelectionEvent = event;
    }
    return true;
  }

  private mergeBufferedInspectSelection(
    record: PanelPortRecord,
    holder: BufferedSelectionHolder,
    candidate: BufferedInspectSelection,
    preferCandidateOnTie: boolean,
  ): void {
    const candidateEvent = candidate.selectionEvent;
    if (
      candidateEvent &&
      !this.mergeBufferedSelectionEvent(record, holder, candidateEvent)
    ) return;
    const latest = this.latestBufferedSelectionEvent(holder);
    if (
      candidateEvent &&
      latest &&
      !this.sameSelectionEvent(candidateEvent, latest)
    ) return;
    const current = holder.bufferedInspectSelection;
    if (!current) {
      holder.bufferedInspectSelection = candidate;
      return;
    }
    const currentEvent = current.selectionEvent;
    if (candidateEvent && currentEvent) {
      if (this.canObserveStylesSelectionEvent(
        this.selectionAuthorityForEvent(currentEvent),
        candidateEvent,
      ) ||
        (preferCandidateOnTie &&
          this.sameSelectionEvent(currentEvent, candidateEvent))) {
        holder.bufferedInspectSelection = candidate;
      }
      return;
    }
    if (candidateEvent && !currentEvent) {
      holder.bufferedInspectSelection = candidate;
      return;
    }
    if (
      !candidateEvent &&
      !currentEvent &&
      (candidate.selectionRevision > current.selectionRevision ||
        (preferCandidateOnTie &&
          candidate.selectionRevision === current.selectionRevision))
    ) {
      holder.bufferedInspectSelection = candidate;
    }
  }

  private mergeBufferedSelections(
    record: PanelPortRecord,
    source: BufferedSelectionHolder,
    target: BufferedSelectionHolder,
  ): void {
    const event = this.latestBufferedSelectionEvent(source);
    if (event) this.mergeBufferedSelectionEvent(record, target, event);
    const inspect = source.bufferedInspectSelection;
    if (inspect) {
      this.mergeBufferedInspectSelection(record, target, inspect, false);
    }
  }

  private bufferPendingSelectionEvent(
    record: PanelPortRecord,
    event: DomEvent,
  ): void {
    if (
      event.type !== "dom.selectionChanged" &&
      event.type !== "dom.selectionCleared"
    ) return;
    const transition = this.currentGatedTabRefreshTransition(record);
    const cleanup = this.controlledInspectCleanups.get(record.channel);
    const holder = transition ??
      (cleanup && this.isCurrentControlledCleanup(cleanup) ? cleanup : undefined) ??
      this.currentPendingWindowTransitionSelection(record);
    if (!holder) return;
    this.mergeBufferedSelectionEvent(record, holder, event);
  }

  private bufferPendingInspectSelection(
    record: PanelPortRecord,
    payload: InspectPayload,
    selectionRevision: number,
    contentSessionId: ContentSessionId,
    republishToken: string | undefined,
    selectionEvent: StylesSelectionEvent | undefined,
  ): void {
    if (republishToken !== undefined) return;
    const transition = this.currentGatedTabRefreshTransition(record);
    const cleanup = this.controlledInspectCleanups.get(record.channel);
    const holder = transition ??
      (cleanup && this.isCurrentControlledCleanup(cleanup) ? cleanup : undefined) ??
      this.currentPendingWindowTransitionSelection(record);
    if (!holder) return;
    this.mergeBufferedInspectSelection(record, holder, {
      payload,
      selectionRevision,
      contentSessionId,
      ...(selectionEvent ? { selectionEvent } : {}),
    }, true);
  }

  private commitBufferedSelectionEvent(
    transition: PendingTabRefreshTransition,
    transitionCurrent = this.isCurrentPendingTabRefreshTransition(transition),
  ): BufferedInspectSelection | undefined {
    const bufferedInspect = transition.bufferedInspectSelection;
    const event = this.latestBufferedSelectionEvent(transition);
    transition.bufferedSelectionEvent = undefined;
    transition.bufferedInspectSelection = undefined;
    if (
      !event ||
      !transitionCurrent ||
      !this.observeStylesSelectionAuthority(transition.record, event)
    ) {
      return undefined;
    }
    this.panelSessions.publish(transition.record.channel, event);
    return this.bufferedInspectMatchesEvent(
        bufferedInspect,
        event,
        transition.contentSessionId,
      )
      ? bufferedInspect
      : undefined;
  }

  private currentGatedTabRefreshTransition(
    record: PanelPortRecord,
  ): PendingTabRefreshTransition | undefined {
    const admission = this.pendingTabRefreshAdmissions.get(record.channel);
    if (
      admission?.record === record &&
        this.pendingTabRefreshAdmissions.get(record.channel) === admission &&
        this.isCurrentTabRefreshTransitionSnapshot(admission.transition)
    ) {
      return admission.transition;
    }
    const pending = this.pendingTabRefreshTransitions.get(record.channel);
    return pending && this.isCurrentPendingTabRefreshTransition(pending)
      ? pending
      : undefined;
  }

  private inheritPendingTabRefreshSelection(
    previous:
      | PendingTabRefreshTransition
      | PendingWindowTransitionSelection,
    next: PendingTabRefreshTransition | ControlledInspectCleanup,
  ): void {
    this.mergeBufferedSelections(next.record, previous, next);
  }

  private currentPendingWindowTransitionSelection(
    record: PanelPortRecord,
  ): PendingWindowTransitionSelection | undefined {
    const pending = record.pendingWindowTransitionSelection;
    return pending &&
        pending.windowId === pending.binding.windowId &&
        record.contentSessionId === pending.contentSessionId &&
        this.isCurrentActivation(
          record,
          pending.activationToken,
          pending.binding,
        )
      ? pending
      : undefined;
  }

  private releaseTabRefreshAdmission(
    admission: PendingTabRefreshAdmission,
    replayBuffered: boolean,
  ): void {
    if (
      this.pendingTabRefreshAdmissions.get(admission.record.channel) !==
        admission
    ) return;
    const bufferedInspect = replayBuffered
      ? this.commitBufferedSelectionEvent(
          admission.transition,
          this.isCurrentTabRefreshTransitionSnapshot(admission.transition),
        )
      : undefined;
    this.pendingTabRefreshAdmissions.delete(admission.record.channel);
    if (!bufferedInspect) return;
    void this.publishSelection(
      bufferedInspect.payload,
      bufferedInspect.selectionRevision,
      bufferedInspect.contentSessionId,
      undefined,
      bufferedInspect.selectionEvent,
      {
        tab: {
          id: admission.transition.binding.tabId,
          windowId: admission.windowId,
        },
      },
    ).catch((error: unknown) => this.reportError(error));
  }

  private matchesRefreshRepublishAuthority(
    record: PanelPortRecord,
    contentSessionId: ContentSessionId,
    documentEpoch: number,
    nodeRef: string,
    selectionRevision: number,
  ): boolean {
    const refresh = record.refreshRepublishAuthority;
    const invalidation = record.stylesInvalidationAuthority;
    return Boolean(
      refresh &&
        invalidation &&
        refresh.contentSessionId === contentSessionId &&
        refresh.documentEpoch === documentEpoch &&
        refresh.nodeRef === nodeRef &&
        refresh.selectionRevision === selectionRevision &&
        invalidation.documentEpoch === refresh.documentEpoch &&
        invalidation.stylesRevision === refresh.stylesRevision &&
        invalidation.stylesheetRevision === refresh.stylesheetRevision,
    );
  }

  private commitRefreshRepublishAuthority(
    record: PanelPortRecord,
    authority: RefreshRepublishAuthority | undefined,
  ): void {
    if (
      !authority ||
      authority.phase !== "pending" ||
      record.refreshRepublishAuthority !== authority
    ) return;
    record.refreshRepublishAuthority = Object.freeze({
      ...authority,
      phase: "committed",
    });
    if (record.pendingRefreshRenewalToken === authority.republishToken) {
      record.pendingRefreshRenewalToken = undefined;
    }
  }

  private rejectPendingRefreshRepublishAuthority(
    record: PanelPortRecord,
    authority: RefreshRepublishAuthority | undefined,
  ): void {
    if (
      authority?.phase === "pending" &&
      record.refreshRepublishAuthority === authority
    ) {
      const retry = record.pendingRefreshRenewalToken ===
          authority.republishToken &&
        this.matchesRefreshRepublishAuthority(
          record,
          authority.contentSessionId,
          authority.documentEpoch,
          authority.nodeRef,
          authority.selectionRevision,
        );
      record.refreshRepublishAuthority = undefined;
      if (record.pendingRefreshRenewalToken === authority.republishToken) {
        record.pendingRefreshRenewalToken = undefined;
      }
      if (retry && !this.hasInspectTransitionGate(record)) {
        const request = this.currentRepublishRequest(record);
        if (request) {
          const retryAuthority: RefreshRepublishAuthority = Object.freeze({
            ...authority,
            republishToken: request.republishToken,
            phase: "pending",
          });
          record.refreshRepublishAuthority = retryAuthority;
          void this.panelSessions.republishSelection(record.channel, request)
            .then((republished) => {
              if (
                !republished &&
                record.republishPublication === request
              ) {
                record.republishPublication = undefined;
              }
              if (!republished) {
                this.rejectPendingRefreshRepublishAuthority(
                  record,
                  retryAuthority,
                );
              }
            })
            .catch((error: unknown) => {
              if (record.republishPublication === request) {
                record.republishPublication = undefined;
              }
              this.rejectPendingRefreshRepublishAuthority(
                record,
                retryAuthority,
              );
              this.reportError(error);
            });
        }
      }
    }
  }

  private queueWindowState(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
    queue: WindowStateQueue,
    state: BrowserWindowConnectionState,
    displayLinkCode?: string,
    protocolMismatch?: BrowserProtocolMismatch,
  ): void {
    if (
      record.windowStateQueue !== queue ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return;
    }
    record.windowStateRevision += 1;
    const revision = record.windowStateRevision;
    let inspectionCleanupFailed = false;
    const controlledContentSessionId = record.contentSessionId;
    const revokesAuthority = revokesSourcePresentationAuthority(state);
    const existingControlledCleanup = controlledContentSessionId
      ? this.controlledInspectCleanups.get(record.channel)
      : undefined;
    const controlledCleanup = revokesAuthority && controlledContentSessionId
      ? this.prepareControlledRecordCleanup(
          record,
          token,
          binding,
          controlledContentSessionId,
          true,
        )
      : (state === "linking" || state === "linked") &&
          existingControlledCleanup &&
          this.isCurrentControlledCleanup(existingControlledCleanup)
      ? existingControlledCleanup
      : undefined;
    const cleanupRetainer = controlledCleanup ? {} : undefined;
    if (controlledCleanup && cleanupRetainer) {
      if (state === "linking" || state === "linked") {
        controlledCleanup.republishOnRelease = true;
      }
      controlledCleanup.transientRetainers.add(cleanupRetainer);
    }
    const operation = queue.tail.then(async () => {
      try {
        if (
          record.windowStateQueue !== queue ||
          !record.registration ||
          !this.isCurrentActivation(record, token, binding)
        ) {
          return;
        }
        const cleanupAcknowledged = controlledCleanup
          ? await controlledCleanup.promise
          : true;
        if (controlledCleanup && !cleanupAcknowledged) {
          inspectionCleanupFailed = true;
        }
        if (revokesAuthority) {
          this.revokeInspectWindow(binding.windowId);
        }
        if (
          record.windowStateQueue !== queue ||
          !record.registration ||
          !this.isCurrentActivation(record, token, binding)
        ) {
          return;
        }
        const refreshed = await this.refreshPanelBinding(
          binding,
          record,
          token,
        );
        if (
          refreshed !== binding ||
          record.windowStateQueue !== queue ||
          !record.registration ||
          !this.isCurrentActivation(record, token, binding)
        ) {
          return;
        }
        if (
          state === "offline" ||
          (state === "notLinked" && this.browserLocalInspection)
        ) {
          const contentSessionId = record.contentSessionId;
          if (contentSessionId) {
            if (
              controlledContentSessionId === undefined ||
              !cleanupAcknowledged ||
              contentSessionId !== controlledContentSessionId
            ) {
              inspectionCleanupFailed = true;
              record.inspectionFailedClosed = true;
              const session = record.inspectSession;
              this.disposeInspectionSession(record, false);
              await session?.whenIdle();
              await this.inspectCoordinator.whenIdle(binding.tabId);
              if (
                record.windowStateQueue !== queue ||
                !record.registration ||
                !this.isCurrentActivation(record, token, binding)
              ) {
                return;
              }
            }
          }
        }
        const previousState = record.lastWindowState;
        record.lastWindowState = state;
        if (state === "notLinked") {
          this.peerBlockedWindows.add(binding.windowId);
          this.peerStates.delete(binding.windowId);
          this.peerTransitionAuthorities.delete(binding.windowId);
          this.availabilityStates.delete(binding.windowId);
          record.republishInFlightEpoch = undefined;
          record.republishedAvailabilityEpoch = 0;
          record.inspectionFailedClosed =
            record.inspectionFailedClosed || inspectionCleanupFailed;
        } else if (state === "incompatible") {
          this.peerBlockedWindows.add(binding.windowId);
        }
        if (
          state === "incompatible" ||
          (state === "notLinked" && !this.browserLocalInspection)
        ) {
          if (record.inspectSession || record.panelSessionBinding) {
            this.disposeInspectionSession(record, false);
          }
        } else if (
          (
            this.browserLocalInspection ||
            state === "linking" ||
            state === "linked"
          ) &&
          !record.inspectSession &&
          !record.inspectionFailedClosed
        ) {
          try {
            this.startInspectionSession(record, binding);
          } catch (error) {
            record.inspectionFailedClosed = true;
            this.reportError(error);
          }
        }
        if (state === "linking" || state === "linked") {
          this.peerBlockedWindows.delete(binding.windowId);
        }
        this.updateBridgeAvailability(
          binding.windowId,
          previousState,
          state,
        );
        const windowStateMessage: Record<string, unknown> = {
          type: "pin-op.windowState",
          state,
        };
        if (displayLinkCode !== undefined) {
          windowStateMessage.displayLinkCode = displayLinkCode;
        }
        this.postToCurrentPort(record, token, windowStateMessage);
        if (state === "incompatible") {
          this.postToCurrentPort(
            record,
            token,
            incompatibleProtocolMessage(protocolMismatch),
          );
        } else if (state === "linked") {
          this.postToCurrentPort(record, token, {
            type: "pin-op.protocol.compatibility",
            compatible: true,
            browserProtocolVersion: PROTOCOL_VERSION,
          } satisfies ProtocolCompatibilityMessage);
          void this.publishFreshLinkedTabState(
            record,
            token,
            binding,
            revision,
          ).catch((error) => this.reportError(error));
        }
      } finally {
        if (controlledCleanup && cleanupRetainer) {
          controlledCleanup.transientRetainers.delete(cleanupRetainer);
          this.releaseControlledCleanup(controlledCleanup);
        }
      }
    });
    queue.tail = operation.catch((error) =>
      this.reportError(error),
    );
  }

  private async publishFreshLinkedTabState(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
    revision: number,
  ): Promise<void> {
    if (
      !this.isCurrentLinkedSnapshot(record, token, binding, revision) ||
      record.tabStateInvalidatedByUnlink
    ) {
      return;
    }
    const initialization = await this.ensurePanelTabStateInitialized(
      record,
      token,
      binding,
    );
    if (
      !initialization ||
      !this.isCurrentLinkedSnapshot(record, token, binding, revision)
    ) {
      return;
    }
    const state = await this.tabRefreshCoordinator.state(
      binding.tabId,
      binding.windowId,
    );
    if (!this.isCurrentLinkedSnapshot(record, token, binding, revision)) {
      return;
    }
    this.postToCurrentPort(
      record,
      token,
      createPanelTabStateMessage(state),
    );
  }

  private isCurrentLinkedSnapshot(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
    revision: number,
  ): boolean {
    return (
      record.windowStateRevision === revision &&
      record.lastWindowState === "linked" &&
      this.isCurrentActivation(record, token, binding)
    );
  }

  private updateBridgeAvailability(
    windowId: number,
    previousState: BrowserWindowConnectionState | undefined,
    state: BrowserWindowConnectionState,
  ): void {
    if (state === "notLinked") {
      return;
    }
    const availability = this.getAvailabilityState(windowId);
    const peer = this.peerStates.get(windowId);
    if (state !== "linked") {
      const wasAvailable = windowIsAvailable(availability, peer);
      availability.bridgeConnected = false;
      const initialLink = state === "linking" &&
        (previousState === undefined || previousState === "notLinked");
      if (wasAvailable && !initialLink) {
        this.beginAvailabilityEpoch(availability);
      }
      return;
    }

    availability.bridgeConnected = true;
    if (
      peer === undefined &&
      availability.epoch > 0
    ) {
      availability.initialPeerCoveredEpoch = availability.epoch;
    }
    this.scheduleAvailabilityRepublish(windowId, availability);
  }

  private getAvailabilityState(windowId: number): WindowAvailabilityState {
    const current = this.availabilityStates.get(windowId);
    if (current) {
      return current;
    }
    const created: WindowAvailabilityState = {
      bridgeConnected: undefined,
      epoch: 0,
    };
    this.availabilityStates.set(windowId, created);
    return created;
  }

  private beginAvailabilityEpoch(state: WindowAvailabilityState): void {
    state.epoch += 1;
    state.initialPeerCoveredEpoch = undefined;
  }

  private scheduleAvailabilityRepublish(
    windowId: number,
    availability: WindowAvailabilityState,
  ): void {
    if (
      this.availabilityStates.get(windowId) !== availability ||
      availability.epoch === 0 ||
      !windowIsAvailable(availability, this.peerStates.get(windowId))
    ) {
      return;
    }
    for (const record of this.activeInspectionRecords(windowId)) {
      this.scheduleRecordRepublish(record, windowId, availability);
    }
  }

  private scheduleRecordRepublish(
    record: PanelPortRecord,
    windowId: number,
    availability: WindowAvailabilityState,
  ): void {
    const epoch = availability.epoch;
    if (
      record.republishWindowId !== windowId ||
      record.republishedAvailabilityEpoch >= epoch ||
      record.republishInFlightEpoch !== undefined ||
      this.hasInspectTransitionGate(record)
    ) {
      return;
    }
    const token = record.activationToken;
    const binding = this.bindings.get(record.channel);
    const session = record.inspectSession;
    const republishRequest = this.currentRepublishRequest(record);
    if (
      !token ||
      !binding ||
      !session ||
      !republishRequest ||
      binding.windowId !== windowId ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return;
    }
    record.availabilityRepublish = Object.freeze({
      token: republishRequest.republishToken,
      windowId,
      epoch,
    });
    record.republishInFlightEpoch = epoch;
    void this.panelSessions.republishSelection(record.channel, republishRequest)
      .then(() => {
        if (
          record.republishInFlightEpoch !== epoch ||
          record.republishWindowId !== windowId
        ) {
          return;
        }
        record.republishInFlightEpoch = undefined;
        const current = this.availabilityStates.get(windowId);
        if (current && current.epoch > epoch) {
          this.scheduleAvailabilityRepublish(windowId, current);
        }
      })
      .catch((error) => {
        if (record.republishInFlightEpoch === epoch) {
          record.republishInFlightEpoch = undefined;
        }
        this.reportError(error);
      });
  }

  private prepareControlledWindowTransition(
    windowId: number,
    retainForWindowState: boolean,
  ): Promise<boolean> {
    return this.beginControlledWindowTransition(
      windowId,
      retainForWindowState,
    ).promise;
  }

  private beginControlledWindowTransition(
    windowId: number,
    retainForWindowState: boolean,
  ): PreparedControlledWindowTransition {
    const retainer = {};
    const retainToken = retainForWindowState ? {} : undefined;
    const cleanups: ControlledInspectCleanup[] = [];
    const retirements = this.retiringInspectRetirementsForWindow(windowId);
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      const activationToken = record.activationToken;
      if (
        !binding ||
        !activationToken ||
        binding.windowId !== windowId ||
        !record.registration ||
        !record.inspectSession ||
        !record.contentSessionId ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        continue;
      }
      const cleanup = this.prepareControlledRecordCleanup(
        record,
        activationToken,
        binding,
        record.contentSessionId,
        false,
      );
      cleanup.transientRetainers.add(retainer);
      if (retainToken) cleanup.windowTransitionRetainers.add(retainToken);
      cleanups.push(cleanup);
    }
    const finish = (): void => {
      this.revokeInspectWindow(windowId);
      for (const cleanup of cleanups) {
        cleanup.transientRetainers.delete(retainer);
        this.tryReleaseControlledCleanup(cleanup);
      }
    };
    const promise = Promise.all([
      Promise.all(cleanups.map((cleanup) => cleanup.promise)),
      Promise.all(retirements),
    ]).then(
      ([results]) => {
        finish();
        return results.every(Boolean);
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
    return {
      cleanups: Object.freeze([...cleanups]),
      promise,
      ...(retainToken ? { retainToken } : {}),
    };
  }

  private releasePreparedControlledWindowTransition(
    transition: PreparedControlledWindowTransition,
  ): void {
    if (!transition.retainToken) return;
    for (const cleanup of transition.cleanups) {
      if (
        this.controlledInspectCleanups.get(cleanup.record.channel) === cleanup &&
        this.isCurrentControlledCleanup(cleanup)
      ) {
        cleanup.windowTransitionRetainers.delete(transition.retainToken);
        this.tryReleaseControlledCleanup(cleanup);
      }
    }
  }

  private invokeCoordinatorUnlink(
    windowId: number,
    signal: AbortSignal,
    commandToken: object,
    prepared: PreparedControlledWindowTransition,
  ): Promise<void> {
    const expected: ExpectedNestedWindowTransition = {
      commandToken,
      kind: "unlink",
      prepared,
    };
    this.expectedNestedWindowTransitions.set(windowId, expected);
    try {
      return this.coordinator.unlinkWindow(windowId, signal);
    } finally {
      if (this.expectedNestedWindowTransitions.get(windowId) === expected) {
        this.expectedNestedWindowTransitions.delete(windowId);
      }
    }
  }

  private prepareControlledInspectTabTransition(
    tabId: number,
    command?: RefreshExecutionCommand,
  ): Promise<boolean> {
    const retainer = {};
    const cleanups: ControlledInspectCleanup[] = [];
    const retirements = this.retiringInspectRetirementsForTab(tabId);
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      const activationToken = record.activationToken;
      if (
        !binding ||
        !activationToken ||
        binding.tabId !== tabId ||
        !record.registration ||
        !record.inspectSession ||
        !record.contentSessionId ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        continue;
      }
      const cleanup = this.prepareControlledRecordCleanup(
        record,
        activationToken,
        binding,
        record.contentSessionId,
        false,
      );
      cleanup.transientRetainers.add(retainer);
      const transition = this.pendingTabRefreshTransitions.get(record.channel);
      if (
        transition &&
        transition.record === record &&
        transition.activationToken === activationToken &&
        transition.binding === binding &&
        transition.contentSessionId === record.contentSessionId &&
        transition.windowId === binding.windowId &&
        command?.refreshGeneration === transition.refreshGeneration &&
        command.mode === transition.mode
      ) {
        const previousCleanup = transition.cleanup;
        if (previousCleanup !== cleanup) {
          if (previousCleanup) {
            previousCleanup.transientRetainers.delete(transition.token);
            this.tryReleaseControlledCleanup(previousCleanup);
          }
          cleanup.transientRetainers.add(transition.token);
          transition.cleanup = cleanup;
        }
      }
      cleanups.push(cleanup);
    }
    const finish = (): void => {
      this.revokeInspectTab(tabId);
      for (const cleanup of cleanups) {
        cleanup.transientRetainers.delete(retainer);
        this.tryReleaseControlledCleanup(cleanup);
      }
    };
    return Promise.all([
      Promise.all(cleanups.map((cleanup) => cleanup.promise)),
      Promise.all(retirements),
    ]).then(
      ([results]) => {
        finish();
        return results.every(Boolean);
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
  }

  private hasControlledInspectionTarget(windowId: number): boolean {
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      const activationToken = record.activationToken;
      if (
        binding &&
        activationToken &&
        binding.windowId === windowId &&
        record.registration &&
        record.inspectSession &&
        record.contentSessionId &&
        this.isCurrentActivation(record, activationToken, binding)
      ) {
        return true;
      }
    }
    return this.retiringInspectRetirementsForWindow(windowId).length > 0;
  }

  private retiringInspectRetirementsForTab(tabId: number): Promise<void>[] {
    const cleanup = this.retiringInspectCleanups.get(tabId);
    const retirement = cleanup?.requirement.inspectRetirement;
    return cleanup && retirement ? [retirement] : [];
  }

  private retiringInspectRetirementsForWindow(
    windowId: number,
  ): Promise<void>[] {
    const retirements: Promise<void>[] = [];
    for (const cleanup of this.retiringInspectCleanups.values()) {
      const current = this.bindings.get(cleanup.binding.channel);
      const matchesCurrentWindow = Boolean(
        current &&
        sameIdentity(current, cleanup.binding) &&
        current.windowId === windowId,
      );
      if (
        cleanup.binding.windowId === windowId ||
        matchesCurrentWindow
      ) {
        const retirement = cleanup.requirement.inspectRetirement;
        if (retirement) retirements.push(retirement);
      }
    }
    return retirements;
  }

  private prepareControlledRecordCleanup(
    record: PanelPortRecord,
    activationToken: object,
    binding: ChannelBinding,
    contentSessionId: ContentSessionId,
    retainForWindowState: boolean,
  ): ControlledInspectCleanup {
    const existing = this.controlledInspectCleanups.get(record.channel);
    if (
      existing &&
      this.isCurrentControlledCleanup(existing) &&
      existing.record === record &&
      existing.activationToken === activationToken &&
      existing.binding === binding &&
      existing.contentSessionId === contentSessionId
    ) {
      if (retainForWindowState) existing.retainForWindowState = true;
      this.consumePendingWindowTransitionSelection(record, existing);
      return existing;
    }
    if (existing) this.controlledInspectCleanups.delete(record.channel);

    const promise = this.inspectCoordinator
      .clearPseudoStates(binding.tabId, contentSessionId)
      .then((acknowledged) => {
        const current = this.isCurrentControlledCleanupSnapshot(
          record,
          activationToken,
          binding,
          contentSessionId,
        );
        if (!acknowledged && current) {
          this.failCloseControlledCleanup(
            record,
            activationToken,
            binding,
            contentSessionId,
          );
        }
        return acknowledged && current;
      })
      .catch((error: unknown) => {
        this.reportError(error);
        if (this.isCurrentControlledCleanupSnapshot(
          record,
          activationToken,
          binding,
          contentSessionId,
        )) {
          this.failCloseControlledCleanup(
            record,
            activationToken,
            binding,
            contentSessionId,
          );
        }
        return false;
      });
    const cleanup: ControlledInspectCleanup = {
      record,
      activationToken,
      binding,
      contentSessionId,
      promise,
      transientRetainers: new Set(),
      windowTransitionRetainers: new Set(),
      settled: false,
      retainForWindowState,
      republishOnRelease: false,
    };
    this.controlledInspectCleanups.set(record.channel, cleanup);
    this.consumePendingWindowTransitionSelection(record, cleanup);
    void promise.then(() => {
      cleanup.settled = true;
      this.tryReleaseControlledCleanup(cleanup);
    });
    return cleanup;
  }

  private consumePendingWindowTransitionSelection(
    record: PanelPortRecord,
    cleanup: ControlledInspectCleanup,
  ): void {
    const pending = this.currentPendingWindowTransitionSelection(record);
    if (!pending) {
      record.pendingWindowTransitionSelection = undefined;
      return;
    }
    this.inheritPendingTabRefreshSelection(pending, cleanup);
    pending.bufferedSelectionEvent = undefined;
    pending.bufferedInspectSelection = undefined;
    record.pendingWindowTransitionSelection = undefined;
    cleanup.republishOnRelease = true;
  }

  private isCurrentControlledCleanup(
    cleanup: ControlledInspectCleanup,
  ): boolean {
    return this.isCurrentControlledCleanupSnapshot(
      cleanup.record,
      cleanup.activationToken,
      cleanup.binding,
      cleanup.contentSessionId,
    );
  }

  private isCurrentControlledCleanupSnapshot(
    record: PanelPortRecord,
    activationToken: object,
    binding: ChannelBinding,
    contentSessionId: ContentSessionId,
  ): boolean {
    return record.contentSessionId === contentSessionId &&
      record.inspectSession !== undefined &&
      this.isCurrentActivation(record, activationToken, binding);
  }

  private releaseControlledCleanup(cleanup: ControlledInspectCleanup): void {
    cleanup.retainForWindowState = false;
    cleanup.windowTransitionRetainers.clear();
    this.tryReleaseControlledCleanup(cleanup);
  }

  private tryReleaseControlledCleanup(cleanup: ControlledInspectCleanup): void {
    if (
      !cleanup.settled ||
      cleanup.retainForWindowState ||
      cleanup.windowTransitionRetainers.size > 0 ||
      cleanup.transientRetainers.size > 0
    ) return;
    if (this.controlledInspectCleanups.get(cleanup.record.channel) === cleanup) {
      this.commitControlledCleanupSelection(cleanup);
      this.controlledInspectCleanups.delete(cleanup.record.channel);
      if (cleanup.republishOnRelease) {
        const availability = this.availabilityStates.get(
          cleanup.binding.windowId,
        );
        if (availability) {
          this.scheduleAvailabilityRepublish(
            cleanup.binding.windowId,
            availability,
          );
        }
      }
    }
  }

  private commitControlledCleanupSelection(
    cleanup: ControlledInspectCleanup,
  ): void {
    const event = this.latestBufferedSelectionEvent(cleanup);
    cleanup.bufferedSelectionEvent = undefined;
    cleanup.bufferedInspectSelection = undefined;
    if (
      !event ||
      !this.isCurrentControlledCleanup(cleanup) ||
      !this.observeStylesSelectionAuthority(cleanup.record, event)
    ) return;
    this.panelSessions.publish(cleanup.record.channel, event);
  }

  private hasInspectTransitionGate(record: PanelPortRecord): boolean {
    return record.replacingContentSessionId !== undefined ||
      this.controlledInspectCleanups.has(record.channel) ||
      this.pendingTabRefreshTransitions.has(record.channel) ||
      this.pendingTabRefreshAdmissions.has(record.channel) ||
      this.currentPendingWindowTransitionSelection(record) !== undefined;
  }

  private async preparePendingTabRefreshTransitions(
    windowId: number,
    message: PageRefreshMessage,
  ): Promise<PendingTabRefreshTransition[]> {
    const transitions: PendingTabRefreshTransition[] = [];
    const admissions = new Map<
      PendingTabRefreshTransition,
      PendingTabRefreshAdmission
    >();
    for (const record of this.activeInspectionRecords(windowId)) {
      const activationToken = record.activationToken;
      const binding = this.bindings.get(record.channel);
      const contentSessionId = record.contentSessionId;
      if (
        !activationToken ||
        !binding ||
        !contentSessionId ||
        binding.windowId !== windowId ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        continue;
      }
      const transition: PendingTabRefreshTransition = {
        token: {},
        record,
        activationToken,
        binding,
        contentSessionId,
        windowId,
        refreshGeneration: message.refreshGeneration,
        mode: message.mode,
        initialStylesInvalidationAuthority:
          record.stylesInvalidationAuthority,
      };
      const admission: PendingTabRefreshAdmission = {
        token: {},
        record,
        windowId,
        transition,
      };
      this.pendingTabRefreshAdmissions.set(record.channel, admission);
      admissions.set(transition, admission);
      transitions.push(transition);
    }

    try {
      const states = await Promise.all(transitions.map((transition) =>
        this.tabRefreshCoordinator.state(
          transition.binding.tabId,
          transition.windowId,
        )
      ));
      const participating: PendingTabRefreshTransition[] = [];
      for (let index = 0; index < transitions.length; index += 1) {
        const transition = transitions[index]!;
        const state = states[index]!;
        const admission = admissions.get(transition);
        if (
          admission &&
          this.pendingTabRefreshAdmissions.get(transition.record.channel) ===
            admission &&
          this.isCurrentTabRefreshTransitionSnapshot(transition) &&
          state.tabId === transition.binding.tabId &&
          state.windowId === transition.windowId &&
          state.autoRefreshEnabled &&
          state.participant
        ) {
          const previous = this.pendingTabRefreshTransitions.get(
            transition.record.channel,
          );
          if (previous && previous !== transition) {
            this.inheritPendingTabRefreshSelection(previous, transition);
          }
          this.pendingTabRefreshTransitions.set(
            transition.record.channel,
            transition,
          );
          if (previous) this.releasePendingTabRefreshTransition(previous);
          participating.push(transition);
        }
        if (admission) {
          this.releaseTabRefreshAdmission(
            admission,
            this.pendingTabRefreshTransitions.get(transition.record.channel) !==
              transition,
          );
        }
      }
      return participating;
    } catch (error) {
      for (const transition of transitions) {
        this.releasePendingTabRefreshTransition(transition);
        const admission = admissions.get(transition);
        if (admission) this.releaseTabRefreshAdmission(admission, true);
      }
      throw error;
    }
  }

  private isCurrentPendingTabRefreshTransition(
    transition: PendingTabRefreshTransition,
  ): boolean {
    return !this.disposed &&
      this.pendingTabRefreshTransitions.get(transition.record.channel) ===
        transition &&
      this.isCurrentTabRefreshTransitionSnapshot(transition);
  }

  private isCurrentTabRefreshTransitionSnapshot(
    transition: PendingTabRefreshTransition,
  ): boolean {
    return !this.disposed &&
      transition.record.contentSessionId === transition.contentSessionId &&
      transition.record.inspectSession !== undefined &&
      this.isCurrentActivation(
        transition.record,
        transition.activationToken,
        transition.binding,
      );
  }

  private deferTabRefreshSelectionForWindowTransition(
    transition: PendingTabRefreshTransition,
  ): void {
    if (
      !transition.bufferedSelectionEvent &&
      !transition.bufferedInspectSelection
    ) return;
    const cleanup = this.controlledInspectCleanups.get(
      transition.record.channel,
    );
    if (cleanup && this.isCurrentControlledCleanup(cleanup)) {
      this.inheritPendingTabRefreshSelection(transition, cleanup);
      cleanup.republishOnRelease = true;
      transition.bufferedSelectionEvent = undefined;
      transition.bufferedInspectSelection = undefined;
      return;
    }
    const existing = this.currentPendingWindowTransitionSelection(
      transition.record,
    );
    const pending: PendingWindowTransitionSelection = {
      activationToken: transition.activationToken,
      binding: transition.binding,
      contentSessionId: transition.contentSessionId,
      windowId: transition.windowId,
      bufferedSelectionEvent: existing?.bufferedSelectionEvent,
      bufferedInspectSelection: existing?.bufferedInspectSelection,
    };
    this.mergeBufferedSelections(transition.record, transition, pending);
    transition.record.pendingWindowTransitionSelection = pending;
    transition.bufferedSelectionEvent = undefined;
    transition.bufferedInspectSelection = undefined;
  }

  private releasePendingWindowTransitionSelection(
    record: PanelPortRecord,
  ): void {
    const pending = this.currentPendingWindowTransitionSelection(record);
    record.pendingWindowTransitionSelection = undefined;
    if (!pending) return;
    const bufferedInspect = pending.bufferedInspectSelection;
    const event = this.latestBufferedSelectionEvent(pending);
    if (!event || !this.observeStylesSelectionAuthority(record, event)) return;
    this.panelSessions.publish(record.channel, event);
    if (!this.bufferedInspectMatchesEvent(
      bufferedInspect,
      event,
      pending.contentSessionId,
    )) return;
    void this.publishSelection(
      bufferedInspect.payload,
      bufferedInspect.selectionRevision,
      bufferedInspect.contentSessionId,
      undefined,
      event,
      {
        tab: {
          id: pending.binding.tabId,
          windowId: pending.windowId,
        },
      },
    ).catch((error: unknown) => this.reportError(error));
  }

  private releasePendingWindowTransitionSelections(windowId: number): void {
    for (const record of this.panelPorts.values()) {
      if (record.pendingWindowTransitionSelection?.windowId === windowId) {
        this.releasePendingWindowTransitionSelection(record);
      }
    }
  }

  private releasePendingTabRefreshTransition(
    transition: PendingTabRefreshTransition,
    replayBuffered = false,
  ): void {
    const bufferedInspect = replayBuffered &&
        this.isCurrentPendingTabRefreshTransition(transition)
      ? this.commitBufferedSelectionEvent(transition)
      : undefined;
    if (
      this.pendingTabRefreshTransitions.get(transition.record.channel) ===
        transition
    ) {
      this.pendingTabRefreshTransitions.delete(transition.record.channel);
    }
    const cleanup = transition.cleanup;
    transition.cleanup = undefined;
    if (cleanup) {
      cleanup.transientRetainers.delete(transition.token);
      this.tryReleaseControlledCleanup(cleanup);
    }
    if (bufferedInspect) {
      void this.publishSelection(
        bufferedInspect.payload,
        bufferedInspect.selectionRevision,
        bufferedInspect.contentSessionId,
        undefined,
        bufferedInspect.selectionEvent,
        {
          tab: {
            id: transition.binding.tabId,
            windowId: transition.windowId,
          },
        },
      ).catch((error: unknown) => this.reportError(error));
    }
  }

  private dropPendingTabRefreshTransition(record: PanelPortRecord): void {
    const admission = this.pendingTabRefreshAdmissions.get(record.channel);
    if (admission?.record === record) {
      this.pendingTabRefreshAdmissions.delete(record.channel);
    }
    const transition = this.pendingTabRefreshTransitions.get(record.channel);
    if (transition?.record === record) {
      this.releasePendingTabRefreshTransition(transition);
    }
  }

  private completePendingTabRefreshTransition(
    completion: TabRefreshCompletion,
  ): void {
    const channel = this.channelByTab.get(completion.tabId);
    const transition = channel
      ? this.pendingTabRefreshTransitions.get(channel)
      : undefined;
    if (
      !transition ||
      transition.binding.tabId !== completion.tabId ||
      transition.windowId !== completion.windowId ||
      transition.refreshGeneration !== completion.refreshGeneration ||
      transition.mode !== completion.mode
    ) {
      return;
    }
    const transitionCurrent = this.isCurrentPendingTabRefreshTransition(
      transition,
    );
    const controlledCleanupCompleted = transition.cleanup?.settled === true;
    if (completion.accepted && !controlledCleanupCompleted) {
      this.reportError(new Error(
        "Accepted tab refresh completed without controlled inspect cleanup",
      ));
    }
    if (
      completion.accepted &&
      completion.mode === "reload" &&
      controlledCleanupCompleted &&
      transitionCurrent
    ) {
      transition.bufferedSelectionEvent = undefined;
      transition.bufferedInspectSelection = undefined;
      return;
    }
    const bufferedInspect = transitionCurrent
      ? this.commitBufferedSelectionEvent(transition)
      : undefined;
    const request = completion.accepted &&
        controlledCleanupCompleted &&
        this.isCurrentPendingTabRefreshTransition(transition)
      ? this.currentRepublishRequest(transition.record)
      : undefined;
    if (request) {
      const invalidation = transition.record.stylesInvalidationAuthority;
      if (
        invalidation &&
        invalidation !== transition.initialStylesInvalidationAuthority &&
        invalidation.documentEpoch === request.documentEpoch
      ) {
        transition.record.pendingRefreshRenewalToken = undefined;
        transition.record.refreshRepublishAuthority = Object.freeze({
          ...invalidation,
          contentSessionId: request.contentSessionId,
          nodeRef: request.nodeRef,
          selectionRevision: request.selectionRevision,
          republishToken: request.republishToken,
          phase: "pending",
        });
      }
    }
    this.releasePendingTabRefreshTransition(transition);
    if (!request) {
      if (!completion.accepted && bufferedInspect) {
        void this.publishSelection(
          bufferedInspect.payload,
          bufferedInspect.selectionRevision,
          bufferedInspect.contentSessionId,
          undefined,
          bufferedInspect.selectionEvent,
          {
            tab: {
              id: transition.binding.tabId,
              windowId: transition.windowId,
            },
          },
        ).catch((error: unknown) => this.reportError(error));
      }
      return;
    }

    void this.panelSessions.republishSelection(
      transition.record.channel,
      request,
    ).then((republished) => {
      if (
        !republished &&
        transition.record.republishPublication === request
      ) {
        transition.record.republishPublication = undefined;
      }
      if (
        !republished &&
        transition.record.refreshRepublishAuthority?.republishToken ===
          request.republishToken
      ) {
        transition.record.refreshRepublishAuthority = undefined;
      }
    }).catch((error: unknown) => {
      if (transition.record.republishPublication === request) {
        transition.record.republishPublication = undefined;
      }
      if (
        transition.record.refreshRepublishAuthority?.republishToken ===
        request.republishToken
      ) {
        transition.record.refreshRepublishAuthority = undefined;
      }
      this.reportError(error);
    });
  }

  private failCloseControlledCleanup(
    record: PanelPortRecord,
    activationToken: object,
    binding: ChannelBinding,
    contentSessionId: ContentSessionId,
  ): void {
    if (!this.isCurrentControlledCleanupSnapshot(
      record,
      activationToken,
      binding,
      contentSessionId,
    )) {
      return;
    }
    if (!record.inspectSession?.retireContentLease(contentSessionId)) {
      return;
    }
    this.dropPendingTabRefreshTransition(record);
    record.inspectionFailedClosed = true;
    record.contentRecoveryAvailable = false;
    record.contentSessionId = undefined;
    record.replacingContentSessionId = undefined;
    record.pendingWindowTransitionSelection = undefined;
    record.stylesSelectionAuthority = undefined;
    record.stylesInvalidationAuthority = undefined;
    record.refreshRepublishAuthority = undefined;
    this.postToActiveChannel(record.channel, {
      type: "pin-op.inspect.invalidated",
      reason: "documentDisconnected",
    });
    record.panelSessionBinding?.dispose();
    record.panelSessionBinding = undefined;
    this.revokeInspectChannel(record.channel);
  }

  private revokeInspectChannel(channel: string): void {
    const record = this.panelPorts.get(channel);
    if (record) {
      record.inspectPublicationToken = undefined;
      record.republishPublication = undefined;
      record.availabilityRepublish = undefined;
    }
    this.correlations.disposeChannel(channel);
  }

  private revokeInspectTab(tabId: number): void {
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      if (record.inspectTabId === tabId || binding?.tabId === tabId) {
        record.inspectPublicationToken = undefined;
        record.republishPublication = undefined;
        record.availabilityRepublish = undefined;
      }
    }
    this.correlations.disposeTab(tabId);
  }

  private revokeInspectWindow(windowId: number): void {
    for (const record of this.panelPorts.values()) {
      const binding = this.bindings.get(record.channel);
      if (
        record.inspectWindowId === windowId ||
        binding?.windowId === windowId
      ) {
        record.inspectPublicationToken = undefined;
        record.republishPublication = undefined;
        record.availabilityRepublish = undefined;
      }
    }
    this.correlations.disposeWindow(windowId);
  }

  private activeInspectionRecords(windowId: number): PanelPortRecord[] {
    return [...this.panelPorts.values()].filter((record) => {
      const token = record.activationToken;
      const binding = this.bindings.get(record.channel);
      return Boolean(
        token &&
          binding &&
          binding.windowId === windowId &&
          record.registration &&
          record.inspectSession &&
          maintainsInspectionSession(record.lastWindowState) &&
          this.isCurrentActivation(record, token, binding),
      );
    });
  }

  private receiveResolution(
    peerContext: TrustedIdePeerContext,
    message: ResolutionMessage,
  ): void {
    if (this.disposed) {
      return;
    }
    const route = this.correlations.routeForInspect(message.inspectMessageId);
    const record = route ? this.panelPorts.get(route.channel) : undefined;
    if (!route || !record || this.hasInspectTransitionGate(record)) {
      return;
    }
    const channel = this.correlations.accept(message, peerContext);
    if (!channel) {
      return;
    }
    this.panelSessions.publish(channel, message);
  }

  private receiveSourceNavigationState(
    peerContext: TrustedIdePeerContext,
    message: SourceNavigationStateMessage,
  ): void {
    if (this.disposed) {
      return;
    }
    const route = this.correlations.routeForInspect(message.inspectMessageId);
    const routeRecord = route ? this.panelPorts.get(route.channel) : undefined;
    if (!route || !routeRecord || this.hasInspectTransitionGate(routeRecord)) {
      return;
    }
    const channel = this.correlations.acceptNavigationState(
      message,
      peerContext,
    );
    if (!channel) {
      return;
    }
    const binding = this.bindings.get(channel);
    const record = this.panelPorts.get(channel);
    const token = record?.activationToken;
    if (
      !binding ||
      !record ||
      !token ||
      !record.registration ||
      binding.windowId !== peerContext.windowId ||
      !this.isCurrentActivation(record, token, binding) ||
      !this.correlations.authorizeNavigation({
        channel,
        inspectMessageId: message.inspectMessageId,
        resolutionGeneration: message.resolutionGeneration,
        tabId: binding.tabId,
      })
    ) {
      return;
    }
    this.panelSessions.publish(channel, message);
  }

  private receiveSourceMatches(
    peerContext: TrustedIdePeerContext,
    message: SourceMatchesMessage,
  ): void {
    if (this.disposed || !isTrustedIdePeerContext(peerContext)) {
      return;
    }
    const parsed = parseProtocolData(message, SourceMatchesMessageSchema);
    if (!parsed) {
      return;
    }
    const route = this.correlations.routeForInspect(parsed.inspectMessageId);
    if (!route) {
      return;
    }
    const binding = this.bindings.get(route.channel);
    const record = this.panelPorts.get(route.channel);
    const token = record?.activationToken;
    if (
      !binding ||
      !record ||
      !token ||
      !record.registration ||
      !record.inspectSession ||
      !record.panelSessionBinding ||
      record.inspectTabId !== route.tabId ||
      record.inspectWindowId !== route.windowId ||
      binding.tabId !== route.tabId ||
      binding.windowId !== route.windowId ||
      peerContext.windowId !== route.windowId ||
      isProtocolIncompatible(record) ||
      !maintainsInspectionSession(record.lastWindowState) ||
      this.hasInspectTransitionGate(record) ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return;
    }
    const channel = this.correlations.acceptSourceMatches(parsed, peerContext);
    if (channel !== route.channel) {
      return;
    }
    this.panelSessions.publish(channel, parsed);
  }

  private receiveRulesSources(
    peerContext: TrustedIdePeerContext,
    message: RulesSourcesMessage,
  ): void {
    if (this.disposed || !isTrustedIdePeerContext(peerContext)) return;
    const parsed = parseRulesSourcesProtocolData(
      message,
      RulesSourcesMessageSchema,
    );
    if (!parsed) return;
    const route = this.correlations.routeForInspect(parsed.inspectMessageId);
    if (!route) return;
    const binding = this.bindings.get(route.channel);
    const record = this.panelPorts.get(route.channel);
    const token = record?.activationToken;
    if (
      !binding ||
      !record ||
      !token ||
      !record.registration ||
      !record.inspectSession ||
      !record.panelSessionBinding ||
      record.inspectTabId !== route.tabId ||
      record.inspectWindowId !== route.windowId ||
      binding.tabId !== route.tabId ||
      binding.windowId !== route.windowId ||
      peerContext.windowId !== route.windowId ||
      isProtocolIncompatible(record) ||
      !maintainsInspectionSession(record.lastWindowState) ||
      this.hasInspectTransitionGate(record) ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return;
    }
    const prepared = this.correlations.prepareRulesSources(parsed, peerContext);
    if (!prepared || prepared.channel !== route.channel) return;
    if (!this.panelSessions.publish(prepared.channel, parsed)) {
      prepared.rollback();
      return;
    }
    if (!prepared.commit()) {
      this.panelSessions.publishRulesInvalidated(
        prepared.channel,
        parsed.inspectMessageId,
        parsed.rulesGeneration,
      );
    }
  }

  private receivePeerState(
    windowId: number,
    message: PeerStateMessage,
  ): void {
    if (
      this.disposed ||
      !isBrowserId(windowId) ||
      this.removedWindows.has(windowId) ||
      this.peerBlockedWindows.has(windowId)
    ) {
      this.peerStates.delete(windowId);
      this.peerTransitionAuthorities.delete(windowId);
      this.availabilityStates.delete(windowId);
      return;
    }
    const previous = this.peerStates.get(windowId);
    if (
      previous?.sessionId === message.sessionId &&
      message.peerGeneration <= previous.generation
    ) {
      return;
    }
    const connectedSessionChanged = message.connected &&
      previous !== undefined &&
      previous.sessionId !== message.sessionId;
    const requiresCleanup = !message.connected || connectedSessionChanged;
    const hasCleanupTarget = requiresCleanup &&
      this.hasControlledInspectionTarget(windowId);
    const cleanup = hasCleanupTarget
      ? this.prepareControlledWindowTransition(windowId, false)
      : undefined;
    if (requiresCleanup && !hasCleanupTarget) {
      this.revokeInspectWindow(windowId);
    }
    const availability = this.getAvailabilityState(windowId);
    const wasAvailable = windowIsAvailable(availability, previous);
    const coveredInitialPeer = previous === undefined &&
      message.connected &&
      availability.epoch > 0 &&
      availability.initialPeerCoveredEpoch === availability.epoch;
    if (!message.connected) {
      if (wasAvailable) {
        this.beginAvailabilityEpoch(availability);
      }
    } else if (previous === undefined) {
      if (!coveredInitialPeer) {
        this.beginAvailabilityEpoch(availability);
      }
    } else if (connectedSessionChanged && wasAvailable) {
      this.beginAvailabilityEpoch(availability);
    }
    const nextPeer = {
      sessionId: message.sessionId,
      connected: message.connected,
      generation: message.peerGeneration,
    };
    const transitionAuthority = {};
    const refreshEpoch = this.windowRefreshEpoch(windowId);
    this.peerStates.set(windowId, nextPeer);
    this.peerTransitionAuthorities.set(windowId, transitionAuthority);
    const previousTransition = this.peerTransitionTails.get(windowId) ??
      undefined;
    const publishAcceptedPeerState = (acknowledged: boolean): void => {
      if (
        this.disposed ||
        this.removedWindows.has(windowId) ||
        this.peerBlockedWindows.has(windowId) ||
        this.peerTransitionAuthorities.get(windowId) !== transitionAuthority ||
        this.peerStates.get(windowId) !== nextPeer ||
        this.windowRefreshEpoch(windowId) !== refreshEpoch
      ) {
        return;
      }
      if (!acknowledged) {
        this.reportError(new Error(
          "Peer transition cleanup was not acknowledged",
        ));
      }
      if (message.connected) {
        void this.tabRefreshCoordinator
          .beginWindowEpoch(windowId)
          .catch((error) => this.reportError(error));
      }
      for (const record of this.activeInspectionRecords(windowId)) {
        const token = record.activationToken;
        const binding = this.bindings.get(record.channel);
        if (
          !token ||
          !binding ||
          binding.windowId !== windowId ||
          !record.inspectSession ||
          !this.isCurrentActivation(record, token, binding)
        ) {
          continue;
        }
        this.panelSessions.publish(record.channel, message);
      }
      if (message.connected) {
        this.scheduleAvailabilityRepublish(windowId, availability);
      }
    };
    if (!cleanup && !previousTransition) {
      publishAcceptedPeerState(true);
      return;
    }
    const operation = (previousTransition ?? Promise.resolve()).then(async () => {
      publishAcceptedPeerState(cleanup ? await cleanup : true);
    });
    const tail = operation.then(
      () => undefined,
      (error: unknown) => this.reportError(error),
    );
    this.peerTransitionTails.set(windowId, tail);
    void tail.finally(() => {
      if (this.peerTransitionTails.get(windowId) === tail) {
        this.peerTransitionTails.delete(windowId);
      }
    });
  }

  private receiveProtocolMismatch(windowId: number): void {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    const cleanup = this.hasControlledInspectionTarget(windowId)
      ? this.prepareControlledWindowTransition(windowId, false)
      : undefined;
    if (cleanup) {
      void cleanup.then(
        () => this.commitProtocolMismatch(windowId),
        (error: unknown) => {
          this.reportError(error);
          this.commitProtocolMismatch(windowId);
        },
      );
      return;
    }
    this.commitProtocolMismatch(windowId);
  }

  private commitProtocolMismatch(windowId: number): void {
    if (this.disposed) return;
    this.revokeInspectWindow(windowId);
    this.peerBlockedWindows.add(windowId);
    this.peerStates.delete(windowId);
    this.peerTransitionAuthorities.delete(windowId);
    this.availabilityStates.delete(windowId);
    this.contentRefreshCoordinator.revokeWindow(windowId);
    void this.tabRefreshCoordinator
      .clearWindowPending(windowId)
      .catch((error) => this.reportError(error));
  }

  private postToCurrentPort(
    record: PanelPortRecord,
    token: object,
    message: unknown,
  ): boolean {
    if (
      this.panelPorts.get(record.channel) !== record ||
      record.activationToken !== token
    ) {
      return false;
    }
    try {
      record.port.postMessage(message);
      return true;
    } catch {
      // A disappearing panel is finalized by its disconnect event.
      return false;
    }
  }

  private postToActiveChannel(channel: string, message: unknown): boolean {
    const record = this.panelPorts.get(channel);
    const token = record?.activationToken;
    if (!record || !token) {
      return false;
    }
    return this.postToCurrentPort(record, token, message);
  }

  private isCurrentPending(pending: PendingRegistration): boolean {
    return (
      !this.disposed &&
      pending.disposeGeneration === this.disposeGeneration &&
      this.pendingRegistrations.get(pending.channel) === pending
    );
  }

  private isCurrentActivation(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
  ): boolean {
    return (
      !this.disposed &&
      this.panelPorts.get(record.channel) === record &&
      record.activationToken === token &&
      record.bindingGeneration === binding.generation &&
      !binding.suspended &&
      this.bindings.get(binding.channel) === binding
    );
  }

  private isCurrentPanelCommand(
    record: PanelPortRecord,
    binding: ChannelBinding,
    command: PanelCommandRecord,
  ): boolean {
    return (
      this.panelCommands.get(record.channel) === command &&
      command.bindingGeneration === binding.generation &&
      command.abortController !== undefined &&
      !command.abortController.signal.aborted &&
      this.isCurrentActivation(record, command.activationToken, binding)
    );
  }

  private isCurrentWindowCommand(
    windowId: number,
    commandToken: object,
  ): boolean {
    return (
      !this.disposed &&
      this.windowCommands.get(windowId) === commandToken
    );
  }

  private isCurrentWindowPanelCommand(
    windowId: number,
    record: PanelPortRecord,
    binding: ChannelBinding,
    command: PanelCommandRecord,
  ): boolean {
    return (
      binding.windowId === windowId &&
      this.isCurrentWindowCommand(windowId, command.commandToken) &&
      this.isCurrentPanelCommand(record, binding, command)
    );
  }

  private acceptPageRefreshAfterWindowCommand(
    windowId: number,
    message: PageRefreshMessage,
    refreshEpoch = this.windowRefreshEpoch(windowId),
  ): void {
    if (
      this.disposed ||
      this.removedWindows.has(windowId) ||
      this.windowRefreshEpoch(windowId) !== refreshEpoch
    ) {
      return;
    }
    const commandToken = this.windowCommands.get(windowId);
    const completion = commandToken
      ? this.windowCommandCompletions.get(windowId)
      : undefined;
    if (commandToken) {
      if (!completion) {
        this.reportError(new Error("Missing window command completion gate"));
        return;
      }
      void completion.promise.then(() =>
        this.acceptPageRefreshAfterWindowCommand(windowId, message, refreshEpoch)
      );
      return;
    }
    let refreshTransitions: PendingTabRefreshTransition[] = [];
    const releaseRefreshTransitions = (): void => {
      for (const transition of refreshTransitions) {
        this.releasePendingTabRefreshTransition(transition, true);
      }
      refreshTransitions = [];
    };
    void this.tabRefreshCoordinator
      .acceptPageRefresh(windowId, message, async () => {
        try {
          if (
            this.disposed ||
            this.removedWindows.has(windowId) ||
            this.windowRefreshEpoch(windowId) !== refreshEpoch
          ) {
            return false;
          }
          if (refreshTransitions.length > 0) return false;
          refreshTransitions = await this.preparePendingTabRefreshTransitions(
            windowId,
            message,
          );
          const current = !this.disposed &&
            !this.removedWindows.has(windowId) &&
            this.windowRefreshEpoch(windowId) === refreshEpoch;
          if (!current) releaseRefreshTransitions();
          return current;
        } catch (error) {
          releaseRefreshTransitions();
          this.reportError(error);
          return false;
        }
      }, (completion) => this.completePendingTabRefreshTransition(completion))
      .then((accepted) => {
        if (!accepted) releaseRefreshTransitions();
      })
      .catch((error) => {
        releaseRefreshTransitions();
        this.reportError(error);
      });
  }

  private windowRefreshEpoch(windowId: number): number {
    return this.windowRefreshEpochs.get(windowId) ?? 0;
  }

  private beginWindowRefreshEpoch(windowId: number): void {
    this.windowRefreshEpochs.set(
      windowId,
      this.windowRefreshEpoch(windowId) + 1,
    );
    const transitions = [...this.pendingTabRefreshTransitions.values()]
      .filter((transition) => transition.windowId === windowId);
    const admissions = [...this.pendingTabRefreshAdmissions.values()]
      .filter((admission) => admission.windowId === windowId);
    for (const transition of transitions) {
      this.deferTabRefreshSelectionForWindowTransition(transition);
    }
    for (const admission of admissions) {
      this.deferTabRefreshSelectionForWindowTransition(admission.transition);
    }
    for (const transition of transitions) {
      this.releasePendingTabRefreshTransition(transition);
    }
    for (const admission of admissions) {
      this.releaseTabRefreshAdmission(admission, false);
    }
  }

  private createWindowCommandCompletion(): WindowCommandCompletion {
    let resolveCompletion: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let released = false;
    return {
      promise,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        resolveCompletion();
      },
    };
  }

  private acquireWindowCommand(windowId: number, commandToken: object): void {
    this.windowCommands.set(windowId, commandToken);
    this.windowCommandCompletions.set(
      windowId,
      this.createWindowCommandCompletion(),
    );
  }

  private releaseWindowCommandForWindow(
    windowId: number,
    commandToken: object,
  ): boolean {
    if (this.windowCommands.get(windowId) !== commandToken) {
      return false;
    }
    this.windowCommands.delete(windowId);
    const completion = this.windowCommandCompletions.get(windowId);
    this.windowCommandCompletions.delete(windowId);
    completion?.release();
    return true;
  }

  private releaseWindowCommand(commandToken: object): void {
    for (const [windowId, currentToken] of this.windowCommands) {
      if (currentToken === commandToken) {
        this.releaseWindowCommandForWindow(windowId, commandToken);
      }
    }
  }

  private abortPanelCommand(
    record: PanelPortRecord,
    activationToken: object,
  ): void {
    const command = this.panelCommands.get(record.channel);
    if (
      command?.activationToken === activationToken
    ) {
      if (command.abortController) {
        command.abortController.abort();
      } else if (this.panelPorts.get(record.channel) !== record) {
        this.releaseWindowCommand(command.commandToken);
      }
    }
  }

  private removeBinding(
    binding: ChannelBinding,
    preserveRequiredTeardown = false,
  ): void {
    if (this.bindings.get(binding.channel) !== binding) {
      return;
    }
    this.bindings.delete(binding.channel);
    if (
      !preserveRequiredTeardown &&
      this.requiredPanelTeardowns.get(binding.channel)?.binding === binding
    ) {
      this.requiredPanelTeardowns.delete(binding.channel);
    }
    if (this.channelByTab.get(binding.tabId) === binding.channel) {
      this.channelByTab.delete(binding.tabId);
    }
    if (this.channelBySource.get(binding.sourceId) === binding.channel) {
      this.channelBySource.delete(binding.sourceId);
    }
  }

  private isTrustedDevtoolsSender(sender: BackgroundMessageSender): boolean {
    return (
      typeof this.expectedDevtoolsUrl === "string" &&
      this.expectedDevtoolsUrl.length > 0 &&
      sender.url === this.expectedDevtoolsUrl
    );
  }

  private isExpectedPanelSender(
    sender: BackgroundMessageSender | undefined,
    channel: string,
  ): boolean {
    if (
      typeof this.expectedPanelUrl !== "string" ||
      this.expectedPanelUrl.length === 0 ||
      typeof sender?.url !== "string"
    ) {
      return false;
    }
    try {
      const expected = new URL(this.expectedPanelUrl);
      expected.search = "";
      expected.hash = "";
      expected.searchParams.set("channel", channel);
      return sender.url === expected.href;
    } catch {
      return false;
    }
  }

  private allocateGeneration(): number {
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    return generation;
  }

  private currentRepublishRequest(
    record: PanelPortRecord,
  ): InspectRepublishRequest | undefined {
    const contentSessionId = record.contentSessionId;
    const authority = record.stylesSelectionAuthority;
    if (!contentSessionId || !authority?.selected) return undefined;
    const republishToken = this.allocateRepublishToken();
    const request = Object.freeze({
      type: "pin-op.inspect.republish",
      contentSessionId,
      documentEpoch: authority.documentEpoch,
      nodeRef: authority.nodeRef,
      selectionRevision: authority.selectionRevision,
      republishToken,
    } satisfies InspectRepublishRequest);
    record.republishPublication = request;
    record.availabilityRepublish = undefined;
    return request;
  }

  private allocateRepublishToken(): string {
    const token = "republish-" + this.nextRepublishToken;
    this.nextRepublishToken += 1;
    return token;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics cannot break background ownership.
    }
  }
}

export function createBackgroundRouter(
  options: BackgroundRouterOptions,
): BackgroundRouter {
  return new BackgroundRouter(options);
}

function parseRegistrationMessage(
  value: unknown,
): RegistrationIdentity | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "channel", "tabId", "sourceId"]) ||
    value.type !== "pin-op.registerDevtools" ||
    !isValidDevtoolsChannel(value.channel) ||
    !isBrowserId(value.tabId) ||
    typeof value.sourceId !== "string"
  ) {
    return undefined;
  }
  const source = ClientSourceSchema.safeParse({
    role: "browser",
    id: value.sourceId,
    metadata: {},
  });
  return source.success
    ? {
        channel: value.channel,
        tabId: value.tabId,
        sourceId: source.data.id,
      }
    : undefined;
}

function parsePanelWindowCommand(
  value: unknown,
): PanelWindowCommand | undefined {
  if (!isRecord(value) || !isValidDevtoolsChannel(value.channel)) {
    return undefined;
  }
  if (
    value.type === "pin-op.linkWindow" &&
    hasOnlyKeys(value, ["type", "channel", "code"]) &&
    typeof value.code === "string" &&
    /^[0-9]{7}$/.test(value.code)
  ) {
    return {
      type: "pin-op.linkWindow",
      channel: value.channel,
      code: value.code,
    };
  }
  if (
    value.type === "pin-op.unlinkWindow" &&
    hasOnlyKeys(value, ["type", "channel"])
  ) {
    return {
      type: "pin-op.unlinkWindow",
      channel: value.channel,
    };
  }
  return undefined;
}

interface ContentSelectionEnvelope {
  readonly contentSessionId: ContentSessionId;
  readonly selectionRevision: number;
  readonly republishToken?: string;
  readonly selectionEvent?: StylesSelectionEvent;
  readonly payload: InspectPayload;
}

interface ContentDomEventEnvelope {
  readonly contentSessionId: ContentSessionId;
  readonly event: DomEvent;
}

interface ContentStylesEventEnvelope {
  readonly contentSessionId: ContentSessionId;
  readonly event: StylesEvent;
}

function parseElementSelectedMessage(
  value: unknown,
): ContentSelectionEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const hasDocumentEpoch = Object.hasOwn(value, "documentEpoch");
  const hasNodeRef = Object.hasOwn(value, "nodeRef");
  const hasAncestorPath = Object.hasOwn(value, "ancestorPath");
  const hasSelectionIdentity = hasDocumentEpoch || hasNodeRef || hasAncestorPath;
  if (
    (hasSelectionIdentity &&
      !(hasDocumentEpoch && hasNodeRef && hasAncestorPath)) ||
    !hasOnlyKeys(value, [
      "type",
      "contentSessionId",
      "selectionRevision",
      "payload",
      ...(Object.hasOwn(value, "republishToken") ? ["republishToken"] : []),
      ...(hasSelectionIdentity
        ? ["documentEpoch", "nodeRef", "ancestorPath"]
        : []),
    ]) ||
    value.type !== "elementSelected" ||
    !isValidContentSessionId(value.contentSessionId) ||
    !isSelectionRevision(value.selectionRevision) ||
    (Object.hasOwn(value, "republishToken") &&
      !isValidInspectRepublishToken(value.republishToken)) ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }
  try {
    const parsedSelectionEvent = hasSelectionIdentity
      ? parseDomEvent({
          type: "dom.selectionChanged",
          documentEpoch: value.documentEpoch,
          selectionRevision: value.selectionRevision,
          nodeRef: value.nodeRef,
          ancestorPath: value.ancestorPath,
        })
      : undefined;
    const selectionEvent = parsedSelectionEvent?.type === "dom.selectionChanged"
      ? parsedSelectionEvent
      : undefined;
    if (hasSelectionIdentity && !selectionEvent) return undefined;
    const parsed = InspectMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      messageId: "background-payload-validation",
      type: "inspect",
      sessionId: "background-payload-validation",
      source: {
        role: "browser",
        id: "background-payload-validation",
        metadata: {},
      },
      targets: value.payload.targets,
      ruleEvidence: value.payload.ruleEvidence,
      context: value.payload.context,
      ideHighlightEnabled: value.payload.ideHighlightEnabled,
      metadata: value.payload.metadata,
    });
    return parsed.success
      ? {
          contentSessionId: value.contentSessionId,
          selectionRevision: value.selectionRevision,
          ...(value.republishToken === undefined
            ? {}
            : { republishToken: value.republishToken as string }),
          ...(selectionEvent ? { selectionEvent } : {}),
          payload: {
            targets: parsed.data.targets,
            ruleEvidence: parsed.data.ruleEvidence,
            context: parsed.data.context,
            ideHighlightEnabled: parsed.data.ideHighlightEnabled,
            metadata: parsed.data.metadata,
          },
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseContentDomEventMessage(
  value: unknown,
): ContentDomEventEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "contentSessionId", "event"]) ||
    value.type !== "pin-op.dom.event" ||
    !isValidContentSessionId(value.contentSessionId)
  ) {
    return undefined;
  }
  try {
    return {
      contentSessionId: value.contentSessionId,
      event: parseDomEvent(value.event),
    };
  } catch {
    return undefined;
  }
}

function parseContentStylesEventMessage(
  value: unknown,
): ContentStylesEventEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "contentSessionId", "event"]) ||
    value.type !== "pin-op.styles.event" ||
    !isValidContentSessionId(value.contentSessionId)
  ) return undefined;
  try {
    return {
      contentSessionId: value.contentSessionId,
      event: parseStylesEvent(value.event),
    };
  } catch {
    return undefined;
  }
}

function validatedSenderTab(
  sender: BackgroundMessageSender,
): { readonly id: number; readonly windowId?: number } | undefined {
  const id = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (
    !isBrowserId(id) ||
    (windowId !== undefined && !isBrowserId(windowId))
  ) {
    return undefined;
  }
  return windowId === undefined ? { id } : { id, windowId };
}

function resolvedTab(
  tab: BackgroundTab | undefined,
  expectedTabId: number,
): { readonly id: number; readonly windowId: number } | undefined {
  return tab && tab.id === expectedTabId && isBrowserId(tab.windowId)
    ? { id: expectedTabId, windowId: tab.windowId }
    : undefined;
}

function sameIdentity(
  left: RegistrationIdentity,
  right: RegistrationIdentity,
): boolean {
  return (
    left.channel === right.channel &&
    left.tabId === right.tabId &&
    left.sourceId === right.sourceId
  );
}

function validPanelPortLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 1_024)
    : DEFAULT_MAX_PANEL_PORTS;
}

function sanitizedCommandError(error: unknown): BackgroundCommandError {
  if (error instanceof BrowserProtocolError) {
    if (error.code === "link.rateLimited") {
      return "rateLimited";
    }
    if (error.code === "link.invalidCode") {
      return "invalidCode";
    }
  }
  return "error";
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProtocolIncompatible(record: PanelPortRecord): boolean {
  return record.lastWindowState === "incompatible";
}

function revokesSourcePresentationAuthority(
  state: BrowserWindowConnectionState,
): boolean {
  return state === "reconnecting" ||
    state === "offline" ||
    state === "rateLimited" ||
    state === "error" ||
    state === "incompatible" ||
    state === "notLinked";
}

function maintainsInspectionSession(
  state: BrowserWindowConnectionState | undefined,
): boolean {
  return state === "linking" ||
    state === "linked" ||
    state === "offline" ||
    state === "reconnecting";
}

function canRecoverInspectionSession(
  state: BrowserWindowConnectionState | undefined,
  browserLocalInspection: boolean,
): boolean {
  return browserLocalInspection
    ? state !== undefined && state !== "incompatible"
    : maintainsInspectionSession(state);
}

function domQueryRequestId(request: DomRequest): string | undefined {
  return request.type === "dom.getRoot" ||
    request.type === "dom.getChildren" ||
    request.type === "dom.resolveLocator"
    ? request.requestId
    : undefined;
}

function readInspectorQueryRequestId(
  value: unknown,
  expectedType?: "styles.getMatched" | "styles.setPseudoStates",
): string | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const typeDescriptor = Reflect.getOwnPropertyDescriptor(
      descriptors,
      "type",
    )?.value as PropertyDescriptor | undefined;
    const requestIdDescriptor = Reflect.getOwnPropertyDescriptor(
      descriptors,
      "requestId",
    )?.value as PropertyDescriptor | undefined;
    if (
      !typeDescriptor ||
      !requestIdDescriptor ||
      !Object.hasOwn(typeDescriptor, "value") ||
      !Object.hasOwn(requestIdDescriptor, "value")
    ) {
      return undefined;
    }
    const type = typeDescriptor.value;
    const requestId = requestIdDescriptor.value;
    const isAllowedType = expectedType
      ? type === expectedType
      : type === "dom.getRoot" ||
        type === "dom.getChildren" ||
        type === "dom.resolveLocator";
    return isAllowedType &&
        typeof requestId === "string" &&
        requestId.length > 0 &&
        requestId.length <= (expectedType
          ? STYLES_PROTOCOL_MAX_IDENTIFIER_LENGTH
          : DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH)
      ? requestId
      : undefined;
  } catch {
    return undefined;
  }
}

function windowIsAvailable(
  state: WindowAvailabilityState,
  peer: { readonly connected: boolean } | undefined,
): boolean {
  return state.bridgeConnected !== false && peer?.connected !== false;
}

function incompatibleProtocolMessage(
  details: BrowserProtocolMismatch | undefined,
): ProtocolCompatibilityMessage {
  return Object.freeze({
    type: "pin-op.protocol.compatibility",
    compatible: false,
    browserProtocolVersion: PROTOCOL_VERSION,
    peerProtocolVersion: details?.peerProtocolVersion ?? "unknown",
  });
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function safeDisconnect(port: { disconnect(): void }): void {
  try {
    port.disconnect();
  } catch {
    // Teardown remains best effort after browser-side disconnect.
  }
}

let inspectMessageSequence = 0;

function createInspectMessageId(): string {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") {
      return randomUuid.call(globalThis.crypto);
    }
  } catch {
    // Use a bounded process-local fallback below.
  }
  inspectMessageSequence = (inspectMessageSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `inspect-${Date.now().toString(36)}-${inspectMessageSequence.toString(36)}`;
}
