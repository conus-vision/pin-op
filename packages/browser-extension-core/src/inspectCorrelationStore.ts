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

export const DEFAULT_MAX_INSPECT_CORRELATIONS = 256;

interface InspectCorrelation {
  readonly channel: string;
  readonly tabId: number;
  readonly windowId?: number;
  resolutionGeneration: number;
  sessionId?: string;
  sourceId?: string;
  document?: SourceDocument;
  matchIds: Set<string>;
}

export interface SourceOpenAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly matchId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly sessionId: string;
  readonly source: {
    readonly role: "ide";
    readonly id: string;
  };
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
    windowId?: number,
  ): void {
    if (
      !isValidDevtoolsChannel(channel) ||
      !isOpaqueId(inspectMessageId) ||
      !isBrowserId(tabId) ||
      (windowId !== undefined && !isBrowserId(windowId))
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
      ...(windowId === undefined ? {} : { windowId }),
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

  public accept(message: ResolutionMessage): string | undefined {
    const parsed = parseProtocolData(message, ResolutionMessageSchema);
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      parsed.resolutionGeneration <= correlation.resolutionGeneration ||
      (correlation.sourceId !== undefined &&
        (correlation.sourceId !== parsed.source.id ||
          correlation.sessionId !== parsed.sessionId))
    ) {
      return undefined;
    }
    correlation.resolutionGeneration = parsed.resolutionGeneration;
    correlation.sessionId = parsed.sessionId;
    correlation.sourceId = parsed.source.id;
    correlation.document = parsed.document
      ? Object.freeze({ ...parsed.document })
      : undefined;
    correlation.matchIds.clear();
    this.correlations.delete(parsed.inspectMessageId);
    this.correlations.set(parsed.inspectMessageId, correlation);
    return correlation.channel;
  }

  public acceptNavigationState(
    message: SourceNavigationStateMessage,
  ): string | undefined {
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
      correlation.resolutionGeneration !== parsed.resolutionGeneration ||
      correlation.sessionId !== parsed.sessionId ||
      correlation.sourceId !== parsed.source.id
    ) {
      return undefined;
    }
    return correlation.channel;
  }

  public acceptSourceMatches(message: unknown): string | undefined {
    const parsed = parseProtocolData(message, SourceMatchesMessageSchema);
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (!correlation) {
      return undefined;
    }

    if (parsed.matches.length === 0 && correlation.resolutionGeneration < 0) {
      correlation.matchIds.clear();
      return correlation.channel;
    }
    if (!matchesCurrentAuthority(parsed, correlation)) {
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
    return correlation.channel;
  }

  public authorizeSourceOpen(input: unknown): boolean {
    const record = snapshotExactDataRecord(input, [
      "channel",
      "tabId",
      "windowId",
      "inspectMessageId",
      "resolutionGeneration",
      "matchId",
      "sessionId",
      "source",
    ]);
    const source = snapshotSource(record?.source);
    if (
      !record ||
      !source ||
      !isValidDevtoolsChannel(record.channel) ||
      !isBrowserId(record.tabId) ||
      !isBrowserId(record.windowId) ||
      !isOpaqueId(record.inspectMessageId) ||
      !isResolutionGeneration(record.resolutionGeneration) ||
      !isOpaqueId(record.matchId) ||
      !isOpaqueId(record.sessionId)
    ) {
      return false;
    }
    const correlation = this.correlations.get(record.inspectMessageId);
    return Boolean(
      correlation &&
        correlation.channel === record.channel &&
        correlation.tabId === record.tabId &&
        correlation.windowId === record.windowId &&
        correlation.resolutionGeneration === record.resolutionGeneration &&
        correlation.sessionId === record.sessionId &&
        correlation.sourceId === source.id &&
        correlation.matchIds.has(record.matchId as string),
    );
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
}

function matchesCurrentAuthority(
  message: SourceMatchesMessage,
  correlation: InspectCorrelation,
): boolean {
  return correlation.resolutionGeneration === message.resolutionGeneration &&
    correlation.sessionId === message.sessionId &&
    correlation.sourceId === message.source.id &&
    correlation.document !== undefined &&
    correlation.document.label === message.document.label &&
    correlation.document.languageId === message.document.languageId;
}

function snapshotSource(value: unknown): { readonly id: string } | undefined {
  const source = snapshotExactDataRecord(value, ["role", "id"]);
  return source?.role === "ide" && isOpaqueId(source.id)
    ? Object.freeze({ id: source.id })
    : undefined;
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
