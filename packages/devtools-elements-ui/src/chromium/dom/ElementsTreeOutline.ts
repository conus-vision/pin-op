// Copyright 2021 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Copyright (C) 2007, 2008 Apple Inc.  All rights reserved.
 * Copyright (C) 2008 Matt Lilek <webkit@mattlilek.com>
 * Copyright (C) 2009 Joseph Pecoraro
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/*
 * Pin-op adaptation of
 * front_end/panels/elements/ElementsTreeOutline.ts at Chromium DevTools
 * revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains bounded row reconciliation, disclosure, keyboard navigation,
 * selection, and hover. Chromium tree widgets, SDK/host dependencies,
 * editing, drag/drop, clipboard mutation, and context menus are omitted.
 */

import type {
  TreeDataSource,
  TreeRowSnapshot,
} from "../../contracts.js";
import {
  ElementsTreeElement,
  type TreeItemPosition,
} from "./ElementsTreeElement.js";

export const DEFAULT_MAX_VISIBLE_TREE_ROWS = 512;
const MIN_VISIBLE_TREE_ROWS = 1;
const MAX_PENDING_TREE_COMMANDS = DEFAULT_MAX_VISIBLE_TREE_ROWS;
const TREE_ROW_HEIGHT_PX = 20;
const TREE_OVERSCAN_ROWS = 2;
const ZERO_HEIGHT_FALLBACK_ROWS = 32;
const MAX_VIRTUAL_EXTENT_PX = 33_554_432;
const MAX_VIRTUAL_SPACER_ROWS = Math.floor(MAX_VIRTUAL_EXTENT_PX / TREE_ROW_HEIGHT_PX);
const VIRTUAL_SPACER_ROW_SPANS = Object.freeze(
  Array.from(
    { length: Math.floor(Math.log2(MAX_VIRTUAL_SPACER_ROWS)) + 1 },
    (_, index) => 2 ** (Math.floor(Math.log2(MAX_VIRTUAL_SPACER_ROWS)) - index),
  ),
);

export interface ElementsTreeOutlineOptions {
  readonly maxVisibleRows?: number;
  readonly resizeObserverFactory?: (
    callback: () => void,
  ) => ElementsTreeResizeObserver;
}

interface RenderedInteraction {
  readonly authority: InteractionAuthority;
  readonly rendered: ElementsTreeElement;
}

interface InteractionAuthority {
  readonly nodeRef: string;
  readonly type: TreeRowSnapshot["type"];
  readonly parentRef: string | undefined;
  readonly kind: NonNullable<TreeRowSnapshot["node"]>["kind"] | undefined;
  readonly nodeName: string | undefined;
  readonly branchRevision: number | undefined;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly selectable: boolean | undefined;
  readonly inaccessible: boolean | undefined;
}

interface ElementsTreeResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

interface VirtualLayout {
  readonly scrollTop: number;
  readonly viewportStart: number;
  readonly viewportRowCount: number;
  readonly windowStart: number;
  readonly windowRowCount: number;
}

