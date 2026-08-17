import type { SourcePosition, SourceRange } from "@pin-op/plugin-api";
import type { SourceNavigateMessage } from "@pin-op/protocol";
import type { SourceNavigationStateSender } from "../bridgeClient.js";
import type { ResolvedSourceMatch } from "../sourcePlugins/types.js";
import type { DisposableLike } from "./decorations.js";

export interface SourceNavigationEditor {
  readonly documentUri: string;
}

export interface SourceNavigationHost {
  getActiveEditor(): SourceNavigationEditor | undefined;
  getPrimaryCursor(editor: SourceNavigationEditor): SourcePosition;
  setPrimaryCursor(
    editor: SourceNavigationEditor,
    position: SourcePosition,
  ): void;
  revealRange(editor: SourceNavigationEditor, range: SourceRange): void;
  onDidChangeActiveEditor(listener: () => void): DisposableLike;
  onDidChangePrimaryCursor(listener: () => void): DisposableLike;
}

export interface SourceNavigationResolution {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly documentUri?: string;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly includedMatches?: readonly SourceNavigationIncludedMatch[];
}

export interface SourceNavigationIncludedMatch {
  readonly matchId: string;
  readonly targetRole: ResolvedSourceMatch["targetRole"];
  readonly range: SourceRange;
}

export function replacePrimarySelection<T>(
  selections: readonly T[],
  primary: T,
): readonly T[] {
  return [primary, ...selections.slice(1)];
}

interface PreferredNavigationTarget {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly documentUri: string;
  readonly index: number;
  readonly range: SourceRange;
}

export class SourceNavigator implements DisposableLike {
  private readonly subscriptions: readonly DisposableLike[];
  private inspectMessageId: string | undefined;
  private resolutionGeneration = 0;
  private documentUri: string | undefined;
  private ranges: readonly SourceRange[] = [];
  private matches: readonly ResolvedSourceMatch[] = [];
  private includedMatches: readonly SourceNavigationIncludedMatch[] = [];
  private preferredTarget: PreferredNavigationTarget | undefined;
  private disposed = false;

  public constructor(
    private readonly host: SourceNavigationHost,
    private readonly stateSender: SourceNavigationStateSender,
  ) {
    this.subscriptions = [
      host.onDidChangeActiveEditor(() => this.invalidate()),
      host.onDidChangePrimaryCursor(() => this.publishState()),
    ];
  }

  public update(resolution: SourceNavigationResolution): void {
    if (this.disposed) return;
    this.preferredTarget = undefined;
    this.inspectMessageId = resolution.inspectMessageId;
    this.resolutionGeneration = resolution.resolutionGeneration;
    this.documentUri = resolution.documentUri;
    this.matches = resolution.documentUri ? resolution.matches : [];
    this.ranges = resolution.documentUri
      ? selectedRanges(resolution.documentUri, resolution.matches)
      : [];
    this.includedMatches = resolution.documentUri
      ? currentIncludedMatches(
          resolution.matches,
          resolution.includedMatches ?? [],
        )
      : [];
    this.publishState();
  }

  public setIncludedMatches(
    includedMatches: readonly SourceNavigationIncludedMatch[],
    publish = false,
  ): void {
    if (this.disposed) return;
    this.includedMatches = currentIncludedMatches(
      this.matches,
      includedMatches,
    );
    if (publish) this.publishState();
  }

  public navigate(message: SourceNavigateMessage): void {
    if (
      this.disposed ||
      message.inspectMessageId !== this.inspectMessageId ||
      message.resolutionGeneration !== this.resolutionGeneration ||
      !this.documentUri ||
      this.ranges.length === 0
    ) {
      return;
    }

    const editor = this.host.getActiveEditor();
    if (!editor || editor.documentUri !== this.documentUri) {
      this.preferredTarget = undefined;
      return;
    }

    const cursor = this.host.getPrimaryCursor(editor);
    const activeIndex = this.activeRangeIndex(editor, cursor);
    const targetIndex = activeIndex === undefined
      ? outsideTargetIndex(this.ranges, cursor, message.direction)
      : adjacentIndex(activeIndex, this.ranges.length, message.direction);
    const target = this.ranges[targetIndex];
    if (!target) return;

    this.preferredTarget = {
      inspectMessageId: this.inspectMessageId,
      resolutionGeneration: this.resolutionGeneration,
      documentUri: this.documentUri,
      index: targetIndex,
      range: target,
    };
    try {
      this.host.setPrimaryCursor(editor, target.start);
    } catch (error) {
      this.preferredTarget = undefined;
      throw error;
    }
    this.host.revealRange(editor, target);
    this.publishState();
  }

  public beginInspect(inspectMessageId: string): void {
    if (this.disposed) return;
    this.preferredTarget = undefined;
    this.inspectMessageId = inspectMessageId;
    this.resolutionGeneration = 0;
    this.documentUri = undefined;
    this.ranges = [];
    this.matches = [];
    this.includedMatches = [];
    this.publishState();
  }

