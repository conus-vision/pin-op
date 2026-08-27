const extension = Object.freeze({});
const instance = Object.freeze({instance: () => extension});
export const Config = Object.freeze({
  baseConfiguration: () => extension,
  closeBrackets: instance,
  autocompletion: instance,
  domWordWrap: instance,
});
export const TextEditor = Object.freeze({TextEditor: class extends HTMLElement {state = null;}});
