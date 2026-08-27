import * as ObjectWrapper from '#chromium/core/common/Object.js';
import * as Throttler from '#chromium/core/common/Throttler.js';
import * as Color from '#chromium/core/common/Color.js';

export {Color, ObjectWrapper, Throttler};
export const EventTarget = Object.freeze({});

class ReadOnlySetting<T> extends ObjectWrapper.ObjectWrapper<{change: T}> {
  #value: T;
  constructor(value: T) { super(); this.#value = value; }
  get(): T { return this.#value; }
  set(_value: T): void { throw new Error('Chromium Styles settings are read-only'); }
  addChangeListener(_listener: (event: unknown) => void, _thisObject?: object): void {}
  removeChangeListener(_listener: (event: unknown) => void, _thisObject?: object): void {}
}

class ReadOnlySettings {
  static #instance = new ReadOnlySettings();
  readonly #settings = new Map<string, ReadOnlySetting<unknown>>();
  static instance(): ReadOnlySettings { return ReadOnlySettings.#instance; }
  moduleSetting<T = unknown>(name: string): ReadOnlySetting<T> {
    let setting = this.#settings.get(name);
    if (!setting) {
      const defaults: Record<string, unknown> = {
        'text-editor-indent': '  ',
        'collapse-non-contributing-css-rules': false,
        'show-css-property-documentation-on-hover': false,
      };
      setting = new ReadOnlySetting(defaults[name] ?? false);
      this.#settings.set(name, setting);
    }
    return setting as ReadOnlySetting<T>;
  }
}

export const Settings = Object.freeze({Settings: ReadOnlySettings, Setting: ReadOnlySetting});
export const Revealer = Object.freeze({reveal: async (_value: unknown): Promise<void> => {}});
export const DOMLinkifier = Object.freeze({});
