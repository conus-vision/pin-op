// Pin-op production facade over the exact pinned Chromium DOM renderer.
// This module deliberately exposes no raw utility, widget, or tree-element
// class: the neutral adapter receives only its reviewed runtime capabilities.
import '#chromium/ui/dom_extension/dom_extension.js';
import '../facades/core-styles.js';

import {DOMDocument, DOMNode} from '#chromium/core/sdk/DOMModel.js';
import {ElementsTreeElement} from '#chromium/panels/elements/ElementsTreeElement.js';
import {ElementsTreeOutline} from '#chromium/panels/elements/ElementsTreeOutline.js';
import {
  Events as TreeOutlineEvents,
  TreeElement,
} from '#chromium/ui/legacy/Treeoutline.js';

interface LoadMoreAuthority {
  readonly parent: DOMNode;
  readonly serviceRowRef: string;
  readonly focused: boolean;
  readonly hasMore: true;
  readonly loadedChildCount: number;
  readonly totalChildCount: number;
  readonly remainingChildCount: number;
}

interface LoadMoreBridge {
  update(parents: readonly LoadMoreAuthority[]): void;
  dispose(): void;
}

interface LoadMoreEntry {
  authority: LoadMoreAuthority;
  readonly treeElement: TreeElement;
  readonly button: HTMLButtonElement;
  readonly onClick: (event: Event) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onMouseDown: (event: MouseEvent) => void;
  pending: Promise<void>|undefined;
  active: boolean;
}

function installLoadMoreBridge(
    outline: ElementsTreeOutline,
    loadMore: (authority: LoadMoreAuthority) => Promise<void>): LoadMoreBridge {
  const ownerDocument = outline.element.ownerDocument;
  const entries = new Map<DOMNode, LoadMoreEntry>();
  let disposed = false;
  let refreshQueued = false;

  const removeEntry = (entry: LoadMoreEntry): void => {
    if (!entry.active) {
      return;
    }
    entry.active = false;
    entry.button.removeEventListener('click', entry.onClick);
    entry.button.removeEventListener('keydown', entry.onKeyDown);
    entry.button.removeEventListener('mousedown', entry.onMouseDown);
    entry.button.disabled = true;
    entry.button.removeAttribute('aria-busy');
    entry.treeElement.parent?.removeChild(entry.treeElement);
  };

  const setLoading = (entry: LoadMoreEntry, loading: boolean): void => {
    entry.button.disabled = loading;
    if (loading) {
      entry.button.setAttribute('aria-busy', 'true');
      entry.button.textContent = 'Loading…';
      return;
    }
    entry.button.removeAttribute('aria-busy');
    updateButtonPresentation(entry);
  };

  const request = (entry: LoadMoreEntry): Promise<void> => {
    if (disposed || !entry.active || entries.get(entry.authority.parent) !== entry) {
      return Promise.resolve();
    }
    if (entry.pending) {
      return entry.pending;
    }
    const authority = entry.authority;
    const pending = Promise.resolve().then(() => loadMore(authority));
    entry.pending = pending;
    setLoading(entry, true);
    void pending.then(() => undefined, () => undefined).finally(() => {
      if (
        !disposed && entry.active && entry.pending === pending &&
        entries.get(entry.authority.parent) === entry
      ) {
        entry.pending = undefined;
        setLoading(entry, false);
      }
    });
    return pending;
  };

  const createEntry = (authority: LoadMoreAuthority): LoadMoreEntry => {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'text-button pin-op-elements-load-more';
    button.setAttribute('data-pin-op-load-more-ref', authority.serviceRowRef);

    let entry: LoadMoreEntry;
    const onClick = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      void request(entry).catch(() => undefined);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void request(entry).catch(() => undefined);
    };
    const onMouseDown = (event: MouseEvent): void => {
      event.stopPropagation();
    };
    const treeElement = new TreeElement(button);
    treeElement.selectable = false;
    treeElement.listItemElement.classList.add('pin-op-elements-load-more-row');
    treeElement.listItemElement.setAttribute('data-pin-op-service-row', 'load-more');
    button.addEventListener('click', onClick);
    button.addEventListener('keydown', onKeyDown);
    button.addEventListener('mousedown', onMouseDown);
    entry = {
      authority,
      treeElement,
      button,
      onClick,
      onKeyDown,
      onMouseDown,
      pending: undefined,
      active: true,
    };
    updateButtonPresentation(entry);
    return entry;
  };

  const attachEntry = (entry: LoadMoreEntry): boolean => {
    const parentTreeElement = outline.findTreeElement(entry.authority.parent);
    if (!parentTreeElement || !parentTreeElement.expanded) {
      entry.treeElement.parent?.removeChild(entry.treeElement);
      return false;
    }
    if (entry.treeElement.parent !== parentTreeElement) {
      entry.treeElement.parent?.removeChild(entry.treeElement);
      let insertionIndex = parentTreeElement.childCount();
      for (let index = 0; index < parentTreeElement.childCount(); ++index) {
        const child = parentTreeElement.childAt(index);
        if (child instanceof ElementsTreeElement && child.isClosingTag()) {
          insertionIndex = index;
          break;
        }
      }
      parentTreeElement.insertChild(entry.treeElement, insertionIndex);
    }
    const buttonRoot = entry.button.getRootNode() as Document|ShadowRoot;
    if (entry.authority.focused) {
      if (buttonRoot.activeElement !== entry.button) {
        entry.button.focus();
      }
    } else if (buttonRoot.activeElement === entry.button) {
      entry.button.blur();
    }
    return true;
  };

  const refreshAttachedEntries = (): void => {
    if (disposed || refreshQueued) {
      return;
    }
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (disposed) {
        return;
      }
      for (const entry of entries.values()) {
        attachEntry(entry);
      }
    });
  };
  outline.addEventListener(TreeOutlineEvents.ElementAttached, refreshAttachedEntries);
  outline.addEventListener(TreeOutlineEvents.ElementExpanded, refreshAttachedEntries);
  outline.addEventListener(TreeOutlineEvents.ElementsDetached, refreshAttachedEntries);

  return Object.freeze({
    update(parents: readonly LoadMoreAuthority[]): void {
      if (disposed) {
        return;
      }
      validateLoadMoreAuthorities(parents);
      const desiredParents = new Set(parents.map(authority => authority.parent));
      for (const [parent, entry] of entries) {
        if (!desiredParents.has(parent)) {
          entries.delete(parent);
          removeEntry(entry);
        }
      }
      for (const authority of parents) {
        let entry = entries.get(authority.parent);
        if (entry && entry.authority.serviceRowRef !== authority.serviceRowRef) {
          entries.delete(authority.parent);
          removeEntry(entry);
          entry = undefined;
        }
        if (!entry) {
          entry = createEntry(authority);
          entries.set(authority.parent, entry);
        } else {
          entry.authority = authority;
          if (!entry.pending) {
            updateButtonPresentation(entry);
          }
        }
        attachEntry(entry);
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      outline.removeEventListener(TreeOutlineEvents.ElementAttached, refreshAttachedEntries);
      outline.removeEventListener(TreeOutlineEvents.ElementExpanded, refreshAttachedEntries);
      outline.removeEventListener(TreeOutlineEvents.ElementsDetached, refreshAttachedEntries);
      for (const entry of entries.values()) {
        removeEntry(entry);
      }
      entries.clear();
    },
  });
}

