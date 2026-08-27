const values = new Map<unknown, unknown>();

export const DevToolsContext = Object.freeze({
  globalInstance: () => Object.freeze({
    get: (key: unknown) => values.get(key),
    has: (key: unknown) => values.has(key),
    set: (key: unknown, value: unknown) => values.set(key, value),
  }),
});

export const Runtime = Object.freeze({
  hostConfig: Object.freeze({devToolsAllowInterestForcing: false}),
});
