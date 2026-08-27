export const InspectorFrontendHost = Object.freeze({
  isUnderTest: (): boolean => false,
  InspectorFrontendHostInstance: Object.freeze({
    copyText: (_text: string): void => {},
    isUnderTest: (): boolean => false,
  }),
});
export const UserMetrics = Object.freeze({
  Action: Object.freeze({StyleRuleCopied: 0}),
  SwatchType: Object.freeze({}),
});
export const userMetrics = Object.freeze({
  actionTaken: (_action: unknown): void => {},
  swatchActivated: (_swatch: unknown): void => {},
});
