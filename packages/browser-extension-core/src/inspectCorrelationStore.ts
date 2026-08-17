import {
  RESOLUTION_LIMITS,
  ResolutionMessageSchema,
  SourceMatchesMessageSchema,
  SourceNavigationStateMessageSchema,
  type ResolutionMessage,
  type SourceDocument,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { isValidDevtoolsChannel } from "./inspectPortProtocol.js";
import {
  parseProtocolData,
  snapshotExactDataRecord,
} from "./protocolDataSnapshot.js";
import {
  isTrustedIdePeerContext,
  trustedIdePeerMatchesPayload,
  type TrustedIdePeerContext,
} from "./trustedIdePeerContext.js";

export const DEFAULT_MAX_INSPECT_CORRELATIONS = 256;

interface InspectCorrelation {
  readonly channel: string;
  readonly tabId: number;
  readonly windowId: number;
  resolutionGeneration: number;
  sessionId?: string;
  sourceId?: string;
  document?: SourceDocument;
  peerContext?: TrustedIdePeerContext;
  matchIds: Set<string>;
}

export interface SourceOpenAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly matchId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly context: TrustedIdePeerContext;
}

export interface InspectCorrelationRoute {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly tabId: number;
  readonly windowId: number;
}

export interface PresentationSettingsAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly tabId: number;
  readonly windowId: number;
  readonly context: TrustedIdePeerContext;
}

export class InspectCorrelationStore {
  private readonly correlations = new Map<string, InspectCorrelation>();

  public constructor(
    private readonly maximumSize = DEFAULT_MAX_INSPECT_CORRELATIONS,
  ) {
    if (
      !Number.isSafeInteger(maximumSize) ||
      maximumSize <= 0 ||
      maximumSize > 1_024
    ) {
      throw new RangeError("Inspect correlation limit is invalid");
    }
  }

