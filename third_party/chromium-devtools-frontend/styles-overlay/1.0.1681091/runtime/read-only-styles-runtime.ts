import '../../../patches/1.0.1681091/facades/core-styles.js';

import {CSSMatchedStyles, PropertyState} from '#chromium/core/sdk/CSSMatchedStyles.js';
import {cssMetadata} from '#chromium/core/sdk/CSSMetadata.js';
import {StylesSidebarPane} from '#chromium/panels/elements/StylesSidebarPane.js';

type DeclarationState =
  'winning-known-author'|'overridden-known-author'|'inactive'|'unknown';

interface DeclarationSnapshot {
  readonly declarationRef: string;
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly state: DeclarationState;
}

interface ContextSnapshot {
  readonly kind: 'media'|'supports'|'layer'|'scope'|'container'|'starting-style'|'unknown';
  readonly text: string;
}

interface GeneratedSourceSnapshot {
  readonly label: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

interface RuleSnapshot {
  readonly ruleRef: string;
  readonly selectorText: string;
  readonly matchingSelectorIndices: readonly number[];
  readonly previewedSelectorIndices?: readonly number[];
  readonly declarations: readonly DeclarationSnapshot[];
  readonly contexts: readonly ContextSnapshot[];
  readonly generatedSource?: GeneratedSourceSnapshot;
}

interface InheritedSnapshot {
  readonly ancestorIndex: number;
  readonly displayLabel: string;
  readonly inlineStyle?: RuleSnapshot;
  readonly matchedRules: readonly RuleSnapshot[];
}

interface MatchedStylesSnapshot {
  readonly nodeRef: string;
  readonly inlineStyle?: RuleSnapshot;
  readonly matchedRules: readonly RuleSnapshot[];
  readonly inherited: readonly InheritedSnapshot[];
}

interface OriginDecoration {
  readonly label: string;
  readonly languageId: 'css'|'scss';
  readonly startLine: number;
  readonly startColumn: number;
  readonly clickable: boolean;
  readonly state?: 'pending'|'stale'|'incompatible';
}

interface OriginDeclaration {
  readonly property: string;
  readonly occurrence: number;
}

interface PaneOptions {
  readonly document: Document;
  readonly mount: HTMLElement;
  readonly resolveOrigin: (ruleRef: string) => OriginDecoration|undefined;
  readonly openOrigin: (ruleRef: string, declaration?: OriginDeclaration) => void;
  readonly previewMediaQuery?: (conditionText: string) => void;
  readonly onError: (error: unknown) => void;
}

interface RenderedModel {
  readonly matchedStyles: CSSMatchedStyles;
  readonly cssModel: object;
  readonly node: object;
  readonly ruleRefByStyle: ReadonlyMap<object, string>;
  readonly ruleByRef: ReadonlyMap<string, RuleSnapshot>;
  readonly declarationByProperty: WeakMap<object, OriginDeclaration>;
}

interface PropertyTreeElement {
  readonly property?: object;
  readonly listItemElement?: HTMLElement;
  children(): readonly PropertyTreeElement[];
}

interface PropertiesSection {
  style(): object;
  readonly propertiesTreeOutline?: {rootElement(): PropertyTreeElement};
}

interface ReadOnlyCSSQueryElement extends HTMLElement {
  readonly data?: {readonly queryPrefix: string; readonly queryText: string};
}

interface MutableComputedStyleModel {
  node: object|null;
  cssModel(): object|null;
  setModel(node: object|null, cssModel: object|null): void;
  addEventListener(): void;
  removeEventListener(): void;
}

interface PinOpStylesSidebarPane extends StylesSidebarPane {
  pinOpPresentMatchedStyles(matchedStyles: CSSMatchedStyles, signal: AbortSignal): Promise<void>;
  pinOpClearReadOnlyStyles(): void;
  pinOpDisposeReadOnlyStyles(): void;
}

export function createChromiumReadOnlyStylesRuntime() {
  return Object.freeze({
    createPane(options: PaneOptions): ChromiumReadOnlyStylesPane {
      return new ChromiumReadOnlyStylesPane(options);
    },
  });
}

class ChromiumReadOnlyStylesPane {
  readonly element: HTMLElement;
  readonly #mount: HTMLElement;
  readonly #previousMountStyle: Readonly<
    Record<'display'|'flexDirection'|'height'|'minHeight'|'overflow', string>
  >;
  readonly #pane: PinOpStylesSidebarPane;
  readonly #computedStyleModel: MutableComputedStyleModel;
  readonly #options: PaneOptions;
  #rendered: RenderedModel|undefined;
  #renderController: AbortController|undefined;
  #originController: AbortController|undefined;
  #revision = 0;
  #disposed = false;

