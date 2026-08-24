import { describe, expect, it, vi } from "vitest";
import {
  APPLICABILITY_LIMITS,
  MatchedStylesApplicabilityObserver,
  type ApplicabilityCandidate,
} from "../src/matchedStylesApplicabilityObserver.js";

describe("MatchedStylesApplicabilityObserver", () => {
  it("digests exact selector-list indices and bounded composed ancestors", () => {
    const root = eventTargetHarness();
    const document = documentHarness(root);
    const ancestor = matchable(document, new Set([".ancestor"]));
    const selected = matchable(document, new Set([".card", ":checked"]), ancestor);
    const changes: unknown[] = [];
    const observer = createObserver(document, changes);

    observer.setSelection(selected, [
      candidate("card", document, ".missing, .card, :checked"),
      candidate("ancestor", document, ".ancestor"),
    ]);
    const snapshot = observer.check();

    expect(snapshot.partial).toBe(false);
    expect(snapshot.ancestorsVisited).toBe(2);
    expect(snapshot.matches).toEqual([
      { candidateKey: "card", ancestorIndex: 0, matchingSelectorIndices: [1, 2], groupApplicability: [] },
      { candidateKey: "ancestor", ancestorIndex: 1, matchingSelectorIndices: [0], groupApplicability: [] },
    ]);
    expect(changes).toEqual([]);
  });

  it("detects eventless checked, indeterminate, validity, placeholder, and custom state changes", () => {
    const root = eventTargetHarness();
    const document = documentHarness(root);
    const active = new Set<string>();
    const selected = matchable(document, active);
    const changes: unknown[] = [];
    const observer = createObserver(document, changes);
    observer.setSelection(selected, [candidate(
      "states",
      document,
      ":checked, :indeterminate, :valid, :placeholder-shown, :state(ready)",
    )]);
    observer.check();

    for (const selector of [
      ":checked",
      ":indeterminate",
      ":valid",
      ":placeholder-shown",
      ":state(ready)",
    ]) {
      active.add(selector);
      expect(observer.check().changed).toBe(true);
    }
    expect(changes).toHaveLength(5);
    expect(changes.every((change) => (
      (change as { reason: string }).reason === "applicability-change"
    ))).toBe(true);
  });

  it("tracks media/supports applicability while keeping scope/container unknown", () => {
    const root = eventTargetHarness();
    const mql = mediaHarness(false);
    const document = documentHarness(root, mql);
    const selected = matchable(document, new Set([".card"]));
    const changes: unknown[] = [];
    const observer = createObserver(document, changes);
    observer.setSelection(selected, [candidate("groups", document, ".card", [
      { kind: "media", text: "(width > 40rem)" },
      { kind: "supports", text: "(display: grid)" },
      { kind: "scope", text: "(.layout)" },
      { kind: "container", text: "sidebar (width > 10rem)" },
    ])]);

    expect(observer.check().matches[0]?.groupApplicability).toEqual([
      "inactive", "active", "unknown", "unknown",
    ]);
    mql.matches = true;
    mql.emit();
    expect(changes).toHaveLength(1);
    expect(observer.check().matches[0]?.groupApplicability[0]).toBe("active");
  });

  it("evaluates identical media conditions in their exact document scope", () => {
    const mainDocument = documentHarness(eventTargetHarness(), mediaHarness(true));
    const frameDocument = documentHarness(eventTargetHarness(), mediaHarness(false));
    const selected = matchable(frameDocument, new Set([".card"]));
    const observer = createObserver(mainDocument, []);
    const media = [{ kind: "media", text: "screen" }] as const;

    observer.setSelection(selected, [
      candidate("main", mainDocument, ".card", media),
      candidate("frame", frameDocument, ".card", media),
    ]);

    expect(observer.check().matches).toEqual([{
      candidateKey: "frame",
      ancestorIndex: 0,
      matchingSelectorIndices: [0],
      groupApplicability: ["inactive"],
    }]);
  });

  it("coalesces mutation, slot, pointer/focus, resize, and media signals without dispatching events", async () => {
    const root = eventTargetHarness();
    const mql = mediaHarness(true);
    const document = documentHarness(root, mql);
    const mutation = mutationHarness();
    const changes: unknown[] = [];
    const observer = createObserver(document, changes, {
      createMutationObserver: mutation.create,
    });
    observer.setSelection(matchable(document, new Set([".card"])), [
      candidate("card", document, ".card", [{ kind: "media", text: "screen" }]),
    ]);
    observer.check();

    mutation.emit([{ type: "attributes" }]);
    root.emit("slotchange");
    root.emit("pointerover");
    root.emit("pointerout");
    root.emit("focusin");
    root.emit("focusout");
    document.view.emit("resize");
    mql.emit();
    await Promise.resolve();

    expect(changes).toHaveLength(1);
    expect((changes[0] as { reason: string }).reason).toBe("observable-signal");
    expect(root.dispatchEvent).not.toHaveBeenCalled();
    expect(document.view.dispatchEvent).not.toHaveBeenCalled();
  });

  it("rotates bounded applicability work and provides a deterministic manual refresh fallback", () => {
    const root = eventTargetHarness();
    const document = documentHarness(root);
    const active = new Set<string>();
    const selected = matchable(document, active);
    const changes: unknown[] = [];
    const observer = createObserver(document, changes);
    const candidates = Array.from(
      { length: APPLICABILITY_LIMITS.candidatesPerPass + 1 },
      (_, index) => candidate(`candidate-${index}`, document, `.state-${index}`),
    );
    observer.setSelection(selected, candidates);

    const first = observer.check();
    expect(first.partial).toBe(true);
    expect(first.nextCursor).toBe(APPLICABILITY_LIMITS.candidatesPerPass);
    active.add(`.state-${APPLICABILITY_LIMITS.candidatesPerPass}`);
    const second = observer.check();
    expect(second.candidatesVisited).toBeGreaterThan(0);
    expect(second.changed).toBe(true);

    active.add(".state-0");
    const invalidationsBeforeManual = changes.length;
    observer.manualRefresh();
    expect(changes).toHaveLength(invalidationsBeforeManual + 1);
    expect(changes.at(-1)).toMatchObject({ reason: "manual-refresh" });
  });

  it("tears down every observer/listener/media registration and ignores later callbacks", async () => {
    const root = eventTargetHarness();
    const mql = mediaHarness(true);
    const document = documentHarness(root, mql);
    const mutation = mutationHarness();
    const changes: unknown[] = [];
    const observer = createObserver(document, changes, {
      createMutationObserver: mutation.create,
    });
    observer.setSelection(matchable(document, new Set([".card"])), [
      candidate("card", document, ".card", [{ kind: "media", text: "screen" }]),
    ]);
    observer.check();
    observer.dispose();

    expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(root.listenerCount()).toBe(0);
    expect(document.view.listenerCount()).toBe(0);
    expect(mql.listenerCount()).toBe(0);
    mutation.emit([{ type: "childList" }]);
    root.emit("focusin");
    mql.emit();
    await Promise.resolve();
    expect(changes).toEqual([]);
    expect(() => observer.check()).toThrow(/disposed/i);
  });
});

