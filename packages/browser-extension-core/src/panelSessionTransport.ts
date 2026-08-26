import {
  PeerStateMessageSchema,
  ResolutionMessageSchema,
  RulesSourcesMessageSchema,
  SourceMatchesMessageSchema,
  SourceNavigationStateMessageSchema,
  type PeerStateMessage,
  type ResolutionMessage,
  type RulesSourcesMessage,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import {
  isDomResponseForRequest,
  parseDomEvent,
  parseDomRequest,
  parseDomResponse,
  type DomEvent,
  type DomRequest,
  type DomResponse,
} from "./domProtocol.js";
import {
  isValidDevtoolsChannel,
  parsePanelInspectStartedState,
  parsePanelRulesSourcesInvalidatedState,
  parseInspectRepublishRequest,
  type InspectRepublishRequest,
} from "./inspectPortProtocol.js";
import {
  parseProtocolData,
  parseRulesSourcesProtocolData,
} from "./protocolDataSnapshot.js";
import {
  isStylesResponseForRequest,
  parseStylesEvent,
  parseStylesRequest,
  parseStylesResponse,
  type StylesErrorCode,
  type StylesRequest,
  type StylesInvalidatedEvent,
  type StylesResponse,
} from "./stylesProtocol.js";

export const DEFAULT_MAX_PANEL_SESSION_CHANNELS = 64;

export interface PanelSessionTransportOptions {
  readonly sendTabMessage: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly postPanelMessage: (
    channel: string,
    message: unknown,
  ) => boolean | void;
  readonly maxChannels?: number;
}

export interface PanelIdeDisconnectedState {
  readonly type: "pin-op.ideState";
  readonly status: "ide-disconnected";
  readonly inspectMessageId: string;
}

interface PanelSessionBinding {
  readonly tabId: number;
  republish?: Promise<boolean>;
  republishRequest?: InspectRepublishRequest;
  republishToken?: object;
}

export class PanelSessionTransport {
  private readonly channels = new Map<string, PanelSessionBinding>();
  private readonly maximumChannels: number;

  public constructor(private readonly options: PanelSessionTransportOptions) {
    this.maximumChannels = validMaximum(options.maxChannels);
  }

  public bind(channel: string, tabId: number): { dispose(): void } {
    if (!isValidDevtoolsChannel(channel) || !isBrowserId(tabId)) {
      throw new Error("Invalid panel session binding");
    }
    if (!this.channels.has(channel) && this.channels.size >= this.maximumChannels) {
      throw new Error("Panel session channel limit reached");
    }
    const binding: PanelSessionBinding = { tabId };
    this.channels.set(channel, binding);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        if (this.channels.get(channel) === binding) {
          this.channels.delete(channel);
        }
      },
    };
  }

  public async request(
    channel: string,
    request: DomRequest,
  ): Promise<DomResponse> {
    let parsed: DomRequest;
    try {
      parsed = parseDomRequest(request);
    } catch {
      return domError("invalid-request", readRequestId(request));
    }
    const binding = this.channels.get(channel);
    if (!binding) {
      return domError("session-disposed", requestIdOf(parsed));
    }
    let raw: unknown;
    try {
      raw = await this.options.sendTabMessage(binding.tabId, parsed);
    } catch {
      return this.channels.get(channel) === binding
        ? domError("internal-error", requestIdOf(parsed))
        : domError("session-disposed", requestIdOf(parsed));
    }
    if (this.channels.get(channel) !== binding) {
      return domError("session-disposed", requestIdOf(parsed));
    }
    try {
      const response = parseDomResponse(raw);
      return isDomResponseForRequest(parsed, response)
        ? response
        : domError("internal-error", requestIdOf(parsed));
    } catch {
      return domError("internal-error", requestIdOf(parsed));
    }
  }

  public async dispatch(channel: string, request: DomRequest): Promise<void> {
    let parsed: DomRequest;
    try {
      parsed = parseDomRequest(request);
    } catch {
      return;
    }
    const binding = this.channels.get(channel);
    if (!binding) {
      return;
    }
    let raw: unknown;
    try {
      raw = await this.options.sendTabMessage(binding.tabId, parsed);
    } catch {
      return;
    }
    if (this.channels.get(channel) !== binding || !Array.isArray(raw)) {
      return;
    }
    for (const candidate of raw) {
      try {
        this.publish(channel, parseDomEvent(candidate));
      } catch {
        // A malformed content response cannot escape its bound channel.
      }
    }
  }

  public async requestStyles(
    channel: string,
    request: StylesRequest,
  ): Promise<StylesResponse> {
    let parsed: StylesRequest;
    try {
      parsed = parseStylesRequest(request);
    } catch {
      return stylesError("invalid-request", readRequestId(request));
    }
    const binding = this.channels.get(channel);
    if (!binding) return stylesError("cancelled", parsed.requestId);
    let raw: unknown;
    try {
      raw = await this.options.sendTabMessage(binding.tabId, parsed);
    } catch {
      return this.channels.get(channel) === binding
        ? stylesError("internal-error", parsed.requestId)
        : stylesError("cancelled", parsed.requestId);
    }
    if (this.channels.get(channel) !== binding) {
      return stylesError("cancelled", parsed.requestId);
    }
    try {
      const response = parseStylesResponse(raw);
      return isStylesResponseForRequest(parsed, response)
        ? response
        : stylesError("internal-error", parsed.requestId);
    } catch {
      return stylesError("internal-error", parsed.requestId);
    }
  }

  public republishSelection(
    channel: string,
    requestValue: InspectRepublishRequest,
  ): Promise<boolean> {
    const request = parseInspectRepublishRequest(requestValue);
    const binding = this.channels.get(channel);
    if (!binding || !request) {
      return Promise.resolve(false);
    }
    if (
      binding.republish &&
      binding.republishRequest &&
      sameRepublishRequest(binding.republishRequest, request)
    ) {
      return binding.republish;
    }
    const republishToken = {};
    binding.republishToken = republishToken;
    const pending = (async (): Promise<boolean> => {
      try {
        const result = await this.options.sendTabMessage(binding.tabId, {
          ...request,
        });
        return this.channels.get(channel) === binding && result === true;
      } catch {
        return false;
      } finally {
        if (binding.republishToken === republishToken) {
          binding.republish = undefined;
          binding.republishRequest = undefined;
          binding.republishToken = undefined;
        }
      }
    })();
    binding.republish = pending;
    binding.republishRequest = request;
    return pending;
  }

  public publish(
    channel: string,
    message:
      | DomEvent
      | StylesInvalidatedEvent
      | ResolutionMessage
      | PeerStateMessage
      | RulesSourcesMessage
      | SourceMatchesMessage
      | SourceNavigationStateMessage,
  ): boolean {
    if (!this.channels.has(channel)) {
      return false;
    }
    const parsed = parsePublishedMessage(message);
    if (!parsed) {
      return false;
    }
    try {
      return this.options.postPanelMessage(channel, parsed) !== false;
    } catch {
      // A panel disconnect owns channel disposal.
      return false;
    }
  }

  public disposeChannel(channel: string): void {
    this.channels.delete(channel);
  }

  public publishIdeDisconnected(
    channel: string,
    inspectMessageId: string,
  ): void {
    if (!this.channels.has(channel) || !isOpaqueId(inspectMessageId)) {
      return;
    }
    const state: PanelIdeDisconnectedState = Object.freeze({
      type: "pin-op.ideState",
      status: "ide-disconnected",
      inspectMessageId,
    });
    try {
      this.options.postPanelMessage(channel, state);
    } catch {
      // A panel disconnect owns channel disposal.
    }
  }

  public publishRulesInvalidated(
    channel: string,
    inspectMessageId: string,
    rulesGeneration: number,
  ): boolean {
    if (!this.channels.has(channel)) return false;
    const state = parsePanelRulesSourcesInvalidatedState({
      type: "pin-op.rules.invalidated",
      inspectMessageId,
      rulesGeneration,
    });
    if (!state) return false;
    try {
      return this.options.postPanelMessage(channel, state) !== false;
    } catch {
      return false;
    }
  }

  public publishInspectStarted(
    channel: string,
    inspectMessageId: string,
    selectionRevision: number,
    expectedRuleRefs: readonly string[],
  ): void {
    if (!this.channels.has(channel)) return;
    const state = parsePanelInspectStartedState({
      type: "pin-op.inspect.started",
      inspectMessageId,
      selectionRevision,
      expectedRuleRefs,
    });
    if (!state) return;
    try {
      this.options.postPanelMessage(channel, state);
    } catch {
      // A panel disconnect owns channel disposal.
    }
  }
}