export class ElementsTreeOutline {
  public readonly element: HTMLElement;
  private readonly renderedRows = new Map<string, ElementsTreeElement>();
  private readonly pendingCommands = new Set<string>();
  private allRows: readonly TreeRowSnapshot[] = [];
  private itemPositions: ReadonlyMap<TreeRowSnapshot, TreeItemPosition> = new Map();
  private visibleRows: readonly TreeRowSnapshot[] = [];
  private windowStart = 0;
  private focusedRef: string | undefined;
  private hoveredRef: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private resizeObserver: ElementsTreeResizeObserver | undefined;
  private disposed = false;
  private renderGeneration = 0;
  private readonly maxVisibleRows: number;
  private readonly onClickListener = (event: Event): void => this.onClick(event);
  private readonly onKeyDownListener = (event: Event): void => this.onKeyDown(event);
  private readonly onPointerMoveListener = (event: Event): void => this.onPointerMove(event);
  private readonly onPointerLeaveListener = (): void => this.onPointerLeave();
  private readonly onScrollListener = (): void => this.onScroll();

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    private readonly dataSource: TreeDataSource,
    options: ElementsTreeOutlineOptions = {},
  ) {
    this.maxVisibleRows = normalizeVisibleRowLimit(options.maxVisibleRows);
    this.element = createElement(document, "div", {
      className: "pin-op-elements-inspector__tree elements-disclosure elements-tree-outline",
      attributes: {
        "aria-label": "DOM tree",
        "data-part": "dom-rows",
        role: "tree",
        tabindex: "-1",
      },
    });
    this.element.addEventListener("click", this.onClickListener);
    this.element.addEventListener("keydown", this.onKeyDownListener);
    this.element.addEventListener("pointermove", this.onPointerMoveListener);
    this.element.addEventListener("pointerleave", this.onPointerLeaveListener);
    this.element.addEventListener("scroll", this.onScrollListener);

    try {
      this.unsubscribe = dataSource.subscribe(() => this.renderRows());
      this.renderRows();
      if (!this.disposed) mount.append(this.element);
      if (!this.disposed) {
        const resizeObserver = createResizeObserver(
          document,
          options.resizeObserverFactory,
          () => this.onResize(),
        );
        this.resizeObserver = resizeObserver;
        resizeObserver?.observe(this.element);
      }
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderGeneration += 1;
    this.clearHover();
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } finally {
      this.disconnectResizeObserver();
      this.cleanupListeners();
      this.pendingCommands.clear();
      this.renderedRows.clear();
      this.allRows = [];
      this.itemPositions = new Map();
      this.visibleRows = [];
      this.element.replaceChildren();
      this.element.remove();
    }
  }

  private cleanup(): void {
    this.disposed = true;
    this.renderGeneration += 1;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } finally {
      this.disconnectResizeObserver();
      this.cleanupListeners();
      this.pendingCommands.clear();
      this.renderedRows.clear();
      this.allRows = [];
      this.itemPositions = new Map();
      this.visibleRows = [];
      this.element.replaceChildren();
      this.element.remove();
    }
  }

  private cleanupListeners(): void {
    this.element.removeEventListener("click", this.onClickListener);
    this.element.removeEventListener("keydown", this.onKeyDownListener);
    this.element.removeEventListener("pointermove", this.onPointerMoveListener);
    this.element.removeEventListener("pointerleave", this.onPointerLeaveListener);
    this.element.removeEventListener("scroll", this.onScrollListener);
  }

  private disconnectResizeObserver(): void {
    const resizeObserver = this.resizeObserver;
    this.resizeObserver = undefined;
    try {
      resizeObserver?.disconnect();
    } catch {
      // Host teardown owns no renderer authority after the reference is cleared.
    }
  }

  private renderRows(): void {
    if (this.disposed) return;
    const generation = ++this.renderGeneration;
    const snapshot = this.dataSource.snapshot();
    const restoreDocumentFocus = this.element.contains(this.document.activeElement);
    const previousFocusedRef = this.focusedRef;
    const previousFocusedRow = previousFocusedRef === undefined
      ? undefined
      : this.allRows.find((row) => row.nodeRef === previousFocusedRef);
    const nextFocusedRef = chooseFocusedRef(
      snapshot.rows,
      previousFocusedRef,
      previousFocusedRow?.parentRef,
    );
    if (this.disposed || generation !== this.renderGeneration) return;

    this.allRows = snapshot.rows;
    this.itemPositions = treeItemPositions(snapshot.rows);
    this.focusedRef = nextFocusedRef;
    const focusedIndex = this.focusedIndex();
    if (focusedIndex >= 0) this.revealIndex(focusedIndex);
    this.windowStart = this.virtualLayout().windowStart;
    const shouldClearHover = this.hoveredRef !== undefined
      && !this.allRows.some((row) => row.nodeRef === this.hoveredRef && canInspect(row));
    this.commitWindow(restoreDocumentFocus);
    if (this.disposed || generation !== this.renderGeneration) return;
    if (shouldClearHover && this.hoveredRef !== undefined) {
      this.clearHover();
    }
  }

  private commitWindow(restoreDocumentFocus: boolean): void {
    if (this.disposed) return;
    const layout = this.virtualLayout();
    this.windowStart = layout.windowStart;
    const visibleRows = this.allRows.slice(
      layout.windowStart,
      layout.windowStart + layout.windowRowCount,
    );
    const rendered = visibleRows.map((row) => {
      const renderedRow = row.nodeRef === this.focusedRef && !row.focused
        ? { ...row, focused: true }
        : row.nodeRef !== this.focusedRef && row.focused
          ? { ...row, focused: false }
          : row;
      return new ElementsTreeElement(
        this.document,
        renderedRow,
        this.itemPositions.get(row),
      );
    });

    this.visibleRows = visibleRows;
    this.renderedRows.clear();
    for (const renderedRow of rendered) {
      this.renderedRows.set(renderedRow.row.nodeRef, renderedRow);
    }
    this.element.setAttribute("data-rendered-row-count", String(rendered.length));
    const topSpacer = renderVirtualSpacer(
      this.document,
      "top",
      layout.windowStart,
    );
    const bottomSpacer = renderVirtualSpacer(
      this.document,
      "bottom",
      Math.max(
        0,
        this.allRows.length - layout.windowStart - rendered.length,
      ),
    );
    this.element.replaceChildren(
      topSpacer,
      ...rendered.map((row) => row.element),
      bottomSpacer,
    );
    if (restoreDocumentFocus && this.focusedRef !== undefined) {
      focusElement(this.renderedRows.get(this.focusedRef)?.element);
    }
  }

  private onClick(event: Event): void {
    if (this.disposed) return;
    const target = event.target;
    const rowElement = this.rowElementFromTarget(target);
    if (!rowElement) return;
    const interaction = this.captureInteraction(rowElement);
    if (!interaction) return;
    const row = interaction.rendered.row;

    const action = this.actionFromTarget(target, rowElement);
    consume(event);
    if (!this.focusRow(row.nodeRef, true) || !this.isInteractionCurrent(interaction)) {
      return;
    }
    if (action === "toggle" && row.type === "node" && row.expandable) {
      if (row.expanded) {
        runSynchronousCommand(() => this.dataSource.collapse(row.nodeRef));
      } else {
        this.runCommand(`expand:${row.nodeRef}`, () => this.dataSource.expand(row.nodeRef));
      }
      return;
    }
    if (row.type === "load-more") {
      if (row.parentRef !== undefined) {
        this.runCommand(
          `load:${row.parentRef}`,
          () => this.dataSource.loadMore(row.parentRef as string),
        );
      }
      return;
    }
    if (canInspect(row)) {
      this.runCommand(`select:${row.nodeRef}`, () => this.dataSource.select(row.nodeRef));
    }
  }

  private onKeyDown(event: Event): void {
    if (this.disposed || this.allRows.length === 0) return;
    const rowElement = this.rowElementFromTarget(event.target);
    const interaction = rowElement ? this.captureInteraction(rowElement) : undefined;
    if (!interaction || interaction.rendered.row.nodeRef !== this.focusedRef) return;
    const key = (event as KeyboardEvent).key;
    const index = this.focusedIndex();
    const row = this.allRows[index];
    if (!row) return;

    switch (key) {
      case "ArrowUp":
        if (index > 0) this.focusRow(this.allRows[index - 1]?.nodeRef, true);
        break;
      case "ArrowDown":
        if (index < this.allRows.length - 1) {
          this.focusRow(this.allRows[index + 1]?.nodeRef, true);
        }
        break;
      case "Home":
        this.focusRow(this.allRows[0]?.nodeRef, true);
        break;
      case "End":
        this.focusRow(this.allRows[this.allRows.length - 1]?.nodeRef, true);
        break;
      case "Enter":
      case " ":
      case "Space":
      case "Spacebar":
        if (row.type === "load-more") {
          this.activateLoadMore(row);
        } else if (canInspect(row)) {
          this.runCommand(`select:${row.nodeRef}`, () => this.dataSource.select(row.nodeRef));
        } else {
          return;
        }
        break;
      case "ArrowRight":
        if (row.type === "load-more") {
          this.activateLoadMore(row);
        } else if (row.expandable && !row.expanded) {
          this.runCommand(`expand:${row.nodeRef}`, () => this.dataSource.expand(row.nodeRef));
        } else if (row.type === "node" && row.expanded) {
          const child = this.allRows[index + 1];
          if (child && child.depth > row.depth) this.focusRow(child.nodeRef, true);
        }
        break;
      case "ArrowLeft":
        if (row.type === "node" && row.expandable && row.expanded) {
          runSynchronousCommand(() => this.dataSource.collapse(row.nodeRef));
        } else if (row.parentRef !== undefined) {
          this.focusRow(row.parentRef, true);
        }
        break;
      default:
        return;
    }
    consume(event);
  }

  private activateLoadMore(row: TreeRowSnapshot): void {
    const rendered = this.renderedRows.get(row.nodeRef);
    const interaction = rendered === undefined
      ? undefined
      : interactionForRendered(rendered);
    if (
      interaction === undefined
      || !this.focusRow(row.nodeRef, true)
      || !this.isInteractionCurrent(interaction)
    ) {
      return;
    }
    if (row.parentRef !== undefined) {
      this.runCommand(
        `load:${row.parentRef}`,
        () => this.dataSource.loadMore(row.parentRef as string),
      );
    }
  }

  private runCommand(key: string, command: () => Promise<void>): void {
    if (
      this.disposed
      || this.pendingCommands.has(key)
      || this.pendingCommands.size >= MAX_PENDING_TREE_COMMANDS
    ) {
      return;
    }
    this.pendingCommands.add(key);
    let pending: Promise<void>;
    try {
      pending = command();
    } catch {
      this.pendingCommands.delete(key);
      return;
    }
    const pendingCommands = this.pendingCommands;
    void pending.then(
      () => pendingCommands.delete(key),
      () => pendingCommands.delete(key),
    );
  }

  private onPointerMove(event: Event): void {
    if (this.disposed) return;
    const rowElement = this.rowElementFromTarget(event.target);
    const row = rowElement
      ? this.captureInteraction(rowElement)?.rendered.row
      : undefined;
    const nextHoveredRef = row && canInspect(row)
      ? row.nodeRef
      : undefined;
    if (nextHoveredRef === this.hoveredRef) return;
    this.hoveredRef = nextHoveredRef;
    runSynchronousCommand(() => this.dataSource.hover(nextHoveredRef));
  }

  private onPointerLeave(): void {
    if (this.disposed) return;
    this.clearHover();
  }

  private onScroll(): void {
    if (this.disposed || this.allRows.length === 0) return;
    const layout = this.virtualLayout();
    const focusedIndex = this.focusedIndex();
    const viewportEnd = Math.min(
      this.allRows.length,
      layout.viewportStart + layout.viewportRowCount,
    );
    const restoreDocumentFocus = this.element.contains(this.document.activeElement);
    if (focusedIndex < layout.viewportStart || focusedIndex >= viewportEnd) {
      this.focusRow(
        this.allRows[layout.viewportStart]?.nodeRef,
        true,
        restoreDocumentFocus,
        false,
      );
      return;
    }
    if (layout.windowStart !== this.windowStart) {
      this.renderGeneration += 1;
      this.windowStart = layout.windowStart;
      this.commitWindow(restoreDocumentFocus);
    }
  }

  private onResize(): void {
    if (this.disposed) return;
    this.renderGeneration += 1;
    const focusedIndex = this.focusedIndex();
    if (focusedIndex >= 0) this.revealIndex(focusedIndex);
    this.windowStart = this.virtualLayout().windowStart;
    this.commitWindow(this.element.contains(this.document.activeElement));
  }

  private clearHover(): void {
    if (this.hoveredRef === undefined) return;
    this.hoveredRef = undefined;
    runSynchronousCommand(() => this.dataSource.hover(undefined));
  }

  private focusRow(
    nodeRef: string | undefined,
    userInitiated: boolean,
    focusDocument = true,
    reveal = true,
  ): boolean {
    if (nodeRef === undefined || this.disposed) return false;
    const nextIndex = this.allRows.findIndex((row) => row.nodeRef === nodeRef);
    if (nextIndex < 0) return false;
    if (reveal) this.revealIndex(nextIndex);
    const previousRef = this.focusedRef;
    const previousWindowStart = this.windowStart;
    this.focusedRef = nodeRef;
    this.windowStart = this.virtualLayout().windowStart;
    if (previousWindowStart !== this.windowStart || !this.renderedRows.has(nodeRef)) {
      this.renderGeneration += 1;
      this.commitWindow(false);
    } else if (previousRef !== nodeRef) {
      if (previousRef !== undefined) this.renderedRows.get(previousRef)?.setFocused(false);
      this.renderedRows.get(nodeRef)?.setFocused(true);
    }
    const rendered = this.renderedRows.get(nodeRef);
    if (!rendered) return false;
    const interaction = interactionForRendered(rendered);
    if (userInitiated) {
      runSynchronousCommand(() => this.dataSource.focus(nodeRef));
      const current = this.currentRenderedForInteraction(interaction);
      if (!current || this.focusedRef !== nodeRef) return false;
      if (focusDocument) focusElement(current.element);
      if (!this.currentRenderedForInteraction(interaction) || this.focusedRef !== nodeRef) {
        return false;
      }
    }
    return true;
  }

  private focusedIndex(): number {
    const index = this.allRows.findIndex((row) => row.nodeRef === this.focusedRef);
    return index;
  }

  private rowElementFromTarget(target: EventTarget | null): HTMLElement | undefined {
    if (!isHTMLElementLike(target) || !this.element.contains(target)) return undefined;
    let element = isHTMLElementLike(target) ? target : undefined;
    while (element && element !== this.element) {
      if (element.getAttribute("data-row-type") !== null) {
        const rendered = this.renderedRows.get(
          element.getAttribute("data-node-ref") ?? "",
        );
        return rendered?.element === element ? element : undefined;
      }
      element = element.parentElement ?? undefined;
    }
    return undefined;
  }

  private captureInteraction(rowElement: HTMLElement): RenderedInteraction | undefined {
    const rendered = this.renderedRows.get(rowElement.getAttribute("data-node-ref") ?? "");
    if (
      rendered === undefined
      || rendered.element !== rowElement
      || !this.element.contains(rowElement)
    ) {
      return undefined;
    }
    return interactionForRendered(rendered);
  }

  private isInteractionCurrent(interaction: RenderedInteraction): boolean {
    return this.currentRenderedForInteraction(interaction) !== undefined;
  }

  private currentRenderedForInteraction(
    interaction: RenderedInteraction,
  ): ElementsTreeElement | undefined {
    if (this.disposed) return undefined;
    const rendered = this.renderedRows.get(interaction.authority.nodeRef);
    if (
      rendered === undefined
      || !this.element.contains(rendered.element)
      || !sameInteractionAuthority(
        interaction.authority,
        authorityForRow(rendered.row),
      )
    ) {
      return undefined;
    }
    return rendered;
  }

  private revealIndex(index: number): void {
    const layout = this.virtualLayout();
    const viewportEnd = Math.min(
      this.allRows.length,
      layout.viewportStart + layout.viewportRowCount,
    );
    if (index >= layout.viewportStart && index < viewportEnd) return;
    const viewportHeight = safeLayoutValue(() => this.element.clientHeight);
    const nextScrollTop = index < layout.viewportStart
      ? extentForRows(index)
      : Math.max(0, extentForRows(index + 1) - viewportHeight);
    this.writeScrollTop(nextScrollTop);
  }

  private virtualLayout(): VirtualLayout {
    const rowCount = this.allRows.length;
    const viewportHeight = safeLayoutValue(() => this.element.clientHeight);
    const viewportRowCount = Math.min(
      this.maxVisibleRows,
      viewportHeight > 0
        ? Math.max(1, Math.ceil(viewportHeight / TREE_ROW_HEIGHT_PX))
        : ZERO_HEIGHT_FALLBACK_ROWS,
    );
    const windowRowCount = Math.min(
      rowCount,
      this.maxVisibleRows,
      viewportHeight > 0
        ? viewportRowCount + TREE_OVERSCAN_ROWS * 2
        : viewportRowCount,
    );
    const maximumScrollTop = Math.max(
      0,
      extentForRows(rowCount) - viewportHeight,
    );
    const rawScrollTop = safeLayoutValue(() => this.element.scrollTop);
    const scrollTop = Math.min(rawScrollTop, maximumScrollTop);
    this.writeScrollTop(scrollTop);
    const maximumViewportStart = Math.max(0, rowCount - viewportRowCount);
    const viewportStart = Math.min(
      maximumViewportStart,
      Math.floor(scrollTop / TREE_ROW_HEIGHT_PX),
    );
    const overscanBefore = Math.min(
      TREE_OVERSCAN_ROWS,
      Math.floor(Math.max(0, windowRowCount - viewportRowCount) / 2),
    );
    const maximumWindowStart = Math.max(0, rowCount - windowRowCount);
    const windowStart = Math.min(
      maximumWindowStart,
      Math.max(0, viewportStart - overscanBefore),
    );
    return {
      scrollTop,
      viewportStart,
      viewportRowCount,
      windowStart,
      windowRowCount,
    };
  }

  private writeScrollTop(value: number): void {
    const scrollTop = Math.min(
      MAX_VIRTUAL_EXTENT_PX,
      Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0),
    );
    try {
      if (this.element.scrollTop !== scrollTop) this.element.scrollTop = scrollTop;
    } catch {
      // The renderer-owned viewport may disappear during host teardown.
    }
  }

  private actionFromTarget(
    target: EventTarget | null,
    rowElement: HTMLElement,
  ): string | undefined {
    let element = isHTMLElementLike(target) ? target : undefined;
    while (element) {
      const action = element.getAttribute("data-action");
      if (action !== null) return action;
      if (element === rowElement) return undefined;
      element = element.parentElement ?? undefined;
    }
    return undefined;
  }
}

