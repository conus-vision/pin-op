import type {
  PluginDiagnostic,
  SourceMatch,
  SourcePluginResult,
} from "@pin-op/plugin-api";
import type { ResolutionStatus } from "@pin-op/protocol";

export interface ResolvedSourceMatch extends SourceMatch {
  readonly pluginId: string;
}

export interface ResolvedPluginDiagnostic extends PluginDiagnostic {
  readonly pluginId: string;
}

export type ActiveDocumentSourceKind =
  | "active-document"
  | "not-found"
  | "other-document"
  | "ambiguous";

export interface CssDeclarationEvidence {
  readonly property: string;
  readonly value: string;
  readonly important?: boolean;
  readonly valueComplete?: boolean;
}

export interface NormalizedDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

export interface RuleFingerprint {
  readonly selector: string | undefined;
  readonly declarations: readonly NormalizedDeclaration[];
  readonly conditions: readonly string[];
}

export interface StatusAwareSourcePluginResult extends SourcePluginResult {
  readonly status: ResolutionStatus;
}

interface SourceMapResolutionBase {
  readonly diagnostics: readonly PluginDiagnostic[];
}

export type SourceMapResolution =
  | SourceMapResolutionBase & {
      readonly kind: "mapped";
      readonly mapUri: string;
      readonly sourceUrl: string;
      readonly line: number;
      readonly column: number;
    }
  | SourceMapResolutionBase & {
      readonly kind: "missing";
    }
  | SourceMapResolutionBase & {
      readonly kind: "invalid";
      readonly diagnosticCode: "resolver.source-read-failed";
    }
  | SourceMapResolutionBase & {
      readonly kind: "unmapped";
      readonly mapUri: string;
    };

export interface SourceResolution {
  readonly selectionMessageId: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}

export interface PluginResolutionCandidate {
  readonly pluginId: string;
  readonly status: ResolutionStatus;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}

export type SourcePluginDispatch =
  | {
      readonly kind: "resolved";
      readonly resolution: SourceResolution;
      readonly candidates: readonly PluginResolutionCandidate[];
    }
  | {
      readonly kind: "unsupported-document";
      readonly documentUri: string;
      readonly documentVersion: number;
    };
