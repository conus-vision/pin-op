import {
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@browser2ide/protocol";
import { isValidDevtoolsChannel } from "./inspectPortProtocol.js";

export const DEFAULT_MAX_INSPECT_CORRELATIONS = 256;

interface InspectCorrelation {
  readonly channel: string;
  readonly tabId: number;
  resolutionGeneration: number;
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
  ): void {
    if (
      !isValidDevtoolsChannel(channel) ||
      !isOpaqueId(inspectMessageId) ||
      !isBrowserId(tabId)
    ) {
      throw new Error("Invalid inspect correlation");
    }
    for (const [recordedId, correlation] of this.correlations) {
      if (correlation.channel === channel) {
        this.correlations.delete(recordedId);
      }
    }
    this.correlations.delete(inspectMessageId);
    this.correlations.set(inspectMessageId, {
      channel,
      tabId,
      resolutionGeneration: -1,
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
    let parsed: ResolutionMessage;
    try {
      parsed = ResolutionMessageSchema.parse(message);
    } catch {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      parsed.resolutionGeneration <= correlation.resolutionGeneration
    ) {
      return undefined;
    }
    correlation.resolutionGeneration = parsed.resolutionGeneration;
    this.correlations.delete(parsed.inspectMessageId);
    this.correlations.set(parsed.inspectMessageId, correlation);
    return correlation.channel;
  }

  public acceptNavigationState(
    message: SourceNavigationStateMessage,
  ): string | undefined {
    const parsed = SourceNavigationStateMessageSchema.safeParse(message);
    if (!parsed.success) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.data.inspectMessageId);
    if (
      !correlation ||
      correlation.resolutionGeneration !== parsed.data.resolutionGeneration
    ) {
      return undefined;
    }
    return correlation.channel;
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
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
