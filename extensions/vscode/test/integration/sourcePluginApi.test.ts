import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Pin-op external source plugin API", () => {
  test("activates the fixture through the public core API", async () => {
    assert.equal(
      vscode.workspace.workspaceFolders?.[0]?.name,
      "basic-css",
      "the integration harness must open its configured workspace",
    );
    const fixture = vscode.extensions.getExtension<{
      readonly sourcePluginRegistered: boolean;
      readonly refreshClassifierRegistered: boolean;
      readonly coreApiVersion: number;
    }>("conus-vision.pin-op-source-plugin-fixture");

    assert.ok(
      fixture,
      "fixture extension must be loaded as a development extension",
    );
    const exported = await fixture.activate();
    assert.equal(exported.sourcePluginRegistered, true);
    assert.equal(exported.refreshClassifierRegistered, true);
    assert.equal(exported.coreApiVersion, 3);
    assert.equal(
      vscode.extensions.getExtension("conus-vision.pin-op")?.isActive,
      true,
      "the fixture must share the activated production Pin-op runtime",
    );
  });
});
