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

const toolbarIconPaths = Object.freeze({
  'cross-circle-filled':
      'M7.062 14L10 11.062L12.938 14L14 12.938L11.062 10L14 7.062L12.938 6L10 8.938L7.062 6L6 7.062L8.938 10L6 12.938L7.062 14ZM10 18C8.90267 18 7.868 17.7917 6.896 17.375C5.924 16.9583 5.07333 16.3853 4.344 15.656C3.61467 14.9267 3.04167 14.076 2.625 13.104C2.20833 12.132 2 11.0973 2 10C2 8.88867 2.20833 7.85033 2.625 6.885C3.04167 5.92033 3.61467 5.07333 4.344 4.344C5.07333 3.61467 5.924 3.04167 6.896 2.625C7.868 2.20833 8.90267 2 10 2C11.1113 2 12.1497 2.20833 13.115 2.625C14.0797 3.04167 14.9267 3.61467 15.656 4.344C16.3853 5.07333 16.9583 5.92033 17.375 6.885C17.7917 7.85033 18 8.88867 18 10C18 11.0973 17.7917 12.132 17.375 13.104C16.9583 14.076 16.3853 14.9267 15.656 15.656C14.9267 16.3853 14.0797 16.9583 13.115 17.375C12.1497 17.7917 11.1113 18 10 18Z',
  'regular-expression':
      'M4.33333 15.6458C3.58333 14.8958 3.00694 14.0347 2.60417 13.0625C2.20139 12.0903 2 11.0694 2 9.99998C2 8.93054 2.20139 7.9097 2.60417 6.93748C3.00694 5.96526 3.58333 5.0972 4.33333 4.33331L5.41667 5.39581C4.79167 6.00692 4.31597 6.70831 3.98958 7.49998C3.66319 8.29165 3.5 9.12498 3.5 9.99998C3.5 10.8611 3.66319 11.684 3.98958 12.4687C4.31597 13.2535 4.78472 13.9583 5.39583 14.5833L4.33333 15.6458ZM7.75 15C7.40278 15 7.10764 14.8785 6.86458 14.6354C6.62153 14.3923 6.5 14.0972 6.5 13.75C6.5 13.4028 6.62153 13.1076 6.86458 12.8646C7.10764 12.6215 7.40278 12.5 7.75 12.5C8.09722 12.5 8.39236 12.6215 8.63542 12.8646C8.87847 13.1076 9 13.4028 9 13.75C9 14.0972 8.87847 14.3923 8.63542 14.6354C8.39236 14.8785 8.09722 15 7.75 15ZM10.5 11V9.29165L9.02083 10.1458L8.27083 8.85415L9.75 7.99998L8.27083 7.14581L9.02083 5.85415L10.5 6.70831V4.99998H12V6.70831L13.4792 5.85415L14.2292 7.14581L12.75 7.99998L14.2292 8.85415L13.4792 10.1458L12 9.29165V11H10.5ZM15.6667 15.6458L14.6042 14.5833C15.2153 13.9722 15.684 13.2743 16.0104 12.4896C16.3368 11.7048 16.5 10.875 16.5 9.99998C16.5 9.12498 16.3403 8.29165 16.0208 7.49998C15.7014 6.70831 15.2292 6.00692 14.6042 5.39581L15.6667 4.33331C16.4167 5.0972 16.9931 5.96526 17.3958 6.93748C17.7986 7.9097 18 8.93054 18 9.99998C18 11.0694 17.7986 12.0903 17.3958 13.0625C16.9931 14.0347 16.4167 14.8958 15.6667 15.6458Z',
});

class ReadOnlyToolbarIconButton extends HTMLElement {
  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }
}
if (!customElements.get('devtools-button')) {
  customElements.define('devtools-button', ReadOnlyToolbarIconButton);
}

function createReadOnlyIconButton(
    iconName: keyof typeof toolbarIconPaths, title: string, toggle = false): HTMLElement {
  const button = document.createElement('devtools-button');
  button.className = 'pin-op-toolbar-icon-button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('role', 'button');
  button.tabIndex = 0;
  if (toggle) button.setAttribute('aria-pressed', 'false');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 20 20');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', toolbarIconPaths[iconName]);
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    button.click();
  });
  return button;
}

