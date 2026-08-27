import type {
  CreateElementsRulesRenderer,
  ElementsRulesRendererHost,
  MatchedStylesSnapshot,
  PseudoStateDataSource,
  RuleOriginDecoration,
  SourceLinkDelegate,
} from "../../contracts.js";
import { PseudoStateController } from "../../pseudoStateController.js";

/**
 * The browser bundle owns Chromium's real StylesSidebarPane and converts the
 * neutral snapshot to the pinned Protocol/SDK objects it needs. This package
 * deliberately knows only the small, read-only high-level boundary below.
 */
export interface ChromiumReadOnlyStylesRuntime {
  createPane(options: ChromiumReadOnlyStylesPaneOptions): ChromiumReadOnlyStylesPane;
}

export interface ChromiumReadOnlyStylesPaneOptions {
  readonly document: Document;
  readonly mount: HTMLElement;
  readonly resolveOrigin: (
    ruleRef: string,
  ) => RuleOriginDecoration | undefined;
  readonly openOrigin: (ruleRef: string) => void;
  readonly onError: (error: unknown) => void;
}

export interface ChromiumReadOnlyStylesPane {
  readonly element: HTMLElement;
  render(snapshot: MatchedStylesSnapshot): void;
  refreshOrigins(): void;
  clear(): void;
  dispose(): void;
}

export interface PinOpStylesRulesRendererOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Creates the Rules renderer factory injected into ElementsInspectorView.
 * Chromium stays behind an explicit structural interface, so this package
 * never imports SDK/UI globals or relies on their singleton state.
 */
export function createPinOpStylesRulesRenderer(
  runtime: ChromiumReadOnlyStylesRuntime,
  options: PinOpStylesRulesRendererOptions = {},
): CreateElementsRulesRenderer {
  return (
    document,
    mount,
    _dataSource,
    sourceLinkDelegate,
    pseudoStateDataSource,
  ) => createHost(
    runtime,
    document,
    mount,
    sourceLinkDelegate,
    pseudoStateDataSource,
    options,
  );
}

