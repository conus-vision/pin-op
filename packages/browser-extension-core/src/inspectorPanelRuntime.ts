import type {
  CreateElementsInspectorView,
  MatchedDeclarationSnapshot,
  MatchedRuleSnapshot,
  MatchedStylesSnapshot,
  PseudoState,
  PseudoStateDataSource,
  PseudoStateDisabledReason,
  PseudoStateSnapshot,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
} from "@pin-op/devtools-elements-ui";
import type { DomTreeController } from "./domTreeController.js";
import type { DomTreeDocument } from "./domTreeDocument.js";
import { ElementsInspectorAdapter } from "./elementsInspectorAdapter.js";
import {
  startPanelRuntimeWithPresentation,
  type PanelRuntimeOptions,
  type PanelRuntimePresentation,
} from "./panelRuntime.js";
import {
  InspectorPanelView,
  type InspectorPanelDocument,
} from "./inspectorPanelView.js";
import type { PanelSettingsController } from "./panelSettingsController.js";
import {
  MatchedStylesModel,
  type MatchedStylesModelSnapshot,
  type MatchedStylesResetReason,
} from "./matchedStylesModel.js";
import type {
  GeneratedMatchedRuleSource,
  MatchedDeclaration,
  MatchedDeclarationReason,
  MatchedRule,
  MatchedStyles,
} from "./matchedStylesTypes.js";
import { parseDomEvent } from "./domProtocol.js";
import {
  parsePanelInspectStartedState,
  parseInspectPortInvalidated,
  parsePanelRulesSourcesInvalidatedState,
  parseProtocolCompatibilityMessage,
} from "./inspectPortProtocol.js";
import { parseStylesEvent } from "./stylesProtocol.js";
import {
  RulesSourcesController,
} from "./rulesSourcesController.js";
import {
  SourcePaneView,
  type SourcePaneDocument,
} from "./sourcePaneView.js";

export interface InspectorPanelRuntimeOptions extends Omit<
  PanelRuntimeOptions,
  "createResizeObserver" | "document" | "layoutStorage"
> {
  readonly document: InspectorPanelDocument & DomTreeDocument;
  readonly createElementsInspectorView: CreateElementsInspectorView;
}

export interface InspectorPanelRuntime {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly settingsController: PanelSettingsController;
  readonly matchedStylesModel: MatchedStylesModel;
  readonly rulesSourcesController: RulesSourcesController;
  dispose(): void;
}

export function startInspectorPanelRuntime(
  options: InspectorPanelRuntimeOptions,
): InspectorPanelRuntime {
  const presentationState: {
    matchedStylesModel?: MatchedStylesModel;
    rulesSourcesController?: RulesSourcesController;
  } = {};
  const runtime = startPanelRuntimeWithPresentation(
    options,
    (runtimeOptions, reportError) => createInspectorPresentation(
      runtimeOptions,
      reportError,
      presentationState,
      options.createElementsInspectorView,
    ),
  );
  const matchedStylesModel = presentationState.matchedStylesModel;
  const rulesSourcesController = presentationState.rulesSourcesController;
  if (!matchedStylesModel || !rulesSourcesController) {
    runtime.dispose();
    throw new Error("Matched styles model failed to initialize");
  }
  return Object.freeze({
    ready: runtime.ready,
    closed: runtime.closed,
    settingsController: runtime.settingsController,
    matchedStylesModel,
    rulesSourcesController,
    dispose: () => runtime.dispose(),
  });
}

