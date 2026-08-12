import type { SelectionSnapshot } from "@pinop/plugin-api";
import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type RuntimeFact,
} from "@pinop/protocol";
import { declarationEvidenceFromFact } from "./declarationFingerprint.js";
import type { CssDeclarationEvidence } from "./types.js";

export interface TargetCssFact {
  readonly targetRole: "selected" | "parent";
  readonly fact: CssRuleFact;
  readonly sourceUrl: string;
  readonly declarations: readonly CssDeclarationEvidence[];
}

export function targetCssFacts(
  selection: SelectionSnapshot,
): TargetCssFact[] {
  const unique = new Map<string, {
    readonly targetRole: TargetCssFact["targetRole"];
    readonly fact: CssRuleFact;
    readonly sourceUrl: string;
    readonly declarations: CssDeclarationEvidence[];
    readonly declarationKeys: Set<string>;
  }>();
  let unstableFactIndex = 0;
  for (const target of selection.targets) {
    for (const fact of target.facts) {
      if (!isCssRuleFact(fact)) continue;
      const sourceUrl = cssFactSourceUrl(fact);
      if (!sourceUrl) continue;
      const stableIdentity = stableCssRuleIdentity(fact);
      const key = JSON.stringify([
        target.role,
        sourceUrl,
        fact.selector,
        stableIdentity ?? `unstable:${unstableFactIndex++}`,
        fact.metadata.media ?? null,
        fact.metadata.mediaTruncated ?? null,
      ]);
      let entry = unique.get(key);
      if (!entry) {
        entry = {
          targetRole: target.role,
          fact,
          sourceUrl,
          declarations: [],
          declarationKeys: new Set(),
        };
        unique.set(key, entry);
      }
      const declaration = declarationEvidenceFromFact(fact);
      if (!declaration) continue;
      const declarationKey = JSON.stringify(declaration);
      if (!entry.declarationKeys.has(declarationKey)) {
        entry.declarationKeys.add(declarationKey);
        entry.declarations.push(declaration);
      }
    }
  }
  return [...unique.values()].map((entry) => ({
    targetRole: entry.targetRole,
    fact: entry.fact,
    sourceUrl: entry.sourceUrl,
    declarations: entry.declarations,
  }));
}

export function stableCssRuleIdentity(
  fact: CssRuleFact,
): string | undefined {
  if (fact.source !== undefined) {
    return validSourcePosition(fact.source.line, fact.source.column) &&
        typeof fact.source.uri === "string" &&
        fact.source.uri.length > 0 &&
        fact.source.uri.length <= INSPECT_LIMITS.urlLength
      ? JSON.stringify([
        "source",
        fact.source.uri,
        fact.source.line,
        fact.source.column,
      ])
      : undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(fact.metadata, "rulePath")) {
    return undefined;
  }
  const path = parseBrowserRulePath(fact.metadata.rulePath);
  return path === undefined
    ? undefined
    : JSON.stringify(["rule-path", fact.metadata.rulePath]);
}

export function parseBrowserRulePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > INSPECT_LIMITS.selectorLength
  ) {
    return undefined;
  }
  const segments = value.split(".");
  if (
    segments.length < 2 ||
    segments.length > INSPECT_LIMITS.cssRuleDepth + 2
  ) {
    return undefined;
  }
  for (const [index, segment] of segments.entries()) {
    if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
    const numeric = Number(segment);
    const upperBound = index === 0
      ? INSPECT_LIMITS.stylesheets
      : INSPECT_LIMITS.cssRules;
    if (!Number.isSafeInteger(numeric) || numeric >= upperBound) {
      return undefined;
    }
  }
  return segments.slice(1).join(".");
}

function validSourcePosition(line: number, column: number): boolean {
  return Number.isSafeInteger(line) &&
    Number.isSafeInteger(column) &&
    line >= 1 &&
    column >= 1;
}

function isCssRuleFact(fact: RuntimeFact): fact is CssRuleFact {
  return fact.type === "css-rule" &&
    "selector" in fact &&
    "property" in fact &&
    "value" in fact;
}

export function cssFactSourceUrl(fact: CssRuleFact): string | undefined {
  for (const candidate of [
    fact.metadata.sourceUrl,
    fact.metadata.stylesheet,
    fact.source?.uri,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