function sameRepublishRequest(
  left: InspectRepublishRequest,
  right: InspectRepublishRequest,
): boolean {
  return left.contentSessionId === right.contentSessionId &&
    left.documentEpoch === right.documentEpoch &&
    left.nodeRef === right.nodeRef &&
    left.selectionRevision === right.selectionRevision &&
    left.republishToken === right.republishToken;
}

function parsePublishedMessage(
  message:
    | DomEvent
    | StylesInvalidatedEvent
    | ResolutionMessage
    | PeerStateMessage
    | RulesSourcesMessage
    | SourceMatchesMessage
    | SourceNavigationStateMessage,
): PublishedPanelMessage | undefined {
  try {
    return parseDomEvent(message);
  } catch {
    // Non-DOM bridge messages use the generic proxy-safe protocol snapshot.
  }
  try {
    const event = parseStylesEvent(message);
    if (event.type === "styles.invalidated") return event;
  } catch {
    // Non-local bridge messages continue below.
  }
  const rulesSources = parseRulesSourcesProtocolData(
    message,
    RulesSourcesMessageSchema,
  );
  if (rulesSources) return rulesSources;
  return parseProtocolData(message, {
    safeParse(value):
      | { readonly success: true; readonly data: PublishedPanelMessage }
      | { readonly success: false } {
      try {
        if (!isRecord(value) || typeof value.type !== "string") {
          return { success: false };
        }
        const parsed = value.type === "resolution"
          ? ResolutionMessageSchema.safeParse(value)
          : value.type === "peerState"
          ? PeerStateMessageSchema.safeParse(value)
          : value.type === "source.matches"
          ? SourceMatchesMessageSchema.safeParse(value)
          : value.type === "source.navigationState"
          ? SourceNavigationStateMessageSchema.safeParse(value)
          : { success: false as const };
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false };
      } catch {
        return { success: false };
      }
    },
  });
}

type PublishedPanelMessage =
  | DomEvent
  | StylesInvalidatedEvent
  | ResolutionMessage
  | PeerStateMessage
  | RulesSourcesMessage
  | SourceMatchesMessage
  | SourceNavigationStateMessage;

function domError(
  code: "invalid-request" | "session-disposed" | "internal-error",
  requestId?: string,
): DomResponse {
  return Object.freeze({
    type: "dom.error",
    ...(requestId ? { requestId } : {}),
    code,
  });
}

function stylesError(
  code: StylesErrorCode,
  requestId = "invalid-styles-request",
): StylesResponse {
  return Object.freeze({
    type: "styles.error",
    requestId,
    code,
  });
}

function requestIdOf(request: DomRequest): string | undefined {
  return "requestId" in request ? request.requestId : undefined;
}

function readRequestId(value: unknown): string | undefined {
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "requestId");
    return descriptor && "value" in descriptor &&
        typeof descriptor.value === "string" &&
        descriptor.value.length > 0 &&
        descriptor.value.length <= 128
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validMaximum(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_PANEL_SESSION_CHANNELS;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_024) {
    throw new RangeError("Panel session channel limit is invalid");
  }
  return value;
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
