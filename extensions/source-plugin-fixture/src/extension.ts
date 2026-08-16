import * as vscode from "vscode";
import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type SourcePlugin,
} from "@pin-op/plugin-api";

const plugin: SourcePlugin = {
  id: "pin-op.fixture",
  displayName: "Pin-op Fixture",
  apiVersion: SOURCE_PLUGIN_API_VERSION,
  documentSelectors: [
    { languageId: "pin-op-fixture", scheme: "file" },
  ],
  supportedFactKinds: ["fixture.source"],
  async resolve(context) {
    const end = context.document.positionAt(context.document.getText().length);
    return {
      matches: [
        {
          targetRole: "selected",
          range: { start: { line: 0, character: 0 }, end },
          label: "Fixture source",
          kind: "fixture",
          relation: "defines",
          confidence: "instrumented",
        },
      ],
    };
  },
};

export async function activate(context: vscode.ExtensionContext): Promise<{
  readonly registered: boolean;
  readonly coreApiVersion: number;
}> {
  const core = vscode.extensions.getExtension<PinOpApi>(
    "conus-vision.pin-op",
  );
  if (!core) throw new Error("Pin-op core extension is unavailable");

  const api = await core.activate();
  if (api.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported Pin-op API version: ${api.apiVersion}`);
  }
  context.subscriptions.push(api.registerSourcePlugin(plugin));
  return { registered: true, coreApiVersion: api.apiVersion };
}