function createInspectorPresentation(
  options: PanelRuntimeOptions,
  reportError: (error: unknown) => void,
  presentationState: {
    matchedStylesModel?: MatchedStylesModel;
    rulesSourcesController?: RulesSourcesController;
  },
  createElementsInspectorView: CreateElementsInspectorView,
): PanelRuntimePresentation {
  const view = new InspectorPanelView(
    options.document as InspectorPanelDocument,
    reportError,
    createElementsInspectorView,
  );
  return {
    view,
    browserLocalInspection: true,
    attach(context) {
      const matchedStylesModel = new MatchedStylesModel({
        request: context.requestStyles,
      });
      const rulesSourcesController = new RulesSourcesController(
        context.dispatchRulesOpen,
      );
      const rulesLifecycle: RulesLifecycleAuthority = {};
      const pseudoStateAdapter = new MatchedStylesPseudoStateAdapter(
        matchedStylesModel,
        context.treeController,
      );
      let preparedRecoveryFence = false;
      presentationState.matchedStylesModel = matchedStylesModel;
      presentationState.rulesSourcesController = rulesSourcesController;
      const removeInspectorMessages = context.subscribeInspectorMessages(
        (message) => routeInspectorLifecycle(
          matchedStylesModel,
          rulesSourcesController,
          pseudoStateAdapter,
          rulesLifecycle,
          message,
          () => {
            const prepared = preparedRecoveryFence;
            preparedRecoveryFence = false;
            return prepared;
          },
        ),
      );
      const adapter = new ElementsInspectorAdapter(context.treeController);
      const rulesAdapter = new MatchedStylesRulesAdapter(
        matchedStylesModel,
        rulesSourcesController,
      );
      let removeSettingsBindings: (() => void) | undefined;
      let sourcePaneView: SourcePaneView | undefined;
      try {
        const elementsHost = view.mountTree(adapter);
        elementsHost.bindRulesDataSource(
          rulesAdapter,
          rulesAdapter,
          pseudoStateAdapter,
        );
        sourcePaneView = new SourcePaneView({
          document: options.document as unknown as SourcePaneDocument,
          root: elementsHost.sidebarExtensionMount,
          controller: context.sourcePaneController,
          onError: reportError,
        });
        view.bindStylesRefresh(matchedStylesModel);
        removeSettingsBindings = view.bindSettings(
          context.settingsController,
        );
      } catch (error) {
        removeInspectorMessages();
        pseudoStateAdapter.dispose();
        rulesSourcesController.dispose();
        matchedStylesModel.dispose();
        sourcePaneView?.dispose();
        view.dispose();
        throw error;
      }
      if (!sourcePaneView) {
        throw new Error("Source pane failed to initialize");
      }
      let disposed = false;
      const resetPreviewAuthority = (
        pseudoBoundary: "recovery" | "content-lease-replaced",
      ): boolean => {
        if (disposed) return false;
        if (pseudoBoundary === "recovery") {
          pseudoStateAdapter.beginRecovery();
        } else {
          pseudoStateAdapter.contentLeaseReplaced();
        }
        rulesLifecycle.selectionRevision = undefined;
        rulesLifecycle.documentEpoch = undefined;
        matchedStylesModel.reset("content-lease-replaced");
        rulesSourcesController.invalidate("transport-invalidation");
        return true;
      };
      return {
        sourcePaneView,
        removeSettingsBindings,
        removeSourceNavigationBindings: noOp,
        removeLayoutBindings: noOp,
        beforeControlledTransition() {
          const reset = resetPreviewAuthority("recovery");
          if (reset) preparedRecoveryFence = true;
          return reset;
        },
        contentLeaseReplaced() {
          preparedRecoveryFence = false;
          resetPreviewAuthority("content-lease-replaced");
        },
        disposePresentation() {
          if (disposed) return;
          disposed = true;
          removeInspectorMessages();
          pseudoStateAdapter.dispose();
          rulesSourcesController.dispose();
          matchedStylesModel.dispose();
          sourcePaneView.dispose();
          view.dispose();
        },
      };
    },
  };
}

async function routeInspectorLifecycle(
  model: MatchedStylesModel,
  controller: RulesSourcesController,
  pseudoStateAdapter: MatchedStylesPseudoStateAdapter,
  lifecycle: RulesLifecycleAuthority,
  message: unknown,
  consumePreparedRecoveryFence: () => boolean,
): Promise<void> {
  if (parseInspectPortInvalidated(message)) {
    if (!consumePreparedRecoveryFence()) {
      pseudoStateAdapter.acceptLifecycle(message);
      lifecycle.selectionRevision = undefined;
      lifecycle.documentEpoch = undefined;
      model.reset("inspect-port-invalidated");
      controller.invalidate("transport-invalidation");
    }
    return;
  }
  pseudoStateAdapter.acceptLifecycle(message);
  const matchedLifecycle = routeMatchedStylesLifecycle(model, message);
  routeRulesSourcesLifecycle(controller, lifecycle, message);
  await matchedLifecycle;
}

