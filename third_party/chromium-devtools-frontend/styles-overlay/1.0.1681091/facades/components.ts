import {html} from '#chromium/ui/lit/lit.js';

class ReadOnlyLinkifier {
  constructor(..._args: unknown[]) {}
  reset(): void {}
  dispose(): void {}
  linkifyCSSLocation(): Node { return document.createTextNode(''); }
  static renderLinkifiedUrl(url: string): unknown { return html`${url}`; }
}
export const Linkifier = Object.freeze({Linkifier: ReadOnlyLinkifier, ScriptLocationLink: class extends HTMLElement {}});
export const ImagePreview = Object.freeze({loadPrecomputedFeatures: async () => undefined});
