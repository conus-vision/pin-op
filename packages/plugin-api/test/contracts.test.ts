import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type SourcePlugin,
} from "../src/index.js";

describe("source plugin public contract", () => {
  it("exports API version 1 and accepts a structurally valid plugin", () => {
    const plugin: SourcePlugin = {
      id: "fixture.source",
      displayName: "Fixture Source",
      apiVersion: SOURCE_PLUGIN_API_VERSION,
      documentSelectors: [{ languageId: "fixture", scheme: "file" }],
      supportedFactKinds: ["fixture.source"],
      async resolve() {
        return { matches: [] };
      },
    };
    expect(SOURCE_PLUGIN_API_VERSION).toBe(1);
    expect(plugin.id).toBe("fixture.source");
    expectTypeOf<PinOpApi["registerSourcePlugin"]>().toBeFunction();
  });
});
