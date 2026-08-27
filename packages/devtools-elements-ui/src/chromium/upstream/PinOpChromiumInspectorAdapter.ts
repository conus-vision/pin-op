import type {
  CreateElementsInspectorView,
  CreateElementsTreeRenderer,
} from "../../contracts.js";
import { ElementsInspectorShell } from "../../elementsInspectorShell.js";
import {
  createPinOpElementsTreeAdapter,
  type ChromiumElementsRuntime,
} from "./PinOpElementsTreeAdapter.js";
import {
  createPinOpStylesRulesRenderer,
  type ChromiumReadOnlyStylesRuntime,
} from "./PinOpStylesSidebarAdapter.js";

export interface PinOpChromiumInspectorRuntime extends
  ChromiumElementsRuntime,
  ChromiumReadOnlyStylesRuntime {}

export interface PinOpChromiumInspectorAdapterOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Composes Pin-op's neutral Inspector shell with the pinned Chromium DOM and
 * Styles renderers. Browser builds provide the concrete, versioned runtime;
 * this package keeps all page and IDE authority behind the neutral sources.
 */
export function createPinOpChromiumInspectorViewFactory(
  runtime: PinOpChromiumInspectorRuntime,
  options: PinOpChromiumInspectorAdapterOptions = {},
): CreateElementsInspectorView {
  const onError = options.onError;
  const createTreeRenderer: CreateElementsTreeRenderer = (
    _document,
    mount,
    treeDataSource,
  ) => createPinOpElementsTreeAdapter(runtime, mount, treeDataSource, {
    onError,
  });
  const createRulesRenderer = createPinOpStylesRulesRenderer(runtime, {
    onError,
  });

  return (document, mount, treeDataSource) => new ElementsInspectorShell(
    document,
    mount,
    treeDataSource,
    undefined,
    undefined,
    undefined,
    createTreeRenderer,
    createRulesRenderer,
  );
}