function chooseFocusedRef(
  rows: readonly TreeRowSnapshot[],
  previousFocusedRef: string | undefined,
  previousParentRef: string | undefined,
): string | undefined {
  const authoritativeRef = rows.find((row) => row.focused)?.nodeRef;
  if (authoritativeRef !== undefined) return authoritativeRef;
  if (previousFocusedRef !== undefined && rows.some((row) => row.nodeRef === previousFocusedRef)) {
    return previousFocusedRef;
  }
  if (previousParentRef !== undefined && rows.some((row) => row.nodeRef === previousParentRef)) {
    return previousParentRef;
  }
  return rows.find((row) => row.selected)?.nodeRef
    ?? rows[0]?.nodeRef;
}

function interactionForRendered(rendered: ElementsTreeElement): RenderedInteraction {
  return {
    authority: authorityForRow(rendered.row),
    rendered,
  };
}

function authorityForRow(row: TreeRowSnapshot): InteractionAuthority {
  return {
    nodeRef: row.nodeRef,
    type: row.type,
    parentRef: row.parentRef,
    kind: row.node?.kind,
    nodeName: row.node?.nodeName,
    branchRevision: row.node?.branchRevision,
    expandable: row.expandable,
    expanded: row.expanded,
    selectable: row.node?.selectable,
    inaccessible: row.node?.inaccessible,
  };
}

