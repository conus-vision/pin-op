import type {
  CreateElementsRulesRenderer,
  ElementsRulesRendererHost,
  MatchedStylesSnapshot,
  PseudoStateDataSource,
  RuleOriginDeclaration,
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
  /** Opens a rule's source, at one of its declarations when one is given. */
  readonly openOrigin: (
    ruleRef: string,
    declaration?: RuleOriginDeclaration,
  ) => void;
  /** Shows the page at the viewport size an `@media` condition names. */
  readonly previewMediaQuery?: (conditionText: string) => void;
  readonly onError: (error: unknown) => void;
}

export interface ChromiumReadOnlyStylesPane {
  readonly element: HTMLElement;
  render(snapshot: MatchedStylesSnapshot): void | Promise<void>;
  refreshOrigins(): void | Promise<void>;
  clear(): void;
  dispose(): void;
  /** Chromium's own Styles toolbar row, when the runtime exposes it. */
  toolbarElement?(): HTMLElement | null;
  /** Chromium's toolbar pane below that row, when the runtime exposes it. */
  toolbarPaneElement?(): HTMLElement | null;
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
  let pseudoMountedInPane = false;
  try {
    pane = runtime.createPane({
      document,
      mount,
      resolveOrigin: originBoundary.resolveOrigin,
      openOrigin: originBoundary.openOrigin,
      previewMediaQuery: originBoundary.previewMediaQuery,
      onError: originBoundary.report,
    });
    assertPane(pane);
    paneElement = pane.element;
    if (
      originalNodeSet.has(paneElement) ||
      !isDirectChild(paneElement, mount)
    ) {
      throw new Error(
        "Native read-only Styles pane must be a new direct child of its mount",
      );
    }
    if (pseudoStateDataSource) {
      pseudoStateController = new PseudoStateController(
        document,
        pseudoStateDataSource,
      );
      // Prefer Chromium's own toolbar row and toolbar pane so the read-only
      // preview toggle occupies the native element-state position instead of
      // floating above the rule list. Those elements live behind the pane's
      // widget shadow root, so the runtime is their only authority.
      const toolbar = mountTarget(pane.toolbarElement?.());
      const toolbarPane = mountTarget(pane.toolbarPaneElement?.());
      if (toolbar && toolbarPane) {
        toolbar.append(pseudoStateController.buttonHost);
        toolbarPane.append(pseudoStateController.paneHost);
        pseudoMountedInPane = true;
      } else {
        mount.append(pseudoStateController.element, paneElement);
      }
    }
    const ownedNodes = directChildren(mount).filter(
      node => !originalNodeSet.has(node),
    );
    return new PinOpStylesRulesRendererHost(
      mount,
      pane,
      paneElement,
      pseudoStateController,
      pseudoMountedInPane,
      originBoundary,
      ownedNodes,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    attempt(failures, () => pseudoStateController?.dispose());
    attempt(failures, () => pane?.dispose());
    attempt(failures, () => restoreChildren(mount, originalNodes));
    originBoundary.dispose();
    throwFailures(failures, "Native Styles renderer initialization failed");
  }
}

class PinOpStylesRulesRendererHost implements ElementsRulesRendererHost {
  private lastSnapshot: MatchedStylesSnapshot | undefined;
  private pendingPresentation: PendingPresentation | undefined;
  private presentationRequestRevision = 0;
  private presenting = false;
  private awaitingAsyncPresentation = false;
  private disposed = false;
  private disposeCompleted = false;