  public record(
    channel: string,
    inspectMessageId: string,
    tabId: number,
    windowId: number,
  ): void {
    if (
      !isValidDevtoolsChannel(channel) ||
      !isOpaqueId(inspectMessageId) ||
      !isBrowserId(tabId) ||
      !isBrowserId(windowId)
    ) {
      throw new Error("Invalid inspect correlation");
    }
    for (const [recordedId, correlation] of this.correlations) {
      if (correlation.channel === channel || correlation.tabId === tabId) {
        this.correlations.delete(recordedId);
      }
    }
    this.correlations.delete(inspectMessageId);
    this.correlations.set(inspectMessageId, {
      channel,
      tabId,
      windowId,
      resolutionGeneration: -1,
      matchIds: new Set(),
    });
    while (this.correlations.size > this.maximumSize) {
      const oldest = this.correlations.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) {
        break;
      }
      this.correlations.delete(oldest);
    }
  }

  public accept(
    message: ResolutionMessage,
    peerContext: TrustedIdePeerContext,
  ): string | undefined {
    if (!isTrustedIdePeerContext(peerContext)) {
      return undefined;
    }
    const parsed = parseProtocolData(message, ResolutionMessageSchema);
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      correlation.windowId !== peerContext.windowId ||
      !payloadMatchesPeer(parsed, peerContext) ||
      parsed.resolutionGeneration <= correlation.resolutionGeneration ||
      (correlation.sourceId !== undefined &&
        (correlation.sourceId !== peerContext.source.id ||
          correlation.sessionId !== peerContext.sessionId))
    ) {
      return undefined;
    }
    correlation.resolutionGeneration = parsed.resolutionGeneration;
    correlation.sessionId = peerContext.sessionId;
    correlation.sourceId = peerContext.source.id;
    correlation.document = parsed.document
      ? Object.freeze({ ...parsed.document })
      : undefined;
    correlation.peerContext = peerContext;
    correlation.matchIds.clear();
    this.correlations.delete(parsed.inspectMessageId);
    this.correlations.set(parsed.inspectMessageId, correlation);
    return correlation.channel;
  }

  public routeForInspect(
    inspectMessageId: unknown,
  ): InspectCorrelationRoute | undefined {
    if (!isOpaqueId(inspectMessageId)) {
      return undefined;
    }
    const correlation = this.correlations.get(inspectMessageId);
    return correlation
      ? Object.freeze({
          channel: correlation.channel,
          inspectMessageId,
          tabId: correlation.tabId,
          windowId: correlation.windowId,
        })
      : undefined;
  }

  public acceptNavigationState(
    message: SourceNavigationStateMessage,
    peerContext: TrustedIdePeerContext,
  ): string | undefined {
    if (!isTrustedIdePeerContext(peerContext)) {
      return undefined;
    }
    const parsed = parseProtocolData(
      message,
      SourceNavigationStateMessageSchema,
    );
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      !correlationMatchesPeer(correlation, peerContext) ||
      !payloadMatchesPeer(parsed, peerContext) ||
      correlation.resolutionGeneration !== parsed.resolutionGeneration ||
      correlation.sessionId === undefined ||
      correlation.sourceId === undefined
    ) {
      return undefined;
    }
    return correlation.channel;
  }

  public acceptSourceMatches(
    message: unknown,
    peerContext: TrustedIdePeerContext,
  ): string | undefined {
    if (!isTrustedIdePeerContext(peerContext)) {
      return undefined;
    }
    const parsed = parseProtocolData(message, SourceMatchesMessageSchema);
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      correlation.windowId !== peerContext.windowId ||
      !payloadMatchesPeer(parsed, peerContext)
    ) {
      return undefined;
    }

    if (parsed.matches.length === 0 && correlation.resolutionGeneration < 0) {
      correlation.matchIds.clear();
      return correlation.channel;
    }
    if (!matchesCurrentAuthority(parsed, correlation, peerContext)) {
      return undefined;
    }

    const matchIds = new Set<string>();
    for (const match of parsed.matches) {
      if (matchIds.has(match.matchId)) {
        return undefined;
      }
      matchIds.add(match.matchId);
    }
    correlation.matchIds = matchIds;
    if (parsed.matches.length > 0) {
      correlation.peerContext = peerContext;
    }
    return correlation.channel;
  }

  public authorizeSourceOpen(
    input: unknown,
  ): SourceOpenAuthority | undefined {
    const record = snapshotExactDataRecord(input, [
      "channel",
      "tabId",
      "windowId",
      "inspectMessageId",
      "resolutionGeneration",
      "matchId",
    ]);
    if (
      !record ||
      !isValidDevtoolsChannel(record.channel) ||
      !isBrowserId(record.tabId) ||
      !isBrowserId(record.windowId) ||
      !isOpaqueId(record.inspectMessageId) ||
      !isResolutionGeneration(record.resolutionGeneration) ||
      !isOpaqueId(record.matchId)
    ) {
      return undefined;
    }
    const correlation = this.correlations.get(record.inspectMessageId);
    const context = correlation?.peerContext;
    if (
      !correlation ||
      !context ||
      !isTrustedIdePeerContext(context) ||
      correlation.channel !== record.channel ||
      correlation.tabId !== record.tabId ||
      correlation.windowId !== record.windowId ||
      correlation.resolutionGeneration !== record.resolutionGeneration ||
      !correlation.matchIds.has(record.matchId as string)
    ) {
      return undefined;
    }
    return Object.freeze({
      channel: correlation.channel,
      inspectMessageId: record.inspectMessageId,
      resolutionGeneration: correlation.resolutionGeneration,
      matchId: record.matchId,
      tabId: correlation.tabId,
      windowId: correlation.windowId,
      context,
    } as SourceOpenAuthority);
  }

  public authorizePresentationSettings(
    input: unknown,
  ): PresentationSettingsAuthority | undefined {
    const record = snapshotExactDataRecord(input, [
      "channel",
      "tabId",
      "windowId",
      "inspectMessageId",
    ]);
    if (
      !record ||
      !isValidDevtoolsChannel(record.channel) ||
      !isBrowserId(record.tabId) ||
      !isBrowserId(record.windowId) ||
      !isOpaqueId(record.inspectMessageId)
    ) {
      return undefined;
    }
    const correlation = this.correlations.get(record.inspectMessageId);
    const context = correlation?.peerContext;
    if (
      !correlation ||
      !context ||
      !isTrustedIdePeerContext(context) ||
      correlation.channel !== record.channel ||
      correlation.tabId !== record.tabId ||
      correlation.windowId !== record.windowId ||
      correlation.resolutionGeneration < 0
    ) {
      return undefined;
    }
    return Object.freeze({
      channel: correlation.channel,
      inspectMessageId: record.inspectMessageId,
      resolutionGeneration: correlation.resolutionGeneration,
      tabId: correlation.tabId,
      windowId: correlation.windowId,
      context,
    } as PresentationSettingsAuthority);
  }

  public discardSourcePresentationAuthority(
    authority: SourceOpenAuthority | PresentationSettingsAuthority,
  ): boolean {
    const correlation = this.correlations.get(authority.inspectMessageId);
    if (
      !correlation ||
      correlation.channel !== authority.channel ||
      correlation.tabId !== authority.tabId ||
      correlation.windowId !== authority.windowId ||
      correlation.resolutionGeneration !== authority.resolutionGeneration ||
      correlation.peerContext !== authority.context
    ) {
      return false;
    }
    return this.correlations.delete(authority.inspectMessageId);
  }

  public authorizeNavigation(input: {
    readonly channel: string;
    readonly inspectMessageId: string;
    readonly resolutionGeneration: number;
    readonly tabId: number;
  }): boolean {
    if (
      !isValidDevtoolsChannel(input.channel) ||
      !isOpaqueId(input.inspectMessageId) ||
      !isResolutionGeneration(input.resolutionGeneration) ||
      !isBrowserId(input.tabId)
    ) {
      return false;
    }
    const correlation = this.correlations.get(input.inspectMessageId);
    return Boolean(
      correlation &&
        correlation.channel === input.channel &&
        correlation.resolutionGeneration === input.resolutionGeneration &&
        correlation.tabId === input.tabId,
    );
  }

  public discard(inspectMessageId: string): void {
    this.correlations.delete(inspectMessageId);
  }

  public disposeChannel(channel: string): void {
    for (const [inspectMessageId, correlation] of this.correlations) {
      if (correlation.channel === channel) {
        this.correlations.delete(inspectMessageId);
      }
    }
  }

  public disposeTab(tabId: number): void {
    if (!isBrowserId(tabId)) {
      return;
    }
    for (const [inspectMessageId, correlation] of this.correlations) {
      if (correlation.tabId === tabId) {
        this.correlations.delete(inspectMessageId);
      }
    }
  }

  public disposeWindow(windowId: number): void {
    if (!isBrowserId(windowId)) {
      return;
    }
    for (const [inspectMessageId, correlation] of this.correlations) {
      if (correlation.windowId === windowId) {
        this.correlations.delete(inspectMessageId);
      }
    }
  }
}

function matchesCurrentAuthority(
  message: SourceMatchesMessage,
  correlation: InspectCorrelation,
  peerContext: TrustedIdePeerContext,
): boolean {
  return correlation.resolutionGeneration === message.resolutionGeneration &&
    correlation.peerContext !== undefined &&
    correlationMatchesPeer(correlation, peerContext) &&
    payloadMatchesPeer(message, peerContext) &&
    correlation.document !== undefined &&
    correlation.document.label === message.document.label &&
    correlation.document.languageId === message.document.languageId;
}

function correlationMatchesPeer(
  correlation: InspectCorrelation,
  peerContext: TrustedIdePeerContext,
): boolean {
  return correlation.windowId === peerContext.windowId &&
    correlation.sessionId === peerContext.sessionId &&
    correlation.sourceId === peerContext.source.id;
}

function payloadMatchesPeer(
  message: {
    readonly sessionId: string;
    readonly source: { readonly role: "ide"; readonly id: string };
  },
  peerContext: TrustedIdePeerContext,
): boolean {
  return trustedIdePeerMatchesPayload(peerContext, message);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isResolutionGeneration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= RESOLUTION_LIMITS.generation
  );
}