function routeRulesSourcesLifecycle(
  controller: RulesSourcesController,
  lifecycle: RulesLifecycleAuthority,
  message: unknown,
): void {
  const inspectStarted = parsePanelInspectStartedState(message);
  if (inspectStarted) {
    lifecycle.selectionRevision = inspectStarted.selectionRevision;
    lifecycle.documentEpoch = undefined;
    controller.beginInspect(
      inspectStarted.inspectMessageId,
      new Set(inspectStarted.expectedRuleRefs),
    );
    return;
  }
  const rulesInvalidated = parsePanelRulesSourcesInvalidatedState(message);
  if (rulesInvalidated) {
    controller.invalidatePublication(
      rulesInvalidated.inspectMessageId,
      rulesInvalidated.rulesGeneration,
    );
    return;
  }
  if (controller.accept(message) === "published") return;
  try {
    const event = parseStylesEvent(message);
    if (event.type === "styles.invalidated") {
      controller.invalidate("stylesheet-refresh");
    }
    return;
  } catch {
    // Continue through exact lifecycle families.
  }
  try {
    const event = parseDomEvent(message);
    if (event.type === "dom.selectionChanged") {
      if (
        lifecycle.selectionRevision !== event.selectionRevision ||
        (lifecycle.documentEpoch !== undefined &&
          lifecycle.documentEpoch !== event.documentEpoch)
      ) {
        controller.invalidate("document-navigation");
      }
      lifecycle.selectionRevision = event.selectionRevision;
      lifecycle.documentEpoch = event.documentEpoch;
    } else if (event.type === "dom.selectionCleared") {
      controller.invalidate("document-navigation");
      lifecycle.selectionRevision = event.selectionRevision;
      lifecycle.documentEpoch = event.documentEpoch;
    }
    return;
  } catch {
    // Continue through non-DOM lifecycle families.
  }
  if (parseInspectPortInvalidated(message)) {
    lifecycle.selectionRevision = undefined;
    lifecycle.documentEpoch = undefined;
    controller.invalidate("transport-invalidation");
    return;
  }
  const compatibility = parseProtocolCompatibilityMessage(message);
  if (compatibility) {
    if (!compatibility.compatible) {
      lifecycle.selectionRevision = undefined;
      lifecycle.documentEpoch = undefined;
    }
    controller.setCompatible(compatibility.compatible);
    return;
  }
  const state = rulesWindowState(message);
  if (state === "incompatible") {
    lifecycle.selectionRevision = undefined;
    lifecycle.documentEpoch = undefined;
    controller.setCompatible(false);
  } else if (state && state !== "linked") {
    lifecycle.selectionRevision = undefined;
    lifecycle.documentEpoch = undefined;
    controller.invalidate("disconnect");
  } else if (isIdeDisconnectedState(message) || isDisconnectedPeer(message)) {
    lifecycle.selectionRevision = undefined;
    lifecycle.documentEpoch = undefined;
    controller.invalidate("disconnect");
  }
}

interface RulesLifecycleAuthority {
  documentEpoch?: number;
  selectionRevision?: number;
}

async function routeMatchedStylesLifecycle(
  model: MatchedStylesModel,
  message: unknown,
): Promise<void> {
  try {
    const event = parseStylesEvent(message);
    if (event.type === "styles.invalidated") model.invalidate(event);
    return;
  } catch {
    // Continue through exact lifecycle families.
  }
  try {
    const event = parseDomEvent(message);
    if (event.type === "dom.selectionChanged") {
      await model.select({
        documentEpoch: event.documentEpoch,
        nodeRef: event.nodeRef,
        selectionRevision: event.selectionRevision,
      });
    } else if (event.type === "dom.selectionCleared") {
      model.reset("advanced-selection");
    }
    return;
  } catch {
    // Continue through non-DOM lifecycle families.
  }
  if (parseInspectPortInvalidated(message)) {
    model.reset("inspect-port-invalidated");
    return;
  }
  const compatibility = parseProtocolCompatibilityMessage(message);
  if (compatibility && !compatibility.compatible) {
    model.reset("compatibility-failure");
    return;
  }
  const reason = disconnectedResetReason(message);
  if (reason) model.reset(reason);
}

class MatchedStylesRulesAdapter implements RulesDataSource, SourceLinkDelegate {
  private sourceSnapshot: MatchedStylesModelSnapshot | undefined;
  private presentationSnapshot: RulesPresentationSnapshot = EMPTY_RULES_PRESENTATION;

  public constructor(
    private readonly model: MatchedStylesModel,
    private readonly rulesSources: RulesSourcesController,
  ) {}

