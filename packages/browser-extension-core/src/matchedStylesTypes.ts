import type { CssRuleContextRecord } from "./cssRuleWalker.js";

export type MatchedDeclarationState =
  | "winning-known-author"
  | "overridden-known-author"
  | "inactive"
  | "unknown";

export type MatchedDeclarationReason =
  | "highest-precedence-known-author-declaration"
  | "lower-precedence-author-declaration"
  | "inactive-group-condition"
  | "unsupported-cascade-layer"
  | "unsupported-cascade-scope"
  | "unsupported-container-query"
  | "unsupported-starting-style"
  | "unsupported-group-context"
  | "unknown-group-applicability"
  | "custom-property-cascade"
  | "variable-dependent-value"
  | "animation-or-transition-cascade"
  | "unsupported-shorthand"
  | "inherited-author-declaration"
  | "unsupported-selector-specificity";

export interface MatchedDeclaration {
  readonly ruleRef: string;
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueTruncated: boolean;
  readonly state: MatchedDeclarationState;
  readonly reason: MatchedDeclarationReason;
}

export interface GeneratedMatchedRuleSource {
  readonly sourceUrl?: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly rulePath: string;
}

export interface MatchedRule {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly declarations: readonly MatchedDeclaration[];
  readonly contexts: readonly CssRuleContextRecord[];
  readonly contextsTruncated?: boolean;
  readonly mediaTruncated?: boolean;
  readonly source?: GeneratedMatchedRuleSource;
}

export interface InheritedMatchedRules {
  readonly ancestorIndex: number;
  readonly elementName: string;
  readonly rules: readonly MatchedRule[];
}

export interface MatchedStyles {
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly nodeRef: string;
  readonly inline?: MatchedRule;
  readonly rules: readonly MatchedRule[];
  readonly inherited: readonly InheritedMatchedRules[];
  readonly inaccessibleStylesheetCount: number;
  readonly partial: boolean;
  readonly diagnostics: readonly string[];
}