  public constructor(
    private readonly mount: HTMLElement,
    private readonly pane: ChromiumReadOnlyStylesPane,
    private readonly paneElement: HTMLElement,
    private readonly pseudoStateController: PseudoStateController | undefined,
    private readonly pseudoMountedInPane: boolean,
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
        requestRevision,
      };
      this.drainPresentation();
      return;
    }
    if (requestRevision !== this.presentationRequestRevision || this.disposed) return;
    const authorityRevision = this.originBoundary.setRuleRefs(ruleRefs);
    this.pendingPresentation = {
      kind: "render",
      authorityRevision,
      requestRevision,
      snapshot,
    };
    this.drainPresentation();
  }

  public clear(): void {
    if (this.disposed) return;
    const requestRevision = ++this.presentationRequestRevision;
    this.originBoundary.clearRuleRefs();
    this.pendingPresentation = { kind: "clear", requestRevision };
    this.drainPresentation();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.presentationRequestRevision += 1;
    this.disposed = true;
    this.pendingPresentation = undefined;
    this.lastSnapshot = undefined;
    this.originBoundary.dispose();
    if (this.presenting && !this.awaitingAsyncPresentation) return;
    this.finishDispose();
  }

  private drainPresentation(): void {
    if (this.presenting || this.disposed) return;
    while (!this.disposed) {
      const presentation = this.pendingPresentation;
      if (!presentation) return;
      this.pendingPresentation = undefined;
      this.presenting = true;
      if (presentation.kind === "render") {
        const completion = this.startSnapshotPresentation(presentation);
        if (completion) {
          this.awaitingAsyncPresentation = true;
          this.observeAsyncPresentation(presentation, completion);
          if (this.disposed && !this.disposeCompleted) this.finishDispose();
          return;
        }
      } else if (presentation.kind === "clear") {
        this.clearPane("Native Styles pane could not be cleared");
      } else {
        this.recoverFromPresentationFailure(presentation, presentation.error);
      }
      this.presenting = false;
      if (this.disposed && !this.disposeCompleted) {
        this.finishDispose();
        return;
      }
    }
  }

  private startSnapshotPresentation(
    presentation: Extract<PendingPresentation, { readonly kind: "render" }>,
  ): Promise<void> | undefined {
    const refreshOnly = presentation.snapshot === this.lastSnapshot;
    let completion: void | Promise<void>;
    try {
      completion = refreshOnly
        ? this.pane.refreshOrigins()
        : this.pane.render(presentation.snapshot);
    } catch (error) {
      this.recoverFromPresentationFailure(presentation, error);
      return undefined;
    }
    if (completion !== undefined) return adoptCompletion(completion);
    this.completeSnapshotPresentation(presentation);
    return undefined;
  }

  private observeAsyncPresentation(
    presentation: Extract<PendingPresentation, { readonly kind: "render" }>,
    completion: Promise<void>,
  ): void {
    void completion.then(
      () => this.settleAsyncPresentation(presentation, { kind: "success" }),
      error => this.settleAsyncPresentation(
        presentation,
        { kind: "failure", error },
      ),
    ).catch(error => {
      // A native callback may be arbitrarily hostile. Keep its exception out
      // of the host event loop and leave diagnostics observational.
      try {
        this.awaitingAsyncPresentation = false;
        this.presenting = false;
        this.lastSnapshot = undefined;
        this.originBoundary.report(error);
      } catch {
        // The boundary itself is deliberately non-throwing; this is a final
        // containment guard for structural runtimes outside our type system.
      }
    });
  }

  private settleAsyncPresentation(
    presentation: Extract<PendingPresentation, { readonly kind: "render" }>,
    outcome: AsyncPresentationOutcome,
  ): void {
    this.awaitingAsyncPresentation = false;
    try {
      if (outcome.kind === "success") {
        this.completeSnapshotPresentation(presentation);
      } else {
        this.recoverFromPresentationFailure(presentation, outcome.error);
      }
    } finally {
      this.presenting = false;
    }
    if (this.disposed && !this.disposeCompleted) {
      this.finishDispose();
      return;
    }
    this.drainPresentation();
  }

  private completeSnapshotPresentation(
    presentation: Extract<PendingPresentation, { readonly kind: "render" }>,
  ): void {
    if (!this.isCurrentPresentation(presentation)) {
      if (!this.disposed) this.lastSnapshot = undefined;
      return;
    }
    try {
      this.restoreStableChildren();
    } catch (error) {
      this.recoverFromPresentationFailure(presentation, error);
      return;
    }
    if (!this.isCurrentPresentation(presentation)) {
      if (!this.disposed) this.lastSnapshot = undefined;
      return;
    }
    this.lastSnapshot = presentation.snapshot;
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
      throwFailures(failures, "Native Styles renderer teardown failed");
    }
  }

  private recoverFromPresentationFailure(
    presentation: Extract<
      PendingPresentation,
      { readonly kind: "render" | "failure" }
    >,
    presentationError: unknown,
  ): void {
    if (this.disposed) return;
    if (!this.isCurrentPresentation(presentation)) {
      // The newer request has not touched the serialized pane yet. Force it
      // through a full render because the failed older call may be partial.
      this.lastSnapshot = undefined;
      this.originBoundary.report(presentationError);
      return;
    }
    this.lastSnapshot = undefined;
    this.originBoundary.clearRuleRefsIfCurrent(presentation.authorityRevision);
    const failures: unknown[] = [presentationError];
    attempt(failures, () => this.pane.clear());
    if (failures.length > 1 && !this.disposed) {
      attempt(failures, () => this.paneElement.replaceChildren());
    }
    if (!this.disposed) attempt(failures, () => this.restoreStableChildren());
    this.originBoundary.reportFailures(
      failures,
      "Native Styles presentation failed",
    );
  }

  private isCurrentPresentation(
    presentation: Extract<
      PendingPresentation,
      { readonly kind: "render" | "failure" }
    >,
  ): boolean {
    return !this.disposed &&
      presentation.requestRevision === this.presentationRequestRevision &&
      this.originBoundary.isCurrentRevision(presentation.authorityRevision);
  }

  private restoreStableChildren(): void {
    if (this.disposed) return;
    const pseudoElement = this.pseudoMountedInPane
      ? undefined
      : this.pseudoStateController?.element;
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
    readonly requestRevision: number;
    readonly snapshot: MatchedStylesSnapshot;
  }
  | {
    readonly kind: "clear";
    readonly requestRevision: number;
  }
  | {
    readonly kind: "failure";
    readonly authorityRevision: number;
    readonly error: unknown;
    readonly requestRevision: number;
  };

type AsyncPresentationOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: unknown };

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

  public readonly openOrigin = (
    ruleRef: string,
    declaration?: RuleOriginDeclaration,
  ): void => {
    const authorityRevision = this.authorityRevision;
    const delegate = this.delegate;
    // A declaration that cannot be named safely still opens its rule, as the
    // origin link would, rather than swallowing the click.
    const safeDeclaration = declaration === undefined
      ? undefined
      : sanitizeDeclaration(declaration);
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
      Reflect.apply(
        openRuleOrigin,
        delegate,
        safeDeclaration ? [ruleRef, safeDeclaration] : [ruleRef],
      );
    } catch (error) {
      this.report(error);
    }
  };

  public readonly previewMediaQuery = (conditionText: string): void => {
    const delegate = this.delegate;
    if (
      this.disposed ||
      !delegate ||
      typeof conditionText !== "string" ||
      conditionText.trim().length === 0 ||
      conditionText.length > MEDIA_CONDITION_MAX_LENGTH
    ) return;
    try {
      const previewMediaQuery = delegate.previewMediaQuery;
      if (typeof previewMediaQuery !== "function") return;
      Reflect.apply(previewMediaQuery, delegate, [conditionText]);
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

function sanitizeDeclaration(
  declaration: RuleOriginDeclaration,
): RuleOriginDeclaration | undefined {
  try {
    const property = declaration.property;
    const occurrence = declaration.occurrence;
    return typeof property === "string" &&
        property.length <= DECLARATION_PROPERTY_MAX_LENGTH &&
        CSS_PROPERTY_NAME.test(property) &&
        Number.isSafeInteger(occurrence) &&
        occurrence >= 0 &&
        occurrence < DECLARATION_OCCURRENCE_LIMIT
      ? Object.freeze({ property, occurrence })
      : undefined;
  } catch {
    return undefined;
  }
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

function mountTarget(value: HTMLElement | null | undefined): HTMLElement | undefined {
  return isRecord(value) && typeof value.append === "function" ? value : undefined;
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
    throw new TypeError("Native read-only Styles runtime returned an invalid pane");
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

function adoptCompletion(completion: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const then = completion.then;
      if (typeof then !== "function") {
        throw new TypeError("Native Styles completion is not thenable");
      }
      Reflect.apply(then, completion, [() => resolve(), reject]);
    } catch (error) {
      reject(error);
    }
  });
}

const EMPTY_RULE_REFS: ReadonlySet<string> = Object.freeze(new Set<string>());
const SOURCE_LABEL_MAX_LENGTH = 128;
const DECLARATION_PROPERTY_MAX_LENGTH = 256;
const DECLARATION_OCCURRENCE_LIMIT = 128;
const MEDIA_CONDITION_MAX_LENGTH = 2048;
const CSS_PROPERTY_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/u;
const FORBIDDEN_SOURCE_LABEL =
  /[\/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
