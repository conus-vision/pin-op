export class ImagePreviewPopover { hide(): void {} }
export class StylePropertyHighlighter {
  constructor(..._args: unknown[]) {}
  async highlightProperty(): Promise<void> {}
}
export class StyleEditorWidget {
  static instance() { return {getSection: () => null, unbindContext: () => {}, bindContext: () => {}}; }
}
export const ElementsPanel = class { static instance() { return {}; } };
export const WebCustomData = class { static create() { return undefined; } };
export const LayersWidget = class { static instance() {
  return {isShowing: (): boolean => false, revealLayer: (_name: string): void => {}};
}};
export class ButtonProvider {
  static instance() { return {item: () => ({setVisible: (_value: boolean) => {}})}; }
}
export const formatSpecificitySummary = (): string => '';
export const getSpecificityBreakdownLines = (): string[] => [];
export const cssRuleValidatorsMap = new Map();
export class CSSValueTraceView extends HTMLElement {}
export class BezierPopoverIcon {}
export class ColorSwatchPopoverIcon {}
export const ColorSwatchPopoverIconEvents = Object.freeze({});
export const ShadowEvents = Object.freeze({});
export class ShadowSwatchPopoverHelper {}
export const getCssDeclarationAsJavascriptProperty = (): string => '';
export const ComputedStyleModel = Object.freeze({
  Events: Object.freeze({CSS_MODEL_CHANGED: 'CSSModelChanged', COMPUTED_STYLE_CHANGED: 'ComputedStyleChanged'}),
  ComputedStyleModel: class {},
});
export const FormatPickerContextMenu = Object.freeze({FormatPickerContextMenu: class {
  constructor(..._args: unknown[]) {}
  async show(_event: Event, _callback: (color: unknown) => void): Promise<void> {}
}});
