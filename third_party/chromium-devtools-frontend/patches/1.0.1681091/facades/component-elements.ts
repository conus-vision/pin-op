class DevToolsAdorner extends HTMLElement {
  name = '';
  hide(): void { this.hidden = true; }
  show(): void { this.hidden = false; }
}
if (!customElements.get('devtools-adorner')) customElements.define('devtools-adorner', DevToolsAdorner);
