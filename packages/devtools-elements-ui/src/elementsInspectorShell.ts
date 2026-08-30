import type {
  CreateElementsRulesRenderer,
  CreateElementsTreeRenderer,
  ElementsRulesRendererHost,
  ElementsTreeRendererHost,
  PseudoStateDataSource,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
  TreeDataSource,
} from "./contracts.js";

const CHROMIUM_BASELINE_THEME_CLASS = "baseline-grayscale";

// Chromium's Elements panel stacks its sidebar under the tree at this width.
const STACKED_LAYOUT_QUERY = "(max-width: 680px)";
const RESIZE_STEP = 16;
const MINIMUM_PANE_SIZE = 160;
const RESIZE_AXES = Object.freeze(["inline", "block"] as const);
const SIDEBAR_SIZE_PROPERTY = Object.freeze({
  inline: "--pin-op-elements-sidebar-width",
  block: "--pin-op-elements-sidebar-height",
});
const SIDEBAR_SIZE_STORAGE_KEY = Object.freeze({
  inline: "pin-op.inspector.sidebar-width",
  block: "pin-op.inspector.sidebar-height",
});
const DEFAULT_SIDEBAR_FRACTION = Object.freeze({ inline: 0.38, block: 0.45 });
const MINIMUM_SIDEBAR_SIZE = Object.freeze({ inline: 220, block: 120 });

type ResizeAxis = (typeof RESIZE_AXES)[number];

const nextAriaIdSequence = new WeakMap<Document, number>();
const chromiumThemeBridges = new WeakMap<Document, ChromiumThemeBridgeState>();

export class ElementsInspectorShell {
  public readonly element: HTMLElement;
  public readonly domRoot: HTMLElement;
  public readonly rulesRoot: HTMLElement;
  public readonly sidebarExtensionMount: HTMLElement;
  private readonly rulesTab: HTMLElement;
  private readonly sourceTab: HTMLElement;
  private readonly resizer: HTMLElement;
  private stackedMediaQuery: MediaQueryList | undefined;
  private resizePointerId: number | undefined;
  private resizeOffset = 0;
  private treeRendererHost: ElementsTreeRendererHost | undefined;
  private rulesDataSource: RulesDataSource | undefined;
  private rulesPane: ElementsRulesRendererHost | undefined;
  private rulesMessage: HTMLElement | undefined;
  private unsubscribeRules: (() => void) | undefined;
  private themeMediaQuery: MediaQueryList | undefined;
  private readonly themeOwner = Symbol("pin-op-chromium-theme-owner");
  private ownsChromiumTheme = false;
  private rulesRenderRevision = 0;
  private disposed = false;

  private readonly updateChromiumTheme = (event: MediaQueryListEvent): void => {
    if (!this.ownsChromiumTheme) return;
    updateChromiumThemeOwner(this.document, this.themeOwner, event.matches);
  };

  private readonly startResize = (event: PointerEvent): void => {
    this.beginResize(event);
  };

  private readonly continueResize = (event: PointerEvent): void => {
    this.updateResize(event);
  };

  private readonly finishResize = (event: PointerEvent): void => {
    this.endResize(event);
  };

  private readonly resizeByKey = (event: KeyboardEvent): void => {
    this.nudgeResize(event);
  };

  private readonly applyStackedOrientation = (): void => {
    this.renderResizerOrientation();
  };

  private readonly showRules = (): void => {
    this.selectSidebarTab("rules");
  };

  private readonly showSource = (): void => {
    this.selectSidebarTab("source");
  };

  private readonly navigateFromRulesTab = (event: KeyboardEvent): void => {
    this.navigateSidebarTabs("rules", event);
  };