function sameInteractionAuthority(
  left: InteractionAuthority,
  right: InteractionAuthority,
): boolean {
  return left.nodeRef === right.nodeRef
    && left.type === right.type
    && left.parentRef === right.parentRef
    && left.kind === right.kind
    && left.nodeName === right.nodeName
    && left.branchRevision === right.branchRevision
    && left.expandable === right.expandable
    && left.expanded === right.expanded
    && left.selectable === right.selectable
    && left.inaccessible === right.inaccessible;
}

function createResizeObserver(
  document: Document,
  factory: ElementsTreeOutlineOptions["resizeObserverFactory"],
  callback: () => void,
): ElementsTreeResizeObserver | undefined {
  if (factory !== undefined) return factory(callback);
  let ResizeObserverConstructor: typeof ResizeObserver | undefined;
  try {
    ResizeObserverConstructor = document.defaultView?.ResizeObserver;
  } catch {
    return undefined;
  }
  if (ResizeObserverConstructor === undefined) return undefined;
  return new ResizeObserverConstructor(() => callback());
}

function renderVirtualSpacer(
  document: Document,
  position: "top" | "bottom",
  rowCount: number,
): HTMLElement {
  const spacer = createElement(document, "div", {
    className: "elements-tree-virtual-spacer",
    attributes: {
      "aria-hidden": "true",
      "data-part": "virtual-spacer",
      "data-position": position,
    },
  });
  let remainingRows = normalizeVirtualSpacerRows(rowCount);
  for (const span of VIRTUAL_SPACER_ROW_SPANS) {
    if (remainingRows < span) continue;
    spacer.append(createElement(document, "div", {
      className: `elements-tree-virtual-spacer-chunk elements-tree-virtual-spacer-chunk--${span}`,
      attributes: { "data-row-span": String(span) },
    }));
    remainingRows -= span;
  }
  return spacer;
}

