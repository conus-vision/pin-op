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
  type MatchedStylesResetReason,
} from "./matchedStylesModel.js";
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
    attach(context) {
      const matchedStylesModel = new MatchedStylesModel({
        request: context.requestStyles,
      });
      presentationState.matchedStylesModel = matchedStylesModel;
      const removeInspectorMessages = context.subscribeInspectorMessages(
        (message) => routeMatchedStylesLifecycle(matchedStylesModel, message),
      );
      const adapter = new ElementsInspectorAdapter(context.treeController);
      let removeSettingsBindings: (() => void) | undefined;
      try {
        view.mountTree(adapter);
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

function routeMatchedStylesLifecycle(
  model: MatchedStylesModel,
  message: unknown,
): void {
  try {
    const event = parseStylesEvent(message);
    if (event.type === "styles.invalidated") model.invalidate(event);
    return;
  } catch {
    // Continue through exact lifecycle families.
  }
  try {
    const event = parseDomEvent(message);
    if (
      event.type === "dom.selectionChanged" ||
      event.type === "dom.selectionCleared"
    ) model.reset("advanced-selection");
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
      : state.value === "notLinked" || state.value === "error"
      ? "content-lease-replaced"
      : undefined;
  } catch {
    return undefined;
  }
}

const NO_VISIBLE_SOURCE_PANE = Object.freeze({
  setState: noOp,
});

function noOp(): void {}
