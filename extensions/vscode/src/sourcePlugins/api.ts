import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type SourcePlugin,
} from "@pinop/plugin-api";
import type { SourcePluginRegistry } from "./registry.js";

export function createPinOpApi(
  registry: SourcePluginRegistry,
): PinOpApi {
  return Object.freeze({
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    registerSourcePlugin: (plugin: SourcePlugin) => registry.register(plugin),
  });
}
