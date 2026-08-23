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
  dispose(): void;
}

export function startInspectorPanelRuntime(
  options: InspectorPanelRuntimeOptions,
): InspectorPanelRuntime {
  const runtime = startPanelRuntimeWithPresentation(
    options,
    createInspectorPresentation,
  );
  return Object.freeze({
    ready: runtime.ready,
    closed: runtime.closed,
    settingsController: runtime.settingsController,
    dispose: () => runtime.dispose(),
  });
}

function createInspectorPresentation(
  options: PanelRuntimeOptions,
  reportError: (error: unknown) => void,
): PanelRuntimePresentation {
  const view = new InspectorPanelView(
    options.document as InspectorPanelDocument,
    reportError,
  );
  return {
    view,
    attach(context) {
      const adapter = new ElementsInspectorAdapter(context.treeController);
      let removeSettingsBindings: (() => void) | undefined;
      try {
        view.mountTree(adapter);
        removeSettingsBindings = view.bindSettings(
          context.settingsController,
        );
      } catch (error) {
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
          view.dispose();
        },
      };
    },
  };
}

const NO_VISIBLE_SOURCE_PANE = Object.freeze({
  setState: noOp,
});

function noOp(): void {}
