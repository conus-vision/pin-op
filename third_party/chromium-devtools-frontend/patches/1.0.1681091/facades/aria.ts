const booleanAttribute = (element: Element, name: string, value: boolean): void =>
  element.setAttribute(name, String(value));
export const clearSelected = (element: Element): void => element.removeAttribute('aria-selected');
export const markAsGroup = (element: Element): void => element.setAttribute('role', 'group');
export const markAsTree = (element: Element): void => element.setAttribute('role', 'tree');
export const markAsTreeitem = (element: Element): void => element.setAttribute('role', 'treeitem');
export const setExpanded = (element: Element, value: boolean): void => booleanAttribute(element, 'aria-expanded', value);
export const setSelected = (element: Element, value: boolean): void => booleanAttribute(element, 'aria-selected', value);
export const unsetExpandable = (element: Element): void => element.removeAttribute('aria-expanded');
export const LiveAnnouncer = Object.freeze({status: (_message: string): void => {}});