  public snapshot(): RulesPresentationSnapshot {
    const source = this.model.snapshot();
    if (source !== this.sourceSnapshot) {
      this.sourceSnapshot = source;
      this.presentationSnapshot = projectRulesPresentation(source);
    }
    return this.presentationSnapshot;
  }

  public subscribe(listener: () => void): () => void {
    const removeModel = this.model.subscribe(listener);
    const removeRulesSources = this.rulesSources.subscribe(listener);
    return () => {
      removeRulesSources();
      removeModel();
    };
  }

  public originFor(ruleRef: string) {
    return this.rulesSources.originFor(ruleRef);
  }

  public openRuleOrigin(ruleRef: string): void {
    this.rulesSources.open(ruleRef);
  }

  public filter(_query: string): void {
    // Filtering is presentation-local and never changes browser authority.
  }
}

/** Browser-local projection for the bounded read-only pseudo-state controls. */
class MatchedStylesPseudoStateAdapter implements PseudoStateDataSource {
  private readonly listeners = new Set<() => void>();
  private current: PseudoStateSnapshot = PSEUDO_UNAVAILABLE_NO_SELECTION;
  private lastReady: PseudoReadyAuthority | undefined;
  private selectionRevision: number | undefined;
  private boundary: PseudoLifecycleBoundary | undefined;
  private lifecycleRevision = 0;
  private removeModel: () => void = noOp;
  private removeTree: () => void = noOp;
  private disposed = false;

  public constructor(
    private readonly model: MatchedStylesModel,
    private readonly tree: DomTreeController,
  ) {
    let notificationsEnabled = false;
    let removeModel: (() => void) | undefined;
    let removeTree: (() => void) | undefined;
    try {
      removeModel = model.subscribe(() => {
        if (notificationsEnabled) this.recompute();
      });
      removeTree = tree.subscribe(() => {
        if (notificationsEnabled) this.recompute();
      });
      this.removeModel = removeModel;
      this.removeTree = removeTree;
      notificationsEnabled = true;
      this.recompute();
    } catch (error) {
      try {
        removeTree?.();
      } catch {
        // Preserve the initialization failure.
      }
      try {
        removeModel?.();
      } catch {
        // Preserve the initialization failure.
      }
      throw error;
    }
  }

  public snapshot(): PseudoStateSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    if (this.disposed) return noOp;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  public async setStates(states: readonly PseudoState[]): Promise<void> {
    if (this.disposed || !isInteractivePseudoSnapshot(this.current)) return;
    const canonical = canonicalPreviewStates(states);
    const lifecycleRevision = this.lifecycleRevision;
    const modelSnapshot = this.model.snapshot();
    const treeSnapshot = this.tree.snapshot();
    if (!this.isExactAuthority(modelSnapshot, treeSnapshot)) return;
    if (
      this.disposed ||
      lifecycleRevision !== this.lifecycleRevision ||
      modelSnapshot !== this.model.snapshot()
    ) return;
    const currentTree = this.tree.snapshot();
    if (!sameTreeAuthority(treeSnapshot, currentTree)) return;
    await this.model.setPseudoStates(canonical);
  }

  public acceptLifecycle(message: unknown): void {
    if (this.disposed) return;
    try {
      const event = parseDomEvent(message);
      if (event.type === "dom.selectionChanged") {
        this.selectionRevision = event.selectionRevision;
        this.recompute();
      } else if (event.type === "dom.selectionCleared") {
        this.selectionRevision = undefined;
        this.beginBoundary("no-selection", false);
      }
      return;
    } catch {
      // Continue through non-DOM lifecycle families.
    }

    if (parseInspectPortInvalidated(message)) {
      this.selectionRevision = undefined;
      this.lastReady = undefined;
      this.beginBoundary("recovery", false);
      return;
    }
    const compatibility = parseProtocolCompatibilityMessage(message);
    if (compatibility) {
      if (compatibility.compatible) this.resumeBoundary("mismatch");
      else {
        this.selectionRevision = undefined;
        this.lastReady = undefined;
        this.beginBoundary("mismatch", true);
      }
      return;
    }
    const windowState = rulesWindowState(message);
    if (windowState === "incompatible") {
      this.selectionRevision = undefined;
      this.lastReady = undefined;
      this.beginBoundary("mismatch", true);
      return;
    }
    if (windowState === "linked") {
      this.resumeBoundary("disconnected");
      return;
    }
    if (isConnectedPeer(message)) {
      this.resumeBoundary("disconnected");
      return;
    }
    if (
      windowState === "offline" ||
      windowState === "reconnecting" ||
      windowState === "notLinked" ||
      windowState === "linking" ||
      windowState === "rateLimited" ||
      windowState === "error" ||
      isIdeDisconnectedState(message) ||
      isDisconnectedPeer(message)
    ) {
      this.lastReady = undefined;
      this.beginBoundary("disconnected", true);
    }
  }

