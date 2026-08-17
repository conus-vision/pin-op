import type { SourceExcerpt } from "@pin-op/protocol";
import {
  type SourcePaneController,
  type SourcePaneGroup,
  type SourcePaneViewModel,
} from "./sourcePaneController.js";

export type SourcePaneDocument = Pick<
  Document,
  "activeElement" | "createElement" | "createTextNode"
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
  readonly group: GroupKey;
  readonly element: HTMLButtonElement;
}

interface CreatedExcerpt {
  readonly item: HTMLElement;
  readonly openButton: HTMLButtonElement;
}

interface RenderedGroup {
  readonly section: HTMLElement;
  readonly toggle: HTMLButtonElement;
}

type FocusRestoreTarget =
  | { readonly kind: "source" }
  | { readonly kind: "toggle"; readonly group: GroupKey }
  | {
      readonly kind: "match";
      readonly group: GroupKey;
      readonly matchId: string;
    };

interface FocusRestoreCandidates {
  readonly toggles?: Readonly<Record<GroupKey, HTMLButtonElement>>;
  readonly status?: HTMLElement;
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
    if (
      action.name === "open-source" ||
      action.name === "open-source-item"
    ) {
      event.preventDefault();
      this.open(action.element.dataset.matchId);
    }
  };

  public constructor(options: SourcePaneViewOptions) {
    this.document = options.document;
    this.root = options.root;
    this.controller = options.controller;
    this.onError = options.onError ?? (() => undefined);
    this.root.className = appendClass(this.root.className, "source-pane");
    this.root.addEventListener("click", this.onClick);
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
    this.run(() => this.root.replaceChildren());
  }

  private renderCurrent(): void {
    const focusTarget = this.captureFocusTarget();
    const epoch = this.renderEpoch + 1;
    this.renderEpoch = epoch;
    this.renderedEntries = Object.freeze([]);
    if (this.state.kind !== "ready") {
      const status = this.createStatus(this.state.kind, this.state.statusText);
      this.root.replaceChildren(status);
      this.restoreFocus(focusTarget, { status });
      return;
    }

    const model = this.controller.snapshot();
    this.resetDisclosureFromModel(model);
    const children: HTMLElement[] = [];
    const header = this.createDocumentHeader(model);
    if (header) children.push(header);

    const entries: RenderedEntry[] = [];
    const selectedGroup = this.createGroup(
      "selected",
      model.groups.selected,
      this.selectedCollapsed,
      epoch,
      entries,
    );
    const parentGroup = this.createGroup(
      "parent",
      model.groups.parent,
      this.parentCollapsed,
      epoch,
      entries,
    );
    children.push(selectedGroup.section, parentGroup.section);
    if (model.omittedMatchCount > 0) {
      const omitted = this.document.createElement("p");
      omitted.className = "source-pane-omitted";
      omitted.dataset.part = "omitted-matches";
      omitted.textContent = `${model.omittedMatchCount} additional matches omitted`;
      children.push(omitted);
    }
    const authoritativeMatchCount =
      model.groups.selected.matches.length +
      model.groups.parent.matches.length +
      model.omittedMatchCount;
    if (authoritativeMatchCount === 0) {
      children.push(this.createStatus("empty", "No source matches"));
    }
    this.root.replaceChildren(...children);
    this.renderedEntries = Object.freeze(entries);
    this.restoreFocus(focusTarget, {
      toggles: {
        selected: selectedGroup.toggle,
        parent: parentGroup.toggle,
      },
    });
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
  ): RenderedGroup {
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
      const list = this.document.createElement("ul");
      list.className = "source-pane-list";
      list.dataset.groupList = key;
      list.setAttribute("aria-label", `${group.label} source matches`);
      for (const match of group.matches) {
        const excerpt = this.createExcerpt(match, key, epoch);
        entries.push({
          matchId: match.matchId,
          group: key,
          element: excerpt.openButton,
        });
        list.append(excerpt.item);
      }
      section.append(list);
    }
    return { section, toggle: disclosure };
  }

  private createExcerpt(
    match: SourceExcerpt,
    group: GroupKey,
    epoch: number,
  ): CreatedExcerpt {
    const active = this.controller.snapshot().activeMatchId === match.matchId;
    const item = this.document.createElement("li");
    item.className = active
      ? "source-pane-entry is-active"
      : "source-pane-entry";
    item.dataset.action = "open-source-item";
    item.dataset.matchId = match.matchId;
    item.dataset.group = group;
    item.dataset.renderEpoch = String(epoch);

    const heading = this.document.createElement("div");
    heading.className = "source-pane-entry-heading";
    const label = this.document.createElement("span");
    label.className = "source-pane-entry-label";
    label.textContent = match.label;
    const lines = this.document.createElement("span");
    lines.className = "source-pane-entry-lines";
    lines.textContent = lineLabel(match.startLine, match.endLine);
    const openButton = this.document.createElement("button") as HTMLButtonElement;
    openButton.className = "source-pane-open";
    openButton.dataset.action = "open-source";
    openButton.dataset.matchId = match.matchId;
    openButton.dataset.openMatchId = match.matchId;
    openButton.dataset.group = group;
    openButton.dataset.renderEpoch = String(epoch);
    openButton.setAttribute("type", "button");
    openButton.setAttribute(
      "aria-label",
      `Open ${match.label}, ${lineLabel(match.startLine, match.endLine)}`,
    );
    if (active) {
      openButton.setAttribute("aria-current", "true");
    }
    openButton.textContent = "Open";
    heading.append(label, lines, openButton);
    item.append(heading);

    const pre = this.document.createElement("pre");
    pre.className = "source-pane-excerpt";
    const code = this.document.createElement("code");
    code.append(this.document.createTextNode(match.text));
    pre.append(code);
    item.append(pre);

    if (match.truncated) {
      const truncated = this.document.createElement("span");
      truncated.className = "source-pane-truncated";
      truncated.textContent = "Excerpt truncated";
      item.append(truncated);
    }
    return { item, openButton };
  }

  private createStatus(kind: Exclude<SourcePaneViewState["kind"], "ready">, text: string): HTMLElement {
    const status = this.document.createElement("p");
    status.className = `source-pane-status is-${kind}`;
    status.dataset.state = kind;
    status.setAttribute("tabindex", "-1");
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
    if (!matchId) {
      return;
    }
    if (!this.currentEntry(matchId)) return;
    this.run(() => {
      this.controller.open(matchId);
    });
  }

  private currentEntry(matchId: string): RenderedEntry | undefined {
    return this.renderedEntries.find((entry) => entry.matchId === matchId);
  }

  private captureFocusTarget(): FocusRestoreTarget | undefined {
    const activeElement = this.document.activeElement;
    if (
      !isElementLike(activeElement) ||
      !isWithinBoundary(activeElement, this.root)
    ) {
      return undefined;
    }
    const action = closestAction(activeElement, this.root);
    if (
      !action ||
      action.element.dataset.renderEpoch !== String(this.renderEpoch)
    ) {
      return { kind: "source" };
    }
    const group = groupKey(action.element.dataset.group);
    if (!group) {
      return { kind: "source" };
    }
    if (action.name === "toggle-group") {
      return { kind: "toggle", group };
    }
    const matchId = action.element.dataset.matchId;
    return action.name === "open-source" && matchId
      ? { kind: "match", group, matchId }
      : { kind: "source" };
  }

  private restoreFocus(
    target: FocusRestoreTarget | undefined,
    candidates: FocusRestoreCandidates,
  ): void {
    if (!target || this.disposed) {
      return;
    }
    let element: HTMLElement | undefined;
    if (target.kind === "toggle") {
      element = candidates.toggles?.[target.group];
    } else if (target.kind === "match") {
      element = this.renderedEntries.find(
        (entry) =>
          entry.group === target.group && entry.matchId === target.matchId,
      )?.element ?? candidates.toggles?.[target.group];
    }
    element ??= candidates.status;
    if (!element) {
      this.root.setAttribute("tabindex", "-1");
      element = this.root;
    }
    this.run(() => {
      if (!this.disposed) {
        element.focus();
      }
    });
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

function isWithinBoundary(element: HTMLElement, boundary: HTMLElement): boolean {
  let candidate: HTMLElement | null = element;
  while (candidate) {
    if (candidate === boundary) {
      return true;
    }
    candidate = candidate.parentElement;
  }
  return false;
}

function appendClass(existing: string, className: string): string {
  const names = existing.split(/\s+/).filter(Boolean);
  if (!names.includes(className)) names.push(className);
  return names.join(" ");
}
