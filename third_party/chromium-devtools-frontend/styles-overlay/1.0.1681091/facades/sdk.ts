import * as CSSContainerQuery from '#chromium/core/sdk/CSSContainerQuery.js';
import * as CSSLayer from '#chromium/core/sdk/CSSLayer.js';
import * as CSSMatchedStyles from '#chromium/core/sdk/CSSMatchedStyles.js';
import * as CSSMedia from '#chromium/core/sdk/CSSMedia.js';
import * as CSSMetadata from '#chromium/core/sdk/CSSMetadata.js';
import * as CSSProperty from '#chromium/core/sdk/CSSProperty.js';
import * as CSSQuery from './css-query.js';
import * as CSSRule from '#chromium/core/sdk/CSSRule.js';
import * as CSSScope from '#chromium/core/sdk/CSSScope.js';
import * as CSSStartingStyle from '#chromium/core/sdk/CSSStartingStyle.js';
import * as CSSStyleDeclaration from '#chromium/core/sdk/CSSStyleDeclaration.js';
import * as CSSSupports from '#chromium/core/sdk/CSSSupports.js';
import * as DOMModel from './dom-model.js';
import * as CSSPropertyParser from '#chromium/core/sdk/CSSPropertyParser.js';
import * as CSSPropertyParserMatchers from '#chromium/core/sdk/CSSPropertyParserMatchers.js';

export {
  CSSContainerQuery, CSSLayer, CSSMatchedStyles, CSSMedia, CSSMetadata, CSSProperty, CSSPropertyParser,
  CSSPropertyParserMatchers, CSSQuery, CSSRule, CSSScope, CSSStartingStyle, CSSStyleDeclaration, CSSSupports, DOMModel,
};
export class CSSLocation { constructor(..._args: unknown[]) {} }
class ReadOnlyCSSModel {
  static readableLayerName(text: string): string { return text || '<anonymous>'; }
}
export const CSSModel = Object.freeze({CSSLocation, CSSModel: ReadOnlyCSSModel});
export const CSSStyleSheetHeader = Object.freeze({});
export const OverlayModel = Object.freeze({OverlayModel: class {static hideDOMNodeHighlight(): void {}}});
export const TargetManager = Object.freeze({TargetManager: class {static instance() { return {}; }}});
export const AnimationModel = Object.freeze({});
export const SDKSettings = Object.freeze({});
