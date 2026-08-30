import { describe, expect, it } from "vitest";
import { PseudoStateController } from "../src/pseudoStateController.js";
import type {
  RulesDataSource,
  RulesPresentationSnapshot,
} from "../src/contracts.js";
import { elementsSession } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";

type PseudoState = "hover" | "focus";
type DisabledReason =
  | "no-selection"
  | "recovery"
  | "disconnected"
  | "mismatch";

type PseudoStateSnapshot = Readonly<{
  state: "ready" | "loading" | "partial" | "error" | "unavailable";
  states: readonly PseudoState[];
  unsupportedRuleCount: number;
  inaccessibleStylesheetCount: number;
  approximateRuleCount: number;
  reason?: DisabledReason;
  message?: string;
}>;

interface PseudoStateDataSourceShape {
  snapshot(): PseudoStateSnapshot;
  subscribe(listener: () => void): () => void;
  setStates(states: readonly PseudoState[]): Promise<void>;
}

type PseudoAwarePseudoStateController = new (
  document: Document,
  pseudoStateDataSource: PseudoStateDataSourceShape,
) => PseudoStateController;

const PreviewController = PseudoStateController as unknown as
  PseudoAwarePseudoStateController;

describe(":hov preview controller", () => {
  it("renders only hover and focus preview choices with screen-reader labels", () => {
    const harness = createHarness(ready([]));
    const button = part(harness.root, "pseudo-state-button");

    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toBe(":hov");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toMatch(/preview/i);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBeNull();

    button.dispatch("click");

    const menu = part(harness.root, "pseudo-state-menu");
    const choices = pseudoChoices(menu);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    expect(choices.map((choice) => choice.getAttribute("data-pseudo-state")))
      .toEqual(["hover", "focus"]);
    expect(choices.map((choice) => choice.getAttribute("aria-label")))
      .toEqual([expect.stringMatching(/preview.*:hover/i), expect.stringMatching(/preview.*:focus/i)]);
    expect(harness.root.textContent).not.toMatch(
      /:active|:visited|:focus-within/i,
    );
    expect(harness.root.querySelector('input[type="text"]')).toBeNull();
    expect(harness.root.querySelector('[data-part="pseudo-state-input"]'))
      .toBeNull();
  });

  it("opens from the keyboard and Escape closes with focus returned to :hov", () => {
    const harness = createHarness(ready([]));
    const button = part(harness.root, "pseudo-state-button");

    const open = button.dispatch("keydown", { key: "Enter" });

    const menu = part(harness.root, "pseudo-state-menu");
    const hover = pseudoChoice(menu, "hover");
    expect(open.defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(harness.document.activeElement()).toBe(hover);

    const close = menu.dispatch("keydown", { key: "Escape" });

    expect(close.defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menu.hidden).toBe(true);
    expect(harness.document.activeElement()).toBe(button);
  });

  it("replaces the complete state set atomically and blocks racing changes", async () => {
    const harness = createHarness(ready(["hover"]));
    const update = deferred<void>();
    harness.pseudo.nextUpdate = update.promise;
    const button = part(harness.root, "pseudo-state-button");
    button.dispatch("click");
    const menu = part(harness.root, "pseudo-state-menu");
    const hover = pseudoChoice(menu, "hover") as CheckboxElement;
    const focus = pseudoChoice(menu, "focus") as CheckboxElement;

    expect(hover.checked).toBe(true);
    expect(focus.checked).toBe(false);
    focus.focus();
    expect(harness.document.activeElement()).toBe(focus);
    focus.checked = true;
    focus.dispatch("change");

    expect(harness.pseudo.setCalls).toEqual([["hover", "focus"]]);
    expect(harness.pseudo.snapshot().states).toEqual(["hover"]);
    expect(Object.isFrozen(harness.pseudo.setCalls[0])).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(hover.disabled).toBe(true);
    expect(focus.disabled).toBe(true);

    hover.checked = false;
    hover.dispatch("change");
    expect(harness.pseudo.setCalls).toEqual([["hover", "focus"]]);

    harness.pseudo.publish(ready(["hover", "focus"]));
    update.resolve();
    await update.promise;
    await Promise.resolve();

    expect(part(harness.root, "pseudo-state-button").disabled).toBe(false);
    expect((pseudoChoice(harness.root, "hover") as CheckboxElement).checked)
      .toBe(true);
    expect((pseudoChoice(harness.root, "focus") as CheckboxElement).checked)
      .toBe(true);
    expect(
      harness.document.activeElement() ===
        part(harness.root, "pseudo-state-button"),
    ).toBe(true);
  });

  it.each([
    ["no-selection", /select/i],
    ["recovery", /recover/i],
    ["disconnected", /disconnect/i],
    ["mismatch", /mismatch|incompatible/i],
  ] as const)(
    "disables and resets previews for %s",
    (reason, description) => {
      const harness = createHarness(ready(["hover", "focus"]));
      const button = part(harness.root, "pseudo-state-button");
      button.dispatch("click");

      harness.pseudo.publish(unavailable(reason));

      const currentButton = part(harness.root, "pseudo-state-button");
      const status = part(harness.root, "pseudo-state-description");
      expect(currentButton.disabled).toBe(true);
      expect(currentButton.getAttribute("aria-expanded")).toBe("false");
      expect(status.textContent).toMatch(description);
      expect(pseudoChoices(harness.root).map((choice) => (
        (choice as CheckboxElement).checked
      ))).toEqual([false, false]);
    },
  );

  it("describes partial author-style coverage without claiming native or exact parity", () => {
    const harness = createHarness(snapshot({
      state: "partial",
      states: ["focus"],
      unsupportedRuleCount: 2,
      inaccessibleStylesheetCount: 1,
      approximateRuleCount: 3,
    }));
    const button = part(harness.root, "pseudo-state-button");
    const description = part(harness.root, "pseudo-state-description");

    // Coverage is what the button says on hover; it takes no room in the pane.
    expect(description.getAttribute("role")).toBe("note");
    for (const text of [description.textContent, button.title]) {
      expect(text).toMatch(/author styles only/i);
      expect(text).toMatch(/2 .*unsupported/i);
      expect(text).toMatch(/1 .*inaccessible/i);
      expect(text).toMatch(/3 .*source-order approximation/i);
      expect(text).toMatch(/not .*native browser forcing/i);
      expect(text).toMatch(/not .*exact cascade parity/i);
    }
    expect(button.getAttribute("aria-describedby")).toBe(description.id);
  });

  it("surfaces preview errors accessibly and leaves controls disabled", () => {
    const harness = createHarness(snapshot({
      state: "error",
      states: [],
      message: "Preview update failed",
    }));
    const button = part(harness.root, "pseudo-state-button");
    const description = part(harness.root, "pseudo-state-description");

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(description.getAttribute("role")).toBe("alert");
    expect(description.textContent).toContain("Preview update failed");
    expect(description.textContent).toMatch(/preview/i);
  });

  it("ignores a late failed update after selection authority is replaced", async () => {
    const harness = createHarness(ready(["hover"]));
    const update = deferred<void>();
    harness.pseudo.nextUpdate = update.promise;
    const button = part(harness.root, "pseudo-state-button");
    button.dispatch("click");
    const focus = pseudoChoice(harness.root, "focus") as CheckboxElement;
    focus.checked = true;
    focus.dispatch("change");

    harness.pseudo.publish(unavailable("no-selection"));
    harness.pseudo.publish(ready([]));

    const replacementButton = part(harness.root, "pseudo-state-button");
    expect(replacementButton.disabled).toBe(false);
    update.reject(new Error("stale update failed"));
    await update.promise.catch(() => undefined);
    await Promise.resolve();

    expect(part(harness.root, "pseudo-state-button").disabled).toBe(false);
    expect(part(harness.root, "pseudo-state-description").textContent)
      .not.toMatch(/error|failed/i);
  });

  it("does not steal focus moved outside the preview while an update settles", async () => {
    const harness = createHarness(ready([]));
    const update = deferred<void>();
    harness.pseudo.nextUpdate = update.promise;
    const external = harness.document.createElement("button") as unknown as
      FakeElement;
    harness.document.body.append(external);
    const button = part(harness.root, "pseudo-state-button");
    button.dispatch("keydown", { key: "Enter" });
    const focus = pseudoChoice(harness.root, "focus") as CheckboxElement;
    focus.focus();
    focus.checked = true;
    focus.dispatch("change");

    external.focus();
    harness.pseudo.publish(ready(["focus"]));
    update.resolve();
    await update.promise;
    await Promise.resolve();

    expect(harness.document.activeElement() === external).toBe(true);
  });
});

class FakeRulesDataSource implements RulesDataSource {
  public snapshot(): RulesPresentationSnapshot {
    return elementsSession.rules;
  }

  public subscribe(_listener: () => void): () => void {
    return () => {};
  }

  public filter(_query: string): void {}
}

class FakePseudoStateDataSource implements PseudoStateDataSourceShape {
  public readonly setCalls: Array<readonly PseudoState[]> = [];
  public nextUpdate: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  public constructor(private current: PseudoStateSnapshot) {}

  public snapshot(): PseudoStateSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setStates(states: readonly PseudoState[]): Promise<void> {
    this.setCalls.push(Object.freeze([...states]));
    return this.nextUpdate;
  }

  public publish(next: PseudoStateSnapshot): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

interface CheckboxElement extends FakeElement {
  checked: boolean;
}

function createHarness(initial: PseudoStateSnapshot) {
  const document = new FakeDocument();
  const pseudo = new FakePseudoStateDataSource(initial);
  const controller = new PreviewController(document.document, pseudo);
  const root = controller.element as unknown as FakeElement;
  document.body.append(root);
  return { document, controller, pseudo, root };
}

function part(root: FakeElement, name: string): FakeElement {
  return required(root.querySelector(`[data-part="${name}"]`));
}

function pseudoChoices(root: FakeElement): FakeElement[] {
  return root.querySelectorAll('input[type="checkbox"]');
}

function pseudoChoice(root: FakeElement, state: PseudoState): FakeElement {
  return required(root.querySelector(`[data-pseudo-state="${state}"]`));
}

function ready(states: readonly PseudoState[]): PseudoStateSnapshot {
  return snapshot({ state: "ready", states });
}

function unavailable(reason: DisabledReason): PseudoStateSnapshot {
  return snapshot({ state: "unavailable", states: [], reason });
}

function snapshot(
  value: Pick<PseudoStateSnapshot, "state" | "states"> &
    Partial<Omit<PseudoStateSnapshot, "state" | "states">>,
): PseudoStateSnapshot {
  return Object.freeze({
    unsupportedRuleCount: 0,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 0,
    ...value,
    states: Object.freeze([...value.states]),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Missing expected rendered element");
  }
  return value;
}
