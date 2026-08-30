import {createPinOpChromiumInspectorViewFactory, installGeckoDomCompatibility} from
  '@pin-op/devtools-elements-ui/chromium-adapter';
import {chromiumElementsRuntime} from
  '../third_party/chromium-devtools-frontend/patches/1.0.1681091/entrypoints/read-only-elements.js';
import {chromiumReadOnlyStylesRuntime} from
  '../third_party/chromium-devtools-frontend/styles-overlay/1.0.1681091/entrypoints/read-only-styles.js';

// Before any upstream code runs: Gecko has no ShadowRoot.getSelection(), and
// without it every tree click handler throws on its first line.
installGeckoDomCompatibility();

// Keep the authority surface explicit. Neither overlay can replace capabilities
// owned by the other, and no raw Chromium class escapes this browser module.
const chromiumInspectorRuntime = Object.freeze({
  ...chromiumElementsRuntime,
  ...chromiumReadOnlyStylesRuntime,
});

export const createElementsInspectorView =
  createPinOpChromiumInspectorViewFactory(chromiumInspectorRuntime);