  constructor(options: PaneOptions) {
    if (options.document !== document) {
      throw new Error('Native Styles runtime requires its owning browser document');
    }
    this.#options = options;
    this.#mount = options.mount;
    this.#previousMountStyle = Object.freeze({
      display: options.mount.style.display,
      flexDirection: options.mount.style.flexDirection,
      height: options.mount.style.height,
      minHeight: options.mount.style.minHeight,
      overflow: options.mount.style.overflow,
    });
    options.mount.style.display = 'flex';
    options.mount.style.flexDirection = 'column';
    options.mount.style.height = '100%';
    options.mount.style.minHeight = '0';
    options.mount.style.overflow = 'hidden';
    this.#computedStyleModel = createComputedStyleModel();
    this.#pane = new StylesSidebarPane(this.#computedStyleModel as never) as PinOpStylesSidebarPane;
    this.#pane.markAsRoot();
    this.#pane.show(options.mount);
    this.element = this.#pane.element;
    this.element.setAttribute('data-part', 'chromium-read-only-styles-pane');
    this.element.style.minHeight = '0';
    this.element.style.minWidth = '0';
    this.element.style.height = '100%';
    this.element.style.maxHeight = '100%';
    this.element.style.flex = '1 1 auto';
    this.element.style.overflow = 'auto';
    this.#adoptPinOpControlStyles();
  }

  // Chromium keeps this pane inside a widget shadow root, so the panel's own
  // scoped stylesheet cannot reach a Pin-op control mounted in the native
  // toolbar. Adopt exactly the read-only control rules next to it instead.
  #adoptPinOpControlStyles(): void {
    const root = this.#pane.contentElement.getRootNode();
    if (!(root instanceof ShadowRoot) ||
      root.querySelector('style[data-part="pin-op-control-styles"]')) {
      return;
    }
    const style = document.createElement('style');
    style.setAttribute('data-part', 'pin-op-control-styles');
    style.textContent = PIN_OP_CONTROL_STYLES;
    root.append(style);
  }

  render(snapshot: MatchedStylesSnapshot): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const revision = ++this.#revision;
    this.#renderController?.abort();
    this.#originController?.abort();
    this.#originController = undefined;
    const controller = new AbortController();
    this.#renderController = controller;
    return this.#present(snapshot, revision, controller);
  }

  refreshOrigins(): void {
    if (this.#disposed || !this.#rendered) return;
    this.#decorateOrigins(this.#rendered);
  }

  /**
   * Chromium's own Styles toolbar row. Pin-op mounts its read-only `:hov`
   * control here so the preview toggle sits where DevTools keeps the
   * element-state toggle instead of floating over the rule list.
   */
  toolbarElement(): HTMLElement|null {
    if (this.#disposed) return null;
    return this.#pane.contentElement.querySelector<HTMLElement>('devtools-toolbar.styles-pane-toolbar');
  }

  /** Chromium's toolbar pane below the toolbar row, used by the `:hov` preview. */
  toolbarPaneElement(): HTMLElement|null {
    if (this.#disposed) return null;
    return this.#pane.contentElement.querySelector<HTMLElement>('.styles-sidebar-toolbar-pane');
  }

  clear(): void {
    if (this.#disposed) return;
    this.#revision += 1;
    this.#renderController?.abort();
    this.#renderController = undefined;
    this.#originController?.abort();
    this.#originController = undefined;
    this.#rendered = undefined;
    this.#computedStyleModel.setModel(null, null);
    this.#pane.pinOpClearReadOnlyStyles();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revision += 1;
    this.#renderController?.abort();
    this.#renderController = undefined;
    this.#originController?.abort();
    this.#originController = undefined;
    this.#rendered = undefined;
    this.#computedStyleModel.setModel(null, null);
    this.#pane.pinOpDisposeReadOnlyStyles();
    this.#pane.detach();
    this.element.remove();
    this.#mount.style.display = this.#previousMountStyle.display;
    this.#mount.style.flexDirection = this.#previousMountStyle.flexDirection;
    this.#mount.style.height = this.#previousMountStyle.height;
    this.#mount.style.minHeight = this.#previousMountStyle.minHeight;
    this.#mount.style.overflow = this.#previousMountStyle.overflow;
  }

  async #present(
      snapshot: MatchedStylesSnapshot, revision: number, controller: AbortController): Promise<void> {
    try {
      const rendered = await createRenderedModel(snapshot);
      controller.signal.throwIfAborted();
      if (this.#disposed || revision !== this.#revision) return;
      this.#computedStyleModel.setModel(rendered.node, rendered.cssModel);
      await this.#pane.pinOpPresentMatchedStyles(rendered.matchedStyles, controller.signal);
      controller.signal.throwIfAborted();
      if (this.#disposed || revision !== this.#revision) return;
      this.#rendered = rendered;
      this.#decorateOrigins(rendered);
      this.#decoratePreviewedSelectors(rendered);
    } catch (error) {
      if (this.#disposed || revision !== this.#revision || controller.signal.aborted) return;
      this.#rendered = undefined;
      this.#computedStyleModel.setModel(null, null);
      this.#pane.pinOpClearReadOnlyStyles();
      this.#report(error);
      throw error;
    } finally {
      if (this.#renderController === controller) this.#renderController = undefined;
    }
  }

  #decorateOrigins(rendered: RenderedModel): void {
    this.#originController?.abort();
    const originController = new AbortController();
    this.#originController = originController;
    for (const subtitle of this.#pane.contentElement.querySelectorAll<HTMLElement>('.styles-section-subtitle')) {
      const sectionElement = subtitle.closest('.styles-section');
      const section = sectionElement ? this.#pane.sectionByElement.get(sectionElement) : undefined;
      const style = section?.style();
      const ruleRef = style ? rendered.ruleRefByStyle.get(style) : undefined;
      const rule = ruleRef ? rendered.ruleByRef.get(ruleRef) : undefined;
      if (!ruleRef || !rule) {
        subtitle.replaceChildren();
        continue;
      }
      const resolved = this.#options.resolveOrigin(ruleRef);
      const origin = resolved ?? generatedOrigin(rule.generatedSource);
      if (!origin) {
        subtitle.replaceChildren();
        continue;
      }
      const label = origin.startLine === undefined ? origin.label : `${origin.label}:${origin.startLine}`;
      if (origin.clickable && origin.state === undefined) {
        const button = this.#options.document.createElement('button');
        button.type = 'button';
        button.className = 'text-button link-style devtools-link pin-op-rule-origin';
        button.style.display = 'inline-block';
        button.style.inlineSize = '100px';
        button.style.maxInlineSize = '100%';
        button.style.overflow = 'hidden';
        button.style.textOverflow = 'ellipsis';
        button.style.whiteSpace = 'nowrap';
        const icon = this.#options.document.createElement('devtools-icon') as HTMLElement&{name: string};
        icon.name = 'open-externally';
        icon.className = 'pin-op-rule-origin-icon';
        button.append(label, icon);
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          this.#options.openOrigin(ruleRef);
        }, {signal: originController.signal});
        subtitle.replaceChildren(button);
        if (section) this.#decorateDeclarations(rendered, section, ruleRef, originController.signal);
      } else {
        subtitle.replaceChildren(this.#options.document.createTextNode(label));
      }
    }
    this.#decorateMediaQueries(originController.signal);
  }

  /**
   * Makes each declaration of a rule whose source can be opened open it at that
   * declaration's value, so the value can be edited straight away instead of
   * being looked for inside the rule. Longhands shown under a shorthand open the
   * shorthand the stylesheet wrote.
   */
  #decorateDeclarations(
      rendered: RenderedModel, section: object, ruleRef: string, signal: AbortSignal): void {
    const outline = (section as PropertiesSection).propertiesTreeOutline;
    if (!outline) return;
    const visit = (element: PropertyTreeElement, inherited: OriginDeclaration|undefined): void => {
      const declaration = (element.property ? rendered.declarationByProperty.get(element.property) : undefined) ??
          inherited;
      const item = element.listItemElement;
      if (declaration && item) {
        item.classList.add(OPENABLE_DECLARATION_CLASS);
        item.title = `Open ${declaration.property} in the IDE`;
        item.style.cursor = 'pointer';
        item.addEventListener('click', event => {
          if (event.defaultPrevented || this.#options.document.getSelection()?.isCollapsed === false) return;
          event.preventDefault();
          event.stopPropagation();
          this.#options.openOrigin(ruleRef, declaration);
        }, {signal});
        signal.addEventListener('abort', () => {
          item.classList.remove(OPENABLE_DECLARATION_CLASS);
          item.removeAttribute('title');
          item.style.cursor = '';
        }, {once: true});
      }
      for (const child of element.children()) visit(child, declaration);
    };
    for (const child of outline.rootElement().children()) visit(child, undefined);
  }

  /**
   * Makes an `@media` condition that names a viewport size show the page at that
   * size, so the rules it guards can be seen applying.
   */
  #decorateMediaQueries(signal: AbortSignal): void {
    const previewMediaQuery = this.#options.previewMediaQuery;
    if (!previewMediaQuery) return;
    for (const query of this.#pane.contentElement.querySelectorAll<ReadOnlyCSSQueryElement>(
             '.styles-section pin-op-readonly-css-query')) {
      const data = query.data;
      const text = query.shadowRoot?.querySelector<HTMLElement>('.query-text');
      if (!data || !text || data.queryPrefix !== '@media' || !VIEWPORT_MEDIA_FEATURE.test(data.queryText)) {
        continue;
      }
      const conditionText = data.queryText;
      text.title = 'Resize the page to this size';
      text.style.cursor = 'pointer';
      text.style.textDecoration = 'underline dotted';
      text.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        previewMediaQuery(conditionText);
      }, {signal});
      signal.addEventListener('abort', () => {
        text.removeAttribute('title');
        text.style.cursor = '';
        text.style.textDecoration = '';
      }, {once: true});
    }
  }

  /**
   * Marks the selectors the `:hov` preview is what makes match, so a previewed
   * rule reads the way a filtered one does instead of appearing among the
   * ordinary matches with nothing to tell it apart.
   */
  #decoratePreviewedSelectors(rendered: RenderedModel): void {
    for (const sectionElement of this.#pane.contentElement.querySelectorAll<HTMLElement>('.styles-section')) {
      const section = this.#pane.sectionByElement.get(sectionElement);
      const style = section?.style();
      const ruleRef = style ? rendered.ruleRefByStyle.get(style) : undefined;
      const rule = ruleRef ? rendered.ruleByRef.get(ruleRef) : undefined;
      const previewed = new Set(rule?.previewedSelectorIndices ?? []);
      const selectors = sectionElement.getElementsByClassName('simple-selector');
      for (let index = 0; index < selectors.length; index += 1) {
        selectors[index].classList.toggle(PREVIEWED_SELECTOR_CLASS, previewed.has(index));
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#options.onError(error);
    } catch {
      // Diagnostics are observational and never gain renderer authority.
    }
  }
}