  public invalidate(): void {
    if (this.disposed) return;
    this.preferredTarget = undefined;
    this.documentUri = undefined;
    this.ranges = [];
    this.matches = [];
    this.includedMatches = [];
    this.publishState();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preferredTarget = undefined;
    this.matches = [];
    this.includedMatches = [];
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private publishState(): void {
    if (this.disposed || this.inspectMessageId === undefined) return;

    const editor = this.host.getActiveEditor();
    const matchesActiveDocument =
      editor !== undefined &&
      this.documentUri !== undefined &&
      editor.documentUri === this.documentUri;
    const selectedMatchCount = matchesActiveDocument ? this.ranges.length : 0;
    const activeMatchIndex = matchesActiveDocument
      ? this.activeRangeIndex(editor, this.host.getPrimaryCursor(editor))
      : undefined;
    const activeMatchId = matchesActiveDocument
      ? containingIncludedMatchId(
          this.includedMatches,
          this.host.getPrimaryCursor(editor),
        )
      : undefined;
    if (!matchesActiveDocument) this.preferredTarget = undefined;

    this.stateSender.sendSourceNavigationState({
      inspectMessageId: this.inspectMessageId,
      resolutionGeneration: this.resolutionGeneration,
      selectedMatchCount,
      ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
      ...(activeMatchId === undefined ? {} : { activeMatchId }),
    });
  }

  private activeRangeIndex(
    editor: SourceNavigationEditor,
    cursor: SourcePosition,
  ): number | undefined {
    const preferred = this.preferredTarget;
    if (preferred) {
      const currentRange = this.ranges[preferred.index];
      if (
        preferred.inspectMessageId === this.inspectMessageId &&
        preferred.resolutionGeneration === this.resolutionGeneration &&
        preferred.documentUri === this.documentUri &&
        preferred.documentUri === editor.documentUri &&
        samePosition(cursor, preferred.range.start) &&
        currentRange !== undefined &&
        sameRange(currentRange, preferred.range)
      ) {
        return preferred.index;
      }
      this.preferredTarget = undefined;
    }
    return containingRangeIndex(this.ranges, cursor);
  }
}

function currentIncludedMatches(
  matches: readonly ResolvedSourceMatch[],
  included: readonly SourceNavigationIncludedMatch[],
): readonly SourceNavigationIncludedMatch[] {
  const currentRanges = new Set(matches.map((match) => JSON.stringify([
    match.targetRole,
    rangeKey("", match.range),
  ])));
  const seenIds = new Set<string>();
  return included.filter((entry) => {
    if (seenIds.has(entry.matchId)) return false;
    const current = currentRanges.has(JSON.stringify([
      entry.targetRole,
      rangeKey("", entry.range),
    ]));
    if (current) seenIds.add(entry.matchId);
    return current;
  });
}

function containingIncludedMatchId(
  matches: readonly SourceNavigationIncludedMatch[],
  cursor: SourcePosition,
): string | undefined {
  return matches.find((match) => contains(match.range, cursor))?.matchId;
}

function selectedRanges(
  documentUri: string,
  matches: readonly ResolvedSourceMatch[],
): readonly SourceRange[] {
  const unique = new Map<string, SourceRange>();
  for (const match of matches) {
    if (match.targetRole !== "selected") continue;
    const key = rangeKey(documentUri, match.range);
    if (!unique.has(key)) unique.set(key, match.range);
  }
  return [...unique.values()].sort(compareRanges);
}

function containingRangeIndex(
  ranges: readonly SourceRange[],
  cursor: SourcePosition,
): number | undefined {
  const index = ranges.findIndex(
    (range) => contains(range, cursor),
  );
  return index < 0 ? undefined : index;
}

function contains(range: SourceRange, cursor: SourcePosition): boolean {
  return comparePositions(range.start, cursor) <= 0 &&
    comparePositions(cursor, range.end) < 0;
}

function outsideTargetIndex(
  ranges: readonly SourceRange[],
  cursor: SourcePosition,
  direction: SourceNavigateMessage["direction"],
): number {
  if (direction === "next") {
    const next = ranges.findIndex(
      (range) => comparePositions(range.start, cursor) > 0,
    );
    return next < 0 ? 0 : next;
  }

  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range && comparePositions(range.end, cursor) <= 0) return index;
  }
  return ranges.length - 1;
}

function adjacentIndex(
  activeIndex: number,
  rangeCount: number,
  direction: SourceNavigateMessage["direction"],
): number {
  return direction === "next"
    ? (activeIndex + 1) % rangeCount
    : (activeIndex - 1 + rangeCount) % rangeCount;
}

function compareRanges(left: SourceRange, right: SourceRange): number {
  return comparePositions(left.start, right.start) ||
    comparePositions(left.end, right.end);
}

function comparePositions(left: SourcePosition, right: SourcePosition): number {
  return left.line - right.line || left.character - right.character;
}

function sameRange(left: SourceRange, right: SourceRange): boolean {
  return samePosition(left.start, right.start) &&
    samePosition(left.end, right.end);
}

function samePosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function rangeKey(documentUri: string, range: SourceRange): string {
  return JSON.stringify([
    documentUri,
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ]);
}
