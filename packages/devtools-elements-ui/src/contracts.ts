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

export interface SourceLinkDelegate {
  openRuleOrigin(ruleRef: string): void;
}
