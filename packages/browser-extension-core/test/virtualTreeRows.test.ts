import { describe, expect, it } from "vitest";
import { virtualTreeRows } from "../src/virtualTreeRows.js";

describe("virtualTreeRows", () => {
  it("materializes only the viewport and overscan rows", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ index }));

    const visible = virtualTreeRows(rows, {
      start: 500,
      size: 20,
      overscan: 5,
    });

    expect(visible).toHaveLength(30);
    expect(visible[0]).toMatchObject({ index: 495, value: { index: 495 } });
    expect(visible.at(-1)).toMatchObject({ index: 524, value: { index: 524 } });
  });

  it("clamps the window at both collection edges", () => {
    const rows = ["a", "b", "c", "d"];

    expect(virtualTreeRows(rows, { start: 0, size: 2, overscan: 3 }))
      .toEqual([
        { index: 0, value: "a" },
        { index: 1, value: "b" },
        { index: 2, value: "c" },
        { index: 3, value: "d" },
      ]);
    expect(virtualTreeRows(rows, { start: 99, size: 5, overscan: 2 }))
      .toEqual([]);
  });

  it("rejects non-integer and negative viewport values", () => {
    expect(() => virtualTreeRows([], { start: -1, size: 1, overscan: 0 }))
      .toThrow("Invalid virtual tree viewport");
    expect(() => virtualTreeRows([], { start: 0, size: 1.5, overscan: 0 }))
      .toThrow("Invalid virtual tree viewport");
  });
});
