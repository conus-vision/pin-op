export const Platform = Object.freeze({isMac: (): boolean => false});
export const InspectorFrontendHost = Object.freeze({
  InspectorFrontendHostInstance: Object.freeze({copyText: (_text: string): void => {}}),
});
export const UserMetrics = Object.freeze({
  Action: Object.freeze({ChangeInspectedNodeInElementsPanel: 0}),
});
export const userMetrics = Object.freeze({actionTaken: (_action: unknown): void => {}});