const PREVIEWED_SELECTOR_CLASS = 'pin-op-previewed-selector';
const OPENABLE_DECLARATION_CLASS = 'pin-op-openable-declaration';
const VIEWPORT_MEDIA_FEATURE = /\b(?:(?:min|max)-)?(?:width|height)\b/i;

const PIN_OP_CONTROL_STYLES = `
.pseudo-state-toolbar-item {
  display: flex;
  flex: none;
  align-items: center;
  margin-inline: 2px;
}

.pseudo-state-button {
  appearance: none;
  min-height: 20px;
  min-width: 36px;
  margin: 0;
  padding: 1px 6px;
  border: 0;
  border-radius: 100px;
  color: var(--sys-color-on-surface);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.pseudo-state-button:hover:not(:disabled),
.pseudo-state-button[aria-expanded="true"] {
  background: var(--sys-color-state-hover-on-subtle);
}

.pseudo-state-button:disabled {
  color: var(--sys-color-state-disabled);
  cursor: default;
}

.pseudo-state-button:focus-visible {
  outline: 2px solid var(--sys-color-state-focus-ring);
  outline-offset: -2px;
}

.pseudo-state-pane {
  display: block;
  min-width: 0;
}

.pseudo-state-menu {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding: 2px 5px;
}

.pseudo-state-choice {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  cursor: pointer;
}

.pseudo-state-choice:has(input:disabled) {
  color: var(--sys-color-state-disabled);
  cursor: default;
}

.pseudo-state-choice input {
  flex: none;
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--sys-color-primary);
}

.pseudo-state-description {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.pseudo-state-description[role="status"],
.pseudo-state-description[role="alert"] {
  position: static;
  width: auto;
  height: auto;
  margin: 0;
  padding: 2px 5px 4px;
  overflow: visible;
  clip-path: none;
  color: var(--sys-color-on-surface-subtle);
  white-space: normal;
}

.pseudo-state-description[role="alert"] {
  border-inline-start: 3px solid var(--sys-color-error);
}

/* Exactly the mark the filter puts on what it matched, for what :hov matched. */
.simple-selector.pin-op-previewed-selector {
  background-color: var(--sys-color-tonal-container);
  color: var(--sys-color-on-surface);
}
`;

