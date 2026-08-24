import type {
  MatchedDeclarationSnapshot,
  MatchedRuleSnapshot,
  MatchedStylesSnapshot,
  RulesDataSource,
  RulesPresentationSnapshot,
} from "@pin-op/devtools-elements-ui";
import type { DomTreeDocument } from "./domTreeView.js";
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
  parseInspectPortInvalidated,
  parseProtocolCompatibilityMessage,
} from "./inspectPortProtocol.js";
import { parseStylesEvent } from "./stylesProtocol.js";

export interface InspectorPanelRuntimeOptions extends Omit<
  PanelRuntimeOptions,
  "createResizeObserver" | "document" | "layoutStorage"
> {
  readonly document: InspectorPanelDocument & DomTreeDocument;
}

export interface InspectorPanelRuntime {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly settingsController: PanelSettingsController;
  readonly matchedStylesModel: MatchedStylesModel;
  dispose(): void;
}

export function startInspectorPanelRuntime(
  options: InspectorPanelRuntimeOptions,
): InspectorPanelRuntime {
  const presentationState: { matchedStylesModel?: MatchedStylesModel } = {};
  const runtime = startPanelRuntimeWithPresentation(
    options,
    (runtimeOptions, reportError) => createInspectorPresentation(
      runtimeOptions,
      reportError,
      presentationState,
    ),
  );
  const matchedStylesModel = presentationState.matchedStylesModel;
  if (!matchedStylesModel) {
    runtime.dispose();
    throw new Error("Matched styles model failed to initialize");
  }
  return Object.freeze({
    ready: runtime.ready,
    closed: runtime.closed,
    settingsController: runtime.settingsController,
    matchedStylesModel,
    dispose: () => runtime.dispose(),
  });
}

function createInspectorPresentation(
  options: PanelRuntimeOptions,
  reportError: (error: unknown) => void,
  presentationState: { matchedStylesModel?: MatchedStylesModel },
): PanelRuntimePresentation {
  const view = new InspectorPanelView(
    options.document as InspectorPanelDocument,
    reportError,
  );
  return {
    view,
    browserLocalInspection: true,
    attach(context) {
      const matchedStylesModel = new MatchedStylesModel({
        request: context.requestStyles,
      });
      presentationState.matchedStylesModel = matchedStylesModel;
      const removeInspectorMessages = context.subscribeInspectorMessages(
        (message) => routeMatchedStylesLifecycle(matchedStylesModel, message),
      );
      const adapter = new ElementsInspectorAdapter(context.treeController);
      const rulesAdapter = new MatchedStylesRulesAdapter(matchedStylesModel);
      let removeSettingsBindings: (() => void) | undefined;
      try {
        view.mountTree(adapter).bindRulesDataSource(rulesAdapter);
        view.bindStylesRefresh(matchedStylesModel);
        removeSettingsBindings = view.bindSettings(
          context.settingsController,
        );
      } catch (error) {
        removeInspectorMessages();
        matchedStylesModel.dispose();
        view.dispose();
        throw error;
      }
      let disposed = false;
      return {
        sourcePaneView: NO_VISIBLE_SOURCE_PANE,
        removeSettingsBindings,
        removeSourceNavigationBindings: noOp,
        removeLayoutBindings: noOp,
        contentLeaseReplaced() {
          matchedStylesModel.reset("content-lease-replaced");
        },
        disposePresentation() {
          if (disposed) return;
          disposed = true;
          removeInspectorMessages();
          matchedStylesModel.dispose();
          view.dispose();
        },
      };
    },
  };
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

class MatchedStylesRulesAdapter implements RulesDataSource {
  private sourceSnapshot: MatchedStylesModelSnapshot | undefined;
  private presentationSnapshot: RulesPresentationSnapshot = EMPTY_RULES_PRESENTATION;

  public constructor(private readonly model: MatchedStylesModel) {}

  public snapshot(): RulesPresentationSnapshot {
    const source = this.model.snapshot();
    if (source !== this.sourceSnapshot) {
      this.sourceSnapshot = source;
      this.presentationSnapshot = projectRulesPresentation(source);
    }
    return this.presentationSnapshot;
  }

  public subscribe(listener: () => void): () => void {
    return this.model.subscribe(() => listener());
  }

  public filter(_query: string): void {
    // Filtering is presentation-local and never changes browser authority.
  }
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
        matchedStyles: projectMatchedStyles(source.styles),
      });
    }
  }
}

function projectMatchedStyles(source: MatchedStyles): MatchedStylesSnapshot {
  return Object.freeze({
    documentEpoch: source.documentEpoch,
    selectionRevision: source.selectionRevision,
    stylesRevision: source.stylesRevision,
    stylesheetRevision: source.stylesheetRevision,
    nodeRef: source.nodeRef,
    ...(source.inline ? { inlineStyle: projectMatchedRule(source.inline) } : {}),
    matchedRules: Object.freeze(source.rules.map(projectMatchedRule)),
    inherited: Object.freeze(source.inherited.map((group) => Object.freeze({
      nodeRef: group.elementName,
      matchedRules: Object.freeze(group.rules.map(projectMatchedRule)),
    }))),
    inaccessibleStylesheetCount: source.inaccessibleStylesheetCount,
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

const NO_VISIBLE_SOURCE_PANE = Object.freeze({
  setState: noOp,
});

function noOp(): void {}