  public contentLeaseReplaced(): void {
    if (this.disposed) return;
    this.selectionRevision = undefined;
    this.lastReady = undefined;
    this.beginBoundary("disconnected", false);
  }

  public beginRecovery(): void {
    if (this.disposed) return;
    this.selectionRevision = undefined;
    this.lastReady = undefined;
    this.beginBoundary("recovery", false);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleRevision += 1;
    this.selectionRevision = undefined;
    this.boundary = undefined;
    this.lastReady = undefined;
    this.listeners.clear();
    const removeTree = this.removeTree;
    const removeModel = this.removeModel;
    this.removeTree = noOp;
    this.removeModel = noOp;
    let disposeError: unknown;
    try {
      removeTree();
    } catch (error) {
      disposeError = error;
    }
    try {
      removeModel();
    } catch (error) {
      disposeError ??= error;
    }
    if (disposeError !== undefined) throw disposeError;
  }

  private beginBoundary(
    reason: PseudoStateDisabledReason,
    requiresResume: boolean,
  ): void {
    this.lifecycleRevision += 1;
    this.boundary = Object.freeze({
      reason,
      minimumModelGeneration: this.model.snapshot().generation + 1,
      requiresResume,
    });
    this.publish(pseudoUnavailable(reason));
  }

  private resumeBoundary(reason: PseudoStateDisabledReason): void {
    const boundary = this.boundary;
    if (!boundary || boundary.reason !== reason || !boundary.requiresResume) {
      this.recompute();
      return;
    }
    const source = this.model.snapshot();
    const tree = this.tree.snapshot();
    const shouldRefresh = this.isExactAuthority(source, tree);
    this.lifecycleRevision += 1;
    this.boundary = Object.freeze({ ...boundary, requiresResume: false });
    this.recompute();
    if (shouldRefresh && !this.disposed) {
      void this.model.refresh().catch(() => {
        // MatchedStylesModel publishes the fixed error projection itself.
      });
    }
  }

  private recompute(): void {
    if (this.disposed) return;
    const tree = this.tree.snapshot();
    if (tree.recovering) {
      this.publish(PSEUDO_UNAVAILABLE_RECOVERY);
      return;
    }
    const source = this.model.snapshot();
    const boundary = this.boundary;
    const exact = this.isExactAuthority(source, tree);
    if (boundary) {
      if (
        boundary.requiresResume ||
        source.generation < boundary.minimumModelGeneration ||
        !exact
      ) {
        this.publish(pseudoUnavailable(boundary.reason));
        return;
      }
      this.boundary = undefined;
    }
    if (tree.documentEpoch === undefined || tree.selectedRef === undefined) {
      this.publish(PSEUDO_UNAVAILABLE_NO_SELECTION);
      return;
    }
    if (!exact) {
      this.publish(PSEUDO_UNAVAILABLE_MISMATCH);
      return;
    }

    if (source.state === "loading") {
      const confirmed = pseudoStatesFromModelKey(source) ??
        this.statesFromLastReady(tree);
      this.publish(pseudoSnapshot("loading", confirmed));
      return;
    }
    if (source.state === "error") {
      this.publish(PSEUDO_ERROR);
      return;
    }
    if ((source.state === "ready" || source.state === "partial") && source.styles) {
      if (!stylesMatchPseudoAuthority(source, tree, this.selectionRevision)) {
        this.publish(PSEUDO_UNAVAILABLE_MISMATCH);
        return;
      }
      const states = canonicalPreviewStates(source.styles.pseudoStates);
      this.lastReady = Object.freeze({
        documentEpoch: source.styles.documentEpoch,
        nodeRef: source.styles.nodeRef,
        selectionRevision: source.styles.selectionRevision,
        states,
      });
      this.publish(Object.freeze({
        state: source.state,
        states,
        unsupportedRuleCount: source.styles.unsupportedRuleCount,
        inaccessibleStylesheetCount: source.styles.inaccessibleStylesheetCount,
        approximateRuleCount: source.styles.approximateRuleCount,
      }));
      return;
    }
    this.publish(PSEUDO_UNAVAILABLE_NO_SELECTION);
  }

