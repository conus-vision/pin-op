export interface VirtualViewport {
  readonly start: number;
  readonly size: number;
  readonly overscan: number;
}

export interface VirtualTreeRow<T> {
  readonly index: number;
  readonly value: T;
}

export function virtualTreeRows<T>(
  rows: readonly T[],
  viewport: VirtualViewport,
): readonly VirtualTreeRow<T>[] {
  assertViewport(viewport);
  if (viewport.start >= rows.length || viewport.size === 0) {
    return Object.freeze([]);
  }

  const first = Math.max(0, viewport.start - viewport.overscan);
  const last = Math.min(
    rows.length,
    viewport.start + viewport.size + viewport.overscan,
  );
  return Object.freeze(
    rows.slice(first, last).map((value, offset) => Object.freeze({
      index: first + offset,
      value,
    })),
  );
}

function assertViewport(viewport: VirtualViewport): void {
  if (
    !Number.isSafeInteger(viewport.start) ||
    !Number.isSafeInteger(viewport.size) ||
    !Number.isSafeInteger(viewport.overscan) ||
    viewport.start < 0 ||
    viewport.size < 0 ||
    viewport.overscan < 0
  ) {
    throw new RangeError("Invalid virtual tree viewport");
  }
}
