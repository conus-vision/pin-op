export class CSSModel {}
export class OverlayModel {
  static hideDOMNodeHighlight(_targetManager: unknown): void {}
}
export class RemoteObject {
  static toCallArgument(value: unknown): unknown { return value; }
}
export class ResourceTreeModel {}
export const Events = Object.freeze({DocumentOpened: 'DocumentOpened'});
export class RuntimeModel {}
export class SDKModel<Events = unknown> {
  static register(_model: unknown, _registration: unknown): void {}
  readonly #target: any;
  constructor(target: any) { this.#target = target; }
  target(): any { return this.#target; }
  dispatchEventToListeners(_event: unknown, _data?: unknown): void {}
}
export const Capability = Object.freeze({DOM: 1});
