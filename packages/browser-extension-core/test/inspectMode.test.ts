import { describe, expect, it, vi } from "vitest";
import {
  InspectMode,
  type InspectDocument,
  type InspectEventType,
} from "../src/inspectMode.js";

const SUPPRESSED_EVENT_TYPES = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
] as const;

describe("InspectMode", () => {
  it("suppresses the complete picker action sequence and removes every listener", () => {
    const document = new FakeInspectDocument();
    const mode = new InspectMode({
      document,
      onSelect: vi.fn(),
    });

    mode.enable();
    mode.enable();

    for (const type of SUPPRESSED_EVENT_TYPES) {
      const event = createEvent(type, element());
      document.dispatch(type, event);
      expect(event.calls, type).toEqual([
        "preventDefault",
        "stopPropagation",
        "stopImmediatePropagation",
      ]);
      expect(document.captureAdds(type), type).toBe(1);
    }

    mode.disable();
    mode.disable();

    for (const type of SUPPRESSED_EVENT_TYPES) {
      expect(document.captureRemoves(type), type).toBe(1);
      expect(document.listenerCount(type), type).toBe(0);
    }

    expect(document.addOptions("touchstart")).toEqual([
      { capture: true, passive: false },
    ]);
    expect(document.addOptions("touchend")).toEqual([
      { capture: true, passive: false },
    ]);
    expect(document.removeOptions("touchstart")).toEqual([
      { capture: true, passive: false },
    ]);
    expect(document.removeOptions("touchend")).toEqual([
      { capture: true, passive: false },
    ]);
  });

  it("selects exactly once for a trusted primary pointer interaction without compatibility mouse events", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element();
    const mode = new InspectMode({
      document,
      onSelect: (element) => selected.push(element),
    });
    mode.enable();

    document.dispatch("click", createEvent("click", target, {
      isTrusted: false,
    }));
    dispatchPointerSequence(document, target, { button: 2 });
    dispatchPointerSequence(document, target, { isPrimary: false });
    dispatchPointerSequence(document, target);
    document.dispatch("click", createEvent("click", target));
    document.dispatch("dblclick", createEvent("dblclick", target));

    expect(selected).toEqual([target]);
  });

  it("uses mousedown, mouseup, click only as a fallback with no pointer stream", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element("BUTTON", "mouse-target");
    const mode = new InspectMode({
      document,
      onSelect: (candidate) => selected.push(candidate),
    });
    mode.enable();

    dispatchMouseSequence(document, target);
    expect(selected).toEqual([target]);

    document.dispatch("pointerdown", createEvent("pointerdown", target));
    document.dispatch("mousedown", createEvent("mousedown", target));
    document.dispatch("mouseup", createEvent("mouseup", target));
    document.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([target]);

    document.dispatch("pointerdown", createEvent("pointerdown", target, {
      isPrimary: false,
      pointerId: 2,
    }));
    dispatchMouseSequence(document, target);

    expect(selected).toEqual([target]);
  });

  it("requires an ordered pointer sequence with matching target and pointer identity", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element("BUTTON", "target");
    const other = element("BUTTON", "other");
    const mode = new InspectMode({
      document,
      onSelect: (candidate) => selected.push(candidate),
    });
    mode.enable();

    document.dispatch("pointerup", createEvent("pointerup", target));
    document.dispatch("click", createEvent("click", target));

    document.dispatch("pointerdown", createEvent("pointerdown", target));
    document.dispatch("pointerup", createEvent("pointerup", other));
    document.dispatch("click", createEvent("click", target));

    document.dispatch("pointerdown", createEvent("pointerdown", target, {
      pointerId: 7,
    }));
    document.dispatch("pointerup", createEvent("pointerup", target, {
      pointerId: 8,
    }));
    document.dispatch("click", createEvent("click", target));

    document.dispatch("pointerdown", createEvent("pointerdown", target));
    document.dispatch("pointercancel", createEvent("pointercancel", target));
    document.dispatch("click", createEvent("click", other));
    document.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([]);

    dispatchPointerSequence(document, target);
    expect(selected).toEqual([target]);
  });

  it("does not combine primary interaction phases across documents", () => {
    const topDocument = new FakeInspectDocument();
    const frameDocument = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element("BUTTON", "shared-target");
    const mode = new InspectMode({
      document: topDocument,
      onSelect: (candidate) => selected.push(candidate),
    });
    mode.addDocument(frameDocument);
    mode.enable();

    topDocument.dispatch("pointerdown", createEvent("pointerdown", target));
    frameDocument.dispatch("pointerup", createEvent("pointerup", target));
    frameDocument.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([]);

    dispatchPointerSequence(frameDocument, target);
    expect(selected).toEqual([target]);
  });

  it("clears armed document state on removal and reentrant staleness", () => {
    const document = new FakeInspectDocument(true);
    const selected: unknown[] = [];
    const target = element("BUTTON", "target");
    const mode = new InspectMode({
      document,
      onSelect: (candidate) => selected.push(candidate),
    });
    mode.enable();

    document.dispatch("pointerdown", createEvent("pointerdown", target));
    mode.removeDocument(document);
    mode.addDocument(document);
    document.dispatch("click", createEvent("click", target));

    document.dispatch("pointerdown", createEvent("pointerdown", target));
    const reentrantPointerUp = createEvent("pointerup", target);
    reentrantPointerUp.composedPath = () => {
      mode.removeDocument(document);
      mode.addDocument(document);
      return [target];
    };
    document.dispatch("pointerup", reentrantPointerUp);
    document.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([]);
  });

  it("selects on trusted touch completion and dedupes a later compatibility click", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element("BUTTON", "touch-target");
    const mode = new InspectMode({
      document,
      onSelect: (element) => selected.push(element),
    });
    mode.enable();

    document.dispatch("touchstart", createEvent("touchstart", target));
    document.dispatch("touchend", createEvent("touchend", target));
    expect(selected).toEqual([target]);

    document.dispatch("click", createEvent("click", target));
    document.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([target]);

    document.dispatch("touchstart", createEvent("touchstart", target));
    dispatchMouseSequence(document, target);
    document.dispatch("touchstart", createEvent("touchstart", target));
    dispatchPointerSequence(document, target, { pointerType: "touch" });

    expect(selected).toEqual([target]);
  });

  it("selects a primary touch pointer on pointerup and dedupes its click", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element("BUTTON", "pointer-touch-target");
    const mode = new InspectMode({
      document,
      onSelect: (candidate) => selected.push(candidate),
    });
    mode.enable();

    document.dispatch("pointerdown", createEvent("pointerdown", target, {
      pointerId: 19,
      pointerType: "touch",
    }));
    document.dispatch("touchstart", createEvent("touchstart", target));
    document.dispatch("pointerup", createEvent("pointerup", target, {
      pointerId: 19,
      pointerType: "touch",
    }));
    document.dispatch("touchend", createEvent("touchend", target));
    document.dispatch("click", createEvent("click", target));

    expect(selected).toEqual([target]);
  });

  it("selects the first composed-path element outside the page overlay", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const textNode = { nodeType: 3 };
    const overlayNode = element("DIV", "pin-op-overlay");
    const card = element("ARTICLE", "card");
    const mode = new InspectMode({
      document,
      isOverlayNode: (node) => node === overlayNode,
      onSelect: (element) => selected.push(element),
    });
    mode.enable();

    dispatchPointerSequence(document, textNode, {
      path: [textNode, overlayNode, card],
    });

    expect(selected).toEqual([card]);
  });

  it("tracks frame documents without duplicates and ignores stale frame events", () => {
    const topDocument = new FakeInspectDocument();
    const frameDocument = new FakeInspectDocument(true);
    const hovered: unknown[] = [];
    const topTarget = element("MAIN", "top");
    const frameTarget = element("BUTTON", "frame");
    const mode = new InspectMode({
      document: topDocument,
      onHover: (element) => hovered.push(element),
      onSelect: vi.fn(),
    });

    mode.addDocument(frameDocument);
    mode.addDocument(frameDocument);
    mode.enable();
    frameDocument.dispatch(
      "pointermove",
      createEvent("pointermove", frameTarget),
    );

    mode.removeDocument(frameDocument);
    frameDocument.dispatch(
      "pointermove",
      createEvent("pointermove", frameTarget),
    );
    topDocument.dispatch(
      "pointermove",
      createEvent("pointermove", topTarget),
    );

    expect(hovered).toEqual([frameTarget, topTarget]);
    expect(frameDocument.captureAdds("pointermove")).toBe(1);
    expect(frameDocument.captureRemoves("pointermove")).toBe(1);
  });

  it("forwards hover clearing and only distinct trusted Escape presses", () => {
    const document = new FakeInspectDocument();
    const calls: string[] = [];
    const mode = new InspectMode({
      document,
      onClearHover: () => calls.push("clear"),
      onEscape: () => calls.push("escape"),
      onHover: () => calls.push("hover"),
      onSelect: vi.fn(),
    });
    mode.enable();

    document.dispatch(
      "pointermove",
      createEvent("pointermove", element(), { isTrusted: false }),
    );
    document.dispatch("pointermove", createEvent("pointermove", element()));
    document.dispatch(
      "pointermove",
      createEvent("pointermove", { nodeType: 3 }),
    );
    document.dispatch("keydown", createKeyEvent("Escape", false));
    document.dispatch("keydown", createKeyEvent("Enter", true));
    document.dispatch("keydown", createKeyEvent("Escape", true, true));
    const escape = createKeyEvent("Escape", true);
    document.dispatch("keydown", escape);

    expect(calls).toEqual(["hover", "clear", "escape"]);
    expect(escape.calls).toEqual([
      "preventDefault",
      "stopPropagation",
      "stopImmediatePropagation",
    ]);
  });

  it("fails closed when page event access throws or reenters", () => {
    const document = new FakeInspectDocument();
    const selected: unknown[] = [];
    const target = element();
    const mode = new InspectMode({
      document,
      onError: () => {
        throw new Error("diagnostics are hostile too");
      },
      onSelect: (element) => selected.push(element),
    });
    mode.enable();
    document.dispatch("pointerdown", createEvent("pointerdown", target));

    const reentrantClick = createEvent("click", target);
    reentrantClick.composedPath = () => {
      mode.disable();
      return [target];
    };
    expect(() => document.dispatch("click", reentrantClick)).not.toThrow();

    mode.enable();
    const throwingEvent = {
      type: "pointerdown",
      target,
      get isTrusted(): boolean {
        throw new Error("blocked");
      },
      button: 0,
      composedPath: () => [target],
      preventDefault() {
        throw new Error("blocked");
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    expect(() => document.dispatch("pointerdown", throwingEvent)).not.toThrow();

    expect(selected).toEqual([]);
  });

  it("makes disposal terminal and leaves retained listeners harmless", () => {
    const document = new FakeInspectDocument(true);
    const laterDocument = new FakeInspectDocument();
    const hovered: unknown[] = [];
    const selected: unknown[] = [];
    const target = element();
    const mode = new InspectMode({
      document,
      onHover: (element) => hovered.push(element),
      onSelect: (element) => selected.push(element),
    });
    mode.enable();

    mode.dispose();
    mode.dispose();
    mode.addDocument(laterDocument);
    mode.enable();
    document.dispatch("pointermove", createEvent("pointermove", target));
    dispatchPointerSequence(document, target);
    laterDocument.dispatch("pointermove", createEvent("pointermove", target));
    dispatchPointerSequence(laterDocument, target);

    expect(hovered).toEqual([]);
    expect(selected).toEqual([]);
    expect(document.captureRemoves("click")).toBe(1);
    expect(document.captureAdds("click")).toBe(1);
    expect(laterDocument.captureAdds("click")).toBe(0);
  });

  it("makes a partially leaked install harmless and retries while enabled", () => {
    const document = new FakeInspectDocument({
      retainRemovedListeners: true,
      throwOnAddOnce: "touchstart",
      throwOnRemove: true,
    });
    const selected: unknown[] = [];
    const target = element("BUTTON", "retry-target");
    const mode = new InspectMode({
      document,
      onError: vi.fn(),
      onSelect: (candidate) => selected.push(candidate),
    });

    mode.enable();
    mode.enable();
    dispatchPointerSequence(document, target);

    expect(selected).toEqual([target]);
    expect(document.captureAdds("click")).toBe(2);

    mode.disable();
    dispatchPointerSequence(document, target);
    expect(selected).toEqual([target]);
  });
});

