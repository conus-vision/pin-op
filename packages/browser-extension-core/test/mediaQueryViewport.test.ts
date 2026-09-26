import { describe, expect, it } from "vitest";
import {
  resizeTabViewport,
  viewportForMediaCondition,
  type ViewportResizeApi,
} from "../src/mediaQueryViewport.js";

describe("viewportForMediaCondition", () => {
  it.each([
    ["(max-width: 600px)", { width: 600 }],
    ["screen and (min-width: 768px)", { width: 768 }],
    ["(min-width: 768px) and (max-width: 1023.98px)", { width: 1023 }],
    ["(width <= 600px)", { width: 600 }],
    ["(width < 600px)", { width: 599 }],
    ["(width > 768px)", { width: 769 }],
    ["(600px < width)", { width: 601 }],
    ["(400px <= width <= 700px)", { width: 700 }],
    ["(max-width: 40em)", { width: 640 }],
    ["(max-width: 37.5rem)", { width: 600 }],
    ["(max-height: 500px)", { height: 500 }],
    ["(max-width: 600px) and (min-height: 400px)", { width: 600, height: 400 }],
    ["(max-width: 600px), print", { width: 600 }],
  ])("reads %s", (condition, expected) => {
    expect(viewportForMediaCondition(condition)).toEqual(expected);
  });

  it.each([
    "print",
    "(prefers-color-scheme: dark)",
    "not all and (max-width: 600px)",
    "(min-width: 900px) and (max-width: 600px)",
    "(max-width: 50vw)",
    "(max-width: 600)",
  ])("has no viewport for %s", (condition) => {
    expect(viewportForMediaCondition(condition)).toBeUndefined();
  });

  it("clamps to a usable window", () => {
    expect(viewportForMediaCondition("(max-width: 10px)")).toEqual({ width: 100 });
    expect(viewportForMediaCondition("(min-width: 100000px)")).toEqual({ width: 16_384 });
  });
});

describe("resizeTabViewport", () => {
  function fakeBrowser(options: {
    chromeWidth: number;
    zoom?: number;
    state?: string;
    maxWindowWidth?: number;
  }) {
    const zoom = options.zoom ?? 1;
    const window = { width: 1400, height: 900, state: options.state ?? "normal" };
    const updates: unknown[] = [];
    const api: ViewportResizeApi = {
      measureViewport: async () => ({
        width: Math.round((window.width - options.chromeWidth) / zoom),
        height: Math.round((window.height - 80) / zoom),
      }),
      getWindow: async () => ({ ...window }),
      updateWindow: async (_id, update) => {
        updates.push(update);
        if (update.state) window.state = update.state;
        if (update.width !== undefined) {
          window.width = Math.min(options.maxWindowWidth ?? Infinity, update.width);
        }
        if (update.height !== undefined) window.height = update.height;
      },
    };
    return { api, window, updates };
  }

  it("sizes the viewport, not the window", async () => {
    const browser = fakeBrowser({ chromeWidth: 16 });

    await expect(resizeTabViewport(browser.api, 1, 2, { width: 600 }))
      .resolves.toBe(true);
    expect(browser.window.width).toBe(616);
    expect(browser.updates).toEqual([{ width: 616 }]);
  });

  it("restores a maximized window before sizing it", async () => {
    const browser = fakeBrowser({ chromeWidth: 16, state: "maximized" });

    await resizeTabViewport(browser.api, 1, 2, { width: 768, height: 500 });

    expect(browser.updates[0]).toEqual({ state: "normal" });
    expect(browser.window.width).toBe(784);
    expect(browser.window.height).toBe(580);
  });

  it("corrects for page zoom on a further pass", async () => {
    const browser = fakeBrowser({ chromeWidth: 16, zoom: 1.25 });

    await expect(resizeTabViewport(browser.api, 1, 2, { width: 600 }))
      .resolves.toBe(true);
    expect(Math.round((browser.window.width - 16) / 1.25)).toBe(600);
  });

  it("gives up when the window cannot grow", async () => {
    const browser = fakeBrowser({ chromeWidth: 16, maxWindowWidth: 1400 });

    await expect(resizeTabViewport(browser.api, 1, 2, { width: 3000 }))
      .resolves.toBe(false);
  });
});
