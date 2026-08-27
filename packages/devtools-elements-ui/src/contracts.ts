export interface InspectorAttributeSnapshot {
  readonly name: string;
  readonly value: string;
}

export type InspectorNodeKind =
  | "document-type"
  | "element"
  | "text"
  | "comment"
  | "shadow-root"
  | "frame-document";

export type InspectorNodeRelationship =
  | "dom"
  | "shadow-root"
  | "frame-document";

export interface InspectorNodeSnapshot {
  readonly nodeRef: string;
  readonly kind: InspectorNodeKind;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly attributes: readonly InspectorAttributeSnapshot[];
  readonly childCount: number;
  readonly relationship: InspectorNodeRelationship;
  readonly selectable: boolean;
  readonly expandable: boolean;
  readonly inaccessible?: boolean;
  readonly branchRevision: number;
}

export interface TreeRowSnapshot {
  readonly type: "node" | "load-more";
  readonly nodeRef: string;
  readonly parentRef?: string;
  /** Zero-based visual depth within the neutral Elements tree. */
  readonly depth: number;
  readonly expanded: boolean;
  readonly expandable: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
  readonly node?: InspectorNodeSnapshot;
}

export interface TreePresentationSnapshot {
  readonly rows: readonly TreeRowSnapshot[];
}

export interface TreeDataSource {
  snapshot(): TreePresentationSnapshot;
  subscribe(listener: () => void): () => void;
  expand(nodeRef: string): Promise<void>;
  collapse(nodeRef: string): void;
  loadMore(parentRef: string): Promise<void>;
  select(nodeRef: string): Promise<void>;
  focus(nodeRef: string): void;
  hover(nodeRef?: string): void;
}

/**
 * Owns every resource installed by a tree renderer factory. The inspector
 * calls dispose at most once, including when later constructor work fails.
 */
export interface ElementsTreeRendererHost {
  dispose(): void;
}

/**
 * Mounts a tree renderer into the supplied inspector-owned DOM pane.
 * Implementations own the mounted content and must be failure-atomic if they
 * throw before returning a host.
 */
export type CreateElementsTreeRenderer = (
  document: Document,
  mount: HTMLElement,
  treeDataSource: TreeDataSource,
) => ElementsTreeRendererHost;

export type DeclarationState =
  | "winning-known-author"
  | "overridden-known-author"
  | "inactive"
  | "unknown";

export interface MatchedDeclarationSnapshot {
  readonly declarationRef: string;
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly state: DeclarationState;
  readonly stateReason?: string;
}

export type RuleContextKind =
  | "media"
  | "supports"
  | "layer"
  | "scope"
  | "container"
  | "starting-style"
  | "unknown";

export interface RuleContextSnapshot {
  readonly kind: RuleContextKind;
  readonly text: string;
}

/**
 * Display-only public-web source provenance. The label is a URL basename;
 * generated positions are 1-based when present.
 */
