import inspectorCommonStyles from '#chromium/ui/legacy/inspectorCommon.css.js';
import textButtonStyles from '#chromium/ui/components/buttons/textButton.css.js';
import {Widget} from '#chromium/ui/legacy/Widget.js';
import {nothing} from '#chromium/ui/lit/lit.js';

function appendCss(root: ShadowRoot, cssFiles: readonly unknown[]): void {
  for (const css of cssFiles) {
    const text = typeof css === 'string' ? css : String(css ?? '');
    if (!text) continue;
    const style = document.createElement('style');
    style.textContent = text;
    root.appendChild(style);
  }
}

export function createShadowRootWithCoreStyles(
    element: Element,
    options: {cssFile?: readonly unknown[]|unknown, delegatesFocus?: boolean} = {}): ShadowRoot {
  const root = element.attachShadow({mode: 'open', delegatesFocus: options.delegatesFocus});
  appendCss(root, [inspectorCommonStyles, textButtonStyles]);
  const files = Array.isArray(options.cssFile) ? options.cssFile : options.cssFile ? [options.cssFile] : [];
  appendCss(root, files);
  root.addEventListener('focus', focusChanged, true);
  return root;
}

function focusChanged(event: Event): void {
  const target = event.target as HTMLElement|null;
  let active: Element|null = target?.ownerDocument.activeElement ?? null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  let node: Node|null = active;
  while (node && !Widget.get(node)) {
    const root = node.getRootNode();
    node = node.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  let widget = node ? Widget.get(node) : undefined;
  while (widget?.parentWidget()) {
    const parent = widget.parentWidget();
    if (!parent) break;
    parent.setDefaultFocusedChild(widget);
    widget = parent;
  }
}
export function cloneCustomElement(element: Element): Element { return element.cloneNode(true) as Element; }
export function deepElementFromEvent(event: Event): Element|null {
  return (event.composedPath()[0] as Element | undefined) ?? null;
}
export function measuredScrollbarWidth(): number { return 0; }
export function deepElementFromPoint(
    documentRoot: Document|ShadowRoot|null|undefined, x: number, y: number): Node|null {
  let container = documentRoot;
  let node: Element|null = null;
  while (container) {
    const innerNode = container.elementFromPoint(x, y);
    if (!innerNode || node === innerNode) break;
    node = innerNode;
    container = node.shadowRoot;
  }
  return node;
}
export function enclosingNodeOrSelfWithNodeNameInArray(node: Node|null, names: readonly string[]): Node|null {
  for (let current = node; current; current = current.parentNode) {
    if (names.some(name => current?.nodeName.toLowerCase() === name.toLowerCase())) return current;
  }
  return null;
}
export function enclosingNodeOrSelfWithNodeName(node: Node|null, name: string): Node|null {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeName.toLowerCase() === name.toLowerCase()) return current;
  }
  return null;
}
export function createTextButton(text: string, handler: (event: Event) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'text-button';
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', handler);
  button.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopImmediatePropagation();
  });
  return button;
}
export function createTextChild(parent: Node, text: string): Text {
  const child = document.createTextNode(text);
  parent.appendChild(child);
  return child;
}
export function copyTextToClipboard(_text: string): void {}
export function handleElementValueModifications(_event: Event, _element: Element): void {}
export function isBeingEdited(_element: Element): boolean { return false; }
export function isEditing(): boolean { return false; }
export function runCSSAnimationOnce(element: Element, className: string): void {
  element.classList.add(className);
  queueMicrotask(() => element.classList.remove(className));
}
export const animateOn = (_enabled: boolean, _className: string): typeof nothing => nothing;

export class HTMLElementWithLightDOMTemplate extends HTMLElement {
  static cloneNode(node: Node): Node { return node.cloneNode(true); }
  static findCorrespondingElement(
      source: HTMLElement, sourceRoot: HTMLElement, targetRoot: Element): Element|null {
    const indexes: number[] = [];
    for (let current: Element|null = source; current && current !== sourceRoot; current = current.parentElement) {
      if (!current.parentElement) return null;
      indexes.push([...current.parentElement.children].indexOf(current));
    }
    let target: Element|null = targetRoot;
    for (const index of indexes.reverse()) target = target?.children.item(index) ?? null;
    return target;
  }
  protected addNodes(_nodes: NodeList|Node[]): void {}
  protected removeNodes(_nodes: NodeList|Node[]): void {}
  protected updateNode(_node: Node, _attribute: string|null): void {}
}
