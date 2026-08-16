import type {
  ErrorMessage,
  InspectMessage,
  ProtocolErrorCode,
  ResolutionDiagnosticCode,
  ResolutionStatus,
} from "@pin-op/protocol";
import type { ConnectionState } from "./bridgeClient.js";
import type {
  BridgeManagerState,
  BridgeSnapshot,
} from "./bridgeManager.js";
import type { PresenterOutcome } from "./sourcePlugins/resolutionOutcome.js";
import type {
  ResolvedPluginDiagnostic,
  SourceResolution,
} from "./sourcePlugins/types.js";

export interface OutputChannelLike {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

export interface ProtocolErrorSummary {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

export interface DiagnosticsSnapshot {
  readonly bridgeState: BridgeManagerState;
  readonly clientState: ConnectionState;
  readonly url?: string;
  readonly port?: number;
  readonly sessionId: string;
  readonly bridgeInstanceId?: string;
  readonly linkedBrowserCount: number;
  readonly lastInspectAt?: Date;
  readonly targetsReceived: number;
  readonly factsReceived: number;
  readonly matchesResolved: number;
  readonly selectedMatchesResolved: number;
  readonly parentMatchesResolved: number;
  readonly pluginDiagnostics: number;
  readonly lastResolutionStatus?: ResolutionStatus;
  readonly lastResolutionGeneration?: number;
  readonly inaccessibleStylesheetCount: number;
  readonly resolutionDiagnosticCodes: readonly ResolutionDiagnosticCode[];
  readonly sourceDocumentUri?: string;
  readonly pluginDiagnosticDetails: readonly ResolvedPluginDiagnostic[];
  readonly lastProtocolError?: ProtocolErrorSummary;
}

export interface DiagnosticsTrackerOptions {
  readonly now?: () => Date;
}

export class DiagnosticsTracker {
  private readonly now: () => Date;
  private lastInspectAt: Date | undefined;
  private targetsReceived = 0;
  private factsReceived = 0;
  private matchesResolved = 0;
  private selectedMatchesResolved = 0;
  private parentMatchesResolved = 0;
  private pluginDiagnostics = 0;
  private lastResolutionStatus: ResolutionStatus | undefined;
  private lastResolutionGeneration: number | undefined;
  private inaccessibleStylesheetCount = 0;
  private resolutionDiagnosticCodes: ResolutionDiagnosticCode[] = [];
  private sourceDocumentUri: string | undefined;
  private pluginDiagnosticDetails: ResolvedPluginDiagnostic[] = [];
  private lastProtocolError: ProtocolErrorSummary | undefined;