function singleLineToolbarText(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

class ReadOnlyToolbarPrompt {
  readonly proxy: HTMLElement;
  readonly element: HTMLElement;
  constructor(placeholder: string) {
    this.proxy = document.createElement('span');
    this.proxy.className = 'toolbar-prompt-proxy';
    const root = document.createElement('div');
    root.className = 'text-prompt-root';
    this.element = document.createElement('div');
    this.element.className = 'toolbar-input-prompt text-prompt';
    this.element.setAttribute('aria-label', placeholder);
    this.element.setAttribute('role', 'textbox');
    this.element.setAttribute('aria-autocomplete', 'both');
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('contenteditable', 'plaintext-only');
    this.element.setAttribute('data-placeholder', placeholder);
    root.appendChild(this.element);
    this.proxy.appendChild(root);
  }
  value(): string { return singleLineToolbarText(this.element.textContent ?? ''); }
  setValue(value: string): void { this.element.textContent = singleLineToolbarText(value); }
  focus(): void { this.element.focus(); }
}

class ReadOnlyToolbarFilter extends ReadOnlyToolbarItem<{TextChanged: string}> {
  static Event = Object.freeze({TEXT_CHANGED: 'TextChanged', ENTER_PRESSED: 'EnterPressed'});
  readonly prompt: ReadOnlyToolbarPrompt;
  readonly clearButton: HTMLElement;
  constructor(...args: unknown[]) {
    super(document.createElement('div'));
    this.element.className = 'toolbar-input toolbar-filter toolbar-input-empty';
    const growFactor = args[1];
    if (typeof growFactor === 'number' && growFactor) {
      this.element.style.flexGrow = String(growFactor);
    }
    const shrinkFactor = args[2];
    if (typeof shrinkFactor === 'number' && shrinkFactor) {
      this.element.style.flexShrink = String(shrinkFactor);
    }
    const filterIcon = document.createElement('devtools-icon') as HTMLElement&{name: string};
    filterIcon.name = 'filter';
    filterIcon.className = 'pin-op-filter-icon';
    this.prompt = new ReadOnlyToolbarPrompt('Filter');
    this.prompt.element.addEventListener('focus', () => this.element.classList.add('focused'));
    this.prompt.element.addEventListener('blur', () => this.element.classList.remove('focused'));
    this.prompt.element.addEventListener('input', () => this.onTextChanged());
    this.prompt.element.addEventListener('beforeinput', event => {
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
      }
    });
    this.prompt.element.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      this.insertText(singleLineToolbarText(text));
      this.onTextChanged();
    });
    this.prompt.element.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.value()) this.dispatchEventToListeners('EnterPressed', this.value());
      } else if (event.key === 'Escape' && this.value()) {
        event.preventDefault();
        this.setValue('', true);
      }
    });
    this.clearButton = createReadOnlyIconButton('cross-circle-filled', 'Clear');
    this.clearButton.classList.add('toolbar-input-clear-button');
    this.clearButton.tabIndex = -1;
    this.clearButton.addEventListener('click', () => {
      this.setValue('', true);
      this.prompt.focus();
    });
    this.element.append(filterIcon, this.prompt.proxy, this.clearButton);
    const regexToggle = args.at(-1);
    if (typeof regexToggle === 'function') {
      const button = createReadOnlyIconButton('regular-expression', 'Use regular expression', true);
      button.addEventListener('click', () => {
        button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
        regexToggle();
      });
      this.element.appendChild(button);
    }
  }
  setValue(value: string, notify = false): void {
    this.prompt.setValue(value);
    this.updateEmptyStyles();
    if (notify) this.dispatchEventToListeners('TextChanged', this.value());
  }
  value(): string { return this.prompt.value(); }
  valueWithoutSuggestion(): string { return this.value(); }
  clearAutocomplete(): void {}
  focus(): void { this.prompt.focus(); }
  private onTextChanged(): void {
    const rawValue = this.prompt.element.textContent ?? '';
    const value = singleLineToolbarText(rawValue);
    if (value !== rawValue) this.prompt.setValue(value);
    this.updateEmptyStyles();
    this.dispatchEventToListeners('TextChanged', value);
  }
  private insertText(text: string): void {
    const selection = this.prompt.element.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.prompt.setValue(this.value() + text);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!this.prompt.element.contains(range.commonAncestorContainer)) {
      this.prompt.setValue(this.value() + text);
      return;
    }
    range.deleteContents();
    const textNode = this.prompt.element.ownerDocument.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  private updateEmptyStyles(): void {
    this.element.classList.toggle('toolbar-input-empty', !this.value());
  }
}
class ReadOnlyToolbarElement extends HTMLElement {
  readonly #shadow = this.attachShadow({mode: 'open'});
  constructor() {
    super();
    const style = document.createElement('style');
    style.textContent = ':host{padding:0 2px;position:relative;white-space:nowrap;overflow:hidden;display:flex;flex:none;align-items:center;z-index:0;--toolbar-height:26px}slot{height:var(--toolbar-height)}';
    this.#shadow.append(style, document.createElement('slot'));
  }
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
