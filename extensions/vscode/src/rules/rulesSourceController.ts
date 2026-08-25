import { createHash } from "node:crypto";
import type { SourceDocument, SourcePosition, SourceRange } from
  "@pin-op/plugin-api";
import {
  RESOLUTION_LIMITS,
  RULES_SOURCES_LIMITS,
  type InspectMessage,
  type RulesOpenMessage,
} from "@pin-op/protocol";
import { RULES_SOURCE_MAP_MAX_BYTES } from
  "../sourcePlugins/sourceMapLoader.js";
import { RULES_STYLESHEET_MAX_BYTES } from
  "../sourcePlugins/stylesheetAst.js";
import {
  canonicalRulesSourceUri,
  type RulesSourceSnapshotWorkspace,
} from "../sourcePlugins/sourceWorkspace.js";
import {
  RulesOpenAuthorityRegistry,
  type StoredRuleOpenAuthority,
} from "./rulesOpenAuthorityRegistry.js";
import {
  RulesSourcesPublication,
  type PreparedRulesSourcesPublication,
  type RulesSourcesPublicationPayload,
} from "./rulesSourcesPublication.js";
import type {
  RulesSourceResolutionBatch,
  RulesSourceResolver,
  RulesSourceResolverRequest,
} from "./rulesSourceResolver.js";

const MAX_RETAINED_DEPENDENCIES = RULES_SOURCES_LIMITS.sources * 3;

export type RulesSourceFailureCode =
  | "rules-source-resolution-failed"
  | "rules-sources-send-failed"
  | "rules-source-open-rejected"
  | "rules-source-open-stale"
  | "rules-source-open-failed";

export interface RulesSourceEditorLike {
  readonly documentUri: string;
  readonly document: {
    readonly uri: string | { toString(): string };
    readonly version: number;
  };
}

export interface RulesSourceControllerHost<
  Document extends SourceDocument = SourceDocument,
  Editor extends RulesSourceEditorLike = RulesSourceEditorLike,
> {
  openTextDocument(uri: string): PromiseLike<Document>;
  showTextDocument(document: Document): PromiseLike<Editor>;
  setPrimaryCursor(editor: Editor, position: SourcePosition): void;
  revealRange(editor: Editor, range: SourceRange): void;
  reportFailure(code: RulesSourceFailureCode): void;
}

export interface RulesSourceResolverLike {
  resolve(
    request: RulesSourceResolverRequest,
  ): Promise<RulesSourceResolutionBatch>;
}

export interface RulesSourceControllerOptions<
  Document extends SourceDocument,
  Editor extends RulesSourceEditorLike,
> {
  readonly workspace: RulesSourceSnapshotWorkspace;
  readonly resolver: Pick<RulesSourceResolver, "resolve"> | RulesSourceResolverLike;
  readonly registry: RulesOpenAuthorityRegistry;
  readonly publication: RulesSourcesPublication;
  readonly sendRulesSources: (
    payload: RulesSourcesPublicationPayload,
  ) => boolean;
  readonly host: RulesSourceControllerHost<Document, Editor>;
}

export class RulesSourceController<
  Document extends SourceDocument = SourceDocument,
  Editor extends RulesSourceEditorLike = RulesSourceEditorLike,
