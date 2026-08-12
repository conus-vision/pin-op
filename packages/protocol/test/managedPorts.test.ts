import { describe, expect, it } from "vitest";
import {
  MANAGED_BRIDGE_PORT_COUNT,
  MANAGED_BRIDGE_PORT_END,
  MANAGED_BRIDGE_PORT_START,
  isManagedBridgePort,
} from "../src/index.js";

describe("managed bridge ports", () => {
  it("exports the one hundred ports owned by PinOp", () => {
    expect(MANAGED_BRIDGE_PORT_START).toBe(48_735);
    expect(MANAGED_BRIDGE_PORT_COUNT).toBe(100);
    expect(MANAGED_BRIDGE_PORT_END).toBe(48_834);
  });

  it.each([
    [48_734, false],
    [48_735, true],
    [48_834, true],
    [48_835, false],
    [48_735.5, false],
    [Number.NaN, false],
  ])("classifies %s as managed=%s", (port, expected) => {
    expect(isManagedBridgePort(port)).toBe(expected);
  });
});
