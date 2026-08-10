import {
  ChevronLeft,
  ChevronRight,
  type IconNode,
} from "lucide";
import {
  type DomTreeController,
  type DomTreeKey,
  type DomTreeRow,
} from "./domTreeController.js";
import type {
  SourceNavigationController,
  SourceNavigationViewModel,
} from "./sourceNavigationController.js";
import { createLucideElement } from "./lucideElement.js";

export type DomTreeDocument = Pick<
  Document,
  "activeElement" | "createElement" | "createElementNS" | "getElementById"
>;

export interface DomTreeViewOptions {
  readonly document: DomTreeDocument;
  readonly controller: DomTreeController;
  readonly sourceNavigationController: SourceNavigationController;
  readonly rowHeight?: number;
  readonly overscan?: number;
  readonly createResizeObserver?: DomTreeResizeObserverFactory;
  readonly onError?: (error: unknown) => void;
}

export interface DomTreeResizeObserver {
  observe(target: HTMLElement): void;
  disconnect(): void;
}

export type DomTreeResizeObserverFactory = (
  listener: () => void,
) => DomTreeResizeObserver | undefined;

export const DEFAULT_DOM_TREE_ROW_HEIGHT = 24;
export const DEFAULT_DOM_TREE_OVERSCAN = 6;

const TREE_KEYS = new Set<DomTreeKey>([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
]);

export class DomTreeView {
  private readonly document: DomTreeDocument;
  private readonly controller: DomTreeController;
  private readonly sourceNavigationController: SourceNavigationController;
  private readonly tree: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rowHeight: number;
  private readonly overscan: number;
  private readonly onError: (error: unknown) => void;
  private readonly resizeObserver: DomTreeResizeObserver | undefined;
  private removeControllerListener: (() => void) | undefined;
  private removeSourceNavigationListener: (() => void) | undefined;
  private seenRevealVersion = 0;
  private seenFocusedRef: string | undefined;
  private disposed = false;