async function createRenderedModel(snapshot: MatchedStylesSnapshot): Promise<RenderedModel> {
  const cssModel = createReadOnlyCSSModel();
  const node = createNodeChain(snapshot, cssModel);
  const orderedRules = orderedRuleSnapshots(snapshot);
  const identityByRule = new Map(orderedRules.map((rule, index) =>
    [rule, `pin-op-rule:${index}`] as const));
  const ruleByIdentity = new Map([...identityByRule].map(([rule, identity]) => [identity, rule] as const));
  const matchedPayload = [...snapshot.matchedRules].reverse().map(rule =>
    ruleMatchPayload(rule, identityByRule.get(rule) as string));
  const inheritedPayload = snapshot.inherited.map(inherited => ({
    ...(inherited.inlineStyle ? {
      inlineStyle: stylePayload(inherited.inlineStyle, identityByRule.get(inherited.inlineStyle) as string),
    } : {}),
    matchedCSSRules: [...inherited.matchedRules].reverse().map(rule =>
      ruleMatchPayload(rule, identityByRule.get(rule) as string)),
  }));
  const matchedStyles = await CSSMatchedStyles.create({
    cssModel: cssModel as never,
    node: node as never,
    activePositionFallbackIndex: -1,
    inlinePayload: snapshot.inlineStyle ?
      stylePayload(snapshot.inlineStyle, identityByRule.get(snapshot.inlineStyle) as string) :
      snapshot.matchedRules.length === 0 ? emptyInlineStylePayload() : null,
    attributesPayload: null,
    matchedPayload,
    pseudoPayload: [],
    inheritedPayload,
    inheritedPseudoPayload: [],
    animationsPayload: [],
    parentLayoutNodeId: undefined,
    positionTryRules: [],
    propertyRules: [],
    cssPropertyRegistrations: [],
    atRules: [],
    animationStylesPayload: [],
    transitionsStylePayload: null,
    inheritedAnimatedPayload: snapshot.inherited.map(() => ({})),
    functionRules: [],
  });
  const ruleRefByStyle = new Map<object, string>();
  const propertyStates = new WeakMap<object, PropertyState|null>();
  const declarationByProperty = new WeakMap<object, OriginDeclaration>();
  for (const style of matchedStyles.nodeStyles()) {
    const identity = style.cssText;
    const rule = identity ? ruleByIdentity.get(identity) : undefined;
    style.cssText = undefined;
    if (!rule) continue;
    ruleRefByStyle.set(style, rule.ruleRef);
    const properties = style.leadingProperties();
    for (let index = 0; index < properties.length; index++) {
      const property = properties[index];
      const declaration = rule.declarations[index];
      if (!declaration) continue;
      const state = chromiumPropertyState(declaration.state);
      propertyStates.set(property, state);
      declarationByProperty.set(property, Object.freeze({
        property: declaration.name,
        occurrence: declarationOccurrence(rule.declarations, index),
      }));
      if (declaration.state === 'inactive') property.setActive(false);
    }
  }
  Object.defineProperty(matchedStyles, 'propertyState', {
    configurable: true,
    value: (property: object): PropertyState|null => propertyStates.get(property) ?? null,
  });
  return Object.freeze({
    matchedStyles,
    cssModel,
    node,
    ruleRefByStyle,
    ruleByRef: new Map(orderedRules.map(rule => [rule.ruleRef, rule])),
    declarationByProperty,
  });
}

