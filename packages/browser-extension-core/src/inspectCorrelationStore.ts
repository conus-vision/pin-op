import {
  InspectRuleEvidenceBatchSchema,
  RESOLUTION_LIMITS,
  ResolutionMessageSchema,
  RulesSourcesMessageSchema,
  SourceMatchesMessageSchema,
  SourceNavigationStateMessageSchema,
  type InspectRuleEvidenceBatch,
  type ResolutionMessage,
  type RulesSourcesMessage,
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

const sourcePresentationAuthorityRevision: unique symbol = Symbol(
  "sourcePresentationAuthorityRevision",
);
const rulesOpenAuthorityRevision: unique symbol = Symbol(
  "rulesOpenAuthorityRevision",
);
const sourceResolutionGenerationBrand: unique symbol = Symbol(
  "sourceResolutionGenerationBrand",
);
const rulesGenerationBrand: unique symbol = Symbol("rulesGenerationBrand");

type SourceResolutionGeneration = number & {
  readonly [sourceResolutionGenerationBrand]: true;
};

type RulesGeneration = number & {
  readonly [rulesGenerationBrand]: true;
};

interface InspectCorrelation {
  readonly channel: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly expectedRuleRefs: ReadonlySet<string>;
  sourceAuthorityRevision: bigint;
  rulesAuthorityRevision: bigint;
  resolutionGeneration: number;
  rulesGeneration: number;
  sessionId?: string;
  sourceId?: string;
  document?: SourceDocument;
  sourcePeerContext?: TrustedIdePeerContext;
  rulesPeerContext?: TrustedIdePeerContext;
  matchIds: Set<string>;
  ruleOpenAuthorityIds: Set<string>;
}

export interface SourceOpenAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: SourceResolutionGeneration;
  readonly matchId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly context: TrustedIdePeerContext;
  readonly [sourcePresentationAuthorityRevision]: bigint;
}

export interface InspectCorrelationRoute {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly expectedRuleRefs: ReadonlySet<string>;
}

export interface PresentationSettingsAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: SourceResolutionGeneration;
  readonly tabId: number;
  readonly windowId: number;
  readonly context: TrustedIdePeerContext;
  readonly [sourcePresentationAuthorityRevision]: bigint;
}

export interface RulesOpenAuthority {
  readonly channel: string;
  readonly inspectMessageId: string;
  readonly rulesGeneration: RulesGeneration;
  readonly openAuthorityId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly context: TrustedIdePeerContext;
  readonly [rulesOpenAuthorityRevision]: bigint;
}

