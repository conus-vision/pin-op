import { ElementsTreeOutline } from "./chromium/dom/ElementsTreeOutline.js";
import { StylesSidebarPane } from "./chromium/rules/StylesSidebarPane.js";
import type {
  CreateElementsRulesRenderer,
  CreateElementsTreeRenderer,
  PseudoStateDataSource,
  RulesDataSource,
  SourceLinkDelegate,
  TreeDataSource,
} from "./contracts.js";
import { ElementsInspectorShell } from "./elementsInspectorShell.js";

/**
 * Backwards-compatible Inspector with Pin-op's local fallback renderers.
 * Production Chromium builds import ElementsInspectorShell directly so these
 * fallback modules cannot enter the native DevTools runtime closure.
 */
export class ElementsInspectorView extends ElementsInspectorShell {
  public constructor(
    document: Document,
    mount: HTMLElement,
    treeDataSource: TreeDataSource,
    rulesDataSource?: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
    pseudoStateDataSource?: PseudoStateDataSource,
    createTreeRenderer: CreateElementsTreeRenderer = createLocalTreeRenderer,
    createRulesRenderer: CreateElementsRulesRenderer = createLocalRulesRenderer,
  ) {
    super(
      document,
      mount,
      treeDataSource,
      rulesDataSource,
      sourceLinkDelegate,
      pseudoStateDataSource,
      createTreeRenderer,
      createRulesRenderer,
    );
  }
}

const createLocalTreeRenderer: CreateElementsTreeRenderer = (
  document,
  mount,
  treeDataSource,
) => new ElementsTreeOutline(document, mount, treeDataSource);

const createLocalRulesRenderer: CreateElementsRulesRenderer = (
  document,
  mount,
  dataSource,
  sourceLinkDelegate,
  pseudoStateDataSource,
) => {
  const pane = new StylesSidebarPane(
    document,
    dataSource,
    sourceLinkDelegate,
    pseudoStateDataSource,
  );
  try {
    mount.append(pane.element);
    return pane;
  } catch (error) {
    let cleanupError: unknown;
    try {
      pane.dispose();
    } catch (caught) {
      cleanupError = caught;
    } finally {
      pane.element.remove();
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        "Rules mount and teardown failed",
      );
    }
    throw error;
  }
};