  private isExactAuthority(
    source: MatchedStylesModelSnapshot,
    tree: ReturnType<DomTreeController["snapshot"]>,
  ): boolean {
    const key = source.key;
    return !tree.recovering &&
      tree.documentEpoch !== undefined &&
      tree.selectedRef !== undefined &&
      this.selectionRevision !== undefined &&
      key !== undefined &&
      key.documentEpoch === tree.documentEpoch &&
      key.nodeRef === tree.selectedRef &&
      key.selectionRevision === this.selectionRevision;
  }

  private statesFromLastReady(
    tree: ReturnType<DomTreeController["snapshot"]>,
  ): readonly PseudoState[] {
    const ready = this.lastReady;
    return ready &&
        ready.documentEpoch === tree.documentEpoch &&
        ready.nodeRef === tree.selectedRef &&
        ready.selectionRevision === this.selectionRevision
      ? ready.states
      : NO_PSEUDO_STATES;
  }

  private publish(snapshot: PseudoStateSnapshot): void {
    if (this.disposed || samePseudoSnapshot(this.current, snapshot)) return;
    this.current = snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Presentation observers cannot change browser-local authority.
      }
    }
  }
}

interface PseudoReadyAuthority {
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly states: readonly PseudoState[];
}

interface PseudoLifecycleBoundary {
  readonly reason: PseudoStateDisabledReason;
  readonly minimumModelGeneration: number;
  readonly requiresResume: boolean;
}

const NO_PSEUDO_STATES = Object.freeze([] as PseudoState[]);
const PSEUDO_UNAVAILABLE_NO_SELECTION = pseudoUnavailable("no-selection");
const PSEUDO_UNAVAILABLE_RECOVERY = pseudoUnavailable("recovery");
const PSEUDO_UNAVAILABLE_MISMATCH = pseudoUnavailable("mismatch");
const PSEUDO_ERROR: PseudoStateSnapshot = Object.freeze({
  state: "error",
  states: NO_PSEUDO_STATES,
  unsupportedRuleCount: 0,
  inaccessibleStylesheetCount: 0,
  approximateRuleCount: 0,
  message: "Pseudo-state preview is unavailable",
});

function pseudoUnavailable(
  reason: PseudoStateDisabledReason,
): PseudoStateSnapshot {
  return Object.freeze({
    state: "unavailable",
    states: NO_PSEUDO_STATES,
    unsupportedRuleCount: 0,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 0,
    reason,
  });
}

function pseudoSnapshot(
  state: "loading",
  states: readonly PseudoState[],
): PseudoStateSnapshot {
  return Object.freeze({
    state,
    states: canonicalPreviewStates(states),
    unsupportedRuleCount: 0,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 0,
  });
}

function canonicalPreviewStates(
  states: readonly PseudoState[],
): readonly PseudoState[] {
  return Object.freeze([
    ...(states.includes("hover") ? ["hover" as const] : []),
    ...(states.includes("focus") ? ["focus" as const] : []),
  ]);
}

function pseudoStatesFromModelKey(
  source: MatchedStylesModelSnapshot,
): readonly PseudoState[] | undefined {
  const key = source.key;
  return key && "pseudoStates" in key
    ? canonicalPreviewStates(key.pseudoStates)
    : undefined;
}

function stylesMatchPseudoAuthority(
  source: MatchedStylesModelSnapshot,
  tree: ReturnType<DomTreeController["snapshot"]>,
  selectionRevision: number | undefined,
): boolean {
  const styles = source.styles;
  const key = source.key;
  return styles !== undefined &&
    key !== undefined &&
    selectionRevision !== undefined &&
    styles.documentEpoch === tree.documentEpoch &&
    styles.nodeRef === tree.selectedRef &&
    styles.selectionRevision === selectionRevision &&
    key.documentEpoch === styles.documentEpoch &&
    key.nodeRef === styles.nodeRef &&
    key.selectionRevision === styles.selectionRevision;
}

