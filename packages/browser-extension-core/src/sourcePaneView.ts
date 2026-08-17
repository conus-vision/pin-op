import type { SourceExcerpt } from "@pin-op/protocol";
import {
  type SourcePaneController,
  type SourcePaneGroup,
  type SourcePaneViewModel,
} from "./sourcePaneController.js";

export type SourcePaneDocument = Pick<
  Document,
  "createElement" | "createTextNode"
>;

export type SourcePaneViewState =
  | { readonly kind: "ready" }
  | { readonly kind: "loading"; readonly statusText: string }
  | { readonly kind: "empty"; readonly statusText: string }
  | { readonly kind: "error"; readonly statusText: string }
  | { readonly kind: "incompatible"; readonly statusText: string };

export interface SourcePaneViewOptions {
  readonly document: SourcePaneDocument;
  readonly root: HTMLElement;
  readonly controller: SourcePaneController;
  readonly onError?: (error: unknown) => void;
}

type GroupKey = "selected" | "parent";

interface RenderedEntry {
  readonly matchId: string;
  readonly element: HTMLElement;
}

const READY_STATE: SourcePaneViewState = Object.freeze({ kind: "ready" });

export class SourcePaneView {
  private readonly document: SourcePaneDocument;
  private readonly root: HTMLElement;
  private readonly controller: SourcePaneController;
  private readonly onError: (error: unknown) => void;
  private removeControllerListener: (() => void) | undefined;
  private state = READY_STATE;
  private selectedMatches: readonly SourceExcerpt[] | undefined;
  private parentMatches: readonly SourceExcerpt[] | undefined;
  private selectedCollapsed = false;
  private parentCollapsed = true;
  private renderedEntries: readonly RenderedEntry[] = Object.freeze([]);
  private renderEpoch = 0;
  private disposed = false;

  private readonly onClick = (event: Event): void => {
    if (this.disposed || this.state.kind !== "ready") {
      return;
    }
    const action = closestAction(event.target, this.root);
    if (!action || action.element.dataset.renderEpoch !== String(this.renderEpoch)) {
      return;
    }
    if (action.name === "toggle-group") {
      const group = groupKey(action.element.dataset.group);
      if (!group) return;
      event.preventDefault();
      this.toggleGroup(group);
      return;
    }
    if (action.name === "open-source") {
      event.preventDefault();
      this.open(action.element.dataset.matchId);
    }
  };

