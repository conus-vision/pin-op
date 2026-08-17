import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { SourcePosition, SourceRange } from "@pin-op/plugin-api";
import {
  PROTOCOL_VERSION,
  RESOLUTION_LIMITS,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
  type SourceOpenMessage,
} from "@pin-op/protocol";
import type { SourceMatchesInput } from "../bridgeClient.js";
import type { TextDocumentLike } from "../sourcePlugins/sourceDocument.js";
import type {
  ResolvedSourceMatch,
  SourceResolution,
} from "../sourcePlugins/types.js";

export interface SourceAuthority {
  readonly matchId: string;
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly range: SourceRange;
}

export interface SourceExcerptEditor {
  readonly document: TextDocumentLike;
}

export interface SourceExcerptNavigationMatch {
  readonly matchId: string;
  readonly targetRole: ResolvedSourceMatch["targetRole"];
  readonly range: SourceRange;
}

export interface SourceExcerptPublication {
  readonly message: SourceMatchesInput;
  readonly navigationMatches: readonly SourceExcerptNavigationMatch[];
  readonly excerptReadFailed: boolean;
}

export interface SourceExcerptPublicationInput {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly editor: SourceExcerptEditor;
  readonly resolution: SourceResolution;
}

export interface SourceExcerptInvalidation {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly editor?: SourceExcerptEditor;
}

export interface SourceExcerptRegistryOptions {
  readonly createMatchId?: () => string;
  readonly measureEnvelopeBytes?: (message: SourceMatchesInput) => number;
}

interface CurrentSourceState {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly document: SourceMatchesInput["document"];
}

