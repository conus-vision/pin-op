type Strings = Readonly<Record<string, string>>;

function format(message: string, values?: Record<string, unknown>): string {
  if (!values) {
    return message;
  }
  return message.replace(/\{([A-Z0-9_]+)\}/g, (_match, key: string) => String(values[key] ?? ''));
}

export const i18n = Object.freeze({
  registerUIStrings: (_path: string, strings: Strings): Strings => strings,
  getLocalizedString: (strings: Strings, id: string, values?: Record<string, unknown>): string =>
    format(Object.values(strings).find(value => value === id) ?? id, values),
  getLazilyComputedLocalizedString: (strings: Strings, id: string) => (): string =>
    Object.values(strings).find(value => value === id) ?? id,
  lockedString: (value: string): string => value,
});