  private readonly onKeyDown = (event: Event): void => {
    if (this.disposed || this.state.kind !== "ready") {
      return;
    }
    const keyboardEvent = event as KeyboardEvent;
    const action = closestAction(event.target, this.root);
    if (!action || action.element.dataset.renderEpoch !== String(this.renderEpoch)) {
      return;
    }
    if (
      action.name === "toggle-group" &&
      (keyboardEvent.key === "Enter" || keyboardEvent.key === " ")
    ) {
      const group = groupKey(action.element.dataset.group);
      if (!group) return;
      event.preventDefault();
      this.toggleGroup(group);
      return;
    }
    if (action.name !== "open-source") {
      return;
    }
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
      event.preventDefault();
      this.open(action.element.dataset.matchId);
      return;
    }
    const direction = keyboardDirection(keyboardEvent.key);
    if (!direction) {
      return;
    }
    event.preventDefault();
    this.focusEntry(action.element.dataset.matchId, direction);
  };

  public constructor(options: SourcePaneViewOptions) {
    this.document = options.document;
    this.root = options.root;
    this.controller = options.controller;
    this.onError = options.onError ?? (() => undefined);
    this.root.className = appendClass(this.root.className, "source-pane");
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("keydown", this.onKeyDown);
    this.removeControllerListener = this.controller.subscribe(() => this.render());
    this.render();
  }

  public setState(state: SourcePaneViewState): void {
    if (this.disposed) {
      return;
    }
    this.state = snapshotState(state);
    this.render();
  }

  public render(): void {
    if (this.disposed) {
      return;
    }
    this.run(() => this.renderCurrent());
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.renderEpoch += 1;
    this.renderedEntries = Object.freeze([]);
    this.removeControllerListener?.();
    this.removeControllerListener = undefined;
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.run(() => this.root.replaceChildren());
  }

  private renderCurrent(): void {
    const epoch = this.renderEpoch + 1;
    this.renderEpoch = epoch;
    this.renderedEntries = Object.freeze([]);
    if (this.state.kind !== "ready") {
      this.root.replaceChildren(this.createStatus(this.state.kind, this.state.statusText));
      return;
    }

    const model = this.controller.snapshot();
    this.resetDisclosureFromModel(model);
    const children: HTMLElement[] = [];
    const header = this.createDocumentHeader(model);
    if (header) children.push(header);

    const entries: RenderedEntry[] = [];
    children.push(
      this.createGroup("selected", model.groups.selected, this.selectedCollapsed, epoch, entries),
      this.createGroup("parent", model.groups.parent, this.parentCollapsed, epoch, entries),
    );
    if (model.omittedMatchCount > 0) {
      const omitted = this.document.createElement("p");
      omitted.className = "source-pane-omitted";
      omitted.dataset.part = "omitted-matches";
      omitted.textContent = `${model.omittedMatchCount} additional matches omitted`;
      children.push(omitted);
    }
    if (entries.length === 0 && model.omittedMatchCount === 0) {
      children.push(this.createStatus("empty", "No source matches"));
    }
    this.root.replaceChildren(...children);
    this.renderedEntries = Object.freeze(entries);
  }

  private createDocumentHeader(model: SourcePaneViewModel): HTMLElement | undefined {
    if (!model.document) {
      return undefined;
    }
    const header = this.document.createElement("header");
    header.className = "source-pane-document";
    header.dataset.part = "document";

    const label = this.document.createElement("span");
    label.className = "source-pane-document-label";
    label.textContent = model.document.label;
    const language = this.document.createElement("span");
    language.className = "source-pane-document-language";
    language.textContent = model.document.languageId;
    header.append(label, language);
    return header;
  }

  private createGroup(
    key: GroupKey,
    group: SourcePaneGroup,
    collapsed: boolean,
    epoch: number,
    entries: RenderedEntry[],
  ): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "source-pane-group";
    section.dataset.groupSection = key;

    const disclosure = this.document.createElement("button") as HTMLButtonElement;
    disclosure.className = "source-pane-group-toggle";
    disclosure.dataset.action = "toggle-group";
    disclosure.dataset.group = key;
    disclosure.dataset.renderEpoch = String(epoch);
    disclosure.setAttribute("type", "button");
    disclosure.setAttribute("aria-expanded", String(!collapsed));
    disclosure.textContent = group.label;
    section.append(disclosure);

    if (!collapsed) {
      const list = this.document.createElement("div");
      list.className = "source-pane-list";
      list.dataset.groupList = key;
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", `${group.label} source matches`);
      for (const match of group.matches) {
        const row = this.createExcerpt(match, epoch);
        entries.push({ matchId: match.matchId, element: row });
        list.append(row);
      }
      section.append(list);
    }
    return section;
  }

  private createExcerpt(match: SourceExcerpt, epoch: number): HTMLElement {
    const active = this.controller.snapshot().activeMatchId === match.matchId;
    const row = this.document.createElement("div");
    row.className = active
      ? "source-pane-entry is-active"
      : "source-pane-entry";
    row.dataset.action = "open-source";
    row.dataset.matchId = match.matchId;
    row.dataset.renderEpoch = String(epoch);
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-selected", String(active));

    const heading = this.document.createElement("div");
    heading.className = "source-pane-entry-heading";
    const label = this.document.createElement("span");
    label.className = "source-pane-entry-label";
    label.textContent = match.label;
    const lines = this.document.createElement("span");
    lines.className = "source-pane-entry-lines";
    lines.textContent = lineLabel(match.startLine, match.endLine);
    heading.append(label, lines);
    row.append(heading);

    const pre = this.document.createElement("pre");
    pre.className = "source-pane-excerpt";
    const code = this.document.createElement("code");
    code.append(this.document.createTextNode(match.text));
    pre.append(code);
    row.append(pre);

    if (match.truncated) {
      const truncated = this.document.createElement("span");
      truncated.className = "source-pane-truncated";
      truncated.textContent = "Excerpt truncated";
      row.append(truncated);
    }
    return row;
  }

  private createStatus(kind: Exclude<SourcePaneViewState["kind"], "ready">, text: string): HTMLElement {
    const status = this.document.createElement("p");
    status.className = `source-pane-status is-${kind}`;
    status.dataset.state = kind;
    status.setAttribute("role", kind === "error" || kind === "incompatible" ? "alert" : "status");
    status.textContent = text;
    return status;
  }

  private resetDisclosureFromModel(model: SourcePaneViewModel): void {
    if (model.groups.selected.matches !== this.selectedMatches) {
      this.selectedMatches = model.groups.selected.matches;
      this.selectedCollapsed = model.groups.selected.collapsed;
    }
    if (model.groups.parent.matches !== this.parentMatches) {
      this.parentMatches = model.groups.parent.matches;
      this.parentCollapsed = model.groups.parent.collapsed;
    }
  }

  private toggleGroup(group: GroupKey): void {
    if (group === "selected") {
      this.selectedCollapsed = !this.selectedCollapsed;
    } else {
      this.parentCollapsed = !this.parentCollapsed;
    }
    this.render();
  }

  private open(matchId: string | undefined): void {
    if (!matchId || !this.currentEntry(matchId)) {
      return;
    }
    this.run(() => {
      this.controller.open(matchId);
    });
  }

  private focusEntry(
    currentMatchId: string | undefined,
    direction: "previous" | "next" | "first" | "last",
  ): void {
    if (!currentMatchId || this.renderedEntries.length === 0) {
      return;
    }
    const current = this.renderedEntries.findIndex(({ matchId }) => matchId === currentMatchId);
    if (current < 0) {
      return;
    }
    const index = direction === "first"
      ? 0
      : direction === "last"
        ? this.renderedEntries.length - 1
        : direction === "previous"
          ? Math.max(0, current - 1)
          : Math.min(this.renderedEntries.length - 1, current + 1);
    this.run(() => this.renderedEntries[index]?.element.focus());
  }

  private currentEntry(matchId: string): RenderedEntry | undefined {
    return this.renderedEntries.find((entry) => entry.matchId === matchId);
  }

  private run(action: () => void): void {
    try {
      action();
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        // Diagnostics must not break source-pane lifecycle.
      }
    }
  }
}