export interface GeneratedRuleSourceSnapshot {
  readonly label: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

export interface MatchedRuleSnapshot {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly declarations: readonly MatchedDeclarationSnapshot[];
  readonly contexts: readonly RuleContextSnapshot[];
  readonly generatedSource?: GeneratedRuleSourceSnapshot;
}

export interface InheritedRulesSnapshot {
  readonly nodeRef: string;
  readonly inlineStyle?: MatchedRuleSnapshot;
  readonly matchedRules: readonly MatchedRuleSnapshot[];
}

export type RulesDiagnosticSeverity = "info" | "warning" | "error";

export interface RulesDiagnosticSnapshot {
  readonly code: string;
  readonly severity: RulesDiagnosticSeverity;
  readonly message: string;
}

export interface MatchedStylesSnapshot {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly pseudoStateRevision: number;
  readonly pseudoStates: readonly ("hover" | "focus")[];
  readonly nodeRef: string;
  readonly inlineStyle?: MatchedRuleSnapshot;
  readonly matchedRules: readonly MatchedRuleSnapshot[];
  readonly inherited: readonly InheritedRulesSnapshot[];
  readonly unsupportedRuleCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly approximateRuleCount: number;
  readonly omittedRuleCount: number;
  readonly diagnostics: readonly RulesDiagnosticSnapshot[];
}

export type RulesPresentationState =
  | "empty"
  | "loading"
  | "ready"
  | "partial"
  | "error";

export type RulesPresentationSnapshot =
  | { readonly state: "empty" }
  | { readonly state: "loading" }
  | {
    readonly state: "ready";
    readonly matchedStyles: MatchedStylesSnapshot;
  }
  | {
    readonly state: "partial";
    readonly matchedStyles: MatchedStylesSnapshot;
  }
  | {
    readonly state: "error";
    readonly message: string;
    readonly diagnostics: readonly RulesDiagnosticSnapshot[];
  };

export interface RulesDataSource {
  snapshot(): RulesPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  filter(query: string): void;
}

/**
 * Owns the concrete Rules presentation mounted by the inspector. Implementors
 * may use Chromium DevTools widgets, but receive only Pin-op's read-only
 * presentation snapshots and delegates.
 */
export interface ElementsRulesRendererHost {
  readonly element: HTMLElement;
  render(snapshot: MatchedStylesSnapshot): void;
  clear(): void;
  dispose(): void;
}

export type CreateElementsRulesRenderer = (
  document: Document,
  dataSource: RulesDataSource,
  sourceLinkDelegate?: SourceLinkDelegate,
  pseudoStateDataSource?: PseudoStateDataSource,
) => ElementsRulesRendererHost;

export type PseudoState = "hover" | "focus";

export type PseudoStatePresentationState =
  | "ready"
  | "loading"
  | "partial"
  | "error"
  | "unavailable";

export type PseudoStateDisabledReason =
  | "no-selection"
  | "recovery"
  | "disconnected"
  | "mismatch";

/**
 * Browser-local, display-only state for the bounded author-style preview.
 * Implementations must return an immutable snapshot and atomically replace the
 * complete state set in setStates().
 */
export interface PseudoStateSnapshot {
  readonly state: PseudoStatePresentationState;
  readonly states: readonly PseudoState[];
  readonly unsupportedRuleCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly approximateRuleCount: number;
  readonly reason?: PseudoStateDisabledReason;
  readonly message?: string;
}

export interface PseudoStateDataSource {
  snapshot(): PseudoStateSnapshot;
  subscribe(listener: () => void): () => void;
  setStates(states: readonly PseudoState[]): Promise<void>;
}

export type RuleOriginConfidence = "exact" | "sourcemap";

export type RuleOriginState = "pending" | "stale" | "incompatible";

/**
 * Sanitized IDE-owned source provenance for one Rules row. The label is a
 * basename and positions are 1-based; no workspace path or open authority is
 * exposed to the renderer.
 */
export interface RuleOriginDecoration {
  readonly label: string;
  readonly languageId: "css" | "scss";
  readonly startLine: number;
  readonly startColumn: number;
  readonly confidence: RuleOriginConfidence;
  readonly clickable: boolean;
  readonly state?: RuleOriginState;
}

export interface SourceLinkDelegate {
  originFor(ruleRef: string): RuleOriginDecoration | undefined;
  openRuleOrigin(ruleRef: string): void;
}

export interface ElementsInspectorHost {
  readonly element: HTMLElement;
  readonly domRoot: HTMLElement;
  readonly rulesRoot: HTMLElement;
  readonly sidebarExtensionMount: HTMLElement;
  bindRulesDataSource(
    dataSource: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
    pseudoStateDataSource?: PseudoStateDataSource,
  ): void;
  dispose(): void;
}

export type CreateElementsInspectorView = (
  document: Document,
  mount: HTMLElement,
  treeDataSource: TreeDataSource,
) => ElementsInspectorHost;
