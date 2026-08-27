// Test-only entrypoint used to probe the transformed upstream prototypes.
// This module is never the production or extension entrypoint.
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
