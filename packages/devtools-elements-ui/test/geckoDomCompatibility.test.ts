import { describe, expect, it } from "vitest";

import {
  installGeckoDomCompatibility,
} from "../src/chromium/upstream/GeckoDomCompatibility.js";

describe("installGeckoDomCompatibility", () => {
  it("gives Gecko's shadow roots the selection accessor Chromium expects", () => {
    const selection = { type: "Range" };
    const document = { getSelection: () => selection };
    class ShadowRoot {
      public readonly ownerDocument = document;
    }
    const scope = { ShadowRoot } as unknown as typeof globalThis;

    expect(installGeckoDomCompatibility(scope)).toBe(true);

    const root = new ShadowRoot() as unknown as {
      getSelection(): unknown;
    };
    expect(root.getSelection()).toBe(selection);
  });

  it("answers null when the shadow root has no document to ask", () => {
    class ShadowRoot {
      public readonly ownerDocument = undefined;
    }
    const scope = { ShadowRoot } as unknown as typeof globalThis;
    installGeckoDomCompatibility(scope);

    const root = new ShadowRoot() as unknown as { getSelection(): unknown };
    expect(root.getSelection()).toBeNull();
  });

  it("leaves Blink's own accessor alone", () => {
    const native = () => "native";
    class ShadowRoot {
      public getSelection = native;
    }
    ShadowRoot.prototype.getSelection = native;
    const scope = { ShadowRoot } as unknown as typeof globalThis;

    expect(installGeckoDomCompatibility(scope)).toBe(false);
    expect(ShadowRoot.prototype.getSelection).toBe(native);
  });

  it("stays inert where there is no shadow DOM at all", () => {
    expect(installGeckoDomCompatibility({} as typeof globalThis)).toBe(false);
  });
});