function sameTreeAuthority(
  left: ReturnType<DomTreeController["snapshot"]>,
  right: ReturnType<DomTreeController["snapshot"]>,
): boolean {
  return left.documentEpoch === right.documentEpoch &&
    left.selectedRef === right.selectedRef &&
    left.recovering === right.recovering;
}

function isInteractivePseudoSnapshot(snapshot: PseudoStateSnapshot): boolean {
  return snapshot.state === "ready" || snapshot.state === "partial";
}

function samePseudoSnapshot(
  left: PseudoStateSnapshot,
  right: PseudoStateSnapshot,
): boolean {
  return left.state === right.state &&
    left.reason === right.reason &&
    left.message === right.message &&
    left.unsupportedRuleCount === right.unsupportedRuleCount &&
    left.inaccessibleStylesheetCount === right.inaccessibleStylesheetCount &&
    left.approximateRuleCount === right.approximateRuleCount &&
    left.states.length === right.states.length &&
    left.states.every((state, index) => state === right.states[index]);
}

const EMPTY_RULES_PRESENTATION: RulesPresentationSnapshot = Object.freeze({
  state: "empty",
});
const LOADING_RULES_PRESENTATION: RulesPresentationSnapshot = Object.freeze({
  state: "loading",
});

function projectRulesPresentation(
  source: MatchedStylesModelSnapshot,
): RulesPresentationSnapshot {
  switch (source.state) {
    case "idle":
      return EMPTY_RULES_PRESENTATION;
    case "loading":
      return LOADING_RULES_PRESENTATION;
    case "error":
      return Object.freeze({
        state: "error",
        message: source.errorCode
          ? `Styles unavailable (${source.errorCode})`
          : "Styles unavailable",
        diagnostics: Object.freeze(source.errorCode
          ? [Object.freeze({
            code: source.errorCode,
            severity: "error" as const,
            message: "The selected element's styles could not be inspected",
          })]
          : []),
      });
    case "ready":
    case "partial": {
      if (!source.styles) {
        return Object.freeze({
          state: "error",
          message: "Styles unavailable",
          diagnostics: Object.freeze([]),
        });
      }
      return Object.freeze({
        state: source.state,
        matchedStyles: projectMatchedStylesSnapshot(source.styles),
      });
    }
  }
}

export function projectMatchedStylesSnapshot(
  source: MatchedStyles,
): MatchedStylesSnapshot {
  return Object.freeze({
    documentEpoch: source.documentEpoch,
    selectionRevision: source.selectionRevision,
    stylesRevision: source.stylesRevision,
    stylesheetRevision: source.stylesheetRevision,
    pseudoStateRevision: source.pseudoStateRevision,
    pseudoStates: Object.freeze([...source.pseudoStates]),
    nodeRef: source.nodeRef,
    ...(source.inline ? { inlineStyle: projectMatchedRule(source.inline) } : {}),
    matchedRules: Object.freeze(source.rules.map(projectMatchedRule)),
    inherited: Object.freeze(source.inherited.map((group) => Object.freeze({
      ancestorIndex: group.ancestorIndex,
      displayLabel: group.elementName,
      matchedRules: Object.freeze(group.rules.map(projectMatchedRule)),
    }))),
    inaccessibleStylesheetCount: source.inaccessibleStylesheetCount,
    unsupportedRuleCount: source.unsupportedRuleCount,
    approximateRuleCount: source.approximateRuleCount,
    omittedRuleCount: 0,
    diagnostics: Object.freeze(source.diagnostics.map((message, index) => (
      Object.freeze({
        code: `matched-styles-${index + 1}`,
        severity: "warning" as const,
        message,
      })
    ))),
  });
}

function projectMatchedRule(rule: MatchedRule): MatchedRuleSnapshot {
  const generatedSource = projectGeneratedSource(rule.source);
  return Object.freeze({
    ruleRef: rule.ruleRef,
    selectorText: rule.selectorText,
    matchingSelectorIndices: Object.freeze([...rule.matchingSelectorIndices]),
    declarations: Object.freeze(rule.declarations.map((declaration, index) => (
      projectDeclaration(declaration, index)
    ))),
    contexts: Object.freeze(rule.contexts.map((context) => Object.freeze({
      kind: context.kind,
      text: context.text,
    }))),
    ...(generatedSource ? { generatedSource } : {}),
  });
}

