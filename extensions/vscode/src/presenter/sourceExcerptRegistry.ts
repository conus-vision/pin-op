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
import {
  normalizeLanguageId,
  normalizeSourceDisplayLabel,
  normalizeSourceKind,
  normalizeSourceRelation,
  sourceDocumentLabel,
} from "../sourcePresentationMetadata.js";
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

const MATCH_ID_GENERATION_ATTEMPTS = 16;
const MAX_ESCAPED_OPAQUE_ID = "\u0000".repeat(
  RESOLUTION_LIMITS.opaqueIdLength,
);

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
    try {
      this.current = sourceState(
        input.inspectMessageId,
        input.resolutionGeneration,
        document,
      );
    } catch {
      this.current = Object.freeze({
        inspectMessageId: input.inspectMessageId,
        resolutionGeneration: input.resolutionGeneration,
        document: unknownDocument(),
      });
      return this.emptyPublication();
    }

    let valid: ValidMatch[];
    try {
      if (!matchesActiveDocument(input)) return this.emptyPublication();
      valid = validMatches(input.resolution.matches, document);
    } catch {
      return this.emptyPublication();
    }
    if (valid.length === 0) return this.emptyPublication();

    let text: string;
    try {
      text = document.getText();
    } catch {
      return this.emptyPublication(true);
    }

    let unique: ValidMatch[];
    try {
      unique = deduplicateAndOrder(valid);
    } catch {
      return this.emptyPublication(false, valid.length);
    }
    const matchIds = new Set<string>();
    const candidates: PublicationCandidate[] = [];
    try {
      for (const entry of unique.slice(0, SOURCE_PRESENTATION_LIMITS.matches)) {
        const matchId = this.allocateMatchId(matchIds);
        if (!matchId) return this.emptyPublication(false, unique.length);
        candidates.push(this.createCandidate(input, entry, text, matchId));
      }
    } catch {
      return this.emptyPublication(false, unique.length);
    }
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

    return frozenPublication(
      this.message(
        included.map((candidate) => candidate.excerpt),
        omittedMatchCount,
      ),
      included.map(
        (candidate) => candidate.navigationMatch,
      ),
      false,
    );
  }

  public invalidate(
    invalidation?: SourceExcerptInvalidation,
  ): SourceMatchesInput | undefined {
    this.authorities.clear();
    if (invalidation) {
      let document = unknownDocument();
      if (invalidation.editor) {
        try {
          document = publicDocument(invalidation.editor.document);
        } catch {
          // Keep the unknown public document and invalidate all authority.
        }
      }
      this.current = Object.freeze({
        inspectMessageId: invalidation.inspectMessageId,
        resolutionGeneration: invalidation.resolutionGeneration,
        document,
      });
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
    return frozenAuthority(authority);
  }

  private createCandidate(
    input: SourceExcerptPublicationInput,
    entry: ValidMatch,
    documentText: string,
    matchId: string,
  ): PublicationCandidate {
    const completeText = documentText.slice(entry.startOffset, entry.endOffset);
    const bounded = boundedExcerpt(completeText);
    const authorityRange = frozenRange(entry.match.range);
    const authority = frozenAuthority({
      matchId,
      inspectMessageId: input.inspectMessageId,
      resolutionGeneration: input.resolutionGeneration,
      documentUri: input.editor.document.uri.toString(),
      documentVersion: input.editor.document.version,
      range: authorityRange,
    });
    const kind = normalizeSourceKind(entry.match.kind);
    const relation = normalizeSourceRelation(entry.match.relation);
    return {
      excerpt: frozenExcerpt({
        matchId,
        targetRole: entry.match.targetRole,
        label: normalizeSourceDisplayLabel(
          entry.match.label,
          this.current?.document.label ?? "untitled",
          {
            kind,
            relation,
            trustedStyleSelector:
              entry.match.labelProvenance === "builtin-style-selector",
          },
        ),
        kind,
        relation,
        confidence: entry.match.confidence,
        startLine: authorityRange.start.line + 1,
        endLine: authorityRange.end.line + 1,
        text: bounded.text,
        truncated: bounded.truncated,
      }),
      authority,
      navigationMatch: frozenNavigationMatch({
        matchId,
        targetRole: entry.match.targetRole,
        range: entry.match.range,
      }),
    };
  }

  private allocateMatchId(used: Set<string>): string | undefined {
    for (
      let attempt = 0;
      attempt < MATCH_ID_GENERATION_ATTEMPTS;
      attempt += 1
    ) {
      let candidate: unknown;
      try {
        candidate = this.createMatchId();
      } catch {
        continue;
      }
      if (!validOpaqueId(candidate) || used.has(candidate)) continue;
      used.add(candidate);
      return candidate;
    }
    return undefined;
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

  private emptyPublication(
    excerptReadFailed = false,
    omittedMatchCount = 0,
  ): SourceExcerptPublication {
    return frozenPublication(
      this.message([], omittedMatchCount),
      [],
      excerptReadFailed,
    );
  }

  private message(
    matches: SourceMatchesInput["matches"],
    omittedMatchCount: number,
  ): SourceMatchesInput {
    const current = this.current;
    if (!current) throw new Error("Source excerpt state is not initialized");
    return frozenSourceMatches({
      inspectMessageId: current.inspectMessageId,
      resolutionGeneration: current.resolutionGeneration,
      document: current.document,
      matches,
      omittedMatchCount,
    });
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
  return Object.freeze({
    inspectMessageId,
    resolutionGeneration,
    document: publicDocument(document),
  });
}

function publicDocument(
  document: TextDocumentLike,
): SourceMatchesInput["document"] {
  return frozenDocument({
    label: sourceDocumentLabel(document.uri.toString()),
    languageId: normalizeLanguageId(document.languageId),
  });
}

function unknownDocument(): SourceMatchesInput["document"] {
  return frozenDocument({ label: "untitled", languageId: "unknown" });
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
    left.match.pluginId.localeCompare(right.match.pluginId);
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

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= RESOLUTION_LIMITS.opaqueIdLength;
}

function frozenPublication(
  message: SourceMatchesInput,
  navigationMatches: readonly SourceExcerptNavigationMatch[],
  excerptReadFailed: boolean,
): SourceExcerptPublication {
  return Object.freeze({
    message,
    navigationMatches: Object.freeze(
      navigationMatches.map(frozenNavigationMatch),
    ),
    excerptReadFailed,
  });
}

function frozenSourceMatches(message: SourceMatchesInput): SourceMatchesInput {
  return Object.freeze({
    inspectMessageId: message.inspectMessageId,
    resolutionGeneration: message.resolutionGeneration,
    document: frozenDocument(message.document),
    matches: Object.freeze(message.matches.map(frozenExcerpt)),
    omittedMatchCount: message.omittedMatchCount,
  });
}

function frozenDocument(
  document: SourceMatchesInput["document"],
): SourceMatchesInput["document"] {
  return Object.freeze({
    label: document.label,
    languageId: document.languageId,
  });
}

function frozenExcerpt(
  excerpt: SourceMatchesInput["matches"][number],
): SourceMatchesInput["matches"][number] {
  return Object.freeze({ ...excerpt });
}

function frozenNavigationMatch(
  match: SourceExcerptNavigationMatch,
): SourceExcerptNavigationMatch {
  return Object.freeze({
    matchId: match.matchId,
    targetRole: match.targetRole,
    range: frozenRange(match.range),
  });
}

function frozenAuthority(authority: SourceAuthority): SourceAuthority {
  return Object.freeze({
    matchId: authority.matchId,
    inspectMessageId: authority.inspectMessageId,
    resolutionGeneration: authority.resolutionGeneration,
    documentUri: authority.documentUri,
    documentVersion: authority.documentVersion,
    range: frozenRange(authority.range),
  });
}

function frozenRange(range: SourceRange): SourceRange {
  return Object.freeze({
    start: frozenPosition(range.start),
    end: frozenPosition(range.end),
  });
}

function frozenPosition(position: SourcePosition): SourcePosition {
  return Object.freeze({
    line: position.line,
    character: position.character,
  });
}

function conservativeEnvelopeBytes(message: SourceMatchesInput): number {
  return Buffer.byteLength(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: MAX_ESCAPED_OPAQUE_ID,
    sessionId: MAX_ESCAPED_OPAQUE_ID,
    source: { role: "ide", id: MAX_ESCAPED_OPAQUE_ID },
    ...message,
    metadata: {},
  }), "utf8");
}