/** Which occurrence of its property name, within its own rule, a declaration is. */
function declarationOccurrence(declarations: readonly DeclarationSnapshot[], index: number): number {
  const name = declarations[index].name.toLowerCase();
  let occurrence = 0;
  for (let earlier = 0; earlier < index; earlier++) {
    if (declarations[earlier].name.toLowerCase() === name) occurrence++;
  }
  return occurrence;
}

function orderedRuleSnapshots(snapshot: MatchedStylesSnapshot): RuleSnapshot[] {
  const rules: RuleSnapshot[] = [];
  if (snapshot.inlineStyle) rules.push(snapshot.inlineStyle);
  rules.push(...snapshot.matchedRules);
  for (const inherited of snapshot.inherited) {
    if (inherited.inlineStyle) rules.push(inherited.inlineStyle);
    rules.push(...inherited.matchedRules);
  }
  return rules;
}

function chromiumPropertyState(state: DeclarationState): PropertyState|null {
  if (state === 'winning-known-author') return PropertyState.ACTIVE;
  if (state === 'overridden-known-author') return PropertyState.OVERLOADED;
  return null;
}

function stylePayload(rule: RuleSnapshot, identity: string) {
  return {
    cssText: identity,
    cssProperties: rule.declarations.map(declaration => ({
      name: declaration.name,
      value: declaration.value,
      important: declaration.important,
      parsedOk: true,
      implicit: false,
      disabled: false,
      text: `${declaration.name}: ${declaration.value}${declaration.important ? ' !important' : ''};`,
      longhandProperties: readOnlyLonghandProperties(declaration),
    })),
    shorthandEntries: [],
  };
}

