import { describe, expect, it, vi } from "vitest";

const lucide = vi.hoisted(() => ({
  ClipboardPaste: { name: "ClipboardPaste" },
  MousePointer2: { name: "MousePointer2" },
  RefreshCw: { name: "RefreshCw" },
  createIcons: vi.fn(),
}));

vi.mock("lucide", () => lucide);

import { createPanelIcons } from "../src/panelController.js";

describe("createPanelIcons", () => {
  it("registers every icon rendered by the shared panel assets", () => {
    createPanelIcons();

    expect(lucide.createIcons).toHaveBeenCalledOnce();
    expect(lucide.createIcons).toHaveBeenCalledWith({
      icons: {
        ClipboardPaste: lucide.ClipboardPaste,
        MousePointer2: lucide.MousePointer2,
        RefreshCw: lucide.RefreshCw,
      },
      attrs: {
        width: "15",
        height: "15",
        "aria-hidden": "true",
      },
    });
  });
});
