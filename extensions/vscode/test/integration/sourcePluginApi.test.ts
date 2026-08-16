import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Pin-op external source plugin API", () => {
  test("activates the fixture through the public core API", async () => {
    const fixture = vscode.extensions.getExtension<{
      readonly registered: boolean;
      readonly coreApiVersion: number;
    }>("conus-vision.pin-op-source-plugin-fixture");

    assert.ok(
      fixture,
      "fixture extension must be loaded as a development extension",
    );
    const exported = await fixture.activate();
    assert.equal(exported.registered, true);
    assert.equal(exported.coreApiVersion, 1);
  });
});
