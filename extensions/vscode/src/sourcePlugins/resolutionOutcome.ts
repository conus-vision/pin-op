import {
  RESOLUTION_LIMITS,
  type ResolutionDiagnosticCode,
  type ResolutionMessage,
  type ResolutionStatus,
} from "@pin-op/protocol";
import type {
  PluginResolutionCandidate,
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
} from "./types.js";

export interface PresenterDocument {
  readonly label: string;
  readonly languageId: string;
}

export interface PresenterOutcome {
  readonly status: ResolutionStatus;
  readonly document?: PresenterDocument;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly selectedMatchCount: number;
  readonly parentMatchCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly diagnosticCodes: readonly ResolutionDiagnosticCode[];
  readonly localDiagnostics: readonly ResolvedPluginDiagnostic[];
}

export interface ResolutionReductionOptions {
  readonly document?: PresenterDocument;
  readonly matches?: readonly ResolvedSourceMatch[];
  readonly inaccessibleStylesheetCount?: number;
  readonly localDiagnostics?: readonly ResolvedPluginDiagnostic[];
  readonly rejectedMatchCount?: number;
  readonly fallbackStatus?: ResolutionStatus;
}

export type ProtocolResolution = Pick<
  ResolutionMessage,
  | "document"
  | "status"
  | "selectedMatchCount"
  | "parentMatchCount"
  | "inaccessibleStylesheetCount"
  | "diagnosticCodes"
>;

const FAILURE_PRECEDENCE: readonly ResolutionStatus[] = [
  "no-active-editor",
  "unsupported-document",
  "no-facts",
  "source-ambiguous",
  "source-not-active-document",
  "source-not-found",
  "source-map-invalid",
  "source-map-missing",
  "rule-match-ambiguous",
  "no-rule-match",
  "error",
];

export function reduceResolutionOutcome(
  candidates: readonly PluginResolutionCandidate[],
  options: ResolutionReductionOptions = {},
): PresenterOutcome {
  const matches = options.matches ?? candidates.flatMap((entry) => entry.matches);
  const selectedMatchCount = countRole(matches, "selected");
  const parentMatchCount = countRole(matches, "parent");
  const localDiagnostics = options.localDiagnostics ??
    candidates.flatMap((entry) => entry.diagnostics);
  const status = matches.length > 0
    ? "matched"
    : firstFailure(candidates, options.fallbackStatus ?? "no-rule-match");
  const diagnosticCodes = stableDiagnosticCodes(
    localDiagnostics,
    options.rejectedMatchCount ?? 0,
  );

  return {
    status,
    ...(options.document === undefined
      ? {}
      : { document: boundedDocument(options.document) }),
    matches,
    selectedMatchCount: boundedCount(selectedMatchCount),
    parentMatchCount: boundedCount(parentMatchCount),
    inaccessibleStylesheetCount: boundedCount(
      options.inaccessibleStylesheetCount ?? 0,
    ),
    diagnosticCodes: status === "error" && diagnosticCodes.length === 0
      ? ["resolver.plugin-error"]
      : diagnosticCodes,
    localDiagnostics,
  };
}

export function toProtocolResolution(
  outcome: PresenterOutcome,
): ProtocolResolution {
  return {
    ...(outcome.document === undefined
      ? {}
      : { document: boundedDocument(outcome.document) }),
    status: outcome.status,
    selectedMatchCount: outcome.status === "matched"
      ? boundedCount(outcome.selectedMatchCount)
      : 0,
    parentMatchCount: outcome.status === "matched"
      ? boundedCount(outcome.parentMatchCount)
      : 0,
    inaccessibleStylesheetCount: boundedCount(
      outcome.inaccessibleStylesheetCount,
    ),
    diagnosticCodes: [...new Set(outcome.diagnosticCodes)]
      .slice(0, RESOLUTION_LIMITS.diagnosticCodes),
  };
}

export function boundedDocument(document: PresenterDocument): PresenterDocument {
  return {
    label: boundedText(document.label, RESOLUTION_LIMITS.labelLength, "unknown"),
    languageId: boundedText(
      document.languageId,
      RESOLUTION_LIMITS.languageIdLength,
      "unknown",
    ),
  };
}

function firstFailure(
  candidates: readonly PluginResolutionCandidate[],
  fallback: ResolutionStatus,
): ResolutionStatus {
  const statuses = new Set(candidates.map((entry) => entry.status));
  return FAILURE_PRECEDENCE.find((status) => statuses.has(status)) ?? fallback;
}

function countRole(
  matches: readonly ResolvedSourceMatch[],
  role: ResolvedSourceMatch["targetRole"],
): number {
  return matches.filter((match) => match.targetRole === role).length;
}

function stableDiagnosticCodes(
  diagnostics: readonly ResolvedPluginDiagnostic[],
  rejectedMatchCount: number,
): readonly ResolutionDiagnosticCode[] {
  const codes: ResolutionDiagnosticCode[] = [];
  if (rejectedMatchCount > 0) codes.push("resolver.invalid-result");
  for (const diagnostic of diagnostics) {
    const code = protocolDiagnosticCode(diagnostic);
    if (code && !codes.includes(code)) codes.push(code);
    if (codes.length >= RESOLUTION_LIMITS.diagnosticCodes) break;
  }
  return codes;
}

function protocolDiagnosticCode(
  diagnostic: ResolvedPluginDiagnostic,
): ResolutionDiagnosticCode | undefined {
  const { code } = diagnostic;
  if (code === "plugin.timeout") return "resolver.plugin-timeout";
  if (code === "plugin.exception") return "resolver.plugin-error";
  if (code === "plugin.invalidResult" || code === "plugin.invalidRange") {
    return "resolver.invalid-result";
  }
  if (/readFailed|parseFailed/i.test(code)) {
    return "resolver.source-read-failed";
  }
  if (diagnostic.severity === "error") return "resolver.plugin-error";
  return undefined;
}

function boundedText(value: string, limit: number, fallback: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (clean || fallback).slice(0, limit);
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), RESOLUTION_LIMITS.count);
}
