import {html} from '#chromium/ui/lit/lit.js';

export const ImagePreview = Object.freeze({loadPrecomputedFeatures: async () => undefined});
export const Linkifier = Object.freeze({
  Linkifier: class {
    static renderLinkifiedUrl(url: string): unknown { return html`${url}`; }
  },
  ScriptLocationLink: class extends HTMLElement {},
});