function createHost(
  runtime: ChromiumReadOnlyStylesRuntime,
  document: Document,
  mount: HTMLElement,
  sourceLinkDelegate: SourceLinkDelegate | undefined,
  pseudoStateDataSource: PseudoStateDataSource | undefined,
  options: PinOpStylesRulesRendererOptions,
): ElementsRulesRendererHost {
  const originalNodes = directChildren(mount);
  const originalNodeSet = new Set(originalNodes);
  const originBoundary = new RuleOriginBoundary(
    sourceLinkDelegate,
    options.onError,
  );
  let pane: ChromiumReadOnlyStylesPane | undefined;
  let paneElement: HTMLElement | undefined;
  let pseudoStateController: PseudoStateController | undefined;
  try {
    pane = runtime.createPane({
      document,
      mount,
      resolveOrigin: originBoundary.resolveOrigin,
      openOrigin: originBoundary.openOrigin,
      onError: originBoundary.report,
    });
    assertPane(pane);
    paneElement = pane.element;
    if (
      originalNodeSet.has(paneElement) ||
      !isDirectChild(paneElement, mount)
    ) {
      throw new Error(
        "Chromium read-only Styles pane must be a new direct child of its mount",
      );
    }
    if (pseudoStateDataSource) {
      pseudoStateController = new PseudoStateController(
        document,
        pseudoStateDataSource,
      );
      mount.append(pseudoStateController.element, paneElement);
    }
    const ownedNodes = directChildren(mount).filter(
      node => !originalNodeSet.has(node),
    );
    return new PinOpStylesRulesRendererHost(
      mount,
      pane,
      paneElement,
      pseudoStateController,
      originBoundary,
      ownedNodes,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    attempt(failures, () => pseudoStateController?.dispose());
    attempt(failures, () => pane?.dispose());
    attempt(failures, () => restoreChildren(mount, originalNodes));
    originBoundary.dispose();
    throwFailures(failures, "Chromium Styles renderer initialization failed");
  }
}

class PinOpStylesRulesRendererHost implements ElementsRulesRendererHost {
  private lastSnapshot: MatchedStylesSnapshot | undefined;
  private pendingPresentation: PendingPresentation | undefined;
  private presentationRequestRevision = 0;
  private presenting = false;
  private disposed = false;
  private disposeCompleted = false;

  public constructor(
    private readonly mount: HTMLElement,
    private readonly pane: ChromiumReadOnlyStylesPane,
    private readonly paneElement: HTMLElement,
    private readonly pseudoStateController: PseudoStateController | undefined,
    private readonly originBoundary: RuleOriginBoundary,
    private readonly ownedNodes: readonly Node[],
  ) {}

  public render(snapshot: MatchedStylesSnapshot): void {
    if (this.disposed) return;
    const requestRevision = ++this.presentationRequestRevision;
    let ruleRefs: ReadonlySet<string>;
    try {
      ruleRefs = collectRuleRefs(snapshot);
    } catch (error) {
      if (requestRevision !== this.presentationRequestRevision || this.disposed) {
        this.originBoundary.report(error);
        return;
      }
      const authorityRevision = this.originBoundary.clearRuleRefs();
      this.pendingPresentation = {
        kind: "failure",
        authorityRevision,
        error,
      };
      this.drainPresentation();
      return;
    }
    if (requestRevision !== this.presentationRequestRevision || this.disposed) return;
    const authorityRevision = this.originBoundary.setRuleRefs(ruleRefs);
    this.pendingPresentation = {
      kind: "render",
      authorityRevision,
      snapshot,
    };
    this.drainPresentation();
  }

  public clear(): void {
    if (this.disposed) return;
    this.presentationRequestRevision += 1;
    this.originBoundary.clearRuleRefs();
    this.pendingPresentation = { kind: "clear" };
    this.drainPresentation();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.presentationRequestRevision += 1;
    this.disposed = true;
    this.pendingPresentation = undefined;
    this.lastSnapshot = undefined;
    this.originBoundary.dispose();
    if (this.presenting) return;
    this.finishDispose();
  }

  private drainPresentation(): void {
    if (this.presenting || this.disposed) return;
    this.presenting = true;
    try {
      while (!this.disposed) {
        const presentation = this.pendingPresentation;
        if (!presentation) break;
        this.pendingPresentation = undefined;
        if (presentation.kind === "render") {
          this.presentSnapshot(presentation);
        } else if (presentation.kind === "clear") {
          this.clearPane("Chromium Styles pane could not be cleared");
        } else {
          this.recoverFromPresentationFailure(
            presentation.authorityRevision,
            presentation.error,
          );
        }
      }
    } finally {
      this.presenting = false;
      if (this.disposed && !this.disposeCompleted) this.finishDispose();
    }
  }

  private presentSnapshot(
    presentation: Extract<PendingPresentation, { readonly kind: "render" }>,
  ): void {
    const refreshOnly = presentation.snapshot === this.lastSnapshot;
    try {
      if (refreshOnly) this.pane.refreshOrigins();
      else this.pane.render(presentation.snapshot);
      if (this.disposed) return;
      this.restoreStableChildren();
      if (this.disposed) return;
      this.lastSnapshot = presentation.snapshot;
    } catch (error) {
      this.recoverFromPresentationFailure(
        presentation.authorityRevision,
        error,
      );
    }
  }

  private clearPane(message: string): void {
    this.lastSnapshot = undefined;
    const failures: unknown[] = [];
    attempt(failures, () => this.pane.clear());
    if (failures.length > 0 && !this.disposed) {
      attempt(failures, () => this.paneElement.replaceChildren());
    }
    if (!this.disposed) attempt(failures, () => this.restoreStableChildren());
    this.originBoundary.reportFailures(failures, message);
  }

  private finishDispose(): void {
    if (this.disposeCompleted) return;
    this.disposeCompleted = true;
    const failures: unknown[] = [];
    attempt(failures, () => this.pseudoStateController?.dispose());
    attempt(failures, () => this.pane.dispose());
    for (const node of this.ownedNodes) {
      attempt(failures, () => removeNode(node));
    }
    if (failures.length > 0) {
      throwFailures(failures, "Chromium Styles renderer teardown failed");
    }
  }

  private recoverFromPresentationFailure(
    authorityRevision: number,
    presentationError: unknown,
  ): void {
    if (this.disposed) return;
    if (!this.originBoundary.isCurrentRevision(authorityRevision)) {
      // The newer request has not touched the serialized pane yet. Force it
      // through a full render because the failed older call may be partial.
      this.lastSnapshot = undefined;
      this.originBoundary.report(presentationError);
      return;
    }
    this.lastSnapshot = undefined;
    this.originBoundary.clearRuleRefsIfCurrent(authorityRevision);
    const failures: unknown[] = [presentationError];
    attempt(failures, () => this.pane.clear());
    if (failures.length > 1 && !this.disposed) {
      attempt(failures, () => this.paneElement.replaceChildren());
    }
    if (!this.disposed) attempt(failures, () => this.restoreStableChildren());
    this.originBoundary.reportFailures(
      failures,
      "Chromium Styles presentation failed",
    );
  }

  private restoreStableChildren(): void {
    if (this.disposed) return;
    const pseudoElement = this.pseudoStateController?.element;
    const children = directChildren(this.mount);
    if (pseudoElement) {
      const pseudoIndex = children.indexOf(pseudoElement);
      const paneIndex = children.indexOf(this.paneElement);
      if (
        pseudoIndex === children.length - 2 &&
        paneIndex === children.length - 1
      ) {
        return;
      }
      this.mount.append(pseudoElement, this.paneElement);
    } else if (children.at(-1) !== this.paneElement) {
      this.mount.append(this.paneElement);
    }
  }
}

type PendingPresentation =
  | {
    readonly kind: "render";
    readonly authorityRevision: number;
    readonly snapshot: MatchedStylesSnapshot;
  }
  | {
    readonly kind: "clear";
  }
  | {
    readonly kind: "failure";
    readonly authorityRevision: number;
    readonly error: unknown;
  };

class RuleOriginBoundary {
  private ruleRefs: ReadonlySet<string> = EMPTY_RULE_REFS;
  private authorityRevision = 0;
  private disposed = false;

  public constructor(
    private delegate: SourceLinkDelegate | undefined,
    private errorObserver: ((error: unknown) => void) | undefined,
  ) {}

  public readonly resolveOrigin = (
    ruleRef: string,
  ): RuleOriginDecoration | undefined => {
    const authorityRevision = this.authorityRevision;
    const delegate = this.delegate;
    if (
      this.disposed ||
      typeof ruleRef !== "string" ||
      !this.ruleRefs.has(ruleRef) ||
      !delegate
    ) {
      return undefined;
    }
    try {
      const origin = delegate.originFor(ruleRef);
      const sanitized = origin === undefined ? undefined : sanitizeOrigin(origin);
      if (!this.isCurrentAuthority(authorityRevision, delegate, ruleRef)) {
        return undefined;
      }
      return sanitized;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  };

  public readonly openOrigin = (ruleRef: string): void => {
    const authorityRevision = this.authorityRevision;
    const delegate = this.delegate;
    if (
      this.disposed ||
      typeof ruleRef !== "string" ||
      !this.ruleRefs.has(ruleRef) ||
      !delegate
    ) return;
    let openRuleOrigin: SourceLinkDelegate["openRuleOrigin"];
    try {
      openRuleOrigin = delegate.openRuleOrigin;
    } catch (error) {
      this.report(error);
      return;
    }
    const origin = this.resolveOrigin(ruleRef);
    if (
      !origin?.clickable ||
      !this.isCurrentAuthority(authorityRevision, delegate, ruleRef)
    ) {
      return;
    }
    try {
      Reflect.apply(openRuleOrigin, delegate, [ruleRef]);
    } catch (error) {
      this.report(error);
    }
  };

  public readonly report = (error: unknown): void => {
    if (this.disposed || !this.errorObserver) return;
    try {
      this.errorObserver(error);
    } catch {
      // Diagnostics are observational and never gain renderer authority.
    }
  };

  public setRuleRefs(ruleRefs: ReadonlySet<string>): number {
    if (!this.disposed) {
      this.ruleRefs = ruleRefs;
      this.authorityRevision += 1;
    }
    return this.authorityRevision;
  }

  public clearRuleRefs(): number {
    if (!this.disposed) {
      this.ruleRefs = EMPTY_RULE_REFS;
      this.authorityRevision += 1;
    }
    return this.authorityRevision;
  }

  public clearRuleRefsIfCurrent(authorityRevision: number): void {
    if (!this.disposed && authorityRevision === this.authorityRevision) {
      this.ruleRefs = EMPTY_RULE_REFS;
      this.authorityRevision += 1;
    }
  }

  public isCurrentRevision(authorityRevision: number): boolean {
    return !this.disposed && authorityRevision === this.authorityRevision;
  }

  public reportFailures(failures: readonly unknown[], message: string): void {
    if (failures.length === 0) return;
    this.report(combinedFailure(failures, message));
  }

  public dispose(): void {
    this.disposed = true;
    this.ruleRefs = EMPTY_RULE_REFS;
    this.authorityRevision += 1;
    this.delegate = undefined;
    this.errorObserver = undefined;
  }

  private isCurrentAuthority(
    authorityRevision: number,
    delegate: SourceLinkDelegate,
    ruleRef: string,
  ): boolean {
    return !this.disposed &&
      authorityRevision === this.authorityRevision &&
      delegate === this.delegate &&
      this.ruleRefs.has(ruleRef);
  }
}

function collectRuleRefs(snapshot: MatchedStylesSnapshot): ReadonlySet<string> {
  const refs = new Set<string>();
  const addRule = (rule: MatchedStylesSnapshot["matchedRules"][number]): void => {
    if (typeof rule.ruleRef !== "string" || rule.ruleRef.length === 0) {
      throw new TypeError("Matched Styles contains an invalid rule reference");
    }
    refs.add(rule.ruleRef);
  };
  if (snapshot.inlineStyle) addRule(snapshot.inlineStyle);
  for (const rule of snapshot.matchedRules) addRule(rule);
  for (const inherited of snapshot.inherited) {
    if (inherited.inlineStyle) addRule(inherited.inlineStyle);
    for (const rule of inherited.matchedRules) addRule(rule);
  }
  return refs;
}

function sanitizeOrigin(origin: RuleOriginDecoration): RuleOriginDecoration {
  const label = origin.label;
  const languageId = origin.languageId;
  const startLine = origin.startLine;
  const startColumn = origin.startColumn;
  const confidence = origin.confidence;
  const clickable = origin.clickable;
  const state = origin.state;
  if (
    !isSafeLabel(label) ||
    (languageId !== "css" && languageId !== "scss") ||
    !isOneBasedPosition(startLine) ||
    !isOneBasedPosition(startColumn) ||
    (confidence !== "exact" && confidence !== "sourcemap") ||
    typeof clickable !== "boolean" ||
    (state !== undefined &&
      state !== "pending" &&
      state !== "stale" &&
      state !== "incompatible") ||
    (state !== undefined && clickable)
  ) {
    throw new TypeError("Source origin decoration is invalid or not sanitized");
  }
  return Object.freeze({
    label,
    languageId,
    startLine,
    startColumn,
    confidence,
    clickable,
    ...(state === undefined ? {} : { state }),
  });
}

function isSafeLabel(label: unknown): label is string {
  return typeof label === "string" &&
    label.length > 0 &&
    label.length <= SOURCE_LABEL_MAX_LENGTH &&
    label !== "." &&
    label !== ".." &&
    !FORBIDDEN_SOURCE_LABEL.test(label) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(label);
}

function isOneBasedPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function assertPane(
  pane: ChromiumReadOnlyStylesPane,
): asserts pane is ChromiumReadOnlyStylesPane {
  if (
    !isRecord(pane) ||
    !isRecord(pane.element) ||
    typeof pane.element.remove !== "function" ||
    typeof pane.render !== "function" ||
    typeof pane.refreshOrigins !== "function" ||
    typeof pane.clear !== "function" ||
    typeof pane.dispose !== "function"
  ) {
    throw new TypeError("Chromium read-only Styles runtime returned an invalid pane");
  }
}

function directChildren(mount: HTMLElement): Node[] {
  const structural = mount as unknown as {
    readonly childNodes?: ArrayLike<Node>;
    readonly children: ArrayLike<Node>;
  };
  return Array.from(structural.childNodes ?? structural.children);
}

function isDirectChild(node: Node, mount: HTMLElement): boolean {
  const structural = node as unknown as {
    readonly parentNode?: Node | null;
    readonly parentElement?: HTMLElement | null;
  };
  return (structural.parentNode ?? structural.parentElement) === mount;
}

function restoreChildren(mount: HTMLElement, children: readonly Node[]): void {
  mount.replaceChildren(...children);
}

function removeNode(node: Node): void {
  const removable = node as Node & { remove(): void };
  removable.remove();
}

function attempt(failures: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}

function combinedFailure(
  failures: readonly unknown[],
  message: string,
): unknown {
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, message);
}

function throwFailures(failures: readonly unknown[], message: string): never {
  throw combinedFailure(failures, message);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

const EMPTY_RULE_REFS: ReadonlySet<string> = Object.freeze(new Set<string>());
const SOURCE_LABEL_MAX_LENGTH = 128;
const FORBIDDEN_SOURCE_LABEL =
  /[\/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
