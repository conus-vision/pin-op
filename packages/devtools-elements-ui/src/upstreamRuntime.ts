import { ElementsInspectorView } from "./elementsInspectorView.js";
import type { CreateElementsInspectorView } from "./contracts.js";

export const createElementsInspectorView: CreateElementsInspectorView = (
  document,
  mount,
  treeDataSource,
) => new ElementsInspectorView(document, mount, treeDataSource);
