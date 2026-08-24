import { describe, expect, it } from "vitest";
import {
  classifyCascade,
  type CascadeCandidate,
} from "../src/cascadeClassifier.js";

describe("classifyCascade", () => {
  it("proves only a known lower-precedence author declaration is overridden", () => {
    const winner = candidate({ sourceOrder: 2, specificity: [0, 1, 0] });
    const simpleLowerSpecificity = candidate({
      sourceOrder: 1,
      specificity: [0, 0, 1],
    });

    expect(classifyCascade(simpleLowerSpecificity, [simpleLowerSpecificity, winner]))
      .toEqual({
        state: "overridden-known-author",
        reason: "lower-precedence-author-declaration",
      });
    expect(classifyCascade(winner, [simpleLowerSpecificity, winner])).toEqual({
      state: "winning-known-author",
      reason: "highest-precedence-known-author-declaration",
    });
  });

  it("orders importance before specificity and specificity before source order", () => {
    const normalId = candidate({ specificity: [1, 0, 0], sourceOrder: 9 });
    const importantType = candidate({
      important: true,
      specificity: [0, 0, 1],
      sourceOrder: 1,
    });
    expect(classifyCascade(normalId, [normalId, importantType]).state)
      .toBe("overridden-known-author");
    expect(classifyCascade(importantType, [normalId, importantType]).state)
      .toBe("winning-known-author");

    const earlyClass = candidate({ specificity: [0, 1, 0], sourceOrder: 2 });
    const lateClass = candidate({ specificity: [0, 1, 0], sourceOrder: 3 });
    expect(classifyCascade(earlyClass, [earlyClass, lateClass]).state)
      .toBe("overridden-known-author");
  });

  it("reports inactive media/supports conditions without making cascade claims", () => {
    const inactive = candidate({ active: false });
    expect(classifyCascade(inactive, [inactive])).toEqual({
      state: "inactive",
      reason: "inactive-group-condition",
    });
  });

  it.each([
    ["layer", "unsupported-cascade-layer"],
    ["scope", "unsupported-cascade-scope"],
    ["container", "unsupported-container-query"],
    ["starting-style", "unsupported-starting-style"],
    ["unknown", "unsupported-group-context"],
  ] as const)("keeps %s contexts unknown", (kind, reason) => {
    const insideUnknownLayer = candidate({ contexts: [{ kind, text: "x" }] });
    expect(classifyCascade(insideUnknownLayer, [insideUnknownLayer])).toEqual({
      state: "unknown",
      reason,
    });
  });

  it.each([
    [candidate({ property: "--theme" }), "custom-property-cascade"],
    [candidate({ property: "margin" }), "unsupported-shorthand"],
    [candidate({ inherited: true }), "inherited-author-declaration"],
    [candidate({ specificity: undefined }), "unsupported-selector-specificity"],
    [candidate({ active: undefined }), "unknown-group-applicability"],
  ] as const)("keeps unsafe cases unknown", (unsafe, reason) => {
    expect(classifyCascade(unsafe, [unsafe])).toEqual({
      state: "unknown",
      reason,
    });
  });

  it("does not use computed style or unrelated declarations as loser evidence", () => {
    const onlyKnown = candidate({ value: "red" });
    const unrelated = candidate({ property: "background-color", value: "blue" });
    expect(classifyCascade(onlyKnown, [onlyKnown, unrelated])).toEqual({
      state: "winning-known-author",
      reason: "highest-precedence-known-author-declaration",
    });
  });

  it("keeps variables and declarations exposed to shorthand/animation effects unknown", () => {
    const variable = candidate({ value: "var(--theme)" });
    expect(classifyCascade(variable, [variable])).toEqual({
      state: "unknown",
      reason: "variable-dependent-value",
    });

    const color = candidate({ property: "margin-left" });
    const shorthand = candidate({ property: "margin" });
    expect(classifyCascade(color, [color, shorthand])).toEqual({
      state: "unknown",
      reason: "unsupported-shorthand",
    });

    const animation = candidate({ property: "animation-name" });
    expect(classifyCascade(color, [color, animation])).toEqual({
      state: "unknown",
      reason: "animation-or-transition-cascade",
    });
  });
});

function candidate(
  overrides: Partial<CascadeCandidate> = {},
): CascadeCandidate {
  return {
    property: "color",
    value: "red",
    important: false,
    specificity: [0, 1, 0],
    sourceOrder: 1,
    contexts: [],
    active: true,
    inherited: false,
    ...overrides,
  };
}
