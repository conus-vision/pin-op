import * as ObjectWrapper from '#chromium/core/common/Object.js';
import * as TreeOutline from '#chromium/ui/legacy/Treeoutline.js';
import * as Widget from '#chromium/ui/legacy/Widget.js';
import * as UIUtils from './ui-utils.js';

class ReadOnlyToolbarItem<T = Record<string, unknown>> extends ObjectWrapper.ObjectWrapper<T> {
  readonly element: HTMLElement;
  constructor(element = document.createElement('div')) { super(); this.element = element; }
  setVisible(visible: boolean): void { this.element.classList.toggle('hidden', !visible); }
  setEnabled(enabled: boolean): void { this.element.toggleAttribute('disabled', !enabled); }
}
class ReadOnlyToolbarFilter extends ReadOnlyToolbarItem<{TextChanged: string}> {
  static Event = Object.freeze({TEXT_CHANGED: 'TextChanged', ENTER_PRESSED: 'EnterPressed'});
  readonly input: HTMLInputElement;
  constructor(...args: unknown[]) {
    super(document.createElement('div'));
    this.element.className = 'toolbar-input toolbar-filter';
    this.input = document.createElement('input');
    this.input.type = 'search';
    this.input.placeholder = 'Filter';
    this.input.addEventListener('input', () => this.dispatchEventToListeners('TextChanged', this.input.value));
    const filterIcon = document.createElement('devtools-icon') as HTMLElement&{name: string};
    filterIcon.name = 'filter';
    filterIcon.className = 'pin-op-filter-icon';
    this.element.append(filterIcon, this.input);
    const regexToggle = args.at(-1);
    if (typeof regexToggle === 'function') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '.*';
      button.addEventListener('click', () => regexToggle());
      this.element.appendChild(button);
    }
  }
  setValue(value: string, notify = false): void {
    this.input.value = value;
    if (notify) this.dispatchEventToListeners('TextChanged', value);
  }
  value(): string { return this.input.value; }
}
class ReadOnlyToolbarElement extends HTMLElement {
  appendToolbarItem(item: ReadOnlyToolbarItem): void { this.appendChild(item.element); }
  async appendItemsAtLocation(_location: string): Promise<void> {}
}
if (!customElements.get('devtools-toolbar')) customElements.define('devtools-toolbar', ReadOnlyToolbarElement);
class ReadOnlyToolbarButton extends ReadOnlyToolbarItem {
  static Events = Object.freeze({CLICK: 'Click'});
  constructor(title = '', _icon?: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    super(button);
  }
  setSize(_size: unknown): void {}
  setToggled(_value: boolean): void {}
}

export {TreeOutline, UIUtils, Widget};
export const Toolbar = Object.freeze({
  ToolbarItem: ReadOnlyToolbarItem,
  ToolbarInput: ReadOnlyToolbarFilter,
  ToolbarFilter: ReadOnlyToolbarFilter,
  ToolbarButton: ReadOnlyToolbarButton,
  ToolbarToggle: ReadOnlyToolbarButton,
});
const setLabel = (element: Element, label: string|null): void => {
  if (label === null) element.removeAttribute('aria-label'); else element.setAttribute('aria-label', label);
};
export const ARIAUtils = Object.freeze({
  setLabel,
  setHidden: (element: Element, value: boolean): void => element.setAttribute('aria-hidden', String(value)),
  setControls: (element: Element, controlled: Element): void => {
    if (!controlled.id) controlled.id = `pin-op-style-${Math.random().toString(36).slice(2)}`;
    element.setAttribute('aria-controls', controlled.id);
  },
  markAsButton: (element: Element): void => element.setAttribute('role', 'button'),
  markAsList: (element: Element): void => element.setAttribute('role', 'list'),
  markAsListitem: (element: Element): void => element.setAttribute('role', 'listitem'),
  setExpanded: (element: Element, value: boolean): void =>
    element.setAttribute('aria-expanded', String(value)),
  LiveAnnouncer: Object.freeze({alert: (_message: string): void => {}}),
});
export const DOMUtilities = Object.freeze({
  deepActiveElement: (doc: Document): Element|null => {
    let active: Element|null = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  },
});
const context = {flavor: () => null, setFlavor: () => {}, addFlavorChangeListener: () => {}, removeFlavorChangeListener: () => {}};
export const Context = Object.freeze({Context: class {static instance() { return context; }}});
export const ViewManager = Object.freeze({ViewManager: class {static instance() {
  return {addEventListener: () => {}, isViewVisible: (_id: string): boolean => false};
}}, Events: {}});
export const UIUserMetrics = Object.freeze({UIUserMetrics: class {static instance() { return {panelLoaded: () => {}}; }}});
export const KeyboardShortcut = Object.freeze({KeyboardShortcut: Object.freeze({
  eventHasCtrlEquivalentKey: (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey,
})});
export const Tooltip = Object.freeze({Tooltip: Object.freeze({install: () => {}})});
export const ContextMenu = Object.freeze({ContextMenu: class {}});
export const InplaceEditor = Object.freeze({Config: class {}, InplaceEditor: class {}});
export const TextPrompt = Object.freeze({TextPrompt: class {}});
export const SuggestBox = Object.freeze({});
export const ActionRegistration = Object.freeze({});