  private readonly navigateFromSourceTab = (event: KeyboardEvent): void => {
    this.navigateSidebarTabs("source", event);
  };

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    treeDataSource: TreeDataSource,
    rulesDataSource: RulesDataSource | undefined,
    sourceLinkDelegate: SourceLinkDelegate | undefined,
    pseudoStateDataSource: PseudoStateDataSource | undefined,
    createTreeRenderer: CreateElementsTreeRenderer,
    private readonly createRulesRenderer: CreateElementsRulesRenderer,
  ) {
    const ariaIds = allocateAriaIds(document);
    this.element = this.createElement("section", {
      className: "pin-op-elements-inspector",
      attributes: {
        "aria-label": "Elements inspector",
        "data-part": "inspector-workspace",
      },
    });

    this.domRoot = this.createElement("section", {
      className: "pin-op-elements-inspector__dom-pane",
      attributes: {
        "aria-label": "DOM tree",
        "data-pane": "dom",
      },
    });

    const sidebar = this.createElement("aside", {
      className: "pin-op-elements-inspector__sidebar",
      attributes: {
        "aria-label": "Element details",
        "data-pane": "sidebar",
      },
    });
    const tabList = this.createElement("div", {
      className: "pin-op-elements-inspector__tabs",
      attributes: {
        "aria-label": "Element details",
        "aria-orientation": "horizontal",
        role: "tablist",
      },
    });
    this.rulesTab = this.createElement("button", {
      className: "pin-op-elements-inspector__tab",
      text: "Rules",
      attributes: {
        "aria-controls": ariaIds.rulesPanel,
        "aria-selected": "true",
        id: ariaIds.rulesTab,
        role: "tab",
        tabindex: "0",
        type: "button",
      },
    });
    this.sourceTab = this.createElement("button", {
      className: "pin-op-elements-inspector__tab",
      text: "Source",
      attributes: {
        "aria-controls": ariaIds.sourcePanel,
        "aria-selected": "false",
        id: ariaIds.sourceTab,
        role: "tab",
        tabindex: "-1",
        type: "button",
      },
    });
    this.resizer = this.createElement("div", {
      className: "pin-op-elements-inspector__resizer",
      attributes: {
        "aria-label": "Resize the element details pane",
        "aria-orientation": "vertical",
        "data-part": "sidebar-resizer",
        role: "separator",
        tabindex: "0",
      },
    });
    this.resizer.addEventListener("pointerdown", this.startResize);
    this.resizer.addEventListener("pointermove", this.continueResize);
    this.resizer.addEventListener("pointerup", this.finishResize);
    this.resizer.addEventListener("pointercancel", this.finishResize);
    this.resizer.addEventListener("keydown", this.resizeByKey);
    this.rulesTab.addEventListener("click", this.showRules);
    this.sourceTab.addEventListener("click", this.showSource);
    this.rulesTab.addEventListener("keydown", this.navigateFromRulesTab);
    this.sourceTab.addEventListener("keydown", this.navigateFromSourceTab);
    tabList.append(this.rulesTab, this.sourceTab);

    this.rulesRoot = this.createElement("section", {
      className: "pin-op-elements-inspector__rules",
      attributes: {
        "aria-labelledby": ariaIds.rulesTab,
        "data-pane": "rules",
        id: ariaIds.rulesPanel,
        role: "tabpanel",
        "aria-readonly": "true",
      },
    });
    this.sidebarExtensionMount = this.createElement("div", {
      className: "pin-op-elements-inspector__sidebar-extension",
      attributes: {
        "aria-hidden": "true",
        "aria-labelledby": ariaIds.sourceTab,
        "data-part": "sidebar-extension",
        id: ariaIds.sourcePanel,
        role: "tabpanel",
      },
    });
    this.sidebarExtensionMount.hidden = true;
    sidebar.append(tabList, this.rulesRoot, this.sidebarExtensionMount);
    this.element.append(this.domRoot, this.resizer, sidebar);

    try {
      this.bindColorScheme();
      this.bindSidebarSize();
      this.treeRendererHost = createTreeRenderer(
        document,
        this.domRoot,
        treeDataSource,
      );
      if (rulesDataSource) {
        this.bindRulesDataSource(
          rulesDataSource,
          sourceLinkDelegate,
          pseudoStateDataSource,
        );
      } else {
        this.renderRules();
      }
      mount.append(this.element);
    } catch (error) {
      try {
        this.dispose();
      } catch {
        // Preserve the constructor failure that prevented the view from mounting.
      }
      throw error;
    }
  }

  public bindRulesDataSource(
    dataSource: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
    pseudoStateDataSource?: PseudoStateDataSource,
  ): void {
    if (this.disposed) throw new Error("Elements Inspector is disposed");
    if (this.rulesDataSource || this.rulesPane || this.unsubscribeRules) {
      throw new Error("Rules data source is already bound");
    }
    const rulesMessage = this.createRulesMessage();
    this.rulesRoot.append(rulesMessage);
    let rulesPane: ElementsRulesRendererHost;
    try {
      rulesPane = this.createRulesRenderer(
        this.document,
        this.rulesRoot,
        dataSource,
        sourceLinkDelegate,
        pseudoStateDataSource,
      );
    } catch (error) {
      this.rulesRoot.replaceChildren();
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      let notificationsEnabled = false;
      unsubscribe = dataSource.subscribe(() => {
        if (notificationsEnabled) this.renderRules();
      });
      this.rulesDataSource = dataSource;
      this.rulesPane = rulesPane;
      this.rulesMessage = rulesMessage;
      this.unsubscribeRules = unsubscribe;
      notificationsEnabled = true;
      this.renderRules();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        rulesPane.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      this.rulesRoot.replaceChildren();
      this.rulesDataSource = undefined;
      this.rulesPane = undefined;
      this.rulesMessage = undefined;
      this.unsubscribeRules = undefined;
      this.renderRules();
      if (failures.length > 1) {
        throw new AggregateError(failures, "Rules binding and teardown failed");
      }
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizer.removeEventListener("pointerdown", this.startResize);
    this.resizer.removeEventListener("pointermove", this.continueResize);
    this.resizer.removeEventListener("pointerup", this.finishResize);
    this.resizer.removeEventListener("pointercancel", this.finishResize);
    this.resizer.removeEventListener("keydown", this.resizeByKey);
    const stackedMediaQuery = this.stackedMediaQuery;
    this.stackedMediaQuery = undefined;
    try {
      stackedMediaQuery?.removeEventListener(
        "change",
        this.applyStackedOrientation,
      );
    } catch {
      // A view that dropped listener support has nothing left to release.
    }
    this.rulesTab.removeEventListener("click", this.showRules);
    this.sourceTab.removeEventListener("click", this.showSource);
    this.rulesTab.removeEventListener("keydown", this.navigateFromRulesTab);
    this.sourceTab.removeEventListener("keydown", this.navigateFromSourceTab);
    let disposeError: unknown;
    const themeMediaQuery = this.themeMediaQuery;
    this.themeMediaQuery = undefined;
    try {
      themeMediaQuery?.removeEventListener("change", this.updateChromiumTheme);
    } catch (error) {
      disposeError = error;
    }
    if (this.ownsChromiumTheme) {
      this.ownsChromiumTheme = false;
      try {
        releaseChromiumThemeOwner(this.document, this.themeOwner);
      } catch (error) {
        disposeError ??= error;
      }
    }
    const unsubscribeRules = this.unsubscribeRules;
    this.unsubscribeRules = undefined;
    this.rulesDataSource = undefined;
    try {
      unsubscribeRules?.();
    } catch (error) {
      disposeError = error;
    }
    const treeRendererHost = this.treeRendererHost;
    this.treeRendererHost = undefined;
    try {
      treeRendererHost?.dispose();
    } catch (error) {
      disposeError ??= error;
    }
    const rulesPane = this.rulesPane;
    this.rulesPane = undefined;
    this.rulesMessage = undefined;
    try {
      rulesPane?.dispose();
    } catch (error) {
      disposeError ??= error;
    } finally {
      this.element.remove();
    }
    if (disposeError !== undefined) throw disposeError;
  }

  private bindSidebarSize(): void {
    const defaultView = this.document.defaultView;
    const stacked = defaultView?.matchMedia?.(STACKED_LAYOUT_QUERY);
    if (stacked) {
      this.stackedMediaQuery = stacked;
      try {
        stacked.addEventListener("change", this.applyStackedOrientation);
      } catch {
        // A view without listener support keeps the initial orientation.
        this.stackedMediaQuery = undefined;
      }
    }
    for (const axis of RESIZE_AXES) {
      const stored = readStoredSidebarSize(defaultView, axis);
      if (stored !== undefined) this.writeSidebarSize(axis, stored);
    }
    this.renderResizerOrientation();
  }

  private renderResizerOrientation(): void {
    if (this.disposed) return;
    // A separator reports the axis it moves along, which is the opposite of
    // the axis it splits.
    this.resizer.setAttribute(
      "aria-orientation",
      this.stackedAxis() === "block" ? "horizontal" : "vertical",
    );
  }

  private stackedAxis(): ResizeAxis {
    return this.stackedMediaQuery?.matches ? "block" : "inline";
  }

  private beginResize(event: PointerEvent): void {
    if (this.disposed || event.button !== 0) return;
    const bounds = boundsOf(this.resizer);
    if (!bounds) return;
    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.resizeOffset = this.stackedAxis() === "block"
      ? event.clientY - bounds.top
      : event.clientX - bounds.left;
    this.resizer.dataset.state = "active";
    try {
      this.resizer.setPointerCapture?.(event.pointerId);
    } catch {
      // Without pointer capture the pointerup listener still ends the drag.
    }
  }

  private updateResize(event: PointerEvent): void {
    if (this.disposed || this.resizePointerId !== event.pointerId) return;
    const root = boundsOf(this.element);
    const separator = boundsOf(this.resizer);
    if (!root || !separator) return;
    event.preventDefault();
    const axis = this.stackedAxis();
    const size = axis === "block"
      ? root.bottom - (event.clientY - this.resizeOffset) - separator.height
      : root.right - (event.clientX - this.resizeOffset) - separator.width;
    const total = axis === "block" ? root.height : root.width;
    this.writeSidebarSize(axis, clampSidebarSize(size, total, axis));
  }

  private endResize(event: PointerEvent): void {
    if (this.resizePointerId !== event.pointerId) return;
    this.resizePointerId = undefined;
    delete this.resizer.dataset.state;
    try {
      this.resizer.releasePointerCapture?.(event.pointerId);
    } catch {
      // Releasing a capture the view already dropped is not an error.
    }
    if (this.disposed) return;
    const axis = this.stackedAxis();
    const current = this.readSidebarSize(axis);
    if (current !== undefined) {
      writeStoredSidebarSize(this.document.defaultView, axis, current);
    }
  }

  private nudgeResize(event: KeyboardEvent): void {
    if (this.disposed) return;
    const axis = this.stackedAxis();
    const grow = axis === "block" ? "ArrowUp" : "ArrowLeft";
    const shrink = axis === "block" ? "ArrowDown" : "ArrowRight";
    if (event.key !== grow && event.key !== shrink) return;
    const root = boundsOf(this.element);
    if (!root) return;
    event.preventDefault();
    const total = axis === "block" ? root.height : root.width;
    const current = this.readSidebarSize(axis) ?? Math.round(
      total * DEFAULT_SIDEBAR_FRACTION[axis],
    );
    const next = current + (event.key === grow ? RESIZE_STEP : -RESIZE_STEP);
    const size = clampSidebarSize(next, total, axis);
    this.writeSidebarSize(axis, size);
    writeStoredSidebarSize(this.document.defaultView, axis, size);
  }

  private readSidebarSize(axis: ResizeAxis): number | undefined {
    const raw = this.element.style.getPropertyValue(SIDEBAR_SIZE_PROPERTY[axis]);
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private writeSidebarSize(axis: ResizeAxis, size: number): void {
    this.element.style.setProperty(
      SIDEBAR_SIZE_PROPERTY[axis],
      `${Math.round(size)}px`,
    );
  }

  private bindColorScheme(): void {
    const defaultView = this.document.defaultView;
    if (!defaultView) return;
    const mediaQuery = defaultView.matchMedia("(prefers-color-scheme: dark)");
    this.themeMediaQuery = mediaQuery;
    this.ownsChromiumTheme = true;
    updateChromiumThemeOwner(this.document, this.themeOwner, mediaQuery.matches);
    try {
      mediaQuery.addEventListener("change", this.updateChromiumTheme);
    } catch (error) {
      this.ownsChromiumTheme = false;
      releaseChromiumThemeOwner(this.document, this.themeOwner);
      this.themeMediaQuery = undefined;
      throw error;
    }
  }

  private renderRules(): void {
    if (this.disposed) return;
    const revision = ++this.rulesRenderRevision;
    const snapshot = this.rulesDataSource?.snapshot() ?? EMPTY_RULES_SNAPSHOT;
    if (this.disposed || revision !== this.rulesRenderRevision) return;

    this.rulesRoot.setAttribute("data-state", snapshot.state);
    this.rulesRoot.setAttribute(
      "aria-busy",
      snapshot.state === "loading" ? "true" : "false",
    );
    this.renderRulesProbe(snapshot);
    const rulesPane = this.rulesPane;
    if (!rulesPane) return;

    let messageText: string | undefined;
    let messageRole: "alert" | "status" = "status";
    if (snapshot.state === "loading") {
      rulesPane.clear();
      messageText = "Loading styles";
    } else if (snapshot.state === "partial") {
      // A partial snapshot still shows every rule it has, and the footer already
      // reports what could not be read; the pane keeps its room for the rules.
      rulesPane.render(snapshot.matchedStyles);
    } else if (snapshot.state === "ready") {
      rulesPane.render(snapshot.matchedStyles);
    } else if (snapshot.state === "error") {
      rulesPane.clear();
      messageText = snapshot.message;
      messageRole = "alert";
    } else {
      rulesPane.clear();
    }
    if (this.disposed || revision !== this.rulesRenderRevision) return;
    this.updateRulesMessage(messageText, messageRole);
  }

  private renderRulesProbe(snapshot: RulesPresentationSnapshot): void {
    for (const attribute of RULES_PROBE_ATTRIBUTES) {
      this.rulesRoot.removeAttribute(attribute);
    }
    if (snapshot.state !== "ready" && snapshot.state !== "partial") return;
    const styles = snapshot.matchedStyles;
    this.rulesRoot.setAttribute(
      "data-document-epoch",
      String(styles.documentEpoch),
    );
    this.rulesRoot.setAttribute(
      "data-selection-revision",
      String(styles.selectionRevision),
    );
    this.rulesRoot.setAttribute(
      "data-styles-revision",
      String(styles.stylesRevision),
    );
    this.rulesRoot.setAttribute(
      "data-stylesheet-revision",
      String(styles.stylesheetRevision),
    );
    this.rulesRoot.setAttribute(
      "data-pseudo-state-revision",
      String(styles.pseudoStateRevision),
    );
    this.rulesRoot.setAttribute(
      "data-pseudo-states",
      styles.pseudoStates.join(" "),
    );
    const ruleRef = primaryRuleRef(styles);
    if (ruleRef) this.rulesRoot.setAttribute("data-probe-rule-ref", ruleRef);
  }

  private createRulesMessage(): HTMLElement {
    const message = this.createElement("p", {
      className: "pin-op-elements-inspector__rules-message",
      attributes: {
        "data-part": "rules-message",
      },
    });
    message.hidden = true;
    return message;
  }

  private updateRulesMessage(
    text?: string,
    role: "alert" | "status" = "status",
  ): void {
    const message = this.rulesMessage;
    if (!message) return;
    message.textContent = text ?? "";
    message.hidden = text === undefined;
    if (text === undefined) {
      message.removeAttribute("role");
    } else {
      message.setAttribute("role", role);
    }
  }

  private selectSidebarTab(tab: "rules" | "source"): void {
    if (this.disposed) return;
    const rulesSelected = tab === "rules";
    this.rulesTab.setAttribute("aria-selected", String(rulesSelected));
    this.rulesTab.setAttribute("tabindex", rulesSelected ? "0" : "-1");
    this.sourceTab.setAttribute("aria-selected", String(!rulesSelected));
    this.sourceTab.setAttribute("tabindex", rulesSelected ? "-1" : "0");
    this.rulesRoot.hidden = !rulesSelected;
    this.rulesRoot.setAttribute("aria-hidden", String(!rulesSelected));
    this.sidebarExtensionMount.hidden = rulesSelected;
    this.sidebarExtensionMount.setAttribute(
      "aria-hidden",
      String(rulesSelected),
    );
  }

  private navigateSidebarTabs(
    current: "rules" | "source",
    event: KeyboardEvent,
  ): void {
    if (this.disposed) return;
    let next: "rules" | "source" | undefined;
    if (event.key === "Home") {
      next = "rules";
    } else if (event.key === "End") {
      next = "source";
    } else if (event.key === "ArrowRight") {
      next = current === "rules" ? "source" : "rules";
    } else if (event.key === "ArrowLeft") {
      next = current === "rules" ? "source" : "rules";
    }
    if (!next) return;
    event.preventDefault();
    this.selectSidebarTab(next);
    (next === "rules" ? this.rulesTab : this.sourceTab).focus();
  }

  private createElement(
    tagName: string,
    options: {
      readonly attributes?: Readonly<Record<string, string>>;
      readonly className?: string;
      readonly text?: string;
    } = {},
  ): HTMLElement {
    const element = this.document.createElement(tagName);
    if (options.className) element.className = options.className;
    for (const [name, value] of Object.entries(options.attributes ?? {})) {
      element.setAttribute(name, value);
    }
    if (options.text !== undefined) element.textContent = options.text;
    return element;
  }
}

const EMPTY_RULES_SNAPSHOT: RulesPresentationSnapshot = Object.freeze({
  state: "empty",
});

const RULES_PROBE_ATTRIBUTES = Object.freeze([
  "data-document-epoch",
  "data-selection-revision",
  "data-styles-revision",
  "data-stylesheet-revision",
  "data-pseudo-state-revision",
  "data-pseudo-states",
  "data-probe-rule-ref",
]);

function primaryRuleRef(
  styles: Extract<
    RulesPresentationSnapshot,
    { readonly state: "ready" | "partial" }
  >["matchedStyles"],
): string | undefined {
  const matched = styles.matchedRules[0]?.ruleRef;
  if (matched) return matched;
  if (styles.inlineStyle) return styles.inlineStyle.ruleRef;
  for (const inherited of styles.inherited) {
    if (inherited.matchedRules[0]) return inherited.matchedRules[0].ruleRef;
    if (inherited.inlineStyle) return inherited.inlineStyle.ruleRef;
  }
  return undefined;
}

function boundsOf(element: HTMLElement): DOMRect | undefined {
  const measure = (element as Partial<HTMLElement>).getBoundingClientRect;
  if (typeof measure !== "function") return undefined;
  const bounds = measure.call(element);
  return Number.isFinite(bounds?.width) && Number.isFinite(bounds?.height)
    ? bounds
    : undefined;
}

function clampSidebarSize(
  size: number,
  total: number,
  axis: ResizeAxis,
): number {
  const minimum = MINIMUM_SIDEBAR_SIZE[axis];
  const maximum = Math.max(minimum, total - MINIMUM_PANE_SIZE);
  if (!Number.isFinite(size)) return minimum;
  return Math.min(Math.max(size, minimum), maximum);
}

function sidebarSizeStorage(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage ?? undefined;
  } catch {
    // A view that refuses storage keeps the default split for this session.
    return undefined;
  }
}

