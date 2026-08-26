import type {
  PseudoState,
  PseudoStateDataSource,
  PseudoStateDisabledReason,
  PseudoStateSnapshot,
} from "./contracts.js";

const PREVIEW_STATES = Object.freeze(["hover", "focus"] as const);
const nextControlId = new WeakMap<Document, number>();

export class PseudoStateController {
  public readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly description: HTMLElement;
  private readonly choices = new Map<PseudoState, HTMLInputElement>();
  private readonly choiceListeners = new Map<
    PseudoState,
    (event: Event) => void
  >();
  private unsubscribe: (() => void) | undefined;
  private current: PseudoStateSnapshot;
  private pendingStates: readonly PseudoState[] | undefined;
  private sourceRevision = 0;
  private updateRevision = 0;
  private disposed = false;
  private localError: string | undefined;
  private returnFocusAfterUpdate = false;
  private readonly onButtonClickListener = (): void => this.toggleMenu();
  private readonly onButtonKeyDownListener = (event: Event): void => (
    this.onButtonKeyDown(event)
  );
  private readonly onMenuKeyDownListener = (event: Event): void => (
    this.onMenuKeyDown(event)
  );

  public constructor(
    private readonly document: Document,
    private readonly dataSource: PseudoStateDataSource,
  ) {
    const ids = allocateControlIds(document);
    this.element = createElement(document, "div", {
      className: "pseudo-state-controls",
      attributes: { "data-part": "pseudo-state-controls" },
    });
    this.button = createElement(document, "button", {
      className: "pseudo-state-button",
      text: ":hov",
      attributes: {
        "aria-busy": "false",
        "aria-controls": ids.menu,
        "aria-describedby": ids.description,
        "aria-expanded": "false",
        "aria-label": "Open pseudo-state preview controls",
        "data-part": "pseudo-state-button",
        type: "button",
      },
    }) as HTMLButtonElement;
    this.menu = createElement(document, "div", {
      className: "pseudo-state-menu",
      attributes: {
        "aria-label": "Pseudo-state previews",
        "data-part": "pseudo-state-menu",
        id: ids.menu,
        role: "group",
      },
    });
    this.menu.hidden = true;
    for (const state of PREVIEW_STATES) {
      const label = createElement(document, "label", {
        className: "pseudo-state-choice",
      });
      const input = createElement(document, "input", {
        attributes: {
          "aria-label": `Preview :${state}`,
          "data-part": "pseudo-state-checkbox",
          "data-pseudo-state": state,
          type: "checkbox",
        },
      }) as HTMLInputElement;
      const text = createElement(document, "span", { text: `:${state}` });
      const listener = (event: Event): void => this.onChoiceChanged(
        state,
        input,
        event,
      );
      input.addEventListener("change", listener);
      this.choices.set(state, input);
      this.choiceListeners.set(state, listener);
      label.append(input, text);
      this.menu.append(label);
    }
    this.description = createElement(document, "p", {
      className: "pseudo-state-description",
      attributes: {
        "aria-live": "polite",
        "data-part": "pseudo-state-description",
        id: ids.description,
        role: "status",
      },
    });
    this.element.append(this.button, this.menu, this.description);
    this.button.addEventListener("click", this.onButtonClickListener);
    this.button.addEventListener("keydown", this.onButtonKeyDownListener);
    this.menu.addEventListener("keydown", this.onMenuKeyDownListener);

    // Set before subscribing so an eager source cannot observe an uninitialized
    // controller. Eager notifications are ignored until cleanup ownership is
    // installed, then the latest snapshot is read exactly once.
    this.current = EMPTY_SNAPSHOT;
    let unsubscribe: (() => void) | undefined;
    try {
      let notificationsEnabled = false;
      unsubscribe = dataSource.subscribe(() => {
        if (notificationsEnabled) this.updateFromSource();
      });
      this.unsubscribe = unsubscribe;
      notificationsEnabled = true;
      const revision = ++this.sourceRevision;
      const initial = immutableSnapshot(dataSource.snapshot());
      if (revision === this.sourceRevision) this.current = initial;
      this.render();
    } catch (error) {
      try {
        unsubscribe?.();
      } catch {
        // Preserve the initialization failure.
      }
      this.unsubscribe = undefined;
      this.removeOwnedListeners();
      this.element.remove();
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sourceRevision += 1;
    this.updateRevision += 1;
    this.pendingStates = undefined;
    this.returnFocusAfterUpdate = false;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    let disposeError: unknown;
    try {
      unsubscribe?.();
    } catch (error) {
      disposeError = error;
    }
    this.removeOwnedListeners();
    this.choices.clear();
    this.choiceListeners.clear();
    this.element.replaceChildren();
    this.element.remove();
    if (disposeError !== undefined) throw disposeError;
  }

  private updateFromSource(): void {
    if (this.disposed) return;
    const revision = ++this.sourceRevision;
    let next: PseudoStateSnapshot;
    let localError: string | undefined;
    try {
      next = immutableSnapshot(this.dataSource.snapshot());
    } catch {
      next = ERROR_SNAPSHOT;
      localError = "Pseudo-state preview state could not be read";
    }
    if (this.disposed || revision !== this.sourceRevision) return;
    if (next.state === "unavailable" || next.state === "error") {
      // A lifecycle reset owns authority over any older in-flight request.
      // Fence its eventual completion before a later selection becomes ready.
      this.updateRevision += 1;
      this.pendingStates = undefined;
      this.returnFocusAfterUpdate = false;
    }
    this.current = next;
    this.localError = localError;
    this.render();
  }

  private toggleMenu(): void {
    if (this.disposed || this.button.disabled) return;
    if (this.menu.hidden) this.openMenu(false);
    else this.closeMenu(false);
  }

  private onButtonKeyDown(event: Event): void {
    if (this.disposed || this.button.disabled) return;
    const key = (event as KeyboardEvent).key;
    if (key !== "Enter" && key !== " " && key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    this.openMenu(true);
  }

  private onMenuKeyDown(event: Event): void {
    if (this.disposed || (event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu(true);
  }

  private openMenu(focusFirst: boolean): void {
    if (this.disposed || this.button.disabled) return;
    this.menu.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    if (focusFirst) this.choices.get("hover")?.focus();
  }

  private closeMenu(returnFocus: boolean): void {
    this.menu.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (returnFocus && !this.disposed) this.button.focus();
  }

  private onChoiceChanged(
    state: PseudoState,
    input: HTMLInputElement,
    event: Event,
  ): void {
    event.stopPropagation();
    if (this.disposed || this.pendingStates || !this.isInteractive()) {
      this.renderChoices(this.displayedStates());
      return;
    }
    const selected = new Set(this.current.states);
    if (input.checked) selected.add(state);
    else selected.delete(state);
    const next = Object.freeze(
      PREVIEW_STATES.filter((candidate) => selected.has(candidate)),
    );
    const revision = ++this.updateRevision;
    this.returnFocusAfterUpdate = this.menu.contains(this.document.activeElement);
    this.pendingStates = next;
    this.localError = undefined;
    this.render();

    let update: Promise<void>;
    try {
      update = this.dataSource.setStates(next);
    } catch {
      this.finishUpdate(revision, true);
      return;
    }
    void Promise.resolve(update).then(
      () => this.finishUpdate(revision, false),
      () => this.finishUpdate(revision, true),
    );
  }

  private finishUpdate(revision: number, failed: boolean): void {
    if (this.disposed || revision !== this.updateRevision) return;
    const returnFocus = this.returnFocusAfterUpdate;
    this.returnFocusAfterUpdate = false;
    this.pendingStates = undefined;
    if (failed) {
      this.localError = "Pseudo-state preview update failed";
    }
    this.render();
    const activeElement = this.document.activeElement;
    const focusIsUnowned = activeElement === null ||
      activeElement === this.document.body ||
      this.menu.contains(activeElement);
    if (
      returnFocus &&
      focusIsUnowned &&
      !this.button.disabled &&
      !this.disposed
    ) {
      this.button.focus();
    }
  }

  private render(): void {
    if (this.disposed) return;
    const disabled = !this.isInteractive() ||
      this.pendingStates !== undefined;
    const busy = this.localError === undefined && (
      this.pendingStates !== undefined || this.current.state === "loading"
    );
    this.button.disabled = disabled;
    this.button.setAttribute("aria-busy", busy ? "true" : "false");
    for (const choice of this.choices.values()) choice.disabled = disabled;
    this.renderChoices(this.displayedStates());
    if (disabled) this.closeMenu(false);

    const error = this.localError ?? (this.current.state === "error"
      ? this.current.message ?? "Pseudo-state preview is unavailable"
      : undefined);
    const hasCoverageWarning = this.current.state === "partial" ||
      this.current.unsupportedRuleCount > 0 ||
      this.current.inaccessibleStylesheetCount > 0 ||
      this.current.approximateRuleCount > 0;
    this.description.setAttribute(
      "role",
      error
        ? "alert"
        : hasCoverageWarning || this.current.state !== "ready"
          ? "status"
          : "note",
    );
    this.description.textContent = error
      ? `Pseudo-state preview error: ${error}`
      : descriptionFor(this.current);
  }

  private renderChoices(states: readonly PseudoState[]): void {
    const selected = new Set(states);
    for (const state of PREVIEW_STATES) {
      const choice = this.choices.get(state);
      if (choice) choice.checked = selected.has(state);
    }
  }

  private displayedStates(): readonly PseudoState[] {
    if (this.current.state === "unavailable" || this.current.state === "error") {
      return NO_STATES;
    }
    return this.pendingStates ?? this.current.states;
  }

  private isInteractive(): boolean {
    return this.current.state === "ready" || this.current.state === "partial";
  }

  private removeOwnedListeners(): void {
    this.button.removeEventListener("click", this.onButtonClickListener);
    this.button.removeEventListener("keydown", this.onButtonKeyDownListener);
    this.menu.removeEventListener("keydown", this.onMenuKeyDownListener);
    for (const [state, choice] of this.choices) {
      const listener = this.choiceListeners.get(state);
      if (listener) choice.removeEventListener("change", listener);
    }
  }
}

const NO_STATES = Object.freeze([] as PseudoState[]);
const EMPTY_SNAPSHOT: PseudoStateSnapshot = Object.freeze({
  state: "unavailable",
  states: NO_STATES,
  unsupportedRuleCount: 0,
  inaccessibleStylesheetCount: 0,
  approximateRuleCount: 0,
  reason: "no-selection",
});
const ERROR_SNAPSHOT: PseudoStateSnapshot = Object.freeze({
  state: "error",
  states: NO_STATES,
  unsupportedRuleCount: 0,
  inaccessibleStylesheetCount: 0,
  approximateRuleCount: 0,
});

function immutableSnapshot(snapshot: PseudoStateSnapshot): PseudoStateSnapshot {
  const selected = new Set(snapshot.states);
  return Object.freeze({
    state: snapshot.state,
    states: Object.freeze(
      PREVIEW_STATES.filter((state) => selected.has(state)),
    ),
    unsupportedRuleCount: snapshot.unsupportedRuleCount,
    inaccessibleStylesheetCount: snapshot.inaccessibleStylesheetCount,
    approximateRuleCount: snapshot.approximateRuleCount,
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    ...(snapshot.message ? { message: snapshot.message } : {}),
  });
}

function descriptionFor(snapshot: PseudoStateSnapshot): string {
  if (snapshot.state === "unavailable") {
    return unavailableDescription(snapshot.reason);
  }
  if (snapshot.state === "loading") {
    return "Pseudo-state preview is loading author styles only.";
  }
  const counts = coverageCounts(snapshot);
  if (counts.length > 0 || snapshot.state === "partial") {
    const details = counts.length > 0
      ? counts.join("; ")
      : "coverage is partial";
    return `Pseudo-state preview covers author styles only: ${details}. ` +
      "This is not native browser forcing and not exact cascade parity.";
  }
  return "Preview :hover and :focus for author styles only.";
}

function coverageCounts(snapshot: PseudoStateSnapshot): string[] {
  const counts: string[] = [];
  if (snapshot.unsupportedRuleCount > 0) {
    counts.push(`${snapshot.unsupportedRuleCount} rules unsupported`);
  }
  if (snapshot.inaccessibleStylesheetCount > 0) {
    counts.push(
      `${snapshot.inaccessibleStylesheetCount} stylesheets inaccessible`,
    );
  }
  if (snapshot.approximateRuleCount > 0) {
    counts.push(
      `${snapshot.approximateRuleCount} rules use source-order approximation`,
    );
  }
  return counts;
}

function unavailableDescription(
  reason: PseudoStateDisabledReason | undefined,
): string {
  if (reason === "recovery") {
    return "Pseudo-state preview is unavailable while inspection recovers.";
  }
  if (reason === "disconnected") {
    return "Pseudo-state preview is unavailable because the browser is disconnected.";
  }
  if (reason === "mismatch") {
    return "Pseudo-state preview is unavailable because the browser protocol is incompatible.";
  }
  return "Select an element to use the pseudo-state preview.";
}

function allocateControlIds(
  document: Document,
): { readonly menu: string; readonly description: string } {
  let sequence = nextControlId.get(document) ?? 1;
  while (true) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const ids = {
      menu: `pin-op-pseudo-state-menu${suffix}`,
      description: `pin-op-pseudo-state-description${suffix}`,
    };
    if (Object.values(ids).every((id) => document.getElementById(id) === null)) {
      nextControlId.set(document, sequence + 1);
      return ids;
    }
    sequence += 1;
  }
}

function createElement(
  document: Document,
  tagName: string,
  options: {
    readonly attributes?: Readonly<Record<string, string>>;
    readonly className?: string;
    readonly text?: string;
  } = {},
): HTMLElement {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (options.text !== undefined) element.textContent = options.text;
  return element;
}
