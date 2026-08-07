import type {
  PluginDiagnostic,
  SourceMatch,
} from "@browser2ide/plugin-api";
import type { ResolutionStatus } from "@browser2ide/protocol";

export interface ResolvedSourceMatch extends SourceMatch {
  readonly pluginId: string;
}

export interface ResolvedPluginDiagnostic extends PluginDiagnostic {
  readonly pluginId: string;
}

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
