import * as ObjectWrapper from '#chromium/core/common/Object.js';
import * as ParsedURL from '#chromium/core/common/ParsedURL.js';
import * as Srcset from '#chromium/core/common/Srcset.js';
import * as Throttler from '#chromium/core/common/Throttler.js';

export const EventTarget = Object.freeze({});
export {ObjectWrapper, ParsedURL, Srcset, Throttler};

class ReadOnlySetting<T> extends ObjectWrapper.ObjectWrapper<{change: T}> {
  #value: T;
  constructor(value: T) { super(); this.#value = value; }
  get(): T { return this.#value; }
  set(value: T): void { this.#value = value; this.dispatchEventToListeners('change', value); }
  addChangeListener(listener: (event: unknown) => void, thisObject?: object): void {
    this.addEventListener('change', listener as never, thisObject);
  }
  removeChangeListener(listener: (event: unknown) => void, thisObject?: object): void {
    this.removeEventListener('change', listener as never, thisObject);
  }
}

class ReadOnlySettings {
  static #instance = new ReadOnlySettings();
  readonly #settings = new Map<string, ReadOnlySetting<unknown>>();
  static instance(_options?: unknown): ReadOnlySettings { return ReadOnlySettings.#instance; }
  moduleSetting<T = unknown>(name: string): ReadOnlySetting<T> {
    let setting = this.#settings.get(name);
    if (!setting) {
      const defaults: Record<string, unknown> = {
        'highlight-node-on-hover-in-overlay': false,
        'show-html-comments': true,
        'show-ua-shadow-dom': false,
        'text-editor-indent': '  ',
      };
      setting = new ReadOnlySetting(defaults[name] ?? false);
      this.#settings.set(name, setting);
    }
    return setting as ReadOnlySetting<T>;
  }
  createSetting<T>(_name: string, defaultValue: T): ReadOnlySetting<T> {
    return new ReadOnlySetting(defaultValue);
  }
}

export const Settings = Object.freeze({Settings: ReadOnlySettings, Setting: ReadOnlySetting});

export const Revealer = Object.freeze({
  reveal: async (_value: unknown): Promise<void> => {},
});