> {
  private readonly workspace: RulesSourceSnapshotWorkspace;
  private readonly resolver: RulesSourceResolverLike;
  private readonly registry: RulesOpenAuthorityRegistry;
  private readonly publication: RulesSourcesPublication;
  private readonly sendRulesSources: (
    payload: RulesSourcesPublicationPayload,
  ) => boolean;
  private readonly host: RulesSourceControllerHost<Document, Editor>;
  private currentInspect: InspectMessage | undefined;
  private resolutionAbort: AbortController | undefined;
  private operation = 0;
  private openOperation = 0;
  private rulesGeneration = 0;
  private locallyAcceptedInspectMessageId: string | undefined;
  private readonly retainedDependencyUris = new Set<string>();
  private watchAllRulesCandidates = false;
  private disposed = false;

  public constructor(options: RulesSourceControllerOptions<Document, Editor>) {
    this.workspace = options.workspace;
    this.resolver = options.resolver;
    this.registry = options.registry;
    this.publication = options.publication;
    this.sendRulesSources = options.sendRulesSources;
    this.host = options.host;
  }

  public acceptInspect(message: InspectMessage): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.openOperation += 1;
    if (this.currentInspect?.messageId !== message.messageId) {
      this.rulesGeneration = 0;
      this.locallyAcceptedInspectMessageId = undefined;
      this.clearRetainedDependencies();
    }
    this.currentInspect = message;
    return this.resolveCurrent(true);
  }

  public republish(): Promise<void> {
    return this.resolveCurrent(false);
  }

  public async open(message: RulesOpenMessage): Promise<void> {
    if (this.disposed) return;
    const openOperation = ++this.openOperation;
    const inspect = this.currentInspect;
    if (!inspect || inspect.messageId !== message.inspectMessageId) {
      this.invalidateWithoutPublication();
      return;
    }
    const currentGeneration = this.registry.current();
    if (
      !currentGeneration ||
      currentGeneration.inspectMessageId !== message.inspectMessageId ||
      currentGeneration.rulesGeneration !== message.rulesGeneration
    ) {
      this.report("rules-source-open-rejected");
      this.invalidateWithoutPublication();
      return;
    }
    const authority = this.registry.authorize(message);
    if (!authority) {
      this.report("rules-source-open-rejected");
      await this.replaceIfCurrent(message.inspectMessageId, message.rulesGeneration);
      return;
    }
    if (!this.workspace.isWorkspaceUri(authority.documentUri)) {
      await this.failOpen(authority, "rules-source-open-stale");
      return;
    }

    let opened: Document;
    try {
      opened = await this.host.openTextDocument(authority.documentUri);
    } catch {
      if (!this.isOpenCurrent(openOperation)) return;
      await this.failOpen(authority, "rules-source-open-failed");
      return;
    }
    if (!this.isOpenCurrent(openOperation)) return;
    const beforeShow = await this.revalidate(
      authority,
      message,
      opened,
      () => this.isOpenCurrent(openOperation),
    );
    if (!this.isOpenCurrent(openOperation) || beforeShow === "superseded") return;
    if (beforeShow === "stale") {
      await this.failOpen(authority, "rules-source-open-stale");
      return;
    }

    let editor: Editor;
    try {
      editor = await this.host.showTextDocument(opened);
    } catch {
      if (!this.isOpenCurrent(openOperation)) return;
      await this.failOpen(authority, "rules-source-open-failed");
      return;
    }
    if (!this.isOpenCurrent(openOperation)) return;
    const afterShow = await this.revalidate(
      authority,
      message,
      opened,
      () => this.isOpenCurrent(openOperation),
    );
    if (!this.isOpenCurrent(openOperation) || afterShow === "superseded") return;
    if (afterShow === "stale" || !sameEditorDocument(editor, authority)) {
      await this.failOpen(authority, "rules-source-open-stale");
      return;
    }

    try {
      if (!this.isOpenCurrent(openOperation)) return;
      this.host.setPrimaryCursor(editor, authority.range.start);
      if (!this.isOpenCurrent(openOperation)) return;
      this.host.revealRange(editor, authority.range);
    } catch {
      if (!this.isOpenCurrent(openOperation)) return;
      await this.failOpen(authority, "rules-source-open-failed");
    }
  }

  public async dependencyChanged(uri: string): Promise<boolean> {
    if (!this.isDependencyRelevant(uri)) return false;
    this.openOperation += 1;
    await this.resolveCurrent(true);
    return true;
  }

  public workspaceChanged(): Promise<void> {
    this.openOperation += 1;
    return this.resolveCurrent(true);
  }

  public stylesheetRefresh(): Promise<void> {
    this.openOperation += 1;
    return this.resolveCurrent(true);
  }

  public pageRefresh(): Promise<void> {
    this.openOperation += 1;
    return this.resolveCurrent(true);
  }

  public documentNavigated(): void {
    this.invalidateWithoutPublication();
  }

  public disconnect(): void {
    this.invalidateWithoutPublication();
  }

  public clear(): void {
    this.invalidateWithoutPublication();
  }

  public dependencyUris(): readonly string[] {
    return Object.freeze([...this.retainedDependencyUris]);
  }

  public isResolutionInFlight(): boolean {
    return this.resolutionAbort !== undefined;
  }

  public isDependencyRelevant(uri: string): boolean {
    const canonical = canonicalUri(uri);
    if (this.retainedDependencyUris.has(canonical)) return true;
    if (!this.watchAllRulesCandidates && !this.isResolutionInFlight()) {
      return false;
    }
    try {
      return this.workspace.isWorkspaceUri(canonical) &&
        isRulesDependencyCandidate(canonical);
    } catch {
      return false;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateWithoutPublication();
  }

  private async resolveCurrent(clearRegistry: boolean): Promise<void> {
    if (this.disposed || !this.currentInspect) return;
    if (this.rulesGeneration >= RESOLUTION_LIMITS.generation) {
      this.report("rules-source-resolution-failed");
      this.invalidateWithoutPublication();
      return;
    }
    this.resolutionAbort?.abort();
    if (clearRegistry) this.registry.clear();
    const abort = new AbortController();
    this.resolutionAbort = abort;
    const operation = ++this.operation;
    const inspect = this.currentInspect;
    const rulesGeneration = this.rulesGeneration + 1;
    try {
      let resolution: RulesSourceResolutionBatch;
      try {
        resolution = await this.resolver.resolve({
          selectionMessageId: inspect.messageId,
          pageUrl: inspect.context.url,
          ruleEvidence: inspect.ruleEvidence,
          signal: abort.signal,
          isCurrent: () => this.isResolutionCurrent(
            operation,
            inspect.messageId,
            abort,
          ),
        });
      } catch {
        if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) return;
        this.report("rules-source-resolution-failed");
        resolution = unresolvedResolution(inspect);
      }
      if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) return;

      let workspaceGeneration: number;
      try {
        workspaceGeneration = readWorkspaceGeneration(this.workspace);
      } catch {
        this.report("rules-source-resolution-failed");
        workspaceGeneration = 0;
        resolution = unresolvedResolution(inspect);
      }
      this.rulesGeneration = rulesGeneration;
      let prepared;
      try {
        prepared = this.publication.prepare({
          inspectMessageId: inspect.messageId,
          rulesGeneration,
          ruleEvidence: inspect.ruleEvidence,
          resolution,
          workspaceGeneration,
        });
      } catch {
        this.report("rules-source-resolution-failed");
        if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) return;
        if (this.locallyAcceptedInspectMessageId !== inspect.messageId) {
          this.invalidateWithoutPublication();
        }
        return;
      }
      if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) {
        prepared.rollback();
        return;
      }

      let activated = false;
      try {
        prepared.activate();
        activated = true;
        const sent = this.sendRulesSources(prepared.payload);
        if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) {
          this.settleSupersededPublication(prepared, sent, inspect.messageId);
          return;
        }
        if (!sent) {
          throw new Error("Rules sources frame was not accepted locally");
        }
        prepared.commit();
        this.locallyAcceptedInspectMessageId = inspect.messageId;
        this.retainCurrentDependencies();
      } catch {
        if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) {
          if (activated) {
            this.settleSupersededPublication(
              prepared,
              false,
              inspect.messageId,
            );
          }
          return;
        }
        if (activated) {
          try {
            prepared.rollback();
          } catch {
            this.registry.clear();
          }
        }
        this.report("rules-sources-send-failed");
        if (!this.isResolutionCurrent(operation, inspect.messageId, abort)) return;
        if (
          this.locallyAcceptedInspectMessageId !== inspect.messageId &&
          !this.registry.current()
        ) {
          this.invalidateWithoutPublication();
        }
      }
    } finally {
      if (this.resolutionAbort === abort) this.resolutionAbort = undefined;
    }
  }

  private isResolutionCurrent(
    operation: number,
    inspectMessageId: string,
    abort: AbortController,
  ): boolean {
    return !this.disposed && !abort.signal.aborted &&
      operation === this.operation &&
      this.currentInspect?.messageId === inspectMessageId;
  }

  private async revalidate(
    authority: StoredRuleOpenAuthority,
    message: RulesOpenMessage,
    opened: Document,
    isOpenCurrent: () => boolean,
  ): Promise<"valid" | "stale" | "superseded"> {
    if (!isOpenCurrent()) return "superseded";
    let valid = true;
    let generationBefore = -1;
    try {
      generationBefore = readWorkspaceGeneration(this.workspace);
    } catch {
      valid = false;
    }
    for (const dependency of authority.dependencies) {
      if (!this.workspace.isWorkspaceUri(dependency.uri)) valid = false;
      try {
        const snapshot = await this.workspace.readRulesSourceSnapshot(
          dependency.uri,
          dependency.kind === "external-source-map"
            ? RULES_SOURCE_MAP_MAX_BYTES
            : RULES_STYLESHEET_MAX_BYTES,
        );
        if (!isOpenCurrent()) return "superseded";
        const contentHash = createHash("sha256").update(snapshot.text)
          .digest("hex");
        if (
          canonicalUri(snapshot.uri) !== canonicalUri(dependency.uri) ||
          contentHash !== dependency.contentHash ||
          (dependency.documentVersion !== undefined &&
            snapshot.documentVersion !== dependency.documentVersion)
        ) {
          valid = false;
        }
      } catch {
        if (!isOpenCurrent()) return "superseded";
        valid = false;
      }
    }
    let generationAfter = -1;
    try {
      generationAfter = readWorkspaceGeneration(this.workspace);
    } catch {
      valid = false;
    }
    const currentAuthority = this.registry.authorize(message);
    if (!isOpenCurrent()) return "superseded";
    return valid && currentAuthority !== undefined &&
      sameAuthority(currentAuthority, authority) &&
      generationBefore === authority.workspaceGeneration &&
      generationAfter === authority.workspaceGeneration &&
      sameOpenedDocument(opened, authority) &&
      validDocumentRange(opened, authority.range)
      ? "valid"
      : "stale";
  }

  private async failOpen(
    authority: StoredRuleOpenAuthority,
    code: RulesSourceFailureCode,
  ): Promise<void> {
    this.report(code);
    await this.replaceIfCurrent(
      authority.inspectMessageId,
      authority.rulesGeneration,
    );
  }

  private async replaceIfCurrent(
    inspectMessageId: string,
    failedGeneration: number,
  ): Promise<void> {
    if (
      this.disposed ||
      this.currentInspect?.messageId !== inspectMessageId
    ) {
      return;
    }
    const active = this.registry.current();
    if (
      active?.inspectMessageId === inspectMessageId &&
      active.rulesGeneration > failedGeneration
    ) {
      return;
    }
    await this.resolveCurrent(true);
  }

  private isOpenCurrent(operation: number): boolean {
    return !this.disposed && operation === this.openOperation;
  }

  private settleSupersededPublication(
    prepared: PreparedRulesSourcesPublication,
    locallyAccepted: boolean,
    inspectMessageId: string,
  ): void {
    try {
      if (locallyAccepted) {
        prepared.commit();
        if (this.currentInspect?.messageId === inspectMessageId) {
          this.locallyAcceptedInspectMessageId = inspectMessageId;
          this.retainCurrentDependencies();
        }
      } else {
        prepared.rollback();
      }
    } catch {
      // A newer operation already owns the registry; never clear its state.
    }
  }

  private invalidateWithoutPublication(): void {
    this.resolutionAbort?.abort();
    this.resolutionAbort = undefined;
    this.operation += 1;
    this.openOperation += 1;
    this.currentInspect = undefined;
    this.locallyAcceptedInspectMessageId = undefined;
    this.registry.clear();
    this.clearRetainedDependencies();
  }

  private retainCurrentDependencies(): void {
    for (const uri of this.registry.dependencyUris()) {
      if (this.retainedDependencyUris.size >= MAX_RETAINED_DEPENDENCIES) {
        this.watchAllRulesCandidates = true;
        return;
      }
      this.retainedDependencyUris.add(canonicalUri(uri));
    }
  }

  private clearRetainedDependencies(): void {
    this.retainedDependencyUris.clear();
    this.watchAllRulesCandidates = false;
  }

  private report(code: RulesSourceFailureCode): void {
    try {
      this.host.reportFailure(code);
    } catch {
      // Failure reporting is isolated from authority state transitions.
    }
  }
}

