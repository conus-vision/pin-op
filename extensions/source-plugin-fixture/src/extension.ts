import * as vscode from "vscode";
import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type SourcePlugin,
} from "@pinop/plugin-api";

const plugin: SourcePlugin = {
  id: "pinop.fixture",
  displayName: "PinOp Fixture",
  apiVersion: SOURCE_PLUGIN_API_VERSION,
  documentSelectors: [
    { languageId: "pinop-fixture", scheme: "file" },
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
    "conus-vision.pinop",
  );
  if (!core) throw new Error("PinOp core extension is unavailable");

  const api = await core.activate();
  if (api.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported PinOp API version: ${api.apiVersion}`);
  }
  context.subscriptions.push(api.registerSourcePlugin(plugin));
  return { registered: true, coreApiVersion: api.apiVersion };
}
