import type { CreateElementsInspectorView } from "./contracts.js";

/**
 * Placeholder for the browser bundle's native Chromium Inspector factory. The
 * reviewed browser build replaces this module with the pinned Chromium runtime
 * entry, so Pin-op ships no second Inspector implementation of its own.
 */
export const createElementsInspectorView: CreateElementsInspectorView = () => {
  throw new Error("Native Chromium Inspector runtime is not linked");
};