function unresolvedResolution(message: InspectMessage): RulesSourceResolutionBatch {
  const ruleRefs = [...new Set(
    message.ruleEvidence.rules.map((rule) => rule.ruleRef),
  )];
  return {
    selectionMessageId: message.messageId,
    results: ruleRefs.map((ruleRef) => ({
      kind: "unresolved",
      ruleRef,
      reason: "resolution-failed",
    })),
  };
}

function readWorkspaceGeneration(
  workspace: RulesSourceSnapshotWorkspace,
): number {
  const generation = workspace.currentRulesSourceGeneration();
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Rules source workspace generation is invalid");
  }
  return generation;
}

function sameAuthority(
  left: StoredRuleOpenAuthority,
  right: StoredRuleOpenAuthority,
): boolean {
  return left.openAuthorityId === right.openAuthorityId &&
    left.inspectMessageId === right.inspectMessageId &&
    left.rulesGeneration === right.rulesGeneration;
}

function sameOpenedDocument(
  document: SourceDocument,
  authority: StoredRuleOpenAuthority,
): boolean {
  return canonicalUri(document.uri) === canonicalUri(authority.documentUri) &&
    document.version === authority.documentVersion;
}

function sameEditorDocument(
  editor: RulesSourceEditorLike,
  authority: StoredRuleOpenAuthority,
): boolean {
  const uri = typeof editor.document.uri === "string"
    ? editor.document.uri
    : editor.document.uri.toString();
  return canonicalUri(editor.documentUri) === canonicalUri(authority.documentUri) &&
    canonicalUri(uri) === canonicalUri(authority.documentUri) &&
    editor.document.version === authority.documentVersion;
}

function validDocumentRange(
  document: SourceDocument,
  range: SourceRange,
): boolean {
  try {
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    return endOffset > startOffset &&
      equalPosition(document.positionAt(startOffset), range.start) &&
      equalPosition(document.positionAt(endOffset), range.end);
  } catch {
    return false;
  }
}

function equalPosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function canonicalUri(uri: string): string {
  return canonicalRulesSourceUri(uri) ?? uri;
}

function isRulesDependencyCandidate(uri: string): boolean {
  try {
    return /\.(?:css|scss|map)$/i.test(new URL(uri).pathname);
  } catch {
    return false;
  }
}
