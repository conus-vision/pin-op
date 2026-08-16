import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type Disposable,
  type PinOpApi,
  type RefreshClassifier,
  type RefreshClassifierInput,
  type RefreshMode,
  type SourcePlugin,
} from "../src/index.js";

describe("source plugin public contract", () => {
  it("exports API version 2 and accepts structurally valid extensions", () => {
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
    const classifier: RefreshClassifier = {
      id: "fixture.refresh",
      classify(input: RefreshClassifierInput): RefreshMode | undefined {
        return input.languageId === "fixture" ? "reload" : undefined;
      },
    };

    expect(SOURCE_PLUGIN_API_VERSION).toBe(2);
    expect(plugin.id).toBe("fixture.source");
    expect(classifier.classify({
      uri: "file:///workspace/example.fixture",
      languageId: "fixture",
    })).toBe("reload");
    expectTypeOf<PinOpApi["registerSourcePlugin"]>().toBeFunction();
    expectTypeOf<PinOpApi["registerRefreshClassifier"]>().toBeFunction();
    expectTypeOf<
      ReturnType<PinOpApi["registerRefreshClassifier"]>
    >().toEqualTypeOf<Disposable>();
  });
});