class FakeInspectDocument implements InspectDocument {
  private readonly listeners = new Map<
    InspectEventType,
    Set<(event: any) => void>
  >();
  private readonly additions: Array<{
    readonly options: boolean | { readonly capture: boolean; readonly passive?: boolean };
    readonly type: InspectEventType;
  }> = [];
  private readonly removals: Array<{
    readonly options: boolean | { readonly capture: boolean; readonly passive?: boolean };
    readonly type: InspectEventType;
  }> = [];
  private addHasThrown = false;

  private readonly config: {
    readonly retainRemovedListeners: boolean;
    readonly throwOnAddOnce?: InspectEventType;
    readonly throwOnRemove: boolean;
  };

  public constructor(
    options: boolean | {
      readonly retainRemovedListeners?: boolean;
      readonly throwOnAddOnce?: InspectEventType;
      readonly throwOnRemove?: boolean;
    } = false,
  ) {
    this.config = typeof options === "boolean"
      ? {
          retainRemovedListeners: options,
          throwOnRemove: false,
        }
      : {
          retainRemovedListeners: options.retainRemovedListeners ?? false,
          throwOnAddOnce: options.throwOnAddOnce,
          throwOnRemove: options.throwOnRemove ?? false,
        };
  }

  public addEventListener(
    type: InspectEventType,
    listener: (event: any) => void,
    options: boolean | { readonly capture: boolean; readonly passive?: boolean },
  ): void {
    expect(captureEnabled(options)).toBe(true);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    this.additions.push({ options, type });
    if (this.config.throwOnAddOnce === type && !this.addHasThrown) {
      this.addHasThrown = true;
      throw new Error(`add failed for ${type}`);
    }
  }

