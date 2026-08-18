import {
  ResolutionMessageSchema,
  SourceMatchesMessageSchema,
  SourceNavigationStateMessageSchema,
  type ResolutionMessage,
  type SourceDocument,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { parseProtocolData } from "./protocolDataSnapshot.js";
import type { PanelSourceOpenCommand } from "./inspectPortProtocol.js";

export type { PanelSourceOpenCommand } from "./inspectPortProtocol.js";

export type SourcePaneDispatch = (message: PanelSourceOpenCommand) => void;

export type SourceMatchesAcceptance =
  | "rejected"
  | "invalidated"
  | "published";

export interface SourcePaneGroup {
  readonly label: "Selected" | "Parent";
  readonly collapsed: boolean;
  readonly matches: readonly SourceExcerpt[];
}

export interface SourcePaneViewModel {
  readonly document?: SourceDocument;
  readonly groups: {
    readonly selected: SourcePaneGroup;
    readonly parent: SourcePaneGroup;
  };
  readonly activeMatchId?: string;
  readonly omittedMatchCount: number;
}

interface ResolutionAuthority {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly document?: SourceDocument;
}

const emptySelectedGroup: SourcePaneGroup = Object.freeze({
  label: "Selected",
  collapsed: false,
  matches: Object.freeze([]),
});
const emptyParentGroup: SourcePaneGroup = Object.freeze({
  label: "Parent",
  collapsed: true,
  matches: Object.freeze([]),
});
const emptyModel: SourcePaneViewModel = Object.freeze({
  groups: Object.freeze({
    selected: emptySelectedGroup,
    parent: emptyParentGroup,
  }),
  omittedMatchCount: 0,
});

export class SourcePaneController {
  private readonly listeners = new Set<() => void>();
  private compatible = false;
  private inspectMessageId: string | undefined;
  private authority: ResolutionAuthority | undefined;
  private publishedMatchIds = new Set<string>();
  private current = emptyModel;

  public constructor(private readonly dispatch: SourcePaneDispatch) {}

  public setCompatible(compatible: boolean): void {
    if (!compatible) {
      this.compatible = false;
      this.reset();
      return;
    }
    this.compatible = true;
  }

  public beginInspect(inspectMessageId: string): boolean {
    this.reset();
    if (!this.compatible || !isOpaqueId(inspectMessageId)) {
      return false;
    }
    this.inspectMessageId = inspectMessageId;
    return true;
  }

  public acceptResolution(message: unknown): boolean {
    const parsed = parseProtocolData(message, ResolutionMessageSchema);
    if (
      !parsed ||
      !this.compatible ||
      parsed.inspectMessageId !== this.inspectMessageId ||
      (this.authority !== undefined &&
        parsed.resolutionGeneration <= this.authority.resolutionGeneration)
    ) {
      return false;
    }

    this.authority = Object.freeze({
      inspectMessageId: parsed.inspectMessageId,
      resolutionGeneration: parsed.resolutionGeneration,
      sessionId: parsed.sessionId,
      sourceId: parsed.source.id,
      ...(parsed.document ? { document: freezeDocument(parsed.document) } : {}),
    });
    this.clearMatches();
    return true;
  }

  public acceptMatches(message: unknown): SourceMatchesAcceptance {
    const parsed = parseProtocolData(message, SourceMatchesMessageSchema);
    if (
      !parsed ||
      !this.compatible ||
      parsed.inspectMessageId !== this.inspectMessageId
    ) {
      return "rejected";
    }

    if (parsed.matches.length === 0 && !this.authority) {
      this.clearMatches();
      return "invalidated";
    }

    if (!this.authority || !matchesAuthority(parsed, this.authority)) {
      return "rejected";
    }

    const matchIds = new Set<string>();
    for (const match of parsed.matches) {
      if (matchIds.has(match.matchId)) {
        return "rejected";
      }
      matchIds.add(match.matchId);
    }

    const selected: SourceExcerpt[] = [];
    const parent: SourceExcerpt[] = [];
    for (const match of parsed.matches) {
      const frozen = freezeExcerpt(match);
      (match.targetRole === "selected" ? selected : parent).push(frozen);
    }
    this.publishedMatchIds = matchIds;
    this.update(Object.freeze({
      document: freezeDocument(parsed.document),
      groups: Object.freeze({
        selected: Object.freeze({
          label: "Selected",
          collapsed: false,
          matches: Object.freeze(selected),
        }),
        parent: Object.freeze({
          label: "Parent",
          collapsed: true,
          matches: Object.freeze(parent),
        }),
      }),
      omittedMatchCount: parsed.omittedMatchCount,
    }));
    return "published";
  }

  public acceptNavigationState(message: unknown): boolean {
    const parsed = parseProtocolData(
      message,
      SourceNavigationStateMessageSchema,
    );
    if (
      !parsed ||
      !this.authority ||
      parsed.inspectMessageId !== this.inspectMessageId ||
      parsed.inspectMessageId !== this.authority.inspectMessageId ||
      parsed.resolutionGeneration !== this.authority.resolutionGeneration ||
      parsed.sessionId !== this.authority.sessionId ||
      parsed.source.id !== this.authority.sourceId ||
      (parsed.activeMatchId !== undefined &&
        !this.publishedMatchIds.has(parsed.activeMatchId))
    ) {
      return false;
    }

    this.update(Object.freeze({
      ...this.current,
      ...(parsed.activeMatchId === undefined
        ? { activeMatchId: undefined }
        : { activeMatchId: parsed.activeMatchId }),
    }));
    return true;
  }

  public open(matchId: string): boolean {
    if (
      !this.compatible ||
      !this.inspectMessageId ||
      !this.authority ||
      !isOpaqueId(matchId) ||
      !this.publishedMatchIds.has(matchId)
    ) {
      return false;
    }
    this.dispatch(Object.freeze({
      type: "pin-op.source.open",
      inspectMessageId: this.inspectMessageId,
      resolutionGeneration: this.authority.resolutionGeneration,
      matchId,
    }));
    return true;
  }

  public invalidate(): void {
    this.reset();
  }

  public disconnect(): void {
    this.compatible = false;
    this.reset();
  }

  public beginBinding(): void {
    this.compatible = false;
    this.reset();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public snapshot(): SourcePaneViewModel {
    return this.current;
  }

  private clearMatches(): void {
    this.publishedMatchIds = new Set();
    this.update(emptyModel);
  }

  private reset(): void {
    this.inspectMessageId = undefined;
    this.authority = undefined;
    this.clearMatches();
  }

  private update(model: SourcePaneViewModel): void {
    this.current = model;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failed view must not prevent other panel surfaces from updating.
      }
    }
  }
}

function matchesAuthority(
  message: SourceMatchesMessage,
  authority: ResolutionAuthority,
): boolean {
  return message.inspectMessageId === authority.inspectMessageId &&
    message.resolutionGeneration === authority.resolutionGeneration &&
    message.sessionId === authority.sessionId &&
    message.source.id === authority.sourceId &&
    authority.document !== undefined &&
    sameDocument(message.document, authority.document);
}

function sameDocument(left: SourceDocument, right: SourceDocument): boolean {
  return left.label === right.label && left.languageId === right.languageId;
}

function freezeDocument(document: SourceDocument): SourceDocument {
  return Object.freeze({
    label: document.label,
    languageId: document.languageId,
  });
}

function freezeExcerpt(excerpt: SourceExcerpt): SourceExcerpt {
  return Object.freeze({
    matchId: excerpt.matchId,
    targetRole: excerpt.targetRole,
    label: excerpt.label,
    kind: excerpt.kind,
    relation: excerpt.relation,
    confidence: excerpt.confidence,
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    text: excerpt.text,
    truncated: excerpt.truncated,
  });
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
