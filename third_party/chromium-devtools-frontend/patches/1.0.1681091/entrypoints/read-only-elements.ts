// Production entrypoint for Pin-op's read-only Chromium Elements tree.
// Every #chromium resolution is confined to the pinned npm package by the
// build-time overlay verifier.
import '#chromium/ui/dom_extension/dom_extension.js';
import '../facades/core-styles.js';

export {
  DOMDocument,
  DOMModel,
  DOMNode,
  DOMNodeEvents,
  Events as DOMModelEvents,
} from '#chromium/core/sdk/DOMModel.js';
export {ElementsTreeOutline} from '#chromium/panels/elements/ElementsTreeOutline.js';
export {
  ElementsTreeElement,
  ElementsTreeWidget,
} from '#chromium/panels/elements/ElementsTreeElement.js';
export {
  Events as TreeOutlineEvents,
  TreeElement,
} from '#chromium/ui/legacy/Treeoutline.js';
export {createShadowRootWithCoreStyles, createTextButton} from '../facades/ui-utils.js';