function snapshotState(state: SourcePaneViewState): SourcePaneViewState {
  if (state.kind === "ready") {
    return READY_STATE;
  }
  return Object.freeze({ kind: state.kind, statusText: String(state.statusText) });
}

function lineLabel(startLine: number, endLine: number): string {
  return startLine === endLine
    ? `Line ${startLine}`
    : `Lines ${startLine}-${endLine}`;
}

function groupKey(value: string | undefined): GroupKey | undefined {
  return value === "selected" || value === "parent" ? value : undefined;
}

function keyboardDirection(
  key: string,
): "previous" | "next" | "first" | "last" | undefined {
  if (key === "ArrowUp") return "previous";
  if (key === "ArrowDown") return "next";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return undefined;
}

function closestAction(
  target: EventTarget | null,
  boundary: HTMLElement,
): { readonly name: string; readonly element: HTMLElement } | undefined {
  let candidate: unknown = target;
  while (isElementLike(candidate) && candidate !== boundary) {
    const name = candidate.dataset.action;
    if (name) {
      return { name, element: candidate };
    }
    candidate = candidate.parentElement;
  }
  return undefined;
}

function isElementLike(value: unknown): value is HTMLElement {
  return Boolean(
    value &&
    typeof value === "object" &&
    "dataset" in value &&
    "parentElement" in value,
  );
}

function appendClass(existing: string, className: string): string {
  const names = existing.split(/\s+/).filter(Boolean);
  if (!names.includes(className)) names.push(className);
  return names.join(" ");
}
