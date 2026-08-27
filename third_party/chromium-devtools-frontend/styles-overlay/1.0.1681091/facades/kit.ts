import '#chromium/Images/Images.js';

const reviewedIconNames = new Set([
  'triangle-right',
  'triangle-down',
  'filter',
  'open-externally',
]);

export class Icon extends HTMLElement {
  readonly #shadow = this.attachShadow({mode: 'open'});
  #name = '';

  set name(value: string) {
    this.#name = reviewedIconNames.has(value) ? value : '';
    this.#render();
  }

  get name(): string {
    return this.#name;
  }

  connectedCallback(): void {
    this.#render();
  }

  #render(): void {
    this.#shadow.replaceChildren();
    if (!this.#name) return;
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: inline-block;
        flex: none;
        height: var(--sys-size-6);
        width: var(--sys-size-6);
        vertical-align: text-bottom;
      }
      .pin-op-icon-glyph {
        display: block;
        height: 100%;
        width: 100%;
        background-color: currentcolor;
        mask: var(--pin-op-icon-image) center / contain no-repeat;
        -webkit-mask: var(--pin-op-icon-image) center / contain no-repeat;
      }
    `;
    const glyph = document.createElement('span');
    glyph.className = 'pin-op-icon-glyph';
    glyph.style.setProperty('--pin-op-icon-image', `var(--image-file-${this.#name})`);
    this.#shadow.append(style, glyph);
  }
}

if (!customElements.get('devtools-icon')) customElements.define('devtools-icon', Icon);

export function createIcon(name: string, className?: string): Icon {
  const icon = document.createElement('devtools-icon') as Icon;
  icon.name = name;
  if (className) icon.className = className;
  return icon;
}
