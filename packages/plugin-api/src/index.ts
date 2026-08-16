import type {
  InspectContext,
  InspectTarget,
  JsonObject,
} from "@pin-op/protocol";

export const SOURCE_PLUGIN_API_VERSION = 1 as const;

export interface Disposable {
  dispose(): void;
}

export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface SourceDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): SourcePosition;
  offsetAt(position: SourcePosition): number;
}

export type SourceResolutionStrategy = "workspace-bound" | "automatic";

export interface SourceUriResolution {
  readonly uris: readonly string[];
  readonly status: "exact" | "unique-basename" | "not-found" | "ambiguous";
  readonly strategy: SourceResolutionStrategy;
  readonly workspaceFolderUri?: string;
}

export interface SourceWorkspace {
  findFiles(pattern: string): Promise<readonly string[]>;
  readText(uri: string): Promise<string>;
  resolveSourceUri(
    sourceUrl: string,
    baseUrl: string,
  ): Promise<SourceUriResolution>;
  resolveRelativeUri(baseUri: string, reference: string): string;
  isWorkspaceUri(uri: string): boolean;
}

export interface SelectionSnapshot {
  readonly sessionId: string;
  readonly messageId: string;
  readonly targets: readonly InspectTarget[];
  readonly context: InspectContext;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DocumentSelector {
  readonly languageId: string;
  readonly scheme?: string;
}

export type SourceConfidence =
  | "exact"
  | "sourcemap"
  | "instrumented"
  | "heuristic"
  | "unknown";

export interface SourceMatch {
  readonly targetRole: "selected" | "parent";
  readonly range: SourceRange;
  readonly label: string;
  readonly kind: string;
  readonly relation: string;
  readonly confidence: SourceConfidence;
  readonly metadata?: JsonObject;
}

export interface PluginDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata?: JsonObject;
}

export interface SourcePluginContext {
  readonly selection: SelectionSnapshot;
  readonly document: SourceDocument;
  readonly workspace: SourceWorkspace;
  readonly signal: AbortSignal;
}

export interface SourcePluginResult {
  readonly matches: readonly SourceMatch[];
  readonly diagnostics?: readonly PluginDiagnostic[];
}

export interface SourcePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly apiVersion: typeof SOURCE_PLUGIN_API_VERSION;
  readonly documentSelectors: readonly DocumentSelector[];
  readonly supportedFactKinds: readonly string[];
  resolve(context: SourcePluginContext): Promise<SourcePluginResult>;
}

export interface PinOpApi {
  readonly apiVersion: typeof SOURCE_PLUGIN_API_VERSION;
  registerSourcePlugin(plugin: SourcePlugin): Disposable;
}