export class InspectCorrelationStore {
  private readonly correlations = new Map<string, InspectCorrelation>();
  private authorityRevisionSequence = 0n;

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
    ruleEvidence: InspectRuleEvidenceBatch,
  ): void {
    const parsedRuleEvidence = InspectRuleEvidenceBatchSchema.safeParse(
      ruleEvidence,
    );
    if (
      !isValidDevtoolsChannel(channel) ||
      !isOpaqueId(inspectMessageId) ||
      !isBrowserId(tabId) ||
      !isBrowserId(windowId) ||
      !parsedRuleEvidence.success
    ) {
      throw new Error("Invalid inspect correlation");
    }
    const expectedRuleRefs = new Set(
      parsedRuleEvidence.data.rules.map(({ ruleRef }) => ruleRef),
    );
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
      expectedRuleRefs,
      sourceAuthorityRevision: this.nextAuthorityRevision(),
      rulesAuthorityRevision: this.nextAuthorityRevision(),
      resolutionGeneration: -1,
      rulesGeneration: -1,
      matchIds: new Set(),
      ruleOpenAuthorityIds: new Set(),
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
    correlation.sourcePeerContext = peerContext;
    correlation.matchIds.clear();
    correlation.sourceAuthorityRevision = this.nextAuthorityRevision();
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
          expectedRuleRefs: new Set(correlation.expectedRuleRefs),
        })
      : undefined;
  }

  public acceptRulesSources(
    message: RulesSourcesMessage,
    peerContext: TrustedIdePeerContext,
  ): string | undefined {
    if (!isTrustedIdePeerContext(peerContext)) {
      return undefined;
    }
    const parsed = parseProtocolData(message, RulesSourcesMessageSchema);
    if (!parsed) {
      return undefined;
    }
    const correlation = this.correlations.get(parsed.inspectMessageId);
    if (
      !correlation ||
      correlation.windowId !== peerContext.windowId ||
      !payloadMatchesPeer(parsed, peerContext) ||
      (correlation.sourceId !== undefined &&
        (correlation.sourceId !== peerContext.source.id ||
          correlation.sessionId !== peerContext.sessionId)) ||
      (correlation.rulesGeneration < 0
        ? parsed.rulesGeneration !== 1
        : parsed.rulesGeneration <= correlation.rulesGeneration) ||
      !rulesSourcesCoverExpectedRefs(parsed, correlation.expectedRuleRefs)
    ) {
      return undefined;
    }

    correlation.sessionId = peerContext.sessionId;
    correlation.sourceId = peerContext.source.id;
    correlation.rulesGeneration = parsed.rulesGeneration;
    correlation.rulesPeerContext = peerContext;
    correlation.ruleOpenAuthorityIds = new Set(
      parsed.sources.map(({ openAuthorityId }) => openAuthorityId),
    );
    correlation.rulesAuthorityRevision = this.nextAuthorityRevision();
    this.correlations.delete(parsed.inspectMessageId);
    this.correlations.set(parsed.inspectMessageId, correlation);
    return correlation.channel;
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
      !payloadMatchesPeer(parsed, peerContext) ||
      (correlation.sourceId !== undefined &&
        !correlationMatchesPeer(correlation, peerContext))
    ) {
      return undefined;
    }

    if (parsed.matches.length === 0 && correlation.resolutionGeneration < 0) {
      correlation.matchIds.clear();
      correlation.sourceAuthorityRevision = this.nextAuthorityRevision();
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
      correlation.sourcePeerContext = peerContext;
    }
    correlation.sourceAuthorityRevision = this.nextAuthorityRevision();
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
    const context = correlation?.sourcePeerContext;
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
      resolutionGeneration: asSourceResolutionGeneration(
        correlation.resolutionGeneration,
      ),
      matchId: record.matchId,
      tabId: correlation.tabId,
      windowId: correlation.windowId,
      context,
      [sourcePresentationAuthorityRevision]:
        correlation.sourceAuthorityRevision,
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
    const context = correlation?.sourcePeerContext;
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
      resolutionGeneration: asSourceResolutionGeneration(
        correlation.resolutionGeneration,
      ),
      tabId: correlation.tabId,
      windowId: correlation.windowId,
      context,
      [sourcePresentationAuthorityRevision]:
        correlation.sourceAuthorityRevision,
    } as PresentationSettingsAuthority);
  }

  public authorizeRulesOpen(
    input: unknown,
  ): RulesOpenAuthority | undefined {
    const record = snapshotExactDataRecord(input, [
      "channel",
      "tabId",
      "windowId",
      "inspectMessageId",
      "rulesGeneration",
      "openAuthorityId",
    ]);
    if (
      !record ||
      !isValidDevtoolsChannel(record.channel) ||
      !isBrowserId(record.tabId) ||
      !isBrowserId(record.windowId) ||
      !isOpaqueId(record.inspectMessageId) ||
      !isResolutionGeneration(record.rulesGeneration) ||
      !isOpaqueId(record.openAuthorityId)
    ) {
      return undefined;
    }
    const correlation = this.correlations.get(record.inspectMessageId);
    const context = correlation?.rulesPeerContext;
    if (
      !correlation ||
      !context ||
      !isTrustedIdePeerContext(context) ||
      correlation.channel !== record.channel ||
      correlation.tabId !== record.tabId ||
      correlation.windowId !== record.windowId ||
      correlation.rulesGeneration !== record.rulesGeneration ||
      !correlation.ruleOpenAuthorityIds.has(record.openAuthorityId as string)
    ) {
      return undefined;
    }
    return Object.freeze({
      channel: correlation.channel,
      inspectMessageId: record.inspectMessageId,
      rulesGeneration: asRulesGeneration(correlation.rulesGeneration),
      openAuthorityId: record.openAuthorityId,
      tabId: correlation.tabId,
      windowId: correlation.windowId,
      context,
      [rulesOpenAuthorityRevision]: correlation.rulesAuthorityRevision,
    } as RulesOpenAuthority);
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
      correlation.sourcePeerContext !== authority.context ||
      correlation.sourceAuthorityRevision !==
        authority[sourcePresentationAuthorityRevision]
    ) {
      return false;
    }
    return this.correlations.delete(authority.inspectMessageId);
  }

  public discardRulesOpenAuthority(authority: RulesOpenAuthority): boolean {
    const correlation = this.correlations.get(authority.inspectMessageId);
    if (
      !correlation ||
      correlation.channel !== authority.channel ||
      correlation.tabId !== authority.tabId ||
      correlation.windowId !== authority.windowId ||
      correlation.rulesGeneration !== authority.rulesGeneration ||
      correlation.rulesPeerContext !== authority.context ||
      !correlation.ruleOpenAuthorityIds.has(authority.openAuthorityId) ||
      correlation.rulesAuthorityRevision !== authority[rulesOpenAuthorityRevision]
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

  private nextAuthorityRevision(): bigint {
    this.authorityRevisionSequence += 1n;
    return this.authorityRevisionSequence;
  }
}

function matchesCurrentAuthority(
  message: SourceMatchesMessage,
  correlation: InspectCorrelation,
  peerContext: TrustedIdePeerContext,
): boolean {
  return correlation.resolutionGeneration === message.resolutionGeneration &&
    correlation.sourcePeerContext !== undefined &&
    correlationMatchesPeer(correlation, peerContext) &&
    payloadMatchesPeer(message, peerContext) &&
    correlation.document !== undefined &&
    correlation.document.label === message.document.label &&
    correlation.document.languageId === message.document.languageId;
}

function rulesSourcesCoverExpectedRefs(
  message: RulesSourcesMessage,
  expectedRuleRefs: ReadonlySet<string>,
): boolean {
  if (
    message.sources.length + message.unresolvedRuleCount !==
      expectedRuleRefs.size
  ) {
    return false;
  }
  for (const source of message.sources) {
    if (!expectedRuleRefs.has(source.ruleRef)) {
      return false;
    }
  }
  return true;
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

function asSourceResolutionGeneration(
  value: number,
): SourceResolutionGeneration {
  return value as SourceResolutionGeneration;
}

function asRulesGeneration(value: number): RulesGeneration {
  return value as RulesGeneration;
}
