import type { SourceDocument, SourcePosition } from "@browser2ide/plugin-api";
import type { ResolvedSourceMatch } from "../sourcePlugins/types.js";

export interface VisibleMatchResult {
  readonly matches: readonly ResolvedSourceMatch[];
  readonly selectedMatchCount: number;
  readonly parentMatchCount: number;
  readonly rejectedMatchCount: number;
}

const CONFIDENCE_PRIORITY: Record<ResolvedSourceMatch["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

export function visibleMatches(
  matches: readonly ResolvedSourceMatch[],
  document: SourceDocument,
): VisibleMatchResult {
  const valid: ResolvedSourceMatch[] = [];
  let rejectedMatchCount = 0;

  for (const match of matches) {
    const range = normalizeRange(match, document);
    if (!range) {
      rejectedMatchCount += 1;
      continue;
    }
    valid.push({ ...match, range });
  }

  const unique = new Map<string, ResolvedSourceMatch>();
  for (const match of valid) {
    const key = rangeKey(document.uri, match);
    const current = unique.get(key);
    if (!current || compareChoice(match, current) < 0) {
      unique.set(key, match);
    }
  }

  const visible = [...unique.values()].sort(compareByRange);
  return {
    matches: visible,
    selectedMatchCount: visible.filter((match) => match.targetRole === "selected")
      .length,
    parentMatchCount: visible.filter((match) => match.targetRole === "parent")
      .length,
    rejectedMatchCount,
  };
}

function normalizeRange(
  match: ResolvedSourceMatch,
  document: SourceDocument,
): ResolvedSourceMatch["range"] | undefined {
  const { start, end } = match.range;
  if (!validPosition(start) || !validPosition(end)) return undefined;

  try {
    const startOffset = document.offsetAt(start);
    const endOffset = document.offsetAt(end);
    if (startOffset >= endOffset) return undefined;

    const normalizedStart = document.positionAt(startOffset);
    const normalizedEnd = document.positionAt(endOffset);
    if (!samePosition(normalizedStart, start) || !samePosition(normalizedEnd, end)) {
      return undefined;
    }
    return {
      start: { ...normalizedStart },
      end: { ...normalizedEnd },
    };
  } catch {
    return undefined;
  }
}

function validPosition(position: SourcePosition): boolean {
  return Number.isInteger(position.line) &&
    Number.isInteger(position.character) &&
    position.line >= 0 &&
    position.character >= 0;
}

function samePosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function rangeKey(documentUri: string, match: ResolvedSourceMatch): string {
  return JSON.stringify([
    documentUri,
    match.range.start.line,
    match.range.start.character,
    match.range.end.line,
    match.range.end.character,
  ]);
}

function compareChoice(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return rolePriority(left) - rolePriority(right) ||
    CONFIDENCE_PRIORITY[left.confidence] -
      CONFIDENCE_PRIORITY[right.confidence] ||
    left.pluginId.localeCompare(right.pluginId) ||
    left.kind.localeCompare(right.kind) ||
    left.relation.localeCompare(right.relation);
}

function rolePriority(match: ResolvedSourceMatch): number {
  return match.targetRole === "selected" ? 0 : 1;
}

function compareByRange(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character ||
    compareChoice(left, right);
}