function readStoredSidebarSize(
  view: Window | null,
  axis: ResizeAxis,
): number | undefined {
  let raw: string | null | undefined;
  try {
    raw = sidebarSizeStorage(view)?.getItem(SIDEBAR_SIZE_STORAGE_KEY[axis]);
  } catch {
    return undefined;
  }
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) && value >= MINIMUM_SIDEBAR_SIZE[axis]
    ? value
    : undefined;
}

function writeStoredSidebarSize(
  view: Window | null,
  axis: ResizeAxis,
  size: number,
): void {
  try {
    sidebarSizeStorage(view)?.setItem(
      SIDEBAR_SIZE_STORAGE_KEY[axis],
      String(Math.round(size)),
    );
  } catch {
    // Losing one remembered split never blocks inspection.
  }
}

interface InspectorAriaIds {
  readonly rulesTab: string;
  readonly rulesPanel: string;
  readonly sourceTab: string;
  readonly sourcePanel: string;
}

interface ChromiumThemeBridgeState {
  readonly initiallyDark: boolean;
  readonly initiallyBaseline: boolean;
  readonly platformClass: string | undefined;
  readonly initiallyPlatform: boolean;
  readonly owners: Map<symbol, boolean>;
}

/**
 * Chromium selects its UI and source-code font tokens through one
 * `platform-*` root class. Without it the pinned token set keeps its generic
 * fallback fonts instead of the host platform's DevTools typography.
 */