interface ValidMatch {
  readonly match: ResolvedSourceMatch;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface PublicationCandidate {
  readonly excerpt: SourceMatchesInput["matches"][number];
  readonly authority: SourceAuthority;
  readonly navigationMatch: SourceExcerptNavigationMatch;
}

const CONFIDENCE_PRIORITY: Record<ResolvedSourceMatch["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

const MAX_OPAQUE_ID = "x".repeat(RESOLUTION_LIMITS.opaqueIdLength);

export class SourceExcerptRegistry {
  private readonly createMatchId: () => string;
  private readonly measureEnvelopeBytes: (message: SourceMatchesInput) => number;
  private readonly authorities = new Map<string, SourceAuthority>();
  private current: CurrentSourceState | undefined;

  public constructor(options: SourceExcerptRegistryOptions) {
    this.createMatchId = options.createMatchId ?? randomUUID;
    this.measureEnvelopeBytes = options.measureEnvelopeBytes ??
      conservativeEnvelopeBytes;
  }

  public publish(input: SourceExcerptPublicationInput): SourceExcerptPublication {
    const { document } = input.editor;
    this.authorities.clear();
    this.current = sourceState(
      input.inspectMessageId,
      input.resolutionGeneration,
      document,
    );

    if (!matchesActiveDocument(input)) return this.emptyPublication();

    const valid = validMatches(input.resolution.matches, document);
    if (valid.length === 0) return this.emptyPublication();

    let text: string;
    try {
      text = document.getText();
    } catch {
      return this.emptyPublication(true);
    }

    const unique = deduplicateAndOrder(valid);
    const candidates = unique
      .slice(0, SOURCE_PRESENTATION_LIMITS.matches)
      .map((entry) => this.createCandidate(input, entry, text));
    let included = candidates;
    let omittedMatchCount = unique.length - included.length;

    while (
      included.length > 0 &&
      !this.fitsEnvelope(included, omittedMatchCount)
    ) {
      included = included.slice(0, -1);
      omittedMatchCount += 1;
    }

    if (!this.fitsEnvelope(included, omittedMatchCount)) {
      omittedMatchCount = unique.length;
      included = [];
    }

    for (const candidate of included) {
      this.authorities.set(candidate.authority.matchId, candidate.authority);
    }

    return {
      message: this.message(
        included.map((candidate) => candidate.excerpt),
        omittedMatchCount,
      ),
      navigationMatches: included.map(
        (candidate) => candidate.navigationMatch,
      ),
      excerptReadFailed: false,
    };
  }

  public invalidate(
    invalidation?: SourceExcerptInvalidation,
  ): SourceMatchesInput | undefined {
    this.authorities.clear();
    if (invalidation) {
      this.current = {
        inspectMessageId: invalidation.inspectMessageId,
        resolutionGeneration: invalidation.resolutionGeneration,
        document: invalidation.editor
          ? publicDocument(invalidation.editor.document)
          : unknownDocument(),
      };
    }
    return this.current ? this.message([], 0) : undefined;
  }

  public resolveOpen(
    message: SourceOpenMessage,
    activeDocument: TextDocumentLike,
  ): SourceAuthority | undefined {
    const current = this.current;
    if (
      !current ||
      message.inspectMessageId !== current.inspectMessageId ||
      message.resolutionGeneration !== current.resolutionGeneration
    ) {
      return undefined;
    }

    const authority = this.authorities.get(message.matchId);
    if (
      !authority ||
      authority.inspectMessageId !== message.inspectMessageId ||
      authority.resolutionGeneration !== message.resolutionGeneration ||
      authority.documentUri !== activeDocument.uri.toString() ||
      authority.documentVersion !== activeDocument.version
    ) {
      return undefined;
    }
    return authority;
  }

  private createCandidate(
    input: SourceExcerptPublicationInput,
    entry: ValidMatch,
    documentText: string,
  ): PublicationCandidate {
    const matchId = this.createMatchId();
    const completeText = documentText.slice(entry.startOffset, entry.endOffset);
    const bounded = boundedExcerpt(completeText);
    const range = copyRange(entry.match.range);
    const authority: SourceAuthority = {
      matchId,
      inspectMessageId: input.inspectMessageId,
      resolutionGeneration: input.resolutionGeneration,
      documentUri: input.editor.document.uri.toString(),
      documentVersion: input.editor.document.version,
      range,
    };
    return {
      excerpt: {
        matchId,
        targetRole: entry.match.targetRole,
        label: boundedField(entry.match.label, RESOLUTION_LIMITS.labelLength),
        kind: boundedField(entry.match.kind, RESOLUTION_LIMITS.labelLength),
        relation: boundedField(
          entry.match.relation,
          RESOLUTION_LIMITS.labelLength,
        ),
        confidence: entry.match.confidence,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        text: bounded.text,
        truncated: bounded.truncated,
      },
      authority,
      navigationMatch: {
        matchId,
        targetRole: entry.match.targetRole,
        range,
      },
    };
  }

  private fitsEnvelope(
    candidates: readonly PublicationCandidate[],
    omittedMatchCount: number,
  ): boolean {
    try {
      const bytes = this.measureEnvelopeBytes(this.message(
        candidates.map((candidate) => candidate.excerpt),
        omittedMatchCount,
      ));
      return Number.isFinite(bytes) &&
        bytes <= SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES;
    } catch {
      return false;
    }
  }

  private emptyPublication(excerptReadFailed = false): SourceExcerptPublication {
    return {
      message: this.message([], 0),
      navigationMatches: [],
      excerptReadFailed,
    };
  }

  private message(
    matches: SourceMatchesInput["matches"],
    omittedMatchCount: number,
  ): SourceMatchesInput {
    const current = this.current;
    if (!current) throw new Error("Source excerpt state is not initialized");
    return {
      inspectMessageId: current.inspectMessageId,
      resolutionGeneration: current.resolutionGeneration,
      document: current.document,
      matches,
      omittedMatchCount,
    };
  }
}

function matchesActiveDocument(input: SourceExcerptPublicationInput): boolean {
  const document = input.editor.document;
  return input.resolution.selectionMessageId === input.inspectMessageId &&
    input.resolution.documentUri === document.uri.toString() &&
    input.resolution.documentVersion === document.version;
}

function sourceState(
  inspectMessageId: string,
  resolutionGeneration: number,
  document: TextDocumentLike,
): CurrentSourceState {
  return {
    inspectMessageId,
    resolutionGeneration,
    document: publicDocument(document),
  };
}

function publicDocument(
  document: TextDocumentLike,
): SourceMatchesInput["document"] {
  return {
    label: boundedField(
      documentLabel(document.uri.toString()),
      RESOLUTION_LIMITS.labelLength,
      "untitled",
    ),
    languageId: boundedField(
      document.languageId,
      RESOLUTION_LIMITS.languageIdLength,
      "unknown",
    ),
  };
}

function unknownDocument(): SourceMatchesInput["document"] {
  return { label: "untitled", languageId: "unknown" };
}

function documentLabel(documentUri: string): string {
  try {
    const parsed = new URL(documentUri);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (segment) {
      try {
        return basename(decodeURIComponent(segment));
      } catch {
        return basename(segment);
      }
    }
  } catch {
    const segment = documentUri.split(/[\\/]/).filter(Boolean).at(-1);
    if (segment) return segment;
  }
  return "untitled";
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "untitled";
}

function validMatches(
  matches: readonly ResolvedSourceMatch[],
  document: TextDocumentLike,
): ValidMatch[] {
  const valid: ValidMatch[] = [];
  for (const match of matches) {
    const offsets = validOffsets(match.range, document);
    if (offsets) valid.push({ match, ...offsets });
  }
  return valid;
}

function validOffsets(
  range: SourceRange,
  document: TextDocumentLike,
): { readonly startOffset: number; readonly endOffset: number } | undefined {
  if (!validPosition(range.start) || !validPosition(range.end)) return undefined;
  try {
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      startOffset >= endOffset ||
      !samePosition(document.positionAt(startOffset), range.start) ||
      !samePosition(document.positionAt(endOffset), range.end)
    ) {
      return undefined;
    }
    return { startOffset, endOffset };
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

function deduplicateAndOrder(matches: readonly ValidMatch[]): ValidMatch[] {
  const ordered = [...matches].sort(compareValidMatches);
  const unique = new Map<string, ValidMatch>();
  for (const entry of ordered) {
    const key = rangeKey(entry.match.range);
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function compareValidMatches(left: ValidMatch, right: ValidMatch): number {
  return rolePriority(left.match) - rolePriority(right.match) ||
    compareRanges(left.match.range, right.match.range) ||
    CONFIDENCE_PRIORITY[left.match.confidence] -
      CONFIDENCE_PRIORITY[right.match.confidence] ||
    left.match.pluginId.localeCompare(right.match.pluginId) ||
    left.match.label.localeCompare(right.match.label) ||
    left.match.kind.localeCompare(right.match.kind) ||
    left.match.relation.localeCompare(right.match.relation);
}

function rolePriority(match: ResolvedSourceMatch): number {
  return match.targetRole === "selected" ? 0 : 1;
}

function compareRanges(left: SourceRange, right: SourceRange): number {
  return comparePositions(left.start, right.start) ||
    comparePositions(left.end, right.end);
}

function comparePositions(left: SourcePosition, right: SourcePosition): number {
  return left.line - right.line || left.character - right.character;
}

function samePosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function copyRange(range: SourceRange): SourceRange {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function rangeKey(range: SourceRange): string {
  return JSON.stringify([
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ]);
}

function boundedExcerpt(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const lineBounded = boundLogicalLines(text, SOURCE_PRESENTATION_LIMITS.textLines);
  const byteBounded = boundUtf8(
    lineBounded.text,
    SOURCE_PRESENTATION_LIMITS.textBytes,
  );
  return {
    text: byteBounded.text,
    truncated: lineBounded.truncated || byteBounded.truncated,
  };
}

function boundLogicalLines(
  text: string,
  maximumLines: number,
): { readonly text: string; readonly truncated: boolean } {
  const endings = /\r\n|\r|\n/g;
  let lineCount = 1;
  for (let match = endings.exec(text); match; match = endings.exec(text)) {
    lineCount += 1;
    if (lineCount > maximumLines) {
      return { text: text.slice(0, match.index), truncated: true };
    }
  }
  return { text, truncated: false };
}

function boundUtf8(
  text: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  let bytes = 0;
  const scalars: string[] = [];
  for (const scalar of text) {
    const safeScalar = scalar.length === 1 && isSurrogate(scalar.charCodeAt(0))
      ? "\ufffd"
      : scalar;
    const scalarBytes = Buffer.byteLength(safeScalar, "utf8");
    if (bytes + scalarBytes > maximumBytes) {
      return { text: scalars.join(""), truncated: true };
    }
    bytes += scalarBytes;
    scalars.push(safeScalar);
  }
  return { text: scalars.join(""), truncated: false };
}

function isSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff;
}

function boundedField(value: string, limit: number, fallback = "unknown"): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  let bounded = clean.slice(0, limit);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded || fallback;
}

function conservativeEnvelopeBytes(message: SourceMatchesInput): number {
  return Buffer.byteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: MAX_OPAQUE_ID,
    sessionId: MAX_OPAQUE_ID,
    source: { role: "ide", id: MAX_OPAQUE_ID },
    ...message,
    metadata: {},
  }), "utf8");
}
