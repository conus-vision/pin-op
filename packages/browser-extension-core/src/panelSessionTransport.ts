import {
  PeerStateMessageSchema,
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
  type PeerStateMessage,
  type ResolutionMessage,
  type SourceNavigationStateMessage,
} from "@pinop/protocol";
import {
  isDomResponseForRequest,
  isSelectionRevision,
  parseDomEvent,
  parseDomRequest,
  parseDomResponse,
  type DomEvent,
  type DomRequest,
  type DomResponse,
} from "./domProtocol.js";
import { isValidDevtoolsChannel } from "./inspectPortProtocol.js";

export const DEFAULT_MAX_PANEL_SESSION_CHANNELS = 64;

export interface PanelSessionTransportOptions {
  readonly sendTabMessage: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly postPanelMessage: (channel: string, message: unknown) => void;
  readonly maxChannels?: number;
}

export interface PanelIdeDisconnectedState {
  readonly type: "pinop.ideState";
  readonly status: "ide-disconnected";
  readonly inspectMessageId: string;
}

export interface PanelInspectStartedState {
  readonly type: "pinop.inspect.started";
  readonly inspectMessageId: string;
  readonly selectionRevision: number;
}

interface PanelSessionBinding {
  readonly tabId: number;
  republish?: Promise<boolean>;
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

  public republishSelection(channel: string): Promise<boolean> {
    const binding = this.channels.get(channel);
    if (!binding) {
      return Promise.resolve(false);
    }
    if (binding.republish) {
      return binding.republish;
    }
    const republishToken = {};
    binding.republishToken = republishToken;
    const pending = (async (): Promise<boolean> => {
      try {
        const result = await this.options.sendTabMessage(binding.tabId, {
          type: "pinop.inspect.republish",
        });
        return this.channels.get(channel) === binding && result !== false;
      } catch {
        return false;
      } finally {
        if (binding.republishToken === republishToken) {
          binding.republish = undefined;
          binding.republishToken = undefined;
        }
      }
    })();
    binding.republish = pending;
    return pending;
  }

  public publish(
    channel: string,
    message:
      | DomEvent
      | ResolutionMessage
      | PeerStateMessage
      | SourceNavigationStateMessage,
  ): void {
    if (!this.channels.has(channel)) {
      return;
    }
    const parsed = parsePublishedMessage(message);
    if (!parsed) {
      return;
    }
    try {
      this.options.postPanelMessage(channel, parsed);
    } catch {
      // A panel disconnect owns channel disposal.
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
      type: "pinop.ideState",
      status: "ide-disconnected",
      inspectMessageId,
    });
    try {
      this.options.postPanelMessage(channel, state);
    } catch {
      // A panel disconnect owns channel disposal.
    }
  }

  public publishInspectStarted(
    channel: string,
    inspectMessageId: string,
    selectionRevision: number,
  ): void {
    if (
      !this.channels.has(channel) ||
      !isOpaqueId(inspectMessageId) ||
      !isSelectionRevision(selectionRevision)
    ) {
      return;
    }
    const state: PanelInspectStartedState = Object.freeze({
      type: "pinop.inspect.started",
      inspectMessageId,
      selectionRevision,
    });
    try {
      this.options.postPanelMessage(channel, state);
    } catch {
      // A panel disconnect owns channel disposal.
    }
  }
}

function parsePublishedMessage(
  message:
    | DomEvent
    | ResolutionMessage
    | PeerStateMessage
    | SourceNavigationStateMessage,
):
  | DomEvent
  | ResolutionMessage
  | PeerStateMessage
  | SourceNavigationStateMessage
  | undefined {
  try {
    if (isRecord(message) && typeof message.type === "string") {
      if (message.type.startsWith("dom.")) {
        return parseDomEvent(message);
      }
      if (message.type === "resolution") {
        return ResolutionMessageSchema.parse(message);
      }
      if (message.type === "peerState") {
        return PeerStateMessageSchema.parse(message);
      }
      if (message.type === "source.navigationState") {
        return SourceNavigationStateMessageSchema.parse(message);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

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