  public constructor(options: DiagnosticsTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public recordInspect(message: InspectMessage): void {
    this.lastInspectAt = this.now();
    this.targetsReceived = message.targets.length;
    this.factsReceived = message.targets.reduce(
      (total, target) => total + target.facts.length,
      0,
    );
    this.clearResolution();
  }

  public recordResolution(
    outcome: PresenterOutcome,
    resolutionGeneration: number,
    resolution?: SourceResolution,
  ): void {
    this.matchesResolved =
      outcome.selectedMatchCount + outcome.parentMatchCount;
    this.selectedMatchesResolved = outcome.selectedMatchCount;
    this.parentMatchesResolved = outcome.parentMatchCount;
    this.pluginDiagnosticDetails = (resolution?.diagnostics ??
      outcome.localDiagnostics).map((entry) => ({ ...entry }));
    this.pluginDiagnostics = this.pluginDiagnosticDetails.length;
    this.lastResolutionStatus = outcome.status;
    this.lastResolutionGeneration = resolutionGeneration;
    this.inaccessibleStylesheetCount = outcome.inaccessibleStylesheetCount;
    this.resolutionDiagnosticCodes = [...outcome.diagnosticCodes];
    this.sourceDocumentUri = resolution?.documentUri;
  }

  public recordProtocolError(error: ErrorMessage): void {
    this.lastProtocolError = { code: error.code, message: error.message };
  }

  public snapshot(
    bridge: BridgeSnapshot,
    clientState: ConnectionState,
  ): DiagnosticsSnapshot {
    return {
      bridgeState: bridge.state,
      clientState,
      ...(bridge.url === undefined ? {} : { url: bridge.url }),
      ...(bridge.port === undefined ? {} : { port: bridge.port }),
      sessionId: bridge.sessionId,
      ...(bridge.bridgeInstanceId === undefined
        ? {}
        : { bridgeInstanceId: bridge.bridgeInstanceId }),
      linkedBrowserCount: bridge.linkedBrowserCount,
      ...(this.lastInspectAt === undefined
        ? {}
        : { lastInspectAt: new Date(this.lastInspectAt.getTime()) }),
      targetsReceived: this.targetsReceived,
      factsReceived: this.factsReceived,
      matchesResolved: this.matchesResolved,
      selectedMatchesResolved: this.selectedMatchesResolved,
      parentMatchesResolved: this.parentMatchesResolved,
      pluginDiagnostics: this.pluginDiagnostics,
      ...(this.lastResolutionStatus === undefined
        ? {}
        : { lastResolutionStatus: this.lastResolutionStatus }),
      ...(this.lastResolutionGeneration === undefined
        ? {}
        : { lastResolutionGeneration: this.lastResolutionGeneration }),
      inaccessibleStylesheetCount: this.inaccessibleStylesheetCount,
      resolutionDiagnosticCodes: [...this.resolutionDiagnosticCodes],
      ...(this.sourceDocumentUri === undefined
        ? {}
        : { sourceDocumentUri: this.sourceDocumentUri }),
      pluginDiagnosticDetails: this.pluginDiagnosticDetails.map((entry) => ({
        ...entry,
      })),
      ...(this.lastProtocolError === undefined
        ? {}
        : { lastProtocolError: { ...this.lastProtocolError } }),
    };
  }

  public clearResolution(): void {
    this.matchesResolved = 0;
    this.selectedMatchesResolved = 0;
    this.parentMatchesResolved = 0;
    this.pluginDiagnostics = 0;
    this.lastResolutionStatus = undefined;
    this.lastResolutionGeneration = undefined;
    this.inaccessibleStylesheetCount = 0;
    this.resolutionDiagnosticCodes = [];
    this.sourceDocumentUri = undefined;
    this.pluginDiagnosticDetails = [];
  }
}

export function writeBridgeDiagnostics(
  output: OutputChannelLike,
  snapshot: DiagnosticsSnapshot,
): void {
  output.appendLine(
    `bridge=${snapshot.bridgeState} client=${snapshot.clientState} url=${snapshot.url ?? "unavailable"} port=${snapshot.port ?? "unavailable"} session=${snapshot.sessionId} instance=${snapshot.bridgeInstanceId ?? "unavailable"} browsers=${snapshot.linkedBrowserCount}`,
  );
  output.appendLine(
    `lastInspect=${formatDate(snapshot.lastInspectAt)} targets=${snapshot.targetsReceived} facts=${snapshot.factsReceived}`,
  );
  output.appendLine(
    `resolution status=${snapshot.lastResolutionStatus ?? "unavailable"} generation=${snapshot.lastResolutionGeneration ?? "unavailable"} document=${documentLabel(snapshot)} selected=${snapshot.selectedMatchesResolved} parent=${snapshot.parentMatchesResolved} inaccessible=${snapshot.inaccessibleStylesheetCount} codes=${snapshot.resolutionDiagnosticCodes.join(",") || "none"}`,
  );
  output.appendLine(
    `sources matches=${snapshot.matchesResolved} pluginDiagnostics=${snapshot.pluginDiagnostics}`,
  );
  for (const diagnostic of snapshot.pluginDiagnosticDetails) {
    output.appendLine(
      `sourceDiagnostic ${singleLine(diagnostic.pluginId)} ${singleLine(diagnostic.code)} ${diagnostic.severity}: ${singleLine(diagnostic.message)}`,
    );
  }
  output.appendLine(
    `protocolError=${snapshot.lastProtocolError ? `${snapshot.lastProtocolError.code}: ${snapshot.lastProtocolError.message}` : "none"}`,
  );
}

function documentLabel(snapshot: DiagnosticsSnapshot): string {
  if (snapshot.sourceDocumentUri) {
    try {
      return decodeURIComponent(
        new URL(snapshot.sourceDocumentUri).pathname.split("/").filter(Boolean)
          .at(-1) ?? "unavailable",
      );
    } catch {
      return snapshot.sourceDocumentUri.split(/[\\/]/).filter(Boolean).at(-1) ??
        "unavailable";
    }
  }
  return "unavailable";
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function formatDate(value: Date | undefined): string {
  return value?.toISOString() ?? "unavailable";
}
