import {
  ClientSourceSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  SourceMatchesMessageSchema,
  type ClientSource,
  type PageRefreshMessage,
  type PeerStateMessage,
  type ResolutionMessage,
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
  parseDomRequest,
  parseDomResponse,
  type DomEvent,
  type DomErrorCode,
  type DomRequest,
} from "./domProtocol.js";
import {
  InspectCorrelationStore,
  type PresentationSettingsAuthority,
  type SourceOpenAuthority,
} from "./inspectCorrelationStore.js";
import { parseProtocolData } from "./protocolDataSnapshot.js";
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
  parseInspectContentLeasePortName,
  parseDevtoolsPanelPortName,
  parseInspectPortRequest,
  parsePanelPresentationSettingsCommand,
  parsePanelSourceOpenCommand,
  parsePanelSourceNavigateCommand,
  parsePanelTabSettingsCommand,
  type ContentSessionId,
  type PanelInspectPort,
  type PanelPresentationSettingsCommand,
  type PanelSourceOpenCommand,
  type PanelSourceNavigateCommand,
} from "./inspectPortProtocol.js";
import { PanelSessionTransport } from "./panelSessionTransport.js";
import {
  createPanelTabStateMessage,
  type ProtocolCompatibilityMessage,
  type TabRefreshState,
} from "./refreshRuntimeProtocol.js";
import type {
  TabRefreshCoordinator,
  TabRefreshSettings,
} from "./tabRefreshCoordinator.js";
import type {
  BrowserWindowConnectionState,
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
  invalidateBinding: boolean;
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
  observeTabUpdate(): void {},
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
  private readonly windowCommandCompletions = new WeakMap<
    object,
    WindowCommandCompletion
  >();
  private readonly panelTeardowns = new Map<
    string,
    { readonly binding: ChannelBinding; readonly promise: Promise<boolean> }
  >();
  private readonly requiredPanelTeardowns = new Map<
    string,
    PanelTeardownRequirement
  >();
  private readonly removedWindows = new Set<number>();
  private readonly peerBlockedWindows = new Set<number>();
  private readonly removeSubscriptions: Array<() => void> = [];
  private readonly peerStates = new Map<
    number,
    {
      readonly sessionId: string;
      readonly connected: boolean;
      readonly generation: number;
    }
  >();
  private readonly availabilityStates = new Map<
    number,
    WindowAvailabilityState
  >();
  private nextGeneration = 1;
  private disposeGeneration = 1;
  private disposed = false;

  public constructor(options: BackgroundRouterOptions) {
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
    if (this.disposed) {
      return undefined;
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

    const selection = parseElementSelectedMessage(message);
    if (!selection) {
      return this.contentRefreshCoordinator.routeMessage(message, sender);
    }
    return this.publishSelection(
      selection.payload,
      selection.selectionRevision,
      selection.contentSessionId,
      sender,
    );
  }

  public connectPort(port: BackgroundRuntimePort): void {
    if (this.disposed) {
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

  public async removeWindow(windowId: number): Promise<void> {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    const tabRefreshRemoval = this.tabRefreshCoordinator.removeWindow(
      windowId,
    );
    this.contentRefreshCoordinator.revokeWindow(windowId);
    this.correlations.disposeWindow(windowId);
    this.removedWindows.add(windowId);
    this.peerStates.delete(windowId);
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

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeGeneration += 1;

    for (const removeSubscription of this.removeSubscriptions.splice(0)) {
      try {
        removeSubscription();
      } catch (error) {
        this.reportError(error);
      }
    }
    for (const record of [...this.panelPorts.values()]) {
      this.closePanelPort(record, true);
    }
    this.pendingRegistrations.clear();
    this.panelCommands.clear();
    for (const commandToken of new Set(this.windowCommands.values())) {
      this.releaseWindowCommand(commandToken);
    }
    this.panelTeardowns.clear();
    this.requiredPanelTeardowns.clear();
    this.bindings.clear();
    this.channelByTab.clear();
    this.channelBySource.clear();
    this.removedWindows.clear();
    this.peerBlockedWindows.clear();
    this.peerStates.clear();
    this.availabilityStates.clear();
    this.contentRefreshCoordinator.dispose();
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
    this.correlations.disposeTab(tabId);
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
    this.contentRefreshCoordinator.revokeTab(tabId);
    this.correlations.disposeTab(tabId);
    for (const pending of this.pendingRegistrations.values()) {
      if (pending.tabId === tabId && this.isCurrentPending(pending)) {
        pending.detachedWindowId = oldWindowId;
      }
    }
    void this.tabRefreshCoordinator
      .detachTab(tabId, oldWindowId)
      .catch((error) => this.reportError(error));
    void this.contentRefreshCoordinator
      .detachTab(tabId)
      .catch((error) => this.reportError(error));

    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    if (
      !binding ||
      binding.tabId !== tabId ||
      binding.windowId !== oldWindowId ||
      binding.suspended
    ) {
      return;
    }

    const suspended: ChannelBinding = {
      ...binding,
      generation: this.allocateGeneration(),
      suspended: true,
    };
    this.bindings.set(suspended.channel, suspended);
    const record = this.panelPorts.get(suspended.channel);
    if (record) {
      this.clearPanelActivation(record, true);
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
        void this.attachMovedBindingAfterTeardown(binding, newWindowId);
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
    const replacement = this.replaceBindingWindow(binding, newWindowId);
    const record = this.panelPorts.get(replacement.channel);
    if (record) {
      this.activatePanelPort(record, replacement);
    }
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
    this.contentRefreshCoordinator.observeTabUpdate(tabId, update);
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
    this.peerBlockedWindows.add(windowId);
    this.contentRefreshCoordinator.revokeWindow(windowId);
    this.correlations.disposeWindow(windowId);
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
    const activationToken = record.activationToken;
    if (preserveInspection) {
      this.correlations.disposeChannel(record.channel);
      if (settlePendingInspect) {
        record.inspectSession?.suspend("stalePanel");
      }
    } else {
      this.disposeInspectionSession(record, settlePendingInspect);
    }
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
        onContentLeaseAttached: (contentSessionId) => {
          if (
            this.panelPorts.get(record.channel) === record &&
            record.inspectSession === session
          ) {
            record.contentSessionId = contentSessionId;
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
    const binding = this.bindings.get(record.channel);
    const token = record.activationToken;
    const recover = reason === "documentDisconnected" &&
      record.contentRecoveryAvailable &&
      token !== undefined &&
      binding !== undefined &&
      this.isCurrentActivation(record, token, binding) &&
      maintainsInspectionSession(record.lastWindowState);
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
    const session = record.inspectSession;
    record.inspectSession = undefined;
    record.inspectTabId = undefined;
    record.inspectWindowId = undefined;
    record.contentSessionId = undefined;
    record.panelSessionBinding?.dispose();
    record.panelSessionBinding = undefined;
    record.contentRecoveryAvailable = false;
    this.panelSessions.disposeChannel(record.channel);
    this.correlations.disposeChannel(record.channel);
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
    this.clearPanelActivation(record);
    if (closedTabId !== undefined) {
      this.contentRefreshCoordinator.revokeTab(closedTabId);
      if (activeBinding) {
        void this.requestPanelTeardown(activeBinding, false);
      } else {
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
    const commandToken = this.createWindowCommandToken();
    this.windowCommands.set(leasedWindowId, commandToken);
    let dispatchedBinding: ChannelBinding | undefined;
    let dispatchedCommand: PanelCommandRecord | undefined;
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
        this.windowCommands.delete(leasedWindowId);
        leasedWindowId = refreshed.windowId;
        this.windowCommands.set(leasedWindowId, commandToken);
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
        await this.coordinator.linkWindow(
          refreshed.windowId,
          command.code,
          source,
          abortController.signal,
        );
      } else {
        this.contentRefreshCoordinator.revokeWindow(refreshed.windowId);
        this.correlations.disposeChannel(command.channel);
        this.peerBlockedWindows.add(refreshed.windowId);
        await this.coordinator.unlinkWindow(
          refreshed.windowId,
          abortController.signal,
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
      this.releaseWindowCommand(commandToken);
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
      let domRequest: DomRequest;
      try {
        domRequest = parseDomRequest(message);
      } catch {
        const requestId = readDomQueryRequestId(message);
        if (requestId) {
          this.postDomQueryError(record, requestId, "invalid-request");
        }
        return;
      }
      this.queueDomRequest(record, activationToken, domRequest);
      return;
    }
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
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
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
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
        record.activationToken !== activationToken ||
        !record.inspectSession ||
        !record.panelSessionBinding ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        settleQuery("session-disposed");
        return;
      }
      if (requestId) {
        const inspectSession = record.inspectSession;
        const panelSessionBinding = record.panelSessionBinding;
        const response = await this.panelSessions.request(record.channel, request);
        if (
          record.inspectSession !== inspectSession ||
          record.panelSessionBinding !== panelSessionBinding ||
          !this.isCurrentActivation(record, activationToken, binding)
        ) {
          settleQuery("session-disposed");
          return;
        }
        this.postToCurrentPort(record, activationToken, response);
        return;
      }
      await this.panelSessions.dispatch(record.channel, request);
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
      settleQuery("internal-error");
    });
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

  private invalidatePanelBinding(
    binding: ChannelBinding,
  ): Promise<boolean> {
    this.contentRefreshCoordinator.revokeTab(binding.tabId);
    return this.requestPanelTeardown(binding, true);
  }

  private requestPanelTeardown(
    binding: ChannelBinding,
    invalidateBinding: boolean,
  ): Promise<boolean> {
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (required && required.binding !== binding) {
      return Promise.resolve(false);
    }
    if (required) {
      required.invalidateBinding ||= invalidateBinding;
    } else {
      this.requiredPanelTeardowns.set(binding.channel, {
        binding,
        invalidateBinding,
      });
    }
    const existing = this.panelTeardowns.get(binding.channel);
    if (existing?.binding === binding) {
      return existing.promise;
    }
    const promise = this.performPanelBindingTeardown(binding).finally(() => {
      if (this.panelTeardowns.get(binding.channel)?.promise === promise) {
        this.panelTeardowns.delete(binding.channel);
      }
    });
    this.panelTeardowns.set(binding.channel, { binding, promise });
    return promise;
  }

  private async awaitPanelTeardownForActivation(
    binding: ChannelBinding,
  ): Promise<boolean> {
    const pending = this.panelTeardowns.get(binding.channel);
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (pending?.binding !== binding && required?.binding !== binding) {
      return true;
    }
    return pending?.binding === binding
      ? await pending.promise
      : await this.requestPanelTeardown(
          binding,
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
      required?.binding === binding
    ) {
      await this.requestPanelTeardown(
        binding,
        required.invalidateBinding,
      );
    }
  }

  private hasRequiredPanelTeardown(binding: ChannelBinding): boolean {
    return this.panelTeardowns.get(binding.channel)?.binding === binding ||
      this.requiredPanelTeardowns.get(binding.channel)?.binding === binding;
  }

  private async performPanelBindingTeardown(
    binding: ChannelBinding,
  ): Promise<boolean> {
    const required = this.requiredPanelTeardowns.get(binding.channel);
    if (required?.binding !== binding) {
      return true;
    }
    try {
      await this.tabRefreshCoordinator.panelClosed(
        binding.tabId,
        binding.windowId,
      );
    } catch (error) {
      this.reportError(error);
      return false;
    }
    const completed = this.requiredPanelTeardowns.get(binding.channel);
    if (completed?.binding !== binding) {
      return true;
    }
    if (completed.invalidateBinding) {
      const record = this.panelPorts.get(binding.channel);
      if (record?.bindingGeneration === binding.generation) {
        record.port.onMessage.removeListener(record.onMessage);
        this.clearPanelActivation(record, true);
        record.onMessage = (message) =>
          this.rejectPendingInspect(record, message);
        record.port.onMessage.addListener(record.onMessage);
      }
      this.removeBinding(binding, true);
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
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) {
      return undefined;
    }
    const channel = this.channelByTab.get(senderTab.id);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = channel ? this.panelPorts.get(channel) : undefined;
    if (
      !binding ||
      !record ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      record.bindingGeneration !== binding.generation ||
      !record.registration ||
      !record.activationToken
    ) {
      return undefined;
    }
    const token = record.activationToken;
    const refreshed = await this.refreshPanelBinding(binding, record, token);
    if (
      !refreshed ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
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
      !record.activationToken ||
      !this.isCurrentActivation(record, record.activationToken, refreshed)
    ) {
      return undefined;
    }
    const inspectPayload: InspectPayload = {
      targets: payload.targets,
      context: payload.context,
      ideHighlightEnabled: tabState.ideHighlightEnabled,
      metadata: payload.metadata,
    };
    try {
      inspectMessageId = this.inspectMessageId();
      this.correlations.record(
        refreshed.channel,
        inspectMessageId,
        refreshed.tabId,
        refreshed.windowId,
      );
      this.panelSessions.publishInspectStarted(
        refreshed.channel,
        inspectMessageId,
        selectionRevision,
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
    }
    return okResult;
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
    if (
      !binding ||
      !record ||
      !record.inspectSession ||
      record.contentSessionId !== contentSessionId ||
      record.bindingGeneration !== binding.generation ||
      (senderTab.windowId !== undefined &&
        senderTab.windowId !== binding.windowId)
    ) {
      return undefined;
    }
    this.panelSessions.publish(binding.channel, event);
    return okResult;
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
    if (revokesSourcePresentationAuthority(state)) {
      this.correlations.disposeWindow(binding.windowId);
    }
    const operation = queue.tail.then(async () => {
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
      const previousState = record.lastWindowState;
      record.lastWindowState = state;
      if (state === "notLinked") {
        this.peerBlockedWindows.add(binding.windowId);
        this.peerStates.delete(binding.windowId);
        this.availabilityStates.delete(binding.windowId);
        record.republishInFlightEpoch = undefined;
        record.republishedAvailabilityEpoch = 0;
        record.inspectionFailedClosed = false;
        if (record.inspectSession || record.panelSessionBinding) {
          this.disposeInspectionSession(record, false);
        }
      } else if (state === "incompatible") {
        this.peerBlockedWindows.add(binding.windowId);
        if (record.inspectSession || record.panelSessionBinding) {
          this.disposeInspectionSession(record, false);
        }
      } else if (
        (state === "linking" || state === "linked") &&
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
      record.republishInFlightEpoch !== undefined
    ) {
      return;
    }
    const token = record.activationToken;
    const binding = this.bindings.get(record.channel);
    const session = record.inspectSession;
    if (
      !token ||
      !binding ||
      !session ||
      binding.windowId !== windowId ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return;
    }
    record.republishInFlightEpoch = epoch;
    void this.panelSessions.republishSelection(record.channel)
      .then((republished) => {
        if (
          record.republishInFlightEpoch !== epoch ||
          record.republishWindowId !== windowId
        ) {
          return;
        }
        record.republishInFlightEpoch = undefined;
        if (
          republished &&
          record.inspectSession === session &&
          this.isCurrentActivation(record, token, binding)
        ) {
          record.republishedAvailabilityEpoch = Math.max(
            record.republishedAvailabilityEpoch,
            epoch,
          );
        }
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
      this.availabilityStates.delete(windowId);
      return;
    }
    const activeRecords = this.activeInspectionRecords(windowId);
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
    if (!message.connected || connectedSessionChanged) {
      this.correlations.disposeWindow(windowId);
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
    this.peerStates.set(windowId, {
      sessionId: message.sessionId,
      connected: message.connected,
      generation: message.peerGeneration,
    });
    if (message.connected) {
      void this.tabRefreshCoordinator
        .beginWindowEpoch(windowId)
        .catch((error) => this.reportError(error));
    }
    for (const record of activeRecords) {
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
  }

  private receiveProtocolMismatch(windowId: number): void {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    this.contentRefreshCoordinator.revokeWindow(windowId);
    this.correlations.disposeWindow(windowId);
    this.peerBlockedWindows.add(windowId);
    this.peerStates.delete(windowId);
    this.availabilityStates.delete(windowId);
    void this.tabRefreshCoordinator
      .clearWindowPending(windowId)
      .catch((error) => this.reportError(error));
  }

  private postToCurrentPort(
    record: PanelPortRecord,
    token: object,
    message: unknown,
  ): void {
    if (
      this.panelPorts.get(record.channel) !== record ||
      record.activationToken !== token
    ) {
      return;
    }
    try {
      record.port.postMessage(message);
    } catch {
      // A disappearing panel is finalized by its disconnect event.
    }
  }

  private postToActiveChannel(channel: string, message: unknown): void {
    const record = this.panelPorts.get(channel);
    const token = record?.activationToken;
    if (!record || !token) {
      return;
    }
    this.postToCurrentPort(record, token, message);
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
  ): void {
    if (this.disposed) {
      return;
    }
    const commandToken = this.windowCommands.get(windowId);
    const completion = commandToken
      ? this.windowCommandCompletions.get(commandToken)
      : undefined;
    if (completion) {
      void completion.promise.then(() =>
        this.acceptPageRefreshAfterWindowCommand(windowId, message)
      );
      return;
    }
    void this.tabRefreshCoordinator
      .acceptPageRefresh(windowId, message)
      .catch((error) => this.reportError(error));
  }

  private createWindowCommandToken(): object {
    const commandToken = {};
    let resolveCompletion: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let released = false;
    this.windowCommandCompletions.set(commandToken, {
      promise,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        resolveCompletion();
      },
    });
    return commandToken;
  }

  private releaseWindowCommand(commandToken: object): void {
    for (const [windowId, currentToken] of this.windowCommands) {
      if (currentToken === commandToken) {
        this.windowCommands.delete(windowId);
      }
    }
    const completion = this.windowCommandCompletions.get(commandToken);
    this.windowCommandCompletions.delete(commandToken);
    completion?.release();
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
  readonly payload: InspectPayload;
}

interface ContentDomEventEnvelope {
  readonly contentSessionId: ContentSessionId;
  readonly event: DomEvent;
}

function parseElementSelectedMessage(
  value: unknown,
): ContentSelectionEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "type",
      "contentSessionId",
      "selectionRevision",
      "payload",
    ]) ||
    value.type !== "elementSelected" ||
    !isValidContentSessionId(value.contentSessionId) ||
    !isSelectionRevision(value.selectionRevision) ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }
  try {
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
      context: value.payload.context,
      ideHighlightEnabled: value.payload.ideHighlightEnabled,
      metadata: value.payload.metadata,
    });
    return parsed.success
      ? {
          contentSessionId: value.contentSessionId,
          selectionRevision: value.selectionRevision,
          payload: {
            targets: parsed.data.targets,
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

function domQueryRequestId(request: DomRequest): string | undefined {
  return request.type === "dom.getRoot" ||
    request.type === "dom.getChildren" ||
    request.type === "dom.resolveLocator"
    ? request.requestId
    : undefined;
}

function readDomQueryRequestId(value: unknown): string | undefined {
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
    return (
      type === "dom.getRoot" ||
      type === "dom.getChildren" ||
      type === "dom.resolveLocator"
    ) &&
        typeof requestId === "string" &&
        requestId.length > 0 &&
        requestId.length <= DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH
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
