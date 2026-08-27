import * as DOMModel from '#chromium/core/sdk/DOMModel.js';

class EmptyTargetManager {
  static #instance = new EmptyTargetManager();
  static instance(): EmptyTargetManager { return EmptyTargetManager.#instance; }
  addModelListener(): void {}
  removeModelListener(): void {}
  models(): unknown[] { return []; }
}

class EmptyOverlayModel {
  static hideDOMNodeHighlight(_targetManager: unknown): void {}
}

export {DOMModel};
export const ConsoleModel = Object.freeze({ConsoleModel: class {}});
export const OverlayModel = Object.freeze({
  OverlayModel: EmptyOverlayModel,
  Events: Object.freeze({
    HIGHLIGHT_NODE_REQUESTED: 'HighlightNodeRequested',
    INSPECT_MODE_WILL_BE_TOGGLED: 'InspectModeWillBeToggled',
  }),
});
export const RuntimeModel = Object.freeze({ExecutionContext: class {}});
export const TargetManager = Object.freeze({TargetManager: EmptyTargetManager});
export const CSSMatchedStyles = Object.freeze({PropertyState: Object.freeze({ACTIVE: 'Active'})});
export const CSSMetadata = Object.freeze({
  cssMetadata: () => Object.freeze({isPropertyInherited: (_name: string): boolean => false}),
});
export const CSSModel = Object.freeze({});
export const FrameManager = Object.freeze({
  FrameManager: class {
    static instance(): {getFrame: (_id: string) => null} { return {getFrame: () => null}; }
  },
});
export const RemoteObject = Object.freeze({
  RemoteObject: class {},
  RemoteFunction: class {
    static objectAsFunction(_value: unknown): {targetFunctionDetails: () => Promise<null>} {
      return {targetFunctionDetails: async () => null};
    }
  },
});
export const Target = Object.freeze({});
