import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type RefreshClassifier,
  type SourcePlugin,
} from "@pin-op/plugin-api";
import type { RefreshClassifierRegistry } from "../refresh/refreshClassifierRegistry.js";
import type { SourcePluginRegistry } from "./registry.js";

export function createPinOpApi(
  sourcePluginRegistry: SourcePluginRegistry,
  refreshClassifierRegistry: RefreshClassifierRegistry,
): PinOpApi {
  return Object.freeze({
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    registerSourcePlugin: (plugin: SourcePlugin) =>
      sourcePluginRegistry.register(plugin),
    registerRefreshClassifier: (classifier: RefreshClassifier) =>
      refreshClassifierRegistry.register(classifier),
  });
}
