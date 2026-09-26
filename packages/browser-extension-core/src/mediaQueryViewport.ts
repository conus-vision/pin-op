/**
 * The viewport an `@media` condition names, and the browser window resize that
 * shows the inspected page at it.
 *
 * A width range is shown at its upper bound, the widest viewport it still
 * matches, since that is the layout the range was written for; an open-ended
 * minimum is shown at the minimum itself. A strict bound is one CSS pixel
 * inside it. Heights follow the same rule. Relative units are read against the
 * initial 16 px font size, which is what a media query itself does.
 */

export interface ViewportSize {
  readonly width?: number;
  readonly height?: number;
}

export const VIEWPORT_DIMENSION_MIN = 100;
export const VIEWPORT_DIMENSION_MAX = 16_384;

const MEDIA_FONT_SIZE_PX = 16;

type Axis = "width" | "height";

interface Bounds {
  min?: number;
  max?: number;
}

const LENGTH = String.raw`(-?\d*\.?\d+)\s*(px|em|rem)?`;
const PREFIXED_FEATURE = new RegExp(
  String.raw`\(\s*(min|max)-(width|height)\s*:\s*${LENGTH}\s*\)`,
  "giu",
);
const RANGE_FEATURE = new RegExp(
  String.raw`\(\s*(?:${LENGTH}\s*(<=|<|>=|>)\s*)?(width|height)(?:\s*(<=|<|>=|>|=)\s*${LENGTH})?\s*\)`,
  "giu",
);

export function viewportForMediaCondition(
  conditionText: string,
): ViewportSize | undefined {
  if (typeof conditionText !== "string" || conditionText.length > 2048) {
    return undefined;
  }
  // Only what every branch of the condition requires is a size to show; a
  // negated or alternative branch cannot be shown by one viewport.
  const firstBranch = conditionText.split(/,|\bor\b/iu)[0] ?? "";
  if (/\bnot\b/iu.test(firstBranch)) return undefined;
  const bounds: Record<Axis, Bounds> = { width: {}, height: {} };

  for (const match of firstBranch.matchAll(PREFIXED_FEATURE)) {
    const value = pixels(match[3], match[4]);
    if (value === undefined) continue;
    tighten(bounds[match[2]!.toLowerCase() as Axis], match[1] === "min" ? ">=" : "<=", value);
  }
  for (const match of firstBranch.matchAll(RANGE_FEATURE)) {
    const axis = match[4]!.toLowerCase() as Axis;
    if (match[3] !== undefined) {
      const value = pixels(match[1], match[2]);
      // `600px < width` reads as `width > 600px`.
      if (value !== undefined) tighten(bounds[axis], flip(match[3]), value);
    }
    if (match[5] !== undefined) {
      const value = pixels(match[6], match[7]);
      if (value !== undefined) tighten(bounds[axis], match[5], value);
    }
  }

  const width = pick(bounds.width);
  const height = pick(bounds.height);
  if (width === undefined && height === undefined) return undefined;
  return Object.freeze({
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  });
}

function pixels(
  value: string | undefined,
  unit: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const lowerUnit = unit?.toLowerCase();
  if (lowerUnit === undefined && number !== 0) return undefined;
  return lowerUnit === "em" || lowerUnit === "rem"
    ? number * MEDIA_FONT_SIZE_PX
    : number;
}

function flip(operator: string): string {
  return operator.replace("<", "#").replace(">", "<").replace("#", ">");
}

function tighten(bounds: Bounds, operator: string, value: number): void {
  if (operator === "=") {
    bounds.min = Math.max(bounds.min ?? value, value);
    bounds.max = Math.min(bounds.max ?? value, value);
  } else if (operator === ">=" || operator === ">") {
    const min = operator === ">" ? Math.floor(value) + 1 : Math.ceil(value);
    bounds.min = Math.max(bounds.min ?? min, min);
  } else if (operator === "<=" || operator === "<") {
    const max = operator === "<" ? Math.ceil(value) - 1 : Math.floor(value);
    bounds.max = Math.min(bounds.max ?? max, max);
  }
}

function pick(bounds: Bounds): number | undefined {
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) {
    return undefined;
  }
  const value = bounds.max ?? bounds.min;
  if (value === undefined) return undefined;
  return Math.min(
    VIEWPORT_DIMENSION_MAX,
    Math.max(VIEWPORT_DIMENSION_MIN, Math.round(value)),
  );
}

export interface BrowserWindowBounds {
  readonly width?: number;
  readonly height?: number;
  readonly state?: string;
}

export interface ViewportResizeApi {
  /** The inspected tab's current viewport, in CSS pixels. */
  measureViewport(tabId: number): Promise<{
    readonly width: number;
    readonly height: number;
  } | undefined>;
  getWindow(windowId: number): Promise<BrowserWindowBounds>;
  updateWindow(
    windowId: number,
    update: { width?: number; height?: number; state?: "normal" },
  ): Promise<unknown>;
}

const MAX_RESIZE_PASSES = 3;

/**
 * Resizes the window that holds the inspected tab until the tab's viewport is
 * the requested size. The window's frame, and any docked DevTools, take a fixed
 * share of it, so the window is changed by what the viewport is still missing;
 * page zoom makes a window pixel worth more or less than a CSS pixel, which a
 * further pass corrects.
 */
export async function resizeTabViewport(
  api: ViewportResizeApi,
  tabId: number,
  windowId: number,
  target: ViewportSize,
): Promise<boolean> {
  let bounds = await api.getWindow(windowId);
  if (bounds.state !== undefined && bounds.state !== "normal") {
    await api.updateWindow(windowId, { state: "normal" });
    bounds = await api.getWindow(windowId);
  }
  let scale = 1;
  for (let pass = 0; pass < MAX_RESIZE_PASSES; pass += 1) {
    const viewport = await api.measureViewport(tabId);
    if (!viewport) return false;
    const missingWidth = target.width === undefined ? 0 : target.width - viewport.width;
    const missingHeight = target.height === undefined ? 0 : target.height - viewport.height;
    if (missingWidth === 0 && missingHeight === 0) return true;
    const update: { width?: number; height?: number } = {};
    if (missingWidth !== 0 && bounds.width !== undefined) {
      update.width = Math.max(VIEWPORT_DIMENSION_MIN, Math.round(bounds.width + missingWidth * scale));
    }
    if (missingHeight !== 0 && bounds.height !== undefined) {
      update.height = Math.max(VIEWPORT_DIMENSION_MIN, Math.round(bounds.height + missingHeight * scale));
    }
    if (update.width === undefined && update.height === undefined) return false;
    await api.updateWindow(windowId, update);
    const resized = await api.getWindow(windowId);
    const after = await api.measureViewport(tabId);
    if (!after) return false;
    const movedWidth = after.width - viewport.width;
    const windowWidthChange = (resized.width ?? 0) - (bounds.width ?? 0);
    if (movedWidth !== 0 && windowWidthChange !== 0) {
      scale = Math.abs(windowWidthChange / movedWidth);
    }
    bounds = resized;
    if (
      (target.width === undefined || after.width === target.width) &&
      (target.height === undefined || after.height === target.height)
    ) {
      return true;
    }
    // A bounds at the screen's limit does not move any further.
    if (after.width === viewport.width && after.height === viewport.height) {
      return false;
    }
  }
  return false;
}