function updateButtonPresentation(entry: LoadMoreEntry): void {
  const {authority, button} = entry;
  const remaining = authority.remainingChildCount;
  button.textContent = remaining === 1 ? 'Load more (1 node)' : `Load more (${remaining} nodes)`;
  button.setAttribute('aria-label',
      remaining === 1 ? 'Load 1 more DOM node' : `Load ${remaining} more DOM nodes`);
  button.setAttribute('data-pin-op-load-more-ref', authority.serviceRowRef);
  entry.treeElement.listItemElement.setAttribute('data-pin-op-node-ref', authority.serviceRowRef);
}

function validateLoadMoreAuthorities(parents: readonly LoadMoreAuthority[]): void {
  if (!Array.isArray(parents)) {
    throw new TypeError('Chromium load-more update requires an array');
  }
  const seenParents = new Set<DOMNode>();
  const seenServiceRows = new Set<string>();
  for (const authority of parents) {
    const counts = [
      authority?.loadedChildCount,
      authority?.totalChildCount,
      authority?.remainingChildCount,
    ];
    if (
      !authority || typeof authority !== 'object' || authority.hasMore !== true ||
      typeof authority.serviceRowRef !== 'string' || authority.serviceRowRef.length === 0 ||
      typeof authority.focused !== 'boolean' || !(authority.parent instanceof DOMNode) ||
      counts.some(value => !Number.isSafeInteger(value) || value < 0) ||
      authority.loadedChildCount > authority.totalChildCount || authority.remainingChildCount === 0 ||
      typeof authority.parent.childNodeCount !== 'function' ||
      authority.parent.childNodeCount() !== authority.totalChildCount ||
      authority.parent.children()?.length !== authority.loadedChildCount ||
      authority.remainingChildCount !==
        Math.max(0, authority.totalChildCount - authority.loadedChildCount)
    ) {
      throw new TypeError('Invalid Chromium load-more authority');
    }
    if (seenParents.has(authority.parent) || seenServiceRows.has(authority.serviceRowRef)) {
      throw new TypeError('Duplicate Chromium load-more authority');
    }
    seenParents.add(authority.parent);
    seenServiceRows.add(authority.serviceRowRef);
  }
}

export const chromiumElementsRuntime = Object.freeze({
  DOMDocument,
  ElementsTreeOutline,
  selectedNodeChangedEvent: ElementsTreeOutline.Events.SelectedNodeChanged,
  elementCollapsedEvent: TreeOutlineEvents.ElementCollapsed,
  elementExpandedEvent: TreeOutlineEvents.ElementExpanded,
  installLoadMoreBridge,
});