function chromiumPlatformClass(document: Document): string | undefined {
  const navigator = document.defaultView?.navigator as
    | (Navigator & { readonly userAgentData?: { readonly platform?: string } })
    | undefined;
  if (!navigator) return undefined;
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  if (/mac/i.test(platform)) return "platform-mac";
  if (/win/i.test(platform)) return "platform-windows";
  if (/linux|x11|cros|android/i.test(platform)) return "platform-linux";
  return undefined;
}

function updateChromiumThemeOwner(
  document: Document,
  owner: symbol,
  dark: boolean,
): void {
  let bridge = chromiumThemeBridges.get(document);
  if (!bridge) {
    const platformClass = chromiumPlatformClass(document);
    bridge = {
      initiallyDark: document.documentElement.classList.contains(
        "theme-with-dark-background",
      ),
      initiallyBaseline: document.documentElement.classList.contains(
        CHROMIUM_BASELINE_THEME_CLASS,
      ),
      platformClass,
      initiallyPlatform: platformClass !== undefined &&
        document.documentElement.classList.contains(platformClass),
      owners: new Map(),
    };
    chromiumThemeBridges.set(document, bridge);
  }
  bridge.owners.set(owner, dark);
  synchronizeChromiumTheme(document, bridge);
}

function releaseChromiumThemeOwner(document: Document, owner: symbol): void {
  const bridge = chromiumThemeBridges.get(document);
  if (!bridge) return;
  bridge.owners.delete(owner);
  synchronizeChromiumTheme(document, bridge);
  if (bridge.owners.size === 0) chromiumThemeBridges.delete(document);
}