  public removeEventListener(
    type: InspectEventType,
    listener: (event: any) => void,
    options: boolean | { readonly capture: boolean; readonly passive?: boolean },
  ): void {
    expect(captureEnabled(options)).toBe(true);
    this.removals.push({ options, type });
    if (this.config.throwOnRemove) {
      throw new Error(`remove failed for ${type}`);
    }
    if (!this.config.retainRemovedListeners) {
      this.listeners.get(type)?.delete(listener);
    }
  }

  public dispatch(type: InspectEventType, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  public captureAdds(type: InspectEventType): number {
    return this.additions.filter((candidate) => candidate.type === type).length;
  }

  public captureRemoves(type: InspectEventType): number {
    return this.removals.filter((candidate) => candidate.type === type).length;
  }

  public addOptions(
    type: InspectEventType,
  ): readonly (boolean | { readonly capture: boolean; readonly passive?: boolean })[] {
    return this.additions
      .filter((candidate) => candidate.type === type)
      .map((candidate) => candidate.options);
  }

  public removeOptions(
    type: InspectEventType,
  ): readonly (boolean | { readonly capture: boolean; readonly passive?: boolean })[] {
    return this.removals
      .filter((candidate) => candidate.type === type)
      .map((candidate) => candidate.options);
  }

  public listenerCount(type: InspectEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function createEvent(
  type: InspectEventType,
  target: unknown,
  overrides: {
    readonly isTrusted?: boolean;
    readonly button?: number;
    readonly isPrimary?: boolean;
    readonly path?: readonly unknown[];
    readonly pointerId?: number;
    readonly pointerType?: string;
  } = {},
) {
  const calls: string[] = [];
  return {
    type,
    target,
    isTrusted: overrides.isTrusted ?? true,
    button: overrides.button ?? 0,
    isPrimary: overrides.isPrimary ?? true,
    pointerId: overrides.pointerId ?? 1,
    pointerType: overrides.pointerType ?? "mouse",
    composedPath: () => (
      Array.isArray(overrides.path)
        ? overrides.path
        : [target]
    ),
    calls,
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
    stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
  };
}

function createKeyEvent(key: string, isTrusted: boolean, repeat = false) {
  const calls: string[] = [];
  return {
    type: "keydown" as const,
    key,
    isTrusted,
    repeat,
    calls,
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
    stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
  };
}

function dispatchPointerSequence(
  document: FakeInspectDocument,
  target: unknown,
  overrides: {
    readonly isTrusted?: boolean;
    readonly button?: number;
    readonly isPrimary?: boolean;
    readonly path?: readonly unknown[];
    readonly pointerId?: number;
    readonly pointerType?: string;
  } = {},
): void {
  for (const type of [
    "pointerdown",
    "pointerup",
    "click",
  ] as const) {
    document.dispatch(type, createEvent(type, target, overrides));
  }
}

function dispatchMouseSequence(
  document: FakeInspectDocument,
  target: unknown,
): void {
  for (const type of ["mousedown", "mouseup", "click"] as const) {
    document.dispatch(type, createEvent(type, target));
  }
}

function captureEnabled(
  options: boolean | { readonly capture: boolean },
): boolean {
  return typeof options === "boolean" ? options : options.capture;
}

function element(tagName = "A", id = "link") {
  return {
    nodeType: 1,
    tagName,
    id,
    classList: [],
    attributes: [],
    matches: () => true,
    parentElement: null,
  };
}
