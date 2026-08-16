import { describe, expect, it, vi } from "vitest";
import type {
  RefreshClassifier,
  SourcePlugin,
} from "@pin-op/plugin-api";
import { RefreshClassifierRegistry } from "../src/refresh/refreshClassifierRegistry.js";
import { createPinOpApi } from "../src/sourcePlugins/api.js";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";

describe("refresh classifier registry", () => {
  it.each(["css", "scss", "sass", "less"])(
    "classifies .%s as styles",
    (extension) => {
      const registry = new RefreshClassifierRegistry();

      expect(registry.classify(input(`file:///workspace/app.${extension}`)))
        .toBe("styles");
      expect(registry.classify(input(
        `file:///workspace/app.${extension.toUpperCase()}`,
      ))).toBe("styles");
    },
  );

  it.each(["js", "mjs", "cjs", "jsx", "ts", "tsx", "php"])(
    "classifies .%s as reload",
    (extension) => {
      const registry = new RefreshClassifierRegistry();

      expect(registry.classify(input(`file:///workspace/app.${extension}`)))
        .toBe("reload");
      expect(registry.classify(input(
        `file:///workspace/app.${extension.toUpperCase()}`,
      ))).toBe("reload");
    },
  );

  it("classifies the parsed pathname without query or fragment text", () => {
    const registry = new RefreshClassifierRegistry();

    expect(registry.classify(input(
      "https://example.test/assets/app.css?source=app.ts#view.php",
    ))).toBe("styles");
    expect(registry.classify(input(
      "file:///workspace/app.ts?source=app.css#view.scss",
    ))).toBe("reload");
  });

  it.each([
    "not a canonical uri.css",
    "file:///workspace/app.vue",
    "file:///workspace/app.css.txt",
    "file:///workspace/no-extension",
  ])("ignores %s", (uri) => {
    expect(new RefreshClassifierRegistry().classify(input(uri))).toBeUndefined();
  });

  it("gives classifiers only frozen URI and language values", () => {
    let received: object | undefined;
    const registry = new RefreshClassifierRegistry();
    registry.register({
      id: "fixture.immutable",
      classify(value) {
        received = value;
        return undefined;
      },
    });

    registry.classify({
      uri: "file:///workspace/app.fixture",
      languageId: "fixture",
      sourceText: "private source",
    } as Parameters<RefreshClassifierRegistry["classify"]>[0]);

    expect(received).toEqual({
      uri: "file:///workspace/app.fixture",
      languageId: "fixture",
    });
    expect(Object.isFrozen(received)).toBe(true);
  });

  it.each(["styles", "reload"] as const)(
    "returns a custom %s classification",
    (mode) => {
      const registry = new RefreshClassifierRegistry();
      registry.register({
        id: `fixture.${mode}`,
        classify: () => mode,
      });

      expect(registry.classify(input("file:///workspace/app.fixture")))
        .toBe(mode);
    },
  );

  it("aggregates custom results with reload precedence in either order", () => {
    for (const modes of [
      ["styles", "reload"],
      ["reload", "styles"],
    ] as const) {
      const registry = new RefreshClassifierRegistry();
      modes.forEach((mode, index) => registry.register({
        id: `fixture.${index}`,
        classify: () => mode,
      }));

      expect(registry.classify(input("file:///workspace/app.fixture")))
        .toBe("reload");
    }
  });

  it("combines built-in and custom results with the same precedence", () => {
    const registry = new RefreshClassifierRegistry();
    registry.register({
      id: "fixture.reload",
      classify: () => "reload",
    });

    expect(registry.classify(input("file:///workspace/app.css")))
      .toBe("reload");
  });

  it("rejects duplicate IDs and disposal is idempotent", () => {
    const registry = new RefreshClassifierRegistry();
    const registration = registry.register({
      id: "fixture.styles",
      classify: () => "styles",
    });

    expect(() => registry.register({
      id: "fixture.styles",
      classify: () => "reload",
    })).toThrow(/already registered/);

    registration.dispose();
    expect(registry.classify(input("file:///workspace/app.fixture")))
      .toBeUndefined();
    expect(registry.classify(input("file:///workspace/app.css")))
      .toBe("styles");
    registry.register({
      id: "fixture.styles",
      classify: () => "reload",
    });
    registration.dispose();
    expect(registry.classify(input("file:///workspace/app.fixture")))
      .toBe("reload");
  });

  it("isolates throwing classifiers and reports only their ID and error", () => {
    const error = new Error("classification failed");
    const reports: unknown[] = [];
    const registry = new RefreshClassifierRegistry({
      onError: (report) => reports.push(report),
    });
    registry.register({
      id: "fixture.throwing",
      classify: () => {
        throw error;
      },
    });
    registry.register({
      id: "fixture.reload",
      classify: () => "reload",
    });
    const privateUri = "file:///private/customer/project/app.css";

    expect(registry.classify(input(privateUri))).toBe("reload");
    expect(reports).toEqual([{
      classifierId: "fixture.throwing",
      error,
    }]);
    expect(JSON.stringify(reports)).not.toContain(privateUri);
  });

  it("ignores an error sink failure and continues classification", () => {
    const registry = new RefreshClassifierRegistry({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    registry.register({
      id: "fixture.throwing",
      classify: () => {
        throw new Error("classifier failed");
      },
    });

    expect(registry.classify(input("file:///workspace/app.ts"))).toBe("reload");
  });

  it("bounds external registrations", () => {
    const registry = new RefreshClassifierRegistry();
    for (let index = 0; index < 64; index += 1) {
      registry.register({
        id: `fixture.${index}`,
        classify: () => undefined,
      });
    }

    expect(() => registry.register({
      id: "fixture.overflow",
      classify: () => undefined,
    })).toThrow(/at most 64/i);
  });
});

describe("Pin-op API", () => {
  it("delegates source plugin and refresh classifier registration", () => {
    const sourceRegistry = new SourcePluginRegistry();
    const refreshRegistry = new RefreshClassifierRegistry();
    const sourceRegistration = { dispose: vi.fn() };
    const refreshRegistration = { dispose: vi.fn() };
    const sourceRegister = vi.spyOn(sourceRegistry, "register")
      .mockReturnValue(sourceRegistration);
    const refreshRegister = vi.spyOn(refreshRegistry, "register")
      .mockReturnValue(refreshRegistration);
    const plugin = { id: "fixture.source" } as SourcePlugin;
    const classifier: RefreshClassifier = {
      id: "fixture.refresh",
      classify: () => undefined,
    };
    const api = createPinOpApi(sourceRegistry, refreshRegistry);

    expect(api.registerSourcePlugin(plugin)).toBe(sourceRegistration);
    expect(api.registerRefreshClassifier(classifier)).toBe(refreshRegistration);
    expect(sourceRegister).toHaveBeenCalledWith(plugin);
    expect(refreshRegister).toHaveBeenCalledWith(classifier);
  });
});

function input(uri: string) {
  return { uri, languageId: "fixture" };
}