function synchronizeChromiumTheme(
  document: Document,
  bridge: ChromiumThemeBridgeState,
): void {
  let dark = bridge.initiallyDark;
  if (!dark) {
    for (const ownedDark of bridge.owners.values()) {
      if (!ownedDark) continue;
      dark = true;
      break;
    }
  }
  document.documentElement.classList.toggle(
    "theme-with-dark-background",
    dark,
  );
  // Chromium's design tokens reserve untinted surfaces for its baseline
  // themes. Without this class the pinned token set falls back to the
  // browser-theme-tinted branch and paints Chromium surfaces blue.
  document.documentElement.classList.toggle(
    CHROMIUM_BASELINE_THEME_CLASS,
    bridge.initiallyBaseline || bridge.owners.size > 0,
  );
  if (bridge.platformClass !== undefined) {
    document.documentElement.classList.toggle(
      bridge.platformClass,
      bridge.initiallyPlatform || bridge.owners.size > 0,
    );
  }
}

function allocateAriaIds(document: Document): InspectorAriaIds {
  let sequence = nextAriaIdSequence.get(document) ?? 1;
  while (true) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const ids = {
      rulesTab: `pin-op-elements-rules-tab${suffix}`,
      rulesPanel: `pin-op-elements-rules-panel${suffix}`,
      sourceTab: `pin-op-elements-source-tab${suffix}`,
      sourcePanel: `pin-op-elements-source-panel${suffix}`,
    };
    if (Object.values(ids).every((id) => document.getElementById(id) === null)) {
      nextAriaIdSequence.set(document, sequence + 1);
      return ids;
    }
    sequence += 1;
  }
}