  private readonly onScroll = (): void => this.render();
  private readonly onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (!TREE_KEYS.has(keyboardEvent.key as DomTreeKey)) {
      return;
    }
    if (isSourceNavigationTarget(event.target, this.tree)) {
      return;
    }
    event.preventDefault();
    this.run(() => this.controller.handleKey(keyboardEvent.key as DomTreeKey));
  };
  private readonly onClick = (event: Event): void => {
    const action = closestDataValue(event.target, this.tree, "action");
    if (action === "source-previous" || action === "source-next") {
      event.preventDefault();
      event.stopPropagation();
      this.run(() => this.sourceNavigationController.navigate(
        action === "source-previous" ? "previous" : "next",
      ));
      return;
    }
    const row = closestRow(event.target, this.tree);
    if (!row) {
      return;
    }
    const nodeRef = row.dataset.nodeRef;
    if (!nodeRef) {
      return;
    }
    if (action === "toggle") {
      event.preventDefault();
      this.controller.focus(nodeRef);
      this.focusRenderedRow(nodeRef);
      this.run(() => this.controller.toggle(nodeRef));
      return;
    }
    const rowType = row.dataset.rowType;
    this.controller.focus(nodeRef);
    this.focusRenderedRow(nodeRef);
    if (rowType === "load-more") {
      const parentRef = row.dataset.parentRef;
      if (parentRef) {
        this.run(() => this.controller.loadMore(parentRef));
      }
      return;
    }
    this.run(() => this.controller.select(nodeRef));
  };
  private readonly onPointerOver = (event: Event): void => {
    const row = closestRow(event.target, this.tree);
    if (
      !row ||
      row.dataset.rowType !== "node" ||
      row.dataset.rowKind !== "element" ||
      row.dataset.loading === "true" ||
      row.dataset.inaccessible === "true"
    ) {
      this.controller.clearHover();
      return;
    }
    const nodeRef = row.dataset.nodeRef;
    if (nodeRef) {
      this.controller.hover(nodeRef);
    }
  };
  private readonly onPointerLeave = (): void => this.controller.clearHover();

  public constructor(options: DomTreeViewOptions) {
    this.document = options.document;
    this.controller = options.controller;
    this.sourceNavigationController = options.sourceNavigationController;
    this.tree = requiredElement(options.document, "dom-tree");
    this.spacer = requiredElement(options.document, "dom-tree-spacer");
    this.empty = requiredElement(options.document, "dom-tree-empty");
    this.rowHeight = positiveInteger(
      options.rowHeight,
      DEFAULT_DOM_TREE_ROW_HEIGHT,
      "row height",
    );
    this.overscan = nonnegativeInteger(
      options.overscan,
      DEFAULT_DOM_TREE_OVERSCAN,
      "overscan",
    );
    this.onError = options.onError ?? (() => undefined);
    this.resizeObserver = (
      options.createResizeObserver ?? createDefaultResizeObserver
    )(() => this.render());

    this.tree.setAttribute("role", "tree");
    this.tree.setAttribute("aria-label", "DOM tree");
    this.tree.addEventListener("scroll", this.onScroll);
    this.tree.addEventListener("keydown", this.onKeyDown);
    this.tree.addEventListener("click", this.onClick);
    this.tree.addEventListener("pointerover", this.onPointerOver);
    this.tree.addEventListener("pointerleave", this.onPointerLeave);
    this.resizeObserver?.observe(this.tree);
    this.removeControllerListener = this.controller.subscribe(() => this.render());
    this.removeSourceNavigationListener =
      this.sourceNavigationController.subscribe(() => this.render());
    this.render();
  }

  public render(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.controller.snapshot();
    const sourceNavigation = this.sourceNavigationController.snapshot();
    const focusChanged = snapshot.focusedRef !== this.seenFocusedRef;
    if (
      snapshot.revealRef &&
      snapshot.revealVersion > this.seenRevealVersion
    ) {
      this.seenRevealVersion = snapshot.revealVersion;
      this.ensureVisible(snapshot.revealRef);
    } else if (focusChanged && snapshot.focusedRef) {
      this.ensureVisible(snapshot.focusedRef);
    }
    this.seenFocusedRef = snapshot.focusedRef;

    const allRows = this.controller.rows();
    const viewportSize = Math.max(
      1,
      Math.ceil(Math.max(this.tree.clientHeight, this.rowHeight) / this.rowHeight),
    );
    const start = Math.max(0, Math.floor(this.tree.scrollTop / this.rowHeight));
    const rows = this.controller.visibleRows({
      start,
      size: viewportSize,
      overscan: this.overscan,
    });
    if (
      rows.length > 0 &&
      !rows.some(({ value }) => (
        value.nodeRef === snapshot.focusedRef && isFocusableRow(value)
      ))
    ) {
      const viewportFocus = rows.find(({ index, value }) => (
        index >= start &&
        index < start + viewportSize &&
        isFocusableRow(value)
      )) ?? rows.find(({ value }) => isFocusableRow(value));
      if (viewportFocus) {
        this.seenFocusedRef = viewportFocus.value.nodeRef;
        this.controller.focus(viewportFocus.value.nodeRef);
        return;
      }
    }
    const restoreFocus = this.tree.contains(this.document.activeElement);

    this.spacer.style.height = `${allRows.length * this.rowHeight}px`;
    this.tree.setAttribute("aria-busy", snapshot.loadingRoot ? "true" : "false");
    this.empty.hidden = allRows.length > 0 || snapshot.loadingRoot;
    this.spacer.replaceChildren(...rows.map(({ index, value }) => (
      this.createRow(value, index, sourceNavigation)
    )));

    if (restoreFocus && snapshot.focusedRef) {
      this.focusRenderedRow(snapshot.focusedRef);
    }
  }

  public focus(nodeRef: string): void {
    this.controller.focus(nodeRef);
    this.focusRenderedRow(nodeRef);
  }

  public key(key: DomTreeKey): Promise<void> {
    return this.controller.handleKey(key);
  }

  public focusedRef(): string | undefined {
    return this.controller.focusedRef;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeControllerListener?.();
    this.removeControllerListener = undefined;
    this.removeSourceNavigationListener?.();
    this.removeSourceNavigationListener = undefined;
    this.tree.removeEventListener("scroll", this.onScroll);
    this.tree.removeEventListener("keydown", this.onKeyDown);
    this.tree.removeEventListener("click", this.onClick);
    this.tree.removeEventListener("pointerover", this.onPointerOver);
    this.tree.removeEventListener("pointerleave", this.onPointerLeave);
    this.resizeObserver?.disconnect();
    this.spacer.replaceChildren();
  }

  private createRow(
    row: DomTreeRow,
    index: number,
    sourceNavigation: SourceNavigationViewModel,
  ): HTMLElement {
    const element = this.document.createElement("div");
    element.className = rowClassName(row);
    element.dataset.nodeRef = row.nodeRef;
    element.dataset.rowType = row.type;
    element.dataset.rowKind = row.kind;
    element.dataset.loading = String(row.loading);
    element.dataset.inaccessible = String(row.inaccessible);
    if (row.parentRef) {
      element.dataset.parentRef = row.parentRef;
    }
    element.setAttribute("role", "treeitem");
    element.setAttribute("aria-level", String(row.depth));
    element.setAttribute("aria-selected", String(row.selected));
    element.setAttribute(
      "tabindex",
      row.focused && isFocusableRow(row) ? "0" : "-1",
    );
    if (row.inaccessible) {
      element.setAttribute("aria-disabled", "true");
    }
    if (row.type === "node" && row.expandable && !row.inaccessible) {
      element.setAttribute("aria-expanded", String(row.expanded));
    }
    element.style.height = `${this.rowHeight}px`;
    element.style.transform = `translateY(${index * this.rowHeight}px)`;
    element.style.paddingInlineStart = `${Math.max(0, row.depth - 1) * 14 + 4}px`;

    const disclosure = this.document.createElement("span");
    disclosure.className = "dom-tree-disclosure";
    disclosure.dataset.part = "disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    if (row.type === "node" && row.expandable && !row.inaccessible) {
      disclosure.dataset.action = "toggle";
    }

    const label = this.document.createElement("span");
    label.className = "dom-tree-label";
    label.dataset.part = "label";
    label.textContent = row.label;
    element.append(disclosure, label);
    if (row.selected && sourceNavigation.reserveRowSpace) {
      element.append(this.createSourceNavigationControls(sourceNavigation));
    }
    return element;
  }

  private createSourceNavigationControls(
    model: SourceNavigationViewModel,
  ): HTMLElement {
    const controls = this.document.createElement("span");
    controls.className = "source-navigation-controls";
    controls.dataset.part = "source-navigation-controls";
    if (!model.visible) {
      controls.setAttribute("aria-hidden", "true");
      return controls;
    }

    controls.append(
      this.createSourceNavigationButton(
        "source-previous",
        "Previous source match",
        ChevronLeft,
        model.disabled,
      ),
      this.createSourceNavigationButton(
        "source-next",
        "Next source match",
        ChevronRight,
        model.disabled,
      ),
    );
    return controls;
  }

  private createSourceNavigationButton(
    action: "source-previous" | "source-next",
    label: string,
    icon: IconNode,
    disabled: boolean,
  ): HTMLButtonElement {
    const button = this.document.createElement("button") as HTMLButtonElement;
    button.className = "source-navigation-button";
    button.dataset.action = action;
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.disabled = disabled;
    button.append(createNavigationIcon(this.document, icon));
    return button;
  }

  private ensureVisible(nodeRef: string): void {
    const index = this.controller.rows().findIndex((row) => row.nodeRef === nodeRef);
    if (index < 0) {
      return;
    }
    const top = index * this.rowHeight;
    const bottom = top + this.rowHeight;
    const viewportHeight = Math.max(this.tree.clientHeight, this.rowHeight);
    if (top < this.tree.scrollTop) {
      this.tree.scrollTop = top;
    } else if (bottom > this.tree.scrollTop + viewportHeight) {
      this.tree.scrollTop = bottom - viewportHeight;
    }
  }

  private focusRenderedRow(nodeRef: string): void {
    const row = findRenderedRow(this.spacer, nodeRef);
    if (!row) {
      return;
    }
    try {
      row.focus({ preventScroll: true });
    } catch {
      row.focus();
    }
  }

  private run(action: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(action)
      .catch((error) => {
        try {
          this.onError(error);
        } catch {
          // Diagnostics cannot break the tree interaction loop.
        }
      });
  }
}

