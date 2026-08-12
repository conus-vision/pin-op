import type {
  ProtocolErrorCode,
  ResolutionDiagnosticCode,
  ResolutionMessage,
  ResolutionStatus,
} from "@pinop/protocol";
import type { BrowserConnectionState } from "./bridgeClient.js";

export interface PanelErrorSummary {
  readonly code?: ProtocolErrorCode;
  readonly message: string;
}

export interface PanelLinkDetails {
  readonly url: string;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
}

export interface PanelDiagnosticsSnapshot {
  readonly connectionState: BrowserConnectionState;
  readonly link?: PanelLinkDetails;
  readonly lastMessageSentAt?: Date;
  readonly lastError?: PanelErrorSummary;
  readonly inaccessibleStylesheetCount: number;
  readonly matchedCssFactCount: number;
  readonly resolution?: PanelResolutionSummary;
}

export type PanelResolutionSummary =
  | { readonly status: "resolving" | "ide-disconnected" }
  | {
      readonly status: ResolutionStatus;
      readonly resolutionGeneration: number;
      readonly selectedMatchCount: number;
      readonly parentMatchCount: number;
      readonly inaccessibleStylesheetCount: number;
      readonly diagnosticCodes: readonly ResolutionDiagnosticCode[];
    };

export class PanelDiagnostics {
  private connectionState: BrowserConnectionState = "disconnected";
  private link: PanelLinkDetails | undefined;
  private lastMessageSentAt: Date | undefined;
  private lastError: PanelErrorSummary | undefined;
  private inaccessibleStylesheetCount = 0;
  private matchedCssFactCount = 0;
  private resolution: PanelResolutionSummary | undefined;

  public setConnectionState(state: BrowserConnectionState): void {
    this.connectionState = state;
  }

  public setLink(link: PanelLinkDetails | undefined): void {
    this.link = link ? { ...link } : undefined;
  }

  public recordSelection(
    targets: readonly {
      readonly facts: readonly { readonly type?: unknown }[];
    }[],
    inaccessibleStylesheetCount: number,
  ): void {
    this.matchedCssFactCount = targets.flatMap((target) => target.facts).filter(
      (fact) => fact.type === "css-rule",
    ).length;
    this.inaccessibleStylesheetCount = inaccessibleStylesheetCount;
  }

  public recordMessageSent(at = new Date()): void {
    this.lastMessageSentAt = at;
  }

  public recordResolving(): void {
    this.resolution = { status: "resolving" };
  }

  public recordIdeDisconnected(): void {
    this.resolution = { status: "ide-disconnected" };
  }

  public recordResolution(message: ResolutionMessage): void {
    this.resolution = {
      status: message.status,
      resolutionGeneration: message.resolutionGeneration,
      selectedMatchCount: message.selectedMatchCount,
      parentMatchCount: message.parentMatchCount,
      inaccessibleStylesheetCount: message.inaccessibleStylesheetCount,
      diagnosticCodes: [...message.diagnosticCodes],
    };
  }

  public clearResolution(): void {
    this.resolution = undefined;
  }

  public recordError(error: PanelErrorSummary): void {
    this.lastError = {
      ...error,
      message: sanitizedErrorMessage(error),
    };
  }

  public reset(): void {
    this.connectionState = "disconnected";
    this.link = undefined;
    this.lastMessageSentAt = undefined;
    this.lastError = undefined;
    this.inaccessibleStylesheetCount = 0;
    this.matchedCssFactCount = 0;
    this.resolution = undefined;
  }

  public snapshot(): PanelDiagnosticsSnapshot {
    return {
      connectionState: this.connectionState,
      link: this.link,
      lastMessageSentAt: this.lastMessageSentAt,
      lastError: this.lastError,
      inaccessibleStylesheetCount: this.inaccessibleStylesheetCount,
      matchedCssFactCount: this.matchedCssFactCount,
      resolution: cloneResolution(this.resolution),
    };
  }
}

function sanitizedErrorMessage(error: PanelErrorSummary): string {
  if (error.code === undefined) {
    return error.message;
  }
  return (
    PROTOCOL_ERROR_MESSAGES[error.code] ?? "PinOp protocol error"
  );
}

const PROTOCOL_ERROR_MESSAGES: Readonly<
  Record<ProtocolErrorCode, string>
> = {
  "link.invalidCode": "Link request was rejected",
  "link.unreachable": "Link request was rejected",
  "link.rejected": "Link request was rejected",
  "link.rateLimited": "Link requests are temporarily rate-limited",
  "auth.tokenRejected": "Saved link is no longer valid",
  "auth.instanceChanged": "Saved link is no longer valid",
  "protocol.invalidMessage": "Bridge sent an invalid protocol message",
  "bridge.noIdeClient": "No IDE client is connected",
  "bridge.noBrowserClient": "No browser client is connected",
  "bridge.offline": "Bridge is offline",
  "resolver.fileNotFound": "Source file was not found",
  "resolver.sourceMapFailed": "Source map resolution failed",
  "browser.stylesheetInaccessible":
    "A stylesheet could not be inspected",
};

function cloneResolution(
  resolution: PanelResolutionSummary | undefined,
): PanelResolutionSummary | undefined {
  if (!resolution || !("diagnosticCodes" in resolution)) {
    return resolution ? { ...resolution } : undefined;
  }
  return {
    ...resolution,
    diagnosticCodes: [...resolution.diagnosticCodes],
  };
}