function projectDeclaration(
  declaration: MatchedDeclaration,
  index: number,
): MatchedDeclarationSnapshot {
  const reason = declarationReason(declaration.reason);
  return Object.freeze({
    declarationRef: `${declaration.ruleRef}:${index}`,
    name: declaration.property,
    value: declaration.value,
    important: declaration.important,
    state: declaration.state,
    stateReason: declaration.valueTruncated ? `${reason}; value truncated` : reason,
  });
}

function projectGeneratedSource(
  source: GeneratedMatchedRuleSource | undefined,
): MatchedRuleSnapshot["generatedSource"] | undefined {
  if (!source?.sourceUrl) return undefined;
  let label: string;
  try {
    const url = new URL(source.sourceUrl);
    label = url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
  } catch {
    return undefined;
  }
  return Object.freeze({
    label,
    ...(source.startLine !== undefined ? { lineNumber: source.startLine } : {}),
    ...(source.startColumn !== undefined ? { columnNumber: source.startColumn } : {}),
  });
}

const DECLARATION_REASONS: Readonly<Record<MatchedDeclarationReason, string>> = Object.freeze({
  "highest-precedence-known-author-declaration":
    "Highest known author declaration; unavailable origins may still apply",
  "lower-precedence-author-declaration": "Overridden by another known author declaration",
  "inactive-group-condition": "Declaration is inactive in the current group condition",
  "unsupported-cascade-layer": "Cascade layer precedence is not proven",
  "unsupported-cascade-scope": "Cascade scope precedence is not proven",
  "unsupported-container-query": "Container query applicability is not proven",
  "unsupported-starting-style": "Starting-style applicability is not proven",
  "unsupported-group-context": "Grouping context is unsupported",
  "unknown-group-applicability": "Grouping context applicability is unknown",
  "custom-property-cascade": "Custom property cascade is unknown",
  "variable-dependent-value": "Variable-dependent value precedence is unknown",
  "animation-or-transition-cascade": "Animation or transition precedence is unknown",
  "unsupported-shorthand": "Shorthand precedence is not proven",
  "inherited-author-declaration": "Inherited author declaration",
  "unsupported-selector-specificity": "Selector specificity is not proven",
});

function declarationReason(reason: MatchedDeclarationReason): string {
  return DECLARATION_REASONS[reason];
}

function disconnectedResetReason(
  message: unknown,
): Exclude<MatchedStylesResetReason, "disposal" | "advanced-selection"> |
  undefined {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(message);
    const type = descriptors.type;
    const state = descriptors.state;
    if (
      !type?.enumerable ||
      !Object.hasOwn(type, "value") ||
      type.value !== "pin-op.windowState" ||
      !state?.enumerable ||
      !Object.hasOwn(state, "value")
    ) return undefined;
    return state.value === "incompatible"
      ? "compatibility-failure"
      : undefined;
  } catch {
    return undefined;
  }
}

function rulesWindowState(message: unknown): string | undefined {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(message);
    const type = descriptors.type;
    const state = descriptors.state;
    return type?.enumerable &&
        Object.hasOwn(type, "value") &&
        type.value === "pin-op.windowState" &&
        state?.enumerable &&
        Object.hasOwn(state, "value") &&
        typeof state.value === "string"
      ? state.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isIdeDisconnectedState(message: unknown): boolean {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(message);
    return descriptors.type?.enumerable === true &&
      Object.hasOwn(descriptors.type, "value") &&
      descriptors.type.value === "pin-op.ideState" &&
      descriptors.status?.enumerable === true &&
      Object.hasOwn(descriptors.status, "value") &&
      descriptors.status.value === "ide-disconnected";
  } catch {
    return false;
  }
}

function isDisconnectedPeer(message: unknown): boolean {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(message);
    return descriptors.type?.enumerable === true &&
      Object.hasOwn(descriptors.type, "value") &&
      descriptors.type.value === "peerState" &&
      descriptors.connected?.enumerable === true &&
      Object.hasOwn(descriptors.connected, "value") &&
      descriptors.connected.value === false;
  } catch {
    return false;
  }
}

function isConnectedPeer(message: unknown): boolean {
  try {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(message);
    return descriptors.type?.enumerable === true &&
      Object.hasOwn(descriptors.type, "value") &&
      descriptors.type.value === "peerState" &&
      descriptors.connected?.enumerable === true &&
      Object.hasOwn(descriptors.connected, "value") &&
      descriptors.connected.value === true;
  } catch {
    return false;
  }
}

function noOp(): void {}
