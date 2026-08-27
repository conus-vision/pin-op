import * as TreeOutline from '#chromium/ui/legacy/Treeoutline.js';
import * as Widget from '#chromium/ui/legacy/Widget.js';
import * as UIUtils from './ui-utils.js';

class NoopPopoverHelper {
  constructor(_element: Element, _request: unknown) {}
  dispose(): void {}
  hidePopover(): void {}
  setTimeout(_show: number, _hide: number): void {}
}

class ReadOnlyActionRegistry {
  static instance(): ReadOnlyActionRegistry { return new ReadOnlyActionRegistry(); }
  hasAction(_id: string): boolean { return false; }
  getAction(_id: string): {execute: () => Promise<void>, title: () => string} {
    return {execute: async () => {}, title: () => ''};
  }
}

class ReadOnlyContextMenu {
  constructor(_event: Event, _options?: unknown) {}
  defaultSection(): {appendItem: (...args: unknown[]) => void} { return {appendItem: () => {}}; }
  async show(): Promise<void> {}
}

class InplaceConfig<T = unknown> {
  constructor(..._args: unknown[]) {}
}

export {TreeOutline, UIUtils, Widget};
export const ARIAUtils = Object.freeze({setLabel: (element: Element, label: string|null): void => {
  if (label !== null) element.setAttribute('aria-label', label);
}});
export const ActionRegistry = Object.freeze({ActionRegistry: ReadOnlyActionRegistry});
export const Context = Object.freeze({Context: class {
  static instance(): {flavor: (_type: unknown) => null, setFlavor: () => void} {
    return {flavor: () => null, setFlavor: () => {}};
  }
}});
export const ContextMenu = Object.freeze({ContextMenu: ReadOnlyContextMenu});
export const GlassPane = Object.freeze({GlassPane: class {contentElement = document.createElement('div');}});
export const InplaceEditor = Object.freeze({
  Config: InplaceConfig,
  InplaceEditor: class { static startEditing(): null { return null; } },
});
export const KeyboardShortcut = Object.freeze({KeyboardShortcut: Object.freeze({
  eventHasCtrlEquivalentKey: (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey,
  eventHasEitherCtrlOrMeta: (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey,
})});
export const PopoverHelper = Object.freeze({PopoverHelper: NoopPopoverHelper});
export const ViewManager = Object.freeze({ViewManager: class {
  static instance(): {showView: () => Promise<void>, view: () => null} {
    return {showView: async () => {}, view: () => null};
  }
}});