function normalizeVirtualSpacerRows(rowCount: number): number {
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) return 0;
  return Math.min(MAX_VIRTUAL_SPACER_ROWS, rowCount);
}

function extentForRows(rowCount: number): number {
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) return 0;
  return Math.min(MAX_VIRTUAL_EXTENT_PX, rowCount * TREE_ROW_HEIGHT_PX);
}

function treeItemPositions(
  rows: readonly TreeRowSnapshot[],
): ReadonlyMap<TreeRowSnapshot, TreeItemPosition> {
  const siblingGroups = new Map<string | undefined, TreeRowSnapshot[]>();
  for (const row of rows) {
    const siblings = siblingGroups.get(row.parentRef) ?? [];
    siblings.push(row);
    siblingGroups.set(row.parentRef, siblings);
  }

  const positions = new Map<TreeRowSnapshot, TreeItemPosition>();
  for (const siblings of siblingGroups.values()) {
    const setSize = siblings.length;
    siblings.forEach((row, index) => positions.set(row, {
      positionInSet: index + 1,
      setSize,
    }));
  }
  return positions;
}

function safeLayoutValue(read: () => number): number {
  try {
    const value = read();
    if (Number.isNaN(value) || value <= 0) return 0;
    if (!Number.isFinite(value)) return MAX_VIRTUAL_EXTENT_PX;
    return Math.min(MAX_VIRTUAL_EXTENT_PX, Math.floor(value));
  } catch {
    return 0;
  }
}

function normalizeVisibleRowLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_VISIBLE_TREE_ROWS;
  if (!Number.isSafeInteger(value) || value < MIN_VISIBLE_TREE_ROWS) {
    throw new RangeError("maxVisibleRows must be a positive safe integer");
  }
  return Math.min(value, DEFAULT_MAX_VISIBLE_TREE_ROWS);
}

function focusElement(element: HTMLElement | undefined): void {
  if (!element || typeof element.focus !== "function") return;
  element.focus({ preventScroll: true });
}

function runSynchronousCommand(command: () => void): void {
  try {
    command();
  } catch {
    // The controller owns command error presentation and retries.
  }
}

function canInspect(row: TreeRowSnapshot): boolean {
  return row.type === "node"
    && row.node?.kind === "element"
    && row.node.selectable
    && !row.node.inaccessible;
}

function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function isHTMLElementLike(target: EventTarget | null): target is HTMLElement {
  return target !== null
    && typeof (target as HTMLElement).getAttribute === "function";
}

function createElement(
  document: Document,
  tagName: string,
  options: {
    readonly attributes?: Readonly<Record<string, string>>;
    readonly className?: string;
  } = {},
): HTMLElement {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  return element;
}