function emptyInlineStylePayload() {
  return {
    cssText: undefined,
    cssProperties: [],
    shorthandEntries: [],
  };
}

function readOnlyLonghandProperties(declaration: DeclarationSnapshot) {
  const longhandNames = cssMetadata().getLonghands(declaration.name.toLowerCase());
  if (!longhandNames?.length) return [];
  // CSSOM expansion happens on a detached element. It neither touches the
  // inspected page nor grants a CSSModel writer, while matching each host
  // browser's serialization for the pinned Chromium longhand inventory.
  const scratchStyle = document.createElement('span').style;
  scratchStyle.setProperty(declaration.name, declaration.value, declaration.important ? 'important' : '');
  return longhandNames.map(longhandName => ({
    name: longhandName,
    value: scratchStyle.getPropertyValue(longhandName),
    important: declaration.important,
    parsedOk: true,
    implicit: true,
    disabled: false,
    text: `${longhandName}: ${scratchStyle.getPropertyValue(longhandName)}${declaration.important ? ' !important' : ''};`,
  })).filter(property => property.value !== '');
}

function ruleMatchPayload(rule: RuleSnapshot, identity: string) {
  const selectors = splitSelectorList(rule.selectorText);
  return {
    rule: {
      selectorList: {
        text: rule.selectorText,
        selectors: selectors.map(text => ({text})),
      },
      origin: 'regular',
      style: stylePayload(rule, identity),
      ...contextPayload(rule.contexts),
    },
    matchingSelectors: rule.matchingSelectorIndices.filter(index => index < selectors.length),
  };
}

