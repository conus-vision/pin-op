import * as ArrayUtilities from '#chromium/core/platform/ArrayUtilities.js';
import * as NumberUtilities from '#chromium/core/platform/NumberUtilities.js';
import * as StringUtilities from '#chromium/core/platform/StringUtilities.js';

export {ArrayUtilities, NumberUtilities, StringUtilities};
export const DevToolsPath = Object.freeze({EmptyUrlString: ''});
export const KeyboardUtilities = Object.freeze({
  ENTER_KEY: 'Enter',
  isEnterOrSpaceKey: (event: KeyboardEvent): boolean => event.key === 'Enter' || event.key === ' ',
  isEscKey: (event: KeyboardEvent): boolean => event.key === 'Escape',
});
export const isMac = (): boolean => false;
export function assertNotNullOrUndefined<T>(value: T|null|undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value');
  return value;
}