function createObserver(
  document: ReturnType<typeof documentHarness>,
  changes: unknown[],
  options: Partial<ConstructorParameters<typeof MatchedStylesApplicabilityObserver>[0]> = {},
) {
  return new MatchedStylesApplicabilityObserver({
    document: document as unknown as Document,
    onInvalidated: (event) => changes.push(event),
    ...options,
  });
}

function candidate(
  key: string,
  scope: object,
  selectorText: string,
  contexts: ApplicabilityCandidate["contexts"] = [],
): ApplicabilityCandidate {
  return { key, scope: scope as Document, selectorText, contexts };
}

function matchable(root: object, active: Set<string>, parentElement: Element | null = null) {
  return {
    parentElement,
    assignedSlot: null,
    getRootNode: () => root,
    matches: (selector: string) => active.has(selector),
  } as unknown as Element;
}

function eventTargetHarness() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, listener: EventListener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ type } as Event);
      }
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    dispatchEvent: vi.fn(),
  };
}

function documentHarness(root: ReturnType<typeof eventTargetHarness>, mql = mediaHarness(true)) {
  const viewTarget = eventTargetHarness();
  const view = {
    ...viewTarget,
    matchMedia: vi.fn(() => mql),
    CSS: { supports: vi.fn(() => true) },
  };
  return Object.assign(root, {
    nodeType: 9,
    defaultView: view,
    view,
  });
}

function mediaHarness(initial: boolean) {
  const listeners = new Set<EventListener>();
  return {
    matches: initial,
    media: "screen",
    addEventListener(_type: string, listener: EventListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: EventListener) {
      listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener({ type: "change" } as Event);
    },
    listenerCount: () => listeners.size,
  };
}

function mutationHarness() {
  let callback: ((records: readonly unknown[]) => void) | undefined;
  const disconnect = vi.fn();
  return {
    create(next: (records: readonly unknown[]) => void) {
      callback = next;
      return { observe: vi.fn(), disconnect };
    },
    emit(records: readonly unknown[]) {
      callback?.(records);
    },
    disconnect,
  };
}