function rowClassName(row: DomTreeRow): string {
  const names = ["dom-tree-row", `is-${row.kind}`];
  if (row.expanded) names.push("is-expanded");
  if (row.selected) names.push("is-selected");
  if (row.focused) names.push("is-focused");
  if (row.hovered) names.push("is-hovered");
  if (row.loading) names.push("is-loading");
  if (row.inaccessible) names.push("is-inaccessible");
  return names.join(" ");
}

function isFocusableRow(row: DomTreeRow): boolean {
  return row.type === "node" || !row.loading;
}

function findRenderedRow(root: HTMLElement, nodeRef: string): HTMLElement | undefined {
  for (const child of root.children) {
    if (isElementLike(child) && child.dataset.nodeRef === nodeRef) {
      return child;
    }
  }
  return undefined;
}

function closestRow(target: EventTarget | null, boundary: HTMLElement): HTMLElement | undefined {
  let candidate: unknown = target;
  while (isElementLike(candidate) && candidate !== boundary) {
    if (candidate.dataset.nodeRef && candidate.dataset.rowType) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return undefined;
}

function closestDataValue(
  target: EventTarget | null,
  boundary: HTMLElement,
  key: string,
): string | undefined {
  let candidate: unknown = target;
  while (isElementLike(candidate) && candidate !== boundary) {
    const value = candidate.dataset[key];
    if (value) {
      return value;
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

function requiredElement(document: DomTreeDocument, id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing DOM tree element: ${id}`);
  }
  return element;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 256) {
    throw new RangeError(`Invalid DOM tree ${label}`);
  }
  return result;
}

function nonnegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > 256) {
    throw new RangeError(`Invalid DOM tree ${label}`);
  }
  return result;
}

function createDefaultResizeObserver(
  listener: () => void,
): DomTreeResizeObserver | undefined {
  if (typeof ResizeObserver !== "function") {
    return undefined;
  }
  return new ResizeObserver(() => listener());
}

function isSourceNavigationTarget(
  target: EventTarget | null,
  boundary: HTMLElement,
): boolean {
  const action = closestDataValue(target, boundary, "action");
  return (
    action === "source-previous" ||
    action === "source-next" ||
    closestDataValue(target, boundary, "part") ===
      "source-navigation-controls"
  );
}

function createNavigationIcon(
  ownerDocument: DomTreeDocument,
  icon: IconNode,
): Element {
  const element = createLucideElement(ownerDocument, icon);
  element.setAttribute("aria-hidden", "true");
  return element;
}