function contextPayload(contexts: readonly ContextSnapshot[]) {
  const media = [];
  const supports = [];
  const layers = [];
  const scopes = [];
  const containerQueries = [];
  const startingStyles = [];
  const ruleTypes = [];
  // The neutral contract is outer-to-inner; CDP and the pinned pane consume
  // ancestor rule evidence from the innermost rule going outwards.
  for (const context of [...contexts].reverse()) {
    if (context.kind === 'media') {
      media.push({text: context.text, source: 'mediaRule'});
      ruleTypes.push('MediaRule');
    } else if (context.kind === 'supports') {
      supports.push({text: context.text, active: true});
      ruleTypes.push('SupportsRule');
    } else if (context.kind === 'layer') {
      layers.push({text: context.text});
      ruleTypes.push('LayerRule');
    } else if (context.kind === 'scope') {
      scopes.push({text: context.text});
      ruleTypes.push('ScopeRule');
    } else if (context.kind === 'container') {
      containerQueries.push({text: context.text});
      ruleTypes.push('ContainerRule');
    } else if (context.kind === 'starting-style') {
      startingStyles.push({});
      ruleTypes.push('StartingStyleRule');
    }
  }
  return {media, supports, layers, scopes, containerQueries, startingStyles, ruleTypes};
}

function splitSelectorList(selectorText: string): string[] {
  const selectors = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < selectorText.length; index++) {
    const character = selectorText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start).trim());
  return selectors.filter(Boolean);
}

function createReadOnlyCSSModel() {
  const target = Object.freeze({model: () => null});
  const domModel = Object.freeze({
    getContainerForNode(
        _nodeId: number, _containerName?: string, _physicalAxes?: string, _logicalAxes?: string,
        _queriesScrollState?: boolean, _queriesAnchored?: boolean): Promise<undefined> {
      return Promise.resolve(undefined);
    },
  });
  return Object.freeze({
    async getEnvironmentVariables(): Promise<Record<string, string>> { return {}; },
    styleSheetHeaderForId(): null { return null; },
    sourceMapManager(): {sourceMapForClient(): null} { return {sourceMapForClient: () => null}; },
    domModel(): object { return domModel; },
    target(): object { return target; },
  });
}

function createComputedStyleModel(): MutableComputedStyleModel {
  let cssModel: object|null = null;
  return {
    node: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    cssModel(): object|null { return cssModel; },
    setModel(node: object|null, nextCSSModel: object|null): void {
      this.node = node;
      cssModel = nextCSSModel;
    },
  };
}

function createNodeChain(snapshot: MatchedStylesSnapshot, cssModel: object) {
  const refs = [snapshot.nodeRef, ...snapshot.inherited.map(item => `inherited:${item.ancestorIndex}`)];
  const inheritedLabels = [undefined, ...snapshot.inherited.map(item => item.displayLabel)];
  const nodes = refs.map((ref, index) => ({
    id: index + 1,
    parentNode: null as unknown,
    ownerDocument: null as unknown,
    nodeType: () => 1,
    backendNodeId: () => index + 1,
    nodeNameInCorrectCase: () => index === 0 ? 'div' : 'body',
    hasAssignedSlot: () => false,
    pseudoType: () => null,
    getAttribute: () => null,
    pinOpInheritedLabel: inheritedLabels[index],
    domModel: () => ({cssModel: () => cssModel}),
    toString: () => ref,
  }));
  for (let index = 0; index < nodes.length - 1; index++) {
    nodes[index].parentNode = nodes[index + 1];
  }
  const ownerDocument = {id: 1};
  for (const node of nodes) node.ownerDocument = ownerDocument;
  return nodes[0];
}

function generatedOrigin(source: GeneratedSourceSnapshot|undefined): {
  readonly label: string;
  readonly languageId: 'css';
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly clickable: false;
}|undefined {
  if (!source) return undefined;
  return {
    label: safeSourceLabel(source.label),
    languageId: 'css',
    ...(source.lineNumber === undefined ? {} : {startLine: source.lineNumber}),
    ...(source.columnNumber === undefined ? {} : {startColumn: source.columnNumber}),
    clickable: false,
  };
}

function safeSourceLabel(label: string): string {
  const segments = label.split(/[\\/]/);
  return segments.at(-1) || label;
}
